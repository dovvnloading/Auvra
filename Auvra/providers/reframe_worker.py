"""Runs one Reframe render in a process of its own, under Reframe's own Python.

Standalone on purpose: it is run by an interpreter that has Reframe's packages and may have none of Auvra's. It reads the job
folder Auvra prepared, reports through status.json there, and stops when a file named cancel appears.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable

_FINAL_REPORT_ATTEMPTS = 100
_FINAL_REPORT_WAIT_SECONDS = 0.05
# However little a fill gives, a sky still gives some light: with none at all, what the sun misses would go black.
# The viewport's vignette, from where it starts.
_VIGNETTE_OFFSET = 0.35


def fog_transmittance(distance: Any, fog: dict[str, Any], exp: Callable[[Any], Any], clip: Callable[[Any, float, float], Any]) -> Any:
    """How much of what is at a distance comes through a fog, by the viewport's own law. For numbers or for arrays."""
    if fog.get("kind") == "linear":
        near, far = float(fog["near"]), float(fog["far"])
        return 1.0 - clip((distance - near) / (far - near), 0.0, 1.0)
    density = float(fog.get("density", 0.0))
    return exp(-(density * distance) ** 2)


def _sky_in_each_pixel(np: Any, distance: Any) -> Any:
    """How much of each pixel is sky. Distance is averaged over every sample, the ones that met nothing counting as none, so a pixel on an object's edge reads as near as it is covered."""
    padded = np.pad(distance, 1, mode="edge")
    around = [padded[1 + y:padded.shape[0] - 1 + y, 1 + x:padded.shape[1] - 1 + x] for y in (-1, 0, 1) for x in (-1, 0, 1)]
    farthest = np.max(around, axis=0)
    beside_sky = np.min(around, axis=0) <= 0.0
    covered = np.where(beside_sky, distance / np.maximum(farthest, 1e-6), 1.0)
    return np.where(distance <= 0.0, 1.0, 1.0 - np.clip(covered, 0.0, 1.0))


def panorama_along_view(np: Any, panorama: Any, rotation_deg: float, camera: dict[str, Any], rows: int, columns: int) -> Any:
    """What a panorama shows behind each pixel of a frame, from the bottom row up, the way round the renderer reads one."""
    eye = np.array(camera["lookfrom"], dtype=np.float64)
    forward = np.array(camera["lookat"], dtype=np.float64) - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, (0.0, 1.0, 0.0))
    right = right / np.linalg.norm(right) if np.linalg.norm(right) > 1e-6 else np.array((1.0, 0.0, 0.0))
    up = np.cross(right, forward)
    extent = np.tan(np.radians(float(camera["vfov"])) / 2.0)
    x, y = np.meshgrid(((np.arange(columns) + 0.5) / columns * 2.0 - 1.0) * extent * columns / rows, ((np.arange(rows) + 0.5) / rows * 2.0 - 1.0) * extent)
    rays = forward[None, None, :] + x[:, :, None] * right[None, None, :] + y[:, :, None] * up[None, None, :]
    rays /= np.linalg.norm(rays, axis=2, keepdims=True)
    height, width = panorama.shape[:2]
    across = ((np.arctan2(rays[:, :, 2], rays[:, :, 0]) - np.radians(rotation_deg)) / (2.0 * np.pi) + 0.5) % 1.0 * width - 0.5
    down = np.arccos(np.clip(rays[:, :, 1], -1.0, 1.0)) / np.pi * height - 0.5
    left, top = np.floor(across).astype(np.int64), np.floor(down).astype(np.int64)
    part_x, part_y = (across - left)[:, :, None], (down - top)[:, :, None]
    upper, lower = np.clip(top, 0, height - 1), np.clip(top + 1, 0, height - 1)
    beside = (left + 1) % width
    left = left % width
    return (panorama[upper, left] * (1.0 - part_x) + panorama[upper, beside] * part_x) * (1.0 - part_y) + (panorama[lower, left] * (1.0 - part_x) + panorama[lower, beside] * part_x) * part_y


def _light_of_screen(np: Any, shown: Any) -> Any:
    """Colours on screen back as light, as the tone curve hands it on."""
    return np.where(shown <= 0.04045, shown / 12.92, np.power((shown + 0.055) / 1.055, 2.4))


