import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// 2026-09-27 (KST 19:33-20:34): 주작업기가 꺼진 동안 맥 대기기의 수집 프로필에 일반 창이 없어
// chrome.tabs.create 가 3ms 만에 거절됐고(naver_page_navigation_failed), 대기기 실패 2건이 전역
// 회로를 열고 대기기 검증 실패 2건이 다시 열어 돌아온 주작업기가 20:34 까지 기다렸다.
// 대기기 기기 쪽 실패 격리·벤치, 대기기에서 시작된 회로(수동 종단 포함)에서 주작업기 즉시 검증,
// 적용 확인 SQL 과 되돌리기 SQL 을 실제 Postgres(PGlite)로 고정한다. 주작업기가 열었거나 자기
// 검증을 이미 쓴 회로, 수동 정지·probe_security_block·보안 cooldown·살아 있는 임대, 차단 호출이
// 안 된 채 해제·만료된 네이버 차단과 추적기 코드로 끝난 검증, 열 값이 없는(마이그레이션 전) 회로는
// 옛 함수와 차등 비교로 동일함을 단정한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = path.join(root, "supabase", "migrations");
const nextPattern = /^\d{14}_naver_shopping_standby_failure_isolation\.sql$/u;
const nextNames = fs.readdirSync(migrations).filter((name) => nextPattern.test(name));
const migration = nextNames[0] ? fs.readFileSync(path.join(migrations, nextNames[0]), "utf8") : "";
const sqlDocs = path.join(root, "docs", "sql");
const readDoc = (suffix) => {
  const file = path.join(sqlDocs, `20260927120000_naver_shopping_standby_failure_isolation.${suffix}.sql`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};
const rollbackSql = readDoc("rollback");
const verifySql = readDoc("verify-applied");

function priorFunction(file, name) {
  const source = fs.readFileSync(path.join(migrations, file), "utf8");
  const blocks = source.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "giu")) || [];
  assert.ok(blocks.length, `${file} must define ${name}`);
  return blocks.at(-1);
}
const OLD = {
  claim: priorFunction("20260919030000_naver_shopping_standby_runtime_identity_registration.sql", "mi_claim_naver_shopping_worker_lane"),
  fail: priorFunction("20260903160000_naver_shopping_transient_page_half_open_and_tracker_lifecycle_lease.sql", "mi_record_naver_shopping_worker_failure"),
  rel: priorFunction("20260821180001_naver_shopping_error_taxonomy_hardening.sql", "mi_release_naver_shopping_worker_lane"),
  block: priorFunction("20260821180001_naver_shopping_error_taxonomy_hardening.sql", "mi_block_naver_shopping_worker_lane"),
  stop: priorFunction("20260811095137_naver_shopping_worker_control_plane.sql", "mi_stop_naver_shopping_worker"),
};
const newFunction = (name) => migration.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "iu"))?.[0] || "";

const PRIMARY = "windows-desktop-primary";
const STANDBY = "macbook-standby";
const PT = "11111111-1111-4111-8111-111111111111";
const ST = "22222222-2222-4222-8222-222222222222";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Historical fixture identity (as in the other standby migration suites); not the live runtime.
const VERSION = "1.1.21";
const FINGERPRINT = "84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0";
const NAV = "naver_page_navigation_failed";
const MARKER = "mi:standby-failure-isolation";
const ISOLATED_FUNCTIONS = [
  "mi_claim_naver_shopping_worker_lane",
  "mi_record_naver_shopping_worker_failure",
  "mi_release_naver_shopping_worker_lane",
];
const NEW_COLUMNS = [
  "circuit_opened_by_worker",
  "standby_failure_worker_id",
  "standby_failure_streak",
  "standby_last_failure_at",
  "standby_last_failure_code",
  "standby_benched_until",
];
const STANDBY_DEVICE_CODES = [
  "naver_page_navigation_failed",
  "provider_deadline_exceeded",
  "provider_browser_collection_failed",
  "provider_browser_launch_failed",
  "provider_browser_dependency_missing",
  "native_host_response_timeout",
  "native_host_input_closed",
  "native_host_input_failed",
  "native_host_request_id_mismatch",
  "native_host_page_delivery_failed",
  "native_host_collection_failed",
];
const SECURITY_CODES = [
  "naver_verification_required",
  "naver_network_restricted",
  "naver_http_418",
  "naver_http_429",
  "naver_http_403",
  "naver_captcha_detected",
  "naver_auth_required",
  "naver_access_blocked",
];

async function fixture({ green = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.naver_shopping_worker_coordination (
      lane_key text primary key,
      circuit_state text not null default 'closed',
      circuit_reason text,
      circuit_opened_at timestamptz,
      failure_signature text,
      failure_streak integer not null default 0,
      transient_system_probe_attempts integer not null default 0,
      probe_tracker_id uuid,
      probe_started_at timestamptz,
      primary_worker_id text,
      primary_seen_at timestamptz,
      lease_worker_id text,
      lease_token uuid,
      lease_until timestamptz,
      cooldown_until timestamptz,
      last_block_code text,
      run_id uuid,
      runtime_version text,
      runtime_fingerprint text,
      current_stage text,
      current_page integer not null default 0,
      current_job_kind text,
      current_tracker_id uuid,
      current_job_started_at timestamptz,
      last_success_at timestamptz,
      last_failure_at timestamptz,
      last_failure_code text,
      last_collection_id text,
      last_checked_count integer,
      last_excluded_ad_count integer,
      last_duration_ms integer,
      last_source text,
      cadence_mode text not null default 'baseline',
      cadence_minutes integer not null default 10,
      stability_started_at timestamptz,
      success_streak integer not null default 0,
      transient_standby_handoff_at timestamptz,
      transient_standby_handoff_worker_id text,
      transient_standby_handoff_success_at timestamptz,
      updated_at timestamptz default now()
    );
    create table public.naver_rank_trackers (id uuid primary key, status text not null default 'active',
      processing_until timestamptz, worker_quarantined_until timestamptz, retry_count integer default 0);
    create table public.naver_shopping_rank_lookup_jobs (id uuid primary key, status text, processing_until timestamptz);
    create table public.naver_shopping_worker_runs (run_id uuid primary key, worker_id text, runtime_version text, runtime_fingerprint text);
    create table public.naver_shopping_scheduler_events (event_id bigint generated always as identity primary key,
      event_type text, run_id uuid, claim_id uuid, tracker_id uuid, worker_id text, group_fingerprint text,
      error_code text, priority text, lease_started_at timestamptz);
  `);
  await db.exec(OLD.fail);
  await db.exec(OLD.claim);
  await db.exec(OLD.rel);
  await db.exec(OLD.block);
  await db.exec(OLD.stop);
  if (green) await db.exec(migration);
  return db;
}

async function seed(db, overrides = {}) {
  const values = {
    lane_key: "'global'",
    primary_worker_id: `'${PRIMARY}'`,
    primary_seen_at: "now() - interval '1 hour'",
    runtime_version: `'${VERSION}'`,
    runtime_fingerprint: `'${FINGERPRINT}'`,
    last_success_at: "now() - interval '2 hours'",
    ...overrides,
  };
  await db.exec("delete from public.naver_shopping_worker_coordination; delete from public.naver_shopping_worker_runs; delete from public.naver_shopping_scheduler_events;");
  await db.exec(`insert into public.naver_shopping_worker_coordination (${Object.keys(values).join(", ")}) values (${Object.values(values).join(", ")});`);
  await db.query("insert into public.naver_shopping_worker_runs values ($1,$2,$3,$4)", [RUN, PRIMARY, VERSION, FINGERPRINT]);
}

// Moves every coordination timestamp back, which is the same as advancing the clock.
async function advance(db, seconds) {
  const columns = (await db.query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_shopping_worker_coordination'
      and data_type = 'timestamp with time zone'`)).rows.map((row) => row.column_name);
  await db.exec(`update public.naver_shopping_worker_coordination set ${columns
    .map((column) => `${column} = ${column} - make_interval(secs => ${Number(seconds)})`).join(", ")}`);
}

