import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarPrincipal,
  calendarRoleCanEdit,
  handleWorkItemsRequest,
  normalizeCalendarAction,
  validIsoDate,
  workItemsDateRange,
} from "./work-items.mjs";

test("date-only schedule inputs and list bounds use Seoul calendar days", () => {
  assert.equal(validIsoDate("2026-08-15"), "2026-08-14T15:00:00.000Z");
  assert.equal(validIsoDate("2026-08-15T09:30"), "2026-08-15T00:30:00.000Z");
  assert.equal(validIsoDate("2026-02-30"), "");
  assert.equal(validIsoDate("2026-02-30T09:00"), "");
  assert.deepEqual(workItemsDateRange(new Request("https://insight.momentlabs.co.kr/api/work-items?from=2026-08-01&to=2026-08-31")), {
    from: "2026-07-31T15:00:00.000Z",
    toExclusive: "2026-08-31T15:00:00.000Z",
  });
  assert.deepEqual(workItemsDateRange(new Request("https://insight.momentlabs.co.kr/api/work-items?to=2026-08-31T23:59:00%2B09:00")), {
    from: "",
    toExclusive: "2026-08-31T14:59:00.000Z",
  });
});

test("calendar principal is derived only from the trusted session scope", () => {
  assert.deepEqual(calendarPrincipal({ role: "owner", ownerAgencyCode: "mml93-a01" }), {
    key: "owner:mml93-a01",
    displayName: "총관리자",
  });
  assert.deepEqual(calendarPrincipal({ role: "team", team: { id: "6c921a08-0eaa-43f4-a424-bdae7b93df4a", team_name: "콘텐츠팀" } }), {
    key: "team:6c921a08-0eaa-43f4-a424-bdae7b93df4a",
    displayName: "콘텐츠팀",
  });
  assert.equal(calendarPrincipal({ role: "client", client: { id: "client-1" } }), null);
});

test("bounded calendar GET reports truncation instead of silently hiding overflow", async () => {
  const rows = Array.from({ length: 201 }, (_, index) => managerRow({ id: `item-${index}` }));
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [], error: null } },
    { kind: "from", name: "schedule_items", result: { data: rows, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("GET"), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 200);
  assert.equal(payload.truncated, true);
  harness.done();
});

test("calendar edit permission excludes viewers", () => {
  assert.equal(calendarRoleCanEdit("owner"), true);
  assert.equal(calendarRoleCanEdit("editor"), true);
  assert.equal(calendarRoleCanEdit("viewer"), false);
});

test("calendar action accepts only the explicit action schemas", () => {
  assert.deepEqual(normalizeCalendarAction({ action: "calendar-create", name: "콘텐츠", color: "emerald" }), {
    ok: true,
    action: "calendar-create",
    value: { name: "콘텐츠", color: "emerald" },
  });
  assert.equal(normalizeCalendarAction({ action: "calendar-create", name: "콘텐츠", color: "emerald", owner: "attacker" }).ok, false);
  assert.equal(normalizeCalendarAction({ action: "calendar-invite-create", calendarId: "calendar-1", grantRole: "owner" }).ok, false);
  assert.equal(normalizeCalendarAction({ action: "calendar-invite-accept", code: "" }).ok, false);
  assert.equal(normalizeCalendarAction({ action: "calendar-create", name: "", color: "navy" }).ok, false);
  assert.equal(normalizeCalendarAction({ action: "calendar-create", name: "대표", color: "neon" }).ok, false);
  assert.equal(normalizeCalendarAction({ action: "calendar-leave", calendarId: "" }).ok, false);
});

