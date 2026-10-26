from __future__ import annotations

import json
import re
import unittest

from jsonschema import Draft202012Validator

from Auvra.project.schemas import SCHEMA_DIR, _PROTOCOL_RESERVED_KEY

from tests.project.test_material_override_names import ALLOWED, RESERVED

ASSET = "a" * 64
WORDS = [
    "path", "filepath", "filesystempath", "sourcepath", "assetpath", "directorypath", "absolutepath", "localpath",
    "base64", "binary", "bytes", "blob", "credential", "credentials", "secret", "token", "apikey", "api_key",
    "api-key", "password", "authorization", "authheader", "auth_header", "auth-header", "file", "animationfiles",
    "object", "url",
]
# Python's re.I also folds these non-ASCII letters onto ASCII ones.
FOLDS = {"i": ["\u0130", "\u0131"], "s": ["\u017f"], "k": ["\u212a"]}


def _schema():
    return json.loads((SCHEMA_DIR / "models.schema.json").read_text(encoding="utf-8"))


def _corpus():
    names = set(RESERVED) | set(ALLOWED)
    for word in WORDS:
        names.update({word, word.upper(), word.title(), word.swapcase().title()})
        for index, letter in enumerate(word):
            for replacement in [letter.upper(), *FOLDS.get(letter, [])]:
                names.add(word[:index] + replacement + word[index + 1:])
        for affix in ("\n", "\n\n", "\r", "\r\n", " ", "_", "s", "0", "\t"):
            names.update({word + affix, affix + word, word.title() + affix})
        names.update({word[:-1], word + word, f"{word}|{word}", f"Metal {word}"})
    names.update({"", "api__key", "api_-key", "auth--header", "Body", "position", "\u0130", "\u212a"})
    return sorted(names)


class ModelsSchemaReservedNameTests(unittest.TestCase):
    def setUp(self):
        self.schema = _schema()
        self.validator = Draft202012Validator(self.schema)
        self.pattern = self.schema["$defs"]["reservedMaterialName"]["pattern"]

    def _document(self, **fields):
        return {"schemaVersion": 1, "documents": [{"id": "model", "name": "Robot.fbx", "assetId": ASSET, **fields}]}

    def test_schema_pattern_matches_exactly_the_python_blocklist(self):
        # jsonschema applies ``pattern`` with a flag-less re.search, the same as an ECMA RegExp without flags.
        for name in _corpus():
            with self.subTest(name=name):
                self.assertEqual(re.search(self.pattern, name) is not None, _PROTOCOL_RESERVED_KEY.search(name) is not None)

    def test_pattern_avoids_flag_and_anchor_dependent_syntax(self):
        self.assertNotIn("$", self.pattern)
        self.assertNotIn("(?i", self.pattern)
        self.assertLessEqual({c for c in self.pattern if ord(c) >= 128}, set("".join(sum(FOLDS.values(), []))))

    def test_schema_alone_rejects_reserved_override_keys(self):
        for name in RESERVED:
            with self.subTest(name=name):
                self.assertFalse(self.validator.is_valid(self._document(materialOverrides={name: {"opacity": 0.5}})))
                self.assertFalse(self.validator.is_valid(self._document(textureOverrides={name: "texture"})))

    def test_schema_alone_accepts_other_override_keys(self):
        for name in ALLOWED:
            with self.subTest(name=name):
                self.assertTrue(self.validator.is_valid(self._document(materialOverrides={name: {"opacity": 0.5}})))
                self.assertTrue(self.validator.is_valid(self._document(textureOverrides={name: "texture"})))


if __name__ == "__main__":
    unittest.main()
