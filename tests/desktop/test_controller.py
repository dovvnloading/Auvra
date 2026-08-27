from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import Auvra.desktop.contracts as contracts
from Auvra.desktop.controller import FrameController, FrameProcessExitedError
from Auvra.desktop.contracts import FrameConfig, FrameConfigurationError, FrameFailure, FrameMode, FrameStartupError, FrameState
from Auvra.desktop.policy import FramePolicy


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
    def test_dispatches_only_exact_source_and_posts_validated_response(self):
        process = Mock(is_alive=Mock(return_value=True))
        with tempfile.TemporaryDirectory() as temp, patch.object(contracts, "_CONTROLLED_TEST_PROFILE_PARENTS", {Path(temp)}):
            controller = FrameController.development(process, "http://127.0.0.1:3099/", profile_parent=Path(temp), frame_factory=FakeFrame)
            controller.start()
            valid = {"protocol": "auvra.host/1", "type": "request", "id": "r1", "session": controller.dispatcher.session.session_id, "revision": 0, "method": "host.ping", "payload": {}}
            controller.on_message(json.dumps(valid), "http://127.0.0.1:3099/")
            controller.on_message(json.dumps(valid), "http://evil.test/")
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
