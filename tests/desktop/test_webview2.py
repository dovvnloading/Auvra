from __future__ import annotations

import gc
import io
import os
import sys
import threading
import time
import types
import unittest
import weakref
import unittest.mock as mock

from Auvra.desktop.contracts import FrameConfig, FrameMode, FrameStartupError, FrameState
from Auvra.desktop.assets import ASSET_ORIGIN, AssetResourceResponse
from Auvra.desktop.webview2 import WebView2Frame
from .fakes import EventArgs, download, message, navigation, new_window, permission, resource


class NativeBodyReaderTests(unittest.TestCase):
    """What the page sends comes through .NET, which only Windows has here."""

    def setUp(self) -> None:
        try:
            import clr  # type: ignore[import-not-found]  # noqa: F401
            from System import Array, Byte  # type: ignore[import-not-found]
            from System.IO import MemoryStream  # type: ignore[import-not-found]
        except Exception as exc:
            self.skipTest(f".NET is not available: {exc}")
        self.stream_of = lambda data: MemoryStream(Array[Byte](data))

    def test_it_hands_over_exactly_what_was_sent_a_chunk_at_a_time(self) -> None:
        sent = bytes(range(256)) * 41
        reader = WebView2Frame._NativeBodyReader(self.stream_of(sent))
        received = []
        while chunk := reader.read(4096):
            self.assertIsInstance(chunk, bytes)
            self.assertLessEqual(len(chunk), 4096)
            received.append(chunk)
        self.assertEqual(b"".join(received), sent)

    def test_it_counts_what_came_through_net_so_it_can_be_collected(self) -> None:
        reader = WebView2Frame._NativeBodyReader(self.stream_of(bytes(5000)))
        while reader.read(4096):
            pass
        self.assertEqual(reader.native_bytes, 5000)
        self.assertEqual(WebView2Frame._NativeBodyReader(io.BytesIO(b"fake")).native_bytes, 0)

    def test_a_request_that_was_answered_is_let_go(self) -> None:
        # A request holds its whole body. The callback and .NET delegate that answer it hold
        # each other, which neither runtime can collect, so the callback must not keep it.
        class Form:
            def BeginInvoke(self, action):
                action()

        class Args:
            Response = None

        class Deferral:
            def Complete(self):
                pass

        frame = WebView2Frame(FrameConfig(FrameMode.DEVELOPMENT, development_origin="http://127.0.0.1:3000"))
        frame._form = Form()
        args = Args()
        watched = weakref.ref(args)
        frame._complete_deferred_resource(args, Deferral(), AssetResourceResponse(204, "No Content", {}))
        self.assertIsNotNone(args.Response)
        del args
        gc.collect()
        self.assertIsNone(watched())
        frame._form = None
        frame.close()

    def test_a_large_file_is_not_read_a_byte_at_a_time(self) -> None:
        sent = bytes(16 * 1024 * 1024)
        reader = WebView2Frame._NativeBodyReader(self.stream_of(sent))
        started = time.perf_counter()
        total = 0
        while chunk := reader.read(1024 * 1024):
            total += len(chunk)
        self.assertEqual(total, len(sent))
        # A byte at a time this takes over 6 seconds.
        self.assertLess(time.perf_counter() - started, 2.0)


