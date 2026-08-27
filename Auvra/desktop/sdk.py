"""Pinned, least-privilege acquisition of the official WebView2 SDK.

Only the SDK assemblies and x64 loader are copied. The Evergreen Runtime is
an operating-system prerequisite and is never downloaded or redistributed.
"""

from __future__ import annotations

from dataclasses import dataclass
import errno
import hashlib
import io
import os
from pathlib import Path
import shutil
import stat
import tempfile
import threading
from typing import Callable
from urllib.request import Request, urlopen
import zipfile


SDK_VERSION = "1.0.4129.50"
SDK_SHA256 = "d3934f482d484b89fb4825df720c710664e1143a1e90f7b3a60794ef33f473d2"
SDK_URL = f"https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{SDK_VERSION}/microsoft.web.webview2.{SDK_VERSION}.nupkg"
SDK_LICENSE = "BSD-3-Clause (Microsoft.Web.WebView2 SDK; LICENSE.txt in archive)"
SDK_NOTICE = "NOTICE.txt in the official Microsoft.Web.WebView2 NuGet archive"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_EXTRACTED_BYTES = 64 * 1024 * 1024

_REQUIRED = {
    "lib/net462/Microsoft.Web.WebView2.Core.dll": "Microsoft.Web.WebView2.Core.dll",
    "lib/net462/Microsoft.Web.WebView2.WinForms.dll": "Microsoft.Web.WebView2.WinForms.dll",
    "runtimes/win-x64/native/WebView2Loader.dll": "WebView2Loader.dll",
    "LICENSE.txt": "LICENSE.txt",
    "NOTICE.txt": "NOTICE.txt",
}
_FILE_HASHES = {
    "Microsoft.Web.WebView2.Core.dll": "958efdb7f13a6d1f3079756c96956cc96cf713ae46fa085c8b1e7f44316a4f7e",
    "Microsoft.Web.WebView2.WinForms.dll": "a7b8be525030f19d9e88c6e684bca053dc7a3b080c31c3d9428f7438e7b6768f",
    "WebView2Loader.dll": "a9a09232c25805323d4cfb3fc8f545a190a9c8a99c93262ea99d0b88df99ec90",
    "LICENSE.txt": "0af8f1b807512aae39c2ac1aa4d0cae65cabecb6fd554b8439a5162a0d6eca55",
    "NOTICE.txt": "106423785c5b7eba0a8e61d1837f2132e9c828e20ad530f565d981c1df60dd90",
}


class SdkError(RuntimeError):
    """Bounded SDK acquisition or integrity error."""


@dataclass(frozen=True, slots=True)
class SdkLayout:
    root: Path
    core_assembly: Path
    winforms_assembly: Path
    loader: Path
    license_file: Path
    notice_file: Path


Downloader = Callable[[str], bytes]


def _default_downloader(url: str, *, timeout: float = 30.0) -> bytes:
    request = Request(url, headers={"User-Agent": "Auvra-WebView2-SDK/1"})
    try:
        with urlopen(request, timeout=timeout) as response:
            length = response.headers.get("Content-Length")
            if length and int(length) > MAX_ARCHIVE_BYTES:
                raise SdkError("WebView2 SDK archive is too large")
            result = bytearray()
            while chunk := response.read(1024 * 1024):
                result.extend(chunk)
                if len(result) > MAX_ARCHIVE_BYTES:
                    raise SdkError("WebView2 SDK archive is too large")
            return bytes(result)
    except SdkError:
        raise
    except Exception as exc:
        raise SdkError("unable to download the pinned WebView2 SDK") from exc


def _valid_file(path: Path, digest: str) -> bool:
    if not path.is_file():
        return False
    hasher = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
    except OSError:
        return False
    return hasher.hexdigest() == digest


def _layout(root: Path) -> SdkLayout:
    return SdkLayout(root, root / "Microsoft.Web.WebView2.Core.dll", root / "Microsoft.Web.WebView2.WinForms.dll",
                     root / "WebView2Loader.dll", root / "LICENSE.txt", root / "NOTICE.txt")


def _remove_temp(path: Path) -> None:
    try:
        if path.is_symlink() or not path.is_dir():
            path.unlink()
        else:
            shutil.rmtree(path, ignore_errors=True)
    except OSError:
        pass


def _cached(root: Path) -> SdkLayout | None:
    marker = root / ".auvra-sdk.sha256"
    try:
        lines = marker.read_text(encoding="ascii").splitlines()
        recorded = dict(line.split(" ", 1) for line in lines[1:] if " " in line)
        if not lines or lines[0].strip() != SDK_SHA256 or any(recorded.get(name) != digest for name, digest in _FILE_HASHES.items()):
            return None
    except (OSError, UnicodeError):
        return None
    layout = _layout(root)
    if all(_valid_file(path, _FILE_HASHES[path.name]) for path in (layout.core_assembly, layout.winforms_assembly, layout.loader, layout.license_file, layout.notice_file)):
        return layout
    return None


