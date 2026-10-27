import unittest

from Auvra.project.schemas import _assert_known_nested


class FreeformNestedTests(unittest.TestCase):
    def test_component_props_may_use_names_that_nested_records_also_use(self):
        # A timeline's transform track keys its positions under "position", which as a nested
        # authored record elsewhere is the HUD layout {x, y}.
        timeline = {"duration": 5, "tracks": [{
            "id": "track", "kind": "transform", "targetId": "rock",
            "position": [{"time": 0, "value": [0, 0, 0], "interpolation": "linear"}],
            "scale": [{"time": 1, "value": [1, 2, 1], "interpolation": "step"}],
        }]}
        _assert_known_nested({"components": [{"id": "c", "type": "timeline", "enabled": True,
                                               "props": {"timeline": timeline, "size": [1, 2, 3]}}]})

    def test_records_outside_free_form_values_keep_their_keys(self):
        with self.assertRaisesRegex(ValueError, "unknown fields in position"):
            _assert_known_nested({"elements": [{"id": "e", "position": {"x": 0, "y": 0, "time": 1}}]})

    def test_free_form_values_keep_their_size_limit(self):
        with self.assertRaisesRegex(ValueError, "props exceeds property limit"):
            _assert_known_nested({"props": {f"key{index}": index for index in range(129)}})


if __name__ == "__main__":
    unittest.main()
