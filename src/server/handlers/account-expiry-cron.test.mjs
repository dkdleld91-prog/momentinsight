import assert from "node:assert/strict";
import test from "node:test";
import handler, {
  RANK_TRACKER_TABLES,
  clientPrincipalKey,
  deleteExpiredClient,
  expireUnlinkedClients,
  googleLinkTransitionClosed,
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
// Storage 는 storageCalls 에 따로 기록한다. "storage:objects"(경로 Set)를 주면 실제 storage-js 처럼 동작한다: list 는 그 폴더 바로 아래
// 항목(폴더는 id null)을 이름순·limit/offset 으로, remove 는 있는 경로만 지우고 지운 것만 돌려준다. "storage:list"(함수)는 목록을 직접 정하고,
// 함수가 { error } 를 돌려주면 그 호출만 실패한다. "storage:removeErrorAt" 은 n번째 remove 호출만 실패시킨다.
function fakeCtx(rowsByTable) {
  const calls = [];
  const storageCalls = [];
  const objects = rowsByTable["storage:objects"] || null;
  let removeCount = 0;
  const childrenOf = (path) => {
    const entries = new Map();
    for (const full of [...objects].sort()) {
      if (!full.startsWith(`${path}/`)) continue;
      const rest = full.slice(path.length + 1);
      const name = rest.split("/")[0];
      if (!entries.has(name)) entries.set(name, rest.includes("/") ? { name, id: null } : { name, id: `obj-${full}` });
    }
    return [...entries.values()];
  };
  const supabaseAdmin = {
    storage: {
      from(bucket) {
        return {
          list(path, options) {
            storageCalls.push(["list", bucket, path, options]);
            if (rowsByTable["storage:listError"]) return Promise.resolve({ data: null, error: rowsByTable["storage:listError"] });
            const spec = rowsByTable["storage:list"];
            const answer = objects
              ? childrenOf(path).slice(options.offset, options.offset + options.limit)
              : typeof spec === "function" ? spec(path, options) : [];
            if (answer && !Array.isArray(answer) && answer.error) return Promise.resolve({ data: null, error: answer.error });
            return Promise.resolve({ data: answer, error: null });
          },
          remove(paths) {
            storageCalls.push(["remove", bucket, paths]);
            removeCount += 1;
            if (rowsByTable["storage:removeError"] || rowsByTable["storage:removeErrorAt"] === removeCount) {
              return Promise.resolve({ data: null, error: rowsByTable["storage:removeError"] || { message: `remove ${removeCount} failed` } });
            }
            if (!objects) return Promise.resolve({ data: paths.map((name) => ({ name })), error: null });
            const deleted = paths.filter((path) => objects.delete(path)).map((name) => ({ name }));
            return Promise.resolve({ data: deleted, error: null });
          },
        };
      },
    },
    from(table) {
      const record = { table, ops: [] };
      calls.push(record);
      // 표 값이 함수면 그 호출의 ops 를 보고 응답 줄을 고른다(재확인 select 와 delete 를 다르게 답할 때).
      const spec = rowsByTable[table] || [];
      const query = {
        select(columns) { record.ops.push(["select", columns]); return query; },
        delete() { record.ops.push(["delete"]); return query; },
        update(values) { record.ops.push(["update", values]); return query; },
        insert(values) {
          record.ops.push(["insert", values]);
          return Promise.resolve({ data: null, error: rowsByTable[`${table}:insertError`] || null });
        },
        not(column, op, value) { record.ops.push(["not", column, op, value]); return query; },
        lt(column, value) { record.ops.push(["lt", column, value]); return query; },
        lte(column, value) { record.ops.push(["lte", column, value]); return query; },
        is(column, value) { record.ops.push(["is", column, value]); return query; },
        eq(column, value) { record.ops.push(["eq", column, value]); return query; },
        in(column, values) { record.ops.push(["in", column, values]); return query; },
        order(column, options) { record.ops.push(["order", column, options]); return query; },
        limit(count) { record.ops.push(["limit", count]); return query; },
        then(resolve, reject) {
          const response = rowsByTable[`${table}:error`]
            ? { data: null, error: rowsByTable[`${table}:error`] }
            : { data: typeof spec === "function" ? spec(record) : spec, error: null };
          return Promise.resolve(response).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { ctx: { supabaseAdmin }, calls, storageCalls };
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

const CLIENT_ID = "0b6f3a52-6c1e-4d7a-9e2f-1a2b3c4d5e6f";
const DUE_CLIENT = { id: CLIENT_ID, name: "지난 계정", agency_code: "ABC123", status: "active", plan_name: "basic", plan_expires_at: iso(-6), plan_note: null };
const isDelete = (call) => call.ops.some(([op]) => op === "delete");

test("deleting an expired client rechecks the row, removes Google link, personal schedules, rank trackers, notes, identities, quota and the client row, then audits", async () => {
  const { ctx, calls, storageCalls } = fakeCtx({
    owner_google_calendar_sync: [{ owner_agency_code: `client:${CLIENT_ID}` }, { owner_agency_code: `client:${CLIENT_ID}` }],
    owner_google_integrations: [{ owner_agency_code: `client:${CLIENT_ID}` }],
    schedule_items: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    schedule_calendar_memberships: [],
    naver_rank_trackers: [{ id: "t1" }, { id: "t2" }],
    naver_place_rank_trackers: [{ id: "p1" }],
    keyword_research_notes: [{ id: "n1" }],
    login_identities: [{ google_sub: "sub-1" }],
    trial_keyword_quota: [{ google_sub: "sub-1" }, { google_sub: "sub-1" }],
    clients: [DUE_CLIENT],
  });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.skipped, "");
  assert.equal(summary.googleSync, 2);
  assert.equal(summary.google, 1);
  assert.equal(summary.schedules, 3);
  assert.equal(summary.memberships, 0);
  assert.deepEqual(summary.trackers, { naver_rank_trackers: 2, naver_place_rank_trackers: 1 });
  assert.equal(summary.notes, 1);
  assert.equal(summary.identities, 1);
  assert.equal(summary.quota, 2);
  assert.equal(summary.client, true);
  const tables = calls.map((call) => call.table);
  assert.deepEqual(tables, [
    "clients",
    "owner_google_calendar_sync",
    "owner_google_integrations",
    "schedule_items",
    "schedule_calendar_memberships",
    "files",
    ...RANK_TRACKER_TABLES,
    "keyword_research_notes",
    "login_identities",
    "trial_keyword_quota",
    "login_identities",
    "clients",
    "audit_logs",
  ]);
  // 첫 clients 호출은 지우기 직전 재확인(select)이고, 로그인 연결은 google_sub 를 먼저 읽고(select) 체험 한도를 지운 뒤에 지운다.
  assert.equal(isDelete(calls[0]), false);
  assert.deepEqual(calls[0].ops.find(([op]) => op === "eq"), ["eq", "id", CLIENT_ID]);
  const identityCalls = calls.filter((call) => call.table === "login_identities");
  assert.deepEqual(identityCalls.map(isDelete), [false, true]);
  // 보고서 파일 실물: files 행을 읽고(select) 그 광고주 경로를 훑는다. 실물이 없으면 지우는 요청도 없다.
  assert.equal(isDelete(calls.find((call) => call.table === "files")), false);
  assert.deepEqual(calls.find((call) => call.table === "files").ops.find(([op]) => op === "eq"), ["eq", "client_id", CLIENT_ID]);
  assert.equal(summary.storageObjects, 0);
  for (const call of calls.slice(1).filter((entry) => !["audit_logs", "files"].includes(entry.table) && entry !== identityCalls[0])) {
    assert.equal(call.ops[0][0], "delete", `${call.table} 는 delete 로 시작한다`);
  }
  const eqs = (table) => calls.find((call) => call.table === table).ops.filter(([op]) => op === "eq");
  assert.deepEqual(eqs("owner_google_calendar_sync"), [["eq", "owner_agency_code", `client:${CLIENT_ID}`]]);
  assert.deepEqual(eqs("owner_google_integrations"), [["eq", "owner_agency_code", `client:${CLIENT_ID}`]]);
  assert.deepEqual(eqs("schedule_items"), [["eq", "personal_role", "client"], ["eq", "personal_code", CLIENT_ID]]);
  assert.deepEqual(eqs("schedule_calendar_memberships"), [["eq", "principal_key", `client:${CLIENT_ID}`]]);
  assert.deepEqual(eqs("naver_rank_trackers"), [["eq", "agency_code", "abc123"]]);
  // 광고주 행 삭제는 재확인한 그대로일 때만: 같은 코드(저장된 그대로)·같은 메모·만료 + 유예 5일 ≤ 지금.
  const clientDelete = calls.filter((call) => call.table === "clients")[1];
  assert.ok(isDelete(clientDelete));
  assert.deepEqual(clientDelete.ops.filter(([op]) => op === "eq"), [["eq", "id", CLIENT_ID], ["eq", "agency_code", "ABC123"]]);
  assert.deepEqual(clientDelete.ops.find(([op]) => op === "lte"), ["lte", "plan_expires_at", iso(-5)]);
  assert.deepEqual(clientDelete.ops.find(([op]) => op === "is"), ["is", "plan_note", null]);
  assert.equal(summary.auditLogged, true);
  // 광고주 행 삭제 전·후 두 번 훑는다(두 번째는 그 사이 올라온 파일용, files 행은 이미 없어 읽지 않는다).
  const sweep = ["list", "moment-reports", `clients/${CLIENT_ID}`, { limit: 1000, offset: 0 }];
  assert.deepEqual(storageCalls, [sweep, sweep]);
  const audit = calls.find((call) => call.table === "audit_logs");
  assert.equal(audit.ops[0][1].action, "client.deleted_after_grace");
  // 감사 메타데이터는 sanitizeAuditMetadata 를 거친다(코드류 값은 가려질 수 있음) — 출처와 결과만 확인한다.
  assert.equal(audit.ops[0][1].metadata.source, "account-expiry-cron");
  assert.equal(audit.ops[0][1].metadata.clientDeleted, true);
  assert.equal(audit.ops[0][1].target_id, CLIENT_ID);
});

test("deletion never builds a key that reaches the owner or an operation team (client:<uuid> only)", async () => {
  assert.equal(clientPrincipalKey(CLIENT_ID.toUpperCase()), `client:${CLIENT_ID}`);
  for (const bad of ["", null, undefined, "mml93-a01", "team:" + CLIENT_ID, "client:" + CLIENT_ID, "c-1", "*", "%", CLIENT_ID + " or 1=1"]) {
    assert.equal(clientPrincipalKey(bad), "", `${String(bad)} 로는 키를 만들지 않는다`);
  }
  const { ctx, calls } = fakeCtx({ clients: [{ ...DUE_CLIENT, id: "c-1" }] });
  const summary = await deleteExpiredClient(ctx, { ...DUE_CLIENT, id: "c-1" }, { nowMs: NOW, env: ENV });
  assert.equal(summary.client, false);
  assert.match(summary.errors[0], /id is not a uuid/);
  assert.equal(calls.length, 0, "uuid 가 아니면 아무 표도 읽거나 지우지 않는다");
});

test("a partial failure keeps the client row so the next run can retry, reports the error and audits what was removed", async () => {
  const { ctx, calls } = fakeCtx({
    owner_google_calendar_sync: [],
    owner_google_integrations: [],
    schedule_items: [],
    schedule_calendar_memberships: [],
    naver_rank_trackers: [],
    "naver_place_rank_trackers:error": { message: "place table down" },
    keyword_research_notes: [],
    login_identities: [],
    clients: [DUE_CLIENT],
  });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.equal(summary.client, false);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /naver_place_rank_trackers: place table down/);
  assert.equal(calls.some((call) => call.table === "clients" && isDelete(call)), false, "부분 실패면 광고주 행은 지우지 않는다");
  const audit = calls.filter((call) => call.table === "audit_logs");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].ops[0][1].action, "client.delete_partial_failed");
  assert.equal(audit[0].ops[0][1].metadata.clientDeleted, false);
});

test("an account extended after selection is skipped before anything is deleted", async () => {
  const extended = { ...DUE_CLIENT, plan_expires_at: iso(29) };
  const { ctx, calls } = fakeCtx({ clients: [extended] });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.equal(summary.skipped, "not_due");
  assert.equal(summary.client, false);
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(calls.map((call) => call.table), ["clients", "audit_logs"]);
  assert.equal(calls.some(isDelete), false);
  assert.equal(calls[1].ops[0][1].action, "client.delete_skipped_not_due");
});

test("a row whose code changed, that became the owner code, or that is already gone is not deleted", async () => {
  for (const current of [{ ...DUE_CLIENT, agency_code: "other1" }, { ...DUE_CLIENT, agency_code: "mml93-a01" }]) {
    const { ctx, calls } = fakeCtx({ clients: [current] });
    const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
    assert.equal(summary.skipped, "not_due");
    assert.equal(calls.some(isDelete), false);
  }
  const { ctx, calls } = fakeCtx({ clients: [] });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.equal(summary.skipped, "missing");
  assert.deepEqual(calls.map((call) => call.table), ["clients"]);
});

const EMPTY_CHILDREN = {
  owner_google_calendar_sync: [],
  owner_google_integrations: [],
  schedule_items: [],
  schedule_calendar_memberships: [],
  naver_rank_trackers: [],
  naver_place_rank_trackers: [],
  keyword_research_notes: [],
  login_identities: [],
};

// clients 호출 순서대로 답한다: 재확인 select → 마지막 delete → (0행이면) 다시 읽기.
function clientsInOrder(...answers) {
  let index = 0;
  return () => answers[Math.min(index++, answers.length - 1)];
}

test("if the client row is extended between the recheck and the final delete, it stays and the run reports a failure", async () => {
  const { ctx, calls } = fakeCtx({ ...EMPTY_CHILDREN, clients: clientsInOrder([DUE_CLIENT], [], [{ id: CLIENT_ID }]) });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.equal(summary.client, false);
  assert.equal(summary.skipped, "");
  assert.match(summary.errors[0], /account changed during deletion/);
  const audit = calls.find((call) => call.table === "audit_logs");
  assert.equal(audit.ops[0][1].action, "client.delete_partial_failed");
});

test("if another run already deleted the row before the final delete, it is skipped (not a failure)", async () => {
  const { ctx, calls } = fakeCtx({ ...EMPTY_CHILDREN, clients: clientsInOrder([DUE_CLIENT], [], []) });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.equal(summary.client, false);
  assert.equal(summary.skipped, "missing");
  assert.deepEqual(summary.errors, []);
  // 이 실행이 지운 하위 데이터도 남도록 따로 기록한다(광고주 행은 다른 실행이 지움).
  const audit = calls.filter((call) => call.table === "audit_logs");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].ops[0][1].action, "client.deleted_by_other_run");
});

