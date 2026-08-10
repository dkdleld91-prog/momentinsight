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
  assert.match(installer, /chrome:\/\/extensions/u);
  assert.match(installer, /extensionPath = \(Join-Path \$runtimePath/u);
  assert.doesNotMatch(installer, /return "Default"/u);
  assert.match(entrypoint, /WindowsPowerShell\\v1\.0\\powershell\.exe/u);
  assert.match(entrypoint, /install-naver-shopping-chrome-bridge-windows\.ps1/u);
  assert.doesNotMatch(entrypoint, /WorkerSecret|LOCAL_WORKER_SECRET/u);
});

test("Windows native host uses HKCU registration, DPAPI and explicit binary stdio relay", () => {
  assert.match(installer, /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/u);
  assert.match(installer, /allowed_origins/u);
  assert.match(installer, /chrome-extension:\/\/\$extensionId\//u);
  assert.match(installer, /ProtectedData\]::Protect/u);
  assert.match(installer, /DataProtectionScope\]::CurrentUser/u);
  assert.ok(installer.includes("Read-Host \"Moment Insight production worker secret\" -AsSecureString"));
  assert.doesNotMatch(installer, /-AsPlainText|cmdkey/iu);

  assert.match(launcher, /ProtectedData\.Unprotect/u);
  assert.match(launcher, /DataProtectionScope\.CurrentUser/u);
  assert.match(launcher, /RedirectStandardInput = true/u);
  assert.match(launcher, /RedirectStandardOutput = true/u);
  assert.match(launcher, /RedirectStandardError = false/u);
  assert.match(launcher, /Console\.OpenStandardInput\(\)/u);
  assert.match(launcher, /input\.CopyTo\(child\.StandardInput\.BaseStream\)/u);
  assert.match(launcher, /child\.StandardOutput\.BaseStream\.CopyTo\(output\)/u);
  assert.match(launcher, /outputRelay\.Join\(5000\)/u);
  assert.match(launcher, /MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET/u);
  assert.match(launcher, /MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS"\] = maxJobs/u);
  assert.match(launcher, /MI_NAVER_SHOPPING_WORKER_ID"\] = "windows-desktop-primary"/u);
  assert.match(launcher, /MI_NAVER_SHOPPING_WORKER_ROLE"\] = "primary"/u);
  assert.match(launcher, /SingleInstanceMutexName/u);
  assert.match(launcher, /native_host_already_running/u);
  assert.match(launcher, /child\.WaitForExit\(5000\)/u);
  assert.match(launcher, /child\.Kill\(\)/u);
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
  assert.match(scheduler, /chrome_ready profile=/u);
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
  assert.match(updater, /MomentInsightNaverShoppingHost\.cs/u);
  assert.match(updater, /Add-Type -Path \$stagedLauncherSource/u);
  assert.match(updater, /native_host_launcher_compile_failed/u);
  assert.match(updater, /naver-shopping-native-host\.mjs/u);
  assert.match(updater, /\$launcherChanged/u);
  assert.match(updater, /launcher_recompiled=/u);
  assert.match(updater, /launcher_sha256/u);
  assert.ok(
    updater.indexOf("extension_javascript_invalid") < updater.indexOf("Get-Process chrome"),
    "validation must finish before Chrome is restarted",
  );
  assert.match(updater, /MI_EXTENSION_UPDATE_OK/u);
});
