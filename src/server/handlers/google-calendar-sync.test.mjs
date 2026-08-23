import assert from "node:assert/strict";
import test from "node:test";

import {
  decorateGoogleSummary,
  normalizeImportedTitle,
  undecorateGoogleSummary,
} from "../google-calendar-client.mjs";
import {
  eventInWindow,
  eventIsEcho,
  googleEventTimes,
  inboundUpdatePatch,
  mapGoogleEventToScheduleRow,
  matchRowForEvent,
  ownerSyncableRows,
  pushPendingRows,
  pushRowToGoogle,
  runOwnerCalendarSync,
  syncOneCalendar,
  syncWindow,
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
