"""Explicit opt-in evidence for the real signed Windows package lifecycle."""

from __future__ import annotations

import os
from pathlib import Path
import unittest

from release.windows_lifecycle import CHANNEL_IDENTITIES, run_windows_lifecycle_smoke


class WindowsLifecycleSmokeTests(unittest.TestCase):
    def test_signed_windows_install_upgrade_rollback_uninstall(self) -> None:
        if os.name != "nt" or os.environ.get("AUVRA_WINDOWS_LIFECYCLE_SMOKE") != "1":
            self.skipTest("set AUVRA_WINDOWS_LIFECYCLE_SMOKE=1 on Windows to enable signed lifecycle evidence")
        channel = os.environ.get("AUVRA_WINDOWS_LIFECYCLE_CHANNEL", "stable")
        if channel not in CHANNEL_IDENTITIES:
            self.fail("AUVRA_WINDOWS_LIFECYCLE_CHANNEL must be stable, beta, or dev")
        names = {
            "initial": "AUVRA_WINDOWS_LIFECYCLE_INITIAL",
            "upgrade": "AUVRA_WINDOWS_LIFECYCLE_UPGRADE",
            "rollback": "AUVRA_WINDOWS_LIFECYCLE_ROLLBACK",
        }
        paths: dict[str, str] = {}
        for label, name in names.items():
            value = os.environ.get(name)
            if not value:
                self.fail(f"{name} is required when signed lifecycle evidence is enabled")
            paths[label] = value
        result = run_windows_lifecycle_smoke(
            Path(paths["initial"]),
            Path(paths["upgrade"]),
            Path(paths["rollback"]),
            identity=CHANNEL_IDENTITIES[channel],
        )
        self.assertEqual(result["identity"], CHANNEL_IDENTITIES[channel])
        self.assertTrue(result["userDataPreserved"])


if __name__ == "__main__":
    unittest.main()
