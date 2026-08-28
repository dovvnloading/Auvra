"""Deterministic .auvraplugin archives and strict package validation."""

from __future__ import annotations

from dataclasses import dataclass
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import unicodedata
import zipfile
from typing import Any, Mapping, Protocol
from Auvra.diagnostics import trace_public_class


MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 256
MAX_MANIFEST_BYTES = 256 * 1024
MAX_FRAME_BYTES = 64 * 1024
_PLUGIN_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_KEY_ID = re.compile(r"^[0-9a-f]{64}$")
_SEMVER = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_ALGORITHMS = {"ECDSA-P256-SHA256"}
_CAPABILITIES = {"text", "code", "commands", "media.generate", "media.edit"}
_PERMISSIONS = {"networkProxy", "credentialUse", "assetRead", "assetWrite", "cache"}
_WINDOWS_DEVICES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


class PackageError(ValueError):
    """A package is malformed, untrusted, or incompatible."""


class SignatureVerifier(Protocol):
    def verify(self, *, key_id: str, signed: bytes, signature: bytes) -> bool: ...


def canonical_json(value: Any) -> bytes:
    try:
        return (json.dumps(value, ensure_ascii=False, allow_nan=False,
                           separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise PackageError("package metadata is not canonical JSON") from exc


def _safe_member(name: str) -> bool:
    if not name or "\\" in name or name.startswith("/") or name.endswith("/"):
        return False
    parts = name.split("/")
    return all(part not in {"", ".", ".."} and ":" not in part and
               not part.endswith((" ", ".")) and part.split(".", 1)[0].casefold() not in _WINDOWS_DEVICES and
               all(ord(c) >= 32 for c in part) for part in parts)


def _b64decode(value: Any, label: str) -> bytes:
    if not isinstance(value, str) or not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise PackageError(f"{label} is invalid")
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, base64.binascii.Error) as exc:
        raise PackageError(f"{label} is invalid") from exc


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _sha256_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str:
    """Hash a ZIP member through its bounded stream, never materializing it."""
    digest = hashlib.sha256()
    with archive.open(info, "r") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo, source: Path) -> None:
    """Copy a fixture payload in chunks while preserving deterministic metadata."""
    with archive.open(info, "w") as target, source.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            target.write(block)


def _validate_permissions(value: Any) -> dict[str, Any]:
    if value is None:
        return {key: False for key in _PERMISSIONS}
    if not isinstance(value, dict) or set(value) - _PERMISSIONS:
        raise PackageError("permissions are invalid")
    result: dict[str, Any] = {key: False for key in _PERMISSIONS}
    for key, item in value.items():
        if key == "networkProxy":
            if not isinstance(item, list) or len(item) > 16:
                raise PackageError("networkProxy permission is invalid")
            origins: list[str] = []
            for origin in item:
                if not isinstance(origin, str):
                    raise PackageError("networkProxy origins must be exact HTTPS origins")
                from urllib.parse import urlsplit
                try:
                    parsed = urlsplit(origin)
                    hostname = parsed.hostname
                    port = parsed.port
                    valid = (parsed.scheme == "https" and hostname is not None and
                             parsed.username is None and parsed.password is None and
                             port is None and parsed.path in {"", "/"} and
                             not parsed.query and not parsed.fragment and
                             origin == f"https://{hostname}")
                except ValueError as exc:
                    raise PackageError("networkProxy origins must be exact HTTPS origins") from exc
                if not valid:
                    raise PackageError("networkProxy origins must be exact HTTPS origins")
                origins.append(origin)
            result[key] = sorted(set(origins))
        else:
            if not isinstance(item, bool):
                raise PackageError(f"{key} permission must be boolean")
            result[key] = item
    return result


