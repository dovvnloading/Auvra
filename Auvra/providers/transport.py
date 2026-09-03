"""Bounded standard-library transport contracts and stream parsers."""

from __future__ import annotations

import json
import http.client
import ssl
from dataclasses import dataclass, field
from typing import BinaryIO, Iterable, Iterator, Mapping, Protocol
from urllib.parse import urljoin, urlsplit

from .errors import ErrorCode, ProviderError, from_http_status
from Auvra.diagnostics import trace_public_class


_HOP_BY_HOP_HEADERS = frozenset({"host", "connection"})


@dataclass(frozen=True, slots=True)
class HttpRequest:
    method: str
    url: str
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""
    timeout: float = 30.0


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""

    @property
    def retry_after(self) -> float | None:
        value = next((v for k, v in self.headers.items() if k.lower() == "retry-after"), None)
        try: return min(86400.0, max(0.0, float(value))) if value is not None else None
        except (TypeError, ValueError): return None

    def json(self, *, max_bytes: int = 4 * 1024 * 1024):
        if len(self.body) > max_bytes:
            raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProviderError(ErrorCode.REMOTE, "provider returned invalid JSON") from exc


class Transport(Protocol):
    def request(self, request: HttpRequest) -> HttpResponse: ...
    def stream(self, request: HttpRequest, sink: BinaryIO, *, max_bytes: int) -> HttpResponse: ...
    def upload(self, request: HttpRequest, source: BinaryIO, *, size: int) -> HttpResponse: ...


