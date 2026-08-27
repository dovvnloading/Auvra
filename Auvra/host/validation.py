"""Canonical protocol validation shared by host components."""

from __future__ import annotations

import json
from functools import lru_cache
import math
from pathlib import Path
import re
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


SCHEMA_PATH = Path(__file__).resolve().parents[2] / "protocol" / "v1" / "auvra-host.schema.json"


class ProtocolValidationError(ValueError):
    """A message is not a valid protocol v1 message."""


_FORBIDDEN_JSON_KEY = re.compile(
    r"^(?:path|filepath|filesystempath|sourcepath|assetpath|directorypath|absolutepath|localpath|base64|binary|bytes|blob|credential|credentials|secret|token|api[_-]?key|password|authorization|auth[_-]?header)$",
    re.I,
)
_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
_UNC_PATH = re.compile(r"^\\\\")
_FILE_URI = re.compile(r"^file://", re.I)
MAX_MESSAGE_BYTES = 256 * 1024


def _check_json_safe(value: Any, *, depth: int = 0) -> None:
    """Reject non-JSON values, non-finite numbers, and authority leaks."""
    if depth > 32:
        raise ProtocolValidationError("message nesting is too deep")
    if isinstance(value, str):
        if _WINDOWS_DRIVE.match(value) or _UNC_PATH.match(value) or _FILE_URI.match(value) or value.startswith("/"):
            raise ProtocolValidationError("filesystem paths are not allowed")
        return
    if value is None or isinstance(value, (bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ProtocolValidationError("message contains a non-finite number")
        return
    if isinstance(value, (bytes, bytearray, memoryview)):
        raise ProtocolValidationError("binary payloads are not allowed")
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or _FORBIDDEN_JSON_KEY.search(key):
                raise ProtocolValidationError("filesystem and binary fields are not allowed")
            _check_json_safe(item, depth=depth + 1)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _check_json_safe(item, depth=depth + 1)
        return
    raise ProtocolValidationError("message contains a non-JSON value")


def _check_encoded_size(message: dict[str, Any]) -> None:
    try:
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ProtocolValidationError("message is not JSON encodable") from exc
    if len(encoded) > MAX_MESSAGE_BYTES:
        raise ProtocolValidationError("message exceeds the protocol size limit")


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    with SCHEMA_PATH.open(encoding="utf-8") as stream:
        schema = json.load(stream)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def validate_message(message: Any) -> dict[str, Any]:
    """Validate and return a message, never coercing or accepting extensions."""
    if not isinstance(message, dict):
        raise ProtocolValidationError("message must be an object")
    _check_encoded_size(message)
    _check_json_safe(message)
    errors = sorted(_validator().iter_errors(message), key=lambda error: list(error.path))
    if errors:
        raise ProtocolValidationError("invalid protocol message")
    _check_encoded_size(message)
    return message


def validate_request(message: Any) -> dict[str, Any]:
    value = validate_message(message)
    if value.get("type") != "request":
        raise ProtocolValidationError("message is not a request")
    return value


def validate_response(message: Any) -> dict[str, Any]:
    value = validate_message(message)
    if value.get("type") != "response":
        raise ProtocolValidationError("message is not a response")
    return value
