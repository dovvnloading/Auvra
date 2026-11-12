"""Transactional native project repository."""
from __future__ import annotations

import copy, hashlib, os, re, shutil, tempfile, time, uuid, zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from Auvra.diagnostics import trace_public_class
from .archive import export_folder, validate_archive
from .assets import AssetStore, sniff_mime
from .errors import (ArchiveValidationError, InvalidProjectError, ReadOnlyError,
                     RevisionConflictError, RecoveryRequiredError,
                     UnsupportedVersionError)
from .legacy import LegacyArchive
from .locking import ProjectLock
from . import migrations as _migrations
from .schemas import (DOMAIN_NAMES, _asset_handles, domain_document, validate_domain,
                      validate_project_descriptor, validate_project_references)
from .serialization import atomic_dump_json, dump_json, load_json

FORMAT = "auvra.project"
VERSION = 1
MANUAL_LIMIT = 5
AUTOSAVE_LIMIT = 10
PROJECT_CAP = 2 * 1024**3
RECOVERY_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
_RECOVERY_COMPLETE = ".complete"
# Domains added after recovery points were first written. A point captured
# before one existed has no file for it, which reads as the empty domain it
# then was; every other domain must still be present in a complete point.
_RECOVERY_LATER_DOMAINS = frozenset({"prefabs"})

@dataclass(frozen=True)
class ProjectStatus:
    project_id: str
    name: str
    revision: int
    dirty: bool
    read_only: bool

@dataclass(frozen=True)
class ProjectSnapshot:
    project_id: str
    revision: int
    domains: dict[str, Any]
    page: int = 0
    page_size: int = 100

