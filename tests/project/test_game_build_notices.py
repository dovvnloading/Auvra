"""Exported games ship third-party notices for the web player and the Windows player."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from Auvra.project.game_build import BUILD_MARKER, NOTICES_FILE, build_game

WEB_NOTICES = b"Third-party software notices\n\nthree@0.170.0 (MIT)\n"
PLAYER_NOTICES = b"Third-party software notices: the Auvra Windows game player\n\nwry@0.57.1 (Apache-2.0 OR MIT)\n"
DOMAINS = {
    "metadata": [{"id": "game-settings", "settings": {"name": "Demo"}}],
    "levels": [{"id": "level-1", "name": "First"}],
}


class GameBuildNoticesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.destination = self.root / "builds" / "Demo"
        self.player = self.root / "player" / "auvra-player.exe"
        self.player.parent.mkdir()
        self.player.write_bytes(b"MZ-player")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def template(self, *, notices: bool = True) -> Path:
        files = {"index.html": b"<!doctype html><title>Player</title>"}
        if notices:
            files[NOTICES_FILE] = WEB_NOTICES
        root = self.root / ("template" if notices else "template-without-notices")
        for relative, data in files.items():
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            (root / relative).write_bytes(data)
        manifest = {"files": [{"path": path, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                              for path, data in files.items()]}
        (root / "player-template.json").write_text(json.dumps(manifest), encoding="utf-8")
        return root

    def build(self, *, target: str = "windows", template: Path | None = None):
        return build_game(
            domains=DOMAINS, read_asset=lambda asset_id: (b"", "application/octet-stream"),
            template_root=template or self.template(), destination=self.destination, target=target,
            build_id="build-1", game_id="game-1",
            player_executable=self.player if target == "windows" else None,
        )

    def assert_marker_matches_files(self) -> None:
        marker = json.loads((self.destination / BUILD_MARKER).read_text(encoding="utf-8"))
        paths = [item["path"] for item in marker["files"]]
        self.assertEqual(len(paths), len(set(paths)))
        for item in marker["files"]:
            data = (self.destination / item["path"]).read_bytes()
            self.assertEqual((item["size"], item["sha256"]), (len(data), hashlib.sha256(data).hexdigest()), item["path"])

    def test_windows_build_appends_the_player_crate_notices(self) -> None:
        (self.player.parent / NOTICES_FILE).write_bytes(PLAYER_NOTICES)
        report = self.build()
        self.assertEqual(report.warnings, ())
        self.assertEqual((self.destination / NOTICES_FILE).read_bytes(), WEB_NOTICES.rstrip() + b"\n\n" + PLAYER_NOTICES)
        self.assertEqual((self.destination / "Demo.exe").read_bytes(), b"MZ-player")
        self.assert_marker_matches_files()

    def test_windows_build_without_player_notices_warns_and_keeps_web_notices(self) -> None:
        report = self.build()
        self.assertEqual((self.destination / NOTICES_FILE).read_bytes(), WEB_NOTICES)
        self.assertEqual(len(report.warnings), 1)
        self.assertIn("third-party notices were not found", report.warnings[0])
        self.assertNotIn(str(self.root), report.warnings[0])
        self.assert_marker_matches_files()

    def test_template_without_notices_gets_the_player_notices(self) -> None:
        (self.player.parent / NOTICES_FILE).write_bytes(PLAYER_NOTICES)
        self.build(template=self.template(notices=False))
        self.assertEqual((self.destination / NOTICES_FILE).read_bytes(), PLAYER_NOTICES)
        self.assert_marker_matches_files()

    def test_web_build_ships_only_the_web_player_notices(self) -> None:
        (self.player.parent / NOTICES_FILE).write_bytes(PLAYER_NOTICES)
        report = self.build(target="web")
        self.assertEqual(report.warnings, ())
        self.assertEqual((self.destination / NOTICES_FILE).read_bytes(), WEB_NOTICES)
        self.assert_marker_matches_files()


if __name__ == "__main__":
    unittest.main()
