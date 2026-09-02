import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NATIVE_HOST_NAME = "co.kr.momentinsight.naver_shopping";
const OLD_AGENT_LABEL = "co.kr.momentinsight.naver-shopping-local-worker";
const CHROME_SCHEDULER_LABEL = "co.kr.momentinsight.naver-shopping-chrome-scheduler";
const RUNTIME_DIRECTORY_NAME = "NaverShoppingBridge";
const CHROME_SCHEDULER_CONFIG_NAME = "naver-shopping-chrome-scheduler.conf";
const CHROME_PROFILE_DIRECTORY_ENV = "MI_CHROME_PROFILE_DIRECTORY";
const CHROME_PROFILE_DIRECTORY_FLAG = "--profile-directory";
const RUNTIME_FILES = Object.freeze([
  ["scripts/run-naver-shopping-native-host.sh", 0o700],
  ["scripts/run-naver-shopping-chrome-scheduler.sh", 0o700],
  ["scripts/naver-shopping-native-host.mjs", 0o600],
  ["scripts/naver-shopping-native-host-core.mjs", 0o600],
  ["scripts/naver-shopping-local-worker.mjs", 0o600],
  ["src/server/local-worker-auth.mjs", 0o600],
  ["src/server/security.mjs", 0o600],
  ["src/server/handlers/naver-shopping-rank.mjs", 0o600],
  ["src/server/naver-shopping/local-worker-contract.mjs", 0o600],
  ["src/server/naver-shopping/source-status.mjs", 0o600],
  ["src/server/naver-shopping/provider-runtime.mjs", 0o600],
  ["src/server/naver-shopping/mobile-top-fallback.mjs", 0o600],
  ["tools/naver-shopping-rank-collector/src/contract.mjs", 0o600],
  ["tools/naver-shopping-rank-collector/src/provider.mjs", 0o600],
]);

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function validChromeProfileDirectory(value) {
  return /^(?:Default|Profile [1-9][0-9]{0,2})$/u.test(String(value || ""));
}

export function resolveChromeProfileDirectory(homeDirectory, options = {}) {
  const explicit = String(options.profileDirectory || "").trim();
  if (explicit) {
    if (!validChromeProfileDirectory(explicit)) throw new Error("chrome_profile_directory_invalid");
    return explicit;
  }
  const localStatePath = path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Local State",
  );
  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const profiles = localState?.profile?.info_cache || {};
    const preferredName = String(options.profileName || "동빈").trim();
    const match = Object.entries(profiles).find(([directory, profile]) => (
      validChromeProfileDirectory(directory)
      && String(profile?.name || "").trim() === preferredName
    ));
    if (match) return match[0];
    if (profiles.Default && validChromeProfileDirectory("Default")) return "Default";
  } catch {
    // A fresh Chrome profile may not have Local State yet.
  }
  return "Default";
}

function chromeSchedulerConfigPath(homeDirectory) {
  return path.join(homeDirectory, "Library", "Application Support", "MomentInsight", CHROME_SCHEDULER_CONFIG_NAME);
}

