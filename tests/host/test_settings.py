import unittest
from Auvra.host.settings import SettingsConflict, SettingsError, SettingsStore


class SettingsTests(unittest.TestCase):
    def test_allowlist_and_revision_conflict(self):
        store = SettingsStore({"theme": "dark"}, allowed_keys={"theme", "locale"}, defaults={"theme": "system"})
        self.assertEqual(store.snapshot()["values"]["theme"], "dark")
        with self.assertRaises(SettingsError): store.update({"path": "x"}, 0)
        self.assertEqual(store.update({"locale": "fr-FR"}, 0)["revision"], 1)
        with self.assertRaises(SettingsConflict): store.update({"theme": "light"}, 0)
    def test_values_are_bounded_json(self):
        store = SettingsStore(allowed_keys={"value"})
        cyclic = []; cyclic.append(cyclic)
        for value in (float("nan"), float("inf"), cyclic, {"x": "a" * 1025}, [0] * 65, {"x": 9007199254740992}):
            with self.assertRaises(SettingsError): store.update({"value": value}, store.revision)
