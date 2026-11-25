from __future__ import annotations

import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from Auvra.project import archive
from Auvra.project.errors import ArchiveValidationError


class ArchiveExportTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "project"
        self.destination = Path(temp.name) / "backup.auvrapack"
        self.files = {
            "Demo.auvra": b'{"name":"Demo"}',
            ".gitignore": b".auvra/\n",
            "Project/metadata.json": b'{"documents":[]}',
            "Content/manifest.json": b"{}",
        }
        for data in (b"a" * 4096, b"b" * 4096):
            self.files[f"Content/sha256/{hashlib.sha256(data).hexdigest()}"] = data
        for name, data in self.files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.total = sum(map(len, self.files.values()))

    def assert_no_staging(self):
        self.assertEqual(list(self.destination.parent.glob(self.destination.name + ".tmp-*")), [])

    def test_exact_limit_exports_and_passes_import_validation(self):
        # Internal files are excluded from the portable pack and its budget.
        internal = self.root / ".auvra" / "journal"
        internal.parent.mkdir()
        internal.write_bytes(b"x" * self.total)
        with mock.patch.object(archive, "MAX_TOTAL", self.total):
            archive.export_folder(self.root, self.destination)
            infos = archive.validate_archive(self.destination)
            self.assertEqual(sum(info.file_size for info in infos), self.total)
        with zipfile.ZipFile(self.destination) as packed:
            self.assertEqual({info.filename: packed.read(info) for info in packed.infolist()
                              if not info.is_dir()}, self.files)
        self.assert_no_staging()

    def test_over_limit_rejected_before_writing_or_replacing(self):
        # Both assets fit individually; together with metadata they exceed the cap.
        for existing in (False, True):
            with self.subTest(existing=existing):
                if existing:
                    archive.export_folder(self.root, self.destination)
                    previous = self.destination.read_bytes()
                with (mock.patch.object(archive, "MAX_TOTAL", self.total - 1),
                      mock.patch.object(zipfile.ZipFile, "write") as write):
                    with self.assertRaisesRegex(ArchiveValidationError, "uncompressed bytes.*Save As"):
                        archive.export_folder(self.root, self.destination)
                    write.assert_not_called()
                if existing:
                    self.assertEqual(self.destination.read_bytes(), previous)
                else:
                    self.assertFalse(self.destination.exists())
                self.assert_no_staging()

    def test_growth_after_preflight_rejected_and_existing_pack_preserved(self):
        archive.export_folder(self.root, self.destination)
        previous = self.destination.read_bytes()
        original_write = zipfile.ZipFile.write
        target = self.root / "Project/metadata.json"

        def grow_before_write(packed, filename, *args, **kwargs):
            if filename == target:
                with target.open("ab") as stream:
                    stream.write(b" ")
            return original_write(packed, filename, *args, **kwargs)

        with (mock.patch.object(archive, "MAX_TOTAL", self.total),
              mock.patch.object(zipfile.ZipFile, "write", autospec=True, side_effect=grow_before_write)):
            with self.assertRaisesRegex(ArchiveValidationError, "archive exceeds size limit"):
                archive.export_folder(self.root, self.destination)
        self.assertEqual(self.destination.read_bytes(), previous)
        self.assert_no_staging()

    def test_final_archive_must_pass_import_member_checks(self):
        # The final validation also catches independently enforced import limits.
        archive.export_folder(self.root, self.destination)
        previous = self.destination.read_bytes()
        with mock.patch.object(archive, "MAX_MEMBERS", len(self.files) + 2):
            with self.assertRaisesRegex(ArchiveValidationError, "too many members"):
                archive.export_folder(self.root, self.destination)
        self.assertEqual(self.destination.read_bytes(), previous)
        self.assert_no_staging()

    def test_import_custom_total_override_still_works(self):
        archive.export_folder(self.root, self.destination)
        with mock.patch.object(archive, "MAX_TOTAL", self.total - 1):
            with self.assertRaisesRegex(ArchiveValidationError, "archive exceeds size limit"):
                archive.validate_archive(self.destination)
            self.assertTrue(archive.validate_archive(self.destination, max_total=self.total))


class RepositoryArchiveBudgetTests(unittest.TestCase):
    def test_export_and_import_share_budget_for_valid_project(self):
        from io import BytesIO
        from Auvra.project import ProjectRepository

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            destination = root / "project.auvrapack"
            with ProjectRepository.create(root / "source", "Demo") as repo:
                refs = [repo.assets.put_stream(BytesIO(data), mime="application/octet-stream")
                        for data in (b"a" * 4096, b"b" * 4096)]
                repo.apply_changes({"models": [
                    {"id": f"m{index}", "name": f"Model {index}", "assetId": ref.asset_id}
                    for index, ref in enumerate(refs)
                ]}, expected_revision=0)
                repo.export_pack(destination)
                total = sum(info.file_size for info in archive.validate_archive(destination))
                with mock.patch.object(archive, "MAX_TOTAL", total):
                    repo.export_pack(destination)
                    with ProjectRepository.import_pack(destination, root / "imported") as imported:
                        self.assertEqual(imported.get_domain("models"), repo.get_domain("models"))
                        self.assertTrue(all(imported.assets.verify(ref.asset_id) for ref in refs))
                previous = destination.read_bytes()
                with mock.patch.object(archive, "MAX_TOTAL", total - 1):
                    with self.assertRaisesRegex(ArchiveValidationError, "archive exceeds size limit"):
                        repo.export_pack(destination)
                self.assertEqual(destination.read_bytes(), previous)
                self.assertEqual(list(root.glob(destination.name + ".tmp-*")), [])
