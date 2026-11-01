"""fal.ai's catalog: which endpoints exist, what each costs and what each takes.

Every image model fal offers is listed from its model API, and the language models its router reaches from
OpenRouter's public list, so a new model needs no change here. Prices are read in the background (fal limits how fast)
and everything is kept in one file beside the provider's other state, so the list is there at once on the next start.
"""

from __future__ import annotations

import json
import os
import math
import re
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from urllib.parse import quote, urlencode

from .descriptors import Capability
from .errors import ErrorCode, ProviderError
from .transport import BoundedTransport, HttpRequest, Transport
from Auvra.diagnostics import trace_public_class

CATALOG_ORIGIN = "https://api.fal.ai"
ROUTER_MODELS_ORIGIN = "https://openrouter.ai"
ROUTER_MODELS_URL = ROUTER_MODELS_ORIGIN + "/api/v1/models"

MEDIA_CATEGORIES: Mapping[str, Capability] = {
    "image-to-image": Capability.MEDIA_EDIT,
    "text-to-image": Capability.MEDIA_GENERATE,
    "3d-to-3d": Capability.MEDIA_MESH,
}
# Models that make surface maps from a picture. Nothing about them says so in the catalog: they are image-to-image there.
MAP_MODELS = frozenset({"fal-ai/patina"})
# Models that paint a seamless material from a description, with its surface maps.
MATERIAL_MODELS = frozenset({"fal-ai/patina/material"})
# Models that were found to paint a true panorama when asked: the horizon across the middle and the ground stretched as it
# should be. Others paint a wide photograph, which falls apart wrapped around a level.
SKY_MODELS = frozenset({"fal-ai/flux-2-max", "blackforestlabs/flux-3/text-to-image"})
# Models that really answer with a transparent background. Others take the setting and paint on white.
DECAL_MODELS = frozenset({"fal-ai/ideogram/v3/generate-transparent"})
# Of the models that take a mesh, these paint it from a description and can keep its own texture layout, so what they
# make fits the model as it is. The others need a reference picture, or give back a different mesh.
MESH_MODELS = frozenset({"meshy/v7/retexture", "meshy/v6/retexture", "meshy/v6-lite/retexture"})
# What is known without the network, so that a first start offline still has a model to choose.
SEED_MODELS: Mapping[str, frozenset[Capability]] = {
    "fal-ai/flux/dev": frozenset({Capability.MEDIA_GENERATE}),
    "fal-ai/flux/dev/image-to-image": frozenset({Capability.MEDIA_EDIT}),
}

_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\Z")
_PAGE_SIZE = 100
_PRICE_BATCH = 40
_PRICE_PAUSE_SECONDS = 0.6
_RATE_LIMIT_TRIES = 6
_STALE_SECONDS = 24 * 60 * 60
_CACHE_VERSION = 4
_DESCRIPTION_LENGTH = 200
_TOKENS_PRICED = 1_000_000

TEXT_CAPABILITIES = frozenset({Capability.TEXT, Capability.CODE})


@dataclass(frozen=True, slots=True)
class CatalogModel:
    model_id: str
    display_name: str
    capabilities: frozenset[Capability]
    category: str = ""
    description: str = ""
    # What one `price_unit` costs, as fal bills it. A language model's price is for its input, with its output apart.
    price_micro_usd: int | None = None
    price_unit: str = ""
    output_price_micro_usd: int | None = None


def _micro_usd(value: Any) -> int | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number * 1_000_000) if number >= 0 and number == number and number != float("inf") else None


def _text(value: Any, limit: int) -> str:
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


def parse_media_model(row: Any) -> CatalogModel | None:
    """One row of fal's model list, or None for one that is not an active image model."""
    if not isinstance(row, Mapping) or not isinstance(row.get("metadata"), Mapping):
        return None
    endpoint, metadata = row.get("endpoint_id"), row["metadata"]
    capability = MEDIA_CATEGORIES.get(metadata.get("category"))
    if capability is None or not isinstance(endpoint, str) or _MODEL_ID.fullmatch(endpoint) is None:
        return None
    if metadata.get("status") not in (None, "active"):
        return None
    if capability == Capability.MEDIA_MESH and endpoint not in MESH_MODELS:
        return None
    if endpoint in MAP_MODELS:
        capability = Capability.MEDIA_MAPS
    capabilities = {capability}
    if endpoint in MATERIAL_MODELS:
        capabilities.add(Capability.MEDIA_MATERIAL)
    if endpoint in SKY_MODELS:
        capabilities.add(Capability.MEDIA_SKY)
    if endpoint in DECAL_MODELS:
        capabilities.add(Capability.MEDIA_DECAL)
    return CatalogModel(endpoint, _text(metadata.get("display_name"), 128) or endpoint, frozenset(capabilities),
                        str(metadata["category"]), _text(metadata.get("description"), _DESCRIPTION_LENGTH))