@trace_public_class("repository", concise=(
    "create", "apply_changes", "save", "save_as", "autosave",
    "restore_recovery", "export_pack", "import_pack", "import_legacy", "close",
))
class ProjectRepository:
    """One project handle. All mutating methods require the acquired lock."""
    def __init__(self, path: str | os.PathLike[str], *, read_only: bool = False,
                 page_size: int = 100) -> None:
        self.path = Path(path)
        self.page_size = page_size
        _validate_open_boundaries(self.path)
        self._lock = ProjectLock(self.path / ".auvra" / "project.lock")
        self.read_only = read_only or not self._lock.acquire()
        self._descriptor: dict[str, Any] = {}
        self._dirty = False
        self._open()

    @classmethod
    def create(cls, path: str | os.PathLike[str], name: str | None = None):
        path = Path(path)
        if path.exists():
            if any(path.iterdir()): raise InvalidProjectError("project destination already exists")
            path.rmdir()
        path.parent.mkdir(parents=True, exist_ok=True)
        name = name or path.name
        if not name or any(c in name for c in '/\\'):
            raise InvalidProjectError("invalid project name")
        descriptor = {"format": FORMAT, "schemaVersion": VERSION,
                      "projectId": str(uuid.uuid4()), "name": name,
                      "revision": 0, "createdAt": time.time(), "updatedAt": time.time(),
                      "engineVersion": _migrations.ENGINE_VERSION}
        staging = Path(tempfile.mkdtemp(prefix=f".{path.name}.create-", dir=path.parent))
        try:
            (staging / "Project").mkdir(exist_ok=True); (staging / "Content" / "sha256").mkdir(parents=True, exist_ok=True)
            (staging / ".auvra" / "transactions").mkdir(parents=True, exist_ok=True)
            dump_json(staging / f"{name}.auvra", descriptor)
            (staging / ".gitignore").write_text(".auvra/\n", encoding="utf-8", newline="\n")
            _fsync_directory(staging / "Project"); _fsync_directory(staging / "Content"); _fsync_directory(staging)
            os.replace(staging, path); _fsync_directory(path.parent); staging = None
        finally:
            if staging is not None: shutil.rmtree(staging, ignore_errors=True)
        return cls(path)

    def _descriptor_path(self) -> Path:
        matches = [p for p in self.path.glob("*.auvra") if p.is_file()]
        if len(matches) != 1: raise InvalidProjectError("project requires one descriptor")
        return matches[0]

    def _open(self) -> None:
        try: self._descriptor = load_json(self._descriptor_path())
        except Exception:
            self._descriptor = {}
            if self.read_only or not self._recover_descriptor():
                self.close(); raise InvalidProjectError("invalid project descriptor")
            try: self._descriptor = load_json(self._descriptor_path())
            except Exception as exc:
                self.close(); raise RecoveryRequiredError("project descriptor requires recovery") from exc
        # Newer, malformed or unreachable format versions are refused here;
        # an older one yields the ordered steps that upgrade it after recovery.
        # A refused or unfinished upgrade clears the descriptor before close so
        # asset pruning never judges references it cannot read.
        try: pending = _migrations.active_registry().plan(self._descriptor.get("schemaVersion"), VERSION)
        except UnsupportedVersionError: self._descriptor = {}; self.close(); raise
        if not pending:
            try: validate_project_descriptor(self._descriptor)
            except ValueError as exc: self.close(); raise InvalidProjectError(str(exc)) from exc
        try:
            if self.read_only and pending:
                raise UnsupportedVersionError("project must be opened for writing to upgrade its format")
            if self.read_only:
                txdir = self.path / ".auvra" / "transactions"
                for journal in txdir.glob("*.json") if txdir.exists() else ():
                    try:
                        transaction = load_json(journal)
                    except Exception as exc:
                        raise RecoveryRequiredError("project recovery requires the writer lock") from exc
                    if transaction.get("state") != "committed":
                        raise RecoveryRequiredError("project recovery requires the writer lock")
            else:
                self._recover()
            # Blob deletions use a durable same-volume staging name. Replay
            # their commit point before the strict manifest/file-set check;
            # read-only openers may inspect but never repair a missing blob.
            try:
                ready = self.assets.recover_pending_deletions(writable=not self.read_only)
            except ValueError as exc:
                raise InvalidProjectError(str(exc)) from exc
            if not ready:
                raise RecoveryRequiredError("pending asset deletion requires the writer lock")
            self._reconcile_recovery_assets(writable=not self.read_only)
            if pending: self._migrate()
            _validate_project_tree(self.path, allow_internal=True)
        except Exception:
            # A failed open must not prune assets from an unvalidated tree.
            # In particular, an interrupted deletion can still need its
            # manifest-listed blob restored from staging on the next attempt.
            self._descriptor = {}
            self.close()
            raise

    def _reconcile_recovery_assets(self, *, writable: bool) -> None:
        """Finish an interrupted restore before validating the live asset set.

        The ready marker is durable before the first live blob is installed.
        Incomplete staging is never published; prepared staging is replayable
        whether the document transaction kept its old or new generation.
        """
        internal = self.path / ".auvra"
        for staging in sorted(internal.glob(".recovery-assets-*")):
            if not staging.is_dir() or _is_reparse(staging):
                raise RecoveryRequiredError("unsafe pending recovery assets")
            ready = staging / ".ready"
            if not ready.exists():
                if writable:
                    shutil.rmtree(staging)
                continue
            if not ready.is_file() or _is_reparse(ready) or ready.read_text(encoding="ascii") != "ready\n":
                raise RecoveryRequiredError("damaged pending recovery assets")
            if not writable:
                raise RecoveryRequiredError("asset recovery requires the writer lock")
            self._publish_recovery_assets(staging)

    def _publish_recovery_assets(self, staging: Path) -> None:
        """Replay a prepared union manifest and its verified snapshot blobs."""
        manifest_file = staging / "manifest.json"
        if not manifest_file.is_file() or _is_reparse(manifest_file):
            raise RecoveryRequiredError("pending recovery manifest is missing")
        try:
            desired = load_json(manifest_file)
        except (OSError, ValueError) as exc:
            raise RecoveryRequiredError("pending recovery manifest is invalid") from exc
        if not isinstance(desired, dict):
            raise RecoveryRequiredError("pending recovery manifest is invalid")
        live_content = self.path / "Content" / "sha256"
        staged: dict[str, Path] = {}
        for source in staging.iterdir():
            if source.name in (".ready", "manifest.json"):
                continue
            if (not source.is_file() or _is_reparse(source)
                    or not re.fullmatch(r"[0-9a-f]{64}", source.name)
                    or source.name not in desired):
                raise RecoveryRequiredError("pending recovery contains unsafe content")
            digest = hashlib.sha256()
            with source.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != source.name:
                raise RecoveryRequiredError("pending recovery asset hash mismatch")
            staged[source.name] = source
        for asset_id, metadata in desired.items():
            if (not isinstance(asset_id, str) or not re.fullmatch(r"[0-9a-f]{64}", asset_id)
                    or not isinstance(metadata, dict) or set(metadata) != {"size", "mime", "name"}
                    or not isinstance(metadata["size"], int) or isinstance(metadata["size"], bool)
                    or metadata["size"] < 0 or not isinstance(metadata["mime"], str)
                    or (metadata["name"] is not None and not isinstance(metadata["name"], str))):
                raise RecoveryRequiredError("pending recovery asset metadata is invalid")
            if asset_id in staged and staged[asset_id].stat().st_size != metadata["size"]:
                raise RecoveryRequiredError("pending recovery asset size mismatch")
            if asset_id not in staged and not self.assets.verify(asset_id, expected_size=metadata["size"]):
                raise RecoveryRequiredError("pending recovery is missing an existing asset")
        incoming = live_content / ".incoming"
        incoming.mkdir(parents=True, exist_ok=True)
        if _is_reparse(incoming):
            raise RecoveryRequiredError("unsafe recovery asset staging directory")
        for asset_id, source in staged.items():
            target = live_content / asset_id
            if target.exists() and _is_reparse(target):
                raise RecoveryRequiredError("unsafe existing recovery asset")
            if self.assets.verify(asset_id, expected_size=desired[asset_id]["size"]):
                continue
            temporary = incoming / f"restore-{uuid.uuid4().hex}"
            try:
                shutil.copy2(source, temporary)
                _fsync_file(temporary)
                os.replace(temporary, target)
                _fsync_directory(live_content)
            finally:
                temporary.unlink(missing_ok=True)
        temporary = incoming / f"restore-manifest-{uuid.uuid4().hex}"
        try:
            shutil.copy2(manifest_file, temporary)
            _fsync_file(temporary)
            os.replace(temporary, self.path / "Content" / "manifest.json")
            _fsync_directory(self.path / "Content")
        finally:
            temporary.unlink(missing_ok=True)
        # Clear the replay marker only after the live manifest is durable.
        # A crash during directory cleanup must not leave a half-removed plan
        # that appears ready to replay.
        (staging / ".ready").unlink()
        _fsync_directory(staging)
        shutil.rmtree(staging)
        _fsync_directory(staging.parent)

    def _migrate(self) -> None:
        """Upgrade an older project format in one recoverable transaction."""
        raw = {domain: load_json(self._domain_path(domain)) for domain in DOMAIN_NAMES
               if self._domain_path(domain).is_file()}
        result = _migrations.active_registry().migrate(self._descriptor, raw, VERSION)
        try:
            descriptor = validate_project_descriptor(result.descriptor)
            unknown = set(result.domains) - set(DOMAIN_NAMES)
            if unknown: raise ValueError(f"unknown project domain: {sorted(unknown)[0]}")
            migrated = {domain: validate_domain(domain, value) for domain, value in result.domains.items()}
            validate_project_references({domain: migrated.get(domain) or self.get_domain(domain)
                                         for domain in DOMAIN_NAMES}, asset_exists=self.assets.verify)
        except ValueError as exc:
            raise _migrations.ProjectMigrationError(f"migrated project is invalid: {exc}") from exc
        new_revision = self.revision + 1
        self._descriptor = descriptor
        self._transaction({domain: value for domain, value in migrated.items() if raw.get(domain) != value},
                          new_revision)

    def _recover_descriptor(self) -> bool:
        txdir = self.path / ".auvra" / "transactions"
        for journal in txdir.glob("*.json") if txdir.exists() else ():
            try: tx = load_json(journal)
            except Exception: continue
            entry = tx.get("descriptor")
            if not isinstance(entry, dict): continue
            try: backup = _journal_path(self.path, entry.get("backup"), "staging")
            except RecoveryRequiredError: continue
            if backup.is_file():
                os.replace(backup, self._descriptor_path())
                _fsync_directory(self.path)
                return True
        return False

    def _recover(self) -> None:
        txdir = self.path / ".auvra" / "transactions"
        if not txdir.exists(): return
        for journal in txdir.glob("*.json"):
            try: tx = load_json(journal)
            except Exception: raise RecoveryRequiredError("corrupt transaction journal requires recovery")
            staging_roots: set[Path] = set()
            entries = tx.get("files", [])
            if not isinstance(entries, list):
                raise RecoveryRequiredError("transaction journal files are invalid")
            for entry in [*entries, tx.get("descriptor", {})]:
                if isinstance(entry, dict) and entry.get("staged"):
                    staging_roots.add(_journal_path(self.path, entry.get("staged"), "staging").parent)
            if tx.get("state") == "committed":
                journal.unlink(missing_ok=True)
                # A committed journal intentionally contains only the final
                # state, so recover any orphaned staging trees left by a crash
                # between the commit marker and journal cleanup.
                staging_roots.update(path for path in txdir.parent.glob("tx-*") if path.is_dir())
                for staging_root in staging_roots:
                    shutil.rmtree(staging_root, ignore_errors=True)
                continue
            # Descriptor is the commit point. Restore the old generation when it
            # was not advanced; finish staged documents when it was advanced.
            if self._descriptor.get("revision") == tx.get("newRevision"):
                for entry in entries:
                    staged = _journal_path(self.path, entry.get("staged"), "staging")
                    target = _journal_path(self.path, entry.get("target"), "project")
                    if staged.exists(): os.replace(staged, target)
                descriptor = tx.get("descriptor", {})
                staged = _journal_path(self.path, descriptor.get("staged"), "staging") if descriptor else None
                target = self._descriptor_path() if descriptor else None
                if staged and target and staged.exists(): os.replace(staged, target)
                _fsync_directory(self.path / "Project")
            else:
                for entry in tx.get("files", []):
                    backup = _journal_path(self.path, entry.get("backup"), "staging")
                    target = _journal_path(self.path, entry.get("target"), "project")
                    if backup.exists(): os.replace(backup, target)
                    elif not entry.get("existed", True): target.unlink(missing_ok=True)
                    else: raise RecoveryRequiredError("transaction backup is missing")
                descriptor = tx.get("descriptor", {})
                backup = _journal_path(self.path, descriptor.get("backup"), "staging") if descriptor else None
                target = self._descriptor_path() if descriptor else None
                if backup and target and backup.exists(): os.replace(backup, target)
                elif descriptor: raise RecoveryRequiredError("descriptor transaction backup is missing")
                _fsync_directory(self.path / "Project")
            _fsync_directory(self.path / ".auvra")
            journal.unlink(missing_ok=True)
            _fsync_directory(txdir)
            for staging_root in staging_roots:
                shutil.rmtree(staging_root, ignore_errors=True)

    @property
    def status(self) -> ProjectStatus:
        return ProjectStatus(self._descriptor["projectId"], self._descriptor["name"], self.revision, self._dirty, self.read_only)
    @property
    def project_id(self): return self._descriptor["projectId"]
    @property
    def revision(self): return self._descriptor["revision"]
    @property
    def name(self): return self._descriptor["name"]
    @property
    def assets(self): return AssetStore(self.path / "Content")

    def _domain_path(self, domain: str) -> Path:
        if domain not in DOMAIN_NAMES: raise KeyError(domain)
        return self.path / "Project" / f"{domain}.json"
    def get_domain(self, domain: str) -> dict[str, Any]:
        path = self._domain_path(domain)
        if not path.exists(): return domain_document(domain, [])
        return validate_domain(domain, load_json(path))

    def referenced_asset_ids(self, domains: dict[str, Any] | None = None) -> set[str]:
        """Return every asset needed by live documents, including source provenance."""

        # Share the schema validator's recursive handle traversal so cleanup
        # cannot discard a valid animationAssetIds (or other nested) reference.
        # Keep inputAssetIds provenance even though playback does not require it.
        selected = domains if domains is not None else {
            domain: self.get_domain(domain) for domain in DOMAIN_NAMES
        }
        return {
            asset_id for document in selected.values()
            for asset_id in _asset_handles(document, history=True)
        }

    def prune_unreferenced_assets(self, candidates: Iterable[str] | None = None) -> set[str]:
        """Delete blobs no longer reachable from the live project."""

        return self.assets.remove_unreferenced(self.referenced_asset_ids(), candidates)

    def discard_asset_if_unreferenced(self, asset_id: str) -> bool:
        """Remove one blob only when no live document points to it."""

        if asset_id in self.referenced_asset_ids():
            return False
        return self.assets.remove(asset_id)
    def snapshot(self, domains: Iterable[str] | None = None, *, page: int = 0, page_size: int | None = None,
                 offset: int | None = None) -> ProjectSnapshot:
        if not isinstance(page, int) or page < 0: raise ValueError("page must be a non-negative integer")
        page_size = self.page_size if page_size is None else page_size
        if not isinstance(page_size, int) or not 1 <= page_size <= 1000: raise ValueError("page_size must be between 1 and 1000")
        if offset is not None and (not isinstance(offset, int) or offset < 0): raise ValueError("offset must be a non-negative integer")
        requested = list(domains or DOMAIN_NAMES); result = {}
        for domain in requested:
            doc = self.get_domain(domain); values = doc["documents"]
            start = offset if offset is not None else page * page_size
            result[domain] = {"schemaVersion": 1, "documents": values[start:start + page_size], "hasMore": start + page_size < len(values)}
        return ProjectSnapshot(self.project_id, self.revision, result, page, page_size)

    def apply_changes(self, changes: dict[str, list[dict[str, Any]]], *, expected_revision: int) -> int:
        if self.read_only: raise ReadOnlyError("project is read-only")
        if expected_revision != self.revision: raise RevisionConflictError("project revision changed")
        validated = {domain: domain_document(domain, copy.deepcopy(docs)) for domain, docs in changes.items()}
        candidate = {domain: (validated[domain] if domain in validated else self.get_domain(domain)) for domain in DOMAIN_NAMES}
        candidate_refs = self.referenced_asset_ids(candidate)
        superseded = (_superseded_terrain_assets(self.get_domain("objects"), validated["objects"])
                      if "objects" in validated else set())
        if "models" in validated:
            superseded |= _superseded_skin_paint(self.get_domain("models"), validated["models"])
        try:
            validate_project_references(candidate, asset_exists=self.assets.verify)
        except ValueError as exc:
            self.prune_unreferenced_assets(candidate_refs - self.referenced_asset_ids())
            raise InvalidProjectError(str(exc)) from exc
        try:
            self._transaction(validated, expected_revision + 1)
        except Exception:
            self.prune_unreferenced_assets(candidate_refs - self.referenced_asset_ids())
            raise
        self._dirty = True
        if superseded:
            # Every sculpt or paint stroke, terrain undo and redo commits a new
            # content-addressed heightfield or splat map (and every stroke on a
            # model, its painted weights), and the editor re-uploads any heights
            # or weights it needs again. Drop a replaced
            # one as soon as no committed document references it, instead of
            # keeping it in Content (and copying it into every recovery point)
            # until close.
            try:
                self.assets.remove_unreferenced(candidate_refs, superseded)
            except (OSError, ValueError):
                pass
        return self.revision

    def _transaction(self, docs: dict[str, dict[str, Any]], new_revision: int) -> None:
        txdir = self.path / ".auvra" / "transactions"; txdir.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix="tx-", dir=self.path / ".auvra"))
        entries = []; journal = None; committed = False
        try:
            for domain, value in docs.items():
                target = self._domain_path(domain); backup = staging / f"old-{domain}.json"; staged = staging / f"new-{domain}.json"
                existed = target.exists()
                if existed:
                    shutil.copy2(target, backup); _fsync_file(backup)
                dump_json(staged, value)
                entries.append({"target": f"Project/{domain}.json", "backup": f"staging/{staging.name}/{backup.name}", "staged": f"staging/{staging.name}/{staged.name}", "existed": existed})
            descriptor_target = self._descriptor_path()
            descriptor_backup = staging / "old-descriptor.auvra"
            descriptor_staged = staging / "new-descriptor.auvra"
            shutil.copy2(descriptor_target, descriptor_backup); _fsync_file(descriptor_backup)
            descriptor = dict(self._descriptor); descriptor["revision"] = new_revision; descriptor["updatedAt"] = time.time()
            _migrations.stamp_engine_version(descriptor)
            dump_json(descriptor_staged, descriptor)
            journal = txdir / f"{uuid.uuid4()}.json"
            descriptor_entry = {"target": f"{descriptor_target.name}", "backup": f"staging/{staging.name}/{descriptor_backup.name}", "staged": f"staging/{staging.name}/{descriptor_staged.name}", "existed": True}
            atomic_dump_json(journal, {"state":"prepared", "oldRevision":self.revision, "newRevision":new_revision, "files":entries, "descriptor":descriptor_entry})
            _fsync_directory(staging); _fsync_directory(txdir)
            for entry in entries:
                target = self.path / entry["target"]
                staged = staging / Path(entry["staged"]).name
                target.parent.mkdir(parents=True, exist_ok=True); os.replace(staged, target)
                _fsync_directory(target.parent)
            os.replace(descriptor_staged, descriptor_target)
            _fsync_directory(self.path)
            self._descriptor = descriptor
            atomic_dump_json(journal, {"state":"committed", "newRevision":new_revision})
            journal.unlink(missing_ok=True)
            _fsync_directory(txdir)
            committed = True
        finally:
            # An interrupted transaction must retain both its journal and
            # same-volume staging directory so the next opener can select the
            # complete old or complete new generation.
            if committed or journal is None or not journal.exists():
                shutil.rmtree(staging, ignore_errors=True)

    def save(self, *, expected_revision: int | None = None) -> int:
        if expected_revision is not None and expected_revision != self.revision: raise RevisionConflictError("project revision changed")
        if self.read_only: raise ReadOnlyError("project is read-only")
        self._retain_recovery("manual")
        self._dirty = False
        return self.revision
    def save_as(self, destination: str | os.PathLike[str], *, name: str | None = None) -> "ProjectRepository":
        if self.read_only: raise ReadOnlyError("project is read-only")
        destination = Path(destination)
        if _destination_is_inside(self.path, destination):
            raise InvalidProjectError("Save As destination must be outside the source project")
        if destination.exists(): raise InvalidProjectError("Save As destination already exists")
        new_name = name or destination.name
        if not new_name or any(c in new_name for c in "/\\"):
            raise InvalidProjectError("invalid project name")
        parent = destination.parent; parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.saveas-", dir=parent))
        try:
            shutil.copytree(self.path, staging, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".auvra", ".incoming"))
            descriptor_files = [p for p in staging.glob("*.auvra") if p.is_file()]
            if len(descriptor_files) != 1: raise InvalidProjectError("source has no unique descriptor")
            descriptor = load_json(descriptor_files[0]); descriptor.update(
                projectId=str(uuid.uuid4()), name=new_name, revision=0,
                createdAt=time.time(), updatedAt=time.time(), engineVersion=_migrations.ENGINE_VERSION)
            old = descriptor_files[0]; new = staging / f"{new_name}.auvra"; dump_json(new, descriptor)
            if old.resolve() != new.resolve(): old.unlink()
            try: _validate_project_tree(staging)
            except ValueError as exc: raise InvalidProjectError(str(exc)) from exc
            # Publish the lock/transaction authority as part of the staged
            # tree; a crash after the rename must still leave an openable copy.
            (staging / ".auvra" / "transactions").mkdir(parents=True, exist_ok=True)
            _fsync_tree(staging); os.replace(staging, destination)
            _fsync_directory(destination / ".auvra"); _fsync_directory(parent); staging = None
            return ProjectRepository(destination)
        finally:
            if staging is not None: shutil.rmtree(staging, ignore_errors=True)
    def _retain_recovery(self, kind: str) -> None:
        root = self.path / ".auvra" / ("autosaves" if kind == "autosave" else "backups")
        root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{kind}-", dir=root))
        stamp = root / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        try:
            # Build the entire point outside its published name. Every domain
            # is materialized, so restore cannot interpret a missing file as
            # an empty domain after an interrupted copy.
            descriptor = self._descriptor_path()
            shutil.copy2(descriptor, staging / descriptor.name)
            for domain in DOMAIN_NAMES:
                dump_json(staging / f"{domain}.json", self.get_domain(domain))

            # Keep the immutable content referenced by the captured documents
            # alongside their JSON. This prevents later asset cleanup from
            # making an otherwise valid recovery point unusable.
            snapshot_content = staging / "Content" / "sha256"
            snapshot_content.mkdir(parents=True, exist_ok=True)
            source_content = self.path / "Content" / "sha256"
            if not source_content.is_dir() or _is_reparse(source_content):
                raise InvalidProjectError("project asset store is unavailable")
            for source in source_content.iterdir():
                if source.name == ".incoming":
                    continue
                if not source.is_file() or _is_reparse(source):
                    raise InvalidProjectError("project asset store contains unsafe content")
                shutil.copy2(source, snapshot_content / source.name)
            manifest = self.path / "Content" / "manifest.json"
            if manifest.is_file() and not _is_reparse(manifest):
                shutil.copy2(manifest, staging / "Content" / "manifest.json")
            else:
                dump_json(staging / "Content" / "manifest.json", {})

            # Publish the completion marker last, then atomically rename the
            # fully fsynced staging tree under its final recovery-point name.
            (staging / _RECOVERY_COMPLETE).write_text(
                "auvra-recovery/1\n", encoding="ascii", newline="\n"
            )
            _fsync_tree(staging)
            os.replace(staging, stamp)
            _fsync_directory(root)
            staging = None
        finally:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
        limit = AUTOSAVE_LIMIT if kind == "autosave" else MANUAL_LIMIT
        points = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p:p.stat().st_mtime, reverse=True)
        for point in points[limit:]: shutil.rmtree(point, ignore_errors=True)
        cutoff = time.time() - RECOVERY_MAX_AGE_SECONDS
        for point in points[:limit]:
            try:
                if point.stat().st_mtime < cutoff:
                    shutil.rmtree(point, ignore_errors=True)
            except OSError:
                continue
        all_points = []
        for recovery_root in (self.path / ".auvra" / "backups", self.path / ".auvra" / "autosaves"):
            if recovery_root.exists():
                all_points.extend((p, recovery_root) for p in recovery_root.iterdir() if p.is_dir())
        all_points.sort(key=lambda pair: pair[0].stat().st_mtime)
        total = sum(f.stat().st_size for point, _ in all_points for f in point.rglob("*") if f.is_file())
        while all_points and total > PROJECT_CAP:
            point, _ = all_points.pop(0)
            total -= sum(f.stat().st_size for f in point.rglob("*") if f.is_file())
            shutil.rmtree(point, ignore_errors=True)
    def autosave_due(self, *, dirty_since: float | None, last_mutation: float | None, now: float | None = None) -> bool:
        if self.read_only or not self._dirty or dirty_since is None or last_mutation is None: return False
        now = now or time.time(); return now - dirty_since >= 60 and now - last_mutation >= 5
    def autosave(self) -> int:
        if self.read_only: raise ReadOnlyError("project is read-only")
        self._retain_recovery("autosave"); return self.revision
    def recovery_points(self, kind: str | None = None) -> list[dict[str, Any]]:
        kinds = [kind] if kind in ("manual", "autosave") else ["manual", "autosave"]
        output = []
        # A finished recovery point never changes, so each is checked and measured once (keyed by its
        # modification time, in case one is replaced under the same name). Every host reply that
        # carries the project status lists the points, so a rescan of each snapshot's files there
        # would slow every request.
        sizes: dict[tuple[str, str, int], int] = self.__dict__.setdefault("_recovery_sizes", {})
        for selected in kinds:
            root = self.path / ".auvra" / ("autosaves" if selected == "autosave" else "backups")
            if not root.exists(): continue
            cutoff = time.time() - RECOVERY_MAX_AGE_SECONDS
            stamped: list[tuple[int, str]] = []
            with os.scandir(root) as listing:
                names = [entry.name for entry in listing if not entry.name.startswith(".") and entry.is_dir()]
            for name in names:
                # The folder's own time, not the listing's copy (NTFS updates that one lazily): it
                # changes when anything is added to or removed from the point.
                try:
                    stamped.append((os.stat(root / name).st_mtime_ns, name))
                except OSError:
                    continue
            for mtime_ns, name in sorted(stamped, reverse=True):
                if mtime_ns / 1e9 < cutoff:
                    continue
                key = (selected, name, mtime_ns)
                size = sizes.get(key)
                if size is None:
                    point = root / name
                    if not _recovery_point_complete(point):
                        continue
                    size = sum(
                        f.stat().st_size for f in point.rglob("*")
                        if f.is_file() and not _is_reparse(f)
                    )
                    sizes[key] = size
                output.append({"kind": selected, "name": name, "size": size})
        return output
    def restore_recovery(self, kind: str, name: str) -> int:
        if self.read_only: raise ReadOnlyError("project is read-only")
        if kind not in ("manual", "autosave") or not name or any(part in ("", ".", "..") for part in Path(name).parts) or Path(name).name != name:
            raise InvalidProjectError("invalid recovery point")
        point = self.path / ".auvra" / ("autosaves" if kind == "autosave" else "backups") / name
        if not point.is_dir() or _is_reparse(point): raise InvalidProjectError("recovery point not found")
        marker = point / _RECOVERY_COMPLETE
        if not marker.is_file() or _is_reparse(marker):
            raise InvalidProjectError("recovery point is incomplete")
        descriptor_files = [path for path in point.glob("*.auvra") if path.is_file() and not _is_reparse(path)]
        if len(descriptor_files) != 1:
            raise InvalidProjectError("recovery point descriptor is missing")
        try:
            validate_project_descriptor(load_json(descriptor_files[0]))
        except (OSError, ValueError) as exc:
            raise InvalidProjectError("recovery point descriptor is invalid") from exc
        expected_entries = {_RECOVERY_COMPLETE, descriptor_files[0].name, "Content"} | {
            f"{domain}.json" for domain in DOMAIN_NAMES
        }
        for entry in point.iterdir():
            if entry.name not in expected_entries or _is_reparse(entry):
                raise InvalidProjectError("recovery point contains unknown data")
        snapshot_content = point / "Content" / "sha256"
        snapshot_manifest = point / "Content" / "manifest.json"
        if (not snapshot_content.is_dir() or _is_reparse(snapshot_content) or
                not snapshot_manifest.is_file() or _is_reparse(snapshot_manifest)):
            raise InvalidProjectError("recovery point assets are incomplete")
        docs = {}
        for path in point.glob("*.json"):
            if path.stem not in DOMAIN_NAMES: raise InvalidProjectError("recovery point contains unknown data")
        for domain in DOMAIN_NAMES:
            path = point / f"{domain}.json"
            if _recovery_domain_absent(point, domain):
                docs[domain] = domain_document(domain, [])
                continue
            if not path.is_file() or _is_reparse(path):
                raise InvalidProjectError("recovery point domain is incomplete")
            docs[domain] = validate_domain(domain, load_json(path))

        # Verify the captured content before touching the live project.  The
        # manifest is opaque metadata, but every stored blob must still match
        # its content address and every manifest entry must have a blob.
        try:
            manifest = load_json(snapshot_manifest)
        except Exception as exc:
            raise InvalidProjectError("recovery point asset manifest is invalid") from exc
        if not isinstance(manifest, dict):
            raise InvalidProjectError("recovery point asset manifest is invalid")
        snapshot_ids: set[str] = set()
        for asset in snapshot_content.iterdir():
            snapshot_ids.add(asset.name)
            if not asset.is_file() or _is_reparse(asset) or not re.fullmatch(r"[0-9a-f]{64}", asset.name):
                raise InvalidProjectError("recovery point contains unsafe asset")
            digest = hashlib.sha256()
            with asset.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != asset.name:
                raise InvalidProjectError("recovery point asset hash mismatch")
        for asset_id, metadata in manifest.items():
            if not re.fullmatch(r"[0-9a-f]{64}", asset_id) or not isinstance(metadata, dict):
                raise InvalidProjectError("recovery point asset manifest is invalid")
            if not (snapshot_content / asset_id).is_file():
                raise InvalidProjectError("recovery point asset manifest is incomplete")
            if (set(metadata) != {"size", "mime", "name"}
                    or not isinstance(metadata["size"], int) or isinstance(metadata["size"], bool)
                    or metadata["size"] < 0 or metadata["size"] != (snapshot_content / asset_id).stat().st_size
                    or not isinstance(metadata["mime"], str)
                    or (metadata["name"] is not None and not isinstance(metadata["name"], str))):
                raise InvalidProjectError("recovery point asset metadata is invalid")
            with (snapshot_content / asset_id).open("rb") as stream:
                detected = sniff_mime(stream.read(512))
            if metadata["mime"] in {"image/png", "image/jpeg", "audio/wav", "audio/ogg", "model/gltf-binary"} and metadata["mime"] != detected:
                raise InvalidProjectError("recovery point asset MIME is invalid")
        if set(manifest) != snapshot_ids:
            raise InvalidProjectError("recovery point asset manifest does not match stored content")
        try:
            validate_project_references(docs, asset_exists=lambda asset_id: asset_id in manifest)
        except ValueError as exc:
            raise InvalidProjectError("recovery point references invalid assets or documents") from exc

        # Retain the current content records alongside the snapshot's. A
        # successful restore can later prune extras, but replacing the manifest
        # while keeping post-snapshot blobs would make the project unopenable.
        live_manifest = self.path / "Content" / "manifest.json"
        if live_manifest.exists() and _is_reparse(live_manifest):
            raise InvalidProjectError("project asset manifest is unsafe")
        try:
            live_entries = load_json(live_manifest) if live_manifest.is_file() else {}
        except (OSError, ValueError) as exc:
            raise InvalidProjectError("project asset manifest is invalid") from exc
        if not isinstance(live_entries, dict):
            raise InvalidProjectError("project asset manifest is invalid")
        merged = {**live_entries, **manifest}

        # Prepare a durable replay plan before altering live content. It
        # remains in .auvra if copying a blob, publishing the manifest or
        # committing the document generation is interrupted.
        asset_staging = Path(tempfile.mkdtemp(prefix=".recovery-assets-", dir=self.path / ".auvra"))
        prepared = False
        try:
            for source in snapshot_content.iterdir():
                shutil.copy2(source, asset_staging / source.name)
            dump_json(asset_staging / "manifest.json", merged)
            _fsync_tree(asset_staging)
            (asset_staging / ".ready").write_text("ready\n", encoding="ascii", newline="\n")
            _fsync_file(asset_staging / ".ready")
            _fsync_directory(asset_staging)
            prepared = True

            try:
                self._publish_recovery_assets(asset_staging)
                revision = self.revision + 1
                self._transaction(docs, revision)
            except Exception:
                # A journal may finish the NEW document revision on reopen.
                # Never prune snapshot blobs based on the old documents while
                # that decision remains unresolved.
                self.__dict__["_skip_asset_prune"] = True
                raise
            self._dirty = True
            try:
                # Keep every asset captured by the point, even if it was not
                # referenced by a document. Only discard newer extra blobs.
                self.prune_unreferenced_assets(set(live_entries) - set(manifest))
            except (OSError, ValueError):
                # Two-phase deletion keeps even locked extras recoverable.
                pass
            return revision
        finally:
            if not prepared:
                shutil.rmtree(asset_staging, ignore_errors=True)
    def export_pack(self, destination: str | os.PathLike[str]) -> None:
        if _destination_is_inside(self.path, Path(destination)):
            raise InvalidProjectError("export destination must be outside the source project")
        _validate_project_tree(self.path, allow_internal=True)
        export_folder(self.path, destination)
    @classmethod
    def import_pack(cls, archive: str | os.PathLike[str], destination: str | os.PathLike[str]) -> "ProjectRepository":
        destination = Path(destination)
        if destination.exists(): raise InvalidProjectError("import destination already exists")
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.import-", dir=destination.parent))
        try:
            # Keep validation and extraction on the same open archive handle.
            # Reopening by pathname after validation permits a replacement
            # archive to swap in traversal members or oversized content.
            try:
                z = zipfile.ZipFile(archive)
            except (OSError, zipfile.BadZipFile) as exc:
                raise ArchiveValidationError("invalid ZIP archive") from exc
            with z:
                infos = validate_archive(z)
                for info in infos:
                    if info.is_dir():
                        (staging / Path(info.filename)).mkdir(parents=True, exist_ok=True)
                        continue
                    out = staging / Path(info.filename)
                    out.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(info) as src, out.open("wb") as dst: shutil.copyfileobj(src, dst, 1024 * 1024)
            try: _validate_project_tree(staging)
            except ValueError as exc: raise InvalidProjectError(str(exc)) from exc
            # The authority directory is part of the staged project rather
            # than a post-rename repair step.
            (staging / ".auvra" / "transactions").mkdir(parents=True, exist_ok=True)
            _fsync_tree(staging); os.replace(staging, destination)
            _fsync_directory(destination / ".auvra"); _fsync_directory(destination.parent); staging = None
            return cls(destination)
        except Exception:
            raise
        finally:
            if staging is not None: shutil.rmtree(staging, ignore_errors=True)
    @staticmethod
    def import_legacy(source: str | os.PathLike[str]) -> tuple[dict[str, Any], Any]: return LegacyArchive(source).migrate()
    def close(self) -> None:
        if not self.read_only and self._descriptor and not self.__dict__.get("_skip_asset_prune", False):
            try:
                self.prune_unreferenced_assets()
            except (OSError, ValueError):
                pass
        self._lock.release()
    def __enter__(self): return self
    def __exit__(self, *_): self.close()

