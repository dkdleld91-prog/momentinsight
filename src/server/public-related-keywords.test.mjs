import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createPublicRelatedKeywordsHandler, createPublicRateConsumer, publicRelatedRateKey } from "./public-related-keywords.mjs";
import { publicRelatedNodeResponse, trustedPublicClientIp } from "./public-related-keyword-adapter.mjs";

const env = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "server-test-secret", NAVER_SEARCHAD_API_KEY: "search-test-key", NAVER_SEARCHAD_SECRET_KEY: "search-test-secret", NAVER_SEARCHAD_CUSTOMER_ID: "123" };
const request = (keyword = "기준어", headers = {}, method = "GET") => new Request(`https://insight.momentlabs.co.kr/api/public/related-keywords?keyword=${encodeURIComponent(keyword)}`, { method, headers });
const ip = "203.0.113.7";
const item = keyword => ({ relKeyword: keyword, monthlyPcQcCnt: 0, monthlyMobileQcCnt: 100, monthlyAvePcClkCnt: 0, monthlyAveMobileClkCnt: 1, monthlyAvePcCtr: 0, monthlyAveMobileCtr: 1, compIdx: "중간" });
function fixture({ count = 51, ratePayload, rateStatus = 200, providerStatus = 200 } = {}) {
  const state = { now: 1_790_000_000_000, rpc: [], search: [], buckets: new Map() };
  state.fetchImpl = async (url, options) => {
    const target = new URL(url);
    if (target.pathname === "/rest/v1/rpc/consume_code_login_rate_limit") {
      const params = JSON.parse(options.body);
      state.rpc.push(params);
      assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(options.headers.authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
      assert.equal(options.redirect, "error");
      if (ratePayload !== undefined) return Response.json(ratePayload, { status: rateStatus });
      let b = state.buckets.get(params.p_key_hash);
      if (!b || b.startedAt + params.p_window_seconds * 1000 <= state.now) { b = { startedAt: state.now, count: 0 }; state.buckets.set(params.p_key_hash, b); }
      const allowed = b.count < params.p_attempt_limit;
      if (allowed) b.count += 1;
      return Response.json([{ allowed, retry_after: allowed ? 0 : Math.ceil((b.startedAt + params.p_window_seconds * 1000 - state.now)/1000) }]);
    }
    assert.equal(target.origin, "https://api.searchad.naver.com", "public service cannot read tenant/category/rank tables");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    state.search.push(url);
    return Response.json({ keywordList: [item(target.searchParams.get("hintKeywords")), ...Array.from({ length: count }, (_, i) => item(`실제연관${i}`))] }, { status: providerStatus });
  };
  state.make = () => createPublicRelatedKeywordsHandler({ env, fetchImpl: state.fetchImpl, now: () => state.now });
  return state;
}

test("anonymous fifty are real, bounded, public fields only and isolated from caller identity", async () => {
  const f = fixture(), handler = f.make();
  const r = await handler(request("기준어", { cookie: "private=not-forwarded", authorization: "Bearer not-forwarded", "x-mi-session-role": "owner", "x-mi-agency-code": "tenant-not-forwarded" }), { clientIp: ip });
  assert.equal(r.status, 200);
  const p = await r.json();
  assert.equal(p.related.length, 50);
  assert.equal(p.related[0].pcVolume, 0);
  assert.equal(p.related[0].mobileVolume, 100);
  assert.equal(p.related[0].keyword, "실제연관0");
  assert.deepEqual(Object.keys(p.related[0]).sort(), ["keyword", "volume", "volumeLabel", "pcVolume", "mobileVolume", "pcVolumeLabel", "mobileVolumeLabel", "clicks", "ctr", "competition"].sort());
  assert.doesNotMatch(JSON.stringify(p), /category|tenant|agency|secret|token|snapshot|tracker/iu);
  assert.equal(f.search.length, 1);
  assert.equal(f.rpc.length, 4);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("short and zero provider responses are never padded", async () => {
  for (const count of [0, 5, 14]) {
    const f = fixture({ count });
    const r = await f.make()(request(), { clientIp: ip });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).related.length, count);
    assert.equal(f.search.length, 1);
  }
});

test("IP minute boundary survives fresh handler instances; cached traffic still consumes request limits", async () => {
  const f = fixture(), handler = f.make();
  for (let n = 0; n < 5; n++) assert.equal((await handler(request(), { clientIp: ip })).status, 200);
  assert.equal(f.search.length, 1, "same-key cache hits need no new source calls");
  const denied = await f.make()(request(), { clientIp: ip });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  assert.equal(f.search.length, 1, "instance replacement cannot reset the durable IP rate");
  f.now += 60_000;
  assert.equal((await handler(request(), { clientIp: ip })).status, 200);
  const boundary = fixture(), boundaryHandler = boundary.make();
  boundary.buckets.set(publicRelatedRateKey("ip-minute", ip, env), { startedAt: boundary.now - 59_999, count: 4 });
  assert.equal((await boundaryHandler(request(), { clientIp: ip })).status, 200, "last allowed request of the prior fixed window");
  boundary.now += 1;
  for (let n = 0; n < 5; n++) assert.equal((await boundaryHandler(request(), { clientIp: ip })).status, 200, "new fixed window allows its own five requests");
  assert.equal((await boundaryHandler(request(), { clientIp: ip })).status, 429, "a prior-window success cannot be miscounted as a new-window quota bypass");
});

test("IP hour boundary is independent of minute resets and resets after its own window", async () => {
  const f = fixture(), handler = f.make();
  for (let n = 0; n < 30; n++) {
    if (n && n % 5 === 0) f.now += 60_000;
    assert.equal((await handler(request(), { clientIp: ip })).status, 200);
  }
  f.now += 60_000;
  assert.equal((await handler(request(), { clientIp: ip })).status, 429);
  assert.equal(f.search.length, 1);
  f.now += 3600_000;
  assert.equal((await handler(request(), { clientIp: ip })).status, 200);
});

test("global source minute key is shared across IPs and fresh instances, never per keyword", async () => {
  const f = fixture();
  for (let n = 0; n < 6; n++) assert.equal((await f.make()(request(`키워드${n}`), { clientIp: `203.0.113.${n+10}` })).status, 200);
  assert.equal((await f.make()(request("일곱번째"), { clientIp: "203.0.113.99" })).status, 429);
  assert.equal(f.search.length, 6);
  f.now += 60_000;
  assert.equal((await f.make()(request("다음분"), { clientIp: ip })).status, 200);
});

test("global hourly request cap counts cache hits across IPs without external calls on denial", async () => {
  const f = fixture(), handler = f.make();
  for (let n = 0; n < 100; n++) assert.equal((await handler(request(), { clientIp: `203.0.113.${n+1}` })).status, 200);
  assert.equal(f.search.length, 1);
  const denied = await f.make()(request(), { clientIp: "198.51.100.4" });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "3600");
  assert.equal(f.search.length, 1);
});

