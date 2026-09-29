import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

// 2026-09-29 3차 훈련(KST): 주작업기가 16:04:32 에 묶음을 잡고 수집하던 중 크롬·네이티브 호스트가
// 강제 종료됐다. 죽어 가던 워커는 16:04:39 에 추적기 claim 만 풀고(fail) record-failure·release 전에
// 죽어, 레인 잠금이 16:39:32(35분)까지 남았다. 그 사이 맥 대기기와 16:19:30 에 돌아온 주작업기가 모두
// `busy` 로 거절됐다. 죽은 잠금 인계: 보유자가 6분 동안 아무것도 쓰지 않았고 그 잠금에서 시작한 수집이
// 16분 넘게 지났으면(또는 그 잠금에서 수집이 시작된 적 없으면) 다음 claim 이 그 잠금을 만료로 돌린다.
// 드릴 3 재현, navigating 전에 죽은 잠금(6분), 살아 있는 느린 작업기는 절대 뺏기지 않음, 블록 위치
// (런타임 식별 검사 뒤·조기 탐침 계산 전), 트리거의 심장박동 열·수집 시작 재도장(한 런 안 여러 job 포함),
// 16분 한계가 기대는 코드 상수, 새 열 없는 공정성 픽스처와의 결합, 적용 확인·되돌리기 SQL 을
// 실제 Postgres(PGlite)로 고정한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = path.join(root, "supabase", "migrations");
const nextPattern = /^\d{14}_naver_shopping_dead_lease_takeover\.sql$/u;
const nextNames = fs.readdirSync(migrations).filter((name) => nextPattern.test(name));
const migration = nextNames[0] ? fs.readFileSync(path.join(migrations, nextNames[0]), "utf8") : "";
const sqlDocs = path.join(root, "docs", "sql");
const readDoc = (name) => fs.readFileSync(path.join(sqlDocs, name), "utf8");
const readSource = (file) => fs.readFileSync(path.join(root, file), "utf8");

const FUNCTION_BLOCK = (name) => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "giu");
function lastFunction(file, name) {
  const source = fs.readFileSync(path.join(migrations, file), "utf8");
  const blocks = source.match(FUNCTION_BLOCK(name)) || [];
  assert.ok(blocks.length, `${file} must define ${name}`);
  return blocks.at(-1);
}
function newestFunction(name) {
  let latest = "";
  for (const file of fs.readdirSync(migrations).filter((entry) => /^\d{14}_.+\.sql$/u.test(entry)).sort()) {
    const source = fs.readFileSync(path.join(migrations, file), "utf8");
    for (const match of source.matchAll(FUNCTION_BLOCK(name))) latest = match[0];
  }
  return latest;
}
const ISOLATION = "20260927120000_naver_shopping_standby_failure_isolation.sql";
const OLD = {
  claim: lastFunction(ISOLATION, "mi_claim_naver_shopping_worker_lane"),
  fail: lastFunction(ISOLATION, "mi_record_naver_shopping_worker_failure"),
  rel: lastFunction(ISOLATION, "mi_release_naver_shopping_worker_lane"),
  block: lastFunction("20260821180001_naver_shopping_error_taxonomy_hardening.sql", "mi_block_naver_shopping_worker_lane"),
  touch: lastFunction("20260811095137_naver_shopping_worker_control_plane.sql", "mi_touch_naver_shopping_worker_lane"),
  progress: newestFunction("mi_report_naver_shopping_worker_progress"),
};
const newClaim = migration.match(FUNCTION_BLOCK("mi_claim_naver_shopping_worker_lane"))?.[0] || "";
// The live progress gate pins the runtime; read it instead of writing a literal here.
const VERSION = OLD.progress.match(/expected_runtime_version constant text := '([^']+)'/u)[1];
const FINGERPRINT = OLD.progress.match(/expected_runtime_fingerprint constant text :=\s*'([a-f0-9]{64})'/u)[1];
const OTHER_FINGERPRINT = FINGERPRINT.replace(/^./u, (first) => (first === "0" ? "1" : "0"));
const MARKER = "mi:dead-lease-takeover";
const NEW_COLUMNS = [
  "lease_heartbeat_at",
  "lease_collection_started_at",
  "lease_reaped_at",
  "lease_reaped_worker_id",
  "lease_reaped_run_id",
  "lease_reaped_stage",
  "lease_reaped_by_worker_id",
];

const PRIMARY = "windows-desktop-primary";
const STANDBY = "macbook-standby";
const T1604 = "11111111-1111-4111-8111-111111111111"; // the run that died
const TPOLL = "33333333-3333-4333-8333-333333333333";
const TCATCH = "44444444-4444-4444-8444-444444444444";
const TSTANDBY = "22222222-2222-4222-8222-222222222222";
const RUN1604 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUNPOLL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUNCATCH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUNSTANDBY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TRACKER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

