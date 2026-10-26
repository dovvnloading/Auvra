from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from Auvra.project.errors import InvalidProjectError
from Auvra.project.repository import ProjectRepository
from Auvra.project.service import ProjectService
from Auvra.project.index import ProjectIndex
from Auvra.project.templates import apply_template


def documents(repository: ProjectRepository, domain: str) -> list[dict]:
    value = repository.get_domain(domain)
    return value["documents"] if isinstance(value, dict) else value


class TemplateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        # Cleanups run last-in first-out, so repositories close before the folder is removed.
        self.addCleanup(self.tmp.cleanup)

    def create(self, name: str) -> ProjectRepository:
        repository = ProjectRepository.create(self.root / name, name.title())
        self.addCleanup(repository.close)
        return repository

    def test_starter_template_is_a_valid_playable_project(self) -> None:
        repository = self.create("starter")
        apply_template(repository, "starter", project_name="Starter")
        objects = documents(repository, "objects")
        kinds = {item["type"] for item in objects}
        self.assertTrue({"terrain", "sky_sphere", "player_start", "prop"} <= kinds)
        level_ids = {item["id"] for item in documents(repository, "levels")}
        self.assertTrue(all(item["levelId"] in level_ids for item in objects))
        model_ids = {item["id"] for item in documents(repository, "models")}
        self.assertTrue(all(item["modelId"] in model_ids for item in objects if item["type"] == "prop"))
        settings = next(item for item in documents(repository, "metadata") if item["id"] == "game-settings")["settings"]
        self.assertIn(settings["startupLevelId"], level_ids)
        player = next(item for item in documents(repository, "blueprints") if item["id"] == settings["playerBlueprintId"])
        self.assertIn(player["linkedModelId"], model_ids)
        for asset_id in repository.referenced_asset_ids():
            self.assertTrue(repository.assets.verify(asset_id), asset_id)

    def test_blank_template_leaves_the_project_empty(self) -> None:
        repository = self.create("blank")
        revision = repository.revision
        apply_template(repository, "blank", project_name="Blank")
        apply_template(repository, None, project_name="Blank")
        self.assertEqual(repository.revision, revision)
        self.assertEqual(documents(repository, "objects"), [])

    def test_unknown_template_is_rejected(self) -> None:
        repository = self.create("other")
        with self.assertRaises(InvalidProjectError):
            apply_template(repository, "shooter", project_name="Other")

    def test_service_create_applies_the_template(self) -> None:
        service = ProjectService(ProjectIndex(self.root / "index.sqlite3"))
        try:
            service.create(self.root / "via-service", "Via Service", "starter")
            self.assertGreater(len(documents(service.active, "objects")), 3)
        finally:
            service.shutdown()


if __name__ == "__main__":
    unittest.main()