const lane = async (db) => (await db.query("select * from public.naver_shopping_worker_coordination")).rows[0];
async function claim(db, worker, role, token) {
  return (await db.query("select public.mi_claim_naver_shopping_worker_lane($1,$2,$3,2100,180,$4,$5) as r", [worker, role, token, VERSION, FINGERPRINT])).rows[0].r;
}
// what mi_report_naver_shopping_worker_progress does to the lane before/after the first page
async function progress(db, stage) {
  await db.query("update public.naver_shopping_worker_coordination set run_id=$1, current_stage=$2, current_job_kind='tracker' where lane_key='global'", [RUN, stage]);
}
async function fail(db, worker, token, code, scope = "system", trackerId = null) {
  return (await db.query("select public.mi_record_naver_shopping_worker_failure($1,$2,$3,$4,$5,$6) as r", [worker, token, RUN, code, scope, trackerId])).rows[0].r;
}
async function release(db, worker, token) {
  return (await db.query("select public.mi_release_naver_shopping_worker_lane($1,$2) as r", [worker, token])).rows[0].r;
}
async function block(db, worker, token, code) {
  return (await db.query("select public.mi_block_naver_shopping_worker_lane($1,$2,$3) as r", [worker, token, code])).rows[0].r;
}
// One claimed job that fails with `code` at `stage`, exactly as the worker drives the RPCs.
async function attempt(db, worker, role, token, code, stage = "navigating") {
  const c = await claim(db, worker, role, token);
  if (!c.granted) return { claim: c };
  await progress(db, stage);
  const f = await fail(db, worker, token, code);
  if (f.laneReleased !== true) await release(db, worker, token);
  return { claim: c, failure: f };
}
const standbyAttempt = (db, code = NAV, stage = "navigating") => attempt(db, STANDBY, "standby", ST, code, stage);
const primaryAttempt = (db, code, stage = "collecting") => attempt(db, PRIMARY, "primary", PT, code, stage);
const minutesBetween = (later, earlier) => (new Date(later) - new Date(earlier)) / 60000;
const brief = (r) => [r.granted, r.reason, r.circuitState ?? null, r.autoRecovery ?? null, r.manualRequired ?? null];

const CORE = ["circuit_state", "circuit_reason", "failure_signature", "failure_streak", "transient_system_probe_attempts",
  "lease_worker_id", "run_id", "current_stage", "last_failure_code", "cadence_mode", "cadence_minutes", "success_streak",
  "last_block_code", "transient_standby_handoff_worker_id"];
const core = (row) => Object.fromEntries(CORE.map((key) => [key, row[key]]));

