from __future__ import annotations

import io
import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from Auvra.project import ProjectRepository
from Auvra.project.assets import (
    HEIGHTFIELD_MIME,
    AssetStore,
    decode_heightfield,
    encode_heightfield,
)
from Auvra.project.errors import InvalidProjectError
from Auvra.project.schemas import domain_document, validate_domain

# Shared with tests/frontend/terrainHeightfield.test.ts: the editor and the
# host must agree on this exact byte layout.
GOLDEN_HEIGHTFIELD = bytes.fromhex(
    "41555652414846310200000002000000"
    "000000000000c03f000000c000005040"
)


def terrain_object(terrain_data):
    return {
        "id": "terrain", "levelId": "level", "name": "Terrain", "type": "terrain",
        "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1],
        "terrainData": terrain_data,
    }


def heightfield_reference(asset_id, samples=513):
    return {"assetId": asset_id, "encoding": "float32le", "columns": samples, "rows": samples}


class HeightfieldEncodingTests(unittest.TestCase):
    def test_golden_layout_round_trips(self):
        self.assertEqual(encode_heightfield([0.0, 1.5, -2.0, 3.25], 2, 2), GOLDEN_HEIGHTFIELD)
        self.assertEqual(decode_heightfield(GOLDEN_HEIGHTFIELD), (2, 2, [0.0, 1.5, -2.0, 3.25]))

    def test_samples_are_float32(self):
        columns, rows, samples = decode_heightfield(encode_heightfield([0.1, 0.2, 0.3, 0.4], 2, 2))
        self.assertEqual((columns, rows), (2, 2))
        expected = [struct.unpack("<f", struct.pack("<f", value))[0] for value in (0.1, 0.2, 0.3, 0.4)]
        self.assertEqual(samples, expected)

    def test_rejects_malformed_heightfields(self):
        with self.assertRaises(ValueError):
            encode_heightfield([0.0, 1.0, 2.0], 2, 2)
        with self.assertRaises(ValueError):
            encode_heightfield([0.0, math.nan, 2.0, 3.0], 2, 2)
        with self.assertRaises(ValueError):
            encode_heightfield([0.0], 1, 1)
        with self.assertRaises(ValueError):
            decode_heightfield(GOLDEN_HEIGHTFIELD[:-1])
        with self.assertRaises(ValueError):
            decode_heightfield(b"AUVRAHF2" + GOLDEN_HEIGHTFIELD[8:])


class HeightfieldAssetStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AssetStore(Path(self.tmp.name) / "Content")

    def tearDown(self):
        self.tmp.cleanup()

    def test_accepts_and_round_trips_the_heightfield_kind(self):
        samples = [float(index % 17) * 0.25 - 2.0 for index in range(513 * 513)]
        data = encode_heightfield(samples, 513, 513)
        reference = self.store.put_stream(io.BytesIO(data), size=len(data), mime=HEIGHTFIELD_MIME, name="terrain-heightfield.bin")
        self.assertEqual(reference.mime, HEIGHTFIELD_MIME)
        self.assertEqual(self.store.reference(reference.asset_id).mime, HEIGHTFIELD_MIME)
        with self.store.open(reference.asset_id) as stream:
            self.assertEqual(decode_heightfield(stream.read()), (513, 513, samples))
        # Content addressing: re-uploading the same terrain is idempotent.
        again = self.store.put_stream(io.BytesIO(data), mime=HEIGHTFIELD_MIME, name="terrain-heightfield.bin")
        self.assertEqual(again.asset_id, reference.asset_id)

    def test_rejects_invalid_content_declared_as_heightfield(self):
        nan = struct.pack("<f", math.nan)
        invalid = [
            b"not a heightfield",
            GOLDEN_HEIGHTFIELD[:-4],
            GOLDEN_HEIGHTFIELD + b"\x00\x00\x00\x00",
            GOLDEN_HEIGHTFIELD[:16] + nan + GOLDEN_HEIGHTFIELD[20:],
            b"AUVRAHF1" + struct.pack("<II", 1, 4) + GOLDEN_HEIGHTFIELD[16:],
        ]
        for data in invalid:
            with self.subTest(data=data[:20]), self.assertRaises(ValueError):
                self.store.put_stream(io.BytesIO(data), mime=HEIGHTFIELD_MIME)
        self.assertEqual([path.name for path in self.store.content.iterdir() if path.is_file()], [])


