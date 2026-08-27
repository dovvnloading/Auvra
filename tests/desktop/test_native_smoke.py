"""Opt-in, real Windows WebView2 smoke coverage for the Stage 2 frame.

The suite is deliberately skipped during normal unit-test discovery.  Set
``AUVRA_NATIVE_SMOKE=1`` to run it.  It starts only the exact repository Vite
process and uses a private temporary WebView2 profile; no process-name based
cleanup or external browser automation is used.
"""

from __future__ import annotations

import http.server
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from typing import Any, Callable

from Auvra.desktop.contracts import FrameConfig, FrameMode, FrameState
from Auvra.desktop.controller import FrameController, _new_profile
from Auvra.desktop import contracts as desktop_contracts
from Auvra.desktop.assets import AssetTransferRegistry
from Auvra.desktop.dialogs import DialogSelection
from Auvra.desktop.project_host import NativeProjectHost
from Auvra.desktop.sdk import acquire_sdk
from Auvra.desktop.webview2 import WebView2Frame
from Auvra.launcher.cli import choose_port
from Auvra.launcher.config import FRONTEND_ROOT
from Auvra.launcher.process import OwnedProcess
from Auvra.launcher.readiness import wait_for_readiness


_SMOKE_ENABLED = os.environ.get("AUVRA_NATIVE_SMOKE") == "1"
_STARTUP_TIMEOUT = 45.0
_SHUTDOWN_TIMEOUT = 12.0
_POLL = 0.1


class _TrapHandler(http.server.BaseHTTPRequestHandler):
    hits: list[str] = []

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        type(self).hits.append(self.path)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"trap")

    def log_message(self, *_args: object) -> None:
        return


class _TrapServer:
    def __init__(self) -> None:
        _TrapHandler.hits = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _TrapHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, name="auvra-native-smoke-trap", daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    @property
    def hits(self) -> list[str]:
        return list(_TrapHandler.hits)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)


class _PackagedOwner:
    """Minimal owner for a packaged frame, which has no Vite child."""

    def __init__(self) -> None:
        self.stopped = False

    def is_alive(self) -> bool:
        return not self.stopped

    def terminate(self) -> None:
        self.stopped = True


class _SmokeProjectDialogs:
    """Deterministic dialog seam for the opt-in native project lifecycle."""

    def __init__(self, parent: Path) -> None:
        self.project_path = parent / "Native Smoke Project"

    def choose_create_location(self, _suggested_name: str) -> DialogSelection:
        return DialogSelection(self.project_path)

    def choose_open_project(self) -> DialogSelection:
        return DialogSelection(self.project_path / "Native Smoke Project.auvra")

    def choose_save_as_location(self, _suggested_name: str) -> DialogSelection:
        return DialogSelection(self.parent / "Native Smoke Project Copy")

    def choose_export_pack(self, _suggested_name: str) -> DialogSelection:
        return DialogSelection(self.parent / "Native Smoke Project.auvrapack")

    def choose_import_pack(self) -> DialogSelection:
        return DialogSelection(self.parent / "Native Smoke Project.auvrapack")

    def choose_import_legacy(self) -> DialogSelection:
        return DialogSelection(self.parent / "legacy.forge")

    @property
    def parent(self) -> Path:
        return self.project_path.parent


