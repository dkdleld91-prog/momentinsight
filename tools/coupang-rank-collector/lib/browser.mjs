// 브라우저 실행·종료·청소(명세 §9.2 lib/browser.mjs, §2.2-3).
// 키워드마다 <root>/runs/mi-coupang-run-<ms>-<hex8> 새 프로필로 Edge(또는 맥 예비 경로의 Chrome)를 띄우고, 끝나면 지운다.
// 종료 대상은 셋뿐이다: 자기가 띄운 PID 트리, 명령줄에 우리 runs 폴더가 든 브라우저, state/browser.pid 의 PID 중 명령줄이 맞는 것.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PROFILE_DIR_PATTERN, STALE_PROFILE_MS } from "./contract.mjs";
import { stripBom } from "./config.mjs";

export const DEVTOOLS_PORT_TIMEOUT_MS = 20000;
export const DEVTOOLS_POLL_MS = 200;
export const CLOSE_WAIT_MS = 5000;
export const WINDOWS_RUNS_MARKER = "\\MomentInsight\\CoupangRank\\runs\\";
export const MAC_RUNS_MARKER = "/MomentInsight/CoupangRank/runs/";
const DEFAULT_USER_DATA_MARKERS = Object.freeze([
  "\\user data",
  "/library/application support/google/chrome",
  "/library/application support/microsoft edge",
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BrowserError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function runsDir(root, pathImpl = path) {
  return pathImpl.join(pathImpl.resolve(root), "runs");
}

export function profileDirName(nowMs = Date.now(), hex = randomBytes(4).toString("hex")) {
  return `mi-coupang-run-${String(nowMs)}-${hex}`;
}

export function makeProfileDir(root, { now = Date.now, random = () => randomBytes(4).toString("hex") } = {}) {
  const parent = runsDir(root);
  fs.mkdirSync(parent, { recursive: true });
  const dir = path.join(parent, profileDirName(now(), random()));
  assertSafeProfileDir(dir, root);
  fs.mkdirSync(dir);
  return dir;
}

export function assertSafeProfileDir(dir, root, { pathImpl = path } = {}) {
  const resolved = pathImpl.resolve(String(dir || ""));
  const parent = runsDir(root, pathImpl);
  if (pathImpl.dirname(resolved) !== parent) throw new BrowserError("profile_dir_unsafe", "profile_dir_outside_runs");
  if (!PROFILE_DIR_PATTERN.test(pathImpl.basename(resolved))) throw new BrowserError("profile_dir_unsafe", "profile_dir_name");
  const lower = resolved.toLowerCase();
  if (DEFAULT_USER_DATA_MARKERS.some((marker) => lower.includes(marker))) {
    throw new BrowserError("profile_dir_unsafe", "profile_dir_default_user_data");
  }
  return resolved;
}

export function browserArgs({ profileDir, windowMode, platform }) {
  const position = windowMode === "offscreen" ? "-2400,-2400" : "0,0";
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate,CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-size=1280,900",
    `--window-position=${position}`,
  ];
  if (platform === "macos") args.push("--use-mock-keychain");
  args.push("about:blank");
  return args;
}

// 연결 코드가 브라우저로 새지 않게 MI_ 로 시작하는 키를 모두 뺀다(윈도우 환경변수는 대소문자를 가리지 않는다).
export function cleanEnv(env = process.env) {
  const copy = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key.toUpperCase().startsWith("MI_")) continue;
    copy[key] = value;
  }
  return copy;
}

export function browserPidPath(root) {
  return path.join(path.resolve(root), "state", "browser.pid");
}

