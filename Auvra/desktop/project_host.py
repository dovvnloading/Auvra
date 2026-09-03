"""Production adapter between the versioned host protocol and project authority."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict
import errno
import json
import math
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any, Callable
from Auvra.diagnostics import trace_public_class

from Auvra.host.dispatcher import HostOperationError
from Auvra.project import (
    ArchiveValidationError,
    AuvraProjectError,
    InvalidProjectError,
    ProjectIndex,
    ProjectService,
    ReadOnlyError,
    RevisionConflictError,
    UnsupportedVersionError,
)
from Auvra.project.errors import RecoveryRequiredError
from Auvra.project.schemas import DOMAIN_NAMES

from .assets import AssetResourceRequest, AssetTransferRegistry, AssetUpload
from .dialogs import DialogSelection, WinFormsProjectDialogs


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SNAPSHOT_SOFT_LIMIT = 192 * 1024


@trace_public_class("project_host", concise=("handle", "asset_resource", "shutdown"))
class NativeProjectHost:
    """Keep dialogs, paths, streams, and indexes behind one protocol adapter."""

    def __init__(
        self,
        state_root: Path,
        *,
        asset_registry: AssetTransferRegistry,
        dialogs: WinFormsProjectDialogs | None = None,
        service: ProjectService | None = None,
        preview_store: Any = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        state_root = Path(state_root).expanduser().absolute()
        state_root.mkdir(parents=True, exist_ok=True)
        self.assets = asset_registry
        self.dialogs = dialogs or WinFormsProjectDialogs()
        self.service = service or ProjectService(ProjectIndex(state_root / "projects.sqlite3"))
        self.preview_store = preview_store
        self._now = now
        self._dirty_since: float | None = None
        self._last_mutation: float | None = None
        self._events: list[tuple[str, dict[str, Any]]] = []
        self._recovery_by_id: dict[str, tuple[str, str, str]] = {}
        self._recovery_id_by_key: dict[tuple[str, str, str], str] = {}
        self._native_engine: Any = None
        self._native_staged_assets: set[str] = set()
        self._operation_lock = threading.RLock()
        self._event_lock = threading.Lock()
        self._event_sink: Callable[[str, dict[str, Any]], None] | None = None
        self._ui_invoker: Callable[[Callable[[], Any]], Any] = lambda callback: callback()

    def set_event_sink(self, sink: Callable[[str, dict[str, Any]], None] | None) -> None:
        """Stream events while an off-thread project operation is running."""

        self._event_sink = sink

    def set_ui_invoker(self, invoker: Callable[[Callable[[], Any]], Any]) -> None:
        """Marshal only native dialogs to the desktop STA thread."""

        self._ui_invoker = invoker

    def set_preview_store(self, preview_store: Any) -> None:
        """Bind one session-local generated preview store."""

        self.preview_store = preview_store

    def set_native_engine_host(self, native_engine: Any) -> None:
        """Bind the runtime owner without making it a second project authority."""
        self._native_engine = native_engine
        active = self.service.active
        if active is not None:
            self._hydrate_native(active)

    def handle(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._operation_lock:
            return self._handle_serial(method, payload)

    def _handle_serial(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        handler = {
            "project.getStatus": self._get_status,
            "project.create": self._create,
            "project.open": self._open,
            "project.openRecent": self._open_recent,
            "project.close": self._close,
            "project.getSnapshot": self._snapshot,
            "project.applyChanges": self._apply,
            "project.save": self._save,
            "project.saveAs": self._save_as,
            "project.exportPack": self._export,
            "project.importPack": self._import_pack,
            "project.importLegacy": self._import_legacy,
            "asset.beginUpload": self._begin_upload,
            "asset.resolve": self._resolve_asset,
        }.get(method)
        if handler is None:
            raise HostOperationError("unknown_method", "Unknown project method")
        try:
            return handler(payload)
        except HostOperationError:
            self._queue("project.status", self._status_value(busy=False, progress=None))
            raise
        except Exception as exc:
            self._queue("project.status", self._status_value(busy=False, progress=None))
            raise self._mapped_error(exc) from None

    def asset_resource(self, request: AssetResourceRequest):
        with self._operation_lock:
            return self.assets.handle(
                method=request.method,
                url=request.url,
                headers=request.headers,
                body=request.body,
            )

    def drain_events(self) -> list[tuple[str, dict[str, Any]]]:
        with self._event_lock:
            events, self._events = self._events, []
            return events

    def tick(self) -> None:
        if not self._operation_lock.acquire(blocking=False):
            return
        try:
            active = self.service.active
            if active is None:
                return
            if active.autosave_due(
                dirty_since=self._dirty_since,
                last_mutation=self._last_mutation,
                now=self._now(),
            ):
                active.autosave()
                recoveries = len(active.recovery_points())
                self._queue("project.recovery", self._status_value(available=recoveries))
                # One recovery point per dirty period. A later mutation starts a
                # new 60-second window instead of duplicating an unchanged state.
                self._dirty_since = None
        finally:
            self._operation_lock.release()

    def shutdown(self) -> None:
        if self._native_engine is not None:
            try:
                self._native_engine.close_project()
            except Exception:
                pass
        self.service.shutdown()

    @staticmethod
    def _cook_asset_ids(domains: dict[str, Any]) -> set[str]:
        """Select only glTF/GLB/FBX-backed authored model and animation sources."""
        found: set[str] = set()
        for domain in ("models", "animations"):
            documents = domains.get(domain, {}).get("documents", [])
            if not isinstance(documents, list):
                continue
            for document in documents:
                asset_id = document.get("assetId") if isinstance(document, dict) else None
                if isinstance(asset_id, str) and _SHA256.fullmatch(asset_id):
                    found.add(asset_id)
        return found

    def _native_domains(self, active: Any) -> dict[str, Any]:
        # Only world-authority fields cross the private native boundary. Large
        # HUD/graph/terrain/provider documents remain solely in the project
        # repository and cannot inflate a native protocol frame.
        fields = {
            "levels": ("id",),
            "models": ("id", "assetId"),
            "animations": ("id", "assetId", "modelId"),
            "objects": ("id", "levelId", "modelId", "position", "rotation", "scale"),
        }
        authored = {
            domain: active.get_domain(domain)
            for domain in fields
        }
        return self._native_domains_from_documents(authored, fields)

    @staticmethod
    def _euler_to_native_quaternion(rotation: Any) -> list[float]:
        """Convert authored Three.js XYZ-radian Euler angles for native only.

        Project files intentionally keep the editor-facing Euler representation.
        The native world consumes normalized quaternions, so this conversion is
        kept at the private host boundary and never written back to a project.
        """
        if (not isinstance(rotation, (list, tuple)) or len(rotation) != 3 or
                any(isinstance(value, bool) or not isinstance(value, (int, float)) or
                    not math.isfinite(value) for value in rotation)):
            raise ValueError("object rotation must be three finite Euler radians")
        x, y, z = (float(value) for value in rotation)
        half_x, half_y, half_z = x / 2.0, y / 2.0, z / 2.0
        sx, cx = math.sin(half_x), math.cos(half_x)
        sy, cy = math.sin(half_y), math.cos(half_y)
        sz, cz = math.sin(half_z), math.cos(half_z)
        quaternion = [
            sx * cy * cz + cx * sy * sz,
            cx * sy * cz - sx * cy * sz,
            cx * cy * sz + sx * sy * cz,
            cx * cy * cz - sx * sy * sz,
        ]
        length = math.sqrt(sum(value * value for value in quaternion))
        if not math.isfinite(length) or length <= 1e-12:
            raise ValueError("object rotation quaternion is not normalizable")
        return [value / length for value in quaternion]

    @classmethod
    def _native_domains_from_documents(
        cls,
        domains: dict[str, Any],
        fields: dict[str, tuple[str, ...]] | None = None,
    ) -> dict[str, Any]:
        fields = fields or {
            "levels": ("id",),
            "models": ("id", "assetId"),
            "animations": ("id", "assetId", "modelId"),
            "objects": ("id", "levelId", "modelId", "position", "rotation", "scale"),
        }
        result: dict[str, dict[str, Any]] = {}
        for domain, allowed in fields.items():
            value = domains.get(domain, {})
            documents = value.get("documents", []) if isinstance(value, dict) else []
            if not isinstance(documents, list):
                raise ValueError(f"{domain} documents are invalid")
            native_documents = []
            for document in documents:
                if not isinstance(document, dict):
                    raise ValueError(f"{domain} document is invalid")
                native_document = {
                    key: document[key] for key in allowed if key in document
                }
                if domain == "objects" and "rotation" in native_document:
                    native_document["rotation"] = cls._euler_to_native_quaternion(
                        native_document["rotation"]
                    )
                native_documents.append(native_document)
            result[domain] = {
                "schemaVersion": 1,
                "documents": native_documents,
            }
        return result

    def _hydrate_native(self, active: Any, progress: Callable[[float], None] | None = None) -> None:
        native = self._native_engine
        if native is None:
            if progress is not None:
                progress(1.0)
            return
        try:
            domains = self._native_domains(active)
            asset_ids = self._cook_asset_ids(domains)
            pending = sorted(asset_ids - self._native_staged_assets)
            total_steps = len(pending) + 1
            for index, asset_id in enumerate(pending, start=1):
                with active.assets.open(asset_id) as stream:
                    native.stage_asset(asset_id, stream)
                self._native_staged_assets.add(asset_id)
                if progress is not None:
                    progress(index / total_steps)
            native.hydrate_project(active.project_id, active.revision, domains, asset_ids=sorted(asset_ids))
            if progress is not None:
                progress(1.0)
        except Exception as exc:
            # A durable repository commit is still authoritative, but the
            # native world is no longer a trustworthy view of it.  Invalidate
            # the whole in-memory session before surfacing the existing,
            # fail-closed recovery error.  In particular, do not let callers
            # observe an opened/revision/dirty success for a world that did
            # not hydrate.
            self._invalidate_native_session(active)
            raise HostOperationError(
                "recovery_required",
                "Native project hydration failed; recovery is required",
                {"projectId": active.project_id, "revision": active.revision},
            ) from exc

    def _invalidate_native_session(self, active: Any) -> None:
        """Close native and repository state after a failed native boundary."""
        native = self._native_engine
        if native is not None:
            try:
                native.close_project(active.project_id)
            except Exception:
                # The native child is already considered unusable.  The
                # repository must still be closed and the protocol must still
                # expose the canonical closed state.
                pass
        self._native_staged_assets.clear()
        if self.service.active is active:
            self.service.close()
        else:
            try:
                active.close()
            except Exception:
                pass
        self._dirty_since = self._last_mutation = None
        self._queue("project.closed", self._status_value())

    def _validate_native_candidate(self, active: Any, revision: int, domains: dict[str, Any]) -> None:
        native = self._native_engine
        if native is None or not callable(getattr(native, "validate_project", None)):
            return
        try:
            native.validate_project(
                active.project_id,
                revision,
                self._native_domains_from_documents(domains),
            )
        except HostOperationError:
            raise
        except Exception as exc:
            raise HostOperationError("invalid_project", "Native world rejected the project candidate") from exc

    def _queue(self, name: str, payload: dict[str, Any]) -> None:
        event_fields = {
            "projectId", "revision", "name", "dirty", "readOnly", "busy",
            "progress", "recoveryAvailable", "recoveryId", "recoveryKind",
            "recentProjects", "status", "domains", "dirtySince", "operation",
            "available",
        }
        bounded = {key: value for key, value in payload.items() if key in event_fields}
        sink = self._event_sink
        if sink is not None:
            sink(name, bounded)
            return
        with self._event_lock:
            self._events.append((name, bounded))

    def _progress(self, operation: str, value: float) -> None:
        self._queue(
            "project.progress",
            self._status_value(busy=True, progress=max(0.0, min(1.0, value)), operation=operation),
        )

    def _choose(self, callback: Callable[[], DialogSelection | None]) -> DialogSelection:
        return self._selected(self._ui_invoker(callback))

    def _recovery_values(self) -> list[dict[str, Any]]:
        active = self.service.active
        if active is None:
            return []
        values: list[dict[str, Any]] = []
        for point in active.recovery_points():
            key = (active.project_id, point["kind"], point["name"])
            recovery_id = self._recovery_id_by_key.get(key)
            if recovery_id is None:
                recovery_id = "recovery-" + secrets.token_urlsafe(24)
                self._recovery_id_by_key[key] = recovery_id
                self._recovery_by_id[recovery_id] = key
            values.append({"recoveryId": recovery_id, "kind": point["kind"], "size": point["size"]})
        return values

    def _restore_requested(self, payload: dict[str, Any], status: Any) -> Any:
        recovery_id = payload.get("recoveryId")
        if recovery_id is None:
            return status
        selected = self._recovery_by_id.get(recovery_id)
        if selected is None or selected[0] != status.project_id:
            raise HostOperationError("recovery_required", "Recovery selection is no longer available")
        return self.service.restore_recovery(
            project_id=status.project_id,
            kind=selected[1],
            name=selected[2],
        )

    def _status_value(self, status: Any = None, **extra: Any) -> dict[str, Any]:
        if status is None:
            active = self.service.active
            status = active.status if active is not None else None
        if status is None:
            result: dict[str, Any] = {
                "projectId": None,
                "revision": 0,
                "name": None,
                "dirty": False,
                "readOnly": False,
                "busy": False,
                "progress": None,
                "recoveryAvailable": False,
                "recoveryPoints": [],
                "recentProjects": self._recent_values(),
                "status": "closed",
            }
        else:
            recoveries = self._recovery_values()
            result = {
                "projectId": status.project_id,
                "revision": status.revision,
                "name": status.name,
                "dirty": status.dirty,
                "readOnly": status.read_only,
                "busy": False,
                "progress": None,
                "recoveryAvailable": bool(recoveries),
                "recoveryPoints": recoveries,
                "recentProjects": self._recent_values(),
                "status": "open",
            }
        result.update(extra)
        return result

    def _recent_values(self) -> list[dict[str, Any]]:
        return [
            {"projectId": item["projectId"], "name": item["name"]}
            for item in self.service.recent(20)
        ]

    def _require(self, payload: dict[str, Any], *, expected: bool = False):
        active = self.service.active
        if active is None or payload.get("projectId") != active.project_id:
            raise HostOperationError("invalid_project", "Project is not open")
        if expected and payload.get("expectedRevision") != active.revision:
            raise HostOperationError(
                "revision_conflict",
                "Project revision does not match",
                {
                    "projectId": active.project_id,
                    "expectedRevision": payload.get("expectedRevision"),
                    "actualRevision": active.revision,
                },
            )
        if expected and active.read_only:
            raise HostOperationError("read_only", "Project is read-only")
        return active

    @staticmethod
    def _selected(selection: DialogSelection | None) -> Path:
        if selection is None:
            raise HostOperationError("cancelled", "Project operation was cancelled")
        return selection.path

    def _get_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id = payload.get("projectId")
        if project_id is not None:
            self._require(payload)
        return self._status_value(domains=list(DOMAIN_NAMES))

    def _create(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = payload["name"]
        destination = self._choose(lambda: self.dialogs.choose_create_location(name))
        self._queue("project.opening", self._status_value(busy=True, progress=0.0, operation="create"))
        status = self.service.create(destination, name)
        self._progress("create", 0.6)
        self._native_staged_assets.clear()
        self._hydrate_native(self.service.active, lambda value: self._progress("create", 0.6 + value * 0.35))
        self._dirty_since = self._last_mutation = None
        result = self._status_value(status)
        self._queue("project.opened", result)
        return result

    def _open(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("projectHandle") != "dialog":
            raise HostOperationError("invalid_project", "Project handle is not available")
        descriptor = self._choose(self.dialogs.choose_open_project)
        self._queue("project.opening", self._status_value(busy=True, progress=0.0, operation="open"))
        status = self.service.open(descriptor.parent)
        self._progress("open", 0.5)
        status = self._restore_requested(payload, status)
        self._dirty_since = self._last_mutation = None
        self._native_staged_assets.clear()
        self._hydrate_native(self.service.active, lambda value: self._progress("open", 0.55 + value * 0.4))
        result = self._status_value(status)
        self._queue("project.opened", result)
        if status.read_only:
            self._queue("project.readOnly", result)
        return result

    def _open_recent(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._queue("project.opening", self._status_value(busy=True, progress=0.0, operation="openRecent"))
        status = self.service.open_recent(payload["recentId"])
        self._progress("openRecent", 0.5)
        status = self._restore_requested(payload, status)
        self._dirty_since = self._last_mutation = None
        self._native_staged_assets.clear()
        self._hydrate_native(self.service.active, lambda value: self._progress("openRecent", 0.55 + value * 0.4))
        result = self._status_value(status)
        self._queue("project.opened", result)
        return result

    def _close(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require(payload, expected=True)
        project_id, revision = active.project_id, active.revision
        self._queue("project.closing", self._status_value(busy=True, operation="close"))
        if self._native_engine is not None:
            try:
                self._native_engine.close_project(project_id)
            except Exception:
                pass
        self.service.close()
        self._native_staged_assets.clear()
        self._dirty_since = self._last_mutation = None
        # ``_status_value`` accepts a ProjectStatus as its positional value;
        # after close the service has no active status, so start from the
        # canonical closed value and retain the identity/revision of the
        # project that was just closed.
        result = self._status_value(projectId=project_id, revision=revision)
        self._queue("project.closed", result)
        return result

    def _snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require(payload)
        cursor = payload.get("cursor", "0")
        if cursor in {None, ""}:
            offset = 0
        elif isinstance(cursor, str) and cursor.isascii() and cursor.isdigit():
            offset = int(cursor)
        else:
            raise HostOperationError("invalid_request", "Snapshot cursor is invalid")
        page_size = min(int(payload.get("pageSize", 100)), 100)
        domains = [payload["domain"]] if payload.get("domain") else list(DOMAIN_NAMES)
        while True:
            snapshot = self.service.get_snapshot(domains, offset=offset, page_size=page_size)
            more = any(bool(value.get("hasMore")) for value in snapshot.domains.values())
            result = self._status_value(
                self.service.active.status,
                domains=snapshot.domains,
                cursor=str(offset + page_size) if more else "",
                hasMore=more,
            )
            size = len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if size <= _SNAPSHOT_SOFT_LIMIT:
                return result
            if page_size == 1:
                raise HostOperationError("invalid_project", "A project document exceeds the transport limit")
            page_size = max(1, page_size // 2)

    def _apply(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require(payload, expected=True)
        changed: dict[str, list[dict[str, Any]]] = {}
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for change in payload["changes"]:
            grouped[change["domain"]].append(change)
        for domain, operations in grouped.items():
            documents = {
                document["id"]: document
                for document in active.get_domain(domain)["documents"]
            }
            for change in operations:
                document_id = change["documentId"]
                if change["operation"] == "remove":
                    documents.pop(document_id, None)
                else:
                    document = change.get("document")
                    if not isinstance(document, dict) or document.get("id") != document_id:
                        raise HostOperationError("invalid_request", "Project document identity does not match")
                    documents[document_id] = document
            changed[domain] = [documents[key] for key in sorted(documents)]
        candidate = {
            domain: {"schemaVersion": 1, "documents":
                     (changed[domain] if domain in changed else active.get_domain(domain)["documents"])}
            for domain in DOMAIN_NAMES
        }
        self._validate_native_candidate(active, active.revision + 1, candidate)
        status = self.service.apply_changes(
            changed,
            project_id=active.project_id,
            expected_revision=payload["expectedRevision"],
        )
        now = self._now()
        self._dirty_since = self._dirty_since or now
        self._last_mutation = now
        self._hydrate_native(self.service.active)
        result = self._status_value(status)
        self._queue("project.revision", result)
        self._queue("project.dirty", result)
        return result

    def _save(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require(payload, expected=True)
        status = self.service.save(
            project_id=active.project_id,
            expected_revision=payload["expectedRevision"],
        )
        self._dirty_since = self._last_mutation = None
        result = self._status_value(status)
        self._queue("project.dirty", result)
        self._queue("project.recovery", self._status_value(available=len(active.recovery_points())))
        return result

    def _save_as(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require(payload, expected=True)
        name = payload["name"]
        destination = self._choose(lambda: self.dialogs.choose_save_as_location(name))
        status = self.service.save_as(destination, project_id=active.project_id, name=name)
        self._native_staged_assets.clear()
        self._hydrate_native(self.service.active)
        self._dirty_since = self._last_mutation = None
        result = self._status_value(status)
        self._queue("project.opened", result)
        return result

    def _export(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require(payload, expected=True)
        destination = self._choose(lambda: self.dialogs.choose_export_pack(active.name))
        self.service.export_pack(destination, project_id=active.project_id)
        return self._status_value()

    def _import_pack(self, payload: dict[str, Any]) -> dict[str, Any]:
        source = self._choose(self.dialogs.choose_import_pack)
        name = payload.get("name") or source.stem
        destination = self._choose(lambda: self.dialogs.choose_create_location(name))
        self._queue("project.opening", self._status_value(busy=True, progress=0.0, operation="importPack"))
        status = self.service.import_pack(source, destination)
        self._progress("importPack", 0.65)
        self._native_staged_assets.clear()
        self._hydrate_native(self.service.active, lambda value: self._progress("importPack", 0.65 + value * 0.3))
        self._dirty_since = self._last_mutation = None
        result = self._status_value(status)
        self._queue("project.opened", result)
        return result

    def _import_legacy(self, payload: dict[str, Any]) -> dict[str, Any]:
        source = self._choose(self.dialogs.choose_import_legacy)
        name = payload.get("name") or source.stem
        destination = self._choose(lambda: self.dialogs.choose_create_location(name))
        self._queue("project.opening", self._status_value(busy=True, progress=0.0, operation="importLegacy"))
        migrate = getattr(self.service, "migrate_legacy", None)
        if not callable(migrate):
            raise HostOperationError("migration_failed", "Legacy migration is unavailable")
        try:
            status, report = migrate(source, destination, name=name)
        except PermissionError:
            raise
        except OSError:
            raise
        except Exception:
            raise HostOperationError("migration_failed", "Legacy migration failed validation") from None
        self._progress("importLegacy", 0.65)
        self._dirty_since = self._last_mutation = None
        self._native_staged_assets.clear()
        self._hydrate_native(self.service.active, lambda value: self._progress("importLegacy", 0.65 + value * 0.3))
        result = self._status_value(status, report=self._safe_report(report))
        self._queue("project.opened", result)
        return result

    def _begin_upload(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require(payload, expected=True)
        project_id = active.project_id
        declared_size = int(payload["size"])
        mime = payload["mime"]
        name = payload["name"]

        def ingest(upload: AssetUpload) -> None:
            current = self.service.active
            if current is None or current.project_id != project_id or current.read_only:
                raise ReadOnlyError("project upload is no longer writable")
            with upload.path.open("rb") as stream:
                reference = self.service.begin_upload(
                    stream,
                    project_id=project_id,
                    size=upload.size,
                    mime=upload.mime_type,
                    name=name,
                )
            if reference.asset_id != upload.sha256:
                raise InvalidProjectError("uploaded asset hash changed during ingestion")

        ticket = self.assets.issue_upload(
            mime_type=mime,
            max_size=declared_size,
            ttl=60,
            on_upload=ingest,
        )
        return self._status_value(
            url=ticket.url,
            method=ticket.method,
            mime=mime,
            size=declared_size,
        )

    def _resolve_asset(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require(payload)
        asset_id = payload["assetId"]
        if not _SHA256.fullmatch(asset_id):
            raise HostOperationError("invalid_request", "Asset identity is invalid")
        try:
            reference = self.service.resolve_reference(asset_id, project_id=active.project_id)
            stream = self.service.resolve(asset_id, project_id=active.project_id)
            mime, size = reference.mime or "application/octet-stream", reference.size
        except (FileNotFoundError, ValueError):
            # Existing project content with missing/corrupt metadata is a
            # project failure, not an excuse to substitute a session preview.
            if active.assets.path_for(asset_id).exists():
                raise
            if self.preview_store is None:
                raise
            try:
                preview = self.preview_store.find(asset_id)
                stream = self.preview_store.open(asset_id)
                mime, size = preview.mime, preview.size
            except Exception:
                raise HostOperationError("invalid_job", "Generated preview is unavailable") from None
        try:
            ticket = self.assets.issue_download_stream(
                stream,
                mime_type=mime,
                expected_hash=asset_id,
                max_size=max(1, size),
                ttl=60,
            )
        finally:
            stream.close()
        return self._status_value(
            url=ticket.url,
            method=ticket.method,
            assetId=asset_id,
            mime=mime,
            size=size,
        )

    @staticmethod
    def _safe_report(report: Any) -> dict[str, Any]:
        value = asdict(report) if hasattr(report, "__dataclass_fields__") else report
        if not isinstance(value, dict):
            return {"migrated": True}
        # Source paths are explicitly excluded from protocol migration reports.
        return {key: child for key, child in value.items() if key not in {"source", "path"}}

    @staticmethod
    def _mapped_error(exc: Exception) -> HostOperationError:
        if isinstance(exc, RevisionConflictError):
            return HostOperationError("revision_conflict", "Project revision does not match")
        if isinstance(exc, ReadOnlyError):
            return HostOperationError("read_only", "Project is read-only")
        if isinstance(exc, UnsupportedVersionError):
            return HostOperationError("unsupported_version", "Project version is not supported")
        if isinstance(exc, RecoveryRequiredError):
            return HostOperationError("recovery_required", "Project recovery is required")
        if isinstance(exc, (ArchiveValidationError, InvalidProjectError)):
            return HostOperationError("invalid_project", "Project validation failed")
        if isinstance(exc, PermissionError):
            return HostOperationError("permission_denied", "Project access was denied")
        if isinstance(exc, OSError):
            if getattr(exc, "errno", None) in {errno.ENOSPC, errno.EDQUOT}:
                return HostOperationError("disk_failure", "There is not enough disk space")
            return HostOperationError("disk_failure", "Project storage operation failed")
        if isinstance(exc, AuvraProjectError):
            return HostOperationError("internal_error", "Project operation failed")
        return HostOperationError("internal_error", "Project operation failed")
