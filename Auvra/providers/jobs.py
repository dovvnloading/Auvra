"""Durable provider-job state with redacted SQLite persistence."""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Mapping
from .descriptors import Capability, ProviderRegistry
from Auvra.diagnostics import trace_public_class


class JobState(StrEnum):
    QUEUED = "queued"
    SUBMITTING = "submitting"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELLED = "cancelled"
    RECOVERING = "recovering"


_TERMINAL = frozenset({JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED})
_ALLOWED = {
    JobState.QUEUED: {JobState.SUBMITTING, JobState.CANCEL_REQUESTED, JobState.CANCELLED},
    JobState.SUBMITTING: {JobState.RUNNING, JobState.FAILED, JobState.CANCEL_REQUESTED, JobState.CANCELLED, JobState.RECOVERING},
    JobState.RUNNING: {JobState.SUCCEEDED, JobState.FAILED, JobState.CANCEL_REQUESTED, JobState.CANCELLED, JobState.RECOVERING},
    JobState.CANCEL_REQUESTED: {JobState.CANCELLED, JobState.FAILED, JobState.RECOVERING},
    JobState.RECOVERING: {JobState.RUNNING, JobState.SUCCEEDED, JobState.FAILED, JobState.CANCEL_REQUESTED, JobState.CANCELLED},
    JobState.FAILED: {JobState.QUEUED},
    JobState.CANCELLED: {JobState.QUEUED},
    JobState.SUCCEEDED: set(),
}


@dataclass(frozen=True, slots=True)
class Job:
    job_id: str
    project_id: str | None
    provider: str
    model: str
    capability: str
    state: JobState
    prompt_hash: str
    artifact_hash: str | None
    remote_id: str | None
    attempts: int
    cost_micro_usd: int
    reconcile: Mapping[str, Any]
    provenance: Mapping[str, Any]
    created_at: float
    updated_at: float

    @property
    def route(self) -> str:
        from .descriptors import PROVIDER_REGISTRY
        return "local" if PROVIDER_REGISTRY.get(self.provider).is_local else "cloud"

    @property
    def attempt(self) -> int:
        return max(1, self.attempts + 1)

    @property
    def status(self) -> JobState:
        return self.state


@dataclass(frozen=True, slots=True)
class JobEvent:
    sequence: int
    job_id: str
    state: JobState
    message: str | None
    at: float


