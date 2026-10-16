// collector.json 읽기·검증(명세 §9.2). 설치기가 쓰고, worker·trial 이 읽는다.
// 이 파일에는 N30 경로·라벨을 두지 않는다(맥 Chrome 보호용 로그 경로는 맥 설치기가 collector.json 에 쓴다).
import fs from "node:fs";
import path from "node:path";
import { NODE_MAJOR_MAX, NODE_MAJOR_MIN, PUBLIC_ORIGIN } from "./contract.mjs";

export const CONFIG_FILE = "collector.json";
export const PLATFORMS = Object.freeze(["windows", "macos"]);
export const BROWSER_KINDS = Object.freeze(["edge", "chrome"]);

// §9.2 경로 규칙. Beta·Dev·Canary 는 실행 파일 이름·폴더가 달라 맞지 않는다.
export const BROWSER_PATH_RULES = Object.freeze({
  "windows:edge": /\\Microsoft\\Edge\\Application\\msedge\.exe$/i,
  "macos:edge": /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge$/,
  "macos:chrome": /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/,
});

const CLOCK_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export class ConfigError extends Error {
  constructor(field) {
    super(`config_invalid:${field}`);
    this.code = "config_invalid";
    this.field = field;
  }
}

export function stripBom(text) {
  const value = String(text ?? "");
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

// 설치 루트 아래 이름(§3.1). 루트 = worker.mjs 가 있는 app 폴더의 부모.
export function rootPaths(root) {
  const base = path.resolve(root);
  const state = path.join(base, "state");
  return {
    root: base,
    app: path.join(base, "app"),
    runs: path.join(base, "runs"),
    outbox: path.join(base, "outbox"),
    state,
    logs: path.join(base, "logs"),
    trialResults: path.join(base, "trial-results"),
    config: path.join(base, CONFIG_FILE),
    trialConfig: path.join(base, "trial.json"),
    browserPid: path.join(state, "browser.pid"),
    browserVersion: path.join(state, "browser-version"),
    lock: path.join(state, "worker.lock"),
    log: path.join(base, "logs", "worker.log"),
  };
}

export function rootFromAppDir(appDir) {
  return path.dirname(path.resolve(appDir));
}

export function assertBrowserPath(platform, kind, browserPath) {
  const rule = BROWSER_PATH_RULES[`${platform}:${kind}`];
  if (!rule) throw new ConfigError(platform === "windows" ? "browser.kind_windows_edge_only" : "browser.kind");
  if (typeof browserPath !== "string" || !browserPath || browserPath.length > 400 || !rule.test(browserPath)) {
    throw new ConfigError("browser.path");
  }
  return browserPath;
}

function isAbsoluteAnyPlatform(value) {
  return typeof value === "string" && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}

function positiveInteger(value, max) {
  return Number.isInteger(value) && value > 0 && value <= max;
}

function validateChromeGuard(guard) {
  if (!guard || typeof guard !== "object" || Array.isArray(guard)) throw new ConfigError("chromeGuard");
  for (const key of ["schedulerLog", "watchdogLog"]) {
    if (!isAbsoluteAnyPlatform(guard[key]) || guard[key].length > 400) throw new ConfigError(`chromeGuard.${key}`);
  }
  if (!positiveInteger(guard.intervalSeconds, 86400)) throw new ConfigError("chromeGuard.intervalSeconds");
  if (!Array.isArray(guard.calendarLocalTimes) || guard.calendarLocalTimes.length > 24
    || !guard.calendarLocalTimes.every((item) => typeof item === "string" && CLOCK_PATTERN.test(item))) {
    throw new ConfigError("chromeGuard.calendarLocalTimes");
  }
  for (const key of ["marginSeconds", "driftSeconds", "watchdogBusySeconds"]) {
    if (!positiveInteger(guard[key], 3600)) throw new ConfigError(`chromeGuard.${key}`);
  }
  return Object.freeze({
    schedulerLog: guard.schedulerLog,
    watchdogLog: guard.watchdogLog,
    intervalSeconds: guard.intervalSeconds,
    calendarLocalTimes: Object.freeze([...guard.calendarLocalTimes]),
    marginSeconds: guard.marginSeconds,
    driftSeconds: guard.driftSeconds,
    watchdogBusySeconds: guard.watchdogBusySeconds,
  });
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("root");
  if (raw.schema !== 1) throw new ConfigError("schema");
  if (!PLATFORMS.includes(raw.platform)) throw new ConfigError("platform");
  // 다른 도메인은 거절한다(연결 코드가 다른 곳으로 가지 않게).
  if (raw.apiBase !== PUBLIC_ORIGIN) throw new ConfigError("apiBase");
  if (raw.nodePath != null && (typeof raw.nodePath !== "string" || raw.nodePath.length > 400)) throw new ConfigError("nodePath");
  const browser = raw.browser;
  if (!browser || typeof browser !== "object" || !BROWSER_KINDS.includes(browser.kind)) throw new ConfigError("browser.kind");
  if (raw.platform === "windows" && browser.kind !== "edge") throw new ConfigError("browser.kind_windows_edge_only");
  assertBrowserPath(raw.platform, browser.kind, browser.path);
  let chromeGuard = null;
  if (raw.platform === "macos" && browser.kind === "chrome") {
    chromeGuard = validateChromeGuard(raw.chromeGuard);
  } else if (raw.chromeGuard != null) {
    // Edge 에는 보호가 필요 없다. 값이 있어도 쓰지 않는다.
    chromeGuard = null;
  }
  return Object.freeze({
    schema: 1,
    platform: raw.platform,
    apiBase: raw.apiBase,
    nodePath: raw.nodePath || null,
    browser: Object.freeze({ kind: browser.kind, path: browser.path }),
    chromeGuard,
  });
}

export function parseConfigText(text) {
  let raw;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    throw new ConfigError("json");
  }
  return validateConfig(raw);
}

export function loadConfig(root) {
  let text;
  try {
    text = fs.readFileSync(rootPaths(root).config, "utf8");
  } catch {
    throw new ConfigError("missing");
  }
  return parseConfigText(text);
}

export function guardModeOf(config) {
  return config?.platform === "macos" && config?.browser?.kind === "chrome" ? "n30-chrome" : "none";
}

// §9.3-4 실행 환경: Node 주 버전 22~24 + 전역 WebSocket + String.prototype.toWellFormed.
export function checkNodeRuntime({
  version = process.versions.node, webSocket = globalThis.WebSocket, toWellFormed = String.prototype.toWellFormed,
} = {}) {
  const major = Number(String(version || "").split(".")[0]);
  return Number.isInteger(major) && major >= NODE_MAJOR_MIN && major <= NODE_MAJOR_MAX
    && typeof webSocket === "function" && typeof toWellFormed === "function";
}