test("calendar create returns only the safe membership projection", async () => {
  const calendarId = "33333333-3333-4333-8333-333333333333";
  const calendarRow = {
    id: calendarId,
    name: "대표 일정",
    color: "navy",
    owner_principal_key: "owner:mml93-a01",
    owner_agency_code: "mml93-a01",
    created_by_operation_team_id: null,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
  };
  const harness = scriptedCtx([
    { kind: "rpc", name: "mi_create_schedule_calendar", result: { data: calendarRow, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [{ role: "owner", revoked_at: null, calendar: calendarRow }], error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-create",
    name: "대표 일정",
    color: "navy",
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.calendar.id, calendarId);
  assert.equal(payload.calendar.role, "owner");
  assert.equal("owner_principal_key" in payload.calendar, false);
  assert.equal("owner_agency_code" in payload.calendar, false);
  assert.equal("created_by_operation_team_id" in payload.calendar, false);
  harness.done();
});

test("calendar invite persists only a one-use digest and never audits the raw code", async () => {
  const calendarId = "44444444-4444-4444-8444-444444444444";
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "owner", revoked_at: null, calendar: { id: calendarId, name: "대표 일정", color: "navy" } }, error: null } },
    { kind: "from", name: "schedule_calendar_invites", result: { data: { id: "invite-1", calendar_id: calendarId, grant_role: "editor", expires_at: "2026-08-21T00:00:00.000Z" }, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-invite-create",
    calendarId,
    grantRole: "editor",
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.match(payload.invite.code, /^[A-Za-z0-9_-]{22}$/u);
  const inserts = harness.calls.filter(([kind]) => kind === "insert").map(([, value]) => value);
  const inviteInsert = inserts.find((value) => value?.calendar_id === calendarId);
  const auditInsert = inserts.find((value) => value?.action === "schedule_calendar_invite_created");
  assert.match(inviteInsert.code_digest, /^[a-f0-9]{64}$/u);
  assert.equal("code" in inviteInsert, false);
  assert.equal(inviteInsert.max_uses, 1);
  assert.equal(JSON.stringify(auditInsert).includes(payload.invite.code), false);
  harness.done();
});

function queryBuilder(step, calls) {
  const builder = {};
  for (const method of ["select", "insert", "update", "delete", "eq", "is", "in", "or", "gte", "gt", "lte", "lt", "order", "limit"]) {
    builder[method] = (...args) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.maybeSingle = async () => step.result;
  builder.single = async () => step.result;
  builder.then = (resolve, reject) => Promise.resolve(step.result).then(resolve, reject);
  return builder;
}

function scriptedCtx(steps) {
  const queue = [...steps];
  const calls = [];
  return {
    calls,
    ctx: {
      supabaseAdmin: {
        from(table) {
          const step = queue.shift();
          assert.equal(step?.kind, "from");
          assert.equal(step?.name, table);
          calls.push(["from", table]);
          return queryBuilder(step, calls);
        },
        async rpc(name, args) {
          const step = queue.shift();
          assert.equal(step?.kind, "rpc");
          assert.equal(step?.name, name);
          calls.push(["rpc", name, args]);
          return step.result;
        },
      },
    },
    done() { assert.equal(queue.length, 0, `unused scripted steps: ${queue.length}`); },
  };
}

function ownerRequest(method, body) {
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

function clientRequest(method, body) {
  return new Request("https://insight.momentlabs.co.kr/api/work-items", {
    method,
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "client",
      "x-mi-agency-code": "client-a01",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function teamRequest(method, teamCode, body) {
  return new Request("https://insight.momentlabs.co.kr/api/work-items", {
    method,
    headers: {
      "content-type": "application/json",
      "x-mi-session-role": "team",
      "x-mi-team-code": teamCode,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function managerRow(overrides = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: null,
    operation_team_id: null,
    owner_agency_code: "mml93-a01",
    title: "급여 지급",
    schedule_type: "report_due",
    status: "planned",
    priority: "medium",
    starts_at: "2026-08-15T00:00:00.000Z",
    ends_at: "2026-08-15T01:00:00.000Z",
    visibility: "internal",
    is_all_day: false,
    calendar_id: null,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("monthly POST materializes one atomic finite series and keeps retry identity", async () => {
  const seriesId = "11111111-1111-4111-8111-111111111111";
  const saved = [
    managerRow({ series_id: seriesId, occurrence_on: "2026-08-15", recurrence_kind: "monthly", recurrence_until: "2026-10-15" }),
    managerRow({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", starts_at: "2026-09-15T00:00:00.000Z", ends_at: "2026-09-15T01:00:00.000Z", series_id: seriesId, occurrence_on: "2026-09-15", recurrence_kind: "monthly", recurrence_until: "2026-10-15" }),
    managerRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", starts_at: "2026-10-15T00:00:00.000Z", ends_at: "2026-10-15T01:00:00.000Z", series_id: seriesId, occurrence_on: "2026-10-15", recurrence_kind: "monthly", recurrence_until: "2026-10-15" }),
  ];
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: [], error: null } },
    { kind: "from", name: "schedule_items", result: { data: saved, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
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
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.items.length, 3);
  const insert = harness.calls.find(([kind]) => kind === "insert");
  assert.equal(insert[1].length, 3);
  assert.deepEqual(insert[1].map((row) => row.occurrence_on), ["2026-08-15", "2026-09-15", "2026-10-15"]);
  assert.equal(insert[1].every((row) => row.series_id === seriesId), true);
  harness.done();
});

test("concurrent monthly retries resolve the unique series race as unchanged", async () => {
  const seriesId = "11111111-1111-4111-8111-222222222222";
  const existing = [managerRow({ series_id: seriesId, occurrence_on: "2026-08-15", recurrence_kind: "monthly", recurrence_until: "2026-08-15" })];
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: [], error: null } },
    { kind: "from", name: "schedule_items", result: { data: null, error: { code: "23505", message: "duplicate key" } } },
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "급여 지급",
    scheduleType: "report_due",
    status: "planned",
    priority: "medium",
    startsAt: "2026-08-15T09:00:00+09:00",
    repeat: "monthly",
    repeatUntil: "2026-08-15",
    requestId: seriesId,
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.unchanged, true);
  assert.equal(payload.items.length, 1);
  harness.done();
});

test("viewer cannot create an event in a shared calendar", async () => {
  const calendarId = "22222222-2222-4222-8222-222222222222";
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "viewer", calendar: { id: calendarId, name: "공유", color: "navy" } }, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "공유 일정",
    scheduleType: "meeting",
    status: "planned",
    priority: "medium",
    startsAt: "2026-08-20T09:00:00+09:00",
    calendarId,
  }), harness.ctx);

  assert.equal(response.status, 403);
  assert.equal(harness.calls.filter(([kind]) => kind === "insert").length, 0);
  harness.done();
});

test("shared calendar creation uses the atomic editor RPC instead of a table insert", async () => {
  const calendarId = "66666666-6666-4666-8666-666666666666";
  const saved = managerRow({ calendar_id: calendarId, operation_team_id: null });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", calendar: { id: calendarId, name: "공유", color: "emerald" } }, error: null } },
    { kind: "rpc", name: "mi_insert_shared_schedule_items", result: { data: [saved], error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "공유 일정",
    scheduleType: "meeting",
    status: "planned",
    priority: "medium",
    startsAt: "2026-08-20T09:00:00+09:00",
    calendarId,
  }), harness.ctx);

  assert.equal(response.status, 201);
  assert.equal(harness.calls.some(([kind, name]) => kind === "rpc" && name === "mi_insert_shared_schedule_items"), true);
  assert.equal(harness.calls.some(([kind, table]) => kind === "from" && table === "schedule_items"), false);
  harness.done();
});

test("shared calendar update fails closed when membership is revoked before the atomic write", async () => {
  const calendarId = "77777777-7777-4777-8777-777777777777";
  const existing = managerRow({ calendar_id: calendarId, operation_team_id: null });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", calendar: { id: calendarId, name: "공유", color: "emerald" } }, error: null } },
    { kind: "rpc", name: "mi_update_shared_schedule_item", result: { data: null, error: { code: "42501", message: "calendar_edit_forbidden" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("PATCH", {
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
    title: existing.title,
    scheduleType: existing.schedule_type,
    status: "done",
    priority: existing.priority,
    startsAt: existing.starts_at,
    endsAt: existing.ends_at,
    calendarId,
  }), harness.ctx);

  assert.equal(response.status, 403);
  assert.equal(harness.calls.some(([kind, name]) => kind === "rpc" && name === "mi_update_shared_schedule_item"), true);
  harness.done();
});

test("shared assistant completion also fails closed after membership revocation", async () => {
  const calendarId = "88888888-8888-4888-8888-888888888888";
  const existing = managerRow({ calendar_id: calendarId, operation_team_id: null });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", calendar: { id: calendarId, name: "공유", color: "emerald" } }, error: null } },
    { kind: "rpc", name: "mi_update_shared_schedule_item", result: { data: null, error: { code: "42501", message: "calendar_edit_forbidden" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("PATCH", {
    action: "assistant-complete",
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
  }), harness.ctx);

  assert.equal(response.status, 403);
  assert.equal(harness.calls.some(([kind, name]) => kind === "rpc" && name === "mi_update_shared_schedule_item"), true);
  harness.done();
});

test("shared calendar delete uses the atomic editor RPC and optimistic timestamp", async () => {
  const calendarId = "99999999-9999-4999-8999-999999999999";
  const existing = managerRow({ calendar_id: calendarId, operation_team_id: null });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", calendar: { id: calendarId, name: "공유", color: "emerald" } }, error: null } },
    { kind: "rpc", name: "mi_delete_shared_schedule_item", result: { data: existing.id, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
  }), harness.ctx);

  assert.equal(response.status, 200);
  const call = harness.calls.find(([kind, name]) => kind === "rpc" && name === "mi_delete_shared_schedule_item");
  assert.equal(call[2].p_calendar_id, calendarId);
  assert.equal(call[2].p_expected_updated_at, existing.updated_at);
  assert.equal(harness.calls.some(([kind]) => kind === "delete"), false);
  harness.done();
});

test("general PATCH uses optimistic lock and exact original tenant scope", async () => {
  const original = managerRow();
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: original, error: null } },
    { kind: "from", name: "schedule_items", result: { data: null, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("PATCH", {
    id: original.id,
    expectedUpdatedAt: original.updated_at,
    title: original.title,
    scheduleType: original.schedule_type,
    status: "done",
    priority: original.priority,
    startsAt: original.starts_at,
    endsAt: original.ends_at,
    calendarId: "",
  }), harness.ctx);

  assert.equal(response.status, 409);
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "eq" && column === "updated_at" && value === original.updated_at));
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "eq" && column === "owner_agency_code" && value === "mml93-a01"));
  assert.ok(harness.calls.some(([kind, column]) => kind === "is" && column === "calendar_id"));
  assert.equal(harness.calls.filter(([kind, table]) => kind === "from" && table === "audit_logs").length, 0);
  harness.done();
});

test("moving one recurring occurrence updates its Seoul occurrence key atomically", async () => {
  const existing = managerRow({
    series_id: "55555555-5555-4555-8555-555555555555",
    occurrence_on: "2026-08-15",
    recurrence_kind: "monthly",
    recurrence_until: "2026-10-15",
  });
  const moved = { ...existing, starts_at: "2026-09-20T00:00:00.000Z", ends_at: "2026-09-20T01:00:00.000Z", occurrence_on: "2026-09-20" };
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
    { kind: "from", name: "schedule_items", result: { data: moved, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("PATCH", {
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
    title: existing.title,
    scheduleType: existing.schedule_type,
    status: existing.status,
    priority: existing.priority,
    startsAt: "2026-09-20T09:00:00+09:00",
    endsAt: "2026-09-20T10:00:00+09:00",
    calendarId: "",
  }), harness.ctx);

  assert.equal(response.status, 200);
  const update = harness.calls.find(([kind]) => kind === "update");
  assert.equal(update[1].occurrence_on, "2026-09-20");
  harness.done();
});

test("client cannot complete a public legacy schedule through the assistant action", async () => {
  const existing = managerRow({
    client_id: "client-1",
    visibility: "client_visible",
    public_title: "공개 일정",
  });
  const harness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: { id: "client-1", name: "광고주", agency_code: "client-a01", status: "active" }, error: null } },
  ]);
  const response = await handleWorkItemsRequest(clientRequest("PATCH", {
    action: "assistant-complete",
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
  }), harness.ctx);

  assert.equal(response.status, 403);
  assert.equal(harness.calls.filter(([kind, table]) => kind === "from" && table === "schedule_items").length, 0);
  harness.done();
});

