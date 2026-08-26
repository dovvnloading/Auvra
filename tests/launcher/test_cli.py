from __future__ import annotations

import contextlib
import io
import inspect
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from Auvra.launcher import cli
from Auvra.launcher import diagnostics
from Auvra.launcher.config import Paths
from Auvra.launcher.dependencies import DependencyState
from Auvra.launcher.process import run_owned_command
from Auvra.launcher.readiness import ReadinessResult


class CliParserTests(unittest.TestCase):
    def test_exit_code_contract_is_stable(self) -> None:
        self.assertEqual(cli.ExitCode.OK, 0)
        self.assertEqual(cli.ExitCode.USAGE, 2)
        self.assertEqual(cli.ExitCode.RUNTIME, 10)
        self.assertEqual(cli.ExitCode.DEPENDENCIES, 11)
        self.assertEqual(cli.ExitCode.CHILD, 14)
        self.assertEqual(cli.ExitCode.CLEANUP, 15)
        self.assertEqual(getattr(cli.ExitCode, "PORT", 12), 12)
        self.assertEqual(getattr(cli.ExitCode, "READINESS", 13), 13)
        self.assertEqual(getattr(cli.ExitCode, "INTERRUPTED", 130), 130)

    def test_no_argument_and_explicit_start_are_equivalent_aliases(self) -> None:
        calls: list[tuple[Paths, int | None, bool]] = []

        def fake_start(paths: Paths, *, explicit_port: int | None, json_mode: bool) -> int:
            calls.append((paths, explicit_port, json_mode))
            return cli.ExitCode.OK

        with mock.patch.object(cli, "run_start", side_effect=fake_start):
            self.assertEqual(cli.main([]), cli.ExitCode.OK)
            self.assertEqual(cli.main(["start"]), cli.ExitCode.OK)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1:], calls[1][1:])

    def test_parser_accepts_global_and_subcommand_json(self) -> None:
        with mock.patch.object(cli, "run_doctor", return_value=cli.ExitCode.OK) as doctor:
            self.assertEqual(cli.main(["--json", "doctor"]), 0)
            self.assertTrue(doctor.call_args.kwargs["json_mode"])
        with mock.patch.object(cli, "run_doctor", return_value=cli.ExitCode.OK) as doctor:
            self.assertEqual(cli.main(["doctor", "--json"]), 0)
            self.assertTrue(doctor.call_args.kwargs["json_mode"])

    def test_prepare_interrupt_uses_the_stable_interrupt_exit_code(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), \
             mock.patch.object(cli, "run_prepare", side_effect=KeyboardInterrupt):
            self.assertEqual(cli.main(["prepare", "--json"]), cli.ExitCode.INTERRUPTED)
        self.assertIn('"interrupted":true', output.getvalue())

    def test_doctor_interrupt_is_handled_inside_shutdown_context_with_structured_output(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), \
             mock.patch.object(cli, "_shutdown_signal_handlers") as shutdown, \
             mock.patch.object(cli, "run_doctor", side_effect=KeyboardInterrupt):
            result = cli.main(["doctor", "--json"])
        self.assertEqual(result, cli.ExitCode.INTERRUPTED)
        shutdown.assert_called_once_with()
        record = json.loads(output.getvalue())
        self.assertEqual(record, {
            "command": "doctor",
            "error": "interrupted by user",
            "interrupted": True,
            "ok": False,
        })
        self.assertNotIn("TOKEN", output.getvalue().upper())

    def test_invalid_arguments_have_usage_exit_code(self) -> None:
        self.assertEqual(cli.main(["--definitely-invalid"]), cli.ExitCode.USAGE)
        self.assertEqual(cli.main(["start", "--port", "not-a-port"]), cli.ExitCode.USAGE)

    def test_supported_and_unsupported_runtime_version_parsing(self) -> None:
        self.assertEqual(diagnostics.parse_version("v22.12.0"), (22, 12, 0))
        self.assertEqual(diagnostics.parse_version("npm 11.6.2"), (11, 6, 2))
        self.assertIsNone(diagnostics.parse_version("version unknown"))
        completed = mock.Mock(returncode=0, stdout="v22.12.0\n")
        with mock.patch.object(diagnostics.shutil, "which", return_value="node.exe"):
            self.assertTrue(diagnostics.check_node(runner=mock.Mock(return_value=completed)).ok)
        completed.stdout = "v23.0.0\n"
        with mock.patch.object(diagnostics.shutil, "which", return_value="node.exe"):
            self.assertFalse(diagnostics.check_node(runner=mock.Mock(return_value=completed)).ok)

    def test_doctor_runtime_defaults_use_owned_command_runner(self) -> None:
        for function in (diagnostics.check_node, diagnostics.check_npm, diagnostics.collect_diagnostics):
            default = inspect.signature(function).parameters["runner"].default
            self.assertIs(default, run_owned_command, function.__name__)

    def test_runtime_probe_honors_owned_runner_contract_without_starting_service(self) -> None:
        calls: list[tuple[list[str], dict[str, object]]] = []

        def owned_runner(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, "v22.12.0\n", "")

        with mock.patch.object(diagnostics.shutil, "which", return_value="node.exe"):
            result = diagnostics.check_node(runner=owned_runner)
        self.assertTrue(result.ok)
        self.assertEqual(calls[0][0], ["node.exe", "--version"])
        self.assertFalse(calls[0][1]["shell"])
        self.assertTrue(calls[0][1]["check"] is False)
        self.assertTrue(calls[0][1]["text"] is True)
        self.assertEqual(calls[0][1]["encoding"], "utf-8")
        self.assertEqual(calls[0][1]["errors"], "replace")

    def test_runtime_and_dependency_failures_keep_meaningful_exit_codes(self) -> None:
        paths = Paths()
        with mock.patch.object(cli, "collect_diagnostics", return_value={
            "ok": False,
            "runtimes": [{"name": "python", "ok": False, "detail": "unsupported"}],
            "lockfile": {"status": "valid", "reason": ""},
            "dependencies": {"status": "ready", "reason": ""},
        }):
            self.assertEqual(cli.run_doctor(paths, json_mode=True), cli.ExitCode.RUNTIME)
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(False, mock.Mock(to_dict=lambda: {"status": "missing"}), "")):
            self.assertEqual(cli.run_prepare(paths, repair=False, json_mode=True), cli.ExitCode.DEPENDENCIES)

    def test_npm_timeout_result_stays_dependency_exit_code_without_traceback(self) -> None:
        paths = Paths()
        state = DependencyState("missing", "node_modules does not exist", "fixture-editor", 3)
        timeout_output = "npm ci timed out after 900.0 seconds"
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(False, state, timeout_output)), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            result = cli.run_prepare(paths, repair=False, json_mode=True)
        self.assertEqual(result, cli.ExitCode.DEPENDENCIES)
        record = json.loads(output.getvalue())
        self.assertEqual(record["dependencies"]["status"], "missing")
        self.assertIn("timed out", record["output"])
        self.assertNotIn("Traceback", output.getvalue())

        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", return_value=3010), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(False, state, timeout_output)), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            result = cli.run_start(paths, explicit_port=None, json_mode=True)
        self.assertEqual(result, cli.ExitCode.DEPENDENCIES)
        record = json.loads(output.getvalue())
        self.assertEqual(record["dependencies"]["status"], "missing")
        self.assertIn("timed out", record["output"])
        self.assertNotIn("Traceback", output.getvalue())

    def test_start_maps_port_readiness_and_child_failures_to_distinct_codes(self) -> None:
        paths = Paths()
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", side_effect=OSError("requested loopback port is already in use")):
            self.assertEqual(cli.run_start(paths, explicit_port=3000, json_mode=True), 12)
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", return_value=3010), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(True, mock.Mock(to_dict=lambda: {"status": "ready"}), "")), \
             mock.patch.object(cli.OwnedProcess, "launch", side_effect=OSError("cannot launch child")):
            self.assertEqual(cli.run_start(paths, explicit_port=None, json_mode=True), 14)

    def test_start_maps_readiness_timeout_and_child_exit_separately(self) -> None:
        paths = Paths()
        owned = mock.Mock()
        owned.is_alive.return_value = False
        timeout_result = ReadinessResult(False, "http://127.0.0.1:3011/", 2, "timed out after 0.1s")
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", return_value=3011), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(True, mock.Mock(to_dict=lambda: {"status": "ready"}), "")), \
             mock.patch.object(cli.OwnedProcess, "launch", return_value=owned), \
             mock.patch.object(cli, "wait_for_readiness", return_value=timeout_result):
            self.assertEqual(cli.run_start(paths, explicit_port=None, json_mode=True), 13)
            owned.terminate.assert_called_once()
        child_exit = ReadinessResult(False, "http://127.0.0.1:3011/", 1, "launcher child exited before readiness")
        owned = mock.Mock()
        owned.is_alive.return_value = False
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", return_value=3011), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(True, mock.Mock(to_dict=lambda: {"status": "ready"}), "")), \
             mock.patch.object(cli.OwnedProcess, "launch", return_value=owned), \
             mock.patch.object(cli, "wait_for_readiness", return_value=child_exit):
            self.assertEqual(cli.run_start(paths, explicit_port=None, json_mode=True), 14)

        owned = mock.Mock()
        owned.is_alive.return_value = False
        owned.poll.return_value = 17
        exited_ready = ReadinessResult(True, "http://127.0.0.1:3011/", 1, "HTTP 200")
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", return_value=3011), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(True, mock.Mock(to_dict=lambda: {"status": "ready"}), "")), \
             mock.patch.object(cli.OwnedProcess, "launch", return_value=owned), \
             mock.patch.object(cli, "wait_for_readiness", return_value=exited_ready):
            self.assertEqual(cli.run_start(paths, explicit_port=None, json_mode=True), 14)

    def test_start_builds_loopback_strict_port_command_from_space_safe_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra start path with spaces ") as raw:
            paths = Paths.from_repo_root(Path(raw))
            owned = mock.Mock()
            owned.is_alive.return_value = False
            owned.poll.return_value = 0
            ready = ReadinessResult(True, "http://127.0.0.1:3022/", 1, "HTTP 200")
            with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
                 mock.patch.object(cli, "choose_port", return_value=3022), \
                 mock.patch.object(cli, "_node_npm", return_value=("node with spaces", "npm with spaces")), \
                 mock.patch.object(cli, "prepare_dependencies", return_value=(True, mock.Mock(to_dict=lambda: {"status": "ready"}), "")), \
                 mock.patch.object(cli.OwnedProcess, "launch", return_value=owned) as launch, \
                 mock.patch.object(cli, "wait_for_readiness", return_value=ready):
                self.assertEqual(cli.run_start(paths, explicit_port=None, json_mode=True), cli.ExitCode.OK)
            launch.assert_called_once()
            argv, cwd = launch.call_args.args[:2]
            self.assertEqual(argv, ["node with spaces", str(paths.vite_script), "--host", "127.0.0.1", "--port", "3022", "--strictPort"])
            self.assertEqual(cwd, paths.frontend_root)

    def test_child_output_is_redacted_before_human_logging(self) -> None:
        paths = Paths()
        owned = mock.Mock()
        owned.is_alive.return_value = False

        def launch(*_args: object, **kwargs: object):
            kwargs["on_output"]("FAL_KEY=do-not-print-child")
            return owned

        output = io.StringIO()
        with contextlib.redirect_stdout(output), \
             mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", return_value=3022), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(True, mock.Mock(to_dict=lambda: {"status": "ready"}), "")), \
             mock.patch.object(cli.OwnedProcess, "launch", side_effect=launch), \
             mock.patch.object(cli, "wait_for_readiness", return_value=ReadinessResult(False, "http://127.0.0.1:3022/", 1, "child exited", "child-exited")):
            self.assertEqual(cli.run_start(paths, explicit_port=3022, json_mode=False), cli.ExitCode.CHILD)
        self.assertNotIn("do-not-print-child", output.getvalue())
        self.assertIn("[REDACTED]", output.getvalue())

    def test_start_maps_interrupt_and_cleanup_failure_codes(self) -> None:
        paths = Paths()
        owned = mock.Mock()
        owned.is_alive.return_value = False
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", return_value=3023), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(True, mock.Mock(to_dict=lambda: {"status": "ready"}), "")), \
             mock.patch.object(cli.OwnedProcess, "launch", return_value=owned), \
             mock.patch.object(cli, "wait_for_readiness", side_effect=KeyboardInterrupt):
            self.assertEqual(cli.run_start(paths, explicit_port=None, json_mode=True), 130)
        owned = mock.Mock()
        owned.is_alive.return_value = False
        owned.terminate.side_effect = cli.ProcessCleanupError("cleanup failed")
        with mock.patch.object(cli, "_runtime_ok", return_value=(True, [])), \
             mock.patch.object(cli, "choose_port", return_value=3023), \
             mock.patch.object(cli, "prepare_dependencies", return_value=(True, mock.Mock(to_dict=lambda: {"status": "ready"}), "")), \
             mock.patch.object(cli.OwnedProcess, "launch", return_value=owned), \
             mock.patch.object(cli, "wait_for_readiness", side_effect=KeyboardInterrupt):
            self.assertEqual(cli.run_start(paths, explicit_port=None, json_mode=True), 15)


