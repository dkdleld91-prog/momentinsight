// 0단계 시험(명세 §9.4, H7). 서버를 부르지 않고 로컬에만 남긴다. 10/19 12:00 맥 시험이 끝난 뒤에만 돌린다.
// 모드 3 × 키워드 1 + 대소문자 비교 2 = 5회를 운영과 같은 간격(240~360초 무작위)으로 잰다. 차단 신호가 한 번이라도 나오면 멈춘다.
// 결과: <root>/trial-results/<KST 날짜>.jsonl(로컬이라 키워드 포함), 마지막 줄 MI_COUPANG_TRIAL … 을 표준 출력과 summary.txt 에 남긴다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKED_HTTP_STATUSES, DEFAULT_WINDOW_MODE, WINDOW_MODES } from "./lib/contract.mjs";
import { checkNodeRuntime, loadConfig, rootFromAppDir, rootPaths, stripBom } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import { acquireLock } from "./lib/lock.mjs";
import {
  countProfileDirs, killOrphanBrowser, readBrowserVersionFile, sweepStaleProfiles, windowsSystemTool, writeBrowserVersionFile,
} from "./lib/browser.mjs";
import { collectKeyword } from "./lib/collect.mjs";
import { isWaitableGuardReason, runGuard } from "./lib/guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
export const GUARD_WAIT_MAX_SECONDS = 900;

export class TrialConfigError extends Error {
  constructor(field) {
    super(`trial_json_invalid:${field}`);
    this.code = "trial_json_invalid";
    this.field = field;
  }
}

function keywordOk(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 50;
}

export function parseTrialConfig(text) {
  let raw;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    throw new TrialConfigError("json");
  }
  if (!raw || typeof raw !== "object") throw new TrialConfigError("root");
  if (!Array.isArray(raw.keywords) || !raw.keywords.length || raw.keywords.length > 5 || !raw.keywords.every(keywordOk)) {
    throw new TrialConfigError("keywords");
  }
  if (!Array.isArray(raw.casePair) || raw.casePair.length !== 2 || !raw.casePair.every(keywordOk)) throw new TrialConfigError("casePair");
  if (!Array.isArray(raw.modes) || !raw.modes.length || !raw.modes.every((mode) => WINDOW_MODES.includes(mode))
    || new Set(raw.modes).size !== raw.modes.length) {
    throw new TrialConfigError("modes");
  }
  const gap = raw.gapSeconds;
  if (!Array.isArray(gap) || gap.length !== 2 || !gap.every((value) => Number.isInteger(value) && value >= 0 && value <= 3600) || gap[0] > gap[1]) {
    throw new TrialConfigError("gapSeconds");
  }
  return {
    keywords: raw.keywords.map((item) => item.trim()),
    casePair: raw.casePair.map((item) => item.trim()),
    modes: [...raw.modes],
    gapSeconds: [gap[0], gap[1]],
  };
}

export function trialPlan(trial) {
  const plan = [];
  for (const mode of trial.modes) {
    for (const keyword of trial.keywords) plan.push({ kind: "mode", mode, keyword });
  }
  const caseMode = trial.modes.includes(DEFAULT_WINDOW_MODE) ? DEFAULT_WINDOW_MODE : trial.modes[0];
  for (const keyword of trial.casePair) plan.push({ kind: "case", mode: caseMode, keyword });
  return plan;
}

export function isBlockedPage(page) {
  return page?.status === "blocked" || page?.blockedText === true || BLOCKED_HTTP_STATUSES.includes(page?.httpStatus);
}

export function modeGood(result) {
  return result.status === "ok" && result.stable === true && result.organicCount >= 45 && result.itemCount >= 55;
}

