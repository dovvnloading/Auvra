from __future__ import annotations
import json, tempfile, unittest
from pathlib import Path
from unittest import mock

from Auvra.project import ProjectRepository
import Auvra.project.migrations as migrations
import Auvra.project.repository as repository_module
from Auvra.project.errors import InvalidProjectError, UnsupportedVersionError
from Auvra.project.migrations import (ENGINE_VERSION, Migration, MigrationRegistry,
                                      ProjectMigrationError)


def _rename_title(descriptor, domains):
    """Test-only 0 -> 1 step: version 0 metadata stored ``title``."""
    for document in domains.get("metadata", {}).get("documents", []):
        document["name"] = document.pop("title")
    domains.setdefault("metadata", {})["schemaVersion"] = 1
    return descriptor, domains


TEST_MIGRATION = Migration(0, 1, "rename metadata title to name", _rename_title)


class MigrationRegistryTests(unittest.TestCase):
    def test_shipped_registry_is_empty_for_the_first_format(self):
        self.assertEqual(migrations.CURRENT_SCHEMA_VERSION, repository_module.VERSION)
        self.assertEqual(migrations.REGISTRY.migrations, ())
        self.assertEqual(migrations.REGISTRY.plan(1, 1), ())

    def test_plan_orders_steps_and_refuses_unknown_versions(self):
        noop = lambda descriptor, domains: (descriptor, domains)
        registry = MigrationRegistry([Migration(2, 3, "b", noop), Migration(0, 2, "a", noop)])
        self.assertEqual([(m.from_version, m.to_version) for m in registry.plan(0, 3)], [(0, 2), (2, 3)])
        self.assertEqual(registry.plan(3, 3), ())
        with self.assertRaisesRegex(UnsupportedVersionError, "newer than this engine"):
            registry.plan(4, 3)
        with self.assertRaisesRegex(UnsupportedVersionError, "no migration"):
            registry.plan(1, 3)
        with self.assertRaisesRegex(UnsupportedVersionError, "no migration"):
            registry.plan(0, 1)  # the only step from 0 overshoots the target
        for bad in (None, "1", True, -1, 1.0):
            with self.assertRaises(UnsupportedVersionError):
                registry.plan(bad, 3)

    def test_register_rejects_ambiguous_or_backward_steps(self):
        noop = lambda descriptor, domains: (descriptor, domains)
        registry = MigrationRegistry([Migration(0, 1, "a", noop)])
        with self.assertRaises(ValueError): registry.register(Migration(0, 2, "dup", noop))
        with self.assertRaises(ValueError): registry.register(Migration(2, 2, "same", noop))
        with self.assertRaises(ValueError): registry.register(Migration(3, 1, "back", noop))

    def test_migrate_runs_on_copies_and_wraps_failures(self):
        descriptor = {"schemaVersion": 0}
        domains = {"metadata": {"schemaVersion": 0, "documents": [{"id": "m", "title": "T"}]}}
        result = MigrationRegistry([TEST_MIGRATION]).migrate(descriptor, domains, 1)
        self.assertEqual(result.descriptor["schemaVersion"], 1)
        self.assertEqual(result.domains["metadata"]["documents"], [{"id": "m", "name": "T"}])
        self.assertEqual(domains["metadata"]["documents"], [{"id": "m", "title": "T"}])
        self.assertEqual(result.applied, (TEST_MIGRATION,))

        def broken(descriptor, domains): raise KeyError("boom")
        with self.assertRaisesRegex(ProjectMigrationError, "0->1 failed"):
            MigrationRegistry([Migration(0, 1, "broken", broken)]).migrate(descriptor, domains, 1)
        with self.assertRaisesRegex(ProjectMigrationError, "invalid result"):
            MigrationRegistry([Migration(0, 1, "bad", lambda d, m: None)]).migrate(descriptor, domains, 1)


class RepositoryMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name) / "Migrated"
        ProjectRepository.create(self.root, "Migrated").close()
        self.descriptor_path = self.root / "Migrated.auvra"
        self.metadata_path = self.root / "Project" / "metadata.json"
    def tearDown(self): self.tmp.cleanup()

    def read(self, path): return json.loads(path.read_text(encoding="utf-8"))
    def write(self, path, value): path.write_text(json.dumps(value), encoding="utf-8")

    def make_version_zero(self):
        descriptor = self.read(self.descriptor_path); descriptor["schemaVersion"] = 0
        descriptor.pop("engineVersion", None); self.write(self.descriptor_path, descriptor)
        self.write(self.metadata_path, {"schemaVersion": 0, "documents": [{"id": "meta", "title": "Old"}]})

    def test_create_and_commit_stamp_engine_version(self):
        self.assertEqual(self.read(self.descriptor_path)["engineVersion"], ENGINE_VERSION)
        descriptor = self.read(self.descriptor_path); descriptor["engineVersion"] = "0.1.0"
        self.write(self.descriptor_path, descriptor)
        with ProjectRepository(self.root) as repo:
            repo.apply_changes({"metadata": [{"id": "meta"}]}, expected_revision=0)
        self.assertEqual(self.read(self.descriptor_path)["engineVersion"], ENGINE_VERSION)

    def test_existing_project_without_engine_version_still_opens(self):
        descriptor = self.read(self.descriptor_path); descriptor.pop("engineVersion")
        self.write(self.descriptor_path, descriptor)
        with ProjectRepository(self.root) as repo:
            self.assertEqual(repo.revision, 0)
            self.assertNotIn("engineVersion", self.read(self.descriptor_path))
            repo.apply_changes({"metadata": [{"id": "meta"}]}, expected_revision=0)
        self.assertEqual(self.read(self.descriptor_path)["engineVersion"], ENGINE_VERSION)

    def test_newer_version_is_refused_without_touching_the_project(self):
        descriptor = self.read(self.descriptor_path); descriptor["schemaVersion"] = 2
        self.write(self.descriptor_path, descriptor); before = self.descriptor_path.read_bytes()
        with self.assertRaisesRegex(UnsupportedVersionError, "schemaVersion 2 is newer"):
            ProjectRepository(self.root)
        self.assertEqual(self.descriptor_path.read_bytes(), before)
        descriptor["schemaVersion"] = 1; self.write(self.descriptor_path, descriptor)
        with ProjectRepository(self.root) as repo:  # the refusal released the writer lock
            self.assertFalse(repo.read_only)

    def test_older_version_without_a_migration_path_is_refused(self):
        self.make_version_zero()
        with self.assertRaisesRegex(UnsupportedVersionError, "no migration from schemaVersion 0"):
            ProjectRepository(self.root)

    def test_injected_migration_upgrades_on_open_in_one_transaction(self):
        self.make_version_zero()
        with mock.patch.object(migrations, "REGISTRY", MigrationRegistry([TEST_MIGRATION])):
            with ProjectRepository(self.root) as repo:
                self.assertEqual(repo.revision, 1)
                self.assertEqual(repo.get_domain("metadata")["documents"], [{"id": "meta", "name": "Old"}])
        descriptor = self.read(self.descriptor_path)
        self.assertEqual((descriptor["schemaVersion"], descriptor["revision"], descriptor["engineVersion"]),
                         (1, 1, ENGINE_VERSION))
        self.assertEqual(self.read(self.metadata_path)["documents"], [{"id": "meta", "name": "Old"}])
        self.assertEqual(list((self.root / ".auvra" / "transactions").glob("*.json")), [])
        with ProjectRepository(self.root) as repo:  # current now; no registry needed
            self.assertEqual(repo.revision, 1)

    def test_read_only_open_refuses_to_upgrade(self):
        self.make_version_zero(); before = self.metadata_path.read_bytes()
        with mock.patch.object(migrations, "REGISTRY", MigrationRegistry([TEST_MIGRATION])):
            with self.assertRaisesRegex(UnsupportedVersionError, "opened for writing"):
                ProjectRepository(self.root, read_only=True)
        self.assertEqual(self.metadata_path.read_bytes(), before)
        self.assertEqual(self.read(self.descriptor_path)["schemaVersion"], 0)

    def test_invalid_migration_output_leaves_old_project_intact(self):
        self.make_version_zero(); before = self.metadata_path.read_bytes()
        def keeps_title(descriptor, domains): return descriptor, domains
        registry = MigrationRegistry([Migration(0, 1, "incomplete", keeps_title)])
        with mock.patch.object(migrations, "REGISTRY", registry):
            with self.assertRaises(InvalidProjectError) as caught:
                ProjectRepository(self.root)
        self.assertIsInstance(caught.exception, ProjectMigrationError)
        self.assertEqual(self.metadata_path.read_bytes(), before)
        self.assertEqual(self.read(self.descriptor_path)["schemaVersion"], 0)


if __name__ == "__main__":
    unittest.main()
