from __future__ import annotations

import json
from pathlib import Path
import re
import tempfile
import time
import unittest

from Auvra.diagnostics.core import (
    DiagnosticsSession,
    PROFILE_CODE_CACHE_MAX,
    PROFILE_SUMMARY_MAX,
    install_diagnostics,
    traced,
)
from Auvra.project.serialization import canonical_json


REPOSITORY_ROOT = Path(__file__).parents[2]
PYTHON_EXEMPTIONS = {
    "Auvra/Auvra.py": "entrypoint",
    "Auvra/desktop/contracts.py": "data-model",
    "Auvra/desktop/policy.py": "webview-policy-child",
    "Auvra/desktop/sdk.py": "startup-child",
    "Auvra/host/fake.py": "development-host",
    "Auvra/host/validation.py": "host-dispatch-child",
    "Auvra/launcher/bootstrap.py": "startup-child",
    "Auvra/launcher/config.py": "data-model",
    "Auvra/launcher/dependencies.py": "startup-child",
    "Auvra/launcher/platform/posix.py": "startup-child",
    "Auvra/launcher/platform/windows_job.py": "startup-child",
    "Auvra/launcher/process.py": "startup-child",
    "Auvra/launcher/readiness.py": "startup-child",
    "Auvra/plugins/protocol.py": "protocol-model",
    "Auvra/project/archive.py": "project-service-child",
    "Auvra/project/errors.py": "error-model",
    "Auvra/project/schemas.py": "data-model",
    "Auvra/project/serialization.py": "project-service-child",
    "Auvra/providers/commands.py": "provider-service-child",
    "Auvra/providers/descriptors.py": "data-model",
    "Auvra/providers/errors.py": "error-model",
}
NATIVE_TRACE_CLASSIFICATIONS = {
    "assets.rs": "asset-submit-status-boundary",
    "gpu.rs": "renderer-dispatch-boundary",
    "lib.rs": "module-root",
    "main.rs": "direct-dispatch-and-phase-tracing",
    "render_world.rs": "render-extraction-boundary",
    "world.rs": "world-and-hydration-boundary",
}


