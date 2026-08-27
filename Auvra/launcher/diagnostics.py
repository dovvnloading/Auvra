"""Runtime checks and safe diagnostic formatting."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import hashlib
import os
from pathlib import Path
import re
import shutil
import secrets
import subprocess
import sys
import time
import zipfile
from typing import Callable

from .config import Paths, command_environment
from .dependencies import inspect_dependencies, validate_lockfile
from .process import ProcessCleanupError, ProcessLaunchError, run_owned_command


@dataclass(frozen=True)
class RuntimeResult:
    name: str
    ok: bool
    version: str = ""
    detail: str = ""

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


_VERSION = re.compile(r"(?:v)?(\d+)\.(\d+)\.(\d+)")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)(\b[\w.-]*(?:api[_-]?key|anon[_-]?key|access[_-]?key|private[_-]?key|fal[_-]?key|token|password|secret|credential)[\w.-]*\b\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_AUTHORIZATION_HEADER = re.compile(r"(?i)(\bauthorization\s*:\s*)([^\r\n,;]+)")
_BEARER_TOKEN = re.compile(r"(?i)(\bbearer\s+)([^\s,;]+)")
_URL_CREDENTIALS = re.compile(r"(?i)(https?://)([^/@\s:]+):([^/@\s]+)@")
_ABSOLUTE_PATH = re.compile(r"(?i)(?:[a-z]:[\\/]|\\\\|/(?![\s\"']))[^\s\"']*")
_URL = re.compile(r"(?i)https?://[^\s\"']+")
_SUPPORT_SECRET = re.compile(r"(?i)(?:bearer\s+|authorization\s*[:=]|(?:api|anon|access|private|fal)[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|token\s*[:=])")
_SUPPORT_SECRET_KEY = re.compile(r"(?i)(?:password|secret|token|api[_-]?key|anon[_-]?key|access[_-]?key|private[_-]?key|fal[_-]?key|authorization|credential|bearer|cookie)")
_SUPPORT_FORBIDDEN_KEY = re.compile(r"(?i)^(?:payload|prompt|response|output|body|document|documents|asset|assets|content|binary|base64|path|file[_-]?path|filesystem[_-]?path|source[_-]?path|directory[_-]?path|local[_-]?path)$")

DIAGNOSTIC_RETENTION_SECONDS = 30 * 24 * 60 * 60
DIAGNOSTIC_MAX_FILES = 5
DIAGNOSTIC_MAX_BYTES = 5 * 1024 * 1024
SUPPORT_BUNDLE_MAX_BYTES = 10 * 1024 * 1024
RUN_MARKER_NAME = "run-marker.json"
CRASH_MARKER_NAME = "crash-marker.json"
_SUPPORT_MEMBERS = frozenset({"manifest.json", "diagnostics.json", "events.ndjson", "crash.json", "checksums.sha256"})


def parse_version(value: str) -> tuple[int, int, int] | None:
    match = _VERSION.search(value)
    return tuple(int(part) for part in match.groups()) if match else None


def _runtime_command(
    command: str,
    *,
    cwd: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]],
) -> tuple[str, str]:
    executable = shutil.which(command)
    if not executable:
        return "", f"{command} was not found on PATH"
    try:
        result = runner([executable, "--version"], cwd=str(cwd), shell=False, check=False, text=True,
                        encoding="utf-8", errors="replace",
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        env=command_environment(), timeout=10)
    except subprocess.TimeoutExpired:
        return "", f"{command} --version timed out after 10 seconds"
    except ProcessCleanupError as exc:
        return "", f"unable to clean up {command} probe: {str(exc)[:120]}"
    except ProcessLaunchError as exc:
        return "", f"unable to own {command} probe: {str(exc)[:120]}"
    except OSError as exc:
        return "", f"unable to run {command}: {exc}"
    output = (result.stdout or "").strip().splitlines()
    version = output[0][:80] if output else ""
    if result.returncode != 0:
        return version, f"{command} --version exited {result.returncode}"
    return version, ""


def check_python() -> RuntimeResult:
    current = tuple(sys.version_info[:3])
    version = ".".join(str(part) for part in current)
    ok = sys.implementation.name == "cpython" and (3, 12) <= current < (3, 15)
    detail = "supported runtime is CPython >=3.12,<3.15" if not ok else ""
    return RuntimeResult("python", ok, version, detail)


def check_node(*, cwd: Path | None = None, runner: Callable[..., subprocess.CompletedProcess[str]] = run_owned_command) -> RuntimeResult:
    raw, detail = _runtime_command("node", cwd=(cwd or Path.cwd()).resolve(), runner=runner)
    parsed = parse_version(raw)
    ok = bool(parsed and ((parsed >= (22, 12, 0) and parsed < (23, 0, 0)) or
                         (parsed >= (24, 0, 0) and parsed < (25, 0, 0))))
    if not detail and not ok:
        detail = "supported Node.js range is ^22.12.0 || ^24"
    return RuntimeResult("node", ok, raw, detail)


def check_npm(*, cwd: Path | None = None, runner: Callable[..., subprocess.CompletedProcess[str]] = run_owned_command) -> RuntimeResult:
    raw, detail = _runtime_command("npm", cwd=(cwd or Path.cwd()).resolve(), runner=runner)
    parsed = parse_version(raw)
    ok = bool(parsed and parsed >= (10, 0, 0) and parsed < (12, 0, 0))
    if not detail and not ok:
        detail = "supported npm range is >=10,<12"
    return RuntimeResult("npm", ok, raw, detail)


def collect_diagnostics(paths: Paths, *, runner: Callable[..., subprocess.CompletedProcess[str]] = run_owned_command) -> dict[str, object]:
    runtimes = [check_python(), check_node(cwd=paths.repo_root, runner=runner), check_npm(cwd=paths.repo_root, runner=runner)]
    lock = validate_lockfile(paths)
    deps = inspect_dependencies(paths)
    return {
        "ok": all(item.ok for item in runtimes) and lock.status == "valid" and deps.ready,
        "runtimes": [item.to_dict() for item in runtimes],
        "lockfile": lock.to_dict(),
        "dependencies": deps.to_dict(),
        "frontend": str(paths.frontend_root),
    }


def redact(value: object) -> object:
    """Recursively redact values whose keys or text resemble secrets."""
    secret_words = (
        "password", "secret", "token", "apikey", "accesskey", "anonkey",
        "privatekey", "falkey", "credential", "authorization",
    )
    if isinstance(value, dict):
        result: dict[object, object] = {}
        for key, item in value.items():
            key_text = re.sub(r"[^a-z0-9]", "", str(key).lower())
            result[key] = "[REDACTED]" if any(word in key_text for word in secret_words) else redact(item)
        return result
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = _AUTHORIZATION_HEADER.sub(r"\1[REDACTED]", value)
        value = _BEARER_TOKEN.sub(r"\1[REDACTED]", value)
        value = _URL_CREDENTIALS.sub(r"\1[REDACTED]@", value)
        return _SECRET_ASSIGNMENT.sub(r"\1[REDACTED]", value)
    return value


def emit(data: dict[str, object], *, json_mode: bool) -> None:
    safe = redact(data)
    if json_mode:
        print(json.dumps(safe, sort_keys=True, separators=(",", ":")))
        return
    if "message" in safe:
        print(str(safe["message"]))
        return
    command = safe.get("command")
    if command:
        if safe.get("error"):
            print(f"{command}: error: {safe['error']}")
        else:
            print(f"{command}: {'ok' if safe.get('ok', True) else 'failed'}")
    if safe.get("url"):
        print(f"ready: {safe['url']}")
    if isinstance(safe.get("removed"), list) and safe["removed"]:
        for item in safe["removed"]:
            print(f"removed: {item}")
    if isinstance(safe.get("output"), str) and safe["output"]:
        print(safe["output"], end="" if safe["output"].endswith("\n") else "\n")


def _safe_diagnostics_root(paths: Paths) -> Path:
    root = paths.diagnostics_root.absolute()
    for candidate in (paths.launcher_state.absolute(), root):
        current = Path(candidate.anchor)
        for component in candidate.parts[1:]:
            current /= component
            if not current.exists() and not current.is_symlink():
                continue
            if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
                raise OSError("diagnostics path cannot contain links or reparse points")
            try:
                if getattr(current.stat(), "st_file_attributes", 0) & 0x400:
                    raise OSError("diagnostics path cannot contain links or reparse points")
            except FileNotFoundError:
                continue
    if root.exists() and not root.is_dir():
        raise OSError("diagnostics directory is not a regular directory")
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()) or not root.is_dir():
        raise OSError("diagnostics directory is unsafe")
    return root


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp")
    try:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        fd = os.open(temporary, flags, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                fd = -1
                json.dump(value, stream, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            if fd >= 0:
                os.close(fd)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _load_json(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def prune_local_diagnostics(paths: Paths, *, now: float | None = None) -> list[str]:
    """Prune only launcher-owned crash records by age/count/size."""
    root = _safe_diagnostics_root(paths)
    now = time.time() if now is None else now
    candidates = [p for p in root.iterdir() if p.is_file() and
                  ((p.name.startswith("crash-") and p.suffix == ".json") or p.name == CRASH_MARKER_NAME)]
    removed: list[str] = []
    for path in candidates[:]:
        try:
            if now - path.stat().st_mtime > DIAGNOSTIC_RETENTION_SECONDS:
                path.unlink()
                removed.append(path.name)
                candidates.remove(path)
        except OSError:
            continue
    candidates.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    for path in candidates[DIAGNOSTIC_MAX_FILES:]:
        try:
            path.unlink()
            removed.append(path.name)
        except OSError:
            pass
    candidates = [p for p in candidates[:DIAGNOSTIC_MAX_FILES] if p.exists()]
    total = sum(p.stat().st_size for p in candidates)
    for path in sorted(candidates, key=lambda item: item.stat().st_mtime):
        if total <= DIAGNOSTIC_MAX_BYTES:
            break
        try:
            total -= path.stat().st_size
            path.unlink()
            removed.append(path.name)
        except OSError:
            pass
    return removed


def begin_diagnostics_run(paths: Paths, *, run_id: str | None = None) -> dict[str, object] | None:
    """Publish a crash-safe run marker and return any prior unclean marker."""
    root = _safe_diagnostics_root(paths)
    prune_local_diagnostics(paths)
    marker = root / RUN_MARKER_NAME
    previous = _load_json(marker) if marker.exists() else None
    if previous is not None:
        crash = {"version": 1, "kind": "unclean_shutdown", "previous": previous, "at": time.time()}
        _atomic_json(root / CRASH_MARKER_NAME, redact(crash))
    _atomic_json(marker, {"version": 1, "runId": run_id or secrets.token_urlsafe(16), "startedAt": time.time()})
    return previous


def finish_diagnostics_run(paths: Paths) -> None:
    root = _safe_diagnostics_root(paths)
    marker = root / RUN_MARKER_NAME
    if marker.exists() and not marker.is_symlink():
        marker.unlink()


def record_diagnostics_crash(paths: Paths, *, component: str, code: str,
                             exit_code: int | None = None, detail: str | None = None) -> Path:
    root = _safe_diagnostics_root(paths)
    value: dict[str, object] = {"version": 1, "kind": "crash", "component": str(component)[:64],
                                "code": str(code)[:128], "at": time.time()}
    if exit_code is not None:
        value["exitCode"] = int(exit_code)
    if detail:
        value["detail"] = str(detail)[:256]
    name = f"crash-{int(time.time() * 1000)}-{os.urandom(4).hex()}.json"
    target = root / name
    _atomic_json(target, _support_sanitize(redact(value)))
    _atomic_json(root / CRASH_MARKER_NAME, _support_sanitize(redact(value)))
    prune_local_diagnostics(paths)
    return target


def delete_local_diagnostics(paths: Paths) -> list[str]:
    """Delete only the exact launcher-owned diagnostics directory contents."""
    root = paths.diagnostics_root
    if not root.exists() and not root.is_symlink():
        return []
    if root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()) or not root.is_dir():
        raise OSError("refusing to remove linked diagnostics directory")
    entries = list(root.iterdir())
    for path in entries:
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise OSError("refusing to remove linked diagnostics content")
    removed = [path.name for path in entries]
    shutil.rmtree(root)
    return removed


def _support_sanitize(value: object, key: str = "") -> object:
    if _SUPPORT_FORBIDDEN_KEY.fullmatch(key):
        return "[OMITTED]"
    if isinstance(value, dict):
        return {str(k): _support_sanitize(v, str(k)) for k, v in value.items()
                if not _SUPPORT_SECRET_KEY.search(str(k))}
    if isinstance(value, list):
        return [_support_sanitize(item, key) for item in value[:256]]
    if isinstance(value, str):
        value = _BEARER_TOKEN.sub("[REDACTED_AUTH]", value)
        value = _URL.sub("[REDACTED_URL]", value)
        value = _ABSOLUTE_PATH.sub("[REDACTED_PATH]", value)
        return value[:2048]
    return value


def _support_scan(data: bytes) -> None:
    text = data.decode("utf-8", "replace")
    if _SUPPORT_SECRET.search(text) or _URL.search(text) or _ABSOLUTE_PATH.search(text):
        raise ValueError("support bundle contains sensitive text")
    if re.search(r"(?i)(?:\.dmp|\.pdb|node_modules|target/|\\target\\|\.env(?:[.\\]|$))", text):
        raise ValueError("support bundle contains an excluded artifact")


def export_support_bundle(paths: Paths, destination: str | os.PathLike[str], *, ring: object | None = None) -> Path:
    """Write a user-requested, redacted, path-free support ZIP atomically."""
    if ring is None:
        from Auvra.host.logging import process_diagnostics
        ring = process_diagnostics()
    destination = Path(destination).expanduser().absolute()
    if (destination.name in {"", ".", ".."} or destination.exists()
            or destination.is_symlink()):
        raise ValueError("support bundle destination is invalid")
    destination.parent.mkdir(parents=True, exist_ok=True)
    runtime = _support_sanitize(redact(collect_diagnostics(paths)))
    events = []
    snapshot = getattr(ring, "snapshot", None)
    if callable(snapshot):
        events = _support_sanitize(snapshot())
    crash = _support_sanitize(_load_json(paths.diagnostics_root / CRASH_MARKER_NAME) or {})
    documents = {
        "manifest.json": {"version": 1, "kind": "auvra-support", "telemetry": False},
        "diagnostics.json": runtime,
        "events.ndjson": "\n".join(json.dumps(item, ensure_ascii=True, sort_keys=True, separators=(",", ":")) for item in events) + ("\n" if events else ""),
        "crash.json": crash,
    }
    payloads: dict[str, bytes] = {}
    for name, value in documents.items():
        payloads[name] = (value if isinstance(value, str) else json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    checksums = "".join(f"{hashlib.sha256(payloads[name]).hexdigest()}  {name}\n" for name in sorted(payloads))
    payloads["checksums.sha256"] = checksums.encode("ascii")
    for name, payload in payloads.items():
        if name not in _SUPPORT_MEMBERS or len(payload) > SUPPORT_BUNDLE_MAX_BYTES:
            raise ValueError("support bundle member exceeds policy")
        _support_scan(payload)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp")
    try:
        with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(payloads):
                archive.writestr(name, payloads[name])
        if temporary.stat().st_size > SUPPORT_BUNDLE_MAX_BYTES:
            raise ValueError("support bundle exceeds policy")
        with temporary.open("rb+") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return destination
