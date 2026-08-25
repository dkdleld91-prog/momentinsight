import assert from "node:assert/strict";
import test from "node:test";

import {
  CALENDAR_COLOR_PALETTE,
  EVENT_COLOR_DISPLAY_ORDER,
  EVENT_COLOR_PALETTE,
  buildGoogleEventPayload,
  conferenceUriFromEvent,
  decorateGoogleSummary,
  describeRecurrence,
  eventColorName,
  isEventColorId,
  modernCalendarColor,
  modernEventColor,
  normalizeAttendeeList,
  normalizeHexColor,
  normalizeImportedTitle,
  readableTextColor,
  seriesAnchorTimes,
  undecorateGoogleSummary,
  validateRecurrenceLines,
} from "../google-calendar-client.mjs";
import {
  CALENDAR_INVITE_ROLES,
  FULL_SYNC_INTERVAL_MS,
  FULL_SYNC_JITTER_MS,
  MAX_CALENDAR_INVITES,
  MAX_FULL_SYNC_EVENTS,
  MAX_SYNC_CALENDARS,
  OPTIONAL_CALENDAR_CATALOG_COLUMNS,
  OPTIONAL_COLUMN_RETRY_MS,
  OPTIONAL_EVENT_COLOR_COLUMNS,
  OPTIONAL_SCHEDULE_COLUMNS,
  colorBackfillPatch,
  createOwnerCalendar,
  deleteOwnerCalendarAcl,
  disableOptionalColumns,
  disabledOptionalColumns,
  eventInWindow,
  eventIsEcho,
  fullSyncIntervalMs,
  googleEventTimes,
  googleMirrorFields,
  hexColor,
  inboundUpdatePatch,
  insertOwnerCalendarAcl,
  listOwnerCalendarAcl,
  listOwnerCalendarCatalog,
  listOwnerWritableCalendars,
  mapGoogleEventToScheduleRow,
  materializeRecurringInstances,
  matchRowForEvent,
  optionalColumnEnabled,
  ownerSyncableRows,
  pushPendingRows,
  pushRowToGoogle,
  refreshOwnerCalendarCatalog,
  resetOptionalColumns,
  resolveOwnerCalendars,
  retireDedicatedCalendar,
  runOwnerCalendarSync,
  runWithOptionalColumns,
  setOptionalColumnClock,
  setOwnerCalendarVisibility,
  shouldPromoteFullSync,
  syncOneCalendar,
  syncWindow,
  writeRowToGoogleFirst,
} from "./google-calendar-sync.mjs";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ENV = { GOOGLE_OAUTH_CLIENT_ID: "cid-1", GOOGLE_OAUTH_CLIENT_SECRET: "sec-1" };
const OWNER = "mml93-a01";
const NOW = Date.parse("2026-08-23T00:00:00.000Z");

const INTEGRATION = {
  owner_agency_code: OWNER,
  refresh_token: "rt-1",
  calendar_id: "dedicated@group.calendar.google.com",
  google_email: "owner@example.com",
  sync_status: "ok",
  last_sync_at: null,
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

// 라우트는 "METHOD url"(쿼리 제외) 키로 잡는다. 쿼리는 call.query 로 검사한다.
function fetchMock(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const full = String(url);
    const [base, search = ""] = full.split("?");
    const method = options.method || "GET";
    const call = { method, url: base, query: Object.fromEntries(new URLSearchParams(search)), options, full };
    calls.push(call);
    const route = routes[`${method} ${base}`];
    if (route === undefined) throw new Error(`unexpected fetch: ${method} ${base}`);
    return typeof route === "function" ? route(call) : route;
  };
  return { calls, impl };
}

// 순차 응답을 명확하게 다루기 위한 단순 큐 라우트.
function sequence(...responses) {
  let index = 0;
  return (call) => {
    const item = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof item === "function" ? item(call) : item;
  };
}

function tokenRoute(accessToken = "gat-1") {
  return () => jsonResponse(200, { access_token: accessToken });
}

function makeCtx(tables = {}) {
  const ops = [];
  const resolve = (op) => {
    const handler = tables[op.table];
    const out = typeof handler === "function" ? handler(op) : handler;
    return out === undefined ? { data: null, error: null } : out;
  };
  const from = (table) => {
    const op = { table, kind: "select", values: null, filters: [], fields: "", limit: 0 };
    const query = {
      select(fields) { op.fields = fields || ""; return query; },
      insert(values) { op.kind = "insert"; op.values = values; return query; },
      update(values) { op.kind = "update"; op.values = values; return query; },
      upsert(values, options) { op.kind = "upsert"; op.values = values; op.options = options; return query; },
      delete() { op.kind = "delete"; return query; },
      eq(column, value) { op.filters.push(["eq", column, value]); return query; },
      in(column, value) { op.filters.push(["in", column, value]); return query; },
      is(column, value) { op.filters.push(["is", column, value]); return query; },
      or(expression) { op.filters.push(["or", expression]); return query; },
      gte(column, value) { op.filters.push(["gte", column, value]); return query; },
      gt(column, value) { op.filters.push(["gt", column, value]); return query; },
      lte(column, value) { op.filters.push(["lte", column, value]); return query; },
      lt(column, value) { op.filters.push(["lt", column, value]); return query; },
      order() { return query; },
      limit(value) { op.limit = value; return query; },
      maybeSingle() { ops.push(op); return Promise.resolve(resolve(op)); },
      then(onOk, onErr) { ops.push(op); return Promise.resolve(resolve(op)).then(onOk, onErr); },
    };
    return query;
  };
  const rpc = async () => ({ data: null, error: null });
  return { ctx: { supabaseAdmin: { from, rpc } }, ops };
}

function opsFor(ops, table, kind) {
  return ops.filter((op) => op.table === table && op.kind === kind);
}

function calendarRow(values = {}) {
  return {
    owner_agency_code: OWNER,
    google_calendar_id: "primary@example.com",
    calendar_role: "primary",
    sync_token: null,
    full_sync_page_token: null,
    window_start: null,
    window_end: null,
    last_synced_at: null,
    last_full_sync_at: null,
    ...values,
  };
}

function timedEvent(values = {}) {
  return {
    id: "gev-1",
    status: "confirmed",
    summary: "구글 회의",
    etag: '"e1"',
    updated: "2026-08-22T10:00:00.000Z",
    htmlLink: "https://calendar.google.com/event?eid=1",
    start: { dateTime: "2026-08-24T06:00:00.000Z" },
    end: { dateTime: "2026-08-24T07:00:00.000Z" },
    ...values,
  };
}

// ─────────────────────────────────────────────────────────────
// 순수 함수
// ─────────────────────────────────────────────────────────────

test("timed google events map to absolute ISO instants and default to one hour", () => {
  assert.deepEqual(googleEventTimes(timedEvent()), {
    ok: true, isAllDay: false,
    startsAt: "2026-08-24T06:00:00.000Z", endsAt: "2026-08-24T07:00:00.000Z",
  });
  const noEnd = googleEventTimes(timedEvent({ end: {} }));
  assert.equal(noEnd.endsAt, "2026-08-24T07:00:00.000Z");
  const reversed = googleEventTimes(timedEvent({ end: { dateTime: "2026-08-24T05:00:00.000Z" } }));
  assert.equal(reversed.endsAt, reversed.startsAt, "종료가 시작보다 빠르면 시작으로 클램프한다");
  assert.deepEqual(googleEventTimes({ start: {}, end: {} }), { ok: false });
});

test("all-day google events collapse the exclusive end date back to the inclusive last day", () => {
  const twoDays = googleEventTimes({ start: { date: "2026-08-24" }, end: { date: "2026-08-26" } });
  assert.deepEqual(twoDays, {
    ok: true, isAllDay: true,
    startsAt: "2026-08-23T15:00:00.000Z",
    endsAt: "2026-08-24T15:00:00.000Z",
  });
  const oneDay = googleEventTimes({ start: { date: "2026-08-24" }, end: { date: "2026-08-25" } });
  assert.equal(oneDay.startsAt, oneDay.endsAt, "하루짜리는 ends_at === starts_at 이라 date_order 를 만족한다");
});

test("imported titles are clamped to the 1..120 character column constraint", () => {
  assert.equal(normalizeImportedTitle(""), "(제목 없음)");
  assert.equal(normalizeImportedTitle("   "), "(제목 없음)");
  assert.equal(normalizeImportedTitle(undefined), "(제목 없음)");
  assert.equal(normalizeImportedTitle("가  나\n다"), "가 나 다");
  assert.equal(Array.from(normalizeImportedTitle("가".repeat(400))).length, 120);
  const emoji = normalizeImportedTitle("😀".repeat(200));
  assert.equal(Array.from(emoji).length, 120);
  assert.ok(!emoji.includes("�"), "서로게이트 쌍이 쪼개지지 않는다");
});

test("summary decoration round-trips exactly and only when we wrote the marker", () => {
  const cases = [
    [{ title: "보고", status: "done" }, "모먼트커피"],
    [{ title: "보고", status: "done" }, ""],
    [{ title: "보고", status: "planned" }, "모먼트커피"],
    [{ title: "보고", status: "planned" }, ""],
    [{ title: "✓ 체크리스트", status: "done" }, ""],
    [{ title: "[대괄호] 제목", status: "planned" }, "모먼트커피"],
    [{ title: "✓ [x] 겹침", status: "done" }, "모먼트커피"],
  ];
  for (const [row, clientName] of cases) {
    const summary = decorateGoogleSummary(row, clientName);
    const props = { miStatus: row.status, ...(clientName ? { miClientName: clientName } : {}) };
    assert.equal(undecorateGoogleSummary(summary, props), row.title, JSON.stringify([row, clientName]));
  }
  // 구글에서 만든 이벤트는 부기 속성이 없으므로 아무것도 벗기지 않는다.
  assert.equal(undecorateGoogleSummary("✓ [모먼트] 원문", {}), "✓ [모먼트] 원문");
});

test("inbound patches carry google-owned fields only", () => {
  const built = inboundUpdatePatch(timedEvent(), { id: "row-1", google_calendar_id: "primary@example.com" });
  assert.ok(built.ok);
  const forbidden = [
    "schedule_type", "priority", "visibility", "public_title", "public_comment",
    "internal_note", "assignee_name", "client_id", "operation_team_id",
    "owner_agency_code", "series_id", "recurrence_kind", "recurrence_until", "status",
  ];
  for (const key of forbidden) {
    assert.ok(!(key in built.patch), `${key} 는 구글이 소유하지 않는다`);
  }
  assert.equal(built.patch.title, "구글 회의");
  assert.equal(built.patch.google_etag, '"e1"');
  assert.equal(built.patch.google_updated_at, "2026-08-22T10:00:00.000Z");
});

test("series rows recompute occurrence_on and refuse moves past the recurrence window", () => {
  const row = { id: "row-1", series_id: "s-1", recurrence_until: "2026-12-31" };
  const moved = inboundUpdatePatch(timedEvent({ start: { dateTime: "2026-09-02T01:00:00.000Z" }, end: {} }), row);
  assert.ok(moved.ok);
  assert.equal(moved.patch.occurrence_on, "2026-09-02", "서울 기준 시작일과 일치해야 제약을 통과한다");

  const beyond = inboundUpdatePatch(timedEvent({ start: { dateTime: "2027-03-01T01:00:00.000Z" }, end: {} }), row);
  assert.deepEqual(beyond, { ok: false, reason: "series_window" });
});

test("the echo guard drops anything not newer than the recorded google version", () => {
  const row = { google_updated_at: "2026-08-22T10:00:00.000Z" };
  assert.equal(eventIsEcho(timedEvent(), row), true, "같은 시각은 우리가 쓴 메아리다");
  assert.equal(eventIsEcho(timedEvent({ updated: "2026-08-22T09:00:00.000Z" }), row), true);
  assert.equal(eventIsEcho(timedEvent({ updated: "2026-08-22T11:00:00.000Z" }), row), false);
  assert.equal(eventIsEcho(timedEvent(), { google_updated_at: null }), false);
  assert.equal(eventIsEcho(timedEvent(), null), false);
});

test("google-origin rows land in the internal scope with every recurrence column null", () => {
  const row = mapGoogleEventToScheduleRow(timedEvent(), { ownerCode: OWNER, calendarId: "primary@example.com" });
  assert.equal(row.owner_agency_code, OWNER);
  assert.equal(row.client_id, null);
  assert.equal(row.operation_team_id, null);
  assert.equal(row.calendar_id, null);
  assert.equal(row.visibility, "internal");
  assert.equal(row.schedule_type, "meeting");
  assert.equal(row.status, "planned");
  assert.equal(row.google_source, "google");
  assert.equal(row.google_calendar_id, "primary@example.com");
  assert.equal(row.internal_note, null);
  for (const key of ["series_id", "occurrence_on", "recurrence_kind", "recurrence_until"]) {
    assert.ok(!(key in row), `${key} 는 넣지 않는다 (recurrence_coherent 제약)`);
  }
});

test("owner-authored rows of every scope are syncable, foreign and shared rows are not", () => {
  const access = { role: "owner", ownerAgencyCode: "MML93-A01" };
  const rows = [
    { id: "a" },
    { id: "b", client_id: "c1" },
    { id: "c", operation_team_id: "t1" },
    { id: "d", owner_agency_code: "mml93-a01" },
    { id: "e", owner_agency_code: "other-a01" },
    { id: "f", calendar_id: "shared" },
  ];
  assert.deepEqual(ownerSyncableRows(access, rows).map((row) => row.id), ["a", "b", "c", "d"]);
  assert.deepEqual(ownerSyncableRows({ role: "team" }, rows), []);
  assert.deepEqual(ownerSyncableRows(null, rows), []);
});

test("the import window bounds new events only", () => {
  const window = syncWindow(NOW);
  assert.equal(eventInWindow("2026-08-24T00:00:00.000Z", window), true);
  assert.equal(eventInWindow("2026-06-01T00:00:00.000Z", window), false, "31일보다 오래된 과거");
  assert.equal(eventInWindow("2028-01-01T00:00:00.000Z", window), false);
  assert.equal(eventInWindow("not-a-date", window), false);
});

test("event matching prefers the calendar/event key and refuses duplicate copies", () => {
  const row = { id: "11111111-1111-4111-8111-111111111111", owner_agency_code: OWNER, google_event_id: "gev-1" };
  const maps = { byEvent: new Map([["gev-1", row]]), byScheduleId: new Map([[row.id, row]]) };
  assert.deepEqual(matchRowForEvent({ id: "gev-1" }, maps, OWNER), { row, via: "event" });

  const legacy = { id: row.id, owner_agency_code: OWNER, google_event_id: null };
  const legacyMaps = { byEvent: new Map(), byScheduleId: new Map([[row.id, legacy]]) };
  const byProp = matchRowForEvent(
    { id: "gev-9", extendedProperties: { private: { miScheduleId: row.id, miOwnerCode: OWNER } } },
    legacyMaps, OWNER,
  );
  assert.equal(byProp.via, "schedule");

  const copy = matchRowForEvent(
    { id: "gev-copy", extendedProperties: { private: { miScheduleId: row.id } } },
    maps, OWNER,
  );
  assert.equal(copy.via, "duplicate");
  assert.equal(copy.row, null);
  assert.equal(copy.conflictRow.id, row.id);
});

// ─────────────────────────────────────────────────────────────
// inbound 엔진
// ─────────────────────────────────────────────────────────────

test("a full sync bounds the request, imports new events, and stores the sync token", async () => {
  const { ctx, ops } = makeCtx({ schedule_items: { data: [], error: null } });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`GET ${eventsUrl}`]: jsonResponse(200, { items: [timedEvent()], nextSyncToken: "st-1" }),
  });

  const result = await syncOneCalendar(ctx, OWNER, calendarRow(), "gat-1", { mode: "full", now: NOW, fetchImpl: impl });

  assert.equal(result.imported, 1);
  assert.equal(calls[0].query.singleEvents, "true");
  assert.equal(calls[0].query.showDeleted, "true");
  assert.equal(calls[0].query.timeMin, syncWindow(NOW).timeMin);
  assert.equal(calls[0].query.timeMax, syncWindow(NOW).timeMax);
  assert.ok(!("syncToken" in calls[0].query), "full sync 에는 syncToken 을 붙이지 않는다");

  const inserted = opsFor(ops, "schedule_items", "insert");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].values.title, "구글 회의");
  const saved = opsFor(ops, "owner_google_calendar_sync", "update").at(-1);
  assert.equal(saved.values.sync_token, "st-1");
  assert.equal(saved.values.full_sync_page_token, null);
  assert.ok(saved.values.last_full_sync_at);
});

test("an incremental sync sends the token and never sends timeMin or timeMax", async () => {
  const { ctx } = makeCtx({ schedule_items: { data: [], error: null } });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`GET ${eventsUrl}`]: jsonResponse(200, { items: [], nextSyncToken: "st-2" }),
  });

  await syncOneCalendar(ctx, OWNER, calendarRow({ sync_token: "st-1" }), "gat-1", { now: NOW, fetchImpl: impl });

  assert.equal(calls[0].query.syncToken, "st-1");
  assert.ok(!("timeMin" in calls[0].query), "timeMin 은 syncToken 과 함께 쓸 수 없다");
  assert.ok(!("timeMax" in calls[0].query));
});

test("events outside the window are skipped when new but still applied when already stored", async () => {
  const far = timedEvent({ id: "gev-far", start: { dateTime: "2028-01-01T00:00:00.000Z" }, end: {} });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;

  const fresh = makeCtx({ schedule_items: { data: [], error: null } });
  const mockA = fetchMock({ [`GET ${eventsUrl}`]: jsonResponse(200, { items: [far], nextSyncToken: "st" }) });
  const skipped = await syncOneCalendar(fresh.ctx, OWNER, calendarRow(), "gat-1", { mode: "full", now: NOW, fetchImpl: mockA.impl });
  assert.equal(skipped.imported, 0);
  assert.equal(skipped.skipped, 1);
  assert.equal(opsFor(fresh.ops, "schedule_items", "insert").length, 0);

  const known = { id: "row-far", owner_agency_code: OWNER, google_event_id: "gev-far", google_calendar_id: "primary@example.com" };
  const stored = makeCtx({
    schedule_items: (op) => (op.kind === "select"
      ? { data: op.filters.some((f) => f[1] === "google_event_id") ? [known] : [], error: null }
      : { data: null, error: null }),
  });
  const mockB = fetchMock({ [`GET ${eventsUrl}`]: jsonResponse(200, { items: [far], nextSyncToken: "st" }) });
  const applied = await syncOneCalendar(stored.ctx, OWNER, calendarRow(), "gat-1", { mode: "full", now: NOW, fetchImpl: mockB.impl });
  assert.equal(applied.updated, 1, "이미 MI 에 있는 행은 윈도우와 무관하게 갱신한다");
});

test("pagination keeps the same parameters and takes the token from the last page only", async () => {
  const { ctx, ops } = makeCtx({ schedule_items: { data: [], error: null } });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`GET ${eventsUrl}`]: sequence(
      jsonResponse(200, { items: [], nextPageToken: "pt-2" }),
      jsonResponse(200, { items: [], nextSyncToken: "st-final" }),
    ),
  });

  await syncOneCalendar(ctx, OWNER, calendarRow({ sync_token: "st-0" }), "gat-1", { now: NOW, fetchImpl: impl });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].query.pageToken, "pt-2");
  assert.equal(calls[1].query.syncToken, "st-0", "페이지를 넘겨도 같은 파라미터 집합을 유지한다");
  assert.equal(opsFor(ops, "owner_google_calendar_sync", "update").at(-1).values.sync_token, "st-final");
});

