"""Owned process boundary for the Stage 6 native engine.

The Python host owns the process and session token.  The child owns native
world state; no native objects, file paths, or binary payloads cross this
boundary.  A single process instance is intentionally reusable across editor
reloads.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import struct
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO, Callable, Mapping, Sequence

from Auvra.diagnostics.core import active_diagnostics, current_diagnostic_context, trace_public_class
from Auvra.host.dispatcher import HostOperationError
from Auvra.host.logging import redact
from Auvra.launcher.platform import PosixProcessGroup, WindowsJob


PROTOCOL_VERSION = "auvra.native/1"
SESSION_TOKEN_ENV = "AUVRA_NATIVE_SESSION_TOKEN"
NATIVE_SOURCE_ROOT_ENV = "AUVRA_NATIVE_SOURCE_ROOT"
NATIVE_DERIVED_ROOT_ENV = "AUVRA_NATIVE_DERIVED_ROOT"
MAX_FRAME_BYTES = 64 * 1024
_MAX_DIAGNOSTIC_BYTES = 64 * 1024
_MAX_DIAGNOSTIC_RECORD_BYTES = 8 * 1024
_MAX_DIAGNOSTIC_RECORDS = 256
_NATIVE_DIAGNOSTIC_SCHEMA = "auvra.native-diagnostic/1"
_NATIVE_DIAGNOSTIC_EVENTS = frozenset({
    "native.ready", "native.stopped", "native.eof", "native.protocol_failed",
    "native.configuration_failed", "native.fatal", "native.diagnostic_failure",
    "native.operation_started", "native.operation_phase",
    "native.operation_completed", "native.operation_failed",
})
_NATIVE_DIAGNOSTIC_CODES = frozenset({
    "fatal_protocol_error", "invalid_session_token", "fatal_error",
    "serialization_failed",
    "operation_failed",
})
_NATIVE_DIAGNOSTIC_PHASES = frozenset({
    "dispatch", "complete", "world_validate", "world_commit", "world_advance",
    "hydration_validate", "hydration_commit", "asset_submit", "asset_status",
    "render_extract", "render_plan", "render_submit", "viewport_open",
    "viewport_close", "renderer_recover", "session_start", "shutdown",
})
_NATIVE_DIAGNOSTIC_METHODS = frozenset({
    "session.hello", "world.getSnapshot", "world.apply", "world.applyTransaction",
    "world.applyCommands", "world.validateHydration", "world.hydrate",
    "world.beginHydration", "world.appendHydration", "world.commitHydration",
    "world.abortHydration", "world.closeProject", "world.advance", "world.getReplay",
    "renderer.getCapabilities", "renderer.renderReference", "renderer.extract",
    "renderer.getMetrics", "renderer.recover", "asset.submit", "asset.beginCook",
    "asset.status", "asset.cancel", "viewport.open", "viewport.close", "shutdown",
})


def _session_proof(token: str, challenge: str, editor_session: str) -> str:
    message = f"{challenge}\n{editor_session}".encode("utf-8")
    return hmac.new(token.encode("ascii"), message, hashlib.sha256).hexdigest()


_ENGINE_FEATURES = (
    "pbr_metallic_roughness", "skeletal_animation", "frustum_culling",
    "deterministic_lod", "instance_batching", "directional_lights",
    "point_lights", "spot_lights", "shadow_maps", "image_based_lighting",
    "entity_picking", "editor_gizmos", "hdr_intermediate",
    "aces_tone_mapping", "msaa_or_fxaa", "post_processing_chain",
)


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
    """Compatibility view of one canonical native-component record."""

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
    header = bytearray()
    while len(header) < 4:
        chunk = stream.read(4 - len(header))
        if not chunk:
            if not header:
                return None
            raise NativeEngineProtocolError("native response header is incomplete")
        header.extend(chunk)
    size = struct.unpack(">I", header)[0]
    if size < 2 or size > MAX_FRAME_BYTES:
        raise NativeEngineFrameTooLargeError("native response exceeds the 64 KiB frame limit")
    payload = bytearray()
    while len(payload) < size:
        chunk = stream.read(size - len(payload))
        if not chunk:
            raise NativeEngineProtocolError("native response body is incomplete")
        payload.extend(chunk)
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
            normalized_key = "".join(character for character in key.casefold() if character.isalnum())
            if normalized_key in {
                "path", "filepath", "filesystempath", "sourcepath", "derivedpath",
                "assetpath", "directorypath", "absolutepath", "localpath",
                "base64", "binary", "bytes", "blob",
            }:
                raise NativeEngineProtocolError("native protocol does not carry paths or binary data")
            _validate_json_data(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _validate_json_data(child)
    elif isinstance(value, str):
        windows_absolute = (
            len(value) >= 3 and value[0].isalpha() and value[1] == ":"
            and value[2] in {"/", "\\"}
        )
        if (windows_absolute or value.startswith(("/", "\\\\", "//"))
                or value.casefold().startswith("data:")):
            raise NativeEngineProtocolError("native protocol does not carry paths or binary data")


@trace_public_class("native_engine", concise=(
    "start", "restart", "call", "session_hello", "apply_world",
    "open_viewport", "close_viewport", "render_reference", "recover", "close",
))
class NativeEngine:
    """Own one long-lived native child and its authenticated request channel."""

    def __init__(self, command: Sequence[str], *, startup_timeout: float = 10.0,
                 request_timeout: float = 10.0, shutdown_timeout: float = 5.0,
                 environment: Mapping[str, str] | None = None,
                 source_root: Path | str | None = None,
                 derived_root: Path | str | None = None,
                 diagnostics: Any = None) -> None:
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
        self.source_root = Path(source_root).expanduser().absolute() if source_root is not None else None
        self.derived_root = Path(derived_root).expanduser().absolute() if derived_root is not None else None
        self._runtime_diagnostics = diagnostics if diagnostics is not None else active_diagnostics()
        self._process: subprocess.Popen[bytes] | None = None
        self._process_owner: Any = None
        self._token: str | None = None
        self._state = NativeEngineState.NEW
        self._revision: int | None = None
        self._request_number = 0
        self._request_lock = threading.Lock()
        self._response_queue: queue.Queue[dict[str, Any] | BaseException | None] = queue.Queue()
        self._ready = threading.Event()
        self._stderr_done = threading.Event()

    @property
    def process(self) -> subprocess.Popen[bytes] | None:
        return self._process

    @property
    def state(self) -> NativeEngineState:
        return self._state

    @property
    def status(self) -> NativeStatus:
        diagnostics = self.diagnostics
        pid = self._process.pid if self._process is not None else None
        return NativeStatus(self._state, pid, self._revision, diagnostics)

    @property
    def diagnostics(self) -> tuple[NativeDiagnostic, ...]:
        if self._runtime_diagnostics is None:
            return ()
        records = [record for record in self._runtime_diagnostics.snapshot()
                   if record.get("component") == "native"][-_MAX_DIAGNOSTIC_RECORDS:]
        return tuple(NativeDiagnostic(record) for record in records)

    def start(self, *, editor_session: str = "editor") -> NativeStatus:
        if self._state is not NativeEngineState.NEW:
            raise NativeEngineClosedError("native engine can only be started once")
        if not editor_session or len(editor_session) > 128:
            raise NativeEngineConfigurationError("editor session is invalid")
        self._state = NativeEngineState.STARTING
        if self._runtime_diagnostics is not None:
            self._runtime_diagnostics.emit("native", "native.lifecycle",
                                           attributes={"state": "starting", "protocol": PROTOCOL_VERSION})
        self._token = secrets.token_hex(32)
        environment = dict(self._environment)
        environment[SESSION_TOKEN_ENV] = self._token
        if self.source_root is not None:
            self.source_root.mkdir(parents=True, exist_ok=True)
            environment[NATIVE_SOURCE_ROOT_ENV] = str(self.source_root)
        if self.derived_root is not None:
            self.derived_root.mkdir(parents=True, exist_ok=True)
            environment[NATIVE_DERIVED_ROOT_ENV] = str(self.derived_root)
        owner: Any = None
        try:
            owner = WindowsJob() if os.name == "nt" else PosixProcessGroup()
            launch_kwargs = dict(getattr(owner, "creation_kwargs", {}))
            if os.name == "nt":
                launch_kwargs["creationflags"] = int(launch_kwargs.get("creationflags", 0)) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self._process = subprocess.Popen(
                list(self.command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, env=environment, shell=False, bufsize=0,
                **launch_kwargs,
            )
            self._process_owner = owner
            if os.name == "nt":
                owner.assign(self._process)
            else:
                owner.attach(self._process)
        except (OSError, ValueError) as exc:
            if self._process is not None:
                try:
                    if owner is not None:
                        owner.kill(self._process)
                    else:
                        self._process.kill()
                except Exception:
                    pass
                try:
                    self._process.wait(timeout=1)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            if owner is not None:
                try:
                    owner.close()
                except Exception:
                    pass
            self._process_owner = None
            self._state = NativeEngineState.FAILED
            if self._runtime_diagnostics is not None:
                self._runtime_diagnostics.emit("native", "native.lifecycle",
                                               attributes={"state": "failed", "code": "process_start_failed",
                                                           "errorType": type(exc).__name__})
            raise NativeEngineStartupError("native process could not be started") from exc
        assert self._process.stderr is not None
        assert self._process.stdout is not None
        threading.Thread(target=self._read_stderr,
                         args=(self._process.stderr, self._process, self._ready, self._stderr_done), daemon=True,
                         name="auvra-native-stderr").start()
        threading.Thread(target=self._read_stdout, args=(self._process.stdout, self._response_queue), daemon=True,
                         name="auvra-native-stdout").start()
        if not self._ready.wait(self.startup_timeout):
            self._state = NativeEngineState.FAILED
            if self._runtime_diagnostics is not None:
                self._runtime_diagnostics.emit("native", "native.lifecycle",
                                               attributes={"state": "failed", "code": "startup_timeout",
                                                           "timeoutMs": round(self.startup_timeout * 1000, 3)})
            self.close(timeout=min(self.shutdown_timeout, 1.0))
            raise NativeEngineStartupError("native process did not report ready before timeout")
        if self._process.poll() is not None:
            self._state = NativeEngineState.FAILED
            if self._runtime_diagnostics is not None:
                self._runtime_diagnostics.emit("native", "native.lifecycle",
                                               attributes={"state": "exited", "code": "child_exited",
                                                           "returnCode": self._process.returncode})
            # A child that exits before readiness may already have spawned
            # descendants. Close the ownership boundary before surfacing the
            # typed startup failure so those descendants cannot outlive the
            # failed launch.
            self.close(timeout=min(self.shutdown_timeout, 1.0))
            raise NativeEngineChildExitedError(self._process.returncode)
        try:
            self._call("session.hello", {"editorSession": editor_session})
        except NativeEngineError:
            self._state = NativeEngineState.FAILED
            self.close(timeout=min(self.shutdown_timeout, 1.0))
            raise
        self._state = NativeEngineState.READY
        if self._runtime_diagnostics is not None:
            self._runtime_diagnostics.emit("native", "native.lifecycle",
                                           attributes={"state": "ready", "protocol": PROTOCOL_VERSION})
        return self.status

    def restart(self, *, editor_session: str = "editor") -> NativeStatus:
        """Replace the owned child while retaining no durable project state."""
        if self._state in {NativeEngineState.STARTING, NativeEngineState.CLOSING}:
            raise NativeEngineClosedError("native engine is already transitioning")
        if self._state is NativeEngineState.NEW:
            return self.start(editor_session=editor_session)
        self.close(timeout=self.shutdown_timeout)
        # Reader threads from the previous child may finish after close; the
        # new child receives a fresh transport queue and readiness event.
        self._process = None
        self._process_owner = None
        self._token = None
        self._state = NativeEngineState.NEW
        self._revision = None
        self._request_number = 0
        self._response_queue = queue.Queue()
        self._ready = threading.Event()
        self._stderr_done = threading.Event()
        return self.start(editor_session=editor_session)

    def _read_stderr(self, stream: BinaryIO, process: subprocess.Popen[bytes],
                     ready: threading.Event, done: threading.Event) -> None:
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
                accepted = self._diagnostics_append(record)
                if accepted and record.get("event") == "native.ready":
                    ready.set()
                    if self._runtime_diagnostics is not None:
                        self._runtime_diagnostics.emit("native", "native.lifecycle",
                                                       attributes={"state": "child_ready",
                                                                   "source": "stderr"})
        finally:
            done.set()
            if process.poll() is not None:
                ready.set()
                if self._runtime_diagnostics is not None:
                    self._runtime_diagnostics.emit("native", "native.lifecycle",
                                                   attributes={"state": "stderr_closed",
                                                               "returnCode": process.returncode})

    def _diagnostics_append(self, record: dict[str, Any]) -> bool:
        safe = redact(record, max_depth=6, max_items=64, max_string=512)
        if not isinstance(safe, dict):
            safe = {"level": "error", "code": "invalid_diagnostic"}
        encoded = json.dumps(safe, ensure_ascii=True, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > _MAX_DIAGNOSTIC_RECORD_BYTES:
            safe = {"level": "warning", "code": "diagnostic_truncated"}
        diagnostics = self._runtime_diagnostics
        if (set(safe) - {"schema", "level", "event", "method", "code", "traceId",
                         "spanId", "parentSpanId", "phase", "outcome", "durationMs"}
                or safe.get("schema") != _NATIVE_DIAGNOSTIC_SCHEMA
                or safe.get("level") not in {"debug", "info", "warning", "error", "critical"}
                or safe.get("event") not in _NATIVE_DIAGNOSTIC_EVENTS
                or ("method" in safe and safe.get("method") not in _NATIVE_DIAGNOSTIC_METHODS)
                or ("code" in safe and safe.get("code") not in _NATIVE_DIAGNOSTIC_CODES)
                or any(key in safe and (not isinstance(safe.get(key), str)
                                        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", safe[key]))
                       for key in ("traceId", "spanId", "parentSpanId"))
                or ("phase" in safe and safe.get("phase") not in _NATIVE_DIAGNOSTIC_PHASES)
                or ("outcome" in safe and safe.get("outcome") not in {"success", "failure", "cancelled"})
                or ("durationMs" in safe and (not isinstance(safe.get("durationMs"), (int, float))
                                               or isinstance(safe.get("durationMs"), bool)
                                               or not 0 <= safe["durationMs"] <= 86_400_000))):
            if diagnostics is not None:
                diagnostics.emit("native", "native.diagnostic_invalid",
                                 attributes={"code": "invalid_diagnostic"}, deduplicate=False)
            return False
        if diagnostics is None:
            return True
        code = safe.get("code") if isinstance(safe.get("code"), str) else None
        child_event = safe.get("event") if isinstance(safe.get("event"), str) else "native.diagnostic"
        level = safe.get("level")
        event = ("native.child_error" if level in {"error", "critical"} else
                 "native.child_warning" if level == "warning" else "native.child_record")
        attributes: dict[str, Any] = {"state": child_event, "source": "stderr"}
        if code is not None:
            attributes["code"] = code
        for key in ("method", "phase", "outcome", "durationMs"):
            if key in safe:
                attributes[key] = safe[key]
        diagnostics.emit(
            "native", event,
            trace_id=safe.get("traceId") if isinstance(safe.get("traceId"), str) else None,
            span_id=safe.get("spanId") if isinstance(safe.get("spanId"), str) else None,
            parent_span_id=(safe.get("parentSpanId")
                            if isinstance(safe.get("parentSpanId"), str) else None),
            attributes=attributes,
        )
        return True

    def _read_stdout(self, stream: BinaryIO,
                     response_queue: queue.Queue[dict[str, Any] | BaseException | None]) -> None:
        try:
            while True:
                frame = _read_frame(stream)
                if frame is None:
                    response_queue.put(None)
                    return
                response_queue.put(frame)
        except BaseException as exc:
            response_queue.put(exc)

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

    def _terminate_owned_process(self, process: subprocess.Popen[bytes], *, timeout: float) -> None:
        """Stop the native root and its launcher-owned process tree."""

        owner = self._process_owner
        try:
            if owner is not None:
                owner.terminate(process)
            else:
                process.terminate()
        except (OSError, ValueError):
            pass
        try:
            process.wait(timeout=max(0.05, timeout))
        except subprocess.TimeoutExpired:
            pass
        # Kill through the ownership boundary even when the root already
        # exited: descendants may still be alive in the group/job.
        try:
            if owner is not None:
                owner.kill(process)
            elif process.poll() is None:
                process.kill()
        except (OSError, ValueError):
            pass
        if process.poll() is None:
            try:
                process.kill()
                process.wait(timeout=min(max(0.05, timeout), 1.0))
            except (OSError, subprocess.TimeoutExpired):
                pass

    def _invalidate_transport(self, *, code: str) -> None:
        """Fail closed after a response-channel timeout or protocol fault.

        A timed-out request may still produce a late frame.  Retaining the
        reader and response queue would let that frame be consumed as the
        response to a later request, permanently shifting correlation.  The
        queue is therefore replaced and the child is terminated before any
        subsequent call can be accepted; callers can use the explicit
        restart path to create a fresh channel.
        """
        self._state = NativeEngineState.FAILED
        self._response_queue = queue.Queue()
        process = self._process
        if process is not None:
            self._terminate_owned_process(process, timeout=min(self.shutdown_timeout, 1.0))
        if self._runtime_diagnostics is not None:
            self._runtime_diagnostics.emit(
                "native", "native.lifecycle",
                attributes={"state": "failed", "code": code},
            )

    def _call_transport(self, method: str, params: Mapping[str, Any] | None = None,
                        *, timeout: float | None = None) -> dict[str, Any]:
        if not method or not isinstance(method, str):
            raise NativeEngineConfigurationError("native method is required")
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            raise NativeEngineClosedError("native process is unavailable")
        request_params = dict(params or {})
        if method == "session.hello":
            token = self._token
            editor_session = request_params.get("editorSession")
            if token is None or not isinstance(editor_session, str) or not editor_session:
                raise NativeEngineAuthenticationError("native session proof cannot be constructed")
            challenge = secrets.token_hex(32)
            request_params["challenge"] = challenge
            request_params["proof"] = _session_proof(token, challenge, editor_session)
        _validate_json_data(request_params)
        diagnostic_context = current_diagnostic_context()
        trace_id = diagnostic_context.get("traceId")
        span_id = diagnostic_context.get("spanId")
        parent_span_id = diagnostic_context.get("parentSpanId")
        request_params["__diagnostics"] = {
            **({"traceId": trace_id} if trace_id else {}),
            **({"spanId": span_id} if span_id else {}),
            **({"parentSpanId": parent_span_id} if parent_span_id else {}),
            "detailed": bool(self._runtime_diagnostics and self._runtime_diagnostics.detailed),
        }
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
                self._invalidate_transport(code="response_timeout")
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
            _validate_json_data(result)
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

    def _call(self, method: str, params: Mapping[str, Any] | None = None,
              *, timeout: float | None = None) -> dict[str, Any]:
        started = time.monotonic()
        request_id = f"native-{self._request_number + 1}"
        diagnostics = self._runtime_diagnostics
        context = current_diagnostic_context()
        trace_id = context.get("traceId") or request_id
        session_id = context.get("sessionId")
        activity = (diagnostics.begin_activity("native", method, request_id=request_id,
                                               trace_id=trace_id)
                    if diagnostics is not None else None)
        if diagnostics is not None:
            diagnostics.emit("native", "native.request_started", session_id=session_id,
                             request_id=request_id, trace_id=trace_id,
                             attributes={"method": method})
        try:
            result = self._call_transport(method, params, timeout=timeout)
            if diagnostics is not None:
                diagnostics.emit("native", "native.request_completed", session_id=session_id,
                                 request_id=request_id, trace_id=trace_id,
                                 attributes={"method": method, "outcome": "success",
                                             "durationMs": round((time.monotonic() - started) * 1000, 3),
                                             "revision": self._revision})
            return result
        except NativeEngineTimeoutError as exc:
            if diagnostics is not None:
                diagnostics.emit("native", "native.request_timed_out", session_id=session_id,
                                 request_id=request_id, trace_id=trace_id,
                                 attributes={"method": method, "outcome": "failure",
                                             "code": "timeout", "errorType": type(exc).__name__,
                                             "timeoutMs": round((self.request_timeout if timeout is None else timeout) * 1000, 3),
                                             "durationMs": round((time.monotonic() - started) * 1000, 3)})
            raise
        except NativeEngineError as exc:
            if diagnostics is not None:
                diagnostics.emit("native", "native.request_failed", session_id=session_id,
                                 request_id=request_id, trace_id=trace_id,
                                 attributes={"method": method, "outcome": "failure",
                                             "code": getattr(exc, "code", type(exc).__name__),
                                             "errorType": type(exc).__name__,
                                             "durationMs": round((time.monotonic() - started) * 1000, 3)})
            raise
        finally:
            if activity is not None:
                activity.finish()

    def call(self, method: str, params: Mapping[str, Any] | None = None,
             *, timeout: float | None = None) -> dict[str, Any]:
        """Call an allowed native method with exact response correlation."""

        if self._state is not NativeEngineState.READY:
            raise NativeEngineClosedError("native engine is not ready")
        return self._call(method, params, timeout=timeout)

    def session_hello(self, editor_session: str) -> dict[str, Any]:
        return self.call("session.hello", {"editorSession": editor_session})

    def snapshot_world(self) -> dict[str, Any]:
        first = self.call("world.getSnapshot", {"offset": 0, "limit": 256})
        page = first.get("page")
        # Older development binaries do not return paging metadata. Preserve
        # their one-page response for compatibility while current binaries
        # are required to prove that every bounded page was collected.
        if not isinstance(page, Mapping):
            return first
        offset = page.get("offset")
        limit = page.get("limit")
        total = page.get("total")
        has_more = page.get("hasMore")
        entities = first.get("entities")
        if (not isinstance(offset, int) or isinstance(offset, bool) or offset != 0
                or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 256
                or not isinstance(total, int) or isinstance(total, bool) or not 0 <= total <= 1024
                or not isinstance(has_more, bool) or not isinstance(entities, list)
                or len(entities) > limit or len(entities) > total):
            raise NativeEngineProtocolError("native snapshot paging metadata is invalid")
        collected = list(entities)
        next_offset = len(collected)
        while has_more:
            if next_offset >= total:
                raise NativeEngineProtocolError("native snapshot paging did not advance")
            current = self.call("world.getSnapshot", {"offset": next_offset, "limit": limit})
            current_page = current.get("page")
            current_entities = current.get("entities")
            if not isinstance(current_page, Mapping) or not isinstance(current_entities, list):
                raise NativeEngineProtocolError("native snapshot paging metadata is invalid")
            if (current_page.get("offset") != next_offset
                    or current_page.get("limit") != limit
                    or current_page.get("total") != total
                    or not isinstance(current_page.get("hasMore"), bool)
                    or len(current_entities) == 0
                    or len(current_entities) > limit
                    or len(collected) + len(current_entities) > total):
                raise NativeEngineProtocolError("native snapshot paging metadata is inconsistent")
            for key in ("revision", "worldRevision", "tick", "worldHash", "projectId", "projectRevision", "replayHash"):
                if key in first and current.get(key) != first.get(key):
                    raise NativeEngineProtocolError("native snapshot changed while paging")
            collected.extend(current_entities)
            next_offset = len(collected)
            has_more = current_page["hasMore"]
        if next_offset != total:
            raise NativeEngineProtocolError("native snapshot paging was incomplete")
        result = dict(first)
        result["entities"] = collected
        result["page"] = {"offset": 0, "limit": limit, "total": total, "hasMore": False}
        return result

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
        if self._runtime_diagnostics is not None:
            self._runtime_diagnostics.emit("native", "native.lifecycle",
                                           attributes={"state": "closing"})
        wait_for = self.shutdown_timeout if timeout is None else max(0.05, timeout)
        acknowledged = False
        if process is not None and process.poll() is None and process.stdin is not None:
            try:
                response = self._call("shutdown", {}, timeout=wait_for)
                acknowledged = response.get("stopped") is True
            except NativeEngineError:
                pass
        if process is not None:
            if process.poll() is None:
                try:
                    process.wait(timeout=wait_for)
                except subprocess.TimeoutExpired:
                    self._terminate_owned_process(process, timeout=min(wait_for, 1.0))
            else:
                # Even an exited root may leave descendants in the owned
                # process group/job, so run the owner kill path once more.
                self._terminate_owned_process(process, timeout=min(wait_for, 1.0))
            owner = self._process_owner
            if owner is not None:
                try:
                    owner.close()
                except OSError:
                    pass
                self._process_owner = None
        self._state = NativeEngineState.CLOSED
        if process is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
        if self._runtime_diagnostics is not None:
            self._runtime_diagnostics.emit("native", "native.lifecycle",
                                           attributes={"state": "closed", "acknowledged": acknowledged,
                                                       "returnCode": process.returncode if process is not None else None})

    def __enter__(self) -> "NativeEngine":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()


@trace_public_class("native_engine_host", concise=(
    "start", "restart", "close", "stage_asset", "validate_project",
    "hydrate_project", "close_project", "handle",
))
class NativeEngineHost:
    """Adapt UI ``engine.*`` calls to the fixed native child methods."""

    _MAX_EVENTS = 64
    _METHODS = frozenset({
        "engine.getStatus", "engine.getSnapshot", "engine.applyChanges",
        "engine.openViewport", "engine.closeViewport", "engine.renderReference",
        "engine.getMetrics", "engine.recover",
    })

    def __init__(self, engine: NativeEngine, *, source_root: Path | str | None = None) -> None:
        self.engine = engine
        configured_source = source_root if source_root is not None else getattr(engine, "source_root", None)
        self._source_root = Path(configured_source).expanduser().absolute() if configured_source is not None else None
        self._world_revision = 0
        self._project_id: str | None = None
        self._project_revision = 0
        self._project_payload: dict[str, Any] | None = None
        self._staged_assets: set[str] = set()
        self._dock_target_provider: Callable[[], Mapping[str, int] | None] | None = None
        self._dock_support: str = "unsupported"
        self._dock_active = False
        self._dock_reason: str | None = None
        self._viewport = "closed"
        self._backend: str | None = None
        self._adapter: str | None = None
        self._device_type: str | None = None
        self._fallback_reason: str | None = None
        self._metrics: dict[str, Any] | None = None
        self._native_fields: dict[str, Any] = {}
        self._recovery_count = 0
        self._events: list[tuple[str, dict[str, Any]]] = []
        self._editor_session = "editor"

    def start(self, *, editor_session: str = "editor") -> NativeStatus:
        self._editor_session = editor_session
        status = self.engine.start(editor_session=editor_session)
        if self._project_payload is not None:
            self._hydrate_native()
        return status

    def restart(self, *, editor_session: str = "editor") -> NativeStatus:
        self._editor_session = editor_session
        self._world_revision = 0
        self._viewport = "closed"
        self._dock_active = False
        self._dock_reason = None
        restart = getattr(self.engine, "restart", None)
        if not callable(restart):
            raise NativeEngineClosedError("native engine restart is unavailable")
        status = restart(editor_session=editor_session)
        if self._project_payload is not None:
            self._hydrate_native()
        return status

    def close(self, *, timeout: float | None = None) -> None:
        self.engine.close(timeout=timeout)

    def set_dock_target_provider(self, provider: Callable[[], Mapping[str, int] | None] | None) -> None:
        """Bind an internal frame seam; browser payloads cannot provide handles."""
        self._dock_target_provider = provider

    def stage_asset(self, asset_id: str, stream: BinaryIO, *, chunk_size: int = 1024 * 1024) -> None:
        """Copy one verified project asset to the private native source cache.

        The project repository remains canonical.  This cache is rebuildable,
        addressed only by the verified lowercase SHA-256 asset id, and never
        appears in a UI or native JSON payload.
        """
        if not isinstance(asset_id, str) or len(asset_id) != 64 or any(c not in "0123456789abcdef" for c in asset_id):
            raise NativeEngineConfigurationError("native asset identity is invalid")
        if self._source_root is None:
            raise NativeEngineConfigurationError("native source cache is unavailable")
        if chunk_size <= 0 or chunk_size > 8 * 1024 * 1024:
            raise NativeEngineConfigurationError("native asset chunk size is invalid")
        self._assert_cache_safe(self._source_root)
        self._source_root.mkdir(parents=True, exist_ok=True)
        self._assert_cache_safe(self._source_root)
        target = self._source_root / asset_id
        if self._unsafe_path(target):
            raise NativeEngineConfigurationError("native source cache entry is unsafe")
        if target.exists():
            if not target.is_file():
                raise NativeEngineConfigurationError("native source cache entry is unsafe")
            digest = hashlib.sha256()
            with target.open("rb") as existing:
                for block in iter(lambda: existing.read(chunk_size), b""):
                    digest.update(block)
            if digest.hexdigest() == asset_id:
                self._staged_assets.add(asset_id)
                return
            target.unlink()
        temporary = self._source_root / f".{asset_id}.{secrets.token_hex(8)}.tmp"
        digest = hashlib.sha256()
        try:
            with temporary.open("xb") as output:
                while True:
                    block = stream.read(chunk_size)
                    if not block:
                        break
                    if not isinstance(block, (bytes, bytearray, memoryview)) or len(block) > chunk_size:
                        raise NativeEngineConfigurationError("native asset stream exceeded its chunk bound")
                    digest.update(block)
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            if digest.hexdigest() != asset_id:
                raise NativeEngineConfigurationError("native asset hash verification failed")
            os.replace(temporary, target)
            try:
                directory_fd = os.open(self._source_root, os.O_RDONLY)
                os.fsync(directory_fd)
                os.close(directory_fd)
            except OSError:
                pass
            self._staged_assets.add(asset_id)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _unsafe_path(path: Path) -> bool:
        try:
            info = os.lstat(path)
            return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & 0x400)
        except FileNotFoundError:
            return False
        except OSError:
            return True

    @classmethod
    def _assert_cache_safe(cls, path: Path) -> None:
        current = Path(path.anchor)
        for component in path.parts[1:]:
            current /= component
            if cls._unsafe_path(current):
                raise NativeEngineConfigurationError("native cache path contains a link or reparse point")

    def _hydrate_native(self) -> dict[str, Any] | None:
        if self._project_payload is None or self.engine.state is not NativeEngineState.READY:
            return None
        try:
            result = self._transfer_hydration(self._project_payload, validate_only=False)
        except NativeEngineResponseError as error:
            # Stage 6 binaries may predate hydration.  They remain usable for
            # the compatibility path; the project is still retained as the
            # durable authority and will hydrate after a native restart.
            if error.code == "unknown_method":
                return None
            raise
        self._ingest_native_result(result)
        return result

    @staticmethod
    def _hydration_pages(documents: Sequence[Mapping[str, Any]], *, limit: int = 48 * 1024) -> list[list[Mapping[str, Any]]]:
        pages: list[list[Mapping[str, Any]]] = []
        page: list[Mapping[str, Any]] = []
        for document in documents:
            candidate = [*page, document]
            size = len(json.dumps(candidate, ensure_ascii=False, allow_nan=False,
                                  separators=(",", ":"), sort_keys=True).encode("utf-8"))
            if size > limit and page:
                pages.append(page)
                page = [document]
            elif size > limit:
                raise NativeEngineFrameTooLargeError("native hydration document exceeds the bounded frame limit")
            else:
                page = candidate
        if page:
            pages.append(page)
        return pages

    def _transfer_hydration(self, payload: Mapping[str, Any], *, validate_only: bool) -> dict[str, Any]:
        begin = {
            "projectId": payload["projectId"],
            "projectRevision": payload["projectRevision"],
            "validateOnly": validate_only,
        }
        try:
            started = self.engine.call("world.beginHydration", begin)
        except NativeEngineResponseError as error:
            if error.code == "unknown_method":
                method = "world.validateHydration" if validate_only else "world.hydrate"
                return self.engine.call(method, payload)
            raise
        if started.get("hydrationTransaction") is not True:
            method = "world.validateHydration" if validate_only else "world.hydrate"
            return self.engine.call(method, payload)
        try:
            domains = payload.get("domains", {})
            if not isinstance(domains, Mapping):
                raise NativeEngineConfigurationError("project domains are invalid")
            for domain in sorted(domains):
                value = domains[domain]
                if not isinstance(value, Mapping) or value.get("schemaVersion") != 1:
                    raise NativeEngineConfigurationError("project domain schema is invalid")
                documents = value.get("documents")
                if not isinstance(documents, list) or not all(isinstance(item, Mapping) for item in documents):
                    raise NativeEngineConfigurationError("project domain documents are invalid")
                pages = self._hydration_pages(documents) or [[]]
                for page in pages:
                    self.engine.call("world.appendHydration", {
                        "domain": domain, "schemaVersion": 1,
                        "documents": page,
                    })
            asset_ids = payload.get("assetIds", [])
            if not isinstance(asset_ids, list):
                raise NativeEngineConfigurationError("project asset identities are invalid")
            for offset in range(0, len(asset_ids), 256):
                self.engine.call("world.appendHydration", {
                    "assetIds": asset_ids[offset:offset + 256],
                })
            return self.engine.call("world.commitHydration")
        except BaseException:
            try:
                self.engine.call("world.abortHydration")
            except NativeEngineError:
                pass
            raise

    @staticmethod
    def _normalized_hash(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        normalized = value[2:] if value.startswith("0x") else value
        if not 16 <= len(normalized) <= 64 or any(char not in "0123456789abcdef" for char in normalized):
            return None
        return normalized

    def _ingest_native_result(self, value: Mapping[str, Any]) -> None:
        """Retain only schema-shaped native status fields for canonical output."""
        if not isinstance(value, Mapping):
            return
        revision = value.get("worldRevision", value.get("revision"))
        if isinstance(revision, int) and not isinstance(revision, bool) and revision >= 0:
            self._world_revision = revision
        for key in ("tick", "projectRevision"):
            item = value.get(key)
            if isinstance(item, int) and not isinstance(item, bool) and item >= 0:
                self._native_fields[key] = item
        if "projectId" in value:
            project_id = value.get("projectId")
            if project_id is None or (isinstance(project_id, str) and 0 < len(project_id) <= 128):
                self._native_fields["projectId"] = project_id
        for key in ("worldHash", "replayHash", "extractionHash"):
            normalized = self._normalized_hash(value.get(key))
            if normalized is not None:
                self._native_fields[key] = normalized
        capabilities = value.get("featureCapabilities")
        if isinstance(capabilities, list) and len(capabilities) == len(_ENGINE_FEATURES):
            normalized_capabilities: list[dict[str, Any]] = []
            for expected, item in zip(_ENGINE_FEATURES, capabilities, strict=True):
                if not isinstance(item, Mapping) or item.get("feature") != expected or not isinstance(item.get("supported"), bool):
                    break
                reason = item.get("fallbackReason", item.get("fallback_reason"))
                if reason is not None and not isinstance(reason, str):
                    break
                if item["supported"]:
                    reason = None
                normalized_capabilities.append({
                    "feature": expected,
                    "supported": item["supported"],
                    "fallbackReason": reason[:256] if isinstance(reason, str) else None,
                })
            if len(normalized_capabilities) == len(_ENGINE_FEATURES):
                self._native_fields["featureCapabilities"] = normalized_capabilities
        if isinstance(value.get("backend"), str) and 0 < len(value["backend"]) <= 64:
            self._backend = value["backend"]
        if isinstance(value.get("adapter"), str) and 0 < len(value["adapter"]) <= 256:
            self._adapter = value["adapter"]
        if value.get("device_type") in {"Cpu", "IntegratedGpu", "DiscreteGpu", "VirtualGpu", "Other"}:
            self._device_type = value["device_type"]
        if "fallback" in value and isinstance(value.get("fallback"), str):
            self._fallback_reason = value["fallback"][:256]
        if "fallbackReason" in value and (isinstance(value.get("fallbackReason"), str) or value.get("fallbackReason") is None):
            fallback = value.get("fallbackReason")
            self._fallback_reason = fallback[:256] if isinstance(fallback, str) else None
        if value.get("dockSupport") in {"unsupported", "same-build"}:
            self._dock_support = value["dockSupport"]
        if "dockActive" in value and isinstance(value.get("dockActive"), bool):
            self._dock_active = value["dockActive"]
        if "dockReason" in value and (isinstance(value.get("dockReason"), str) or value.get("dockReason") is None):
            reason = value.get("dockReason")
            self._dock_reason = reason[:256] if isinstance(reason, str) else None
        if value.get("referenceScene") == "basic":
            self._native_fields["referenceScene"] = "basic"
        if value.get("referenceVersion") == 1:
            self._native_fields["referenceVersion"] = 1

    def validate_project(self, project_id: str, project_revision: int, domains: Mapping[str, Any]) -> None:
        """Validate a candidate project against native rules without mutation."""
        payload = {"projectId": project_id, "projectRevision": project_revision, "domains": dict(domains)}
        _validate_json_data(payload)
        if self.engine.state is not NativeEngineState.READY:
            return
        try:
            self._transfer_hydration(payload, validate_only=True)
        except NativeEngineResponseError as error:
            if error.code != "unknown_method":
                raise

    def hydrate_project(self, project_id: str, project_revision: int,
                        domains: Mapping[str, Any], *, asset_ids: Sequence[str] = ()) -> dict[str, Any] | None:
        if not isinstance(project_id, str) or not project_id:
            raise NativeEngineConfigurationError("project identity is invalid")
        if not isinstance(project_revision, int) or isinstance(project_revision, bool) or project_revision < 0:
            raise NativeEngineConfigurationError("project revision is invalid")
        payload = {"projectId": project_id, "projectRevision": project_revision,
                   "domains": dict(domains), "assetIds": sorted(set(asset_ids))}
        _validate_json_data(payload)
        self._project_id = project_id
        self._project_revision = project_revision
        self._project_payload = payload
        return self._hydrate_native()

    def close_project(self, project_id: str | None = None) -> None:
        if project_id is not None and self._project_id not in {None, project_id}:
            return
        try:
            if self.engine.state is NativeEngineState.READY:
                try:
                    self.engine.call("world.closeProject")
                except NativeEngineResponseError as error:
                    if error.code != "unknown_method":
                        raise
        finally:
            self._project_id = None
            self._project_revision = 0
            self._project_payload = None
            self._world_revision = 0
            for key in ("tick", "projectId", "projectRevision", "worldHash",
                        "replayHash", "extractionHash", "referenceScene",
                        "referenceVersion"):
                self._native_fields.pop(key, None)

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
            "dockSupport": self._dock_support,
            "dockActive": self._dock_active,
            "dockReason": self._dock_reason,
        }
        if "projectId" in self._native_fields:
            result["projectId"] = self._native_fields["projectId"]
            if self._native_fields["projectId"] is not None and "projectRevision" in self._native_fields:
                result["projectRevision"] = self._native_fields["projectRevision"]
        elif self._project_id is not None:
            result["projectId"] = self._project_id
            result["projectRevision"] = self._project_revision
        if self._backend is not None:
            result["backend"] = self._backend
        if self._adapter is not None:
            result["adapter"] = self._adapter
        if self._device_type is not None:
            result["deviceType"] = self._device_type
        if self._fallback_reason is not None:
            result["fallbackReason"] = self._fallback_reason
        if self._metrics is not None:
            result["metrics"] = dict(self._metrics)
        for key in ("tick", "worldHash", "replayHash", "extractionHash", "featureCapabilities",
                    "referenceScene", "referenceVersion"):
            value = getattr(self, "_native_fields", {}).get(key)
            if value is not None:
                result[key] = value
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

    def restore_events(self, events: Sequence[tuple[str, dict[str, Any]]]) -> None:
        self._events[0:0] = list(events)

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
        self._ingest_native_result(capabilities)
        return capabilities

    @staticmethod
    def _host_entities(value: Any) -> list[dict[str, Any]]:
        """Project the private native DTO onto the strict public entity shape."""
        if not isinstance(value, list) or len(value) > 1024:
            raise NativeEngineProtocolError("native entity snapshot is invalid")
        result: list[dict[str, Any]] = []
        for item in value:
            if not isinstance(item, Mapping):
                raise NativeEngineProtocolError("native entity snapshot is invalid")
            entity_id, position, color = item.get("id"), item.get("position"), item.get("color")
            if (not isinstance(entity_id, str) or not entity_id
                    or not isinstance(position, list) or len(position) != 3
                    or not isinstance(color, list) or len(color) != 4):
                raise NativeEngineProtocolError("native entity snapshot is invalid")
            result.append({"id": entity_id, "position": list(position), "color": list(color)})
        return result

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
                snapshot_reader = getattr(self.engine, "snapshot_world", None)
                snapshot = snapshot_reader() if callable(snapshot_reader) else self.engine.call("world.getSnapshot")
                self._ingest_native_result(snapshot)
                result = self._canonical("engine.snapshot", values={"entities": self._host_entities(snapshot.get("entities", []))})
            elif method == "engine.applyChanges":
                if self._project_id is not None:
                    raise HostOperationError(
                        "unsupported_capability",
                        "Project world mutations must use project.applyChanges",
                    )
                expected = payload.get("expectedRevision")
                entities = payload.get("entities")
                if not isinstance(expected, int) or isinstance(expected, bool) or not isinstance(entities, list):
                    raise HostOperationError("invalid_request", "expectedRevision and entities are required")
                applied = self.engine.call("world.apply", {"expectedRevision": expected, "entities": entities})
                self._ingest_native_result(applied)
                if "revision" not in applied and "worldRevision" not in applied:
                    self._world_revision += 1
                result = self._canonical("engine.applyChanges", values={"entities": self._host_entities(applied.get("entities", entities))})
                self._event("engine.revision", {"worldRevision": self._world_revision})
            elif method == "engine.openViewport":
                width, height = payload.get("width", 1280), payload.get("height", 720)
                title = payload.get("title", "Auvra Native Viewport")
                if not isinstance(width, int) or isinstance(width, bool) or not isinstance(height, int) or isinstance(height, bool) or not isinstance(title, str):
                    raise HostOperationError("invalid_request", "viewport dimensions and title are invalid")
                if self._viewport == "open":
                    result = self._canonical("engine.openViewport")
                    self._event("engine.status", {key: value for key, value in result.items()
                                                   if key in {"status", "worldRevision", "viewport", "backend", "adapter", "fallbackReason"}})
                    return result
                request = {"width": width, "height": height, "title": title}
                self._dock_active = False
                self._dock_reason = None
                target = self._dock_target_provider() if self._dock_target_provider is not None else None
                if self._dock_support == "same-build" and isinstance(target, Mapping):
                    handle = target.get("parentHandle")
                    target_width, target_height = target.get("width"), target.get("height")
                    if (isinstance(handle, int) and not isinstance(handle, bool) and handle > 0
                            and isinstance(target_width, int) and target_width > 0
                            and isinstance(target_height, int) and target_height > 0):
                        request["parentHandle"] = handle
                        request["width"] = target_width
                        request["height"] = target_height
                    else:
                        self._dock_reason = "same-build dock target is unavailable"
                elif self._dock_support != "same-build":
                    self._dock_reason = "native dock target is unsupported"
                opened = self.engine.call("viewport.open", request)
                if not isinstance(opened, dict):
                    raise NativeEngineProtocolError("native viewport result must be an object")
                self._ingest_native_result(opened)
                if not self._dock_active and self._dock_reason is None:
                    self._dock_reason = "native viewport opened as a separate window"
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
                rendered = self.engine.call("renderer.renderReference", {
                    "sceneId": "basic", "width": width, "height": height,
                })
                self._ingest_native_result(rendered)
                self._capabilities()
                raw_metrics = self.engine.call("renderer.getMetrics")
                self._metrics = {
                    "startupMs": raw_metrics.get("startup_ms", 0),
                    "frameCpuMs": raw_metrics.get("last_frame_submit_ms"),
                    "gpuFrameMs": raw_metrics.get("gpu_frame_ms"),
                    "memoryBytes": raw_metrics.get("memory_bytes", 0),
                    "recoveryCount": self._recovery_count,
                }
                values: dict[str, Any] = {
                    "width": rendered.get("width", width),
                    "height": rendered.get("height", height),
                    "referenceScene": "basic",
                    "referenceVersion": 1,
                }
                if isinstance(rendered.get("pixel_hash_fnv1a64"), str):
                    signature = rendered["pixel_hash_fnv1a64"]
                    normalized_signature = signature[2:] if signature.startswith("0x") else signature
                    if 16 <= len(normalized_signature) <= 64 and all(char in "0123456789abcdef" for char in normalized_signature):
                        values["signature"] = normalized_signature
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
                had_viewport = self._viewport == "open"
                try:
                    recovered = self.engine.call("renderer.recover")
                except (NativeEngineTimeoutError, NativeEngineChildExitedError,
                        NativeEngineProtocolError, NativeEngineClosedError):
                    self.restart(editor_session=self._editor_session)
                    self._viewport = "closed"
                    self._dock_active = False
                    self._dock_reason = "native viewport must be reopened after process recovery"
                    recovered = {"capabilities": self._capabilities()}
                self._ingest_native_result(recovered)
                viewport_reopened = recovered.get("viewport_reopened")
                if isinstance(viewport_reopened, bool):
                    self._viewport = "open" if viewport_reopened else "closed"
                    if had_viewport and not viewport_reopened:
                        self._dock_active = False
                        self._dock_reason = "native viewport was unavailable after renderer recovery"
                self._recovery_count += 1
                if self._metrics is not None:
                    self._metrics["recoveryCount"] = self._recovery_count
                caps = recovered.get("capabilities")
                if isinstance(caps, dict):
                    self._ingest_native_result(caps)
                result = self._canonical("engine.recover")
                self._event("engine.recovery", {
                    "worldRevision": self._world_revision,
                    "metrics": self._metrics or {
                        "startupMs": 0, "frameCpuMs": None, "gpuFrameMs": None,
                        "memoryBytes": 0, "recoveryCount": self._recovery_count,
                    },
                })
            self._event("engine.status", {key: value for key, value in result.items()
                                           if key in {"status", "worldRevision", "viewport", "backend", "adapter", "deviceType", "fallbackReason"}})
            return result
        except HostOperationError:
            raise
        except NativeEngineError as error:
            raise self._translate_error(error) from error


@trace_public_class("native_engine_host", concise=("start", "restart", "handle"))
class NativeEngineUnavailableHost:
    """Declared web fallback when the development native binary is unavailable."""

    def __init__(self, reason: str = "Native engine executable is unavailable") -> None:
        self.reason = reason[:256]

    def start(self, *, editor_session: str = "editor") -> None:
        return None

    def restart(self, *, editor_session: str = "editor") -> None:
        return None

    def close(self, *, timeout: float | None = None) -> None:
        return None

    def validate_project(self, project_id: str, project_revision: int, domains: Mapping[str, Any]) -> None:
        return None

    def hydrate_project(self, project_id: str, project_revision: int,
                        domains: Mapping[str, Any], *, asset_ids: Sequence[str] = ()) -> None:
        return None

    def close_project(self, project_id: str | None = None) -> None:
        return None

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
