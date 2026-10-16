import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import vercelHandler, { safeErrorPayload } from "../api/[...path].mjs";
import { nodeRequestId } from "../api/_error-safety.mjs";
import { ERROR_HTTP_STATUS as COUPANG_RANK_ERROR_HTTP_STATUS } from "../src/server/coupang-rank/contract.mjs";

test("accepts only a safe inbound request id", () => {
  assert.equal(nodeRequestId({ headers: { "x-request-id": "request-safe-1234" } }), "request-safe-1234");
  assert.notEqual(nodeRequestId({ headers: { "x-request-id": "bad id\nvalue" } }), "bad id\nvalue");
});

test("passes through client errors", () => {
  const response = new Response(null, { status: 400 });
  assert.equal(safeErrorPayload(response, JSON.stringify({ message: "잘못된 요청입니다." })), null);
});

test("sanitizes database details from server errors", () => {
  const response = new Response(null, { status: 500 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    message: "relation public.clients does not exist",
    code: "42P01",
  }));

  assert.deepEqual(result, {
    status: 500,
    body: {
      ok: false,
      message: "서버 처리 중 오류가 발생했습니다.",
      code: "SERVER_ERROR",
    },
  });
});

test("keeps explicit configuration-pending responses", () => {
  const response = new Response(null, { status: 503 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "NAVER_API_NOT_CONFIGURED",
    message: "연결 준비 중입니다.",
  }));

  assert.equal(result, null);
});

test("keeps an explicit readiness failure as HTTP 503", () => {
  const response = new Response(null, { status: 503 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "SERVER_NOT_READY",
    message: "서버 연결 준비 상태를 확인해주세요.",
  }));

  assert.equal(result, null);
});

test("keeps handler-authored tracker failures and collector-unavailable responses (2026-09-11)", () => {
  for (const [status, field, code] of [
    [500, "code", "NAVER_RANK_TRACKERS_FAILED"],
    [503, "errorCode", "SHOPPING_RANK_SOURCE_UNAVAILABLE"],
  ]) {
    const response = new Response(null, { status });
    const result = safeErrorPayload(response, JSON.stringify({
      ok: false,
      [field]: code,
      message: "순위 추적 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
    }));
    assert.equal(result, null, code);
  }
  // A secret in the body still forces the sanitized envelope.
  const leaking = safeErrorPayload(new Response(null, { status: 500 }), JSON.stringify({
    ok: false,
    code: "NAVER_RANK_TRACKERS_FAILED",
    message: "SUPABASE_SERVICE_ROLE_KEY invalid",
  }));
  assert.equal(leaking.status, 503);
  assert.equal(leaking.body.code, "SERVER_CONFIGURATION_PENDING");
});

test("keeps a benign Supabase availability message without treating the product name as a secret", () => {
  const response = new Response(null, { status: 503 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "SERVER_NOT_READY",
    message: "supabase unavailable",
  }));

  assert.equal(result, null);
});

test("sanitizes secret details even when the response code is expected", () => {
  const response = new Response(null, { status: 503 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "SERVER_NOT_READY",
    message: "SUPABASE_SECRET_KEY=do-not-leak",
  }));

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "SERVER_CONFIGURATION_PENDING");
  assert.doesNotMatch(JSON.stringify(result), /SUPABASE_SECRET_KEY|do-not-leak/);
});

test("keeps a safe request id when sanitizing a server error", () => {
  const response = new Response(null, { status: 500 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    requestId: "request-safe-1234",
    message: "database detail",
  }));
  assert.equal(result.body.requestId, "request-safe-1234");
});

test("maps exposed secret names to a configuration response", () => {
  const response = new Response(null, { status: 500 });
  const result = safeErrorPayload(response, "SUPABASE_SECRET_KEY is missing");

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "SERVER_CONFIGURATION_PENDING");
  assert.match(result.body.message, /관리자 설정/);
});

test("preserves a valid typed rank-cron item failure without leaking row data", () => {
  const response = new Response(null, { status: 502 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "NAVER_RANK_CRON_ITEM_FAILURE",
    message: "raw collector failure for private-keyword",
    requestId: "request-safe-5678",
    summary: {
      now: "2026-07-31T01:02:03.000Z",
      checked: 5,
      succeeded: 3,
      failed: 2,
      remaining: 7,
      drained: false,
      configured: true,
      results: [{ trackerId: "private-tracker", keyword: "private-keyword", productId: "private-product" }],
    },
  }));

  assert.deepEqual(result, {
    status: 502,
    body: {
      ok: false,
      code: "NAVER_RANK_CRON_ITEM_FAILURE",
      message: "일부 네이버 상품 순위 자동 갱신이 실패했습니다.",
      summary: {
        now: "2026-07-31T01:02:03.000Z",
        checked: 5,
        succeeded: 3,
        failed: 2,
        remaining: 7,
        drained: false,
        configured: true,
      },
      requestId: "request-safe-5678",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private|trackerId|keyword|productId|results/);
});

test("rejects an inconsistent typed rank-cron failure summary", () => {
  const response = new Response(null, { status: 502 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "NAVER_RANK_CRON_ITEM_FAILURE",
    summary: {
      now: "2026-07-31T01:02:03.000Z",
      checked: 5,
      succeeded: 5,
      failed: 2,
      remaining: 0,
      drained: true,
      configured: true,
    },
  }));

  assert.equal(result.status, 500);
  assert.equal(result.body.code, "SERVER_ERROR");
});

