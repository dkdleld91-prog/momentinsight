// C 30일 순위(쿠팡 검색 1쪽, 광고 제외 일반 순위) 화면 API — 명세 §5(WP2).
// 독립 모듈: 바깥 의존은 @supabase/server·../security.mjs·../owner-identity.mjs·../runtime.mjs 뿐이고, 나머지는 ../coupang-rank/*.mjs.
// 일반 세션 경로다. 게이트가 신뢰 머리글(x-mi-session-*, x-mi-agency-code 등)을 다시 심고, 이 핸들러는 그 머리글만 읽는다.
// 사전 요청(사전 점검 메서드)은 라우터가 먼저 204 로 답하므로 여기서는 GET·POST 만 다룬다.
import { withSupabase } from "@supabase/server";
import { protectedJson } from "../security.mjs";
import { PRIMARY_AGENCY_CODE } from "../owner-identity.mjs";
import { requestIdFor } from "../runtime.mjs";
import {
  COLLECTOR_BUNDLE_VERSION,
  COLLECTOR_ERROR_CODE_PATTERN,
  ERROR_HTTP_STATUS,
  MANUAL_ALLOWED_ROLES,
  MANUAL_CLAIM_ID_PARAM,
  MANUAL_CLAIM_TOKEN_HEADER,
  MANUAL_CLAIM_TTL_SECONDS,
  MANUAL_OUTCOMES,
  MANUAL_RECORD_BODY_MAX_BYTES,
  MANUAL_STOP_CODES,
  MANUAL_STOP_REASON_PARAM,
  MANUAL_STOP_VIEW,
  MANUAL_VERIFY_VIEW,
  MAX_ACTIVE_COLLECTORS,
  SUCCESS_RUN_STATUSES,
  TRACKERS_BODY_MAX_BYTES,
  TRACKER_LIST_FETCH_LIMIT,
  TRACKER_LIST_MAX,
} from "../coupang-rank/contract.mjs";
import { chunk, inList, isSetupMissing, loadSettings, mapLimit, selectPages } from "../coupang-rank/db.mjs";
import { generateCollectorToken } from "../coupang-rank/worker-token.mjs";
import { accessView, canonicalAgencyCode, ownerSessionDenial, resolveCoupangAccess } from "../coupang-rank/access.mjs";
import {
  coupangKeywordKey,
  isUuid,
  normalizeCoupangGroupName,
  normalizeCoupangKeyword,
  parseCoupangProductInput,
  parseIdList,
} from "../coupang-rank/inputs.mjs";
import { collectorState, kstDayOf, kstDays30, trackerPayload } from "../coupang-rank/board.mjs";
import { capacityOf, isRaisingPatch, raiseStatus, settingsPayload, validateSettingsPatch } from "../coupang-rank/settings.mjs";
import { collectorOneLiners, safeRelease } from "../coupang-rank/one-liners.mjs";
import {
  MANUAL_MESSAGES,
  finalManualStatus,
  generateManualClaimToken,
  hasManualColumns,
  isManualToken,
  manualDiagnostics,
  manualNavigatedFinalPath,
  manualPauseFields,
  manualPayload,
  manualRecordStopCode,
  manualRefusal,
  manualTokenHash,
} from "../coupang-rank/manual.mjs";
import {
  classifyManualPage,
  manualStopSignal,
  recordPayloadForRpc,
  sanitizeTitles,
  validateManualRecord,
} from "../coupang-rank/page-result.mjs";

const RESPONSE_OPTIONS = Object.freeze({
  methods: "GET, POST, OPTIONS",
  headers: "content-type, x-mi-csrf, x-mi-agency-code",
});

const TABLES = Object.freeze({
  settings: "coupang_rank_settings",
  limits: "coupang_rank_account_limits",
  collectors: "coupang_rank_collectors",
  trackers: "coupang_rank_trackers",
  keywords: "coupang_rank_keywords",
  runs: "coupang_rank_runs",
  snapshots: "coupang_rank_snapshots",
  days: "coupang_rank_days",
  cooldowns: "coupang_rank_cooldowns",
  manualClaims: "coupang_rank_manual_claims",
});

const TRACKER_COLUMNS = [
  "id", "agency_code", "client_id", "keyword", "keyword_key", "product_id", "product_url", "vendor_item_id",
  "product_title", "group_name", "sort_order", "status", "paused_at", "created_kst_day", "current_result",
  "current_rank", "current_organic_count", "current_ad_order", "current_same_option", "last_checked_at",
  "last_found_at", "created_at",
].join(", ");
const DAY_COLUMNS = [
  "tracker_id", "kst_day", "slot_minute", "slot_index", "result", "rank", "organic_count", "ad_order",
  "checked_at", "success_count", "failure_count", "best_rank",
].join(", ");
const KEYWORD_COLUMNS = [
  "keyword_key", "next_due_at", "slot_ends_at", "lease_run_id", "consecutive_failures", "consecutive_unsupported", "last_status",
].join(", ");
const COLLECTOR_PANEL_COLUMNS = [
  "id", "label", "token_hint", "platform", "created_at", "revoked_at", "last_seen_at", "last_version", "last_node",
  "last_browser", "last_os", "last_guard", "last_claim_at", "last_claim_reply",
].join(", ");
const SNAPSHOT_COLUMNS = [
  "checked_at", "kst_day", "slot_index", "slot_minute", "result", "rank", "organic_count", "organic_slot", "ad_order", "same_option",
].join(", ");
// 측정 기록(view=runs)에 보여 줄 실패 회차 상태. 임대 중·반납은 측정이 아니라서 뺀다.
const FAILURE_RUN_STATUSES = Object.freeze(["expired", "partial", "blocked", "empty", "error", "timeout", "unsupported"]);

// ① 지금 확인: 확장이 창을 열기 직전에 부르는 확인(GET)과, 확장이 본 차단을 결과 보고 전에 알리는 중지(GET).
// 둘 다 같은 크롬의 총관리자 세션(게이트) + 1회용 요청 토큰(머리글)으로만 열린다. GET 인 이유는 contract.mjs ① 머리말.
const MANUAL_VIEWS = new Set([MANUAL_VERIFY_VIEW, MANUAL_STOP_VIEW]);
const VIEWS = new Set(["", "access", "runs", "collector", ...MANUAL_VIEWS]);
const SCOPED_ACTIONS = new Set(["create", "pause", "resume", "delete", "group"]);
const CREATE_ACTIONS = new Set(["create", "resume"]);
const OWNER_ACTIONS = new Set([
  "settings-update", "collector-enable", "collector-disable", "cooldown-clear",
  "account-limit-set", "collector-token-create", "collector-token-revoke",
]);
// ① 지금 확인(spec-manual §6.3·§6.4). manual-claim 은 범위(추적기)가 필요해 범위 판정을 하고, manual-record 는 범위와 무관하다.
const MANUAL_ACTIONS = new Set(["manual-claim", "manual-record"]);
const MANUAL_HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LIMIT_ERROR_CODES = new Set(["COUPANG_KEYWORD_LIMIT_REACHED", "COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED"]);
const LIMIT_AGENCY_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INTEGER_TEXT_PATTERN = /^[0-9]{1,4}$/;
const CLAIM_REASON_PATTERN = /^[a-z_]{1,30}$/;
const DEFAULT_COLLECTOR_LABEL = "수집기";
const COLLECTOR_LABEL_MAX = 40;
const DAY_BATCH_SIZE = 30;
const KEYWORD_BATCH_SIZE = 100;
const READ_CONCURRENCY = 4;
const SNAPSHOT_VIEW_LIMIT = 200;
const FAILURE_VIEW_LIMIT = 50;
const FAILURE_VIEW_DAYS = 14;
const SLOW_LIST_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
// 회차 출처(① 지금 확인 SQL 이 더한 coupang_rank_runs.source, 기본값 'collector'). 속도 올리기 관문은 48시간 수집기 회차만 센다.
const RUN_SOURCE_COLLECTOR = "collector";
const RAISE_WINDOW_MS = 48 * 60 * 60 * 1000;

