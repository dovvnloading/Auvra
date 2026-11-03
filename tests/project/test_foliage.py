from __future__ import annotations

import io
import struct
import tempfile
import unittest
from pathlib import Path

from Auvra.project import ProjectRepository
from Auvra.project.assets import FOLIAGE_MIME, AssetStore, sniff_mime
from Auvra.project.game_build import _MIME_EXTENSIONS
from Auvra.project.schemas import domain_document, validate_domain, validate_project_references

ASSET = "a" * 64
FLOATS = 10


def encode_foliage(count, value=1.0, floats=FLOATS, magic=b"AUVRAFO1"):
    return struct.pack("<8sII", magic, count, floats) + struct.pack(f"<{count * floats}f", *([value] * (count * floats)))


def foliage_reference(asset_id=ASSET, count=2):
    return {"assetId": asset_id, "encoding": "float32le-10", "count": count}


def foliage_set(types):
    return {
        "id": "foliage", "levelId": "level", "modelId": "", "name": "Foliage", "type": "foliage_set",
        "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "foliageData": {"types": types},
    }


def foliage_type(**changes):
    return {
        "id": "tree", "modelId": "model", "active": True, "density": 2, "radius": 1, "scaleMode": "uniform",
        "scaleX": [1, 1], "scaleY": [1, 1], "scaleZ": [1, 1], "zOffset": [0, 0], "alignToNormal": False, "alignMaxAngle": 25,
        "randomYaw": True, "randomPitch": 0, "slope": [0, 45], "height": [-10, 10], "includeLayers": [], "excludeLayers": [],
        "minLayerWeight": 0.5, "castShadow": True, "impostorDistance": 0, "cullDistance": 0, "collision": "none", **changes,
    }


class FoliageSchemaTests(unittest.TestCase):
    def test_accepts_a_set_and_its_reference(self):
        document = domain_document("objects", [foliage_set([foliage_type(instancemap=foliage_reference())])])
        validated = validate_domain("objects", document)
        self.assertEqual(validated["documents"][0]["foliageData"]["types"][0]["instancemap"]["count"], 2)

    def test_rejects_what_a_document_should_not_hold(self):
        cases = {
            "instances written out": foliage_type(instances=[1, 2, 3]),
            "unknown setting": foliage_type(shininess=2),
            "unknown reference field": foliage_type(instancemap={**foliage_reference(), "path": "x"}),
            "unknown encoding": foliage_type(instancemap={**foliage_reference(), "encoding": "float64"}),
            "uppercase digest": foliage_type(instancemap=foliage_reference("A" * 64)),
            "no instances counted": foliage_type(instancemap=foliage_reference(count=0)),
            "missing model": {key: value for key, value in foliage_type().items() if key != "modelId"},
        }
        for label, entry in cases.items():
            with self.subTest(label), self.assertRaises(ValueError):
                validate_domain("objects", domain_document("objects", [foliage_set([entry])]))

    def test_a_type_must_name_a_real_model(self):
        domains = {
            "levels": domain_document("levels", [{"id": "level", "name": "Level"}]),
            "objects": domain_document("objects", [foliage_set([foliage_type()])]),
        }
        with self.assertRaises(ValueError):
            validate_project_references(domains)


class FoliageAssetTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = AssetStore(Path(tmp.name) / "Content")

    def test_is_recognized_and_stored(self):
        data = encode_foliage(3)
        self.assertEqual(sniff_mime(data), FOLIAGE_MIME)
        stored = self.store.put_stream(io.BytesIO(data), mime=FOLIAGE_MIME, name="foliage.bin")
        self.assertTrue(stored.asset_id)

    def test_refuses_damaged_files(self):
        cases = {
            "cut short": encode_foliage(3)[:-4],
            "wrong layout": encode_foliage(2, floats=9),
            "not finite": encode_foliage(1, float("nan")),
        }
        for label, data in cases.items():
            with self.subTest(label), self.assertRaises(ValueError):
                self.store.put_stream(io.BytesIO(data), mime=FOLIAGE_MIME, name="foliage.bin")

    def test_a_built_game_gives_it_an_extension(self):
        self.assertEqual(_MIME_EXTENSIONS[FOLIAGE_MIME], "afo")


class FoliageRepositoryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = ProjectRepository.create(Path(tmp.name) / "Foliage", "Foliage")
        self.addCleanup(self.repo.close)
        model = self.repo.assets.put_stream(io.BytesIO(b"model"), mime="application/octet-stream").asset_id
        self.repo.apply_changes({
            "levels": [{"id": "level", "name": "Level"}],
            "models": [{"id": "model", "name": "Tree", "category": "Prop", "assetId": model}],
        }, expected_revision=0)

    def upload(self, count):
        return self.repo.assets.put_stream(io.BytesIO(encode_foliage(count)), mime=FOLIAGE_MIME, name="foliage.bin").asset_id

    def commit(self, asset_id, count):
        self.repo.apply_changes({"objects": [foliage_set([foliage_type(instancemap=foliage_reference(asset_id, count))])]}, expected_revision=self.repo.revision)

    def test_keeps_the_live_asset_and_drops_the_one_replaced(self):
        first = self.upload(2)
        self.commit(first, 2)
        self.assertIn(first, self.repo.referenced_asset_ids())
        second = self.upload(3)
        self.commit(second, 3)
        self.assertIn(second, self.repo.referenced_asset_ids())
        self.assertFalse(self.repo.assets.path_for(first).exists())
        self.assertTrue(self.repo.assets.path_for(second).exists())


if __name__ == "__main__":
    unittest.main()
