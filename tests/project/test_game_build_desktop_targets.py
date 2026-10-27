"""Linux and macOS game builds, and which desktop targets the host can build."""

from __future__ import annotations

import hashlib
import io
import json
import os
import plistlib
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import Auvra.desktop.project_host as project_host_module
from Auvra.desktop.assets import AssetTransferRegistry
from Auvra.desktop.dialogs import DialogSelection
from Auvra.desktop.project_host import NativeProjectHost, player_executable_candidates
from Auvra.host.dispatcher import HostOperationError
from Auvra.host.validation import validate_response
from Auvra.project.game_build import (
    BUILD_MARKER,
    BUILD_TARGETS,
    EXECUTABLE_MODE,
    NOTICES_FILE,
    README_FILE,
    TEMPLATE_MANIFEST,
    GameBuildError,
    build_game,
)

TEMPLATE_FILES = {
    "index.html": b"<!doctype html><title>Player</title>",
    "assets/player.js": b"console.log('player');",
    NOTICES_FILE: b"Third-party software notices\n\nthree@0.170.0 (MIT)\n",
}
PLAYER_BYTES = b"\x7fELF-or-Mach-O player"
PLAYER_NOTICES = b"Third-party software notices: the Auvra game player\n\nwry@0.57.1 (Apache-2.0 OR MIT)\n"
MODEL_ID = "a" * 64


