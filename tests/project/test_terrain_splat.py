from __future__ import annotations

import io
import struct
import tempfile
import unittest
from pathlib import Path

from Auvra.project import ProjectRepository
from Auvra.project.assets import SPLATMAP_MIME, AssetStore, sniff_mime
from Auvra.project.errors import InvalidProjectError
from Auvra.project.game_build import _MIME_EXTENSIONS
from Auvra.project.schemas import domain_document, validate_domain, validate_project_references

ASSET = "a" * 64


def encode_splatmap(columns, rows, weights=None):
    """The terrainSplatCodec.ts layout: "AUVRASP1", uint32 columns, uint32 rows, RGBA8."""
    body = bytes(weights) if weights is not None else bytes([255, 0, 0, 0]) * (columns * rows)
    return b"AUVRASP1" + struct.pack("<II", columns, rows) + body


def splatmap_reference(asset_id, samples=3):
    return {"assetId": asset_id, "encoding": "rgba8", "columns": samples, "rows": samples}


def terrain_object(terrain_data, object_id="terrain"):
    return {
        "id": object_id, "levelId": "level", "name": "Terrain", "type": "terrain",
        "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1],
        "terrainData": terrain_data,
    }


def painted_terrain(splatmap=None, layers=None):
    terrain = {
        "resolution": 2, "width": 10, "depth": 10,
        "textureLayers": layers if layers is not None else [{"textureId": "grass", "tiling": 16}, {"tiling": 8}],
    }
    if splatmap is not None:
        terrain["splatmap"] = splatmap
    return terrain


def objects_document(*objects):
    return {"schemaVersion": 1, "documents": list(objects)}


def textures(*identities):
    return domain_document("textures", [
        {"id": identity, "name": f"{identity}.png", "assetId": ASSET} for identity in identities
    ])


class SplatmapAssetStoreTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = AssetStore(Path(tmp.name) / "Content")

    def test_accepts_and_sniffs_the_splatmap_kind(self):
        data = encode_splatmap(3, 3)
        self.assertEqual(sniff_mime(data[:512]), SPLATMAP_MIME)
        reference = self.store.put_stream(io.BytesIO(data), size=len(data), mime=SPLATMAP_MIME, name="terrain-splatmap.bin")
        self.assertEqual(reference.mime, SPLATMAP_MIME)
        self.assertEqual(self.store.reference(reference.asset_id).mime, SPLATMAP_MIME)
        with self.store.open(reference.asset_id) as stream:
            self.assertEqual(stream.read(), data)
        # Undeclared uploads are recognised by their magic and validated too.
        self.assertEqual(self.store.put_stream(io.BytesIO(encode_splatmap(2, 2))).mime, SPLATMAP_MIME)

    def test_rejects_invalid_content_declared_as_splatmap(self):
        valid = encode_splatmap(3, 3)
        invalid = [
            b"not a splat map",
            valid[:12],
            valid[:-1],
            valid + b"\x00",
            b"AUVRAHF1" + valid[8:],
            encode_splatmap(1, 4, [0] * 16),
            encode_splatmap(4098, 2, []),
        ]
        for data in invalid:
            with self.subTest(data=data[:20]), self.assertRaises(ValueError):
                self.store.put_stream(io.BytesIO(data), mime=SPLATMAP_MIME)
        # A wrongly sized splat map is rejected even when its type is sniffed.
        with self.assertRaises(ValueError):
            self.store.put_stream(io.BytesIO(valid[:-4]))
        self.assertEqual([path.name for path in self.store.content.iterdir() if path.is_file()], [])

    def test_game_builds_ship_splatmaps_with_their_own_extension(self):
        self.assertEqual(_MIME_EXTENSIONS[SPLATMAP_MIME], "splat")
        # Web builds go on any static host, so no shipped extension may be one a server executes
        # (IIS sends *.asp to Classic ASP, and splat weights are arbitrary bytes).
        executable = {"asp", "aspx", "asa", "ashx", "asmx", "cer", "cgi", "jsp", "php", "phtml", "pl", "py", "shtml"}
        self.assertEqual(set(_MIME_EXTENSIONS.values()) & executable, set())


