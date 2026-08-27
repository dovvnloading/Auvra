import json
import unittest
from pathlib import Path

from Auvra.host.validation import ProtocolValidationError, validate_message


ROOT = Path(__file__).resolve().parents[2]


class ConformanceTests(unittest.TestCase):
    def test_shared_vectors(self):
        vectors = json.loads((ROOT / "protocol/v1/conformance.json").read_text(encoding="utf-8"))
        for vector in vectors["valid"]:
            with self.subTest(vector["name"]):
                validate_message(vector["message"])
        for vector in vectors["invalid"]:
            with self.subTest(vector["name"]):
                with self.assertRaises(ProtocolValidationError):
                    validate_message(vector["message"])