export function kstDay(nowMs) {
  return new Date(nowMs + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function summarizeTrial({ plan, results, blocked, leftover, priority, browser, stop }) {
  const modeRuns = plan.filter((item) => item.kind === "mode");
  const modeResults = results.filter((item) => item.kind === "mode");
  const caseResults = results.filter((item) => item.kind === "case");
  const ok = results.filter((item) => item.status === "ok").length;
  const stableAll = results.length === plan.length && results.every((item) => item.status === "ok" && item.stable === true);
  const item60 = modeResults.filter((item) => item.itemCount >= 60).length;
  const modes = [];
  for (const mode of [...new Set(modeRuns.map((item) => item.mode))]) {
    const planned = modeRuns.filter((item) => item.mode === mode).length;
    const good = modeResults.filter((item) => item.mode === mode && modeGood(item)).length;
    modes.push(`${mode}:${good}/${planned}`);
  }
  let caseSame = "n/a";
  if (caseResults.length === 2 && caseResults.every((item) => item.status === "ok")) {
    caseSame = JSON.stringify(caseResults[0].organicIds) === JSON.stringify(caseResults[1].organicIds) ? "yes" : "no";
  }
  const cleanupFail = results.filter((item) => item.cleanupFailed).length;
  const avgMs = results.length ? Math.round(results.reduce((sum, item) => sum + item.durationMs, 0) / results.length) : 0;
  const parts = [
    "MI_COUPANG_TRIAL",
    `runs=${results.length}`,
    `ok=${ok}`,
    `blocked=${blocked ? 1 : 0}`,
    `stableAll=${stableAll ? "yes" : "no"}`,
    `item60=${item60}/${modeRuns.length}`,
    `modes=${modes.join(",")}`,
    `caseSame=${caseSame}`,
    `cleanupFail=${cleanupFail}`,
    `leftover=${leftover}`,
    `priority=${priority || "n/a"}`,
    `avgMs=${avgMs}`,
    `browser=${browser}`,
  ];
  if (stop) parts.push(`stop=${stop}`);
  return parts.join(" ");
}

export function readWindowsPriority(pid, { execFile = execFileSync } = {}) {
  try {
    const text = String(execFile(windowsSystemTool("powershell"), [
      "-NoProfile", "-Command", `(Get-Process -Id ${Number(pid)}).PriorityClass`,
    ], { encoding: "utf8", timeout: 20000, windowsHide: true }) || "").trim();
    return /^[A-Za-z]{1,20}$/.test(text) ? text : "unknown";
  } catch {
    return "unknown";
  }
}

export async function runTrial({ appDir = HERE, stdout = null, deps = {} } = {}) {
  const d = {
    now: Date.now,
    sleep: realSleep,
    random: Math.random,
    loadConfig,
    acquireLock,
    createLogger,
    collectKeyword,
    runGuard,
    killOrphanBrowser,
    sweepStaleProfiles,
    countProfileDirs,
    readWindowsPriority,
    checkNodeRuntime,
    readTrialText: (file) => fs.readFileSync(file, "utf8"),
    ...deps,
  };
  const print = typeof stdout === "function" ? stdout : (line) => process.stdout.write(`${line}\n`);
  const root = rootFromAppDir(appDir);
  const paths = rootPaths(root);
  const log = d.createLogger(root, { now: () => new Date(d.now()) });
  const fail = (code) => {
    const line = `MI_COUPANG_TRIAL_FAIL code=${code}`;
    try {
      fs.mkdirSync(paths.trialResults, { recursive: true });
      fs.writeFileSync(path.join(paths.trialResults, "summary.txt"), `${line}\n`, "utf8");
    } catch { /* 무시 */ }
    print(line);
    log.event("trial_end", { code });
    return { ok: false, line };
  };
  let config;
  try {
    config = d.loadConfig(root);
  } catch {
    return fail("config_invalid");
  }
  if (!d.checkNodeRuntime()) return fail("node_version_unsupported");
  let trial;
  try {
    trial = parseTrialConfig(d.readTrialText(paths.trialConfig));
  } catch {
    return fail("trial_json_invalid");
  }
  const lock = d.acquireLock(root, { now: d.now });
  if (!lock?.ok) return fail("locked");
  try {
    try { fs.rmSync(path.join(paths.trialResults, "summary.txt"), { force: true }); } catch { /* 무시 */ }
    d.killOrphanBrowser(root, log, { platform: config.platform });
    d.sweepStaleProfiles(root, d.now());
    const plan = trialPlan(trial);
    const results = [];
    let blocked = false;
    let stop = null;
    let priority = config.platform === "windows" ? "unknown" : "n/a";
    let version = readBrowserVersionFile(root);
    fs.mkdirSync(paths.trialResults, { recursive: true });
    const outFile = path.join(paths.trialResults, `${kstDay(d.now())}.jsonl`);
    log.event("trial_start", { runs: plan.length });
    for (const [index, item] of plan.entries()) {
      if (index > 0) {
        const [min, max] = trial.gapSeconds;
        const gap = min + Math.floor(d.random() * (max - min + 1));
        lock.refresh?.();
        await d.sleep(gap * 1000);
      }
      // 맥 Chrome 예비 경로면 N30 틱을 피한다(Edge 는 늘 통과).
      let guard = d.runGuard(config, { now: d.now() });
      let waited = 0;
      while (!guard.ok && isWaitableGuardReason(guard.reason) && waited + (guard.retryAfterSec || 0) <= GUARD_WAIT_MAX_SECONDS) {
        waited += guard.retryAfterSec || 1;
        await d.sleep((guard.retryAfterSec || 1) * 1000);
        guard = d.runGuard(config, { now: d.now() });
      }
      if (!guard.ok) {
        stop = guard.reason;
        break;
      }
      lock.refresh?.();
      const isFirst = index === 0;
      const collected = await d.collectKeyword({
        config, keyword: item.keyword, windowMode: item.mode, root, log,
        onLaunched: isFirst && config.platform === "windows" ? (child) => { priority = d.readWindowsPriority(child.pid); } : undefined,
      });
      if (collected.browserVersion && collected.browserVersion !== "unknown") {
        version = collected.browserVersion;
        writeBrowserVersionFile(root, version);
      }
      const page = collected.page;
      const result = {
        at: new Date(d.now()).toISOString(), kind: item.kind, mode: item.mode, keyword: item.keyword,
        status: page.status, httpStatus: page.httpStatus, itemCount: page.itemCount, organicCount: page.organic.length,
        adsCount: page.ads.length, stable: page.stable, loginWall: page.loginWall, noResultText: page.noResultText,
        blockedText: page.blockedText, finalHost: page.finalHost, finalPath: page.finalPath, errorCode: page.errorCode,
        durationMs: collected.durationMs, browser: collected.browser, cleanupFailed: Boolean(collected.cleanupFailed),
        organicIds: page.organic.map((entry) => entry.p),
      };
      results.push(result);
      try { fs.appendFileSync(outFile, `${JSON.stringify(result)}\n`, "utf8"); } catch { /* 무시 */ }
      log.event("trial_run", { index: index + 1, status: page.status, http: page.httpStatus ?? "-", items: page.itemCount, stable: page.stable, mode: item.mode });
      if (isBlockedPage(page)) {
        blocked = true;
        break;
      }
    }
    const line = summarizeTrial({
      plan, results, blocked, leftover: d.countProfileDirs(root), priority, browser: `${config.browser.kind}/${version}`, stop,
    });
    try {
      fs.appendFileSync(outFile, `${JSON.stringify({ at: new Date(d.now()).toISOString(), summary: line })}\n`, "utf8");
      fs.writeFileSync(path.join(paths.trialResults, "summary.txt"), `${line}\n`, "utf8");
    } catch { /* 무시 */ }
    print(line);
    log.event("trial_end", { runs: results.length, blocked: blocked ? 1 : 0, stop: stop || "-" });
    return { ok: true, line, results };
  } finally {
    lock.release();
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  const real = (file) => {
    try { return fs.realpathSync(file); } catch { return path.resolve(file); }
  };
  const self = real(fileURLToPath(import.meta.url));
  const invoked = real(path.resolve(process.argv[1]));
  return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (invokedDirectly()) {
  await runTrial();
  process.exit(0);
}
