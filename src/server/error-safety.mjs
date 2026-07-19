const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function safeErrorPayload(response, text) {
  if (response.status < 500) return null;

  const sensitive = /\b(?:SUPABASE_[A-Z0-9_]+|MISSING_[A-Z0-9_]+|[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|JWKS)[A-Z0-9_]*)\b/.test(text)
    || /\b(?:secret|token|api[_ -]?key|private[_ -]?key|service[_ -]?role(?:[_ -]?key)?|jwks)\b\s*(?:=|:)\s*\S+/i.test(text);
  let requestId = "";
  let expectedServerResponse = false;
  try {
    const payload = JSON.parse(text || "{}");
    const code = String(payload?.code || "");
    const statuses = Object.values(payload?.sourceStatus || {});
    const isExpectedConfigPending = /_NOT_CONFIGURED$/.test(code)
      || statuses.some((item) => item?.status === "not_configured");
    expectedServerResponse = isExpectedConfigPending || code === "SERVER_NOT_READY";
    if (SAFE_REQUEST_ID.test(String(payload?.requestId || ""))) requestId = String(payload.requestId);
  } catch {}

  if (expectedServerResponse && !sensitive) return null;

  return {
    status: sensitive ? 503 : 500,
    body: {
      ok: false,
      message: sensitive
        ? "서버 연결이 준비되지 않았습니다. 관리자 설정을 확인해주세요."
        : "서버 처리 중 오류가 발생했습니다.",
      code: sensitive ? "SERVER_CONFIGURATION_PENDING" : "SERVER_ERROR",
      ...(requestId ? { requestId } : {}),
    },
  };
}