const MESSAGES = Object.freeze({
  COUPANG_SESSION_REQUIRED: "로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.",
  TRIAL_LOCKED: "체험 계정에서는 쿠팡 30일 순위를 쓸 수 없습니다. 도입 문의 후 이용할 수 있습니다.",
  COUPANG_SCOPE_NO_CREATE: "이 팀 코드 범위에서는 새로 등록하거나 다시 시작할 수 없습니다(조회·중지·삭제만).",
  COUPANG_OWNER_ONLY: "총관리자만 할 수 있는 작업입니다.",
  COUPANG_SCOPE_NOT_FOUND: "대상 범위(광고주·팀 코드)를 찾을 수 없습니다.",
  COUPANG_ACCESS_DENIED: "쿠팡 순위 접근 권한을 확인할 수 없습니다.",
  COUPANG_KEYWORD_LIMIT_REACHED: "이 계정의 쿠팡 키워드 한도에 도달했습니다.",
  COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED: "전체 쿠팡 키워드 한도에 도달했습니다.",
  COUPANG_KEYWORD_REQUIRED: "키워드를 입력해 주세요.",
  COUPANG_KEYWORD_INVALID: "키워드는 50자 이하의 검색어로 입력해 주세요(주소는 넣지 않습니다).",
  COUPANG_PRODUCT_URL_REQUIRED: "쿠팡 상품 주소를 입력해 주세요.",
  COUPANG_SHORT_LINK_UNSUPPORTED: "상품 페이지를 연 뒤 주소창 주소를 붙여 주세요.",
  COUPANG_NOT_PRODUCT_URL: "쿠팡 상품 페이지 주소(…/vp/products/숫자)나 상품번호를 넣어 주세요.",
  COUPANG_GROUP_INVALID: "그룹 이름은 30자 이하로 입력해 주세요.",
  COUPANG_IDS_INVALID: "고칠 추적기를 1~100개 골라 주세요.",
  COUPANG_ACTION_INVALID: "요청 형식이 올바르지 않습니다.",
  COUPANG_SETTINGS_INVALID: "설정 값이 허용 범위를 벗어났습니다.",
  COUPANG_LIMIT_INVALID: "계정 코드나 한도 값이 올바르지 않습니다(한도 0~1000).",
  COUPANG_COLLECTOR_LABEL_INVALID: "수집기 이름은 1~40자로 입력해 주세요.",
  COUPANG_RAISE_CONFIRM_REQUIRED: "속도를 올리는 변경은 확인이 필요합니다.",
  COUPANG_TRACKER_NOT_FOUND: "추적기를 찾을 수 없습니다.",
  COUPANG_COLLECTOR_NOT_FOUND: "연결 코드를 찾을 수 없습니다.",
  COUPANG_RAISE_NOT_ALLOWED: "지금은 속도를 올릴 수 없습니다.",
  COUPANG_COLLECTOR_LIMIT: "활성 연결 코드는 최대 3개입니다. 쓰지 않는 코드를 먼저 폐기해 주세요.",
  COUPANG_NO_COLLECTOR: "연결된 수집기가 없습니다. 연결 코드를 먼저 만들어 주세요.",
  COUPANG_COLLECTOR_MANUAL_CONFLICT: "'지금 확인'이 켜져 있거나 지금 확인이 차단으로 쉬는 중(30분)·멈춘 날이라 자동 수집을 켜지 않았습니다(자동 수집은 아직 지금 확인의 간격·쉼·그날 중지를 보지 않습니다). '지금 확인 끄기'를 누르고, 쉬는 중이면 30분 뒤, 그날 중지였다면 다음 날 켜 주세요.",
  COUPANG_MANUAL_COLLECTOR_CONFLICT: "자동 수집이 켜져 있어 '지금 확인'을 켜지 않았습니다(자동 수집은 아직 지금 확인의 간격·그날 중지를 보지 않습니다). 먼저 수집기 관리에서 '수집 끄기'를 눌러 주세요.",
  BODY_TOO_LARGE: "요청 본문이 너무 큽니다.",
  METHOD_NOT_ALLOWED: "허용되지 않은 요청 방식입니다.",
  COUPANG_SETUP_REQUIRED: "쿠팡 순위 저장소가 아직 준비되지 않았습니다(대표 SQL 실행 전).",
  COUPANG_RANK_TRACKERS_FAILED: "쿠팡 순위 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
  ...MANUAL_MESSAGES,
});

class SetupMissingError extends Error {
  constructor(stage) {
    super("coupang_rank_setup_missing");
    this.stage = stage;
  }
}

function respond(request, body, status = 200) {
  return protectedJson(request, body, status, RESPONSE_OPTIONS);
}

function failure(request, code, extra = {}) {
  return respond(request, {
    ok: false,
    code,
    message: MESSAGES[code] || MESSAGES.COUPANG_RANK_TRACKERS_FAILED,
    ...extra,
  }, ERROR_HTTP_STATUS[code] || 400);
}

function dbError(stage, error) {
  if (isSetupMissing(error)) return new SetupMissingError(stage);
  const wrapped = new Error(`coupang_rank_${stage}_failed`);
  wrapped.code = String(error?.code || "");
  wrapped.stage = stage;
  wrapped.cause = error;
  return wrapped;
}