def parse_router_model(row: Any) -> CatalogModel | None:
    """One of OpenRouter's models as fal's router reaches it, or None for one that does not write text."""
    if not isinstance(row, Mapping) or not isinstance(row.get("id"), str) or _MODEL_ID.fullmatch(row["id"]) is None:
        return None
    architecture = row.get("architecture")
    if isinstance(architecture, Mapping):
        outputs, inputs = architecture.get("output_modalities"), architecture.get("input_modalities")
        if (isinstance(outputs, list) and "text" not in outputs) or (isinstance(inputs, list) and "text" not in inputs):
            return None
    parameters = row.get("supported_parameters")
    capabilities = set(TEXT_CAPABILITIES)
    # HUD commands need output constrained to their schema, or a Claude model's tool call (see TextAdapter).
    if isinstance(parameters, list) and ("structured_outputs" in parameters or (row["id"].startswith("anthropic/") and "tools" in parameters)):
        capabilities.add(Capability.COMMANDS)
    pricing = row.get("pricing") if isinstance(row.get("pricing"), Mapping) else {}
    prompt, completion = _micro_usd(_scaled(pricing.get("prompt"))), _micro_usd(_scaled(pricing.get("completion")))
    return CatalogModel(row["id"], _text(row.get("name"), 128) or row["id"], frozenset(capabilities), "llm",
                        _text(row.get("description"), _DESCRIPTION_LENGTH), prompt, "1M tokens", completion)


def _scaled(per_token: Any) -> float | None:
    try:
        return float(per_token) * _TOKENS_PRICED
    except (TypeError, ValueError):
        return None


def _to_cache(model: CatalogModel) -> dict[str, Any]:
    return {"id": model.model_id, "name": model.display_name, "capabilities": sorted(item.value for item in model.capabilities),
            "category": model.category, "description": model.description, "price": model.price_micro_usd,
            "unit": model.price_unit, "outputPrice": model.output_price_micro_usd}


def _from_cache(row: Any) -> CatalogModel | None:
    try:
        price, output = row.get("price"), row.get("outputPrice")
        if (_MODEL_ID.fullmatch(row["id"]) is None or (price is not None and (not isinstance(price, int) or price < 0)) or
                (output is not None and (not isinstance(output, int) or output < 0))):
            return None
        return CatalogModel(row["id"], _text(row["name"], 128), frozenset(Capability(item) for item in row["capabilities"]),
                            _text(row.get("category"), 64), _text(row.get("description"), _DESCRIPTION_LENGTH),
                            price, _text(row.get("unit"), 32), output)
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


