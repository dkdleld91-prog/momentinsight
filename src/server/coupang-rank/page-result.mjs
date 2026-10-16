// C 30일 순위 수집기 결과 검증·판정(명세 §6.5, WP3). 수집기 API 핸들러(coupang-rank-worker.mjs)만 쓴다.
// 순위는 여기서 세지 않는다(맞추기는 SQL coupang_rank_match 한 곳). 여기서는 다음 세 가지만 한다.
// 1) 수집기가 보낸 record 본문의 모양 검사(어긋나면 PAGE_INVALID {field})
// 2) 제목 t 다듬기(거절 대신 그 원소의 t 만 지움, M6)
// 3) 회차 상태 최종 판정(차단 신호 1순위, P2·H4)
// 이 모듈은 C 계약(contract.mjs) 말고는 아무것도 import 하지 않는다.
import {
  ADS_MAX,
  BLOCKED_HTTP_STATUSES,
  COLLECTOR_ERROR_CODE_PATTERN,
  FOREIGN_NAVIGATION_ERROR_CODE,
  KEYWORD_MAX,
  ORGANIC_MAX,
  PAGE_STATUSES,
  SLOT_MAX,
  TITLE_MAX,
  VERSION_PATTERN,
} from "./contract.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_ID_PATTERN = /^[0-9]{4,15}$/;
const VENDOR_ITEM_PATTERN = /^[0-9]{0,20}$/;
const COUPANG_HOST_PATTERN = /(^|\.)coupang\.com$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const ITEM_KEYS = new Set(["p", "v", "s", "t"]);

const HTTP_STATUS_MAX = 599;
const ITEM_COUNT_MAX = 200;
const FINAL_HOST_MAX = 60;
const FINAL_PATH_MAX = 80;
const DURATION_MS_MAX = 600000;
const BROWSER_TEXT_MAX = 60;

export const SEARCH_HOST = "www.coupang.com";
export const SEARCH_PATH = "/np/search";
export const LOGIN_HOST = "login.coupang.com";

