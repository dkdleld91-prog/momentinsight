import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { COLLECTOR_VERSION, TOKEN_ENV } from "../lib/contract.mjs";
import { acquireLock } from "../lib/lock.mjs";
import { createLogger } from "../lib/log.mjs";
import { flushOutbox, saveOutbox } from "../lib/outbox.mjs";
import { splitItems } from "../lib/extract.mjs";
import { helloAuthLabel, osLabel, runWorker } from "../worker.mjs";
import { WINDOWS_CONFIG, fakeClock, fixture, removeRoot, tempRoot } from "./helpers.mjs";

const TOKEN = `mic1_${"Ab3_-".repeat(8)}xyz`;
const KEYWORD = "아이폰 18프로 사생활 보호 필름";
const RUN_IDS = ["2cd1a0b0-1111-4222-8333-444455556661", "2cd1a0b0-1111-4222-8333-444455556662", "2cd1a0b0-1111-4222-8333-444455556663"];

function okPage(overrides = {}) {
  const split = splitItems(fixture("page-full.json"));
  return {
    status: "ok", httpStatus: 200, loginWall: true, stable: true, noResultText: false, blockedText: false,
    itemCount: split.itemCount, organic: split.organic, ads: split.ads, finalHost: "www.coupang.com", finalPath: "/np/search", errorCode: null,
    ...overrides,
  };
}

function job(index = 0, extra = {}) {
  return { status: 200, body: { ok: true, state: "job", runId: RUN_IDS[index], keyword: KEYWORD, keywordKey: KEYWORD, leaseUntil: "x", windowMode: "offscreen", slotDay: "2026-10-17", slotIndex: 0, ...extra } };
}

function wait(reason, retryAfterSec, extra = {}) {
  return { status: 200, body: { ok: true, state: "wait", reason, retryAfterSec, ...extra } };
}

const RECORD_OK = { status: 200, body: { ok: true, accepted: true, duplicate: false, late: false, status: "ok", matched: 2, stop: false } };

function harness({
  hello = { status: 200, body: { ok: true, state: "run" } },
  claims = [],
  records = [],
  releases = [],
  guard = () => ({ ok: true, mode: "none" }),
  collect = null,
  collectMs = 13000,
  config = WINDOWS_CONFIG,
  token = TOKEN,
  argv = [],
  nodeVersion = "22.12.0",
  random = () => 0,
} = {}) {
  const root = tempRoot();
  const clock = fakeClock();
  const calls = { hello: [], claim: 0, record: [], release: [], collect: [], guard: 0, flush: 0, orphan: 0, sweep: 0 };
  const output = [];
  const signals = new EventEmitter();
  const env = { [TOKEN_ENV]: token, PATH: "/bin" };
  const api = {
    hello: async (body) => { calls.hello.push(body); return typeof hello === "function" ? hello() : hello; },
    claim: async () => {
      calls.claim += 1;
      const next = claims.shift() || wait("idle", 600);
      return typeof next === "function" ? next({ signals }) : next;
    },
    record: async (body, options) => {
      calls.record.push({ body, options });
      const next = records.length ? records.shift() : RECORD_OK;
      return typeof next === "function" ? next(body) : next;
    },
    release: async (runId, reason, options) => {
      calls.release.push({ runId, reason, options });
      return releases.shift() || { status: 200, body: { ok: true, released: true } };
    },
  };
  const deps = {
    now: clock.now,
    sleep: (ms) => clock.sleep(ms),
    random,
    loadConfig: () => config,
    acquireLock: (lockRoot, options) => acquireLock(lockRoot, options),
    createLogger: (logRoot, options) => createLogger(logRoot, options),
    createApi: ({ config: apiConfig, token: apiToken }) => {
      calls.apiToken = apiToken;
      calls.apiConfig = apiConfig;
      return api;
    },
    collectKeyword: async (args) => {
      calls.collect.push(args);
      clock.advance(collectMs);
      if (collect) return collect(args, { signals });
      return { page: okPage(), durationMs: collectMs, browser: "edge 141.0.3537.71", browserVersion: "141.0.3537.71", cleanupFailed: false };
    },
    runGuard: (...args) => { calls.guard += 1; return guard(calls.guard, ...args); },
    killOrphanBrowser: () => { calls.orphan += 1; return { killed: false }; },
    sweepStaleProfiles: () => { calls.sweep += 1; return 0; },
    flushOutbox: async (args) => { calls.flush += 1; return flushOutbox(args); },
    saveOutbox,
    nodeVersion,
    osRelease: "10.0.26100",
  };
  const run = () => runWorker({ appDir: path.join(root, "app"), env, argv, stdout: (line) => output.push(line), signals, deps });
  const logText = () => {
    try { return fs.readFileSync(path.join(root, "logs", "worker.log"), "utf8"); } catch { return ""; }
  };
  return { root, clock, calls, output, env, run, logText, signals, cleanup: () => removeRoot(root) };
}

