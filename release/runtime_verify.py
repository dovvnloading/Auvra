"""Runtime-safe verifier copied into the packaged host during assembly.

This module intentionally has no dependency on the repository build toolchain,
network, or package manager.  It validates the signed package's canonical
release manifest before the packaged frontend or native engine is opened.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
from typing import Any


MIN_WINDOWS_BUILD = 26100
CHANNEL_IDENTITIES = {"stable": "Auvra", "beta": "Auvra.Beta", "dev": "Auvra.Dev"}
FORBIDDEN = (".git", ".auvra-local", "agents.md", "node_modules", ".venv", "__pycache__", ".pytest_cache", ".pfx", ".pem", ".key", ".env")
MSIX_CONTAINER_METADATA = {"AppxBlockMap.xml"}


class RuntimeVerificationError(RuntimeError):
    """The installed package cannot be trusted as a complete release."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative(value: str) -> str:
    path = Path(value)
    if not value or path.is_absolute() or "\\" in value or any(part in {"", ".", ".."} for part in value.split("/")):
        raise RuntimeVerificationError(f"invalid manifest path: {value!r}")
    return path.as_posix()


def verify_installed_package(package_root: Path | str) -> dict[str, Any]:
    root = Path(package_root).resolve()
    manifest_path = root / "release-manifest.json"
    try:
        raw = manifest_path.read_bytes()
        manifest = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeVerificationError("release manifest is unreadable") from exc
    if not isinstance(manifest, dict) or manifest.get("schema") != 1:
        raise RuntimeVerificationError("release manifest schema is unsupported")
    canonical = (json.dumps(manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    if raw != canonical:
        raise RuntimeVerificationError("release manifest is not canonical")
    channel = manifest.get("channel")
    if channel not in CHANNEL_IDENTITIES or manifest.get("identity") != CHANNEL_IDENTITIES[channel]:
        raise RuntimeVerificationError("release channel identity is invalid")
    if manifest.get("platform") != "win-x64" or int(manifest.get("minimumWindowsBuild", 0)) < MIN_WINDOWS_BUILD:
        raise RuntimeVerificationError("release platform or minimum Windows build is invalid")
    if sys.platform == "win32" and sys.getwindowsversion().build < MIN_WINDOWS_BUILD:
        raise RuntimeVerificationError("Windows 11 build is below the release minimum")

    expected: dict[str, dict[str, Any]] = {}
    for entry in manifest.get("files", []):
        if not isinstance(entry, dict):
            raise RuntimeVerificationError("release manifest file entry is invalid")
        relative = _safe_relative(str(entry.get("path", "")))
        if relative == "release-manifest.json" or relative in expected:
            raise RuntimeVerificationError("release manifest file list is invalid")
        if any(fragment in relative.lower() for fragment in FORBIDDEN):
            raise RuntimeVerificationError("forbidden file is listed in release manifest")
        expected[relative] = entry
    actual: dict[str, dict[str, Any]] = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            raise RuntimeVerificationError("installed package contains a link")
        if path.is_file() and path.name != "release-manifest.json":
            relative = path.relative_to(root).as_posix()
            if relative in MSIX_CONTAINER_METADATA:
                continue
            if any(fragment in relative.lower() for fragment in FORBIDDEN):
                raise RuntimeVerificationError("installed package contains a forbidden file")
            actual[relative] = {"path": relative, "size": path.stat().st_size, "sha256": _sha256(path)}
    if expected != actual:
        raise RuntimeVerificationError("installed package payload integrity check failed")
    required_files = (
        "AppxManifest.xml", "sbom.json", "frontend/index.html", "native/auvra-native.exe",
        "runtime/python/pythonw.exe", "runtime/python/python314._pth", "host/auvra_startup.py", "host/auvra_release_verify.py",
    )
    required_dirs = ("runtime/webview2-sdk", "runtime/webview2")
    for relative in required_dirs:
        if not (root / relative).is_dir():
            raise RuntimeVerificationError(f"required package directory is missing: {relative}")
    for relative in required_files:
        target = root / relative
        if not target.is_file():
            raise RuntimeVerificationError(f"required package file is missing: {relative}")
    return manifest
