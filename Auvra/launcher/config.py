"""Immutable launcher paths and policy constants."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_ROOT = REPO_ROOT / "fbx-viewer (1)"
PACKAGE_JSON = FRONTEND_ROOT / "package.json"
PACKAGE_LOCK = FRONTEND_ROOT / "package-lock.json"
NODE_MODULES = FRONTEND_ROOT / "node_modules"
VITE_SCRIPT = NODE_MODULES / "vite" / "bin" / "vite.js"
LAUNCHER_STATE = FRONTEND_ROOT / ".auvra-launcher"
HOST = "127.0.0.1"
DEFAULT_PORT = 3000
PORT_RANGE = range(3001, 3100)
READINESS_TIMEOUT = 30.0


@dataclass(frozen=True)
class Paths:
    """Paths are explicit so callers are independent of the current cwd."""

    repo_root: Path = REPO_ROOT
    frontend_root: Path = FRONTEND_ROOT
    package_json: Path = PACKAGE_JSON
    package_lock: Path = PACKAGE_LOCK
    node_modules: Path = NODE_MODULES
    vite_script: Path = VITE_SCRIPT
    launcher_state: Path = LAUNCHER_STATE

    @classmethod
    def from_repo_root(cls, root: Path) -> "Paths":
        root = root.resolve()
        frontend = root / "fbx-viewer (1)"
        modules = frontend / "node_modules"
        return cls(root, frontend, frontend / "package.json", frontend / "package-lock.json",
                   modules, modules / "vite" / "bin" / "vite.js", frontend / ".auvra-launcher")


def command_environment() -> dict[str, str]:
    """Return a normal inherited environment without exposing it in diagnostics."""

    return dict(os.environ)
