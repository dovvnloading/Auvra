from __future__ import annotations

import re
import unittest

from Auvra.host.validation import ProtocolValidationError, _check_json_safe
from Auvra.project.schemas import domain_document, validate_domain

ASSET = "a" * 64

# The editor's sanitizeJson key list (fbx-viewer (1)/utils/projectService.ts).
_EDITOR_FORBIDDEN_KEY = re.compile(
    r"^(?:file|animationFiles|object|url|path|filePath|sourcePath|localPath|assetPath|directoryPath|filesystemPath"
    r"|absolutePath|base64|binary|bytes|blob)$",
    re.I,
)

# Names either protocol layer refuses as a JSON key, in assorted casings.
RESERVED = [
    "Path", "PATH", "FilePath", "FilesystemPath", "sourcePath", "AssetPath", "DirectoryPath", "AbsolutePath",
    "LocalPath", "base64", "Binary", "Bytes", "Blob",
    "Credential", "Credentials", "Secret", "Token", "API_KEY", "api-key", "ApiKey", "Password",
    "Authorization", "auth_header", "AuthHeader", "File", "animationFiles", "Object", "URL",
]
ALLOWED = ["Body", "Path_Stone", "Pathway", "Tokens", "Objects", "File01", "Metal Blob", "position"]


def _models(**fields):
    return domain_document("models", [{"id": "model", "name": "Robot.fbx", "assetId": ASSET, **fields}])


def _protocol_rejects(name):
    if _EDITOR_FORBIDDEN_KEY.search(name):
        return True
    try:
        _check_json_safe({name: 1})
    except ProtocolValidationError:
        return True
    return False


class MaterialOverrideNameTests(unittest.TestCase):
    def test_names_the_protocol_cannot_carry_are_rejected(self):
        for name in RESERVED:
            with self.subTest(name=name):
                self.assertTrue(_protocol_rejects(name))
                with self.assertRaisesRegex(ValueError, "materialOverrides cannot use the material name"):
                    validate_domain("models", _models(materialOverrides={name: {"opacity": 0.5}}))
                with self.assertRaisesRegex(ValueError, "textureOverrides cannot use the material name"):
                    validate_domain("models", _models(textureOverrides={name: "texture"}))

    def test_other_names_are_accepted(self):
        for name in ALLOWED:
            with self.subTest(name=name):
                self.assertFalse(_protocol_rejects(name))
                validate_domain("models", _models(materialOverrides={name: {"opacity": 0.5}}))
                validate_domain("models", _models(textureOverrides={name: "texture"}))


if __name__ == "__main__":
    unittest.main()
