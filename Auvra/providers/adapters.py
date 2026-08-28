"""SDK-free provider adapters using one injectable bounded HTTP contract."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import unquote, urlsplit

from .commands import COMMAND_JSON_SCHEMA, CommandProposal, validate_command
from .descriptors import Capability, ProviderDescriptor, ProviderRegistry
from .errors import ErrorCode, ProviderError, normalize_error
from .media import MediaArtifact, MediaDownloader
from .transport import BoundedTransport, HttpRequest, HttpResponse, Transport
from Auvra.diagnostics import trace_public_class


@dataclass(frozen=True, slots=True)
class TextResult:
    provider: str
    model: str
    text: str
    usage: Mapping[str, int] | None = None

    def __repr__(self) -> str:
        # Completion text can contain credentials or user-provided private
        # material; callers should log metadata, never the full response.
        return (f"TextResult(provider={self.provider!r}, model={self.model!r}, "
                f"text_length={len(self.text)}, usage_present={self.usage is not None})")


@dataclass(frozen=True, slots=True)
class MediaJob:
    provider: str
    model: str
    request_id: str

    def __repr__(self) -> str:
        return f"MediaJob(provider={self.provider!r}, model={self.model!r}, request_id_present={bool(self.request_id)})"


@trace_public_class("provider_adapter", concise=("health", "list_models"))
class Adapter:
    def __init__(self, transport: Transport, *, credential_store: Any = None,
                 registry: ProviderRegistry | None = None, endpoint: str | None = None) -> None:
        self.registry = registry or ProviderRegistry()
        self.descriptor = self.registry.get(self.provider_id)
        self.credentials = credential_store
        self.endpoint = endpoint or self.descriptor.origins[0]
        _validate_endpoint(self.descriptor, self.endpoint)
        self.transport = BoundedTransport(transport, allowed_origins=self.descriptor.origins)
        self._raw_transport = transport
        self._models = set(self.descriptor.models)

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.descriptor.credential_name:
            if self.credentials is None:
                raise ProviderError(ErrorCode.CREDENTIAL_UNAVAILABLE, "provider credential is unavailable", self.provider_id)
            try: key = self.credentials.read(self.descriptor.credential_name)
            except Exception as exc: raise ProviderError(ErrorCode.CREDENTIAL_UNAVAILABLE, "provider credential is unavailable", self.provider_id) from exc
            if not key:
                raise ProviderError(ErrorCode.CREDENTIAL_UNAVAILABLE, "provider credential is unavailable", self.provider_id)
            if self.provider_id == "fal": headers["Authorization"] = "Key " + key
            elif self.provider_id == "anthropic": headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"
            else: headers["Authorization"] = "Bearer " + key
        return headers

    def health(self) -> bool:
        try:
            self._json("GET", self._health_path())
            return True
        except ProviderError:
            return False

    def _health_path(self) -> str:
        if self.provider_id == "fal": return "/status"
        if self.provider_id == "ollama": return "/api/tags"
        if self.provider_id == "openrouter": return "/api/v1/models"
        return "/v1/models"

    def list_models(self) -> tuple[str, ...]:
        """Refresh a process-local allowlist; never accepts model names blindly."""
        try:
            value = self._json("GET", self._models_path())
            candidates = value.get("data", value.get("models", []))
            discovered = []
            if isinstance(candidates, list):
                for item in candidates:
                    name = (item.get("id") or item.get("name") or item.get("model")) if isinstance(item, Mapping) else item
                    if isinstance(name, str) and 0 < len(name) <= 200: discovered.append(name)
            self._models.update(discovered)
            if discovered: self.registry.discover_models(self.provider_id, self._models)
        except ProviderError:
            pass
        return tuple(sorted(self._models))

    @property
    def models(self) -> tuple[str, ...]:
        return self.registry.models(self.provider_id)

    def _models_path(self) -> str:
        if self.provider_id == "ollama": return "/api/tags"
        if self.provider_id == "openrouter": return "/api/v1/models"
        return "/v1/models"

    def _json(self, method: str, path: str, payload: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
        url = self.endpoint.rstrip("/") + "/" + path.lstrip("/")
        # GET requests have no object body in any provider contract.
        body = b"" if method.upper() == "GET" else json.dumps(payload or {}, separators=(",", ":")).encode()
        response = self.transport.request(HttpRequest(method, url, self._headers(), body))
        value = response.json()
        if not isinstance(value, Mapping): raise ProviderError(ErrorCode.REMOTE, "provider returned an invalid object", self.provider_id)
        return value


@trace_public_class("provider_adapter", concise=("complete",))
class TextAdapter(Adapter):
    """Common text and structured-command contract for cloud and local providers."""
    provider_id = ""

    def complete(self, *, model: str, prompt: str, capability: Capability | str = Capability.TEXT, system: str | None = None,
                 structured_command: bool = False, temperature: float | None = None,
                 target_element_id: str | None = None) -> TextResult | CommandProposal:
        if not isinstance(prompt, str) or not prompt or len(prompt) > 1_000_000:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "prompt is invalid", self.provider_id)
        try: capability = Capability(capability)
        except (TypeError, ValueError) as exc: raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "capability is not supported", self.provider_id) from exc
        if structured_command: capability = Capability.COMMANDS
        if capability not in {Capability.TEXT, Capability.CODE, Capability.COMMANDS} or model not in self.models or not self.descriptor.supports(capability):
            raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "provider/model does not support requested capability", self.provider_id)
        try: value = self._complete_json(model=model, prompt=prompt, system=system, temperature=temperature,
                                         structured_command=structured_command)
        except ProviderError: raise
        except Exception as exc: raise normalize_error(exc, provider=self.provider_id) from exc
        text = self._extract_text(value)
        if structured_command:
            # The host-selected target is the only binding an update/delete
            # proposal may use; never trust a target supplied by model output.
            try: return validate_command(json.loads(text), target_element_id=target_element_id)
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                raise ProviderError(ErrorCode.REMOTE, "provider returned an invalid command proposal", self.provider_id) from exc
        if len(text) > 65536: raise ProviderError(ErrorCode.REMOTE, "provider text exceeded size limit", self.provider_id)
        raw_usage = value.get("usage")
        usage = ({str(key): item for key, item in raw_usage.items()
                  if isinstance(key, str) and isinstance(item, int) and not isinstance(item, bool) and item >= 0}
                 if isinstance(raw_usage, Mapping) else None)
        return TextResult(self.provider_id, model, text, usage)

    def _complete_json(self, *, model: str, prompt: str, system: str | None,
                       temperature: float | None, structured_command: bool) -> Mapping[str, Any]:
        payload: dict[str, Any] = {"model": model, "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]}
        if temperature is not None: payload["temperature"] = temperature
        if structured_command: payload["response_format"] = {"type": "json_schema", "json_schema": {"name": "auvra_hud_commands", "strict": True, "schema": COMMAND_JSON_SCHEMA}}
        path = "/v1/chat/completions"
        if self.provider_id in {"openai", "xai"}:
            path = "/v1/responses"
            payload = {"model": model, "input": prompt, "store": False, "max_output_tokens": 4096}
            if system: payload["instructions"] = system
            if temperature is not None: payload["temperature"] = temperature
            if structured_command: payload["text"] = {"format": {"type": "json_schema", "name": "auvra_hud_commands", "strict": True, "schema": COMMAND_JSON_SCHEMA}}
        elif self.provider_id == "openrouter":
            payload["provider"] = {"allow_fallbacks": False, "require_parameters": True, "data_collection": "deny"}
        if self.provider_id == "anthropic":
            payload = {"model": model, "max_tokens": 4096, "messages": [{"role": "user", "content": prompt}]}
            if system: payload["system"] = system
            if structured_command:
                payload["output_config"] = {"format": {"type": "json_schema", "schema": COMMAND_JSON_SCHEMA}}
            path = "/v1/messages"
        elif self.provider_id == "ollama":
            path = "/api/chat"
            payload["stream"] = False
            if structured_command: payload["format"] = COMMAND_JSON_SCHEMA
        elif self.provider_id == "openrouter":
            # OpenRouter's OpenAI-compatible API is rooted at /api/v1.
            path = "/api/v1/chat/completions"
        elif self.provider_id == "llama.cpp":
            path = "/v1/chat/completions"
        return self._json("POST", path, payload)

    def _extract_text(self, value: Mapping[str, Any]) -> str:
        if self.provider_id == "anthropic":
            content = value.get("content", [])
            if isinstance(content, list):
                text = "".join(block["text"] for block in content if isinstance(block, Mapping) and block.get("type") == "text" and isinstance(block.get("text"), str))
                if text: return text
        elif self.provider_id == "ollama":
            message = value.get("message")
            if isinstance(message, Mapping) and isinstance(message.get("content"), str): return message["content"]
        if self.provider_id in {"openai", "xai"}:
            output = value.get("output", [])
            if isinstance(output, list):
                for item in output:
                    if isinstance(item, Mapping):
                        content = item.get("content", [])
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, Mapping) and isinstance(block.get("text"), str): return block["text"]
            if isinstance(value.get("output_text"), str): return value["output_text"]
        choices = value.get("choices", [])
        if isinstance(choices, list) and choices and isinstance(choices[0], Mapping):
            message = choices[0].get("message", choices[0])
            if isinstance(message, Mapping):
                content = message.get("content")
                if isinstance(content, str): return content
                if isinstance(content, list):
                    text = "".join(item["text"] for item in content if isinstance(item, Mapping) and isinstance(item.get("text"), str))
                    if text: return text
        if self.provider_id == "llama.cpp":
            for key in ("content", "response"):
                if isinstance(value.get(key), str): return value[key]
        raise ProviderError(ErrorCode.REMOTE, "provider response contained no text", self.provider_id)


class OpenAIAdapter(TextAdapter): provider_id = "openai"
class AnthropicAdapter(TextAdapter): provider_id = "anthropic"
class XAIAdapter(TextAdapter): provider_id = "xai"
class OpenRouterAdapter(TextAdapter): provider_id = "openrouter"
class OllamaAdapter(TextAdapter): provider_id = "ollama"
class LlamaCppAdapter(TextAdapter): provider_id = "llama.cpp"


@trace_public_class("provider_adapter", concise=(
    "submit", "status", "result", "cancel", "upload_input", "download_output",
))
class FalAdapter(Adapter):
    provider_id = "fal"

    def submit(self, *, model: str, payload: Mapping[str, Any], capability: Capability | str = Capability.MEDIA_GENERATE) -> MediaJob:
        try: capability = Capability(capability)
        except (TypeError, ValueError) as exc: raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "fal capability is not supported", self.provider_id) from exc
        if not isinstance(payload, Mapping):
            raise ProviderError(ErrorCode.INVALID_REQUEST, "fal request payload is invalid", self.provider_id)
        if capability not in {Capability.MEDIA_GENERATE, Capability.MEDIA_EDIT} or not self.descriptor.supports(capability, model):
            raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "fal model is not registered", self.provider_id)
        if capability == Capability.MEDIA_EDIT and model != "fal-ai/flux/dev/image-to-image": raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "fal edit model is not supported", self.provider_id)
        if capability == Capability.MEDIA_GENERATE and model != "fal-ai/flux/dev": raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "fal generation model is not supported", self.provider_id)
        result = self._json("POST", f"/{model}", payload)
        request_id = result.get("request_id") or result.get("id")
        if not _valid_remote_id(request_id):
            raise ProviderError(ErrorCode.REMOTE, "fal response contained no request id", self.provider_id)
        return MediaJob(self.provider_id, model, request_id)

    def status(self, job: MediaJob) -> Mapping[str, Any]:
        self._validate_job(job)
        return self._json("GET", f"/{job.model}/requests/{job.request_id}/status")

    @staticmethod
    def status_state(value: Mapping[str, Any]) -> str:
        state = str(value.get("status", value.get("state", ""))).upper()
        return {"IN_QUEUE": "queued", "IN_PROGRESS": "running", "COMPLETED": "succeeded", "FAILED": "failed", "CANCELLED": "cancelled"}.get(state, "unknown")

    def result(self, job: MediaJob) -> Mapping[str, Any]:
        self._validate_job(job)
        return self._json("GET", f"/{job.model}/requests/{job.request_id}")

    def cancel(self, job: MediaJob) -> bool:
        self._validate_job(job)
        url = self.endpoint.rstrip("/") + f"/{job.model}/requests/{job.request_id}/cancel"
        response = self.transport.request(HttpRequest("PUT", url, self._headers(), b""))
        if response.status not in {200, 202, 204}: raise ProviderError(ErrorCode.REMOTE, "fal cancellation failed", self.provider_id, response.status >= 500, response.status)
        return True

    def upload_input(self, *, source, size: int, filename: str = "input.bin", content_type: str = "application/octet-stream") -> str:
        if not isinstance(size, int) or size <= 0 or size > 32 * 1024 * 1024: raise ProviderError(ErrorCode.INVALID_REQUEST, "fal upload size is invalid", self.provider_id)
        _validate_upload_metadata(filename, content_type)
        response = self.transport.request(HttpRequest("POST", "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {**self._headers(), "Content-Type": "application/json"}, json.dumps({"file_name": filename[:128], "content_type": content_type}, separators=(",", ":")).encode()))
        value = response.json()
        if not isinstance(value, Mapping) or not isinstance(value.get("upload_url"), str) or not isinstance(value.get("file_url"), str): raise ProviderError(ErrorCode.REMOTE, "fal upload response was invalid", self.provider_id)
        upload_url, file_url = value["upload_url"], value["file_url"]
        if not _fal_cdn_url(upload_url) or not _fal_cdn_url(file_url): raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "fal upload URL was not trusted", self.provider_id)
        upload_transport = BoundedTransport(self._raw_transport, allowed_origins=("https://fal.media", "https://v3.fal.media", "https://v3b.fal.media"))
        upload_transport.upload(HttpRequest("PUT", upload_url, {"Content-Type": content_type}, b""), source, size=size)
        return file_url

    def download_output(self, url: str, *, sink, expected_sha256: str | None = None,
                        expected_size: int | None = None) -> MediaArtifact:
        """Stream one Fal CDN artifact through the dedicated media policy."""
        return MediaDownloader(max_bytes=128 * 1024 * 1024).download(
            url, transport=self._raw_transport, sink=sink,
            expected_sha256=expected_sha256, expected_size=expected_size,
            allowed_content_types=("image/",),
        )

    def _validate_job(self, job: MediaJob) -> None:
        if not isinstance(job, MediaJob) or job.provider != self.provider_id:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "fal job is invalid", self.provider_id)
        # Models are registered route segments (and may contain one slash),
        # while request IDs are a single opaque path segment. Re-check both
        # here because MediaJob is public and can be constructed by callers.
        if job.model not in self.descriptor.models or any(part in {"", ".", ".."} for part in job.model.split("/")):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "fal job endpoint is not allowed", self.provider_id)
        if not _valid_remote_id(job.request_id):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "fal job endpoint is not allowed", self.provider_id)


_UPLOAD_MIME_RE = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")


def _validate_upload_metadata(filename: str, content_type: str) -> None:
    """Validate metadata before it reaches Fal's upload-initiation endpoint."""
    if (not isinstance(filename, str) or not filename or len(filename) > 128 or
            filename in {".", ".."} or "/" in filename or "\\" in filename or
            any(ord(char) < 0x20 or ord(char) == 0x7F for char in filename)):
        raise ProviderError(ErrorCode.INVALID_REQUEST, "fal upload filename is invalid", "fal")
    if (not isinstance(content_type, str) or len(content_type) > 127 or
            not _UPLOAD_MIME_RE.fullmatch(content_type)):
        raise ProviderError(ErrorCode.INVALID_REQUEST, "fal upload content type is invalid", "fal")


