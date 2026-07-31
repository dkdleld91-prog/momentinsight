import assert from "node:assert/strict";
import test from "node:test";

import { safeErrorPayload } from "./[...path].mjs";
import { nodeRequestId } from "./error-safety.mjs";

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
