"""New-project templates.

``blank`` creates an empty project. ``starter`` adds a playable first level: rolling terrain, a
sky, a player start, a player character blueprint, scattered props and game settings, so a new
user can press Play immediately and learn by editing something that works.
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path
from typing import Any

from .assets import encode_heightfield
from .errors import InvalidProjectError

TEMPLATE_NAMES = ("blank", "starter")
_STARTER_ROOT = Path(__file__).resolve().parent / "templates" / "starter"

# Model id -> (asset file, display name, category, normalised size in world units).
_STARTER_MODELS = {
    "starter-model-character": ("character.fbx", "Character", "Character", 5.0),
    "starter-model-crate": ("crate.fbx", "Crate", "Prop", 2.5),
    "starter-model-rock": ("rock.fbx", "Rock", "Environment", 3.0),
    "starter-model-tree": ("tree.fbx", "Tree", "Environment", 9.0),
}

_TERRAIN_SAMPLES = 65  # (resolution + 1) per side
_TERRAIN_SIZE = 120.0


def _terrain_height(column: int, row: int) -> float:
    """Gentle hills that stay flat around the player start in the middle."""
    x = (column / (_TERRAIN_SAMPLES - 1) - 0.5) * _TERRAIN_SIZE
    z = (row / (_TERRAIN_SAMPLES - 1) - 0.5) * _TERRAIN_SIZE
    distance = math.hypot(x, z)
    falloff = min(1.0, max(0.0, (distance - 12.0) / 25.0))
    return falloff * (2.2 * math.sin(x / 9.0) * math.cos(z / 11.0) + 1.5 * math.sin((x + z) / 17.0))


def _object(object_id: str, level_id: str, name: str, kind: str, position: list[float], *,
            model_id: str = "", rotation_y: float = 0.0, scale: float = 1.0, **extra: Any) -> dict[str, Any]:
    document = {
        "id": object_id, "levelId": level_id, "modelId": model_id, "name": name, "type": kind,
        "position": position, "rotation": [0.0, rotation_y, 0.0], "scale": [scale, scale, scale],
    }
    document.update(extra)
    return document


def apply_template(repository: Any, template: str | None, *, project_name: str) -> None:
    """Populate a freshly created project. ``blank`` (or None) leaves it empty."""

    if template in (None, "blank"):
        return
    if template != "starter":
        raise InvalidProjectError(f"unknown project template: {template!r}")

    asset_ids: dict[str, str] = {}
    for model_id, (file_name, _, _, _) in _STARTER_MODELS.items():
        path = _STARTER_ROOT / "assets" / file_name
        with path.open("rb") as stream:
            asset_ids[model_id] = repository.assets.put_stream(
                stream, size=path.stat().st_size, mime="model/fbx", name=file_name,
            ).asset_id

    heights = [_terrain_height(column, row) for row in range(_TERRAIN_SAMPLES) for column in range(_TERRAIN_SAMPLES)]
    heightfield_bytes = encode_heightfield(heights, _TERRAIN_SAMPLES, _TERRAIN_SAMPLES)
    heightfield_id = repository.assets.put_stream(
        io.BytesIO(heightfield_bytes), size=len(heightfield_bytes),
        mime="application/vnd.auvra.heightfield", name="starter-terrain.ahf",
    ).asset_id

    level_id = "starter-level-1"
    player = json.loads((_STARTER_ROOT / "player_blueprint.json").read_text(encoding="utf-8"))

    objects = [
        _object("starter-terrain", level_id, "Terrain", "terrain", [0.0, 0.0, 0.0], terrainData={
            "resolution": _TERRAIN_SAMPLES - 1, "width": _TERRAIN_SIZE, "depth": _TERRAIN_SIZE,
            "heightfield": {"assetId": heightfield_id, "encoding": "float32le",
                            "columns": _TERRAIN_SAMPLES, "rows": _TERRAIN_SAMPLES},
        }),
        _object("starter-sky", level_id, "Sky", "sky_sphere", [0.0, 0.0, 0.0]),
        _object("starter-player-start", level_id, "Player Start", "player_start", [0.0, 0.0, 6.0]),
    ]
    # A loose ring of props around the start so there is something to walk to and edit.
    props = [
        ("crate", "starter-model-crate", [6.0, 0.0, -4.0], 0.3), ("crate", "starter-model-crate", [7.5, 0.0, -2.5], 1.1),
        ("crate", "starter-model-crate", [-6.0, 0.0, -6.0], 0.0), ("rock", "starter-model-rock", [-10.0, 0.0, 2.0], 0.8),
        ("rock", "starter-model-rock", [12.0, 0.0, 8.0], 2.4), ("rock", "starter-model-rock", [3.0, 0.0, -14.0], 1.7),
    ]
    for index, (label, model_id, position, rotation) in enumerate(props):
        objects.append(_object(f"starter-{label}-{index}", level_id, f"{label.title()} {index + 1}", "prop", position,
                               model_id=model_id, rotation_y=rotation))
    for index in range(10):
        angle = index * 2 * math.pi / 10 + 0.4
        radius = 22.0 + 6.0 * math.sin(index * 1.7)
        objects.append(_object(f"starter-tree-{index}", level_id, f"Tree {index + 1}", "prop",
                               [round(radius * math.cos(angle), 2), 0.0, round(radius * math.sin(angle), 2)],
                               model_id="starter-model-tree", rotation_y=round(angle, 3)))

    begin_play = {
        "nodes": [
            {"id": "starter-begin", "type": "Event", "name": "Event BeginPlay", "position": {"x": 80, "y": 120},
             "inputs": [], "outputs": [{"id": "starter-begin-out", "name": "Out", "dataType": "Exec", "direction": "Output"}]},
            {"id": "starter-print", "type": "PrintString", "name": "Print String", "position": {"x": 360, "y": 120},
             "inputs": [{"id": "starter-print-in", "name": "In", "dataType": "Exec", "direction": "Input"}],
             "outputs": [{"id": "starter-print-out", "name": "Out", "dataType": "Exec", "direction": "Output"}],
             "data": {"printMessage": "Welcome! Edit this level in the World Editor, then press Build Web to ship it."}},
        ],
        "connections": [{"id": "starter-wire", "fromNodeId": "starter-begin", "fromPinId": "starter-begin-out",
                         "toNodeId": "starter-print", "toPinId": "starter-print-in"}],
        "variables": [],
    }

    changes = {
        "models": [
            {"id": model_id, "name": name, "category": category, "assetId": asset_ids[model_id],
             "isPlacedInScene": False, "importSettings": {"normalize": True, "targetSize": size}}
            for model_id, (_, name, category, size) in _STARTER_MODELS.items()
        ],
        "blueprints": [player],
        "levels": [{"id": level_id, "name": "Level 1", "createdAt": 0, "blueprint": begin_play}],
        "objects": objects,
        "metadata": [{"id": "game-settings", "settings": {
            "schema": 1, "name": project_name, "startupLevelId": level_id, "playerBlueprintId": player["id"],
        }}],
    }
    repository.apply_changes(changes, expected_revision=repository.revision)
