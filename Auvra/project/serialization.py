"""Deterministic JSON serialization used by every project document."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, IO

def _finite(value: Any) -> Any:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite numbers are not valid project data")
        return value
    if isinstance(value, dict):
        if any(not isinstance(k, str) for k in value):
            raise ValueError("project object keys must be strings")
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value

def canonical_json(value: Any) -> str:
    """Return UTF-8-ready JSON with sorted keys, LF, and no NaN/Infinity."""
    return json.dumps(_finite(value), ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False) + "\n"

def dump_json(path: str | os.PathLike[str], value: Any, *, fsync: bool = True) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    data = canonical_json(value).encode("utf-8")
    with target.open("wb") as stream:
        stream.write(data)
        stream.flush()
        if fsync:
            os.fsync(stream.fileno())

def atomic_dump_json(path: str | os.PathLike[str], value: Any) -> None:
    """Write and publish a JSON file atomically on its containing volume."""
    target = Path(path)
    temp = target.with_name(f".{target.name}.tmp-{os.getpid()}-{id(value)}")
    try:
        dump_json(temp, value, fsync=True)
        os.replace(temp, target)
        try:
            fd = os.open(target.parent, os.O_RDONLY); os.fsync(fd); os.close(fd)
        except OSError:
            pass
    finally:
        try: temp.unlink()
        except FileNotFoundError: pass

def load_json(path: str | os.PathLike[str]) -> Any:
    with Path(path).open("r", encoding="utf-8", newline="") as stream:
        value = json.load(stream, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
    _finite(value)
    return value
