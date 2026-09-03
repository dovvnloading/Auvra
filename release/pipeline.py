"""Stdlib-only deterministic Windows package pipeline.

The pipeline intentionally does not download runtimes or dependencies.  A
release can only be assembled from a caller-provided, hash-recorded input
directory.  MakeAppx and SignTool are optional build-time Windows SDK tools;
they are never copied into the package and credentials are never read from the
environment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import struct
import sys
import tempfile
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zlib


ROOT = Path(__file__).resolve().parent
POLICY_PATH = ROOT / "policy.json"
FORBIDDEN_SUFFIXES = {".pfx", ".p12", ".pem", ".key", ".env"}
FORBIDDEN_CONTENT_SUFFIXES = {".map", ".log", ".dmp", ".dump", ".pdb", ".ilk", ".obj", ".lib", ".exp", ".pyc", ".pyproj", ".sln"}
FORBIDDEN_CONTENT_NAMES = {"vite.config.ts", "vite.config.js", "tsconfig.json", "cargo.toml", "cargo.lock", "pyproject.toml", "uv.lock", "package.json", "package-lock.json", "auvra.py", "auvra.pyproj", "bootstrap.py"}
SECRET_PATTERN = re.compile(
    rb"-----BEGIN [^-]*PRIVATE KEY-----"
    rb"|(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[\"'][A-Za-z0-9_./+=:-]{12,}[\"']"
    rb"|authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{16,}",
    re.IGNORECASE,
)
ABSOLUTE_PATH_PATTERN = re.compile(
    rb"(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/](?:Users|home|workspace|tmp|var)[\\/]"
    rb"|\\\\[A-Za-z0-9_.-]{2,}[\\/](?:Users|home|workspace|tmp|var)[\\/]"
    rb"|/(?:Users|home|workspace|tmp|var)/)",
    re.IGNORECASE,
)
PRIVATE_CONTENT_PATTERN = re.compile(
    rb"(?:private[ _-]*plan|do[ _-]*not[ _-]*share|internal[ _-]*roadmap)",
    re.IGNORECASE,
)
RUNTIME_CDN_PATTERN = re.compile(
    rb"https?://(?:cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|fonts\.googleapis\.com|fonts\.gstatic\.com)",
    re.IGNORECASE,
)
MSIX_CONTAINER_METADATA = {"AppxBlockMap.xml"}


class ReleaseError(RuntimeError):
    """A release input, package, or lifecycle invariant failed."""


def _read_policy() -> dict[str, Any]:
    value = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema") != 1:
        raise ReleaseError("release policy is invalid")
    matrix = value.get("supportMatrix")
    expected_matrix = {"windows": "Windows 11 24H2", "logicalCores": 4, "ramGiB": 8,
                       "freeSsdGiB": 10, "minimumDisplay": "1280x720",
                       "graphics": "DX12/WDDM2.0", "nativeFeatureLevel": "11_0",
                       "webglFallback": "WebGL2"}
    if matrix != expected_matrix:
        raise ReleaseError("release hardware support matrix is invalid")
    return value


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _is_reparse(path: Path) -> bool:
    try:
        return bool(path.stat().st_file_attributes & 0x40000000)
    except (AttributeError, OSError):
        return False


def _safe_manifest_path(value: str) -> str:
    path = Path(value)
    if not value or path.is_absolute() or "\\" in value or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ReleaseError(f"unsafe release manifest path: {value!r}")
    return path.as_posix()


def _assert_regular_tree(root: Path, *, label: str) -> list[Path]:
    if not root.is_dir() or root.is_symlink() or _is_reparse(root):
        raise ReleaseError(f"{label} input is missing or is not a directory: {root}")
    files: list[Path] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if path.is_symlink() or _is_reparse(path):
            raise ReleaseError(f"{label} input contains a symlink: {_relative(path, root)}")
        if path.is_file():
            files.append(path)
        elif not path.is_dir():
            raise ReleaseError(f"{label} input contains a non-regular entry: {_relative(path, root)}")
    if not files:
        raise ReleaseError(f"{label} input is empty")
    return files


def _assert_no_forbidden(path: str, policy: Mapping[str, Any]) -> None:
    lowered = path.lower()
    for fragment in policy["forbiddenPathFragments"]:
        if str(fragment).lower() in lowered:
            raise ReleaseError(f"forbidden development or secret path in release: {path}")
    if Path(path).suffix.lower() in FORBIDDEN_SUFFIXES:
        raise ReleaseError(f"forbidden secret file in release: {path}")


def _scan_release_content(root: Path, policy: Mapping[str, Any], *, include_manifest: bool = False) -> None:
    """Reject accidental developer artifacts and secret-like text."""

    def violation(data: bytes) -> bool:
        return bool(
            SECRET_PATTERN.search(data)
            or ABSOLUTE_PATH_PATTERN.search(data)
            or PRIVATE_CONTENT_PATTERN.search(data)
            or RUNTIME_CDN_PATTERN.search(data)
        )

    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if path.is_symlink() or _is_reparse(path):
            raise ReleaseError(f"release contains a link or reparse point: {_relative(path, root)}")
        if not path.is_file():
            continue
        relative = _relative(path, root)
        if not include_manifest and relative == "release-manifest.json":
            continue
        _assert_no_forbidden(relative, policy)
        lower_name = path.name.lower()
        if path.suffix.lower() in FORBIDDEN_CONTENT_SUFFIXES or lower_name in FORBIDDEN_CONTENT_NAMES:
            raise ReleaseError(f"development or diagnostic file is not releasable: {relative}")
        try:
            with path.open("rb") as stream:
                sample = stream.read(4096)
                rolling = sample
                normalized = sample.replace(b"\x00", b"")
                if violation(rolling) or violation(normalized):
                    raise ReleaseError(f"secret-like or private content in release: {relative}")
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    rolling = (rolling + chunk)[-1024 * 1024:]
                    normalized = (normalized + chunk.replace(b"\x00", b""))[-1024 * 1024:]
                    if violation(rolling) or violation(normalized):
                        raise ReleaseError(f"secret-like or private content in release: {relative}")
                if violation(rolling) or violation(normalized):
                    raise ReleaseError(f"secret-like or private content in release: {relative}")
        except OSError as exc:
            raise ReleaseError(f"release content could not be scanned: {relative}") from exc


def _input_inventory(input_root: Path, policy: Mapping[str, Any]) -> dict[str, Any]:
    if not input_root.is_dir():
        raise ReleaseError(f"staged input root does not exist: {input_root}")
    inventory: dict[str, Any] = {"schema": 1, "platform": policy["platform"], "inputs": {}}
    required = [str(item) for item in policy["requiredInputs"]]
    for name in required:
        source = input_root / name
        files = _assert_regular_tree(source, label=name)
        entries = []
        for path in files:
            relative = _relative(path, source)
            _assert_no_forbidden(f"{name}/{relative}", policy)
            entries.append({"path": relative, "size": path.stat().st_size, "sha256": sha256(path)})
        inventory["inputs"][name] = entries
    return inventory


def _validate_runtime_pin_markers(input_root: Path, policy: Mapping[str, Any]) -> None:
    """Require acquisition attestations for extracted third-party runtimes."""

    pins = policy.get("runtimePins")
    if not isinstance(pins, Mapping):
        raise ReleaseError("runtime pin policy is missing")
    for directory, pin_name in (("python-embed", "pythonEmbed"), ("webview2-fixed", "webview2Fixed")):
        marker = input_root / directory / "Auvra.runtime-pin.json"
        try:
            value = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReleaseError(f"{directory} is missing its verified runtime pin marker") from exc
        expected = pins.get(pin_name)
        if not isinstance(value, dict) or value.get("schema") != 1 or value.get("kind") != pin_name or not isinstance(expected, Mapping):
            raise ReleaseError(f"{directory} runtime pin marker is invalid")
        marker_hash = value.get("sha256")
        if (value.get("version") != expected.get("version") or not isinstance(marker_hash, str)
                or marker_hash.lower() != str(expected.get("sha256", "")).lower()):
            raise ReleaseError(f"{directory} runtime pin does not match release policy")
        attested = value.get("files")
        if not isinstance(attested, list):
            raise ReleaseError(f"{directory} runtime pin is missing its extracted-file attestation")
        expected_files: list[dict[str, Any]] = []
        runtime_root = input_root / directory
        marker_relative = "Auvra.runtime-pin.json"
        for path in sorted(runtime_root.rglob("*"), key=lambda item: item.as_posix().lower()):
            if path.is_symlink() or _is_reparse(path):
                raise ReleaseError(f"{directory} runtime contains a link or reparse point")
            if not path.is_file():
                continue
            relative = _relative(path, runtime_root)
            if relative == marker_relative:
                continue
            expected_files.append({
                "path": relative,
                "size": path.stat().st_size,
                "sha256": sha256(path),
            })
        normalized_attestation: list[dict[str, Any]] = []
        for entry in attested:
            if not isinstance(entry, Mapping) or not isinstance(entry.get("path"), str):
                raise ReleaseError(f"{directory} runtime pin file attestation is invalid")
            relative = _safe_manifest_path(entry["path"])
            if relative == marker_relative or not isinstance(entry.get("size"), int) or entry["size"] < 0:
                raise ReleaseError(f"{directory} runtime pin file attestation is invalid")
            digest = entry.get("sha256")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
                raise ReleaseError(f"{directory} runtime pin file attestation is invalid")
            normalized_attestation.append({
                "path": relative,
                "size": entry["size"],
                "sha256": digest.lower(),
            })
        normalized_attestation.sort(key=lambda entry: entry["path"].lower())
        if normalized_attestation != expected_files:
            raise ReleaseError(f"{directory} extracted runtime contents do not match its attestation")
    sdk_marker = input_root / "webview2-sdk" / ".auvra-sdk.sha256"
    expected_sdk = pins.get("webview2Sdk")
    try:
        first_line = sdk_marker.read_text(encoding="ascii").splitlines()[0].strip().lower()
    except (OSError, UnicodeDecodeError, IndexError) as exc:
        raise ReleaseError("webview2-sdk is missing its verified SDK hash marker") from exc
    if not isinstance(expected_sdk, Mapping) or first_line != str(expected_sdk.get("sha256", "")).lower():
        raise ReleaseError("webview2-sdk hash marker does not match release policy")


def _manifest_files(manifest: Mapping[str, Any], policy: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise ReleaseError("release manifest file list is invalid")
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ReleaseError("release manifest file entry is invalid")
        relative = _safe_manifest_path(entry.get("path", "")) if isinstance(entry.get("path"), str) else ""
        if not relative or relative == "release-manifest.json" or relative in result:
            raise ReleaseError("release manifest contains duplicate or unsafe paths")
        if not isinstance(entry.get("size"), int) or entry["size"] < 0 or not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-fA-F]{64}", entry["sha256"]):
            raise ReleaseError(f"release manifest digest entry is invalid: {relative}")
        _assert_no_forbidden(relative, policy)
        result[relative] = {"path": relative, "size": entry["size"], "sha256": entry["sha256"].lower()}
    return result


def write_input_inventory(input_root: Path, output: Path) -> dict[str, Any]:
    policy = _read_policy()
    inventory = _input_inventory(input_root.resolve(), policy)
    _validate_runtime_pin_markers(input_root.resolve(), policy)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_json(inventory))
    return inventory


def _version_parts(version: str) -> tuple[int, int, int, int]:
    values = version.split(".")
    if len(values) == 3:
        values.append("0")
    if len(values) != 4 or any(not item.isdigit() for item in values):
        raise ReleaseError("version must contain three or four numeric components")
    result = tuple(int(item) for item in values)
    if any(item < 0 or item > 65535 for item in result):
        raise ReleaseError("version components must be between 0 and 65535")
    return result  # type: ignore[return-value]


def _copy_tree(source: Path, destination: Path, *, policy: Mapping[str, Any], label: str) -> None:
    for path in _assert_regular_tree(source, label=label):
        relative = _relative(path, source)
        _assert_no_forbidden(f"{label}/{relative}", policy)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)


def _copy_required_file(source_dir: Path, destination: Path, *, label: str, suffix: str | None = None) -> None:
    files = _assert_regular_tree(source_dir, label=label)
    candidates = [path for path in files if suffix is None or path.name.lower() == suffix.lower()]
    if len(candidates) != 1:
        expected = suffix or "one file"
        raise ReleaseError(f"{label} must contain exactly one {expected}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(candidates[0], destination)


def _manifest_xml(identity: str, publisher: str, version: tuple[int, int, int, int]) -> bytes:
    ns = "http://schemas.microsoft.com/appx/manifest/foundation/windows10"
    uap = "http://schemas.microsoft.com/appx/manifest/uap/windows10"
    rescap = "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
    ET.register_namespace("", ns)
    ET.register_namespace("uap", uap)
    ET.register_namespace("rescap", rescap)
    package = ET.Element(f"{{{ns}}}Package", IgnorableNamespaces="uap rescap")
    ET.SubElement(package, f"{{{ns}}}Identity", Name=identity, Publisher=publisher,
                  Version=".".join(str(item) for item in version), ProcessorArchitecture="x64")
    props = ET.SubElement(package, f"{{{ns}}}Properties")
    ET.SubElement(props, f"{{{ns}}}DisplayName").text = "Auvra"
    ET.SubElement(props, f"{{{ns}}}PublisherDisplayName").text = "Auvra"
    ET.SubElement(props, f"{{{ns}}}Logo").text = "Assets/logo.png"
    resources = ET.SubElement(package, f"{{{ns}}}Resources")
    ET.SubElement(resources, f"{{{ns}}}Resource", Language="en-us")
    dependencies = ET.SubElement(package, f"{{{ns}}}Dependencies")
    ET.SubElement(dependencies, f"{{{ns}}}TargetDeviceFamily", Name="Windows.Desktop",
                  MinVersion="10.0.26100.0", MaxVersionTested="10.0.26100.0")
    apps = ET.SubElement(package, f"{{{ns}}}Applications")
    app = ET.SubElement(apps, f"{{{ns}}}Application", Id="Auvra", Executable="runtime/python/pythonw.exe",
                        EntryPoint="Windows.FullTrustApplication")
    ET.SubElement(app, f"{{{uap}}}VisualElements", DisplayName="Auvra", Description="Auvra game engine",
                  BackgroundColor="#101820", Square150x150Logo="Assets/logo_150.png", Square44x44Logo="Assets/logo_44.png")
    capabilities = ET.SubElement(package, f"{{{ns}}}Capabilities")
    ET.SubElement(capabilities, f"{{{rescap}}}Capability", Name="runFullTrust")
    return ET.tostring(package, encoding="utf-8", xml_declaration=True)


def _write_png(path: Path, width: int, height: int) -> None:
    """Write a deterministic neutral RGBA tile without an asset dependency."""

    row = b"\x00" + bytes((16, 24, 32, 255)) * width
    raw = row * height

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def _write_sbom(output_root: Path, inventory: Mapping[str, Any], policy: Mapping[str, Any]) -> None:
    pins = policy["runtimePins"]
    components = [
        {"type": "application", "name": "Auvra", "version": "release"},
        {"type": "framework", "name": "CPython embeddable", "version": pins["pythonEmbed"]["version"], "licenses": ["Python-2.0"]},
        {"type": "library", "name": "Microsoft.Web.WebView2 SDK", "version": pins["webview2Sdk"]["version"], "licenses": ["Microsoft-WebView2-SDK"]},
        {"type": "framework", "name": "Microsoft WebView2 Fixed Runtime", "version": pins["webview2Fixed"]["version"], "licenses": ["Microsoft-WebView2-Runtime"]},
    ]
    artifacts = []
    for entry in inventory["inputs"].get("python-site-packages", []):
        artifacts.append({"path": "runtime/python/Lib/site-packages/" + entry["path"], "sha256": entry["sha256"]})
    license_files = [{"path": "licenses/" + entry["path"], "sha256": entry["sha256"]}
                     for entry in inventory["inputs"].get("licenses", [])]
    sbom = {"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
            "components": components, "artifacts": artifacts, "licenseFiles": license_files}
    (output_root / "sbom.json").write_bytes(canonical_json(sbom))


def _appinstaller(identity: str, publisher: str, version: tuple[int, int, int, int], uri: str, updates: bool) -> bytes:
    ns = "http://schemas.microsoft.com/appx/appinstaller/2021"
    ET.register_namespace("", ns)
    root = ET.Element(f"{{{ns}}}AppInstaller", Version=".".join(str(item) for item in version), Uri=uri)
    msix_uri = uri[:-len(".appinstaller")] + ".msix" if uri.lower().endswith(".appinstaller") else uri + ".msix"
    ET.SubElement(root, f"{{{ns}}}MainPackage", Name=identity, Publisher=publisher,
                  Version=".".join(str(item) for item in version), Uri=msix_uri,
                  ProcessorArchitecture="x64")
    settings = ET.SubElement(root, f"{{{ns}}}UpdateSettings")
    on_launch = ET.SubElement(settings, f"{{{ns}}}OnLaunch", HoursBetweenUpdateChecks="24",
                              ShowPrompt="true", UpdateBlocksActivation="false")
    _ = on_launch
    ET.SubElement(settings, f"{{{ns}}}ForceUpdateFromAnyVersion").text = "true" if updates else "false"
    if not updates:
        settings.remove(on_launch)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _validate_appinstaller(data: bytes, *, hosted: bool) -> None:
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ReleaseError("App Installer metadata is not valid XML") from exc
    force = next((node for node in root.iter() if node.tag.endswith("ForceUpdateFromAnyVersion")), None)
    launch = next((node for node in root.iter() if node.tag.endswith("OnLaunch")), None)
    if force is None or force.text != ("true" if hosted else "false") or (hosted and launch is None) or (not hosted and launch is not None):
        raise ReleaseError("App Installer rollback/update metadata is invalid")


def _write_packaged_startup(output_root: Path, channel: str) -> None:
    """Install a Python-embeddable startup contract in the package.

    The MSIX entrypoint is the verified ``pythonw.exe`` from the embeddable
    input.  Its pinned ``python314._pth`` imports ``sitecustomize``; that file invokes
    the generated host startup script, which verifies the immutable package
    before importing the app.  No shell, uv, Node, or ambient runtime is
    involved in this path.
    """

    python_root = output_root / "runtime" / "python"
    pythonw = python_root / "pythonw.exe"
    if not pythonw.is_file():
        raise ReleaseError("python-embed input must contain pythonw.exe")
    host_root = output_root / "host"
    startup = host_root / "auvra_startup.py"
    startup.write_text((
        """from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'host'))
