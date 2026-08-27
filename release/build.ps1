[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $InputRoot,
    [Parameter(Mandatory)] [string] $OutputRoot,
    [Parameter(Mandatory)] [ValidateSet('stable', 'beta', 'dev')] [string] $Channel,
    [Parameter(Mandatory)] [string] $Version,
    [string] $AppInstallerUri,
    [string] $MsixOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$assemble = @('-m', 'release.pipeline', 'assemble', '--input-root', $InputRoot,
              '--output', $OutputRoot, '--channel', $Channel, '--version', $Version)
if ($AppInstallerUri) { $assemble += @('--appinstaller-uri', $AppInstallerUri) }
python @assemble
if ($MsixOutput) {
    python -m release.pipeline package --staging $OutputRoot --output $MsixOutput
}