// supabase 응답에서 오류면 던지고 data 를 돌려준다.
function rowsOf(result, stage) {
  if (result?.error) throw dbError(stage, result.error);
  return Array.isArray(result?.data) ? result.data : [];
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

// ── 공용 읽기 ──────────────────────────────────────────────────────────────

async function loadDayRows(ctx, trackerIds, oldestDay) {
  if (!trackerIds.length) return [];
  const groups = await mapLimit(chunk(trackerIds, DAY_BATCH_SIZE), READ_CONCURRENCY, async (ids) => {
    const result = await selectPages(() => ctx.supabaseAdmin
      .from(TABLES.days)
      .select(DAY_COLUMNS)
      .in("tracker_id", ids)
      .gte("kst_day", oldestDay)
      .order("tracker_id", { ascending: true })
      .order("kst_day", { ascending: false })
      .order("slot_minute", { ascending: false }), { pageSize: 1000, maxPages: 64 });
    if (result.error) throw dbError("days", result.error);
    if (!result.complete) throw dbError("days", { code: "DAYS_INCOMPLETE" });
    return result.data;
  });
  return groups.flat();
}

async function loadKeywordRows(ctx, keywordKeys) {
  if (!keywordKeys.length) return [];
  const groups = await mapLimit(chunk(keywordKeys, KEYWORD_BATCH_SIZE), READ_CONCURRENCY, async (keys) => rowsOf(
    await ctx.supabaseAdmin.from(TABLES.keywords).select(KEYWORD_COLUMNS).filter("keyword_key", "in", inList(keys)),
    "keywords",
  ));
  return groups.flat();
}

async function loadActiveCollectors(ctx) {
  return rowsOf(
    await ctx.supabaseAdmin.from(TABLES.collectors).select("id, last_seen_at, last_version, revoked_at").is("revoked_at", null),
    "collectors",
  );
}

async function countActiveCollectors(ctx) {
  const result = await ctx.supabaseAdmin
    .from(TABLES.collectors)
    .select("id", { count: "exact", head: true })
    .is("revoked_at", null);
  if (result.error) throw dbError("collectors", result.error);
  const count = Number(result.count);
  if (!Number.isInteger(count)) throw dbError("collectors", { code: "COUNT_MISSING" });
  return count;
}

// 마지막 성공 회차 시각. collectorOnly 면 수집기 회차만 본다(① 지금 확인 SQL 이 회차 출처 source 를 더한 뒤에만 —
// 그 전에는 칸이 없고 모든 회차가 수집기다). '최근 갱신 · 수집기 PC'·'정상 · 마지막 수집'이 수동 확인만으로 수집기가
// 돈 것처럼 보이지 않게 한다.
async function loadLastSuccessAt(ctx, collectorOnly = false) {
  let query = ctx.supabaseAdmin.from(TABLES.runs).select("claimed_at");
  if (collectorOnly) query = query.eq("source", RUN_SOURCE_COLLECTOR);
  const rows = rowsOf(
    await query
      .in("status", [...SUCCESS_RUN_STATUSES])
      .order("claimed_at", { ascending: false })
      .limit(1),
    "last_success",
  );
  return rows[0]?.claimed_at ?? null;
}

// 자동 수집 집계(C 원문 coupang_rank_stats)는 회차 출처를 가리지 않아, 수동 '지금 확인' 성공이 '48시간 성공'·'마지막 성공'에
// 섞인다(수집기가 한 번도 돌지 않아도 속도 올리기 관문 '48시간 성공 48회'가 열릴 수 있었다). 수동 칸(SQL) 뒤에는 이 두 값만
// 수집기 회차로 다시 센다(C 원문 함수는 그대로). 차단·빈 쪽 수는 그대로 둔다(수동 차단도 차단으로 보는 보수적 효과).
async function collectorOnlyStats(ctx, settings, stats, now) {
  if (!hasManualColumns(settings)) return stats;
  const since = new Date(now.getTime() - RAISE_WINDOW_MS).toISOString();
  const [counted, lastSuccessAt] = await Promise.all([
    ctx.supabaseAdmin
      .from(TABLES.runs)
      .select("id", { count: "exact", head: true })
      .eq("source", RUN_SOURCE_COLLECTOR)
      .in("status", [...SUCCESS_RUN_STATUSES])
      .gt("claimed_at", since),
    loadLastSuccessAt(ctx, true),
  ]);
  if (counted.error) throw dbError("stats_collector", counted.error);
  const success48h = Number(counted.count);
  if (!Number.isInteger(success48h)) throw dbError("stats_collector", { code: "COUNT_MISSING" });
  return { ...stats, success48h, lastSuccessAt, successSource: RUN_SOURCE_COLLECTOR };
}

async function loadLimitStatus(ctx, agencyCode, keywordKey) {
  const result = await ctx.supabaseAdmin.rpc("coupang_rank_limit_status", {
    p_agency_code: agencyCode,
    p_keyword_key: keywordKey,
  });
  if (result.error) throw dbError("limit_status", result.error);
  if (!plainObject(result.data)) throw dbError("limit_status", { code: "LIMIT_STATUS_SHAPE" });
  return result.data;
}

function limitPayload(status, settings) {
  return {
    used: finiteNumberOrNull(status?.used) ?? 0,
    max: finiteNumberOrNull(status?.limit) ?? 0,
    globalUsed: finiteNumberOrNull(status?.globalUsed) ?? 0,
    globalMax: finiteNumberOrNull(status?.globalLimit) ?? 0,
    capacity: capacityOf(settings).keywordsAtChecks,
  };
}

async function loadStats(ctx) {
  const result = await ctx.supabaseAdmin.rpc("coupang_rank_stats");
  if (result.error) throw dbError("stats", result.error);
  return plainObject(result.data) ? result.data : {};
}

// 목록·단건 공용: 일별·키워드·수집기·마지막 성공·한도를 동시에 읽고 추적기 항목을 조립한다(§5.3.1 4~5단계).
async function assembleTrackers(ctx, settings, access, rows, now, { includeLimit }) {
  const days30 = kstDays30(now);
  const ids = rows.map((row) => row.id);
  const keywordKeys = [...new Set(rows.map((row) => row.keyword_key).filter(Boolean))];
  const [dayRows, keywordRows, collectors, lastSuccessAt, limitStatus] = await Promise.all([
    loadDayRows(ctx, ids, days30[days30.length - 1]),
    loadKeywordRows(ctx, keywordKeys),
    loadActiveCollectors(ctx),
    loadLastSuccessAt(ctx, hasManualColumns(settings)),
    includeLimit ? loadLimitStatus(ctx, access.agencyCode, null) : Promise.resolve(null),
  ]);
  const daysByTracker = new Map();
  for (const day of dayRows) {
    const key = String(day?.tracker_id || "");
    if (!daysByTracker.has(key)) daysByTracker.set(key, []);
    daysByTracker.get(key).push(day);
  }
  const keywordByKey = new Map(keywordRows.map((row) => [String(row.keyword_key), row]));
  // '지연'은 이 범위의 활성 추적기 키워드만 본다(일시중지만 남은 키워드는 수집 대상이 아니라 오탐이 된다).
  const activeKeys = new Set(rows.filter((row) => row.status === "active").map((row) => String(row.keyword_key)));
  const state = collectorState({
    setupRequired: false,
    settings,
    collectors,
    keywords: keywordRows.filter((row) => activeKeys.has(String(row.keyword_key))),
    now,
  });
  const trackers = rows.map((row) => trackerPayload(
    row,
    daysByTracker.get(String(row.id)) || [],
    keywordByKey.get(String(row.keyword_key)) || null,
    state,
    days30,
    now,
  ));
  return {
    days30,
    state,
    lastSuccessAt,
    trackers,
    limit: limitStatus ? limitPayload(limitStatus, settings) : null,
  };
}

async function findTrackerById(ctx, agencyCode, trackerId, columns = TRACKER_COLUMNS) {
  const result = await ctx.supabaseAdmin
    .from(TABLES.trackers)
    .select(columns)
    .eq("id", trackerId)
    .eq("agency_code", agencyCode)
    .maybeSingle();
  if (result.error) throw dbError("tracker", result.error);
  return result.data || null;
}

async function findTrackerByProduct(ctx, agencyCode, keywordKey, productId) {
  const result = await ctx.supabaseAdmin
    .from(TABLES.trackers)
    .select(TRACKER_COLUMNS)
    .eq("agency_code", agencyCode)
    .eq("keyword_key", keywordKey)
    .eq("product_id", productId)
    .maybeSingle();
  if (result.error) throw dbError("existing", result.error);
  return result.data || null;
}

// 등록·다시 시작 응답용: 그 추적기 하나를 목록과 같은 방식으로 다시 읽고, 한도(capacity 포함)를 함께 돌려준다.
async function trackerWithLimit(ctx, settings, access, trackerId, now) {
  const row = await findTrackerById(ctx, access.agencyCode, trackerId);
  if (!row) throw dbError("reload", { code: "TRACKER_RELOAD_MISSING" });
  const assembled = await assembleTrackers(ctx, settings, access, [row], now, { includeLimit: true });
  return { tracker: assembled.trackers[0], limit: assembled.limit };
}

function scopeFields(access) {
  return {
    scopeKey: `${access.mode}:${access.agencyCode}`,
    scopeAgencyCode: access.agencyCode,
    scopeClientId: access.clientId ? String(access.clientId) : "",
    scopeMode: access.mode,
    readOnly: access.readOnly === true,
  };
}

// ── ① 지금 확인 공용 ──────────────────────────────────────────────────────

function manualAllowed(access) {
  return access?.owner === true && MANUAL_ALLOWED_ROLES.includes(access.role);
}

// 목록에 싣는 manual 칸. 수동 칸이 없거나(대표 SQL 전) 요약을 읽지 못하면 setup_required 로 닫는다(목록은 그대로 200).
async function loadManualPayload(ctx, settings) {
  if (!hasManualColumns(settings)) return { state: "setup_required" };
  try {
    const result = await ctx.supabaseAdmin.rpc("coupang_rank_manual_summary", { p_exclude_claim: null });
    if (result?.error) {
      if (!isSetupMissing(result.error)) {
        console.warn(JSON.stringify({
          event: "coupang_rank_trackers_manual_summary_failed",
          errorCode: String(result.error.code || ""),
        }));
      }
      return { state: "setup_required" };
    }
    return manualPayload(result?.data);
  } catch (error) {
    console.warn(JSON.stringify({ event: "coupang_rank_trackers_manual_summary_failed", errorCode: String(error?.code || "") }));
    return { state: "setup_required" };
  }
}

// 수동 RPC 결과: 함수가 없으면(대표 SQL 전) null 을 돌려 부르는 쪽이 409 로 답하게 하고, 그 밖의 DB 오류는 던진다.
async function manualRpc(ctx, name, args, stage) {
  const result = await ctx.supabaseAdmin.rpc(name, args);
  if (result?.error) {
    if (isSetupMissing(result.error)) return null;
    const wrapped = new Error(`coupang_rank_${stage}_failed`);
    wrapped.code = String(result.error.code || "");
    wrapped.stage = stage;
    throw wrapped;
  }
  if (!plainObject(result?.data)) {
    const wrapped = new Error(`coupang_rank_${stage}_failed`);
    wrapped.code = "MANUAL_RPC_SHAPE";
    wrapped.stage = stage;
    throw wrapped;
  }
  return result.data;
}

// SQL 거절({ ok:false, code | state }) → 4xx 응답(문구는 사유별, manual·retryAfterSec·stopped 를 아는 만큼).
function manualFailure(request, data) {
  const refusal = manualRefusal(data);
  return respond(request, {
    ok: false,
    code: refusal.code,
    message: refusal.message || MESSAGES[refusal.code] || MESSAGES.COUPANG_RANK_TRACKERS_FAILED,
    ...refusal.extra,
  }, refusal.status);
}

// 확장이 보낸 요청 id(쿼리)·토큰(머리글). 토큰은 주소에 싣지 않는다(기록·주소창에 남지 않게).
function manualClaimCredentials(request, url) {
  const claimId = url.searchParams.get(MANUAL_CLAIM_ID_PARAM);
  if (!isUuid(claimId)) return { ok: false, field: "claimId" };
  const token = String(request.headers.get(MANUAL_CLAIM_TOKEN_HEADER) || "");
  if (!isManualToken(token)) return { ok: false, field: "claimToken" };
  return { ok: true, claimId: claimId.toLowerCase(), tokenSha256: manualTokenHash(token) };
}

// GET ?view=manual-verify: 확장이 새 시크릿 창을 열기 직전에 부른다. 통과하면 서버가 이 시각을 실제 검색 시각으로 적고
// (간격·하루 횟수의 기준), 확장은 응답의 keyword(서버가 정한 검색어)로만 창을 연다. 1회용: 두 번째는 CLAIM_USED.
async function manualVerifyView(request, ctx, settings, access, url, trace) {
  if (!hasManualColumns(settings)) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  const credentials = manualClaimCredentials(request, url);
  if (!credentials.ok) return failure(request, "COUPANG_ACTION_INVALID", { field: credentials.field });
  trace.stage = "manual_verify";
  const data = await manualRpc(ctx, "coupang_rank_manual_verify", {
    p_claim_id: credentials.claimId,
    p_token_sha256: credentials.tokenSha256,
    p_requested_by: access.createdBy,
  }, "manual_verify");
  if (!data) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  if (data.ok !== true || data.verified !== true) return manualFailure(request, data);
  return respond(request, {
    ok: true,
    verified: true,
    claimId: data.claimId ?? credentials.claimId,
    keyword: data.keyword ?? null,
    keywordKey: data.keywordKey ?? null,
    verifiedAt: data.verifiedAt ?? null,
    recordUntil: data.recordUntil ?? null,
    serverTime: data.serverTime ?? null,
  });
}

// GET ?view=manual-stop&reason=…: 확장이 차단 신호(403·429·503·차단 문구·검색 밖으로 보냄)를 본 순간 결과 보고와
// 따로 알린다(관리자 탭이 닫혀도 쉼이 걸리게). 차단될 때마다 30분 쉼(SQL c30-5 가 센다. c30-4 는 같은 날 두 번째면 그날 중지,
// 그 전에는 한 번에 그날 중지). 순위는 저장하지 않는다(더 엄격하게만 바뀐다). 응답 paused·pausedUntil 은 SQL 요약의 쉼 끝 시각.
async function manualStopView(request, ctx, settings, access, url, trace) {
  if (!hasManualColumns(settings)) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  const credentials = manualClaimCredentials(request, url);
  if (!credentials.ok) return failure(request, "COUPANG_ACTION_INVALID", { field: credentials.field });
  const reason = url.searchParams.get(MANUAL_STOP_REASON_PARAM);
  if (!MANUAL_STOP_CODES.includes(reason)) return failure(request, "COUPANG_ACTION_INVALID", { field: "reason" });
  trace.stage = "manual_stop";
  const data = await manualRpc(ctx, "coupang_rank_manual_stop", {
    p_claim_id: credentials.claimId,
    p_token_sha256: credentials.tokenSha256,
    p_requested_by: access.createdBy,
    p_code: reason,
    p_run_id: null,
  }, "manual_stop");
  if (!data) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  if (data.ok !== true) return manualFailure(request, data);
  const manual = manualPayload(data.manual);
  return respond(request, {
    ok: true,
    stopped: data.stopped === true,
    ...manualPauseFields(manual),
    blocksToday: finiteNumberOrNull(data.blocksToday),
    stoppedDay: data.stoppedDay ?? null,
    stopCode: data.stopCode ?? reason,
    manual,
  });
}

// ── GET ──────────────────────────────────────────────────────────────────

function setupRequiredBody(request, view) {
  if (view === "access") return accessView(request, null);
  if (view === "") {
    return {
      ok: true,
      setupRequired: true,
      trackers: [],
      returnedCount: 0,
      totalCount: 0,
      hasMore: false,
      complete: true,
      collector: { state: "setup_required" },
    };
  }
  return { ok: true, setupRequired: true };
}

async function listView(request, ctx, settings, access, now, trace) {
  const started = Date.now();
  trace.stage = "trackers";
  const result = await ctx.supabaseAdmin
    .from(TABLES.trackers)
    .select(TRACKER_COLUMNS, { count: "exact" })
    .eq("agency_code", access.agencyCode)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(TRACKER_LIST_FETCH_LIMIT);
  const rows = rowsOf(result, "trackers");
  const count = Number.isInteger(result.count) ? result.count : null;
  const shown = rows.slice(0, TRACKER_LIST_MAX);
  trace.stage = "details";
  const [assembled, manual] = await Promise.all([
    assembleTrackers(ctx, settings, access, shown, now, { includeLimit: access.role !== "client" }),
    manualAllowed(access) ? loadManualPayload(ctx, settings) : Promise.resolve(null),
  ]);
  const totalCount = count ?? rows.length;
  const hasMore = totalCount > TRACKER_LIST_MAX;
  const body = {
    ok: true,
    setupRequired: false,
    ...scopeFields(access),
    returnedCount: Math.min(TRACKER_LIST_MAX, rows.length),
    totalCount,
    hasMore,
    complete: count !== null && !hasMore && rows.length === count,
    todayKst: assembled.days30[0],
    days30: assembled.days30,
    limit: assembled.limit,
    collector: {
      state: assembled.state,
      lastSuccessAt: assembled.lastSuccessAt,
      checksPerDay: finiteNumberOrNull(settings.checks_per_day),
      activeFromHour: finiteNumberOrNull(settings.active_from_hour),
      activeToHour: finiteNumberOrNull(settings.active_to_hour),
      cooldownUntil: settings.cooldown_until ?? null,
    },
    trackers: assembled.trackers,
  };
  // ① 지금 확인 칸은 총관리자(MANUAL_ALLOWED_ROLES)에게만 싣는다. 운영팀·광고주 응답에는 키 자체가 없다.
  if (manual) body.manual = manual;
  const ms = Date.now() - started;
  if (ms > SLOW_LIST_MS) {
    console.warn(JSON.stringify({ event: "coupang_rank_trackers_list_slow", ms, count: rows.length }));
  }
  return respond(request, body);
}

async function runsView(request, ctx, access, url, now, trace) {
  const requested = url.searchParams.get("trackerId");
  if (!isUuid(requested)) return failure(request, "COUPANG_TRACKER_NOT_FOUND");
  const trackerId = requested.toLowerCase();
  trace.stage = "tracker";
  const tracker = await findTrackerById(ctx, access.agencyCode, trackerId, "id, keyword_key");
  if (!tracker) return failure(request, "COUPANG_TRACKER_NOT_FOUND");
  const days30 = kstDays30(now);
  trace.stage = "runs_view";
  const [snapshots, failures] = await Promise.all([
    ctx.supabaseAdmin
      .from(TABLES.snapshots)
      .select(SNAPSHOT_COLUMNS)
      .eq("tracker_id", trackerId)
      .gte("kst_day", days30[days30.length - 1])
      .order("checked_at", { ascending: false })
      .limit(SNAPSHOT_VIEW_LIMIT)
      .then((value) => rowsOf(value, "snapshots")),
    ctx.supabaseAdmin
      .from(TABLES.runs)
      .select("claimed_at, status, error_code, slot_index")
      .eq("keyword_key", tracker.keyword_key)
      .in("status", [...FAILURE_RUN_STATUSES])
      .gte("claimed_at", isoOf(now.getTime() - FAILURE_VIEW_DAYS * DAY_MS))
      .order("claimed_at", { ascending: false })
      .limit(FAILURE_VIEW_LIMIT)
      .then((value) => rowsOf(value, "failures")),
  ]);
  // 다른 계정의 상품번호·쪽 목록은 보내지 않는다(쪽 목록 열은 읽지도 않는다).
  return respond(request, {
    ok: true,
    trackerId,
    snapshots: snapshots.map((row) => ({
      checkedAt: row.checked_at ?? null,
      day: row.kst_day ? String(row.kst_day).slice(0, 10) : kstDayOf(row.checked_at),
      slot: finiteNumberOrNull(row.slot_index) ?? 0,
      result: row.result ?? null,
      rank: finiteNumberOrNull(row.rank),
      organicCount: finiteNumberOrNull(row.organic_count),
      organicSlot: finiteNumberOrNull(row.organic_slot),
      adOrder: finiteNumberOrNull(row.ad_order),
      sameOption: typeof row.same_option === "boolean" ? row.same_option : null,
    })),
    failures: failures.map((row) => ({
      claimedAt: row.claimed_at ?? null,
      status: row.status ?? null,
      errorCode: row.error_code ?? null,
      slot: finiteNumberOrNull(row.slot_index),
    })),
  });
}

function lastClaimReason(reply) {
  if (!plainObject(reply)) return null;
  const value = typeof reply.reason === "string" ? reply.reason : (typeof reply.state === "string" ? reply.state : "");
  return CLAIM_REASON_PATTERN.test(value) ? value : null;
}

async function loadCollectorPanelRows(ctx) {
  const rows = rowsOf(
    await ctx.supabaseAdmin
      .from(TABLES.collectors)
      .select(COLLECTOR_PANEL_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(100),
    "collectors_panel",
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label ?? DEFAULT_COLLECTOR_LABEL,
    tokenHint: row.token_hint ?? "",
    platform: row.platform ?? null,
    createdAt: row.created_at ?? null,
    revokedAt: row.revoked_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    lastVersion: row.last_version ?? null,
    lastNode: row.last_node ?? null,
    lastBrowser: row.last_browser ?? null,
    lastOs: row.last_os ?? null,
    lastGuard: row.last_guard ?? null,
    lastClaimAt: row.last_claim_at ?? null,
    lastClaimReason: lastClaimReason(row.last_claim_reply),
  }));
}