test("a Google account linked between reading and deleting login identities also loses its trial quota", async () => {
  const { ctx, calls } = fakeCtx({
    ...EMPTY_CHILDREN,
    // 읽을 때는 sub-1, 지울 때는 sub-1 + 새로 연결된 sub-2
    login_identities: (record) => (record.ops.some(([op]) => op === "delete") ? [{ google_sub: "sub-1" }, { google_sub: "sub-2" }] : [{ google_sub: "sub-1" }]),
    trial_keyword_quota: (record) => [{ google_sub: record.ops.find(([op]) => op === "in")[2][0] }],
    clients: [DUE_CLIENT],
  });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.deepEqual(summary.errors, []);
  const quotaCalls = calls.filter((call) => call.table === "trial_keyword_quota");
  assert.deepEqual(quotaCalls.map((call) => call.ops.find(([op]) => op === "in")[2]), [["sub-1"], ["sub-2"]]);
  assert.equal(summary.quota, 2);
  assert.equal(summary.identities, 2);
});

test("a note change between recheck and delete is caught by the final delete filter (eq plan_note)", async () => {
  const unlinked = { ...DUE_CLIENT, plan_note: GOOGLE_LINK_EXPIRY_NOTE, plan_expires_at: iso(-4) };
  const { ctx, calls } = fakeCtx({ ...EMPTY_CHILDREN, clients: [unlinked] });
  const summary = await deleteExpiredClient(ctx, unlinked, { nowMs: NOW, env: ENV });
  assert.equal(summary.client, true);
  const clientDelete = calls.filter((call) => call.table === "clients")[1];
  assert.deepEqual(clientDelete.ops.find(([op, column]) => column === "plan_note"), ["eq", "plan_note", GOOGLE_LINK_EXPIRY_NOTE]);
  // 구글 미연동 자동 만료는 유예 3일 → 만료 + 3일 ≤ 지금
  assert.deepEqual(clientDelete.ops.find(([op]) => op === "lte"), ["lte", "plan_expires_at", iso(-3)]);
});

