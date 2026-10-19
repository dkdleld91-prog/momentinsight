import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import {
  commerceCatalogSample, commerceCategoryConfigReason, commerceCategoryCredentialKey,
  createCommerceCategorySource, hasCommerceCategoryConfig,
} from "./naver-commerce-category-source.mjs";

const NOW = Date.parse("2026-10-18T01:00:00Z");
const envFor = (extra = {}) => ({
  NAVER_COMMERCE_CLIENT_ID: "category-source-app",
  NAVER_COMMERCE_CLIENT_SECRET: "$2a$04$abcdefghijklmnopqrstuu",
  NAVER_COMMERCE_TOKEN_TYPE: "SELF", ...extra,
});
const item = (id = 59776958987, path = "생활/건강 > 냉온/찜질용품 > 찜질기") => ({
  id, categoryId: "50006989", wholeCategoryName: path,
  name: "must-not-escape", brandName: "private-unused-field",
});
const page = (items = [item()], extra = {}) => ({
  contents: items, page: 1, size: 20, first: true, last: true,
  totalElements: items.length, totalPages: items.length ? 1 : 0, ...extra,
});
const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
  status, headers: { "content-type": "application/json", ...headers },
});
const token = (extra = {}) => json({ access_token: "server-only-bearer", expires_in: 10800, token_type: "Bearer", ...extra });
const signature = async () => "safe-signature";

function fixture(options = {}) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    if (new URL(url).pathname.endsWith("/oauth2/token")) return token();
    return json(page());
  };
  return { calls, source: createCommerceCategorySource({ env: envFor(), now: () => NOW, signImpl: signature, fetchImpl, ...options }) };
}

test("config is server-only, explicit, credential-scoped and fail closed", () => {
  assert.equal(commerceCategoryConfigReason({}), "source_unavailable");
  assert.equal(hasCommerceCategoryConfig(envFor()), true);
  for (const extra of [
    { NAVER_COMMERCE_CLIENT_ID: "" }, { NAVER_COMMERCE_CLIENT_ID: "invalid\napp" },
    { NAVER_COMMERCE_CLIENT_SECRET: "not-a-bcrypt-salt" },
    { NAVER_COMMERCE_CLIENT_SECRET: "$2a$31$abcdefghijklmnopqrstuu" },
    { NAVER_COMMERCE_TOKEN_TYPE: "" }, { NAVER_COMMERCE_TOKEN_TYPE: "self" },
    { NAVER_COMMERCE_TOKEN_TYPE: "SELLER" }, { NAVER_COMMERCE_ACCOUNT_ID: "do-not-send-in-SELF" },
  ]) {
    assert.equal(hasCommerceCategoryConfig(envFor(extra)), false);
    assert.equal(commerceCategoryConfigReason(envFor(extra)), "source_config_invalid");
  }
  assert.equal(hasCommerceCategoryConfig(envFor({ NAVER_COMMERCE_TOKEN_TYPE: "SELLER", NAVER_COMMERCE_ACCOUNT_ID: "seller_123" })), true);
  const key = commerceCategoryCredentialKey(envFor());
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.notEqual(key, commerceCategoryCredentialKey(envFor({ NAVER_COMMERCE_CLIENT_ID: "rotated-app" })));
  assert.doesNotMatch(key, /category-source-app|abcdefghijkl/u);
});

test("OAuth uses only the official form endpoint with no SELF account_id, query or bearer", async () => {
  const { source, calls } = fixture();
  const result = await source("온열  찜질기");
  assert.equal(calls.length, 2);
  const auth = calls[0];
  assert.equal(auth.url, "https://api.commerce.naver.com/external/v1/oauth2/token");
  assert.equal(auth.request.method, "POST");
  assert.equal(auth.request.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(auth.request.headers.authorization, undefined);
  assert.equal(auth.request.redirect, "error");
  const form = new URLSearchParams(auth.request.body);
  assert.deepEqual([...form.keys()].sort(), ["client_id", "timestamp", "grant_type", "client_secret_sign", "type"].sort());
  assert.equal(form.get("client_id"), envFor().NAVER_COMMERCE_CLIENT_ID);
  assert.equal(form.get("timestamp"), String(NOW));
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("type"), "SELF");
  assert.equal(form.get("client_secret_sign"), "safe-signature");
  assert.equal(form.has("account_id"), false);
  assert.equal(result.keyword, "온열 찜질기");
  assert.equal(result.source, "naver_commerce_catalog_sample");
  assert.equal(result.complete, true);
  assert.equal(result.items[0].catalogId, "59776958987");
  assert.equal(result.items[0].category2, "냉온/찜질용품");
  assert.equal(result.items[0].category3, "찜질기");
  assert.equal(result.collectedAt, new Date(NOW).toISOString());
  assert.doesNotMatch(JSON.stringify(result), /server-only|must-not-escape|private-unused|sourceExhausted|rank|tracker/u);
});

