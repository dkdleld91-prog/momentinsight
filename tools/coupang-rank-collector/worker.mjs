// C 30일 순위(쿠팡) 수집기 1회 실행(명세 §9.3). 예약 작업(윈도우)·launchd(맥)가 10분마다 부른다.
// 서버에서 검색어 하나씩 임대(claim)해 새 프로필 브라우저로 검색 1쪽을 읽고 보고(record)한다. 맞추기·순위는 서버가 한다.
// 종료 코드는 늘 0(상태는 서버·로그로 본다). 로그에 키워드·연결 코드·제목을 남기지 않는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCKED_HTTP_STATUSES, CLAIM_MIN_REMAINING_SECONDS, COLLECTOR_TOKEN_PATTERN, COLLECTOR_VERSION, DEFAULT_WINDOW_MODE,
  MIN_BROWSER_GAP_SECONDS, RECORD_FINAL_CODES, RECORD_RETRY_DELAYS_MS, RUN_BUDGET_SECONDS, TOKEN_ENV, WINDOW_MODES,
} from "./lib/contract.mjs";
import { checkNodeRuntime, guardModeOf, loadConfig, rootFromAppDir } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import { acquireLock } from "./lib/lock.mjs";
import {
  killOrphanBrowser, readBrowserVersionFile, sweepStaleProfiles, writeBrowserVersionFile,
} from "./lib/browser.mjs";
import { collectKeyword } from "./lib/collect.mjs";
import { createApi } from "./lib/api.mjs";
import { flushOutbox, saveOutbox } from "./lib/outbox.mjs";
import { isWaitableGuardReason, runGuard } from "./lib/guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHUTDOWN_CALL_TIMEOUT_MS = 3000;

const realSleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const timer = setTimeout(done, Math.max(0, ms));
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", done);
    resolve();
  }
  signal?.addEventListener?.("abort", done, { once: true });
});

export function osLabel(platform, release = os.release()) {
  return `${platform === "windows" ? "Windows" : "macOS Darwin"} ${release}`.slice(0, 60);
}

export function helloAuthLabel(response) {
  if (!response) return "error";
  if (response.status >= 200 && response.status < 300 && response.body?.ok) return "ok";
  if (response.status === 401) return "rejected";
  if (response.status === 426) return "update_required";
  if (response.status === 503 && response.body?.code === "COUPANG_SETUP_REQUIRED") return "setup_required";
  if (response.routeMissing) return "route_missing";
  if (response.status === 0) return "unreachable";
  return "error";
}

function shortRun(runId) {
  return String(runId || "").slice(0, 8);
}

function retrySeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
}