test("calendar GET merges visible shared rows, de-duplicates ids, and applies the requested date window", async () => {
  const calendarId = "12121212-1212-4212-8212-121212121212";
  const duplicate = managerRow({
    id: "deduped-item",
    starts_at: "2026-08-12T00:00:00.000Z",
    calendar_id: calendarId,
    calendar: { id: calendarId, name: "공유 일정", color: "emerald" },
  });
  const harness = scriptedCtx([
    {
      kind: "from",
      name: "schedule_calendar_memberships",
      result: {
        data: [{
          role: "editor",
          revoked_at: null,
          calendar: [{
            id: calendarId,
            name: "공유 일정",
            color: "emerald",
            archived_at: null,
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-01T00:00:00.000Z",
          }],
        }],
        error: null,
      },
    },
    { kind: "from", name: "schedule_items", result: { data: [managerRow({ id: "legacy-later", starts_at: "2026-08-20T00:00:00.000Z" }), duplicate], error: null } },
    { kind: "from", name: "schedule_items", result: { data: [duplicate, managerRow({ id: "shared-first", starts_at: "2026-08-02T00:00:00.000Z", calendar_id: calendarId })], error: null } },
  ]);
  const request = new Request("https://insight.momentlabs.co.kr/api/work-items?from=2026-08-01&to=2026-08-31&limit=2", {
    headers: { "x-mi-session-role": "owner", "x-mi-owner-agency-code": "mml93-a01" },
  });
  const response = await handleWorkItemsRequest(request, harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.items.map((item) => item.id), ["shared-first", "deduped-item"]);
  assert.equal(payload.truncated, true);
  assert.deepEqual(payload.calendars[0], {
    id: calendarId,
    name: "공유 일정",
    color: "emerald",
    role: "editor",
    isOwner: false,
    shared: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "in" && column === "calendar_id" && value[0] === calendarId));
  assert.equal(harness.calls.filter(([kind]) => kind === "gte").length, 2);
  assert.equal(harness.calls.filter(([kind]) => kind === "lt").length, 2);
  harness.done();
});