// 계정별 한도 표(§5.6 accountLimits). kind: owner → advertiser(clients) → team(팀 코드) → unknown('연결 없음').
async function loadAccountLimits(ctx) {
  const limitResult = await selectPages(() => ctx.supabaseAdmin
    .from(TABLES.limits)
    .select("agency_code, keyword_limit, updated_at")
    .order("agency_code", { ascending: true }));
  if (limitResult.error) throw dbError("account_limits", limitResult.error);
  const rows = limitResult.data || [];
  const codes = [...new Set(rows.map((row) => String(row.agency_code || "")).filter(Boolean))];
  const clientNames = new Map();
  const teamNames = new Map();
  if (codes.length) {
    const clientGroups = await mapLimit(chunk(codes, 100), READ_CONCURRENCY, async (group) => rowsOf(
      await ctx.supabaseAdmin.from("clients").select("agency_code, name").filter("agency_code", "in", inList(group)),
      "account_limit_clients",
    ));
    for (const client of clientGroups.flat()) {
      const code = canonicalAgencyCode(client.agency_code);
      if (code && !clientNames.has(code)) clientNames.set(code, String(client.name || code));
    }
    const teamResult = await selectPages(() => ctx.supabaseAdmin
      .from("operation_team_codes")
      .select("id, team_code, team_name")
      .order("id", { ascending: true }));
    if (teamResult.error) throw dbError("account_limit_teams", teamResult.error);
    for (const team of teamResult.data || []) {
      const code = canonicalAgencyCode(team.team_code);
      if (code && !teamNames.has(code)) teamNames.set(code, String(team.team_name || code));
    }
  }
  return rows.map((row) => {
    const agencyCode = String(row.agency_code || "");
    let kind = "unknown";
    let label = "연결 없음";
    if (agencyCode === PRIMARY_AGENCY_CODE) {
      kind = "owner";
      label = "총관리자";
    } else if (clientNames.has(agencyCode)) {
      kind = "advertiser";
      label = clientNames.get(agencyCode);
    } else if (teamNames.has(agencyCode)) {
      kind = "team";
      label = teamNames.get(agencyCode);
    }
    return { agencyCode, keywordLimit: finiteNumberOrNull(row.keyword_limit), kind, label };
  });
}

function currentRelease() {
  return safeRelease(String(process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7));
}

async function collectorView(request, ctx, settings, now, trace) {
  trace.stage = "collector_view";
  const [collectors, accountLimits, allStats] = await Promise.all([
    loadCollectorPanelRows(ctx),
    loadAccountLimits(ctx),
    loadStats(ctx),
  ]);
  // '48시간 성공'·'마지막 성공'·속도 올리기 가능 여부는 수집기 회차로만(수동 지금 확인 성공은 빼고) 보인다.
  const stats = await collectorOnlyStats(ctx, settings, allStats, now);
  const release = currentRelease();
  const raise = raiseStatus(settings, stats, now);
  return respond(request, {
    ok: true,
    release,
    bundleVersion: COLLECTOR_BUNDLE_VERSION,
    settings: settingsPayload(settings),
    collectors,
    accountLimits,
    stats,
    capacity: capacityOf(settings, stats.activeKeywords ?? null),
    raise: {
      allowed: raise.allowed,
      nextStep: raise.nextStep,
      reasons: raise.reasons,
      blocked48h: raise.blocked48h,
      empty48h: raise.empty48h,
      success48h: raise.success48h,
      hoursSinceRateChange: raise.hoursSinceRateChange,
    },
    oneLiners: collectorOneLiners(release),
  });
}

async function handleGet(request, ctx, url, view, now, trace) {
  if (!VIEWS.has(view)) return failure(request, "COUPANG_ACTION_INVALID");
  // 총관리자 전용(대표 결정 2026-10-23): 총관리자 세션이 아니면 설정을 읽기 전에 거절한다
  // (목록·기록·수집기·지금 확인, 메뉴 확인 view=access 까지 모두. 관리자 화면은 view=access 를 부르지 않는다).
  trace.stage = "access";
  const denial = ownerSessionDenial(request);
  if (denial) return failure(request, denial);
  trace.stage = "settings";
  const loaded = await loadSettings(ctx);
  if (loaded.setupRequired) {
    // 확장의 확인·중지는 '준비 안 됨'을 성공 모양(ok:true)으로 받으면 안 된다.
    if (MANUAL_VIEWS.has(view)) return failure(request, "COUPANG_SETUP_REQUIRED");
    return respond(request, setupRequiredBody(request, view));
  }
  const settings = loaded.settings;

  if (view === "access") {
    const result = accessView(request, settings);
    return result.ok ? respond(request, result) : failure(request, result.code);
  }

  trace.stage = "access";
  const resolved = await resolveCoupangAccess(request, ctx, {
    create: false,
    ownerOnly: view === "collector" || MANUAL_VIEWS.has(view),
  });
  if (!resolved.ok) return failure(request, resolved.code);
  const access = resolved.access;
  if (MANUAL_VIEWS.has(view)) {
    if (!manualAllowed(access)) return failure(request, "COUPANG_OWNER_ONLY");
    if (view === MANUAL_VERIFY_VIEW) return manualVerifyView(request, ctx, settings, access, url, trace);
    return manualStopView(request, ctx, settings, access, url, trace);
  }
  if (view === "collector") {
    if (access.owner !== true) return failure(request, "COUPANG_OWNER_ONLY");
    return collectorView(request, ctx, settings, now, trace);
  }
  if (view === "runs") return runsView(request, ctx, access, url, now, trace);
  return listView(request, ctx, settings, access, now, trace);
}

