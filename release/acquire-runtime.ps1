param(
    [Parameter(Mandatory=$true)][string]$Output
)

$ErrorActionPreference = 'Stop'
$resolved = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $resolved) {
    if (-not (Get-Item -LiteralPath $resolved).PSIsContainer) { throw 'Runtime output must be a directory' }
    if (Get-ChildItem -LiteralPath $resolved -Force) { throw 'Runtime output must be absent or empty' }
} else {
    New-Item -ItemType Directory -Path $resolved | Out-Null
}
$policy = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'policy.json') | ConvertFrom-Json
$pins = $policy.runtimePins

function Get-Verified([string]$Name, $Pin, [string]$Extension) {
    $archive = Join-Path $resolved ($Name + $Extension)
    Invoke-WebRequest -Uri $Pin.url -OutFile $archive
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    if ($actual -ne $Pin.sha256.ToLowerInvariant()) {
        throw "$Name hash mismatch: expected $($Pin.sha256), got $actual"
    }
    return $archive
}

function Write-ExtractionAttestation([string]$Root, [string]$Kind, $Pin) {
    $rootItem = Get-Item -LiteralPath $Root -ErrorAction Stop
    $entries = @(
        Get-ChildItem -LiteralPath $Root -File -Recurse -Force |
            Sort-Object -Property FullName |
            ForEach-Object {
                $relative = $_.FullName.Substring($rootItem.FullName.Length).TrimStart('\').Replace('\', '/')
                [ordered]@{
                    path = $relative
                    size = [int64]$_.Length
                    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
                }
            }
    )
    if ($entries.Count -eq 0) { throw "$Kind extraction is empty" }
    $marker = [ordered]@{
        schema = 1
        kind = $Kind
        version = $Pin.version
        sha256 = $Pin.sha256.ToLowerInvariant()
        files = $entries
    }
    $marker | ConvertTo-Json -Compress -Depth 8 |
        Set-Content -LiteralPath (Join-Path $Root 'Auvra.runtime-pin.json') -Encoding ascii -NoNewline
}

$pythonArchive = Get-Verified 'python-embed' $pins.pythonEmbed '.zip'
$pythonDir = Join-Path $resolved 'python-embed'
New-Item -ItemType Directory -Force -Path $pythonDir | Out-Null
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonDir -Force
Write-ExtractionAttestation $pythonDir 'pythonEmbed' $pins.pythonEmbed

$webviewArchive = Get-Verified 'webview2-fixed-x64' $pins.webview2Fixed '.cab'
$webviewDir = Join-Path $resolved 'webview2-fixed'
New-Item -ItemType Directory -Force -Path $webviewDir | Out-Null
$expand = Get-Command expand.exe -ErrorAction SilentlyContinue
if (-not $expand) { throw 'Windows expand.exe is required to extract the pinned WebView2 CAB' }
& $expand.Source -F:* $webviewArchive $webviewDir | Out-Null
$runtimeExecutables = @(Get-ChildItem -LiteralPath $webviewDir -Filter 'msedgewebview2.exe' -File -Recurse)
if ($runtimeExecutables.Count -ne 1) { throw 'Pinned WebView2 CAB must contain exactly one msedgewebview2.exe' }
$runtimeExecutable = $runtimeExecutables[0]
if ($runtimeExecutable.Directory.FullName -ne (Get-Item -LiteralPath $webviewDir).FullName) {
    Get-ChildItem -LiteralPath $runtimeExecutable.Directory.FullName -Force | Move-Item -Destination $webviewDir -Force
    Remove-Item -LiteralPath $runtimeExecutable.Directory.FullName -Recurse -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $webviewDir 'msedgewebview2.exe') -PathType Leaf)) {
    throw 'Pinned WebView2 CAB could not be flattened to webview2-fixed/msedgewebview2.exe'
}
Write-ExtractionAttestation $webviewDir 'webview2Fixed' $pins.webview2Fixed

Remove-Item -LiteralPath $pythonArchive, $webviewArchive -Force
Write-Host "Verified and staged CPython $($pins.pythonEmbed.version) and WebView2 Fixed $($pins.webview2Fixed.version)."
Write-Host 'Use stage_inputs.ps1 with these directories plus the locked site-packages, SDK, native, host, and license inputs.'
