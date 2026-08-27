import unittest
from dataclasses import replace
from Auvra.host.session import JSON_SAFE_REVISION_MAX, SessionManager


class SessionTests(unittest.TestCase):
    def test_deterministic_monotonic_revision(self):
        session = SessionManager("s1")
        self.assertEqual(session.envelope()["status"], "active")
        self.assertEqual([session.advance(), session.advance()], [1, 2])
        session.close(); self.assertEqual(session.state.status, "closed")
        with self.assertRaises(RuntimeError): session.advance()
    def test_invalid_session_is_rejected(self):
        with self.assertRaises(ValueError): SessionManager("bad session")
    def test_revision_safe_integer_guard(self):
        session = SessionManager("s1")
        session._state = replace(session.state, revision=JSON_SAFE_REVISION_MAX)
        with self.assertRaises(OverflowError): session.advance()