def _fsync_directory(path: Path) -> None:
    """Persist directory entries where the platform exposes directory fsync."""
    try:
        fd = os.open(path, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    except (OSError, ValueError):
        # Windows does not expose ordinary directories as fsync-able handles.
        pass

def _fsync_file(path: Path) -> None:
    with path.open("rb+") as stream: os.fsync(stream.fileno())

def _fsync_tree(root: Path) -> None:
    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_file():
            _fsync_file(path)
        elif path.is_dir():
            _fsync_directory(path)

_TERRAIN_ASSET_KEYS = ("heightfield", "splatmap", "splatmap2", "holemap")

def _terrain_assets(objects: dict[str, Any]) -> dict[tuple[Any, str], str]:
    """Map each (terrain object id, terrainData key) to its heightfield or splat map asset id."""
    references: dict[tuple[Any, str], str] = {}
    for document in objects.get("documents", []):
        terrain = document.get("terrainData") if isinstance(document, dict) else None
        if not isinstance(terrain, dict):
            continue
        for key in _TERRAIN_ASSET_KEYS:
            reference = terrain.get(key)
            if isinstance(reference, dict) and isinstance(reference.get("assetId"), str):
                references[(document.get("id"), key)] = reference["assetId"]
    for document in objects.get("documents", []):
        foliage = document.get("foliageData") if isinstance(document, dict) else None
        for foliage_type in (foliage.get("types") or []) if isinstance(foliage, dict) else []:
            reference = foliage_type.get("instancemap") if isinstance(foliage_type, dict) else None
            if isinstance(reference, dict) and isinstance(reference.get("assetId"), str):
                references[(document.get("id"), f"foliage:{foliage_type.get('id')}")] = reference["assetId"]
    return references

def _superseded_terrain_assets(previous: dict[str, Any], committed: dict[str, Any]) -> set[str]:
    """Heightfields and splat maps that a kept object document replaced with another one.

    Only replacements count: a deleted terrain keeps its assets until the
    project closes, so undoing the delete can still restore its references.
    """
    after = _terrain_assets(committed)
    kept = {document.get("id") for document in committed.get("documents", []) if isinstance(document, dict)}
    return {asset_id for (object_id, key), asset_id in _terrain_assets(previous).items()
            if object_id in kept and after.get((object_id, key)) != asset_id}

def _superseded_skin_paint(previous: dict[str, Any], committed: dict[str, Any]) -> set[str]:
    """Painted weights that a kept model document replaced or gave up."""
    after = {document.get("id"): document for document in committed.get("documents", []) if isinstance(document, dict)}
    superseded: set[str] = set()
    for document in previous.get("documents", []):
        reference = document.get("skinPaint") if isinstance(document, dict) else None
        kept = after.get(document.get("id")) if isinstance(document, dict) else None
        if not isinstance(reference, dict) or not isinstance(reference.get("assetId"), str) or kept is None:
            continue
        if (kept.get("skinPaint") or {}).get("assetId") != reference["assetId"]:
            superseded.add(reference["assetId"])
    return superseded

def _journal_path(project_root: Path, value: Any, area: str) -> Path:
    """Resolve only the journal's approved relative path namespaces."""
    if not isinstance(value, str) or not value or Path(value).is_absolute() or "\\" in value:
        raise RecoveryRequiredError("transaction journal contains an unsafe path")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts): raise RecoveryRequiredError("transaction journal contains an unsafe path")
    if area == "project":
        if len(parts) != 2 or parts[0] != "Project" or not parts[1].endswith(".json"):
            raise RecoveryRequiredError("transaction journal target is outside Project")
        return project_root.joinpath(*parts)
    if area == "staging":
        if len(parts) != 3 or parts[0] != "staging": raise RecoveryRequiredError("transaction journal staging path is invalid")
        root = (project_root / ".auvra" / parts[1]).resolve()
        allowed = (project_root / ".auvra").resolve()
        if allowed not in root.parents or root == allowed: raise RecoveryRequiredError("transaction journal staging path is invalid")
        return root / parts[2]
    raise RecoveryRequiredError("unknown transaction path area")

