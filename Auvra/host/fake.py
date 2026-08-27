"""Deterministic fake host for protocol and UI tests."""

from __future__ import annotations

import hashlib
import re
from typing import Any

from .dispatcher import HostDispatcher
from .session import SessionManager
from .validation import validate_message, validate_response


class FakeHost:
    def __init__(self, session_id: str = "fake-session-0001") -> None:
        self.session = SessionManager(session_id)
        self.dispatcher = HostDispatcher(self.session)
        self.events: list[dict[str, Any]] = []

    def request(self, request: dict[str, Any]) -> dict[str, Any]:
        return validate_response(self.dispatcher.dispatch(request))

    def emit_revision(self) -> dict[str, Any]:
        event = self.dispatcher.make_event("host.revision")
        self.events.append(validate_message(event))
        return event

    def emit_project_event(self, event_name: str, project_id: str = "fake-project-0001", **payload: Any) -> dict[str, Any]:
        """Emit a deterministic project lifecycle event for UI tests."""
        event = self.dispatcher.make_event(event_name, {"projectId": project_id, **payload})
        self.events.append(validate_message(event))
        return event

    def request_asset(self, *, method: str, url: str, origin: str, mime: str | None = None,
                      body: bytes | bytearray | memoryview | None = None, now: float = 0) -> dict[str, Any]:
        """Exercise the fake asset ticket lifecycle without filesystem access."""
        if origin != "https://assets.auvra.local":
            raise ValueError("asset_origin_denied")
        match = re.fullmatch(r"https://assets\.auvra\.local/v1/(get|put)/([A-Za-z0-9_-]{43})", url)
        if match is None:
            raise ValueError("asset_url_invalid")
        state = self.dispatcher._asset_tickets.get(match.group(2))
        if state is None or state["consumed"]:
            raise ValueError("asset_ticket_consumed")
        if now >= state.get("expiresAt", 300):
            raise ValueError("asset_ticket_expired")
        expected_method = "GET" if match.group(1) == "get" else "PUT"
        if method.upper() != expected_method or state.get("method") != expected_method:
            raise ValueError("asset_method_denied")
        if expected_method == "PUT":
            if mime != state["mime"] or body is None:
                raise ValueError("asset_mime_denied")
            value = bytes(body)
            if len(value) != state["size"]:
                raise ValueError("asset_size_invalid")
            asset_id = hashlib.sha256(value).hexdigest()
            state["sha256"] = asset_id
            state["consumed"] = True
            self.dispatcher._asset_ids.add(asset_id)
            return {"status": 204, "sha256": asset_id}
        state["consumed"] = True
        return {"status": 200, "sha256": state.get("sha256")}
