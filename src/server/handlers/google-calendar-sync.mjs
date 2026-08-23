import { sanitizeAuditMetadata } from "../audit-security.mjs";
import { seoulDateKey } from "../calendar-domain.mjs";
import {
  DONE_PREFIX,
  buildGoogleEventPayload,
  cleanText,
  clientDisplayName,
  decorateGoogleSummary,
  googleFetch,
  googleOauthConfig,
  loadOwnerGoogleIntegration,
  normalizeCode,
  normalizeImportedTitle,
  refreshAccessToken,
  undecorateGoogleSummary,
} from "../google-calendar-client.mjs";

// 구글 캘린더 양방향 동기화 엔진.
//
// 루프 차단은 3중이다.
//  (1) 구조: inbound 쓰기는 이 모듈만 수행하고 이 모듈은 work-items 의 PATCH
//      경로를 타지 않는다. "inbound -> outbound" 코드 경로가 존재하지 않는다.
//  (2) 버전: 구글이 준 updated 를 그대로 저장해 두고, 그보다 새롭지 않은
//      inbound 는 우리가 쓴 메아리로 보고 버린다.
//  (3) 순서: 한 실행에서 push 를 먼저, pull 을 나중에 해서 같은 실행 안에
//      우리 쓰기가 (2)로 흡수되게 한다.

export const WINDOW_PAST_DAYS = 30;
export const WINDOW_FUTURE_DAYS = 365;
export const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_PAGES = 10;
export const DEFAULT_PAGE_SIZE = 250;
export const DEFAULT_PUSH_LIMIT = 50;
export const DEFAULT_PUSH_CONCURRENCY = 6;
export const DEFAULT_BUDGET_MS = 20000;
export const IMPORTED_SCHEDULE_TYPE = "meeting";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SYNC_ROW_FIELDS = [
  "id", "owner_agency_code", "client_id", "operation_team_id", "calendar_id",
  "title", "status", "starts_at", "ends_at", "is_all_day",
  "series_id", "occurrence_on", "recurrence_until",
  "google_event_id", "google_calendar_id", "google_etag", "google_updated_at",
  "google_source", "google_sync_state", "updated_at",
].join(",");

const CALENDAR_SYNC_FIELDS = [
  "owner_agency_code", "google_calendar_id", "calendar_role", "sync_token",
  "full_sync_page_token", "window_start", "window_end",
  "last_synced_at", "last_full_sync_at", "last_error", "last_error_at",
].join(",");

