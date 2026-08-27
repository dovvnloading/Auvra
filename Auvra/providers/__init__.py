"""Host-owned, provider-neutral inference primitives.

The package intentionally has no provider SDK dependencies.  Adapters receive
an injected transport and credentials are never part of request or durable-job
objects.
"""

from .adapters import (
    AnthropicAdapter, FalAdapter, LlamaCppAdapter, OllamaAdapter,
    OpenAIAdapter, OpenRouterAdapter, TextAdapter, XAIAdapter,
)
from .commands import COMMAND_JSON_SCHEMA, CommandProposal, CommandValidationError, validate_command, validate_update
from .credentials import CredentialError, CredentialVault, MemoryCredentialStore, SessionCredentialStore, WindowsCredentialManager
from .descriptors import CAPABILITIES, PROVIDER_REGISTRY, PROVIDERS, Capability, ProviderDescriptor, ProviderFeature, ProviderRegistry
from .errors import ErrorCode, ProviderError, normalize_error
from .jobs import DurableJobStore, Job, JobEvent, JobState, SQLiteJobStore
from .media import MediaArtifact, MediaDownloader, MediaPreviewStore
from .settings import ProviderSettings, ProviderSettingsStore
from .routing import Budget, Route, RoutePolicy, RouteRequest, RouteSelection
from .transport import BoundedTransport, HttpRequest, HttpResponse, HttpTransport, SseEvent, StandardHttpTransport, StdlibTransport, parse_ndjson, parse_sse

__all__ = [
    "AnthropicAdapter", "BoundedTransport", "Budget", "CAPABILITIES",
    "Capability", "COMMAND_JSON_SCHEMA", "CommandProposal", "CommandValidationError",
    "CredentialError", "CredentialVault", "DurableJobStore", "ErrorCode", "FalAdapter",
    "HttpRequest", "HttpResponse", "Job", "JobEvent", "JobState",
    "LlamaCppAdapter", "MediaArtifact", "MediaDownloader", "MediaPreviewStore", "MemoryCredentialStore", "OllamaAdapter",
    "OpenAIAdapter", "OpenRouterAdapter", "PROVIDER_REGISTRY",
    "ProviderDescriptor", "ProviderError", "ProviderFeature", "ProviderRegistry", "PROVIDERS", "ProviderSettings", "ProviderSettingsStore", "Route",
    "RoutePolicy", "RouteRequest", "RouteSelection", "SQLiteJobStore",
    "SessionCredentialStore", "SseEvent", "StandardHttpTransport", "StdlibTransport", "HttpTransport", "TextAdapter", "WindowsCredentialManager", "XAIAdapter",
    "normalize_error", "parse_ndjson", "parse_sse", "validate_command", "validate_update",
]
