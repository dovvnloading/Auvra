"""Batch work on a project's materials from the command line, without the editor open.

    python -m Auvra.project.material_commands PROJECT list
    python -m Auvra.project.material_commands PROJECT set-value MATERIAL NAME VALUE
    python -m Auvra.project.material_commands PROJECT apply-preset MATERIAL PRESET
    python -m Auvra.project.material_commands PROJECT cook MATERIAL
    python -m Auvra.project.material_commands PROJECT ball MATERIAL
    python -m Auvra.project.material_commands PROJECT bake-mesh-maps MODEL

``list`` names each material, whether a texture graph makes it, its texture graph's parameters with their values and
its presets. ``set-value`` sets one of a texture graph's parameters (VALUE is JSON: a number, [r, g, b] or text);
``apply-preset`` sets every value one of its presets holds. Both save the project; the editor, and a game that cooks
its texture graphs (fbx-viewer runtime/materials/materialCooking.ts), draw the new values.

``cook``, ``ball`` and ``bake-mesh-maps`` are drawn on a graphics card by the editor's own evaluator, renderer and
baker, which run in its browser frame; the host has no headless frame for them yet, so they answer so (exit code 3)
and name where in the editor to do them. MATERIAL and MODEL are an id or a name (any case). ``--json`` prints results
as JSON.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from .repository import ProjectRepository


class MaterialCommandError(ValueError):
    """A command that cannot be done as asked, in plain words."""


_NEEDS_EDITOR = {
    "cook": "Cooking a texture graph runs its nodes on a graphics card through the editor's evaluator. In the editor: Materials › the material › Update material; a game set to cook its texture graphs cooks them as it loads.",
    "ball": "A material's ball is drawn by the editor's renderer. In the editor: Materials › the material › Add to my library draws it.",
    "bake-mesh-maps": "Mesh maps are baked on a graphics card by the editor's baker. In the editor: Paint › the model › Bake.",
}


def _find(documents: Sequence[dict[str, Any]], wanted: str, what: str) -> dict[str, Any]:
    exact = [item for item in documents if item.get("id") == wanted]
    named = exact or [item for item in documents if str(item.get("name", "")).lower() == wanted.lower()]
    if not named:
        raise MaterialCommandError(f"There is no {what} called {wanted!r} in this project.")
    if len(named) > 1:
        raise MaterialCommandError(f"More than one {what} is called {wanted!r}: use its id ({', '.join(item['id'] for item in named)}).")
    return named[0]


def _stored(material: dict[str, Any]) -> dict[str, Any]:
    stored = material.get("textureGraph")
    if not isinstance(stored, dict) or not isinstance(stored.get("graph"), dict):
        raise MaterialCommandError(f"{material.get('name')!r} is not made by a texture graph.")
    return stored


def list_materials(repository: ProjectRepository) -> list[dict[str, Any]]:
    """Each material: its id, name, what makes it, and its texture graph's parameters (with values) and presets."""

    result = []
    for material in repository.get_domain("materials").get("documents", []):
        stored = material.get("textureGraph")
        entry: dict[str, Any] = {"id": material["id"], "name": material.get("name", ""), "kind": "shader graph"}
        if isinstance(stored, dict) and isinstance(stored.get("graph"), dict):
            graph = stored["graph"]
            values = stored.get("values") or {}
            entry["kind"] = "graph for other graphs" if stored.get("library") is True else "texture graph"
            entry["parameters"] = {
                parameter["name"]: values.get(parameter["name"], parameter.get("default"))
                for parameter in graph.get("parameters") or [] if isinstance(parameter, dict) and parameter.get("name")
            }
            entry["presets"] = [preset.get("name") or preset.get("id") for preset in graph.get("presets") or [] if isinstance(preset, dict)]
        result.append(entry)
    return result


