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
PACKAGED_CHANNELS = frozenset({"stable", "beta", "dev"})


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

    @classmethod
    def from_packaged_root(cls, frontend_root: Path, channel: str) -> "Paths":
        """Build release paths with mutable state outside the installed package."""
        if channel not in PACKAGED_CHANNELS:
            raise ValueError("unsupported packaged release channel")
        frontend = Path(frontend_root).expanduser().resolve(strict=True)
        if not frontend.is_dir() or frontend.name != "frontend":
            raise ValueError("packaged root must be the release frontend directory")
        local_app_data = os.environ.get("LOCALAPPDATA")
        if not local_app_data:
            raise OSError("LOCALAPPDATA is required for packaged startup")
        state = Path(local_app_data).expanduser().absolute() / "Auvra" / channel
        package = frontend.parent
        return cls(package, frontend, frontend / "package.json", frontend / "package-lock.json",
                   package / "runtime" / "node_modules", package / "runtime" / "node_modules" / "vite" / "bin" / "vite.js", state)

    @property
    def diagnostics_root(self) -> Path:
        """Launcher-owned local diagnostics; never a project or release file."""
        return self.launcher_state / "diagnostics"

    @property
    def packaged_webview2_sdk(self) -> Path:
        return self.repo_root / "runtime" / "webview2-sdk"

    @property
    def packaged_webview2_runtime(self) -> Path:
        return self.repo_root / "runtime" / "webview2"

    @property
    def packaged_native(self) -> Path:
        return self.repo_root / "native" / "auvra-native.exe"


def command_environment() -> dict[str, str]:
    """Return a normal inherited environment without exposing it in diagnostics."""

    return dict(os.environ)