def write_template(root: Path) -> Path:
    for relative, data in TEMPLATE_FILES.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    manifest = {"files": [
        {"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for path, data in TEMPLATE_FILES.items()
    ]}
    (root / TEMPLATE_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
    return root


def write_player(path: Path, *, notices: bool = True) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PLAYER_BYTES)
    if notices:
        (path.parent / NOTICES_FILE).write_bytes(PLAYER_NOTICES)
    return path


def domains(**settings):
    return {
        "metadata": [{"id": "game-settings", "settings": {"name": "Demo", **settings}}],
        "levels": [{"id": "level-1", "name": "First"}],
        "models": [{"id": "model-1", "name": "Hero", "assetId": MODEL_ID}],
    }


class DesktopTargetLayoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.template = write_template(self.root / "template")
        self.player = write_player(self.root / "player" / "auvra-player")
        self.output = self.root / "builds"
        self.destination = self.output / "Demo"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def build(self, target: str, **overrides):
        options = dict(
            domains=domains(), read_asset=lambda asset_id: (b"fbx-bytes", "model/fbx"),
            template_root=self.template, destination=self.destination, target=target,
            build_id="build-1", game_id="game-1", player_executable=self.player,
        )
        options.update(overrides)
        return build_game(**options)

    def marker(self) -> dict:
        return json.loads((self.destination / BUILD_MARKER).read_text(encoding="utf-8"))

    def assert_marker_matches_files(self) -> dict:
        marker = self.marker()
        recorded = [item["path"] for item in marker["files"]]
        for item in marker["files"]:
            data = (self.destination / item["path"]).read_bytes()
            self.assertEqual((item["size"], item["sha256"]), (len(data), hashlib.sha256(data).hexdigest()), item["path"])
        written = sorted(path.relative_to(self.destination).as_posix()
                         for path in self.destination.rglob("*") if path.is_file())
        self.assertEqual(written, sorted(recorded + [BUILD_MARKER]))
        self.assertEqual(sorted(path.name for path in self.output.iterdir()), [self.destination.name])
        return marker

    def assert_executable(self, relative: str) -> None:
        records = {item["path"]: item for item in self.marker()["files"]}
        self.assertEqual(records[relative].get("mode"), EXECUTABLE_MODE)
        self.assertEqual(EXECUTABLE_MODE, 0o755)
        self.assertEqual([path for path, item in records.items() if "mode" in item], [relative])
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE((self.destination / relative).stat().st_mode), 0o755)

    def test_linux_build_puts_the_player_beside_a_game_folder(self) -> None:
        report = self.build("linux")

        self.assertEqual((report.target, report.warnings), ("linux", ()))
        self.assertEqual((self.destination / "demo").read_bytes(), PLAYER_BYTES)
        self.assert_executable("demo")
        self.assertEqual((self.destination / "game" / "index.html").read_bytes(), TEMPLATE_FILES["index.html"])
        self.assertTrue((self.destination / "game" / "assets" / "player.js").is_file())
        manifest = json.loads((self.destination / "game" / "game" / "game.json").read_text(encoding="utf-8"))
        self.assertEqual((manifest["format"], manifest["gameId"], manifest["name"]), ("auvra.game", "game-1", "Demo"))
        self.assertTrue((self.destination / "game" / "game" / "assets" / f"{MODEL_ID}.fbx").is_file())
        self.assertFalse((self.destination / "index.html").exists())
        self.assertFalse((self.destination / "game" / NOTICES_FILE).exists())
        self.assertEqual((self.destination / NOTICES_FILE).read_bytes(),
                         TEMPLATE_FILES[NOTICES_FILE].rstrip() + b"\n\n" + PLAYER_NOTICES)
        readme = (self.destination / README_FILE).read_bytes()
        self.assertNotIn(b"\r\n", readme)
        for expected in (b"./demo", b"chmod +x demo", b"libwebkit2gtk-4.1", b"game folder"):
            self.assertIn(expected, readme)
        marker = self.assert_marker_matches_files()
        self.assertEqual(marker["target"], "linux")
        self.assertEqual(report.files, len(marker["files"]) + 1)

    def test_linux_executable_is_an_ascii_slug_that_never_shadows_the_game_folder(self) -> None:
        for name, expected in (("My Game: Deluxe!", "my-game-deluxe"), ("Game", "auvra-game"),
                               ("ゲーム", "auvra-game"), ("  Space__Race 2 ", "space-race-2")):
            with self.subTest(name=name):
                self.build("linux", domains=domains(name=name))
                self.assertEqual((self.destination / expected).read_bytes(), PLAYER_BYTES)
                self.assertTrue((self.destination / "game" / "game" / "game.json").is_file())
                self.assert_executable(expected)

    def test_macos_build_is_an_app_bundle_with_info_plist(self) -> None:
        report = self.build("macos", domains=domains(version="1.2.0"))

        self.assertEqual((report.target, report.warnings), ("macos", ()))
        contents = self.destination / "Demo.app" / "Contents"
        self.assertEqual((contents / "MacOS" / "Demo").read_bytes(), PLAYER_BYTES)
        self.assert_executable("Demo.app/Contents/MacOS/Demo")
        info = plistlib.loads((contents / "Info.plist").read_bytes())
        self.assertEqual(info["CFBundleName"], "Demo")
        self.assertEqual(info["CFBundleIdentifier"], "com.auvra.game-1")
        self.assertEqual(info["CFBundleExecutable"], "Demo")
        self.assertEqual(info["CFBundlePackageType"], "APPL")
        self.assertEqual(info["CFBundleShortVersionString"], "1.2.0")
        self.assertEqual(info["LSMinimumSystemVersion"], "11.0")
        self.assertIs(info["NSHighResolutionCapable"], True)
        resources = contents / "Resources"
        self.assertEqual((resources / "game" / "index.html").read_bytes(), TEMPLATE_FILES["index.html"])
        self.assertTrue((resources / "game" / "game" / "game.json").is_file())
        self.assertTrue((resources / "game" / "game" / "assets" / f"{MODEL_ID}.fbx").is_file())
        self.assertEqual((resources / NOTICES_FILE).read_bytes(),
                         TEMPLATE_FILES[NOTICES_FILE].rstrip() + b"\n\n" + PLAYER_NOTICES)
        readme = (self.destination / README_FILE).read_text(encoding="utf-8")
        self.assertIn("right-click", readme)
        self.assertIn("Open", readme)
        self.assertEqual(sorted(path.name for path in self.destination.iterdir()), sorted([README_FILE, "Demo.app", BUILD_MARKER]))
        self.assertEqual(self.assert_marker_matches_files()["target"], "macos")

    def test_macos_version_and_bundle_identifier_are_sanitized(self) -> None:
        report = self.build("macos", game_id="My Game/1")
        info = plistlib.loads((self.destination / "Demo.app" / "Contents" / "Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], "com.auvra.My-Game-1")
        self.assertNotIn("CFBundleShortVersionString", info)
        self.assertEqual(report.warnings, ())

        report = self.build("macos", domains=domains(version="beta"))
        info = plistlib.loads((self.destination / "Demo.app" / "Contents" / "Info.plist").read_bytes())
        self.assertNotIn("CFBundleShortVersionString", info)
        self.assertEqual(len(report.warnings), 1)
        self.assertIn("is not like 1.2.3", report.warnings[0])

    def test_player_without_notices_warns_and_keeps_the_web_notices(self) -> None:
        player = write_player(self.root / "bare" / "auvra-player", notices=False)
        report = self.build("macos", player_executable=player)
        self.assertEqual(len(report.warnings), 1)
        self.assertIn("macOS game player's third-party notices", report.warnings[0])
        self.assertNotIn(str(self.root), report.warnings[0])
        self.assertEqual((self.destination / "Demo.app" / "Contents" / "Resources" / NOTICES_FILE).read_bytes(),
                         TEMPLATE_FILES[NOTICES_FILE])

    def test_missing_player_names_the_target_and_where_to_get_it(self) -> None:
        for target, label, sources in (
            ("linux", "Linux", ("player-desktop/dist/linux-x64", "game-player/linux-x64")),
            ("macos", "macOS", ("player-desktop/dist/macos", "game-player/macos")),
            ("windows", "Windows", ("cargo build --release", "game-player/auvra-player.exe")),
        ):
            for player in (None, self.root / "missing" / "auvra-player"):
                with self.subTest(target=target, player=player):
                    with self.assertRaises(GameBuildError) as caught:
                        self.build(target, player_executable=player)
                    self.assertEqual(caught.exception.code, "unsupported_capability")
                    self.assertIn(label, caught.exception.message)
                    for source in sources:
                        self.assertIn(source, caught.exception.message)
                    self.assertFalse(self.destination.exists())
                    self.assertFalse(self.output.exists())

    def test_targets_replace_each_other_atomically_in_a_marked_folder(self) -> None:
        self.build("web")
        self.build("linux", build_id="build-2")
        self.assertFalse((self.destination / "index.html").exists())
        self.assertEqual(self.assert_marker_matches_files()["buildId"], "build-2")
        self.build("macos", build_id="build-3")
        self.assertFalse((self.destination / "demo").exists())
        self.assertFalse((self.destination / "game").exists())
        self.assertEqual(self.assert_marker_matches_files()["target"], "macos")

        self.destination.rename(self.root / "kept")
        self.destination.mkdir()
        (self.destination / "keep.txt").write_text("mine", encoding="utf-8")
        with self.assertRaises(GameBuildError) as caught:
            self.build("linux")
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertEqual([path.name for path in self.destination.iterdir()], ["keep.txt"])


class PlayerLookupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_packaged_editor_ships_every_player_in_its_game_player_folder(self) -> None:
        players = self.root / "game-player"
        self.assertEqual(player_executable_candidates("windows", player_root=players), (players / "auvra-player.exe",))
        self.assertEqual(player_executable_candidates("linux", player_root=players),
                         (players / "linux-x64" / "auvra-player",))
        self.assertEqual(player_executable_candidates("macos", player_root=players),
                         (players / "macos" / "auvra-player",))
        self.assertEqual(player_executable_candidates("web", player_root=players), ())

    def test_checkout_prefers_its_cargo_build_for_the_host_os_then_ci_artifacts(self) -> None:
        crate = self.root / "player-desktop"
        release = crate / "target" / "release"

        def candidates(target: str, platform: str) -> tuple[Path, ...]:
            return player_executable_candidates(target, checkout_root=self.root, platform=platform)

        self.assertEqual(candidates("windows", "win32"), (release / "auvra-player.exe",))
        self.assertEqual(candidates("linux", "win32"), (crate / "dist" / "linux-x64" / "auvra-player",))
        self.assertEqual(candidates("macos", "win32"), (crate / "dist" / "macos" / "auvra-player",))
        self.assertEqual(candidates("linux", "linux"),
                         (release / "auvra-player", crate / "dist" / "linux-x64" / "auvra-player"))
        self.assertEqual(candidates("macos", "linux"), (crate / "dist" / "macos" / "auvra-player",))
        self.assertEqual(candidates("macos", "darwin"),
                         (release / "auvra-player", crate / "dist" / "macos" / "auvra-player"))
        self.assertEqual(candidates("linux", "darwin"), (crate / "dist" / "linux-x64" / "auvra-player",))


class _BuildDialogs:
    def __init__(self, projects: Path, builds: Path) -> None:
        self.projects = projects
        self.builds = builds
        self.build_requests: list[str] = []

    def choose_create_location(self, suggested_name: str):
        return DialogSelection(self.projects / suggested_name)

    def choose_build_destination(self, suggested_name: str):
        self.build_requests.append(suggested_name)
        return DialogSelection(self.builds)


class HostBuildTargetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.template = write_template(self.root / "player-template")
        self.players = self.root / "game-player"
        write_player(self.players / "auvra-player.exe")
        write_player(self.players / "linux-x64" / "auvra-player")
        self.builds = self.root / "builds"
        self.builds.mkdir()
        self.registry = AssetTransferRegistry(
            self.root / "transfers", session_id="session-desktop-targets", trusted_origin="http://127.0.0.1:3000",
        )
        self.dialogs = _BuildDialogs(self.root / "projects", self.builds)
        self.hosts: list[NativeProjectHost] = []

    def tearDown(self) -> None:
        for host in self.hosts:
            host.shutdown()
        self.registry.close()
        self.temporary.cleanup()

    def host(self, name: str = "state", **options) -> NativeProjectHost:
        options.setdefault("player_template_root", self.template)
        host = NativeProjectHost(self.root / name, asset_registry=self.registry, dialogs=self.dialogs, **options)
        self.hosts.append(host)
        return host

    @staticmethod
    def availability(host: NativeProjectHost) -> dict[str, tuple[bool, str | None]]:
        return {item["target"]: (item["available"], item.get("reason")) for item in host.build_targets()}

    def test_packaged_host_reports_each_target_and_why_it_is_missing(self) -> None:
        host = self.host(player_root=self.players)
        self.assertEqual(self.availability(host), {
            "web": (True, None),
            "windows": (True, None),
            "linux": (True, None),
            "macos": (False, "This Auvra install does not include the macOS game player."),
        })
        self.assertEqual(host.player_executable_for("linux"), self.players / "linux-x64" / "auvra-player")
        self.assertIsNone(host.player_executable_for("macos"))
        self.assertIsNone(host.player_executable_for("web"))

        write_player(self.players / "macos" / "auvra-player")
        self.assertEqual(self.availability(host)["macos"], (True, None))

    def test_explicit_windows_player_overrides_the_lookup(self) -> None:
        pinned = write_player(self.root / "pinned" / "auvra-player.exe")
        host = self.host(player_root=self.root / "empty-game-player", player_executable=pinned)
        self.assertEqual(host.player_executable_for("windows"), pinned)
        self.assertEqual(self.availability(host)["windows"], (True, None))
        self.assertFalse(self.availability(host)["linux"][0])

    def test_checkout_host_explains_how_to_get_each_player(self) -> None:
        checkout = self.root / "checkout"
        with mock.patch.object(project_host_module, "_CHECKOUT_ROOT", checkout):
            host = self.host("state-checkout")
        availability = self.availability(host)
        self.assertEqual(availability["web"], (True, None))
        self.assertIn("cargo build --release in player-desktop on Windows", availability["windows"][1])
        self.assertIn("player-desktop/dist/linux-x64", availability["linux"][1])
        self.assertIn("player-desktop/dist/macos", availability["macos"][1])
        self.assertFalse(any(available for target, (available, _) in availability.items() if target != "web"))

        write_player(checkout / "player-desktop" / "dist" / "linux-x64" / "auvra-player")
        self.assertEqual(self.availability(host)["linux"], (True, None))

    def test_missing_template_makes_every_target_unavailable(self) -> None:
        host = self.host(player_root=self.players, player_template_root=self.root / "missing-template")
        availability = self.availability(host)
        self.assertEqual(sorted(availability), sorted(BUILD_TARGETS))
        for target in BUILD_TARGETS:
            self.assertEqual(availability[target], (False, "The game player template is not installed."), target)

    def test_status_response_carries_build_targets_and_validates(self) -> None:
        host = self.host(player_root=self.players)
        status = host.handle("project.getStatus", {})
        self.assertEqual([item["target"] for item in status["buildTargets"]], list(BUILD_TARGETS))
        envelope = {"protocol": "auvra.host/1", "type": "response", "id": "r-status", "session": "s1",
                    "revision": 0, "ok": True, "result": status}
        validate_response(envelope)
        self.assertNotIn(str(self.root), json.dumps(status))
        self.assertNotIn(self.root.as_posix(), json.dumps(status))

    def test_host_builds_linux_and_refuses_a_missing_player_before_the_dialog(self) -> None:
        host = self.host(player_root=self.players)
        created = host.handle("project.create", {"name": "Project"})
        reference = host.service.active.assets.put_stream(
            io.BytesIO(b"fbx-model"), size=9, mime="model/fbx", name="hero.fbx",
        )
        documents = {
            "metadata": {"id": "game-settings", "settings": {"name": "Demo Game"}},
            "levels": {"id": "level-1", "name": "First"},
            "models": {"id": "model-1", "name": "Hero", "assetId": reference.asset_id},
        }
        changed = host.handle("project.applyChanges", {
            "projectId": created["projectId"], "expectedRevision": created["revision"],
            "changes": [{"domain": domain, "documentId": document["id"], "operation": "upsert", "document": document}
                        for domain, document in documents.items()],
        })
        payload = {"projectId": changed["projectId"], "expectedRevision": changed["revision"]}

        with self.assertRaises(HostOperationError) as caught:
            host.build_game({**payload, "target": "macos"})
        self.assertEqual(caught.exception.code, "unsupported_capability")
        self.assertEqual(str(caught.exception), "This Auvra install does not include the macOS game player.")
        self.assertEqual(self.dialogs.build_requests, [])

        result = host.build_game({**payload, "target": "linux"})
        self.assertEqual(result["report"]["target"], "linux")
        destination = self.builds / "Demo Game-Linux"
        self.assertEqual((destination / "demo-game").read_bytes(), PLAYER_BYTES)
        self.assertTrue((destination / "game" / "game" / "game.json").is_file())
        self.assertEqual(json.loads((destination / BUILD_MARKER).read_text(encoding="utf-8"))["target"], "linux")

        write_player(self.players / "macos" / "auvra-player")
        again = host.build_game({**payload, "target": "macos", "destinationHandle": result["handle"]})
        self.assertEqual(again["report"]["target"], "macos")
        self.assertTrue((self.builds / "Demo Game-macOS" / "Demo Game.app" / "Contents" / "MacOS" / "Demo Game").is_file())
        self.assertEqual(self.dialogs.build_requests, ["Demo Game"])


if __name__ == "__main__":
    unittest.main()
