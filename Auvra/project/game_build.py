"""Build a standalone game folder from one project revision.

``build_game`` is a pure filesystem operation: the caller supplies the domain
documents and an asset reader, and nothing here touches the host, the UI, or
the project repository.  The output layout is the game pack described by
``fbx-viewer (1)/runtime/types.ts`` (``GamePackManifest``) next to a verified
copy of the prebuilt player template, plus an ``auvra-build.json`` marker that
identifies the folder as something a later build may safely replace.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Mapping, Sequence

from .schemas import DOMAIN_NAMES, SCHEMA_VERSION
from .serialization import canonical_json

TEMPLATE_MANIFEST = "player-template.json"
# The player template ships the web player's npm notices under this name; the
# release package stages the Windows player's Rust crate notices beside
# auvra-player.exe under the same name (release/notices.py).
NOTICES_FILE = "THIRD_PARTY_NOTICES.txt"
BUILD_MARKER = "auvra-build.json"
BUILD_KIND = "auvra-game-build"
BUILD_SCHEMA = 1
GAME_PACK_FORMAT = "auvra.game"
GAME_PACK_SCHEMA = 1
GAME_SETTINGS_DOCUMENT_ID = "game-settings"
EDITOR_STATE_DOCUMENT_ID = "editor-state"
BUILD_TARGETS = ("web", "windows")
ERROR_CODES = frozenset({"invalid_request", "invalid_project", "locking", "unsupported_capability"})

# Mirrors DEFAULT_GAME_SETTINGS in fbx-viewer (1)/runtime/types.ts.
DEFAULT_GAME_SETTINGS: dict[str, Any] = {
    "schema": 1,
    "name": "Untitled Game",
    "startupLevelId": None,
    "playerBlueprintId": None,
    "window": {"fullscreen": False},
    "quality": {"shadows": True, "postProcessing": True, "maxDpr": 2, "fov": 60},
    "input": {"mouseSensitivity": 0.002, "invertY": False},
    "audio": {"masterVolume": 1},
}
_NESTED_SETTINGS = ("window", "quality", "input", "audio")

_MIME_EXTENSIONS = {
    "model/fbx": "fbx",
    "model/gltf-binary": "glb",
    "image/png": "png",
    "image/jpeg": "jpg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "application/vnd.auvra.heightfield": "ahf",
    "application/vnd.auvra.splatmap": "asp",
}
_GENERIC_MIME = "application/octet-stream"
_SAFE_ASSET_ID = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
_HEX = frozenset("0123456789abcdef")
_RESERVED_ROOTS = ("game", BUILD_MARKER)
_CHUNK = 1024 * 1024


class GameBuildError(Exception):
    """A build failure with a stable ``code`` the host can map to UI copy."""

    def __init__(self, code: str, message: str) -> None:
        if code not in ERROR_CODES:
            raise ValueError(f"unknown game build error code: {code}")
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class BuildReport:
    """Summary of a published build. ``files`` and ``bytes`` include the marker."""

    build_id: str
    target: str
    files: int
    bytes: int
    assets: int
    levels: int
    warnings: tuple[str, ...]


def build_game(
    *,
    domains: Mapping[str, Sequence[Mapping[str, Any]]],
    read_asset: Callable[[str], tuple[bytes, str]],
    template_root: Path,
    destination: Path,
    target: Literal["web", "windows"],
    build_id: str,
    game_id: str,
    player_executable: Path | None = None,
) -> BuildReport:
    """Write a playable build into ``destination`` and publish it atomically.

    ``domains`` maps project domain names to their documents (a plain list or a
    ``{schemaVersion, documents}`` wrapper).  ``read_asset`` returns the bytes
    and MIME type of one referenced asset id.  ``destination`` is only ever
    replaced when it is absent or already holds a marked Auvra build.
    A ``windows`` build also needs ``player_executable`` (auvra-player.exe), which
    is copied in as ``<Game Name>.exe`` next to the web files it serves.  The
    player's Rust crate notices (``THIRD_PARTY_NOTICES.txt`` beside the exe)
    are appended to the build's ``THIRD_PARTY_NOTICES.txt``.
    """

    if target not in BUILD_TARGETS:
        raise GameBuildError("invalid_request", f"unsupported build target: {target!r}")
    for label, value in (("build id", build_id), ("game id", game_id)):
        if not isinstance(value, str) or not value.strip():
            raise GameBuildError("invalid_request", f"a {label} is required")
    if not callable(read_asset):
        raise GameBuildError("invalid_request", "an asset reader is required")
    template_root = Path(template_root)
    destination = Path(destination)
    if destination.name in ("", ".", ".."):
        raise GameBuildError("invalid_request", "the build destination must name a folder")

    _require_replaceable(destination)
    executable: bytes | None = None
    player_notices: bytes | None = None
    if target == "windows":
        if player_executable is None or not Path(player_executable).is_file():
            raise GameBuildError(
                "unsupported_capability",
                "the Windows game player is not built; run cargo build --release in player-desktop",
            )
        try:
            executable = Path(player_executable).read_bytes()
        except OSError as error:
            raise _filesystem_error(error, "could not read the Windows game player") from error
        player_notices = _read_player_notices(Path(player_executable))
    template = _read_template(template_root)
    content = _prepare_domains(domains)
    settings, levels = _resolve_settings(content)
    warnings: list[str] = []
    if executable is not None and player_notices is None:
        warnings.append(
            "the Windows game player's third-party notices were not found beside auvra-player.exe; "
            f"the build's {NOTICES_FILE} covers only the web player"
        )
    blueprint_id = settings.get("playerBlueprintId")
    if blueprint_id and blueprint_id not in {item["id"] for item in content["blueprints"]}:
        warnings.append(f"player blueprint {blueprint_id} does not exist; the default player is used")
    asset_ids = sorted(_referenced_asset_ids(content))
    for asset_id in asset_ids:
        if not asset_id or len(asset_id) > 128 or not set(asset_id) <= _SAFE_ASSET_ID:
            raise GameBuildError("invalid_project", f"invalid asset id: {asset_id!r}")

    parent = destination.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}.staging-", dir=parent))
    except OSError as error:
        raise _filesystem_error(error, "could not prepare the build folder") from error

    try:
        records: list[dict[str, Any]] = []
        for entry in template:
            _copy_verified(template_root, staging, entry)
            records.append(dict(entry))
        for domain in DOMAIN_NAMES:
            document = {"schemaVersion": SCHEMA_VERSION, "documents": content[domain]}
            _write(staging, f"game/content/{domain}.json", canonical_json(document).encode("utf-8"), records)
        shipped: list[dict[str, Any]] = []
        for asset_id in asset_ids:
            data, mime = _load_asset(read_asset, asset_id)
            extension = _MIME_EXTENSIONS.get(mime, "bin")
            if extension == "bin" and mime != _GENERIC_MIME:
                warnings.append(f"asset {asset_id} has unrecognised type {mime or 'unknown'}; shipped as .bin")
            file_name = f"{asset_id}.{extension}"
            _write(staging, f"game/assets/{file_name}", data, records)
            shipped.append({"id": asset_id, "file": file_name, "mime": mime or _GENERIC_MIME, "size": len(data)})
        manifest = {
            "format": GAME_PACK_FORMAT,
            "schema": GAME_PACK_SCHEMA,
            "gameId": game_id,
            "name": settings["name"],
            "buildId": build_id,
            "startupLevelId": settings["startupLevelId"],
            "settings": settings,
            "levels": levels,
            "domains": list(DOMAIN_NAMES),
            "assets": shipped,
        }
        _write(staging, "game/game.json", canonical_json(manifest).encode("utf-8"), records)
        if executable is not None:
            _write(staging, f"{_executable_name(settings['name'])}.exe", executable, records)
        if player_notices is not None:
            _append_notices(staging, player_notices, records)
        records.sort(key=lambda item: item["path"])
        marker = {
            "schema": BUILD_SCHEMA,
            "kind": BUILD_KIND,
            "buildId": build_id,
            "target": target,
            "files": records,
        }
        marker_bytes = canonical_json(marker).encode("utf-8")
        (staging / BUILD_MARKER).write_bytes(marker_bytes)
    except BaseException as error:
        shutil.rmtree(staging, ignore_errors=True)
        if isinstance(error, OSError):
            raise _filesystem_error(error, "could not write the build") from error
        raise

    warnings.extend(_publish(staging, destination))
    return BuildReport(
        build_id=build_id,
        target=target,
        files=len(records) + 1,
        bytes=sum(item["size"] for item in records) + len(marker_bytes),
        assets=len(shipped),
        levels=len(levels),
        warnings=tuple(warnings),
    )


def _executable_name(game_name: Any) -> str:
    """A Windows-safe file stem for the game's exe."""

    text = str(game_name or "").strip()
    safe = "".join(character if character.isalnum() or character in " -_" else "_" for character in text)
    safe = safe.strip(" ._")[:64]
    return safe or "Game"