function functionBody(sql, name) {
  const block = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nas \\$\\$\\n([\\s\\S]*?)\\n\\$\\$;`, "iu"));
  return block?.[1] || "";
}

test("migration is runtime neutral, marked in every body and keeps invoker/search_path/grants", () => {
  assert.equal(nextNames.length, 1);
  assert.ok(nextNames[0] > "20260925010000_naver_shopping_failure_evidence_size_limit.sql");
  assert.match(migration, /revoke all on function public\.mi_claim_naver_shopping_worker_lane\(\s*text, text, uuid, integer, integer, text, text\s*\) from public, anon, authenticated, service_role;/u);
  assert.match(migration, /grant execute on function public\.mi_claim_naver_shopping_worker_lane\(\s*text, text, uuid, integer, integer, text, text\s*\) to service_role;/u);
  assert.match(migration, /revoke all on function public\.mi_record_naver_shopping_worker_failure\(\s*text, uuid, uuid, text, text, uuid\s*\) from public, anon, authenticated, service_role;/u);
  assert.match(migration, /grant execute on function public\.mi_record_naver_shopping_worker_failure\(\s*text, uuid, uuid, text, text, uuid\s*\) to service_role;/u);
  assert.match(migration, /revoke all on function public\.mi_release_naver_shopping_worker_lane\(text, uuid\)\s+from public, anon, authenticated, service_role;/u);
  assert.match(migration, /grant execute on function public\.mi_release_naver_shopping_worker_lane\(text, uuid\)\s+to service_role;/u);
  assert.doesNotMatch(migration, /\b1\.1\.\d+\b|[a-f0-9]{64}/u, "no runtime literal, not even in comments");
  assert.equal((migration.match(/create or replace function/gu) || []).length, 3);
  assert.equal((migration.match(/security invoker/gu) || []).length, 3);
  assert.equal((migration.match(/set search_path = ''/gu) || []).length, 3);
  assert.match(migration, /^begin;$/mu);
  assert.match(migration, /^commit;$/mu);
  for (const name of ISOLATED_FUNCTIONS) {
    const body = functionBody(migration, name);
    assert.ok(body, name);
    assert.equal(body.split(MARKER).length - 1, 1, `${name} carries the applied marker inside its body`);
  }
});

test("the device-code list is the documented one and never contains a Naver blocking code", () => {
  const header = migration.slice(0, migration.indexOf("\nbegin;\n"));
  for (const code of STANDBY_DEVICE_CODES) assert.ok(header.includes(code), `header documents ${code}`);
  const failureBody = functionBody(migration, "mi_record_naver_shopping_worker_failure");
  const listed = failureBody.match(/standby_host_local_failure :=[\s\S]*?split_part\(normalized_error, ':', 1\) in \(([\s\S]*?)\);/u)?.[1] || "";
  const codes = [...listed.matchAll(/'([a-z0-9_]+)'/gu)].map((match) => match[1]);
  assert.deepEqual(codes, STANDBY_DEVICE_CODES);
  for (const code of SECURITY_CODES) assert.equal(codes.includes(code), false, code);
  // the primary's early probe: the claim's transient recovery codes plus the standby-device codes, nothing else
  const claimBody = functionBody(migration, "mi_claim_naver_shopping_worker_lane");
  const quoted = (list) => [...list.matchAll(/'([a-z0-9_]+)'/gu)].map((match) => match[1]);
  const transient = quoted(claimBody.match(/transient_recovery_open := current_row\.circuit_state = 'open'\s+and transient_failure_code in \(([\s\S]*?)\)/u)?.[1] || "");
  assert.equal(transient.length, 10);
  const early = quoted(claimBody.match(/and early_probe_code in \(([\s\S]*?)\)/u)?.[1] || "");
  assert.deepEqual([...early].sort(), [...new Set([...transient, ...STANDBY_DEVICE_CODES])].sort());
  for (const code of SECURITY_CODES) assert.equal(early.includes(code), false, code);
  assert.doesNotMatch(claimBody, /strpos\(/u, "no reason qualifies merely by containing ':'");
});

test("migration applies twice (idempotent) and adds the six columns with the streak bound", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await db.exec(migration);
  const cols = (await db.query("select column_name from information_schema.columns where table_name='naver_shopping_worker_coordination'")).rows.map((r) => r.column_name);
  for (const column of NEW_COLUMNS) assert.ok(cols.includes(column), column);
  await seed(db);
  assert.equal((await lane(db)).standby_failure_streak, 0);
  await assert.rejects(db.exec("update public.naver_shopping_worker_coordination set standby_failure_streak = 1001"), /standby_failure_streak_check/u);
});

test("verify-applied SQL reads false before, nine times true after, and false for the functions after rollback", async (t) => {
  assert.ok(verifySql, "docs/sql verify-applied file exists");
  assert.ok(rollbackSql, "docs/sql rollback file exists");
  assert.match(verifySql, /position\('mi:standby-failure-isolation' in prosrc\) > 0 as applied/u);
  const db = await fixture({ green: false });
  t.after(() => db.close());
  const check = async () => Object.fromEntries((await db.query(verifySql)).rows.map((row) => [`${row.kind}:${row.name}`, row.applied]));
  const before = await check();
  assert.equal(Object.keys(before).length, 9);
  assert.ok(Object.values(before).every((applied) => applied === false));
  await db.exec(migration);
  const after = await check();
  assert.equal(Object.keys(after).length, 9);
  assert.ok(Object.values(after).every((applied) => applied === true), JSON.stringify(after));
  await seed(db, { circuit_opened_by_worker: `'${STANDBY}'`, standby_failure_worker_id: `'${STANDBY}'`, standby_failure_streak: "2",
    standby_benched_until: "now() + interval '30 minutes'" });
  await db.exec(rollbackSql);
  const rolledBack = await check();
  for (const name of ISOLATED_FUNCTIONS) assert.equal(rolledBack[`function:${name}`], false, name);
  for (const column of NEW_COLUMNS) assert.equal(rolledBack[`column:${column}`], true, column);
  const row = await lane(db);
  assert.equal(row.circuit_opened_by_worker, null);
  assert.equal(row.standby_benched_until, null);
  assert.equal(row.standby_failure_streak, 0);
});

test("rollback restores the old circuit behaviour byte for byte", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await db.exec(rollbackSql);
  for (const [name, old] of [["mi_claim_naver_shopping_worker_lane", OLD.claim], ["mi_record_naver_shopping_worker_failure", OLD.fail], ["mi_release_naver_shopping_worker_lane", OLD.rel]]) {
    const live = (await db.query("select prosrc from pg_proc where proname = $1", [name])).rows[0].prosrc;
    assert.equal(live.trim(), functionBody(old, name).trim(), name);
  }
  await seed(db);
  await standbyAttempt(db);
  await standbyAttempt(db);
  const row = await lane(db);
  assert.equal(row.circuit_state, "open");
  assert.equal(row.circuit_reason, `navigating:${NAV}`);
  assert.equal(row.standby_failure_streak, 0);
});

// 09-27 timeline (KST): primary last request 19:32:38, standby job_failed 19:42:33 and 19:52:06,
// standby navigation probes 20:03:00 and 20:19:58, primary back 20:21:54.
async function replay0927(db) {
  const out = {};
  await seed(db, { primary_seen_at: "now() - interval '595 seconds'", last_success_at: "now() - interval '1084 seconds'" });
  out.first = await standbyAttempt(db); // 19:42:33
  await advance(db, 573);
  out.second = await standbyAttempt(db); // 19:52:06
  out.afterSecond = await lane(db);
  await advance(db, 654);
  out.probe2003 = await standbyAttempt(db); // 20:03:00
  await advance(db, 1018);
  out.probe2019 = await standbyAttempt(db); // 20:19:58
  await advance(db, 116);
  out.primary2021 = await claim(db, PRIMARY, "primary", PT); // 20:21:54
  out.at2021 = await lane(db);
  return out;
}

test("RED: the 2026-09-27 timeline on the old functions holds the returning primary behind the standby's circuit", async (t) => {
  const db = await fixture({ green: false });
  t.after(() => db.close());
  const out = await replay0927(db);
  assert.equal(out.afterSecond.circuit_state, "open");
  assert.equal(out.afterSecond.circuit_reason, `navigating:${NAV}`);
  assert.equal(out.probe2003.claim.circuitState, "half_open");
  assert.equal(out.probe2003.failure.circuitState, "open");
  assert.equal(out.probe2019.claim.circuitState, "half_open");
  assert.equal(out.probe2019.failure.circuitState, "open");
  assert.equal(out.primary2021.granted, false);
  assert.equal(out.primary2021.reason, "circuit_open");
  await advance(db, 485); // 20:29:59, ten minutes after the standby's 20:19:58 reopen
  const late = await claim(db, PRIMARY, "primary", PT);
  assert.equal(late.granted, true);
  assert.equal(late.circuitState, "half_open");
});

test("GREEN: the 2026-09-27 timeline keeps the circuit closed, benches the standby 30 minutes and admits the primary at 20:21:54", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const out = await replay0927(db);
  assert.equal(out.first.claim.granted, true);
  assert.deepEqual(
    [out.first.failure.recorded, out.first.failure.circuitState, out.first.failure.laneReleased, out.first.failure.standbyIsolated, out.first.failure.standbyFailureStreak, out.first.failure.standbyBenchedUntil],
    [true, "closed", true, true, 1, null],
  );
  assert.equal(out.second.failure.standbyFailureStreak, 2);
  const row = out.afterSecond;
  assert.equal(row.circuit_state, "closed");
  assert.equal(row.failure_signature, null);
  assert.equal(row.failure_streak, 0);
  assert.equal(row.lease_worker_id, null);
  assert.equal(row.last_failure_code, NAV);
  assert.equal(row.standby_last_failure_code, NAV);
  assert.equal(Math.round(minutesBetween(row.standby_benched_until, row.standby_last_failure_at)), 30);
  for (const refused of [out.probe2003.claim, out.probe2019.claim]) {
    assert.equal(refused.granted, false);
    assert.equal(refused.reason, "standby_benched");
    assert.ok(refused.benchedUntil);
    assert.equal(refused.circuitState, "closed");
  }
  assert.equal(out.primary2021.granted, true);
  assert.equal(out.primary2021.circuitState, "closed");
  assert.notEqual(out.primary2021.autoRecovery, true);
  assert.equal(out.at2021.lease_worker_id, PRIMARY);
  assert.equal(out.at2021.circuit_opened_by_worker, null);
  await release(db, PRIMARY, PT);
  await advance(db, 20); // the bench ended at 20:22:06; the live primary keeps the standby back as today
  const standby = await claim(db, STANDBY, "standby", ST);
  assert.equal(standby.reason, "primary_online");
});

test("bench: 60 minutes from the third failure; a primary success keeps an active bench and starts a new episode; a 3-hour gap does too", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db);
  await standbyAttempt(db);
  await standbyAttempt(db);
  await advance(db, 1801);
  const third = await standbyAttempt(db);
  assert.equal(third.failure.standbyFailureStreak, 3);
  let row = await lane(db);
  assert.equal(Math.round(minutesBetween(row.standby_benched_until, row.standby_last_failure_at)), 60);
  await advance(db, 60);
  // an atomic success (e.g. by the primary) after the standby's last failure
  await db.exec("update public.naver_shopping_worker_coordination set last_success_at = clock_timestamp() + interval '1 second'");
  const stillBenched = await claim(db, STANDBY, "standby", ST);
  assert.equal(stillBenched.reason, "standby_benched", "a success does not lift an active bench");
  await advance(db, 3600);
  const fresh = await standbyAttempt(db);
  assert.equal(fresh.failure.standbyFailureStreak, 1, "a success after the last failure starts a new episode");
  row = await lane(db);
  assert.equal(row.standby_benched_until, null);
  await advance(db, 3 * 3600 + 1);
  const gap = await standbyAttempt(db);
  assert.equal(gap.failure.standbyFailureStreak, 1, "failures more than 3 hours apart start a new episode");
  await advance(db, 60);
  const next = await standbyAttempt(db);
  assert.equal(next.failure.standbyFailureStreak, 2);
});

test("the standby's Naver-page codes still open the global circuit (opener recorded, no bench)", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db);
  const first = await standbyAttempt(db, "naver_page_timeout");
  assert.notEqual(first.failure.standbyIsolated, true);
  await standbyAttempt(db, "naver_page_timeout");
  const row = await lane(db);
  assert.equal(row.circuit_state, "open");
  assert.equal(row.circuit_reason, "navigating:naver_page_timeout");
  assert.equal(row.circuit_opened_by_worker, STANDBY);
  assert.equal(row.standby_failure_streak, 0);
  assert.equal(row.standby_benched_until, null);
});

test("Naver blocking from the standby keeps today's global cooldown and probe_security_block (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const scenario = async (db) => {
    const out = [];
    await seed(db);
    const c = await claim(db, STANDBY, "standby", ST);
    await progress(db, "navigating");
    const f = await fail(db, STANDBY, ST, "naver_http_429", "security");
    out.push(["closed", brief(c), f, await block(db, STANDBY, ST, "naver_http_429"), core(await lane(db))]);
    out.push(["primary", brief(await claim(db, PRIMARY, "primary", PT))]);
    // a standby navigation probe that meets a verification page
    await seed(db, {
      circuit_state: "'open'", circuit_reason: `'navigating:${NAV}'`, circuit_opened_at: "now() - interval '11 minutes'",
      failure_signature: `'navigating:${NAV}'`, failure_streak: "2", last_failure_code: `'${NAV}'`,
    });
    const probe = await claim(db, STANDBY, "standby", ST);
    await progress(db, "navigating");
    const sf = await fail(db, STANDBY, ST, "naver_verification_required", "security");
    out.push(["probe", brief(probe), sf, await block(db, STANDBY, ST, "naver_verification_required"), core(await lane(db))]);
    out.push(["primaryDuringCooldown", brief(await claim(db, PRIMARY, "primary", PT))]);
    await advance(db, 3601);
    out.push(["primaryAfterCooldown", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
    return out;
  };
  const a = await scenario(oldDb);
  const b = await scenario(newDb);
  assert.deepEqual(b, a);
  assert.equal(b[3][1][1], "cooldown");
  assert.equal(b[4][1][1], "circuit_open");
  assert.equal(b[2][4].circuit_reason, "probe_security_block");
  const row = await lane(newDb);
  assert.equal(row.circuit_opened_by_worker, null, "probe_security_block keeps no opener: the early probe never applies");
  assert.equal(row.standby_failure_streak, 0);
});

test("the primary's own circuit: failures, probes and early claims are identical to the old functions (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const scenario = async (db) => {
    const out = [];
    await seed(db, { primary_seen_at: "now()" });
    for (const code of [NAV, NAV, "provider_deadline_exceeded"]) {
      const c = await claim(db, PRIMARY, "primary", PT);
      out.push(["claim", brief(c)]);
      if (c.granted) {
        await progress(db, "navigating");
        const f = await fail(db, PRIMARY, PT, code);
        out.push(["fail", f]);
        if (f.laneReleased !== true) out.push(["release", await release(db, PRIMARY, PT)]);
      }
      out.push(["row", core(await lane(db))]);
    }
    await advance(db, 11 * 60);
    const probe = await claim(db, PRIMARY, "primary", PT);
    out.push(["probe", brief(probe)]);
    await progress(db, "navigating");
    out.push(["probeFail", await fail(db, PRIMARY, PT, NAV)]);
    out.push(["row", core(await lane(db))]);
    out.push(["early", brief(await claim(db, PRIMARY, "primary", PT))]);
    return out;
  };
  const a = await scenario(oldDb);
  const b = await scenario(newDb);
  assert.deepEqual(b, a);
  assert.equal((await lane(newDb)).circuit_opened_by_worker, PRIMARY);
});

test("the primary's lookup, tracker and security failures keep identical circuit fields (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const tracker = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const run = async (db) => {
    const out = [];
    await db.query("insert into public.naver_rank_trackers(id) values ($1) on conflict do nothing", [tracker]);
    for (const [scope, code, trackerId] of [["lookup", NAV, null], ["tracker", "provider_duplicate_identity", tracker], ["security", "naver_http_429", null], ["system", "native_host_input_closed", null]]) {
      await seed(db, { primary_seen_at: "now()" });
      await claim(db, PRIMARY, "primary", PT);
      await progress(db, "navigating");
      const f = await fail(db, PRIMARY, PT, code, scope, trackerId);
      out.push([scope, f, core(await lane(db))]);
    }
    return out;
  };
  const a = await run(oldDb);
  const b = await run(newDb);
  assert.deepEqual(b, a);
});

// A navigation circuit the primary's own failures opened, then the primary went quiet and the
// standby took the 09-19 navigation probe. Whether that probe fails, is released incomplete or
// expires, the episode stays the primary's: the returning primary waits exactly as today.
for (const ending of ["fail", "incomplete", "expired"]) {
  test(`a navigation circuit the primary opened keeps the primary as opener when the standby's probe ends ${ending}: the primary waits as today (differential)`, async (t) => {
    const oldDb = await fixture({ green: false });
    const newDb = await fixture();
    t.after(() => { oldDb.close(); newDb.close(); });
    const run = async (db) => {
      const out = [];
      await seed(db, { primary_seen_at: "now()" });
      for (let i = 0; i < 2; i += 1) await primaryAttempt(db, NAV, "navigating");
      out.push(["opened", core(await lane(db))]);
      await advance(db, 11 * 60);
      const probe = await claim(db, STANDBY, "standby", ST);
      out.push(["standbyProbe", brief(probe)]);
      await progress(db, "navigating");
      if (ending === "fail") {
        out.push(["standbyFail", await fail(db, STANDBY, ST, NAV)]);
      } else if (ending === "incomplete") {
        await db.query("insert into public.naver_shopping_scheduler_events(event_type, run_id, lease_started_at) values ('tracker_claimed', $1, now())", [RUN]);
        out.push(["standbyRelease", await release(db, STANDBY, ST)]);
      } else {
        await advance(db, 2101);
        out.push(["settle", brief(await claim(db, PRIMARY, "primary", PT))]);
      }
      out.push(["reopened", core(await lane(db))]);
      out.push(["primaryBack", brief(await claim(db, PRIMARY, "primary", PT))]);
      await advance(db, 10 * 60 + 1);
      out.push(["primaryAfterQuiet", brief(await claim(db, PRIMARY, "primary", PT))]);
      return out;
    };
    const a = await run(oldDb);
    const b = await run(newDb);
    assert.deepEqual(b, a);
    const byStep = Object.fromEntries(b.map((entry) => [entry[0], entry]));
    assert.equal(byStep.opened[1].circuit_reason, `navigating:${NAV}`);
    assert.deepEqual(byStep.standbyProbe[1], [true, "granted", "half_open", true, null]);
    assert.equal(byStep.reopened[1].circuit_state, "open");
    assert.deepEqual(byStep.primaryBack[1], [false, "circuit_open", "open", null, null]);
    assert.deepEqual(byStep.primaryAfterQuiet[1], [true, "granted", "half_open", true, null]);
    assert.equal((await lane(newDb)).circuit_opened_by_worker, PRIMARY, "kept through the standby's probe and the next half-open");
  });
}

