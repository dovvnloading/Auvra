"""Portable archive writer and fail-closed archive validator."""
from __future__ import annotations
import os, unicodedata, uuid, zipfile
from pathlib import Path
from .schemas import DOMAIN_NAMES
from .errors import ArchiveValidationError

MAX_MEMBER = 2 * 1024**3
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

def validate_archive(path: str | os.PathLike[str], *, max_total: int = MAX_MEMBER) -> list[zipfile.ZipInfo]:
    try: archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc: raise ArchiveValidationError("invalid ZIP archive") from exc
    with archive:
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
            if total > max_total: raise ArchiveValidationError("archive exceeds size limit")
        return infos

def export_folder(folder: str | os.PathLike[str], destination: str | os.PathLike[str]) -> None:
    folder = Path(folder); destination = Path(destination)
    temp = destination.with_name(destination.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex}")
    try:
        with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            descriptors = [p for p in folder.glob("*.auvra") if p.is_file()]
            if len(descriptors) != 1: raise ValueError("project requires one descriptor")
            paths = [descriptors[0], folder / ".gitignore"]
            paths += [folder / "Project" / f"{domain}.json" for domain in DOMAIN_NAMES if (folder / "Project" / f"{domain}.json").is_file()]
            manifest = folder / "Content" / "manifest.json"
            if manifest.is_file(): paths.append(manifest)
            assets = folder / "Content" / "sha256"
            if assets.exists(): paths += [p for p in assets.iterdir() if p.is_file() and p.name != "manifest.json"]
            for path in sorted(paths):
                if path.is_file(): archive.write(path, path.relative_to(folder).as_posix())
            for directory in (folder / "Project", folder / "Content", folder / "Content" / "sha256"):
                archive.writestr(directory.relative_to(folder).as_posix().rstrip("/") + "/", b"")
        with temp.open("rb+") as stream: os.fsync(stream.fileno())
        os.replace(temp, destination)
        try:
            fd = os.open(destination.parent, os.O_RDONLY); os.fsync(fd); os.close(fd)
        except OSError: pass
    finally:
        try: temp.unlink()
        except FileNotFoundError: pass