class WholeProgramTraceTests(unittest.TestCase):
    def tearDown(self) -> None:
        install_diagnostics(None)

    def test_every_python_runtime_module_has_a_trace_classification(self) -> None:
        files = sorted((REPOSITORY_ROOT / "Auvra").rglob("*.py"))
        seen_exemptions: set[str] = set()
        missing: list[str] = []
        for path in files:
            relative = path.relative_to(REPOSITORY_ROOT).as_posix()
            if path.name == "__init__.py" or "/generated/" in f"/{relative}":
                continue
            source = path.read_text(encoding="utf-8")
            if any(token in source for token in (
                "trace_public_class", "@traced", ".emit(", "DiagnosticsSession",
                "start_diagnostic_span", "active_diagnostics", "process_ring",
            )):
                continue
            if relative in PYTHON_EXEMPTIONS:
                seen_exemptions.add(relative)
                continue
            missing.append(relative)
        stale = sorted(set(PYTHON_EXEMPTIONS) - seen_exemptions)
        self.assertEqual(missing, [], f"unclassified Python runtime modules: {missing}")
        self.assertEqual(stale, [], f"stale Python trace exemptions: {stale}")

    def test_detailed_capture_profiles_internal_functions_without_values_or_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra whole program trace ") as raw:
            session = DiagnosticsSession(
                Path(raw) / "diagnostics",
                source_root=REPOSITORY_ROOT,
                run_id="run-program-profile",
                mode="test",
            )
            session.start()
            session.start_detailed_capture()
            secret_value = "value-that-must-not-be-recorded"
            canonical_json({"private": secret_value, "count": 2})
            session.stop_detailed_capture(reason="test")
            session.close(outcome="success")
            records = [
                record for record in session.snapshot()
                if record.get("event") == "runtime.function_summary"
            ]
            encoded = json.dumps(records)
            self.assertTrue(any(
                record.get("attributes", {}).get("codeSite")
                == "auvra.project.serialization.canonical_json"
                for record in records
            ))
            self.assertNotIn(secret_value, encoded)
            self.assertNotIn(str(REPOSITORY_ROOT), encoded)

    def test_hierarchical_spans_share_trace_and_link_parent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra span hierarchy ") as raw:
            session = DiagnosticsSession(Path(raw) / "diagnostics", run_id="run-spans", mode="test")
            session.start()
            install_diagnostics(session)

            @traced("coverage_test", "child", detailed_only=False)
            def child() -> None:
                time.sleep(0.001)

            @traced("coverage_test", "parent", detailed_only=False)
            def parent() -> None:
                child()

            parent()
            session.close(outcome="success")
            starts = [
                record for record in session.snapshot()
                if record.get("event") == "activity.started"
                and record.get("attributes", {}).get("subsystem") == "coverage_test"
            ]
            self.assertEqual(len(starts), 2)
            parent_record = next(record for record in starts if record["attributes"]["action"] == "parent")
            child_record = next(record for record in starts if record["attributes"]["action"] == "child")
            self.assertEqual(child_record["traceId"], parent_record["traceId"])
            self.assertEqual(child_record["parentSpanId"], parent_record["spanId"])

    def test_detailed_profiler_state_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra profiler bounds ") as raw:
            session = DiagnosticsSession(Path(raw) / "diagnostics", run_id="run-profiler-bounds", mode="test")
            profiler = session._program_profiler
            code_objects = [
                compile(f"VALUE = {index}", f"<external-{index}>", "exec")
                for index in range(PROFILE_CODE_CACHE_MAX + 32)
            ]
            for code in code_objects:
                profiler._code_site(code)
            self.assertEqual(len(profiler._code_sites), PROFILE_CODE_CACHE_MAX)

            profiler._active = True
            for index in range(PROFILE_SUMMARY_MAX + 32):
                frame = object()
                profiler._local.stack = [
                    (id(frame), time.perf_counter(), f"auvra.test.call_{index}",
                     "trace-bounds", None, f"span-{index}", None)
                ]
                profiler._profile(frame, "return", None)
            profiler._active = False
            self.assertEqual(len(profiler._summaries), PROFILE_SUMMARY_MAX)

    def test_every_native_dispatch_method_has_a_trace_phase_or_quiet_classification(self) -> None:
        native_modules = {path.name for path in (REPOSITORY_ROOT / "native" / "src").glob("*.rs")}
        self.assertEqual(native_modules, set(NATIVE_TRACE_CLASSIFICATIONS))
        source = (REPOSITORY_ROOT / "native" / "src" / "main.rs").read_text(encoding="utf-8")
        start = source.index("let result = match req.method.as_str()")
        end = source.index("match result", start)
        dispatch = source[start:end]
        methods = set(re.findall(
            r'"((?:world|renderer|asset|viewport)\.[A-Za-z]+|shutdown)"',
            dispatch,
        ))
        phased = {
            "world.getSnapshot", "world.apply", "world.applyTransaction", "world.applyCommands",
            "world.validateHydration", "world.hydrate", "world.beginHydration",
            "world.appendHydration", "world.commitHydration", "world.abortHydration",
            "world.closeProject", "world.advance", "renderer.renderReference",
            "renderer.extract", "renderer.recover", "asset.submit", "asset.beginCook",
            "asset.status", "asset.cancel", "viewport.open", "viewport.close", "shutdown",
        }
        quiet = {"world.getReplay", "renderer.getCapabilities", "renderer.getMetrics"}
        self.assertEqual(methods, phased | quiet)
        self.assertIn("NativeTraceGuard::begin(&method, req.id, diagnostic_context)", source)
        for phase in (
            "world_commit", "hydration_validate", "hydration_commit", "world_advance",
            "render_extract", "render_submit", "asset_submit", "viewport_open",
            "viewport_close", "renderer_recover", "shutdown",
        ):
            self.assertIn(f'"{phase}"', dispatch)

    def test_native_trace_spans_include_request_identity(self) -> None:
        """Repeated native calls on one trace must remain independently correlated."""
        source = (REPOSITORY_ROOT / "native" / "src" / "main.rs").read_text(encoding="utf-8")
        guard_start = source.index("impl NativeTraceGuard")
        guard_end = source.index("fn take_diagnostic_context", guard_start)
        guard = source[guard_start:guard_end]
        self.assertIn(
            "fn begin(method: &str, request_id: u64, context: DiagnosticContext)",
            guard,
        )
        self.assertIn('"{method}:{request_id}:{}"', guard)
        self.assertIn(
            "NativeTraceGuard::begin(&method, req.id, diagnostic_context)",
            source,
        )


if __name__ == "__main__":
    unittest.main()
