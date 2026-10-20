import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRelatedKeywordSource, relatedRowsFromSearchAd } from "./related-keyword-source.mjs";
import { relatedRowsFromSearchAd as handlerRows } from "./handlers/related-keywords.mjs";

const NOW = Date.parse("2026-10-20T01:00:00Z");
const env = () => ({ NAVER_SEARCHAD_API_KEY: "private-api-key", NAVER_SEARCHAD_SECRET_KEY: "private-secret", NAVER_SEARCHAD_CUSTOMER_ID: "123" });
const item = (keyword, extra = {}) => ({ relKeyword: keyword, monthlyPcQcCnt: 100, monthlyMobileQcCnt: 200, monthlyAvePcClkCnt: 1, monthlyAveMobileClkCnt: 2, monthlyAvePcCtr: 1, monthlyAveMobileCtr: 2, compIdx: "보통", ...extra });
const response = (payload, options = {}) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" }, ...options });
const good = () => response({ keywordList: [item("연관어")] });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("source projection is re-exported unchanged and keeps exact words, normalized dedupe and cap50", () => {
  assert.equal(handlerRows, relatedRowsFromSearchAd);
  const rows = relatedRowsFromSearchAd({ keywordList: [item("기 준어"), item("허리  찜질기"), item("허리찜질기"), item("가".repeat(61)), item("bad\u0000word"), ...Array.from({ length: 60 }, (_, i) => item(`연관${i}`, { monthlyPcQcCnt: i }))] }, "기준어");
  assert.equal(rows.length, 50);
  assert.equal(rows[0].keyword, "허리  찜질기");
  assert.equal(rows[0].ctr, 1.5);
  assert.equal(rows[1].volume, 200);
  assert.ok(rows.every((row) => !Object.hasOwn(row, "category")));
});

test("source values preserve suppressed/missing/zero data and never pad a short response", () => {
  const rows = relatedRowsFromSearchAd({ keywordList: [item("가", { monthlyPcQcCnt: "<10", monthlyMobileQcCnt: "< 10" }), item("나", { monthlyPcQcCnt: null }), item("다", { monthlyPcQcCnt: 0, monthlyMobileQcCnt: 0 })] }, "기준어");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].volume, null);
  assert.equal(rows[0].volumeLabel, "< 20");
  assert.equal(rows[1].volumeLabel, "확인 필요");
  assert.equal(rows[2].volume, 0);
  assert.throws(() => relatedRowsFromSearchAd({}, "기준어"), /invalid_response/u);
});

test("cold source calls hook before its signed SearchAd GET; default hook preserves private behavior", async () => {
  const calls = [];
  const config = env();
  const load = createRelatedKeywordSource({ env: config, now: () => NOW, beforeSourceFetch: async () => { calls.push("hook"); }, fetchImpl: async (url, options) => {
    calls.push("fetch");
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://api.searchad.naver.com/keywordstool");
    assert.equal(parsed.searchParams.get("hintKeywords"), "허리찜질기");
    assert.equal(parsed.searchParams.get("showDetail"), "1");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["X-Timestamp"], String(NOW));
    assert.equal(options.headers["X-API-KEY"], config.NAVER_SEARCHAD_API_KEY);
    assert.equal(options.headers["X-Customer"], config.NAVER_SEARCHAD_CUSTOMER_ID);
    assert.equal(options.headers["X-Signature"], crypto.createHmac("sha256", config.NAVER_SEARCHAD_SECRET_KEY).update(`${NOW}.GET./keywordstool`).digest("base64"));
    assert.ok(options.signal instanceof AbortSignal);
    return good();
  } });
  assert.equal((await load("허리 찜질기"))[0].volume, 300);
  assert.deepEqual(calls, ["hook", "fetch"]);
  const withoutHook = createRelatedKeywordSource({ env: env(), now: () => NOW, fetchImpl: async () => good() });
  assert.equal((await withoutHook("기준어")).length, 1);
});

