// api·log·lock·cdp 보조 모듈 테스트.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  COLLECTOR_VERSION, COLLECTOR_VERSION_HEADER, COUPANG_WORKER_PATH, LOCK_STALE_MS, PUBLIC_ORIGIN, WORKER_BODY_MAX_BYTES,
} from "../lib/contract.mjs";
import { createApi, fitRecordBody } from "../lib/api.mjs";
import { createLogger, formatLine } from "../lib/log.mjs";
import { acquireLock } from "../lib/lock.mjs";
import { CdpConnection } from "../lib/cdp.mjs";
import { WINDOWS_CONFIG, fakeBrowser, removeRoot, tempRoot } from "./helpers.mjs";

const TOKEN = `mic1_${"q".repeat(43)}`;

function fetchStub(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { calls, fetchImpl };
}

function response(status, body) {
  return { status, text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) };
}

test("api: 운영 도메인 + 수집기 경로, Bearer·content-type·버전 머리글, 리다이렉트 거절, 20초 제한", async () => {
  const stub = fetchStub(() => response(200, { ok: true, state: "run" }));
  const api = createApi({ config: WINDOWS_CONFIG, token: TOKEN, fetchImpl: stub.fetchImpl });
  const result = await api.hello({ platform: "windows" });
  assert.deepEqual(result, { status: 200, body: { ok: true, state: "run" }, routeMissing: false });
  assert.equal(stub.calls[0].url, `${PUBLIC_ORIGIN}${COUPANG_WORKER_PATH}`);
  const init = stub.calls[0].init;
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers[COLLECTOR_VERSION_HEADER], COLLECTOR_VERSION);
  assert.deepEqual(Object.keys(init.headers).sort(), ["authorization", "content-type", COLLECTOR_VERSION_HEADER].sort());
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body), { action: "hello", platform: "windows" });
  await api.claim();
  assert.deepEqual(JSON.parse(stub.calls[1].init.body), { action: "claim" });
  await api.release("r1", "guard");
  assert.deepEqual(JSON.parse(stub.calls[2].init.body), { action: "release", runId: "r1", reason: "guard" });
});

