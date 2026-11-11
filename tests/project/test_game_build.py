from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import Auvra.project.game_build as game_build_module
from Auvra.project.game_build import BUILD_MARKER, GameBuildError, build_game
from Auvra.project.schemas import DOMAIN_NAMES

MODEL_ID = "a" * 64
TEXTURE_ID = "b" * 64
UNUSED_ID = "c" * 64
HEIGHTFIELD_ID = "d" * 64

ASSETS = {
    MODEL_ID: (b"fbx-bytes", "model/fbx"),
    TEXTURE_ID: (b"png-bytes", "image/png"),
    UNUSED_ID: (b"never-shipped", "audio/ogg"),
    HEIGHTFIELD_ID: (b"heights", "application/vnd.auvra.heightfield"),
}

TEMPLATE_FILES = {
    "index.html": b"<!doctype html><title>Player</title>",
    "assets/player.js": b"console.log('player');",
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def project_domains(**overrides):
    domains = {
        "metadata": [
            {"id": "editor-state", "camera": {"x": 1}},
            {"id": "game-settings", "settings": {"name": "Demo", "quality": {"fov": 75}}},
        ],
        "levels": [{"id": "level-1", "name": "First"}, {"id": "level-2", "name": "Second"}],
        "models": [{"id": "model-1", "name": "Hero", "assetId": MODEL_ID}],
        "textures": [{
            "id": "texture-1", "name": "Skin", "assetId": TEXTURE_ID,
            "generation": {"providerId": "p", "artifactSha256": TEXTURE_ID, "inputAssetIds": [UNUSED_ID]},
        }],
        "objects": [{
            "id": "terrain", "levelId": "level-2", "name": "Ground", "type": "terrain",
            "terrainData": {"heightfield": {"assetId": HEIGHTFIELD_ID}},
        }],
    }
    domains.update(overrides)
    return domains


class GameBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.template = self.root / "template"
        for relative, data in TEMPLATE_FILES.items():
            path = self.template / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        manifest = {"files": [{"path": p, "size": len(d), "sha256": sha256(d)} for p, d in TEMPLATE_FILES.items()]}
        (self.template / "player-template.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.output = self.root / "builds"
        self.destination = self.output / "Demo"
        self.reads: list[str] = []

    def tearDown(self):
        self.tmp.cleanup()

    def read_asset(self, asset_id):
        self.reads.append(asset_id)
        return ASSETS[asset_id]

    def build(self, build_id="build-1", **overrides):
        options = dict(
            domains=project_domains(), read_asset=self.read_asset, template_root=self.template,
            destination=self.destination, target="web", build_id=build_id, game_id="game-1",
        )
        options.update(overrides)
        return build_game(**options)

    def load(self, relative):
        return json.loads((self.destination / relative).read_text(encoding="utf-8"))

    def assert_no_leftovers(self):
        self.assertEqual(sorted(p.name for p in self.output.iterdir() if p.name != self.destination.name), [])

    def test_happy_path_layout_and_manifest(self):
        report = self.build()
        for relative, data in TEMPLATE_FILES.items():
            self.assertEqual((self.destination / relative).read_bytes(), data)
        self.assertFalse((self.destination / "player-template.json").exists())
        manifest = self.load("game/game.json")
        self.assertEqual(manifest["format"], "auvra.game")
        self.assertEqual(manifest["schema"], 1)
        self.assertEqual((manifest["gameId"], manifest["buildId"], manifest["name"]), ("game-1", "build-1", "Demo"))
        self.assertEqual(manifest["startupLevelId"], "level-1")
        self.assertEqual(manifest["settings"]["startupLevelId"], "level-1")
        self.assertEqual(manifest["settings"]["quality"], {"shadows": True, "postProcessing": True, "maxDpr": 2, "fov": 75, "meshLod": True, "occlusionCulling": True, "textureCompression": True, "antiAliasing": "temporal", "renderScale": 1, "loadLevelsOnDemand": True, "assetMemoryMb": 2048, "renderer": "auto", "shadowPages": False, "textureGraphCooking": "capable"})
        self.assertEqual(manifest["settings"]["navigation"], {"agentRadius": 0.4, "agentHeight": 1.8, "maxSlopeDegrees": 40, "maxStepHeight": 0.35})
        self.assertEqual(manifest["levels"], [{"id": "level-1", "name": "First"}, {"id": "level-2", "name": "Second"}])
        self.assertEqual(manifest["domains"], list(DOMAIN_NAMES))
        self.assertEqual(manifest["assets"], [
            {"id": MODEL_ID, "file": f"{MODEL_ID}.fbx", "mime": "model/fbx", "size": 9},
            {"id": TEXTURE_ID, "file": f"{TEXTURE_ID}.png", "mime": "image/png", "size": 9},
            {"id": HEIGHTFIELD_ID, "file": f"{HEIGHTFIELD_ID}.ahf", "mime": "application/vnd.auvra.heightfield", "size": 7},
        ])
        self.assertEqual((self.destination / "game/assets" / f"{MODEL_ID}.fbx").read_bytes(), b"fbx-bytes")
        for domain in DOMAIN_NAMES:
            self.assertEqual(self.load(f"game/content/{domain}.json")["schemaVersion"], 1)
        marker = self.load(BUILD_MARKER)
        self.assertEqual((marker["schema"], marker["kind"], marker["buildId"], marker["target"]),
                         (1, "auvra-game-build", "build-1", "web"))
        for item in marker["files"]:
            data = (self.destination / item["path"]).read_bytes()
            self.assertEqual((item["size"], item["sha256"]), (len(data), sha256(data)))
        written = sorted(p.relative_to(self.destination).as_posix() for p in self.destination.rglob("*") if p.is_file())
        self.assertEqual(written, sorted([item["path"] for item in marker["files"]] + [BUILD_MARKER]))
        self.assertEqual((report.files, report.assets, report.levels, report.warnings), (len(written), 3, 2, ()))
        self.assertEqual(report.bytes, sum((self.destination / p).stat().st_size for p in written))
        self.assert_no_leftovers()

    def test_windows_build_ships_the_player_named_after_the_game(self):
        player = self.root / "auvra-player.exe"
        player.write_bytes(b"MZ-player")
        report = self.build(target="windows", player_executable=player)
        self.assertEqual((self.destination / "Demo.exe").read_bytes(), b"MZ-player")
        self.assertTrue((self.destination / "index.html").exists())
        marker = self.load(BUILD_MARKER)
        self.assertEqual(marker["target"], "windows")
        self.assertIn("Demo.exe", [item["path"] for item in marker["files"]])
        self.assertEqual(report.target, "windows")

    def test_windows_build_without_player_is_unsupported(self):
        with self.assertRaises(GameBuildError) as raised:
            self.build(target="windows", player_executable=self.root / "missing.exe")
        self.assertEqual(raised.exception.code, "unsupported_capability")
        self.assertFalse(self.destination.exists())

    def test_editor_only_data_is_stripped(self):
        self.build()
        metadata = self.load("game/content/metadata.json")["documents"]
        self.assertEqual([item["id"] for item in metadata], ["game-settings"])
        texture = self.load("game/content/textures.json")["documents"][0]
        self.assertNotIn("generation", texture)

    def test_unreferenced_asset_is_excluded(self):
        self.build()
        self.assertNotIn(UNUSED_ID, self.reads)
        self.assertFalse(any(UNUSED_ID in p.name for p in (self.destination / "game/assets").iterdir()))
        self.assertNotIn(UNUSED_ID, [item["id"] for item in self.load("game/game.json")["assets"]])

    def test_overwrites_a_marked_build(self):
        self.build("build-1")
        (self.destination / "stale.txt").write_text("old", encoding="utf-8")
        player = self.root / "auvra-player.exe"
        player.write_bytes(b"MZ-player")
        report = self.build("build-2", target="windows", player_executable=player)
        self.assertEqual(report.build_id, "build-2")
        self.assertEqual(self.load("game/game.json")["buildId"], "build-2")
        self.assertEqual(self.load(BUILD_MARKER)["target"], "windows")
        self.assertFalse((self.destination / "stale.txt").exists())
        self.assert_no_leftovers()

    def test_refuses_an_unmarked_destination(self):
        self.destination.mkdir(parents=True)
        (self.destination / "keep.txt").write_text("mine", encoding="utf-8")
        with self.assertRaises(GameBuildError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertIn("not an Auvra build", caught.exception.message)
        self.assertEqual(sorted(p.name for p in self.destination.iterdir()), ["keep.txt"])
        self.assert_no_leftovers()

    def test_template_hash_mismatch_is_unsupported(self):
        (self.template / "assets/player.js").write_bytes(b"console.log('tampered');")
        with self.assertRaises(GameBuildError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, "unsupported_capability")
        self.assertFalse(self.destination.exists())
        self.assert_no_leftovers()

    def test_missing_levels_or_startup_level_are_invalid_project(self):
        with self.assertRaises(GameBuildError) as caught:
            self.build(domains=project_domains(levels=[], objects=[]))
        self.assertEqual(caught.exception.code, "invalid_project")
        settings = [{"id": "game-settings", "settings": {"startupLevelId": "missing"}}]
        with self.assertRaises(GameBuildError) as caught:
            self.build(domains=project_domains(metadata=settings))
        self.assertEqual(caught.exception.code, "invalid_project")
        self.assertFalse(self.destination.exists())

    def test_locked_swap_rolls_back_to_previous_build(self):
        self.build("build-1")
        real_replace = os.replace
        calls = []

        def replace(source, target):
            calls.append((Path(source), Path(target)))
            if len(calls) == 2:
                raise PermissionError("locked")
            return real_replace(source, target)

        with mock.patch.object(game_build_module.os, "replace", side_effect=replace):
            with self.assertRaises(GameBuildError) as caught:
                self.build("build-2")
        self.assertEqual(caught.exception.code, "locking")
        self.assertEqual(self.load("game/game.json")["buildId"], "build-1")
        self.assert_no_leftovers()

    def test_a_build_without_prepared_models_is_the_sources_alone(self):
        report = self.build()
        self.assertNotIn("prepared", self.load("game/game.json"))
        self.assertEqual(report.prepared_models, 0)

    def test_prepared_models_go_beside_their_sources_as_ordinary_assets(self):
        prepared_id = "e" * 64
        report = self.build(
            prepared={"version": 1, "textures": "bc", "models": [{"source": MODEL_ID, "asset": prepared_id}]},
            read_prepared={prepared_id: b"glb-bytes"}.get,
        )
        manifest = self.load("game/game.json")
        self.assertEqual(manifest["schema"], 1)
        self.assertEqual(manifest["prepared"], {"version": 1, "textures": "bc", "models": [{"source": MODEL_ID, "asset": prepared_id}]})
        self.assertIn({"id": prepared_id, "file": f"{prepared_id}.glb", "mime": "model/gltf-binary", "size": 9}, manifest["assets"])
        self.assertIn(MODEL_ID, [asset["id"] for asset in manifest["assets"]])
        self.assertEqual((self.destination / "game/assets" / f"{prepared_id}.glb").read_bytes(), b"glb-bytes")
        self.assertIn(f"game/assets/{prepared_id}.glb", [item["path"] for item in self.load(BUILD_MARKER)["files"]])
        self.assertEqual((report.assets, report.prepared_models, report.warnings), (4, 1, ()))

    def test_a_prepared_model_shared_by_two_sources_is_written_once(self):
        prepared_id = "e" * 64
        self.build(
            prepared={"version": 1, "textures": "none", "models": [
                {"source": MODEL_ID, "asset": prepared_id}, {"source": TEXTURE_ID, "asset": prepared_id},
            ]},
            read_prepared={prepared_id: b"glb-bytes"}.get,
        )
        manifest = self.load("game/game.json")
        self.assertEqual([asset["id"] for asset in manifest["assets"]].count(prepared_id), 1)
        self.assertEqual(len(manifest["prepared"]["models"]), 2)
        self.assertEqual(manifest["prepared"]["textures"], "none")

    def test_preparation_never_fails_a_build(self):
        usable, unusable, unread = "e" * 64, "f" * 64, "9" * 64

        def read_prepared(asset):
            if asset == unusable:
                return None
            if asset == unread:
                raise OSError("gone")
            return b"glb-bytes"

        report = self.build(
            prepared={"version": 1, "textures": "bc", "models": [
                {"source": MODEL_ID, "asset": usable},
                {"source": TEXTURE_ID, "asset": unusable},
                {"source": HEIGHTFIELD_ID, "asset": unread},
                # A source the project no longer uses, and a name that cannot be a file.
                {"source": UNUSED_ID, "asset": "8" * 64},
                {"source": MODEL_ID, "asset": "../escape"},
            ]},
            read_prepared=read_prepared,
        )
        manifest = self.load("game/game.json")
        self.assertEqual(manifest["prepared"]["models"], [{"source": MODEL_ID, "asset": usable}])
        self.assertEqual(report.prepared_models, 1)
        self.assertEqual(len(report.warnings), 2)
        self.assertNotIn("8" * 64, [asset["id"] for asset in manifest["assets"]])
        self.assertFalse((self.output / "escape.glb").exists())
        # Nothing usable leaves the field out altogether.
        self.build("build-2", prepared={"version": 1, "textures": "bc", "models": [{"source": MODEL_ID, "asset": unusable}]}, read_prepared=read_prepared)
        self.assertNotIn("prepared", self.load("game/game.json"))


if __name__ == "__main__":
    unittest.main()


class CookedPicturesBuildTests(unittest.TestCase):
    def test_a_game_that_always_cooks_ships_its_texture_graphs_without_their_baked_pictures(self) -> None:
        from Auvra.project.game_build import without_baked_pictures

        graph = {"nodes": [], "links": []}
        content = {
            "materials": [
                {"id": "crate", "name": "Crate", "pictures": {"baseColor": "baked-colour", "orm": "baked-orm"}, "textureIds": ["baked-colour", "baked-orm"],
                 "textureGraph": {"graph": graph, "baked": {"textures": {"baseColor": "baked-colour", "orm": "baked-orm"}}}},
                {"id": "mask", "name": "Mask", "textureGraph": {"graph": graph, "library": True, "baked": {"textures": {"baseColor": "library-picture"}}}},
            ],
            "models": [{"id": "barrel", "materialOverrides": {"Body": {"mapTextureId": "baked-orm"}}}],
            "textures": [{"id": "baked-colour"}, {"id": "baked-orm"}, {"id": "library-picture"}, {"id": "other"}],
        }
        kept = without_baked_pictures(content)
        # The colour only the graph makes goes; the packed picture a model also wears, a library graph's and others stay.
        self.assertEqual([item["id"] for item in kept["textures"]], ["baked-orm", "library-picture", "other"])
        self.assertIs(without_baked_pictures({"materials": [], "textures": [{"id": "x"}]})["textures"][0]["id"], "x")


    def test_a_paint_stack_reference_keeps_applied_input_pictures_in_always_cook_builds(self) -> None:
        from Auvra.project.game_build import without_baked_pictures

        source = {
            "id": "paint-source", "pictures": {"baseColor": "paint-colour"},
            # A legacy document might not have a textureIds list, so mention counts alone cannot guard the applied map.
            "paint": {"modelId": "model", "layers": [{"id": "layer", "kind": "fill"}],
                      "applied": {"textures": {"baseColor": "paint-colour"}, "at": 1}},
            "textureGraph": {"graph": {"nodes": []}, "baked": {"textures": {"baseColor": "paint-colour"}}},
        }
        unrelated = {
            "id": "unused", "pictures": {"baseColor": "unused-colour"}, "textureIds": ["unused-colour"],
            "textureGraph": {"graph": {"nodes": []}, "baked": {"textures": {"baseColor": "unused-colour"}}},
        }

        def build(consumer_node: dict) -> list[str]:
            content = {
                "materials": [
                    source, unrelated,
                    {"id": "consumer", "textureGraph": {"graph": {"nodes": [consumer_node]}}},
                ],
                "textures": [{"id": "paint-colour"}, {"id": "unused-colour"}],
            }
            return [item["id"] for item in without_baked_pictures(content)["textures"]]

        # The consuming graph stores only the source material ID, not the source's texture ID.
        self.assertEqual(build({"type": "subgraph", "params": {"graph": "paint:paint-source"}}), ["paint-colour"])
        self.assertEqual(build({"type": "iterate", "params": {"graph": "paint:paint-source"}}), ["paint-colour"])
        self.assertEqual(build({"type": "paintStack", "params": {"asset": "paint-source", "folder": ""}}), ["paint-colour"])
        # A folder has no bundled per-folder output yet; never substitute the whole applied picture.
        self.assertEqual(build({"type": "subgraph", "params": {"graph": "paint:paint-source:folder"}}), [])