test("parallel same keyword is deduplicated after per-caller rate admission", async () => {
  const f = fixture(), handler = f.make();
  const results = await Promise.all([handler(request(), { clientIp: ip }), handler(request(), { clientIp: "203.0.113.8" })]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(f.search.length, 1);
  assert.equal(f.rpc.filter(r => r.p_window_seconds === 60 && r.p_attempt_limit === 6).length, 1);
});

test("missing IP, invalid query and method make no DB or provider calls", async () => {
  const f = fixture(), handler = f.make();
  assert.equal((await handler(request(), {})).status, 503);
  for (const keyword of ["", "\u0000bad", "x".repeat(61), "x".repeat(121)]) assert.equal((await handler(request(keyword), { clientIp: ip })).status, 400);
  assert.equal((await handler(new Request("https://x/api/public/related-keywords?keyword=a&keyword=b"), { clientIp: ip })).status, 400);
  assert.equal((await handler(request("x", {}, "POST"), { clientIp: ip })).status, 405);
  assert.equal(f.rpc.length + f.search.length, 0);
});

test("malformed or failed durable limiter is fail-closed, never anonymous unlimited access", async () => {
  for (const ratePayload of [null, {}, [], [{ allowed: true, retry_after: 0 }, { allowed: true, retry_after: 0 }], [{ allowed: "true", retry_after: 0 }], [{ allowed: true, retry_after: 1 }], [{ allowed: false, retry_after: 0 }], [{ allowed: false, retry_after: -1 }], [{ allowed: false, retry_after: 999999 }]]) {
    const f = fixture({ ratePayload });
    const r = await f.make()(request(), { clientIp: ip });
    assert.equal(r.status, 503, JSON.stringify(ratePayload));
    assert.equal(f.search.length, 0);
    assert.doesNotMatch(await r.text(), /server-test-secret|search-test/iu);
  }
  const f = fixture({ ratePayload: { private_error: "server-test-secret" }, rateStatus: 500 });
  assert.equal((await f.make()(request(), { clientIp: ip })).status, 503);
  assert.equal(f.search.length, 0);
});

test("rate limiter has bounded body/time and does not follow credential redirects or retry", async () => {
  for (const fetchImpl of [async () => new Response("x".repeat(4096), { headers: { "content-type": "application/json" } }), async () => { throw new Error("private-failure-detail"); }]) {
    let calls = 0;
    const consume = createPublicRateConsumer({ env, fetchImpl: (...args) => { calls++; return fetchImpl(...args); } });
    await assert.rejects(consume("ip-minute", ip, 60, 5), e => e.code === "rate_unavailable");
    assert.equal(calls, 1);
  }
  const consume = createPublicRateConsumer({ env, fetchImpl: () => new Promise(() => {}) });
  const start = Date.now();
  await assert.rejects(consume("ip-minute", ip, 60, 5), e => e.code === "rate_unavailable");
  assert.ok(Date.now() - start < 3000);
});

test("source 429 is bounded, returned as 429 and does not create retry loops", async () => {
  const f = fixture({ providerStatus: 429 }), handler = f.make();
  assert.equal((await handler(request(), { clientIp: ip })).status, 429);
  assert.equal((await handler(request("다른키워드"), { clientIp: ip })).status, 429);
  assert.equal(f.search.length, 1);
});

test("public namespaced hashes separate login, scope/window, IP and global budgets", () => {
  const scopes = ["ip-minute", "ip-hour", "all-hour", "source-minute"];
  const keys = scopes.map(s => publicRelatedRateKey(s, ip, env));
  assert.equal(new Set(keys).size, scopes.length);
  assert.ok(keys.every(k => /^[a-f0-9]{64}$/u.test(k)));
  assert.notEqual(keys[0], publicRelatedRateKey("ip-minute", "203.0.113.8", env));
  assert.equal(keys[2], publicRelatedRateKey("all-hour", "different-instance", env));
  assert.notEqual(keys[0], publicRelatedRateKey("ip-minute", ip, { ...env, SUPABASE_SERVICE_ROLE_KEY: "another-server-secret" }));
});

test("existing modern Supabase server key is supported on apikey only with no new environment setting", async () => {
  const modern = { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: "sb_secret_fixture_not_a_real_key" };
  let calls = 0;
  const consume = createPublicRateConsumer({ env: modern, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers.apikey, modern.SUPABASE_SECRET_KEY);
    assert.equal(options.headers.authorization, undefined, "modern secret keys are not JWT bearer tokens");
    assert.equal(JSON.parse(options.body).p_key_hash, publicRelatedRateKey("ip-minute", ip, modern));
    return Response.json([{ allowed: true, retry_after: 0 }]);
  } });
  await consume("ip-minute", ip, 60, 5);
  assert.equal(calls, 1);
  const unavailable = createPublicRateConsumer({ env: { ...modern, SUPABASE_SECRET_KEY: "[SENSITIVE]" }, fetchImpl: () => assert.fail("placeholder is not a usable server key") });
  await assert.rejects(unavailable("ip-minute", ip, 60, 5), e => e.code === "rate_unavailable");
});

