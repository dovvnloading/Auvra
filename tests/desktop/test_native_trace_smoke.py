from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest

from Auvra.desktop.native_engine import NativeEngine, NativeEngineResponseError
from Auvra.diagnostics.core import DiagnosticsSession, install_diagnostics


@unittest.skipUnless(os.environ.get("AUVRA_NATIVE_TRACE_SMOKE") == "1",
                     "set AUVRA_NATIVE_TRACE_SMOKE=1 after building the native release binary")
@unittest.skipUnless(os.name == "nt", "native trace smoke is Windows-only")
class NativeTraceSmokeTests(unittest.TestCase):
    def test_real_native_child_emits_correlated_operation_records(self) -> None:
        repository = Path(__file__).parents[2]
        binary = repository / "native" / "target" / "release" / "auvra-native.exe"
        self.assertTrue(binary.is_file(), "build the native release binary first")
        with tempfile.TemporaryDirectory(prefix="auvra native trace smoke ") as raw:
            session = DiagnosticsSession(
                Path(raw) / "diagnostics",
                source_root=repository,
                run_id="run-native-trace-smoke",
                mode="test",
            )
            session.start()
            session.start_detailed_capture()
            install_diagnostics(session)
            engine = NativeEngine([str(binary)], startup_timeout=5, request_timeout=5,
                                  shutdown_timeout=2)
            try:
                engine.start(editor_session="trace-smoke")
                engine.snapshot_world()
                # Exercise representative quiet and phased dispatch paths so
                # this smoke proves runtime trace behavior beyond one
                # snapshot call.  Detailed capture records quiet operations.
                engine.call("world.getReplay")
                engine.call("renderer.getCapabilities")
                viewport_opened = True
                try:
                    engine.open_viewport(width=320, height=240, title="Auvra trace smoke")
                except NativeEngineResponseError as error:
                    if error.code != "unsupported_capability":
                        raise
                    # Windows CI can run in an occluded desktop session where
                    # the swapchain is unavailable even though offscreen
                    # rendering and native diagnostics remain healthy.
                    viewport_opened = False
                engine.render_reference(width=32, height=32)
                engine.call("renderer.extract")
                engine.reference_metrics()
                engine.recover()
                engine.close_viewport()
                engine.call("world.closeProject")
            finally:
                engine.close(timeout=2)
                session.close(outcome="success")
                install_diagnostics(None)
            operation_records = [
                record for record in session.snapshot()
                if str(record.get("attributes", {}).get("state", "")).startswith("native.operation_")
            ]
            self.assertTrue(any(
                record["attributes"]["state"] == "native.operation_started"
                for record in operation_records
            ))
            self.assertTrue(any(
                record["attributes"]["state"] == "native.operation_completed"
                and record["attributes"].get("method") == "world.getSnapshot"
                and record.get("traceId")
                and record.get("spanId")
                for record in operation_records
            ))
            completed_methods = {
                record["attributes"].get("method")
                for record in operation_records
                if record["attributes"]["state"] == "native.operation_completed"
            }
            required_methods = {
                "world.getReplay", "renderer.getCapabilities",
                "renderer.renderReference", "renderer.extract", "renderer.getMetrics",
                "renderer.recover", "viewport.close", "world.closeProject",
            }
            if viewport_opened:
                required_methods.add("viewport.open")
            self.assertTrue(required_methods <= completed_methods, completed_methods)
            if not viewport_opened:
                self.assertTrue(any(
                    record["attributes"]["state"] == "native.operation_failed"
                    and record["attributes"].get("method") == "viewport.open"
                    for record in operation_records
                ), operation_records)


if __name__ == "__main__":
    unittest.main()
