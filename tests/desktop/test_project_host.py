from __future__ import annotations

import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from Auvra.desktop.assets import AssetTransferRegistry
from Auvra.desktop.dialogs import DialogSelection
from Auvra.desktop.project_host import NativeProjectHost
from Auvra.desktop.previews import PreviewStore


class _Dialogs:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.create_count = 0

    def choose_create_location(self, suggested_name: str):
        self.create_count += 1
        return DialogSelection(self.root / (suggested_name if self.create_count == 1 else f"{suggested_name}-{self.create_count}"))

    def choose_open_project(self):
        return None

    def choose_save_as_location(self, suggested_name: str):
        return DialogSelection(self.root / f"{suggested_name}-copy")

    def choose_export_pack(self, suggested_name: str):
        return DialogSelection(self.root / f"{suggested_name}.auvrapack")

    def choose_import_pack(self):
        return None

    def choose_import_legacy(self):
        return None


class _NativeRecorder:
    def __init__(self, *, fail_hydrate: bool = False) -> None:
        self.fail_hydrate = fail_hydrate
        self.hydrations = []
        self.validations = []
        self.closed = []

    def validate_project(self, project_id, revision, domains):
        self.validations.append((project_id, revision, domains))

    def hydrate_project(self, project_id, revision, domains, *, asset_ids=()):
        if self.fail_hydrate:
            raise RuntimeError("native child unavailable")
        self.hydrations.append((project_id, revision, domains, tuple(asset_ids)))

    def close_project(self, project_id=None):
        self.closed.append(project_id)

    def stage_asset(self, asset_id, stream):
        stream.read()


class NativeProjectHostTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.registry = AssetTransferRegistry(
            self.root / "transfers",
            session_id="session-project-host",
            trusted_origin="http://127.0.0.1:3000",
        )
        self.host = NativeProjectHost(
            self.root / "state",
            asset_registry=self.registry,
            dialogs=_Dialogs(self.root / "projects"),
        )

    def tearDown(self) -> None:
        self.host.shutdown()
        self.registry.close()
        self.temp.cleanup()

    def test_create_apply_snapshot_save_as_and_status_never_expose_paths(self) -> None:
        closed = self.host.handle("project.getStatus", {})
        self.assertIsNone(closed["projectId"])
        created = self.host.handle("project.create", {"name": "Demo"})
        project_id = created["projectId"]
        changed = self.host.handle(
            "project.applyChanges",
            {
                "projectId": project_id,
                "expectedRevision": 0,
                "changes": [
                    {
                        "domain": "metadata",
                        "documentId": "project",
                        "operation": "upsert",
                        "document": {"id": "project", "name": "Demo"},
                    }
                ],
            },
        )
        self.assertEqual(changed["revision"], 1)
        snapshot = self.host.handle(
            "project.getSnapshot",
            {"projectId": project_id, "domain": "metadata", "pageSize": 10},
        )
        self.assertEqual(snapshot["domains"]["metadata"]["documents"][0]["id"], "project")
        copied = self.host.handle(
            "project.saveAs",
            {"projectId": project_id, "expectedRevision": 1, "name": "Demo"},
        )
        self.assertNotEqual(copied["projectId"], project_id)
        for value in (closed, created, changed, snapshot, copied):
            rendered = repr(value)
            self.assertNotIn(str(self.root), rendered)
            self.assertNotIn("path", rendered.lower())

    def test_asset_upload_and_resolve_are_opaque_streamed_and_content_addressed(self) -> None:
        created = self.host.handle("project.create", {"name": "Assets"})
        ticket = self.host.handle(
            "asset.beginUpload",
            {
                "projectId": created["projectId"],
                "expectedRevision": created["revision"],
                "size": 7,
                "mime": "application/octet-stream",
                "name": "payload.bin",
            },
        )
        self.assertEqual(ticket["method"], "PUT")
        response = self.registry.handle(
            method="PUT",
            url=ticket["url"],
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Content-Type": "application/octet-stream",
                "Content-Length": "7",
            },
            body=io.BytesIO(b"payload"),
        )
        asset_id = response.headers["X-Auvra-Asset-Sha256"]
        resolved = self.host.handle(
            "asset.resolve",
            {"projectId": created["projectId"], "assetId": asset_id},
        )
        self.assertEqual(resolved["method"], "GET")
        self.assertEqual(resolved["mime"], "application/octet-stream")
        self.assertEqual(resolved["size"], 7)
        served = self.registry.handle(
            method="GET",
            url=resolved["url"],
            headers={"Origin": "http://127.0.0.1:3000"},
        )
        self.assertEqual(served.body.read(), b"payload")
        self.assertEqual(served.headers["Content-Type"], "application/octet-stream")
        served.body.close()

    def test_generated_preview_resolves_without_becoming_project_content(self) -> None:
        created = self.host.handle("project.create", {"name": "Preview"})
        previews = PreviewStore(self.root / "previews")
        try:
            payload = (
                b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
                b"\x00\x00\x00\x02\x00\x00\x00\x03\x08\x06\x00\x00\x00"
            )
            record = previews.ingest("job-0123456789abcdef", io.BytesIO(payload))
            self.host.set_preview_store(previews)
            canonical = self.host.service.active.path / "Content" / "sha256" / record.asset_id
            self.assertFalse(canonical.exists())
            resolved = self.host.handle(
                "asset.resolve",
                {"projectId": created["projectId"], "assetId": record.asset_id},
            )
            served = self.registry.handle(
                method="GET",
                url=resolved["url"],
                headers={"Origin": "http://127.0.0.1:3000"},
            )
            self.assertEqual(served.body.read(), payload)
            served.body.close()
            self.assertFalse(canonical.exists())
        finally:
            previews.close()

    def test_project_events_are_queued_without_path_authority(self) -> None:
        created = self.host.handle("project.create", {"name": "Events"})
        names = [name for name, _ in self.host.drain_events()]
        self.assertEqual(names, ["project.opening", "project.opened"])
        self.host.handle(
            "project.applyChanges",
            {
                "projectId": created["projectId"],
                "expectedRevision": 0,
                "changes": [{
                    "domain": "metadata",
                    "documentId": "project",
                    "operation": "upsert",
                    "document": {"id": "project", "name": "Events"},
                }],
            },
        )
        events = self.host.drain_events()
        self.assertEqual([name for name, _ in events], ["project.revision", "project.dirty"])
        self.assertFalse(any("path" in repr(payload).lower() for _, payload in events))

    def test_recovery_points_are_opaque_and_restore_through_open_recent(self) -> None:
        created = self.host.handle("project.create", {"name": "Recovery"})
        project_id = created["projectId"]
        first = self.host.handle("project.applyChanges", {
            "projectId": project_id,
            "expectedRevision": 0,
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "First"},
            }],
        })
        saved = self.host.handle("project.save", {
            "projectId": project_id, "expectedRevision": first["revision"],
        })
        recovery = saved["recoveryPoints"][0]
        self.assertRegex(recovery["recoveryId"], r"^recovery-[A-Za-z0-9_-]+$")
        second = self.host.handle("project.applyChanges", {
            "projectId": project_id,
            "expectedRevision": saved["revision"],
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "Second"},
            }],
        })
        restored = self.host.handle("project.openRecent", {
            "recentId": project_id, "recoveryId": recovery["recoveryId"],
        })
        self.assertGreater(restored["revision"], second["revision"])
        snapshot = self.host.handle("project.getSnapshot", {
            "projectId": project_id, "domain": "metadata", "pageSize": 10,
        })
        self.assertEqual(snapshot["domains"]["metadata"]["documents"][0]["name"], "First")

    def test_autosave_runs_once_until_another_mutation(self) -> None:
        clock = [100.0]
        self.host.shutdown()
        self.host = NativeProjectHost(
            self.root / "state-autosave",
            asset_registry=self.registry,
            dialogs=_Dialogs(self.root / "autosave-projects"),
            now=lambda: clock[0],
        )
        created = self.host.handle("project.create", {"name": "Autosave"})
        changed = self.host.handle("project.applyChanges", {
            "projectId": created["projectId"],
            "expectedRevision": 0,
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "Autosave"},
            }],
        })
        clock[0] = 165.0
        self.host.tick()
        first_count = len(self.host.service.active.recovery_points())
        clock[0] = 300.0
        self.host.tick()
        self.assertEqual(first_count, 1)
        self.assertEqual(len(self.host.service.active.recovery_points()), 1)
        self.host.handle("project.applyChanges", {
            "projectId": created["projectId"],
            "expectedRevision": changed["revision"],
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "Autosave again"},
            }],
        })
        clock[0] = 365.0
        self.host.tick()
        self.assertEqual(len(self.host.service.active.recovery_points()), 2)

    def test_snapshot_cursor_is_absolute_when_transport_page_shrinks(self) -> None:
        created = self.host.handle("project.create", {"name": "Paging"})
        documents = [
            {"id": f"doc-{index:03d}", "description": "x" * 5000}
            for index in range(80)
        ]
        changed = self.host.handle("project.applyChanges", {
            "projectId": created["projectId"],
            "expectedRevision": 0,
            "changes": [{
                "domain": "metadata", "documentId": value["id"],
                "operation": "upsert", "document": value,
            } for value in documents],
        })
        cursor = ""
        received: list[str] = []
        while True:
            page = self.host.handle("project.getSnapshot", {
                "projectId": created["projectId"], "domain": "metadata",
                "pageSize": 100, **({"cursor": cursor} if cursor else {}),
            })
            received.extend(item["id"] for item in page["domains"]["metadata"]["documents"])
            if not page["hasMore"]:
                break
            cursor = page["cursor"]
        self.assertEqual(received, [value["id"] for value in documents])
        self.assertEqual(page["revision"], changed["revision"])

    def test_project_open_and_mutation_hydrate_native_after_durable_commit(self) -> None:
        native = _NativeRecorder()
        self.host.set_native_engine_host(native)
        created = self.host.handle("project.create", {"name": "NativeWorld"})
        self.assertEqual(len(native.hydrations), 1)
        changed = self.host.handle("project.applyChanges", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "NativeWorld"},
            }],
        })
        self.assertEqual(changed["revision"], 1)
        self.assertEqual(native.hydrations[-1][1], 1)
        self.assertEqual(native.validations[-1][1], 1)

    def test_durable_project_wins_when_native_rehydration_fails(self) -> None:
        native = _NativeRecorder(fail_hydrate=True)
        self.host.set_native_engine_host(native)
        created = self.host.handle("project.create", {"name": "RecoveryWorld"})
        changed = self.host.handle("project.applyChanges", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "Persisted"},
            }],
        })
        self.assertEqual(changed["revision"], 1)
        snapshot = self.host.handle("project.getSnapshot", {
            "projectId": created["projectId"], "domain": "metadata", "pageSize": 10,
        })
        self.assertEqual(snapshot["domains"]["metadata"]["documents"][0]["name"], "Persisted")
        self.assertTrue(any(name == "project.recovery" for name, _ in self.host.drain_events()))

    def test_import_pack_and_legacy_each_hydrate_once(self) -> None:
        native = _NativeRecorder()
        self.host.set_native_engine_host(native)
        created = self.host.handle("project.create", {"name": "ImportTarget"})
        native.hydrations.clear()
        source = self.root / "source.auvrapack"
        source.write_bytes(b"placeholder")
        with mock.patch.object(self.host.dialogs, "choose_import_pack", return_value=DialogSelection(source)), \
             mock.patch.object(self.host.service, "import_pack", return_value=self.host.service.active.status):
            self.host.handle("project.importPack", {"sourceHandle": "pack"})
        self.assertEqual(len(native.hydrations), 1)
        native.hydrations.clear()
        legacy = self.root / "legacy.forge"
        legacy.write_bytes(b"placeholder")
        report = type("Report", (), {})()
        with mock.patch.object(self.host.dialogs, "choose_import_legacy", return_value=DialogSelection(legacy)), \
             mock.patch.object(self.host.service, "migrate_legacy", return_value=(self.host.service.active.status, report)):
            self.host.handle("project.importLegacy", {"sourceHandle": "legacy"})
        self.assertEqual(len(native.hydrations), 1)


if __name__ == "__main__":
    unittest.main()