class HeightfieldSchemaTests(unittest.TestCase):
    def test_reference_form_validates_and_stays_small(self):
        document = domain_document("objects", [terrain_object({
            "resolution": 512, "width": 100, "depth": 100, "textureId": "texture",
            "heightfield": heightfield_reference("a" * 64),
        })])
        encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
        self.assertLess(len(encoded), 2 * 1024)

    def test_legacy_inline_heights_still_validate(self):
        validate_domain("objects", {"schemaVersion": 1, "documents": [terrain_object({
            "resolution": 2, "width": 10, "depth": 10, "heights": [0.0] * 9,
        })]})
        validate_domain("objects", {"schemaVersion": 1, "documents": [terrain_object({
            "resolution": 64, "width": 10, "depth": 10, "heights": [],
        })]})
        validate_domain("objects", {"schemaVersion": 1, "documents": [terrain_object(None)]})

    def test_rejects_malformed_references(self):
        cases = {
            "inline and referenced heights": {"resolution": 512, "width": 1, "depth": 1, "heights": [0.0], "heightfield": heightfield_reference("a" * 64)},
            "resolution mismatch": {"resolution": 256, "width": 1, "depth": 1, "heightfield": heightfield_reference("a" * 64)},
            "missing resolution": {"width": 1, "depth": 1, "heightfield": heightfield_reference("a" * 64)},
            "uppercase digest": {"resolution": 512, "width": 1, "depth": 1, "heightfield": heightfield_reference("A" * 64)},
            "unknown encoding": {"resolution": 512, "width": 1, "depth": 1, "heightfield": {**heightfield_reference("a" * 64), "encoding": "float64le"}},
            "unknown field": {"resolution": 512, "width": 1, "depth": 1, "heightfield": {**heightfield_reference("a" * 64), "path": "x"}},
            "missing dimension": {"resolution": 512, "width": 1, "depth": 1, "heightfield": {"assetId": "a" * 64, "encoding": "float32le", "columns": 513}},
        }
        for label, terrain in cases.items():
            with self.subTest(label), self.assertRaises(ValueError):
                validate_domain("objects", {"schemaVersion": 1, "documents": [terrain_object(terrain)]})


class HeightfieldRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = ProjectRepository.create(Path(self.tmp.name) / "Terrain", "Terrain")
        self.repo.apply_changes({"levels": [{"id": "level", "name": "Level"}]}, expected_revision=0)

    def tearDown(self):
        self.repo.close()
        self.tmp.cleanup()

    def test_terrain_reference_is_a_live_asset_reference(self):
        data = encode_heightfield([0.0] * (3 * 3), 3, 3)
        reference = self.repo.assets.put_stream(io.BytesIO(data), mime=HEIGHTFIELD_MIME, name="terrain-heightfield.bin")
        terrain = {"resolution": 2, "width": 10, "depth": 10, "heightfield": heightfield_reference(reference.asset_id, 3)}
        self.repo.apply_changes({"objects": [terrain_object(terrain)]}, expected_revision=1)
        # Pending-upload cleanup and pruning must treat the heightfield as live.
        self.assertIn(reference.asset_id, self.repo.referenced_asset_ids())
        self.assertFalse(self.repo.discard_asset_if_unreferenced(reference.asset_id))
        self.assertTrue(self.repo.assets.verify(reference.asset_id))

    def test_missing_heightfield_asset_is_rejected(self):
        terrain = {"resolution": 2, "width": 10, "depth": 10, "heightfield": heightfield_reference("b" * 64, 3)}
        with self.assertRaises(InvalidProjectError):
            self.repo.apply_changes({"objects": [terrain_object(terrain)]}, expected_revision=1)


if __name__ == "__main__":
    unittest.main()
