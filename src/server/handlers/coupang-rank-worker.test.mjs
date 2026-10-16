import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  handleCoupangRankWorkerRequest,
  helloFields,
  helloStateFor,
  kstHourOf,
} from "./coupang-rank-worker.mjs";
import workerApp from "./coupang-rank-worker.mjs";
import { collectorTokenHash } from "../coupang-rank/worker-token.mjs";
import {
  CLAIM_MIN_REMAINING_SECONDS,
  MIN_BROWSER_GAP_SECONDS,
  RUN_BUDGET_SECONDS,
  WORKER_BODY_MAX_BYTES,
} from "../coupang-rank/contract.mjs";

const HANDLER_SOURCE = fs.readFileSync(new URL("./coupang-rank-worker.mjs", import.meta.url), "utf8");
const URL_WORKER = "https://insight.momentlabs.co.kr/api/coupang-rank-worker";
const TOKEN = `mic1_${"Q".repeat(40)}x9Q`;
const OTHER_TOKEN = `mic1_${"R".repeat(40)}x9R`;
const COLLECTOR_ID = "5b0f3c1e-1d2a-4f7e-9c3b-8a6d2e4f1a00";
const RUN_ID = "2cd1a0b4-9e1f-4c55-8a2b-0f6c3d9e7a10";
const KEYWORD = "아이폰 18프로 사생활 보호 필름";

function collectorRow(overrides = {}) {
  return {
    id: COLLECTOR_ID,
    label: "윈도우 데스크탑",
    token_sha256: collectorTokenHash(TOKEN),
    token_hint: TOKEN.slice(-4),
    created_at: "2026-10-16T00:00:00.000Z",
    revoked_at: null,
    last_seen_at: null,
    platform: null,
    last_version: null,
    last_node: null,
    last_browser: null,
    last_os: null,
    last_guard: null,
    last_claim_at: null,
    ...overrides,
  };
}

function settingsRow(overrides = {}) {
  return {
    id: 1,
    enabled: true,
    needs_owner_review: false,
    budget_blocked: false,
    cooldown_until: null,
    cooldown_reason: null,
    active_from_hour: 0,
    active_to_hour: 24,
    window_mode: "offscreen",
    min_collector_version: null,
    last_housekeeping_at: new Date().toISOString(),
    ...overrides,
  };
}

// 수집기 API 가 쓰는 만큼만 흉내 낸 Supabase. 모든 호출을 calls 에 남긴다.
function fakeDb({ collectors = [collectorRow()], settings = settingsRow(), errors = {}, rpc = {} } = {}) {
  const calls = [];
  const state = { collectors, settings };

  class Query {
    constructor(table) {
      this.table = table;
      this.operation = "select";
      this.values = null;
      this.filters = [];
      this.orFilter = null;
    }

    select(columns) {
      this.columns = columns;
      return this;
    }

    update(values) {
      this.operation = "update";
      this.values = values;
      return this;
    }

    eq(column, value) {
      this.filters.push([column, value]);
      return this;
    }

    or(expression) {
      this.orFilter = expression;
      return this;
    }

    matches(row) {
      if (!this.filters.every(([column, value]) => row[column] === value)) return false;
      if (this.orFilter) {
        const match = /^last_seen_at\.is\.null,last_seen_at\.lt\.(.+)$/.exec(this.orFilter);
        if (!match) throw new Error(`unsupported or filter ${this.orFilter}`);
        const cutoff = Date.parse(match[1]);
        return row.last_seen_at === null || Date.parse(row.last_seen_at) < cutoff;
      }
      return true;
    }

    rows() {
      if (this.table === "coupang_rank_collectors") return state.collectors;
      if (this.table === "coupang_rank_settings") return state.settings ? [state.settings] : [];
      throw new Error(`unexpected table ${this.table}`);
    }

    async maybeSingle() {
      calls.push({ type: "select", table: this.table, filters: this.filters });
      const error = errors[`select:${this.table}`];
      if (error) return { data: null, error };
      const found = this.rows().filter((row) => this.matches(row));
      return { data: found[0] ? { ...found[0] } : null, error: null };
    }

    then(resolve, reject) {
      return Promise.resolve().then(() => {
        if (this.operation !== "update") throw new Error("only update is awaited directly");
        calls.push({ type: "update", table: this.table, values: this.values, filters: this.filters, or: this.orFilter });
        const error = errors[`update:${this.table}`];
        if (error) return { data: null, error };
        let count = 0;
        for (const row of this.rows()) {
          if (this.matches(row)) {
            Object.assign(row, this.values);
            count += 1;
          }
        }
        return { data: null, error: null, count };
      }).then(resolve, reject);
    }
  }

  return {
    calls,
    state,
    rpcCalls: () => calls.filter((call) => call.type === "rpc"),
    ctx: {
      supabaseAdmin: {
        from(table) {
          return new Query(table);
        },
        async rpc(name, args) {
          calls.push({ type: "rpc", name, args });
          const handler = rpc[name];
          if (handler === undefined) throw new Error(`unexpected rpc ${name}`);
          return typeof handler === "function" ? handler(args) : handler;
        },
      },
    },
  };
}

