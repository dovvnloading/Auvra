"""Strict opt-in smoke for the real Windows Appx package lifecycle.

The deterministic model in :mod:`release.lifecycle` is useful for unit tests,
but it cannot prove that Windows accepts a signed package or preserves its
application data while upgrading, rolling back, and uninstalling.  This module
keeps that evidence-producing check explicit and fail-closed: callers must
provide three signed MSIX files and must opt in to changing the local machine.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any

from .pipeline import ReleaseError


CHANNEL_IDENTITIES = {"stable": "Auvra", "beta": "Auvra.Beta", "dev": "Auvra.Dev"}
SMOKE_ENVIRONMENT_VARIABLE = "AUVRA_WINDOWS_LIFECYCLE_SMOKE"


# Keep the PowerShell body in source so it is reviewable and can be syntax
# checked without installing a package.  All paths and the identity are passed
# as arguments rather than interpolated into this script.
WINDOWS_LIFECYCLE_SCRIPT = r"""
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Identity,
    [Parameter(Mandatory = $true)] [string] $InitialPackage,
    [Parameter(Mandatory = $true)] [string] $UpgradePackage,
    [Parameter(Mandatory = $true)] [string] $RollbackPackage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installed = $null
$marker = $null
$packageFamily = $null
$userDataPreserved = $false

function Get-OneInstalledPackage {
    param([string] $Name)
    $matches = @(Get-AppxPackage -Name $Name -ErrorAction SilentlyContinue)
    if ($matches.Count -ne 1) {
        throw "expected exactly one installed package for '$Name', found $($matches.Count)"
    }
    return $matches[0]
}

function Assert-PackageFile {
    param([string] $Path, [string] $Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label does not exist: $Path"
    }
    if ([IO.Path]::GetExtension($Path).ToLowerInvariant() -ne '.msix') {
        throw "$Label must be an MSIX file: $Path"
    }
}