// ── POST ─────────────────────────────────────────────────────────────────

// 본문 상한: manual-record 만 64KB(상품 130개 × 한글 제목이면 32KB 를 넘을 수 있다), 나머지 동작은 32KB 그대로.
// 동작 이름은 본문 안에 있으므로 64KB 까지 읽고 해석한 뒤 동작별 상한을 다시 본다(선언 길이·실제 길이 모두).
async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MANUAL_RECORD_BODY_MAX_BYTES) return { ok: false, code: "BODY_TOO_LARGE" };
  const contentType = String(request.headers.get("content-type") || "").trim().toLowerCase();
  if (!contentType.startsWith("application/json")) return { ok: false, code: "COUPANG_ACTION_INVALID" };
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, code: "COUPANG_ACTION_INVALID" };
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MANUAL_RECORD_BODY_MAX_BYTES) return { ok: false, code: "BODY_TOO_LARGE" };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: bytes > TRACKERS_BODY_MAX_BYTES ? "BODY_TOO_LARGE" : "COUPANG_ACTION_INVALID" };
  }
  if (!plainObject(body)) return { ok: false, code: bytes > TRACKERS_BODY_MAX_BYTES ? "BODY_TOO_LARGE" : "COUPANG_ACTION_INVALID" };
  const limit = body.action === "manual-record" ? MANUAL_RECORD_BODY_MAX_BYTES : TRACKERS_BODY_MAX_BYTES;
  if ((Number.isFinite(declared) && declared > limit) || bytes > limit) return { ok: false, code: "BODY_TOO_LARGE" };
  return { ok: true, body };
}

// 한도 트리거(P0001): message 가 한도 코드면 { code, limit(details), count(hint) }.
function limitErrorOf(error) {
  if (!error || String(error.code || "") !== "P0001") return null;
  const code = String(error.message || "");
  if (!LIMIT_ERROR_CODES.has(code)) return null;
  return { code, limit: finiteNumberOrNull(error.details), count: finiteNumberOrNull(error.hint) };
}

async function afterActivate(ctx, trackerId) {
  const result = await ctx.supabaseAdmin.rpc("coupang_rank_after_activate", { p_tracker_id: trackerId });
  if (result.error) throw dbError("after_activate", result.error);
  return result.data?.firstCheck === "recorded" ? "recorded" : "queued";
}

async function nextSortOrder(ctx, agencyCode) {
  const rows = rowsOf(
    await ctx.supabaseAdmin
      .from(TABLES.trackers)
      .select("sort_order")
      .eq("agency_code", agencyCode)
      .order("sort_order", { ascending: false })
      .limit(1),
    "sort_order",
  );
  const max = finiteNumberOrNull(rows[0]?.sort_order);
  return max === null ? 100 : Math.trunc(max) + 100;
}

async function alreadyTrackingResponse(request, ctx, settings, access, trackerId, now) {
  const { tracker, limit } = await trackerWithLimit(ctx, settings, access, trackerId, now);
  return respond(request, { ok: true, alreadyTracking: true, tracker, limit });
}

async function createAction(request, ctx, settings, access, body, now, trace) {
  const keyword = normalizeCoupangKeyword(body.keyword);
  if (!keyword.ok) return failure(request, keyword.code);
  const product = parseCoupangProductInput(body.productUrl);
  if (!product.ok) return failure(request, product.code);
  const groupProvided = body.groupName !== undefined && body.groupName !== null;
  const group = normalizeCoupangGroupName(body.groupName);
  if (!group.ok) return failure(request, group.code);
  const keywordKey = coupangKeywordKey(keyword.value);

  // 같은 범위·같은 (키워드 열쇠, 상품번호). 옵션(vendorItemId)만 다르면 같은 상품이라 중복이다.
  trace.stage = "existing";
  const existing = await findTrackerByProduct(ctx, access.agencyCode, keywordKey, product.productId);
  if (existing && existing.status === "active") {
    trace.stage = "reload";
    return alreadyTrackingResponse(request, ctx, settings, access, existing.id, now);
  }
  if (existing) {
    trace.stage = "reactivate";
    const patch = { status: "active", paused_at: null };
    if (groupProvided) patch.group_name = group.value;
    const updated = await ctx.supabaseAdmin
      .from(TABLES.trackers)
      .update(patch)
      .eq("id", existing.id)
      .eq("agency_code", access.agencyCode)
      .eq("status", "paused")
      .select("id");
    if (updated.error) {
      const limitError = limitErrorOf(updated.error);
      if (limitError) return failure(request, limitError.code, { limit: limitError.limit, count: limitError.count });
      throw dbError("reactivate", updated.error);
    }
    if (!Array.isArray(updated.data) || !updated.data.length) {
      // 다른 요청이 먼저 다시 시작했다.
      trace.stage = "reload";
      return alreadyTrackingResponse(request, ctx, settings, access, existing.id, now);
    }
    trace.stage = "after_activate";
    const firstCheck = await afterActivate(ctx, existing.id);
    trace.stage = "reload";
    const { tracker, limit } = await trackerWithLimit(ctx, settings, access, existing.id, now);
    return respond(request, { ok: true, resumed: true, tracker, firstCheck, limit });
  }

  trace.stage = "limit_status";
  const status = await loadLimitStatus(ctx, access.agencyCode, keywordKey);
  const used = finiteNumberOrNull(status.used) ?? 0;
  const max = finiteNumberOrNull(status.limit) ?? 0;
  if (used >= max) return failure(request, "COUPANG_KEYWORD_LIMIT_REACHED", { limit: max, count: used });
  const globalUsed = finiteNumberOrNull(status.globalUsed) ?? 0;
  const globalMax = finiteNumberOrNull(status.globalLimit) ?? 0;
  if (status.keywordActive !== true && globalUsed >= globalMax) {
    return failure(request, "COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED", { limit: globalMax, count: globalUsed });
  }

  trace.stage = "sort_order";
  const sortOrder = await nextSortOrder(ctx, access.agencyCode);
  trace.stage = "insert";
  const inserted = await ctx.supabaseAdmin
    .from(TABLES.trackers)
    .insert({
      agency_code: access.agencyCode,
      client_id: access.clientId || null,
      keyword: keyword.value,
      keyword_key: keywordKey,
      product_id: product.productId,
      product_url: product.productUrl,
      vendor_item_id: product.vendorItemId,
      group_name: group.value,
      sort_order: sortOrder,
      created_by: access.createdBy,
    })
    .select("id")
    .single();
  if (inserted.error) {
    const limitError = limitErrorOf(inserted.error);
    if (limitError) return failure(request, limitError.code, { limit: limitError.limit, count: limitError.count });
    if (String(inserted.error.code || "") === "23505") {
      trace.stage = "existing_race";
      const raced = await findTrackerByProduct(ctx, access.agencyCode, keywordKey, product.productId);
      if (raced) return alreadyTrackingResponse(request, ctx, settings, access, raced.id, now);
    }
    throw dbError("insert", inserted.error);
  }
  const trackerId = inserted.data?.id;
  if (!trackerId) throw dbError("insert", { code: "INSERT_ID_MISSING" });
  trace.stage = "after_activate";
  const firstCheck = await afterActivate(ctx, trackerId);
  trace.stage = "reload";
  const { tracker, limit } = await trackerWithLimit(ctx, settings, access, trackerId, now);
  return respond(request, { ok: true, tracker, firstCheck, limit });
}

async function pauseAction(request, ctx, access, body, now, trace) {
  const parsed = parseIdList(body);
  if (!parsed.ok) return failure(request, parsed.code);
  trace.stage = "pause";
  const rows = rowsOf(
    await ctx.supabaseAdmin
      .from(TABLES.trackers)
      .update({ status: "paused", paused_at: now.toISOString() })
      .eq("agency_code", access.agencyCode)
      .in("id", parsed.ids)
      .eq("status", "active")
      .select("id"),
    "pause",
  );
  return respond(request, { ok: true, updated: rows.length });
}

async function resumeAction(request, ctx, access, body, trace) {
  const parsed = parseIdList(body);
  if (!parsed.ok) return failure(request, parsed.code);
  let updated = 0;
  for (const id of parsed.ids) {
    trace.stage = "resume";
    const result = await ctx.supabaseAdmin
      .from(TABLES.trackers)
      .update({ status: "active", paused_at: null })
      .eq("agency_code", access.agencyCode)
      .eq("id", id)
      .eq("status", "paused")
      .select("id");
    if (result.error) {
      const limitError = limitErrorOf(result.error);
      if (limitError) {
        // 그 자리에서 멈춘다. 앞의 것은 이미 다시 시작된 상태다.
        return respond(request, {
          ok: true,
          updated,
          stoppedAt: { id, code: limitError.code, limit: limitError.limit, count: limitError.count },
        });
      }
      throw dbError("resume", result.error);
    }
    if (!Array.isArray(result.data) || !result.data.length) continue;
    trace.stage = "after_activate";
    await afterActivate(ctx, id);
    updated += 1;
  }
  return respond(request, { ok: true, updated });
}

async function deleteAction(request, ctx, access, body, trace) {
  const parsed = parseIdList(body);
  if (!parsed.ok) return failure(request, parsed.code);
  trace.stage = "delete";
  // 완전 삭제. 스냅샷·일별 칸은 FK cascade 로 함께 지워지고, 키워드 행은 남아 40일 뒤 정리된다.
  const rows = rowsOf(
    await ctx.supabaseAdmin
      .from(TABLES.trackers)
      .delete()
      .eq("agency_code", access.agencyCode)
      .in("id", parsed.ids)
      .select("id"),
    "delete",
  );
  return respond(request, { ok: true, deleted: rows.length });
}