export function launchBrowser({ config, profileDir, root, windowMode, spawnImpl = spawn, env = process.env, now = Date.now }) {
  assertSafeProfileDir(profileDir, root);
  const args = browserArgs({ profileDir, windowMode, platform: config.platform });
  let child;
  try {
    child = spawnImpl(config.browser.path, args, {
      env: cleanEnv(env),
      stdio: "ignore",
      detached: config.platform === "macos",
    });
  } catch {
    throw new BrowserError("browser_launch_failed");
  }
  if (child && typeof child.on === "function") {
    child.on("error", (error) => { child.launchError = error; });
  }
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) throw new BrowserError("browser_launch_failed");
  try {
    fs.mkdirSync(path.dirname(browserPidPath(root)), { recursive: true });
    fs.writeFileSync(browserPidPath(root), JSON.stringify({ pid: child.pid, profileDir, startedAt: new Date(now()).toISOString() }), "utf8");
  } catch {
    // 기록 실패는 측정을 막지 않는다(다음 실행의 남은 브라우저 정리만 못 한다).
  }
  return child;
}

function hasExited(child) {
  if (!child) return true;
  const exitCode = child.exitCode ?? null;
  const signalCode = child.signalCode ?? null;
  return exitCode !== null || signalCode !== null;
}

export function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(hasExited(child)); }, timeoutMs);
    const onExit = () => { cleanup(); resolve(true); };
    function cleanup() {
      clearTimeout(timer);
      try { child.off?.("exit", onExit); } catch { /* 무시 */ }
    }
    child.once?.("exit", onExit);
  });
}

export async function readDevToolsActivePort(profileDir, timeoutMs = DEVTOOLS_PORT_TIMEOUT_MS, {
  child = null, sleep = defaultSleep, now = Date.now, readFile = (file) => fs.readFileSync(file, "utf8"), pollMs = DEVTOOLS_POLL_MS,
} = {}) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const until = now() + timeoutMs;
  for (;;) {
    if (child && (child.launchError || hasExited(child))) {
      throw new BrowserError(child.launchError ? "browser_launch_failed" : "browser_exit_early");
    }
    try {
      const [portLine, pathLine] = String(readFile(file)).split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port < 65536 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(String(pathLine || "").trim())) {
        return `ws://127.0.0.1:${port}${String(pathLine).trim()}`;
      }
    } catch {
      // 아직 파일이 없다.
    }
    if (now() >= until) throw new BrowserError("devtools_port_timeout");
    await sleep(pollMs);
  }
}

export function windowsSystemTool(name) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  if (name === "powershell") return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return path.win32.join(systemRoot, "System32", `${name}.exe`);
}

