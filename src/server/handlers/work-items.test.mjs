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

// 레거시 테스트는 "구글 미연동" 분기를 기준으로 쓰였다. Vercel 프로덕션 빌드는
// GOOGLE_OAUTH_* 가 실린 채 테스트를 돌리므로, 주변 환경변수를 모듈 로드 시점에
// 지워 기준선을 "없음"으로 고정한다. 구글 경로를 검증하는 테스트는 아래
// withGoogleEnv 가 직접 값을 넣었다가 이 기준선으로 되돌린다.
const PINNED_GOOGLE_ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "MI_GOOGLE_OAUTH_REDIRECT",
];
const AMBIENT_GOOGLE_ENV = {};
for (const key of PINNED_GOOGLE_ENV_KEYS) {
  AMBIENT_GOOGLE_ENV[key] = process.env[key];
  delete process.env[key];
}
process.on("exit", () => {
  for (const key of PINNED_GOOGLE_ENV_KEYS) {
    if (AMBIENT_GOOGLE_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = AMBIENT_GOOGLE_ENV[key];
  }
});

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

// ─────────────────────────────────────────────────────────────
// 삭제: 구글 우선 경로
// ─────────────────────────────────────────────────────────────

function deletableRow(overrides = {}) {
  return {
    id: "row-1",
    client_id: null, operation_team_id: null, owner_agency_code: "mml93-a01", calendar_id: null,
    title: "월간 정산 미팅", schedule_type: "meeting", status: "planned", priority: "medium",
    starts_at: "2026-09-13T05:00:00.000Z", ends_at: "2026-09-13T06:00:00.000Z",
    visibility: "internal", is_all_day: false,
    google_calendar_id: DEDICATED, google_event_id: "gev-1",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const DELETE_EVENT_URL = `${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events/gev-1`;

test("a google delete failure returns 502 and preserves the MI row", async (t) => {
  await t.test("needs_reconnect", async () => {
    const harness = tableCtx({
      schedule_items: [{ data: deletableRow(), error: null }],
      owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
      audit_logs: [{ error: null }],
    });
    const { impl } = googleFetchMock({ [`POST ${TOKEN_URL}`]: googleJson(400, { error: "invalid_grant" }) });

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-1",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 502);
    assert.equal(payload.code, "google_delete_failed");
    assert.equal(payload.message, "구글 연결이 만료되었습니다. 구글 캘린더를 다시 연결한 뒤 삭제해주세요.");
    assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 0, "구글이 실패하면 MI 행을 남긴다");
  });

  await t.test("generic retry", async () => {
    const harness = tableCtx({
      schedule_items: [{ data: deletableRow(), error: null }],
      owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
      audit_logs: [{ error: null }],
    });
    const { impl } = googleFetchMock({
      [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
      [`DELETE ${DELETE_EVENT_URL}`]: googleJson(500, { error: { code: 500 } }),
    });

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-1",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 502);
    assert.equal(payload.code, "google_delete_failed");
    assert.equal(payload.message, "구글 캘린더에서 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.");
    assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 0, "구글이 실패하면 MI 행을 남긴다");
  });
});

// 구글에서 이미 사라진 일정은 삭제 성공과 같다. 여기서 막으면 MI 행이 영원히 남는다.
test("a google 404 or 410 on the event delete still removes the MI row", async (t) => {
  for (const status of [404, 410]) {
    await t.test(`google ${status}`, async () => {
      const harness = tableCtx({
        schedule_items: [
          { data: deletableRow(), error: null },
          { data: { id: "row-1" }, error: null },
        ],
        owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
        audit_logs: [{ error: null }],
      });
      const { impl } = googleFetchMock({
        [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
        [`DELETE ${DELETE_EVENT_URL}`]: googleJson(status, { error: { code: status } }),
      });

      const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
        id: "row-1",
        expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
      }), harness.ctx));

      assert.equal(response.status, 200);
      const removals = opsFor(harness.ops, "schedule_items", "delete");
      assert.equal(removals.length, 1);
      assert.equal(removals[0].filters.some(([kind, column]) => kind === "eq" && column === "updated_at"), false);
    });
  }
});