from auvra_release_verify import verify_installed_package
verify_installed_package(ROOT)
if os.environ.get('AUVRA_RELEASE_NON_UI_SMOKE') == '1':
    raise SystemExit(0)
from Auvra.launcher.config import Paths
from Auvra.launcher.cli import main, run_start
paths = Paths.from_packaged_root(ROOT / 'frontend', 'CHANNEL')
if sys.argv[1:]:
    if sys.argv[1] != 'support':
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1:], paths=paths))
raise SystemExit(run_start(paths, explicit_port=None, json_mode=False, packaged_root=ROOT / 'frontend'))
""".replace("'CHANNEL'", repr(channel))
        ),
        encoding="utf-8",
        newline="\n",
    )
    (python_root / "sitecustomize.py").write_text(
        """from pathlib import Path
import os
import runpy
try:
    runpy.run_path(str(Path(__file__).resolve().parents[2] / 'host' / 'auvra_startup.py'), run_name='__main__')
except SystemExit as exc:
    code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    os._exit(code)
os._exit(0)
""",
        encoding="utf-8",
        newline="\n",
    )
    zip_names = sorted(path.name for path in python_root.glob("*.zip") if path.is_file())
    pth_lines = [*zip_names, ".", "Lib", "Lib/site-packages", "../../host", "import site"]
    (python_root / "python314._pth").write_text("\n".join(pth_lines) + "\n", encoding="utf-8", newline="\n")


def normalize_staging_metadata(package_root: Path) -> None:
    """Normalize timestamps so unsigned staging has reproducible metadata."""

    # 1980-01-01 is representable by FAT/ZIP metadata and Windows filesystems.
    fixed_timestamp = 315532800
    paths = sorted(package_root.rglob("*"), key=lambda item: item.as_posix().lower(), reverse=True)
    paths.append(package_root)
    for path in paths:
        if path.is_symlink():
            raise ReleaseError(f"cannot normalize a symlink: {_relative(path, package_root)}")
        try:
            # Links were rejected above; the Windows Python build does not
            # expose the follow_symlinks keyword for utime.
            os.utime(path, (fixed_timestamp, fixed_timestamp))
        except OSError as exc:
            raise ReleaseError(f"cannot normalize staging metadata: {path}") from exc


def _assemble_into(input_root: Path, output_root: Path, *, channel: str, version: str,
                   appinstaller_uri: str | None = None) -> dict[str, Any]:
    policy = _read_policy()
    if channel not in policy["channels"]:
        raise ReleaseError(f"unknown release channel: {channel}")
    if channel == "dev" and appinstaller_uri is not None:
        raise ReleaseError("dev releases cannot publish App Installer metadata")
    version_parts = _version_parts(version)
    input_root = input_root.resolve()
    inventory = _input_inventory(input_root, policy)
    _validate_runtime_pin_markers(input_root, policy)
    if output_root.exists() and (output_root.is_symlink() or not output_root.is_dir()):
        raise ReleaseError("package output is not a regular directory")
    output_root.mkdir(parents=True, exist_ok=True)
    channel_policy = policy["channels"][channel]
    _copy_tree(input_root / "frontend", output_root / "frontend", policy=policy, label="frontend")
    _copy_tree(input_root / "python-embed", output_root / "runtime" / "python", policy=policy, label="python-embed")
    _copy_tree(input_root / "python-site-packages", output_root / "runtime" / "python" / "Lib" / "site-packages", policy=policy, label="python-site-packages")
    _copy_tree(input_root / "webview2-sdk", output_root / "runtime" / "webview2-sdk", policy=policy, label="webview2-sdk")
    _copy_tree(input_root / "webview2-fixed", output_root / "runtime" / "webview2", policy=policy, label="webview2-fixed")
    _copy_tree(input_root / "host", output_root / "host", policy=policy, label="host")
    _copy_tree(input_root / "licenses", output_root / "licenses", policy=policy, label="licenses")
    _copy_required_file(input_root / "native", output_root / "native" / "auvra-native.exe", label="native", suffix="auvra-native.exe")
    if not (output_root / "host" / "Auvra").is_dir():
        raise ReleaseError("host input must contain the importable Auvra application package")
    _write_packaged_startup(output_root, channel)
    shutil.copyfile(ROOT / "runtime_verify.py", output_root / "host" / "auvra_release_verify.py")
    assets = output_root / "Assets"
    assets.mkdir()
    _write_png(assets / "logo_44.png", 44, 44)
    _write_png(assets / "logo_150.png", 150, 150)
    _write_png(assets / "logo.png", 256, 256)
    _write_sbom(output_root, inventory, policy)
    manifest = _manifest_xml(channel_policy["identity"], channel_policy["publisher"], version_parts)
    (output_root / "AppxManifest.xml").write_bytes(manifest)
    companion: dict[str, Any] | None = None
    if appinstaller_uri:
        uri = appinstaller_uri.replace("{channel}", channel).replace("{version}", ".".join(str(item) for item in version_parts))
        companion_path = output_root.parent / f"{channel_policy['identity']}.appinstaller"
        companion_bytes = _appinstaller(channel_policy["identity"], channel_policy["publisher"], version_parts, uri, bool(channel_policy["updates"]))
        _validate_appinstaller(companion_bytes, hosted=bool(channel_policy["updates"]))
        companion = {"path": companion_path.name, "sha256": hashlib.sha256(companion_bytes).hexdigest()}
    _scan_release_content(output_root, policy)
    release_manifest: dict[str, Any] = {
        "schema": 1, "product": policy["product"], "channel": channel,
        "identity": channel_policy["identity"], "publisher": channel_policy["publisher"],
        "platform": policy["platform"], "version": ".".join(str(item) for item in version_parts),
        "minimumWindowsBuild": policy["minimumWindowsBuild"], "inputs": inventory["inputs"],
        "files": []
    }
    if companion is not None:
        release_manifest["appinstaller"] = companion
    for path in sorted(output_root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if path.is_file():
            relative = _relative(path, output_root)
            _assert_no_forbidden(relative, policy)
            release_manifest["files"].append({"path": relative, "size": path.stat().st_size, "sha256": sha256(path)})
    (output_root / "release-manifest.json").write_bytes(canonical_json(release_manifest))
    normalize_staging_metadata(output_root)
    return release_manifest


def assemble(input_root: Path, output_root: Path, *, channel: str, version: str,
             appinstaller_uri: str | None = None) -> dict[str, Any]:
    """Assemble to a same-volume temporary sibling, then publish atomically."""

    destination = Path(output_root).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir() or any(destination.iterdir()):
            raise ReleaseError("package output must be an empty regular directory")
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.release-", dir=destination.parent))
    published = False
    try:
        manifest = _assemble_into(input_root, temporary, channel=channel, version=version, appinstaller_uri=appinstaller_uri)
        if destination.exists():
            destination.rmdir()
        os.replace(temporary, destination)
        published = True
        if appinstaller_uri:
            policy = _read_policy()
            channel_policy = policy["channels"][channel]
            uri = appinstaller_uri.replace("{channel}", channel).replace("{version}", manifest["version"])
            companion_bytes = _appinstaller(channel_policy["identity"], channel_policy["publisher"], _version_parts(manifest["version"]), uri, bool(channel_policy["updates"]))
            _validate_appinstaller(companion_bytes, hosted=bool(channel_policy["updates"]))
            (destination.parent / f"{channel_policy['identity']}.appinstaller").write_bytes(companion_bytes)
        return manifest
    finally:
        if not published and temporary.exists():
            shutil.rmtree(temporary)


def verify_package(package_root: Path, *, expected_channel: str | None = None) -> dict[str, Any]:
    policy = _read_policy()
    root = package_root.resolve()
    if not root.is_dir() or root.is_symlink() or _is_reparse(root):
        raise ReleaseError("package root is missing or unsafe")
    manifest_path = root / "release-manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise ReleaseError("release-manifest.json is missing")
    manifest_raw = manifest_path.read_bytes()
    manifest = json.loads(manifest_raw.decode("utf-8"))
    if not isinstance(manifest, dict) or manifest.get("schema") != 1:
        raise ReleaseError("release manifest is invalid")
    if manifest_raw != canonical_json(manifest):
        raise ReleaseError("release manifest is not canonical")
    channel = manifest.get("channel")
    if expected_channel is not None and channel != expected_channel:
        raise ReleaseError("release channel does not match expected channel")
    if channel not in policy["channels"]:
        raise ReleaseError("release channel is not allowed")
    channel_policy = policy["channels"][channel]
    if manifest.get("identity") != channel_policy["identity"] or manifest.get("publisher") != channel_policy["publisher"]:
        raise ReleaseError("release package identity or publisher is invalid")
    expected = _manifest_files(manifest, policy)
    _scan_release_content(root, policy)
    actual: dict[str, dict[str, Any]] = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ReleaseError(f"package contains a symlink: {_relative(path, root)}")
        if path.is_file():
            relative = _relative(path, root)
            _assert_no_forbidden(relative, policy)
            # The manifest describes its payload; including its own digest
            # would create a circular value.  Its canonical bytes are checked
            # separately by the parser and package signature.
            if relative != "release-manifest.json" and relative not in MSIX_CONTAINER_METADATA:
                actual[relative] = {"path": relative, "size": path.stat().st_size, "sha256": sha256(path)}
    if expected != actual:
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        changed = sorted(path for path in set(expected) & set(actual) if expected[path] != actual[path])
        raise ReleaseError(f"package integrity mismatch (missing={missing}, extra={extra}, changed={changed})")
    if (not (root / "AppxManifest.xml").is_file() or not (root / "sbom.json").is_file()
            or not (root / "runtime" / "python" / "pythonw.exe").is_file()):
        raise ReleaseError("package launch manifest or embedded Python entrypoint is missing")
    if not (root / "runtime" / "webview2").is_dir() or not (root / "runtime" / "webview2-sdk").is_dir():
        raise ReleaseError("fixed WebView2 Runtime or managed SDK is missing from package")
    if not (root / "native" / "auvra-native.exe").is_file():
        raise ReleaseError("native engine is missing from package")
    return manifest


def make_msix(package_root: Path, output: Path, *, makeappx: str | None = None) -> Path:
    normalize_staging_metadata(package_root)
    tool = makeappx or os.environ.get("AUVRA_MAKEAPPX") or shutil.which("MakeAppx.exe")
    if not tool:
        raise ReleaseError("MakeAppx.exe is required; set AUVRA_MAKEAPPX or install the Windows SDK")
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [tool, "pack", "/o", "/d", str(package_root), "/p", str(output)]
    result = subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise ReleaseError(f"MakeAppx failed with status {result.returncode}: {result.stderr[-1000:]}")
    if not output.is_file():
        raise ReleaseError("MakeAppx reported success without producing a package")
    return output


DEFAULT_TIMESTAMP_URL = "https://timestamp.digicert.com"


def _validate_timestamp_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ReleaseError("timestamp URL must be an HTTPS origin without credentials")
    return value


def sign_msix(
    package: Path,
    *,
    signtool: str | None,
    certificate: Path | None = None,
    thumbprint: str | None = None,
    timestamp_url: str = DEFAULT_TIMESTAMP_URL,
) -> None:
    if certificate is None and thumbprint is None:
        raise ReleaseError("a certificate file or certificate-store thumbprint is required")
    if certificate is not None and thumbprint is not None:
        raise ReleaseError("certificate file and certificate-store thumbprint are mutually exclusive")
    if certificate is not None and (not certificate.is_file() or certificate.suffix.lower() not in {".pfx", ".p12"}):
        raise ReleaseError("signing certificate must be an existing PFX/P12 file")
    if thumbprint is not None and not re.fullmatch(r"[0-9a-fA-F]{40}", thumbprint):
        raise ReleaseError("certificate-store thumbprint must be 40 hexadecimal characters")
    if not package.is_file() or package.suffix.lower() != ".msix":
        raise ReleaseError("package to sign must be an existing MSIX file")
    timestamp_url = _validate_timestamp_url(timestamp_url)
    tool = signtool or os.environ.get("AUVRA_SIGNTOOL") or shutil.which("SignTool.exe")
    if not tool:
        raise ReleaseError("SignTool.exe is required; set AUVRA_SIGNTOOL or install the Windows SDK")
    command = [tool, "sign", "/fd", "SHA256", "/tr", timestamp_url, "/td", "SHA256"]
    if certificate is not None:
        command.extend(["/f", str(certificate)])
    else:
        command.extend(["/sha1", thumbprint])
    command.append(str(package))
    result = subprocess.run(command, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise ReleaseError(f"SignTool failed with status {result.returncode}: {result.stderr[-1000:]}")
    verify = subprocess.run(
        [tool, "verify", "/pa", "/all", "/q", str(package)],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if verify.returncode:
        raise ReleaseError(f"SignTool verification failed with status {verify.returncode}: {verify.stderr[-1000:]}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="release.pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    inv = sub.add_parser("inventory")
    inv.add_argument("--input-root", type=Path, required=True)
    inv.add_argument("--output", type=Path, required=True)
    assemble_parser = sub.add_parser("assemble")
    assemble_parser.add_argument("--input-root", type=Path, required=True)
    assemble_parser.add_argument("--output", type=Path, required=True)
    assemble_parser.add_argument("--channel", choices=("stable", "beta", "dev"), required=True)
    assemble_parser.add_argument("--version", required=True)
    assemble_parser.add_argument("--appinstaller-uri")
    package = sub.add_parser("package")
    package.add_argument("--staging", type=Path, required=True)
    package.add_argument("--output", type=Path, required=True)
    package.add_argument("--makeappx")
    verify = sub.add_parser("verify")
    verify.add_argument("--package-root", type=Path, required=True)
    verify.add_argument("--channel")
    sign = sub.add_parser("sign")
    sign.add_argument("--package", type=Path, required=True)
    certificate = sign.add_mutually_exclusive_group(required=True)
    certificate.add_argument("--certificate", type=Path)
    certificate.add_argument("--thumbprint")
    sign.add_argument("--signtool")
    sign.add_argument("--timestamp-url", default=DEFAULT_TIMESTAMP_URL)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "inventory":
            write_input_inventory(args.input_root, args.output)
        elif args.command == "assemble":
            assemble(args.input_root, args.output, channel=args.channel, version=args.version, appinstaller_uri=args.appinstaller_uri)
        elif args.command == "package":
            verify_package(args.staging)
            make_msix(args.staging, args.output, makeappx=args.makeappx)
        elif args.command == "verify":
            verify_package(args.package_root, expected_channel=args.channel)
        else:
            sign_msix(args.package, signtool=args.signtool, certificate=args.certificate,
                      thumbprint=args.thumbprint, timestamp_url=args.timestamp_url)
    except (OSError, ValueError, ReleaseError, json.JSONDecodeError) as exc:
        print(f"release pipeline failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
