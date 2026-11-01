"""Reframe, a path tracer on this computer, as a provider of finished frames.

It is a separate program with its own Python and its own graphics-card packages, so each render runs as a process of its own,
from a folder made for it: nothing here imports it. The editor sends one bundle holding the scene. Only what is known is taken
from that bundle into the renderer's settings, and the paths in those settings are ones made here, as the bundle comes from the
editor's page and the settings name files for the renderer to read.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, BinaryIO, Mapping

from Auvra.diagnostics.core import trace_public_class

from .adapters import Adapter, MediaJob
from .descriptors import Capability
from .errors import ErrorCode, ProviderError
from .media import MediaArtifact

MODEL = "path-tracer"
HOME_VARIABLE = "AUVRA_REFRAME_HOME"
PYTHON_VARIABLE = "AUVRA_REFRAME_PYTHON"
_BUNDLE_MAGIC = b"AUVRARB1"
_MAX_HEADER_BYTES = 16 * 1024 * 1024
_MAX_MESHES = 4096
_MAX_LIGHTS = 256
_MAX_SIZE = 8192
_MAX_SAMPLES = 65536
_MAX_BOUNCES = 64
_CHUNK = 1024 * 1024
_ENGINE_FILE = Path("gi_renderer") / "engine" / "render.py"
_RENDER_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# How long a render gets to stop by itself. It only looks between samples, and not at all while compiling kernels.
_STOP_GRACE_SECONDS = 5.0
_MATERIAL_TEXTURES = {"baseColorTexture": "baseColorTexture", "normalTexture": "normalMap", "roughnessTexture": "roughnessTexture", "metallicTexture": "metallicTexture"}


def find_home() -> Path | None:
    """Where Reframe is: where the variable says, or where it is usually kept."""
    named = os.environ.get(HOME_VARIABLE, "").strip()
    candidates = [Path(named)] if named else []
    candidates.append(Path.home() / "source" / "repos" / "Reframe-Diffused" / "Reframe-Diffused")
    return next((folder for folder in candidates if (folder / _ENGINE_FILE).is_file()), None)


def find_python(home: Path) -> str | None:
    """An interpreter that can run Reframe: the one named, the one in its folder, or the one on the path."""
    named = os.environ.get(PYTHON_VARIABLE, "").strip()
    if named:
        return named
    own = home / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    return str(own) if own.is_file() else shutil.which("python") or shutil.which("python3")


def _number(value: Any, fallback: float, low: float = -1e9, high: float = 1e9) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return fallback
    return float(max(low, min(high, value)))


def _triple(value: Any, fallback: tuple[float, float, float], low: float = -1e9, high: float = 1e9) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return list(fallback)
    return [_number(item, fallback[index], low, high) for index, item in enumerate(value)]


def read_bundle_header(stream: BinaryIO) -> tuple[dict[str, Any], int]:
    """The scene description at the start of a bundle, and where its data starts."""
    if stream.read(len(_BUNDLE_MAGIC)) != _BUNDLE_MAGIC:
        raise ProviderError(ErrorCode.INVALID_REQUEST, "the scene could not be read", "reframe")
    length = struct.unpack("<I", stream.read(4))[0]
    if length > _MAX_HEADER_BYTES:
        raise ProviderError(ErrorCode.INVALID_REQUEST, "the scene description is too large", "reframe")
    try:
        header = json.loads(stream.read(length).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ProviderError(ErrorCode.INVALID_REQUEST, "the scene could not be read", "reframe") from exc
    if not isinstance(header, dict):
        raise ProviderError(ErrorCode.INVALID_REQUEST, "the scene could not be read", "reframe")
    return header, len(_BUNDLE_MAGIC) + 4 + length


class _Blobs:
    """Copies the parts of a bundle out to files in the job's folder, by where the header says they are."""

    def __init__(self, stream: BinaryIO, start: int, total: int, folder: Path) -> None:
        self.stream, self.start, self.total, self.folder = stream, start, total, folder
        self.count = 0

    def _span(self, reference: Any) -> tuple[int, int]:
        if not isinstance(reference, Mapping):
            raise ProviderError(ErrorCode.INVALID_REQUEST, "the scene could not be read", "reframe")
        offset, length = reference.get("offset"), reference.get("length")
        if (isinstance(offset, bool) or isinstance(length, bool) or not isinstance(offset, int) or not isinstance(length, int)
                or offset < 0 or length <= 0 or self.start + offset + length > self.total):
            raise ProviderError(ErrorCode.INVALID_REQUEST, "the scene could not be read", "reframe")
        return offset, length

    def write(self, reference: Any, suffix: str) -> Path:
        offset, length = self._span(reference)
        self.count += 1
        target = self.folder / f"part{self.count}{suffix}"
        self.stream.seek(self.start + offset)
        with target.open("wb") as sink:
            left = length
            while left:
                chunk = self.stream.read(min(_CHUNK, left))
                if not chunk:
                    raise ProviderError(ErrorCode.INVALID_REQUEST, "the scene could not be read", "reframe")
                sink.write(chunk)
                left -= len(chunk)
        return target

    def picture(self, reference: Any) -> str:
        offset, length = self._span(reference)
        self.stream.seek(self.start + offset)
        return "data:image/png;base64," + base64.b64encode(self.stream.read(length)).decode("ascii")


