"""Strict, reviewable HUD element command proposals."""
from __future__ import annotations
import hashlib, json, math, re
from dataclasses import dataclass
from typing import Any, Mapping

class CommandValidationError(ValueError): pass

HUD_TYPES = frozenset({"Container", "Text", "HealthBar", "Crosshair", "Scope", "Button"})
ALIGN = frozenset({"top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right"})
COMMON_FIELDS = frozenset({"name", "type", "props", "position", "size", "zIndex", "isVisible", "isLocked", "align"})
# The HUD vocabulary below mirrors the editor ("fbx-viewer (1)"): player/menus.tsx parseMenuAction,
# components/HUDEditor/componentRegistry.tsx (BUTTON_VARIANTS, defaultProps, propOptions, bindableProps)
# and components/HUDEditor/HUDBindingField.tsx HUD_BINDING_SOURCES / runtime/gameState.ts readGameStateBinding.
MENU_ACTIONS = frozenset({"play", "continue", "options", "quit", "resume", "save", "load"})
OPEN_LEVEL_PREFIX = "openLevel:"
BUTTON_VARIANTS = frozenset({"primary", "secondary", "outline", "ghost"})
TEXT_ALIGN = frozenset({"left", "center", "right"})
BINDING_SOURCES = frozenset({"player.health", "player.maxHealth", "player.stamina", "player.isAiming", "player.weapon",
                             "player.ammo", "player.magazine", "player.reserve", "player.reloading", "level.id"})
VARIABLE_BINDING_PREFIX = "vars."
# Props each element type may bind to a live game-state value while the game runs.
BINDABLE_PROPS = {
    "Container": frozenset({"backgroundColor", "borderColor"}),
    "Text": frozenset({"text", "color"}),
    "HealthBar": frozenset({"value", "max"}),
    "Crosshair": frozenset({"color"}),
    "Scope": frozenset({"opacity", "scale"}),
    "Button": frozenset({"label"}),
}
# Every element may run a menu action when clicked and may bind props to live values.
_SHARED_PROPS = frozenset({"action", "bind"})
PROP_FIELDS = {
    "Container": frozenset({"backgroundColor", "borderColor", "borderWidth", "borderRadius"}) | _SHARED_PROPS,
    "Text": frozenset({"text", "textKey", "color", "fontSize", "fontWeight", "fontFamily", "textAlign"}) | _SHARED_PROPS,
    "HealthBar": frozenset({"value", "max", "barColor", "backgroundColor", "showIcon", "showText"}) | _SHARED_PROPS,
    "Crosshair": frozenset({"color", "size", "thickness", "gap"}) | _SHARED_PROPS,
    "Scope": frozenset({"color", "opacity", "scale", "glowIntensity"}) | _SHARED_PROPS,
    "Button": frozenset({"label", "labelKey", "variant", "fontSize"}) | _SHARED_PROPS,
}
_ALL_PROPS = frozenset().union(*PROP_FIELDS.values())
_ALL_BINDABLE = frozenset().union(*BINDABLE_PROPS.values())
_OPS = frozenset({"create", "update", "delete"})
_FORBIDDEN = ("custom", "code", "shell", "path", "url", "network", "script", "command", "exec", "file")
# Names a plain-object lookup in the player resolves through Object.prototype.
_RESERVED_NAMES = frozenset({"__proto__", "constructor", "prototype", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "toString", "valueOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"})
_LEVEL_ID = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"
_VARIABLE_NAME = r"[A-Za-z_][A-Za-z0-9_]{0,63}"
_STRING_KEY = r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}"
_ACTION_BODY = "|".join(sorted(MENU_ACTIONS)) + "|" + re.escape(OPEN_LEVEL_PREFIX) + _LEVEL_ID
_BIND_BODY = "|".join(re.escape(source) for source in sorted(BINDING_SOURCES)) + "|" + re.escape(VARIABLE_BINDING_PREFIX) + _VARIABLE_NAME
_ACTION_RE, _BIND_RE, _STRING_KEY_RE = re.compile("(?:" + _ACTION_BODY + ")?"), re.compile("(?:" + _BIND_BODY + ")"), re.compile("(?:" + _STRING_KEY + ")?")
_LABEL_MAX = 256

