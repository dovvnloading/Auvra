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
import sys
import threading
import time
from typing import Any, Callable, Sequence
from Auvra.diagnostics import trace_public_class
from Auvra.diagnostics.core import active_diagnostics

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
from Auvra.project.game_build import (
    BUILD_TARGETS,
    DESKTOP_TARGETS,
    PACKAGED_PLAYER_BINARIES,
    TARGET_LABELS,
    TEMPLATE_MANIFEST,
    GameBuildError,
    build_game,
)
from Auvra.project.schemas import DOMAIN_NAMES

from .assets import AssetResourceRequest, AssetTransferRegistry, AssetUpload
from .dialogs import DialogSelection, WinFormsProjectDialogs, _validated_name
from .native_engine import NativeEngineState, NativeEngineUnavailableHost


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_CHECKOUT_ROOT = Path(__file__).resolve().parents[2]
# Development builds copy the Vite player entry; packaged builds pass the
# immutable ``<frontend root>/player`` tree explicitly.
_DEV_PLAYER_TEMPLATE_ROOT = _CHECKOUT_ROOT / "fbx-viewer (1)" / "dist" / "player"
_BUILD_TARGET_SUFFIX = {"web": "Web", "windows": "Windows", "linux": "Linux", "macos": "macOS"}
# The desktop target a checkout's own ``cargo build --release`` produces.
_HOST_DESKTOP_TARGET = {"win32": "windows", "linux": "linux", "darwin": "macos"}
_TEMPLATE_MISSING = "The game player template is not installed"
# Shown in the Build Game picker and returned when a development checkout has
# no player for a desktop target.  Paths are repository-relative.
_DEV_PLAYER_HINTS = {
    "windows": "Build the Windows game player first: run cargo build --release in player-desktop on Windows.",
    "linux": "Build the Linux game player on Linux (cargo build --release in player-desktop), "
             "or download its linux-x64 CI artifact to player-desktop/dist/linux-x64.",
    "macos": "Download the universal macOS game player CI artifact to player-desktop/dist/macos, "
             "or build it on a Mac (cargo build --release in player-desktop).",
}
# GameBuildError codes that are already host protocol error codes.
_BUILD_ERROR_CODES = frozenset({"invalid_request", "invalid_project", "locking", "unsupported_capability"})
_SNAPSHOT_SOFT_LIMIT = 192 * 1024
# A snapshot page also carries the project status envelope (recent projects,
# recovery points).  Writes are capped below the page limit by this reserve so
# every committed document fits a single-document page and can be reopened.
_SNAPSHOT_ENVELOPE_RESERVE = 32 * 1024
DOCUMENT_LOAD_LIMIT = _SNAPSHOT_SOFT_LIMIT - _SNAPSHOT_ENVELOPE_RESERVE
_AUTOSAVE_RETRY_DELAY = 5.0


