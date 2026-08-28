"""Bounded streaming media transfer helpers; ownership of sinks stays with callers."""
from __future__ import annotations
import hashlib, os, uuid
import re
from dataclasses import dataclass
from typing import BinaryIO
from urllib.parse import unquote, urlsplit
from .errors import ErrorCode, ProviderError
from .transport import HttpRequest, Transport
from Auvra.diagnostics import trace_public_class

@dataclass(frozen=True, slots=True)
class MediaArtifact:
    artifact_id: str
    content_type: str
    size: int
    sha256: str
    committed: bool = False

@trace_public_class("provider_media", concise=("download",))
class MediaDownloader:
    def __init__(self, *, max_bytes: int = 32 * 1024 * 1024, allowed_origins: tuple[str, ...] = ("https://fal.media", "https://v3.fal.media", "https://v3b.fal.media")):
        if max_bytes <= 0: raise ValueError("media bound must be positive")
        self.max_bytes, self.allowed_origins = max_bytes, frozenset(allowed_origins)

    def download(self, url: str, *, transport: Transport, sink: BinaryIO | os.PathLike[str], expected_sha256: str | None = None,
                 expected_size: int | None = None, allowed_content_types: tuple[str, ...] = ("image/",)) -> MediaArtifact:
        if expected_sha256 is not None and (not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256)):
            raise ProviderError(ErrorCode.INVALID_REQUEST, "media hash is invalid")
        if expected_sha256 is not None:
            expected_sha256 = expected_sha256.lower()
        if expected_size is not None and (not isinstance(expected_size, int) or isinstance(expected_size, bool) or not 0 <= expected_size <= self.max_bytes):
            raise ProviderError(ErrorCode.INVALID_REQUEST, "media size is invalid")
        if not isinstance(allowed_content_types, tuple) or any(not isinstance(item, str) or not item for item in allowed_content_types):
            raise ProviderError(ErrorCode.INVALID_REQUEST, "media MIME policy is invalid")
        try:
            parsed = urlsplit(url); origin = f"{parsed.scheme}://{parsed.netloc}"; port = parsed.port
        except (TypeError, ValueError) as exc:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "media URL is not allowlisted") from exc
        if not _is_allowed_media_url(parsed, origin, self.allowed_origins, port):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "media URL is not allowlisted")
        close = False
        if hasattr(sink, "write"): stream = sink
        else: stream = open(sink, "wb"); close = True
        failed = False
        try:
            digest = hashlib.sha256()
            size, digest, headers = self._stream(url, transport, stream, digest, allowed_content_types)
            if expected_size is not None and size != expected_size: raise ProviderError(ErrorCode.REMOTE, "media size did not match expected size")
            value = digest.hexdigest()
            if expected_sha256 is not None and value != expected_sha256: raise ProviderError(ErrorCode.REMOTE, "media hash verification failed")
            return MediaArtifact(str(uuid.uuid4()), headers.get("content-type", "application/octet-stream"), size, value)
        except Exception:
            failed = True
            raise
        finally:
            if close: stream.close()
            if failed and close:
                try: os.unlink(sink)
                except (FileNotFoundError, OSError): pass

    def _stream(self, url, transport, sink, digest, allowed):
        current = url
        for _ in range(3):
            parsed = urlsplit(current); origin = f"{parsed.scheme}://{parsed.netloc}"
            target = _HashSink(sink, digest, self.max_bytes)
            response = transport.stream(HttpRequest("GET", current, {"Accept": "image/*"}, b""), target, max_bytes=self.max_bytes) if hasattr(transport, "stream") else transport.request(HttpRequest("GET", current, {"Accept": "image/*"}, b""))
            if response.status in {301, 302, 303, 307, 308}:
                location = _header(response, "location")
                try:
                    p = urlsplit(location or ""); port = p.port
                except (TypeError, ValueError) as exc:
                    raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "media redirect is not allowlisted") from exc
                if not _is_allowed_media_url(p, f"{p.scheme}://{p.netloc}", self.allowed_origins, port):
                    raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "media redirect is not allowlisted")
                if target.size:
                    raise ProviderError(ErrorCode.REMOTE, "media redirect returned a body")
                current = location; continue
            if response.status < 200 or response.status >= 300: raise ProviderError(ErrorCode.REMOTE, "media download failed")
            ctype = _header(response, "content-type", "application/octet-stream").split(";", 1)[0].strip().lower()
            allowed = tuple(item.strip().lower() for item in allowed)
            if allowed and not any(ctype.startswith(prefix) for prefix in allowed): raise ProviderError(ErrorCode.REMOTE, "media MIME type is not allowed")
            declared = _declared_size(response)
            if declared is not None and declared > self.max_bytes: raise ProviderError(ErrorCode.REMOTE, "media exceeds size limit")
            if not hasattr(transport, "stream"):
                data = response.body
                target.write(data)
            if declared is not None and declared != target.size: raise ProviderError(ErrorCode.REMOTE, "media size did not match response")
            return target.size, digest, {"content-type": ctype}
        raise ProviderError(ErrorCode.REMOTE, "media redirect limit exceeded")

    def _add_size(self, n, size): return size + n

@trace_public_class("provider_media", concise=("ingest", "discard", "commit"))
class MediaPreviewStore(MediaDownloader):
    """Compatibility name retained as a transfer helper; no bytes are retained."""
    def ingest(self, data: bytes, *, sink: BinaryIO | os.PathLike[str], content_type: str = "application/octet-stream") -> MediaArtifact:
        if not isinstance(data, bytes) or not data or len(data) > self.max_bytes: raise ProviderError(ErrorCode.INVALID_REQUEST, "media is empty or exceeds size limit")
        if hasattr(sink, "write"): sink.write(data)
        else:
            with open(sink, "wb") as stream: stream.write(data)
        return MediaArtifact(str(uuid.uuid4()), content_type, len(data), hashlib.sha256(data).hexdigest())

    def preview(self, artifact: MediaArtifact) -> MediaArtifact: return artifact
    def discard(self, artifact: MediaArtifact) -> bool: return True
    def commit(self, artifact: MediaArtifact) -> MediaArtifact: return MediaArtifact(artifact.artifact_id, artifact.content_type, artifact.size, artifact.sha256, True)

def _header(response, name: str, default: str = "") -> str:
    for key, value in response.headers.items():
        if isinstance(key, str) and key.lower() == name.lower():
            return value if isinstance(value, str) else default
    return default


def _declared_size(response) -> int | None:
    value = _header(response, "content-length")
    if not value:
        return None
    try:
        size = int(value)
    except (TypeError, ValueError):
        raise ProviderError(ErrorCode.REMOTE, "media size is invalid")
    if size < 0:
        raise ProviderError(ErrorCode.REMOTE, "media size is invalid")
    return size


def _is_allowed_media_url(parsed, origin: str, allowed_origins, port: int | None) -> bool:
    return (parsed.scheme == "https" and origin in allowed_origins and port is None and
            bool(parsed.path.strip("/")) and not parsed.username and not parsed.password and
            not parsed.fragment and not any(ord(ch) < 32 or ord(ch) == 127 for ch in parsed.geturl()) and
            "\\" not in parsed.path and
            all(part not in {".", ".."} for part in unquote(parsed.path).split("/")))

class _HashSink:
    def __init__(self, sink, digest, limit): self.sink, self.digest, self.limit, self.size = sink, digest, limit, 0
    def write(self, data):
        self.size += len(data)
        if self.size > self.limit: raise ProviderError(ErrorCode.REMOTE, "media exceeds size limit")
        self.digest.update(data); return self.sink.write(data)
