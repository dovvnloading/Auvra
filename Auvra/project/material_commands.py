"""Batch work on a project's materials from the command line, without the editor open.

    python -m Auvra.project.material_commands PROJECT list
    python -m Auvra.project.material_commands PROJECT set-value MATERIAL NAME VALUE
    python -m Auvra.project.material_commands PROJECT apply-preset MATERIAL PRESET
    python -m Auvra.project.material_commands PROJECT rename-parameter MATERIAL OLD NEW [--apply-revision REV --receipt FILE]
    python -m Auvra.project.material_commands PROJECT undo-rename FILE
    python -m Auvra.project.material_commands PROJECT redo-rename FILE
    python -m Auvra.project.material_commands PROJECT cook MATERIAL [--size N] [--out FOLDER] [--into-project]
    python -m Auvra.project.material_commands PROJECT ball MATERIAL [--size PIXELS] [--out FOLDER] [--into-project]
    python -m Auvra.project.material_commands PROJECT bake-mesh-maps MODEL [--size N] [--samples N] [--out FOLDER] [--into-project]

``list`` names each material, whether a texture graph makes it, its texture graph's parameters with their values and
its presets. ``set-value`` sets one of a texture graph's parameters (VALUE is JSON: a number, [r, g, b] or text);
``apply-preset`` sets every value one of its presets holds. Both save the project; the editor, and a game that cooks
its texture graphs (fbx-viewer runtime/materials/materialCooking.ts), draw the new values.

``cook``, ``ball`` and ``bake-mesh-maps`` are drawn on a graphics card by the editor's own evaluator, ball renderer and
baker. This process only hands them the project's documents: the editor's code runs in a headless browser on its
software GPU (fbx-viewer scripts/materials/headless.mjs, with Node and the editor's packages installed), with the
editor closed. ``cook`` makes a texture graph's pictures as Update material does, ``ball`` a material's preview ball
as a PNG, and ``bake-mesh-maps`` a model's mesh maps for each of its surfaces as the Paint tab bakes them (kept bottom
row first, as the Paint tab keeps them). ``--out`` writes the pictures to a folder; ``--into-project`` keeps them in the
project as the editor would (the material's pictures, a texture in Material balls, or the bake of the surface's painted
set) and saves it. ``--size`` is a power of two (9 or 512 for 512 pixels; the material's or set's own when not given)
or, for a ball, pixels across (160 when not given).

MATERIAL and MODEL are an id or a name (any case). ``--json`` prints results as JSON. Exit codes: 2 for a request that
cannot be done as asked, 3 when Node, the editor's packages or a browser are missing, 4 when the headless browser fails.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence

from .errors import AuvraProjectError
from .repository import ProjectRepository
from .schemas import DOMAIN_NAMES


class MaterialCommandError(ValueError):
    """A command that cannot be done as asked, in plain words."""


class HeadlessUnavailable(MaterialCommandError):
    """The headless browser cannot be started here: Node, the editor's packages or a browser are missing."""


class HeadlessFailed(MaterialCommandError):
    """The headless browser started but could not do the work."""


DRAWN_COMMANDS = ("cook", "ball", "bake-mesh-maps")
_EDITOR_ROOT = Path(__file__).resolve().parents[2] / "fbx-viewer (1)"
_HEADLESS_SCRIPT = _EDITOR_ROOT / "scripts" / "materials" / "headless.mjs"
# Long enough for a large bake on a software GPU.
_HEADLESS_TIMEOUT = 2400


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


def headless_unavailable() -> str | None:
    """Why the headless browser cannot be started here, in plain words; None when it can."""

    node = shutil.which("node")
    if not node:
        return "Cooking, balls and bakes run the editor's code in a headless browser, which needs Node: install it, or do this in the editor."
    if not _HEADLESS_SCRIPT.is_file() or not (_EDITOR_ROOT / "node_modules" / "vite").is_dir():
        return "Cooking, balls and bakes run the editor's code in a headless browser, which needs the editor's packages installed in fbx-viewer (1)."
    checked = subprocess.run([node, str(_HEADLESS_SCRIPT), "--check"], cwd=_EDITOR_ROOT, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=60)
    if checked.returncode != 0:
        return checked.stderr.strip() or "No browser to run the editor's code in was found."
    return None


