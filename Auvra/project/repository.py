"""Transactional native project repository."""
from __future__ import annotations

import copy, hashlib, json, os, re, shutil, tempfile, time, uuid, zipfile
import stat
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
from .schemas import (DOMAIN_NAMES, domain_document, validate_domain,
                      validate_project_descriptor, validate_project_references)
from .serialization import atomic_dump_json, canonical_json, dump_json, load_json

FORMAT = "auvra.project"
VERSION = 1
MANUAL_LIMIT = 5
AUTOSAVE_LIMIT = 10
PROJECT_CAP = 2 * 1024**3
RECOVERY_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
_RECOVERY_COMPLETE = ".complete"

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
                      "revision": 0, "createdAt": time.time(), "updatedAt": time.time()}
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
        if self._descriptor.get("schemaVersion") != VERSION: self.close(); raise UnsupportedVersionError("unsupported project version")
        try: validate_project_descriptor(self._descriptor)
        except ValueError as exc: self.close(); raise InvalidProjectError(str(exc)) from exc
        try:
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
            _validate_project_tree(self.path, allow_internal=True)
        except Exception:
            self.close()
            raise

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
            if tx.get("state") == "committed": journal.unlink(missing_ok=True); continue
            # Descriptor is the commit point. Restore the old generation when it
            # was not advanced; finish staged documents when it was advanced.
            if self._descriptor.get("revision") == tx.get("newRevision"):
                for entry in tx.get("files", []):
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
        """Return the content hashes reachable from the live project documents."""

        references: set[str] = set()

        def collect(value: Any) -> None:
            if isinstance(value, dict):
                for key, child in value.items():
                    if key == "assetId" and isinstance(child, str):
                        references.add(child)
                    elif key == "assetIds" and isinstance(child, list):
                        references.update(item for item in child if isinstance(item, str))
                    collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)

        selected = domains or {domain: self.get_domain(domain) for domain in DOMAIN_NAMES}
        for document in selected.values():
            collect(document)
        return references

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
            shutil.copytree(self.path, staging, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".auvra"))
            descriptor_files = [p for p in staging.glob("*.auvra") if p.is_file()]
            if len(descriptor_files) != 1: raise InvalidProjectError("source has no unique descriptor")
            descriptor = load_json(descriptor_files[0]); descriptor.update(
                projectId=str(uuid.uuid4()), name=new_name, revision=0,
                createdAt=time.time(), updatedAt=time.time())
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
        for selected in kinds:
            root = self.path / ".auvra" / ("autosaves" if selected == "autosave" else "backups")
            if not root.exists(): continue
            cutoff = time.time() - RECOVERY_MAX_AGE_SECONDS
            for point in sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p:p.stat().st_mtime, reverse=True):
                if point.name.startswith("."):
                    continue
                marker = point / _RECOVERY_COMPLETE
                if not marker.is_file() or _is_reparse(marker):
                    continue
                if any(not (point / f"{domain}.json").is_file() or _is_reparse(point / f"{domain}.json")
                       for domain in DOMAIN_NAMES):
                    continue
                snapshot_content = point / "Content" / "sha256"
                snapshot_manifest = point / "Content" / "manifest.json"
                if (not snapshot_content.is_dir() or _is_reparse(snapshot_content) or
                        not snapshot_manifest.is_file() or _is_reparse(snapshot_manifest)):
                    continue
                try:
                    if point.stat().st_mtime < cutoff:
                        continue
                except OSError:
                    continue
                output.append({
                    "kind": selected,
                    "name": point.name,
                    "size": sum(
                        f.stat().st_size for f in point.rglob("*")
                        if f.is_file() and not _is_reparse(f)
                    ),
                })
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
        for asset in snapshot_content.iterdir():
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

        # Stage captured assets under the project authority before the document
        # transaction validates cross-domain references. If the transaction
        # fails, restore the previous manifest; extra immutable blobs are safe.
        asset_staging = Path(tempfile.mkdtemp(prefix=".recovery-assets-", dir=self.path / ".auvra"))
        live_content = self.path / "Content" / "sha256"
        live_manifest = self.path / "Content" / "manifest.json"
        previous_manifest = asset_staging / "manifest.previous.json"
        manifest_existed = live_manifest.is_file()
        try:
            for source in snapshot_content.iterdir():
                shutil.copy2(source, asset_staging / source.name)
            shutil.copy2(snapshot_manifest, asset_staging / "manifest.json")
            _fsync_tree(asset_staging)
            for source in snapshot_content.iterdir():
                staged = asset_staging / source.name
                target = live_content / source.name
                if target.exists() and _is_reparse(target):
                    raise InvalidProjectError("project asset store contains a linked entry")
                if target.exists() and self.assets.verify(source.name):
                    staged.unlink(missing_ok=True)
                else:
                    os.replace(staged, target)
            if live_manifest.exists() and _is_reparse(live_manifest):
                raise InvalidProjectError("project asset manifest is unsafe")
            if manifest_existed:
                shutil.copy2(live_manifest, previous_manifest)
            os.replace(asset_staging / "manifest.json", live_manifest)

            revision = self.revision + 1
            self._transaction(docs, revision)
            self._dirty = True
            return revision
        except Exception:
            if previous_manifest.is_file():
                try:
                    os.replace(previous_manifest, live_manifest)
                except OSError:
                    pass
            elif not manifest_existed:
                live_manifest.unlink(missing_ok=True)
            raise
        finally:
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
        if not self.read_only and self._descriptor:
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
