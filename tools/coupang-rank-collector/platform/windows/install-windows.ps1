# Moment Insight C 30-day rank (Coupang) collector - Windows installer / updater / trial / uninstaller (spec 9.5.2).
# ASCII only. Run in an elevated Windows PowerShell 5.1 (Desktop) shell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\mi-coupang-install.ps1" -Release abc1234 [-ResetToken] [-TrialOnly] [-Uninstall]
# Uses Microsoft Edge only (msedge.exe) with a fresh temporary profile per keyword under
# %LOCALAPPDATA%\MomentInsight\CoupangRank\runs\. It never reads or writes the N30 folders or logs and only stops
# processes whose command line contains our own runs folder (or, for -Uninstall, our own worker/trial node scripts).
# The connection code is stored with DPAPI (CurrentUser). The scheduled task runs as the signed-in user, RunLevel Limited.
param(
    [string]$Release = '',
    [switch]$ResetToken,
    [switch]$TrialOnly,
    [switch]$Uninstall
)
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$PublicOrigin = 'https://insight.momentlabs.co.kr'
$BundleUrl = 'https://insight.momentlabs.co.kr/coupang-collector/bundle.json'
$TaskPath = '\MomentInsight\'
$TaskName = 'CoupangRank'
$TrialTaskName = 'CoupangRankTrial'
$EntropyLabel = 'co.kr.momentinsight.coupang-rank-collector.v1'
$TokenPattern = '^mic1_[A-Za-z0-9_-]{43}$'
$EdgePathPattern = '\\Microsoft\\Edge\\Application\\msedge\.exe$'
$RunsMarker = '\MomentInsight\CoupangRank\runs\'
$WorkerMarker = '\CoupangRank\app\worker.mjs'
$TrialMarker = '\CoupangRank\app\trial.mjs'
$Root = Join-Path $env:LOCALAPPDATA 'MomentInsight\CoupangRank'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
# Default trial input (spec 9.4). Non-ASCII keywords are JSON \u escapes so this file stays ASCII.
$TrialJson = '{"keywords":["\uc544\uc774\ud3f0 18\ud504\ub85c \uc0ac\uc0dd\ud65c \ubcf4\ud638 \ud544\ub984"],"casePair":["iPhone 17 \ucf00\uc774\uc2a4","iphone 17 \ucf00\uc774\uc2a4"],"modes":["normal","offscreen","minimized"],"gapSeconds":[240,360]}'

function Stop-Install([string]$Code) {
    throw "MI_COUPANG_FAIL:$Code"
}

function Write-Utf8File([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Read-SharedText([string]$Path) {
    $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        return $reader.ReadToEnd()
    }
    finally {
        $stream.Dispose()
    }
}

# Native commands: keep stderr from turning into terminating errors under ErrorActionPreference=Stop.
function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @Arguments 2>&1 | ForEach-Object { [string]$_ }
        return [PSCustomObject]@{ Code = $LASTEXITCODE; Output = (@($output) -join "`n") }
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Test-InstallEnvironment {
    if ($env:OS -ne 'Windows_NT') { Stop-Install 'powershell_51_admin_required' }
    if ($PSVersionTable.PSEdition -ne 'Desktop') { Stop-Install 'powershell_51_admin_required' }
    $version = $PSVersionTable.PSVersion
    if ($version.Major -ne 5 -or $version.Minor -lt 1) { Stop-Install 'powershell_51_admin_required' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Stop-Install 'powershell_51_admin_required' }
    # PowerShell 5.1 does not load the DPAPI types by default (P4).
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

function Resolve-Node {
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Stop-Install 'node_version_must_be_22_to_24' }
    $node = [System.IO.Path]::GetFullPath($node)
    $result = Invoke-Native $node @('-p', 'process.versions.node')
    $nodeVersion = ([string]$result.Output).Trim()
    if ($result.Code -ne 0 -or $nodeVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Stop-Install 'node_version_must_be_22_to_24' }
    $major = [int]($nodeVersion -split '\.')[0]
    if ($major -lt 22 -or $major -gt 24) { Stop-Install 'node_version_must_be_22_to_24' }
    return [PSCustomObject]@{ Path = $node; Version = $nodeVersion }
}

function Resolve-Edge {
    $candidates = @()
    try {
        $registered = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction Stop).'(default)'
        if ($registered) { $candidates += ([string]$registered).Trim().Trim('"').Trim() }
    }
    catch {
    }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe') }
    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        if ($candidate -notmatch $EdgePathPattern) { continue }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $full = [System.IO.Path]::GetFullPath($candidate)
        $edgeVersion = [string](Get-Item -LiteralPath $full).VersionInfo.ProductVersion
        if ($edgeVersion -notmatch '^[0-9]+(\.[0-9]+){1,3}$') { $edgeVersion = 'unknown' }
        return [PSCustomObject]@{ Path = $full; Version = $edgeVersion }
    }
    Stop-Install 'edge_not_found'
}