function primaryAgencyCode(env = process.env) {
  return normalizeCode(env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
}

function isUuid(value) {
  return UUID_PATTERN.test(cleanText(value).toLowerCase());
}

function eventsPath(calendarId, eventId = "") {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 (테스트의 중심)
// ─────────────────────────────────────────────────────────────

export function syncWindow(now = Date.now()) {
  return {
    timeMin: new Date(now - WINDOW_PAST_DAYS * DAY_MS).toISOString(),
    timeMax: new Date(now + WINDOW_FUTURE_DAYS * DAY_MS).toISOString(),
  };
}

export function eventInWindow(startsAt, window) {
  const at = new Date(cleanText(startsAt)).getTime();
  if (!Number.isFinite(at)) return false;
  return at >= new Date(window.timeMin).getTime() && at <= new Date(window.timeMax).getTime();
}

function seoulMidnightIso(dateKey, dayOffset = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(cleanText(dateKey));
  if (!match) return "";
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayOffset, -9);
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function isoOrEmpty(value) {
  const parsed = new Date(cleanText(value));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

// 종일 일정의 end.date 는 배타적이다. MI 는 마지막 날을 포함으로 저장하므로
// 하루를 빼서 서울 자정으로 되돌린다. 하루짜리면 ends_at === starts_at 이 되고
// schedule_items_date_order(ends_at >= starts_at) 를 그대로 만족한다.
export function googleEventTimes(event = {}) {
  const start = event.start || {};
  const end = event.end || {};
  if (start.date) {
    const startsAt = seoulMidnightIso(start.date);
    if (!startsAt) return { ok: false };
    const endsAt = seoulMidnightIso(end.date, -1) || startsAt;
    return {
      ok: true,
      isAllDay: true,
      startsAt,
      endsAt: new Date(endsAt).getTime() < new Date(startsAt).getTime() ? startsAt : endsAt,
    };
  }
  const startsAt = isoOrEmpty(start.dateTime);
  if (!startsAt) return { ok: false };
  const rawEnd = isoOrEmpty(end.dateTime);
  const endsAt = rawEnd || new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString();
  return {
    ok: true,
    isAllDay: false,
    startsAt,
    endsAt: new Date(endsAt).getTime() < new Date(startsAt).getTime() ? startsAt : endsAt,
  };
}

export function eventPrivateProps(event = {}) {
  const props = event.extendedProperties?.private;
  return props && typeof props === "object" ? props : {};
}

export function eventIsCancelled(event = {}) {
  return cleanText(event.status).toLowerCase() === "cancelled";
}

// (2) 버전 가드. 저장해 둔 값 자체가 구글에서 온 것이므로 같은 시각이 정상이고,
// 페이지가 날아오는 사이 더 새로운 outbound 가 값을 앞당겼을 수도 있어 <= 로 본다.
export function eventIsEcho(event = {}, row = null) {
  const known = new Date(cleanText(row?.google_updated_at)).getTime();
  const incoming = new Date(cleanText(event.updated)).getTime();
  if (!Number.isFinite(known) || !Number.isFinite(incoming)) return false;
  return incoming <= known;
}

function googleMirrorFields(event = {}) {
  const attendees = Array.isArray(event.attendees) ? event.attendees.slice(0, 50) : null;
  return {
    google_etag: cleanText(event.etag, 200) || null,
    google_updated_at: isoOrEmpty(event.updated) || null,
    google_html_link: cleanText(event.htmlLink, 1000) || null,
    google_recurring_event_id: cleanText(event.recurringEventId, 1024) || null,
    google_location: cleanText(event.location, 1000) || null,
    google_description: cleanText(event.description, 8000) || null,
    google_attendees: attendees,
  };
}

export function mapGoogleEventToScheduleRow(event = {}, { ownerCode = "", calendarId = "" } = {}) {
  const times = googleEventTimes(event);
  if (!times.ok) return null;
  const props = eventPrivateProps(event);
  return {
    owner_agency_code: normalizeCode(ownerCode),
    client_id: null,
    operation_team_id: null,
    calendar_id: null,
    title: normalizeImportedTitle(undecorateGoogleSummary(event.summary, props)),
    schedule_type: IMPORTED_SCHEDULE_TYPE,
    status: "planned",
    priority: "medium",
    visibility: "internal",
    public_title: null,
    public_comment: null,
    internal_note: null,
    is_all_day: times.isAllDay,
    starts_at: times.startsAt,
    ends_at: times.endsAt,
    google_source: "google",
    google_calendar_id: cleanText(calendarId),
    google_event_id: cleanText(event.id, 1024),
    google_sync_state: "synced",
    google_sync_error: null,
    google_synced_at: new Date().toISOString(),
    ...googleMirrorFields(event),
  };
}

// 구글이 소유한 필드만 담은 패치를 만든다. schedule_type / priority / visibility /
// client_id / internal_note 등 MI 소유 필드는 절대 포함되지 않는다.
export function inboundUpdatePatch(event = {}, row = {}) {
  const times = googleEventTimes(event);
  if (!times.ok) return { ok: false, reason: "invalid_time" };
  const props = eventPrivateProps(event);
  const patch = {
    title: normalizeImportedTitle(undecorateGoogleSummary(event.summary, props)),
    starts_at: times.startsAt,
    ends_at: times.endsAt,
    is_all_day: times.isAllDay,
    google_sync_state: "synced",
    google_sync_error: null,
    google_synced_at: new Date().toISOString(),
    ...googleMirrorFields(event),
  };
  if (!row.google_calendar_id) patch.google_calendar_id = cleanText(event.calendarId) || undefined;

  // 시리즈 행은 occurrence_on 이 서울 기준 시작일과 같아야 하고
  // recurrence_until 을 넘을 수 없다(schedule_items_recurrence_coherent).
  if (row.series_id) {
    const occurrenceOn = seoulDateKey(times.startsAt);
    if (!occurrenceOn) return { ok: false, reason: "invalid_time" };
    if (row.recurrence_until && occurrenceOn > row.recurrence_until) {
      return { ok: false, reason: "series_window" };
    }
    patch.occurrence_on = occurrenceOn;
  }
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete patch[key];
  }
  return { ok: true, patch };
}

// (C-1) 대표가 만든 행이면 광고주/운영팀 범위여도 구글로 민다.
// access.role === "owner" 조건은 유지한다 — 운영팀원이 만든 일정이 대표 개인
// 캘린더로 흘러드는 것을 막는 유일한 방어선이다.
// owner_agency_code 는 selectFields 에 없을 수 있어 있을 때만 대조한다.
export function ownerSyncableRows(access, rows) {
  if (!access || access.role !== "owner") return [];
  const ownerCode = normalizeCode(access.ownerAgencyCode);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || row.calendar_id) return false;
    if (row.owner_agency_code && normalizeCode(row.owner_agency_code) !== ownerCode) return false;
    return true;
  });
}