test("calendar GET fails closed when memberships cannot be loaded", async () => {
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: null, error: { message: "membership unavailable" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("GET"), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.detail, "membership unavailable");
  harness.done();
});

test("calendar GET ignores archived memberships and surfaces shared-query failures", async () => {
  const calendarId = "31313131-3131-4131-8131-313131313131";
  const harness = scriptedCtx([
    {
      kind: "from",
      name: "schedule_calendar_memberships",
      result: {
        data: [
          { role: "owner", calendar: { id: "archived", name: "보관", archived_at: "2026-08-01T00:00:00.000Z" } },
          { role: "editor", calendar: { id: calendarId, name: "공유", color: "navy", archived_at: null } },
        ],
        error: null,
      },
    },
    { kind: "from", name: "schedule_items", result: { data: [], error: null } },
    { kind: "from", name: "schedule_items", result: { data: null, error: { message: "shared query failed" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("GET"), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.detail, "shared query failed");
  assert.ok(harness.calls.some(([kind, column, ids]) => kind === "in" && column === "calendar_id" && ids.length === 1 && ids[0] === calendarId));
  harness.done();
});

test("advertisers cannot use calendar connection actions", async () => {
  const harness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: { id: "client-1", name: "광고주", agency_code: "client-a01", status: "active" }, error: null } },
  ]);
  const response = await handleWorkItemsRequest(clientRequest("POST", {
    action: "calendar-create",
    name: "금지된 일정표",
    color: "navy",
  }), harness.ctx);

  assert.equal(response.status, 403);
  assert.equal(harness.calls.some(([kind]) => kind === "rpc"), false);
  harness.done();
});