function workerRequest(body, { token = TOKEN, version = "1.0.0", headers = {}, method = "POST", raw } = {}) {
  const all = new Headers({ "content-type": "application/json", ...headers });
  if (token !== null) all.set("authorization", `Bearer ${token}`);
  if (version !== null) all.set("x-mi-coupang-collector", version);
  const init = { method, headers: all };
  if (method !== "GET" && method !== "HEAD") init.body = raw !== undefined ? raw : JSON.stringify(body);
  return new Request(URL_WORKER, init);
}

async function call(db, body, options) {
  const response = await handleCoupangRankWorkerRequest(workerRequest(body, options), db.ctx);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const HELLO = {
  action: "hello",
  platform: "windows",
  browser: { kind: "edge", version: "141.0.3537.71" },
  node: "22.12.0",
  os: "Windows 10.0.26100",
  guard: "none",
};

function recordBody(pageOverrides = {}, overrides = {}) {
  return {
    action: "record",
    runId: RUN_ID,
    keywordKey: KEYWORD,
    page: {
      status: "ok",
      httpStatus: 200,
      loginWall: true,
      stable: true,
      noResultText: false,
      blockedText: false,
      itemCount: 60,
      organic: [{ p: "9000001", v: "", s: 3 }, { p: "8533720933", v: "96009802650", s: 38, t: "아이쉘 360도 …" }],
      ads: [{ p: "8533720933", v: "96009802650", s: 22, t: "아이쉘 360도 …" }],
      finalHost: "www.coupang.com",
      finalPath: "/np/search",
      errorCode: null,
      ...pageOverrides,
    },
    durationMs: 14833,
    collectorVersion: "1.0.0",
    browser: "edge 141.0.3537.71",
    ...overrides,
  };
}

const RECORD_OK = { ok: true, accepted: true, duplicate: false, late: false, status: "ok", matched: 3, stop: false, cooldownUntil: null, reviewRequired: false };

async function quietly(fn) {
  const original = { warn: console.warn, error: console.error };
  const logs = [];
  console.warn = (...args) => logs.push(["warn", ...args]);
  console.error = (...args) => logs.push(["error", ...args]);
  try {
    return { result: await fn(), logs };
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
}

test("형식이 틀린 연결 코드는 DB 조회 0으로 401", async () => {
  const db = fakeDb();
  const cases = [
    { token: null },
    { token: "abc" },
    { token: `${TOKEN}=` },
    { token: TOKEN.slice(0, -1) },
    { token: null, headers: { authorization: TOKEN } },
    { token: null, headers: { authorization: `bearer ${TOKEN}` } },
    { token: null, headers: { authorization: `Basic ${TOKEN}` } },
  ];
  for (const options of cases) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, { action: "claim" }, options);
    assert.equal(result.status, 401, JSON.stringify(options));
    assert.equal(result.body.code, "COLLECTOR_AUTH_REJECTED");
    assert.equal(result.body.ok, false);
  }
  // 형식이 틀리면 본문 크기도 보지 않는다(인증이 본문보다 먼저)
  const big = await call(db, null, { token: "abc", raw: "x".repeat(WORKER_BODY_MAX_BYTES + 10) });
  assert.equal(big.status, 401);
  assert.equal(db.calls.length, 0);
});

test("해시 불일치·폐기된 연결 코드는 401", async () => {
  const unknown = fakeDb();
  const missing = await call(unknown, { action: "claim" }, { token: OTHER_TOKEN });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, "COLLECTOR_AUTH_REJECTED");
  assert.equal(unknown.rpcCalls().length, 0);
  assert.equal(unknown.calls.filter((entry) => entry.type === "update").length, 0);

  const revoked = fakeDb({ collectors: [collectorRow({ revoked_at: "2026-10-16T05:00:00.000Z" })] });
  const rejected = await call(revoked, { action: "claim" });
  assert.equal(rejected.status, 401);
  assert.equal(revoked.rpcCalls().length, 0);
  assert.equal(revoked.calls.filter((entry) => entry.type === "update").length, 0);
});

test("405: POST 가 아니면 거절하고, 핸들러에는 OPTIONS 분기가 없다", async () => {
  const db = fakeDb();
  for (const method of ["GET", "PUT", "DELETE"]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, { action: "claim" }, { method });
    assert.equal(result.status, 405, method);
    assert.equal(result.body.code, "METHOD_NOT_ALLOWED");
  }
  assert.equal(db.calls.length, 0);
  assert.equal(HANDLER_SOURCE.includes('"OPTIONS"'), false);
  assert.match(HANDLER_SOURCE, /withSupabase\(\{ auth: "none", cors: false \}, handleCoupangRankWorkerRequest\)/);
  assert.equal(typeof workerApp.fetch, "function");
});