test("a standby-originated navigation circuit: the standby keeps the 10-minute quiet period, the returning primary probes at once", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  // the standby's navigation failures opened the circuit; the standby took the probe after 10 minutes and failed
  await seed(db, {
    circuit_state: "'open'", circuit_reason: `'navigating:${NAV}'`, circuit_opened_at: "now() - interval '11 minutes'",
    failure_signature: `'navigating:${NAV}'`, failure_streak: "2", last_failure_code: `'${NAV}'`,
    circuit_opened_by_worker: `'${STANDBY}'`,
  });
  const probe = await claim(db, STANDBY, "standby", ST);
  assert.equal(probe.granted, true);
  assert.equal(probe.circuitState, "half_open");
  let row = await lane(db);
  assert.equal(row.circuit_opened_by_worker, STANDBY, "kept through open -> half_open");
  await progress(db, "navigating");
  const f = await fail(db, STANDBY, ST, NAV);
  assert.equal(f.circuitState, "open", "a failed half-open probe still reopens (fail-closed)");
  assert.equal(f.laneReleased, true);
  row = await lane(db);
  assert.equal(row.circuit_reason, `navigating:${NAV}`);
  assert.equal(row.circuit_opened_by_worker, STANDBY);
  assert.equal(row.standby_failure_streak, 1);
  const standbyAgain = await claim(db, STANDBY, "standby", ST);
  assert.equal(standbyAgain.reason, "circuit_open", "the standby still waits 10 minutes");
  const primary = await claim(db, PRIMARY, "primary", PT);
  assert.deepEqual(Object.keys(primary).sort(), ["autoRecovery", "cadenceMinutes", "circuitState", "granted", "leaseUntil", "probeTrackerId", "reason"]);
  assert.deepEqual(brief(primary), [true, "granted", "half_open", true, null]);
  row = await lane(db);
  assert.equal(row.circuit_reason, "auto_navigation_probe");
  assert.equal(row.circuit_opened_by_worker, STANDBY, "the early probe keeps the opener until the primary's probe ends");
  assert.equal(row.transient_system_probe_attempts, 0, "navigation probes have no budget");
  assert.equal(row.lease_worker_id, PRIMARY);
  assert.ok(row.probe_started_at);
});

test("no probe loop: the primary's own incomplete early probe falls back to the 10-minute wait", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db, {
    circuit_state: "'open'", circuit_reason: `'navigating:${NAV}'`, circuit_opened_at: "now() - interval '1 minute'",
    failure_signature: `'navigating:${NAV}'`, failure_streak: "1", last_failure_code: `'${NAV}'`,
    circuit_opened_by_worker: `'${STANDBY}'`,
  });
  const probe = await claim(db, PRIMARY, "primary", PT);
  assert.equal(probe.granted, true);
  await db.query("update public.naver_shopping_worker_coordination set run_id=$1, current_stage='collecting', current_job_kind='tracker', current_tracker_id=gen_random_uuid()", [RUN]);
  await db.query("insert into public.naver_shopping_scheduler_events(event_type, run_id, lease_started_at) values ('tracker_claimed', $1, now())", [RUN]);
  assert.equal(await release(db, PRIMARY, PT), true);
  const row = await lane(db);
  assert.equal(row.circuit_state, "open");
  assert.equal(row.circuit_reason, "probe_incomplete");
  assert.equal(row.circuit_opened_by_worker, PRIMARY);
  const again = await claim(db, PRIMARY, "primary", PT);
  assert.equal(again.granted, false);
  assert.equal(again.reason, "circuit_open");
  await advance(db, 10 * 60 + 1);
  assert.equal((await claim(db, PRIMARY, "primary", PT)).circuitState, "half_open", "the normal 10-minute wait applies");
});

