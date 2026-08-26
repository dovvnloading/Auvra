"""Platform-specific process ownership primitives."""

from __future__ import annotations

import os

from .posix import PosixProcessGroup

if os.name == "nt":
    from .windows_job import WindowsJob
else:
    WindowsJob = None  # type: ignore[assignment,misc]

__all__ = ["PosixProcessGroup", "WindowsJob"]
