"""Canonical versioned domain schemas and their strict validator."""
from __future__ import annotations

import copy
import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from jsonschema import Draft202012Validator, FormatChecker

SCHEMA_VERSION = 1
DOMAIN_NAMES = (
    "metadata", "worlds", "scenes", "levels", "objects", "environment",
    "models", "animations", "attachments", "sockets", "textures", "audio",
    "materials", "blueprints", "graphs", "hud", "prefabs",
)
PROJECT_SCHEMA_NAME = "project"
SCHEMA_DIR = Path(__file__).resolve().parents[2] / "project" / "v1"

# Nested authored records are deliberately checked here as well as in the
# top-level JSON Schemas. These are the stable keys currently emitted by the
# editor; free-form runtime/user settings stay in their own versioned blobs.
_NESTED_KEYS = {
    "spawnConfig": {"blueprintId", "interval", "maxSpawns", "team"},
    "audioConfig": {"audioId", "volume", "loop", "autoplay", "muted", "isSpatial", "refDistance", "maxDistance", "rolloffFactor", "loopStart", "loopEnd"},
    # ``heights`` is the legacy inline form; current documents reference a
    # binary heightfield asset instead (see ``_validate_terrain_heightfields``).
    # Paint weights likewise live in a binary splat map asset (``splatmap``);
    # the editor's in-memory ``splat`` array is never persisted.
    "terrainData": {"resolution", "width", "depth", "heights", "heightfield", "textureId", "textureLayers", "splatmap"},
    "heightfield": {"assetId", "encoding", "columns", "rows"},
    "splatmap": {"assetId", "encoding", "columns", "rows"},
    "textureLayers": {"textureId", "tiling"},
    "skyConfig": {"timeOfDay", "sunIntensity", "ambienceIntensity", "sunColor", "fogColor", "fogDensity", "turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG", "inclination", "azimuth"},
    "dimensions": {"width", "height"},
    "importSettings": {"normalize", "targetSize"},
    "size": {"width", "height"},
    "generation": {"providerId", "modelId", "modelVersion", "jobId", "createdAt", "routeOrigin", "routeConsent", "promptSha256", "settingsSha256", "artifactSha256", "inputAssetIds", "seed", "costMicroUsd"},
    "flashConfig": {"enabled", "textureId", "scale", "color", "duration", "rotationSpeed", "preview"},
    "position": {"x", "y"},
    "variables": {"id", "name", "type", "value"},
    "inputs": {"id", "key", "type", "targetVariableId", "targetValue", "name", "dataType", "direction"},
    "states": {"id", "name", "position", "loop", "isRoot", "stateType", "clipName", "blendSamples", "blendParamX", "blendParamY", "playRate", "playRateParam", "notifies", "rootMotion", "syncGroup", "subGraph", "curves"},
    "curves": {"id", "variableId", "keys"},
    "keys": {"time", "value"},
    "subGraph": {"states", "transitions"},
    "notifies": {"id", "name", "time"},
    "blendSamples": {"id", "clipName", "position"},
    "transitions": {"id", "fromStateId", "toStateId", "duration", "conditions", "exitTime", "conditionMode", "anyState", "priority"},
    "conditions": {"variableId", "operator", "value"},
    "nodes": {"id", "type", "name", "position", "inputs", "outputs", "data", "customData"},
    "outputs": {"id", "name", "dataType", "direction"},
    "connections": {"id", "fromNodeId", "fromPinId", "toNodeId", "toPinId"},
    "stats": {"id", "name", "value"},
    "elements": {"id", "type", "name", "props", "position", "size", "zIndex", "isVisible", "isLocked", "align"},
    "commands": {"id", "jobId", "providerId", "modelId", "promptSha256", "operationsSha256", "appliedAt"},
    "animationGraph": {"variables", "inputs", "states", "transitions", "activeStateId", "customData"},
    "layout": {"x", "y", "width", "height", "customData"},
    "lods": {"level", "maxDistance"},
    "render": {"visible", "radius", "selected", "lods"},
    "ik": {"footIK", "footMaxStep", "lookAt", "lookAtBone", "lookAtMaxAngle", "aimPitch"},
    "upperBody": {"fireClip", "aimClip", "maskBone"},
    "carry": {"boneName", "position", "rotation"},
    "weapons": {"id", "name", "attachmentId", "muzzleSocket", "startsOwned", "carry", "fireMode", "fireRate", "damage", "magazine", "reserve", "reloadSeconds", "spread", "pellets", "projectileSpeed", "fireClip", "aimClip", "reloadClip"},
    "behaviorTree": {"rootId", "behaviorNodes"},
    "behaviorNodes": {"id", "type", "children", "condition", "action", "value", "text"},
}
_FREEFORM_KEYS = {"settings", "overrides", "style", "payload", "data", "customData", "props"}
# ``materialOverrides`` is keyed by authored material names, so its entries are
# checked against the override fields instead of by their (arbitrary) key.
_MATERIAL_OVERRIDE_KEYS = {"color", "roughness", "metalness", "emissive", "emissiveIntensity", "opacity", "mapTextureId", "normalTextureId"}
_MATERIAL_TEXTURE_KEYS = ("mapTextureId", "normalTextureId")
# Material names are also the keys of ``materialOverrides`` and
# ``textureOverrides``, but every document crosses two protocol key blocklists:
# the host's ``_FORBIDDEN_JSON_KEY`` (Auvra/host/validation.py) and the
# editor's ``sanitizeJson`` (fbx-viewer (1)/utils/projectService.ts). A name
# either one rejects could never be saved or loaded, so it is refused here too
# (and a pack carrying one fails to import instead of opening unloadable).
_PROTOCOL_RESERVED_KEY = re.compile(
    r"^(?:path|filepath|filesystempath|sourcepath|assetpath|directorypath|absolutepath|localpath|base64|binary|bytes|blob"
    r"|credential|credentials|secret|token|api[_-]?key|password|authorization|auth[_-]?header"
    r"|file|animationfiles|object|url)$",
    re.I,
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")

_COMMON = {
    "type": "object", "required": ["schemaVersion", "documents"],
    "properties": {"schemaVersion": {"const": 1}, "documents": {
        "type": "array", "items": {"type": "object", "required": ["id"],
        "properties": {"id": {"type": "string", "minLength": 1}},
        "additionalProperties": True}
    }}, "additionalProperties": False,
}

def schema_for(domain: str) -> dict[str, Any]:
    if domain not in DOMAIN_NAMES and domain != PROJECT_SCHEMA_NAME:
        raise KeyError(domain)
    path = SCHEMA_DIR / f"{domain}.schema.json"
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)

