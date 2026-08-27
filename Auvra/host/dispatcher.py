"""Fail-closed versioned host request dispatcher.

The dispatcher owns protocol/session validation only.  Real project authority
is injected by the application host; the built-in project handlers are a
deterministic, in-memory implementation used by the fake host and protocol
tests.  No request ever contains or receives a filesystem path or binary data.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable
import re

from .logging import StructuredLogger
from .session import SessionManager
from .validation import ProtocolValidationError, validate_message, validate_request, validate_response

METHODS = (
    "host.ping", "host.getCapabilities", "project.getStatus", "project.create",
    "project.open", "project.openRecent", "project.close", "project.getSnapshot",
    "project.applyChanges", "project.save", "project.saveAs", "project.exportPack",
    "project.importPack", "project.importLegacy", "asset.beginUpload", "asset.resolve",
)
PROJECT_METHODS = METHODS[2:]
MUTATING_METHODS = frozenset({
    "project.create", "project.open", "project.openRecent", "project.close",
    "project.applyChanges", "project.save", "project.saveAs", "project.exportPack",
    "project.importPack", "project.importLegacy", "asset.beginUpload",
})
EVENTS = frozenset({
    "host.session", "host.revision", "project.status", "project.opening", "project.opened",
    "project.closing", "project.closed", "project.revision", "project.dirty",
    "project.readOnly", "project.progress", "project.recovery",
})
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


Handler = Callable[[dict[str, Any]], dict[str, Any]]


class HostDispatcher:
    def __init__(self, session: SessionManager | None = None,
                 logger: StructuredLogger | None = None,
                 methods: Mapping[str, Handler] | None = None) -> None:
        self.session = session or SessionManager()
        self.logger = logger or StructuredLogger()
        self._project_id = "fake-project-0001"
        self._project_revision = 0
        self._project_open = False
        self._project_dirty = False
        self._project_read_only = False
        self._project_service: Any = None
        self._asset_service: Any = None
        self._documents: dict[str, dict[str, Any]] = {}
        self._asset_tickets: dict[str, dict[str, Any]] = {}
        self._asset_ids: set[str] = set()
        self._methods: dict[str, Handler] = {
            "host.ping": lambda payload: {"pong": True},
            "host.getCapabilities": lambda payload: {
                "protocol": "auvra.host/1",
                "methods": ["host.ping", "host.getCapabilities"],
                "projectMethods": list(PROJECT_METHODS),
            },
            "project.getStatus": self._get_status,
            "project.create": self._create_project,
            "project.open": self._open_project,
            "project.openRecent": self._open_recent,
            "project.close": self._close_project,
            "project.getSnapshot": self._get_snapshot,
            "project.applyChanges": self._apply_changes,
            "project.save": self._save_project,
            "project.saveAs": self._save_as,
            "project.exportPack": self._export_pack,
            "project.importPack": self._import_pack,
            "project.importLegacy": self._import_legacy,
            "asset.beginUpload": self._begin_upload,
            "asset.resolve": self._resolve_asset,
        }
        if methods:
            self._methods.update(methods)

    def bind_services(self, *, project_service: Any = None, asset_service: Any = None) -> None:
        """Bind host-owned services without importing filesystem or desktop code.

        A service may expose ``handle(method, payload)`` or a method named after
        the protocol operation with dots replaced by underscores.  It returns a
        JSON-compatible result and may raise :class:`HostOperationError` for a
        typed, fail-closed protocol error.  Asset services are only used for
        ``asset.*`` methods; the project service is only used for ``project.*``.
        """
        self._project_service = project_service
        self._asset_service = asset_service

    def register_method(self, method: str, handler: Handler) -> None:
        """Inject one application-owned method without changing the protocol."""
        if method not in METHODS:
            raise ValueError("method is not part of protocol v1")
        self._methods[method] = handler

    def _response(self, request: dict[str, Any], *, result: dict[str, Any] | None = None,
                  code: str | None = None, message: str | None = None,
                  details: dict[str, Any] | None = None) -> dict[str, Any]:
        candidate_id = request.get("id", "invalid")
        safe_id = candidate_id if isinstance(candidate_id, str) and _ID.fullmatch(candidate_id) else "invalid"
        response: dict[str, Any] = {
            "protocol": "auvra.host/1", "type": "response", "id": safe_id,
            "session": self.session.session_id, "revision": self.session.revision, "ok": code is None,
        }
        if code is None:
            response["result"] = result or {}
        else:
            error: dict[str, Any] = {"code": code, "message": message or "Request failed"}
            if details:
                error["details"] = details
            response["error"] = error
        try:
            return validate_response(response)
        except ProtocolValidationError:
            safe = {"protocol": "auvra.host/1", "type": "response", "id": "invalid",
                    "session": self.session.session_id, "revision": self.session.revision,
                    "ok": False, "error": {"code": "invalid_response", "message": "Invalid host response"}}
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
        bound_handler = self._bound_handler(request["method"])
        handler = bound_handler or self._methods.get(request["method"])
        if handler is None:
            return self._response(request, code="unknown_method", message="Unknown host method")
        try:
            result = handler(request["payload"])
            # The native service owns project revisions, while this dispatcher
            # owns the host/session revision used to order messages.  Advance
            # it after a successful bound mutation and before response
            # validation so the response is the next authoritative revision.
            if bound_handler is not None and request["method"] in MUTATING_METHODS:
                self.session.advance()
            return self._response(request, result=result)
        except HostOperationError as error:
            return self._response(request, code=error.code, message=str(error), details=error.details)
        except Exception:
            self.logger.emit("error", "host.dispatch_failed", {"method": request["method"]})
            return self._response(request, code="internal_error", message="Host operation failed")

    def make_event(self, event_name: str, payload: Mapping[str, Any] | None = None,
                   *, advance: bool = True) -> dict[str, Any]:
        """Create and validate one host event envelope.

        Project events always carry the bounded status shape so consumers can
        hydrate from an event without relying on a preceding response.  The
        outer session revision is monotonic and independent of the project's
        own revision field.
        """
        if event_name not in EVENTS:
            raise ValueError("unsupported host event")
        if advance:
            self.session.advance()
        event_payload = dict(payload or {})
        if event_name.startswith("project."):
            defaults: dict[str, Any] = {
                "projectId": None, "revision": 0, "name": None, "dirty": False,
                "readOnly": False, "busy": False, "progress": None,
                "recoveryAvailable": False, "recentProjects": [], "status": "closed",
                "domains": {},
            }
            defaults.update(event_payload)
            event_payload = defaults
        event = {
            "protocol": "auvra.host/1", "type": "event", "event": event_name,
            "session": self.session.session_id, "revision": self.session.revision,
            "payload": event_payload,
        }
        return validate_message(event)

    def drain_bound_events(self) -> list[dict[str, Any]]:
        """Drain native service events into validated, ordered envelopes.

        A bound project or asset service may expose ``drain_events()`` and
        return ``(event_name, payload)`` pairs.  Events are converted here so
        the service never controls protocol/session metadata or filesystem
        authority.  Each drained event advances the host session revision.
        """
        envelopes: list[dict[str, Any]] = []
        seen: set[int] = set()
        for service in (self._project_service, self._asset_service):
            if service is None or id(service) in seen:
                continue
            seen.add(id(service))
            drain = getattr(service, "drain_events", None)
            if not callable(drain):
                continue
            for item in drain() or []:
                if not isinstance(item, (tuple, list)) or len(item) != 2:
                    raise ValueError("bound event must be (name, payload)")
                name, payload = item
                if not isinstance(name, str) or not isinstance(payload, Mapping):
                    raise ValueError("bound event has invalid shape")
                envelopes.append(self.make_event(name, payload))
        return envelopes

    def _bound_handler(self, method: str) -> Handler | None:
        service = self._project_service if method.startswith("project.") else self._asset_service if method.startswith("asset.") else None
        if service is None:
            return None
        candidate = getattr(service, "handle", None)
        if callable(candidate):
            return lambda payload: candidate(method, payload)
        name = method.replace(".", "_")
        candidate = getattr(service, name, None)
        if callable(candidate):
            return candidate
        def missing(payload: dict[str, Any]) -> dict[str, Any]:
            raise HostOperationError("internal_error", "Bound host service does not implement the method")
        return missing

    def _require_project(self, payload: dict[str, Any], *, expected: bool = False) -> None:
        if payload.get("projectId") != self._project_id:
            raise HostOperationError("invalid_project", "Project is not open")
        if not self._project_open:
            raise HostOperationError("invalid_project", "Project is not open")
        if expected and payload.get("expectedRevision") != self._project_revision:
            raise HostOperationError("revision_conflict", "Project revision does not match", {
                "projectId": self._project_id, "expectedRevision": payload.get("expectedRevision"),
                "actualRevision": self._project_revision,
            })
        if expected and self._project_read_only:
            raise HostOperationError("read_only", "Project is read-only")

    def _advance_project(self) -> None:
        self._project_revision += 1
        self._project_dirty = True
        self.session.advance()

    def _result(self, **values: Any) -> dict[str, Any]:
        return {"projectId": self._project_id, "revision": self._project_revision,
                "name": "Untitled", "readOnly": self._project_read_only,
                "dirty": self._project_dirty, "status": "open", **values}

    def _get_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id = payload.get("projectId")
        if project_id != self._project_id or not self._project_open:
            return {"projectId": None, "revision": 0, "name": None,
                    "readOnly": False, "dirty": False, "busy": False,
                    "progress": None, "recoveryAvailable": False,
                    "recentProjects": [], "status": "closed"}
        return self._result(busy=False, progress=None, recoveryAvailable=False, recentProjects=[])

    def _create_project(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._project_open = True
        self._project_read_only = False
        self._project_dirty = True
        self._project_revision = 0
        self._documents.clear()
        self.session.advance()
        return self._result(name=payload["name"])

    def _open_project(self, payload: dict[str, Any]) -> dict[str, Any]:
        handle = payload["projectHandle"]
        if handle == "locked":
            raise HostOperationError("locking", "Project is locked by another writer", {"retryable": False})
        if handle == "cancel":
            raise HostOperationError("cancelled", "Project open was cancelled")
        self._project_open = True
        self._project_read_only = handle == "readonly"
        self._project_dirty = False
        self.session.advance()
        return self._result(handle=handle)

    def _open_recent(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload["recentId"] == "missing":
            raise HostOperationError("invalid_project", "Recent project is unavailable")
        return self._open_project({"projectHandle": payload["recentId"]})

    def _close_project(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload, expected=True)
        self._project_open = False
        self._project_dirty = False
        self.session.advance()
        return {"projectId": self._project_id, "revision": self._project_revision,
                "status": "closed", "dirty": False, "readOnly": False}

    def _get_snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload)
        domain = payload.get("domain")
        docs = [doc for key, doc in sorted(self._documents.items()) if not domain or key.startswith(domain + ":")]
        page_size = payload.get("pageSize", 1000)
        offset = int(payload.get("cursor", "0") or 0)
        page = docs[offset:offset + page_size]
        next_offset = offset + len(page)
        return self._result(documents=page, cursor=str(next_offset) if next_offset < len(docs) else "", hasMore=next_offset < len(docs))

    def _apply_changes(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload, expected=True)
        for change in payload["changes"]:
            key = f"{change['domain']}:{change['documentId']}"
            if change["operation"] == "remove": self._documents.pop(key, None)
            else: self._documents[key] = change.get("document", {})
        self._advance_project()
        return self._result()

    def _save_project(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload, expected=True)
        self._project_dirty = False
        self.session.advance()
        return self._result(dirty=False)

    def _save_as(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload, expected=True)
        self._project_dirty = False
        self.session.advance()
        return self._result(name=payload["name"], dirty=False)

    def _export_pack(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload, expected=True)
        return self._result(handle="pack-0001")

    def _import_pack(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload["sourceHandle"] in {"invalid", "bomb"}:
            raise HostOperationError("invalid_project", "Project archive failed validation")
        self._project_open = True
        self._project_read_only = False
        self.session.advance()
        return self._result(handle=payload["sourceHandle"])

    def _import_legacy(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload["sourceHandle"] == "invalid":
            raise HostOperationError("migration_failed", "Legacy source could not be migrated")
        self._project_open = True
        self.session.advance()
        return self._result(report={"migrated": True})

    def _begin_upload(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload, expected=True)
        token = "A" * 43
        self._asset_tickets[token] = {"projectId": self._project_id, "size": payload["size"], "mime": payload["mime"], "name": payload["name"], "expiresAt": 300, "method": "PUT", "consumed": False}
        self._advance_project()
        return self._result(uploadId=token, size=payload["size"], mime=payload["mime"], method="PUT", expiresAt=300, url=f"https://assets.auvra.local/v1/put/{token}")

    def _resolve_asset(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload)
        if payload["assetId"] not in self._asset_ids:
            raise HostOperationError("invalid_project", "Asset is unavailable")
        token = "B" * 43
        self._asset_tickets[token] = {"projectId": self._project_id, "size": 0, "mime": "application/octet-stream", "name": "", "expiresAt": 300, "method": "GET", "consumed": False, "sha256": payload["assetId"]}
        return self._result(assetId=payload["assetId"], method="GET", expiresAt=300, url=f"https://assets.auvra.local/v1/get/{token}")


class HostOperationError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}