export function rowClientName(row = {}, clientsById = null) {
  if (row.client) return clientDisplayName(row.client);
  if (clientsById && row.client_id) return clientDisplayName(clientsById.get(row.client_id));
  return "";
}

// ─────────────────────────────────────────────────────────────
// 상태 기록
// ─────────────────────────────────────────────────────────────

async function recordSyncAudit(ctx, action, targetId, metadata) {
  try {
    await ctx.supabaseAdmin.from("audit_logs").insert({
      actor_id: null,
      client_id: null,
      action,
      target_table: "schedule_items",
      target_id: targetId || null,
      metadata: sanitizeAuditMetadata(metadata || {}),
    }).then(() => {}, () => {});
  } catch (error) {
    // 감사 기록은 동기화 결과를 바꾸지 않는다
  }
}

export async function markIntegrationSyncStatus(ctx, ownerCode, status, errorText = null) {
  try {
    await ctx.supabaseAdmin
      .from("owner_google_integrations")
      .update({
        sync_status: status,
        sync_error: errorText ? cleanText(errorText, 500) : null,
        updated_at: new Date().toISOString(),
      })
      .eq("owner_agency_code", normalizeCode(ownerCode))
      .then(() => {}, () => {});
  } catch (error) {
    // 상태 기록 실패가 동기화를 막지 않는다
  }
}

async function markRowSyncState(ctx, rowId, values) {
  try {
    await ctx.supabaseAdmin
      .from("schedule_items")
      .update(values)
      .eq("id", rowId)
      .then(() => {}, () => {});
  } catch (error) {
    // 상태 기록 실패가 동기화를 막지 않는다
  }
}

// ─────────────────────────────────────────────────────────────
// outbound
// ─────────────────────────────────────────────────────────────

function syncedRowValues(event) {
  return {
    google_event_id: cleanText(event?.id, 1024) || null,
    google_etag: cleanText(event?.etag, 200) || null,
    google_updated_at: isoOrEmpty(event?.updated) || null,
    google_html_link: cleanText(event?.htmlLink, 1000) || null,
    google_sync_state: "synced",
    google_sync_error: null,
    google_synced_at: new Date().toISOString(),
  };
}

export async function pushRowToGoogle(ctx, env, options) {
  const { integration, accessToken, row, clientName = "", mode = "upsert", fetchImpl = fetch } = options;
  const ownerCode = normalizeCode(integration.owner_agency_code);
  // 원본 캘린더로 되돌려 쓴다. 이것을 전용 캘린더로 고정하면 primary 에서 온
  // 행을 지울 때 엉뚱한 캘린더에 404 를 날리고 "성공" 으로 처리하게 된다.
  const calendarId = cleanText(row.google_calendar_id) || cleanText(integration.calendar_id);
  if (!calendarId) return { ok: false, reason: "no_calendar" };

  if (mode === "delete") {
    if (!row.google_event_id) return { ok: true, skipped: true };
    // 반복 인스턴스는 DELETE 대신 status=cancelled 로 취소한다. 부모 시리즈까지
    // 지워질 가능성을 원천 차단한다.
    const result = row.google_recurring_event_id
      ? await googleFetch(accessToken, "PATCH", eventsPath(calendarId, row.google_event_id), { status: "cancelled" }, { fetchImpl })
      : await googleFetch(accessToken, "DELETE", eventsPath(calendarId, row.google_event_id), null, { fetchImpl });
    if (result.ok || result.status === 404 || result.status === 410) return { ok: true };
    return { ok: false, reason: `delete_${result.status}` };
  }

  const payload = buildGoogleEventPayload(row, { ownerCode, clientName });
  if (!payload) return { ok: false, reason: "invalid_row" };

  if (row.google_event_id) {
    const path = eventsPath(calendarId, row.google_event_id);
    const headers = row.google_etag ? { "if-match": row.google_etag } : {};
    let result = await googleFetch(accessToken, "PATCH", path, payload, { headers, fetchImpl });
    if (result.status === 412) {
      // 구글이 정본이다: 최신 etag 를 다시 받아 한 번만 재시도하고,
      // 그래도 충돌하면 다음 inbound 가 MI 를 구글 값으로 덮게 둔다.
      const fresh = await googleFetch(accessToken, "GET", path, null, { fetchImpl });
      if (fresh.ok && fresh.data?.etag) {
        result = await googleFetch(accessToken, "PATCH", path, payload, {
          headers: { "if-match": String(fresh.data.etag) },
          fetchImpl,
        });
      }
      if (result.status === 412) return { ok: false, reason: "etag_conflict" };
    }
    if (result.ok && result.data) {
      return { ok: true, values: { ...syncedRowValues(result.data), google_calendar_id: calendarId } };
    }
    if (result.status !== 404 && result.status !== 410) return { ok: false, reason: `patch_${result.status}` };
  }

  const created = await googleFetch(accessToken, "POST", eventsPath(calendarId), payload, { fetchImpl });
  if (!created.ok || !created.data?.id) return { ok: false, reason: `insert_${created.status}` };
  return { ok: true, values: { ...syncedRowValues(created.data), google_calendar_id: calendarId } };
}