test("413: content-length 가 64KB 를 넘거나 실제 본문이 넘으면 DB 조회 없이 거절", async () => {
  const db = fakeDb();
  const declared = await call(db, { action: "claim" }, { headers: { "content-length": String(WORKER_BODY_MAX_BYTES + 1) } });
  assert.equal(declared.status, 413);
  assert.equal(declared.body.code, "BODY_TOO_LARGE");
  const streamed = await call(db, null, { raw: JSON.stringify({ action: "claim", pad: "x".repeat(WORKER_BODY_MAX_BYTES) }) });
  assert.equal(streamed.status, 413);
  assert.equal(streamed.body.code, "BODY_TOO_LARGE");
  assert.equal(db.calls.length, 0);

  // 정확히 상한이면 받는다
  const base = JSON.stringify({ action: "claim", pad: "" });
  const exact = JSON.stringify({ action: "claim", pad: "x".repeat(WORKER_BODY_MAX_BYTES - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(exact), WORKER_BODY_MAX_BYTES);
  const okDb = fakeDb({ rpc: { coupang_rank_claim: { data: { state: "wait", reason: "gap", retryAfterSec: 30 }, error: null } } });
  const accepted = await call(okDb, null, { raw: exact });
  assert.equal(accepted.status, 200);
});

test("400 BODY_INVALID: JSON 이 아니거나 객체가 아니거나 UTF-8 이 깨짐", async () => {
  const db = fakeDb();
  for (const raw of ["", "not json", "[]", "null", "42", "\"claim\""]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, null, { raw });
    assert.equal(result.status, 400, raw);
    assert.equal(result.body.code, "BODY_INVALID");
  }
  const broken = await call(db, null, { raw: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) });
  assert.equal(broken.status, 400);
  assert.equal(broken.body.code, "BODY_INVALID");
  assert.equal(db.calls.length, 0);
});

test("400 ACTION_INVALID: 알 수 없는 action", async () => {
  const db = fakeDb();
  for (const action of [undefined, "", "submit", "HELLO", 7]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, { action });
    assert.equal(result.status, 400, String(action));
    assert.equal(result.body.code, "ACTION_INVALID");
  }
  assert.equal(db.rpcCalls().length, 0);
  assert.equal(db.calls.filter((entry) => entry.type === "update").length, 0);
});

test("버전 머리글 형식이 틀리면 모든 동작에서 400 COLLECTOR_VERSION_INVALID", async () => {
  const db = fakeDb();
  for (const version of [null, "", "1.0", "v1.0.0", "1.0.0-beta", "1.0.0.0", "1000.0.0"]) {
    for (const body of [HELLO, { action: "claim" }, recordBody(), { action: "release", runId: RUN_ID, reason: "guard" }]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await call(db, body, { version });
      assert.equal(result.status, 400, `${version} ${body.action}`);
      assert.equal(result.body.code, "COLLECTOR_VERSION_INVALID");
    }
  }
  assert.equal(db.rpcCalls().length, 0);
  assert.equal(db.calls.filter((entry) => entry.type === "update").length, 0);
});

test("426 은 hello·claim 에만, record·release 는 버전이 낮아도 받는다", async () => {
  const rpc = {
    coupang_rank_claim: { data: { state: "wait", reason: "gap", retryAfterSec: 100 }, error: null },
    coupang_rank_record: { data: RECORD_OK, error: null },
    coupang_rank_release: { data: { ok: true, released: true }, error: null },
  };
  const db = fakeDb({ settings: settingsRow({ min_collector_version: "1.2.0" }), rpc });
  for (const body of [HELLO, { action: "claim" }]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, body, { version: "1.1.9" });
    assert.equal(result.status, 426, body.action);
    assert.deepEqual(
      { code: result.body.code, minVersion: result.body.minVersion, ok: result.body.ok },
      { code: "COLLECTOR_UPDATE_REQUIRED", minVersion: "1.2.0", ok: false },
    );
  }
  assert.equal(db.rpcCalls().length, 0);
  assert.equal(db.calls.filter((entry) => entry.type === "update").length, 0, "426 이면 신호도 쓰지 않는다");

  const recorded = await call(db, recordBody(), { version: "1.0.0" });
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.accepted, true);
  const released = await call(db, { action: "release", runId: RUN_ID, reason: "shutdown" }, { version: "1.0.0" });
  assert.equal(released.status, 200);
  assert.equal(released.body.released, true);

  // 같거나 높으면 hello·claim 도 통과(숫자 비교: 1.10.0 > 1.2.0)
  for (const version of ["1.2.0", "1.10.0", "2.0.0"]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, { action: "claim" }, { version });
    assert.equal(result.status, 200, version);
  }
});