test("hitting the page cap parks the page token and leaves the sync token untouched", async () => {
  const { ctx, ops } = makeCtx({ schedule_items: { data: [], error: null } });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;
  const { impl } = fetchMock({
    [`GET ${eventsUrl}`]: jsonResponse(200, { items: [], nextPageToken: "pt-next" }),
  });

  const result = await syncOneCalendar(ctx, OWNER, calendarRow(), "gat-1", {
    mode: "full", now: NOW, maxPages: 2, fetchImpl: impl,
  });

  assert.equal(result.partial, true);
  const saved = opsFor(ops, "owner_google_calendar_sync", "update").at(-1);
  assert.equal(saved.values.full_sync_page_token, "pt-next");
  assert.ok(!("sync_token" in saved.values), "반쯤 진행한 상태에서 토큰을 갱신하면 남은 변경을 잃는다");
});

test("a cancelled event deletes the matched row and writes an audit trail", async () => {
  const row = {
    id: "row-1", owner_agency_code: OWNER, title: "지울 일정", status: "planned",
    starts_at: "2026-08-24T06:00:00.000Z", google_event_id: "gev-1",
    google_calendar_id: "primary@example.com", google_source: "google",
  };
  const { ctx, ops } = makeCtx({
    schedule_items: (op) => (op.kind === "select"
      ? { data: op.filters.some((f) => f[1] === "google_event_id") ? [row] : [], error: null }
      : { data: null, error: null }),
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;
  const { impl } = fetchMock({
    [`GET ${eventsUrl}`]: jsonResponse(200, {
      items: [
        timedEvent({ status: "cancelled" }),
        timedEvent({ id: "gev-unknown", status: "cancelled" }),
      ],
      nextSyncToken: "st",
    }),
  });

  const result = await syncOneCalendar(ctx, OWNER, calendarRow({ sync_token: "st-0" }), "gat-1", { now: NOW, fetchImpl: impl });

  assert.equal(result.deleted, 1);
  assert.equal(result.skipped, 1, "매칭되지 않는 취소는 무시한다");
  assert.deepEqual(opsFor(ops, "schedule_items", "delete")[0].filters, [["eq", "id", "row-1"]]);
  // 순번이 아니라 action 으로 짚는다 — 감사 줄이 하나 늘어도 이 단언은 흔들리지 않는다.
  const audit = opsFor(ops, "audit_logs", "insert")
    .map((op) => op.values)
    .find((values) => values.action === "google_calendar_item_deleted");
  assert.ok(audit, "취소 반영은 google_calendar_item_deleted 로 남는다");
  assert.equal(audit.metadata.title, "지울 일정");
  assert.equal(audit.metadata.eventId, "gev-1");
});

test("a 410 clears the token and falls back to a full sync inside the same run", async () => {
  const { ctx, ops } = makeCtx({ schedule_items: { data: [], error: null } });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`GET ${eventsUrl}`]: sequence(
      jsonResponse(410, { error: { code: 410, message: "Sync token is no longer valid" } }),
      jsonResponse(200, { items: [timedEvent()], nextSyncToken: "st-fresh" }),
    ),
  });

  const result = await syncOneCalendar(ctx, OWNER, calendarRow({ sync_token: "st-stale" }), "gat-1", { now: NOW, fetchImpl: impl });

  assert.equal(result.fullResync, true);
  assert.equal(result.imported, 1);
  assert.equal(calls[0].query.syncToken, "st-stale");
  assert.ok(!("syncToken" in calls[1].query), "재동기화는 토큰 없이 시작한다");
  assert.equal(calls[1].query.timeMin, syncWindow(NOW).timeMin);
  assert.equal(opsFor(ops, "owner_google_calendar_sync", "update").at(-1).values.sync_token, "st-fresh");
});

test("an echo of our own write produces no database mutation at all", async () => {
  const row = {
    id: "row-1", owner_agency_code: OWNER, google_event_id: "gev-1",
    google_calendar_id: "primary@example.com",
    google_updated_at: "2026-08-22T10:00:00.000Z",
  };
  const { ctx, ops } = makeCtx({
    schedule_items: (op) => (op.kind === "select"
      ? { data: op.filters.some((f) => f[1] === "google_event_id") ? [row] : [], error: null }
      : { data: null, error: null }),
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;
  const { impl } = fetchMock({
    [`GET ${eventsUrl}`]: jsonResponse(200, { items: [timedEvent()], nextSyncToken: "st" }),
  });

  const result = await syncOneCalendar(ctx, OWNER, calendarRow({ sync_token: "st-0" }), "gat-1", { now: NOW, fetchImpl: impl });

  assert.equal(result.skipped, 1);
  assert.equal(result.updated, 0);
  assert.equal(opsFor(ops, "schedule_items", "update").length, 0);
  assert.equal(opsFor(ops, "schedule_items", "insert").length, 0);
  assert.equal(opsFor(ops, "schedule_items", "delete").length, 0);
});

// ─────────────────────────────────────────────────────────────
// 메아리 뒤의 색 보정
//
// google_color_id 열이 생기기 전에 들어온 행은, 구글에서 그 일정을 다시 건드리지
// 않는 한 메아리 가드에 막혀 영영 색을 받지 못했다. 색 한 열만 그 가드를 비껴간다.
// ─────────────────────────────────────────────────────────────

const ECHO_EVENTS_URL = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;

function echoRow(values = {}) {
  return {
    id: "row-1", owner_agency_code: OWNER, google_event_id: "gev-1",
    google_calendar_id: "primary@example.com",
    google_updated_at: "2026-08-22T10:00:00.000Z",
    google_etag: '"e1"',
    google_color_id: null,
    title: "구글 회의",
    starts_at: "2026-08-24T06:00:00.000Z",
    ...values,
  };
}

// 실제 DB 처럼 쓴 값을 행에 반영한다 — 두 번째 실행이 같은 행을 다시 본다.
function echoSyncCtx(row) {
  return makeCtx({
    schedule_items: (op) => {
      if (op.kind === "select") {
        return { data: op.filters.some((filter) => filter[1] === "google_event_id") ? [row] : [], error: null };
      }
      if (op.kind === "update") Object.assign(row, op.values);
      return { data: null, error: null };
    },
  });
}

function echoSync(ctx, impl) {
  return syncOneCalendar(ctx, OWNER, calendarRow({ sync_token: "st-0" }), "gat-1", { now: NOW, fetchImpl: impl });
}

test("the color backfill fires only on a real change and never on a missing key", () => {
  assert.deepEqual(colorBackfillPatch(timedEvent({ colorId: "10" }), { google_color_id: null }), { google_color_id: "10" });
  assert.deepEqual(colorBackfillPatch(timedEvent({ colorId: "10" }), {}), { google_color_id: "10" },
    "열이 없어 안 읽힌 값은 비어 있는 것으로 본다");
  assert.deepEqual(Object.keys(colorBackfillPatch(timedEvent({ colorId: "10" }), {})), ["google_color_id"],
    "제목·시각·etag 는 절대 함께 실리지 않는다");
  assert.equal(colorBackfillPatch(timedEvent({ colorId: "10" }), { google_color_id: "10" }), null, "같은 색이면 쓰지 않는다");
  assert.equal(colorBackfillPatch(timedEvent(), { google_color_id: "10" }), null,
    "키가 없는 응답은 색을 지웠다는 뜻이 아니다");
  assert.deepEqual(colorBackfillPatch(timedEvent({ colorId: "" }), { google_color_id: "10" }), { google_color_id: null },
    "키가 있는데 비어 있으면 캘린더 색을 따르라는 명시적 답이다");
  assert.deepEqual(colorBackfillPatch(timedEvent({ colorId: "99" }), { google_color_id: "10" }), { google_color_id: null },
    "팔레트에 없는 id 는 받아쓰지 않는다");
  assert.equal(colorBackfillPatch(timedEvent({ colorId: "99" }), {}), null, "지울 것도 없으면 쓰지 않는다");
});

test("an echoed event backfills the per-event color onto a row that predates the column", async () => {
  const row = echoRow();
  const { ctx, ops } = echoSyncCtx(row);
  const { impl } = fetchMock({
    [`GET ${ECHO_EVENTS_URL}`]: jsonResponse(200, { items: [timedEvent({ colorId: "10", summary: "덮으면 안 되는 제목" })], nextSyncToken: "st" }),
  });

  const result = await echoSync(ctx, impl);

  assert.equal(result.updated, 1, "메아리여도 색 한 열은 뒤늦게 채워진다");
  assert.equal(result.skipped, 0);
  const updates = opsFor(ops, "schedule_items", "update");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].values, { google_color_id: "10" }, "색 말고는 아무것도 쓰지 않는다");
  assert.equal(row.title, "구글 회의", "오래된 이벤트가 제목을 덮지 못한다");
  assert.equal(row.google_updated_at, "2026-08-22T10:00:00.000Z", "버전도 그대로다 — 메아리 가드가 무너지면 안 된다");
  assert.equal(row.google_etag, '"e1"');
});

test("a replayed color backfill writes nothing, so updated_at never churns", async () => {
  const row = echoRow();
  const { ctx, ops } = echoSyncCtx(row);
  const { impl } = fetchMock({
    [`GET ${ECHO_EVENTS_URL}`]: jsonResponse(200, { items: [timedEvent({ colorId: "10" })], nextSyncToken: "st" }),
  });

  await echoSync(ctx, impl);
  const replay = await echoSync(ctx, impl);

  assert.equal(replay.updated, 0);
  assert.equal(replay.skipped, 1, "두 번째부터는 예전과 똑같이 건너뛴다");
  assert.equal(opsFor(ops, "schedule_items", "update").length, 1, "같은 값을 다시 쓰지 않는다");
});

test("an echoed event never rewrites a color it already has or one it never mentioned", async () => {
  const row = echoRow({ google_color_id: "10" });
  const { ctx, ops } = echoSyncCtx(row);
  const { impl } = fetchMock({
    [`GET ${ECHO_EVENTS_URL}`]: sequence(
      jsonResponse(200, { items: [timedEvent({ colorId: "10" })], nextSyncToken: "st" }),
      jsonResponse(200, { items: [timedEvent()], nextSyncToken: "st" }),
    ),
  });

  const same = await echoSync(ctx, impl);
  const silent = await echoSync(ctx, impl);

  assert.deepEqual([same.updated, same.skipped], [0, 1], "색이 그대로면 쓰지 않는다");
  assert.deepEqual([silent.updated, silent.skipped], [0, 1], "키가 없으면 손대지 않는다");
  assert.equal(opsFor(ops, "schedule_items", "update").length, 0);
  assert.equal(row.google_color_id, "10", "키 없는 응답이 대표님이 고른 색을 지우지 않는다");
});

test("the color backfill degrades with its own column group and heals on the same timer", async () => {
  resetOptionalColumns();
  try {
    const state = { migrated: false };
    const row = echoRow();
    // 열이 내려간 창에서는 그 값이 애초에 실려 오지 않는다.
    const withoutColorColumn = (source) => {
      const copy = { ...source };
      delete copy.google_color_id;
      return copy;
    };
    const { ctx, ops } = makeCtx({
      schedule_items: (op) => {
        if (op.kind === "update") { Object.assign(row, op.values); return { data: null, error: null }; }
        if (op.kind !== "select") return { data: null, error: null };
        if (!state.migrated && op.fields.includes("google_color_id")) {
          return { data: null, error: { code: "42703", message: "column schedule_items.google_color_id does not exist" } };
        }
        if (!op.filters.some((filter) => filter[1] === "google_event_id")) return { data: [], error: null };
        return { data: [state.migrated ? row : withoutColorColumn(row)], error: null };
      },
    });
    let clock = NOW;
    setOptionalColumnClock(() => clock);
    const { impl } = fetchMock({
      [`GET ${ECHO_EVENTS_URL}`]: jsonResponse(200, { items: [timedEvent({ colorId: "10" })], nextSyncToken: "st" }),
    });

    const degraded = await echoSync(ctx, impl);

    assert.deepEqual([degraded.updated, degraded.skipped], [0, 1], "열이 없으면 예전과 똑같이 건너뛴다");
    assert.equal(opsFor(ops, "schedule_items", "update").length, 0, "없는 열에 쓰려 들지 않는다");
    assert.deepEqual(disabledOptionalColumns(), [...OPTIONAL_EVENT_COLOR_COLUMNS], "색 묶음만 내려간다");
    assert.equal(row.google_color_id, null);

    state.migrated = true;
    clock += OPTIONAL_COLUMN_RETRY_MS;

    const healed = await echoSync(ctx, impl);

    assert.equal(healed.updated, 1, "재배포 없이 TTL 이 지나면 스스로 채운다");
    assert.deepEqual(opsFor(ops, "schedule_items", "update").at(-1).values, { google_color_id: "10" });
    assert.deepEqual(disabledOptionalColumns(), []);
  } finally {
    resetOptionalColumns();
  }
});

// ─────────────────────────────────────────────────────────────
// outbound
// ─────────────────────────────────────────────────────────────

test("write-back targets the row's original calendar, not the dedicated one", async () => {
  const { ctx } = makeCtx();
  const path = `${CALENDAR_BASE}/calendars/primary%40example.com/events/gev-1`;
  const { calls, impl } = fetchMock({
    [`PATCH ${path}`]: jsonResponse(200, { id: "gev-1", etag: '"e2"', updated: "2026-08-22T12:00:00.000Z" }),
  });

  const result = await pushRowToGoogle(ctx, GOOGLE_ENV, {
    integration: INTEGRATION,
    accessToken: "gat-1",
    row: {
      id: "row-1", title: "회의", status: "planned",
      starts_at: "2026-08-24T06:00:00.000Z", ends_at: "2026-08-24T07:00:00.000Z",
      google_event_id: "gev-1", google_calendar_id: "primary@example.com", google_etag: '"e1"',
    },
    fetchImpl: impl,
  });

  assert.ok(result.ok);
  assert.equal(calls[0].url, path);
  assert.equal(calls[0].options.headers["if-match"], '"e1"', "조건부 쓰기로 충돌을 감지한다");
  assert.equal(result.values.google_calendar_id, "primary@example.com");
  assert.equal(result.values.google_etag, '"e2"');
});

test("a 412 refetches the etag once and gives up to google on a second conflict", async () => {
  const { ctx } = makeCtx();
  const path = `${CALENDAR_BASE}/calendars/primary%40example.com/events/gev-1`;
  const row = {
    id: "row-1", title: "회의", status: "planned", starts_at: "2026-08-24T06:00:00.000Z",
    google_event_id: "gev-1", google_calendar_id: "primary@example.com", google_etag: '"stale"',
  };

  const recovered = fetchMock({
    [`PATCH ${path}`]: sequence(jsonResponse(412, {}), jsonResponse(200, { id: "gev-1", etag: '"e9"' })),
    [`GET ${path}`]: jsonResponse(200, { id: "gev-1", etag: '"fresh"' }),
  });
  const ok = await pushRowToGoogle(ctx, GOOGLE_ENV, { integration: INTEGRATION, accessToken: "g", row, fetchImpl: recovered.impl });
  assert.ok(ok.ok);
  assert.deepEqual(recovered.calls.map((call) => call.method), ["PATCH", "GET", "PATCH"]);
  assert.equal(recovered.calls[2].options.headers["if-match"], '"fresh"');

  const stuck = fetchMock({
    [`PATCH ${path}`]: jsonResponse(412, {}),
    [`GET ${path}`]: jsonResponse(200, { id: "gev-1", etag: '"fresh"' }),
  });
  const failed = await pushRowToGoogle(ctx, GOOGLE_ENV, { integration: INTEGRATION, accessToken: "g", row, fetchImpl: stuck.impl });
  assert.deepEqual(failed, { ok: false, reason: "etag_conflict" });
});

test("MI deletes hit the original calendar and cancel recurring instances instead of deleting them", async () => {
  const { ctx } = makeCtx();
  const path = `${CALENDAR_BASE}/calendars/primary%40example.com/events/gev-1`;

  const single = fetchMock({ [`DELETE ${path}`]: jsonResponse(204, undefined) });
  const one = await pushRowToGoogle(ctx, GOOGLE_ENV, {
    integration: INTEGRATION, accessToken: "g", mode: "delete",
    row: { id: "row-1", google_event_id: "gev-1", google_calendar_id: "primary@example.com" },
    fetchImpl: single.impl,
  });
  assert.ok(one.ok);
  assert.equal(single.calls[0].method, "DELETE");

  const instance = fetchMock({ [`PATCH ${path}`]: jsonResponse(200, { id: "gev-1", status: "cancelled" }) });
  const cancelled = await pushRowToGoogle(ctx, GOOGLE_ENV, {
    integration: INTEGRATION, accessToken: "g", mode: "delete",
    row: {
      id: "row-1", google_event_id: "gev-1", google_calendar_id: "primary@example.com",
      google_recurring_event_id: "gev-parent",
    },
    fetchImpl: instance.impl,
  });
  assert.ok(cancelled.ok);
  assert.equal(instance.calls[0].method, "PATCH");
  assert.deepEqual(JSON.parse(instance.calls[0].options.body), { status: "cancelled" });

  const gone = fetchMock({ [`DELETE ${path}`]: jsonResponse(404, { error: {} }) });
  const tolerated = await pushRowToGoogle(ctx, GOOGLE_ENV, {
    integration: INTEGRATION, accessToken: "g", mode: "delete",
    row: { id: "row-1", google_event_id: "gev-1", google_calendar_id: "primary@example.com" },
    fetchImpl: gone.impl,
  });
  assert.deepEqual(tolerated, { ok: true });
});

