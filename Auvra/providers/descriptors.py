"""Versioned static provider descriptors and capability registry."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Iterable, Mapping
from urllib.parse import urlsplit


class Capability(StrEnum):
    TEXT = "text"
    CODE = "code"
    COMMANDS = "commands"
    MEDIA_GENERATE = "media.generate"
    MEDIA_EDIT = "media.edit"
    # Compatibility spellings are aliases, not additional routable capabilities.
    STRUCTURED_COMMAND = "commands"
    MEDIA_GENERATION = "media.generate"
    MEDIA_EDITING = "media.edit"


class ProviderFeature(StrEnum):
    STREAMING = "streaming"
    QUEUE = "queue"
    CANCEL = "cancel"
    DURABLE = "durable"
    UPLOAD = "upload"
    STRUCTURED_OUTPUT = "structured_output"


CAPABILITIES = tuple(Capability)


@dataclass(frozen=True, slots=True)
class ProviderDescriptor:
    provider_id: str
    display_name: str
    version: int
    kind: str  # cloud or local
    origins: tuple[str, ...]
    capabilities: frozenset[Capability]
    models: tuple[str, ...]
    credential_name: str | None = None
    features: frozenset[ProviderFeature] = frozenset()

    def __post_init__(self) -> None:
        if not self.provider_id or self.provider_id != self.provider_id.lower():
            raise ValueError("provider id must be lowercase and non-empty")
        if self.version < 1 or self.kind not in {"cloud", "local"}:
            raise ValueError("invalid provider descriptor")
        if not self.origins or any(not _valid_origin(origin, self.kind) for origin in self.origins):
            raise ValueError("provider origins are not allowed")
        if not self.capabilities or not self.capabilities.issubset(set(Capability)):
            raise ValueError("provider must declare capabilities")
        if any(not model or len(model) > 200 for model in self.models):
            raise ValueError("invalid provider model")

    def supports(self, capability: Capability | str, model: str | None = None) -> bool:
        try:
            capability = Capability(capability)
        except ValueError:
            return False
        return capability in self.capabilities and (model is None or model in self.models)

    @property
    def id(self) -> str:
        return self.provider_id

    @property
    def is_local(self) -> bool:
        return self.kind == "local"

    @property
    def is_cloud(self) -> bool:
        return self.kind == "cloud"


def _valid_origin(origin: str, kind: str) -> bool:
    parsed = urlsplit(origin)
    if kind == "cloud":
        return (parsed.scheme == "https" and not parsed.username and not parsed.password and
                not parsed.query and not parsed.fragment and parsed.path in {"", "/"} and bool(parsed.hostname))
    return (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1"} and
            parsed.port is not None and not parsed.username and not parsed.password and
            not parsed.fragment and not parsed.query)


_DESCRIPTORS = (
    ProviderDescriptor("fal", "fal.ai", 1, "cloud", ("https://queue.fal.run", "https://rest.fal.ai"),
                       frozenset({Capability.MEDIA_GENERATE, Capability.MEDIA_EDIT}),
                       ("fal-ai/flux/dev", "fal-ai/flux/dev/image-to-image"), "fal_api_key",
                       frozenset({ProviderFeature.QUEUE, ProviderFeature.CANCEL, ProviderFeature.DURABLE, ProviderFeature.UPLOAD})),
    ProviderDescriptor("openai", "OpenAI", 1, "cloud", ("https://api.openai.com",),
                       frozenset({Capability.TEXT, Capability.CODE, Capability.COMMANDS}),
                       (), "openai_api_key",
                       frozenset({ProviderFeature.STREAMING, ProviderFeature.STRUCTURED_OUTPUT})),
    ProviderDescriptor("anthropic", "Anthropic", 1, "cloud", ("https://api.anthropic.com",),
                       frozenset({Capability.TEXT, Capability.CODE, Capability.COMMANDS}),
                       (), "anthropic_api_key",
                       frozenset({ProviderFeature.STREAMING, ProviderFeature.STRUCTURED_OUTPUT})),
    ProviderDescriptor("xai", "xAI", 1, "cloud", ("https://api.x.ai",),
                       frozenset({Capability.TEXT, Capability.CODE, Capability.COMMANDS}),
                       (), "xai_api_key",
                       frozenset({ProviderFeature.STREAMING, ProviderFeature.STRUCTURED_OUTPUT})),
    ProviderDescriptor("openrouter", "OpenRouter", 1, "cloud", ("https://openrouter.ai",),
                       frozenset({Capability.TEXT, Capability.CODE, Capability.COMMANDS}),
                       (), "openrouter_api_key",
                       frozenset({ProviderFeature.STREAMING, ProviderFeature.STRUCTURED_OUTPUT})),
    ProviderDescriptor("ollama", "Ollama", 1, "local", ("http://127.0.0.1:11434",),
                       frozenset({Capability.TEXT, Capability.CODE, Capability.COMMANDS}),
                       (), None,
                       frozenset({ProviderFeature.STREAMING, ProviderFeature.STRUCTURED_OUTPUT})),
    ProviderDescriptor("llama.cpp", "llama.cpp", 1, "local", ("http://127.0.0.1:8080",),
                       frozenset({Capability.TEXT, Capability.CODE, Capability.COMMANDS}),
                       (), None,
                       frozenset({ProviderFeature.STREAMING, ProviderFeature.STRUCTURED_OUTPUT})),
)


PROVIDER_REGISTRY = MappingProxyType({descriptor.provider_id: descriptor for descriptor in _DESCRIPTORS})
PROVIDERS = PROVIDER_REGISTRY


class ProviderRegistry:
    """Read-only registry; descriptors cannot be added from project content."""

    def __init__(self, descriptors: Iterable[ProviderDescriptor] | None = None) -> None:
        values = tuple(descriptors or _DESCRIPTORS)
        self._values = MappingProxyType({item.provider_id: item for item in values})
        self._discovered: dict[str, frozenset[str]] = {}

    def get(self, provider_id: str) -> ProviderDescriptor:
        try:
            return self._values[provider_id]
        except KeyError as exc:
            raise KeyError(f"unknown provider: {provider_id}") from exc

    get_descriptor = get

    def __contains__(self, provider_id: str) -> bool:
        return provider_id in self._values

    def all(self) -> tuple[ProviderDescriptor, ...]:
        return tuple(self._values.values())

    @property
    def descriptors(self) -> tuple[ProviderDescriptor, ...]:
        return self.all()

    def discover_models(self, provider_id: str, models: Iterable[str]) -> tuple[str, ...]:
        self.get(provider_id)
        checked = frozenset(model for model in models if isinstance(model, str) and 0 < len(model) <= 200)
        self._discovered[provider_id] = checked
        return tuple(sorted(checked))

    def models(self, provider_id: str) -> tuple[str, ...]:
        descriptor = self.get(provider_id)
        return tuple(sorted(set(descriptor.models) | self._discovered.get(provider_id, frozenset())))

    def supports(self, provider_id: str, capability: Capability | str, model: str) -> bool:
        descriptor = self.get(provider_id)
        return descriptor.supports(capability) and model in self.models(provider_id)
