"""Local, bounded, high-signal runtime diagnostics."""

from .core import (
    DIAGNOSTIC_SCHEMA,
    REDACTED,
    DiagnosticActivity,
    DiagnosticRing,
    DiagnosticsSession,
    active_diagnostics,
    bind_diagnostic_context,
    current_diagnostic_context,
    follow_records,
    install_diagnostics,
    inspect_records,
    latest_run_summary,
    redact,
    safe_diagnostics_root,
)
from .webview import DiagnosticWebViewLane, WEBVIEW_DIAGNOSTIC_PROTOCOL

__all__ = [
    "DIAGNOSTIC_SCHEMA",
    "REDACTED",
    "DiagnosticActivity",
    "DiagnosticRing",
    "DiagnosticsSession",
    "active_diagnostics",
    "bind_diagnostic_context",
    "current_diagnostic_context",
    "follow_records",
    "install_diagnostics",
    "inspect_records",
    "latest_run_summary",
    "redact",
    "safe_diagnostics_root",
    "DiagnosticWebViewLane",
    "WEBVIEW_DIAGNOSTIC_PROTOCOL",
]
