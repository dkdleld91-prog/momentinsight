// C 30일 순위 화면 계산(명세 §5.3.3·§5.3.4, WP2). 서버가 계산하고 화면은 그리기만 한다.
// 날짜는 모두 KST(UTC+9, 서머타임 없음). Vercel 은 UTC 로 돌기 때문에 시스템 시간대에 기대지 않는다.
import { RANK_TOP, SNAPSHOT_RESULTS, compareVersion } from "./contract.mjs";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUCCESS_RESULTS = new Set(SNAPSHOT_RESULTS);
const DAY_PATTERN = /^(\d{4}-\d{2}-\d{2})/;
const OFFLINE_AFTER_MS = 30 * 60 * 1000;
const DELAYED_AFTER_MS = 60 * 60 * 1000;
const KEYWORD_FAILING_STATES = new Set(["ok", "delayed", "idle_hours"]);
const KST_HOUR_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hourCycle: "h23" });

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value) return Date.parse(value);
  return Number.NaN;
}

function finiteInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function dayText(value) {
  const match = DAY_PATTERN.exec(String(value ?? ""));
  return match ? match[1] : "";
}

// ISO 시각 → KST 날짜 YYYY-MM-DD. 읽을 수 없으면 null.
export function kstDayOf(iso) {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return null;
  const kst = new Date(ms + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(kst.getUTCDate())}`;
}

// 서버 now 의 KST 날짜부터 거꾸로 30개(최근부터).
export function kstDays30(now = new Date()) {
  const today = kstDayOf(now) || kstDayOf(Date.now());
  const base = Date.parse(`${today}T00:00:00.000Z`);
  const days = [];
  for (let index = 0; index < 30; index += 1) days.push(new Date(base - index * DAY_MS).toISOString().slice(0, 10));
  return days;
}

// ISO 시각 → KST HH:MM. 읽을 수 없으면 null.
export function kstClock(iso) {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return null;
  const kst = new Date(ms + KST_OFFSET_MS);
  return `${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`;
}

// KST 시(0~23). §5.3.4 대로 Intl 로 구한다.
export function kstHour(now = new Date()) {
  const ms = toMs(now);
  const parts = KST_HOUR_FORMAT.formatToParts(new Date(Number.isFinite(ms) ? ms : Date.now()));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) ? hour % 24 : 0;
}

// 지금이 수집 시간대 [from, to) 안인지.
export function inCollectWindow(settings, now = new Date()) {
  const from = finiteInt(settings?.active_from_hour) ?? 8;
  const to = finiteInt(settings?.active_to_hour) ?? 23;
  const hour = kstHour(now);
  return hour >= from && hour < to;
}

function rowDay(row) {
  return dayText(row?.kst_day);
}

function rowSlot(row) {
  return finiteInt(row?.slot_minute) ?? 0;
}

function rowCheckedMs(row) {
  const ms = toMs(row?.checked_at);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

// 대표값 순서: slot_minute 이 큰 것, 같으면 checked_at 이 늦은 것.
function laterRow(left, right) {
  if (!left) return right;
  const slotDiff = rowSlot(right) - rowSlot(left);
  if (slotDiff !== 0) return slotDiff > 0 ? right : left;
  return rowCheckedMs(right) > rowCheckedMs(left) ? right : left;
}

function isSuccess(row) {
  return SUCCESS_RESULTS.has(String(row?.result || ""));
}

function rankValue(value) {
  const rank = finiteInt(value);
  return rank !== null && rank >= 1 && rank <= RANK_TOP ? rank : null;
}

function nonNegative(value) {
  const number = finiteInt(value);
  return number !== null && number >= 0 ? number : null;
}

// 일별 칸(날짜마다 1개, 최근 날짜부터). rows = coupang_rank_days 행(한 추적기).
// { d, s, r, n, a, t, c, f, b, k }
export function buildDayCells(rows) {
  const byDay = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = rowDay(row);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }
  const cells = [];
  for (const [day, dayRows] of byDay) {
    let representative = null;
    for (const row of dayRows) if (isSuccess(row)) representative = laterRow(representative, row);
    let status;
    if (representative) {
      status = String(representative.result);
    } else {
      const unsupported = dayRows.filter((row) => String(row?.result || "") === "unsupported");
      status = unsupported.length ? "unsupported" : "failed";
      for (const row of unsupported.length ? unsupported : dayRows) representative = laterRow(representative, row);
    }
    const success = status !== "failed" && status !== "unsupported";
    let c = 0;
    let f = 0;
    let best = null;
    for (const row of dayRows) {
      c += nonNegative(row?.success_count) ?? 0;
      f += nonNegative(row?.failure_count) ?? 0;
      const rowBest = rankValue(row?.best_rank);
      if (rowBest !== null && (best === null || rowBest < best)) best = rowBest;
    }
    cells.push({
      d: day,
      s: status,
      r: status === "found" ? rankValue(representative?.rank) : null,
      n: success ? nonNegative(representative?.organic_count) : null,
      a: success ? (finiteInt(representative?.ad_order) ?? null) : null,
      t: kstClock(representative?.checked_at),
      c,
      f,
      b: best,
      k: finiteInt(representative?.slot_index) ?? 0,
    });
  }
  cells.sort((left, right) => (left.d < right.d ? 1 : left.d > right.d ? -1 : 0));
  return cells;
}

// 추세(§5.3.3 표). L = 가장 최근 성공 행(날짜, slot_minute 순), P = L 과 같은 slot_minute 이면서 더 이른 날짜의 가장 최근 성공 행.
function trendOf(rows) {
  const success = (Array.isArray(rows) ? rows : []).filter((row) => isSuccess(row) && rowDay(row));
  success.sort((left, right) => {
    const leftDay = rowDay(left);
    const rightDay = rowDay(right);
    if (leftDay !== rightDay) return leftDay < rightDay ? 1 : -1;
    const slotDiff = rowSlot(right) - rowSlot(left);
    if (slotDiff !== 0) return slotDiff;
    return rowCheckedMs(right) - rowCheckedMs(left);
  });
  const latest = success[0];
  if (!latest) return { trend: "new", trendDelta: null };
  const previous = success.find((row) => rowSlot(row) === rowSlot(latest) && rowDay(row) < rowDay(latest));
  if (!previous) return { trend: "new", trendDelta: null };
  const latestFound = String(latest.result) === "found";
  const previousFound = String(previous.result) === "found";
  if (latestFound && previousFound) {
    const latestRank = rankValue(latest.rank);
    const previousRank = rankValue(previous.rank);
    if (latestRank === null || previousRank === null) return { trend: "same", trendDelta: null };
    const delta = previousRank - latestRank;
    return { trend: delta > 0 ? "up" : delta < 0 ? "down" : "same", trendDelta: delta };
  }
  if (latestFound) return { trend: "enter", trendDelta: null };
  if (previousFound) return { trend: "exit", trendDelta: null };
  return { trend: "same", trendDelta: null };
}

function latestFoundAt(rows) {
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.result || "") !== "found") continue;
    if (!best || rowCheckedMs(row) > rowCheckedMs(best)) best = row;
  }
  return best ? best.checked_at ?? null : null;
}

// 요약 수치(§5.3.3). rows = 일별 행, cells = buildDayCells(rows), keyword = 키워드 행(없으면 null),
// state = 수집기 상태(collectorState), days30 = kstDays30(now).
export function buildSummary(rows, cells, keyword, state, days30) {
  const window30 = new Set(Array.isArray(days30) ? days30 : []);
  const window7 = new Set((Array.isArray(days30) ? days30 : []).slice(0, 7));
  const list = Array.isArray(cells) ? cells : [];
  let best30 = null;
  let foundDays7 = 0;
  let measuredDays7 = 0;
  let rankSum = 0;
  for (const cell of list) {
    if (window30.size && !window30.has(cell.d)) continue;
    if (cell.b !== null && cell.b !== undefined && (best30 === null || cell.b < best30)) best30 = cell.b;
    if (!window7.has(cell.d)) continue;
    if (SUCCESS_RESULTS.has(cell.s)) measuredDays7 += 1;
    if (cell.s === "found" && cell.r !== null && cell.r !== undefined) {
      foundDays7 += 1;
      rankSum += cell.r;
    }
  }
  const avg7 = foundDays7 ? Math.round((rankSum / foundDays7) * 10) / 10 : null;
  const { trend, trendDelta } = trendOf(rows);
  const attentionReasons = [];
  if (trend === "down" && trendDelta !== null && trendDelta <= -10) attentionReasons.push("drop10");
  if (trend === "exit") attentionReasons.push("exit");
  const failures = finiteInt(keyword?.consecutive_failures) ?? 0;
  const unsupported = finiteInt(keyword?.consecutive_unsupported) ?? 0;
  if (failures >= 3 && KEYWORD_FAILING_STATES.has(String(state || ""))) attentionReasons.push("keyword_failing");
  if (unsupported >= 2) attentionReasons.push("unsupported");
  return {
    best30,
    avg7,
    foundDays7,
    measuredDays7,
    trend,
    trendDelta,
    attention: attentionReasons.length > 0,
    attentionReasons,
    lastFoundAt: latestFoundAt(rows),
  };
}

// 수집기 상태(§5.3.4, 위에서부터 처음 맞는 것).
// input = { setupRequired, settings(행), collectors(폐기 안 된 수집기 행), keywords(이 범위 활성 추적기의 키워드 행), now }
export function collectorState(input = {}) {
  if (input.setupRequired || !input.settings) return "setup_required";
  const settings = input.settings;
  const nowMs = toMs(input.now ?? Date.now());
  const collectors = (Array.isArray(input.collectors) ? input.collectors : [])
    .filter((row) => row && (row.revoked_at === null || row.revoked_at === undefined));
  if (!collectors.length) return "not_connected";
  if (settings.enabled !== true) return "disabled";
  if (settings.needs_owner_review === true) return "review";
  if (settings.budget_blocked === true) return "budget";
  const cooldownMs = toMs(settings.cooldown_until);
  if (Number.isFinite(cooldownMs) && cooldownMs > nowMs) return "cooldown";
  const minVersion = String(settings.min_collector_version || "");
  if (minVersion && collectors.every((row) => compareVersion(row.last_version || "0.0.0", minVersion) < 0)) return "outdated";
  const inWindow = inCollectWindow(settings, nowMs);
  if (inWindow) {
    let lastSeen = Number.NEGATIVE_INFINITY;
    for (const row of collectors) {
      const seen = toMs(row.last_seen_at);
      if (Number.isFinite(seen) && seen > lastSeen) lastSeen = seen;
    }
    if (!Number.isFinite(lastSeen) || nowMs - lastSeen > OFFLINE_AFTER_MS) return "offline";
  }
  const delayed = (Array.isArray(input.keywords) ? input.keywords : []).some((row) => {
    if (!row || (row.lease_run_id !== null && row.lease_run_id !== undefined)) return false;
    const due = toMs(row.next_due_at);
    const ends = toMs(row.slot_ends_at);
    return Number.isFinite(due) && Number.isFinite(ends) && due < nowMs - DELAYED_AFTER_MS && ends > nowMs;
  });
  if (delayed) return "delayed";
  if (!inWindow) return "idle_hours";
  return "ok";
}

// 다음 수집(§5.3.3 표). 반환 { nextCheckAt, nextCheckState }.
export function nextCheck(keywordRow, status, now = new Date()) {
  if (String(status || "") === "paused") return { nextCheckAt: null, nextCheckState: "paused" };
  const nowMs = toMs(now);
  const ends = toMs(keywordRow?.slot_ends_at);
  if (!keywordRow || !Number.isFinite(ends) || ends <= nowMs) return { nextCheckAt: null, nextCheckState: "replan" };
  const due = toMs(keywordRow.next_due_at);
  if (!Number.isFinite(due)) return { nextCheckAt: null, nextCheckState: "replan" };
  if (due <= nowMs) return { nextCheckAt: keywordRow.next_due_at, nextCheckState: "due" };
  return { nextCheckAt: keywordRow.next_due_at, nextCheckState: "scheduled" };
}

function currentPayload(row) {
  if (!row || !SUCCESS_RESULTS.has(String(row.current_result || ""))) return null;
  const result = String(row.current_result);
  return {
    result,
    rank: result === "found" ? rankValue(row.current_rank) : null,
    organicCount: nonNegative(row.current_organic_count),
    adOrder: finiteInt(row.current_ad_order),
    sameOption: typeof row.current_same_option === "boolean" ? row.current_same_option : null,
    checkedAt: row.last_checked_at ?? null,
  };
}

function keywordHealth(keywordRow) {
  return {
    consecutiveFailures: finiteInt(keywordRow?.consecutive_failures) ?? 0,
    consecutiveUnsupported: finiteInt(keywordRow?.consecutive_unsupported) ?? 0,
    lastStatus: keywordRow?.last_status ?? null,
  };
}

// 추적기 항목(§3.3, 필드 순서 고정). row = 추적기 행, dayRows = 그 추적기의 일별 행, keywordRow = 키워드 행(없으면 null).
export function trackerPayload(row, dayRows, keywordRow, state, days30, now = new Date()) {
  const window30 = new Set(Array.isArray(days30) ? days30 : []);
  const rows = (Array.isArray(dayRows) ? dayRows : []).filter((item) => !window30.size || window30.has(rowDay(item)));
  const cells = buildDayCells(rows);
  const summary = buildSummary(rows, cells, keywordRow, state, days30);
  if (row?.last_found_at) summary.lastFoundAt = row.last_found_at;
  const next = nextCheck(keywordRow, row?.status, now);
  return {
    id: row?.id ?? null,
    keyword: row?.keyword ?? "",
    keywordKey: row?.keyword_key ?? "",
    productId: row?.product_id ?? "",
    productUrl: row?.product_url ?? "",
    vendorItemId: row?.vendor_item_id ?? null,
    productTitle: row?.product_title ?? null,
    groupName: row?.group_name ?? "",
    sortOrder: finiteInt(row?.sort_order) ?? 0,
    status: row?.status ?? "active",
    createdAt: row?.created_at ?? null,
    createdDay: dayText(row?.created_kst_day) || kstDayOf(row?.created_at),
    pausedAt: row?.paused_at ?? null,
    pausedDay: row?.paused_at ? kstDayOf(row.paused_at) : null,
    current: currentPayload(row),
    nextCheckAt: next.nextCheckAt,
    nextCheckState: next.nextCheckState,
    keywordHealth: keywordHealth(keywordRow),
    summary,
    days: cells,
  };
}
