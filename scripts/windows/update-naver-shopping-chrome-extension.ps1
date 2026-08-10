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
$schedulerConfigPath = Join-Path $runtimePath "windows-chrome-scheduler.conf"
$chromeUserDataPath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
$nativeConfigPath = Join-Path $runtimePath "windows-native-host.conf"
$launcherSourcePath = Join-Path $runtimePath "scripts\windows\MomentInsightNaverShoppingHost.cs"
$nativeHostScriptPath = Join-Path $runtimePath "scripts\naver-shopping-native-host.mjs"
$localWorkerScriptPath = Join-Path $runtimePath "scripts\naver-shopping-local-worker.mjs"
$localWorkerContractPath = Join-Path $runtimePath "src\server\naver-shopping\local-worker-contract.mjs"
$launcherPath = Join-Path $runtimePath "MomentInsightNaverShoppingHost.exe"
$taskPath = "\MomentInsight\"
$taskName = "NaverShoppingChrome"
$extensionId = "pflggephankeefaeoaafkmggampnaefm"
$sourceBase = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/tools/naver-shopping-chrome-extension"
$launcherSourceUrl = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/scripts/windows/MomentInsightNaverShoppingHost.cs"
$nativeHostScriptUrl = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/scripts/naver-shopping-native-host.mjs"
$localWorkerScriptUrl = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/scripts/naver-shopping-local-worker.mjs"
$localWorkerContractUrl = "https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/$ReleaseCommit/src/server/naver-shopping/local-worker-contract.mjs"
$files = @(
    "README.md",
    "icon16.png",
    "icon32.png",
    "icon48.png",
    "icon128.png",
    "manifest.json",
    "popup.css",
    "popup.html",
    "popup.js",
    "service-worker.js"
)

