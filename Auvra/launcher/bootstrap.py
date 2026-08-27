"""Stdlib-only, crash-safe bootstrap for Auvra's locked Python environment."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
import errno
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
from typing import Callable, Iterator, Sequence

from .process import OwnedProcess, ProcessCleanupError, run_owned_command

UV_VERSION = "0.12.5"
BOOTSTRAP_EXIT_CODE = 11
BOOTSTRAP_MARKER = "AUVRA_BOOTSTRAP_INTERPRETER"
OWNERSHIP_MARKER_NAME = ".auvra-managed.json"
INITIALIZING_MARKER_NAME = ".auvra-initializing.json"
CLAIM_NAME = "bootstrap.claim"
LOCK_TIMEOUT_SECONDS = 120.0
COMMAND_TIMEOUT_SECONDS = 900.0
# A lock must remain valid for longer than the maximum finite child command.
LOCK_STALE_SECONDS = COMMAND_TIMEOUT_SECONDS + 300.0
MAX_OUTPUT_BYTES = 4096

_VERSION_RE = re.compile(r"(?:^|\s)uv\s+(\d+\.\d+\.\d+)(?:\s|$)", re.I)
_SECRET_RE = re.compile(
    r"(?ix)([\"']?[\w.-]*(?:api[_-]?key|anon[_-]?key|access[_-]?key|private[_-]?key|"
    r"fal[_-]?key|token|password|secret|credential)[\w.-]*[\"']?\s*[:=]\s*)"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"
)
_BEARER_RE = re.compile(r"(?i)(\bbearer\s+)(?:\"[^\"]*\"|'[^']*'|[^\s,;\]\}\"]+)")
_URL_CREDENTIAL_RE = re.compile(r"(?i)(https?://)([^/@\s:]+)(?::([^/@\s]+))?@")
_PYTHON_INJECTION_VARS = frozenset({
    "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT",
    "PYTHONUSERBASE", "PYTHONEXECUTABLE", "PYTHONWARNINGS",
    "PYTHONPYCACHEPREFIX", "PYTHONSAFEPATH",
})
_PROBE = (
    "import json,sys; print(json.dumps({"
    "'implementation':sys.implementation.name,'version':list(sys.version_info[:2]),"
    "'prefix':sys.prefix,'base_prefix':sys.base_prefix,'executable':sys.executable}))"
)


class BootstrapError(RuntimeError):
    """A bounded, actionable failure while preparing the managed environment."""


@dataclass(frozen=True, slots=True)
class BootstrapPaths:
    repo_root: Path
    entrypoint: Path
    state_root: Path
    bootstrap_env: Path
    target_env: Path
    lock_path: Path

    @classmethod
    def from_entrypoint(cls, entrypoint: Path | str) -> "BootstrapPaths":
        entry = _absolute(Path(entrypoint))
        repo = entry.parent.parent
        frontend = repo / "fbx-viewer (1)"
        state = frontend / ".auvra-launcher"
        return cls(repo, entry, state, state / "bootstrap-venv", repo / ".venv", state / "bootstrap.lock")


Runner = Callable[..., object]
Clock = Callable[[], float]
Sleeper = Callable[[float], None]


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _link_like(path: Path) -> bool:
    try:
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            return True
        attrs = path.stat().st_file_attributes
    except (AttributeError, FileNotFoundError):
        return False
    except OSError as exc:
        raise BootstrapError("cannot inspect a bootstrap path") from exc
    return bool(attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _assert_tree(path: Path, *, root: Path | None = None, allow_missing_leaf: bool = False,
                 allow_final_link: bool = False) -> Path:
    """Validate existing components without resolving through links."""
    candidate = _absolute(path)
    if root is not None:
        root_abs = _absolute(root)
        try:
            candidate.relative_to(root_abs)
        except ValueError as exc:
            raise BootstrapError("bootstrap path escapes the repository") from exc
    current = Path(candidate.anchor)
    parts = candidate.parts[1:]
    for index, component in enumerate(parts):
        current /= component
        exists = current.exists() or current.is_symlink()
        if not exists:
            if allow_missing_leaf and index == len(parts) - 1:
                break
            continue
        if _link_like(current) and not (allow_final_link and index == len(parts) - 1):
            raise BootstrapError("bootstrap paths may not contain symlinks, junctions, or reparse points")
    return candidate


def _validate_paths(paths: BootstrapPaths) -> BootstrapPaths:
    repo = _assert_tree(paths.repo_root)
    if not repo.is_dir():
        raise BootstrapError("repository root is not a directory")
    entry = _assert_tree(paths.entrypoint, root=repo)
    if not entry.is_file():
        raise BootstrapError("launcher entry point is missing")
    _assert_tree(repo / "fbx-viewer (1)", root=repo)
    state = _assert_tree(paths.state_root, root=repo, allow_missing_leaf=True)
    bootstrap_env = _assert_tree(paths.bootstrap_env, root=repo, allow_missing_leaf=True)
    target_env = _assert_tree(paths.target_env, root=repo, allow_missing_leaf=True)
    lock = _assert_tree(paths.lock_path, root=repo, allow_missing_leaf=True)
    return BootstrapPaths(repo, entry, state, bootstrap_env, target_env, lock)


def _revalidate(paths: BootstrapPaths, *extra: Path) -> None:
    _validate_paths(paths)
    for item in extra:
        _assert_tree(item, root=paths.repo_root, allow_missing_leaf=True)


def _mkdir_safe(path: Path) -> None:
    path = _assert_tree(path, allow_missing_leaf=True)
    missing: list[Path] = []
    current = path
    while not current.exists():
        missing.append(current)
        if current.parent == current:
            break
        current = current.parent
    for item in reversed(missing):
        _assert_tree(item, allow_missing_leaf=True)
        try:
            item.mkdir()
        except FileExistsError:
            pass
        _assert_tree(item)
        if not item.is_dir() or _link_like(item):
            raise BootstrapError("bootstrap directory became a link or non-directory")


def _managed_python(environment: Path) -> Path:
    env = _assert_tree(environment, allow_missing_leaf=True)
    name = "python.exe" if os.name == "nt" else "python"
    candidate = env / ("Scripts" if os.name == "nt" else "bin") / name
    # POSIX venvs normally link the final interpreter to the base interpreter.
    _assert_tree(candidate, root=env, allow_final_link=(os.name != "nt"))
    if not candidate.is_file() or (os.name == "nt" and _link_like(candidate)):
        raise BootstrapError("managed uv environment has no safe Python interpreter")
    return candidate


def _canonical_file(path: Path) -> Path:
    try:
        return Path(os.path.normcase(os.path.abspath(os.fspath(path)))).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise BootstrapError("cannot resolve the managed Python interpreter") from exc


def _isolated_env(base: dict[str, str] | None = None) -> dict[str, str]:
    environment = dict(os.environ if base is None else base)
    for name in _PYTHON_INJECTION_VARS:
        environment.pop(name, None)
    environment["PYTHONNOUSERSITE"] = "1"
    return environment


def _isolated_command(command: Sequence[str | os.PathLike[str]], args: Sequence[str] = ()) -> list[str]:
    result = [os.fspath(item) for item in command]
    if len(result) >= 3 and result[1:3] == ["-m", "uv"]:
        result = [result[0], "-E", "-s", *result[1:]]
    return [*result, *args]


def _marker_path(environment: Path) -> Path:
    return environment / OWNERSHIP_MARKER_NAME


def _initializing_marker_path(environment: Path) -> Path:
    return environment / INITIALIZING_MARKER_NAME


def _read_marker(paths: BootstrapPaths) -> dict[str, object] | None:
    marker = _marker_path(paths.target_env)
    _assert_tree(marker, root=paths.target_env, allow_missing_leaf=True)
    if not marker.exists():
        return None
    if _link_like(marker) or not marker.is_file():
        raise BootstrapError("managed environment ownership marker is not a regular file")
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BootstrapError("managed environment ownership marker is invalid") from exc
    if not isinstance(value, dict) or value.get("version") != 1:
        raise BootstrapError("managed environment ownership marker is invalid")
    return value


def _read_initializing_marker(paths: BootstrapPaths) -> dict[str, object] | None:
    marker = _initializing_marker_path(paths.target_env)
    _assert_tree(marker, root=paths.target_env, allow_missing_leaf=True)
    if not marker.exists():
        return None
    if _link_like(marker) or not marker.is_file():
        raise BootstrapError("managed environment initialization marker is not a regular file")
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BootstrapError("managed environment initialization marker is invalid") from exc
    if not isinstance(value, dict) or value.get("version") != 1:
        raise BootstrapError("managed environment initialization marker is invalid")
    return value


def _marker_matches(paths: BootstrapPaths, marker: dict[str, object], interpreter: Path | None = None) -> bool:
    """Check marker paths without trusting any path supplied by the marker."""
    try:
        target = _canonical_file(Path(str(marker["target"])))
        repo = _canonical_file(Path(str(marker["repo"])))
        recorded = _canonical_file(Path(str(marker["interpreter"])))
    except (KeyError, TypeError, BootstrapError):
        return False
    if target != _canonical_file(paths.target_env) or repo != _canonical_file(paths.repo_root):
        return False
    if interpreter is not None and recorded != _canonical_file(interpreter):
        return False
    return True


def _initializing_matches(paths: BootstrapPaths, marker: dict[str, object]) -> bool:
    try:
        return (_canonical_file(Path(str(marker["repo"]))) == _canonical_file(paths.repo_root)
                and _canonical_file(Path(str(marker["target"]))) == _canonical_file(paths.target_env)
                and _canonical_file(Path(str(marker["python"]))) == _canonical_file(Path(sys.executable)))
    except (KeyError, TypeError, BootstrapError):
        return False


def _probe_interpreter(interpreter: Path, environment: Path, *, paths: BootstrapPaths,
                       runner: Runner) -> dict[str, object]:
    _revalidate(paths, environment)
    command = [str(interpreter), "-E", "-s", "-c", _PROBE]
    try:
        result = runner(command, cwd=str(paths.repo_root), env=_isolated_env(), shell=False,
                        check=False, text=True, encoding="utf-8", errors="replace", timeout=30.0)
    except Exception as exc:
        raise BootstrapError("managed Python interpreter could not be probed") from exc
    if int(getattr(result, "returncode", 1)) != 0:
        raise BootstrapError("managed Python interpreter probe failed")
    try:
        value = json.loads(str(getattr(result, "stdout", "")))
    except (TypeError, ValueError) as exc:
        raise BootstrapError("managed Python interpreter returned an invalid probe") from exc
    if not isinstance(value, dict):
        raise BootstrapError("managed Python interpreter returned an invalid probe")
    expected_env = _canonical_file(environment)
    try:
        prefix = _canonical_file(Path(str(value["prefix"])))
        executable = _canonical_file(Path(str(value["executable"])))
    except (KeyError, BootstrapError, TypeError) as exc:
        raise BootstrapError("managed Python interpreter probe is incomplete") from exc
    if value.get("implementation") != "cpython" or value.get("version") not in ([3, 12], [3, 13], [3, 14]):
        raise BootstrapError("managed environment must use supported CPython 3.12-3.14")
    if prefix != expected_env or executable != _canonical_file(interpreter):
        raise BootstrapError("managed interpreter identity does not match its environment")
    if str(value.get("base_prefix", "")) == str(value.get("prefix", "")):
        raise BootstrapError("managed interpreter is not a virtual environment")
    return value


def _validate_managed_environment(paths: BootstrapPaths, *, runner: Runner) -> Path:
    environment = _assert_tree(paths.target_env, root=paths.repo_root)
    cfg = environment / "pyvenv.cfg"
    _assert_tree(cfg, root=environment)
    if not cfg.is_file() or _link_like(cfg):
        raise BootstrapError("managed environment is missing a safe pyvenv.cfg")
    interpreter = _managed_python(environment)
    _probe_interpreter(interpreter, environment, paths=paths, runner=runner)
    return interpreter


def _marker_state(paths: BootstrapPaths, *, runner: Runner = run_owned_command) -> bool:
    marker_value = os.environ.get(BOOTSTRAP_MARKER)
    if marker_value is None:
        return False
    target = _validate_managed_environment(paths, runner=runner)
    durable = _read_marker(paths)
    if durable is None:
        raise BootstrapError("bootstrap loop marker has no durable ownership marker")
    current = _canonical_file(Path(sys.executable))
    try:
        recorded = _canonical_file(Path(marker_value))
        prefix = _canonical_file(Path(sys.prefix))
    except BootstrapError as exc:
        raise BootstrapError("bootstrap loop marker is invalid") from exc
    if recorded != current or current != _canonical_file(target) or prefix != _canonical_file(paths.target_env):
        raise BootstrapError("bootstrap loop marker does not match the managed interpreter")
    if not _marker_matches(paths, durable, target):
        raise BootstrapError("durable ownership marker does not match the managed interpreter")
    try:
        if _canonical_file(Path(str(durable.get("interpreter")))) != current:
            raise BootstrapError("durable ownership marker does not match the managed interpreter")
    except (TypeError, BootstrapError) as exc:
        raise BootstrapError("durable ownership marker is invalid") from exc
    if sys.implementation.name != "cpython" or sys.base_prefix == sys.prefix:
        raise BootstrapError("bootstrap loop marker is not running inside the managed venv")
    return True


def _write_marker(paths: BootstrapPaths, *, interpreter: Path) -> None:
    _revalidate(paths, paths.target_env)
    marker = _marker_path(paths.target_env)
    _assert_tree(marker, root=paths.target_env, allow_missing_leaf=True)
    payload = {"version": 1, "repo": str(_canonical_file(paths.repo_root)),
               "target": str(_canonical_file(paths.target_env)),
               "interpreter": str(_canonical_file(interpreter))}
    temporary = marker.with_name(f".{marker.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp")
    _assert_tree(temporary, root=paths.target_env, allow_missing_leaf=True)
    fd = -1
    try:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(temporary, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            fd = -1
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        _revalidate(paths, paths.target_env)
        if marker.exists() or marker.is_symlink():
            raise BootstrapError("managed environment ownership marker appeared during bootstrap")
        os.replace(temporary, marker)
        if os.name != "nt":
            # Persist the rename itself, not only the marker contents.
            directory_fd = os.open(paths.target_env, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        _assert_tree(marker, root=paths.target_env)
    except OSError as exc:
        raise BootstrapError("cannot write the managed environment ownership marker") from exc
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            if temporary.exists() or temporary.is_symlink():
                temporary.unlink()
        except OSError:
            pass


def _write_initializing_marker(paths: BootstrapPaths, *, interpreter: str | os.PathLike[str]) -> None:
    """Publish ownership before the first mutating sync, crash-safely."""
    _revalidate(paths, paths.target_env)
    marker = _initializing_marker_path(paths.target_env)
    _assert_tree(marker, root=paths.target_env, allow_missing_leaf=True)
    payload = {"version": 1, "repo": str(_canonical_file(paths.repo_root)),
               "target": str(_canonical_file(paths.target_env)),
               "python": str(_canonical_file(Path(interpreter)))}
    temporary = marker.with_name(f".{marker.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp")
    _assert_tree(temporary, root=paths.target_env, allow_missing_leaf=True)
    fd = -1
    try:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(temporary, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            fd = -1
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        _revalidate(paths, paths.target_env)
        if marker.exists() or marker.is_symlink():
            raise BootstrapError("managed environment initialization marker appeared during bootstrap")
        os.replace(temporary, marker)
        _assert_tree(marker, root=paths.target_env)
    except OSError as exc:
        raise BootstrapError("cannot write the managed environment initialization marker") from exc
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            if temporary.exists() or temporary.is_symlink():
                temporary.unlink()
        except OSError:
            pass


def _remove_initializing_marker(paths: BootstrapPaths) -> None:
    marker = _initializing_marker_path(paths.target_env)
    _assert_tree(marker, root=paths.target_env, allow_missing_leaf=True)
    if marker.exists() or marker.is_symlink():
        if _link_like(marker):
            raise BootstrapError("managed environment initialization marker may not be a link")
        marker.unlink()


def _redact_output(value: object) -> str:
    text = str(value or "")
    text = _SECRET_RE.sub(r"\1[REDACTED]", text)
    text = _BEARER_RE.sub(r"\1[REDACTED]", text)
    text = _URL_CREDENTIAL_RE.sub(r"\1[REDACTED]@", text)
    encoded = text.encode("utf-8", "replace")
    if len(encoded) > MAX_OUTPUT_BYTES:
        text = encoded[:MAX_OUTPUT_BYTES].decode("utf-8", "ignore") + "..."
    return text.replace("\x00", "")


def _command_name(argv: Sequence[str | os.PathLike[str]]) -> str:
    return Path(os.fspath(argv[0])).name or "command"


def _run(argv: Sequence[str | os.PathLike[str]], *, cwd: Path, runner: Runner,
         timeout: float = COMMAND_TIMEOUT_SECONDS, env: dict[str, str] | None = None,
         isolated: bool = True) -> object:
    command = _isolated_command(argv) if isolated else [os.fspath(item) for item in argv]
    environment = _isolated_env(env)
    try:
        result = runner(command, cwd=str(cwd), env=environment, shell=False, check=False,
                        text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except Exception as exc:
        detail = _redact_output(exc)
        raise BootstrapError(f"{_command_name(command)} could not be run{': ' + detail if detail else ''}") from None
    code = int(getattr(result, "returncode", 1))
    if code != 0:
        detail = _redact_output(getattr(result, "stdout", ""))
        suffix = f": {detail}" if detail else ""
        raise BootstrapError(f"{_command_name(command)} exited with status {code}{suffix}")
    return result


def _uv_version(result: object) -> str | None:
    match = _VERSION_RE.search(str(getattr(result, "stdout", "")))
    return match.group(1) if match else None


def _probe(command: Sequence[str], *, paths: BootstrapPaths, runner: Runner) -> bool:
    try:
        result = _run(command + ["--version"], cwd=paths.repo_root, runner=runner, timeout=30.0)
    except BootstrapError:
        return False
    return _uv_version(result) == UV_VERSION


def _uv_candidates(paths: BootstrapPaths) -> Iterator[list[str]]:
    uv_name = "uv.exe" if os.name == "nt" else "uv"
    base = paths.bootstrap_env / ("Scripts" if os.name == "nt" else "bin") / uv_name
    try:
        _assert_tree(base, root=paths.bootstrap_env)
    except BootstrapError:
        pass
    else:
        if base.is_file() and not _link_like(base):
            yield [str(base)]
    # Never execute a PATH-selected binary merely because it prints the pinned
    # version string. Use only our managed bootstrap tool or the invoking
    # interpreter's exact module; otherwise install the pinned wheel into the
    # managed bootstrap environment below.
    yield [sys.executable, "-m", "uv"]


def _find_uv(paths: BootstrapPaths, runner: Runner) -> list[str] | None:
    for candidate in _uv_candidates(paths):
        if _probe(candidate, paths=paths, runner=runner):
            return candidate
    return None


def _install_uv(paths: BootstrapPaths, runner: Runner) -> list[str]:
    _revalidate(paths)
    _mkdir_safe(paths.state_root)
    if paths.bootstrap_env.exists():
        _assert_tree(paths.bootstrap_env, root=paths.repo_root)
        bootstrap_python = paths.bootstrap_env / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")
        if not bootstrap_python.is_file():
            _run([sys.executable, "-m", "venv", str(paths.bootstrap_env)], cwd=paths.repo_root, runner=runner)
    else:
        _run([sys.executable, "-m", "venv", str(paths.bootstrap_env)], cwd=paths.repo_root, runner=runner)
    _revalidate(paths, paths.bootstrap_env)
    bootstrap_python = _managed_python(paths.bootstrap_env)
    _run([bootstrap_python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
          "--no-cache-dir", "--only-binary=:all:", "--no-deps", "--upgrade", f"uv=={UV_VERSION}"],
         cwd=paths.repo_root, runner=runner)
    uv = _find_uv(paths, runner)
    if uv is None:
        raise BootstrapError(f"uv {UV_VERSION} was installed but could not be verified")
    return uv


def _parse_owner(path: Path) -> tuple[int, str] | None:
    try:
        content = path.read_text(encoding="ascii")
    except (OSError, UnicodeError) as exc:
        raise BootstrapError("cannot read the bootstrap owner record") from exc
    fields: dict[str, str] = {}
    for line in content.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            fields[key] = value
    try:
        pid, token = int(fields["pid"]), fields["token"]
    except (KeyError, ValueError):
        return None
    if pid <= 0 or not re.fullmatch(r"[0-9a-f]{16,128}", token):
        return None
    return pid, token


def _owner_alive(pid: int) -> bool:
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        # Windows reports ERROR_INVALID_PARAMETER (87) for a nonexistent PID;
        # POSIX uses ESRCH. Other failures remain live by default.
        if exc.errno == errno.ESRCH or getattr(exc, "winerror", None) in {87, 1168}:
            return False
        return True
    return True


def _lock_stale(path: Path, *, now: Clock) -> bool:
    owner = _parse_owner(path)
    if owner is None or _owner_alive(owner[0]):
        return False
    try:
        age = max(0.0, now() - path.stat().st_mtime)
    except OSError as exc:
        raise BootstrapError("cannot inspect the bootstrap lock") from exc
    return age >= max(LOCK_STALE_SECONDS, COMMAND_TIMEOUT_SECONDS + 1.0)


@contextmanager
def _owner_file(path: Path, *, timeout: float, clock: Clock, sleeper: Sleeper,
                label: str) -> Iterator[None]:
    _assert_tree(path, allow_missing_leaf=True)
    started = clock()
    token = os.urandom(16).hex()
    fd = -1
    while True:
        _assert_tree(path, allow_missing_leaf=True)
        if path.exists() or path.is_symlink():
            if _link_like(path):
                raise BootstrapError(f"{label} may not be a link")
            if _lock_stale(path, now=time.time):
                try:
                    path.unlink()
                except OSError as exc:
                    raise BootstrapError(f"cannot clear the stale {label}") from exc
                continue
            elapsed = clock() - started
            if elapsed >= timeout:
                raise BootstrapError(f"timed out waiting for the {label}")
            sleeper(min(0.25, max(0.01, timeout - elapsed)))
            continue
        try:
            flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            fd = os.open(path, flags, 0o600)
            os.write(fd, f"pid={os.getpid()}\ntoken={token}\n".encode("ascii"))
            os.fsync(fd)
            os.close(fd)
            fd = -1
            _assert_tree(path)
            yield
        except FileExistsError:
            continue
        except OSError as exc:
            raise BootstrapError(f"cannot create the {label}") from exc
        finally:
            if fd >= 0:
                os.close(fd)
            try:
                if path.is_file() and not _link_like(path):
                    owner = _parse_owner(path)
                    if owner is not None and owner[0] == os.getpid() and owner[1] == token:
                        path.unlink()
            except OSError:
                pass
        return


@contextmanager
def _lock(paths: BootstrapPaths, *, clock: Clock = time.monotonic,
          sleeper: Sleeper = time.sleep) -> Iterator[None]:
    _mkdir_safe(paths.state_root)
    _revalidate(paths, paths.lock_path)
    with _owner_file(paths.lock_path, timeout=LOCK_TIMEOUT_SECONDS, clock=clock,
                      sleeper=sleeper, label="bootstrap lock"):
        _revalidate(paths)
        yield


def _sync(paths: BootstrapPaths, uv: Sequence[str], runner: Runner, *, check: bool = False,
          python: str | os.PathLike[str] | None = None) -> None:
    _revalidate(paths, paths.target_env)
    env = os.environ.copy()
    env["UV_NO_PROGRESS"] = "1"
    env["UV_PROJECT_ENVIRONMENT"] = str(paths.target_env)
    invoking_python = os.fspath(python if python is not None else sys.executable)
    command = [*uv, "sync", "--locked", "--no-install-project", "--no-dev", "--python", invoking_python]
    if check:
        command.append("--check")
    _run(command, cwd=paths.repo_root, runner=runner, env=env)
    _revalidate(paths, paths.target_env)


@contextmanager
def _target_claim(paths: BootstrapPaths, *, clock: Clock, sleeper: Sleeper) -> Iterator[None]:
    claim = paths.state_root / CLAIM_NAME
    _revalidate(paths, claim)
    with _owner_file(claim, timeout=LOCK_TIMEOUT_SECONDS, clock=clock,
                     sleeper=sleeper, label="bootstrap environment claim"):
        yield


def _reexec(paths: BootstrapPaths, managed_python: Path) -> None:
    _revalidate(paths, paths.target_env, managed_python)
    interpreter = str(_canonical_file(managed_python))
    environment = _isolated_env()
    environment[BOOTSTRAP_MARKER] = interpreter
    argv = [interpreter, "-E", "-s", str(paths.entrypoint), *sys.argv[1:]]
    if os.name == "nt":
        # CPython's os.execve is not a reliable process-overlay primitive on
        # Windows (including supported 3.14 builds). Keep the managed launcher
        # inside a private Job Object, stream bounded/redacted output, and
        # propagate its exact exit status instead.
        owned: OwnedProcess | None = None
        try:
            owned = OwnedProcess.launch(
                argv,
                paths.repo_root,
                env=environment,
                on_output=lambda line: print(_redact_output(line), flush=True),
            )
            return_code = owned.wait()
        except KeyboardInterrupt:
            raise
        except OSError as exc:
            raise BootstrapError("managed interpreter could not be started") from exc
        finally:
            if owned is not None:
                try:
                    owned.terminate()
                except ProcessCleanupError as exc:
                    raise BootstrapError("managed interpreter cleanup failed") from exc
        raise SystemExit(return_code)
    try:
        os.execve(interpreter, argv, environment)
    except OSError as exc:
        raise BootstrapError("managed interpreter could not be started") from exc
    raise BootstrapError("managed interpreter re-exec returned unexpectedly")


def bootstrap(*, paths: BootstrapPaths | None = None, runner: Runner = run_owned_command,
              reexec: bool = True, clock: Clock = time.monotonic,
              sleeper: Sleeper = time.sleep) -> Path | None:
    """Prepare the locked environment, then re-exec into its interpreter."""
    resolved = _validate_paths(paths or BootstrapPaths.from_entrypoint(Path(__file__).parents[1] / "Auvra.py"))
    if sys.implementation.name != "cpython" or not (3, 12) <= sys.version_info[:2] < (3, 15):
        raise BootstrapError("Auvra requires CPython 3.12, 3.13, or 3.14")
    if _marker_state(resolved, runner=runner):
        return _managed_python(resolved.target_env)
    with _lock(resolved, clock=clock, sleeper=sleeper):
        _revalidate(resolved)
        uv = _find_uv(resolved, runner) or _install_uv(resolved, runner)
        if resolved.target_env.exists():
            _assert_tree(resolved.target_env, root=resolved.repo_root)
            marker = _read_marker(resolved)
            initializing = _read_initializing_marker(resolved)
            if marker is not None:
                managed = _validate_managed_environment(resolved, runner=runner)
                if not _marker_matches(resolved, marker, managed):
                    raise BootstrapError("managed environment ownership marker is invalid")
                if initializing is not None:
                    # A crash can occur after durable ownership is published
                    # but before the initializing marker is removed. Recover
                    # only when both records identify this exact repo/target.
                    if not _initializing_matches(resolved, initializing):
                        raise BootstrapError("managed environment has conflicting ownership markers")
                    _remove_initializing_marker(resolved)
                    initializing = None
                _sync(resolved, uv, runner, python=managed)
            elif initializing is not None:
                if not _initializing_matches(resolved, initializing):
                    raise BootstrapError("managed environment initialization marker is invalid")
                try:
                    recovery_python = _canonical_file(Path(str(initializing["python"])))
                except (KeyError, TypeError, BootstrapError) as exc:
                    raise BootstrapError("managed environment initialization marker is invalid") from exc
                _sync(resolved, uv, runner, python=recovery_python)
            else:
                # Existing unmarked .venv is user-owned. --check is the only
                # permitted operation; failure never mutates or removes it.
                managed = _validate_managed_environment(resolved, runner=runner)
                _sync(resolved, uv, runner, check=True, python=managed)
            managed = _validate_managed_environment(resolved, runner=runner)
            if marker is None:
                _write_marker(resolved, interpreter=managed)
            if initializing is not None:
                _remove_initializing_marker(resolved)
        else:
            with _target_claim(resolved, clock=clock, sleeper=sleeper):
                _revalidate(resolved, resolved.target_env)
                if resolved.target_env.exists():
                    raise BootstrapError("repository .venv appeared during bootstrap; refusing to claim it")
                _mkdir_safe(resolved.target_env)
                _revalidate(resolved, resolved.target_env)
                _write_initializing_marker(resolved, interpreter=sys.executable)
                _sync(resolved, uv, runner, python=sys.executable)
                managed = _validate_managed_environment(resolved, runner=runner)
                _write_marker(resolved, interpreter=managed)
                _remove_initializing_marker(resolved)
    if reexec:
        _reexec(resolved, managed)
    return managed


__all__ = ["BOOTSTRAP_EXIT_CODE", "BootstrapError", "BootstrapPaths", "bootstrap"]
