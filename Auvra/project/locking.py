"""OS-backed advisory exclusive lock; metadata is informational only."""
from __future__ import annotations
import os, socket
from pathlib import Path
from typing import IO
from .errors import LockError
from Auvra.diagnostics.core import trace_public_class

@trace_public_class("project_lock", concise=("acquire", "release"))
class ProjectLock:
    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path); self._file: IO[bytes] | None = None
    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stream = self.path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                stream.seek(0); stream.write(b"0"); stream.flush(); stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, IOError):
            stream.close(); return False
        self._file = stream
        stream.seek(0); stream.truncate(); stream.write(f"{os.getpid()} {socket.gethostname()}\n".encode()); stream.flush()
        return True
    def release(self) -> None:
        if self._file is None: return
        try:
            if os.name == "nt":
                import msvcrt
                self._file.seek(0); msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl; fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        finally:
            self._file.close(); self._file = None
    def __enter__(self):
        if not self.acquire(): raise LockError("project is already open by another process")
        return self
    def __exit__(self, *_): self.release()
