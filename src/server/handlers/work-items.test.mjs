import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantCompleteWorkItem,
  clientWorkItemPayload,
  handleWorkItemsRequest,
  monthlyRecurrenceLines,
  normalizeGoogleEventInput,
  normalizeWorkItemInput,
  roleCanMutateWorkItems,
} from "./work-items.mjs";

test("work items default to internal visibility", () => {
  const result = normalizeWorkItemInput({
    title: "월간 보고서 검수",
    scheduleType: "report_due",
    status: "planned",
    priority: "high",
    startsAt: "2026-07-30T09:00:00+09:00",
    internalNote: "광고주 공개 전 수치 재확인",
  }, { canPublish: false });

  assert.equal(result.ok, true);
  assert.equal(result.value.visibility, "internal");
  assert.equal(result.value.public_title, null);
  assert.equal(result.value.internal_note, "광고주 공개 전 수치 재확인");
});

test("account-only team cannot publish a work item", () => {
  const result = normalizeWorkItemInput({
    title: "소재 업로드",
    scheduleType: "content_upload",
    status: "planned",
    priority: "medium",
    startsAt: "2026-07-30T10:00:00+09:00",
    isClientVisible: true,
  }, { canPublish: false });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});

test("published work item keeps public copy separate from internal note", () => {
  const result = normalizeWorkItemInput({
    title: "내부 소재 교체 검수",
    publicTitle: "신규 소재 적용",
    scheduleType: "creative",
    status: "in_progress",
    priority: "medium",
    startsAt: "2026-07-30T11:00:00+09:00",
    isClientVisible: true,
    publicComment: "적용 후 성과를 확인합니다.",
    internalNote: "CTR 낮으면 B안으로 복귀",
  }, { canPublish: true });

  assert.equal(result.ok, true);
  assert.equal(result.value.visibility, "client_visible");
  assert.equal(result.value.public_title, "신규 소재 적용");
  assert.equal(result.value.internal_note, "CTR 낮으면 B안으로 복귀");
});

test("dragged work item accepts the moved start and end range", () => {
  const result = normalizeWorkItemInput({
    title: "월간 보고서 검수",
    scheduleType: "report_due",
    status: "in_progress",
    priority: "high",
    startsAt: "2026-08-03T09:00:00+09:00",
    endsAt: "2026-08-03T10:30:00+09:00",
  }, { canPublish: false });

  assert.equal(result.ok, true);
  assert.equal(result.value.starts_at, "2026-08-03T00:00:00.000Z");
  assert.equal(result.value.ends_at, "2026-08-03T01:30:00.000Z");
  assert.equal(new Date(result.value.ends_at).getTime() - new Date(result.value.starts_at).getTime(), 90 * 60 * 1000);
});

test("quick completion accepts done without changing the work schedule", () => {
  const result = normalizeWorkItemInput({
    title: "월간 보고서 검수",
    scheduleType: "report_due",
    status: "done",
    priority: "high",
    startsAt: "2026-08-03T09:00:00+09:00",
    endsAt: "2026-08-03T10:30:00+09:00",
    internalNote: "공개 전 수치 확인",
  }, { canPublish: false });

  assert.equal(result.ok, true);
  assert.equal(result.value.status, "done");
  assert.equal(result.value.schedule_type, "report_due");
  assert.equal(result.value.priority, "high");
  assert.equal(result.value.internal_note, "공개 전 수치 확인");
  assert.equal(result.value.starts_at, "2026-08-03T00:00:00.000Z");
  assert.equal(result.value.ends_at, "2026-08-03T01:30:00.000Z");
});

test("quick completion can reopen as planned without changing the work schedule", () => {
  const result = normalizeWorkItemInput({
    title: "월간 보고서 검수",
    scheduleType: "report_due",
    status: "planned",
    priority: "high",
    startsAt: "2026-08-03T09:00:00+09:00",
    endsAt: "2026-08-03T10:30:00+09:00",
    internalNote: "공개 전 수치 확인",
  }, { canPublish: false });

  assert.equal(result.ok, true);
  assert.equal(result.value.status, "planned");
  assert.equal(result.value.schedule_type, "report_due");
  assert.equal(result.value.priority, "high");
  assert.equal(result.value.internal_note, "공개 전 수치 확인");
  assert.equal(result.value.starts_at, "2026-08-03T00:00:00.000Z");
  assert.equal(result.value.ends_at, "2026-08-03T01:30:00.000Z");
});

