from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from Auvra.project import ProjectRepository
from Auvra.project.errors import InvalidProjectError

_PREFAB = {
    "id": "crate", "name": "Crate", "rootId": "root",
    "objects": [{"id": "root", "name": "Root", "type": "prop",
                 "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}],
}


class RecoveryPointsBeforePrefabsTests(unittest.TestCase):
    """Recovery points written before the prefabs domain existed have no prefabs.json."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "Project"
        self.repo = ProjectRepository.create(self.root, "Project")

    def tearDown(self):
        self.repo.close()
        self.tmp.cleanup()

    def _point_without(self, domain: str) -> str:
        self.repo.apply_changes({"metadata": [{"id": "snapshot", "name": "Snapshot"}]}, expected_revision=0)
        self.repo.save()
        name = self.repo.recovery_points("manual")[0]["name"]
        (self.root / ".auvra" / "backups" / name / f"{domain}.json").unlink()
        return name

    def test_missing_prefabs_is_listed_and_restores_as_empty_domain(self):
        point = self._point_without("prefabs")
        self.assertIn(point, {item["name"] for item in self.repo.recovery_points("manual")})
        self.repo.apply_changes({"prefabs": [_PREFAB]}, expected_revision=self.repo.revision)
        self.assertEqual(len(self.repo.get_domain("prefabs")["documents"]), 1)

        self.repo.restore_recovery("manual", point)

        self.assertEqual(self.repo.get_domain("prefabs")["documents"], [])
        self.assertEqual(self.repo.get_domain("metadata")["documents"][0]["id"], "snapshot")

    def test_listing_measures_each_finished_point_once(self):
        point = self._point_without("prefabs")
        # Taking the file out changed the point, so this listing measures it again; later ones do not.
        self.repo.recovery_points("manual")
        original = Path.rglob
        with mock.patch.object(Path, "rglob", autospec=True, side_effect=original) as walked:
            for _ in range(3):
                self.assertIn(point, {item["name"] for item in self.repo.recovery_points("manual")})
        self.assertEqual(walked.call_count, 0)

    def test_other_missing_domains_still_fail(self):
        point = self._point_without("hud")
        self.assertNotIn(point, {item["name"] for item in self.repo.recovery_points("manual")})
        with self.assertRaises(InvalidProjectError):
            self.repo.restore_recovery("manual", point)

    def test_prefabs_entry_that_is_not_a_file_still_fails(self):
        point = self._point_without("prefabs")
        (self.root / ".auvra" / "backups" / point / "prefabs.json").mkdir()
        self.assertNotIn(point, {item["name"] for item in self.repo.recovery_points("manual")})
        with self.assertRaises(InvalidProjectError):
            self.repo.restore_recovery("manual", point)


if __name__ == "__main__":
    unittest.main()
