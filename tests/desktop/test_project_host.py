from __future__ import annotations

import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from Auvra.desktop.assets import AssetTransferRegistry
from Auvra.desktop.dialogs import DialogSelection
from Auvra.desktop.native_engine import NativeEngineHost, NativeEngineState
from Auvra.desktop.project_host import DOCUMENT_LOAD_LIMIT, NativeProjectHost
from Auvra.desktop.previews import PreviewStore
from Auvra.diagnostics.core import DiagnosticsSession, install_diagnostics
from Auvra.host.dispatcher import HostOperationError
from Auvra.project.repository import ProjectRepository
from Auvra.project.schemas import DOMAIN_NAMES


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
    def __init__(self, *, fail_hydrate: bool = False, fail_stage: bool = False) -> None:
        self.fail_hydrate = fail_hydrate
        self.fail_stage = fail_stage
        self.hydrations = []
        self.validations = []
        self.closed = []
        self.stale = []

    def mark_stale(self, reason, *, project_id=None, project_revision=None):
        self.stale.append(reason)

    def validate_project(self, project_id, revision, domains):
        self.validations.append((project_id, revision, domains))

    def hydrate_project(self, project_id, revision, domains, *, asset_ids=()):
        if self.fail_hydrate:
            raise RuntimeError("native child unavailable")
        self.hydrations.append((project_id, revision, domains, tuple(asset_ids)))

    def close_project(self, project_id=None):
        self.closed.append(project_id)

    def stage_asset(self, asset_id, stream):
        if self.fail_stage:
            raise RuntimeError("native asset staging failed")
        stream.read()