class SplatmapSchemaTests(unittest.TestCase):
    def test_accepts_texture_layers_and_a_splatmap_reference(self):
        terrain = painted_terrain(splatmap_reference(ASSET))
        document = validate_domain("objects", objects_document(terrain_object(terrain)))
        self.assertEqual(document["documents"][0]["terrainData"], terrain)
        # Layers alone (an unpainted terrain) and four layers are both valid.
        validate_domain("objects", objects_document(terrain_object(painted_terrain())))
        validate_domain("objects", objects_document(terrain_object(painted_terrain(layers=[{"tiling": 1}] * 4))))

    def test_rejects_unknown_fields(self):
        cases = {
            "splatmap": painted_terrain({**splatmap_reference(ASSET), "path": "x"}),
            "layer": painted_terrain(layers=[{"tiling": 4, "normalTextureId": "n"}]),
            "inline weights": {**painted_terrain(splatmap_reference(ASSET)), "splat": [255, 0, 0, 0] * 9},
        }
        for label, terrain in cases.items():
            with self.subTest(label), self.assertRaisesRegex(ValueError, "unknown fields"):
                validate_domain("objects", objects_document(terrain_object(terrain)))

    def test_rejects_malformed_layers_and_references(self):
        cases = {
            "five layers": painted_terrain(layers=[{"tiling": 1}] * 5),
            "missing tiling": painted_terrain(layers=[{"textureId": "grass"}]),
            "zero tiling": painted_terrain(layers=[{"tiling": 0}]),
            "huge tiling": painted_terrain(layers=[{"tiling": 10001}]),
            "empty texture id": painted_terrain(layers=[{"textureId": "", "tiling": 1}]),
            "layers not a list": painted_terrain(layers={"tiling": 1}),
            "resolution mismatch": painted_terrain(splatmap_reference(ASSET, samples=5)),
            "missing resolution": {key: value for key, value in painted_terrain(splatmap_reference(ASSET)).items() if key != "resolution"},
            "unknown encoding": painted_terrain({**splatmap_reference(ASSET), "encoding": "float32le"}),
            "uppercase digest": painted_terrain(splatmap_reference("A" * 64)),
            "missing dimension": painted_terrain({"assetId": ASSET, "encoding": "rgba8", "columns": 3}),
        }
        for label, terrain in cases.items():
            with self.subTest(label), self.assertRaises(ValueError):
                validate_domain("objects", objects_document(terrain_object(terrain)))

    def test_prefab_members_check_the_splatmap_grid(self):
        terrain = painted_terrain(splatmap_reference(ASSET, samples=5))
        member = {key: value for key, value in terrain_object(terrain).items() if key != "levelId"}
        prefab = {"id": "prefab", "name": "Terrain", "rootId": "terrain", "objects": [member]}
        with self.assertRaisesRegex(ValueError, "splat map does not match its resolution"):
            validate_domain("prefabs", objects_document(prefab))


class SplatmapReferenceTests(unittest.TestCase):
    def domains(self, layers, *texture_ids):
        return {
            "levels": domain_document("levels", [{"id": "level", "name": "Level"}]),
            "objects": domain_document("objects", [terrain_object(painted_terrain(splatmap_reference(ASSET), layers))]),
            "textures": textures(*texture_ids),
        }

    def test_layer_textures_must_exist(self):
        layers = [{"textureId": "grass", "tiling": 16}, {"tiling": 8}, {"textureId": "rock", "tiling": 4}]
        validate_project_references(self.domains(layers, "grass", "rock"))
        with self.assertRaisesRegex(ValueError, "invalid terrain layer texture reference"):
            validate_project_references(self.domains(layers, "grass"))

    def test_layers_without_textures_need_no_texture_documents(self):
        validate_project_references(self.domains([{"tiling": 16}, {"tiling": 8}]))


class SplatmapRepositoryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = ProjectRepository.create(Path(tmp.name) / "Terrain", "Terrain")
        self.addCleanup(self.repo.close)
        texture_asset = self.repo.assets.put_stream(io.BytesIO(b"texture"), mime="application/octet-stream").asset_id
        self.repo.apply_changes({
            "levels": [{"id": "level", "name": "Level"}],
            "textures": [{"id": "grass", "name": "grass.png", "assetId": texture_asset}],
        }, expected_revision=0)

    def upload(self, fill):
        data = encode_splatmap(3, 3, [fill, 255 - fill, 0, 0] * 9)
        return self.repo.assets.put_stream(io.BytesIO(data), mime=SPLATMAP_MIME, name="terrain-splatmap.bin").asset_id

    def commit(self, terrain):
        self.repo.apply_changes({"objects": [terrain_object(terrain)]}, expected_revision=self.repo.revision)

    def test_splatmap_is_a_live_asset_reference(self):
        asset_id = self.upload(255)
        self.commit(painted_terrain(splatmap_reference(asset_id)))
        stored = self.repo.get_domain("objects")["documents"][0]["terrainData"]
        self.assertEqual(stored["splatmap"]["assetId"], asset_id)
        self.assertEqual(stored["textureLayers"], [{"textureId": "grass", "tiling": 16}, {"tiling": 8}])
        self.assertIn(asset_id, self.repo.referenced_asset_ids())
        self.assertFalse(self.repo.discard_asset_if_unreferenced(asset_id))

    def test_missing_splatmap_asset_and_dangling_layer_texture_are_rejected(self):
        with self.assertRaises(InvalidProjectError):
            self.commit(painted_terrain(splatmap_reference("b" * 64)))
        with self.assertRaises(InvalidProjectError):
            self.commit(painted_terrain(layers=[{"textureId": "missing", "tiling": 16}]))

    def test_replaced_splatmap_is_discarded_once_the_replacement_commits(self):
        first, second = self.upload(255), self.upload(128)
        self.commit(painted_terrain(splatmap_reference(first)))
        self.commit(painted_terrain(splatmap_reference(second)))
        # Like a heightfield, a replaced splat map leaves Content, and so every recovery point.
        self.assertFalse(self.repo.assets.verify(first))
        self.assertTrue(self.repo.assets.verify(second))
        self.repo.autosave()
        [point] = [path for path in (self.repo.path / ".auvra" / "autosaves").iterdir() if path.is_dir()]
        self.assertFalse((point / "Content" / "sha256" / first).exists())
        self.assertTrue((point / "Content" / "sha256" / second).exists())
        # Undo uploads the weights again, under the same content address.
        self.assertEqual(self.upload(255), first)
        self.commit(painted_terrain(splatmap_reference(first)))
        self.assertEqual(self.repo.get_domain("objects")["documents"][0]["terrainData"]["splatmap"]["assetId"], first)
        self.assertFalse(self.repo.assets.verify(second))

    def test_shared_and_deleted_splatmaps_are_kept(self):
        shared, replacement = self.upload(255), self.upload(128)

        def commit(*assets):
            objects = [terrain_object(painted_terrain(splatmap_reference(asset_id)), object_id)
                       for object_id, asset_id in assets]
            self.repo.apply_changes({"objects": objects}, expected_revision=self.repo.revision)

        commit(("terrain", shared), ("copy", shared))
        # Another terrain still references the replaced splat map.
        commit(("terrain", replacement), ("copy", shared))
        self.assertTrue(self.repo.assets.verify(shared))
        # A deleted terrain keeps its splat map until close (undo can restore it).
        commit(("terrain", replacement))
        self.assertTrue(self.repo.assets.verify(shared))


if __name__ == "__main__":
    unittest.main()
