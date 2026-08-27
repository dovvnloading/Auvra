"""Host-owned provider service bound to the versioned dispatcher.

This module is deliberately the only desktop composition point that knows
about provider adapters, credentials, durable jobs, and generated previews.
The dispatcher receives only bounded dictionaries produced here.
"""

from __future__ import annotations

import hashlib
import json
import copy
import os
from pathlib import Path
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Mapping

from Auvra.host.dispatcher import HostOperationError
from Auvra.providers import (
    AnthropicAdapter, Capability, CommandProposal, FalAdapter,
    LlamaCppAdapter, OllamaAdapter, OpenAIAdapter, OpenRouterAdapter,
    ProviderError, ProviderRegistry, ProviderSettingsStore, RoutePolicy,
    RouteRequest, SQLiteJobStore, XAIAdapter, validate_command, validate_update,
)
from Auvra.providers.adapters import MediaJob
from Auvra.providers.credentials import MemoryCredentialStore, WindowsCredentialManager
from Auvra.providers.transport import StdlibTransport

from .credential_prompt import CredentialPromptUnavailableError, WinFormsCredentialPrompt


_ADAPTERS = {
    "openai": OpenAIAdapter,
    "anthropic": AnthropicAdapter,
    "xai": XAIAdapter,
    "openrouter": OpenRouterAdapter,
    "ollama": OllamaAdapter,
    "llama.cpp": LlamaCppAdapter,
    "fal": FalAdapter,
}
_PROVIDER_ERRORS = {
    "unsupported_capability": "unsupported_capability",
    "credential_unavailable": "credential_unavailable",
    "endpoint_not_allowed": "endpoint_denied",
    "cancelled": "cancelled",
    "budget_exceeded": "budget_exceeded",
    "authentication": "provider_authentication",
    "authorization": "provider_authorization",
    "rate_limited": "provider_rate_limited",
    "timeout": "provider_timeout",
    "network": "provider_network",
    "remote": "provider_invalid_response",
    "not_found": "provider_not_found",
    "invalid_request": "invalid_request",
}


def _assert_state_path_safe(path: Path) -> None:
    """Reject symlink/junction redirection before creating host state."""
    path = Path(path).expanduser().absolute()
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            stat_result = os.lstat(current)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise OSError("provider state path cannot be inspected") from exc
        # lstat, unlike Path.stat, examines the link/junction itself.  Windows
        # junctions and other reparse points must not be allowed to redirect
        # the durable provider databases.
        if current.is_symlink() or getattr(stat_result, "st_file_attributes", 0) & 0x400:
            raise OSError("provider state path cannot contain links")