test("an expired standby probe keeps the episode's opener: the primary probes at once only in a standby-originated episode", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db, {
    circuit_state: "'half_open'", circuit_reason: "'auto_navigation_probe'", last_failure_code: `'${NAV}'`,
    probe_started_at: "now() - interval '40 minutes'", lease_worker_id: `'${STANDBY}'`, lease_token: `'${ST}'`,
    lease_until: "now() - interval '1 minute'", circuit_opened_by_worker: `'${STANDBY}'`,
  });
  const first = await claim(db, PRIMARY, "primary", PT);
  assert.equal(first.reason, "circuit_open");
  const row = await lane(db);
  assert.equal(row.circuit_reason, "probe_interrupted");
  assert.equal(row.circuit_opened_by_worker, STANDBY);
  const second = await claim(db, PRIMARY, "primary", PT);
  assert.deepEqual(brief(second), [true, "granted", "half_open", true, null]);
});

test("an expired standby probe in a circuit opened before this migration (no opener) keeps today's 10-minute wait (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const run = async (db) => {
    const out = [];
    await seed(db, {
      circuit_state: "'half_open'", circuit_reason: "'auto_navigation_probe'", last_failure_code: `'${NAV}'`,
      probe_started_at: "now() - interval '40 minutes'", lease_worker_id: `'${STANDBY}'`, lease_token: `'${ST}'`,
      lease_until: "now() - interval '1 minute'",
    });
    out.push(["settle", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
    out.push(["again", brief(await claim(db, PRIMARY, "primary", PT))]);
    await advance(db, 10 * 60 + 1);
    out.push(["afterQuiet", brief(await claim(db, PRIMARY, "primary", PT))]);
    return out;
  };
  const a = await run(oldDb);
  const b = await run(newDb);
  assert.deepEqual(b, a);
  assert.deepEqual(b[1][1], [false, "circuit_open", "open", null, null]);
  assert.deepEqual(b[2][1], [true, "granted", "half_open", true, null]);
  assert.equal((await lane(newDb)).circuit_opened_by_worker, null);
});

test("lookup-scope standby device failures count toward the bench and release the lane", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db);
  for (let i = 0; i < 2; i += 1) {
    await claim(db, STANDBY, "standby", ST);
    await progress(db, "navigating");
    const f = await fail(db, STANDBY, ST, NAV, "lookup");
    assert.equal(f.laneReleased, true);
  }
  const row = await lane(db);
  assert.equal(row.standby_failure_streak, 2);
  assert.ok(row.standby_benched_until);
  assert.equal(row.circuit_state, "closed");
  assert.equal(row.lease_worker_id, null);
});

test("without a registered primary nothing is isolated (fail-closed as today)", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await seed(db, { primary_worker_id: "null", primary_seen_at: "null" });
  await standbyAttempt(db);
  await standbyAttempt(db);
  const row = await lane(db);
  assert.equal(row.circuit_state, "open");
  assert.equal(row.standby_failure_streak, 0);
});

