"""Strict, reviewable HUD element command proposals."""
from __future__ import annotations
import hashlib, json, math
from dataclasses import dataclass
from typing import Any, Mapping

class CommandValidationError(ValueError): pass

HUD_TYPES = frozenset({"Container", "Text", "HealthBar", "Crosshair", "Scope"})
ALIGN = frozenset({"top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right"})
COMMON_FIELDS = frozenset({"name", "type", "props", "position", "size", "zIndex", "isVisible", "isLocked", "align"})
PROP_FIELDS = {
    "Container": frozenset({"backgroundColor", "borderColor", "borderWidth", "borderRadius"}),
    "Text": frozenset({"text", "color", "fontSize", "fontWeight", "fontFamily"}),
    "HealthBar": frozenset({"value", "max", "barColor", "backgroundColor", "showIcon", "showText"}),
    "Crosshair": frozenset({"color", "size", "thickness", "gap"}),
    "Scope": frozenset({"color", "opacity", "scale", "glowIntensity"}),
}
_OPS = frozenset({"create", "update", "delete"})
_FORBIDDEN = ("custom", "code", "shell", "path", "url", "network", "script", "command", "exec", "file")

_SCHEMA_COMMON = {"type": "object", "required": ["name", "type", "props", "position", "size", "zIndex", "isVisible", "isLocked"], "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 128}, "type": {"enum": sorted(HUD_TYPES)}, "props": {"type": "object"}, "position": {"$ref": "#/$defs/position"}, "size": {"$ref": "#/$defs/size"}, "zIndex": {"type": "integer", "minimum": -100000, "maximum": 100000}, "isVisible": {"type": "boolean"}, "isLocked": {"type": "boolean"}, "align": {"enum": sorted(ALIGN)}}, "additionalProperties": False}
_PROP_SCHEMAS = {
    "Container": {"type": "object", "properties": {key: {"type": ["string", "number"]} for key in PROP_FIELDS["Container"]}, "additionalProperties": False},
    "Text": {"type": "object", "properties": {"text": {"type": "string", "maxLength": 2048}, "color": {"type": "string", "maxLength": 64}, "fontSize": {"type": "number", "minimum": 0, "maximum": 10000}, "fontWeight": {"type": ["string", "number"]}, "fontFamily": {"type": "string", "maxLength": 128}}, "additionalProperties": False},
    "HealthBar": {"type": "object", "properties": {"value": {"type": "number"}, "max": {"type": "number", "exclusiveMinimum": 0}, "barColor": {"type": "string", "maxLength": 64}, "backgroundColor": {"type": "string", "maxLength": 64}, "showIcon": {"type": "boolean"}, "showText": {"type": "boolean"}}, "additionalProperties": False},
    "Crosshair": {"type": "object", "properties": {"color": {"type": "string", "maxLength": 64}, "size": {"type": "number", "minimum": 0, "maximum": 10000}, "thickness": {"type": "number", "minimum": 0, "maximum": 10000}, "gap": {"type": "number", "minimum": 0, "maximum": 10000}}, "additionalProperties": False},
    "Scope": {"type": "object", "properties": {"color": {"type": "string", "maxLength": 64}, "opacity": {"type": "number", "minimum": 0, "maximum": 1}, "scale": {"type": "number", "exclusiveMinimum": 0, "maximum": 100}, "glowIntensity": {"type": "number", "minimum": 0, "maximum": 10000}}, "additionalProperties": False},
}
_ELEMENT_SCHEMA = {"oneOf": [{**_SCHEMA_COMMON, "properties": {**_SCHEMA_COMMON["properties"], "type": {"const": kind}, "props": _PROP_SCHEMAS[kind]}} for kind in sorted(HUD_TYPES)]}
_DELTA_SCHEMA = {"type": "object", "minProperties": 1, "properties": {"props": {"type": "object"}, "position": {"$ref": "#/$defs/position"}, "size": {"$ref": "#/$defs/size"}, "zIndex": {"type": "integer", "minimum": -100000, "maximum": 100000}, "isVisible": {"type": "boolean"}, "isLocked": {"type": "boolean"}, "align": {"enum": sorted(ALIGN)}}, "additionalProperties": False}
COMMAND_JSON_SCHEMA = {"type": "object", "properties": {"proposal_id": {"type": "string", "maxLength": 128}, "base_revision": {"type": "integer", "minimum": 0}, "commands": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"oneOf": [{"type": "object", "required": ["op", "element"], "properties": {"op": {"const": "create"}, "element": _ELEMENT_SCHEMA}, "additionalProperties": False}, {"type": "object", "required": ["op", "name", "delta"], "properties": {"op": {"const": "update"}, "name": {"type": "string", "minLength": 1, "maxLength": 128}, "delta": _DELTA_SCHEMA}, "additionalProperties": False}, {"type": "object", "required": ["op", "name"], "properties": {"op": {"const": "delete"}, "name": {"type": "string", "minLength": 1, "maxLength": 128}}, "additionalProperties": False}]}}}, "required": ["commands"], "additionalProperties": False, "$defs": {"position": {"type": "object", "required": ["x", "y"], "properties": {"x": {"type": "number", "minimum": -100000, "maximum": 100000}, "y": {"type": "number", "minimum": -100000, "maximum": 100000}}, "additionalProperties": False}, "size": {"type": "object", "required": ["width", "height"], "properties": {"width": {"type": "number", "exclusiveMinimum": 0, "maximum": 100000}, "height": {"type": "number", "exclusiveMinimum": 0, "maximum": 100000}}, "additionalProperties": False}}}

