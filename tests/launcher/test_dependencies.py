from __future__ import annotations

import inspect
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from Auvra.launcher import dependencies
from Auvra.launcher.config import Paths
from Auvra.launcher.dependencies import inspect_dependencies, prepare_dependencies, validate_lockfile
from Auvra.launcher.process import run_owned_command


class DependencyFixture:
    def __init__(self, root: Path) -> None:
        self.paths = Paths.from_repo_root(root)
        self.paths.frontend_root.mkdir(parents=True)
        package = {
            "name": "fixture-editor", "version": "1.0.0", "dependencies": {"left-pad": "1.3.0"},
            "devDependencies": {"vite": "5.0.0"},
        }
        packages = {
            "": {"name": "fixture-editor", "version": "1.0.0", "dependencies": {"left-pad": "1.3.0"}, "devDependencies": {"vite": "5.0.0"}},
            "node_modules/left-pad": {"version": "1.3.0"},
            "node_modules/transitive": {"version": "2.0.0"},
            "node_modules/vite": {"version": "5.0.0", "dev": True},
        }
        lock = {"name": "fixture-editor", "version": "1.0.0", "lockfileVersion": 3, "requires": True, "packages": packages}
        self.paths.package_json.write_text(json.dumps(package), encoding="utf-8")
        self.paths.package_lock.write_text(json.dumps(lock), encoding="utf-8")
        self.package = package
        self.lock = lock

    def install(self) -> None:
        self.paths.node_modules.mkdir(parents=True, exist_ok=True)
        installed = {k: v for k, v in self.lock["packages"].items() if k}
        hidden = {"name": self.package["name"], "version": self.package["version"], "lockfileVersion": 3, "packages": installed}
        (self.paths.node_modules / ".package-lock.json").write_text(json.dumps(hidden), encoding="utf-8")
        for name, version in (("left-pad", "1.3.0"), ("transitive", "2.0.0"), ("vite", "5.0.0")):
            module = self.paths.node_modules / name
            (module / "bin").mkdir(parents=True, exist_ok=True)
            (module / "package.json").write_text(json.dumps({"name": name, "version": version}), encoding="utf-8")
        self.paths.vite_script.write_text("// fake vite\n", encoding="utf-8")


