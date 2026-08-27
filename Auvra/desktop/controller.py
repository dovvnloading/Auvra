"""Composition boundary between the owned Vite process, frame, and host."""

from __future__ import annotations

import json
from pathlib import Path
import secrets
import shutil
import tempfile
import threading
import time
from typing import Any, Callable, Sequence
from urllib.parse import urlsplit

from Auvra.host.dispatcher import HostDispatcher
from Auvra.host.session import SessionManager
from Auvra.host.validation import validate_response

from . import contracts as _contracts
from .assets import AssetResourceRequest, AssetTransferRegistry
from .contracts import (
    Frame,
    FrameClosedError,
    FrameConfig,
    FrameConfigurationError,
    FrameMode,
    FrameStartupError,
)
from .policy import FramePolicy
from .project_host import NativeProjectHost
from .provider_host import NativeProviderHost, _assert_state_path_safe
from .previews import PreviewStore
from .native_engine import (
    NativeEngine,
    NativeEngineError,
    NativeEngineHost,
    NativeEngineUnavailableHost,
)
from .sdk import SdkLayout, acquire_sdk
from .webview2 import WebView2Frame
from .webview2 import MESSAGE_MAX_BYTES


class FrameProcessExitedError(RuntimeError):
    """The launcher-owned frontend stopped before the user closed the frame."""

    def __init__(self, returncode: int) -> None:
        self.returncode = returncode
        super().__init__(f"frontend child exited with status {returncode}")


class _ProfileLease:
    """Opaque, one-launch authority for deleting one browser profile."""

    __slots__ = ("path", "token")

    def __init__(self, path: Path, token: str) -> None:
        self.path = path
        self.token = token


def _is_link_or_reparse(path: Path) -> bool:
    try:
        if not path.exists() and not path.is_symlink():
            return False
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            return True
        # ``st_file_attributes`` is Windows-only.  On POSIX, a normal stat
        # result has no such field and should not be treated as a reparse
        # point merely because the optional attribute is absent.
        attributes = getattr(path.stat(), "st_file_attributes", 0)
        return bool(attributes & 0x400)
    except (AttributeError, OSError, RuntimeError):
        return True


def _assert_profile_parent_is_safe(parent: Path) -> None:
    current = Path(parent.anchor)
    try:
        for component in parent.parts[1:]:
            current = current / component
            if _is_link_or_reparse(current):
                raise OSError("WebView2 profile parent cannot contain links or reparse points")
    except (OSError, RuntimeError) as exc:
        raise OSError("WebView2 profile parent cannot be inspected safely") from exc


