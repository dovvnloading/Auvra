"""Owned child process lifecycle."""

from __future__ import annotations

from dataclasses import dataclass
import subprocess
import threading
from pathlib import Path
from typing import Callable, Mapping, Sequence
import os

from .platform import PosixProcessGroup, WindowsJob


# Never let a child with a missing newline make readline allocate unbounded
# memory.  The finite-command API retains only a bounded UTF-8 tail.
OUTPUT_READ_CHARS = 8192
MAX_CAPTURE_BYTES = 64 * 1024


class ProcessLaunchError(RuntimeError):
    pass


class ProcessCleanupError(RuntimeError):
    pass


@dataclass
class OwnedProcess:
    process: subprocess.Popen[str]
    owner: object
    output_thread: threading.Thread | None = None
    _closed: bool = False

    @classmethod
    def launch(
        cls,
        argv: Sequence[str | os.PathLike[str]],
        cwd: Path,
        *,
        on_output: Callable[[str], None] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> "OwnedProcess":
        command = [os.fspath(arg) for arg in argv]
        job = None
        kwargs: dict[str, object] = {
            "cwd": str(cwd), "shell": False, "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT,
            "text": True, "encoding": "utf-8", "errors": "replace", "bufsize": 1,
            "env": dict(env) if env is not None else None,
        }
        if os.name == "nt":
            job = WindowsJob()
            kwargs.update(job.creation_kwargs)
        else:
            kwargs.update(PosixProcessGroup.creation_kwargs)
        try:
            child = subprocess.Popen(command, **kwargs)  # type: ignore[arg-type]
            if job is not None:
                try:
                    job.assign(child)
                except Exception as exc:
                    raise ProcessLaunchError(str(exc)) from exc
        except (OSError, ProcessLaunchError):
            if job is not None:
                job.close()
            raise
        owner = job if job is not None else PosixProcessGroup(child.pid)
        owned = cls(child, owner)
        if on_output is not None and child.stdout is not None:
            def stream() -> None:
                while True:
                    # TextIOWrapper.readline(size) returns a partial line when
                    # the size is reached, so a multi-megabyte/no-newline
                    # stream remains bounded while still being live.
                    chunk = child.stdout.readline(OUTPUT_READ_CHARS)
                    if not chunk:
                        break
                    try:
                        on_output(chunk.rstrip("\r\n"))
                    except Exception:
                        # A logging/diagnostic callback must never stop the
                        # reader: continuing to drain the pipe prevents a
                        # verbose child from blocking on a full buffer.
                        continue
            owned.output_thread = threading.Thread(target=stream, name="auvra-vite-output", daemon=True)
            owned.output_thread.start()
        return owned

    def poll(self) -> int | None:
        return self.process.poll()

    def is_alive(self) -> bool:
        return self.poll() is None

    def wait(self, timeout: float | None = None) -> int:
        return self.process.wait(timeout=timeout)

    def terminate(self, *, grace: float = 3.0) -> None:
        if self._closed:
            return
        cleanup_error: Exception | None = None
        try:
            try:
                self.owner.terminate(self.process)
            except Exception:
                # Graceful signalling is best effort. The owned group/job hard
                # stop below remains mandatory and authoritative.
                pass
            if self.is_alive():
                try:
                    self.process.wait(timeout=grace)
                except subprocess.TimeoutExpired:
                    pass
            # Ensure descendants that outlive the root are gone too. This
            # remains scoped to the launcher's process group/job.
            try:
                self.owner.kill(self.process)
            except Exception as exc:
                cleanup_error = exc
            if self.is_alive():
                try:
                    self.process.wait(timeout=grace)
                except subprocess.TimeoutExpired:
                    # A last resort on the exact owned pid. POSIX groups and
                    # Job Objects already cover descendants; this is not
                    # name-based.
                    self.process.kill()
                    try:
                        self.process.wait(timeout=grace)
                    except subprocess.TimeoutExpired as exc:
                        raise ProcessCleanupError(
                            f"process {self.process.pid} did not stop"
                        ) from exc
        except Exception as exc:
            cleanup_error = cleanup_error or exc
        finally:
            try:
                self._close_owner()
            except Exception as exc:
                cleanup_error = cleanup_error or exc
            finally:
                if self.output_thread is not None:
                    self.output_thread.join(timeout=1.0)
                if self.process.stdout is not None and not self.process.stdout.closed:
                    self.process.stdout.close()
                self._closed = True
        if cleanup_error is not None:
            if isinstance(cleanup_error, ProcessCleanupError):
                raise cleanup_error
            raise ProcessCleanupError(str(cleanup_error)) from cleanup_error

    def _close_owner(self) -> None:
        close = getattr(self.owner, "close", None)
        if close:
            close()


def run_owned_command(
    argv: Sequence[str | os.PathLike[str]],
    *,
    cwd: str | os.PathLike[str],
    env: Mapping[str, str] | None = None,
    shell: bool = False,
    check: bool = False,
    text: bool = True,
    encoding: str = "utf-8",
    errors: str = "replace",
    stdout: int | None = subprocess.PIPE,
    stderr: int | None = subprocess.STDOUT,
    timeout: float | None = 10.0,
) -> subprocess.CompletedProcess[str]:
    """Run a finite command inside the same owned-tree boundary as Vite.

    A timeout is enforced while the child remains in its private process
    group/job. TimeoutExpired is re-raised only after graceful interrupt and
    forced owned-tree cleanup have completed.
    """

    if shell or not text:
        raise ValueError("owned commands require shell=False and text=True")
    if encoding.lower().replace("_", "-") != "utf-8" or errors != "replace":
        raise ValueError("owned commands require UTF-8 replacement decoding")
    if stdout != subprocess.PIPE or stderr != subprocess.STDOUT:
        raise ValueError("owned commands require captured combined output")
    output_tail = bytearray()

    def capture(chunk: str) -> None:
        encoded = chunk.encode("utf-8", "replace")
        output_tail.extend(encoded)
        if len(output_tail) > MAX_CAPTURE_BYTES:
            del output_tail[:len(output_tail) - MAX_CAPTURE_BYTES]

    owned = OwnedProcess.launch(
        argv,
        Path(cwd),
        on_output=capture,
        env=env,
    )
    try:
        return_code = owned.wait(timeout=timeout)
    finally:
        owned.terminate()
    output = bytes(output_tail).decode("utf-8", "replace")
    command = [os.fspath(item) for item in argv]
    result = subprocess.CompletedProcess(command, return_code, output, None)
    if check and return_code:
        raise subprocess.CalledProcessError(return_code, command, output=output)
    return result
