import tempfile
import unittest
from pathlib import Path

from Auvra.project.errors import InvalidProjectError
from Auvra.project.index import ProjectIndex
from Auvra.project.service import ProjectService


class ProjectServiceCreateTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.service = ProjectService(ProjectIndex(self.root / "index.sqlite3"))
        self.addCleanup(self.service.shutdown)

    def test_failed_template_leaves_no_project_and_the_path_can_be_reused(self) -> None:
        target = self.root / "Game"
        with self.assertRaises(InvalidProjectError):
            self.service.create(target, "Game", template="no-such-template")
        self.assertFalse(target.exists())
        self.assertIsNone(self.service.active)

        status = self.service.create(target, "Game", template="starter")
        self.assertEqual(status.name, "Game")
        self.assertTrue(target.is_dir())


if __name__ == "__main__":
    unittest.main()
