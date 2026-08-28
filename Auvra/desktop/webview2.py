"""Direct Python.NET adapter for Microsoft's WebView2 WinForms control."""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
import json
import os
from pathlib import Path
import struct
import subprocess
import threading
from typing import Any, Callable

from .assets import (
    AssetResourceRequest,
    AssetResourceResponse,
    AssetTransportError,
    is_asset_resource_url,
)
from .contracts import (
    FrameClosedError,
    FrameConfig,
    FrameFailure,
    FrameMode,
    FrameStartupError,
    FrameState,
    FrameUnavailableError,
)
from .policy import FramePolicy
from .sdk import SdkLayout, acquire_sdk
from Auvra.host.validation import ProtocolValidationError, validate_message

MESSAGE_MAX_BYTES = 256 * 1024


class WebView2Frame:
    """Own a WinForms/WebView2 UI loop on one dedicated STA thread.

    Native objects are intentionally kept behind this class. Event handlers
    below only inspect small event arguments and are therefore straightforward
    to exercise with ``tests.desktop.fakes`` without a Windows GUI.
    """

    def __init__(self, config: FrameConfig, *, sdk: SdkLayout | None = None,
                 sdk_cache: Path | str | None = None,
                 sdk_acquirer: Callable[..., SdkLayout] = acquire_sdk) -> None:
        self.config = config
        self.policy = FramePolicy(config.mode, config.trusted_origin,
                                  packaged_root=str(config.packaged_root) if config.packaged_root else None)
        self._sdk = sdk
        self._sdk_cache = sdk_cache
        self._sdk_acquirer = sdk_acquirer
        self._state = FrameState.NEW
        self._lock = threading.RLock()
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._browser_exited = threading.Event()
        self._failure: FrameFailure | None = None
        self._thread: Any = None
        self._form: Any = None
        self._control: Any = None
        self._core: Any = None
        self._environment: Any = None
        self._browser_process_id: int | None = None
        self._dll_directory_handle: Any = None
        self._pending_actions: list[Any] = []
        self._resource_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="auvra-assets")
        self._resource_slots = threading.BoundedSemaphore(4)

    @property
    def state(self) -> FrameState:
        with self._lock:
            return self._state

    def invoke_on_ui(self, callback: Callable[[], Any]) -> Any:
        """Run only the small native-UI portion of a host operation on STA."""

        with self._lock:
            form = self._form
            state = self._state
        if form is None or state in {FrameState.CLOSING, FrameState.CLOSED, FrameState.FAILED}:
            raise FrameClosedError("desktop frame is not available")
        if not bool(getattr(form, "InvokeRequired", True)):
            return callback()

        completed = threading.Event()
        result: dict[str, Any] = {}

        def invoke() -> None:
            try:
                result["value"] = callback()
            except BaseException as exc:
                result["error"] = exc
            finally:
                completed.set()
                with self._lock:
                    if action in self._pending_actions:
                        self._pending_actions.remove(action)

        from System import Action  # type: ignore[import-not-found]

        action = Action(invoke)
        with self._lock:
            self._pending_actions.append(action)
        try:
            form.BeginInvoke(action)
        except Exception:
            with self._lock:
                if action in self._pending_actions:
                    self._pending_actions.remove(action)
            raise FrameClosedError("desktop frame is not available") from None

        while not completed.wait(0.1):
            with self._lock:
                if self._state in {FrameState.CLOSING, FrameState.CLOSED, FrameState.FAILED}:
                    raise FrameClosedError("desktop frame closed during native UI operation")
        if "error" in result:
            raise result["error"]
        return result.get("value")

    @property
    def failure(self) -> FrameFailure | None:
        with self._lock:
            return self._failure

    def dock_target(self) -> dict[str, int] | None:
        """Return the current native parent handle and client size, if ready.

        This is deliberately a read-only seam. It exposes no WebView2 object,
        filesystem path, or browser authority and returns ``None`` until the
        frame has a live WinForms handle.
        """
        with self._lock:
            form, state = self._form, self._state
        if state is not FrameState.READY or form is None:
            return None
        try:
            handle = getattr(form, "Handle")
            to_int = getattr(handle, "ToInt64", None)
            value = int(to_int() if callable(to_int) else handle)
            size = getattr(form, "ClientSize", None)
            width = int(getattr(size, "Width", getattr(form, "ClientSize.Width", 0)))
            height = int(getattr(size, "Height", getattr(form, "ClientSize.Height", 0)))
        except (AttributeError, TypeError, ValueError, OverflowError):
            return None
        if value <= 0 or width <= 0 or height <= 0:
            return None
        return {"parentHandle": value, "width": width, "height": height}

    @property
    def native_parent_handle(self) -> int | None:
        target = self.dock_target()
        return None if target is None else target["parentHandle"]

    def _signal(self, event: str, fields: dict[str, Any] | None = None) -> None:
        callback = self.config.on_lifecycle
        if callback is not None:
            try:
                callback(event, fields)
            except Exception:
                # Host lifecycle notifications must not take down the native
                # loop. No callback exception is allowed to escape to WebView.
                pass

    def _fail(self, code: str, message: str) -> None:
        with self._lock:
            if self._state in {FrameState.CLOSED, FrameState.FAILED}:
                return
            self._failure = FrameFailure(code, message)
            self._state = FrameState.FAILED
        self._ready.set()
        self._signal("failure", {"code": code, "message": message})

    def start(self) -> None:
        with self._lock:
            if self._state is FrameState.READY:
                return
            if self._state in {FrameState.STARTING, FrameState.CLOSING}:
                raise FrameStartupError("Auvra frame is already starting or closing")
            if self._state in {FrameState.CLOSED, FrameState.FAILED}:
                raise FrameClosedError("Auvra frame cannot be restarted")
            self._state = FrameState.STARTING
            self._thread = self._create_sta_thread()
            self._thread.Start()
        if not self._ready.wait(self.config.startup_timeout):
            self._fail("startup_timeout", "Auvra desktop frame did not become ready in time")
            self.close(timeout=self.config.shutdown_timeout)
            raise FrameStartupError("Auvra desktop frame startup timed out")
        failure = self.failure
        if failure is not None:
            self.close(timeout=self.config.shutdown_timeout)
            raise FrameStartupError(failure.message)

    def close(self, timeout: float | None = None) -> None:
        timeout = self.config.shutdown_timeout if timeout is None else max(0.1, timeout)
        with self._lock:
            if self._state is FrameState.CLOSED:
                return
            self._state = FrameState.CLOSING
            form = self._form
            thread = self._thread
        self._resource_executor.shutdown(wait=False, cancel_futures=True)
        if form is not None:
            try:
                from System import Action  # type: ignore[import-not-found]
                form.BeginInvoke(Action(self._close_on_ui_thread))
            except Exception:
                # A disposed form or a UI thread that has not initialized is
                # handled by the native loop's finally block.
                self._closed.set()
        else:
            self._closed.set()
        if thread is not None and not self._on_native_thread():
            thread.Join(max(1, int(timeout * 1000)))
            if bool(getattr(thread, "IsAlive", False)):
                self._fail("shutdown_timeout", "Auvra desktop frame did not close in time")
                raise FrameStartupError("Auvra desktop frame shutdown timed out")
            self._browser_exited.wait(min(timeout, 2.0))
            if not self._browser_exited.is_set():
                self._terminate_owned_browser()
        with self._lock:
            self._state = FrameState.CLOSED
        self._closed.set()

    def post_message(self, message: str | dict[str, Any]) -> None:
        """Post a JSON message on the WebView2 UI thread without blocking it."""
        with self._lock:
            core, form, state = self._core, self._form, self._state
        if state is not FrameState.READY or core is None or form is None:
            raise FrameClosedError("Auvra frame is not ready")
        if isinstance(message, dict):
            body = json.dumps(message, ensure_ascii=True, separators=(",", ":"))
        elif isinstance(message, str):
            body = message
            if len(body.encode("utf-8", "replace")) > MESSAGE_MAX_BYTES:
                raise ValueError("message exceeds the protocol size limit")
            try:
                parsed = json.loads(body)
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise ValueError("message must be valid JSON") from exc
            try:
                validate_message(parsed)
            except ProtocolValidationError as exc:
                raise ValueError("message is not a valid protocol envelope") from exc
        else:
            raise TypeError("message must be JSON text or an object")
        if isinstance(message, dict):
            try:
                validate_message(message)
            except ProtocolValidationError as exc:
                raise ValueError("message is not a valid protocol envelope") from exc
        if len(body.encode("utf-8")) > MESSAGE_MAX_BYTES:
            raise ValueError("message exceeds the protocol size limit")

        def send() -> None:
            try:
                if self._core is not None:
                    self._core.PostWebMessageAsJson(body)
            finally:
                # Keep the Python.NET delegate rooted until WinForms invokes
                # it; otherwise the GC can collect an asynchronously queued
                # Action before WebView2 receives the envelope.
                with self._lock:
                    if action in self._pending_actions:
                        self._pending_actions.remove(action)

        try:
            from System import Action  # type: ignore[import-not-found]
            # Always enqueue, including when called from a WebView2 callback.
            # Re-entering the control synchronously from NavigationCompleted or
            # WebMessageReceived can deadlock native COM callbacks.
            action = Action(send)
            with self._lock:
                self._pending_actions.append(action)
            form.BeginInvoke(action)
        except Exception as exc:
            with self._lock:
                if "action" in locals() and action in self._pending_actions:
                    self._pending_actions.remove(action)
            raise FrameClosedError("Auvra frame UI thread is unavailable") from exc

    def _create_sta_thread(self) -> Any:
        if os.name != "nt":
            self._fail("runtime_unavailable", "Auvra WebView2 frame is available on Windows only")
            raise FrameStartupError("Auvra WebView2 frame is available on Windows only")
        try:
            import clr  # type: ignore[import-not-found]
            from System.Threading import ApartmentState, Thread, ThreadStart  # type: ignore[import-not-found]
            thread = Thread(ThreadStart(self._run_native))
            # SetApartmentState must happen before Start. WinForms requires an
            # STA and .NET rejects changing apartment state after Start.
            thread.SetApartmentState(ApartmentState.STA)
            thread.IsBackground = False
            return thread
        except (ImportError, OSError, RuntimeError) as exc:
            self._fail("runtime_unavailable", "Python.NET is required for the Auvra desktop frame")
            raise FrameStartupError("Python.NET is required for the Auvra desktop frame") from exc

    def _on_native_thread(self) -> bool:
        thread = self._thread
        return bool(thread is not None and getattr(thread, "ManagedThreadId", -1) == self._managed_thread_id())

    @staticmethod
    def _managed_thread_id() -> int:
        try:
            from System.Threading import Thread  # type: ignore[import-not-found]
            return int(Thread.CurrentThread.ManagedThreadId)
        except ImportError:
            return -1

    def _close_on_ui_thread(self) -> None:
        try:
            if self._form is not None:
                self._form.Close()
        finally:
            self._closed.set()

    def _run_native(self) -> None:
        try:
            self._load_and_run()
        except FrameUnavailableError as exc:
            self._fail("runtime_unavailable", str(exc))
        except Exception:
            # Deliberately do not include native exception text: it may contain
            # URLs, profile paths, message bodies, or environment secrets.
            self._fail("native_startup_failed", "Auvra desktop frame failed to start")
        finally:
            self._dispose_native()
            with self._lock:
                self._form = None
                self._control = None
                self._core = None
                self._environment = None
                if self._state is not FrameState.FAILED:
                    self._state = FrameState.CLOSED
            self._closed.set()
            self._signal("closed")

    def _load_and_run(self) -> None:
        if os.name != "nt":
            raise FrameUnavailableError("Auvra WebView2 frame is available on Windows only")
        if struct.calcsize("P") != 8:
            raise FrameUnavailableError("Auvra WebView2 frame requires a 64-bit Python process")
        if self._sdk is None:
            if self._sdk_cache is None:
                raise FrameUnavailableError("a verified WebView2 SDK cache directory is required")
            self._sdk = self._sdk_acquirer(self._sdk_cache)
        if not all(path.is_file() for path in (self._sdk.core_assembly, self._sdk.winforms_assembly, self._sdk.loader)):
            raise FrameUnavailableError("the verified WebView2 SDK assemblies are missing")
        if self.config.user_data_folder is None:
            raise FrameUnavailableError("an explicit private WebView2 user-data folder is required")
        try:
            import clr  # type: ignore[import-not-found]
            try:
                # P/Invoke does not reliably search a managed assembly's
                # directory when hosted by Python.NET.  Scope the official
                # loader directory to this frame lifetime instead of mutating
                # the process-wide PATH.
                self._dll_directory_handle = os.add_dll_directory(str(self._sdk.root))
            except (AttributeError, OSError) as exc:
                raise FrameUnavailableError("the WebView2 native loader directory could not be secured") from exc
            clr.AddReference(str(self._sdk.core_assembly))
            clr.AddReference(str(self._sdk.winforms_assembly))
            from System import Action  # type: ignore[import-not-found]
            from System.Windows.Forms import Application, DockStyle, Form  # type: ignore[import-not-found]
            from Microsoft.Web.WebView2.Core import CoreWebView2Environment  # type: ignore[import-not-found]
            from Microsoft.Web.WebView2.WinForms import (  # type: ignore[import-not-found]
                CoreWebView2CreationProperties,
                WebView2,
            )
        except ImportError as exc:
            raise FrameUnavailableError("Python.NET and the WebView2 WinForms SDK are required on Windows") from exc
        browser_folder = self.config.browser_executable_folder
        try:
            runtime_version = str(
                CoreWebView2Environment.GetAvailableBrowserVersionString(str(browser_folder))
                if browser_folder is not None
                else CoreWebView2Environment.GetAvailableBrowserVersionString()
            )
            if not runtime_version:
                raise RuntimeError("empty runtime version")
        except Exception as exc:
            runtime_kind = "fixed" if browser_folder is not None else "Evergreen"
            raise FrameUnavailableError(f"the {runtime_kind} WebView2 Runtime cannot be loaded") from exc

        profile = self.config.user_data_folder
        profile.mkdir(parents=True, exist_ok=True)
        creation = CoreWebView2CreationProperties()
        creation.BrowserExecutableFolder = str(browser_folder) if browser_folder is not None else None
        creation.UserDataFolder = str(profile)

        form = Form()
        form.Text = self.config.title
        form.Width, form.Height = 1280, 800
        # Showing a WinForms form before Application.Run enters the STA
        # message loop can prevent WebView2's async initialization callback
        # from being delivered under Python.NET.  Start hidden, then show it
        # from the UI-thread Load callback once the environment is scheduled.
        form.Visible = False
        form.FormClosed += lambda sender, args: self._closed.set()
        control = WebView2()
        # CreationProperties lets the WinForms wrapper create its environment
        # as part of implicit initialization.  Do not synchronously wait on a
        # WebView2 task from this STA: WebView2 needs this message pump to
        # deliver initialization and shutdown callbacks.
        control.CreationProperties = creation
        control.Dock = DockStyle.Fill
        form.Controls.Add(control)
        self._form, self._control = form, control

        def initialized(sender: Any, args: Any) -> None:
            success = bool(getattr(args, "IsSuccess", True))
            self._signal("initialization_completed", {"success": success})
            if not success:
                exception = getattr(args, "InitializationException", None)
                exception_type = type(exception).__name__ if exception is not None else "unknown"
                hresult = getattr(exception, "HResult", None)
                inner = getattr(exception, "InnerException", None)
                inner_type = type(inner).__name__ if inner is not None else "none"
                self._fail("webview2_initialization_failed", "WebView2 Runtime initialization failed")
                self._signal("initialization_failed", {"exception_type": exception_type, "inner_type": inner_type, "hresult": int(hresult) if hresult is not None else None})
                form.Close()
                return
            try:
                core = control.CoreWebView2
                environment = getattr(core, "Environment", None)
                if environment is None:
                    raise RuntimeError("WebView2 environment is unavailable")
                self._environment = environment
                self._configure_core(core)
            except Exception as exc:
                self._fail("native_configuration_failed", "WebView2 frame policy configuration failed")
                self._signal("configuration_failed", {"exception_type": type(exc).__name__})
                form.Close()

        control.CoreWebView2InitializationCompleted += initialized

        def shown(sender: Any, args: Any) -> None:
            try:
                # InitializationCompleted is the completion boundary.  The
                # returned task is deliberately not waited synchronously.
                control.EnsureCoreWebView2Async()
                if self.config.visible:
                    form.Show()
            except Exception:
                self._fail("environment_failed", "WebView2 environment creation failed")
                form.Close()

        form.Load += shown
        Application.Run(form)

    def _dispose_native(self) -> None:
        # Dispose controls on the STA before releasing references. This is
        # required for WebView2 to release its profile lock and browser child.
        if self._control is not None:
            try:
                controller = getattr(self._control, "CoreWebView2Controller", None)
                if controller is not None:
                    controller.Close()
            except Exception:
                pass
        for native in (self._control, self._form, self._environment):
            if native is not None:
                try:
                    native.Dispose()
                except Exception:
                    pass
        handle = self._dll_directory_handle
        self._dll_directory_handle = None
        if handle is not None:
            try:
                handle.close()
            except (OSError, AttributeError):
                pass
        with self._lock:
            self._pending_actions.clear()

    def _configure_core(self, core: Any) -> None:
        self._core = core
        try:
            self._browser_process_id = int(core.BrowserProcessId)
        except Exception:
            self._browser_process_id = None
        core.NavigationStarting += self._on_navigation
        core.FrameNavigationStarting += self._on_frame_navigation
        core.NewWindowRequested += self._on_new_window
        core.DownloadStarting += self._on_download
        core.PermissionRequested += self._on_permission
        core.WebResourceRequested += self._on_resource
        core.WebMessageReceived += self._on_message
        core.NavigationCompleted += self._on_navigation_completed
        core.ProcessFailed += self._on_process_failed
        # BrowserProcessExited belongs to CoreWebView2Environment, not the
        # CoreWebView2 document object in the official SDK.
        if self._environment is None:
            raise RuntimeError("WebView2 environment is unavailable")
        self._environment.BrowserProcessExited += self._on_browser_exited
        if self.config.mode is FrameMode.PACKAGED:
            core.Settings.AreDevToolsEnabled = False
            core.Settings.AreDefaultContextMenusEnabled = False
            core.Settings.AreBrowserAcceleratorKeysEnabled = False
            core.Settings.IsStatusBarEnabled = False
        from Microsoft.Web.WebView2.Core import CoreWebView2WebResourceContext  # type: ignore[import-not-found]
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All)
        if self.config.mode is FrameMode.PACKAGED:
            from Microsoft.Web.WebView2.Core import CoreWebView2HostResourceAccessKind  # type: ignore[import-not-found]
            core.SetVirtualHostNameToFolderMapping("app.auvra.local", str(self.config.packaged_root), CoreWebView2HostResourceAccessKind.DenyCors)
            initial = self.config.trusted_origin + "/index.html"
        else:
            initial = self.config.trusted_origin + "/"
        core.Navigate(initial)

    @staticmethod
    def _value(args: Any, name: str, default: Any = None) -> Any:
        return getattr(args, name, default)

    @staticmethod
    def _cancel(args: Any, value: bool = True) -> None:
        if hasattr(args, "Cancel"):
            args.Cancel = value

    def _on_navigation(self, sender: Any, args: Any) -> None:
        if not self.policy.navigation(str(self._value(args, "Uri", ""))).allowed:
            self._cancel(args)

    def _on_navigation_completed(self, sender: Any, args: Any) -> None:
        success = bool(self._value(args, "IsSuccess", False))
        if not success:
            with self._lock:
                initial = self._state is FrameState.STARTING
            self._signal("navigation_failed", {"code": "navigation_failed"})
            if initial:
                self._fail("navigation_failed", "Auvra editor navigation failed")
                if self._form is not None:
                    self._form.Close()
            return
        with self._lock:
            initial = self._state is FrameState.STARTING
            if initial:
                self._state = FrameState.READY
        if initial:
            self._ready.set()
            self._signal("ready", {"origin": self.config.trusted_origin})
        self._signal("navigation_completed", {"success": True})

    def _on_frame_navigation(self, sender: Any, args: Any) -> None:
        if not self.policy.frame_navigation(str(self._value(args, "Uri", ""))).allowed:
            self._cancel(args)

    def _on_new_window(self, sender: Any, args: Any) -> None:
        if hasattr(args, "Handled"):
            args.Handled = True
        if hasattr(args, "Cancel"):
            args.Cancel = True

    def _on_download(self, sender: Any, args: Any) -> None:
        if hasattr(args, "Cancel"):
            args.Cancel = True

    def _on_permission(self, sender: Any, args: Any) -> None:
        if hasattr(args, "State"):
            try:
                from Microsoft.Web.WebView2.Core import CoreWebView2PermissionState  # type: ignore[import-not-found]
                args.State = CoreWebView2PermissionState.Deny
            except ImportError:
                args.State = 2

    def _on_resource(self, sender: Any, args: Any) -> None:
        request = self._value(args, "Request")
        uri = str(self._value(request, "Uri", ""))
        if is_asset_resource_url(uri):
            self._on_asset_resource(args, request, uri)
            return
        if not self.policy.resource(str(uri)).allowed:
            self._deny_resource(args)

    @staticmethod
    def _request_headers(request: Any) -> dict[str, str]:
        source = getattr(request, "Headers", None)
        result: dict[str, str] = {}
        for name in (
            "Origin",
            "Content-Type",
            "Content-Length",
            "Access-Control-Request-Method",
        ):
            try:
                value = source.GetHeader(name) if source is not None else ""
            except Exception:
                value = ""
            if value:
                result[name] = str(value)
        return result

    class _NativeBodyReader:
        def __init__(self, stream: Any) -> None:
            self.stream = stream

        def read(self, size: int) -> bytes:
            if self.stream is None:
                return b""
            reader = getattr(self.stream, "read", None)
            if callable(reader):
                return bytes(reader(size))
            from System import Array, Byte  # type: ignore[import-not-found]

            buffer = Array.CreateInstance(Byte, size)
            count = int(self.stream.Read(buffer, 0, size))
            if count <= 0:
                return b""
            return bytes(buffer[index] for index in range(count))

    def _on_asset_resource(self, args: Any, request: Any, uri: str) -> None:
        callback = self.config.on_asset_resource
        if callback is None:
            self._deny_resource(args)
            return
        method = str(self._value(request, "Method", "GET")).upper()
        body = self._value(request, "Content")
        resource_request = AssetResourceRequest(
            method,
            uri,
            self._request_headers(request),
            self._NativeBodyReader(body) if body is not None else None,
        )
        get_deferral = getattr(args, "GetDeferral", None)
        if callable(get_deferral):
            try:
                deferral = get_deferral()
            except Exception:
                self._deny_resource(args)
                return
            if not self._resource_slots.acquire(blocking=False):
                response = AssetResourceResponse(503, "Busy", {"Cache-Control": "no-store"})
                self._complete_deferred_resource(args, deferral, response)
                return
            try:
                future = self._resource_executor.submit(self._handle_asset_resource, callback, resource_request)
            except RuntimeError:
                self._resource_slots.release()
                self._complete_deferred_resource(
                    args, deferral, AssetResourceResponse(503, "Closed", {"Cache-Control": "no-store"}),
                )
                return
            future.add_done_callback(lambda completed: self._asset_resource_finished(args, deferral, completed))
            return
        # Pure-Python adapters without WebView2 deferrals retain a synchronous
        # bounded path for unit tests only.
        response = self._handle_asset_resource(callback, resource_request)
        self._set_resource_response(args, response)

    @staticmethod
    def _handle_asset_resource(callback: Callable[[AssetResourceRequest], Any], resource_request: AssetResourceRequest) -> AssetResourceResponse:
        try:
            response = callback(resource_request)
            if not isinstance(response, AssetResourceResponse):
                raise TypeError("asset resource callback returned an invalid response")
        except AssetTransportError as exc:
            response = AssetResourceResponse(exc.status, "Denied", {"Cache-Control": "no-store"})
        except Exception:
            response = AssetResourceResponse(500, "Denied", {"Cache-Control": "no-store"})
        return response

    def _asset_resource_finished(self, args: Any, deferral: Any, future: Future[AssetResourceResponse]) -> None:
        self._resource_slots.release()
        try:
            response = future.result()
        except Exception:
            response = AssetResourceResponse(500, "Denied", {"Cache-Control": "no-store"})
        self._complete_deferred_resource(args, deferral, response)

    def _complete_deferred_resource(self, args: Any, deferral: Any, response: AssetResourceResponse) -> None:
        with self._lock:
            form = self._form
            state = self._state

        def complete() -> None:
            try:
                self._set_resource_response(args, response)
            finally:
                try:
                    deferral.Complete()
                finally:
                    with self._lock:
                        if action in self._pending_actions:
                            self._pending_actions.remove(action)

        if form is None:
            try:
                if state in {FrameState.CLOSING, FrameState.CLOSED, FrameState.FAILED}:
                    self._close_resource_body(response)
                else:
                    self._set_resource_response(args, response)
            finally:
                deferral.Complete()
            return
        try:
            from System import Action  # type: ignore[import-not-found]
            action = Action(complete)
            with self._lock:
                self._pending_actions.append(action)
            form.BeginInvoke(action)
        except Exception:
            with self._lock:
                if "action" in locals() and action in self._pending_actions:
                    self._pending_actions.remove(action)
            self._close_resource_body(response)
            try:
                deferral.Complete()
            except Exception:
                pass

    @staticmethod
    def _close_resource_body(response: AssetResourceResponse) -> None:
        if response.body is not None:
            try:
                response.body.close()
            except Exception:
                pass

    def _set_resource_response(self, args: Any, response: AssetResourceResponse) -> None:
        # Pure-Python fakes accept the bounded response directly. Native
        # WebView2 receives a .NET stream without materializing file contents.
        environment = getattr(self._core, "Environment", None)
        if environment is None:
            if hasattr(args, "Response"):
                args.Response = response
                return
            self._deny_resource(args)
            return
        native_stream = None
        try:
            if response.body is None:
                from System.IO import MemoryStream  # type: ignore[import-not-found]

                native_stream = MemoryStream()
            else:
                name = getattr(response.body, "name", None)
                if not isinstance(name, (str, os.PathLike)):
                    raise TypeError("asset response stream is not file-backed")
                response.body.close()
                from System.IO import FileAccess, FileMode, FileShare, FileStream  # type: ignore[import-not-found]

                native_stream = FileStream(str(name), FileMode.Open, FileAccess.Read, FileShare.Read)
            headers = "".join(f"{name}: {value}\r\n" for name, value in response.headers.items())
            args.Response = environment.CreateWebResourceResponse(
                native_stream,
                int(response.status),
                str(response.reason),
                headers,
            )
        except Exception:
            if native_stream is not None:
                try:
                    native_stream.Dispose()
                except Exception:
                    pass
            self._fail("asset_resource_failed", "Auvra could not serve a secured asset resource")

    def _deny_resource(self, args: Any) -> None:
        # Test fakes expose Cancel. WebView2's real resource event is blocked
        # by installing a synthetic 403 response, since its args have no
        # Cancel property.
        if hasattr(args, "Cancel"):
            self._cancel(args)
            return
        try:
            from System.IO import MemoryStream  # type: ignore[import-not-found]
            body = MemoryStream()
            environment = getattr(self._core, "Environment", None)
            if environment is None:
                raise RuntimeError("WebView2 environment is unavailable")
            args.Response = environment.CreateWebResourceResponse(body, 403, "Forbidden", "Content-Type: text/plain\r\n")
        except Exception:
            # If a native deny response cannot be created, fail closed by
            # stopping the frame instead of allowing an unapproved request.
            self._fail("resource_policy_failed", "Auvra could not enforce its resource policy")

    def _on_message(self, sender: Any, args: Any) -> None:
        source = str(self._value(args, "Source", ""))
        if not self.policy.allow_message(source):
            return
        try:
            body = str(self._value(args, "WebMessageAsJson", ""))
            if len(body.encode("utf-8", "replace")) > MESSAGE_MAX_BYTES:
                return
            parsed = json.loads(body)
            validate_message(parsed)
        except (TypeError, ValueError, json.JSONDecodeError, ProtocolValidationError):
            return
        callback = self.config.on_message
        if callback is not None:
            try:
                callback(body, source)
            except Exception:
                # The protocol dispatcher is injected by the host. Its
                # failures must not cross the native event boundary or expose
                # the message body through a native traceback.
                self._signal("message_failed", {"code": "dispatcher_failed"})

    def _on_process_failed(self, sender: Any, args: Any) -> None:
        self._fail("renderer_process_failed", "The Auvra renderer process failed")
        self.close(timeout=self.config.shutdown_timeout)

    def _terminate_owned_browser(self) -> None:
        """Contain a browser tree that ignored controller disposal."""
        pid = self._browser_process_id
        if os.name != "nt" or pid is None or pid <= 0 or pid == os.getpid():
            return
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2.0,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.SubprocessError):
            # The caller reports a profile cleanup failure if locks remain.
            return

    def _on_browser_exited(self, sender: Any, args: Any) -> None:
        """Handle unexpected browser termination without false close errors."""
        self._browser_exited.set()
        with self._lock:
            unexpected = self._state not in {FrameState.CLOSING, FrameState.CLOSED}
        if not unexpected:
            return
        self._fail("browser_process_exited", "The Auvra browser process exited unexpectedly")
        self.close(timeout=self.config.shutdown_timeout)