test("when the trial quota delete fails, login identities are kept so the next run can still find the quota", async () => {
  const { ctx, calls } = fakeCtx({
    ...EMPTY_CHILDREN,
    login_identities: [{ google_sub: "sub-1" }],
    "trial_keyword_quota:error": { message: "quota down" },
    clients: [DUE_CLIENT],
  });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.match(summary.errors[0], /trial_keyword_quota: quota down/);
  assert.equal(summary.identities, null);
  assert.equal(calls.filter((call) => call.table === "login_identities").some(isDelete), false);
  assert.equal(calls.some((call) => call.table === "clients" && isDelete(call)), false);
});

test("an audit insert error does not change the deletion but is reported as auditFailed", async () => {
  const selected = { ...DUE_CLIENT, agency_code: "abc123" };
  const { ctx } = fakeCtx({
    ...EMPTY_CHILDREN,
    clients: [selected],
    operation_team_codes: [],
    "audit_logs:insertError": { message: "audit down" },
  });
  const summary = await runAccountExpiry(ctx, { nowMs: NOW, env: ENV });
  assert.deepEqual(summary.deleted, ["abc123"]);
  assert.deepEqual(summary.failed, []);
  assert.deepEqual(summary.auditFailed, ["abc123"]);
});

// moment-reports 의 가짜 실물: clients/<id>/sources/2026-10/(a.pdf · report..final.pdf · 자리 표시 파일) · reports/2026-11/r0..r{n-1}.pptx
function reportObjects(clientId, bigCount = 0) {
  const base = `clients/${clientId}`;
  return new Set([
    `${base}/sources/2026-10/a.pdf`,
    `${base}/sources/2026-10/report..final.pdf`,
    `${base}/sources/2026-10/.emptyFolderPlaceholder`,
    ...Array.from({ length: bigCount }, (_, index) => `${base}/reports/2026-11/r${String(index).padStart(4, "0")}.pptx`),
    "clients/11111111-2222-3333-4444-555555555555/reports/2026-11/other.pdf", // 다른 광고주
  ]);
}

