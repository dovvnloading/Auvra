from __future__ import annotations

import io
import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from Auvra.project import ProjectRepository
from Auvra.project.assets import SKIN_PAINT_ENCODING, SKIN_PAINT_MIME, AssetStore, sniff_mime
from Auvra.project.game_build import _MIME_EXTENSIONS, _referenced_asset_ids
from Auvra.project.schemas import validate_domain

ASSET = "a" * 64
NO_BONE = 0xFFFF
GLB = b"glTF" + struct.pack("<II", 2, 12)


def encode_skin_paint(names=("Hips", "Spine"), places=(1.0, 2.0, 3.0), bones=(0, 1, NO_BONE, NO_BONE), shares=(0.75, 0.25, 0.0, 0.0)):
    """The skinPaintFile.ts layout: "AUVRASK1", uint32 places, uint32 length of the names, the names, then the three lists."""
    text = json.dumps(list(names)).encode("utf-8")
    text += b" " * (-len(text) % 4)
    count = len(places) // 3
    return (
        b"AUVRASK1" + struct.pack("<II", count, len(text)) + text
        + struct.pack(f"<{len(places)}f", *places)
        + struct.pack(f"<{len(bones)}H", *bones)
        + struct.pack(f"<{len(shares)}f", *shares)
    )


class SkinPaintAssetStoreTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = AssetStore(Path(tmp.name) / "Content")

    def test_accepts_and_sniffs_painted_weights(self):
        data = encode_skin_paint()
        self.assertEqual(sniff_mime(data[:512]), SKIN_PAINT_MIME)
        reference = self.store.put_stream(io.BytesIO(data), size=len(data), mime=SKIN_PAINT_MIME, name="skin-paint.bin")
        self.assertEqual(reference.mime, SKIN_PAINT_MIME)
        with self.store.open(reference.asset_id) as stream:
            self.assertEqual(stream.read(), data)
        # Undeclared uploads are recognised by their magic and validated too.
        self.assertEqual(self.store.put_stream(io.BytesIO(encode_skin_paint(names=("Head",), bones=(0, NO_BONE, NO_BONE, NO_BONE), shares=(1.0, 0.0, 0.0, 0.0)))).mime, SKIN_PAINT_MIME)

    def test_accepts_many_places(self):
        count = 1000
        data = encode_skin_paint(places=[0.5] * (count * 3), bones=[0, 1, NO_BONE, NO_BONE] * count, shares=[0.5, 0.5, 0.0, 0.0] * count)
        self.store.put_stream(io.BytesIO(data), mime=SKIN_PAINT_MIME)

    def test_rejects_invalid_content_declared_as_painted_weights(self):
        valid = encode_skin_paint()
        invalid = [
            b"not painted weights",
            valid[:12],
            valid[:-4],
            valid + b"\x00\x00\x00\x00",
            b"AUVRASP1" + valid[8:],
            encode_skin_paint(places=(math.nan, 0.0, 0.0)),
            encode_skin_paint(places=(math.inf, 0.0, 0.0)),
            encode_skin_paint(bones=(2, NO_BONE, NO_BONE, NO_BONE)),
            encode_skin_paint(shares=(1.5, 0.0, 0.0, 0.0)),
            encode_skin_paint(shares=(-0.5, 0.0, 0.0, 0.0)),
            encode_skin_paint(shares=(math.nan, 0.0, 0.0, 0.0)),
            b"AUVRASK1" + struct.pack("<II", 1, 3) + b"[] " + valid[16:],
            b"AUVRASK1" + struct.pack("<II", 0, 4) + b"nope",
            b"AUVRASK1" + struct.pack("<II", 0, 4) + b"[1] ",
        ]
        for data in invalid:
            with self.subTest(data=data[:32]), self.assertRaises(ValueError):
                self.store.put_stream(io.BytesIO(data), mime=SKIN_PAINT_MIME)
        self.assertEqual([path.name for path in self.store.content.iterdir() if path.is_file()], [])

    def test_game_builds_give_painted_weights_their_own_extension(self):
        self.assertEqual(_MIME_EXTENSIONS[SKIN_PAINT_MIME], "askp")