test("last_seen 은 60초에 한 번만 쓰고, 조건부 update 로 겹침을 막는다", async () => {
  const rpc = { coupang_rank_claim: { data: { state: "wait", reason: "gap", retryAfterSec: 100 }, error: null } };

  const fresh = fakeDb({ collectors: [collectorRow({ last_seen_at: new Date(Date.now() - 30_000).toISOString() })], rpc });
  assert.equal((await call(fresh, { action: "claim" })).status, 200);
  assert.equal(fresh.calls.filter((entry) => entry.type === "update").length, 0, "60초 안이면 쓰기 요청 0");

  const stale = fakeDb({ collectors: [collectorRow({ last_seen_at: new Date(Date.now() - 120_000).toISOString(), last_version: "0.9.0" })], rpc });
  const before = Date.now();
  assert.equal((await call(stale, { action: "claim" }, { version: "1.0.3" })).status, 200);
  const updates = stale.calls.filter((entry) => entry.type === "update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].table, "coupang_rank_collectors");
  assert.deepEqual(updates[0].filters, [["id", COLLECTOR_ID]]);
  const cutoff = /^last_seen_at\.is\.null,last_seen_at\.lt\.(.+)$/.exec(updates[0].or);
  assert.ok(cutoff, updates[0].or);
  assert.ok(Math.abs(Date.parse(cutoff[1]) - (before - 60_000)) < 5_000);
  assert.deepEqual(Object.keys(updates[0].values).sort(), ["last_seen_at", "last_version"]);
  assert.equal(updates[0].values.last_version, "1.0.3");
  assert.equal(stale.state.collectors[0].last_version, "1.0.3");
  assert.equal(stale.state.collectors[0].platform, null, "claim 은 hello 칸을 건드리지 않는다");

  const never = fakeDb({ rpc });
  assert.equal((await call(never, { action: "claim" })).status, 200);
  assert.equal(never.calls.filter((entry) => entry.type === "update").length, 1);
  assert.ok(never.state.collectors[0].last_seen_at);

  // 신호 쓰기가 실패해도 claim 은 계속한다(기록만)
  const failing = fakeDb({ rpc, errors: { "update:coupang_rank_collectors": { code: "57014", message: "db text" } } });
  const { result, logs } = await quietly(() => call(failing, { action: "claim" }));
  assert.equal(result.status, 200);
  assert.equal(failing.rpcCalls().length, 1);
  assert.ok(logs.some((entry) => entry[0] === "warn" && String(entry[1]).includes("coupang_rank_worker_signal_failed")));
  assert.equal(JSON.stringify(logs).includes("db text"), false);
});

test("hello: 신호와 함께 플랫폼·브라우저 칸을 저장하고 응답 모양을 지킨다", async () => {
  const db = fakeDb();
  const result = await call(db, HELLO);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(result.body), [
    "ok", "serverTime", "collectorId", "label", "state", "cooldownUntil", "windowMode",
    "maxRunSeconds", "claimMinRemainingSeconds", "minBrowserGapSeconds",
  ]);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.collectorId, COLLECTOR_ID);
  assert.equal(result.body.label, "윈도우 데스크탑");
  assert.equal(result.body.state, "run");
  assert.equal(result.body.cooldownUntil, null);
  assert.equal(result.body.windowMode, "offscreen");
  assert.equal(result.body.maxRunSeconds, RUN_BUDGET_SECONDS);
  assert.equal(result.body.claimMinRemainingSeconds, CLAIM_MIN_REMAINING_SECONDS);
  assert.equal(result.body.minBrowserGapSeconds, MIN_BROWSER_GAP_SECONDS);
  assert.ok(Number.isFinite(Date.parse(result.body.serverTime)));
  assert.equal(JSON.stringify(result.body).includes("token"), false);

  const row = db.state.collectors[0];
  assert.equal(row.platform, "windows");
  assert.equal(row.last_version, "1.0.0");
  assert.equal(row.last_node, "22.12.0");
  assert.equal(row.last_browser, "edge 141.0.3537.71");
  assert.equal(row.last_os, "Windows 10.0.26100");
  assert.equal(row.last_guard, "none");

  // 곧바로 다시 와도(설치기 --hello-only 직후 첫 실행) 막지 않는다. 쓰기 0, 읽기 2번(수집기·설정)
  const again = fakeDb({ collectors: [collectorRow({ last_seen_at: new Date().toISOString() })] });
  const second = await call(again, HELLO);
  assert.equal(second.status, 200);
  assert.equal(second.body.state, "run");
  assert.deepEqual(again.calls.map((entry) => `${entry.type}:${entry.table || entry.name}`), [
    "select:coupang_rank_collectors",
    "select:coupang_rank_settings",
  ]);
});

test("hello: 윈도우는 edge 만, 그 밖의 형식 오류는 400 BODY_INVALID(쓰기 없음)", async () => {
  const bad = [
    { ...HELLO, browser: { kind: "chrome", version: "141.0.0.0" } },
    { ...HELLO, platform: "linux" },
    { ...HELLO, platform: undefined },
    { ...HELLO, browser: undefined },
    { ...HELLO, browser: "edge" },
    { ...HELLO, browser: { kind: "firefox" } },
    { ...HELLO, node: "2".repeat(21) },
    { ...HELLO, os: "o".repeat(61) },
    { ...HELLO, guard: "n30" },
    { ...HELLO, node: 22 },
    { ...HELLO, os: "Windows\n10" },
    { ...HELLO, browser: { kind: "edge", version: "1".repeat(56) } },
  ];
  for (const body of bad) {
    const db = fakeDb();
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.code, "BODY_INVALID");
    assert.equal(db.calls.filter((entry) => entry.type === "update").length, 0);
  }
  // 맥은 edge·chrome 모두 받는다
  const mac = fakeDb();
  const macChrome = await call(mac, { ...HELLO, platform: "macos", browser: { kind: "chrome", version: "141.0.7390.55" }, guard: "n30-chrome", os: "macOS 26.6" });
  assert.equal(macChrome.status, 200);
  assert.equal(mac.state.collectors[0].platform, "macos");
  assert.equal(mac.state.collectors[0].last_browser, "chrome 141.0.7390.55");
  assert.equal(mac.state.collectors[0].last_guard, "n30-chrome");
  // 첫 실행은 브라우저 버전을 모른다(unknown)
  assert.deepEqual(helloFields({ ...HELLO, browser: { kind: "edge", version: "unknown" } }).fields.last_browser, "edge unknown");
  assert.deepEqual(helloFields({ platform: "windows", browser: { kind: "edge" } }), {
    ok: true,
    fields: { platform: "windows", last_node: null, last_browser: "edge", last_os: null, last_guard: null },
  });
});

