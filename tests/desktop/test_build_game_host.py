from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from Auvra.desktop.assets import AssetTransferRegistry
from Auvra.desktop.dialogs import DialogSelection, WinFormsProjectDialogs
from Auvra.desktop.project_host import NativeProjectHost
from Auvra.host.dispatcher import HostOperationError
from Auvra.project.game_build import BUILD_MARKER, TEMPLATE_MANIFEST
from tests.desktop.test_dialogs import _Forms


TEMPLATE_FILES = {
    "index.html": b"<!doctype html><title>Player</title>",
    "assets/player.js": b"console.log('player');",
}
MODEL_BYTES = b"fbx-model-bytes"


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
        self.assertEqual(set(result["report"]), {"target", "files", "bytes", "assets", "levels"})
        self.assertEqual(result["report"]["target"], "web")
        self.assertEqual(result["report"]["assets"], 1)
        self.assertEqual(result["report"]["levels"], 1)
        self.assertGreater(result["report"]["bytes"], 0)
        encoded = json.dumps(result)
        self.assertNotIn(str(self.root), encoded)
        self.assertNotIn(self.root.as_posix(), encoded)

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


if __name__ == "__main__":
    unittest.main()