// SQL 열 char_length 와 같은 기준(코드 포인트)으로 센다.
function codePointLength(text) {
  return Array.from(text).length;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIntegerBetween(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function invalid(field) {
  return { ok: false, field };
}

// "null 또는 X" 칸은 JSON 에서 빠진 것(undefined)도 null 로 본다.
// JS 수집기가 undefined 를 넣으면 JSON.stringify 가 키를 지우기 때문이다(차단 신호 httpStatus 를 잃지 않게).
function nullable(value) {
  return value === undefined ? null : value;
}

function validateItems(list, max, name, seenSlots) {
  if (!Array.isArray(list)) return invalid(`page.${name}`);
  if (list.length > max) return invalid(`page.${name}`);
  let previous = 0;
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const at = `page.${name}[${index}]`;
    if (!isPlainObject(item)) return invalid(at);
    for (const key of Object.keys(item)) {
      if (!ITEM_KEYS.has(key)) return invalid(`${at}.${key}`);
    }
    if (typeof item.p !== "string" || !PRODUCT_ID_PATTERN.test(item.p)) return invalid(`${at}.p`);
    if (typeof item.v !== "string" || !VENDOR_ITEM_PATTERN.test(item.v)) return invalid(`${at}.v`);
    if (!isIntegerBetween(item.s, 1, SLOT_MAX)) return invalid(`${at}.s`);
    // 배열 안은 s 오름차순·중복 없음(§3.3), 두 배열 사이에도 s 중복 없음(§6.5)
    if (item.s <= previous) return invalid(`${at}.s`);
    if (seenSlots.has(item.s)) return invalid(`${at}.s`);
    previous = item.s;
    seenSlots.add(item.s);
    // t 는 없거나 문자열. 모양이 나쁜 문자열은 거절하지 않고 sanitizeTitles 가 지운다(M6)
    if (item.t !== undefined && typeof item.t !== "string") return invalid(`${at}.t`);
  }
  return null;
}

// record 본문 검증(§6.5). 통과하면 { ok: true }, 아니면 { ok: false, field } — 핸들러가 400 PAGE_INVALID {field} 로 답한다.
// 본문은 고치지 않는다(제목 다듬기는 sanitizeTitles).
export function validateCollectorRecord(body) {
  if (!isPlainObject(body)) return invalid("body");
  if (typeof body.runId !== "string" || !UUID_PATTERN.test(body.runId)) return invalid("runId");
  if (typeof body.keywordKey !== "string") return invalid("keywordKey");
  const keyLength = codePointLength(body.keywordKey);
  if (keyLength < 1 || keyLength > KEYWORD_MAX) return invalid("keywordKey");

  const page = body.page;
  if (!isPlainObject(page)) return invalid("page");
  if (!PAGE_STATUSES.includes(page.status)) return invalid("page.status");
  const httpStatus = nullable(page.httpStatus);
  if (httpStatus !== null && !isIntegerBetween(httpStatus, 0, HTTP_STATUS_MAX)) return invalid("page.httpStatus");
  for (const flag of ["loginWall", "stable", "noResultText", "blockedText"]) {
    if (typeof page[flag] !== "boolean") return invalid(`page.${flag}`);
  }
  if (!isIntegerBetween(page.itemCount, 0, ITEM_COUNT_MAX)) return invalid("page.itemCount");

  const seenSlots = new Set();
  const organicProblem = validateItems(page.organic, ORGANIC_MAX, "organic", seenSlots);
  if (organicProblem) return organicProblem;
  const adsProblem = validateItems(page.ads, ADS_MAX, "ads", seenSlots);
  if (adsProblem) return adsProblem;

  if (typeof page.finalHost !== "string"
    || page.finalHost.length > FINAL_HOST_MAX
    || page.finalHost !== page.finalHost.toLowerCase()
    || /\s/.test(page.finalHost)
    || CONTROL_CHAR_PATTERN.test(page.finalHost)) {
    return invalid("page.finalHost");
  }
  if (typeof page.finalPath !== "string"
    || page.finalPath.length > FINAL_PATH_MAX
    || page.finalPath.includes("?")
    || page.finalPath.includes("#")
    || CONTROL_CHAR_PATTERN.test(page.finalPath)) {
    return invalid("page.finalPath");
  }
  const errorCode = nullable(page.errorCode);
  if (errorCode !== null && (typeof errorCode !== "string" || !COLLECTOR_ERROR_CODE_PATTERN.test(errorCode))) {
    return invalid("page.errorCode");
  }

  if (!isIntegerBetween(body.durationMs, 0, DURATION_MS_MAX)) return invalid("durationMs");
  if (typeof body.collectorVersion !== "string" || !VERSION_PATTERN.test(body.collectorVersion)) {
    return invalid("collectorVersion");
  }
  if (typeof body.browser !== "string"
    || codePointLength(body.browser) > BROWSER_TEXT_MAX
    || CONTROL_CHAR_PATTERN.test(body.browser)) {
    return invalid("browser");
  }
  return { ok: true };
}

function cleanTitle(item) {
  if (!Object.prototype.hasOwnProperty.call(item, "t")) return { ...item };
  const title = item.t;
  const keep = typeof title === "string"
    && title.isWellFormed()
    && title.trim() !== ""
    && codePointLength(title) <= TITLE_MAX;
  if (keep) return { ...item };
  const { t: _dropped, ...rest } = item;
  return rest;
}

// 제목 다듬기(M6). 홀로 남은 서러게이트(isWellFormed 아님)·빈 문자열·80 코드 포인트 초과면 그 원소의 t 만 지운다.
// 나머지 값(p·v·s)과 결과는 그대로 둔다. 입력은 바꾸지 않고 새 page 를 돌려준다.
export function sanitizeTitles(page) {
  if (!isPlainObject(page)) return page;
  const out = { ...page };
  if (Array.isArray(page.organic)) out.organic = page.organic.map((item) => (isPlainObject(item) ? cleanTitle(item) : item));
  if (Array.isArray(page.ads)) out.ads = page.ads.map((item) => (isPlainObject(item) ? cleanTitle(item) : item));
  return out;
}

function isCoupangHost(host) {
  return typeof host === "string" && COUPANG_HOST_PATTERN.test(host);
}

// 회차 상태 최종 판정(§6.5 표). 위에서부터 처음 맞는 행을 따른다. 검증을 통과한 page 를 받는다.
// 반환: { status } 또는 { status, errorCode }(서버가 덮어쓰는 판정 코드가 있을 때만)
export function classifyCollectorPage(page) {
  const httpStatus = nullable(page?.httpStatus);
  const host = typeof page?.finalHost === "string" ? page.finalHost : "";
  const path = typeof page?.finalPath === "string" ? page.finalPath : "";
  const organic = Array.isArray(page?.organic) ? page.organic : [];

  // 1~3: 차단 신호는 수집기의 page.status 와 무관하게 먼저 본다(P2)
  if (BLOCKED_HTTP_STATUSES.includes(httpStatus)) return { status: "blocked" };
  if (page?.blockedText === true || page?.status === "blocked") return { status: "blocked" };
  if (host === LOGIN_HOST || (isCoupangHost(host) && path.startsWith("/login"))) return { status: "blocked" };
  // 4~5: 수집기가 실패로 보낸 것
  if (page?.status === "timeout") return { status: "timeout" };
  if (page?.status === "error") return { status: "error" };
  // 6: 쿠팡이 아닌 곳(사람이 창에서 다른 사이트로 간 경우 등). 차단으로 세지 않는다(H4)
  if (!host || !isCoupangHost(host)) return { status: "error", errorCode: FOREIGN_NAVIGATION_ERROR_CODE };
  // 7: 그 밖의 HTTP 오류(1행의 403·429·503 제외)
  if (Number.isInteger(httpStatus) && httpStatus >= 400) return { status: "error" };
  // 8: 쿠팡 안이지만 검색 1쪽이 아님(이동). 그 키워드만 다음 날로
  if (host !== SEARCH_HOST || path !== SEARCH_PATH) return { status: "unsupported" };
  // 9~10: 일반 상품 0개
  if (organic.length === 0) return { status: page?.noResultText === true ? "noresult" : "empty" };
  // 11: 스크롤 뒤 개수가 흔들림
  if (page?.stable !== true) return { status: "partial" };
  return { status: "ok" };
}

// rpc("coupang_rank_record") 의 p_run(§6.5). 판정이 errorCode 를 주면 그 값으로 덮어쓴다.
// organic·ads 는 다듬은 제목 t 를 그대로 넘긴다(스냅샷 제목용). 증거 저장 때 t 를 빼는 것은 SQL 이 한다.
export function recordPayloadForRpc(body, classified) {
  const page = body?.page || {};
  const override = classified && typeof classified.errorCode === "string" ? classified.errorCode : null;
  return {
    httpStatus: nullable(page.httpStatus),
    loginWall: page.loginWall,
    stable: page.stable,
    itemCount: page.itemCount,
    organic: Array.isArray(page.organic) ? page.organic : [],
    ads: Array.isArray(page.ads) ? page.ads : [],
    finalHost: page.finalHost,
    finalPath: page.finalPath,
    durationMs: body?.durationMs,
    collectorVersion: body?.collectorVersion,
    browser: body?.browser,
    errorCode: override ?? nullable(page.errorCode),
  };
}