test("hello state 순서: disabled → review → budget → cooldown → window → run", () => {
  // 2026-10-17 12:00 KST = 03:00Z
  const noon = Date.parse("2026-10-17T03:00:00.000Z");
  const future = "2026-10-17T05:00:00.000Z";
  const past = "2026-10-17T01:00:00.000Z";
  const base = settingsRow({ active_from_hour: 8, active_to_hour: 23 });
  assert.equal(helloStateFor({ ...base, enabled: false, needs_owner_review: true, budget_blocked: true, cooldown_until: future }, noon), "disabled");
  assert.equal(helloStateFor({ ...base, needs_owner_review: true, budget_blocked: true, cooldown_until: future }, noon), "review");
  assert.equal(helloStateFor({ ...base, budget_blocked: true, cooldown_until: future }, noon), "budget");
  assert.equal(helloStateFor({ ...base, cooldown_until: future }, noon), "cooldown");
  assert.equal(helloStateFor({ ...base, cooldown_until: past }, noon), "run");
  assert.equal(helloStateFor({ ...base, cooldown_until: future, active_from_hour: 13 }, noon), "cooldown");
  assert.equal(helloStateFor({ ...base, active_from_hour: 13 }, noon), "window");
  assert.equal(helloStateFor(base, noon), "run");
  assert.equal(helloStateFor(null, noon), "disabled");
});

test("hello window 판정은 KST 시(Intl) 기준이며 [from, to) 이다", () => {
  assert.equal(kstHourOf(Date.parse("2026-10-16T22:59:59.999Z")), 7);
  assert.equal(kstHourOf(Date.parse("2026-10-16T23:00:00.000Z")), 8);
  assert.equal(kstHourOf(Date.parse("2026-10-17T13:59:59.000Z")), 22);
  assert.equal(kstHourOf(Date.parse("2026-10-17T14:00:00.000Z")), 23);
  assert.equal(kstHourOf(Date.parse("2026-10-17T15:00:00.000Z")), 0);
  const base = settingsRow({ active_from_hour: 8, active_to_hour: 23 });
  assert.equal(helloStateFor(base, Date.parse("2026-10-16T22:59:59.999Z")), "window"); // 07:59 KST
  assert.equal(helloStateFor(base, Date.parse("2026-10-16T23:00:00.000Z")), "run"); // 08:00 KST
  assert.equal(helloStateFor(base, Date.parse("2026-10-17T13:59:59.000Z")), "run"); // 22:59 KST
  assert.equal(helloStateFor(base, Date.parse("2026-10-17T14:00:00.000Z")), "window"); // 23:00 KST
  assert.equal(helloStateFor({ ...base, active_from_hour: 0, active_to_hour: 24 }, Date.parse("2026-10-17T14:30:00.000Z")), "run");
});

test("hello: 쉬는 중이면 cooldownUntil 을 주고, 지난 값은 null", async () => {
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const cooling = await call(fakeDb({ settings: settingsRow({ cooldown_until: until, cooldown_reason: "blocked" }) }), HELLO);
  assert.equal(cooling.body.state, "cooldown");
  assert.equal(cooling.body.cooldownUntil, until);
  const over = await call(fakeDb({ settings: settingsRow({ cooldown_until: new Date(Date.now() - 1000).toISOString() }) }), HELLO);
  assert.equal(over.body.state, "run");
  assert.equal(over.body.cooldownUntil, null);
  const disabled = await call(fakeDb({ settings: settingsRow({ enabled: false, window_mode: "minimized" }) }), HELLO);
  assert.equal(disabled.body.state, "disabled");
  assert.equal(disabled.body.windowMode, "minimized");
});