async function groupAction(request, ctx, access, body, trace) {
  const parsed = parseIdList(body);
  if (!parsed.ok) return failure(request, parsed.code);
  const group = normalizeCoupangGroupName(body.groupName);
  if (!group.ok) return failure(request, group.code);
  trace.stage = "group";
  const rows = rowsOf(
    await ctx.supabaseAdmin
      .from(TABLES.trackers)
      .update({ group_name: group.value })
      .eq("agency_code", access.agencyCode)
      .in("id", parsed.ids)
      .select("id"),
    "group",
  );
  return respond(request, { ok: true, updated: rows.length });
}

async function updateSettingsRow(ctx, patch, stage) {
  const result = await ctx.supabaseAdmin
    .from(TABLES.settings)
    .update({ ...patch, updated_by: "owner" })
    .eq("id", 1)
    .select("*")
    .maybeSingle();
  if (result.error) throw dbError(stage, result.error);
  if (!plainObject(result.data)) throw new SetupMissingError(stage);
  return result.data;
}

// 조건부 설정 갱신: guard 가 거는 조건(예: 자동 수집 꺼짐)이 쓰는 순간에도 맞을 때만 쓴다. 맞는 행이 없으면 null.
// PostgreSQL 은 같은 행의 UPDATE 를 줄 세우고, 뒤에 선 UPDATE 는 앞 갱신이 끝난 행으로 WHERE 를 다시 본다(READ COMMITTED).
// 그래서 같은 순간 온 '지금 확인 켜기'와 '수집 켜기'는 각자 읽은 설정으로 판정해도 둘 중 하나만 저장된다(2026-10-23 재검사).
async function updateSettingsRowWhere(ctx, patch, stage, guard) {
  const result = await guard(ctx.supabaseAdmin
    .from(TABLES.settings)
    .update({ ...patch, updated_by: "owner" })
    .eq("id", 1))
    .select("*")
    .maybeSingle();
  if (result.error) throw dbError(stage, result.error);
  return plainObject(result.data) ? result.data : null;
}

// 조건부 갱신이 0행이면 설정을 다시 읽는다: 행이 없으면 예전처럼 준비 안 됨, 있으면 그 사이 바뀐 설정 = 409.
async function reloadSettingsAfterRace(ctx, stage) {
  const loaded = await loadSettings(ctx);
  if (loaded.setupRequired || !plainObject(loaded.settings)) throw new SetupMissingError(stage);
  return loaded.settings;
}

async function settingsUpdateAction(request, ctx, settings, body, now, trace) {
  const patch = body.settings;
  if (!plainObject(patch)) return failure(request, "COUPANG_SETTINGS_INVALID", { field: "settings" });
  // ① 지금 확인 켜기·끄기는 수동 칸(대표 SQL 20261018090000)이 있어야 저장된다.
  if (Object.hasOwn(patch, "manualEnabled") && !hasManualColumns(settings)) {
    return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  }
  // 자동 수집이 켜져 있으면 지금 확인을 켜지 않는다(아래 manualAutoConflict 설명). 끄기는 언제나 된다.
  if (patch.manualEnabled === true && settings.enabled === true) {
    return failure(request, "COUPANG_MANUAL_COLLECTOR_CONFLICT", { reason: "collector_enabled" });
  }
  const confirmRaise = body.confirmRaise === true;
  let stats = null;
  // 내리기만 하는 변경은 집계를 읽지 않고 바로 저장한다(집계가 느리거나 실패해도 비상 감속이 막히지 않게).
  // 올리기 관문의 '48시간 성공'은 수집기 회차만 센다(수동 지금 확인 성공이 자동 속도의 증거가 되지 않게).
  if (confirmRaise && isRaisingPatch(patch, settings)) {
    trace.stage = "stats";
    stats = await collectorOnlyStats(ctx, settings, await loadStats(ctx), now);
  }
  const checked = validateSettingsPatch(patch, settings, stats, now, confirmRaise);
  if (!checked.ok) {
    const { ok: _ok, status: _status, code, ...extra } = checked;
    return failure(request, code, extra);
  }
  trace.stage = "settings_update";
  let saved;
  if (checked.update.manual_enabled === true) {
    // 지금 확인 켜기: 위에서 읽은 뒤 '수집 켜기'가 먼저 저장됐을 수 있어, 자동 수집이 꺼져 있을 때만 쓴다(갱신 0행 = 409).
    saved = await updateSettingsRowWhere(ctx, checked.update, "settings_update", (query) => query.eq("enabled", false));
    if (!saved) {
      await reloadSettingsAfterRace(ctx, "settings_update");
      return failure(request, "COUPANG_MANUAL_COLLECTOR_CONFLICT", { reason: "collector_enabled" });
    }
  } else {
    saved = await updateSettingsRow(ctx, checked.update, "settings_update");
  }
  let replanned = 0;
  if (checked.replan) {
    trace.stage = "replan";
    const result = await ctx.supabaseAdmin.rpc("coupang_rank_replan_all");
    if (result.error) throw dbError("replan", result.error);
    replanned = finiteNumberOrNull(result.data) ?? 0;
  }
  return respond(request, { ok: true, settings: settingsPayload(saved), replanned });
}

// ① 지금 확인 ↔ 자동 수집: 자동 claim(C 원문 coupang_rank_claim)은 아직 수동 간격(manual_last_search_at)·수동 쉼·그날 중지
// (manual_paused_until·manual_stopped_day)를 보지 않는다(자동 재개 묶음에서 SQL 로 양방향 관문을 넣을 때까지). 그 전까지 같은 회선에서
// 둘이 함께 돌지 않게 자동 수집 켜기를 거절한다: 지금 확인이 켜져 있거나, 오늘(KST) 지금 확인이 차단으로 멈춘 날이거나,
// 차단 뒤 30분 쉬는 중(c30-4 칸이 있을 때만). 끄기는 언제나 된다.
const MANUAL_PAUSE_COLUMN = "manual_paused_until";

function manualPausedAt(settings, now) {
  if (!plainObject(settings) || !Object.hasOwn(settings, MANUAL_PAUSE_COLUMN)) return false;
  const until = Date.parse(String(settings[MANUAL_PAUSE_COLUMN] || ""));
  return Number.isFinite(until) && until > now.getTime();
}

function manualAutoConflict(settings, now) {
  if (!hasManualColumns(settings)) return null;
  if (settings.manual_enabled === true) return "manual_enabled";
  const stoppedDay = typeof settings.manual_stopped_day === "string" ? settings.manual_stopped_day.slice(0, 10) : "";
  if (stoppedDay && stoppedDay === kstDayOf(now)) return "manual_stopped_today";
  if (manualPausedAt(settings, now)) return "manual_paused";
  return null;
}

// 수집 켜기의 조건부 쓰기: '지금 확인 꺼짐' 이고 (그날 중지 기록 없음 또는 그날 중지가 오늘 아님)
// 이고 (c30-4 칸이 있으면) (쉼 기록 없음 또는 쉼이 끝남)일 때만. '또는' 을 조건부 갱신 여러 번으로 나눈다
// (각 갱신이 쓰는 순간 조건 전체를 다시 보므로 어느 쪽이 통과해도 안전하다).
async function enableCollectorIfNoManual(ctx, now, stage, withPause) {
  const today = kstDayOf(now);
  const stopGuards = [
    (query) => query.is("manual_stopped_day", null),
    (query) => query.neq("manual_stopped_day", today),
  ];
  const pauseGuards = withPause
    ? [(query) => query.is(MANUAL_PAUSE_COLUMN, null), (query) => query.lte(MANUAL_PAUSE_COLUMN, now.toISOString())]
    : [(query) => query];
  for (const stopGuard of stopGuards) {
    for (const pauseGuard of pauseGuards) {
      const saved = await updateSettingsRowWhere(ctx, { enabled: true }, stage,
        (query) => pauseGuard(stopGuard(query.eq("manual_enabled", false))));
      if (saved) return saved;
    }
  }
  return null;
}

async function collectorEnableAction(request, ctx, settings, enable, now, trace) {
  if (enable) {
    const conflict = manualAutoConflict(settings, now);
    if (conflict) return failure(request, "COUPANG_COLLECTOR_MANUAL_CONFLICT", { reason: conflict });
    trace.stage = "collectors_count";
    if ((await countActiveCollectors(ctx)) < 1) return failure(request, "COUPANG_NO_COLLECTOR");
  }
  trace.stage = enable ? "enable" : "disable";
  // 수동 칸이 있으면(대표 SQL 뒤) 위에서 읽은 뒤 '지금 확인 켜기'·그날 중지가 먼저 저장됐을 수 있어 조건부로 쓴다(갱신 0행 = 409).
  if (enable && hasManualColumns(settings)) {
    const saved = await enableCollectorIfNoManual(ctx, now, trace.stage, Object.hasOwn(settings, MANUAL_PAUSE_COLUMN));
    if (saved) return respond(request, { ok: true, settings: settingsPayload(saved) });
    const reloaded = await reloadSettingsAfterRace(ctx, trace.stage);
    return failure(request, "COUPANG_COLLECTOR_MANUAL_CONFLICT", { reason: manualAutoConflict(reloaded, now) || "settings_changed" });
  }
  const saved = await updateSettingsRow(ctx, { enabled: enable }, trace.stage);
  return respond(request, { ok: true, settings: settingsPayload(saved) });
}