export async function runWorker({ appDir = HERE, env = process.env, argv = process.argv.slice(2), stdout = null, signals = process, deps = {} } = {}) {
  // 연결 코드는 시작 즉시 메모리로 옮기고 환경에서 지운다(§3.1).
  const rawToken = env[TOKEN_ENV];
  delete env[TOKEN_ENV];
  const d = {
    now: Date.now,
    sleep: realSleep,
    random: Math.random,
    loadConfig,
    acquireLock,
    createLogger,
    createApi,
    collectKeyword,
    runGuard,
    killOrphanBrowser,
    sweepStaleProfiles,
    flushOutbox,
    saveOutbox,
    checkNodeRuntime,
    readBrowserVersionFile,
    writeBrowserVersionFile,
    nodeVersion: process.versions.node,
    osRelease: os.release(),
    ...deps,
  };
  const helloOnly = argv.includes("--hello-only");
  const print = typeof stdout === "function" ? stdout : (line) => process.stdout.write(`${line}\n`);
  const root = rootFromAppDir(appDir);
  const log = d.createLogger(root, { now: () => new Date(d.now()) });
  const startedAt = d.now();
  const outcome = { reason: "done", jobs: 0, auth: null };
  const shutdown = new AbortController();
  let phase = "idle";
  const onSignal = () => {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    log.event("shutdown_signal", { phase });
  };
  const sleepFor = (ms) => d.sleep(ms, shutdown.signal);
  const remainingSeconds = () => RUN_BUDGET_SECONDS - (d.now() - startedAt) / 1000;
  const finish = (reason) => {
    outcome.reason = reason;
    if (helloOnly) print(`auth=${outcome.auth || "error"}`);
    return outcome;
  };
  signals?.on?.("SIGTERM", onSignal);
  signals?.on?.("SIGINT", onSignal);
  let lock = null;
  try {
    log.event("run_start", { version: COLLECTOR_VERSION, mode: helloOnly ? "hello_only" : "run", pid: process.pid });

    // 1. config
    let config;
    try {
      config = d.loadConfig(root);
    } catch (error) {
      log.event("config_invalid", { field: error?.field || "unknown" });
      outcome.auth = "config_invalid";
      return finish("config_invalid");
    }

    // 2. 잠금. --hello-only(설치기 인증 확인)는 앞 실행이 아직 돌아 잠금을 못 잡아도 hello 만 한다
    //    (이때는 5·6단계의 정리·재전송을 건너뛴다. 돌고 있는 실행의 브라우저·보관함을 건드리지 않기 위해서다).
    lock = d.acquireLock(root, { now: d.now });
    let exclusive = true;
    if (!lock?.ok) {
      log.event("run_skip_locked", { reason: lock?.reason || "locked", mode: helloOnly ? "hello_only" : "run" });
      lock = null;
      if (!helloOnly) {
        outcome.auth = "locked";
        return finish("locked");
      }
      exclusive = false;
    }

    // 3. 연결 코드 형식
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!COLLECTOR_TOKEN_PATTERN.test(token)) {
      log.event("token_missing", {});
      outcome.auth = "token_missing";
      return finish("token_missing");
    }

    // 4. 실행 환경
    if (!d.checkNodeRuntime({ version: d.nodeVersion })) {
      log.event("node_version_unsupported", { node: d.nodeVersion });
      outcome.auth = "node_version_unsupported";
      return finish("node_version_unsupported");
    }

    // 5. 남은 브라우저·낡은 프로필 정리
    if (exclusive) {
      d.killOrphanBrowser(root, log, { platform: config.platform });
      d.sweepStaleProfiles(root, d.now());
    }

    const api = d.createApi({ config, token });

    // 6. 보관함 재전송
    const flushed = exclusive ? await d.flushOutbox({ root, api, log, now: d.now }) : null;
    if (flushed?.stop) {
      outcome.auth = flushed.reason === "auth_rejected" ? "rejected" : flushed.reason === "update_required" ? "update_required" : "route_missing";
      return finish(flushed.reason || "outbox_stop");
    }

    // 7. hello
    const guardMode = guardModeOf(config);
    const hello = await api.hello({
      platform: config.platform,
      browser: { kind: config.browser.kind, version: d.readBrowserVersionFile(root) },
      node: String(d.nodeVersion).slice(0, 20),
      os: osLabel(config.platform, d.osRelease),
      guard: guardMode,
    });
    outcome.auth = helloAuthLabel(hello);
    log.event("hello", { http: hello.status, state: hello.body?.state || "-", code: hello.body?.code || "-", guard: guardMode });
    if (hello.status === 0) log.event("api_unreachable", { stage: "hello" });
    if (hello.routeMissing) {
      log.event("api_route_missing", { http: hello.status, stage: "hello" });
      return finish("route_missing");
    }
    if (outcome.auth !== "ok") return finish(`hello_${outcome.auth}`);
    if (helloOnly) return finish("hello_only");
    if (hello.body.state !== "run") return finish(`hello_${String(hello.body.state || "unknown").slice(0, 20)}`);

    // 8. 반복
    let lastBrowserEndAt = null;
    for (;;) {
      if (shutdown.signal.aborted) return finish("shutdown");
      // a. 남은 예산
      if (remainingSeconds() < CLAIM_MIN_REMAINING_SECONDS) return finish("budget");

      // b. N30 보호(맥 Chrome 일 때만 실제 검사)
      const guard = d.runGuard(config, { now: d.now() });
      if (!guard.ok) {
        const retry = retrySeconds(guard.retryAfterSec);
        if (isWaitableGuardReason(guard.reason) && retry > 0 && retry <= remainingSeconds() - CLAIM_MIN_REMAINING_SECONDS) {
          log.event("guard_wait", { reason: guard.reason, retry, action: "sleep" });
          await sleepFor(retry * 1000);
          continue;
        }
        log.event("guard_wait", { reason: guard.reason, retry: retry || "-", action: "end" });
        return finish("guard");
      }

      // c. claim
      const claim = await api.claim();
      if (claim.status === 401 || claim.status === 426) {
        log.event("claim_error", { http: claim.status, code: claim.body?.code || "-" });
        return finish(claim.status === 401 ? "auth_rejected" : "update_required");
      }
      if (claim.routeMissing) {
        log.event("api_route_missing", { http: claim.status, stage: "claim" });
        return finish("route_missing");
      }
      if (claim.status !== 200 || !claim.body?.ok) {
        log.event("claim_error", { http: claim.status, code: claim.body?.code || "-" });
        if (claim.status === 0) log.event("api_unreachable", { stage: "claim" });
        return finish("claim_error");
      }
      const reply = claim.body;
      if (reply.state === "wait") {
        const retry = retrySeconds(reply.retryAfterSec);
        log.event("claim_wait", { reason: reply.reason || "-", retry, throttled: Boolean(reply.throttled) });
        if (reply.reason === "gap" && retry > 0 && retry <= remainingSeconds() - CLAIM_MIN_REMAINING_SECONDS) {
          await sleepFor((retry + Math.floor(d.random() * 6)) * 1000);
          continue;
        }
        return finish(`wait_${String(reply.reason || "unknown").slice(0, 20)}`);
      }
      if (reply.state !== "job" || !RUN_ID_PATTERN.test(String(reply.runId || "")) || typeof reply.keyword !== "string"
        || !reply.keyword || typeof reply.keywordKey !== "string" || !reply.keywordKey) {
        log.event("claim_error", { http: claim.status, state: reply.state || "-", code: "reply_invalid" });
        return finish("claim_invalid");
      }
      const runId = reply.runId;
      outcome.jobs += 1;
      phase = "claimed";
      log.event("job", { run: shortRun(runId), slot: `${reply.slotDay || "-"}#${reply.slotIndex ?? "-"}` });

      // d. 브라우저 실행 사이 30초
      if (lastBrowserEndAt !== null) {
        const waitMs = MIN_BROWSER_GAP_SECONDS * 1000 - (d.now() - lastBrowserEndAt);
        if (waitMs > 0) await sleepFor(waitMs);
      }
      if (shutdown.signal.aborted) {
        const released = await api.release(runId, "shutdown", { timeoutMs: SHUTDOWN_CALL_TIMEOUT_MS });
        log.event("release", { run: shortRun(runId), reason: "shutdown", http: released.status });
        return finish("shutdown");
      }

      // e. 브라우저를 띄우기 직전에 보호를 다시 본다. 쉬어야 하면 측정 없이 반납한다.
      const guardAgain = d.runGuard(config, { now: d.now() });
      if (!guardAgain.ok) {
        log.event("guard_wait", { reason: guardAgain.reason, retry: retrySeconds(guardAgain.retryAfterSec) || "-", action: "release" });
        const released = await api.release(runId, "guard");
        log.event("release", { run: shortRun(runId), reason: "guard", http: released.status });
        return finish("guard");
      }

      // f. 측정
      phase = "browser";
      const windowMode = WINDOW_MODES.includes(reply.windowMode) ? reply.windowMode : DEFAULT_WINDOW_MODE;
      const collected = await d.collectKeyword({ config, keyword: reply.keyword, windowMode, root, log, signal: shutdown.signal });
      lastBrowserEndAt = d.now();
      phase = "record";
      d.writeBrowserVersionFile(root, collected.browserVersion);
      const page = collected.page;
      log.event("collect", {
        run: shortRun(runId), status: page.status, http: page.httpStatus ?? "-", items: page.itemCount,
        organic: page.organic.length, ads: page.ads.length, stable: page.stable, ms: collected.durationMs,
        code: page.errorCode || "-", mode: windowMode,
      });

      // g. 보고(1·3·9초 재시도 → 보관함)
      const recordBody = {
        runId, keywordKey: reply.keywordKey, page, durationMs: collected.durationMs,
        collectorVersion: COLLECTOR_VERSION, browser: collected.browser,
      };
      if (shutdown.signal.aborted) {
        const response = await api.record(recordBody, { timeoutMs: SHUTDOWN_CALL_TIMEOUT_MS });
        log.event("record", { run: shortRun(runId), http: response.status, accepted: Boolean(response.body?.accepted), code: response.body?.code || "-", shutdown: 1 });
        return finish("shutdown");
      }
      let response;
      for (let attempt = 0; ; attempt += 1) {
        response = await api.record(recordBody);
        const retryable = response.status === 0 || response.status >= 500 || response.routeMissing;
        if (!retryable || attempt >= RECORD_RETRY_DELAYS_MS.length || shutdown.signal.aborted) break;
        await sleepFor(RECORD_RETRY_DELAYS_MS[attempt]);
      }
      const retryable = response.status === 0 || response.status >= 500 || response.routeMissing;
      if (retryable) {
        if (response.routeMissing) log.event("api_route_missing", { http: response.status, stage: "record" });
        if (response.status === 0) log.event("api_unreachable", { stage: "record" });
        d.saveOutbox(root, runId, recordBody, { log, now: d.now });
        return finish(response.routeMissing ? "route_missing" : "outbox");
      }
      const body = response.body || {};
      if (response.status >= 200 && response.status < 300 && body.ok) {
        log.event("record", {
          run: shortRun(runId), accepted: Boolean(body.accepted), duplicate: Boolean(body.duplicate), status: body.status || "-",
          matched: body.matched ?? "-", stop: Boolean(body.stop), late: Boolean(body.late), code: "-",
        });
      } else if (typeof body.code === "string" && RECORD_FINAL_CODES.includes(body.code)) {
        log.event("record_dropped", { run: shortRun(runId), http: response.status, code: body.code });
        return finish("record_rejected");
      } else {
        log.event("record", { run: shortRun(runId), http: response.status, code: body.code || "-", accepted: false });
        return finish(response.status === 401 ? "auth_rejected" : response.status === 426 ? "update_required" : "record_rejected");
      }

      // h. 차단·빈 쪽·쉬기 등: 이번 실행을 바로 끝낸다.
      phase = "idle";
      if (body.stop) return finish("stop");
      if (page.status === "blocked" || BLOCKED_HTTP_STATUSES.includes(page.httpStatus)) return finish("blocked");
    }
  } catch (error) {
    log.event("run_error", { code: error?.code || "unexpected" });
    return finish("run_error");
  } finally {
    signals?.off?.("SIGTERM", onSignal);
    signals?.off?.("SIGINT", onSignal);
    if (lock) lock.release();
    log.event("run_end", { reason: outcome.reason, jobs: outcome.jobs, ms: d.now() - startedAt, mode: helloOnly ? "hello_only" : "run" });
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
  await runWorker();
  process.exit(0);
}
