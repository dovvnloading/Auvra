"""Session-bound, single-use asset transfer tickets for the desktop frame.

The protocol carries only opaque HTTPS URLs. Filesystem paths and binary data
remain on the Python side of the host boundary, and every transfer is streamed
through bounded chunks. A ticket covers one file, which may go in one request
or in several: an upload's pieces come in order, each saying where it belongs
with ``Content-Range``, and a download's are asked for with ``Range``.
"""

from __future__ import annotations

from dataclasses import dataclass
import errno
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import threading
from Auvra.diagnostics import trace_public_class
from Auvra.project.errors import AssetContentError, ReadOnlyError
from Auvra.project.locking import ProjectLock
import time
from typing import Any, BinaryIO, Callable, Mapping
from urllib.parse import urlsplit


ASSET_ORIGIN = "https://assets.auvra.local"
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_RANGE_RE = re.compile(r"bytes (\d{1,12})-(\d{1,12})/(\d{1,12})")
_ASKED_RANGE_RE = re.compile(r"bytes=(\d{1,12})-(\d{1,12})")
_MARKER_NAME = ".auvra-asset-transfer"
_SESSION_LOCK_NAME = ".auvra-session"
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
    cleanup_path: Path | None = None
    consumed: bool = False
    upload: AssetUpload | None = None
    on_upload: Callable[[AssetUpload], None] | None = None
    ttl: float = 0.0
    received: int = 0
    digest: Any = None
    receiving: bool = False
    verified: bool = False


class _FilePiece:
    """Part of a file as one response's body. ``span`` lets the frame read it without a copy through Python."""

    def __init__(self, path: Path, start: int, length: int, release: Callable[[], None] | None) -> None:
        self.name = str(path)
        self.span = (start, length)
        self._release = release
        self._stream: BinaryIO | None = None
        self._left = length
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    def read(self, size: int = -1) -> bytes:
        if self._stream is None:
            self._stream = open(self.name, "rb")
            self._stream.seek(self.span[0])
        data = self._stream.read(self._left if size < 0 else min(size, self._left))
        self._left -= len(data)
        return data

    def __enter__(self) -> _FilePiece:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._stream is not None:
            self._stream.close()
        if self._release is not None:
            self._release()