// 기존 conf 2행(프로필 디렉터리)을 읽는다. 파일이 없거나 값이 규칙에 맞지 않으면 null.
export function readChromeSchedulerProfileDirectory(homeDirectory) {
  try {
    const lines = fs.readFileSync(chromeSchedulerConfigPath(homeDirectory), "utf8").split("\n");
    const candidate = String(lines[1] ?? "").trim();
    return validChromeProfileDirectory(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// 우선순위: 명시 옵션(CLI 인자·env 포함) > 기존 conf 보존 > Local State 탐지.
// 재설치가 실제 수집 확장이 있는 프로필을 기본값(Default)으로 되돌리지 않게 한다.
export function resolveChromeSchedulerProfileSelection(homeDirectory, options = {}) {
  const previousProfileDirectory = readChromeSchedulerProfileDirectory(homeDirectory);
  const explicit = String(options.profileDirectory || "").trim();
  let profileDirectory;
  let profileSource;
  if (explicit) {
    profileDirectory = resolveChromeProfileDirectory(homeDirectory, options);
    profileSource = String(options.profileDirectorySource || "option");
  } else if (previousProfileDirectory) {
    profileDirectory = previousProfileDirectory;
    profileSource = "preserved";
  } else {
    profileDirectory = resolveChromeProfileDirectory(homeDirectory, options);
    profileSource = "detected";
  }
  return {
    profileDirectory,
    profileSource,
    previousProfileDirectory,
    profileChanged: previousProfileDirectory !== null && previousProfileDirectory !== profileDirectory,
  };
}

export function resolveChromeApplicationPath(homeDirectory, options = {}) {
  const explicit = String(options.chromeApplicationPath || "").trim();
  const candidates = [
    explicit,
    "/Applications/Google Chrome.app",
    path.join(homeDirectory, "Applications", "Google Chrome.app"),
    path.join(homeDirectory, "Desktop", "Google Chrome.app"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => {
    const executable = path.join(candidate, "Contents", "MacOS", "Google Chrome");
    try {
      return fs.statSync(candidate).isDirectory() && fs.statSync(executable).isFile();
    } catch {
      return false;
    }
  });
  if (!found) throw new Error("chrome_application_missing");
  return path.resolve(found);
}

export function buildChromeSchedulerPlist(options = {}) {
  const wrapperPath = String(options.wrapperPath || "").trim();
  const logDirectory = String(options.logDirectory || "").trim();
  if (!path.isAbsolute(wrapperPath) || !path.isAbsolute(logDirectory)) {
    throw new Error("chrome_scheduler_path_invalid");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CHROME_SCHEDULER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${xmlEscape(wrapperPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>50</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>50</integer></dict>
  </array>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDirectory, "naver-shopping-chrome-scheduler.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDirectory, "naver-shopping-chrome-scheduler.error.log"))}</string>
</dict>
</plist>
`;
}

function installChromeScheduler(options) {
  const {
    homeDirectory,
    runtimePath,
    chromeApplicationPath,
    profileDirectory,
    profileSource = "option",
    previousProfileDirectory = null,
    profileChanged = false,
  } = options;
  const applicationDirectory = path.dirname(runtimePath);
  const configPath = path.join(applicationDirectory, CHROME_SCHEDULER_CONFIG_NAME);
  fs.writeFileSync(configPath, `${chromeApplicationPath}\n${profileDirectory}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);

  const logDirectory = path.join(homeDirectory, "Library", "Logs", "MomentInsight");
  const launchAgentsDirectory = path.join(homeDirectory, "Library", "LaunchAgents");
  const launchAgentPath = path.join(launchAgentsDirectory, `${CHROME_SCHEDULER_LABEL}.plist`);
  const wrapperPath = path.join(runtimePath, "scripts", "run-naver-shopping-chrome-scheduler.sh");
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(launchAgentPath, buildChromeSchedulerPlist({ wrapperPath, logDirectory }), { mode: 0o600 });
  fs.chmodSync(launchAgentPath, 0o600);
  execFileSync("/usr/bin/plutil", ["-lint", launchAgentPath], { stdio: "ignore" });

  if (options.activate !== false) {
    const domain = `gui/${process.getuid()}`;
    try {
      execFileSync("/bin/launchctl", ["bootout", domain, launchAgentPath], { stdio: "ignore" });
    } catch {
      // The scheduler may not be loaded yet.
    }
    execFileSync("/bin/launchctl", ["bootstrap", domain, launchAgentPath], { stdio: "ignore" });
    execFileSync("/bin/launchctl", ["enable", `${domain}/${CHROME_SCHEDULER_LABEL}`], { stdio: "ignore" });
    execFileSync("/bin/launchctl", ["kickstart", `${domain}/${CHROME_SCHEDULER_LABEL}`], { stdio: "ignore" });
  }

  return {
    configPath,
    launchAgentPath,
    chromeApplicationPath,
    profileDirectory,
    profileSource,
    previousProfileDirectory,
    profileChanged,
  };
}

export function deriveChromeExtensionId(publicKeyBase64) {
  const key = Buffer.from(String(publicKeyBase64 || ""), "base64");
  if (key.length < 64) throw new Error("chrome_extension_key_invalid");
  const digest = crypto.createHash("sha256").update(key).digest().subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((value) => String.fromCharCode("a".charCodeAt(0) + value))
    .join("");
}

function keychainReady() {
  const account = process.env.USER || os.userInfo().username;
  try {
    const secret = execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      "co.kr.momentinsight.naver-shopping-local-worker",
      "-a",
      account,
      "-w",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return secret.length >= 32;
  } catch {
    return false;
  }
}

function installRuntime(repositoryPath, homeDirectory) {
  const applicationDirectory = path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "MomentInsight",
  );
  const runtimePath = path.join(applicationDirectory, RUNTIME_DIRECTORY_NAME);
  fs.mkdirSync(runtimePath, { recursive: true, mode: 0o700 });
  fs.chmodSync(applicationDirectory, 0o700);
  fs.chmodSync(runtimePath, 0o700);

  for (const [relativePath, mode] of RUNTIME_FILES) {
    const sourcePath = path.join(repositoryPath, relativePath);
    const destinationPath = path.join(runtimePath, relativePath);
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.isFile()) throw new Error(`native_host_runtime_file_invalid:${relativePath}`);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, mode);
  }

  return {
    runtimePath,
    wrapperPath: path.join(runtimePath, "scripts", "run-naver-shopping-native-host.sh"),
  };
}

export function installChromeBridge(options = {}) {
  const repositoryPath = path.resolve(options.repositoryPath || path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  ));
  const homeDirectory = path.resolve(options.homeDirectory || os.homedir());
  const extensionPath = path.join(repositoryPath, "tools", "naver-shopping-chrome-extension");
  const manifestPath = path.join(extensionPath, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const extensionId = deriveChromeExtensionId(manifest.key);
  if (!(options.keychainReady?.() ?? keychainReady())) {
    throw new Error("native_host_keychain_secret_missing_or_weak");
  }
  const { runtimePath, wrapperPath } = installRuntime(repositoryPath, homeDirectory);
  const wrapperStat = fs.statSync(wrapperPath);
  if (!wrapperStat.isFile() || (wrapperStat.mode & 0o111) === 0) {
    throw new Error("native_host_wrapper_not_executable");
  }

  const hostDirectory = path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
  );
  fs.mkdirSync(hostDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(hostDirectory, 0o700);
  const hostManifestPath = path.join(hostDirectory, `${NATIVE_HOST_NAME}.json`);
  fs.writeFileSync(hostManifestPath, `${JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: "Moment Insight N Shopping signed local bridge",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(hostManifestPath, 0o600);

  if (options.disableOldAutomaticWorker !== false) {
    const domain = `gui/${process.getuid()}`;
    const oldPlist = path.join(homeDirectory, "Library", "LaunchAgents", `${OLD_AGENT_LABEL}.plist`);
    try {
      execFileSync("/bin/launchctl", ["bootout", domain, oldPlist], { stdio: "ignore" });
    } catch {
      // The old worker may already be unloaded.
    }
    try {
      execFileSync("/bin/launchctl", ["disable", `${domain}/${OLD_AGENT_LABEL}`], { stdio: "ignore" });
    } catch {
      // The disabled state is a safety bonus; missing launchd state is harmless.
    }
  }

  const scheduler = options.installChromeScheduler === false ? null : installChromeScheduler({
    homeDirectory,
    runtimePath,
    chromeApplicationPath: resolveChromeApplicationPath(homeDirectory, options),
    ...resolveChromeSchedulerProfileSelection(homeDirectory, options),
    activate: options.activateChromeScheduler !== false,
  });

  return {
    extensionId,
    extensionPath,
    hostManifestPath,
    runtimePath,
    wrapperPath,
    scheduler,
    oldAutomaticBrowserWorkerDisabled: true,
  };
}

// CLI 전용: --profile-directory=<dir> 인자, 없으면 env MI_CHROME_PROFILE_DIRECTORY.
// 모듈 호출(워치독 드리프트 동기화)은 이 함수를 거치지 않으므로 env 의 영향을 받지 않는다.
export function parseInstallerCliOptions(argv = [], env = {}) {
  const options = {};
  for (const argument of argv.slice(2)) {
    if (argument.startsWith(`${CHROME_PROFILE_DIRECTORY_FLAG}=`)) {
      const value = argument.slice(CHROME_PROFILE_DIRECTORY_FLAG.length + 1).trim();
      if (!validChromeProfileDirectory(value)) throw new Error("chrome_profile_directory_invalid");
      options.profileDirectory = value;
      options.profileDirectorySource = "cli";
      continue;
    }
    throw new Error(`chrome_bridge_install_argument_unknown:${argument}`);
  }
  if (!options.profileDirectory) {
    const fromEnvironment = String(env[CHROME_PROFILE_DIRECTORY_ENV] || "").trim();
    if (fromEnvironment) {
      if (!validChromeProfileDirectory(fromEnvironment)) throw new Error("chrome_profile_directory_invalid");
      options.profileDirectory = fromEnvironment;
      options.profileDirectorySource = "env";
    }
  }
  return options;
}

// 보존/변경 사실을 stdout 한 줄로 요약한다. 스케줄러를 설치하지 않았으면 null.
export function describeChromeProfileDecision(scheduler) {
  const profileDirectory = String(scheduler?.profileDirectory || "").trim();
  if (!profileDirectory) return null;
  const source = String(scheduler.profileSource || "option");
  const previous = scheduler.previousProfileDirectory ?? null;
  let verdict = "set";
  if (source === "preserved") verdict = "preserved";
  else if (scheduler.profileChanged) verdict = "changed";
  else if (previous !== null) verdict = "kept";
  return `chrome_profile_directory ${verdict}: ${profileDirectory} (source=${source}, previous=${previous ?? "none"})`;
}

export function runInstallerCli({
  argv = process.argv,
  env = process.env,
  install = installChromeBridge,
  stdout = (line) => console.log(line),
  stderr = (line) => console.error(line),
} = {}) {
  try {
    const result = install(parseInstallerCliOptions(argv, env));
    const decision = describeChromeProfileDecision(result?.scheduler);
    if (decision) stdout(decision);
    stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stderr(error?.message || "chrome_bridge_install_failed");
    return 1;
  }
}

const directlyExecuted = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directlyExecuted) {
  process.exitCode = runInstallerCli();
}