@dataclass(frozen=True, slots=True)
class CommandProposal:
    proposal_id: str
    base_revision: int
    commands: tuple[Mapping[str, Any], ...]
    diff_hash: str
    prompt_hash: str | None = None
    def as_dict(self) -> dict[str, Any]:
        return {"proposal_id": self.proposal_id, "base_revision": self.base_revision, "commands": [dict(x) for x in self.commands], "diff_hash": self.diff_hash, "prompt_hash": self.prompt_hash}

def validate_command(value: Mapping[str, Any], *, proposal_id: str | None = None, base_revision: int | None = None, prompt_hash: str | None = None, target_element_id: str | None = None) -> CommandProposal:
    if not isinstance(value, Mapping): raise CommandValidationError("proposal must be an object")
    raw = value.get("commands")
    if not isinstance(raw, list) or not 0 < len(raw) <= 50: raise CommandValidationError("commands must contain 1..50 items")
    normalized = []
    for command in raw:
        if not isinstance(command, Mapping) or command.get("op") not in _OPS: raise CommandValidationError("operation is not allowlisted")
        if any(any(term in str(key).lower() for term in _FORBIDDEN) for key in command): raise CommandValidationError("unsafe command field")
        op = command["op"]
        if target_element_id is None and op != "create": raise CommandValidationError("an unbound proposal may only create elements")
        if target_element_id is not None and op == "create": raise CommandValidationError("a bound proposal may only update or delete its target")
        if op == "create":
            if set(command) != {"op", "element"}: raise CommandValidationError("create fields are invalid")
            normalized.append({"op": op, "element": _element(command["element"])})
        elif op == "update":
            if set(command) != {"op", "name", "delta"}: raise CommandValidationError("update fields are invalid")
            name = _name(command["name"])
            if target_element_id is not None and name != target_element_id: raise CommandValidationError("command target does not match host-selected element")
            delta = command["delta"]
            if not isinstance(delta, Mapping) or not delta or set(delta) - (COMMON_FIELDS - {"name", "type"}): raise CommandValidationError("update delta is invalid")
            # Updates may not change identity or type; normalize only safe mutable fields.
            if "props" in delta:
                if not isinstance(delta["props"], Mapping): raise CommandValidationError("props delta is invalid")
                _props(delta["props"], None)
            normalized.append({"op": op, "name": name, "delta": _delta(delta)})
        else:
            if set(command) != {"op", "name"}: raise CommandValidationError("delete fields are invalid")
            name = _name(command["name"])
            if target_element_id is not None and name != target_element_id: raise CommandValidationError("command target does not match host-selected element")
            normalized.append({"op": op, "name": name})
    revision = base_revision if base_revision is not None else value.get("base_revision", 0)
    if not isinstance(revision, int) or revision < 0: raise CommandValidationError("base revision is invalid")
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()
    if len(encoded) > 32 * 1024: raise CommandValidationError("proposal exceeds size limit")
    identifier = proposal_id or str(value.get("proposal_id", hashlib.sha256(encoded).hexdigest()[:16]))
    if not isinstance(identifier, str) or not 1 <= len(identifier) <= 128: raise CommandValidationError("proposal id is invalid")
    return CommandProposal(identifier, revision, tuple(normalized), hashlib.sha256(encoded).hexdigest(), prompt_hash)

