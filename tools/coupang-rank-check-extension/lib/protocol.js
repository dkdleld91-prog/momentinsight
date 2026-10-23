// C 30일 ① '지금 확인' 확장 — 상수·요청 검사·주소 만들기·서버 요청(spec-manual §4, 2026-10-23 구현).
// 이 파일은 크롬 서비스 워커와 Node 테스트가 함께 읽는다(ESM). 크롬 API 는 쓰지 않는다.
// 서버 요청은 이 파일의 serverGet 한 곳뿐이다(정적 테스트). 쿠팡에는 fetch 하지 않는다(창을 열어 읽기만).

export const EXTENSION_VERSION = "1.0.0"; // manifest.json version 과 같아야 한다(테스트)

// ── 보내는 쪽(관리자 화면)과 서버 ──
export const PAGE_ORIGIN = "https://insight.momentlabs.co.kr";
export const PAGE_PATHS = Object.freeze(["/admin", "/admin.html"]);
export const SERVER_ORIGIN = PAGE_ORIGIN;
export const TRACKERS_PATH = "/api/coupang-rank-trackers"; // = 서버 contract COUPANG_TRACKERS_PATH
// 서버 요청 2가지(모두 GET). 세션 게이트가 POST 에 출처(Origin)·CSRF 를 요구하는데 확장 서비스 워커의 출처는
// chrome-extension:// 이라 들 수 없다(session-gate.mjs mutationOriginAllowed·csrfMatches). GET 은 그 둘을 보지 않는다.
// 요청 토큰은 주소가 아니라 머리글에 싣는다(기록·주소창에 남지 않게). 이름은 서버 contract 와 같다(테스트).
//  - manual-verify: 빈 시크릿 창을 열어 검사를 마친 뒤, 쿠팡 주소를 넣기 직전. 서버가 토큰·기한·상태·전역 간격(서버 시각)을
//    보고 '검색함'으로 한 번만 표시한다.
//  - manual-stop: 차단 신호를 본 순간. 서버가 그 요청의 검색 날짜를 '그날 중지'로 건다(더 엄격하게만 바뀐다).
export const VERIFY_VIEW = "manual-verify"; // = MANUAL_VERIFY_VIEW
export const STOP_VIEW = "manual-stop"; // = MANUAL_STOP_VIEW
export const CLAIM_ID_PARAM = "claimId"; // = MANUAL_CLAIM_ID_PARAM
export const STOP_REASON_PARAM = "reason"; // = MANUAL_STOP_REASON_PARAM
export const CLAIM_TOKEN_HEADER = "x-mi-coupang-claim-token"; // = MANUAL_CLAIM_TOKEN_HEADER
export const EXTENSION_VERSION_HEADER = "x-mi-coupang-check";
export const SERVER_TIMEOUT_MS = 10000;
export const SERVER_BODY_MAX_CHARS = 16384;
// 그날 중지 사유(= 서버 MANUAL_STOP_CODES). 순서는 서버 manualStopSignal 과 같다(assemble.js stopReasonOf).
export const STOP_REASONS = Object.freeze([
  "blocked_http_403", "blocked_http_429", "blocked_http_503", "blocked_text", "blocked_page",
  "login_redirect", "page_unreadable", "extension_reported",
]);
export const EXTENSION_REPORTED_STOP = "extension_reported";

// ── 쿠팡 검색 1쪽 ──
export const SEARCH_HOST = "www.coupang.com";
export const SEARCH_PATH = "/np/search";
export const SEARCH_URL_PREFIX = "https://www.coupang.com/np/search?q=";
export const COUPANG_ORIGIN_PATTERN = "https://www.coupang.com/*";
export const SERVER_ORIGIN_PATTERN = "https://insight.momentlabs.co.kr/*";
export const AD_SOURCE_TYPE = "srp_product_ads"; // = 수집기 AD_SOURCE_TYPE
export const BLOCKED_HTTP_STATUSES = Object.freeze([403, 429, 503]); // = 계약 BLOCKED_HTTP_STATUSES