test("the pending sweep retries failed pushes and flips them to synced", async () => {
  const pending = [
    { id: "row-1", title: "밀린 일정", status: "planned", starts_at: "2026-08-24T06:00:00.000Z", google_sync_state: "pending", client_id: "client-1" },
  ];
  const { ctx, ops } = makeCtx({
    schedule_items: (op) => (op.kind === "select" ? { data: pending, error: null } : { data: null, error: null }),
    clients: { data: [{ id: "client-1", name: "모먼트커피" }], error: null },
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events`;
  const { calls, impl } = fetchMock({
    [`POST ${eventsUrl}`]: jsonResponse(200, { id: "gev-new", etag: '"e1"', updated: "2026-08-23T00:00:00.000Z" }),
  });

  const result = await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { fetchImpl: impl });

  assert.deepEqual(result, { pushed: 1, pushFailed: 0 });
  assert.equal(JSON.parse(calls[0].options.body).summary, "[모먼트커피] 밀린 일정");
  const update = opsFor(ops, "schedule_items", "update")[0];
  assert.equal(update.values.google_sync_state, "synced");
  assert.equal(update.values.google_event_id, "gev-new");
});

test("a failed push marks the row failed so the next sync retries it", async () => {
  const pending = [{ id: "row-1", title: "밀린 일정", status: "planned", starts_at: "2026-08-24T06:00:00.000Z" }];
  const { ctx, ops } = makeCtx({
    schedule_items: (op) => (op.kind === "select" ? { data: pending, error: null } : { data: null, error: null }),
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events`;
  const { impl } = fetchMock({ [`POST ${eventsUrl}`]: jsonResponse(500, { error: {} }) });

  const result = await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { fetchImpl: impl });

  assert.deepEqual(result, { pushed: 0, pushFailed: 1 });
  assert.equal(opsFor(ops, "schedule_items", "update")[0].values.google_sync_state, "failed");
});

// updated_at 을 올리는 트리거에는 조건이 없다. 값이 하나도 바뀌지 않는 기록용
// 쓰기까지 그대로 버전을 올리면 대표님 화면의 사본이 이유 없이 낡는다.
function alreadySyncedRow(values = {}) {
  return {
    id: "row-1",
    title: "이미 밀어둔 일정",
    status: "planned",
    starts_at: "2026-08-24T06:00:00.000Z",
    google_event_id: "gev-1",
    google_calendar_id: "dedicated@group.calendar.google.com",
    google_etag: '"e1"',
    google_updated_at: "2026-08-23T00:00:00.000Z",
    google_html_link: "https://calendar.google.com/event?eid=1",
    google_sync_state: "synced",
    google_sync_error: null,
    ...values,
  };
}

const PENDING_PATCH_URL = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events/gev-1`;

function pushOnePending(row, echo) {
  const { ctx, ops } = makeCtx({
    schedule_items: (op) => (op.kind === "select" ? { data: [row], error: null } : { data: null, error: null }),
  });
  const { calls, impl } = fetchMock({ [`PATCH ${PENDING_PATCH_URL}`]: jsonResponse(200, echo) });
  return { ctx, ops, calls, run: () => pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { fetchImpl: impl }) };
}

test("a push whose google echo changes nothing skips the bookkeeping write", async () => {
  const { ops, calls, run } = pushOnePending(alreadySyncedRow(), {
    id: "gev-1",
    etag: '"e1"',
    updated: "2026-08-23T00:00:00.000Z",
    htmlLink: "https://calendar.google.com/event?eid=1",
  });

  const result = await run();

  assert.deepEqual(result, { pushed: 1, pushFailed: 0 }, "밀기 자체는 성공으로 센다");
  assert.equal(calls[0].method, "PATCH", "구글로 보내는 것은 그대로다");
  assert.deepEqual(opsFor(ops, "schedule_items", "update"), [], "updated_at 을 올릴 이유가 없다");
});

test("a push whose google echo brings a new etag still writes the bookkeeping row", async () => {
  const { ops, run } = pushOnePending(alreadySyncedRow(), {
    id: "gev-1",
    etag: '"e2"',
    updated: "2026-08-23T01:00:00.000Z",
    htmlLink: "https://calendar.google.com/event?eid=1",
  });

  const result = await run();

  assert.deepEqual(result, { pushed: 1, pushFailed: 0 });
  const update = opsFor(ops, "schedule_items", "update")[0];
  assert.equal(update.values.google_etag, '"e2"');
  assert.equal(update.values.google_updated_at, "2026-08-23T01:00:00.000Z");
});

test("a row flipping from pending to synced still writes even when nothing else changed", async () => {
  const { ops, run } = pushOnePending(alreadySyncedRow({ google_sync_state: "pending" }), {
    id: "gev-1",
    etag: '"e1"',
    updated: "2026-08-23T00:00:00.000Z",
    htmlLink: "https://calendar.google.com/event?eid=1",
  });

  const result = await run();

  assert.deepEqual(result, { pushed: 1, pushFailed: 0 });
  assert.equal(opsFor(ops, "schedule_items", "update")[0].values.google_sync_state, "synced");
});

// ─────────────────────────────────────────────────────────────
// 오케스트레이션
// ─────────────────────────────────────────────────────────────

test("an expired refresh token flips the integration to needs_reconnect without calling calendar", async () => {
  const { ctx, ops } = makeCtx({
    owner_google_integrations: (op) => (op.kind === "select" ? { data: INTEGRATION, error: null } : { data: null, error: null }),
  });
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }),
  });

  const result = await runOwnerCalendarSync(ctx, GOOGLE_ENV, OWNER, { now: NOW, fetchImpl: impl });

  assert.equal(result.needsReconnect, true);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.url), [TOKEN_URL], "캘린더는 건드리지 않는다");
  assert.equal(opsFor(ops, "owner_google_integrations", "update")[0].values.sync_status, "needs_reconnect");
});

test("a stored needs_reconnect short-circuits before any google traffic", async () => {
  const { ctx } = makeCtx({
    owner_google_integrations: (op) => (op.kind === "select"
      ? { data: { ...INTEGRATION, sync_status: "needs_reconnect" }, error: null }
      : { data: null, error: null }),
  });
  const { calls, impl } = fetchMock({});

  const result = await runOwnerCalendarSync(ctx, GOOGLE_ENV, OWNER, { now: NOW, fetchImpl: impl });

  assert.equal(result.needsReconnect, true);
  assert.equal(calls.length, 0, "400 폭풍을 만들지 않는다");
});

// 예전에는 이 실행이 "전용 + 기본" 두 캘린더를 함께 당겼다. 이제는 전용 캘린더를
// 먼저 비워 지우고 기본 캘린더 하나만 동기화한다 — 대표님의 내 캘린더에는 기본
// 캘린더 하나만 남아야 한다.
test("a full run retires the dedicated calendar first and then pulls only the primary", async () => {
  const { ctx, ops } = makeCtx({
    owner_google_integrations: (op) => (op.kind === "select" ? { data: INTEGRATION, error: null } : { data: null, error: null }),
    owner_google_calendar_sync: (op) => (op.kind === "select" ? { data: [], error: null } : { data: null, error: null }),
    schedule_items: { data: [], error: null },
  });
  const dedicatedUrl = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events`;
  const dedicatedCalendarUrl = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com`;
  const primaryUrl = `${CALENDAR_BASE}/calendars/owner%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`GET ${CALENDAR_BASE}/calendars/primary`]: jsonResponse(200, { id: "owner@example.com" }),
    [`GET ${dedicatedUrl}`]: jsonResponse(200, { items: [] }),
    [`DELETE ${dedicatedCalendarUrl}`]: jsonResponse(204, undefined),
    [`GET ${primaryUrl}`]: jsonResponse(200, { items: [timedEvent()], nextSyncToken: "st-p" }),
    [`GET ${CALENDAR_BASE}/users/me/calendarList`]: jsonResponse(200, { items: [] }),
  });

  const result = await runOwnerCalendarSync(ctx, GOOGLE_ENV, OWNER, { now: NOW, fetchImpl: impl });

  assert.equal(result.ok, true);
  assert.equal(result.changed, 1);
  assert.deepEqual(result.calendars.map((entry) => entry.role), ["primary"], "지운 캘린더는 동기화 대상에 오르지 않는다");
  // 회수가 push/pull 보다 먼저여야 그 뒤에 만들어지는 카탈로그가 이미 옳다.
  const retiredAt = calls.findIndex((call) => call.method === "DELETE" && call.url === dedicatedCalendarUrl);
  const pulledAt = calls.findIndex((call) => call.url === primaryUrl);
  assert.ok(retiredAt >= 0, "전용 캘린더는 실제로 지워진다");
  assert.ok(retiredAt < pulledAt, "회수가 pull 보다 먼저다");
  // primary 는 "primary" 리터럴이 아니라 실제 id 로 고정되어야 중복 동기화가 없다.
  const upserts = opsFor(ops, "owner_google_calendar_sync", "upsert");
  assert.deepEqual(upserts.map((op) => op.values.google_calendar_id), ["owner@example.com"]);
  assert.equal(opsFor(ops, "owner_google_integrations", "update").at(-1).values.sync_status, "ok");
  const cleared = opsFor(ops, "owner_google_integrations", "update").find((op) => "calendar_id" in op.values);
  assert.equal(cleared.values.calendar_id, null, "연동 행은 더 이상 전용 캘린더를 가리키지 않는다");
});

test("a run without an integration reports not-connected and touches nothing", async () => {
  const { ctx } = makeCtx({ owner_google_integrations: { data: null, error: null } });
  const { calls, impl } = fetchMock({});
  const result = await runOwnerCalendarSync(ctx, GOOGLE_ENV, OWNER, { now: NOW, fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-connected");
  assert.equal(calls.length, 0);

  const missingEnv = await runOwnerCalendarSync(ctx, {}, OWNER, { now: NOW, fetchImpl: impl });
  assert.equal(missingEnv.reason, "env");
});

// ─────────────────────────────────────────────────────────────
// 전용 캘린더 회수
//
// 연동된 대표님의 내 캘린더에는 기본 캘린더 하나만 남는다. 회수는 멱등이고,
// 절대 던지지 않으며, 한 조각이라도 남아 있으면 캘린더를 지우지 않는다.
// ─────────────────────────────────────────────────────────────

const DEDICATED = INTEGRATION.calendar_id;
const PRIMARY_ID = "owner@example.com";
const DEDICATED_EVENTS_URL = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events`;
const DEDICATED_CALENDAR_URL = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com`;

// 기본 캘린더를 카탈로그 캐시에서 찾게 해 둔다 — 그래야 /calendars/primary 를
// 부르지 않는 경로까지 그대로 확인된다.
function retireCtx(extra = {}) {
  return makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? {
        data: [{ google_calendar_id: PRIMARY_ID, calendar_role: "primary", calendar_summary: "내 캘린더" }],
        error: null,
      }
      : { data: null, error: null }),
    schedule_items: { data: null, error: null },
    owner_google_integrations: { data: null, error: null },
    audit_logs: { data: null, error: null },
    ...extra,
  });
}

test("retiring the dedicated calendar moves its events to the primary and then deletes it", async () => {
  const { ctx, ops } = retireCtx();
  const { calls, impl } = fetchMock({
    [`GET ${DEDICATED_EVENTS_URL}`]: jsonResponse(200, {
      items: [timedEvent({ id: "gev-1" }), timedEvent({ id: "gev-master", recurrence: ["RRULE:FREQ=WEEKLY"] })],
    }),
    [`POST ${DEDICATED_EVENTS_URL}/gev-1/move`]: jsonResponse(200, { id: "gev-1", etag: '"m1"' }),
    [`POST ${DEDICATED_EVENTS_URL}/gev-master/move`]: jsonResponse(200, { id: "gev-master", etag: '"m2"' }),
    [`DELETE ${DEDICATED_CALENDAR_URL}`]: jsonResponse(204, undefined),
  });

  const result = await retireDedicatedCalendar(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { now: NOW, fetchImpl: impl });

  assert.equal(result.ok, true);
  assert.equal(result.retired, true);
  assert.deepEqual([result.moved, result.skipped, result.failed], [2, 0, 0]);

  // 마스터를 받아야 옮길 수 있으므로 singleEvents=false 다.
  const listed = calls.find((call) => call.method === "GET" && call.url === DEDICATED_EVENTS_URL);
  assert.equal(listed.query.singleEvents, "false");
  // 동기화 윈도우를 걸지 않는다 — 걸면 그 밖의 이벤트가 캘린더와 함께 사라진다.
  assert.ok(!("timeMin" in listed.query), "회수는 캘린더 전체를 훑는다");
  assert.ok(!("timeMax" in listed.query));
  const moves = calls.filter((call) => call.url.endsWith("/move"));
  assert.deepEqual(moves.map((call) => call.query.destination), [PRIMARY_ID, PRIMARY_ID]);
  assert.deepEqual(moves.map((call) => call.query.sendUpdates), ["none", "none"],
    "캘린더를 옮겼다고 참석자에게 메일이 가서는 안 된다");
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url === DEDICATED_CALENDAR_URL));

  // 이벤트별 update 두 번 + 인스턴스 행까지 훑는 쓸어담기 update 한 번.
  const updates = opsFor(ops, "schedule_items", "update");
  assert.equal(updates.length, 3);
  assert.equal(updates[0].values.google_calendar_id, PRIMARY_ID);
  assert.equal(updates[0].values.google_calendar_name, "내 캘린더");
  assert.equal(updates[0].values.google_etag, '"m1"');
  assert.deepEqual(updates[0].filters, [
    ["eq", "owner_agency_code", OWNER],
    ["eq", "google_calendar_id", DEDICATED],
    ["eq", "google_event_id", "gev-1"],
  ]);
  assert.deepEqual(updates.at(-1).filters, [
    ["eq", "owner_agency_code", OWNER],
    ["eq", "google_calendar_id", DEDICATED],
  ], "반복 시리즈의 인스턴스 행은 마스터 id 로 잡히지 않으므로 마지막에 한 번 쓸어담는다");

  const removed = opsFor(ops, "owner_google_calendar_sync", "delete")[0];
  assert.deepEqual(removed.filters, [["eq", "owner_agency_code", OWNER], ["eq", "google_calendar_id", DEDICATED]]);
  assert.equal(opsFor(ops, "owner_google_integrations", "update").at(-1).values.calendar_id, null);
  const audit = opsFor(ops, "audit_logs", "insert")
    .map((op) => op.values)
    .find((values) => values.action === "google_calendar_dedicated_retired");
  assert.ok(audit, "회수는 감사 줄을 남긴다");
  assert.equal(audit.target_table, "owner_google_integrations");
  assert.equal(audit.metadata.moved, 2);
  assert.equal(audit.metadata.primaryCalendarId, PRIMARY_ID);
});

// 캘린더를 마지막에 통째로 지우므로, 옮기지 않고 남긴 이벤트는 구글에서 영구히
// 사라진다. 동기화 윈도우(-30일 ~ +365일)를 회수에 걸면 하필 아무도 보고 있지
// 않은 오래된·먼 미래의 일정만 조용히 지워진다. 그래서 회수는 전체를 훑는다.
test("events far outside the sync window are still moved before the calendar is deleted", async () => {
  const { ctx } = retireCtx();
  const twoYearsOut = new Date(NOW + 730 * 24 * 60 * 60 * 1000).toISOString();
  const longPast = new Date(NOW - 730 * 24 * 60 * 60 * 1000).toISOString();
  const { calls, impl } = fetchMock({
    [`GET ${DEDICATED_EVENTS_URL}`]: jsonResponse(200, {
      items: [
        timedEvent({ id: "gev-future", start: { dateTime: twoYearsOut }, end: { dateTime: twoYearsOut } }),
        timedEvent({ id: "gev-past", start: { dateTime: longPast }, end: { dateTime: longPast } }),
      ],
    }),
    [`POST ${DEDICATED_EVENTS_URL}/gev-future/move`]: jsonResponse(200, { id: "gev-future", etag: '"m1"' }),
    [`POST ${DEDICATED_EVENTS_URL}/gev-past/move`]: jsonResponse(200, { id: "gev-past", etag: '"m2"' }),
    [`DELETE ${DEDICATED_CALENDAR_URL}`]: jsonResponse(204, undefined),
  });

  const result = await retireDedicatedCalendar(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { now: NOW, fetchImpl: impl });

  assert.equal(result.retired, true);
  assert.deepEqual([result.moved, result.skipped, result.failed], [2, 0, 0]);
  assert.deepEqual(calls.filter((call) => call.url.endsWith("/move")).map((call) => call.url), [
    `${DEDICATED_EVENTS_URL}/gev-future/move`,
    `${DEDICATED_EVENTS_URL}/gev-past/move`,
  ], "윈도우 밖이라고 남겨 두면 캘린더와 함께 사라진다");
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url === DEDICATED_CALENDAR_URL));
});

test("an unmovable event keeps the dedicated calendar alive for the next run", async () => {
  const { ctx, ops } = retireCtx();
  const { calls, impl } = fetchMock({
    [`GET ${DEDICATED_EVENTS_URL}`]: jsonResponse(200, {
      items: [
        timedEvent({ id: "gev-1" }),
        // 구글은 birthday / focusTime / fromGmail / outOfOffice / workingLocation 을 옮겨 주지 않는다.
        timedEvent({ id: "gev-birthday", eventType: "birthday" }),
        // 반복 예외는 마스터를 따라간다 — 따로 옮길 수 없다.
        timedEvent({ id: "gev-exception", recurringEventId: "gev-master" }),
      ],
    }),
    [`POST ${DEDICATED_EVENTS_URL}/gev-1/move`]: jsonResponse(200, { id: "gev-1", etag: '"m1"' }),
  });

  const result = await retireDedicatedCalendar(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { now: NOW, fetchImpl: impl });

  assert.deepEqual(result, { ok: false, reason: "pending", moved: 1, skipped: 2, failed: 0 });
  assert.equal(calls.filter((call) => call.url.endsWith("/move")).length, 1, "옮길 수 없는 것은 시도조차 하지 않는다");
  assert.equal(calls.some((call) => call.method === "DELETE"), false, "일정이 남은 캘린더는 절대 지우지 않는다");
  assert.equal(opsFor(ops, "owner_google_calendar_sync", "delete").length, 0);
  assert.equal(opsFor(ops, "owner_google_integrations", "update").length, 0, "연동은 그대로 살아 있다");
});

test("a failed move leaves the dedicated calendar and the integration untouched", async () => {
  const { ctx, ops } = retireCtx();
  const { calls, impl } = fetchMock({
    [`GET ${DEDICATED_EVENTS_URL}`]: jsonResponse(200, { items: [timedEvent({ id: "gev-1" })] }),
    [`POST ${DEDICATED_EVENTS_URL}/gev-1/move`]: jsonResponse(500, { error: {} }),
  });

  const result = await retireDedicatedCalendar(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { now: NOW, fetchImpl: impl });

  assert.deepEqual(result, { ok: false, reason: "pending", moved: 0, skipped: 0, failed: 1 });
  assert.equal(calls.some((call) => call.method === "DELETE"), false);
  assert.equal(opsFor(ops, "schedule_items", "update").length, 0, "옮기지 못한 행은 원래 캘린더를 계속 가리킨다");
  assert.equal(opsFor(ops, "owner_google_integrations", "update").length, 0);
});

test("a retirement with nothing left to do never touches google", async () => {
  // 이미 회수를 끝낸 연동: calendar_id 가 null 이다.
  const done = retireCtx();
  const doneFetch = fetchMock({});
  assert.deepEqual(
    await retireDedicatedCalendar(done.ctx, GOOGLE_ENV, OWNER, { ...INTEGRATION, calendar_id: null }, "gat-1", { now: NOW, fetchImpl: doneFetch.impl }),
    { ok: true, skipped: true, reason: "no_dedicated" },
  );
  assert.equal(doneFetch.calls.length, 0);
  assert.equal(done.ops.length, 0, "DB 도 건드리지 않는다");

  // 전용 캘린더 id 가 곧 기본 캘린더인 경우 — 자기 자신으로 옮기거나 기본
  // 캘린더를 지우는 사고를 여기서 막는다.
  const same = makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? { data: [{ google_calendar_id: DEDICATED, calendar_role: "primary" }], error: null }
      : { data: null, error: null }),
  });
  const sameFetch = fetchMock({});
  assert.deepEqual(
    await retireDedicatedCalendar(same.ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { now: NOW, fetchImpl: sameFetch.impl }),
    { ok: true, skipped: true, reason: "already_primary" },
  );
  assert.equal(sameFetch.calls.length, 0);
});

test("a second run after a successful retirement is a no-op with no google traffic", async () => {
  const { ctx } = retireCtx();
  const { calls, impl } = fetchMock({
    [`GET ${DEDICATED_EVENTS_URL}`]: jsonResponse(200, { items: [] }),
    [`DELETE ${DEDICATED_CALENDAR_URL}`]: jsonResponse(204, undefined),
  });

  const first = await retireDedicatedCalendar(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { now: NOW, fetchImpl: impl });
  assert.equal(first.retired, true);
  const spent = calls.length;

  // 회수가 끝나면 연동 행의 calendar_id 는 null 이다. 다음 실행은 그 값을 읽고
  // 곧바로 물러난다 — 멱등의 값이 여기에 있다.
  const second = await retireDedicatedCalendar(ctx, GOOGLE_ENV, OWNER, { ...INTEGRATION, calendar_id: null }, "gat-1", { now: NOW, fetchImpl: impl });
  assert.deepEqual(second, { ok: true, skipped: true, reason: "no_dedicated" });
  assert.equal(calls.length, spent, "두 번째 실행은 구글을 한 번도 부르지 않는다");
});

