from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from Auvra.project.assets import AssetStore, FBX_MIME, GENERIC_MIME, OBJ_MIME


class SameFileTests(unittest.TestCase):
    def put(self, store: AssetStore, data: bytes, mime: str | None, name: str):
        return store.put_stream(io.BytesIO(data), size=len(data), mime=mime, name=name)

    def recorded(self, root: str, asset_id: str) -> dict:
        return json.loads((Path(root) / "manifest.json").read_text(encoding="utf-8"))[asset_id]

    def test_a_file_stored_without_saying_what_it_is_can_come_again_saying_so(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = AssetStore(root)
            first = self.put(store, b"Kaydara FBX Binary", GENERIC_MIME, "gun.fbx")
            second = self.put(store, b"Kaydara FBX Binary", FBX_MIME, "gun.fbx")
            self.assertEqual(first.asset_id, second.asset_id)
            self.assertEqual(self.recorded(root, first.asset_id)["mime"], FBX_MIME)

    def test_saying_less_about_a_file_does_not_forget_what_is_known(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = AssetStore(root)
            first = self.put(store, b"Kaydara FBX Binary", FBX_MIME, "gun.fbx")
            self.put(store, b"Kaydara FBX Binary", GENERIC_MIME, "gun.fbx")
            self.assertEqual(self.recorded(root, first.asset_id)["mime"], FBX_MIME)

    def test_a_file_can_come_again_under_another_name_and_keeps_its_first(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = AssetStore(root)
            first = self.put(store, b"Kaydara FBX Binary", FBX_MIME, "gun.fbx")
            self.put(store, b"Kaydara FBX Binary", FBX_MIME, "copy of gun.fbx")
            self.assertEqual(self.recorded(root, first.asset_id)["name"], "gun.fbx")

    def test_one_file_cannot_be_two_kinds_of_thing(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = AssetStore(root)
            self.put(store, b"v 0 0 0", OBJ_MIME, "shape.obj")
            with self.assertRaises(ValueError):
                self.put(store, b"v 0 0 0", FBX_MIME, "shape.fbx")


if __name__ == "__main__":
    unittest.main()