def _name(value: Any) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 128 or any(ch in value for ch in "\\/:\n\r") or any(term in value.lower() for term in _FORBIDDEN): raise CommandValidationError("HUD name is invalid")
    return value

def _element(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) - COMMON_FIELDS or not COMMON_FIELDS - {"align"} <= set(value): raise CommandValidationError("HUD element shape is invalid")
    name, kind = _name(value.get("name")), value.get("type")
    if kind not in HUD_TYPES: raise CommandValidationError("HUD type is not safe")
    props = value.get("props")
    _props(props, kind)
    position, size = value.get("position"), value.get("size")
    if not isinstance(position, Mapping) or set(position) != {"x", "y"}: raise CommandValidationError("position is invalid")
    if not isinstance(size, Mapping) or set(size) != {"width", "height"}: raise CommandValidationError("size is invalid")
    x, y = _number(position["x"], -100000, 100000), _number(position["y"], -100000, 100000)
    width, height = _number(size["width"], 1, 100000), _number(size["height"], 1, 100000)
    z = value.get("zIndex");
    if not isinstance(z, int) or isinstance(z, bool) or not -100000 <= z <= 100000: raise CommandValidationError("zIndex is invalid")
    if not isinstance(value.get("isVisible"), bool) or not isinstance(value.get("isLocked"), bool): raise CommandValidationError("visibility/lock is invalid")
    result = {"name": name, "type": kind, "props": dict(props), "position": {"x": x, "y": y}, "size": {"width": width, "height": height}, "zIndex": z, "isVisible": value["isVisible"], "isLocked": value["isLocked"]}
    if "align" in value:
        if value["align"] not in ALIGN: raise CommandValidationError("align is invalid")
        result["align"] = value["align"]
    return result

def _delta(value: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(value)
    if "name" in result or "type" in result: raise CommandValidationError("identity cannot be updated")
    if "position" in result:
        p = result["position"]
        if not isinstance(p, Mapping) or set(p) != {"x", "y"}: raise CommandValidationError("position delta is invalid")
        result["position"] = {"x": _number(p["x"], -100000, 100000), "y": _number(p["y"], -100000, 100000)}
    if "size" in result:
        s = result["size"]
        if not isinstance(s, Mapping) or set(s) != {"width", "height"}: raise CommandValidationError("size delta is invalid")
        result["size"] = {"width": _number(s["width"], 1, 100000), "height": _number(s["height"], 1, 100000)}
    if "zIndex" in result and (not isinstance(result["zIndex"], int) or isinstance(result["zIndex"], bool) or not -100000 <= result["zIndex"] <= 100000): raise CommandValidationError("zIndex delta is invalid")
    if "align" in result and result["align"] not in ALIGN: raise CommandValidationError("align delta is invalid")
    for key in ("isVisible", "isLocked"):
        if key in result and not isinstance(result[key], bool): raise CommandValidationError("boolean delta is invalid")
    return result

def _props(value: Any, kind: str | None) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or (kind is not None and set(value) - PROP_FIELDS[kind]): raise CommandValidationError("props are not allowlisted")
    if len(value) > 16: raise CommandValidationError("too many props")
    for key, item in value.items():
        if any(term in str(key).lower() for term in _FORBIDDEN): raise CommandValidationError("unsafe prop")
        if isinstance(item, (Mapping, list, tuple)) or not isinstance(item, (str, int, float, bool)) or (isinstance(item, str) and (len(item) > 2048 or any(term in item.lower() for term in _FORBIDDEN))): raise CommandValidationError("unsafe prop value")
        if isinstance(item, float) and not math.isfinite(item): raise CommandValidationError("prop number is invalid")
    return value

def validate_update(delta: Mapping[str, Any], element_type: str) -> dict[str, Any]:
    """Validate an update against the existing element type before host apply."""
    if element_type not in HUD_TYPES: raise CommandValidationError("HUD type is not safe")
    if not isinstance(delta, Mapping) or "type" in delta or "name" in delta: raise CommandValidationError("identity cannot be updated")
    if "props" in delta: _props(delta["props"], element_type)
    return _delta(delta)

def _number(value: Any, low: float, high: float) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high: raise CommandValidationError("number is invalid")
    return value