async function fixture({ green = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema mi_internal;
    create table public.naver_shopping_worker_coordination (
      lane_key text primary key,
      circuit_state text not null default 'closed', circuit_reason text, circuit_opened_at timestamptz,
      failure_signature text, failure_streak integer not null default 0,
      transient_system_probe_attempts integer not null default 0,
      probe_tracker_id uuid, probe_started_at timestamptz,
      primary_worker_id text, primary_seen_at timestamptz,
      lease_worker_id text, lease_token uuid, lease_until timestamptz,
      cooldown_until timestamptz, last_block_code text, run_id uuid,
      runtime_version text, runtime_fingerprint text,
      current_stage text, current_page integer not null default 0, current_job_kind text,
      current_tracker_id uuid, current_job_started_at timestamptz,
      last_success_at timestamptz, last_failure_at timestamptz, last_failure_code text,
      cadence_mode text not null default 'baseline', cadence_minutes integer not null default 10,
      stability_started_at timestamptz, success_streak integer not null default 0,
      transient_standby_handoff_at timestamptz, transient_standby_handoff_worker_id text,
      transient_standby_handoff_success_at timestamptz,
      circuit_opened_by_worker text, standby_failure_worker_id text,
      standby_failure_streak integer not null default 0, standby_last_failure_at timestamptz,
      standby_last_failure_code text, standby_benched_until timestamptz,
      updated_at timestamptz default now()
    );
    create table public.naver_rank_trackers (id uuid primary key, status text not null default 'active',
      processing_until timestamptz, worker_quarantined_until timestamptz, retry_count integer default 0);
    create table public.naver_shopping_rank_lookup_jobs (id uuid primary key, status text, processing_until timestamptz);
    create table public.naver_shopping_worker_runs (run_id uuid primary key, worker_id text, run_trigger text,
      runtime_version text, runtime_fingerprint text, started_at timestamptz);
    create table public.naver_shopping_scheduler_events (event_id bigint generated always as identity primary key,
      event_type text, run_id uuid, claim_id uuid, tracker_id uuid, worker_id text, group_fingerprint text,
      error_code text, priority text, lease_started_at timestamptz);
  `);
  for (const sql of [OLD.fail, OLD.claim, OLD.rel, OLD.block, OLD.touch, OLD.progress]) await db.exec(sql);
  if (green) await db.exec(migration);
  await db.exec(`insert into public.naver_shopping_worker_coordination (lane_key, primary_worker_id, primary_seen_at,
    runtime_version, runtime_fingerprint, last_success_at) values ('global', '${PRIMARY}', now(), '${VERSION}', '${FINGERPRINT}', now() - interval '10 minutes')`);
  return db;
}

// Moving every timestamp back is the same as advancing the clock; the stamping trigger is
// disabled for the shift so the shift itself is not a holder write.
async function advance(db, seconds) {
  const columns = (await db.query(`select column_name from information_schema.columns
    where table_schema='public' and table_name='naver_shopping_worker_coordination'
      and data_type='timestamp with time zone'`)).rows.map((row) => row.column_name);
  const trig = (await db.query("select 1 from pg_trigger where tgname='trg_mi_stamp_naver_shopping_worker_lease_heartbeat'")).rows.length;
  if (trig) await db.exec("alter table public.naver_shopping_worker_coordination disable trigger trg_mi_stamp_naver_shopping_worker_lease_heartbeat");
  await db.exec(`update public.naver_shopping_worker_coordination set ${columns
    .map((column) => `${column} = ${column} - make_interval(secs => ${Number(seconds)})`).join(", ")}`);
  await db.exec(`update public.naver_rank_trackers set processing_until = processing_until - make_interval(secs => ${Number(seconds)})`);
  if (trig) await db.exec("alter table public.naver_shopping_worker_coordination enable trigger trg_mi_stamp_naver_shopping_worker_lease_heartbeat");
}
const lane = async (db) => (await db.query("select * from public.naver_shopping_worker_coordination")).rows[0];
const claim = async (db, worker, role, token, fingerprint = FINGERPRINT) => (await db.query(
  "select public.mi_claim_naver_shopping_worker_lane($1,$2,$3,2100,180,$4,$5) as r", [worker, role, token, VERSION, fingerprint])).rows[0].r;
async function progress(db, worker, token, run, stage, page, { trigger = "rank-catch-up", kind = "tracker", tracker = TRACKER } = {}) {
  return (await db.query(
    "select public.mi_report_naver_shopping_worker_progress($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r",
    [worker, token, run, stage, page, kind, tracker, VERSION, FINGERPRINT, trigger])).rows[0].r;
}
const touch = async (db, worker, token) => (await db.query("select public.mi_touch_naver_shopping_worker_lane($1,$2,2100) as r", [worker, token])).rows[0].r;
const release = async (db, worker, token) => (await db.query("select public.mi_release_naver_shopping_worker_lane($1,$2) as r", [worker, token])).rows[0].r;
const fail = async (db, worker, token, run, code) => (await db.query(
  "select public.mi_record_naver_shopping_worker_failure($1,$2,$3,$4,'system',null) as r", [worker, token, run, code])).rows[0].r;
// claim-lane as the server handler does it: grant, then register the run as `claiming`.
async function claimLane(db, worker, role, token, run, trigger) {
  const r = await claim(db, worker, role, token);
  if (r.granted) assert.equal(await progress(db, worker, token, run, "claiming", 0, { trigger, kind: "", tracker: null }), true);
  return r;
}
// The `claim` action before every job of a run (handler): touch, then the idle `claiming` envelope.
async function claimJob(db, worker, token, run, trigger) {
  assert.equal(await touch(db, worker, token), true);
  assert.equal(await progress(db, worker, token, run, "claiming", 0, { trigger, kind: "", tracker: null }), true);
}
// One-minute rank-remote poll: grant, no wake, release.
async function poll(db, token = TPOLL) {
  const r = await claimLane(db, PRIMARY, "primary", token, RUNPOLL, "rank-remote");
  if (r.granted) assert.equal(await release(db, PRIMARY, token), true);
  return r;
}
const collectionAgeSeconds = async (db) => Number((await db.query(`select extract(epoch from clock_timestamp()
  - lease_collection_started_at) as age from public.naver_shopping_worker_coordination`)).rows[0].age);

test("migration is runtime neutral, marked, and only inserts the takeover into the newest claim body", () => {
  assert.equal(nextNames.length, 1, "exactly one dead-lease takeover migration");
  assert.doesNotMatch(migration, /\b1\.1\.\d+\b|[a-f0-9]{64}/u);
  assert.equal((migration.match(/create or replace function/gu) || []).length, 2);
  assert.equal((migration.match(/security invoker/gu) || []).length, 2);
  assert.equal((migration.match(/set search_path = ''/gu) || []).length, 2);
  assert.match(migration, /^begin;$/mu);
  assert.match(migration, /^commit;$/mu);
  assert.match(migration, /before update on public\.naver_shopping_worker_coordination\s+for each row execute function mi_internal\.mi_stamp_naver_shopping_worker_lease_heartbeat\(\);/u);
  assert.match(migration, /revoke all on function mi_internal\.mi_stamp_naver_shopping_worker_lease_heartbeat\(\)\s+from public, anon, authenticated, service_role;/u);
  assert.match(migration, /revoke all on function public\.mi_claim_naver_shopping_worker_lane\(\s*text, text, uuid, integer, integer, text, text\s*\) from public, anon, authenticated, service_role;/u);
  assert.match(migration, /grant execute on function public\.mi_claim_naver_shopping_worker_lane\(\s*text, text, uuid, integer, integer, text, text\s*\) to service_role;/u);
  for (const column of NEW_COLUMNS) assert.match(migration, new RegExp(`add column if not exists ${column} `, "u"));
  // the marker sits inside both function bodies, so the applied check can read prosrc
  const trigger = migration.match(/create or replace function mi_internal\.mi_stamp_naver_shopping_worker_lease_heartbeat\(\)[\s\S]*?\n\$\$;/u)[0];
  assert.match(trigger, /\nas \$\$\n-- mi:dead-lease-takeover 2026-09-29\n/u);
  assert.equal(newClaim.split(MARKER).length - 1, 1);
  assert.match(newClaim, /\nas \$\$\n-- mi:standby-failure-isolation 2026-09-27\n-- mi:dead-lease-takeover 2026-09-29\n/u, "the 09-27 applied marker stays");
  const stripped = newClaim
    .replace("-- mi:dead-lease-takeover 2026-09-29\n", "")
    .replace(/  -- 2026-09-29 \(dead-lease takeover\)[\s\S]*?returning \* into current_row;\n    end if;\n  end if;\n\n/u, "");
  assert.equal(stripped, OLD.claim, "everything else is the 20260927120000 body byte for byte");
  assert.doesNotMatch(migration, /create or replace function public\.mi_report_naver_shopping_worker_progress/u, "the runtime pin is never re-declared here");
});

test("the takeover sits after the runtime identity refusal and before the early probe and busy rules", () => {
  const at = (needle) => {
    const index = newClaim.indexOf(needle);
    assert.ok(index > 0, needle);
    return index;
  };
  const takeover = at("  -- 2026-09-29 (dead-lease takeover)");
  assert.ok(at("'reason', 'runtime_identity_invalid'") < takeover);
  assert.ok(takeover < at("early_probe_code := case"));
  assert.ok(takeover < at("'reason', 'recovery_manual_required'"));
  assert.ok(takeover < at("'reason', 'cooldown'"));
  assert.ok(takeover < at("'reason', 'busy'"));
  assert.ok(takeover < at("-- Expired probes must be settled before role admission."));
  assert.ok(takeover < at("'reason', 'primary_online'"));
});

test("applies twice; the trigger stamps only holder writes and clears with the lease", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await db.exec(migration);
  const r = await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up");
  assert.equal(r.granted, true);
  let row = await lane(db);
  assert.ok(row.lease_heartbeat_at, "grant stamps");
  assert.equal(row.lease_collection_started_at, null);
  await advance(db, 120);
  const before = (await lane(db)).lease_heartbeat_at;
  // another worker's poll (busy) moves primary_seen_at / updated_at only
  assert.equal((await claim(db, STANDBY, "standby", TSTANDBY)).reason, "busy");
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy");
  row = await lane(db);
  assert.ok(row.primary_seen_at > before, "the poll did move primary_seen_at");
  assert.equal(row.lease_heartbeat_at.getTime(), before.getTime());
  // a hand-written value never sticks
  await db.exec("update public.naver_shopping_worker_coordination set lease_heartbeat_at = now() + interval '1 day', lease_collection_started_at = now()");
  row = await lane(db);
  assert.equal(row.lease_heartbeat_at.getTime(), before.getTime());
  assert.equal(row.lease_collection_started_at, null);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0), true);
  row = await lane(db);
  assert.ok(row.lease_heartbeat_at > before);
  assert.ok(row.lease_collection_started_at);
  const nav = row.lease_collection_started_at;
  await advance(db, 5);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "collecting", 1), true);
  row = await lane(db);
  assert.equal(row.lease_collection_started_at.getTime(), nav.getTime() - 5000, "collection start stays at navigating");
  await advance(db, 30);
  const h = (await lane(db)).lease_heartbeat_at;
  assert.equal(await touch(db, PRIMARY, T1604), true);
  assert.ok((await lane(db)).lease_heartbeat_at > h, "touch is a heartbeat");
  // a failure that keeps the lane is a heartbeat on its own: the second one leaves current_stage
  // at 'failed', so last_failure_at is the only watched column it changes
  const securityFailure = async () => (await db.query(
    "select public.mi_record_naver_shopping_worker_failure($1,$2,$3,'naver_http_429','security',null) as r",
    [PRIMARY, T1604, RUN1604])).rows[0].r;
  for (const round of [1, 2]) {
    await advance(db, 30);
    const beforeFailure = await lane(db);
    if (round === 2) assert.equal(beforeFailure.current_stage, "failed");
    const recorded = await securityFailure();
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.laneReleased, false);
    const afterFailure = await lane(db);
    assert.equal(afterFailure.circuit_state, "closed");
    assert.equal(afterFailure.current_stage, "failed");
    assert.ok(afterFailure.lease_heartbeat_at > beforeFailure.lease_heartbeat_at, `failure ${round} is a heartbeat`);
  }
  // atomic success writes last_success_at (its RPCs are not in this fixture): a heartbeat on its own
  await advance(db, 30);
  const beforeSuccess = (await lane(db)).lease_heartbeat_at;
  await db.exec("update public.naver_shopping_worker_coordination set last_success_at = now()");
  assert.ok((await lane(db)).lease_heartbeat_at > beforeSuccess, "last_success_at is a heartbeat");
  assert.equal(await release(db, PRIMARY, T1604), true);
  row = await lane(db);
  assert.equal(row.lease_heartbeat_at, null);
  assert.equal(row.lease_collection_started_at, null);
});

// Drill 3 timeline (KST): 16:04:32 claim, 16:04:32.66 navigating, 16:04:35 page 1,
// 16:04:39 the `fail` action and death (no record-failure, no release). The primary was off
// until 16:19:30 and then polled every minute (at :25); rank-catch-up alarms at :x4:32.
async function drill3(db) {
  const out = {};
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  await advance(db, 0.66);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0), true);
  await advance(db, 2.34);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "collecting", 1), true);
  await advance(db, 4); // 16:04:39 dies
  await advance(db, 5 * 60 + 53); // 16:10:32 standby alarm: primary stale since 16:07:32
  out.standby1610 = await claim(db, STANDBY, "standby", TSTANDBY);
  await advance(db, 8 * 60 + 58); // 16:19:30 primary back
  out.poll1619 = await poll(db);
  await advance(db, 55); // 16:20:25
  out.poll1620 = await poll(db);
  await advance(db, 60); // 16:21:25 (navigating + 16:52)
  out.poll1621 = await poll(db);
  out.afterPoll = await lane(db);
  await advance(db, 187); // 16:24:32 rank-catch-up
  out.catch1624 = await claimLane(db, PRIMARY, "primary", TCATCH, RUNCATCH, "rank-catch-up");
  out.afterCatch = await lane(db);
  // the dead run, were it still alive, is out
  out.oldProgress = await progress(db, PRIMARY, T1604, RUN1604, "collecting", 2);
  out.oldFailure = await fail(db, PRIMARY, T1604, RUN1604, "native_host_input_closed");
  out.oldRelease = await release(db, PRIMARY, T1604);
  out.final = await lane(db);
  return out;
}

test("drill 3: the restored primary takes the dead lease within one alarm, not at 16:44", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const out = await drill3(db);
  assert.equal(out.standby1610.reason, "busy", "16:10: silent 6 min but collection started 6 min ago");
  assert.equal(out.poll1619.reason, "busy", "16:19:30: navigating + 14:58");
  assert.equal(out.poll1620.reason, "busy", "16:20:25: navigating + 15:53 < 16 min");
  assert.equal(out.poll1621.granted, true, "16:21:25: dead lease taken over");
  assert.equal(out.afterPoll.lease_worker_id, null, "the poll released it without a wake");
  assert.equal(out.afterPoll.lease_reaped_worker_id, PRIMARY);
  assert.equal(out.afterPoll.lease_reaped_run_id, RUN1604);
  assert.equal(out.afterPoll.lease_reaped_stage, "collecting");
  assert.equal(out.afterPoll.lease_reaped_by_worker_id, PRIMARY);
  assert.equal(out.catch1624.granted, true);
  assert.equal(out.afterCatch.lease_token, TCATCH);
  assert.equal(out.afterCatch.circuit_state, "closed");
  assert.equal(out.oldProgress, false);
  assert.deepEqual(out.oldFailure, { recorded: false, reason: "lease_lost" });
  assert.equal(out.oldRelease, false);
  assert.equal(out.final.lease_token, TCATCH, "the new run keeps the lane");
  assert.equal(out.final.failure_streak, 0);
});

test("drill 3 before the migration: busy until 16:39:32 (differential)", async (t) => {
  const db = await fixture({ green: false });
  t.after(() => db.close());
  const out = await drill3(db);
  for (const key of ["standby1610", "poll1619", "poll1620", "poll1621", "catch1624"]) assert.equal(out[key].reason, "busy", key);
  assert.equal(out.oldProgress, true, "the dead run still owns the lane");
  await release(db, PRIMARY, T1604);
});

// A worker can die between the grant and its first `navigating`: Windows shuts down during the
// one-minute poll's grant -> claim-wake -> release, or the native host is killed right after
// claim-lane / queue-all. No collection ever started under that lease
// (lease_collection_started_at is null), so 6 minutes of holder silence alone hands it over.
test("a lease that never reached `navigating` is taken over after 6 silent minutes, not at lease_until (differential)", async () => {
  const cases = [
    { name: "grant only, the standby claims", job: false, claimer: [STANDBY, "standby", TSTANDBY, RUNSTANDBY, "mac-standby"] },
    { name: "grant and one job claim, the primary's next run claims", job: true, claimer: [PRIMARY, "primary", TCATCH, RUNCATCH, "rank-catch-up"] },
  ];
  for (const c of cases) {
    for (const green of [true, false]) {
      const db = await fixture({ green });
      let elapsed = 0;
      let leaseFrom = 0; // the grant, or the job claim's touch, sets lease_until 35 minutes ahead
      const wait = async (seconds) => {
        elapsed += seconds;
        await advance(db, seconds);
      };
      const [worker, role, token, run, trigger] = c.claimer;
      assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-remote")).granted, true);
      if (c.job) {
        await wait(30);
        await claimJob(db, PRIMARY, T1604, RUN1604, "rank-remote");
        leaseFrom = elapsed;
      }
      // the worker dies here: no `navigating`, no record-failure, no release
      await wait(5 * 60 + 59);
      assert.equal((await claim(db, worker, role, token)).reason, "busy", `${c.name} (${green}): 5:59 silent`);
      await wait(2);
      const before = await lane(db);
      assert.equal(before.lease_token, T1604);
      assert.equal(before.current_stage, "claiming");
      if (green) {
        assert.ok(before.lease_heartbeat_at, "a lease granted after the migration has a heartbeat");
        assert.equal(before.lease_collection_started_at, null, "no collection started under it");
        const r = await claimLane(db, worker, role, token, run, trigger);
        assert.equal(r.granted, true, `${c.name}: 6:01 silent, never navigating`);
        const row = await lane(db);
        assert.equal(row.lease_token, token);
        assert.equal(row.lease_reaped_worker_id, PRIMARY);
        assert.equal(row.lease_reaped_run_id, RUN1604);
        assert.equal(row.lease_reaped_stage, "claiming");
        assert.equal(row.lease_reaped_by_worker_id, worker);
        assert.equal(row.circuit_state, "closed");
      } else {
        // before the migration the same lease blocks every other claim until lease_until
        assert.equal((await claim(db, worker, role, token)).reason, "busy", `${c.name}: 6:01 silent`);
        await wait(leaseFrom + 35 * 60 - elapsed - 1);
        assert.equal((await claim(db, worker, role, token)).reason, "busy", `${c.name}: 1 s before lease_until`);
        await wait(2);
        assert.equal((await claimLane(db, worker, role, token, run, trigger)).granted, true, `${c.name}: lease_until passed`);
      }
      await db.close();
    }
  }
});

test("standby (b): takes a dead primary lease only while the primary heartbeat is stale", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0), true);
  await advance(db, 16 * 60 + 1);
  // primary machine alive (its poll just ran): the standby may expire the lease but not take it
  await db.exec("update public.naver_shopping_worker_coordination set primary_seen_at = now()");
  const refused = await claim(db, STANDBY, "standby", TSTANDBY);
  assert.equal(refused.reason, "primary_online");
  let row = await lane(db);
  assert.ok(row.lease_until <= new Date(), "expired in place");
  assert.equal(row.lease_reaped_by_worker_id, STANDBY);
  // primary machine gone as well
  await advance(db, 181);
  const granted = await claimLane(db, STANDBY, "standby", TSTANDBY, RUNSTANDBY, "mac-standby");
  assert.equal(granted.granted, true);
  row = await lane(db);
  assert.equal(row.lease_worker_id, STANDBY);
});

test("a caller refused runtime_identity_invalid never takes a dead lease over (block after the identity check)", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0), true);
  await advance(db, 16 * 60 + 1); // dead by both rules, primary stale
  const leaseUntil = (await lane(db)).lease_until;
  // a standby on another runtime than the one the dead primary registered
  const refused = await claim(db, STANDBY, "standby", TSTANDBY, OTHER_FINGERPRINT);
  assert.equal(refused.reason, "runtime_identity_invalid");
  let row = await lane(db);
  assert.equal(row.lease_reaped_at, null);
  assert.equal(row.lease_until.getTime(), leaseUntil.getTime(), "the lease is untouched");
  assert.equal(row.lease_token, T1604);
  // the same standby on the registered runtime takes it over
  const granted = await claimLane(db, STANDBY, "standby", TSTANDBY, RUNSTANDBY, "mac-standby");
  assert.equal(granted.granted, true);
  row = await lane(db);
  assert.equal(row.lease_reaped_by_worker_id, STANDBY);
  assert.equal(row.lease_worker_id, STANDBY);
});

// Constructed state (a dead lease over an open, standby-originated circuit with the 09-27 manual
// terminal): the primary's early probe is computed after the takeover, so the takeover answers
// exactly like the 35-minute expiry. A takeover placed after the early-probe computation would
// answer recovery_manual_required here.
test("the primary's early probe sees the takeover exactly like the 35-minute expiry (differential)", async () => {
  const outcomes = [];
  for (const green of [true, false]) {
    const db = await fixture({ green });
    await db.exec(`update public.naver_shopping_worker_coordination set circuit_state='open',
      circuit_reason='transient_recovery_manual_required', circuit_opened_at = now(),
      circuit_opened_by_worker='${STANDBY}', transient_system_probe_attempts = 0,
      last_failure_code='naver_page_navigation_failed', primary_seen_at = now() - interval '1 hour',
      lease_worker_id='${STANDBY}', lease_token='${TSTANDBY}', lease_until = now() + interval '35 minutes',
      run_id='${RUNSTANDBY}', current_stage='navigating', current_job_kind='tracker',
      current_tracker_id='${TRACKER}', current_job_started_at = now()`);
    await advance(db, green ? 16 * 60 + 1 : 35 * 60 + 1);
    const r = await claim(db, PRIMARY, "primary", TPOLL);
    const row = await lane(db);
    outcomes.push([r.granted, r.reason, r.circuitState, r.autoRecovery ?? null, row.circuit_state, row.circuit_reason, row.lease_worker_id]);
    if (green) assert.equal(row.lease_reaped_worker_id, STANDBY);
    await db.close();
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0][0], true, "the returning primary probes at once, as after the plain expiry");
  assert.equal(outcomes[0][4], "half_open");
});

test("a slow live worker is never taken over", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0), true);
  // one page every 95 s (the per-page bound) for 14 minutes, then submit silence of 5:59
  for (let page = 1; page <= 8; page += 1) {
    await advance(db, 95);
    assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "collecting", page), true);
    await db.exec("update public.naver_shopping_worker_coordination set primary_seen_at = now() - interval '10 minutes'");
    assert.equal((await claim(db, STANDBY, "standby", TSTANDBY)).reason, "busy");
    assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy");
  }
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "submitting", 8), true);
  await advance(db, 359); // 5:59 silent, navigating + 18:39
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy");
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "completed", 8), true);
  // silent 7 minutes but its collection started 12 minutes ago (a stuck page): still busy
  await claimJob(db, PRIMARY, T1604, RUN1604, "rank-catch-up");
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0), true);
  await advance(db, 5 * 60);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "collecting", 1), true);
  await advance(db, 7 * 60);
  assert.equal((await claim(db, STANDBY, "standby", TSTANDBY)).reason, "busy");
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy");
  assert.equal((await lane(db)).lease_token, T1604);
  assert.equal((await lane(db)).lease_reaped_at, null);
});

// A bounded run drains several jobs under one lease. The server writes the idle `claiming`
// envelope before every job, so the next job's `navigating` starts a new collection even when
// both are lookups (tracker null) and the first one failed at `navigating`.
test("every job of a run restarts the collection clock (multi-job re-stamp)", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const lookup = { trigger: "rank-catch-up", kind: "lookup", tracker: null };
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  await claimJob(db, PRIMARY, T1604, RUN1604, "rank-catch-up");
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0, lookup), true);
  // job 1 hangs until its request deadline and fails (the `fail` action writes no lane column)
  await advance(db, 14 * 60 + 30);
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy", "navigating + 14:30, silent 14:30");
  await claimJob(db, PRIMARY, T1604, RUN1604, "rank-catch-up");
  await advance(db, 1);
  assert.ok(await collectionAgeSeconds(db) >= 14 * 60 + 31, "the `claiming` envelope keeps job 1's start");
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0, lookup), true);
  assert.ok(await collectionAgeSeconds(db) < 5, "job 2 restarted the collection clock");
  // the worker dies right after job 2 started: 6:01 silent, 20:32 after job 1 but 6:01 after job 2
  await advance(db, 6 * 60 + 1);
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy");
  assert.equal((await lane(db)).lease_reaped_at, null);
  await advance(db, 10 * 60);
  assert.equal((await poll(db)).granted, true, "job 2 navigating + 16:01");
  const row = await lane(db);
  assert.equal(row.lease_reaped_stage, "navigating");
  assert.equal(row.lease_reaped_run_id, RUN1604);
  // without the server's `claiming` envelope a repeated lookup `navigating` would not restart it
  assert.equal((await claimLane(db, PRIMARY, "primary", TCATCH, RUNCATCH, "rank-catch-up")).granted, true);
  assert.equal(await progress(db, PRIMARY, TCATCH, RUNCATCH, "navigating", 0, lookup), true);
  const once = (await lane(db)).lease_collection_started_at;
  await advance(db, 60);
  assert.equal(await progress(db, PRIMARY, TCATCH, RUNCATCH, "navigating", 0, lookup), true);
  assert.equal((await lane(db)).lease_collection_started_at.getTime(), once.getTime() - 60_000);
  // so the handler must keep writing it before every job claim
  const handler = readSource("src/server/handlers/naver-shopping-local-worker.mjs");
  assert.match(
    handler,
    /if \(body\.action === "claim"\) \{\s*workerControlInput\(body\);\s*await touchWorkerLane\(ctx, body\);[\s\S]{0,400}?await reportWorkerProgress\(ctx, \{\s*\.\.\.body,\s*stage: "claiming",\s*page: 0,\s*jobKind: "",\s*trackerId: null,\s*\}\);[\s\S]{0,200}?let job;/u,
  );
});

// Defensive trigger rules the current code never reaches (every grant sets `claiming` and the
// handler writes the `claiming` envelope before every job): a `navigating` for another tracker or
// under another run, and a grant that lands in `navigating`, each start a new collection.
test("the collection start is re-stamped for another tracker, another run and a grant into navigating", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  const otherTracker = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0), true);
  await advance(db, 60);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0, { tracker: otherTracker }), true);
  assert.ok(await collectionAgeSeconds(db) < 5, "navigating for another tracker restarts it");
  await advance(db, 60);
  // the progress gate keeps run_id for the lease, so only a direct write changes it
  await db.exec(`update public.naver_shopping_worker_coordination set run_id = '${RUNCATCH}'`);
  assert.ok(await collectionAgeSeconds(db) < 5, "navigating under another run restarts it");
  await advance(db, 60);
  assert.equal(await progress(db, PRIMARY, T1604, RUNCATCH, "navigating", 0, { tracker: otherTracker }), true);
  assert.ok(await collectionAgeSeconds(db) >= 60, "the same tracker and run keep it");
  await db.exec(`update public.naver_shopping_worker_coordination set lease_token = '${TCATCH}',
    lease_until = now() + interval '35 minutes', current_stage = 'navigating'`);
  const row = await lane(db);
  assert.ok(row.lease_collection_started_at, "a grant into navigating starts a collection");
  assert.ok(await collectionAgeSeconds(db) < 5);
  assert.ok(row.lease_heartbeat_at >= row.lease_collection_started_at);
});

// The 16-minute collection bound is an arithmetic on code constants; this pins each of them.
test("the 6- and 16-minute bounds hold for the code constants they rely on", () => {
  const minutes = (pattern) => Number(newClaim.match(pattern)[1]) * 60_000;
  const heartbeatBoundMs = minutes(/lease_heartbeat_at <= v_now - interval '(\d+) minutes'/u);
  const collectionBoundMs = minutes(/lease_collection_started_at <= v_now - interval '(\d+) minutes'/u);
  const constant = (source, name) => {
    const match = source.match(new RegExp(`const ${name} = ([0-9_]+(?: \\* [0-9_]+)?);`, "u"));
    assert.ok(match, name);
    return match[1].split(" * ").reduce((product, factor) => product * Number(factor.replaceAll("_", "")), 1);
  };
  const contract = readSource("src/server/naver-shopping/local-worker-contract.mjs");
  const worker = readSource("scripts/naver-shopping-local-worker.mjs");
  const extension = readSource("tools/naver-shopping-chrome-extension/service-worker.js");

  // the request deadline: at most 14 minutes after the `navigating` report returned
  const requestTimeoutMs = constant(contract, "LOCAL_WORKER_REQUEST_TIMEOUT_MS");
  assert.match(contract, /Math\.min\(LOCAL_WORKER_REQUEST_TIMEOUT_MS, Number\(timeoutMs \|\| LOCAL_WORKER_REQUEST_TIMEOUT_MS\)\)/u);
  assert.match(contract, /deadlineAt: new Date\(Number\(nowMs\) \+ boundedTimeout\)\.toISOString\(\)/u);
  const navigating = worker.indexOf('await reportProgress("navigating", 0, job);');
  const request = worker.indexOf("const request = localWorkerRankRequest(");
  assert.ok(navigating > 0 && navigating < request, "the deadline is set after the navigating report returned");
  assert.match(worker.slice(request, request + 200), /localWorkerRankRequest\(\s*job,\s*options\.nowMs\?\.\(\) \?\? Date\.now\(\),/u);
  // that report returns within the default API timeout (the variable is set nowhere, below)
  const apiTimeoutMs = constant(worker, "DEFAULT_REQUEST_TIMEOUT_MS");
  const submitTimeoutMs = constant(worker, "DEFAULT_SUBMIT_TIMEOUT_MS");
  assert.match(worker, /timeoutMs: payload\?\.action === "submit"\s*\? boundedInteger\(\s*env\.MI_NAVER_SHOPPING_LOCAL_WORKER_SUBMIT_TIMEOUT_MS,\s*DEFAULT_SUBMIT_TIMEOUT_MS,[\s\S]{0,80}?: boundedInteger\(\s*env\.MI_NAVER_SHOPPING_LOCAL_WORKER_API_TIMEOUT_MS,\s*DEFAULT_REQUEST_TIMEOUT_MS,/u);
  assert.match(worker, /const timeout = setTimeout\(\(\) => controller\.abort\(\), options\.timeoutMs \|\| DEFAULT_REQUEST_TIMEOUT_MS\);/u);
  // every delivered page is a holder write (progress `collecting`)
  assert.match(worker, /options\.registerProgressSink\?\.\(async \(input = \{\}\) => \{[\s\S]{0,400}?await reportProgress\("collecting", page\);/u);

  // the extension: no navigation once the deadline passed; a page load ends within its timeouts
  const pageTimeoutMs = constant(extension, "PAGE_TIMEOUT_MS");
  const pageScriptTimeoutMs = constant(extension, "PAGE_SCRIPT_TIMEOUT_MS");
  const pageIntervalMs = constant(extension, "PAGE_REQUEST_INTERVAL_MS");
  const pageJitterMs = constant(extension, "PAGE_REQUEST_JITTER_MS");
  const collect = extension.slice(extension.indexOf("async function collectPages("), extension.indexOf("async function saveStatus("));
  assert.match(collect, /const deadline = Math\.min\(Date\.now\(\) \+ COLLECTION_TIMEOUT_MS, requestDeadline\);/u);
  assert.match(collect, /for \(let pageIndex = pageStart; pageIndex <= pageEnd; pageIndex \+= 1\) \{\s*assertWithinDeadline\(\);/u);
  assert.match(collect, /await waitForTabComplete\(tabId\);\s*assertWithinDeadline\(\);/u);
  assert.match(collect, /await wait\(pageRequestDelay\(\)\);\s*assertWithinDeadline\(\);/u);
  assert.equal((collect.match(/openCollectionTab\(url\)|chrome\.tabs\.update\(tabId, \{ url, active: false \}\)/gu) || []).length, 2, "the only two navigations in collectPages");
  assert.ok(collect.indexOf("assertWithinDeadline();") < collect.indexOf("openCollectionTab(url)"));
  assert.match(extension, /\}, PAGE_TIMEOUT_MS\);/u);
  assert.match(extension, /\}\), PAGE_SCRIPT_TIMEOUT_MS, "naver_page_script_timeout"\);/u);

  // 16 minutes: navigating (DB) -> report returns (<= API timeout) -> deadline (+14 min) ->
  // a navigation started just before it ends within the tab-load and script timeouts.
  const lastNaverRequestEndsMs = apiTimeoutMs + requestTimeoutMs + pageTimeoutMs + pageScriptTimeoutMs;
  assert.equal(lastNaverRequestEndsMs, 15.5 * 60_000);
  assert.ok(lastNaverRequestEndsMs < collectionBoundMs, `${lastNaverRequestEndsMs} ms must stay below ${collectionBoundMs} ms`);
  // 6 minutes: the longest holder silence while collecting (one page) and after `submitting`
  // (submit, then reconcile-submit, fail and record-failure) at the default timeouts
  const onePageMs = pageTimeoutMs + pageScriptTimeoutMs + pageIntervalMs + pageJitterMs + apiTimeoutMs;
  const afterSubmittingMs = submitTimeoutMs + 3 * apiTimeoutMs;
  assert.equal(afterSubmittingMs, 210_000);
  assert.ok(onePageMs < heartbeatBoundMs && afterSubmittingMs < heartbeatBoundMs);
  assert.ok(heartbeatBoundMs < collectionBoundMs, "a live collection is protected by the 16-minute rule alone");

  // the API timeout variable is only read by the worker: no installer, wrapper or config sets it.
  // Dot files are read as well (.env.example, .env.local, .npmrc, ...). Skipped: VCS data,
  // dependencies, build output and .claude (gitignored; in the main checkout it holds agents'
  // worktrees, full copies of this repository whose worker file would be listed here).
  const setters = [];
  const skip = new Set(["node_modules", ".git", "dist", "coverage", ".claude"]);
  const configExtensions = /\.(?:mjs|cjs|js|json|sh|zsh|ps1|psm1|cmd|bat|plist|template|example|env|ya?ml|toml|conf|ini|xml)$/u;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (entry.name.startsWith(".") || configExtensions.test(entry.name))
        && fs.readFileSync(full, "utf8").includes("MI_NAVER_SHOPPING_LOCAL_WORKER_API_TIMEOUT_MS")) {
        setters.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  assert.deepEqual(setters.sort(), [
    "scripts/naver-shopping-dead-lease-takeover-migration.test.mjs",
    "scripts/naver-shopping-local-worker.mjs",
  ]);
});

test("a lease that was live before the migration keeps its plain expiry", async (t) => {
  const db = await fixture({ green: false });
  t.after(() => db.close());
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "navigating", 0), true);
  await db.exec(migration);
  // pages after the migration do not give the old lease a heartbeat (its collection start is unknown)
  await advance(db, 30);
  assert.equal(await progress(db, PRIMARY, T1604, RUN1604, "collecting", 1), true);
  assert.equal((await lane(db)).lease_heartbeat_at, null);
  await advance(db, 34 * 60 - 30);
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy");
  await advance(db, 61);
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).granted, true);
});

test("a dead half-open probe settles exactly like an expired one (differential)", async () => {
  const cases = [
    { holder: PRIMARY, token: T1604, reason: "auto_navigation_probe", handoff: false },
    { holder: STANDBY, token: TSTANDBY, reason: "auto_navigation_probe", handoff: false },
    { holder: STANDBY, token: TSTANDBY, reason: "auto_transient_system_probe", handoff: true },
  ];
  for (const c of cases) {
    const outcomes = [];
    for (const green of [true, false]) {
      const db = await fixture({ green });
      // the probe lease exactly as the claim grants it (a new token: the trigger stamps a grant)
      await db.exec(`update public.naver_shopping_worker_coordination set circuit_state='half_open', circuit_reason='${c.reason}',
        circuit_opened_by_worker='${STANDBY}', last_failure_code='native_host_response_timeout',
        transient_system_probe_attempts = 2, primary_seen_at = now() - interval '1 hour',
        lease_worker_id='${c.holder}', lease_token='${c.token}', lease_until = now() + interval '35 minutes',
        probe_started_at = now(), current_stage='claiming', current_job_started_at = now(),
        transient_standby_handoff_at = ${c.handoff ? "now()" : "null"},
        transient_standby_handoff_worker_id = ${c.handoff ? `'${STANDBY}'` : "null"},
        transient_standby_handoff_success_at = ${c.handoff ? "last_success_at" : "null"}`);
      assert.equal(await progress(db, c.holder, c.token, RUN1604, "navigating", 0, { trigger: "mac-standby" }), true);
      await advance(db, green ? 16 * 60 + 1 : 35 * 60 + 1);
      const r = await claim(db, PRIMARY, "primary", TPOLL);
      const row = await lane(db);
      outcomes.push([r.reason, row.circuit_state, row.circuit_reason, row.circuit_opened_by_worker, row.lease_worker_id]);
      await db.close();
    }
    assert.deepEqual(outcomes[0], outcomes[1], `${c.holder} ${c.reason}: same settlement as the 35-minute expiry`);
    assert.equal(outcomes[0][1], "open");
    assert.equal(outcomes[0][2], c.handoff ? "transient_recovery_manual_required" : "probe_interrupted");
  }
});

test("the primary takes a dead standby lease at once", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await db.exec("update public.naver_shopping_worker_coordination set primary_seen_at = now() - interval '1 hour'");
  assert.equal((await claimLane(db, STANDBY, "standby", TSTANDBY, RUNSTANDBY, "mac-standby")).granted, true);
  assert.equal(await progress(db, STANDBY, TSTANDBY, RUNSTANDBY, "navigating", 0, { trigger: "mac-standby" }), true);
  await advance(db, 15 * 60);
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy");
  await advance(db, 61);
  const r = await claimLane(db, PRIMARY, "primary", TCATCH, RUNCATCH, "rank-catch-up");
  assert.equal(r.granted, true);
  const row = await lane(db);
  assert.equal(row.lease_worker_id, PRIMARY);
  assert.equal(row.lease_reaped_worker_id, STANDBY);
  assert.equal(row.standby_failure_streak, 0, "a takeover is not a failure: no bench, no circuit");
  assert.equal(row.circuit_state, "closed");
});

test("the trigger fires for a caller without EXECUTE on it (service_role path)", async (t) => {
  const db = await fixture();
  t.after(() => db.close());
  await db.exec(`grant usage on schema public to service_role; grant select, update on public.naver_shopping_worker_coordination to service_role;
    grant execute on function public.mi_touch_naver_shopping_worker_lane(text, uuid, integer) to service_role;`);
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  await advance(db, 60);
  const h = (await lane(db)).lease_heartbeat_at;
  await db.exec("set role service_role");
  const touched = (await db.query("select public.mi_touch_naver_shopping_worker_lane($1,$2,2100) as r", [PRIMARY, T1604])).rows[0].r;
  await db.exec("reset role");
  assert.equal(touched, true);
  assert.ok((await lane(db)).lease_heartbeat_at > h);
});

// scripts/naver-shopping-scheduler-fairness-pglite.test.mjs runs the newest claim on a table
// without these columns. That works only because the takeover is nested behind the grant time:
// a claim over a lease younger than 6 minutes (or an expired one) never reads them.
test("the new claim runs on a coordination table without the new columns unless a lease is older than 6 minutes", async (t) => {
  const db = await fixture({ green: false });
  t.after(() => db.close());
  await db.exec(newClaim);
  assert.equal((await claimLane(db, PRIMARY, "primary", T1604, RUN1604, "rank-catch-up")).granted, true);
  await advance(db, 5 * 60 + 59);
  assert.equal((await claim(db, STANDBY, "standby", TSTANDBY)).reason, "busy");
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).reason, "busy");
  await advance(db, 2);
  await assert.rejects(claim(db, PRIMARY, "primary", TPOLL), /lease_heartbeat_at/u, "a fixture that claims over an older lease needs the seven columns");
  await advance(db, 30 * 60);
  assert.equal((await claim(db, PRIMARY, "primary", TPOLL)).granted, true, "an expired lease never reads them either");
});

test("verify-applied SQL reads false before and true after; rollback restores the 09-27 claim", async (t) => {
  const verifySql = readDoc("20260929120000_naver_shopping_dead_lease_takeover.verify-applied.sql");
  const rollbackSql = readDoc("20260929120000_naver_shopping_dead_lease_takeover.rollback.sql");
  const isolationVerifySql = readDoc("20260927120000_naver_shopping_standby_failure_isolation.verify-applied.sql");
  const db = await fixture({ green: false });
  t.after(() => db.close());
  const check = async (sql = verifySql) => Object.fromEntries((await db.query(sql)).rows.map((row) => [`${row.kind}:${row.name}`, row.applied]));
  const before = await check();
  assert.equal(Object.keys(before).length, 10);
  assert.ok(Object.values(before).every((v) => v === false), JSON.stringify(before));
  await db.exec(migration);
  const after = await check();
  assert.equal(Object.keys(after).length, 10);
  assert.ok(Object.values(after).every((v) => v === true), JSON.stringify(after));
  const isolation = await check(isolationVerifySql);
  assert.ok(Object.values(isolation).every((v) => v === true), `the 09-27 check still reads applied: ${JSON.stringify(isolation)}`);
  await db.exec(rollbackSql);
  const rolled = await check();
  assert.equal(rolled["function:mi_claim_naver_shopping_worker_lane"], false);
  assert.equal(rolled["function:mi_stamp_naver_shopping_worker_lease_heartbeat"], false);
  assert.equal(rolled["trigger:trg_mi_stamp_naver_shopping_worker_lease_heartbeat"], false);
  for (const column of NEW_COLUMNS) assert.equal(rolled[`column:${column}`], true, `${column} stays`);
  const live = (await db.query("select prosrc from pg_proc where proname='mi_claim_naver_shopping_worker_lane'")).rows[0].prosrc;
  const oldBody = OLD.claim.match(/\nas \$\$\n([\s\S]*?)\n\$\$;/u)[1];
  assert.equal(live.trim(), oldBody.trim());
  assert.ok(rollbackSql.includes(OLD.claim), "the rollback carries the 09-27 claim verbatim");
  assert.match(rollbackSql, /BEFORE docs\/sql\/20260927120000_naver_shopping_standby_failure_isolation\.rollback\.sql/u);
  // and the 09-27 rollback, opened alone, says so too (before its first statement)
  const isolationRollbackSql = readDoc("20260927120000_naver_shopping_standby_failure_isolation.rollback.sql");
  const isolationHeader = isolationRollbackSql.slice(0, isolationRollbackSql.indexOf("\nbegin;\n"));
  assert.match(isolationHeader, /^-- 20260929120000 이 적용돼 있으면 docs\/sql\/20260929120000_naver_shopping_dead_lease_takeover\.rollback\.sql 을 먼저 실행한다\.$/mu);
});

test("the newest claim definition keeps the takeover (a later re-declaration must copy it)", () => {
  const newest = newestFunction("mi_claim_naver_shopping_worker_lane");
  assert.ok(newest.includes(MARKER));
  assert.ok(newest.includes("mi:standby-failure-isolation"));
  assert.match(newest, /lease_heartbeat_at <= v_now - interval '6 minutes'/u);
  assert.match(newest, /lease_collection_started_at <= v_now - interval '16 minutes'/u);
  assert.match(newest, /coalesce\(current_row\.current_job_started_at, '-infinity'::timestamptz\)\s*<= v_now - interval '6 minutes' then/u);
});
