from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

from Auvra.project.schemas import DOMAIN_NAMES, PROJECT_SCHEMA_NAME
from release import pipeline
from release.asset_cooking import cook_assets
from release.cross_backend import verify_cross_backend
from release.lifecycle import LifecycleState
from release.pipeline import ReleaseError, assemble, sign_msix, verify_package, write_input_inventory
from release.runtime_verify import (
    HOST_SCHEMA_FILES,
    PROJECT_SCHEMA_NAMES,
    RuntimeVerificationError,
    verify_installed_package,
)
from release.windows_lifecycle import WINDOWS_LIFECYCLE_SCRIPT, run_windows_lifecycle_smoke


REPOSITORY = Path(__file__).parents[2]


def _notices(title: str, component: str) -> bytes:
    """A minimal staged notices file in the release.notices entry format."""
    rule = "=" * 78
    return f"{title}\n\n{rule}\n{component}\n{rule}\n\nPermission is hereby granted, free of charge.\n".encode("utf-8")


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
                    "webview2-fixed", "native", "game-player", "host", "licenses",
                )
            }
            for directory in directories.values():
                directory.mkdir()
            native = directories["native"] / "auvra-native.exe"
            native.write_bytes(b"native")
            game_player = directories["game-player"] / "auvra-player.exe"
            game_player.write_bytes(b"player")
            result = self._run_wrapper(
                "stage_inputs.ps1", "-Frontend", str(directories["frontend"]),
                "-PythonEmbed", str(directories["python-embed"]),
                "-PythonSitePackages", str(directories["python-site-packages"]),
                "-WebView2Sdk", str(directories["webview2-sdk"]),
                "-WebView2Fixed", str(directories["webview2-fixed"]),
                "-NativeBinary", str(native), "-GamePlayerBinary", str(game_player), "-HostInput", str(directories["host"]),
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
            # Resource archives contain arbitrary prose strings; these must
            # not be mistaken for release-private text merely because the
            # bytes happen to include a policy phrase.
            "webview2-fixed/resources.pak": b"\x00internal roadmap\x00",
            "webview2-fixed/Auvra.runtime-pin.json": b'{"schema":1,"kind":"webview2Fixed","version":"151.0.4129.107","sha256":"f1e1c2c9b34c79ba4d88df77fb79a05441e1bd7481d6a985d76dd377cda45f33"}',
            "native/auvra-native.exe": b"native",
            "game-player/auvra-player.exe": b"player",
            # Third-party notices: Vite emits the frontend file, stage_inputs.ps1
            # writes the Rust crate files, and Python notices come from dist-info.
            "frontend/THIRD_PARTY_NOTICES.txt": _notices("Third-party software notices", "react@18.2.0 (MIT)"),
            "native/THIRD_PARTY_NOTICES.txt": _notices("Native engine crates", "wgpu@30.0.1 (MIT OR Apache-2.0)"),
            "game-player/THIRD_PARTY_NOTICES.txt": _notices("Game player crates", "wry@0.57.1 (Apache-2.0 OR MIT)"),
            "python-site-packages/example_package-1.0.0.dist-info/METADATA":
                b"Metadata-Version: 2.4\nName: example-package\nVersion: 1.0.0\nLicense-Expression: MIT\nLicense-File: LICENSE\n",
            "python-site-packages/example_package-1.0.0.dist-info/licenses/LICENSE": b"MIT License\n\nCopyright (c) Example\n",
            "host/Auvra/__init__.py": b"",
            "host/Auvra/launcher/__init__.py": b"",
            "host/Auvra/launcher/cli.py": b"def main(argv=None): return 0\n",
            "licenses/NOTICE.txt": b"permissive notices",
        }
        for relative, data in files.items():
            path = staged / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        # Mirror the CI host-input step: the real schema files sit beside Auvra.
        for relative in HOST_SCHEMA_FILES:
            path = staged / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((REPOSITORY / relative.removeprefix("host/")).read_bytes())
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
            self.assertTrue((output / "game-player" / "auvra-player.exe").is_file())
            self.assertTrue((output / "release-manifest.json").is_file())

    def test_release_schema_contract_matches_host_schema_modules(self) -> None:
        self.assertEqual(sorted(PROJECT_SCHEMA_NAMES), sorted((*DOMAIN_NAMES, PROJECT_SCHEMA_NAME)))
        for relative in HOST_SCHEMA_FILES:
            self.assertTrue((REPOSITORY / relative.removeprefix("host/")).is_file(), relative)

    def test_host_schemas_are_required_staged_inputs_and_package_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            for relative in ("host/protocol/v1/auvra-host.schema.json", "host/project/v1/hud.schema.json"):
                schema = inputs / relative
                original = schema.read_bytes()
                schema.unlink()
                with self.assertRaisesRegex(ReleaseError, "missing the packaged host schema"):
                    write_input_inventory(inputs, root / "inventory.json")
                with self.assertRaisesRegex(ReleaseError, "missing the packaged host schema"):
                    assemble(inputs, root / "package", channel="dev", version="1.0.0")
                self.assertFalse((root / "package").exists())
                schema.write_bytes(original)
            # Even a package assembled around the input contract cannot verify.
            shutil.rmtree(inputs / "host" / "protocol")
            with mock.patch.object(pipeline, "_require_host_schemas"):
                assemble(inputs, root / "schemaless", channel="dev", version="1.0.0")
            with self.assertRaisesRegex(ReleaseError, "missing the packaged host schema: protocol/v1/auvra-host.schema.json"):
                verify_package(root / "schemaless")
            with self.assertRaisesRegex(RuntimeVerificationError, "host/protocol/v1/auvra-host.schema.json"):
                verify_installed_package(root / "schemaless")

    @staticmethod
    def _stage_application_host(inputs: Path) -> None:
        """Replace the stub host with the real application tree, as CI does."""
        host_application = inputs / "host" / "Auvra"
        shutil.rmtree(host_application)
        shutil.copytree(
            REPOSITORY / "Auvra", host_application,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "Auvra.py", "Auvra.pyproj", "bootstrap.py"),
        )

    def test_packaged_non_ui_smoke_loads_host_schemas_from_the_package_tree(self) -> None:
        loader = (
            "import json, sys\n"
            "from pathlib import Path\n"
            "root = Path(sys.argv[1]).resolve()\n"
            "sys.path.insert(0, str(root / 'host'))\n"
            "from auvra_release_verify import verify_packaged_schemas\n"
            "verify_packaged_schemas(root)\n"
            "from Auvra.host import validation\n"
            "from Auvra.project import schemas\n"
            "print(json.dumps({'protocol': str(validation.SCHEMA_PATH), 'project': str(schemas.SCHEMA_DIR)}))\n"
        )
        def run(*arguments: str) -> subprocess.CompletedProcess[str]:
            # ``-I`` keeps the developer checkout off sys.path; ``-B`` keeps the
            # package free of bytecode, which the runtime verifier rejects.
            return subprocess.run(
                [sys.executable, "-I", "-B", *arguments],
                env={**os.environ, "AUVRA_RELEASE_NON_UI_SMOKE": "1"},
                capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
            )

        with tempfile.TemporaryDirectory(prefix="auvra packaged schemas ") as temporary:
            root = Path(temporary)
            inputs = self.staged_inputs(root)
            self._stage_application_host(inputs)
            package = root / "package"
            assemble(inputs, package, channel="dev", version="1.0.0")
            smoke = run(str(package / "host" / "auvra_startup.py"))
            self.assertEqual(smoke.returncode, 0, smoke.stdout + smoke.stderr)
            resolved = run("-c", loader, str(package))
            self.assertEqual(resolved.returncode, 0, resolved.stdout + resolved.stderr)
            values = json.loads(resolved.stdout)
            host = package.resolve() / "host"
            self.assertEqual(Path(values["protocol"]), host / "protocol" / "v1" / "auvra-host.schema.json")
            self.assertEqual(Path(values["project"]), host / "project" / "v1")

            # A manifest-consistent package whose shipped schema cannot load
            # must fail the packaged smoke, not merely the file inventory.
            (inputs / "host" / "project" / "v1" / "hud.schema.json").write_text("{not json", encoding="utf-8")
            broken = root / "broken-package"
            assemble(inputs, broken, channel="dev", version="1.0.0")
            verify_installed_package(broken)
            failed = run(str(broken / "host" / "auvra_startup.py"))
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("packaged project schema could not be loaded: hud", failed.stderr)

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
            (inputs / "native" / "auvra-native.exe").write_bytes(
                rb"native build path: C:\Users\runneradmin\source\Auvra\native\src\main.rs"
            )
            binary_package = root / "binary-package"
            assemble(inputs, binary_package, channel="stable", version="1.0.0")
            self.assertTrue((binary_package / "native" / "auvra-native.exe").is_file())
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

    def test_windows_lifecycle_runner_requires_three_msix_files_and_proves_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packages = [root / name for name in ("initial.msix", "upgrade.msix", "rollback.msix")]
            for package in packages:
                package.write_bytes(b"signed package placeholder")
            response = {
                "schema": 1,
                "identity": "Auvra",
                "initialVersion": "1.0.0.0",
                "upgradeVersion": "2.0.0.0",
                "rollbackVersion": "1.0.0.0",
                "installed": True,
                "upgraded": True,
                "rolledBack": True,
                "uninstalled": True,
                "userDataPreserved": True,
            }
            with mock.patch("release.windows_lifecycle.os.name", "nt"), \
                 mock.patch("release.windows_lifecycle.Path", type(root)), \
                 mock.patch("release.windows_lifecycle.subprocess.run",
                            return_value=subprocess.CompletedProcess([], 0, json.dumps(response), "")) as run:
                result = run_windows_lifecycle_smoke(
                    packages[0], packages[1], packages[2], identity="Auvra", powershell="powershell.exe",
                )
            self.assertEqual(result, response)
            command = run.call_args.args[0]
            self.assertEqual(command[:5], ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"])
            self.assertIn("-ForceUpdateFromAnyVersion", WINDOWS_LIFECYCLE_SCRIPT)
            self.assertIn("-PreserveApplicationData", WINDOWS_LIFECYCLE_SCRIPT)

    def test_windows_lifecycle_runner_rejects_missing_package_before_starting_shell(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            packages = [root / name for name in ("initial.msix", "upgrade.msix")]
            for package in packages:
                package.write_bytes(b"placeholder")
            with mock.patch("release.windows_lifecycle.os.name", "nt"), \
                 mock.patch("release.windows_lifecycle.Path", type(root)), \
                 mock.patch("release.windows_lifecycle.subprocess.run") as run:
                with self.assertRaisesRegex(ReleaseError, "rollback package is missing"):
                    run_windows_lifecycle_smoke(
                        packages[0], packages[1], root / "rollback.msix", identity="Auvra", powershell="powershell.exe",
                    )
            run.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "PowerShell lifecycle scripts require Windows")
    def test_windows_lifecycle_powershell_body_parses(self) -> None:
        powershell = self._powershell()
        if powershell is None:
            self.skipTest("PowerShell is required for lifecycle script syntax validation")
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / "lifecycle.ps1"
            script.write_text(WINDOWS_LIFECYCLE_SCRIPT, encoding="utf-8")
            environment = os.environ.copy()
            environment["AUVRA_LIFECYCLE_PARSE_TARGET"] = str(script)
            parse = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "$tokens=$null; $errors=$null; "
                    "[System.Management.Automation.Language.Parser]::ParseFile($env:AUVRA_LIFECYCLE_PARSE_TARGET,[ref]$tokens,[ref]$errors) | Out-Null; "
                    "if($errors.Count){$errors | ForEach-Object Message; exit 1}; exit 0",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
                env=environment,
            )
        self.assertEqual(parse.returncode, 0, parse.stdout + parse.stderr)

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