def _material(raw: Any, blobs: _Blobs) -> dict[str, Any]:
    source = raw if isinstance(raw, Mapping) else {}
    material: dict[str, Any] = {
        "type": "pbr",
        "baseColor": _triple(source.get("baseColor"), (0.8, 0.8, 0.8), 0.0, 1.0),
        "roughness": _number(source.get("roughness"), 0.6, 0.0, 1.0),
        "metallic": _number(source.get("metallic"), 0.0, 0.0, 1.0),
        "opacity": _number(source.get("opacity"), 1.0, 0.0, 1.0),
    }
    emission = _triple(source.get("emission"), (0.0, 0.0, 0.0), 0.0, 1000.0)
    if any(emission):
        material["emission"] = emission
    for key, field in _MATERIAL_TEXTURES.items():
        if source.get(key) is not None:
            material[field] = blobs.picture(source[key])
    return material


def build_render_config(header: Mapping[str, Any], settings: Mapping[str, Any], blobs: _Blobs) -> dict[str, Any]:
    """The renderer's settings for a scene: only what is known, and only paths to files made here."""
    meshes = header.get("meshes")
    if not isinstance(meshes, list) or not meshes or len(meshes) > _MAX_MESHES:
        raise ProviderError(ErrorCode.INVALID_REQUEST, "there is nothing in view to render", "reframe")
    objects: list[dict[str, Any]] = []
    for mesh in meshes:
        if not isinstance(mesh, Mapping):
            raise ProviderError(ErrorCode.INVALID_REQUEST, "the scene could not be read", "reframe")
        objects.append({
            "type": "mesh", "meshEncoding": "float32_file_v1",
            "positionsPath": str(blobs.write(mesh.get("positions"), ".bin")),
            "uvsPath": str(blobs.write(mesh.get("uvs"), ".bin")),
            "normalsPath": str(blobs.write(mesh.get("normals"), ".bin")),
            "material": _material(mesh.get("material"), blobs),
        })
    lights: list[dict[str, Any]] = []
    for raw in (header.get("lights") if isinstance(header.get("lights"), list) else [])[:_MAX_LIGHTS]:
        if not isinstance(raw, Mapping) or raw.get("type") not in {"directional", "point", "spot"}:
            continue
        light: dict[str, Any] = {"type": raw["type"], "color": _triple(raw.get("color"), (1.0, 1.0, 1.0), 0.0, 1000.0), "intensity": _number(raw.get("intensity"), 1.0, 0.0, 1e7)}
        if raw["type"] == "directional":
            light["direction"] = _triple(raw.get("direction"), (0.0, -1.0, 0.0))
            light["angle"] = _number(raw.get("angle"), 2.0, 0.0, 45.0)
        else:
            light["position"] = _triple(raw.get("position"), (0.0, 1.0, 0.0))
        if raw["type"] == "spot":
            light["direction"] = _triple(raw.get("direction"), (0.0, -1.0, 0.0))
            light["cone_angle"] = _number(raw.get("angle"), 30.0, 0.0, 180.0)
        lights.append(light)
    camera = header.get("camera") if isinstance(header.get("camera"), Mapping) else {}
    raw_environment = header.get("environment") if isinstance(header.get("environment"), Mapping) else {}
    environment: dict[str, Any] = {
        "background": _triple(raw_environment.get("background"), (0.5, 0.55, 0.62), 0.0, 100.0),
        "intensity": _number(raw_environment.get("intensity"), 1.0, 0.0, 100.0),
    }
    if raw_environment.get("panorama") is not None:
        environment["hdri_path"] = str(blobs.write(raw_environment["panorama"], ".png"))
        environment["rotation_deg"] = _number(raw_environment.get("rotation"), 0.0, -360000.0, 360000.0)
    return {
        "scene": "custom", "schema_version": 1, "device": "gpu", "backend": "cuda", "tone_map": "aces", "denoise": settings.get("denoise") is True,
        "width": int(_number(settings.get("width"), 960, 16, _MAX_SIZE)),
        "height": int(_number(settings.get("height"), 540, 16, _MAX_SIZE)),
        "samples_per_pixel": int(_number(settings.get("samples"), 64, 1, _MAX_SAMPLES)),
        "max_bounces": int(_number(settings.get("bounces"), 6, 1, _MAX_BOUNCES)),
        "objects": objects, "lights": lights, "environment": environment,
        "camera": {
            "projection": "perspective", "dof_enabled": False,
            "lookfrom": _triple(camera.get("position"), (0.0, 2.0, 5.0)),
            "lookat": _triple(camera.get("target"), (0.0, 1.0, 0.0)),
            "vfov": _number(camera.get("fov"), 45.0, 1.0, 170.0),
        },
    }