function assertNoSecretsInLog(text) {
  assert.ok(!text.includes(KEYWORD), "로그에 키워드 없음");
  assert.ok(!text.includes("아이폰"), "로그에 키워드 조각 없음");
  assert.ok(!text.includes(TOKEN), "로그에 연결 코드 없음");
  assert.ok(!text.includes("mic1_"), "로그에 연결 코드 모양 없음");
  assert.ok(!text.includes("일반 상품") && !text.includes("광고 상품"), "로그에 제목 없음");
}

test("정상 실행: hello → claim → 측정 → record, gap 기다림 뒤 다음 회차, 남은 예산이 모자라면 끝", async () => {
  const h = harness({ claims: [job(0), wait("gap", 250), job(1), wait("gap", 200)] });
  try {
    const outcome = await h.run();
    assert.equal(outcome.reason, "wait_gap");
    assert.equal(outcome.jobs, 2);
    assert.equal(h.env[TOKEN_ENV], undefined, "토큰은 환경에서 지운다");
    assert.equal(h.calls.apiToken, TOKEN);
    assert.equal(h.calls.orphan, 1);
    assert.equal(h.calls.sweep, 1);
    assert.equal(h.calls.flush, 1);
    assert.deepEqual(h.calls.hello[0], {
      platform: "windows", browser: { kind: "edge", version: "unknown" }, node: "22.12.0", os: "Windows 10.0.26100", guard: "none",
    });
    assert.equal(h.calls.claim, 4);
    assert.equal(h.calls.record.length, 2);
    const first = h.calls.record[0].body;
    assert.deepEqual(Object.keys(first), ["runId", "keywordKey", "page", "durationMs", "collectorVersion", "browser"]);
    assert.equal(first.runId, RUN_IDS[0]);
    assert.equal(first.keywordKey, KEYWORD);
    assert.equal(first.collectorVersion, COLLECTOR_VERSION);
    assert.equal(first.browser, "edge 141.0.3537.71");
    assert.equal(first.durationMs, 13000);
    assert.equal(h.calls.collect[0].keyword, KEYWORD);
    assert.equal(h.calls.collect[0].windowMode, "offscreen");
    assert.deepEqual(h.clock.sleeps, [250000]);
    assert.equal(fs.readFileSync(path.join(h.root, "state", "browser-version"), "utf8").trim(), "141.0.3537.71");
    assert.equal(fs.existsSync(path.join(h.root, "state", "worker.lock")), false, "잠금 해제");
    const log = h.logText();
    for (const event of ["run_start", "hello", "job", "collect", "record", "claim_wait", "run_end"]) assert.match(log, new RegExp(` ${event} `));
    assert.match(log, / run_end reason=wait_gap jobs=2 /);
    assertNoSecretsInLog(log);
  } finally {
    h.cleanup();
  }
});