def is_marked_build(path: Path) -> bool:
    """True when ``path`` is a real folder holding a valid Auvra build marker."""

    path = Path(path)
    try:
        if path.is_symlink() or not path.is_dir():
            return False
        marker = json.loads((path / BUILD_MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (
        isinstance(marker, dict)
        and marker.get("schema") == BUILD_SCHEMA
        and marker.get("kind") == BUILD_KIND
        and isinstance(marker.get("files"), list)
    )


def normalize_game_settings(value: Any) -> dict[str, Any]:
    """Merge stored (possibly partial or older) settings over the defaults."""

    stored = dict(value) if isinstance(value, Mapping) else {}
    result = {**copy.deepcopy(DEFAULT_GAME_SETTINGS), **stored, "schema": 1}
    for key in _NESTED_SETTINGS:
        nested = stored.get(key)
        result[key] = {**DEFAULT_GAME_SETTINGS[key], **(dict(nested) if isinstance(nested, Mapping) else {})}
    return result


def _require_replaceable(destination: Path) -> None:
    if not destination.exists() and not destination.is_symlink():
        return
    if not is_marked_build(destination):
        raise GameBuildError("invalid_request", "destination exists and is not an Auvra build")


def _read_template(root: Path) -> list[dict[str, Any]]:
    try:
        raw = json.loads((root / TEMPLATE_MANIFEST).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise GameBuildError("unsupported_capability", "the player template is not installed") from None
    except (OSError, ValueError):
        raise GameBuildError("unsupported_capability", "the player template manifest is unreadable") from None
    files = raw.get("files") if isinstance(raw, dict) else None
    if not isinstance(files, list) or not files:
        raise GameBuildError("unsupported_capability", "the player template manifest lists no files")
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in files:
        if not isinstance(item, dict):
            raise GameBuildError("unsupported_capability", "the player template manifest is malformed")
        path, size, sha256 = item.get("path"), item.get("size"), item.get("sha256")
        if not _is_safe_relative(path):
            raise GameBuildError("unsupported_capability", f"the player template lists an unsafe path: {path!r}")
        if path.split("/", 1)[0].lower() in _RESERVED_ROOTS:
            raise GameBuildError("unsupported_capability", f"the player template overlaps the game pack: {path}")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise GameBuildError("unsupported_capability", f"the player template size for {path} is invalid")
        if not isinstance(sha256, str) or len(sha256) != 64 or not set(sha256) <= _HEX:
            raise GameBuildError("unsupported_capability", f"the player template hash for {path} is invalid")
        if path.lower() in seen:
            raise GameBuildError("unsupported_capability", f"the player template lists {path} twice")
        seen.add(path.lower())
        entries.append({"path": path, "size": size, "sha256": sha256})
    return entries


def _is_safe_relative(path: Any) -> bool:
    if not isinstance(path, str) or not path or "\\" in path or ":" in path or "\0" in path:
        return False
    return all(segment not in ("", ".", "..") for segment in path.split("/"))


def _copy_verified(template_root: Path, staging: Path, entry: Mapping[str, Any]) -> None:
    relative = entry["path"]
    source = template_root.joinpath(*relative.split("/"))
    try:
        reader = source.open("rb")
    except OSError:
        raise GameBuildError("unsupported_capability", f"the player template is missing {relative}") from None
    digest = hashlib.sha256()
    written = 0
    with reader:
        target = staging.joinpath(*relative.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as writer:
            for chunk in iter(lambda: reader.read(_CHUNK), b""):
                digest.update(chunk)
                written += len(chunk)
                writer.write(chunk)
    if written != entry["size"] or digest.hexdigest() != entry["sha256"]:
        raise GameBuildError("unsupported_capability", f"the player template file {relative} is stale or corrupt")


def _write(staging: Path, relative: str, data: bytes, records: list[dict[str, Any]]) -> None:
    target = staging.joinpath(*relative.split("/"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    records.append({"path": relative, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})


def _read_player_notices(player_executable: Path) -> bytes | None:
    """The player's crate notices staged beside it, or None when absent (dev builds)."""

    path = player_executable.with_name(NOTICES_FILE)
    if not path.is_file():
        return None
    try:
        data = path.read_bytes()
    except OSError as error:
        raise _filesystem_error(error, "could not read the Windows game player's notices") from error
    return data if data.strip() else None


def _append_notices(staging: Path, notices: bytes, records: list[dict[str, Any]]) -> None:
    """Append ``notices`` to the template's notices file (or create it) and re-record it."""

    existing = next((item for item in records if item["path"] == NOTICES_FILE), None)
    combined = notices.strip() + b"\n"
    if existing is not None:
        records.remove(existing)
        combined = staging.joinpath(NOTICES_FILE).read_bytes().rstrip() + b"\n\n" + combined
    _write(staging, NOTICES_FILE, combined, records)


def _load_asset(read_asset: Callable[[str], tuple[bytes, str]], asset_id: str) -> tuple[bytes, str]:
    try:
        result = read_asset(asset_id)
    except GameBuildError:
        raise
    except PermissionError as error:
        raise GameBuildError("locking", f"asset {asset_id} is locked: {error}") from error
    except (LookupError, OSError, ValueError) as error:
        raise GameBuildError("invalid_project", f"asset {asset_id} could not be read") from error
    if not isinstance(result, (tuple, list)) or len(result) != 2:
        raise GameBuildError("invalid_project", f"asset {asset_id} could not be read")
    data, mime = result
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise GameBuildError("invalid_project", f"asset {asset_id} could not be read")
    essence = mime.split(";", 1)[0].strip().lower() if isinstance(mime, str) else ""
    return bytes(data), essence


def _prepare_domains(domains: Any) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(domains, Mapping):
        raise GameBuildError("invalid_request", "project domains are required")
    unknown = sorted(str(name) for name in domains if name not in DOMAIN_NAMES)
    if unknown:
        raise GameBuildError("invalid_request", f"unknown project domains: {unknown}")
    prepared: dict[str, list[dict[str, Any]]] = {}
    for domain in DOMAIN_NAMES:
        documents = domains.get(domain) or ()
        if isinstance(documents, Mapping):
            documents = documents.get("documents") or ()
        if isinstance(documents, (str, bytes)) or not isinstance(documents, Sequence):
            raise GameBuildError("invalid_project", f"{domain} documents must be a list")
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for document in documents:
            identity = document.get("id") if isinstance(document, Mapping) else None
            if not isinstance(identity, str) or not identity:
                raise GameBuildError("invalid_project", f"{domain} documents need a string id")
            if identity in seen:
                raise GameBuildError("invalid_project", f"duplicate {domain} document id {identity}")
            seen.add(identity)
            if domain == "metadata" and identity == EDITOR_STATE_DOCUMENT_ID:
                continue
            item = _plain(document, f"{domain} document {identity}")
            if domain == "textures":
                item.pop("generation", None)
            items.append(item)
        prepared[domain] = items
    return prepared


def _plain(value: Any, label: str) -> Any:
    """Deep-copy into JSON-native containers, rejecting non-JSON values."""

    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise GameBuildError("invalid_project", f"{label} contains a non-finite number")
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, child in value.items():
            if not isinstance(key, str):
                raise GameBuildError("invalid_project", f"{label} has a non-string key")
            result[key] = _plain(child, label)
        return result
    if isinstance(value, (list, tuple)):
        return [_plain(child, label) for child in value]
    raise GameBuildError("invalid_project", f"{label} contains a value that is not JSON")


def _resolve_settings(content: Mapping[str, list[dict[str, Any]]]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    stored = next(
        (item.get("settings") for item in content["metadata"] if item["id"] == GAME_SETTINGS_DOCUMENT_ID),
        None,
    )
    settings = normalize_game_settings(stored)
    if not isinstance(settings.get("name"), str) or not settings["name"].strip():
        settings["name"] = DEFAULT_GAME_SETTINGS["name"]
    levels = [
        {"id": item["id"], "name": item["name"] if isinstance(item.get("name"), str) else item["id"]}
        for item in content["levels"]
    ]
    if not levels:
        raise GameBuildError("invalid_project", "the project has no levels to play")
    startup = settings.get("startupLevelId")
    if startup in (None, ""):
        startup = levels[0]["id"]
    if not isinstance(startup, str) or startup not in {level["id"] for level in levels}:
        raise GameBuildError("invalid_project", f"the startup level {startup!r} does not exist")
    settings["startupLevelId"] = startup
    blueprint = settings.get("playerBlueprintId")
    if blueprint == "" or (blueprint is not None and not isinstance(blueprint, str)):
        settings["playerBlueprintId"] = None
    return settings, levels


def _referenced_asset_ids(content: Mapping[str, list[dict[str, Any]]]) -> set[str]:
    """Collect ids under ``assetId``/``*AssetId`` keys and ``assetIds``/``*AssetIds`` lists."""

    references: set[str] = set()

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if (key == "assetId" or key.endswith("AssetId")) and isinstance(child, str) and child:
                    references.add(child)
                elif (key == "assetIds" or key.endswith("AssetIds")) and isinstance(child, list):
                    references.update(item for item in child if isinstance(item, str) and item)
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    for documents in content.values():
        collect(documents)
    return references


def _publish(staging: Path, destination: Path) -> list[str]:
    """Swap ``staging`` in as ``destination``; returns non-fatal warnings."""

    warnings: list[str] = []
    try:
        _require_replaceable(destination)
    except GameBuildError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    aside: Path | None = None
    if destination.exists() or destination.is_symlink():
        aside = destination.with_name(f".{destination.name}.previous-{uuid.uuid4().hex}")
        try:
            os.replace(destination, aside)
        except OSError as error:
            shutil.rmtree(staging, ignore_errors=True)
            raise _filesystem_error(error, "the previous build is in use and could not be replaced") from error
    try:
        os.replace(staging, destination)
    except OSError as error:
        message = "could not publish the build"
        if aside is not None:
            try:
                os.replace(aside, destination)
            except OSError:
                message += f"; the previous build was kept at {aside}"
        shutil.rmtree(staging, ignore_errors=True)
        raise _filesystem_error(error, message) from error
    if aside is not None:
        if not is_marked_build(aside):
            warnings.append(f"the previous build at {aside} changed during the build and was kept")
        else:
            try:
                shutil.rmtree(aside)
            except OSError:
                warnings.append(f"the previous build at {aside} could not be removed")
    return warnings


def _filesystem_error(error: OSError, message: str) -> GameBuildError:
    if isinstance(error, PermissionError):
        return GameBuildError("locking", f"{message}: {error}")
    return GameBuildError("invalid_request", f"{message}: {error}")
