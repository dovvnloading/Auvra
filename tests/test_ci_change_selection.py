"""Safety guarantees for CI path-based skips."""

import unittest
import re
from pathlib import Path

from tools.ci.select_checks import ALL, classify


class CheckSelectionTests(unittest.TestCase):
    def test_unknown_change_fails_open(self):
        self.assertEqual(classify(["future-engine/sim.cpp"]), set(ALL))

    def test_missing_diff_fails_open(self):
        self.assertEqual(classify([]), set(ALL))

    def test_manual_release_runs_everything(self):
        self.assertEqual(classify(["README.md"], full=True), set(ALL))

    def test_docs_only_does_not_launch_expensive_jobs(self):
        self.assertEqual(classify(["docs/architecture.md", "README.md"]), set())

    def test_editor_change_checks_browser_and_webview(self):
        self.assertEqual(classify(["fbx-viewer (1)/components/App.tsx"]), {"editor", "browser", "smoke"})

    def test_protocol_change_checks_everything(self):
        self.assertEqual(classify(["protocol/v1/file.schema.json"]), set(ALL))

    def test_generated_protocol_change_checks_everything(self):
        self.assertEqual(classify(["fbx-viewer (1)/host/generated/protocolV1.ts"]), set(ALL))

    def test_native_change_checks_windows_integration(self):
        self.assertEqual(classify(["native/src/lib.rs"]), {"native", "smoke"})

    def test_player_change_runs_every_platform(self):
        self.assertEqual(classify(["player-desktop/src/main.rs"]), {"player"})

    def test_python_change_checks_integration(self):
        self.assertEqual(classify(["Auvra/desktop/controller.py"]), {"python", "smoke"})

    def test_python_test_alone_does_not_build_native_player(self):
        self.assertEqual(classify(["tests/host/test_dispatcher.py"]), {"python"})

    def test_workflow_change_checks_everything(self):
        self.assertEqual(classify([".github/workflows/verify.yml"]), set(ALL))

    def test_ci_selector_change_checks_everything(self):
        self.assertEqual(classify(["tools/ci/select_checks.py"]), set(ALL))

    def test_multi_area_change_is_union(self):
        self.assertEqual(classify(["native/src/lib.rs", "player-desktop/src/main.rs"]), {"native", "smoke", "player"})

    def test_licensing_change_is_not_skipped(self):
        self.assertEqual(classify(["LICENSE"]), set(ALL))

    def test_unknown_mixed_with_docs_runs_everything(self):
        self.assertEqual(classify(["README.md", "new-engine/src.rs"]), set(ALL))

    def test_matrix_required_checks_are_step_gated(self):
        # A skipped matrix job does not emit its individual required check names.
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/verify.yml").read_text()
        for job, signal, step_count in [
            ("editor-build", "editor", 15),
            ("python-verify", "python", 6),
            ("native-engine-build", "native", 9),
        ]:
            with self.subTest(job=job):
                after_job = workflow.split(f"  {job}:\n", 1)[1]
                block = re.split(r"(?m)^  [a-z][a-z0-9-]*:\s*$", after_job, maxsplit=1)[0]
                header, steps = block.split("    steps:\n", 1)
                self.assertNotIn(f"    if: needs.changes.outputs.{signal}", header)
                self.assertIn(f"if: needs.changes.outputs.{signal} != 'true'", steps)
                self.assertEqual(steps.count(f"if: needs.changes.outputs.{signal} == 'true'"), step_count)
                self.assertIn("working-directory: ${{ github.workspace }}", steps)


if __name__ == "__main__":
    unittest.main()
