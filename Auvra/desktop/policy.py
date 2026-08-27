"""Pure URL and WebView2 event policy.

This module has no native imports and is the security boundary used by the
adapter as well as by its unit-test fakes.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import ipaddress
import re
from urllib.parse import SplitResult, urlsplit

from .contracts import FrameMode


class PolicyAction(str, Enum):
    NAVIGATION = "navigation"
    FRAME_NAVIGATION = "frame_navigation"
    RESOURCE = "resource"
    MESSAGE = "message"


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    allowed: bool
    reason: str
    action: PolicyAction | None = None

    @property
    def cancel(self) -> bool:
        return not self.allowed


_HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$", re.I)
_CONTROL_RE = re.compile(r"[\x00-\x20\x7f]")


def _parts(value: str) -> SplitResult:
    if not isinstance(value, str) or not value or _CONTROL_RE.search(value):
        raise ValueError("malformed URL")
    # Backslashes are interpreted as separators by Windows URL consumers.
    if "\\" in value or value.startswith("//"):
        raise ValueError("unsafe URL")
    try:
        result = urlsplit(value)
        if not result.scheme or not result.netloc or result.username is not None or result.password is not None:
            raise ValueError("URL must have an authority and no credentials")
        host = result.hostname
        if host is None or not _HOST_RE.fullmatch(host):
            raise ValueError("invalid host")
        # Accessing .port performs strict validation and rejects non-numeric,
        # out-of-range, and malformed bracketed ports.
        port = result.port
        if port is None:
            port = 443 if result.scheme.lower() == "https" else 80 if result.scheme.lower() == "http" else None
        if result.scheme.lower() in {"http", "https", "ws", "wss"} and port is None:
            raise ValueError("invalid port")
        if result.hostname and ":" in result.hostname:
            # Auvra origins are host names, not arbitrary IPv6 authorities.
            raise ValueError("IPv6 host is not permitted")
        if result.path.startswith("//") or "//" in result.path:
            raise ValueError("ambiguous URL path")
        return result
    except (ValueError, UnicodeError) as exc:
        raise ValueError("malformed URL") from exc


def _canonical_origin(parts: SplitResult) -> str:
    scheme = parts.scheme.lower()
    host = parts.hostname.lower() if parts.hostname else ""
    port = parts.port
    default = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    return f"{scheme}://{host}{'' if port is None or default else f':{port}'}"


def validate_origin(origin: str, *, development: bool) -> str:
    """Validate and return a canonical exact origin, rejecting lookalikes."""
    parts = _parts(origin)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if parts.path not in {"", "/"} or parts.query or parts.fragment:
        raise ValueError("origin cannot include path, query, or fragment")
    if development:
        if scheme != "http" or host not in {"127.0.0.1", "localhost"}:
            raise ValueError("development origin must be explicit loopback HTTP")
        if host == "localhost":
            raise ValueError("localhost is not an explicit loopback origin")
        if not (1024 <= (parts.port or 80) <= 65535):
            raise ValueError("development origin must use a user port")
    else:
        if scheme != "https" or host != "app.auvra.local":
            raise ValueError("packaged origin must be https://app.auvra.local")
        if parts.port not in {None, 443}:
            raise ValueError("packaged origin must use the default HTTPS port")
    return _canonical_origin(parts)


class FramePolicy:
    """Exact allowlist for document navigation, resources, and messages."""

    def __init__(self, mode: FrameMode | str, trusted_origin: str, *, packaged_root: str | None = None) -> None:
        self.mode = mode if isinstance(mode, FrameMode) else FrameMode(mode)
        self.origin = validate_origin(trusted_origin, development=self.mode is FrameMode.DEVELOPMENT)
        self.packaged_root = packaged_root

    def _check(self, url: str, action: PolicyAction, *, top_level: bool = False) -> PolicyDecision:
        if action is PolicyAction.RESOURCE:
            opaque = self._opaque_resource(url)
            if opaque is not None:
                return opaque
        try:
            parts = _parts(url)
        except ValueError:
            return PolicyDecision(False, "malformed-or-local-url", action)
        scheme = parts.scheme.lower()
        canonical = _canonical_origin(parts)
        if self.mode is FrameMode.DEVELOPMENT:
            allowed_scheme = scheme in {"http", "ws"}
            # The document is HTTP; WebSocket is only a resource transport.
            comparable = canonical
            if scheme == "ws":
                comparable = "http://" + canonical[len("ws://"):]
            if comparable != self.origin or not allowed_scheme:
                return PolicyDecision(False, "origin-not-approved", action)
            if top_level and scheme != "http":
                return PolicyDecision(False, "top-level-scheme-not-approved", action)
        else:
            if canonical != self.origin or scheme != "https":
                return PolicyDecision(False, "origin-not-approved", action)
        # Dot segments and percent encoded separators can escape a virtual root
        # or produce origin-confusion in native URL handling.
        if any(segment in {".", ".."} for segment in parts.path.split("/")) or any(token in parts.path.lower() for token in ("%2f", "%5c", "%2e", "%00")):
            return PolicyDecision(False, "unsafe-path", action)
        return PolicyDecision(True, "approved-origin", action)

    def _opaque_resource(self, url: str) -> PolicyDecision | None:
        """Handle browser-local resource URLs without widening navigation."""
        if not isinstance(url, str):
            return PolicyDecision(False, "malformed-or-local-url", PolicyAction.RESOURCE)
        lowered = url.lower()
        if lowered.startswith("data:"):
            # Data resources have no network authority and are commonly used
            # for generated previews. They are never valid top-level URLs or
            # messages, and malformed/control-bearing forms remain denied.
            if _CONTROL_RE.search(url) or "\\" in url or "," not in url[5:]:
                return PolicyDecision(False, "malformed-data-url", PolicyAction.RESOURCE)
            return PolicyDecision(True, "approved-local-resource", PolicyAction.RESOURCE)
        if not lowered.startswith("blob:"):
            return None
        embedded = url[5:]
        try:
            inner = _parts(embedded)
            if inner.path in {"", "/"}:
                raise ValueError("blob identifier is missing")
            canonical = _canonical_origin(inner)
        except ValueError:
            return PolicyDecision(False, "malformed-blob-url", PolicyAction.RESOURCE)
        if canonical != self.origin or inner.scheme.lower() not in {"http", "https"}:
            return PolicyDecision(False, "blob-origin-not-approved", PolicyAction.RESOURCE)
        if any(segment in {".", ".."} for segment in inner.path.split("/")):
            return PolicyDecision(False, "unsafe-blob-path", PolicyAction.RESOURCE)
        return PolicyDecision(True, "approved-local-resource", PolicyAction.RESOURCE)

    def navigation(self, url: str) -> PolicyDecision:
        return self._check(url, PolicyAction.NAVIGATION, top_level=True)

    def frame_navigation(self, url: str) -> PolicyDecision:
        return self._check(url, PolicyAction.FRAME_NAVIGATION, top_level=False)

    def resource(self, url: str) -> PolicyDecision:
        return self._check(url, PolicyAction.RESOURCE, top_level=False)

    def message(self, source: str, origin: str | None = None) -> PolicyDecision:
        # WebView2 gives Source as an absolute URI. Require both values where
        # available; never inspect or log the message body here.
        candidate = origin or source
        try:
            source_parts = _parts(source)
            candidate_parts = _parts(candidate)
        except ValueError:
            return PolicyDecision(False, "message-source-invalid", PolicyAction.MESSAGE)
        if _canonical_origin(source_parts) != self.origin or _canonical_origin(candidate_parts) != self.origin:
            return PolicyDecision(False, "message-source-not-approved", PolicyAction.MESSAGE)
        if source_parts.path != candidate_parts.path:
            return PolicyDecision(False, "message-source-mismatch", PolicyAction.MESSAGE)
        return PolicyDecision(True, "approved-origin", PolicyAction.MESSAGE)

    def allow_navigation(self, url: str) -> bool:
        return self.navigation(url).allowed

    def allow_frame_navigation(self, url: str) -> bool:
        return self.frame_navigation(url).allowed

    def allow_resource(self, url: str) -> bool:
        return self.resource(url).allowed

    def allow_message(self, source: str, origin: str | None = None) -> bool:
        return self.message(source, origin).allowed