test("pending rows without a calendar of their own fall back to the primary once retired", async () => {
  const retiredIntegration = { ...INTEGRATION, calendar_id: null };
  const pending = [{ id: "row-1", title: "밀린 일정", status: "planned", starts_at: "2026-08-24T06:00:00.000Z" }];
  const { ctx } = makeCtx({
    schedule_items: (op) => (op.kind === "select" ? { data: pending, error: null } : { data: null, error: null }),
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? { data: [{ google_calendar_id: PRIMARY_ID, calendar_role: "primary", calendar_summary: "내 캘린더" }], error: null }
      : { data: null, error: null }),
  });
  const primaryEventsUrl = `${CALENDAR_BASE}/calendars/owner%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`POST ${primaryEventsUrl}`]: jsonResponse(200, { id: "gev-new", etag: '"e1"', updated: "2026-08-23T00:00:00.000Z" }),
  });

  const result = await pushPendingRows(ctx, GOOGLE_ENV, OWNER, retiredIntegration, "gat-1", { fetchImpl: impl });

  assert.deepEqual(result, { pushed: 1, pushFailed: 0 });
  assert.equal(calls[0].url, primaryEventsUrl, "전용 캘린더가 사라져도 갈 곳이 있다");
});

// ─────────────────────────────────────────────────────────────
// MI 삭제 → 구글 삭제 (운영 사고 회귀 방지)
// ─────────────────────────────────────────────────────────────

function deletableRow(overrides = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: null, operation_team_id: null, owner_agency_code: OWNER,
    title: "지울 일정", schedule_type: "meeting", status: "planned", priority: "medium",
    starts_at: "2026-08-24T06:00:00.000Z", ends_at: "2026-08-24T07:00:00.000Z",
    visibility: "internal", is_all_day: false, calendar_id: null,
    google_event_id: "gev-1", google_calendar_id: INTEGRATION.calendar_id,
    google_source: "mi", google_sync_state: "synced",
    created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function deleteRequest(row) {
  return new Request("https://insight.momentlabs.co.kr/api/work-items", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "owner",
      "x-mi-owner-agency-code": OWNER,
    },
    body: JSON.stringify({ id: row.id, expectedUpdatedAt: row.updated_at }),
  });
}

function deleteCtx(row) {
  const scheduleResults = [{ data: row, error: null }, { data: { id: row.id }, error: null }];
  return makeCtx({
    schedule_items: (op) => (op.kind === "select" ? scheduleResults.shift() : { data: { id: row.id }, error: null }),
    owner_google_integrations: (op) => (op.kind === "select" ? { data: INTEGRATION, error: null } : { data: null, error: null }),
    audit_logs: { data: null, error: null },
  });
}

async function withStubbedFetch(impl, run) {
  const original = globalThis.fetch;
  const env = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  globalThis.fetch = impl;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid-1";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "sec-1";
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    if (env.id === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = env.id;
    if (env.secret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = env.secret;
  }
}

test("deleting an MI-created row removes the google event before the MI row", async () => {
  const { handleWorkItemsRequest } = await import("./work-items.mjs");
  const row = deletableRow();
  const { ctx, ops } = deleteCtx(row);
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`DELETE ${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events/gev-1`]: jsonResponse(204, undefined),
  });

  const response = await withStubbedFetch(impl, () => handleWorkItemsRequest(deleteRequest(row), ctx));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(calls.at(-1).method, "DELETE");
  // 구글 호출이 DB 삭제보다 먼저 일어나야 한다.
  const order = ops.map((op) => `${op.table}:${op.kind}`);
  assert.ok(order.indexOf("owner_google_integrations:select") < order.indexOf("schedule_items:delete"));
  assert.equal(opsFor(ops, "schedule_items", "delete").length, 1);
});

test("deleting an imported row targets its original primary calendar", async () => {
  const { handleWorkItemsRequest } = await import("./work-items.mjs");
  const row = deletableRow({
    google_calendar_id: "owner@example.com", google_event_id: "gev-primary", google_source: "google",
  });
  const { ctx, ops } = deleteCtx(row);
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`DELETE ${CALENDAR_BASE}/calendars/owner%40example.com/events/gev-primary`]: jsonResponse(204, undefined),
  });

  const response = await withStubbedFetch(impl, () => handleWorkItemsRequest(deleteRequest(row), ctx));

  assert.equal(response.status, 200);
  assert.equal(calls.at(-1).url, `${CALENDAR_BASE}/calendars/owner%40example.com/events/gev-primary`);
  assert.equal(opsFor(ops, "schedule_items", "delete").length, 1);
});

test("a google delete failure keeps the MI row, reports it, and audits the failure", async () => {
  const { handleWorkItemsRequest } = await import("./work-items.mjs");
  const row = deletableRow();
  const { ctx, ops } = deleteCtx(row);
  const { impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`DELETE ${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events/gev-1`]: jsonResponse(500, { error: {} }),
  });

  const response = await withStubbedFetch(impl, () => handleWorkItemsRequest(deleteRequest(row), ctx));
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.ok, false);
  assert.match(payload.message, /구글 캘린더에서 삭제하지 못했습니다/);
  assert.equal(opsFor(ops, "schedule_items", "delete").length, 0, "구글에 남은 일정을 MI에서만 지우지 않는다");
  const failed = opsFor(ops, "schedule_items", "update").at(-1);
  assert.equal(failed.values.google_sync_state, "failed");
  assert.equal(failed.values.google_sync_error, "delete:delete_500");
  // handleDelete 는 결과별 감사보다 먼저 시도 감사(work_item_delete_attempted)를
  // 남긴다. .at(-1) 로 마지막 줄을 집으면 그 시도 줄을 잡게 되므로 action 으로 짚는다.
  const audits = opsFor(ops, "audit_logs", "insert").map((op) => op.values);
  const audit = audits.find((values) => values.action === "google_calendar_sync_failed");
  assert.ok(audit, "구글 삭제 실패는 google_calendar_sync_failed 로 남는다");
  assert.equal(audit.metadata.mode, "delete");
  const attempted = audits.find((values) => values.action === "work_item_delete_attempted");
  assert.ok(attempted, "삭제 시도 자체도 감사에 남는다");
  assert.equal(attempted.metadata.outcome, "google_failed");
});

test("a google event that is already gone still lets the MI row be deleted", async () => {
  const { handleWorkItemsRequest } = await import("./work-items.mjs");
  const row = deletableRow();
  const { ctx, ops } = deleteCtx(row);
  const { impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`DELETE ${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events/gev-1`]: jsonResponse(404, { error: {} }),
  });

  const response = await withStubbedFetch(impl, () => handleWorkItemsRequest(deleteRequest(row), ctx));

  assert.equal(response.status, 200);
  assert.equal(opsFor(ops, "schedule_items", "delete").length, 1);
});

test("an expired refresh token blocks the delete with a reconnect message", async () => {
  const { handleWorkItemsRequest } = await import("./work-items.mjs");
  const row = deletableRow();
  const { ctx, ops } = deleteCtx(row);
  const { impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: jsonResponse(400, { error: "invalid_grant" }),
  });

  const response = await withStubbedFetch(impl, () => handleWorkItemsRequest(deleteRequest(row), ctx));
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.match(payload.message, /다시 연결한 뒤 삭제해주세요/);
  assert.equal(opsFor(ops, "schedule_items", "delete").length, 0);
});

test("a row that never reached google is still deleted locally without google traffic", async () => {
  const { handleWorkItemsRequest } = await import("./work-items.mjs");
  const row = deletableRow({ google_event_id: null, google_calendar_id: null, google_sync_state: "pending" });
  const { ctx, ops } = deleteCtx(row);
  const { calls, impl } = fetchMock({});

  const response = await withStubbedFetch(impl, () => handleWorkItemsRequest(deleteRequest(row), ctx));

  assert.equal(response.status, 200);
  assert.equal(calls.length, 0);
  assert.equal(opsFor(ops, "schedule_items", "delete").length, 1);
});

// ─────────────────────────────────────────────────────────────
// 일정 상세 · 캘린더 목록 · Google-first 쓰기
// ─────────────────────────────────────────────────────────────

function detailRow(values = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    owner_agency_code: OWNER,
    client_id: null, operation_team_id: null, calendar_id: null,
    title: "월간 정산 미팅", status: "planned",
    starts_at: "2026-09-13T05:00:00.000Z", ends_at: "2026-09-13T06:00:00.000Z",
    is_all_day: false,
    google_location: "본사 회의실",
    google_description: "정산 자료 지참",
    google_attendees: [{ email: "A@B.com" }, { email: "a@b.com" }, { email: "c@d.com", displayName: "다라" }],
    google_recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
    ...values,
  };
}

test("the detail payload carries recurrence, attendees, location, description and a conference request", () => {
  const payload = buildGoogleEventPayload(detailRow(), {
    ownerCode: OWNER, createConference: true, details: { mode: "insert" },
  });

  assert.deepEqual(payload.recurrence, ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"]);
  assert.deepEqual(payload.attendees, [{ email: "a@b.com" }, { email: "c@d.com", displayName: "다라" }]);
  assert.equal(payload.location, "본사 회의실");
  assert.equal(payload.description, "정산 자료 지참");
  assert.equal(payload.start.timeZone, "Asia/Seoul");
  assert.equal(payload.end.timeZone, "Asia/Seoul");
  assert.equal(payload.conferenceData.conferenceSolutionKey, undefined);
  assert.deepEqual(payload.conferenceData.createRequest.conferenceSolutionKey, { type: "hangoutsMeet" });
  assert.match(payload.conferenceData.createRequest.requestId, /^[0-9a-f-]{36}$/u);
});

test("all-day detail events still name the timezone and skip empty fields on insert", () => {
  const payload = buildGoogleEventPayload(detailRow({
    is_all_day: true, occurrence_on: "2026-09-13",
    google_location: null, google_description: null, google_attendees: null, google_recurrence: [],
  }), { ownerCode: OWNER, details: { mode: "insert" } });

  assert.deepEqual(payload.start, { date: "2026-09-13", timeZone: "Asia/Seoul" });
  assert.deepEqual(payload.end, { date: "2026-09-14", timeZone: "Asia/Seoul" });
  assert.equal("location" in payload, false);
  assert.equal("description" in payload, false);
  assert.equal("attendees" in payload, false);
  assert.equal("recurrence" in payload, false);
});

test("a detail patch clears emptied fields explicitly because google only replaces what it is sent", () => {
  const payload = buildGoogleEventPayload(detailRow({
    google_location: null, google_description: "", google_attendees: [], google_recurrence: [],
  }), { ownerCode: OWNER, details: { mode: "patch" } });

  assert.equal(payload.location, "");
  assert.equal(payload.description, "");
  assert.deepEqual(payload.attendees, []);
  assert.deepEqual(payload.recurrence, []);
});

test("recurrence never rides on an instance row, so an instance edit cannot fork the series", () => {
  const payload = buildGoogleEventPayload(detailRow({ google_recurring_event_id: "master-1" }), {
    ownerCode: OWNER, details: { mode: "patch" },
  });
  assert.equal("recurrence" in payload, false);
});

// "모든 일정" 수정의 시간 규칙. 인스턴스의 날짜가 시리즈를 끌고 가면 안 된다.
test("the series anchor keeps the master date and takes only the edited time and length", () => {
  const master = { start: { dateTime: "2026-03-05T02:00:00.000Z" }, end: { dateTime: "2026-03-05T03:00:00.000Z" } };
  // 9/5 인스턴스를 14:00~15:30(서울)으로 고쳤다.
  const shifted = seriesAnchorTimes(master, {
    starts_at: "2026-09-05T05:00:00.000Z",
    ends_at: "2026-09-05T06:30:00.000Z",
  });
  assert.equal(shifted.start.dateTime, "2026-03-05T05:00:00.000Z", "마스터의 3/5 는 그대로다");
  assert.equal(shifted.end.dateTime, "2026-03-05T06:30:00.000Z", "길이는 편집한 1시간 30분이다");
  assert.equal(shifted.start.timeZone, "Asia/Seoul");
});

test("an all-day series anchor spans the edited number of days from the master date", () => {
  const shifted = seriesAnchorTimes({ start: { date: "2026-03-05" } }, {
    is_all_day: true,
    starts_at: "2026-09-05T15:00:00.000Z",
    ends_at: "2026-09-06T15:00:00.000Z",
    occurrence_on: "2026-09-06",
  });
  assert.deepEqual(shifted.start, { date: "2026-03-05" });
  // 9/6~9/7 은 이틀이므로 마스터는 3/5~3/6, 구글의 끝은 배타적이라 3/7 이다.
  assert.deepEqual(shifted.end, { date: "2026-03-07" });
});

test("a master whose start cannot be read yields no anchor so the series times stay untouched", () => {
  assert.equal(seriesAnchorTimes({}, { starts_at: "2026-09-05T05:00:00.000Z" }), null);
  assert.equal(seriesAnchorTimes({ start: { dateTime: "2026-03-05T02:00:00.000Z" } }, {}), null);
});

test("an existing conference is never re-requested", () => {
  const payload = buildGoogleEventPayload(detailRow({ google_conference_uri: "https://meet.google.com/abc" }), {
    ownerCode: OWNER, createConference: true, details: { mode: "patch" },
  });
  assert.equal("conferenceData" in payload, false);
});

// 배경 push 가 상세를 다시 실으면 events.patch 가 배열을 통째로 갈아치워
// 모든 참석자의 RSVP 가 초기화된다. 그래서 details 없이 나가야 한다.
test("the background push payload carries no attendees, recurrence, location or description", async () => {
  const { ctx } = makeCtx({
    schedule_items: (op) => (op.kind === "select" ? { data: [detailRow({ google_sync_state: "pending" })], error: null } : { data: null, error: null }),
    clients: { data: [], error: null },
  });
  let body = null;
  const { impl } = fetchMock({
    [`POST ${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events`]: (call) => {
      body = JSON.parse(call.options.body);
      return jsonResponse(200, { id: "gev-bg" });
    },
  });

  await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { fetchImpl: impl });

  assert.equal("attendees" in body, false);
  assert.equal("recurrence" in body, false);
  assert.equal("location" in body, false);
  assert.equal("description" in body, false);
  assert.equal(body.summary, "월간 정산 미팅");
});

test("recurrence summaries collapse to the presets the dialog can produce", () => {
  assert.equal(describeRecurrence([]), "반복 안 함");
  assert.equal(describeRecurrence(null), "반복 안 함");
  assert.equal(describeRecurrence(["RRULE:FREQ=DAILY"]), "매일");
  assert.equal(describeRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]), "매주 월, 수");
  assert.equal(describeRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]), "주중 매일");
  assert.equal(describeRecurrence(["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"]), "매월 13일");
  assert.equal(describeRecurrence(["RRULE:FREQ=YEARLY"]), "매년");
  assert.equal(describeRecurrence(["RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=13"]), "맞춤 반복");
  assert.equal(describeRecurrence(["RRULE:FREQ=MONTHLY;BYDAY=2TU"]), "맞춤 반복");
  assert.equal(describeRecurrence(["RDATE:20260913T050000Z"]), "맞춤 반복");
});

test("recurrence lines are checked for the RFC5545 prefix, a FREQ and sane limits", () => {
  assert.deepEqual(validateRecurrenceLines(undefined), { ok: true, value: [] });
  assert.deepEqual(validateRecurrenceLines(["RRULE:FREQ=DAILY"]), { ok: true, value: ["RRULE:FREQ=DAILY"] });
  assert.equal(validateRecurrenceLines("RRULE:FREQ=DAILY").ok, false);
  assert.equal(validateRecurrenceLines(["FREQ=DAILY"]).ok, false);
  assert.equal(validateRecurrenceLines(["RRULE:BYDAY=MO"]).ok, false);
  assert.equal(validateRecurrenceLines([`RRULE:FREQ=DAILY;X=${"a".repeat(600)}`]).ok, false);
  assert.equal(validateRecurrenceLines(new Array(5).fill("RRULE:FREQ=DAILY")).ok, false);
});

test("mirror fields keep the conference link and drop it from no answer at all", () => {
  const withMeet = googleMirrorFields(timedEvent({
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    recurrence: ["RRULE:FREQ=DAILY"],
    attendees: [{ email: "a@b.com", responseStatus: "accepted" }],
  }));
  assert.equal(withMeet.google_conference_uri, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual(withMeet.google_recurrence, ["RRULE:FREQ=DAILY"]);
  assert.deepEqual(withMeet.google_attendees, [{ email: "a@b.com", responseStatus: "accepted" }]);

  const entryPoints = googleMirrorFields(timedEvent({
    conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://meet.google.com/xyz" }] },
  }));
  assert.equal(entryPoints.google_conference_uri, "https://meet.google.com/xyz");

  // 버전 0 응답에는 conferenceData 가 없고 인스턴스 응답에는 recurrence 가 없다.
  // 없다고 null 로 덮으면 저장해 둔 링크와 반복 요약이 사라진다.
  assert.equal("google_conference_uri" in googleMirrorFields(timedEvent()), false);
  assert.equal("google_recurrence" in googleMirrorFields(timedEvent()), false);
  assert.deepEqual(googleMirrorFields(timedEvent({ recurrence: [] })).google_recurrence, []);
});

test("inbound sync imports the per-event color and never invents one for an event without the key", () => {
  assert.equal(googleMirrorFields(timedEvent({ colorId: "11" })).google_color_id, "11");
  assert.equal(mapGoogleEventToScheduleRow(timedEvent({ colorId: "5" }), { ownerCode: OWNER, calendarId: TEAM_CALENDAR }).google_color_id, "5");
  assert.equal(inboundUpdatePatch(timedEvent({ colorId: "3" }), { id: "row-1" }).patch.google_color_id, "3");

  // colorId 는 색을 지정한 일정에만 실려 온다. 키가 없는 응답을 null 로 받아쓰면
  // 대표님이 고른 색이 매 동기화마다 지워진다.
  assert.equal("google_color_id" in googleMirrorFields(timedEvent()), false, "키가 없으면 저장해 둔 색을 건드리지 않는다");
  assert.equal("google_color_id" in inboundUpdatePatch(timedEvent(), { id: "row-1" }).patch, false);

  // 키가 있는데 비어 있으면 그것은 "이 일정은 캘린더 색을 따른다" 는 답이다.
  assert.equal(googleMirrorFields(timedEvent({ colorId: "" })).google_color_id, null);
  assert.equal(googleMirrorFields(timedEvent({ colorId: null })).google_color_id, null);
  // 팔레트에 없는 값을 그대로 저장하면 화면이 색을 못 찾는다. 열 제약과 같은 범위로 좁힌다.
  assert.equal(googleMirrorFields(timedEvent({ colorId: "99" })).google_color_id, null);
});

test("a dialog write sends the chosen color and clears it with null only when the dialog asked", () => {
  const row = { id: "row-1", title: "정산", starts_at: "2026-09-13T05:00:00.000Z", google_color_id: "11" };

  const inserted = buildGoogleEventPayload(row, { details: { mode: "insert" } });
  assert.equal(inserted.colorId, "11");
  // 기본값("캘린더 색")은 구글에서 colorId 가 없는 상태 그 자체다. 새로 만들 때는 싣지 않는다.
  assert.equal("colorId" in buildGoogleEventPayload({ ...row, google_color_id: null }, { details: { mode: "insert" } }), false);
  assert.equal("colorId" in buildGoogleEventPayload({ ...row, google_color_id: "99" }, { details: { mode: "insert" } }), false,
    "팔레트에 없는 값은 구글로 나가지 않는다");

  // patch 는 null 을 실어야만 색이 지워져 캘린더 색으로 돌아간다.
  assert.equal(buildGoogleEventPayload({ ...row, google_color_id: null }, { details: { mode: "patch" } }).colorId, null);
  assert.equal(buildGoogleEventPayload(row, { details: { mode: "patch" } }).colorId, "11");
  // 다이얼로그가 지목하지 않은 필드는 건드리지 않는다.
  assert.equal("colorId" in buildGoogleEventPayload(row, { details: { mode: "patch", fields: ["location"] } }), false);
  assert.equal("colorId" in buildGoogleEventPayload(row, {}), false, "상세 없이 미는 백그라운드 push 는 색을 건드리지 않는다");
});

const OWNER_ACCESS = { role: "owner", ownerAgencyCode: OWNER, client: null, team: null };

function writeCtx(extra = {}) {
  return makeCtx({
    owner_google_integrations: (op) => (op.kind === "select" ? { data: INTEGRATION, error: null } : { data: null, error: null }),
    owner_google_calendar_sync: (op) => (op.kind === "select" ? { data: [], error: null } : { data: null, error: null }),
    ...extra,
  });
}

test("a dialog insert asks for conference support and carries the invite preference", async () => {
  const { ctx } = writeCtx();
  const eventsUrl = `${CALENDAR_BASE}/calendars/pick%40group.calendar.google.com/events`;
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${eventsUrl}`]: jsonResponse(200, {
      id: "gev-new", etag: '"e1"', updated: "2026-09-01T00:00:00.000Z",
      hangoutLink: "https://meet.google.com/abc", recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
    }),
  });

  const result = await writeRowToGoogleFirst(ctx, GOOGLE_ENV, OWNER_ACCESS, detailRow(), {
    mode: "insert",
    calendarId: "pick@group.calendar.google.com",
    sendUpdates: "all",
    createConference: true,
    fetchImpl: impl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.calendarId, "pick@group.calendar.google.com");
  const insert = calls.find((call) => call.url === eventsUrl);
  assert.deepEqual(insert.query, { conferenceDataVersion: "1", sendUpdates: "all" });
  assert.equal(result.values.google_event_id, "gev-new");
  assert.equal(result.values.google_calendar_id, "pick@group.calendar.google.com");
  assert.equal(result.values.google_conference_uri, "https://meet.google.com/abc");
  assert.equal(result.values.google_sync_state, "synced");
});

test("a dialog patch keeps conference version 0 unless this very request creates a meeting", async () => {
  const path = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events/gev-1`;
  const plain = writeCtx();
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`PATCH ${path}`]: jsonResponse(200, { id: "gev-1", etag: '"e2"' }),
  });
  await writeRowToGoogleFirst(plain.ctx, GOOGLE_ENV, OWNER_ACCESS, detailRow({ google_event_id: "gev-1" }), {
    mode: "patch", sendUpdates: "none", fetchImpl: impl,
  });
  assert.deepEqual(calls.find((call) => call.method === "PATCH").query, { sendUpdates: "none" });

  const meeting = writeCtx();
  const second = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`PATCH ${path}`]: jsonResponse(200, { id: "gev-1", etag: '"e3"' }),
  });
  await writeRowToGoogleFirst(meeting.ctx, GOOGLE_ENV, OWNER_ACCESS, detailRow({ google_event_id: "gev-1" }), {
    mode: "patch", createConference: true, fetchImpl: second.impl,
  });
  assert.deepEqual(second.calls.find((call) => call.method === "PATCH").query, {
    conferenceDataVersion: "1", sendUpdates: "all",
  });
});

test("a google-first write reports the failure shape the handler turns into a 502", async () => {
  const { ctx } = writeCtx();
  const { impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events`]: jsonResponse(403, { error: { code: 403 } }),
  });
  const failed = await writeRowToGoogleFirst(ctx, GOOGLE_ENV, OWNER_ACCESS, detailRow(), { mode: "insert", fetchImpl: impl });
  assert.deepEqual(failed, { ok: false, reason: "google_403" });

  const expired = writeCtx();
  const { impl: expiredImpl } = fetchMock({
    [`POST ${TOKEN_URL}`]: jsonResponse(400, { error: "invalid_grant" }),
  });
  const reconnect = await writeRowToGoogleFirst(expired.ctx, GOOGLE_ENV, OWNER_ACCESS, detailRow(), { mode: "insert", fetchImpl: expiredImpl });
  assert.deepEqual(reconnect, { ok: false, reason: "needs_reconnect" });

  const outOfScope = await writeRowToGoogleFirst(expired.ctx, GOOGLE_ENV, { role: "team" }, detailRow(), { mode: "insert", fetchImpl: expiredImpl });
  assert.equal(outOfScope.skipped, true);
  const missingEnv = await writeRowToGoogleFirst(expired.ctx, {}, OWNER_ACCESS, detailRow(), { mode: "insert", fetchImpl: expiredImpl });
  assert.deepEqual(missingEnv, { ok: true, skipped: true, reason: "env" });
});

