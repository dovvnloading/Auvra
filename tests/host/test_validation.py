import unittest
from Auvra.host.validation import ProtocolValidationError, validate_message


class ValidationTests(unittest.TestCase):
    def test_non_object_and_unknown_fields_fail(self):
        for value in (None, [], {"protocol": "auvra.host/1"}):
            with self.assertRaises(ProtocolValidationError): validate_message(value)

    def test_bounds_and_unknown_method_fail(self):
        base = {"protocol":"auvra.host/1","type":"request","id":"x","session":"s","revision":0,"method":"host.ping","payload":{}}
        for key, value in (("revision", -1), ("id", ""), ("method", "host.nope")):
            candidate = dict(base); candidate[key] = value
            with self.assertRaises(ProtocolValidationError): validate_message(candidate)
        overflow = dict(base); overflow["revision"] = 9007199254740992
        with self.assertRaises(ProtocolValidationError): validate_message(overflow)

    def test_non_finite_and_authority_payloads_fail_closed(self):
        base = {"protocol":"auvra.host/1","type":"request","id":"r1","session":"s1","revision":0,"method":"host.ping","payload":{}}
        with self.assertRaises(ProtocolValidationError): validate_message({**base, "revision": float("nan")})
        with self.assertRaises(ProtocolValidationError): validate_message({**base, "payload": {"filePath": "C:/secret"}})
        with self.assertRaises(ProtocolValidationError): validate_message({**base, "payload": {"blob": b"secret"}})

    def test_pathfinding_key_is_not_confused_with_filesystem_authority(self):
        value = {"protocol":"auvra.host/1","type":"request","id":"r1","session":"s1","revision":0,
                 "method":"project.applyChanges","payload":{"projectId":"p1","expectedRevision":0,
                 "changes":[{"domain":"levels","documentId":"l1","operation":"upsert",
                              "document":{"pathfinding": True}}]}}
        validate_message(value)

    def test_encoded_message_limit_is_enforced(self):
        value = {"protocol":"auvra.host/1","type":"request","id":"r1","session":"s1","revision":0,
                 "method":"project.applyChanges","payload":{"projectId":"p1","expectedRevision":0,
                 "changes":[{"domain":"levels","documentId":"l1","operation":"upsert",
                              "document":{"description":"x" * (256 * 1024)}}]}}
        with self.assertRaises(ProtocolValidationError): validate_message(value)

    def test_engine_payloads_are_bounded_and_path_free(self):
        base = {"protocol": "auvra.host/1", "type": "request", "id": "r-engine",
                "session": "s1", "revision": 0, "method": "engine.applyChanges",
                "payload": {"expectedRevision": 0, "entities": [{
                    "id": "reference", "position": [0, 0, 0], "color": [0.2, 0.6, 1, 1],
                }]}}
        validate_message(base)
        path_entity = {**base, "payload": {**base["payload"], "entities": [{
            "id": "C:/secret", "position": [0, 0, 0], "color": [1, 1, 1, 1],
        }]}}
        with self.assertRaises(ProtocolValidationError): validate_message(path_entity)
        oversized = {**base, "payload": {**base["payload"], "entities": [{
            "id": "reference", "position": [0, 0, 0], "color": [1, 1, 1, 1],
            "extra": "x" * (256 * 1024),
        }]}}
        with self.assertRaises(ProtocolValidationError): validate_message(oversized)
