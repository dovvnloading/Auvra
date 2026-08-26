"""Frontend lockfile validation and narrowly scoped npm preparation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Callable, Mapping

from .config import Paths, command_environment
from .process import ProcessCleanupError, ProcessLaunchError, run_owned_command


@dataclass(frozen=True)
class DependencyState:
    status: str
    reason: str = ""
    package_name: str = ""
    lockfile_version: int | None = None

    @property
    def ready(self) -> bool:
        return self.status == "ready"

    @property
    def needs_install(self) -> bool:
        return self.status in {"missing", "stale", "damaged"}

    def to_dict(self) -> dict[str, object]:
        return asdict(self) | {"ready": self.ready, "needs_install": self.needs_install}


def _read_json(path: Path) -> tuple[dict[str, object] | None, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, f"missing {path.name}"
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return None, f"invalid {path.name}: {str(exc)[:120]}"
    if not isinstance(value, dict):
        return None, f"invalid {path.name}: root must be an object"
    return value, ""


def _requirements(package: Mapping[str, object]) -> tuple[dict[str, str], dict[str, str]]:
    def fields(name: str) -> dict[str, str]:
        value = package.get(name, {})
        return {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}
    return fields("dependencies"), fields("devDependencies")


def _is_link_like(path: Path) -> bool:
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def remove_scoped_tree(path: Path, *, parent: Path, expected_name: str) -> None:
    """Remove one exact direct child without following links or junctions."""

    lexical_path = Path(os.path.abspath(path))
    lexical_parent = Path(os.path.abspath(parent))
    if lexical_path.name != expected_name or lexical_path.parent != lexical_parent:
        raise OSError(f"refusing cleanup outside exact {expected_name} target")
    if _is_link_like(lexical_parent):
        raise OSError(f"refusing cleanup through linked parent: {lexical_parent}")
    if not lexical_path.exists() and not _is_link_like(lexical_path):
        return
    if _is_link_like(lexical_path):
        raise OSError(f"refusing to remove linked target: {lexical_path}")
    resolved_parent = lexical_parent.resolve(strict=True)
    resolved_path = lexical_path.resolve(strict=True)
    if resolved_path.parent != resolved_parent:
        raise OSError(f"refusing cleanup outside frontend root: {resolved_path}")
    shutil.rmtree(resolved_path)


def validate_lockfile(paths: Paths) -> DependencyState:
    if _is_link_like(paths.frontend_root):
        return DependencyState("inconsistent", "frontend root may not be a link or junction")
    package, package_error = _read_json(paths.package_json)
    if package is None:
        return DependencyState("inconsistent", package_error)
    lock, lock_error = _read_json(paths.package_lock)
    if lock is None:
        return DependencyState("inconsistent", lock_error)
    lock_version = lock.get("lockfileVersion")
    if lock_version != 3:
        return DependencyState("inconsistent", "package-lock.json must use lockfileVersion 3")
    root = lock.get("packages")
    root_entry = root.get("") if isinstance(root, dict) else None
    if not isinstance(root_entry, dict):
        return DependencyState("inconsistent", "package-lock.json has no root package entry")
    package_name = str(package.get("name", ""))
    if package_name != str(lock.get("name", "")) or package_name != str(root_entry.get("name", "")):
        return DependencyState("inconsistent", "package name differs between package.json and lockfile")
    if str(package.get("version", "")) != str(lock.get("version", "")):
        return DependencyState("inconsistent", "package version differs between package.json and lockfile")
    if str(package.get("version", "")) != str(root_entry.get("version", "")):
        return DependencyState("inconsistent", "package version differs from package-lock root")
    prod, dev = _requirements(package)
    lock_prod, lock_dev = _requirements(root_entry)
    if prod != lock_prod or dev != lock_dev:
        return DependencyState("inconsistent", "direct dependencies differ from package-lock root")
    if package.get("engines", {}) != root_entry.get("engines", {}):
        return DependencyState("inconsistent", "runtime engines differ from package-lock root")
    packages = root
    if not isinstance(packages, dict):
        return DependencyState("inconsistent", "package-lock.json packages is not an object")
    for name in (*prod.keys(), *dev.keys()):
        entry = packages.get(f"node_modules/{name}")
        if not isinstance(entry, dict) or not entry.get("version"):
            return DependencyState("inconsistent", f"lockfile is missing direct dependency {name}")
    return DependencyState("valid", "lockfile is consistent", package_name, 3)


def inspect_dependencies(paths: Paths) -> DependencyState:
    lock_state = validate_lockfile(paths)
    if lock_state.status != "valid":
        return lock_state
    if not paths.node_modules.exists():
        return DependencyState("missing", "node_modules does not exist", lock_state.package_name, 3)
    if _is_link_like(paths.node_modules):
        return DependencyState("damaged", "node_modules may not be a link or junction", lock_state.package_name, 3)
    if not paths.node_modules.is_dir():
        return DependencyState("damaged", "node_modules is not a directory", lock_state.package_name, 3)
    hidden_lock = paths.node_modules / ".package-lock.json"
    installed_lock, error = _read_json(hidden_lock)
    if installed_lock is None:
        return DependencyState("damaged", error, lock_state.package_name, 3)
    if installed_lock.get("lockfileVersion") != 3:
        return DependencyState("stale", "installed dependency lockfile is not v3", lock_state.package_name, 3)
    installed_packages = installed_lock.get("packages")
    locked_document, lock_error = _read_json(paths.package_lock)
    package_document, package_error = _read_json(paths.package_json)
    if locked_document is None or package_document is None:
        return DependencyState(
            "inconsistent",
            lock_error or package_error or "dependency metadata changed during inspection",
            lock_state.package_name,
            3,
        )
    locked_packages = locked_document.get("packages")
    if not isinstance(installed_packages, dict) or not isinstance(locked_packages, dict):
        return DependencyState("damaged", "installed dependency lockfile is malformed", lock_state.package_name, 3)
    # npm's hidden lock omits the empty root-package entry. Its top-level name
    # and version still identify the install, while the package inventory below
    # is compared against the committed lockfile.
    if (installed_lock.get("name"), installed_lock.get("version")) != (
        lock_state.package_name, package_document.get("version")):
        return DependencyState("stale", "installed dependency metadata is stale", lock_state.package_name, 3)
    required_lock_paths = {
        key for key, value in locked_packages.items()
        if key and isinstance(value, dict) and not value.get("optional")
    }
    if not required_lock_paths.issubset(installed_packages) or not set(installed_packages).issubset(set(locked_packages) - {""}):
        return DependencyState("stale", "installed dependency inventory differs from lockfile", lock_state.package_name, 3)
    for package_path, expected in locked_packages.items():
        if not package_path or not isinstance(expected, dict):
            continue
        installed = installed_packages.get(package_path)
        if installed is None and expected.get("optional"):
            continue
        if not isinstance(installed, dict) or installed != expected:
            return DependencyState("stale", f"installed {package_path} is not lockfile version", lock_state.package_name, 3)
        module_root = paths.frontend_root
        for part in Path(*package_path.split("/")).parts:
            module_root /= part
            if _is_link_like(module_root):
                return DependencyState(
                    "damaged",
                    f"installed dependency {package_path} may not traverse a link or junction",
                    lock_state.package_name,
                    3,
                )
        module_json = module_root / "package.json"
        actual, module_error = _read_json(module_json)
        if actual is None:
            return DependencyState(
                "damaged",
                f"installed {package_path} is damaged: {module_error}",
                lock_state.package_name,
                3,
            )
        if str(actual.get("version")) != str(expected.get("version")):
            return DependencyState(
                "stale",
                f"installed {package_path}/package.json is stale",
                lock_state.package_name,
                3,
            )
    if _is_link_like(paths.vite_script):
        return DependencyState("damaged", "vite launcher may not be a link", lock_state.package_name, 3)
    if not paths.vite_script.is_file():
        return DependencyState("damaged", "vite launcher is missing", lock_state.package_name, 3)
    return DependencyState("ready", "installed dependencies match package-lock.json", lock_state.package_name, 3)


def _run_npm(
    paths: Paths,
    npm: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = run_owned_command,
) -> subprocess.CompletedProcess[str]:
    return runner(
        [npm, "ci", "--no-audit", "--no-fund"], cwd=str(paths.frontend_root),
        env=command_environment(), shell=False, check=False, text=True,
        encoding="utf-8", errors="replace",
        timeout=900.0,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )


def prepare_dependencies(
    paths: Paths,
    npm: str,
    *,
    repair: bool = False,
    runner: Callable[..., subprocess.CompletedProcess[str]] = run_owned_command,
) -> tuple[bool, DependencyState, str]:
    """Prepare only from the committed lockfile; return success/state/output."""

    lock_state = validate_lockfile(paths)
    if lock_state.status != "valid":
        return False, lock_state, ""
    state = inspect_dependencies(paths)
    if repair:
        remove_scoped_tree(
            paths.node_modules,
            parent=paths.frontend_root,
            expected_name="node_modules",
        )
        state = DependencyState("missing", "repair requested", lock_state.package_name, 3)
    if state.ready:
        return True, state, ""
    if not state.needs_install:
        return False, state, ""
    try:
        result = _run_npm(paths, npm, runner=runner)
    except subprocess.TimeoutExpired as exc:
        return False, state, f"npm ci timed out after {exc.timeout} seconds"
    except (ProcessCleanupError, ProcessLaunchError) as exc:
        return False, state, f"npm ci process ownership failed: {str(exc)[:160]}"
    output = result.stdout or ""
    after = inspect_dependencies(paths)
    if result.returncode != 0:
        return False, after, output
    return after.ready, after, output
