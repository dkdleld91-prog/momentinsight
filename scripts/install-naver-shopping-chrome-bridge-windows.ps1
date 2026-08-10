[CmdletBinding()]
param(
    [string]$RepositoryPath = "",
    [string]$ProfileName = "",
    [Security.SecureString]$WorkerSecret
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepositoryPath)) {
    $RepositoryPath = Split-Path -Path $PSScriptRoot -Parent
}
$hostName = "co.kr.momentinsight.naver_shopping"
$extensionId = "pflggephankeefaeoaafkmggampnaefm"
$productionApiUrl = "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker"
$entropyLabel = "co.kr.momentinsight.naver-shopping-local-worker.v1"
$taskPath = "\MomentInsight\"
$taskName = "NaverShoppingChrome"

function Write-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Resolve-ChromePath {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe" })
    ) | Where-Object { $_ }
    $match = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $match) { throw "chrome_application_missing" }
    return [IO.Path]::GetFullPath($match)
}

function Resolve-ProfileDirectory {
    param([string]$VisibleName)
    $localStatePath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Local State"
    if (-not (Test-Path -LiteralPath $localStatePath -PathType Leaf)) { throw "chrome_local_state_missing" }
    $localState = Get-Content -LiteralPath $localStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $profiles = $localState.profile.info_cache.psobject.Properties
    $eligibleProfiles = @($profiles | Where-Object {
        $_.Name -match '^(Default|Profile [1-9][0-9]{0,2})$' -and
        -not [string]::IsNullOrWhiteSpace([string]$_.Value.name)
    })
    $match = $eligibleProfiles | Where-Object {
        [string]$_.Value.name -eq $VisibleName
    } | Select-Object -First 1
    if (-not $match -and $VisibleName -match '^[1-9][0-9]*$') {
        $profileIndex = [int]$VisibleName - 1
        if ($profileIndex -lt $eligibleProfiles.Count) {
            $match = $eligibleProfiles[$profileIndex]
        }
    }
    if (-not $match) {
        $available = ($profiles | ForEach-Object { [string]$_.Value.name } | Where-Object { $_ }) -join ", "
        throw "chrome_profile_not_found:$VisibleName available=$available"
    }
    return $match.Name
}

if ($env:OS -ne "Windows_NT") { throw "windows_only_installer" }
if ($PSVersionTable.PSEdition -ne "Desktop") {
    throw "run_with_windows_powershell_5_1_not_pwsh"
}
Add-Type -AssemblyName System.Security -ErrorAction Stop
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "administrator_shell_required"
}

$repositoryRoot = [IO.Path]::GetFullPath($RepositoryPath)
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = [IO.Path]::GetFullPath($nodeCommand.Source)
$nodeVersion = & $nodePath -p "process.versions.node"
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 22 -or $nodeMajor -ge 25) { throw "node_version_must_be_22_to_24" }
$chromePath = Resolve-ChromePath
if ([string]::IsNullOrWhiteSpace($ProfileName)) {
    $localState = Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Local State") -Raw -Encoding UTF8 | ConvertFrom-Json
    $profileOptions = @($localState.profile.info_cache.psobject.Properties | Where-Object {
        $_.Name -match '^(Default|Profile [1-9][0-9]{0,2})$' -and
        -not [string]::IsNullOrWhiteSpace([string]$_.Value.name)
    })
    for ($profileIndex = 0; $profileIndex -lt $profileOptions.Count; $profileIndex += 1) {
        Write-Host ("[{0}] {1}" -f ($profileIndex + 1), [string]$profileOptions[$profileIndex].Value.name)
    }
    $ProfileName = Read-Host "Chrome profile visible name or number"
}
if ([string]::IsNullOrWhiteSpace($ProfileName)) { throw "chrome_profile_name_required" }
$profileDirectory = Resolve-ProfileDirectory -VisibleName $ProfileName

$runtimePath = Join-Path $env:LOCALAPPDATA "MomentInsight\NaverShoppingBridge"
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$directoryAcl = New-Object Security.AccessControl.DirectorySecurity
$directoryAcl.SetAccessRuleProtection($true, $false)
$directoryRule = New-Object Security.AccessControl.FileSystemAccessRule(
    $identity.Name,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
)
$directoryAcl.AddAccessRule($directoryRule)
Set-Acl -LiteralPath $runtimePath -AclObject $directoryAcl

