"""Stable, redacted provider error types."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import re
from typing import Any


# Provider responses and exception text are untrusted.  Keep the public error
# surface deliberately boring when a lower layer accidentally includes a
# credential, URL, or request payload in its message.
_SENSITIVE_TEXT = re.compile(
    r"(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|credential|"
    r"password|passwd|secret|token|https?://|file://|[A-Za-z]:\\)",
    re.IGNORECASE,
)


def _safe_error_message(value: str) -> str:
    if _SENSITIVE_TEXT.search(value):
        return "provider request failed"
    return value


class ErrorCode(StrEnum):
    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    AUTHENTICATION = "authentication"
    AUTHORIZATION = "authorization"
    RATE_LIMITED = "rate_limited"
    TIMEOUT = "timeout"
    NETWORK = "network"
    REMOTE = "remote"
    NOT_FOUND = "not_found"
    CANCELLED = "cancelled"
    BUDGET_EXCEEDED = "budget_exceeded"
    ENDPOINT_NOT_ALLOWED = "endpoint_not_allowed"
    CREDENTIAL_UNAVAILABLE = "credential_unavailable"
    CONFLICT = "conflict"
    INTERNAL = "internal"


@dataclass(frozen=True, slots=True)
class ProviderError(Exception):
    """A user-safe error; detail must never contain request data or secrets."""

    code: ErrorCode
    message: str
    provider: str | None = None
    retryable: bool = False
    status: int | None = None
    retry_after: float | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.message, str):
            raise ValueError("provider error message must be text")
        object.__setattr__(self, "message", _safe_error_message(self.message))
        Exception.__init__(self, self.message)
        if not self.message or len(self.message) > 512:
            raise ValueError("provider error message must be 1..512 characters")
        if self.status is not None and not 100 <= self.status <= 599:
            raise ValueError("invalid HTTP status")

    def __str__(self) -> str:
        prefix = f"{self.provider}: " if self.provider else ""
        return f"{prefix}{self.message}"

    def __repr__(self) -> str:
        # Dataclass' generated repr would make a secret-bearing message easy
        # to leak into logs, tracebacks, or SQLite diagnostics.
        return (f"ProviderError(code={self.code!r}, provider={self.provider!r}, "
                f"retryable={self.retryable!r}, status={self.status!r})")

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code.value, "message": self.message,
                "provider": self.provider, "retryable": self.retryable,
                "status": self.status, "retry_after": self.retry_after}


def normalize_error(error: BaseException, *, provider: str | None = None) -> ProviderError:
    if isinstance(error, ProviderError):
        return error
    if isinstance(error, TimeoutError):
        return ProviderError(ErrorCode.TIMEOUT, "provider request timed out", provider, True)
    if isinstance(error, (ConnectionError, OSError)):
        return ProviderError(ErrorCode.NETWORK, "provider network request failed", provider, True)
    if isinstance(error, ValueError):
        return ProviderError(ErrorCode.INVALID_REQUEST, "provider response was invalid", provider, False)
    return ProviderError(ErrorCode.INTERNAL, "provider request failed", provider, False)


def from_http_status(status: int, *, provider: str, message: str = "provider request failed",
                    retry_after: float | None = None) -> ProviderError:
    if status in (401, 403):
        code, retryable = (ErrorCode.AUTHENTICATION if status == 401 else ErrorCode.AUTHORIZATION), False
    elif status == 404:
        code, retryable = ErrorCode.NOT_FOUND, False
    elif status == 408:
        code, retryable = ErrorCode.TIMEOUT, True
    elif status == 429:
        code, retryable = ErrorCode.RATE_LIMITED, True
    elif 500 <= status <= 599:
        code, retryable = ErrorCode.REMOTE, True
    else:
        code, retryable = ErrorCode.REMOTE, False
    return ProviderError(code, message[:512], provider, retryable, status, retry_after)