def _graded(np: Any, film: Any, mapped: Any, grade: dict[str, Any]) -> Any:
    """What a view's stack does to the picture once it is tone mapped, each in the order, the colours and by the sum the stack has it."""
    out = mapped
    saturation = float(grade.get("saturation", 0.0))
    if saturation != 0.0:
        grey = out.mean(axis=2, keepdims=True)
        out = out + (grey - out) * ((1.0 - 1.0 / (1.001 - saturation)) if saturation > 0.0 else -saturation)
    brightness, contrast = float(grade.get("brightness", 0.0)), float(grade.get("contrast", 0.0))
    look = grade.get("look")
    if brightness != 0.0 or contrast != 0.0 or isinstance(look, dict):
        # These two work in the colours on screen.
        shown = film.linear_to_srgb(np.clip(out, 0.0, 1.0))
        if brightness != 0.0 or contrast != 0.0:
            centred = shown + brightness - 0.5
            shown = (centred / (1.0 - contrast) if contrast > 0.0 else centred * (1.0 + contrast)) + 0.5
        if isinstance(look, dict):
            size = int(look["size"])
            table = np.fromfile(look["table"], dtype=np.float32).reshape(size, size, size, 4)[:, :, :, :3]
            place = np.clip(shown, 0.0, 1.0) * (size - 1)
            low = np.floor(place).astype(np.int32)
            ends = [low, np.minimum(low + 1, size - 1)]
            part = place - low
            blended = 0.0
            for r in (0, 1):
                for g in (0, 1):
                    for b in (0, 1):
                        weight = (part[:, :, 0] if r else 1.0 - part[:, :, 0]) * (part[:, :, 1] if g else 1.0 - part[:, :, 1]) * (part[:, :, 2] if b else 1.0 - part[:, :, 2])
                        blended = blended + table[ends[b][:, :, 2], ends[g][:, :, 1], ends[r][:, :, 0]] * weight[:, :, None]
            strength = float(look["strength"])
            shown = shown * (1.0 - strength) + blended * strength
        out = _light_of_screen(np, np.clip(shown, 0.0, 1.0))
    darkness = float(grade.get("vignette", 0.0))
    if darkness > 0.0:
        rows, columns = out.shape[0], out.shape[1]
        y, x = np.meshgrid((np.arange(rows) + 0.5) / rows - 0.5, (np.arange(columns) + 0.5) / columns - 0.5, indexing="ij")
        reach = np.sqrt(x * x + y * y) * (darkness + _VIGNETTE_OFFSET)
        edge = _VIGNETTE_OFFSET * 0.799
        step = np.clip((reach - 0.8) / (edge - 0.8), 0.0, 1.0)
        out = out * (step * step * (3.0 - 2.0 * step))[:, :, None]
    return np.clip(out, 0.0, 1.0)