@trace_public_class("provider_transport", concise=("request", "stream", "upload"))
class StdlibTransport:
    """Production HTTP transport with TLS/loopback policy and bounded reads."""

    def __init__(self, *, max_response_bytes: int = 16 * 1024 * 1024, user_agent: str = "Auvra/1 provider") -> None:
        if max_response_bytes <= 0: raise ValueError("response bound must be positive")
        self.max_response_bytes = max_response_bytes
        self.user_agent = user_agent[:128]

    def request(self, request: HttpRequest) -> HttpResponse:
        try:
            parsed = urlsplit(request.url); parsed.port
        except (TypeError, ValueError) as exc:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed") from exc
        if (parsed.scheme not in {"https", "http"} or not parsed.hostname or
                parsed.username or parsed.password or parsed.fragment):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed")
        if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "::1"}:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "non-TLS provider endpoint is not allowed")
        if request.method.upper() == "GET" and request.body:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "GET requests cannot contain a body")
        if request.timeout <= 0 or request.timeout > 120: raise ProviderError(ErrorCode.TIMEOUT, "provider timeout is outside the allowed bound")
        headers = _forward_headers(request.headers)
        headers["User-Agent"] = self.user_agent
        try:
            connection: http.client.HTTPConnection | http.client.HTTPSConnection
            if parsed.scheme == "https": connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=request.timeout, context=ssl.create_default_context())
            else: connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=request.timeout)
            try:
                request_path = parsed.path or "/"
                if parsed.query: request_path += "?" + parsed.query
                connection.request(request.method.upper(), request_path, body=request.body, headers=headers)
                response = connection.getresponse()
                captured = {k.lower(): v[:512] for k, v in response.getheaders() if k.lower() in {"content-type", "content-length", "location", "retry-after", "x-request-id"}}
                declared = _content_length(captured)
                if declared is not None and declared > self.max_response_bytes:
                    raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
                data = bytearray()
                while len(data) <= self.max_response_bytes:
                    chunk = response.read(min(64 * 1024, self.max_response_bytes + 1 - len(data)))
                    if not chunk: break
                    data.extend(chunk)
                if len(data) > self.max_response_bytes: raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
                return HttpResponse(response.status, captured, bytes(data))
            finally: connection.close()
        except ProviderError: raise
        except TimeoutError as exc: raise ProviderError(ErrorCode.TIMEOUT, "provider request timed out", retryable=True) from exc
        except OSError as exc: raise ProviderError(ErrorCode.NETWORK, "provider network request failed", retryable=True) from exc

    def stream(self, request: HttpRequest, sink: BinaryIO, *, max_bytes: int) -> HttpResponse:
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "provider response size limit is invalid")
        if request.timeout <= 0 or request.timeout > 120:
            raise ProviderError(ErrorCode.TIMEOUT, "provider timeout is outside the allowed bound")
        try:
            parsed = urlsplit(request.url); parsed.port
        except (TypeError, ValueError) as exc:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed") from exc
        if (parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or
                (parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "::1"})):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed")
        if request.method.upper() == "GET" and request.body:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "GET requests cannot contain a body")
        try:
            conn = (http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=request.timeout, context=ssl.create_default_context()) if parsed.scheme == "https" else http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=request.timeout))
            try:
                path = parsed.path or "/"; path += ("?" + parsed.query) if parsed.query else ""
                headers = _forward_headers(request.headers); headers["User-Agent"] = self.user_agent
                conn.request(request.method.upper(), path, body=request.body, headers=headers); response = conn.getresponse()
                captured = {k.lower(): v[:512] for k, v in response.getheaders() if k.lower() in {"content-type", "content-length", "location", "retry-after", "x-request-id"}}
                declared = _content_length(captured)
                if declared is not None and declared > max_bytes:
                    raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
                if response.status < 200 or response.status >= 300:
                    response.read(min(64 * 1024, max_bytes + 1))
                    return HttpResponse(response.status, captured, b"")
                total = 0
                while True:
                    chunk = response.read(min(64 * 1024, max_bytes - total + 1))
                    if not chunk: break
                    total += len(chunk)
                    if total > max_bytes: raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
                    sink.write(chunk)
                return HttpResponse(response.status, captured, b"")
            finally: conn.close()
        except ProviderError: raise
        except TimeoutError as exc: raise ProviderError(ErrorCode.TIMEOUT, "provider request timed out", retryable=True) from exc
        except OSError as exc: raise ProviderError(ErrorCode.NETWORK, "provider network request failed", retryable=True) from exc

    def upload(self, request: HttpRequest, source: BinaryIO, *, size: int) -> HttpResponse:
        if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > self.max_response_bytes * 2: raise ProviderError(ErrorCode.INVALID_REQUEST, "upload size is invalid")
        if request.timeout <= 0 or request.timeout > 120:
            raise ProviderError(ErrorCode.TIMEOUT, "provider timeout is outside the allowed bound")
        try:
            parsed = urlsplit(request.url); parsed.port
        except (TypeError, ValueError) as exc:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed") from exc
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed")
        conn = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=request.timeout, context=ssl.create_default_context())
        try:
            path = parsed.path or "/"; path += ("?" + parsed.query) if parsed.query else ""
            headers = _forward_headers(request.headers, excluded={"content-length", "transfer-encoding"})
            headers["User-Agent"] = self.user_agent; headers["Content-Length"] = str(size)
            conn.putrequest(request.method.upper(), path)
            for key, value in headers.items(): conn.putheader(key, value)
            conn.endheaders(); sent = 0
            while sent < size:
                chunk = source.read(min(64 * 1024, size - sent))
                if not chunk: raise ProviderError(ErrorCode.INVALID_REQUEST, "upload source ended early")
                sent += len(chunk); conn.send(chunk)
            if sent != size: raise ProviderError(ErrorCode.INVALID_REQUEST, "upload size did not match source")
            response = conn.getresponse(); captured = {k.lower(): v[:512] for k, v in response.getheaders() if k.lower() in {"content-type", "content-length", "location", "retry-after", "x-request-id"}}
            declared = _content_length(captured)
            if declared is not None and declared > self.max_response_bytes:
                raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
            data = bytearray()
            while len(data) <= self.max_response_bytes:
                chunk = response.read(min(64 * 1024, self.max_response_bytes + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            if len(data) > self.max_response_bytes:
                raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
            if declared is not None and len(data) != declared:
                raise ProviderError(ErrorCode.REMOTE, "provider response size did not match declared length")
            return HttpResponse(response.status, captured, bytes(data))
        except ProviderError: raise
        except (TimeoutError, OSError) as exc: raise ProviderError(ErrorCode.NETWORK, "provider upload failed", retryable=True) from exc
        finally: conn.close()


StandardHttpTransport = StdlibTransport
HttpTransport = StdlibTransport


def _content_length(headers: Mapping[str, str]) -> int | None:
    value = next((v for k, v in headers.items() if k.lower() == "content-length"), None)
    if value is None:
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise ProviderError(ErrorCode.REMOTE, "provider response had an invalid size")
    if result < 0:
        raise ProviderError(ErrorCode.REMOTE, "provider response had an invalid size")
    return result


def _forward_headers(headers: Mapping[str, str], *, excluded: Iterable[str] = ()) -> dict[str, str]:
    blocked = _HOP_BY_HOP_HEADERS | {str(name).lower() for name in excluded}
    return {
        str(key): str(value)
        for key, value in headers.items()
        if str(key).lower() not in blocked
    }


@trace_public_class("provider_transport", concise=("request", "stream", "upload"))
class BoundedTransport:
    """Injectable transport guard; it does not create network connections itself."""

    def __init__(self, transport: Transport, *, max_request_bytes: int = 4 * 1024 * 1024,
                 max_response_bytes: int = 16 * 1024 * 1024, max_timeout: float = 120.0,
                 allowed_origins: Iterable[str] = ()) -> None:
        if max_request_bytes <= 0 or max_response_bytes <= 0 or max_timeout <= 0:
            raise ValueError("transport limits must be positive")
        self.transport, self.max_request_bytes = transport, max_request_bytes
        self.max_response_bytes, self.max_timeout = max_response_bytes, max_timeout
        self.allowed_origins = frozenset(allowed_origins)

    def request(self, request: HttpRequest) -> HttpResponse:
        parsed, origin = self._validate(request)
        if len(request.body) > self.max_request_bytes:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "provider request exceeded size limit")
        if request.timeout <= 0 or request.timeout > self.max_timeout:
            raise ProviderError(ErrorCode.TIMEOUT, "provider timeout is outside the allowed bound")
        response = self.transport.request(request)
        if len(response.body) > self.max_response_bytes:
            raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
        if response.status < 200 or response.status >= 300:
            raise from_http_status(response.status, provider="provider", retry_after=response.retry_after)
        return response

    def stream(self, request: HttpRequest, sink: BinaryIO, *, max_bytes: int | None = None) -> HttpResponse:
        self._validate(request)
        limit = self.max_response_bytes if max_bytes is None else min(max_bytes, self.max_response_bytes)
        if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "provider response size limit is invalid")
        if not hasattr(self.transport, "stream"):
            response = self.request(request)
            if len(response.body) > limit: raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
            sink.write(response.body); return HttpResponse(response.status, response.headers, b"")
        response = self.transport.stream(request, _BoundedSink(sink, limit), max_bytes=limit)
        if response.status < 200 or response.status >= 300: raise from_http_status(response.status, provider="provider", retry_after=response.retry_after)
        return response

    def upload(self, request: HttpRequest, source: BinaryIO, *, size: int) -> HttpResponse:
        self._validate(request)
        if not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > self.max_response_bytes * 2:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "provider upload size is invalid")
        if not hasattr(self.transport, "upload"): raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "stream upload is unavailable")
        response = self.transport.upload(request, source, size=size)
        if len(response.body) > self.max_response_bytes:
            raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
        if response.status < 200 or response.status >= 300: raise from_http_status(response.status, provider="provider", retry_after=response.retry_after)
        return response

    def _validate(self, request: HttpRequest):
        try:
            parsed = urlsplit(request.url)
            origin = f"{parsed.scheme}://{parsed.netloc}"
            hostname = parsed.hostname
        except (TypeError, ValueError) as exc:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed") from exc
        if parsed.scheme not in {"https", "http"} or not hostname or parsed.username or parsed.password or parsed.fragment:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed")
        if parsed.scheme == "http" and hostname not in {"127.0.0.1", "::1"}:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "non-TLS provider endpoint is not allowed")
        if request.method.upper() == "GET" and request.body:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "GET requests cannot contain a body")
        if self.allowed_origins and origin not in self.allowed_origins: raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowed")
        if len(request.body) > self.max_request_bytes: raise ProviderError(ErrorCode.INVALID_REQUEST, "provider request exceeded size limit")
        if request.timeout <= 0 or request.timeout > self.max_timeout: raise ProviderError(ErrorCode.TIMEOUT, "provider timeout is outside the allowed bound")
        return parsed, origin