def _safe_member(name: str, info: zipfile.ZipInfo) -> None:
    # Zip member paths are always POSIX separators. Reject absolute paths,
    # drive-qualified paths, traversal, and symlinks before opening anything.
    if not name or name.startswith(("/", "\\")) or ":" in name.split("/", 1)[0]:
        raise SdkError("WebView2 SDK archive contains an unsafe path")
    parts = name.split("/")
    if name.endswith("/"):
        parts = parts[:-1]
    if any(part in {"", ".", ".."} for part in parts):
        raise SdkError("WebView2 SDK archive contains an unsafe path")
    mode = (info.external_attr >> 16) & 0xFFFF
    if stat.S_ISLNK(mode):
        raise SdkError("WebView2 SDK archive contains an unsafe member")


def _extract(archive: bytes, destination: Path) -> None:
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            members = {entry.filename: entry for entry in bundle.infolist()}
            for entry in bundle.infolist():
                _safe_member(entry.filename, entry)
            if not _REQUIRED.keys() <= members.keys():
                raise SdkError("pinned WebView2 SDK archive is incomplete")
            for source, target_name in _REQUIRED.items():
                info = members[source]
                _safe_member(info.filename, info)
                if info.file_size < 0 or info.file_size > MAX_EXTRACTED_BYTES:
                    raise SdkError("WebView2 SDK archive member is too large")
                total += info.file_size
                if total > MAX_EXTRACTED_BYTES:
                    raise SdkError("WebView2 SDK archive is too large")
                target = destination / target_name
                with bundle.open(info, "r") as source_stream, target.open("xb") as target_stream:
                    shutil.copyfileobj(source_stream, target_stream, 1024 * 1024)
    except SdkError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise SdkError("unable to extract the pinned WebView2 SDK") from exc


def acquire_sdk(cache_dir: Path | str, *, downloader: Downloader | None = None) -> SdkLayout:
    """Return a verified SDK layout, downloading it atomically if necessary."""
    base = Path(cache_dir).expanduser().resolve()
    target = base / f"microsoft.web.webview2-{SDK_VERSION}-x64"
    cached = _cached(target)
    if cached:
        return cached
    base.mkdir(parents=True, exist_ok=True)
    try:
        archive = (downloader or _default_downloader)(SDK_URL)
    except SdkError:
        raise
    except Exception as exc:
        raise SdkError("WebView2 SDK downloader failed") from exc
    if not isinstance(archive, (bytes, bytearray)) or len(archive) > MAX_ARCHIVE_BYTES:
        raise SdkError("WebView2 SDK downloader returned an invalid archive")
    if hashlib.sha256(archive).hexdigest() != SDK_SHA256:
        raise SdkError("WebView2 SDK archive digest does not match the pinned release")
    temp: Path | None = Path(tempfile.mkdtemp(prefix=f".auvra-sdk-{SDK_VERSION}-", dir=base))
    quarantine: Path | None = None
    try:
        _extract(bytes(archive), temp)
        marker = SDK_SHA256 + "\n" + "\n".join(f"{name} {digest}" for name, digest in _FILE_HASHES.items()) + "\n"
        (temp / ".auvra-sdk.sha256").write_text(marker, encoding="ascii")
        # The target is a version/digest-specific immutable publication. Never
        # replace a verified cache another process may already have published.
        try:
            os.replace(temp, target)
            temp = None
        except OSError as exc:
            if not isinstance(exc, (FileExistsError, PermissionError)) and exc.errno != errno.ENOTEMPTY:
                raise SdkError("WebView2 SDK cache publication failed") from exc
            # A POSIX rename cannot replace a non-empty directory, and
            # Windows does not replace an existing directory at all. Re-check
            # for a concurrent valid publisher, otherwise quarantine the
            # invalid cache before publishing our verified directory.
            if _cached(target) is None and target.exists() and temp is not None:
                quarantine = base / f".{target.name}.invalid-{os.getpid()}-{threading.get_ident()}"
                try:
                    os.replace(target, quarantine)
                    os.replace(temp, target)
                    temp = None
                except OSError as exc:
                    raise SdkError("WebView2 SDK cache publication failed") from exc
        result = _cached(target)
        if result is None:
            raise SdkError("WebView2 SDK cache publication failed integrity checks")
        return result
    finally:
        if temp is not None:
            _remove_temp(temp)
        if quarantine is not None:
            _remove_temp(quarantine)


def sdk_evidence() -> dict[str, str]:
    return {"version": SDK_VERSION, "sha256": SDK_SHA256, "source": SDK_URL, "license": SDK_LICENSE, "notice": SDK_NOTICE}