test("catalog request is one exact name first-page bounded GET, not a rank request", async () => {
  const { source, calls } = fixture();
  await source("온열&찜질기");
  const request = calls[1];
  const url = new URL(request.url);
  assert.equal(`${url.origin}${url.pathname}`, "https://api.commerce.naver.com/external/v1/product-models");
  assert.deepEqual([...url.searchParams], [["name", "온열&찜질기"], ["page", "1"], ["size", "20"]]);
  assert.equal(request.request.method, "GET");
  assert.equal(request.request.redirect, "error");
  assert.equal(request.request.headers.authorization, "Bearer server-only-bearer");
  assert.equal(request.request.body, undefined);
});

test("SELLER form includes only the configured account with explicit SELLER type", async () => {
  const { source, calls } = fixture({ env: envFor({ NAVER_COMMERCE_TOKEN_TYPE: "SELLER", NAVER_COMMERCE_ACCOUNT_ID: "seller_123" }) });
  await source("찜질기");
  const form = new URLSearchParams(calls[0].request.body);
  assert.equal(form.get("type"), "SELLER");
  assert.equal(form.get("account_id"), "seller_123");
});

test("default bcrypt signature encodes the official clientId_timestamp password using the secret salt", async () => {
  const { source, calls } = fixture({ signImpl: undefined });
  await source("찜질기");
  const encoded = new URLSearchParams(calls[0].request.body).get("client_secret_sign");
  const hash = Buffer.from(encoded, "base64").toString("utf8");
  assert.equal(await bcrypt.compare(`${envFor().NAVER_COMMERCE_CLIENT_ID}_${NOW}`, hash), true);
  assert.equal(hash.slice(0, 29), envFor().NAVER_COMMERCE_CLIENT_SECRET);
});

test("one observed sample retains every category pair and a fourth taxonomy level is not substituted for small", () => {
  const result = commerceCatalogSample(page([
    item(1), item(2, "디지털/가전 > 계절가전 > 전기매트 > 전기방석"),
  ]), "찜질기", new Date(NOW).toISOString());
  assert.deepEqual(result.items, [
    { catalogId: "1", categoryId: "50006989", category2: "냉온/찜질용품", category3: "찜질기" },
    { catalogId: "2", categoryId: "50006989", category2: "계절가전", category3: "전기매트" },
  ]);
});

test("first page can have more catalog matches without claiming full market exhaustion or paging again", async () => {
  const calls = [];
  const source = createCommerceCategorySource({ env: envFor(), now: () => NOW, signImpl: signature, fetchImpl: async (url) => {
    calls.push(url);
    return url.includes("oauth2/token") ? token() : json(page(Array.from({ length: 20 }, (_, index) => item(index + 1)), {
      last: false, totalElements: 75, totalPages: 4,
    }));
  } });
  const result = await source("찜질기");
  assert.equal(result.complete, true);
  assert.equal(result.hasMore, true);
  assert.equal(result.last, false);
  assert.equal(result.totalElements, 75);
  assert.equal(result.sampleLimit, 20);
  assert.equal(calls.length, 2);
  assert.equal(result.sourceExhausted, undefined);
});

test("missing, shallow, HTML, oversized or malformed category paths produce only an incomplete sample", () => {
  for (const path of [undefined, "", "생활/건강 > 건강관리용품", "생활/건강 > > 찜질기", "a > b > c > d > e", "a > b > <script>", "a > b\n > c", `a > ${"b".repeat(101)} > c`]) {
    const result = commerceCatalogSample(page([{ ...item(), wholeCategoryName: path }]), "찜질기", new Date(NOW).toISOString());
    assert.equal(result.complete, false);
    assert.equal(result.reason, "incomplete_sample");
    assert.equal(result.items[0].category2, "");
    assert.equal(result.items[0].category3, "");
  }
});

