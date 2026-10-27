import unittest

from Auvra.project.schemas import domain_document, validate_domain


def _graph(**state_fields):
    return {
        "id": "g1",
        "modelId": "m1",
        "variables": [{"id": "v1", "name": "Speed", "type": "Float", "value": 0}],
        "inputs": [],
        "states": [
            {
                "id": "s1", "name": "Walk", "position": {"x": 0, "y": 0}, "loop": True, "isRoot": True,
                "stateType": "Blend1D", "clipName": None, "blendParamX": "v1", "blendParamY": "",
                "blendSamples": [{"id": "b1", "clipName": "Walk", "position": [0, 0]}],
                **state_fields,
            }
        ],
        "transitions": [
            {
                "id": "t1", "fromStateId": "s1", "toStateId": "s1", "duration": 0.2,
                "conditions": [{"variableId": "v1", "operator": ">", "value": 0}],
                "conditionMode": "any", "anyState": True, "priority": 10,
            }
        ],
        "activeStateId": "s1",
    }


class AnimationGraphSchemaTests(unittest.TestCase):
    def test_accepts_playback_notify_root_motion_and_transition_fields(self):
        graph = _graph(playRate=1.5, playRateParam="v1", rootMotion=True,
                       notifies=[{"id": "n1", "name": "Footstep", "time": 0.25}])
        validate_domain("graphs", domain_document("graphs", [graph]))

    def test_rejects_unknown_notify_fields(self):
        graph = _graph(notifies=[{"id": "n1", "name": "Footstep", "time": 0.25, "sound": "x"}])
        with self.assertRaisesRegex(ValueError, "unknown fields in notifies"):
            validate_domain("graphs", domain_document("graphs", [graph]))

    def test_accepts_blueprint_ik_settings(self):
        blueprint = {"id": "bp1", "name": "Hero", "type": "Player Character",
                     "ik": {"footIK": True, "footMaxStep": 0.4, "lookAt": "camera", "lookAtBone": "Head", "lookAtMaxAngle": 60}}
        validate_domain("blueprints", domain_document("blueprints", [blueprint]))

    def test_rejects_bad_blueprint_ik_settings(self):
        blueprint = {"id": "bp1", "name": "Hero", "type": "Player Character", "ik": {"lookAt": "moon"}}
        with self.assertRaises(Exception):
            validate_domain("blueprints", domain_document("blueprints", [blueprint]))


if __name__ == "__main__":
    unittest.main()