async function cooldownClearAction(request, ctx, now, trace) {
  trace.stage = "cooldown_clear";
  const saved = await updateSettingsRow(ctx, {
    cooldown_until: null,
    cooldown_reason: null,
    needs_owner_review: false,
    review_reason: null,
    budget_blocked: false,
    budget_reason: null,
    error_streak: 0,
    empty_streak: 0,
  }, "cooldown_clear");
  // 7일 차단 횟수(쉬기 기록)는 지우지 않는다. 열린 쉬기에 해제 표시만 남긴다.
  trace.stage = "cooldown_rows";
  rowsOf(
    await ctx.supabaseAdmin
      .from(TABLES.cooldowns)
      .update({ cleared_at: now.toISOString(), cleared_by: "owner" })
      .is("cleared_at", null)
      .select("id"),
    "cooldown_rows",
  );
  return respond(request, { ok: true, settings: settingsPayload(saved) });
}

function limitValueOf(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && INTEGER_TEXT_PATTERN.test(value.trim())) return Number(value.trim());
  return Number.NaN;
}

async function accountLimitSetAction(request, ctx, body, trace) {
  const agencyCode = canonicalAgencyCode(typeof body.agencyCode === "string" ? body.agencyCode : "");
  if (!LIMIT_AGENCY_CODE_PATTERN.test(agencyCode)) return failure(request, "COUPANG_LIMIT_INVALID");
  if (!Object.hasOwn(body, "keywordLimit")) return failure(request, "COUPANG_LIMIT_INVALID");
  trace.stage = "account_limit";
  if (body.keywordLimit === null) {
    rowsOf(
      await ctx.supabaseAdmin.from(TABLES.limits).delete().eq("agency_code", agencyCode).select("agency_code"),
      "account_limit",
    );
  } else {
    const keywordLimit = limitValueOf(body.keywordLimit);
    if (!Number.isInteger(keywordLimit) || keywordLimit < 0 || keywordLimit > 1000) {
      return failure(request, "COUPANG_LIMIT_INVALID");
    }
    rowsOf(
      await ctx.supabaseAdmin
        .from(TABLES.limits)
        .upsert({ agency_code: agencyCode, keyword_limit: keywordLimit, updated_by: "owner" }, { onConflict: "agency_code" })
        .select("agency_code"),
      "account_limit",
    );
  }
  trace.stage = "account_limits";
  return respond(request, { ok: true, accountLimits: await loadAccountLimits(ctx) });
}

function collectorLabelOf(value) {
  if (value === undefined || value === null) return { ok: true, value: DEFAULT_COLLECTOR_LABEL };
  if (typeof value !== "string") return { ok: false };
  if (typeof value.isWellFormed === "function" && !value.isWellFormed()) return { ok: false };
  const label = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!label) return { ok: true, value: DEFAULT_COLLECTOR_LABEL };
  if (Array.from(label).length > COLLECTOR_LABEL_MAX || /[\u0000-\u001f\u007f]/u.test(label)) return { ok: false };
  return { ok: true, value: label };
}

async function collectorTokenCreateAction(request, ctx, body, trace) {
  const label = collectorLabelOf(body.label);
  if (!label.ok) return failure(request, "COUPANG_COLLECTOR_LABEL_INVALID");
  trace.stage = "collectors_count";
  // 기존 코드는 폐기하지 않는다(맥 미니로 옮길 때 두 대를 겹쳐 운영).
  if ((await countActiveCollectors(ctx)) >= MAX_ACTIVE_COLLECTORS) return failure(request, "COUPANG_COLLECTOR_LIMIT");
  const generated = generateCollectorToken();
  trace.stage = "collector_insert";
  const result = await ctx.supabaseAdmin
    .from(TABLES.collectors)
    .insert({
      label: label.value,
      token_sha256: generated.tokenSha256,
      token_hint: generated.tokenHint,
      created_by: "owner",
    })
    .select("id, label, token_hint")
    .single();
  if (result.error) throw dbError("collector_insert", result.error);
  // 원문은 이 응답에 한 번만 담긴다(저장하지 않는다).
  return respond(request, {
    ok: true,
    id: result.data?.id ?? null,
    label: result.data?.label ?? label.value,
    token: generated.token,
    tokenHint: generated.tokenHint,
  });
}

async function collectorTokenRevokeAction(request, ctx, body, now, trace) {
  if (!isUuid(body.id)) return failure(request, "COUPANG_COLLECTOR_NOT_FOUND");
  const id = body.id.toLowerCase();
  trace.stage = "collector_revoke";
  const rows = rowsOf(
    await ctx.supabaseAdmin
      .from(TABLES.collectors)
      .update({ revoked_at: now.toISOString() })
      .eq("id", id)
      .is("revoked_at", null)
      .select("id, revoked_at"),
    "collector_revoke",
  );
  if (rows.length) return respond(request, { ok: true, revokedAt: rows[0].revoked_at ?? now.toISOString() });
  const existing = await ctx.supabaseAdmin.from(TABLES.collectors).select("id, revoked_at").eq("id", id).maybeSingle();
  if (existing.error) throw dbError("collector_revoke", existing.error);
  if (!existing.data) return failure(request, "COUPANG_COLLECTOR_NOT_FOUND");
  return respond(request, { ok: true, revokedAt: existing.data.revoked_at ?? null });
}

// ── ① 지금 확인 POST ──────────────────────────────────────────────────────

// 보관 기간 정리·예산 검사: 자동 수집이 꺼져 있어도 돌도록 claim 앞에서 6시간에 한 번(수집기 hello 와 같은 규칙).
// 실패는 기록만 하고 claim 은 그대로 진행한다.
async function maybeManualHousekeeping(ctx, settings, now, trace) {
  const lastMs = Date.parse(String(settings?.last_housekeeping_at || ""));
  if (Number.isFinite(lastMs) && now.getTime() - lastMs < MANUAL_HOUSEKEEPING_INTERVAL_MS) return false;
  trace.stage = "manual_housekeeping";
  try {
    const result = await ctx.supabaseAdmin.rpc("coupang_rank_housekeeping");
    if (result?.error) throw result.error;
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "coupang_rank_trackers_housekeeping_failed",
      errorCode: String(error?.code || ""),
    }));
    return false;
  }
}

// POST manual-claim {trackerId}: 화면이 '지금 확인'을 누를 때 1회용 요청을 받는다(검색은 아직 없음).
// 원문 토큰은 이 응답에만 싣고(화면 → 확장), DB 에는 sha256 만 남긴다.
async function manualClaimAction(request, ctx, settings, access, body, now, trace) {
  if (!hasManualColumns(settings)) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  if (!isUuid(body.trackerId)) return failure(request, "COUPANG_TRACKER_NOT_FOUND");
  const trackerId = body.trackerId.toLowerCase();
  await maybeManualHousekeeping(ctx, settings, now, trace);
  const generated = generateManualClaimToken();
  trace.stage = "manual_claim";
  const data = await manualRpc(ctx, "coupang_rank_manual_claim", {
    p_tracker_id: trackerId,
    p_agency_code: access.agencyCode,
    p_requested_by: access.createdBy,
    p_requested_role: access.role,
    p_token_sha256: generated.tokenSha256,
  }, "manual_claim");
  if (!data) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  if (data.ok !== true) return manualFailure(request, data);
  return respond(request, {
    ok: true,
    claimId: data.claimId ?? null,
    claimToken: generated.token,
    keyword: data.keyword ?? null,
    keywordKey: data.keywordKey ?? null,
    expiresAt: data.expiresAt ?? null,
    expiresInSeconds: MANUAL_CLAIM_TTL_SECONDS,
    serverTime: data.serverTime ?? null,
    manual: manualPayload(data.manual),
  });
}

// 확장 1.0.1 실패 진단 저장(기록 RPC 가 성공한 뒤, 따로). 그 요청의 회차(claims.run_id)에 diagnostics 가 비어 있을 때만 쓴다
// (같은 보고를 다시 보내도 덮어쓰지 않음). 칸이 없으면(대표 SQL c30-3 전: 42703·PGRST204) 조용히 건너뛰고, 그 밖의 오류도
// 기록만 남긴다 — 어떤 경우에도 순위 기록 결과·응답은 그대로다.
const DIAGNOSTICS_MISSING_CODES = new Set(["42703", "PGRST204"]);

function noteDiagnosticsFailure(error) {
  const code = String(error?.code || "");
  if (DIAGNOSTICS_MISSING_CODES.has(code) || isSetupMissing(error)) return false;
  console.warn(JSON.stringify({ event: "coupang_rank_trackers_manual_diagnostics_failed", errorCode: code }));
  return false;
}

async function saveManualDiagnostics(ctx, claimId, diagnostics) {
  try {
    const claimRow = await ctx.supabaseAdmin
      .from(TABLES.manualClaims)
      .select("run_id")
      .eq("id", claimId)
      .maybeSingle();
    if (claimRow.error) return noteDiagnosticsFailure(claimRow.error);
    const runId = claimRow.data?.run_id;
    if (!isUuid(runId)) return false;
    const updated = await ctx.supabaseAdmin
      .from(TABLES.runs)
      .update({ diagnostics })
      .eq("id", runId)
      .eq("source", "manual")
      .is("diagnostics", null);
    if (updated.error) return noteDiagnosticsFailure(updated.error);
    return true;
  } catch (error) {
    return noteDiagnosticsFailure(error);
  }
}

// 진단 저장을 기다리는 상한(1.0.1 검토 반영). 순위 기록은 이미 끝난 뒤라 DB 가 멈춰도 응답을 늦추지 않는다: 넘으면 경고 1줄
// (errorCode "timeout")만 남기고 응답한다. 저장은 뒤에서 끝날 수도 있고, 화면이 다시 보내면(중복 처리) 그때 채워진다.
// ctx.manualDiagnosticsTimeoutMs 는 시험용(양수일 때만).
const DIAGNOSTICS_SAVE_TIMEOUT_MS = 2500;

async function saveManualDiagnosticsWithin(ctx, claimId, diagnostics) {
  const override = ctx?.manualDiagnosticsTimeoutMs;
  const limit = Number.isFinite(override) && override > 0 ? override : DIAGNOSTICS_SAVE_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), limit); });
  try {
    const saved = await Promise.race([saveManualDiagnostics(ctx, claimId, diagnostics), timeout]);
    return saved === "timeout" ? noteDiagnosticsFailure({ code: "timeout" }) : saved;
  } finally {
    clearTimeout(timer);
  }
}