// updated_at 은 google_synced_at 갱신만으로도 올라간다. 낡은 값을 들고 온
// 삭제는 막지 않고 행을 다시 읽어 그 정본으로 구글까지 지운다.
test("a stale expectedUpdatedAt re-reads the row and still deletes through google", async () => {
  const harness = tableCtx({
    schedule_items: [
      { data: deletableRow(), error: null },
      { data: deletableRow({ updated_at: "2026-09-02T00:00:00.000Z", google_synced_at: "2026-09-02T00:00:00.000Z" }), error: null },
      { data: { id: "row-1" }, error: null },
    ],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    audit_logs: [{ error: null }],
  });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`DELETE ${DELETE_EVENT_URL}`]: googleJson(204, {}),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
    id: "row-1",
    expectedUpdatedAt: "2026-08-25T00:00:00.000Z",
  }), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(opsFor(harness.ops, "schedule_items", "select").length, 2, "낡은 버전이면 행을 한 번만 다시 읽는다");
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 1);
  // 삭제는 감사 두 줄이다. 시도(work_item_delete_attempted)를 먼저 남기고
  // 그 다음에 기존 성공 줄(work_item_deleted)을 남긴다.
  const audits = opsFor(harness.ops, "audit_logs", "insert");
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map((op) => op.values.action), ["work_item_delete_attempted", "work_item_deleted"]);
});

// ─────────────────────────────────────────────────────────────
// 사이드바 카탈로그: 숨긴 캘린더 제외 · 읽기 전용 캘린더 보호
// ─────────────────────────────────────────────────────────────

const HOLIDAY = "holidays@group.calendar.google.com";
// resolveOwnerCalendars 가 방금 만들어 넣은 카탈로그 행의 모습 그대로다:
// calendar_writable 은 DB 기본값 false, calendar_access_role 은 null.
// 둘 다 "모름" 이므로 잠그면 안 되는 캘린더다.
const UNKNOWN_CALENDAR = "team-shared@group.calendar.google.com";
// writerWithoutPrivateAccess 는 일정 읽기·쓰기를 준다. 읽기 전용이 아니다.
const LIMITED_WRITER = "limited@group.calendar.google.com";

function catalogRows() {
  return [
    { google_calendar_id: DEDICATED, calendar_role: "dedicated", calendar_summary: "모먼트 인사이트", calendar_access_role: "owner", calendar_writable: true, calendar_visible: true, calendar_background_color: "#0b8043", calendar_foreground_color: "#ffffff" },
    { google_calendar_id: HOLIDAY, calendar_role: "secondary", calendar_summary: "대한민국 공휴일", calendar_access_role: "reader", calendar_writable: false, calendar_visible: false, calendar_background_color: "#616161" },
  ];
}

function feedRow(id, calendarId, title) {
  return {
    id,
    title,
    schedule_type: "meeting",
    status: "planned",
    starts_at: "2026-09-13T05:00:00.000Z",
    is_all_day: false,
    calendar_id: null,
    google_calendar_id: calendarId,
  };
}

function workGetRequest(search = "") {
  return new Request(`https://insight.momentlabs.co.kr/api/work-items${search}`, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "owner",
      "x-mi-owner-agency-code": "mml93-a01",
    },
  });
}

function feedCtx() {
  return tableCtx({
    schedule_items: [{ data: [
      feedRow("row-1", DEDICATED, "월간 정산 미팅"),
      feedRow("row-2", HOLIDAY, "추석"),
      feedRow("row-3", null, "구글 없는 일정"),
    ], error: null }],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: catalogRows(), error: null }],
  });
}

test("GET drops the rows of a calendar the owner unchecked in the sidebar", async () => {
  const response = await withGoogleEnv(null, () => handleWorkItemsRequest(workGetRequest(), feedCtx().ctx));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.items.map((item) => item.id), ["row-1", "row-3"],
    "숨긴 캘린더의 행은 빠지고 구글 캘린더가 없는 행은 남는다");
});

test("GET with includeHidden brings the unchecked calendar back", async () => {
  const response = await withGoogleEnv(null, () => handleWorkItemsRequest(workGetRequest("?includeHidden=1"), feedCtx().ctx));
  const payload = await response.json();

  assert.deepEqual(payload.items.map((item) => item.id), ["row-1", "row-2", "row-3"]);
  const holiday = payload.items[1];
  assert.equal(holiday.calendarName, "대한민국 공휴일");
  assert.equal(holiday.calendarColor, "#616161");
  assert.equal(holiday.calendarAccessRole, "reader");
  assert.equal(holiday.calendarVisible, false);
  assert.equal(holiday.readOnly, true, "읽기 전용 캘린더의 일정은 화면에서도 잠긴다");
  assert.equal(payload.items[0].readOnly, false);
  assert.equal(payload.items[0].calendarColor, "#0b8043");
  assert.equal(payload.items[0].calendarTextColor, "#ffffff");
  assert.equal(payload.items[2].readOnly, false, "카탈로그에 없는 행은 잠그지 않는다");
  assert.equal(payload.items[2].calendarVisible, true);
});

