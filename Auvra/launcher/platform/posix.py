"""POSIX process-group ownership."""

from __future__ import annotations

import os
import signal
from typing import Any


class PosixProcessGroup:
    """Start a child in a new session and signal exactly that process group."""

    creation_kwargs = {"start_new_session": True}

    def __init__(self, pgid: int | None = None) -> None:
        self.pgid = pgid

    def attach(self, process: Any) -> None:
        # The child is the session/process-group leader when start_new_session
        # is used. Keep the id even after the root exits so descendants can be
        # cleaned up without relying on a potentially reused process id.
        self.pgid = process.pid

    def terminate(self, process: Any, *, force: bool = False) -> None:
        sig = signal.SIGKILL if force else signal.SIGINT
        try:
            pgid = self.pgid if self.pgid is not None else os.getpgid(process.pid)
            os.killpg(pgid, sig)
        except ProcessLookupError:
            # The process may have exited between poll and signalling. Never
            # broaden this to a name- or port-based kill.
            return

    def kill(self, process: Any) -> None:
        self.terminate(process, force=True)

    def close(self) -> None:
        """POSIX process groups do not own an operating-system handle."""
