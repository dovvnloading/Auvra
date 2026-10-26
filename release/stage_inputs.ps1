[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Frontend,
    [Parameter(Mandatory)] [string] $PythonEmbed,
    [Parameter(Mandatory)] [string] $PythonSitePackages,
    [Parameter(Mandatory)] [string] $WebView2Sdk,
    [Parameter(Mandatory)] [string] $WebView2Fixed,
    [Parameter(Mandatory)] [string] $NativeBinary,
    [Parameter(Mandatory)] [string] $GamePlayerBinary,
    [Parameter(Mandatory)] [string] $HostInput,
    [Parameter(Mandatory)] [string] $Licenses,
    [Parameter(Mandatory)] [string] $Output
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Copy-StagedTree([string] $Source, [string] $Name) {
    $resolved = (Resolve-Path -LiteralPath $Source -ErrorAction Stop).Path
    if (-not (Get-Item -LiteralPath $resolved).PSIsContainer) { throw "$Name must be a directory" }
    $destination = Join-Path $Output $Name
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Get-ChildItem -LiteralPath $resolved -Force | Copy-Item -Destination $destination -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $Output | Out-Null
$existing = Get-ChildItem -LiteralPath $Output -Force
if ($existing) { throw 'Output must be an empty directory for deterministic staging' }
Copy-StagedTree $Frontend 'frontend'
Copy-StagedTree $PythonEmbed 'python-embed'
Copy-StagedTree $PythonSitePackages 'python-site-packages'
Copy-StagedTree $WebView2Sdk 'webview2-sdk'
Copy-StagedTree $WebView2Fixed 'webview2-fixed'
# HostInput holds the importable Auvra package plus protocol\v1 and project\v1
# *.schema.json beside it; the inventory step below rejects a host without them.
Copy-StagedTree $HostInput 'host'
Copy-StagedTree $Licenses 'licenses'
$native = (Resolve-Path -LiteralPath $NativeBinary -ErrorAction Stop).Path
if ([IO.Path]::GetFileName($native) -ne 'auvra-native.exe') { throw 'NativeBinary must be auvra-native.exe' }
New-Item -ItemType Directory -Force -Path (Join-Path $Output 'native') | Out-Null
Copy-Item -LiteralPath $native -Destination (Join-Path $Output 'native\auvra-native.exe') -Force
$gamePlayer = (Resolve-Path -LiteralPath $GamePlayerBinary -ErrorAction Stop).Path
if ([IO.Path]::GetFileName($gamePlayer) -ne 'auvra-player.exe') { throw 'GamePlayerBinary must be auvra-player.exe' }
New-Item -ItemType Directory -Force -Path (Join-Path $Output 'game-player') | Out-Null
Copy-Item -LiteralPath $gamePlayer -Destination (Join-Path $Output 'game-player\auvra-player.exe') -Force
# Third-party notices for the Rust crates each binary ships, written beside it
# from this checkout's Cargo.lock and the offline cargo registry. Assembly
# composes them into the package-root THIRD_PARTY_NOTICES.txt, and exported
# Windows games copy the player's notices next to the game executable.
$repository = Split-Path -Parent $PSScriptRoot
python -m release.notices rust --strict --manifest-dir (Join-Path $repository 'native') --output (Join-Path $Output 'native\THIRD_PARTY_NOTICES.txt')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
python -m release.notices rust --strict --manifest-dir (Join-Path $repository 'player-desktop') --output (Join-Path $Output 'game-player\THIRD_PARTY_NOTICES.txt')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

python -m release.pipeline inventory --input-root $Output --output (Join-Path $Output 'inputs-manifest.json')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
