from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

from Auvra.desktop.assets import AssetTransferRegistry, AssetTransportError, AssetUpload
from Auvra.desktop.dialogs import DialogSelection, WinFormsProjectDialogs
from Auvra.desktop.prepared_models import PreparedModelStore
from Auvra.desktop.project_host import NativeProjectHost, _public_build_warnings
from Auvra.host.validation import validate_message
from Auvra.host.dispatcher import HostOperationError
from Auvra.project.game_build import BUILD_MARKER, TEMPLATE_MANIFEST
from tests.desktop.test_dialogs import _Forms


TEMPLATE_FILES = {
    "index.html": b"<!doctype html><title>Player</title>",
    "assets/player.js": b"console.log('player');",
}
MODEL_BYTES = b"fbx-model-bytes"
PREPARED_BYTES = b"prepared-model-bytes"
KEY = "e" * 64


class _BuildDialogs:
    def __init__(self, projects: Path, builds: Path | None) -> None:
        self.projects = projects
        self.builds = builds
        self.build_requests: list[str] = []

    def choose_create_location(self, suggested_name: str):
        return DialogSelection(self.projects / suggested_name)

    def choose_build_destination(self, suggested_name: str):
        self.build_requests.append(suggested_name)
        return None if self.builds is None else DialogSelection(self.builds)