def player_executable_candidates(
    target: str,
    *,
    player_root: Path | None = None,
    checkout_root: Path | None = None,
    platform: str | None = None,
) -> tuple[Path, ...]:
    """Where the desktop game player for ``target`` may be, best first.

    A packaged editor passes its ``game-player`` folder as ``player_root`` and
    ships every player there.  A development checkout (this repository unless
    ``checkout_root`` is given) uses its own cargo release build for the host
    OS (``platform``, default ``sys.platform``), then the players downloaded
    from CI into ``player-desktop/dist``.
    """

    relative = PACKAGED_PLAYER_BINARIES.get(target)
    if relative is None:
        return ()
    if player_root is not None:
        return (Path(player_root).expanduser().absolute().joinpath(*relative.split("/")),)
    crate = Path(checkout_root or _CHECKOUT_ROOT) / "player-desktop"
    if target == "windows":
        return (crate / "target" / "release" / "auvra-player.exe",)
    candidates = [crate.joinpath("dist", *relative.split("/"))]
    if _HOST_DESKTOP_TARGET.get(platform or sys.platform) == target:
        candidates.insert(0, crate / "target" / "release" / "auvra-player")
    return tuple(candidates)


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
        native_authoritative: bool = False,
        player_template_root: Path | None = None,
        player_executable: Path | None = None,
        player_root: Path | None = None,
    ) -> None:
        state_root = Path(state_root).expanduser().absolute()
        state_root.mkdir(parents=True, exist_ok=True)
        self._state_root = state_root
        self.player_template_root = Path(player_template_root or _DEV_PLAYER_TEMPLATE_ROOT).expanduser().absolute()
        # Desktop players: a packaged editor passes its game-player folder as
        # ``player_root``, ``player_executable`` pins the Windows player, and
        # everything else comes from the development checkout.
        self._packaged_players = player_root is not None
        self._player_candidates = {
            target: player_executable_candidates(target, player_root=player_root) for target in DESKTOP_TARGETS
        }
        if player_executable is not None:
            self._player_candidates["windows"] = (Path(player_executable).expanduser().absolute(),)
        # Opaque build handles map to a chosen parent folder for one session;
        # paths never cross the protocol.
        self._build_destinations: dict[str, tuple[str, Path]] = {}
        self.assets = asset_registry
        self.dialogs = dialogs or WinFormsProjectDialogs()
        self.service = service or ProjectService(ProjectIndex(state_root / "projects.sqlite3"))
        self.preview_store = preview_store
        self._now = now
        self._dirty_since: float | None = None
        self._last_mutation: float | None = None
        self._autosave_retry_at = 0.0
        self._events: list[tuple[str, dict[str, Any]]] = []
        self._recovery_by_id: dict[str, tuple[str, str, str]] = {}
        self._recovery_id_by_key: dict[tuple[str, str, str], str] = {}
        self._native_engine: Any = None
        # WebGL2 is the authoritative renderer today, so a native hydration
        # failure degrades only the native view.  Once native rendering is
        # authoritative, the same failure must fail the project closed.
        self._native_authoritative = native_authoritative
        self._native_staged_assets: set[str] = set()
        # Hydration skipped while a native child was stopped; the next tick
        # after it is READY again mirrors the current revision.
        self._native_resync = False
        # Project the native host last received, so a skipped hydration for
        # another project can drop it instead of re-presenting it on restart.
        self._native_project: str | None = None
        self._pending_assets: dict[str, set[str]] = defaultdict(set)
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
        self._native_resync = False
        self._native_project = None
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
            "project.buildGame": self._build_game,
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

    def build_game(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Build a standalone game from the open project (read-only allowed)."""
        return self.handle("project.buildGame", payload)

    def player_executable_for(self, target: str) -> Path | None:
        """The desktop player binary a ``target`` build copies, or None when it is missing."""
        return next((path for path in self._player_candidates.get(target, ()) if path.is_file()), None)

    def build_targets(self) -> list[dict[str, Any]]:
        """Every build target with whether it can build now and, when not, why."""
        template_ready = (self.player_template_root / TEMPLATE_MANIFEST).is_file()
        targets: list[dict[str, Any]] = []
        for target in BUILD_TARGETS:
            reason: str | None = None
            if not template_ready:
                reason = _TEMPLATE_MISSING + "."
            elif target in DESKTOP_TARGETS and self.player_executable_for(target) is None:
                reason = self._missing_player_reason(target)
            entry: dict[str, Any] = {"target": target, "available": reason is None}
            if reason is not None:
                entry["reason"] = reason
            targets.append(entry)
        return targets

    def _missing_player_reason(self, target: str) -> str:
        if self._packaged_players:
            return f"This Auvra install does not include the {TARGET_LABELS[target]} game player."
        return _DEV_PLAYER_HINTS[target]

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

    def restore_events(self, events: Sequence[tuple[str, dict[str, Any]]]) -> None:
        with self._event_lock:
            self._events[0:0] = list(events)

    def tick(self) -> None:
        if not self._operation_lock.acquire(blocking=False):
            return
        try:
            active = self.service.active
            if active is None:
                return
            if self._native_resync and self._native_running():
                try:
                    self._hydrate_native(active)
                except HostOperationError:
                    # Authoritative hydration failure already closed the
                    # session and published project.closed.
                    return
                active = self.service.active
                if active is None:
                    return
            now = self._now()
            if now < self._autosave_retry_at:
                return
            if active.autosave_due(
                dirty_since=self._dirty_since,
                last_mutation=self._last_mutation,
                now=now,
            ):
                try:
                    active.autosave()
                    recoveries = len(active.recovery_points())
                except Exception as exc:
                    # Autosave is a background convenience operation.  A disk
                    # or permissions failure must leave the live project and
                    # controller usable; retain the dirty period and retry at
                    # a bounded cadence instead of escaping the desktop loop.
                    self._autosave_retry_at = now + _AUTOSAVE_RETRY_DELAY
                    diagnostics = active_diagnostics()
                    if diagnostics is not None:
                        diagnostics.emit(
                            "operation", "operation.failed",
                            attributes={"code": "autosave_failed",
                                        "errorType": type(exc).__name__},
                        )
                    return
                self._autosave_retry_at = 0.0
                self._queue("project.recovery", self._recovery_event_value("autosave", available=recoveries))
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
        active = self.service.active
        if active is not None:
            self._discard_pending_assets(active.project_id, active)
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

    def _record_pending_asset(self, project_id: str, asset_id: str) -> None:
        self._pending_assets[project_id].add(asset_id)

    def retain_pending_asset(self, project_id: str, asset_id: str) -> None:
        """An upload something else now relies on: it stays until the project closes, when anything still unnamed goes."""
        self._pending_assets[project_id].discard(asset_id)

    def _discard_pending_assets(self, project_id: str, active: Any | None = None) -> None:
        pending = self._pending_assets.get(project_id)
        if not pending:
            return
        active = active or self.service.active
        if active is None or getattr(active, "project_id", None) != project_id:
            return
        live = getattr(active, "referenced_asset_ids", lambda: set())()
        for asset_id in list(pending):
            if asset_id in live:
                pending.discard(asset_id)
                continue
            try:
                discard = getattr(active, "discard_asset_if_unreferenced", None)
                if callable(discard):
                    discard(asset_id)
            except (OSError, ValueError):
                continue
            pending.discard(asset_id)
        if not pending:
            self._pending_assets.pop(project_id, None)

    def _retire_active_pending_assets(self) -> None:
        active = self.service.active
        if active is not None:
            self._discard_pending_assets(active.project_id, active)

    def _native_running(self) -> bool:
        """Whether a native world exists that hydration would reach."""
        native = self._native_engine
        if native is None or isinstance(native, NativeEngineUnavailableHost):
            return False
        state = getattr(getattr(native, "engine", None), "state", None)
        return state is None or state == NativeEngineState.READY

    def _defer_native(self, active: Any) -> None:
        """Record a hydration skipped because the native child is stopped."""
        native = self._native_engine
        if native is None or isinstance(native, NativeEngineUnavailableHost):
            # The web fallback never hosts a native world.
            return
        self._native_resync = True
        previous = self._native_project
        if previous is not None and previous != active.project_id:
            # A native restart re-hydrates its retained payload; do not let
            # it re-present the project that is no longer open.
            try:
                native.close_project(previous)
            except Exception:
                pass
            self._native_project = None

    def _native_domains(self, active: Any, reuse: dict[str, Any] | None = None) -> dict[str, Any]:
        # Only renderer-authority fields cross the private native boundary.
        # Large HUD/graph/terrain/provider documents remain solely in the
        # project repository and cannot inflate a native protocol frame.
        # ``reuse`` carries domain documents already read for this revision.
        fields = self._native_fields()
        authored = {
            domain: reuse[domain] if reuse is not None and domain in reuse else active.get_domain(domain)
            for domain in fields
        }
        return self._native_domains_from_documents(authored, fields)

    @staticmethod
    def _native_fields() -> dict[str, tuple[str, ...]]:
        return {
            "worlds": ("id", "name", "camera", "cameraPosition", "lights", "lighting", "postEffects", "msaaSamples", "fxaa"),
            "scenes": ("id", "name", "camera", "cameraPosition", "lights", "lighting", "postEffects", "msaaSamples", "fxaa"),
            "levels": ("id", "name", "camera", "cameraPosition", "lights", "lighting", "postEffects", "msaaSamples", "fxaa"),
            "environment": ("id", "name", "settings", "skyConfig", "fog", "camera", "cameraPosition", "lights", "lighting", "ibl", "postEffects", "msaaSamples", "fxaa"),
            "models": ("id", "assetId", "category", "textureOverrides"),
            "animations": ("id", "assetId", "modelId", "durationTicks", "duration", "speedNumerator", "speedDenominator", "looped"),
            "materials": ("id", "name", "textureIds", "overrides", "baseColorFactor", "baseColor", "metallic", "roughness", "baseColorTexture", "baseColorTextureId", "normalTexture", "normalTextureId", "metallicRoughnessTexture", "metallicRoughnessTextureId"),
            "objects": ("id", "levelId", "modelId", "position", "rotation", "scale", "color", "materialId", "material", "radius", "lods", "animationId", "animation", "render", "selected"),
        }

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
        fields = fields or cls._native_fields()
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

    def _hydrate_native(
        self,
        active: Any,
        progress: Callable[[float], None] | None = None,
        *,
        reuse: dict[str, Any] | None = None,
    ) -> None:
        native = self._native_engine
        if not self._native_running():
            # No running native world: skip reading, converting and staging
            # the project entirely.  A stopped child catches up on a tick.
            self._defer_native(active)
            if progress is not None:
                progress(1.0)
            return
        self._native_resync = False
        try:
            domains = self._native_domains(active, reuse)
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
            self._native_project = active.project_id
            if progress is not None:
                progress(1.0)
        except Exception as exc:
            if not self._native_authoritative:
                # The durable commit and the WebGL2 view remain correct; only
                # the native mirror is stale.  Keep the project open.
                self._degrade_native_view(active, exc)
                return
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

    def _degrade_native_view(self, active: Any, error: Exception) -> None:
        """Mark the non-authoritative native view stale and record why."""
        mark_stale = getattr(self._native_engine, "mark_stale", None)
        if callable(mark_stale):
            try:
                # The identity lets native drop a world that still holds the
                # previous project or revision instead of re-hydrating it.
                mark_stale(
                    "Native project hydration failed; the native view is stale",
                    project_id=active.project_id,
                    project_revision=active.revision,
                )
            except Exception:
                pass
        self._emit_native_lifecycle("stale", "hydration_failed", error)

    @staticmethod
    def _emit_native_lifecycle(state: str, code: str, error: Exception) -> None:
        diagnostics = active_diagnostics()
        if diagnostics is not None:
            diagnostics.emit(
                "native", "native.lifecycle",
                attributes={"state": state, "code": code,
                            "errorType": type(error).__name__},
            )

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
        self._native_resync = False
        self._native_project = None
        self._discard_pending_assets(active.project_id, active)
        if self.service.active is active:
            self.service.close()
        else:
            try:
                active.close()
            except Exception:
                pass
        self._dirty_since = self._last_mutation = None
        self._queue("project.closed", self._status_value())

    def _native_validates(self) -> bool:
        return self._native_running() and callable(getattr(self._native_engine, "validate_project", None))

    def _validate_native_candidate(self, active: Any, revision: int, domains: dict[str, Any]) -> None:
        native = self._native_engine
        if not self._native_validates():
            return
        try:
            native.validate_project(
                active.project_id,
                revision,
                self._native_domains_from_documents(domains),
            )
        except Exception as exc:
            if not self._native_authoritative:
                # WebGL2 is authoritative, so native rules must not block a
                # durable write.  If native rejects the committed content too,
                # the post-commit hydration degrades only the native view.
                self._emit_native_lifecycle("rejected", "validation_failed", exc)
                return
            if isinstance(exc, HostOperationError):
                raise
            raise HostOperationError("invalid_project", "Native world rejected the project candidate") from exc

    def _queue(self, name: str, payload: dict[str, Any]) -> None:
        event_fields = {
            "projectId", "revision", "name", "dirty", "readOnly", "busy",
            "progress", "recoveryAvailable", "recoveryId", "recoveryKind", "recoveryPoints",
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

    def _recovery_event_value(self, kind: str, **extra: Any) -> dict[str, Any]:
        """Publish the full recovery list and identify the newly-created point."""
        payload = self._status_value(**extra)
        active = self.service.active
        if active is None:
            return payload
        points = active.recovery_points(kind)
        if not points:
            return payload
        key = (active.project_id, kind, points[0]["name"])
        recovery_id = self._recovery_id_by_key.get(key)
        if recovery_id is not None:
            payload.update({"recoveryId": recovery_id, "recoveryKind": kind})
        return payload

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

    def _require(self, payload: dict[str, Any], *, expected: bool = False, writable: bool = True):
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
        if expected and writable and active.read_only:
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
        # Build target availability is host-wide, so it is reported with or
        # without an open project; events never carry it.
        return self._status_value(domains=list(DOMAIN_NAMES), buildTargets=self.build_targets())

    def _create(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = payload["name"]
        destination = self._choose(lambda: self.dialogs.choose_create_location(name))
        self._queue("project.opening", self._status_value(busy=True, progress=0.0, operation="create"))
        self._retire_active_pending_assets()
        # The project takes its folder's name, which the dialog numbers ("Starter Game 2") when taken.
        status = self.service.create(destination, destination.name, payload.get("template"))
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
        self._retire_active_pending_assets()
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
        self._retire_active_pending_assets()
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
        self._discard_pending_assets(project_id, active)
        self.service.close()
        self._native_staged_assets.clear()
        self._native_resync = False
        self._native_project = None
        self._dirty_since = self._last_mutation = None
        # ``_status_value`` accepts a ProjectStatus as its positional value;
        # after close the service has no active status, so start from the
        # canonical closed value and retain the identity/revision of the
        # project that was just closed.
        result = self._status_value(projectId=project_id, revision=revision)
        self._queue("project.closed", result)
        return result

    @staticmethod
    def _snapshot_cursor(cursor: Any) -> tuple[int, int]:
        """Parse ``offset`` or ``offset.domainIndex`` (a page split by domain)."""
        if cursor in {None, ""}:
            return 0, 0
        if isinstance(cursor, str) and cursor.isascii():
            offset, split, domain = cursor.partition(".")
            if offset.isdigit() and (not split or domain.isdigit()):
                return int(offset), int(domain) if split else 0
        raise HostOperationError("invalid_request", "Snapshot cursor is invalid")

    def _snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require(payload)
        offset, first = self._snapshot_cursor(payload.get("cursor", "0"))
        page_size = min(int(payload.get("pageSize", 100)), 100)
        domains = [payload["domain"]] if payload.get("domain") else list(DOMAIN_NAMES)
        if first >= len(domains):
            raise HostOperationError("invalid_request", "Snapshot cursor is invalid")
        if first:
            # Continue a one-document page that was split across domains.
            page_size = 1
        envelope = self._status_value(self.service.active.status)

        def page(names: Sequence[str], snapshot: Any, cursor: str, more: bool) -> dict[str, Any] | None:
            result = {**envelope, "domains": {name: snapshot.domains[name] for name in names},
                      "cursor": cursor, "hasMore": more}
            size = len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            return result if size <= _SNAPSHOT_SOFT_LIMIT else None

        while True:
            snapshot = self.service.get_snapshot(domains, offset=offset, page_size=page_size)
            more = any(bool(value.get("hasMore")) for value in snapshot.domains.values())
            result = page(domains[first:], snapshot, str(offset + page_size) if more else "", more)
            if result is not None:
                return result
            if page_size > 1:
                page_size = max(1, page_size // 2)
                continue
            # One document per domain still exceeds the page: serve the longest
            # fitting run of domains and resume the same offset after it.
            fitting: dict[str, Any] | None = None
            for end in range(first + 1, len(domains)):
                candidate = page(domains[first:end], snapshot, f"{offset}.{end}", True)
                if candidate is None:
                    break
                fitting = candidate
            if fitting is None:
                raise HostOperationError("invalid_project", "A project document exceeds the transport limit")
            return fitting

    @staticmethod
    def _require_loadable_documents(changes: Sequence[dict[str, Any]]) -> None:
        """Reject a document that could be committed but never paged back."""
        for change in changes:
            document = change.get("document")
            if change.get("operation") == "remove" or document is None:
                continue
            size = len(json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if size > DOCUMENT_LOAD_LIMIT:
                raise HostOperationError(
                    "invalid_request",
                    f"Project document exceeds the {DOCUMENT_LOAD_LIMIT // 1024} KiB load limit",
                )

    def _apply(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self.service.active
        unchanged_native: dict[str, Any] | None = None
        try:
            active = self._require(payload, expected=True)
            self._require_loadable_documents(payload["changes"])
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
            if self._native_validates():
                # Native rules see only renderer-authority domains, so read
                # just the unchanged ones of those; hydration reuses them.
                unchanged_native = {
                    domain: active.get_domain(domain)
                    for domain in self._native_fields() if domain not in changed
                }
                candidate = {
                    **unchanged_native,
                    **{domain: {"schemaVersion": 1, "documents": documents}
                       for domain, documents in changed.items()},
                }
                self._validate_native_candidate(active, active.revision + 1, candidate)
            status = self.service.apply_changes(
                changed,
                project_id=active.project_id,
                expected_revision=payload["expectedRevision"],
            )
        except Exception:
            if active is not None and payload.get("projectId") == getattr(active, "project_id", None):
                self._discard_pending_assets(active.project_id, active)
            raise
        self._discard_pending_assets(active.project_id, self.service.active)
        now = self._now()
        self._dirty_since = self._dirty_since or now
        self._last_mutation = now
        # The commit wrote only the changed domains, so the unchanged native
        # domains read for validation are still this revision's content.
        self._hydrate_native(self.service.active, reuse=unchanged_native)
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
        self._queue("project.recovery", self._recovery_event_value("manual", available=len(active.recovery_points())))
        return result

    def _save_as(self, payload: dict[str, Any]) -> dict[str, Any]:
        active = self._require(payload, expected=True)
        name = payload["name"]
        destination = self._choose(lambda: self.dialogs.choose_save_as_location(name))
        self._retire_active_pending_assets()
        status = self.service.save_as(destination, project_id=active.project_id, name=destination.name)
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

    def _build_game(self, payload: dict[str, Any]) -> dict[str, Any]:
        # Building only reads the project, so read-only projects may build.
        active = self._require(payload, expected=True, writable=False)
        target = payload.get("target")
        suffix = _BUILD_TARGET_SUFFIX.get(target) if isinstance(target, str) else None
        if suffix is None:
            raise HostOperationError("invalid_request", "Build target is not supported")
        template_root = self.player_template_root
        if not (template_root / TEMPLATE_MANIFEST).is_file():
            # Fail before asking for a folder the build could never fill.
            raise HostOperationError("unsupported_capability", _TEMPLATE_MISSING)
        player: Path | None = None
        if target in DESKTOP_TARGETS:
            player = self.player_executable_for(target)
            if player is None:
                raise HostOperationError("unsupported_capability", self._missing_player_reason(target))
        project_id = active.project_id
        domains = {domain: active.get_domain(domain) for domain in DOMAIN_NAMES}
        game_name = self._game_name(domains, active.name)
        handle = payload.get("destinationHandle")
        # "dialog" (what the editor sends) or no handle asks for a folder; a handle from an
        # earlier build reuses that folder.
        if handle is not None and handle != "dialog":
            remembered = self._build_destinations.get(handle) if isinstance(handle, str) else None
            if remembered is None or remembered[0] != project_id:
                raise HostOperationError("invalid_request", "Build destination is no longer available")
            parent = remembered[1]
        else:
            chooser = getattr(self.dialogs, "choose_build_destination", None)
            if not callable(chooser):
                raise HostOperationError("unsupported_capability", "Build destination dialog is unavailable")
            parent = self._choose(lambda: chooser(game_name))
            handle = "build-" + secrets.token_urlsafe(24)
        destination = self._build_destination(
            active, parent, _validated_name(f"{game_name[:80]}-{suffix}", f"AuvraGame-{suffix}"),
        )
        store = active.assets

        def read_asset(asset_id: str) -> tuple[bytes, str]:
            # ValueError (bad id, missing metadata) becomes invalid_project.
            mime = store.reference(asset_id).mime or "application/octet-stream"
            with store.open(asset_id) as stream:
                return stream.read(), mime

        self._progress("buildGame", 0.0)
        try:
            report = build_game(
                domains=domains,
                read_asset=read_asset,
                template_root=template_root,
                destination=destination,
                target=target,
                build_id=secrets.token_hex(16),
                game_id=project_id,
                player_executable=player,
            )
        except GameBuildError as exc:
            raise self._build_error(exc) from None
        self._build_destinations[handle] = (project_id, parent)
        self._queue("project.status", self._status_value(busy=False, progress=None))
        return self._status_value(
            handle=handle,
            # "bytes" is a reserved protocol key (binary payloads), so the size travels as sizeBytes;
            # a reply carrying it is refused by the editor and closes the host connection.
            report={
                "target": report.target,
                "files": report.files,
                "sizeBytes": report.bytes,
                "assets": report.assets,
                "levels": report.levels,
            },
        )

    @staticmethod
    def _game_name(domains: dict[str, Any], fallback: str) -> str:
        documents = domains.get("metadata", {}).get("documents", [])
        for document in documents if isinstance(documents, list) else []:
            if isinstance(document, dict) and document.get("id") == "game-settings":
                settings = document.get("settings")
                name = settings.get("name") if isinstance(settings, dict) else None
                if isinstance(name, str) and name.strip():
                    return name.strip()
        return str(fallback or "AuvraGame").strip() or "AuvraGame"

    def _build_destination(self, active: Any, parent: Path, name: str) -> Path:
        from .provider_host import _assert_state_path_safe

        destination = Path(parent).expanduser().absolute() / name
        try:
            _assert_state_path_safe(destination)
            resolved = destination.resolve(strict=False)
            protected = (
                Path(active.path).expanduser().absolute().resolve(strict=False),
                self._state_root.resolve(strict=False),
            )
        except OSError:
            raise HostOperationError("invalid_request", "Build destination cannot contain links") from None
        for root in protected:
            # A build replaces its destination, so it must neither live inside
            # nor contain the project or host state.
            if resolved == root or root in resolved.parents or resolved in root.parents:
                raise HostOperationError("invalid_request", "Build destination overlaps the project")
        return destination

    @staticmethod
    def _build_error(exc: Exception) -> HostOperationError:
        code = getattr(exc, "code", None)
        mapped = code if code in _BUILD_ERROR_CODES else "internal_error"
        message = getattr(exc, "message", None)
        if (not isinstance(message, str) or not message.strip() or len(message) > 200
                or "/" in message or "\\" in message):
            # Build messages may name files; never forward a path.
            message = "Game build failed"
        return HostOperationError(mapped, message)

    def _import_pack(self, payload: dict[str, Any]) -> dict[str, Any]:
        source = self._choose(self.dialogs.choose_import_pack)
        name = payload.get("name") or source.stem
        destination = self._choose(lambda: self.dialogs.choose_create_location(name))
        self._queue("project.opening", self._status_value(busy=True, progress=0.0, operation="importPack"))
        self._retire_active_pending_assets()
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
        self._retire_active_pending_assets()
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
            already_present = current.assets.verify(upload.sha256, expected_size=upload.size)
            try:
                with upload.path.open("rb") as stream:
                    reference = self.service.begin_upload(
                        stream,
                        project_id=project_id,
                        size=upload.size,
                        mime=upload.mime_type,
                        name=name,
                    )
            except Exception:
                if not already_present:
                    try:
                        current.discard_asset_if_unreferenced(upload.sha256)
                    except (OSError, ValueError):
                        pass
                raise
            if reference.asset_id != upload.sha256:
                raise InvalidProjectError("uploaded asset hash changed during ingestion")
            if not already_present:
                self._record_pending_asset(project_id, upload.sha256)

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
                preview = self.preview_store.find(asset_id, project_id=active.project_id)
                stream = self.preview_store.open(asset_id, project_id=active.project_id)
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