function manualRecordInvalid(request, field, extra = {}) {
  return failure(request, "COUPANG_MANUAL_RECORD_INVALID", { field, ...extra });
}

// POST manual-record: 화면이 확장의 답을 그대로 보낸다. 판정은 서버가 한다(page-result 규칙 + M1 + M2).
// 저장은 SQL 이 하고, 확장 확인을 받지 않은 요청의 측정 결과는 받지 않는다(꾸민 결과 막기).
// 차단 신호는 모양이 틀린 본문이어도, 요청이 끝났거나 늦었어도 차단으로 알린다(30분 쉼·그날 중지 — 더 엄격하게만 바뀐다).
async function manualRecordAction(request, ctx, settings, access, body, trace) {
  if (!hasManualColumns(settings)) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  if (!isUuid(body.claimId)) return manualRecordInvalid(request, "claimId");
  if (!isManualToken(body.claimToken)) return manualRecordInvalid(request, "claimToken");
  if (!MANUAL_OUTCOMES.includes(body.outcome)) return manualRecordInvalid(request, "outcome");
  const outcomeCode = body.outcomeCode === undefined ? null : body.outcomeCode;
  if (outcomeCode !== null && (typeof outcomeCode !== "string" || !COLLECTOR_ERROR_CODE_PATTERN.test(outcomeCode))) {
    return manualRecordInvalid(request, "outcomeCode");
  }
  const claimId = body.claimId.toLowerCase();
  const tokenSha256 = manualTokenHash(body.claimToken);
  const measured = body.outcome === "measured";

  if (measured) {
    const checked = validateManualRecord(body);
    if (!checked.ok) {
      const stopCode = manualStopSignal(body.page);
      if (!stopCode) return manualRecordInvalid(request, checked.field);
      trace.stage = "manual_stop";
      const stopped = await manualRpc(ctx, "coupang_rank_manual_stop", {
        p_claim_id: claimId,
        p_token_sha256: tokenSha256,
        p_requested_by: access.createdBy,
        p_code: stopCode,
        p_run_id: null,
      }, "manual_stop");
      if (!stopped) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
      const stoppedManual = stopped.ok === true ? manualPayload(stopped.manual) : null;
      return manualRecordInvalid(request, checked.field, {
        stopped: stopped.ok === true && stopped.stopped === true,
        ...(stoppedManual ? { ...manualPauseFields(stoppedManual), stopCode, manual: stoppedManual } : {}),
      });
    }
  }

  trace.stage = "manual_claim_row";
  const claimResult = await ctx.supabaseAdmin
    .from(TABLES.manualClaims)
    .select("id, keyword_key, status")
    .eq("id", claimId)
    .maybeSingle();
  if (claimResult.error) {
    if (isSetupMissing(claimResult.error)) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
    throw dbError("manual_claim_row", claimResult.error);
  }
  const claim = claimResult.data;
  if (!plainObject(claim)) return failure(request, "COUPANG_MANUAL_CLAIM_NOT_FOUND");

  let status = null;
  let run = null;
  let stopCode;
  if (measured) {
    const page = sanitizeTitles(body.page);
    const final = finalManualStatus(classifyManualPage(page), page, claim);
    status = final.status;
    run = recordPayloadForRpc({ ...body, page, collectorVersion: body.extensionVersion }, final);
    // 측정 중 쿼리만 바뀐 이동(user_navigated)이면 바뀐 쿼리 이름(값 없음)을 그 회차 final_path 에 남긴다(기존 칸, 마이그레이션 없음).
    run.finalPath = manualNavigatedFinalPath(page, run.errorCode);
    stopCode = manualRecordStopCode("measured", outcomeCode, page);
  } else {
    stopCode = manualRecordStopCode(body.outcome, outcomeCode, null);
  }
  trace.stage = "manual_record";
  const data = await manualRpc(ctx, "coupang_rank_manual_record", {
    p_claim_id: claimId,
    p_token_sha256: tokenSha256,
    p_requested_by: access.createdBy,
    p_outcome: body.outcome,
    p_outcome_code: outcomeCode,
    p_status: status,
    p_run: run,
    p_stop_code: stopCode,
  }, "manual_record");
  if (!data) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
  if (data.ok !== true) return manualFailure(request, data);
  // 확장 1.0.1 진단: 모양·크기를 통과한 것만, 저장한(또는 이미 저장된) 측정 회차에만 따로 남긴다(실패해도 응답 그대로).
  const diagnostics = measured ? manualDiagnostics(body) : null;
  if (diagnostics && (data.accepted === true || data.duplicate === true)) await saveManualDiagnosticsWithin(ctx, claimId, diagnostics);
  const manual = manualPayload(data.manual);
  return respond(request, {
    ok: true,
    accepted: data.accepted === true,
    duplicate: data.duplicate === true,
    outcome: body.outcome,
    status: data.status ?? null,
    errorCode: data.errorCode ?? null,
    matched: finiteNumberOrNull(data.matched) ?? 0,
    counted: data.counted === true,
    stopped: data.stopped === true,
    // 차단 뒤 30분 쉼(c30-4): SQL 요약에 쉼 끝 시각이 있으면 쉬는 중. SQL 전에는 늘 false(차단이면 stopped).
    ...manualPauseFields(manual),
    stopCode: data.stopCode ?? null,
    late: data.late === true,
    tracker: plainObject(data.tracker) ? data.tracker : null,
    manual,
  });
}

async function handlePost(request, ctx, now, trace) {
  // 총관리자 전용(대표 결정 2026-10-23): 총관리자 세션이 아니면 본문을 읽기 전에 거절한다(등록·중지·지금 확인 등 모든 동작).
  trace.stage = "access";
  const denial = ownerSessionDenial(request);
  if (denial) return failure(request, denial);
  trace.stage = "body";
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return failure(request, parsed.code);
  const body = parsed.body;
  const action = typeof body.action === "string" ? body.action : "";
  if (!SCOPED_ACTIONS.has(action) && !OWNER_ACTIONS.has(action) && !MANUAL_ACTIONS.has(action)) {
    return failure(request, "COUPANG_ACTION_INVALID");
  }
  trace.action = action;

  trace.stage = "settings";
  const loaded = await loadSettings(ctx);
  if (loaded.setupRequired) return failure(request, "COUPANG_SETUP_REQUIRED");
  const settings = loaded.settings;

  trace.stage = "access";
  const ownerOnly = OWNER_ACTIONS.has(action) || action === "manual-record";
  const resolved = await resolveCoupangAccess(request, ctx, {
    create: CREATE_ACTIONS.has(action),
    ownerOnly,
  });
  if (!resolved.ok) return failure(request, resolved.code);
  const access = resolved.access;
  if (ownerOnly && access.owner !== true) return failure(request, "COUPANG_OWNER_ONLY");
  if (MANUAL_ACTIONS.has(action) && !manualAllowed(access)) return failure(request, "COUPANG_OWNER_ONLY");

  switch (action) {
    case "create":
      return createAction(request, ctx, settings, access, body, now, trace);
    case "pause":
      return pauseAction(request, ctx, access, body, now, trace);
    case "resume":
      return resumeAction(request, ctx, access, body, trace);
    case "delete":
      return deleteAction(request, ctx, access, body, trace);
    case "group":
      return groupAction(request, ctx, access, body, trace);
    case "settings-update":
      return settingsUpdateAction(request, ctx, settings, body, now, trace);
    case "collector-enable":
      return collectorEnableAction(request, ctx, settings, true, now, trace);
    case "collector-disable":
      return collectorEnableAction(request, ctx, settings, false, now, trace);
    case "cooldown-clear":
      return cooldownClearAction(request, ctx, now, trace);
    case "account-limit-set":
      return accountLimitSetAction(request, ctx, body, trace);
    case "collector-token-create":
      return collectorTokenCreateAction(request, ctx, body, trace);
    case "collector-token-revoke":
      return collectorTokenRevokeAction(request, ctx, body, now, trace);
    case "manual-claim":
      return manualClaimAction(request, ctx, settings, access, body, now, trace);
    case "manual-record":
      return manualRecordAction(request, ctx, settings, access, body, trace);
    default:
      return failure(request, "COUPANG_ACTION_INVALID");
  }
}

// ── 입구 ─────────────────────────────────────────────────────────────────

// options.now 는 테스트용 고정 시각(운영에서는 비어 있어 서버 시계를 쓴다).
export async function handleCoupangRankTrackersRequest(request, ctx, options = {}) {
  const method = String(request?.method || "").toUpperCase();
  const url = new URL(request.url);
  const view = method === "GET" ? String(url.searchParams.get("view") || "") : "";
  const trace = { action: "", view: VIEWS.has(view) ? view : "", stage: "start" };
  const nowMs = options && options.now !== undefined ? new Date(options.now).getTime() : Date.now();
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  try {
    if (method === "GET") return await handleGet(request, ctx, url, view, now, trace);
    if (method === "POST") return await handlePost(request, ctx, now, trace);
    return failure(request, "METHOD_NOT_ALLOWED");
  } catch (error) {
    if (error instanceof SetupMissingError || isSetupMissing(error)) {
      if (MANUAL_VIEWS.has(trace.view) || MANUAL_ACTIONS.has(trace.action)) return failure(request, "COUPANG_MANUAL_SETUP_REQUIRED");
      if (method === "GET") return respond(request, setupRequiredBody(request, trace.view));
      return failure(request, "COUPANG_SETUP_REQUIRED");
    }
    console.error(JSON.stringify({
      event: "coupang_rank_trackers_failed",
      requestId: requestIdFor(request),
      method,
      action: trace.action,
      view: trace.view,
      stage: String(error?.stage || trace.stage || ""),
      errorCode: String(error?.code || ""),
    }));
    return failure(request, "COUPANG_RANK_TRACKERS_FAILED");
  }
}

export default {
  fetch: withSupabase({ auth: "none", cors: false }, handleCoupangRankTrackersRequest),
};
