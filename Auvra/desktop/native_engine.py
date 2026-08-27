"""Owned process boundary for the Stage 6 native engine.

The Python host owns the process and session token.  The child owns native
world state; no native objects, file paths, or binary payloads cross this
boundary.  A single process instance is intentionally reusable across editor
reloads.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
import os
import queue
import secrets
import struct
import subprocess
import threading
from typing import Any, BinaryIO, Mapping, Sequence

from Auvra.host.dispatcher import HostOperationError


PROTOCOL_VERSION = "auvra.native/1"
SESSION_TOKEN_ENV = "AUVRA_NATIVE_SESSION_TOKEN"
MAX_FRAME_BYTES = 64 * 1024
_MAX_DIAGNOSTIC_BYTES = 64 * 1024


class NativeEngineError(RuntimeError):
    """Base class for bounded native-engine boundary failures."""


class NativeEngineConfigurationError(NativeEngineError, ValueError):
    """The native process configuration is invalid."""


class NativeEngineClosedError(NativeEngineError):
    """An operation was attempted after native shutdown."""


class NativeEngineStartupError(NativeEngineError):
    """The child did not reach its ready lifecycle state."""


class NativeEngineTimeoutError(NativeEngineError):
    """A bounded native operation exceeded its timeout."""


class NativeEngineChildExitedError(NativeEngineError):
    """The owned child exited while an operation was pending."""

    def __init__(self, returncode: int | None) -> None:
        self.returncode = returncode
        super().__init__(f"native child exited with status {returncode}")


class NativeEngineProtocolError(NativeEngineError):
    """The child violated framing or response correlation rules."""


class NativeEngineFrameTooLargeError(NativeEngineProtocolError):
    """A JSON frame exceeded the 64 KiB protocol limit."""


class NativeEngineAuthenticationError(NativeEngineProtocolError):
    """The child rejected the session authentication."""


class NativeEngineRevisionConflictError(NativeEngineError):
    """The native world rejected a stale expected revision."""

    def __init__(self, message: str, *, expected: int | None = None,
                 actual: int | None = None) -> None:
        self.expected = expected
        self.actual = actual
        super().__init__(message)


class NativeEngineResponseError(NativeEngineError):
    """A typed native error response was returned."""

    def __init__(self, code: str, message: str, details: Any = None) -> None:
        self.code = code
        self.details = details
        super().__init__(message)


class NativeEngineState(str, Enum):
    NEW = "new"
    STARTING = "starting"
    READY = "ready"
    CLOSING = "closing"
    CLOSED = "closed"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class NativeDiagnostic:
    """One bounded structured NDJSON record from native stderr."""

    record: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class NativeStatus:
    """Safe status snapshot without exposing the session token."""

    state: NativeEngineState
    pid: int | None
    revision: int | None
    diagnostics: tuple[NativeDiagnostic, ...]


def _encode_frame(value: Mapping[str, Any]) -> bytes:
    try:
        payload = json.dumps(
            value, ensure_ascii=False, allow_nan=False,
            separators=(",", ":"), sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise NativeEngineProtocolError("native request is not JSON data") from exc
    if len(payload) > MAX_FRAME_BYTES:
        raise NativeEngineFrameTooLargeError("native request exceeds the 64 KiB frame limit")
    return struct.pack(">I", len(payload)) + payload


def _read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise NativeEngineProtocolError("native response header is incomplete")
    size = struct.unpack(">I", header)[0]
    if size < 2 or size > MAX_FRAME_BYTES:
        raise NativeEngineFrameTooLargeError("native response exceeds the 64 KiB frame limit")
    payload = stream.read(size)
    if len(payload) != size:
        raise NativeEngineProtocolError("native response body is incomplete")
    try:
        value = json.loads(payload.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise NativeEngineProtocolError("native response is not valid JSON") from exc
    if not isinstance(value, dict):
        raise NativeEngineProtocolError("native response must be a JSON object")
    return value


def _validate_json_data(value: Any) -> None:
    """Reject path/binary values before they can enter the native protocol."""

    if isinstance(value, (bytes, bytearray, memoryview, os.PathLike)):
        raise NativeEngineProtocolError("native protocol does not carry paths or binary data")
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise NativeEngineProtocolError("native JSON object keys must be strings")
            _validate_json_data(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _validate_json_data(child)


class NativeEngine:
    """Own one long-lived native child and its authenticated request channel."""

    def __init__(self, command: Sequence[str], *, startup_timeout: float = 10.0,
                 request_timeout: float = 10.0, shutdown_timeout: float = 5.0,
                 environment: Mapping[str, str] | None = None) -> None:
        if not command or isinstance(command, (str, bytes)) or any(not isinstance(item, str) or not item for item in command):
            raise NativeEngineConfigurationError("native command must be a non-empty argument sequence")
        for name, value in (("startup", startup_timeout), ("request", request_timeout), ("shutdown", shutdown_timeout)):
            if not 0.05 <= value <= 120:
                raise NativeEngineConfigurationError(f"native {name} timeout must be between 0.05 and 120 seconds")
        self.command = tuple(command)
        self.startup_timeout = startup_timeout
        self.request_timeout = request_timeout
        self.shutdown_timeout = shutdown_timeout
        self._environment = dict(environment or os.environ)
        self._process: subprocess.Popen[bytes] | None = None
        self._token: str | None = None
        self._state = NativeEngineState.NEW
        self._revision: int | None = None
        self._request_number = 0
        self._request_lock = threading.Lock()
        self._response_queue: queue.Queue[dict[str, Any] | BaseException | None] = queue.Queue()
        self._ready = threading.Event()
        self._stderr_done = threading.Event()
        self._diagnostics: list[NativeDiagnostic] = []
        self._diagnostics_lock = threading.Lock()

    @property
    def process(self) -> subprocess.Popen[bytes] | None:
        return self._process

    @property
    def state(self) -> NativeEngineState:
        return self._state

    @property
    def status(self) -> NativeStatus:
        with self._diagnostics_lock:
            diagnostics = tuple(self._diagnostics)
        pid = self._process.pid if self._process is not None else None
        return NativeStatus(self._state, pid, self._revision, diagnostics)

    @property
    def diagnostics(self) -> tuple[NativeDiagnostic, ...]:
        return self.status.diagnostics

    def start(self, *, editor_session: str = "editor") -> NativeStatus:
        if self._state is not NativeEngineState.NEW:
            raise NativeEngineClosedError("native engine can only be started once")
        if not editor_session or len(editor_session) > 128:
            raise NativeEngineConfigurationError("editor session is invalid")
        self._state = NativeEngineState.STARTING
        self._token = secrets.token_hex(32)
        environment = dict(self._environment)
        environment[SESSION_TOKEN_ENV] = self._token
        try:
            self._process = subprocess.Popen(
                list(self.command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, env=environment, shell=False, bufsize=0,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, ValueError) as exc:
            self._state = NativeEngineState.FAILED
            raise NativeEngineStartupError("native process could not be started") from exc
        assert self._process.stderr is not None
        assert self._process.stdout is not None
        threading.Thread(target=self._read_stderr, args=(self._process.stderr,), daemon=True,
                         name="auvra-native-stderr").start()
        threading.Thread(target=self._read_stdout, args=(self._process.stdout,), daemon=True,
                         name="auvra-native-stdout").start()
        if not self._ready.wait(self.startup_timeout):
            self._state = NativeEngineState.FAILED
            self.close(timeout=min(self.shutdown_timeout, 1.0))
            raise NativeEngineStartupError("native process did not report ready before timeout")
        if self._process.poll() is not None:
            self._state = NativeEngineState.FAILED
            raise NativeEngineChildExitedError(self._process.returncode)
        try:
            self._call("session.hello", {"editorSession": editor_session})
        except NativeEngineError:
            self._state = NativeEngineState.FAILED
            self.close(timeout=min(self.shutdown_timeout, 1.0))
            raise
        self._state = NativeEngineState.READY
        return self.status

    def _read_stderr(self, stream: BinaryIO) -> None:
        try:
            for raw in iter(stream.readline, b""):
                if len(raw) > _MAX_DIAGNOSTIC_BYTES:
                    self._diagnostics_append({"level": "error", "code": "diagnostic_too_large"})
                    continue
                try:
                    record = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._diagnostics_append({"level": "error", "code": "invalid_diagnostic"})
                    continue
                if not isinstance(record, dict):
                    self._diagnostics_append({"level": "error", "code": "invalid_diagnostic"})
                    continue
                self._diagnostics_append(record)
                if record.get("event") == "native.ready":
                    self._ready.set()
        finally:
            self._stderr_done.set()
            if self._process is not None and self._process.poll() is not None:
                self._ready.set()

    def _diagnostics_append(self, record: dict[str, Any]) -> None:
        with self._diagnostics_lock:
            self._diagnostics.append(NativeDiagnostic(record))

    def _read_stdout(self, stream: BinaryIO) -> None:
        try:
            while True:
                frame = _read_frame(stream)
                if frame is None:
                    self._response_queue.put(None)
                    return
                self._response_queue.put(frame)
        except BaseException as exc:
            self._response_queue.put(exc)

    def _next_request_id(self) -> int:
        self._request_number += 1
        return self._request_number

    @staticmethod
    def _returncode(process: subprocess.Popen[bytes]) -> int | None:
        returncode = process.poll()
        if returncode is not None:
            return returncode
        try:
            return process.wait(timeout=0.1)
        except subprocess.TimeoutExpired:
            return process.poll()

    def _call(self, method: str, params: Mapping[str, Any] | None = None,
              *, timeout: float | None = None) -> dict[str, Any]:
        if not method or not isinstance(method, str):
            raise NativeEngineConfigurationError("native method is required")
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            raise NativeEngineClosedError("native process is unavailable")
        request_params = dict(params or {})
        _validate_json_data(request_params)
        request_id = self._next_request_id()
        request = {"protocol": PROTOCOL_VERSION, "id": request_id,
                   "method": method, "params": request_params}
        frame = _encode_frame(request)
        with self._request_lock:
            if process.poll() is not None:
                raise NativeEngineChildExitedError(self._returncode(process))
            try:
                process.stdin.write(frame)
                process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise NativeEngineChildExitedError(self._returncode(process)) from exc
            wait_for = self.request_timeout if timeout is None else timeout
            try:
                response = self._response_queue.get(timeout=wait_for)
            except queue.Empty as exc:
                raise NativeEngineTimeoutError(f"native method '{method}' timed out") from exc
        if response is None:
            raise NativeEngineChildExitedError(self._returncode(process))
        if isinstance(response, BaseException):
            raise response
        if response.get("protocol") != PROTOCOL_VERSION or response.get("id") != request_id:
            raise NativeEngineProtocolError("native response version or request id does not match")
        if response.get("ok") is True:
            result = response.get("result", {})
            if not isinstance(result, dict):
                raise NativeEngineProtocolError("native result must be a JSON object")
            if isinstance(result.get("revision"), int) and not isinstance(result.get("revision"), bool):
                self._revision = result["revision"]
            return result
        error = response.get("error")
        if not isinstance(error, dict) or not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
            raise NativeEngineProtocolError("native error response is malformed")
        code = error["code"]
        if code in {"unauthorized", "authentication_failed"}:
            raise NativeEngineAuthenticationError(error["message"])
        if code == "revision_conflict":
            raise NativeEngineRevisionConflictError(error["message"])
        raise NativeEngineResponseError(code, error["message"], error.get("details"))

    def call(self, method: str, params: Mapping[str, Any] | None = None,
             *, timeout: float | None = None) -> dict[str, Any]:
        """Call an allowed native method with exact response correlation."""

        if self._state is not NativeEngineState.READY:
            raise NativeEngineClosedError("native engine is not ready")
        return self._call(method, params, timeout=timeout)

    def session_hello(self, editor_session: str) -> dict[str, Any]:
        return self.call("session.hello", {"editorSession": editor_session})

    def snapshot_world(self) -> dict[str, Any]:
        return self.call("world.getSnapshot")

    def apply_world(self, expected_revision: int, entities: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        if expected_revision < 0 or isinstance(expected_revision, bool):
            raise NativeEngineConfigurationError("expected revision must be a non-negative integer")
        return self.call("world.apply", {"expectedRevision": expected_revision,
                                          "entities": list(entities)})

    def open_viewport(self, *, width: int = 1280, height: int = 720,
                      title: str = "Auvra Native Viewport") -> dict[str, Any]:
        return self.call("viewport.open", {"width": width, "height": height,
                                            "title": title})

    def close_viewport(self) -> dict[str, Any]:
        return self.call("viewport.close")

    def render_reference(self, *, width: int = 256, height: int = 256) -> dict[str, Any]:
        return self.call("renderer.renderReference", {"width": width, "height": height})

    def reference_metrics(self) -> dict[str, Any]:
        return self.call("renderer.getMetrics")

    def recover(self) -> dict[str, Any]:
        return self.call("renderer.recover")

    def close(self, *, timeout: float | None = None) -> None:
        if self._state in {NativeEngineState.CLOSED, NativeEngineState.NEW}:
            self._state = NativeEngineState.CLOSED
            return
        process = self._process
        self._state = NativeEngineState.CLOSING
        wait_for = self.shutdown_timeout if timeout is None else max(0.05, timeout)
        acknowledged = False
        if process is not None and process.poll() is None and process.stdin is not None:
            try:
                response = self._call("shutdown", {}, timeout=wait_for)
                acknowledged = response.get("stopped") is True
            except NativeEngineError:
                pass
        if process is not None:
            try:
                process.wait(timeout=wait_for)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=min(wait_for, 1.0))
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=min(wait_for, 1.0))
        self._state = NativeEngineState.CLOSED
        if process is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
        _ = acknowledged  # lifecycle evidence remains available in diagnostics

    def __enter__(self) -> "NativeEngine":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()


class NativeEngineHost:
    """Adapt UI ``engine.*`` calls to the fixed native child methods."""

    _MAX_EVENTS = 64
    _METHODS = frozenset({
        "engine.getStatus", "engine.getSnapshot", "engine.applyChanges",
        "engine.openViewport", "engine.closeViewport", "engine.renderReference",
        "engine.getMetrics", "engine.recover",
    })

    def __init__(self, engine: NativeEngine) -> None:
        self.engine = engine
        self._world_revision = 0
        self._viewport = "closed"
        self._backend: str | None = None
        self._adapter: str | None = None
        self._fallback_reason: str | None = None
        self._metrics: dict[str, Any] | None = None
        self._recovery_count = 0
        self._events: list[tuple[str, dict[str, Any]]] = []

    def start(self, *, editor_session: str = "editor") -> NativeStatus:
        status = self.engine.start(editor_session=editor_session)
        return status

    def close(self, *, timeout: float | None = None) -> None:
        self.engine.close(timeout=timeout)

    @staticmethod
    def _state_name(state: NativeEngineState) -> str:
        return {
            NativeEngineState.READY: "ready",
            NativeEngineState.STARTING: "starting",
            NativeEngineState.CLOSING: "stopped",
            NativeEngineState.CLOSED: "stopped",
            NativeEngineState.FAILED: "failed",
            NativeEngineState.NEW: "starting",
        }[state]

    def _canonical(self, kind: str, *, values: Mapping[str, Any] | None = None) -> dict[str, Any]:
        result: dict[str, Any] = {
            "kind": kind,
            "protocol": PROTOCOL_VERSION,
            "status": self._state_name(self.engine.state),
            "worldRevision": self._world_revision,
            "viewport": self._viewport,
        }
        if self._backend is not None:
            result["backend"] = self._backend
        if self._adapter is not None:
            result["adapter"] = self._adapter
        if self._fallback_reason is not None:
            result["fallbackReason"] = self._fallback_reason
        if self._metrics is not None:
            result["metrics"] = dict(self._metrics)
        if values:
            result.update(values)
        return result

    def _event(self, name: str, payload: Mapping[str, Any]) -> None:
        self._events.append((name, dict(payload)))
        if len(self._events) > self._MAX_EVENTS:
            del self._events[:len(self._events) - self._MAX_EVENTS]

    def drain_events(self) -> list[tuple[str, dict[str, Any]]]:
        events, self._events = self._events, []
        return events

    @staticmethod
    def _translate_error(error: NativeEngineError) -> HostOperationError:
        if isinstance(error, NativeEngineRevisionConflictError):
            details: dict[str, Any] = {}
            if error.expected is not None:
                details["expectedRevision"] = error.expected
            if error.actual is not None:
                details["actualRevision"] = error.actual
            return HostOperationError("revision_conflict", str(error), details)
        if isinstance(error, NativeEngineAuthenticationError):
            return HostOperationError("permission_denied", "Native engine authentication failed")
        if isinstance(error, NativeEngineResponseError):
            allowed = {"invalid_request", "unsupported_version", "revision_conflict",
                       "unsupported_capability", "recovery_required", "internal_error",
                       "unknown_method"}
            code = "invalid_request" if error.code == "already_open" else error.code if error.code in allowed else "internal_error"
            return HostOperationError(code, str(error))
        if isinstance(error, (NativeEngineTimeoutError, NativeEngineChildExitedError,
                              NativeEngineProtocolError, NativeEngineClosedError)):
            return HostOperationError("recovery_required", "Native engine is unavailable",
                                      {"retryable": True})
        return HostOperationError("internal_error", "Native engine operation failed")

    def _capabilities(self) -> dict[str, Any]:
        capabilities = self.engine.call("renderer.getCapabilities")
        if isinstance(capabilities.get("backend"), str):
            self._backend = capabilities["backend"]
        if isinstance(capabilities.get("adapter"), str):
            self._adapter = capabilities["adapter"]
        if isinstance(capabilities.get("fallback"), str):
            self._fallback_reason = capabilities["fallback"]
        return capabilities

    def handle(self, method: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if method not in self._METHODS:
            raise HostOperationError("unknown_method", "Unknown native engine method")
        if not isinstance(payload, Mapping):
            raise HostOperationError("invalid_request", "Native engine payload must be an object")
        try:
            if method == "engine.getStatus":
                self._capabilities()
                result = self._canonical("engine.status")
            elif method == "engine.getSnapshot":
                snapshot = self.engine.call("world.getSnapshot")
                self._world_revision = int(snapshot.get("revision", self._world_revision))
                result = self._canonical("engine.snapshot", values={"entities": snapshot.get("entities", [])})
            elif method == "engine.applyChanges":
                expected = payload.get("expectedRevision")
                entities = payload.get("entities")
                if not isinstance(expected, int) or isinstance(expected, bool) or not isinstance(entities, list):
                    raise HostOperationError("invalid_request", "expectedRevision and entities are required")
                applied = self.engine.call("world.apply", {"expectedRevision": expected, "entities": entities})
                self._world_revision = int(applied.get("revision", self._world_revision + 1))
                result = self._canonical("engine.applyChanges", values={"entities": applied.get("entities", entities)})
                self._event("engine.revision", {"worldRevision": self._world_revision})
            elif method == "engine.openViewport":
                width, height = payload.get("width", 1280), payload.get("height", 720)
                title = payload.get("title", "Auvra Native Viewport")
                if not isinstance(width, int) or isinstance(width, bool) or not isinstance(height, int) or isinstance(height, bool) or not isinstance(title, str):
                    raise HostOperationError("invalid_request", "viewport dimensions and title are invalid")
                self.engine.call("viewport.open", {"width": width, "height": height, "title": title})
                self._viewport = "open"
                result = self._canonical("engine.openViewport")
                self._event("engine.viewport", {"viewport": self._viewport})
            elif method == "engine.closeViewport":
                self.engine.call("viewport.close")
                self._viewport = "closed"
                result = self._canonical("engine.closeViewport")
                self._event("engine.viewport", {"viewport": self._viewport})
            elif method == "engine.renderReference":
                width, height = payload.get("width", 256), payload.get("height", 256)
                if not isinstance(width, int) or isinstance(width, bool) or not isinstance(height, int) or isinstance(height, bool):
                    raise HostOperationError("invalid_request", "reference dimensions are invalid")
                rendered = self.engine.call("renderer.renderReference", {"width": width, "height": height})
                values: dict[str, Any] = {
                    "width": rendered.get("width", width),
                    "height": rendered.get("height", height),
                }
                if isinstance(rendered.get("pixel_hash_fnv1a64"), str):
                    values["signature"] = rendered["pixel_hash_fnv1a64"].removeprefix("0x")
                result = self._canonical("engine.renderReference", values=values)
            elif method == "engine.getMetrics":
                raw = self.engine.call("renderer.getMetrics")
                self._metrics = {
                    "startupMs": raw.get("startup_ms", 0),
                    "frameCpuMs": raw.get("last_frame_submit_ms"),
                    "gpuFrameMs": raw.get("gpu_frame_ms"),
                    "memoryBytes": raw.get("memory_bytes", 0),
                    "recoveryCount": self._recovery_count,
                }
                result = self._canonical("engine.metrics")
            else:  # engine.recover
                recovered = self.engine.call("renderer.recover")
                self._recovery_count += 1
                if self._metrics is not None:
                    self._metrics["recoveryCount"] = self._recovery_count
                caps = recovered.get("capabilities")
                if isinstance(caps, dict):
                    if isinstance(caps.get("backend"), str): self._backend = caps["backend"]
                    if isinstance(caps.get("adapter"), str): self._adapter = caps["adapter"]
                result = self._canonical("engine.recover")
                self._event("engine.recovery", {
                    "worldRevision": self._world_revision,
                    "metrics": self._metrics or {
                        "startupMs": 0, "frameCpuMs": None, "gpuFrameMs": None,
                        "memoryBytes": 0, "recoveryCount": self._recovery_count,
                    },
                })
            self._event("engine.status", {key: value for key, value in result.items()
                                           if key in {"status", "worldRevision", "viewport", "backend", "adapter", "fallbackReason"}})
            return result
        except HostOperationError:
            raise
        except NativeEngineError as error:
            raise self._translate_error(error) from error


class NativeEngineUnavailableHost:
    """Declared web fallback when the development native binary is unavailable."""

    def __init__(self, reason: str = "Native engine executable is unavailable") -> None:
        self.reason = reason[:256]

    def handle(self, method: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        kind = {
            "engine.getStatus": "engine.status",
            "engine.getSnapshot": "engine.snapshot",
            "engine.closeViewport": "engine.closeViewport",
            "engine.getMetrics": "engine.metrics",
        }.get(method)
        if kind is None:
            raise HostOperationError("unsupported_capability", self.reason)
        result: dict[str, Any] = {
            "kind": kind, "protocol": PROTOCOL_VERSION, "status": "degraded",
            "worldRevision": 0, "viewport": "closed", "backend": "WebGL2",
            "adapter": "web compatibility renderer", "fallbackReason": self.reason,
        }
        if method == "engine.getSnapshot":
            result["entities"] = []
        if method == "engine.getMetrics":
            result["metrics"] = {
                "startupMs": 0, "frameCpuMs": None, "gpuFrameMs": None,
                "memoryBytes": 0, "recoveryCount": 0,
            }
        return result

    def drain_events(self) -> list[tuple[str, dict[str, Any]]]:
        return []
