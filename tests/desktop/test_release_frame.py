from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import Auvra.desktop.contracts as contracts
import Auvra.desktop.controller as controller_module
from Auvra.desktop.contracts import FrameConfig, FrameConfigurationError, FrameMode, FrameState
from Auvra.desktop.controller import FrameController
from Auvra.desktop.webview2 import WebView2Frame


class FakeFrame:
    def __init__(self, config: FrameConfig) -> None:
        self.config = config
        self.policy = Mock(allow_message=Mock(return_value=True))
        self.state = FrameState.NEW
        self.closed = 0

    def start(self) -> None:
        self.state = FrameState.READY

    def close(self) -> None:
        self.closed += 1
        self.state = FrameState.CLOSED

    def post_message(self, body: str) -> None:
        return None


def _packaged_root(base: Path) -> Path:
    root = base / "dist"
    root.mkdir()
    (root / "index.html").write_text("<!doctype html>", encoding="utf-8")
    return root


class ReleaseFrameTests(unittest.TestCase):
    def test_fixed_runtime_validation_is_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra release spaces ") as raw:
            base = Path(raw)
            root = _packaged_root(base)
            runtime = base / "runtime"
            with patch.object(contracts, "_REPO_FRONTEND_DIST", root):
                with self.assertRaises(FrameConfigurationError):
                    FrameConfig(FrameMode.PACKAGED, packaged_root=root, browser_executable_folder=runtime)

                runtime.mkdir()
                with self.assertRaisesRegex(FrameConfigurationError, "incomplete"):
                    FrameConfig(FrameMode.PACKAGED, packaged_root=root, browser_executable_folder=runtime)

                (runtime / "msedgewebview2.exe").write_bytes(b"runtime")
                valid = FrameConfig(FrameMode.PACKAGED, packaged_root=root, browser_executable_folder=runtime)
                self.assertEqual(valid.browser_executable_folder, runtime.resolve())

                linked = base / "runtime-link"
                try:
                    os.symlink(runtime, linked, target_is_directory=True)
                except (OSError, NotImplementedError):
                    self.skipTest("symbolic links are unavailable")
                with self.assertRaisesRegex(FrameConfigurationError, "links"):
                    FrameConfig(FrameMode.PACKAGED, packaged_root=root, browser_executable_folder=linked)

    def test_packaged_real_frame_requires_verified_inputs_without_network_acquisition(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra packaged spaces ") as raw:
            base = Path(raw)
            root = _packaged_root(base)
            profile_parent = base / "profile parent"
            profile_parent.mkdir()
            process = Mock(is_alive=Mock(return_value=True))
            with patch.object(contracts, "_REPO_FRONTEND_DIST", root), \
                 patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {profile_parent}), \
                 patch.object(controller_module, "acquire_sdk") as acquire:
                with self.assertRaisesRegex(FrameConfigurationError, "verified WebView2 SDK"):
                    FrameController.packaged(process, root, profile_parent=profile_parent)
                acquire.assert_not_called()
            self.assertEqual(list(profile_parent.glob("webview2-*")), [])

    def test_packaged_channel_uses_exact_local_appdata_profile_boundary(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra release local state ") as raw:
            local = Path(raw) / "Local AppData"
            allowed = local / "Auvra" / "beta"
            with patch.dict(os.environ, {"LOCALAPPDATA": str(local)}, clear=False):
                self.assertTrue(contracts._profile_parent_is_allowed(allowed))
                self.assertFalse(contracts._profile_parent_is_allowed(local / "Auvra" / "preview"))
                self.assertFalse(contracts._profile_parent_is_allowed(local / "Another Product" / "beta"))

    def test_packaged_native_start_binds_and_cleans_exactly_with_spaces(self) -> None:
        class FakeNativeEngine:
            def __init__(self, command: tuple[str, ...]) -> None:
                self.command = command

        class FakeNativeHost:
            instances: list["FakeNativeHost"] = []

            def __init__(self, engine: FakeNativeEngine) -> None:
                self.engine = engine
                self.started: list[str] = []
                self.closed = 0
                self.__class__.instances.append(self)

            def start(self, *, editor_session: str) -> None:
                self.started.append(editor_session)

            def close(self, *, timeout: float | None = None) -> None:
                self.closed += 1

            def drain_events(self) -> list[tuple[str, dict[str, object]]]:
                return []

        with tempfile.TemporaryDirectory(prefix="auvra packaged spaces ") as raw:
            base = Path(raw)
            root = _packaged_root(base)
            profile_parent = base / "profile parent with spaces"
            profile_parent.mkdir()
            process = Mock(is_alive=Mock(return_value=True))
            command = [str(base / "native engine.exe"), "--profile", "space safe"]
            with patch.object(contracts, "_REPO_FRONTEND_DIST", root), \
                 patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {profile_parent}), \
                 patch.object(controller_module, "NativeEngine", FakeNativeEngine), \
                 patch.object(controller_module, "NativeEngineHost", FakeNativeHost):
                controller = FrameController.packaged(
                    process, root, profile_parent=profile_parent,
                    native_command=command, frame_factory=FakeFrame,
                )
                owner = FakeNativeHost.instances[-1]
                self.assertEqual(owner.engine.command, tuple(command))
                self.assertEqual(owner.started, [controller.dispatcher.session.session_id])
                self.assertIs(controller.dispatcher._engine_service, owner)
                profile = controller.profile_path
                controller.start()
                controller.close()
                controller.close()
                self.assertEqual(owner.closed, 1)
                self.assertEqual(controller.frame.closed, 1)
                process.terminate.assert_called_once()
                self.assertIsNotNone(profile)
                self.assertFalse(profile.exists())

    def test_packaged_native_start_failure_uses_web_fallback_and_cleans(self) -> None:
        class FailingNativeEngine:
            def __init__(self, command: tuple[str, ...]) -> None:
                self.command = command

        class FailingNativeHost:
            instances: list["FailingNativeHost"] = []

            def __init__(self, engine: FailingNativeEngine) -> None:
                self.engine = engine
                self.closed = 0
                self.__class__.instances.append(self)

            def start(self, *, editor_session: str) -> None:
                raise controller_module.NativeEngineError("native startup failed")

            def close(self, *, timeout: float | None = None) -> None:
                self.closed += 1

        with tempfile.TemporaryDirectory(prefix="auvra packaged fallback spaces ") as raw:
            base = Path(raw)
            root = _packaged_root(base)
            profile_parent = base / "profile parent"
            profile_parent.mkdir()
            process = Mock(is_alive=Mock(return_value=True))
            with patch.object(contracts, "_REPO_FRONTEND_DIST", root), \
                 patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {profile_parent}), \
                 patch.object(controller_module, "NativeEngine", FailingNativeEngine), \
                 patch.object(controller_module, "NativeEngineHost", FailingNativeHost):
                controller = FrameController.packaged(
                    process, root, profile_parent=profile_parent,
                    native_command=[str(base / "native engine.exe")], frame_factory=FakeFrame,
                )
                owner = FailingNativeHost.instances[-1]
                fallback = controller.dispatcher._engine_service
                self.assertIsInstance(fallback, controller_module.NativeEngineUnavailableHost)
                controller.start()
                controller.close()
                self.assertEqual(owner.closed, 1)
                self.assertFalse(list(profile_parent.glob("webview2-*")))
                process.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