@lru_cache(maxsize=None)
def validator_for(domain: str) -> Draft202012Validator:
    schema = schema_for(domain)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())

def validate_project_descriptor(value: Any) -> dict[str, Any]:
    errors = sorted(validator_for(PROJECT_SCHEMA_NAME).iter_errors(value), key=lambda e: list(e.path))
    if errors:
        raise ValueError(f"invalid project descriptor: {errors[0].message}")
    return value

def validate_domain(domain: str, value: Any) -> dict[str, Any]:
    if domain not in DOMAIN_NAMES:
        raise ValueError(f"unknown project domain: {domain}")
    # Object transforms are the one v1 compatibility boundary.  Normalize a
    # legacy document into the canonical authored representation before the
    # strict JSON Schema is applied.  Work on a copy so callers never observe
    # an in-place migration.
    candidate = copy.deepcopy(value)
    if domain == "objects":
        _normalize_object_transforms(candidate)
        _validate_terrain_heightfields(candidate)
        _validate_component_ids(candidate)
    elif domain == "prefabs":
        # A prefab carries object documents (without a level); hold them to
        # the same cross-field rules as the objects domain.
        for prefab in _documents(candidate):
            if isinstance(prefab, dict) and isinstance(prefab.get("objects"), list):
                members = {"documents": prefab["objects"]}
                _validate_terrain_heightfields(members)
                _validate_component_ids(members)
    elif domain == "sockets":
        _normalize_socket_transforms(candidate)
    _assert_finite(candidate)
    _assert_known_nested(candidate)
    _assert_asset_handles(candidate)
    errors = sorted(validator_for(domain).iter_errors(candidate), key=lambda e: list(e.path))
    if errors:
        raise ValueError(f"invalid {domain} project document: {errors[0].message}")
    return candidate

