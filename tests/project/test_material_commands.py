import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from Auvra.project.material_commands import MaterialCommandError, apply_preset, list_materials, main, set_value
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

    def test_says_what_is_drawn_by_the_editor(self) -> None:
        for command in ("cook", "ball", "bake-mesh-maps"):
            code, _, err = self.run_command(command, "Living crate")
            self.assertEqual(code, 3)
            self.assertIn("In the editor", err)
        code, _, err = self.run_command("set-value", "Living crate", "Dryness", "1")
        self.assertEqual(code, 2)
        self.assertIn("no parameter", err)


if __name__ == "__main__":
    unittest.main()
