import contextlib
import io
import json
import shutil
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

    @unittest.skipUnless(shutil.which("node") and (material_commands._EDITOR_ROOT / "node_modules/esbuild").is_dir(),
                         "requires the editor's Node dependencies")
    def test_rename_previews_commits_and_travels_through_reopened_project(self) -> None:
        with ProjectRepository(self.path) as repository:
            materials = repository.get_domain("materials")["documents"]
            source = materials[0]
            source["roughness"] = 0.42
            source["textureGraph"]["graph"]["parameters"][0]["hintExtension"] = "keep"
            dependent = {"id": "dependent", "name": "Dependent", "graph": source["graph"], "textureGraph": {"graph": {
                "version": 1, "nodes": [{"id": "graph", "type": "subgraph", "params": {"graph": source["id"]},
                                        "valuePins": ["Wetness"]}], "links": [], "parameters": []}},
                "paint": {"version": 1, "layers": [{"fill": {"roughness": {"kind": "graph", "graphId": source["id"],
                                                                "values": {"Wetness": 0.75}}}}]}}
            models = repository.get_domain("models")["documents"]
            objects = repository.get_domain("objects")["documents"]
            placed = next(obj for obj in objects if obj["id"] == "living-wet-1")
            model = next(item for item in models if item["id"] == placed["modelId"])
            slot = next(iter(placed["materialOverrides"]))
            model["materialOverrides"][slot]["parameters"] = [{"name": "Wetness", "value": 0.77}]
            member = {key: placed[key] for key in ("id", "modelId", "name", "type", "position", "rotation", "scale", "materialOverrides")}
            prefab = {"id": "kit", "name": "Kit", "rootId": member["id"], "objects": [member]}
            meta = {"id": "texture-graph-presets", "settings": {"version": 1, "presets": [
                {"id": "library", "graphId": source["id"], "values": {"Wetness": 0.2}}]}}
            repository.apply_changes({"materials": [*materials, dependent], "models": models, "prefabs": [prefab],
                                      "metadata": [*repository.get_domain("metadata")["documents"], meta]},
                                     expected_revision=repository.revision)
            before = material_commands._rename_inventory(repository)
            revision = repository.revision
            code, _, error = self.run_command("rename-parameter", source["id"], "Wetness", "Patina")
            self.assertEqual(code, 2, error)
            self.assertIn("open elsewhere", error)

        receipt = Path(self.tmp.name) / "command.json"
        args = ["rename-parameter", source["id"], "Wetness", "Patina"]
        def run(*arguments):
            code, out, err = self.run_command("--json", *arguments)
            self.assertEqual(code, 0, err)
            return json.loads(out)

        preview = run(*args)
        self.assertFalse(preview["applied"])
        self.assertEqual(preview["revision"], revision)
        self.assertEqual(preview["impact"]["nestedNodes"], 1)
        self.assertEqual(preview["impact"]["objectOverrides"], 5)
        self.assertEqual(preview["impact"]["prefabOverrides"], 1)
        self.assertEqual(preview["impact"]["sharedPresets"], 1)
        self.assertEqual(preview["impact"]["paintReferences"], 1)
        self.assertEqual(preview["impact"]["modelOverrides"], 1)
        with ProjectRepository(self.path) as repository:
            self.assertEqual(material_commands._rename_inventory(repository), before)

        apply = [*args, "--apply-revision", str(revision), "--receipt", str(receipt)]
        with mock.patch.object(ProjectRepository, "apply_changes", side_effect=MaterialCommandError("forced failure")):
            self.assertEqual(self.run_command(*apply)[0], 2)
        with ProjectRepository(self.path) as repository:
            self.assertEqual(repository.revision, revision)
            self.assertEqual(material_commands._rename_inventory(repository), before)
        self.assertEqual(self.run_command(*apply)[0], 2)  # Existing receipt is preserved.
        receipt.unlink()
        self.assertEqual(run(*apply)["revision"], revision + 1)
        with ProjectRepository(self.path) as repository:
            after = material_commands._rename_inventory(repository)
            values = [parameter for obj in after["objects"] for entry in obj.get("materialOverrides", {}).values()
                      for parameter in entry.get("parameters", [])]
            self.assertFalse(any(parameter["name"] == "Wetness" for parameter in values))
            self.assertEqual(sum(parameter["name"] == "Patina" for parameter in values), 5)
            saved = next(item for item in after["materials"] if item["id"] == source["id"])
            self.assertEqual(saved["roughness"], 0.42)
            self.assertEqual(saved["textureGraph"]["graph"]["parameters"][0]["hintExtension"], "keep")
        self.assertEqual(run("undo-rename", str(receipt))["revision"], revision + 2)
        with ProjectRepository(self.path) as repository:
            self.assertEqual(material_commands._rename_inventory(repository), before)
        self.assertEqual(run("redo-rename", str(receipt))["revision"], revision + 3)
        with ProjectRepository(self.path) as repository:
            self.assertEqual(material_commands._rename_inventory(repository), after)
            set_value(repository, source["id"], "Patina", 0.6)
        code, _, err = self.run_command("undo-rename", str(receipt))
        self.assertEqual(code, 2)
        self.assertIn("differ", err)

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