test("GET carries the sidebar catalog next to the writable dialog list", async () => {
  const response = await withGoogleEnv(null, () => handleWorkItemsRequest(workGetRequest(), feedCtx().ctx));
  const payload = await response.json();

  assert.deepEqual(payload.calendars, [], "옛 공유 일정표 키는 그대로 빈 배열이다");
  assert.deepEqual(payload.googleCalendarCatalog.map((entry) => entry.id), [DEDICATED, HOLIDAY]);
  assert.deepEqual(payload.googleCalendarCatalog.map((entry) => entry.group), ["own", "other"]);
  assert.equal(payload.googleCalendarCatalog[1].writable, false);
  assert.equal(payload.googleCalendarCatalog[1].visible, false);
  assert.equal(payload.googleCalendarCatalog[1].color, "#616161");
  assert.deepEqual(payload.googleCalendars.map((entry) => entry.id), [DEDICATED],
    "다이얼로그에는 쓰기 가능한 캘린더만 올린다");
  assert.deepEqual(Object.keys(payload.googleCalendars[0]).sort(),
    ["accessRole", "dedicated", "id", "name", "primary"]);
});

function holidayRow(overrides = {}) {
  return {
    id: "row-2",
    client_id: null, operation_team_id: null, owner_agency_code: "mml93-a01", calendar_id: null,
    title: "추석", schedule_type: "meeting", status: "planned", priority: "medium",
    starts_at: "2026-09-13T05:00:00.000Z", ends_at: "2026-09-13T06:00:00.000Z",
    visibility: "internal", is_all_day: false,
    google_calendar_id: HOLIDAY, google_event_id: "gev-holiday",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

test("a PATCH on a read-only calendar is refused before google or the database is touched", async () => {
  const harness = tableCtx({
    schedule_items: [{ data: holidayRow(), error: null }],
    owner_google_calendar_sync: [{ data: catalogRows(), error: null }],
  });
  const { calls, impl } = googleFetchMock({});

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("PATCH", dialogBody({
    id: "row-2",
    expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    conference: false,
  })), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.code, "calendar_read_only");
  assert.match(payload.message, /읽기 전용/);
  assert.equal(calls.length, 0, "구글을 부르지 않는다");
  assert.equal(opsFor(harness.ops, "schedule_items", "update").length, 0, "행도 건드리지 않는다");
});

test("a DELETE on a read-only calendar is refused before google or the database is touched", async () => {
  const harness = tableCtx({
    schedule_items: [{ data: holidayRow(), error: null }],
    owner_google_calendar_sync: [{ data: catalogRows(), error: null }],
  });
  const { calls, impl } = googleFetchMock({});

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
    id: "row-2",
    expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
  }), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.code, "calendar_read_only");
  assert.equal(calls.length, 0, "구글을 부르지 않는다");
  assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 0, "MI 행을 남긴다");
});

// 캐시가 아직 차오르지 않았다는 이유로 고칠 수 있는 일정을 막으면 안 된다.
test("a row whose calendar the catalog does not know is still editable", async () => {
  const row = holidayRow({ id: "row-1", google_calendar_id: DEDICATED, google_event_id: "gev-1", title: "월간 정산 미팅" });
  const harness = tableCtx({
    schedule_items: [
      { data: row, error: null },
      { data: { ...row, updated_at: "2026-09-02T00:00:00.000Z" }, error: null },
    ],
    owner_google_calendar_sync: [{ data: [catalogRows()[1]], error: null }],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    audit_logs: [{ error: null }],
  });
  const { impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`PATCH ${CALENDAR_BASE}/calendars/${encodeURIComponent(DEDICATED)}/events/gev-1`]: googleJson(200, {
      id: "gev-1", etag: '"e2"',
    }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("PATCH", dialogBody({
    id: "row-1",
    expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    conference: false,
  })), harness.ctx));

  assert.equal(response.status, 200);
  assert.equal(opsFor(harness.ops, "schedule_items", "update").length, 1);
});

