"""Small structured logger with recursive bounded secret redaction."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, Callable

_SECRET_KEY = re.compile(r"(?:pass(?:word)?|secret|token|api[_-]?key|authorization|credential|bearer|cookie|private[_-]?key)", re.I)
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.I)
_KEY_VALUE = re.compile(r"\b(?:sk|key|token|secret)[_-]?[A-Za-z0-9]{8,}\b", re.I)
REDACTED = "[REDACTED]"
TRUNCATED = "[TRUNCATED]"


def _redact_text(value: str, max_string: int) -> str:
    result = _BEARER.sub(REDACTED, value)
    result = _KEY_VALUE.sub(REDACTED, result)
    return result if len(result) <= max_string else result[:max_string] + TRUNCATED


def redact(value: Any, *, max_depth: int = 6, max_items: int = 64, max_string: int = 512) -> Any:
    """Return a bounded copy safe for diagnostic output."""
    if max_depth < 0:
        return TRUNCATED
    if isinstance(value, str):
        return _redact_text(value, max_string)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= max_items:
                result[TRUNCATED] = TRUNCATED
                break
            key_text = _redact_text(str(key), max_string)
            result[key_text] = REDACTED if _SECRET_KEY.search(str(key)) else redact(
                item, max_depth=max_depth - 1, max_items=max_items, max_string=max_string
            )
        return result
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return [redact(item, max_depth=max_depth - 1, max_items=max_items, max_string=max_string)
                for item in list(value)[:max_items]] + ([TRUNCATED] if len(value) > max_items else [])
    return _redact_text(str(value), max_string)


class StructuredLogger:
    def __init__(self, sink: Callable[[str], None] | None = None, *, max_bytes: int = 8192) -> None:
        self._sink = sink
        self.max_bytes = max(256, max_bytes)

    def emit(self, level: str, event: str, fields: Mapping[str, Any] | None = None) -> dict[str, Any]:
        record = redact({"level": level, "event": event, "fields": dict(fields or {})})
        encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > self.max_bytes:
            record = {"level": "warning", "event": "log.truncated", "fields": {"truncated": True}}
            encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
        if self._sink:
            self._sink(encoded)
        return record