test("report files under the client's own Storage folder are removed in batches; other buckets and paths are never touched", async () => {
  const objects = reportObjects(CLIENT_ID, 1005);
  const { ctx, storageCalls } = fakeCtx({
    ...EMPTY_CHILDREN,
    files: [
      { storage_bucket: "moment-reports", storage_path: `clients/${CLIENT_ID}/reports/2026-09/old.pdf` }, // 행만 있고 실물 없음
      { storage_bucket: "moment-reports", storage_path: "clients/11111111-2222-3333-4444-555555555555/reports/2026-11/other.pdf" }, // 다른 광고주
      { storage_bucket: "moment-assets", storage_path: `clients/${CLIENT_ID}/logo.png` }, // 공용 버킷
      { storage_bucket: "moment-reports", storage_path: `clients/${CLIENT_ID}/../escape.pdf` }, // 경로 탈출
      { storage_bucket: null, storage_path: null }, // 외부 링크
    ],
    "storage:objects": objects,
    clients: [DUE_CLIENT],
  });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.client, true);
  const lists = storageCalls.filter(([op]) => op === "list");
  assert.ok(lists.every(([, bucket, path]) => bucket === "moment-reports" && path.startsWith(`clients/${CLIENT_ID}`)));
  // 1000개 꽉 찬 쪽 다음에 offset 1000 으로 한 번 더 읽는다. 두 번째 훑기 때는 이미 비어 폴더 목록만 읽는다.
  assert.deepEqual(lists.filter(([, , path]) => path.endsWith("2026-11")).map(([, , , options]) => options.offset), [0, 1000]);
  const removed = storageCalls.filter(([op]) => op === "remove");
  assert.ok(removed.every(([, bucket, paths]) => bucket === "moment-reports" && paths.length <= 100));
  const requested = removed.flatMap(([, , paths]) => paths);
  assert.ok(requested.every((path) => path.startsWith(`clients/${CLIENT_ID}/`) && path.split("/").every((part) => part && part !== "..")));
  assert.ok(requested.includes(`clients/${CLIENT_ID}/reports/2026-09/old.pdf`), "행이 가리키는 경로도 지우기를 요청한다");
  assert.ok(requested.includes(`clients/${CLIENT_ID}/sources/2026-10/report..final.pdf`), "파일 이름 안의 '..' 는 지운다");
  // 실제로 지운 수만 센다(행만 있고 실물이 없는 old.pdf 는 0) — 3 + 1005
  assert.equal(summary.storageObjects, 1008);
  assert.deepEqual([...objects], ["clients/11111111-2222-3333-4444-555555555555/reports/2026-11/other.pdf"], "다른 광고주 실물은 그대로");
});

