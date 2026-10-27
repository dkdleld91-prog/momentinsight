// C 30일 순위 설정(명세 §5.6·§5.9, WP2). 설정 행(snake_case) ↔ 화면 값(camelCase), 변경 검증·상향 규칙, 용량.
import { RATE_LADDER_PER_HOUR, VERSION_PATTERN, WINDOW_MODES } from "./contract.mjs";

const HOUR_MS = 60 * 60 * 1000;
const QUIET_WINDOW_HOURS = 48;
const SUCCESS_REQUIRED_48H = 48;
const INTEGER_TEXT_PATTERN = /^-?[0-9]{1,6}$/;

// 편집 가능한 칸(§5.9 표). 순서는 화면 설정 폼 순서와 같다.
const EDITABLE_FIELDS = Object.freeze({
  teamAccessEnabled: { column: "team_access_enabled", kind: "boolean" },
  clientViewEnabled: { column: "client_view_enabled", kind: "boolean" },
  checksPerDay: { column: "checks_per_day", kind: "integer", min: 1, max: 6 },
  minGapSeconds: { column: "min_gap_seconds", kind: "integer", min: 30, max: 3600 },
  gapJitterSeconds: { column: "gap_jitter_seconds", kind: "integer", min: 0, max: 600 },
  maxRunsPerHour: { column: "max_runs_per_hour", kind: "integer", min: 1, max: 60 },
  maxRunsPerDay: { column: "max_runs_per_day", kind: "integer", min: 1, max: 1000 },
  activeFromHour: { column: "active_from_hour", kind: "integer", min: 0, max: 23 },
  activeToHour: { column: "active_to_hour", kind: "integer", min: 1, max: 24 },
  defaultAccountLimit: { column: "default_account_limit", kind: "integer", min: 0, max: 1000 },
  globalKeywordLimit: { column: "global_keyword_limit", kind: "integer", min: 1, max: 1000 },
  windowMode: { column: "window_mode", kind: "enum", values: WINDOW_MODES },
  minCollectorVersion: { column: "min_collector_version", kind: "version" },
  maxStorageMb: { column: "max_storage_mb", kind: "integer", min: 10, max: 400 },
  dbSizeStopMb: { column: "db_size_stop_mb", kind: "integer", min: 100, max: 8000 },
  // ① 지금 확인 켜기·끄기(spec-manual §6.9). 속도 상향 규칙·재계획 대상이 아니다. 간격·하루·시간 값은 화면에서 바꾸지 않는다
  // (대표 결정값, 바꾸려면 SQL — 더 느슨하게는 제약이 막는다). 수동 칸이 없는 설정에 보내면 핸들러가 409 로 막는다.
  manualEnabled: { column: "manual_enabled", kind: "boolean" },
});

export const EDITABLE_SETTING_FIELDS = Object.freeze(Object.keys(EDITABLE_FIELDS));

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value) return Date.parse(value);
  return Number.NaN;
}

