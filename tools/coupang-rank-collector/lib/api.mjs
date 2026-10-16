// 서버 호출(명세 §9.2 lib/api.mjs): POST apiBase + /api/coupang-rank-worker, 제한 20초.
// 반환 { status, body, routeMissing }. 네트워크 실패는 { status: 0 }. 4xx 인데 body.code 가 없으면 routeMissing(M1).
import { COLLECTOR_VERSION, COLLECTOR_VERSION_HEADER, COUPANG_WORKER_PATH, WORKER_BODY_MAX_BYTES } from "./contract.mjs";

export const API_TIMEOUT_MS = 20000;

function stripTitles(list) {
  return Array.isArray(list) ? list.map(({ t, ...rest }) => rest) : list;
}

// 본문이 64KB 를 넘으면 제목(t)을 지우고, 그래도 넘으면 측정 목록을 비운 error 로 바꾼다.
export function fitRecordBody(body, maxBytes = WORKER_BODY_MAX_BYTES) {
  let text = JSON.stringify(body);
  if (Buffer.byteLength(text, "utf8") <= maxBytes || !body?.page) return { body, text, trimmed: false };
  const withoutTitles = { ...body, page: { ...body.page, organic: stripTitles(body.page.organic), ads: stripTitles(body.page.ads) } };
  text = JSON.stringify(withoutTitles);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { body: withoutTitles, text, trimmed: true };
  const errorBody = {
    ...withoutTitles,
    page: { ...withoutTitles.page, status: "error", stable: false, organic: [], ads: [], errorCode: "extract_failed" },
  };
  return { body: errorBody, text: JSON.stringify(errorBody), trimmed: true };
}

export function createApi({ config, token, fetchImpl = globalThis.fetch, timeoutMs = API_TIMEOUT_MS }) {
  const url = `${config.apiBase}${COUPANG_WORKER_PATH}`;
  async function post(payload, { timeoutMs: callTimeoutMs = timeoutMs } = {}) {
    const { text } = fitRecordBody(payload);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [COLLECTOR_VERSION_HEADER]: COLLECTOR_VERSION,
        },
        body: text,
        redirect: "error",
        signal: AbortSignal.timeout(callTimeoutMs),
      });
    } catch {
      return { status: 0, body: null, routeMissing: false };
    }
    let body = null;
    try {
      const raw = await response.text();
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const status = Number(response.status) || 0;
    const routeMissing = status >= 400 && status < 500 && !(body && typeof body.code === "string" && body.code);
    return { status, body, routeMissing };
  }
  return {
    url,
    post,
    hello: (fields, options) => post({ action: "hello", ...fields }, options),
    claim: (options) => post({ action: "claim" }, options),
    record: (fields, options) => post({ action: "record", ...fields }, options),
    release: (runId, reason, options) => post({ action: "release", runId, reason }, options),
  };
}