// ── 측정 시간(수집기 collect.mjs·계약과 같은 값 — 패리티 테스트) ──
export const LOAD_TIMEOUT_MS = 45000; // = NAV_TIMEOUT_MS
export const HARD_CAP_MS = 120000; // = BROWSER_HARD_CAP_SECONDS * 1000
export const SETTLE_MS = 2500;
export const SCROLL_COUNT = 8;
export const EXTRA_SCROLL_COUNT = 2;
export const SCROLL_PIXELS = 1400;
export const SCROLL_GAP_MS = Object.freeze([350, 700]);
export const READ_GAP_MS = 1200;
// 확장에만 있는 값
export const KEEPALIVE_MS = 15000; // 서비스 워커 30초 유휴 타이머를 확장 API 호출로 다시 잰다
export const PROBE_INTERVAL_MS = 1000; // 주 문서 load(=readyState complete) 확인 간격
export const QUICK_READ_TIMEOUT_MS = 3000; // 시간 초과 때 차단 문구·HTTP 상태만 짧게 읽기
export const CLOSE_TIMEOUT_MS = 5000;
export const LOCAL_MIN_GAP_MS = 170000; // 같은 크롬 안 상대 간격(보조). 전역 180초는 서버가 확인 시각으로 판정한다
export const ACTIVE_STALE_MS = 7 * 60 * 1000; // 이보다 오래된 '작업 중' 기록의 창은 닫지 않는다(창 번호 재사용 대비)
export const RESULT_RESEND_MS = 10 * 60 * 1000; // 차단 아닌 결과는 10분(서버 늦은 보고 기한)까지만 다시 준다
// 그날 중지 알림이 실패하면 같은 실행 안에서 다시 보낸다(0초 → 3초 뒤 → 그 7초 뒤 = 0·3·10초, 알람 없이 기다리기만).
export const STOP_RETRY_DELAYS_MS = Object.freeze([3000, 7000]);
export const WINDOW_WIDTH = 1280;
export const WINDOW_HEIGHT = 900;
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ── 메시지 ──
export const MESSAGE_TYPES = Object.freeze({
  hello: "mi-coupang-hello",
  check: "mi-coupang-check",
  ack: "mi-coupang-ack",
});
// 쿠팡 주소를 넣기 전에 멈춘 경우(쿠팡 검색 0번). 확장은 빈 시크릿 창을 먼저 열어 검사한 뒤에 서버 확인을 받으므로,
// 창 만들기·시크릿 검사 실패는 서버 확인 전이다(횟수에 들지 않음). 서버 확인 뒤에 멈춘 것(window_closed_early 등)은
// 횟수에 들 수 있다(서버 기록 응답의 counted 가 사실). 모두 서버 contract MANUAL_NOT_STARTED_CODES 에 있어야 한다(테스트).
// report_pending·blocked_today 는 '오늘 차단을 봤다'는 뜻이라 서버가 그날 중지로 받아야 한다(MANUAL_STOP_NOT_STARTED_CODES).
export const NOT_STARTED_CODES = Object.freeze([
  "bad_request",
  "busy",
  "too_soon",
  "report_pending",
  "blocked_today",
  "incognito_not_allowed",
  "host_access_withheld",
  "incognito_window_open",
  "verify_refused",
  "verify_unreachable",
  "window_create_failed",
  "window_create_null",
  "window_closed_early",
  "extension_error",
]);
// 창을 연 뒤의 실패(page.errorCode) = 서버 MANUAL_EXTENSION_ERROR_CODES. 모두 ^[a-z0-9_]{1,60}$.
export const PAGE_ERROR_CODES = Object.freeze([
  "page_timeout",
  "window_closed",
  "browser_hard_cap",
  "page_load_failed",
  "page_unreadable",
  "extract_failed",
  "user_navigated",
]);
// D1(대표 결정 '예'): 쿠팡이 읽을 수 없는 곳(로그인 화면 등)으로 보내 읽지 못함 = 차단으로 본다.
export const UNREADABLE_ERROR_CODE = "page_unreadable";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLAIM_TOKEN_PATTERN = /^mcm1_[A-Za-z0-9_-]{43}$/; // = 서버 MANUAL_TOKEN_PATTERN
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SERVER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,59}$/;
const SERVER_STATE_PATTERN = /^[a-z_]{1,30}$/;
const KEYWORD_MAX = 50;

