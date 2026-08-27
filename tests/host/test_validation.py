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