function calendarBoundRow(calendarId, overrides = {}) {
  return {
    id: "row-9",
    client_id: null, operation_team_id: null, owner_agency_code: "mml93-a01", calendar_id: null,
    title: "팀 공유 일정", schedule_type: "meeting", status: "planned", priority: "medium",
    starts_at: "2026-09-13T05:00:00.000Z", ends_at: "2026-09-13T06:00:00.000Z",
    visibility: "internal", is_all_day: false,
    google_calendar_id: calendarId, google_event_id: "gev-9",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function eventUrlFor(calendarId) {
  return `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/gev-9`;
}

// 프로덕션 회귀. 가드가 writable !== true 로 막던 시절에는 resolveOwnerCalendars 가
// 만든 모든 보조 캘린더 행(calendar_writable=false, calendar_access_role=null)이
// 읽기 전용으로 뒤집혀 수정·삭제가 통째로 403 calendar_read_only 가 됐다.
// "삭제가 막힌다" 던 그 버그를 여기서 못박는다.
test("a calendar the catalog knows but whose access role is unknown stays editable and deletable (regression)", async (t) => {
  const catalog = [{ google_calendar_id: UNKNOWN_CALENDAR, calendar_role: "secondary", calendar_summary: "팀 공유" }];

  await t.test("PATCH", async () => {
    const row = calendarBoundRow(UNKNOWN_CALENDAR);
    const harness = tableCtx({
      schedule_items: [
        { data: row, error: null },
        { data: { ...row, updated_at: "2026-09-02T00:00:00.000Z" }, error: null },
      ],
      owner_google_calendar_sync: [{ data: catalog, error: null }],
      owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
      audit_logs: [{ error: null }],
    });
    const { calls, impl } = googleFetchMock({
      [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
      [`PATCH ${eventUrlFor(UNKNOWN_CALENDAR)}`]: googleJson(200, { id: "gev-9", etag: '"e2"' }),
    });

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("PATCH", dialogBody({
      id: "row-9",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
      conference: false,
    })), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 200, "accessRole 을 모르는 캘린더는 수정할 수 있어야 한다");
    assert.equal(payload.code, undefined, "calendar_read_only 로 막히지 않는다");
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 1, "구글에도 실제로 나간다");
    assert.equal(opsFor(harness.ops, "schedule_items", "update").length, 1);
  });

  await t.test("DELETE", async () => {
    const row = calendarBoundRow(UNKNOWN_CALENDAR);
    const harness = tableCtx({
      schedule_items: [
        { data: row, error: null },
        { data: { id: "row-9" }, error: null },
      ],
      owner_google_calendar_sync: [{ data: catalog, error: null }],
      owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
      audit_logs: [{ error: null }, { error: null }],
    });
    const { calls, impl } = googleFetchMock({
      [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
      [`DELETE ${eventUrlFor(UNKNOWN_CALENDAR)}`]: googleJson(204, {}),
    });

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-9",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 200, "accessRole 을 모르는 캘린더는 삭제할 수 있어야 한다");
    assert.equal(payload.code, undefined, "calendar_read_only 로 막히지 않는다");
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1, "구글에서 먼저 지운다");
    assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 1);
  });
});

// 잠금은 accessRole 로만 판단한다. writerWithoutPrivateAccess 는 일정 읽기·쓰기를
// 주므로, calendar_writable 백필이 아직 닿지 않은 행이어도 편집을 막으면 안 된다.
test("a writerWithoutPrivateAccess calendar is editable even before the writable flag is backfilled", async () => {
  const row = calendarBoundRow(LIMITED_WRITER);
  const harness = tableCtx({
    schedule_items: [
      { data: row, error: null },
      { data: { ...row, updated_at: "2026-09-02T00:00:00.000Z" }, error: null },
    ],
    owner_google_calendar_sync: [{ data: [{
      google_calendar_id: LIMITED_WRITER,
      calendar_role: "secondary",
      calendar_summary: "제한 쓰기 캘린더",
      calendar_access_role: "writerWithoutPrivateAccess",
      calendar_writable: false,
    }], error: null }],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    audit_logs: [{ error: null }],
  });
  const { calls, impl } = googleFetchMock({
    [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
    [`PATCH ${eventUrlFor(LIMITED_WRITER)}`]: googleJson(200, { id: "gev-9", etag: '"e2"' }),
  });

  const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("PATCH", dialogBody({
    id: "row-9",
    expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    conference: false,
  })), harness.ctx));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.code, undefined, "읽기 전용이 아니므로 막지 않는다");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