// 삭제는 구글 우선(Google-first)이다. MI 행을 지우기 전에 구글에서 먼저 지우고,
// 지우지 못하면 MI 행을 남긴 채 호출자가 사용자에게 실패를 알리게 한다.
// 예전처럼 "지우고 나서 조용히 push" 하면 구글 호출이 어떤 이유로 실패해도
// (토큰 만료, 403, 5xx, 네트워크) 대표님 화면에서는 삭제가 성공한 것처럼 보이고
// 구글에는 일정이 그대로 남는다. 그 침묵이 이번 사고의 원인이다.
export async function deleteRowFromGoogle(ctx, env, access, row, fetchImpl = fetch) {
  if (!ownerSyncableRows(access, [row]).length) return { ok: true, skipped: true, reason: "scope" };
  if (!cleanText(row?.google_event_id)) return { ok: true, skipped: true, reason: "no-event" };
  const config = googleOauthConfig(env);
  if (!config.clientId || !config.clientSecret) return { ok: true, skipped: true, reason: "env" };
  const ownerCode = normalizeCode(access.ownerAgencyCode || primaryAgencyCode(env));
  const { integration, error } = await loadOwnerGoogleIntegration(ctx, ownerCode);
  // 연동을 끊은 뒤라면 구글 일정이 남는 것이 이미 약속된 동작이므로 로컬 삭제를 막지 않는다.
  if (error || !integration) return { ok: true, skipped: true, reason: "not-connected" };
  const token = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
  if (!token.ok) {
    if (token.reason === "invalid_grant") {
      await markIntegrationSyncStatus(ctx, ownerCode, "needs_reconnect", "구글 재연결이 필요합니다.");
      return { ok: false, reason: "needs_reconnect" };
    }
    return { ok: false, reason: "token" };
  }
  try {
    const result = await pushRowToGoogle(ctx, env, {
      integration,
      accessToken: token.accessToken,
      row,
      mode: "delete",
      fetchImpl,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason || "delete_failed" };
  } catch (unexpected) {
    return { ok: false, reason: "network" };
  }
}

// 구글 삭제가 실패했을 때의 흔적. 행은 남으므로 상태를 failed 로 되돌려
// 다음 동기화가 재시도 대상으로 잡게 하고, 감사 로그도 남긴다.
export async function recordGoogleDeleteFailure(ctx, row, reason) {
  await markRowSyncState(ctx, row.id, {
    google_sync_state: "failed",
    google_sync_error: cleanText(`delete:${reason}`, 500),
  });
  try {
    await ctx.supabaseAdmin.from("audit_logs").insert({
      actor_id: null,
      client_id: row.client_id || null,
      action: "google_calendar_sync_failed",
      target_table: "schedule_items",
      target_id: row.id || null,
      metadata: sanitizeAuditMetadata({
        mode: "delete",
        reason,
        failed: 1,
        total: 1,
        calendarId: cleanText(row.google_calendar_id, 200) || null,
        eventId: cleanText(row.google_event_id, 200) || null,
      }),
    }).then(() => {}, () => {});
  } catch (unexpected) {
    // 감사 기록 실패가 응답을 바꾸지 않는다
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// MI 저장 직후의 즉시 push. 구글이 실패해도 저장을 막지 않는다 —
// 행은 google_sync_state='pending' 으로 남아 다음 동기화가 재시도한다.
export async function syncOwnerScheduleRows(ctx, env, access, rows, mode, fetchImpl = fetch) {
  try {
    const targets = ownerSyncableRows(access, rows);
    if (!targets.length) return { skipped: true, reason: "scope" };
    const config = googleOauthConfig(env);
    if (!config.clientId || !config.clientSecret) return { skipped: true, reason: "env" };
    const ownerCode = normalizeCode(access.ownerAgencyCode || primaryAgencyCode(env));
    const { integration, error } = await loadOwnerGoogleIntegration(ctx, ownerCode);
    if (error || !integration) return { skipped: true, reason: "not-connected" };
    const token = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
    if (!token.ok) {
      if (token.reason === "invalid_grant") {
        await markIntegrationSyncStatus(ctx, ownerCode, "needs_reconnect", "구글 재연결이 필요합니다.");
      }
      return { skipped: false, synced: 0, failed: targets.length, reason: "token" };
    }

    const results = await mapWithConcurrency(targets, DEFAULT_PUSH_CONCURRENCY, async (row) => {
      try {
        const result = await pushRowToGoogle(ctx, env, {
          integration,
          accessToken: token.accessToken,
          row,
          clientName: rowClientName(row),
          mode,
          fetchImpl,
        });
        if (result.ok && result.values) await markRowSyncState(ctx, row.id, result.values);
        if (!result.ok) {
          await markRowSyncState(ctx, row.id, {
            google_sync_state: "failed",
            google_sync_error: cleanText(result.reason, 500) || "push_failed",
          });
        }
        return { ok: result.ok };
      } catch (rowError) {
        return { ok: false };
      }
    });

    const failed = results.filter((result) => !result.ok).length;
    if (failed > 0) {
      await ctx.supabaseAdmin.from("audit_logs").insert({
        actor_id: null,
        client_id: null,
        action: "google_calendar_sync_failed",
        target_table: "schedule_items",
        target_id: targets[0]?.id || null,
        metadata: sanitizeAuditMetadata({ mode, failed, total: targets.length }),
      }).then(() => {}, () => {});
    }
    return { skipped: false, synced: results.length - failed, failed };
  } catch (error) {
    return { skipped: false, synced: 0, failed: Array.isArray(rows) ? rows.length : 0, reason: "unexpected" };
  }
}

export async function pushPendingRows(ctx, env, ownerCode, integration, accessToken, options = {}) {
  const limit = options.pushLimit || DEFAULT_PUSH_LIMIT;
  const fetchImpl = options.fetchImpl || fetch;
  const { data, error } = await ctx.supabaseAdmin
    .from("schedule_items")
    .select(SYNC_ROW_FIELDS)
    .eq("owner_agency_code", normalizeCode(ownerCode))
    .in("google_sync_state", ["pending", "failed"])
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) return { pushed: 0, pushFailed: 0 };
  const rows = (data || []).filter((row) => row && !row.calendar_id);
  if (!rows.length) return { pushed: 0, pushFailed: 0 };

  const clientIds = [...new Set(rows.map((row) => row.client_id).filter(Boolean))];
  const clientsById = new Map();
  if (clientIds.length) {
    const lookup = await ctx.supabaseAdmin.from("clients").select("id, name, business_name").in("id", clientIds);
    for (const client of lookup.data || []) clientsById.set(client.id, client);
  }

  const results = await mapWithConcurrency(rows, DEFAULT_PUSH_CONCURRENCY, async (row) => {
    try {
      const result = await pushRowToGoogle(ctx, env, {
        integration,
        accessToken,
        row,
        clientName: rowClientName(row, clientsById),
        mode: "upsert",
        fetchImpl,
      });
      if (result.ok && result.values) await markRowSyncState(ctx, row.id, result.values);
      else if (!result.ok) {
        await markRowSyncState(ctx, row.id, {
          google_sync_state: "failed",
          google_sync_error: cleanText(result.reason, 500) || "push_failed",
        });
      }
      return result.ok;
    } catch (rowError) {
      return false;
    }
  });
  const pushFailed = results.filter((ok) => !ok).length;
  return { pushed: results.length - pushFailed, pushFailed };
}

// ─────────────────────────────────────────────────────────────
// inbound
// ─────────────────────────────────────────────────────────────

export async function resolveOwnerCalendars(ctx, ownerCode, integration, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const code = normalizeCode(ownerCode);
  const { data } = await ctx.supabaseAdmin
    .from("owner_google_calendar_sync")
    .select(CALENDAR_SYNC_FIELDS)
    .eq("owner_agency_code", code);
  const known = new Map((data || []).map((row) => [row.google_calendar_id, row]));

  const wanted = [];
  const dedicated = cleanText(integration.calendar_id);
  if (dedicated) wanted.push({ id: dedicated, role: "dedicated" });

  let primaryId = "";
  for (const row of known.values()) {
    if (row.calendar_role === "primary") primaryId = row.google_calendar_id;
  }
  if (!primaryId && options.accessToken) {
    // primary 는 "primary" 리터럴이 아니라 실제 id(이메일)로 고정한다.
    // 그러지 않으면 같은 캘린더가 두 id 로 두 번 동기화되어 행이 중복된다.
    const profile = await googleFetch(options.accessToken, "GET", "/calendars/primary", null, { fetchImpl });
    if (profile.ok && profile.data?.id) primaryId = String(profile.data.id);
  }
  if (primaryId && primaryId !== dedicated) wanted.push({ id: primaryId, role: "primary" });

  const calendars = [];
  for (const entry of wanted) {
    const existing = known.get(entry.id);
    if (existing) {
      calendars.push(existing);
      continue;
    }
    const fresh = {
      owner_agency_code: code,
      google_calendar_id: entry.id,
      calendar_role: entry.role,
      sync_token: null,
      full_sync_page_token: null,
      window_start: null,
      window_end: null,
      last_synced_at: null,
      last_full_sync_at: null,
      last_error: null,
      last_error_at: null,
    };
    await ctx.supabaseAdmin
      .from("owner_google_calendar_sync")
      .upsert(fresh, { onConflict: "owner_agency_code,google_calendar_id" })
      .then(() => {}, () => {});
    calendars.push(fresh);
  }
  return calendars;
}

async function saveCalendarSyncState(ctx, calendarRow, values) {
  await ctx.supabaseAdmin
    .from("owner_google_calendar_sync")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("owner_agency_code", calendarRow.owner_agency_code)
    .eq("google_calendar_id", calendarRow.google_calendar_id)
    .then(() => {}, () => {});
}

async function loadMatchingRows(ctx, calendarId, events) {
  const eventIds = [...new Set(events.map((event) => cleanText(event.id)).filter(Boolean))];
  const scheduleIds = [...new Set(events
    .map((event) => cleanText(eventPrivateProps(event).miScheduleId).toLowerCase())
    .filter(isUuid))];
  const byEvent = new Map();
  const byScheduleId = new Map();
  if (eventIds.length) {
    const { data } = await ctx.supabaseAdmin
      .from("schedule_items")
      .select(SYNC_ROW_FIELDS)
      .eq("google_calendar_id", calendarId)
      .in("google_event_id", eventIds);
    for (const row of data || []) byEvent.set(row.google_event_id, row);
  }
  if (scheduleIds.length) {
    const { data } = await ctx.supabaseAdmin
      .from("schedule_items")
      .select(SYNC_ROW_FIELDS)
      .in("id", scheduleIds);
    for (const row of data || []) byScheduleId.set(row.id, row);
  }
  return { byEvent, byScheduleId };
}

export function matchRowForEvent(event, maps, ownerCode) {
  const eventId = cleanText(event.id);
  const direct = maps.byEvent.get(eventId);
  if (direct) return { row: direct, via: "event" };
  const props = eventPrivateProps(event);
  const scheduleId = cleanText(props.miScheduleId).toLowerCase();
  if (!isUuid(scheduleId)) return { row: null, via: "" };
  const row = maps.byScheduleId.get(scheduleId);
  if (!row) return { row: null, via: "" };
  const propOwner = normalizeCode(props.miOwnerCode);
  if (propOwner && normalizeCode(ownerCode) !== propOwner) return { row: null, via: "" };
  if (row.owner_agency_code && normalizeCode(row.owner_agency_code) !== normalizeCode(ownerCode)) {
    return { row: null, via: "" };
  }
  // 대표가 구글에서 일정을 복사하면 같은 miScheduleId 가 둘이 된다. 매칭을
  // 허용하면 MI 행이 두 이벤트 사이를 오가며 진동하므로 복제본은 무시한다.
  if (row.google_event_id && row.google_event_id !== eventId) {
    return { row: null, via: "duplicate", conflictRow: row };
  }
  return { row, via: "schedule" };
}

async function applyEvents(ctx, ownerCode, calendarRow, events, window, counters) {
  const calendarId = calendarRow.google_calendar_id;
  const maps = await loadMatchingRows(ctx, calendarId, events);

  for (const event of events) {
    const match = matchRowForEvent(event, maps, ownerCode);
    if (match.via === "duplicate") {
      counters.skipped += 1;
      if (match.conflictRow?.id) {
        await markRowSyncState(ctx, match.conflictRow.id, { google_sync_error: "duplicate_copy" });
      }
      continue;
    }
    const row = match.row;

    if (eventIsCancelled(event)) {
      if (!row) { counters.skipped += 1; continue; }
      await ctx.supabaseAdmin.from("schedule_items").delete().eq("id", row.id).then(() => {}, () => {});
      await recordSyncAudit(ctx, "google_calendar_item_deleted", row.id, {
        calendarId,
        eventId: cleanText(event.id, 200),
        title: cleanText(row.title, 200),
        startsAt: row.starts_at,
        status: row.status,
        googleSource: row.google_source,
      });
      counters.deleted += 1;
      continue;
    }

    if (row && eventIsEcho(event, row)) { counters.skipped += 1; continue; }

    if (row) {
      const built = inboundUpdatePatch(event, row);
      if (!built.ok) {
        counters.skipped += 1;
        await markRowSyncState(ctx, row.id, {
          google_sync_state: "failed",
          google_sync_error: built.reason,
        });
        continue;
      }
      const patch = { ...built.patch };
      if (!row.google_calendar_id) patch.google_calendar_id = calendarId;
      if (!row.google_event_id) patch.google_event_id = cleanText(event.id, 1024);
      const { error } = await ctx.supabaseAdmin.from("schedule_items").update(patch).eq("id", row.id);
      if (error) {
        counters.skipped += 1;
        await markRowSyncState(ctx, row.id, {
          google_sync_state: "failed",
          google_sync_error: error.code === "23505" ? "series_conflict" : cleanText(error.message, 500),
        });
        continue;
      }
      counters.updated += 1;
      continue;
    }

    const times = googleEventTimes(event);
    if (!times.ok) { counters.skipped += 1; continue; }
    // 이미 MI 에 있는 행은 윈도우와 무관하게 반영하지만, 새 이벤트는
    // 윈도우 밖이면 들이지 않는다. sync token 이 범위를 기억하든 말든 같은 결과가 된다.
    if (!eventInWindow(times.startsAt, window)) { counters.skipped += 1; continue; }
    const insertRow = mapGoogleEventToScheduleRow(event, { ownerCode, calendarId });
    if (!insertRow) { counters.skipped += 1; continue; }
    const { error } = await ctx.supabaseAdmin.from("schedule_items").insert(insertRow);
    if (error) { counters.skipped += 1; continue; }
    counters.imported += 1;
  }
}

export async function syncOneCalendar(ctx, ownerCode, calendarRow, accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const nowMs = options.now || Date.now();
  const deadlineAt = options.deadlineAt || Number.POSITIVE_INFINITY;
  const counters = { imported: 0, updated: 0, deleted: 0, skipped: 0 };

  const resuming = Boolean(cleanText(calendarRow.full_sync_page_token));
  let incremental = resuming
    ? Boolean(cleanText(calendarRow.sync_token))
    : options.mode !== "full" && Boolean(cleanText(calendarRow.sync_token));
  let window = incremental && calendarRow.window_start && calendarRow.window_end
    ? { timeMin: new Date(calendarRow.window_start).toISOString(), timeMax: new Date(calendarRow.window_end).toISOString() }
    : syncWindow(nowMs);
  if (resuming && calendarRow.window_start && calendarRow.window_end) {
    window = { timeMin: new Date(calendarRow.window_start).toISOString(), timeMax: new Date(calendarRow.window_end).toISOString() };
  }

  let pageToken = resuming ? cleanText(calendarRow.full_sync_page_token) : "";
  let nextSyncToken = "";
  let pages = 0;
  let partial = false;
  let fullResync = false;
  let recovered410 = false;
  let failure = "";

  while (true) {
    const query = { singleEvents: "true", showDeleted: "true", maxResults: String(options.pageSize || DEFAULT_PAGE_SIZE) };
    if (incremental) {
      query.syncToken = cleanText(calendarRow.sync_token);
    } else {
      // timeMin/timeMax 는 syncToken 과 함께 쓸 수 없다. full sync 에서만 붙인다.
      query.timeMin = window.timeMin;
      query.timeMax = window.timeMax;
    }
    if (pageToken) query.pageToken = pageToken;

    const result = await googleFetch(accessToken, "GET", eventsPath(calendarRow.google_calendar_id), null, { query, fetchImpl });

    if (result.status === 410 && !recovered410) {
      // sync token 무효 → 저장분을 버리고 같은 호출 안에서 full sync 로 되돌린다.
      recovered410 = true;
      fullResync = true;
      incremental = false;
      pageToken = "";
      nextSyncToken = "";
      pages = 0;
      window = syncWindow(nowMs);
      await saveCalendarSyncState(ctx, calendarRow, { sync_token: null, full_sync_page_token: null });
      calendarRow = { ...calendarRow, sync_token: null, full_sync_page_token: null };
      continue;
    }
    if (!result.ok) {
      failure = `list_${result.status}`;
      break;
    }

    const events = Array.isArray(result.data?.items) ? result.data.items : [];
    if (events.length) await applyEvents(ctx, ownerCode, calendarRow, events, window, counters);

    pages += 1;
    pageToken = cleanText(result.data?.nextPageToken);
    if (result.data?.nextSyncToken) nextSyncToken = String(result.data.nextSyncToken);
    if (!pageToken) break;
    if (pages >= maxPages || Date.now() >= deadlineAt) { partial = true; break; }
  }

  const nowIso = new Date(nowMs).toISOString();
  if (failure) {
    await saveCalendarSyncState(ctx, calendarRow, { last_error: cleanText(failure, 500), last_error_at: nowIso });
  } else if (partial) {
    // 중단 시 sync token 은 건드리지 않는다. nextSyncToken 은 마지막 페이지에만
    // 오므로, 반쯤 진행한 상태에서 토큰을 갱신하면 남은 변경을 영원히 잃는다.
    await saveCalendarSyncState(ctx, calendarRow, {
      full_sync_page_token: pageToken,
      window_start: window.timeMin,
      window_end: window.timeMax,
      last_error: null,
      last_error_at: null,
    });
  } else {
    await saveCalendarSyncState(ctx, calendarRow, {
      sync_token: nextSyncToken || calendarRow.sync_token || null,
      full_sync_page_token: null,
      window_start: window.timeMin,
      window_end: window.timeMax,
      last_synced_at: nowIso,
      ...(incremental ? {} : { last_full_sync_at: nowIso }),
      last_error: null,
      last_error_at: null,
    });
  }

  return {
    calendarId: calendarRow.google_calendar_id,
    role: calendarRow.calendar_role,
    ...counters,
    fullResync,
    partial,
    error: failure || null,
  };
}

// ─────────────────────────────────────────────────────────────
// 오케스트레이션
// ─────────────────────────────────────────────────────────────

export async function runOwnerCalendarSync(ctx, env, ownerCode, options = {}) {
  const code = normalizeCode(ownerCode || primaryAgencyCode(env));
  const fetchImpl = options.fetchImpl || fetch;
  const nowMs = options.now || Date.now();
  const empty = { pushed: 0, pushFailed: 0, calendars: [], changed: 0 };

  const config = googleOauthConfig(env);
  if (!config.clientId || !config.clientSecret) {
    return { ok: false, reason: "env", ...empty, lastSyncAt: null };
  }
  const { integration, error } = await loadOwnerGoogleIntegration(ctx, code);
  if (error || !integration) {
    return { ok: false, reason: "not-connected", ...empty, lastSyncAt: null };
  }
  // needs_reconnect 인 동안 구글을 계속 두드리면 400 폭풍이 난다.
  if (integration.sync_status === "needs_reconnect") {
    return { ok: true, needsReconnect: true, ...empty, lastSyncAt: integration.last_sync_at || null };
  }

  const token = await refreshAccessToken(integration.refresh_token, env, fetchImpl);
  if (!token.ok) {
    if (token.reason === "invalid_grant") {
      await markIntegrationSyncStatus(ctx, code, "needs_reconnect", "구글 재연결이 필요합니다.");
      return { ok: true, needsReconnect: true, ...empty, lastSyncAt: integration.last_sync_at || null };
    }
    await markIntegrationSyncStatus(ctx, code, "error", "구글 토큰을 갱신하지 못했습니다.");
    return { ok: false, reason: "token", ...empty, lastSyncAt: integration.last_sync_at || null };
  }

  const deadlineAt = Date.now() + (options.budgetMs || DEFAULT_BUDGET_MS);
  const push = await pushPendingRows(ctx, env, code, integration, token.accessToken, {
    pushLimit: options.pushLimit,
    fetchImpl,
  });

  const calendars = await resolveOwnerCalendars(ctx, code, integration, {
    accessToken: token.accessToken,
    fetchImpl,
  });

  // 마지막 full sync 가 하루 넘게 지났으면 이번 실행을 full 로 올린다.
  // incremental 은 "변경된" 이벤트만 주므로, 시간이 흘러 윈도우 안으로 들어온
  // (그러나 변경되지 않은) 이벤트는 full sync 없이는 영원히 오지 않는다.
  const results = [];
  for (const calendarRow of calendars) {
    const lastFull = new Date(cleanText(calendarRow.last_full_sync_at)).getTime();
    const stale = !Number.isFinite(lastFull) || nowMs - lastFull >= FULL_SYNC_INTERVAL_MS;
    const mode = options.mode === "full" || stale ? "full" : "incremental";
    results.push(await syncOneCalendar(ctx, code, calendarRow, token.accessToken, {
      mode,
      now: nowMs,
      deadlineAt,
      maxPages: options.maxPages,
      pageSize: options.pageSize,
      fetchImpl,
    }));
  }

  const changed = results.reduce((total, result) => total + result.imported + result.updated + result.deleted, 0);
  const failed = results.find((result) => result.error);
  const lastSyncAt = new Date(nowMs).toISOString();
  await ctx.supabaseAdmin
    .from("owner_google_integrations")
    .update({
      last_sync_at: lastSyncAt,
      sync_status: failed ? "error" : "ok",
      sync_error: failed ? cleanText(failed.error, 500) : null,
      updated_at: lastSyncAt,
    })
    .eq("owner_agency_code", code)
    .then(() => {}, () => {});

  return {
    ok: true,
    needsReconnect: false,
    pushed: push.pushed,
    pushFailed: push.pushFailed,
    calendars: results,
    changed,
    lastSyncAt,
    error: failed ? failed.error : null,
  };
}

export { DONE_PREFIX, decorateGoogleSummary, normalizeImportedTitle, undecorateGoogleSummary };
