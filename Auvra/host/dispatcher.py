"""Fail-closed request dispatcher for the minimal host capability set."""

from __future__ import annotations

from typing import Any, Callable
import re

from .logging import StructuredLogger
from .session import SessionManager
from .validation import ProtocolValidationError, validate_request, validate_response


class HostDispatcher:
    def __init__(self, session: SessionManager | None = None, logger: StructuredLogger | None = None) -> None:
        self.session = session or SessionManager()
        self.logger = logger or StructuredLogger()
        self._methods: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
            "host.ping": lambda payload: {"pong": True},
            "host.getCapabilities": lambda payload: {"protocol": "auvra.host/1", "methods": ["host.ping", "host.getCapabilities"]},
        }

    def _response(self, request: dict[str, Any], *, result: dict[str, Any] | None = None,
                  code: str | None = None, message: str | None = None) -> dict[str, Any]:
        candidate_id = request.get("id", "invalid")
        safe_id = candidate_id if isinstance(candidate_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", candidate_id) else "invalid"
        response: dict[str, Any] = {"protocol": "auvra.host/1", "type": "response", "id": safe_id,
                                    "session": self.session.session_id, "revision": self.session.revision, "ok": code is None}
        if code is None:
            response["result"] = result or {}
        else:
            response["error"] = {"code": code, "message": message or "Request failed"}
        try:
            return validate_response(response)
        except ProtocolValidationError:
            safe = {"protocol":"auvra.host/1","type":"response","id":"invalid","session":self.session.session_id,
                    "revision":self.session.revision,"ok":False,"error":{"code":"invalid_response","message":"Invalid host response"}}
            return validate_response(safe)

    def dispatch(self, raw_request: Any) -> dict[str, Any]:
        request_id = raw_request.get("id", "invalid") if isinstance(raw_request, dict) else "invalid"
        if isinstance(raw_request, dict) and raw_request.get("type") == "request":
            method = raw_request.get("method")
            if isinstance(method, str) and method not in self._methods:
                return self._response(raw_request, code="unknown_method", message="Unknown host method")
        try:
            request = validate_request(raw_request)
        except ProtocolValidationError:
            return self._response({"id": request_id}, code="invalid_request", message="Invalid host request")
        if request["session"] != self.session.session_id:
            return self._response(request, code="session_mismatch", message="Session does not match")
        if request["revision"] != self.session.revision:
            return self._response(request, code="revision_conflict", message="Host revision does not match")
        handler = self._methods.get(request["method"])
        if handler is None:
            return self._response(request, code="unknown_method", message="Unknown host method")
        try:
            return self._response(request, result=handler(request["payload"]))
        except Exception:
            self.logger.emit("error", "host.dispatch_failed", {"method": request["method"]})
            return self._response(request, code="internal_error", message="Host operation failed")