test("a dialog insert falls back to the primary calendar once the dedicated one is retired", async () => {
  // 회수를 마친 연동: calendar_id 가 null 이라 예전 코드라면 no_calendar 로 502 였다.
  const { ctx } = makeCtx({
    owner_google_integrations: (op) => (op.kind === "select"
      ? { data: { ...INTEGRATION, calendar_id: null }, error: null }
      : { data: null, error: null }),
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? { data: [{ google_calendar_id: PRIMARY_ID, calendar_role: "primary", calendar_summary: "내 캘린더" }], error: null }
      : { data: null, error: null }),
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/owner%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${eventsUrl}`]: jsonResponse(200, { id: "gev-new", etag: '"e1"', updated: "2026-09-01T00:00:00.000Z" }),
  });

  const result = await writeRowToGoogleFirst(ctx, GOOGLE_ENV, OWNER_ACCESS, detailRow(), { mode: "insert", fetchImpl: impl });

  assert.equal(result.ok, true);
  assert.equal(result.calendarId, PRIMARY_ID);
  assert.equal(result.values.google_calendar_id, PRIMARY_ID);
  assert.equal(result.calendarName, "내 캘린더");
  assert.equal(calls.some((call) => call.url === `${CALENDAR_BASE}/calendars/primary`), false,
    "카탈로그 캐시가 답을 들고 있으면 다이얼로그 저장은 구글을 부르지 않는다");
});

test("instances are collected across pages inside the sync window without writing rows", async () => {
  const { ctx, ops } = makeCtx({});
  const instancesUrl = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events/master-1/instances`;
  const { calls, impl } = fetchMock({
    [`GET ${instancesUrl}`]: sequence(
      jsonResponse(200, { items: [timedEvent({ id: "master-1_a", recurringEventId: "master-1" })], nextPageToken: "p2" }),
      jsonResponse(200, {
        items: [
          timedEvent({ id: "master-1_b", recurringEventId: "master-1" }),
          timedEvent({ id: "master-1_c", status: "cancelled" }),
        ],
      }),
    ),
  });

  const result = await materializeRecurringInstances(ctx, GOOGLE_ENV, {
    accessToken: "gat-1",
    calendarId: INTEGRATION.calendar_id,
    masterEventId: "master-1",
    now: NOW,
    fetchImpl: impl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.instances.map((event) => event.id), ["master-1_a", "master-1_b"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.maxResults, "250");
  assert.equal(calls[0].query.showDeleted, "false");
  assert.equal(calls[0].query.timeMin, syncWindow(NOW).timeMin);
  assert.equal(calls[1].query.pageToken, "p2");
  assert.equal(ops.length, 0, "행은 여기서 쓰지 않는다");
});

test("the calendar catalog stores writable calendars and never overwrites a known role", async () => {
  const { ctx, ops } = makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? { data: [{ google_calendar_id: INTEGRATION.calendar_id, calendar_role: "dedicated" }], error: null }
      : { data: null, error: null }),
  });
  const { calls, impl } = fetchMock({
    [`GET ${CALENDAR_BASE}/users/me/calendarList`]: jsonResponse(200, {
      items: [
        { id: INTEGRATION.calendar_id, summary: "모먼트 인사이트", accessRole: "owner" },
        { id: "owner@example.com", summary: "owner@example.com", summaryOverride: "내 캘린더", accessRole: "owner", primary: true },
        { id: "team@group.calendar.google.com", summary: "팀 일정", accessRole: "writer" },
        { id: "gone@group.calendar.google.com", summary: "지운 것", accessRole: "writer", deleted: true },
      ],
    }),
  });

  const result = await refreshOwnerCalendarCatalog(ctx, OWNER, "gat-1", { fetchImpl: impl });

  assert.deepEqual(result, { ok: true, saved: 3 });
  // minAccessRole 을 빼야 공휴일·구독 캘린더처럼 읽기 전용인 것까지 목록에 담긴다.
  assert.deepEqual(calls[0].query, { showHidden: "false", showDeleted: "false", maxResults: "250" });
  const upserts = opsFor(ops, "owner_google_calendar_sync", "upsert");
  assert.deepEqual(upserts.map((op) => op.values.google_calendar_id),
    [INTEGRATION.calendar_id, "owner@example.com", "team@group.calendar.google.com"]);
  assert.equal(upserts[0].values.calendar_role, "dedicated", "이미 아는 역할은 secondary 로 덮지 않는다");
  assert.equal(upserts[1].values.calendar_role, "secondary");
  assert.equal(upserts[1].values.calendar_summary, "내 캘린더");
  assert.equal(upserts[1].values.calendar_is_primary, true);
  assert.equal(upserts[2].values.calendar_writable, true);
});

test("a catalog refresh failure is swallowed so it can never fail a sync", async () => {
  const { ctx } = makeCtx({});
  const { impl } = fetchMock({});
  assert.deepEqual(await refreshOwnerCalendarCatalog(ctx, OWNER, "gat-1", { fetchImpl: impl }), {
    ok: false, reason: "network", saved: 0,
  });
});

test("the writable calendar list puts the dedicated calendar first, then primary, then names", async () => {
  const { ctx } = makeCtx({
    owner_google_calendar_sync: {
      data: [
        { google_calendar_id: "team@group.calendar.google.com", calendar_role: "secondary", calendar_summary: "팀 일정", calendar_access_role: "writer", calendar_is_primary: false, calendar_writable: true },
        { google_calendar_id: "owner@example.com", calendar_role: "primary", calendar_summary: "내 캘린더", calendar_access_role: "owner", calendar_is_primary: true, calendar_writable: true },
        { google_calendar_id: INTEGRATION.calendar_id, calendar_role: "dedicated", calendar_summary: "모먼트 인사이트", calendar_access_role: "owner", calendar_is_primary: false, calendar_writable: true },
        { google_calendar_id: "readonly@group.calendar.google.com", calendar_role: "secondary", calendar_summary: "읽기 전용", calendar_writable: false },
      ],
      error: null,
    },
  });

  const calendars = await listOwnerWritableCalendars(ctx, OWNER, INTEGRATION);

  assert.deepEqual(calendars.map((entry) => entry.id), [
    INTEGRATION.calendar_id, "owner@example.com", "team@group.calendar.google.com",
  ]);
  assert.equal(calendars[0].dedicated, true);
  assert.equal(calendars[1].primary, true);
  assert.equal(calendars[2].accessRole, "writer");
});

test("an empty catalog still offers the dedicated calendar and never calls google", async () => {
  const { ctx } = makeCtx({ owner_google_calendar_sync: { data: [], error: null } });
  assert.deepEqual(await listOwnerWritableCalendars(ctx, OWNER, INTEGRATION), [{
    id: INTEGRATION.calendar_id, name: "모먼트 인사이트", primary: false, accessRole: "owner", dedicated: true,
  }]);
  const broken = makeCtx({ owner_google_calendar_sync: { data: null, error: { code: "42P01", message: "relation does not exist" } } });
  assert.deepEqual(await listOwnerWritableCalendars(broken.ctx, OWNER, null), []);
});

test("a missing optional column retries once without it instead of surfacing a 500", async () => {
  resetOptionalColumns();
  try {
    let attempt = 0;
    const { ctx, ops } = makeCtx({
      schedule_items: (op) => {
        if (op.kind !== "select") return { data: null, error: null };
        attempt += 1;
        return attempt === 1
          ? { data: null, error: { code: "42703", message: 'column schedule_items.google_recurrence does not exist' } }
          : { data: [], error: null };
      },
    });

    const result = await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", { fetchImpl: async () => { throw new Error("no google"); } });

    assert.deepEqual(result, { pushed: 0, pushFailed: 0 });
    const selects = opsFor(ops, "schedule_items", "select");
    assert.equal(selects.length, 2, "정확히 한 번만 재시도한다");
    assert.ok(selects[0].fields.includes("google_recurrence"));
    assert.equal(selects[1].fields.includes("google_recurrence"), false);
    assert.equal(selects[1].fields.includes("google_conference_uri"), false);
    assert.ok(selects[1].fields.includes("google_event_id"), "필수 열은 그대로 남는다");
  } finally {
    resetOptionalColumns();
  }
});

// ─────────────────────────────────────────────────────────────
// 선택 열 강등의 자가 치유 (운영 사고 회귀 방지)
//
// 코드가 먼저 배포되고 SQL 이 나중에 들어오는 창에서 강등된 람다는, 예전 구현
// 에서는 SQL 이 들어온 뒤에도 프로세스가 죽을 때까지 열을 뺀 채로 살았다.
// 아래 네 가지가 "재배포 없이 스스로 낫는다"를 못 박는다.
// ─────────────────────────────────────────────────────────────

// 이 묶음의 스텁은 "그 열을 달라고 한 질의만 실패한다" 로 마이그레이션 전/후를
// 흉내 낸다. migrated 를 켜면 그 순간 SQL 이 들어온 것과 같다.
function optionalColumnCtx(state) {
  return makeCtx({
    schedule_items: (op) => {
      if (op.kind !== "select") return { data: null, error: null };
      if (!state.migrated && op.fields.includes("google_recurrence")) {
        return { data: null, error: { code: "42703", message: "column schedule_items.google_recurrence does not exist" } };
      }
      return { data: [], error: null };
    },
  });
}

const NO_GOOGLE = { fetchImpl: async () => { throw new Error("no google"); } };

test("a demoted column group heals itself after the retry window, with no restart", async () => {
  resetOptionalColumns();
  try {
    const state = { migrated: false };
    const { ctx, ops } = optionalColumnCtx(state);
    let clock = NOW;
    setOptionalColumnClock(() => clock);

    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);
    assert.deepEqual(disabledOptionalColumns().sort(), [...OPTIONAL_SCHEDULE_COLUMNS].sort(), "묶음 전체가 함께 내려간다");

    // TTL 안에서는 그대로 열을 뺀 채로 나간다.
    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);
    assert.equal(opsFor(ops, "schedule_items", "select").at(-1).fields.includes("google_recurrence"), false);

    // 마이그레이션이 들어왔다. 람다는 그대로 살아 있다.
    state.migrated = true;
    clock += OPTIONAL_COLUMN_RETRY_MS;

    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);
    const healed = opsFor(ops, "schedule_items", "select").at(-1);
    assert.ok(healed.fields.includes("google_recurrence"), "재배포도 resetOptionalColumns 도 없이 열이 다시 실린다");
    assert.ok(healed.fields.includes("google_calendar_name"));
    assert.deepEqual(disabledOptionalColumns(), []);
  } finally {
    resetOptionalColumns();
  }
});

test("the visibility toggle stops answering unsupported once the retry window elapses", async () => {
  resetOptionalColumns();
  try {
    let migrated = false;
    const { ctx, ops } = makeCtx({
      owner_google_calendar_sync: (op) => {
        if (op.kind !== "update") return { data: null, error: null };
        return migrated
          ? { data: { google_calendar_id: TEAM_CALENDAR }, error: null }
          : { data: null, error: { code: "42703", message: "column owner_google_calendar_sync.calendar_visible does not exist" } };
      },
    });
    let clock = NOW;
    setOptionalColumnClock(() => clock);

    assert.deepEqual(await setOwnerCalendarVisibility(ctx, OWNER, TEAM_CALENDAR, false), { ok: false, reason: "unsupported" });
    assert.equal(opsFor(ops, "owner_google_calendar_sync", "update").length, 1, "없는 열에 다시 쓰지 않는다");

    // TTL 안에서는 DB 를 건드리지도 않고 곧바로 미지원으로 답한다.
    assert.deepEqual(await setOwnerCalendarVisibility(ctx, OWNER, TEAM_CALENDAR, false), { ok: false, reason: "unsupported" });
    assert.equal(opsFor(ops, "owner_google_calendar_sync", "update").length, 1);

    migrated = true;
    clock += OPTIONAL_COLUMN_RETRY_MS;

    assert.deepEqual(await setOwnerCalendarVisibility(ctx, OWNER, TEAM_CALENDAR, false), { ok: true, updated: true },
      "TTL 이 지나면 미지원이라고 단정하지 않고 DB 를 실제로 다시 두드린다");
    assert.equal(opsFor(ops, "owner_google_calendar_sync", "update").length, 2);
  } finally {
    resetOptionalColumns();
  }
});

test("a column group still missing after the retry window re-arms instead of flapping", async () => {
  resetOptionalColumns();
  try {
    const state = { migrated: false };
    const { ctx, ops } = optionalColumnCtx(state);
    let clock = NOW;
    setOptionalColumnClock(() => clock);
    const selects = () => opsFor(ops, "schedule_items", "select").length;

    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);
    assert.equal(selects(), 2, "첫 강등은 정확히 한 번만 재시도한다");

    clock += OPTIONAL_COLUMN_RETRY_MS;
    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);
    assert.equal(selects(), 4, "TTL 이 지나면 딱 한 번 다시 떠본다");

    // 여전히 없으므로 타이머만 새로 감겼다. 이어지는 호출은 재프로브 없이
    // 열을 뺀 질의 하나씩이다 — 매 호출마다 42703 을 다시 맞지 않는다.
    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);
    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);
    assert.equal(selects(), 6);
  } finally {
    resetOptionalColumns();
  }
});

test("optional column groups expire independently of one another", async () => {
  resetOptionalColumns();
  try {
    let clock = NOW;
    setOptionalColumnClock(() => clock);

    assert.equal(disableOptionalColumns({ code: "42703" }, OPTIONAL_CALENDAR_CATALOG_COLUMNS), true);
    assert.equal(optionalColumnEnabled("calendar_visible"), false);
    assert.equal(optionalColumnEnabled("google_recurrence"), true, "다른 마이그레이션의 묶음은 함께 내려가지 않는다");

    // 카탈로그 묶음이 반쯤 지났을 때 일정 묶음이 내려간다. 타이머는 각자 돈다.
    clock += Math.floor(OPTIONAL_COLUMN_RETRY_MS / 2);
    assert.equal(disableOptionalColumns({ code: "42703" }, OPTIONAL_SCHEDULE_COLUMNS), true);
    assert.equal(optionalColumnEnabled("google_recurrence"), false);
    assert.equal(optionalColumnEnabled("calendar_visible"), false, "아직 둘 다 살아 있다");

    clock += Math.ceil(OPTIONAL_COLUMN_RETRY_MS / 2);
    assert.equal(optionalColumnEnabled("calendar_visible"), true, "먼저 내려간 묶음이 먼저 만료된다");
    assert.equal(optionalColumnEnabled("google_recurrence"), false, "나중에 내려간 묶음은 아직 만료 전이다");
    assert.deepEqual(disabledOptionalColumns().sort(), [...OPTIONAL_SCHEDULE_COLUMNS].sort());
  } finally {
    resetOptionalColumns();
  }
});