function Resolve-LoadedExtensionPath {
    param(
        [string]$ProfilePath,
        [string]$ExpectedExtensionId,
        [string]$ExpectedManifestKey
    )
    $pattern = [regex]::Escape($ExpectedExtensionId) + '.{0,500000}?"path":"([^"]+)"'
    foreach ($preferenceName in @("Secure Preferences", "Preferences")) {
        $preferencePath = Join-Path $ProfilePath $preferenceName
        if (-not (Test-Path -LiteralPath $preferencePath -PathType Leaf)) { continue }
        $preferenceText = [IO.File]::ReadAllText($preferencePath)
        foreach ($match in [regex]::Matches(
            $preferenceText,
            $pattern,
            [Text.RegularExpressions.RegexOptions]::Singleline
        )) {
            $candidatePath = $match.Groups[1].Value.Replace('\\', '\').Replace('\/', '/')
            try {
                $candidatePath = [IO.Path]::GetFullPath($candidatePath)
                $candidateManifestPath = Join-Path $candidatePath "manifest.json"
                if (-not (Test-Path -LiteralPath $candidateManifestPath -PathType Leaf)) { continue }
                $candidateManifest = Get-Content -LiteralPath $candidateManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ([string]$candidateManifest.key -eq $ExpectedManifestKey) { return $candidatePath }
            }
            catch {
                continue
            }
        }
    }
    throw "loaded_extension_path_missing"
}

if (-not (Test-Path -LiteralPath $extensionPath -PathType Container)) { throw "extension_path_missing" }
if (-not (Test-Path -LiteralPath $schedulerConfigPath -PathType Leaf)) { throw "scheduler_config_missing" }
if (-not (Test-Path -LiteralPath $nativeConfigPath -PathType Leaf)) { throw "native_config_missing" }
$schedulerConfig = @(Get-Content -LiteralPath $schedulerConfigPath -Encoding UTF8)
if ($schedulerConfig.Count -ne 2) { throw "scheduler_config_invalid" }
$profileDirectory = $schedulerConfig[1].Trim()
if ($profileDirectory -notmatch '^(Default|Profile [1-9][0-9]{0,2})$') { throw "chrome_profile_invalid" }
$profilePath = Join-Path $chromeUserDataPath $profileDirectory
if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) { throw "chrome_profile_missing" }
$runtimeManifest = Get-Content -LiteralPath (Join-Path $extensionPath "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$runtimeManifest.key)) { throw "extension_manifest_key_missing" }
$loadedExtensionPath = Resolve-LoadedExtensionPath `
    -ProfilePath $profilePath `
    -ExpectedExtensionId $extensionId `
    -ExpectedManifestKey ([string]$runtimeManifest.key)
$userProfileRoot = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\') + '\'
if (-not ($loadedExtensionPath + '\').StartsWith($userProfileRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "loaded_extension_path_outside_user_profile"
}
$extensionTargets = @($extensionPath, $loadedExtensionPath) | Sort-Object -Unique
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
    $localWorkerScriptBytes = $client.DownloadData($localWorkerScriptUrl)
    if (-not $localWorkerScriptBytes -or $localWorkerScriptBytes.Length -eq 0) { throw "local_worker_script_download_empty" }
    $localWorkerContractBytes = $client.DownloadData($localWorkerContractUrl)
    if (-not $localWorkerContractBytes -or $localWorkerContractBytes.Length -eq 0) { throw "local_worker_contract_download_empty" }
    $stagedLauncherSource = Join-Path $stagingPath "MomentInsightNaverShoppingHost.cs"
    $stagedNativeHostScript = Join-Path $stagingPath "naver-shopping-native-host.mjs"
    $stagedLocalWorkerScript = Join-Path $stagingPath "naver-shopping-local-worker.mjs"
    $stagedLocalWorkerContract = Join-Path $stagingPath "local-worker-contract.mjs"
    $stagedLauncher = Join-Path $stagingPath "MomentInsightNaverShoppingHost.exe"
    [IO.File]::WriteAllBytes($stagedLauncherSource, $launcherSourceBytes)
    [IO.File]::WriteAllBytes($stagedNativeHostScript, $nativeHostScriptBytes)
    [IO.File]::WriteAllBytes($stagedLocalWorkerScript, $localWorkerScriptBytes)
    [IO.File]::WriteAllBytes($stagedLocalWorkerContract, $localWorkerContractBytes)

    $manifestPath = Join-Path $stagingPath "manifest.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$manifest.version -ne $ExpectedVersion) { throw "extension_version_mismatch" }

    foreach ($scriptName in @("service-worker.js", "popup.js")) {
        & $nodePath --check (Join-Path $stagingPath $scriptName)
        if ($LASTEXITCODE -ne 0) { throw "extension_javascript_invalid:$scriptName" }
    }
    & $nodePath --check $stagedNativeHostScript
    if ($LASTEXITCODE -ne 0) { throw "native_host_javascript_invalid" }
    & $nodePath --check $stagedLocalWorkerScript
    if ($LASTEXITCODE -ne 0) { throw "local_worker_javascript_invalid" }
    & $nodePath --check $stagedLocalWorkerContract
    if ($LASTEXITCODE -ne 0) { throw "local_worker_contract_javascript_invalid" }
    $launcherMissing = -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)
    $launcherSourceChanged = -not (Test-Path -LiteralPath $launcherSourcePath -PathType Leaf) -or
        ((Get-FileHash -Algorithm SHA256 -LiteralPath $stagedLauncherSource).Hash -ne
            (Get-FileHash -Algorithm SHA256 -LiteralPath $launcherSourcePath).Hash)
    $launcherNeedsCompile = $launcherMissing -or $launcherSourceChanged
    if ($launcherNeedsCompile) {
        $compilerPath = Join-Path $env:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
        if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) {
            $compilerPath = Join-Path $env:SystemRoot "Microsoft.NET\Framework\v4.0.30319\csc.exe"
        }
        if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) { throw "windows_csharp_compiler_missing" }
        & $compilerPath /nologo /target:winexe "/out:$stagedLauncher" `
            /reference:System.dll /reference:System.Core.dll /reference:System.Security.dll `
            $stagedLauncherSource
        if ($LASTEXITCODE -ne 0) { throw "native_host_launcher_compile_failed" }
        if (-not (Test-Path -LiteralPath $stagedLauncher -PathType Leaf)) { throw "native_host_launcher_compile_failed" }
    }

    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "MomentInsightNaverShoppingHost.exe" -or
        ($_.Name -eq "node.exe" -and $_.CommandLine -like "*naver-shopping-native-host.mjs*")
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($targetPath in $extensionTargets) {
        foreach ($file in $files) {
            Copy-Item -LiteralPath (Join-Path $stagingPath $file) -Destination (Join-Path $targetPath $file) -Force
        }
        $targetManifest = Get-Content -LiteralPath (Join-Path $targetPath "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$targetManifest.version -ne $ExpectedVersion) { throw "loaded_extension_version_mismatch" }
    }
    if ($launcherSourceChanged) {
        New-Item -ItemType Directory -Path (Split-Path $launcherSourcePath -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $stagedLauncherSource -Destination $launcherSourcePath -Force
    }
    if ($launcherNeedsCompile) {
        Copy-Item -LiteralPath $stagedLauncher -Destination $launcherPath -Force
    }
    Copy-Item -LiteralPath $stagedNativeHostScript -Destination $nativeHostScriptPath -Force
    Copy-Item -LiteralPath $stagedLocalWorkerScript -Destination $localWorkerScriptPath -Force
    Copy-Item -LiteralPath $stagedLocalWorkerContract -Destination $localWorkerContractPath -Force
    Start-Sleep -Seconds 3
    Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName

    $serviceWorkerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $extensionPath "service-worker.js")).Hash.ToLowerInvariant()
    $loadedServiceWorkerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $loadedExtensionPath "service-worker.js")).Hash.ToLowerInvariant()
    if ($loadedServiceWorkerHash -ne $serviceWorkerHash) { throw "loaded_extension_hash_mismatch" }
    $launcherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $launcherPath).Hash.ToLowerInvariant()
    $nativeHostHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $nativeHostScriptPath).Hash.ToLowerInvariant()
    $localWorkerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localWorkerScriptPath).Hash.ToLowerInvariant()
    $localWorkerContractHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localWorkerContractPath).Hash.ToLowerInvariant()
    Write-Host "MI_EXTENSION_UPDATE_OK release=$ReleaseCommit version=$ExpectedVersion syntax=4 profile=$($profileDirectory.Replace(' ', '_')) loaded_extension_synced=true launcher_recompiled=$launcherNeedsCompile launcher_source_updated=$launcherSourceChanged service_worker_sha256=$serviceWorkerHash loaded_service_worker_sha256=$loadedServiceWorkerHash launcher_sha256=$launcherHash native_host_sha256=$nativeHostHash local_worker_sha256=$localWorkerHash local_worker_contract_sha256=$localWorkerContractHash"
}
finally {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
}