test("api: 네트워크 실패는 status 0, 4xx 인데 code 가 없으면 routeMissing, code 가 있으면 아님", async () => {
  const failing = createApi({ config: WINDOWS_CONFIG, token: TOKEN, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(await failing.claim(), { status: 0, body: null, routeMissing: false });
  const notFound = createApi({ config: WINDOWS_CONFIG, token: TOKEN, fetchImpl: async () => response(404, "Not found") });
  assert.equal((await notFound.claim()).routeMissing, true);
  const jsonNoCode = createApi({ config: WINDOWS_CONFIG, token: TOKEN, fetchImpl: async () => response(404, { ok: false, message: "x" }) });
  assert.equal((await jsonNoCode.claim()).routeMissing, true);
  const coded = createApi({ config: WINDOWS_CONFIG, token: TOKEN, fetchImpl: async () => response(404, { ok: false, code: "JOB_NOT_FOUND" }) });
  assert.equal((await coded.claim()).routeMissing, false);
  const server = createApi({ config: WINDOWS_CONFIG, token: TOKEN, fetchImpl: async () => response(502, "<html>") });
  assert.deepEqual(await server.claim(), { status: 502, body: null, routeMissing: false });
});

test("api: 본문이 64KB 를 넘으면 제목을 지우고, 그래도 넘으면 목록을 비운 error 로 보낸다", () => {
  const organic = Array.from({ length: 100 }, (_, index) => ({ p: String(10000 + index), v: "", s: index + 1, t: "가".repeat(400) }));
  const body = { action: "record", runId: "x", page: { status: "ok", organic, ads: [], httpStatus: 200 } };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > WORKER_BODY_MAX_BYTES);
  const fitted = fitRecordBody(body);
  assert.equal(fitted.trimmed, true);
  assert.ok(Buffer.byteLength(fitted.text) <= WORKER_BODY_MAX_BYTES);
  assert.ok(fitted.body.page.organic.every((item) => !("t" in item)));
  assert.equal(fitted.body.page.status, "ok");
  const huge = { action: "record", runId: "x", page: { status: "ok", organic: [], ads: [], httpStatus: 403, junk: "x".repeat(70000) } };
  const errorBody = fitRecordBody(huge);
  assert.equal(errorBody.body.page.status, "error");
  assert.equal(errorBody.body.page.errorCode, "extract_failed");
  assert.equal(errorBody.body.page.httpStatus, 403);
  const small = { action: "claim" };
  assert.equal(fitRecordBody(small).trimmed, false);
});

test("log: 키워드·토큰·제목 키는 버리고, 값의 연결 코드 모양은 지우고, 공백은 _ 로", () => {
  const line = formatLine("collect", { keyword: "아이폰", title: "제목", token: TOKEN, t: "제목2", status: "ok", note: `has ${TOKEN} inside`, ms: 12 }, new Date(0));
  assert.equal(line, "1970-01-01T00:00:00.000Z collect status=ok note=has_mic1_REDACTED_inside ms=12\n");
  assert.equal(formatLine("Bad Event!", {}, new Date(0)), "1970-01-01T00:00:00.000Z log_event_invalid\n");
  assert.equal(formatLine("x", { empty: "", nil: null }, new Date(0)), "1970-01-01T00:00:00.000Z x empty=- nil=-\n");
});

test("log: 1MB(여기선 작게)를 넘으면 worker.log.1 로 바꾼다", () => {
  const root = tempRoot();
  try {
    const log = createLogger(root, { maxBytes: 200, now: () => new Date(0) });
    for (let index = 0; index < 10; index += 1) log.event("tick", { index, pad: "x".repeat(30) });
    const current = fs.statSync(path.join(root, "logs", "worker.log")).size;
    assert.ok(current <= 200 + 80);
    assert.ok(fs.existsSync(path.join(root, "logs", "worker.log.1")));
  } finally {
    removeRoot(root);
  }
});

test("lock: 두 번째는 실패, 20분 지난 잠금은 지우고 다시, 해제하면 디렉터리가 없어진다", () => {
  const root = tempRoot();
  try {
    let now = Date.now();
    const first = acquireLock(root, { now: () => now });
    assert.equal(first.ok, true);
    assert.ok(fs.existsSync(path.join(root, "state", "worker.lock", "pid")));
    assert.deepEqual(acquireLock(root, { now: () => now }), { ok: false, reason: "locked" });
    now += LOCK_STALE_MS + 1000;
    const second = acquireLock(root, { now: () => now });
    assert.equal(second.ok, true);
    second.release();
    assert.equal(fs.existsSync(path.join(root, "state", "worker.lock")), false);
    first.release();
  } finally {
    removeRoot(root);
  }
});

test("cdp: 명령·응답, 오류 응답은 cdp_error, 세션별 사건, waitFor 시간 초과 null, 닫히면 대기 명령 거절", async () => {
  const browser = fakeBrowser({ hangEvaluate: true, failWindow: true });
  const conn = await CdpConnection.connect("ws://127.0.0.1:1/devtools/browser/x", { WebSocketImpl: browser.WebSocketImpl, commandTimeoutMs: 50 });
  const created = await conn.send("Target.createTarget", { url: "about:blank" });
  assert.equal(created.targetId, "T1");
  const sessionEvents = [];
  const browserEvents = [];
  conn.on("Page.loadEventFired", (params) => sessionEvents.push(params), "S1");
  conn.on("Page.loadEventFired", (params) => browserEvents.push(params), null);
  const loaded = conn.waitFor("Page.loadEventFired", 500, "S1");
  await conn.send("Page.navigate", { url: "https://www.coupang.com/np/search?q=a" }, "S1");
  assert.deepEqual(await loaded, { timestamp: 1 });
  assert.equal(sessionEvents.length, 1);
  assert.equal(browserEvents.length, 0);
  assert.equal(browser.calls.at(-1).sessionId, "S1");
  await assert.rejects(conn.send("Runtime.evaluate", { expression: "1" }, "S1"), (error) => error.code === "cdp_error" && /timeout/.test(error.message));
  await assert.rejects(conn.send("Browser.getWindowForTarget", {}), (error) => error.code === "cdp_error");
  assert.equal(await conn.waitFor("Never.happens", 20), null);
  const pending = conn.send("Runtime.evaluate", { expression: "2" }, "S1");
  conn.close();
  await assert.rejects(pending, (error) => /socket_closed/.test(error.message));
  await assert.rejects(conn.send("Browser.close"), (error) => error.code === "cdp_error");
  await assert.rejects(CdpConnection.connect("ws://x", { WebSocketImpl: null }), (error) => error.code === "cdp_unreachable");
});
