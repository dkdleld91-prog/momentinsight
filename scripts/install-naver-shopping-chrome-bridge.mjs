import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NATIVE_HOST_NAME = "co.kr.momentinsight.naver_shopping";
const OLD_AGENT_LABEL = "co.kr.momentinsight.naver-shopping-local-worker";
const RUNTIME_DIRECTORY_NAME = "NaverShoppingBridge";
const RUNTIME_FILES = Object.freeze([
  ["scripts/run-naver-shopping-native-host.sh", 0o700],
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

  return {
    extensionId,
    extensionPath,
    hostManifestPath,
    runtimePath,
    wrapperPath,
    oldAutomaticBrowserWorkerDisabled: true,
  };
}

const directlyExecuted = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directlyExecuted) {
  try {
    console.log(JSON.stringify(installChromeBridge(), null, 2));
  } catch (error) {
    console.error(error?.message || "chrome_bridge_install_failed");
    process.exitCode = 1;
  }
}