test("정리(housekeeping)는 6시간에 한 번, 실패해도 hello 는 정상", async () => {
  const housekeeping = { data: { snapshots: 0 }, error: null };
  const cases = [
    [null, 1],
    [new Date(Date.now() - 60 * 60 * 1000).toISOString(), 0],
    [new Date(Date.now() - 5.9 * 60 * 60 * 1000).toISOString(), 0],
    [new Date(Date.now() - 6.1 * 60 * 60 * 1000).toISOString(), 1],
  ];
  for (const [last, expected] of cases) {
    const db = fakeDb({ settings: settingsRow({ last_housekeeping_at: last }), rpc: { coupang_rank_housekeeping: housekeeping } });
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, HELLO);
    assert.equal(result.status, 200);
    assert.equal(db.rpcCalls().filter((entry) => entry.name === "coupang_rank_housekeeping").length, expected, String(last));
  }
  // claim 은 정리를 부르지 않는다
  const claimDb = fakeDb({
    settings: settingsRow({ last_housekeeping_at: null }),
    rpc: { coupang_rank_claim: { data: { state: "wait", reason: "idle", retryAfterSec: 600 }, error: null } },
  });
  await call(claimDb, { action: "claim" });
  assert.deepEqual(claimDb.rpcCalls().map((entry) => entry.name), ["coupang_rank_claim"]);

  for (const failure of [
    { data: null, error: { code: "57014", message: "statement timeout secret" } },
    () => { throw new Error("network down"); },
  ]) {
    const db = fakeDb({ settings: settingsRow({ last_housekeeping_at: null }), rpc: { coupang_rank_housekeeping: failure } });
    // eslint-disable-next-line no-await-in-loop
    const { result, logs } = await quietly(() => call(db, HELLO));
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.state, "run");
    assert.ok(logs.some((entry) => String(entry[1]).includes("coupang_rank_worker_housekeeping_failed")));
    assert.equal(JSON.stringify(logs).includes("secret"), false);
  }
});

test("claim: SQL 답을 그대로 넘기고 serverTime 만 더한다(throttled 포함)", async () => {
  const replies = [
    { state: "wait", reason: "gap", retryAfterSec: 212 },
    { state: "wait", reason: "gap", retryAfterSec: 205, throttled: true },
    { state: "wait", reason: "cooldown", cooldownUntil: "2026-10-17T08:00:00+00:00", retryAfterSec: 3600 },
    {
      state: "job", runId: RUN_ID, keyword: KEYWORD, keywordKey: KEYWORD, leaseUntil: "2026-10-17T02:13:00+00:00",
      windowMode: "offscreen", slotDay: "2026-10-17", slotIndex: 0,
    },
  ];
  for (const reply of replies) {
    const db = fakeDb({ rpc: { coupang_rank_claim: { data: reply, error: null } } });
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, { action: "claim" });
    assert.equal(result.status, 200);
    const { serverTime, ...rest } = result.body;
    assert.deepEqual(rest, { ok: true, ...reply });
    assert.ok(Number.isFinite(Date.parse(serverTime)));
    assert.deepEqual(db.rpcCalls(), [{ type: "rpc", name: "coupang_rank_claim", args: { p_collector_id: COLLECTOR_ID } }]);
  }
});

test("record: 판정한 상태와 p_run 으로 RPC 를 부르고 답을 그대로 돌려준다", async () => {
  let seen = null;
  const db = fakeDb({ rpc: { coupang_rank_record: (args) => { seen = args; return { data: RECORD_OK, error: null }; } } });
  const result = await call(db, recordBody());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, RECORD_OK);
  assert.equal(seen.p_run_id, RUN_ID);
  assert.equal(seen.p_collector_id, COLLECTOR_ID);
  assert.equal(seen.p_keyword_key, KEYWORD);
  assert.equal(seen.p_status, "ok");
  assert.deepEqual(Object.keys(seen.p_run), [
    "httpStatus", "loginWall", "stable", "itemCount", "organic", "ads",
    "finalHost", "finalPath", "durationMs", "collectorVersion", "browser", "errorCode",
  ]);
  assert.equal(seen.p_run.organic[1].t, "아이쉘 360도 …", "제목은 스냅샷용으로 넘긴다(증거에서 빼는 것은 SQL)");
  assert.equal(seen.p_run.errorCode, null);
});

test("record: 차단·이동·제목 다듬기가 RPC 인자에 반영된다", async () => {
  const cases = [
    [{ status: "error", httpStatus: 403, errorCode: "cdp_error" }, "blocked", "cdp_error"],
    [{ status: "timeout", httpStatus: 429, errorCode: "page_timeout" }, "blocked", "page_timeout"],
    [{ finalHost: "login.coupang.com", finalPath: "/login/login.pang" }, "blocked", null],
    [{ finalHost: "www.example.org", finalPath: "/" }, "error", "foreign_navigation"],
    [{ finalPath: "/vp/products/8533720933" }, "unsupported", null],
    [{ organic: [], noResultText: true }, "noresult", null],
    [{ organic: [], ads: [] }, "empty", null],
    [{ stable: false }, "partial", null],
  ];
  for (const [overrides, status, errorCode] of cases) {
    let seen = null;
    const db = fakeDb({ rpc: { coupang_rank_record: (args) => { seen = args; return { data: { ...RECORD_OK, status }, error: null }; } } });
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, recordBody(overrides));
    assert.equal(result.status, 200, JSON.stringify(overrides));
    assert.equal(seen.p_status, status, JSON.stringify(overrides));
    assert.equal(seen.p_run.errorCode, errorCode, JSON.stringify(overrides));
  }

  let seen = null;
  const db = fakeDb({ rpc: { coupang_rank_record: (args) => { seen = args; return { data: RECORD_OK, error: null }; } } });
  const titled = await call(db, recordBody({
    organic: [{ p: "9000001", v: "", s: 3, t: "\uD800" }, { p: "8533720933", v: "96009802650", s: 38, t: "가".repeat(81) }],
    ads: [{ p: "8533720933", v: "96009802650", s: 22, t: "" }],
  }));
  assert.equal(titled.status, 200);
  assert.deepEqual(seen.p_run.organic, [{ p: "9000001", v: "", s: 3 }, { p: "8533720933", v: "96009802650", s: 38 }]);
  assert.deepEqual(seen.p_run.ads, [{ p: "8533720933", v: "96009802650", s: 22 }]);
});