class WebView2HandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.received: list[str] = []
        self.frame = WebView2Frame(FrameConfig(FrameMode.DEVELOPMENT, development_origin="http://127.0.0.1:3000", on_message=lambda body, source: self.received.append(body)))

    def tearDown(self) -> None:
        self.frame.close()

    def test_net_is_kept_collecting_only_while_large_files_pass_through(self):
        with mock.patch("Auvra.desktop.webview2.threading.Thread") as thread:
            self.frame._keep_collecting_for(1024)
            thread.assert_not_called()
            self.frame._keep_collecting_for(64 * 1024 * 1024)
            thread.assert_called_once()
            thread.return_value.start.assert_called_once()
            first = self.frame._collect_until
            self.frame._keep_collecting_for(64 * 1024 * 1024)
            thread.assert_called_once()
            self.assertGreater(self.frame._collect_until, first)
        self.frame._collect_until = time.monotonic() - 1
        self.frame._collect_assets()
        self.assertFalse(self.frame._collecting)

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

    def test_diagnostics_envelopes_reach_the_diagnostics_lane(self):
        heartbeat = '{"protocol":"auvra.diagnostics/1","type":"heartbeat","visibility":"visible","activeCount":0}'
        self.frame._on_message(None, message("http://127.0.0.1:3000/", heartbeat))
        self.frame._on_message(None, message("https://evil.test/", heartbeat))
        self.assertEqual(self.received, [heartbeat])

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

    def _ready_frame(self) -> tuple[WebView2Frame, list[tuple[str, dict | None]], list[str]]:
        signals: list[tuple[str, dict | None]] = []
        reloads: list[str] = []
        frame = WebView2Frame(FrameConfig(FrameMode.DEVELOPMENT, development_origin="http://127.0.0.1:3000",
                                          on_lifecycle=lambda event, fields=None: signals.append((event, fields))))
        frame._state = FrameState.READY
        frame._core = types.SimpleNamespace(Reload=lambda: reloads.append("reload"))
        self.addCleanup(frame.close)
        return frame, signals, reloads

    def test_processes_the_runtime_restarts_itself_leave_the_frame_running(self):
        frame, signals, reloads = self._ready_frame()
        for kind in ("GpuProcessExited", "UtilityProcessExited", "FrameRenderProcessExited",
                     "SandboxHelperProcessExited", "UnknownProcessExited"):
            frame._on_process_failed(None, EventArgs(ProcessFailedKind=kind))
        self.assertIsNone(frame.failure)
        self.assertIs(frame.state, FrameState.READY)
        self.assertEqual(reloads, [])
        self.assertEqual([fields["reason"] for event, fields in signals if event == "process_failed"],
                         ["gpu_process_exited", "utility_process_exited", "frame_render_process_exited",
                          "sandbox_helper_process_exited", "unknown_process_exited"])

    def test_a_busy_page_is_left_to_finish(self):
        frame, signals, reloads = self._ready_frame()
        frame._on_process_failed(None, EventArgs(ProcessFailedKind="RenderProcessUnresponsive"))
        self.assertIsNone(frame.failure)
        self.assertEqual(reloads, [])
        self.assertIn(("process_failed", {"code": "renderer_unresponsive", "reason": "render_process_unresponsive"}), signals)

    def test_a_dead_page_renderer_reloads_the_page_until_it_keeps_dying(self):
        frame, signals, reloads = self._ready_frame()
        for _ in range(3):
            frame._on_process_failed(None, EventArgs(ProcessFailedKind="RenderProcessExited"))
        self.assertEqual(len(reloads), 3)
        self.assertIsNone(frame.failure)
        self.assertEqual(sum(1 for event, fields in signals if fields and fields.get("code") == "renderer_reloaded"), 3)
        frame._on_process_failed(None, EventArgs(ProcessFailedKind="RenderProcessExited"))
        self.assertEqual(len(reloads), 3)
        self.assertEqual(frame.failure.code, "renderer_process_failed")

    def test_reloads_long_ago_do_not_count_towards_the_limit(self):
        frame, _, reloads = self._ready_frame()
        with mock.patch("Auvra.desktop.webview2.time.monotonic", side_effect=[0.0, 1.0, 2.0, 400.0]):
            for _ in range(4):
                frame._on_process_failed(None, EventArgs(ProcessFailedKind="RenderProcessExited"))
        self.assertEqual(len(reloads), 4)
        self.assertIsNone(frame.failure)

    def test_numeric_kinds_and_a_dead_browser_still_close_the_frame(self):
        frame, signals, reloads = self._ready_frame()
        frame._on_process_failed(None, EventArgs(ProcessFailedKind=6))
        self.assertIsNone(frame.failure)
        self.assertEqual(signals[-1][1]["reason"], "gpu_process_exited")
        frame._on_process_failed(None, EventArgs(ProcessFailedKind="BrowserProcessExited"))
        self.assertEqual(frame.failure.code, "renderer_process_failed")
        self.assertEqual(reloads, [])

    def test_an_unreadable_failure_closes_the_frame_as_before(self):
        frame, _, _ = self._ready_frame()
        frame._on_process_failed(None, object())
        self.assertEqual(frame.failure.code, "renderer_process_failed")

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