def validate_project_references(
    domains: dict[str, dict[str, Any]],
    *,
    asset_exists: Callable[[str], bool] | None = None,
) -> None:
    """Validate stable cross-domain identities against one candidate revision."""

    records: dict[str, dict[str, dict[str, Any]]] = {}
    for domain in DOMAIN_NAMES:
        document = domains.get(domain) or domain_document(domain, [])
        by_id: dict[str, dict[str, Any]] = {}
        for item in document["documents"]:
            identity = item["id"]
            if identity in by_id:
                raise ValueError(f"duplicate {domain} document id")
            by_id[identity] = item
        records[domain] = by_id

    def require(domain: str, identity: Any, label: str, *, optional: bool = False) -> None:
        if optional and (identity is None or identity == ""):
            return
        if not isinstance(identity, str) or identity not in records[domain]:
            raise ValueError(f"invalid {label} reference")

    for world in records["worlds"].values():
        for identity in world.get("levels", []): require("levels", identity, "world level")
    for scene in records["scenes"].values():
        require("levels", scene.get("levelId"), "scene level", optional=True)
        for identity in scene.get("objects", []):
            if isinstance(identity, str): require("objects", identity, "scene object")
    for value in records["objects"].values():
        require("levels", value.get("levelId"), "object level")
        require("models", value.get("modelId"), "object model", optional=True)
        require("blueprints", (value.get("spawnConfig") or {}).get("blueprintId"), "spawn blueprint", optional=True)
        require("audio", (value.get("audioConfig") or {}).get("audioId"), "object audio", optional=True)
        require("textures", (value.get("terrainData") or {}).get("textureId"), "terrain texture", optional=True)
        for layer in ((value.get("terrainData") or {}).get("textureLayers") or []):
            require("textures", layer.get("textureId") if isinstance(layer, dict) else None, "terrain layer texture", optional=True)
        require("prefabs", value.get("prefabId"), "object prefab", optional=True)
    # Transform parents live in the same level, so a hierarchy never spans
    # levels and a level can be loaded (or deleted) as one tree.
    for value in records["objects"].values():
        parent = value.get("parentId")
        if parent is None or parent == "":
            continue
        parent_value = records["objects"].get(parent)
        if parent_value is None or parent_value.get("levelId") != value.get("levelId"):
            raise ValueError("invalid object parent reference")
    _assert_acyclic(records["objects"], "object hierarchy")
    # A prefab is one tree: its root has no parent and every other member's
    # parent is another member. Member ``prefabId`` values are informational
    # (instantiation stamps the instantiated prefab) and are not resolved.
    for prefab in records["prefabs"].values():
        members: dict[str, dict[str, Any]] = {}
        for value in prefab["objects"]:
            if value["id"] in members:
                raise ValueError("duplicate prefab object id")
            members[value["id"]] = value
        if prefab["rootId"] not in members:
            raise ValueError("invalid prefab root reference")
        for identity, value in members.items():
            parent = value.get("parentId")
            if identity == prefab["rootId"]:
                if parent is not None and parent != "":
                    raise ValueError("prefab root must not have a parent")
            elif parent not in members:
                raise ValueError("invalid prefab object parent reference")
        _assert_acyclic(members, "prefab hierarchy")
    for value in records["animations"].values():
        require("models", value.get("modelId"), "animation model", optional=True)
    for value in records["models"].values():
        for identity in (value.get("textureOverrides") or {}).values():
            require("textures", identity, "model texture")
        for override in (value.get("materialOverrides") or {}).values():
            for key in _MATERIAL_TEXTURE_KEYS:
                require("textures", override.get(key), "model material texture", optional=True)
    for domain in ("attachments", "sockets"):
        for value in records[domain].values():
            require("models", value.get("parentModelId"), f"{domain} parent model")
    for value in records["sockets"].values():
        require("textures", (value.get("flashConfig") or {}).get("textureId"), "socket texture", optional=True)
    for value in records["materials"].values():
        for identity in value.get("textureIds", []): require("textures", identity, "material texture")
    for value in records["textures"].values():
        generation = value.get("generation")
        if generation is not None:
            if generation.get("artifactSha256") != value.get("assetId"):
                raise ValueError("generated texture provenance does not match its asset")
            for identity in generation.get("inputAssetIds", []):
                if asset_exists is not None and not asset_exists(identity):
                    raise ValueError("generated texture provenance references a missing input asset")
    for value in records["blueprints"].values():
        require("models", value.get("linkedModelId"), "blueprint model", optional=True)
        require("textures", value.get("textureId"), "blueprint texture", optional=True)
        for identity in value.get("weaponSounds", []): require("audio", identity, "blueprint audio")

    if asset_exists is not None:
        for document in domains.values():
            for asset_id in _asset_handles(document):
                if not asset_exists(asset_id):
                    raise ValueError("project references a missing asset")

