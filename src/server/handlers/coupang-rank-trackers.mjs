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
  ERROR_HTTP_STATUS,
  MAX_ACTIVE_COLLECTORS,
  SUCCESS_RUN_STATUSES,
  TRACKERS_BODY_MAX_BYTES,
  TRACKER_LIST_FETCH_LIMIT,
  TRACKER_LIST_MAX,
} from "../coupang-rank/contract.mjs";
import { chunk, inList, isSetupMissing, loadSettings, mapLimit, selectPages } from "../coupang-rank/db.mjs";
import { generateCollectorToken } from "../coupang-rank/worker-token.mjs";
import { accessView, canonicalAgencyCode, resolveCoupangAccess } from "../coupang-rank/access.mjs";
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

const VIEWS = new Set(["", "access", "runs", "collector"]);
const SCOPED_ACTIONS = new Set(["create", "pause", "resume", "delete", "group"]);
const CREATE_ACTIONS = new Set(["create", "resume"]);
const OWNER_ACTIONS = new Set([
  "settings-update", "collector-enable", "collector-disable", "cooldown-clear",
  "account-limit-set", "collector-token-create", "collector-token-revoke",
]);
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

const MESSAGES = Object.freeze({
  COUPANG_SESSION_REQUIRED: "로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.",
  TRIAL_LOCKED: "체험 계정에서는 쿠팡 30일 순위를 쓸 수 없습니다. 도입 문의 후 이용할 수 있습니다.",
  COUPANG_TEAM_NOT_OPEN: "쿠팡 30일 순위는 아직 운영팀에 열리지 않았습니다.",
  COUPANG_CLIENT_NOT_OPEN: "쿠팡 30일 순위는 아직 광고주 화면에 열리지 않았습니다.",
  COUPANG_READ_ONLY: "광고주 화면에서는 쿠팡 순위를 조회만 할 수 있습니다.",
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
  BODY_TOO_LARGE: "요청 본문이 너무 큽니다.",
  METHOD_NOT_ALLOWED: "허용되지 않은 요청 방식입니다.",
  COUPANG_SETUP_REQUIRED: "쿠팡 순위 저장소가 아직 준비되지 않았습니다(대표 SQL 실행 전).",
  COUPANG_RANK_TRACKERS_FAILED: "쿠팡 순위 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
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

async function loadLastSuccessAt(ctx) {
  const rows = rowsOf(
    await ctx.supabaseAdmin
      .from(TABLES.runs)
      .select("claimed_at")
      .in("status", [...SUCCESS_RUN_STATUSES])
      .order("claimed_at", { ascending: false })
      .limit(1),
    "last_success",
  );
  return rows[0]?.claimed_at ?? null;
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
    loadLastSuccessAt(ctx),
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
  const assembled = await assembleTrackers(ctx, settings, access, shown, now, { includeLimit: access.role !== "client" });
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
  const [collectors, accountLimits, stats] = await Promise.all([
    loadCollectorPanelRows(ctx),
    loadAccountLimits(ctx),
    loadStats(ctx),
  ]);
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
  trace.stage = "settings";
  const loaded = await loadSettings(ctx);
  if (loaded.setupRequired) return respond(request, setupRequiredBody(request, view));
  const settings = loaded.settings;

  if (view === "access") {
    const result = accessView(request, settings);
    return result.ok ? respond(request, result) : failure(request, result.code);
  }

  trace.stage = "access";
  const resolved = await resolveCoupangAccess(request, ctx, settings, {
    write: false,
    create: false,
    ownerOnly: view === "collector",
  });
  if (!resolved.ok) return failure(request, resolved.code);
  const access = resolved.access;
  if (view === "collector") {
    if (access.owner !== true) return failure(request, "COUPANG_OWNER_ONLY");
    return collectorView(request, ctx, settings, now, trace);
  }
  if (view === "runs") return runsView(request, ctx, access, url, now, trace);
  return listView(request, ctx, settings, access, now, trace);
}

// ── POST ─────────────────────────────────────────────────────────────────

async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TRACKERS_BODY_MAX_BYTES) return { ok: false, code: "BODY_TOO_LARGE" };
  const contentType = String(request.headers.get("content-type") || "").trim().toLowerCase();
  if (!contentType.startsWith("application/json")) return { ok: false, code: "COUPANG_ACTION_INVALID" };
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, code: "COUPANG_ACTION_INVALID" };
  }
  if (new TextEncoder().encode(text).length > TRACKERS_BODY_MAX_BYTES) return { ok: false, code: "BODY_TOO_LARGE" };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: "COUPANG_ACTION_INVALID" };
  }
  if (!plainObject(body)) return { ok: false, code: "COUPANG_ACTION_INVALID" };
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

