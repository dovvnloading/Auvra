from __future__ import annotations

import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import textwrap
import unittest
import hashlib
import io

from Auvra.desktop.native_engine import (
    MAX_FRAME_BYTES,
    NativeEngine,
    NativeEngineChildExitedError,
    NativeEngineConfigurationError,
    NativeEngineFrameTooLargeError,
    NativeEngineHost,
    NativeEngineRevisionConflictError,
    NativeEngineState,
    PROTOCOL_VERSION,
    _encode_frame,
    _read_frame,
)


FAKE_CHILD = textwrap.dedent(
    r'''
    import json, os, struct, sys

    PROTOCOL = "auvra.native/1"
    MAX_FRAME = 64 * 1024
    token = os.environ.get("AUVRA_NATIVE_SESSION_TOKEN", "")
    revision = 0
    entities = []
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


class _HydrationRecorder:
    """Small native boundary double for bounded hydration tests."""

    state = NativeEngineState.READY

    def __init__(self, *, fail_append: bool = False) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.fail_append = fail_append

    def call(self, method: str, params: dict[str, object] | None = None) -> dict[str, object]:
        values = dict(params or {})
        self.calls.append((method, values))
        if method == "world.beginHydration":
            return {"hydrationTransaction": True}
        if method == "world.appendHydration" and self.fail_append:
            raise RuntimeError("append failed")
        if method == "world.commitHydration":
            return {"revision": 1}
        return {}


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

    def test_response_framing_accepts_fragmented_pipe_reads(self) -> None:
        value = {"protocol": PROTOCOL_VERSION, "id": 7, "ok": True, "result": {"ready": True}}
        encoded = _encode_frame(value)

        class FragmentedReader(io.BytesIO):
            def read(self, size: int = -1) -> bytes:
                return super().read(min(size, 1))

        self.assertEqual(_read_frame(FragmentedReader(encoded)), value)

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
            engine.call("world.apply", {"payload": "x" * MAX_FRAME_BYTES})

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
            "entities": [{"id": "cube", "position": [1, 2, 3], "color": [0.2, 0.6, 1.0, 1.0]}],
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

    def test_native_asset_staging_verifies_hash_and_keeps_protocol_pathless(self) -> None:
        engine = self.make_engine()
        source = Path(self.temp.name) / "native-source"
        host = NativeEngineHost(engine, source_root=source)
        payload = b"gltf-source"
        asset_id = hashlib.sha256(payload).hexdigest()
        host.stage_asset(asset_id, io.BytesIO(payload), chunk_size=4)
        self.assertEqual((source / asset_id).read_bytes(), payload)
        with self.assertRaisesRegex(Exception, "hash"):
            host.stage_asset("0" * 64, io.BytesIO(payload), chunk_size=4)
        with self.assertRaisesRegex(Exception, "paths"):
            engine.call("world.hydrate", {"path": "C:\\private"})
        for forbidden in ({"asset_path": "asset"}, {"binary": "AQ=="}, {"note": "C:\\private\\asset"}):
            with self.assertRaisesRegex(Exception, "paths or binary"):
                engine.call("world.hydrate", forbidden)

    def test_hydration_is_retained_for_editor_reload_and_native_restart(self) -> None:
        engine = self.make_engine()
        host = NativeEngineHost(engine)
        domains = {"scenes": {"schemaVersion": 1, "documents": [{"id": "scene"}]}}
        host.hydrate_project("project-1", 4, domains)
        self.assertEqual(host._project_payload["projectId"], "project-1")
        self.assertEqual(host._project_payload["projectRevision"], 4)
        # A second session hello represents an editor document reload and does
        # not discard the retained project hydration payload.
        engine.session_hello("editor-reloaded")
        self.assertEqual(host._project_payload["projectRevision"], 4)

    def test_stage8_result_fields_are_canonical_and_dock_handle_is_internal(self) -> None:
        class Engine:
            state = NativeEngineState.READY

            def __init__(self):
                self.calls = []

            def call(self, method, params=None):
                self.calls.append((method, params or {}))
                if method == "renderer.getCapabilities":
                    return {
                        "backend": "wgpu", "adapter": "reference",
                        "dockSupport": "same-build", "dockReason": None,
                        "featureCapabilities": [
                            {"feature": feature, "supported": True, "fallbackReason": None}
                            for feature in (
                                "pbr_metallic_roughness", "skeletal_animation", "frustum_culling",
                                "deterministic_lod", "instance_batching", "directional_lights",
                                "point_lights", "spot_lights", "shadow_maps", "image_based_lighting",
                                "entity_picking", "editor_gizmos", "hdr_intermediate", "aces_tone_mapping",
                                "msaa_or_fxaa", "post_processing_chain",
                            )
                        ],
                        "tick": 12, "worldHash": "a" * 16,
                        "replayHash": "b" * 16, "extractionHash": "c" * 16,
                    }
                if method == "renderer.getMetrics":
                    return {"startup_ms": 1, "last_frame_submit_ms": 2,
                            "gpu_frame_ms": 3, "memory_bytes": 4}
                if method == "renderer.renderReference":
                    return {"width": 64, "height": 64, "pixel_hash_fnv1a64": "0x" + "d" * 16}
                if method == "viewport.open":
                    return {"dockSupport": "same-build", "dockActive": False,
                            "dockReason": "native chose separate viewport"}
                if method == "world.getSnapshot":
                    return {"revision": 4, "tick": 12, "projectId": "project-1",
                            "projectRevision": 9, "worldHash": "0x" + "a" * 16,
                            "replayHash": "0x" + "b" * 16,
                            "extractionHash": "0x" + "c" * 16, "entities": []}
                return {}

        engine = Engine()
        host = NativeEngineHost(engine)
        host.set_dock_target_provider(lambda: {"parentHandle": 99, "width": 640, "height": 480})
        host.handle("engine.getStatus", {})
        snapshot = host.handle("engine.getSnapshot", {})
        self.assertEqual(snapshot["tick"], 12)
        self.assertEqual(snapshot["projectRevision"], 9)
        self.assertEqual(snapshot["worldHash"], "a" * 16)
        first = host.handle("engine.openViewport", {"width": 640, "height": 480})
        second = host.handle("engine.openViewport", {"width": 640, "height": 480})
        self.assertEqual(first, second)
        self.assertNotIn("alreadyOpen", second)
        self.assertEqual([name for name, _ in engine.calls].count("viewport.open"), 1)
        viewport_call = next(params for name, params in engine.calls if name == "viewport.open")
        self.assertEqual(viewport_call.get("parentHandle"), 99)
        self.assertFalse(first["dockActive"])
        rendered = host.handle("engine.renderReference", {"width": 64, "height": 64})
        self.assertEqual(rendered["referenceScene"], "basic")
        self.assertEqual(rendered["referenceVersion"], 1)
        self.assertEqual(rendered["featureCapabilities"][0]["supported"], True)
        self.assertNotIn("path", repr(rendered).lower())
        host.close_project("project-1")
        self.assertEqual([name for name, _ in engine.calls].count("world.closeProject"), 1)
        closed = host._canonical("engine.status")
        self.assertNotIn("projectId", closed)
        self.assertNotIn("worldHash", closed)

    def test_hydration_uses_bounded_transaction_frames(self) -> None:
        engine = _HydrationRecorder()
        host = NativeEngineHost(engine)
        documents = [
            {"id": f"document-{index}", "payload": "x" * 4000}
            for index in range(24)
        ]
        host.hydrate_project(
            "project-bounded", 3,
            {"scenes": {"schemaVersion": 1, "documents": documents}},
        )

        methods = [method for method, _params in engine.calls]
        self.assertEqual(methods[0], "world.beginHydration")
        self.assertGreaterEqual(methods.count("world.appendHydration"), 2)
        self.assertEqual(methods[-1], "world.commitHydration")
        for request_id, (method, params) in enumerate(engine.calls, start=1):
            frame = _encode_frame({
                "protocol": PROTOCOL_VERSION,
                "id": request_id,
                "method": method,
                "params": params,
            })
            self.assertLessEqual(len(frame), MAX_FRAME_BYTES, method)

    def test_validate_only_uses_transaction_and_never_legacy_hydration(self) -> None:
        engine = _HydrationRecorder()
        host = NativeEngineHost(engine)
        domains = {"scenes": {"schemaVersion": 1, "documents": [{"id": "scene"}]}}

        host.validate_project("project-validate", 8, domains)

        methods = [method for method, _params in engine.calls]
        self.assertIn("world.beginHydration", methods)
        begin = next(params for method, params in engine.calls if method == "world.beginHydration")
        self.assertTrue(begin["validateOnly"])
        self.assertNotIn("world.validateHydration", methods)
        self.assertNotIn("world.hydrate", methods)
        self.assertIn("world.commitHydration", methods)

    def test_hydration_append_failure_aborts_and_retains_project_payload(self) -> None:
        engine = _HydrationRecorder(fail_append=True)
        host = NativeEngineHost(engine)
        domains = {"scenes": {"schemaVersion": 1, "documents": [{"id": "scene"}]}}
        expected = {
            "projectId": "project-failed-transfer",
            "projectRevision": 11,
            "domains": domains,
            "assetIds": [],
        }

        with self.assertRaisesRegex(RuntimeError, "append failed"):
            host.hydrate_project("project-failed-transfer", 11, domains)

        self.assertEqual(host._project_payload, expected)
        methods = [method for method, _params in engine.calls]
        self.assertIn("world.abortHydration", methods)
        self.assertNotIn("world.commitHydration", methods)

    def test_dangling_source_symlink_is_rejected(self) -> None:
        source = Path(self.temp.name) / "native-source"
        source.mkdir()
        asset_id = hashlib.sha256(b"asset").hexdigest()
        target = source / asset_id
        try:
            target.symlink_to(source / "missing-source")
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlink creation unavailable: {error}")

        host = NativeEngineHost(_HydrationRecorder(), source_root=source)
        with self.assertRaisesRegex(NativeEngineConfigurationError, "unsafe|link|reparse"):
            host.stage_asset(asset_id, io.BytesIO(b"asset"))

    def test_project_close_unloads_public_identity_and_hashes(self) -> None:
        engine = _HydrationRecorder()
        host = NativeEngineHost(engine)
        domains = {"scenes": {"schemaVersion": 1, "documents": []}}
        host.hydrate_project("project-close", 12, domains)
        host._ingest_native_result({
            "projectId": "project-close", "projectRevision": 12,
            "worldHash": "a" * 16, "replayHash": "b" * 16,
            "extractionHash": "c" * 16,
        })
        before = host._canonical("engine.status")
        self.assertEqual(before["projectId"], "project-close")
        self.assertEqual(before["worldHash"], "a" * 16)

        host.close_project("project-close")

        after = host._canonical("engine.status")
        for key in ("projectId", "projectRevision", "worldHash", "replayHash", "extractionHash"):
            self.assertNotIn(key, after)
        self.assertEqual(
            [method for method, _params in engine.calls].count("world.closeProject"),
            1,
        )

    def test_restart_rehydrates_same_project_payload_in_fresh_child(self) -> None:
        log = Path(self.temp.name) / "hydration.jsonl"
        script = Path(self.temp.name) / "restart_native.py"
        script.write_text(
            FAKE_CHILD.replace(
                '        else:\n            result = {"method": method, "params": params}',
                '        elif method == "world.hydrate":\n'
                '            with open(os.environ["AUVRA_TEST_HYDRATE_LOG"], "a", encoding="utf-8") as stream:\n'
                '                stream.write(json.dumps(params, sort_keys=True) + "\\n")\n'
                '            result = {"revision": params["projectRevision"]}\n'
                '        else:\n            result = {"method": method, "params": params}',
            ),
            encoding="utf-8",
        )
        environment = dict(os.environ, AUVRA_TEST_HYDRATE_LOG=str(log))
        self.engine = NativeEngine([sys.executable, "-u", str(script)],
                                   startup_timeout=2, request_timeout=2,
                                   shutdown_timeout=1, environment=environment)
        self.engine.start(editor_session="first")
        host = NativeEngineHost(self.engine)
        domains = {"scenes": {"schemaVersion": 1, "documents": [{"id": "scene"}]}}
        host.hydrate_project("project-restart", 7, domains)
        first_pid = self.engine.status.pid
        host.restart(editor_session="second")
        self.assertNotEqual(self.engine.status.pid, first_pid)
        records = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0], records[1])
        self.assertEqual(records[1]["projectId"], "project-restart")
        self.assertEqual(records[1]["projectRevision"], 7)
        self.assertEqual(records[1]["domains"], domains)

    def test_failed_restart_retains_project_payload_for_retry(self) -> None:
        engine = self.make_engine()
        host = NativeEngineHost(engine)
        host.hydrate_project("project-retry", 3, {"scenes": {"schemaVersion": 1, "documents": []}})
        payload = dict(host._project_payload)
        engine.command = (str(Path(self.temp.name) / "missing-native-child.exe"),)
        with self.assertRaises(Exception):
            host.restart(editor_session="retry")
        self.assertEqual(host._project_payload, payload)


if __name__ == "__main__":
    unittest.main()
