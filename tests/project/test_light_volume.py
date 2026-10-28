from __future__ import annotations

import io
import math
import struct
import tempfile
import unittest
from pathlib import Path

from Auvra.project.assets import LIGHT_VOLUME_MIME, AssetStore, sniff_mime
from Auvra.project.game_build import _MIME_EXTENSIONS
from Auvra.project.schemas import validate_domain

ASSET = "a" * 64


def encode_light_volume(nx, ny, nz, samples=None):
    """The bakedLighting.ts layout: "AUVRALV1", uint32 x, y and z counts, 12 float32 per probe."""
    values = samples if samples is not None else [0.25] * (nx * ny * nz * 12)
    return b"AUVRALV1" + struct.pack("<III", nx, ny, nz) + struct.pack(f"<{len(values)}f", *values)


def level(baked_lighting):
    return {"schemaVersion": 1, "documents": [{"id": "level", "name": "Level 1", "bakedLighting": baked_lighting}]}


def probes(**changes):
    return {
        "assetId": ASSET, "encoding": "sh1-float32le", "origin": [-4, 0.25, -4], "spacing": 2,
        "counts": [5, 3, 5], "bakedAt": "2026-10-28T12:00:00.000Z", "signature": "0123456789abcdef", **changes,
    }


class LightVolumeAssetStoreTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = AssetStore(Path(tmp.name) / "Content")

    def test_accepts_and_sniffs_a_light_volume(self):
        data = encode_light_volume(2, 1, 3)
        self.assertEqual(sniff_mime(data[:512]), LIGHT_VOLUME_MIME)
        reference = self.store.put_stream(io.BytesIO(data), size=len(data), mime=LIGHT_VOLUME_MIME, name="light-volume.bin")
        self.assertEqual(reference.mime, LIGHT_VOLUME_MIME)
        with self.store.open(reference.asset_id) as stream:
            self.assertEqual(stream.read(), data)
        # Undeclared uploads are recognised by their magic and validated too.
        self.assertEqual(self.store.put_stream(io.BytesIO(encode_light_volume(1, 1, 1))).mime, LIGHT_VOLUME_MIME)

    def test_rejects_invalid_content_declared_as_a_light_volume(self):
        valid = encode_light_volume(2, 2, 2)
        invalid = [
            b"not a light volume",
            valid[:16],
            valid[:-4],
            valid + b"\x00\x00\x00\x00",
            b"AUVRASP1" + valid[8:],
            encode_light_volume(0, 2, 2, []),
            encode_light_volume(257, 1, 1, [0.0] * (257 * 12)),
            encode_light_volume(256, 256, 2, []),
            encode_light_volume(1, 1, 1, [math.nan] + [0.0] * 11),
            encode_light_volume(1, 1, 1, [math.inf] + [0.0] * 11),
        ]
        for data in invalid:
            with self.subTest(data=data[:24]), self.assertRaises(ValueError):
                self.store.put_stream(io.BytesIO(data), mime=LIGHT_VOLUME_MIME)
        self.assertEqual([path.name for path in self.store.content.iterdir() if path.is_file()], [])

    def test_game_builds_give_light_volumes_their_own_extension(self):
        self.assertEqual(_MIME_EXTENSIONS[LIGHT_VOLUME_MIME], "alv")


class LevelBakedLightingSchemaTests(unittest.TestCase):
    def test_accepts_settings_and_a_baked_volume(self):
        baked = {"spacing": 2, "bounces": 2, "intensity": 1, "probes": probes()}
        document = validate_domain("levels", level(baked))
        self.assertEqual(document["documents"][0]["bakedLighting"], baked)
        # Settings alone (not baked yet) are valid too.
        validate_domain("levels", level({"spacing": 4}))

    def test_rejects_unknown_fields_and_bad_asset_ids(self):
        cases = {
            "settings": {"spacing": 2, "resolution": 16},
            "probes": {"probes": probes(path="x")},
            "uppercase digest": {"probes": probes(assetId="A" * 64)},
        }
        for label, baked in cases.items():
            with self.subTest(label), self.assertRaises(ValueError):
                validate_domain("levels", level(baked))


if __name__ == "__main__":
    unittest.main()