def _use_viewport_finish(film: Any, load_image: Callable[[str], Any]) -> None:
    """
    Puts on a frame what brings it to the view, where the renderer hands over its light and depth for fog. Its own fog thins by
    another law. Fog and particles go on where the viewport has them: in the light with a post-process stack, and otherwise after
    tone mapping, in the colours on screen. What a stack does after tone mapping follows that.
    """
    import numpy as np

    held: dict[str, Any] = {}
    tone_map = film.tonemap

    def picture_of(part: dict[str, Any], like: Any) -> Any:
        drawn = np.fromfile(part["picture"], dtype=np.float32).reshape(int(part["height"]), int(part["width"]), 4)
        return drawn if drawn.shape[:2] == like.shape[:2] else None

    def apply_depth_fog(hdr: Any, depth: Any, finish: Any) -> Any:
        if not isinstance(finish, dict) or not finish.get("enabled"):
            return hdr
        distance = depth.reshape(hdr.shape[0], hdr.shape[1]).astype(np.float32)
        sky = _sky_in_each_pixel(np, distance)
        out = hdr
        if isinstance(finish.get("cloud_shade"), dict):
            drawn = picture_of(finish["cloud_shade"], out)
            if drawn is not None:
                out = out * drawn[:, :, :3]
        shown = finish.get("sky")
        if isinstance(shown, dict):
            # The renderer's rays saw the light around where they met nothing. The view shows its sky there.
            rows, columns = hdr.shape[:2]
            around = panorama_along_view(np, load_image(shown["light_around"]), 0.0, finish["camera"], rows, columns)
            behind = np.array(shown["colour"], dtype=np.float32)[None, None, :]
            if shown.get("panorama"):
                behind = panorama_along_view(np, load_image(shown["panorama"]), float(shown.get("rotation_deg", 0.0)), finish["camera"], rows, columns)
            out = np.maximum(out + sky[:, :, None] * (behind * float(shown["intensity"]) - around), 0.0)
        grade = finish.get("grade") if isinstance(finish.get("grade"), dict) else {}
        on_screen = finish.get("on_screen", True)
        if finish.get("kind") in {"squared", "linear"}:
            # Sky has no fog in the viewport. A pixel on an edge is as far as what covers it.
            far = distance / np.maximum(1.0 - sky, 1e-3)
            through = (sky + (1.0 - sky) * fog_transmittance(far, finish, np.exp, np.clip))[:, :, None]
            drawn = picture_of(finish["fog_picture"], out) if isinstance(finish.get("fog_picture"), dict) else None
            colour = drawn[:, :, :3] if drawn is not None else np.array(finish["color"][:3], dtype=np.float32)[None, None, :]
            if on_screen:
                held["through"], held["colour"] = through, colour
            else:
                out = out * through + colour * (1.0 - through)
        if isinstance(finish.get("over"), dict):
            drawn = picture_of(finish["over"], out)
            if drawn is not None and on_screen:
                held["over"] = drawn
            elif drawn is not None:
                out = out * (1.0 - np.clip(drawn[:, :, 3:], 0.0, 1.0)) + drawn[:, :, :3]
        balance = grade.get("white_balance")
        if balance is not None:
            out = out * np.array(balance, dtype=np.float32)[None, None, :]
        held["grade"] = grade
        return out.astype(np.float32)

    def tonemap(hdr: Any, mode: Any = "filmic", exposure: Any = 0.0) -> Any:
        mapped = tone_map(hdr, mode, exposure)
        through, over = held.get("through"), held.get("over")
        if through is not None or over is not None:
            on_screen = film.linear_to_srgb(mapped)
            if through is not None:
                on_screen = on_screen * through + held["colour"] * (1.0 - through)
            if over is not None:
                on_screen = on_screen * (1.0 - np.clip(over[:, :, 3:], 0.0, 1.0)) + over[:, :, :3]
            on_screen = np.clip(on_screen, 0.0, 1.0)
            mapped = _light_of_screen(np, on_screen)
        grade = held.get("grade")
        return (_graded(np, film, mapped, grade) if grade else mapped).astype(np.float32)

    film.apply_depth_fog = apply_depth_fog
    film.tonemap = tonemap


def main(home: str, job_dir: str) -> int:
    folder = Path(job_dir)
    status_file = folder / "status.json"

    def report(state: str, progress: float = 0.0, message: str = "") -> None:
        scratch = folder / "status.tmp"
        scratch.write_text(json.dumps({"state": state, "progress": progress, "message": message[:240]}), encoding="utf-8")
        # Windows refuses while the host is reading the file. Progress can wait for the next report, and must never stop a
        # render; how it ended cannot wait, so that is tried for longer.
        attempts = 1 if state == "running" else _FINAL_REPORT_ATTEMPTS
        for attempt in range(attempts):
            try:
                os.replace(scratch, status_file)
                return
            except OSError:
                if attempt + 1 < attempts:
                    time.sleep(_FINAL_REPORT_WAIT_SECONDS)

    def on_update(state: object = "rendering", progress: object = 0.0, _samples: object = 0, _elapsed: object = 0.0, message: object = "", *_rest: object) -> None:
        report("running", float(progress) if isinstance(progress, (int, float)) else 0.0, str(message))

    report("running", 0.0, "Starting")
    try:
        sys.path.insert(0, home)
        from gi_renderer.engine import film
        from gi_renderer.engine.render import render_job
        from gi_renderer.engine.scene import load_image_linear

        _use_viewport_finish(film, load_image_linear)
        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        outcome = render_job(str(folder), config, on_update, (folder / "cancel").exists)
    except Exception:
        (folder / "error.log").write_text(traceback.format_exc(), encoding="utf-8")
        last = traceback.format_exc().strip().splitlines()[-1]
        report("failed", 0.0, last)
        return 1
    if (folder / "cancel").exists() or outcome == "cancelled":
        report("cancelled", 0.0, "")
    elif (folder / "final.png").is_file():
        report("succeeded", 1.0, "")
    else:
        report("failed", 0.0, "The render finished without a picture.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
