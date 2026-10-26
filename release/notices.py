"""Third-party license notices for the Windows editor package and exported games.

The editor package bundles the frontend build, the Python host with its
site-packages, the native engine, the Windows game player, an embeddable
CPython and the Microsoft WebView2 runtime and SDK.  This module renders the
package-root ``THIRD_PARTY_NOTICES.txt`` that covers all of it:

* frontend npm packages: the ``THIRD_PARTY_NOTICES.txt`` that
  ``fbx-viewer (1)/scripts/licenses/notices.mjs`` emits into every Vite build;
* Python packages: the license files recorded in each ``*.dist-info``;
* Rust crates of ``native`` and ``player-desktop``: resolved for the Windows
  target with ``cargo metadata --offline`` (falling back to ``Cargo.lock``),
  with the license files of each crate's source taken from the local cargo
  registry, its download cache or a vendor directory.  A crate whose source is
  not available offline is listed with its declared license and crates.io URL
  and says so;
* CPython and WebView2: license references plus the license files the staged
  runtimes ship.

The Rust notices are written next to each binary at staging time (see
``stage_inputs.ps1``); the editor file is composed from staged inputs only, so
assembly stays deterministic.  Stdlib only; nothing here uses the network.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from email.parser import HeaderParser
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import textwrap
import tomllib
from typing import Any, Iterable, Mapping


NOTICES_FILE = "THIRD_PARTY_NOTICES.txt"
WINDOWS_TARGET = "x86_64-pc-windows-msvc"
CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"
RULE = "=" * 78
PART_RULE = "#" * 78
MIN_EDITOR_NOTICES_BYTES = 2048
REPOSITORY = Path(__file__).resolve().parent.parent
POLICY_PATH = Path(__file__).resolve().parent / "policy.json"
FRONTEND_ROOT = REPOSITORY / "fbx-viewer (1)"
FRONTEND_COLLECTOR = FRONTEND_ROOT / "scripts" / "licenses" / "notices.mjs"
NATIVE_LABEL = "the Auvra native engine (native/auvra-native.exe)"
PLAYER_LABEL = ("the Auvra Windows game player (game-player/auvra-player.exe, "
                "shipped in exported Windows games as <Game Name>.exe)")
DEFAULT_LABELS = {"native": NATIVE_LABEL, "player-desktop": PLAYER_LABEL}

# The package-root notices file has these parts, in this order.
EDITOR_PARTS: tuple[tuple[str, str], ...] = (
    ("frontend", "Frontend npm production packages (frontend/)"),
    ("python", "Python packages bundled with the host (runtime/python/Lib/site-packages/)"),
    ("native", "Rust crates in the native engine (native/auvra-native.exe)"),
    ("player", "Rust crates in the Windows game player (game-player/auvra-player.exe)"),
    ("runtimes", "Bundled runtimes: CPython and Microsoft WebView2 (runtime/)"),
)

_LICENSE_NAME = re.compile(r"^(?:licen[cs]e|copying|notice|unlicense|copyright)", re.IGNORECASE)
_LICENSE_DIRECTORIES = {"license", "licenses"}
_NON_TEXT_SUFFIXES = {".spdx", ".rs", ".toml", ".json", ".html", ".htm", ".py", ".sh", ".yml", ".yaml", ".png", ".svg"}
# The release content scan rejects runtime CDN URLs in shipped text; notices
# only need to name them, so the scheme is dropped (as notices.mjs does).
_CDN_URL = re.compile(r"https?://(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|fonts\.googleapis\.com|fonts\.gstatic\.com)",
                      re.IGNORECASE)
_COMPONENT_HEADING = re.compile(rf"^{RULE}\n(?P<title>[^\n]+)\n{RULE}$", re.MULTILINE)
_COMPONENT_TITLE = re.compile(r"^(?P<name>.+)@(?P<version>[^@\s()]+) \((?P<license>.*)\)$")
_PART_HEADING = re.compile(rf"^{PART_RULE}\nPart (?P<index>\d+) of (?P<total>\d+): (?P<title>[^\n]+)\n{PART_RULE}$",
                           re.MULTILINE)
_PROJECT_URL_LABELS = ("source", "sources", "source code", "repository", "code", "github", "homepage", "home")


class NoticesError(RuntimeError):
    """Notices could not be collected, or a notices file is incomplete."""


@dataclass(frozen=True)
class Notice:
    """One third-party component and the license texts it ships."""

    name: str
    version: str
    license: str
    details: tuple[str, ...] = ()
    texts: tuple[tuple[str, str], ...] = ()
    fallback: str = ""

    @property
    def title(self) -> str:
        return f"{self.name}@{self.version} ({self.license})"

    def render(self) -> str:
        blocks: list[str] = []
        if self.details:
            blocks.append("\n".join(self.details))
        if self.texts:
            blocks.extend(f"--- {label} ---\n\n{text}" for label, text in self.texts)
        else:
            blocks.append(self.fallback or f"(No license file shipped; declared license: {self.license})")
        return f"{RULE}\n{self.title}\n{RULE}\n\n" + "\n\n".join(blocks) + "\n"


@dataclass(frozen=True)
class RustNotices:
    """The shipped crates of one cargo project."""

    notices: tuple[Notice, ...]
    resolver: str
    target: str
    unavailable: tuple[str, ...]


@dataclass(frozen=True)
class _Crate:
    name: str
    version: str
    source: str | None
    directory: Path | None = None
    license: str | None = None
    license_file: str | None = None
    repository: str | None = None
    from_metadata: bool = False


# ---------------------------------------------------------------------------
# Text helpers


def _paragraph(text: str) -> str:
    return textwrap.fill(" ".join(text.split()), width=78, break_long_words=False, break_on_hyphens=False)


def _read_text(data: bytes) -> str:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in text.split("\n")).strip("\n")


def sanitize(text: str) -> str:
    """Normalise newlines, drop CDN URL schemes and end with one newline."""

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return _CDN_URL.sub(r"\1", text).rstrip("\n") + "\n"


def render_document(title: str, introduction: str, notices: Iterable[Notice]) -> str:
    sections = [notice.render() for notice in notices]
    return sanitize(f"{title}\n\n{_paragraph(introduction)}\n\n" + "\n".join(sections))


def _is_license_file(name: str) -> bool:
    return bool(_LICENSE_NAME.match(name)) and PurePosixPath(name).suffix.lower() not in _NON_TEXT_SUFFIXES


def _contained(root: Path, relative: str) -> Path | None:
    normalized = posixpath.normpath(relative.replace("\\", "/"))
    if not normalized or normalized.startswith(("/", "../")) or normalized == ".." or ":" in normalized:
        return None
    return root.joinpath(*normalized.split("/"))


def count_components(text: str) -> int:
    """Number of ``name@version (license)`` component entries in ``text``."""

    return sum(1 for match in _COMPONENT_HEADING.finditer(text) if _COMPONENT_TITLE.match(match.group("title")))


def component_licenses(text: str) -> dict[tuple[str, str], str]:
    """Map ``(name, version)`` to the declared license of each entry."""

    result: dict[tuple[str, str], str] = {}
    for match in _COMPONENT_HEADING.finditer(text):
        title = _COMPONENT_TITLE.match(match.group("title"))
        if title:
            result[(title.group("name"), title.group("version"))] = title.group("license")
    return result


# ---------------------------------------------------------------------------
# Python packages


def _python_license(headers: Any) -> str:
    expression = str(headers.get("License-Expression") or "").strip()
    if expression:
        return expression
    declared = str(headers.get("License") or "").strip()
    if declared and "\n" not in declared and len(declared) <= 100 and declared.upper() != "UNKNOWN":
        return declared
    classifiers = [str(value).split("::")[-1].strip() for value in headers.get_all("Classifier") or []
                   if str(value).startswith("License ::")]
    classifiers = [value for value in classifiers if value and value != "OSI Approved"]
    if classifiers:
        return " / ".join(dict.fromkeys(classifiers))
    return "license not declared in metadata"


def _python_project_url(headers: Any) -> str | None:
    urls: dict[str, str] = {}
    for value in headers.get_all("Project-URL") or []:
        label, _, url = str(value).partition(",")
        if url.strip():
            urls.setdefault(label.strip().casefold(), url.strip())
    for label in _PROJECT_URL_LABELS:
        if label in urls:
            return urls[label]
    home = str(headers.get("Home-page") or "").strip()
    return home or None


def _python_license_texts(dist_info: Path, declared: Iterable[str]) -> list[tuple[str, str]]:
    picked: list[Path] = []
    for value in declared:
        relative = str(value).strip()
        for base in (dist_info / "licenses", dist_info):
            path = _contained(base, relative) if relative else None
            if path is not None and path.is_file():
                picked.append(path)
                break
    if not picked:
        if dist_info.is_dir():
            picked.extend(path for path in sorted(dist_info.iterdir(), key=lambda item: item.name.casefold())
                          if path.is_file() and _is_license_file(path.name))
        licenses = dist_info / "licenses"
        if licenses.is_dir():
            picked.extend(path for path in sorted(licenses.rglob("*"), key=lambda item: item.as_posix().casefold())
                          if path.is_file())
    texts: list[tuple[str, str]] = []
    seen: set[Path] = set()
    for path in picked:
        if path in seen:
            continue
        seen.add(path)
        text = _read_text(path.read_bytes())
        if text:
            texts.append((path.relative_to(dist_info).as_posix(), text))
    return texts


def _cyclonedx_license(component: Mapping[str, Any]) -> str:
    values: list[str] = []
    for entry in component.get("licenses") or []:
        if not isinstance(entry, Mapping):
            continue
        if isinstance(entry.get("expression"), str):
            values.append(entry["expression"])
        elif isinstance(entry.get("license"), Mapping):
            value = entry["license"].get("id") or entry["license"].get("name")
            if isinstance(value, str):
                values.append(value)
    return " / ".join(values) or "license not declared"


def _embedded_components(dist_info: Path) -> list[str]:
    """Components a wheel declares in its PEP 770 SBOMs (for example statically linked crates)."""

    lines: list[str] = []
    sboms = dist_info / "sboms"
    if not sboms.is_dir():
        return lines
    for path in sorted(sboms.glob("*.json"), key=lambda item: item.name.casefold()):
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        components = document.get("components") if isinstance(document, Mapping) else None
        entries: set[str] = set()
        for component in components if isinstance(components, list) else []:
            if isinstance(component, Mapping) and isinstance(component.get("name"), str) \
                    and isinstance(component.get("version"), str):
                entries.add(f"  {component['name']} {component['version']} ({_cyclonedx_license(component)})")
        if entries:
            lines.append(_paragraph(f"Embedded components declared by {path.relative_to(dist_info).as_posix()} "
                                    "(their license texts are not part of this package's metadata):"))
            lines.extend(sorted(entries, key=str.casefold))
    return lines


def python_notices(site_packages: Path) -> list[Notice]:
    """One notice per ``*.dist-info`` in ``site_packages``, with its license files."""

    site_packages = Path(site_packages)
    if not site_packages.is_dir():
        return []
    notices: list[Notice] = []
    for dist_info in sorted(site_packages.glob("*.dist-info"), key=lambda item: item.name.casefold()):
        metadata = dist_info / "METADATA"
        if not dist_info.is_dir() or not metadata.is_file():
            continue
        headers = HeaderParser().parsestr(_read_text(metadata.read_bytes()), headersonly=True)
        name = str(headers.get("Name") or "").strip()
        version = str(headers.get("Version") or "").strip()
        if not name or not version:
            continue
        details: list[str] = []
        project = _python_project_url(headers)
        if project:
            details.append(f"Project: {project}")
        details.extend(_embedded_components(dist_info))
        notices.append(Notice(
            name=name,
            version=version,
            license=_python_license(headers),
            details=tuple(details),
            texts=tuple(_python_license_texts(dist_info, headers.get_all("License-File") or [])),
        ))
    return notices


def render_python_document(notices: Iterable[Notice]) -> str:
    return render_document(
        "Third-party software notices: Python packages bundled with the Auvra host",
        "The Auvra host runs on the bundled CPython runtime with the packages below installed in "
        "runtime/python/Lib/site-packages. Each package is used under the license files recorded in "
        "its .dist-info metadata, reproduced below.",
        notices,
    )


# ---------------------------------------------------------------------------
# Rust crates


def _cargo_home(explicit: Path | None) -> Path:
    if explicit is not None:
        return Path(explicit)
    configured = os.environ.get("CARGO_HOME")
    return Path(configured) if configured else Path.home() / ".cargo"


def _cargo_metadata(manifest_dir: Path, target: str, cargo: str | None) -> dict[str, Any] | None:
    executable = cargo or os.environ.get("AUVRA_CARGO") or shutil.which("cargo")
    if not executable:
        return None
    command = [executable, "metadata", "--format-version", "1", "--filter-platform", target,
               "--locked", "--offline", "--manifest-path", str(manifest_dir / "Cargo.toml")]
    try:
        result = subprocess.run(command, cwd=manifest_dir, capture_output=True, check=False, timeout=300)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode:
        return None
    try:
        value = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("packages"), list):
        return None
    return value


def _metadata_crates(metadata: Mapping[str, Any]) -> list[_Crate]:
    """Crates reachable from the workspace through normal and build edges."""

    packages = {item["id"]: item for item in metadata.get("packages", [])
                if isinstance(item, Mapping) and isinstance(item.get("id"), str)}
    members = {item for item in metadata.get("workspace_members") or [] if isinstance(item, str)}
    resolve = metadata.get("resolve") if isinstance(metadata.get("resolve"), Mapping) else {}
    nodes = {node["id"]: node for node in resolve.get("nodes") or []
             if isinstance(node, Mapping) and isinstance(node.get("id"), str)}
    pending = sorted(members)
    reached: set[str] = set()
    while pending:
        current = pending.pop()
        if current in reached:
            continue
        reached.add(current)
        node = nodes.get(current)
        if node is None:
            continue
        deps = node.get("deps")
        if not isinstance(deps, list):
            pending.extend(item for item in node.get("dependencies") or [] if isinstance(item, str))
            continue
        for dep in deps:
            if not isinstance(dep, Mapping) or not isinstance(dep.get("pkg"), str):
                continue
            kinds = dep.get("dep_kinds") or [{"kind": None}]
            if any(not isinstance(kind, Mapping) or kind.get("kind") != "dev" for kind in kinds):
                pending.append(dep["pkg"])
    crates: list[_Crate] = []
    for identity in reached - members:
        package = packages.get(identity)
        if package is None:
            continue
        manifest = package.get("manifest_path")
        crates.append(_Crate(
            name=str(package.get("name")),
            version=str(package.get("version")),
            source=package.get("source") if isinstance(package.get("source"), str) else None,
            directory=Path(manifest).parent if isinstance(manifest, str) else None,
            license=package.get("license") if isinstance(package.get("license"), str) else None,
            license_file=package.get("license_file") if isinstance(package.get("license_file"), str) else None,
            repository=package.get("repository") if isinstance(package.get("repository"), str) else None,
            from_metadata=True,
        ))
    return crates


def _lockfile_crates(manifest_dir: Path) -> list[_Crate]:
    lock = manifest_dir / "Cargo.lock"
    try:
        data = tomllib.loads(lock.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise NoticesError(f"{manifest_dir.name}/Cargo.lock is missing or unreadable") from exc
    crates: list[_Crate] = []
    for package in data.get("package") or []:
        if not isinstance(package, Mapping):
            continue
        name, version, source = package.get("name"), package.get("version"), package.get("source")
        # Packages without a source are this repository's own path crates.
        if isinstance(name, str) and isinstance(version, str) and isinstance(source, str):
            crates.append(_Crate(name=name, version=version, source=source))
    return crates


def _toml(data: bytes) -> dict[str, Any]:
    try:
        value = tomllib.loads(_read_text(data))
    except tomllib.TOMLDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _package_fields(manifest: Mapping[str, Any]) -> tuple[str | None, str | None, str | None]:
    package = manifest.get("package") if isinstance(manifest.get("package"), Mapping) else {}
    fields = tuple(package.get(key) if isinstance(package.get(key), str) else None
                   for key in ("license", "license-file", "repository"))
    return fields  # type: ignore[return-value]


def _locate_crate(name: str, version: str, manifest_dir: Path, cargo_home: Path) -> Path | None:
    """A crate source directory or ``.crate`` archive available offline."""

    for candidate in (manifest_dir / "vendor" / f"{name}-{version}", manifest_dir / "vendor" / name):
        manifest = candidate / "Cargo.toml"
        if manifest.is_file():
            package = _toml(manifest.read_bytes()).get("package") or {}
            if isinstance(package, Mapping) and package.get("name") == name and package.get("version") == version:
                return candidate
    registry = cargo_home / "registry"
    for kind, suffix in (("src", ""), ("cache", ".crate")):
        base = registry / kind
        indexes = sorted((item for item in base.iterdir() if item.is_dir()), key=lambda item: item.name) \
            if base.is_dir() else []
        for index in indexes:
            candidate = index / f"{name}-{version}{suffix}"
            if (suffix and candidate.is_file()) or (not suffix and (candidate / "Cargo.toml").is_file()):
                return candidate
    return None


def _directory_texts(directory: Path, license_file: str | None) -> list[tuple[str, str]]:
    picked: list[Path] = []
    for entry in sorted(directory.iterdir(), key=lambda item: item.name.casefold()):
        if entry.is_file() and _is_license_file(entry.name):
            picked.append(entry)
        elif entry.is_dir() and entry.name.casefold() in _LICENSE_DIRECTORIES:
            picked.extend(path for path in sorted(entry.rglob("*"), key=lambda item: item.as_posix().casefold())
                          if path.is_file() and path.suffix.lower() not in _NON_TEXT_SUFFIXES)
    if license_file:
        candidate = _contained(directory, license_file)
        if candidate is not None and candidate.is_file() and candidate not in picked:
            picked.append(candidate)
    texts: list[tuple[str, str]] = []
    for path in picked:
        text = _read_text(path.read_bytes())
        if text:
            texts.append((path.relative_to(directory).as_posix(), text))
    return texts


def _archive_texts(archive: Path, name: str, version: str) -> tuple[Mapping[str, Any], list[tuple[str, str]]] | None:
    """Read the manifest and license files of a downloaded ``.crate`` without extracting it."""

    prefix = f"{name}-{version}/"
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            members = {member.name[len(prefix):]: member for member in bundle.getmembers()
                       if member.isfile() and member.name.startswith(prefix)}

            def read(relative: str) -> bytes:
                handle = bundle.extractfile(members[relative])
                if handle is None:
                    return b""
                with handle:
                    return handle.read()

            manifest = _toml(read("Cargo.toml")) if "Cargo.toml" in members else {}
            _, license_file, _ = _package_fields(manifest)
            picked: list[str] = []
            for relative in sorted(members, key=str.casefold):
                parts = relative.split("/")
                if (len(parts) == 1 and _is_license_file(parts[0])) or (
                        len(parts) > 1 and parts[0].casefold() in _LICENSE_DIRECTORIES
                        and PurePosixPath(relative).suffix.lower() not in _NON_TEXT_SUFFIXES):
                    picked.append(relative)
            if license_file:
                normalized = posixpath.normpath(license_file.replace("\\", "/"))
                if normalized in members and normalized not in picked:
                    picked.append(normalized)
            texts = [(relative, text) for relative in picked if (text := _read_text(read(relative)))]
    except (OSError, tarfile.TarError, EOFError):
        return None
    return manifest, texts


def _crate_notice(crate: _Crate, manifest_dir: Path, cargo_home: Path) -> tuple[Notice, bool]:
    license, license_file, repository = crate.license, crate.license_file, crate.repository
    texts: list[tuple[str, str]] | None = None
    directory = crate.directory if crate.directory is not None and crate.directory.is_dir() else None
    if directory is None:
        located = _locate_crate(crate.name, crate.version, manifest_dir, cargo_home)
        if located is not None and located.is_dir():
            directory = located
        elif located is not None:
            archived = _archive_texts(located, crate.name, crate.version)
            if archived is not None:
                manifest, texts = archived
                if not crate.from_metadata:
                    license, license_file, repository = _package_fields(manifest)
    if directory is not None:
        if not crate.from_metadata:
            manifest_path = directory / "Cargo.toml"
            license, license_file, repository = _package_fields(
                _toml(manifest_path.read_bytes()) if manifest_path.is_file() else {})
        texts = _directory_texts(directory, license_file)
    available = texts is not None
    declared = license or (f"see {license_file}" if license_file else None)
    details: list[str] = []
    if repository:
        details.append(f"Repository: {repository}")
    if crate.source == CRATES_IO_SOURCE:
        details.append(f"Crate: https://crates.io/crates/{crate.name}/{crate.version}")
    elif crate.source:
        details.append(f"Source: {crate.source}")
    if not available:
        where = (f"https://crates.io/crates/{crate.name}/{crate.version}" if crate.source == CRATES_IO_SOURCE
                 else (crate.source or "its upstream repository"))
        fallback = _paragraph(
            "License text not available offline: the crate source was not found in the local cargo "
            f"registry, its download cache or a vendor directory. Declared license: "
            f"{declared or 'unknown offline'}. The crate and its license are published at {where}.")
    else:
        fallback = _paragraph(
            f"No license file is shipped in the crate source. Declared license: {declared or 'not declared'}.")
    notice = Notice(
        name=crate.name,
        version=crate.version,
        license=declared or ("license unavailable offline" if not available else "license not declared"),
        details=tuple(details),
        texts=tuple(texts or ()),
        fallback=fallback,
    )
    return notice, available


def rust_notices(manifest_dir: Path, *, target: str = WINDOWS_TARGET, cargo: str | None = None,
                 cargo_home: Path | None = None) -> RustNotices:
    """Notices for the third-party crates one cargo project ships for ``target``."""

    manifest_dir = Path(manifest_dir).resolve()
    if not (manifest_dir / "Cargo.toml").is_file():
        raise NoticesError(f"{manifest_dir.name} has no Cargo.toml")
    metadata = _cargo_metadata(manifest_dir, target, cargo)
    if metadata is not None:
        crates, resolver = _metadata_crates(metadata), "cargo metadata"
    else:
        crates, resolver = _lockfile_crates(manifest_dir), "Cargo.lock"
    home = _cargo_home(cargo_home)
    notices: list[Notice] = []
    unavailable: list[str] = []
    seen: set[tuple[str, str]] = set()
    for crate in sorted(crates, key=lambda item: (item.name.casefold(), item.version, item.source or "")):
        if (crate.name, crate.version) in seen:
            continue
        seen.add((crate.name, crate.version))
        notice, available = _crate_notice(crate, manifest_dir, home)
        notices.append(notice)
        if not available:
            unavailable.append(f"{crate.name}@{crate.version}")
    return RustNotices(tuple(notices), resolver, target, tuple(unavailable))


def render_rust_document(label: str, result: RustNotices) -> str:
    if result.resolver == "cargo metadata":
        scope = (f"resolved by cargo metadata from Cargo.lock for {result.target} (normal and build "
                 "dependencies; development-only dependencies are excluded)")
    else:
        scope = ("read from Cargo.lock without platform filtering, because cargo metadata was not available "
                 "offline, so crates used only on other platforms may be listed")
    introduction = (f"{label[:1].upper()}{label[1:]} is built from the Rust crates below, {scope}. Each crate is "
                    "used under the license files reproduced from its source.")
    if result.unavailable:
        introduction += (f" {len(result.unavailable)} crate(s) whose source was not available offline are listed "
                         "with their declared license and download location instead of a license text.")
    return render_document(f"Third-party software notices: {label}", introduction, result.notices)


# ---------------------------------------------------------------------------
# Runtimes and the editor package file


def _shipped_texts(root: Path | None, names: Iterable[str], location: str) -> tuple[tuple[str, str], ...]:
    if root is None or not root.is_dir():
        return ()
    texts: list[tuple[str, str]] = []
    for name in names:
        path = root / name
        if path.is_file():
            text = _read_text(path.read_bytes())
            if text:
                texts.append((f"{location}{name}", text))
    return tuple(texts)


def runtime_notices(pins: Mapping[str, Any], *, python_embed: Path | None = None,
                    webview2_sdk: Path | None = None, webview2_fixed: Path | None = None) -> list[Notice]:
    """License references for the bundled CPython and WebView2 payloads."""

    def pin(name: str) -> Mapping[str, Any]:
        value = pins.get(name)
        if not isinstance(value, Mapping) or not isinstance(value.get("version"), str):
            raise NoticesError(f"runtime pin {name} is missing")
        return value

    python_pin, sdk_pin, fixed_pin = pin("pythonEmbed"), pin("webview2Sdk"), pin("webview2Fixed")
    python_details = ["Location: runtime/python/"]
    if isinstance(python_pin.get("url"), str):
        python_details.append(f"Distribution: {python_pin['url']}")
    python_details.append("License: Python Software Foundation License Version 2; "
                          "https://docs.python.org/3/license.html")
    fixed_details = ["Location: runtime/webview2/"]
    if isinstance(fixed_pin.get("url"), str):
        fixed_details.append(f"Distribution: {fixed_pin['url']}")
    if webview2_fixed is not None and webview2_fixed.is_dir():
        shipped = [f"runtime/webview2/{path.name}"
                   for path in sorted(webview2_fixed.iterdir(), key=lambda item: item.name.casefold())
                   if path.is_file() and _is_license_file(path.name)]
        if shipped:
            fixed_details.append("License files shipped with the runtime: " + ", ".join(shipped))
    sdk_details = ["Location: runtime/webview2-sdk/"]
    if isinstance(sdk_pin.get("url"), str):
        sdk_details.append(f"Distribution: {sdk_pin['url']}")
    sdk_details.append(f"Package: https://www.nuget.org/packages/Microsoft.Web.WebView2/{sdk_pin['version']}")
    return [
        Notice(
            name="CPython embeddable distribution",
            version=python_pin["version"],
            license="PSF-2.0",
            details=tuple(python_details),
            texts=_shipped_texts(python_embed, ("LICENSE.txt",), "runtime/python/"),
            fallback=_paragraph("The distribution's LICENSE.txt was not staged with this package. The CPython "
                                "license and the licenses of the libraries it bundles are published at "
                                "https://docs.python.org/3/license.html."),
        ),
        Notice(
            name="Microsoft Edge WebView2 Runtime (Fixed Version)",
            version=fixed_pin["version"],
            license="Microsoft Software License Terms",
            details=tuple(fixed_details),
            fallback=_paragraph(
                "The Microsoft Edge WebView2 Runtime is proprietary Microsoft software. It is redistributed in its "
                "Fixed Version form under the Microsoft software license terms that accompany the Fixed Version "
                "download at https://developer.microsoft.com/microsoft-edge/webview2/ (distribution guidance: "
                "https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution). Open-source "
                "components included in the runtime are credited by the runtime itself at edge://credits."),
        ),
        Notice(
            name="Microsoft.Web.WebView2 SDK",
            version=sdk_pin["version"],
            license="BSD-3-Clause",
            details=tuple(sdk_details),
            texts=_shipped_texts(webview2_sdk, ("LICENSE.txt", "NOTICE.txt"), "runtime/webview2-sdk/"),
            fallback=_paragraph("The SDK's LICENSE.txt and NOTICE.txt were not staged with this package; they "
                                "are published in the NuGet package referenced above."),
        ),
    ]


def render_runtime_document(notices: Iterable[Notice]) -> str:
    return render_document(
        "Third-party software notices: bundled runtimes",
        "The package ships the runtimes below unmodified, as pinned and hash-verified by the release policy.",
        notices,
    )


def compose_editor_notices(parts: Mapping[str, str]) -> str:
    """Join the part documents into the package-root notices file."""

    total = len(EDITOR_PARTS)
    contents = "\n".join(f"  Part {index}: {title}" for index, (_, title) in enumerate(EDITOR_PARTS, 1))
    text = "\n".join((
        "Auvra third-party software notices",
        "",
        _paragraph("This Auvra package bundles the third-party software listed in this file. Each component is "
                   "used under the license reproduced or referenced in its entry. Auvra's own license is in the "
                   "licenses folder of this package."),
        "",
        "Contents:",
        contents,
        "",
    ))
    for index, (key, title) in enumerate(EDITOR_PARTS, 1):
        body = str(parts.get(key) or "").strip()
        text += f"\n{PART_RULE}\nPart {index} of {total}: {title}\n{PART_RULE}\n\n{body}\n"
    return sanitize(text)


def verify_editor_notices(text: str) -> dict[str, int]:
    """Require every part, in order, each listing at least one component."""

    if len(text.encode("utf-8")) < MIN_EDITOR_NOTICES_BYTES:
        raise NoticesError(f"{NOTICES_FILE} is too small to be complete")
    headings = list(_PART_HEADING.finditer(text))
    titles = [match.group("title") for match in headings]
    expected = [title for _, title in EDITOR_PARTS]
    if titles != expected or any(int(match.group("total")) != len(EDITOR_PARTS) for match in headings):
        missing = [title for title in expected if title not in titles]
        raise NoticesError(f"{NOTICES_FILE} parts are missing or out of order (missing={missing})")
    counts: dict[str, int] = {}
    for index, (key, title) in enumerate(EDITOR_PARTS):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        count = count_components(text[headings[index].end():end])
        if count < 1:
            raise NoticesError(f"{NOTICES_FILE} part '{title}' lists no components")
        counts[key] = count
    return counts


def _required_notices(path: Path, label: str) -> str:
    try:
        text = path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        raise NoticesError(f"{label} input is missing {NOTICES_FILE}") from None
    except (OSError, UnicodeDecodeError) as exc:
        raise NoticesError(f"{label} input {NOTICES_FILE} is unreadable") from exc
    if count_components(text) < 1:
        raise NoticesError(f"{label} input {NOTICES_FILE} lists no components")
    return text


def editor_notices_from_inputs(input_root: Path, pins: Mapping[str, Any]) -> str:
    """Compose the package-root notices from a staged release input root."""

    input_root = Path(input_root)
    python = python_notices(input_root / "python-site-packages")
    if not python:
        raise NoticesError("python-site-packages input has no *.dist-info metadata to take license notices from")
    return compose_editor_notices({
        "frontend": _required_notices(input_root / "frontend" / NOTICES_FILE, "frontend"),
        "python": render_python_document(python),
        "native": _required_notices(input_root / "native" / NOTICES_FILE, "native"),
        "player": _required_notices(input_root / "game-player" / NOTICES_FILE, "game-player"),
        "runtimes": render_runtime_document(runtime_notices(
            pins,
            python_embed=input_root / "python-embed",
            webview2_sdk=input_root / "webview2-sdk",
            webview2_fixed=input_root / "webview2-fixed",
        )),
    })


def frontend_notices_from_sources(frontend_root: Path = FRONTEND_ROOT, *, node: str | None = None) -> str:
    """Run ``scripts/licenses/notices.mjs`` (the Vite build's collector) directly."""

    executable = node or shutil.which("node")
    if not executable:
        raise NoticesError("node is required to run scripts/licenses/notices.mjs")
    script = ("const [collector, root] = process.argv.slice(1);"
              "const { collectThirdPartyNotices } = await import(collector);"
              "process.stdout.write(collectThirdPartyNotices(root));")
    frontend_root = Path(frontend_root).resolve()
    collector = frontend_root / "scripts" / "licenses" / "notices.mjs"
    try:
        result = subprocess.run([executable, "--input-type=module", "-e", script, collector.as_uri(), str(frontend_root)],
                                capture_output=True, check=False, timeout=300)
    except (OSError, subprocess.SubprocessError) as exc:
        raise NoticesError("notices.mjs could not be run") from exc
    if result.returncode:
        raise NoticesError(f"notices.mjs failed: {result.stderr.decode('utf-8', 'replace')[-500:]}")
    return result.stdout.decode("utf-8")


def _read_pins() -> Mapping[str, Any]:
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    pins = policy.get("runtimePins") if isinstance(policy, Mapping) else None
    if not isinstance(pins, Mapping):
        raise NoticesError("release policy has no runtime pins")
    return pins


def _write(path: Path, text: str) -> int:
    data = text.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return len(data)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="release.notices", description="Collect third-party license notices.")
    sub = parser.add_subparsers(dest="command", required=True)
    rust = sub.add_parser("rust", help="write the notices for the crates one cargo project ships")
    rust.add_argument("--manifest-dir", type=Path, required=True)
    rust.add_argument("--label", help="what the binary is; defaults to the label of native/ or player-desktop/")
    rust.add_argument("--output", type=Path, required=True)
    rust.add_argument("--target", default=WINDOWS_TARGET)
    rust.add_argument("--cargo")
    rust.add_argument("--cargo-home", type=Path)
    rust.add_argument("--strict", action="store_true",
                      help="fail when a shipped crate's license text is not available offline")
    editor = sub.add_parser("editor", help="compose the package notices from a staged release input root")
    editor.add_argument("--input-root", type=Path, required=True)
    editor.add_argument("--output", type=Path, required=True)
    preview = sub.add_parser("preview", help="compose the package notices from this checkout")
    preview.add_argument("--output", type=Path, required=True)
    preview.add_argument("--site-packages", type=Path, default=REPOSITORY / ".venv" / "Lib" / "site-packages")
    preview.add_argument("--frontend-notices", type=Path,
                         help="a built THIRD_PARTY_NOTICES.txt; by default notices.mjs is run with node")
    preview.add_argument("--node")
    preview.add_argument("--cargo")
    preview.add_argument("--cargo-home", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "rust":
            label = args.label or DEFAULT_LABELS.get(Path(args.manifest_dir).resolve().name)
            if not label:
                raise NoticesError("--label is required for a cargo project other than native or player-desktop")
            result = rust_notices(args.manifest_dir, target=args.target, cargo=args.cargo, cargo_home=args.cargo_home)
            if args.strict and result.unavailable:
                listed = ", ".join(result.unavailable[:20])
                raise NoticesError(f"{len(result.unavailable)} crate(s) have no license text available offline "
                                   f"(resolver: {result.resolver}): {listed}")
            size = _write(args.output, render_rust_document(label, result))
            summary: dict[str, Any] = {"bytes": size, "crates": len(result.notices), "resolver": result.resolver,
                                       "unavailable": list(result.unavailable)}
        elif args.command == "editor":
            text = editor_notices_from_inputs(args.input_root, _read_pins())
            summary = {"bytes": _write(args.output, text), "parts": verify_editor_notices(text)}
        else:
            if args.frontend_notices is not None:
                frontend, frontend_source = args.frontend_notices.read_text(encoding="utf-8"), "file"
            else:
                frontend, frontend_source = frontend_notices_from_sources(node=args.node), "notices.mjs"
            native = rust_notices(REPOSITORY / "native", cargo=args.cargo, cargo_home=args.cargo_home)
            player = rust_notices(REPOSITORY / "player-desktop", cargo=args.cargo, cargo_home=args.cargo_home)
            text = compose_editor_notices({
                "frontend": frontend,
                "python": render_python_document(python_notices(args.site_packages)),
                "native": render_rust_document(NATIVE_LABEL, native),
                "player": render_rust_document(PLAYER_LABEL, player),
                "runtimes": render_runtime_document(runtime_notices(_read_pins())),
            })
            summary = {
                "bytes": _write(args.output, text),
                "parts": verify_editor_notices(text),
                "frontendSource": frontend_source,
                "rustResolver": {"native": native.resolver, "player": player.resolver},
                "unavailable": {"native": list(native.unavailable), "player": list(player.unavailable)},
            }
    except (NoticesError, OSError, json.JSONDecodeError) as exc:
        print(f"notices failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
