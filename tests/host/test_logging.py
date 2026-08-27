import json
import unittest
from Auvra.host.logging import REDACTED, StructuredLogger, redact


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