class _EphemeralDownloadStream:
    """Close a staged download and remove its private copy together."""

    def __init__(self, stream: BinaryIO, cleanup: Callable[[], None]) -> None:
        self._stream = stream
        self._cleanup = cleanup
        self._closed = False

    @property
    def name(self) -> object:
        return getattr(self._stream, "name", None)

    @property
    def closed(self) -> bool:
        return self._closed or bool(getattr(self._stream, "closed", False))

    def read(self, size: int = -1) -> bytes:
        data = self._stream.read(size)
        if size < 0 or not data:
            self.close()
        return data

    def readinto(self, buffer: Any) -> int:
        size = self._stream.readinto(buffer)
        if not size:
            self.close()
        return size

    def readline(self, size: int = -1) -> bytes:
        data = self._stream.readline(size)
        if not data:
            self.close()
        return data

    def __iter__(self) -> _EphemeralDownloadStream:
        return self

    def __next__(self) -> bytes:
        line = self._stream.readline()
        if not line:
            self.close()
            raise StopIteration
        return line

    def __enter__(self) -> _EphemeralDownloadStream:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        error: Exception | None = None
        try:
            self._stream.close()
        except Exception as exc:
            error = exc
        finally:
            self._cleanup()
        if error is not None:
            raise error

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


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
        self._active_downloads: set[_EphemeralDownloadStream] = set()
        parent = Path(parent).expanduser().absolute()
        parent.mkdir(parents=True, exist_ok=True)
        self._parent = parent.resolve(strict=True)
        directory = self._parent / f"asset-transfer-{secrets.token_urlsafe(16)}"
        directory.mkdir(mode=0o700)
        self._root = directory.resolve(strict=True)
        # Taken before the marker, so no other session can find this folder and take it for abandoned.
        self._session_lock = ProjectLock(self._root / _SESSION_LOCK_NAME)
        self._session_lock.acquire()
        self._marker = secrets.token_urlsafe(32)
        marker = self._root / _MARKER_NAME
        with marker.open("x", encoding="ascii", newline="\n") as stream:
            stream.write(self._marker + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        self._remove_abandoned()

    def _remove_abandoned(self) -> None:
        """Remove what sessions that never closed left behind: a crash would otherwise keep its staged copies for good."""
        for other in self._parent.glob("asset-transfer-*"):
            if other == self._root or other.is_symlink() or not (other / _MARKER_NAME).is_file():
                continue
            lock = ProjectLock(other / _SESSION_LOCK_NAME)
            try:
                if not lock.acquire():
                    continue
                lock.release()
            except OSError:
                continue
            shutil.rmtree(other, ignore_errors=True)

    def _drop_expired(self) -> None:
        """Forget tickets nobody came back for, and what they left on disk: an upload cancelled part way, a download never fetched."""
        now = self._now()
        with self._lock:
            for state in list(self._tickets.values()):
                if now < state.expires_at or state.receiving or state.upload is not None:
                    continue
                self._tickets.pop(state.token, None)
                if not state.consumed:
                    self._cleanup_staged_path(state.cleanup_path)

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
        cleanup_path: Path | None = None,
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
        self._drop_expired()
        token = secrets.token_urlsafe(32)
        expires = self._now() + ttl
        state = _TicketState(
            token=token,
            session_id=self.session_id,
            method=method,
            mime_type=mime,
            max_size=max_size,
            expected_hash=expected_hash,
            expires_at=expires,
            source_path=source_path,
            cleanup_path=cleanup_path,
            on_upload=on_upload,
            ttl=ttl,
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
        return self._issue_download_path(
            source,
            mime_type=mime_type,
            expected_hash=expected_hash,
            max_size=max_size,
            ttl=ttl,
        )

    def _issue_download_path(
        self,
        source: Path,
        *,
        mime_type: str,
        expected_hash: str,
        max_size: int,
        ttl: float,
        cleanup_path: Path | None = None,
    ) -> AssetTicket:
        path = Path(source).absolute().resolve(strict=True)
        if not path.is_file() or path.is_symlink():
            raise AssetTransportError("asset_unavailable", 404)
        size, actual = _hash_file(path, max_size=max_size)
        if not secrets.compare_digest(actual, expected_hash):
            raise AssetTransportError("asset_hash_mismatch", 409)
        return self._new_ticket(
            "GET",
            mime_type,
            size,
            expected_hash,
            ttl,
            path,
            cleanup_path=cleanup_path,
        )

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
                # A staged download is read back once and deleted, so it is not forced to disk:
                # flushing every asset the editor loads made each one wait on the drive.
                output.flush()
            if not secrets.compare_digest(digest.hexdigest(), expected_hash):
                raise AssetTransportError("asset_hash_mismatch", 409)
            return self._issue_download_path(
                target,
                mime_type=mime_type,
                expected_hash=expected_hash,
                max_size=max_size,
                ttl=ttl,
                cleanup_path=target,
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
                self._cleanup_staged_path(state.cleanup_path)
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
                    "Access-Control-Allow-Headers": "Content-Type, Content-Range, Range",
                    "Access-Control-Max-Age": "0",
                }
            )
            return AssetResourceResponse(204, "No Content", response_headers)
        if method != state.method:
            raise AssetTransportError("asset_method_denied", 405)
        if method == "PUT":
            return self._upload(state, headers, body)
        asked = self._header(headers, "Range")
        return self._download_piece(state, asked) if asked else self._download(state)

    def failure_response(self, headers: Mapping[str, str], error: Exception) -> AssetResourceResponse:
        """A failed transfer as an answer the page that asked can read, to say what went wrong. Anything else that asks gets a bare refusal."""
        if isinstance(error, AssetTransportError):
            status = error.status
        elif isinstance(error, ReadOnlyError):
            status = 423
        elif isinstance(error, AssetContentError):
            status = 415
        elif isinstance(error, OSError) and error.errno == errno.ENOSPC:
            status = 507
        else:
            status = 500
        trusted = self._header(headers, "Origin") == self.trusted_origin
        return AssetResourceResponse(status, "Denied", self._cors_headers() if trusted else {"Cache-Control": "no-store"})

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
        first, end, total = self._piece_of(state, headers)
        with self._lock:
            if state.consumed or state.receiving:
                raise AssetTransportError("asset_ticket_consumed", 410)
            if first != state.received:
                raise AssetTransportError("asset_piece_out_of_order", 409)
            state.receiving = True
        target = self._root / f"{state.token}.upload"
        digest = state.digest or hashlib.sha256()
        size = first
        whole = False
        try:
            with target.open("ab" if first else "xb") as output:
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
                if end is not None and size != end:
                    raise AssetTransportError("asset_piece_invalid", 400)
                whole = total is None or size == total
                if whole:
                    output.flush()
                    # Stored straight away, it is forced to disk there: a second wait here buys nothing.
                    if state.on_upload is None:
                        os.fsync(output.fileno())
        except Exception:
            with self._lock:
                state.consumed = True
                state.receiving = False
                state.cleanup_path = None
            target.unlink(missing_ok=True)
            raise
        if not whole:
            with self._lock:
                state.received = size
                state.digest = digest
                state.cleanup_path = target
                state.receiving = False
                # Each piece buys the next one its time: the whole file may take longer than one ticket lasts.
                state.expires_at = self._now() + state.ttl
            return AssetResourceResponse(204, "No Content", self._cors_headers())
        with self._lock:
            state.consumed = True
            state.receiving = False
            state.cleanup_path = None
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

    def _piece_of(self, state: _TicketState, headers: Mapping[str, str]) -> tuple[int, int | None, int | None]:
        """Where a piece starts, where it ends and the whole file's size. A request stating no range is the whole file."""
        stated = self._header(headers, "Content-Range")
        if not stated:
            return 0, None, None
        match = _RANGE_RE.fullmatch(stated)
        if match is None:
            raise AssetTransportError("asset_piece_invalid", 400)
        first, last, total = (int(value, 10) for value in match.groups())
        if first > last or last >= total:
            raise AssetTransportError("asset_piece_invalid", 400)
        if total > state.max_size:
            raise AssetTransportError("asset_too_large", 413)
        return first, last + 1, total

    def _download_piece(self, state: _TicketState, asked: str) -> AssetResourceResponse:
        """One piece of a stored file. The file is checked with the first piece asked for, and let go with the last."""
        path = state.source_path
        if path is None:
            raise AssetTransportError("asset_unavailable", 404)
        match = _ASKED_RANGE_RE.fullmatch(asked)
        if match is None:
            raise AssetTransportError("asset_piece_invalid", 400)
        first, last = (int(value, 10) for value in match.groups())
        if first > last or last >= state.max_size:
            raise AssetTransportError("asset_piece_invalid", 416)
        if not state.verified:
            try:
                _, actual = _hash_file(path, max_size=state.max_size)
                if state.expected_hash is None or not secrets.compare_digest(actual, state.expected_hash):
                    raise AssetTransportError("asset_hash_mismatch", 409)
            except (AssetTransportError, OSError) as exc:
                with self._lock:
                    state.consumed = True
                self._cleanup_staged_path(state.cleanup_path)
                if isinstance(exc, AssetTransportError):
                    raise
                raise AssetTransportError("asset_unavailable", 404) from exc
            state.verified = True
        whole = last == state.max_size - 1
        with self._lock:
            state.consumed = whole
            # Each piece buys the next one its time, as it does for an upload.
            state.expires_at = self._now() + state.ttl
        length = last - first + 1
        response_headers = self._cors_headers()
        response_headers.update(
            {
                "Content-Type": state.mime_type,
                "Content-Length": str(length),
                "Content-Range": f"bytes {first}-{last}/{state.max_size}",
            }
        )
        release = (lambda: self._cleanup_staged_path(state.cleanup_path)) if whole else None
        return AssetResourceResponse(206, "Partial Content", response_headers, _FilePiece(path, first, length, release))

    def _download(self, state: _TicketState) -> AssetResourceResponse:
        with self._lock:
            if state.consumed:
                raise AssetTransportError("asset_ticket_consumed", 410)
            state.consumed = True
        path = state.source_path
        if path is None:
            raise AssetTransportError("asset_unavailable", 404)
        try:
            size, actual = _hash_file(path, max_size=state.max_size)
            if state.expected_hash is None or not secrets.compare_digest(actual, state.expected_hash):
                raise AssetTransportError("asset_hash_mismatch", 409)
            stream = path.open("rb")
        except AssetTransportError:
            self._cleanup_staged_path(state.cleanup_path)
            raise
        except OSError as exc:
            self._cleanup_staged_path(state.cleanup_path)
            raise AssetTransportError("asset_unavailable", 404) from exc
        if state.cleanup_path is not None:
            owned = _EphemeralDownloadStream(
                stream,
                lambda: self._release_download(state.cleanup_path, owned),
            )
            with self._lock:
                self._active_downloads.add(owned)
            stream = owned
        response_headers = self._cors_headers()
        response_headers.update(
            {
                "Content-Type": state.mime_type,
                "Content-Length": str(size),
                "X-Auvra-Asset-Sha256": actual,
            }
        )
        return AssetResourceResponse(200, "OK", response_headers, stream)

    def _cleanup_staged_path(self, path: Path | None) -> None:
        if path is None or path.parent != self._root:
            return
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def _release_download(self, path: Path, stream: _EphemeralDownloadStream) -> None:
        self._cleanup_staged_path(path)
        with self._lock:
            self._active_downloads.discard(stream)

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
        self._session_lock.release()
        with self._lock:
            active = list(self._active_downloads)
            self._active_downloads.clear()
            self._tickets.clear()
        for stream in active:
            try:
                stream.close()
            except OSError:
                pass
        root = self._root
        marker = root / _MARKER_NAME
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
