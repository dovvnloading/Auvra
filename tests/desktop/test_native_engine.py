from __future__ import annotations

import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import textwrap
import unittest

from Auvra.desktop.native_engine import (
    MAX_FRAME_BYTES,
    NativeEngine,
    NativeEngineChildExitedError,
    NativeEngineFrameTooLargeError,
    NativeEngineHost,
    NativeEngineRevisionConflictError,
    NativeEngineState,
)


FAKE_CHILD = textwrap.dedent(
    r'''
    import json, os, struct, sys

    PROTOCOL = "auvra.native/1"
    MAX_FRAME = 64 * 1024
    token = os.environ.get("AUVRA_NATIVE_SESSION_TOKEN", "")
    revision = 0
    entities = {}
    print(json.dumps({"level":"info","event":"native.ready","protocol":PROTOCOL}), file=sys.stderr, flush=True)

    def read_frame():
        header = sys.stdin.buffer.read(4)
        if not header:
            return None
        size = struct.unpack(">I", header)[0]
        if size > MAX_FRAME:
            raise RuntimeError("oversize")
        body = sys.stdin.buffer.read(size)
        return json.loads(body.decode("utf-8"))

    def write_frame(value):
        body = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
        sys.stdout.buffer.write(struct.pack(">I", len(body)) + body)
        sys.stdout.buffer.flush()

    while True:
        try:
            request = read_frame()
            if request is None:
                break
            request_id = request.get("id", "unknown")
            if "token" in request:
                write_frame({"protocol":PROTOCOL,"id":request_id,"ok":False,"error":{"code":"unauthorized","message":"token must stay in the environment"}})
                continue
            method = request.get("method")
            params = request.get("params", {})
            if method == "session.hello":
                result = {"authenticated": len(token) == 64, "requestTokenField": "token" in request}
            elif method == "world.apply":
                if params.get("expectedRevision") != revision:
                    write_frame({"protocol":PROTOCOL,"id":request_id,"ok":False,"error":{"code":"revision_conflict","message":"expected revision does not match"}})
                    continue
                entities = params.get("entities", [])
                revision += 1
                result = {"revision": revision, "entities": entities}
            elif method == "world.getSnapshot":
                result = {"revision": revision, "entities": entities}
            elif method == "shutdown":
                write_frame({"protocol":PROTOCOL,"id":request_id,"ok":True,"result":{"stopped":True}})
                print(json.dumps({"level":"info","event":"native.stopped","revision":revision}), file=sys.stderr, flush=True)
                break
            elif method == "exit":
                os._exit(7)
            else:
                result = {"method": method, "params": params}
            write_frame({"protocol":PROTOCOL,"id":request_id,"ok":True,"result":result})
        except Exception:
            break
    sys.exit(0)
    '''
)


class NativeEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="auvra-native-engine-")
        self.script = Path(self.temp.name) / "fake_native.py"
        self.script.write_text(FAKE_CHILD, encoding="utf-8")
        self.engine: NativeEngine | None = None

    def tearDown(self) -> None:
        if self.engine is not None:
            self.engine.close(timeout=1)
        self.temp.cleanup()

    def make_engine(self) -> NativeEngine:
        self.engine = NativeEngine([sys.executable, "-u", str(self.script)],
                                   startup_timeout=2, request_timeout=2,
                                   shutdown_timeout=1)
        self.engine.start(editor_session="editor-before-reload")
        return self.engine

    def test_framing_authentication_revision_and_reload_continuity(self) -> None:
        engine = self.make_engine()
        hello = engine.session_hello("editor-before-reload")
        self.assertTrue(hello["authenticated"])
        self.assertFalse(hello["requestTokenField"])
        applied = engine.apply_world(0, [{"id": "cube", "position": [1, 2, 3]}])
        self.assertEqual(applied["revision"], 1)
        with self.assertRaises(NativeEngineRevisionConflictError):
            engine.apply_world(0, [])
        # Reconnecting the editor does not restart the child or lose its world.
        pid = engine.status.pid
        engine.session_hello("editor-after-reload")
        snapshot = engine.snapshot_world()
        self.assertEqual(engine.status.pid, pid)
        self.assertEqual(snapshot["revision"], 1)
        self.assertEqual(snapshot["entities"][0]["position"], [1, 2, 3])

    def test_oversize_request_is_rejected_before_write(self) -> None:
        engine = self.make_engine()
        with self.assertRaises(NativeEngineFrameTooLargeError):
            engine.call("world.apply", {"blob": "x" * MAX_FRAME_BYTES})

    def test_clean_shutdown_reports_lifecycle_and_does_not_kill(self) -> None:
        engine = self.make_engine()
        process = engine.process
        assert process is not None
        engine.close(timeout=1)
        self.assertEqual(engine.state, NativeEngineState.CLOSED)
        self.assertEqual(process.returncode, 0)
        self.assertEqual([item.record.get("event") for item in engine.diagnostics],
                         ["native.ready", "native.stopped"])

    def test_child_exit_is_typed_and_cleanup_is_bounded(self) -> None:
        engine = self.make_engine()
        with self.assertRaises(NativeEngineChildExitedError) as raised:
            engine.call("exit")
        self.assertEqual(raised.exception.returncode, 7)
        engine.close(timeout=1)
        self.assertEqual(engine.state, NativeEngineState.CLOSED)

    def test_native_diagnostics_are_redacted_and_bounded(self) -> None:
        engine = self.make_engine()
        for number in range(400):
            engine._diagnostics_append({
                "event": "native.detail",
                "authorization": "Bearer do-not-print-this-token",
                "message": "x" * 9000,
                "number": number,
            })
        encoded = json.dumps([item.record for item in engine.diagnostics])
        self.assertLessEqual(len(engine.diagnostics), 256)
        self.assertNotIn("do-not-print-this-token", encoded)
        self.assertNotIn("x" * 9000, encoded)

    def test_host_maps_engine_methods_and_drains_bounded_events(self) -> None:
        engine = self.make_engine()
        host = NativeEngineHost(engine)
        self.assertEqual(host.handle("engine.getStatus", {})["kind"], "engine.status")
        self.assertEqual(host.handle("engine.getSnapshot", {})["kind"], "engine.snapshot")
        applied = host.handle("engine.applyChanges", {
            "expectedRevision": 0,
            "entities": [{"id": "cube", "position": [1, 2, 3]}],
        })
        self.assertEqual(applied["worldRevision"], 1)
        self.assertEqual(host.handle("engine.openViewport", {"width": 640, "height": 480, "title": "Auvra"})["viewport"], "open")
        self.assertEqual(host.handle("engine.closeViewport", {})["viewport"], "closed")
        self.assertEqual(host.handle("engine.renderReference", {"width": 64, "height": 64})["kind"], "engine.renderReference")
        self.assertEqual(host.handle("engine.getMetrics", {})["kind"], "engine.metrics")
        recovery = host.handle("engine.recover", {})
        self.assertEqual(recovery["kind"], "engine.recover")
        self.assertEqual(recovery["status"], "ready")
        names = [name for name, _payload in host.drain_events()]
        self.assertIn("engine.status", names)
        self.assertIn("engine.revision", names)
        self.assertIn("engine.viewport", names)
        self.assertIn("engine.recovery", names)
        self.assertEqual(host.drain_events(), [])


if __name__ == "__main__":
    unittest.main()
