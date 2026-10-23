// C 30일 순위 ① '지금 확인' 서버 도우미(spec-manual §6.8, 2026-10-23 재구현). Vercel 함수 파일이 아니다.
// 화면 API 핸들러(coupang-rank-trackers.mjs)만 import 한다. 바깥 의존은 contract·inputs·page-result·node:crypto 뿐이다.
// - 요청 토큰: "mcm1_" + base64url(32바이트). 서버는 sha256 hex 만 저장하고 원문은 claim 응답에 한 번만 싣는다.
// - 시간 판정은 SQL(서버 시계)이 한다. 여기서는 시각을 계산하지 않고 SQL 이 준 값을 옮기기만 한다(retryAfterSec 포함).
import { createHash, randomBytes } from "node:crypto";
import {
  ERROR_HTTP_STATUS,
  MANUAL_CHANGED_PARAMS_MAX,
  MANUAL_CHANGED_PARAM_NAME_MAX,
  MANUAL_CLAIM_TTL_SECONDS,
  MANUAL_EXTENSION_FOLDER,
  MANUAL_EXTENSION_ID,
  MANUAL_EXTENSION_VERSION,
  MANUAL_EXTENSION_ZIP_PATH,
  MANUAL_MIN_EXTENSION_VERSION,
  MANUAL_QUERY_MISMATCH_ERROR_CODE,
  MANUAL_STATES,
  MANUAL_STOP_NOT_STARTED_CODES,
  MANUAL_TOKEN_PATTERN,
  MANUAL_USER_NAVIGATED_ERROR_CODE,
} from "./contract.mjs";
import { coupangKeywordKey, normalizeCoupangKeyword } from "./inputs.mjs";
import { manualStopSignal } from "./page-result.mjs";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
// 수동 칸이 있는지 보는 열(대표 SQL 20261018090000 실행 전에는 없다).
const MANUAL_SETTINGS_COLUMN = "manual_enabled";
// M2 를 보는 판정(검색어가 바뀌면 목록이 그 키워드의 순위가 아니다). 차단·시간 초과·오류·이동은 그대로 둔다.
const QUERY_CHECKED_STATUSES = new Set(["ok", "noresult", "empty", "partial"]);
const STOP_EXTENSION_REPORTED = "extension_reported";
// 회차 final_path 칸 상한(SQL char_length <= 80 · page-result FINAL_PATH_MAX). 잘린 이름 목록 끝 표시.
const FINAL_PATH_MAX = 80;
const CHANGED_CUT_MARK = "&…";
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

// 상태 → 거절 코드(§6.2). ready 는 거절이 아니다.
export const MANUAL_STATE_CODES = Object.freeze({
  setup_required: "COUPANG_MANUAL_SETUP_REQUIRED",
  off: "COUPANG_MANUAL_OFF",
  budget: "COUPANG_MANUAL_BUDGET",
  stopped: "COUPANG_MANUAL_STOPPED",
  cooldown: "COUPANG_MANUAL_COOLDOWN",
  hours: "COUPANG_MANUAL_HOURS",
  busy: "COUPANG_MANUAL_BUSY",
  daily_cap: "COUPANG_MANUAL_DAILY_CAP",
  gap: "COUPANG_MANUAL_GAP",
});

