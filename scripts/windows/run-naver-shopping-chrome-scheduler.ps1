[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$runtimePath = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$configPath = Join-Path $runtimePath "windows-chrome-scheduler.conf"
$logDirectory = Join-Path $env:LOCALAPPDATA "MomentInsight\Logs"
$logPath = Join-Path $logDirectory "naver-shopping-chrome-scheduler.log"

function Write-SafeLog {
    param([string]$Code)
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $timestamp = (Get-Date).ToUniversalTime().ToString("o")
    Add-Content -LiteralPath $logPath -Value "$timestamp $Code" -Encoding UTF8
}

try {
    $config = @(Get-Content -LiteralPath $configPath -Encoding UTF8)
    if ($config.Count -ne 2) { throw "scheduler_config_invalid" }
    $chromePath = [IO.Path]::GetFullPath($config[0].Trim())
    $profileDirectory = $config[1].Trim()
    if (-not (Test-Path -LiteralPath $chromePath -PathType Leaf)) { throw "chrome_missing" }
    if ($chromePath -notmatch '(?i)\\Google\\Chrome\\Application\\chrome\.exe$') { throw "chrome_path_invalid" }
    if ($profileDirectory -notmatch '^(Default|Profile [1-9][0-9]{0,2})$') { throw "chrome_profile_invalid" }
    $profilePath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\$profileDirectory"
    if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) { throw "chrome_profile_missing" }

    $processQueryErrors = @()
    $chromeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" `
        -ErrorAction SilentlyContinue -ErrorVariable processQueryErrors)
    if ($processQueryErrors.Count -gt 0) { throw "chrome_process_check_failed" }
    $currentSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $sessionChromeProcesses = @($chromeProcesses | Where-Object { [int]$_.SessionId -eq $currentSessionId })
    if (@($sessionChromeProcesses | Where-Object {
        [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath)
    }).Count -gt 0) { throw "chrome_process_metadata_unavailable" }
    $sameChromeRunning = @($sessionChromeProcesses | Where-Object {
        $executablePath = [IO.Path]::GetFullPath([string]$_.ExecutablePath)
        [string]::Equals($executablePath, $chromePath, [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    $profileArgument = '--profile-directory="{0}"' -f $profileDirectory
    if ($sameChromeRunning) {
        Start-Process -FilePath $chromePath -ArgumentList @(
            $profileArgument,
            "--no-startup-window",
            "--no-first-run",
            "--no-default-browser-check"
        ) -WindowStyle Hidden
        Write-SafeLog "chrome_profile_handoff profile=$profileDirectory"
        exit 0
    }
    Start-Process -FilePath $chromePath -ArgumentList @(
        $profileArgument,
        "--no-first-run",
        "--no-default-browser-check"
    ) -WindowStyle Minimized
    Write-SafeLog "chrome_ready profile=$profileDirectory"
    exit 0
}
catch {
    $code = if ($_.Exception.Message -match '^[a-z0-9_]+$') { $_.Exception.Message } else { "scheduler_failed" }
    Write-SafeLog $code
    exit 1
}
