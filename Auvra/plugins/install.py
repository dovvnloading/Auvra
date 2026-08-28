"""Fail-closed validation, extraction, and Windows ACL installation."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Callable
import zipfile

from .package import PluginPackage, PackageError
from Auvra.diagnostics import trace_public_class


class InstallError(PackageError):
    """An install could not be completed without leaving a usable partial copy."""


@dataclass(frozen=True, slots=True)
class InstalledPlugin:
    package: PluginPackage
    directory: Path
    executable: Path


def _linked(path: Path) -> bool:
    try:
        return path.is_symlink() or bool(getattr(path.stat(), "st_file_attributes", 0) & 0x400)
    except OSError as exc:
        raise InstallError("plugin install path cannot be inspected") from exc


def _check_tree(root: Path, target: Path) -> None:
    root = root.absolute()
    target = target.absolute()
    try:
        relative = target.relative_to(root)
    except ValueError as exc:
        raise InstallError("plugin extraction escaped its install root") from exc
    current = root
    if _linked(root):
        raise InstallError("plugin install root cannot be a link or reparse point")
    for part in relative.parts:
        current /= part
        if current.exists() and _linked(current):
            raise InstallError("plugin extraction encountered a link or reparse point")


def _check_existing_components(path: Path) -> None:
    current = Path(path.absolute().anchor)
    for part in path.absolute().parts[1:]:
        current /= part
        if (current.exists() or current.is_symlink()) and _linked(current):
            raise InstallError("plugin install path cannot contain links or reparse points")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _remove_staging(path: Path) -> None:
    """Remove a failed staging tree even after immutable modes were applied."""
    if not path.exists():
        return
    for item in sorted(path.rglob("*"), key=lambda value: len(value.parts), reverse=True):
        try:
            item.chmod(0o700)
        except OSError:
            pass
    try:
        path.chmod(0o700)
    except OSError:
        pass
    shutil.rmtree(path, ignore_errors=True)
    if path.exists():
        raise InstallError("failed plugin installation left staging data")


@trace_public_class("plugin_install", concise=("install",))
class PluginInstaller:
    """Install only a fully validated package into a digest-addressed directory."""

    def __init__(self, root: str | os.PathLike[str] | None = None,
                 *, acl_grant: Callable[[Path, PluginPackage], None] | None = None) -> None:
        if root is None:
            local = os.environ.get("LOCALAPPDATA")
            if not local:
                raise InstallError("a user-local plugin root is unavailable")
            root = Path(local) / "Auvra" / "plugins"
        self.root = Path(root).expanduser().absolute()
        self.acl_grant = acl_grant or _grant_appcontainer_read_execute

    def install(self, path: str | os.PathLike[str], *, verifier=None,
                trusted_keys: set[str] | None = None,
                allow_unsigned: bool = False) -> InstalledPlugin:
        # Complete archive/signature validation always precedes filesystem writes.
        package = PluginPackage.open(path, verifier=verifier, trusted_keys=trusted_keys,
                                    allow_unsigned=allow_unsigned)
        _check_existing_components(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        _check_tree(self.root, self.root)
        final = self.root / package.package_digest
        _check_tree(self.root, final)
        if final.is_symlink() or (final.exists() and _linked(final)):
            raise InstallError("existing digest-addressed plugin install is a link or reparse point")
        executable = final / package.manifest["entrypoint"]["path"]
        if final.exists():
            payload_dir = final / "payload"
            expected = {"payload", "payload/" + executable.name}
            actual = {item.relative_to(final).as_posix() for item in final.rglob("*")}
            if (_linked(final) or not payload_dir.is_dir() or _linked(payload_dir)
                    or actual != expected or not executable.is_file() or _linked(executable)
                    or _sha256(executable) != package.manifest["entrypoint"]["sha256"]):
                raise InstallError("existing digest-addressed plugin install is invalid")
            return InstalledPlugin(package, final, executable)
        staging = Path(tempfile.mkdtemp(prefix=f".{package.package_digest}.", dir=self.root))
        try:
            payload = staging / "payload"
            payload.mkdir()
            target = payload / Path(package.manifest["entrypoint"]["path"]).name
            _check_tree(staging, target)
            with zipfile.ZipFile(package.path, "r") as archive:
                info = archive.getinfo(package.manifest["entrypoint"]["path"])
                with archive.open(info, "r") as source, target.open("xb") as output:
                    for block in iter(lambda: source.read(1024 * 1024), b""):
                        output.write(block)
            if _sha256(target) != package.manifest["entrypoint"]["sha256"]:
                raise InstallError("extracted plugin digest does not match package")
            target.chmod(0o555)
            payload.chmod(0o555)
            # The callback is injectable for deterministic tests but production
            # always uses the native AppContainer SID ACL implementation.
            self.acl_grant(staging, package)
            os.rename(staging, final)  # atomic and refuses an existing final dir
            staging = None  # type: ignore[assignment]
            final.chmod(0o555)
            return InstalledPlugin(package, final, final / "payload" / target.name)
        except (OSError, zipfile.BadZipFile) as exc:
            raise InstallError("plugin installation failed closed") from exc
        finally:
            if staging is not None and staging.exists():
                _remove_staging(staging)


def _grant_appcontainer_read_execute(directory: Path, package: PluginPackage) -> None:
    """Grant only read/execute ACLs to this package's exact AppContainer SID."""
    if sys.platform != "win32":
        raise InstallError("Windows AppContainer ACLs are unavailable")
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    LPVOID = ctypes.c_void_p
    HANDLE = wintypes.HANDLE
    HRESULT = ctypes.c_long
    userenv.CreateAppContainerProfile.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, LPVOID, wintypes.DWORD, ctypes.POINTER(LPVOID)]
    userenv.CreateAppContainerProfile.restype = HRESULT
    userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(LPVOID)]
    userenv.DeriveAppContainerSidFromAppContainerName.restype = HRESULT
    advapi32.FreeSid.argtypes = [LPVOID]
    advapi32.FreeSid.restype = LPVOID
    profile = "Auvra.Plugin." + package.manifest["pluginId"] + "." + package.package_digest[:16]
    sid = LPVOID()
    hr = userenv.CreateAppContainerProfile(profile, profile, "Auvra provider plugin", None, 0, ctypes.byref(sid))
    if hr != 0 and userenv.DeriveAppContainerSidFromAppContainerName(profile, ctypes.byref(sid)) != 0:
        raise InstallError("AppContainer profile could not be created")
    if not sid:
        raise InstallError("AppContainer SID is unavailable")
    class TRUSTEE(ctypes.Structure):
        _fields_ = [("pMultipleTrustee", LPVOID), ("MultipleTrusteeOperation", wintypes.DWORD),
                    ("TrusteeForm", wintypes.DWORD), ("TrusteeType", wintypes.DWORD), ("ptstrName", LPVOID)]
    class EXPLICIT_ACCESS(ctypes.Structure):
        _fields_ = [("grfAccessPermissions", wintypes.DWORD), ("grfAccessMode", wintypes.DWORD),
                    ("grfInheritance", wintypes.DWORD), ("Trustee", TRUSTEE)]
    advapi32.GetNamedSecurityInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(LPVOID), ctypes.POINTER(LPVOID), ctypes.POINTER(LPVOID), ctypes.POINTER(LPVOID), ctypes.POINTER(LPVOID)]
    advapi32.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi32.SetEntriesInAclW.argtypes = [wintypes.ULONG, ctypes.POINTER(EXPLICIT_ACCESS), LPVOID, ctypes.POINTER(LPVOID)]
    advapi32.SetEntriesInAclW.restype = wintypes.DWORD
    advapi32.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD, LPVOID, LPVOID, LPVOID, LPVOID]
    advapi32.SetNamedSecurityInfoW.restype = wintypes.DWORD
    kernel32.LocalFree.argtypes = [LPVOID]
    kernel32.LocalFree.restype = LPVOID
    try:
        trustee = TRUSTEE(None, 0, 0, 0, sid)
        entry = EXPLICIT_ACCESS(0x1200A9, 1, 3, trustee)  # read/execute + child inheritance
        for item in (directory, directory / "payload",
                     directory / "payload" / Path(package.manifest["entrypoint"]["path"]).name):
            if _linked(item):
                raise InstallError("plugin install path became a link or reparse point")
            old_dacl = LPVOID(); security_descriptor = LPVOID(); new_dacl = LPVOID()
            error = advapi32.GetNamedSecurityInfoW(str(item), 1, 4, None, None, ctypes.byref(old_dacl), None, ctypes.byref(security_descriptor))
            if error:
                raise InstallError("plugin ACL could not be read")
            try:
                error = advapi32.SetEntriesInAclW(1, ctypes.byref(entry), old_dacl, ctypes.byref(new_dacl))
                if error:
                    raise InstallError("plugin ACL could not be composed")
                error = advapi32.SetNamedSecurityInfoW(str(item), 1, 4, None, None, new_dacl, None)
                if error:
                    raise InstallError("plugin ACL could not be applied")
            finally:
                if security_descriptor:
                    kernel32.LocalFree(security_descriptor)
                if new_dacl:
                    kernel32.LocalFree(new_dacl)
    finally:
        advapi32.FreeSid(sid)


__all__ = ["InstallError", "InstalledPlugin", "PluginInstaller"]