test("empty catalog coverage is no_results, not proof the keyword has no category", () => {
  const result = commerceCatalogSample(page([]), "비카탈로그키워드", new Date(NOW).toISOString());
  assert.equal(result.complete, false);
  assert.equal(result.reason, "no_results");
  assert.deepEqual(result.items, []);
});

test("unsafe or duplicate catalog identities and missing category IDs reject the entire sample", () => {
  for (const contents of [
    [item(Number.MAX_SAFE_INTEGER + 1)], [item(0)], [item(-1)], [item("001")],
    [item(1), item(1)], [item("9223372036854775808")],
    [{ ...item(), categoryId: undefined }], [{ ...item(), categoryId: "-12" }],
  ]) assert.throws(() => commerceCatalogSample(page(contents), "가", new Date(NOW).toISOString()), /invalid_sample/u);
  assert.equal(commerceCatalogSample(page([item("9223372036854775807")]), "가", new Date(NOW).toISOString()).items[0].catalogId, "9223372036854775807");
});

test("response first-page pagination and count inconsistencies fail closed", () => {
  for (const extra of [
    { page: 2 }, { first: false }, { size: 100 }, { totalElements: 21, totalPages: 2, last: false },
    { totalElements: -1 }, { totalElements: 1.5 }, { totalPages: 0 }, { last: false },
    { contents: Array.from({ length: 21 }, (_, i) => item(i + 1)) }, { contents: {} },
  ]) assert.throws(() => commerceCatalogSample(page(undefined, extra), "가", new Date(NOW).toISOString()), /invalid_sample/u);
  assert.equal(commerceCatalogSample(page(undefined, { page: 0 }), "가", new Date(NOW).toISOString()).complete, true);
});

test("invalid config, deadline, already aborted signal and invalid keyword do zero network work", async () => {
  let calls = 0;
  const source = createCommerceCategorySource({ env: {}, now: () => NOW, fetchImpl: async () => { calls += 1; throw new Error("must-not-call"); } });
  await assert.rejects(source("가"), /source_unavailable/u);
  await assert.rejects(source("가", { deadline: NOW }), /deadline_exceeded/u);
  await assert.rejects(source("가", { signal: AbortSignal.abort() }), /source_aborted/u);
  for (const keyword of [null, "", "a\nb", "a".repeat(61)]) await assert.rejects(source(keyword), /invalid_keyword/u);
  assert.equal(calls, 0);
});

test("authentication deduplicates concurrent callers and caches only until expires_in minus margin", async () => {
  let time = NOW;
  let authCalls = 0;
  let catalogCalls = 0;
  const source = createCommerceCategorySource({ env: envFor(), now: () => time, signImpl: signature, fetchImpl: async (url) => {
    if (url.includes("oauth2/token")) { authCalls += 1; await new Promise((resolve) => setTimeout(resolve, 2)); return token({ expires_in: 120 }); }
    catalogCalls += 1;
    return json(page());
  } });
  await Promise.all([source("가"), source("나")]);
  assert.equal(authCalls, 1);
  assert.equal(catalogCalls, 2);
  time += 59_999;
  await source("다");
  assert.equal(authCalls, 1);
  time += 1;
  await source("라");
  assert.equal(authCalls, 2);
});

test("credential rotation never reuses the previous token or authentication cooldown", async () => {
  const config = envFor();
  const calls = [];
  const source = createCommerceCategorySource({ env: config, now: () => NOW, signImpl: signature, fetchImpl: async (url, request) => {
    calls.push({ url, request });
    if (url.includes("oauth2/token")) return token({ access_token: `token-${new URLSearchParams(request.body).get("client_id")}` });
    return json(page());
  } });
  await source("가");
  config.NAVER_COMMERCE_CLIENT_ID = "rotated-app";
  await source("나");
  assert.equal(calls.length, 4);
  assert.equal(calls[3].request.headers.authorization, "Bearer token-rotated-app");
});