// 일정 색 마이그레이션은 위 묶음들과 별개로 적용된다. 색 열만 없는 창에서
// 참석자·반복 요약까지 함께 내려가면 안 되고, 그 반대도 마찬가지다.
test("the event color column is its own group and heals on its own timer", async () => {
  resetOptionalColumns();
  try {
    const state = { migrated: false };
    const { ctx, ops } = makeCtx({
      schedule_items: (op) => {
        if (op.kind !== "select") return { data: null, error: null };
        if (!state.migrated && op.fields.includes("google_color_id")) {
          return { data: null, error: { code: "42703", message: "column schedule_items.google_color_id does not exist" } };
        }
        return { data: [], error: null };
      },
    });
    let clock = NOW;
    setOptionalColumnClock(() => clock);

    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);

    assert.deepEqual(disabledOptionalColumns(), [...OPTIONAL_EVENT_COLOR_COLUMNS], "색 묶음만 내려간다");
    assert.equal(optionalColumnEnabled("google_recurrence"), true, "다른 마이그레이션의 상세 열은 그대로 살아 있다");
    const degraded = opsFor(ops, "schedule_items", "select").at(-1);
    assert.equal(degraded.fields.includes("google_color_id"), false);
    assert.ok(degraded.fields.includes("google_recurrence"), "함께 실리던 상세 열은 계속 실린다");
    assert.equal(opsFor(ops, "schedule_items", "select").length, 2, "정확히 한 번만 재시도한다");

    state.migrated = true;
    clock += OPTIONAL_COLUMN_RETRY_MS;

    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);
    assert.ok(opsFor(ops, "schedule_items", "select").at(-1).fields.includes("google_color_id"),
      "재배포 없이 스스로 낫는다");
    assert.deepEqual(disabledOptionalColumns(), []);
  } finally {
    resetOptionalColumns();
  }
});

test("a query carrying both migrations demotes only the group the error names", async () => {
  resetOptionalColumns();
  try {
    setOptionalColumnClock(() => NOW);
    // 두 마이그레이션의 열이 한 질의에 함께 실린다. 먼저 색이 없다고 하고,
    // 다음 시도에서는 상세 열이 없다고 한다 — 각각 자기 묶음만 내려가야 한다.
    const missing = ["google_color_id", "google_recurrence"];
    const { ctx, ops } = makeCtx({
      schedule_items: (op) => {
        if (op.kind !== "select") return { data: null, error: null };
        const absent = missing.find((column) => op.fields.includes(column));
        if (!absent) return { data: [], error: null };
        return { data: null, error: { code: "42703", message: `column schedule_items.${absent} does not exist` } };
      },
    });

    await pushPendingRows(ctx, GOOGLE_ENV, OWNER, INTEGRATION, "gat-1", NO_GOOGLE);

    assert.deepEqual(disabledOptionalColumns().sort(), [...OPTIONAL_EVENT_COLOR_COLUMNS, ...OPTIONAL_SCHEDULE_COLUMNS].sort(),
      "한 질의 안에서도 묶음마다 한 번씩 물러난다");
    assert.equal(opsFor(ops, "schedule_items", "select").length, 3, "묶음 수만큼만 물러나고 그 뒤로는 멈춘다");
    const last = opsFor(ops, "schedule_items", "select").at(-1);
    assert.ok(last.fields.includes("google_event_id"), "필수 열은 그대로 남는다");
  } finally {
    resetOptionalColumns();
  }
});

test("a successful select carrying the columns lifts the demotion before the timer", async () => {
  resetOptionalColumns();
  try {
    let clock = NOW;
    setOptionalColumnClock(() => clock);
    assert.equal(disableOptionalColumns({ code: "42703" }, OPTIONAL_SCHEDULE_COLUMNS), true);
    assert.equal(optionalColumnEnabled("google_conference_uri"), false);

    // 열을 실제로 들고 온 SELECT 는 마이그레이션이 들어왔다는 확실한 증거다.
    // 값이 null 이어도 키가 있으면 열은 있는 것이다.
    await runWithOptionalColumns(() => Promise.resolve({
      data: [{ id: "row-1", google_recurrence: null }],
      error: null,
    }), OPTIONAL_SCHEDULE_COLUMNS);

    assert.deepEqual(disabledOptionalColumns(), [], "TTL 을 기다리지 않고 곧바로 되올린다");
  } finally {
    resetOptionalColumns();
  }
});

test("calendars already carrying MI events join the pull so a third calendar still syncs", async () => {
  const { ctx } = makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select" ? { data: [], error: null } : { data: null, error: null }),
    schedule_items: { data: [
      { google_calendar_id: "third@group.calendar.google.com" },
      { google_calendar_id: "third@group.calendar.google.com" },
      { google_calendar_id: INTEGRATION.calendar_id },
    ], error: null },
  });
  const { impl } = fetchMock({
    [`GET ${CALENDAR_BASE}/calendars/primary`]: jsonResponse(200, { id: "owner@example.com" }),
  });

  const calendars = await resolveOwnerCalendars(ctx, OWNER, INTEGRATION, { accessToken: "gat-1", fetchImpl: impl });

  assert.deepEqual(calendars.map((entry) => entry.google_calendar_id), [
    INTEGRATION.calendar_id, "owner@example.com", "third@group.calendar.google.com",
  ]);
  assert.equal(calendars.at(-1).calendar_role, "secondary");
});

// ─────────────────────────────────────────────────────────────
// 캘린더 목록(사이드바) 카탈로그
// ─────────────────────────────────────────────────────────────

const HOLIDAY_CALENDAR = "holidays@group.calendar.google.com";
const TEAM_CALENDAR = "team@group.calendar.google.com";

test("hex colors are normalized to lowercase #rrggbb and anything else is dropped", () => {
  assert.equal(hexColor("#0088AA"), "#0088aa");
  assert.equal(hexColor("#FFF"), "#ffffff");
  assert.equal(hexColor("0088aa"), null);
  assert.equal(hexColor("rgb(0,136,170)"), null);
  assert.equal(hexColor(""), null);
  assert.equal(hexColor(null), null);
});

// ─────────────────────────────────────────────────────────────
// 색 팔레트: 레거시(API) → 모던(웹 UI)
//
// 대표님 기준은 "구글 화면과 하나도 다르지 않게" 다. API 가 주는 값과 구글이
// 실제로 칠하는 값이 다르므로, 그 대응표가 어긋나면 곧바로 색이 틀린다.
// ─────────────────────────────────────────────────────────────

test("legacy calendar colors map onto the palette google actually paints", () => {
  assert.equal(modernCalendarColor("#16a765"), "#0b8043", "Basil 초록이 광복절 초록과 같아진다");
  assert.equal(modernCalendarColor("#cd74e6"), "#8e24aa", "Grape 보라가 타임딜 보라와 같아진다");
  assert.equal(modernCalendarColor("#9fe1e7"), "#039be5", "Peacock 하늘색이 구글 파랑과 같아진다");
  assert.equal(modernCalendarColor("#16A765"), "#0b8043", "대문자 16진도 같은 색이다");
  // colorId 를 아는 경우가 가장 정확하다. 배경색과 어긋나도 id 가 이긴다.
  assert.equal(modernCalendarColor("#16a765", "23"), "#8e24aa", "colorId 를 알면 그것이 먼저다");
  // 표에 없는 색은 지어내지 않고 구글이 준 값을 그대로 쓴다.
  assert.equal(modernCalendarColor("#123456"), "#123456", "모르는 색은 원본을 그대로 통과시킨다");
  assert.equal(modernCalendarColor("#abc"), "#aabbcc", "3자리 축약형도 원본 그대로 펼쳐진다");
  assert.equal(modernCalendarColor("rgb(0,0,0)"), "", "색이 아닌 값은 빈 문자열이다");
  assert.equal(modernCalendarColor(""), "");
  assert.equal(modernCalendarColor(null), "");
});

test("event color ids map onto the swatch colors the google dialog shows", () => {
  assert.equal(modernEventColor("11"), "#d50000", "토마토");
  assert.equal(modernEventColor("5"), "#f6bf26", "바나나");
  assert.equal(modernEventColor("99"), "", "팔레트에 없는 id 는 색이 없다");
  assert.equal(modernEventColor(""), "");
  assert.equal(modernEventColor(null), "");
  assert.equal(eventColorName("11"), "토마토");
  assert.equal(eventColorName("99"), "");
  assert.equal(isEventColorId("1"), true);
  assert.equal(isEventColorId("11"), true);
  assert.equal(isEventColorId("0"), false);
  assert.equal(isEventColorId("12"), false);
  assert.equal(isEventColorId(""), false);
});

test("both palettes are complete, unambiguous and fully mapped", () => {
  assert.equal(EVENT_COLOR_PALETTE.length, 11, "구글 일정 색은 11개다");
  assert.equal(CALENDAR_COLOR_PALETTE.length, 24, "구글 캘린더 색은 24개다");

  for (const palette of [EVENT_COLOR_PALETTE, CALENDAR_COLOR_PALETTE]) {
    const ids = palette.map((entry) => entry.id);
    const modern = palette.map((entry) => entry.modern);
    const legacy = palette.map((entry) => entry.legacy);
    assert.equal(new Set(ids).size, palette.length, "id 가 겹치지 않는다");
    assert.equal(new Set(modern).size, palette.length, "모던 16진이 겹치지 않는다 — 겹치면 두 색이 같아 보인다");
    assert.equal(new Set(legacy).size, palette.length, "레거시 16진이 겹치지 않는다 — 겹치면 역매핑이 흔들린다");
    for (const entry of palette) {
      assert.equal(normalizeHexColor(entry.legacy), entry.legacy, `${entry.name} 레거시 값이 #rrggbb 소문자다`);
      assert.equal(normalizeHexColor(entry.modern), entry.modern, `${entry.name} 모던 값이 #rrggbb 소문자다`);
    }
  }

  // 11개 id 가 하나도 빠짐없이 색과 한국어 이름을 갖는다.
  for (const entry of EVENT_COLOR_PALETTE) {
    assert.equal(modernEventColor(entry.id), entry.modern, `${entry.name} id 가 색으로 이어진다`);
    assert.ok(eventColorName(entry.id), `${entry.name} 에 한국어 표기가 있다`);
  }
  assert.deepEqual([...EVENT_COLOR_DISPLAY_ORDER].sort(), EVENT_COLOR_PALETTE.map((entry) => entry.id).sort(),
    "스와치 표시 순서가 팔레트의 id 를 하나도 빠뜨리거나 더하지 않는다");
  // 캘린더 색은 id 로도 레거시 16진으로도 같은 곳에 도착한다.
  for (const entry of CALENDAR_COLOR_PALETTE) {
    assert.equal(modernCalendarColor(entry.legacy), entry.modern, `${entry.name} 레거시 값이 모던 값으로 이어진다`);
    assert.equal(modernCalendarColor("", entry.id), entry.modern, `${entry.name} id 가 모던 값으로 이어진다`);
  }
});

test("the ink on a swatch is picked from its luminance, not from a fixed table", () => {
  assert.equal(readableTextColor("#f6bf26"), "#1f1f1f", "밝은 바나나 위에는 진한 글자다");
  assert.equal(readableTextColor("#0b8043"), "#ffffff", "짙은 바질 위에는 흰 글자다");
  assert.equal(readableTextColor("#d50000"), "#ffffff");
  assert.equal(readableTextColor(""), "", "색을 모르면 글자색도 정하지 않는다");
  assert.equal(readableTextColor("rgb(0,0,0)"), "");
});

test("the catalog stores colors and selection and derives writable from the access role", async () => {
  const { ctx, ops } = makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select" ? { data: [], error: null } : { data: null, error: null }),
  });
  const { impl } = fetchMock({
    [`GET ${CALENDAR_BASE}/users/me/calendarList`]: jsonResponse(200, {
      items: [
        { id: HOLIDAY_CALENDAR, summary: "대한민국 공휴일", accessRole: "reader", backgroundColor: "#0088AA", foregroundColor: "#FFF", selected: true },
        { id: TEAM_CALENDAR, summary: "팀 일정", accessRole: "writerWithoutPrivateAccess", selected: false },
        { id: "busy@group.calendar.google.com", summary: "약속 보기 전용", accessRole: "freeBusyReader" },
      ],
    }),
  });

  const result = await refreshOwnerCalendarCatalog(ctx, OWNER, "gat-1", { fetchImpl: impl });

  assert.deepEqual(result, { ok: true, saved: 3 });
  const upserts = opsFor(ops, "owner_google_calendar_sync", "upsert");
  assert.equal(upserts[0].values.calendar_writable, false, "reader 캘린더는 MI 에서 쓰지 못한다");
  assert.equal(upserts[0].values.calendar_background_color, "#0088aa");
  assert.equal(upserts[0].values.calendar_foreground_color, "#ffffff");
  assert.equal(upserts[0].values.calendar_selected, true);
  assert.equal(upserts[0].values.calendar_visible, true, "처음 보는 캘린더는 구글 체크 상태를 따라간다");
  assert.equal(upserts[1].values.calendar_writable, true, "writerWithoutPrivateAccess 도 일정 쓰기 권한이다");
  assert.equal(upserts[1].values.calendar_visible, false, "구글에서 꺼져 있으면 꺼진 채로 들어온다");
  assert.equal(upserts[2].values.calendar_writable, false, "freeBusyReader 는 읽기 전용이다");
});

test("a catalog refresh never flips a calendar the owner already toggled in MI", async () => {
  const { ctx, ops } = makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? {
        data: [
          { google_calendar_id: TEAM_CALENDAR, calendar_role: "secondary", calendar_visible: false },
          { google_calendar_id: HOLIDAY_CALENDAR, calendar_role: "secondary", calendar_visible: true },
        ],
        error: null,
      }
      : { data: null, error: null }),
  });
  const { impl } = fetchMock({
    [`GET ${CALENDAR_BASE}/users/me/calendarList`]: jsonResponse(200, {
      items: [
        { id: TEAM_CALENDAR, summary: "팀 일정", accessRole: "writer", selected: true },
        { id: HOLIDAY_CALENDAR, summary: "대한민국 공휴일", accessRole: "reader", selected: false },
        { id: "new@group.calendar.google.com", summary: "새 캘린더", accessRole: "reader", selected: false },
      ],
    }),
  });

  await refreshOwnerCalendarCatalog(ctx, OWNER, "gat-1", { fetchImpl: impl });

  const upserts = opsFor(ops, "owner_google_calendar_sync", "upsert");
  assert.equal(upserts[0].values.calendar_visible, false, "MI 에서 끈 캘린더는 구글이 켜져 있어도 꺼진 채로 남는다");
  assert.equal(upserts[1].values.calendar_visible, true, "MI 에서 켠 캘린더도 그대로 둔다");
  assert.equal(upserts[2].values.calendar_visible, false, "처음 보는 캘린더에만 기본값을 넣는다");
});

test("the calendar catalog splits my calendars from the others and keeps the read-only ones", async () => {
  const { ctx } = makeCtx({
    owner_google_calendar_sync: {
      data: [
        { google_calendar_id: TEAM_CALENDAR, calendar_role: "secondary", calendar_summary: "팀 일정", calendar_access_role: "writer", calendar_writable: true, calendar_visible: true, calendar_selected: true },
        { google_calendar_id: HOLIDAY_CALENDAR, calendar_role: "secondary", calendar_summary: "대한민국 공휴일", calendar_access_role: "reader", calendar_writable: false, calendar_visible: false, calendar_background_color: "#616161", calendar_foreground_color: "#ffffff" },
        { google_calendar_id: "shared@group.calendar.google.com", calendar_role: "secondary", calendar_summary: "가나다 공유", calendar_access_role: "freeBusyReader", calendar_writable: false },
        { google_calendar_id: "owner@example.com", calendar_role: "primary", calendar_summary: "내 캘린더", calendar_access_role: "owner", calendar_is_primary: true, calendar_writable: true },
        { google_calendar_id: INTEGRATION.calendar_id, calendar_role: "dedicated", calendar_summary: "모먼트 인사이트", calendar_access_role: "owner", calendar_writable: true },
      ],
      error: null,
    },
  });

  const catalog = await listOwnerCalendarCatalog(ctx, OWNER, INTEGRATION);

  assert.deepEqual(catalog.map((entry) => entry.id), [
    "owner@example.com",
    INTEGRATION.calendar_id,
    "shared@group.calendar.google.com",
    HOLIDAY_CALENDAR,
    TEAM_CALENDAR,
  ], "내 캘린더가 먼저, 그 안에서 기본→전용→이름 순이다");
  assert.deepEqual(catalog.map((entry) => entry.group), ["own", "own", "other", "other", "other"]);
  const holiday = catalog.find((entry) => entry.id === HOLIDAY_CALENDAR);
  assert.equal(holiday.writable, false, "읽기 전용 캘린더도 목록에는 남는다");
  assert.equal(holiday.visible, false);
  assert.equal(holiday.accessRole, "reader");
  assert.equal(holiday.color, "#616161");
  assert.equal(holiday.textColor, "#ffffff");
  assert.equal(catalog[1].dedicated, true);
  assert.equal(catalog[0].primary, true);
  assert.equal(catalog.find((entry) => entry.id === TEAM_CALENDAR).selected, true);

  // 같은 캐시에서 뽑은 다이얼로그용 목록은 예전 모양과 순서를 그대로 지킨다.
  const writable = await listOwnerWritableCalendars(ctx, OWNER, INTEGRATION);
  assert.deepEqual(writable.map((entry) => entry.id), [
    INTEGRATION.calendar_id, "owner@example.com", TEAM_CALENDAR,
  ]);
  assert.deepEqual(Object.keys(writable[0]).sort(), ["accessRole", "dedicated", "id", "name", "primary"]);
});

// 캘린더 색의 정본은 colorId(1~24)다. 레거시 16진만 보고 옮기면 표에 없거나
// 어긋난 값이 미묘하게 다른 색으로 굳는다 — 대표님 기본 캘린더의 파랑이 그랬다.
test("the catalog stores the color google actually paints, keyed by colorId", async () => {
  const { ctx, ops } = makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select" ? { data: [], error: null } : { data: null, error: null }),
  });
  const { impl } = fetchMock({
    [`GET ${CALENDAR_BASE}/users/me/calendarList`]: jsonResponse(200, {
      items: [
        { id: TEAM_CALENDAR, summary: "팀 일정", accessRole: "writer", colorId: "8", backgroundColor: "#16a765", foregroundColor: "#000000" },
        { id: HOLIDAY_CALENDAR, summary: "공휴일", accessRole: "reader", colorId: "23", backgroundColor: "#123456" },
        { id: "legacy@group.calendar.google.com", summary: "id 없음", accessRole: "reader", backgroundColor: "#9fe1e7" },
        { id: "custom@group.calendar.google.com", summary: "사용자 지정", accessRole: "reader", backgroundColor: "#123456" },
        { id: "nocolor@group.calendar.google.com", summary: "색 없음", accessRole: "reader" },
      ],
    }),
  });

  const result = await refreshOwnerCalendarCatalog(ctx, OWNER, "gat-1", { fetchImpl: impl });

  assert.deepEqual(result, { ok: true, saved: 5 });
  const stored = opsFor(ops, "owner_google_calendar_sync", "upsert").map((op) => op.values);
  assert.equal(stored[0].calendar_background_color, "#0b8043", "colorId 8 은 구글이 칠하는 Basil 로 적재된다");
  assert.equal(stored[0].calendar_foreground_color, "#ffffff", "글자색은 옮긴 색 위에서 다시 정한다");
  assert.equal(stored[1].calendar_background_color, "#8e24aa", "레거시 16진을 몰라도 colorId 가 색을 정한다");
  assert.equal(stored[2].calendar_background_color, "#039be5", "colorId 가 없으면 레거시 표로 되짚는다");
  assert.equal(stored[3].calendar_background_color, "#123456", "표에도 없고 id 도 없으면 원본을 그대로 통과시킨다");
  assert.equal(stored[4].calendar_background_color, null);
  assert.equal(stored[4].calendar_foreground_color, null, "색을 모르면 글자색도 정하지 않는다");
});