test("the new claim still runs a primary closed-circuit claim on a table without the new columns", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.naver_shopping_worker_coordination (lane_key text primary key, circuit_state text not null default 'closed',
      circuit_reason text, circuit_opened_at timestamptz, failure_signature text, failure_streak integer not null default 0,
      transient_system_probe_attempts integer not null default 0, probe_tracker_id uuid, probe_started_at timestamptz,
      primary_worker_id text, primary_seen_at timestamptz, lease_worker_id text, lease_token uuid, lease_until timestamptz,
      cooldown_until timestamptz, last_block_code text, run_id uuid, runtime_version text, runtime_fingerprint text,
      current_stage text, current_page integer not null default 0, current_job_kind text, current_tracker_id uuid,
      current_job_started_at timestamptz, last_success_at timestamptz, last_failure_code text,
      cadence_mode text not null default 'baseline', cadence_minutes integer not null default 10,
      stability_started_at timestamptz, success_streak integer not null default 0,
      transient_standby_handoff_at timestamptz, transient_standby_handoff_worker_id text,
      transient_standby_handoff_success_at timestamptz, updated_at timestamptz);
    create table public.naver_shopping_rank_lookup_jobs (id uuid, status text, processing_until timestamptz);
    create table public.naver_rank_trackers (id uuid, status text, processing_until timestamptz);
    create table public.naver_shopping_worker_runs (run_id uuid, runtime_version text, runtime_fingerprint text);
    insert into public.naver_shopping_worker_coordination(lane_key, runtime_version, runtime_fingerprint) values ('global', '${VERSION}', '${FINGERPRINT}');`);
  await db.exec(newFunction("mi_claim_naver_shopping_worker_lane"));
  const r = await claim(db, PRIMARY, "primary", PT);
  assert.equal(r.granted, true);
  assert.equal(r.circuitState, "closed");
});

// A transient circuit that the standby's page failures opened while the primary was off.
async function standbyTransientCircuit(db) {
  await seed(db);
  await standbyAttempt(db, "naver_page_script_failed", "collecting");
  await standbyAttempt(db, "naver_page_script_failed", "collecting");
  const row = await lane(db);
  assert.equal(row.circuit_state, "open");
  assert.equal(row.circuit_reason, "collecting:naver_page_script_failed");
}

test("(1) a standby handoff that fails no longer locks the returning primary out; its own failure restores the terminal", async (t) => {
  for (const handoffCode of ["native_host_input_closed", "naver_page_script_failed"]) {
    const oldDb = await fixture({ green: false });
    const newDb = await fixture();
    t.after(() => { oldDb.close(); newDb.close(); });
    const run = async (db) => {
      await standbyTransientCircuit(db);
      await advance(db, 31 * 60);
      const handoff = await standbyAttempt(db, handoffCode, "collecting");
      assert.equal(handoff.claim.standbyHandoff, true);
      assert.equal(handoff.failure.circuitState, "open");
      return claim(db, PRIMARY, "primary", PT);
    };
    const before = await run(oldDb);
    assert.deepEqual(brief(before), [false, "recovery_manual_required", "open", null, true], `old: ${handoffCode}`);
    const after = await run(newDb);
    assert.deepEqual(brief(after), [true, "granted", "half_open", true, null], `new: ${handoffCode}`);
    let row = await lane(newDb);
    assert.equal(row.circuit_reason, "auto_transient_system_probe");
    assert.equal(row.transient_system_probe_attempts, 1, "the early probe consumes one of the primary's two");
    assert.equal(row.circuit_opened_by_worker, STANDBY, "kept until the primary's own probe ends");
    // the primary's own probe fails: the 09-10 manual terminal applies again
    await progress(newDb, "collecting");
    const own = await fail(newDb, PRIMARY, PT, "naver_page_script_failed");
    assert.equal(own.circuitState, "open");
    row = await lane(newDb);
    assert.equal(row.circuit_opened_by_worker, PRIMARY);
    const terminal = await claim(newDb, PRIMARY, "primary", PT);
    assert.deepEqual(brief(terminal), [false, "recovery_manual_required", "open", null, true]);
    assert.equal((await lane(newDb)).circuit_reason, "transient_recovery_manual_required");
    assert.equal((await claim(newDb, PRIMARY, "primary", PT)).reason, "recovery_manual_required");
  }
});

test("(2) a standby handoff released probe_incomplete without a signature, or expired, lets the primary probe at once", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const incomplete = async (db) => {
    await standbyTransientCircuit(db);
    await advance(db, 31 * 60);
    const handoff = await claim(db, STANDBY, "standby", ST);
    assert.equal(handoff.standbyHandoff, true);
    await progress(db, "collecting");
    await db.query("insert into public.naver_shopping_scheduler_events(event_type, run_id, lease_started_at) values ('tracker_claimed', $1, now())", [RUN]);
    assert.equal(await release(db, STANDBY, ST), true);
    const row = await lane(db);
    assert.deepEqual([row.circuit_state, row.circuit_reason, row.failure_signature, row.transient_system_probe_attempts], ["open", "probe_incomplete", null, 0]);
    return claim(db, PRIMARY, "primary", PT);
  };
  assert.deepEqual(brief(await incomplete(oldDb)), [false, "circuit_open", "open", null, null]);
  await advance(oldDb, 5 * 3600);
  assert.equal((await claim(oldDb, PRIMARY, "primary", PT)).reason, "circuit_open", "old: no automatic exit at all");
  assert.deepEqual(brief(await incomplete(newDb)), [true, "granted", "half_open", true, null]);
  assert.equal((await lane(newDb)).circuit_reason, "auto_transient_system_probe");

  const expired = async (db) => {
    await standbyTransientCircuit(db);
    await advance(db, 31 * 60);
    assert.equal((await claim(db, STANDBY, "standby", ST)).standbyHandoff, true);
    await progress(db, "collecting");
    await advance(db, 2101);
    const settle = await claim(db, PRIMARY, "primary", PT);
    assert.equal(settle.reason, "recovery_manual_required", "the expired handoff settles into the manual terminal");
    return claim(db, PRIMARY, "primary", PT);
  };
  assert.equal((await expired(oldDb)).reason, "recovery_manual_required");
  const next = await expired(newDb);
  assert.equal((await lane(newDb)).circuit_reason, "auto_transient_system_probe");
  assert.deepEqual(brief(next), [true, "granted", "half_open", true, null]);
});

test("(3) a transient circuit the primary opened keeps the 09-10 contract and its manual terminal (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const run = async (db) => {
    const out = [];
    await seed(db, { primary_seen_at: "now()" });
    for (let i = 0; i < 2; i += 1) out.push(["open", brief((await primaryAttempt(db, "naver_page_timeout")).claim)]);
    out.push(["early", brief(await claim(db, PRIMARY, "primary", PT))]);
    for (let probe = 0; probe < 2; probe += 1) {
      await advance(db, 31 * 60);
      await db.exec("update public.naver_shopping_worker_coordination set primary_seen_at = now()");
      const p = await primaryAttempt(db, "naver_page_timeout");
      out.push(["probe", brief(p.claim), p.failure.circuitState, core(await lane(db))]);
    }
    out.push(["handoffReady", brief(await claim(db, PRIMARY, "primary", PT))]);
    await db.exec("delete from public.naver_shopping_worker_runs");
    out.push(["unproven", brief(await claim(db, STANDBY, "standby", ST)), core(await lane(db))]);
    out.push(["primaryTerminal", brief(await claim(db, PRIMARY, "primary", PT))]);
    // a terminal recorded before this migration (no opener) is also unchanged
    await seed(db, { circuit_state: "'open'", circuit_reason: "'transient_recovery_manual_required'", circuit_opened_at: "now() - interval '2 hours'",
      last_failure_code: "'naver_page_timeout'", transient_system_probe_attempts: "2" });
    out.push(["legacyTerminal", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
    return out;
  };
  const a = await run(oldDb);
  const b = await run(newDb);
  assert.deepEqual(b, a);
  const byStep = Object.fromEntries(b.map((entry) => [entry[0], entry]));
  assert.equal(byStep.early[1][1], "circuit_open");
  assert.equal(byStep.handoffReady[1][1], "standby_handoff_required");
  assert.equal(byStep.unproven[1][1], "recovery_runtime_unproven");
  assert.deepEqual(byStep.primaryTerminal[1], [false, "recovery_manual_required", "open", null, true]);
  assert.deepEqual(byStep.legacyTerminal[1], [false, "recovery_manual_required", "open", null, true]);
});

test("after the primary's own two transient probes, a failed standby handoff gives the primary no extra probe: the manual terminal holds (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const run = async (db) => {
    const out = [];
    await seed(db, { primary_seen_at: "now()" });
    for (let i = 0; i < 2; i += 1) await primaryAttempt(db, "naver_page_timeout");
    for (let probe = 0; probe < 2; probe += 1) {
      await advance(db, 31 * 60);
      await db.exec("update public.naver_shopping_worker_coordination set primary_seen_at = now()");
      const p = await primaryAttempt(db, "naver_page_timeout");
      out.push(["probe", brief(p.claim), p.failure.circuitState]);
    }
    const handoff = await standbyAttempt(db, "native_host_response_timeout", "collecting");
    out.push(["handoff", brief(handoff.claim), handoff.claim.standbyHandoff, handoff.failure.circuitState, core(await lane(db))]);
    out.push(["primaryBack", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
    await advance(db, 2 * 3600);
    out.push(["primaryLater", brief(await claim(db, PRIMARY, "primary", PT))]);
    out.push(["standbyLater", brief(await claim(db, STANDBY, "standby", ST))]);
    return out;
  };
  const a = await run(oldDb);
  const b = await run(newDb);
  assert.deepEqual(b, a);
  const byStep = Object.fromEntries(b.map((entry) => [entry[0], entry]));
  assert.equal(byStep.handoff[2], true);
  assert.equal(byStep.handoff[3], "open");
  assert.deepEqual(byStep.primaryBack[1], [false, "recovery_manual_required", "open", null, true]);
  assert.equal(byStep.primaryBack[2].circuit_reason, "transient_recovery_manual_required");
  assert.equal(byStep.primaryBack[2].transient_system_probe_attempts, 2);
  assert.deepEqual(byStep.primaryLater[1], [false, "recovery_manual_required", "open", null, true]);
  assert.equal(byStep.standbyLater[1][1], "recovery_manual_required");
  const row = await lane(newDb);
  assert.equal(row.circuit_opened_by_worker, PRIMARY, "the standby's failed handoff keeps the primary's episode");
  assert.equal(row.lease_worker_id, null);
});

test("the early probe also needs transient_system_probe_attempts = 0: a counted primary probe keeps the 30-minute wait whatever the column names", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const standbyTransient = {
    circuit_state: "'open'", circuit_reason: "'collecting:naver_page_timeout'", circuit_opened_at: "now() - interval '1 minute'",
    failure_signature: "'collecting:naver_page_timeout'", failure_streak: "2", last_failure_code: "'naver_page_timeout'",
    circuit_opened_by_worker: `'${STANDBY}'`,
  };
  await seed(db, { ...standbyTransient, transient_system_probe_attempts: "1" });
  assert.deepEqual(brief(await claim(db, PRIMARY, "primary", PT)), [false, "circuit_open", "open", null, null]);
  await advance(db, 30 * 60 + 1);
  assert.deepEqual(brief(await claim(db, PRIMARY, "primary", PT)), [true, "granted", "half_open", true, null]);
  assert.equal((await lane(db)).transient_system_probe_attempts, 2);
  // the same circuit with no probe counted is standby-originated: the primary probes at once
  await seed(db, standbyTransient);
  assert.deepEqual(brief(await claim(db, PRIMARY, "primary", PT)), [true, "granted", "half_open", true, null]);
  assert.equal((await lane(db)).transient_system_probe_attempts, 1);
});

test("a standby-opened transient circuit gives the returning primary its first probe at once; the second keeps the 30-minute wait", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await standbyTransientCircuit(db);
  let row = await lane(db);
  assert.equal(row.circuit_opened_by_worker, STANDBY);
  const primary = await claim(db, PRIMARY, "primary", PT);
  assert.deepEqual(brief(primary), [true, "granted", "half_open", true, null]);
  row = await lane(db);
  assert.equal(row.circuit_reason, "auto_transient_system_probe");
  assert.equal(row.transient_system_probe_attempts, 1);
  await progress(db, "collecting");
  const f = await fail(db, PRIMARY, PT, "naver_page_script_failed");
  assert.equal(f.circuitState, "open");
  row = await lane(db);
  assert.equal(row.circuit_opened_by_worker, PRIMARY);
  assert.equal((await claim(db, PRIMARY, "primary", PT)).reason, "circuit_open", "the second probe keeps the 30-minute quiet period");
  await advance(db, 30 * 60 + 1);
  assert.equal((await claim(db, PRIMARY, "primary", PT)).circuitState, "half_open");
  assert.equal((await lane(db)).transient_system_probe_attempts, 2);
});

test("a standby-originated circuit on a Naver-page code with no automatic exit keeps today's manual state (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const run = async (db) => {
    const out = [];
    await seed(db);
    await standbyAttempt(db, "naver_next_data_schema_drift", "collecting");
    await standbyAttempt(db, "naver_next_data_schema_drift", "collecting");
    out.push(["opened", core(await lane(db))]);
    out.push(["primaryBack", brief(await claim(db, PRIMARY, "primary", PT))]);
    await advance(db, 3600);
    out.push(["primaryLater", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
    return out;
  };
  const a = await run(oldDb);
  const b = await run(newDb);
  assert.deepEqual(b, a);
  assert.equal(b[0][1].circuit_reason, "collecting:naver_next_data_schema_drift");
  assert.deepEqual(b[1][1], [false, "circuit_open", "open", null, null]);
  assert.deepEqual(b[2][1], [false, "circuit_open", "open", null, null]);
  assert.equal((await lane(newDb)).circuit_opened_by_worker, STANDBY);
});

test("a standby-device signature from a failed standby handoff in a standby-originated episode gives the returning primary one probe", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const run = async (db) => {
    await standbyTransientCircuit(db);
    await advance(db, 31 * 60);
    const handoff = await standbyAttempt(db, "native_host_collection_failed", "collecting");
    assert.equal(handoff.claim.standbyHandoff, true);
    assert.equal(handoff.failure.circuitState, "open");
    assert.equal((await lane(db)).circuit_reason, "collecting:native_host_collection_failed");
    return claim(db, PRIMARY, "primary", PT);
  };
  assert.deepEqual(brief(await run(oldDb)), [false, "circuit_open", "open", null, null], "old: no automatic exit for this code");
  assert.deepEqual(brief(await run(newDb)), [true, "granted", "half_open", true, null]);
  const row = await lane(newDb);
  assert.equal(row.circuit_reason, "auto_transient_system_probe");
  assert.equal(row.transient_system_probe_attempts, 1);
  assert.equal(row.circuit_opened_by_worker, STANDBY);
});

test("the early probe waits for a live security cooldown and a live lease, and is never given to a standby", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const standbyNavigationCircuit = {
    circuit_state: "'open'", circuit_reason: `'navigating:${NAV}'`, circuit_opened_at: "now() - interval '1 minute'",
    failure_signature: `'navigating:${NAV}'`, failure_streak: "2", last_failure_code: `'${NAV}'`,
    circuit_opened_by_worker: `'${STANDBY}'`,
  };
  await seed(db, { ...standbyNavigationCircuit, cooldown_until: "now() + interval '20 minutes'", last_block_code: "'naver_http_429'" });
  assert.equal((await claim(db, PRIMARY, "primary", PT)).reason, "cooldown");
  assert.equal((await lane(db)).circuit_state, "open");
  await seed(db, { ...standbyNavigationCircuit, lease_worker_id: `'${STANDBY}'`, lease_token: `'${ST}'`, lease_until: "now() + interval '10 minutes'" });
  assert.equal((await claim(db, PRIMARY, "primary", PT)).reason, "busy");
  await seed(db, standbyNavigationCircuit);
  assert.equal((await claim(db, STANDBY, "standby", ST)).reason, "circuit_open");
  await seed(db, { ...standbyNavigationCircuit, circuit_opened_by_worker: `'${PRIMARY}'` });
  assert.equal((await claim(db, PRIMARY, "primary", PT)).reason, "circuit_open");
});

test("a manual terminal the standby caused keeps today's reply while a security cooldown or a live lease stands, then the primary probes (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const terminal = {
    circuit_state: "'open'", circuit_reason: "'transient_recovery_manual_required'", circuit_opened_at: "now() - interval '5 minutes'",
    failure_signature: "'collecting:naver_page_timeout'", failure_streak: "1", last_failure_code: "'naver_page_timeout'",
  };
  const cases = {
    cooldown: { cooldown_until: "now() + interval '20 minutes'", last_block_code: "'naver_http_429'" },
    lease: { lease_worker_id: `'${STANDBY}'`, lease_token: `'${ST}'`, lease_until: "now() + interval '20 minutes'" },
  };
  for (const [name, extra] of Object.entries(cases)) {
    const run = async (db, opener) => {
      await seed(db, { ...terminal, ...extra, ...opener });
      const during = [brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))];
      return during;
    };
    const before = await run(oldDb, {});
    const after = await run(newDb, { circuit_opened_by_worker: `'${STANDBY}'` });
    assert.deepEqual(after, before, name);
    assert.deepEqual(after[0], [false, "recovery_manual_required", "open", null, true], name);
    await advance(newDb, 21 * 60);
    assert.deepEqual(brief(await claim(newDb, PRIMARY, "primary", PT)), [true, "granted", "half_open", true, null], `${name} ended`);
  }
});

test("a stale opener never turns a deliberate stop or a security block into an early probe", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  // a manual close (or a success) leaves the column as it was; the emergency stop button then opens the circuit
  await seed(db, { circuit_opened_by_worker: `'${STANDBY}'` });
  const stopped = (await db.query("select public.mi_stop_naver_shopping_worker('manual_stop') as r")).rows[0].r;
  assert.equal(stopped.accepted, true);
  assert.equal((await lane(db)).circuit_opened_by_worker, STANDBY);
  assert.deepEqual(brief(await claim(db, PRIMARY, "primary", PT)), [false, "circuit_open", "open", null, null]);
  assert.equal((await lane(db)).circuit_reason, "manual_stop");
  // a one-job canary (manual_canary does not clear the opener) that meets a Naver block
  await seed(db, {
    circuit_state: "'half_open'", circuit_reason: "'manual_canary'", circuit_opened_by_worker: `'${STANDBY}'`,
    lease_worker_id: `'${PRIMARY}'`, lease_token: `'${PT}'`, lease_until: "now() + interval '30 minutes'", probe_started_at: "now()",
    primary_seen_at: "now()",
  });
  assert.equal(await block(db, PRIMARY, PT, "naver_http_429"), true);
  let row = await lane(db);
  assert.equal(row.circuit_reason, "probe_security_block");
  assert.equal(row.circuit_opened_by_worker, STANDBY);
  await advance(db, 1801);
  assert.deepEqual(brief(await claim(db, PRIMARY, "primary", PT)), [false, "circuit_open", "open", null, null]);
  row = await lane(db);
  assert.equal(row.circuit_reason, "probe_security_block", "the security path is unchanged");
});

// what mi_record_naver_shopping_worker_success does to the lane on an atomic commit (not re-declared
// here, so it leaves circuit_opened_by_worker as it was)
async function atomicSuccess(db) {
  await db.exec(`update public.naver_shopping_worker_coordination
    set circuit_state = 'closed', circuit_reason = null, circuit_opened_at = null, failure_signature = null,
        failure_streak = 0, transient_system_probe_attempts = 0, probe_tracker_id = null, probe_started_at = null,
        lease_worker_id = null, lease_token = null, lease_until = null, run_id = null,
        current_stage = 'completed', last_success_at = clock_timestamp()`);
}

test("a manual stop with a ':' reason is refused as today, over a stale or a live standby opener (differential)", async (t) => {
  const oldDb = await fixture({ green: false });
  const newDb = await fixture();
  t.after(() => { oldDb.close(); newDb.close(); });
  const stop = async (db, reason) => (await db.query("select public.mi_stop_naver_shopping_worker($1) as r", [reason])).rows[0].r;
  const run = async (db) => {
    const out = [];
    // a standby-originated episode closed by an atomic success: the opener column stays behind
    await standbyTransientCircuit(db);
    await atomicSuccess(db);
    for (const reason of ["owner:maintenance", "collecting:naver_page_timeout", `navigating:${NAV}`]) {
      out.push([reason, await stop(db, reason), brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
      await advance(db, 3600);
      out.push([`${reason} later`, brief(await claim(db, PRIMARY, "primary", PT))]);
    }
    // the stop pressed while a standby-originated circuit is open
    await standbyTransientCircuit(db);
    for (const reason of ["manual_stop", "manual_stop:owner"]) {
      out.push([reason, await stop(db, reason), brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
    }
    return out;
  };
  const a = await run(oldDb);
  const b = await run(newDb);
  assert.deepEqual(b, a);
  for (const entry of b) {
    const reply = entry.length === 2 ? entry[1] : entry[2];
    assert.equal(reply[0], false, entry[0]);
    assert.notEqual(reply[1], "granted", entry[0]);
  }
  assert.equal((await lane(newDb)).circuit_opened_by_worker, STANDBY, "the stop leaves the column; the reason alone keeps the primary out");
});

test("a Naver block on the primary's early probe keeps probe_security_block and its cooldown exactly as today", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await standbyTransientCircuit(db);
  assert.deepEqual(brief(await claim(db, PRIMARY, "primary", PT)), [true, "granted", "half_open", true, null]);
  await progress(db, "collecting");
  assert.equal(await block(db, PRIMARY, PT, "naver_http_429"), true);
  let row = await lane(db);
  assert.equal(row.circuit_state, "open");
  assert.equal(row.circuit_reason, "probe_security_block");
  assert.equal(row.circuit_opened_by_worker, STANDBY, "the block path is not re-declared and leaves the column");
  assert.equal((await claim(db, PRIMARY, "primary", PT)).reason, "cooldown");
  await advance(db, 1801);
  assert.deepEqual(brief(await claim(db, PRIMARY, "primary", PT)), [false, "circuit_open", "open", null, null]);
  row = await lane(db);
  assert.equal(row.circuit_reason, "probe_security_block");
  assert.equal(row.transient_system_probe_attempts, 1);
});

test("a probe that recovers the circuit in release closes the episode and clears the opener", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const tracker = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await db.query("insert into public.naver_rank_trackers(id) values ($1) on conflict do nothing", [tracker]);
  await seed(db, {
    circuit_state: "'open'", circuit_reason: `'navigating:${NAV}'`, circuit_opened_at: "now() - interval '1 minute'",
    failure_signature: `'navigating:${NAV}'`, failure_streak: "2", last_failure_code: `'${NAV}'`,
    circuit_opened_by_worker: `'${STANDBY}'`,
  });
  assert.deepEqual(brief(await claim(db, PRIMARY, "primary", PT)), [true, "granted", "half_open", true, null]);
  assert.equal((await lane(db)).circuit_opened_by_worker, STANDBY);
  await progress(db, "collecting");
  const trackerFailure = await fail(db, PRIMARY, PT, "provider_duplicate_identity", "tracker", tracker);
  assert.equal(trackerFailure.quarantined, true);
  assert.equal(await release(db, PRIMARY, PT), true);
  const row = await lane(db);
  assert.equal(row.circuit_state, "closed");
  assert.equal(row.circuit_reason, null);
  assert.equal(row.circuit_opened_by_worker, null);
});

// A navigation circuit ten minutes old, as the standby's two failures left it on the old functions
// (or a standby-originated one on the new functions when `opener` names the standby).
const navigationCircuit = (opener = {}) => ({
  circuit_state: "'open'", circuit_reason: `'navigating:${NAV}'`, circuit_opened_at: "now() - interval '11 minutes'",
  failure_signature: `'navigating:${NAV}'`, failure_streak: "2", last_failure_code: `'${NAV}'`, ...opener,
});
const standbyOpener = { circuit_opened_by_worker: `'${STANDBY}'` };
// A standby probe on a navigation circuit, or the standby's transient handoff 31 minutes into its own transient circuit.
async function standbyProbe(db, kind, opener) {
  if (kind === "navigation") await seed(db, navigationCircuit(opener));
  else {
    await standbyTransientCircuit(db);
    await advance(db, 31 * 60);
  }
  const probe = await claim(db, STANDBY, "standby", ST);
  assert.equal(probe.granted, true, kind);
  assert.equal(probe.circuitState, "half_open", kind);
  await progress(db, "collecting");
  return [brief(probe), probe.standbyHandoff ?? null];
}
async function releaseAfterWork(db, worker, token) {
  await db.query("insert into public.naver_shopping_scheduler_events(event_type, run_id, lease_started_at) values ('tracker_claimed', $1, now())", [RUN]);
  return release(db, worker, token);
}

// scripts/naver-shopping-local-worker.mjs: when the block-lane call fails the worker only logs
// local_worker_global_cooldown_failed and still releases the lane in finally; a worker that dies
// leaves the lease to expire. The Naver block is then only in last_failure_code.
test("a Naver block recorded on a standby probe whose block call never landed keeps today's state, released or expired (differential)", async (t) => {
  for (const kind of ["navigation", "handoff"]) {
    for (const ending of ["release", "expire"]) {
      const oldDb = await fixture({ green: false });
      const newDb = await fixture();
      t.after(() => { oldDb.close(); newDb.close(); });
      const run = async (db, opener) => {
        const out = [];
        out.push(["probe", ...(await standbyProbe(db, kind, opener))]);
        out.push(["security", await fail(db, STANDBY, ST, "naver_http_429", "security")]);
        if (ending === "release") out.push(["release", await releaseAfterWork(db, STANDBY, ST)]);
        else {
          await advance(db, 2101);
          out.push(["settle", brief(await claim(db, PRIMARY, "primary", PT))]);
        }
        out.push(["primaryBack", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
        await advance(db, 3600);
        out.push(["primaryLater", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
        return out;
      };
      const a = await run(oldDb, {});
      const b = await run(newDb, kind === "navigation" ? standbyOpener : {});
      const label = `${kind} ${ending}`;
      assert.deepEqual(b, a, label);
      const byStep = Object.fromEntries(b.map((entry) => [entry[0], entry]));
      assert.equal(byStep.primaryBack[1][0], false, label);
      assert.equal(byStep.primaryBack[2].circuit_state, "open", label);
      assert.equal(byStep.primaryBack[2].last_failure_code, "naver_http_429", label);
      assert.equal(byStep.primaryBack[2].last_block_code, null, `${label}: no cooldown was applied`);
      assert.equal(byStep.primaryLater[1][0], false, `${label}: still no automatic exit an hour later`);
      const expected = kind === "handoff" && ending === "expire" ? "transient_recovery_manual_required"
        : ending === "expire" ? "probe_interrupted" : "probe_incomplete";
      assert.equal(byStep.primaryLater[2].circuit_reason, expected, label);
      assert.equal((await lane(newDb)).circuit_opened_by_worker, STANDBY, `${label}: a standby-originated episode, still no early probe`);
    }
  }
});

test("a standby probe that ends probe_incomplete on a tracker code keeps today's state (differential)", async (t) => {
  const tracker = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  for (const kind of ["navigation", "handoff"]) {
    const oldDb = await fixture({ green: false });
    const newDb = await fixture();
    t.after(() => { oldDb.close(); newDb.close(); });
    const run = async (db, opener) => {
      const out = [];
      await db.query("insert into public.naver_rank_trackers(id) values ($1) on conflict do nothing", [tracker]);
      out.push(["probe", ...(await standbyProbe(db, kind, opener))]);
      out.push(["tracker", await fail(db, STANDBY, ST, "provider_stable_rendered_order_unproven", "tracker", tracker)]);
      out.push(["release", await releaseAfterWork(db, STANDBY, ST)]);
      out.push(["primaryBack", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
      await advance(db, 3600);
      out.push(["primaryLater", brief(await claim(db, PRIMARY, "primary", PT))]);
      return out;
    };
    const a = await run(oldDb, {});
    const b = await run(newDb, kind === "navigation" ? standbyOpener : {});
    assert.deepEqual(b, a, kind);
    const byStep = Object.fromEntries(b.map((entry) => [entry[0], entry]));
    assert.deepEqual(byStep.primaryBack[1], [false, "circuit_open", "open", null, null], kind);
    assert.equal(byStep.primaryBack[2].circuit_reason, "probe_incomplete", kind);
    assert.equal(byStep.primaryBack[2].last_failure_code, "provider_stable_rendered_order_unproven", kind);
    assert.deepEqual(byStep.primaryLater[1], [false, "circuit_open", "open", null, null], kind);
    assert.equal((await lane(newDb)).circuit_opened_by_worker, STANDBY, kind);
  }
});

test("a circuit opened before this migration (no opener): a failed or incomplete standby navigation probe keeps the 10-minute wait and the column NULL (differential)", async (t) => {
  for (const ending of ["failure", "release"]) {
    const oldDb = await fixture({ green: false });
    const newDb = await fixture();
    t.after(() => { oldDb.close(); newDb.close(); });
    const openers = [];
    const run = async (db) => {
      const out = [];
      out.push(["probe", ...(await standbyProbe(db, "navigation", {}))]);
      await progress(db, "navigating");
      if (ending === "failure") out.push(["failure", await fail(db, STANDBY, ST, NAV)]);
      else out.push(["release", await releaseAfterWork(db, STANDBY, ST)]);
      const row = await lane(db);
      if ("circuit_opened_by_worker" in row) openers.push(row.circuit_opened_by_worker);
      out.push(["primaryBack", brief(await claim(db, PRIMARY, "primary", PT)), core(await lane(db))]);
      await advance(db, 10 * 60 + 1);
      out.push(["afterQuiet", brief(await claim(db, PRIMARY, "primary", PT))]);
      return out;
    };
    const a = await run(oldDb);
    const b = await run(newDb);
    assert.deepEqual(b, a, ending);
    const byStep = Object.fromEntries(b.map((entry) => [entry[0], entry]));
    assert.deepEqual(byStep.primaryBack[1], [false, "circuit_open", "open", null, null], ending);
    assert.equal(byStep.primaryBack[2].circuit_reason, ending === "failure" ? `navigating:${NAV}` : "probe_incomplete", ending);
    assert.deepEqual(byStep.afterQuiet[1], [true, "granted", "half_open", true, null], ending);
    assert.deepEqual(openers, [null], `${ending}: the standby's probe leaves the column NULL`);
    assert.equal((await lane(newDb)).circuit_opened_by_worker, null, ending);
  }
});
