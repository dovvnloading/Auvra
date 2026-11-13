import contextlib
import io
import json
import struct
import tempfile
import unittest
from pathlib import Path
import unittest.mock as mock

from Auvra.project import material_commands
from Auvra.project.material_commands import MaterialCommandError, apply_preset, headless_unavailable, list_materials, main, set_value
from Auvra.project.repository import ProjectRepository
from Auvra.project.templates import apply_template


class MaterialCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "living"
        repository = ProjectRepository.create(self.path, "Living")
        apply_template(repository, "living-materials", project_name="Living")
        # A preset to apply, as the texture graph editor keeps them.
        documents = repository.get_domain("materials")["documents"]
        documents[0]["textureGraph"]["graph"]["presets"] = [{"id": "soaked", "name": "Soaked", "values": {"Wetness": 1}}]
        repository.apply_changes({"materials": documents}, expected_revision=repository.revision)
        repository.save()
        repository.close()

    def run_command(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main([str(self.path), *args])
        return code, out.getvalue(), err.getvalue()

    def test_lists_texture_graphs_with_their_parameters_and_presets(self) -> None:
        with ProjectRepository(self.path) as repository:
            self.assertEqual(list_materials(repository), [
                {"id": "living-crate", "name": "Living crate", "kind": "texture graph", "parameters": {"Wetness": 0}, "presets": ["Soaked"]},
            ])
        code, out, _ = self.run_command("--json", "list")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)[0]["name"], "Living crate")

    def test_sets_a_value_and_applies_a_preset_saving_the_project(self) -> None:
        code, out, _ = self.run_command("set-value", "living crate", "Wetness", "0.4")
        self.assertEqual((code, json.loads(out)), (0, {"Wetness": 0.4}))
        with ProjectRepository(self.path) as repository:
            self.assertEqual(repository.get_domain("materials")["documents"][0]["textureGraph"]["values"], {"Wetness": 0.4})
            # Clamped to the parameter's limits.
            self.assertEqual(set_value(repository, "living-crate", "Wetness", 3), {"Wetness": 1})
            self.assertEqual(apply_preset(repository, "Living crate", "soaked"), {"Wetness": 1})
            with self.assertRaisesRegex(MaterialCommandError, "no parameter called 'Dryness'"):
                set_value(repository, "Living crate", "Dryness", 1)
            with self.assertRaisesRegex(MaterialCommandError, "takes a number"):
                set_value(repository, "Living crate", "Wetness", "wet")
            with self.assertRaisesRegex(MaterialCommandError, "no material called"):
                set_value(repository, "Bricks", "Wetness", 1)

    def test_drawing_asks_where_the_pictures_go_and_says_what_it_needs(self) -> None:
        for command in ("cook", "ball", "bake-mesh-maps"):
            code, _, err = self.run_command(command, "Living crate")
            self.assertEqual(code, 2)
            self.assertIn("Say where the pictures go", err)
        code, _, err = self.run_command("cook", "Living crate", "--size", "33", "--out", str(self.path.parent / "out"))
        self.assertEqual(code, 2)
        self.assertIn("power of two", err)
        with mock.patch.object(material_commands.shutil, "which", return_value=None):
            code, _, err = self.run_command("cook", "Living crate", "--out", str(self.path.parent / "out"))
        self.assertEqual(code, 3)
        self.assertIn("needs Node", err)
        code, _, err = self.run_command("set-value", "Living crate", "Dryness", "1")
        self.assertEqual(code, 2)
        self.assertIn("no parameter", err)


def _png_size(path: Path) -> tuple[int, int]:
    return struct.unpack(">II", path.read_bytes()[16:24])


_UNAVAILABLE = headless_unavailable()


@unittest.skipIf(_UNAVAILABLE, _UNAVAILABLE or "")
class HeadlessMaterialCommandTests(unittest.TestCase):
    """Cooking, a ball and a bake on the living materials template, drawn small in the headless browser."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "living"
        self.out = Path(self.tmp.name) / "pictures"
        repository = ProjectRepository.create(self.path, "Living")
        apply_template(repository, "living-materials", project_name="Living")
        repository.save()
        repository.close()

    def run_command(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main([str(self.path), "--json", *args])
        self.assertEqual(code, 0, err.getvalue())
        return code, out.getvalue(), err.getvalue()

    def test_cooks_into_a_folder_and_the_project(self) -> None:
        _, out, _ = self.run_command("cook", "Living crate", "--size", "32", "--out", str(self.out), "--into-project")
        files = json.loads(out)["files"]
        self.assertEqual(sorted(file["name"] for file in files), ["Living_crate_baseColor.png", "Living_crate_normal.png", "Living_crate_orm.png"])
        for file in files:
            self.assertEqual(_png_size(Path(file["path"])), (32, 32))
        with ProjectRepository(self.path, read_only=True) as repository:
            crate = repository.get_domain("materials")["documents"][0]
            textures = {item["id"]: item for item in repository.get_domain("textures")["documents"]}
            self.assertEqual(sorted(crate["pictures"]), ["baseColor", "normal", "orm"])
            self.assertEqual(crate["textureGraph"]["baked"]["size"], 5)
            for role, texture_id in crate["pictures"].items():
                self.assertEqual(textures[texture_id]["folder"], "Texture graphs/Living crate")
                self.assertTrue(repository.assets.verify(textures[texture_id]["assetId"]))
        # Cooked again, the pictures it replaces go.
        self.run_command("cook", "Living crate", "--size", "16", "--into-project")
        with ProjectRepository(self.path, read_only=True) as repository:
            self.assertEqual(len(repository.get_domain("textures")["documents"]), 3)

    def test_draws_a_ball(self) -> None:
        _, out, _ = self.run_command("ball", "living-crate", "--size", "32", "--out", str(self.out), "--into-project")
        result = json.loads(out)
        self.assertEqual(_png_size(Path(result["files"][0]["path"])), (32, 32))
        # Its texture graph was never made into pictures: the ball shows them made now.
        self.assertIn("not up to date", " ".join(result["notes"]))
        with ProjectRepository(self.path, read_only=True) as repository:
            textures = repository.get_domain("textures")["documents"]
        self.assertEqual([(item["name"], item["folder"]) for item in textures], [("Living crate ball", "Material balls")])

    def test_bakes_mesh_maps_into_a_painted_set(self) -> None:
        _, out, _ = self.run_command("bake-mesh-maps", "Crate", "--size", "16", "--samples", "4", "--out", str(self.out), "--into-project")
        result = json.loads(out)
        names = {file["name"] for file in result["files"]}
        self.assertIn("Crate_Wood_ambientOcclusion.png", names)
        self.assertIn("Crate_Wood_normal.png", names)
        # A painted set is 256 pixels across at least.
        self.assertEqual(_png_size(self.out / "Crate_Wood_position.png"), (256, 256))
        with ProjectRepository(self.path, read_only=True) as repository:
            sets = [item for item in repository.get_domain("materials")["documents"] if item.get("paint")]
            self.assertEqual(len(sets), 1)
            paint = sets[0]["paint"]
            self.assertEqual((paint["modelId"], paint["materialNames"], paint["size"]), ("starter-model-crate", ["Wood"], 8))
            for map_name in ("ambientOcclusion", "normal", "position", "curvature"):
                self.assertTrue(repository.assets.verify(paint["bake"]["maps"][map_name]["1001"]["assetId"]))


if __name__ == "__main__":
    unittest.main()
