"""Bounded, content-addressed binary storage."""
from __future__ import annotations
import hashlib
import math
import os
import re
import shutil, uuid, stat
import json
import struct
import sys
import threading
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable, Sequence
from Auvra.diagnostics import trace_public_class

_HASH = re.compile(r"^[0-9a-f]{64}$")
_MANIFEST_LOCK = threading.RLock()

# Terrain heightfields: a 16-byte header (magic, uint32 columns, uint32 rows)
# followed by columns * rows row-major Float32 samples, all little-endian.
HEIGHTFIELD_MIME = "application/vnd.auvra.heightfield"
HEIGHTFIELD_MAGIC = b"AUVRAHF1"
HEIGHTFIELD_ENCODING = "float32le"
MAX_HEIGHTFIELD_SAMPLES_PER_SIDE = 4097
_HEIGHTFIELD_HEADER = struct.Struct("<8sII")

# Model formats.  Binary glTF carries the ``glTF`` magic; glTF JSON and
# Wavefront OBJ are text without a signature, so they are accepted by their
# declared MIME after a content sanity check (text, and a JSON object for
# glTF).  FBX keeps its declared MIME unchanged.
GLB_MIME = "model/gltf-binary"
GLTF_JSON_MIME = "model/gltf+json"
OBJ_MIME = "model/obj"
FBX_MIME = "model/fbx"
MODEL_MIMES = frozenset({GLB_MIME, GLTF_JSON_MIME, OBJ_MIME, FBX_MIME})
_TEXT_MODEL_MIMES = frozenset({GLTF_JSON_MIME, OBJ_MIME})

# Verifying a blob is a full SHA-256 pass, and every project edit checks each
# referenced asset.  A repository builds a fresh AssetStore view per access,
# so verified blobs are remembered process-wide by absolute path.  A hit needs
# the exact (size, mtime_ns, inode, device) the digest was computed for, so a
# rewrite, truncation or replacement of the blob is hashed again.
_VERIFIED: dict[str, tuple[int, int, int, int]] = {}
_VERIFIED_LOCK = threading.Lock()
_VERIFIED_LIMIT = 65536

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
            known_media = {"image/png", "image/jpeg", "image/webp", "audio/wav", "audio/ogg", GLB_MIME, HEIGHTFIELD_MIME}
            if mime in known_media and detected != mime:
                raise ValueError("asset MIME does not match its content")
            declared = mime.lower() if isinstance(mime, str) else None
            if declared in _TEXT_MODEL_MIMES and not text_model_matches(declared, bytes(prefix)):
                raise ValueError("asset MIME does not match its content")
            mime = mime or detected or "application/octet-stream"
            if mime == HEIGHTFIELD_MIME:
                validate_heightfield_file(tmp)
            asset_id = digest.hexdigest(); target = self.path_for(asset_id)
            target.parent.mkdir(parents=True, exist_ok=True)
            # Serialize same-digest ingestion with manifest publication.  An
            # existing filename is not proof of valid content: repair a
            # corrupt or truncated blob with the freshly verified stream.
            with _MANIFEST_LOCK:
                if target.exists() and self.verify(asset_id, expected_size=total):
                    tmp.unlink()
                else:
                    _forget_verified(target)
                    os.replace(tmp, target)
                    # The bytes now at ``target`` were hashed while staging.
                    try: _remember_verified(target, target.stat())
                    except OSError: pass
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
        """Return whether the blob exists and hashes to its id.

        An unchanged blob that already verified costs one ``stat``; only a
        new or modified blob is read and hashed.
        """
        path = self.path_for(asset_id)
        try: info = path.stat()
        except OSError: return False
        if (not stat.S_ISREG(info.st_mode) or path.is_symlink()
                or getattr(info, "st_file_attributes", 0) & 0x400):
            return False
        if expected_size is not None and info.st_size != expected_size: return False
        fingerprint = _fingerprint(info)
        with _VERIFIED_LOCK:
            if _VERIFIED.get(_verified_key(path)) == fingerprint: return True
        if _file_digest(path) != asset_id:
            _forget_verified(path)
            return False
        # Cache only when the blob did not change while it was being hashed.
        try: settled = path.stat()
        except OSError: return True
        if _fingerprint(settled) == fingerprint: _remember_verified(path, settled)
        return True

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

    def remove(self, asset_id: str) -> bool:
        """Remove one unreferenced content-addressed blob and its metadata."""

        path = self.path_for(asset_id)
        if path.is_symlink() or (path.exists() and _is_reparse(path)):
            raise ValueError("unsafe asset path")
        manifest = self.root / "manifest.json"
        with _MANIFEST_LOCK:
            values: dict[str, object] = {}
            if manifest.exists():
                try:
                    loaded = json.loads(manifest.read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    raise ValueError("asset manifest is corrupt") from exc
                if not isinstance(loaded, dict):
                    raise ValueError("asset manifest is corrupt")
                values = loaded
            existed = asset_id in values or path.exists()
            if asset_id in values:
                values.pop(asset_id)
                temporary = manifest.with_name(f"manifest.json.tmp-{os.getpid()}-{uuid.uuid4().hex}")
                try:
                    temporary.write_text(
                        json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
                        encoding="utf-8",
                        newline="\n",
                    )
                    with temporary.open("a", encoding="utf-8") as stream:
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, manifest)
                finally:
                    temporary.unlink(missing_ok=True)
            _forget_verified(path)
            path.unlink(missing_ok=True)
            return existed

    def remove_unreferenced(
        self,
        referenced: Iterable[str],
        candidates: Iterable[str] | None = None,
    ) -> set[str]:
        """Remove candidate blobs that are not in the live project references."""

        keep = set(referenced)
        selected = set(candidates) if candidates is not None else None
        manifest = self.root / "manifest.json"
        if not manifest.is_file():
            return set()
        try:
            values = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError("asset manifest is corrupt") from exc
        if not isinstance(values, dict):
            raise ValueError("asset manifest is corrupt")
        removed: set[str] = set()
        for asset_id in list(values):
            if not isinstance(asset_id, str) or asset_id in keep:
                continue
            if selected is not None and asset_id not in selected:
                continue
            if self.remove(asset_id):
                removed.add(asset_id)
        return removed

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
    if prefix.startswith(HEIGHTFIELD_MAGIC): return HEIGHTFIELD_MIME
    return None

