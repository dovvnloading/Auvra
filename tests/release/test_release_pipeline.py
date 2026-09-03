from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

from release.asset_cooking import cook_assets
from release.cross_backend import verify_cross_backend
from release.lifecycle import LifecycleState
from release.pipeline import ReleaseError, assemble, sign_msix, verify_package, write_input_inventory
from release.runtime_verify import verify_installed_package


class ReleasePipelineTests(unittest.TestCase):
    @staticmethod
    def _powershell() -> str | None:
        if os.name != "nt":
            return None
        return shutil.which("pwsh") or shutil.which("powershell")

    def _run_wrapper(self, script: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        powershell = self._powershell()
        if powershell is None:
            self.skipTest("PowerShell is required for release-wrapper regression tests")
        command = [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                   "-File", str(Path(__file__).parents[2] / "release" / script), *arguments]
        return subprocess.run(command, cwd=Path(__file__).parents[2], capture_output=True,
                              text=True, encoding="utf-8", errors="replace", check=False)

    @unittest.skipUnless(os.name == "nt", "release wrappers require Windows PowerShell")
    def test_build_wrapper_propagates_python_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = self._run_wrapper(
                "build.ps1", "-InputRoot", str(root / "missing-input"),
                "-OutputRoot", str(root / "package"), "-Channel", "stable", "-Version", "1.0.0",
            )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    @unittest.skipUnless(os.name == "nt", "release wrappers require Windows PowerShell")
    def test_verify_wrapper_propagates_python_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            result = self._run_wrapper(
                "verify.ps1", "-PackageRoot", str(Path(temporary) / "missing-package"),
                "-Channel", "stable",
            )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    @unittest.skipUnless(os.name == "nt", "release wrappers require Windows PowerShell")
    def test_stage_inputs_wrapper_propagates_python_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directories = {
                name: root / name
                for name in (
                    "frontend", "python-embed", "python-site-packages", "webview2-sdk",
                    "webview2-fixed", "native", "host", "licenses",
                )
            }
            for directory in directories.values():
                directory.mkdir()
            native = directories["native"] / "auvra-native.exe"
            native.write_bytes(b"native")
            result = self._run_wrapper(
                "stage_inputs.ps1", "-Frontend", str(directories["frontend"]),
                "-PythonEmbed", str(directories["python-embed"]),
                "-PythonSitePackages", str(directories["python-site-packages"]),
                "-WebView2Sdk", str(directories["webview2-sdk"]),
                "-WebView2Fixed", str(directories["webview2-fixed"]),
                "-NativeBinary", str(native), "-HostInput", str(directories["host"]),
                "-Licenses", str(directories["licenses"]), "-Output", str(root / "staged"),
            )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    def staged_inputs(self, root: Path) -> Path:
        staged = root / "inputs"
        files = {
            "frontend/index.html": b"<!doctype html>",
            "python-embed/pythonw.exe": b"pythonw",
            "python-embed/pythonw.zip": b"stdlib",
            "python-embed/Auvra.runtime-pin.json": b'{"schema":1,"kind":"pythonEmbed","version":"3.14.7","sha256":"d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15"}',
            "python-site-packages/pythonnet.pyd": b"wheel",
            "webview2-sdk/Microsoft.Web.WebView2.Core.dll": b"sdk",
            "webview2-sdk/.auvra-sdk.sha256": b"d3934f482d484b89fb4825df720c710664e1143a1e90f7b3a60794ef33f473d2\n",
            "webview2-fixed/msedgewebview2.exe": b"runtime",
            "webview2-fixed/Auvra.runtime-pin.json": b'{"schema":1,"kind":"webview2Fixed","version":"151.0.4129.107","sha256":"f1e1c2c9b34c79ba4d88df77fb79a05441e1bd7481d6a985d76dd377cda45f33"}',
            "native/auvra-native.exe": b"native",
            "host/Auvra/__init__.py": b"",
            "host/Auvra/launcher/__init__.py": b"",
            "host/Auvra/launcher/cli.py": b"def main(argv=None): return 0\n",
            "licenses/NOTICE.txt": b"permissive notices",
        }
        for relative, data in files.items():
            path = staged / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        for directory, kind, version, digest in (
            ("python-embed", "pythonEmbed", "3.14.7", "d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15"),
            ("webview2-fixed", "webview2Fixed", "151.0.4129.107", "f1e1c2c9b34c79ba4d88df77fb79a05441e1bd7481d6a985d76dd377cda45f33"),
        ):
            root = staged / directory
            entries = []
            for path in sorted(
                    (item for item in root.rglob("*") if item.is_file() and item.name != "Auvra.runtime-pin.json"),
                    key=lambda item: item.as_posix().lower()):
                entries.append({"path": path.relative_to(root).as_posix(), "size": path.stat().st_size,
                                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
            marker = {"schema": 1, "kind": kind, "version": version, "sha256": digest, "files": entries}
            (root / "Auvra.runtime-pin.json").write_text(json.dumps(marker, separators=(",", ":")), encoding="ascii")
        return staged

    def test_runtime_pin_attestation_rejects_modified_extracted_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            inputs = self.staged_inputs(Path(temporary))
            (inputs / "python-embed" / "pythonw.exe").write_bytes(b"tampered")
            with self.assertRaisesRegex(ReleaseError, "contents do not match"):
                write_input_inventory(inputs, inputs / "inventory.json")

    def test_signing_uses_timestamp_and_post_verifies_without_password_argument(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "Auvra.msix"
            certificate = root / "release.pfx"
            package.write_bytes(b"unsigned package")
            certificate.write_bytes(b"certificate")
            responses = [
                subprocess.CompletedProcess([], 0, stdout="signed", stderr=""),
                subprocess.CompletedProcess([], 0, stdout="verified", stderr=""),
            ]
            with mock.patch("release.pipeline.subprocess.run", side_effect=responses) as run:
                sign_msix(package, signtool="signtool.exe", certificate=certificate)
            self.assertEqual(run.call_count, 2)
            sign_command = run.call_args_list[0].args[0]
            self.assertNotIn("/p", sign_command)
            self.assertEqual(sign_command[sign_command.index("/tr") + 1], "https://timestamp.digicert.com")
            self.assertEqual(sign_command[sign_command.index("/td") + 1], "SHA256")
            verify_command = run.call_args_list[1].args[0]
            self.assertEqual(verify_command[1:5], ["verify", "/pa", "/all", "/q"])

    def test_signing_accepts_certificate_store_thumbprint_and_rejects_bad_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "Auvra.msix"
            package.write_bytes(b"unsigned package")
            with mock.patch("release.pipeline.subprocess.run", return_value=subprocess.CompletedProcess([], 0, stderr="")) as run:
                sign_msix(package, signtool="signtool.exe", thumbprint="a" * 40)
            self.assertIn("/sha1", run.call_args_list[0].args[0])
            with self.assertRaisesRegex(ReleaseError, "HTTPS"):
                sign_msix(package, signtool="signtool.exe", thumbprint="a" * 40,
                          timestamp_url="http://timestamp.example")

    def test_hosted_appinstaller_requires_secure_public_origin(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            for uri in (
                "http://updates.example/Auvra.appinstaller",
                "file:///tmp/Auvra.appinstaller",
                "https://localhost/Auvra.appinstaller",
                "https://127.0.0.1/Auvra.appinstaller",
                "https://user:password@updates.example/Auvra.appinstaller",
            ):
                with self.assertRaises(ReleaseError):
                    assemble(inputs, root / "bad", channel="stable", version="1.0.0",
                             appinstaller_uri=uri)

    def test_assemble_verify_and_appinstaller_are_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            output = root / "package"
            first = assemble(inputs, output, channel="beta", version="1.2.3",
                             appinstaller_uri="https://updates.example/{channel}/{version}/Auvra.appinstaller")
            first_bytes = {path.relative_to(output).as_posix(): path.read_bytes()
                           for path in output.rglob("*") if path.is_file()}
            first_times = {path.relative_to(output).as_posix(): path.stat().st_mtime_ns
                           for path in output.rglob("*") if path.is_file()}
            verify_package(output, expected_channel="beta")
            sbom = json.loads((output / "sbom.json").read_text(encoding="utf-8"))
            names = {(item.get("purl"), item.get("name")) for item in sbom["components"]}
            self.assertIn(("pkg:npm/react@18.2.0", "react"), names)
            self.assertTrue(any(item.get("purl", "").startswith("pkg:cargo/wgpu@") for item in sbom["components"]))
            self.assertTrue(any(item.get("purl", "").startswith("pkg:pypi/jsonschema@") for item in sbom["components"]))
            # MakeAppx adds container metadata when an MSIX is unpacked. It is
            # validated by MakeAppx itself and is not part of Auvra's payload.
            (output / "AppxBlockMap.xml").write_bytes(b"<BlockMap />")
            verify_package(output, expected_channel="beta")
            verify_installed_package(output)
            (output / "AppxBlockMap.xml").unlink()
            companion = root / "Auvra.Beta.appinstaller"
            self.assertTrue(companion.is_file())
            xml = ET.fromstring(companion.read_bytes())
            force = next(node for node in xml.iter() if node.tag.endswith("ForceUpdateFromAnyVersion"))
            self.assertEqual(force.text, "true")
            appx = ET.fromstring((output / "AppxManifest.xml").read_bytes())
            self.assertTrue(any(node.tag.endswith("Capability") and node.attrib.get("Name") == "runFullTrust"
                                for node in appx.iter()))
            shutil.rmtree(output)
            assemble(inputs, output, channel="beta", version="1.2.3",
                     appinstaller_uri="https://updates.example/{channel}/{version}/Auvra.appinstaller")
            second_bytes = {path.relative_to(output).as_posix(): path.read_bytes()
                            for path in output.rglob("*") if path.is_file()}
            second_times = {path.relative_to(output).as_posix(): path.stat().st_mtime_ns
                            for path in output.rglob("*") if path.is_file()}
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(first_times, second_times)
            self.assertEqual(first["identity"], "Auvra.Beta")
            startup = (output / "host" / "auvra_startup.py").read_text(encoding="utf-8")
            self.assertIn("sys.argv[1] != 'support'", startup)
            self.assertIn("main(sys.argv[1:], paths=paths)", startup)
            sitecustomize = (output / "runtime" / "python" / "sitecustomize.py").read_text(encoding="utf-8")
            self.assertIn("except SystemExit as exc:", sitecustomize)
            self.assertIn("os._exit(code)", sitecustomize)

    def test_default_local_release_contract_smoke_verifies_staged_package(self) -> None:
        """Run a real package assembly/verification smoke in ordinary discovery.

        The WebView2/native process smoke is intentionally Windows-only, but
        local discovery must still exercise the release boundary instead of
        relying solely on mocked launcher calls or skipped hardware tests.
        """
        with tempfile.TemporaryDirectory(prefix="auvra local release contract ") as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            output = root / "package"
            assemble(inputs, output, channel="stable", version="9.9.9",
                     appinstaller_uri="https://updates.example/stable/9.9.9/Auvra.appinstaller")
            verify_package(output, expected_channel="stable")
            manifest = verify_installed_package(output)

            self.assertEqual(manifest.get("channel"), "stable")
            self.assertTrue((output / "runtime" / "python").is_dir())
            self.assertTrue((output / "runtime" / "webview2").is_dir())
            self.assertTrue((output / "native" / "auvra-native.exe").is_file())
            self.assertTrue((output / "release-manifest.json").is_file())

    def test_integrity_and_forbidden_inputs_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            output = root / "package"
            assemble(inputs, output, channel="stable", version="1.0.0")
            (output / "frontend" / "index.html").write_bytes(b"tampered")
            with self.assertRaises(ReleaseError):
                verify_package(output)
            bad = inputs / "frontend" / "AGENTS.md"
            bad.write_text("must not ship", encoding="utf-8")
            with self.assertRaises(ReleaseError):
                write_input_inventory(inputs, root / "inventory.json")

    def test_content_scan_dev_feed_and_atomic_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            (inputs / "host" / "secret.txt").write_text("api_key='0123456789abcdef0123456789'", encoding="utf-8")
            with self.assertRaises(ReleaseError):
                assemble(inputs, root / "bad-package", channel="stable", version="1.0.0")
            self.assertFalse((root / "bad-package").exists())
            (inputs / "host" / "secret.txt").unlink()
            (inputs / "frontend" / "bundle.js.map").write_text("{}", encoding="utf-8")
            with self.assertRaises(ReleaseError):
                assemble(inputs, root / "map-package", channel="stable", version="1.0.0")
            (inputs / "frontend" / "bundle.js.map").unlink()
            (inputs / "frontend" / "bundle.js").write_text(
                "fetch('https://cdn.jsdelivr.net/example/runtime.js')", encoding="utf-8"
            )
            with self.assertRaises(ReleaseError):
                assemble(inputs, root / "cdn-package", channel="stable", version="1.0.0")
            (inputs / "frontend" / "bundle.js").unlink()
            (inputs / "host" / "developer-path.txt").write_text(
                r"C:\Users\developer\source\Auvra.py", encoding="utf-8"
            )
            with self.assertRaises(ReleaseError):
                assemble(inputs, root / "path-package", channel="stable", version="1.0.0")
            (inputs / "host" / "developer-path.txt").unlink()
            (inputs / "host" / "private-plan.txt").write_text("internal roadmap", encoding="utf-8")
            with self.assertRaises(ReleaseError):
                assemble(inputs, root / "private-package", channel="stable", version="1.0.0")
            (inputs / "host" / "private-plan.txt").unlink()
            with self.assertRaises(ReleaseError):
                assemble(inputs, root / "dev-package", channel="dev", version="1.0.0",
                         appinstaller_uri="https://updates.example/dev.appinstaller")

    def test_content_scan_rejects_nul_encoded_secret(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            (inputs / "host" / "utf16.txt").write_bytes(
                "api_key='0123456789abcdef0123456789'".encode("utf-16-le")
            )
            with self.assertRaisesRegex(ReleaseError, "secret-like"):
                assemble(inputs, root / "nul-package", channel="stable", version="1.0.0")

    def test_lifecycle_upgrade_rollback_and_uninstall_preserve_data(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            one = root / "one"
            two = root / "two"
            assemble(inputs, one, channel="stable", version="1.0.0")
            assemble(inputs, two, channel="stable", version="2.0.0")
            state = LifecycleState(user_data={"project.auvra": b"keep"})
            self.assertEqual(state.install(one, channel="stable")["action"], "install")
            self.assertEqual(state.install(two, channel="stable")["action"], "install")
            with self.assertRaises(ReleaseError):
                state.install(one, channel="stable")
            self.assertEqual(state.install(one, channel="stable", force_any_version=True)["action"], "rollback")
            state.uninstall(channel="stable")
            self.assertEqual(state.user_data, {"project.auvra": b"keep"})

    def test_asset_cooking_and_cross_backend_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "scene.json").write_text('{ "b": 2, "a": 1 }\n', encoding="utf-8")
            (source / "mesh.bin").write_bytes(b"mesh")
            cooked = root / "cooked"
            first = cook_assets(source, cooked)
            first_bytes = {path.relative_to(cooked).as_posix(): path.read_bytes()
                           for path in cooked.rglob("*") if path.is_file()}
            self.assertNotIn(str(source), (cooked / "assets-manifest.json").read_text(encoding="utf-8"))
            second = cook_assets(source, cooked)
            second_bytes = {path.relative_to(cooked).as_posix(): path.read_bytes()
                            for path in cooked.rglob("*") if path.is_file()}
            self.assertEqual(first, second)
            self.assertEqual(first_bytes, second_bytes)
            with self.assertRaisesRegex(ReleaseError, "pixel signatures differ"):
                verify_cross_backend(
                {"sceneId": "basic", "selected": "webgl2", "pixelSignature": "a" * 32,
                 "results": [{"backend": "webgl2", "supported": True, "qualified": True,
                              "pixelSignature": "a" * 32}]},
                {"probe": "auvra-native-self-test", "reference": {"width": 96, "height": 80,
                 "pixel_hash_fnv1a64": "0x" + "b" * 16}},
                )
            evidence = verify_cross_backend(
                {"sceneId": "basic", "selected": "webgl2", "pixelSignature": "0x" + "a" * 16,
                 "results": [{"backend": "webgl2", "supported": True, "qualified": True,
                              "pixelSignature": "A" * 16}]},
                {"probe": "auvra-native-self-test", "reference": {"width": 96, "height": 80,
                 "pixel_hash_fnv1a64": "0x" + "a" * 16}},
            )
            self.assertTrue(evidence["pixelSignaturesMatch"])
            with self.assertRaises(ReleaseError):
                verify_cross_backend(
                    {"sceneId": "basic", "selected": "webgl2", "pixelSignature": "a" * 32,
                     "results": [{"backend": "webgl2", "supported": True, "qualified": True,
                                  "pixelSignature": "a" * 32}], "width": 32, "height": 32},
                    {"probe": "auvra-native-self-test", "reference": {"width": 96, "height": 80,
                     "pixel_hash_fnv1a64": "0x" + "a" * 16}},
                )


if __name__ == "__main__":
    unittest.main()
