"""Command-line interface for Auvra's development launcher."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
import shutil
import signal
import socket
import threading
import time
from pathlib import Path
from collections.abc import Iterator

from .config import DEFAULT_PORT, HOST, PORT_RANGE, READINESS_TIMEOUT, Paths
from .dependencies import prepare_dependencies, remove_scoped_tree
from .diagnostics import (
    begin_diagnostics_run, check_node, check_npm, check_python, collect_diagnostics,
    delete_local_diagnostics, emit, export_support_bundle, finish_diagnostics_run,
    record_diagnostics_crash, redact,
)
from .process import OwnedProcess, ProcessCleanupError, ProcessLaunchError
from .readiness import wait_for_readiness
from Auvra.desktop.controller import FrameController, FrameProcessExitedError
from Auvra.desktop.contracts import FrameConfigurationError, FrameStartupError
from Auvra.desktop.sdk import SdkError, load_packaged_sdk


class ExitCode:
    OK = 0
    USAGE = 2
    UNEXPECTED = 1
    RUNTIME = 10
    DEPENDENCIES = 11
    PORT = 12
    READINESS = 13
    CHILD = 14
    CLEANUP = 15
    INTERRUPTED = 130


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="Auvra.py", description="Run the Auvra development editor.")
    parser.add_argument("--json", action="store_true", help="emit structured JSON diagnostic records")
    sub = parser.add_subparsers(dest="command")
    start = sub.add_parser("start", help="prepare and run the loopback Vite server")
    start.add_argument("--port", type=int, help="strictly use this loopback port")
    start.add_argument("--packaged-root", type=Path, help="open an immutable frontend dist directory without Vite")
    start.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    doctor = sub.add_parser("doctor", help="check runtimes, lockfile, and dependencies")
    doctor.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    prepare = sub.add_parser("prepare", help="validate/install locked frontend dependencies")
    prepare.add_argument("--repair", action="store_true", help="remove exact node_modules and reinstall")
    prepare.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    clean = sub.add_parser("clean", help="remove launcher state and frontend build output")
    clean.add_argument("--dependencies", action="store_true", help="also remove exact node_modules")
    clean.add_argument("--yes", action="store_true", help="confirm dependency removal")
    clean.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    support = sub.add_parser("support", help="export or delete local diagnostics")
    support.add_argument("--output", type=Path, help="write a redacted support bundle to this path")
    support.add_argument("--delete-local", action="store_true", help="delete launcher-owned local diagnostics")
    support.add_argument("--yes", action="store_true", help="confirm local diagnostics deletion")
    support.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    return parser


def _json_mode(args: argparse.Namespace) -> bool:
    return bool(getattr(args, "json", False))


@contextmanager
def _shutdown_signal_handlers() -> Iterator[None]:
    """Translate terminal-close signals into the normal cleanup path."""

    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous: dict[signal.Signals, object] = {}

    def interrupt(_signum: int, _frame: object) -> None:
        raise KeyboardInterrupt

    for name in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        candidate = getattr(signal, name, None)
        if candidate is None or candidate in previous:
            continue
        try:
            previous[candidate] = signal.getsignal(candidate)
            signal.signal(candidate, interrupt)
        except (OSError, ValueError):
            previous.pop(candidate, None)
    try:
        yield
    finally:
        for candidate, handler in previous.items():
            signal.signal(candidate, handler)  # type: ignore[arg-type]


def _runtime_ok(paths: Paths) -> tuple[bool, list[dict[str, object]]]:
    checks = [check_python(), check_node(cwd=paths.repo_root), check_npm(cwd=paths.repo_root)]
    return all(item.ok for item in checks), [item.to_dict() for item in checks]


def _node_npm() -> tuple[str, str]:
    node = shutil.which("node") or "node"
    npm = shutil.which("npm") or "npm"
    return node, npm


def _port_open(port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((HOST, port))
        return False
    except OSError:
        return True
    finally:
        sock.close()


def choose_port(explicit: int | None) -> int:
    if explicit is not None:
        if not 1 <= explicit <= 65535:
            raise ValueError("--port must be between 1 and 65535")
        if _port_open(explicit):
            raise OSError(f"requested loopback port {explicit} is already in use")
        return explicit
    if not _port_open(DEFAULT_PORT):
        return DEFAULT_PORT
    for port in PORT_RANGE:
        if not _port_open(port):
            return port
    raise OSError("no free loopback port in 3001-3099")


def _human_runtime(checks: list[dict[str, object]]) -> None:
    for check in checks:
        state = "ok" if check["ok"] else "FAIL"
        detail = f": {check['detail']}" if check.get("detail") else ""
        print(f"{check['name']}: {state} {check.get('version', '')}{detail}")


def run_doctor(paths: Paths, *, json_mode: bool) -> int:
    result = collect_diagnostics(paths)
    if json_mode:
        emit({"command": "doctor", **result}, json_mode=True)
    else:
        _human_runtime(result["runtimes"])  # type: ignore[arg-type]
        print(f"lockfile: {result['lockfile']['status']} ({result['lockfile']['reason']})")  # type: ignore[index]
        print(f"dependencies: {result['dependencies']['status']} ({result['dependencies']['reason']})")  # type: ignore[index]
    if result["ok"]:
        return ExitCode.OK
    runtime_failed = any(not bool(item["ok"]) for item in result["runtimes"])  # type: ignore[index]
    return ExitCode.RUNTIME if runtime_failed else ExitCode.DEPENDENCIES


def run_prepare(paths: Paths, *, repair: bool, json_mode: bool) -> int:
    ok_runtime, checks = _runtime_ok(paths)
    if not ok_runtime:
        result = {"command": "prepare", "ok": False, "error": "runtime check failed", "runtimes": checks}
        emit(result, json_mode=json_mode)
        if not json_mode:
            _human_runtime(checks)
        return ExitCode.RUNTIME
    _, npm = _node_npm()
    try:
        ok, state, output = prepare_dependencies(paths, npm, repair=repair)
    except ProcessCleanupError as exc:
        emit({"command": "prepare", "ok": False,
              "error": f"owned-process cleanup failed: {exc}"}, json_mode=json_mode)
        return ExitCode.CLEANUP
    except ProcessLaunchError as exc:
        emit({"command": "prepare", "ok": False,
              "error": f"dependency child launch failed: {exc}"}, json_mode=json_mode)
        return ExitCode.CHILD
    except (OSError, ValueError) as exc:
        ok, state, output = False, None, str(exc)
    result = {"command": "prepare", "ok": ok, "repair": repair,
              "dependencies": state.to_dict() if state else {}, "output": output[-4000:]}
    emit(result, json_mode=json_mode)
    return ExitCode.OK if ok else ExitCode.DEPENDENCIES


def run_clean(paths: Paths, *, dependencies: bool, yes: bool, json_mode: bool) -> int:
    if dependencies and not yes:
        if json_mode:
            emit({"command": "clean", "ok": False, "error": "--yes is required with --dependencies"}, json_mode=True)
            return ExitCode.USAGE
        try:
            answer = input("Remove the exact frontend node_modules directory? [y/N] ").strip().lower()
        except KeyboardInterrupt:
            emit({"command": "clean", "ok": False, "interrupted": True,
                  "error": "interrupted by user"}, json_mode=json_mode)
            return ExitCode.INTERRUPTED
        except EOFError:
            answer = ""
        if answer not in {"y", "yes"}:
            print("Dependency cleanup cancelled.")
            return ExitCode.OK
    removed: list[str] = []
    try:
        for target, expected_name in (
            (paths.launcher_state, ".auvra-launcher"),
            (paths.frontend_root / "dist", "dist"),
        ):
            if target.exists() or target.is_symlink():
                remove_scoped_tree(
                    target,
                    parent=paths.frontend_root,
                    expected_name=expected_name,
                )
                removed.append(str(target))
        if dependencies:
            if paths.node_modules.exists() or paths.node_modules.is_symlink():
                remove_scoped_tree(
                    paths.node_modules,
                    parent=paths.frontend_root,
                    expected_name="node_modules",
                )
                removed.append(str(paths.node_modules))
    except OSError as exc:
        emit({"command": "clean", "ok": False, "error": str(exc)[:240], "removed": removed}, json_mode=json_mode)
        return ExitCode.CLEANUP
    emit({"command": "clean", "ok": True, "removed": removed}, json_mode=json_mode)
    return ExitCode.OK


def run_support(paths: Paths, *, output: Path | None, delete_local: bool, yes: bool,
                json_mode: bool) -> int:
    if delete_local and not yes:
        emit({"command": "support", "ok": False, "error": "--yes is required with --delete-local"}, json_mode=json_mode)
        return ExitCode.USAGE
    if output is None and not delete_local:
        emit({"command": "support", "ok": False, "error": "--output or --delete-local is required"}, json_mode=json_mode)
        return ExitCode.USAGE
    try:
        result: dict[str, object] = {"command": "support", "ok": True}
        if output is not None:
            result["output"] = str(export_support_bundle(paths, output))
        if delete_local:
            result["removed"] = delete_local_diagnostics(paths)
        emit(result, json_mode=json_mode)
        return ExitCode.OK
    except (OSError, ValueError) as exc:
        emit({"command": "support", "ok": False, "error": str(exc)[:240]}, json_mode=json_mode)
        return ExitCode.CLEANUP


class _PackagedOwner:
    def __init__(self) -> None:
        self.stopped = False

    def is_alive(self) -> bool:
        return not self.stopped

    def poll(self) -> int:
        return 0

    def terminate(self) -> None:
        self.stopped = True


def _verify_release_package(package_root: Path) -> dict[str, object]:
    """Use the package-shipped verifier; development checkout is a test fallback."""
    verifier = None
    try:
        from auvra_release_verify import verify_installed_package
        verifier = verify_installed_package
    except ImportError:
        try:
            from release.runtime_verify import verify_installed_package
            verifier = verify_installed_package
        except ImportError as exc:
            raise FrameConfigurationError("packaged release verifier is unavailable") from exc
    try:
        result = verifier(package_root)
    except Exception as exc:
        raise FrameConfigurationError(str(exc)[:240]) from exc
    if not isinstance(result, dict) or not isinstance(result.get("channel"), str):
        raise FrameConfigurationError("packaged release verification returned invalid metadata")
    return result


def _release_packaged_inputs(packaged_root: Path) -> tuple[Paths, Path, object, Path, Path] | None:
    """Resolve verified release assets; return ``None`` for legacy dev dist."""
    requested = Path(packaged_root).expanduser().absolute()
    if not requested.is_dir():
        return None
    try:
        frontend = requested.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise FrameConfigurationError("packaged frontend directory is unavailable") from exc
    package_root = frontend.parent
    if not (package_root / "release-manifest.json").is_file():
        return None
    metadata = _verify_release_package(package_root)
    paths = Paths.from_packaged_root(frontend, str(metadata["channel"]))
    sdk = load_packaged_sdk(paths.packaged_webview2_sdk)
    runtime = paths.packaged_webview2_runtime
    native = paths.packaged_native
    if runtime.is_symlink() or not runtime.is_dir() or runtime.joinpath("msedgewebview2.exe").is_symlink() \
            or not runtime.joinpath("msedgewebview2.exe").is_file():
        raise FrameConfigurationError("packaged fixed WebView2 runtime is missing or incomplete")
    if native.is_symlink() or not native.is_file():
        raise FrameConfigurationError("packaged native engine is missing or unsafe")
    return paths, frontend, sdk, runtime, native


def _packaged_diagnostics_paths(packaged_root: Path, fallback: Paths) -> Paths | None:
    """Select release-local diagnostics without trusting an invalid package."""
    requested = Path(packaged_root).expanduser().absolute()
    try:
        frontend = requested.resolve(strict=True)
        manifest = frontend.parent / "release-manifest.json"
        if not manifest.is_file():
            return fallback
        value = json.loads(manifest.read_text(encoding="utf-8"))
        channel = value.get("channel") if isinstance(value, dict) else None
        if not isinstance(channel, str):
            return None
        return Paths.from_packaged_root(frontend, channel)
    except (OSError, RuntimeError, ValueError, UnicodeError, json.JSONDecodeError):
        return None


def run_packaged(paths: Paths, *, packaged_root: Path, json_mode: bool) -> int:
    if not packaged_root.is_dir():
        emit({"command": "start", "ok": False, "error": "packaged frontend directory does not exist"}, json_mode=json_mode)
        return ExitCode.DEPENDENCIES
    owner = _PackagedOwner()
    controller: FrameController | None = None
    exit_code = ExitCode.OK
    try:
        release = _release_packaged_inputs(packaged_root)
        if release is None:
            launch_paths, resolved_root, sdk, runtime, native = paths, packaged_root, None, None, None
        else:
            launch_paths, resolved_root, sdk, runtime, native = release
        controller = FrameController.packaged(
            owner, resolved_root, profile_parent=launch_paths.launcher_state,
            sdk=sdk, browser_executable_folder=runtime,
            native_command=[str(native.resolve())] if native is not None else None,
        )
        controller.start()
        emit({"command": "start", "ok": True, "packaged": True, "root": str(resolved_root)}, json_mode=json_mode)
        controller.run()
    except FrameConfigurationError as exc:
        emit({"command": "start", "ok": False, "error": str(exc)[:240]}, json_mode=json_mode)
        exit_code = ExitCode.DEPENDENCIES
    except (FrameStartupError, SdkError) as exc:
        emit({"command": "start", "ok": False, "error": str(exc)[:240]}, json_mode=json_mode)
        exit_code = ExitCode.RUNTIME
    except FrameProcessExitedError as exc:
        emit({"command": "start", "ok": False, "error": str(exc)[:240]}, json_mode=json_mode)
        exit_code = ExitCode.CHILD
    except (OSError, ProcessLaunchError) as exc:
        emit({"command": "start", "ok": False, "error": str(exc)[:240]}, json_mode=json_mode)
        exit_code = ExitCode.CHILD
    except KeyboardInterrupt:
        emit({"command": "start", "ok": False, "interrupted": True,
              "error": "interrupted by user"}, json_mode=json_mode)
        exit_code = ExitCode.INTERRUPTED
    finally:
        if controller is not None:
            controller.close()
            if controller.cleanup_error is not None:
                emit({"command": "start", "ok": False,
                      "error": "desktop frame cleanup failed"}, json_mode=json_mode)
                exit_code = ExitCode.CLEANUP
    return exit_code


def _run_start(paths: Paths, *, explicit_port: int | None, json_mode: bool, packaged_root: Path | None = None) -> int:
    if packaged_root is not None:
        return run_packaged(paths, packaged_root=packaged_root, json_mode=json_mode)
    ok_runtime, checks = _runtime_ok(paths)
    if not ok_runtime:
        emit({"command": "start", "ok": False, "error": "runtime check failed", "runtimes": checks}, json_mode=json_mode)
        if not json_mode:
            _human_runtime(checks)
        return ExitCode.RUNTIME
    try:
        port = choose_port(explicit_port)
    except (OSError, ValueError) as exc:
        emit({"command": "start", "ok": False, "error": str(exc)[:240]}, json_mode=json_mode)
        return ExitCode.PORT
    used_fallback = explicit_port is None and port != DEFAULT_PORT
    if used_fallback and not json_mode:
        print(f"port {DEFAULT_PORT} is occupied; using loopback port {port}")
    _, npm = _node_npm()
    try:
        ready, state, install_output = prepare_dependencies(paths, npm)
    except ProcessCleanupError as exc:
        emit({"command": "start", "ok": False,
              "error": f"dependency cleanup failed: {exc}"}, json_mode=json_mode)
        return ExitCode.CLEANUP
    except ProcessLaunchError as exc:
        emit({"command": "start", "ok": False,
              "error": f"dependency child launch failed: {exc}"}, json_mode=json_mode)
        return ExitCode.CHILD
    except (OSError, ValueError) as exc:
        ready, state, install_output = False, None, str(exc)
    if not ready:
        emit({"command": "start", "ok": False, "error": "dependency preparation failed",
              "port": port, "dependencies": state.to_dict() if state else {}, "output": install_output[-4000:]}, json_mode=json_mode)
        return ExitCode.DEPENDENCIES
    node, _ = _node_npm()
    command = [node, str(paths.vite_script), "--host", HOST, "--port", str(port), "--strictPort"]
    def log(line: str) -> None:
        if not json_mode and line:
            print(str(redact(line)), flush=True)
    owned: OwnedProcess | None = None
    controller: FrameController | None = None
    exit_code = ExitCode.OK
    try:
        owned = OwnedProcess.launch(command, paths.frontend_root, on_output=log)
        result = wait_for_readiness(HOST, port, owned.is_alive, timeout=READINESS_TIMEOUT)
        if not result.ready:
            emit({"command": "start", "ok": False, "error": "frontend readiness failed",
                  "url": result.url, "detail": result.detail, "reason": result.reason,
                  "attempts": result.attempts}, json_mode=json_mode)
            child_exited = (
                result.reason == "child-exited"
                or "child exited before readiness" in result.detail.lower()
            )
            exit_code = ExitCode.CHILD if child_exited else ExitCode.READINESS
        else:
            if not owned.is_alive():
                child_code = int(owned.poll() or 0)
                emit({"command": "start", "ok": False,
                      "error": f"frontend child exited with status {child_code}"}, json_mode=json_mode)
                exit_code = ExitCode.CHILD
            else:
                try:
                    controller = FrameController.development(
                        owned, result.url, profile_parent=paths.launcher_state,
                        native_command=_native_engine_command(paths),
                    )
                    controller.start()
                    emit({"command": "start", "ok": True, "url": result.url, "port": port,
                          "preferred_port": DEFAULT_PORT, "fallback": used_fallback}, json_mode=json_mode)
                    controller.run()
                except FrameProcessExitedError as exc:
                    emit({"command": "start", "ok": False,
                          "error": str(exc)[:240]}, json_mode=json_mode)
                    exit_code = ExitCode.CHILD
                except (FrameStartupError, SdkError, FrameConfigurationError) as exc:
                    emit({"command": "start", "ok": False,
                          "error": str(exc)[:240]}, json_mode=json_mode)
                    exit_code = ExitCode.RUNTIME
    except KeyboardInterrupt:
        emit({"command": "start", "ok": False, "interrupted": True,
              "error": "interrupted by user"}, json_mode=json_mode)
        exit_code = ExitCode.INTERRUPTED
    except (OSError, ProcessLaunchError) as exc:
        emit({"command": "start", "ok": False, "error": str(exc)[:240]}, json_mode=json_mode)
        exit_code = ExitCode.CHILD
    finally:
        if controller is not None:
            controller.close()
            if controller.cleanup_error is not None:
                emit({"command": "start", "ok": False,
                      "error": "desktop frame cleanup failed"}, json_mode=json_mode)
                exit_code = ExitCode.CLEANUP
        if owned is not None:
            try:
                owned.terminate()
            except ProcessCleanupError as exc:
                emit({"command": "start", "ok": False,
                      "error": f"owned-process cleanup failed: {exc}"}, json_mode=json_mode)
                exit_code = ExitCode.CLEANUP
    return exit_code


def run_start(paths: Paths, *, explicit_port: int | None, json_mode: bool, packaged_root: Path | None = None) -> int:
    """Run start with an atomic local crash marker and bounded retention."""
    diagnostic_paths = _packaged_diagnostics_paths(packaged_root, paths) if packaged_root is not None else paths
    if diagnostic_paths is not None:
        begin_diagnostics_run(diagnostic_paths)
    try:
        result = _run_start(paths, explicit_port=explicit_port, json_mode=json_mode, packaged_root=packaged_root)
        # Persist only unexpected owned-process or cleanup failures. Expected
        # configuration, dependency, port, readiness, and user-cancellation
        # outcomes are actionable errors, not crashes from a previous run.
        if diagnostic_paths is not None and result in {ExitCode.CHILD, ExitCode.CLEANUP}:
            record_diagnostics_crash(diagnostic_paths, component="launcher", code="start_failed", exit_code=result)
        return result
    except BaseException as exc:
        if diagnostic_paths is not None:
            record_diagnostics_crash(diagnostic_paths, component="launcher", code="uncaught_exception", detail=type(exc).__name__)
        raise
    finally:
        if diagnostic_paths is not None:
            finish_diagnostics_run(diagnostic_paths)


def _native_engine_command(paths: Paths) -> list[str] | None:
    """Resolve only the repository-owned Stage 6 development binary."""

    name = "auvra-native.exe" if os.name == "nt" else "auvra-native"
    candidate = paths.repo_root / "native" / "target" / "release" / name
    return [str(candidate)] if candidate.is_file() else None


def main(argv: list[str] | None = None, *, paths: Paths | None = None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)
    command = args.command or "start"
    paths = paths or Paths()
    json_mode = _json_mode(args)
    if command == "doctor":
        try:
            with _shutdown_signal_handlers():
                return run_doctor(paths, json_mode=json_mode)
        except KeyboardInterrupt:
            emit({"command": "doctor", "ok": False, "interrupted": True,
                  "error": "interrupted by user"}, json_mode=json_mode)
            return ExitCode.INTERRUPTED
    if command == "prepare":
        try:
            with _shutdown_signal_handlers():
                return run_prepare(paths, repair=args.repair, json_mode=json_mode)
        except KeyboardInterrupt:
            emit({"command": "prepare", "ok": False, "interrupted": True,
                  "error": "interrupted by user"}, json_mode=json_mode)
            return ExitCode.INTERRUPTED
    if command == "clean":
        return run_clean(paths, dependencies=args.dependencies, yes=args.yes, json_mode=json_mode)
    if command == "support":
        return run_support(paths, output=args.output, delete_local=args.delete_local,
                           yes=args.yes, json_mode=json_mode)
    try:
        with _shutdown_signal_handlers():
            if getattr(args, "packaged_root", None) is not None:
                return run_start(paths, explicit_port=None, json_mode=json_mode, packaged_root=args.packaged_root)
            return run_start(paths, explicit_port=getattr(args, "port", None), json_mode=json_mode)
    except KeyboardInterrupt:
        emit({"command": "start", "ok": False, "interrupted": True,
              "error": "interrupted by user"}, json_mode=json_mode)
        return ExitCode.INTERRUPTED


if __name__ == "__main__":
    raise SystemExit(main())