def _wait_until(predicate: Callable[[], bool], timeout: float, label: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(_POLL)
    raise AssertionError(f"timed out waiting for {label}")


def _script_for_requests(prefix: str, trap_port: int | None = None) -> str:
    trap = ""
    if trap_port is not None:
        trap = f"""
        const blocked = new Image();
        blocked.src = "http://127.0.0.1:{trap_port}/must-not-reach";
        window.open("http://127.0.0.1:{trap_port}/popup-must-not-open", "auvra-smoke-popup");
        """
    return f"""
    (() => {{
      const state = {{ session: null, requested: new Set() }};
      window.__auvraNativeSmoke = state;
      const send = (id, session, revision) => {{
        if (state.requested.has(id)) return;
        state.requested.add(id);
        chrome.webview.postMessage({{
          protocol: "auvra.host/1", type: "request", id,
          session, revision, method: "host.ping", payload: {{}}
        }});
      }};
      chrome.webview.addEventListener("message", event => {{
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "session" && !state.session) {{
          state.session = message.session;
          send("{prefix}-ping", message.session, message.revision);
        }}
        if (message.type === "response" && message.id === "{prefix}-ping" && message.ok) {{
          send("{prefix}-ack", message.session, message.revision);
        }}
      }});
      {trap}
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const dataImage = new Image();
      dataImage.onload = () => send("{prefix}-data", state.session, 0);
      dataImage.onerror = () => send("{prefix}-data-error", state.session, 0);
      dataImage.src = "data:image/png;base64," + png;
      const blobImage = new Image();
      blobImage.onload = () => send("{prefix}-blob", state.session, 0);
      blobImage.onerror = () => send("{prefix}-blob-error", state.session, 0);
      blobImage.src = URL.createObjectURL(
        new Blob([Uint8Array.from(atob(png), character => character.charCodeAt(0))], {{type: "image/png"}})
      );
    }})();
    """


def _script_for_project_lifecycle(prefix: str) -> str:
    """Exercise the native project service through WebView2's real bridge."""

    return f"""
    (() => {{
      const state = {{ session: null, revision: 0, projectId: null, sent: new Set() }};
      window.__auvraNativeProjectSmoke = state;
      const request = (id, method, payload) => {{
        if (state.sent.has(id)) return;
        state.sent.add(id);
        chrome.webview.postMessage({{
          protocol: "auvra.host/1", type: "request", id,
          session: state.session, revision: state.revision, method, payload
        }});
      }};
      chrome.webview.addEventListener("message", event => {{
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "session" && !state.session) {{
          state.session = message.session;
          state.revision = message.revision;
          request("{prefix}-create", "project.create", {{ name: "Native Smoke Project" }});
          return;
        }}
        if (message.type !== "response" || !message.id) return;
        state.revision = message.revision;
        if (!message.ok) return;
        const result = message.result || {{}};
        if (message.id === "{prefix}-create") {{
          state.projectId = result.projectId;
          request("{prefix}-apply", "project.applyChanges", {{
            projectId: state.projectId, expectedRevision: result.revision,
            changes: [{{ domain: "metadata", documentId: "project", operation: "upsert",
              document: {{ id: "project", name: "Native Smoke Project" }} }}]
          }});
        }} else if (message.id === "{prefix}-apply") {{
          request("{prefix}-snapshot", "project.getSnapshot", {{
            projectId: state.projectId, domain: "metadata", pageSize: 10
          }});
        }} else if (message.id === "{prefix}-snapshot") {{
          request("{prefix}-save", "project.save", {{
            projectId: state.projectId, expectedRevision: result.revision
          }});
        }} else if (message.id === "{prefix}-save") {{
          request("{prefix}-close", "project.close", {{
            projectId: state.projectId, expectedRevision: result.revision
          }});
        }}
      }});
    }})();
    """


@unittest.skipUnless(_SMOKE_ENABLED, "set AUVRA_NATIVE_SMOKE=1 for real WebView2 smoke")
@unittest.skipUnless(os.name == "nt", "real WebView2 smoke is Windows-only")
class NativeWebView2SmokeTests(unittest.TestCase):
    """Run the complete hidden native frame path against the installed runtime."""

    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("npm.cmd") is None and shutil.which("npm") is None:
            raise AssertionError("npm is required for the enabled native smoke")
        if not (FRONTEND_ROOT / "node_modules").is_dir():
            raise AssertionError("frontend node_modules is required; run the launcher prepare step")
        cls.sdk = acquire_sdk(FRONTEND_ROOT / ".auvra-launcher" / "webview2-sdk")
        cls.trap = _TrapServer()

    @classmethod
    def tearDownClass(cls) -> None:
        trap = getattr(cls, "trap", None)
        if trap is not None:
            trap.close()

    def _ui(self, frame: WebView2Frame, callback: Callable[[Any], None]) -> None:
        """Run one short callback on the frame's STA without arbitrary eval."""
        from System import Action  # type: ignore[import-not-found]

        done = threading.Event()
        errors: list[BaseException] = []

        def invoke() -> None:
            try:
                callback(frame._core)
            except BaseException as exc:  # propagate test failures on caller
                errors.append(exc)
            finally:
                done.set()

        action = Action(invoke)
        with frame._lock:
            frame._pending_actions.append(action)
        frame._form.BeginInvoke(action)
        if not done.wait(5.0):
            self.fail("timed out waiting for native UI callback")
        if errors:
            raise errors[0]

    def _execute_script(self, frame: WebView2Frame, script: str) -> None:
        # ExecuteScriptAsync is invoked only by this opt-in test, on the native
        # STA.  It is not a production bridge or an exposed application API.
        self._ui(frame, lambda core: core.ExecuteScriptAsync(script))

    def _bind_project_host(self, controller: FrameController, root: Path, origin: str) -> Path:
        """Install the production adapter with deterministic, private dialogs."""

        dialogs = _SmokeProjectDialogs(root / "projects")
        registry = AssetTransferRegistry(
            root / "asset-transfers",
            session_id=controller.dispatcher.session.session_id,
            trusted_origin=origin,
        )
        host = NativeProjectHost(root / "project-state", asset_registry=registry, dialogs=dialogs)
        controller.asset_registry = registry
        controller.project_host = host
        controller.dispatcher.bind_services(project_service=host, asset_service=host)
        return dialogs.project_path

    def _project_lifecycle(self, controller: FrameController, prefix: str, seen: list[dict[str, Any]], project_path: Path) -> None:
        self._execute_script(controller.frame, _script_for_project_lifecycle(prefix))
        # ExecuteScriptAsync queues work on the document thread; wait until
        # the listener is installed before sending the synthetic navigation
        # boundary below.
        time.sleep(0.25)
        # The native script API is asynchronous; a short repeated boundary
        # keeps this opt-in smoke deterministic across runner load variance.
        for _ in range(4):
            controller.on_lifecycle("navigation_completed", {"success": True})
            time.sleep(0.2)
        expected = {
            f"{prefix}-create", f"{prefix}-apply", f"{prefix}-snapshot",
            f"{prefix}-save", f"{prefix}-close",
        }
        _wait_until(
            lambda: expected.issubset({item.get("id") for item in seen}),
            20.0,
            "native project lifecycle",
        )
        responses = {item["id"]: item for item in seen if item.get("id") in expected}
        self.assertTrue(all(item.get("ok") is True for item in responses.values()), responses)
        self.assertTrue((project_path / "Native Smoke Project.auvra").is_file())
        self.assertTrue((project_path / "Project" / "metadata.json").is_file())
        self.assertFalse(any(str(project_path) in json.dumps(item) for item in responses.values()))

    def _make_controller(
        self,
        mode: FrameMode,
        profile_parent: Path,
        *,
        origin: str = "",
        packaged_root: Path | None = None,
        process: Any,
        seen: list[dict[str, Any]],
        lifecycle: list[str],
    ) -> FrameController:
        holder: dict[str, FrameController] = {}

        def on_message(body: str, source: str) -> None:
            seen.append(json.loads(body))
            holder["controller"].on_message(body, source)

        def on_lifecycle(event: str, fields: dict[str, Any] | None = None) -> None:
            lifecycle.append(event)
            if "controller" in holder:
                holder["controller"].on_lifecycle(event, fields)

        # The production profile lease intentionally accepts only the launcher
        # state or an explicitly registered disposable test parent.
        registered_parent = profile_parent.expanduser().absolute().resolve(strict=False)
        desktop_contracts._CONTROLLED_TEST_PROFILE_PARENTS.add(registered_parent)
        try:
            lease = _new_profile(profile_parent)
            config = FrameConfig(
                mode,
                development_origin=origin,
                packaged_root=packaged_root,
                user_data_folder=lease.path,
                on_message=on_message,
                on_lifecycle=on_lifecycle,
                startup_timeout=_STARTUP_TIMEOUT,
                shutdown_timeout=_SHUTDOWN_TIMEOUT,
                visible=False,
            )
        except BaseException:
            desktop_contracts._CONTROLLED_TEST_PROFILE_PARENTS.discard(registered_parent)
            raise
        frame = WebView2Frame(config, sdk=self.sdk)
        controller = FrameController(
            process, frame=frame, profile_path=lease.path, profile_lease=lease, poll_interval=_POLL
        )
        # Capture both directions of the real bridge.  WebView2 delivers
        # incoming requests to ``on_message`` directly, while responses leave
        # through ``post_message`` and are otherwise invisible to the test.
        post_message = frame.post_message

        def capture_post(message: str | dict[str, Any]) -> None:
            seen.append(json.loads(message) if isinstance(message, str) else message)
            post_message(message)

        frame.post_message = capture_post  # type: ignore[method-assign]
        holder["controller"] = controller
        return controller

    def _handshake(self, controller: FrameController, prefix: str, seen: list[dict[str, Any]], *, trap: bool = False) -> None:
        frame = controller.frame
        self._execute_script(frame, _script_for_requests(prefix, self.trap.port if trap else None))
        # NavigationCompleted normally sends this already. Re-send after the
        # listener is installed so the test proves delivery, not timing luck.
        controller.on_lifecycle("navigation_completed", {"success": True})
        expected = {f"{prefix}-ping", f"{prefix}-ack", f"{prefix}-data", f"{prefix}-blob"}
        _wait_until(lambda: expected.issubset({item.get("id") for item in seen}), 12.0, f"{prefix} native protocol roundtrip")
        self.assertNotIn(f"{prefix}-data-error", {item.get("id") for item in seen})
        self.assertNotIn(f"{prefix}-blob-error", {item.get("id") for item in seen})

    def _source(self, frame: WebView2Frame) -> str:
        value: list[str] = []
        self._ui(frame, lambda core: value.append(str(core.Source)))
        return value[0]

    def test_real_dev_reload_policy_resources_and_packaged_virtual_https(self) -> None:
        npm = shutil.which("npm.cmd") or shutil.which("npm")
        port = choose_port(None)
        vite = OwnedProcess.launch(
            [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", str(port)],
            FRONTEND_ROOT,
        )
        dev_profile_parent = Path(tempfile.mkdtemp(prefix="auvra-native-smoke-"))
        dev_seen: list[dict[str, Any]] = []
        dev_lifecycle: list[str] = []
        dev: FrameController | None = None
        try:
            ready = wait_for_readiness("127.0.0.1", port, vite.is_alive, timeout=30.0, interval=0.15)
            self.assertTrue(ready.ready, ready.detail)
            dev = self._make_controller(
                FrameMode.DEVELOPMENT, dev_profile_parent, origin=f"http://127.0.0.1:{port}",
                process=vite, seen=dev_seen, lifecycle=dev_lifecycle,
            )
            project_path = self._bind_project_host(dev, dev_profile_parent, f"http://127.0.0.1:{port}")
            dev.start()
            self.assertEqual(dev.frame.state, FrameState.READY)
            self.assertTrue(self._source(dev.frame).startswith(f"http://127.0.0.1:{port}/"))
            session_id = dev.dispatcher.session.session_id
            self._handshake(dev, "dev-1", dev_seen, trap=True)
            self._project_lifecycle(dev, "project", dev_seen, project_path)

            nav_before = dev_lifecycle.count("navigation_completed")
            self._ui(dev.frame, lambda core: core.Reload())
            _wait_until(lambda: dev_lifecycle.count("navigation_completed") > nav_before, 15.0, "full reload")
            self._handshake(dev, "dev-2", dev_seen)
            self.assertEqual(dev.dispatcher.session.session_id, session_id)
            self.assertEqual(dev.frame.state, FrameState.READY)

            trusted = f"http://127.0.0.1:{port}/"
            self._ui(dev.frame, lambda core: core.Navigate("https://example.com/"))
            time.sleep(0.7)
            self.assertTrue(self._source(dev.frame).startswith(trusted))
            probe = dev_profile_parent / "blocked-file.txt"
            probe.write_text("must not navigate", encoding="utf-8")
            self._ui(dev.frame, lambda core: core.Navigate(probe.as_uri()))
            time.sleep(0.7)
            self.assertTrue(self._source(dev.frame).startswith(trusted))
            self.assertEqual(self.trap.hits, [], "external image/popup reached the trap server")
        finally:
            if dev is not None:
                dev.close()
            if vite.is_alive():
                vite.terminate()
            self.assertFalse(vite.is_alive(), "owned Vite process survived smoke cleanup")
            self.assertFalse(any(dev_profile_parent.glob("webview2-*")), "private development WebView2 profile survived cleanup")
            desktop_contracts._CONTROLLED_TEST_PROFILE_PARENTS.discard(dev_profile_parent.resolve())
            shutil.rmtree(dev_profile_parent, ignore_errors=True)

        packaged_parent = Path(tempfile.mkdtemp(prefix="auvra-native-smoke-packaged-"))
        packaged_seen: list[dict[str, Any]] = []
        packaged_lifecycle: list[str] = []
        packaged: FrameController | None = None
        owner = _PackagedOwner()
        try:
            dist = FRONTEND_ROOT / "dist"
            self.assertTrue((dist / "index.html").is_file(), "run npm run build before packaged smoke")
            packaged = self._make_controller(
                FrameMode.PACKAGED, packaged_parent, packaged_root=dist,
                process=owner, seen=packaged_seen, lifecycle=packaged_lifecycle,
            )
            packaged.start()
            self.assertEqual(packaged.frame.state, FrameState.READY)
            self.assertTrue(self._source(packaged.frame).startswith("https://app.auvra.local/"))
            self._handshake(packaged, "packaged", packaged_seen)
        finally:
            if packaged is not None:
                packaged.close()
            self.assertFalse(owner.is_alive(), "packaged owner was not closed")
            self.assertFalse(any(packaged_parent.glob("webview2-*")), "private packaged WebView2 profile survived cleanup")
            desktop_contracts._CONTROLLED_TEST_PROFILE_PARENTS.discard(packaged_parent.resolve())
            shutil.rmtree(packaged_parent, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
