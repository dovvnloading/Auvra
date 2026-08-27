"""Canonical versioned domain schemas and their strict validator."""
from __future__ import annotations

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
    "materials", "blueprints", "graphs", "hud",
)
PROJECT_SCHEMA_NAME = "project"
SCHEMA_DIR = Path(__file__).resolve().parents[2] / "project" / "v1"

# Nested authored records are deliberately checked here as well as in the
# top-level JSON Schemas. These are the stable keys currently emitted by the
# editor; free-form runtime/user settings stay in their own versioned blobs.
_NESTED_KEYS = {
    "spawnConfig": {"blueprintId", "interval", "maxSpawns", "team"},
    "audioConfig": {"audioId", "volume", "loop", "autoplay", "muted", "isSpatial", "refDistance", "maxDistance", "rolloffFactor", "loopStart", "loopEnd"},
    "terrainData": {"resolution", "width", "depth", "heights", "textureId"},
    "skyConfig": {"timeOfDay", "sunIntensity", "ambienceIntensity", "sunColor", "fogColor", "fogDensity", "turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG", "inclination", "azimuth"},
    "dimensions": {"width", "height"},
    "size": {"width", "height"},
    "generation": {"providerId", "modelId", "modelVersion", "jobId", "createdAt", "routeOrigin", "routeConsent", "promptSha256", "settingsSha256", "artifactSha256", "inputAssetIds", "seed", "costMicroUsd"},
    "flashConfig": {"enabled", "textureId", "scale", "color", "duration", "rotationSpeed", "preview"},
    "position": {"x", "y"},
    "variables": {"id", "name", "type", "value"},
    "inputs": {"id", "key", "type", "targetVariableId", "targetValue", "name", "dataType", "direction"},
    "states": {"id", "name", "position", "loop", "isRoot", "stateType", "clipName", "blendSamples", "blendParamX", "blendParamY"},
    "blendSamples": {"id", "clipName", "position"},
    "transitions": {"id", "fromStateId", "toStateId", "duration", "conditions"},
    "conditions": {"variableId", "operator", "value"},
    "nodes": {"id", "type", "name", "position", "inputs", "outputs", "data", "customData"},
    "outputs": {"id", "name", "dataType", "direction"},
    "connections": {"id", "fromNodeId", "fromPinId", "toNodeId", "toPinId"},
    "stats": {"id", "name", "value"},
    "elements": {"id", "type", "name", "props", "position", "size", "zIndex", "isVisible", "isLocked", "align"},
    "commands": {"id", "jobId", "providerId", "modelId", "promptSha256", "operationsSha256", "appliedAt"},
    "animationGraph": {"variables", "inputs", "states", "transitions", "activeStateId", "customData"},
    "layout": {"x", "y", "width", "height", "customData"},
}
_FREEFORM_KEYS = {"settings", "overrides", "style", "payload", "data", "customData", "props"}
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
    _assert_finite(value)
    _assert_known_nested(value)
    _assert_asset_handles(value)
    errors = sorted(validator_for(domain).iter_errors(value), key=lambda e: list(e.path))
    if errors:
        raise ValueError(f"invalid {domain} project document: {errors[0].message}")
    return value

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
    for value in records["animations"].values():
        require("models", value.get("modelId"), "animation model", optional=True)
    for value in records["models"].values():
        for identity in (value.get("textureOverrides") or {}).values():
            require("textures", identity, "model texture")
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
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("non-finite numbers are not valid project data")
    if isinstance(value, dict):
        for child in value.values(): _assert_finite(child)
    elif isinstance(value, (list, tuple)):
        for child in value: _assert_finite(child)

def _assert_known_nested(value: Any, parent_key: str | None = None) -> None:
    if isinstance(value, dict):
        if parent_key in _FREEFORM_KEYS:
            if len(value) > 128: raise ValueError(f"{parent_key} exceeds property limit")
            for key, child in value.items():
                if not isinstance(key, str) or len(key) > 128: raise ValueError(f"invalid {parent_key} key")
                _assert_known_nested(child, key)
            return
        allowed = _NESTED_KEYS.get(parent_key)
        if allowed is not None:
            unknown = set(value) - allowed
            if unknown: raise ValueError(f"unknown fields in {parent_key}: {sorted(unknown)!r}")
        for key, child in value.items(): _assert_known_nested(child, key)
    elif isinstance(value, list):
        for child in value: _assert_known_nested(child, parent_key)

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
