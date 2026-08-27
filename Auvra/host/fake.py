"""Deterministic fake host for protocol and UI tests."""

from __future__ import annotations

from typing import Any

from .dispatcher import HostDispatcher
from .session import SessionManager
from .validation import validate_response, validate_message


class FakeHost:
    def __init__(self, session_id: str = "fake-session-0001") -> None:
        self.session = SessionManager(session_id)
        self.dispatcher = HostDispatcher(self.session)
        self.events: list[dict[str, Any]] = []

    def request(self, request: dict[str, Any]) -> dict[str, Any]:
        return validate_response(self.dispatcher.dispatch(request))

    def emit_revision(self) -> dict[str, Any]:
        revision = self.session.advance()
        event = {"protocol":"auvra.host/1","type":"event","event":"host.revision",
                 "session":self.session.session_id,"revision":revision,"payload":{}}
        self.events.append(validate_message(event))
        return event
