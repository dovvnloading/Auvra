"""New-project templates.

``blank`` creates an empty project. ``starter`` adds a playable first level: rolling terrain, a
sky, a player start, a player character blueprint, scattered props and game settings, so a new
user can press Play immediately and learn by editing something that works.

``arena`` ("Arena Sample") is a small complete game to learn from. Level 1 is a walled arena:
collect every spinning coin while red guards from a spawner hunt you (rigged and animated, a shot
guard falls as a ragdoll; tools/arena_enemy_model.py builds the model), then travel to the Finish level. It shows solid and trigger colliders, dynamic rigid bodies, rotator, mover, particle and
light components, a level blueprint that keeps score in a level variable, plays a sound and
changes level, an enemy blueprint, a HUD bound to the score and authored title and pause menus.

``outpost`` ("Outpost Sample") is built on the whole kit with characters and scenery made for it
(tools/outpost_character_model.py, tools/outpost_props_model.py), so it can be shared: an intro
camera cut, a Scout who waves and talks, three supply caches whose scripts count into a level
variable, raider spawners, a timeline that opens the gate and lights the beacon, an autosave, and a
player graph with a nested Locomotion state machine, sync groups, a landing curve, upper-body aim
and fire clips and an additive hit reaction.
"""

from __future__ import annotations

import io
import json
import math
import wave
from pathlib import Path
from typing import Any, Iterable

from .assets import encode_heightfield
from .errors import InvalidProjectError

TEMPLATE_NAMES = ("blank", "starter", "arena", "courtyard", "outpost")
_TEMPLATES_ROOT = Path(__file__).resolve().parent / "templates"
_STARTER_ROOT = _TEMPLATES_ROOT / "starter"
_ARENA_ROOT = _TEMPLATES_ROOT / "arena"

FBX_MIME = "model/fbx"
WAV_MIME = "audio/wav"
HEIGHTFIELD_MIME = "application/vnd.auvra.heightfield"

# Model id -> (asset file, display name, category, normalised size in world units).
_STARTER_MODELS = {
    "starter-model-character": ("character.fbx", "Character", "Character", 5.0),
    "starter-model-crate": ("crate.fbx", "Crate", "Prop", 2.5),
    "starter-model-rock": ("rock.fbx", "Rock", "Environment", 3.0),
    "starter-model-tree": ("tree.fbx", "Tree", "Environment", 9.0),
}

_TERRAIN_SAMPLES = 65  # (resolution + 1) per side
_TERRAIN_SIZE = 120.0
_STARTER_FLAT_RADIUS = 12.0


def _hills(x: float, z: float, flat_radius: float) -> float:
    """Gentle hills that stay flat within ``flat_radius`` of the middle."""
    distance = math.hypot(x, z)
    falloff = min(1.0, max(0.0, (distance - flat_radius) / 25.0))
    return falloff * (2.2 * math.sin(x / 9.0) * math.cos(z / 11.0) + 1.5 * math.sin((x + z) / 17.0))


def _terrain_height(column: int, row: int, flat_radius: float = _STARTER_FLAT_RADIUS) -> float:
    """Height of one heightfield sample: row 0 is the -Z edge, column 0 the -X edge."""
    x = (column / (_TERRAIN_SAMPLES - 1) - 0.5) * _TERRAIN_SIZE
    z = (row / (_TERRAIN_SAMPLES - 1) - 0.5) * _TERRAIN_SIZE
    return _hills(x, z, flat_radius)


def _ground_y(x: float, z: float, flat_radius: float = _STARTER_FLAT_RADIUS, sink: float = 0.1) -> float:
    """Where a prop's base goes at world (x, z): on the hills, sunk ``sink`` into slopes so no gap shows under it.

    Nothing snaps props to the terrain, and normalised models stand on y=0, so a prop's y is its base height.
    """
    if math.hypot(x, z) <= flat_radius:
        return 0.0
    return round(_hills(x, z, flat_radius) - sink, 2)


# The sky the editor's Add Sky Sphere creates (EnvironmentSidebar): without a skyConfig the sky inspector hides
# every control and the runtime falls back to a config with near-black fog.
_SKY_CONFIG = {
    "timeOfDay": 14.0, "sunIntensity": 1.5, "ambienceIntensity": 0.5, "sunColor": "#ffffff",
    "fogColor": "#8caebf", "fogDensity": 0.02, "turbidity": 8.0, "rayleigh": 1.0,
    "mieCoefficient": 0.005, "mieDirectionalG": 0.7, "inclination": 0.49, "azimuth": 0.25,
}


def _sky_object(object_id: str, level_id: str) -> dict[str, Any]:
    # Raised like the editor's, so its icon is not buried in the ground.
    return _object(object_id, level_id, "Sky", "sky_sphere", [0.0, 5.0, 0.0], skyConfig=dict(_SKY_CONFIG))


def _object(object_id: str, level_id: str, name: str, kind: str, position: list[float], *,
            model_id: str = "", rotation_y: float = 0.0, scale: float = 1.0, **extra: Any) -> dict[str, Any]:
    document = {
        "id": object_id, "levelId": level_id, "modelId": model_id, "name": name, "type": kind,
        "position": position, "rotation": [0.0, rotation_y, 0.0], "scale": [scale, scale, scale],
    }
    document.update(extra)
    return document


def _store_file(repository: Any, path: Path, mime: str) -> str:
    with path.open("rb") as stream:
        return repository.assets.put_stream(stream, size=path.stat().st_size, mime=mime, name=path.name).asset_id


def _store_heightfield(repository: Any, heights: list[float], samples: int, name: str) -> str:
    data = encode_heightfield(heights, samples, samples)
    return repository.assets.put_stream(io.BytesIO(data), size=len(data), mime=HEIGHTFIELD_MIME, name=name).asset_id


def _terrain_object(object_id: str, level_id: str, heightfield_id: str, samples: int, size: float) -> dict[str, Any]:
    return _object(object_id, level_id, "Terrain", "terrain", [0.0, 0.0, 0.0], terrainData={
        "resolution": samples - 1, "width": size, "depth": size,
        "heightfield": {"assetId": heightfield_id, "encoding": "float32le", "columns": samples, "rows": samples},
    })


def _model_document(model_id: str, asset_id: str, name: str, category: str, size: float) -> dict[str, Any]:
    return {"id": model_id, "name": name, "category": category, "assetId": asset_id,
            "isPlacedInScene": False, "importSettings": {"normalize": True, "targetSize": size}}


def apply_template(repository: Any, template: str | None, *, project_name: str) -> None:
    """Populate a freshly created project. ``blank`` (or None) leaves it empty."""

    if template in (None, "blank"):
        return
    builder = _BUILDERS.get(template) if isinstance(template, str) else None
    if builder is None:
        raise InvalidProjectError(f"unknown project template: {template!r}")
    builder(repository, project_name)


# --- starter --------------------------------------------------------------------------------

def _apply_starter(repository: Any, project_name: str) -> None:
    asset_ids = {model_id: _store_file(repository, _STARTER_ROOT / "assets" / file_name, FBX_MIME)
                 for model_id, (file_name, _, _, _) in _STARTER_MODELS.items()}

    heights = [_terrain_height(column, row) for row in range(_TERRAIN_SAMPLES) for column in range(_TERRAIN_SAMPLES)]
    heightfield_id = _store_heightfield(repository, heights, _TERRAIN_SAMPLES, "starter-terrain.ahf")

    level_id = "starter-level-1"
    player = json.loads((_STARTER_ROOT / "player_blueprint.json").read_text(encoding="utf-8"))

    objects = [
        _terrain_object("starter-terrain", level_id, heightfield_id, _TERRAIN_SAMPLES, _TERRAIN_SIZE),
        _sky_object("starter-sky", level_id),
        _object("starter-player-start", level_id, "Player Start", "player_start", [0.0, 0.0, 6.0]),
    ]
    # A loose ring of props around the start so there is something to walk to and edit.
    props = [
        ("crate", "starter-model-crate", [6.0, 0.0, -4.0], 0.3), ("crate", "starter-model-crate", [7.5, 0.0, -2.5], 1.1),
        ("crate", "starter-model-crate", [-6.0, 0.0, -6.0], 0.0), ("rock", "starter-model-rock", [-10.0, 0.0, 2.0], 0.8),
        ("rock", "starter-model-rock", [12.0, 0.0, 8.0], 2.4), ("rock", "starter-model-rock", [3.0, 0.0, -14.0], 1.7),
    ]
    for index, (label, model_id, (x, _, z), rotation) in enumerate(props):
        objects.append(_object(f"starter-{label}-{index}", level_id, f"{label.title()} {index + 1}", "prop",
                               [x, _ground_y(x, z), z], model_id=model_id, rotation_y=rotation))
    for index in range(10):
        angle = index * 2 * math.pi / 10 + 0.4
        radius = 22.0 + 6.0 * math.sin(index * 1.7)
        x, z = round(radius * math.cos(angle), 2), round(radius * math.sin(angle), 2)
        objects.append(_object(f"starter-tree-{index}", level_id, f"Tree {index + 1}", "prop",
                               [x, _ground_y(x, z), z], model_id="starter-model-tree", rotation_y=round(angle, 3)))

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
        "models": [_model_document(model_id, asset_ids[model_id], name, category, size)
                   for model_id, (_, name, category, size) in _STARTER_MODELS.items()],
        "blueprints": [player],
        "levels": [{"id": level_id, "name": "Level 1", "createdAt": 0, "blueprint": begin_play}],
        "objects": objects,
        "metadata": [{"id": "game-settings", "settings": {
            "schema": 1, "name": project_name, "startupLevelId": level_id, "playerBlueprintId": player["id"],
        }}],
    }
    repository.apply_changes(changes, expected_revision=repository.revision)


# --- level blueprint graphs -----------------------------------------------------------------

def _pin_slug(name: str) -> str:
    return name.lower().replace(" ", "-")


