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
$launcherSourcePath = Join-Path $runtimePath "scripts\windows\MomentInsightNaverShoppingHost.cs"
$nativeHostScriptPath = Join-Path $runtimePath "scripts\naver-shopping-native-host.mjs"
$launcherPath = Join-Path $runtimePath "MomentInsightNaverShoppingHost.exe"
$taskPath = "\MomentInsight\"
$taskName = "NaverShoppingChrome"
$sourceBase = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/tools/naver-shopping-chrome-extension"
$launcherSourceUrl = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/scripts/windows/MomentInsightNaverShoppingHost.cs"
$nativeHostScriptUrl = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/scripts/naver-shopping-native-host.mjs"
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
    $launcherSourceBytes = $client.DownloadData($launcherSourceUrl)
    if (-not $launcherSourceBytes -or $launcherSourceBytes.Length -eq 0) { throw "launcher_download_empty" }
    $nativeHostScriptBytes = $client.DownloadData($nativeHostScriptUrl)
    if (-not $nativeHostScriptBytes -or $nativeHostScriptBytes.Length -eq 0) { throw "native_host_script_download_empty" }
    $stagedLauncherSource = Join-Path $stagingPath "MomentInsightNaverShoppingHost.cs"
    $stagedNativeHostScript = Join-Path $stagingPath "naver-shopping-native-host.mjs"
    $stagedLauncher = Join-Path $stagingPath "MomentInsightNaverShoppingHost.exe"
    [IO.File]::WriteAllBytes($stagedLauncherSource, $launcherSourceBytes)
    [IO.File]::WriteAllBytes($stagedNativeHostScript, $nativeHostScriptBytes)

    $manifestPath = Join-Path $stagingPath "manifest.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$manifest.version -ne $ExpectedVersion) { throw "extension_version_mismatch" }

    foreach ($scriptName in @("service-worker.js", "popup.js")) {
        & $nodePath --check (Join-Path $stagingPath $scriptName)
        if ($LASTEXITCODE -ne 0) { throw "extension_javascript_invalid:$scriptName" }
    }
    & $nodePath --check $stagedNativeHostScript
    if ($LASTEXITCODE -ne 0) { throw "native_host_javascript_invalid" }
    $launcherMissing = -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)
    $launcherSourceChanged = -not (Test-Path -LiteralPath $launcherSourcePath -PathType Leaf) -or
        ((Get-FileHash -Algorithm SHA256 -LiteralPath $stagedLauncherSource).Hash -ne
            (Get-FileHash -Algorithm SHA256 -LiteralPath $launcherSourcePath).Hash)
    $launcherNeedsCompile = $launcherMissing -or $launcherSourceChanged
    if ($launcherNeedsCompile) {
        Add-Type -Path $stagedLauncherSource -OutputAssembly $stagedLauncher -OutputType WindowsApplication -ReferencedAssemblies @(
            "System.dll",
            "System.Core.dll",
            "System.Security.dll"
        ) -PassThru | Out-Null
        if (-not (Test-Path -LiteralPath $stagedLauncher -PathType Leaf)) { throw "native_host_launcher_compile_failed" }
    }

    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "MomentInsightNaverShoppingHost.exe" -or
        ($_.Name -eq "node.exe" -and $_.CommandLine -like "*naver-shopping-native-host.mjs*")
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $stagingPath $file) -Destination (Join-Path $extensionPath $file) -Force
    }
    if ($launcherSourceChanged) {
        New-Item -ItemType Directory -Path (Split-Path $launcherSourcePath -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $stagedLauncherSource -Destination $launcherSourcePath -Force
    }
    if ($launcherNeedsCompile) {
        Copy-Item -LiteralPath $stagedLauncher -Destination $launcherPath -Force
    }
    Copy-Item -LiteralPath $stagedNativeHostScript -Destination $nativeHostScriptPath -Force
    Start-Sleep -Seconds 3
    Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName

    $serviceWorkerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $extensionPath "service-worker.js")).Hash.ToLowerInvariant()
    $launcherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $launcherPath).Hash.ToLowerInvariant()
    $nativeHostHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nativeHostScriptPath).Hash.ToLowerInvariant()
    Write-Host "MI_EXTENSION_UPDATE_OK release=$ReleaseCommit version=$ExpectedVersion syntax=3 launcher_recompiled=$launcherNeedsCompile launcher_source_updated=$launcherSourceChanged service_worker_sha256=$serviceWorkerHash launcher_sha256=$launcherHash native_host_sha256=$nativeHostHash"
}
finally {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
}