test("record: 형식 오류는 RPC 없이 400 PAGE_INVALID {field}", async () => {
  const db = fakeDb({ rpc: { coupang_rank_record: { data: RECORD_OK, error: null } } });
  const cases = [
    [recordBody({}, { runId: "x" }), "runId"],
    [recordBody({}, { keywordKey: "" }), "keywordKey"],
    [recordBody({}, { page: undefined }), "page"],
    [recordBody({ status: "found" }), "page.status"],
    [recordBody({ organic: [{ p: "9000001", v: "", s: 3, x: 1 }] }), "page.organic[0].x"],
    [recordBody({ organic: [{ p: "9000001", v: "", s: 22 }] }), "page.ads[0].s"],
    [recordBody({ finalPath: "/np/search?q=a" }), "page.finalPath"],
  ];
  for (const [body, field] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, body);
    assert.equal(result.status, 400, field);
    assert.deepEqual({ code: result.body.code, field: result.body.field }, { code: "PAGE_INVALID", field });
  }
  assert.equal(db.rpcCalls().length, 0);
});

test("record: 이미 끝난 회차(재전송)는 duplicate 답을 그대로 200 으로", async () => {
  const duplicate = { ok: true, accepted: false, duplicate: true, status: "ok", matched: 3, stop: false };
  const db = fakeDb({ rpc: { coupang_rank_record: { data: duplicate, error: null } } });
  const result = await call(db, recordBody());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, duplicate);
});

test("RPC 코드 → HTTP: record·release", async () => {
  const mapping = [
    ["JOB_NOT_FOUND", 404],
    ["JOB_LEASE_MISMATCH", 409],
    ["JOB_KEYWORD_MISMATCH", 409],
    ["JOB_TOO_OLD", 410],
    ["RUN_STATUS_INVALID", 400],
  ];
  for (const [code, status] of mapping) {
    const db = fakeDb({ rpc: { coupang_rank_record: { data: { ok: false, code }, error: null } } });
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, recordBody());
    assert.equal(result.status, status, code);
    assert.equal(result.body.code, code);
    assert.equal(result.body.ok, false);
    assert.equal(typeof result.body.message, "string");
  }
  for (const [code, status] of [["JOB_NOT_FOUND", 404], ["JOB_LEASE_MISMATCH", 409], ["RELEASE_REASON_INVALID", 400]]) {
    const db = fakeDb({ rpc: { coupang_rank_release: { data: { ok: false, code }, error: null } } });
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, { action: "release", runId: RUN_ID, reason: "guard" });
    assert.equal(result.status, status, code);
    assert.equal(result.body.code, code);
  }
  // 목록 밖 코드는 500 으로 닫는다
  const unknown = fakeDb({ rpc: { coupang_rank_record: { data: { ok: false, code: "SOMETHING_NEW" }, error: null } } });
  const { result } = await quietly(() => call(unknown, recordBody()));
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "COUPANG_RANK_WORKER_FAILED");
});

test("release: 사유·회차 검사, 반납·이미 끝난 회차 답", async () => {
  const db = fakeDb({ rpc: { coupang_rank_release: { data: { ok: true, released: true }, error: null } } });
  for (const reason of ["guard", "shutdown", "budget"]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, { action: "release", runId: RUN_ID, reason });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, released: true });
  }
  assert.deepEqual(db.rpcCalls()[0].args, { p_run_id: RUN_ID, p_collector_id: COLLECTOR_ID, p_reason: "guard" });

  const before = db.rpcCalls().length;
  for (const reason of [undefined, "", "blocked", "GUARD"]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await call(db, { action: "release", runId: RUN_ID, reason });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "RELEASE_REASON_INVALID");
  }
  const badRun = await call(db, { action: "release", runId: "nope", reason: "guard" });
  assert.equal(badRun.status, 400);
  assert.equal(badRun.body.code, "BODY_INVALID");
  assert.equal(db.rpcCalls().length, before);

  const done = fakeDb({ rpc: { coupang_rank_release: { data: { ok: true, released: false, status: "ok" }, error: null } } });
  const finished = await call(done, { action: "release", runId: RUN_ID, reason: "guard" });
  assert.deepEqual(finished.body, { ok: true, released: false, status: "ok" });
});