test("a second catalog refresh over already-mapped rows never flips the color back", async () => {
  const item = { id: TEAM_CALENDAR, summary: "팀 일정", accessRole: "writer", colorId: "8", backgroundColor: "#16a765", foregroundColor: "#000000" };
  const table = new Map();
  const { ctx, ops } = makeCtx({
    owner_google_calendar_sync: (op) => {
      if (op.kind === "upsert") table.set(op.values.google_calendar_id, { ...op.values });
      return op.kind === "select" ? { data: [...table.values()], error: null } : { data: null, error: null };
    },
  });
  const { impl } = fetchMock({
    [`GET ${CALENDAR_BASE}/users/me/calendarList`]: jsonResponse(200, { items: [item] }),
  });

  await refreshOwnerCalendarCatalog(ctx, OWNER, "gat-1", { fetchImpl: impl });
  await refreshOwnerCalendarCatalog(ctx, OWNER, "gat-1", { fetchImpl: impl });

  const upserts = opsFor(ops, "owner_google_calendar_sync", "upsert").map((op) => op.values);
  assert.equal(upserts.length, 2);
  assert.equal(upserts[0].calendar_background_color, "#0b8043");
  assert.equal(upserts[1].calendar_background_color, upserts[0].calendar_background_color,
    "두 번째 적재가 레거시로 되돌리지 않는다");
  assert.equal(upserts[1].calendar_foreground_color, upserts[0].calendar_foreground_color);
  assert.equal(modernCalendarColor(upserts[0].calendar_background_color), upserts[0].calendar_background_color,
    "옮긴 값을 다시 옮겨도 제자리다 — 모던 16진은 레거시 표의 키가 아니다");

  // 화면 경로도 저장해 둔 값을 그대로 통과시킨다.
  const catalog = await listOwnerCalendarCatalog(ctx, OWNER, null);
  assert.equal(catalog[0].color, "#0b8043");
  assert.equal(catalog[0].textColor, "#ffffff");
});

test("the catalog paints the modern palette for rows adopted before the colorId fix", async () => {
  // 이 행들은 refreshOwnerCalendarCatalog 가 색을 옮기기 전에 적재된 것이라
  // 아직 구글 API 의 레거시 값을 들고 있다. 다음 카탈로그 갱신이 저장 값을
  // 바로잡을 때까지, 화면으로 나가는 이 자리가 옮겨서 내보낸다.
  const stored = [
    { google_calendar_id: TEAM_CALENDAR, calendar_role: "secondary", calendar_summary: "팀 일정", calendar_access_role: "writer", calendar_writable: true, calendar_background_color: "#16a765", calendar_foreground_color: "#000000" },
    { google_calendar_id: HOLIDAY_CALENDAR, calendar_role: "secondary", calendar_summary: "공휴일", calendar_access_role: "reader", calendar_background_color: "#cd74e6" },
    { google_calendar_id: "custom@group.calendar.google.com", calendar_role: "secondary", calendar_summary: "사용자 지정", calendar_access_role: "reader", calendar_background_color: "#123456" },
    { google_calendar_id: "nocolor@group.calendar.google.com", calendar_role: "secondary", calendar_summary: "색 없음", calendar_access_role: "reader" },
  ];
  const { ctx } = makeCtx({ owner_google_calendar_sync: { data: stored, error: null } });

  const catalog = await listOwnerCalendarCatalog(ctx, OWNER, null);
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));

  assert.equal(byId.get(TEAM_CALENDAR).color, "#0b8043", "레거시 Basil 이 구글 화면의 Basil 로 나간다");
  assert.equal(byId.get(HOLIDAY_CALENDAR).color, "#8e24aa", "레거시 Grape 가 구글 화면의 Grape 로 나간다");
  assert.equal(byId.get("custom@group.calendar.google.com").color, "#123456", "표에 없는 색은 원본 그대로 통과한다");
  assert.equal(byId.get("nocolor@group.calendar.google.com").color, null);
  assert.equal(byId.get("nocolor@group.calendar.google.com").textColor, null);
  // 글자색은 옮긴 색 위에서 다시 정한다. 구글이 준 foreground(#000000)는
  // 레거시 배경에 맞춘 값이라 짙은 모던 초록 위에서는 읽히지 않는다.
  assert.equal(byId.get(TEAM_CALENDAR).textColor, "#ffffff", "옮긴 색 위에서 대비를 다시 계산한다");

  // 읽기는 행을 고치지 않는다. 저장 값의 교정은 다음 카탈로그 갱신의 몫이다.
  assert.equal(stored[0].calendar_background_color, "#16a765", "행의 레거시 값은 읽기만으로 바뀌지 않는다");
  assert.equal(stored[1].calendar_background_color, "#cd74e6");
});

test("an empty catalog still infers the dedicated calendar as a visible writable entry", async () => {
  const { ctx } = makeCtx({ owner_google_calendar_sync: { data: [], error: null } });
  assert.deepEqual(await listOwnerCalendarCatalog(ctx, OWNER, INTEGRATION), [{
    id: INTEGRATION.calendar_id,
    name: "모먼트 인사이트",
    primary: false,
    dedicated: true,
    accessRole: "owner",
    writable: true,
    // writable 의 여집합이 아니다. "확인된 읽기 전용" 만 참이고, 전용 캘린더는
    // 대표님 소유이므로 언제나 거짓이다.
    readOnly: false,
    visible: true,
    selected: true,
    color: null,
    textColor: null,
    group: "own",
  }]);
  const broken = makeCtx({ owner_google_calendar_sync: { data: null, error: { code: "42P01", message: "relation does not exist" } } });
  assert.deepEqual(await listOwnerCalendarCatalog(broken.ctx, OWNER, null), []);
});

test("the MI visibility toggle writes one local column and reports every outcome", async (t) => {
  await t.test("saved", async () => {
    const { ctx, ops } = makeCtx({
      owner_google_calendar_sync: (op) => (op.kind === "update"
        ? { data: { google_calendar_id: TEAM_CALENDAR }, error: null }
        : { data: null, error: null }),
    });

    assert.deepEqual(await setOwnerCalendarVisibility(ctx, OWNER, TEAM_CALENDAR, false), { ok: true, updated: true });
    const update = opsFor(ops, "owner_google_calendar_sync", "update")[0];
    assert.equal(update.values.calendar_visible, false);
    assert.deepEqual(Object.keys(update.values).sort(), ["calendar_visible", "updated_at"], "구글로는 아무것도 되쓰지 않는다");
    assert.deepEqual(update.filters, [["eq", "owner_agency_code", OWNER], ["eq", "google_calendar_id", TEAM_CALENDAR]]);
  });

  await t.test("not_found", async () => {
    const { ctx } = makeCtx({ owner_google_calendar_sync: { data: null, error: null } });
    assert.deepEqual(await setOwnerCalendarVisibility(ctx, OWNER, "gone@group.calendar.google.com", true), { ok: false, reason: "not_found" });
    assert.deepEqual(await setOwnerCalendarVisibility(ctx, OWNER, "   ", true), { ok: false, reason: "not_found" });
  });

  await t.test("unsupported", async () => {
    resetOptionalColumns();
    try {
      const { ctx, ops } = makeCtx({
        owner_google_calendar_sync: (op) => (op.kind === "update"
          ? { data: null, error: { code: "42703", message: "column owner_google_calendar_sync.calendar_visible does not exist" } }
          : { data: null, error: null }),
      });

      assert.deepEqual(await setOwnerCalendarVisibility(ctx, OWNER, TEAM_CALENDAR, true), { ok: false, reason: "unsupported" });
      assert.equal(opsFor(ops, "owner_google_calendar_sync", "update").length, 1, "없는 열에 다시 쓰지 않는다");
    } finally {
      resetOptionalColumns();
    }
  });

  await t.test("storage", async () => {
    const { ctx } = makeCtx({
      owner_google_calendar_sync: (op) => (op.kind === "update"
        ? { data: null, error: { code: "PGRST301", message: "permission denied" } }
        : { data: null, error: null }),
    });
    assert.deepEqual(await setOwnerCalendarVisibility(ctx, OWNER, TEAM_CALENDAR, true), { ok: false, reason: "storage" });
  });
});

test("every catalogued calendar joins the pull, the hidden ones last", async () => {
  const { ctx } = makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? {
        data: [
          calendarRow({ google_calendar_id: HOLIDAY_CALENDAR, calendar_role: "secondary", calendar_visible: false }),
          calendarRow({ google_calendar_id: "a@group.calendar.google.com", calendar_role: "secondary" }),
          calendarRow({ google_calendar_id: TEAM_CALENDAR, calendar_role: "secondary", calendar_visible: true }),
        ],
        error: null,
      }
      : { data: null, error: null }),
    schedule_items: { data: [], error: null },
  });

  const calendars = await resolveOwnerCalendars(ctx, OWNER, INTEGRATION, {});

  assert.deepEqual(calendars.map((entry) => entry.google_calendar_id), [
    INTEGRATION.calendar_id,
    "a@group.calendar.google.com",
    TEAM_CALENDAR,
    HOLIDAY_CALENDAR,
  ], "체크를 꺼 둔 캘린더도 계속 동기화하되 순서는 뒤로 민다");
});

test("one sync run never takes on more calendars than the cap", async () => {
  const rows = Array.from({ length: MAX_SYNC_CALENDARS + 10 }, (_, index) => calendarRow({
    google_calendar_id: `c${String(index).padStart(2, "0")}@group.calendar.google.com`,
    calendar_role: "secondary",
  }));
  const { ctx } = makeCtx({
    owner_google_calendar_sync: (op) => (op.kind === "select" ? { data: rows, error: null } : { data: null, error: null }),
    schedule_items: { data: [], error: null },
  });

  const calendars = await resolveOwnerCalendars(ctx, OWNER, INTEGRATION, {});

  assert.equal(calendars.length, MAX_SYNC_CALENDARS);
  assert.equal(calendars[0].google_calendar_id, INTEGRATION.calendar_id, "전용 캘린더는 언제나 살아남는다");
});

test("hitting the event cap parks the page token exactly like the page cap does", async () => {
  const items = Array.from({ length: MAX_FULL_SYNC_EVENTS }, (_, index) => ({ id: `gev-${index}`, status: "confirmed" }));
  const { ctx, ops } = makeCtx({ schedule_items: { data: [], error: null } });
  const eventsUrl = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`GET ${eventsUrl}`]: jsonResponse(200, { items, nextPageToken: "pt-next" }),
  });

  const result = await syncOneCalendar(ctx, OWNER, calendarRow(), "gat-1", {
    mode: "full", now: NOW, maxPages: 50, fetchImpl: impl,
  });

  assert.equal(result.partial, true);
  assert.equal(calls.length, 1, "상한에 닿으면 다음 페이지를 부르지 않는다");
  const saved = opsFor(ops, "owner_google_calendar_sync", "update").at(-1);
  assert.equal(saved.values.full_sync_page_token, "pt-next");
  assert.ok(!("sync_token" in saved.values), "반쯤 진행한 상태에서 토큰을 갱신하면 남은 변경을 잃는다");
});

// ─────────────────────────────────────────────────────────────
// 새 캘린더 만들기 + 참가자(ACL) 관리
//
// 확인한 구글 문서:
//   calendars.insert https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert
//   acl.insert       https://developers.google.com/workspace/calendar/api/v3/reference/acl/insert
//   acl.list = GET /calendars/{calendarId}/acl · acl.delete = DELETE /calendars/{calendarId}/acl/{ruleId}
// ─────────────────────────────────────────────────────────────

const SHARE_CALENDAR = "share@group.calendar.google.com";
const CALENDARS_URL = `${CALENDAR_BASE}/calendars`;
const SHARE_ACL_URL = `${CALENDARS_URL}/${encodeURIComponent(SHARE_CALENDAR)}/acl`;

// 카탈로그 한 줄. accessRole 이 소유권 관문의 유일한 판정 근거다.
function catalogRow(values = {}) {
  return {
    google_calendar_id: SHARE_CALENDAR,
    calendar_role: "secondary",
    calendar_summary: "쿠팡 공유",
    calendar_access_role: "owner",
    calendar_is_primary: false,
    calendar_writable: true,
    calendar_visible: true,
    ...values,
  };
}

function shareCtx({ integration = INTEGRATION, catalog = [catalogRow()] } = {}) {
  return makeCtx({
    owner_google_integrations: () => ({ data: integration, error: null }),
    // 같은 테이블을 카탈로그 읽기(select)와 캐시 적재(upsert)가 함께 쓴다.
    owner_google_calendar_sync: (op) => (op.kind === "select" ? { data: catalog, error: null } : { data: null, error: null }),
    audit_logs: () => ({ data: null, error: null }),
  });
}

test("createOwnerCalendar sends the summary with the Seoul time zone and one acl insert per invite", async () => {
  const { ctx, ops } = shareCtx({ catalog: [] });
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${CALENDARS_URL}`]: (call) => {
      const sent = JSON.parse(String(call.options.body));
      // 필수 본문 필드는 summary 하나지만 timeZone 을 반드시 함께 보낸다 —
      // 없으면 구글 계정 기본 시간대를 따라가 하루 경계가 어긋난다.
      assert.deepEqual(sent, { summary: "쿠팡 공유", timeZone: "Asia/Seoul" });
      return jsonResponse(200, { id: SHARE_CALENDAR, summary: "쿠팡 공유" });
    },
    [`POST ${SHARE_ACL_URL}`]: (call) => {
      assert.equal(call.query.sendNotifications, "true", "초대 메일이 나가야 한다");
      return jsonResponse(200, { id: `user:${JSON.parse(String(call.options.body)).scope.value}` });
    },
  });

  const result = await createOwnerCalendar(ctx, GOOGLE_ENV, OWNER, {
    summary: "  쿠팡 공유  ",
    invites: [{ email: "A@B.com", role: "writer" }, "c@d.com", { email: "a@b.com", role: "reader" }],
  }, { fetchImpl: impl });

  assert.equal(result.ok, true);
  assert.equal(result.calendarId, SHARE_CALENDAR);
  assert.equal(result.summary, "쿠팡 공유", "이름은 앞뒤 공백만 털어 그대로 쓴다");
  // 세 번째 항목은 첫 번째와 같은 주소(대소문자만 다름)라 한 건으로 접힌다.
  assert.deepEqual(result.invited, [
    { email: "a@b.com", role: "writer" },
    { email: "c@d.com", role: "writer" },
  ], "이메일은 소문자로 접히고 role 기본값은 writer 다");
  assert.deepEqual(result.failedInvites, []);

  const aclBodies = calls
    .filter((call) => call.url === SHARE_ACL_URL)
    .map((call) => JSON.parse(String(call.options.body)));
  assert.deepEqual(aclBodies, [
    { role: "writer", scope: { type: "user", value: "a@b.com" } },
    { role: "writer", scope: { type: "user", value: "c@d.com" } },
  ]);

  const [upsert] = opsFor(ops, "owner_google_calendar_sync", "upsert");
  assert.equal(upsert.values.calendar_role, "secondary");
  assert.equal(upsert.values.calendar_access_role, "owner");
  assert.equal(upsert.values.calendar_writable, true);
  assert.equal(upsert.values.calendar_visible, true);
  assert.equal(upsert.values.calendar_is_primary, false);
  assert.equal(upsert.values.calendar_summary, "쿠팡 공유");
  assert.ok(upsert.values.calendar_catalog_at, "카탈로그 시각을 남겨야 사이드바가 바로 그린다");
  assert.equal(upsert.options.onConflict, "owner_agency_code,google_calendar_id");
});

test("createOwnerCalendar validates every input before it calls google at all", async () => {
  const cases = [
    [{ summary: "   " }, "summary"],
    [{ summary: "가".repeat(201) }, "summary"],
    [{ summary: "공유", invites: "a@b.com" }, "invites"],
    [{ summary: "공유", invites: Array.from({ length: MAX_CALENDAR_INVITES + 1 }, (unused, index) => `p${index}@b.com`) }, "invites_max"],
    [{ summary: "공유", invites: [{ email: "not-an-email" }] }, "invite_email"],
    [{ summary: "공유", invites: [{ email: "a@b.com", role: "owner" }] }, "invite_role"],
  ];
  for (const [input, reason] of cases) {
    const { ctx } = shareCtx();
    // 라우트가 하나도 없는 mock 이라 어떤 fetch 든 던진다. 검증이 먼저라는 것을
    // 이보다 강하게 말할 방법이 없다 — 토큰 발급조차 나가면 안 된다.
    const { calls, impl } = fetchMock({});
    const result = await createOwnerCalendar(ctx, GOOGLE_ENV, OWNER, input, { fetchImpl: impl });
    assert.equal(result.ok, false, `${reason} 은 거절돼야 한다`);
    assert.equal(result.reason, reason);
    assert.equal(calls.length, 0, `${reason}: 구글을 한 번도 부르면 안 된다`);
  }
  // role 은 CALENDAR_INVITE_ROLES 두 개만 통과한다.
  assert.deepEqual([...CALENDAR_INVITE_ROLES].sort(), ["reader", "writer"]);
});

test("one failing acl insert keeps the calendar and the other invites", async () => {
  const { ctx, ops } = shareCtx({ catalog: [] });
  const { impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${CALENDARS_URL}`]: jsonResponse(200, { id: SHARE_CALENDAR }),
    // 가운데 한 건만 구글이 거절한다.
    [`POST ${SHARE_ACL_URL}`]: sequence(
      jsonResponse(200, { id: "user:a" }),
      jsonResponse(403, { error: { message: "forbidden" } }),
      jsonResponse(200, { id: "user:c" }),
    ),
  });

  const result = await createOwnerCalendar(ctx, GOOGLE_ENV, OWNER, {
    summary: "공유",
    invites: ["a@b.com", "b@b.com", "c@b.com"],
  }, { fetchImpl: impl });

  assert.equal(result.ok, true, "캘린더는 이미 만들어졌으므로 전체를 실패로 되돌리지 않는다");
  assert.deepEqual(result.invited.map((entry) => entry.email), ["a@b.com", "c@b.com"]);
  assert.deepEqual(result.failedInvites, [{ email: "b@b.com", role: "writer", reason: "google_403" }]);
  assert.equal(opsFor(ops, "owner_google_calendar_sync", "upsert").length, 1, "실패한 초대가 캐시 적재를 막지 않는다");
});

