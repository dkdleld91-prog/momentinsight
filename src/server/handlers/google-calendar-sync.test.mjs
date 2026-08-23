import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGoogleEventPayload,
  conferenceUriFromEvent,
  decorateGoogleSummary,
  describeRecurrence,
  normalizeAttendeeList,
  normalizeImportedTitle,
  undecorateGoogleSummary,
  validateRecurrenceLines,
} from "../google-calendar-client.mjs";
import {
  MAX_FULL_SYNC_EVENTS,
  MAX_SYNC_CALENDARS,
  eventInWindow,
  eventIsEcho,
  googleEventTimes,
  googleMirrorFields,
  hexColor,
  inboundUpdatePatch,
  listOwnerCalendarCatalog,
  listOwnerWritableCalendars,
  mapGoogleEventToScheduleRow,
  materializeRecurringInstances,
  matchRowForEvent,
  ownerSyncableRows,
  pushPendingRows,
  pushRowToGoogle,
  refreshOwnerCalendarCatalog,
  resetOptionalColumns,
  resolveOwnerCalendars,
  runOwnerCalendarSync,
  setOwnerCalendarVisibility,
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
  const audit = opsFor(ops, "audit_logs", "insert")[0].values;
  assert.equal(audit.action, "google_calendar_item_deleted");
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

test("a full run pushes first, then pulls both the dedicated and primary calendars", async () => {
  const { ctx, ops } = makeCtx({
    owner_google_integrations: (op) => (op.kind === "select" ? { data: INTEGRATION, error: null } : { data: null, error: null }),
    owner_google_calendar_sync: (op) => (op.kind === "select" ? { data: [], error: null } : { data: null, error: null }),
    schedule_items: { data: [], error: null },
  });
  const dedicatedUrl = `${CALENDAR_BASE}/calendars/dedicated%40group.calendar.google.com/events`;
  const primaryUrl = `${CALENDAR_BASE}/calendars/owner%40example.com/events`;
  const { calls, impl } = fetchMock({
    [`POST ${TOKEN_URL}`]: tokenRoute(),
    [`GET ${CALENDAR_BASE}/calendars/primary`]: jsonResponse(200, { id: "owner@example.com" }),
    [`GET ${dedicatedUrl}`]: jsonResponse(200, { items: [], nextSyncToken: "st-d" }),
    [`GET ${primaryUrl}`]: jsonResponse(200, { items: [timedEvent()], nextSyncToken: "st-p" }),
  });

  const result = await runOwnerCalendarSync(ctx, GOOGLE_ENV, OWNER, { now: NOW, fetchImpl: impl });

  assert.equal(result.ok, true);
  assert.equal(result.changed, 1);
  assert.deepEqual(result.calendars.map((entry) => entry.role), ["dedicated", "primary"]);
  assert.ok(calls.some((call) => call.url === dedicatedUrl));
  assert.ok(calls.some((call) => call.url === primaryUrl));
  // primary 는 "primary" 리터럴이 아니라 실제 id 로 고정되어야 중복 동기화가 없다.
  const upserts = opsFor(ops, "owner_google_calendar_sync", "upsert");
  assert.deepEqual(upserts.map((op) => op.values.google_calendar_id).sort(),
    ["dedicated@group.calendar.google.com", "owner@example.com"]);
  assert.equal(opsFor(ops, "owner_google_integrations", "update").at(-1).values.sync_status, "ok");
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
  const audit = opsFor(ops, "audit_logs", "insert").at(-1).values;
  assert.equal(audit.action, "google_calendar_sync_failed");
  assert.equal(audit.metadata.mode, "delete");
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

test("an empty catalog still infers the dedicated calendar as a visible writable entry", async () => {
  const { ctx } = makeCtx({ owner_google_calendar_sync: { data: [], error: null } });
  assert.deepEqual(await listOwnerCalendarCatalog(ctx, OWNER, INTEGRATION), [{
    id: INTEGRATION.calendar_id,
    name: "모먼트 인사이트",
    primary: false,
    dedicated: true,
    accessRole: "owner",
    writable: true,
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