def _validate_endpoint(descriptor: ProviderDescriptor, endpoint: str) -> None:
    try:
        parsed = urlsplit(endpoint)
        parsed.port
        origin = f"{parsed.scheme}://{parsed.netloc}"
    except (TypeError, ValueError) as exc:
        raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowlisted", descriptor.provider_id) from exc
    if descriptor.kind == "cloud":
        if (origin not in descriptor.origins or parsed.path not in ("", "/") or
                parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "cloud endpoint is not allowlisted", descriptor.provider_id)
    else:
        # Local providers are deliberately pinned to the descriptor's exact
        # numeric loopback origin (DNS names and arbitrary ports are not safe
        # substitutes).  A bare trailing slash is equivalent to an origin.
        if (origin not in descriptor.origins or parsed.scheme != "http" or
                parsed.hostname not in {"127.0.0.1", "::1"} or parsed.port is None or
                parsed.path or parsed.query or parsed.fragment or
                parsed.username or parsed.password):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "local provider endpoint must be loopback", descriptor.provider_id)


def _valid_remote_id(value: Any) -> bool:
    """Accept only one opaque, printable path segment returned by fal."""
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or value in {".", ".."}:
        return False
    return all(ch.isascii() and (ch.isalnum() or ch in "._~-") for ch in value)

def _fal_cdn_url(value: Any) -> bool:
    if not isinstance(value, str): return False
    try:
        parsed = urlsplit(value); port = parsed.port
    except (TypeError, ValueError):
        return False
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return (parsed.scheme == "https" and origin in {"https://fal.media", "https://v3.fal.media", "https://v3b.fal.media"} and
            parsed.hostname in {"fal.media", "v3.fal.media", "v3b.fal.media"} and port is None and
            not parsed.fragment and not parsed.username and not parsed.password and bool(parsed.path.strip("/")) and
            len(parsed.query) <= 4096 and "\\" not in parsed.path and
            not any(ord(ch) < 32 or ord(ch) == 127 for ch in parsed.geturl()) and
            all(part not in {".", ".."} for part in unquote(parsed.path).split("/")))