$runtimeFiles = @(
    "scripts/naver-shopping-native-host.mjs",
    "scripts/naver-shopping-native-host-core.mjs",
    "scripts/naver-shopping-local-worker.mjs",
    "scripts/windows/MomentInsightNaverShoppingHost.cs",
    "scripts/windows/run-naver-shopping-chrome-scheduler.ps1",
    "src/server/local-worker-auth.mjs",
    "src/server/security.mjs",
    "src/server/handlers/naver-shopping-rank.mjs",
    "src/server/naver-shopping/local-worker-contract.mjs",
    "src/server/naver-shopping/source-status.mjs",
    "src/server/naver-shopping/provider-runtime.mjs",
    "src/server/naver-shopping/mobile-top-fallback.mjs",
    "tools/naver-shopping-rank-collector/src/contract.mjs",
    "tools/naver-shopping-rank-collector/src/provider.mjs",
    "tools/naver-shopping-chrome-extension/README.md",
    "tools/naver-shopping-chrome-extension/icon16.png",
    "tools/naver-shopping-chrome-extension/icon32.png",
    "tools/naver-shopping-chrome-extension/icon48.png",
    "tools/naver-shopping-chrome-extension/icon128.png",
    "tools/naver-shopping-chrome-extension/manifest.json",
    "tools/naver-shopping-chrome-extension/popup.css",
    "tools/naver-shopping-chrome-extension/popup.html",
    "tools/naver-shopping-chrome-extension/popup.js",
    "tools/naver-shopping-chrome-extension/service-worker.js"
)
foreach ($relativePath in $runtimeFiles) {
    $sourcePath = Join-Path $repositoryRoot ($relativePath -replace '/', '\')
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "runtime_file_missing:$relativePath" }
    $destinationPath = Join-Path $runtimePath ($relativePath -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path $destinationPath -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

if (-not $WorkerSecret) {
    $WorkerSecret = Read-Host "Moment Insight production worker secret" -AsSecureString
}
$secretPointer = [IntPtr]::Zero
$secretBytes = $null
$protectedBytes = $null
try {
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($WorkerSecret)
    $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    if ($plainSecret.Length -lt 32) { throw "worker_secret_missing_or_weak" }
    $secretBytes = [Text.Encoding]::UTF8.GetBytes($plainSecret)
    $entropy = [Text.Encoding]::UTF8.GetBytes($entropyLabel)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $secretBytes,
        $entropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    Write-Utf8NoBom -Path (Join-Path $runtimePath "windows-worker-secret.dpapi") -Value ([Convert]::ToBase64String($protectedBytes))
}
finally {
    $plainSecret = $null
    if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    if ($secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
    if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
}

Write-Utf8NoBom -Path (Join-Path $runtimePath "windows-native-host.conf") -Value "$nodePath`n$productionApiUrl`n1`n"
Write-Utf8NoBom -Path (Join-Path $runtimePath "windows-chrome-scheduler.conf") -Value "$chromePath`n$profileDirectory`n"

$launcherSource = Join-Path $runtimePath "scripts\windows\MomentInsightNaverShoppingHost.cs"
$launcherPath = Join-Path $runtimePath "MomentInsightNaverShoppingHost.exe"
Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
Add-Type -Path $launcherSource -OutputAssembly $launcherPath -OutputType WindowsApplication -ReferencedAssemblies @(
    "System.dll",
    "System.Core.dll",
    "System.Security.dll"
) -PassThru | Out-Null
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw "native_host_launcher_compile_failed" }

$nativeManifestPath = Join-Path $runtimePath "$hostName.json"
$nativeManifest = [ordered]@{
    name = $hostName
    description = "Moment Insight N Shopping signed Windows bridge"
    path = $launcherPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json -Depth 4
Write-Utf8NoBom -Path $nativeManifestPath -Value "$nativeManifest`n"

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $nativeManifestPath

$schedulerPath = Join-Path $runtimePath "scripts\windows\run-naver-shopping-chrome-scheduler.ps1"
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$taskAction = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$schedulerPath`""
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 10) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$schedulerService = New-Object -ComObject "Schedule.Service"
$schedulerService.Connect()
$schedulerRoot = $schedulerService.GetFolder("\")
try {
    $null = $schedulerService.GetFolder($taskPath)
}
catch {
    $null = $schedulerRoot.CreateFolder("MomentInsight")
}
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $taskAction `
    -Trigger @($repeatTrigger, $logonTrigger) -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName

$profileArgument = '--profile-directory="{0}"' -f $profileDirectory
Start-Process -FilePath $chromePath -ArgumentList @(
    $profileArgument,
    "chrome://extensions"
)

[PSCustomObject]@{
    ok = $true
    extensionId = $extensionId
    extensionPath = (Join-Path $runtimePath "tools\naver-shopping-chrome-extension")
    profileName = $ProfileName
    profileDirectory = $profileDirectory
    nativeHostManifest = $nativeManifestPath
    registryPath = $registryPath
    scheduledTask = "$taskPath$taskName"
    nextStep = "Enable Chrome developer mode and use Load unpacked with extensionPath"
}