class FrameController:
    """Own one Vite tree and one frame with deterministic teardown."""

    def __init__(self, process: Any, *, frame: Frame, dispatcher: HostDispatcher | None = None,
                  profile_path: Path | None = None, profile_lease: _ProfileLease | None = None,
                  project_host: NativeProjectHost | None = None,
                  provider_host: NativeProviderHost | None = None,
                  preview_store: PreviewStore | None = None,
                  asset_registry: AssetTransferRegistry | None = None,
                  native_engine_host: NativeEngineHost | NativeEngineUnavailableHost | None = None,
                  poll_interval: float = 0.1) -> None:
        self.process = process
        self.frame = frame
        # Rebuild the policy from the immutable frame configuration at this
        # boundary.  A test/native adapter cannot weaken source checks by
        # supplying a permissive policy object (or by omitting one entirely).
        config = getattr(frame, "config", None)
        if config is None or not isinstance(config, FrameConfig):
            raise FrameConfigurationError("desktop frame adapter must expose a valid frame configuration")
        if not callable(getattr(getattr(frame, "policy", None), "allow_message", None)):
            raise FrameConfigurationError("desktop frame adapter must expose an origin policy")
        self.policy = FramePolicy(config.mode, config.trusted_origin,
                                  packaged_root=str(config.packaged_root) if config.packaged_root else None)
        self.dispatcher = dispatcher or HostDispatcher(SessionManager("s-" + secrets.token_urlsafe(24)))
        self.project_host = project_host
        self.provider_host = provider_host
        self.preview_store = preview_store
        self.asset_registry = asset_registry
        self.native_engine_host = native_engine_host
        self.profile_path = profile_path
        self._profile_lease = profile_lease
        self.poll_interval = max(0.02, poll_interval)
        self._lock = threading.RLock()
        self._closed = False
        self._process_stopped = False
        self.cleanup_error: Exception | None = None

    @classmethod
    def development(cls, process: Any, origin: str, *, profile_parent: Path,
                    dispatcher: HostDispatcher | None = None,
                    native_command: Sequence[str] | None = None,
                    frame_factory: Callable[..., Frame] = WebView2Frame) -> "FrameController":
        lease = _new_profile(profile_parent)
        profile = lease.path
        parsed = urlsplit(origin)
        exact_origin = f"{parsed.scheme}://{parsed.netloc}"
        holder: dict[str, FrameController] = {}
        active_dispatcher = dispatcher or HostDispatcher(SessionManager("s-" + secrets.token_urlsafe(24)))
        asset_registry: AssetTransferRegistry | None = None
        project_host: NativeProjectHost | None = None
        preview_store: PreviewStore | None = None
        provider_host: NativeProviderHost | None = None
        native_engine_host: NativeEngineHost | NativeEngineUnavailableHost = NativeEngineUnavailableHost()
        try:
            asset_registry = AssetTransferRegistry(
                profile.parent / "asset-transfers",
                session_id=active_dispatcher.session.session_id,
                trusted_origin=exact_origin,
            )
            project_host = NativeProjectHost(profile.parent, asset_registry=asset_registry)
            _assert_state_path_safe(profile.parent / "previews")
            _assert_state_path_safe(profile.parent / "provider-state")
            preview_store = PreviewStore(profile.parent / "previews")
            project_host.set_preview_store(preview_store)
            provider_host = NativeProviderHost(profile.parent / "provider-state", project_host=project_host, preview_store=preview_store)
            if native_command:
                candidate = NativeEngineHost(NativeEngine(tuple(native_command)))
                try:
                    candidate.start(editor_session=active_dispatcher.session.session_id)
                    native_engine_host = candidate
                except NativeEngineError:
                    candidate.close(timeout=1)
                    native_engine_host = NativeEngineUnavailableHost("Native engine startup failed; using the web compatibility renderer")
            active_dispatcher.bind_services(
                project_service=project_host, asset_service=project_host,
                provider_service=provider_host, engine_service=native_engine_host,
            )
            config = FrameConfig(FrameMode.DEVELOPMENT, development_origin=exact_origin,
                                 user_data_folder=profile,
                                 on_message=lambda body, source: holder["controller"].on_message(body, source),
                                 on_lifecycle=lambda event, fields=None: holder["controller"].on_lifecycle(event, fields),
                                 on_asset_resource=lambda request: holder["controller"].on_asset_resource(request))
            if frame_factory is WebView2Frame:
                sdk = acquire_sdk(profile.parent / "webview2-sdk")
                frame = frame_factory(config, sdk=sdk)
            else:
                frame = frame_factory(config)
        except Exception:
            if provider_host is not None:
                provider_host.shutdown()
            if preview_store is not None:
                preview_store.close()
            if project_host is not None:
                project_host.shutdown()
            if asset_registry is not None:
                asset_registry.close()
            if isinstance(native_engine_host, NativeEngineHost):
                native_engine_host.close(timeout=1)
            _remove_profile(lease)
            raise
        controller = cls(
            process,
            frame=frame,
            dispatcher=active_dispatcher,
            profile_path=profile,
            profile_lease=lease,
            project_host=project_host,
            provider_host=provider_host,
            preview_store=preview_store,
            asset_registry=asset_registry,
            native_engine_host=native_engine_host,
        )
        holder["controller"] = controller
        return controller

    @classmethod
    def packaged(cls, process: Any, packaged_root: Path, *, profile_parent: Path,
                 dispatcher: HostDispatcher | None = None,
                 native_command: Sequence[str] | None = None,
                 sdk: SdkLayout | None = None,
                 browser_executable_folder: Path | None = None,
                 frame_factory: Callable[..., Frame] = WebView2Frame) -> "FrameController":
        """Build a controller mapped to one immutable frontend ``dist`` tree."""
        # Validate privileged packaged content before creating any browser
        # profile.  An unapproved root is a configuration/dependency failure,
        # not a child-process failure caused incidentally by profile setup.
        approved_root = _contracts._immutable_root(packaged_root)
        if approved_root is None:  # Defensive: ``packaged_root`` is required.
            raise FrameConfigurationError("packaged root is required in packaged mode")
        lease = _new_profile(profile_parent)
        profile = lease.path
        holder: dict[str, FrameController] = {}
        active_dispatcher = dispatcher or HostDispatcher(SessionManager("s-" + secrets.token_urlsafe(24)))
        asset_registry: AssetTransferRegistry | None = None
        project_host: NativeProjectHost | None = None
        preview_store: PreviewStore | None = None
        provider_host: NativeProviderHost | None = None
        native_engine_host: NativeEngineHost | NativeEngineUnavailableHost = (
            NativeEngineUnavailableHost("Native engine is unavailable; using the web compatibility renderer")
        )
        try:
            asset_registry = AssetTransferRegistry(
                profile.parent / "asset-transfers",
                session_id=active_dispatcher.session.session_id,
                trusted_origin="https://app.auvra.local",
            )
            project_host = NativeProjectHost(profile.parent, asset_registry=asset_registry)
            _assert_state_path_safe(profile.parent / "previews")
            _assert_state_path_safe(profile.parent / "provider-state")
            preview_store = PreviewStore(profile.parent / "previews")
            project_host.set_preview_store(preview_store)
            provider_host = NativeProviderHost(profile.parent / "provider-state", project_host=project_host, preview_store=preview_store)
            if native_command:
                candidate = NativeEngineHost(NativeEngine(tuple(native_command)))
                try:
                    candidate.start(editor_session=active_dispatcher.session.session_id)
                    native_engine_host = candidate
                except NativeEngineError:
                    candidate.close(timeout=1)
                    native_engine_host = NativeEngineUnavailableHost(
                        "Native engine startup failed; using the web compatibility renderer"
                    )
            active_dispatcher.bind_services(
                project_service=project_host, asset_service=project_host,
                provider_service=provider_host, engine_service=native_engine_host,
            )
            config = FrameConfig(FrameMode.PACKAGED, packaged_root=approved_root,
                                 browser_executable_folder=browser_executable_folder,
                                 user_data_folder=profile,
                                 on_message=lambda body, source: holder["controller"].on_message(body, source),
                                 on_lifecycle=lambda event, fields=None: holder["controller"].on_lifecycle(event, fields),
                                 on_asset_resource=lambda request: holder["controller"].on_asset_resource(request))
            if frame_factory is WebView2Frame:
                if sdk is None or browser_executable_folder is None:
                    raise FrameConfigurationError(
                        "packaged mode requires verified WebView2 SDK and fixed runtime layouts"
                    )
                frame = frame_factory(config, sdk=sdk)
            else:
                frame = frame_factory(config)
        except Exception:
            if provider_host is not None:
                provider_host.shutdown()
            if preview_store is not None:
                preview_store.close()
            if project_host is not None:
                project_host.shutdown()
            if asset_registry is not None:
                asset_registry.close()
            if isinstance(native_engine_host, NativeEngineHost):
                native_engine_host.close(timeout=1)
            _remove_profile(lease)
            raise
        controller = cls(
            process,
            frame=frame,
            dispatcher=active_dispatcher,
            profile_path=profile,
            profile_lease=lease,
            project_host=project_host,
            provider_host=provider_host,
            preview_store=preview_store,
            asset_registry=asset_registry,
            native_engine_host=native_engine_host,
        )
        holder["controller"] = controller
        return controller

    def start(self) -> None:
        try:
            self.frame.start()
            self._drain_lifecycle()
        except Exception:
            self.close()
            raise

    def run(self) -> int:
        """Wait while both owned resources are alive, then close the frame."""
        try:
            while True:
                self._drain_lifecycle()
                if self.project_host is not None:
                    self.project_host.tick()
                if self.provider_host is not None:
                    self.provider_host.tick()
                self._flush_bound_events()
                state = getattr(self.frame, "state", None)
                state_value = getattr(state, "value", state)
                failure = getattr(self.frame, "failure", None)
                if failure is not None or state_value == "failed":
                    message = getattr(failure, "message", "The Auvra desktop frame failed")
                    raise FrameStartupError(str(message))
                if state_value == "closed":
                    return 0
                if not self._process_alive():
                    raise FrameProcessExitedError(int(self.process.poll() or 0))
                time.sleep(self.poll_interval)
        except KeyboardInterrupt:
            raise
        finally:
            self.close()

    def on_message(self, body: str, source: str) -> None:
        """Dispatch a source-gated JSON request and post its safe response."""
        if not isinstance(source, str) or not self.policy.allow_message(source):
            return
        if not isinstance(body, str) or len(body.encode("utf-8", "replace")) > MESSAGE_MAX_BYTES:
            return
        try:
            request = json.loads(body)
        except (TypeError, ValueError, json.JSONDecodeError):
            request = None
        response = self.dispatcher.dispatch(request)
        events = self.dispatcher.drain_bound_events()
        if events:
            # Deliver state events before resolving the request promise, then
            # stamp the response with the final host revision.  Otherwise a
            # frontend continuation could issue its next request from the
            # response revision while the host had already advanced for
            # queued events.
            for event in events:
                self._post(event)
            response = dict(response)
            response["revision"] = self.dispatcher.session.revision
            response = validate_response(response)
        self._post(response)

    def on_asset_resource(self, request: AssetResourceRequest):
        if self.project_host is None:
            raise RuntimeError("native project asset service is unavailable")
        return self.project_host.asset_resource(request)

    def _post(self, payload: dict[str, Any]) -> None:
        try:
            # post_message performs the UI-thread handoff and accepts only a
            # compact JSON object; this serialization never includes logs.
            self.frame.post_message(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))  # type: ignore[attr-defined]
        except FrameClosedError:
            return

    def _flush_bound_events(self) -> None:
        """Post validated native-service events in dispatcher revision order."""

        for event in self.dispatcher.drain_bound_events():
            self._post(event)

    def on_lifecycle(self, event: str, fields: dict[str, Any] | None = None) -> None:
        # NavigationCompleted is the authoritative document boundary.  The
        # native adapter also emits ``ready`` for the first successful load;
        # that signal is state-only so the initial document gets exactly one
        # session envelope, just like every subsequent full reload.
        if event == "navigation_completed":
            self._post(self.dispatcher.session.envelope())
        elif event == "closed":
            self._stop_process()

    def _drain_lifecycle(self) -> None:
        # Retained as a small compatibility hook for callers that previously
        # drained deferred lifecycle work.  Native callbacks now enqueue the
        # UI-safe post themselves, so there is no hidden timing dependency.
        return

    def _process_alive(self) -> bool:
        try:
            return bool(self.process.is_alive())
        except (AttributeError, OSError):
            return False

    def _stop_process(self) -> None:
        with self._lock:
            if self._process_stopped:
                return
            self._process_stopped = True
        try:
            self.process.terminate()
        except Exception as exc:
            # The CLI owns final error reporting; lifecycle callbacks must not
            # re-enter the native event loop with an exception.
            self.cleanup_error = self.cleanup_error or exc

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            self.frame.close()
        except Exception as exc:
            # Continue to process cleanup even when native shutdown fails.
            self.cleanup_error = exc
        if self.provider_host is not None:
            try:
                self.provider_host.shutdown()
            except Exception as exc:
                self.cleanup_error = self.cleanup_error or exc
        if self.preview_store is not None:
            try:
                self.preview_store.close()
            except Exception as exc:
                self.cleanup_error = self.cleanup_error or exc
        if self.project_host is not None:
            try:
                self.project_host.shutdown()
            except Exception as exc:
                self.cleanup_error = self.cleanup_error or exc
        if self.asset_registry is not None:
            try:
                self.asset_registry.close()
            except OSError as exc:
                self.cleanup_error = self.cleanup_error or exc
        if isinstance(self.native_engine_host, NativeEngineHost):
            try:
                self.native_engine_host.close()
            except NativeEngineError as exc:
                self.cleanup_error = self.cleanup_error or exc
        self._stop_process()
        if self.profile_path is not None:
            try:
                _remove_profile(self._profile_lease)
            except OSError as exc:
                self.cleanup_error = self.cleanup_error or exc


