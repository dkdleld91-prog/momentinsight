import assert from "node:assert/strict";
import test from "node:test";
import handler, {
  RANK_TRACKER_TABLES,
  deleteExpiredClient,
  runAccountExpiry,
  selectDeleteDueClients,
} from "./account-expiry-cron.mjs";
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
    ],
  });
  const due = await selectDeleteDueClients(ctx, NOW, 20, ENV);
  assert.deepEqual(due.map((row) => row.agency_code), ["abc123"]);
  const query = calls.find((call) => call.table === "clients");
  assert.ok(query.ops.some(([op, column]) => op === "not" && column === "plan_expires_at"));
  assert.ok(query.ops.some(([op, column, value]) => op === "lt" && column === "plan_expires_at" && value === iso(-5)));
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
