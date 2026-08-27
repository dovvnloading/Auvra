"""Separate bounded ``auvra.provider/1`` framing contract."""

from __future__ import annotations

import json
import re
import struct
from typing import Any, BinaryIO, Mapping


MAX_FRAME_BYTES = 64 * 1024
PROTOCOL = "auvra.provider/1"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_METHOD = re.compile(r"^[a-z][a-z0-9]*(?:\.[A-Za-z0-9_-]+){1,7}$")
_AUTHORITY_KEYS = {"path", "filepath", "filesystempath", "directorypath", "credential", "credentials",
                   "secret", "token", "apikey", "authorization", "cookie", "password", "privatekey"}
_WINDOWS_PATH = re.compile(r"(?i)^(?:[a-z]:[\\/]|\\\\|file:)")


class ProviderProtocolError(ValueError):
    pass


def _safe(value: Any, depth: int = 0) -> None:
    if depth > 32:
        raise ProviderProtocolError("provider message is too deep")
    if isinstance(value, (bytes, bytearray, memoryview)):
        raise ProviderProtocolError("provider messages cannot contain binary values")
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", key.casefold()) if isinstance(key, str) else ""
            if not isinstance(key, str) or normalized in _AUTHORITY_KEYS:
                raise ProviderProtocolError("provider message contains forbidden authority")
            _safe(child, depth + 1)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _safe(child, depth + 1)
    elif isinstance(value, str) and (_WINDOWS_PATH.match(value) or value.startswith("/")):
        raise ProviderProtocolError("provider message contains a filesystem path")


def validate_payload(value: Any) -> None:
    """Reject authority-bearing values before the broker sees a request."""
    _safe(value)


def _validate_envelope(value: Mapping[str, Any]) -> None:
    if value.get("protocol") != PROTOCOL or not isinstance(value.get("id"), str) or not _IDENTIFIER.fullmatch(value["id"]):
        raise ProviderProtocolError("provider frame envelope is invalid")
    keys = set(value)
    if "method" in value:
        if keys != {"protocol", "id", "method", "payload"} or not isinstance(value["method"], str) \
                or not _METHOD.fullmatch(value["method"]) or not isinstance(value["payload"], dict):
            raise ProviderProtocolError("provider request envelope is invalid")
    else:
        if not isinstance(value.get("ok"), bool):
            raise ProviderProtocolError("provider response envelope is invalid")
        expected = {"protocol", "id", "ok", "result" if value["ok"] else "error"}
        payload_key = "result" if value["ok"] else "error"
        if keys != expected or not isinstance(value.get(payload_key), dict):
            raise ProviderProtocolError("provider response envelope is invalid")


def encode(value: Mapping[str, Any]) -> bytes:
    if not isinstance(value, Mapping):
        raise ProviderProtocolError("provider frame must be an object")
    _validate_envelope(value)
    validate_payload(value)
    try:
        body = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ProviderProtocolError("provider frame is not JSON") from exc
    if len(body) > MAX_FRAME_BYTES:
        raise ProviderProtocolError("provider frame exceeds 64 KiB")
    return struct.pack(">I", len(body)) + body


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        block = stream.read(remaining)
        if not block:
            break
        chunks.append(block)
        remaining -= len(block)
    return b"".join(chunks)


def read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    header = _read_exact(stream, 4)
    if not header:
        return None
    if len(header) != 4:
        raise ProviderProtocolError("provider frame header is incomplete")
    size = struct.unpack(">I", header)[0]
    if size < 2 or size > MAX_FRAME_BYTES:
        raise ProviderProtocolError("provider frame exceeds 64 KiB")
    body = _read_exact(stream, size)
    if len(body) != size:
        raise ProviderProtocolError("provider frame body is incomplete")
    try:
        value = json.loads(body.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ProviderProtocolError("provider frame is invalid JSON") from exc
    if not isinstance(value, dict):
        raise ProviderProtocolError("provider frame must be an object")
    validate_payload(value)
    _validate_envelope(value)
    return value


def write_frame(stream: BinaryIO, value: Mapping[str, Any]) -> None:
    stream.write(encode(value))
    stream.flush()