_SCHEMA_COMMON = {"type": "object", "required": ["name", "type", "props", "position", "size", "zIndex", "isVisible", "isLocked"], "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 128}, "type": {"enum": sorted(HUD_TYPES)}, "props": {"type": "object"}, "position": {"$ref": "#/$defs/position"}, "size": {"$ref": "#/$defs/size"}, "zIndex": {"type": "integer", "minimum": -100000, "maximum": 100000}, "isVisible": {"type": "boolean"}, "isLocked": {"type": "boolean"}, "align": {"enum": sorted(ALIGN)}}, "additionalProperties": False}
_ACTION_SCHEMA = {"type": "string", "maxLength": len(OPEN_LEVEL_PREFIX) + 128, "pattern": "^(" + _ACTION_BODY + ")?$", "description": "Menu action run when the player clicks this element on a menu screen: " + ", ".join(sorted(MENU_ACTIONS)) + " or openLevel:<levelId>; empty for none."}
_STRING_KEY_DESCRIPTION = "Localization string-table key such as menu.play; when set it replaces the literal {}. Empty to use the literal."
def _string_key_schema(literal: str) -> dict[str, Any]:
    return {"type": "string", "maxLength": 200, "pattern": "^(" + _STRING_KEY + ")?$", "description": _STRING_KEY_DESCRIPTION.format(literal)}
def _bind_object(props: frozenset[str], bindable: str) -> dict[str, Any]:
    return {"type": "object", "properties": {prop: {"type": "string", "maxLength": len(VARIABLE_BINDING_PREFIX) + 64, "pattern": "^(" + _BIND_BODY + ")$"} for prop in sorted(props)}, "additionalProperties": False, "description": "Live values while the game runs, as prop name -> source: " + ", ".join(sorted(BINDING_SOURCES)) + " or vars.<levelVariableName>. Bindable props: " + bindable + ". An update replaces the whole map."}
def _bind_schema(kind: str) -> dict[str, Any]:
    return _bind_object(BINDABLE_PROPS[kind], ", ".join(sorted(BINDABLE_PROPS[kind])))
def _prop_schema(kind: str, properties: Mapping[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": {**properties, "action": _ACTION_SCHEMA, "bind": _bind_schema(kind)}, "additionalProperties": False}
_PROP_SCHEMAS = {
    "Container": _prop_schema("Container", {key: {"type": ["string", "number"]} for key in ("backgroundColor", "borderColor", "borderWidth", "borderRadius")}),
    "Text": _prop_schema("Text", {"text": {"type": "string", "maxLength": 2048}, "textKey": _string_key_schema("text"), "color": {"type": "string", "maxLength": 64}, "fontSize": {"type": "number", "minimum": 0, "maximum": 10000}, "fontWeight": {"type": ["string", "number"]}, "fontFamily": {"type": "string", "maxLength": 128}, "textAlign": {"enum": sorted(TEXT_ALIGN)}}),
    "HealthBar": _prop_schema("HealthBar", {"value": {"type": "number"}, "max": {"type": "number", "exclusiveMinimum": 0}, "barColor": {"type": "string", "maxLength": 64}, "backgroundColor": {"type": "string", "maxLength": 64}, "showIcon": {"type": "boolean"}, "showText": {"type": "boolean"}}),
    "Crosshair": _prop_schema("Crosshair", {"color": {"type": "string", "maxLength": 64}, "size": {"type": "number", "minimum": 0, "maximum": 10000}, "thickness": {"type": "number", "minimum": 0, "maximum": 10000}, "gap": {"type": "number", "minimum": 0, "maximum": 10000}}),
    "Scope": _prop_schema("Scope", {"color": {"type": "string", "maxLength": 64}, "opacity": {"type": "number", "minimum": 0, "maximum": 1}, "scale": {"type": "number", "exclusiveMinimum": 0, "maximum": 100}, "glowIntensity": {"type": "number", "minimum": 0, "maximum": 10000}}),
    "Button": _prop_schema("Button", {"label": {"type": "string", "maxLength": _LABEL_MAX}, "labelKey": _string_key_schema("label"), "variant": {"enum": sorted(BUTTON_VARIANTS)}, "fontSize": {"type": "number", "minimum": 0, "maximum": 10000}}),
}
_ELEMENT_SCHEMA = {"oneOf": [{**_SCHEMA_COMMON, "properties": {**_SCHEMA_COMMON["properties"], "type": {"const": kind}, "props": _PROP_SCHEMAS[kind]}} for kind in sorted(HUD_TYPES)]}
def _update_props_schema() -> dict[str, Any]:
    """Every HUD type's props as one closed object: an update's schema cannot know the target's type
    (validate_update re-checks props against it), and providers that close objects by default or require
    additionalProperties false would otherwise only accept {}. A prop whose rules differ by type takes anyOf."""
    variants: dict[str, list[Any]] = {}
    for kind in sorted(HUD_TYPES):
        for key, schema in _PROP_SCHEMAS[kind]["properties"].items():
            if key != "bind" and schema not in variants.setdefault(key, []): variants[key].append(schema)
    properties: dict[str, Any] = {key: found[0] if len(found) == 1 else {"anyOf": found} for key, found in sorted(variants.items())}
    properties["bind"] = _bind_object(_ALL_BINDABLE, "; ".join(kind + ": " + ", ".join(sorted(BINDABLE_PROPS[kind])) for kind in sorted(HUD_TYPES)))
    return {"type": "object", "properties": properties, "additionalProperties": False, "description": "Props merged into the target element, using the prop names and rules of its type."}
_DELTA_SCHEMA = {"type": "object", "minProperties": 1, "properties": {"props": _update_props_schema(), "position": {"$ref": "#/$defs/position"}, "size": {"$ref": "#/$defs/size"}, "zIndex": {"type": "integer", "minimum": -100000, "maximum": 100000}, "isVisible": {"type": "boolean"}, "isLocked": {"type": "boolean"}, "align": {"enum": sorted(ALIGN)}}, "additionalProperties": False}
_COMMAND_DESCRIPTION = "HUD element commands. Element types: " + ", ".join(sorted(HUD_TYPES)) + ". A Button draws label (or the labelKey string) in a variant (" + ", ".join(sorted(BUTTON_VARIANTS)) + ") and runs its action when clicked on a menu screen. Every element may set action and bind props to live game-state values."
COMMAND_JSON_SCHEMA = {"type": "object", "description": _COMMAND_DESCRIPTION, "properties": {"proposal_id": {"type": "string", "minLength": 1, "maxLength": 128}, "base_revision": {"type": "integer", "minimum": 0}, "commands": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"oneOf": [{"type": "object", "required": ["op", "element"], "properties": {"op": {"const": "create"}, "element": _ELEMENT_SCHEMA}, "additionalProperties": False}, {"type": "object", "required": ["op", "name", "delta"], "properties": {"op": {"const": "update"}, "name": {"type": "string", "minLength": 1, "maxLength": 128}, "delta": _DELTA_SCHEMA}, "additionalProperties": False}, {"type": "object", "required": ["op", "name"], "properties": {"op": {"const": "delete"}, "name": {"type": "string", "minLength": 1, "maxLength": 128}}, "additionalProperties": False}]}}}, "required": ["commands"], "additionalProperties": False, "$defs": {"position": {"type": "object", "required": ["x", "y"], "properties": {"x": {"type": "number", "minimum": -100000, "maximum": 100000}, "y": {"type": "number", "minimum": -100000, "maximum": 100000}}, "additionalProperties": False}, "size": {"type": "object", "required": ["width", "height"], "properties": {"width": {"type": "number", "exclusiveMinimum": 0, "maximum": 100000}, "height": {"type": "number", "exclusiveMinimum": 0, "maximum": 100000}}, "additionalProperties": False}}}

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
            # The target's type is unknown here, so props are checked against every HUD
            # type; validate_update re-checks them against the real type before apply.
            props = None
            if "props" in delta:
                if not isinstance(delta["props"], Mapping): raise CommandValidationError("props delta is invalid")
                props = _props(delta["props"], None)
            normalized_delta = _delta(delta)
            if props is not None: normalized_delta["props"] = props
            normalized.append({"op": op, "name": name, "delta": normalized_delta})
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
    props = _props(value.get("props"), kind)
    position, size = value.get("position"), value.get("size")
    if not isinstance(position, Mapping) or set(position) != {"x", "y"}: raise CommandValidationError("position is invalid")
    if not isinstance(size, Mapping) or set(size) != {"width", "height"}: raise CommandValidationError("size is invalid")
    x, y = _number(position["x"], -100000, 100000), _number(position["y"], -100000, 100000)
    width, height = _number(size["width"], 1, 100000), _number(size["height"], 1, 100000)
    z = value.get("zIndex");
    if not isinstance(z, int) or isinstance(z, bool) or not -100000 <= z <= 100000: raise CommandValidationError("zIndex is invalid")
    if not isinstance(value.get("isVisible"), bool) or not isinstance(value.get("isLocked"), bool): raise CommandValidationError("visibility/lock is invalid")
    result = {"name": name, "type": kind, "props": props, "position": {"x": x, "y": y}, "size": {"width": width, "height": height}, "zIndex": z, "isVisible": value["isVisible"], "isLocked": value["isLocked"]}
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

def _props(value: Any, kind: str | None) -> dict[str, Any]:
    """A normalized copy of allowlisted props for `kind`, or for any HUD type when the type is not known yet."""
    if not isinstance(value, Mapping) or set(value) - (PROP_FIELDS[kind] if kind is not None else _ALL_PROPS): raise CommandValidationError("props are not allowlisted")
    if len(value) > 16: raise CommandValidationError("too many props")
    result: dict[str, Any] = {}
    for key, item in value.items():
        if any(term in str(key).lower() for term in _FORBIDDEN): raise CommandValidationError("unsafe prop")
        if key == "bind":
            result[key] = _bindings(item, kind)
            continue
        if isinstance(item, (Mapping, list, tuple)) or not isinstance(item, (str, int, float, bool)) or (isinstance(item, str) and (len(item) > 2048 or any(term in item.lower() for term in _FORBIDDEN))): raise CommandValidationError("unsafe prop value")
        if isinstance(item, float) and not math.isfinite(item): raise CommandValidationError("prop number is invalid")
        check = _PROP_VALUES.get(key)
        if check is not None and not check(item): raise CommandValidationError(f"{key} prop is invalid")
        result[key] = item
    return result

def _bindings(value: Any, kind: str | None) -> dict[str, str]:
    """`props.bind`: bindable prop name -> a known game-state source or vars.<name>."""
    allowed = BINDABLE_PROPS[kind] if kind is not None else _ALL_BINDABLE
    if not isinstance(value, Mapping): raise CommandValidationError("bind is invalid")
    result: dict[str, str] = {}
    for prop, source in value.items():
        if not isinstance(prop, str) or prop not in allowed: raise CommandValidationError("bind prop is not bindable")
        if not isinstance(source, str) or _BIND_RE.fullmatch(source) is None or source.removeprefix(VARIABLE_BINDING_PREFIX) in _RESERVED_NAMES or any(term in source.lower() for term in _FORBIDDEN): raise CommandValidationError("bind source is not allowlisted")
        result[prop] = source
    return result

def _is_string_key(value: Any) -> bool:
    return isinstance(value, str) and _STRING_KEY_RE.fullmatch(value) is not None and value not in _RESERVED_NAMES

def _is_font_size(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and 0 <= value <= 10000

# Value rules for props whose meaning is fixed by the editor; other props keep the generic scalar rules above.
_PROP_VALUES = {
    "action": lambda value: isinstance(value, str) and _ACTION_RE.fullmatch(value) is not None,
    "textKey": _is_string_key,
    "labelKey": _is_string_key,
    "label": lambda value: isinstance(value, str) and len(value) <= _LABEL_MAX,
    "variant": lambda value: isinstance(value, str) and value in BUTTON_VARIANTS,
    "textAlign": lambda value: isinstance(value, str) and value in TEXT_ALIGN,
    "fontSize": _is_font_size,
}

def validate_update(delta: Mapping[str, Any], element_type: str) -> dict[str, Any]:
    """Validate an update against the existing element type before host apply."""
    if element_type not in HUD_TYPES: raise CommandValidationError("HUD type is not safe")
    if not isinstance(delta, Mapping) or "type" in delta or "name" in delta: raise CommandValidationError("identity cannot be updated")
    props = _props(delta["props"], element_type) if "props" in delta else None
    result = _delta(delta)
    if props is not None: result["props"] = props
    return result

def _number(value: Any, low: float, high: float) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high: raise CommandValidationError("number is invalid")
    return value

# Provider projections of COMMAND_JSON_SCHEMA. Each provider constrains decoding with its own JSON Schema
# subset and several answer a schema outside it with HTTP 400, so a request carries the projection for its
# provider. The projections only guide the model: validate_command/validate_update stay the authority.
@dataclass(frozen=True, slots=True)
class _SchemaProfile:
    strict: bool  # every property is listed in required and optional ones become nullable
    unsupported: frozenset[str] = frozenset()  # constraint keywords removed (and restated in the description)
    const: bool = True  # False: {"const": v} becomes a one-value enum
    type_arrays: bool = True  # False: "type": [a, b] unions become anyOf
    max_min_items: int | None = None  # the largest minItems the provider accepts
    number_ranges: bool = True  # False: range keywords are kept on integers only
    lengths_with_pattern: bool = True  # False: minLength/maxLength are removed where a pattern applies

_RANGE_KEYWORDS = frozenset({"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"})
_VALUE_CONSTRAINTS = _RANGE_KEYWORDS | {"multipleOf", "minLength", "maxLength", "pattern", "maxItems", "minProperties", "maxProperties"}
_CONSTRAINT_HINTS = {"minimum": ">= {}", "maximum": "<= {}", "exclusiveMinimum": "> {}", "exclusiveMaximum": "< {}", "multipleOf": "a multiple of {}", "minLength": "length >= {}", "maxLength": "length <= {}", "pattern": "pattern {}", "minItems": "items >= {}", "maxItems": "items <= {}", "minProperties": "fields set >= {}", "maxProperties": "fields set <= {}"}
_SCALAR_TYPES = frozenset({"string", "number", "integer", "boolean"})
_SCHEMA_PROFILES = {
    # Strict structured outputs: all keys required, additionalProperties false, anyOf (oneOf is rejected).
    # minLength/maxLength, min/maxProperties and const are missing from the documented subset.
    "openai": _SchemaProfile(strict=True, unsupported=frozenset({"minLength", "maxLength", "minProperties", "maxProperties"}), const=False),
    # Enforces every canonical keyword (oneOf as anyOf) within its limits; optional properties are allowed.
    "xai": _SchemaProfile(strict=False),
    # No numeric, length, maxItems or property-count constraints and minItems 0/1 only; patterns with large
    # {n,m} ranges may be rejected, so patterns go too.
    "anthropic": _SchemaProfile(strict=False, unsupported=_VALUE_CONSTRAINTS, max_min_items=1),
    # Forwarded to the routed endpoint's strict mode, so the OpenAI shape within the Anthropic keyword subset,
    # spelling unions as anyOf.
    "openrouter": _SchemaProfile(strict=True, unsupported=_VALUE_CONSTRAINTS, const=False, type_arrays=False, max_min_items=1),
    # llama.cpp's grammar conversion (Ollama runs it through llama-server) honours ranges on integers only and
    # lets a pattern override lengths; it skips the rest silently.
    "llama.cpp": _SchemaProfile(strict=False, unsupported=frozenset({"multipleOf", "minProperties", "maxProperties"}), number_ranges=False, lengths_with_pattern=False),
}
_SCHEMA_PROFILES["ollama"] = _SCHEMA_PROFILES["llama.cpp"]
# fal's language models are OpenRouter's, through its router.
_SCHEMA_PROFILES["fal"] = _SCHEMA_PROFILES["openrouter"]
COMMAND_SCHEMA_PROVIDERS = frozenset(_SCHEMA_PROFILES)

def provider_command_schema(provider_id: str) -> dict[str, Any]:
    """COMMAND_JSON_SCHEMA projected onto the JSON Schema subset `provider_id` accepts, as a new object.

    Local $refs are inlined, oneOf becomes anyOf, constraint keywords the provider does not support are
    removed and restated in the description, and strict providers list every property in required with
    the optional ones made nullable (validate_provider_command drops those nulls again)."""
    profile = _SCHEMA_PROFILES.get(provider_id)
    if profile is None: raise ValueError("provider has no command schema")
    definitions = COMMAND_JSON_SCHEMA.get("$defs", {})
    return _project(_inline({key: value for key, value in COMMAND_JSON_SCHEMA.items() if key != "$defs"}, definitions, ()), profile)

def _inline(node: Any, definitions: Mapping[str, Any], active: tuple[str, ...]) -> Any:
    """A deep copy of `node` with every local "#/$defs/<name>" reference replaced by its target."""
    if isinstance(node, list): return [_inline(item, definitions, active) for item in node]
    if not isinstance(node, Mapping): return node
    if "$ref" in node:
        ref = node["$ref"]
        name = ref[len("#/$defs/"):] if isinstance(ref, str) and ref.startswith("#/$defs/") else None
        if name not in definitions or name in active: raise ValueError("schema reference cannot be inlined")
        return {**_inline(definitions[name], definitions, active + (name,)), **_inline({key: value for key, value in node.items() if key != "$ref"}, definitions, active)}
    return {key: _inline(value, definitions, active) for key, value in node.items()}

def _drops(key: str, value: Any, node: Mapping[str, Any], profile: _SchemaProfile) -> bool:
    if key in profile.unsupported: return True
    if key == "minItems": return profile.max_min_items is not None and value > profile.max_min_items
    if key in _RANGE_KEYWORDS: return not profile.number_ranges and node.get("type") != "integer"
    if key in ("minLength", "maxLength"): return not profile.lengths_with_pattern and "pattern" in node and "pattern" not in profile.unsupported
    return False

def _json_type(value: Any) -> str:
    if value is None: return "null"
    if isinstance(value, bool): return "boolean"
    if isinstance(value, int): return "integer"
    return "number" if isinstance(value, float) else "string" if isinstance(value, str) else "object"

def _project(node: Any, profile: _SchemaProfile) -> dict[str, Any]:
    """One schema node (already a private copy) rewritten for `profile`."""
    result: dict[str, Any] = {}
    hints: list[str] = []
    for key, value in node.items():
        if key in ("oneOf", "anyOf"): result.setdefault("anyOf", []).extend(_project(item, profile) for item in value)
        elif key == "allOf": result[key] = [_project(item, profile) for item in value]
        elif key == "properties": result[key] = {name: _project(item, profile) for name, item in value.items()}
        elif key in ("items", "additionalProperties") and isinstance(value, Mapping): result[key] = _project(value, profile)
        elif key in _CONSTRAINT_HINTS and _drops(key, value, node, profile): hints.append(_CONSTRAINT_HINTS[key].format(value))
        else: result[key] = value
    if hints: result["description"] = (result["description"] + " " if result.get("description") else "") + "Constraints: " + ", ".join(hints)
    if not profile.const and "const" in result: result["enum"] = [result.pop("const")]
    if profile.strict and "enum" in result and "type" not in result:
        kinds = {_json_type(item) for item in result["enum"]}
        if len(kinds) == 1: result["type"] = kinds.pop()
    if not profile.type_arrays and isinstance(result.get("type"), list):
        kinds, description = result.pop("type"), result.pop("description", None)
        result = {"anyOf": [{"type": kind, **result} for kind in kinds], **({"description": description} if description is not None else {})}
    if result.get("type") == "object" or "properties" in result:
        result["additionalProperties"] = False
        if profile.strict:
            properties, required = result.setdefault("properties", {}), set(node.get("required", ()))
            for name, schema in properties.items():
                if name not in required: properties[name] = _nullable(schema, profile)
            result["required"] = list(properties)
    return result

def _nullable(schema: dict[str, Any], profile: _SchemaProfile) -> dict[str, Any]:
    """`schema` that also accepts null: a type union for plain scalars, otherwise an anyOf null branch."""
    kind = schema.get("type")
    kinds = [kind] if isinstance(kind, str) else kind
    if profile.type_arrays and isinstance(kinds, list) and set(kinds) <= _SCALAR_TYPES and not {"enum", "const", "anyOf", "allOf"} & schema.keys():
        return {**schema, "type": [*kinds, "null"]}
    if "anyOf" in schema and set(schema) <= {"anyOf", "description"}:
        return schema if {"type": "null"} in schema["anyOf"] else {**schema, "anyOf": [*schema["anyOf"], {"type": "null"}]}
    return {"anyOf": [schema, {"type": "null"}]}

def strip_optional_nulls(value: Any) -> Any:
    """Provider output without the null-valued properties COMMAND_JSON_SCHEMA marks optional.

    Strict structured outputs make every property required, so the model sends null where a sparse
    proposal leaves a field out. Nulls in required or unknown fields stay for validate_command to reject.
    The input is not changed; the walk follows the schema, so its depth is bounded by the schema's."""
    return _strip_nulls(value, COMMAND_JSON_SCHEMA)

def _resolve(schema: Any) -> Any:
    if isinstance(schema, Mapping) and isinstance(schema.get("$ref"), str) and schema["$ref"].startswith("#/$defs/"):
        return COMMAND_JSON_SCHEMA["$defs"].get(schema["$ref"][len("#/$defs/"):])
    return schema

def _strip_nulls(value: Any, schema: Any) -> Any:
    schema = _resolve(schema)
    if not isinstance(schema, Mapping): return value
    if isinstance(value, list):
        items = schema.get("items")
        return [_strip_nulls(item, items) for item in value] if isinstance(items, Mapping) else value
    if not isinstance(value, Mapping): return value
    branches = schema.get("oneOf", schema.get("anyOf"))
    if isinstance(branches, list):
        schema = _tagged_branch(value, branches)
        if schema is None: return value
    properties = schema.get("properties")
    if not isinstance(properties, Mapping): return value
    required = schema.get("required", ())
    return {key: _strip_nulls(item, properties.get(key)) for key, item in value.items() if not (item is None and key in properties and key not in required)}

def _tagged_branch(value: Mapping[str, Any], branches: list[Any]) -> Mapping[str, Any] | None:
    """The union branch whose const-valued properties (op, element type) all match `value`."""
    for branch in map(_resolve, branches):
        if not isinstance(branch, Mapping) or not isinstance(branch.get("properties"), Mapping): continue
        tags = {key: prop["const"] for key, prop in branch["properties"].items() if isinstance(prop, Mapping) and "const" in prop}
        if tags and all(key in value and value[key] == tag for key, tag in tags.items()): return branch
    return None

def validate_provider_command(value: Any, *, target_element_id: str | None = None) -> CommandProposal:
    """validate_command for structured provider output, which may carry nulls for absent optional fields."""
    cleaned = strip_optional_nulls(value)
    # Strict outputs must always write proposal_id; an empty one means "none", so the host derives the id.
    if isinstance(cleaned, dict) and cleaned.get("proposal_id") == "":
        cleaned = {key: item for key, item in cleaned.items() if key != "proposal_id"}
    return validate_command(cleaned, target_element_id=target_element_id)
