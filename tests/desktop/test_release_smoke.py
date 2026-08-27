"""Opt-in smoke test for an assembled Windows release package.

Normal discovery skips this test.  An enabled run is intentionally strict:
missing package inputs and any startup/cleanup failure are test failures.
"""

from __future__ import annotations

import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from Auvra.desktop import contracts as desktop_contracts
from Auvra.desktop.controller import FrameController
from Auvra.desktop.native_engine import NativeEngineHost, NativeEngineState
from Auvra.desktop.sdk import load_packaged_sdk
from Auvra.launcher.config import Paths
from release.runtime_verify import verify_installed_package


class _OwnedProcess:
    """Minimal packaged owner; packaged startup has no Vite child."""

    def __init__(self) -> None:
        self._alive = True
        self.terminate_calls = 0

    def is_alive(self) -> bool:
        return self._alive

    def poll(self) -> int | None:
        return None if self._alive else 0

    def terminate(self) -> None:
        self.terminate_calls += 1
        self._alive = False


def _read_source(frame: object) -> str:
    """Read the WebView2 source through its STA UI queue."""
    from System import Action  # type: ignore[import-not-found]

    done = threading.Event()
    values: list[str] = []
    errors: list[BaseException] = []

    def invoke() -> None:
        try:
            values.append(str(frame._core.Source))  # type: ignore[attr-defined]
        except BaseException as exc:
            errors.append(exc)
        finally:
            done.set()

    action = Action(invoke)
    with frame._lock:  # type: ignore[attr-defined]
        frame._pending_actions.append(action)  # type: ignore[attr-defined]
    frame._form.BeginInvoke(action)  # type: ignore[attr-defined]
    if not done.wait(5.0):
        raise AssertionError("timed out reading the WebView2 source")
    if errors:
        raise errors[0]
    return values[0]


class ReleaseSmokeTests(unittest.TestCase):
    def test_verified_packaged_frame_starts_hidden_and_cleans_owned_resources(self) -> None:
        if os.name != "nt" or os.environ.get("AUVRA_RELEASE_SMOKE") != "1":
            self.skipTest("set AUVRA_RELEASE_SMOKE=1 on Windows to enable the release smoke")
        raw_package = os.environ.get("AUVRA_RELEASE_PACKAGE_ROOT")
        if not raw_package:
            self.fail("AUVRA_RELEASE_PACKAGE_ROOT is required when release smoke is enabled")
        package = Path(raw_package).expanduser().absolute()
        if not package.is_dir() or package.is_symlink():
            self.fail("AUVRA_RELEASE_PACKAGE_ROOT must name an assembled package directory")

        try:
            manifest = verify_installed_package(package)
        except Exception as exc:
            self.fail(f"assembled release verification failed: {exc}")
        channel = manifest.get("channel")
        if not isinstance(channel, str):
            self.fail("verified release manifest has no channel")
        frontend = package / "frontend"
        with tempfile.TemporaryDirectory(prefix="auvra release smoke localappdata ") as local_raw:
            local_app_data = Path(local_raw)
            with patch.dict(os.environ, {"LOCALAPPDATA": str(local_app_data)}, clear=False), \
                 patch.object(desktop_contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {local_app_data / "Auvra" / channel}):
                paths = Paths.from_packaged_root(frontend, channel)
                sdk = load_packaged_sdk(paths.packaged_webview2_sdk)
                runtime = paths.packaged_webview2_runtime
                native = paths.packaged_native
                self.assertTrue(runtime.is_dir(), "fixed WebView2 runtime directory is missing")
                self.assertFalse(runtime.is_symlink(), "fixed WebView2 runtime directory is linked")
                self.assertTrue((runtime / "msedgewebview2.exe").is_file(), "fixed WebView2 runtime executable is missing")
                self.assertTrue(native.is_file(), "packaged native executable is missing")
                self.assertFalse(native.is_symlink(), "packaged native executable is linked")

                owner = _OwnedProcess()
                controller: FrameController | None = None
                try:
                    controller = FrameController.packaged(
                        owner,
                        frontend,
                        profile_parent=paths.launcher_state,
                        native_command=[str(native.resolve())],
                        sdk=sdk,
                        browser_executable_folder=runtime,
                    )
                    # The production frame starts with the form hidden; keep
                    # this assertion explicit without changing production code.
                    object.__setattr__(controller.frame.config, "visible", False)
                    controller.start()
                    self.assertEqual(controller.frame.state.value, "ready")
                    self.assertTrue(_read_source(controller.frame).startswith("https://app.auvra.local/"))
                    self.assertIsInstance(controller.native_engine_host, NativeEngineHost)
                    self.assertIs(controller.dispatcher._engine_service, controller.native_engine_host)
                    self.assertEqual(controller.native_engine_host.engine.state, NativeEngineState.READY)
                    self.assertIsNotNone(controller.native_engine_host.engine.status.pid)
                finally:
                    if controller is not None:
                        controller.close()
                    self.assertFalse(owner.is_alive(), "packaged owner survived cleanup")
                    self.assertEqual(owner.terminate_calls, 1)
                    if controller is not None and controller.profile_path is not None:
                        self.assertFalse(controller.profile_path.exists(), "WebView2 profile survived cleanup")


if __name__ == "__main__":
    unittest.main()