@trace_public_class("provider_jobs", concise=(
    "create", "transition", "request_cancel", "cancel", "retry", "add_cost",
    "reserve_cost", "reconcile_restart", "reconcile", "close",
))
class SQLiteJobStore:
    """SQLite-backed state machine. Prompts, payloads, responses, and secrets are never accepted."""

    def __init__(self, database: str = ":memory:", *, registry: ProviderRegistry | None = None) -> None:
        if database != ":memory:": Path(database).parent.mkdir(parents=True, exist_ok=True)
        self.registry = registry or ProviderRegistry()
        self._db = sqlite3.connect(database, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.executescript("""
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS jobs (
              job_id TEXT PRIMARY KEY, project_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
              capability TEXT NOT NULL, state TEXT NOT NULL, prompt_hash TEXT NOT NULL,
              artifact_hash TEXT, remote_id TEXT, attempts INTEGER NOT NULL,
              cost_micro_usd INTEGER NOT NULL, reconcile_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
              created_at REAL NOT NULL, updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS job_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(job_id),
              state TEXT NOT NULL, message TEXT, at REAL NOT NULL
            );
        """)
        columns = {row[1] for row in self._db.execute("PRAGMA table_info(jobs)").fetchall()}
        if "project_id" not in columns:
            # Databases created by early Stage 4 development builds have no
            # durable owner. Leave those rows ownerless so restart recovery
            # fails closed instead of attaching work to whichever project is
            # open next.
            self._db.execute("ALTER TABLE jobs ADD COLUMN project_id TEXT")
        self._db.commit()

    def close(self) -> None:
        with self._lock: self._db.close()

    def create(self, *, project_id: str, provider: str, model: str, capability: str, prompt_hash: str,
               artifact_hash: str | None = None, cost_micro_usd: int = 0,
               provenance: Mapping[str, Any] | None = None, job_id: str | None = None) -> Job:
        if not _is_project_id(project_id): raise ValueError("invalid project id")
        if not isinstance(provider, str) or provider not in self.registry: raise ValueError("unknown provider")
        if not isinstance(model, str) or not model or len(model) > 200: raise ValueError("invalid model")
        try: capability = Capability(capability)
        except (TypeError, ValueError) as exc: raise ValueError("invalid capability") from exc
        if capability not in self.registry.get(provider).capabilities: raise ValueError("unsupported capability")
        if not isinstance(cost_micro_usd, int) or isinstance(cost_micro_usd, bool) or cost_micro_usd < 0: raise ValueError("invalid cost")
        if not _is_hash(prompt_hash): raise ValueError("prompt hash must be sha256")
        if artifact_hash is not None and not _is_hash(artifact_hash): raise ValueError("artifact hash must be sha256")
        _safe_json(provenance or {})
        now = time.time(); identifier = job_id or "job-" + str(uuid.uuid4())
        if not isinstance(identifier, str) or not identifier.startswith("job-") or not 8 <= len(identifier) <= 128:
            raise ValueError("job id must use job- prefix")
        with self._lock:
            try:
                self._db.execute("""INSERT INTO jobs (
                    job_id,project_id,provider,model,capability,state,prompt_hash,
                    artifact_hash,remote_id,attempts,cost_micro_usd,reconcile_json,
                    provenance_json,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (identifier, project_id, provider, model, capability, JobState.QUEUED.value, prompt_hash,
                     artifact_hash, None, 0, cost_micro_usd, "{}", json.dumps(dict(provenance or {}), sort_keys=True), now, now))
                self._event(identifier, JobState.QUEUED, None, now)
                self._db.commit()
            except sqlite3.IntegrityError as exc: raise ValueError("job id already exists") from exc
        return self.get(identifier)

    def get(self, job_id: str, *, project_id: str | None = None) -> Job:
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if row is None: raise KeyError(job_id)
        if project_id is not None and row["project_id"] != project_id:
            # Do not reveal whether another project owns this job.
            raise KeyError(job_id)
        return _job(row)

    create_job = create
    get_job = get

    def list(self, *, states: set[JobState] | None = None,
             project_id: str | None = None) -> tuple[Job, ...]:
        with self._lock:
            if project_id is None:
                rows = self._db.execute("SELECT * FROM jobs ORDER BY created_at, job_id").fetchall()
            else:
                rows = self._db.execute("SELECT * FROM jobs WHERE project_id=? ORDER BY created_at, job_id", (project_id,)).fetchall()
        values = tuple(_job(row) for row in rows)
        return tuple(value for value in values if states is None or value.state in states)

    def transition(self, job_id: str, state: JobState, *, message: str | None = None,
                   remote_id: str | None = None, artifact_hash: str | None = None,
               reconcile: Mapping[str, Any] | None = None, cost_micro_usd: int | None = None,
               project_id: str | None = None) -> Job:
        state = JobState(state)
        if remote_id is not None and (not isinstance(remote_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,200}", remote_id) is None):
            raise ValueError("invalid remote job id")
        with self._lock:
            current = self.get(job_id, project_id=project_id)
            if state == current.state:
                # Progress and remote reconciliation may advance without changing lifecycle state.
                if reconcile is not None or remote_id is not None:
                    metadata = current.reconcile if reconcile is None else reconcile
                    _safe_json(metadata); now = time.time()
                    self._db.execute("UPDATE jobs SET reconcile_json=?, remote_id=COALESCE(?,remote_id), updated_at=? WHERE job_id=?", (json.dumps(dict(metadata), sort_keys=True), remote_id, now, job_id)); self._db.commit()
                return self.get(job_id)
            if state not in _ALLOWED[current.state]: raise ValueError(f"invalid job transition {current.state} -> {state}")
            if artifact_hash is not None and not _is_hash(artifact_hash): raise ValueError("artifact hash must be sha256")
            _safe_json(reconcile or {})
            now = time.time()
            if cost_micro_usd is not None and (not isinstance(cost_micro_usd, int) or cost_micro_usd < 0): raise ValueError("invalid cost")
            self._db.execute("UPDATE jobs SET state=?, remote_id=COALESCE(?,remote_id), artifact_hash=COALESCE(?,artifact_hash), reconcile_json=?, cost_micro_usd=COALESCE(?,cost_micro_usd), updated_at=? WHERE job_id=?",
                (state.value, remote_id, artifact_hash, json.dumps(dict(reconcile or current.reconcile), sort_keys=True), cost_micro_usd, now, job_id))
            self._event(job_id, state, _safe_message(message), now)
            self._db.commit()
        return self.get(job_id)

    def request_cancel(self, job_id: str, *, project_id: str | None = None) -> Job:
        current = self.get(job_id, project_id=project_id)
        if current.state in _TERMINAL or current.state == JobState.CANCEL_REQUESTED: return current
        return self.transition(job_id, JobState.CANCEL_REQUESTED, message="cancellation requested", project_id=project_id)

    def cancel(self, job_id: str, *, project_id: str | None = None) -> Job:
        current = self.request_cancel(job_id, project_id=project_id)
        if current.state == JobState.CANCEL_REQUESTED: return self.transition(job_id, JobState.CANCELLED, message="cancelled", project_id=project_id)
        return current

    def retry(self, job_id: str, *, project_id: str | None = None) -> Job:
        current = self.get(job_id, project_id=project_id)
        if current.state == JobState.QUEUED: return current
        if current.state not in {JobState.FAILED, JobState.CANCELLED}: raise ValueError("only failed or cancelled jobs can retry")
        if current.attempt >= 3: raise ValueError("job retry limit reached")
        with self._lock:
            now = time.time()
            self._db.execute("UPDATE jobs SET state=?, attempts=attempts+1, remote_id=NULL, reconcile_json='{}', updated_at=? WHERE job_id=?",
                             (JobState.QUEUED.value, now, job_id))
            self._event(job_id, JobState.QUEUED, "retry queued", now); self._db.commit()
        return self.get(job_id)

    def add_cost(self, job_id: str, amount_micro_usd: int, *, project_id: str | None = None) -> Job:
        """Add one explicitly approved retry reservation to a durable job."""
        if not isinstance(amount_micro_usd, int) or isinstance(amount_micro_usd, bool) or amount_micro_usd < 0:
            raise ValueError("invalid cost")
        with self._lock:
            current = self.get(job_id, project_id=project_id)
            self._db.execute("UPDATE jobs SET cost_micro_usd=?, updated_at=? WHERE job_id=?",
                             (current.cost_micro_usd + amount_micro_usd, time.time(), job_id))
            self._db.commit()
        return self.get(job_id, project_id=project_id)

    def events(self, job_id: str, *, project_id: str | None = None) -> tuple[JobEvent, ...]:
        with self._lock:
            self.get(job_id, project_id=project_id)
            rows = self._db.execute("SELECT * FROM job_events WHERE job_id=? ORDER BY sequence", (job_id,)).fetchall()
        return tuple(JobEvent(row["sequence"], job_id, JobState(row["state"]), row["message"], row["at"]) for row in rows)

    def reserve_cost(self, job_id: str, amount_micro_usd: int, *, project_id: str | None = None) -> Job:
        """Idempotently record a pre-dispatch reservation on a queued job."""
        if not isinstance(amount_micro_usd, int) or isinstance(amount_micro_usd, bool) or amount_micro_usd < 0: raise ValueError("invalid cost")
        with self._lock:
            current = self.get(job_id, project_id=project_id)
            if current.cost_micro_usd == amount_micro_usd: return current
            if current.cost_micro_usd != 0: raise ValueError("job cost is already reserved")
            if current.state not in {JobState.QUEUED, JobState.SUBMITTING}: raise ValueError("job is not reservable")
            self._db.execute("UPDATE jobs SET cost_micro_usd=?, updated_at=? WHERE job_id=?", (amount_micro_usd, time.time(), job_id)); self._db.commit()
        return self.get(job_id)

    def cost_totals(self, provider: str, *, at: datetime | None = None) -> dict[str, int]:
        """Return durable aggregate/day/month micro-USD totals using UTC timestamps."""
        point = at or datetime.now(timezone.utc); day, month = point.date().isoformat(), point.strftime("%Y-%m")
        with self._lock: rows = self._db.execute("SELECT cost_micro_usd,created_at FROM jobs WHERE provider=?", (provider,)).fetchall()
        daily = monthly = aggregate = 0
        for row in rows:
            amount = int(row[0]); aggregate += amount; stamp = datetime.fromtimestamp(row[1], timezone.utc)
            if stamp.date().isoformat() == day: daily += amount
            if stamp.strftime("%Y-%m") == month: monthly += amount
        return {"aggregate": aggregate, "daily": daily, "monthly": monthly}

    def pending_reconciliation(self, *, project_id: str | None = None) -> tuple[Job, ...]:
        return self.list(states={JobState.SUBMITTING, JobState.RUNNING, JobState.CANCEL_REQUESTED, JobState.RECOVERING}, project_id=project_id)

    def reconcile_restart(self) -> tuple[Job, ...]:
        """Fail non-durable in-flight work cleanly; durable work is returned for polling."""
        pending = self.pending_reconciliation(); durable = []
        for job in pending:
            # A pre-project-ownership database may contain in-flight rows with
            # a NULL owner.  Never attach those rows to the next open project.
            if not job.project_id:
                try: self.transition(job.job_id, JobState.FAILED, message="restart requires project ownership", reconcile={"restart_pending": True})
                except ValueError: pass
                continue
            if bool(job.reconcile.get("durable", False)):
                try: durable.append(self.transition(job.job_id, JobState.RECOVERING, message="restart requires remote reconciliation", reconcile={"durable": True, "restart_pending": True}))
                except ValueError: durable.append(job)
            else:
                try: self.transition(job.job_id, JobState.FAILED, message="restart requires reconciliation", reconcile={"restart_pending": True})
                except ValueError: pass
        return tuple(durable)

    def reconcile(self, job_id: str, *, remote_state: str, remote_id: str | None = None,
                  metadata: Mapping[str, Any] | None = None,
                  project_id: str | None = None) -> Job:
        state_map = {"queued": JobState.RUNNING, "running": JobState.RUNNING,
                     "completed": JobState.SUCCEEDED, "succeeded": JobState.SUCCEEDED,
                     "failed": JobState.FAILED, "cancelled": JobState.CANCELLED}
        if remote_state not in state_map: raise ValueError("unknown remote state")
        target = state_map[remote_state]; current = self.get(job_id, project_id=project_id)
        if current.state == JobState.QUEUED and target == JobState.RUNNING:
            self.transition(job_id, JobState.SUBMITTING, remote_id=remote_id, reconcile=metadata or {}, project_id=project_id)
            current = self.get(job_id, project_id=project_id)
        if target == current.state: return current
        if target == JobState.SUCCEEDED and current.state == JobState.CANCEL_REQUESTED: return current
        return self.transition(job_id, target, remote_id=remote_id, reconcile=metadata or {}, project_id=project_id)

    def _event(self, job_id: str, state: JobState, message: str | None, at: float) -> None:
        self._db.execute("INSERT INTO job_events(job_id,state,message,at) VALUES (?,?,?,?)", (job_id, state.value, message, at))


def _job(row: sqlite3.Row) -> Job:
    return Job(row["job_id"], row["project_id"], row["provider"], row["model"], row["capability"], JobState(row["state"]),
               row["prompt_hash"], row["artifact_hash"], row["remote_id"], row["attempts"], row["cost_micro_usd"],
               json.loads(row["reconcile_json"]), json.loads(row["provenance_json"]), row["created_at"], row["updated_at"])


def _is_hash(value: str) -> bool:
    if not isinstance(value, str) or len(value) != 64:
        return False
    try: int(value, 16); return True
    except ValueError: return False


_PROJECT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def _is_project_id(value: str) -> bool:
    return isinstance(value, str) and _PROJECT_ID.fullmatch(value) is not None


def _safe_json(value: Mapping[str, Any]) -> None:
    if not isinstance(value, Mapping): raise ValueError("metadata must be an object")
    allowed = {"durable", "restart_pending", "remote_state", "progress", "route", "provider", "model", "capability", "route_consent", "content_hash", "prompt_hash", "remote_request_id", "cost_micro_usd", "error_code", "retryable"}
    if any(not isinstance(key, str) or key not in allowed for key in value): raise ValueError("metadata key is not allowlisted")
    if any(not isinstance(item, (str, int, float, bool, type(None))) or (isinstance(item, str) and (len(item) > 512 or "://" in item or "\\" in item)) or (isinstance(item, float) and not math.isfinite(item)) for item in value.values()): raise ValueError("metadata value is not a bounded primitive")
    if any(isinstance(item, str) and any(token in item.lower() for token in ("api_key", "apikey", "authorization", "bearer ", "credential", "password", "secret", "token=")) for item in value.values()):
        raise ValueError("metadata value contains sensitive data")
    for key in ("prompt_hash", "content_hash"):
        if key in value and not _is_hash(value[key]): raise ValueError("metadata hash is invalid")
    for key in ("progress", "cost_micro_usd"):
        if key in value and (not isinstance(value[key], (int, float)) or value[key] < 0): raise ValueError("metadata numeric value is invalid")
    encoded = json.dumps(value, sort_keys=True)
    if len(encoded.encode()) > 32768: raise ValueError("metadata exceeds size limit")
    lowered = encoded.lower()
    if any(token in lowered for token in ("\"response\"", "\"secret\"", "\"token\"", "\"api_key\"", "\"credential\"", "\"url\"", "\"path\"", "\"payload\"", "\"output\"")):
        raise ValueError("sensitive metadata key is not allowed")


def _safe_message(value: str | None) -> str | None:
    if value is None: return None
    if not isinstance(value, str) or len(value) > 512: raise ValueError("job message exceeds size limit")
    # Event messages are durable and frequently surfaced in diagnostics.
    # Reject request data/credentials rather than persisting or echoing them.
    lowered = value.lower()
    if any(token in lowered for token in ("api_key", "apikey", "authorization", "bearer ", "credential", "password", "secret", "token", "https://", "http://", "file://", "\\")):
        raise ValueError("job message contains sensitive data")
    return value


DurableJobStore = SQLiteJobStore
