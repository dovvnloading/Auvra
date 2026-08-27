"""Read-only migration readers for the prototype ``.forge`` archive."""
from __future__ import annotations
import json, mimetypes, zipfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from .archive import validate_archive
from .assets import sniff_mime
from .errors import ArchiveValidationError

@dataclass
class LegacyMigrationReport:
    warnings: list[str] = field(default_factory=list)
    domains: dict[str, int] = field(default_factory=dict)
    assets: int = 0

class LegacyArchive:
    """Parse, validate, and report a legacy archive without modifying it."""
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
    def inspect(self) -> tuple[dict[str, Any], LegacyMigrationReport]:
        infos = validate_archive(self.path)
        names = {i.filename for i in infos}
        if "manifest.json" not in names or "scene.json" not in names:
            raise ArchiveValidationError("legacy archive requires manifest.json and scene.json")
        report = LegacyMigrationReport()
        result: dict[str, Any] = {}
        stems: set[str] = set()
        with zipfile.ZipFile(self.path) as archive:
            asset_names = {i.filename for i in infos if i.filename.startswith("assets/") and not i.is_dir()}
            for info in infos:
                if info.is_dir(): continue
                if info.filename.endswith("/"): continue
                if info.filename.endswith(".json"):
                    stem = Path(info.filename).stem.casefold()
                    if stem in stems: raise ArchiveValidationError("duplicate legacy JSON document")
                    stems.add(stem)
                    if info.file_size > 64 * 1024 * 1024: raise ArchiveValidationError("legacy JSON member is too large")
                    try:
                        with archive.open(info) as stream:
                            raw = stream.read(64 * 1024 * 1024 + 1)
                        if len(raw) > 64 * 1024 * 1024: raise ArchiveValidationError("legacy JSON member is too large")
                        value = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                        raise ArchiveValidationError(f"invalid JSON: {info.filename}") from exc
                    key = Path(info.filename).stem
                    result[key] = value
                    report.domains[key] = len(value) if isinstance(value, list) else 1
                elif info.filename.startswith("assets/"):
                    report.assets += 1
                    with archive.open(info) as stream:
                        prefix = stream.read(512)
                    suffix = Path(info.filename).suffix.lower()
                    detected = sniff_mime(prefix)
                    expected = {".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".wav":"audio/wav", ".ogg":"audio/ogg"}.get(suffix)
                    if expected and detected != expected:
                        raise ArchiveValidationError(f"legacy asset MIME mismatch: {info.filename}")
            manifest = result.get("manifest")
            if not isinstance(manifest, dict) or not isinstance(manifest.get("version"), int):
                raise ArchiveValidationError("invalid legacy manifest")
            references: set[str] = set()
            def collect(value: Any, key: str = ""):
                if isinstance(value, dict):
                    for child_key, child in value.items():
                        if child_key.lower().endswith("filename") and isinstance(child, str): references.add(child if child.startswith("assets/") else "assets/" + child)
                        collect(child, child_key)
                elif isinstance(value, list):
                    for child in value: collect(child, key)
            for value in result.values(): collect(value)
            missing = sorted(ref for ref in references if ref not in asset_names)
            if missing: raise ArchiveValidationError("legacy archive references missing assets")
        return result, report
    def migrate(self) -> tuple[dict[str, Any], LegacyMigrationReport]:
        return self.inspect()
    def asset_names(self) -> list[str]:
        return [info.filename for info in validate_archive(self.path) if info.filename.startswith("assets/") and not info.is_dir()]
    @contextmanager
    def open_asset(self, name: str):
        if name not in self.asset_names(): raise ArchiveValidationError("unknown legacy asset")
        with zipfile.ZipFile(self.path) as archive:
            with archive.open(name) as stream: yield stream
