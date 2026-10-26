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
# ``Auvra/host/validation.py`` and ``Auvra/project/schemas.py`` resolve their
# schemas from ``parents[2]`` of their own file.  In a package that is the
# ``host`` tree, so both schema directories are staged next to ``host/Auvra``.
# The project names must equal ``DOMAIN_NAMES`` plus the descriptor schema.
PROTOCOL_SCHEMA = "host/protocol/v1/auvra-host.schema.json"
PROJECT_SCHEMA_DIR = "host/project/v1"
PROJECT_SCHEMA_NAMES = (
    "metadata", "worlds", "scenes", "levels", "objects", "environment",
    "models", "animations", "attachments", "sockets", "textures", "audio",
    "materials", "blueprints", "graphs", "hud", "prefabs", "project",
)
HOST_SCHEMA_FILES = (PROTOCOL_SCHEMA, *(f"{PROJECT_SCHEMA_DIR}/{name}.schema.json" for name in PROJECT_SCHEMA_NAMES))


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
        "AppxManifest.xml", "sbom.json", "frontend/index.html", "native/auvra-native.exe", "game-player/auvra-player.exe",
        "runtime/python/pythonw.exe", "runtime/python/python314._pth", "host/auvra_startup.py", "host/auvra_release_verify.py",
        *HOST_SCHEMA_FILES,
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


def verify_packaged_schemas(package_root: Path | str) -> dict[str, Any]:
    """Compile the host protocol and project schemas as the packaged host does.

    The packaged interpreter imports ``Auvra`` from ``host``; this proves that
    the shipped modules resolve their schema files inside that tree (never a
    developer checkout) and that every shipped schema loads and compiles.
    """
    import importlib

    root = Path(package_root).resolve()
    try:
        validation = importlib.import_module("Auvra.host.validation")
        schemas = importlib.import_module("Auvra.project.schemas")
    except Exception as exc:
        raise RuntimeVerificationError(f"packaged schema modules could not be imported: {type(exc).__name__}") from exc
    if Path(validation.SCHEMA_PATH).resolve() != root / PROTOCOL_SCHEMA:
        raise RuntimeVerificationError("packaged protocol schema does not resolve inside the package host tree")
    if Path(schemas.SCHEMA_DIR).resolve() != root / PROJECT_SCHEMA_DIR:
        raise RuntimeVerificationError("packaged project schemas do not resolve inside the package host tree")
    names = (*schemas.DOMAIN_NAMES, schemas.PROJECT_SCHEMA_NAME)
    if sorted(names) != sorted(PROJECT_SCHEMA_NAMES):
        raise RuntimeVerificationError("packaged project schema list does not match the release contract")
    try:
        validation._validator()
    except Exception as exc:
        raise RuntimeVerificationError(f"packaged protocol schema could not be loaded: {type(exc).__name__}") from exc
    for name in names:
        try:
            schemas.validator_for(name)
        except Exception as exc:
            raise RuntimeVerificationError(f"packaged project schema could not be loaded: {name}") from exc
    return {"protocolSchema": PROTOCOL_SCHEMA, "projectSchemas": len(names)}
