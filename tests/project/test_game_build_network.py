import asyncio
from contextlib import suppress
import json
import os
import re
import secrets
import sys
import tempfile
import unittest
from pathlib import Path
import unittest.mock as mock

from Auvra.project import game_build as game_build_module
from Auvra.project.game_build import BUILD_MARKER, GameBuildError, build_game, normalize_game_settings, relay_origin

from tests.net.test_relay import Client
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
        self.assertIn("BUNDLED_MAX_PLAYERS: int | None = 8", relay)
        readme = (self.destination / "server" / "README.txt").read_text(encoding="utf-8")
        self.assertIn("python relay.py --port 8443", readme)
        self.assertIn("AUVRA_RELAY_HOST_TOKEN", readme)
        self.assertIn("--insecure-local", readme)
        self.assertIn("Host credentials", readme)
        self.assertIn("wss://", readme)
        self.assertIn("maximum of 8 players per room (including the host)", readme)
        self.assertIn("--max-players 8", readme)
        marker = json.loads((self.destination / BUILD_MARKER).read_text(encoding="utf-8"))
        record = next(item for item in marker["files"] if item["path"] == "index.html")
        self.assertEqual(record["sha256"], sha256(page.encode("utf-8")))
        relay_record = next(item for item in marker["files"] if item["path"] == "server/relay.py")
        self.assertEqual(relay_record["sha256"], sha256((self.destination / "server" / "relay.py").read_bytes()))
        self.assertEqual(report.warnings, ())
        manifest = json.loads((self.destination / "game" / "game.json").read_text(encoding="utf-8"))
        self.assertTrue(manifest["settings"]["network"]["enabled"])
        self.assertEqual(manifest["settings"]["network"]["maxPlayers"], 8)
        self.assertNotIn("hostToken", manifest["settings"]["network"])

    def test_authored_limit_normalization_matches_player(self):
        cases = [(None, 8), (True, 8), (False, 8), ("2", 8), ({}, 8),
                 (0, 1), (-100, 1), (1, 1), (2, 2), (8, 8), (16, 16),
                 (17, 16), (10 ** 400, 16), (2.49, 2), (2.5, 3), (15.5, 16),
                 (float("nan"), 8), (float("inf"), 8), (float("-inf"), 8)]
        self.assertEqual(normalize_game_settings({})["network"]["maxPlayers"], 8)
        for value, expected in cases:
            with self.subTest(value=value):
                settings = normalize_game_settings({"network": {"maxPlayers": value}})
                self.assertEqual(settings["network"]["maxPlayers"], expected)
                self.assertIs(type(settings["network"]["maxPlayers"]), int)

    def test_build_normalizes_limit_in_manifest_readme_and_relay(self):
        for authored, expected in ((None, 8), ("2", 8), (True, 8), (0, 1), (2.5, 3), (99, 16)):
            with self.subTest(authored=authored):
                self.build({"enabled": True, "maxPlayers": authored})
                manifest = json.loads((self.destination / "game" / "game.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["settings"]["network"]["maxPlayers"], expected)
                server = self.destination / "server"
                self.assertIn(f"BUNDLED_MAX_PLAYERS: int | None = {expected}",
                              (server / "relay.py").read_text(encoding="utf-8"))
                self.assertIn(f"maximum of {expected} players", (server / "README.txt").read_text(encoding="utf-8"))
                self.assertNotIn("BUNDLED_MAX_PLAYERS: int | None = None",
                                 (server / "relay.py").read_text(encoding="utf-8"))

    def test_incompatible_relay_template_fails_closed_and_preserves_build(self):
        self.build({"enabled": False})
        previous = (self.destination / BUILD_MARKER).read_bytes()
        template = Path(self.tmp.name) / "incompatible-relay.py"
        declaration = b"BUNDLED_MAX_PLAYERS: int | None = None"
        for source in (b"# old generic relay", declaration + b"\n" + declaration):
            with self.subTest(source=source):
                template.write_bytes(source)
                with mock.patch.object(game_build_module, "RELAY_SCRIPT", template):
                    with self.assertRaises(GameBuildError) as rejected:
                        self.build({"enabled": True, "maxPlayers": 2})
                self.assertEqual(rejected.exception.code, "unsupported_capability")
                self.assertEqual((self.destination / BUILD_MARKER).read_bytes(), previous)
                self.assertFalse((self.destination / "server").exists())
                self.assertEqual(list(self.destination.parent.glob(".Demo.staging-*")), [])

    def test_bundled_relay_enforces_authored_limits_over_real_websockets(self):
        # Execute the exact generated standalone script from a different cwd,
        # not an imported source relay or a mocked capacity check. The host
        # counts toward the cap, and neither guests nor the authenticated
        # host can choose a higher limit in hello.
        for authored, operator, insecure in (
            (1, None, False), (2, None, False), (8, None, False), (16, None, False),
            (2, 16, False), (8, 2, False), (2, 16, True),
        ):
            with self.subTest(authored=authored, operator=operator, insecure=insecure):
                self.build({"enabled": True, "maxPlayers": authored})
                asyncio.run(self._exercise_bundled_relay(
                    min(authored, operator) if operator is not None else authored,
                    operator=operator, insecure=insecure,
                ))

    async def _exercise_bundled_relay(self, limit: int, *, operator: int | None, insecure: bool):
        script = self.destination / "server" / "relay.py"
        token = secrets.token_urlsafe(32)
        env = os.environ.copy()
        if insecure:
            env.pop("AUVRA_RELAY_HOST_TOKEN", None)
        else:
            env["AUVRA_RELAY_HOST_TOKEN"] = token
        args = [sys.executable, str(script), "--port", "0"]
        if operator is not None:
            args.extend(["--max-players", str(operator)])
        if insecure:
            args.append("--insecure-local")
        process = await asyncio.create_subprocess_exec(
            *args, cwd=str(self.template), env=env, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        clients: list[Client] = []
        try:
            startup = await asyncio.wait_for(process.stdout.readline(), timeout=15)
            match = re.search(rb"127\.0\.0\.1:(\d+).*max (\d+) players per room", startup)
            self.assertIsNotNone(match, startup.decode("utf-8", errors="replace"))
            port = int(match.group(1))
            self.assertEqual(int(match.group(2)), limit)

            async def connect() -> Client:
                client = await asyncio.wait_for(Client.connect(port), timeout=5)
                clients.append(client)
                self.assertEqual(client.status, "101")
                return client

            host = await connect()
            credentials = {} if insecure else {"hostToken": token}
            welcome = await host.hello(name="Host", maxPlayers=999, **credentials)
            self.assertEqual(welcome["t"], "welcome")
            self.assertEqual(welcome["host"], welcome["you"])
            host_id = welcome["you"]

            # Fill all but the final guest slot. A lower guest-advertised
            # limit must not shrink the server's room capacity either.
            for index in range(max(0, limit - 2)):
                guest = await connect()
                admitted = await guest.hello(name=f"Guest {index}", maxPlayers=1)
                self.assertEqual(admitted["t"], "welcome")
                self.assertEqual(admitted["host"], host_id)
                self.assertEqual((await host.receive())["t"], "joined")

            # Race two guests for the final slot (or no slot for capacity 1).
            candidates = await asyncio.gather(connect(), connect())
            results = await asyncio.gather(
                candidates[0].hello(name="Candidate A", maxPlayers=16),
                candidates[1].hello(name="Candidate B", maxPlayers=999),
            )
            winners = [(client, message) for client, message in zip(candidates, results)
                       if message["t"] == "welcome"]
            self.assertEqual(len(winners), int(limit > 1))
            for client, message in zip(candidates, results):
                if message["t"] != "welcome":
                    self.assertEqual((message["t"], message["code"]), ("error", "full"))
                    self.assertEqual(await client.receive(), "close")

            if winners:
                winner, admitted = winners[0]
                self.assertEqual(len(admitted["peers"]), limit - 1)
                self.assertEqual(admitted["host"], host_id)
                self.assertEqual((await host.receive())["peer"]["id"], admitted["you"])
            overflow = await connect()
            error = await overflow.hello(name="Overflow", maxPlayers=999)
            self.assertEqual((error["t"], error["code"]), ("error", "full"))
            self.assertEqual(await overflow.receive(), "close")

            if winners:
                await winner.close()
                self.assertEqual(await host.receive(), {"t": "left", "id": admitted["you"]})
                replacement = await connect()
                replacement_welcome = await replacement.hello(name="Replacement")
                self.assertEqual(replacement_welcome["t"], "welcome")
                self.assertEqual(replacement_welcome["host"], host_id)
                self.assertEqual(len(replacement_welcome["peers"]), limit - 1)
                self.assertEqual((await host.receive())["t"], "joined")

            # The same immutable cap applies independently to another room.
            other_host = await connect()
            other = await other_host.hello(room="other", name="Other host", **credentials)
            self.assertEqual(other["t"], "welcome")
            self.assertEqual(other["host"], other["you"])
            self.assertEqual(other["peers"], [])
        finally:
            for client in reversed(clients):
                await client.close()
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    process.terminate()
            try:
                await asyncio.wait_for(process.communicate(), timeout=10)
            except asyncio.TimeoutError:
                with suppress(ProcessLookupError):
                    process.kill()
                await process.communicate()

    def test_persisted_host_credentials_are_not_exported_and_existing_build_is_preserved(self):
        self.build({"enabled": False})
        previous = (self.destination / BUILD_MARKER).read_bytes()
        credential = "A" * 43
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                with self.assertRaises(GameBuildError) as rejected:
                    self.build({"enabled": enabled, "hostToken": credential})
                self.assertEqual(rejected.exception.code, "invalid_project")
                self.assertIn("Remove the saved multiplayer host credential", str(rejected.exception))
                self.assertNotIn(credential, str(rejected.exception))
                self.assertEqual((self.destination / BUILD_MARKER).read_bytes(), previous)
                self.assertEqual(list(self.destination.parent.glob(".Demo.staging-*")), [])

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
