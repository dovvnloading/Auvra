"""One local, bounded diagnostics stream for launcher and runtime components."""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
import contextvars
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import wraps
import hashlib
import inspect
import json
import os
from pathlib import Path
import queue
import re
import secrets
import sys
import threading
import time
from typing import Any, Callable, ParamSpec, TypeVar


DIAGNOSTIC_SCHEMA = "auvra.diagnostics/1"
REDACTED = "[REDACTED]"
OMITTED = "[OMITTED]"
TRUNCATED = "[TRUNCATED]"
RECORD_MAX_BYTES = 2 * 1024
STRING_MAX_CHARS = 256
ATTRIBUTE_MAX_ITEMS = 16
ARRAY_MAX_ITEMS = 16
STACK_MAX_FRAMES = 12
PROFILE_CODE_CACHE_MAX = 4096
PROFILE_SUMMARY_MAX = 2048
PROFILE_STACK_MAX = 256
NORMAL_QUEUE_RECORDS = 1024
PRIORITY_QUEUE_RECORDS = 128
RING_MAX_RECORDS = 1000
RING_MAX_BYTES = 2 * 1024 * 1024
SEGMENT_MAX_BYTES = 1024 * 1024
RUN_MAX_SEGMENTS = 5
RUN_MAX_BYTES = SEGMENT_MAX_BYTES * RUN_MAX_SEGMENTS
RUN_RETENTION_SECONDS = 7 * 24 * 60 * 60
RUN_MAX_COUNT = 20
# Reserve one MiB inside the 25 MiB diagnostics-directory ceiling for the
# latest/current manifests, bounded crash markers, and atomic-write overhead.
RUN_TOTAL_MAX_BYTES = 24 * 1024 * 1024
DETAILED_CAPTURE_SECONDS = 15 * 60
DEDUP_WINDOW_SECONDS = 10.0
WRITER_FLUSH_SECONDS = 0.25
RUN_MARKER_NAME = "current-run.json"
LATEST_RUN_NAME = "latest-run.json"

