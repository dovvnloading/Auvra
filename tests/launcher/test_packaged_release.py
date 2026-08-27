from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from Auvra.launcher import cli
from Auvra.launcher.config import Paths


def _package(base: Path, *, runtime: bool = True, native: bool = True) -> tuple[Path, Path, Path]:
    package = base / "installed package"
    frontend = package / "frontend"
    frontend.mkdir(parents=True)
    (frontend / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (package / "release-manifest.json").write_text('{"channel":"stable"}', encoding="utf-8")
    runtime_root = package / "runtime" / "webview2"
    if runtime:
        runtime_root.mkdir(parents=True)
        (runtime_root / "msedgewebview2.exe").write_bytes(b"fixed runtime")
    native_path = package / "native" / "auvra-native.exe"
    if native:
        native_path.parent.mkdir(parents=True)
        native_path.write_bytes(b"native")
    return package, frontend, native_path


class PackagedReleaseTests(unittest.TestCase):
    def test_packaged_paths_use_channel_local_appdata_state(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra installed spaces ") as raw:
            base = Path(raw)
            _, frontend, _ = _package(base)
            local = base / "Local AppData"
            with patch.dict(cli.os.environ, {"LOCALAPPDATA": str(local)}, clear=False):
                paths = Paths.from_packaged_root(frontend, "beta")
            self.assertEqual(paths.launcher_state, local / "Auvra" / "beta")
            self.assertNotEqual(paths.launcher_state.parent, frontend.parent)
            self.assertEqual(paths.repo_root, frontend.parent)

    def test_verified_release_passes_staged_sdk_runtime_native_and_skips_dev_toolchain(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra release startup spaces ") as raw:
            base = Path(raw)
            package, frontend, native = _package(base)
            sdk = object()
            fake_controller = Mock(cleanup_error=None, run=Mock(return_value=0))
            source_paths = Paths.from_repo_root(base / "checkout")
            with patch.dict(cli.os.environ, {"LOCALAPPDATA": str(base / "Local AppData")}, clear=False), \
                 patch.object(cli, "_verify_release_package", return_value={"channel": "stable"}) as verify, \
                 patch.object(cli, "load_packaged_sdk", return_value=sdk) as load_sdk, \
                 patch.object(cli.FrameController, "packaged", return_value=fake_controller) as packaged, \
                 patch.object(cli, "_runtime_ok") as runtime_ok, \
                 patch.object(cli, "prepare_dependencies") as prepare, \
                 patch.object(cli.OwnedProcess, "launch") as launch:
                result = cli.run_packaged(source_paths, packaged_root=frontend, json_mode=True)

            self.assertEqual(result, cli.ExitCode.OK)
            verify.assert_called_once_with(package.resolve())
            load_sdk.assert_called_once_with(package / "runtime" / "webview2-sdk")
            runtime_ok.assert_not_called()
            prepare.assert_not_called()
            launch.assert_not_called()
            args, kwargs = packaged.call_args
            self.assertEqual(args[1], frontend.resolve())
            self.assertEqual(kwargs["profile_parent"], base / "Local AppData" / "Auvra" / "stable")
            self.assertIs(kwargs["sdk"], sdk)
            self.assertEqual(kwargs["browser_executable_folder"], package / "runtime" / "webview2")
            self.assertEqual(kwargs["native_command"], [str(native.resolve())])
            fake_controller.start.assert_called_once()
            fake_controller.run.assert_called_once()
            fake_controller.close.assert_called_once()

    def test_verified_release_requires_fixed_runtime_and_native_payload(self) -> None:
        for runtime, native in ((False, True), (True, False)):
            with self.subTest(runtime=runtime, native=native), tempfile.TemporaryDirectory(prefix="auvra release inputs ") as raw:
                base = Path(raw)
                package, frontend, _ = _package(base, runtime=runtime, native=native)
                with patch.dict(cli.os.environ, {"LOCALAPPDATA": str(base / "Local AppData")}, clear=False), \
                     patch.object(cli, "_verify_release_package", return_value={"channel": "dev"}), \
                     patch.object(cli, "load_packaged_sdk", return_value=object()), \
                     patch.object(cli.FrameController, "packaged") as packaged:
                    result = cli.run_packaged(Paths.from_repo_root(base / "checkout"), packaged_root=frontend, json_mode=True)
                self.assertEqual(result, cli.ExitCode.DEPENDENCIES)
                packaged.assert_not_called()
                self.assertTrue((package / "release-manifest.json").is_file())

    def test_start_wrapper_uses_release_local_diagnostics_state(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra release diagnostics ") as raw:
            base = Path(raw)
            _, frontend, _ = _package(base)
            source_paths = Paths.from_repo_root(base / "checkout")
            local = base / "Local AppData"
            with patch.dict(cli.os.environ, {"LOCALAPPDATA": str(local)}, clear=False), \
                 patch.object(cli, "_run_start", return_value=cli.ExitCode.OK), \
                 patch.object(cli, "begin_diagnostics_run") as begin, \
                 patch.object(cli, "finish_diagnostics_run") as finish:
                result = cli.run_start(source_paths, explicit_port=None, json_mode=True, packaged_root=frontend)
            self.assertEqual(result, cli.ExitCode.OK)
            expected = begin.call_args.args[0]
            self.assertEqual(expected.launcher_state, local / "Auvra" / "stable")
            begin.assert_called_once_with(expected)
            finish.assert_called_once_with(expected)


if __name__ == "__main__":
    unittest.main()
