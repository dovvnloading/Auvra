"""Failure-injection coverage for asset blob and manifest publication (#346)."""
from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from Auvra.project import ProjectRepository
from Auvra.project.assets import AssetStore, GENERIC_MIME, OBJ_MIME
from Auvra.project.errors import RecoveryRequiredError


class AssetPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "project"
        self.repo: ProjectRepository | None = ProjectRepository.create(self.root, "project")
        self.manifest = self.root / "Content" / "manifest.json"
        self.content = self.root / "Content" / "sha256"

    def tearDown(self) -> None:
        self._close()
        self.tmp.cleanup()

    def _close(self) -> None:
        if self.repo is not None:
            self.repo.close()
            self.repo = None

    def _reopen(self) -> None:
        self._close()
        self.repo = ProjectRepository(self.root)

    def _records(self) -> dict:
        return json.loads(self.manifest.read_text(encoding="utf-8")) if self.manifest.exists() else {}

    def _assert_manifest_matches_blobs(self) -> None:
        live = {path.name for path in self.content.iterdir() if path.is_file()}
        self.assertEqual(set(self._records()), live)
        self.assertTrue(all(len(asset_id) == 64 for asset_id in live))
        self.assertEqual(
            {entry.name for entry in self.manifest.parent.iterdir()},
            {"sha256"} | ({"manifest.json"} if self.manifest.exists() else set()),
        )

    def _crash_import(self, body: str, expected_exit: int) -> None:
        # Import from a separate process: a Python exception would run finally
        # blocks, but an actual process exit does not.
        self._close()
        completed = subprocess.run(
            [sys.executable, "-c", body, str(self.root / "Content")],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(completed.returncode, expected_exit, completed.stderr)

    def test_manifest_write_failure_rolls_back_only_new_blob(self) -> None:
        assert self.repo is not None
        existing = self.repo.assets.put_stream(io.BytesIO(b"existing asset"))
        self.repo.apply_changes(
            {"models": [{"id": "existing", "name": "Existing", "assetId": existing.asset_id}]},
            expected_revision=0,
        )
        data = b"new blob whose manifest cannot be written"
        asset_id = hashlib.sha256(data).hexdigest()
        original = self._records()

        with mock.patch.object(AssetStore, "_record", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.repo.assets.put_stream(io.BytesIO(data))

        self.assertFalse((self.content / asset_id).exists())
        self.assertEqual(self._records(), original)
        self._assert_manifest_matches_blobs()
        self._reopen()
        assert self.repo is not None
        self.assertTrue(self.repo.assets.verify(existing.asset_id))
        self.assertFalse((self.content / asset_id).exists())

    def test_blob_install_failure_never_publishes_manifest(self) -> None:
        assert self.repo is not None
        data = b"blob-rename-refused"
        asset_id = hashlib.sha256(data).hexdigest()
        target = self.content / asset_id
        original_replace = os.replace

        def refuse_blob(source, destination):
            if Path(destination) == target:
                raise PermissionError("blob destination is locked")
            return original_replace(source, destination)

        with mock.patch("Auvra.project.assets.os.replace", side_effect=refuse_blob):
            with self.assertRaises(PermissionError):
                self.repo.assets.put_stream(io.BytesIO(data))

        self.assertFalse(target.exists())
        self.assertNotIn(asset_id, self._records())
        self.assertFalse((self.content / ".incoming" / f".publish-{asset_id}").exists())
        self._reopen()
        self._assert_manifest_matches_blobs()

    def test_partial_manifest_write_and_failed_temp_cleanup_leave_project_openable(self) -> None:
        assert self.repo is not None
        data = b"partial-manifest-failure"
        asset_id = hashlib.sha256(data).hexdigest()
        original_write = Path.write_text
        original_unlink = Path.unlink

        def partial_write(path, text, *args, **kwargs):
            if Path(path).name.startswith("manifest.json.tmp-"):
                original_write(path, text[:12], *args, **kwargs)
                raise OSError("disk full during manifest write")
            return original_write(path, text, *args, **kwargs)

        def blocked_cleanup(path, *args, **kwargs):
            if Path(path).name.startswith("manifest.json.tmp-"):
                raise PermissionError("temporary manifest is locked")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "write_text", new=partial_write), \
             mock.patch.object(Path, "unlink", new=blocked_cleanup):
            with self.assertRaises(OSError):
                self.repo.assets.put_stream(io.BytesIO(data))

        self.assertFalse((self.content / asset_id).exists())
        self.assertTrue(list((self.content / ".incoming").glob("manifest.json.tmp-*")))
        self._reopen()
        self.assertFalse(list((self.content / ".incoming").glob("manifest.json.tmp-*")))
        self._assert_manifest_matches_blobs()

    def test_process_exit_after_blob_install_before_manifest_commit_is_replayed(self) -> None:
        data = b"exit-before-manifest"
        asset_id = hashlib.sha256(data).hexdigest()
        self._crash_import(
            "import io, os, sys\n"
            "from Auvra.project.assets import AssetStore\n"
            "def interrupt(*args, **kwargs): os._exit(73)\n"
            "AssetStore._record = interrupt\n"
            f"AssetStore(sys.argv[1]).put_stream(io.BytesIO({data!r}))\n",
            73,
        )
        self._reopen()
        self.assertFalse((self.content / asset_id).exists())
        self._assert_manifest_matches_blobs()

    def test_process_exit_during_partial_manifest_write_is_replayed(self) -> None:
        data = b"exit-during-manifest"
        asset_id = hashlib.sha256(data).hexdigest()
        self._crash_import(
            "import io, os, sys\n"
            "from pathlib import Path\n"
            "from Auvra.project.assets import AssetStore\n"
            "original = Path.write_text\n"
            "def interrupt(path, text, *args, **kwargs):\n"
            "    if path.name.startswith('manifest.json.tmp-'):\n"
            "        original(path, text[:12], *args, **kwargs)\n"
            "        os._exit(74)\n"
            "    return original(path, text, *args, **kwargs)\n"
            "Path.write_text = interrupt\n"
            f"AssetStore(sys.argv[1]).put_stream(io.BytesIO({data!r}))\n",
            74,
        )
        self.assertTrue(list((self.content / ".incoming").glob("manifest.json.tmp-*")))
        self._reopen()
        self.assertFalse((self.content / asset_id).exists())
        self.assertFalse(list((self.content / ".incoming").glob("manifest.json.tmp-*")))
        self._assert_manifest_matches_blobs()

    def test_failed_rollback_can_be_retried_on_next_writable_open(self) -> None:
        assert self.repo is not None
        data = b"rollback-is-temporarily-blocked"
        asset_id = hashlib.sha256(data).hexdigest()
        target = self.content / asset_id
        original_unlink = Path.unlink

        def locked_blob(path, *args, **kwargs):
            if Path(path) == target:
                raise PermissionError("blob is locked")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(AssetStore, "_record", side_effect=OSError("manifest write failed")), \
             mock.patch.object(Path, "unlink", new=locked_blob):
            with self.assertRaises(OSError):
                self.repo.assets.put_stream(io.BytesIO(data))

        self.assertTrue(target.exists())
        with self.assertRaises(RecoveryRequiredError):
            ProjectRepository(self.root)  # The current writer still owns the project.
        self._reopen()
        self.assertFalse(target.exists())
        self._assert_manifest_matches_blobs()

    def test_failure_after_manifest_commit_keeps_published_blob(self) -> None:
        assert self.repo is not None
        data = b"manifest-has-committed"
        asset_id = hashlib.sha256(data).hexdigest()
        original_record = AssetStore._record

        def commit_then_fail(store, *args, **kwargs):
            original_record(store, *args, **kwargs)
            raise OSError("interrupted after manifest commit")

        with mock.patch.object(AssetStore, "_record", new=commit_then_fail):
            with self.assertRaises(OSError):
                self.repo.assets.put_stream(io.BytesIO(data))

        self.assertIn(asset_id, self._records())
        self.assertTrue(self.repo.assets.verify(asset_id))
        self.repo.apply_changes(
            {"models": [{"id": "committed", "name": "Committed", "assetId": asset_id}]},
            expected_revision=0,
        )
        self._reopen()
        assert self.repo is not None
        self.assertTrue(self.repo.assets.verify(asset_id))
        self._assert_manifest_matches_blobs()

    def test_process_exit_after_manifest_commit_preserves_import(self) -> None:
        data = b"exit-after-manifest"
        asset_id = hashlib.sha256(data).hexdigest()
        self._crash_import(
            "import io, os, sys\n"
            "from Auvra.project.assets import AssetStore\n"
            "original = AssetStore._record\n"
            "def interrupt(store, *args, **kwargs):\n"
            "    original(store, *args, **kwargs)\n"
            "    os._exit(75)\n"
            "AssetStore._record = interrupt\n"
            f"AssetStore(sys.argv[1]).put_stream(io.BytesIO({data!r}))\n",
            75,
        )
        self._reopen()
        assert self.repo is not None
        self.assertTrue(self.repo.assets.verify(asset_id))
        self.assertIn(asset_id, self._records())
        self._assert_manifest_matches_blobs()

    def test_successful_ingest_and_existing_metadata_upgrade_are_unchanged(self) -> None:
        assert self.repo is not None
        store = self.repo.assets
        data = b"v 0 0 0\n"
        first = store.put_stream(io.BytesIO(data), mime=GENERIC_MIME, name="original.obj")
        second = store.put_stream(io.BytesIO(data), mime=OBJ_MIME, name="renamed.obj")
        self.assertEqual(first.asset_id, second.asset_id)
        self.assertEqual(
            self._records()[first.asset_id],
            {"size": len(data), "mime": OBJ_MIME, "name": "original.obj"},
        )
        self.assertFalse((self.content / ".incoming" / f".publish-{first.asset_id}").exists())
        self._assert_manifest_matches_blobs()
        self.repo.apply_changes(
            {"models": [{"id": "model", "name": "Model", "assetId": first.asset_id}]},
            expected_revision=0,
        )
        self._reopen()
        assert self.repo is not None
        self.assertTrue(self.repo.assets.verify(first.asset_id))
        self._assert_manifest_matches_blobs()


if __name__ == "__main__":
    unittest.main()