test("calendar create surfaces RPC failure without auditing", async () => {
  const harness = scriptedCtx([
    { kind: "rpc", name: "mi_create_schedule_calendar", result: { data: null, error: { message: "create failed" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-create",
    name: "대표 일정",
    color: "navy",
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.detail, "create failed");
  assert.equal(harness.calls.some(([kind, table]) => kind === "from" && table === "audit_logs"), false);
  harness.done();
});

test("calendar create has a safe fallback when the membership refresh is briefly empty", async () => {
  const calendarId = "30303030-3030-4030-8030-303030303030";
  const harness = scriptedCtx([
    { kind: "rpc", name: "mi_create_schedule_calendar", result: { data: [{ calendar_id: calendarId, created_at: "2026-08-20T01:00:00.000Z", updated_at: "2026-08-20T01:00:00.000Z" }], error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [], error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-create",
    name: "방금 만든 일정",
    color: "sky",
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(payload.calendar, {
    id: calendarId,
    name: "방금 만든 일정",
    color: "sky",
    role: "owner",
    isOwner: true,
    shared: false,
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T01:00:00.000Z",
  });
  harness.done();
});

test("only a current calendar owner can create an invite", async () => {
  const calendarId = "13131313-1313-4313-8313-131313131313";
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", revoked_at: null, calendar: { id: calendarId, name: "공유", color: "navy" } }, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-invite-create",
    calendarId,
    grantRole: "viewer",
  }), harness.ctx);

  assert.equal(response.status, 403);
  assert.equal(harness.calls.some(([kind, table]) => kind === "from" && table === "schedule_calendar_invites"), false);
  harness.done();
});

test("invite creation reports storage errors without returning a raw code", async () => {
  const calendarId = "14141414-1414-4414-8414-141414141414";
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "owner", revoked_at: null, calendar: { id: calendarId, name: "대표", color: "navy" } }, error: null } },
    { kind: "from", name: "schedule_calendar_invites", result: { data: null, error: { message: "invite insert failed" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-invite-create",
    calendarId,
    grantRole: "editor",
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.detail, "invite insert failed");
  assert.equal("invite" in payload, false);
  harness.done();
});

test("valid one-use invite joins a shared calendar and refreshes membership", async () => {
  const calendarId = "15151515-1515-4515-8515-151515151515";
  const code = "ABCDEFGHIJKLMNOPQRSTUV";
  const calendar = {
    id: calendarId,
    name: "파트너 일정",
    color: "violet",
    archived_at: null,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
  };
  const harness = scriptedCtx([
    { kind: "rpc", name: "consume_code_login_rate_limit", result: { data: { allowed: true, retry_after: 0 }, error: null } },
    { kind: "rpc", name: "consume_code_login_rate_limit", result: { data: [{ allowed: true, retry_after: 0 }], error: null } },
    { kind: "rpc", name: "mi_accept_schedule_calendar_invite", result: { data: { status: "joined", calendar_id: calendarId }, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [{ role: "viewer", revoked_at: null, calendar }], error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-invite-accept",
    code,
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.unchanged, false);
  assert.equal(payload.calendars[0].id, calendarId);
  const accept = harness.calls.find(([kind, name]) => kind === "rpc" && name === "mi_accept_schedule_calendar_invite");
  assert.match(accept[2].p_code_digest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(harness.calls).includes(code), false);
  harness.done();
});

test("already-used membership response is idempotent", async () => {
  const calendarId = "16161616-1616-4616-8616-161616161616";
  const harness = scriptedCtx([
    { kind: "rpc", name: "consume_code_login_rate_limit", result: { data: { allowed: true }, error: null } },
    { kind: "rpc", name: "consume_code_login_rate_limit", result: { data: { allowed: true }, error: null } },
    { kind: "rpc", name: "mi_accept_schedule_calendar_invite", result: { data: [{ status: "already_member", calendarId }], error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [], error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-invite-accept",
    code: "ZYXWVUTSRQPONMLKJIHGFE",
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.unchanged, true);
  assert.match(payload.message, /이미 연결/);
  harness.done();
});

test("invite acceptance rate limit returns retry-after and does not consume the invite", async () => {
  const harness = scriptedCtx([
    { kind: "rpc", name: "consume_code_login_rate_limit", result: { data: { allowed: false, retry_after: 37 }, error: null } },
    { kind: "rpc", name: "consume_code_login_rate_limit", result: { data: { allowed: true, retry_after: 0 }, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-invite-accept",
    code: "RATE123456789012345678",
  }), harness.ctx);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "37");
  assert.equal(harness.calls.some(([kind, name]) => kind === "rpc" && name === "mi_accept_schedule_calendar_invite"), false);
  harness.done();
});

test("invalid or expired invite is rejected after durable rate checks", async () => {
  const harness = scriptedCtx([
    { kind: "rpc", name: "consume_code_login_rate_limit", result: { data: { allowed: true }, error: null } },
    { kind: "rpc", name: "consume_code_login_rate_limit", result: { data: { allowed: true }, error: null } },
    { kind: "rpc", name: "mi_accept_schedule_calendar_invite", result: { data: { status: "expired" }, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    action: "calendar-invite-accept",
    code: "EXPIRED123456789012345",
  }), harness.ctx);

  assert.equal(response.status, 400);
  harness.done();
});

test("calendar owner cannot leave their own calendar", async () => {
  const calendarId = "17171717-1717-4717-8717-171717171717";
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "owner", revoked_at: null, calendar: { id: calendarId, name: "대표", color: "navy" } }, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", { action: "calendar-leave", calendarId }), harness.ctx);

  assert.equal(response.status, 409);
  assert.equal(harness.calls.some(([kind]) => kind === "update"), false);
  harness.done();
});

test("shared calendar leave is optimistic and refreshes the remaining calendars", async () => {
  const calendarId = "18181818-1818-4818-8818-181818181818";
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "viewer", revoked_at: null, calendar: { id: calendarId, name: "공유", color: "sky" } }, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { calendar_id: calendarId }, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [], error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", { action: "calendar-leave", calendarId }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.calendars, []);
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "eq" && column === "role" && value === "viewer"));
  harness.done();
});

test("calendar leave detects a concurrent membership change", async () => {
  const calendarId = "19191919-1919-4919-8919-191919191919";
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", revoked_at: null, calendar: { id: calendarId, name: "공유", color: "amber" } }, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: null, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", { action: "calendar-leave", calendarId }), harness.ctx);

  assert.equal(response.status, 409);
  harness.done();
});

test("POST validates calendar ids, repeat modes, and monthly request identity before writing", async () => {
  const invalidCalendar = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "일정",
    scheduleType: "meeting",
    startsAt: "2026-08-20T09:00:00+09:00",
    calendarId: "not-a-uuid",
  }), scriptedCtx([]).ctx);
  assert.equal(invalidCalendar.status, 400);

  const invalidRepeat = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "일정",
    scheduleType: "meeting",
    startsAt: "2026-08-20T09:00:00+09:00",
    repeat: "weekly",
  }), scriptedCtx([]).ctx);
  assert.equal(invalidRepeat.status, 400);

  const missingRequestId = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "일정",
    scheduleType: "meeting",
    startsAt: "2026-08-20T09:00:00+09:00",
    repeat: "monthly",
    repeatUntil: "2026-10-20",
  }), scriptedCtx([]).ctx);
  assert.equal(missingRequestId.status, 400);
});

test("monthly retry returns the pre-existing finite series without inserting", async () => {
  const seriesId = "20202020-2020-4020-8020-202020202020";
  const existing = [managerRow({ series_id: seriesId, occurrence_on: "2026-08-20", recurrence_kind: "monthly", recurrence_until: "2026-09-20" })];
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "월간 정산",
    scheduleType: "report_due",
    startsAt: "2026-08-20T09:00:00+09:00",
    repeat: "monthly",
    repeatUntil: "2026-09-20",
    requestId: seriesId,
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.unchanged, true);
  assert.equal(harness.calls.some(([kind]) => kind === "insert"), false);
  harness.done();
});

test("shared POST fails closed if editor membership is revoked at the atomic write", async () => {
  const calendarId = "21212121-2121-4121-8121-212121212121";
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", revoked_at: null, calendar: { id: calendarId, name: "공유", color: "navy" } }, error: null } },
    { kind: "rpc", name: "mi_insert_shared_schedule_items", result: { data: null, error: { code: "42501", message: "calendar_edit_forbidden" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "공유 일정",
    scheduleType: "meeting",
    startsAt: "2026-08-20T09:00:00+09:00",
    calendarId,
  }), harness.ctx);

  assert.equal(response.status, 403);
  harness.done();
});

