"""Safety guarantees for CI path-based skips."""

import unittest

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


if __name__ == "__main__":
    unittest.main()
