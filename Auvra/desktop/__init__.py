"""Python-owned desktop frame boundary.

The package is intentionally importable on every supported development host;
the optional Windows WebView2 runtime is loaded only when a frame is started.
"""

from .contracts import (
    FrameConfig,
    FrameError,
    FrameFailure,
    FrameMode,
    FrameState,
    FrameUnavailableError,
)
from .policy import FramePolicy, PolicyDecision
from .controller import FrameController

__all__ = [
    "FrameConfig", "FrameError", "FrameFailure", "FrameMode", "FramePolicy",
    "FrameState", "FrameUnavailableError", "PolicyDecision", "FrameController",
]
