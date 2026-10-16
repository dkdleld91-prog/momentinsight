# Moment Insight C 30-day rank (Coupang) collector - scheduled task wrapper (spec 9.5.3).
# ASCII only. Windows PowerShell 5.1. Runs as the signed-in user with RunLevel Limited.
# 1) load DPAPI types  2) read collector.json as UTF-8  3) unprotect the connection code into this process only
# 4) run worker.mjs (or trial.mjs with -Mode trial), log the exit code, clear the variable. Always exit 0.
param(
    [ValidateSet('worker', 'trial')]
    [string]$Mode = 'worker'
)
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $appDir
$logDir = Join-Path $root 'logs'
$logPath = Join-Path $logDir 'worker.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-RunnerLog([string]$EventText) {
    try {
        if (-not (Test-Path -LiteralPath $logDir -PathType Container)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
        $stamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
        [System.IO.File]::AppendAllText($logPath, "$stamp $EventText`n", $utf8NoBom)
    }
    catch {
    }
}

$plainToken = $null
$tokenBytes = $null
try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop

    $configPath = Join-Path $root 'collector.json'
    $configText = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
    if ($configText.Length -gt 0 -and $configText[0] -eq [char]0xFEFF) { $configText = $configText.Substring(1) }
    $config = $configText | ConvertFrom-Json
    $nodePath = [string]$config.nodePath
    $browserPath = [string]$config.browser.path
    if ([string]::IsNullOrWhiteSpace($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        Write-RunnerLog 'runner_config_invalid field=nodePath'
        exit 0
    }
    if ([string]$config.browser.kind -ne 'edge' -or $browserPath -notmatch '\\Microsoft\\Edge\\Application\\msedge\.exe$' -or -not (Test-Path -LiteralPath $browserPath -PathType Leaf)) {
        Write-RunnerLog 'runner_config_invalid field=browser.path'
        exit 0
    }

    if ($Mode -eq 'trial') {
        & $nodePath (Join-Path $appDir 'trial.mjs')
        Write-RunnerLog "runner_exit mode=trial code=$LASTEXITCODE"
        exit 0
    }

    $tokenPath = Join-Path $root 'coupang-token.dpapi'
    try {
        $encoded = ([System.IO.File]::ReadAllText($tokenPath, [System.Text.Encoding]::UTF8)).Trim()
        $entropy = [System.Text.Encoding]::UTF8.GetBytes('co.kr.momentinsight.coupang-rank-collector.v1')
        $tokenBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            [Convert]::FromBase64String($encoded),
            $entropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $plainToken = [System.Text.Encoding]::UTF8.GetString($tokenBytes)
    }
    catch {
        Write-RunnerLog 'dpapi_unprotect_failed'
        exit 0
    }
    finally {
        if ($tokenBytes) { [Array]::Clear($tokenBytes, 0, $tokenBytes.Length) }
    }

    $env:MI_COUPANG_COLLECTOR_TOKEN = $plainToken
    $plainToken = $null
    try {
        & $nodePath (Join-Path $appDir 'worker.mjs')
        $exitCode = $LASTEXITCODE
    }
    finally {
        Remove-Item -Path 'Env:\MI_COUPANG_COLLECTOR_TOKEN' -ErrorAction SilentlyContinue
    }
    Write-RunnerLog "runner_exit mode=worker code=$exitCode"
}
catch {
    Write-RunnerLog 'runner_failed'
}
finally {
    $plainToken = $null
    Remove-Item -Path 'Env:\MI_COUPANG_COLLECTOR_TOKEN' -ErrorAction SilentlyContinue
}
exit 0