class NativeProviderHost:
    """Implement provider protocol methods without exposing provider authority."""

    def __init__(
        self,
        state_root: Path,
        *,
        project_host: Any,
        preview_store: Any = None,
        registry: ProviderRegistry | None = None,
        credential_prompt: Any = None,
        transports: Mapping[str, Any] | None = None,
        adapters: Mapping[str, Any] | None = None,
        executor: ThreadPoolExecutor | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.state_root = Path(state_root).expanduser().absolute()
        _assert_state_path_safe(self.state_root)
        self.state_root.mkdir(parents=True, exist_ok=True)
        _assert_state_path_safe(self.state_root)
        self.project_host = project_host
        self.preview_store = preview_store
        self.registry = registry or ProviderRegistry()
        settings_db = self.state_root / "provider-settings.sqlite3"
        jobs_db = self.state_root / "provider-jobs.sqlite3"
        # Validate the exact database files as well as their parent.  A
        # reparse-point database would otherwise redirect durable state after
        # the directory check has passed.
        _assert_state_path_safe(settings_db)
        _assert_state_path_safe(jobs_db)
        self.settings = ProviderSettingsStore(str(settings_db), registry=self.registry)
        self.jobs = SQLiteJobStore(str(jobs_db), registry=self.registry)
        # Route selection is intentionally stateless.  Cost caps live in each
        # provider's durable settings row, never in a process-global budget.
        self.route_policy = RoutePolicy(self.registry)
        self.prompt = credential_prompt or WinFormsCredentialPrompt()
        self.transports = dict(transports or {})
        self._adapters = dict(adapters or {})
        self._executor = executor or ThreadPoolExecutor(max_workers=2, thread_name_prefix="auvra-provider")
        self._owns_executor = executor is None
        self._futures: dict[str, Future[Any]] = {}
        self._meta: dict[str, dict[str, Any]] = {}
        self._events: list[tuple[str, dict[str, Any]]] = []
        self._memory: dict[str, MemoryCredentialStore] = {}
        self._vault: Any = None
        self._last_transaction: dict[str, Any] | None = None
        self._provided_adapters = frozenset(self._adapters)
        self._lock = threading.RLock()
        self._closed = False
        self._now = now
        self._initialize_vault()
        self._restore_configured_models()
        self._recover_restart_jobs()

    def _initialize_vault(self) -> None:
        """Initialize and probe the OS vault before serving provider calls.

        Failure means the OS vault is unavailable; it must never silently
        switch to a file-backed credential store.
        """
        try:
            self._vault = WindowsCredentialManager()
        except Exception:
            self._vault = None
            return
        for descriptor in self.registry.all():
            if descriptor.credential_name:
                try:
                    self._vault.read(descriptor.credential_name)
                except Exception:
                    self._vault = None
                    return

    def _restore_configured_models(self) -> None:
        for descriptor in self.registry.all():
            configured = self.settings.get(descriptor.provider_id)
            if configured.routes:
                self.registry.discover_models(descriptor.provider_id, configured.routes.values())

    def handle(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "provider.list": self._provider_list,
            "provider.getStatus": self._provider_status,
            "provider.configureCredential": self._configure_credential,
            "provider.deleteCredential": self._delete_credential,
            "provider.configure": self._configure,
            "provider.listModels": self._list_models,
            "provider.health": self._health,
            "inference.submit": self._submit,
            "inference.get": self._get_job,
            "inference.list": self._list_jobs,
            "inference.cancel": self._cancel,
            "inference.retry": self._retry,
            "media.discard": self._discard,
            "media.commit": self._commit_media,
            "command.preview": self._preview_command,
            "command.approve": self._approve_command,
            "command.undo": self._undo_command,
        }
        handler = handlers.get(method)
        if handler is None:
            raise HostOperationError("unknown_method", "Unknown provider method")
        try:
            return handler(payload)
        except HostOperationError:
            raise
        except ProviderError as exc:
            raise self._map_error(exc) from None
        except (KeyError, TypeError, ValueError) as exc:
            raise HostOperationError("invalid_request", "Provider request is invalid") from exc

    def drain_events(self) -> list[tuple[str, dict[str, Any]]]:
        with self._lock:
            events, self._events = self._events, []
        return events

    def tick(self) -> None:
        """Advance adapter polling hooks without blocking the UI thread."""
        with self._lock:
            if self._closed:
                return
            for job_id, future in list(self._futures.items()):
                if future.done():
                    self._futures.pop(job_id, None)

    def _recover_restart_jobs(self) -> None:
        """Reconcile durable Fal requests after a process restart."""
        try:
            pending = self.jobs.reconcile_restart()
        except Exception:
            return
        for job in pending:
            if job.provider != "fal" or not job.remote_id:
                continue
            self._meta[job.job_id] = {
                "projectId": getattr(job, "project_id", None), "prompt": "", "assetIds": [], "route": "cloud",
                "providerId": job.provider, "modelId": job.model, "capability": job.capability,
                "settingsHash": self._settings_hash(self.settings.get(job.provider)), "createdAt": job.created_at,
                "promptHash": job.prompt_hash, "projectRevision": 0,
            }
            with self._lock:
                self._queue("provider.recovery", {"providerId": job.provider, "jobId": job.job_id, "status": "recovering", "progress": None, "attempt": job.attempt, "retryable": True})
                self._futures[job.job_id] = self._executor.submit(self._recover_fal_job, job.job_id)

    def _recover_fal_job(self, job_id: str) -> None:
        try:
            job = self.jobs.get(job_id)
            adapter = self._adapter("fal")
            remote = MediaJob("fal", job.model, job.remote_id or "")
            self.jobs.transition(job_id, "running")
            for _ in range(120):
                state = adapter.status_state(adapter.status(remote))
                if state == "succeeded":
                    self._ingest_media(job_id, adapter.result(remote), adapter, self._meta[job_id])
                    self.jobs.transition(job_id, "succeeded", artifact_hash=self._meta[job_id].get("artifactHash"))
                    self._queue_job_event(job_id, "succeeded", 1, self.registry.get("fal"))
                    return
                if state in {"failed", "cancelled"}:
                    raise ProviderError("remote", "durable media request failed", "fal")
                time.sleep(0.05)
            raise ProviderError("timeout", "durable media request timed out", "fal")
        except Exception as exc:
            try:
                error = exc if isinstance(exc, ProviderError) else ProviderError("internal", "provider recovery failed", "fal")
                self.jobs.transition(job_id, "failed", message="provider recovery failed")
                self._queue_job_event(job_id, "failed", None, self.registry.get("fal"), message=self._map_error(error).code)
            except Exception:
                pass

    def shutdown(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            futures = tuple(self._futures.values())
            self._futures.clear()
        for future in futures:
            future.cancel()
        for future in futures:
            try:
                future.result(timeout=5)
            except Exception:
                pass
        if self._owns_executor:
            self._executor.shutdown(wait=True, cancel_futures=True)
        for store in self._memory.values():
            store.clear()
        self._memory.clear()
        try:
            self.jobs.close()
        finally:
            self.settings.close()

    def _provider_list(self, _payload: dict[str, Any]) -> dict[str, Any]:
        values = []
        for descriptor in self.registry.all():
            values.append({
                "providerId": descriptor.provider_id,
                "displayName": descriptor.display_name,
                "route": descriptor.kind,
                "capabilities": sorted(cap.value for cap in descriptor.capabilities),
                "features": sorted(feature.value for feature in descriptor.features),
                "requiresCredential": bool(descriptor.credential_name),
                "configured": self._credential_status(descriptor.provider_id) in {"configured", "memoryOnly"},
                "available": True,
            })
        return {"kind": "provider.list", "providers": values}

    def _provider_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        descriptor = self.registry.get(payload["providerId"])
        settings = self.settings.get(descriptor.provider_id)
        credential = self._credential_status(descriptor.provider_id)
        configured = credential in {"configured", "memoryOnly", "notRequired"}
        return {"kind": "provider.status", "providerId": descriptor.provider_id,
                "configured": configured, "available": True,
                "healthy": configured, "state": "ready" if configured else "unconfigured",
                "settings": self._settings_value(settings), "settingsRevision": settings.revision,
                "credentialStatus": credential}

    def _configure_credential(self, payload: dict[str, Any]) -> dict[str, Any]:
        descriptor = self.registry.get(payload["providerId"])
        if not descriptor.credential_name:
            return {"kind": "provider.credential", "providerId": descriptor.provider_id,
                    "storageMode": payload["storageMode"], "configured": True,
                    "credentialStatus": "notRequired"}
        mode = payload["storageMode"]
        store: Any
        if mode == "memoryOnly":
            store = self._memory.setdefault(descriptor.provider_id, MemoryCredentialStore())
        elif mode == "osVault":
            try:
                if self._vault is None:
                    self._vault = WindowsCredentialManager()
                store = self._vault
            except Exception as exc:
                raise HostOperationError("credential_unavailable", "Operating-system credential storage is unavailable") from exc
        else:
            raise HostOperationError("invalid_request", "Credential storage mode is invalid")
        try:
            value = self.prompt.prompt(descriptor.display_name)
        except CredentialPromptUnavailableError as exc:
            raise HostOperationError("credential_unavailable", "Native credential entry is unavailable") from exc
        if value is None:
            raise HostOperationError("cancelled", "Credential entry was cancelled")
        try:
            store.write(descriptor.credential_name, value)
        except Exception as exc:
            raise HostOperationError("credential_unavailable", "Credential storage failed") from exc
        finally:
            value = ""
        if descriptor.provider_id not in self._provided_adapters:
            self._adapters.pop(descriptor.provider_id, None)
        return {"kind": "provider.credential", "providerId": descriptor.provider_id,
                "storageMode": mode, "configured": True, "credentialStatus": self._credential_status(descriptor.provider_id)}

    def _delete_credential(self, payload: dict[str, Any]) -> dict[str, Any]:
        descriptor = self.registry.get(payload["providerId"])
        if not descriptor.credential_name:
            return self._provider_status(payload)
        for store in tuple(filter(None, (self._memory.get(descriptor.provider_id), self._vault))):
            try:
                store.delete(descriptor.credential_name)
            except Exception as exc:
                raise HostOperationError("credential_unavailable", "Credential removal failed") from exc
        if descriptor.provider_id not in self._provided_adapters:
            self._adapters.pop(descriptor.provider_id, None)
        return self._provider_status(payload)

    def _configure(self, payload: dict[str, Any]) -> dict[str, Any]:
        descriptor = self.registry.get(payload["providerId"])
        current = self.settings.get(descriptor.provider_id)
        if payload["expectedSettingsRevision"] != current.revision:
            raise HostOperationError("revision_conflict", "Provider settings revision does not match")
        settings = payload["settings"]
        if set(settings) - {"enabled", "routes", "fallbackPolicy", "requireCostConfirmation", "budgets", "endpoint"}:
            raise HostOperationError("invalid_request", "Provider settings contain unsupported fields")
        if not isinstance(settings.get("enabled"), bool) or not isinstance(settings.get("routes"), list):
            raise HostOperationError("invalid_request", "Provider settings are invalid")
        if settings.get("fallbackPolicy") != "none":
            raise HostOperationError("invalid_request", "Provider fallback policy is invalid")
        if not isinstance(settings.get("requireCostConfirmation"), bool):
            raise HostOperationError("invalid_request", "Provider cost confirmation setting is invalid")
        budgets = settings.get("budgets")
        if not isinstance(budgets, dict) or set(budgets) != {"perJobMicroUsd", "dailyMicroUsd", "monthlyMicroUsd"}:
            raise HostOperationError("invalid_request", "Provider budgets are invalid")
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in budgets.values()):
            raise HostOperationError("invalid_request", "Provider budgets are invalid")
        routes = settings["routes"]
        if any(not isinstance(item, dict) or set(item) != {"capability", "modelId"} for item in routes):
            raise HostOperationError("invalid_request", "Provider routes are invalid")
        if len({(item["capability"], item["modelId"]) for item in routes}) != len(routes):
            raise HostOperationError("invalid_request", "Provider routes must be unique")
        route_map: dict[str, str] = {}
        for item in routes:
            capability = Capability(item["capability"])
            model_id = item["modelId"]
            if capability.value in route_map:
                raise HostOperationError("invalid_request", "Provider routes must be unique")
            route_map[capability.value] = model_id
            self.route_policy.select(RouteRequest(capability, descriptor.provider_id, model_id, settings.get("endpoint")))
        for capability in route_map if settings["enabled"] else ():
            for other in self.registry.all():
                if other.provider_id == descriptor.provider_id:
                    continue
                other_settings = self.settings.get(other.provider_id)
                if other_settings.enabled and other_settings.routes.get(capability) is not None:
                    raise HostOperationError("invalid_request", f"Capability {capability} is already routed by another enabled provider")
        endpoint = settings.get("endpoint")
        if endpoint is not None and not isinstance(endpoint, str):
            raise HostOperationError("invalid_request", "Provider endpoint is invalid")
        updated = self.settings.set(
            descriptor.provider_id, enabled=settings["enabled"], routes=route_map,
            endpoint=endpoint, require_cost_confirmation=settings["requireCostConfirmation"],
            max_job_cost_micro_usd=budgets["perJobMicroUsd"], max_daily_cost_micro_usd=budgets["dailyMicroUsd"],
            max_monthly_cost_micro_usd=budgets["monthlyMicroUsd"], expected_revision=current.revision)
        if descriptor.provider_id not in self._provided_adapters:
            self._adapters.pop(descriptor.provider_id, None)
        return self._provider_status({"providerId": descriptor.provider_id}) | {"settingsRevision": updated.revision}

    def _list_models(self, payload: dict[str, Any]) -> dict[str, Any]:
        descriptor = self.registry.get(payload["providerId"])
        if descriptor.provider_id in self.transports or descriptor.provider_id in self._adapters:
            models = self._adapter(descriptor.provider_id).list_models()
            self.registry.discover_models(descriptor.provider_id, models)
        else:
            models = self.registry.models(descriptor.provider_id)
        capability = payload.get("capability")
        return {"kind": "provider.models", "providerId": descriptor.provider_id, "models":[
            {"modelId": model, "displayName": model, "capabilities": sorted(cap.value for cap in descriptor.capabilities if capability is None or cap.value == capability)}
            for model in models if capability is None or self.registry.supports(descriptor.provider_id, capability, model)
        ]}

    def _health(self, payload: dict[str, Any]) -> dict[str, Any]:
        descriptor = self.registry.get(payload["providerId"])
        started = time.monotonic()
        healthy = False
        if descriptor.provider_id == "fal":
            # fal.ai has no generic /status endpoint.  A local health probe
            # must not manufacture one; credential availability is the safe
            # host-level health signal until a real request is reconciled.
            healthy = self._credential_status(descriptor.provider_id) in {"configured", "memoryOnly"}
        elif descriptor.kind == "local" and descriptor.provider_id not in self.transports and descriptor.provider_id not in self._adapters:
            healthy = False
        else:
            healthy = bool(self._adapter(descriptor.provider_id).health())
        return {"kind": "provider.health", "providerId": descriptor.provider_id, "healthy": healthy,
                "latencyMs": int((time.monotonic() - started) * 1000), "message": "healthy" if healthy else "unavailable"}

    def _submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require_project(payload, expected=True)
        descriptor = self.registry.get(payload["providerId"])
        capability = Capability(payload["capability"])
        if payload.get("route") != descriptor.kind:
            raise HostOperationError("endpoint_denied", "Provider route does not match explicit request")
        configured = self.settings.get(descriptor.provider_id)
        if not configured.enabled or configured.routes.get(capability.value) != payload["modelId"]:
            raise HostOperationError("unsupported_capability", "Provider route is not configured")
        selection = self.route_policy.select(RouteRequest(capability, descriptor.provider_id, payload["modelId"], configured.endpoint))
        if selection.route.provider != descriptor.provider_id or selection.route.model != payload["modelId"]:
            raise HostOperationError("unsupported_capability", "Provider route is not exact")
        if descriptor.kind == "cloud" and self._credential_status(descriptor.provider_id) not in {"configured", "memoryOnly"}:
            raise HostOperationError("provider_not_configured", "Provider credential is not configured")
        if (descriptor.kind == "cloud" and
                (configured.require_cost_confirmation or payload.get("estimatedCostMicroUsd") is None) and
                payload.get("consent") != "explicit"):
            raise HostOperationError("budget_exceeded", "Cloud provider cost requires explicit confirmation")
        prompt = payload.get("input", "")
        if not isinstance(prompt, str) or len(prompt) > 65536:
            raise HostOperationError("invalid_request", "Inference input is invalid")
        target = payload.get("targetElementId")
        if target is not None and (capability != Capability.COMMANDS or not isinstance(target, str) or not 1 <= len(target) <= 128):
            raise HostOperationError("invalid_request", "Command target is invalid")
        selected = None
        if capability == Capability.COMMANDS:
            hud = self.project_host.service.active.get_domain("hud")
            main = next((item for item in hud.get("documents", []) if isinstance(item, dict) and item.get("id") == "hud-main"), None)
            if main is None:
                raise HostOperationError("invalid_command", "Canonical hud-main document is unavailable")
            elements = [item for item in main.get("elements", []) if isinstance(item, dict)]
            if (len({item.get("id") for item in elements}) != len(elements) or
                    len({item.get("name") for item in elements}) != len(elements)):
                raise HostOperationError("invalid_command", "HUD element identities collide")
            selected = None if target is None else next((item for item in elements if item.get("id") == target), None)
            if target is not None and selected is None:
                raise HostOperationError("invalid_command", "Command target is unavailable")
            context = json.dumps({"targetElementId": target, "elements": elements}, sort_keys=True, separators=(",", ":"))
            prompt = (prompt + "\n\nHUD context:\n" + context)[:65536]
        prompt_hash = hashlib.sha256(prompt.encode()).hexdigest()
        asset_ids = payload.get("assetIds", [])
        if not isinstance(asset_ids, list) or len(asset_ids) > 16 or any(not isinstance(item, str) or len(item) != 64 for item in asset_ids):
            raise HostOperationError("invalid_request", "Inference assets are invalid")
        if len(set(asset_ids)) != len(asset_ids) or any(any(ch not in "0123456789abcdef" for ch in item) for item in asset_ids):
            raise HostOperationError("invalid_request", "Inference assets are invalid")
        for asset_id in asset_ids:
            resolver = getattr(self.project_host.service, "resolve_reference", None)
            if callable(resolver):
                resolver(asset_id, project_id=active.project_id)
        with self._lock:
            estimated_cost = self._check_budget(descriptor.provider_id, configured, payload.get("estimatedCostMicroUsd"))
            job = self.jobs.create(provider=descriptor.provider_id, model=payload["modelId"], capability=capability.value, prompt_hash=prompt_hash,
                                   project_id=active.project_id, cost_micro_usd=estimated_cost,
                                   provenance={"route": descriptor.kind, "provider": descriptor.provider_id, "model": payload["modelId"], "capability": capability.value})
            self._meta[job.job_id] = {"projectId": active.project_id, "prompt": prompt, "assetIds": asset_ids, "route": descriptor.kind,
                                       "providerId": descriptor.provider_id, "modelId": payload["modelId"], "capability": capability.value,
                                       "settingsHash": self._settings_hash(configured), "createdAt": self._now(), "promptHash": prompt_hash,
                                       "estimatedCostMicroUsd": estimated_cost,
                                       "projectRevision": active.revision, "targetElementId": target,
                                       "targetElementName": selected.get("name") if selected is not None else None}
            self._queue_job_event(job.job_id, "queued", 0, descriptor)
            self._futures[job.job_id] = self._executor.submit(self._run_job, job.job_id, descriptor.provider_id, payload["modelId"], capability)
        return {"kind": "inference.submit", "job": self._job_value(job.job_id)}

    def _get_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_job_project(payload)
        return {"kind": "inference.get", "job": self._job_value(payload["jobId"])}

    def _list_jobs(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require_project(payload)
        values = [self._job_value(job.job_id) for job in self.jobs.list(project_id=active.project_id)]
        if payload.get("status"):
            values = [value for value in values if value["status"] == payload["status"]]
        limit = min(int(payload.get("limit", 100)), 100)
        try:
            offset = int(payload.get("cursor", "0") or 0)
        except (TypeError, ValueError) as exc:
            raise HostOperationError("invalid_request", "Inference cursor is invalid") from exc
        if offset < 0:
            raise HostOperationError("invalid_request", "Inference cursor is invalid")
        page = values[offset:offset + limit]
        next_offset = offset + len(page)
        return {"kind": "inference.list", "jobs": page, "cursor": str(next_offset) if next_offset < len(values) else "", "hasMore": next_offset < len(values)}

    def _cancel(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require_project(payload)
        job = self._require_job_project(payload)
        if job.state.value in {"succeeded", "failed", "cancelled"}:
            return {"kind": "inference.cancel", "job": self._job_value(job.job_id)}
        # A remote HTTP 202 acknowledges the request only.  Keep the durable
        # state cancel_requested until a later remote reconciliation confirms
        # cancellation.
        job = self.jobs.request_cancel(job.job_id, project_id=active.project_id)
        if job.remote_id and job.provider == "fal" and job.state.value in {"submitting", "running", "cancel_requested", "recovering"}:
            try:
                self._adapter("fal").cancel(MediaJob("fal", job.model, job.remote_id))
            except ProviderError as exc:
                raise self._map_error(exc) from None
        self._queue_job_event(job.job_id, job.state.value, None, self.registry.get(job.provider))
        return {"kind": "inference.cancel", "job": self._job_value(job.job_id)}

    def _retry(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            active = self._require_project(payload, expected=True)
            existing = self._require_job_project(payload)
            meta = self._meta.get(existing.job_id)
            if meta is None:
                raise HostOperationError("invalid_job", "Job recovery metadata is unavailable")
            configured = self.settings.get(existing.provider)
            retry_cost = self._check_budget(existing.provider, configured, meta.get("estimatedCostMicroUsd"))
            job = self.jobs.retry(payload["jobId"], project_id=active.project_id)
            if retry_cost:
                job = self.jobs.add_cost(job.job_id, retry_cost, project_id=active.project_id)
            descriptor = self.registry.get(job.provider)
            capability = Capability(job.capability)
            self._futures[job.job_id] = self._executor.submit(self._run_job, job.job_id, job.provider, job.model, capability)
            self._queue_job_event(job.job_id, "queued", 0, descriptor)
        return {"kind": "inference.retry", "job": self._job_value(job.job_id)}

    def _discard(self, payload: dict[str, Any]) -> dict[str, Any]:
        job = self._require_job_project(payload)
        preview = self.preview_store.get(job.job_id, payload["previewAssetId"]) if self.preview_store is not None else None
        if preview is None:
            raise HostOperationError("invalid_job", "Generated preview is unavailable")
        self.preview_store.discard(job.job_id, preview.asset_id)
        return {"kind": "media.discard", "projectId": payload["projectId"], "jobId": job.job_id,
                "previewAssetId": payload["previewAssetId"], "projectRevision": self._project_revision(payload["projectId"])}

    def _commit_media(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require_project(payload, expected=True)
        job = self._require_job_project(payload)
        if job.state.value != "succeeded" or job.capability not in {Capability.MEDIA_GENERATE.value, Capability.MEDIA_EDIT.value}:
            raise HostOperationError("invalid_job", "Media job is not complete")
        meta = self._meta.get(job.job_id, {})
        preview = self.preview_store.get(job.job_id, payload["previewAssetId"]) if self.preview_store is not None else None
        if preview is None:
            raise HostOperationError("invalid_job", "Generated preview is unavailable")
        with self.preview_store.open(preview.asset_id) as stream:
            reference = self.project_host.service.begin_upload(stream, project_id=active.project_id, size=preview.size, mime=preview.mime, name=payload["name"])
        generation = {
            "providerId": job.provider, "modelId": job.model, "jobId": job.job_id,
            "createdAt": meta.get("createdAt", self._now()),
            "routeOrigin": meta.get("route", "cloud"), "routeConsent": "explicit",
            "promptSha256": job.prompt_hash, "settingsSha256": meta.get("settingsHash", self._settings_hash(self.settings.get(job.provider))),
            "artifactSha256": reference.asset_id, "inputAssetIds": meta.get("assetIds", []),
        }
        if isinstance(meta.get("modelVersion"), str):
            generation["modelVersion"] = meta["modelVersion"]
        if isinstance(meta.get("seed"), int) and not isinstance(meta.get("seed"), bool):
            generation["seed"] = meta["seed"]
        if isinstance(meta.get("costMicroUsd"), int) and not isinstance(meta.get("costMicroUsd"), bool):
            generation["costMicroUsd"] = meta["costMicroUsd"]
        texture = {"id": payload["textureId"], "name": payload["name"], "assetId": reference.asset_id, "dimensions": {"width": preview.width, "height": preview.height}, "generation": generation}
        # apply_changes expects document records, not a replacement domain
        # singleton.  Merge the generated record into the complete canonical
        # textures document, replacing only a matching texture identity.
        texture_domain = self.project_host.service.active.get_domain("textures")
        texture_documents = copy.deepcopy(list(texture_domain.get("documents", [])))
        texture_index = next((index for index, item in enumerate(texture_documents)
                              if isinstance(item, dict) and item.get("id") == payload["textureId"]), None)
        if texture_index is None:
            texture_documents.append(texture)
        else:
            texture_documents[texture_index] = texture
        changes: dict[str, list[dict[str, Any]]] = {"textures": texture_documents}
        if payload.get("materialName"):
            if not isinstance(payload["materialName"], str) or not 1 <= len(payload["materialName"]) <= 256:
                raise HostOperationError("invalid_request", "Material name is invalid")
            target_model_id = payload.get("targetModelId")
            if not isinstance(target_model_id, str):
                raise HostOperationError("invalid_request", "Target model is required for a texture override")
            model_domain = self.project_host.service.active.get_domain("models")
            model_documents = copy.deepcopy(list(model_domain.get("documents", [])))
            model_index = next((index for index, item in enumerate(model_documents)
                                if isinstance(item, dict) and item.get("id") == target_model_id), None)
            if model_index is None:
                raise HostOperationError("invalid_project", "Target model is unavailable")
            model = dict(model_documents[model_index]); overrides = dict(model.get("textureOverrides", {})); overrides[payload["materialName"]] = payload["textureId"]; model["textureOverrides"] = overrides
            model_documents[model_index] = model
            # Keep every model record and only update the selected model.
            changes["models"] = model_documents
        status = self.project_host.service.apply_changes(changes, project_id=active.project_id, expected_revision=payload["expectedRevision"])
        self.preview_store.discard(job.job_id, preview.asset_id)
        return {"kind": "media.commit", "projectId": active.project_id, "jobId": job.job_id, "previewAssetId": preview.asset_id, "projectRevision": status.revision, "assetId": reference.asset_id, "provenance": generation}

    def _preview_command(self, payload: dict[str, Any]) -> dict[str, Any]:
        if "changes" in payload or "document" in payload:
            raise HostOperationError("invalid_request", "Command proposals are host-owned")
        active = self._require_project(payload, expected=True)
        job = self._require_job_project(payload)
        if job.state.value != "succeeded" or not self._meta.get(job.job_id, {}).get("proposal"):
            raise HostOperationError("invalid_job", "Completed job has no command proposal")
        if self._meta[job.job_id].get("projectId") != active.project_id:
            raise HostOperationError("invalid_project", "Job does not belong to the open project")
        proposal: CommandProposal = self._meta[job.job_id]["proposal"]
        if proposal.base_revision != active.revision:
            raise HostOperationError("revision_conflict", "Command proposal is stale")
        proposal_id = proposal.proposal_id
        diff = []
        for command in proposal.commands:
            if command["op"] == "create":
                name = command["element"]["name"]
                summary = f"create HUD element {name}"
                operation = "upsert"
            else:
                name = command["name"]
                summary = f"{command['op']} HUD element {name}"
                operation = "remove" if command["op"] == "delete" else "upsert"
            diff.append({"domain": "hud", "documentId": "hud-main", "operation": operation, "summary": summary[:256]})
        self._meta[job.job_id]["proposalId"] = proposal_id
        return {"kind": "command.preview", "projectId": payload["projectId"], "projectRevision": active.revision, "proposalId": proposal_id, "diff": diff}

    def _approve_command(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require_project(payload, expected=True)
        source = next((meta for meta in self._meta.values() if meta.get("proposalId") == payload["proposalId"]), None)
        if source is None or "proposal" not in source:
            raise HostOperationError("approval_required", "Command proposal is unavailable")
        if source.get("projectId") != active.project_id or source.get("projectRevision") != payload["expectedRevision"]:
            raise HostOperationError("revision_conflict", "Command proposal is stale")
        source_job_id = next((job_id for job_id, meta in self._meta.items() if meta is source), None)
        if source_job_id is None:
            raise HostOperationError("approval_required", "Command proposal is unavailable")
        try:
            source_job = self.jobs.get(source_job_id, project_id=active.project_id)
        except KeyError:
            raise HostOperationError("invalid_project", "Job does not belong to the open project") from None
        proposal: CommandProposal = source["proposal"]
        # Keep an immutable snapshot of the entire pre-change HUD domain.  It
        # is the only value accepted by host undo and is restored in one
        # revision transaction.
        hud = self.project_host.service.active.get_domain("hud")
        pre_change_hud = copy.deepcopy(hud)
        documents = copy.deepcopy(list(hud.get("documents", [])))
        main_index = next((index for index, item in enumerate(documents)
                           if isinstance(item, dict) and item.get("id") == "hud-main"), None)
        hud_main = documents[main_index] if main_index is not None else None
        if hud_main is None:
            raise HostOperationError("invalid_command", "Canonical hud-main document is unavailable")
        elements = copy.deepcopy(list(hud_main.get("elements", [])))
        if any(not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("name"), str)
               for item in elements):
            raise HostOperationError("invalid_command", "HUD element identity is invalid")
        if len({item["id"] for item in elements}) != len(elements) or len({item["name"] for item in elements}) != len(elements):
            raise HostOperationError("invalid_command", "HUD element identities collide")
        by_name = {item["name"]: item for item in elements}
        by_id = {item["id"]: item for item in elements}
        target_id = source.get("targetElementId")
        target_name = source.get("targetElementName")
        if target_id is not None:
            selected = by_id.get(target_id)
            if selected is None or selected.get("name") != target_name:
                raise HostOperationError("revision_conflict", "Selected HUD element is stale")
        for command in proposal.commands:
            if command["op"] == "delete":
                name = command["name"]
                if name not in by_name:
                    raise HostOperationError("invalid_command", "HUD delete target is unavailable")
                removed = by_name.pop(name)
                by_id.pop(removed["id"], None)
            elif command["op"] == "create":
                element = dict(command["element"])
                name = element["name"]
                # The command format carries a name, while canonical HUD
                # records carry both name and id.  Never resolve a name as an
                # id, and never let either identity collide with an existing
                # record.
                if name in by_name or name in by_id:
                    raise HostOperationError("invalid_command", "HUD element identity collides")
                element["id"] = name
                by_name[element["name"]] = element
                by_id[element["id"]] = element
            else:
                name = command["name"]
                existing = by_name.get(name)
                if existing is None:
                    raise HostOperationError("invalid_command", "HUD update target is unavailable")
                delta = validate_update(command["delta"], existing["type"])
                existing = dict(existing)
                if "props" in delta:
                    merged_props = dict(existing.get("props", {})); merged_props.update(delta["props"])
                    delta = dict(delta); delta["props"] = merged_props
                existing.update(delta); by_name[name] = existing; by_id[existing["id"]] = existing
        hud_main = dict(hud_main); hud_main["elements"] = list(by_name.values())
        documents[main_index] = hud_main
        audit = {"id": proposal.proposal_id, "jobId": source_job_id, "providerId": source.get("providerId", "openai"), "modelId": source.get("modelId", "unknown"), "promptSha256": source.get("promptHash", "0" * 64), "operationsSha256": proposal.diff_hash, "appliedAt": self._now()}
        hud_main["commands"] = list(hud_main.get("commands", []))[-63:] + [audit]
        hud = {"schemaVersion": hud.get("schemaVersion", 1), "documents": documents}
        result = self.project_host.service.apply_changes({"hud": hud}, project_id=active.project_id, expected_revision=payload["expectedRevision"])
        transaction_id = "transaction-" + uuid.uuid4().hex
        self._last_transaction = {"projectId": active.project_id, "revision": result.revision, "hud": pre_change_hud, "transactionId": transaction_id}
        return {"kind": "command.approve", "projectId": active.project_id, "projectRevision": result.revision, "transactionId": transaction_id}

    def _undo_command(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require_project(payload, expected=True)
        transaction = self._last_transaction
        if transaction is None or transaction["projectId"] != active.project_id or payload["transactionId"] != transaction["transactionId"]:
            raise HostOperationError("invalid_command", "Only the last approved transaction can be undone")
        result = self.project_host.service.apply_changes({"hud": copy.deepcopy(transaction["hud"])}, project_id=active.project_id, expected_revision=payload["expectedRevision"])
        self._last_transaction = None
        return {"kind": "command.undo", "projectId": active.project_id, "projectRevision": result.revision, "transactionId": payload["transactionId"]}

    def _run_job(self, job_id: str, provider_id: str, model: str, capability: Capability) -> None:
        try:
            job = self.jobs.get(job_id)
            if job.state.value == "cancel_requested":
                job = self.jobs.reconcile(job_id, remote_state="cancelled", project_id=job.project_id)
                self._queue_job_event(job_id, job.state.value, 1, self.registry.get(provider_id))
                return
            self.jobs.transition(job_id, "submitting")
            self.jobs.transition(job_id, "running")
            adapter = self._adapter(provider_id)
            meta = self._meta[job_id]
            if capability in {Capability.TEXT, Capability.CODE, Capability.COMMANDS}:
                result = adapter.complete(model=model, prompt=meta["prompt"], capability=capability, structured_command=capability == Capability.COMMANDS)
                if isinstance(result, CommandProposal):
                    meta["proposal"] = validate_command(
                        {"commands": [dict(item) for item in result.commands]},
                        proposal_id=_normalize_proposal_id(result.proposal_id), base_revision=meta["projectRevision"], prompt_hash=job.prompt_hash,
                        target_element_id=meta.get("targetElementName"),
                    )
                    meta["proposalId"] = meta["proposal"].proposal_id
                else:
                    meta["outputText"] = result.text[:65536]
            elif capability in {Capability.MEDIA_GENERATE, Capability.MEDIA_EDIT}:
                media_payload: dict[str, Any] = {"prompt": meta["prompt"]}
                if capability == Capability.MEDIA_EDIT:
                    references = []
                    for asset_id in meta["assetIds"]:
                        reference = self.project_host.service.resolve_reference(asset_id, project_id=meta["projectId"])
                        with self.project_host.service.resolve(asset_id, project_id=meta["projectId"]) as source:
                            references.append(adapter.upload_input(source=source, size=reference.size, filename="input.bin", content_type=reference.mime or "application/octet-stream"))
                    if references:
                        media_payload["image_url"] = references[0]
                result = adapter.submit(model=model, capability=capability, payload=media_payload)
                request_id = getattr(result, "request_id", None)
                self.jobs.transition(job_id, "running", remote_id=request_id, reconcile={"durable": True, "remote_request_id": request_id or "", "provider": provider_id, "model": model, "route": meta["route"]})
                for _ in range(120):
                    status = adapter.status(result)
                    state = adapter.status_state(status)
                    if state == "succeeded":
                        if status.get("error") or status.get("error_type"):
                            raise ProviderError("remote", "media provider reported a failed result", provider_id)
                        if self.jobs.get(job_id).state.value == "cancel_requested":
                            self.jobs.reconcile(job_id, remote_state="succeeded", project_id=meta.get("projectId"))
                            self._queue_job_event(job_id, "cancel_requested", None, self.registry.get(provider_id))
                            return
                        break
                    if state in {"failed", "cancelled"}:
                        if state == "cancelled" and self.jobs.get(job_id).state.value == "cancel_requested":
                            job = self.jobs.reconcile(job_id, remote_state="cancelled", project_id=meta.get("projectId"))
                            self._queue_job_event(job_id, job.state.value, 1, self.registry.get(provider_id))
                            return
                        raise ProviderError("remote", "media job did not complete", provider_id)
                    time.sleep(0.05)
                else:
                    raise ProviderError("timeout", "media job timed out", provider_id)
                output = adapter.result(result)
                self._ingest_media(job_id, output, adapter, meta)
            if self.jobs.get(job_id).state.value == "cancel_requested":
                job = self.jobs.reconcile(job_id, remote_state="succeeded", project_id=meta.get("projectId"))
                self._queue_job_event(job_id, job.state.value, None, self.registry.get(provider_id))
                return
            self.jobs.transition(job_id, "succeeded", artifact_hash=meta.get("artifactHash"))
            descriptor = self.registry.get(provider_id)
            self._queue_job_event(job_id, "succeeded", 1, descriptor)
        except Exception as exc:
            try:
                error = exc if isinstance(exc, ProviderError) else ProviderError("internal", "provider job failed")
                meta = self._meta.get(job_id, {})
                meta["errorCode"] = self._map_error(error).code
                meta["retryable"] = bool(error.retryable)
                self.jobs.transition(job_id, "failed", message="provider job failed",
                                     reconcile={"provider": provider_id, "error_code": meta["errorCode"], "retryable": bool(error.retryable)})
                self._queue_job_event(job_id, "failed", None, self.registry.get(provider_id), message=meta["errorCode"], retryable=bool(error.retryable))
            except Exception:
                pass

    def _ingest_media(self, job_id: str, output: Mapping[str, Any], adapter: Any, meta: dict[str, Any]) -> None:
        if self.preview_store is None:
            raise ProviderError("remote", "preview storage is unavailable")
        images = output.get("images")
        if isinstance(images, list) and images and isinstance(images[0], Mapping):
            image = images[0]
            if isinstance(image.get("url"), str):
                output = {"url": image["url"], "mime": image.get("content_type") or image.get("mime")}
            if isinstance(image.get("width"), int) and isinstance(image.get("height"), int):
                meta["dimensions"] = {"width": image["width"], "height": image["height"]}
        if isinstance(output.get("seed"), int) and not isinstance(output.get("seed"), bool):
            meta["seed"] = output["seed"]
        url = output.get("url")
        if not isinstance(url, str):
            raise ProviderError("remote", "media response contained no streamed artifact")
        import tempfile
        with tempfile.NamedTemporaryFile() as temp:
            artifact = adapter.download_output(url, sink=temp)
            temp.flush(); temp.seek(0)
            record = self.preview_store.ingest(job_id, temp, declared_mime=artifact.content_type, provenance=self._preview_provenance(job_id, meta))
        meta["artifactHash"] = record.asset_id
        meta["preview"] = record

    def _adapter(self, provider_id: str) -> Any:
        if provider_id in self._adapters:
            return self._adapters[provider_id]
        transport = self.transports.get(provider_id)
        if transport is None:
            transport = StdlibTransport()
        descriptor = self.registry.get(provider_id)
        credential_store = self._credential_store(provider_id)
        endpoint = self.settings.get(provider_id).endpoint
        cls = _ADAPTERS[provider_id]
        adapter = cls(transport, credential_store=credential_store, registry=self.registry, endpoint=endpoint)
        self._adapters[provider_id] = adapter
        return adapter

    def _credential_store(self, provider_id: str) -> Any:
        return self._memory.get(provider_id) or self._vault

    def _credential_status(self, provider_id: str) -> str:
        descriptor = self.registry.get(provider_id)
        if not descriptor.credential_name:
            return "notRequired"
        for mode, store in (("memoryOnly", self._memory.get(provider_id)), ("configured", self._vault)):
            if store is not None:
                try:
                    if store.read(descriptor.credential_name): return mode
                except Exception:
                    continue
        return "absent" if self._vault is not None else "unavailable"

    def _check_budget(self, provider_id: str, settings: Any, estimate: Any) -> int:
        """Validate one reservation against durable provider-specific caps."""
        if estimate is None:
            return 0
        if not isinstance(estimate, int) or isinstance(estimate, bool) or estimate < 0:
            raise HostOperationError("invalid_request", "Provider cost estimate is invalid")
        if self.registry.get(provider_id).kind == "local":
            if estimate != 0:
                raise HostOperationError("invalid_request", "Local provider cost must be zero")
            return 0
        if estimate == 0:
            return 0
        limits = (settings.max_job_cost_micro_usd, settings.max_daily_cost_micro_usd,
                  settings.max_monthly_cost_micro_usd)
        if any(limit <= 0 for limit in limits):
            raise HostOperationError("budget_exceeded", "Cloud provider budget is not configured")
        totals = self.jobs.cost_totals(provider_id)
        if estimate > limits[0]:
            raise HostOperationError("budget_exceeded", "Job cost exceeds provider budget")
        if totals["daily"] + estimate > limits[1]:
            raise HostOperationError("budget_exceeded", "Daily provider budget is exhausted")
        if totals["monthly"] + estimate > limits[2]:
            raise HostOperationError("budget_exceeded", "Monthly provider budget is exhausted")
        return estimate

    def _settings_value(self, settings: Any) -> dict[str, Any]:
        return {
            "enabled": settings.enabled,
            "routes": [{"capability": capability, "modelId": model} for capability, model in sorted(settings.routes.items())],
            "fallbackPolicy": "none",
            "requireCostConfirmation": settings.require_cost_confirmation,
            "budgets": {
                "perJobMicroUsd": settings.max_job_cost_micro_usd,
                "dailyMicroUsd": settings.max_daily_cost_micro_usd,
                "monthlyMicroUsd": settings.max_monthly_cost_micro_usd,
            },
            "endpointConfigured": settings.endpoint is not None,
        }

    @staticmethod
    def _settings_hash(settings: Any) -> str:
        value = {
            "enabled": settings.enabled, "routes": dict(sorted(settings.routes.items())),
            "fallbackPolicy": "none", "requireCostConfirmation": settings.require_cost_confirmation,
            "budgets": {"perJobMicroUsd": settings.max_job_cost_micro_usd, "dailyMicroUsd": settings.max_daily_cost_micro_usd, "monthlyMicroUsd": settings.max_monthly_cost_micro_usd},
            "endpointConfigured": settings.endpoint is not None,
        }
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def _preview_provenance(self, job_id: str, meta: Mapping[str, Any]) -> dict[str, Any]:
        result = {
            "providerId": meta["providerId"], "modelId": meta["modelId"], "jobId": job_id,
            "createdAt": meta["createdAt"], "routeOrigin": meta["route"], "routeConsent": "explicit",
            "promptSha256": self.jobs.get(job_id).prompt_hash, "settingsSha256": meta["settingsHash"],
            "inputAssetIds": list(meta.get("assetIds", [])),
        }
        if isinstance(meta.get("seed"), int) and not isinstance(meta.get("seed"), bool):
            result["seed"] = meta["seed"]
        return result

    def _job_value(self, job_id: str) -> dict[str, Any]:
        job = self.jobs.get(job_id); meta = self._meta.get(job_id, {})
        value = {"jobId": job.job_id, "providerId": job.provider, "modelId": job.model, "capability": job.capability, "route": meta.get("route", job.route), "status": job.state.value, "progress": 1 if job.state.value == "succeeded" else None, "attempt": job.attempt}
        if job.state.value == "failed":
            value["message"] = str(meta.get("errorCode", job.reconcile.get("error_code", "provider_error")))[:256]
            value["retryable"] = bool(meta.get("retryable", job.reconcile.get("retryable", False)))
        if "outputText" in meta: value["outputText"] = meta["outputText"]
        if "proposal" in meta: value["proposalAvailable"] = True; value["proposalId"] = meta["proposal"].proposal_id
        if "preview" in meta:
            preview = meta["preview"]; value["preview"] = {"previewAssetId": preview.asset_id, "mime": preview.mime, "size": preview.size, "dimensions": {"width": preview.width, "height": preview.height}}
        return value

    def _queue_job_event(self, job_id: str, status: str, progress: float | None, descriptor: Any, *, message: str | None = None, retryable: bool = False) -> None:
        try:
            attempt = self.jobs.get(job_id).attempt
        except Exception:
            attempt = 1
        payload = {"providerId": descriptor.provider_id, "jobId": job_id, "status": status, "progress": progress, "attempt": attempt, "retryable": bool(retryable), **({"message": str(message)[:256]} if message else {})}
        self._queue("provider.progress", payload)
        if status in {"queued", "succeeded", "failed", "cancelled"}:
            self._queue("provider.job", payload)

    def _queue(self, event: str, payload: dict[str, Any]) -> None:
        with self._lock:
            self._events.append((event, payload))

    def _require_project(self, payload: dict[str, Any], *, expected: bool = False) -> Any:
        active = self.project_host.service.active
        if active is None or payload.get("projectId") != active.project_id:
            raise HostOperationError("invalid_project", "Project is not open")
        if expected and payload.get("expectedRevision") != active.revision:
            raise HostOperationError("revision_conflict", "Project revision does not match")
        if expected and getattr(active, "read_only", False):
            raise HostOperationError("read_only", "Project is read-only")
        return active

    def _require_job_project(self, payload: dict[str, Any]) -> Any:
        if not isinstance(payload.get("projectId"), str):
            raise HostOperationError("invalid_project", "Project ownership is required")
        active = self._require_project(payload)
        try:
            return self.jobs.get(payload["jobId"], project_id=active.project_id)
        except KeyError:
            raise HostOperationError("invalid_job", "Inference job is unavailable") from None

    def _project_revision(self, project_id: str) -> int:
        active = self.project_host.service.active
        if active is None or active.project_id != project_id:
            raise HostOperationError("invalid_project", "Project is not open")
        return active.revision

    @staticmethod
    def _map_error(exc: ProviderError) -> HostOperationError:
        code = _PROVIDER_ERRORS.get(str(exc.code), "internal_error")
        return HostOperationError(code, str(exc.message)[:256])


def _normalize_proposal_id(value: Any) -> str:
    """Return a protocol-safe, host-owned proposal identifier."""
    if isinstance(value, str) and value.startswith("proposal-") and 9 <= len(value) <= 128:
        suffix = value[len("proposal-"):]
        if suffix and all(char.isalnum() or char in "_-" for char in suffix):
            return value
    raw = str(value) if isinstance(value, str) else ""
    suffix = hashlib.sha256(raw.encode()).hexdigest()[:32]
    return "proposal-" + suffix
