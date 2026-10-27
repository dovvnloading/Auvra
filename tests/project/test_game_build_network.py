import json
import tempfile
import unittest
from pathlib import Path

from Auvra.project.game_build import BUILD_MARKER, build_game, relay_origin

from tests.project.test_game_build import ASSETS, project_domains, sha256

PAGE = b"<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; connect-src 'self' blob:; form-action 'none'\"><title>Player</title>"


class NetworkBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.template = root / "template"
        self.template.mkdir()
        (self.template / "index.html").write_bytes(PAGE)
        manifest = {"files": [{"path": "index.html", "size": len(PAGE), "sha256": sha256(PAGE)}]}
        (self.template / "player-template.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.destination = root / "builds" / "Demo"

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, network):
        settings = {"name": "Demo", "network": network}
        domains = project_domains(metadata=[{"id": "game-settings", "settings": settings}])
        return build_game(domains=domains, read_asset=lambda asset_id: ASSETS[asset_id], template_root=self.template,
                          destination=self.destination, target="web", build_id="b1", game_id="g1")

    def test_multiplayer_builds_allow_the_relay_and_ship_it(self):
        report = self.build({"enabled": True, "serverUrl": "wss://Relay.Example.com:8443/game", "room": "main", "maxPlayers": 8})
        page = (self.destination / "index.html").read_text(encoding="utf-8")
        self.assertIn("connect-src 'self' blob: wss://relay.example.com:8443;", page)
        relay = (self.destination / "server" / "relay.py").read_text(encoding="utf-8")
        self.assertIn("def start_relay", relay)
        readme = (self.destination / "server" / "README.txt").read_text(encoding="utf-8")
        self.assertIn("python relay.py --port 8443", readme)
        marker = json.loads((self.destination / BUILD_MARKER).read_text(encoding="utf-8"))
        record = next(item for item in marker["files"] if item["path"] == "index.html")
        self.assertEqual(record["sha256"], sha256(page.encode("utf-8")))
        self.assertEqual(report.warnings, ())
        manifest = json.loads((self.destination / "game" / "game.json").read_text(encoding="utf-8"))
        self.assertTrue(manifest["settings"]["network"]["enabled"])

    def test_single_player_builds_are_unchanged(self):
        self.build({"enabled": False, "serverUrl": "ws://127.0.0.1:7777"})
        self.assertEqual((self.destination / "index.html").read_bytes(), PAGE)
        self.assertFalse((self.destination / "server").exists())

    def test_bad_relay_addresses_are_never_put_in_the_policy(self):
        report = self.build({"enabled": True, "serverUrl": "ws://evil.example; script-src *"})
        self.assertEqual((self.destination / "index.html").read_bytes(), PAGE)
        self.assertTrue(any("not a ws://" in warning for warning in report.warnings))

    def test_relay_origin(self):
        self.assertEqual(relay_origin({"network": {"enabled": True, "serverUrl": "ws://127.0.0.1:7777"}}), "ws://127.0.0.1:7777")
        self.assertEqual(relay_origin({"network": {"enabled": True, "serverUrl": "wss://example.com/path"}}), "wss://example.com")
        self.assertIsNone(relay_origin({"network": {"enabled": False, "serverUrl": "ws://127.0.0.1:7777"}}))
        self.assertIsNone(relay_origin({"network": {"enabled": True, "serverUrl": "http://example.com"}}))
        self.assertIsNone(relay_origin({"network": {"enabled": True, "serverUrl": "ws://example.com:99999"}}))
        self.assertIsNone(relay_origin({}))


if __name__ == "__main__":
    unittest.main()