async function settingsUpdateAction(request, ctx, settings, body, now, trace) {
  const patch = body.settings;
  if (!plainObject(patch)) return failure(request, "COUPANG_SETTINGS_INVALID", { field: "settings" });
  const confirmRaise = body.confirmRaise === true;
  let stats = null;
  // 내리기만 하는 변경은 집계를 읽지 않고 바로 저장한다(집계가 느리거나 실패해도 비상 감속이 막히지 않게).
  if (confirmRaise && isRaisingPatch(patch, settings)) {
    trace.stage = "stats";
    stats = await loadStats(ctx);
  }
  const checked = validateSettingsPatch(patch, settings, stats, now, confirmRaise);
  if (!checked.ok) {
    const { ok: _ok, status: _status, code, ...extra } = checked;
    return failure(request, code, extra);
  }
  trace.stage = "settings_update";
  const saved = await updateSettingsRow(ctx, checked.update, "settings_update");
  let replanned = 0;
  if (checked.replan) {
    trace.stage = "replan";
    const result = await ctx.supabaseAdmin.rpc("coupang_rank_replan_all");
    if (result.error) throw dbError("replan", result.error);
    replanned = finiteNumberOrNull(result.data) ?? 0;
  }
  return respond(request, { ok: true, settings: settingsPayload(saved), replanned });
}

async function collectorEnableAction(request, ctx, enable, trace) {
  if (enable) {
    trace.stage = "collectors_count";
    if ((await countActiveCollectors(ctx)) < 1) return failure(request, "COUPANG_NO_COLLECTOR");
  }
  trace.stage = enable ? "enable" : "disable";
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

async function handlePost(request, ctx, now, trace) {
  trace.stage = "body";
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return failure(request, parsed.code);
  const body = parsed.body;
  const action = typeof body.action === "string" ? body.action : "";
  if (!SCOPED_ACTIONS.has(action) && !OWNER_ACTIONS.has(action)) return failure(request, "COUPANG_ACTION_INVALID");
  trace.action = action;

  trace.stage = "settings";
  const loaded = await loadSettings(ctx);
  if (loaded.setupRequired) return failure(request, "COUPANG_SETUP_REQUIRED");
  const settings = loaded.settings;

  trace.stage = "access";
  const ownerOnly = OWNER_ACTIONS.has(action);
  const resolved = await resolveCoupangAccess(request, ctx, settings, {
    write: true,
    create: CREATE_ACTIONS.has(action),
    ownerOnly,
  });
  if (!resolved.ok) return failure(request, resolved.code);
  const access = resolved.access;
  if (ownerOnly && access.owner !== true) return failure(request, "COUPANG_OWNER_ONLY");

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
      return collectorEnableAction(request, ctx, true, trace);
    case "collector-disable":
      return collectorEnableAction(request, ctx, false, trace);
    case "cooldown-clear":
      return cooldownClearAction(request, ctx, now, trace);
    case "account-limit-set":
      return accountLimitSetAction(request, ctx, body, trace);
    case "collector-token-create":
      return collectorTokenCreateAction(request, ctx, body, trace);
    case "collector-token-revoke":
      return collectorTokenRevokeAction(request, ctx, body, now, trace);
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
