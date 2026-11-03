"""Models prepared for game builds, kept per user and shared across projects.

The editor prepares a model once, in a worker, and uploads the result here
before it asks for a build; each build copies what it names into its game pack.
A prepared model is named by a key made from its source asset and what was baked
into it, so nothing here belongs to a project and nothing is ever exported with
one.  Losing a file only means the next build prepares that model again.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
from typing import Iterable

from Auvra.diagnostics import trace_public_class

from .assets import AssetUpload


PREPARED_MODEL_MIME = "model/gltf-binary"
# Past this, what was used longest ago goes after a build.
DEFAULT_CAPACITY_BYTES = 16 * 1024**3
_KEY = re.compile(r"^[0-9a-f]{64}$")
_CHUNK_SIZE = 1024 * 1024


@trace_public_class("prepared_models", concise=("available", "read"))
class PreparedModelStore:
    """Own the ``<key>.glb`` files in one folder and the hash saved beside each."""

    def __init__(self, root: Path, *, capacity_bytes: int = DEFAULT_CAPACITY_BYTES) -> None:
        self._root = Path(root)
        self._capacity = capacity_bytes

    def _model_path(self, key: str) -> Path:
        if not isinstance(key, str) or not _KEY.fullmatch(key):
            raise ValueError("prepared model key is invalid")
        return self._root / f"{key}.glb"

    def available(self, keys: Iterable[str]) -> list[str]:
        """The ``keys`` held here; each counts as just used, so it is not the next to go."""

        found: list[str] = []
        for key in keys:
            model = self._model_path(key)
            if model.is_file() and model.with_suffix(".sha256").is_file():
                try:
                    os.utime(model)
                except OSError:
                    pass
                found.append(key)
        return found

    def ingest(self, key: str, upload: AssetUpload) -> None:
        """Take over a finished upload, whole or not at all, and save its hash."""

        model = self._model_path(key)
        self._root.mkdir(parents=True, exist_ok=True)
        saved = model.with_suffix(".sha256")
        staged = model.with_suffix(".sha256.tmp")
        staged.write_text(upload.sha256, encoding="ascii")
        os.replace(staged, saved)
        os.replace(upload.path, model)

    def read(self, key: str) -> bytes | None:
        """A model's bytes; None when it is gone or no longer matches its saved hash, then deleted."""

        model = self._model_path(key)
        saved = model.with_suffix(".sha256")
        try:
            expected = saved.read_text(encoding="ascii").strip()
            data = model.read_bytes()
        except (OSError, ValueError):
            self._delete(key)
            return None
        if hashlib.sha256(data).hexdigest() != expected:
            self._delete(key)
            return None
        return data

    def trim(self, keep: Iterable[str] = ()) -> None:
        """Deletes what was used longest ago until the folder fits, never the models in ``keep``."""

        kept = set(keep)
        entries: list[tuple[float, int, str]] = []
        total = 0
        try:
            for path in self._root.glob("*.glb"):
                stat = path.stat()
                total += stat.st_size
                if path.stem not in kept:
                    entries.append((stat.st_mtime, stat.st_size, path.stem))
        except OSError:
            return
        for _used, size, key in sorted(entries):
            if total <= self._capacity:
                return
            self._delete(key)
            total -= size

    def _delete(self, key: str) -> None:
        model = self._model_path(key)
        for path in (model, model.with_suffix(".sha256")):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