test("does not preserve a typed rank-cron failure that contains secret details", () => {
  const response = new Response(null, { status: 502 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "NAVER_RANK_CRON_ITEM_FAILURE",
    message: "SUPABASE_SECRET_KEY=do-not-leak",
    summary: {
      now: "2026-07-31T01:02:03.000Z",
      checked: 1,
      succeeded: 0,
      failed: 1,
      remaining: 0,
      drained: true,
      configured: true,
    },
  }));

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "SERVER_CONFIGURATION_PENDING");
  assert.doesNotMatch(JSON.stringify(result), /SUPABASE_SECRET_KEY|do-not-leak/);
});

test("keeps the typed rank provider configuration response", () => {
  const response = new Response(null, { status: 503 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "NAVER_RANK_PROVIDER_NOT_CONFIGURED",
    message: "네이버 상품 순위 수집원이 연결되지 않아 대기열을 시작하지 않았습니다.",
    claimed: 0,
    sourceStatus: { shoppingRank: { status: "not_configured" } },
  }));

  assert.equal(result, null);
});

test("preserves only bounded observable fields for a warming shopping provider", () => {
  const response = new Response(null, { status: 503 });
  const result = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "NAVER_RANK_PROVIDER_WARMING",
    errorCode: "private-error-code",
    message: "raw provider message for private-keyword",
    detail: "private runtime detail",
    retryable: true,
    retryAfter: 9999,
    claimed: 0,
    requestId: "request-safe-9012",
    providerStatus: { status: "warming", raw: "private-provider-state" },
    sourceStatus: { shoppingRank: { status: "warming", label: "private-label" } },
  }));

  assert.deepEqual(result, {
    status: 503,
    body: {
      ok: false,
      code: "NAVER_RANK_PROVIDER_WARMING",
      errorCode: "NAVER_RANK_PROVIDER_WARMING",
      message: "네이버 상품 순위 수집원을 준비하고 있어 대기열을 아직 시작하지 않았습니다.",
      retryable: true,
      retryAfter: 300,
      rankSourceReady: false,
      claimed: 0,
      providerStatus: {
        status: "warming",
        retryable: true,
        retryAfter: 300,
      },
      sourceStatus: { shoppingRank: { status: "warming" } },
      requestId: "request-safe-9012",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private|raw|detail|label/);
});

test("rejects malformed or secret-bearing provider status responses", () => {
  const response = new Response(null, { status: 503 });
  const malformed = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "SHOPPING_RANK_PROVIDER_WARMING",
    retryable: false,
    retryAfter: 15,
    sourceStatus: { shoppingRank: { status: "warming" } },
  }));
  assert.equal(malformed.status, 500);
  assert.equal(malformed.body.code, "SERVER_ERROR");

  const sensitive = safeErrorPayload(response, JSON.stringify({
    ok: false,
    code: "SHOPPING_RANK_SOURCE_UNAVAILABLE",
    retryable: false,
    retryAfter: 0,
    sourceStatus: { shoppingRank: { status: "unavailable" } },
    detail: "NAVER_SHOPPING_RANK_API_KEY=do-not-leak",
  }));
  assert.equal(sensitive.status, 503);
  assert.equal(sensitive.body.code, "SERVER_CONFIGURATION_PENDING");
  assert.doesNotMatch(JSON.stringify(sensitive), /NAVER_SHOPPING_RANK_API_KEY|do-not-leak/);
});

// C 30일 순위 계약 §3.4 의 5xx(503 COUPANG_SETUP_REQUIRED, 500 COUPANG_RANK_TRACKERS_FAILED·COUPANG_RANK_WORKER_FAILED).
// 2026-10-16 통합 검수: 공용 봉인이 이 응답들을 500 SERVER_ERROR 로 바꿔 설치기가 auth=setup_required 대신 auth=error 를 냈다.
const COUPANG_RANK_5XX = Object.entries(COUPANG_RANK_ERROR_HTTP_STATUS).filter(([, status]) => status >= 500);

test("keeps every C 30-day rank contract 5xx response the handler authored (2026-10-16)", () => {
  assert.deepEqual(COUPANG_RANK_5XX.map(([code]) => code).sort(), [
    "COUPANG_RANK_TRACKERS_FAILED",
    "COUPANG_RANK_WORKER_FAILED",
    "COUPANG_SETUP_REQUIRED",
  ]);
  for (const [code, status] of COUPANG_RANK_5XX) {
    const result = safeErrorPayload(new Response(null, { status }), JSON.stringify({
      ok: false,
      code,
      message: "쿠팡 순위 저장소가 아직 준비되지 않았습니다.",
      requestId: "request-safe-c30-1",
    }));
    assert.equal(result, null, code);
  }
});

