import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildGlobalAccountRankHealthAuditSql } from "./naver-shopping-global-account-rank-health-audit.mjs";

const activationCohort = [
  { trackerId: "00000000-0000-4000-8000-000000000001", agencyCode: "mml93-a01" },
  { trackerId: "00000000-0000-4000-8000-000000000002", agencyCode: "mml93-a01" },
  { trackerId: "00000000-0000-4000-8000-000000000003", agencyCode: "other-a01" },
  { trackerId: "00000000-0000-4000-8000-000000000004", agencyCode: "other-a01" },
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cohortHash(members) {
  const roster = [...members]
    .sort((left, right) => compareText(left.agencyCode, right.agencyCode)
      || compareText(left.trackerId, right.trackerId))
    .map(({ trackerId, agencyCode }) => `${trackerId}:${agencyCode}`)
    .join(",");
  return createHash("md5").update(roster, "utf8").digest("hex");
}

function mandatoryCohortHash(members, agencyCode) {
  return cohortHash(members.filter((member) => member.agencyCode === agencyCode));
}

const args = {
  activationAt: "2026-08-30T00:00:00.000Z", observedAt: "2026-08-30T02:00:00.000Z",
  worker: "windows-desktop-primary", runtime: "1.1.18",
  fingerprint: "65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c",
  mandatoryAgency: "mml93-a01", mustTotal: 4, mustMandatory: 2,
  expectedCohortHash: cohortHash(activationCohort),
  expectedMandatoryCohortHash: mandatoryCohortHash(activationCohort, "mml93-a01"),
};

async function database() {
  const db = new PGlite();
  await db.exec(`create role service_role;
    create table naver_rank_trackers (id uuid primary key, agency_code text, status text,
      current_rank integer, last_checked_at timestamptz, next_check_at timestamptz,
      worker_quarantined_until timestamptz, processing_until timestamptz);
    create table naver_shopping_scheduler_events (event_id bigint primary key,
      occurred_at timestamptz, event_type text, cycle_id uuid, claim_id uuid, run_id uuid,
      worker_id text, tracker_id uuid, agency_code text, checked_count integer,
      collection_id text, error_code text, priority text,
      cycle_number bigint default 1,
      group_fingerprint text default repeat('a', 64), roster_state text default 'eligible',
      lease_started_at timestamptz default '2026-08-30T00:00:00Z',
      lease_until timestamptz default '2026-08-30T02:00:00Z',
      details jsonb default '{"memberCount":1}'::jsonb);
    create table naver_shopping_worker_runs (run_id uuid primary key, worker_id text,
      runtime_version text, runtime_fingerprint text, started_at timestamptz,
      run_trigger text);
    create table naver_rank_snapshots (id uuid primary key, tracker_id uuid,
      checked_at timestamptz, rank integer, matched boolean, source text,
      collection_id text, item jsonb, top_items jsonb, checked_count integer);
    create table naver_shopping_rank_lookup_jobs (status text, processing_until timestamptz);
    create table naver_shopping_worker_coordination (lane_key text, primary_worker_id text,
      primary_seen_at timestamptz, runtime_version text, runtime_fingerprint text,
      circuit_state text, circuit_reason text, cooldown_until timestamptz,
      lease_worker_id text, lease_token text, lease_until timestamptz, run_id uuid,
      current_stage text, current_page integer, current_job_kind text,
      current_tracker_id uuid, current_job_started_at timestamptz,
      probe_tracker_id uuid, probe_started_at timestamptz);
    grant select on all tables in schema public to service_role;`);
  return db;
}

async function seedActiveCohort(db, members = activationCohort) {
  const values = members.map(({ trackerId, agencyCode }) =>
    `('${trackerId}','${agencyCode}','active',null,null,null,null,null)`).join(",\n");
  await db.exec(`insert into naver_rank_trackers values ${values};`);
}

async function audit(db, options = args) {
  const results = await db.exec(buildGlobalAccountRankHealthAuditSql(options));
  return results.find((result) => result.command === "SELECT")?.rows[0]?.audit;
}

test("builds only one fixed read-only transaction and never selects sensitive fields", () => {
  const sql = buildGlobalAccountRankHealthAuditSql(args);
  assert.match(sql, /^begin transaction isolation level repeatable read read only;\nset local role service_role;/u);
  assert.equal((sql.match(/\bbegin\b/giu) || []).length, 1);
  assert.equal((sql.match(/\bcommit\b/giu) || []).length, 1);
  assert.doesNotMatch(sql, /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/iu);
  assert.doesNotMatch(sql, /product_id|keyword|title|image/iu);
  assert.doesNotMatch(sql, /select[\s\S]{0,80}lease_token\b/iu);
  assert.match(sql, /coordination\.lease_token is null/iu);
  assert.match(sql, /row_number\(\) over \(partition by cohort\.tracker_id order by event\.event_id\)/iu);
  assert.match(sql, /order by event\.event_id\s+limit 1/iu);
  assert.match(sql, /event\.tracker_id = claim\.tracker_id/iu);
  assert.match(sql, /event\.cycle_id = target_cycle\.cycle_id/iu);
  assert.match(sql, /event\.priority in \('new', 'resume', 'normal'\)/iu);
  assert.match(sql, /run_trigger is distinct from 'rank-catch-up'/iu);
  assert.match(sql, /event\.event_type = 'cycle_rostered'/iu);
  assert.match(sql, /event\.event_type = 'group_claimed'/iu);
  assert.match(sql, /group_fingerprint is distinct from claim_group_fingerprint/iu);
  assert.match(sql, /group_lease_started_at <= group_at and group_at < group_lease_until/iu);
  assert.match(sql, /claim_lease_started_at <= claim_at and claim_at < claim_lease_until/iu);
  assert.match(sql, /claim_lease_started_at <= run_started_at and run_started_at < claim_lease_until/iu);
  assert.match(sql, /terminal_lease_started_at <= terminal_at[\s\S]*terminal_at < terminal_lease_until/iu);
  assert.match(sql, /terminal_event_id < completed_event_id/iu);
  assert.match(sql, /current\.checked_at = cohort\.last_checked_at/iu);
  assert.match(sql, /from public\.naver_shopping_worker_runs as run cross join target_cycle/iu);
  assert.match(sql, /terminalLaneReleaseOrderOk/iu);
  assert.match(sql, /historicalConcurrencyAttested/iu);
  assert.match(sql, /boundaryViolationEventCount/iu);
  assert.match(sql, /boundaryViolationRunCount/iu);
  assert.match(sql, /event\.event_id > target_cycle\.started_event_id[\s\S]*event\.event_id < target_cycle\.completed_event_id/iu);
  assert.match(sql, /boundary_violation_run_count = 0/iu);
  assert.match(sql, /count\(\*\) over \(\)::integer as terminal_count/iu);
  assert.match(sql, /tracker_committed/iu);
  assert.match(sql, /snapshot\.checked_count = 300/iu);
  assert.match(sql, /snapshot\.item -> 'adExcluded' = 'true'::jsonb/iu);
  assert.match(sql, /md5\(coalesce\(pg_catalog\.string_agg/iu);
  assert.match(sql, /expected_cohort_hash/iu);
  assert.match(sql, /expected_mandatory_cohort_hash/iu);
  assert.match(sql, /as mandatory_cohort_hash/iu);
  assert.match(sql, /as exact_cohort_ok/iu);
  assert.match(sql, /group by agency_code/iu);
  assert.match(sql, /max_concurrency/iu);
});

test("rejects unsafe or internally impossible arguments", () => {
  assert.throws(() => buildGlobalAccountRankHealthAuditSql({ ...args, worker: "x';drop table x;--" }));
  assert.throws(() => buildGlobalAccountRankHealthAuditSql({ ...args, observedAt: args.activationAt.replace("00:00", "00:00"), activationAt: args.observedAt }));
  assert.throws(() => buildGlobalAccountRankHealthAuditSql({ ...args, mustTotal: 1, mustMandatory: 2 }));
  assert.throws(() => buildGlobalAccountRankHealthAuditSql({
    ...args, expectedCohortHash: undefined,
  }));
  assert.throws(() => buildGlobalAccountRankHealthAuditSql({
    ...args, expectedMandatoryCohortHash: args.fingerprint,
  }));
  assert.throws(() => buildGlobalAccountRankHealthAuditSql({
    ...args, expectedCohortHash: "0'.repeat(32);drop_table",
  }));
});

test("PGlite fixes the cohort, partitions agencies, and never lets a later success bypass the first terminal", async () => {
  const db = await database();
  const ids = activationCohort.map((member) => member.trackerId);
  const cycle = "30000000-0000-4000-8000-000000000001";
  const runs = [1, 2, 4].map((n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  const claims = [1, 2, 4].map((n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  await db.exec(`insert into naver_rank_trackers values
    ('${ids[0]}','mml93-a01','active',10,'2026-08-30T01:01Z','2026-08-30T03:00Z',null,null),
    ('${ids[1]}','mml93-a01','active',20,'2026-08-28T01:00Z','2026-08-30T01:00Z','2026-08-31T00:00Z',null),
    ('${ids[2]}','other-a01','active',null,null,null,null,null),
    ('${ids[3]}','other-a01','active',30,'2026-08-30T01:01Z','2026-08-30T03:00Z',null,null);
    insert into naver_shopping_worker_runs values
    ('${runs[0]}','windows-desktop-primary','1.1.18','${args.fingerprint}','2026-08-30T01:00:10Z','rank-catch-up'),
    ('${runs[1]}','windows-desktop-primary','1.1.18','${args.fingerprint}','2026-08-30T01:10:10Z','rank-catch-up'),
    ('${runs[2]}','windows-desktop-primary','1.1.18','${args.fingerprint}','2026-08-30T01:20:10Z','rank-catch-up');
    insert into naver_shopping_scheduler_events (
      event_id, occurred_at, event_type, cycle_id, claim_id, run_id, worker_id,
      tracker_id, agency_code, checked_count, collection_id, error_code, priority
    ) values
    (1,'2026-08-30T00:01Z','cycle_started','${cycle}',null,null,null,null,null,null,null,null,null),
    (2,'2026-08-30T00:50Z','cycle_rostered','${cycle}',null,null,null,'${ids[0]}','mml93-a01',null,null,null,null),
    (3,'2026-08-30T00:59Z','group_claimed','${cycle}','${claims[0]}','${runs[0]}','windows-desktop-primary',null,null,null,null,null,'normal'),
    (4,'2026-08-30T01:00Z','tracker_claimed','${cycle}','${claims[0]}','${runs[0]}','windows-desktop-primary','${ids[0]}','mml93-a01',null,null,null,'normal'),
    (5,'2026-08-30T01:01Z','tracker_committed','${cycle}','${claims[0]}','${runs[0]}','windows-desktop-primary','${ids[0]}','mml93-a01',300,'pw-chrome-good',null,'normal'),
    (6,'2026-08-30T01:05Z','cycle_rostered','${cycle}',null,null,null,'${ids[1]}','mml93-a01',null,null,null,null),
    (7,'2026-08-30T01:09Z','group_claimed','${cycle}','${claims[1]}','${runs[1]}','windows-desktop-primary',null,null,null,null,null,'normal'),
    (8,'2026-08-30T01:10Z','tracker_claimed','${cycle}','${claims[1]}','${runs[1]}','windows-desktop-primary','${ids[1]}','mml93-a01',null,null,null,'normal'),
    (9,'2026-08-30T01:11Z','job_failed','${cycle}','${claims[1]}','${runs[1]}','windows-desktop-primary','${ids[1]}','mml93-a01',null,null,'naver_next_data_rank_drift','normal'),
    (10,'2026-08-30T01:12Z','tracker_committed','${cycle}','${claims[1]}','${runs[1]}','windows-desktop-primary','${ids[1]}','mml93-a01',300,'pw-chrome-late',null,'normal'),
    (11,'2026-08-30T01:15Z','cycle_rostered','${cycle}',null,null,null,'${ids[3]}','other-a01',null,null,null,null),
    (12,'2026-08-30T01:19Z','group_claimed','${cycle}','${claims[2]}','${runs[2]}','windows-desktop-primary',null,null,null,null,null,'normal'),
    (13,'2026-08-30T01:20Z','tracker_claimed','${cycle}','${claims[2]}','${runs[2]}','windows-desktop-primary','${ids[3]}','other-a01',null,null,null,'normal'),
    (14,'2026-08-30T01:21Z','tracker_committed','${cycle}','${claims[2]}','${runs[2]}','windows-desktop-primary','${ids[3]}','WRONG',300,'pw-chrome-wrong',null,'normal'),
    (15,'2026-08-30T01:30Z','cycle_completed','${cycle}',null,null,null,null,null,null,null,null,null);
    insert into naver_rank_snapshots values
    ('40000000-0000-4000-8000-000000000001','${ids[0]}','2026-08-30T01:01Z',10,true,
      'naver_shopping_results_collector','pw-chrome-good',
      '{"collectionId":"pw-chrome-good","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300),
    ('40000000-0000-4000-8000-000000000002','${ids[1]}','2026-08-30T01:12Z',20,true,
      'naver_shopping_results_collector','pw-chrome-late',
      '{"collectionId":"pw-chrome-late","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300),
    ('40000000-0000-4000-8000-000000000003','${ids[3]}','2026-08-30T01:21Z',30,true,
      'naver_shopping_results_collector','pw-chrome-wrong',
      '{"collectionId":"pw-chrome-wrong","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300);
    insert into naver_shopping_worker_coordination values
      ('global','windows-desktop-primary','2026-08-30T01:59Z','1.1.18','${args.fingerprint}',
       'closed',null,null,null,null,null,null,null,0,null,null,null,null,null);
  `);
  const result = await audit(db);
  assert.equal(result.exactTotalsOk, true);
  assert.equal(result.exactCohortOk, true);
  assert.equal(result.cohortHash, args.expectedCohortHash);
  assert.equal(result.mandatoryCohortHash, args.expectedMandatoryCohortHash);
  assert.equal(result.totalCount, 4);
  assert.equal(result.mandatoryCount, 2);
  assert.deepEqual(result.global, {
    tracker_count: 4, claimed_count: 3, first_terminal_count: 3,
    success_count: 1, failure_count: 0, integrity_count: 2,
    open_count: 0, unclaimed_count: 1, stale_count: 2, due_count: 2,
    quarantine_count: 1, provenance_violation_count: 0,
    identity_violation_count: 0, order_violation_count: 0,
    duplicate_violation_count: 1, agency_mismatch_count: 1,
    reason_counts: { integrity_duplicate: 1, integrity_agency: 1, success: 1, unclaimed: 1 },
  });
  assert.equal(result.agencies.length, 2);
  assert.equal(result.agencies.find((x) => x.agencyCode === "mml93-a01").integrityCount, 1);
  assert.deepEqual(result.terminalReasonCounts, { naver_next_data_rank_drift: 1 });
  assert.deepEqual(result.agencies.find((x) => x.agencyCode === "mml93-a01").terminalReasonCounts,
    { naver_next_data_rank_drift: 1 });
  assert.equal(result.leaseTokenIsNull, true);
  assert.equal(result.fullIdle, true);
  assert.equal(result.maxConcurrency, 2);
  assert.equal(result.incompleteRunCount, 1);
  assert.equal(result.cycle.open_cycle_count, 0);
  assert.equal(result.cycleIntegrityOk, true);
  assert.equal(result.globalPartitionOk, true);
  const mismatch = await audit(db, {
    ...args, mustTotal: 5, mustMandatory: 3,
  });
  assert.equal(mismatch.exactTotalsOk, false);
  assert.equal(mismatch.exactCohortOk, false);
  await db.close();
});

test("PGlite correlates a shared group claim to each tracker terminal", async () => {
  const db = await database();
  const members = activationCohort.slice(0, 2);
  const [first, second] = members.map((member) => member.trackerId);
  const cycle = "30000000-0000-4000-8000-000000000011";
  const run = "10000000-0000-4000-8000-000000000011";
  const claim = "20000000-0000-4000-8000-000000000011";
  const options = {
    ...args,
    mustTotal: 2,
    mustMandatory: 2,
    expectedCohortHash: cohortHash(members),
    expectedMandatoryCohortHash: mandatoryCohortHash(members, "mml93-a01"),
  };
  await db.exec(`insert into naver_rank_trackers values
    ('${first}','mml93-a01','active',10,'2026-08-30T00:12:00Z',null,null,null),
    ('${second}','mml93-a01','active',20,'2026-08-30T00:13:00Z',null,null,null);
    insert into naver_shopping_worker_runs values
    ('${run}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:11:00Z','rank-catch-up');
    insert into naver_shopping_scheduler_events (
      event_id, occurred_at, event_type, cycle_id, claim_id, run_id, worker_id,
      tracker_id, agency_code, checked_count, collection_id, error_code, priority
    ) values
    (1,'2026-08-30T00:01:00Z','cycle_started','${cycle}',null,null,null,null,null,null,null,null,null),
    (2,'2026-08-30T00:05:00Z','cycle_rostered','${cycle}',null,null,null,
      '${first}','mml93-a01',null,null,null,null),
    (3,'2026-08-30T00:05:01Z','cycle_rostered','${cycle}',null,null,null,
      '${second}','mml93-a01',null,null,null,null),
    (4,'2026-08-30T00:09:00Z','group_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (5,'2026-08-30T00:10:00Z','tracker_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${first}','mml93-a01',null,null,null,'normal'),
    (6,'2026-08-30T00:10:00Z','tracker_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${second}','mml93-a01',null,null,null,'normal'),
    (7,'2026-08-30T00:12:00Z','tracker_committed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${first}','mml93-a01',300,'pw-chrome-shared-1',null,'normal'),
    (8,'2026-08-30T00:13:00Z','tracker_committed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${second}','mml93-a01',300,'pw-chrome-shared-2',null,'normal'),
    (9,'2026-08-30T00:14:00Z','cycle_completed','${cycle}',null,null,null,null,null,null,null,null,null);
    update naver_shopping_scheduler_events set details = '{"memberCount":2}'::jsonb
      where event_type = 'group_claimed' and claim_id = '${claim}';
    insert into naver_rank_snapshots values
    ('40000000-0000-4000-8000-000000000011','${first}','2026-08-30T00:12:00Z',10,true,
      'naver_shopping_results_collector','pw-chrome-shared-1',
      '{"collectionId":"pw-chrome-shared-1","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300),
    ('40000000-0000-4000-8000-000000000012','${second}','2026-08-30T00:13:00Z',20,true,
      'naver_shopping_results_collector','pw-chrome-shared-2',
      '{"collectionId":"pw-chrome-shared-2","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300);
    insert into naver_shopping_worker_coordination values
      ('global','windows-desktop-primary','2026-08-30T01:59:00Z','1.1.18','${args.fingerprint}',
       'closed',null,null,null,null,null,null,null,0,null,null,null,null,null);`);

  const result = await audit(db, options);
  assert.equal(result.exactCohortOk, true);
  assert.equal(result.global.claimed_count, 2);
  assert.equal(result.global.first_terminal_count, 2);
  assert.equal(result.global.success_count, 2);
  assert.equal(result.global.integrity_count, 0);
  assert.equal(result.global.duplicate_violation_count, 0);
  assert.equal(result.global.identity_violation_count, 0);
  assert.equal(result.cycleIntegrityOk, true);
  await db.close();
});

test("PGlite requires exact roster, group fingerprint, and lease provenance", async () => {
  const db = await database();
  const members = activationCohort.slice(0, 1);
  const tracker = members[0].trackerId;
  const cycle = "30000000-0000-4000-8000-000000000015";
  const run = "10000000-0000-4000-8000-000000000015";
  const claim = "20000000-0000-4000-8000-000000000015";
  const options = {
    ...args,
    mustTotal: 1,
    mustMandatory: 1,
    expectedCohortHash: cohortHash(members),
    expectedMandatoryCohortHash: mandatoryCohortHash(members, "mml93-a01"),
  };
  await db.exec(`insert into naver_rank_trackers values
    ('${tracker}','mml93-a01','active',10,'2026-08-30T00:12:00Z',null,null,null);
    insert into naver_shopping_worker_runs values
    ('${run}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:11:00Z','rank-catch-up');
    insert into naver_shopping_scheduler_events (
      event_id, occurred_at, event_type, cycle_id, claim_id, run_id, worker_id,
      tracker_id, agency_code, checked_count, collection_id, error_code, priority
    ) values
    (1,'2026-08-30T00:01:00Z','cycle_started','${cycle}',null,null,null,null,null,null,null,null,null),
    (2,'2026-08-30T00:05:00Z','cycle_rostered','${cycle}',null,null,null,
      '${tracker}','mml93-a01',null,null,null,null),
    (3,'2026-08-30T00:09:00Z','group_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (4,'2026-08-30T00:10:00Z','tracker_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${tracker}','mml93-a01',null,null,null,'normal'),
    (5,'2026-08-30T00:12:00Z','tracker_committed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${tracker}','mml93-a01',300,'pw-chrome-provenance',null,'normal'),
    (6,'2026-08-30T00:13:00Z','cycle_completed','${cycle}',null,null,null,null,null,null,null,null,null);
    insert into naver_rank_snapshots values
    ('40000000-0000-4000-8000-000000000015','${tracker}','2026-08-30T00:12:00Z',10,true,
      'naver_shopping_results_collector','pw-chrome-provenance',
      '{"collectionId":"pw-chrome-provenance","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300);
    insert into naver_shopping_worker_coordination values
      ('global','windows-desktop-primary','2026-08-30T01:59:00Z','1.1.18','${args.fingerprint}',
       'closed',null,null,null,null,null,null,null,0,null,null,null,null,null);`);

  assert.equal((await audit(db, options)).global.success_count, 1);
  let corrupted;
  await db.exec(`update naver_shopping_scheduler_events
    set lease_started_at = '2026-08-30T00:09:30Z', lease_until = '2026-08-30T02:00:00Z'
    where event_type in ('group_claimed', 'tracker_claimed', 'tracker_committed');`);
  corrupted = await audit(db, options);
  assert.equal(corrupted.global.success_count, 0);
  assert.equal(corrupted.global.provenance_violation_count, 1);
  assert.deepEqual(corrupted.global.reason_counts, { integrity_provenance: 1 });

  await db.exec(`update naver_shopping_scheduler_events
    set lease_started_at = '2026-08-30T00:00:00Z', lease_until = '2026-08-30T00:11:30Z'
    where event_type in ('group_claimed', 'tracker_claimed', 'tracker_committed');`);
  corrupted = await audit(db, options);
  assert.equal(corrupted.global.success_count, 0);
  assert.equal(corrupted.global.order_violation_count, 1);
  assert.deepEqual(corrupted.global.reason_counts, { integrity_order: 1 });

  await db.exec(`update naver_shopping_scheduler_events
    set lease_until = '2026-08-30T02:00:00Z'
    where event_type in ('group_claimed', 'tracker_claimed', 'tracker_committed');`);
  await db.exec(`update naver_shopping_scheduler_events set group_fingerprint = repeat('b', 64)
    where event_type = 'group_claimed';`);
  corrupted = await audit(db, options);
  assert.equal(corrupted.global.success_count, 0);
  assert.equal(corrupted.global.provenance_violation_count, 1);
  assert.deepEqual(corrupted.global.reason_counts, { integrity_provenance: 1 });

  await db.exec(`update naver_shopping_scheduler_events set group_fingerprint = repeat('a', 64),
    lease_until = '2026-08-30T01:59:00Z' where event_type = 'group_claimed';`);
  corrupted = await audit(db, options);
  assert.equal(corrupted.global.provenance_violation_count, 1);

  await db.exec(`update naver_shopping_scheduler_events set lease_until = '2026-08-30T02:00:00Z'
      where event_type = 'group_claimed';
    delete from naver_shopping_scheduler_events where event_type = 'cycle_rostered';`);
  corrupted = await audit(db, options);
  assert.equal(corrupted.global.provenance_violation_count, 1);
  await db.close();
});

test("PGlite ignores a legitimate later-cycle claim when certifying the first exact cycle", async () => {
  const db = await database();
  const members = activationCohort.slice(0, 1);
  const tracker = members[0].trackerId;
  const cycle = "30000000-0000-4000-8000-000000000021";
  const laterCycle = "30000000-0000-4000-8000-000000000022";
  const run = "10000000-0000-4000-8000-000000000021";
  const laterRun = "10000000-0000-4000-8000-000000000022";
  const claim = "20000000-0000-4000-8000-000000000021";
  const laterClaim = "20000000-0000-4000-8000-000000000022";
  const options = {
    ...args,
    mustTotal: 1,
    mustMandatory: 1,
    expectedCohortHash: cohortHash(members),
    expectedMandatoryCohortHash: mandatoryCohortHash(members, "mml93-a01"),
  };
  await db.exec(`insert into naver_rank_trackers values
    ('${tracker}','mml93-a01','active',11,'2026-08-30T01:12:00Z',null,null,null);
    insert into naver_shopping_worker_runs values
    ('${run}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:11:00Z','rank-catch-up'),
    ('${laterRun}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T01:11:00Z','rank-catch-up');
    insert into naver_shopping_scheduler_events (
      event_id, occurred_at, event_type, cycle_id, claim_id, run_id, worker_id,
      tracker_id, agency_code, checked_count, collection_id, error_code, priority
    ) values
    (1,'2026-08-30T00:01:00Z','cycle_started','${cycle}',null,null,null,null,null,null,null,null,null),
    (2,'2026-08-30T00:05:00Z','cycle_rostered','${cycle}',null,null,null,
      '${tracker}','mml93-a01',null,null,null,null),
    (3,'2026-08-30T00:09:00Z','group_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (4,'2026-08-30T00:10:00Z','tracker_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${tracker}','mml93-a01',null,null,null,'normal'),
    (5,'2026-08-30T00:12:00Z','tracker_committed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${tracker}','mml93-a01',300,'pw-chrome-cycle-1',null,'normal'),
    (6,'2026-08-30T00:13:00Z','cycle_completed','${cycle}',null,null,null,null,null,null,null,null,null),
    (7,'2026-08-30T01:01:00Z','cycle_started','${laterCycle}',null,null,null,null,null,null,null,null,null),
    (8,'2026-08-30T01:05:00Z','cycle_rostered','${laterCycle}',null,null,null,
      '${tracker}','mml93-a01',null,null,null,null),
    (9,'2026-08-30T01:09:00Z','group_claimed','${laterCycle}','${laterClaim}','${laterRun}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (10,'2026-08-30T01:10:00Z','tracker_claimed','${laterCycle}','${laterClaim}','${laterRun}',
      'windows-desktop-primary','${tracker}','mml93-a01',null,null,null,'normal'),
    (11,'2026-08-30T01:12:00Z','tracker_committed','${laterCycle}','${laterClaim}','${laterRun}',
      'windows-desktop-primary','${tracker}','mml93-a01',300,'pw-chrome-cycle-2',null,'normal'),
    (12,'2026-08-30T01:13:00Z','cycle_completed','${laterCycle}',null,null,null,null,null,null,null,null,null);
    insert into naver_rank_snapshots values
    ('40000000-0000-4000-8000-000000000021','${tracker}','2026-08-30T00:12:00Z',10,true,
      'naver_shopping_results_collector','pw-chrome-cycle-1',
      '{"collectionId":"pw-chrome-cycle-1","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300),
    ('40000000-0000-4000-8000-000000000022','${tracker}','2026-08-30T01:12:00Z',11,true,
      'naver_shopping_results_collector','pw-chrome-cycle-2',
      '{"collectionId":"pw-chrome-cycle-2","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300);
    insert into naver_shopping_worker_coordination values
      ('global','windows-desktop-primary','2026-08-30T01:59:00Z','1.1.18','${args.fingerprint}',
       'closed',null,null,null,null,null,null,null,0,null,null,null,null,null);`);

  const result = await audit(db, options);
  assert.equal(result.global.success_count, 1);
  assert.equal(result.global.failure_count, 0);
  assert.equal(result.global.duplicate_violation_count, 0);
  assert.deepEqual(result.terminalReasonCounts, {});
  assert.equal(result.cycle.started_count, 1);
  assert.equal(result.cycle.completed_count, 1);
  assert.equal(result.cycleIntegrityOk, true);
  await db.close();
});

test("PGlite rejects a first terminal written after the exact cycle completed", async () => {
  const db = await database();
  const members = activationCohort.slice(0, 1);
  const tracker = members[0].trackerId;
  const cycle = "30000000-0000-4000-8000-000000000025";
  const run = "10000000-0000-4000-8000-000000000025";
  const claim = "20000000-0000-4000-8000-000000000025";
  const options = {
    ...args,
    mustTotal: 1,
    mustMandatory: 1,
    expectedCohortHash: cohortHash(members),
    expectedMandatoryCohortHash: mandatoryCohortHash(members, "mml93-a01"),
  };
  await db.exec(`insert into naver_rank_trackers values
    ('${tracker}','mml93-a01','active',10,'2026-08-30T00:14:00Z',null,null,null);
    insert into naver_shopping_worker_runs values
    ('${run}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:11:00Z','rank-catch-up');
    insert into naver_shopping_scheduler_events (
      event_id, occurred_at, event_type, cycle_id, claim_id, run_id, worker_id,
      tracker_id, agency_code, checked_count, collection_id, error_code, priority
    ) values
    (1,'2026-08-30T00:01:00Z','cycle_started','${cycle}',null,null,null,null,null,null,null,null,null),
    (2,'2026-08-30T00:05:00Z','cycle_rostered','${cycle}',null,null,null,
      '${tracker}','mml93-a01',null,null,null,null),
    (3,'2026-08-30T00:09:00Z','group_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (4,'2026-08-30T00:10:00Z','tracker_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${tracker}','mml93-a01',null,null,null,'normal'),
    (5,'2026-08-30T00:13:00Z','cycle_completed','${cycle}',null,null,null,null,null,null,null,null,null),
    (6,'2026-08-30T00:14:00Z','tracker_committed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${tracker}','mml93-a01',300,'pw-chrome-too-late',null,'normal');
    insert into naver_rank_snapshots values
    ('40000000-0000-4000-8000-000000000025','${tracker}','2026-08-30T00:14:00Z',10,true,
      'naver_shopping_results_collector','pw-chrome-too-late',
      '{"collectionId":"pw-chrome-too-late","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300);
    insert into naver_shopping_worker_coordination values
      ('global','windows-desktop-primary','2026-08-30T01:59:00Z','1.1.18','${args.fingerprint}',
       'closed',null,null,null,null,null,null,null,0,null,null,null,null,null);`);

  const result = await audit(db, options);
  assert.equal(result.global.success_count, 0);
  assert.equal(result.global.order_violation_count, 1);
  assert.deepEqual(result.global.reason_counts, { integrity_order: 1 });
  assert.equal(result.terminalLaneReleaseOrderOk, false);
  await db.close();
});

test("PGlite excludes probe and repair claims and fails closed on a remote scheduled claim", async () => {
  const db = await database();
  const members = activationCohort.slice(0, 3);
  const [probeTracker, repairTracker, remoteTracker] = members.map((member) => member.trackerId);
  const cycle = "30000000-0000-4000-8000-000000000031";
  const runs = [31, 32, 33].map((n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  const claims = [31, 32, 33].map((n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  const options = {
    ...args,
    mustTotal: 3,
    mustMandatory: 2,
    expectedCohortHash: cohortHash(members),
    expectedMandatoryCohortHash: mandatoryCohortHash(members, "mml93-a01"),
  };
  await db.exec(`insert into naver_rank_trackers values
    ('${probeTracker}','mml93-a01','active',10,'2026-08-30T00:12:00Z',null,null,null),
    ('${repairTracker}','mml93-a01','active',20,'2026-08-30T00:22:00Z',null,null,null),
    ('${remoteTracker}','other-a01','active',30,'2026-08-30T00:32:00Z',null,null,null);
    insert into naver_shopping_worker_runs values
    ('${runs[0]}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:11:00Z','rank-catch-up'),
    ('${runs[1]}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:21:00Z','rank-catch-up'),
    ('${runs[2]}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:31:00Z','rank-remote');
    insert into naver_shopping_scheduler_events (
      event_id, occurred_at, event_type, cycle_id, claim_id, run_id, worker_id,
      tracker_id, agency_code, checked_count, collection_id, error_code, priority
    ) values
    (1,'2026-08-30T00:01:00Z','cycle_started','${cycle}',null,null,null,null,null,null,null,null,null),
    (2,'2026-08-30T00:05:00Z','cycle_rostered','${cycle}',null,null,null,
      '${probeTracker}','mml93-a01',null,null,null,null),
    (3,'2026-08-30T00:09:00Z','group_claimed','${cycle}','${claims[0]}','${runs[0]}',
      'windows-desktop-primary',null,null,null,null,null,'probe'),
    (4,'2026-08-30T00:10:00Z','tracker_claimed','${cycle}','${claims[0]}','${runs[0]}',
      'windows-desktop-primary','${probeTracker}','mml93-a01',null,null,null,'probe'),
    (5,'2026-08-30T00:12:00Z','tracker_committed','${cycle}','${claims[0]}','${runs[0]}',
      'windows-desktop-primary','${probeTracker}','mml93-a01',300,'pw-chrome-probe',null,'probe'),
    (6,'2026-08-30T00:15:00Z','cycle_rostered','${cycle}',null,null,null,
      '${repairTracker}','mml93-a01',null,null,null,null),
    (7,'2026-08-30T00:19:00Z','group_claimed','${cycle}','${claims[1]}','${runs[1]}',
      'windows-desktop-primary',null,null,null,null,null,'repair'),
    (8,'2026-08-30T00:20:00Z','tracker_claimed','${cycle}','${claims[1]}','${runs[1]}',
      'windows-desktop-primary','${repairTracker}','mml93-a01',null,null,null,'repair'),
    (9,'2026-08-30T00:22:00Z','tracker_committed','${cycle}','${claims[1]}','${runs[1]}',
      'windows-desktop-primary','${repairTracker}','mml93-a01',300,'pw-chrome-repair',null,'repair'),
    (10,'2026-08-30T00:25:00Z','cycle_rostered','${cycle}',null,null,null,
      '${remoteTracker}','other-a01',null,null,null,null),
    (11,'2026-08-30T00:29:00Z','group_claimed','${cycle}','${claims[2]}','${runs[2]}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (12,'2026-08-30T00:30:00Z','tracker_claimed','${cycle}','${claims[2]}','${runs[2]}',
      'windows-desktop-primary','${remoteTracker}','other-a01',null,null,null,'normal'),
    (13,'2026-08-30T00:32:00Z','tracker_committed','${cycle}','${claims[2]}','${runs[2]}',
      'windows-desktop-primary','${remoteTracker}','other-a01',300,'pw-chrome-remote',null,'normal'),
    (14,'2026-08-30T00:33:00Z','cycle_completed','${cycle}',null,null,null,null,null,null,null,null,null);
    insert into naver_rank_snapshots values
    ('40000000-0000-4000-8000-000000000031','${probeTracker}','2026-08-30T00:12:00Z',10,true,
      'naver_shopping_results_collector','pw-chrome-probe',
      '{"collectionId":"pw-chrome-probe","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300),
    ('40000000-0000-4000-8000-000000000032','${repairTracker}','2026-08-30T00:22:00Z',20,true,
      'naver_shopping_results_collector','pw-chrome-repair',
      '{"collectionId":"pw-chrome-repair","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300),
    ('40000000-0000-4000-8000-000000000033','${remoteTracker}','2026-08-30T00:32:00Z',30,true,
      'naver_shopping_results_collector','pw-chrome-remote',
      '{"collectionId":"pw-chrome-remote","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300);
    insert into naver_shopping_worker_coordination values
      ('global','windows-desktop-primary','2026-08-30T01:59:00Z','1.1.18','${args.fingerprint}',
       'closed',null,null,null,null,null,null,null,0,null,null,null,null,null);`);

  const result = await audit(db, options);
  assert.equal(result.global.claimed_count, 1);
  assert.equal(result.global.success_count, 0);
  assert.equal(result.global.integrity_count, 1);
  assert.equal(result.global.unclaimed_count, 2);
  assert.equal(result.global.identity_violation_count, 1);
  assert.equal(result.nonCatchUpRunCount, 1);
  assert.deepEqual(result.global.reason_counts, { integrity_identity: 1, unclaimed: 2 });
  await db.close();
});

test("PGlite counts every overlapping run through the last member terminal", async () => {
  const db = await database();
  const members = activationCohort.slice(0, 2);
  const [first, second] = members.map((member) => member.trackerId);
  const cycle = "30000000-0000-4000-8000-000000000035";
  const run = "10000000-0000-4000-8000-000000000035";
  const manualRun = "10000000-0000-4000-8000-000000000036";
  const claim = "20000000-0000-4000-8000-000000000035";
  const options = {
    ...args,
    mustTotal: 2,
    mustMandatory: 2,
    expectedCohortHash: cohortHash(members),
    expectedMandatoryCohortHash: mandatoryCohortHash(members, "mml93-a01"),
  };
  await db.exec(`insert into naver_rank_trackers values
    ('${first}','mml93-a01','active',10,'2026-08-30T00:12:00Z',null,null,null),
    ('${second}','mml93-a01','active',20,'2026-08-30T00:20:00Z',null,null,null);
    insert into naver_shopping_worker_runs values
    ('${run}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:11:00Z','rank-catch-up'),
    ('${manualRun}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:15:00Z','manual');
    insert into naver_shopping_scheduler_events (
      event_id, occurred_at, event_type, cycle_id, claim_id, run_id, worker_id,
      tracker_id, agency_code, checked_count, collection_id, error_code, priority
    ) values
    (1,'2026-08-30T00:01:00Z','cycle_started','${cycle}',null,null,null,null,null,null,null,null,null),
    (2,'2026-08-30T00:05:00Z','cycle_rostered','${cycle}',null,null,null,
      '${first}','mml93-a01',null,null,null,null),
    (3,'2026-08-30T00:05:01Z','cycle_rostered','${cycle}',null,null,null,
      '${second}','mml93-a01',null,null,null,null),
    (4,'2026-08-30T00:09:00Z','group_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (5,'2026-08-30T00:10:00Z','tracker_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${first}','mml93-a01',null,null,null,'normal'),
    (6,'2026-08-30T00:10:01Z','tracker_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${second}','mml93-a01',null,null,null,'normal'),
    (7,'2026-08-30T00:12:00Z','tracker_committed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${first}','mml93-a01',300,'pw-chrome-overlap-1',null,'normal'),
    (8,'2026-08-30T00:20:00Z','tracker_committed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${second}','mml93-a01',300,'pw-chrome-overlap-2',null,'normal'),
    (9,'2026-08-30T00:25:00Z','cycle_completed','${cycle}',null,null,null,null,null,null,null,null,null);
    update naver_shopping_scheduler_events set details = '{"memberCount":2}'::jsonb
      where event_type = 'group_claimed';
    insert into naver_rank_snapshots values
    ('40000000-0000-4000-8000-000000000035','${first}','2026-08-30T00:12:00Z',10,true,
      'naver_shopping_results_collector','pw-chrome-overlap-1',
      '{"collectionId":"pw-chrome-overlap-1","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300),
    ('40000000-0000-4000-8000-000000000036','${second}','2026-08-30T00:20:00Z',20,true,
      'naver_shopping_results_collector','pw-chrome-overlap-2',
      '{"collectionId":"pw-chrome-overlap-2","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300);
    insert into naver_shopping_worker_coordination values
      ('global','windows-desktop-primary','2026-08-30T01:59:00Z','1.1.18','${args.fingerprint}',
       'closed',null,null,null,null,null,null,null,0,null,null,null,null,null);`);

  const result = await audit(db, options);
  assert.equal(result.global.success_count, 2);
  assert.equal(result.maxConcurrency, 2);
  assert.equal(result.overlappingRunCount, 2);
  assert.equal(result.nonCatchUpRunCount, 1);
  assert.equal(result.unattestedRunCount, 1);
  assert.equal(result.terminalLaneReleaseOrderOk, true);
  assert.equal(result.historicalConcurrencyAttested, false);
  await db.close();
});

test("PGlite rejects same-cycle run evidence written only after cycle completion", async () => {
  const db = await database();
  const members = activationCohort.slice(0, 1);
  const tracker = members[0].trackerId;
  const cycle = "30000000-0000-4000-8000-000000000037";
  const run = "10000000-0000-4000-8000-000000000037";
  const lateRun = "10000000-0000-4000-8000-000000000038";
  const claim = "20000000-0000-4000-8000-000000000037";
  const lateClaim = "20000000-0000-4000-8000-000000000038";
  const options = {
    ...args,
    mustTotal: 1,
    mustMandatory: 1,
    expectedCohortHash: cohortHash(members),
    expectedMandatoryCohortHash: mandatoryCohortHash(members, "mml93-a01"),
  };
  await db.exec(`insert into naver_rank_trackers values
    ('${tracker}','mml93-a01','active',10,'2026-08-30T00:12:00Z',null,null,null);
    insert into naver_shopping_worker_runs values
    ('${run}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:11:00Z','rank-catch-up'),
    ('${lateRun}','windows-desktop-primary','1.1.18','${args.fingerprint}',
      '2026-08-30T00:13:30Z','rank-catch-up');
    insert into naver_shopping_scheduler_events (
      event_id, occurred_at, event_type, cycle_id, claim_id, run_id, worker_id,
      tracker_id, agency_code, checked_count, collection_id, error_code, priority
    ) values
    (1,'2026-08-30T00:01:00Z','cycle_started','${cycle}',null,null,null,null,null,null,null,null,null),
    (2,'2026-08-30T00:05:00Z','cycle_rostered','${cycle}',null,null,null,
      '${tracker}','mml93-a01',null,null,null,null),
    (3,'2026-08-30T00:09:00Z','group_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (4,'2026-08-30T00:10:00Z','tracker_claimed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${tracker}','mml93-a01',null,null,null,'normal'),
    (5,'2026-08-30T00:12:00Z','tracker_committed','${cycle}','${claim}','${run}',
      'windows-desktop-primary','${tracker}','mml93-a01',300,'pw-chrome-boundary-good',null,'normal'),
    (6,'2026-08-30T00:13:00Z','cycle_completed','${cycle}',null,null,null,null,null,null,null,null,null),
    (7,'2026-08-30T00:14:00Z','group_claimed','${cycle}','${lateClaim}','${lateRun}',
      'windows-desktop-primary',null,null,null,null,null,'normal'),
    (8,'2026-08-30T00:14:01Z','tracker_claimed','${cycle}','${lateClaim}','${lateRun}',
      'windows-desktop-primary','${tracker}','mml93-a01',null,null,null,'normal'),
    (9,'2026-08-30T00:15:00Z','tracker_committed','${cycle}','${lateClaim}','${lateRun}',
      'windows-desktop-primary','${tracker}','mml93-a01',300,'pw-chrome-boundary-late',null,'normal');
    insert into naver_rank_snapshots values
    ('40000000-0000-4000-8000-000000000037','${tracker}','2026-08-30T00:12:00Z',10,true,
      'naver_shopping_results_collector','pw-chrome-boundary-good',
      '{"collectionId":"pw-chrome-boundary-good","source":"naver_shopping_results_collector","adExcluded":true,"rankPolicy":"organic_only","isOrganic":true,"isAd":false}',
      '[{"isOrganic":true,"isAd":false}]',300);
    insert into naver_shopping_worker_coordination values
      ('global','windows-desktop-primary','2026-08-30T01:59:00Z','1.1.18','${args.fingerprint}',
       'closed',null,null,null,null,null,null,null,0,null,null,null,null,null);`);

  const result = await audit(db, options);
  assert.equal(result.global.success_count, 1);
  assert.equal(result.maxConcurrency, 1);
  assert.equal(result.nonCatchUpRunCount, 0);
  assert.equal(result.incompleteRunCount, 0);
  assert.equal(result.unattestedRunCount, 0);
  assert.equal(result.boundaryViolationEventCount, 3);
  assert.equal(result.boundaryViolationRunCount, 1);
  assert.equal(result.terminalLaneReleaseOrderOk, true);
  assert.equal(result.fullIdle, true);
  assert.equal(result.historicalConcurrencyAttested, false);
  await db.close();
});

test("PGlite rejects the same counts when global cohort membership changes", async () => {
  const db = await database();
  await seedActiveCohort(db);
  const baseline = await audit(db);
  assert.equal(baseline.exactCohortOk, true);
  assert.equal(baseline.cycleIntegrityOk, false);

  const replacement = {
    trackerId: "00000000-0000-4000-8000-000000000005",
    agencyCode: "other-a01",
  };
  await db.exec(`update naver_rank_trackers set status = 'inactive'
    where id = '${activationCohort[3].trackerId}';
    insert into naver_rank_trackers values
    ('${replacement.trackerId}','${replacement.agencyCode}','active',null,null,null,null,null);`);

  const changed = await audit(db);
  assert.equal(changed.totalCount, args.mustTotal);
  assert.equal(changed.mandatoryCount, args.mustMandatory);
  assert.equal(changed.exactTotalsOk, true);
  assert.notEqual(changed.cohortHash, args.expectedCohortHash);
  assert.equal(changed.mandatoryCohortHash, args.expectedMandatoryCohortHash);
  assert.equal(changed.exactCohortOk, false);
  await db.close();
});

test("PGlite requires the mandatory-agency cohort hash even when global totals and hash match", async () => {
  const db = await database();
  await seedActiveCohort(db);
  const result = await audit(db, {
    ...args,
    expectedMandatoryCohortHash: createHash("md5").update("", "utf8").digest("hex"),
  });
  assert.equal(result.exactTotalsOk, true);
  assert.equal(result.cohortHash, args.expectedCohortHash);
  assert.notEqual(result.mandatoryCohortHash, createHash("md5").update("", "utf8").digest("hex"));
  assert.equal(result.exactCohortOk, false);
  await db.close();
});

test("PGlite fails closed when activation-time cohort members are added or removed", async () => {
  const db = await database();
  await seedActiveCohort(db);
  const addedId = "00000000-0000-4000-8000-000000000006";
  await db.exec(`insert into naver_rank_trackers values
    ('${addedId}','other-a01','active',null,null,null,null,null);`);
  const afterAdd = await audit(db);
  assert.equal(afterAdd.totalCount, args.mustTotal + 1);
  assert.equal(afterAdd.exactCohortOk, false);

  await db.exec(`update naver_rank_trackers set status = 'inactive'
    where id in ('${addedId}', '${activationCohort[2].trackerId}');`);
  const afterRemove = await audit(db);
  assert.equal(afterRemove.totalCount, args.mustTotal - 1);
  assert.equal(afterRemove.exactCohortOk, false);
  await db.close();
});
