import unittest
from Auvra.host.dispatcher import HostDispatcher
from Auvra.host.fake import FakeHost
from Auvra.host.session import SessionManager


class DispatcherTests(unittest.TestCase):
    def setUp(self): self.dispatcher = HostDispatcher(SessionManager("s1"))
    def request(self, **kwargs):
        value = {"protocol":"auvra.host/1","type":"request","id":"r1","session":"s1","revision":0,"method":"host.ping","payload":{}}
        value.update(kwargs); return value
    def test_success(self):
        response = self.dispatcher.dispatch(self.request())
        self.assertTrue(response["ok"]); self.assertEqual(response["result"], {"pong": True})
    def test_session_unknown_and_invalid(self):
        self.assertEqual(self.dispatcher.dispatch(self.request(session="other"))["error"]["code"], "session_mismatch")
        self.assertEqual(self.dispatcher.dispatch(self.request(method="host.nope"))["error"]["code"], "unknown_method")
        response = self.dispatcher.dispatch({"bad": object()})
        self.assertEqual(response["error"]["code"], "invalid_request")
        self.assertNotIn("traceback", str(response).lower())
    def test_malformed_id_and_revision_conflict_are_normalized(self):
        malformed = self.request(id={"secret": "do-not-leak"})
        response = self.dispatcher.dispatch(malformed)
        self.assertEqual(response["error"]["code"], "invalid_request")
        self.assertEqual(response["id"], "invalid")
        self.assertEqual(self.dispatcher.dispatch(self.request(revision=1))["error"]["code"], "revision_conflict")
    def test_fake_host_is_deterministic_and_validates_events(self):
        host = FakeHost()
        request = {"protocol":"auvra.host/1","type":"request","id":"r1","session":"fake-session-0001","revision":0,"method":"host.ping","payload":{}}
        self.assertEqual(host.request(request)["result"], {"pong": True})
        self.assertEqual(host.emit_revision()["revision"], 1)
        self.assertEqual(host.request(dict(request, revision=1))["revision"], 1)
