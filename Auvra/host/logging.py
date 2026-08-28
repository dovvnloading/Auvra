"""Compatibility facade over Auvra's unified runtime diagnostics."""

from __future__ import annotations

from collections.abc import Mapping
import json
from typing import Any, Callable

from Auvra.diagnostics.core import (
    EVENT_CATALOG,
    RECORD_MAX_BYTES,
    REDACTED,
    TRUNCATED,
    DiagnosticRing,
    active_diagnostics,
    process_ring,
    redact,
)


DIAGNOSTIC_RECORD_MAX_BYTES = RECORD_MAX_BYTES


def process_diagnostics() -> DiagnosticRing:
    """Return the active session ring, or the bounded pre-session fallback."""

    return process_ring()


class StructuredLogger:
    """Preserve the Stage 2 API while routing catalogued events to one session."""

    def __init__(self, sink: Callable[[str], None] | None = None, *, max_bytes: int = 8192,
                 ring: DiagnosticRing | None = None) -> None:
        self._sink = sink
        self.max_bytes = max(256, min(max_bytes, RECORD_MAX_BYTES))
        self.ring = ring if ring is not None else process_diagnostics()

    def emit(self, level: str, event: str, fields: Mapping[str, Any] | None = None) -> dict[str, Any]:
        session = active_diagnostics()
        spec = EVENT_CATALOG.get(event)
        if session is not None and spec is not None:
            record = session.emit(spec.component, event, level=level, attributes=fields)
        elif session is not None:
            record = session.emit("diagnostics", event, level=level, attributes=fields)
        else:
            record = redact({"level": level, "event": event, "fields": dict(fields or {})})
            if not isinstance(record, dict):
                record = {"level": "warning", "event": "diagnostics.record_rejected"}
            encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > self.max_bytes:
                record = {"level": "warning", "event": "diagnostics.record_rejected",
                          "fields": {"code": "record_too_large"}}
            self.ring.append(record)
        encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
        if self._sink:
            self._sink(encoded)
        return record

    def snapshot(self) -> list[dict[str, Any]]:
        return self.ring.snapshot()

    def clear(self) -> None:
        self.ring.clear()


__all__ = [
    "DIAGNOSTIC_RECORD_MAX_BYTES",
    "DiagnosticRing",
    "REDACTED",
    "StructuredLogger",
    "TRUNCATED",
    "process_diagnostics",
    "redact",
]
