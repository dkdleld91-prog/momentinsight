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