// 화면에 그대로 보여도 되는 쉬운 문구(원인을 단정하지 않는다). 시간·횟수가 들어가는 문구는 manualRefusal 이 채운다.
export const MANUAL_MESSAGES = Object.freeze({
  COUPANG_MANUAL_SETUP_REQUIRED: "지금 확인용 대표 SQL 을 실행하기 전입니다.",
  COUPANG_MANUAL_OFF: "지금 확인이 꺼져 있습니다(총관리자 패널에서 켤 수 있습니다).",
  COUPANG_MANUAL_BUDGET: "저장 용량 상한에 닿아 지금 확인을 멈췄습니다.",
  COUPANG_MANUAL_STOPPED: "오늘 쿠팡 확인 중 차단으로 보이는 응답이 있어 오늘은 지금 확인을 멈췄습니다. 내일 다시 됩니다.",
  COUPANG_MANUAL_COOLDOWN: "자동 수집에서 쿠팡 차단 신호가 있어 쉬는 중입니다. 쉬기가 끝나면 다시 됩니다.",
  COUPANG_MANUAL_HOURS: "지금 확인은 정해진 시간에만 됩니다.",
  COUPANG_MANUAL_BUSY: "다른 확인이 진행 중입니다. 끝난 뒤 다시 눌러 주세요.",
  COUPANG_MANUAL_DAILY_CAP: "오늘 확인 횟수를 모두 썼습니다. 내일 다시 됩니다.",
  COUPANG_MANUAL_GAP: "검색과 검색 사이 간격을 기다리는 중입니다.",
  COUPANG_MANUAL_TRACKER_PAUSED: "일시중지한 추적은 확인할 수 없습니다.",
  COUPANG_MANUAL_TRACKER_INELIGIBLE: "연결이 끊긴 광고주·팀 코드 범위라 확인할 수 없습니다.",
  COUPANG_MANUAL_CLAIM_NOT_FOUND: "확인 요청을 찾을 수 없습니다. 다시 눌러 주세요.",
  COUPANG_MANUAL_CLAIM_MISMATCH: "확인 요청 정보가 맞지 않습니다. 화면을 새로고침한 뒤 다시 눌러 주세요.",
  COUPANG_MANUAL_CLAIM_CLOSED: "이미 끝난 확인 요청입니다.",
  COUPANG_MANUAL_CLAIM_USED: "이미 쓴 확인 요청입니다(한 요청으로 검색은 한 번만 합니다).",
  COUPANG_MANUAL_CLAIM_NOT_VERIFIED: "확장이 서버 확인을 받지 않은 요청이라 결과를 저장하지 않았습니다.",
  COUPANG_MANUAL_CLAIM_EXPIRED: "확인 요청 기한이 지나 결과를 저장하지 않았습니다.",
  COUPANG_MANUAL_RECORD_INVALID: "확인 결과 형식이 맞지 않아 저장하지 않았습니다.",
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

// 설정 행에 수동 칸이 있는지(대표 SQL 실행 여부). 없으면 수동 RPC 를 부르지 않는다.
export function hasManualColumns(settings) {
  return plainObject(settings) && Object.hasOwn(settings, MANUAL_SETTINGS_COLUMN);
}

// 요청 토큰의 sha256 hex(소문자 64자). DB token_sha256 과 같은 값.
export function manualTokenHash(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

// 새 1회용 요청 토큰. token 원문은 claim 응답에만 담고 저장·기록하지 않는다.
export function generateManualClaimToken() {
  const token = `mcm1_${randomBytes(32).toString("base64url")}`;
  if (!MANUAL_TOKEN_PATTERN.test(token)) throw new Error("manual_claim_token_format");
  const tokenSha256 = manualTokenHash(token);
  if (!SHA256_HEX_PATTERN.test(tokenSha256)) throw new Error("manual_claim_token_hash");
  return { token, tokenSha256 };
}

export function isManualToken(value) {
  return typeof value === "string" && MANUAL_TOKEN_PATTERN.test(value);
}

export function manualStateCode(state) {
  return Object.hasOwn(MANUAL_STATE_CODES, state) ? MANUAL_STATE_CODES[state] : null;
}

// SQL summary(jsonb) → 화면·확장이 읽는 manual 칸(§6.6). 상수(확장 ID·버전·zip 경로)를 함께 싣는다.
// 수동 칸이 없거나(SQL 전) 요약을 읽지 못하면 { state: "setup_required" } 만 준다(버튼 숨김).
export function manualPayload(summary) {
  const source = plainObject(summary) ? summary : {};
  const state = MANUAL_STATES.includes(source.state) ? source.state : "setup_required";
  if (state === "setup_required") return { state };
  return {
    state,
    enabled: source.enabled === true,
    usedToday: finiteOrNull(source.usedToday) ?? 0,
    maxPerDay: finiteOrNull(source.maxPerDay),
    minGapSeconds: finiteOrNull(source.minGapSeconds),
    fromHour: finiteOrNull(source.fromHour),
    toHour: finiteOrNull(source.toHour),
    nextAt: textOrNull(source.nextAt),
    busyUntil: textOrNull(source.busyUntil),
    lastSearchAt: textOrNull(source.lastSearchAt),
    stoppedDay: textOrNull(source.stoppedDay),
    stoppedAt: textOrNull(source.stoppedAt),
    stoppedCode: textOrNull(source.stoppedCode),
    cooldownUntil: textOrNull(source.cooldownUntil),
    serverTime: textOrNull(source.serverTime),
    claimTtlSeconds: MANUAL_CLAIM_TTL_SECONDS,
    extensionId: MANUAL_EXTENSION_ID,
    extensionVersion: MANUAL_EXTENSION_VERSION,
    minExtensionVersion: MANUAL_MIN_EXTENSION_VERSION,
    extensionZipPath: MANUAL_EXTENSION_ZIP_PATH,
    extensionFolder: MANUAL_EXTENSION_FOLDER,
  };
}

// 다음 가능 시각까지 남은 초(서버 시계끼리의 차). 둘 중 하나라도 없으면 null.
function secondsUntil(target, serverTime) {
  const until = Date.parse(String(target || ""));
  const now = Date.parse(String(serverTime || ""));
  if (!Number.isFinite(until) || !Number.isFinite(now)) return null;
  return Math.max(1, Math.ceil((until - now) / 1000));
}

function refusalMessage(code, manual) {
  if (code === "COUPANG_MANUAL_HOURS" && Number.isInteger(manual.fromHour) && Number.isInteger(manual.toHour)) {
    return `지금 확인은 ${manual.fromHour}~${manual.toHour}시(한국 시각)에만 됩니다.`;
  }
  if (code === "COUPANG_MANUAL_DAILY_CAP" && Number.isInteger(manual.maxPerDay)) {
    return `오늘 확인 ${manual.maxPerDay}번을 모두 썼습니다. 내일 다시 됩니다.`;
  }
  if (code === "COUPANG_MANUAL_GAP" && Number.isInteger(manual.minGapSeconds)) {
    return `검색과 검색 사이 간격(${Math.round(manual.minGapSeconds / 60)}분)을 기다리는 중입니다.`;
  }
  return MANUAL_MESSAGES[code];
}

// SQL 이 { ok:false, state, manual } 또는 { ok:false, code, ... } 로 거절했을 때 화면 응답 모양.
// 반환: { code, status, message(모르는 코드면 null — 핸들러 문구표로 채움), extra(manual·retryAfterSec·nextAt·stopped·field)}
export function manualRefusal(data) {
  const source = plainObject(data) ? data : {};
  const manual = plainObject(source.manual) ? manualPayload(source.manual) : null;
  const code = typeof source.code === "string" && source.code
    ? source.code
    : (manualStateCode(source.state) || "COUPANG_MANUAL_SETUP_REQUIRED");
  const extra = {};
  if (typeof source.state === "string" && MANUAL_STATES.includes(source.state)) extra.state = source.state;
  if (typeof source.field === "string") extra.field = source.field;
  if (typeof source.stopped === "boolean") extra.stopped = source.stopped;
  if (manual) {
    extra.manual = manual;
    if (code === "COUPANG_MANUAL_GAP" && manual.nextAt) {
      extra.nextAt = manual.nextAt;
      extra.retryAfterSec = secondsUntil(manual.nextAt, manual.serverTime);
    }
    if (code === "COUPANG_MANUAL_BUSY" && manual.busyUntil) {
      extra.retryAfterSec = secondsUntil(manual.busyUntil, manual.serverTime);
    }
  }
  const status = ERROR_HTTP_STATUS[code];
  return {
    code,
    // SQL 이 모르는 코드를 주더라도 5xx 로 새지 않게 4xx 로 닫는다(5xx 코드는 3개로 고정).
    status: Number.isInteger(status) && status >= 400 && status < 500 ? status : 409,
    message: refusalMessage(code, manual || {}) || null,
    extra,
  };
}

// 서버 최종 판정(M2): 목록을 읽은 판정인데 쪽의 검색어가 요청 키워드와 다르면(창에서 다른 검색을 했거나 쿠팡이
// 검색어를 바꿈) 그 목록은 이 키워드 순위가 아니다 → error(query_mismatch). 대소문자·공백 차이는 같은 키워드다.
// 확장이 '사람이 창 안을 눌러 다른 쪽으로 갔다'(user_navigated)고 하면 이동(unsupported) 대신 오류로 본다
// (그 키워드의 모든 추적기에 '검색 결과가 아님'을 쓰지 않게). 차단·시간 초과·오류는 그대로(차단 신호 우선).
export function finalManualStatus(classified, page, claim) {
  const base = plainObject(classified) ? classified : { status: "error" };
  if (base.status === "unsupported" && page?.errorCode === MANUAL_USER_NAVIGATED_ERROR_CODE) {
    return { status: "error", errorCode: MANUAL_USER_NAVIGATED_ERROR_CODE };
  }
  if (!QUERY_CHECKED_STATUSES.has(base.status)) return base;
  const normalized = normalizeCoupangKeyword(typeof page?.query === "string" ? page.query : "");
  const key = normalized.ok ? coupangKeywordKey(normalized.value) : "";
  if (!key || key !== String(claim?.keyword_key ?? "")) {
    return { status: "error", errorCode: MANUAL_QUERY_MISMATCH_ERROR_CODE };
  }
  return base;
}

// 측정 중 쿼리만 바뀌어 user_navigated 로 끝난 회차의 바뀐 쿼리 이름(확장 page.changedParams, 이름만·값 없음).
// 모양이 나쁜 원소는 본문을 거절하지 않고 뺀다(진단용 칸이라 M6 제목과 같은 방식): 문자열·1~40 코드 포인트·제어 문자 없음·
// 깨진 글자 없음만 받고, 같은 이름은 하나, 앞에서부터 10개. 배열이 아니면 null(경로·q 가 바뀐 이동이거나 이름을 싣지 않는 확장).
export function manualChangedParams(page) {
  const list = plainObject(page) && Array.isArray(page.changedParams) ? page.changedParams : null;
  if (!list) return null;
  const out = [];
  for (const name of list) {
    if (out.length >= MANUAL_CHANGED_PARAMS_MAX) break;
    if (typeof name !== "string" || name === "" || !name.isWellFormed() || CONTROL_CHAR_PATTERN.test(name)) continue;
    if (Array.from(name).length > MANUAL_CHANGED_PARAM_NAME_MAX || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

// 회차 기록에 바뀐 쿼리 이름을 남길 곳(2026-10-23, 마이그레이션 없이 쓰는 기존 칸). 회차 표에는 오류 세부 칸이 없고,
// SQL coupang_rank_manual_record 가 p_run 에서 받는 칸 중 주소를 적는 칸은 final_host·final_path 뿐이라 final_path 를 쓴다.
// 모양: 쪽 경로 + "?" + 이름(encodeURIComponent, 값 없음)을 "&" 로 이은 것 — 예 "/np/search?channel&traceId".
// 칸 상한 80자 안에서 이름 단위로 자르고, 잘랐으면 끝에 "&…". 이름이 하나도 없거나 user_navigated 가 아니면 경로 그대로.
export function manualNavigatedFinalPath(page, errorCode) {
  const path = plainObject(page) && typeof page.finalPath === "string" ? page.finalPath : "";
  if (errorCode !== MANUAL_USER_NAVIGATED_ERROR_CODE) return path;
  const names = manualChangedParams(page);
  if (!names || names.length === 0) return path;
  const encoded = names.map((name) => encodeURIComponent(name));
  const join = (parts) => `${path}?${parts.join("&")}`;
  if (join(encoded).length <= FINAL_PATH_MAX) return join(encoded);
  for (let keep = encoded.length - 1; keep >= 1; keep -= 1) {
    const text = `${join(encoded.slice(0, keep))}${CHANGED_CUT_MARK}`;
    if (text.length <= FINAL_PATH_MAX) return text;
  }
  const bare = `${path}?…`;
  return bare.length <= FINAL_PATH_MAX ? bare : path;
}

// 결과 보고의 그날 중지 사유. 측정 결과면 쪽의 차단 신호, '시작 못 함'이면 확장이 오늘 차단을 봤다는 코드.
export function manualRecordStopCode(outcome, outcomeCode, page) {
  if (outcome === "measured") return manualStopSignal(page);
  if (outcome === "not_started" && MANUAL_STOP_NOT_STARTED_CODES.includes(outcomeCode)) return STOP_EXTENSION_REPORTED;
  return null;
}