def _drawn_size(command: str, size: int | None) -> int | None:
    """``--size`` as the page takes it: pixels across for a ball, else a power of two (given as one, or as pixels)."""

    if size is None:
        return None
    if command == "ball":
        if not 16 <= size <= 2048:
            raise MaterialCommandError("A ball is 16 to 2048 pixels across.")
        return size
    if 16 <= size <= 8192 and size & (size - 1) == 0:
        return size.bit_length() - 1
    if 4 <= size <= 13:
        return size
    raise MaterialCommandError("--size is a power of two: 4 to 13 (16 to 8192 pixels), as the power or as the pixels.")


def _upserted(documents: list[dict[str, Any]], changed: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {item["id"]: item for item in changed}
    kept = [by_id.pop(item["id"], item) for item in documents]
    return kept + list(by_id.values())


def _keep_drawn(repository: ProjectRepository, folder: Path, result: dict[str, Any]) -> None:
    """Puts the pictures the page made in the project, with the documents naming them, and saves it."""

    for file in result["files"]:
        path = folder / file["name"]
        with path.open("rb") as stream:
            reference = repository.assets.put_stream(stream, size=path.stat().st_size, mime="image/png", name=file["name"])
        if reference.asset_id != file["assetId"]:
            raise HeadlessFailed(f"{file['name']} changed on its way into the project.")
    changes = result["changes"]
    materials = _upserted(repository.get_domain("materials")["documents"], changes["materials"])
    textures = _upserted(repository.get_domain("textures")["documents"], changes["textures"])
    # The pictures replaced go, unless something else still names them.
    replaced = set(changes.get("replacedTextures") or []) - {item["id"] for item in changes["textures"]}
    if replaced:
        elsewhere = json.dumps([repository.get_domain(domain) for domain in DOMAIN_NAMES if domain not in ("materials", "textures")]) + json.dumps(materials)
        textures = [item for item in textures if item["id"] not in replaced or f'"{item["id"]}"' in elsewhere]
    domains: dict[str, list[dict[str, Any]]] = {}
    if changes["materials"]:
        domains["materials"] = materials
    if changes["textures"] or replaced:
        domains["textures"] = textures
    if domains:
        repository.apply_changes(domains, expected_revision=repository.revision)
        repository.save()


def draw(repository: ProjectRepository, command: str, target: str, *, size: int | None = None, samples: int | None = None,
         out: Path | None = None, into_project: bool = False) -> dict[str, Any]:
    """Cooks, draws a ball or bakes mesh maps with the editor's code in a headless browser.

    Writes the pictures to ``out`` and, with ``into_project``, keeps them in the project and saves it. Returns what was
    made: each file (its name, what it is, its size, its asset id and, written to a folder, its path) and notes.
    """

    if command not in DRAWN_COMMANDS:
        raise MaterialCommandError(f"No command called {command!r}.")
    if into_project and repository.read_only:
        raise MaterialCommandError("The project is open elsewhere (the editor holds it): close it there first.")
    if samples is not None and not 1 <= samples <= 4096:
        raise MaterialCommandError("--samples is 1 to 4096 rays.")
    materials = repository.get_domain("materials")["documents"]
    models = repository.get_domain("models")["documents"]
    if command == "bake-mesh-maps":
        item = _find(models, target, "model")
    else:
        item = _find(materials, target, "material")
        if command == "cook":
            _stored(item)
    page_size = _drawn_size(command, size)
    unavailable = headless_unavailable()
    if unavailable:
        raise HeadlessUnavailable(unavailable)
    node = shutil.which("node") or "node"
    with tempfile.TemporaryDirectory(prefix="auvra-material-job-") as work:
        folder = Path(out).resolve() if out else Path(work) / "pictures"
        job = {
            "command": command,
            "target": item["id"],
            "intoProject": into_project,
            "content": str(repository.path.resolve() / "Content"),
            "out": str(folder),
            "result": str(Path(work) / "result.json"),
            "project": {"materials": materials, "textures": repository.get_domain("textures")["documents"], "models": models},
            **({"size": page_size} if page_size is not None else {}),
            **({"samples": samples} if samples is not None else {}),
        }
        job_file = Path(work) / "job.json"
        job_file.write_text(json.dumps(job), encoding="utf-8")
        try:
            completed = subprocess.run([node, str(_HEADLESS_SCRIPT), str(job_file)], cwd=_EDITOR_ROOT, capture_output=True,
                                       text=True, encoding="utf-8", errors="replace", timeout=_HEADLESS_TIMEOUT)
        except subprocess.TimeoutExpired as error:
            raise HeadlessFailed("The headless browser took too long and was stopped.") from error
        if completed.returncode != 0:
            raise HeadlessFailed(completed.stderr.strip() or "The headless browser stopped without saying why.")
        result: dict[str, Any] = json.loads((Path(work) / "result.json").read_text(encoding="utf-8"))
        if into_project:
            _keep_drawn(repository, folder, result)
    if out:
        for file in result["files"]:
            file["path"] = str(folder / file["name"])
    return result


_RENAME_DOMAINS = ("materials", "models", "objects", "prefabs", "metadata")


def _rename_inventory(repository: ProjectRepository) -> dict[str, list[dict[str, Any]]]:
    return {domain: repository.get_domain(domain)["documents"] for domain in _RENAME_DOMAINS}


def _fingerprint(domains: dict) -> str:
    """Hash JSON numbers consistently across JS and Python (e.g. 0 and 0.0)."""
    def canonical(value):
        if isinstance(value, dict):
            return {key: canonical(item) for key, item in value.items()}
        if isinstance(value, list):
            return [canonical(item) for item in value]
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    ordered = {domain: sorted(documents, key=lambda doc: doc["id"]) for domain, documents in domains.items()}
    return hashlib.sha256(json.dumps(canonical(ordered), sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _rename_plan(repository: ProjectRepository, domains: dict, source: str, old: str, new: str) -> dict:
    node = shutil.which("node")
    if not node or not (_EDITOR_ROOT / "node_modules" / "esbuild").is_dir():
        raise HeadlessUnavailable("Parameter renaming needs Node and the editor's packages. Run npm ci in fbx-viewer (1).")
    request = {"snapshot": {"projectId": repository.project_id, "revision": repository.revision, "domains": domains},
               "sourceMaterialId": source, "from": old, "to": new}
    result = subprocess.run([node, str(_EDITOR_ROOT / "scripts/materials/rename.mjs")],
                            input=json.dumps(request, allow_nan=False), text=True, encoding="utf-8",
                            capture_output=True, timeout=120)
    if result.returncode:
        raise MaterialCommandError(result.stderr.strip() or "The parameter rename planner failed.")
    plan = json.loads(result.stdout)
    # Never round an exact host integer, or accept a normalized document as an inverse.
    saved = {domain: {doc["id"]: doc for doc in documents} for domain, documents in domains.items()}
    for change in plan["undoChanges"]:
        before = saved[change["domain"]][change["id"]]
        if before != change["value"]:
            raise MaterialCommandError(f'The planner could not preserve {change["domain"]}/{change["id"]} exactly.')
    return plan


def _rename_domains(domains: dict, changes: list[dict]) -> dict:
    touched: dict[str, dict[str, dict]] = {}
    if not isinstance(changes, list) or not changes:
        raise MaterialCommandError("The rename receipt has no document changes.")
    for change in changes:
        if not isinstance(change, dict):
            raise MaterialCommandError("The rename receipt contains an invalid change.")
        domain, key, value = change.get("domain"), change.get("id"), change.get("value")
        if (not isinstance(domain, str) or domain not in domains or not isinstance(key, str)
                or change.get("operation") != "upsert" or not isinstance(value, dict) or value.get("id") != key
                or key in touched.get(domain, {})):
            raise MaterialCommandError("The rename receipt contains an invalid document.")
        touched.setdefault(domain, {})[key] = value
    result = {}
    for domain, updates in touched.items():
        documents = domains[domain]
        if updates.keys() - {doc["id"] for doc in documents}:
            raise MaterialCommandError("A document in the rename receipt is missing from this project.")
        result[domain] = [updates.get(doc["id"], doc) for doc in documents]
    return result


def _apply_rename(repository: ProjectRepository, changed: dict, revision: int) -> None:
    # Keep changed documents within the desktop host's single-document paging limit.
    from Auvra.desktop.project_host import DOCUMENT_LOAD_LIMIT

    for domain, docs in changed.items():
        previous = {doc["id"]: doc for doc in repository.get_domain(domain)["documents"]}
        for doc in docs:
            if doc != previous.get(doc["id"]) and len(json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode()) > DOCUMENT_LOAD_LIMIT:
                raise MaterialCommandError(f'The renamed {domain}/{doc["id"]} document is too large to reopen in the editor.')
    revision = repository.apply_changes(changed, expected_revision=revision)
    try:
        repository.save(expected_revision=revision)
    except (OSError, AuvraProjectError) as error:
        raise MaterialCommandError(f"Transaction committed at revision {revision}, but its recovery point could not be saved: {error}") from error


def rename_parameter(repository: ProjectRepository, material: str, old: str, new: str,
                     apply_revision: int | None, receipt_path: Path | None) -> dict:
    revision = repository.revision
    if apply_revision is not None and apply_revision != revision:
        raise MaterialCommandError("The project revision changed. Preview this rename again.")
    domains = _rename_inventory(repository)
    source = _find(domains["materials"], material, "material")["id"]
    if receipt_path is not None and apply_revision is None:
        raise MaterialCommandError("Use --receipt with --apply-revision to commit this rename.")
    plan = _rename_plan(repository, domains, source, old, new)
    if apply_revision is None:
        return {"revision": revision, "impact": plan["impact"], "applied": False}
    if receipt_path is None:
        raise MaterialCommandError("Specify --receipt FILE to keep the complete undo record.")
    if receipt_path.resolve().is_relative_to(repository.path.resolve()):
        raise MaterialCommandError("Keep the undo receipt outside the project folder.")
    changed = _rename_domains(domains, plan["changes"])
    receipt = {"format": "auvra.parameter-rename/1", "projectId": repository.project_id, "source": source,
               "from": old, "to": new, "before": _fingerprint(domains), "after": _fingerprint(domains | changed),
               "undo": plan["undoChanges"]}
    # Write the inverse before the transaction. Even an interruption immediately after
    # the host commit leaves a usable receipt. Existing user files are never replaced.
    with receipt_path.open("x", encoding="utf-8") as stream:
        json.dump(receipt, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    _apply_rename(repository, changed, revision)
    return {"revision": repository.revision, "impact": plan["impact"], "applied": True, "receipt": str(receipt_path)}


def travel_rename(repository: ProjectRepository, receipt_path: Path, undo: bool) -> dict:
    revision = repository.revision
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if (not isinstance(receipt, dict) or receipt.get("format") != "auvra.parameter-rename/1"
            or receipt.get("projectId") != repository.project_id or not isinstance(receipt.get("undo"), list)
            or not all(isinstance(receipt.get(key), str) for key in ("source", "from", "to", "before", "after"))):
        raise MaterialCommandError("This rename receipt does not belong to this project.")
    domains = _rename_inventory(repository)
    if _fingerprint(domains) != receipt.get("after" if undo else "before"):
        raise MaterialCommandError("The project's rename references differ from this receipt. No documents were changed.")
    before = domains | _rename_domains(domains, receipt["undo"]) if undo else domains
    # Replan from the original documents. Only apply an inverse whose forward
    # replay reproduces the exact authored state; the receipt cannot add a change.
    plan = _rename_plan(repository, before, receipt["source"], receipt["from"], receipt["to"])
    after = before | _rename_domains(before, plan["changes"])
    if _fingerprint(before) != receipt["before"] or _fingerprint(after) != receipt["after"] or plan["undoChanges"] != receipt["undo"]:
        raise MaterialCommandError("The saved rename no longer reproduces both project states.")
    _apply_rename(repository, _rename_domains(domains, plan["undoChanges" if undo else "changes"]), revision)
    return {"revision": repository.revision, "impact": plan["impact"], "undone": undo}


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
    rename = sub.add_parser("rename-parameter", help="preview a project-wide parameter rename, or apply the previewed revision")
    rename.add_argument("material")
    rename.add_argument("old")
    rename.add_argument("new")
    rename.add_argument("--apply-revision", type=int, help="apply at the exact revision printed by the preview")
    rename.add_argument("--receipt", type=Path, help="a new undo receipt file outside the project")
    for command in ("undo-rename", "redo-rename"):
        history = sub.add_parser(command, help="restore all affected documents using a parameter rename receipt")
        history.add_argument("receipt", type=Path)
    helps = {
        "cook": ("a texture graph's pictures, as Update material makes them", "a power of two (9 or 512): the material's own when not given"),
        "ball": ("a material's preview ball, as a PNG", "pixels across (160 when not given)"),
        "bake-mesh-maps": ("a model's mesh maps, as the Paint tab bakes them", "a power of two (9 or 512): the set's own, or 2048, when not given"),
    }
    for command, (summary, size) in helps.items():
        drawn = sub.add_parser(command, help=f"{summary} (drawn in a headless browser)")
        drawn.add_argument("target", help="the model's id or name" if command == "bake-mesh-maps" else "the material's id or name")
        drawn.add_argument("--size", type=int, help=size)
        if command == "bake-mesh-maps":
            drawn.add_argument("--samples", type=int, help="rays per texel for occlusion and thickness (128 when not given)")
        drawn.add_argument("--out", type=Path, help="the folder the pictures are written to")
        drawn.add_argument("--into-project", action="store_true", help="keep them in the project as the editor would, and save it")
    return parser


def _print_drawn(result: dict[str, Any]) -> None:
    for file in result["files"]:
        print(f"{file.get('path') or file['name']} ({file['what']}, {file['width']} x {file['height']})")
    for note in result.get("notes", []):
        print(note)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    drawing = args.command in DRAWN_COMMANDS
    try:
        if drawing and not args.out and not args.into_project:
            raise MaterialCommandError("Say where the pictures go: --out FOLDER, --into-project, or both.")
        # Drawing into a folder only reads the project, so the editor may have it open meanwhile.
        reads_only = drawing and not args.into_project
        with ProjectRepository(args.project, read_only=reads_only) as repository:
            if repository.read_only and args.command != "list" and not reads_only:
                raise MaterialCommandError("The project is open elsewhere (the editor holds it): close it there first.")
            if args.command == "list":
                result: Any = list_materials(repository)
            elif args.command == "rename-parameter":
                result = rename_parameter(repository, args.material, args.old, args.new, args.apply_revision, args.receipt)
            elif args.command in ("undo-rename", "redo-rename"):
                result = travel_rename(repository, args.receipt, args.command == "undo-rename")
            elif args.command == "set-value":
                try:
                    value = json.loads(args.value)
                except json.JSONDecodeError:
                    value = args.value
                result = set_value(repository, args.material, args.name, value)
            elif args.command == "apply-preset":
                result = apply_preset(repository, args.material, args.preset)
            else:
                result = draw(repository, args.command, args.target, size=args.size, samples=getattr(args, "samples", None),
                              out=args.out, into_project=args.into_project)
    except HeadlessUnavailable as error:
        print(str(error), file=sys.stderr)
        return 3
    except HeadlessFailed as error:
        print(str(error), file=sys.stderr)
        return 4
    except (MaterialCommandError, AuvraProjectError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2))
    elif args.command == "list":
        for entry in result:
            extra = f" {entry['parameters']}" if entry.get("parameters") else ""
            presets = f" presets: {', '.join(map(str, entry['presets']))}" if entry.get("presets") else ""
            print(f"{entry['name']} ({entry['kind']}){extra}{presets}")
    elif drawing:
        _print_drawn(result)
    else:
        print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