class _ReadyNativeChild:
    """READY native child double that commits every hydration transaction."""

    state = NativeEngineState.READY

    def __init__(self) -> None:
        self.calls: list[str] = []

    def call(self, method, params=None):
        self.calls.append(method)
        if method == "world.beginHydration":
            return {"hydrationTransaction": True}
        if method == "world.commitHydration":
            return {"revision": 1}
        return {}

    def restart(self, *, editor_session="editor"):
        return None


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

    def test_failed_project_mutation_discards_pending_upload(self) -> None:
        created = self.host.handle("project.create", {"name": "Pending"})
        ticket = self.host.handle(
            "asset.beginUpload",
            {
                "projectId": created["projectId"],
                "expectedRevision": created["revision"],
                "size": 7,
                "mime": "application/octet-stream",
                "name": "pending.bin",
            },
        )
        response = self.registry.handle(
            method="PUT",
            url=ticket["url"],
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Content-Type": "application/octet-stream",
                "Content-Length": "7",
            },
            body=io.BytesIO(b"pending"),
        )
        asset_id = response.headers["X-Auvra-Asset-Sha256"]
        target = self.host.service.active.assets.path_for(asset_id)
        self.assertTrue(target.exists())
        with self.assertRaises(HostOperationError) as raised:
            self.host.handle("project.applyChanges", {
                "projectId": created["projectId"],
                "expectedRevision": created["revision"],
                "changes": [{
                    "domain": "objects",
                    "documentId": "object",
                    "operation": "upsert",
                    "document": {"id": "object", "name": "Object", "type": "prop", "levelId": "missing"},
                }],
            })
        self.assertEqual(raised.exception.code, "invalid_project")
        self.assertFalse(target.exists())

    def test_generated_preview_resolves_without_becoming_project_content(self) -> None:
        created = self.host.handle("project.create", {"name": "Preview"})
        previews = PreviewStore(self.root / "previews")
        try:
            payload = (
                b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
                b"\x00\x00\x00\x02\x00\x00\x00\x03\x08\x06\x00\x00\x00"
            )
            record = previews.ingest(
                "job-0123456789abcdef", io.BytesIO(payload), project_id=created["projectId"],
            )
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

    def test_generated_preview_cannot_cross_project_boundaries(self) -> None:
        first = self.host.handle("project.create", {"name": "Preview A"})
        previews = PreviewStore(self.root / "cross-project-previews")
        try:
            payload = (
                b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
                b"\x00\x00\x00\x02\x00\x00\x00\x03\x08\x06\x00\x00\x00"
            )
            record = previews.ingest(
                "job-0123456789abcdef", io.BytesIO(payload), project_id=first["projectId"],
            )
            self.host.set_preview_store(previews)
            second = self.host.handle("project.create", {"name": "Preview B"})
            with self.assertRaises(HostOperationError) as raised:
                self.host.handle("asset.resolve", {
                    "projectId": second["projectId"], "assetId": record.asset_id,
                })
            self.assertEqual(raised.exception.code, "invalid_job")
        finally:
            previews.close()

    def test_project_events_are_queued_without_path_authority(self) -> None:
        created = self.host.handle("project.create", {"name": "Events"})
        opening_events = self.host.drain_events()
        names = [name for name, _ in opening_events]
        self.assertEqual(
            names,
            ["project.opening", "project.progress", "project.progress", "project.opened"],
        )
        progress = [payload["progress"] for name, payload in opening_events if name == "project.progress"]
        self.assertEqual(progress, sorted(progress))
        self.assertTrue(all(0.0 <= value <= 1.0 for value in progress))
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

    def test_recovery_event_contains_full_choices_and_new_point(self) -> None:
        created = self.host.handle("project.create", {"name": "Recovery event"})
        project_id = created["projectId"]
        changed = self.host.handle("project.applyChanges", {
            "projectId": project_id,
            "expectedRevision": created["revision"],
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "Recovery event"},
            }],
        })
        self.host.drain_events()
        saved = self.host.handle("project.save", {
            "projectId": project_id, "expectedRevision": changed["revision"],
        })
        recovery_event = next(
            payload for name, payload in self.host.drain_events()
            if name == "project.recovery"
        )
        expected = saved["recoveryPoints"]
        self.assertEqual(recovery_event["recoveryPoints"], expected)
        self.assertEqual(recovery_event["recoveryId"], expected[0]["recoveryId"])
        self.assertEqual(recovery_event["recoveryKind"], expected[0]["kind"])
        self.assertTrue(recovery_event["recoveryAvailable"])

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

    def test_autosave_failure_isolated_from_controller_tick_and_retried(self) -> None:
        clock = [100.0]
        self.host.shutdown()
        self.host = NativeProjectHost(
            self.root / "state-autosave-failure",
            asset_registry=self.registry,
            dialogs=_Dialogs(self.root / "autosave-failure-projects"),
            now=lambda: clock[0],
        )
        created = self.host.handle("project.create", {"name": "Autosave failure"})
        self.host.handle("project.applyChanges", {
            "projectId": created["projectId"],
            "expectedRevision": created["revision"],
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "Autosave failure"},
            }],
        })
        active = self.host.service.active
        self.assertIsNotNone(active)
        with mock.patch.object(active, "autosave", side_effect=OSError("disk full")) as autosave:
            clock[0] = 165.0
            self.host.tick()
            self.assertEqual(autosave.call_count, 1)
            # A repeated controller tick during the retry window is harmless.
            self.host.tick()
            self.assertEqual(autosave.call_count, 1)
            self.assertIs(self.host.service.active, active)
            # Once the bounded retry delay elapses, the operation is attempted
            # again instead of silently abandoning the dirty period.
            clock[0] = 170.0
            self.host.tick()
            self.assertEqual(autosave.call_count, 2)

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

    def _load_all_domains(self, project_id: str) -> dict[str, list[str]]:
        """Page every domain the way the editor reopens a project."""
        received: dict[str, list[str]] = {}
        cursor = ""
        for _ in range(64):
            page = self.host.handle("project.getSnapshot", {
                "projectId": project_id, "pageSize": 100, **({"cursor": cursor} if cursor else {}),
            })
            for domain, value in page["domains"].items():
                received.setdefault(domain, []).extend(item["id"] for item in value["documents"])
            if not page["hasMore"]:
                return received
            cursor = page["cursor"]
        self.fail("snapshot paging did not terminate")

    def test_document_write_beyond_the_load_limit_is_rejected_before_commit(self) -> None:
        created = self.host.handle("project.create", {"name": "LoadLimit"})
        envelope = len('{"id":"big","description":""}')

        def change(size: int) -> dict:
            return {"domain": "metadata", "documentId": "big", "operation": "upsert",
                    "document": {"id": "big", "description": "x" * (size - envelope)}}

        with self.assertRaises(HostOperationError) as raised:
            self.host.handle("project.applyChanges", {
                "projectId": created["projectId"], "expectedRevision": created["revision"],
                "changes": [change(DOCUMENT_LOAD_LIMIT + 1)],
            })
        self.assertEqual(raised.exception.code, "invalid_request")
        self.assertEqual(str(raised.exception), "Project document exceeds the 160 KiB load limit")
        self.assertEqual(self.host.service.active.revision, created["revision"])
        self.assertEqual(self._load_all_domains(created["projectId"]).get("metadata", []), [])

        accepted = self.host.handle("project.applyChanges", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
            "changes": [change(DOCUMENT_LOAD_LIMIT)],
        })
        self.assertEqual(accepted["revision"], created["revision"] + 1)
        project_path = self.host.service.active.path
        self.host.handle("project.save", {"projectId": created["projectId"], "expectedRevision": accepted["revision"]})
        self.host.handle("project.close", {"projectId": created["projectId"], "expectedRevision": accepted["revision"]})
        self.host.service.open(project_path)
        self.assertEqual(self._load_all_domains(created["projectId"])["metadata"], ["big"])

    def test_all_domain_snapshot_splits_a_page_by_domain_to_stay_loadable(self) -> None:
        created = self.host.handle("project.create", {"name": "DomainSplit"})
        large = 100 * 1024
        self.host.handle("project.applyChanges", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
            "changes": [
                {"domain": "metadata", "documentId": "a-big", "operation": "upsert",
                 "document": {"id": "a-big", "description": "m" * large}},
                {"domain": "metadata", "documentId": "b1", "operation": "upsert",
                 "document": {"id": "b1", "name": "small"}},
                {"domain": "metadata", "documentId": "b2", "operation": "upsert",
                 "document": {"id": "b2", "name": "small"}},
                {"domain": "worlds", "documentId": "w-big", "operation": "upsert",
                 "document": {"id": "w-big", "name": "w" * large}},
            ],
        })
        received = self._load_all_domains(created["projectId"])
        self.assertEqual(received["metadata"], ["a-big", "b1", "b2"])
        self.assertEqual(received["worlds"], ["w-big"])
        self.assertEqual(set(received), set(DOMAIN_NAMES))
        with self.assertRaises(HostOperationError) as raised:
            self.host.handle("project.getSnapshot", {"projectId": created["projectId"], "cursor": "0.99"})
        self.assertEqual(raised.exception.code, "invalid_request")

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

    def test_durable_project_wins_when_authoritative_native_rehydration_fails(self) -> None:
        created = self.host.handle("project.create", {"name": "RecoveryWorld"})
        project_path = self.host.service.active.path
        native = _NativeRecorder(fail_hydrate=True)
        self.host._native_engine = native
        self.host._native_authoritative = True
        self.host.drain_events()
        with self.assertRaises(HostOperationError) as raised:
            self.host.handle("project.applyChanges", {
                "projectId": created["projectId"], "expectedRevision": created["revision"],
                "changes": [{
                    "domain": "metadata", "documentId": "project", "operation": "upsert",
                    "document": {"id": "project", "name": "Persisted"},
                }],
            })
        self.assertEqual(raised.exception.code, "recovery_required")
        self.assertIsNone(self.host.service.active)
        events = self.host.drain_events()
        self.assertFalse(any(name in {"project.opened", "project.revision", "project.dirty"} for name, _ in events))
        self.assertEqual([name for name, _ in events[-2:]], ["project.closed", "project.status"])
        self.assertTrue(all(payload["projectId"] is None for _, payload in events[-2:]))
        self.assertTrue(project_path.exists())
        self.host.set_native_engine_host(None)
        self.host.service.open(project_path)
        snapshot = self.host.service.get_snapshot(["metadata"], page_size=10)
        self.assertEqual(snapshot.domains["metadata"]["documents"][0]["name"], "Persisted")

    def _assert_native_failure(self, method: str, payload: dict, project_path: Path | None = None) -> None:
        # Fail-closed hydration applies only once native rendering is authoritative.
        self.host._native_authoritative = True
        self.host.drain_events()
        with self.assertRaises(HostOperationError) as raised:
            self.host.handle(method, payload)
        self.assertEqual(raised.exception.code, "recovery_required")
        self.assertIsNone(self.host.service.active)
        events = self.host.drain_events()
        self.assertFalse(any(name in {"project.opened", "project.revision", "project.dirty"} for name, _ in events))
        self.assertEqual([name for name, _ in events[-2:]], ["project.closed", "project.status"])
        self.assertTrue(all(payload["projectId"] is None for _, payload in events[-2:]))
        self.assertTrue(all(payload["status"] == "closed" for _, payload in events[-2:]))
        if project_path is not None:
            self.assertTrue(project_path.exists())

    def test_non_authoritative_native_hydration_failure_keeps_project_open(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra project host diagnostics ") as raw:
            session = DiagnosticsSession(Path(raw) / "diagnostics", run_id="run-native-stale", mode="test")
            session.start()
            install_diagnostics(session)
            try:
                native = _NativeRecorder(fail_hydrate=True)
                self.host.set_native_engine_host(native)
                created = self.host.handle("project.create", {"name": "StaleNative"})
                self.assertEqual(created["status"], "open")
                self.assertIsNotNone(self.host.service.active)
                self.host.drain_events()
                changed = self.host.handle("project.applyChanges", {
                    "projectId": created["projectId"], "expectedRevision": created["revision"],
                    "changes": [{
                        "domain": "metadata", "documentId": "project", "operation": "upsert",
                        "document": {"id": "project", "name": "Persisted"},
                    }],
                })
                self.assertEqual(changed["revision"], 1)
                self.assertEqual(changed["status"], "open")
                names = [name for name, _ in self.host.drain_events()]
                self.assertIn("project.revision", names)
                self.assertIn("project.dirty", names)
                self.assertNotIn("project.closed", names)
                self.assertEqual(native.closed, [])
                self.assertEqual(len(native.stale), 2)
                snapshot = self.host.handle("project.getSnapshot", {
                    "projectId": created["projectId"], "domain": "metadata", "pageSize": 10,
                })
                self.assertEqual(snapshot["domains"]["metadata"]["documents"][0]["name"], "Persisted")

                # The retained native view re-synchronizes on the next hydration.
                native.fail_hydrate = False
                self.host.handle("project.applyChanges", {
                    "projectId": created["projectId"], "expectedRevision": 1,
                    "changes": [{
                        "domain": "metadata", "documentId": "project", "operation": "upsert",
                        "document": {"id": "project", "name": "Resynced"},
                    }],
                })
                self.assertEqual(native.hydrations[-1][1], 2)
                stale = [record for record in session.snapshot()
                         if record["event"] == "native.lifecycle"
                         and record.get("attributes", {}).get("state") == "stale"]
                self.assertTrue(stale)
                self.assertEqual(stale[0]["attributes"]["code"], "hydration_failed")
                self.assertEqual(stale[0]["attributes"]["errorType"], "RuntimeError")
            finally:
                install_diagnostics(None)
                session.close(outcome="success")

    def test_non_authoritative_native_failure_keeps_open_save_as_and_import_usable(self) -> None:
        created = self.host.handle("project.create", {"name": "StaleOpen"})
        open_path = self.host.service.active.path
        self.host.handle("project.close", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
        })
        native = _NativeRecorder(fail_hydrate=True)
        self.host._native_engine = native
        with mock.patch.object(self.host.dialogs, "choose_open_project",
                               return_value=DialogSelection(open_path / "StaleOpen.auvra")):
            opened = self.host.handle("project.open", {"projectHandle": "dialog"})
        self.assertEqual(opened["projectId"], created["projectId"])
        self.assertEqual(opened["status"], "open")
        copied = self.host.handle("project.saveAs", {
            "projectId": opened["projectId"], "expectedRevision": opened["revision"], "name": "StaleCopy",
        })
        self.assertEqual(copied["status"], "open")
        self.assertEqual(self.host.service.active.project_id, copied["projectId"])
        self.assertEqual(len(native.stale), 2)

        source_dir = self.root / "stale-source"
        source = ProjectRepository.create(source_dir, "Source")
        try:
            asset = source.assets.put_stream(io.BytesIO(b"stale-asset"), name="asset.glb")
            source.apply_changes({"models": [{"id": "model", "name": "Model", "assetId": asset.asset_id}]}, expected_revision=0)
            source.save()
            pack = self.root / "stale.auvrapack"
            source.export_pack(pack)
        finally:
            source.close()
        native.fail_stage = True
        destination = self.root / "projects" / "StaleImported"
        with mock.patch.object(self.host.dialogs, "choose_import_pack", return_value=DialogSelection(pack)), \
                mock.patch.object(self.host.dialogs, "choose_create_location", return_value=DialogSelection(destination)):
            imported = self.host.handle("project.importPack", {"sourceHandle": "pack"})
        self.assertEqual(imported["status"], "open")
        self.assertIsNotNone(self.host.service.active)
        self.assertEqual(len(native.stale), 3)
        self.assertEqual(native.closed, [])

    def test_non_authoritative_hydration_failure_drops_the_previous_native_project(self) -> None:
        child = _ReadyNativeChild()
        native = NativeEngineHost(child)
        self.host.set_native_engine_host(native)
        previous = self.host.handle("project.create", {"name": "Previous"})
        self.assertEqual(native._canonical("engine.status")["projectId"], previous["projectId"])

        source = ProjectRepository.create(self.root / "switch-source", "Switch")
        try:
            asset = source.assets.put_stream(io.BytesIO(b"switch-asset"), name="asset.glb")
            source.apply_changes({"models": [{"id": "model", "name": "Model", "assetId": asset.asset_id}]}, expected_revision=0)
            source.save()
            pack = self.root / "switch.auvrapack"
            source.export_pack(pack)
        finally:
            source.close()
        destination = self.root / "projects" / "Switched"
        with mock.patch.object(native, "stage_asset", side_effect=OSError("native staging failed")), \
                mock.patch.object(self.host.dialogs, "choose_import_pack", return_value=DialogSelection(pack)), \
                mock.patch.object(self.host.dialogs, "choose_create_location", return_value=DialogSelection(destination)):
            switched = self.host.handle("project.importPack", {"sourceHandle": "pack"})
        self.assertEqual(switched["status"], "open")
        self.assertNotEqual(switched["projectId"], previous["projectId"])
        # Staging failed before the new payload was retained, so native must
        # not keep presenting the previous project as the open one.
        status = native._canonical("engine.status")
        self.assertEqual(status["status"], "degraded")
        self.assertNotIn("projectId", status)
        self.assertIn("world.closeProject", child.calls)

        # Recovery must not re-hydrate the previous project and report ready.
        child.calls.clear()
        native.restart()
        self.assertNotIn("world.beginHydration", child.calls)
        self.assertEqual(native._canonical("engine.status")["status"], "degraded")

        self.host.handle("project.close", {
            "projectId": switched["projectId"], "expectedRevision": switched["revision"],
        })
        self.assertIn("world.closeProject", child.calls)
        self.assertEqual(native._canonical("engine.status")["status"], "ready")

    def test_non_authoritative_native_rejection_does_not_block_project_writes(self) -> None:
        child = _ReadyNativeChild()
        native = NativeEngineHost(child)
        self.host.set_native_engine_host(native)
        created = self.host.handle("project.create", {"name": "NativeRejected"})

        def rename(revision: int, name: str) -> dict:
            return self.host.handle("project.applyChanges", {
                "projectId": created["projectId"], "expectedRevision": revision,
                "changes": [{"domain": "metadata", "documentId": "project", "operation": "upsert",
                             "document": {"id": "project", "name": name}}],
            })

        with tempfile.TemporaryDirectory(prefix="auvra project host diagnostics ") as raw:
            session = DiagnosticsSession(Path(raw) / "diagnostics", run_id="run-native-rejected", mode="test")
            session.start()
            install_diagnostics(session)
            try:
                # Native refuses data: URLs; the project and WebGL2 accept them.
                rejected = self.host.handle("project.applyChanges", {
                    "projectId": created["projectId"], "expectedRevision": created["revision"],
                    "changes": [{"domain": "environment", "documentId": "environment", "operation": "upsert",
                                 "document": {"id": "environment",
                                              "settings": {"sky": "data:image/png;base64,AAAA"}}}],
                })
                self.assertEqual(rejected["revision"], created["revision"] + 1)
                renamed = rename(rejected["revision"], "Renamed")
                self.assertEqual(renamed["revision"], rejected["revision"] + 1)
                self.assertEqual(renamed["status"], "open")
                states = [(record.get("attributes", {}).get("state"), record.get("attributes", {}).get("code"))
                          for record in session.snapshot() if record["event"] == "native.lifecycle"]
                self.assertIn(("rejected", "validation_failed"), states)
                self.assertIn(("stale", "hydration_failed"), states)
            finally:
                install_diagnostics(None)
                session.close(outcome="success")

        # The native view stays stale; recovery cannot resurrect the older
        # revision that native retained before the rejected write.
        child.calls.clear()
        native.restart()
        self.assertNotIn("world.beginHydration", child.calls)
        self.assertEqual(native._canonical("engine.status")["status"], "degraded")

        # Once native rendering is authoritative the same rejection fails closed.
        self.host._native_authoritative = True
        with self.assertRaises(HostOperationError) as raised:
            rename(renamed["revision"], "Blocked")
        self.assertEqual(raised.exception.code, "invalid_project")
        self.assertEqual(self.host.service.active.revision, renamed["revision"])

    def test_native_hydration_failure_fail_closes_create_open_and_open_recent(self) -> None:
        native = _NativeRecorder(fail_hydrate=True)
        self.host._native_engine = native
        create_path = self.root / "projects" / "CreateFailure"
        self._assert_native_failure("project.create", {"name": "CreateFailure"}, create_path)
        self.assertEqual(native.closed, [mock.ANY])

        self.host._native_engine = None
        created = self.host.handle("project.create", {"name": "OpenFailure"})
        open_path = self.host.service.active.path
        self.host.handle("project.close", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
        })
        self.host._native_engine = native
        with mock.patch.object(self.host.dialogs, "choose_open_project", return_value=DialogSelection(open_path / "OpenFailure.auvra")):
            self._assert_native_failure("project.open", {"projectHandle": "dialog"}, open_path)

        self.host._native_engine = None
        recent = self.host.service.open(open_path)
        recent_id = recent.project_id
        self.host.service.close()
        self.host._native_engine = native
        self._assert_native_failure("project.openRecent", {"recentId": recent_id}, open_path)

    def test_native_hydration_failure_fail_closes_save_as_and_apply_changes(self) -> None:
        created = self.host.handle("project.create", {"name": "MutationFailure"})
        project_path = self.host.service.active.path
        native = _NativeRecorder(fail_hydrate=True)
        self.host._native_engine = native
        self._assert_native_failure("project.applyChanges", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
            "changes": [{
                "domain": "metadata", "documentId": "project", "operation": "upsert",
                "document": {"id": "project", "name": "Persisted"},
            }],
        }, project_path)

        self.host._native_engine = None
        restored = self.host.service.open(project_path)
        self.host._native_engine = native
        destination = self.root / "projects" / "MutationFailure-copy"
        with mock.patch.object(self.host.dialogs, "choose_save_as_location", return_value=DialogSelection(destination)):
            self._assert_native_failure("project.saveAs", {
                "projectId": restored.project_id, "expectedRevision": restored.revision, "name": "MutationFailure-copy",
            }, destination)

    def test_native_stage_failure_fail_closes_import_pack_and_legacy(self) -> None:
        source_dir = self.root / "source-project"
        source = ProjectRepository.create(source_dir, "Source")
        try:
            asset = source.assets.put_stream(io.BytesIO(b"asset-bytes"), name="asset.glb")
            source.apply_changes({"models": [{"id": "model", "name": "Model", "assetId": asset.asset_id}]}, expected_revision=0)
            source.save()
            pack = self.root / "source.auvrapack"
            source.export_pack(pack)
        finally:
            source.close()
        destination = self.root / "projects" / "ImportedPackFailure"
        native = _NativeRecorder(fail_stage=True)
        self.host._native_engine = native
        with mock.patch.object(self.host.dialogs, "choose_import_pack", return_value=DialogSelection(pack)), \
                mock.patch.object(self.host.dialogs, "choose_create_location", return_value=DialogSelection(destination)):
            self._assert_native_failure("project.importPack", {"sourceHandle": "pack"}, destination)

        self.host._native_engine = None
        created = self.host.handle("project.create", {"name": "LegacyFailure"})
        legacy_path = self.host.service.active.path
        native.fail_hydrate = True
        self.host._native_engine = native
        report = type("Report", (), {})()
        with mock.patch.object(self.host.dialogs, "choose_import_legacy", return_value=DialogSelection(self.root / "legacy.forge")), \
                mock.patch.object(self.host.dialogs, "choose_create_location", return_value=DialogSelection(self.root / "projects" / "LegacyFailure-copy")), \
                mock.patch.object(self.host.service, "migrate_legacy", return_value=(self.host.service.active.status, report)):
            self._assert_native_failure("project.importLegacy", {"sourceHandle": "legacy"}, legacy_path)

    def test_native_hydration_uses_normalized_quaternion_without_mutating_authored_euler(self) -> None:
        import math

        native = _NativeRecorder()
        self.host.set_native_engine_host(native)
        created = self.host.handle("project.create", {"name": "RotationBoundary"})
        authored_rotation = [0.2, -0.4, math.pi / 2]
        self.host.handle("project.applyChanges", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
            "changes": [{
                "domain": "levels", "documentId": "level", "operation": "upsert",
                "document": {"id": "level", "name": "Level"},
            }, {
                "domain": "objects", "documentId": "object", "operation": "upsert",
                "document": {
                    "id": "object", "levelId": "level", "name": "Object", "type": "prop",
                    "position": [0, 0, 0], "rotation": authored_rotation, "scale": [1, 1, 1],
                },
            }],
        })
        native_object = native.hydrations[-1][2]["objects"]["documents"][0]
        self.assertEqual(len(native_object["rotation"]), 4)
        self.assertAlmostEqual(sum(value * value for value in native_object["rotation"]), 1.0, places=12)
        expected_quaternion = [
            -0.07059288589999412,
            -0.20896434210788314,
            0.6755249097756644,
            0.7035741925769524,
        ]
        for actual, expected in zip(native_object["rotation"], expected_quaternion):
            self.assertAlmostEqual(actual, expected, places=12)
        self.assertNotEqual(native_object["rotation"], authored_rotation)
        snapshot = self.host.handle("project.getSnapshot", {
            "projectId": created["projectId"], "domain": "objects", "pageSize": 10,
        })
        self.assertEqual(snapshot["domains"]["objects"]["documents"][0]["rotation"], authored_rotation)

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
