"""Portable archive writer and fail-closed archive validator."""
from __future__ import annotations
from .serialization import sync_directory
import os, unicodedata, uuid, zipfile
from pathlib import Path
from .schemas import DOMAIN_NAMES
from .errors import ArchiveValidationError

MAX_MEMBER = 2 * 1024**3
MAX_TOTAL = MAX_MEMBER
MAX_MEMBERS = 100_000
_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}

def _safe_name(name: str) -> bool:
    if not name or "\\" in name or name.startswith("/"): return False
    if name.endswith("/"): name = name[:-1]
    parts = name.split("/")
    return bool(parts) and all(
        p not in ("", ".", "..")
        and ":" not in p
        and not p.endswith((" ", "."))
        and not any(ord(char) < 32 for char in p)
        and p.split(".", 1)[0].upper() not in _WINDOWS_RESERVED
        for p in parts
    )

def _check_total_size(total: int, max_total: int) -> None:
    if total > max_total:
        raise ArchiveValidationError(f"archive exceeds size limit ({max_total:,} uncompressed bytes)")


def _validate_archive_members(archive: zipfile.ZipFile, *, max_total: int) -> list[zipfile.ZipInfo]:
    infos = archive.infolist()
    if len(infos) > MAX_MEMBERS: raise ArchiveValidationError("archive has too many members")
    total = 0; seen = set()
    for info in infos:
        folded = unicodedata.normalize("NFC", info.filename).casefold()
        if folded in seen or not _safe_name(info.filename): raise ArchiveValidationError("unsafe or duplicate archive path")
        seen.add(folded)
        # Symlink entries can escape the extraction root even when their
        # textual name looks safe.  Portable project archives contain
        # regular files and directories only.
        if ((info.external_attr >> 16) & 0o170000) == 0o120000:
            raise ArchiveValidationError("symbolic links are not allowed in archives")
        if info.file_size < 0 or info.file_size > MAX_MEMBER: raise ArchiveValidationError("invalid archive member size")
        if info.is_dir(): continue
        if info.file_size and (not info.compress_size or info.file_size / info.compress_size > 1000): raise ArchiveValidationError("suspicious compression ratio")
        total += info.file_size
        _check_total_size(total, max_total)
    return infos


def validate_archive(path: str | os.PathLike[str] | zipfile.ZipFile, *, max_total: int | None = None) -> list[zipfile.ZipInfo]:
    """Validate an archive path, or an already-open archive handle.

    Callers that will later extract should pass the same open ``ZipFile`` so
    validation and extraction share one file handle and cannot be separated by
    a pathname replacement.
    """
    if max_total is None:
        max_total = MAX_TOTAL
    if isinstance(path, zipfile.ZipFile):
        return _validate_archive_members(path, max_total=max_total)
    try: archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc: raise ArchiveValidationError("invalid ZIP archive") from exc
    with archive:
        return _validate_archive_members(archive, max_total=max_total)

def export_folder(folder: str | os.PathLike[str], destination: str | os.PathLike[str]) -> None:
    folder = Path(folder); destination = Path(destination)
    temp = destination.with_name(destination.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex}")
    try:
        descriptors = [p for p in folder.glob("*.auvra") if p.is_file()]
        if len(descriptors) != 1: raise ValueError("project requires one descriptor")
        paths = [descriptors[0], folder / ".gitignore"]
        paths += [folder / "Project" / f"{domain}.json" for domain in DOMAIN_NAMES if (folder / "Project" / f"{domain}.json").is_file()]
        manifest = folder / "Content" / "manifest.json"
        if manifest.is_file(): paths.append(manifest)
        assets = folder / "Content" / "sha256"
        if assets.exists(): paths += [p for p in assets.iterdir() if p.is_file() and p.name != "manifest.json"]
        paths = [path for path in sorted(paths) if path.is_file()]
        # Count exactly the files that will be exported, including metadata,
        # before spending time compressing a project that cannot be imported.
        total = 0
        for path in paths:
            total += path.stat().st_size
            _check_total_size(total, MAX_TOTAL)
        with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            total = 0
            for path in paths:
                name = path.relative_to(folder).as_posix()
                archive.write(path, name)
                # ZIP records actual bytes written, not the preflight stat.
                total += archive.getinfo(name).file_size
                _check_total_size(total, MAX_TOTAL)
            for directory in (folder / "Project", folder / "Content", folder / "Content" / "sha256"):
                archive.writestr(directory.relative_to(folder).as_posix().rstrip("/") + "/", b"")
        # Apply the importer's complete member checks to the finished ZIP
        # before replacing an existing backup or exposing a new one.
        validate_archive(temp)
        with temp.open("rb+") as stream: os.fsync(stream.fileno())
        os.replace(temp, destination)
        sync_directory(destination.parent)
    except ArchiveValidationError as exc:
        raise ArchiveValidationError(f"Cannot export project: {exc}. Use Save As for a folder copy.") from exc
    finally:
        temp.unlink(missing_ok=True)