def text_model_matches(mime: str, prefix: bytes) -> bool:
    """Sanity-check a signature-less text model (glTF JSON or OBJ) prefix."""

    if sniff_mime(prefix) is not None:
        return False
    body = prefix[3:] if prefix.startswith(b"\xef\xbb\xbf") else prefix
    # Text formats never contain NUL or non-whitespace control bytes.
    if not body or any(byte < 0x20 and byte not in b"\t\n\r\x0b\x0c" for byte in body):
        return False
    if mime == GLTF_JSON_MIME:
        return body.lstrip(b" \t\r\n").startswith(b"{")
    return mime == OBJ_MIME

def _fingerprint(info: os.stat_result) -> tuple[int, int, int, int]:
    return (info.st_size, info.st_mtime_ns, info.st_ino, info.st_dev)

def _verified_key(path: Path) -> str:
    return os.path.normcase(os.path.abspath(path))

def _remember_verified(path: Path, info: os.stat_result) -> None:
    key = _verified_key(path)
    with _VERIFIED_LOCK:
        if len(_VERIFIED) >= _VERIFIED_LIMIT and key not in _VERIFIED:
            _VERIFIED.clear()
        _VERIFIED[key] = _fingerprint(info)

def _forget_verified(path: Path) -> None:
    with _VERIFIED_LOCK:
        _VERIFIED.pop(_verified_key(path), None)

def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()

def _check_heightfield_dimensions(columns: int, rows: int) -> None:
    for value in (columns, rows):
        if (not isinstance(value, int) or isinstance(value, bool)
                or not 2 <= value <= MAX_HEIGHTFIELD_SAMPLES_PER_SIDE):
            raise ValueError("terrain heightfield dimensions are out of range")

def _float32_samples(data: bytes) -> array:
    values = array("f")
    values.frombytes(data)
    if sys.byteorder != "little":
        values.byteswap()
    return values

def encode_heightfield(samples: Sequence[float], columns: int, rows: int) -> bytes:
    """Encode row-major terrain heights as a heightfield asset."""

    _check_heightfield_dimensions(columns, rows)
    if len(samples) != columns * rows:
        raise ValueError("terrain heightfield sample count does not match its dimensions")
    values = array("f", samples)
    if not all(map(math.isfinite, values)):
        raise ValueError("terrain heightfield samples must be finite Float32 values")
    if sys.byteorder != "little":
        values.byteswap()
    return _HEIGHTFIELD_HEADER.pack(HEIGHTFIELD_MAGIC, columns, rows) + values.tobytes()

def decode_heightfield(data: bytes) -> tuple[int, int, list[float]]:
    """Return (columns, rows, samples) of a valid heightfield asset."""

    if len(data) < _HEIGHTFIELD_HEADER.size:
        raise ValueError("terrain heightfield asset is truncated")
    magic, columns, rows = _HEIGHTFIELD_HEADER.unpack_from(data)
    if magic != HEIGHTFIELD_MAGIC:
        raise ValueError("terrain heightfield asset has an unknown format")
    _check_heightfield_dimensions(columns, rows)
    if len(data) != _HEIGHTFIELD_HEADER.size + 4 * columns * rows:
        raise ValueError("terrain heightfield asset size does not match its dimensions")
    values = _float32_samples(data[_HEIGHTFIELD_HEADER.size:])
    if not all(map(math.isfinite, values)):
        raise ValueError("terrain heightfield samples must be finite")
    return columns, rows, values.tolist()

def validate_heightfield_file(path: Path, *, chunk_size: int = 1024 * 1024) -> None:
    """Structurally validate a heightfield without loading it all at once."""

    with path.open("rb") as stream:
        header = stream.read(_HEIGHTFIELD_HEADER.size)
        if len(header) != _HEIGHTFIELD_HEADER.size:
            raise ValueError("terrain heightfield asset is truncated")
        magic, columns, rows = _HEIGHTFIELD_HEADER.unpack(header)
        if magic != HEIGHTFIELD_MAGIC:
            raise ValueError("terrain heightfield asset has an unknown format")
        _check_heightfield_dimensions(columns, rows)
        if os.fstat(stream.fileno()).st_size != _HEIGHTFIELD_HEADER.size + 4 * columns * rows:
            raise ValueError("terrain heightfield asset size does not match its dimensions")
        chunk_size -= chunk_size % 4
        for block in iter(lambda: stream.read(chunk_size), b""):
            if not all(map(math.isfinite, _float32_samples(block))):
                raise ValueError("terrain heightfield samples must be finite")

def _is_reparse(path: Path) -> bool:
    try: return bool(getattr(path.stat(), "st_file_attributes", 0) & 0x400)
    except OSError: return True