@dataclass(frozen=True, slots=True)
class SseEvent:
    event: str | None
    data: str
    event_id: str | None = None
    retry: int | None = None


class _BoundedSink:
    """Defensive sink wrapper for injectable transports.

    A transport implementation must honor ``max_bytes``; the wrapper keeps
    that contract true even when a test double or third-party implementation
    writes an oversized chunk in one call.
    """
    def __init__(self, sink: BinaryIO, limit: int) -> None:
        self.sink, self.limit, self.total = sink, limit, 0

    def write(self, data: bytes) -> int:
        self.total += len(data)
        if self.total > self.limit:
            raise ProviderError(ErrorCode.REMOTE, "provider response exceeded size limit")
        return self.sink.write(data)


def parse_sse(chunks: Iterable[bytes | str], *, max_event_bytes: int = 1_048_576) -> Iterator[SseEvent]:
    if not isinstance(max_event_bytes, int) or isinstance(max_event_bytes, bool) or max_event_bytes <= 0:
        raise ValueError("event bound must be positive")
    buffer = ""
    event: str | None = None
    event_id: str | None = None
    retry: int | None = None
    data: list[str] = []

    def flush() -> SseEvent | None:
        nonlocal event, event_id, retry, data
        if not data and event is None and event_id is None and retry is None:
            return None
        result = SseEvent(event, "\n".join(data), event_id, retry)
        event = event_id = None
        retry = None
        data = []
        return result

    for chunk in chunks:
        buffer += chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
        if len(buffer.encode("utf-8")) > max_event_bytes:
            raise ProviderError(ErrorCode.REMOTE, "provider stream event exceeded size limit")
        lines = buffer.splitlines(keepends=True)
        buffer = "" if not lines or lines[-1].endswith(("\n", "\r")) else lines.pop()
        for line in lines:
            line = line.rstrip("\r\n")
            if not line:
                item = flush()
                if item is not None: yield item
                continue
            if line.startswith(":"): continue
            key, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if key == "event": event = value
            elif key == "data":
                data.append(value)
                if len("\n".join(data).encode("utf-8")) > max_event_bytes:
                    raise ProviderError(ErrorCode.REMOTE, "provider stream event exceeded size limit")
            elif key == "id": event_id = value
            elif key == "retry" and value.isdigit(): retry = int(value)
    if buffer:
        key, _, value = buffer.partition(":")
        if key == "data":
            data.append(value[1:] if value.startswith(" ") else value)
            if len("\n".join(data).encode("utf-8")) > max_event_bytes:
                raise ProviderError(ErrorCode.REMOTE, "provider stream event exceeded size limit")
    item = flush()
    if item is not None: yield item


