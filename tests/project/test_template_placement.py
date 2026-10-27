from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from typing import Any

from Auvra.project.repository import ProjectRepository
from Auvra.project.schemas import _NESTED_KEYS
from Auvra.project.templates import _STARTER_FLAT_RADIUS, _hills, apply_template


def documents(repository: ProjectRepository, domain: str) -> list[dict[str, Any]]:
    value = repository.get_domain(domain)
    return value["documents"] if isinstance(value, dict) else value


class TemplatePlacementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def objects(self, template: str) -> list[dict[str, Any]]:
        repository = ProjectRepository.create(self.root / template, template.title())
        self.addCleanup(repository.close)
        apply_template(repository, template, project_name=template.title())
        return documents(repository, "objects")

    def test_starter_props_stand_on_the_terrain(self) -> None:
        props = [item for item in self.objects("starter") if item["type"] == "prop"]
        self.assertGreater(len(props), 10)
        for prop in props:
            x, y, z = prop["position"]
            ground = _hills(x, z, _STARTER_FLAT_RADIUS)
            with self.subTest(prop=prop["name"]):
                # Never floating, and sunk no more than a hand's width into a slope.
                self.assertLessEqual(y, ground + 1e-6)
                self.assertGreaterEqual(y, ground - 0.15)
                if math.hypot(x, z) <= _STARTER_FLAT_RADIUS:
                    self.assertEqual(y, 0.0)
        # The hills actually reach the tree ring, so this is not a flat-ground pass.
        self.assertGreater(max(abs(prop["position"][1]) for prop in props), 0.5)

    def test_every_template_sky_is_editable(self) -> None:
        for template in ("starter", "arena", "courtyard"):
            skies = [item for item in self.objects(template) if item["type"] == "sky_sphere"]
            self.assertTrue(skies, template)
            for sky in skies:
                with self.subTest(template=template, sky=sky["id"]):
                    config = sky.get("skyConfig")
                    self.assertIsInstance(config, dict)
                    self.assertEqual(set(config), _NESTED_KEYS["skyConfig"])
                    self.assertNotEqual(config["fogColor"].lower(), "#050505")
                    self.assertGreater(sky["position"][1], 0.0)


if __name__ == "__main__":
    unittest.main()