// 자기가 띄운 PID 트리만 끈다. 윈도우는 taskkill /PID <pid> /T /F, 맥은 자기 프로세스 그룹(-pid)만.
export function killProcessTree(pid, platform, { execFile = execFileSync, kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (platform === "windows") {
    execFile(windowsSystemTool("taskkill"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 15000, windowsHide: true });
    return true;
  }
  try {
    kill(-pid, "SIGKILL");
  } catch {
    kill(pid, "SIGKILL");
  }
  return true;
}

export function readProcessCommandLine(pid, platform, { execFile = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return "";
  try {
    if (platform === "windows") {
      return String(execFile(windowsSystemTool("powershell"), [
        "-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ], { encoding: "utf8", timeout: 20000, windowsHide: true }) || "");
    }
    return String(execFile("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10000 }) || "");
  } catch {
    return "";
  }
}

export function isOurBrowserCommandLine(commandLine, platform) {
  const text = String(commandLine || "");
  if (platform === "windows") return text.toLowerCase().includes(WINDOWS_RUNS_MARKER.toLowerCase());
  return text.includes(MAC_RUNS_MARKER);
}

export async function closeBrowser({ child, conn, platform, profileDir, root, log, waitMs = CLOSE_WAIT_MS, deps = {} }) {
  const killTree = deps.killTree || ((pid) => killProcessTree(pid, platform));
  const removeDir = deps.rmSync || fs.rmSync;
  let killed = false;
  let cleanupFailed = false;
  if (conn && !conn.closed) {
    conn.send("Browser.close").catch(() => {});
  }
  if (child) {
    const exited = await waitForExit(child, waitMs);
    if (!exited) {
      try {
        killed = Boolean(killTree(child.pid));
      } catch {
        killed = false;
      }
      await waitForExit(child, 2000);
    }
  }
  if (conn) {
    try { conn.close(); } catch { /* 무시 */ }
  }
  if (profileDir) {
    try {
      assertSafeProfileDir(profileDir, root);
      removeDir(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      cleanupFailed = true;
      log?.event?.("profile_cleanup_failed", { code: error?.code || "unknown" });
    }
  }
  try { fs.rmSync(browserPidPath(root), { force: true }); } catch { /* 무시 */ }
  return { killed, cleanupFailed };
}

// 지난 실행이 남긴 브라우저 정리(M7). 명령줄을 읽기만 하고, 우리 runs 폴더가 든 것만 끈다.
export function killOrphanBrowser(root, log, { platform, readCommandLine = readProcessCommandLine, killTree = killProcessTree } = {}) {
  const file = browserPidPath(root);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      try { fs.rmSync(file, { force: true }); } catch { /* 무시 */ }
    }
    return { killed: false };
  }
  let killed = false;
  const pid = Number(record?.pid);
  if (Number.isInteger(pid) && pid > 1) {
    const commandLine = readCommandLine(pid, platform);
    if (isOurBrowserCommandLine(commandLine, platform)) {
      try {
        killTree(pid, platform);
        killed = true;
        log?.event?.("browser_orphan_killed", { pid });
      } catch {
        killed = false;
      }
    }
  }
  try { fs.rmSync(file, { force: true }); } catch { /* 무시 */ }
  return { killed };
}

export function sweepStaleProfiles(root, now = Date.now(), { rmSync = fs.rmSync } = {}) {
  const parent = runsDir(root);
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!PROFILE_DIR_PATTERN.test(name)) continue;
    const startedAt = Number(name.slice("mi-coupang-run-".length, "mi-coupang-run-".length + 13));
    if (!Number.isFinite(startedAt) || now - startedAt <= STALE_PROFILE_MS) continue;
    try {
      rmSync(path.join(parent, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed += 1;
    } catch {
      // 실패는 무시한다(다음 실행이 다시 시도).
    }
  }
  return removed;
}

export function countProfileDirs(root) {
  try {
    return fs.readdirSync(runsDir(root)).filter((name) => PROFILE_DIR_PATTERN.test(name)).length;
  } catch {
    return 0;
  }
}

// state/browser-version: 마지막 측정 때 적은 브라우저 버전(설치기도 처음 값을 적는다). hello 에 쓴다.
const VERSION_TEXT_PATTERN = /^[0-9]{1,5}(?:\.[0-9]{1,6}){1,3}$/;

export function readBrowserVersionFile(root) {
  try {
    const text = stripBom(fs.readFileSync(path.join(path.resolve(root), "state", "browser-version"), "utf8")).trim();
    return VERSION_TEXT_PATTERN.test(text) ? text : "unknown";
  } catch {
    return "unknown";
  }
}

export function writeBrowserVersionFile(root, version) {
  if (!VERSION_TEXT_PATTERN.test(String(version || ""))) return false;
  try {
    const stateDir = path.join(path.resolve(root), "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "browser-version"), `${version}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function parseBrowserVersion(info, kind) {
  const userAgent = String(info?.userAgent || "");
  const product = String(info?.product || "");
  if (kind === "edge") {
    const edge = userAgent.match(/Edg\/(\d+(?:\.\d+){1,3})/) || product.match(/Edg\/(\d+(?:\.\d+){1,3})/);
    if (edge) return edge[1];
  }
  const match = product.match(/(\d+(?:\.\d+){1,3})/);
  return match ? match[1] : "unknown";
}

export async function browserVersion(conn, kind) {
  try {
    return parseBrowserVersion(await conn.send("Browser.getVersion"), kind);
  } catch {
    return "unknown";
  }
}