def parse_ndjson(chunks: Iterable[bytes | str], *, max_line_bytes: int = 1_048_576) -> Iterator[dict]:
    buffer = ""
    for chunk in chunks:
        buffer += chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
        if len(buffer.encode("utf-8")) > max_line_bytes:
            raise ProviderError(ErrorCode.REMOTE, "provider stream line exceeded size limit")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.rstrip("\r")
            if len(line.encode()) > max_line_bytes:
                raise ProviderError(ErrorCode.REMOTE, "provider stream line exceeded size limit")
            if not line.strip(): continue
            try: value = json.loads(line)
            except json.JSONDecodeError as exc: raise ProviderError(ErrorCode.REMOTE, "provider returned invalid NDJSON") from exc
            if not isinstance(value, dict): raise ProviderError(ErrorCode.REMOTE, "provider NDJSON item was not an object")
            yield value
    if buffer.strip():
        if len(buffer.encode()) > max_line_bytes: raise ProviderError(ErrorCode.REMOTE, "provider stream line exceeded size limit")
        try: value = json.loads(buffer)
        except json.JSONDecodeError as exc: raise ProviderError(ErrorCode.REMOTE, "provider returned invalid NDJSON") from exc
        if not isinstance(value, dict): raise ProviderError(ErrorCode.REMOTE, "provider NDJSON item was not an object")
        yield value