def domain_document(domain: str, documents: list[dict[str, Any]]) -> dict[str, Any]:
    value = {"schemaVersion": SCHEMA_VERSION, "documents": documents}
    return validate_domain(domain, value)

def _assert_finite(value: Any) -> None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            finite = math.isfinite(value)
        except (OverflowError, ValueError):
            finite = False
        if not finite:
            raise ValueError("non-finite numbers are not valid project data")
    if isinstance(value, dict):
        for child in value.values(): _assert_finite(child)
    elif isinstance(value, (list, tuple)):
        for child in value: _assert_finite(child)


_DEFAULT_POSITION = [0.0, 0.0, 0.0]
_DEFAULT_ROTATION = [0.0, 0.0, 0.0]
_DEFAULT_SCALE = [1.0, 1.0, 1.0]
_MAX_ABS_POSITION = 1_000_000.0
_MIN_SCALE = 0.0001
_MAX_SCALE = 1_000_000.0
_QUATERNION_EPSILON = 1e-12


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _finite_number(value: Any, label: str) -> float:
    if not _is_number(value):
        raise ValueError(f"{label} must contain only numbers")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{label} must contain only finite numbers") from None
    if not math.isfinite(result):
        raise ValueError(f"{label} must contain only finite numbers")
    return result


def _normalize_object_transforms(value: Any) -> None:
    if not isinstance(value, dict) or not isinstance(value.get("documents"), list):
        return
    for index, object_value in enumerate(value["documents"]):
        if not isinstance(object_value, dict):
            continue
        location = object_value.setdefault("position", list(_DEFAULT_POSITION))
        rotation = object_value.setdefault("rotation", list(_DEFAULT_ROTATION))
        scale = object_value.setdefault("scale", list(_DEFAULT_SCALE))
        object_value["position"] = _canonical_vector(location, "position", index, minimum=-_MAX_ABS_POSITION, maximum=_MAX_ABS_POSITION)
        object_value["rotation"] = _canonical_rotation(rotation, index)
        object_value["scale"] = _canonical_vector(scale, "scale", index, minimum=_MIN_SCALE, maximum=_MAX_SCALE)

