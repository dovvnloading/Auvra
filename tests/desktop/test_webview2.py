from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
from pathlib import Path

from Auvra.desktop.contracts import FrameConfig, FrameMode, FrameStartupError, FrameState, FrameUnavailableError
from Auvra.desktop.assets import ASSET_ORIGIN, AssetResourceResponse
from Auvra.desktop.webview2 import WebView2Frame
from .fakes import download, frame_navigation, message, navigation, new_window, permission, resource


class WebView2HandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.received: list[str] = []
        self.frame = WebView2Frame(FrameConfig(FrameMode.DEVELOPMENT, development_origin="http://127.0.0.1:3000", on_message=lambda body, source: self.received.append(body)))

    def tearDown(self) -> None:
        self.frame.close()

    def test_navigation_and_resource_handlers_cancel_external_content(self):
        allowed = navigation("http://127.0.0.1:3000/")
        denied = navigation("https://evil.test/")
        self.frame._on_navigation(None, allowed)
        self.frame._on_navigation(None, denied)
        self.assertFalse(allowed.Cancel)
        self.assertTrue(denied.Cancel)
        hmr = resource("ws://127.0.0.1:3000/@vite/client")
        external = resource("https://evil.test/app.js")
        self.frame._on_resource(None, hmr)
        self.frame._on_resource(None, external)
        self.assertFalse(hmr.Cancel)
        self.assertTrue(external.Cancel)

    def test_asset_origin_is_intercepted_and_never_widens_navigation(self):
        requests = []
        frame = WebView2Frame(
            FrameConfig(
                FrameMode.DEVELOPMENT,
                development_origin="http://127.0.0.1:3000",
                on_asset_resource=lambda request: requests.append(request) or AssetResourceResponse(
                    204, "No Content", {"Cache-Control": "no-store"}
                ),
            )
        )
        navigation_args = navigation(f"{ASSET_ORIGIN}/v1/get/token")
        frame._on_navigation(None, navigation_args)
        self.assertTrue(navigation_args.Cancel)
        asset = resource(
            f"{ASSET_ORIGIN}/v1/put/" + "a" * 43,
            method="OPTIONS",
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "PUT",
            },
        )
        frame._on_resource(None, asset)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].method, "OPTIONS")
        self.assertEqual(asset.Response.status, 204)

    def test_asset_origin_without_host_handler_is_denied(self):
        asset = resource(f"{ASSET_ORIGIN}/v1/get/" + "a" * 43)
        self.frame._on_resource(None, asset)
        self.assertTrue(asset.Cancel)

    def test_deferred_asset_request_does_not_block_webview_callback(self):
        started = threading.Event()
        release = threading.Event()

        def handle(request):
            started.set()
            if not release.wait(3):
                raise RuntimeError("test asset handler timed out")
            return AssetResourceResponse(204, "No Content", {"Cache-Control": "no-store"})

        frame = WebView2Frame(FrameConfig(
            FrameMode.DEVELOPMENT,
            development_origin="http://127.0.0.1:3000",
            on_asset_resource=handle,
        ))

        class Form:
            InvokeRequired = True

            def BeginInvoke(self, action):
                action()

        frame._state = FrameState.READY
        frame._form = Form()
        args = resource(f"{ASSET_ORIGIN}/v1/get/" + "a" * 43, deferred=True)
        fake_system = types.ModuleType("System")
        fake_system.Action = lambda callback: callback
        completed = threading.Event()
        errors: list[BaseException] = []

        def dispatch() -> None:
            try:
                frame._on_resource(None, args)
            except BaseException as exc:
                errors.append(exc)
            finally:
                completed.set()

        thread = threading.Thread(target=dispatch, name="webview-resource-nonblocking-test")
        try:
            with mock.patch.dict(sys.modules, {"System": fake_system}):
                thread.start()
                self.assertTrue(completed.wait(2), "resource callback blocked behind the asset handler")
                thread.join(timeout=2)
                self.assertEqual(errors, [])
                self.assertTrue(started.wait(1))
                self.assertIsNone(args.Response)
                self.assertFalse(args.deferral.completed.is_set())
                release.set()
                self.assertTrue(args.deferral.completed.wait(1))
            self.assertEqual(args.deferral.complete_count, 1)
            self.assertEqual(args.Response.status, 204)
        finally:
            release.set()
            thread.join(timeout=2)
            frame.close()

    def test_popup_download_permission_are_denied(self):
        popup = new_window(); self.frame._on_new_window(None, popup)
        self.assertTrue(popup.Handled); self.assertTrue(popup.Cancel)
        item = download(); self.frame._on_download(None, item); self.assertTrue(item.Cancel)
        allowed = permission(); self.frame._on_permission(None, allowed); self.assertEqual(allowed.State, 2)

    def test_message_is_origin_gated_and_json_only(self):
        self.frame._on_message(None, message("https://evil.test/", '{"secret":"x"}'))
        self.frame._on_message(None, message("http://127.0.0.1:3000/", "not-json"))
        valid = '{"protocol":"auvra.host/1","type":"request","id":"r1","session":"session-0001","revision":0,"method":"host.ping","payload":{}}'
        self.frame._on_message(None, message("http://127.0.0.1:3000/", valid))
        self.assertEqual(self.received, [valid])

    def test_native_message_cap_is_before_parse(self):
        oversized = '{' + (' ' * (256 * 1024)) + '}'
        self.frame._on_message(None, message("http://127.0.0.1:3000/", oversized))
        self.assertEqual(self.received, [])

    def test_non_windows_start_fails_without_importing_native_runtime(self):
        if os.name == "nt":
            self.skipTest("non-Windows behavior")
        with self.assertRaises(FrameStartupError):
            self.frame.start()
        self.assertEqual(self.frame.failure.code, "runtime_unavailable")

    def test_close_is_idempotent_before_start(self):
        self.frame.close(); self.frame.close()
        self.assertEqual(self.frame.state.value, "closed")

    def test_expected_browser_exit_during_close_is_not_reported_as_failure(self):
        self.frame._state = FrameState.CLOSING
        self.frame._on_browser_exited(None, object())
        self.assertIsNone(self.frame.failure)
        self.assertTrue(self.frame._browser_exited.is_set())

    def test_hung_sta_still_terminates_owned_browser_before_raising(self):
        class Form:
            def BeginInvoke(self, action):
                action()

            def Close(self):
                return None

        class HungThread:
            ManagedThreadId = 424242
            IsAlive = True

            def Join(self, _milliseconds):
                return None

        self.frame._state = FrameState.READY
        self.frame._form = Form()
        self.frame._thread = HungThread()
        self.frame._browser_process_id = 4242
        terminate = mock.patch.object(self.frame, "_terminate_owned_browser")
        fake_system = types.ModuleType("System")
        fake_system.Action = lambda callback: callback
        try:
            with terminate as kill_browser, mock.patch.dict(sys.modules, {"System": fake_system}):
                with self.assertRaises(FrameStartupError):
                    self.frame.close(timeout=0.1)
                kill_browser.assert_called_once_with()
        finally:
            self.frame._state = FrameState.CLOSED

    def test_outbound_post_requires_canonical_protocol_message(self):
        posted: list[str] = []

        class Core:
            def PostWebMessageAsJson(self, body: str) -> None:
                posted.append(body)

        class Form:
            def BeginInvoke(self, action: object) -> None:
                action()

        self.frame._state = FrameState.READY
        self.frame._core = Core()
        self.frame._form = Form()
        with self.assertRaises(ValueError):
            self.frame.post_message({"not": "an envelope"})
        envelope = {
            "protocol": "auvra.host/1", "type": "session", "session": "session-0001",
            "revision": 0, "status": "active",
        }
        fake_system = types.ModuleType("System")
        fake_system.Action = lambda callback: callback
        with mock.patch.dict(sys.modules, {"System": fake_system}):
            self.frame.post_message(envelope)
        self.assertEqual(len(posted), 1)
