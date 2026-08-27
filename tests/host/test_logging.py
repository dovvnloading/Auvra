import json
import unittest
from Auvra.host.logging import DiagnosticRing, REDACTED, StructuredLogger, process_diagnostics, redact


class LoggingTests(unittest.TestCase):
    def test_recursive_redaction_and_bounds(self):
        result = redact({"api_key":"super-secret-value", "nested":{"authorization":"Bearer abcdefghijkl"}, "items":list(range(20))}, max_items=4)
        self.assertEqual(result["api_key"], REDACTED)
        self.assertEqual(result["nested"]["authorization"], REDACTED)
        self.assertLessEqual(len(result["items"]), 5)
    def test_logger_output_bound(self):
        lines = []; logger = StructuredLogger(lines.append, max_bytes=256)
        logger.emit("info", "test", {"message":"x" * 1000})
        self.assertLessEqual(len(lines[0].encode()), 256)
        self.assertEqual(json.loads(lines[0])["event"], "log.truncated")

    def test_diagnostic_ring_is_bounded_and_redacted(self):
        ring = DiagnosticRing(max_records=2, max_bytes=512)
        logger = StructuredLogger(ring=ring)
        logger.emit("error", "failure", {"fal_key": "fal-secret-value"})
        logger.emit("info", "second", {"message": "ok"})
        logger.emit("info", "third", {"message": "ok"})
        self.assertEqual(len(ring), 2)
        self.assertNotIn("fal-secret-value", json.dumps(ring.snapshot()))
        direct = DiagnosticRing(max_bytes=64 * 1024)
        direct.append({"event": "oversized", "message": "x" * 32 * 1024})
        self.assertLessEqual(len(json.dumps(direct.snapshot()[0], separators=(",", ":")).encode()), 8 * 1024)
        ring.clear()
        self.assertEqual(ring.snapshot(), [])

    def test_default_loggers_feed_the_process_support_ring(self):
        ring = process_diagnostics()
        ring.clear()
        StructuredLogger().emit("info", "host.ready", {"message": "ready"})
        self.assertEqual(ring.snapshot(), [{"level": "info", "event": "host.ready", "fields": {"message": "ready"}}])
        ring.clear()