def _validate_terrain_heightfields(value: Any) -> None:
    """Heightfield and splat map references must describe their terrain's grid.

    The reference shapes are enforced by the objects JSON Schema; this checks
    the cross-field rule a schema cannot express. Legacy documents with inline
    ``heights`` are still accepted and are migrated by the editor on the next
    terrain commit.
    """
    if not isinstance(value, dict) or not isinstance(value.get("documents"), list):
        return
    for index, object_value in enumerate(value["documents"]):
        terrain = object_value.get("terrainData") if isinstance(object_value, dict) else None
        if not isinstance(terrain, dict):
            continue
        for key, label in (("heightfield", "heightfield"), ("splatmap", "splat map")):
            reference = terrain.get(key)
            if not isinstance(reference, dict):
                continue
            resolution = terrain.get("resolution")
            if not _is_number(resolution) or not float(resolution).is_integer():
                raise ValueError(f"objects document {index} terrain {label} requires an integer resolution")
            samples = int(resolution) + 1
            if reference.get("columns") != samples or reference.get("rows") != samples:
                raise ValueError(f"objects document {index} terrain {label} does not match its resolution")

def _documents(value: Any) -> list[Any]:
    documents = value.get("documents") if isinstance(value, dict) else None
    return documents if isinstance(documents, list) else []

def _validate_component_ids(value: Any) -> None:
    """Component ids identify one behaviour on its object, so they are unique per object."""
    for index, object_value in enumerate(_documents(value)):
        components = object_value.get("components") if isinstance(object_value, dict) else None
        if not isinstance(components, list):
            continue
        seen: set[str] = set()
        for component in components:
            identity = component.get("id") if isinstance(component, dict) else None
            if isinstance(identity, str):
                if identity in seen:
                    raise ValueError(f"objects document {index} has duplicate component ids")
                seen.add(identity)

def _assert_acyclic(nodes: dict[str, dict[str, Any]], label: str) -> None:
    """Reject ``parentId`` chains that loop; dangling parents are checked by the caller."""
    settled: set[str] = set()
    for start in nodes:
        path: list[str] = []
        on_path: set[str] = set()
        current = start
        while current not in settled:
            if current in on_path:
                raise ValueError(f"{label} contains a cycle")
            on_path.add(current)
            path.append(current)
            parent = nodes[current].get("parentId")
            if not isinstance(parent, str) or parent not in nodes:
                break
            current = parent
        settled.update(path)

def _normalize_socket_transforms(value: Any) -> None:
    if not isinstance(value, dict) or not isinstance(value.get("documents"), list):
        return
    for index, socket_value in enumerate(value["documents"]):
        if not isinstance(socket_value, dict):
            continue
        if "position" in socket_value:
            socket_value["position"] = _canonical_vector(
                socket_value["position"], "position", index,
                minimum=-_MAX_ABS_POSITION, maximum=_MAX_ABS_POSITION,
                domain="sockets",
            )
        if "rotation" in socket_value:
            socket_value["rotation"] = _canonical_rotation(
                socket_value["rotation"], index, domain="sockets",
            )
        if "scale" in socket_value:
            socket_value["scale"] = _canonical_vector(
                socket_value["scale"], "scale", index,
                minimum=_MIN_SCALE, maximum=_MAX_SCALE,
                domain="sockets",
            )


def _canonical_vector(
    value: Any,
    label: str,
    index: int,
    *,
    minimum: float,
    maximum: float,
    domain: str = "objects",
) -> list[float | int]:
    if not isinstance(value, list):
        raise ValueError(f"{domain} document {index} {label} must be an array")
    if len(value) != 3:
        raise ValueError(f"{domain} document {index} {label} must contain exactly three values")
    result: list[float | int] = []
    for component in value:
        number = _finite_number(component, f"{domain} document {index} {label}")
        if number < minimum or number > maximum:
            raise ValueError(f"{domain} document {index} {label} exceeds native bounds")
        result.append(component)
    return result


