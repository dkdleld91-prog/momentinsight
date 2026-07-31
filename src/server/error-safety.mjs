const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const NAVER_RANK_CRON_ITEM_FAILURE = "NAVER_RANK_CRON_ITEM_FAILURE";

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function safeNaverRankCronSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checked = nonNegativeInteger(value.checked);
  const succeeded = nonNegativeInteger(value.succeeded);
  const failed = nonNegativeInteger(value.failed);
  const remaining = nonNegativeInteger(value.remaining);
  const drained = typeof value.drained === "boolean" ? value.drained : null;
  const configured = typeof value.configured === "boolean" ? value.configured : null;
  const now = String(value.now || "");
  if (
    checked === null
    || succeeded === null
    || failed === null
    || remaining === null
    || drained === null
    || configured === null
    || !Number.isFinite(Date.parse(now))
    || checked !== succeeded + failed
    || checked === 0
    || failed === 0
    || configured !== true
    || drained !== (remaining === 0)
  ) return null;

  return { now, checked, succeeded, failed, remaining, drained, configured };
}

export function safeErrorPayload(response, text) {
  if (response.status < 500) return null;

  const sensitive = /\b(?:SUPABASE_[A-Z0-9_]+|MISSING_[A-Z0-9_]+|[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|JWKS)[A-Z0-9_]*)\b/.test(text)
    || /\b(?:secret|token|api[_ -]?key|private[_ -]?key|service[_ -]?role(?:[_ -]?key)?|jwks)\b\s*(?:=|:)\s*\S+/i.test(text);
  let requestId = "";
  let expectedServerResponse = false;
  let safeRankCronFailure = null;
  try {
    const payload = JSON.parse(text || "{}");
    const code = String(payload?.code || "");
    const statuses = Object.values(payload?.sourceStatus || {});
    const isExpectedConfigPending = /_NOT_CONFIGURED$/.test(code)
      || statuses.some((item) => item?.status === "not_configured");
    expectedServerResponse = isExpectedConfigPending || code === "SERVER_NOT_READY";
    if (SAFE_REQUEST_ID.test(String(payload?.requestId || ""))) requestId = String(payload.requestId);
    if (response.status === 502 && code === NAVER_RANK_CRON_ITEM_FAILURE) {
      safeRankCronFailure = safeNaverRankCronSummary(payload?.summary);
    }
  } catch {}

  if (expectedServerResponse && !sensitive) return null;
  if (safeRankCronFailure && !sensitive) {
    return {
      status: 502,
      body: {
        ok: false,
        code: NAVER_RANK_CRON_ITEM_FAILURE,
        message: "일부 네이버 상품 순위 자동 갱신이 실패했습니다.",
        summary: safeRankCronFailure,
        ...(requestId ? { requestId } : {}),
      },
    };
  }

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
