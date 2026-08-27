"""Trust, permission grants, revocation, and Windows CNG verification."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any, Mapping


_PLUGIN_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_KEY_ID = re.compile(r"^[0-9a-f]{64}$")
_DIGEST = _KEY_ID
_PERMISSIONS = {"networkProxy", "credentialUse", "assetRead", "assetWrite", "cache"}


class SecurityError(ValueError):
    """A trust or permission operation is invalid."""


def _reject_linked_state_path(path: Path) -> None:
    """Reject links/reparse points in every existing state path component."""
    current = path.absolute()
    components = list(reversed(current.parents)) + [current]
    for item in components:
        try:
            linked = item.is_symlink() or bool(getattr(item.lstat(), "st_file_attributes", 0) & 0x400)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise SecurityError("security state path cannot be inspected") from exc
        if linked:
            raise SecurityError("security state path cannot contain a link or reparse point")


def _key_id(public_key: bytes) -> str:
    return hashlib.sha256(public_key).hexdigest()


class CngSignatureVerifier:
    """Verify P-256/SHA-256 signatures with Windows CNG.

    The package format stores the 64-byte uncompressed affine public point
    (X||Y) and the 64-byte IEEE-P1363 signature (R||S). Private keys and
    signing operations are intentionally not exposed by the SDK.
    """

    def __init__(self, keys: Mapping[str, bytes]) -> None:
        self.keys = dict(keys)

    def verify(self, *, key_id: str, signed: bytes, signature: bytes) -> bool:
        if sys.platform != "win32" or key_id not in self.keys or len(signature) != 64:
            return False
        public = self.keys[key_id]
        if len(public) != 64 or _key_id(public) != key_id:
            return False
        try:
            import ctypes
            from ctypes import wintypes
            bcrypt = ctypes.WinDLL("bcrypt", use_last_error=True)
            bcrypt.BCryptOpenAlgorithmProvider.argtypes = [ctypes.POINTER(wintypes.HANDLE), wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.ULONG]
            bcrypt.BCryptOpenAlgorithmProvider.restype = ctypes.c_long
            bcrypt.BCryptImportKeyPair.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.LPCWSTR, ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG]
            bcrypt.BCryptImportKeyPair.restype = ctypes.c_long
            bcrypt.BCryptVerifySignature.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.c_void_p, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG]
            bcrypt.BCryptVerifySignature.restype = ctypes.c_long
            bcrypt.BCryptDestroyKey.argtypes = [wintypes.HANDLE]
            bcrypt.BCryptDestroyKey.restype = ctypes.c_long
            bcrypt.BCryptCloseAlgorithmProvider.argtypes = [wintypes.HANDLE, wintypes.ULONG]
            bcrypt.BCryptCloseAlgorithmProvider.restype = ctypes.c_long
            alg = wintypes.HANDLE()
            if bcrypt.BCryptOpenAlgorithmProvider(ctypes.byref(alg), "ECDSA_P256", None, 0) != 0:
                return False
            key = wintypes.HANDLE()
            # BCRYPT_ECCPUBLIC_BLOB: magic ECS1, cbKey=32, X, Y.
            blob = (0x31534345).to_bytes(4, "little") + (32).to_bytes(4, "little") + public
            blob_buf = ctypes.create_string_buffer(blob)
            try:
                if bcrypt.BCryptImportKeyPair(alg, None, "ECCPUBLICBLOB", ctypes.byref(key), blob_buf, len(blob), 0) != 0:
                    return False
                digest = hashlib.sha256(signed).digest()
                digest_buf = ctypes.create_string_buffer(digest)
                sig_buf = ctypes.create_string_buffer(signature)
                return bcrypt.BCryptVerifySignature(key, None, digest_buf, len(digest), sig_buf, len(signature), 0) == 0
            finally:
                if key:
                    bcrypt.BCryptDestroyKey(key)
                bcrypt.BCryptCloseAlgorithmProvider(alg, 0)
        except (AttributeError, OSError, TypeError):
            return False


class TrustStore:
    """Explicit publisher-key trust; never trusts keys from a package."""

    def __init__(self) -> None:
        self._keys: dict[str, bytes] = {}
        self._scopes: dict[str, frozenset[str]] = {}

    def trust_publisher(self, public_key: bytes, *, plugin_ids: set[str] | None = None) -> str:
        if not isinstance(public_key, bytes) or len(public_key) != 64:
            raise SecurityError("publisher key must be a P-256 point")
        if plugin_ids is not None and any(not isinstance(item, str) or not _PLUGIN_ID.fullmatch(item) for item in plugin_ids):
            raise SecurityError("publisher plugin scope is invalid")
        key_id = _key_id(public_key)
        self._keys[key_id] = bytes(public_key)
        self._scopes[key_id] = frozenset(plugin_ids or ())
        return key_id

    def revoke_publisher(self, key_id: str) -> None:
        if not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id):
            raise SecurityError("publisher key ID is invalid")
        self._keys.pop(key_id, None)
        self._scopes.pop(key_id, None)

    def contains(self, key_id: str, plugin_id: str) -> bool:
        return key_id in self._keys and (not self._scopes[key_id] or plugin_id in self._scopes[key_id])

    def verifier(self) -> CngSignatureVerifier:
        return CngSignatureVerifier(self._keys)

    @property
    def key_ids(self) -> frozenset[str]:
        return frozenset(self._keys)


class PermissionGrantStore:
    """Per-project grants bound to the immutable package digest."""

    def __init__(self) -> None:
        self._grants: dict[tuple[str, str, str, str], dict[str, Any]] = {}

    def grant(self, *, project_id: str, plugin_id: str, publisher_key_id: str,
              package_digest: str, permissions: Mapping[str, Any], requested: Mapping[str, Any]) -> None:
        if (not _DIGEST.fullmatch(package_digest) or
                not _PLUGIN_ID.fullmatch(plugin_id) or
                not _KEY_ID.fullmatch(publisher_key_id) or
                not isinstance(project_id, str) or not project_id or len(project_id) > 128):
            raise SecurityError("grant identity is invalid")
        if set(permissions) - _PERMISSIONS:
            raise SecurityError("grant contains an unknown permission")
        if not _subset_permissions(permissions, requested):
            raise SecurityError("grant exceeds package permissions")
        self._grants[(project_id, plugin_id, publisher_key_id, package_digest)] = json.loads(json.dumps(dict(permissions), sort_keys=True))

    def allowed(self, *, project_id: str, plugin_id: str, publisher_key_id: str,
                package_digest: str, permission: str, value: Any = True) -> bool:
        grant = self._grants.get((project_id, plugin_id, publisher_key_id, package_digest), {})
        return _permission_contains(grant.get(permission, False), value)

    def clear_package(self, package_digest: str) -> None:
        for identity in [key for key in self._grants if key[3] == package_digest]:
            del self._grants[identity]

    def has_grant(self, *, project_id: str, plugin_id: str, publisher_key_id: str, package_digest: str) -> bool:
        return (project_id, plugin_id, publisher_key_id, package_digest) in self._grants


def _permission_contains(granted: Any, requested: Any) -> bool:
    if isinstance(granted, bool):
        return granted and requested is True
    if isinstance(granted, list):
        return isinstance(requested, str) and requested in granted
    return False


def _subset_permissions(granted: Mapping[str, Any], requested: Mapping[str, Any]) -> bool:
    for key, value in granted.items():
        if isinstance(value, bool):
            if value and requested.get(key) is not True:
                return False
        elif isinstance(value, list):
            allowed = requested.get(key, [])
            if not isinstance(allowed, list) or any(item not in allowed for item in value):
                return False
        else:
            return False
    return True


class RevocationStore:
    """Fail-closed local revocation state for package, signer, and plugin IDs."""

    def __init__(self) -> None:
        self.package_digests: set[str] = set()
        self.signer_ids: set[str] = set()
        self.plugin_ids: set[str] = set()
        self.version = 0

    def revoke(self, *, package_digest: str | None = None, signer_id: str | None = None, plugin_id: str | None = None) -> None:
        if package_digest is None and signer_id is None and plugin_id is None:
            raise SecurityError("revocation must identify a package, signer, or plugin")
        if package_digest is not None and not _DIGEST.fullmatch(package_digest):
            raise SecurityError("revoked package digest is invalid")
        if signer_id is not None and not _KEY_ID.fullmatch(signer_id):
            raise SecurityError("revoked signer ID is invalid")
        if plugin_id is not None and not _PLUGIN_ID.fullmatch(plugin_id):
            raise SecurityError("revoked plugin ID is invalid")
        if package_digest:
            self.package_digests.add(package_digest)
        if signer_id:
            self.signer_ids.add(signer_id)
        if plugin_id:
            self.plugin_ids.add(plugin_id)
        self.version += 1

    def is_revoked(self, *, package_digest: str, signer_id: str, plugin_id: str) -> bool:
        return package_digest in self.package_digests or signer_id in self.signer_ids or plugin_id in self.plugin_ids


def _state_json(value: Any) -> bytes:
    try:
        return (json.dumps(value, ensure_ascii=False, allow_nan=False,
                           separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise SecurityError("security state is not serializable") from exc


class PersistentSecurityState:
    """Atomic JSON persistence for public trust, grants, and revocations."""

    def __init__(self, path: str | os.PathLike[str], *, trust: TrustStore | None = None,
                 grants: PermissionGrantStore | None = None,
                 revocations: RevocationStore | None = None) -> None:
        self.path = Path(path).expanduser().absolute()
        self.trust = trust or TrustStore()
        self.grants = grants or PermissionGrantStore()
        self.revocations = revocations or RevocationStore()

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> "PersistentSecurityState":
        target = Path(path).expanduser().absolute()
        _reject_linked_state_path(target)
        if not target.exists():
            return cls(target)
        try:
            raw = target.read_bytes()
            value = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise SecurityError("security state is corrupt") from exc
        if raw != _state_json(value) or not isinstance(value, dict) or set(value) != {"version", "trust", "grants", "revocations"} or value.get("version") != 1:
            raise SecurityError("security state is corrupt")
        try:
            trust = TrustStore()
            trust_values = value["trust"]
            if not isinstance(trust_values, list):
                raise SecurityError("security trust state is corrupt")
            for item in trust_values:
                if not isinstance(item, dict) or set(item) != {"keyId", "publicKey", "pluginIds"}:
                    raise SecurityError("security trust state is corrupt")
                public = base64.urlsafe_b64decode(item["publicKey"] + "=" * (-len(item["publicKey"]) % 4))
                if _key_id(public) != item["keyId"] or not isinstance(item["pluginIds"], list):
                    raise SecurityError("security trust state is corrupt")
                trust.trust_publisher(public, plugin_ids=set(item["pluginIds"]))
            grants = PermissionGrantStore()
            grant_values = value["grants"]
            if not isinstance(grant_values, list):
                raise SecurityError("security grant state is corrupt")
            for item in grant_values:
                if not isinstance(item, dict) or set(item) != {"projectId", "pluginId", "publisherKeyId", "packageDigest", "permissions"}:
                    raise SecurityError("security grant state is corrupt")
                grants.grant(project_id=item["projectId"], plugin_id=item["pluginId"],
                             publisher_key_id=item["publisherKeyId"], package_digest=item["packageDigest"],
                             permissions=item["permissions"], requested=item["permissions"])
            revocation = value["revocations"]
            if not isinstance(revocation, dict) or set(revocation) != {"packageDigests", "signerIds", "pluginIds", "version"}:
                raise SecurityError("security revocation state is corrupt")
            revocations = RevocationStore()
            for digest in revocation["packageDigests"]:
                revocations.revoke(package_digest=digest)
            for signer in revocation["signerIds"]:
                revocations.revoke(signer_id=signer)
            for plugin in revocation["pluginIds"]:
                revocations.revoke(plugin_id=plugin)
            if not isinstance(revocation["version"], int) or revocation["version"] < revocations.version:
                raise SecurityError("security revocation state is corrupt")
            revocations.version = revocation["version"]
            return cls(target, trust=trust, grants=grants, revocations=revocations)
        except (KeyError, TypeError, ValueError, base64.binascii.Error) as exc:
            raise SecurityError("security state is corrupt") from exc

    open = load

    def save(self) -> None:
        _reject_linked_state_path(self.path)
        value = {
            "version": 1,
            "trust": [{"keyId": key_id, "publicKey": base64.urlsafe_b64encode(public).rstrip(b"=").decode("ascii"),
                       "pluginIds": sorted(self.trust._scopes[key_id])} for key_id, public in sorted(self.trust._keys.items())],
            "grants": [{"projectId": identity[0], "pluginId": identity[1], "publisherKeyId": identity[2],
                        "packageDigest": identity[3], "permissions": permissions}
                       for identity, permissions in sorted(self.grants._grants.items())],
            "revocations": {"packageDigests": sorted(self.revocations.package_digests),
                            "signerIds": sorted(self.revocations.signer_ids),
                            "pluginIds": sorted(self.revocations.plugin_ids),
                            "version": self.revocations.version},
        }
        data = _state_json(value)
        parent = self.path.parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=parent)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(temporary, 0o600)
                os.replace(temporary, self.path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        except OSError as exc:
            raise SecurityError("security state could not be persisted") from exc