test("client payload excludes internal and tenant fields", () => {
  const payload = clientWorkItemPayload({
    id: "task-1",
    client_id: "client-secret",
    operation_team_id: "team-secret",
    title: "내부 제목",
    public_title: "광고주 공개 제목",
    schedule_type: "meeting",
    status: "planned",
    starts_at: "2026-07-30T09:00:00.000Z",
    ends_at: null,
    public_comment: "공개 안내",
    internal_note: "절대 노출 금지",
    is_all_day: false,
    updated_at: "2026-07-30T09:00:00.000Z",
  });

  assert.equal(payload.title, "광고주 공개 제목");
  assert.equal(payload.publicComment, "공개 안내");
  assert.equal("internalNote" in payload, false);
  assert.equal("clientId" in payload, false);
  assert.equal("operationTeamId" in payload, false);
});

test("client payload never falls back to an internal title", () => {
  const payload = clientWorkItemPayload({
    id: "task-private-title",
    title: "내부에서만 쓰는 제목",
    public_title: null,
    visibility: "client_visible",
  });

  assert.equal(payload.title, "");
  assert.equal(JSON.stringify(payload).includes("내부에서만 쓰는 제목"), false);
});

test("only owner and operation team can mutate work items", () => {
  assert.equal(roleCanMutateWorkItems("owner"), true);
  assert.equal(roleCanMutateWorkItems("team"), true);
  assert.equal(roleCanMutateWorkItems("client"), false);
});

function assistantQueryStub(result, calls) {
  const stub = {
    select(fields) { calls.push(["select", fields]); return stub; },
    update(patch) { calls.push(["update", patch]); return stub; },
    eq(column, value) { calls.push(["eq", column, value]); return stub; },
    is(column, value) { calls.push(["is", column, value]); return stub; },
    or(filter) { calls.push(["or", filter]); return stub; },
    async maybeSingle() { calls.push(["maybeSingle"]); return result; },
  };
  return stub;
}

function assistantCtx(steps) {
  const calls = [];
  const audits = [];
  let index = 0;
  return {
    calls,
    audits,
    ctx: {
      supabaseAdmin: {
        from(table) {
          if (table === "audit_logs") {
            return {
              async insert(row) { audits.push(row); return { error: null }; },
            };
          }
          const step = steps[index];
          index += 1;
          calls.push(["from", table]);
          return assistantQueryStub(step, calls);
        },
      },
    },
  };
}

function assistantRequest() {
  return new Request("https://insight.momentlabs.co.kr/api/work-items", { method: "PATCH" });
}

const assistantAccess = { ok: true, role: "owner", ownerAgencyCode: "mml93-a01", client: null, team: null };

const assistantRow = {
  id: "wi-1",
  client_id: null,
  operation_team_id: null,
  owner_agency_code: "mml93-a01",
  calendar_id: null,
  title: "광고주 미팅",
  schedule_type: "meeting",
  status: "planned",
  priority: "high",
  starts_at: "2026-08-20T05:00:00.000Z",
  visibility: "internal",
  updated_at: "2026-08-20T01:00:00.000Z",
};

test("assistant-complete marks a planned item done with optimistic lock and audit", async () => {
  const harness = assistantCtx([
    { data: assistantRow, error: null },
    { data: { ...assistantRow, status: "done", updated_at: "2026-08-20T02:00:00.000Z" }, error: null },
  ]);
  const response = await assistantCompleteWorkItem(assistantRequest(), harness.ctx, assistantAccess, {
    action: "assistant-complete",
    id: "wi-1",
    expectedUpdatedAt: "2026-08-20T01:00:00.000Z",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.unchanged, false);
  assert.equal(payload.item.status, "done");
  assert.equal(payload.auditLogged, true);
  assert.deepEqual(harness.calls.filter(([kind]) => kind === "update"), [["update", { status: "done", google_sync_state: "pending" }]]);
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "eq" && column === "updated_at" && value === assistantRow.updated_at));
  assert.equal(harness.audits.length, 1);
  assert.equal(harness.audits[0].action, "work_item_completed_by_assistant");
  assert.equal(harness.audits[0].metadata.source, "momentlabs_assistant");
});