class DependencyStateTests(unittest.TestCase):
    def test_prepare_default_runner_is_owned_command_not_raw_subprocess(self) -> None:
        default = inspect.signature(dependencies.prepare_dependencies).parameters["runner"].default
        self.assertIs(default, run_owned_command)
        self.assertIsNot(default, subprocess.run)

    def test_clean_warm_missing_stale_and_damaged_states(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra dependency spaces ") as raw:
            fixture = DependencyFixture(Path(raw))
            self.assertEqual(inspect_dependencies(fixture.paths).status, "missing")
            fixture.install()
            self.assertEqual(inspect_dependencies(fixture.paths).status, "ready")
            hidden = json.loads((fixture.paths.node_modules / ".package-lock.json").read_text())
            hidden["version"] = "9.9.9"
            (fixture.paths.node_modules / ".package-lock.json").write_text(json.dumps(hidden))
            self.assertEqual(inspect_dependencies(fixture.paths).status, "stale")
            fixture.install()
            (fixture.paths.node_modules / "left-pad" / "package.json").unlink()
            self.assertEqual(inspect_dependencies(fixture.paths).status, "damaged")

    def test_missing_transitive_package_is_damaged_even_when_hidden_lock_matches(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra transitive damage ") as raw:
            fixture = DependencyFixture(Path(raw))
            fixture.install()
            shutil.rmtree(fixture.paths.node_modules / "transitive")
            state = inspect_dependencies(fixture.paths)
            self.assertEqual(state.status, "damaged")
            self.assertIn("node_modules/transitive", state.reason)

    def test_lock_consistency_rejects_root_dependency_or_package_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            fixture = DependencyFixture(Path(raw))
            package = json.loads(fixture.paths.package_json.read_text())
            package["dependencies"]["other"] = "1.0.0"
            fixture.paths.package_json.write_text(json.dumps(package))
            state = validate_lockfile(fixture.paths)
            self.assertEqual(state.status, "inconsistent")
            self.assertIn("direct dependencies", state.reason)

    def test_committed_dependency_change_marks_existing_install_stale(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra changed lock ") as raw:
            fixture = DependencyFixture(Path(raw))
            fixture.install()
            changed_lock = json.loads(fixture.paths.package_lock.read_text(encoding="utf-8"))
            changed_lock["packages"]["node_modules/left-pad"]["version"] = "1.3.1"
            fixture.paths.package_lock.write_text(json.dumps(changed_lock), encoding="utf-8")
            state = inspect_dependencies(fixture.paths)
            self.assertEqual(state.status, "stale")
            self.assertIn("node_modules/left-pad", state.reason)

    def test_prepare_warm_does_not_invoke_npm(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            fixture = DependencyFixture(Path(raw))
            fixture.install()
            runner = mock.Mock()
            ok, state, output = prepare_dependencies(fixture.paths, "npm", runner=runner)
            self.assertTrue(ok)
            self.assertEqual(state.status, "ready")
            self.assertEqual(output, "")
            runner.assert_not_called()

    def test_prepare_missing_uses_npm_ci_in_frontend_with_shell_false(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra npm path ") as raw:
            fixture = DependencyFixture(Path(raw))
            calls: list[tuple[list[str], dict[str, object]]] = []

            def runner(argv: list[str], **kwargs: object):
                calls.append((argv, kwargs))
                fixture.install()
                return mock.Mock(returncode=0, stdout="npm ci output")

            ok, state, output = prepare_dependencies(fixture.paths, "npm.cmd", runner=runner)
            self.assertTrue(ok)
            self.assertEqual(state.status, "ready")
            self.assertEqual(output, "npm ci output")
            self.assertEqual(calls[0][0], ["npm.cmd", "ci", "--no-audit", "--no-fund"])
            self.assertEqual(calls[0][1]["cwd"], str(fixture.paths.frontend_root))
            self.assertFalse(calls[0][1]["shell"])

    def test_prepare_converts_npm_timeout_into_actionable_dependency_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra npm timeout ") as raw:
            fixture = DependencyFixture(Path(raw))

            def timed_out(argv: list[str], **kwargs: object):
                self.assertEqual(argv[1:3], ["ci", "--no-audit"])
                self.assertEqual(kwargs["timeout"], 900.0)
                raise subprocess.TimeoutExpired(argv, 900.0, output="partial output")

            ok, state, output = prepare_dependencies(fixture.paths, "npm", runner=timed_out)
            self.assertFalse(ok)
            self.assertEqual(state.status, "missing")
            self.assertIn("npm ci timed out after 900.0 seconds", output)
            self.assertNotIn("Traceback", output)

    def test_prepare_repair_removes_only_exact_node_modules_and_reinstalls(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra repair spaces ") as raw:
            fixture = DependencyFixture(Path(raw))
            fixture.install()
            sibling = fixture.paths.frontend_root / "keep-me.txt"
            sibling.write_text("preserve", encoding="utf-8")
            observed: list[bool] = []

            def runner(_argv: list[str], **_kwargs: object):
                observed.append(not fixture.paths.node_modules.exists())
                fixture.install()
                return mock.Mock(returncode=0, stdout="repaired")

            ok, state, _ = prepare_dependencies(fixture.paths, "npm", repair=True, runner=runner)
            self.assertTrue(ok)
            self.assertEqual(state.status, "ready")
            self.assertEqual(observed, [True])
            self.assertEqual(sibling.read_text(encoding="utf-8"), "preserve")

    def test_prepare_repair_refuses_symlink_node_modules(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra symlink ") as raw:
            fixture = DependencyFixture(Path(raw))
            outside = Path(raw) / "outside"
            outside.mkdir()
            try:
                fixture.paths.node_modules.symlink_to(outside, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"directory symlinks are unavailable: {exc}")
            with self.assertRaises(OSError):
                prepare_dependencies(fixture.paths, "npm", repair=True, runner=mock.Mock())
            self.assertTrue(outside.is_dir())


if __name__ == "__main__":
    unittest.main()