def _new_profile(parent: Path) -> _ProfileLease:
    parent = parent.expanduser().absolute()
    try:
        resolved_parent = parent.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise OSError("WebView2 profile parent is invalid") from exc
    if not _contracts._profile_parent_is_allowed(resolved_parent):
        raise OSError("WebView2 profile parent is outside the launcher profile boundary")
    _assert_profile_parent_is_safe(parent)
    parent.mkdir(parents=True, exist_ok=True)
    # Recheck after mkdir: a caller cannot swap a link into the parent between
    # the initial validation and profile creation.
    _assert_profile_parent_is_safe(parent)
    profile = Path(tempfile.mkdtemp(prefix="webview2-", dir=parent)).absolute()
    if _is_link_or_reparse(profile):
        raise OSError("WebView2 profile cannot be a link")
    token = secrets.token_urlsafe(32)
    marker = profile / _contracts._PROFILE_LEASE_MARKER
    try:
        with marker.open("x", encoding="ascii", newline="\n") as stream:
            stream.write(token + "\n")
            stream.flush()
    except OSError:
        shutil.rmtree(profile, ignore_errors=False)
        raise
    return _ProfileLease(profile, token)


def _remove_profile(lease: _ProfileLease | None) -> None:
    """Delete only a live lease created by this process and launch."""

    if lease is None or not isinstance(lease, _ProfileLease):
        return
    candidate = lease.path.absolute()
    if candidate.name == "" or not candidate.exists() and not candidate.is_symlink():
        return
    try:
        parent = candidate.parent.resolve(strict=True)
        _assert_profile_parent_is_safe(candidate.parent)
    except (OSError, RuntimeError):
        return
    if not _contracts._profile_parent_is_allowed(parent):
        return
    if not candidate.name.startswith("webview2-"):
        return
    if _is_link_or_reparse(candidate):
        return
    marker = candidate / _contracts._PROFILE_LEASE_MARKER
    try:
        if marker.is_symlink() or not marker.is_file():
            return
        marker_bytes = marker.read_bytes()
        if marker_bytes.endswith(b"\r\n"):
            marker_bytes = marker_bytes[:-2] + b"\n"
        if marker_bytes != (lease.token + "\n").encode("ascii"):
            return
    except (OSError, UnicodeEncodeError):
        return
    # Revalidate the complete path immediately before recursive deletion.  In
    # addition to preventing forged names/markers, this preserves the existing
    # fail-closed behavior for junctions, symlinks, and reparse points.
    try:
        _assert_profile_parent_is_safe(candidate.parent)
    except OSError:
        return
    if _is_link_or_reparse(candidate):
        return
    last: OSError | None = None
    for _ in range(10):
        try:
            shutil.rmtree(candidate)
            return
        except OSError as exc:
            last = exc
            time.sleep(0.1)
    if last is not None:
        raise last