test("seals C 30-day rank 5xx payloads that do not match the contract exactly", () => {
  const sealed = (status, payload) => safeErrorPayload(new Response(null, { status }), JSON.stringify(payload));
  for (const [label, status, payload] of [
    ["wrong status for setup", 500, { ok: false, code: "COUPANG_SETUP_REQUIRED", message: "준비 중" }],
    ["wrong status for worker failure", 503, { ok: false, code: "COUPANG_RANK_WORKER_FAILED", message: "실패" }],
    ["wrong status for tracker failure", 502, { ok: false, code: "COUPANG_RANK_TRACKERS_FAILED", message: "실패" }],
    ["missing message", 503, { ok: false, code: "COUPANG_SETUP_REQUIRED" }],
    ["blank message", 503, { ok: false, code: "COUPANG_SETUP_REQUIRED", message: "   " }],
    ["non-string message", 500, { ok: false, code: "COUPANG_RANK_WORKER_FAILED", message: { raw: "relation x" } }],
    ["not a failure envelope", 503, { ok: true, code: "COUPANG_SETUP_REQUIRED", message: "준비 중" }],
    ["code only in errorCode", 503, { ok: false, errorCode: "COUPANG_SETUP_REQUIRED", message: "준비 중" }],
    ["unknown C code", 500, { ok: false, code: "COUPANG_RANK_SOMETHING_FAILED", message: "relation public.coupang_rank_runs does not exist" }],
  ]) {
    const result = sealed(status, payload);
    assert.equal(result?.status, 500, label);
    assert.equal(result?.body?.code, "SERVER_ERROR", label);
  }
});

test("a secret inside a C 30-day rank 5xx still forces the configuration envelope", () => {
  for (const [code, status] of COUPANG_RANK_5XX) {
    const result = safeErrorPayload(new Response(null, { status }), JSON.stringify({
      ok: false,
      code,
      message: "SUPABASE_SECRET_KEY=do-not-leak",
    }));
    assert.equal(result?.status, 503, code);
    assert.equal(result?.body?.code, "SERVER_CONFIGURATION_PENDING", code);
    assert.doesNotMatch(JSON.stringify(result), /SUPABASE_SECRET_KEY|do-not-leak/);
  }
});

// 운영 입구 그대로: api/[...path].mjs(Vercel) → src/server/index.mjs → 수집기 핸들러 → writeWebResponse.
// Supabase 는 127.0.0.1 의 가짜 PostgREST 뿐이다(운영 접속 없음). 대표 SQL 전처럼 모든 표 조회에 PGRST205·DB 오류를 돌려준다.
test("production entry keeps the C collector 503 COUPANG_SETUP_REQUIRED and 500 COUPANG_RANK_WORKER_FAILED (2026-10-16)", async (t) => {
  let mode = "missing";
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(String(req.url || ""));
    res.setHeader("content-type", "application/json");
    if (mode === "missing") {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.coupang_rank_collectors' in the schema cache" }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout on coupang_rank_collectors" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const names = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_SECRET_KEYS", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEYS"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    server.close();
  });
  for (const name of names) delete process.env[name];
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_SECRET_KEY = `sb_secret_${"x".repeat(30)}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = `sb_publishable_${"y".repeat(30)}`;

  const hello = async () => {
    const payload = Buffer.from(JSON.stringify({ action: "hello", platform: "windows", browser: { kind: "edge", version: "141.0.3537.71" }, node: "22.12.0", os: "Windows 10.0.26100", guard: "none" }));
    const req = Readable.from([payload]);
    req.method = "POST";
    req.url = "/api/coupang-rank-worker";
    req.headers = {
      host: "insight.momentlabs.co.kr",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
      "content-length": String(payload.length),
      authorization: `Bearer mic1_${"A".repeat(43)}`,
      "x-mi-coupang-collector": "1.0.0",
    };
    const res = {
      statusCode: 0,
      headers: new Map(),
      body: null,
      setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); },
      end(value) { this.body = value; },
    };
    const original = console.error;
    console.error = () => {};
    try {
      await vercelHandler(req, res);
    } finally {
      console.error = original;
    }
    return { status: res.statusCode, body: JSON.parse(Buffer.from(res.body).toString("utf8")) };
  };

  const missing = await hello();
  assert.ok(seen.some((url) => url.startsWith("/rest/v1/coupang_rank_collectors")), "가짜 PostgREST 까지 갔어야 한다");
  assert.equal(missing.status, 503);
  assert.equal(missing.body.code, "COUPANG_SETUP_REQUIRED");
  assert.equal(missing.body.message, "쿠팡 순위 저장소가 아직 준비되지 않았습니다.");

  mode = "broken";
  const broken = await hello();
  assert.equal(broken.status, 500);
  assert.equal(broken.body.code, "COUPANG_RANK_WORKER_FAILED");
  assert.doesNotMatch(JSON.stringify(broken.body), /57014|canceling|statement/);
});
