from __future__ import annotations

import json
import importlib
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import Auvra.desktop.contracts as contracts
from Auvra.diagnostics.core import DiagnosticsSession, install_diagnostics
from Auvra.desktop.controller import FrameController, FrameProcessExitedError
from Auvra.desktop.contracts import FrameConfig, FrameConfigurationError, FrameFailure, FrameMode, FrameStartupError, FrameState
from Auvra.desktop.policy import FramePolicy


controller_module = importlib.import_module("Auvra.desktop.controller")


class FakeFrame:
    def __init__(self, config: FrameConfig) -> None:
        self.config = config
        self.policy = FramePolicy(config.mode, config.trusted_origin)
        self.state = FrameState.NEW
        self.posts: list[str] = []
        self.started = False
        self.closed = 0

    def start(self) -> None:
        self.started = True
        self.state = FrameState.READY

    def post_message(self, body: str) -> None:
        if self.state is not FrameState.READY:
            from Auvra.desktop.contracts import FrameClosedError
            raise FrameClosedError("closed")
        self.posts.append(body)

    def close(self) -> None:
        self.closed += 1
        self.state = FrameState.CLOSED


class ControllerTests(unittest.TestCase):
    def tearDown(self) -> None:
        install_diagnostics(None)

    def test_development_allows_cold_vite_navigation_to_finish(self):
        process = Mock(is_alive=Mock(return_value=True))
        with tempfile.TemporaryDirectory() as temp, patch.object(
            contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}
        ):
            controller = FrameController.development(
                process,
                "http://127.0.0.1:3099",
                profile_parent=Path(temp),
                frame_factory=FakeFrame,
            )
            try:
                self.assertEqual(controller.frame.config.startup_timeout, 45.0)
            finally:
                controller.close()

    def test_webview_lifecycle_and_rejections_feed_the_process_session(self):
        with tempfile.TemporaryDirectory(prefix="auvra controller diagnostics ") as raw:
            session = DiagnosticsSession(Path(raw) / "diagnostics", run_id="run-frame", mode="test")
            session.start()
            install_diagnostics(session)
            process = Mock(is_alive=Mock(return_value=True))
            frame = FakeFrame(FrameConfig(
                FrameMode.DEVELOPMENT,
                development_origin="http://127.0.0.1:3099",
            ))
            controller = FrameController(process, frame=frame)
            controller.on_lifecycle("initialization_completed", {"success": True})
            controller.on_lifecycle("message_rejected", {"code": "invalid_message"})
            controller.on_lifecycle("process_failed", {"code": "renderer_process_failed"})
            controller.close()
            records = session.snapshot()
            self.assertTrue(any(record["event"] == "webview.lifecycle"
                                and record.get("attributes", {}).get("state") == "initialization_completed"
                                for record in records))
            self.assertTrue(any(record["event"] == "webview.message_rejected" for record in records))
            self.assertTrue(any(record["event"] == "webview.process_failed" for record in records))
            session.close(outcome="failure")

    def test_development_binds_supplied_native_owner_and_closes_it_once(self):
        class FakeNativeEngine:
            def __init__(self, command):
                self.command = command

        class FakeNativeHost:
            instances = []

            def __init__(self, engine):
                self.engine = engine
                self.starts = []
                self.closes = 0
                self.__class__.instances.append(self)

            def start(self, *, editor_session):
                self.starts.append(editor_session)

            def close(self, *, timeout=None):
                self.closes += 1

            def drain_events(self):
                return []

        process = Mock(is_alive=Mock(return_value=True))
        command = ["C:\\owned\\auvra-native.exe", "--profile", "test"]
        with tempfile.TemporaryDirectory() as temp, patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}), \
             patch.object(controller_module, "NativeEngine", FakeNativeEngine), \
             patch.object(controller_module, "NativeEngineHost", FakeNativeHost):
            controller = FrameController.development(
                process, "http://127.0.0.1:3099/", profile_parent=Path(temp),
                native_command=command, frame_factory=FakeFrame,
            )
            owner = FakeNativeHost.instances[-1]
            self.assertEqual(owner.engine.command, tuple(command))
            self.assertEqual(owner.starts, [controller.dispatcher.session.session_id])
            self.assertIs(controller.dispatcher._engine_service, owner)
            controller.close()
            controller.close()
            self.assertEqual(owner.closes, 1)

    def test_native_owner_is_closed_when_frame_start_fails(self):
        class FailingFrame(FakeFrame):
            def start(self):
                raise FrameStartupError("frame startup failed")

        class FakeNativeHost:
            def __init__(self):
                self.closes = 0

            def close(self, *, timeout=None):
                self.closes += 1

        process = Mock(is_alive=Mock(return_value=True))
        owner = FakeNativeHost()
        with patch.object(controller_module, "NativeEngineHost", FakeNativeHost):
            controller = FrameController(
                process,
                frame=FailingFrame(FrameConfig(
                    FrameMode.DEVELOPMENT,
                    development_origin="http://127.0.0.1:3099",
                )),
                native_engine_host=owner,
            )
            with self.assertRaisesRegex(FrameStartupError, "frame startup failed"):
                controller.start()
            self.assertEqual(owner.closes, 1)

    def test_dispatches_only_exact_source_and_posts_validated_response(self):
        process = Mock(is_alive=Mock(return_value=True))
        with tempfile.TemporaryDirectory() as temp, patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}):
            controller = FrameController.development(process, "http://127.0.0.1:3099/", profile_parent=Path(temp), frame_factory=FakeFrame)
            controller.start()
            valid = {"protocol": "auvra.host/1", "type": "request", "id": "r1", "session": controller.dispatcher.session.session_id, "revision": 0, "method": "host.ping", "payload": {}}
            controller.on_message(json.dumps(valid), "http://127.0.0.1:3099/")
            controller.on_message(json.dumps(valid), "http://evil.test/")
            self.assertTrue(controller.wait_for_host_idle())
            self.assertEqual(len(controller.frame.posts), 1)
            self.assertTrue(json.loads(controller.frame.posts[0])["ok"])
            controller.close()
            process.terminate.assert_called_once()
            self.assertFalse(list(Path(temp).glob("webview2-*")))

    def test_reload_sends_session_and_close_is_idempotent(self):
        process = Mock(is_alive=Mock(return_value=True))
        with tempfile.TemporaryDirectory() as temp, patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}):
            controller = FrameController.development(process, "http://127.0.0.1:3099", profile_parent=Path(temp), frame_factory=FakeFrame)
            controller.start()
            controller.on_lifecycle("ready", {"origin": "http://127.0.0.1:3099"})
            self.assertEqual(controller.frame.posts, [])
            controller.on_lifecycle("navigation_completed", {"success": True})
            self.assertEqual(json.loads(controller.frame.posts[-1])["type"], "session")
            controller.close(); controller.close()
            self.assertEqual(controller.frame.closed, 1)

    def test_bound_project_events_are_posted_before_the_response(self):
        class EventingProjectService:
            def handle(self, method, payload):
                self.assertions.append((method, payload))
                return {
                    "projectId": None,
                    "revision": 0,
                    "name": None,
                    "readOnly": False,
                    "dirty": False,
                    "busy": False,
                    "progress": None,
                    "recoveryAvailable": False,
                    "recentProjects": [],
                    "status": "closed",
                }

            def drain_events(self):
                return [("project.status", {"status": "closed"})]

            assertions = []

        process = Mock(is_alive=Mock(return_value=True))
        frame = FakeFrame(FrameConfig(
            FrameMode.DEVELOPMENT,
            development_origin="http://127.0.0.1:3099",
        ))
        frame.state = FrameState.READY
        controller = FrameController(process, frame=frame)
        service = EventingProjectService()
        controller.dispatcher.bind_services(project_service=service)
        request = {
            "protocol": "auvra.host/1",
            "type": "request",
            "id": "status-1",
            "session": controller.dispatcher.session.session_id,
            "revision": 0,
            "method": "project.getStatus",
            "payload": {},
        }

        controller.on_message(json.dumps(request), "http://127.0.0.1:3099/")
        self.assertTrue(controller.wait_for_host_idle())

        messages = [json.loads(body) for body in frame.posts]
        self.assertEqual([message["type"] for message in messages], ["event", "response"])
        self.assertEqual([message["revision"] for message in messages], [1, 1])
        self.assertEqual(messages[0]["event"], "project.status")
        self.assertEqual(service.assertions, [("project.getStatus", {})])
        controller.close()

    def test_host_request_returns_before_blocking_handler_completes(self):
        process = Mock(is_alive=Mock(return_value=True))
        frame = FakeFrame(FrameConfig(
            FrameMode.DEVELOPMENT,
            development_origin="http://127.0.0.1:3099",
        ))
        frame.state = FrameState.READY
        controller = FrameController(process, frame=frame)
        started = threading.Event()
        release = threading.Event()

        def blocking_ping(payload):
            started.set()
            if not release.wait(3):
                raise RuntimeError("test handler timed out")
            return {"pong": True}

        controller.dispatcher.register_method("host.ping", blocking_ping)
        request = {
            "protocol": "auvra.host/1", "type": "request", "id": "slow-1",
            "session": controller.dispatcher.session.session_id, "revision": 0,
            "method": "host.ping", "payload": {},
        }

        completed = threading.Event()
        errors: list[BaseException] = []

        def dispatch() -> None:
            try:
                controller.on_message(json.dumps(request), "http://127.0.0.1:3099/")
            except BaseException as exc:
                errors.append(exc)
            finally:
                completed.set()

        thread = threading.Thread(target=dispatch, name="controller-nonblocking-test")
        thread.start()
        try:
            self.assertTrue(completed.wait(2), "host request dispatch blocked behind the handler")
            self.assertEqual(errors, [])
            self.assertTrue(started.wait(1))
            self.assertEqual(frame.posts, [])
        finally:
            release.set()
            self.assertTrue(controller.wait_for_host_idle(timeout=5))
            thread.join(timeout=2)
            controller.close()
        self.assertTrue(json.loads(frame.posts[-1])["ok"])

    def test_host_queue_saturation_returns_immediate_retryable_response(self):
        process = Mock(is_alive=Mock(return_value=True))
        frame = FakeFrame(FrameConfig(
            FrameMode.DEVELOPMENT,
            development_origin="http://127.0.0.1:3099",
        ))
        frame.state = FrameState.READY
        controller = FrameController(process, frame=frame)
        started = threading.Event()
        release = threading.Event()

        def occupy_host_slot() -> None:
            started.set()
            if not release.wait(3):
                raise RuntimeError("test saturated host worker timed out")

        try:
            futures = [controller._submit_host(occupy_host_slot) for _ in range(64)]
            self.assertTrue(all(future is not None for future in futures))
            self.assertTrue(started.wait(1))
            request = {
                "protocol": "auvra.host/1", "type": "request", "id": "busy-1",
                "session": controller.dispatcher.session.session_id, "revision": 0,
                "method": "host.ping", "payload": {},
            }
            completed = threading.Event()
            errors: list[BaseException] = []

            def dispatch() -> None:
                try:
                    controller.on_message(json.dumps(request), "http://127.0.0.1:3099/")
                except BaseException as exc:
                    errors.append(exc)
                finally:
                    completed.set()

            thread = threading.Thread(target=dispatch, name="controller-saturation-test")
            thread.start()
            self.assertTrue(completed.wait(2), "saturated host dispatch blocked")
            thread.join(timeout=2)
            self.assertEqual(errors, [])
            self.assertEqual(len(frame.posts), 1)
            response = json.loads(frame.posts[0])
            self.assertEqual(response["id"], "busy-1")
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], "locking")
            self.assertTrue(response["error"]["details"]["retryable"])
        finally:
            release.set()
            self.assertTrue(controller.wait_for_host_idle(timeout=5))
            controller.close()

    def test_project_progress_is_streamed_while_handler_is_running(self):
        class StreamingProjectService:
            def __init__(self):
                self.sink = None
                self.started = threading.Event()
                self.release = threading.Event()

            def set_event_sink(self, sink):
                self.sink = sink

            def handle(self, method, payload):
                self.sink("project.progress", {"busy": True, "progress": 0.25, "status": "closed"})
                self.started.set()
                if not self.release.wait(3):
                    raise RuntimeError("test project handler timed out")
                return {
                    "projectId": None, "revision": 0, "name": None, "readOnly": False,
                    "dirty": False, "busy": False, "progress": None,
                    "recoveryAvailable": False, "recentProjects": [], "status": "closed",
                }

            def drain_events(self):
                return []

            def shutdown(self):
                return None

        process = Mock(is_alive=Mock(return_value=True))
        frame = FakeFrame(FrameConfig(
            FrameMode.DEVELOPMENT,
            development_origin="http://127.0.0.1:3099",
        ))
        frame.state = FrameState.READY
        service = StreamingProjectService()
        controller = FrameController(process, frame=frame, project_host=service)
        controller.dispatcher.bind_services(project_service=service)
        request = {
            "protocol": "auvra.host/1", "type": "request", "id": "status-live",
            "session": controller.dispatcher.session.session_id, "revision": 0,
            "method": "project.getStatus", "payload": {},
        }

        controller.on_message(json.dumps(request), "http://127.0.0.1:3099/")
        self.assertTrue(service.started.wait(1))
        messages = [json.loads(body) for body in frame.posts]
        self.assertEqual([message["type"] for message in messages], ["event"])
        self.assertEqual(messages[0]["event"], "project.progress")
        self.assertEqual(messages[0]["payload"]["progress"], 0.25)
        service.release.set()
        self.assertTrue(controller.wait_for_host_idle())
        self.assertEqual(json.loads(frame.posts[-1])["type"], "response")
        controller.close()

    def test_diagnostics_lane_remains_live_while_host_worker_is_blocked(self):
        with tempfile.TemporaryDirectory(prefix="auvra blocked host diagnostics ") as raw:
            session = DiagnosticsSession(Path(raw) / "diagnostics", run_id="run-host-block", mode="test")
            session.start()
            install_diagnostics(session)
            process = Mock(is_alive=Mock(return_value=True))
            frame = FakeFrame(FrameConfig(
                FrameMode.DEVELOPMENT,
                development_origin="http://127.0.0.1:3099",
            ))
            frame.state = FrameState.READY
            controller = FrameController(process, frame=frame)
            blocked = threading.Event()
            release = threading.Event()

            def occupy_host_worker() -> None:
                blocked.set()
                if not release.wait(3):
                    raise RuntimeError("test host worker timed out")

            self.assertIsNotNone(controller._submit_host(occupy_host_worker))
            self.assertTrue(blocked.wait(1))
            diagnostic = {
                "protocol": "auvra.diagnostics/1",
                "type": "event-batch",
                "id": "batch-while-blocked",
                "records": [{
                    "component": "frontend",
                    "event": "frontend.warning",
                    "attributes": {"code": "host_worker_blocked_fixture", "count": 1},
                }],
            }
            completed = threading.Event()
            errors: list[BaseException] = []

            def dispatch() -> None:
                try:
                    controller.on_message(json.dumps(diagnostic), "http://127.0.0.1:3099/")
                except BaseException as exc:
                    errors.append(exc)
                finally:
                    completed.set()

            thread = threading.Thread(target=dispatch, name="controller-diagnostics-lane-test")
            thread.start()
            self.assertTrue(completed.wait(2), "diagnostics dispatch blocked behind the host worker")
            thread.join(timeout=2)
            self.assertEqual(errors, [])
            response = json.loads(frame.posts[-1])
            self.assertEqual(response["protocol"], "auvra.diagnostics/1")
            self.assertTrue(response["ok"])
            self.assertTrue(any(record["event"] == "frontend.warning"
                                for record in session.snapshot()))
            release.set()
            self.assertTrue(controller.wait_for_host_idle())
            controller.close()
            session.close(outcome="success")

    def test_browser_trace_id_correlates_host_request_records(self):
        with tempfile.TemporaryDirectory(prefix="auvra host trace diagnostics ") as raw:
            session = DiagnosticsSession(Path(raw) / "diagnostics", run_id="run-host-trace", mode="test")
            session.start()
            session.start_detailed_capture()
            install_diagnostics(session)
            process = Mock(is_alive=Mock(return_value=True))
            frame = FakeFrame(FrameConfig(
                FrameMode.DEVELOPMENT,
                development_origin="http://127.0.0.1:3099",
            ))
            frame.state = FrameState.READY
            controller = FrameController(process, frame=frame)
            request = {
                "protocol": "auvra.host/1",
                "type": "request",
                "id": "trace-import-1.req-1",
                "session": controller.dispatcher.session.session_id,
                "revision": 0,
                "method": "project.create",
                "payload": {"name": "Untitled"},
            }
            controller.on_message(json.dumps(request), "http://127.0.0.1:3099/")
            self.assertTrue(controller.wait_for_host_idle())
            traced = [record for record in session.snapshot()
                      if record.get("requestId") == "trace-import-1.req-1"]
            self.assertTrue(traced)
            self.assertTrue(all(record.get("traceId") == "trace-import-1" for record in traced))
            self.assertTrue(any(record["event"] == "host.queue_wait" for record in traced))
            controller.close()
            session.close(outcome="success")

    def test_adapter_without_origin_policy_is_rejected(self):
        class UnsafeFrame(FakeFrame):
            def __init__(self, config):
                super().__init__(config)
                del self.policy

        process = Mock(is_alive=Mock(return_value=True))
        with self.assertRaises(FrameConfigurationError):
            FrameController(process, frame=UnsafeFrame(FrameConfig(
                FrameMode.DEVELOPMENT, development_origin="http://127.0.0.1:3099",
            )))

    def test_packaged_controller_uses_immutable_root_and_random_live_session(self):
        process = Mock(is_alive=Mock(return_value=True))
        with tempfile.TemporaryDirectory() as temp, patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}):
            root = Path(temp) / "dist"; root.mkdir()
            (root / "index.html").write_text("<!doctype html>")
            with patch("Auvra.desktop.contracts._REPO_FRONTEND_DIST", root):
                controller = FrameController.packaged(process, root, profile_parent=Path(temp), frame_factory=FakeFrame)
            self.assertEqual(controller.frame.config.mode, FrameMode.PACKAGED)
            self.assertNotEqual(controller.dispatcher.session.session_id, "session-0001")
            controller.close()

    def test_runtime_failure_and_unexpected_clean_child_exit_are_not_success(self):
        failed_process = Mock(is_alive=Mock(return_value=True), poll=Mock(return_value=None))
        failed_frame = FakeFrame(FrameConfig(FrameMode.DEVELOPMENT, development_origin="http://127.0.0.1:3099"))
        failed_frame.state = FrameState.FAILED
        failed_frame.failure = FrameFailure("renderer_failed", "renderer failed")
        failed = FrameController(failed_process, frame=failed_frame)
        with self.assertRaisesRegex(FrameStartupError, "renderer failed"):
            failed.run()

        exited_process = Mock(is_alive=Mock(return_value=False), poll=Mock(return_value=0))
        exited_frame = FakeFrame(FrameConfig(FrameMode.DEVELOPMENT, development_origin="http://127.0.0.1:3099"))
        exited_frame.state = FrameState.READY
        exited = FrameController(exited_process, frame=exited_frame)
        with self.assertRaises(FrameProcessExitedError) as raised:
            exited.run()
        self.assertEqual(raised.exception.returncode, 0)

    def test_process_cleanup_failure_is_retained_for_cli_reporting(self):
        process = Mock()
        process.terminate.side_effect = OSError("owned process survived")
        frame = FakeFrame(FrameConfig(FrameMode.DEVELOPMENT, development_origin="http://127.0.0.1:3099"))
        controller = FrameController(process, frame=frame)
        controller.close()
        self.assertIsInstance(controller.cleanup_error, OSError)