// 화면의 자물쇠도 같은 규칙을 쓴다: 구글이 읽기 전용이라고 확인해 준 캘린더만 잠근다.
test("GET marks readOnly only for the calendar google confirmed as read-only", async () => {
  const harness = tableCtx({
    schedule_items: [{ data: [
      feedRow("row-1", DEDICATED, "월간 정산 미팅"),
      feedRow("row-2", HOLIDAY, "추석"),
      feedRow("row-9", UNKNOWN_CALENDAR, "팀 공유 일정"),
    ], error: null }],
    owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    owner_google_calendar_sync: [{ data: [
      ...catalogRows(),
      { google_calendar_id: UNKNOWN_CALENDAR, calendar_role: "secondary", calendar_summary: "팀 공유" },
    ], error: null }],
  });

  const response = await withGoogleEnv(null, () => handleWorkItemsRequest(workGetRequest("?includeHidden=1"), harness.ctx));
  const payload = await response.json();
  const byId = new Map(payload.items.map((item) => [item.id, item]));

  assert.equal(byId.get("row-9").readOnly, false, "accessRole 을 모르는 캘린더는 화면에서도 잠그지 않는다");
  assert.equal(byId.get("row-2").readOnly, true, "reader 캘린더만 잠근다");
  assert.equal(byId.get("row-1").readOnly, false);
  // 두 신호는 여집합이 아니다 — 다이얼로그 목록에는 여전히 쓰기 가능한 것만 오른다.
  assert.deepEqual(payload.googleCalendars.map((entry) => entry.id), [DEDICATED]);
});

