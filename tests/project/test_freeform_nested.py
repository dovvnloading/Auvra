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

    def test_a_sky_keeps_its_day_length_fog_mode_and_weather(self):
        weather = {"preset": "storm", "clouds": 1, "rain": 1, "snow": 0, "fog": 0.25, "wind": 13, "windDirection": 60, "lightning": 8}
        _assert_known_nested({"skyConfig": {"timeOfDay": 18, "dayLength": 24, "fogMode": "sky", "shadowDistance": 300, "model": "atmosphere", "preset": "sunset", "sunTilt": 20, "sunSize": 1.5, "atmosphere": {"rayleigh": 1, "rayleighTint": "#ffffff", "haze": 2, "hazeGlow": 0.8, "ozone": 1, "ground": "#6b5f4e", "brightness": 1}, "cloudLayer": {"quality": "medium", "altitude": 1500, "thickness": 1500, "density": 1, "detail": 0.5, "scale": 1, "shadows": 0.7}, "night": {"moonPhase": 0.5, "moonSize": 2, "moonBrightness": 0.2, "stars": 1, "milkyWay": 1, "glow": "#0e182a"}, "skyLight": {"enabled": True, "source": "sky", "capture": "live", "resolution": 128, "intensity": 1, "tint": "#ffffff", "reflections": 1, "lowerSolid": False, "lowerColor": "#3b352c", "occlusion": 1, "occlusionFloor": 0.06, "occlusionRange": 128}, "panorama": {"textureId": "sky", "rotation": 0, "brightness": 1}, "weather": weather}})
        with self.assertRaisesRegex(ValueError, "unknown fields in weather"):
            _assert_known_nested({"skyConfig": {"weather": {**weather, "hail": 1}}})

    def test_free_form_values_keep_their_size_limit(self):
        with self.assertRaisesRegex(ValueError, "props exceeds property limit"):
            _assert_known_nested({"props": {f"key{index}": index for index in range(129)}})


if __name__ == "__main__":
    unittest.main()
