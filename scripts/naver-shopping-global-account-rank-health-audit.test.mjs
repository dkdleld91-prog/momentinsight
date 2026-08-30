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
  worker: "windows-desktop-primary", runtime: "1.1.17",
  fingerprint: "1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7",
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
      collection_id text, error_code text);
    create table naver_shopping_worker_runs (run_id uuid primary key, worker_id text,
      runtime_version text, runtime_fingerprint text, started_at timestamptz);
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
  const runs = [1, 2, 4].map((n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  const claims = [1, 2, 4].map((n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  await db.exec(`insert into naver_rank_trackers values
    ('${ids[0]}','mml93-a01','active',10,'2026-08-30T01:01Z','2026-08-30T03:00Z',null,null),
    ('${ids[1]}','mml93-a01','active',20,'2026-08-28T01:00Z','2026-08-30T01:00Z','2026-08-31T00:00Z',null),
    ('${ids[2]}','other-a01','active',null,null,null,null,null),
    ('${ids[3]}','other-a01','active',30,'2026-08-30T01:01Z','2026-08-30T03:00Z',null,null);
    insert into naver_shopping_worker_runs values
    ('${runs[0]}','windows-desktop-primary','1.1.17','${args.fingerprint}','2026-08-30T01:00:10Z'),
    ('${runs[1]}','windows-desktop-primary','1.1.17','${args.fingerprint}','2026-08-30T01:10:10Z'),
    ('${runs[2]}','windows-desktop-primary','1.1.17','${args.fingerprint}','2026-08-30T01:20:10Z');
    insert into naver_shopping_scheduler_events values
    (1,'2026-08-30T00:01Z','cycle_started','30000000-0000-4000-8000-000000000001',null,null,null,null,null,null,null,null),
    (2,'2026-08-30T01:00Z','tracker_claimed',null,'${claims[0]}','${runs[0]}','windows-desktop-primary','${ids[0]}','mml93-a01',null,null,null),
    (3,'2026-08-30T01:01Z','tracker_committed',null,'${claims[0]}','${runs[0]}','windows-desktop-primary','${ids[0]}','mml93-a01',300,'pw-chrome-good',null),
    (4,'2026-08-30T01:10Z','tracker_claimed',null,'${claims[1]}','${runs[1]}','windows-desktop-primary','${ids[1]}','mml93-a01',null,null,null),
    (5,'2026-08-30T01:11Z','job_failed',null,'${claims[1]}','${runs[1]}','windows-desktop-primary','${ids[1]}','mml93-a01',null,null,'naver_next_data_rank_drift'),
    (6,'2026-08-30T01:12Z','tracker_committed',null,'${claims[1]}','${runs[1]}','windows-desktop-primary','${ids[1]}','mml93-a01',300,'pw-chrome-late',null),
    (7,'2026-08-30T01:20Z','tracker_claimed',null,'${claims[2]}','${runs[2]}','windows-desktop-primary','${ids[3]}','other-a01',null,null,null),
    (8,'2026-08-30T01:21Z','tracker_committed',null,'${claims[2]}','${runs[2]}','windows-desktop-primary','${ids[3]}','WRONG',300,'pw-chrome-wrong',null),
    (9,'2026-08-30T01:30Z','cycle_completed','30000000-0000-4000-8000-000000000001',null,null,null,null,null,null,null,null);
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
      ('global','windows-desktop-primary','2026-08-30T01:59Z','1.1.17','${args.fingerprint}',
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
    quarantine_count: 1, identity_violation_count: 0, order_violation_count: 0,
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
  assert.equal(result.maxConcurrency, 1);
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

test("PGlite rejects the same counts when global cohort membership changes", async () => {
  const db = await database();
  await seedActiveCohort(db);
  assert.equal((await audit(db)).exactCohortOk, true);

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
