"""Small, platform-neutral contracts for an Auvra desktop frame."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
import tempfile
from typing import Any, Callable, Mapping, Protocol


_REPO_FRONTEND_DIST = Path(__file__).resolve().parents[2] / "fbx-viewer (1)" / "dist"
_REPO_LAUNCHER_STATE = _REPO_FRONTEND_DIST.parent / ".auvra-launcher"

# Tests may explicitly add an OS-temp parent while constructing disposable
# frames.  This is deliberately empty in production; a basename or a marker
# is never enough to make an arbitrary caller-chosen directory trusted.
_CONTROLLED_TEST_PROFILE_PARENTS: set[Path] = set()
_PROFILE_LEASE_MARKER = ".auvra-profile-lease"


def _profile_parent_is_allowed(value: Path | str) -> bool:
    """Return whether ``value`` is an exact launcher or controlled test root."""

    try:
        candidate = Path(value).expanduser().absolute().resolve(strict=False)
        approved = _REPO_LAUNCHER_STATE.resolve(strict=False)
        if candidate == approved:
            return True
        temp_root = Path(tempfile.gettempdir()).resolve()
        controlled = {
            Path(item).expanduser().absolute().resolve(strict=False)
            for item in _CONTROLLED_TEST_PROFILE_PARENTS
        }
        return candidate != temp_root and candidate in controlled and candidate.is_relative_to(temp_root)
    except (OSError, RuntimeError, ValueError):
        return False


class FrameError(RuntimeError):
    """Base class for bounded, user-actionable frame errors."""


class FrameConfigurationError(FrameError, ValueError):
    """The frame configuration is not safe or internally consistent."""


class FrameUnavailableError(FrameError):
    """The selected native frame cannot be used on this machine."""


class FrameStartupError(FrameError):
    """The native frame failed during bounded startup."""


class FrameClosedError(FrameError):
    """An operation was attempted after the frame was closed."""


class FrameMode(str, Enum):
    DEVELOPMENT = "development"
    PACKAGED = "packaged"


class FrameState(str, Enum):
    NEW = "new"
    STARTING = "starting"
    READY = "ready"
    CLOSING = "closing"
    CLOSED = "closed"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class FrameFailure:
    """Safe failure information; native exception messages are not exposed."""

    code: str
    message: str


# The raw JSON body and WebView2's absolute Source URI are passed separately;
# callers must validate both before dispatching.
MessageCallback = Callable[[str, str], None]
LifecycleCallback = Callable[[str, Mapping[str, Any] | None], None]


class Frame(Protocol):
    def start(self) -> None: ...
    def close(self, timeout: float = 5.0) -> None: ...


def _immutable_root(value: Path | str | None) -> Path | None:
    if value is None:
        return None
    candidate = Path(value).expanduser().absolute()
    # A resolved path is not sufficient: a junction/symlink could later make
    # the mapped virtual host expose content outside the approved tree.
    current = Path(candidate.anchor)
    try:
        for component in candidate.parts[1:]:
            current = current / component
            if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
                raise FrameConfigurationError("packaged root cannot contain symlinks or junctions")
            try:
                attrs = current.stat().st_file_attributes
            except (AttributeError, OSError):
                attrs = 0
            if attrs & 0x400:  # FILE_ATTRIBUTE_REPARSE_POINT (junction/mount point)
                raise FrameConfigurationError("packaged root cannot contain reparse points")
        path = candidate.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise FrameConfigurationError("packaged root must be an existing directory") from exc
    if not path.is_dir():
        raise FrameConfigurationError("packaged root must be a directory")
    try:
        for descendant in path.rglob("*"):
            if descendant.is_symlink() or (hasattr(descendant, "is_junction") and descendant.is_junction()):
                raise FrameConfigurationError("packaged root cannot contain descendant links")
            try:
                if descendant.stat().st_file_attributes & 0x400:
                    raise FrameConfigurationError("packaged root cannot contain descendant reparse points")
            except AttributeError:
                pass
    except OSError as exc:
        raise FrameConfigurationError("packaged root could not be inspected safely") from exc
    # A virtual HTTPS host is a privileged content boundary.  Only the exact
    # repository build output may be mapped; a marker inside a caller-chosen
    # directory would be forgeable and would turn arbitrary local HTML into
    # trusted host content.
    try:
        approved_repo_dist = _REPO_FRONTEND_DIST.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise FrameConfigurationError("the approved Auvra build directory is unavailable") from exc
    if path != approved_repo_dist or not (path / "index.html").is_file():
        raise FrameConfigurationError("packaged root is not the approved Auvra build directory")
    return path


def _safe_profile_path(value: Path | str | None) -> Path | None:
    if value is None:
        return None
    candidate = Path(value).expanduser().absolute()
    parent = candidate.parent
    try:
        parent_resolved = parent.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise FrameConfigurationError("user-data folder parent is unavailable") from exc
    if not _profile_parent_is_allowed(parent_resolved):
        raise FrameConfigurationError("user-data folder is outside the launcher profile boundary")
    # Profiles must be direct children of an approved parent.  The prefix is
    # only an operator-facing hint; ownership is established by the lease
    # marker and the controller's in-memory lease registry.
    current = Path(candidate.anchor)
    try:
        for component in candidate.parts[1:]:
            current = current / component
            if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
                raise FrameConfigurationError("user-data folder cannot contain links")
            try:
                attrs = current.stat().st_file_attributes
            except (AttributeError, OSError):
                attrs = 0
            if attrs & 0x400:
                raise FrameConfigurationError("user-data folder cannot contain reparse points")
    except (OSError, RuntimeError) as exc:
        raise FrameConfigurationError("user-data folder path is invalid") from exc
    if not candidate.is_dir() or candidate.name == "" or not candidate.name.startswith("webview2-"):
        raise FrameConfigurationError("user-data folder is not a launcher profile")
    marker = candidate / _PROFILE_LEASE_MARKER
    try:
        if marker.is_symlink() or not marker.is_file():
            raise FrameConfigurationError("user-data folder ownership lease is missing")
        raw = marker.read_bytes()
    except (OSError, RuntimeError) as exc:
        raise FrameConfigurationError("user-data folder ownership lease is unreadable") from exc
    if raw.endswith(b"\r\n"):
        raw = raw[:-2] + b"\n"
    if len(raw) < 32 or len(raw) > 256 or not raw.endswith(b"\n"):
        raise FrameConfigurationError("user-data folder ownership lease is invalid")
    try:
        token = raw[:-1].decode("ascii")
    except UnicodeDecodeError as exc:
        raise FrameConfigurationError("user-data folder ownership lease is invalid") from exc
    if not token or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in token):
        raise FrameConfigurationError("user-data folder ownership lease is invalid")
    return candidate


@dataclass(frozen=True, slots=True)
class FrameConfig:
    """Immutable inputs to a frame, including the two trusted content origins."""

    mode: FrameMode
    development_origin: str = ""
    packaged_origin: str = "https://app.auvra.local"
    packaged_root: Path | None = None
    on_message: MessageCallback | None = None
    on_lifecycle: LifecycleCallback | None = None
    startup_timeout: float = 15.0
    shutdown_timeout: float = 5.0
    title: str = "Auvra"
    private_browser_profile: bool = True
    user_data_folder: Path | None = None
    visible: bool = True
    _root_ready: bool = field(init=False, repr=False, default=False)

    def __post_init__(self) -> None:
        from .policy import validate_origin

        mode = self.mode if isinstance(self.mode, FrameMode) else FrameMode(self.mode)
        object.__setattr__(self, "mode", mode)
        try:
            if mode is FrameMode.DEVELOPMENT:
                if not self.development_origin:
                    raise FrameConfigurationError("development origin is required")
                object.__setattr__(self, "development_origin", validate_origin(self.development_origin, development=True))
                if self.packaged_root is not None:
                    raise FrameConfigurationError("packaged root is not allowed in development mode")
            else:
                object.__setattr__(self, "packaged_origin", validate_origin(self.packaged_origin, development=False))
                root = _immutable_root(self.packaged_root)
                if root is None:
                    raise FrameConfigurationError("packaged root is required in packaged mode")
                object.__setattr__(self, "packaged_root", root)
        except FrameConfigurationError:
            raise
        except ValueError as exc:
            raise FrameConfigurationError("frame origins are invalid") from exc
        if not (0.1 <= self.startup_timeout <= 120):
            raise FrameConfigurationError("startup timeout must be between 0.1 and 120 seconds")
        if not (0.1 <= self.shutdown_timeout <= 120):
            raise FrameConfigurationError("shutdown timeout must be between 0.1 and 120 seconds")
        if not self.title or len(self.title) > 128 or any(ord(c) < 32 for c in self.title):
            raise FrameConfigurationError("title must be a short printable string")
        if self.user_data_folder is not None:
            object.__setattr__(self, "user_data_folder", _safe_profile_path(self.user_data_folder))

    @property
    def trusted_origin(self) -> str:
        return self.development_origin if self.mode is FrameMode.DEVELOPMENT else self.packaged_origin
