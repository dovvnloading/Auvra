"""Fail-closed versioned host request dispatcher.

The dispatcher owns protocol/session validation only.  Real project authority
is injected by the application host; the built-in project handlers are a
deterministic, in-memory implementation used by the fake host and protocol
tests.  No request ever contains or receives a filesystem path or binary data.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable
import hashlib
import re
import time

from Auvra.diagnostics.core import active_diagnostics, bind_diagnostic_context
from .logging import StructuredLogger
from .session import SessionManager
from .validation import ProtocolValidationError, validate_message, validate_request, validate_response

METHODS = (
    "host.ping", "host.getCapabilities", "project.getStatus", "project.create",
    "project.open", "project.openRecent", "project.close", "project.getSnapshot",
    "project.applyChanges", "project.save", "project.saveAs", "project.exportPack",
    "project.importPack", "project.importLegacy", "asset.beginUpload", "asset.resolve",
    "provider.list", "provider.getStatus", "provider.configureCredential",
    "provider.deleteCredential", "provider.configure", "provider.listModels",
    "provider.health", "inference.submit", "inference.get", "inference.list",
    "inference.cancel", "inference.retry", "media.discard", "media.commit",
    "command.preview", "command.approve", "command.undo",
    "engine.getStatus", "engine.getSnapshot", "engine.applyChanges",
    "engine.openViewport", "engine.closeViewport", "engine.renderReference",
    "engine.getMetrics", "engine.recover",
)
PROJECT_METHODS = METHODS[2:16]
PROVIDER_METHODS = METHODS[16:33]
ENGINE_METHODS = METHODS[33:]
MUTATING_METHODS = frozenset({
    "project.create", "project.open", "project.openRecent", "project.close",
    "project.applyChanges", "project.save", "project.saveAs", "project.exportPack",
    "project.importPack", "project.importLegacy", "asset.beginUpload",
    "media.commit", "command.approve", "command.undo",
    "engine.applyChanges", "engine.openViewport", "engine.closeViewport",
    "engine.recover",
})
_LONG_RUNNING_METHODS = frozenset({"inference.submit", "engine.renderReference"})
EVENTS = frozenset({
    "host.session", "host.revision", "project.status", "project.opening", "project.opened",
    "project.closing", "project.closed", "project.revision", "project.dirty",
    "project.readOnly", "project.progress", "project.recovery",
    "provider.job", "provider.status", "provider.progress", "provider.recovery",
    "engine.status", "engine.revision", "engine.viewport", "engine.recovery",
})
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_ENGINE_FEATURES = (
    "pbr_metallic_roughness", "skeletal_animation", "frustum_culling",
    "deterministic_lod", "instance_batching", "directional_lights",
    "point_lights", "spot_lights", "shadow_maps", "image_based_lighting",
    "entity_picking", "editor_gizmos", "hdr_intermediate",
    "aces_tone_mapping", "msaa_or_fxaa", "post_processing_chain",
)


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
        self._provider_service: Any = None
        self._engine_service: Any = None
        self._documents: dict[str, dict[str, Any]] = {}
        self._asset_tickets: dict[str, dict[str, Any]] = {}
        self._asset_ids: set[str] = set()
        self._provider_configured: set[str] = set()
        self._provider_settings: dict[str, dict[str, Any]] = {}
        self._provider_settings_revision: dict[str, int] = {}
        self._jobs: dict[str, dict[str, Any]] = {}
        self._proposals: dict[str, dict[str, Any]] = {}
        self._transactions: dict[str, dict[str, Any]] = {}
        self._engine_revision = 0
        self._engine_entities: list[dict[str, Any]] = []
        self._engine_viewport = "closed"
        self._engine_recoveries = 0
        self._methods: dict[str, Handler] = {
            "host.ping": lambda payload: {"pong": True},
            "host.getCapabilities": lambda payload: {
                "protocol": "auvra.host/1",
                "methods": ["host.ping", "host.getCapabilities"],
                "projectMethods": list(PROJECT_METHODS),
                "providerMethods": list(PROVIDER_METHODS),
                "engineMethods": list(ENGINE_METHODS),
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
                "provider.list": self._provider_list,
                "provider.getStatus": self._provider_status,
                "provider.configureCredential": self._configure_credential,
                "provider.deleteCredential": self._delete_credential,
                "provider.configure": self._configure_provider,
                "provider.listModels": self._list_models,
                "provider.health": self._provider_health,
                "inference.submit": self._submit_inference,
                "inference.get": self._get_job,
                "inference.list": self._list_jobs,
                "inference.cancel": self._cancel_job,
                "inference.retry": self._retry_job,
                "media.discard": self._discard_media,
                "media.commit": self._commit_media,
                "command.preview": self._preview_command,
                "command.approve": self._approve_command,
                "command.undo": self._undo_command,
                "engine.getStatus": self._engine_status,
                "engine.getSnapshot": self._engine_snapshot,
                "engine.applyChanges": self._engine_apply,
                "engine.openViewport": self._engine_open_viewport,
                "engine.closeViewport": self._engine_close_viewport,
                "engine.renderReference": self._engine_render_reference,
                "engine.getMetrics": self._engine_metrics,
                "engine.recover": self._engine_recover,
        }
        if methods:
            self._methods.update(methods)

    def bind_services(self, *, project_service: Any = None, asset_service: Any = None,
                      provider_service: Any = None, engine_service: Any = None) -> None:
        """Bind host-owned services without importing filesystem or desktop code.

        A service may expose ``handle(method, payload)`` or a method named after
        the protocol operation with dots replaced by underscores.  It returns a
        JSON-compatible result and may raise :class:`HostOperationError` for a
        typed, fail-closed protocol error.  Asset services are only used for
        ``asset.*`` methods; the project service is only used for ``project.*``.
        """
        self._project_service = project_service
        self._asset_service = asset_service
        self._provider_service = provider_service
        self._engine_service = engine_service

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
        method = request["method"]
        request_id = request["id"]
        trace_id = _diagnostic_trace_id(request_id)
        diagnostics = active_diagnostics()
        request_class = ("mutating" if method in MUTATING_METHODS else
                         "long-running" if method in _LONG_RUNNING_METHODS else "read")
        started = time.monotonic()
        activity = (diagnostics.begin_activity("host", method, request_id=request_id,
                                               trace_id=trace_id)
                    if diagnostics is not None else None)
        if activity is not None:
            activity.progress(queue_state="executing")
        persist_boundary = method in MUTATING_METHODS or method in _LONG_RUNNING_METHODS
        if diagnostics is not None and (persist_boundary or diagnostics.detailed):
            diagnostics.emit("host", "host.request_started", session_id=self.session.session_id,
                             request_id=request_id,
                             trace_id=trace_id,
                             attributes={"method": method, "requestClass": request_class})
        try:
            with bind_diagnostic_context(session_id=self.session.session_id,
                                         request_id=request_id, trace_id=trace_id):
                result = handler(request["payload"])
            # The native service owns project revisions, while this dispatcher
            # owns the host/session revision used to order messages.  Advance
            # it after a successful bound mutation and before response
            # validation so the response is the next authoritative revision.
            if bound_handler is not None and method in MUTATING_METHODS:
                self.session.advance()
            if diagnostics is not None and (persist_boundary or diagnostics.detailed):
                diagnostics.emit("host", "host.request_completed", session_id=self.session.session_id,
                                 request_id=request_id,
                                 trace_id=trace_id,
                                 attributes={
                                     "method": method, "requestClass": request_class,
                                     "outcome": "success",
                                     "durationMs": round((time.monotonic() - started) * 1000, 3),
                                     "revision": self.session.revision,
                                 })
            return self._response(request, result=result)
        except HostOperationError as error:
            if diagnostics is not None:
                diagnostics.emit("host", "host.request_failed", session_id=self.session.session_id,
                                 request_id=request_id,
                                 trace_id=trace_id,
                                 attributes={
                                     "method": method, "requestClass": request_class,
                                     "outcome": "failure", "code": error.code,
                                     "errorType": type(error).__name__,
                                     "durationMs": round((time.monotonic() - started) * 1000, 3),
                                 })
            return self._response(request, code=error.code, message=str(error), details=error.details)
        except Exception as error:
            if diagnostics is not None:
                diagnostics.emit("host", "host.dispatch_failed", session_id=self.session.session_id,
                                 request_id=request_id,
                                 trace_id=trace_id,
                                 attributes={
                                     "method": method, "requestClass": request_class,
                                     "outcome": "failure", "code": "internal_error",
                                     "errorType": type(error).__name__,
                                     "durationMs": round((time.monotonic() - started) * 1000, 3),
                                 })
            else:
                self.logger.emit("error", "host.dispatch_failed", {"method": method})
            return self._response(request, code="internal_error", message="Host operation failed")
        finally:
            if activity is not None:
                activity.finish()

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
        elif event_name.startswith("provider."):
            defaults = {
                "providerId": "unknown", "status": "queued", "progress": None,
                "attempt": 1, "retryable": False,
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
        for service in (self._project_service, self._asset_service, self._provider_service, self._engine_service):
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
        service = (self._project_service if method.startswith("project.") else
                   self._asset_service if method.startswith("asset.") else
                   self._provider_service if (method.startswith("provider.") or method.startswith("inference.") or method.startswith("media.") or method.startswith("command.")) else None)
        if method.startswith("engine."):
            service = self._engine_service
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

    # Provider handlers are intentionally deterministic and provider-neutral.
    # Production adapters bind through ``provider_service``; these handlers
    # make protocol and UI tests useful without network access or secrets.
    _PROVIDERS = (
        ("fal", "fal.ai", "cloud", ("media.generate", "media.edit")),
        ("openai", "OpenAI", "cloud", ("text", "code", "commands")),
        ("anthropic", "Anthropic", "cloud", ("text", "code", "commands")),
        ("xai", "xAI", "cloud", ("text", "code", "commands")),
        ("openrouter", "OpenRouter", "cloud", ("text", "code", "commands")),
        ("ollama", "Ollama", "local", ("text", "code", "commands")),
        ("llama.cpp", "llama.cpp", "local", ("text", "code", "commands")),
    )

    def _provider_info(self, provider_id: str) -> tuple[str, str, str, tuple[str, ...]]:
        for item in self._PROVIDERS:
            if item[0] == provider_id:
                return item
        raise HostOperationError("provider_unavailable", "Provider is not registered")

    def _provider_list(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"kind": "provider.list", "providers": [
            {"providerId": pid, "displayName": name, "route": route,
             "capabilities": list(capabilities), "features": ["cancel", "structured_output"],
             "requiresCredential": route == "cloud",
             "configured": route == "local" or pid in self._provider_configured,
             "available": True}
            for pid, name, route, capabilities in self._PROVIDERS
        ]}

    def _provider_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        pid, _name, route, _capabilities = self._provider_info(payload["providerId"])
        configured = route == "local" or pid in self._provider_configured
        settings = self._provider_settings.get(pid, {
            "enabled": False, "routes": [], "fallbackPolicy": "none",
            "requireCostConfirmation": True,
            "budgets": {"perJobMicroUsd": 0, "dailyMicroUsd": 0, "monthlyMicroUsd": 0},
        })
        public_settings = {key: value for key, value in settings.items() if key != "endpoint"}
        public_settings["endpointConfigured"] = bool(settings.get("endpoint"))
        return {"kind": "provider.status", "providerId": pid, "configured": configured,
                "available": True, "healthy": configured, "state": "ready" if configured else "unconfigured",
                "settings": public_settings,
                "settingsRevision": self._provider_settings_revision.get(pid, 0),
                "credentialStatus": "notRequired" if route == "local" else ("configured" if configured else "absent")}

    def _configure_credential(self, payload: dict[str, Any]) -> dict[str, Any]:
        pid, _name, _route, _capabilities = self._provider_info(payload["providerId"])
        self._provider_configured.add(pid)
        return {"kind": "provider.credential", "providerId": pid,
                "storageMode": payload["storageMode"], "configured": True,
                "credentialStatus": "memoryOnly" if payload["storageMode"] == "memoryOnly" else "configured"}

    def _delete_credential(self, payload: dict[str, Any]) -> dict[str, Any]:
        pid, _name, _route, _capabilities = self._provider_info(payload["providerId"])
        self._provider_configured.discard(pid)
        return self._provider_status({"providerId": pid})

    def _configure_provider(self, payload: dict[str, Any]) -> dict[str, Any]:
        pid, _name, _route, _capabilities = self._provider_info(payload["providerId"])
        # Settings contain only non-secret values by schema and validation.
        current = self._provider_settings_revision.get(pid, 0)
        if payload["expectedSettingsRevision"] != current:
            raise HostOperationError("revision_conflict", "Provider settings revision does not match")
        self._provider_settings[pid] = dict(payload["settings"])
        self._provider_settings_revision[pid] = current + 1
        return self._provider_status({"providerId": pid})

    def _list_models(self, payload: dict[str, Any]) -> dict[str, Any]:
        pid, _name, _route, capabilities = self._provider_info(payload["providerId"])
        selected = payload.get("capability")
        if selected and selected not in capabilities:
            return {"kind": "provider.models", "providerId": pid, "models": []}
        return {"kind": "provider.models", "providerId": pid, "models":[
            {"modelId": f"{pid}.default", "displayName": "Default", "capabilities": list(capabilities)}
        ]}

    def _provider_health(self, payload: dict[str, Any]) -> dict[str, Any]:
        pid, _name, route, _capabilities = self._provider_info(payload["providerId"])
        return {"kind": "provider.health", "providerId": pid,
                "healthy": route == "local" or pid in self._provider_configured, "latencyMs": 0,
                "message": "deterministic fake host"}

    def _check_inference_route(self, payload: dict[str, Any]) -> None:
        pid, _name, route, capabilities = self._provider_info(payload["providerId"])
        if payload["route"] != route:
            raise HostOperationError("endpoint_denied", "Provider route does not match explicit request")
        if payload["capability"] not in capabilities:
            raise HostOperationError("unsupported_capability", "Provider does not support capability")
        if route == "cloud" and pid not in self._provider_configured:
            raise HostOperationError("provider_not_configured", "Provider credential is not configured")

    def _submit_inference(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload)
        if payload["expectedRevision"] != self._project_revision:
            raise HostOperationError("revision_conflict", "Project revision does not match", {
                "projectId": self._project_id, "expectedRevision": payload["expectedRevision"],
                "actualRevision": self._project_revision})
        self._check_inference_route(payload)
        if payload.get("targetElementId") is not None and payload["capability"] != "commands":
            raise HostOperationError("unsupported_capability", "targetElementId is valid only for command jobs")
        job_id = f"job-{len(self._jobs) + 1:08d}"
        job = {"jobId": job_id, "providerId": payload["providerId"], "modelId": payload["modelId"],
               "capability": payload["capability"], "route": payload["route"], "status": "succeeded",
               "progress": 1, "attempt": 1, "_projectId": self._project_id}
        if payload["capability"] in {"text", "code"}:
            job["outputText"] = "deterministic fake response"
        if payload["capability"] == "commands":
            proposal_id = f"proposal-{len(self._proposals) + 1:08d}"
            self._proposals[proposal_id] = {"projectId": self._project_id, "changes": [{
                "domain": "assistant", "documentId": "proposal-1", "operation": "upsert",
                "document": {"approved": True}}]}
            job["proposalAvailable"] = True
            job["proposalId"] = proposal_id
        if payload["capability"].startswith("media."):
            preview_id = hashlib.sha256(f"{job_id}:preview".encode("utf-8")).hexdigest()
            job["preview"] = {"previewAssetId": preview_id, "mime": "image/png", "size": 1,
                               "dimensions": {"width": 1, "height": 1}}
        self._jobs[job_id] = job
        return {"kind": "inference.submit", "job": self._public_job(job)}

    @staticmethod
    def _public_job(job: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in job.items() if not key.startswith("_")}

    def _get_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload)
        job = self._jobs.get(payload["jobId"])
        if job is None or job.get("_projectId") != payload["projectId"]:
            raise HostOperationError("invalid_job", "Inference job is unavailable")
        return {"kind": "inference.get", "job": self._public_job(job)}

    def _list_jobs(self, payload: dict[str, Any]) -> dict[str, Any]:
        jobs = list(self._jobs.values())
        if payload.get("projectId") and payload["projectId"] != self._project_id:
            jobs = []
        if payload.get("status"):
            jobs = [job for job in jobs if job["status"] == payload["status"]]
        limit = payload.get("limit", 100)
        offset = int(payload.get("cursor", "0") or 0)
        page = jobs[offset:offset + limit]
        next_offset = offset + len(page)
        return {"kind": "inference.list", "jobs": [self._public_job(job) for job in page],
                "cursor": str(next_offset) if next_offset < len(jobs) else "", "hasMore": next_offset < len(jobs)}

    def _cancel_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload)
        job = self._jobs.get(payload["jobId"])
        if job is None or job.get("_projectId") != payload["projectId"]:
            raise HostOperationError("invalid_job", "Inference job is unavailable")
        job["status"] = "cancelled"
        job["progress"] = None
        return {"kind": "inference.cancel", "job": self._public_job(job)}

    def _retry_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_project(payload, expected=True)
        job = self._jobs.get(payload["jobId"])
        if job is None or job.get("_projectId") != payload["projectId"]:
            raise HostOperationError("invalid_job", "Inference job is unavailable")
        if payload["expectedRevision"] != self._project_revision:
            raise HostOperationError("revision_conflict", "Project revision does not match")
        if job["status"] not in {"failed", "cancelled"} or job["attempt"] >= 8:
            raise HostOperationError("invalid_job", "Job is not retryable")
        job["attempt"] += 1
        job["status"] = "queued"
        job["progress"] = 0
        return {"kind": "inference.retry", "job": self._public_job(job)}

    def _require_media(self, payload: dict[str, Any]) -> None:
        self._require_project(payload)
        if payload.get("expectedRevision") is not None and payload["expectedRevision"] != self._project_revision:
            raise HostOperationError("revision_conflict", "Project revision does not match")

    def _discard_media(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_media(payload)
        job = self._jobs.get(payload["jobId"])
        if job is None or job.get("preview", {}).get("previewAssetId") != payload["previewAssetId"]:
            raise HostOperationError("invalid_job", "Media preview is unavailable")
        return {"kind": "media.discard", "projectId": self._project_id,
                "projectRevision": self._project_revision, "jobId": payload["jobId"],
                "previewAssetId": payload["previewAssetId"]}

    def _commit_media(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_media(payload)
        job = self._jobs.get(payload["jobId"])
        if job is None or job.get("status") != "succeeded" or job.get("preview", {}).get("previewAssetId") != payload["previewAssetId"]:
            raise HostOperationError("invalid_job", "Media job is not complete")
        self._advance_project()
        asset_id = hashlib.sha256(payload["previewAssetId"].encode("utf-8")).hexdigest()
        return {"kind": "media.commit", "projectId": self._project_id,
                "projectRevision": self._project_revision, "jobId": payload["jobId"],
                "previewAssetId": payload["previewAssetId"], "assetId": asset_id,
                "provenance": {"providerId": "fal", "modelId": "fal.default",
                    "jobId": payload["jobId"], "createdAt": 0,
                    "routeOrigin": "cloud", "routeConsent": "explicit",
                    "promptSha256": hashlib.sha256(payload["previewAssetId"].encode("utf-8")).hexdigest(),
                    "settingsSha256": hashlib.sha256(b"fake-settings").hexdigest(),
                    "artifactSha256": asset_id, "inputAssetIds": []}}

    def _preview_command(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_media(payload)
        job = self._jobs.get(payload["jobId"])
        if job is None or job.get("status") != "succeeded" or not job.get("proposalAvailable"):
            raise HostOperationError("invalid_job", "Job has no validated command proposal")
        proposal_id = str(job["proposalId"])
        proposal = self._proposals.get(proposal_id)
        if proposal is None:
            raise HostOperationError("invalid_command", "Command proposal is unavailable")
        changes = proposal["changes"]
        diff = [{"domain": change["domain"], "documentId": change["documentId"],
                 "operation": change["operation"], "summary": f"{change['operation']} {change['domain']}"}
                for change in changes]
        return {"kind": "command.preview", "projectId": self._project_id,
                "projectRevision": self._project_revision, "proposalId": proposal_id, "diff": diff}

    def _approve_command(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_media(payload)
        proposal = self._proposals.pop(payload["proposalId"], None)
        if proposal is None:
            raise HostOperationError("approval_required", "Command proposal is unavailable")
        for change in proposal["changes"]:
            key = f"{change['domain']}:{change['documentId']}"
            if change["operation"] == "remove": self._documents.pop(key, None)
            else: self._documents[key] = change.get("document", {})
        self._advance_project()
        transaction_id = f"transaction-{len(self._transactions) + 1:08d}"
        self._transactions[transaction_id] = {"changes": proposal["changes"]}
        return {"kind": "command.approve", "projectId": self._project_id,
                "projectRevision": self._project_revision, "transactionId": transaction_id}

    def _undo_command(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_media(payload)
        if payload["transactionId"] not in self._transactions:
            raise HostOperationError("invalid_command", "Transaction is unavailable")
        self._transactions.pop(payload["transactionId"])
        self._advance_project()
        return {"kind": "command.undo", "projectId": self._project_id,
                "projectRevision": self._project_revision, "transactionId": payload["transactionId"]}

    def _engine_result(self, kind: str, **values: Any) -> dict[str, Any]:
        return {
            "kind": kind,
            "protocol": "auvra.native/1",
            "status": "ready",
            "worldRevision": self._engine_revision,
            "tick": 0,
            "projectId": self._project_id if self._project_open else None,
            "projectRevision": self._project_revision if self._project_open else 0,
            "worldHash": "0" * 64,
            "replayHash": "0" * 64,
            "extractionHash": "0" * 64,
            "viewport": self._engine_viewport,
            "backend": "WebGL2 fake fallback",
            "adapter": "deterministic fake host",
            "fallbackReason": "Native engine process is not started in browser development mode",
            "featureCapabilities": [
                {"feature": feature, "supported": False,
                 "fallbackReason": f"{feature} is unavailable in the deterministic browser fake"}
                for feature in _ENGINE_FEATURES
            ],
            "dockSupport": "unsupported",
            "dockActive": False,
            "dockReason": "Docking requires the same-build desktop host and native engine",
            **values,
        }

    def _engine_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._engine_result("engine.status")

    def _engine_snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._engine_result("engine.snapshot", entities=[dict(value) for value in self._engine_entities])

    def _engine_apply(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload["expectedRevision"] != self._engine_revision:
            raise HostOperationError("revision_conflict", "Native world revision does not match", {
                "expectedRevision": payload["expectedRevision"], "actualRevision": self._engine_revision,
            })
        self._engine_entities = [dict(value) for value in payload["entities"]]
        self._engine_revision += 1
        return self._engine_result("engine.applyChanges", entities=[dict(value) for value in self._engine_entities])

    def _engine_open_viewport(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._engine_viewport = "open"
        return self._engine_result("engine.openViewport")

    def _engine_close_viewport(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._engine_viewport = "closed"
        return self._engine_result("engine.closeViewport")

    def _engine_render_reference(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._engine_result(
            "engine.renderReference", referenceScene="basic", referenceVersion=1,
            signature="47ed61f4e0a9caba",
            width=payload.get("width", 64), height=payload.get("height", 64),
        )

    def _engine_metrics(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._engine_result("engine.metrics", metrics={
            "startupMs": 0, "frameCpuMs": 0, "gpuFrameMs": None,
            "memoryBytes": 0, "recoveryCount": self._engine_recoveries,
        })

    def _engine_recover(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._engine_recoveries += 1
        return self._engine_result("engine.recover", metrics={
            "startupMs": 0, "frameCpuMs": 0, "gpuFrameMs": None,
            "memoryBytes": 0, "recoveryCount": self._engine_recoveries,
        })


class HostOperationError(RuntimeError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _diagnostic_trace_id(request_id: str) -> str:
    candidate, marker, suffix = request_id.partition(".req-")
    if marker and suffix.isdigit() and _ID.fullmatch(candidate):
        return candidate
    return request_id