class SkinPaintSchemaTests(unittest.TestCase):
    model = {"id": "m", "name": "Model", "assetId": ASSET}

    def test_accepts_a_model_with_painted_weights(self):
        paint = {"assetId": "b" * 64, "encoding": SKIN_PAINT_ENCODING, "count": 12}
        accepted = validate_domain("models", {"schemaVersion": 1, "documents": [{**self.model, "skinPaint": paint}]})
        self.assertEqual(accepted["documents"][0]["skinPaint"], paint)

    def test_rejects_what_is_not_a_reference(self):
        good = {"assetId": "b" * 64, "encoding": SKIN_PAINT_ENCODING, "count": 12}
        for bad in ({**good, "assetId": "nope"}, {**good, "encoding": "other"}, {**good, "count": 0}, {**good, "extra": 1}, {"assetId": "b" * 64}):
            with self.subTest(paint=bad), self.assertRaises(ValueError):
                validate_domain("models", {"schemaVersion": 1, "documents": [{**self.model, "skinPaint": bad}]})

    def test_a_game_build_takes_the_asset_along(self):
        paint = {"assetId": "b" * 64, "encoding": SKIN_PAINT_ENCODING, "count": 12}
        self.assertIn("b" * 64, _referenced_asset_ids({"models": [{**self.model, "skinPaint": paint}]}))


class SkinPaintRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = ProjectRepository.create(Path(self.tmp.name) / "Painted", "Painted")
        self.addCleanup(self.repo.close)
        self.model_asset = self.repo.assets.put_stream(io.BytesIO(GLB), mime="model/gltf-binary", name="m.glb").asset_id

    def _paint(self, *shares):
        data = encode_skin_paint(shares=shares)
        return self.repo.assets.put_stream(io.BytesIO(data), mime=SKIN_PAINT_MIME, name="skin-paint.bin").asset_id

    def _commit(self, paint_asset):
        model = {"id": "m", "name": "Model", "assetId": self.model_asset}
        if paint_asset:
            model["skinPaint"] = {"assetId": paint_asset, "encoding": SKIN_PAINT_ENCODING, "count": 1}
        self.repo.apply_changes({"models": [model]}, expected_revision=self.repo.revision)

    def test_painted_weights_are_kept_and_reachable(self):
        asset = self._paint(1.0, 0.0, 0.0, 0.0)
        self._commit(asset)
        self.assertIn(asset, self.repo.referenced_asset_ids())
        self.assertTrue(self.repo.assets.verify(asset))
        self.assertEqual(self.repo.get_domain("models")["documents"][0]["skinPaint"]["assetId"], asset)

    def test_a_reference_to_a_missing_asset_is_refused(self):
        with self.assertRaises(Exception):
            self._commit("c" * 64)

    def test_replaced_paint_is_discarded_once_the_replacement_commits(self):
        first = self._paint(1.0, 0.0, 0.0, 0.0)
        self._commit(first)
        second = self._paint(0.5, 0.5, 0.0, 0.0)
        self._commit(second)
        self.assertFalse(self.repo.assets.path_for(first).exists())
        self.assertTrue(self.repo.assets.verify(second))

    def test_paint_taken_off_a_model_is_discarded(self):
        asset = self._paint(1.0, 0.0, 0.0, 0.0)
        self._commit(asset)
        self._commit(None)
        self.assertFalse(self.repo.assets.path_for(asset).exists())

    def test_paint_two_models_share_stays_until_neither_holds_it(self):
        asset = self._paint(1.0, 0.0, 0.0, 0.0)
        reference = {"assetId": asset, "encoding": SKIN_PAINT_ENCODING, "count": 1}
        both = [
            {"id": "m", "name": "Model", "assetId": self.model_asset, "skinPaint": reference},
            {"id": "n", "name": "Other", "assetId": self.model_asset, "skinPaint": reference},
        ]
        self.repo.apply_changes({"models": both}, expected_revision=self.repo.revision)
        one = [{"id": "m", "name": "Model", "assetId": self.model_asset}, both[1]]
        self.repo.apply_changes({"models": one}, expected_revision=self.repo.revision)
        self.assertTrue(self.repo.assets.verify(asset))


if __name__ == "__main__":
    unittest.main()
