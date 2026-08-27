"""Host-facing façade for native project operations.

The dispatcher can keep filesystem paths inside this service.  Its results are
status, revisions, snapshots, and opaque asset identifiers; callers do not
need or receive a filesystem authority.
"""
from __future__ import annotations
from pathlib import Path
import os, shutil, tempfile
from typing import BinaryIO, Iterable
from .assets import AssetReference
from .repository import ProjectRepository, ProjectSnapshot, ProjectStatus
from .index import ProjectIndex

class ProjectService:
    def __init__(self, index: ProjectIndex | None = None) -> None:
        self.active: ProjectRepository | None = None
        self.index = index or ProjectIndex()

    def _require(self, project_id: str | None = None) -> ProjectRepository:
        if self.active is None: raise RuntimeError("no project is open")
        if project_id is not None and self.active.project_id != project_id: raise ValueError("project identity mismatch")
        return self.active
    def _close_active(self) -> None:
        if self.active is not None: self.active.close(); self.active = None

    def _activate(self, candidate: ProjectRepository) -> ProjectStatus:
        old = self.active
        self.active = candidate
        if old is not None and old is not candidate:
            old.close()
        self._record()
        return candidate.status

    def create(self, path: str | Path, name: str | None = None) -> ProjectStatus:
        return self._activate(ProjectRepository.create(path, name))
    def open(self, path: str | Path) -> ProjectStatus:
        candidate_path = Path(path).absolute()
        if self.active is not None and self.active.path.absolute() == candidate_path:
            return self.active.status
        return self._activate(ProjectRepository(candidate_path))
    def close(self) -> None:
        self._close_active()
    def shutdown(self) -> None:
        self._close_active(); self.index.close()
    def get_status(self) -> ProjectStatus: return self._require().status
    def _record(self) -> None:
        if self.active is not None: self.index.record(self.active.project_id, self.active.name, str(self.active.path), self.active._descriptor.get("updatedAt", 0))
    def open_recent(self, project_id: str) -> ProjectStatus:
        matches = [row for row in self.index.recent(1000) if row[0] == project_id]
        if not matches: raise FileNotFoundError("recent project not found")
        return self.open(matches[0][2])
    def recent(self, limit: int = 20):
        return [{"projectId": row[0], "name": row[1], "available": Path(row[2]).is_dir()} for row in self.index.recent(limit)]
    def get_snapshot(self, domains: Iterable[str] | None = None, *, page: int = 0,
                     page_size: int | None = None, offset: int | None = None) -> ProjectSnapshot:
        return self._require().snapshot(domains, page=page, page_size=page_size, offset=offset)
    def apply_changes(self, changes: dict, *, project_id: str, expected_revision: int) -> ProjectStatus:
        repo = self._require(project_id); repo.apply_changes(changes, expected_revision=expected_revision); return repo.status
    def save(self, *, project_id: str, expected_revision: int | None = None) -> ProjectStatus:
        repo = self._require(project_id); repo.save(expected_revision=expected_revision); return repo.status
    def save_as(self, destination: str | Path, *, project_id: str, name: str | None = None) -> ProjectStatus:
        repo = self._require(project_id)
        return self._activate(repo.save_as(destination, name=name))
    def export_pack(self, destination: str | Path, *, project_id: str) -> None:
        self._require(project_id).export_pack(destination)
    def import_pack(self, archive: str | Path, destination: str | Path) -> ProjectStatus:
        candidate = ProjectRepository.import_pack(archive, destination)
        return self._activate(candidate)
    def import_legacy(self, source: str | Path): return ProjectRepository.import_legacy(source)
    def migrate_legacy(self, source: str | Path, destination: str | Path, *, name: str | None = None):
        """Validate and migrate a legacy archive, publishing only on success."""
        from .legacy import LegacyArchive, LegacyMigrationReport
        legacy = LegacyArchive(source)
        raw, report = legacy.inspect()
        destination = Path(destination)
        if destination.exists(): raise ValueError("migration destination already exists")
        destination.parent.mkdir(parents=True, exist_ok=True)
        stage_parent = Path(tempfile.mkdtemp(prefix=f".{destination.name}.migration-", dir=destination.parent))
        staged_project = stage_parent / "project"
        candidate = None
        try:
            candidate = ProjectRepository.create(staged_project, name or destination.name)
            assets = {}
            for asset_name in legacy.asset_names():
                with legacy.open_asset(asset_name) as stream:
                    ref = candidate.assets.put_stream(stream, name=Path(asset_name).name)
                assets[asset_name] = ref.asset_id
                assets[asset_name.removeprefix("assets/")] = ref.asset_id
            changes = {}
            for legacy_key, value in raw.items():
                if legacy_key.casefold() == "manifest": continue
                domain = {"levelobjects":"objects", "audios":"audio", "scene":"scenes"}.get(legacy_key.casefold(), legacy_key.casefold())
                if domain not in __import__("Auvra.project.schemas", fromlist=["DOMAIN_NAMES"]).DOMAIN_NAMES: continue
                records = value if isinstance(value, list) else [value]
                mapped = [_map_legacy_record(domain, record, assets) for record in records if isinstance(record, dict)]
                if mapped: changes[domain] = mapped
            if "scenes" not in changes and "metadata" not in changes:
                changes["metadata"] = [{"id":"migrated", "name": name or destination.name}]
            candidate.apply_changes(changes, expected_revision=0); candidate.save(); candidate.close(); candidate = None
            os.replace(staged_project, destination)
            try:
                fd = os.open(destination.parent, os.O_RDONLY); os.fsync(fd); os.close(fd)
            except OSError: pass
            self._close_active(); self.active = ProjectRepository(destination); self._record()
            return self.active.status, report
        except Exception:
            if candidate is not None: candidate.close()
            raise
        finally:
            shutil.rmtree(stage_parent, ignore_errors=True)
    def begin_upload(self, stream: BinaryIO, *, project_id: str, size: int | None = None,
                     mime: str | None = None, name: str | None = None) -> AssetReference:
        return self._require(project_id).assets.put_stream(stream, size=size, mime=mime, name=name)
    def resolve(self, asset_id: str, *, project_id: str) -> BinaryIO:
        repo = self._require(project_id)
        if not repo.assets.verify(asset_id): raise FileNotFoundError("asset unavailable")
        return repo.assets.open(asset_id)
    def resolve_reference(self, asset_id: str, *, project_id: str) -> AssetReference:
        repo = self._require(project_id)
        reference = repo.assets.reference(asset_id)
        if not repo.assets.verify(asset_id, expected_size=reference.size):
            raise FileNotFoundError("asset unavailable")
        return reference

    def recovery(self, *, project_id: str, kind: str | None = None):
        return self._require(project_id).recovery_points(kind)
    def restore_recovery(self, *, project_id: str, kind: str, name: str) -> ProjectStatus:
        repo = self._require(project_id); repo.restore_recovery(kind, name); return repo.status

    def __enter__(self): return self
    def __exit__(self, *_): self.shutdown()

def _map_legacy_record(domain: str, record: dict, assets: dict[str, str]) -> dict:
    from .schemas import schema_for
    allowed = set(schema_for(domain).get("properties", {}).get("documents", {}).get("items", {}).get("properties", {}))
    mapped = {key: value for key, value in record.items() if key in allowed}
    if "assetFilename" in record and "assetId" in allowed and "assetId" not in mapped:
        mapped["assetId"] = record["assetFilename"]
    def rewrite(value, key=""):
        if isinstance(value, dict): return {k: rewrite(v, k) for k, v in value.items()}
        if isinstance(value, list): return [rewrite(v, key) for v in value]
        if isinstance(value, str) and (key.lower().endswith("filename") or key in ("assetId", "assetFilename")):
            return assets.get(value, assets.get(value.removeprefix("assets/"), value))
        return value
    mapped = rewrite(mapped)
    if "id" not in mapped: raise ValueError(f"legacy {domain} record is missing id")
    return mapped
