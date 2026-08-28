"""Deterministic host session and revision identity."""

from __future__ import annotations

from dataclasses import dataclass
import re

from Auvra.diagnostics.core import trace_public_class

_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
JSON_SAFE_REVISION_MAX = 9007199254740991


@dataclass(frozen=True)
class SessionState:
    session_id: str
    revision: int = 0
    status: str = "active"


@trace_public_class("host_session", concise=("advance", "close"))
class SessionManager:
    def __init__(self, session_id: str = "session-0001") -> None:
        if not _SESSION_ID.fullmatch(session_id):
            raise ValueError("invalid session id")
        self._state = SessionState(session_id=session_id)

    @property
    def session_id(self) -> str:
        return self._state.session_id

    @property
    def revision(self) -> int:
        return self._state.revision

    @property
    def state(self) -> SessionState:
        return self._state

    def advance(self) -> int:
        if self._state.status == "closed":
            raise RuntimeError("session is closed")
        if self.revision >= JSON_SAFE_REVISION_MAX:
            raise OverflowError("session revision exceeds JSON safe integer")
        self._state = SessionState(self.session_id, self.revision + 1, self._state.status)
        return self.revision

    def close(self) -> None:
        self._state = SessionState(self.session_id, self.revision, "closed")

    def envelope(self) -> dict[str, object]:
        from .validation import validate_message
        return validate_message({"protocol": "auvra.host/1", "type": "session", "session": self.session_id,
                                 "revision": self.revision, "status": self._state.status})