def _validate_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {
        "schemaVersion", "pluginId", "publisherKeyId", "pluginVersion", "entrypoint",
        "abi", "capabilities", "models", "permissions", "resources",
    }:
        raise PackageError("manifest has unknown fields")
    required = {"schemaVersion", "pluginId", "publisherKeyId", "pluginVersion", "entrypoint", "abi", "capabilities", "permissions", "resources"}
    if required - set(value):
        raise PackageError("manifest is incomplete")
    if value["schemaVersion"] != 1 or not isinstance(value["pluginId"], str) or not _PLUGIN_ID.fullmatch(value["pluginId"]):
        raise PackageError("manifest identity is invalid")
    if not isinstance(value["publisherKeyId"], str) or not _KEY_ID.fullmatch(value["publisherKeyId"]):
        raise PackageError("publisherKeyId is invalid")
    if not isinstance(value["pluginVersion"], str) or not _SEMVER.fullmatch(value["pluginVersion"]):
        raise PackageError("pluginVersion is invalid")
    if value["abi"] != "auvra.provider/1":
        raise PackageError("unsupported provider ABI")
    entrypoint = value["entrypoint"]
    if not isinstance(entrypoint, dict) or set(entrypoint) != {"path", "sha256"}:
        raise PackageError("entrypoint is invalid")
    path = entrypoint["path"]
    if not isinstance(path, str) or not path.startswith("payload/") or not _safe_member(path) or not path.lower().endswith(".exe"):
        raise PackageError("entrypoint must be a payload executable")
    if not isinstance(entrypoint["sha256"], str) or not _SHA256.fullmatch(entrypoint["sha256"]):
        raise PackageError("entrypoint digest is invalid")
    capabilities = value["capabilities"]
    if not isinstance(capabilities, list) or not capabilities or len(capabilities) > 16 or any(item not in _CAPABILITIES for item in capabilities) or len(set(capabilities)) != len(capabilities):
        raise PackageError("capabilities are invalid")
    models = value.get("models", [])
    if not isinstance(models, list) or len(models) > 256 or any(not isinstance(item, str) or not (1 <= len(item) <= 128) for item in models) or len(set(models)) != len(models):
        raise PackageError("models are invalid")
    resources = value["resources"]
    if not isinstance(resources, dict) or set(resources) - {"memoryMiB", "cpuMsPerRequest", "wallMsPerRequest", "maxArtifactBytes"}:
        raise PackageError("resources are invalid")
    limits = {"memoryMiB": (1, 512), "cpuMsPerRequest": (1, 30000), "wallMsPerRequest": (1, 60000), "maxArtifactBytes": (1, 32 * 1024 * 1024)}
    for key, (low, high) in limits.items():
        item = resources.get(key)
        if not isinstance(item, int) or isinstance(item, bool) or not low <= item <= high:
            raise PackageError(f"resource {key} is outside the host ceiling")
    result = dict(value)
    result["permissions"] = _validate_permissions(value.get("permissions"))
    result["models"] = list(models)
    result["capabilities"] = list(capabilities)
    return result


def _signed_body(manifest: Mapping[str, Any], files: Mapping[str, str]) -> bytes:
    return b"AUVRA-PLUGIN/1\n" + canonical_json({"manifest": manifest, "files": dict(sorted(files.items()))})


def signature_body(manifest: Mapping[str, Any], files: Mapping[str, str]) -> bytes:
    """Return the deterministic bytes an external signer must authenticate."""
    checked = _validate_manifest(dict(manifest))
    if set(files) != {"plugin.json", checked["entrypoint"]["path"]} or any(
            not isinstance(name, str) or not _SHA256.fullmatch(digest)
            for name, digest in files.items()):
        raise PackageError("signature file map is invalid")
    return _signed_body(checked, files)


