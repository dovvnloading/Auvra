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
_LEAST_SKY_SHARE = 0.05


def fog_transmittance(distance: Any, fog: dict[str, Any], exp: Callable[[Any], Any], clip: Callable[[Any, float, float], Any]) -> Any:
    """How much of what is at a distance comes through a fog, by the viewport's own law. For numbers or for arrays."""
    if fog.get("kind") == "linear":
        near, far = float(fog["near"]), float(fog["far"])
        return 1.0 - clip((distance - near) / (far - near), 0.0, 1.0)
    density = float(fog.get("density", 0.0))
    return exp(-(density * distance) ** 2)


def sky_light_share(fill: float, sky: float) -> float:
    """
    How much of its own light a sky should give, for what it lights to come out as in the viewport. There a plain fill stands in
    for the sky, a good deal dimmer than a real one of that brightness: at full strength a frame is washed out, its shadows pale.
    """
    if sky <= 0.0:
        return 1.0
    return max(_LEAST_SKY_SHARE, min(1.0, fill / sky))


def _balance_sky(config: dict[str, Any], load_image: Callable[[str], Any]) -> None:
    """Lights the frame with as much as the viewport's fill gives, and notes how far that leaves the sky to be brought back up to what it should show."""
    finish = config.get("volumetric_fog")
    environment = config.get("environment")
    if not isinstance(finish, dict) or "sky_fill" not in finish or not isinstance(environment, dict) or not environment.get("hdri_path"):
        return
    image = load_image(environment["hdri_path"])
    above = image[: image.shape[0] // 2]
    brightness = float((0.2126 * above[:, :, 0] + 0.7152 * above[:, :, 1] + 0.0722 * above[:, :, 2]).mean())
    intensity = float(environment.get("intensity", 1.0))
    share = sky_light_share(float(finish["sky_fill"]), brightness * intensity)
    environment["intensity"] = intensity * share
    finish["sky_shown"] = 1.0 / share


def _sky_in_each_pixel(np: Any, distance: Any) -> Any:
    """How much of each pixel is sky. Distance is averaged over every sample, the ones that met nothing counting as none, so a pixel on an object's edge reads as near as it is covered."""
    padded = np.pad(distance, 1, mode="edge")
    around = [padded[1 + y:padded.shape[0] - 1 + y, 1 + x:padded.shape[1] - 1 + x] for y in (-1, 0, 1) for x in (-1, 0, 1)]
    farthest = np.max(around, axis=0)
    beside_sky = np.min(around, axis=0) <= 0.0
    covered = np.where(beside_sky, distance / np.maximum(farthest, 1e-6), 1.0)
    return np.where(distance <= 0.0, 1.0, 1.0 - np.clip(covered, 0.0, 1.0))


def _use_viewport_finish(film: Any) -> None:
    """
    Puts on a frame what brings it to the view, where the renderer hands over its light and depth for fog. Its own fog thins by
    another law and goes on before tone mapping, where the viewport's goes on after, in the colours on screen.
    """
    import numpy as np

    fog: dict[str, Any] = {}
    tone_map = film.tonemap

    def apply_depth_fog(hdr: Any, depth: Any, finish: Any) -> Any:
        if not isinstance(finish, dict) or not finish.get("enabled"):
            return hdr
        distance = depth.reshape(hdr.shape[0], hdr.shape[1]).astype(np.float32)
        sky = _sky_in_each_pixel(np, distance)
        if finish.get("kind") in {"squared", "linear"}:
            # Sky has no fog in the viewport. A pixel on an edge is as far as what covers it.
            far = distance / np.maximum(1.0 - sky, 1e-3)
            fog["through"] = (sky + (1.0 - sky) * fog_transmittance(far, finish, np.exp, np.clip))[:, :, None]
            fog["color"] = film.linear_to_srgb(np.array(finish["color"][:3], dtype=np.float32))
        shown = float(finish.get("sky_shown", 1.0))
        return (hdr * (1.0 + sky * (shown - 1.0))[:, :, None]).astype(np.float32) if shown != 1.0 else hdr

    def tonemap(hdr: Any, mode: Any = "filmic", exposure: Any = 0.0) -> Any:
        mapped = tone_map(hdr, mode, exposure)
        through = fog.get("through")
        if through is None or through.shape[:2] != mapped.shape[:2]:
            return mapped
        on_screen = film.linear_to_srgb(mapped) * through + fog["color"][None, None, :] * (1.0 - through)
        return np.where(on_screen <= 0.04045, on_screen / 12.92, np.power((on_screen + 0.055) / 1.055, 2.4)).astype(np.float32)

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

        _use_viewport_finish(film)
        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        _balance_sky(config, load_image_linear)
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