test("when a later remove batch fails, the files already removed are still counted in the audit", async () => {
  const objects = reportObjects(CLIENT_ID, 247); // 3 + 247 = 250 → 100 · 100 · 50
  const { ctx, calls } = fakeCtx({ ...EMPTY_CHILDREN, "storage:objects": objects, "storage:removeErrorAt": 3, clients: [DUE_CLIENT] });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.match(summary.errors[0], /^storage: remove 3 failed/);
  assert.equal(summary.storageObjects, 200);
  assert.equal(calls.some((call) => call.table === "clients" && isDelete(call)), false, "광고주 행은 남겨 다음 날 나머지를 지운다");
  const audit = calls.find((call) => call.table === "audit_logs").ops[0][1];
  assert.equal(audit.action, "client.delete_partial_failed");
  assert.equal(audit.metadata.storageObjects, 200);
});

test("a failure in the second sweep (after the client row is gone) is reported as failed, since there is no retry", async () => {
  let baseLists = 0;
  const { ctx } = fakeCtx({
    ...EMPTY_CHILDREN,
    "storage:list": (path) => {
      if (path === `clients/${CLIENT_ID}`) baseLists += 1;
      return baseLists >= 2 ? { error: { message: "list down" } } : [];
    },
    clients: [DUE_CLIENT],
    operation_team_codes: [],
  });
  const summary = await runAccountExpiry(ctx, { nowMs: NOW, env: ENV });
  assert.deepEqual(summary.deleted, [DUE_CLIENT.agency_code.toLowerCase()]);
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].errors[0], /storage after delete: list down/);
});