test("pending is registered before hook runs, same-key queries dedupe, and cache hits never call hook", async () => {
  const gate = deferred();
  let hookCalls = 0, fetchCalls = 0, duplicate;
  let load;
  load = createRelatedKeywordSource({ env: env(), now: () => NOW, beforeSourceFetch: async () => {
    hookCalls++;
    duplicate = load("허리찜질기");
    await gate.promise;
  }, fetchImpl: async () => { fetchCalls++; return good(); } });
  const first = load("허리 찜질기");
  const same = load("허리찜질기");
  await flush();
  assert.equal(hookCalls, 1);
  assert.equal(fetchCalls, 0);
  gate.resolve();
  const values = await Promise.all([first, same, duplicate]);
  assert.equal(fetchCalls, 1);
  assert.equal(values[0], values[1]);
  assert.equal(values[0], values[2]);
  assert.equal(await load("허리찜질기"), values[0]);
  assert.equal(hookCalls, 1);
});

test("awaiting hooks occupy both concurrency slots and reject a third cold key without hook or fetch", async () => {
  const gate = deferred();
  let hooks = 0, fetches = 0;
  const load = createRelatedKeywordSource({ env: env(), now: () => NOW, beforeSourceFetch: async () => { hooks++; await gate.promise; }, fetchImpl: async () => { fetches++; return good(); } });
  const first = load("첫째");
  const second = load("둘째");
  const third = load("셋째");
  await assert.rejects(third, /rate_limited/u);
  assert.equal(hooks, 2);
  assert.equal(fetches, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(fetches, 2);
});

test("hook failure is deduped, frees pending slots, skips fetch, and is never cached", async () => {
  let hooks = 0, fetches = 0;
  const failure = new Error("global_rate_limited");
  const load = createRelatedKeywordSource({ env: env(), now: () => NOW, beforeSourceFetch: async () => { hooks++; if (hooks === 1) throw failure; }, fetchImpl: async () => { fetches++; return good(); } });
  const outcomes = await Promise.allSettled([load("기준어"), load("기준어")]);
  assert.ok(outcomes.every((result) => result.status === "rejected" && result.reason === failure));
  assert.equal(hooks, 1);
  assert.equal(fetches, 0);
  assert.equal((await load("기준어")).length, 1);
  assert.equal(hooks, 2);
  assert.equal(fetches, 1);
});

test("successful rows cache for exactly 24 hours and cache scope follows all source credentials", async () => {
  let at = NOW, hooks = 0, fetches = 0;
  const config = env();
  const load = createRelatedKeywordSource({ env: config, now: () => at, beforeSourceFetch: async () => { hooks++; }, fetchImpl: async () => { fetches++; return good(); } });
  await load("기준어");
  at += 24 * 60 * 60_000 - 1;
  await load("기준어");
  assert.equal(hooks, 1);
  at++;
  await load("기준어");
  assert.equal(hooks, 2);
  for (const key of ["NAVER_SEARCHAD_API_KEY", "NAVER_SEARCHAD_SECRET_KEY", "NAVER_SEARCHAD_CUSTOMER_ID"]) {
    config[key] += "rotated";
    await load("기준어");
  }
  assert.equal(hooks, 5);
  assert.equal(fetches, 5);
});

test("source cache retains at most 256 entries with the original insertion-order eviction", async () => {
  let at = NOW, hooks = 0;
  const load = createRelatedKeywordSource({ env: env(), now: () => at, beforeSourceFetch: async () => { hooks++; }, fetchImpl: async () => good() });
  for (let index = 0; index < 257; index++) { await load(`기준${index}`); at += 60_000; }
  assert.equal(hooks, 257);
  await load("기준256");
  assert.equal(hooks, 257);
  await load("기준0");
  assert.equal(hooks, 258);
});

test("six cold misses per minute stay instance-local and cached keys bypass the exhausted budget", async () => {
  let at = NOW, hooks = 0;
  const options = { env: env(), now: () => at, beforeSourceFetch: async () => { hooks++; }, fetchImpl: async () => good() };
  const privateLoad = createRelatedKeywordSource(options);
  const publicLoad = createRelatedKeywordSource(options);
  for (let index = 0; index < 6; index++) await privateLoad(`기준${index}`);
  await privateLoad("기준0");
  await assert.rejects(privateLoad("일곱째"), /rate_limited/u);
  assert.equal(hooks, 6);
  await publicLoad("일곱째");
  assert.equal(hooks, 7);
  at += 60_000;
  await privateLoad("일곱째");
  assert.equal(hooks, 8);
});

test("missing source credentials skip hook/fetch; failed provider and malformed bodies never become cache hits", async () => {
  let hooks = 0, fetches = 0;
  const missing = createRelatedKeywordSource({ env: {}, now: () => NOW, beforeSourceFetch: async () => { hooks++; }, fetchImpl: async () => { fetches++; return good(); } });
  await assert.rejects(missing("기준어"), /source_unavailable/u);
  assert.equal(hooks, 0);
  const queue = [response({}, { status: 500 }), response({ invalid: true }), good()];
  const load = createRelatedKeywordSource({ env: env(), now: () => NOW, beforeSourceFetch: async () => { hooks++; }, fetchImpl: async () => { fetches++; return queue.shift(); } });
  await assert.rejects(load("기준어"), /source_unavailable/u);
  await assert.rejects(load("기준어"), /invalid_response/u);
  await load("기준어");
  assert.equal(hooks, 3);
  assert.equal(fetches, 3);
});

test("provider 403/418/429 preserve one-minute cooldown without hook or fetch on a new cold key", async () => {
  for (const status of [403, 418, 429]) {
    let at = NOW, hooks = 0, fetches = 0;
    const load = createRelatedKeywordSource({ env: env(), now: () => at, beforeSourceFetch: async () => { hooks++; }, fetchImpl: async () => { fetches++; return fetches === 1 ? response({}, { status }) : good(); } });
    await assert.rejects(load("첫째"), new RegExp(status === 429 ? "rate_limited" : status === 403 ? "source_permission" : "source_unavailable", "u"));
    await assert.rejects(load("둘째"), /source_cooldown/u);
    assert.equal(hooks, 1);
    assert.equal(fetches, 1);
    at += 60_000;
    await load("둘째");
    assert.equal(hooks, 2);
  }
});

test("source bounds the complete JSON read at 2MiB and rejects bad content types without caching", async () => {
  let calls = 0;
  const queue = [new Response("{}", { headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) } }), new Response("{}", { headers: { "content-type": "text/plain" } }), good()];
  const load = createRelatedKeywordSource({ env: env(), now: () => NOW, fetchImpl: async () => { calls++; return queue.shift(); } });
  await assert.rejects(load("기준어"), /response_too_large/u);
  await assert.rejects(load("기준어"), /invalid_response/u);
  await load("기준어");
  assert.equal(calls, 3);
});