try {
    Assert-PackageFile $InitialPackage 'initial package'
    Assert-PackageFile $UpgradePackage 'upgrade package'
    Assert-PackageFile $RollbackPackage 'rollback package'

    $existing = @(Get-AppxPackage -Name $Identity -ErrorAction SilentlyContinue)
    if ($existing.Count -ne 0) {
        throw "refusing lifecycle smoke because '$Identity' is already installed"
    }

    Add-AppxPackage -Path $InitialPackage -ForceApplicationShutdown
    $installed = Get-OneInstalledPackage $Identity
    $initialVersion = [version]$installed.Version
    $packageFamily = [string]$installed.PackageFamilyName
    $stateRoot = Join-Path $env:LOCALAPPDATA ("Packages\$packageFamily\LocalState")
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $marker = Join-Path $stateRoot 'Auvra.lifecycle-smoke.marker'
    Set-Content -LiteralPath $marker -Value 'preserve' -NoNewline -Encoding utf8

    Add-AppxPackage -Path $UpgradePackage -ForceApplicationShutdown
    $installed = Get-OneInstalledPackage $Identity
    $upgradeVersion = [version]$installed.Version
    if ($upgradeVersion -le $initialVersion) {
        throw "upgrade did not increase the installed version ($initialVersion -> $upgradeVersion)"
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw) -ne 'preserve') {
        throw 'upgrade did not preserve the lifecycle marker'
    }

    Add-AppxPackage -Path $RollbackPackage -ForceUpdateFromAnyVersion -ForceApplicationShutdown
    $installed = Get-OneInstalledPackage $Identity
    $rollbackVersion = [version]$installed.Version
    if ($rollbackVersion -ge $upgradeVersion) {
        throw "rollback did not lower the installed version ($upgradeVersion -> $rollbackVersion)"
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw) -ne 'preserve') {
        throw 'rollback did not preserve the lifecycle marker'
    }

    $packageFullName = [string]$installed.PackageFullName
    Remove-AppxPackage -Package $packageFullName -PreserveApplicationData
    if (@(Get-AppxPackage -Name $Identity -ErrorAction SilentlyContinue).Count -ne 0) {
        throw 'uninstall left the package registered'
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'uninstall removed application data despite PreserveApplicationData'
    }
    $userDataPreserved = $true
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    if ((Test-Path -LiteralPath $stateRoot -PathType Container) -and
        @(Get-ChildItem -LiteralPath $stateRoot -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $stateRoot -Force -ErrorAction SilentlyContinue
    }

    [ordered]@{
        schema = 1
        identity = $Identity
        initialVersion = $initialVersion.ToString()
        upgradeVersion = $upgradeVersion.ToString()
        rollbackVersion = $rollbackVersion.ToString()
        installed = $true
        upgraded = $true
        rolledBack = $true
        uninstalled = $true
        userDataPreserved = $userDataPreserved
    } | ConvertTo-Json -Compress
}
finally {
    if ($null -ne $installed) {
        Remove-AppxPackage -Package ([string]$installed.PackageFullName) -PreserveApplicationData -ErrorAction SilentlyContinue
    }
}
""".strip() + "\n"


def _package_path(value: Path | str, label: str) -> Path:
    path = Path(value).expanduser()
    if path.is_symlink():
        raise ReleaseError(f"{label} must not be a symlink")
    try:
        path = path.resolve(strict=True)
    except OSError as exc:
        raise ReleaseError(f"{label} is missing: {path}") from exc
    if not path.is_file() or path.suffix.casefold() != ".msix":
        raise ReleaseError(f"{label} must be an existing MSIX file: {path}")
    return path


def _powershell() -> str:
    configured = os.environ.get("AUVRA_POWERSHELL")
    executable = configured or shutil.which("pwsh") or shutil.which("powershell")
    if not executable:
        raise ReleaseError("PowerShell is required for the Windows lifecycle smoke")
    return executable


def run_windows_lifecycle_smoke(
    initial_package: Path | str,
    upgrade_package: Path | str,
    rollback_package: Path | str,
    *,
    identity: str,
    powershell: str | None = None,
    timeout: float = 180.0,
) -> dict[str, Any]:
    """Run the signed-package install/upgrade/rollback/uninstall smoke.

    The caller is responsible for the explicit opt-in gate.  This function is
    deliberately usable by release automation as well as the opt-in unittest,
    but never silently falls back to the in-memory model.
    """

    if os.name != "nt":
        raise ReleaseError("Windows lifecycle smoke requires Windows")
    if identity not in CHANNEL_IDENTITIES.values():
        raise ReleaseError(f"unsupported lifecycle package identity: {identity!r}")
    if timeout <= 0:
        raise ReleaseError("Windows lifecycle smoke timeout must be positive")
    initial = _package_path(initial_package, "initial package")
    upgrade = _package_path(upgrade_package, "upgrade package")
    rollback = _package_path(rollback_package, "rollback package")
    if len({initial, upgrade, rollback}) != 3:
        raise ReleaseError("initial, upgrade, and rollback packages must be distinct files")

    shell = powershell or _powershell()
    with tempfile.TemporaryDirectory(prefix="auvra-windows-lifecycle-") as temporary:
        script = Path(temporary) / "lifecycle.ps1"
        script.write_text(WINDOWS_LIFECYCLE_SCRIPT, encoding="utf-8", newline="\r\n")
        command = [
            shell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-Identity",
            identity,
            "-InitialPackage",
            str(initial),
            "-UpgradePackage",
            str(upgrade),
            "-RollbackPackage",
            str(rollback),
        ]
        try:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise ReleaseError(f"Windows lifecycle smoke timed out after {timeout:g}s") from exc
        except OSError as exc:
            raise ReleaseError(f"could not start PowerShell lifecycle smoke: {exc}") from exc

    if result.returncode:
        detail = (result.stderr or result.stdout)[-2000:]
        raise ReleaseError(f"Windows lifecycle smoke failed with status {result.returncode}: {detail}")
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise ReleaseError("Windows lifecycle smoke returned no result")
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise ReleaseError("Windows lifecycle smoke returned invalid JSON") from exc
    if not isinstance(payload, dict) or payload.get("schema") != 1:
        raise ReleaseError("Windows lifecycle smoke returned an unsupported result")
    if payload.get("identity") != identity:
        raise ReleaseError("Windows lifecycle smoke returned the wrong package identity")
    expected = {
        "installed": True,
        "upgraded": True,
        "rolledBack": True,
        "uninstalled": True,
        "userDataPreserved": True,
    }
    if any(payload.get(key) is not True for key in expected):
        raise ReleaseError("Windows lifecycle smoke did not prove every lifecycle transition")
    for key in ("initialVersion", "upgradeVersion", "rollbackVersion"):
        if not isinstance(payload.get(key), str) or not payload[key]:
            raise ReleaseError(f"Windows lifecycle smoke omitted {key}")
    return payload


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="release.windows_lifecycle")
    parser.add_argument("--identity", choices=tuple(CHANNEL_IDENTITIES.values()), required=True)
    parser.add_argument("--initial-package", type=Path, required=True)
    parser.add_argument("--upgrade-package", type=Path, required=True)
    parser.add_argument("--rollback-package", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=180.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = run_windows_lifecycle_smoke(
            args.initial_package,
            args.upgrade_package,
            args.rollback_package,
            identity=args.identity,
            timeout=args.timeout,
        )
    except (OSError, ValueError, ReleaseError) as exc:
        print(f"Windows lifecycle smoke failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