test("recurring occurrence cannot move beyond the inclusive series end", async () => {
  const existing = managerRow({
    series_id: "23232323-2323-4323-8323-232323232323",
    occurrence_on: "2026-08-20",
    recurrence_kind: "monthly",
    recurrence_until: "2026-09-20",
  });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("PATCH", {
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
    title: existing.title,
    scheduleType: existing.schedule_type,
    status: existing.status,
    priority: existing.priority,
    startsAt: "2026-10-20T09:00:00+09:00",
  }), harness.ctx);

  assert.equal(response.status, 409);
  assert.equal(harness.calls.some(([kind]) => kind === "update"), false);
  harness.done();
});

test("PATCH rejects moving an item to another calendar and duplicate recurrence dates", async () => {
  const existing = managerRow({
    series_id: "24242424-2424-4424-8424-242424242424",
    occurrence_on: "2026-08-20",
    recurrence_kind: "monthly",
    recurrence_until: "2026-10-20",
  });
  const moveHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
  ]);
  const moved = await handleWorkItemsRequest(ownerRequest("PATCH", {
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
    title: existing.title,
    scheduleType: existing.schedule_type,
    status: existing.status,
    priority: existing.priority,
    startsAt: existing.starts_at,
    calendarId: "25252525-2525-4525-8525-252525252525",
  }), moveHarness.ctx);
  assert.equal(moved.status, 409);
  moveHarness.done();

  const duplicateHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
    { kind: "from", name: "schedule_items", result: { data: null, error: { code: "23505", message: "duplicate" } } },
  ]);
  const duplicate = await handleWorkItemsRequest(ownerRequest("PATCH", {
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
    title: existing.title,
    scheduleType: existing.schedule_type,
    status: existing.status,
    priority: existing.priority,
    startsAt: "2026-09-20T09:00:00+09:00",
  }), duplicateHarness.ctx);
  assert.equal(duplicate.status, 409);
  duplicateHarness.done();
});

test("DELETE validates input and rejects stale state before mutation", async () => {
  const unexpected = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: "item-1",
    expectedUpdatedAt: "2026-08-20T00:00:00.000Z",
    calendarId: "unexpected",
  }), scriptedCtx([]).ctx);
  assert.equal(unexpected.status, 400);

  const existing = managerRow();
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
  ]);
  const stale = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: existing.id,
    expectedUpdatedAt: "2026-08-19T00:00:00.000Z",
  }), harness.ctx);
  assert.equal(stale.status, 409);
  assert.equal(harness.calls.some(([kind]) => kind === "delete"), false);
  harness.done();
});

test("legacy DELETE keeps exact tenant scope and records an audit", async () => {
  const existing = managerRow({ client_id: "client-1", operation_team_id: "team-1" });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
    { kind: "from", name: "schedule_items", result: { data: { id: existing.id }, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: existing.id,
    expectedUpdatedAt: existing.updated_at,
  }), harness.ctx);

  assert.equal(response.status, 200);
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "eq" && column === "client_id" && value === "client-1"));
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "eq" && column === "operation_team_id" && value === "team-1"));
  harness.done();
});

test("unsupported methods return a bounded 405 response", async () => {
  const response = await handleWorkItemsRequest(ownerRequest("PUT"), scriptedCtx([]).ctx);
  const payload = await response.json();

  assert.equal(response.status, 405);
  assert.deepEqual(payload.allowed, ["GET", "POST", "PATCH", "DELETE"]);
});

test("request scope rejects missing sessions and forged owner identity before database access", async () => {
  const anonymous = await handleWorkItemsRequest(new Request("https://insight.momentlabs.co.kr/api/work-items"), scriptedCtx([]).ctx);
  assert.equal(anonymous.status, 401);

  const forged = await handleWorkItemsRequest(new Request("https://insight.momentlabs.co.kr/api/work-items", {
    headers: { "x-mi-session-role": "owner", "x-mi-owner-agency-code": "attacker-a01" },
  }), scriptedCtx([]).ctx);
  assert.equal(forged.status, 403);
});

test("owner advertiser scope resolves its operation team and publishes only that tenant range", async () => {
  const client = {
    id: "client-target",
    name: "대상 광고주",
    business_name: "대상 사업자",
    agency_code: "target-a01",
    status: "active",
    issued_by_team_code: "team-target",
  };
  const team = { id: "team-target-id", owner_agency_code: "mml93-a01", team_code: "team-target", team_name: "대상팀", client_id: client.id };
  const harness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: client, error: null } },
    { kind: "from", name: "operation_team_codes", result: { data: team, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [], error: null } },
    { kind: "from", name: "schedule_items", result: { data: [managerRow({ client_id: client.id, operation_team_id: team.id })], error: null } },
  ]);
  const request = new Request("https://insight.momentlabs.co.kr/api/work-items", {
    headers: {
      "x-mi-session-role": "owner",
      "x-mi-owner-agency-code": "mml93-a01",
      "x-mi-agency-code": "target-a01",
    },
  });
  const response = await handleWorkItemsRequest(request, harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.canPublish, true);
  assert.deepEqual(payload.client, { id: client.id, name: client.name });
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "eq" && column === "client_id" && value === client.id));
  harness.done();
});

