"""Explicit route selection, retries, fallback consent, and budgets."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlsplit

from .descriptors import Capability, ProviderRegistry
from .errors import ErrorCode, ProviderError
from Auvra.diagnostics import trace_public_class


@dataclass(frozen=True, slots=True)
class Route:
    provider: str
    model: str
    capability: Capability
    endpoint: str | None = None


@dataclass(frozen=True, slots=True)
class RouteRequest:
    capability: Capability
    provider: str
    model: str
    endpoint: str | None = None
    allow_cross_route_fallback: bool = False


@dataclass(frozen=True, slots=True)
class RouteSelection:
    route: Route
    alternatives: tuple[Route, ...] = ()
    consent_recorded: bool = False


@dataclass(slots=True)
class Budget:
    """Integer micro-USD budget accounting for job, daily, and monthly limits."""
    max_job_cost: int = 0
    max_aggregate_cost: int = 0  # compatibility alias for aggregate lifetime cap
    aggregate_cost: int = 0
    max_daily_cost: int = 0
    max_monthly_cost: int = 0
    daily_cost: int = 0
    monthly_cost: int = 0

    def reserve(self, amount: int, *, day: str | None = None, month: str | None = None) -> None:
        if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
            raise ProviderError(ErrorCode.BUDGET_EXCEEDED, "invalid provider cost")
        if self.max_job_cost and amount > self.max_job_cost:
            raise ProviderError(ErrorCode.BUDGET_EXCEEDED, "job cost exceeds budget")
        if self.max_aggregate_cost and self.aggregate_cost + amount > self.max_aggregate_cost:
            raise ProviderError(ErrorCode.BUDGET_EXCEEDED, "aggregate provider cost exceeds budget")
        if self.max_daily_cost and self.daily_cost + amount > self.max_daily_cost:
            raise ProviderError(ErrorCode.BUDGET_EXCEEDED, "daily provider cost exceeds budget")
        if self.max_monthly_cost and self.monthly_cost + amount > self.max_monthly_cost:
            raise ProviderError(ErrorCode.BUDGET_EXCEEDED, "monthly provider cost exceeds budget")
        self.aggregate_cost += amount
        self.daily_cost += amount
        self.monthly_cost += amount


@trace_public_class("provider_route", concise=("select", "execute"))
class RoutePolicy:
    def __init__(self, registry: ProviderRegistry | None = None, *, max_retries: int = 2,
                 budget: Budget | None = None) -> None:
        if not 0 <= max_retries <= 5: raise ValueError("retry bound must be 0..5")
        self.registry = registry or ProviderRegistry()
        self.max_retries = max_retries
        self.budget = budget or Budget()

    def select(self, request: RouteRequest) -> RouteSelection:
        if not isinstance(request.capability, Capability):
            try: capability = Capability(request.capability)
            except ValueError as exc: raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "unknown capability") from exc
        else: capability = request.capability
        try: descriptor = self.registry.get(request.provider)
        except (KeyError, TypeError) as exc: raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "provider is unavailable") from exc
        if not self.registry.supports(request.provider, capability, request.model):
            raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "provider/model does not support capability", request.provider)
        if request.allow_cross_route_fallback:
            # Provider selection is explicit and immutable for one operation;
            # silently switching providers can violate locality and consent.
            raise ProviderError(ErrorCode.INVALID_REQUEST, "cross-route fallback is forbidden")
        endpoint = request.endpoint or descriptor.origins[0]
        try:
            parsed = urlsplit(endpoint); origin = f"{parsed.scheme}://{parsed.netloc}"
            # Force validation of malformed ports before making a decision.
            parsed.port
        except (TypeError, ValueError) as exc:
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "provider endpoint is not allowlisted", descriptor.provider_id) from exc
        if (descriptor.kind == "cloud" and
                (origin not in descriptor.origins or parsed.path not in {"", "/"} or
                 parsed.username or parsed.password or parsed.query or parsed.fragment)):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "cloud endpoint is not allowlisted", descriptor.provider_id)
        if (descriptor.kind == "local" and
                (origin not in descriptor.origins or parsed.scheme != "http" or
                 parsed.hostname not in {"127.0.0.1", "::1"} or parsed.port is None or
                 parsed.path or parsed.query or parsed.fragment or
                 parsed.username or parsed.password)):
            raise ProviderError(ErrorCode.ENDPOINT_NOT_ALLOWED, "local route endpoint must be loopback", descriptor.provider_id)
        route = Route(descriptor.provider_id, request.model, capability, endpoint)
        return RouteSelection(route)

    def can_retry(self, error: ProviderError, attempt: int) -> bool:
        return attempt < self.max_retries and error.retryable

    def execute(self, selection: RouteSelection, operation: Callable[[Route], object], *,
                estimated_cost: int | None = None, confirm_unknown_cost: bool = False) -> object:
        """Execute one fixed route with bounded same-route retries only."""
        if estimated_cost is None and not confirm_unknown_cost and selection.route.provider not in {"ollama", "llama.cpp"}:
            raise ProviderError(ErrorCode.BUDGET_EXCEEDED, "provider pricing is unknown; confirmation is required")
        if estimated_cost is not None: self.budget.reserve(estimated_cost)
        attempt = 0
        while True:
            try:
                return operation(selection.route)
            except ProviderError as error:
                if not self.can_retry(error, attempt): raise
                attempt += 1
