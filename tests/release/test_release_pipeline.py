from __future__ import annotations

import json
from pathlib import Path
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET

from release.asset_cooking import cook_assets
from release.cross_backend import verify_cross_backend
from release.lifecycle import LifecycleState
from release.pipeline import ReleaseError, assemble, verify_package, write_input_inventory
from release.runtime_verify import verify_installed_package


class ReleasePipelineTests(unittest.TestCase):
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
        return staged

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
            evidence = verify_cross_backend(
                {"sceneId": "basic", "selected": "webgl2", "pixelSignature": "web",
                 "results": [{"backend": "webgl2", "supported": True, "qualified": True,
                              "pixelSignature": "web"}]},
                {"probe": "auvra-native-self-test", "reference": {"width": 96, "height": 80,
                 "pixel_hash_fnv1a64": "0x1234"}},
            )
            self.assertFalse(evidence["pixelSignaturesMatch"])
            with self.assertRaises(ReleaseError):
                verify_cross_backend(
                    {"sceneId": "basic", "selected": "webgl2", "pixelSignature": "web",
                     "results": [{"backend": "webgl2", "supported": True, "qualified": True,
                                  "pixelSignature": "web"}], "width": 32, "height": 32},
                    {"probe": "auvra-native-self-test", "reference": {"width": 96, "height": 80,
                     "pixel_hash_fnv1a64": "0x1234"}},
                )


if __name__ == "__main__":
    unittest.main()
