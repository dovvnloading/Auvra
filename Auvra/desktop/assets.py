"""Session-bound, single-use asset transfer tickets for the desktop frame.

The protocol carries only opaque HTTPS URLs. Filesystem paths and binary data
remain on the Python side of the host boundary, and every transfer is streamed
through bounded chunks.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import io
import os
from pathlib import Path
import re
import secrets
import shutil
import threading
from Auvra.diagnostics import trace_public_class
import time
from typing import Any, BinaryIO, Callable, Mapping
from urllib.parse import urlsplit


ASSET_ORIGIN = "https://assets.auvra.local"
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_CHUNK_SIZE = 1024 * 1024
_MAX_TTL_SECONDS = 300.0


class AssetTransportError(RuntimeError):
    """A bounded transport failure safe to map to an HTTP response."""

    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True, slots=True)
class AssetTicket:
    url: str
    method: str
    expires_at: float
    mime_type: str
    max_size: int

    def protocol_value(self) -> dict[str, object]:
        return {
            "url": self.url,
            "method": self.method,
            "expiresAt": self.expires_at,
            "mimeType": self.mime_type,
            "maxSize": self.max_size,
        }


@dataclass(frozen=True, slots=True)
class AssetUpload:
    """Private host-side result; ``path`` must never cross the protocol."""

    path: Path
    size: int
    sha256: str
    mime_type: str


@dataclass(slots=True)
class AssetResourceResponse:
    status: int
    reason: str
    headers: dict[str, str]
    body: BinaryIO | None = None


@dataclass(frozen=True, slots=True)
class AssetResourceRequest:
    method: str
    url: str
    headers: Mapping[str, str]
    body: Any = None


@dataclass(slots=True)
class _TicketState:
    token: str
    session_id: str
    method: str
    mime_type: str
    max_size: int
    expected_hash: str | None
    expires_at: float
    source_path: Path | None = None
    consumed: bool = False
    upload: AssetUpload | None = None
    on_upload: Callable[[AssetUpload], None] | None = None


def is_asset_resource_url(url: str) -> bool:
    """Return whether a URL targets the exact intercepted asset origin."""

    if not isinstance(url, str) or "\\" in url:
        return False
    try:
        parts = urlsplit(url)
        return (
            parts.scheme == "https"
            and parts.hostname == "assets.auvra.local"
            and parts.port in {None, 443}
            and parts.username is None
            and parts.password is None
            and not parts.query
            and not parts.fragment
        )
    except ValueError:
        return False


def _validate_origin(value: str) -> str:
    try:
        parts = urlsplit(value)
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
            or parts.path not in {"", "/"}
            or parts.query
            or parts.fragment
        ):
            raise ValueError
        port = parts.port
        default = (parts.scheme == "http" and port in {None, 80}) or (
            parts.scheme == "https" and port in {None, 443}
        )
        suffix = "" if default else f":{port}"
        return f"{parts.scheme}://{parts.hostname.lower()}{suffix}"
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ValueError("asset ticket origin is invalid") from exc


def _validate_mime(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 127
        or any(ord(char) < 33 or ord(char) > 126 for char in value)
        or ";" in value
        or "/" not in value
    ):
        raise ValueError("asset MIME type is invalid")
    return value.lower()


def _hash_file(path: Path, *, max_size: int | None = None) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(_CHUNK_SIZE)
            if not chunk:
                break
            size += len(chunk)
            if max_size is not None and size > max_size:
                raise AssetTransportError("asset_too_large", 413)
            digest.update(chunk)
    return size, digest.hexdigest()


@trace_public_class("asset_transfer", concise=(
    "issue_upload", "issue_download", "issue_download_stream", "handle",
    "claim_upload", "close",
))
class AssetTransferRegistry:
    """Own tickets and a private upload staging directory for one host session."""

    def __init__(
        self,
        parent: Path,
        *,
        session_id: str,
        trusted_origin: str,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        if not isinstance(session_id, str) or len(session_id) < 8:
            raise ValueError("asset session identity is invalid")
        self.session_id = session_id
        self.trusted_origin = _validate_origin(trusted_origin)
        self._now = now
        self._lock = threading.RLock()
        self._tickets: dict[str, _TicketState] = {}
        parent = Path(parent).expanduser().absolute()
        parent.mkdir(parents=True, exist_ok=True)
        self._parent = parent.resolve(strict=True)
        directory = self._parent / f"asset-transfer-{secrets.token_urlsafe(16)}"
        directory.mkdir(mode=0o700)
        self._root = directory.resolve(strict=True)
        self._marker = secrets.token_urlsafe(32)
        marker = self._root / ".auvra-asset-transfer"
        with marker.open("x", encoding="ascii", newline="\n") as stream:
            stream.write(self._marker + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    @property
    def root(self) -> Path:
        """Private integration surface; never serialize this value."""

        return self._root

    def _new_ticket(
        self,
        method: str,
        mime_type: str,
        max_size: int,
        expected_hash: str | None,
        ttl: float,
        source_path: Path | None = None,
        on_upload: Callable[[AssetUpload], None] | None = None,
    ) -> AssetTicket:
        if method not in {"GET", "PUT"}:
            raise ValueError("asset ticket method is invalid")
        mime = _validate_mime(mime_type)
        if not isinstance(max_size, int) or isinstance(max_size, bool) or not 1 <= max_size <= 2 * 1024**3:
            raise ValueError("asset ticket size is invalid")
        if not 0 < ttl <= _MAX_TTL_SECONDS:
            raise ValueError("asset ticket expiry is invalid")
        if expected_hash is not None and not _HASH_RE.fullmatch(expected_hash):
            raise ValueError("asset hash is invalid")
        token = secrets.token_urlsafe(32)
        expires = self._now() + ttl
        state = _TicketState(
            token,
            self.session_id,
            method,
            mime,
            max_size,
            expected_hash,
            expires,
            source_path,
            False,
            None,
            on_upload,
        )
        with self._lock:
            self._tickets[token] = state
        return AssetTicket(
            f"{ASSET_ORIGIN}/v1/{method.lower()}/{token}",
            method,
            expires,
            mime,
            max_size,
        )

    def issue_upload(
        self,
        *,
        mime_type: str,
        max_size: int,
        expected_hash: str | None = None,
        ttl: float = 60.0,
        on_upload: Callable[[AssetUpload], None] | None = None,
    ) -> AssetTicket:
        return self._new_ticket("PUT", mime_type, max_size, expected_hash, ttl, on_upload=on_upload)

    def issue_download(
        self,
        source: Path,
        *,
        mime_type: str,
        expected_hash: str,
        max_size: int,
        ttl: float = 60.0,
    ) -> AssetTicket:
        path = Path(source).absolute().resolve(strict=True)
        if not path.is_file() or path.is_symlink():
            raise AssetTransportError("asset_unavailable", 404)
        size, actual = _hash_file(path, max_size=max_size)
        if not secrets.compare_digest(actual, expected_hash):
            raise AssetTransportError("asset_hash_mismatch", 409)
        return self._new_ticket("GET", mime_type, size, expected_hash, ttl, path)

    def issue_download_stream(
        self,
        stream: BinaryIO,
        *,
        mime_type: str,
        expected_hash: str,
        max_size: int,
        ttl: float = 60.0,
    ) -> AssetTicket:
        """Stage a verified bounded stream without exposing its source path."""

        if not _HASH_RE.fullmatch(expected_hash):
            raise ValueError("asset hash is invalid")
        target = self._root / f"download-{secrets.token_urlsafe(24)}"
        digest = hashlib.sha256()
        size = 0
        try:
            with target.open("xb") as output:
                while True:
                    chunk = stream.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    if not isinstance(chunk, (bytes, bytearray, memoryview)) or len(chunk) > _CHUNK_SIZE:
                        raise AssetTransportError("asset_stream_invalid", 400)
                    size += len(chunk)
                    if size > max_size:
                        raise AssetTransportError("asset_too_large", 413)
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            if not secrets.compare_digest(digest.hexdigest(), expected_hash):
                raise AssetTransportError("asset_hash_mismatch", 409)
            return self.issue_download(
                target,
                mime_type=mime_type,
                expected_hash=expected_hash,
                max_size=max_size,
                ttl=ttl,
            )
        except Exception:
            target.unlink(missing_ok=True)
            raise

    @staticmethod
    def _header(headers: Mapping[str, str], name: str) -> str:
        lowered = name.lower()
        for key, value in headers.items():
            if str(key).lower() == lowered:
                return str(value).strip()
        return ""

    def _state_for(self, url: str) -> _TicketState:
        if not is_asset_resource_url(url):
            raise AssetTransportError("asset_url_invalid", 404)
        parts = urlsplit(url)
        segments = parts.path.split("/")
        if len(segments) != 4 or segments[:3] not in (["", "v1", "get"], ["", "v1", "put"]):
            raise AssetTransportError("asset_url_invalid", 404)
        token = segments[3]
        if not _TOKEN_RE.fullmatch(token):
            raise AssetTransportError("asset_url_invalid", 404)
        with self._lock:
            state = self._tickets.get(token)
            if state is None or state.session_id != self.session_id:
                raise AssetTransportError("asset_ticket_unknown", 404)
            if self._now() >= state.expires_at:
                self._tickets.pop(token, None)
                raise AssetTransportError("asset_ticket_expired", 410)
            if state.consumed:
                raise AssetTransportError("asset_ticket_consumed", 410)
            if segments[2] != state.method.lower():
                raise AssetTransportError("asset_method_denied", 405)
            return state

    def _cors_headers(self) -> dict[str, str]:
        return {
            "Access-Control-Allow-Origin": self.trusted_origin,
            "Cache-Control": "no-store",
            "Vary": "Origin",
            "X-Content-Type-Options": "nosniff",
        }

    def handle(
        self,
        *,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: BinaryIO | None = None,
    ) -> AssetResourceResponse:
        state = self._state_for(url)
        method = str(method).upper()
        origin = self._header(headers, "Origin")
        if origin != self.trusted_origin:
            raise AssetTransportError("asset_origin_denied", 403)
        if method == "OPTIONS":
            requested = self._header(headers, "Access-Control-Request-Method").upper()
            if requested != state.method:
                raise AssetTransportError("asset_method_denied", 405)
            response_headers = self._cors_headers()
            response_headers.update(
                {
                    "Access-Control-Allow-Methods": state.method,
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Max-Age": "0",
                }
            )
            return AssetResourceResponse(204, "No Content", response_headers)
        if method != state.method:
            raise AssetTransportError("asset_method_denied", 405)
        if method == "PUT":
            return self._upload(state, headers, body)
        return self._download(state)

    def _upload(
        self,
        state: _TicketState,
        headers: Mapping[str, str],
        body: BinaryIO | None,
    ) -> AssetResourceResponse:
        if body is None:
            raise AssetTransportError("asset_body_required", 400)
        supplied_mime = self._header(headers, "Content-Type").split(";", 1)[0].strip().lower()
        if supplied_mime != state.mime_type:
            raise AssetTransportError("asset_mime_denied", 415)
        length = self._header(headers, "Content-Length")
        if length:
            try:
                if int(length, 10) < 0 or int(length, 10) > state.max_size:
                    raise AssetTransportError("asset_too_large", 413)
            except ValueError as exc:
                raise AssetTransportError("asset_size_invalid", 400) from exc
        with self._lock:
            if state.consumed:
                raise AssetTransportError("asset_ticket_consumed", 410)
            state.consumed = True
        target = self._root / f"{state.token}.upload"
        digest = hashlib.sha256()
        size = 0
        try:
            with target.open("xb") as output:
                while True:
                    chunk = body.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    if not isinstance(chunk, (bytes, bytearray, memoryview)):
                        raise AssetTransportError("asset_stream_invalid", 400)
                    if len(chunk) > _CHUNK_SIZE:
                        raise AssetTransportError("asset_stream_invalid", 400)
                    size += len(chunk)
                    if size > state.max_size:
                        raise AssetTransportError("asset_too_large", 413)
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
        except Exception:
            target.unlink(missing_ok=True)
            raise
        actual = digest.hexdigest()
        if state.expected_hash and not secrets.compare_digest(actual, state.expected_hash):
            target.unlink(missing_ok=True)
            raise AssetTransportError("asset_hash_mismatch", 409)
        upload = AssetUpload(target, size, actual, state.mime_type)
        if state.on_upload is not None:
            try:
                state.on_upload(upload)
            except Exception:
                target.unlink(missing_ok=True)
                raise
            target.unlink(missing_ok=True)
            upload = None
        with self._lock:
            state.upload = upload
        response_headers = self._cors_headers()
        response_headers["Content-Type"] = "application/json"
        response_headers["X-Auvra-Asset-Sha256"] = actual
        response_headers["X-Auvra-Asset-Size"] = str(size)
        response_headers["Access-Control-Expose-Headers"] = "X-Auvra-Asset-Sha256, X-Auvra-Asset-Size"
        return AssetResourceResponse(204, "No Content", response_headers)

    def _download(self, state: _TicketState) -> AssetResourceResponse:
        with self._lock:
            if state.consumed:
                raise AssetTransportError("asset_ticket_consumed", 410)
            state.consumed = True
        path = state.source_path
        if path is None:
            raise AssetTransportError("asset_unavailable", 404)
        size, actual = _hash_file(path, max_size=state.max_size)
        if state.expected_hash is None or not secrets.compare_digest(actual, state.expected_hash):
            raise AssetTransportError("asset_hash_mismatch", 409)
        stream = path.open("rb")
        response_headers = self._cors_headers()
        response_headers.update(
            {
                "Content-Type": state.mime_type,
                "Content-Length": str(size),
                "X-Auvra-Asset-Sha256": actual,
            }
        )
        return AssetResourceResponse(200, "OK", response_headers, stream)

    def claim_upload(self, url: str) -> AssetUpload:
        """Claim a completed upload for repository ingestion exactly once."""

        state = self._state_for_consumed(url)
        with self._lock:
            upload = state.upload
            if upload is None:
                raise AssetTransportError("asset_upload_incomplete", 409)
            state.upload = None
            self._tickets.pop(state.token, None)
            return upload

    def _state_for_consumed(self, url: str) -> _TicketState:
        if not is_asset_resource_url(url):
            raise AssetTransportError("asset_url_invalid", 404)
        token = urlsplit(url).path.rsplit("/", 1)[-1]
        with self._lock:
            state = self._tickets.get(token)
            if state is None or state.session_id != self.session_id:
                raise AssetTransportError("asset_ticket_unknown", 404)
            return state

    def close(self) -> None:
        with self._lock:
            self._tickets.clear()
        root = self._root
        marker = root / ".auvra-asset-transfer"
        try:
            if (
                root.parent.resolve(strict=True) != self._parent
                or root.is_symlink()
                or not root.name.startswith("asset-transfer-")
                or marker.is_symlink()
                or marker.read_text(encoding="ascii") != self._marker + "\n"
            ):
                return
        except (OSError, RuntimeError, UnicodeError):
            return
        shutil.rmtree(root)

    def __enter__(self) -> AssetTransferRegistry:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