test("only Vercel-injected or actual local socket IP is trusted, never arbitrary caller headers", async () => {
  const req = { method: "GET", url: "/api/public/related-keywords?keyword=a&agency=private&mode=related", headers: { "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2", cookie: "private", authorization: "private", "x-mi-session-role": "owner" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(trustedPublicClientIp(req, { VERCEL: "1" }), "203.0.113.9");
  assert.equal(trustedPublicClientIp(req, {}), "127.0.0.1");
  assert.equal(trustedPublicClientIp({ ...req, headers: { "x-forwarded-for": ip } }, { VERCEL: "1" }), "");
  assert.equal(trustedPublicClientIp({ ...req, headers: { "x-vercel-forwarded-for": "not-an-ip" } }, { VERCEL: "1" }), "");
  const r = await publicRelatedNodeResponse(req, { env: { VERCEL: "1" }, handler: (webRequest, meta) => {
    assert.equal(meta.clientIp, "203.0.113.9");
    assert.equal([...webRequest.headers].length, 0);
    assert.equal(new URL(webRequest.url).search, "?keyword=a");
    return Response.json({ ok: true });
  } });
  assert.equal(r.status, 200);
  assert.equal((await publicRelatedNodeResponse({ ...req, method: "TRACE" }, { handler: () => assert.fail("method rejection must not enter the service") })).status, 405);
  assert.equal((await publicRelatedNodeResponse({ ...req, url: "/api/public/related-keywords?keyword=" + "x".repeat(4096) }, { handler: () => assert.fail("oversize URL must not enter the service") })).status, 400);
});

test("private session gates remain present and public adapter exposes only explicit new resource", () => {
  const gate = fs.readFileSync("src/server/session-gate.mjs", "utf8");
  assert.ok(!gate.match(/const SESSION_FREE_PATHS = new Set\(\[([\s\S]*?)\]\)/u)?.[1].includes("keyword-research"));
  const source = fs.readFileSync("src/server/public-related-keywords.mjs", "utf8");
  assert.doesNotMatch(source, /from\s+['"].*(?:stored-rank|related-keyword-categories|naver-rank|session-gate)/u);
  const adapter = fs.readFileSync("api/public/[resource].mjs", "utf8");
  assert.match(adapter, /resource === "related-keywords"/u);
});
