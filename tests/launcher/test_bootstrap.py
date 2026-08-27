from __future__ import annotations

import io
import importlib.util
import importlib
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

from Auvra.launcher import bootstrap as module


class FakeRunner:
    def __init__(self, root: Path, *, uv_version: str = "0.12.5", module_version: str | None = None) -> None:
        self.root = root
        self.uv_version = uv_version
        self.module_version = module_version
        self.installed = False
        self.fail_sync = False
        self.calls: list[dict[str, object]] = []

    def __call__(self, argv, **kwargs):
        command = [str(item) for item in argv]
        self.calls.append({"argv": command, **kwargs})
        if "-c" in command:
            environment = Path(command[0]).parents[1]
            return subprocess.CompletedProcess(command, 0, json.dumps({
                "implementation": "cpython", "version": [3, 14],
                "prefix": str(environment), "base_prefix": str(self.root),
                "executable": command[0],
            }) + "\n", "")
        if command[-1:] == ["--version"]:
            if "-m" in command and "uv" in command:
                version = self.module_version or self.uv_version
            elif self.installed:
                version = "0.12.5"
            else:
                version = self.uv_version
            return subprocess.CompletedProcess(command, 0, f"uv {version}\n", "")
        if "-m" in command and "venv" in command:
            environment = Path(command[-1])
            python = environment / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_text("python", encoding="ascii")
            (environment / "pyvenv.cfg").write_text("home = C:\\Python314\n", encoding="ascii")
            return subprocess.CompletedProcess(command, 0, "", "")
        if "pip" in command and "install" in command:
            environment = Path(command[0]).parents[1]
            uv = environment / ("Scripts" if os.name == "nt" else "bin") / ("uv.exe" if os.name == "nt" else "uv")
            uv.write_text("uv", encoding="ascii")
            self.installed = True
            return subprocess.CompletedProcess(command, 0, "", "")
        if "sync" in command:
            if self.fail_sync:
                return subprocess.CompletedProcess(command, 1, "sync interrupted\n", "")
            target = Path(str(kwargs["env"]["UV_PROJECT_ENVIRONMENT"]))
            python = target / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")
            if "--check" not in command:
                python.parent.mkdir(parents=True, exist_ok=True)
                python.write_text("python", encoding="ascii")
                (target / "pyvenv.cfg").write_text("home = C:\\Python314\n", encoding="ascii")
            return subprocess.CompletedProcess(command, 0, "", "")
        return subprocess.CompletedProcess(command, 0, "", "")


def make_paths(root: Path) -> module.BootstrapPaths:
    repo = root / "repo with spaces"
    frontend = repo / "fbx-viewer (1)"
    frontend.mkdir(parents=True)
    entry = repo / "Auvra" / "Auvra.py"
    entry.parent.mkdir()
    entry.write_text("", encoding="ascii")
    return module.BootstrapPaths(repo, entry, frontend / ".auvra-launcher", frontend / ".auvra-launcher" / "bootstrap-venv", repo / ".venv", frontend / ".auvra-launcher" / "bootstrap.lock")


class BootstrapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.paths = make_paths(Path(self.temp.name))
        self.old_marker = os.environ.pop(module.BOOTSTRAP_MARKER, None)

    def tearDown(self) -> None:
        if self.old_marker is None:
            os.environ.pop(module.BOOTSTRAP_MARKER, None)
        else:
            os.environ[module.BOOTSTRAP_MARKER] = self.old_marker
        self.temp.cleanup()

    def test_unmarked_existing_environment_uses_nonmutating_check_only(self):
        environment = self.paths.target_env
        interpreter = environment / "Scripts" / "python.exe"
        interpreter.parent.mkdir(parents=True)
        interpreter.write_text("python", encoding="ascii")
        (environment / "pyvenv.cfg").write_text("home = C:\\Python314\n", encoding="ascii")
        runner = FakeRunner(self.paths.repo_root)
        with patch.object(module.shutil, "which", return_value="C:\\uv.exe"):
            managed = module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        self.assertEqual(managed, interpreter)
        sync_calls = [call["argv"] for call in runner.calls if "sync" in call["argv"]]
        self.assertEqual(len(sync_calls), 1)
        self.assertIn("--check", sync_calls[0])
        self.assertEqual(sync_calls[0][sync_calls[0].index("--python") + 1], str(interpreter))
        self.assertTrue((environment / module.OWNERSHIP_MARKER_NAME).is_file())

    def test_interrupted_new_environment_retains_recoverable_initializing_marker(self):
        runner = FakeRunner(self.paths.repo_root)
        runner.fail_sync = True
        with patch.object(module.shutil, "which", return_value="C:\\uv.exe"):
            with self.assertRaises(module.BootstrapError):
                module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        self.assertTrue((self.paths.target_env / module.INITIALIZING_MARKER_NAME).is_file())
        self.assertFalse((self.paths.target_env / module.OWNERSHIP_MARKER_NAME).exists())
        runner.fail_sync = False
        with patch.object(module.shutil, "which", return_value="C:\\uv.exe"):
            module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        self.assertTrue((self.paths.target_env / module.OWNERSHIP_MARKER_NAME).is_file())
        self.assertFalse((self.paths.target_env / module.INITIALIZING_MARKER_NAME).exists())

    def test_marked_environment_sync_binds_to_verified_target_interpreter(self):
        runner = FakeRunner(self.paths.repo_root)
        with patch.object(module.shutil, "which", return_value="C:\\uv.exe"):
            module.bootstrap(paths=self.paths, runner=runner, reexec=False)
            before = len(runner.calls)
            module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        sync = [call["argv"] for call in runner.calls[before:] if "sync" in call["argv"]]
        self.assertEqual(len(sync), 1)
        self.assertEqual(sync[0][-1], str(module._managed_python(self.paths.target_env)))

    def test_completed_marker_recovers_if_crash_left_initializing_marker(self):
        runner = FakeRunner(self.paths.repo_root)
        with patch.object(module.shutil, "which", return_value="C:\\uv.exe"):
            managed = module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        module._write_initializing_marker(self.paths, interpreter=sys.executable)
        with patch.object(module.shutil, "which", return_value="C:\\uv.exe"):
            recovered = module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        self.assertEqual(recovered, managed)
        self.assertTrue((self.paths.target_env / module.OWNERSHIP_MARKER_NAME).is_file())
        self.assertFalse((self.paths.target_env / module.INITIALIZING_MARKER_NAME).exists())

    def test_warm_exact_uv_syncs_locked_environment_and_supports_spaces(self):
        runner = FakeRunner(self.paths.repo_root)
        with patch.object(module.shutil, "which", return_value=None):
            managed = module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        self.assertEqual(managed, module._managed_python(self.paths.target_env))
        sync = next(call for call in runner.calls if "sync" in call["argv"])
        self.assertEqual(sync["cwd"], str(self.paths.repo_root))
        self.assertEqual(sync["argv"][-6:], ["sync", "--locked", "--no-install-project", "--no-dev", "--python", sys.executable])
        self.assertEqual(sync["env"]["UV_PROJECT_ENVIRONMENT"], str(self.paths.target_env))

    def test_path_uv_is_never_trusted_and_exact_module_is_used(self):
        runner = FakeRunner(self.paths.repo_root, uv_version="0.12.4", module_version="0.12.5")
        with patch.object(module.shutil, "which", return_value="C:\\wrong\\uv.exe"):
            module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        probes = [call["argv"] for call in runner.calls if call["argv"][-1:] == ["--version"]]
        self.assertNotIn(["C:\\wrong\\uv.exe", "--version"], probes)
        self.assertIn([sys.executable, "-E", "-s", "-m", "uv", "--version"], probes)

    def test_missing_uv_uses_noninteractive_binary_only_no_deps_install(self):
        runner = FakeRunner(self.paths.repo_root, uv_version="0.0.0")
        with patch.object(module.shutil, "which", return_value=None):
            module.bootstrap(paths=self.paths, runner=runner, reexec=False)
        pip = next(call["argv"] for call in runner.calls if "pip" in call["argv"] and "install" in call["argv"])
        self.assertIn("--no-input", pip)
        self.assertIn("--only-binary=:all:", pip)
        self.assertIn("--no-deps", pip)
        self.assertIn("uv==0.12.5", pip)

    def test_reexec_preserves_arguments_and_sets_exact_loop_marker(self):
        runner = FakeRunner(self.paths.repo_root)
        interpreter = str(self.paths.target_env / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python"))
        expected_argv = [interpreter, "-E", "-s", str(self.paths.entrypoint), "start", "--port", "3010"]
        with patch.object(module.shutil, "which", return_value=None), patch.object(
            module.sys, "argv", [str(self.paths.entrypoint), "start", "--port", "3010"]
        ):
            if os.name == "nt":
                owned = Mock()
                owned.wait.return_value = 17
                with patch.object(module.OwnedProcess, "launch", return_value=owned) as launch:
                    with self.assertRaises(SystemExit) as raised:
                        module.bootstrap(paths=self.paths, runner=runner, reexec=True)
                self.assertEqual(raised.exception.code, 17)
                self.assertEqual(launch.call_args.args[:2], (expected_argv, self.paths.repo_root))
                self.assertEqual(launch.call_args.kwargs["env"][module.BOOTSTRAP_MARKER], interpreter)
                owned.terminate.assert_called_once_with()
            else:
                with patch.object(module.os, "execve", side_effect=SystemExit) as execve:
                    with self.assertRaises(SystemExit):
                        module.bootstrap(paths=self.paths, runner=runner, reexec=True)
                execve.assert_called_once()
                self.assertEqual(execve.call_args.args[0], interpreter)
                self.assertEqual(execve.call_args.args[1], expected_argv)
                self.assertEqual(execve.call_args.args[2][module.BOOTSTRAP_MARKER], interpreter)

    def test_loop_marker_must_match_target_interpreter(self):
        target = self.paths.target_env / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")
        target.parent.mkdir(parents=True)
        target.write_text("python", encoding="ascii")
        (self.paths.target_env / "pyvenv.cfg").write_text("home = C:\\Python314\n", encoding="ascii")
        os.environ[module.BOOTSTRAP_MARKER] = str(self.paths.repo_root / "other-python")
        with self.assertRaisesRegex(module.BootstrapError, "loop marker"):
            module.bootstrap(paths=self.paths, runner=FakeRunner(self.paths.repo_root), reexec=False)

    def test_lock_timeout_and_stale_lock_handling(self):
        module._mkdir_safe(self.paths.state_root)
        self.paths.lock_path.write_text("pid=999999\ntoken=deadbeefdeadbeef\n", encoding="ascii")
        old = time.time() - module.LOCK_STALE_SECONDS - 1
        os.utime(self.paths.lock_path, (old, old))
        with module._lock(self.paths, clock=lambda: 0.0, sleeper=lambda _: None):
            self.assertTrue(self.paths.lock_path.exists())
        self.paths.lock_path.write_text(f"pid={os.getpid()}\ntoken=livebeeflivebeef\n", encoding="ascii")
        now = [0.0]
        with self.assertRaisesRegex(module.BootstrapError, "timed out"):
            with module._lock(self.paths, clock=lambda: now[0], sleeper=lambda _: now.__setitem__(0, now[0] + 121)):
                pass

    def test_linked_state_and_managed_trees_are_refused(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks unavailable")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        for candidate in (self.paths.state_root, self.paths.bootstrap_env, self.paths.target_env):
            candidate.parent.mkdir(parents=True, exist_ok=True)
            try:
                candidate.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            with self.assertRaises(module.BootstrapError):
                module.bootstrap(paths=self.paths, runner=FakeRunner(self.paths.repo_root), reexec=False)
            candidate.unlink()

    def test_output_is_redacted_and_bounded(self):
        result = subprocess.CompletedProcess(["uv"], 1, "TOKEN=super-secret " + "x" * 20000, "")
        with self.assertRaises(module.BootstrapError) as raised:
            module._run(["uv"], cwd=self.paths.repo_root, runner=lambda *args, **kwargs: result)
        message = str(raised.exception)
        self.assertNotIn("super-secret", message)
        self.assertLess(len(message), module.MAX_OUTPUT_BYTES + 128)

    def test_redaction_covers_quoted_json_keys_bearer_and_url_credentials(self):
        text = module._redact_output(
            '{"apiKey": "json-secret", "Authorization": "Bearer bearer-secret", '
            '"url": "https://user:password@example.test/path"}'
        )
        for secret in ("json-secret", "bearer-secret", "password"):
            self.assertNotIn(secret, text)

    def test_live_owner_is_never_stale_even_when_old(self):
        module._mkdir_safe(self.paths.state_root)
        self.paths.lock_path.write_text(
            f"pid={os.getpid()}\ntoken=livebeeflivebeef\n", encoding="ascii"
        )
        old = time.time() - module.LOCK_STALE_SECONDS - 1
        os.utime(self.paths.lock_path, (old, old))
        now = [0.0]
        with self.assertRaisesRegex(module.BootstrapError, "timed out"):
            with module._lock(self.paths, clock=lambda: now[0], sleeper=lambda _: now.__setitem__(0, 121)):
                pass

    def test_entrypoint_does_not_import_cli_until_bootstrap_returns(self):
        source = Path(__file__).parents[2] / "Auvra" / "Auvra.py"
        text = source.read_text(encoding="utf-8")
        self.assertNotIn("from Auvra.launcher.cli import", text.split("def main", 1)[0])

        spec = importlib.util.spec_from_file_location("auvra_test_entrypoint", source)
        self.assertIsNotNone(spec)
        loaded = importlib.util.module_from_spec(spec)
        with patch.object(sys, "path", [str(source.parent), *sys.path]):
            assert spec.loader is not None
            spec.loader.exec_module(loaded)
        cli = types.ModuleType("Auvra.launcher.cli")
        cli.main = lambda: self.fail("Auvra.launcher.cli imported after bootstrap failure")
        with patch.dict(sys.modules, {"Auvra.launcher.cli": cli}), patch.object(
            loaded, "bootstrap", side_effect=loaded.BootstrapError("injected failure")
        ):
            self.assertEqual(loaded.main(), module.BOOTSTRAP_EXIT_CODE)

        with patch.dict(sys.modules, {"Auvra.launcher.cli": cli}), patch.object(
            loaded, "bootstrap", side_effect=KeyboardInterrupt
        ), patch("sys.stderr", new_callable=io.StringIO) as stderr:
            self.assertEqual(loaded.main(), 130)
            self.assertIn("bootstrap interrupted", stderr.getvalue().lower())
            self.assertNotIn("traceback", stderr.getvalue().lower())



if __name__ == "__main__":
    unittest.main()
