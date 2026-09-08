import assert from "node:assert/strict";
import test from "node:test";
import handler, {
  RANK_TRACKER_TABLES,
  deleteExpiredClient,
  expireUnlinkedClients,
  revokeUnlinkedTeams,
  runAccountExpiry,
  selectDeleteDueClients,
  startLinkedClientPlans,
} from "./account-expiry-cron.mjs";
import {
  GOOGLE_LINKED_PLAN_NOTE,
  GOOGLE_LINK_DEADLINE,
  GOOGLE_LINK_EXPIRY_NOTE,
  GOOGLE_LINK_GRACE_DAYS,
  googleLinkDeadlineIso,
  googleLinkPlanExpiryIso,
} from "../account-plan.mjs";
import { requiresCodeSession } from "../session-gate.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-20T18:30:00Z");
const ENV = { MI_PRIMARY_AGENCY_CODE: "mml93-a01", CRON_SECRET: "cron-test-secret" };

function iso(offsetDays) {
  return new Date(NOW + offsetDays * DAY).toISOString();
}

// 표별 응답을 정하고, 모든 호출(from·delete·eq·in·select…)을 순서대로 기록하는 가짜 Supabase.
function fakeCtx(rowsByTable) {
  const calls = [];
  const supabaseAdmin = {
    from(table) {
      const record = { table, ops: [] };
      calls.push(record);
      const rows = rowsByTable[table] || [];
      const query = {
        select(columns) { record.ops.push(["select", columns]); return query; },
        delete() { record.ops.push(["delete"]); return query; },
        update(values) { record.ops.push(["update", values]); return query; },
        insert(values) { record.ops.push(["insert", values]); return Promise.resolve({ data: null, error: null }); },
        not(column, op, value) { record.ops.push(["not", column, op, value]); return query; },
        lt(column, value) { record.ops.push(["lt", column, value]); return query; },
        eq(column, value) { record.ops.push(["eq", column, value]); return query; },
        in(column, values) { record.ops.push(["in", column, values]); return query; },
        order(column, options) { record.ops.push(["order", column, options]); return query; },
        limit(count) { record.ops.push(["limit", count]); return query; },
        then(resolve, reject) {
          const response = rowsByTable[`${table}:error`]
            ? { data: null, error: rowsByTable[`${table}:error`] }
            : { data: rows, error: null };
          return Promise.resolve(response).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { ctx: { supabaseAdmin }, calls };
}

test("delete-due selection keeps only accounts past the grace period and never the owner code", async () => {
  const { ctx, calls } = fakeCtx({
    clients: [
      { id: "c-1", name: "지난 계정", agency_code: "abc123", status: "active", plan_expires_at: iso(-6) },
      { id: "c-2", name: "유예 중", agency_code: "def456", status: "active", plan_expires_at: iso(-2) },
      { id: "c-3", name: "총관리자", agency_code: "mml93-a01", status: "active", plan_expires_at: iso(-30) },
      { id: "c-4", name: "무기한", agency_code: "ghi789", status: "active", plan_expires_at: null },
      // 구글 미연동 자동 만료는 유예 3일(대표 결정 2026-09-08): 4일 지난 미연동은 삭제 대상, 같은 날짜의 일반 만료는 아직 유예 중.
      { id: "c-5", name: "미연동 4일 지남", agency_code: "unl001", status: "active", plan_expires_at: iso(-4), plan_note: GOOGLE_LINK_EXPIRY_NOTE },
      { id: "c-6", name: "일반 4일 지남", agency_code: "ord001", status: "active", plan_expires_at: iso(-4), plan_note: null },
    ],
  });
  const due = await selectDeleteDueClients(ctx, NOW, 20, ENV);
  assert.deepEqual(due.map((row) => row.agency_code), ["abc123", "unl001"]);
  const query = calls.find((call) => call.table === "clients");
  assert.ok(query.ops.some(([op, column]) => op === "not" && column === "plan_expires_at"));
  // 조회는 짧은 유예(3일) 기준으로 넓게 잡고 planStatus 가 행별 유예로 최종 판정한다.
  assert.ok(query.ops.some(([op, column, value]) => op === "lt" && column === "plan_expires_at" && value === iso(-GOOGLE_LINK_GRACE_DAYS)));
  assert.ok(query.ops.some(([op, columns]) => op === "select" && /plan_note/.test(columns)), "유예 판정에 plan_note 가 필요하다");
});

test("deleting an expired client removes rank trackers, notes, identities, quota and the client row, then audits", async () => {
  const { ctx, calls } = fakeCtx({
    naver_rank_trackers: [{ id: "t1" }, { id: "t2" }],
    naver_place_rank_trackers: [{ id: "p1" }],
    keyword_research_notes: [{ id: "n1" }],
    login_identities: [{ google_sub: "sub-1" }],
    trial_keyword_quota: [{ google_sub: "sub-1" }, { google_sub: "sub-1" }],
    clients: [{ id: "c-1" }],
  });
  const summary = await deleteExpiredClient(ctx, { id: "c-1", name: "지난 계정", agency_code: "ABC123", plan_name: "basic", plan_expires_at: iso(-6) });
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.trackers, { naver_rank_trackers: 2, naver_place_rank_trackers: 1 });
  assert.equal(summary.notes, 1);
  assert.equal(summary.identities, 1);
  assert.equal(summary.quota, 2);
  assert.equal(summary.client, true);
  const tables = calls.map((call) => call.table);
  assert.deepEqual(tables, [...RANK_TRACKER_TABLES, "keyword_research_notes", "login_identities", "trial_keyword_quota", "clients", "audit_logs"]);
  for (const call of calls.filter((entry) => entry.table !== "audit_logs")) {
    assert.equal(call.ops[0][0], "delete", `${call.table} 는 delete 로 시작한다`);
  }
  const trackerCall = calls.find((call) => call.table === "naver_rank_trackers");
  assert.deepEqual(trackerCall.ops.find(([op]) => op === "eq"), ["eq", "agency_code", "abc123"]);
  const audit = calls.find((call) => call.table === "audit_logs");
  assert.equal(audit.ops[0][1].action, "client.deleted_after_grace");
  // 감사 메타데이터는 sanitizeAuditMetadata 를 거친다(코드류 값은 가려질 수 있음) — 출처와 결과만 확인한다.
  assert.equal(audit.ops[0][1].metadata.source, "account-expiry-cron");
  assert.equal(audit.ops[0][1].metadata.clientDeleted, true);
  assert.equal(audit.ops[0][1].target_id, "c-1");
});

test("a partial failure keeps the client row so the next run can retry, and reports the error", async () => {
  const { ctx, calls } = fakeCtx({
    naver_rank_trackers: [],
    "naver_place_rank_trackers:error": { message: "place table down" },
    keyword_research_notes: [],
    login_identities: [],
    clients: [{ id: "c-1" }],
  });
  const summary = await deleteExpiredClient(ctx, { id: "c-1", agency_code: "abc123" });
  assert.equal(summary.client, false);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /naver_place_rank_trackers: place table down/);
  assert.equal(calls.some((call) => call.table === "clients"), false, "부분 실패면 광고주 행은 지우지 않는다");
  assert.equal(calls.some((call) => call.table === "audit_logs"), false);
});

test("dry run and the disable switch report due accounts without deleting anything", async () => {
  const { ctx, calls } = fakeCtx({
    clients: [{ id: "c-1", name: "지난 계정", agency_code: "abc123", status: "active", plan_expires_at: iso(-6) }],
  });
  const dry = await runAccountExpiry(ctx, { nowMs: NOW, dryRun: true, env: ENV });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.due.map((row) => row.agencyCode), ["abc123"]);
  assert.deepEqual(dry.deleted, []);
  assert.equal(calls.filter((call) => call.table !== "clients").length, 0);

  const disabled = await runAccountExpiry(ctx, { nowMs: NOW, env: { ...ENV, MI_ACCOUNT_EXPIRY_DELETE_DISABLED: "true" } });
  assert.equal(disabled.dryRun, true);
  assert.equal(disabled.disabled, true);
  assert.deepEqual(disabled.deleted, []);
});

test("the cron endpoint needs the cron secret and is outside the code-session gate", async () => {
  assert.equal(requiresCodeSession(new Request("https://insight.momentlabs.co.kr/api/account-expiry-cron")), false);
  // withSupabase 래퍼가 Supabase 환경값을 요구하므로 테스트용 값을 잠깐 넣는다.
  const overrides = {
    CRON_SECRET: "cron-test-secret",
    SUPABASE_URL: "http://supabase.test",
    SUPABASE_PUBLISHABLE_KEY: "pub-test",
    SUPABASE_SECRET_KEY: "secret-test",
  };
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const denied = await handler.fetch(new Request("https://insight.momentlabs.co.kr/api/account-expiry-cron"));
    assert.equal(denied.status, 401);
    const wrong = await handler.fetch(new Request("https://insight.momentlabs.co.kr/api/account-expiry-cron", { headers: { authorization: "Bearer nope" } }));
    assert.equal(wrong.status, 401);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ── 구글 연동 기한(대표 지시 2026-09-08): 기한 전엔 아무것도 안 하고, 지나면 미연동 활성 광고주에 만료일을 찍는다 ──
test("구글 연동 기한 전에는 미연동 만료 처리가 DB 를 읽지도 않는다", async () => {
  const { ctx, calls } = fakeCtx({ clients: [{ id: "c-1", agency_code: "abc123", status: "active" }] });
  const beforeMs = Date.parse(googleLinkDeadlineIso()) - DAY;
  const result = await expireUnlinkedClients(ctx, { nowMs: beforeMs, env: ENV });
  assert.equal(result.active, false);
  assert.deepEqual(result.marked, []);
  assert.equal(calls.length, 0);
  assert.equal(GOOGLE_LINK_DEADLINE, "2026-10-07");
});

test("기한이 지나면 구글 미연동 활성 광고주만 만료일=기한·메모로 찍고 감사를 남긴다(총관리자·연동 계정·이미 만료 계정 제외)", async () => {
  const deadline = googleLinkDeadlineIso();
  const afterMs = Date.parse(deadline) + 60 * 60 * 1000;
  const { ctx, calls } = fakeCtx({
    clients: [
      { id: "c-1", name: "미연동", agency_code: "abc123", status: "active", plan_expires_at: null },
      { id: "c-2", name: "연동됨", agency_code: "def456", status: "active", plan_expires_at: null },
      { id: "c-3", name: "총관리자", agency_code: "mml93-a01", status: "active", plan_expires_at: null },
      { id: "c-4", name: "이미 만료", agency_code: "ghi789", status: "active", plan_expires_at: iso(-10) },
      { id: "c-5", name: "먼 미래 만료", agency_code: "jkl012", status: "active", plan_expires_at: "2027-01-01T00:00:00.000Z" },
    ],
    login_identities: [{ code: "DEF456" }],
  });
  const result = await expireUnlinkedClients(ctx, { nowMs: afterMs, env: ENV });
  assert.equal(result.active, true);
  assert.deepEqual(result.marked.map((row) => row.agencyCode).sort(), ["abc123", "jkl012"]);
  assert.deepEqual(result.failed, []);
  const updates = calls.filter((call) => call.table === "clients" && call.ops.some(([op]) => op === "update"));
  assert.equal(updates.length, 2);
  for (const call of updates) {
    const [, values] = call.ops.find(([op]) => op === "update");
    assert.equal(values.plan_expires_at, deadline);
    assert.equal(values.plan_note, GOOGLE_LINK_EXPIRY_NOTE);
  }
  const audits = calls.filter((call) => call.table === "audit_logs");
  assert.equal(audits.length, 2);
  assert.equal(audits[0].ops[0][1].action, "client.expired_unlinked");
});

test("총관리자 코드는 환경변수가 빠진 프로덕션에서도 만료·삭제 대상이 아니다(상수 보호)", async () => {
  const afterMs = Date.parse(googleLinkDeadlineIso()) + 60 * 60 * 1000;
  const productionWithoutCode = { VERCEL_ENV: "production" };
  const { ctx: expireCtx } = fakeCtx({
    clients: [
      { id: "c-owner", name: "브랜드 A", agency_code: "mml93-a01", status: "active", plan_expires_at: null },
      { id: "c-1", name: "미연동", agency_code: "abc123", status: "active", plan_expires_at: null },
    ],
    login_identities: [],
  });
  const expired = await expireUnlinkedClients(expireCtx, { nowMs: afterMs, dryRun: true, env: productionWithoutCode });
  assert.deepEqual(expired.marked.map((row) => row.agencyCode), ["abc123"]);

  const { ctx: dueCtx } = fakeCtx({
    clients: [{ id: "c-owner", name: "브랜드 A", agency_code: "mml93-a01", status: "active", plan_expires_at: iso(-30) }],
  });
  assert.deepEqual(await selectDeleteDueClients(dueCtx, NOW, 20, productionWithoutCode), []);

  const { ctx: linkedCtx } = fakeCtx({
    clients: [{ id: "c-owner", name: "브랜드 A", agency_code: "mml93-a01", status: "active", plan_expires_at: null }],
    login_identities: [{ code: "mml93-a01" }],
  });
  const started = await startLinkedClientPlans(linkedCtx, { nowMs: afterMs, dryRun: true, env: productionWithoutCode });
  assert.deepEqual(started.started, []);
});

test("dryRun 이면 미연동 대상만 보고하고 갱신·감사는 없다 · runAccountExpiry 응답에 실린다", async () => {
  const afterMs = Date.parse(googleLinkDeadlineIso()) + DAY;
  const { ctx, calls } = fakeCtx({
    clients: [{ id: "c-1", name: "미연동", agency_code: "abc123", status: "active", plan_expires_at: null }],
    login_identities: [],
  });
  const summary = await runAccountExpiry(ctx, { nowMs: afterMs, dryRun: true, env: ENV });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.googleLinkDeadline, googleLinkDeadlineIso());
  assert.deepEqual(summary.unlinkedExpired.map((row) => row.agencyCode), ["abc123"]);
  assert.deepEqual(summary.linkedPlanStarted, [], "미연동 계정에는 이용 기간을 시작하지 않는다");
  assert.equal(summary.googleLinkGraceDays, GOOGLE_LINK_GRACE_DAYS);
  assert.equal(summary.linkedPlanExpiresAt, googleLinkPlanExpiryIso());
  assert.equal(calls.some((call) => call.ops.some(([op]) => op === "update")), false);
  assert.equal(calls.some((call) => call.table === "audit_logs"), false);
});

// ── 연동한 계정(대표 결정 2026-09-08 "30일 지난 후부터 30일 카운팅"): 기한 뒤 구글 연결 + 무기한 광고주에 10/08~11/06 이용 기간을 찍는다 ──
test("구글 연동 기한 전에는 연동 계정 이용 기간 시작이 DB 를 읽지도 않는다", async () => {
  const { ctx, calls } = fakeCtx({ clients: [{ id: "c-1", agency_code: "def456", status: "active" }], login_identities: [{ code: "def456" }] });
  const beforeMs = Date.parse(googleLinkDeadlineIso()) - DAY;
  const result = await startLinkedClientPlans(ctx, { nowMs: beforeMs, env: ENV });
  assert.equal(result.active, false);
  assert.deepEqual(result.started, []);
  assert.equal(calls.length, 0);
});

test("기한이 지나면 구글 연동 + 무기한 활성 광고주에만 기한 다음 날부터 30일 이용 기간을 찍고 감사를 남긴다", async () => {
  const deadline = googleLinkDeadlineIso();
  const afterMs = Date.parse(deadline) + 60 * 60 * 1000;
  const { ctx, calls } = fakeCtx({
    clients: [
      { id: "c-1", name: "미연동 무기한", agency_code: "abc123", status: "active", plan_expires_at: null, plan_name: null },
      { id: "c-2", name: "연동 무기한", agency_code: "def456", status: "active", plan_expires_at: null, plan_name: null, plan_updated_at: "2026-09-07T12:33:07.689+00:00" },
      { id: "c-3", name: "총관리자", agency_code: "mml93-a01", status: "active", plan_expires_at: null },
      { id: "c-4", name: "연동 + 기간 있음", agency_code: "jkl012", status: "active", plan_expires_at: "2027-01-01T00:00:00.000Z" },
      { id: "c-5", name: "연동 + 기한 뒤 총관리자가 무기한으로 돌림", agency_code: "mno345", status: "active", plan_expires_at: null, plan_updated_at: new Date(Date.parse(deadline) + 30 * 60 * 1000).toISOString() },
      { id: "c-6", name: "연동 프리미엄 무기한", agency_code: "pqr678", status: "active", plan_expires_at: null, plan_name: "premium", plan_updated_at: null },
    ],
    login_identities: [{ code: "DEF456" }, { code: "mml93-a01" }, { code: "jkl012" }, { code: "mno345" }, { code: "pqr678" }],
  });
  const result = await startLinkedClientPlans(ctx, { nowMs: afterMs, env: ENV });
  assert.equal(result.active, true);
  assert.equal(result.expiresAt, googleLinkPlanExpiryIso());
  assert.deepEqual(result.started.map((row) => row.agencyCode).sort(), ["def456", "pqr678"]);
  assert.deepEqual(result.failed, []);
  const updates = calls.filter((call) => call.table === "clients" && call.ops.some(([op]) => op === "update"));
  assert.equal(updates.length, 2);
  const values = updates.map((call) => call.ops.find(([op]) => op === "update")[1]);
  for (const value of values) {
    assert.equal(value.plan_days, 30);
    assert.equal(value.plan_started_at, deadline);
    assert.equal(value.plan_expires_at, googleLinkPlanExpiryIso());
    assert.equal(value.plan_expires_at, "2026-11-06T14:59:59.000Z");
    assert.equal(value.plan_note, GOOGLE_LINKED_PLAN_NOTE);
    assert.ok(value.plan_updated_at);
  }
  assert.deepEqual(values.map((value) => value.plan_name).sort(), ["basic", "premium"], "플랜 이름은 있으면 유지, 없으면 basic");
  const audits = calls.filter((call) => call.table === "audit_logs");
  assert.equal(audits.length, 2);
  assert.equal(audits[0].ops[0][1].action, "client.plan_started_linked");
  assert.equal(audits[0].ops[0][1].metadata.source, "account-expiry-cron");
});

test("연동 계정 이용 기간 시작도 dryRun 이면 대상만 보고하고 갱신·감사는 없다 · runAccountExpiry 응답에 실린다", async () => {
  const afterMs = Date.parse(googleLinkDeadlineIso()) + DAY;
  const { ctx, calls } = fakeCtx({
    clients: [
      { id: "c-1", name: "미연동", agency_code: "abc123", status: "active", plan_expires_at: null },
      { id: "c-2", name: "연동", agency_code: "def456", status: "active", plan_expires_at: null },
    ],
    login_identities: [{ code: "def456" }],
  });
  const summary = await runAccountExpiry(ctx, { nowMs: afterMs, dryRun: true, env: ENV });
  assert.equal(summary.dryRun, true);
  assert.deepEqual(summary.unlinkedExpired.map((row) => row.agencyCode), ["abc123"]);
  assert.deepEqual(summary.linkedPlanStarted.map((row) => row.agencyCode), ["def456"]);
  assert.equal(summary.linkedPlanStarted[0].dryRun, true);
  assert.equal(summary.googleLinkPlanDays, 30);
  assert.equal(calls.some((call) => call.ops.some(([op]) => op === "update")), false);
  assert.equal(calls.some((call) => call.table === "audit_logs"), false);
});

// ── 운영팀도 포함(대표 지시 2026-09-08): 기한 + 유예 3일이 지난 날부터 구글 미연동 활성 운영팀 코드를 해제한다 ──
test("운영팀 미연동 해제는 기한 + 유예 3일 전에는 아무것도 하지 않는다", async () => {
  const { ctx, calls } = fakeCtx({ operation_team_codes: [{ id: "t-1", team_code: "teamalpha", status: "active" }] });
  const justAfterDeadline = Date.parse(googleLinkDeadlineIso()) + DAY;
  const result = await revokeUnlinkedTeams(ctx, { nowMs: justAfterDeadline, env: ENV });
  assert.equal(result.active, false);
  assert.equal(calls.length, 0);
  assert.equal(GOOGLE_LINK_GRACE_DAYS, 3);
  assert.equal(result.revokeFrom, new Date(Date.parse(googleLinkDeadlineIso()) + 3 * DAY).toISOString());
  assert.equal(result.revokeFrom, "2026-10-10T14:59:59.000Z");
});

test("기한 + 유예가 지나면 구글 미연동 활성 운영팀만 revoked 로 바꾸고 감사를 남긴다(연결된 운영팀 제외, 광고주는 건드리지 않음)", async () => {
  const afterMs = Date.parse(googleLinkDeadlineIso()) + 3 * DAY + 60 * 60 * 1000;
  const { ctx, calls } = fakeCtx({
    operation_team_codes: [
      { id: "t-1", team_name: "미연동팀", team_code: "teamalpha", status: "active", client_id: "c-9" },
      { id: "t-2", team_name: "연동팀", team_code: "teambeta", status: "active", client_id: null },
    ],
    login_identities: [{ code: "TEAMBETA" }],
  });
  const result = await revokeUnlinkedTeams(ctx, { nowMs: afterMs, env: ENV });
  assert.equal(result.active, true);
  assert.deepEqual(result.revoked.map((row) => row.teamCode), ["teamalpha"]);
  const updates = calls.filter((call) => call.table === "operation_team_codes" && call.ops.some(([op]) => op === "update"));
  assert.equal(updates.length, 1);
  const [, values] = updates[0].ops.find(([op]) => op === "update");
  assert.equal(values.status, "revoked");
  assert.equal(values.client_id, null);
  assert.ok(values.revoked_at);
  assert.equal(calls.some((call) => call.table === "clients"), false, "광고주 행은 건드리지 않는다");
  const audit = calls.find((call) => call.table === "audit_logs");
  assert.equal(audit.ops[0][1].action, "operation_team.revoked_unlinked");
});