function intOf(value, fallback = null) {
  const number = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isInteger(number) ? number : fallback;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 설정 행 → 화면 값(§5.6 settings, 순서 고정).
export function settingsPayload(row) {
  const source = row || {};
  return {
    enabled: source.enabled === true,
    teamAccessEnabled: source.team_access_enabled === true,
    clientViewEnabled: source.client_view_enabled === true,
    checksPerDay: intOf(source.checks_per_day),
    minGapSeconds: intOf(source.min_gap_seconds),
    gapJitterSeconds: intOf(source.gap_jitter_seconds),
    maxRunsPerHour: intOf(source.max_runs_per_hour),
    maxRunsPerDay: intOf(source.max_runs_per_day),
    activeFromHour: intOf(source.active_from_hour),
    activeToHour: intOf(source.active_to_hour),
    defaultAccountLimit: intOf(source.default_account_limit),
    globalKeywordLimit: intOf(source.global_keyword_limit),
    windowMode: source.window_mode ?? null,
    minCollectorVersion: source.min_collector_version ?? null,
    maxStorageMb: intOf(source.max_storage_mb),
    dbSizeStopMb: intOf(source.db_size_stop_mb),
    cooldownUntil: source.cooldown_until ?? null,
    cooldownReason: source.cooldown_reason ?? null,
    needsOwnerReview: source.needs_owner_review === true,
    reviewReason: source.review_reason ?? null,
    budgetBlocked: source.budget_blocked === true,
    budgetReason: source.budget_reason ?? null,
    rateChangedAt: source.rate_changed_at ?? null,
    updatedAt: source.updated_at ?? null,
    // ① 지금 확인(spec-manual §6.9). 수동 칸이 없으면(대표 SQL 전) false/null.
    manualEnabled: source.manual_enabled === true,
    manualMinGapSeconds: intOf(source.manual_min_gap_seconds),
    manualMaxPerDay: intOf(source.manual_max_per_day),
    manualFromHour: intOf(source.manual_from_hour),
    manualToHour: intOf(source.manual_to_hour),
    manualStoppedDay: source.manual_stopped_day ?? null,
    manualStoppedAt: source.manual_stopped_at ?? null,
    manualStoppedCode: source.manual_stopped_code ?? null,
    // 차단 뒤 30분 쉼(c30-4). 칸이 없으면(대표 SQL 전) null·0.
    manualPausedUntil: source.manual_paused_until ?? null,
    manualBlockDay: source.manual_block_day ?? null,
    manualBlockCount: intOf(source.manual_block_count, 0),
  };
}

// 사다리(12→24→40→60)에서 현재보다 큰 가장 작은 값. 없으면 null.
export function nextLadderStep(current) {
  const value = Number(current);
  const step = RATE_LADDER_PER_HOUR.find((item) => item > (Number.isFinite(value) ? value : 0));
  return step === undefined ? null : step;
}

function normalizeField(name, value) {
  const spec = EDITABLE_FIELDS[name];
  if (spec.kind === "boolean") return typeof value === "boolean" ? { ok: true, value } : { ok: false };
  if (spec.kind === "integer") {
    let number = null;
    if (typeof value === "number" && Number.isInteger(value)) number = value;
    else if (typeof value === "string" && INTEGER_TEXT_PATTERN.test(value.trim())) number = Number(value.trim());
    if (number === null || number < spec.min || number > spec.max) return { ok: false };
    return { ok: true, value: number };
  }
  if (spec.kind === "enum") return typeof value === "string" && spec.values.includes(value) ? { ok: true, value } : { ok: false };
  if (spec.kind === "version") {
    if (value === null || value === "") return { ok: true, value: null };
    return typeof value === "string" && VERSION_PATTERN.test(value) ? { ok: true, value } : { ok: false };
  }
  return { ok: false };
}

function invalid(field) {
  return { ok: false, status: 400, code: "COUPANG_SETTINGS_INVALID", field };
}

// 패치 모양·범위만 본다(상향 규칙 전 단계). 반환 { ok:true, values: { camel: 값 } } | 400 오류.
function normalizePatch(patch, current) {
  if (!plainObject(patch)) return invalid("settings");
  const names = Object.keys(patch);
  if (!names.length) return invalid("settings");
  const values = {};
  for (const name of names) {
    if (!Object.hasOwn(EDITABLE_FIELDS, name)) return invalid(name);
    const normalized = normalizeField(name, patch[name]);
    if (!normalized.ok) return invalid(name);
    values[name] = normalized.value;
  }
  const from = Object.hasOwn(values, "activeFromHour") ? values.activeFromHour : intOf(current?.active_from_hour, 8);
  const to = Object.hasOwn(values, "activeToHour") ? values.activeToHour : intOf(current?.active_to_hour, 23);
  if (!(from < to)) return invalid(Object.hasOwn(values, "activeFromHour") ? "activeFromHour" : "activeToHour");
  return { ok: true, values, from, to };
}

// 속도를 올리는 변경인지(§5.9): 시간당·하루 상한 증가, 최소 간격 감소, 수집 시간대 넓힘(어느 한쪽이라도).
function raisingChanges(values, current, from, to) {
  const changes = [];
  const curHour = intOf(current?.max_runs_per_hour, 0);
  const curDay = intOf(current?.max_runs_per_day, 0);
  const curGap = intOf(current?.min_gap_seconds, 0);
  const curFrom = intOf(current?.active_from_hour, 8);
  const curTo = intOf(current?.active_to_hour, 23);
  if (Object.hasOwn(values, "maxRunsPerHour") && values.maxRunsPerHour > curHour) changes.push("maxRunsPerHour");
  if (Object.hasOwn(values, "maxRunsPerDay") && values.maxRunsPerDay > curDay) changes.push("maxRunsPerDay");
  if (Object.hasOwn(values, "minGapSeconds") && values.minGapSeconds < curGap) changes.push("minGapSeconds");
  if (from < curFrom || to > curTo) changes.push("activeHours");
  return changes;
}

// 핸들러가 stats 를 읽을지 정하려고 쓴다(내리기만 하는 변경은 stats 없이 바로 저장 — 비상시 막히지 않게).
export function isRaisingPatch(patch, current) {
  const normalized = normalizePatch(patch, current);
  if (!normalized.ok) return false;
  return raisingChanges(normalized.values, current, normalized.from, normalized.to).length > 0;
}

function statNumber(stats, name) {
  const value = Number(stats?.[name]);
  return Number.isFinite(value) ? value : null;
}

function hoursSince(value, nowMs) {
  const changed = toMs(value);
  if (!Number.isFinite(changed) || !Number.isFinite(nowMs)) return null;
  return Math.floor(((nowMs - changed) / HOUR_MS) * 10) / 10;
}

// 상향 조건 2·3(+ 사다리 끝)을 본다. 확인(confirmRaise)과 요청 값의 사다리 검사는 validateSettingsPatch 가 한다.
// 반환: { allowed, nextStep, reasons, blocked48h, empty48h, success48h, hoursSinceRateChange }
export function raiseStatus(current, stats, now = new Date()) {
  const nowMs = toMs(now);
  const blocked48h = statNumber(stats, "blocked48h");
  const empty48h = statNumber(stats, "empty48h");
  const success48h = statNumber(stats, "success48h");
  const hoursSinceRateChange = hoursSince(current?.rate_changed_at, nowMs);
  const nextStep = nextLadderStep(current?.max_runs_per_hour);
  const reasons = [];
  if (blocked48h !== 0 || empty48h !== 0) reasons.push("blocked_or_empty_48h");
  if (success48h === null || success48h < SUCCESS_REQUIRED_48H) reasons.push("too_few_success_48h");
  const changedMs = toMs(current?.rate_changed_at);
  if (!Number.isFinite(changedMs) || nowMs - changedMs < QUIET_WINDOW_HOURS * HOUR_MS) reasons.push("quiet_window_short");
  if (nextStep === null) reasons.push("ladder_step");
  return { allowed: reasons.length === 0, nextStep, reasons, blocked48h, empty48h, success48h, hoursSinceRateChange };
}

// settings-update 검증(§5.9).
// patch = 요청 settings(camelCase), current = 지금 설정 행, stats = coupang_rank_stats() 결과(내리기만이면 null 이어도 됨).
// 반환
// - 통과: { ok: true, update: { snake 열: 값 }, raise, replan }
//   (raise 면 update.rate_changed_at = now. updated_by 는 핸들러가 넣는다)
// - 400 COUPANG_SETTINGS_INVALID { field } / 400 COUPANG_RAISE_CONFIRM_REQUIRED
// - 409 COUPANG_RAISE_NOT_ALLOWED { reasons, blocked48h, empty48h, success48h, hoursSinceRateChange, nextStep }
export function validateSettingsPatch(patch, current, stats, now = new Date(), confirmRaise = false) {
  const normalized = normalizePatch(patch, current);
  if (!normalized.ok) return normalized;
  const { values, from, to } = normalized;
  const raising = raisingChanges(values, current, from, to);
  const update = {};
  for (const [name, value] of Object.entries(values)) update[EDITABLE_FIELDS[name].column] = value;

  if (raising.length) {
    if (confirmRaise !== true) return { ok: false, status: 400, code: "COUPANG_RAISE_CONFIRM_REQUIRED", changes: raising };
    const status = raiseStatus(current, stats, now);
    const reasons = status.reasons.filter((reason) => reason !== "ladder_step");
    if (raising.includes("maxRunsPerHour") && (status.nextStep === null || values.maxRunsPerHour !== status.nextStep)) {
      reasons.push("ladder_step");
    }
    if (reasons.length) {
      return {
        ok: false,
        status: 409,
        code: "COUPANG_RAISE_NOT_ALLOWED",
        reasons,
        blocked48h: status.blocked48h,
        empty48h: status.empty48h,
        success48h: status.success48h,
        hoursSinceRateChange: status.hoursSinceRateChange,
        nextStep: status.nextStep,
      };
    }
    update.rate_changed_at = new Date(toMs(now)).toISOString();
  }

  const curChecks = intOf(current?.checks_per_day);
  const curFrom = intOf(current?.active_from_hour);
  const curTo = intOf(current?.active_to_hour);
  const replan = (Object.hasOwn(values, "checksPerDay") && values.checksPerDay !== curChecks)
    || from !== curFrom
    || to !== curTo;
  return { ok: true, update, raise: raising.length > 0, replan };
}

// 용량(§5.6). settings = 설정 행. activeKeywords = stats.activeKeywords(대상만, 모르면 null).
// runsPerDay = min(하루 상한, 시간당 상한 × 수집 시간 수), keywordsAtChecks = floor(runsPerDay / 하루 횟수).
export function capacityOf(settings, activeKeywords = null) {
  const perHour = Math.max(0, intOf(settings?.max_runs_per_hour, 0));
  const perDay = Math.max(0, intOf(settings?.max_runs_per_day, 0));
  const from = intOf(settings?.active_from_hour, 8);
  const to = intOf(settings?.active_to_hour, 23);
  const checks = Math.max(1, intOf(settings?.checks_per_day, 1));
  const runsPerDay = Math.min(perDay, perHour * Math.max(0, to - from));
  const keywordsAtChecks = Math.floor(runsPerDay / checks);
  const active = activeKeywords === null || activeKeywords === undefined ? null : intOf(activeKeywords, null);
  return {
    runsPerDay,
    keywordsAtChecks,
    activeKeywords: active,
    over: active !== null && active > keywordsAtChecks,
  };
}