test("streaming bodies without a length header are cancelled when they exceed 2MiB", async () => {
  let cancelled = false, calls = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(Uint8Array.of(0)); },
    cancel() { cancelled = true; },
  });
  const load = createRelatedKeywordSource({ env: env(), now: () => NOW, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response(body, { headers: { "content-type": "application/json" } }) : good();
  } });
  await assert.rejects(load("기준어"), /response_too_large/u);
  assert.equal(cancelled, true);
  await load("기준어");
  assert.equal(calls, 2);
});

test("four-second timeout covers response-body reads, aborts the source request and frees pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let sourceSignal, bodyController, calls = 0;
  const body = new ReadableStream({ start(controller) { bodyController = controller; } });
  const load = createRelatedKeywordSource({ env: env(), now: () => NOW, fetchImpl: async (_, options) => {
    calls++;
    sourceSignal = options.signal;
    return calls === 1 ? new Response(body, { headers: { "content-type": "application/json" } }) : good();
  } });
  const first = load("기준어");
  const rejected = assert.rejects(first, /source_timeout/u);
  await flush();
  assert.equal(sourceSignal.aborted, false);
  t.mock.timers.tick(4_000);
  await rejected;
  assert.equal(sourceSignal.aborted, true);
  bodyController.enqueue(new TextEncoder().encode('{"keywordList":[]}'));
  bodyController.close();
  assert.equal((await load("기준어")).length, 1);
  assert.equal(calls, 2);
});

test("pure source imports no category provider, stored evidence, owner/tenant or Supabase modules", async () => {
  const source = await readFile(new URL("./related-keyword-source.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from\s*["'][^"']*(?:related-keyword-categories|stored-rank|owner-identity|supabase)|SUPABASE_|lookupCategories|x-mi-)/iu);
  const handler = await readFile(new URL("./handlers/related-keywords.mjs", import.meta.url), "utf8");
  assert.match(handler, /createRelatedKeywordSource\(\{ env, fetchImpl, now \}\)/u);
  assert.match(handler, /TOTAL_TIMEOUT_MS = 16_000/u);
});
