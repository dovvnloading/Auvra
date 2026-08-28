from __future__ import annotations

import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from jsonschema import validate

from Auvra.diagnostics.core import (
    DIAGNOSTIC_SCHEMA,
    NORMAL_QUEUE_RECORDS,
    PRIORITY_QUEUE_RECORDS,
    RECORD_MAX_BYTES,
    DiagnosticsSession,
    inspect_records,
    install_diagnostics,
    latest_run_summary,
    redact,
)
from Auvra.launcher import cli
from Auvra.launcher.config import Paths


class DiagnosticsCoreTests(unittest.TestCase):
    def tearDown(self) -> None:
        install_diagnostics(None)

    def test_record_is_canonical_bounded_and_path_free(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw:
            root = Path(raw) / "diagnostics"
            session = DiagnosticsSession(root, source_root=Path(raw), run_id="run-schema", mode="test")
            session.start()
            record = session.emit(
                "launcher",
                "startup.phase_failed",
                attributes={
                    "phase": "desktop-frame-creation",
                    "code": "startup_timeout",
                    "detail": "Bearer private-token https://example.test C:\\Users\\person\\asset.fbx " + "x" * 1000,
                    "path": "C:\\private\\asset.fbx",
                },
                deduplicate=False,
            )
            session.close(outcome="failure", exit_code=10)
            encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
            self.assertEqual(record["schema"], DIAGNOSTIC_SCHEMA)
            self.assertLessEqual(len(encoded.encode("utf-8")), RECORD_MAX_BYTES)
            self.assertNotIn("private-token", encoded)
            self.assertNotIn("example.test", encoded)
            self.assertNotIn("asset.fbx", encoded)
            self.assertNotIn("path", record.get("attributes", {}))
            schema = json.loads((Path(__file__).parents[2] / "diagnostics" / "v1" / "auvra-diagnostics.schema.json").read_text(encoding="utf-8"))
            self.assertEqual(schema["properties"]["schema"]["const"], DIAGNOSTIC_SCHEMA)
            self.assertEqual(set(schema["required"]), {
                "schema", "sequence", "timestampUtc", "elapsedMs", "level",
                "component", "event", "runId",
            })
            validate(record, schema)

    def test_redaction_bounds_nested_values_without_a_raw_lane(self) -> None:
        safe = redact({
            "authorization": "Bearer do-not-keep",
            "items": list(range(50)),
            "payload": {"name": "private"},
            "note": "/home/person/project/model.fbx",
        })
        encoded = json.dumps(safe)
        self.assertNotIn("do-not-keep", encoded)
        self.assertNotIn("private", encoded)
        self.assertNotIn("model.fbx", encoded)
        self.assertLessEqual(len(safe["items"]), 17)

    def test_persistence_deduplicates_and_ignores_incomplete_final_line(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw:
            root = Path(raw) / "diagnostics"
            session = DiagnosticsSession(root, run_id="run-repeat", mode="test")
            session.start()
            for _ in range(3):
                session.emit("webview", "webview.message_rejected",
                             attributes={"code": "invalid_message"})
            session.close(outcome="failure")
            summary = latest_run_summary(root)
            assert summary is not None
            segment = root / summary["segments"][-1]
            with segment.open("ab") as stream:
                stream.write(b'{"schema":"auvra.diagnostics/1"')
            records = inspect_records(root, run_id="run-repeat", limit=1000)
            rejected = [record for record in records if record["event"] == "webview.message_rejected"]
            self.assertEqual(len(rejected), 2)
            self.assertEqual(rejected[-1]["attributes"]["repeatCount"], 2)
            self.assertEqual(summary["repeated"], 2)

    def test_unclean_run_is_retained_when_the_next_session_starts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw:
            root = Path(raw) / "diagnostics"
            first = DiagnosticsSession(root, run_id="run-first", mode="test")
            first.start()
            first.flush(1)
            first._stop.set()
            assert first._writer is not None
            first._writer.join(1)
            first._close_stream(durable=False)
            first._closed = True
            second = DiagnosticsSession(root, run_id="run-second", mode="test")
            previous = second.start()
            try:
                self.assertEqual(previous["runId"], "run-first")
                prior_summary = json.loads((root / "run-run-first.json").read_text(encoding="utf-8"))
                self.assertEqual(prior_summary["state"], "unclean")
            finally:
                second.close(outcome="success")

    def test_segments_and_run_retention_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw, \
             patch("Auvra.diagnostics.core.SEGMENT_MAX_BYTES", 2048), \
             patch("Auvra.diagnostics.core.RUN_MAX_SEGMENTS", 2), \
             patch("Auvra.diagnostics.core.RUN_MAX_COUNT", 2):
            root = Path(raw) / "diagnostics"
            for run_number in range(3):
                session = DiagnosticsSession(root, run_id=f"run-retain-{run_number}", mode="test")
                session.start()
                for event_number in range(100):
                    session.emit("launcher", "startup.phase_started",
                                 attributes={"phase": f"phase-{event_number}"},
                                 deduplicate=False)
                session.close(outcome="success")
            summaries = sorted(root.glob("run-*.json"))
            self.assertEqual(len(summaries), 2)
            self.assertFalse((root / "run-run-retain-0.json").exists())
            latest = latest_run_summary(root)
            assert latest is not None
            self.assertLessEqual(len(latest["segments"]), 2)
            self.assertTrue(all((root / name).stat().st_size <= 4096
                                for name in latest["segments"]))

    def test_ten_thousand_producer_calls_stay_bounded_under_writer_stall(self) -> None:
        gate = threading.Event()

        class BlockingSession(DiagnosticsSession):
            def _write_record(self, record):
                gate.wait(5)
                super()._write_record(record)

        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw:
            session = BlockingSession(Path(raw) / "diagnostics", run_id="run-pressure", mode="test")
            session.start()
            started = time.monotonic()
            for index in range(10_000):
                session.emit("launcher", "startup.phase_started",
                             attributes={"phase": f"phase-{index % 16}"},
                             deduplicate=False)
            session.emit("host", "host.dispatch_failed",
                         request_id="pressure", trace_id="pressure",
                         attributes={"method": "project.importPack", "code": "pressure"},
                         deduplicate=False)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 5.0)
            self.assertLessEqual(session._normal.qsize(), NORMAL_QUEUE_RECORDS)
            self.assertLessEqual(session._priority.qsize(), PRIORITY_QUEUE_RECORDS)
            self.assertLessEqual(len(session.snapshot()), 1000)
            self.assertGreater(sum(session.summary["dropped"].values()), 0)
            gate.set()
            session.close(outcome="failure")
            events = inspect_records(Path(raw) / "diagnostics", run_id="run-pressure", limit=1000)
            self.assertTrue(any(item["event"] == "host.dispatch_failed" for item in events))
            self.assertTrue(any(item["event"] == "diagnostics.records_dropped" for item in events))

    def test_queue_pressure_drops_debug_before_information(self) -> None:
        gate = threading.Event()

        class BlockingSession(DiagnosticsSession):
            def _write_record(self, record):
                gate.wait(5)
                super()._write_record(record)

        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw:
            session = BlockingSession(Path(raw) / "diagnostics", run_id="run-priority", mode="test")
            session.start()
            session.start_detailed_capture()
            for index in range(NORMAL_QUEUE_RECORDS):
                session.emit("native", "native.request_started",
                             request_id=f"native-{index}",
                             attributes={"method": "world.getSnapshot"},
                             deduplicate=False)
            session.emit("launcher", "startup.phase_started",
                         attributes={"phase": "desktop-frame-creation"},
                         deduplicate=False)
            self.assertGreaterEqual(session.summary["dropped"]["debug"], 1)
            self.assertEqual(session.summary["dropped"]["info"], 0)
            gate.set()
            session.close(outcome="success")

    def test_cli_reads_canonical_latest_run(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw:
            paths = Paths.from_repo_root(Path(raw))
            session = DiagnosticsSession(paths.diagnostics_root, run_id="run-cli", mode="test")
            session.start()
            session.emit("webview", "webview.process_failed",
                         attributes={"state": "failed", "code": "renderer_process_failed"})
            session.close(outcome="failure")
            output = io.StringIO()
            with redirect_stdout(output):
                result = cli.main(["diagnostics", "--json", "--level", "error", "--limit", "10"], paths=paths)
            self.assertEqual(result, cli.ExitCode.OK)
            records = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([record["event"] for record in records], ["webview.process_failed"])
            self.assertEqual(records[0]["schema"], DIAGNOSTIC_SCHEMA)

    def test_storage_failure_degrades_to_bounded_memory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw:
            blocked = Path(raw) / "diagnostics"
            blocked.write_text("not a directory", encoding="utf-8")
            session = DiagnosticsSession(blocked, run_id="run-memory", mode="test")
            session.start()
            self.assertTrue(session.storage_failed)
            self.assertTrue(any(record["event"] == "diagnostics.storage_failed"
                                for record in session.snapshot()))
            session.emit("host", "host.dispatch_failed",
                         attributes={"method": "project.importPack", "code": "failed"})
            self.assertLessEqual(len(session.snapshot()), 1000)
            session.close(outcome="failure")

    def test_stall_escalation_uses_safe_frames_and_emits_one_recovery(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra diagnostics ") as raw:
            source = Path(raw)
            session = DiagnosticsSession(source / "diagnostics", source_root=source,
                                         run_id="run-stall", mode="test")
            session.start()
            activity = session.begin_activity("host", "project.importPack",
                                              operation_id="operation-1",
                                              trace_id="trace-1")
            with session._state_lock:
                state = session._activities[activity.token]
                state.started -= 31
                state.last_progress -= 31
            deadline = time.monotonic() + 2.5
            while time.monotonic() < deadline:
                if any(record["event"] == "diagnostics.operation_stalled"
                       for record in session.snapshot()):
                    break
                time.sleep(0.05)
            stalled = [record for record in session.snapshot()
                       if record["event"] == "diagnostics.operation_stalled"]
            self.assertEqual(len(stalled), 1)
            self.assertTrue(stalled[0]["attributes"]["escalation"])
            self.assertLessEqual(len(stalled[0]["attributes"]["frames"]), 12)
            self.assertNotIn(str(source), json.dumps(stalled))
            activity.finish()
            recovered = [record for record in session.snapshot()
                         if record["event"] == "diagnostics.operation_recovered"]
            self.assertEqual(len(recovered), 1)
            session.close(outcome="success")


if __name__ == "__main__":
    unittest.main()
