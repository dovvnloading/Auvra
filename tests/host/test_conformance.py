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

    def test_engine_capability_shape_is_exact(self):
        value = {
            "protocol": "auvra.host/1", "type": "response", "id": "caps",
            "session": "s1", "revision": 0, "ok": True,
            "result": {
                "protocol": "auvra.host/1",
                "methods": ["host.ping", "host.getCapabilities"],
                "projectMethods": ["project.getStatus", "project.create", "project.open", "project.openRecent", "project.close", "project.getSnapshot", "project.applyChanges", "project.save", "project.saveAs", "project.exportPack", "project.importPack", "project.importLegacy", "asset.beginUpload", "asset.resolve"],
                "providerMethods": ["provider.list", "provider.getStatus", "provider.configureCredential", "provider.deleteCredential", "provider.configure", "provider.listModels", "provider.health", "inference.submit", "inference.get", "inference.list", "inference.cancel", "inference.retry", "media.discard", "media.commit", "command.preview", "command.approve", "command.undo"],
                "engineMethods": ["engine.getStatus", "engine.getSnapshot", "engine.applyChanges", "engine.openViewport", "engine.closeViewport", "engine.renderReference", "engine.getMetrics", "engine.recover"],
            },
        }
        validate_message(value)