test("90초 규칙: 남은 예산이 90초 미만이면 claim 하지 않는다", async () => {
  const h = harness({ claims: [job(0), job(1)], collectMs: 400000 });
  try {
    const outcome = await h.run();
    assert.equal(outcome.reason, "budget");
    assert.equal(h.calls.claim, 1);
    // gap 대기도 남은 예산 − 90초를 넘으면 기다리지 않고 끝낸다.
    const g = harness({ claims: [wait("gap", 391)] });
    try {
      assert.equal((await g.run()).reason, "wait_gap");
      assert.deepEqual(g.clock.sleeps, []);
    } finally {
      g.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test("throttled 답도 gap 이면 그만큼(+0~5초) 기다린 뒤 다시 claim", async () => {
  const h = harness({ claims: [wait("gap", 15, { throttled: true }), job(0), wait("idle", 600)], random: () => 0.99 });
  try {
    await h.run();
    assert.deepEqual(h.clock.sleeps, [20000]);
    assert.match(h.logText(), / claim_wait reason=gap retry=15 throttled=true/);
    assert.equal(h.calls.collect.length, 1);
  } finally {
    h.cleanup();
  }
});

test("gap 이 아닌 기다림 사유는 바로 끝낸다", async () => {
  for (const reason of ["disabled", "review", "budget", "cooldown", "window", "hourly_cap", "daily_cap", "idle"]) {
    const h = harness({ claims: [wait(reason, 30)] });
    try {
      const outcome = await h.run();
      assert.equal(outcome.reason, `wait_${reason}`);
      assert.deepEqual(h.clock.sleeps, []);
      assert.equal(h.calls.collect.length, 0);
    } finally {
      h.cleanup();
    }
  }
});

test("브라우저 실행 사이 최소 30초", async () => {
  const h = harness({ claims: [job(0), wait("gap", 1), job(1), wait("idle", 600)], collectMs: 5000 });
  try {
    await h.run();
    assert.deepEqual(h.clock.sleeps, [1000, 29000]);
    assert.equal(h.calls.collect.length, 2);
  } finally {
    h.cleanup();
  }
});

test("가드: 틱 창이면 기다린 뒤 진행, 브라우저 직전에 뒤집히면 측정 없이 release(guard)", async () => {
  const waitThenGo = harness({
    claims: [job(0), wait("idle", 600)],
    guard: (count) => (count === 1 ? { ok: false, mode: "n30-chrome", reason: "guard_n30_tick_window", retryAfterSec: 100 } : { ok: true, mode: "n30-chrome" }),
  });
  try {
    await waitThenGo.run();
    assert.equal(waitThenGo.clock.sleeps[0], 100000);
    assert.equal(waitThenGo.calls.collect.length, 1);
    assert.match(waitThenGo.logText(), / guard_wait reason=guard_n30_tick_window retry=100 action=sleep/);
  } finally {
    waitThenGo.cleanup();
  }
  const flip = harness({
    claims: [job(0)],
    guard: (count) => (count === 1 ? { ok: true, mode: "n30-chrome" } : { ok: false, mode: "n30-chrome", reason: "guard_n30_watchdog_busy", retryAfterSec: 40 }),
  });
  try {
    const outcome = await flip.run();
    assert.equal(outcome.reason, "guard");
    assert.equal(flip.calls.collect.length, 0);
    assert.deepEqual(flip.calls.release.map(({ runId, reason }) => [runId, reason]), [[RUN_IDS[0], "guard"]]);
  } finally {
    flip.cleanup();
  }
  const missing = harness({ claims: [job(0)], guard: () => ({ ok: false, mode: "n30-chrome", reason: "guard_n30_chrome_missing" }) });
  try {
    assert.equal((await missing.run()).reason, "guard");
    assert.equal(missing.calls.claim, 0);
    assert.deepEqual(missing.clock.sleeps, []);
  } finally {
    missing.cleanup();
  }
});

test("stop:true·blocked·403 이면 그 회차 보고 뒤 바로 끝", async () => {
  const cases = [
    { records: [{ status: 200, body: { ok: true, accepted: true, status: "empty", stop: true } }], collect: null, reason: "stop" },
    { records: [RECORD_OK], collect: () => ({ page: okPage({ status: "blocked", blockedText: true }), durationMs: 1, browser: "edge x", browserVersion: "unknown" }), reason: "blocked" },
    { records: [RECORD_OK], collect: () => ({ page: okPage({ status: "error", httpStatus: 403, errorCode: "cdp_error", organic: [], ads: [] }), durationMs: 1, browser: "edge x", browserVersion: "unknown" }), reason: "blocked" },
  ];
  for (const item of cases) {
    const h = harness({ claims: [job(0), job(1)], records: item.records, collect: item.collect });
    try {
      const outcome = await h.run();
      assert.equal(outcome.reason, item.reason);
      assert.equal(h.calls.claim, 1);
      assert.equal(h.calls.record.length, 1);
    } finally {
      h.cleanup();
    }
  }
});

test("401·426·경로 덮임(코드 없는 4xx)이면 끝: hello·claim·record", async () => {
  const routeMissing = { status: 404, body: null, routeMissing: true };
  const helloCases = [
    [{ status: 401, body: { ok: false, code: "COLLECTOR_AUTH_REJECTED" } }, "hello_rejected"],
    [{ status: 426, body: { ok: false, code: "COLLECTOR_UPDATE_REQUIRED", minVersion: "1.1.0" } }, "hello_update_required"],
    [routeMissing, "route_missing"],
    [{ status: 503, body: { ok: false, code: "COUPANG_SETUP_REQUIRED" } }, "hello_setup_required"],
    [{ status: 0, body: null }, "hello_unreachable"],
    [{ status: 200, body: { ok: true, state: "disabled" } }, "hello_disabled"],
  ];
  for (const [hello, reason] of helloCases) {
    const h = harness({ hello, claims: [job(0)] });
    try {
      assert.equal((await h.run()).reason, reason);
      assert.equal(h.calls.claim, 0);
    } finally {
      h.cleanup();
    }
  }
  const route = harness({ hello: routeMissing });
  try {
    await route.run();
    assert.match(route.logText(), / api_route_missing http=404 stage=hello/);
  } finally {
    route.cleanup();
  }
  for (const [claim, reason] of [[{ status: 401, body: { ok: false, code: "COLLECTOR_AUTH_REJECTED" } }, "auth_rejected"], [{ status: 426, body: { ok: false, code: "COLLECTOR_UPDATE_REQUIRED" } }, "update_required"], [routeMissing, "route_missing"], [{ status: 500, body: { ok: false, code: "COUPANG_RANK_WORKER_FAILED" } }, "claim_error"]]) {
    const h = harness({ claims: [claim, job(0)] });
    try {
      assert.equal((await h.run()).reason, reason);
      assert.equal(h.calls.collect.length, 0);
    } finally {
      h.cleanup();
    }
  }
  const recordAuth = harness({ claims: [job(0), job(1)], records: [{ status: 401, body: { ok: false, code: "COLLECTOR_AUTH_REJECTED" } }] });
  try {
    assert.equal((await recordAuth.run()).reason, "auth_rejected");
    assert.equal(recordAuth.calls.record.length, 1, "401 은 재시도·보관하지 않는다");
    assert.deepEqual(fs.readdirSync(path.join(recordAuth.root, "outbox")), []);
  } finally {
    recordAuth.cleanup();
  }
  const final = harness({ claims: [job(0), job(1)], records: [{ status: 409, body: { ok: false, code: "JOB_LEASE_MISMATCH" } }] });
  try {
    assert.equal((await final.run()).reason, "record_rejected");
    assert.match(final.logText(), / record_dropped run=2cd1a0b0 http=409 code=JOB_LEASE_MISMATCH/);
  } finally {
    final.cleanup();
  }
});

test("record 가 0·5xx·경로 덮임이면 1·3·9초 재시도 뒤 보관함에 두고 끝", async () => {
  const h = harness({ claims: [job(0), job(1)], records: [{ status: 0 }, { status: 502, body: null }, { status: 0 }, { status: 503, body: { ok: false, code: "X" } }] });
  try {
    const outcome = await h.run();
    assert.equal(outcome.reason, "outbox");
    assert.equal(h.calls.record.length, 4);
    assert.deepEqual(h.clock.sleeps, [1000, 3000, 9000]);
    const files = fs.readdirSync(path.join(h.root, "outbox"));
    assert.deepEqual(files, [`${RUN_IDS[0]}.json`]);
    const saved = JSON.parse(fs.readFileSync(path.join(h.root, "outbox", files[0]), "utf8"));
    assert.equal(saved.body.runId, RUN_IDS[0]);
    assert.ok(Date.parse(saved.savedAt));
    assert.match(h.logText(), / outbox_saved run=2cd1a0b0/);
  } finally {
    h.cleanup();
  }
  const route = harness({ claims: [job(0)], records: [1, 2, 3, 4].map(() => ({ status: 404, body: null, routeMissing: true })) });
  try {
    assert.equal((await route.run()).reason, "route_missing");
    assert.equal(fs.readdirSync(path.join(route.root, "outbox")).length, 1);
    assert.match(route.logText(), / api_route_missing http=404 stage=record/);
  } finally {
    route.cleanup();
  }
});

test("시작할 때 보관함 재전송: 401·426·경로 덮임이면 실행을 끝낸다(hello 안 함), 200 이면 지우고 진행", async () => {
  for (const [response, reason] of [
    [{ status: 404, body: null, routeMissing: true }, "route_missing"],
    [{ status: 401, body: { ok: false, code: "COLLECTOR_AUTH_REJECTED" } }, "auth_rejected"],
    [{ status: 426, body: { ok: false, code: "COLLECTOR_UPDATE_REQUIRED" } }, "update_required"],
  ]) {
    const h = harness({ records: [response] });
    try {
      saveOutbox(h.root, RUN_IDS[2], { action: "record", runId: RUN_IDS[2], keywordKey: KEYWORD, page: okPage() }, { now: h.clock.now });
      const outcome = await h.run();
      assert.equal(outcome.reason, reason);
      assert.equal(h.calls.hello.length, 0);
      assert.equal(fs.readdirSync(path.join(h.root, "outbox")).length, 1, "파일은 남긴다(나이로 정리)");
    } finally {
      h.cleanup();
    }
  }
  const sent = harness({ records: [{ status: 200, body: { ok: true, accepted: false, duplicate: true, status: "ok" } }] });
  try {
    saveOutbox(sent.root, RUN_IDS[2], { action: "record", runId: RUN_IDS[2], keywordKey: KEYWORD, page: okPage() }, { now: sent.clock.now });
    await sent.run();
    assert.equal(sent.calls.hello.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(sent.root, "outbox")), []);
    assert.match(sent.logText(), / outbox_sent run=2cd1a0b0 duplicate=true/);
  } finally {
    sent.cleanup();
  }
});

test("SIGTERM: 브라우저를 띄우기 전이면 release(shutdown), 띄운 뒤면 shutdown 결과를 3초 안에 한 번 보고", async () => {
  const before = harness({ claims: [({ signals }) => { signals.emit("SIGTERM"); return job(0); }] });
  try {
    const outcome = await before.run();
    assert.equal(outcome.reason, "shutdown");
    assert.equal(before.calls.collect.length, 0);
    assert.deepEqual(before.calls.release.map(({ runId, reason, options }) => [runId, reason, options?.timeoutMs]), [[RUN_IDS[0], "shutdown", 3000]]);
  } finally {
    before.cleanup();
  }
  const during = harness({
    claims: [job(0), job(1)],
    records: [{ status: 0 }],
    collect: (args, { signals }) => {
      signals.emit("SIGTERM");
      assert.equal(args.signal.aborted, true);
      return { page: okPage({ status: "error", errorCode: "shutdown", organic: [], ads: [], stable: false }), durationMs: 10, browser: "edge x", browserVersion: "unknown" };
    },
  });
  try {
    const outcome = await during.run();
    assert.equal(outcome.reason, "shutdown");
    assert.equal(during.calls.record.length, 1);
    assert.equal(during.calls.record[0].options.timeoutMs, 3000);
    assert.equal(during.calls.record[0].body.page.errorCode, "shutdown");
    assert.equal(during.calls.claim, 1);
    assert.equal(during.signals.listenerCount("SIGTERM"), 0, "처리기를 떼어 낸다");
  } finally {
    during.cleanup();
  }
});

test("잠금·토큰·Node 버전·config 실패는 hello 없이 끝(종료 코드는 늘 0)", async () => {
  const locked = harness();
  try {
    const held = acquireLock(locked.root, { now: locked.clock.now });
    assert.equal(held.ok, true);
    held.refresh();
    assert.equal((await locked.run()).reason, "locked");
    assert.equal(locked.calls.hello.length, 0);
    assert.match(locked.logText(), / run_skip_locked /);
    held.release();
  } finally {
    locked.cleanup();
  }
  const badToken = harness({ token: "mic1_short" });
  try {
    assert.equal((await badToken.run()).reason, "token_missing");
    assert.equal(badToken.env[TOKEN_ENV], undefined);
    assert.equal(badToken.calls.hello.length, 0);
    assertNoSecretsInLog(badToken.logText());
  } finally {
    badToken.cleanup();
  }
  const oldNode = harness({ nodeVersion: "20.18.0" });
  try {
    assert.equal((await oldNode.run()).reason, "node_version_unsupported");
  } finally {
    oldNode.cleanup();
  }
  const badConfig = harness();
  try {
    const outcome = await runWorker({
      appDir: path.join(badConfig.root, "app"), env: { [TOKEN_ENV]: TOKEN }, argv: [], stdout: () => {}, signals: new EventEmitter(),
      deps: { now: badConfig.clock.now, sleep: badConfig.clock.sleep, loadConfig: () => { throw Object.assign(new Error("x"), { code: "config_invalid", field: "apiBase" }); } },
    });
    assert.equal(outcome.reason, "config_invalid");
    assert.match(badConfig.logText(), / config_invalid field=apiBase/);
  } finally {
    badConfig.cleanup();
  }
});

test("--hello-only: 7번까지만 하고 auth=… 한 줄(브라우저·claim 없음)", async () => {
  const cases = [
    [{ status: 200, body: { ok: true, state: "disabled" } }, "auth=ok"],
    [{ status: 401, body: { ok: false, code: "COLLECTOR_AUTH_REJECTED" } }, "auth=rejected"],
    [{ status: 426, body: { ok: false, code: "COLLECTOR_UPDATE_REQUIRED" } }, "auth=update_required"],
    [{ status: 503, body: { ok: false, code: "COUPANG_SETUP_REQUIRED" } }, "auth=setup_required"],
    [{ status: 404, body: null, routeMissing: true }, "auth=route_missing"],
  ];
  for (const [hello, line] of cases) {
    const h = harness({ hello, argv: ["--hello-only"], claims: [job(0)] });
    try {
      await h.run();
      assert.deepEqual(h.output, [line]);
      assert.equal(h.calls.claim, 0);
      assert.equal(h.calls.collect.length, 0);
      assert.match(h.logText(), / run_end .*mode=hello_only/);
    } finally {
      h.cleanup();
    }
  }
  // 앞 실행이 잠금을 쥐고 있어도(업데이트 중) 인증 확인은 하되, 정리·보관함 재전송은 건너뛴다.
  const busy = harness({ argv: ["--hello-only"], claims: [job(0)] });
  try {
    const held = acquireLock(busy.root, { now: busy.clock.now });
    held.refresh();
    await busy.run();
    assert.deepEqual(busy.output, ["auth=ok"]);
    assert.equal(busy.calls.hello.length, 1);
    assert.equal(busy.calls.orphan, 0);
    assert.equal(busy.calls.sweep, 0);
    assert.equal(busy.calls.flush, 0);
    assert.ok(fs.existsSync(path.join(busy.root, "state", "worker.lock")), "남의 잠금은 지우지 않는다");
    held.release();
  } finally {
    busy.cleanup();
  }
  const noToken = harness({ token: "", argv: ["--hello-only"] });
  try {
    await noToken.run();
    assert.deepEqual(noToken.output, ["auth=token_missing"]);
  } finally {
    noToken.cleanup();
  }
});

test("서버가 모르는 창 방식을 주면 기본 offscreen, 응답 모양이 틀린 job 은 측정하지 않는다", async () => {
  const h = harness({ claims: [job(0, { windowMode: "fullscreen" }), job(1, { runId: "not-a-uuid" })] });
  try {
    const outcome = await h.run();
    assert.equal(h.calls.collect[0].windowMode, "offscreen");
    assert.equal(h.calls.collect.length, 1);
    assert.equal(outcome.reason, "claim_invalid");
  } finally {
    h.cleanup();
  }
});

test("helloAuthLabel·osLabel", () => {
  assert.equal(helloAuthLabel({ status: 200, body: { ok: true } }), "ok");
  assert.equal(helloAuthLabel({ status: 500, body: { ok: false, code: "COUPANG_RANK_WORKER_FAILED" } }), "error");
  assert.equal(osLabel("windows", "10.0.26100"), "Windows 10.0.26100");
  assert.equal(osLabel("macos", "25.6.0"), "macOS Darwin 25.6.0");
  assert.ok(osLabel("macos", "x".repeat(100)).length <= 60);
});