_LEVELS = ("debug", "info", "warning", "error", "critical")
_LEVEL_ORDER = {name: index for index, name in enumerate(_LEVELS)}
_EVENT_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$")
_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SECRET_KEY = re.compile(
    r"(?:pass(?:word)?|secret|token|api[_-]?key|anon[_-]?key|access[_-]?key|"
    r"fal[_-]?key|authorization|credential|bearer|cookie|private[_-]?key)", re.I,
)
_FORBIDDEN_KEY = re.compile(
    r"^(?:payload|prompt|response|output|body|document|documents|asset|assets|"
    r"content|binary|base64|blob|path|file|filename|filepath|filesystempath|"
    r"sourcepath|assetpath|directory|directorypath|absolutepath|localpath|url|"
    r"uri|headers?|environment|shader|screenshot|dump)$", re.I,
)
_BEARER = re.compile(r"\bBearer\s+[^\s,;]+", re.I)
_AUTHORIZATION = re.compile(r"(?i)(\bauthorization\s*[:=]\s*)([^\r\n,;]+)")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(\b[\w.-]*(?:api[_-]?key|anon[_-]?key|access[_-]?key|private[_-]?key|"
    r"fal[_-]?key|token|password|secret|credential)[\w.-]*\b\s*[:=]\s*)"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_URL_CREDENTIALS = re.compile(r"(?i)(https?://)([^/@\s:]+):([^/@\s]+)@")
_URL = re.compile(r"(?i)\b(?:https?|file|data)://[^\s\"']+")
_WINDOWS_PATH = re.compile(r"(?i)(?:[a-z]:[\\/]|\\\\)[^\s\"']*")
_POSIX_PATH = re.compile(r"(?<![A-Za-z0-9._-])/(?:[^\s\"']+/)*[^\s\"']+")
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_CONTEXT: contextvars.ContextVar[dict[str, str]] = contextvars.ContextVar(
    "auvra_diagnostic_context", default={},
)


@dataclass(frozen=True)
class EventSpec:
    component: str
    default_level: str
    fields: frozenset[str]


_COMMON = frozenset({
    "phase", "outcome", "durationMs", "code", "errorType", "method", "status",
    "success", "exitCode", "returnCode", "port", "preferredPort", "fallback",
    "timeoutMs", "queueDepth", "queueCapacity", "revision", "worldRevision",
    "processRole", "runtimeKind", "backend", "adapter", "fallbackReason",
    "protocol", "count", "bytes", "droppedCount", "repeatCount",
    "segment", "operationKind", "stallMs", "escalation", "thread", "frames",
    "acknowledged", "reason", "mode", "minutes", "runState", "recordEvent",
    "initial", "source", "state", "requestClass", "clean", "interrupted",
    "assetAlias", "assetKind", "mimeCategory", "extensionCategory", "itemCount",
    "clipCount", "bindingMode", "progressBucket", "workerState", "queueState",
    "activeCount", "visibility", "averageFrameMs", "p95FrameMs", "budgetMs",
    "failedDeliveryCount", "batchCount", "surfaceRole",
    "subsystem", "action", "codeSite", "category", "threadRole",
    "taskKind", "resultClass", "callCount", "totalDurationMs",
    "maxDurationMs", "slowThresholdMs",
    "commitCount", "totalRenderMs", "maxRenderMs",
})
_STARTUP = frozenset({
    "phase", "outcome", "durationMs", "code", "errorType", "success", "port",
    "preferredPort", "fallback", "runtimeKind", "state", "initial",
})
_REQUEST = frozenset({
    "method", "outcome", "durationMs", "code", "errorType", "timeoutMs",
    "queueDepth", "queueCapacity", "revision", "requestClass", "success",
})
_LIFECYCLE = frozenset({
    "state", "code", "errorType", "success", "durationMs", "runtimeKind",
    "initial", "source", "returnCode", "acknowledged", "protocol", "reason",
    "timeoutMs",
})
_DIAGNOSTIC = _COMMON


def _spec(component: str, level: str, fields: frozenset[str] = _COMMON) -> EventSpec:
    return EventSpec(component, level, fields | frozenset({"repeatCount"}))


EVENT_CATALOG: dict[str, EventSpec] = {
    "run.started": _spec("launcher", "info", frozenset({"mode", "runState"})),
    "run.ready": _spec("launcher", "info", frozenset({"durationMs", "mode"})),
    "run.ending": _spec("launcher", "info", frozenset({"outcome", "exitCode", "interrupted"})),
    "run.ended": _spec("launcher", "info", frozenset({"outcome", "exitCode", "durationMs", "clean"})),
    "run.unclean_previous": _spec("launcher", "warning", frozenset({"runState", "code"})),
    "startup.phase_started": _spec("launcher", "info", _STARTUP),
    "startup.phase_completed": _spec("launcher", "info", _STARTUP),
    "startup.phase_failed": _spec("launcher", "error", _STARTUP),
    "child.started": _spec("launcher", "info", _LIFECYCLE | frozenset({"processRole", "port"})),
    "child.ready": _spec("launcher", "info", _LIFECYCLE | frozenset({"processRole", "port"})),
    "child.output_warning": _spec("launcher", "warning", frozenset({"processRole", "code", "repeatCount"})),
    "child.exited": _spec("launcher", "warning", _LIFECYCLE | frozenset({"processRole"})),
    "child.cleanup_failed": _spec("launcher", "error", _LIFECYCLE | frozenset({"processRole"})),
    "webview.lifecycle": _spec("webview", "info", _LIFECYCLE),
    "webview.message_rejected": _spec("webview", "warning", frozenset({"code", "reason", "count"})),
    "webview.policy_rejected": _spec("webview", "warning", frozenset({"code", "reason", "count"})),
    "webview.process_failed": _spec("webview", "error", _LIFECYCLE),
    "host.request_started": _spec("host", "info", _REQUEST),
    "host.request_completed": _spec("host", "info", _REQUEST),
    "host.request_failed": _spec("host", "error", _REQUEST),
    "host.request_timed_out": _spec("host", "error", _REQUEST),
    "host.queue_wait": _spec("host", "debug", frozenset({"method", "durationMs", "queueState"})),
    "host.queue_saturated": _spec("host", "warning", _REQUEST),
    "host.worker_failed": _spec("host", "error", _REQUEST),
    "host.dispatch_failed": _spec("host", "error", _REQUEST),
    "native.lifecycle": _spec("native", "info", _LIFECYCLE),
    "native.request_started": _spec("native", "debug", _REQUEST),
    "native.request_completed": _spec("native", "debug", _REQUEST),
    "native.request_failed": _spec("native", "error", _REQUEST),
    "native.request_timed_out": _spec("native", "error", _REQUEST),
    "native.protocol_rejected": _spec("native", "error", _REQUEST | frozenset({"reason"})),
    "native.diagnostic_invalid": _spec("native", "warning", frozenset({"code", "reason", "count"})),
    "native.child_record": _spec("native", "info", frozenset({"state", "code", "source", "revision", "method", "phase", "outcome", "durationMs"})),
    "native.child_warning": _spec("native", "warning", frozenset({"state", "code", "source", "revision", "method", "phase", "outcome", "durationMs"})),
    "native.child_error": _spec("native", "error", frozenset({"state", "code", "source", "revision", "method", "phase", "outcome", "durationMs"})),
    "diagnostics.capture_started": _spec("diagnostics", "info", frozenset({"mode", "minutes"})),
    "diagnostics.capture_ended": _spec("diagnostics", "info", frozenset({"mode", "reason"})),
    "diagnostics.records_dropped": _spec("diagnostics", "warning", _DIAGNOSTIC),
    "diagnostics.record_rejected": _spec("diagnostics", "warning", _DIAGNOSTIC),
    "diagnostics.storage_failed": _spec("diagnostics", "error", _DIAGNOSTIC),
    "diagnostics.operation_stalled": _spec("diagnostics", "warning", _DIAGNOSTIC),
    "diagnostics.operation_recovered": _spec("diagnostics", "info", _DIAGNOSTIC),
    "diagnostics.support_exported": _spec("diagnostics", "info", frozenset({"count", "bytes"})),
    "diagnostics.support_export_failed": _spec("diagnostics", "error", frozenset({"code", "errorType"})),
    "frontend.session_started": _spec("frontend", "info", frozenset({"state", "visibility"})),
    "frontend.global_error": _spec("frontend", "error", frozenset({"code", "errorType"})),
    "frontend.unhandled_rejection": _spec("frontend", "error", frozenset({"code", "errorType"})),
    "frontend.transport_failed": _spec("frontend", "error", frozenset({"code", "errorType", "method", "timeoutMs"})),
    "frontend.failure": _spec("frontend", "error", _COMMON),
    "frontend.warning": _spec("frontend", "warning", frozenset({"code", "count"})),
    "frontend.event_loop_stalled": _spec("frontend", "warning", frozenset({"durationMs", "visibility"})),
    "frontend.event_loop_recovered": _spec("frontend", "info", frozenset({"durationMs"})),
    "frontend.unresponsive": _spec("frontend", "warning", frozenset({"stallMs", "activeCount", "visibility"})),
    "frontend.responsive": _spec("frontend", "info", frozenset({"durationMs", "activeCount"})),
    "worker.phase": _spec("worker", "info", frozenset({"phase", "workerState", "queueState", "assetAlias", "progressBucket", "itemCount", "clipCount"})),
    "worker.failed": _spec("worker", "error", frozenset({"phase", "workerState", "assetAlias", "code", "errorType"})),
    "operation.started": _spec("operation", "info", _COMMON),
    "operation.phase": _spec("operation", "info", _COMMON),
    "operation.progress": _spec("operation", "info", _COMMON),
    "operation.completed": _spec("operation", "info", _COMMON),
    "operation.failed": _spec("operation", "error", _COMMON),
    "operation.cancelled": _spec("operation", "info", _COMMON),
    "renderer.backend_selected": _spec("renderer", "info", frozenset({"backend", "fallback", "fallbackReason", "surfaceRole"})),
    "renderer.backend_failed": _spec("renderer", "error", frozenset({"backend", "fallback", "code", "errorType", "surfaceRole"})),
    "renderer.context_lost": _spec("renderer", "error", frozenset({"code", "surfaceRole"})),
    "renderer.recovery_started": _spec("renderer", "warning", frozenset({"code", "count", "surfaceRole"})),
    "renderer.recovered": _spec("renderer", "info", frozenset({"durationMs", "count", "surfaceRole"})),
    "renderer.recovery_failed": _spec("renderer", "error", frozenset({"backend", "code", "surfaceRole"})),
    "renderer.capture_failed": _spec("renderer", "error", frozenset({"code", "errorType"})),
    "renderer.performance_degraded": _spec("renderer", "warning", frozenset({"averageFrameMs", "p95FrameMs", "budgetMs", "count", "surfaceRole"})),
    "renderer.performance_recovered": _spec("renderer", "info", frozenset({"durationMs", "surfaceRole"})),
    "activity.started": _spec("activity", "info", _COMMON),
    "activity.phase": _spec("activity", "info", _COMMON),
    "activity.completed": _spec("activity", "info", _COMMON),
    "activity.failed": _spec("activity", "error", _COMMON),
    "activity.cancelled": _spec("activity", "info", _COMMON),
    "runtime.function_summary": _spec("runtime", "debug", _COMMON),
    "runtime.function_completed": _spec("runtime", "debug", _COMMON),
    "runtime.react_summary": _spec("runtime", "debug", _COMMON),
    "runtime.coverage_ready": _spec("runtime", "info", frozenset({"count", "category", "mode"})),
}

_P = ParamSpec("_P")
_R = TypeVar("_R")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _redact_text(value: str, max_string: int = STRING_MAX_CHARS) -> str:
    value = _ANSI.sub("", value)
    value = _AUTHORIZATION.sub(r"\1" + REDACTED, value)
    value = _BEARER.sub(REDACTED, value)
    value = _URL_CREDENTIALS.sub(r"\1" + REDACTED + "@", value)
    value = _SECRET_ASSIGNMENT.sub(r"\1" + REDACTED, value)
    value = _URL.sub("[REDACTED_URL]", value)
    value = _WINDOWS_PATH.sub("[REDACTED_PATH]", value)
    value = _POSIX_PATH.sub("[REDACTED_PATH]", value)
    return value if len(value) <= max_string else value[:max(0, max_string - len(TRUNCATED))] + TRUNCATED


def redact(value: Any, *, max_depth: int = 4, max_items: int = ATTRIBUTE_MAX_ITEMS,
           max_string: int = STRING_MAX_CHARS, key: str = "",
           omit_forbidden: bool = True) -> Any:
    """Return a bounded, path-free copy safe for local persistence and export."""

    if omit_forbidden and _FORBIDDEN_KEY.fullmatch(key):
        return OMITTED
    if _SECRET_KEY.search(key):
        return REDACTED
    if max_depth < 0:
        return TRUNCATED
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else None
    if isinstance(value, str):
        return _redact_text(value, max_string)
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for index, (raw_key, item) in enumerate(value.items()):
            if index >= max_items:
                result[TRUNCATED] = True
                break
            safe_key = _redact_text(str(raw_key), 64)
            result[safe_key] = redact(item, max_depth=max_depth - 1, max_items=max_items,
                                      max_string=max_string, key=str(raw_key),
                                      omit_forbidden=omit_forbidden)
        return result
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        items = list(value)
        array_limit = max(0, min(max_items, ARRAY_MAX_ITEMS))
        result = [redact(item, max_depth=max_depth - 1, max_items=max_items,
                         max_string=max_string, key=key,
                         omit_forbidden=omit_forbidden) for item in items[:array_limit]]
        if len(items) > array_limit:
            result.append(TRUNCATED)
        return result
    return _redact_text(type(value).__name__, max_string)


def _is_link_or_reparse(path: Path) -> bool:
    try:
        if not path.exists() and not path.is_symlink():
            return False
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            return True
        return bool(getattr(path.stat(), "st_file_attributes", 0) & 0x400)
    except (AttributeError, OSError, RuntimeError):
        return True


def safe_diagnostics_root(root: Path) -> Path:
    """Create and return an exact diagnostics directory without following links."""

    root = Path(root).expanduser().absolute()
    current = Path(root.anchor)
    for component in root.parts[1:]:
        current /= component
        if current.exists() or current.is_symlink():
            if _is_link_or_reparse(current):
                raise OSError("diagnostics path cannot contain links or reparse points")
    if root.exists() and not root.is_dir():
        raise OSError("diagnostics path is not a regular directory")
    root.mkdir(parents=True, exist_ok=True)
    if _is_link_or_reparse(root) or not root.is_dir():
        raise OSError("diagnostics directory is unsafe")
    return root


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp")
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                fd = -1
                json.dump(value, stream, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            if fd >= 0:
                os.close(fd)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


@contextmanager
def bind_diagnostic_context(*, session_id: str | None = None,
                            request_id: str | None = None,
                            trace_id: str | None = None,
                            operation_id: str | None = None,
                            span_id: str | None = None,
                            parent_span_id: str | None = None) -> Iterator[None]:
    current = dict(_CONTEXT.get())
    for key, value in (("sessionId", session_id), ("requestId", request_id),
                       ("traceId", trace_id), ("operationId", operation_id),
                       ("spanId", span_id), ("parentSpanId", parent_span_id)):
        safe = _safe_id(value)
        if safe is not None:
            current[key] = safe
    token = _CONTEXT.set(current)
    try:
        yield
    finally:
        _CONTEXT.reset(token)


def current_diagnostic_context() -> dict[str, str]:
    return dict(_CONTEXT.get())


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


class DiagnosticRing:
    """Thread-safe bounded memory evidence for live inspection."""

    def __init__(self, *, max_records: int = RING_MAX_RECORDS,
                 max_bytes: int = RING_MAX_BYTES) -> None:
        if not isinstance(max_records, int) or max_records < 1:
            raise ValueError("diagnostic record bound must be positive")
        if not isinstance(max_bytes, int) or max_bytes < 256:
            raise ValueError("diagnostic byte bound is too small")
        self.max_records = max_records
        self.max_bytes = max_bytes
        self._records: list[tuple[dict[str, Any], int]] = []
        self._bytes = 0
        self._lock = threading.RLock()

    def append(self, record: Mapping[str, Any]) -> None:
        safe = redact(dict(record), max_depth=5)
        if not isinstance(safe, dict):
            return
        encoded = json.dumps(safe, ensure_ascii=True, separators=(",", ":"))
        size = len(encoded.encode("utf-8"))
        if size > RECORD_MAX_BYTES:
            safe = {"schema": DIAGNOSTIC_SCHEMA, "level": "warning",
                    "component": "diagnostics", "event": "diagnostics.record_rejected"}
            size = len(json.dumps(safe, separators=(",", ":")).encode("utf-8"))
        with self._lock:
            self._records.append((safe, size))
            self._bytes += size
            while len(self._records) > self.max_records or self._bytes > self.max_bytes:
                _removed, removed_size = self._records.pop(0)
                self._bytes -= removed_size

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(record) for record, _size in self._records]

    def clear(self) -> None:
        with self._lock:
            self._records.clear()
            self._bytes = 0

    def __len__(self) -> int:
        with self._lock:
            return len(self._records)


class _NormalRecordQueue:
    """Bounded nonblocking queue that always sacrifices debug before info."""

    def __init__(self, max_records: int) -> None:
        from collections import deque

        self.max_records = max_records
        self._debug = deque()
        self._info = deque()
        self._lock = threading.Lock()

    def put_nowait(self, record: dict[str, Any]) -> dict[str, Any] | None:
        level = str(record.get("level", "info"))
        with self._lock:
            total = len(self._debug) + len(self._info)
            displaced = None
            if total >= self.max_records:
                if level != "debug" and self._debug:
                    displaced = self._debug.popleft()
                else:
                    raise queue.Full
            (self._debug if level == "debug" else self._info).append(record)
            return displaced

    def displace_for_priority(self, record: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            if self._debug:
                displaced = self._debug.popleft()
            elif self._info:
                displaced = self._info.popleft()
            else:
                return None
            self._info.append(record)
            return displaced

    def get_nowait(self) -> dict[str, Any]:
        with self._lock:
            if self._info:
                return self._info.popleft()
            if self._debug:
                return self._debug.popleft()
            raise queue.Empty

    def task_done(self) -> None:
        return None

    def empty(self) -> bool:
        return self.qsize() == 0

    def qsize(self) -> int:
        with self._lock:
            return len(self._debug) + len(self._info)


@dataclass
class _DedupState:
    started: float
    last: float
    count: int
    record: dict[str, Any]


@dataclass
class _ActiveState:
    token: str
    component: str
    kind: str
    operation_id: str | None
    request_id: str | None
    trace_id: str | None
    thread_id: int
    started: float
    last_progress: float
    stall_after: float
    phase: str | None = None
    progress_bucket: int | None = None
    worker_state: str | None = None
    queue_state: str | None = None
    capture_stack: bool = True
    warned: bool = False
    escalated: bool = False


class DiagnosticActivity:
    """Opaque active-operation token used by the stall monitor."""

    def __init__(self, session: "DiagnosticsSession", token: str) -> None:
        self._session = session
        self.token = token
        self._finished = False

    def progress(self, *, phase: str | None = None, progress_bucket: int | None = None,
                 worker_state: str | None = None, queue_state: str | None = None) -> None:
        if not self._finished:
            self._session.touch_activity(
                self.token, phase=phase, progress_bucket=progress_bucket,
                worker_state=worker_state, queue_state=queue_state,
            )

    def finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        self._session.finish_activity(self.token)

    def __enter__(self) -> "DiagnosticActivity":
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.finish()


class DiagnosticSpan:
    """Hierarchical, privacy-safe runtime span with bounded stall tracking."""

    def __init__(self, session: "DiagnosticsSession", subsystem: str, action: str, *,
                 operation_id: str | None = None, trace_id: str | None = None,
                 parent_span_id: str | None = None, detailed_only: bool = False,
                 stall_after: float = 5.0, category: str = "operation") -> None:
        context = current_diagnostic_context()
        self._session = session
        self.subsystem = _stable_token(subsystem, "runtime")
        self.action = _stable_token(action, "call")
        self.category = _stable_token(category, "operation")
        self.operation_id = _safe_id(operation_id) or context.get("operationId")
        self.trace_id = (_safe_id(trace_id) or context.get("traceId") or
                         f"trace-{secrets.token_urlsafe(12)}")
        self.parent_span_id = (_safe_id(parent_span_id) or context.get("spanId") or
                               context.get("parentSpanId"))
        self.span_id = f"span-{secrets.token_urlsafe(10)}"
        self._started = time.monotonic()
        self._detailed_only = bool(detailed_only)
        self._recording = not self._detailed_only or session.detailed
        self._activity = session.begin_activity(
            self.subsystem, f"{self.subsystem}.{self.action}",
            operation_id=self.operation_id, trace_id=self.trace_id,
            stall_after=stall_after, capture_stack=True,
        ) if self._recording else None
        self._context_manager: Any = None
        self._closed = False
        self._failed = False

    @property
    def context(self) -> dict[str, str]:
        result = {"traceId": self.trace_id, "spanId": self.span_id}
        if self.parent_span_id:
            result["parentSpanId"] = self.parent_span_id
        if self.operation_id:
            result["operationId"] = self.operation_id
        return result

    def __enter__(self) -> "DiagnosticSpan":
        self._context_manager = bind_diagnostic_context(
            trace_id=self.trace_id, operation_id=self.operation_id,
            span_id=self.span_id, parent_span_id=self.parent_span_id,
        )
        self._context_manager.__enter__()
        if self._recording:
            self._emit("activity.started", {"subsystem": self.subsystem,
                                             "action": self.action,
                                             "category": self.category})
        return self

    def phase(self, phase: str, **attributes: Any) -> None:
        safe_phase = _stable_token(phase, "phase")
        if self._activity is not None:
            self._activity.progress(phase=safe_phase)
        if self._recording:
            self._emit("activity.phase", {"subsystem": self.subsystem,
                                           "action": self.action,
                                           "category": self.category,
                                           "phase": safe_phase, **attributes})

    def fail(self, error: BaseException | None = None, *, code: str = "operation_failed") -> None:
        if self._closed or self._failed:
            return
        self._failed = True
        self._emit("activity.failed", {
            "subsystem": self.subsystem, "action": self.action,
            "category": self.category, "outcome": "failure",
            "durationMs": round((time.monotonic() - self._started) * 1000, 3),
            "code": _stable_token(code, "operation_failed"),
            "errorType": type(error).__name__ if error is not None else "Error",
        })

    def finish(self, *, outcome: str = "success", result_class: str | None = None) -> None:
        if self._closed:
            return
        self._closed = True
        duration_ms = round((time.monotonic() - self._started) * 1000, 3)
        if self._recording and not self._failed:
            terminal = "activity.cancelled" if outcome == "cancelled" else "activity.completed"
            attributes: dict[str, Any] = {
                "subsystem": self.subsystem, "action": self.action,
                "category": self.category, "outcome": outcome,
                "durationMs": duration_ms,
            }
            if result_class is not None:
                attributes["resultClass"] = _stable_token(result_class, "result")
            self._emit(terminal, attributes)
        if self._activity is not None:
            self._activity.finish()
        if self._context_manager is not None:
            self._context_manager.__exit__(None, None, None)
            self._context_manager = None

    def _emit(self, event: str, attributes: Mapping[str, Any]) -> None:
        self._session.emit(
            "activity", event, operation_id=self.operation_id,
            trace_id=self.trace_id, span_id=self.span_id,
            parent_span_id=self.parent_span_id, attributes=attributes,
            deduplicate=False,
        )

    def __exit__(self, error_type: object, error: object, traceback: object) -> None:
        if isinstance(error, BaseException):
            self.fail(error)
        self.finish(outcome="failure" if error is not None else "success")


class PythonProgramProfiler:
    """Detailed-capture profiler with bounded code-site timing summaries."""

    def __init__(self, session: "DiagnosticsSession") -> None:
        self.session = session
        self._lock = threading.RLock()
        self._local = threading.local()
        self._code_sites: dict[object, str | None] = {}
        self._summaries: dict[str, list[float]] = {}
        self._active = False
        self._previous_sys: Any = None
        self._previous_thread: Any = None
        self._slow_emitted = 0

    @property
    def active(self) -> bool:
        return self._active

    def start(self) -> None:
        if self._active:
            return
        self._previous_sys = sys.getprofile()
        self._previous_thread = threading.getprofile()
        if self._previous_sys is not None or self._previous_thread is not None:
            self.session.emit("diagnostics", "diagnostics.record_rejected", attributes={
                "recordEvent": "runtime.profiler", "code": "profiler_already_active",
            }, deduplicate=False)
            return
        self._active = True
        threading.setprofile(self._profile)
        sys.setprofile(self._profile)
        self.session.emit("runtime", "runtime.coverage_ready", attributes={
            "count": 0, "category": "python", "mode": "detailed",
        }, deduplicate=False)

    def stop(self) -> None:
        if not self._active:
            return
        self._active = False
        sys.setprofile(self._previous_sys)
        threading.setprofile(self._previous_thread)
        self.flush(force=True)

    def flush(self, *, force: bool = False) -> None:
        with self._lock:
            if not self._summaries:
                self._slow_emitted = 0
                return
            ordered = sorted(
                self._summaries.items(), key=lambda item: (item[1][1], item[1][2]),
                reverse=True,
            )
            limit = len(ordered) if force else min(64, len(ordered))
            selected = ordered[:limit]
            for site, _summary in selected:
                self._summaries.pop(site, None)
            self._slow_emitted = 0
        for code_site, summary in selected:
            self.session.emit("runtime", "runtime.function_summary", attributes={
                "codeSite": code_site, "callCount": int(summary[0]),
                "totalDurationMs": round(summary[1], 3),
                "maxDurationMs": round(summary[2], 3), "category": "python",
            }, deduplicate=False)

    def _profile(self, frame: Any, event: str, _arg: Any) -> None:
        if not self._active or event not in {"call", "return"}:
            return
        if event == "call":
            code_site = self._code_site(frame.f_code)
            if code_site is None:
                return
            stack = getattr(self._local, "stack", None)
            if stack is None:
                stack = []
                self._local.stack = stack
                self._local.counter = 0
            if len(stack) >= PROFILE_STACK_MAX:
                return
            self._local.counter += 1
            context = current_diagnostic_context()
            parent_span = stack[-1][5] if stack else context.get("spanId")
            span_id = f"py-{threading.get_ident()}-{self._local.counter}"
            trace_id = context.get("traceId") or f"trace-{self.session.run_id}"
            stack.append((id(frame), time.perf_counter(), code_site, trace_id,
                          context.get("operationId"), span_id, parent_span))
            return
        stack = getattr(self._local, "stack", None)
        if not stack:
            return
        frame_id = id(frame)
        index = len(stack) - 1
        while index >= 0 and stack[index][0] != frame_id:
            index -= 1
        if index < 0:
            return
        call = stack.pop(index)
        duration_ms = (time.perf_counter() - call[1]) * 1000.0
        code_site, trace_id, operation_id, span_id, parent_span = call[2:]
        with self._lock:
            summary = self._summaries.get(code_site)
            if summary is None:
                if len(self._summaries) >= PROFILE_SUMMARY_MAX:
                    return
                summary = [0.0, 0.0, 0.0]
                self._summaries[code_site] = summary
            summary[0] += 1
            summary[1] += duration_ms
            summary[2] = max(summary[2], duration_ms)
            emit_slow = duration_ms >= 10.0 and self._slow_emitted < 128
            if emit_slow:
                self._slow_emitted += 1
        if emit_slow:
            self.session.emit("runtime", "runtime.function_completed",
                              operation_id=operation_id, trace_id=trace_id,
                              span_id=span_id, parent_span_id=parent_span,
                              attributes={"codeSite": code_site,
                                          "durationMs": round(duration_ms, 3),
                                          "slowThresholdMs": 10,
                                          "category": "python"},
                              deduplicate=False)

    def _code_site(self, code: Any) -> str | None:
        with self._lock:
            if code in self._code_sites:
                return self._code_sites[code]
        filename = str(getattr(code, "co_filename", ""))
        site: str | None = None
        source_root = self.session.source_root
        if source_root is not None and filename:
            try:
                relative = Path(filename).absolute().relative_to(source_root)
                parts = list(relative.with_suffix("").parts)
                if parts and parts[0].lower() == "auvra" and "generated" not in parts:
                    module = ".".join(parts)
                    if module != "Auvra.diagnostics.core":
                        function = str(getattr(code, "co_qualname", getattr(code, "co_name", "call")))
                        site = _stable_token(f"{module}.{function}", "runtime.call")
            except (OSError, ValueError):
                site = None
        with self._lock:
            if len(self._code_sites) < PROFILE_CODE_CACHE_MAX:
                self._code_sites[code] = site
        return site


class DiagnosticsSession:
    """Python-owned bounded writer, run manifest, ring, and stall monitor."""

    def __init__(self, root: Path, *, source_root: Path | None = None,
                 run_id: str | None = None, mode: str = "development",
                 ring: DiagnosticRing | None = None) -> None:
        self.root = Path(root).expanduser().absolute()
        self.source_root = Path(source_root).absolute() if source_root is not None else None
        self.run_id = run_id or ("run-" + secrets.token_urlsafe(16))
        if not _ID_PATTERN.fullmatch(self.run_id):
            raise ValueError("diagnostic run id is invalid")
        self.mode = mode if mode in {"development", "packaged", "test"} else "development"
        self.ring = ring or DiagnosticRing()
        self._started_at = time.time()
        self._monotonic = time.monotonic()
        self._sequence = 0
        self._sequence_lock = threading.Lock()
        self._normal = _NormalRecordQueue(NORMAL_QUEUE_RECORDS)
        self._priority: queue.Queue[dict[str, Any]] = queue.Queue(PRIORITY_QUEUE_RECORDS)
        self._stop = threading.Event()
        self._flush_requested = threading.Event()
        self._flush_done = threading.Event()
        self._writer: threading.Thread | None = None
        self._monitor: threading.Thread | None = None
        self._stream: Any = None
        self._segment_index = 0
        self._segment_size = 0
        self._segments: list[str] = []
        self._storage_failed = False
        self._storage_error_reported = False
        self._active = False
        self._closed = False
        self._closing = False
        self._close_finalizer_started = False
        self._counts = {level: 0 for level in _LEVELS}
        self._dropped = {level: 0 for level in _LEVELS}
        self._reported_dropped = {level: 0 for level in _LEVELS}
        self._component_health: dict[str, dict[str, Any]] = {
            "diagnostics": {"state": "healthy", "lastEvent": "run.started"},
        }
        self._repeated = 0
        self._last_phase: str | None = None
        self._last_completed_startup_phase: str | None = None
        self._last_failure_phase: str | None = None
        self._manifest_dirty = False
        self._state_lock = threading.RLock()
        self._dedup: dict[tuple[Any, ...], _DedupState] = {}
        self._activities: dict[str, _ActiveState] = {}
        self._detailed_until = 0.0
        self._frontend_expected = False
        self._frontend_last_heartbeat: float | None = None
        self._frontend_visibility = "starting"
        self._frontend_active_count = 0
        self._frontend_unresponsive_at: float | None = None
        self._program_profiler = PythonProgramProfiler(self)

    @property
    def detailed(self) -> bool:
        return time.monotonic() < self._detailed_until

    @property
    def storage_failed(self) -> bool:
        return self._storage_failed

    @property
    def summary(self) -> dict[str, Any]:
        with self._state_lock:
            return self._summary("active" if self._active and not self._closed else "closed")

    def start(self) -> dict[str, Any] | None:
        if self._active:
            return None
        previous: dict[str, Any] | None = None
        storage_error_type: str | None = None
        try:
            root = safe_diagnostics_root(self.root)
            previous = _load_json(root / RUN_MARKER_NAME)
            if previous is not None:
                self._mark_previous_unclean(previous)
            self._prune_runs()
            self._active = True
            self._open_segment()
            atomic_json(root / RUN_MARKER_NAME, {
                "version": 2, "schema": DIAGNOSTIC_SCHEMA, "runId": self.run_id,
                "startedAt": self._started_at,
            })
            self._write_summary("active")
        except OSError as exc:
            self._storage_failed = True
            self._storage_error_reported = True
            storage_error_type = type(exc).__name__
            self._active = True
        self._writer = threading.Thread(target=self._writer_loop, name="auvra-diagnostics-writer", daemon=True)
        self._monitor = threading.Thread(target=self._monitor_loop, name="auvra-diagnostics-monitor", daemon=True)
        self._writer.start()
        self._monitor.start()
        self.emit("launcher", "run.started", attributes={"mode": self.mode, "runState": "active"})
        if self._storage_failed:
            self.emit("diagnostics", "diagnostics.storage_failed",
                      attributes={"code": "storage_unavailable",
                                  "errorType": storage_error_type or "OSError"},
                      deduplicate=False)
        if previous is not None:
            self.emit("launcher", "run.unclean_previous", attributes={"runState": "unclean", "code": "unclean_shutdown"})
        return previous

    def start_detailed_capture(self, *, minutes: int = 15) -> None:
        bounded = max(1, min(int(minutes), 15))
        self._detailed_until = time.monotonic() + bounded * 60
        self.emit("diagnostics", "diagnostics.capture_started",
                  attributes={"mode": "detailed", "minutes": bounded})
        self._program_profiler.start()

    def stop_detailed_capture(self, *, reason: str = "user") -> None:
        if not self.detailed and self._detailed_until == 0:
            return
        if not self.detailed:
            self._detailed_until = time.monotonic() + 1.0
        self._program_profiler.stop()
        self._detailed_until = 0
        self.emit("diagnostics", "diagnostics.capture_ended",
                  attributes={"mode": "concise", "reason": reason})

    def begin_activity(self, component: str, kind: str, *, operation_id: str | None = None,
                       request_id: str | None = None, trace_id: str | None = None,
                       stall_after: float = 5.0, capture_stack: bool = True) -> DiagnosticActivity:
        token = secrets.token_urlsafe(12)
        now = time.monotonic()
        state = _ActiveState(
            token, component, _redact_text(kind, 64), _safe_id(operation_id),
            _safe_id(request_id), _safe_id(trace_id), threading.get_ident(), now, now,
            max(1.0, min(float(stall_after), 120.0)), capture_stack=capture_stack,
        )
        with self._state_lock:
            self._activities[token] = state
        return DiagnosticActivity(self, token)

    def begin_span(self, subsystem: str, action: str, *,
                   operation_id: str | None = None, trace_id: str | None = None,
                   parent_span_id: str | None = None, detailed_only: bool = False,
                   stall_after: float = 5.0, category: str = "operation") -> DiagnosticSpan:
        return DiagnosticSpan(
            self, subsystem, action, operation_id=operation_id,
            trace_id=trace_id, parent_span_id=parent_span_id,
            detailed_only=detailed_only, stall_after=stall_after,
            category=category,
        )

    def touch_activity(self, token: str, *, phase: str | None = None,
                       progress_bucket: int | None = None,
                       worker_state: str | None = None,
                       queue_state: str | None = None) -> None:
        with self._state_lock:
            state = self._activities.get(token)
            if state is not None:
                state.last_progress = time.monotonic()
                if isinstance(phase, str):
                    state.phase = _redact_text(phase, 64)
                if isinstance(progress_bucket, int) and progress_bucket in {0, 25, 50, 75, 100}:
                    state.progress_bucket = progress_bucket
                if isinstance(worker_state, str):
                    state.worker_state = _redact_text(worker_state, 64)
                if isinstance(queue_state, str):
                    state.queue_state = _redact_text(queue_state, 64)

    def expect_frontend_heartbeat(self) -> None:
        with self._state_lock:
            self._frontend_expected = True
            self._frontend_last_heartbeat = time.monotonic()
            self._frontend_visibility = "starting"
            self._frontend_unresponsive_at = None

    def frontend_heartbeat(self, *, visibility: str, active_count: int) -> None:
        if visibility not in {"active", "hidden", "starting", "closing"}:
            return
        now = time.monotonic()
        recovered_at: float | None = None
        with self._state_lock:
            recovered_at = self._frontend_unresponsive_at
            self._frontend_expected = visibility != "closing"
            self._frontend_last_heartbeat = now
            self._frontend_visibility = visibility
            self._frontend_active_count = max(0, min(int(active_count), 64))
            self._frontend_unresponsive_at = None
        if recovered_at is not None:
            self.emit("frontend", "frontend.responsive", attributes={
                "durationMs": round((now - recovered_at) * 1000, 3),
                "activeCount": self._frontend_active_count,
            }, deduplicate=False)

    def finish_activity(self, token: str) -> None:
        with self._state_lock:
            state = self._activities.pop(token, None)
        if state is not None and state.warned:
            self.emit("diagnostics", "diagnostics.operation_recovered",
                      operation_id=state.operation_id, request_id=state.request_id,
                      trace_id=state.trace_id,
                      attributes={"operationKind": state.kind,
                                  "phase": state.phase,
                                  "durationMs": round((time.monotonic() - state.started) * 1000, 3)})

    def emit(self, component: str, event: str, *, level: str | None = None,
             session_id: str | None = None, operation_id: str | None = None,
             request_id: str | None = None, trace_id: str | None = None,
             span_id: str | None = None, parent_span_id: str | None = None,
             attributes: Mapping[str, Any] | None = None,
             deduplicate: bool = True) -> dict[str, Any]:
        if self._closed:
            return {}
        spec = EVENT_CATALOG.get(event)
        if spec is None or component != spec.component or not _EVENT_PATTERN.fullmatch(event):
            spec = EVENT_CATALOG["diagnostics.record_rejected"]
            component = spec.component
            level = spec.default_level
            attributes = {"recordEvent": _redact_text(str(event), 96), "code": "unknown_event"}
            event = "diagnostics.record_rejected"
            deduplicate = True
        chosen_level = spec.default_level
        if chosen_level == "debug" and not self.detailed:
            return {}
        safe_attributes: dict[str, Any] = {}
        for key, value in list((attributes or {}).items())[:ATTRIBUTE_MAX_ITEMS]:
            if key in spec.fields and not _FORBIDDEN_KEY.fullmatch(key) and not _SECRET_KEY.search(key):
                safe_attributes[key] = redact(value, key=key)
        record: dict[str, Any] = {
            "schema": DIAGNOSTIC_SCHEMA,
            "sequence": self._next_sequence(),
            "timestampUtc": _utc_now(),
            "elapsedMs": round((time.monotonic() - self._monotonic) * 1000, 3),
            "level": chosen_level,
            "component": component,
            "event": event,
            "runId": self.run_id,
        }
        for key, value in (
            ("sessionId", session_id), ("operationId", operation_id),
            ("requestId", request_id), ("traceId", trace_id),
            ("spanId", span_id), ("parentSpanId", parent_span_id),
        ):
            safe_id = _safe_id(value)
            if safe_id is not None:
                record[key] = safe_id
        if safe_attributes:
            record["attributes"] = safe_attributes
        record = self._bound_record(record)
        if deduplicate and self._is_repeat(record):
            return record
        self._accept_record(record)
        return record

    def snapshot(self) -> list[dict[str, Any]]:
        return self.ring.snapshot()

    def flush(self, timeout: float = 1.0, *, durable: bool = False) -> bool:
        if not self._active or self._writer is None:
            return True
        self._flush_done.clear()
        if durable:
            setattr(self, "_durable_flush", True)
        self._flush_requested.set()
        return self._flush_done.wait(max(0.0, timeout))

    def close(self, *, outcome: str = "success", exit_code: int | None = None,
              interrupted: bool = False) -> None:
        if self._closed:
            return
        bounded_outcome = outcome if outcome in {"success", "failure", "cancelled", "unclean"} else "failure"
        self.emit("launcher", "run.ending", attributes={
            "outcome": bounded_outcome, "exitCode": exit_code, "interrupted": interrupted,
        }, deduplicate=False)
        self._flush_repeat_summaries(force=True)
        self._report_drops()
        self.emit("launcher", "run.ended", attributes={
            "outcome": bounded_outcome, "exitCode": exit_code,
            "durationMs": round((time.monotonic() - self._monotonic) * 1000, 3),
            "clean": bounded_outcome != "unclean",
        }, deduplicate=False)
        if self._program_profiler.active and not self.detailed:
            self._detailed_until = time.monotonic() + 1.0
        self._program_profiler.stop()
        self._detailed_until = 0
        self._closing = True
        self._closed = True
        self._stop.set()
        self._flush_requested.set()
        if self._writer is not None:
            self._writer.join(1.0)
        if self._monitor is not None:
            self._monitor.join(0.25)
        writer_alive = bool(self._writer and self._writer.is_alive())
        queues_pending = not self._normal.empty() or not self._priority.empty()
        drain_incomplete = writer_alive or queues_pending
        self._active = False
        if writer_alive:
            # The writer owns the stream until it exits. Keep the marker and
            # stream live so the next launch can see an unclean run and the
            # writer cannot race storage teardown.
            self._write_summary(bounded_outcome, exit_code=exit_code,
                                drain_incomplete=True)
            self._start_deferred_close(outcome=bounded_outcome, exit_code=exit_code)
            return
        self._finalize_close(outcome=bounded_outcome, exit_code=exit_code,
                             drain_incomplete=drain_incomplete)

    def _start_deferred_close(self, *, outcome: str, exit_code: int | None) -> None:
        if self._close_finalizer_started:
            return
        self._close_finalizer_started = True
        threading.Thread(
            target=self._deferred_close,
            kwargs={"outcome": outcome, "exit_code": exit_code},
            name="auvra-diagnostics-close",
            daemon=True,
        ).start()

    def _deferred_close(self, *, outcome: str, exit_code: int | None) -> None:
        if self._writer is not None:
            self._writer.join()
        if self._monitor is not None:
            self._monitor.join()
        drain_incomplete = not self._normal.empty() or not self._priority.empty()
        self._finalize_close(outcome=outcome, exit_code=exit_code,
                             drain_incomplete=drain_incomplete)

    def _finalize_close(self, *, outcome: str, exit_code: int | None,
                        drain_incomplete: bool) -> None:
        self._active = False
        self._write_summary(outcome, exit_code=exit_code,
                            drain_incomplete=drain_incomplete)
        marker = self.root / RUN_MARKER_NAME
        current = _load_json(marker)
        if not drain_incomplete and not self._storage_failed \
                and current and current.get("runId") == self.run_id \
                and not _is_link_or_reparse(marker):
            try:
                marker.unlink()
            except OSError:
                pass
        self._close_stream(durable=True)
        self._prune_runs()

    def _next_sequence(self) -> int:
        with self._sequence_lock:
            self._sequence += 1
            return self._sequence

    def _bound_record(self, record: dict[str, Any]) -> dict[str, Any]:
        encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
        if len(encoded) <= RECORD_MAX_BYTES:
            return record
        attributes = dict(record.get("attributes") or {})
        attributes.pop("frames", None)
        while len(attributes) > ATTRIBUTE_MAX_ITEMS:
            attributes.pop(next(reversed(attributes)))
        record["attributes"] = attributes
        while attributes and len(json.dumps(record, ensure_ascii=True, separators=(",", ":")).encode("utf-8")) > RECORD_MAX_BYTES:
            attributes.pop(next(reversed(attributes)))
        if len(json.dumps(record, ensure_ascii=True, separators=(",", ":")).encode("utf-8")) <= RECORD_MAX_BYTES:
            return record
        return {
            "schema": DIAGNOSTIC_SCHEMA,
            "sequence": record["sequence"],
            "timestampUtc": record["timestampUtc"],
            "elapsedMs": record["elapsedMs"],
            "level": "warning",
            "component": "diagnostics",
            "event": "diagnostics.record_rejected",
            "runId": self.run_id,
            "attributes": {"code": "record_too_large"},
        }

    def _dedup_key(self, record: Mapping[str, Any]) -> tuple[Any, ...]:
        attributes = record.get("attributes") if isinstance(record.get("attributes"), dict) else {}
        return (
            record.get("component"), record.get("event"), record.get("traceId"),
            json.dumps(attributes, ensure_ascii=True, sort_keys=True, separators=(",", ":")),
        )

    def _is_repeat(self, record: dict[str, Any]) -> bool:
        now = time.monotonic()
        key = self._dedup_key(record)
        with self._state_lock:
            previous = self._dedup.get(key)
            if previous is not None and now - previous.started <= DEDUP_WINDOW_SECONDS:
                previous.last = now
                previous.count += 1
                self._repeated += 1
                self._manifest_dirty = True
                return True
            if previous is not None and previous.count:
                self._queue_repeat(previous)
            self._dedup[key] = _DedupState(now, now, 0, dict(record))
        return False

    def _queue_repeat(self, state: _DedupState) -> None:
        summary = dict(state.record)
        summary["sequence"] = self._next_sequence()
        summary["timestampUtc"] = _utc_now()
        summary["elapsedMs"] = round((time.monotonic() - self._monotonic) * 1000, 3)
        attributes = dict(summary.get("attributes") or {})
        if len(attributes) >= ATTRIBUTE_MAX_ITEMS:
            attributes.pop(next(reversed(attributes)))
        attributes["repeatCount"] = state.count
        summary["attributes"] = attributes
        self._accept_record(self._bound_record(summary))

    def _flush_repeat_summaries(self, *, force: bool = False) -> None:
        now = time.monotonic()
        expired: list[_DedupState] = []
        with self._state_lock:
            for key, state in list(self._dedup.items()):
                if force or now - state.started > DEDUP_WINDOW_SECONDS:
                    self._dedup.pop(key, None)
                    if state.count:
                        expired.append(state)
        for state in expired:
            self._queue_repeat(state)

    def _accept_record(self, record: dict[str, Any]) -> None:
        self.ring.append(record)
        level = str(record.get("level", "info"))
        with self._state_lock:
            self._counts[level] = self._counts.get(level, 0) + 1
            health = self._component_health.setdefault(str(record.get("component", "diagnostics")), {})
            health["state"] = ("degraded" if _LEVEL_ORDER.get(level, 0) >= _LEVEL_ORDER["error"]
                               else health.get("state", "healthy"))
            health["lastEvent"] = str(record.get("event", "unknown"))
            attributes = record.get("attributes")
            if record.get("event") in {"startup.phase_completed", "startup.phase_failed"} \
                    and isinstance(attributes, dict) and isinstance(attributes.get("phase"), str):
                phase = attributes["phase"]
                if record.get("event") == "startup.phase_failed":
                    self._last_failure_phase = phase
                    self._last_phase = phase
                elif phase not in {"shutdown", "cleanup"}:
                    self._last_completed_startup_phase = phase
                    if self._last_failure_phase is None:
                        self._last_phase = phase
            self._manifest_dirty = True
        target = self._priority if _LEVEL_ORDER.get(level, 1) >= _LEVEL_ORDER["warning"] else self._normal
        try:
            displaced = target.put_nowait(record)
            if displaced is not None:
                displaced_level = str(displaced.get("level", "debug"))
                with self._state_lock:
                    self._dropped[displaced_level] = self._dropped.get(displaced_level, 0) + 1
                    self._manifest_dirty = True
        except queue.Full:
            if target is self._priority:
                displaced = self._normal.displace_for_priority(record)
                if displaced is not None:
                    displaced_level = str(displaced.get("level", "info"))
                    with self._state_lock:
                        self._dropped[displaced_level] = self._dropped.get(displaced_level, 0) + 1
                        self._manifest_dirty = True
                    self._flush_requested.set()
                    return
            with self._state_lock:
                self._dropped[level] = self._dropped.get(level, 0) + 1
                self._manifest_dirty = True
        if target is self._priority:
            self._flush_requested.set()

    def _writer_loop(self) -> None:
        last_flush = time.monotonic()
        try:
            while not self._stop.is_set() or not self._priority.empty() or not self._normal.empty():
                wrote = False
                for source in (self._priority, self._normal):
                    for _ in range(64):
                        try:
                            record = source.get_nowait()
                        except queue.Empty:
                            break
                        try:
                            self._write_record(record)
                            wrote = True
                        finally:
                            source.task_done()
                now = time.monotonic()
                self._flush_repeat_summaries()
                self._report_drops()
                requested = self._flush_requested.is_set()
                if wrote and (requested or now - last_flush >= WRITER_FLUSH_SECONDS):
                    self._flush_stream(durable=bool(getattr(self, "_durable_flush", False)))
                    setattr(self, "_durable_flush", False)
                    if not self._closing:
                        self._write_summary("active")
                    last_flush = now
                if requested and self._priority.empty() and self._normal.empty():
                    self._flush_stream(durable=bool(getattr(self, "_durable_flush", False)))
                    setattr(self, "_durable_flush", False)
                    if not self._closing:
                        self._write_summary("active")
                    self._flush_requested.clear()
                    self._flush_done.set()
                if not wrote:
                    self._stop.wait(0.05)
            self._flush_stream(durable=True)
            if not self._closing:
                self._write_summary("active")
            self._flush_done.set()
        except Exception as exc:
            self._storage_failed = True
            if not self._storage_error_reported:
                self._storage_error_reported = True
                self.emit("diagnostics", "diagnostics.storage_failed",
                          attributes={"code": "storage_unavailable", "errorType": type(exc).__name__},
                          deduplicate=False)
                try:
                    sys.stderr.write(f"Auvra diagnostics storage unavailable ({type(exc).__name__})\n")
                except Exception:
                    pass
            self._flush_done.set()

    def _report_drops(self) -> None:
        with self._state_lock:
            delta = {
                level: self._dropped.get(level, 0) - self._reported_dropped.get(level, 0)
                for level in _LEVELS
            }
            total = sum(max(0, count) for count in delta.values())
            if not total:
                return
            self._reported_dropped = dict(self._dropped)
        self.emit("diagnostics", "diagnostics.records_dropped",
                  attributes={"droppedCount": total}, deduplicate=False)

    def _monitor_loop(self) -> None:
        last_profile_flush = time.monotonic()
        while not self._stop.wait(1.0):
            if self._detailed_until and not self.detailed:
                # Keep the detailed gate open only long enough to persist the
                # profiler's final bounded summaries.
                self._detailed_until = time.monotonic() + 1.0
                self._program_profiler.stop()
                self._detailed_until = 0
                self.emit("diagnostics", "diagnostics.capture_ended",
                          attributes={"mode": "concise", "reason": "expired"})
            now = time.monotonic()
            if self._program_profiler.active and now - last_profile_flush >= 10.0:
                self._program_profiler.flush()
                last_profile_flush = now
            with self._state_lock:
                states = list(self._activities.values())
                frontend_expected = self._frontend_expected
                frontend_last = self._frontend_last_heartbeat
                frontend_visibility = self._frontend_visibility
                frontend_active_count = self._frontend_active_count
                frontend_unresponsive_at = self._frontend_unresponsive_at
            if (frontend_expected and frontend_last is not None and
                    frontend_visibility == "active" and now - frontend_last >= 5.0 and
                    frontend_unresponsive_at is None):
                with self._state_lock:
                    if self._frontend_unresponsive_at is None:
                        self._frontend_unresponsive_at = now
                self.emit("frontend", "frontend.unresponsive", attributes={
                    "stallMs": round((now - frontend_last) * 1000, 3),
                    "activeCount": frontend_active_count,
                    "visibility": frontend_visibility,
                }, deduplicate=False)
            for state in states:
                stalled = now - state.last_progress
                escalate = stalled >= 30.0
                if stalled < state.stall_after or (state.warned and (state.escalated or not escalate)):
                    continue
                frames = self._safe_stack(state.thread_id) if state.capture_stack else []
                attributes: dict[str, Any] = {
                    "operationKind": state.kind,
                    "stallMs": round(stalled * 1000, 3),
                    "durationMs": round((now - state.started) * 1000, 3),
                    "escalation": escalate,
                    "thread": _redact_text(state.component, 64),
                    "phase": state.phase,
                    "progressBucket": state.progress_bucket,
                    "workerState": state.worker_state,
                    "queueState": state.queue_state,
                }
                if frames:
                    attributes["frames"] = frames
                self.emit("diagnostics", "diagnostics.operation_stalled",
                          operation_id=state.operation_id, request_id=state.request_id,
                          trace_id=state.trace_id,
                          attributes=attributes, deduplicate=False)
                with self._state_lock:
                    current = self._activities.get(state.token)
                    if current is not None:
                        current.warned = True
                        current.escalated = current.escalated or escalate

    def _safe_stack(self, thread_id: int) -> list[str]:
        frame = sys._current_frames().get(thread_id)
        result: list[str] = []
        while frame is not None and len(result) < STACK_MAX_FRAMES:
            filename = Path(frame.f_code.co_filename)
            module = filename.name
            if self.source_root is not None:
                try:
                    module = filename.resolve().relative_to(self.source_root.resolve()).as_posix()
                except (OSError, RuntimeError, ValueError):
                    module = filename.name
            result.append(_redact_text(f"{module}:{frame.f_code.co_name}:{frame.f_lineno}", 160))
            frame = frame.f_back
        return result

    def _segment_path(self, index: int) -> Path:
        return self.root / f"run-{self.run_id}-{index:03d}.ndjson"

    def _open_segment(self) -> None:
        path = self._segment_path(self._segment_index)
        if path.exists() or path.is_symlink():
            raise OSError("diagnostic segment already exists")
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        self._stream = os.fdopen(fd, "w", encoding="utf-8", newline="\n", buffering=1)
        self._segment_size = 0
        self._segments.append(path.name)
        while len(self._segments) > RUN_MAX_SEGMENTS:
            removed = self.root / self._segments.pop(0)
            try:
                if removed.is_file() and not _is_link_or_reparse(removed):
                    removed.unlink()
            except OSError:
                pass
        self._manifest_dirty = True

    def _write_record(self, record: Mapping[str, Any]) -> None:
        if self._storage_failed or self._stream is None:
            return
        line = json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n"
        size = len(line.encode("utf-8"))
        if self._segment_size and self._segment_size + size > SEGMENT_MAX_BYTES:
            self._close_stream(durable=True)
            self._segment_index += 1
            self._open_segment()
        self._stream.write(line)
        self._segment_size += size

    def _flush_stream(self, *, durable: bool) -> None:
        if self._stream is None:
            return
        self._stream.flush()
        if durable:
            os.fsync(self._stream.fileno())

    def _close_stream(self, *, durable: bool) -> None:
        stream, self._stream = self._stream, None
        if stream is None:
            return
        try:
            stream.flush()
            if durable:
                os.fsync(stream.fileno())
        finally:
            stream.close()

    def _summary(self, state: str, *, exit_code: int | None = None,
                 drain_incomplete: bool = False) -> dict[str, Any]:
        now = time.monotonic()
        with self._state_lock:
            counts = dict(self._counts)
            dropped = dict(self._dropped)
            health = {component: dict(value) for component, value in self._component_health.items()}
            active_operations = [
                {
                    "component": activity.component,
                    "kind": activity.kind,
                    "operationId": activity.operation_id,
                    "requestId": activity.request_id,
                    "traceId": activity.trace_id,
                    "elapsedMs": round((now - activity.started) * 1000, 3),
                    "stalled": activity.warned,
                    "lastPhase": activity.phase,
                    "progressBucket": activity.progress_bucket,
                    "workerState": activity.worker_state,
                    "queueState": activity.queue_state,
                }
                for activity in self._activities.values()
            ][:64]
        value: dict[str, Any] = {
            "version": 2,
            "schema": DIAGNOSTIC_SCHEMA,
            "runId": self.run_id,
            "mode": self.mode,
            "startedAt": self._started_at,
            "state": state,
            "lastSequence": self._sequence,
            "lastPhase": self._last_phase,
            "lastCompletedStartupPhase": self._last_completed_startup_phase,
            "lastFailurePhase": self._last_failure_phase,
            "captureMode": "detailed" if self.detailed else "concise",
            "counts": counts,
            "dropped": dropped,
            "repeated": self._repeated,
            "componentHealth": health,
            "activeOperations": active_operations,
            "storageFailed": self._storage_failed,
            "drainIncomplete": drain_incomplete,
            "segments": list(self._segments),
        }
        if state != "active":
            value["endedAt"] = time.time()
        if exit_code is not None:
            value["exitCode"] = int(exit_code)
        return value

    def _write_summary(self, state: str, *, exit_code: int | None = None,
                       drain_incomplete: bool = False) -> None:
        if self._storage_failed or (state == "active" and not self._manifest_dirty):
            return
        try:
            value = self._summary(state, exit_code=exit_code, drain_incomplete=drain_incomplete)
            atomic_json(self.root / f"run-{self.run_id}.json", value)
            atomic_json(self.root / LATEST_RUN_NAME, value)
            self._manifest_dirty = False
        except OSError:
            self._storage_failed = True

    def _mark_previous_unclean(self, previous: Mapping[str, Any]) -> None:
        run_id = previous.get("runId")
        if not isinstance(run_id, str) or not _ID_PATTERN.fullmatch(run_id):
            return
        summary_path = self.root / f"run-{run_id}.json"
        summary = _load_json(summary_path) or dict(previous)
        summary.update({"version": 2, "schema": DIAGNOSTIC_SCHEMA, "runId": run_id,
                        "state": "unclean", "endedAt": time.time()})
        try:
            safe_summary = redact(summary, max_depth=6, max_items=64)
            atomic_json(summary_path, safe_summary)
            atomic_json(self.root / LATEST_RUN_NAME, safe_summary)
        except OSError:
            pass

    def _prune_runs(self) -> None:
        try:
            root = safe_diagnostics_root(self.root)
            summaries: list[tuple[float, Path, dict[str, Any]]] = []
            now = time.time()
            for path in root.glob("run-*.json"):
                if path.name == LATEST_RUN_NAME or _is_link_or_reparse(path):
                    continue
                value = _load_json(path)
                if not value or not isinstance(value.get("runId"), str):
                    continue
                summaries.append((path.stat().st_mtime, path, value))
            summaries.sort(key=lambda item: item[0], reverse=True)
            remove: list[tuple[float, Path, dict[str, Any]]] = [
                item for index, item in enumerate(summaries)
                if index >= RUN_MAX_COUNT or now - item[0] > RUN_RETENTION_SECONDS
            ]
            kept = [item for item in summaries if item not in remove]
            total = sum(_run_group_size(root, item[2]) for item in kept)
            for item in sorted(kept, key=lambda entry: entry[0]):
                if total <= RUN_TOTAL_MAX_BYTES:
                    break
                if item[2].get("runId") == self.run_id:
                    continue
                remove.append(item)
                total -= _run_group_size(root, item[2])
            for _mtime, path, value in remove:
                if value.get("runId") == self.run_id:
                    continue
                for name in _safe_segment_names(value):
                    candidate = root / name
                    try:
                        if candidate.is_file() and not _is_link_or_reparse(candidate):
                            candidate.unlink()
                    except OSError:
                        pass
                try:
                    if path.is_file() and not _is_link_or_reparse(path):
                        path.unlink()
                except OSError:
                    pass
        except OSError:
            return


def _safe_id(value: object) -> str | None:
    if isinstance(value, str) and _ID_PATTERN.fullmatch(value):
        return value
    return None


def _stable_token(value: object, fallback: str) -> str:
    text = str(value).strip().lower().replace("-", "_")
    text = re.sub(r"[^a-z0-9._]+", "_", text).strip("._")
    if not text or not _EVENT_PATTERN.fullmatch(text):
        return fallback
    return text[:96]


def _run_group_size(root: Path, summary: Mapping[str, Any]) -> int:
    total = 0
    run_id = summary.get("runId")
    if isinstance(run_id, str):
        path = root / f"run-{run_id}.json"
        try:
            total += path.stat().st_size
        except OSError:
            pass
    for name in _safe_segment_names(summary):
        try:
            total += (root / str(name)).stat().st_size
        except OSError:
            pass
    return total


def _safe_segment_names(summary: Mapping[str, Any]) -> list[str]:
    run_id = summary.get("runId")
    if not isinstance(run_id, str) or not _ID_PATTERN.fullmatch(run_id):
        return []
    pattern = re.compile(rf"^run-{re.escape(run_id)}-\d{{3}}\.ndjson$")
    result: list[str] = []
    for raw in list(summary.get("segments") or [])[:RUN_MAX_SEGMENTS]:
        if isinstance(raw, str) and pattern.fullmatch(raw) and raw not in result:
            result.append(raw)
    return result


_FALLBACK_RING = DiagnosticRing(max_records=256, max_bytes=256 * 1024)
_ACTIVE_SESSION: DiagnosticsSession | None = None
_ACTIVE_LOCK = threading.RLock()


def active_diagnostics() -> DiagnosticsSession | None:
    with _ACTIVE_LOCK:
        return _ACTIVE_SESSION


def install_diagnostics(session: DiagnosticsSession | None) -> DiagnosticsSession | None:
    global _ACTIVE_SESSION
    with _ACTIVE_LOCK:
        previous = _ACTIVE_SESSION
        _ACTIVE_SESSION = session
        return previous


class _NullDiagnosticSpan:
    trace_id = ""
    span_id = ""
    parent_span_id = None
    operation_id = None
    context: dict[str, str] = {}

    def __enter__(self) -> "_NullDiagnosticSpan":
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        return None

    def phase(self, _phase: str, **_attributes: Any) -> None:
        return None

    def fail(self, _error: BaseException | None = None, *, code: str = "operation_failed") -> None:
        return None

    def finish(self, *, outcome: str = "success", result_class: str | None = None) -> None:
        return None


def start_diagnostic_span(subsystem: str, action: str, *,
                          operation_id: str | None = None,
                          trace_id: str | None = None,
                          parent_span_id: str | None = None,
                          detailed_only: bool = False,
                          stall_after: float = 5.0,
                          category: str = "operation") -> DiagnosticSpan | _NullDiagnosticSpan:
    session = active_diagnostics()
    if session is None:
        return _NullDiagnosticSpan()
    return session.begin_span(
        subsystem, action, operation_id=operation_id, trace_id=trace_id,
        parent_span_id=parent_span_id, detailed_only=detailed_only,
        stall_after=stall_after, category=category,
    )


def traced(subsystem: str, action: str | None = None, *,
           detailed_only: bool = True, stall_after: float = 5.0,
           category: str = "utility") -> Callable[[Callable[_P, _R]], Callable[_P, _R]]:
    """Trace a callable without recording arguments, return values, or locals."""

    def decorate(function: Callable[_P, _R]) -> Callable[_P, _R]:
        call_action = action or function.__name__
        if inspect.iscoroutinefunction(function):
            @wraps(function)
            async def async_wrapped(*args: _P.args, **kwargs: _P.kwargs) -> Any:
                with start_diagnostic_span(
                    subsystem, call_action, detailed_only=detailed_only,
                    stall_after=stall_after, category=category,
                ):
                    return await function(*args, **kwargs)
            return async_wrapped

        @wraps(function)
        def wrapped(*args: _P.args, **kwargs: _P.kwargs) -> Any:
            with start_diagnostic_span(
                subsystem, call_action, detailed_only=detailed_only,
                stall_after=stall_after, category=category,
            ):
                return function(*args, **kwargs)
        return wrapped

    return decorate


def trace_public_class(subsystem: str, *, concise: Sequence[str] = (),
                       exclude: Sequence[str] = ()) -> Callable[[type[_R]], type[_R]]:
    """Instrument public class methods; selected boundaries remain concise-mode visible."""

    concise_names = frozenset(concise)
    excluded_names = frozenset(exclude)

    def decorate(cls: type[_R]) -> type[_R]:
        for name, member in list(vars(cls).items()):
            if name.startswith("_") or name in excluded_names or isinstance(member, property):
                continue
            descriptor: type[staticmethod] | type[classmethod] | None = None
            function: Any = member
            if isinstance(member, staticmethod):
                descriptor = staticmethod
                function = member.__func__
            elif isinstance(member, classmethod):
                descriptor = classmethod
                function = member.__func__
            if not callable(function):
                continue
            wrapped = traced(
                subsystem, name, detailed_only=name not in concise_names,
                category="service" if name in concise_names else "utility",
            )(function)
            setattr(cls, name, descriptor(wrapped) if descriptor is not None else wrapped)
        return cls

    return decorate


def process_ring() -> DiagnosticRing:
    session = active_diagnostics()
    return session.ring if session is not None else _FALLBACK_RING


def latest_run_summary(root: Path) -> dict[str, Any] | None:
    root = Path(root).expanduser().absolute()
    if not root.is_dir() or _is_link_or_reparse(root):
        return None
    try:
        return _load_json(safe_diagnostics_root(root) / LATEST_RUN_NAME)
    except OSError:
        return None


def inspect_records(root: Path, *, run_id: str | None = None, level: str | None = None,
                    component: str | None = None, trace_id: str | None = None,
                    limit: int = 200) -> list[dict[str, Any]]:
    """Read a bounded current/latest run, ignoring an incomplete final line."""

    root = Path(root).expanduser().absolute()
    if not root.is_dir() or _is_link_or_reparse(root):
        return []
    root = safe_diagnostics_root(root)
    summary = None
    if run_id is not None and _ID_PATTERN.fullmatch(run_id):
        summary = _load_json(root / f"run-{run_id}.json")
    if summary is None:
        summary = _load_json(root / LATEST_RUN_NAME)
    if not summary:
        return []
    minimum = _LEVEL_ORDER.get(level or "debug", 0)
    bounded_limit = max(1, min(int(limit), 1000))
    records: list[dict[str, Any]] = []
    for name in _safe_segment_names(summary):
        path = root / str(name)
        if path.parent != root or not path.is_file() or _is_link_or_reparse(path):
            continue
        try:
            with path.open("r", encoding="utf-8", errors="replace") as stream:
                for raw in stream:
                    if not raw.endswith("\n"):
                        continue
                    try:
                        value = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if not _valid_persisted_record(value):
                        continue
                    if _LEVEL_ORDER.get(value["level"], 0) < minimum:
                        continue
                    if component and value.get("component") != component:
                        continue
                    if trace_id and value.get("traceId") != trace_id:
                        continue
                    records.append(value)
        except OSError:
            continue
    return records[-bounded_limit:]


def follow_records(root: Path, *, level: str | None = None, component: str | None = None,
                   trace_id: str | None = None, poll_seconds: float = 0.25) -> Iterator[dict[str, Any]]:
    """Follow only launcher-owned current-run segments and tolerate rotation."""

    # Sequences are monotonic within a run.  Retaining only the current run's
    # high-water mark gives follow mode duplicate suppression without keeping
    # every record from every rotated run alive for the process lifetime.
    active_run_id: str | None = None
    last_sequence = -1
    while True:
        summary = latest_run_summary(root)
        if summary:
            run_id = str(summary.get("runId", ""))
            if run_id != active_run_id:
                active_run_id = run_id
                last_sequence = -1
            for record in inspect_records(root, run_id=run_id,
                                          level=level, component=component,
                                          trace_id=trace_id, limit=1000):
                sequence = int(record.get("sequence", 0))
                if sequence <= last_sequence:
                    continue
                last_sequence = sequence
                yield record
        marker = _load_json(Path(root) / RUN_MARKER_NAME)
        if marker is None:
            return
        time.sleep(max(0.05, min(float(poll_seconds), 1.0)))


def _valid_persisted_record(value: object) -> bool:
    return bool(
        isinstance(value, dict)
        and value.get("schema") == DIAGNOSTIC_SCHEMA
        and isinstance(value.get("sequence"), int)
        and value.get("level") in _LEVEL_ORDER
        and isinstance(value.get("component"), str)
        and isinstance(value.get("event"), str)
        and isinstance(value.get("runId"), str)
    )