def _canonical_rotation(value: Any, index: int, *, domain: str = "objects") -> list[float | int]:
    if not isinstance(value, list):
        raise ValueError(f"{domain} document {index} rotation must be an array")
    if len(value) == 3:
        return [_finite_number(component, f"{domain} document {index} rotation") for component in value]
    if len(value) != 4:
        raise ValueError(f"{domain} document {index} rotation must contain three Euler values or four quaternion values")

    quaternion = [_finite_number(component, f"{domain} document {index} rotation") for component in value]
    norm = math.hypot(*quaternion)
    if norm < _QUATERNION_EPSILON:
        raise ValueError(f"{domain} document {index} rotation quaternion has zero length")
    x, y, z, w = (component / norm for component in quaternion)

    # This is the Three.js Euler order XYZ conversion (radians), including
    # its deterministic gimbal-lock branch.  The host's private native
    # boundary converts this canonical Euler form back to a quaternion.
    m11 = 1.0 - 2.0 * (y * y + z * z)
    m12 = 2.0 * (x * y - z * w)
    m13 = 2.0 * (x * z + y * w)
    m22 = 1.0 - 2.0 * (x * x + z * z)
    m23 = 2.0 * (y * z - x * w)
    m32 = 2.0 * (y * z + x * w)
    m33 = 1.0 - 2.0 * (x * x + y * y)
    clamped_m13 = max(-1.0, min(1.0, m13))
    euler_y = math.asin(clamped_m13)
    if abs(clamped_m13) < 0.9999999:
        euler_x = math.atan2(-m23, m33)
        euler_z = math.atan2(-m12, m11)
    else:
        euler_x = math.atan2(m32, m22)
        euler_z = 0.0
    return [euler_x, euler_y, euler_z]

def _assert_known_nested(value: Any, parent_key: str | None = None, freeform: bool = False) -> None:
    """Check nested authored records against the stable editor keys.

    Below a free-form key (component props, node data, settings) the
    contents belong to whatever owns them, so ``_NESTED_KEYS`` is not
    applied there: a component's own field named ``position`` or ``size``
    is not the HUD layout record of that name.
    """
    if isinstance(value, dict):
        if parent_key in ("materialOverrides", "textureOverrides"):
            for name in value:
                if isinstance(name, str) and _PROTOCOL_RESERVED_KEY.search(name):
                    raise ValueError(f"{parent_key} cannot use the material name {name!r}: the project protocol reserves it")
        if parent_key == "materialOverrides":
            for name, override in value.items():
                if not isinstance(override, dict): continue
                unknown = set(override) - _MATERIAL_OVERRIDE_KEYS
                if unknown: raise ValueError(f"unknown fields in materialOverrides[{name!r}]: {sorted(unknown)!r}")
            return
        if parent_key in _FREEFORM_KEYS:
            if len(value) > 128: raise ValueError(f"{parent_key} exceeds property limit")
            for key, child in value.items():
                if not isinstance(key, str) or len(key) > 128: raise ValueError(f"invalid {parent_key} key")
                _assert_known_nested(child, key, True)
            return
        allowed = None if freeform else _NESTED_KEYS.get(parent_key)
        if allowed is not None:
            unknown = set(value) - allowed
            if unknown: raise ValueError(f"unknown fields in {parent_key}: {sorted(unknown)!r}")
        for key, child in value.items(): _assert_known_nested(child, key, freeform)
    elif isinstance(value, list):
        for child in value: _assert_known_nested(child, parent_key, freeform)

def _asset_handles(value: Any, parent_key: str | None = None):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "assetId" and isinstance(child, str):
                yield child
            elif key in {"assetIds", "animationAssetIds", "inputAssetIds"} and isinstance(child, list):
                yield from (item for item in child if isinstance(item, str))
            yield from _asset_handles(child, key)
    elif isinstance(value, list):
        for child in value:
            yield from _asset_handles(child, parent_key)

def _assert_asset_handles(value: Any) -> None:
    for asset_id in _asset_handles(value):
        if not _SHA256.fullmatch(asset_id):
            raise ValueError("asset ids must be lowercase SHA-256 digests")