@trace_public_class("provider_catalog", concise=("models", "refresh_prices", "request_schema"))
class FalCatalog:
    """Thread-safe: the host reads it on request while prices come in on a thread of their own."""

    def __init__(self, transport: Transport, *, key: Callable[[], str | None], cache_path: Path | None = None,
                 now: Callable[[], float] = time.time, sleep: Callable[[float], Any] = time.sleep) -> None:
        self.transport = BoundedTransport(transport, allowed_origins=(CATALOG_ORIGIN, ROUTER_MODELS_ORIGIN))
        self._key, self._cache_path, self._now, self._sleep = key, cache_path, now, sleep
        self._lock = threading.RLock()
        self._models: dict[str, CatalogModel] = {}
        self._fetched_at = 0.0
        self._priced_at = 0.0
        self._schemas: dict[str, Mapping[str, Any]] = {}
        self._load_cache()

    def models(self) -> tuple[CatalogModel, ...]:
        """Everything on offer: from the file while it is fresh, or read now. A failed read keeps what is known."""
        with self._lock:
            fresh = self._models and self._now() - self._fetched_at < _STALE_SECONDS
        if not fresh:
            try:
                self.refresh()
            except ProviderError:
                pass
        with self._lock:
            return tuple(self._models.values())

    def get(self, model_id: str) -> CatalogModel | None:
        with self._lock:
            return self._models.get(model_id)

    def refresh(self) -> None:
        models: dict[str, CatalogModel] = {}
        for category in MEDIA_CATEGORIES:
            for row in self._media_rows(category):
                parsed = parse_media_model(row)
                if parsed is not None:
                    models[parsed.model_id] = parsed
        # The language models are a list of their own; losing them for now must not lose the image models.
        try:
            for row in self._router_rows():
                parsed = parse_router_model(row)
                if parsed is not None:
                    models[parsed.model_id] = parsed
        except ProviderError:
            with self._lock:
                models.update({key: value for key, value in self._models.items() if value.category == "llm"})
        with self._lock:
            for key, known in self._models.items():
                if key in models and known.price_micro_usd is not None and models[key].price_micro_usd is None:
                    models[key] = replace(models[key], price_micro_usd=known.price_micro_usd, price_unit=known.price_unit)
            self._models, self._fetched_at = models, self._now()
        self._save_cache()

    @property
    def prices_stale(self) -> bool:
        with self._lock:
            return self._now() - self._priced_at >= _STALE_SECONDS

    def refresh_prices(self, stop: threading.Event | None = None) -> bool:
        """Reads what the image models cost, a batch at a time. True once all of them have been asked about."""
        with self._lock:
            endpoints = [model.model_id for model in self._models.values() if model.category in MEDIA_CATEGORIES]
        for at in range(0, len(endpoints), _PRICE_BATCH):
            if stop is not None and stop.is_set():
                return False
            batch = ",".join(quote(item, safe="/") for item in endpoints[at:at + _PRICE_BATCH])
            try:
                page = self._get(f"{CATALOG_ORIGIN}/v1/models/pricing?endpoint_id={batch}")
            except ProviderError:
                return False
            rows = page.get("prices") if isinstance(page, Mapping) else None
            with self._lock:
                for row in rows if isinstance(rows, list) else ():
                    if isinstance(row, Mapping) and row.get("endpoint_id") in self._models:
                        price = _micro_usd(row.get("unit_price"))
                        if price is not None and row.get("currency", "USD") == "USD":
                            self._models[row["endpoint_id"]] = replace(self._models[row["endpoint_id"]], price_micro_usd=price, price_unit=_text(row.get("unit"), 32))
            self._sleep(_PRICE_PAUSE_SECONDS)
        with self._lock:
            self._priced_at = self._now()
        self._save_cache()
        return True

    def request_schema(self, model_id: str) -> Mapping[str, Any] | None:
        """The JSON schema of what `model_id` takes, or None when fal will not say."""
        with self._lock:
            known = self._schemas.get(model_id)
        if known is not None:
            return known
        query = urlencode({"endpoint_id": model_id, "expand": "openapi-3.0"})
        try:
            page = self._get(f"{CATALOG_ORIGIN}/v1/models?{query}")
        except ProviderError:
            return None
        rows = page.get("models") if isinstance(page, Mapping) else None
        for row in rows if isinstance(rows, list) else ():
            if isinstance(row, Mapping) and row.get("endpoint_id") == model_id:
                schema = input_schema(row.get("openapi"), model_id)
                if schema is not None:
                    with self._lock:
                        self._schemas[model_id] = schema
                    return schema
        return None

    def _media_rows(self, category: str) -> Iterable[Any]:
        cursor: str | None = None
        for _ in range(64):
            query = {"category": category, "status": "active", "limit": _PAGE_SIZE, **({"cursor": cursor} if cursor else {})}
            page = self._get(f"{CATALOG_ORIGIN}/v1/models?{urlencode(query)}")
            rows = page.get("models") if isinstance(page, Mapping) else None
            yield from rows if isinstance(rows, list) else ()
            cursor = page.get("next_cursor") if isinstance(page, Mapping) else None
            if not (isinstance(page, Mapping) and page.get("has_more") and isinstance(cursor, str) and cursor):
                return

    def _router_rows(self) -> list[Any]:
        # Public, so fal's key has no business going there.
        response = self.transport.request(HttpRequest("GET", ROUTER_MODELS_URL, {"Accept": "application/json"}))
        value = response.json(max_bytes=16 * 1024 * 1024)
        rows = value.get("data") if isinstance(value, Mapping) else None
        return rows if isinstance(rows, list) else []

    def _get(self, url: str) -> Any:
        headers = {"Accept": "application/json"}
        try:
            key = self._key()
        except Exception:
            key = None
        # The list is public too; a key only raises how fast it may be read.
        if key:
            headers["Authorization"] = "Key " + key
        for attempt in range(_RATE_LIMIT_TRIES):
            try:
                return self.transport.request(HttpRequest("GET", url, headers, timeout=60.0)).json(max_bytes=16 * 1024 * 1024)
            except ProviderError as error:
                if error.code != ErrorCode.RATE_LIMITED or attempt == _RATE_LIMIT_TRIES - 1:
                    raise
                self._sleep(error.retry_after if error.retry_after is not None else 2.0 + attempt * 2.0)
        raise ProviderError(ErrorCode.RATE_LIMITED, "fal catalog is rate limited", "fal", True)

    def _load_cache(self) -> None:
        if self._cache_path is None:
            return
        try:
            value = json.loads(Path(self._cache_path).read_text(encoding="utf-8"))
            if value.get("version") != _CACHE_VERSION or not isinstance(value.get("models"), list):
                return
            models = {model.model_id: model for model in map(_from_cache, value["models"]) if model is not None}
            self._models, self._fetched_at = models, float(value.get("fetchedAt", 0.0))
            self._priced_at = float(value.get("pricedAt", 0.0))
        except (OSError, TypeError, ValueError, AttributeError):
            return

    def _save_cache(self) -> None:
        if self._cache_path is None:
            return
        with self._lock:
            value = {"version": _CACHE_VERSION, "fetchedAt": self._fetched_at, "pricedAt": self._priced_at,
                     "models": [_to_cache(model) for model in self._models.values()]}
        path = Path(self._cache_path)
        temporary = path.with_name(path.name + ".tmp")
        try:
            temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, path)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def input_schema(openapi: Any, model_id: str) -> Mapping[str, Any] | None:
    """Pulls what `model_id` takes out of its OpenAPI document, with its references resolved one level down."""
    if not isinstance(openapi, Mapping) or not isinstance(openapi.get("paths"), Mapping):
        return None
    components = openapi.get("components")
    schemas = components.get("schemas") if isinstance(components, Mapping) else None
    schemas = schemas if isinstance(schemas, Mapping) else {}

    def resolve(node: Any, depth: int = 0) -> Any:
        while isinstance(node, Mapping) and isinstance(node.get("$ref"), str) and depth < 16:
            node = schemas.get(node["$ref"].rsplit("/", 1)[-1])
            depth += 1
        return node

    # Some endpoints are another's alias and document themselves under its name, so go by the one that takes a body.
    posts = {path: operations["post"] for path, operations in openapi["paths"].items()
             if isinstance(operations, Mapping) and isinstance(operations.get("post"), Mapping) and "requestBody" in operations["post"]}
    post = posts.get("/" + model_id) or next(iter(posts.values()), None)
    try:
        schema = resolve(post["requestBody"]["content"]["application/json"]["schema"])
    except (KeyError, TypeError):
        return None
    if not isinstance(schema, Mapping) or not isinstance(schema.get("properties"), Mapping):
        return None
    properties = {name: resolve(value) for name, value in schema["properties"].items()}
    return {"properties": properties, "required": [item for item in schema.get("required", ()) if isinstance(item, str)]}


