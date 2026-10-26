"""End-to-end authoring: every new-project template ships as a complete web game.

Each template is created through ``ProjectService.create`` (what the desktop host calls for
``project.create``), built with ``build_game`` exactly the way the host's ``project.buildGame``
does, and the exported folder is checked file by file against the project it came from.
"""
from __future__ import annotations

import ast
import copy
import hashlib
import inspect
import io
import json
import struct
import tempfile
import unittest
import wave
import zlib
from pathlib import Path
from typing import Any, Mapping

from Auvra.project import game_build, templates
from Auvra.project.assets import (
    decode_heightfield, encode_heightfield, validate_heightfield_file, validate_splatmap_file,
)
from Auvra.project.game_build import BUILD_MARKER, TEMPLATE_MANIFEST, GameBuildError, build_game
from Auvra.project.index import ProjectIndex
from Auvra.project.schemas import DOMAIN_NAMES
from Auvra.project.service import ProjectService

# A stand-in for the prebuilt player bundle (fbx-viewer (1)/dist/player) with the same shape.
PLAYER_FILES = {
    "index.html": b'<!doctype html><html><head><title>Player</title></head>'
                  b'<body><script type="module" src="assets/player.js"></script></body></html>',
    "hud-frame.html": b"<!doctype html><title>HUD</title>",
    "assets/player.js": b"console.log('player');",
    "assets/player.css": b"body{margin:0}",
    "THIRD_PARTY_NOTICES.txt": b"three - MIT License\n",
}
NOTICES = "THIRD_PARTY_NOTICES.txt"
EMPTY_TEMPLATE = "blank"


def template_ids() -> tuple[str, ...]:
    """The ids ``Auvra.project.templates`` offers, so a newly added template is covered automatically."""

    for attribute in ("TEMPLATES", "TEMPLATE_NAMES", "TEMPLATE_IDS"):
        listed = getattr(templates, attribute, None)
        if listed:
            if isinstance(listed, Mapping):
                listed = list(listed)
            ids = []
            for item in listed:
                if not isinstance(item, str):
                    item = item.get("id") if isinstance(item, Mapping) else getattr(item, "id", None)
                ids.append(item)
            return tuple(ids)
    # No published list: fall back to the string literals apply_template compares the id against.
    tree = ast.parse(inspect.getsource(templates.apply_template))
    found = {EMPTY_TEMPLATE}
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            for operand in [node.left, *node.comparators]:
                for constant in ast.walk(operand):
                    if isinstance(constant, ast.Constant) and isinstance(constant.value, str):
                        found.add(constant.value)
    return tuple(sorted(found))


TEMPLATE_IDS = template_ids()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def documents(value: Any) -> list[dict[str, Any]]:
    return value["documents"] if isinstance(value, Mapping) else list(value)


def png_bytes() -> bytes:
    """A real 1x1 RGBA PNG."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(b"\x00\x40\xa0\x40\xff")) + chunk(b"IEND", b""))


def wav_bytes() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(8000)
        writer.writeframes(b"\x00\x00" * 80)
    return buffer.getvalue()


def splatmap_bytes(samples: int) -> bytes:
    return struct.pack("<8sII", b"AUVRASP1", samples, samples) + bytes([255, 0, 0, 0]) * (samples * samples)


def collect_asset_ids(value: Any) -> set[str]:
    """Every asset handle in exported content: ``assetId``/``*AssetId`` keys and ``assetIds``/``*AssetIds`` lists."""

    found: set[str] = set()
    if isinstance(value, Mapping):
        for key, child in value.items():
            if (key == "assetId" or key.endswith("AssetId")) and isinstance(child, str) and child:
                found.add(child)
            elif (key == "assetIds" or key.endswith("AssetIds")) and isinstance(child, list):
                found.update(item for item in child if isinstance(item, str) and item)
            found |= collect_asset_ids(child)
    elif isinstance(value, list):
        for child in value:
            found |= collect_asset_ids(child)
    return found


def all_objects(content: Mapping[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Level objects plus prefab members, which carry the same terrain references."""

    members = [member for prefab in content["prefabs"] for member in prefab.get("objects") or []]
    return [*content["objects"], *members]