// managerWorkItemPayload 가 2번째 인자를 받게 되면서, 목록 매핑을 함수 참조로
// 넘기면 배열 인덱스가 캘린더 자리에 꽂힌다. 첫 행 말고 나머지가 통째로
// readOnly 로 잠기는 사고라 여기서 못박는다.
test("a multi-row response never mistakes the list index for a calendar", async () => {
  const rows = [
    { id: "row-1", title: "급여 지급", starts_at: "2026-08-15T00:00:00.000Z" },
    { id: "row-2", title: "급여 지급", starts_at: "2026-09-15T00:00:00.000Z" },
    { id: "row-3", title: "급여 지급", starts_at: "2026-10-15T00:00:00.000Z" },
  ];
  const harness = tableCtx({
    schedule_items: [
      { data: [], error: null },
      { data: rows, error: null },
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
    requestId: "22222222-2222-4222-8222-222222222222",
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.items.length, 3);
  assert.deepEqual(payload.items.map((item) => item.readOnly), [false, false, false]);
  assert.deepEqual(payload.items.map((item) => item.calendarVisible), [true, true, true]);
  assert.deepEqual(payload.items.map((item) => item.calendarName), [null, null, null]);
});

// ─────────────────────────────────────────────────────────────
// 삭제 시도 감사: 성공이든 실패든 요청당 정확히 한 줄
// ─────────────────────────────────────────────────────────────

function auditRows(ops) {
  return opsFor(ops, "audit_logs", "insert").map((op) => op.values);
}

function deleteAttempts(ops) {
  return auditRows(ops).filter((row) => row.action === "work_item_delete_attempted");
}

test("every delete attempt writes exactly one audit row carrying its outcome", async (t) => {
  await t.test("deleted", async () => {
    const harness = tableCtx({
      schedule_items: [
        { data: deletableRow(), error: null },
        { data: { id: "row-1" }, error: null },
      ],
      owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
      audit_logs: [{ error: null }, { error: null }],
    });
    const { impl } = googleFetchMock({
      [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
      [`DELETE ${DELETE_EVENT_URL}`]: googleJson(204, {}),
    });

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-1",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 200, "감사가 늘어도 응답은 그대로다");
    assert.equal(payload.ok, true);
    assert.equal(payload.message, "업무를 삭제했습니다.");
    // 성공한 삭제는 감사 두 줄이다. 시도가 먼저, 기존 성공 줄이 뒤다.
    assert.deepEqual(auditRows(harness.ops).map((row) => row.action),
      ["work_item_delete_attempted", "work_item_deleted"]);
    const attempts = deleteAttempts(harness.ops);
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].metadata,
      { outcome: "deleted", reason: "ok", googleSkipped: false, calendarId: DEDICATED });
  });

  await t.test("google_failed", async () => {
    const harness = tableCtx({
      schedule_items: [{ data: deletableRow(), error: null }],
      owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
      audit_logs: [{ error: null }, { error: null }],
    });
    const { impl } = googleFetchMock({
      [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
      [`DELETE ${DELETE_EVENT_URL}`]: googleJson(500, { error: { code: 500 } }),
    });

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-1",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 502);
    assert.equal(payload.code, "google_delete_failed");
    assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 0, "구글이 실패하면 MI 행을 남긴다");
    const attempts = deleteAttempts(harness.ops);
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].metadata,
      { outcome: "google_failed", reason: "delete_500", googleSkipped: false, calendarId: DEDICATED });
  });

  await t.test("read_only", async () => {
    const harness = tableCtx({
      schedule_items: [{ data: holidayRow(), error: null }],
      owner_google_calendar_sync: [{ data: catalogRows(), error: null }],
      audit_logs: [{ error: null }],
    });
    const { calls, impl } = googleFetchMock({});

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-2",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 403);
    assert.equal(payload.code, "calendar_read_only");
    assert.equal(calls.length, 0, "감사를 남겨도 구글은 부르지 않는다");
    assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 0, "MI 행도 그대로다");
    const attempts = deleteAttempts(harness.ops);
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].metadata,
      { outcome: "read_only", reason: "calendar_read_only", googleSkipped: true, calendarId: HOLIDAY });
  });

  await t.test("scope_miss", async () => {
    // 구글에서는 지웠는데 MI 삭제가 0건 — 이미 사라졌거나 범위 밖이다.
    const harness = tableCtx({
      schedule_items: [
        { data: deletableRow(), error: null },
        { data: null, error: null },
      ],
      owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
      audit_logs: [{ error: null }],
    });
    const { impl } = googleFetchMock({
      [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
      [`DELETE ${DELETE_EVENT_URL}`]: googleJson(204, {}),
    });

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-1",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.message, "삭제할 업무를 찾을 수 없습니다.");
    const attempts = deleteAttempts(harness.ops);
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].metadata,
      { outcome: "scope_miss", reason: "delete_no_match", googleSkipped: false, calendarId: DEDICATED });
  });

  await t.test("db_failed", async () => {
    // 구글 이벤트가 없는 행이라 구글은 건너뛴다(googleSkipped: true).
    const harness = tableCtx({
      schedule_items: [
        { data: deletableRow({ google_event_id: null }), error: null },
        { data: null, error: { code: "57014", message: "statement timeout" } },
      ],
      owner_google_calendar_sync: [{ data: catalogRows(), error: null }],
      audit_logs: [{ error: null }],
    });

    const response = await withGoogleEnv(null, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-1",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), harness.ctx));
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.equal(payload.message, "업무 삭제에 실패했습니다.");
    const attempts = deleteAttempts(harness.ops);
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].metadata,
      { outcome: "db_failed", reason: "57014", googleSkipped: true, calendarId: DEDICATED });
  });

  // 감사는 삭제 결과를 절대 바꾸지 않는다. 감사 테이블이 통째로 던져도
  // 대표님 화면에는 예전과 똑같은 성공이 보여야 한다.
  await t.test("감사 테이블이 던져도 응답은 그대로다", async () => {
    const harness = tableCtx({
      schedule_items: [
        { data: deletableRow(), error: null },
        { data: { id: "row-1" }, error: null },
      ],
      owner_google_integrations: [{ data: GOOGLE_INTEGRATION, error: null }],
    });
    const ctx = {
      supabaseAdmin: {
        ...harness.ctx.supabaseAdmin,
        from(table) {
          if (table === "audit_logs") throw new Error("audit table down");
          return harness.ctx.supabaseAdmin.from(table);
        },
      },
    };
    const { impl } = googleFetchMock({
      [`POST ${TOKEN_URL}`]: googleJson(200, { access_token: "gat-1" }),
      [`DELETE ${DELETE_EVENT_URL}`]: googleJson(204, {}),
    });

    const response = await withGoogleEnv(impl, () => handleWorkItemsRequest(workRequest("DELETE", {
      id: "row-1",
      expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
    }), ctx));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.auditLogged, false, "감사는 실패했다고 알리되 삭제는 성공이다");
    assert.equal(opsFor(harness.ops, "schedule_items", "delete").length, 1);
  });
});