function codePointLength(text) {
  return Array.from(text).length;
}

function wellFormed(text) {
  // String.prototype.isWellFormed 는 크롬 111부터라 직접 본다(최소 110).
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isClaimToken(value) {
  return typeof value === "string" && CLAIM_TOKEN_PATTERN.test(value);
}

// 검색어: 1~50 코드 포인트, 제어 문자·깨진 글자 없음, 앞뒤 공백 없음(서버가 정규화한 값을 그대로 받는다).
export function isSearchKeyword(value) {
  if (typeof value !== "string") return false;
  if (!wellFormed(value) || CONTROL_PATTERN.test(value)) return false;
  if (value.trim() !== value || value === "") return false;
  return codePointLength(value) <= KEYWORD_MAX;
}

export function searchUrl(keyword) {
  return `${SEARCH_URL_PREFIX}${encodeURIComponent(keyword)}`;
}

// 보낸 쪽: insight.momentlabs.co.kr 의 관리자 화면 최상위 프레임만. manifest matches(/admin*)와 겹쳐 한 번 더 본다.
export function isAllowedSender(sender) {
  if (!sender || typeof sender !== "object") return false;
  if (sender.origin !== undefined && sender.origin !== PAGE_ORIGIN) return false;
  if (typeof sender.url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(sender.url);
  } catch {
    return false;
  }
  if (parsed.origin !== PAGE_ORIGIN) return false;
  if (!PAGE_PATHS.includes(parsed.pathname)) return false;
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  return true;
}

// 메시지 모양 검사. 통과하면 { type, ... }, 아니면 { type: null }.
export function parseMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { type: null };
  if (message.type === MESSAGE_TYPES.hello) return { type: "hello" };
  if (message.type === MESSAGE_TYPES.ack) {
    return isUuid(message.claimId) ? { type: "ack", claimId: message.claimId.toLowerCase() } : { type: null };
  }
  if (message.type === MESSAGE_TYPES.check) {
    if (!isUuid(message.claimId) || !isClaimToken(message.claimToken)) return { type: "check", invalid: true };
    // 화면이 보내는 keyword 는 참고값이다. 창에 넣는 검색어는 서버 확인 응답의 keyword 만 쓴다.
    return { type: "check", claimId: message.claimId.toLowerCase(), claimToken: message.claimToken };
  }
  return { type: null };
}

export function compareVersion(left, right) {
  const a = String(left || "0.0.0").split(".").map(Number);
  const b = String(right || "0.0.0").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
  }
  return 0;
}

// navigator 의 브라우저 문자열에서 "chrome 141" / "edge 141" 만 뽑는다(60자 이하).
export function browserLabel(uaText) {
  const text = String(uaText || "");
  const edge = text.match(/\bEdg\/(\d{1,4})/);
  if (edge) return `edge ${edge[1]}`;
  const chrome = text.match(/\bChrome\/(\d{1,4})/);
  if (chrome) return `chrome ${chrome[1]}`;
  return "chrome unknown";
}

// 한국 날짜(YYYY-MM-DD). 서버 시각(서버가 준 serverTime + 맥 시계와의 차이)으로만 계산한다.
export function kstDayOf(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function splitAddress(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!/^https?:$/.test(parsed.protocol)) return { host: "", path: "" };
    return { host: parsed.host.toLowerCase().slice(0, 60), path: parsed.pathname.slice(0, 80) };
  } catch {
    return { host: "", path: "" };
  }
}

// ── 서버 요청 ──
// GET {SERVER_ORIGIN}{TRACKERS_PATH}?view=<view>&claimId=<uuid>[&reason=<code>]
//   머리글: x-mi-coupang-claim-token: mcm1_…, x-mi-coupang-check: <확장 버전>
//   쿠키: 같은 크롬의 총관리자 세션(credentials include). 리다이렉트는 따라가지 않는다.
export function serverUrl(view, claimId, extra = {}) {
  const params = new URLSearchParams({ view, [CLAIM_ID_PARAM]: claimId, ...extra });
  return `${SERVER_ORIGIN}${TRACKERS_PATH}?${params.toString()}`;
}