def signature_envelope(key_id: str, signature: bytes) -> bytes:
    """Encode a signature attachment without ever handling a private key."""
    if not _KEY_ID.fullmatch(key_id) or not isinstance(signature, bytes) or len(signature) != 64:
        raise PackageError("signature attachment is invalid")
    return canonical_json({"algorithm": "ECDSA-P256-SHA256", "keyId": key_id,
                           "signature": base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")})


def attach_signature(package_path: str | os.PathLike[str], destination: str | os.PathLike[str],
                     *, key_id: str, signature: bytes) -> Path:
    """Attach an externally-produced signature to a validated unsigned package."""
    package = PluginPackage.open(package_path, allow_unsigned=True)
    if package.signed:
        raise PackageError("package is already signed")
    envelope = signature_envelope(key_id, signature)
    destination = Path(destination).expanduser().absolute()
    source = Path(package_path).expanduser().absolute()
    if destination == source or destination.exists() or destination.is_symlink():
        raise PackageError("signature destination must be distinct")
    if key_id != package.manifest["publisherKeyId"]:
        raise PackageError("signature key does not match the package publisher")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as old, zipfile.ZipFile(destination, "x") as new:
        for old_info in old.infolist():
            info = zipfile.ZipInfo(old_info.filename, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = old_info.external_attr
            if old_info.filename == package.manifest["entrypoint"]["path"]:
                with old.open(old_info, "r") as source_stream, new.open(info, "w") as target_stream:
                    for block in iter(lambda: source_stream.read(1024 * 1024), b""):
                        target_stream.write(block)
            else:
                new.writestr(info, old.read(old_info))
        info = zipfile.ZipInfo("signature.json", date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = 0o100444 << 16
        new.writestr(info, envelope)
    return destination


@dataclass(frozen=True, slots=True)
@trace_public_class("plugin_package", concise=("open",))
class PluginPackage:
    path: Path
    package_digest: str
    manifest: Mapping[str, Any]
    files: Mapping[str, str]
    signed: bool

    @classmethod
    def open(cls, path: str | os.PathLike[str], *, verifier: SignatureVerifier | None = None,
             trusted_keys: set[str] | None = None, allow_unsigned: bool = False) -> "PluginPackage":
        source = Path(path).expanduser().absolute()
        try:
            if source.is_symlink() or (getattr(source.stat(), "st_file_attributes", 0) & 0x400):
                raise PackageError("plugin archive cannot be a link or reparse point")
        except OSError as exc:
            raise PackageError("plugin archive cannot be inspected") from exc
        try:
            try:
                archive_bytes = source.stat().st_size
            except OSError as exc:
                raise PackageError("plugin archive cannot be inspected") from exc
            if archive_bytes > MAX_ARCHIVE_BYTES:
                raise PackageError("plugin archive exceeds size limit")
            archive = zipfile.ZipFile(source)
        except (OSError, zipfile.BadZipFile) as exc:
            raise PackageError("invalid plugin archive") from exc
        with archive:
            infos = archive.infolist()
            if not 3 <= len(infos) <= MAX_MEMBERS:
                raise PackageError("plugin archive member count is invalid")
            seen: set[str] = set()
            for info in infos:
                folded = unicodedata.normalize("NFC", info.filename).casefold()
                mode = (info.external_attr >> 16) & 0o170000
                if folded in seen or not _safe_member(info.filename) or info.is_dir() or mode == 0o120000 or (info.external_attr & 0x400):
                    raise PackageError("plugin archive has unsafe or duplicate members")
                seen.add(folded)
                if info.file_size < 0 or info.file_size > MAX_MEMBER_BYTES or (info.file_size and not info.compress_size):
                    raise PackageError("plugin archive member size is invalid")
                if info.file_size / max(info.compress_size, 1) > 1000:
                    raise PackageError("plugin archive compression ratio is unsafe")
            names = {info.filename for info in infos}
            if {"plugin.json", "files.sha256"} - names:
                raise PackageError("plugin archive is incomplete")
            manifest_info = archive.getinfo("plugin.json")
            if manifest_info.file_size > MAX_MANIFEST_BYTES:
                raise PackageError("plugin manifest exceeds size limit")
            manifest_bytes = archive.read(manifest_info)
            try:
                manifest_value = json.loads(manifest_bytes.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
                raise PackageError("plugin manifest is invalid JSON") from exc
            manifest = _validate_manifest(manifest_value)
            if manifest_bytes != canonical_json(manifest):
                raise PackageError("plugin.json is not canonical")
            entrypoint = manifest["entrypoint"]["path"]
            allowed = {"plugin.json", "files.sha256", "signature.json", entrypoint}
            if names - allowed:
                raise PackageError("plugin archive contains unknown members")
            files_info = archive.getinfo("files.sha256")
            if files_info.file_size > MAX_MANIFEST_BYTES:
                raise PackageError("files.sha256 exceeds size limit")
            try:
                files_bytes = archive.read(files_info)
                lines = files_bytes.decode("ascii").splitlines()
            except UnicodeDecodeError as exc:
                raise PackageError("files.sha256 is not ASCII") from exc
            files: dict[str, str] = {}
            for line in lines:
                pieces = line.split("  ", 1)
                if len(pieces) != 2 or not _SHA256.fullmatch(pieces[0]) or not _safe_member(pieces[1]):
                    raise PackageError("files.sha256 is invalid")
                if pieces[1] in files or pieces[1] in {"files.sha256", "signature.json"}:
                    raise PackageError("files.sha256 contains a duplicate or forbidden member")
                files[pieces[1]] = pieces[0]
            if set(files) != {"plugin.json", entrypoint}:
                raise PackageError("files.sha256 does not match package members")
            canonical_files = ("\n".join(f"{digest}  {name}" for name, digest in sorted(files.items())) + "\n").encode("ascii")
            if files_bytes != canonical_files:
                raise PackageError("files.sha256 is not canonical")
            if (files["plugin.json"] != hashlib.sha256(manifest_bytes).hexdigest() or
                    files[entrypoint] != _sha256_member(archive, archive.getinfo(entrypoint))):
                raise PackageError("plugin member digest mismatch")
            if files[entrypoint] != manifest["entrypoint"]["sha256"]:
                raise PackageError("entrypoint digest does not match manifest")
            signed = "signature.json" in names
            if not signed and not allow_unsigned:
                raise PackageError("unsigned plugin packages are disabled")
            if signed:
                if verifier is None:
                    raise PackageError("a signature verifier is required")
                try:
                    signature_bytes = archive.read("signature.json")
                    signature = json.loads(signature_bytes.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
                    raise PackageError("plugin signature envelope is invalid JSON") from exc
                if not isinstance(signature, dict) or set(signature) != {"algorithm", "keyId", "signature"} or signature["algorithm"] not in _ALGORITHMS:
                    raise PackageError("plugin signature envelope is invalid")
                if signature_bytes != canonical_json(signature):
                    raise PackageError("plugin signature envelope is not canonical")
                if signature["keyId"] != manifest["publisherKeyId"] or not _KEY_ID.fullmatch(signature["keyId"]):
                    raise PackageError("plugin signer does not match manifest")
                if trusted_keys is not None and signature["keyId"] not in trusted_keys:
                    raise PackageError("plugin signer is not trusted")
                if not verifier.verify(key_id=signature["keyId"], signed=_signed_body(manifest, files), signature=_b64decode(signature["signature"], "signature")):
                    raise PackageError("plugin signature verification failed")
            digest = _sha256_file(source)
            return cls(source, digest, manifest, files, signed)


def build_unsigned_package(source_dir: str | os.PathLike[str], destination: str | os.PathLike[str], manifest: Mapping[str, Any]) -> Path:
    """Build a deterministic unsigned fixture package.

    Production callers must add a signature using the release signing tool;
    this helper deliberately cannot produce a production-trusted package.
    """
    checked = _validate_manifest(dict(manifest))
    root = Path(source_dir).expanduser().absolute()
    entry = root / checked["entrypoint"]["path"]
    if not entry.is_file() or _sha256_file(entry) != checked["entrypoint"]["sha256"]:
        raise PackageError("fixture entrypoint is missing or has the wrong digest")
    files = {"plugin.json": hashlib.sha256(canonical_json(checked)).hexdigest(), checked["entrypoint"]["path"]: checked["entrypoint"]["sha256"]}
    destination = Path(destination).expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise PackageError("fixture package destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_STORED) as archive:
        metadata = (("plugin.json", canonical_json(checked)),
                    ("files.sha256", ("\n".join(f"{digest}  {name}" for name, digest in sorted(files.items())) + "\n").encode("ascii")))
        for name, data in metadata:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100444 << 16
            archive.writestr(info, data)
        info = zipfile.ZipInfo(checked["entrypoint"]["path"], date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = 0o100444 << 16
        _write_member(archive, info, entry)
    return destination