@trace_public_class("provider_reframe", concise=("submit", "cancel", "status"))
class ReframeAdapter(Adapter):
    provider_id = "reframe"
    # A long render is a long render: it is on this computer, and costs nothing to wait for.
    poll_limit_seconds = 12 * 60 * 60

    def __init__(self, transport: Any, *, credential_store: Any = None, registry: Any = None, endpoint: str | None = None, jobs_root: Path | None = None) -> None:
        super().__init__(transport, credential_store=credential_store, registry=registry, endpoint=endpoint)
        self._jobs_root = Path(jobs_root) if jobs_root is not None else Path.home() / ".auvra-render-jobs"
        self._cache = self._jobs_root.parent / "render-cache"
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._stops: dict[str, float] = {}
        # What an earlier run left: nothing can come back for it.
        shutil.rmtree(self._jobs_root, ignore_errors=True)

    def health(self) -> bool:
        home = find_home()
        return home is not None and find_python(home) is not None

    def list_models(self) -> tuple[str, ...]:
        return (MODEL,)

    def _folder(self, job_id: str) -> Path:
        if not job_id.isalnum():
            raise ProviderError(ErrorCode.INVALID_REQUEST, "render job is invalid", self.provider_id)
        return self._jobs_root / job_id

    def upload_input(self, *, source: BinaryIO, size: int, filename: str = "input.bin", content_type: str = "application/octet-stream") -> str:
        job_id = uuid.uuid4().hex
        folder = self._folder(job_id)
        folder.mkdir(parents=True)
        with (folder / "bundle.bin").open("wb") as sink:
            shutil.copyfileobj(source, sink, _CHUNK)
        return job_id

    def media_request(self, *, model: str, prompt: str, images: list[str], size: tuple[int, int] | None = None, mesh: str | None = None) -> dict[str, Any]:
        if not images:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "there is no scene to render", self.provider_id)
        try:
            settings = json.loads(prompt or "{}")
        except ValueError as exc:
            raise ProviderError(ErrorCode.INVALID_REQUEST, "the render settings could not be read", self.provider_id) from exc
        return {"job": images[0], "settings": settings if isinstance(settings, dict) else {}}

    def submit(self, *, model: str, payload: Mapping[str, Any], capability: Capability | str = Capability.MEDIA_RENDER) -> MediaJob:
        home = find_home()
        python = find_python(home) if home is not None else None
        if home is None or python is None:
            raise ProviderError(ErrorCode.UNSUPPORTED_CAPABILITY, "Reframe was not found on this computer", self.provider_id)
        job_id = str(payload["job"])
        folder = self._folder(job_id)
        bundle = folder / "bundle.bin"
        with bundle.open("rb") as stream:
            header, start = read_bundle_header(stream)
            config = build_render_config(header, payload.get("settings") or {}, _Blobs(stream, start, bundle.stat().st_size, folder))
        bundle.unlink()
        (folder / "config.json").write_text(json.dumps(config), encoding="utf-8")
        with (folder / "worker.log").open("wb") as log:
            process = subprocess.Popen(
                [python, str(Path(__file__).with_name("reframe_worker.py")), str(home), str(folder)],
                cwd=folder, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=_RENDER_FLAGS,
                # Nothing of a run is written in Reframe's own folder. Compiled kernels are kept, as compiling them takes minutes.
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "NUMBA_CACHE_DIR": str(self._cache)},
            )
        self._processes[job_id] = process
        return MediaJob(self.provider_id, model, job_id)

    def status(self, job: MediaJob) -> Mapping[str, Any]:
        folder = self._folder(job.request_id)
        try:
            said = json.loads((folder / "status.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            said = {"state": "running", "progress": 0.0}
        process = self._processes.get(job.request_id)
        stop_asked = self._stops.get(job.request_id)
        if stop_asked is not None and said.get("state") == "running":
            if process is None or process.poll() is not None:
                said = {"state": "cancelled"}
            elif time.monotonic() - stop_asked > _STOP_GRACE_SECONDS:
                process.kill()
        elif said.get("state") == "running" and process is not None and process.poll() is not None:
            # It ended without saying how: it did not start, or was killed.
            said = {"state": "failed", "message": self._last_words(folder)}
        return {"status": said.get("state", "running"), "progress": said.get("progress"), "error": said.get("message") if said.get("state") == "failed" else None}

    @staticmethod
    def _last_words(folder: Path) -> str:
        try:
            lines = (folder / "worker.log").read_text(encoding="utf-8", errors="replace").strip().splitlines()
        except OSError:
            return "The renderer stopped unexpectedly."
        return lines[-1][:240] if lines else "The renderer stopped unexpectedly."

    @staticmethod
    def status_state(value: Mapping[str, Any]) -> str:
        return str(value.get("status", "running"))

    def result(self, job: MediaJob) -> Mapping[str, Any]:
        self._processes.pop(job.request_id, None)
        return {"images": [{"url": job.request_id, "content_type": "image/png"}]}

    def download_output(self, url: str, *, sink: Any, expected_sha256: str | None = None, expected_size: int | None = None) -> MediaArtifact:
        folder = self._folder(url)
        digest = hashlib.sha256()
        size = 0
        with (folder / "final.png").open("rb") as source:
            while chunk := source.read(_CHUNK):
                sink.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        shutil.rmtree(folder, ignore_errors=True)
        return MediaArtifact(url, "image/png", size, digest.hexdigest())

    def cancel(self, job: MediaJob) -> bool:
        folder = self._folder(job.request_id)
        if folder.is_dir():
            (folder / "cancel").touch()
        self._stops.setdefault(job.request_id, time.monotonic())
        return True