def _write_template(root: Path) -> None:
    for relative, data in TEMPLATE_FILES.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    manifest = {"files": [
        {"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for path, data in TEMPLATE_FILES.items()
    ]}
    (root / TEMPLATE_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")


class BuildGameHostTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.template = self.root / "player-template"
        _write_template(self.template)
        self.builds = self.root / "builds"
        self.builds.mkdir()
        self.registry = AssetTransferRegistry(
            self.root / "transfers",
            session_id="session-build-game",
            trusted_origin="http://127.0.0.1:3000",
        )
        self.dialogs = _BuildDialogs(self.root / "projects", self.builds)
        # A stand-in player so Windows builds never depend on a local cargo build.
        self.player = self.root / "auvra-player.exe"
        self.player.write_bytes(b"MZ" + bytes(62))
        self.host = NativeProjectHost(
            self.root / "state",
            asset_registry=self.registry,
            dialogs=self.dialogs,
            player_template_root=self.template,
            player_executable=self.player,
        )
        self.project_id, self.revision = self._create_game_project()

    def tearDown(self) -> None:
        self.host.shutdown()
        self.registry.close()
        self.temp.cleanup()

    def _create_game_project(self, *, levels: bool = True) -> tuple[str, int]:
        created = self.host.handle("project.create", {"name": "Project"})
        active = self.host.service.active
        reference = active.assets.put_stream(
            io.BytesIO(MODEL_BYTES), size=len(MODEL_BYTES), mime="model/fbx", name="hero.fbx",
        )
        documents = {
            "metadata": {"id": "game-settings", "settings": {"name": "Demo Game"}},
            "models": {"id": "model-1", "name": "Hero", "assetId": reference.asset_id},
        }
        if levels:
            documents["levels"] = {"id": "level-1", "name": "First"}
        changed = self.host.handle("project.applyChanges", {
            "projectId": created["projectId"],
            "expectedRevision": created["revision"],
            "changes": [
                {"domain": domain, "documentId": document["id"], "operation": "upsert", "document": document}
                for domain, document in documents.items()
            ],
        })
        return changed["projectId"], changed["revision"]

    def _build(self, **overrides):
        payload = {"projectId": self.project_id, "expectedRevision": self.revision, "target": "web"}
        payload.update(overrides)
        return self.host.build_game(payload)

    def _assert_error(self, code: str, **overrides) -> HostOperationError:
        with self.assertRaises(HostOperationError) as caught:
            self._build(**overrides)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(str(self.root), str(caught.exception))
        return caught.exception

    def test_build_writes_named_folder_and_reports_without_paths(self) -> None:
        result = self._build()

        self.assertEqual(self.dialogs.build_requests, ["Demo Game"])
        destination = self.builds / "Demo Game-Web"
        self.assertEqual((destination / "index.html").read_bytes(), TEMPLATE_FILES["index.html"])
        self.assertTrue((destination / BUILD_MARKER).is_file())
        self.assertTrue((destination / "game" / "game.json").is_file())
        self.assertEqual(len(list((destination / "game" / "assets").iterdir())), 1)
        self.assertEqual(result["projectId"], self.project_id)
        self.assertEqual(result["revision"], self.revision)
        self.assertRegex(result["handle"], r"^build-[A-Za-z0-9_-]+$")
        self.assertEqual(set(result["report"]), {"target", "files", "sizeBytes", "assets", "levels", "warnings"})
        self.assertEqual(result["report"]["target"], "web")
        self.assertEqual(result["report"]["assets"], 1)
        self.assertEqual(result["report"]["levels"], 1)
        self.assertGreater(result["report"]["sizeBytes"], 0)
        encoded = json.dumps(result)
        # The reply must pass the host protocol, which the editor checks before accepting it.
        validate_message({"protocol": "auvra.host/1", "type": "response", "id": "r1", "session": "s1",
                          "revision": 1, "ok": True, "result": result})
        self.assertNotIn(str(self.root), encoded)
        self.assertNotIn(self.root.as_posix(), encoded)

    def test_build_report_surfaces_bounded_warning_codes_without_sensitive_values(self) -> None:
        changed = self.host.handle("project.applyChanges", {
            "projectId": self.project_id, "expectedRevision": self.revision,
            "changes": [{
                "domain": "metadata", "documentId": "game-settings", "operation": "upsert",
                "document": {"id": "game-settings", "settings": {
                    "name": "Demo Game",
                    "playerBlueprintId": "missing-player",
                    "network": {"enabled": True, "serverUrl": "not-a-websocket-url"},
                }},
            }],
        })
        self.revision = changed["revision"]
        web = self._build()
        self.assertEqual(
            {entry["code"] for entry in web["report"]["warnings"]},
            {"player_blueprint_missing", "multiplayer_offline"},
        )
        windows = self._build(target="windows")
        self.assertIn("player_notices_missing", {entry["code"] for entry in windows["report"]["warnings"]})
        for result in (web, windows):
            validate_message({"protocol": "auvra.host/1", "type": "response", "id": "r1",
                              "session": "s1", "revision": 1, "ok": True, "result": result})
            self.assertNotIn(str(self.root), json.dumps(result))
            self.assertNotIn("missing-player", json.dumps(result["report"]["warnings"]))
            self.assertNotIn("not-a-websocket-url", json.dumps(result["report"]["warnings"]))

    def test_unknown_or_path_bearing_builder_warnings_never_cross_protocol(self) -> None:
        private = "/home/user/secret/project"
        warnings = _public_build_warnings([
            f"the previous build at {private} could not be removed",
            f"future diagnostic at {private}",
            "multiplayer is on but the server address is invalid",
        ])
        self.assertEqual([entry["code"] for entry in warnings],
                         ["old_build_cleanup_failed", "other_build_warning", "multiplayer_offline"])
        self.assertNotIn(private, json.dumps(warnings))
        self.assertEqual(len(_public_build_warnings(["unrecognized"] * 1000)), 1)

    def test_handle_rebuilds_into_the_same_parent_without_a_dialog(self) -> None:
        first = self._build()
        second = self._build(target="windows", destinationHandle=first["handle"])
        again = self._build(destinationHandle=first["handle"])

        self.assertEqual(self.dialogs.build_requests, ["Demo Game"])
        self.assertEqual(second["handle"], first["handle"])
        self.assertEqual(second["report"]["target"], "windows")
        self.assertTrue((self.builds / "Demo Game-Windows" / BUILD_MARKER).is_file())
        self.assertEqual(again["report"]["target"], "web")
        self.assertEqual(sorted(path.name for path in self.builds.iterdir()),
                         ["Demo Game-Web", "Demo Game-Windows"])
        self._assert_error("invalid_request", destinationHandle="build-unknown")

    def test_dialog_handle_asks_for_a_folder(self) -> None:
        # The editor sends "dialog" when it has no folder to reuse.
        result = self._build(destinationHandle="dialog")
        self.assertEqual(self.dialogs.build_requests, ["Demo Game"])
        self.assertRegex(result["handle"], r"^build-[A-Za-z0-9_-]+$")

    def test_read_only_project_builds_but_identity_and_revision_must_match(self) -> None:
        self.host.service.active.read_only = True
        self.assertEqual(self._build()["report"]["levels"], 1)
        self._assert_error("revision_conflict", expectedRevision=self.revision + 1)
        self._assert_error("invalid_project", projectId="other-project")
        self._assert_error("invalid_request", target="console")

    def test_cancelled_dialog_and_unsafe_destinations_write_nothing(self) -> None:
        self.dialogs.builds = None
        self._assert_error("cancelled")
        project_root = Path(self.host.service.active.path)
        self.dialogs.builds = project_root
        self.assertIn("overlaps", str(self._assert_error("invalid_request")))
        self.assertFalse((project_root / "Demo Game-Web").exists())
        self.dialogs.builds = self.root / "state"
        self.assertIn("overlaps", str(self._assert_error("invalid_request")))
        self.assertFalse((self.root / "state" / "Demo Game-Web").exists())

        # A destination that contains the project would replace it on publish.
        self.host.handle("project.close", {"projectId": self.project_id, "expectedRevision": self.revision})
        self.dialogs.projects = self.root / "outer" / "Demo Game-Web"
        self.project_id, self.revision = self._create_game_project()
        self.dialogs.builds = self.root / "outer"
        self.assertIn("overlaps", str(self._assert_error("invalid_request")))
        self.assertTrue((self.root / "outer" / "Demo Game-Web" / "Project").is_dir())
        self.assertEqual(list(self.builds.iterdir()), [])

    def test_build_errors_map_to_host_codes_without_paths(self) -> None:
        (self.builds / "Demo Game-Web").mkdir()
        (self.builds / "Demo Game-Web" / "keep.txt").write_text("user data", encoding="utf-8")
        self._assert_error("invalid_request")
        self.assertTrue((self.builds / "Demo Game-Web" / "keep.txt").is_file())

        self.host.handle("project.close", {"projectId": self.project_id, "expectedRevision": self.revision})
        self.dialogs.projects = self.root / "projects-2"
        self.project_id, self.revision = self._create_game_project(levels=False)
        self._assert_error("invalid_project", target="windows")

    def test_corrupt_asset_cannot_replace_a_successful_build(self) -> None:
        first = self._build()
        destination = self.builds / "Demo Game-Web"
        marker = (destination / BUILD_MARKER).read_bytes()
        packaged = destination / "game" / "assets" / f"{self._source_id()}.fbx"
        self.assertEqual(packaged.read_bytes(), MODEL_BYTES)

        store = self.host.service.active.assets
        source = store.path_for(self._source_id())
        corrupt = b"!" * len(MODEL_BYTES)
        self.assertNotEqual(corrupt, MODEL_BYTES)
        source.write_bytes(corrupt)
        # A same-size replacement still passes manifest metadata validation.
        self.assertEqual(store.reference(self._source_id()).size, len(corrupt))

        error = self._assert_error("invalid_project", destinationHandle=first["handle"])
        self.assertIn("asset", str(error))
        self.assertEqual((destination / BUILD_MARKER).read_bytes(), marker)
        self.assertEqual(packaged.read_bytes(), MODEL_BYTES)
        self.assertEqual(list(self.builds.glob(".Demo Game-Web.staging-*")), [])

    def test_missing_template_fails_before_the_dialog(self) -> None:
        self.host.player_template_root = self.root / "missing-template"
        self._assert_error("unsupported_capability")
        self.assertEqual(self.dialogs.build_requests, [])

    def test_default_template_is_the_repo_player_dist(self) -> None:
        host = NativeProjectHost(self.root / "state-default", asset_registry=self.registry, dialogs=self.dialogs)
        try:
            repo = Path(__file__).resolve().parents[2]
            self.assertEqual(host.player_template_root, repo / "fbx-viewer (1)" / "dist" / "player")
        finally:
            host.shutdown()

    def test_native_dialog_returns_the_chosen_parent_folder(self) -> None:
        forms = _Forms(result=1, folder=str(self.builds), file="")
        selection = WinFormsProjectDialogs(lambda: forms).choose_build_destination("Demo Game")
        self.assertEqual(selection.path, self.builds.absolute())
        self.assertTrue(all(dialog.disposed for dialog in forms.created))
        cancelled = _Forms(result=0, folder=str(self.builds), file="")
        self.assertIsNone(WinFormsProjectDialogs(lambda: cancelled).choose_build_destination("Demo Game"))

    def _upload_prepared(self, key: str, data: bytes = PREPARED_BYTES) -> None:
        ticket = self.host.handle("asset.beginPreparedUpload", {"projectId": self.project_id, "key": key, "size": len(data)})
        validate_message({"protocol": "auvra.host/1", "type": "response", "id": "r1", "session": "s1",
                          "revision": 1, "ok": True, "result": ticket})
        self.assertEqual((ticket["method"], ticket["mime"], ticket["size"]), ("PUT", "model/gltf-binary", len(data)))
        response = self.registry.handle(
            method="PUT", url=ticket["url"],
            headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "model/gltf-binary", "Content-Length": str(len(data))},
            body=io.BytesIO(data),
        )
        self.assertEqual(response.status, 204)

    def _prepared_payload(self, key: str) -> dict:
        return {"version": 1, "textures": "bc", "models": [{"source": self._source_id(), "asset": key}]}

    def _source_id(self) -> str:
        models = self.host.service.active.get_domain("models")["documents"]
        return models[0]["assetId"]

    def _query(self, *keys: str) -> list[str]:
        result = self.host.handle("asset.queryPrepared", {"projectId": self.project_id, "keys": list(keys)})
        validate_message({"protocol": "auvra.host/1", "type": "response", "id": "r1", "session": "s1",
                          "revision": 1, "ok": True, "result": result})
        return result["preparedKeys"]

    def test_prepared_models_upload_outside_the_project_and_go_into_a_build(self) -> None:
        self.assertEqual(self._query(KEY), [])
        self._upload_prepared(KEY)
        self.assertEqual(self._query(KEY, "f" * 64), [KEY])
        # The store is the host's: nothing of it enters the project, whose revision stands still.
        self.assertEqual(self.host.service.active.revision, self.revision)
        self.assertFalse(self.host.service.active.assets.path_for(hashlib.sha256(PREPARED_BYTES).hexdigest()).exists())
        self.assertFalse(list(self.registry.root.glob("*.upload")))

        result = self._build(prepared=self._prepared_payload(KEY))
        self.assertEqual(result["report"]["preparedModels"], 1)
        self.assertEqual(result["report"]["assets"], 2)
        destination = self.builds / "Demo Game-Web" / "game"
        manifest = json.loads((destination / "game.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["prepared"], self._prepared_payload(KEY))
        self.assertEqual((destination / "assets" / f"{KEY}.glb").read_bytes(), PREPARED_BYTES)
        validate_message({"protocol": "auvra.host/1", "type": "response", "id": "r1", "session": "s1",
                          "revision": 1, "ok": True, "result": result})

    def test_a_build_without_prepared_models_is_todays_pack(self) -> None:
        result = self._build()
        self.assertNotIn("preparedModels", result["report"])
        manifest = json.loads((self.builds / "Demo Game-Web" / "game" / "game.json").read_text(encoding="utf-8"))
        self.assertNotIn("prepared", manifest)

    def test_read_only_projects_can_prepare_and_are_never_purged(self) -> None:
        self.host.service.active.read_only = True
        self._upload_prepared(KEY)
        self.assertEqual(self._query(KEY), [KEY])
        self.assertEqual(self._build(prepared=self._prepared_payload(KEY))["report"]["preparedModels"], 1)

    def test_prepared_models_are_shared_across_projects(self) -> None:
        self._upload_prepared(KEY)
        self.host.handle("project.close", {"projectId": self.project_id, "expectedRevision": self.revision})
        self.dialogs.projects = self.root / "projects-2"
        self.project_id, self.revision = self._create_game_project()
        self.assertEqual(self._query(KEY), [KEY])

    def test_a_prepared_model_that_changed_on_disk_is_deleted_and_the_source_is_used(self) -> None:
        self._upload_prepared(KEY)
        stored = self.root / "state" / "prepared-models" / f"{KEY}.glb"
        self.assertEqual(stored.read_bytes(), PREPARED_BYTES)
        stored.write_bytes(b"something else")

        result = self._build(prepared=self._prepared_payload(KEY))
        self.assertEqual(result["report"]["preparedModels"], 0)
        manifest = json.loads((self.builds / "Demo Game-Web" / "game" / "game.json").read_text(encoding="utf-8"))
        self.assertNotIn("prepared", manifest)
        self.assertEqual(self.dialogs.build_requests, ["Demo Game"])
        self.assertFalse(stored.exists())
        self.assertEqual(self._query(KEY), [])

    def test_oversized_and_malformed_uploads_are_refused(self) -> None:
        with self.assertRaises(HostOperationError):
            self.host.handle("asset.beginPreparedUpload", {"projectId": self.project_id, "key": "../escape", "size": 4})
        with self.assertRaises(HostOperationError):
            self.host.handle("asset.queryPrepared", {"projectId": self.project_id, "keys": ["../escape"]})
        with self.assertRaises(HostOperationError):
            self.host.handle("asset.beginPreparedUpload", {"projectId": "other-project", "key": KEY, "size": 4})
        ticket = self.host.handle("asset.beginPreparedUpload", {"projectId": self.project_id, "key": KEY, "size": 2})
        with self.assertRaises(AssetTransportError):
            self.registry.handle(
                method="PUT", url=ticket["url"],
                headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "model/gltf-binary"},
                body=io.BytesIO(b"too long"),
            )
        self.assertEqual(self._query(KEY), [])

    def test_the_store_trims_what_was_used_longest_ago_and_keeps_this_builds_models(self) -> None:
        store = PreparedModelStore(self.root / "trimmed", capacity_bytes=20)
        keys = ["1" * 64, "2" * 64, "3" * 64]
        for age, key in enumerate(keys):
            data = bytes(8)
            source = self.root / f"upload-{age}"
            source.write_bytes(data)
            store.ingest(key, AssetUpload(source, len(data), hashlib.sha256(data).hexdigest(), "model/gltf-binary"))
            os.utime(self.root / "trimmed" / f"{key}.glb", (1000 + age, 1000 + age))
        self.assertEqual(store.available(keys[:1]), keys[:1])
        # That read made the first the most recently used; the second is the oldest now.
        store.trim(keep=keys[2:])
        self.assertEqual(store.available(keys), [keys[0], keys[2]])
        self.assertFalse((self.root / "trimmed" / f"{keys[1]}.glb").exists())
        self.assertFalse((self.root / "trimmed" / f"{keys[1]}.sha256").exists())
        # A build's own models stay, even past the size.
        PreparedModelStore(self.root / "trimmed", capacity_bytes=0).trim(keep=keys)
        self.assertEqual(store.available(keys), [keys[0], keys[2]])


if __name__ == "__main__":
    unittest.main()