class _LogicGraph:
    """Builds a level blueprint with readable, stable ids, in the pin shapes the editor palette places.

    Pins are ``{id, name, dataType, direction}``; an unwired data input reads ``data['default_<pin>']``.
    Every input takes at most one wire (the editor's rule); an output may feed many inputs.
    """

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self.nodes: list[dict[str, Any]] = []
        self.connections: list[dict[str, Any]] = []
        self._by_id: dict[str, dict[str, Any]] = {}

    def add(self, key: str, kind: str, name: str, at: tuple[int, int], *,
            inputs: Iterable[tuple[str, str]] = (), outputs: Iterable[tuple[str, str]] = (),
            data: dict[str, Any] | None = None) -> str:
        node_id = f"{self.prefix}-{key}"
        node: dict[str, Any] = {
            "id": node_id, "type": kind, "name": name, "position": {"x": at[0], "y": at[1]},
            "inputs": [{"id": f"{node_id}-in-{_pin_slug(pin)}", "name": pin, "dataType": data_type, "direction": "Input"}
                       for pin, data_type in inputs],
            "outputs": [{"id": f"{node_id}-out-{_pin_slug(pin)}", "name": pin, "dataType": data_type, "direction": "Output"}
                        for pin, data_type in outputs],
        }
        if data:
            node["data"] = data
        self.nodes.append(node)
        self._by_id[node_id] = node
        return node_id

    def wire(self, source: str, output: str, target: str, input: str) -> None:
        from_pin = next(pin["id"] for pin in self._by_id[source]["outputs"] if pin["name"] == output)
        to_pin = next(pin["id"] for pin in self._by_id[target]["inputs"] if pin["name"] == input)
        if any(connection["toPinId"] == to_pin for connection in self.connections):
            raise ValueError(f"{target}.{input} already has a wire")
        self.connections.append({"id": f"{from_pin}--{to_pin}", "fromNodeId": source, "fromPinId": from_pin,
                                 "toNodeId": target, "toPinId": to_pin})

    def chain(self, *steps: tuple[str, str, str]) -> None:
        """Wires exec flow through ``(node, input pin, output pin)`` steps in order."""
        for (source, _, output), (target, input, _) in zip(steps, steps[1:]):
            self.wire(source, output, target, input)

    def document(self, variables: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        return {"nodes": self.nodes, "connections": self.connections, "variables": variables or []}

    # Built-in nodes (hooks/useLevelBlueprintRuntime.ts), shaped like LevelBlueprintEditor's palette.

    def begin_play(self, key: str, at: tuple[int, int]) -> str:
        return self.add(key, "Event", "Event BeginPlay", at, outputs=[("Exec", "Exec")])

    def tick(self, key: str, at: tuple[int, int]) -> str:
        return self.add(key, "Event", "Event Tick", at, outputs=[("Exec", "Exec"), ("Delta Seconds", "Float")])

    def overlap(self, key: str, actor: dict[str, Any], at: tuple[int, int]) -> str:
        return self.add(key, "Event", f"On Overlap ({actor['name']})", at,
                        outputs=[("Exec", "Exec"), ("Other Actor", "Object")], data={"targetActorId": actor["id"]})

    def print_string(self, key: str, message: str, at: tuple[int, int]) -> str:
        return self.add(key, "PrintString", "Print String", at, inputs=[("Exec", "Exec"), ("String", "String")],
                        outputs=[("Out", "Exec")], data={"printMessage": message, "default_String": message})

    def destroy_actor(self, key: str, at: tuple[int, int]) -> str:
        return self.add(key, "DestroyActor", "Destroy Actor", at, inputs=[("Exec", "Exec")], outputs=[("Out", "Exec")])

    def level_action(self, key: str, name: str, at: tuple[int, int], **data: Any) -> str:
        return self.add(key, "LevelAction", name, at, inputs=[("Exec", "Exec")], outputs=[("Out", "Exec")], data=data)

    def branch(self, key: str, at: tuple[int, int]) -> str:
        return self.add(key, "Branch", "Branch (If)", at, inputs=[("Exec", "Exec"), ("Condition", "Boolean")],
                        outputs=[("True", "Exec"), ("False", "Exec")])

    def player_variable(self, key: str, variable: str, data_type: str, at: tuple[int, int]) -> str:
        return self.add(key, "VariableGet", f"Get {variable}", at, outputs=[("Value", data_type)],
                        data={"variableName": variable, "targetBlueprintType": "Player"})

    def pure_math(self, key: str, kind: str, name: str, at: tuple[int, int], result: str, **defaults: Any) -> str:
        # Pure: no exec pins. The runtime reads a math node's first two inputs as A and B.
        return self.add(key, kind, name, at, inputs=[("A", "Float"), ("B", "Float")], outputs=[("Result", result)],
                        data={f"default_{pin}": value for pin, value in defaults.items()})

    # Flow and world nodes (hooks/levelBlueprintNodes/flow.ts, world.ts), with their declared pins.

    def sequence(self, key: str, at: tuple[int, int]) -> str:
        return self.add(key, "Sequence", "Sequence", at, inputs=[("Exec", "Exec")],
                        outputs=[("Then 0", "Exec"), ("Then 1", "Exec")])

    def do_once(self, key: str, at: tuple[int, int]) -> str:
        return self.add(key, "DoOnce", "Do Once", at,
                        inputs=[("Exec", "Exec"), ("Reset", "Exec"), ("Start Closed", "Boolean")],
                        outputs=[("Completed", "Exec")], data={"default_Start Closed": False})

    def delay(self, key: str, seconds: float, at: tuple[int, int]) -> str:
        return self.add(key, "Delay", "Delay", at, inputs=[("Exec", "Exec"), ("Duration", "Float")],
                        outputs=[("Out", "Exec")], data={"default_Duration": seconds})

    def get_level_variable(self, key: str, variable: str, at: tuple[int, int]) -> str:
        return self.add(key, "GetLevelVariable", f"Get Level Variable ({variable})", at, inputs=[("Name", "String")],
                        outputs=[("Value", "String"), ("Is Set", "Boolean")], data={"default_Name": variable})

    def set_level_variable(self, key: str, variable: str, at: tuple[int, int], value: str = "") -> str:
        """``value`` is what an unwired Value input writes."""
        return self.add(key, "SetLevelVariable", f"Set Level Variable ({variable})", at,
                        inputs=[("Exec", "Exec"), ("Name", "String"), ("Value", "String")],
                        outputs=[("Out", "Exec"), ("Success", "Boolean")],
                        data={"default_Name": variable, "default_Value": value})

    def play_sound(self, key: str, audio_id: str, at: tuple[int, int]) -> str:
        return self.add(key, "PlaySound", "Play Sound", at, inputs=[("Exec", "Exec"), ("Sound", "String"), ("Bus", "String")],
                        outputs=[("Out", "Exec")], data={"default_Sound": audio_id, "default_Bus": "sfx"})

    def print_format(self, key: str, format_text: str, at: tuple[int, int]) -> str:
        return self.add(key, "Print", "Print (Format)", at,
                        inputs=[("Exec", "Exec"), ("Format", "String"), ("Arg 0", "String"), ("Arg 1", "String"), ("Arg 2", "String")],
                        outputs=[("Out", "Exec"), ("Message", "String")], data={"default_Format": format_text})


# --- arena ----------------------------------------------------------------------------------

_ARENA_LEVEL_ID = "arena-level-1"
_FINISH_LEVEL_ID = "arena-level-2"
_ARENA_PLAYER_ID = "arena-player"
_ARENA_ENEMY_ID = "arena-enemy"
_COIN_SOUND_ID = "arena-sound-coin"
_SCORE_VARIABLE = "score"
_ARENA_FLAT_RADIUS = 26.0
_CRATE_SIZE = 2.5  # the crate model is a unit cube on its base, normalised to this size
_COIN_SIZE = 1.5   # an upright disc on its rim, normalised to this height

_ARENA_MODELS = {
    "arena-model-character": (_STARTER_ROOT / "assets" / "character.fbx", "Character", "Character", 5.0),
    "arena-model-enemy": (_ARENA_ROOT / "assets" / "enemy.fbx", "Guard", "Character", 5.0),
    "arena-model-crate": (_STARTER_ROOT / "assets" / "crate.fbx", "Crate", "Prop", _CRATE_SIZE),
    "arena-model-coin": (_ARENA_ROOT / "assets" / "coin.fbx", "Coin", "Prop", _COIN_SIZE),
    "arena-model-rock": (_STARTER_ROOT / "assets" / "rock.fbx", "Rock", "Environment", 3.0),
    "arena-model-tree": (_STARTER_ROOT / "assets" / "tree.fbx", "Tree", "Environment", 9.0),
}

# Coin (x, z) positions inside the cover ring; the last one waits beyond it, by the guard spawner.
_COIN_POSITIONS = ((8.5, -3.0), (-8.0, 5.0), (-3.0, -9.0), (0.0, -19.0))
_COVER_CRATES = 12
_COVER_RADIUS = 13.0
_PUSHABLE_CRATES = ((4.5, 2.0, 0.4), (-4.5, 0.5, 1.2), (1.5, -5.5, 2.0))


def _component(owner_id: str, kind: str, suffix: str = "", **props: Any) -> dict[str, Any]:
    return {"id": f"{owner_id}-{suffix or kind}", "type": kind, "enabled": True, "props": props}


def _crate_collider(owner_id: str) -> dict[str, Any]:
    half = _CRATE_SIZE / 2
    return _component(owner_id, "collider", shape="box", size=[_CRATE_SIZE] * 3, offset=[0.0, half, 0.0], isTrigger=False)


def _coin_components(owner_id: str) -> list[dict[str, Any]]:
    return [
        _component(owner_id, "collider", "trigger", shape="sphere", radius=1.3, offset=[0.0, _COIN_SIZE / 2, 0.0],
                   isTrigger=True),
        _component(owner_id, "rotator", axis="y", speed=120),
        _component(owner_id, "mover", offset=[0.0, 0.5, 0.0], period=2.4, pingPong=True),
        _component(owner_id, "particles", preset="sparks", rate=6, burst=0, loop=True),
    ]


def _bowl_height(x: float, z: float) -> float:
    """The finish level's ground: flat in the middle, rising gently to a rim."""
    return 3.0 * min(1.0, max(0.0, (math.hypot(x, z) - 12.0) / 12.0)) ** 2


def _arena_objects(heightfield_id: str) -> list[dict[str, Any]]:
    level = _ARENA_LEVEL_ID
    objects = [
        _terrain_object("arena-terrain", level, heightfield_id, _TERRAIN_SAMPLES, _TERRAIN_SIZE),
        _sky_object("arena-sky", level),
        _object("arena-player-start", level, "Player Start", "player_start", [0.0, 0.0, 6.0]),
    ]
    # Cover: a ring of solid crates (a collider without a rigid body is fixed scenery) with gaps to run through.
    for index in range(_COVER_CRATES):
        angle = (index + 0.5) * 2 * math.pi / _COVER_CRATES
        object_id = f"arena-cover-{index + 1}"
        objects.append(_object(object_id, level, f"Cover Crate {index + 1}", "prop",
                               [round(_COVER_RADIUS * math.cos(angle), 2), 0.0, round(_COVER_RADIUS * math.sin(angle), 2)],
                               model_id="arena-model-crate", rotation_y=round(-angle, 3),
                               components=[_crate_collider(object_id)]))
    # Dynamic rigid bodies: the player shoves these around.
    for index, (x, z, rotation) in enumerate(_PUSHABLE_CRATES):
        object_id = f"arena-pushable-{index + 1}"
        objects.append(_object(object_id, level, f"Pushable Crate {index + 1}", "prop", [x, 0.0, z],
                               model_id="arena-model-crate", rotation_y=rotation, components=[
                                   _component(object_id, "rigidBody", type="dynamic", mass=12, gravityScale=1,
                                              lockRotation=False),
                                   _crate_collider(object_id),
                               ]))
    # Pickups: a trigger collider reports the player to the level blueprint, which counts and removes the coin.
    for index, (x, z) in enumerate(_COIN_POSITIONS):
        object_id = f"arena-coin-{index + 1}"
        objects.append(_object(object_id, level, f"Coin {index + 1}", "prop", [x, 0.6, z],
                               model_id="arena-model-coin", components=_coin_components(object_id)))
    objects.append(_object("arena-guard-spawner", level, "Guard Spawner", "spawn_point", [0.0, 0.0, -24.0],
                           spawnConfig={"blueprintId": _ARENA_ENEMY_ID, "interval": 8, "maxSpawns": 2, "team": "Enemy"}))
    for index, (x, z, rotation) in enumerate(((-17.0, 9.0, 0.8), (18.0, -6.0, 2.4), (10.0, 17.0, 1.7), (-15.0, -15.0, 0.3))):
        objects.append(_object(f"arena-rock-{index + 1}", level, f"Rock {index + 1}", "prop", [x, 0.0, z],
                               model_id="arena-model-rock", rotation_y=rotation))
    for index in range(12):
        angle = index * 2 * math.pi / 12 + 0.25
        radius = 36.0 + 4.0 * math.sin(index * 1.3)
        x, z = round(radius * math.cos(angle), 2), round(radius * math.sin(angle), 2)
        # Out on the hills: sit each trunk slightly into the slope.
        objects.append(_object(f"arena-tree-{index + 1}", level, f"Tree {index + 1}", "prop",
                               [x, round(_hills(x, z, _ARENA_FLAT_RADIUS) - 0.3, 2), z],
                               model_id="arena-model-tree", rotation_y=round(angle, 3)))
    return objects


def _finish_objects(heightfield_id: str, samples: int, size: float) -> list[dict[str, Any]]:
    level = _FINISH_LEVEL_ID
    objects = [
        _terrain_object("finish-terrain", level, heightfield_id, samples, size),
        _sky_object("finish-sky", level),
        _object("finish-player-start", level, "Player Start", "player_start", [0.0, 0.0, 8.0]),
        _object("finish-podium", level, "Podium", "prop", [0.0, 0.0, -3.0], model_id="arena-model-crate",
                components=[_crate_collider("finish-podium")]),
        _object("finish-trophy", level, "Trophy Coin", "prop", [0.0, _CRATE_SIZE + 0.2, -3.0], model_id="arena-model-coin",
                scale=1.6, components=[
                    _component("finish-trophy", "rotator", axis="y", speed=60),
                    _component("finish-trophy", "particles", preset="sparks", rate=16, burst=0, loop=True),
                    _component("finish-trophy", "pointLight", color="#ffd27a", intensity=30, distance=14, castShadow=False),
                ]),
    ]
    for index in range(6):
        angle = index * 2 * math.pi / 6 + 0.5
        x, z = round(17.0 * math.cos(angle), 2), round(17.0 * math.sin(angle), 2)
        objects.append(_object(f"finish-tree-{index + 1}", level, f"Tree {index + 1}", "prop",
                               [x, round(_bowl_height(x, z) - 0.3, 2), z], model_id="arena-model-tree",
                               rotation_y=round(angle, 3)))
    return objects


def _arena_logic(coins: list[dict[str, Any]]) -> dict[str, Any]:
    """Level 1: each coin overlap adds one to ``score``, plays a chime, removes the coin and prints the
    tally; every frame a Sequence checks for all coins (then travels to the finish) and for a dead player."""

    graph = _LogicGraph("arena-logic")
    begin = graph.begin_play("begin", (80, 40))
    hint = graph.print_string("hint", f"Collect all {len(coins)} coins. Watch out for the red guards!", (380, 40))
    graph.chain((begin, "", "Exec"), (hint, "Exec", "Out"))

    shared_y = 220 + len(coins) * 180
    score = graph.get_level_variable("get-score", _SCORE_VARIABLE, (80, shared_y))
    plus_one = graph.pure_math("score-plus-one", "Add", "Add (+)", (400, shared_y), "Float", B=1)
    graph.wire(score, "Value", plus_one, "A")

    for index, coin in enumerate(coins):
        row = 220 + index * 180
        key = f"coin-{index + 1}"
        overlap = graph.overlap(f"{key}-overlap", coin, (80, row))
        add_one = graph.set_level_variable(f"{key}-add", _SCORE_VARIABLE, (400, row))
        chime = graph.play_sound(f"{key}-chime", _COIN_SOUND_ID, (720, row))
        remove = graph.destroy_actor(f"{key}-destroy", (1020, row))
        tally = graph.print_format(f"{key}-tally", f"Coins: {{0}} / {len(coins)}", (1280, row))
        graph.wire(plus_one, "Result", add_one, "Value")
        graph.wire(score, "Value", tally, "Arg 0")
        # Destroy Actor removes the actor the overlap event fired for: this coin.
        graph.chain((overlap, "", "Exec"), (add_one, "Exec", "Out"), (chime, "Exec", "Out"),
                    (remove, "Exec", "Out"), (tally, "Exec", "Out"))

    checks_y = shared_y + 200
    tick = graph.tick("tick", (80, checks_y))
    checks = graph.sequence("checks", (340, checks_y))
    graph.chain((tick, "", "Exec"), (checks, "Exec", ""))

    all_collected = graph.pure_math("all-collected", "Equal", "Equal (==)", (340, checks_y + 200), "Boolean", B=len(coins))
    graph.wire(score, "Value", all_collected, "A")
    won = graph.branch("if-all-collected", (620, checks_y))
    once = graph.do_once("finish-once", (880, checks_y))
    cheer = graph.print_string("level-complete", "Level complete! Every coin collected.", (1140, checks_y))
    pause = graph.delay("before-travel", 2.0, (1400, checks_y))
    travel = graph.level_action("open-finish", "Open Level (Finish)", (1660, checks_y),
                                action="OpenLevel", levelId=_FINISH_LEVEL_ID)
    graph.wire(checks, "Then 0", won, "Exec")
    graph.wire(all_collected, "Result", won, "Condition")
    graph.wire(won, "True", once, "Exec")
    graph.chain((once, "", "Completed"), (cheer, "Exec", "Out"), (pause, "Exec", "Out"), (travel, "Exec", ""))

    dead = graph.player_variable("player-is-dead", "IsDead", "Boolean", (340, checks_y + 380))
    caught = graph.branch("if-player-dead", (620, checks_y + 340))
    restart = graph.level_action("restart", "Restart Level", (880, checks_y + 340), action="Restart")
    graph.wire(checks, "Then 1", caught, "Exec")
    graph.wire(dead, "Value", caught, "Condition")
    graph.wire(caught, "True", restart, "Exec")

    return graph.document([{"id": "arena-variable-score", "name": _SCORE_VARIABLE, "type": "Float", "value": 0}])


def _finish_logic() -> dict[str, Any]:
    graph = _LogicGraph("finish-logic")
    begin = graph.begin_play("begin", (80, 120))
    welcome = graph.print_string("welcome", "You made it to the finish! Thanks for playing the Arena sample.", (380, 120))
    pause = graph.delay("pause", 4.0, (680, 120))
    explore = graph.print_string("explore", "Open the Level Blueprint of the Arena level to see how this game works.",
                                 (940, 120))
    graph.chain((begin, "", "Exec"), (welcome, "Exec", "Out"), (pause, "Exec", "Out"), (explore, "Exec", ""))
    return graph.document()


# HUD documents live on a 1920x1080 stage (HUD_REFERENCE_SIZE in fbx-viewer (1)/components/HUDEditor/types.ts).
_HUD_STAGE = {"width": 1920, "height": 1080}
_MENU_BUTTON = (420, 72)
_MENU_BUTTON_GAP = 20


def _hud_element(element_id: str, name: str, kind: str, props: dict[str, Any], x: float, y: float,
                 width: float, height: float, z_index: int, *, locked: bool = False) -> dict[str, Any]:
    return {"id": element_id, "name": name, "type": kind, "props": props, "position": {"x": x, "y": y},
            "size": {"width": width, "height": height}, "zIndex": z_index, "isVisible": True, "isLocked": locked}


def _hud_text(element_id: str, name: str, text: str, x: float, y: float, width: float, height: float, *,
              size: int, color: str = "#ffffff", weight: str = "bold", align: str = "left",
              bind: dict[str, str] | None = None) -> dict[str, Any]:
    props: dict[str, Any] = {"text": text, "textKey": "", "color": color, "fontSize": size, "fontWeight": weight,
                             "fontFamily": "sans-serif", "textAlign": align}
    if bind:
        props["bind"] = bind
    return _hud_element(element_id, name, "Text", props, x, y, width, height, 2)


def _hud_document(document_id: str, name: str, elements: list[dict[str, Any]]) -> dict[str, Any]:
    return {"id": document_id, "name": name, "elements": elements, "layout": dict(_HUD_STAGE), "commands": []}


def _menu(document_id: str, name: str, title: str, subtitle: str, top: int,
          buttons: list[tuple[str, str, str]]) -> dict[str, Any]:
    """A full-screen backdrop, a title and a centred column of Button elements (``props.action`` runs them)."""

    stage_width, stage_height = _HUD_STAGE["width"], _HUD_STAGE["height"]
    width, height = _MENU_BUTTON
    elements = [
        # Locked so clicks on the backdrop never drag it in the editor; unlock it from Layers.
        _hud_element(f"{document_id}-backdrop", "Backdrop", "Container",
                     {"backgroundColor": "rgba(8,12,24,0.78)", "borderColor": "transparent", "borderWidth": 0,
                      "borderRadius": 0}, 0, 0, stage_width, stage_height, 1, locked=True),
        _hud_text(f"{document_id}-title", "Title", title, (stage_width - 1200) / 2, top - 180, 1200, 120,
                  size=96, color="#ffd75a", align="center"),
        _hud_text(f"{document_id}-subtitle", "Subtitle", subtitle, (stage_width - 1200) / 2, top - 70, 1200, 44,
                  size=28, color="rgba(255,255,255,0.8)", weight="normal", align="center"),
    ]
    for index, (action, label, variant) in enumerate(buttons):
        elements.append(_hud_element(
            f"{document_id}-{action}", f"{label} Button", "Button",
            {"label": label, "labelKey": "", "action": action, "variant": variant, "fontSize": 28},
            (stage_width - width) / 2, top + index * (height + _MENU_BUTTON_GAP), width, height, 10 + index,
        ))
    return _hud_document(document_id, name, elements)


def _arena_hud(coin_count: int) -> list[dict[str, Any]]:
    main = _hud_document("hud-main", "Main HUD", [
        _hud_element("hud-main-panel", "Score Panel", "Container",
                     {"backgroundColor": "rgba(0,0,0,0.45)", "borderColor": "rgba(255,215,90,0.7)", "borderWidth": 2,
                      "borderRadius": 12}, 32, 32, 380, 150, 1),
        _hud_text("hud-main-coins-label", "Coins Label", "Coins:", 56, 50, 140, 56, size=40, color="#ffd75a"),
        # Bound text: props.bind maps the 'text' prop to the level variable the blueprint counts in.
        _hud_text("hud-main-coins-value", "Coins Value", "0", 196, 50, 60, 56, size=40, align="center",
                  bind={"text": f"vars.{_SCORE_VARIABLE}"}),
        _hud_text("hud-main-coins-total", "Coins Total", f"/ {coin_count}", 262, 50, 120, 56, size=40,
                  color="rgba(255,255,255,0.7)"),
        _hud_element("hud-main-health", "Health", "HealthBar",
                     {"value": 100, "max": 100, "barColor": "#dc2626", "backgroundColor": "#1f2937", "showIcon": True,
                      "showText": True, "bind": {"value": "player.health", "max": "player.maxHealth"}},
                     48, 116, 340, 52, 2),
        _hud_text("hud-main-hint", "Hint", "Collect every coin. Push the loose crates. Avoid the red guards.",
                  360, 1000, 1200, 40, size=24, color="rgba(255,255,255,0.85)", weight="normal", align="center"),
    ])
    title = _menu("menu-title", "Title Menu", "ARENA", "Collect every coin. Avoid the red guards.", 480, [
        ("play", "Play", "primary"), ("options", "Options", "secondary"), ("quit", "Quit", "outline"),
    ])
    pause = _menu("menu-pause", "Pause Menu", "PAUSED", f"Collect all {coin_count} coins to reach the finish.", 400, [
        ("resume", "Resume", "primary"), ("save", "Save", "secondary"), ("load", "Load", "secondary"),
        ("options", "Options", "secondary"), ("quit", "Quit to title", "outline"),
    ])
    return [main, title, pause]


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return round(audio.getnframes() / audio.getframerate(), 3)


def _apply_arena(repository: Any, project_name: str) -> None:
    asset_ids = {model_id: _store_file(repository, path, FBX_MIME) for model_id, (path, _, _, _) in _ARENA_MODELS.items()}
    sound_path = _ARENA_ROOT / "assets" / "coin.wav"
    sound_asset = _store_file(repository, sound_path, WAV_MIME)

    heights = [_terrain_height(column, row, _ARENA_FLAT_RADIUS)
               for row in range(_TERRAIN_SAMPLES) for column in range(_TERRAIN_SAMPLES)]
    arena_heightfield = _store_heightfield(repository, heights, _TERRAIN_SAMPLES, "arena-terrain.ahf")
    finish_samples, finish_size = 33, 48.0
    finish_heights = [_bowl_height((column / (finish_samples - 1) - 0.5) * finish_size,
                                   (row / (finish_samples - 1) - 0.5) * finish_size)
                      for row in range(finish_samples) for column in range(finish_samples)]
    finish_heightfield = _store_heightfield(repository, finish_heights, finish_samples, "arena-finish-terrain.ahf")

    player = json.loads((_STARTER_ROOT / "player_blueprint.json").read_text(encoding="utf-8"))
    player.update(id=_ARENA_PLAYER_ID, linkedModelId="arena-model-character")
    enemy = json.loads((_ARENA_ROOT / "enemy_blueprint.json").read_text(encoding="utf-8"))

    arena_objects = _arena_objects(arena_heightfield)
    coins = [item for item in arena_objects if item["modelId"] == "arena-model-coin"]
    changes = {
        "models": [_model_document(model_id, asset_ids[model_id], name, category, size)
                   for model_id, (_, name, category, size) in _ARENA_MODELS.items()],
        "blueprints": [player, enemy],
        "audio": [{"id": _COIN_SOUND_ID, "name": "Coin Pickup", "assetId": sound_asset, "type": WAV_MIME,
                   "duration": _wav_duration(sound_path)}],
        "levels": [
            {"id": _ARENA_LEVEL_ID, "name": "Arena", "createdAt": 0, "blueprint": _arena_logic(coins)},
            {"id": _FINISH_LEVEL_ID, "name": "Finish", "createdAt": 0, "blueprint": _finish_logic()},
        ],
        "objects": arena_objects + _finish_objects(finish_heightfield, finish_samples, finish_size),
        "hud": _arena_hud(len(coins)),
        "metadata": [{"id": "game-settings", "settings": {
            "schema": 1, "name": project_name, "startupLevelId": _ARENA_LEVEL_ID, "playerBlueprintId": _ARENA_PLAYER_ID,
        }}],
    }
    repository.apply_changes(changes, expected_revision=repository.revision)


# --- courtyard -------------------------------------------------------------------------------

_COURTYARD_LEVEL_ID = "courtyard-level-1"
_COURTYARD_PLAYER_ID = "courtyard-player"
_CHIME_SOUND_ID = "courtyard-sound-chime"
_RELICS_VARIABLE = "relics"
_GATE_VARIABLE = "gate_open"
_COURTYARD_FLAT_RADIUS = 34.0
_COURTYARD_HALF = 15.0     # the walls stand on a square this far from the middle
_GATE_X = (-1.25, 1.25)    # the two gate crates fill the gap in the north wall
_GATE_HEIGHT_SCALE = 1.4   # the gate doors stand taller than the wall

_COURTYARD_MODELS = {
    "courtyard-model-character": (_STARTER_ROOT / "assets" / "character.fbx", "Character", "Character", 5.0),
    "courtyard-model-keeper": (_ARENA_ROOT / "assets" / "enemy.fbx", "Keeper", "Character", 5.0),
    "courtyard-model-crate": (_STARTER_ROOT / "assets" / "crate.fbx", "Crate", "Prop", _CRATE_SIZE),
    "courtyard-model-relic": (_ARENA_ROOT / "assets" / "coin.fbx", "Relic", "Prop", _COIN_SIZE),
    "courtyard-model-rock": (_STARTER_ROOT / "assets" / "rock.fbx", "Rock", "Environment", 3.0),
    "courtyard-model-tree": (_STARTER_ROOT / "assets" / "tree.fbx", "Tree", "Environment", 9.0),
}

# A warm late-afternoon sky.
_COURTYARD_SKY = dict(_SKY_CONFIG, timeOfDay=17.0, sunColor="#ffd9a8", fogColor="#c9a888", fogDensity=0.015)

# The Script component on each relic: the editor's Collectible template, counting into `relics`.
_RELIC_SCRIPT = f"""// A relic: spins, and when the player walks into its trigger adds one to the level variable
// '{_RELICS_VARIABLE}', plays the chime and removes itself. The level blueprint opens the gate at three.
const SCORE_VARIABLE = '{_RELICS_VARIABLE}';
const POINTS = 1;
const PICKUP_SOUND = '{_CHIME_SOUND_ID}';
const SPIN_SPEED = 2; // radians per second

function onStart(ctx) {{
    ctx.state.startRotation = ctx.self.rotation;
    ctx.state.startTime = ctx.time;
}}

function onUpdate(ctx) {{
    const [rx, ry, rz] = ctx.state.startRotation;
    ctx.self.setRotation(rx, ry + (ctx.time - ctx.state.startTime) * SPIN_SPEED, rz);
}}

function onTriggerEnter(ctx, other) {{
    // other is the object that entered, or null for the player: only the player collects it.
    if (other) return;
    const score = Number(ctx.vars.get(SCORE_VARIABLE)) || 0;
    ctx.vars.set(SCORE_VARIABLE, score + POINTS);
    if (PICKUP_SOUND) ctx.playSound(PICKUP_SOUND, 'sfx');
    ctx.log('Relics: ' + (score + POINTS) + ' / 3');
    ctx.self.destroy();
}}
"""

_KEEPER_DIALOGUE = {
    "startId": "keeper-welcome",
    "lines": [
        {"id": "keeper-welcome", "speaker": "Keeper", "next": "keeper-gate",
         "text": "Welcome to the old courtyard, traveller."},
        {"id": "keeper-gate", "speaker": "Keeper", "next": None,
         "text": "The north gate behind me opens only for someone who has gathered all three sun relics.",
         "choices": [
             {"id": "keeper-ask", "text": "Where are the relics?", "next": "keeper-hints"},
             {"id": "keeper-go", "text": "I'll find them.", "next": "keeper-farewell"},
         ]},
        {"id": "keeper-hints", "speaker": "Keeper", "next": "keeper-farewell",
         "text": "One rests among the eastern stones, one in the western garden, and one on the old well by the east wall."},
        {"id": "keeper-farewell", "speaker": "Keeper", "next": None,
         "text": "Bring all three and the gate will open on its own. Good luck."},
    ],
}

# Relic (x, z) positions and what they sit on (the height of their base).
_RELICS = (("East Stones", 11.0, 6.0, 0.0), ("West Garden", -10.5, 3.0, 0.0), ("Old Well", 9.0, -10.0, 1.0))


def _courtyard_objects(heightfield_id: str) -> list[dict[str, Any]]:
    level = _COURTYARD_LEVEL_ID
    objects = [
        _terrain_object("courtyard-terrain", level, heightfield_id, _TERRAIN_SAMPLES, _TERRAIN_SIZE),
        _object("courtyard-sky", level, "Sky", "sky_sphere", [0.0, 5.0, 0.0], skyConfig=dict(_COURTYARD_SKY)),
        # Facing north (-Z), toward the Keeper and the gate.
        _object("courtyard-player-start", level, "Player Start", "player_start", [0.0, 0.0, 11.0], rotation_y=round(math.pi, 4)),
    ]

    # The walls: a ring of fixed crates on a square, with a gap in the north side the gate fills.
    offsets = [-_COURTYARD_HALF + _CRATE_SIZE / 2 + _CRATE_SIZE * index for index in range(12)]
    wall: list[tuple[float, float]] = []
    for offset in offsets:
        if offset not in _GATE_X:
            wall.append((offset, -_COURTYARD_HALF))
        wall.extend([(offset, _COURTYARD_HALF), (-_COURTYARD_HALF, offset), (_COURTYARD_HALF, offset)])
    for index, (x, z) in enumerate(wall):
        object_id = f"courtyard-wall-{index + 1}"
        objects.append(_object(object_id, level, f"Wall {index + 1}", "prop", [x, 0.0, z],
                               model_id="courtyard-model-crate", components=[_crate_collider(object_id)]))

    # The gate: two tall, thin doors standing out from the wall. Kinematic bodies, so their colliders
    # follow the timeline that sinks them into the ground.
    gate = []
    for side, x in zip(("Left", "Right"), _GATE_X):
        object_id = f"courtyard-gate-{side.lower()}"
        gate.append(_object(object_id, level, f"Gate {side}", "prop", [x, 0.0, -_COURTYARD_HALF],
                            model_id="courtyard-model-crate", components=[
                                _component(object_id, "rigidBody", type="kinematicPosition", mass=50, gravityScale=1,
                                           lockRotation=True),
                                _crate_collider(object_id),
                            ]))
        gate[-1]["scale"] = [1.0, _GATE_HEIGHT_SCALE, 0.6]
    objects.extend(gate)
    sink = -_CRATE_SIZE * _GATE_HEIGHT_SCALE - 0.1
    # A warm lamp over the gate shows the way out; the gate's timeline lives on the same object.
    objects.append(_object("courtyard-gate-mechanism", level, "Gate Mechanism", "prop", [0.0, 4.2, -_COURTYARD_HALF + 1.0],
                           components=[_component("courtyard-gate-mechanism", "pointLight", color="#ffb36b", intensity=30,
                                                  distance=12, castShadow=False),
                                       _component("courtyard-gate-mechanism", "timeline", autoplay=False, loop=False,
                                                  speed=1, playVariable=_GATE_VARIABLE, timeline={
                               "duration": 2.5,
                               "tracks": [{
                                   "id": f"{item['id']}-sinks", "kind": "transform", "objectId": item["id"],
                                   "position": [
                                       {"time": 0, "value": item["position"], "interpolation": "smooth"},
                                       {"time": 2.5, "value": [item["position"][0], sink, item["position"][2]]},
                                   ],
                               } for item in gate],
                           })]))

    # The Keeper, beside the gate rather than in its way: talks when the player is near and presses Interact;
    # a capsule keeps the player from walking through them.
    objects.append(_object("courtyard-keeper", level, "Keeper", "prop", [-4.5, 0.0, -11.5],
                           model_id="courtyard-model-keeper", components=[
                               _component("courtyard-keeper", "dialogue", radius=5, prompt="Talk to the Keeper",
                                          dialogue=_KEEPER_DIALOGUE),
                               _component("courtyard-keeper", "collider", shape="capsule", radius=0.9, height=3.2,
                                          offset=[0.0, 2.5, 0.0], isTrigger=False),
                           ]))

    # The old well: a low crate the third relic sits on.
    objects.append(_object("courtyard-well", level, "Old Well", "prop", [9.0, 0.0, -10.0], model_id="courtyard-model-crate",
                           scale=0.4, components=[_crate_collider("courtyard-well")]))
    for index, (name, x, z, base) in enumerate(_RELICS):
        object_id = f"courtyard-relic-{index + 1}"
        objects.append(_object(object_id, level, f"Relic ({name})", "prop", [x, base + 0.6, z],
                               model_id="courtyard-model-relic", components=[
                                   _component(object_id, "collider", "trigger", shape="sphere", radius=1.6,
                                              offset=[0.0, _COIN_SIZE / 2, 0.0], isTrigger=True),
                                   _component(object_id, "script", source=_RELIC_SCRIPT),
                                   _component(object_id, "particles", preset="sparks", rate=8, burst=0, loop=True),
                                   _component(object_id, "pointLight", color="#ffd27a", intensity=12, distance=6,
                                              castShadow=False),
                               ]))

    # Past the gate: reaching it ends the game.
    objects.append(_object("courtyard-exit", level, "Courtyard Exit", "prop", [0.0, 0.0, -21.0], components=[
        _component("courtyard-exit", "collider", "trigger", shape="box", size=[8.0, 4.0, 3.0], offset=[0.0, 2.0, 0.0],
                   isTrigger=True),
    ]))

    for index, (x, z, rotation) in enumerate(((12.0, 8.5, 0.6), (9.0, 9.5, 2.2), (12.5, 3.0, 1.4))):
        objects.append(_object(f"courtyard-rock-{index + 1}", level, f"Eastern Stone {index + 1}", "prop", [x, 0.0, z],
                               model_id="courtyard-model-rock", rotation_y=rotation))
    for index, (x, z, rotation) in enumerate(((-11.0, 8.0, 0.4), (-12.0, -1.5, 1.9), (-8.0, -6.5, 2.8))):
        objects.append(_object(f"courtyard-garden-tree-{index + 1}", level, f"Garden Tree {index + 1}", "prop",
                               [x, 0.0, z], model_id="courtyard-model-tree", rotation_y=rotation))
    for index in range(14):
        angle = index * 2 * math.pi / 14 + 0.2
        radius = 38.0 + 4.0 * math.sin(index * 1.9)
        x, z = round(radius * math.cos(angle), 2), round(radius * math.sin(angle), 2)
        objects.append(_object(f"courtyard-tree-{index + 1}", level, f"Tree {index + 1}", "prop",
                               [x, round(_hills(x, z, _COURTYARD_FLAT_RADIUS) - 0.3, 2), z],
                               model_id="courtyard-model-tree", rotation_y=round(angle, 3)))
    return objects


def _courtyard_logic(exit_trigger: dict[str, Any]) -> dict[str, Any]:
    """Every frame, three relics open the gate (once); walking through it ends the game."""

    graph = _LogicGraph("courtyard-logic")
    begin = graph.begin_play("begin", (80, 40))
    hint = graph.print_string("hint", "Find the Keeper by the north gate.", (380, 40))
    graph.chain((begin, "", "Exec"), (hint, "Exec", "Out"))

    tick = graph.tick("tick", (80, 260))
    relics = graph.get_level_variable("get-relics", _RELICS_VARIABLE, (80, 460))
    all_found = graph.pure_math("all-found", "Equal", "Equal (==)", (380, 460), "Boolean", B=len(_RELICS))
    graph.wire(relics, "Value", all_found, "A")
    found = graph.branch("if-all-found", (380, 260))
    once = graph.do_once("open-once", (640, 260))
    open_gate = graph.set_level_variable("open-gate", _GATE_VARIABLE, (900, 260), value="1")
    chime = graph.play_sound("gate-sound", _CHIME_SOUND_ID, (1160, 260))
    announce = graph.print_string("gate-opens", "All three relics! The north gate grinds open.", (1420, 260))
    graph.chain((tick, "", "Exec"), (found, "Exec", ""))
    graph.wire(all_found, "Result", found, "Condition")
    graph.wire(found, "True", once, "Exec")
    graph.chain((once, "", "Completed"), (open_gate, "Exec", "Out"), (chime, "Exec", "Out"), (announce, "Exec", ""))

    leave = graph.overlap("exit-overlap", exit_trigger, (80, 660))
    leave_once = graph.do_once("exit-once", (380, 660))
    farewell = graph.print_string("farewell", "You leave the courtyard with the relics. Thanks for playing!", (640, 660))
    pause = graph.delay("before-end", 3.0, (900, 660))
    end = graph.level_action("end-game", "End Game", (1160, 660), action="EndGame")
    graph.chain((leave, "", "Exec"), (leave_once, "Exec", "Completed"), (farewell, "Exec", "Out"), (pause, "Exec", "Out"),
                (end, "Exec", ""))

    return graph.document([
        {"id": "courtyard-variable-relics", "name": _RELICS_VARIABLE, "type": "Float", "value": 0},
        {"id": "courtyard-variable-gate", "name": _GATE_VARIABLE, "type": "Float", "value": 0},
    ])


def _courtyard_hud() -> list[dict[str, Any]]:
    total = len(_RELICS)
    main = _hud_document("hud-main", "Main HUD", [
        _hud_element("hud-main-panel", "Relic Panel", "Container",
                     {"backgroundColor": "rgba(0,0,0,0.45)", "borderColor": "rgba(255,215,140,0.7)", "borderWidth": 2,
                      "borderRadius": 12}, 32, 32, 380, 88, 1),
        _hud_text("hud-main-relics-label", "Relics Label", "Relics:", 56, 50, 150, 56, size=40, color="#ffd78c"),
        _hud_text("hud-main-relics-value", "Relics Value", "0", 206, 50, 60, 56, size=40, align="center",
                  bind={"text": f"vars.{_RELICS_VARIABLE}"}),
        _hud_text("hud-main-relics-total", "Relics Total", f"/ {total}", 272, 50, 120, 56, size=40,
                  color="rgba(255,255,255,0.7)"),
        _hud_text("hud-main-hint", "Hint", "Talk to the Keeper, find three relics, then leave through the north gate.",
                  360, 1000, 1200, 40, size=24, color="rgba(255,255,255,0.85)", weight="normal", align="center"),
    ])
    title = _menu("menu-title", "Title Menu", "COURTYARD", "Find the three sun relics to open the gate.", 480, [
        ("play", "Play", "primary"), ("options", "Options", "secondary"), ("quit", "Quit", "outline"),
    ])
    pause = _menu("menu-pause", "Pause Menu", "PAUSED", f"Find all {total} relics, then leave through the north gate.",
                  400, [
                      ("resume", "Resume", "primary"), ("save", "Save", "secondary"), ("load", "Load", "secondary"),
                      ("options", "Options", "secondary"), ("quit", "Quit to title", "outline"),
                  ])
    return [main, title, pause]


def _apply_courtyard(repository: Any, project_name: str) -> None:
    asset_ids = {model_id: _store_file(repository, path, FBX_MIME) for model_id, (path, _, _, _) in _COURTYARD_MODELS.items()}
    sound_path = _ARENA_ROOT / "assets" / "coin.wav"
    sound_asset = _store_file(repository, sound_path, WAV_MIME)
    heights = [_terrain_height(column, row, _COURTYARD_FLAT_RADIUS)
               for row in range(_TERRAIN_SAMPLES) for column in range(_TERRAIN_SAMPLES)]
    heightfield = _store_heightfield(repository, heights, _TERRAIN_SAMPLES, "courtyard-terrain.ahf")

    player = json.loads((_STARTER_ROOT / "player_blueprint.json").read_text(encoding="utf-8"))
    player.update(id=_COURTYARD_PLAYER_ID, linkedModelId="courtyard-model-character")

    objects = _courtyard_objects(heightfield)
    exit_trigger = next(item for item in objects if item["id"] == "courtyard-exit")
    changes = {
        "models": [_model_document(model_id, asset_ids[model_id], name, category, size)
                   for model_id, (_, name, category, size) in _COURTYARD_MODELS.items()],
        "blueprints": [player],
        "audio": [{"id": _CHIME_SOUND_ID, "name": "Chime", "assetId": sound_asset, "type": WAV_MIME,
                   "duration": _wav_duration(sound_path)}],
        "levels": [{"id": _COURTYARD_LEVEL_ID, "name": "Courtyard", "createdAt": 0, "blueprint": _courtyard_logic(exit_trigger)}],
        "objects": objects,
        "hud": _courtyard_hud(),
        "metadata": [{"id": "game-settings", "settings": {
            "schema": 1, "name": project_name, "startupLevelId": _COURTYARD_LEVEL_ID,
            "playerBlueprintId": _COURTYARD_PLAYER_ID,
        }}],
    }
    repository.apply_changes(changes, expected_revision=repository.revision)


# --- outpost ---------------------------------------------------------------------------------

_OUTPOST_ROOT = _TEMPLATES_ROOT / "outpost"
_OUTPOST_LEVEL_ID = "outpost-level-1"
_OUTPOST_PLAYER_ID = "outpost-player"
_OUTPOST_RAIDER_ID = "outpost-raider"
_SIGNAL_SOUND_ID = "outpost-sound-signal"
_SUPPLIES_VARIABLE = "supplies"
_SIGNAL_VARIABLE = "gate_open"
_OUTPOST_FLAT_RADIUS = 36.0
_CAMP_CENTER_Z = -8.0
_CAMP_HALF = 13.2          # the palisade stands on a square this far from the camp's middle
_PALISADE_WIDTH = 3.3      # one wall segment, normalised to _PALISADE_HEIGHT tall
_PALISADE_HEIGHT = 7.0
_BEACON_HEIGHT = 9.0
_SUPPLY_SIZE = 2.0

# Model id -> (asset file, display name, category, normalised size, material overrides). The
# characters and scenery are built from scratch by tools/outpost_character_model.py and
# tools/outpost_props_model.py, so the sample can be shared freely.
_OUTPOST_MODELS = {
    "outpost-model-ranger": (_OUTPOST_ROOT / "assets" / "ranger.fbx", "Ranger", "Character", 5.0, None),
    "outpost-model-scout": (_OUTPOST_ROOT / "assets" / "ranger.fbx", "Scout", "Character", 5.0,
                            {"Jacket": {"color": "#3d5d86"}, "Pants": {"color": "#5b5348"}, "Hair": {"color": "#8a5a2b"}}),
    "outpost-model-raider": (_OUTPOST_ROOT / "assets" / "raider.fbx", "Raider", "Character", 5.0, None),
    "outpost-model-palisade": (_OUTPOST_ROOT / "assets" / "palisade.fbx", "Palisade", "Environment", _PALISADE_HEIGHT, None),
    "outpost-model-supply": (_OUTPOST_ROOT / "assets" / "supply.fbx", "Supply Cache", "Prop", _SUPPLY_SIZE, None),
    "outpost-model-beacon": (_OUTPOST_ROOT / "assets" / "beacon.fbx", "Signal Beacon", "Environment", _BEACON_HEIGHT, None),
    "outpost-model-tent": (_OUTPOST_ROOT / "assets" / "tent.fbx", "Tent", "Environment", 7.0, None),
    "outpost-model-crate": (_STARTER_ROOT / "assets" / "crate.fbx", "Crate", "Prop", _CRATE_SIZE, None),
    "outpost-model-rock": (_STARTER_ROOT / "assets" / "rock.fbx", "Rock", "Environment", 3.0, None),
    "outpost-model-tree": (_STARTER_ROOT / "assets" / "tree.fbx", "Tree", "Environment", 9.0, None),
}

# Clip names as the FBX files carry them.
_CLIP = {name: f"Armature|{name}" for name in (
    "Idle", "Walk", "Run", "Walk Back", "Strafe Left", "Strafe Right", "Jump", "Falling", "Landing", "Punch",
    "Shooting", "Aiming", "Hit Reaction", "Death", "Wave")}

# Late afternoon, the sun warm and low over the camp.
_OUTPOST_SKY = dict(_SKY_CONFIG, timeOfDay=16.4, sunIntensity=1.8, sunColor="#ffdcb0", fogColor="#c9ad92", fogDensity=0.009,
                    azimuth=0.1)

# Supply caches: (name, x, z). Out past the camp, one behind it.
_SUPPLIES = (("East Ridge", 27.0, 6.0), ("West Woods", -26.0, -16.0), ("North Rocks", 9.0, -31.0))

_SUPPLY_SCRIPT = f"""// A supply cache: bobs gently, and when the player reaches it adds one to the level
// variable '{_SUPPLIES_VARIABLE}', plays the signal chime and is taken. The level blueprint lights the
// beacon and opens the gate at three.
const SCORE_VARIABLE = '{_SUPPLIES_VARIABLE}';
const PICKUP_SOUND = '{_SIGNAL_SOUND_ID}';
const TOTAL = {len(_SUPPLIES)};

function onStart(ctx) {{
    ctx.state.base = ctx.self.position;
    ctx.state.startTime = ctx.time;
}}

function onUpdate(ctx) {{
    const [x, y, z] = ctx.state.base;
    ctx.self.setPosition(x, y + 0.15 * Math.sin((ctx.time - ctx.state.startTime) * 2), z);
}}

function onTriggerEnter(ctx, other) {{
    // other is the object that entered, or null for the player: only the player picks it up.
    if (other) return;
    const count = (Number(ctx.vars.get(SCORE_VARIABLE)) || 0) + 1;
    ctx.vars.set(SCORE_VARIABLE, count);
    ctx.playSound(PICKUP_SOUND, 'sfx');
    ctx.log('Supplies: ' + count + ' / ' + TOTAL);
    ctx.self.destroy();
}}
"""

_SCOUT_DIALOGUE = {
    "startId": "scout-hail",
    "lines": [
        {"id": "scout-hail", "speaker": "Scout", "next": "scout-raid",
         "text": "Ranger! Thank the hills you came. Raiders hit us at dawn."},
        {"id": "scout-raid", "speaker": "Scout", "next": None,
         "text": "They scattered our three supply caches across the hills. Without them we can't light the signal beacon.",
         "choices": [
             {"id": "scout-where", "text": "Where are the caches?", "next": "scout-caches"},
             {"id": "scout-raiders", "text": "How many raiders?", "next": "scout-warning"},
             {"id": "scout-go", "text": "I'll bring them back.", "next": "scout-farewell"},
         ]},
        {"id": "scout-caches", "speaker": "Scout", "next": "scout-raid",
         "text": "One on the east ridge, one in the western woods, and one past the north wall among the rocks."},
        {"id": "scout-warning", "speaker": "Scout", "next": "scout-raid",
         "text": "Two bands camp north of here, and more keep coming. Hold the right mouse button to aim, click to fire."},
        {"id": "scout-farewell", "speaker": "Scout", "next": None,
         "text": "Bring all three and the gate opens and the beacon burns. Then meet me inside."},
    ],
}


def _palisade(object_id: str, level: str, name: str, x: float, z: float, rotation: float,
              extra: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    collider = _component(object_id, "collider", shape="box", size=[_PALISADE_WIDTH, _PALISADE_HEIGHT, 0.9],
                          offset=[0.0, _PALISADE_HEIGHT / 2, 0.0], isTrigger=False)
    return _object(object_id, level, name, "prop", [x, 0.0, z], model_id="outpost-model-palisade",
                   rotation_y=rotation, components=(extra or []) + [collider])


def _outpost_objects(heightfield_id: str) -> list[dict[str, Any]]:
    level = _OUTPOST_LEVEL_ID
    center_z, half = _CAMP_CENTER_Z, _CAMP_HALF
    south_z = center_z + half
    objects = [
        _terrain_object("outpost-terrain", level, heightfield_id, _TERRAIN_SAMPLES, _TERRAIN_SIZE),
        _object("outpost-sky", level, "Sky", "sky_sphere", [0.0, 5.0, 0.0], skyConfig=dict(_OUTPOST_SKY)),
        # Facing north (-Z), toward the camp gate.
        _object("outpost-player-start", level, "Player Start", "player_start", [0.0, 0.0, 26.0], rotation_y=round(math.pi, 4)),
    ]

    # The palisade: eight segments a side, the middle two of the south side are the gate.
    offsets = [(index - 3.5) * _PALISADE_WIDTH for index in range(8)]
    gate_offsets = offsets[3:5]
    wall = 0
    for offset in offsets:
        sides = [(offset, center_z - half, 0.0), (half, center_z + offset, math.pi / 2), (-half, center_z + offset, math.pi / 2)]
        if offset not in gate_offsets:
            sides.append((offset, south_z, 0.0))
        for x, z, rotation in sides:
            wall += 1
            objects.append(_palisade(f"outpost-wall-{wall}", level, f"Palisade {wall}", round(x, 2), round(z, 2), round(rotation, 4)))
    gate = []
    for side, offset in zip(("Left", "Right"), gate_offsets):
        object_id = f"outpost-gate-{side.lower()}"
        # Kinematic, so the collider follows the timeline that sinks the gate.
        gate.append(_palisade(object_id, level, f"Gate {side}", round(offset, 2), south_z, 0.0, extra=[
            _component(object_id, "rigidBody", type="kinematicPosition", mass=80, gravityScale=1, lockRotation=True)]))
    objects.extend(gate)

    beacon_z = center_z - 3.0
    objects.append(_object("outpost-beacon", level, "Signal Beacon", "prop", [0.0, 0.0, beacon_z], model_id="outpost-model-beacon",
                           components=[_component("outpost-beacon", "collider", shape="box", size=[4.4, _BEACON_HEIGHT, 4.4],
                                                  offset=[0.0, _BEACON_HEIGHT / 2, 0.0], isTrigger=False)]))
    # The flame waits below ground; the signal timeline lifts it into the brazier.
    flame_lit = [0.0, _BEACON_HEIGHT - 0.2, beacon_z]
    flame_hidden = [0.0, -30.0, beacon_z]
    objects.append(_object("outpost-beacon-flame", level, "Beacon Flame", "prop", flame_hidden, components=[
        _component("outpost-beacon-flame", "particles", preset="fire", rate=40, burst=0, loop=True),
        _component("outpost-beacon-flame", "pointLight", color="#ff9a3c", intensity=80, distance=40, castShadow=False),
    ]))
    sink = -_PALISADE_HEIGHT - 0.5
    tracks: list[dict[str, Any]] = [{
        "id": f"{item['id']}-sinks", "kind": "transform", "objectId": item["id"],
        "position": [{"time": 0, "value": item["position"], "interpolation": "smooth"},
                     {"time": 3.0, "value": [item["position"][0], sink, item["position"][2]]}],
    } for item in gate]
    tracks.append({"id": "outpost-flame-rises", "kind": "transform", "objectId": "outpost-beacon-flame",
                   "position": [{"time": 0, "value": flame_hidden, "interpolation": "step"}, {"time": 0.4, "value": flame_lit}]})
    objects.append(_object("outpost-signal", level, "Signal Mechanism", "prop", [0.0, 0.0, south_z - 2.0], components=[
        _component("outpost-signal", "timeline", autoplay=False, loop=False, speed=1, playVariable=_SIGNAL_VARIABLE,
                   timeline={"duration": 3.0, "tracks": tracks})]))

    # Inside: tents, stacked crates, and the goal the gate lets you reach.
    objects += [
        _object("outpost-tent-1", level, "Tent 1", "prop", [-8.0, 0.0, center_z - 4.0], model_id="outpost-model-tent",
                rotation_y=round(math.pi / 2, 4), components=[_component("outpost-tent-1", "collider", shape="box",
                                                                          size=[4.8, 4.0, 6.4], offset=[0.0, 2.0, 0.0], isTrigger=False)]),
        _object("outpost-tent-2", level, "Tent 2", "prop", [8.0, 0.0, center_z - 6.0], model_id="outpost-model-tent",
                rotation_y=round(-math.pi / 2, 4), components=[_component("outpost-tent-2", "collider", shape="box",
                                                                           size=[4.8, 4.0, 6.4], offset=[0.0, 2.0, 0.0], isTrigger=False)]),
    ]
    for index, (x, z, rotation) in enumerate(((-9.5, center_z + 7.0, 0.2), (-7.0, center_z + 7.5, 1.0), (9.0, center_z + 6.5, 0.6))):
        object_id = f"outpost-crate-{index + 1}"
        objects.append(_object(object_id, level, f"Crate {index + 1}", "prop", [x, 0.0, z], model_id="outpost-model-crate",
                               rotation_y=rotation, components=[_crate_collider(object_id)]))
    # From just inside the gate to the foot of the beacon.
    objects.append(_object("outpost-goal", level, "Beacon Square", "prop", [0.0, 0.0, center_z + 4.0], components=[
        _component("outpost-goal", "collider", "trigger", shape="box", size=[12.0, 4.0, 10.0], offset=[0.0, 2.0, 0.0],
                   isTrigger=True),
    ]))

    # The Scout waits outside the gate, waving the player over, and talks when they come close.
    objects.append(_object("outpost-scout", level, "Scout", "prop", [-6.5, 0.0, south_z + 4.0], model_id="outpost-model-scout",
                           rotation_y=0.35, components=[
                               _component("outpost-scout", "animation", clip=_CLIP["Wave"], loop=True, speed=1, startAt=0),
                               _component("outpost-scout", "dialogue", radius=7, prompt="Talk to the Scout",
                                          dialogue=_SCOUT_DIALOGUE),
                               _component("outpost-scout", "collider", shape="capsule", radius=0.9, height=3.2,
                                          offset=[0.0, 2.5, 0.0], isTrigger=False),
                               _component("outpost-scout", "lookAtIK", boneName="Head", target="player", maxAngle=70, weight=1),
                           ]))

    for index, (name, x, z) in enumerate(_SUPPLIES):
        object_id = f"outpost-supply-{index + 1}"
        objects.append(_object(object_id, level, f"Supply Cache ({name})", "prop", [x, 0.3, z], model_id="outpost-model-supply",
                               rotation_y=round(0.7 * index, 3), components=[
                                   _component(object_id, "collider", "trigger", shape="sphere", radius=3.0,
                                              offset=[0.0, 1.0, 0.0], isTrigger=True),
                                   _component(object_id, "script", source=_SUPPLY_SCRIPT),
                                   _component(object_id, "particles", preset="sparks", rate=6, burst=0, loop=True),
                                   _component(object_id, "pointLight", color="#9fd4ff", intensity=14, distance=8, castShadow=False),
                               ]))
        # A boulder beside each cache to fight from.
        objects.append(_object(f"outpost-cover-{index + 1}", level, f"Boulder {index + 1}", "prop", [x + 3.5, 0.0, z + 2.0],
                               model_id="outpost-model-rock", rotation_y=round(1.3 * index, 3), scale=1.4))

    # The raiders come from the hills north of the camp, away from where the Ranger starts.
    for index, (x, z) in enumerate(((36.0, -36.0), (-36.0, -32.0))):
        objects.append(_object(f"outpost-raider-camp-{index + 1}", level, f"Raider Spawner {index + 1}", "spawn_point",
                               [x, 0.0, z], spawnConfig={"blueprintId": _OUTPOST_RAIDER_ID, "interval": 14, "maxSpawns": 2,
                                                         "team": "Enemy"}))

    for index in range(16):
        angle = index * 2 * math.pi / 16 + 0.15
        radius = 44.0 + 4.0 * math.sin(index * 2.3)
        x, z = round(radius * math.cos(angle), 2), round(radius * math.sin(angle), 2)
        objects.append(_object(f"outpost-tree-{index + 1}", level, f"Tree {index + 1}", "prop",
                               [x, round(_hills(x, z, _OUTPOST_FLAT_RADIUS) - 0.3, 2), z],
                               model_id="outpost-model-tree", rotation_y=round(angle, 3)))

    # The opening shot: a camera high over the approach that drifts in, then hands over to play.
    start, end = [0.0, 20.0, 50.0], [0.0, 15.0, 38.0]
    objects.append(_object("outpost-intro-camera", level, "Intro Camera", "prop", start,
                           components=[_component("outpost-intro-camera", "camera", fov=55, startActive=False, blendIn=0)]))
    objects[-1]["rotation"] = [-0.33, 0.0, 0.0]
    objects.append(_object("outpost-director", level, "Intro Director", "prop", [0.0, 0.0, 30.0], components=[
        _component("outpost-director", "timeline", autoplay=True, loop=False, speed=1, timeline={
            "duration": 5.0,
            "tracks": [
                {"id": "outpost-intro-cut", "kind": "camera", "blend": 1.5,
                 "keys": [{"time": 0, "value": "outpost-intro-camera"}, {"time": 4.0, "value": ""}]},
                {"id": "outpost-intro-dolly", "kind": "transform", "objectId": "outpost-intro-camera",
                 "position": [{"time": 0, "value": start, "interpolation": "smooth"}, {"time": 4.5, "value": end}]},
            ],
        })]))
    return objects


def _outpost_logic(goal: dict[str, Any]) -> dict[str, Any]:
    """Three supplies light the beacon, open the gate and save; reaching the beacon ends the game; a
    fallen ranger restarts the level."""

    graph = _LogicGraph("outpost-logic")
    begin = graph.begin_play("begin", (80, 40))
    hint = graph.print_string("hint", "Talk to the Scout by the camp gate.", (380, 40))
    graph.chain((begin, "", "Exec"), (hint, "Exec", "Out"))

    tick = graph.tick("tick", (80, 260))
    checks = graph.sequence("checks", (340, 260))
    graph.chain((tick, "", "Exec"), (checks, "Exec", ""))

    supplies = graph.get_level_variable("get-supplies", _SUPPLIES_VARIABLE, (340, 460))
    all_found = graph.pure_math("all-found", "Equal", "Equal (==)", (620, 460), "Boolean", B=len(_SUPPLIES))
    graph.wire(supplies, "Value", all_found, "A")
    found = graph.branch("if-all-found", (620, 260))
    once = graph.do_once("signal-once", (880, 260))
    signal = graph.set_level_variable("signal", _SIGNAL_VARIABLE, (1140, 260), value="1")
    chime = graph.play_sound("signal-sound", _SIGNAL_SOUND_ID, (1400, 260))
    announce = graph.print_string("beacon-lit", "All three caches! The beacon is lit and the gate opens.", (1660, 260))
    save = graph.level_action("autosave", "Save Game", (1920, 260), action="SaveGame")
    saved = graph.print_string("saved", "Progress saved.", (2180, 260))
    graph.wire(checks, "Then 0", found, "Exec")
    graph.wire(all_found, "Result", found, "Condition")
    graph.wire(found, "True", once, "Exec")
    graph.chain((once, "", "Completed"), (signal, "Exec", "Out"), (chime, "Exec", "Out"), (announce, "Exec", "Out"),
                (save, "Exec", "Out"), (saved, "Exec", ""))

    dead = graph.player_variable("player-is-dead", "IsDead", "Boolean", (620, 640))
    fallen = graph.branch("if-player-dead", (880, 600))
    restart_once = graph.do_once("restart-once", (1140, 600))
    pause = graph.delay("before-restart", 2.5, (1400, 600))
    restart = graph.level_action("restart", "Restart Level", (1660, 600), action="Restart")
    graph.wire(checks, "Then 1", fallen, "Exec")
    graph.wire(dead, "Value", fallen, "Condition")
    graph.wire(fallen, "True", restart_once, "Exec")
    graph.chain((restart_once, "", "Completed"), (pause, "Exec", "Out"), (restart, "Exec", ""))

    arrive = graph.overlap("goal-overlap", goal, (80, 860))
    arrive_once = graph.do_once("goal-once", (380, 860))
    farewell = graph.print_string("farewell", "The beacon burns over a safe outpost. Thanks for playing!", (640, 860))
    linger = graph.delay("before-end", 3.0, (900, 860))
    end = graph.level_action("end-game", "End Game", (1160, 860), action="EndGame")
    graph.chain((arrive, "", "Exec"), (arrive_once, "Exec", "Completed"), (farewell, "Exec", "Out"), (linger, "Exec", "Out"),
                (end, "Exec", ""))

    return graph.document([
        {"id": "outpost-variable-supplies", "name": _SUPPLIES_VARIABLE, "type": "Float", "value": 0},
        {"id": "outpost-variable-signal", "name": _SIGNAL_VARIABLE, "type": "Float", "value": 0},
    ])


def _graph_state(state_id: str, name: str, x: float, y: float, clip: str | None = None, *, loop: bool = True,
                 **extra: Any) -> dict[str, Any]:
    state = {"id": state_id, "name": name, "position": {"x": x, "y": y}, "loop": loop, "stateType": "Single",
             "clipName": clip, "blendSamples": [], "blendParamX": "", "blendParamY": ""}
    state.update(extra)
    return state


def _when(transition_id: str, source: str, target: str, duration: float, *conditions: tuple[str, str, Any],
          **extra: Any) -> dict[str, Any]:
    transition = {"id": transition_id, "fromStateId": source, "toStateId": target, "duration": duration,
                  "conditions": [{"variableId": v, "operator": op, "value": value} for v, op, value in conditions]}
    transition.update(extra)
    return transition


def _outpost_player() -> dict[str, Any]:
    """The starter player's controls and variables on the Ranger, with a graph that shows the
    animation kit: a Locomotion state machine whose walk and run share a sync group, a blended
    combat strafe, jump, fall and a landing whose curve holds the character until it recovers,
    death, upper-body aim and fire clips and an additive hit reaction."""

    player = json.loads((_STARTER_ROOT / "player_blueprint.json").read_text(encoding="utf-8"))
    graph = player["animationGraph"]
    speed, jumping, x_input, y_input, sprint, aiming, dead, grounded, falling, vertical = (
        "v1", "v2", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11")
    graph["variables"].append({"id": "v_land_lock", "name": "LandLock", "type": "Boolean", "value": False})

    locomotion = {
        "states": [
            _graph_state("loco-idle", "Idle", 80, 120, _CLIP["Idle"], isRoot=True),
            _graph_state("loco-walk", "Walk", 380, 40, _CLIP["Walk"], syncGroup="Feet"),
            _graph_state("loco-run", "Run", 680, 120, _CLIP["Run"], syncGroup="Feet"),
        ],
        "transitions": [
            _when("loco-start", "loco-idle", "loco-walk", 0.2, (speed, ">", 0)),
            _when("loco-stop", "loco-walk", "loco-idle", 0.25, (speed, "==", 0)),
            _when("loco-sprint", "loco-walk", "loco-run", 0.35, (sprint, "==", True), (y_input, ">", 0)),
            _when("loco-ease", "loco-run", "loco-walk", 0.35, (sprint, "==", False)),
            _when("loco-halt", "loco-run", "loco-idle", 0.3, (speed, "==", 0)),
        ],
    }
    strafe = _graph_state("combat", "Combat Move", 380, 340, None, stateType="Blend2D", blendParamX=x_input,
                          blendParamY=y_input, syncGroup="Feet", blendSamples=[
                              {"id": "combat-idle", "clipName": _CLIP["Idle"], "position": [0, 0]},
                              {"id": "combat-forward", "clipName": _CLIP["Walk"], "position": [0, 1]},
                              {"id": "combat-back", "clipName": _CLIP["Walk Back"], "position": [0, -1]},
                              {"id": "combat-left", "clipName": _CLIP["Strafe Left"], "position": [-1, 0]},
                              {"id": "combat-right", "clipName": _CLIP["Strafe Right"], "position": [1, 0]},
                          ])
    # The landing's curve holds LandLock on for its first 0.3 s: the impact plays out before moving on.
    landing_curve = {"id": "land-lock-curve", "variableId": "v_land_lock",
                     "keys": [{"time": 0, "value": 1}, {"time": 0.28, "value": 1}, {"time": 0.32, "value": 0}]}
    graph["states"] = [
        _graph_state("locomotion", "Locomotion", 80, 120, None, isRoot=True, stateType="StateMachine", subGraph=locomotion),
        strafe,
        _graph_state("jump", "Jump", 700, -80, _CLIP["Jump"], loop=False),
        _graph_state("fall", "Falling", 1000, -80, _CLIP["Falling"]),
        _graph_state("land", "Land", 1000, 160, _CLIP["Landing"], loop=False, curves=[landing_curve]),
        _graph_state("death", "Death", 700, 420, _CLIP["Death"], loop=False),
    ]
    graph["transitions"] = [
        _when("to-combat", "locomotion", "combat", 0.2, (aiming, "==", True)),
        _when("from-combat", "combat", "locomotion", 0.2, (aiming, "==", False)),
        _when("take-off", "locomotion", "jump", 0.1, (jumping, "==", True), (vertical, ">", 0), anyState=True, priority=50),
        _when("drop", "jump", "fall", 0.25, (falling, "==", True), (vertical, "<=", 0), anyState=True, priority=40),
        _when("touch-down", "fall", "land", 0.1, (grounded, "==", True)),
        _when("short-hop", "jump", "land", 0.1, (grounded, "==", True)),
        _when("recover", "land", "locomotion", 0.2, ("v_land_lock", "==", False)),
        _when("fallen", "locomotion", "death", 0.15, (dead, "==", True), anyState=True, priority=100),
    ]
    graph["activeStateId"] = "locomotion"
    player.update(
        id=_OUTPOST_PLAYER_ID, name="Ranger", linkedModelId="outpost-model-ranger",
        description="The Ranger: the starter controls on a character with its own clips.",
        upperBody={"fireClip": _CLIP["Shooting"], "aimClip": _CLIP["Aiming"], "maskBone": "Spine"},
        hitReactClip=_CLIP["Hit Reaction"],
        # Over the shoulder, so the aim and fire clips show, with the spine leaning up and down with the aim.
        aimView="shoulder",
        ik={"footIK": True, "footMaxStep": 0.4, "aimPitch": True},
    )
    player["variables"] = graph["variables"]
    return player


def _outpost_raider() -> dict[str, Any]:
    """The Arena guard's AI and graph on the Raider: runs at the player, punches, flinches when shot."""

    raider = json.loads((_ARENA_ROOT / "enemy_blueprint.json").read_text(encoding="utf-8"))
    clips = {"Idle": _CLIP["Idle"], "Chase": _CLIP["Run"], "Attack": _CLIP["Punch"], "Strafe": _CLIP["Walk"]}
    for state in raider["animationGraph"]["states"]:
        if state["name"] in clips:
            state["clipName"] = clips[state["name"]]
    raider.update(id=_OUTPOST_RAIDER_ID, name="Raider", linkedModelId="outpost-model-raider",
                  description="A raider: chases the Ranger on sight and punches in range. Shot raiders flinch, then fall as ragdolls.",
                  hitReactClip=_CLIP["Hit Reaction"])
    tuning = {"Health": 45, "Damage": 7}
    for stat in raider["stats"]:
        stat["value"] = tuning.get(stat["name"], stat["value"])
    return raider


def _outpost_hud() -> list[dict[str, Any]]:
    total = len(_SUPPLIES)
    main = _hud_document("hud-main", "Main HUD", [
        _hud_element("hud-main-panel", "Supplies Panel", "Container",
                     {"backgroundColor": "rgba(0,0,0,0.45)", "borderColor": "rgba(159,212,255,0.7)", "borderWidth": 2,
                      "borderRadius": 12}, 32, 32, 420, 150, 1),
        _hud_text("hud-main-supplies-label", "Supplies Label", "Supplies:", 56, 50, 190, 56, size=40, color="#9fd4ff"),
        _hud_text("hud-main-supplies-value", "Supplies Value", "0", 246, 50, 60, 56, size=40, align="center",
                  bind={"text": f"vars.{_SUPPLIES_VARIABLE}"}),
        _hud_text("hud-main-supplies-total", "Supplies Total", f"/ {total}", 312, 50, 120, 56, size=40,
                  color="rgba(255,255,255,0.7)"),
        _hud_element("hud-main-health", "Health", "HealthBar",
                     {"value": 100, "max": 100, "barColor": "#dc2626", "backgroundColor": "#1f2937", "showIcon": True,
                      "showText": True, "bind": {"value": "player.health", "max": "player.maxHealth"}},
                     48, 116, 380, 52, 2),
        # Along the top, clear of the dialogue box at the bottom.
        _hud_text("hud-main-hint", "Hint",
                  "Talk to the Scout, recover three supply caches, reach the beacon. Right mouse aims, left mouse fires.",
                  500, 40, 1180, 40, size=24, color="rgba(255,255,255,0.85)", weight="normal", align="center"),
    ])
    title = _menu("menu-title", "Title Menu", "OUTPOST", "Recover the supplies. Light the beacon.", 480, [
        ("play", "Play", "primary"), ("continue", "Continue", "secondary"), ("options", "Options", "secondary"),
        ("quit", "Quit", "outline"),
    ])
    pause = _menu("menu-pause", "Pause Menu", "PAUSED", f"Recover all {total} supply caches, then reach the beacon.", 400, [
        ("resume", "Resume", "primary"), ("save", "Save", "secondary"), ("load", "Load", "secondary"),
        ("options", "Options", "secondary"), ("quit", "Quit to title", "outline"),
    ])
    return [main, title, pause]


def _apply_outpost(repository: Any, project_name: str) -> None:
    stored: dict[Path, str] = {}
    for path, _, _, _, _ in _OUTPOST_MODELS.values():
        if path not in stored:
            stored[path] = _store_file(repository, path, FBX_MIME)
    sound_path = _ARENA_ROOT / "assets" / "coin.wav"
    sound_asset = _store_file(repository, sound_path, WAV_MIME)
    heights = [_terrain_height(column, row, _OUTPOST_FLAT_RADIUS)
               for row in range(_TERRAIN_SAMPLES) for column in range(_TERRAIN_SAMPLES)]
    heightfield = _store_heightfield(repository, heights, _TERRAIN_SAMPLES, "outpost-terrain.ahf")

    pistol_asset = _store_file(repository, _OUTPOST_ROOT / "assets" / "pistol.fbx", FBX_MIME)
    models = []
    for model_id, (path, name, category, size, overrides) in _OUTPOST_MODELS.items():
        model = _model_document(model_id, stored[path], name, category, size)
        if overrides:
            model["materialOverrides"] = overrides
        models.append(model)

    objects = _outpost_objects(heightfield)
    goal = next(item for item in objects if item["id"] == "outpost-goal")
    changes = {
        "models": models,
        "blueprints": [_outpost_player(), _outpost_raider()],
        # The Ranger's pistol in the right hand (in the hand bone's metres; the file is in centimetres),
        # and the muzzle at the end of its barrel for the flash.
        "attachments": [{"id": "outpost-pistol", "name": "Pistol", "assetId": pistol_asset, "parentModelId": "outpost-model-ranger",
                         "boneName": "RightHand", "position": [0.0, 0.075, 0.0], "rotation": [-90.0, 0.0, 0.0],
                         "scale": [0.01, 0.01, 0.01]}],
        "sockets": [{"id": "outpost-muzzle", "name": "Muzzle", "parentModelId": "outpost-model-ranger", "boneName": "RightHand",
                     "position": [0.0, 0.24, -0.05], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0],
                     "flashConfig": {"enabled": True, "textureId": None, "scale": 1.0, "color": "#ffd27a", "duration": 0.08}}],
        "audio": [{"id": _SIGNAL_SOUND_ID, "name": "Signal Chime", "assetId": sound_asset, "type": WAV_MIME,
                   "duration": _wav_duration(sound_path)}],
        "levels": [{"id": _OUTPOST_LEVEL_ID, "name": "Outpost", "createdAt": 0, "blueprint": _outpost_logic(goal)}],
        "objects": objects,
        "hud": _outpost_hud(),
        "metadata": [{"id": "game-settings", "settings": {
            "schema": 1, "name": project_name, "startupLevelId": _OUTPOST_LEVEL_ID, "playerBlueprintId": _OUTPOST_PLAYER_ID,
        }}],
    }
    repository.apply_changes(changes, expected_revision=repository.revision)


_BUILDERS = {"starter": _apply_starter, "arena": _apply_arena, "courtyard": _apply_courtyard, "outpost": _apply_outpost}
