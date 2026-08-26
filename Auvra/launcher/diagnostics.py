"""Runtime checks and safe diagnostic formatting."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
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