test("owner advertiser scope reports client and team lookup failures precisely", async () => {
  const headers = {
    "x-mi-session-role": "owner",
    "x-mi-owner-agency-code": "mml93-a01",
    "x-mi-agency-code": "target-a01",
  };

  const clientErrorHarness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: null, error: { message: "client lookup failed" } } },
  ]);
  const clientError = await handleWorkItemsRequest(new Request("https://insight.momentlabs.co.kr/api/work-items", { headers }), clientErrorHarness.ctx);
  assert.equal(clientError.status, 500);
  clientErrorHarness.done();

  const missingHarness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: null, error: null } },
  ]);
  const missing = await handleWorkItemsRequest(new Request("https://insight.momentlabs.co.kr/api/work-items", { headers }), missingHarness.ctx);
  assert.equal(missing.status, 404);
  missingHarness.done();

  const teamErrorHarness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: { id: "client-target", agency_code: "target-a01", issued_by_team_code: "team-target" }, error: null } },
    { kind: "from", name: "operation_team_codes", result: { data: null, error: { message: "team lookup failed" } } },
  ]);
  const teamError = await handleWorkItemsRequest(new Request("https://insight.momentlabs.co.kr/api/work-items", { headers }), teamErrorHarness.ctx);
  assert.equal(teamError.status, 500);
  teamErrorHarness.done();
});

test("operation team scope supports connected and account-only teams without widening tenant access", async () => {
  const connectedTeam = { id: "team-1", owner_agency_code: "mml93-a01", team_code: "ops-1", team_name: "운영팀", client_id: "client-1" };
  const client = { id: "client-1", name: "광고주", agency_code: "client-a01", status: "active" };
  const connectedHarness = scriptedCtx([
    { kind: "from", name: "operation_team_codes", result: { data: connectedTeam, error: null } },
    { kind: "from", name: "clients", result: { data: client, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [], error: null } },
    { kind: "from", name: "schedule_items", result: { data: [managerRow({ client_id: client.id, operation_team_id: connectedTeam.id })], error: null } },
  ]);
  const connected = await handleWorkItemsRequest(teamRequest("GET", "ops-1"), connectedHarness.ctx);
  const connectedPayload = await connected.json();
  assert.equal(connected.status, 200);
  assert.equal(connectedPayload.canPublish, true);
  assert.ok(connectedHarness.calls.some(([kind, filter]) => kind === "or" && filter.includes("operation_team_id.eq.team-1")));
  connectedHarness.done();

  const accountTeam = { id: "team-2", owner_agency_code: "mml93-a01", team_code: "ops-2", team_name: "계정팀", client_id: null };
  const accountHarness = scriptedCtx([
    { kind: "from", name: "operation_team_codes", result: { data: accountTeam, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: [], error: null } },
    { kind: "from", name: "schedule_items", result: { data: [managerRow({ operation_team_id: accountTeam.id })], error: null } },
  ]);
  const account = await handleWorkItemsRequest(teamRequest("GET", "ops-2"), accountHarness.ctx);
  const accountPayload = await account.json();
  assert.equal(account.status, 200);
  assert.equal(accountPayload.canPublish, false);
  assert.ok(accountHarness.calls.some(([kind, column, value]) => kind === "eq" && column === "operation_team_id" && value === accountTeam.id));
  accountHarness.done();
});

test("operation team scope fails closed on team and linked-client lookup errors", async () => {
  const teamErrorHarness = scriptedCtx([
    { kind: "from", name: "operation_team_codes", result: { data: null, error: { message: "team unavailable" } } },
  ]);
  const teamError = await handleWorkItemsRequest(teamRequest("GET", "ops-error"), teamErrorHarness.ctx);
  assert.equal(teamError.status, 500);
  teamErrorHarness.done();

  const missingHarness = scriptedCtx([
    { kind: "from", name: "operation_team_codes", result: { data: null, error: null } },
  ]);
  const missing = await handleWorkItemsRequest(teamRequest("GET", "ops-missing"), missingHarness.ctx);
  assert.equal(missing.status, 404);
  missingHarness.done();

  const clientErrorHarness = scriptedCtx([
    { kind: "from", name: "operation_team_codes", result: { data: { id: "team-1", owner_agency_code: "mml93-a01", client_id: "client-1" }, error: null } },
    { kind: "from", name: "clients", result: { data: null, error: { message: "linked client unavailable" } } },
  ]);
  const clientError = await handleWorkItemsRequest(teamRequest("GET", "ops-client-error"), clientErrorHarness.ctx);
  assert.equal(clientError.status, 500);
  clientErrorHarness.done();

  const blankTeam = await handleWorkItemsRequest(teamRequest("GET", ""), scriptedCtx([]).ctx);
  assert.equal(blankTeam.status, 404);
});

test("advertiser GET returns only the public payload and uses no shared-calendar principal", async () => {
  const publicRow = managerRow({
    client_id: "client-1",
    title: "내부 제목",
    public_title: "공개 제목",
    public_comment: "공개 안내",
    visibility: "client_visible",
  });
  const harness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: { id: "client-1", name: "광고주", agency_code: "client-a01", status: "active" }, error: null } },
    { kind: "from", name: "schedule_items", result: { data: [publicRow], error: null } },
  ]);
  const response = await handleWorkItemsRequest(clientRequest("GET"), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.items[0].title, "공개 제목");
  assert.equal(JSON.stringify(payload).includes("내부 제목"), false);
  assert.deepEqual(payload.calendars, []);
  assert.ok(harness.calls.some(([kind, column, value]) => kind === "eq" && column === "visibility" && value === "client_visible"));
  harness.done();
});

test("advertiser access reports lookup error and inactive code separately", async () => {
  const errorHarness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: null, error: { message: "client unavailable" } } },
  ]);
  const errorResponse = await handleWorkItemsRequest(clientRequest("GET"), errorHarness.ctx);
  assert.equal(errorResponse.status, 500);
  errorHarness.done();

  const missingHarness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: null, error: null } },
  ]);
  const missingResponse = await handleWorkItemsRequest(clientRequest("GET"), missingHarness.ctx);
  assert.equal(missingResponse.status, 404);
  missingHarness.done();

  const blankCode = await handleWorkItemsRequest(new Request("https://insight.momentlabs.co.kr/api/work-items", {
    headers: { "x-mi-session-role": "client" },
  }), scriptedCtx([]).ctx);
  assert.equal(blankCode.status, 404);
});