test("a failed credential's cooldown does not prevent a newly configured credential from authenticating", async () => {
  const config = envFor();
  let calls = 0;
  const source = createCommerceCategorySource({ env: config, now: () => NOW, signImpl: signature, fetchImpl: async (url) => {
    calls += 1;
    if (calls === 1) return json({ message: "private failure" }, 401);
    return url.includes("oauth2/token") ? token() : json(page());
  } });
  await assert.rejects(source("가"), /source_permission/u);
  await assert.rejects(source("나"), /source_cooldown/u);
  config.NAVER_COMMERCE_CLIENT_ID = "new-credential-app";
  assert.equal((await source("다")).complete, true);
  assert.equal(calls, 3);
});

test("an expired authentication cooldown permits one fresh requested attempt, never an automatic retry", async () => {
  let time = NOW;
  let calls = 0;
  const { source } = fixture({ now: () => time, fetchImpl: async (url) => {
    calls += 1;
    if (calls === 1) return json({}, 403);
    return url.includes("oauth2/token") ? token() : json(page());
  } });
  await assert.rejects(source("가"), /source_permission/u);
  time += 60 * 60_000 - 1;
  await assert.rejects(source("나"), /source_cooldown/u);
  assert.equal(calls, 1);
  time += 1;
  assert.equal((await source("다")).complete, true);
  assert.equal(calls, 3);
});

test("all authentication failures have one attempt and cooldown, with no body or token leakage", async () => {
  for (const status of [400, 401, 403, 418, 429, 500]) {
    let calls = 0;
    const source = createCommerceCategorySource({ env: envFor(), now: () => NOW, signImpl: signature, fetchImpl: async () => {
      calls += 1; return json({ error: "secret-server-error-body" }, status);
    } });
    await assert.rejects(source("가"), (error) => !/secret/u.test(error.message) && /source_|rate_limited/u.test(error.message));
    await assert.rejects(source("나"), /source_cooldown/u);
    assert.equal(calls, 1);
  }
});

test("catalog 401 does not refresh or replay; catalog 429 stops subsequent fanout", async () => {
  for (const status of [401, 403, 418, 429]) {
    const calls = [];
    const source = createCommerceCategorySource({ env: envFor(), now: () => NOW, signImpl: signature, fetchImpl: async (url) => {
      calls.push(url); return url.includes("oauth2/token") ? token() : json({ message: "hidden-detail" }, status);
    } });
    await assert.rejects(source("가"), /source_permission|rate_limited/u);
    await assert.rejects(source("나"), /source_cooldown/u);
    assert.equal(calls.length, 2);
  }
});

test("unknown transport/signature errors are sanitized and never replayed", async () => {
  for (const phase of ["sign", "auth", "catalog"]) {
    let calls = 0;
    const source = createCommerceCategorySource({ env: envFor(), now: () => NOW,
      signImpl: phase === "sign" ? async () => { throw new Error("private-secret-value"); } : signature,
      fetchImpl: async (url) => {
        calls += 1;
        if (phase === "catalog" && url.includes("oauth2/token")) return token();
        throw new Error("private-secret-value");
      },
    });
    await assert.rejects(source("가"), (error) => error.message === "source_unavailable");
    assert.equal(calls, phase === "sign" ? 0 : phase === "catalog" ? 2 : 1);
  }
});

test("invalid tokens, malformed JSON and non-JSON responses cannot become category evidence", async () => {
  for (const payload of [
    { access_token: "injected\r\nheader" }, { access_token: "" }, { token_type: "Other" },
    { expires_in: 60 }, { expires_in: 10801 }, { expires_in: "10800" },
  ]) {
    let calls = 0;
    const { source } = fixture({ fetchImpl: async () => { calls += 1; return token(payload); } });
    await assert.rejects(source("가"), /invalid_response/u);
    assert.equal(calls, 1);
  }
  for (const response of [new Response("<html>secret</html>"), new Response("{broken", { headers: { "content-type": "application/json" } })]) {
    const { source } = fixture({ fetchImpl: async (url) => url.includes("oauth2/token") ? token() : response });
    await assert.rejects(source("가"), /invalid_response/u);
  }
});

test("both token and catalog responses have byte caps before and while streaming", async () => {
  for (const auth of [true, false]) {
    for (const advertised of [true, false]) {
      const { source } = fixture({ fetchImpl: async (url) => {
        if (!auth && url.includes("oauth2/token")) return token();
        return json({ data: "x".repeat(256 * 1024) }, 200, advertised ? { "content-length": String(256 * 1024 + 20) } : {});
      } });
      await assert.rejects(source("가"), /response_too_large/u);
    }
  }
});