def _save_material(repository: ProjectRepository, changed: dict[str, Any]) -> None:
    documents = [changed if item.get("id") == changed["id"] else item for item in repository.get_domain("materials").get("documents", [])]
    repository.apply_changes({"materials": documents}, expected_revision=repository.revision)
    repository.save()


def set_value(repository: ProjectRepository, material_name: str, name: str, value: Any) -> dict[str, Any]:
    """Sets one of a texture graph's parameters and saves; returns the material's values."""

    material = copy.deepcopy(_find(repository.get_domain("materials").get("documents", []), material_name, "material"))
    stored = _stored(material)
    parameters = {parameter.get("name"): parameter for parameter in stored["graph"].get("parameters") or [] if isinstance(parameter, dict)}
    if name not in parameters:
        known = ", ".join(sorted(str(key) for key in parameters if key)) or "none"
        raise MaterialCommandError(f"{material.get('name')!r} has no parameter called {name!r} (it has: {known}).")
    kind = parameters[name].get("kind")
    if kind in ("float", "int") and not (isinstance(value, (int, float)) and not isinstance(value, bool)):
        raise MaterialCommandError(f"{name!r} takes a number.")
    if kind in ("float", "int"):
        low, high = parameters[name].get("min"), parameters[name].get("max")
        if isinstance(low, (int, float)):
            value = max(low, value)
        if isinstance(high, (int, float)):
            value = min(high, value)
        if kind == "int":
            value = int(round(value))
    stored["values"] = {**(stored.get("values") or {}), name: value}
    _save_material(repository, material)
    return stored["values"]


def apply_preset(repository: ProjectRepository, material_name: str, preset_name: str) -> dict[str, Any]:
    """Sets every value a texture graph's preset holds and saves; returns the material's values."""

    material = copy.deepcopy(_find(repository.get_domain("materials").get("documents", []), material_name, "material"))
    stored = _stored(material)
    presets = [preset for preset in stored["graph"].get("presets") or [] if isinstance(preset, dict)]
    preset = _find([{**item, "name": item.get("name") or item.get("id")} for item in presets], preset_name, "preset")
    stored["values"] = {**(stored.get("values") or {}), **(preset.get("values") or {})}
    _save_material(repository, material)
    return stored["values"]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m Auvra.project.material_commands", description="Batch work on a project's materials.")
    parser.add_argument("project", type=Path, help="the project's folder")
    parser.add_argument("--json", action="store_true", help="print results as JSON")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="the materials, their texture graphs' parameters and presets")
    value = sub.add_parser("set-value", help="set one of a texture graph's parameters")
    value.add_argument("material")
    value.add_argument("name")
    value.add_argument("value", help="JSON: a number, [r, g, b] or text")
    preset = sub.add_parser("apply-preset", help="set every value one of a texture graph's presets holds")
    preset.add_argument("material")
    preset.add_argument("preset")
    for command in _NEEDS_EDITOR:
        drawn = sub.add_parser(command, help="drawn by the editor on a graphics card (not headless yet)")
        drawn.add_argument("target")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command in _NEEDS_EDITOR:
        print(_NEEDS_EDITOR[args.command], file=sys.stderr)
        return 3
    try:
        with ProjectRepository(args.project) as repository:
            if repository.read_only and args.command != "list":
                raise MaterialCommandError("The project is open elsewhere (the editor holds it): close it there first.")
            if args.command == "list":
                result: Any = list_materials(repository)
            elif args.command == "set-value":
                try:
                    value = json.loads(args.value)
                except json.JSONDecodeError:
                    value = args.value
                result = set_value(repository, args.material, args.name, value)
            else:
                result = apply_preset(repository, args.material, args.preset)
    except MaterialCommandError as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2))
    elif args.command == "list":
        for entry in result:
            extra = f" {entry['parameters']}" if entry.get("parameters") else ""
            presets = f" presets: {', '.join(map(str, entry['presets']))}" if entry.get("presets") else ""
            print(f"{entry['name']} ({entry['kind']}){extra}{presets}")
    else:
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