test("advertiser cannot create ordinary work items", async () => {
  const harness = scriptedCtx([
    { kind: "from", name: "clients", result: { data: { id: "client-1", name: "광고주", agency_code: "client-a01", status: "active" }, error: null } },
  ]);
  const response = await handleWorkItemsRequest(clientRequest("POST", {
    title: "직접 등록 시도",
    scheduleType: "meeting",
    startsAt: "2026-08-20T09:00:00+09:00",
  }), harness.ctx);
  assert.equal(response.status, 403);
  harness.done();
});

test("legacy POST returns storage errors and succeeds with a bounded internal row", async () => {
  const body = {
    title: "내부 일정",
    scheduleType: "meeting",
    status: "planned",
    priority: "low",
    startsAt: "2026-08-20T09:00:00+09:00",
  };
  const errorHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: null, error: { message: "insert unavailable" } } },
  ]);
  const failed = await handleWorkItemsRequest(ownerRequest("POST", body), errorHarness.ctx);
  assert.equal(failed.status, 500);
  errorHarness.done();

  const saved = managerRow({ priority: "low" });
  const successHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: [saved], error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const success = await handleWorkItemsRequest(ownerRequest("POST", body), successHarness.ctx);
  const payload = await success.json();
  assert.equal(success.status, 201);
  assert.equal(payload.message, "업무를 저장했습니다.");
  assert.equal(payload.items.length, 1);
  successHarness.done();
});

test("POST rejects an end time before the start without touching storage", async () => {
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "역전 일정",
    scheduleType: "meeting",
    startsAt: "2026-08-20T10:00:00+09:00",
    endsAt: "2026-08-20T09:00:00+09:00",
  }), scriptedCtx([]).ctx);

  assert.equal(response.status, 400);
});

test("team may mutate an unassigned legacy row only through its linked client scope", async () => {
  const team = { id: "team-linked", owner_agency_code: "mml93-a01", team_code: "ops-linked", team_name: "운영팀", client_id: "client-linked" };
  const client = { id: "client-linked", name: "연결 광고주", agency_code: "linked-a01", status: "active" };
  const existing = managerRow({ client_id: client.id, operation_team_id: null });
  const harness = scriptedCtx([
    { kind: "from", name: "operation_team_codes", result: { data: team, error: null } },
    { kind: "from", name: "clients", result: { data: client, error: null } },
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
  ]);
  const response = await handleWorkItemsRequest(teamRequest("PATCH", team.team_code, {
    id: existing.id,
    expectedUpdatedAt: "2026-08-19T00:00:00.000Z",
    title: existing.title,
    scheduleType: existing.schedule_type,
    startsAt: existing.starts_at,
  }), harness.ctx);

  assert.equal(response.status, 409);
  harness.done();
});

test("PATCH rejects stale state and shared duplicate occurrence without audit", async () => {
  const staleRow = managerRow();
  const staleHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: staleRow, error: null } },
  ]);
  const stale = await handleWorkItemsRequest(ownerRequest("PATCH", {
    id: staleRow.id,
    expectedUpdatedAt: "2026-08-19T00:00:00.000Z",
    title: staleRow.title,
    scheduleType: staleRow.schedule_type,
    startsAt: staleRow.starts_at,
  }), staleHarness.ctx);
  assert.equal(stale.status, 409);
  staleHarness.done();

  const calendarId = "26262626-2626-4626-8626-262626262626";
  const shared = managerRow({ calendar_id: calendarId, series_id: "27272727-2727-4727-8727-272727272727", recurrence_until: "2026-10-20" });
  const duplicateHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: shared, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", calendar: { id: calendarId, name: "공유", color: "navy" } }, error: null } },
    { kind: "rpc", name: "mi_update_shared_schedule_item", result: { data: null, error: { code: "23505", message: "duplicate" } } },
  ]);
  const duplicate = await handleWorkItemsRequest(ownerRequest("PATCH", {
    id: shared.id,
    expectedUpdatedAt: shared.updated_at,
    title: shared.title,
    scheduleType: shared.schedule_type,
    status: shared.status,
    priority: shared.priority,
    startsAt: shared.starts_at,
    calendarId,
  }), duplicateHarness.ctx);
  assert.equal(duplicate.status, 409);
  duplicateHarness.done();
});

test("shared DELETE fails closed when edit permission changes at the atomic mutation", async () => {
  const calendarId = "28282828-2828-4828-8828-282828282828";
  const shared = managerRow({ calendar_id: calendarId });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: shared, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", calendar: { id: calendarId, name: "공유", color: "navy" } }, error: null } },
    { kind: "rpc", name: "mi_delete_shared_schedule_item", result: { data: null, error: { code: "42501", message: "calendar_edit_forbidden" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: shared.id,
    expectedUpdatedAt: shared.updated_at,
  }), harness.ctx);

  assert.equal(response.status, 403);
  harness.done();
});

test("shared DELETE recognizes a permission failure by its stable database message", async () => {
  const calendarId = "32323232-3232-4232-8232-323232323232";
  const shared = managerRow({ calendar_id: calendarId });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: shared, error: null } },
    { kind: "from", name: "schedule_calendar_memberships", result: { data: { role: "editor", calendar: { id: calendarId, name: "공유", color: "navy" } }, error: null } },
    { kind: "rpc", name: "mi_delete_shared_schedule_item", result: { data: null, error: { code: "P0001", message: "calendar_edit_forbidden" } } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: shared.id,
    expectedUpdatedAt: shared.updated_at,
  }), harness.ctx);

  assert.equal(response.status, 403);
  harness.done();
});