test("assistant-complete keeps an already done item unchanged without update", async () => {
  const harness = assistantCtx([
    { data: { ...assistantRow, status: "done" }, error: null },
  ]);
  const response = await assistantCompleteWorkItem(assistantRequest(), harness.ctx, assistantAccess, {
    action: "assistant-complete",
    id: "wi-1",
    expectedUpdatedAt: "2026-08-20T01:00:00.000Z",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.unchanged, true);
  assert.equal(harness.calls.filter(([kind]) => kind === "update").length, 0);
  assert.equal(harness.audits.length, 0);
});

test("assistant-complete rejects a stale expectedUpdatedAt with 409", async () => {
  const harness = assistantCtx([
    { data: assistantRow, error: null },
  ]);
  const response = await assistantCompleteWorkItem(assistantRequest(), harness.ctx, assistantAccess, {
    action: "assistant-complete",
    id: "wi-1",
    expectedUpdatedAt: "2026-08-19T23:00:00.000Z",
  });

  assert.equal(response.status, 409);
  assert.equal(harness.calls.filter(([kind]) => kind === "update").length, 0);
});

test("assistant-complete returns 409 when the row changes between read and update", async () => {
  const harness = assistantCtx([
    { data: assistantRow, error: null },
    { data: null, error: null },
  ]);
  const response = await assistantCompleteWorkItem(assistantRequest(), harness.ctx, assistantAccess, {
    action: "assistant-complete",
    id: "wi-1",
    expectedUpdatedAt: "2026-08-20T01:00:00.000Z",
  });

  assert.equal(response.status, 409);
  assert.equal(harness.audits.length, 0);
});

test("assistant-complete rejects unexpected input keys", async () => {
  const harness = assistantCtx([]);
  const response = await assistantCompleteWorkItem(assistantRequest(), harness.ctx, assistantAccess, {
    action: "assistant-complete",
    id: "wi-1",
    expectedUpdatedAt: "2026-08-20T01:00:00.000Z",
    status: "done",
  });

  assert.equal(response.status, 400);
  assert.equal(harness.calls.length, 0);
});

test("assistant-complete requires id and a valid expectedUpdatedAt", async () => {
  const harness = assistantCtx([]);
  const missingId = await assistantCompleteWorkItem(assistantRequest(), harness.ctx, assistantAccess, {
    action: "assistant-complete",
    expectedUpdatedAt: "2026-08-20T01:00:00.000Z",
  });
  const invalidDate = await assistantCompleteWorkItem(assistantRequest(), harness.ctx, assistantAccess, {
    action: "assistant-complete",
    id: "wi-1",
    expectedUpdatedAt: "언제였는지 모름",
  });

  assert.equal(missingId.status, 400);
  assert.equal(invalidDate.status, 400);
  assert.equal(harness.calls.length, 0);
});

test("assistant-complete returns 404 when no item is in scope", async () => {
  const harness = assistantCtx([
    { data: null, error: null },
  ]);
  const response = await assistantCompleteWorkItem(assistantRequest(), harness.ctx, assistantAccess, {
    action: "assistant-complete",
    id: "wi-404",
    expectedUpdatedAt: "2026-08-20T01:00:00.000Z",
  });

  assert.equal(response.status, 404);
  assert.equal(harness.audits.length, 0);
});

// ─────────────────────────────────────────────────────────────
// 구글 일정 다이얼로그 계약 (Google-first)
// ─────────────────────────────────────────────────────────────

const GOOGLE_ENV = { GOOGLE_OAUTH_CLIENT_ID: "cid-1", GOOGLE_OAUTH_CLIENT_SECRET: "sec-1" };
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const DEDICATED = "dedicated@group.calendar.google.com";
const GOOGLE_INTEGRATION = {
  owner_agency_code: "mml93-a01",
  refresh_token: "rt-1",
  calendar_id: DEDICATED,
  google_email: "owner@example.com",
  sync_status: "ok",
};

function tableCtx(tables = {}) {
  const ops = [];
  const queues = Object.fromEntries(Object.entries(tables).map(([name, list]) => [name, [...list]]));
  const from = (table) => {
    const op = { table, kind: "select", values: null, options: null, fields: "", filters: [] };
    const settle = () => {
      ops.push(op);
      const queue = queues[table];
      const next = queue && queue.length ? queue.shift() : undefined;
      return next === undefined ? { data: null, error: null } : next;
    };
    const query = {
      select(fields) { op.fields = fields || ""; return query; },
      insert(values) { op.kind = "insert"; op.values = values; return query; },
      update(values) { op.kind = "update"; op.values = values; return query; },
      upsert(values, options) { op.kind = "upsert"; op.values = values; op.options = options; return query; },
      delete() { op.kind = "delete"; return query; },
      maybeSingle() { return Promise.resolve(settle()); },
      single() { return Promise.resolve(settle()); },
      then(onOk, onErr) { return Promise.resolve(settle()).then(onOk, onErr); },
    };
    for (const method of ["eq", "is", "in", "or", "gt", "gte", "lt", "lte", "not", "order", "limit"]) {
      query[method] = (...args) => { op.filters.push([method, ...args]); return query; };
    }
    return query;
  };
  return { ctx: { supabaseAdmin: { from, rpc: async () => ({ data: null, error: null }) } }, ops };
}

function opsFor(ops, table, kind) {
  return ops.filter((op) => op.table === table && op.kind === kind);
}

function googleFetchMock(routes) {
  const calls = [];
  return {
    calls,
    impl: async (url, options = {}) => {
      const [base, search = ""] = String(url).split("?");
      const method = options.method || "GET";
      calls.push({ method, url: base, query: Object.fromEntries(new URLSearchParams(search)), options });
      const route = routes[`${method} ${base}`];
      if (route === undefined) throw new Error(`unexpected fetch: ${method} ${base}`);
      const body = typeof route === "function" ? route(calls.at(-1)) : route;
      return {
        ok: body.status >= 200 && body.status < 300,
        status: body.status,
        async json() { return body.body; },
      };
    },
  };
}

function googleJson(status, body) {
  return { status, body };
}

async function withGoogleEnv(impl, run) {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, GOOGLE_ENV);
  if (impl) globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(GOOGLE_ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function workRequest(method, body) {
  return new Request("https://insight.momentlabs.co.kr/api/work-items", {
    method,
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "owner",
      "x-mi-owner-agency-code": "mml93-a01",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function dialogBody(overrides = {}) {
  return {
    title: "월간 정산 미팅",
    scheduleType: "meeting",
    status: "planned",
    priority: "medium",
    startsAt: "2026-09-13T14:00",
    endsAt: "2026-09-13T15:00",
    attendees: [{ email: "A@B.com" }],
    sendUpdates: "all",
    conference: true,
    location: "본사 회의실",
    description: "정산 자료 지참",
    ...overrides,
  };
}

test("google event input rejects bad attendees, oversized text, bad recurrence and unknown options", () => {
  assert.equal(normalizeGoogleEventInput({ attendees: [{ email: "not-an-email" }] }).ok, false);
  assert.equal(normalizeGoogleEventInput({ attendees: Array.from({ length: 51 }, (_, i) => `a${i}@b.com`) }).ok, false);
  assert.equal(normalizeGoogleEventInput({ attendees: "a@b.com" }).ok, false);
  assert.equal(normalizeGoogleEventInput({ description: "가".repeat(4001) }).ok, false);
  assert.equal(normalizeGoogleEventInput({ location: "가".repeat(501) }).ok, false);
  assert.equal(normalizeGoogleEventInput({ recurrence: ["EVERY MONTH"] }).ok, false);
  assert.equal(normalizeGoogleEventInput({ recurrence: ["RRULE:BYMONTHDAY=13"] }).ok, false);
  assert.equal(normalizeGoogleEventInput({ sendUpdates: "externalOnly" }).ok, false);
  assert.equal(normalizeGoogleEventInput({ conference: "yes" }).ok, false);
  assert.equal(normalizeGoogleEventInput({ recurrenceScope: "following" }).ok, false);
  assert.equal(normalizeGoogleEventInput({ googleCalendarId: "c".repeat(1025) }).ok, false);
  for (const key of ["message"]) {
    assert.equal(typeof normalizeGoogleEventInput({ sendUpdates: "externalOnly" })[key], "string");
  }
});

test("google event input lowercases, dedupes and defaults the invite preference", () => {
  const result = normalizeGoogleEventInput({
    attendees: ["A@B.com", { email: "a@b.com" }, { email: "c@d.com", displayName: "다라" }],
    recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
    location: " 본사 ",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.attendees, [{ email: "a@b.com" }, { email: "c@d.com", displayName: "다라" }]);
  // 키가 없으면 초대 메일을 보내지 않는다. 드래그 이동·빠른 완료가
  // 참석자 전원에게 메일을 쏘는 사고를 막는 기본값이다.
  assert.equal(result.value.sendUpdates, "none");
  assert.equal(normalizeGoogleEventInput({ sendUpdates: "all" }).value.sendUpdates, "all");
  assert.equal(result.value.conference, false);
  assert.equal(result.value.recurrenceScope, "instance");
  assert.equal(result.value.location, "본사");
});

test("allDay is accepted as an alias of isAllDay", () => {
  assert.equal(normalizeWorkItemInput({
    title: "휴가", scheduleType: "meeting", startsAt: "2026-09-13", allDay: true,
  }, { canPublish: false }).value.is_all_day, true);
});

test("a legacy monthly repeat maps onto an RRULE with a Seoul-day UNTIL", () => {
  assert.deepEqual(monthlyRecurrenceLines("2026-09-13T05:00:00.000Z", "2026-12-13", false),
    ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13;UNTIL=20261213T145959Z"]);
  assert.deepEqual(monthlyRecurrenceLines("2026-09-13T05:00:00.000Z", "", true),
    ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"]);
});

test("a google write failure returns 502 and stores nothing at all", async () => {
  const harness = tableCtx({ owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }] });
  const { impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`POST ${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events`]: googleJson(403, { error: { code: 403 } }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("POST", dialogBody()), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "google_write_failed");
  assert.match(payload.message, /구글 캘린더에 일정을 저장하지 못했습니다/);
  assert.equal(opsFor(harness.ops, "schedule_items", "insert").length, 0);
  assert.equal(opsFor(harness.ops, "audit_logs", "insert").length, 0);
});

test("an expired google connection is reported as needs_reconnect without storing anything", async () => {
  const harness = tableCtx({ owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }] });
  const { impl } = googleFetchMock({ [`POST ${TOKEN_URL}`]: googleJson(400, { error: "invalid_grant" }) });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("POST", dialogBody()), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.code, "needs_reconnect");
  assert.equal(opsFor(harness.ops, "schedule_items", "insert").length, 0);
});

test("a connected owner writes one google event and mirrors it into a single MI row", async () => {
  const saved = { id: "row-1", title: "월간 정산 미팅", starts_at: "2026-09-13T05:00:00.000Z", google_event_id: "gev-1" };
  const harness = tableCtx({
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: [{ google_calendar_id: DEDICATED, calendar_role: "dedicated", calendar_summary: "모먼트 인사이트", calendar_writable: true }], error: null }],
    schedule_items: [{ data: [saved], error: null }],
    audit_logs: [{ error: null }],
  });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`POST ${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events`]: googleJson(200, {
      id: "gev-1", etag: '"e1"', updated: "2026-09-01T00:00:00.000Z",
      hangoutLink: "https://meet.google.com/abc",
      attendees: [{ email: "a@b.com", responseStatus: "needsAction" }],
    }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("POST", dialogBody()), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  const insert = opsFor(harness.ops, "schedule_items", "insert")[0];
  assert.equal(insert.values.length, 1);
  assert.equal(insert.values[0].google_event_id, "gev-1");
  assert.equal(insert.values[0].google_sync_state, "synced");
  assert.equal(insert.values[0].google_conference_uri, "https://meet.google.com/abc");
  assert.equal(insert.values[0].google_calendar_name, "모먼트 인사이트");
  assert.match(insert.values[0].id, /^[0-9a-f-]{36}$/u);
  // 확장 속성의 miScheduleId 가 실제 행 id 와 같아야 inbound 가 되짚을 수 있다.
  const body = JSON.parse(calls.find((call) => call.method === "POST" && call.url.endsWith("/events")).options.body);
  assert.equal(body.extendedProperties.private.miScheduleId, insert.values[0].id);
  assert.deepEqual(body.attendees, [{ email: "a@b.com" }]);
  assert.equal(body.location, "본사 회의실");
});

test("a recurring create makes one google master and one MI row per instance, never a master row", async () => {
  const harness = tableCtx({
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: [], error: null }],
    schedule_items: [{ data: [{ id: "row-1" }, { id: "row-2" }], error: null }],
    audit_logs: [{ error: null }],
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events`;
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`POST ${eventsUrl}`]: googleJson(200, {
      id: "master-1", etag: '"e1"', recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
    }),
    [`GET ${eventsUrl}/master-1/instances`]: googleJson(200, {
      items: [
        { id: "master-1_1", recurringEventId: "master-1", status: "confirmed", start: { dateTime: "2026-09-13T05:00:00.000Z" }, end: { dateTime: "2026-09-13T06:00:00.000Z" } },
        { id: "master-1_2", recurringEventId: "master-1", status: "confirmed", start: { dateTime: "2026-10-13T05:00:00.000Z" }, end: { dateTime: "2026-10-13T06:00:00.000Z" } },
      ],
    }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("POST", dialogBody({
    recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
  })), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.items.length, 2);
  const insert = opsFor(harness.ops, "schedule_items", "insert")[0];
  assert.equal(insert.values.length, 2, "인스턴스 수만큼 행이 생긴다");
  assert.deepEqual(insert.values.map((row) => row.google_event_id), ["master-1_1", "master-1_2"]);
  assert.equal(insert.values.every((row) => row.google_recurring_event_id === "master-1"), true);
  assert.equal(insert.values.some((row) => row.google_event_id === "master-1"), false, "MI 마스터 행은 만들지 않는다");
  assert.equal(insert.values.every((row) => row.series_id === undefined), true, "레거시 시리즈 생성기를 쓰지 않는다");
  assert.deepEqual(insert.values[0].starts_at, "2026-09-13T05:00:00.000Z");
  // 구글에는 마스터 1개만 들어간다.
  assert.equal(calls.filter((call) => call.method === "POST" && call.url === eventsUrl).length, 1);
});

test("an empty instance page still saves the created master and says so", async () => {
  const harness = tableCtx({
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: [], error: null }],
    schedule_items: [{ data: [{ id: "row-1" }], error: null }],
    audit_logs: [{ error: null }],
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events`;
  const { impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`POST ${eventsUrl}`]: googleJson(200, { id: "master-1" }),
    [`GET ${eventsUrl}/master-1/instances`]: googleJson(500, { error: { code: 500 } }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("POST", dialogBody({
    recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
  })), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.match(payload.message, /다음 동기화에서 채워집니다/);
  const insert = opsFor(harness.ops, "schedule_items", "insert")[0];
  assert.equal(insert.values.length, 1);
  assert.equal(insert.values[0].google_event_id, "master-1");
});

test("googleCalendarId is an accepted key while the legacy shared calendarId still 404s", async () => {
  const accepted = tableCtx({
    schedule_items: [{ data: [{ id: "row-1", starts_at: "2026-09-13T05:00:00.000Z" }], error: null }],
    audit_logs: [{ error: null }],
  });
  const response = await handleWorkItemsRequest(workRequest("POST", dialogBody({
    googleCalendarId: "abc@group.calendar.google.com",
  })), accepted.ctx);
  assert.equal(response.status, 201);

  const rejected = tableCtx({});
  const shared = await handleWorkItemsRequest(workRequest("POST", dialogBody({ calendarId: "cal-1" })), rejected.ctx);
  assert.equal(shared.status, 404);
  assert.equal(rejected.ops.length, 0);
});

test("an unconnected owner keeps the legacy monthly expansion byte for byte", async () => {
  const seriesId = "11111111-1111-4111-8111-111111111111";
  const harness = tableCtx({
    schedule_items: [
      { data: [], error: null },
      { data: [{ id: "row-1", starts_at: "2026-08-15T00:00:00.000Z" }], error: null },
    ],
    audit_logs: [{ error: null }],
  });
  const response = await handleWorkItemsRequest(workRequest("POST", {
    title: "급여 지급",
    scheduleType: "report_due",
    status: "planned",
    priority: "medium",
    startsAt: "2026-08-15T09:00:00+09:00",
    endsAt: "2026-08-15T10:00:00+09:00",
    repeat: "monthly",
    repeatUntil: "2026-10-15",
    requestId: seriesId,
  }), harness.ctx);

  assert.equal(response.status, 201);
  const insert = opsFor(harness.ops, "schedule_items", "insert")[0];
  assert.deepEqual(insert.values.map((row) => row.occurrence_on), ["2026-08-15", "2026-09-15", "2026-10-15"]);
  assert.equal(insert.values.every((row) => row.series_id === seriesId), true);
  assert.equal(insert.values.every((row) => row.recurrence_kind === "monthly"), true);
});

test("the manager payload and GET expose the google detail fields and the cached calendars", async () => {
  const harness = tableCtx({
    schedule_items: [{ data: [{
      id: "row-1",
      title: "월간 정산 미팅",
      schedule_type: "meeting",
      status: "planned",
      starts_at: "2026-09-13T05:00:00.000Z",
      is_all_day: false,
      calendar_id: null,
      google_calendar_id: DEDICATED,
      google_calendar_name: "모먼트 인사이트",
      google_location: "본사 회의실",
      google_description: "정산 자료 지참",
      google_attendees: [{ email: "a@b.com", displayName: "가나", responseStatus: "accepted", self: true }],
      google_conference_uri: "https://meet.google.com/abc",
      google_recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
      google_recurring_event_id: "master-1",
    }], error: null }],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: [
      { google_calendar_id: DEDICATED, calendar_role: "dedicated", calendar_summary: "모먼트 인사이트", calendar_access_role: "owner", calendar_writable: true },
      { google_calendar_id: "owner@example.com", calendar_role: "primary", calendar_summary: "내 캘린더", calendar_access_role: "owner", calendar_is_primary: true, calendar_writable: true },
    ], error: null }],
  });

  const response = await withGoogleEnv(null, () => handleWorkItemsRequest(workRequest("GET"), harness.ctx));
  const payload = await response.json();
  const item = payload.items[0];

  assert.deepEqual(payload.calendars, [], "옛 공유 일정표 키는 그대로 빈 배열이다");
  assert.deepEqual(payload.googleCalendars.map((entry) => entry.id), [DEDICATED, "owner@example.com"]);
  assert.equal(payload.googleCalendars[0].dedicated, true);
  assert.equal(item.location, "본사 회의실");
  assert.equal(item.description, "정산 자료 지참");
  assert.equal(item.conferenceUri, "https://meet.google.com/abc");
  assert.equal(item.calendarName, "모먼트 인사이트");
  assert.equal(item.googleCalendarId, DEDICATED);
  assert.deepEqual(item.recurrence, ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"]);
  assert.equal(item.recurrenceSummary, "매월 13일");
  assert.equal(item.isRecurringInstance, true);
  assert.deepEqual(item.attendees, [{ email: "a@b.com", displayName: "가나", responseStatus: "accepted" }]);
});

test("GET reports no google calendars when the integration is missing", async () => {
  const harness = tableCtx({
    schedule_items: [{ data: [], error: null }],
    owner_google_integrations: [{ data: null, error: null }],
  });
  const response = await withGoogleEnv(null, () => handleWorkItemsRequest(workRequest("GET"), harness.ctx));
  const payload = await response.json();
  assert.deepEqual(payload.googleCalendars, []);
});

test("a recurring instance edit patches the instance and keeps its own event id", async () => {
  const row = {
    id: "row-1",
    client_id: null, operation_team_id: null, owner_agency_code: "mml93-a01", calendar_id: null,
    title: "월간 정산 미팅", schedule_type: "meeting", status: "planned", priority: "medium",
    starts_at: "2026-09-13T05:00:00.000Z", ends_at: "2026-09-13T06:00:00.000Z",
    visibility: "internal", is_all_day: false,
    google_calendar_id: DEDICATED, google_event_id: "master-1_1", google_recurring_event_id: "master-1",
    google_etag: '"e1"',
    google_attendees: [{ email: "a@b.com", responseStatus: "accepted" }],
    updated_at: "2026-09-01T00:00:00.000Z",
  };
  const harness = tableCtx({
    schedule_items: [
      { data: row, error: null },
      { data: { ...row, updated_at: "2026-09-02T00:00:00.000Z" }, error: null },
    ],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: [], error: null }],
    audit_logs: [{ error: null }],
  });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`PATCH ${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events/master-1_1`]: googleJson(200, {
      id: "master-1_1", etag: '"e2"', recurringEventId: "master-1",
    }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("PATCH", dialogBody({
    id: "row-1",
    expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    attendees: [{ email: "a@b.com" }],
    conference: false,
  })), harness.ctx));

  assert.equal(response.status, 200);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.url.endsWith("/events/master-1_1"), true, "기본값은 이 일정만 수정한다");
  assert.equal(patch.query.conferenceDataVersion, undefined, "회의를 만들지 않는 patch 는 버전 0 이다");
  // RSVP 를 지우지 않으려면 저장해 둔 responseStatus 를 함께 보내야 한다.
  assert.deepEqual(JSON.parse(patch.options.body).attendees, [{ email: "a@b.com", responseStatus: "accepted" }]);
  const update = opsFor(harness.ops, "schedule_items", "update")[0];
  assert.equal(update.values.google_event_id, "master-1_1");
  assert.equal(update.values.google_sync_state, "synced");
});

