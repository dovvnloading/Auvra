"""Small structured logger with recursive bounded secret redaction."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, Callable

_SECRET_KEY = re.compile(r"(?:pass(?:word)?|secret|token|api[_-]?key|anon[_-]?key|access[_-]?key|fal[_-]?key|authorization|credential|bearer|cookie|private[_-]?key)", re.I)
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.I)
_KEY_VALUE = re.compile(r"\b(?:sk|key|token|secret|fal[_-]?key)[_-]?[A-Za-z0-9]{8,}\b", re.I)
REDACTED = "[REDACTED]"
TRUNCATED = "[TRUNCATED]"
DIAGNOSTIC_RECORD_MAX_BYTES = 8 * 1024


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


class DiagnosticRing:
    """Bounded in-memory diagnostics retained only for explicit support export."""

    def __init__(self, *, max_records: int = 256, max_bytes: int = 256 * 1024) -> None:
        if not isinstance(max_records, int) or max_records < 1:
            raise ValueError("diagnostic record bound must be positive")
        if not isinstance(max_bytes, int) or max_bytes < 256:
            raise ValueError("diagnostic byte bound is too small")
        self.max_records = max_records
        self.max_bytes = max_bytes
        self._records: list[dict[str, Any]] = []
        self._bytes = 0

    def append(self, record: Mapping[str, Any]) -> None:
        safe = redact(dict(record), max_depth=6, max_items=64, max_string=512)
        if not isinstance(safe, dict):
            safe = {"level": "warning", "event": "diagnostic.invalid"}
        encoded = json.dumps(safe, ensure_ascii=True, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > min(self.max_bytes, DIAGNOSTIC_RECORD_MAX_BYTES):
            safe = {"level": "warning", "event": "diagnostic.truncated", "fields": {"truncated": True}}
            encoded = json.dumps(safe, ensure_ascii=True, separators=(",", ":"))
        size = len(encoded.encode("utf-8"))
        self._records.append(safe)
        self._bytes += size
        while len(self._records) > self.max_records or self._bytes > self.max_bytes:
            removed = self._records.pop(0)
            self._bytes -= len(json.dumps(removed, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))

    def snapshot(self) -> list[dict[str, Any]]:
        return [dict(record) for record in self._records]

    def clear(self) -> None:
        self._records.clear()
        self._bytes = 0

    def __len__(self) -> int:
        return len(self._records)


_PROCESS_DIAGNOSTICS = DiagnosticRing()


def process_diagnostics() -> DiagnosticRing:
    """Return the bounded process-local ring shared by host components."""

    return _PROCESS_DIAGNOSTICS


class StructuredLogger:
    def __init__(self, sink: Callable[[str], None] | None = None, *, max_bytes: int = 8192,
                 ring: DiagnosticRing | None = None) -> None:
        self._sink = sink
        self.max_bytes = max(256, max_bytes)
        self.ring = ring if ring is not None else process_diagnostics()

    def emit(self, level: str, event: str, fields: Mapping[str, Any] | None = None) -> dict[str, Any]:
        record = redact({"level": level, "event": event, "fields": dict(fields or {})})
        encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > self.max_bytes:
            record = {"level": "warning", "event": "log.truncated", "fields": {"truncated": True}}
            encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
        self.ring.append(record)
        if self._sink:
            self._sink(encoded)
        return record

    def snapshot(self) -> list[dict[str, Any]]:
        return self.ring.snapshot()

    def clear(self) -> None:
        self.ring.clear()