class CliPolicyTests(unittest.TestCase):
    def test_explicit_port_is_strict_and_does_not_fallback(self) -> None:
        with mock.patch.object(cli, "_port_open", return_value=True) as probe:
            with self.assertRaises(OSError):
                cli.choose_port(3000)
            probe.assert_called_once_with(3000)
        with self.assertRaises(ValueError):
            cli.choose_port(0)
        with self.assertRaises(ValueError):
            cli.choose_port(65536)

    def test_auto_port_prefers_3000_then_first_free_fallback(self) -> None:
        with mock.patch.object(cli, "_port_open", side_effect=lambda port: port in {3000, 3001, 3002}) as probe:
            self.assertEqual(cli.choose_port(None), 3003)
            self.assertEqual(probe.call_args_list, [mock.call(3000), mock.call(3001), mock.call(3002), mock.call(3003)])

    def test_json_output_redacts_secret_keys_recursively(self) -> None:
        output = io.StringIO()
        data = {
            "command": "doctor", "api_key": "do-not-print",
            "api-key": "do-not-print-api-dash",
            "access_key": "do-not-print-access",
            "anon_key": "do-not-print-anon",
            "private_key": "do-not-print-private",
            "FAL_KEY": "do-not-print-fal",
            "nested": {"token": "also-secret", "ok": 1,
                       "message": "Authorization: Bearer do-not-print-too",
                       "basic": "Authorization: Basic do-not-print-basic",
                       "quoted": "client_secret='do not print quoted'",
                       "registry": "https://user:do-not-print-url@example.invalid/pkg"},
        }
        with contextlib.redirect_stdout(output):
            cli.emit(data, json_mode=True)
        parsed = json.loads(output.getvalue())
        self.assertEqual(parsed["api_key"], "[REDACTED]")
        self.assertEqual(parsed["nested"]["token"], "[REDACTED]")
        self.assertNotIn("do-not-print", output.getvalue())
        self.assertNotIn("do-not-print-too", output.getvalue())
        self.assertNotIn("do-not-print-basic", output.getvalue())
        self.assertNotIn("do not print quoted", output.getvalue())
        self.assertNotIn("do-not-print-url", output.getvalue())
        self.assertNotIn("do-not-print-api-dash", output.getvalue())
        self.assertNotIn("do-not-print-access", output.getvalue())
        self.assertNotIn("do-not-print-anon", output.getvalue())
        self.assertNotIn("do-not-print-private", output.getvalue())
        self.assertNotIn("do-not-print-fal", output.getvalue())

    def test_clean_preserves_dependencies_and_refuses_unconfirmed_dependency_delete(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra cli spaces ") as raw:
            root = Path(raw)
            paths = Paths.from_repo_root(root)
            paths.frontend_root.mkdir(parents=True)
            paths.node_modules.mkdir()
            paths.launcher_state.mkdir()
            (paths.frontend_root / "dist").mkdir()
            self.assertEqual(cli.run_clean(paths, dependencies=True, yes=False, json_mode=True), cli.ExitCode.USAGE)
            self.assertTrue(paths.node_modules.is_dir())
            self.assertTrue(paths.launcher_state.is_dir())
            self.assertTrue((paths.frontend_root / "dist").is_dir())
            self.assertEqual(cli.run_clean(paths, dependencies=False, yes=True, json_mode=True), cli.ExitCode.OK)
            self.assertTrue(paths.node_modules.is_dir())
            self.assertFalse(paths.launcher_state.exists())
            self.assertFalse((paths.frontend_root / "dist").exists())

    def test_clean_prompt_interrupt_returns_interrupt_exit_code(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra clean interrupt ") as raw:
            paths = Paths.from_repo_root(Path(raw))
            paths.frontend_root.mkdir(parents=True)
            paths.node_modules.mkdir()
            with mock.patch("builtins.input", side_effect=KeyboardInterrupt):
                self.assertEqual(
                    cli.run_clean(paths, dependencies=True, yes=False, json_mode=False),
                    cli.ExitCode.INTERRUPTED,
                )
            self.assertTrue(paths.node_modules.is_dir())

    def test_clean_refuses_symlink_targets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra clean ") as raw:
            root = Path(raw)
            paths = Paths.from_repo_root(root)
            paths.frontend_root.mkdir(parents=True)
            target = root / "outside"
            target.mkdir()
            try:
                paths.launcher_state.symlink_to(target, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"directory symlinks are unavailable: {exc}")
            self.assertEqual(cli.run_clean(paths, dependencies=False, yes=True, json_mode=True), cli.ExitCode.CLEANUP)
            self.assertTrue(paths.launcher_state.is_symlink())
            self.assertTrue(target.is_dir())


if __name__ == "__main__":
    unittest.main()