_PROMPT_FIELDS = ("prompt", "instruction", "text_input", "text_prompt", "text_style_prompt")
_MESH_FIELDS = ("model_url", "mesh_url")
# Surface maps are the ones a material draws with; a model that offers more would only cost more.
_SURFACE_MAPS = ["normal", "roughness", "metalness"]
_IMAGE_FIELDS = ("image_url", "image_urls", "input_image_url", "input_image_urls", "images", "source_image_url",
                 "reference_image_url", "reference_image_urls", "start_image_url", "image")
_LARGEST_SIDE = 4096


def _allows(schema: Any, kind: str) -> bool:
    if not isinstance(schema, Mapping):
        return False
    if schema.get("type") == kind:
        return True
    return any(_allows(item, kind) for item in schema.get("anyOf", ()) if isinstance(item, Mapping))


def _allows_value(schema: Any, value: str) -> bool:
    if not isinstance(schema, Mapping):
        return False
    if value in (schema.get("enum") or ()):
        return True
    return any(_allows_value(item, value) for item in schema.get("anyOf", ()) if isinstance(item, Mapping))


def _allows_size_object(schema: Any) -> bool:
    if not isinstance(schema, Mapping):
        return False
    if "$ref" in schema:
        return str(schema["$ref"]).rsplit("/", 1)[-1] == "ImageSize"
    if isinstance(schema.get("properties"), Mapping) and {"width", "height"} <= set(schema["properties"]):
        return True
    return any(_allows_size_object(item) for item in schema.get("anyOf", ()) if isinstance(item, Mapping))


