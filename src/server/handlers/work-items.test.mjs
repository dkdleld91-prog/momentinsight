import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantCompleteWorkItem,
  clientWorkItemPayload,
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
  assert.deepEqual(harness.calls.filter(([kind]) => kind === "update"), [["update", { status: "done" }]]);
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
