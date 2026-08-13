import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const installerPath = new URL("./install-naver-shopping-chrome-bridge-windows.ps1", import.meta.url);
const launcherPath = new URL("./windows/MomentInsightNaverShoppingHost.cs", import.meta.url);
const schedulerPath = new URL("./windows/run-naver-shopping-chrome-scheduler.ps1", import.meta.url);
const updaterPath = new URL("./windows/update-naver-shopping-chrome-extension.ps1", import.meta.url);
const entrypointPath = new URL("../INSTALL-NAVER-SHOPPING-WINDOWS.cmd", import.meta.url);
const installer = fs.readFileSync(installerPath, "utf8");
const launcher = fs.readFileSync(launcherPath, "utf8");
const scheduler = fs.readFileSync(schedulerPath, "utf8");
const updater = fs.readFileSync(updaterPath, "utf8");
const entrypoint = fs.readFileSync(entrypointPath, "utf8");

test("Windows installer targets one exact Chrome profile and stable extension source", () => {
  assert.doesNotMatch(installer, /\$RepositoryPath = \(Split-Path \$PSScriptRoot/u);
  assert.match(installer, /\$RepositoryPath = Split-Path -Path \$PSScriptRoot -Parent/u);
  assert.match(installer, /\$ProfileName = ""/u);
  assert.match(installer, /Chrome profile visible name or number/u);
  assert.match(installer, /\$VisibleName -match '\^\[1-9\]\[0-9\]\*\$'/u);
  assert.match(installer, /\$eligibleProfiles\[\$profileIndex\]/u);
  assert.match(installer, /Add-Type -AssemblyName System\.Security -ErrorAction Stop/u);
  assert.match(installer, /'--profile-directory="\{0\}"' -f \$profileDirectory/u);
  assert.match(installer, /Google\\Chrome\\User Data\\Local State/u);
  assert.match(installer, /chrome_profile_not_found/u);
  assert.match(installer, /\$profileDirectory = Resolve-ProfileDirectory/u);
  assert.match(installer, /tools\/naver-shopping-chrome-extension\/service-worker\.js/u);
  assert.match(installer, /tools\/naver-shopping-chrome-extension\/icon128\.png/u);
  assert.match(installer, /chrome:\/\/extensions/u);
  assert.match(installer, /extensionPath = \(Join-Path \$runtimePath/u);
  assert.doesNotMatch(installer, /return "Default"/u);
  assert.match(entrypoint, /WindowsPowerShell\\v1\.0\\powershell\.exe/u);
  assert.match(entrypoint, /install-naver-shopping-chrome-bridge-windows\.ps1/u);
  assert.doesNotMatch(entrypoint, /WorkerSecret|LOCAL_WORKER_SECRET/u);
});

test("Windows native host uses HKCU registration, DPAPI and one-way output relay", () => {
  assert.match(installer, /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/u);
  assert.match(installer, /allowed_origins/u);
  assert.match(installer, /chrome-extension:\/\/\$extensionId\//u);
  assert.match(installer, /ProtectedData\]::Protect/u);
  assert.match(installer, /DataProtectionScope\]::CurrentUser/u);
  assert.ok(installer.includes("Read-Host \"Moment Insight production worker secret\" -AsSecureString"));
  assert.doesNotMatch(installer, /-AsPlainText|cmdkey/iu);

  assert.match(launcher, /ProtectedData\.Unprotect/u);
  assert.match(launcher, /DataProtectionScope\.CurrentUser/u);
  assert.match(launcher, /RedirectStandardInput = false/u);
  assert.match(launcher, /RedirectStandardOutput = true/u);
  assert.match(launcher, /RedirectStandardError = false/u);
  assert.doesNotMatch(launcher, /Console\.OpenStandardInput\(\)|StandardInput\.BaseStream/u);
  assert.match(launcher, /child\.StandardOutput\.BaseStream\.CopyTo\(output\)/u);
  assert.match(launcher, /outputRelay\.Join\(5000\)/u);
  assert.ok(launcher.indexOf("child.WaitForExit();") < launcher.indexOf("singleInstance.ReleaseMutex();"));
  assert.ok(launcher.indexOf("singleInstance.ReleaseMutex();") < launcher.indexOf("outputRelay.Join(5000)"));
  assert.match(launcher, /MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET/u);
  assert.match(launcher, /MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS"\] = maxJobs/u);
  assert.match(launcher, /MI_NAVER_SHOPPING_WORKER_ID"\] = "windows-desktop-primary"/u);
  assert.match(launcher, /MI_NAVER_SHOPPING_WORKER_ROLE"\] = "primary"/u);
  assert.doesNotMatch(launcher, /NAVER_SHOPPING_PROVIDER_TIMEOUT_MS/u);
  assert.match(launcher, /SingleInstanceMutexName/u);
  assert.match(launcher, /native_host_already_running/u);
  assert.match(launcher, /child\.WaitForExit\(\)/u);
  assert.doesNotMatch(launcher, /Console\.(?:Write|WriteLine)/u);
});

test("Windows watchdog stays interactive, bounded and free of browser bypass flags", () => {
  assert.match(installer, /administrator_shell_required/u);
  assert.match(installer, /node_version_must_be_22_to_24/u);
  assert.match(installer, /New-ScheduledTaskTrigger -Once/u);
  assert.match(installer, /New-TimeSpan -Minutes 10/u);
  assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn/u);
  assert.match(installer, /Schedule\.Service/u);
  assert.match(installer, /CreateFolder\("MomentInsight"\)/u);
  assert.match(installer, /-LogonType Interactive -RunLevel Limited/u);
  assert.match(installer, /-MultipleInstances IgnoreNew/u);
  assert.match(scheduler, /'--profile-directory="\{0\}"' -f \$profileDirectory/u);
  assert.match(scheduler, /Get-CimInstance Win32_Process -Filter "Name = 'chrome\.exe'"/u);
  assert.match(scheduler, /chrome_process_check_failed/u);
  assert.match(scheduler, /chrome_process_metadata_unavailable/u);
  assert.match(scheduler, /GetCurrentProcess\(\)\.SessionId/u);
  assert.match(scheduler, /StringComparison\]::OrdinalIgnoreCase/u);
  assert.match(scheduler, /chrome_already_running profile=/u);
  assert.match(
    scheduler,
    /if \(\$processQueryErrors\.Count -gt 0\) \{ throw "chrome_process_check_failed" \}\s*\$currentSessionId = \[Diagnostics\.Process\]::GetCurrentProcess\(\)\.SessionId\s*\$sessionChromeProcesses = @\(\$chromeProcesses \| Where-Object \{ \[int\]\$_\.SessionId -eq \$currentSessionId \}\)\s*if \(@\(\$sessionChromeProcesses \| Where-Object \{\s*\[string\]::IsNullOrWhiteSpace\(\[string\]\$_\.ExecutablePath\)\s*\}\)\.Count -gt 0\) \{ throw "chrome_process_metadata_unavailable" \}\s*\$workChromeRunning = @\(\$sessionChromeProcesses \| Where-Object \{\s*\$executablePath = \[IO\.Path\]::GetFullPath\(\[string\]\$_\.ExecutablePath\)\s*\[string\]::Equals\(\$executablePath, \$chromePath, \[StringComparison\]::OrdinalIgnoreCase\)\s*\}\)\.Count -gt 0\s*if \(\$workChromeRunning\) \{\s*Write-SafeLog "chrome_already_running profile=\$profileDirectory"\s*exit 0\s*\}\s*\$profileArgument = '--profile-directory="\{0\}"' -f \$profileDirectory\s*Start-Process -FilePath \$chromePath/u,
  );
  assert.ok(
    scheduler.indexOf("chrome_already_running") < scheduler.indexOf("Start-Process -FilePath $chromePath"),
    "an already running work profile must not be minimized again",
  );
  assert.match(scheduler, /chrome_ready profile=/u);
  assert.match(scheduler, /chrome_profile_missing/u);
  assert.doesNotMatch(`${installer}\n${scheduler}`, /remote-debugging|no-sandbox|user-data-dir/iu);
});

test("Windows runtime stays production-only and one-job bounded", () => {
  assert.match(installer, /https:\/\/insight\.momentlabs\.co\.kr\/api\/naver-shopping-local-worker/u);
  assert.match(installer, /windows-native-host\.conf/u);
  assert.ok(installer.includes("$productionApiUrl`n1`n"));
  assert.match(launcher, /String\.Equals\(apiUrl, ProductionApiUrl/u);
  assert.match(launcher, /String\.Equals\(maxJobs, "1"/u);
  assert.match(installer, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(installer, /FileSystemRights\]::FullControl/u);
});

test("Windows extension updater preserves UTF-8 bytes and validates before restart", () => {
  assert.match(updater, /DownloadData/u);
  assert.match(updater, /\[IO\.File\]::WriteAllBytes/u);
  assert.doesNotMatch(updater, /DownloadString|WriteAllText/u);
  assert.match(updater, /--check \(Join-Path \$stagingPath \$scriptName\)/u);
  assert.match(updater, /extension_javascript_invalid/u);
  assert.match(updater, /extension_version_mismatch/u);
  assert.match(updater, /Secure Preferences/u);
  assert.match(updater, /loaded_extension_path_missing/u);
  assert.match(updater, /loaded_extension_path_outside_user_profile/u);
  assert.match(updater, /loaded_extension_version_mismatch/u);
  assert.match(updater, /loaded_extension_hash_mismatch/u);
  assert.match(updater, /loaded_extension_synced=true/u);
  assert.match(updater, /chrome_profile_missing/u);
  assert.match(updater, /"icon16\.png"/u);
  assert.match(updater, /"icon128\.png"/u);
  assert.match(updater, /MomentInsightNaverShoppingHost\.cs/u);
  assert.match(updater, /naver-shopping-native-host\.mjs/u);
  assert.match(updater, /naver-shopping-native-host-core\.mjs/u);
  assert.match(updater, /native_host_core_download_empty/u);
  assert.match(updater, /native_host_core_javascript_invalid/u);
  assert.match(updater, /native_host_core_sha256/u);
  assert.match(updater, /Copy-Item -LiteralPath \$stagedNativeHostCore -Destination \$nativeHostCorePath -Force/u);
  assert.match(updater, /naver-shopping-local-worker\.mjs/u);
  assert.match(updater, /local_worker_javascript_invalid/u);
  assert.match(updater, /local_worker_sha256/u);
  assert.match(updater, /local-worker-contract\.mjs/u);
  assert.match(updater, /local_worker_contract_javascript_invalid/u);
  assert.match(updater, /local_worker_contract_sha256/u);
  assert.match(updater, /naver-shopping-rank-collector\/src\/provider\.mjs/u);
  assert.match(updater, /collector_provider_download_empty/u);
  assert.match(updater, /collector_provider_javascript_invalid/u);
  assert.match(updater, /collector_provider_sha256/u);
  assert.match(updater, /Copy-Item -LiteralPath \$stagedCollectorProvider -Destination \$collectorProviderPath -Force/u);
  assert.match(updater, /naver-shopping-rank-collector\/src\/contract\.mjs/u);
  assert.match(updater, /collector_contract_download_empty/u);
  assert.match(updater, /collector_contract_javascript_invalid/u);
  assert.match(updater, /collector_contract_sha256/u);
  assert.match(updater, /Copy-Item -LiteralPath \$stagedCollectorContract -Destination \$collectorContractPath -Force/u);
  assert.match(updater, /runtime_fingerprint=/u);
  assert.match(updater, /Security\.Cryptography\.SHA256/u);
  assert.match(updater, /run-naver-shopping-chrome-scheduler\.ps1/u);
  assert.match(updater, /Management\.Automation\.Language\.Parser/u);
  assert.match(updater, /scheduler_script_invalid/u);
  assert.match(updater, /scheduler_script_sha256/u);
  assert.match(updater, /\$launcherMissing/u);
  assert.match(updater, /\$launcherSourceChanged/u);
  assert.match(updater, /\$launcherNeedsCompile = \$launcherMissing -or \$launcherSourceChanged/u);
  assert.match(updater, /Microsoft\.NET\\Framework64\\v4\.0\.30319\\csc\.exe/u);
  assert.match(updater, /native_host_launcher_compile_failed/u);
  assert.match(updater, /launcher_recompiled=/u);
  assert.match(updater, /launcher_source_updated=/u);
  assert.match(updater, /launcher_sha256/u);
  assert.ok(
    updater.indexOf("extension_javascript_invalid") < updater.indexOf("Get-Process chrome"),
    "validation must finish before Chrome is restarted",
  );
  for (const validationCode of [
    "native_host_core_javascript_invalid",
    "collector_provider_javascript_invalid",
    "collector_contract_javascript_invalid",
  ]) {
    assert.ok(
      updater.indexOf(validationCode) < updater.indexOf("Get-Process chrome"),
      `${validationCode} must be checked before Chrome is restarted`,
    );
  }
  assert.match(
    updater,
    /\$ExpectedVersion`n\$serviceWorkerHash`n\$nativeHostHash`n\$nativeHostCoreHash`n\$localWorkerHash`n\$localWorkerContractHash`n\$collectorProviderHash`n\$collectorContractHash/u,
  );
  assert.match(updater, /MI_EXTENSION_UPDATE_OK/u);
});

test("Windows extension updater waits for every targeted process before copying runtime files", () => {
  assert.match(updater, /function Get-UpdateTargetProcesses/u);
  assert.match(updater, /\$_\.Name -eq "chrome\.exe"/u);
  assert.match(updater, /\$_\.Name -eq "MomentInsightNaverShoppingHost\.exe"/u);
  assert.match(updater, /\$_\.Name -eq "node\.exe"[\s\S]{0,100}naver-shopping-native-host\.mjs/u);
  assert.match(updater, /\$processShutdownTimeoutMs = 10000/u);
  assert.match(updater, /\$processShutdownPollMs = 250/u);
  assert.match(updater, /\[Diagnostics\.Stopwatch\]::StartNew\(\)/u);
  assert.match(updater, /Start-Sleep -Milliseconds \$processShutdownPollMs/u);

  const chromeStopIndex = updater.indexOf("Get-Process chrome");
  const workerStopIndex = updater.indexOf("Stop-Process -Id $_.ProcessId");
  const waitIndex = updater.indexOf("$remainingProcesses = @(Get-UpdateTargetProcesses)");
  const copyIndex = updater.indexOf("Copy-Item -LiteralPath (Join-Path $stagingPath $file)");
  assert.ok(chromeStopIndex >= 0, "the updater must stop Chrome");
  assert.ok(workerStopIndex > chromeStopIndex, "the updater must stop the native worker processes");
  assert.ok(waitIndex > workerStopIndex, "the bounded shutdown wait must follow every stop request");
  assert.ok(copyIndex > waitIndex, "runtime copying must wait until targeted processes exit");
});

test("Windows extension updater fails closed with a typed process shutdown timeout", () => {
  const timeoutGuard = updater.indexOf("$shutdownWatch.ElapsedMilliseconds -ge $processShutdownTimeoutMs");
  const typedFailure = updater.indexOf('throw "update_process_shutdown_timeout"');
  const firstRuntimeCopy = updater.indexOf("Copy-Item -LiteralPath (Join-Path $stagingPath $file)");
  assert.ok(timeoutGuard >= 0, "the updater must enforce a bounded shutdown deadline");
  assert.ok(typedFailure > timeoutGuard, "the shutdown timeout must use its typed failure code");
  assert.ok(firstRuntimeCopy > typedFailure, "a shutdown timeout must occur before any runtime copy");
  assert.match(updater, /throw "update_process_check_failed"/u);
});

test("Windows extension updater quiesces the watchdog before process shutdown and runtime copy", () => {
  assert.match(updater, /Get-ScheduledTask -TaskPath \$taskPath -TaskName \$taskName -ErrorAction Stop/u);
  assert.match(updater, /\$scheduledTaskWasEnabled = \[bool\]\$scheduledTask\.Settings\.Enabled/u);
  assert.match(updater, /\$scheduledTaskWasRunning = \[string\]\$scheduledTask\.State -eq "Running"/u);
  assert.match(updater, /throw "scheduled_task_state_unavailable"/u);
  assert.match(updater, /throw "scheduled_task_state_invalid"/u);

  const disableIndex = updater.indexOf("Disable-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop");
  const taskStopIndex = updater.indexOf("Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName");
  const chromeStopIndex = updater.indexOf("Get-Process chrome");
  const processWaitIndex = updater.indexOf("$remainingProcesses = @(Get-UpdateTargetProcesses)");
  const runtimeCopyIndex = updater.indexOf("Copy-Item -LiteralPath (Join-Path $stagingPath $file)");
  assert.ok(disableIndex >= 0, "the updater must disable the watchdog first");
  assert.ok(taskStopIndex > disableIndex, "the updater must stop the disabled watchdog instance");
  assert.ok(chromeStopIndex > taskStopIndex, "Chrome shutdown must follow watchdog quiescence");
  assert.ok(processWaitIndex > chromeStopIndex, "process-zero verification must follow Chrome shutdown");
  assert.ok(runtimeCopyIndex > processWaitIndex, "runtime copying must follow watchdog and process quiescence");
});

test("Windows extension updater restores enablement in finally and starts only after success", () => {
  const finallyIndex = updater.indexOf("finally {");
  const successIndex = updater.indexOf("$updateSucceeded = $true");
  const restoreEnableIndex = updater.indexOf("Enable-ScheduledTask -TaskPath $taskPath -TaskName $taskName");
  const restoreDisableIndex = updater.lastIndexOf("Disable-ScheduledTask -TaskPath $taskPath -TaskName $taskName");
  const successGuardIndex = updater.indexOf("if ($updateSucceeded)", restoreEnableIndex);
  const restartIndex = updater.indexOf("Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName", successGuardIndex);
  const successOutputIndex = updater.indexOf("Write-Host $successMessage");
  assert.ok(successIndex >= 0, "successful validation must be recorded before restoration");
  assert.ok(finallyIndex > successIndex, "task restoration must run from finally");
  assert.ok(restoreEnableIndex > finallyIndex, "an originally enabled task must be re-enabled in finally");
  assert.ok(restoreDisableIndex > finallyIndex, "an originally disabled task must remain disabled in finally");
  assert.ok(successGuardIndex > restoreEnableIndex, "task restart must be success-gated");
  assert.ok(restartIndex > successGuardIndex, "failed updates must not explicitly restart Chrome");
  assert.ok(successOutputIndex > restartIndex, "success must be reported only after task restoration succeeds");
  assert.match(updater, /if \(\[string\]\$restoredTask\.State -ne "Running"\)/u);
  assert.match(updater, /\[string\]\$postStartTask\.State -notin @\("Ready", "Running"\)/u);
  assert.match(updater, /throw "scheduled_task_restore_failed"/u);
});