def named_asset_ids(content: Mapping[str, list[dict[str, Any]]]) -> set[str]:
    """The asset references the player loads by name: models, animations, attachments, textures, audio, terrain."""

    found = {item["assetId"] for domain in ("models", "animations", "attachments", "textures", "audio")
             for item in content[domain] if item.get("assetId")}
    for item in all_objects(content):
        terrain = item.get("terrainData") or {}
        for key in ("heightfield", "splatmap"):
            if isinstance(terrain.get(key), Mapping):
                found.add(terrain[key]["assetId"])
    return found


def open_level_targets(value: Any) -> list[Any]:
    """Level ids named by OpenLevel blueprint nodes and ``openLevel:<id>`` menu actions."""

    targets: list[Any] = []
    if isinstance(value, Mapping):
        data = value.get("data")
        if isinstance(data, Mapping) and data.get("action") == "OpenLevel":
            targets.append(data.get("levelId"))
        action = value.get("action")
        if isinstance(action, str) and action.strip().startswith("openLevel:"):
            targets.append(action.strip()[len("openLevel:"):].strip())
        for child in value.values():
            targets.extend(open_level_targets(child))
    elif isinstance(value, list):
        for child in value:
            targets.extend(open_level_targets(child))
    return targets


class TemplateBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="auvra template builds ")
        # Cleanups run last-in first-out: services shut down before the folder is removed.
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.player = self.root / "player-template"
        for relative, data in PLAYER_FILES.items():
            path = self.player / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        manifest = {"files": [{"path": path, "size": len(data), "sha256": sha256(data)}
                              for path, data in PLAYER_FILES.items()]}
        (self.player / TEMPLATE_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")

    # -- authoring --------------------------------------------------------------------------

    def create(self, template: str) -> ProjectService:
        service = ProjectService(ProjectIndex(self.root / "index" / f"{template}.sqlite3"))
        self.addCleanup(service.shutdown)
        status = service.create(self.root / "projects" / template, f"{template.title()} Game", template)
        self.assertEqual(status.revision, service.active.revision)
        return service

    def build(self, service: ProjectService, destination: Path, build_id: str):
        """Build the open project the way NativeProjectHost._build_game does."""

        repository = service.active
        store = repository.assets

        def read_asset(asset_id: str) -> tuple[bytes, str]:
            mime = store.reference(asset_id).mime or "application/octet-stream"
            with store.open(asset_id) as stream:
                return stream.read(), mime

        return build_game(
            domains={domain: repository.get_domain(domain) for domain in DOMAIN_NAMES},
            read_asset=read_asset,
            template_root=self.player,
            destination=destination,
            target="web",
            build_id=build_id,
            game_id=repository.project_id,
        )

    # -- export checks ----------------------------------------------------------------------

    def load(self, path: Path) -> Any:
        return json.loads(path.read_text(encoding="utf-8"))

    def check_export(self, service: ProjectService, destination: Path, report,
                     build_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """Check one export against the open project; returns (game.json, what was found)."""

        repository = service.active
        store = repository.assets
        written = sorted(path.relative_to(destination).as_posix() for path in destination.rglob("*") if path.is_file())

        # Layout: the verified player bundle, the game pack and the build marker, nothing else.
        game = self.load(destination / "game" / "game.json")
        self.assertEqual((game["format"], game["schema"], game["buildId"], game["gameId"]),
                         ("auvra.game", 1, build_id, repository.project_id))
        self.assertEqual(game["domains"], list(DOMAIN_NAMES))
        bundle = [entry["path"] for entry in self.load(self.player / TEMPLATE_MANIFEST)["files"]]
        expected_files = {*bundle, "game/game.json", BUILD_MARKER}
        expected_files |= {f"game/content/{domain}.json" for domain in game["domains"]}
        expected_files |= {f"game/assets/{item['file']}" for item in game["assets"]}
        self.assertEqual(written, sorted(expected_files))
        self.assertIn("index.html", written)
        self.assertTrue((destination / "assets").is_dir())
        self.assertNotIn(TEMPLATE_MANIFEST, written)
        if (self.player / NOTICES).is_file():
            self.assertIn(NOTICES, written)
        for relative in bundle:
            self.assertEqual((destination / relative).read_bytes(), (self.player / relative).read_bytes(), relative)
        marker = self.load(destination / BUILD_MARKER)
        self.assertEqual((marker["schema"], marker["kind"], marker["buildId"], marker["target"]),
                         (1, "auvra-game-build", build_id, "web"))
        self.assertEqual(sorted(item["path"] for item in marker["files"]), sorted(set(written) - {BUILD_MARKER}))
        for item in marker["files"]:
            data = (destination / item["path"]).read_bytes()
            self.assertEqual((item["size"], item["sha256"]), (len(data), sha256(data)), item["path"])
        self.assertEqual(report.files, len(written))
        self.assertEqual(report.bytes, sum((destination / path).stat().st_size for path in written))
        self.assertEqual((report.build_id, report.target, report.warnings), (build_id, "web", ()))

        # Content: every domain is the project's documents minus editor-only data.
        content: dict[str, list[dict[str, Any]]] = {}
        for domain in game["domains"]:
            exported = self.load(destination / "game" / "content" / f"{domain}.json")
            self.assertEqual(exported["schemaVersion"], 1)
            expected = []
            for item in documents(repository.get_domain(domain)):
                if domain == "metadata" and item["id"] == "editor-state":
                    continue
                item = copy.deepcopy(item)
                if domain == "textures":
                    item.pop("generation", None)
                expected.append(item)
            self.assertEqual(exported["documents"], expected, domain)
            content[domain] = exported["documents"]

        # Assets: each referenced id ships once as game/assets/<id>.<ext>, byte-identical to the project blob.
        referenced = collect_asset_ids(content)
        self.assertLessEqual(named_asset_ids(content), referenced)
        self.assertLessEqual(repository.referenced_asset_ids(), referenced)
        shipped = {item["id"]: item for item in game["assets"]}
        self.assertEqual(len(shipped), len(game["assets"]))
        self.assertEqual(set(shipped), referenced)
        self.assertEqual(report.assets, len(referenced))
        for asset_id in sorted(referenced):
            reference = store.reference(asset_id)
            self.assertIn(reference.mime, game_build._MIME_EXTENSIONS, f"asset {asset_id} has no web extension")
            file_name = f"{asset_id}.{game_build._MIME_EXTENSIONS[reference.mime]}"
            data = (destination / "game" / "assets" / file_name).read_bytes()
            self.assertEqual((len(data), sha256(data)), (reference.size, asset_id), file_name)
            with store.open(asset_id) as stream:
                self.assertEqual(data, stream.read(), file_name)
            self.assertEqual(shipped[asset_id], {"id": asset_id, "file": file_name, "mime": reference.mime,
                                                 "size": reference.size})

        # References: startup level, player blueprint, level travel and object links resolve in the export.
        level_ids = [item["id"] for item in content["levels"]]
        self.assertTrue(level_ids)
        self.assertEqual(game["levels"], [{"id": item["id"], "name": item["name"]} for item in content["levels"]])
        self.assertEqual(report.levels, len(level_ids))
        settings = game["settings"]
        stored = next((item.get("settings") or {} for item in content["metadata"] if item["id"] == "game-settings"), {})
        self.assertEqual(game["startupLevelId"], settings["startupLevelId"])
        self.assertIn(game["startupLevelId"], level_ids)
        if stored.get("startupLevelId"):
            self.assertEqual(game["startupLevelId"], stored["startupLevelId"])
        self.assertEqual(game["name"], stored.get("name") or game_build.DEFAULT_GAME_SETTINGS["name"])
        blueprint_ids = {item["id"] for item in content["blueprints"]}
        model_ids = {item["id"] for item in content["models"]}
        if stored.get("playerBlueprintId"):
            self.assertEqual(settings["playerBlueprintId"], stored["playerBlueprintId"])
        if settings["playerBlueprintId"] is not None:
            self.assertIn(settings["playerBlueprintId"], blueprint_ids)
        for blueprint in content["blueprints"]:
            if blueprint.get("linkedModelId"):
                self.assertIn(blueprint["linkedModelId"], model_ids, blueprint["id"])
        for item in content["objects"]:
            self.assertIn(item["levelId"], level_ids, item["id"])
            if item.get("modelId"):
                self.assertIn(item["modelId"], model_ids, item["id"])
        targets = open_level_targets(content)
        for target in targets:
            self.assertIsInstance(target, str)
            self.assertIn(target, level_ids, "OpenLevel names a level the build does not ship")

        # Terrain: shipped heightfields decode to (resolution + 1)^2 samples; splat maps match the grid.
        heightfields = splatmaps = 0
        for item in all_objects(content):
            terrain = item.get("terrainData") or {}
            if not isinstance(terrain.get("heightfield"), Mapping) and not isinstance(terrain.get("splatmap"), Mapping):
                continue
            samples = int(terrain["resolution"]) + 1
            heightfield = terrain.get("heightfield")
            if isinstance(heightfield, Mapping):
                path = destination / "game" / "assets" / shipped[heightfield["assetId"]]["file"]
                self.assertEqual(path.suffix, ".ahf")
                validate_heightfield_file(path)
                columns, rows, values = decode_heightfield(path.read_bytes())
                self.assertEqual((columns, rows), (samples, samples), item["id"])
                self.assertEqual((heightfield["columns"], heightfield["rows"]), (samples, samples), item["id"])
                self.assertEqual(len(values), samples * samples, item["id"])
                heightfields += 1
            splatmap = terrain.get("splatmap")
            if isinstance(splatmap, Mapping):
                path = destination / "game" / "assets" / shipped[splatmap["assetId"]]["file"]
                self.assertEqual(path.suffix, ".asp")
                validate_splatmap_file(path)
                self.assertEqual(path.stat().st_size, 16 + 4 * samples * samples, item["id"])
                splatmaps += 1
        checked = {"heightfields": heightfields, "splatmaps": splatmaps, "openLevel": targets,
                   "mimes": {item["mime"] for item in game["assets"]}}
        return game, checked

    def build_and_check(self, service: ProjectService, label: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """Build twice into one folder, then confirm an unrelated folder is never overwritten."""

        builds = self.root / "builds" / label
        destination = builds / f"{label}-Web"
        revision = service.get_status().revision
        first, _ = self.check_export(service, destination, self.build(service, destination, "build-1"), "build-1")
        second, checked = self.check_export(service, destination, self.build(service, destination, "build-2"),
                                            "build-2")
        self.assertEqual({**first, "buildId": "build-2"}, second)
        self.assertEqual([path.name for path in builds.iterdir()], [destination.name])

        unrelated = builds / "My Documents"
        unrelated.mkdir()
        (unrelated / "notes.txt").write_text("keep me", encoding="utf-8")
        with self.assertRaises(GameBuildError) as caught:
            self.build(service, unrelated, "build-3")
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertIn("not an Auvra build", caught.exception.message)
        self.assertEqual([path.name for path in unrelated.iterdir()], ["notes.txt"])
        self.assertEqual((unrelated / "notes.txt").read_text(encoding="utf-8"), "keep me")
        self.assertEqual(sorted(path.name for path in builds.iterdir()), sorted([destination.name, unrelated.name]))
        self.assertEqual(self.load(destination / "game" / "game.json")["buildId"], "build-2")

        # Building only reads the project.
        self.assertEqual(service.get_status().revision, revision)
        return second, checked

    # -- tests ------------------------------------------------------------------------------

    def test_templates_are_discovered(self) -> None:
        self.assertIn(EMPTY_TEMPLATE, TEMPLATE_IDS)
        self.assertIn("starter", TEMPLATE_IDS)
        self.assertEqual(len(set(TEMPLATE_IDS)), len(TEMPLATE_IDS))
        self.assertTrue(all(isinstance(identity, str) and identity for identity in TEMPLATE_IDS))

    def test_every_playable_template_builds_a_complete_web_game(self) -> None:
        playable = [identity for identity in TEMPLATE_IDS if identity != EMPTY_TEMPLATE]
        self.assertTrue(playable)
        for template in playable:
            with self.subTest(template=template):
                service = self.create(template)
                game, checked = self.build_and_check(service, template)
                if template == "starter":
                    self.assertGreaterEqual(checked["heightfields"], 1)
                    self.assertIn("model/fbx", checked["mimes"])
                    self.assertEqual(game["settings"]["playerBlueprintId"], "starter-player")
                    self.assertEqual(game["name"], "Starter Game")

    def test_blank_template_builds_once_a_level_is_authored(self) -> None:
        service = self.create(EMPTY_TEMPLATE)
        repository = service.active
        self.assertEqual([documents(repository.get_domain(domain)) for domain in DOMAIN_NAMES],
                         [[] for _ in DOMAIN_NAMES])

        # An empty project has nothing to play, so the build is refused and nothing is written.
        builds = self.root / "builds" / EMPTY_TEMPLATE
        with self.assertRaises(GameBuildError) as caught:
            self.build(service, builds / "Empty-Web", "build-0")
        self.assertEqual(caught.exception.code, "invalid_project")
        self.assertEqual(list(builds.iterdir()) if builds.exists() else [], [])

        project_id = repository.project_id

        def upload(data: bytes, mime: str, name: str) -> str:
            return service.begin_upload(io.BytesIO(data), project_id=project_id, size=len(data),
                                        mime=mime, name=name).asset_id

        samples = 5
        heights = [float(column - row) / 4.0 for row in range(samples) for column in range(samples)]
        heightfield_id = upload(encode_heightfield(heights, samples, samples), "application/vnd.auvra.heightfield",
                                "terrain.ahf")
        splatmap_id = upload(splatmap_bytes(samples), "application/vnd.auvra.splatmap", "terrain.asp")
        texture_id = upload(png_bytes(), "image/png", "grass.png")
        audio_id = upload(wav_bytes(), "audio/wav", "theme.wav")

        def exec_pin(identity: str, name: str, direction: str) -> dict[str, str]:
            return {"id": identity, "name": name, "dataType": "Exec", "direction": direction}

        travel = {
            "nodes": [
                {"id": "begin", "type": "Event", "name": "Event BeginPlay", "position": {"x": 0, "y": 0},
                 "inputs": [], "outputs": [exec_pin("begin-out", "Out", "Output")]},
                {"id": "travel", "type": "LevelAction", "name": "Open Level (Caves)", "position": {"x": 240, "y": 0},
                 "inputs": [exec_pin("travel-in", "Exec", "Input")], "outputs": [exec_pin("travel-out", "Out", "Output")],
                 "data": {"action": "OpenLevel", "levelId": "authored-caves"}},
            ],
            "connections": [{"id": "wire", "fromNodeId": "begin", "fromPinId": "begin-out",
                             "toNodeId": "travel", "toPinId": "travel-in"}],
            "variables": [],
        }
        status = service.apply_changes({
            "metadata": [
                {"id": "editor-state", "settings": {"selection": ["authored-terrain"]}},
                {"id": "game-settings", "settings": {"schema": 1, "name": "Authored Game",
                                                     "startupLevelId": "authored-meadow"}},
            ],
            "levels": [
                {"id": "authored-meadow", "name": "Meadow", "createdAt": 0, "blueprint": travel},
                {"id": "authored-caves", "name": "Caves", "createdAt": 1},
            ],
            "textures": [{"id": "authored-grass", "name": "Grass", "assetId": texture_id,
                          "dimensions": {"width": 1, "height": 1}}],
            "audio": [{"id": "authored-theme", "name": "Theme", "assetId": audio_id, "type": "music"}],
            "objects": [{
                "id": "authored-terrain", "levelId": "authored-meadow", "name": "Terrain", "type": "terrain",
                "position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0],
                "terrainData": {
                    "resolution": samples - 1, "width": 32.0, "depth": 32.0,
                    "heightfield": {"assetId": heightfield_id, "encoding": "float32le",
                                    "columns": samples, "rows": samples},
                    "splatmap": {"assetId": splatmap_id, "encoding": "rgba8", "columns": samples, "rows": samples},
                    "textureLayers": [{"textureId": "authored-grass", "tiling": 8}],
                },
            }],
        }, project_id=project_id, expected_revision=repository.revision)
        self.assertEqual(status.revision, repository.revision)

        game, checked = self.build_and_check(service, EMPTY_TEMPLATE)
        self.assertEqual((checked["heightfields"], checked["splatmaps"]), (1, 1))
        self.assertEqual(checked["openLevel"], ["authored-caves"])
        self.assertEqual(checked["mimes"], {"application/vnd.auvra.heightfield", "application/vnd.auvra.splatmap",
                                             "image/png", "audio/wav"})
        self.assertEqual((game["name"], game["startupLevelId"], game["settings"]["playerBlueprintId"]),
                         ("Authored Game", "authored-meadow", None))


if __name__ == "__main__":
    unittest.main()
