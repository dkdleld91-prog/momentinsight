import test from "node:test";
import assert from "node:assert/strict";
import {
  handleWorkItemsRequest,
  validIsoDate,
  workItemsDateRange,
} from "./work-items.mjs";

// 이 스위트는 레거시/개인 캘린더 계약을 검증하므로 "구글 미연동" 분기에 고정한다.
// Vercel 프로덕션 빌드는 GOOGLE_OAUTH_* 가 실린 채 테스트를 돌리는데, 그러면
// 구글 우선 경로가 켜지면서 스크립트되지 않은 연동 조회가 끼어들어 여기서
// 검증하려던 대상 자체가 바뀐다. 모듈 로드 시점에 지우고 종료 때 되돌린다.
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

test("bounded calendar GET reports truncation instead of silently hiding overflow", async () => {
  const rows = Array.from({ length: 201 }, (_, index) => managerRow({ id: `item-${index}` }));
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: rows, error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("GET"), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 200);
  assert.equal(payload.truncated, true);
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

function observingCtx({ tables = {}, rpcs = {} } = {}) {
  const calls = [];
  const tableQueues = Object.fromEntries(Object.entries(tables).map(([name, results]) => [name, [...results]]));
  const rpcQueues = Object.fromEntries(Object.entries(rpcs).map(([name, results]) => [name, [...results]]));
  return {
    calls,
    ctx: {
      supabaseAdmin: {
        from(table) {
          calls.push(["from", table]);
          const result = tableQueues[table]?.shift() || { data: null, error: null };
          return queryBuilder({ result }, calls);
        },
        async rpc(name, args) {
          calls.push(["rpc", name, args]);
          return rpcQueues[name]?.shift() || { data: null, error: null };
        },
      },
    },
  };
}

// delete() 이후 다음 from() 전까지가 그 삭제 질의에 걸린 조건이다.
function deleteFilters(calls) {
  const start = calls.findIndex(([kind]) => kind === "delete");
  if (start < 0) return [];
  const rest = calls.slice(start + 1);
  const end = rest.findIndex(([kind]) => kind === "from");
  return (end < 0 ? rest : rest.slice(0, end)).filter(([kind]) => kind === "eq" || kind === "is");
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

test("monthly no-end POST stores intent and an exact 60-occurrence materialized horizon", async () => {
  const seriesId = "11111111-1111-4111-8111-333333333333";
  const saved = Array.from({ length: 60 }, (_, index) => managerRow({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-333333333333`,
    series_id: seriesId,
    occurrence_on: index === 59 ? "2030-12-15" : "2026-08-15",
    recurrence_kind: "monthly",
    recurrence_until: "2030-12-15",
    recurrence_no_end: true,
  }));
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
    startsAt: "2026-01-15T09:00:00+09:00",
    endsAt: "2026-01-15T10:00:00+09:00",
    repeat: "monthly",
    repeatNoEnd: true,
    repeatUntil: "",
    requestId: seriesId,
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.items.length, 60);
  assert.equal(payload.item.repeatNoEnd, true);
  assert.equal(payload.item.repeatUntil, null);
  assert.equal(payload.item.materializedUntil, "2030-12-15");
  const insert = harness.calls.find(([kind]) => kind === "insert");
  assert.equal(insert[1].length, 60);
  assert.equal(insert[1].every((row) => row.recurrence_no_end === true), true);
  assert.equal(insert[1].every((row) => row.recurrence_until === "2030-12-15"), true);
  harness.done();
});

test("monthly end mode rejects contradictory and non-boolean input before storage", async () => {
  for (const repeatNoEnd of ["true", 1, null]) {
    const harness = observingCtx();
    const response = await handleWorkItemsRequest(ownerRequest("POST", {
      title: "급여 지급",
      scheduleType: "report_due",
      startsAt: "2026-01-15T09:00:00+09:00",
      repeat: "monthly",
      repeatNoEnd,
      repeatUntil: "2026-12-15",
      requestId: "11111111-1111-4111-8111-444444444444",
    }), harness.ctx);
    assert.equal(response.status, 400);
    assert.equal(harness.calls.length, 0);
  }

  const harness = observingCtx();
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "급여 지급",
    scheduleType: "report_due",
    startsAt: "2026-01-15T09:00:00+09:00",
    repeat: "monthly",
    repeatNoEnd: true,
    repeatUntil: "2026-12-15",
    requestId: "11111111-1111-4111-8111-555555555555",
  }), harness.ctx);
  assert.equal(response.status, 400);
  assert.equal(harness.calls.length, 0);
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

test("POST rejects shared calendar ids and validates repeat inputs before writing", async () => {
  const invalidCalendar = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "일정",
    scheduleType: "meeting",
    startsAt: "2026-08-20T09:00:00+09:00",
    calendarId: "not-a-uuid",
  }), scriptedCtx([]).ctx);
  assert.equal(invalidCalendar.status, 404);

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

test("PATCH rejects shared calendar ids and duplicate recurrence dates", async () => {
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
  assert.equal(moved.status, 404);
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

// public.set_updated_at() 는 조건 없는 BEFORE UPDATE 트리거라서 구글 동기화
// 기록(google_synced_at)만 써도 updated_at 이 올라간다. 삭제까지 버전 일치를
// 요구하면 대표님 화면의 낡은 값 때문에 삭제가 무작위로 막힌다.
test("DELETE validates input but never rejects a stale version, re-reading the row instead", async () => {
  const unexpected = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: "item-1",
    expectedUpdatedAt: "2026-08-20T00:00:00.000Z",
    calendarId: "unexpected",
  }), scriptedCtx([]).ctx);
  assert.equal(unexpected.status, 400);

  const missingId = await handleWorkItemsRequest(ownerRequest("DELETE", {
    expectedUpdatedAt: "2026-08-20T00:00:00.000Z",
  }), scriptedCtx([]).ctx);
  assert.equal(missingId.status, 400);
  assert.equal((await missingId.json()).message, "삭제할 업무의 최신 상태를 확인해주세요.");

  // 값을 실어 보냈는데 형식이 깨진 것은 여전히 잘못된 요청이다.
  const brokenVersion = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expectedUpdatedAt: "2026-02-30",
  }), scriptedCtx([]).ctx);
  assert.equal(brokenVersion.status, 400);
  assert.equal((await brokenVersion.json()).message, "삭제할 업무의 최신 상태를 확인해주세요.");

  const existing = managerRow();
  const fresh = managerRow({ updated_at: "2026-08-21T00:00:00.000Z" });
  const staleHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
    { kind: "from", name: "schedule_items", result: { data: fresh, error: null } },
    { kind: "from", name: "schedule_items", result: { data: { id: existing.id }, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const stale = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: existing.id,
    expectedUpdatedAt: "2026-08-19T00:00:00.000Z",
  }), staleHarness.ctx);
  assert.equal(stale.status, 200);
  assert.equal((await stale.json()).message, "업무를 삭제했습니다.");
  // 낡은 버전을 받으면 행을 한 번 다시 읽고 그 정본으로 삭제를 이어간다.
  const deleteAt = staleHarness.calls.findIndex(([kind]) => kind === "delete");
  const selectsBeforeDelete = staleHarness.calls
    .slice(0, deleteAt)
    .filter(([kind, table], index) => kind === "from" && table === "schedule_items"
      && staleHarness.calls[index + 1]?.[0] === "select").length;
  assert.equal(selectsBeforeDelete, 2);
  assert.equal(staleHarness.calls.some(([kind, column]) => kind === "eq" && column === "updated_at"), false);
  staleHarness.done();
});

test("DELETE succeeds with only an id and keeps the tenant scope without an updated_at lock", async () => {
  const existing = managerRow({ client_id: "client-1", operation_team_id: "team-1" });
  const harness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: existing, error: null } },
    { kind: "from", name: "schedule_items", result: { data: { id: existing.id }, error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
  ]);
  const response = await handleWorkItemsRequest(ownerRequest("DELETE", { id: existing.id }), harness.ctx);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const filters = deleteFilters(harness.calls);
  assert.deepEqual(filters.find(([kind, column]) => kind === "eq" && column === "owner_agency_code"), ["eq", "owner_agency_code", "mml93-a01"]);
  assert.deepEqual(filters.find(([kind, column]) => kind === "eq" && column === "client_id"), ["eq", "client_id", "client-1"]);
  assert.deepEqual(filters.find(([kind, column]) => kind === "eq" && column === "operation_team_id"), ["eq", "operation_team_id", "team-1"]);
  assert.ok(filters.some(([kind, column]) => kind === "is" && column === "calendar_id"));
  assert.equal(filters.some(([kind, column]) => kind === "eq" && column === "updated_at"), false);
  harness.done();
});

test("DELETE returns 404 without touching storage when the row is gone or out of scope", async () => {
  const missingHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: null, error: null } },
  ]);
  const missing = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expectedUpdatedAt: "2026-08-20T00:00:00.000Z",
  }), missingHarness.ctx);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).message, "삭제할 업무를 찾을 수 없습니다.");
  assert.equal(missingHarness.calls.some(([kind]) => kind === "delete"), false);
  missingHarness.done();

  // 다른 대표 코드의 행은 범위 밖이므로 같은 404 로 닫는다.
  const foreignHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: managerRow({ owner_agency_code: "other-a01" }), error: null } },
  ]);
  const foreign = await handleWorkItemsRequest(ownerRequest("DELETE", {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }), foreignHarness.ctx);
  assert.equal(foreign.status, 404);
  assert.equal(foreignHarness.calls.some(([kind]) => kind === "delete"), false);
  foreignHarness.done();

  // 삭제가 0건이면 이미 사라진 것이다 — 버전 충돌 409 로 되돌리지 않는다.
  const raceHarness = scriptedCtx([
    { kind: "from", name: "schedule_items", result: { data: managerRow(), error: null } },
    { kind: "from", name: "schedule_items", result: { data: null, error: null } },
  ]);
  const race = await handleWorkItemsRequest(ownerRequest("DELETE", { id: managerRow().id }), raceHarness.ctx);
  const racePayload = await race.json();
  assert.equal(race.status, 404);
  assert.equal(racePayload.message, "삭제할 업무를 찾을 수 없습니다.");
  raceHarness.done();
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

// 프로덕션 빌드처럼 GOOGLE_OAUTH_* 가 켜져 있어도, 연동 행이 없으면 레거시
// 경로가 그대로 돌아야 한다. 켜진 상태에서 늘어나는 것은 연동 조회 두 번뿐이고
// 저장·감사 로그·201 응답은 미연동일 때와 동일하다는 것을 못 박는다.
test("legacy POST keeps its local path when google env is present but no integration row exists", async () => {
  const body = {
    title: "환경변수 무관 일정",
    scheduleType: "meeting",
    status: "planned",
    priority: "low",
    startsAt: "2026-08-20T09:00:00+09:00",
  };
  const saved = managerRow({ priority: "low" });
  const harness = scriptedCtx([
    { kind: "from", name: "owner_google_integrations", result: { data: null, error: null } },
    { kind: "from", name: "schedule_items", result: { data: [saved], error: null } },
    { kind: "from", name: "audit_logs", result: { error: null } },
    { kind: "from", name: "owner_google_integrations", result: { data: null, error: null } },
  ]);

  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid-ambient";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "sec-ambient";
  let response = null;
  try {
    response = await handleWorkItemsRequest(ownerRequest("POST", body), harness.ctx);
  } finally {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  }
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.message, "업무를 저장했습니다.");
  assert.equal(payload.items.length, 1);
  assert.equal(harness.calls.filter(([kind]) => kind === "from").length, 4);
  harness.done();
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

test("PATCH rejects stale state without audit", async () => {
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
});

test("personal-only contract: GET returns only private rows without reading or exposing shared calendars", async () => {
  const sharedCalendarId = "34343434-3434-4434-8434-343434343434";
  const privateRow = managerRow({ id: "private-item", calendar_id: null, title: "개인 일정" });
  const sharedRow = managerRow({ id: "shared-item", calendar_id: sharedCalendarId, title: "공유 일정" });
  const harness = observingCtx({
    tables: {
      schedule_calendar_memberships: [{
        data: [{
          role: "editor",
          revoked_at: null,
          calendar: {
            id: sharedCalendarId,
            name: "폐쇄 대상 공유 캘린더",
            color: "navy",
            archived_at: null,
          },
        }],
        error: null,
      }],
      schedule_items: [
        { data: [privateRow], error: null },
        { data: [sharedRow], error: null },
      ],
    },
  });

  const response = await handleWorkItemsRequest(ownerRequest("GET"), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.calendars, []);
  assert.deepEqual(payload.items.map((item) => item.id), ["private-item"]);
  assert.equal(harness.calls.some(([kind, table]) => kind === "from" && table === "schedule_calendar_memberships"), false);
  assert.equal(harness.calls.some(([kind, column]) => kind === "in" && column === "calendar_id"), false);
  assert.equal(harness.calls.filter(([kind, table]) => kind === "from" && table === "schedule_items").length, 1);
});

test("personal-only contract: sharing, list, create, join, invite, and leave actions are disabled with 404 before storage", async (t) => {
  const calendarId = "35353535-3535-4535-8535-353535353535";
  const actions = [
    { action: "calendar-list" },
    { action: "calendar-create", name: "공유 캘린더", color: "navy" },
    { action: "calendar-invite-create", calendarId, grantRole: "editor" },
    { action: "calendar-invite-accept", code: "DISABLED12345678901234" },
    { action: "calendar-leave", calendarId },
  ];

  for (const body of actions) {
    await t.test(body.action, async () => {
      const harness = observingCtx();
      const response = await handleWorkItemsRequest(ownerRequest("POST", body), harness.ctx);
      const payload = await response.json();

      assert.equal(response.status, 404);
      assert.equal(payload.ok, false);
      assert.equal(harness.calls.length, 0);
    });
  }
});

test("personal-only contract: supplying a shared calendar id to create an item is disabled with 404", async () => {
  const harness = observingCtx();
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "공유 캘린더 등록 시도",
    scheduleType: "meeting",
    status: "planned",
    priority: "medium",
    startsAt: "2026-08-20T09:00:00+09:00",
    calendarId: "36363636-3636-4636-8636-363636363636",
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(payload.ok, false);
  assert.equal(harness.calls.length, 0);
});

test("personal-only contract: finite monthly recurrence still saves privately", async () => {
  const seriesId = "37373737-3737-4737-8737-373737373737";
  const saved = [
    managerRow({ id: "private-aug", series_id: seriesId, occurrence_on: "2026-08-15", recurrence_kind: "monthly", recurrence_until: "2026-10-15" }),
    managerRow({ id: "private-sep", starts_at: "2026-09-15T00:00:00.000Z", series_id: seriesId, occurrence_on: "2026-09-15", recurrence_kind: "monthly", recurrence_until: "2026-10-15" }),
    managerRow({ id: "private-oct", starts_at: "2026-10-15T00:00:00.000Z", series_id: seriesId, occurrence_on: "2026-10-15", recurrence_kind: "monthly", recurrence_until: "2026-10-15" }),
  ];
  const harness = observingCtx({
    tables: {
      schedule_items: [
        { data: [], error: null },
        { data: saved, error: null },
      ],
      audit_logs: [{ error: null }],
    },
  });
  const response = await handleWorkItemsRequest(ownerRequest("POST", {
    title: "급여 지급",
    scheduleType: "report_due",
    status: "planned",
    priority: "medium",
    startsAt: "2026-08-15T09:00:00+09:00",
    repeat: "monthly",
    repeatUntil: "2026-10-15",
    requestId: seriesId,
  }), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(payload.items.map((item) => item.occurrenceOn), ["2026-08-15", "2026-09-15", "2026-10-15"]);
  const insertedRows = harness.calls.find(([kind]) => kind === "insert")?.[1] || [];
  assert.equal(insertedRows.length, 3);
  assert.equal(insertedRows.every((row) => row.calendar_id === null), true);
  assert.equal(harness.calls.some(([kind, table]) => kind === "from" && table === "schedule_calendar_memberships"), false);
  assert.equal(harness.calls.some(([kind]) => kind === "rpc"), false);
});

test("personal-only contract: existing shared rows reject PATCH, DELETE, and assistant completion before any shared write", async (t) => {
  const calendarId = "38383838-3838-4838-8838-383838383838";
  const existing = managerRow({
    id: "existing-shared-item",
    calendar_id: calendarId,
    title: "비활성화할 공유 일정",
  });
  const cases = [
    {
      name: "PATCH",
      method: "PATCH",
      body: {
        id: existing.id,
        expectedUpdatedAt: existing.updated_at,
        title: existing.title,
        scheduleType: existing.schedule_type,
        status: "done",
        priority: existing.priority,
        startsAt: existing.starts_at,
        endsAt: existing.ends_at,
        calendarId,
      },
    },
    {
      name: "DELETE",
      method: "DELETE",
      body: { id: existing.id, expectedUpdatedAt: existing.updated_at },
    },
    {
      name: "assistant-complete",
      method: "PATCH",
      body: { action: "assistant-complete", id: existing.id, expectedUpdatedAt: existing.updated_at },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = observingCtx({
        tables: {
          schedule_items: [{ data: existing, error: null }],
          schedule_calendar_memberships: [{
            data: { role: "editor", revoked_at: null, calendar: { id: calendarId, name: "기존 공유", color: "navy" } },
            error: null,
          }],
          audit_logs: [{ error: null }],
        },
        rpcs: {
          mi_update_shared_schedule_item: [{ data: [{ ...existing, status: "done" }], error: null }],
          mi_delete_shared_schedule_item: [{ data: existing.id, error: null }],
        },
      });
      const response = await handleWorkItemsRequest(ownerRequest(entry.method, entry.body), harness.ctx);
      const payload = await response.json();

      assert.equal(response.status, 404);
      assert.equal(payload.ok, false);
      assert.equal(harness.calls.filter(([kind, table]) => kind === "from" && table === "schedule_items").length, 1);
      assert.equal(harness.calls.some(([kind, table]) => kind === "from" && table === "schedule_calendar_memberships"), false);
      assert.equal(harness.calls.some(([kind]) => ["rpc", "insert", "update", "delete"].includes(kind)), false);
    });
  }
});

test("personal-only contract: client-visible legacy rows with calendar_id null remain readable through their public copy", async () => {
  const legacy = managerRow({
    id: "legacy-client-visible",
    client_id: "client-1",
    calendar_id: null,
    title: "내부 제목은 숨김",
    public_title: "광고주 공개 일정",
    public_comment: "공개 안내",
    visibility: "client_visible",
  });
  const harness = observingCtx({
    tables: {
      clients: [{ data: { id: "client-1", name: "광고주", agency_code: "client-a01", status: "active" }, error: null }],
      schedule_items: [{ data: [legacy], error: null }],
    },
  });
  const response = await handleWorkItemsRequest(clientRequest("GET"), harness.ctx);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].title, "광고주 공개 일정");
  assert.equal(JSON.stringify(payload).includes("내부 제목은 숨김"), false);
  assert.equal(harness.calls.some(([kind, table]) => kind === "from" && table === "schedule_calendar_memberships"), false);
});