test("createOwnerCalendar surfaces a google rejection as a google_<status> reason", async () => {
  const { ctx, ops } = shareCtx({ catalog: [] });
  const { impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${CALENDARS_URL}`]: jsonResponse(403, { error: { message: "insufficient permissions" } }),
  });
  const result = await createOwnerCalendar(ctx, GOOGLE_ENV, OWNER, { summary: "공유" }, { fetchImpl: impl });
  assert.deepEqual(result, { ok: false, reason: "google_403" });
  assert.equal(opsFor(ops, "owner_google_calendar_sync", "upsert").length, 0, "안 만들어진 캘린더를 캐시에 심으면 안 된다");
});

test("listOwnerCalendarAcl keeps default-scope rules but marks them uneditable", async () => {
  const { ctx } = shareCtx();
  const { impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`GET ${SHARE_ACL_URL}`]: jsonResponse(200, {
      items: [
        { id: "user:a", role: "writer", scope: { type: "user", value: "A@B.com" } },
        { id: "default", role: "reader", scope: { type: "default" } },
        { id: "domain:momentlabs.co.kr", role: "reader", scope: { type: "domain", value: "momentlabs.co.kr" } },
        { id: "", role: "reader", scope: { type: "user", value: "drop@me.com" } },
      ],
    }),
  });

  const result = await listOwnerCalendarAcl(ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, { fetchImpl: impl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.rules, [
    { id: "user:a", email: "a@b.com", role: "writer", scopeType: "user", editable: true },
    // 화면이 "누구나 볼 수 있음" 을 그릴 수 있게 버리지 않고 표식만 단다.
    { id: "default", email: null, role: "reader", scopeType: "default", editable: false },
    { id: "domain:momentlabs.co.kr", email: "momentlabs.co.kr", role: "reader", scopeType: "domain", editable: false },
  ], "id 없는 규칙만 버린다");
});

test("insertOwnerCalendarAcl posts the rule with sendNotifications and answers with the mapped rule", async () => {
  const { ctx } = shareCtx();
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`POST ${SHARE_ACL_URL}`]: (call) => {
      assert.equal(call.query.sendNotifications, "true");
      assert.deepEqual(JSON.parse(String(call.options.body)), {
        role: "reader",
        scope: { type: "user", value: "new@b.com" },
      });
      return jsonResponse(200, { id: "user:new", role: "reader", scope: { type: "user", value: "new@b.com" } });
    },
  });

  const result = await insertOwnerCalendarAcl(ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR,
    { email: "New@B.com", role: "reader" }, { fetchImpl: impl });

  assert.equal(result.ok, true);
  assert.deepEqual(result.rule, { id: "user:new", email: "new@b.com", role: "reader", scopeType: "user", editable: true });
  assert.equal(calls.filter((call) => call.url === SHARE_ACL_URL).length, 1);

  // 잘못된 주소·권한은 구글을 부르기 전에 막힌다.
  for (const [invite, reason] of [[{ email: "nope" }, "invite_email"], [{ email: "a@b.com", role: "owner" }, "invite_role"]]) {
    const blocked = fetchMock({});
    const refused = await insertOwnerCalendarAcl(shareCtx().ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, invite, { fetchImpl: blocked.impl });
    assert.equal(refused.reason, reason);
    assert.equal(blocked.calls.length, 0);
  }
});

test("deleteOwnerCalendarAcl refuses exactly the rules the list marks uneditable", async () => {
  for (const [ruleId, reason] of [["", "rule"], ["   ", "rule"], ["default", "rule_locked"], ["domain:momentlabs.co.kr", "rule_locked"]]) {
    const { calls, impl } = fetchMock({});
    const result = await deleteOwnerCalendarAcl(shareCtx().ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, ruleId, { fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason, `${JSON.stringify(ruleId)} 는 ${reason} 이어야 한다`);
    assert.equal(calls.length, 0, "지울 수 없다고 그려 놓은 것을 지워 주면 두 층의 말이 어긋난다");
  }
});

test("deleteOwnerCalendarAcl treats an already-gone rule as done", async () => {
  for (const status of [204, 404, 410]) {
    const { ctx } = shareCtx();
    const { impl } = fetchMock({
      [`POST ${TOKEN_URL}`]: tokenRoute(),
      [`DELETE ${SHARE_ACL_URL}/user%3Ab`]: jsonResponse(status, status === 204 ? undefined : { error: { message: "gone" } }),
    });
    const result = await deleteOwnerCalendarAcl(ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, "user:b", { fetchImpl: impl });
    assert.equal(result.ok, true, `${status} 는 우리가 원하던 최종 상태와 같다`);
    assert.equal(result.ruleId, "user:b");
  }

  const { ctx } = shareCtx();
  const { impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`DELETE ${SHARE_ACL_URL}/user%3Ab`]: jsonResponse(500, { error: { message: "boom" } }),
  });
  const failed = await deleteOwnerCalendarAcl(ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, "user:b", { fetchImpl: impl });
  assert.deepEqual(failed, { ok: false, reason: "google_500" });
});

test("the acl functions refuse a calendar the owner does not own without touching google", async () => {
  // writer 권한만 있는 남의 캘린더. 여기 참가자를 우리가 고치면 캘린더 주인은
  // 모르는 사이에 사람이 늘어난다.
  const catalog = [catalogRow({ calendar_access_role: "reader", calendar_writable: false })];
  const attempts = [
    ["list", (ctx, options) => listOwnerCalendarAcl(ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, options)],
    ["insert", (ctx, options) => insertOwnerCalendarAcl(ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, { email: "a@b.com" }, options)],
    ["delete", (ctx, options) => deleteOwnerCalendarAcl(ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, "user:a", options)],
  ];
  for (const [label, run] of attempts) {
    const { ctx } = shareCtx({ catalog });
    const { calls, impl } = fetchMock({});
    // 호출부가 이미 발급한 토큰을 넘긴 상태 — HTTP 층이 하는 것과 같다.
    const result = await run(ctx, { fetchImpl: impl, accessToken: "gat-1", integration: INTEGRATION });
    assert.equal(result.ok, false, `${label} 은 막혀야 한다`);
    assert.equal(result.reason, "forbidden");
    assert.equal(calls.length, 0, `${label}: 관문이 구글보다 먼저다`);
  }
});

test("a supplied access token short-circuits the refresh so one request mints it once", async () => {
  const { ctx } = shareCtx();
  const { calls, impl } = fetchMock({
    // 토큰 라우트를 일부러 빼 둔다. 갱신을 시도하면 mock 이 던진다.
    [`GET ${SHARE_ACL_URL}`]: jsonResponse(200, { items: [{ id: "user:a", role: "writer", scope: { type: "user", value: "a@b.com" } }] }),
  });
  const result = await listOwnerCalendarAcl(ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, {
    fetchImpl: impl,
    accessToken: "gat-reused",
    integration: INTEGRATION,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, "Bearer gat-reused");
});

test("the shared session guards answer with one narrow reason each", async () => {
  // 환경변수가 없으면 DB 도 구글도 건드리지 않는다.
  const noEnv = fetchMock({});
  assert.deepEqual(
    await listOwnerCalendarAcl(shareCtx().ctx, {}, OWNER, SHARE_CALENDAR, { fetchImpl: noEnv.impl }),
    { ok: false, reason: "env" },
  );
  assert.equal(noEnv.calls.length, 0);

  // 연동 조회 자체가 불가능한 최소 ctx.
  const noStorage = fetchMock({});
  assert.deepEqual(
    await listOwnerCalendarAcl({ supabaseAdmin: {} }, GOOGLE_ENV, OWNER, SHARE_CALENDAR, { fetchImpl: noStorage.impl }),
    { ok: false, reason: "no-storage" },
  );
  assert.equal(noStorage.calls.length, 0);

  // 연동 행이 없으면 구글을 부르기 전에 not-connected 다.
  const notConnected = fetchMock({});
  assert.deepEqual(
    await listOwnerCalendarAcl(shareCtx({ integration: null }).ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, { fetchImpl: notConnected.impl }),
    { ok: false, reason: "not-connected" },
  );
  assert.equal(notConnected.calls.length, 0);

  // 만료된 refresh token 은 연동 행에 배지를 남기고 needs_reconnect 로 올린다.
  const expired = shareCtx();
  const expiredFetch = fetchMock({ [`POST ${TOKEN_URL}`]: jsonResponse(400, { error: "invalid_grant" }) });
  assert.deepEqual(
    await listOwnerCalendarAcl(expired.ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, { fetchImpl: expiredFetch.impl }),
    { ok: false, reason: "needs_reconnect" },
  );
  const [flipped] = opsFor(expired.ops, "owner_google_integrations", "update");
  assert.equal(flipped.values.sync_status, "needs_reconnect");

  // 그 밖의 토큰 실패는 재연결이 아니라 일시적 오류다.
  const shaky = fetchMock({ [`POST ${TOKEN_URL}`]: jsonResponse(500, { error: "backend_error" }) });
  assert.deepEqual(
    await listOwnerCalendarAcl(shareCtx().ctx, GOOGLE_ENV, OWNER, SHARE_CALENDAR, { fetchImpl: shaky.impl }),
    { ok: false, reason: "token" },
  );
});

// ─────────────────────────────────────────────────────────────
// 수동 동기화는 항상 full
//
// 증분 목록은 syncToken 이후 "바뀐" 이벤트만 준다. 구글에서 색만 지정해 둔
// 옛 일정은 updated 가 그대로라 증분으로는 다시 오지 않고, 하루 한 번 승격되는
// full 때만 다시 훑린다. 그래서 "지금 동기화" 는 full 로 돌아야 그 자리에서
// 색이 채워진다. (대표님의 "세무사 결제" 가 파란색으로 남아 있던 이유다.)
// ─────────────────────────────────────────────────────────────
test("a manual full run re-lists unchanged events so a legacy row gains its google_color_id", async () => {
  const legacyRow = {
    id: "row-legacy",
    owner_agency_code: OWNER,
    google_event_id: "gev-1",
    google_calendar_id: "primary@example.com",
    google_updated_at: "2026-08-23T00:00:00.000Z",
    google_color_id: null,
    google_source: "google",
    google_sync_state: "synced",
    title: "세무사 결제",
    starts_at: "2026-08-24T06:00:00.000Z",
  };
  const { ctx, ops } = makeCtx({
    owner_google_integrations: (op) => (op.kind === "select"
      // 전용 캘린더는 이미 회수된 상태로 둔다 — 이 시험의 관심사가 아니다.
      ? { data: { ...INTEGRATION, calendar_id: null }, error: null }
      : { data: null, error: null }),
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? {
        data: [calendarRow({
          google_calendar_id: "primary@example.com",
          calendar_role: "primary",
          // 토큰이 있고 오늘 이미 full 이 돌았다 → 평소라면 증분으로 떨어진다.
          sync_token: "st-1",
          last_full_sync_at: new Date(NOW - 60 * 1000).toISOString(),
        })],
        error: null,
      }
      : { data: null, error: null }),
    schedule_items: (op) => {
      if (op.kind !== "select") return { data: null, error: null };
      const isEventLookup = op.filters.some(([kind, column]) => kind === "in" && column === "google_event_id");
      // push 대상 조회에는 아무것도 주지 않는다 — 이 시험은 inbound 만 본다.
      return { data: isEventLookup ? [legacyRow] : [], error: null };
    },
  });
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`GET ${CALENDAR_BASE}/users/me/calendarList`]: jsonResponse(200, { items: [] }),
    [`GET ${CALENDAR_BASE}/calendars/primary%40example.com/events`]: jsonResponse(200, {
      items: [timedEvent({
        id: "gev-1",
        // 구글 쪽 updated 는 그대로다 → eventIsEcho 가 참이라 본문은 건드리지 않는다.
        updated: "2026-08-22T00:00:00.000Z",
        colorId: "8",
      })],
      nextSyncToken: "st-2",
    }),
  });

  const result = await runOwnerCalendarSync(ctx, GOOGLE_ENV, OWNER, { now: NOW, mode: "full", fetchImpl: impl });

  assert.equal(result.ok, true);
  const listCall = calls.find((call) => call.url.endsWith("/events"));
  assert.equal(listCall.query.syncToken, undefined, "수동 full 은 저장된 syncToken 을 쓰지 않는다");
  assert.ok(listCall.query.timeMin && listCall.query.timeMax, "full 목록은 창(timeMin/timeMax)을 붙인다");

  const update = opsFor(ops, "schedule_items", "update").at(-1);
  assert.deepEqual(update.values, { google_color_id: "8" }, "색 한 필드만 채운다 — 제목·시간·etag 는 건드리지 않는다");
});

// ─────────────────────────────────────────────────────────────
// full 승격 판정 — 시계에서 떼어 놓는다
//
// 이 판정을 실행 전체로만 겨눌 수 있던 시절, 고정 시각(2026-08-23T23:59Z)을 박아
// 둔 fixture 하나가 실제 시계가 그 시각 + 24시간을 넘긴 순간부터 깨졌다. 로컬
// 17:11 UTC 에는 통과하고 다음 날 06:20 UTC Vercel 빌드에서 full 로 떨어진 것이
// 그 결과다 — 코드가 아니라 달력이 시험을 깬 것이다.
//
// 그래서 여기서는 now 를 전부 못 박고, 하루 중 어느 시각에 돌려도 같은 답이
// 나오는지를 판정 함수에 직접 묻는다. Date.now() 도 TZ 도 이 블록에 들어오지 않는다.
// ─────────────────────────────────────────────────────────────

const TEAM_CODE = "11111111-1111-4111-8111-111111111111";
const TEAM_KEY = `team:${TEAM_CODE}`;
const CLIENT_KEY = "client:33333333-3333-4333-8333-333333333333";
const PROMOTION_KEYS = [OWNER, TEAM_KEY, CLIENT_KEY];
// 자정 직후·아침·자정 직전. 하루 중 어느 자리인지가 판정을 흔들면 안 된다.
// 06:20 은 실제로 빌드를 깨뜨린 그 시각이라 일부러 남겨 둔다.
const PROMOTION_TIMES = [
  "2026-08-24T00:10:00.000Z",
  "2026-08-24T06:20:00.000Z",
  "2026-08-24T23:50:00.000Z",
];
const ONE_HOUR_MS = 60 * 60 * 1000;

test("the owner's full-sync interval stays exactly 24 hours with no jitter", () => {
  assert.equal(fullSyncIntervalMs(OWNER, {}), FULL_SYNC_INTERVAL_MS, "대표님 코드에는 오프셋이 붙지 않는다");
  // 운영 환경이 같은 코드를 명시적으로 심어도 답이 달라지면 안 된다.
  assert.equal(fullSyncIntervalMs(OWNER, { MI_PRIMARY_AGENCY_CODE: OWNER }), FULL_SYNC_INTERVAL_MS);
});

test("the promotion rule is pure: the same arguments always give the same answer", () => {
  const lastFull = "2026-08-23T00:00:00.000Z";
  const now = Date.parse("2026-08-24T06:20:00.000Z");
  for (const key of PROMOTION_KEYS) {
    assert.equal(
      shouldPromoteFullSync(lastFull, now, key, {}),
      shouldPromoteFullSync(lastFull, now, key, {}),
      `${key}: 같은 인자에는 같은 답이다`,
    );
    assert.equal(fullSyncIntervalMs(key, {}), fullSyncIntervalMs(key, {}), `${key}: 주기도 호출마다 흔들리지 않는다`);
  }
  // 읽을 수 없는 값은 "한 번도 full 이 돈 적 없다" 로 본다 → 이번에 올린다.
  for (const missing of [null, undefined, "", "어제쯤"]) {
    assert.equal(shouldPromoteFullSync(missing, now, OWNER, {}), true, `${String(missing)} 은 승격 쪽이다`);
  }
});

test("promotion follows elapsed time only, never the time of day", () => {
  for (const key of PROMOTION_KEYS) {
    // 시간을 손으로 박지 않고 그 계정의 주기에서 뽑는다 — jitter 상수가 움직여도
    // 이 시험은 그대로 성립한다.
    const interval = fullSyncIntervalMs(key, {});
    for (const iso of PROMOTION_TIMES) {
      const now = Date.parse(iso);
      const at = (elapsed) => new Date(now - elapsed).toISOString();
      assert.equal(shouldPromoteFullSync(at(interval - ONE_HOUR_MS), now, key, {}), false, `${key} @ ${iso}: 창 안이면 증분`);
      assert.equal(shouldPromoteFullSync(at(interval), now, key, {}), true, `${key} @ ${iso}: 경계는 승격 쪽이다`);
      assert.equal(shouldPromoteFullSync(at(interval + ONE_HOUR_MS), now, key, {}), true, `${key} @ ${iso}: 창 밖이면 full`);
      // 정확히 24시간이 지난 자리: 대표님만 올라가고 오프셋이 붙은 계정은 아직 버틴다.
      assert.equal(
        shouldPromoteFullSync(at(FULL_SYNC_INTERVAL_MS), now, key, {}),
        key === OWNER,
        `${key} @ ${iso}: 24시간 경과는 대표님만 승격이다`,
      );
    }
  }
});

test("non-owner keys sit at a fixed offset inside the jitter band and never share a slot", () => {
  const team = fullSyncIntervalMs(TEAM_KEY, {});
  const client = fullSyncIntervalMs(CLIENT_KEY, {});
  for (const [key, interval] of [[TEAM_KEY, team], [CLIENT_KEY, client]]) {
    assert.ok(interval > FULL_SYNC_INTERVAL_MS, `${key}: 24시간보다 뒤로 밀린다`);
    assert.ok(interval < FULL_SYNC_INTERVAL_MS + FULL_SYNC_JITTER_MS, `${key}: 그래도 흩뿌리는 폭 안에 있다`);
  }
  assert.notEqual(team, client, "서로 다른 계정은 서로 다른 자리를 잡는다");
});

const PROMOTION_EVENTS_URL = `${CALENDAR_BASE}/calendars/primary%40example.com/events`;

// 실행 전체로 판정을 확인하는 하네스. now 는 언제나 못 박아 넣는다.
async function promotionRun(code, lastFullSyncAt, now, options = {}) {
  const { ctx } = makeCtx({
    owner_google_integrations: (op) => (op.kind === "select"
      // 전용 캘린더는 이미 회수된 상태로 둔다 — 이 시험의 관심사가 아니다.
      ? { data: { ...INTEGRATION, owner_agency_code: code, calendar_id: null }, error: null }
      : { data: null, error: null }),
    owner_google_calendar_sync: (op) => (op.kind === "select"
      ? {
        data: [calendarRow({ owner_agency_code: code, sync_token: "st-1", last_full_sync_at: lastFullSyncAt })],
        error: null,
      }
      : { data: null, error: null }),
    schedule_items: { data: [], error: null },
  });
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`GET ${CALENDAR_BASE}/users/me/calendarList`]: jsonResponse(200, { items: [] }),
    [`GET ${PROMOTION_EVENTS_URL}`]: jsonResponse(200, { items: [], nextSyncToken: "st-2" }),
  });
  const result = await runOwnerCalendarSync(ctx, GOOGLE_ENV, code, { now, fetchImpl: impl, ...options });
  return { result, listed: calls.find((call) => call.url === PROMOTION_EVENTS_URL) };
}

test("an injected clock alone decides an automatic run: incremental inside the window, full past it", async () => {
  const now = Date.parse("2026-08-24T06:20:00.000Z");

  // 대표님 코드 — 정확히 24시간짜리 창.
  const ownerInterval = fullSyncIntervalMs(OWNER, {});
  const ownerCheap = await promotionRun(OWNER, new Date(now - (ownerInterval - ONE_HOUR_MS)).toISOString(), now);
  assert.equal(ownerCheap.result.ok, true);
  assert.equal(ownerCheap.listed.query.syncToken, "st-1", "창 안의 자동 진입은 그대로 증분이다");
  assert.ok(!("timeMin" in ownerCheap.listed.query), "증분에는 창을 붙이지 않는다");

  const ownerStale = await promotionRun(OWNER, new Date(now - (ownerInterval + ONE_HOUR_MS)).toISOString(), now);
  assert.equal(ownerStale.listed.query.syncToken, undefined, "창 밖이면 저장된 토큰을 버린다");
  assert.ok(ownerStale.listed.query.timeMin, "full 목록은 창(timeMin)을 붙인다");

  // 운영팀 개인 캘린더 — 24시간이 꼬박 지나도 자기 오프셋만큼은 아직 창 안이다.
  const personal = { role: "team", code: TEAM_CODE };
  const teamInterval = fullSyncIntervalMs(TEAM_KEY, {});
  const teamCheap = await promotionRun(TEAM_KEY, new Date(now - FULL_SYNC_INTERVAL_MS).toISOString(), now, { personal });
  assert.equal(teamCheap.result.ok, true);
  assert.equal(teamCheap.listed.query.syncToken, "st-1", "오프셋만큼은 증분으로 버틴다");

  const teamStale = await promotionRun(TEAM_KEY, new Date(now - (teamInterval + ONE_HOUR_MS)).toISOString(), now, { personal });
  assert.equal(teamStale.listed.query.syncToken, undefined, "자기 창을 넘기면 그때 full 로 올라간다");
  assert.ok(teamStale.listed.query.timeMin);
});