def _resolution_for(schema: Mapping[str, Any], longest_side: int) -> str | None:
    """The smallest of a model's named resolutions ("1K", "2k", "1.5k") that holds a picture of this size, or else its largest."""
    named: list[tuple[float, str]] = []
    options = [schema, *schema.get("anyOf", [])]
    for option in options:
        for value in option.get("enum", ()) if isinstance(option, Mapping) else ():
            match = re.fullmatch(r"(\d+(?:\.\d+)?)[kK]", str(value))
            if match:
                named.append((float(match.group(1)) * 1000, str(value)))
    if not named:
        return None
    named.sort()
    # "2K" is short of 2048 only by how it is named.
    return next((value for pixels, value in named if pixels >= longest_side * 0.9), named[-1][1])


def build_media_request(schema: Mapping[str, Any] | None, *, model: str, prompt: str, images: list[str],
                        size: tuple[int, int] | None = None, mesh: str | None = None) -> dict[str, Any]:
    """What to send a model, shaped by what it says it takes. One that takes more than we have is refused here."""
    if schema is None:
        request: dict[str, Any] = {"prompt": prompt}
        if images:
            request["image_url"] = images[0]
        return request
    properties = schema.get("properties", {})
    required = set(schema.get("required", ()))
    request = {}
    prompt_field = next((name for name in _PROMPT_FIELDS if name in properties), None)
    if prompt_field is not None and prompt:
        request[prompt_field] = prompt
    if images:
        image_field = next((name for name in _IMAGE_FIELDS if name in properties), None)
        if image_field is None:
            raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, f"{model} does not take an image", "fal")
        request[image_field] = images if _allows(properties[image_field], "array") else images[0]
    if mesh:
        mesh_field = next((name for name in _MESH_FIELDS if name in properties), None)
        if mesh_field is None:
            raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, f"{model} does not take a model", "fal")
        request[mesh_field] = mesh
        # What comes back has to fit the model as it stands, rig and all, and look lit.
        for name in ("enable_original_uv", "enable_pbr"):
            if name in properties:
                request[name] = True
    if "maps" in properties:
        request["maps"] = list(_SURFACE_MAPS)
    missing = sorted(name for name in required if name not in request)
    if missing:
        raise ProviderError(ErrorCode.INVALID_REQUEST, f"{model} also needs {', '.join(missing)[:200]}, which this tool does not supply", "fal")
    # One picture is what is asked for and paid for, whatever a model makes by default.
    for name in ("num_images", "max_images"):
        if name in properties:
            request[name] = 1
    # A texture map keeps its shape, or it stops lining up with the model; and a new one is square.
    if size is not None and "image_size" in properties and _allows_size_object(properties["image_size"]):
        request["image_size"] = {"width": min(size[0], _LARGEST_SIDE), "height": min(size[1], _LARGEST_SIDE)}
    elif not images and "image_size" in properties and _allows_value(properties["image_size"], "square_hd"):
        request["image_size"] = "square_hd"
    elif not images and "aspect_ratio" in properties and _allows_value(properties["aspect_ratio"], "1:1"):
        request["aspect_ratio"] = "1:1"
    if "output_format" in properties and _allows_value(properties["output_format"], "png"):
        request["output_format"] = "png"
    # A model's own defaults are mostly its least: a texture is worth its best.
    if size is not None and "resolution" in properties:
        resolution = _resolution_for(properties["resolution"], max(size))
        if resolution is not None:
            request["resolution"] = resolution
    for name in ("thinking_level", "quality"):
        if name in properties and _allows_value(properties[name], "high"):
            request[name] = "high"
    if "rendering_speed" in properties and _allows_value(properties["rendering_speed"], "QUALITY"):
        request["rendering_speed"] = "QUALITY"
    if size is not None and not images and "aspect_ratio" in properties:
        divisor = math.gcd(size[0], size[1])
        ratio = f"{size[0] // divisor}:{size[1] // divisor}"
        if _allows_value(properties["aspect_ratio"], ratio):
            request["aspect_ratio"] = ratio
    return request


