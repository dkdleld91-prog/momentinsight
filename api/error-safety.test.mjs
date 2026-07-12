import assert from "node:assert/strict";
import test from "node:test";

import { safeErrorPayload } from "./[...path].mjs";

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

test("maps exposed secret names to a configuration response", () => {
  const response = new Response(null, { status: 500 });
  const result = safeErrorPayload(response, "SUPABASE_SECRET_KEY is missing");

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "SERVER_CONFIGURATION_PENDING");
  assert.match(result.body.message, /관리자 설정/);
});
