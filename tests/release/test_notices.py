"""Third-party notices: Python/Rust collectors, composition and the release check."""

from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

from release import notices, pipeline
from release.notices import (
    EDITOR_PARTS,
    NOTICES_FILE,
    RULE,
    NoticesError,
    compose_editor_notices,
    count_components,
    editor_notices_from_inputs,
    python_notices,
    render_python_document,
    render_rust_document,
    rust_notices,
    verify_editor_notices,
)
from release.pipeline import ReleaseError, assemble, canonical_json, verify_package, write_input_inventory
from release.runtime_verify import verify_installed_package
from tests.release import test_release_pipeline as release_fixtures


REPOSITORY = Path(__file__).parents[2]
PINS = json.loads((REPOSITORY / "release" / "policy.json").read_text(encoding="utf-8"))["runtimePins"]
MISSING_CARGO = str(REPOSITORY / "release" / "no-such-cargo.exe")


def write(path: Path, data: str | bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
    return path


def staged_notices(title: str, *components: str) -> str:
    body = "".join(f"{RULE}\n{component}\n{RULE}\n\nPermission is hereby granted, free of charge.\n\n"
                   for component in components)
    return f"{title}\n\n{body}"


def crate_archive(path: Path, name: str, version: str, files: dict[str, str]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, "w:gz") as bundle:
        for relative, text in files.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(f"{name}-{version}/{relative}")
            info.size = len(data)
            bundle.addfile(info, io.BytesIO(data))
    return path


class PythonNoticesTests(unittest.TestCase):
    def test_dist_info_license_files_metadata_and_embedded_components(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site = Path(temporary)
            modern = site / "modern_pkg-2.0.dist-info"
            write(modern / "METADATA", "Metadata-Version: 2.4\nName: modern-pkg\nVersion: 2.0\n"
                  "License-Expression: MIT\nLicense-File: LICENSE\nLicense-File: AUTHORS.md\n"
                  "Project-URL: Documentation, https://docs.example\nProject-URL: Source, https://src.example/modern\n"
                  "\nLicense: this body line is not a header\n")
            write(modern / "licenses" / "LICENSE", "MIT License\r\n\r\nSee https://unpkg.com/modern for assets.\r\n")
            write(modern / "licenses" / "AUTHORS.md", "Ada\n")
            write(modern / "sboms" / "modern.cyclonedx.json", json.dumps({"components": [
                {"name": "archery", "version": "1.2.2", "licenses": [{"expression": "MIT"}]},
                {"name": "pyo3", "version": "0.29.0", "licenses": [{"license": {"id": "Apache-2.0"}}]},
            ]}))
            legacy = site / "Legacy-1.0.dist-info"
            write(legacy / "METADATA", "Metadata-Version: 2.1\nName: Legacy\nVersion: 1.0\nLicense: BSD\n"
                  "Home-page: https://legacy.example\n")
            write(legacy / "LICENSE.txt", "BSD text\n")
            write(legacy / "RECORD", "not a license\n")
            classified = site / "classified-3.dist-info"
            write(classified / "METADATA", "Metadata-Version: 2.1\nName: classified\nVersion: 3\n"
                  "License: UNKNOWN\nClassifier: License :: OSI Approved :: MIT License\n")
            write(site / "stray.dist-info" / "RECORD", "no metadata\n")
            write(site / "module.py", "")

            found = python_notices(site)

            self.assertEqual([(item.name, item.version, item.license) for item in found], [
                ("classified", "3", "MIT License"),
                ("Legacy", "1.0", "BSD"),
                ("modern-pkg", "2.0", "MIT"),
            ])
            classified_notice, legacy_notice, modern_notice = found
            self.assertEqual(classified_notice.texts, ())
            self.assertEqual(legacy_notice.texts, (("LICENSE.txt", "BSD text"),))
            self.assertIn("Project: https://legacy.example", legacy_notice.details)
            self.assertEqual([label for label, _ in modern_notice.texts], ["licenses/LICENSE", "licenses/AUTHORS.md"])
            self.assertIn("Project: https://src.example/modern", modern_notice.details)
            self.assertIn("  archery 1.2.2 (MIT)", modern_notice.details)
            self.assertIn("  pyo3 0.29.0 (Apache-2.0)", modern_notice.details)

            document = render_python_document(found)
            self.assertEqual(count_components(document), 3)
            self.assertIn("(No license file shipped; declared license: MIT License)", document)
            self.assertIn("See unpkg.com/modern for assets.", document)
            self.assertNotIn("https://unpkg.com", document)
            self.assertNotIn("\r", document)
            self.assertNotIn(temporary, document)

    def test_missing_site_packages_is_empty(self) -> None:
        self.assertEqual(python_notices(Path(tempfile.gettempdir()) / "auvra-no-such-site-packages"), [])


class RustNoticesTests(unittest.TestCase):
    def test_cargo_metadata_walk_keeps_shipped_crates_and_their_license_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "project"
            write(project / "Cargo.toml", "[package]\nname = \"app\"\nversion = \"0.1.0\"\n")
            registry = root / "registry"
            alpha = registry / "alpha-1.0.0"
            write(alpha / "Cargo.toml", "")
            write(alpha / "LICENSE-MIT", "MIT alpha\n")
            write(alpha / "LICENSE-APACHE", "Apache alpha\n")
            write(alpha / "LICENSE.spdx", "SPDXVersion: SPDX-2.1\n")
            write(alpha / "src" / "license.rs", "// code\n")
            write(alpha / "license.rs", "// code\n")
            beta = registry / "beta-2.0.0"
            write(beta / "Cargo.toml", "")
            gamma = registry / "gamma-0.3.0"
            write(gamma / "Cargo.toml", "")
            write(gamma / "docs" / "COPYING-gamma", "Gamma terms\n")
            write(gamma / "LICENSES" / "Zlib.txt", "Zlib terms\n")
            dev_only = registry / "devonly-9.0.0"
            write(dev_only / "Cargo.toml", "")

            def package(name: str, version: str, directory: Path, **fields: object) -> dict[str, object]:
                return {"id": f"registry+https://github.com/rust-lang/crates.io-index#{name}@{version}",
                        "name": name, "version": version, "source": notices.CRATES_IO_SOURCE,
                        "manifest_path": str(directory / "Cargo.toml"), "license": None, "license_file": None,
                        "repository": None, **fields}

            app_id = f"path+file:///{project.as_posix()}#app@0.1.0"
            packages = [
                {"id": app_id, "name": "app", "version": "0.1.0", "source": None,
                 "manifest_path": str(project / "Cargo.toml"), "license": "Apache-2.0"},
                package("alpha", "1.0.0", alpha, license="MIT OR Apache-2.0", repository="https://alpha.example"),
                package("beta", "2.0.0", beta, license="MIT"),
                package("gamma", "0.3.0", gamma, license_file="docs/COPYING-gamma"),
                package("devonly", "9.0.0", dev_only, license="MIT"),
            ]
            ids = {item["name"]: item["id"] for item in packages}
            metadata = {
                "packages": packages,
                "workspace_members": [app_id],
                "resolve": {"root": app_id, "nodes": [
                    {"id": app_id, "deps": [
                        {"pkg": ids["alpha"], "dep_kinds": [{"kind": None, "target": None}]},
                        {"pkg": ids["gamma"], "dep_kinds": [{"kind": "build", "target": None}]},
                        {"pkg": ids["devonly"], "dep_kinds": [{"kind": "dev", "target": None}]},
                    ]},
                    {"id": ids["alpha"], "deps": [{"pkg": ids["beta"], "dep_kinds": [{"kind": None, "target": None}]}]},
                    {"id": ids["beta"], "deps": []},
                    {"id": ids["gamma"], "deps": []},
                    {"id": ids["devonly"], "deps": []},
                ]},
            }
            with mock.patch.object(notices, "_cargo_metadata", return_value=metadata) as cargo:
                result = rust_notices(project, cargo_home=root / "empty-cargo-home")
            self.assertEqual(cargo.call_args.args[1], (notices.WINDOWS_TARGET,))
            self.assertEqual(result.resolver, "cargo metadata")
            self.assertEqual(result.unavailable, ())
            by_name = {item.name: item for item in result.notices}
            self.assertEqual(list(by_name), ["alpha", "beta", "gamma"])
            self.assertEqual(by_name["alpha"].texts, (("LICENSE-APACHE", "Apache alpha"), ("LICENSE-MIT", "MIT alpha")))
            self.assertEqual(by_name["alpha"].details, ("Repository: https://alpha.example",
                                                        "Crate: https://crates.io/crates/alpha/1.0.0"))
            self.assertEqual(by_name["beta"].texts, ())
            self.assertIn("No license file is shipped in the crate source. Declared license: MIT.",
                          by_name["beta"].render())
            self.assertEqual(by_name["gamma"].license, "see docs/COPYING-gamma")
            self.assertEqual([label for label, _ in by_name["gamma"].texts], ["LICENSES/Zlib.txt", "docs/COPYING-gamma"])

            document = render_rust_document("the test binary (app.exe)", result)
            self.assertTrue(document.startswith("Third-party software notices: the test binary (app.exe)\n"))
            self.assertIn("resolved by cargo metadata", " ".join(document.split()))
            self.assertEqual(count_components(document), 3)
            self.assertNotIn(temporary, document)

    def test_lockfile_fallback_reads_vendor_registry_and_cache_and_reports_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "project"
            write(project / "Cargo.toml", "[package]\nname = \"app\"\nversion = \"0.1.0\"\n")
            source = 'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
            write(project / "Cargo.lock", "version = 4\n\n"
                  "[[package]]\nname = \"app\"\nversion = \"0.1.0\"\n\n"
                  f"[[package]]\nname = \"cached\"\nversion = \"1.1.0\"\n{source}\n"
                  f"[[package]]\nname = \"missing\"\nversion = \"1.0.0\"\n{source}\n"
                  f"[[package]]\nname = \"unpacked\"\nversion = \"0.2.0\"\n{source}\n"
                  f"[[package]]\nname = \"vendored\"\nversion = \"3.0.0\"\n{source}\n")
            write(project / "vendor" / "vendored" / "Cargo.toml",
                  "[package]\nname = \"vendored\"\nversion = \"3.0.0\"\nlicense = \"Zlib\"\n")
            write(project / "vendor" / "vendored" / "LICENSE", "Zlib vendored\n")
            cargo_home = root / "cargo-home"
            index = "index.crates.io-0000000000000000"
            unpacked = cargo_home / "registry" / "src" / index / "unpacked-0.2.0"
            write(unpacked / "Cargo.toml", "[package]\nname = \"unpacked\"\nversion = \"0.2.0\"\nlicense = \"ISC\"\n"
                  "repository = \"https://unpacked.example\"\n")
            write(unpacked / "LICENSE.md", "ISC unpacked\n")
            crate_archive(cargo_home / "registry" / "cache" / index / "cached-1.1.0.crate", "cached", "1.1.0", {
                "Cargo.toml": "[package]\nname = \"cached\"\nversion = \"1.1.0\"\nlicense = \"MIT\"\n"
                              "license-file = \"legal/TERMS\"\n",
                "LICENSE-MIT": "MIT cached\n",
                "legal/TERMS": "Cached terms\n",
                "src/lib.rs": "// code\n",
            })

            result = rust_notices(project, cargo=MISSING_CARGO, cargo_home=cargo_home)

            self.assertEqual(result.resolver, "Cargo.lock")
            self.assertEqual(result.unavailable, ("missing@1.0.0",))
            by_name = {item.name: item for item in result.notices}
            self.assertEqual(list(by_name), ["cached", "missing", "unpacked", "vendored"])
            self.assertEqual((by_name["cached"].license, by_name["cached"].texts),
                             ("MIT", (("LICENSE-MIT", "MIT cached"), ("legal/TERMS", "Cached terms"))))
            self.assertEqual((by_name["unpacked"].license, by_name["unpacked"].texts),
                             ("ISC", (("LICENSE.md", "ISC unpacked"),)))
            self.assertIn("Repository: https://unpacked.example", by_name["unpacked"].details)
            self.assertEqual((by_name["vendored"].license, by_name["vendored"].texts),
                             ("Zlib", (("LICENSE", "Zlib vendored"),)))
            missing = by_name["missing"].render()
            self.assertIn("missing@1.0.0 (license unavailable offline)", missing)
            self.assertIn("License text not available offline", missing)
            self.assertIn("https://crates.io/crates/missing/1.0.0", missing)
            document = render_rust_document("the test binary", result)
            prose = " ".join(document.split())
            self.assertIn("without platform filtering", prose)
            self.assertIn("1 crate(s) whose source was not available offline", prose)

    def test_cli_writes_notices_and_strict_mode_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "project"
            write(project / "Cargo.toml", "[package]\nname = \"app\"\nversion = \"0.1.0\"\n")
            write(project / "Cargo.lock", "version = 4\n\n[[package]]\nname = \"gone\"\nversion = \"1.0.0\"\n"
                  "source = \"registry+https://github.com/rust-lang/crates.io-index\"\n")
            arguments = ["rust", "--manifest-dir", str(project), "--label", "the test binary",
                         "--cargo", MISSING_CARGO, "--cargo-home", str(root / "cargo-home")]
            strict_output = root / "strict" / NOTICES_FILE
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(notices.main([*arguments, "--strict", "--output", str(strict_output)]), 2)
            self.assertIn("gone@1.0.0", stderr.getvalue())
            self.assertFalse(strict_output.exists())
            output = root / "lenient" / NOTICES_FILE
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertEqual(notices.main([*arguments, "--output", str(output)]), 0)
            summary = json.loads(stdout.getvalue())
            self.assertEqual((summary["crates"], summary["resolver"], summary["unavailable"]),
                             (1, "Cargo.lock", ["gone@1.0.0"]))
            self.assertEqual(summary["bytes"], output.stat().st_size)
            self.assertEqual(count_components(output.read_text(encoding="utf-8")), 1)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(notices.main(["rust", "--manifest-dir", str(project), "--output", str(output),
                                               "--cargo", MISSING_CARGO]), 2)

    def test_universal_binaries_resolve_every_target_in_one_metadata_call(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary) / "project"
            write(project / "Cargo.toml", "[package]\nname = \"app\"\nversion = \"0.1.0\"\n")
            empty = json.dumps({"packages": [], "workspace_members": [], "resolve": {"nodes": []}}).encode("utf-8")
            with mock.patch.object(notices.subprocess, "run",
                                   return_value=notices.subprocess.CompletedProcess([], 0, empty, b"")) as run:
                self.assertIsNotNone(notices._cargo_metadata(project, notices.MACOS_TARGETS, "cargo"))
            command = run.call_args.args[0]
            flags = [command[index + 1] for index, item in enumerate(command) if item == "--filter-platform"]
            self.assertEqual(flags, list(notices.MACOS_TARGETS))
            self.assertIn("--offline", command)

            with mock.patch.object(notices, "_cargo_metadata", return_value=json.loads(empty)) as cargo:
                result = rust_notices(project, target=notices.MACOS_TARGETS, cargo_home=Path(temporary) / "home")
            self.assertEqual(cargo.call_args.args[1], notices.MACOS_TARGETS)
            self.assertEqual(result.target, "x86_64-apple-darwin and aarch64-apple-darwin")
            prose = " ".join(render_rust_document("the test binary", result).split())
            self.assertIn("for x86_64-apple-darwin and aarch64-apple-darwin", prose)
            with self.assertRaises(NoticesError):
                rust_notices(project, target=())

    def test_player_label_follows_the_target_operating_system(self) -> None:
        player = REPOSITORY / "player-desktop"
        self.assertEqual(notices.default_label(player), notices.PLAYER_LABEL)
        self.assertEqual(notices.default_label(player, notices.LINUX_TARGET), notices.LINUX_PLAYER_LABEL)
        self.assertEqual(notices.default_label(player, notices.MACOS_TARGETS), notices.MACOS_PLAYER_LABEL)
        self.assertIsNone(notices.default_label(player, (notices.WINDOWS_TARGET, notices.LINUX_TARGET)))
        self.assertIsNone(notices.default_label(player, "wasm32-unknown-unknown"))
        self.assertEqual(notices.default_label(REPOSITORY / "native"), notices.NATIVE_LABEL)
        self.assertIsNone(notices.default_label(REPOSITORY / "release"))

    def test_cli_writes_universal_macos_player_notices(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "player-desktop"
            write(project / "Cargo.toml", "[package]\nname = \"auvra-player\"\nversion = \"0.1.0\"\n")
            write(project / "Cargo.lock", "version = 4\n\n[[package]]\nname = \"objc2\"\nversion = \"0.6.3\"\n"
                  "source = \"registry+https://github.com/rust-lang/crates.io-index\"\n")
            crate = root / "cargo-home" / "registry" / "src" / "index.crates.io-0000000000000000" / "objc2-0.6.3"
            write(crate / "Cargo.toml", "[package]\nname = \"objc2\"\nversion = \"0.6.3\"\nlicense = \"MIT\"\n")
            write(crate / "LICENSE-MIT", "MIT objc2\n")
            output = root / "dist" / "macos" / NOTICES_FILE
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(notices.main([
                    "rust", "--strict", "--manifest-dir", str(project), "--output", str(output),
                    "--target", "x86_64-apple-darwin", "--target", "aarch64-apple-darwin",
                    "--cargo", MISSING_CARGO, "--cargo-home", str(root / "cargo-home"),
                ]), 0)
            text = output.read_text(encoding="utf-8")
            self.assertTrue(text.startswith(f"Third-party software notices: {notices.MACOS_PLAYER_LABEL}\n"), text[:200])
            self.assertIn("objc2@0.6.3 (MIT)", text)

    def test_repository_player_lists_its_third_party_crates(self) -> None:
        result = rust_notices(REPOSITORY / "player-desktop")
        names = {item.name for item in result.notices}
        self.assertTrue({"wry", "tao", "serde_json"} <= names, sorted(names))
        self.assertNotIn("auvra-player", names)
        self.assertNotIn("auvra-native", {item.name for item in rust_notices(REPOSITORY / "native").notices})


def staged_editor_inputs(root: Path) -> Path:
    write(root / "frontend" / NOTICES_FILE, staged_notices("Third-party software notices", "react@18.2.0 (MIT)",
                                                           "@babel/runtime@7.29.7 (MIT)"))
    write(root / "native" / NOTICES_FILE, staged_notices("Native crates", "wgpu@30.0.1 (MIT OR Apache-2.0)"))
    write(root / "game-player" / NOTICES_FILE, staged_notices("Player crates", "wry@0.57.1 (Apache-2.0 OR MIT)",
                                                              "tao@0.37.2 (Apache-2.0)"))
    dist_info = root / "python-site-packages" / "jsonschema-4.26.0.dist-info"
    write(dist_info / "METADATA", "Metadata-Version: 2.4\nName: jsonschema\nVersion: 4.26.0\n"
          "License-Expression: MIT\nLicense-File: COPYING\n")
    write(dist_info / "licenses" / "COPYING", "Copyright (c) 2013 Julian Berman\n")
    write(root / "python-embed" / "LICENSE.txt", "PSF LICENSE AGREEMENT FOR PYTHON\n")
    write(root / "webview2-sdk" / "LICENSE.txt", "Copyright (C) Microsoft Corporation.\n")
    write(root / "webview2-sdk" / "NOTICE.txt", "Third party notices for the SDK\n")
    write(root / "webview2-fixed" / "msedgewebview2.exe", b"MZ")
    return root


class EditorNoticesTests(unittest.TestCase):
    def test_composed_file_has_every_part_with_components(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = staged_editor_inputs(Path(temporary))
            text = editor_notices_from_inputs(root, PINS)
            self.assertEqual(verify_editor_notices(text),
                             {"frontend": 2, "python": 1, "native": 1, "player": 2, "runtimes": 3})
            titles = [title for _, title in EDITOR_PARTS]
            self.assertEqual([text.index(f"Part {index} of 5: {title}") for index, title in enumerate(titles, 1)],
                             sorted(text.index(f"Part {index} of 5: {title}") for index, title in enumerate(titles, 1)))
            self.assertIn("jsonschema@4.26.0 (MIT)", text)
            self.assertIn("--- licenses/COPYING ---", text)
            self.assertIn(f"CPython embeddable distribution@{PINS['pythonEmbed']['version']} (PSF-2.0)", text)
            self.assertIn("--- runtime/python/LICENSE.txt ---\n\nPSF LICENSE AGREEMENT FOR PYTHON", text)
            self.assertIn(f"Microsoft Edge WebView2 Runtime (Fixed Version)@{PINS['webview2Fixed']['version']}", text)
            self.assertIn("--- runtime/webview2-sdk/NOTICE.txt ---", text)
            self.assertNotIn(temporary, text)
            self.assertEqual(text, editor_notices_from_inputs(root, PINS))

    def test_platform_player_notices_join_the_player_part(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = staged_editor_inputs(Path(temporary))
            write(root / "game-player" / "linux-x64" / NOTICES_FILE,
                  staged_notices("Linux player crates", "webkit2gtk@2.0.2 (MIT)"))
            write(root / "game-player" / "macos" / NOTICES_FILE,
                  staged_notices("macOS player crates", "objc2-web-kit@0.3.2 (Zlib OR Apache-2.0 OR MIT)"))
            text = editor_notices_from_inputs(root, PINS)
            self.assertEqual(verify_editor_notices(text)["player"], 4)
            player_part = text[text.index(f"Part 4 of 5: {EDITOR_PARTS[3][1]}"):text.index("Part 5 of 5:")]
            self.assertLess(player_part.index("tao@0.37.2"), player_part.index("webkit2gtk@2.0.2"))
            self.assertLess(player_part.index("webkit2gtk@2.0.2"), player_part.index("objc2-web-kit@0.3.2"))
            (root / "game-player" / "macos" / NOTICES_FILE).unlink()
            with self.assertRaisesRegex(NoticesError, f"game-player/macos input is missing {NOTICES_FILE}"):
                editor_notices_from_inputs(root, PINS)

    def test_runtime_part_falls_back_to_references_without_staged_license_files(self) -> None:
        text = notices.render_runtime_document(notices.runtime_notices(PINS))
        self.assertEqual(count_components(text), 3)
        self.assertIn("https://docs.python.org/3/license.html", text)
        self.assertIn("https://www.nuget.org/packages/Microsoft.Web.WebView2/", text)
        self.assertIn("edge://credits", text)

    def test_missing_or_empty_staged_notices_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = staged_editor_inputs(Path(temporary))
            for directory in ("frontend", "native", "game-player"):
                path = root / directory / NOTICES_FILE
                original = path.read_bytes()
                path.unlink()
                with self.assertRaisesRegex(NoticesError, f"{directory} input is missing {NOTICES_FILE}"):
                    editor_notices_from_inputs(root, PINS)
                path.write_text("Notices without entries\n", encoding="utf-8")
                with self.assertRaisesRegex(NoticesError, "lists no components"):
                    editor_notices_from_inputs(root, PINS)
                path.write_bytes(original)
            for metadata in (root / "python-site-packages").glob("*.dist-info/METADATA"):
                metadata.unlink()
            with self.assertRaisesRegex(NoticesError, "dist-info"):
                editor_notices_from_inputs(root, PINS)

    def test_verification_rejects_trivial_incomplete_or_reordered_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            text = editor_notices_from_inputs(staged_editor_inputs(Path(temporary)), PINS)
        with self.assertRaisesRegex(NoticesError, "too small"):
            verify_editor_notices("Third-party notices\n")
        parts = {key: staged_notices(key, f"{key}-component@1.0.0 (MIT)") for key, _ in EDITOR_PARTS}
        self.assertEqual(set(verify_editor_notices(compose_editor_notices(parts)).values()), {1})
        without_python = compose_editor_notices({**parts, "python": "Python notices\n\n" + "x" * 4096})
        with self.assertRaisesRegex(NoticesError, "lists no components"):
            verify_editor_notices(without_python)
        title = EDITOR_PARTS[2][1]
        dropped = text.replace(f"Part 3 of 5: {title}", "Part 3 of 5: Something else")
        with self.assertRaisesRegex(NoticesError, "missing or out of order"):
            verify_editor_notices(dropped)


class ReleasePackageNoticesTests(unittest.TestCase):
    def staged(self, root: Path) -> Path:
        return release_fixtures.ReleasePipelineTests.staged_inputs(self, root)  # type: ignore[arg-type]

    def test_assembled_package_carries_root_and_player_notices(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged(root)
            output = root / "package"
            manifest = assemble(inputs, output, channel="dev", version="1.0.0")
            listed = {entry["path"] for entry in manifest["files"]}
            self.assertTrue({NOTICES_FILE, f"game-player/{NOTICES_FILE}"} <= listed)
            text = (output / NOTICES_FILE).read_text(encoding="utf-8")
            self.assertEqual(verify_editor_notices(text),
                             {"frontend": 1, "python": 1, "native": 1, "player": 1, "runtimes": 3})
            self.assertIn("react@18.2.0 (MIT)", text)
            self.assertIn("example-package@1.0.0 (MIT)", text)
            self.assertIn("wgpu@30.0.1 (MIT OR Apache-2.0)", text)
            self.assertIn("wry@0.57.1 (Apache-2.0 OR MIT)", text)
            self.assertEqual((output / "game-player" / NOTICES_FILE).read_bytes(),
                             (inputs / "game-player" / NOTICES_FILE).read_bytes())
            verify_package(output, expected_channel="dev")
            verify_installed_package(output)
            sbom = json.loads((output / "sbom.json").read_text(encoding="utf-8"))
            licenses = {item.get("purl"): item.get("licenses") for item in sbom["components"]}
            self.assertEqual(licenses["pkg:npm/react@18.2.0"], [{"license": {"name": "MIT"}}])
            self.assertEqual(licenses["pkg:cargo/wgpu@30.0.1"], [{"license": {"name": "MIT OR Apache-2.0"}}])
            self.assertEqual(licenses["pkg:pypi/example-package@1.0.0"], [{"license": {"name": "MIT"}}])
            self.assertTrue(any(purl.startswith("pkg:cargo/wry@") for purl in licenses if purl))

    def test_missing_staged_notices_fail_staging_and_assembly(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged(root)
            (inputs / "native" / NOTICES_FILE).unlink()
            with self.assertRaisesRegex(ReleaseError, f"native input is missing {NOTICES_FILE}"):
                write_input_inventory(inputs, root / "inventory.json")
            with self.assertRaisesRegex(ReleaseError, "third-party notices"):
                assemble(inputs, root / "package", channel="dev", version="1.0.0")
            self.assertFalse((root / "package").exists())

    def test_verify_package_requires_complete_notices(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = self.staged(root)
            with mock.patch.object(pipeline, "_editor_notices", return_value="Third-party notices\n"):
                assemble(inputs, root / "trivial", channel="dev", version="1.0.0")
            with self.assertRaisesRegex(ReleaseError, "notices are incomplete"):
                verify_package(root / "trivial")

            package = root / "package"
            assemble(inputs, package, channel="dev", version="1.0.0")
            manifest_path = package / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for relative, message in ((f"game-player/{NOTICES_FILE}", "game-player/THIRD_PARTY_NOTICES.txt"),
                                      (NOTICES_FILE, "missing from the package root")):
                manifest["files"] = [entry for entry in manifest["files"] if entry["path"] != relative]
                (package / relative).unlink()
                manifest_path.write_bytes(canonical_json(manifest))
                with self.assertRaisesRegex(ReleaseError, message):
                    verify_package(package)

    def test_enabled_release_package_has_complete_notices(self) -> None:
        """Opt-in check of the real CI package (set by the release-dev-msix job)."""
        raw_package = os.environ.get("AUVRA_RELEASE_PACKAGE_ROOT")
        if os.environ.get("AUVRA_RELEASE_SMOKE") != "1" or not raw_package:
            self.skipTest("set AUVRA_RELEASE_SMOKE=1 and AUVRA_RELEASE_PACKAGE_ROOT to check a real package")
        package = Path(raw_package)
        text = (package / NOTICES_FILE).read_text(encoding="utf-8")
        counts = verify_editor_notices(text)
        self.assertGreater(counts["frontend"], 10)
        self.assertGreater(counts["native"], 10)
        self.assertGreater(counts["player"], 10)
        self.assertGreater(len(text.encode("utf-8")), 100_000)
        for component in ("react@", "jsonschema@", "pythonnet@", "wgpu@", "winit@", "wry@", "tao@"):
            self.assertIn(f"\n{component}", text)
        self.assertNotIn("License text not available offline", text)
        self.assertIn("--- runtime/webview2-sdk/LICENSE.txt ---", text)
        player = (package / "game-player" / NOTICES_FILE).read_text(encoding="utf-8")
        self.assertIn("\nwry@", player)
        self.assertNotIn("License text not available offline", player)


if __name__ == "__main__":
    unittest.main()
