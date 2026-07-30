import test from "node:test";
import assert from "node:assert/strict";
import {
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

test("only owner and operation team can mutate work items", () => {
  assert.equal(roleCanMutateWorkItems("owner"), true);
  assert.equal(roleCanMutateWorkItems("team"), true);
  assert.equal(roleCanMutateWorkItems("client"), false);
});
