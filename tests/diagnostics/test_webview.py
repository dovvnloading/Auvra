from __future__ import annotations

import json
from pathlib import Path
import tempfile
import time
import unittest

from jsonschema import validate

from Auvra.diagnostics.core import DiagnosticsSession
from Auvra.diagnostics.webview import (
    WEBVIEW_BATCH_MAX_BYTES,
    DiagnosticWebViewLane,
)


class DiagnosticWebViewLaneTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="auvra webview diagnostics ")
        self.session = DiagnosticsSession(
            Path(self.temporary.name) / "diagnostics",
            run_id="run-webview-lane",
            mode="test",
        )
        self.session.start()
        self.posts: list[dict[str, object]] = []
        self.lane = DiagnosticWebViewLane(
            self.session,
            session_id="s-webview-test",
            post=self.posts.append,
        )

    def tearDown(self) -> None:
        self.lane.close()
        self.session.close(outcome="success")
        self.temporary.cleanup()

    def handle(self, value: dict[str, object], *, size: int | None = None) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.lane.handle(value, encoded_size=len(encoded) if size is None else size)

    def test_correlated_operation_worker_phases_and_outcome_are_ingested(self) -> None:
        envelope = {
            "protocol": "auvra.diagnostics/1",
            "type": "event-batch",
            "id": "batch-1",
            "records": [
                {
                    "component": "operation",
                    "event": "operation.started",
                    "operationId": "operation-1",
                    "traceId": "trace-1",
                    "attributes": {
                        "operationKind": "asset.animation.import",
                        "phase": "source_read",
                        "assetAlias": "asset-1",
                        "assetKind": "animation",
                        "bytes": 4096,
                        "progressBucket": 0,
                    },
                },
                {
                    "component": "worker",
                    "event": "worker.phase",
                    "operationId": "operation-1",
                    "traceId": "trace-1",
                    "attributes": {
                        "phase": "fbx_structure_parse",
                        "workerState": "parsing",
                        "assetAlias": "asset-1",
                        "progressBucket": 25,
                    },
                },
                {
                    "component": "operation",
                    "event": "operation.phase",
                    "operationId": "operation-1",
                    "traceId": "trace-1",
                    "attributes": {
                        "operationKind": "asset.animation.import",
                        "phase": "animation_binding",
                        "assetAlias": "asset-1",
                        "assetKind": "animation",
                        "clipCount": 3,
                        "bindingMode": "retargeted",
                        "progressBucket": 75,
                    },
                },
                {
                    "component": "operation",
                    "event": "operation.completed",
                    "operationId": "operation-1",
                    "traceId": "trace-1",
                    "attributes": {
                        "operationKind": "asset.animation.import",
                        "phase": "library_publication",
                        "outcome": "success",
                        "durationMs": 123.5,
                    },
                },
            ],
        }
        schema = json.loads((Path(__file__).parents[2] / "diagnostics" / "v1" /
                             "auvra-diagnostics-webview.schema.json").read_text(encoding="utf-8"))
        validate(envelope, schema)
        self.handle(envelope)

        self.assertEqual(self.posts[-1]["result"], {"accepted": 4})
        records = [record for record in self.session.snapshot()
                   if record.get("traceId") == "trace-1"]
        self.assertEqual([record["event"] for record in records], [
            "operation.started", "worker.phase", "operation.phase", "operation.completed",
        ])
        self.assertEqual(records[1]["attributes"]["workerState"], "parsing")
        self.assertEqual(records[2]["attributes"]["bindingMode"], "retargeted")
        self.assertEqual(self.session.summary["activeOperations"], [])

    def test_worker_phase_and_queue_state_survive_operation_stall(self) -> None:
        self.handle({
            "protocol": "auvra.diagnostics/1",
            "type": "event-batch",
            "id": "batch-stall-start",
            "records": [
                {
                    "component": "operation",
                    "event": "operation.started",
                    "operationId": "operation-stall",
                    "traceId": "trace-stall",
                    "attributes": {
                        "operationKind": "asset.model.import",
                        "phase": "worker_creation",
                        "queueState": "frontend_active",
                    },
                },
                {
                    "component": "worker",
                    "event": "worker.phase",
                    "operationId": "operation-stall",
                    "traceId": "trace-stall",
                    "attributes": {
                        "phase": "fbx_structure_parse",
                        "workerState": "parsing",
                        "queueState": "worker_active",
                        "assetAlias": "asset-2",
                        "progressBucket": 25,
                    },
                },
            ],
        })
        with self.session._state_lock:
            state = next(value for value in self.session._activities.values()
                         if value.operation_id == "operation-stall")
            state.last_progress -= 6
        deadline = time.monotonic() + 2.5
        while time.monotonic() < deadline and not any(
            record["event"] == "diagnostics.operation_stalled"
            and record.get("traceId") == "trace-stall"
            for record in self.session.snapshot()
        ):
            time.sleep(0.05)
        stalled = next(record for record in self.session.snapshot()
                       if record["event"] == "diagnostics.operation_stalled"
                       and record.get("traceId") == "trace-stall")
        self.assertEqual(stalled["attributes"]["phase"], "fbx_structure_parse")
        self.assertEqual(stalled["attributes"]["workerState"], "parsing")
        self.assertEqual(stalled["attributes"]["queueState"], "worker_active")
        self.assertNotIn("frames", stalled["attributes"])

        self.handle({
            "protocol": "auvra.diagnostics/1",
            "type": "event-batch",
            "id": "batch-stall-end",
            "records": [{
                "component": "operation",
                "event": "operation.failed",
                "operationId": "operation-stall",
                "traceId": "trace-stall",
                "attributes": {
                    "operationKind": "asset.model.import",
                    "phase": "fbx_structure_parse",
                    "queueState": "completed",
                    "outcome": "failure",
                    "durationMs": 6000,
                    "code": "operation_failed",
                    "errorType": "ImportError",
                },
            }],
        })
        self.assertTrue(any(record["event"] == "diagnostics.operation_recovered"
                            and record.get("traceId") == "trace-stall"
                            for record in self.session.snapshot()))

    def test_malformed_or_unsafe_batch_is_rejected_atomically(self) -> None:
        before = len(self.session.snapshot())
        self.handle({
            "protocol": "auvra.diagnostics/1",
            "type": "event-batch",
            "id": "batch-unsafe",
            "records": [
                {
                    "component": "frontend",
                    "event": "frontend.warning",
                    "attributes": {"code": "safe_warning", "count": 1},
                },
                {
                    "component": "frontend",
                    "event": "frontend.failure",
                    "attributes": {
                        "code": "unsafe_failure",
                        "errorType": "Error",
                        "phase": "C:\\private\\asset.fbx",
                    },
                },
            ],
        })

        self.assertFalse(self.posts[-1]["ok"])
        added = self.session.snapshot()[before:]
        self.assertFalse(any(record["event"] == "frontend.warning" for record in added))
        self.assertTrue(any(record["event"] == "webview.message_rejected" for record in added))
        self.assertNotIn("asset.fbx", json.dumps(added))

    def test_bounds_sessions_commands_and_heartbeat_recovery(self) -> None:
        oversized = {
            "protocol": "auvra.diagnostics/1", "type": "event-batch",
            "id": "batch-large", "records": [],
        }
        self.handle(oversized, size=WEBVIEW_BATCH_MAX_BYTES + 1)
        self.assertFalse(self.posts[-1]["ok"])

        self.handle({
            "protocol": "auvra.diagnostics/1", "type": "command",
            "id": "command-bad", "session": "s-wrong", "command": "capture.enable",
        })
        self.assertFalse(self.posts[-1]["ok"])
        self.handle({
            "protocol": "auvra.diagnostics/1", "type": "command",
            "id": "command-good", "session": "s-webview-test", "command": "capture.enable",
        })
        self.assertTrue(self.posts[-1]["ok"])
        self.assertTrue(self.session.detailed)

        self.session.expect_frontend_heartbeat()
        self.handle({
            "protocol": "auvra.diagnostics/1", "type": "heartbeat",
            "visibility": "active", "activeCount": 1,
        })
        with self.session._state_lock:
            assert self.session._frontend_last_heartbeat is not None
            self.session._frontend_last_heartbeat -= 6
        deadline = time.monotonic() + 2.5
        while time.monotonic() < deadline and not any(
            record["event"] == "frontend.unresponsive" for record in self.session.snapshot()
        ):
            time.sleep(0.05)
        self.assertTrue(any(record["event"] == "frontend.unresponsive"
                            for record in self.session.snapshot()))
        self.handle({
            "protocol": "auvra.diagnostics/1", "type": "heartbeat",
            "visibility": "active", "activeCount": 1,
        })
        self.assertTrue(any(record["event"] == "frontend.responsive"
                            for record in self.session.snapshot()))


if __name__ == "__main__":
    unittest.main()
