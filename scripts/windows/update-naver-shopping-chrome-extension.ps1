[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{7,40}$')]
    [string]$ReleaseCommit,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')]
    [string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "windows_only_updater" }

$runtimePath = Join-Path $env:LOCALAPPDATA "MomentInsight\NaverShoppingBridge"
$extensionPath = Join-Path $runtimePath "tools\naver-shopping-chrome-extension"
$nativeConfigPath = Join-Path $runtimePath "windows-native-host.conf"
$taskPath = "\MomentInsight\"
$taskName = "NaverShoppingChrome"
$sourceBase = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/tools/naver-shopping-chrome-extension"
$files = @(
    "README.md",
    "manifest.json",
    "popup.css",
    "popup.html",
    "popup.js",
    "service-worker.js"
)

if (-not (Test-Path -LiteralPath $extensionPath -PathType Container)) { throw "extension_path_missing" }
if (-not (Test-Path -LiteralPath $nativeConfigPath -PathType Leaf)) { throw "native_config_missing" }
$nativeConfig = @(Get-Content -LiteralPath $nativeConfigPath -Encoding UTF8)
if ($nativeConfig.Count -lt 1) { throw "native_config_invalid" }
$nodePath = [IO.Path]::GetFullPath($nativeConfig[0].Trim())
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "node_path_missing" }

$stagingPath = Join-Path $runtimePath ("extension-update-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
try {
    $client = New-Object Net.WebClient
    foreach ($file in $files) {
        $bytes = $client.DownloadData("$sourceBase/$file")
        if (-not $bytes -or $bytes.Length -eq 0) { throw "extension_download_empty:$file" }
        [IO.File]::WriteAllBytes((Join-Path $stagingPath $file), $bytes)
    }

    $manifestPath = Join-Path $stagingPath "manifest.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$manifest.version -ne $ExpectedVersion) { throw "extension_version_mismatch" }

    foreach ($scriptName in @("service-worker.js", "popup.js")) {
        & $nodePath --check (Join-Path $stagingPath $scriptName)
        if ($LASTEXITCODE -ne 0) { throw "extension_javascript_invalid:$scriptName" }
    }

    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $stagingPath $file) -Destination (Join-Path $extensionPath $file) -Force
    }
    Start-Sleep -Seconds 3
    Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName

    $serviceWorkerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $extensionPath "service-worker.js")).Hash.ToLowerInvariant()
    Write-Host "MI_EXTENSION_UPDATE_OK release=$ReleaseCommit version=$ExpectedVersion syntax=2 service_worker_sha256=$serviceWorkerHash"
}
finally {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
}
