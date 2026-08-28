from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest import mock

from Auvra.launcher import diagnostics
from Auvra.launcher.config import Paths


class SupportPolicyTests(unittest.TestCase):
    def test_bundle_has_fixed_members_and_rejects_sensitive_content(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra release policy ") as raw:
            paths = Paths.from_repo_root(Path(raw))
            with mock.patch.object(diagnostics, "collect_diagnostics", return_value={
                "ok": True, "frontend": "C:\\Users\\person\\project",
                "message": "Bearer should-not-escape https://example.test",
            }):
                destination = Path(raw) / "bundle.zip"
                diagnostics.export_support_bundle(paths, destination)
            with zipfile.ZipFile(destination) as archive:
                self.assertEqual(set(archive.namelist()), diagnostics._SUPPORT_MEMBERS)
                for name in archive.namelist():
                    self.assertNotRegex(archive.read(name).decode("utf-8"), r"(?i)bearer|https?://|[A-Z]:\\")
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["kind"], "auvra-support")
                self.assertEqual(manifest["version"], 2)
                self.assertEqual(manifest["schema"], "auvra.diagnostics/1")
                self.assertEqual(manifest["build"], "development")
                self.assertFalse(manifest["telemetry"])


if __name__ == "__main__":
    unittest.main()
