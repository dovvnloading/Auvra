"""Keep the example's editable garment and baked fitting clip portable through the actual host."""
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest

from Auvra.project.game_build import build_game
from Auvra.project.repository import ProjectRepository
from Auvra.project.schemas import DOMAIN_NAMES


EXAMPLE = Path(__file__).resolve().parents[2] / "docs" / "examples" / "Auvra-Garment-Studio.auvrapack"


def garment_props(objects):
    return [component["props"] for obj in objects["documents"] for component in obj.get("components", [])
            if component["type"] == "garment" and component["enabled"]]


class GarmentExampleTests(unittest.TestCase):
    def test_clip_survives_copy_pruning_repack_and_web_export(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "roundtrip.auvrapack"
            with ProjectRepository.import_pack(EXAMPLE, root / "source") as source:
                [props] = garment_props(source.get_domain("objects"))
                self.assertEqual(props.get("playback", "live"), "live")
                self.assertEqual(len(props["pattern"]["panels"]), 2)
                self.assertEqual(len(props["pattern"]["seams"]), 4)
                bake = props["fittingBake"]
                self.assertRegex(bake["recipe"], r"^[0-9a-f]{64}$")
                self.assertEqual(bake["duration"], 2)
                asset_id = bake["assetId"]
                with source.assets.open(asset_id) as asset:
                    original = asset.read()
                self.assertEqual(hashlib.sha256(original).hexdigest(), asset_id)
                # Endpoint-inclusive fixed-topology AUVC clip, with frame-major quantized positions.
                magic, version, header_size, vertices, frames, fps, flags, byte_count = struct.unpack_from(
                    "<4sHHIIHHI", original)
                self.assertEqual((magic, version, header_size, flags), (b"AUVC", 1, 48, 0))
                self.assertGreater(vertices, 0)
                self.assertGreater(fps, 0)
                self.assertEqual(frames - 1, bake["duration"] * fps)
                self.assertEqual(byte_count, header_size + frames * (12 + vertices * 6))
                self.assertEqual(len(original), byte_count)
                with source.save_as(root / "copy") as copy:
                    self.assertEqual(garment_props(copy.get_domain("objects")), [props])
                    orphan = copy.assets.put_stream(io.BytesIO(b"unused fitting clip"), mime="application/octet-stream")
                    self.assertIn(asset_id, copy.referenced_asset_ids())
                    self.assertIn(orphan.asset_id, copy.prune_unreferenced_assets())
                    self.assertTrue(copy.assets.verify(asset_id, expected_size=byte_count))
                    copy.export_pack(archive)

            with ProjectRepository.import_pack(archive, root / "reopened") as reopened:
                self.assertEqual(garment_props(reopened.get_domain("objects")), [props])
                template = root / "template"
                template.mkdir()
                page = b"<!doctype html><title>Player fixture</title>"
                (template / "index.html").write_bytes(page)
                file = {"path": "index.html", "size": len(page), "sha256": hashlib.sha256(page).hexdigest()}
                (template / "player-template.json").write_text(json.dumps({"files": [file]}), encoding="utf-8")

                def read_asset(identity):
                    reference = reopened.assets.reference(identity)
                    return reopened.assets.open(identity), reference.mime, reference.size

                destination = root / "web"
                build_game(domains={d: reopened.get_domain(d) for d in DOMAIN_NAMES}, read_asset=read_asset,
                           template_root=template, destination=destination, target="web",
                           build_id="garment-example", game_id=reopened.project_id)

            game = destination / "game"
            contents = json.loads((game / "content" / "objects.json").read_text(encoding="utf-8"))
            self.assertEqual(garment_props(contents), [props])
            manifest = json.loads((game / "game.json").read_text(encoding="utf-8"))
            [entry] = [asset for asset in manifest["assets"] if asset["id"] == asset_id]
            shipped = (game / "assets" / entry["file"]).read_bytes()
            self.assertEqual(entry["size"], byte_count)
            self.assertEqual(hashlib.sha256(shipped).hexdigest(), asset_id)
            self.assertEqual(shipped, original)