test("a Storage error keeps the client row for tomorrow's retry and is audited as a partial failure", async () => {
  const { ctx, calls } = fakeCtx({
    ...EMPTY_CHILDREN,
    "storage:objects": reportObjects(CLIENT_ID),
    "storage:removeError": { message: "storage down" },
    clients: [DUE_CLIENT],
  });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.match(summary.errors[0], /storage: storage down/);
  assert.equal(calls.some((call) => call.table === "clients" && isDelete(call)), false);
  assert.equal(calls.find((call) => call.table === "audit_logs").ops[0][1].action, "client.delete_partial_failed");
});

test("Storage listing refuses folders deeper than expected instead of deleting a partial set", async () => {
  const deep = (path) => (path.split("/").length < 8 ? [{ name: "d", id: null }] : []);
  const { ctx, storageCalls } = fakeCtx({ ...EMPTY_CHILDREN, "storage:list": deep, clients: [DUE_CLIENT] });
  const summary = await deleteExpiredClient(ctx, DUE_CLIENT, { nowMs: NOW, env: ENV });
  assert.match(summary.errors[0], /storage: report folder too deep/);
  assert.equal(storageCalls.some(([op]) => op === "remove"), false);
});

test("a former owner code (MI_LEGACY_AGENCY_CODES) is never deleted even if it looks due", async () => {
  const legacy = { ...DUE_CLIENT, agency_code: "old-owner1" };
  const { ctx, calls } = fakeCtx({ clients: [legacy] });
  const summary = await deleteExpiredClient(ctx, legacy, { nowMs: NOW, env: { ...ENV, MI_LEGACY_AGENCY_CODES: "Old-Owner1" } });
  assert.equal(summary.skipped, "not_due");
  assert.equal(calls.some(isDelete), false);
});