function Initialize-Folders {
    foreach ($name in @('', 'runs', 'outbox', 'state', 'logs', 'trial-results')) {
        $path = if ($name) { Join-Path $Root $name } else { $Root }
        if (-not (Test-Path -LiteralPath $path -PathType Container)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    }
}

# Download bundle.json as bytes and decode as UTF-8 (P5). Verify release, per-file sha256 of the UTF-8 bytes, syntax.
function Get-Bundle([string]$NodePath) {
    $client = New-Object System.Net.WebClient
    try {
        $raw = $client.DownloadData($BundleUrl)
    }
    catch {
        Stop-Install 'bundle_download_failed'
    }
    finally {
        $client.Dispose()
    }
    try {
        $bundle = [System.Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json
    }
    catch {
        Stop-Install 'bundle_invalid'
    }
    if ($bundle.schema -ne 1) { Stop-Install 'bundle_invalid' }
    if ([string]$bundle.release -cne $Release) { Stop-Install 'release_mismatch' }
    $bundleVersion = [string]$bundle.version
    if ($bundleVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Stop-Install 'bundle_invalid' }
    $newDir = Join-Path $Root 'app.new'
    if (Test-Path -LiteralPath $newDir) { Remove-Item -LiteralPath $newDir -Recurse -Force }
    New-Item -ItemType Directory -Path $newDir -Force | Out-Null
    $seen = @{}
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        foreach ($f in @($bundle.files)) {
            $relative = [string]$f.path
            if ($relative -cnotmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$' -or $relative.Contains('..')) { Stop-Install 'bundle_invalid' }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$f.content)
            $hash = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
            if ($hash -cne [string]$f.sha256) { Stop-Install 'bundle_hash_mismatch' }
            $target = Join-Path $newDir ($relative -replace '/', '\')
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            [System.IO.File]::WriteAllBytes($target, $bytes)
            $seen[$relative] = $true
        }
    }
    finally {
        $sha.Dispose()
    }
    foreach ($required in @('worker.mjs', 'trial.mjs', 'run-worker.ps1', 'lib/contract.mjs')) {
        if (-not $seen.ContainsKey($required)) { Stop-Install 'bundle_invalid' }
    }
    foreach ($file in Get-ChildItem -LiteralPath $newDir -Recurse -File) {
        if ($file.Extension -eq '.mjs') {
            $check = Invoke-Native $NodePath @('--check', $file.FullName)
            if ($check.Code -ne 0) { Stop-Install 'bundle_syntax_invalid' }
        }
        elseif ($file.Extension -eq '.ps1') {
            $tokens = $null
            $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
            if ($errors -and $errors.Count -gt 0) { Stop-Install 'bundle_syntax_invalid' }
        }
    }
    Write-Utf8File (Join-Path $newDir 'VERSION') "$bundleVersion $Release`n"
    return $bundleVersion
}

function Get-MainTask {
    return Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Wait-WorkerLock {
    $lockDir = Join-Path $Root 'state\worker.lock'
    $deadline = (Get-Date).AddSeconds(60)
    while ((Test-Path -LiteralPath $lockDir) -and ((Get-Date) -lt $deadline)) {
        Start-Sleep -Seconds 2
    }
}

# Only Edge processes whose command line contains our runs folder.
function Stop-OurBrowsers {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine -and $commandLine.IndexOf($RunsMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

# Only node processes running our own worker.mjs or trial.mjs (M7).
function Stop-OurNodes {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if (-not $commandLine) { continue }
        if ($commandLine.IndexOf($WorkerMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine.IndexOf($TrialMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Install-App {
    $appDir = Join-Path $Root 'app'
    $newDir = Join-Path $Root 'app.new'
    $oldDir = Join-Path $Root 'app.old'
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            # Keep app.old when app is already gone (a previous attempt renamed it), so a failed swap never loses both.
            if ((Test-Path -LiteralPath $oldDir) -and (Test-Path -LiteralPath $appDir)) { Remove-Item -LiteralPath $oldDir -Recurse -Force }
            if (Test-Path -LiteralPath $appDir) { Rename-Item -LiteralPath $appDir -NewName 'app.old' }
            Rename-Item -LiteralPath $newDir -NewName 'app'
            if (Test-Path -LiteralPath $oldDir) { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue }
            return
        }
        catch {
            Start-Sleep -Seconds 3
        }
    }
    Stop-Install 'app_replace_failed'
}

function Set-RootAcl {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $identity.Name,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Root -AclObject $acl
}

function Write-CollectorConfig([string]$NodePath, [string]$EdgePath) {
    $config = [ordered]@{
        schema = 1
        platform = 'windows'
        apiBase = $PublicOrigin
        nodePath = $NodePath
        browser = [ordered]@{ kind = 'edge'; path = $EdgePath }
        chromeGuard = $null
    } | ConvertTo-Json -Depth 4
    Write-Utf8File (Join-Path $Root 'collector.json') "$config`n"
}

function Set-ConnectionCode {
    $tokenPath = Join-Path $Root 'coupang-token.dpapi'
    if ((Test-Path -LiteralPath $tokenPath -PathType Leaf) -and -not $ResetToken) { return }
    $secure = Read-Host -AsSecureString 'Paste connection code'
    $pointer = [IntPtr]::Zero
    $plainBytes = $null
    $protectedBytes = $null
    $plain = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($null -ne $plain) { $plain = $plain.Trim() }
        if ($plain -cnotmatch $TokenPattern) { Stop-Install 'connection_code_invalid' }
        $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
        $entropy = [System.Text.Encoding]::UTF8.GetBytes($EntropyLabel)
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        Write-Utf8File $tokenPath ([Convert]::ToBase64String($protectedBytes))
    }
    finally {
        $plain = $null
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
        if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    }
}

function Read-ConnectionCode {
    $tokenPath = Join-Path $Root 'coupang-token.dpapi'
    $tokenBytes = $null
    try {
        $encoded = ([System.IO.File]::ReadAllText($tokenPath, [System.Text.Encoding]::UTF8)).Trim()
        $entropy = [System.Text.Encoding]::UTF8.GetBytes($EntropyLabel)
        $tokenBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            [Convert]::FromBase64String($encoded),
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [System.Text.Encoding]::UTF8.GetString($tokenBytes)
    }
    catch {
        Stop-Install 'dpapi_unprotect_failed'
    }
    finally {
        if ($tokenBytes) { [Array]::Clear($tokenBytes, 0, $tokenBytes.Length) }
    }
}

function Initialize-TaskFolder {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    try {
        $null = $service.GetFolder('\MomentInsight')
    }
    catch {
        $null = $service.GetFolder('\').CreateFolder('MomentInsight')
    }
}

function New-RunnerAction([string]$Mode) {
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $runner = Join-Path $Root 'app\run-worker.ps1'
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -Mode $Mode"
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    if ([Environment]::OSVersion.Version.Build -ge 19041 -and (Test-Path -LiteralPath $conhost -PathType Leaf)) {
        # conhost.exe --headless: no console window (Windows 10 2004+).
        return New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$powershellExe`" $arguments"
    }
    return New-ScheduledTaskAction -Execute $powershellExe -Argument "-WindowStyle Hidden $arguments"
}

function New-RunnerPrincipal {
    # Signed-in user only, never SYSTEM, never "run whether user is logged on or not".
    return New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
}

function Register-MainTask {
    Initialize-TaskFolder
    $action = New-RunnerAction 'worker'
    $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $logonTrigger.Delay = 'PT2M'
    $principal = New-RunnerPrincipal
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -Priority 7
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $action -Trigger @($repeatTrigger, $logonTrigger) -Principal $principal -Settings $settings -Force | Out-Null
}

function Register-TrialTask {
    Initialize-TaskFolder
    $action = New-RunnerAction 'trial'
    $principal = New-RunnerPrincipal
    # Same run style as the main task (Limited, interactive, conhost --headless, priority 7), 45-minute limit.
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -Priority 7
    Register-ScheduledTask -TaskPath $TaskPath -TaskName $TrialTaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
}

function Remove-TaskIfPresent([string]$Name) {
    $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $Name -ErrorAction SilentlyContinue
    if ($task) { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $Name -Confirm:$false }
}

function Get-UtcStamp {
    return [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

function Invoke-HelloOnly([string]$NodePath) {
    $token = Read-ConnectionCode
    try {
        $env:MI_COUPANG_COLLECTOR_TOKEN = $token
        $token = $null
        $result = Invoke-Native $NodePath @((Join-Path $Root 'app\worker.mjs'), '--hello-only')
    }
    finally {
        $token = $null
        Remove-Item -Path 'Env:\MI_COUPANG_COLLECTOR_TOKEN' -ErrorAction SilentlyContinue
    }
    if ([string]$result.Output -match 'auth=([a-z_]+)') { return $Matches[1] }
    return 'error'
}

function Wait-FirstRun([string]$SinceStamp) {
    $logPath = Join-Path $Root 'logs\worker.log'
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { continue }
        try {
            $lines = (Read-SharedText $logPath) -split "`n"
        }
        catch {
            continue
        }
        for ($index = $lines.Length - 1; $index -ge 0; $index--) {
            $line = $lines[$index].Trim()
            if ($line -match 'mode=hello_only') { continue }
            if ($line -notmatch '^(\S+) run_end ') { continue }
            $stamp = $Matches[1]
            if ([string]::CompareOrdinal($stamp, $SinceStamp) -lt 0) { break }
            if ($line -match 'reason=(\S+)') { return $Matches[1] }
            return 'done'
        }
    }
    return 'pending'
}

function Invoke-TrialOnly([bool]$RestoreMainTask) {
    Write-Utf8File (Join-Path $Root 'trial.json') "$TrialJson`n"
    $summaryPath = Join-Path $Root 'trial-results\summary.txt'
    Remove-Item -LiteralPath $summaryPath -Force -ErrorAction SilentlyContinue
    $line = $null
    try {
        Register-TrialTask
        $since = Get-Date
        Start-ScheduledTask -TaskPath $TaskPath -TaskName $TrialTaskName
        Start-Sleep -Seconds 15
        $deadline = $since.AddMinutes(46)
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
                $line = ((Read-SharedText $summaryPath) -split "`n")[0].Trim()
                if ($line) { break }
            }
            $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TrialTaskName -ErrorAction SilentlyContinue
            if (-not $task -or ($task.State -ne 'Running' -and $task.State -ne 'Queued')) {
                Start-Sleep -Seconds 5
                if (Test-Path -LiteralPath $summaryPath -PathType Leaf) { $line = ((Read-SharedText $summaryPath) -split "`n")[0].Trim() }
                break
            }
            Start-Sleep -Seconds 10
        }
    }
    finally {
        Remove-TaskIfPresent $TrialTaskName
        if ($RestoreMainTask) { Enable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null }
    }
    if (-not $line) { Stop-Install 'trial_no_result' }
    Write-Output $line
}

function Invoke-Uninstall {
    Remove-TaskIfPresent $TaskName
    Remove-TaskIfPresent $TrialTaskName
    Stop-OurNodes
    Stop-OurBrowsers
    Start-Sleep -Seconds 2
    if (Test-Path -LiteralPath $Root) {
        $removed = $false
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            try {
                Remove-Item -LiteralPath $Root -Recurse -Force
                $removed = $true
                break
            }
            catch {
                Stop-OurBrowsers
                Start-Sleep -Seconds 3
            }
        }
        if (-not $removed) { Stop-Install 'uninstall_remove_failed' }
    }
    Write-Output 'MI_COUPANG_UNINSTALL_OK'
}

try {
    if ($Release -cnotmatch '^[0-9a-f]{7}$') { Stop-Install 'release_invalid' }
    Test-InstallEnvironment
    if ($Uninstall) {
        Invoke-Uninstall
        exit 0
    }
    $nodeInfo = Resolve-Node
    $edgeInfo = Resolve-Edge
    Initialize-Folders
    $bundleVersion = Get-Bundle $nodeInfo.Path

    $existingTask = Get-MainTask
    $mainWasEnabled = $false
    if ($existingTask) {
        $mainWasEnabled = ([string]$existingTask.State -ne 'Disabled')
        Disable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName | Out-Null
    }
    Wait-WorkerLock
    Stop-OurBrowsers
    Install-App
    Set-RootAcl
    Write-CollectorConfig $nodeInfo.Path $edgeInfo.Path
    if ($edgeInfo.Version -ne 'unknown') { Write-Utf8File (Join-Path $Root 'state\browser-version') "$($edgeInfo.Version)`n" }

    if ($TrialOnly) {
        Invoke-TrialOnly ([bool]($existingTask -and $mainWasEnabled))
        exit 0
    }

    Set-ConnectionCode
    Register-MainTask
    $auth = Invoke-HelloOnly $nodeInfo.Path
    if ($auth -ne 'ok') {
        Disable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
        Stop-Install "auth_$auth"
    }
    $since = Get-UtcStamp
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
    $firstRun = Wait-FirstRun $since
    $taskState = [string](Get-MainTask).State
    Write-Output "MI_COUPANG_INSTALL_OK release=$Release version=$bundleVersion node=$($nodeInfo.Version) browser=edge/$($edgeInfo.Version) task=$taskState auth=ok first_run=$firstRun"
    exit 0
}
catch {
    $message = [string]$_.Exception.Message
    if ($message -match '^MI_COUPANG_FAIL:([a-z0-9_]+)$') {
        $code = $Matches[1]
    }
    else {
        $code = 'unexpected_error'
        Write-Host ('detail: ' + $message)
    }
    Write-Output "MI_COUPANG_INSTALL_FAIL code=$code"
    exit 1
}