def media_output_url(output: Mapping[str, Any]) -> tuple[str, str | None, dict[str, int] | None] | None:
    """The first picture in a model's result, whichever of the shapes it answers in."""
    candidates: list[Any] = []
    images = output.get("images")
    if isinstance(images, list):
        candidates.extend(images)
    candidates.extend(output.get(name) for name in ("image", "output", "result"))
    candidates.append(output)
    for item in candidates:
        if isinstance(item, Mapping) and isinstance(item.get("url"), str):
            width, height = item.get("width"), item.get("height")
            dimensions = {"width": width, "height": height} if isinstance(width, int) and isinstance(height, int) else None
            mime = item.get("content_type") or item.get("mime")
            return item["url"], mime if isinstance(mime, str) else None, dimensions
    return None


# What a sky is painted at: a panorama is twice as wide as it is tall. The largest that shape within the four megapixels
# the sky models paint at: asked for more, one changes the shape instead of refusing.
SKY_SIZE = (2816, 1408)
# What a new picture of a surface is painted at: the largest square within the same four megapixels.
NEW_TEXTURE_SIZE = (2000, 2000)

_MAP_ROLES = {"basecolor": "color", "base_color": "color", "albedo": "color", "normal": "normal", "roughness": "roughness",
              "metalness": "metalness", "metallic": "metalness"}


def media_outputs(output: Mapping[str, Any]) -> list[tuple[str, str, str | None, dict[str, int] | None]]:
    """Every map in a model's result, as (role, url, mime, dimensions), where a model makes several. Empty for one that makes one picture."""
    found: list[tuple[str, str, str | None, dict[str, int] | None]] = []
    textures = output.get("texture_urls")
    if isinstance(textures, list) and textures and isinstance(textures[0], Mapping):
        for name, role in _MAP_ROLES.items():
            item = textures[0].get(name)
            url = item.get("url") if isinstance(item, Mapping) else item
            if isinstance(url, str) and url and not any(entry[0] == role for entry in found):
                found.append((role, url, None, None))
        return found
    images = output.get("images")
    if isinstance(images, list) and any(isinstance(item, Mapping) and item.get("map_type") for item in images):
        for item in images:
            # Among labelled maps, a picture with no label is the texture they go with.
            role = (_MAP_ROLES.get(item["map_type"]) if item.get("map_type") else "color") if isinstance(item, Mapping) else None
            if role and isinstance(item.get("url"), str) and not any(entry[0] == role for entry in found):
                width, height = item.get("width"), item.get("height")
                mime = item.get("content_type")
                found.append((role, item["url"], mime if isinstance(mime, str) else None,
                              {"width": width, "height": height} if isinstance(width, int) and isinstance(height, int) else None))
    # The picture itself stands for the job.
    found.sort(key=lambda entry: entry[0] != "color")
    return found


# Used to weigh one model against another, not to bill: what a square 1024 texture comes to in each of fal's units.
_ROUGH_UNITS = {"megapixels": 1.05, "processed megapixels": 1.05, "compute seconds": 8.0, "seconds": 8.0}


def rough_job_cost(model: CatalogModel | None) -> int | None:
    """About what one job on `model` costs, in micro-USD, or None where the price is not known or runs by the token."""
    if model is None or model.price_micro_usd is None or model.category == "llm":
        return None
    return round(model.price_micro_usd * _ROUGH_UNITS.get(model.price_unit, 1.0))
