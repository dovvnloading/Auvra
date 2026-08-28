"""Strict, nonblocking WebView lane for browser runtime diagnostics."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import json
import math
import re
from typing import Any, Callable

from .core import (
    ATTRIBUTE_MAX_ITEMS,
    ARRAY_MAX_ITEMS,
    EVENT_CATALOG,
    STRING_MAX_CHARS,
    DiagnosticActivity,
    DiagnosticsSession,
    redact,
)


WEBVIEW_DIAGNOSTIC_PROTOCOL = "auvra.diagnostics/1"
WEBVIEW_BATCH_MAX_RECORDS = 16
WEBVIEW_BATCH_MAX_BYTES = 32 * 1024
WEBVIEW_QUERY_MAX_RECORDS = 100
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SAFE_TEXT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
_FILE_LIKE = re.compile(r"\.(?:fbx|gltf|glb|png|jpe?g|webp|wav|mp3|ogg|flac|auvra)$", re.IGNORECASE)
_BROWSER_COMPONENTS = frozenset({"frontend", "worker", "operation", "renderer"})
_TERMINAL_EVENTS = frozenset({"operation.completed", "operation.failed", "operation.cancelled"})


class DiagnosticLaneError(ValueError):
    """A diagnostics envelope failed its narrow contract."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class DiagnosticWebViewLane:
    """Validate browser evidence and feed it directly to the Python session."""

    def __init__(self, diagnostics: DiagnosticsSession | None, *, session_id: str,
                 post: Callable[[dict[str, Any]], None]) -> None:
        self.diagnostics = diagnostics
        self.session_id = session_id
        self._post = post
        self._activities: dict[str, DiagnosticActivity] = {}
        self._operation_traces: dict[str, str] = {}
        self._closed = False

    @staticmethod
    def recognizes(value: object) -> bool:
        return isinstance(value, Mapping) and value.get("protocol") == WEBVIEW_DIAGNOSTIC_PROTOCOL

    def handle(self, message: Mapping[str, Any], *, encoded_size: int) -> None:
        if self._closed:
            return
        message_id = message.get("id") if isinstance(message.get("id"), str) else None
        try:
            if encoded_size > WEBVIEW_BATCH_MAX_BYTES:
                raise DiagnosticLaneError("batch_too_large")
            kind = message.get("type")
            if kind == "event-batch":
                accepted = self._event_batch(message)
                if message_id is not None:
                    self._respond(message_id, True, {"accepted": accepted})
                return
            if kind == "heartbeat":
                self._heartbeat(message)
                return
            if kind == "query":
                self._require_session(message)
                self._query(message)
                return
            if kind == "command":
                self._require_session(message)
                self._command(message)
                return
            raise DiagnosticLaneError("unsupported_envelope")
        except DiagnosticLaneError as exc:
            if self.diagnostics is not None:
                self.diagnostics.emit(
                    "webview", "webview.message_rejected",
                    attributes={"code": exc.code},
                )
            if message_id is not None and _ID.fullmatch(message_id):
                self._respond(message_id, False, {"code": exc.code})

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for activity in tuple(self._activities.values()):
            activity.finish()
        self._activities.clear()
        self._operation_traces.clear()
        if self.diagnostics is not None:
            self.diagnostics.frontend_heartbeat(visibility="closing", active_count=0)

    def _event_batch(self, message: Mapping[str, Any]) -> int:
        self._exact_keys(message, {"protocol", "type", "id", "records", "failedDeliveryCount"})
        self._require_id(message.get("id"))
        records = message.get("records")
        if not isinstance(records, list) or not records or len(records) > WEBVIEW_BATCH_MAX_RECORDS:
            raise DiagnosticLaneError("invalid_batch_count")
        failed = message.get("failedDeliveryCount", 0)
        if not isinstance(failed, int) or isinstance(failed, bool) or failed < 0 or failed > 4096:
            raise DiagnosticLaneError("invalid_delivery_count")
        prepared = [self._prepare_event_record(raw) for raw in records]
        active = dict(self._operation_traces)
        for record in prepared:
            event = record["event"]
            component = record["component"]
            operation_id = record["operationId"]
            if event == "operation.started":
                trace_id = record["traceId"]
                if (operation_id is None or not isinstance(trace_id, str) or
                        operation_id in active or len(active) >= 64):
                    raise DiagnosticLaneError("invalid_operation_start")
                active[operation_id] = trace_id
            elif operation_id is not None and (event.startswith("operation.") or component == "worker"):
                if operation_id not in active:
                    raise DiagnosticLaneError("orphan_operation")
                if record["traceId"] != active[operation_id]:
                    raise DiagnosticLaneError("trace_mismatch")
            if event in _TERMINAL_EVENTS and operation_id is not None:
                active.pop(operation_id, None)
        if failed and self.diagnostics is not None:
            self.diagnostics.emit("diagnostics", "diagnostics.records_dropped",
                                  attributes={"droppedCount": failed}, deduplicate=False)
        for record in prepared:
            self._accept_event_record(record)
        return len(prepared)

    def _prepare_event_record(self, raw: object) -> dict[str, Any]:
        if not isinstance(raw, Mapping):
            raise DiagnosticLaneError("invalid_record")
        self._require_keys(raw, {"component", "event", "attributes"})
        self._exact_keys(raw, {"component", "event", "operationId", "traceId", "spanId",
                               "parentSpanId", "attributes"})
        component = raw.get("component")
        event = raw.get("event")
        if not isinstance(component, str) or component not in _BROWSER_COMPONENTS:
            raise DiagnosticLaneError("invalid_component")
        spec = EVENT_CATALOG.get(event) if isinstance(event, str) else None
        if spec is None or spec.component != component:
            raise DiagnosticLaneError("invalid_event")
        ids: dict[str, str | None] = {}
        for name in ("operationId", "traceId", "spanId", "parentSpanId"):
            value = raw.get(name)
            if value is not None:
                self._require_id(value)
            ids[name] = value if isinstance(value, str) else None
        attributes = self._attributes(raw.get("attributes", {}), spec.fields)
        operation_id = ids["operationId"]
        if event == "operation.started":
            operation_kind = attributes.get("operationKind")
            phase = attributes.get("phase")
            if not isinstance(operation_kind, str) or not isinstance(phase, str):
                raise DiagnosticLaneError("missing_operation_identity")
        return {
            "component": component,
            "event": event,
            "operationId": operation_id,
            "traceId": ids["traceId"],
            "spanId": ids["spanId"],
            "parentSpanId": ids["parentSpanId"],
            "attributes": attributes,
        }

    def _accept_event_record(self, record: Mapping[str, Any]) -> None:
        component = str(record["component"])
        event = str(record["event"])
        operation_id = record.get("operationId")
        attributes = record["attributes"]
        assert isinstance(attributes, Mapping)
        if event == "operation.started":
            operation_kind = attributes["operationKind"]
            phase = attributes["phase"]
            assert isinstance(operation_id, str)
            self._operation_traces[operation_id] = str(record["traceId"])
            if self.diagnostics is not None:
                activity = self.diagnostics.begin_activity(
                    "frontend", operation_kind, operation_id=operation_id,
                    trace_id=record.get("traceId"), capture_stack=False,
                )
                activity.progress(
                    phase=phase,
                    progress_bucket=self._progress_bucket(attributes),
                    worker_state=self._optional_text(attributes, "workerState"),
                    queue_state=self._optional_text(attributes, "queueState"),
                )
                self._activities[operation_id] = activity
        elif isinstance(operation_id, str):
            activity = self._activities.get(operation_id)
            if activity is not None:
                activity.progress(
                    phase=self._optional_text(attributes, "phase"),
                    progress_bucket=self._progress_bucket(attributes),
                    worker_state=self._optional_text(attributes, "workerState"),
                    queue_state=self._optional_text(attributes, "queueState"),
                )
        if self.diagnostics is not None:
            self.diagnostics.emit(
                component, event, session_id=self.session_id,
                operation_id=operation_id, trace_id=record.get("traceId"),
                span_id=record.get("spanId"), parent_span_id=record.get("parentSpanId"),
                attributes=attributes,
                deduplicate=event not in {"operation.started", *_TERMINAL_EVENTS},
            )
        if event in _TERMINAL_EVENTS and operation_id is not None:
            activity = self._activities.pop(operation_id, None)
            self._operation_traces.pop(operation_id, None)
            if activity is not None:
                activity.finish()

    def _heartbeat(self, message: Mapping[str, Any]) -> None:
        self._exact_keys(message, {"protocol", "type", "visibility", "activeCount"})
        visibility = message.get("visibility")
        active_count = message.get("activeCount")
        if visibility not in {"active", "hidden", "starting", "closing"}:
            raise DiagnosticLaneError("invalid_heartbeat_state")
        if not isinstance(active_count, int) or isinstance(active_count, bool) or not 0 <= active_count <= 64:
            raise DiagnosticLaneError("invalid_active_count")
        if self.diagnostics is not None:
            self.diagnostics.frontend_heartbeat(visibility=visibility, active_count=active_count)

    def _query(self, message: Mapping[str, Any]) -> None:
        self._exact_keys(message, {"protocol", "type", "id", "session", "level",
                                   "component", "trace", "limit"})
        self._require_keys(message, {"id", "session", "limit"})
        message_id = self._require_id(message.get("id"))
        limit = message.get("limit", WEBVIEW_QUERY_MAX_RECORDS)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= WEBVIEW_QUERY_MAX_RECORDS:
            raise DiagnosticLaneError("invalid_query_limit")
        level = message.get("level")
        component = message.get("component")
        trace = message.get("trace")
        for value in (level, component, trace):
            if value is not None and (not isinstance(value, str) or not _SAFE_TEXT.fullmatch(value)):
                raise DiagnosticLaneError("invalid_query_filter")
        records = [] if self.diagnostics is None else self.diagnostics.snapshot()
        if level is not None:
            records = [record for record in records if record.get("level") == level]
        if component is not None:
            records = [record for record in records if record.get("component") == component]
        if trace is not None:
            records = [record for record in records if record.get("traceId") == trace]
        self._respond(message_id, True, {"records": records[-limit:]})

    def _command(self, message: Mapping[str, Any]) -> None:
        self._exact_keys(message, {"protocol", "type", "id", "session", "command"})
        self._require_keys(message, {"id", "session", "command"})
        message_id = self._require_id(message.get("id"))
        command = message.get("command")
        if command == "capture.enable":
            if self.diagnostics is not None:
                self.diagnostics.start_detailed_capture(minutes=15)
        elif command == "capture.disable":
            if self.diagnostics is not None:
                self.diagnostics.stop_detailed_capture(reason="user")
        else:
            raise DiagnosticLaneError("unsupported_command")
        self._respond(message_id, True, {"capture": "detailed" if self.diagnostics and self.diagnostics.detailed else "concise"})

    def _require_session(self, message: Mapping[str, Any]) -> None:
        if message.get("session") != self.session_id:
            raise DiagnosticLaneError("session_mismatch")

    def _attributes(self, raw: object, allowed: frozenset[str]) -> dict[str, Any]:
        if not isinstance(raw, Mapping) or len(raw) > ATTRIBUTE_MAX_ITEMS:
            raise DiagnosticLaneError("invalid_attributes")
        result: dict[str, Any] = {}
        for key, value in raw.items():
            if not isinstance(key, str) or key not in allowed:
                raise DiagnosticLaneError("attribute_not_allowed")
            result[key] = self._attribute_value(key, value)
        return result

    def _attribute_value(self, key: str, value: object) -> Any:
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, int):
            if value < 0 or value > 9_007_199_254_740_991:
                raise DiagnosticLaneError("invalid_attribute_value")
            return value
        if isinstance(value, float):
            if not math.isfinite(value) or value < 0 or value > 9_007_199_254_740_991:
                raise DiagnosticLaneError("invalid_attribute_value")
            return value
        if isinstance(value, str):
            if (not value or len(value) > STRING_MAX_CHARS or
                    not _SAFE_TEXT.fullmatch(value) or _FILE_LIKE.search(value) or
                    redact(value, key=key) != value):
                raise DiagnosticLaneError("unsafe_attribute_value")
            return value
        if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray, str)):
            if len(value) > ARRAY_MAX_ITEMS:
                raise DiagnosticLaneError("invalid_attribute_array")
            return [self._attribute_value(key, item) for item in value]
        raise DiagnosticLaneError("invalid_attribute_value")

    def _respond(self, message_id: str, ok: bool, result: Mapping[str, Any]) -> None:
        self._post({
            "protocol": WEBVIEW_DIAGNOSTIC_PROTOCOL,
            "type": "response",
            "id": message_id,
            "ok": ok,
            "result": dict(result),
        })

    @staticmethod
    def _exact_keys(value: Mapping[str, Any], allowed: set[str]) -> None:
        if set(value) - allowed:
            raise DiagnosticLaneError("unexpected_field")

    @staticmethod
    def _require_keys(value: Mapping[str, Any], required: set[str]) -> None:
        if not required.issubset(value):
            raise DiagnosticLaneError("missing_field")

    @staticmethod
    def _require_id(value: object) -> str:
        if not isinstance(value, str) or not _ID.fullmatch(value):
            raise DiagnosticLaneError("invalid_id")
        return value

    @staticmethod
    def _progress_bucket(attributes: Mapping[str, Any]) -> int | None:
        value = attributes.get("progressBucket")
        return value if isinstance(value, int) and value in {0, 25, 50, 75, 100} else None

    @staticmethod
    def _optional_text(attributes: Mapping[str, Any], key: str) -> str | None:
        value = attributes.get(key)
        return value if isinstance(value, str) else None


def diagnostic_message_size(value: Mapping[str, Any]) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError):
        return WEBVIEW_BATCH_MAX_BYTES + 1