test("caller abort cancels its catalog transport immediately with no replay", async () => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let capturedSignal;
  let calls = 0;
  const { source } = fixture({ fetchImpl: async (url, request) => {
    calls += 1;
    if (url.includes("oauth2/token")) return token();
    capturedSignal = request.signal;
    entered();
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const result = source("가", { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(result, /source_aborted/u);
  assert.equal(capturedSignal.aborted, true);
  assert.equal(calls, 2);
});

test("one aborted authentication waiter does not cancel another keyword's shared token request", async () => {
  let release;
  let authSignal;
  let calls = 0;
  const { source } = fixture({ fetchImpl: async (url, request) => {
    calls += 1;
    if (url.includes("oauth2/token")) {
      authSignal = request.signal;
      await new Promise((resolve) => { release = resolve; });
      return token();
    }
    return json(page());
  } });
  const controller = new AbortController();
  const cancelled = source("가", { signal: controller.signal });
  const remaining = source("나");
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(cancelled, /source_aborted/u);
  assert.equal(authSignal.aborted, false);
  release();
  assert.equal((await remaining).complete, true);
  assert.equal(calls, 2);
});

test("a short first caller deadline never aborts another caller's valid shared OAuth wait", async () => {
  let authCalls = 0;
  let catalogCalls = 0;
  let authSignal;
  const { source } = fixture({ now: Date.now, fetchImpl: async (url, request) => {
    if (url.includes("oauth2/token")) {
      authCalls += 1;
      authSignal = request.signal;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return token();
    }
    catalogCalls += 1;
    return json(page());
  } });
  const short = source("가", { deadline: Date.now() + 15 });
  const long = source("나", { deadline: Date.now() + 1000 });
  await assert.rejects(short, /source_timeout/u);
  assert.equal((await long).complete, true);
  assert.equal(authSignal.aborted, false);
  assert.equal(authCalls, 1);
  assert.equal(catalogCalls, 1);
});

test("a timed-out OAuth response arriving later never caches its token", async () => {
  let time = NOW;
  let authCalls = 0;
  let catalogCalls = 0;
  const { source } = fixture({ now: () => time, fetchImpl: async (url) => {
    if (url.includes("oauth2/token")) {
      authCalls += 1;
      if (authCalls === 1) await new Promise((resolve) => setTimeout(resolve, 60));
      return token({ access_token: authCalls === 1 ? "late-token-must-not-cache" : "new-token" });
    }
    catalogCalls += 1;
    return json(page());
  } });
  await assert.rejects(source("가", { deadline: NOW + 15 }), /source_timeout/u);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(authCalls, 1);
  assert.equal(catalogCalls, 0);
  time += 60 * 60_000;
  assert.equal((await source("나")).complete, true);
  assert.equal(authCalls, 2);
  assert.equal(catalogCalls, 1);
});

test("OAuth expiry of its clock deadline is checked even before the timer has fired", async () => {
  let time = NOW;
  let calls = 0;
  const { source } = fixture({ now: () => time, fetchImpl: async () => {
    calls += 1;
    time += 4001;
    return token();
  } });
  await assert.rejects(source("가"), /source_timeout/u);
  await assert.rejects(source("나"), /source_cooldown/u);
  assert.equal(calls, 1);
});

test("all aborted auth waiters abort the OAuth request and never proceed to catalog", async () => {
  let authSignal;
  let calls = 0;
  const { source } = fixture({ fetchImpl: async (_url, request) => {
    calls += 1; authSignal = request.signal; return new Promise(() => {});
  } });
  const controller = new AbortController();
  const result = source("가", { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(result, /source_aborted/u);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(authSignal.aborted, true);
  assert.equal(calls, 1);
});

test("hung catalog and OAuth requests obey the caller deadline without retries", async () => {
  for (const phase of ["auth", "catalog"]) {
    let calls = 0;
    let capturedSignal;
    const { source } = fixture({ now: Date.now, fetchImpl: async (url, request) => {
      calls += 1;
      if (phase === "catalog" && url.includes("oauth2/token")) return token();
      capturedSignal = request.signal;
      return new Promise(() => {});
    } });
    await assert.rejects(source("가", { deadline: Date.now() + 20 }), /source_timeout/u);
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(capturedSignal.aborted, true);
    assert.equal(calls, phase === "catalog" ? 2 : 1);
  }
});