test("the run lists skipped accounts separately from deleted and failed ones", async () => {
  const selected = { ...DUE_CLIENT, agency_code: "abc123" };
  const { ctx } = fakeCtx({
    // 고를 때는 삭제 대상, 지우기 직전 재확인에서는 연장된 상태.
    clients: (record) => (record.ops.some(([op, column]) => op === "eq" && column === "id") ? [{ ...selected, plan_expires_at: iso(29) }] : [selected]),
    login_identities: [],
    operation_team_codes: [],
  });
  const summary = await runAccountExpiry(ctx, { nowMs: NOW, env: ENV });
  assert.deepEqual(summary.due.map((row) => row.agencyCode), ["abc123"]);
  assert.deepEqual(summary.deleted, []);
  assert.deepEqual(summary.failed, []);
  assert.deepEqual(summary.skipped, [{ agencyCode: "abc123", reason: "not_due" }]);
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

// ── 검수 2026-10-03 긴급 ③: 구글 연동 전환은 기한 시점에 있던 계정에, 전환 기간 안에서 한 번만 적용한다 ──
test("전환 기간 안에서도 기한 뒤 새로 만든 미연동 광고주와 기한 뒤 이용 기간을 손댄 광고주는 만료 처리하지 않는다", async () => {
  const deadlineMs = Date.parse(googleLinkDeadlineIso());
  const nowMs = deadlineMs + 1 * DAY;
  const { ctx, calls } = fakeCtx({
    clients: [
      { id: "c-old", agency_code: "old001", status: "active", plan_expires_at: null, created_at: "2026-09-01T00:00:00.000Z" },
      { id: "c-new", agency_code: "new001", status: "active", plan_expires_at: null, created_at: new Date(deadlineMs + 12 * 60 * 60 * 1000).toISOString() },
      { id: "c-ext", agency_code: "ext001", status: "active", plan_expires_at: "2026-11-30T14:59:59.999Z", plan_updated_at: new Date(deadlineMs + 6 * 60 * 60 * 1000).toISOString(), created_at: "2026-08-01T00:00:00.000Z" },
    ],
    login_identities: [],
  });
  const result = await expireUnlinkedClients(ctx, { nowMs, env: ENV });
  assert.deepEqual(result.marked.map((row) => row.agencyCode), ["old001"]);
  const updated = calls.filter((call) => call.table === "clients" && call.ops.some(([op]) => op === "update"))
    .map((call) => call.ops.find(([op, column]) => op === "eq" && column === "id")[2]);
  assert.deepEqual(updated, ["c-old"]);
  const select = calls.find((call) => call.table === "clients").ops.find(([op]) => op === "select")[1];
  assert.match(select, /created_at/);
  assert.match(select, /plan_updated_at/);
});

test("전환 기간 안에서 기한 뒤 만든 광고주가 구글을 연결해도 고정 만료일을 찍지 않는다", async () => {
  const deadlineMs = Date.parse(googleLinkDeadlineIso());
  const nowMs = deadlineMs + 1 * DAY;
  const { ctx, calls } = fakeCtx({
    clients: [
      { id: "c-new", agency_code: "new002", status: "active", plan_expires_at: null, plan_updated_at: null, created_at: new Date(deadlineMs + 12 * 60 * 60 * 1000).toISOString() },
      { id: "c-old", agency_code: "old002", status: "active", plan_expires_at: null, plan_updated_at: null, created_at: new Date(deadlineMs - 30 * DAY).toISOString() },
    ],
    login_identities: [{ code: "new002" }, { code: "old002" }],
  });
  const result = await startLinkedClientPlans(ctx, { nowMs, env: ENV });
  assert.deepEqual(result.started.map((row) => row.agencyCode), ["old002"]);
  assert.equal(calls.filter((call) => call.table === "clients" && call.ops.some(([op]) => op === "update")).length, 1);
});

test("전환 기간 안에서 기한 뒤 만든 운영팀 코드는 미연동이어도 해제하지 않는다", async () => {
  const deadlineMs = Date.parse(googleLinkDeadlineIso());
  const nowMs = deadlineMs + GOOGLE_LINK_GRACE_DAYS * DAY + 60 * 60 * 1000;
  const { ctx } = fakeCtx({
    operation_team_codes: [
      { id: "t-old", team_code: "teamold", status: "active", created_at: "2026-08-01T00:00:00.000Z" },
      { id: "t-new", team_code: "teamnew", status: "active", created_at: new Date(deadlineMs + DAY).toISOString() },
    ],
    login_identities: [],
  });
  const result = await revokeUnlinkedTeams(ctx, { nowMs, env: ENV });
  assert.deepEqual(result.revoked.map((row) => row.teamCode), ["teamold"]);
});

test("전환 기간(기한+유예 3일+2일)이 지나면 세 단계 모두 DB 를 읽지도 않는다 — 다시 켠 광고주·연결 해제 광고주·다시 켠 운영팀 보호", async () => {
  const deadlineMs = Date.parse(googleLinkDeadlineIso());
  const closeMs = deadlineMs + (GOOGLE_LINK_GRACE_DAYS + 2) * DAY;
  assert.equal(googleLinkTransitionClosed(closeMs - 1, deadlineMs), false);
  assert.equal(googleLinkTransitionClosed(closeMs, deadlineMs), true);
  const rows = {
    clients: [
      // 기한 전부터 일시중지였다가 기한 뒤 다시 켠 광고주(만료일 없음)
      { id: "c-re", agency_code: "react01", status: "active", plan_expires_at: null, created_at: "2026-07-01T00:00:00.000Z" },
      // 기한 때 연동돼 30일이 시작됐다가 기한 뒤 구글 연결을 해제한 광고주
      { id: "c-un", agency_code: "unlink1", status: "active", plan_expires_at: googleLinkPlanExpiryIso(), plan_updated_at: new Date(deadlineMs + 3600000).toISOString(), created_at: "2026-07-01T00:00:00.000Z" },
    ],
    // 10/11 에 크론이 해제했다가 총관리자가 다시 켠 운영팀
    operation_team_codes: [{ id: "t-re", team_code: "teamre1", status: "active", created_at: "2026-07-01T00:00:00.000Z" }],
    login_identities: [],
  };
  for (const nowMs of [closeMs, Date.parse("2026-10-17T18:30:00Z"), Date.parse("2026-12-01T18:30:00Z")]) {
    const { ctx, calls } = fakeCtx(rows);
    const expired = await expireUnlinkedClients(ctx, { nowMs, env: ENV });
    const started = await startLinkedClientPlans(ctx, { nowMs, env: ENV });
    const revoked = await revokeUnlinkedTeams(ctx, { nowMs, env: ENV });
    assert.equal(expired.active, false);
    assert.equal(expired.closed, true);
    assert.deepEqual(expired.marked, []);
    assert.equal(started.active, false);
    assert.deepEqual(started.started, []);
    assert.equal(revoked.active, false);
    assert.deepEqual(revoked.revoked, []);
    assert.equal(calls.length, 0, "전환이 끝난 뒤에는 표를 읽지도 쓰지도 않는다");
  }
});
