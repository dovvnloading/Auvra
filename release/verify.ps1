[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $PackageRoot,
    [Parameter(Mandatory)] [ValidateSet('stable', 'beta', 'dev')] [string] $Channel,
    [switch] $Offline
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
python -m release.pipeline verify --package-root $PackageRoot --channel $Channel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
python -c "from pathlib import Path; from release.lifecycle import verify_lifecycle; import sys; print(verify_lifecycle(Path(sys.argv[1]), channel=sys.argv[2]))" $PackageRoot $Channel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Offline) { Write-Output 'offline verification is structural; no network operation is permitted' }