test("위조한 게이트 머리글은 무시한다(핸들러 원문에도 없음)", async () => {
  const forged = {
    "x-mi-session-role": "owner",
    "x-mi-session-scope": "full",
    "x-mi-owner-agency-code": "mml93-a01",
    "x-mi-agency-code": "mml93-a01",
    "x-mi-rank-access-code": "mml93-a01",
    "x-mi-team-code": "team-1",
  };
  // 위조 머리글이 있어도 연결 코드가 틀리면 401
  const rejectedDb = fakeDb();
  const rejected = await call(rejectedDb, { action: "claim" }, { token: OTHER_TOKEN, headers: forged });
  assert.equal(rejected.status, 401);
  assert.equal(rejectedDb.rpcCalls().length, 0);

  // 맞는 연결 코드면 위조 머리글과 무관하게 같은 답
  const reply = { state: "wait", reason: "disabled", retryAfterSec: 600 };
  const plain = fakeDb({ rpc: { coupang_rank_claim: { data: reply, error: null } } });
  const withForged = fakeDb({ rpc: { coupang_rank_claim: { data: reply, error: null } } });
  const a = await call(plain, { action: "claim" });
  const b = await call(withForged, { action: "claim" }, { headers: forged });
  delete a.body.serverTime;
  delete b.body.serverTime;
  assert.deepEqual(b.body, a.body);
  assert.deepEqual(withForged.rpcCalls(), plain.rpcCalls());

  for (const needle of ["x-mi-session", "x-mi-agency", "x-mi-rank", "x-mi-owner", "x-mi-team", ["nav", "er_"].join("")]) {
    assert.equal(HANDLER_SOURCE.includes(needle), false, needle);
  }
});

test("503: 표·함수가 없으면 COUPANG_SETUP_REQUIRED", async () => {
  const noCollectors = fakeDb({ errors: { "select:coupang_rank_collectors": { code: "42P01", message: "relation does not exist" } } });
  const a = await call(noCollectors, { action: "claim" });
  assert.equal(a.status, 503);
  assert.equal(a.body.code, "COUPANG_SETUP_REQUIRED");

  const noSettings = fakeDb({ errors: { "select:coupang_rank_settings": { code: "PGRST205", message: "missing" } } });
  const b = await call(noSettings, HELLO);
  assert.equal(b.status, 503);
  assert.equal(b.body.code, "COUPANG_SETUP_REQUIRED");

  const emptySettings = fakeDb({ settings: null });
  const c = await call(emptySettings, { action: "claim" });
  assert.equal(c.status, 503);

  for (const [body, name] of [
    [{ action: "claim" }, "coupang_rank_claim"],
    [recordBody(), "coupang_rank_record"],
    [{ action: "release", runId: RUN_ID, reason: "guard" }, "coupang_rank_release"],
  ]) {
    for (const code of ["PGRST202", "42883"]) {
      const db = fakeDb({ rpc: { [name]: { data: null, error: { code, message: "function missing" } } } });
      // eslint-disable-next-line no-await-in-loop
      const result = await call(db, body);
      assert.equal(result.status, 503, `${name} ${code}`);
      assert.equal(result.body.code, "COUPANG_SETUP_REQUIRED");
    }
  }
});

test("500: 그 밖의 DB 오류는 문구를 숨기고 한 줄 기록", async () => {
  const cases = [
    [fakeDb({ errors: { "select:coupang_rank_collectors": { code: "57014", message: "SECRET auth text" } } }), { action: "claim" }, "auth", "claim"],
    [fakeDb({ errors: { "select:coupang_rank_settings": { code: "08006", message: "SECRET settings text" } } }), HELLO, "settings", "hello"],
    [fakeDb({ rpc: { coupang_rank_claim: { data: null, error: { code: "40P01", message: "SECRET deadlock" } } } }), { action: "claim" }, "claim", "claim"],
    [fakeDb({ rpc: { coupang_rank_record: () => { throw Object.assign(new Error("SECRET thrown"), { code: "XX000" }); } } }), recordBody(), "record", "record"],
    [fakeDb({ rpc: { coupang_rank_claim: { data: null, error: null } } }), { action: "claim" }, "claim", "claim"],
  ];
  for (const [db, body, stage, action] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const { result, logs } = await quietly(() => call(db, body));
    assert.equal(result.status, 500, stage);
    assert.equal(result.body.code, "COUPANG_RANK_WORKER_FAILED");
    assert.equal(JSON.stringify(result.body).includes("SECRET"), false);
    const line = logs.find((entry) => entry[0] === "error");
    assert.ok(line, stage);
    const parsed = JSON.parse(line[1]);
    assert.equal(parsed.event, "coupang_rank_worker_failed");
    assert.equal(parsed.stage, stage);
    assert.equal(parsed.action, action);
    assert.equal(typeof parsed.requestId, "string");
    assert.equal(JSON.stringify(logs).includes("SECRET"), false);
    assert.equal(JSON.stringify(logs).includes(TOKEN), false, "로그에 연결 코드가 없다");
  }
});

test("핸들러 import 는 §2.1 허용 목록뿐이다", () => {
  const imports = [...HANDLER_SOURCE.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)].map((match) => match[1]);
  const allowed = new Set(["@supabase/server", "../security.mjs", "../runtime.mjs"]);
  for (const specifier of imports) {
    assert.ok(allowed.has(specifier) || /^\.\.\/coupang-rank\/[a-z-]+\.mjs$/.test(specifier), specifier);
  }
  assert.ok(imports.length >= 4);
});