test("recurrenceScope all patches the master and re-collects the instances without deleting any", async () => {
  const row = {
    id: "row-1",
    client_id: null, operation_team_id: null, owner_agency_code: "mml93-a01", calendar_id: null,
    title: "월간 정산 미팅", schedule_type: "meeting", status: "planned", priority: "medium",
    starts_at: "2026-09-13T05:00:00.000Z", ends_at: "2026-09-13T06:00:00.000Z",
    visibility: "internal", is_all_day: false,
    google_calendar_id: DEDICATED, google_event_id: "master-1_1", google_recurring_event_id: "master-1",
    google_etag: '"e1"',
    updated_at: "2026-09-01T00:00:00.000Z",
  };
  const harness = tableCtx({
    schedule_items: [
      { data: row, error: null },
      { data: { ...row, title: "정산 미팅", updated_at: "2026-09-02T00:00:00.000Z" }, error: null },
      { data: [{ ...row, id: "row-1", google_event_id: "master-1_1" }], error: null },
      { data: null, error: null },
      { data: null, error: null },
    ],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: [], error: null }],
    audit_logs: [{ error: null }],
  });
  const eventsUrl = `${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events`;
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`PATCH ${eventsUrl}/master-1`]: googleJson(200, { id: "master-1", recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"] }),
    [`GET ${eventsUrl}/master-1/instances`]: googleJson(200, {
      items: [
        { id: "master-1_1", recurringEventId: "master-1", status: "confirmed", start: { dateTime: "2026-09-13T05:00:00.000Z" }, end: { dateTime: "2026-09-13T06:00:00.000Z" } },
        { id: "master-1_2", recurringEventId: "master-1", status: "confirmed", start: { dateTime: "2026-10-13T05:00:00.000Z" }, end: { dateTime: "2026-10-13T06:00:00.000Z" } },
      ],
    }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("PATCH", dialogBody({
    id: "row-1",
    title: "정산 미팅",
    expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
    recurrenceScope: "all",
    conference: false,
  })), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 200);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.url.endsWith("/events/master-1"), true, "모든 일정은 마스터를 고친다");
  assert.equal(patch.options.headers["if-match"], undefined, "인스턴스 etag 를 마스터에 쓰지 않는다");
  assert.deepEqual(JSON.parse(patch.options.body).recurrence, ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"]);
  const anchorUpdate = opsFor(harness.ops, "schedule_items", "update")[0];
  assert.equal(anchorUpdate.values.google_event_id, undefined, "마스터 id 를 인스턴스 행에 덮지 않는다");
  const inserted = opsFor(harness.ops, "schedule_items", "insert");
  assert.deepEqual(inserted[0].values.map((entry) => entry.google_event_id), ["master-1_2"]);
  assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 0, "사라진 인스턴스는 지우지 않는다");
  assert.match(payload.message, /반복 일정/);
});

