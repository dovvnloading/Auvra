"""Durable, non-secret provider configuration with optimistic revisions."""
from __future__ import annotations
import json, sqlite3, threading
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from .descriptors import Capability, ProviderRegistry
from Auvra.diagnostics.core import trace_public_class

@dataclass(frozen=True, slots=True)
class ProviderSettings:
    provider: str
    enabled: bool
    routes: dict[str, str]
    endpoint: str | None
    require_cost_confirmation: bool
    max_job_cost_micro_usd: int
    max_daily_cost_micro_usd: int
    max_monthly_cost_micro_usd: int
    revision: int

@trace_public_class("provider_settings", concise=("set", "close"))
class ProviderSettingsStore:
    def __init__(self, database: str = ":memory:", *, registry: ProviderRegistry | None = None) -> None:
        self.registry, self._lock = registry or ProviderRegistry(), threading.RLock()
        if database != ":memory:": Path(database).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(database, check_same_thread=False); self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("""CREATE TABLE IF NOT EXISTS provider_settings (
          provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, routes_json TEXT NOT NULL,
          endpoint TEXT, fallback INTEGER NOT NULL, require_confirmation INTEGER NOT NULL,
          max_job INTEGER NOT NULL, max_daily INTEGER NOT NULL, max_monthly INTEGER NOT NULL,
          revision INTEGER NOT NULL)""")
        self._db.commit()

    def get(self, provider: str) -> ProviderSettings:
        self.registry.get(provider)
        with self._lock: row = self._db.execute("SELECT * FROM provider_settings WHERE provider=?", (provider,)).fetchone()
        if row is None: return ProviderSettings(provider, False, {}, None, True, 0, 0, 0, 0)
        try:
            routes = json.loads(row["routes_json"])
            descriptor = self.registry.get(provider)
            if (row["enabled"] not in {0, 1} or row["fallback"] != 0 or row["require_confirmation"] not in {0, 1} or
                    not isinstance(routes, dict) or len(routes) > 16 or
                    any(Capability(key) not in descriptor.capabilities or not isinstance(model, str) or not 1 <= len(model) <= 200
                        for key, model in routes.items()) or
                    any(not isinstance(row[key], int) or row[key] < 0 for key in ("max_job", "max_daily", "max_monthly")) or
                    not isinstance(row["revision"], int) or row["revision"] < 0):
                raise ValueError
            if row["endpoint"] is not None: _validate_endpoint(descriptor, row["endpoint"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("stored provider settings are invalid") from exc
        return ProviderSettings(provider, bool(row["enabled"]), routes, row["endpoint"], bool(row["require_confirmation"]), row["max_job"], row["max_daily"], row["max_monthly"], row["revision"])

    def set(self, provider: str, *, enabled: bool, routes: dict[Capability | str, str], endpoint: str | None = None,
            require_cost_confirmation: bool = True,
            max_job_cost_micro_usd: int = 0, max_daily_cost_micro_usd: int = 0,
            max_monthly_cost_micro_usd: int = 0, expected_revision: int | None = None) -> ProviderSettings:
        descriptor = self.registry.get(provider)
        if not isinstance(enabled, bool) or not isinstance(routes, dict) or not isinstance(require_cost_confirmation, bool): raise ValueError("invalid provider settings")
        limits = (max_job_cost_micro_usd, max_daily_cost_micro_usd, max_monthly_cost_micro_usd)
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in limits): raise ValueError("budget caps must be nonnegative integers")
        if limits[0] > 1_000_000_000 or limits[1] > 10_000_000_000 or limits[2] > 100_000_000_000: raise ValueError("budget cap exceeds protocol bounds")
        if len(routes) > 16: raise ValueError("too many provider routes")
        normalized = {}
        for capability, model in routes.items():
            capability = Capability(capability)
            if capability not in descriptor.capabilities or not isinstance(model, str) or model not in self.registry.models(provider): raise ValueError("route model is not discovered or registered")
            normalized[capability.value] = model
        if endpoint is not None: _validate_endpoint(descriptor, endpoint)
        current = self.get(provider)
        if expected_revision is not None and expected_revision != current.revision: raise ValueError("settings revision conflict")
        with self._lock:
            self._db.execute("INSERT INTO provider_settings VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET enabled=excluded.enabled,routes_json=excluded.routes_json,endpoint=excluded.endpoint,fallback=excluded.fallback,require_confirmation=excluded.require_confirmation,max_job=excluded.max_job,max_daily=excluded.max_daily,max_monthly=excluded.max_monthly,revision=excluded.revision", (provider, int(enabled), json.dumps(normalized, sort_keys=True), endpoint, 0, int(require_cost_confirmation), max_job_cost_micro_usd, max_daily_cost_micro_usd, max_monthly_cost_micro_usd, current.revision + 1)); self._db.commit()
        return self.get(provider)

    def credential_status(self, provider: str, credential_store: object) -> bool:
        name = self.registry.get(provider).credential_name
        if not name: return True
        try: return bool(credential_store.read(name))
        except Exception: return False

    def close(self) -> None:
        with self._lock: self._db.close()

def _validate_endpoint(descriptor, endpoint: str) -> None:
    parsed = urlsplit(endpoint); origin = f"{parsed.scheme}://{parsed.netloc}"
    if descriptor.is_cloud and (origin not in descriptor.origins or parsed.path not in {"", "/"} or parsed.username or parsed.password or parsed.query or parsed.fragment): raise ValueError("cloud endpoint is not allowlisted")
    if descriptor.is_local and (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"} or parsed.port is None or parsed.path not in {"", "/"} or parsed.username or parsed.password or parsed.query or parsed.fragment): raise ValueError("local endpoint must be numeric loopback")
