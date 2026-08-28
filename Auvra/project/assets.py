"""Bounded, content-addressed binary storage."""
from __future__ import annotations
import hashlib
import os
import re
import shutil, uuid, stat
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable
from Auvra.diagnostics import trace_public_class

_HASH = re.compile(r"^[0-9a-f]{64}$")
_MANIFEST_LOCK = threading.RLock()

@dataclass(frozen=True)
class AssetReference:
    asset_id: str
    size: int
    mime: str | None = None
    name: str | None = None

@trace_public_class("asset_store", concise=("put_stream",))
class AssetStore:
    def __init__(self, root: str | os.PathLike[str], *, max_size: int = 2 * 1024**3) -> None:
        self.root = Path(root)
        self.content = self.root / "sha256"
        self.content.mkdir(parents=True, exist_ok=True)
        self.max_size = max_size

    def path_for(self, asset_id: str) -> Path:
        if not _HASH.fullmatch(asset_id):
            raise ValueError("invalid asset id")
        # The digest is the stable opaque asset handle and the on-disk name;
        # no extension or source filename participates in identity.
        return self.content / asset_id

    def put_stream(self, stream: BinaryIO, *, size: int | None = None,
                   chunk_size: int = 1024 * 1024, mime: str | None = None,
                   name: str | None = None) -> AssetReference:
        if size is not None and (size < 0 or size > self.max_size):
            raise ValueError("asset exceeds project size limit")
        staging = self.content / ".incoming"
        staging.mkdir(parents=True, exist_ok=True)
        tmp = staging / f"asset-{os.getpid()}-{uuid.uuid4().hex}"
        if chunk_size <= 0: raise ValueError("chunk_size must be positive")
        digest = hashlib.sha256(); total = 0; prefix = bytearray()
        try:
            with tmp.open("wb") as output:
                while True:
                    block = stream.read(chunk_size)
                    if not block:
                        break
                    if not isinstance(block, (bytes, bytearray, memoryview)):
                        raise TypeError("asset stream must return bytes")
                    if len(block) > chunk_size: raise ValueError("asset stream exceeded bounded chunk size")
                    total += len(block)
                    if total > self.max_size:
                        raise ValueError("asset exceeds project size limit")
                    if len(prefix) < 512: prefix.extend(block[:512 - len(prefix)])
                    digest.update(block); output.write(block)
                output.flush(); os.fsync(output.fileno())
            if size is not None and total != size:
                raise ValueError("asset size does not match declared size")
            detected = sniff_mime(bytes(prefix))
            known_media = {"image/png", "image/jpeg", "image/webp", "audio/wav", "audio/ogg", "model/gltf-binary"}
            if mime in known_media and detected != mime:
                raise ValueError("asset MIME does not match its content")
            mime = mime or detected or "application/octet-stream"
            asset_id = digest.hexdigest(); target = self.path_for(asset_id)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                tmp.unlink()
            else:
                os.replace(tmp, target)
            self._record(asset_id, total, mime, name)
            return AssetReference(asset_id, total, mime, name)
        finally:
            try: tmp.unlink()
            except FileNotFoundError: pass

    def open(self, asset_id: str) -> BinaryIO:
        path = self.path_for(asset_id)
        if path.is_symlink() or _is_reparse(path): raise ValueError("unsafe asset path")
        return path.open("rb")

    def verify(self, asset_id: str, *, expected_size: int | None = None) -> bool:
        path = self.path_for(asset_id)
        if not path.is_file() or path.is_symlink() or _is_reparse(path): return False
        if expected_size is not None and path.stat().st_size != expected_size: return False
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""): digest.update(block)
        return digest.hexdigest() == asset_id

    def reference(self, asset_id: str) -> AssetReference:
        """Return validated metadata without exposing the content path."""

        path = self.path_for(asset_id)
        manifest = self.root / "manifest.json"
        try:
            values = json.loads(manifest.read_text(encoding="utf-8"))
            metadata = values[asset_id]
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ValueError("asset metadata is unavailable") from exc
        if not isinstance(metadata, dict) or set(metadata) != {"size", "mime", "name"}:
            raise ValueError("asset metadata is invalid")
        size, mime, name = metadata["size"], metadata["mime"], metadata["name"]
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(mime, str)
            or (name is not None and not isinstance(name, str))
            or not path.is_file()
            or path.stat().st_size != size
        ):
            raise ValueError("asset metadata is invalid")
        return AssetReference(asset_id, size, mime, name)

    def _record(self, asset_id: str, size: int, mime: str, name: str | None) -> None:
        manifest = self.root / "manifest.json"
        with _MANIFEST_LOCK:
            values = {}
            if manifest.exists():
                try: values = json.loads(manifest.read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc: raise ValueError("asset manifest is corrupt") from exc
                if not isinstance(values, dict): raise ValueError("asset manifest is corrupt")
            candidate = {"size": size, "mime": mime, "name": name}
            if asset_id in values and values[asset_id] != candidate:
                raise ValueError("asset metadata conflicts with existing content")
            values[asset_id] = candidate
            temp = manifest.with_name(f"manifest.json.tmp-{os.getpid()}-{uuid.uuid4().hex}")
            try:
                temp.write_text(json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
                with temp.open("a", encoding="utf-8") as stream: stream.flush(); os.fsync(stream.fileno())
                os.replace(temp, manifest)
                try:
                    fd = os.open(manifest.parent, os.O_RDONLY); os.fsync(fd); os.close(fd)
                except OSError: pass
            finally:
                temp.unlink(missing_ok=True)

def sniff_mime(prefix: bytes) -> str | None:
    if prefix.startswith(b"\x89PNG\r\n\x1a\n"): return "image/png"
    if prefix.startswith(b"\xff\xd8\xff"): return "image/jpeg"
    if prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP": return "image/webp"
    if prefix.startswith(b"RIFF") and prefix[8:12] == b"WAVE": return "audio/wav"
    if prefix.startswith(b"OggS"): return "audio/ogg"
    if prefix.startswith(b"glTF"): return "model/gltf-binary"
    return None

def _is_reparse(path: Path) -> bool:
    try: return bool(getattr(path.stat(), "st_file_attributes", 0) & 0x400)
    except OSError: return True