def _validate_project_tree(root: Path, *, allow_internal: bool = False) -> None:
    """Validate an extracted pack before it becomes an openable project."""
    allowed_top = {"Project", "Content", ".gitignore"} | {p.name for p in root.glob("*.auvra") if p.is_file()}
    if allow_internal: allowed_top.add(".auvra")
    for entry in root.iterdir():
        if entry.name not in allowed_top or _is_reparse(entry): raise InvalidProjectError("unknown or unsafe project tree entry")
    descriptor_files = [p for p in root.glob("*.auvra") if p.is_file()]
    if len(descriptor_files) != 1:
        raise InvalidProjectError("pack must contain exactly one project descriptor")
    descriptor = load_json(descriptor_files[0])
    try: validate_project_descriptor(descriptor)
    except ValueError as exc: raise InvalidProjectError(str(exc)) from exc
    project_root = root / "Project"
    if not project_root.is_dir() or _is_reparse(project_root): raise InvalidProjectError("missing Project directory")
    domain_documents = {}
    for path in project_root.glob("*.json"):
        if _is_reparse(path): raise InvalidProjectError("unsafe project document")
        domain = path.stem
        if domain not in DOMAIN_NAMES: raise InvalidProjectError("unknown project document")
        try: domain_documents[domain] = validate_domain(domain, load_json(path))
        except ValueError as exc: raise InvalidProjectError(str(exc)) from exc
    if any(p.is_dir() for p in project_root.iterdir()): raise InvalidProjectError("nested Project directories are not allowed")
    if any(p.is_file() and (p.suffix != ".json" or p.stem not in DOMAIN_NAMES) for p in project_root.iterdir()): raise InvalidProjectError("unknown project file")
    content = root / "Content" / "sha256"
    if not (root / "Content").is_dir() or _is_reparse(root / "Content") or not content.is_dir() or _is_reparse(content): raise InvalidProjectError("missing Content directory")
    if content.exists() and any(p.is_dir() and not (allow_internal and p.name == ".incoming") for p in content.iterdir()):
        raise InvalidProjectError("nested content paths are not allowed")
    asset_paths = {p.name: p for p in content.iterdir() if p.is_file()} if content.exists() else {}
    for asset_id, path in asset_paths.items():
        if _is_reparse(path): raise InvalidProjectError("unsafe asset entry")
        if not re.fullmatch(r"[0-9a-f]{64}", asset_id): raise InvalidProjectError("invalid content-addressed asset")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""): digest.update(block)
        if digest.hexdigest() != asset_id: raise InvalidProjectError("asset hash mismatch")
    manifest = root / "Content" / "manifest.json"
    content_root = root / "Content"
    if any(p.name not in ("sha256", "manifest.json") for p in content_root.iterdir()): raise InvalidProjectError("unknown Content entry")
    if asset_paths and not manifest.is_file(): raise InvalidProjectError("missing asset manifest")
    if manifest.exists():
        if _is_reparse(manifest): raise InvalidProjectError("unsafe asset manifest")
        manifest_data = load_json(manifest)
        if not isinstance(manifest_data, dict): raise InvalidProjectError("invalid asset manifest")
        for asset_id, metadata in manifest_data.items():
            if asset_id not in asset_paths or not isinstance(metadata, dict): raise InvalidProjectError("invalid asset manifest entry")
            if set(metadata) != {"size", "mime", "name"} or not isinstance(metadata["size"], int) or metadata["size"] < 0 or not isinstance(metadata["mime"], str) or (metadata["name"] is not None and not isinstance(metadata["name"], str)):
                raise InvalidProjectError("invalid asset metadata")
            if metadata.get("size") != asset_paths[asset_id].stat().st_size: raise InvalidProjectError("asset size metadata mismatch")
            declared = metadata.get("mime")
            with asset_paths[asset_id].open("rb") as stream: detected = sniff_mime(stream.read(512))
            known_media = {"image/png", "image/jpeg", "audio/wav", "audio/ogg", "model/gltf-binary"}
            if declared in known_media and declared != detected: raise InvalidProjectError("asset MIME metadata mismatch")
        if set(manifest_data) != set(asset_paths):
            raise InvalidProjectError("asset manifest does not match stored content")
    references = set()
    def collect(value: Any, key: str = ""):
        if isinstance(value, dict):
            for child_key, child in value.items():
                if child_key == "assetId" and isinstance(child, str): references.add(child)
                elif child_key == "assetIds" and isinstance(child, list): references.update(x for x in child if isinstance(x, str))
                collect(child, child_key)
        elif isinstance(value, list):
            for child in value: collect(child, key)
    for path in project_root.glob("*.json"):
        try: collect(load_json(path))
        except Exception: continue
    missing = [asset_id for asset_id in references if asset_id not in asset_paths]
    if missing: raise InvalidProjectError("pack references missing assets")
    try:
        validate_project_references(
            domain_documents,
            asset_exists=lambda asset_id: asset_id in asset_paths,
        )
    except ValueError as exc:
        raise InvalidProjectError(str(exc)) from exc

