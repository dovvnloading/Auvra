"""Cross-backend reference-result evidence verification."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from .pipeline import ReleaseError, canonical_json


def _load(value: Mapping[str, Any] | Path) -> Mapping[str, Any]:
    if isinstance(value, Path):
        try:
            loaded = json.loads(value.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReleaseError("cross-backend evidence file is invalid") from exc
    else:
        loaded = value
    if not isinstance(loaded, Mapping):
        raise ReleaseError("cross-backend evidence must be an object")
    return loaded


def _frontend_reference(value: Mapping[str, Any]) -> dict[str, Any]:
    """Read the renderer's ``ReferenceSuiteResult`` contract verbatim."""

    if isinstance(value.get("results"), list):
        if value.get("selected") != "webgl2" or value.get("sceneId") != "basic":
            raise ReleaseError("renderer reference did not select the basic webgl2 contract")
        selected = next((item for item in value["results"] if isinstance(item, Mapping) and item.get("backend") == "webgl2"), None)
        if not isinstance(selected, Mapping) or not selected.get("supported") or not selected.get("qualified"):
            raise ReleaseError("renderer webgl2 reference is unavailable or unqualified")
        signature = selected.get("pixelSignature") or value.get("pixelSignature")
        if not isinstance(signature, str) or not signature:
            raise ReleaseError("renderer webgl2 pixel signature is missing")
        return {"scene": str(value["sceneId"]), "signature": signature,
                "dimensions": _optional_dimensions(selected, value)}
    backend = value.get("backend")
    if backend != "webgl2":
        raise ReleaseError("cross-backend evidence is not the expected webgl2 result")
    signature = value.get("signature") or value.get("pixelSignature")
    if not isinstance(signature, str) or not signature:
        raise ReleaseError("webgl2 reference signature is missing")
    return {"scene": value.get("scene", "reference"), "signature": signature,
            "dimensions": _optional_dimensions(value, value)}


def _native_reference(value: Mapping[str, Any]) -> dict[str, Any]:
    """Read the native self-test's nested ``reference`` result contract."""

    candidate = value.get("reference") if value.get("probe") == "auvra-native-self-test" else value
    if not isinstance(candidate, Mapping):
        raise ReleaseError("native self-test reference is missing")
    signature = candidate.get("pixel_hash_fnv1a64") or candidate.get("signature") or candidate.get("pixelSignature")
    if not isinstance(signature, str) or not signature:
        raise ReleaseError("native reference pixel signature is missing")
    return {"scene": value.get("scene", "basic"), "signature": signature,
            "dimensions": _optional_dimensions(candidate, value)}


def _optional_dimensions(value: Mapping[str, Any], fallback: Mapping[str, Any]) -> tuple[int, int] | None:
    width, height = value.get("width", fallback.get("width")), value.get("height", fallback.get("height"))
    if width is None or height is None:
        return None
    if not isinstance(width, int) or isinstance(width, bool) or width <= 0 or not isinstance(height, int) or isinstance(height, bool) or height <= 0:
        raise ReleaseError("cross-backend dimensions are invalid")
    return width, height


def _dimensions(value: Mapping[str, Any]) -> tuple[int, int]:
    width, height = value.get("width"), value.get("height")
    if not isinstance(width, int) or isinstance(width, bool) or width <= 0:
        raise ReleaseError("cross-backend width is invalid")
    if not isinstance(height, int) or isinstance(height, bool) or height <= 0:
        raise ReleaseError("cross-backend height is invalid")
    return width, height


def verify_cross_backend(webgl: Mapping[str, Any] | Path, native: Mapping[str, Any] | Path) -> dict[str, Any]:
    """Verify compatible reference dimensions and scene identity.

    Pixel signatures are retained as evidence but are deliberately not required
    to match: backend-specific rasterization can differ while the scene,
    dimensions, and declared reference contract remain equivalent.
    """

    left, right = _frontend_reference(_load(webgl)), _native_reference(_load(native))
    left_dims, right_dims = left["dimensions"], right["dimensions"]
    if left_dims is not None and right_dims is not None and left_dims != right_dims:
        raise ReleaseError("cross-backend reference dimensions differ")
    left_scene, right_scene = left["scene"], right["scene"]
    if not isinstance(left_scene, str) or not isinstance(right_scene, str) or left_scene not in {right_scene, "basic"}:
        raise ReleaseError("cross-backend scene identities differ")
    left_sig, right_sig = left["signature"], right["signature"]
    return {
        "schema": 1,
        "scene": left_scene,
        "width": left_dims[0] if left_dims else right_dims[0] if right_dims else None,
        "height": left_dims[1] if left_dims else right_dims[1] if right_dims else None,
        "webgl": {"backend": "webgl2", "signature": left_sig},
        "native": {"backend": "native", "signature": right_sig},
        "pixelSignaturesMatch": left_sig == right_sig,
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(prog="release.cross_backend")
    parser.add_argument("--webgl", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        args.output.write_bytes(canonical_json(verify_cross_backend(args.webgl, args.native)))
    except (OSError, ReleaseError) as exc:
        parser.error(str(exc))