// 드래그 이동·빠른 완료 PATCH 는 상세를 싣지 않는다. 그때 서버가 빈 값을
// 보내면 참석자·설명·반복 규칙이 통째로 날아간다.
test("a PATCH without detail keys touches neither google nor the stored details", async () => {
  const row = {
    id: "row-1",
    client_id: null, operation_team_id: null, owner_agency_code: "mml93-a01", calendar_id: null,
    title: "월간 정산 미팅", schedule_type: "meeting", status: "planned", priority: "medium",
    starts_at: "2026-09-13T05:00:00.000Z", ends_at: "2026-09-13T06:00:00.000Z",
    visibility: "internal", is_all_day: false,
    google_calendar_id: DEDICATED, google_event_id: "master-1_1", google_recurring_event_id: "master-1",
    google_location: "본사 회의실", google_description: "정산 자료 지참",
    google_attendees: [{ email: "a@b.com", responseStatus: "accepted" }],
    google_recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=13"],
    updated_at: "2026-09-01T00:00:00.000Z",
  };
  const harness = tableCtx({
    schedule_items: [
      { data: row, error: null },
      { data: { ...row, status: "done", updated_at: "2026-09-02T00:00:00.000Z" }, error: null },
    ],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: [], error: null }],
    audit_logs: [{ error: null }],
  });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    // events.patch 는 갱신된 전체 리소스를 돌려준다. 우리가 보내지 않은 필드는
    // 그대로 되돌아오므로 미러링해도 값이 유지된다.
    [`PATCH ${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events/master-1_1`]: googleJson(200, {
      id: "master-1_1", etag: '"e2"', recurringEventId: "master-1",
      location: "본사 회의실", description: "정산 자료 지참",
      attendees: [{ email: "a@b.com", responseStatus: "accepted" }],
    }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("PATCH", {
    id: "row-1",
    expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    title: "월간 정산 미팅",
    scheduleType: "meeting",
    status: "done",
    priority: "medium",
    startsAt: "2026-09-13T14:00",
    endsAt: "2026-09-13T15:00",
    allDay: false,
    recurrenceScope: "instance",
  }), harness.ctx));

  assert.equal(response.status, 200);
  const body = JSON.parse(calls.find((call) => call.method === "PATCH").options.body);
  assert.equal("attendees" in body, false, "보내지 않은 참석자는 건드리지 않는다");
  assert.equal("location" in body, false);
  assert.equal("description" in body, false);
  assert.equal("recurrence" in body, false, "반복 규칙은 보내지 않으면 그대로 둔다");
  assert.equal(body.summary, "✓ 월간 정산 미팅");
  const update = opsFor(harness.ops, "schedule_items", "update")[0];
  assert.deepEqual(update.values.google_attendees, [{ email: "a@b.com", responseStatus: "accepted" }]);
  assert.equal(update.values.google_location, "본사 회의실");
  // 인스턴스 응답에는 recurrence 가 없다. 없다고 지우면 표시용 사본이 날아간다.
  assert.equal("google_recurrence" in update.values, false);
  assert.equal(update.values.status, "done");
});

test("an explicitly emptied detail is cleared while an absent one is not", () => {
  const cleared = normalizeGoogleEventInput({ attendees: [], location: "", recurrence: [] });
  assert.deepEqual(cleared.value.provided, {
    recurrence: true, attendees: true, location: true, description: false,
  });
  const untouched = normalizeGoogleEventInput({ recurrenceScope: "instance" });
  assert.deepEqual(untouched.value.provided, {
    recurrence: false, attendees: false, location: false, description: false,
  });
});