def _recovery_domain_absent(point: Path, domain: str) -> bool:
    """True when a recovery point predates ``domain`` and so has no file for it.

    Only a domain added after points were first written may be absent, and
    only truly absent: a dangling link or other entry still fails closed.
    """
    return domain in _RECOVERY_LATER_DOMAINS and not os.path.lexists(point / f"{domain}.json")


def _is_reparse(path: Path) -> bool:
    try:
        if path.is_symlink(): return True
        return bool(getattr(path.stat(), "st_file_attributes", 0) & 0x400)
    except OSError:
        return True


def _destination_is_inside(source: Path, destination: Path) -> bool:
    """Reject output paths that resolve into the live project tree."""
    try:
        Path(destination).resolve(strict=False).relative_to(Path(source).resolve(strict=True))
        return True
    except (OSError, ValueError):
        return False

def _recovery_point_complete(point: Path) -> bool:
    """Whether a recovery point finished writing and holds every domain and its content."""
    marker = point / _RECOVERY_COMPLETE
    if not marker.is_file() or _is_reparse(marker):
        return False
    if any(not _recovery_domain_absent(point, domain) and
           (not (point / f"{domain}.json").is_file() or _is_reparse(point / f"{domain}.json"))
           for domain in DOMAIN_NAMES):
        return False
    snapshot_content = point / "Content" / "sha256"
    snapshot_manifest = point / "Content" / "manifest.json"
    return (snapshot_content.is_dir() and not _is_reparse(snapshot_content) and
            snapshot_manifest.is_file() and not _is_reparse(snapshot_manifest))


def _validate_open_boundaries(root: Path) -> None:
    """Reject linked project authority before opening the lock itself."""
    if not root.is_dir() or _is_reparse(root):
        raise InvalidProjectError("project root is missing or unsafe")
    for required in (root / "Project", root / "Content", root / "Content" / "sha256", root / ".auvra"):
        if not required.is_dir() or _is_reparse(required):
            raise InvalidProjectError("project authority directory is missing or unsafe")
    descriptors = [path for path in root.glob("*.auvra") if path.is_file()]
    if len(descriptors) != 1 or _is_reparse(descriptors[0]):
        raise InvalidProjectError("project requires one safe descriptor")
    # Recovery can replace authored documents before the later full schema and
    # hash audit. Reject linked authority now so journals cannot redirect that
    # recovery outside the project boundary.
    for area in (root / "Project", root / "Content", root / "Content" / "sha256"):
        for entry in area.iterdir():
            if _is_reparse(entry):
                raise InvalidProjectError("project authority contains a linked entry")
    internal = root / ".auvra"
    for entry in internal.rglob("*"):
        if _is_reparse(entry):
            raise InvalidProjectError("project internal state contains a linked entry")