export function serverInit(claimToken, version = EXTENSION_VERSION) {
  return {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: {
      accept: "application/json",
      [CLAIM_TOKEN_HEADER]: claimToken,
      [EXTENSION_VERSION_HEADER]: version,
    },
  };
}

async function serverGet(fetchImpl, url, claimToken, { version = EXTENSION_VERSION, timeoutMs = SERVER_TIMEOUT_MS, timers = globalThis } = {}) {
  if (typeof fetchImpl !== "function") return { reached: false };
  const init = serverInit(claimToken, version);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = timers.setTimeout(() => { if (controller) controller.abort(); }, timeoutMs);
  let response;
  let text = "";
  try {
    response = await fetchImpl(url, controller ? { ...init, signal: controller.signal } : init);
    text = await response.text();
  } catch {
    return { reached: false };
  } finally {
    timers.clearTimeout(timer);
  }
  let body = null;
  if (typeof text === "string" && text.length <= SERVER_BODY_MAX_CHARS) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { reached: true, status: response.status, body };
}

function refusalDetail(status, body) {
  const detail = {
    httpStatus: Number.isInteger(status) ? status : null,
    serverCode: typeof body?.code === "string" && SERVER_CODE_PATTERN.test(body.code) ? body.code : null,
  };
  if (typeof body?.state === "string" && SERVER_STATE_PATTERN.test(body.state)) detail.serverState = body.state;
  const retry = Number(body?.retryAfterSec);
  if (Number.isInteger(retry) && retry >= 0 && retry <= 86400) detail.retryAfterSec = retry;
  return detail;
}

function serverTimeOf(body) {
  for (const key of ["serverTime", "verifiedAt"]) {
    const value = body?.[key];
    if (typeof value !== "string") continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// 확인 응답 해석. 시각 비교는 하지 않는다(서버가 이미 판정했다). serverTimeMs 는 날짜 계산용으로만 넘긴다.
// 200 {ok:true, verified:true, claimId, keyword, keywordKey, verifiedAt, serverTime} 만 통과.
export function interpretVerifyResponse(status, body, claimId) {
  if (status === 200) {
    const valid = body && body.ok === true && body.verified === true
      && typeof body.claimId === "string" && body.claimId.toLowerCase() === String(claimId).toLowerCase()
      && isSearchKeyword(body.keyword);
    if (!valid) return { ok: false, code: "verify_unreachable", reason: "invalid_response", ...refusalDetail(status, body) };
    return {
      ok: true,
      keyword: body.keyword,
      keywordKey: typeof body.keywordKey === "string" ? body.keywordKey : null,
      serverTimeMs: serverTimeOf(body),
    };
  }
  // 401(세션 없음)·403(총관리자 아님)·404·409(간격·진행 중·그날 중지 등)·410(기한) = 서버가 허락하지 않음.
  if (Number.isInteger(status) && status >= 400 && status < 500) return { ok: false, code: "verify_refused", ...refusalDetail(status, body) };
  return { ok: false, code: "verify_unreachable", ...refusalDetail(status, body) };
}

export async function verifyClaim(fetchImpl, { claimId, claimToken, ...options }) {
  const reply = await serverGet(fetchImpl, serverUrl(VERIFY_VIEW, claimId), claimToken, options);
  if (!reply.reached) return { ok: false, code: "verify_unreachable", httpStatus: null, serverCode: null };
  return interpretVerifyResponse(reply.status, reply.body, claimId);
}

// 그날 중지 알림. 결과 보고(화면 → manual-record)와 따로 보내 관리자 탭이 닫혀도 서버가 멈추게 한다.
export async function reportStop(fetchImpl, { claimId, claimToken, reason, ...options }) {
  if (!STOP_REASONS.includes(reason)) return { ok: false, httpStatus: null, serverCode: null };
  const reply = await serverGet(fetchImpl, serverUrl(STOP_VIEW, claimId, { [STOP_REASON_PARAM]: reason }), claimToken, options);
  if (!reply.reached) return { ok: false, httpStatus: null, serverCode: null };
  if (reply.status === 200 && reply.body && reply.body.ok === true) return { ok: true, stopped: reply.body.stopped === true, httpStatus: 200 };
  return { ok: false, ...refusalDetail(reply.status, reply.body) };
}
