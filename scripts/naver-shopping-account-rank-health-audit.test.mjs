import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  N30_ACCOUNT_HEALTH_AGENCY_CODE,
  N30_ACCOUNT_HEALTH_RUNTIME_FINGERPRINT,
  N30_ACCOUNT_HEALTH_RUNTIME_VERSION,
  N30_ACCOUNT_HEALTH_WORKER_ID,
  buildN30AccountRankHealthAuditSql,
  classifyN30AccountRankHealth,
  classifyN30AccountTrackerEvidence,
} from "./naver-shopping-account-rank-health-audit.mjs";

const observedAt = "2026-08-29T13:26:26.756412Z";

async function createAuditDatabase() {
  const database = new PGlite();
  await database.exec(`
    create role service_role;
    create table naver_rank_trackers (
      id uuid primary key, agency_code text, product_id text, status text,
      current_rank integer, last_checked_at timestamptz, next_check_at timestamptz,
      worker_quarantined_until timestamptz, retry_count integer,
      processing_until timestamptz
    );
    create table naver_shopping_scheduler_events (
      event_id bigint primary key, occurred_at timestamptz, event_type text,
      cycle_id uuid, cycle_number bigint, claim_id uuid, run_id uuid,
      worker_id text, tracker_id uuid, agency_code text, group_fingerprint text,
      priority text, roster_state text, lease_started_at timestamptz,
      lease_until timestamptz, collection_id text, checked_count integer,
      error_code text, details jsonb
    );
    create table naver_rank_snapshots (
      id uuid primary key, tracker_id uuid, checked_at timestamptz, rank integer,
      matched boolean, source text, collection_id text, item jsonb,
      top_items jsonb, checked_count integer, total integer
    );
    create table naver_shopping_worker_runs (
      run_id uuid primary key, worker_id text, run_trigger text,
      runtime_version text, runtime_fingerprint text, started_at timestamptz
    );
    create table naver_shopping_rank_lookup_jobs (
      status text, processing_until timestamptz
    );
    create table naver_shopping_worker_coordination (
      lane_key text primary key, primary_worker_id text, primary_seen_at timestamptz,
      circuit_state text, circuit_reason text, cooldown_until timestamptz,
      runtime_version text, runtime_fingerprint text, updated_at timestamptz,
      lease_worker_id text, lease_token text, lease_until timestamptz, run_id uuid,
      current_stage text, current_page integer, current_job_kind text,
      current_tracker_id uuid, current_job_started_at timestamptz,
      probe_tracker_id uuid, probe_started_at timestamptz
    );
    grant select on all tables in schema public to service_role;
  `);
  return database;
}

test("builds one fixed-time fail-closed account audit without exposing lease tokens", () => {
  const sql = buildN30AccountRankHealthAuditSql({ observedAt });

  assert.equal(N30_ACCOUNT_HEALTH_AGENCY_CODE, "mml93-a01");
  assert.equal(N30_ACCOUNT_HEALTH_RUNTIME_VERSION, "1.1.20");
  assert.equal(N30_ACCOUNT_HEALTH_WORKER_ID, "windows-desktop-primary");
  assert.match(N30_ACCOUNT_HEALTH_RUNTIME_FINGERPRINT, /^[a-f0-9]{64}$/u);
  assert.match(
    sql,
    /^begin transaction isolation level repeatable read read only;\nset local role service_role;/iu,
  );
  assert.match(sql, /'mml93-a01'::text as agency_code/iu);
  assert.match(sql, /'2026-08-29T13:26:26\.756412Z'::timestamptz as observed_at/iu);
  assert.match(sql, /from public\.naver_rank_trackers as tracker/iu);
  assert.match(sql, /tracker\.agency_code = params\.agency_code/iu);
  assert.doesNotMatch(sql, /join\s+public\.clients/iu);
  assert.match(sql, /snapshot\.tracker_id = tracker\.tracker_id/iu);
  assert.doesNotMatch(sql, /snapshot\.agency_code/iu);
  assert.match(sql, /event\.tracker_id = tracker\.tracker_id/iu);
  assert.match(sql, /terminal\.claim_agency_code is distinct from params\.agency_code/iu);
  assert.match(sql, /terminal\.terminal_agency_code is distinct from params\.agency_code/iu);
  assert.doesNotMatch(sql, /event\.agency_code = params\.agency_code/iu);
  const cycleClaims = sql.slice(
    sql.indexOf("cycle_claim_events as ("),
    sql.indexOf("selected_claims as ("),
  );
  assert.match(cycleClaims, /event\.event_type = 'tracker_claimed'/iu);
  assert.match(cycleClaims, /count\(\*\) over \(partition by tracker\.tracker_id\)/iu);
  assert.doesNotMatch(cycleClaims, /join public\.naver_shopping_worker_runs/iu);
  assert.doesNotMatch(cycleClaims, /event\.worker_id\s*=/iu);
  assert.doesNotMatch(cycleClaims, /event\.run_id\s*=/iu);

  const firstTerminal = sql.slice(
    sql.indexOf("first_terminal as ("),
    sql.indexOf("terminal_evidence as ("),
  );
  assert.match(firstTerminal, /terminal\.claim_id = claim\.claim_id/iu);
  assert.match(sql, /terminal\.tracker_id = claim\.tracker_id/iu);
  assert.doesNotMatch(firstTerminal, /terminal\.run_id = claim\.run_id/iu);
  assert.doesNotMatch(firstTerminal, /terminal\.event_id > claim\.claim_event_id/iu);
  assert.doesNotMatch(firstTerminal, /terminal\.occurred_at >= claim\.claim_at/iu);
  assert.match(sql, /order by terminal\.event_id\s+limit 1/iu);
  assert.match(sql, /event_type in \('tracker_committed', 'finite_window_committed', 'job_failed'\)/iu);
  assert.match(sql, /preclaim_terminal_count/iu);
  assert.match(sql, /wrong_run_terminal_count/iu);
  assert.match(sql, /other_claim_terminal_count/iu);
  assert.match(sql, /orphan_terminal_count/iu);
  assert.match(sql, /terminal_distinct_run_count = 1/iu);
  assert.match(sql, /snapshot\.checked_count = 300/iu);
  assert.match(sql, /snapshot\.source = 'naver_shopping_results_collector'/iu);
  assert.match(sql, /snapshot\.item ->> 'source' = 'naver_shopping_results_collector'/iu);
  assert.match(sql, /snapshot\.item -> 'excludedAdCount'/iu);
  assert.doesNotMatch(sql, /snapshot\.excluded_ad_count/iu);
  assert.match(sql, /snapshot\.matched is true/iu);
  assert.match(sql, /snapshot\.matched is false/iu);
  assert.match(sql, /snapshot\.item ->> 'trackingRankSource' = 'exact_product'/iu);
  assert.match(sql, /snapshot\.item ->> 'sellerProductId' = tracker\.product_id/iu);
  assert.match(
    sql,
    /coalesce\(snapshot\.item ->> 'sellerProductId', ''\) = ''[\s\S]*?snapshot\.item ->> 'productId' = tracker\.product_id/iu,
  );
  assert.match(sql, /snapshot\.item ->> 'trackingRankSource' = 'related_catalog'/iu);
  assert.match(sql, /snapshot\.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'/iu);
  assert.match(sql, /snapshot\.item ->> 'sourceLabel' = '원부'/iu);
  assert.match(sql, /snapshot\.item ->> 'relatedCatalogProductId' ~ '\^\[0-9\]\{5,80\}\$'/iu);
  assert.match(sql, /snapshot\.item ->> 'catalogId' ~ '\^\[0-9\]\{5,80\}\$'/iu);
  assert.match(sql, /snapshot\.item ->> 'catalogId' <> tracker\.product_id/iu);
  assert.match(sql, /jsonb_array_length\(snapshot\.item -> 'catalogSellerProductIds'\) between 1 and 100/iu);
  assert.match(
    sql,
    /jsonb_array_elements_text\([\s\S]*?snapshot\.item -> 'catalogSellerProductIds'[\s\S]*?\)/iu,
  );
  assert.match(sql, /seller_id\.seller_id = tracker\.product_id/iu);
  assert.match(sql, /seller_id\.seller_id !~ '\^\[0-9\]\{5,80\}\$'/iu);
  assert.match(sql, /snapshot\.item -> 'sourceExhausted' = 'true'::jsonb/iu);
  assert.match(sql, /snapshot\.item -> 'finiteMarketTotal' = pg_catalog\.to_jsonb\(snapshot\.checked_count\)/iu);
  assert.match(sql, /snapshot\.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'/iu);
  assert.match(sql, /jsonb_array_elements\(snapshot\.top_items\)/iu);
  assert.match(sql, /jsonb_array_length\(snapshot\.top_items\) between 1 and 100/iu);
  assert.match(sql, /snapshot\.checked_at <= params\.observed_at/iu);
  assert.match(sql, /snapshot\.checked_at = terminal\.terminal_at/iu);
  assert.match(sql, /terminal_snapshot_count = 1/iu);
  assert.match(sql, /current_materialization_valid/iu);
  assert.match(sql, /tracker\.last_checked_at is not distinct from latest\.checked_at/iu);
  assert.match(sql, /valid_success_tracker_count/iu);
  assert.match(sql, /found_tracker_count/iu);
  assert.match(sql, /effective_success_ratio/iu);
  assert.match(sql, /terminal_success_ratio/iu);
  assert.match(sql, /coverage_ratio/iu);
  assert.match(sql, /never_checked_tracker_count/iu);
  assert.match(sql, /stale_24h_tracker_count/iu);
  assert.match(sql, /event_agency_mismatch_count/iu);
  assert.match(sql, /unclaimed_open_tracker_count/iu);
  assert.match(sql, /claimed_open_tracker_count/iu);
  assert.match(sql, /preterminal_integrity_failure_tracker_count/iu);
  assert.match(sql, /terminal_integrity_failure_tracker_count/iu);
  assert.match(sql, /latest_completed_cycle/iu);
  assert.match(sql, /event\.event_type = 'cycle_rostered'/iu);
  assert.match(sql, /event\.event_type = 'cycle_started'/iu);
  assert.match(sql, /cycle_start_count = 1/iu);
  assert.match(sql, /cycle_completed_count = 1/iu);
  assert.match(sql, /roster\.roster_state = 'eligible'/iu);
  assert.match(sql, /terminal\.roster_count = 1/iu);
  assert.match(sql, /terminal\.cycle_started_event_id < terminal\.roster_event_id/iu);
  assert.match(sql, /terminal\.cycle_started_at <= terminal\.roster_at/iu);
  assert.match(sql, /terminal\.roster_event_id < terminal\.group_event_id/iu);
  assert.match(sql, /terminal\.roster_cycle_number is not distinct from terminal\.claim_cycle_number/iu);
  assert.match(sql, /terminal\.roster_group_fingerprint is not distinct from terminal\.claim_group_fingerprint/iu);
  assert.match(sql, /terminal\.group_claim_count = terminal\.group_distinct_tracker_count/iu);
  assert.match(sql, /terminal\.group_claim_identity_or_order_violation_count = 0/iu);
  assert.match(sql, /terminal\.group_claim_roster_violation_count = 0/iu);
  assert.match(
    sql,
    /group_details -> 'memberCount'[\s\S]*?to_jsonb\(terminal\.group_distinct_tracker_count\)/iu,
  );
  assert.doesNotMatch(sql, /group_details -> 'memberCount'\s*=\s*pg_catalog\.to_jsonb\(1\)/iu);
  assert.match(sql, /terminal\.claim_at <= terminal\.run_started_at/iu);
  assert.match(sql, /terminal\.terminal_at >= terminal\.run_started_at/iu);
  assert.match(sql, /terminal\.claim_lease_started_at is not null/iu);
  assert.match(sql, /terminal\.claim_lease_until is not null/iu);
  assert.match(sql, /terminal\.terminal_lease_started_at is not null/iu);
  assert.match(sql, /terminal\.terminal_lease_until is not null/iu);
  assert.match(sql, /terminal\.terminal_at < terminal\.terminal_lease_until/iu);
  assert.match(sql, /coalesce\(valid_atomic_success, false\)/iu);
  assert.match(sql, /control_plane_ok/iu);
  assert.match(sql, /control\.current_page = 0/iu);
  assert.match(sql, /control\.current_job_started_at is null/iu);
  assert.match(sql, /control\.probe_started_at is null/iu);
  assert.match(sql, /control\.updated_at <= params\.observed_at/iu);
  assert.match(sql, /from public\.naver_shopping_rank_lookup_jobs/iu);
  assert.match(sql, /from public\.naver_rank_trackers/iu);
  assert.match(sql, /as processing_count/iu);
  assert.match(sql, /lease_token_is_null/iu);
  assert.equal((sql.match(/coordination\.lease_token/giu) || []).length, 1);
  assert.doesNotMatch(sql, /jsonb_build_object\([\s\S]*?'leaseToken'/iu);
  assert.doesNotMatch(sql, /keyword|product_title|product_url|mall_name/iu);
  assert.match(sql, /n30_account_rank_health_audit_v2/iu);
  assert.match(sql, /commit;\s*$/iu);
  assert.doesNotMatch(sql, /\bfor\s+update\b/iu);
  assert.doesNotMatch(
    sql,
    /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke)\b/iu,
  );
  assert.doesNotMatch(sql, /clock_timestamp|statement_timestamp|now\s*\(/iu);
});

test("executes the generated fail-closed audit in PostgreSQL", async () => {
  const database = await createAuditDatabase();
  try {
    const results = await database.exec(buildN30AccountRankHealthAuditSql({ observedAt }));
    const audit = results.find((result) => result.command === "SELECT")?.rows[0]?.audit;
    assert.ok(audit);
    assert.equal(audit.cycleIntegrityOk, false);
    assert.equal(audit.activeTrackerCount, 0);
    assert.equal(audit.controlPlaneOk, false);
    assert.equal(classifyN30AccountRankHealth(audit).accountHealthy, false);
  } finally {
    await database.close();
  }
});

test("SQL and JavaScript agree on all four open and integrity partitions", async () => {
  const database = await createAuditDatabase();
  const cycleId = "00000000-0000-4000-8000-000000000001";
  const trackerIds = [1, 2, 3, 4]
    .map((value) => `00000000-0000-4000-8001-${String(value).padStart(12, "0")}`);
  const runIds = [2, 3, 4]
    .map((value) => `00000000-0000-4000-8002-${String(value).padStart(12, "0")}`);
  const claimIds = [2, 3, 4, 5]
    .map((value) => `00000000-0000-4000-8003-${String(value).padStart(12, "0")}`);
  const fingerprints = ["a", "b", "c", "d"].map((value) => value.repeat(64));
  try {
    await database.exec(`
      insert into naver_rank_trackers(
        id, agency_code, product_id, status, current_rank, last_checked_at,
        next_check_at, worker_quarantined_until, retry_count, processing_until
      ) values
        ('${trackerIds[0]}', 'mml93-a01', '10000000001', 'active', null, null, null, null, 0, null),
        ('${trackerIds[1]}', 'mml93-a01', '10000000002', 'active', null, null, null, null, 0, null),
        ('${trackerIds[2]}', 'mml93-a01', '10000000003', 'active', null, null, null, null, 0, null),
        ('${trackerIds[3]}', 'mml93-a01', '10000000004', 'active', null, null, null, null, 0, null);
      insert into naver_shopping_worker_runs(
        run_id, worker_id, run_trigger, runtime_version, runtime_fingerprint, started_at
      ) values
        ('${runIds[0]}', 'windows-desktop-primary', 'rank-catch-up', '1.1.20',
          '${N30_ACCOUNT_HEALTH_RUNTIME_FINGERPRINT}', '2026-08-29T12:03:30Z'),
        ('${runIds[1]}', 'windows-desktop-primary', 'rank-catch-up', '1.1.20',
          '${N30_ACCOUNT_HEALTH_RUNTIME_FINGERPRINT}', '2026-08-29T12:05:30Z'),
        ('${runIds[2]}', 'windows-desktop-primary', 'rank-catch-up', '1.1.20',
          '${N30_ACCOUNT_HEALTH_RUNTIME_FINGERPRINT}', '2026-08-29T12:07:30Z');
      insert into naver_shopping_scheduler_events(
        event_id, occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id,
        worker_id, tracker_id, agency_code, group_fingerprint, priority, roster_state,
        lease_started_at, lease_until, error_code, details
      ) values
        (1, '2026-08-29T12:00:00Z', 'cycle_started', '${cycleId}', 42,
          null, null, null, null, null, null, null, null, null, null, null, '{}'),
        (2, '2026-08-29T12:01:00Z', 'cycle_rostered', '${cycleId}', 42,
          null, null, null, '${trackerIds[0]}', 'mml93-a01', '${fingerprints[0]}',
          null, 'eligible', null, null, null, '{}'),
        (3, '2026-08-29T12:01:01Z', 'cycle_rostered', '${cycleId}', 42,
          null, null, null, '${trackerIds[1]}', 'mml93-a01', '${fingerprints[1]}',
          null, 'eligible', null, null, null, '{}'),
        (4, '2026-08-29T12:01:02Z', 'cycle_rostered', '${cycleId}', 42,
          null, null, null, '${trackerIds[2]}', 'mml93-a01', '${fingerprints[2]}',
          null, 'eligible', null, null, null, '{}'),
        (5, '2026-08-29T12:01:03Z', 'cycle_rostered', '${cycleId}', 42,
          null, null, null, '${trackerIds[3]}', 'mml93-a01', '${fingerprints[3]}',
          null, 'eligible', null, null, null, '{}'),
        (6, '2026-08-29T12:02:00Z', 'group_claimed', '${cycleId}', 42,
          '${claimIds[0]}', '${runIds[0]}', 'windows-desktop-primary', null, null,
          '${fingerprints[1]}', 'normal', null, '2026-08-29T12:02:00Z',
          '2026-08-29T13:00:00Z', null, '{"memberCount":1}'),
        (7, '2026-08-29T12:03:00Z', 'tracker_claimed', '${cycleId}', 42,
          '${claimIds[0]}', '${runIds[0]}', 'windows-desktop-primary', '${trackerIds[1]}',
          'mml93-a01', '${fingerprints[1]}', 'normal', null,
          '2026-08-29T12:02:00Z', '2026-08-29T13:00:00Z', null, '{}'),
        (8, '2026-08-29T12:04:00Z', 'group_claimed', '${cycleId}', 42,
          '${claimIds[1]}', '${runIds[1]}', 'windows-desktop-primary', null, null,
          '${fingerprints[2]}', 'normal', null, '2026-08-29T12:04:00Z',
          '2026-08-29T13:00:00Z', null, '{"memberCount":1}'),
        (9, '2026-08-29T12:05:00Z', 'tracker_claimed', '${cycleId}', 42,
          '${claimIds[1]}', '${runIds[1]}', 'windows-desktop-primary', '${trackerIds[2]}',
          'mml93-a01', '${fingerprints[2]}', 'normal', null,
          '2026-08-29T12:04:00Z', '2026-08-29T13:00:00Z', null, '{}'),
        (10, '2026-08-29T12:06:00Z', 'group_claimed', '${cycleId}', 42,
          '${claimIds[2]}', '${runIds[2]}', 'windows-desktop-primary', null, null,
          '${fingerprints[2]}', 'normal', null, '2026-08-29T12:06:00Z',
          '2026-08-29T13:00:00Z', null, '{"memberCount":1}'),
        (11, '2026-08-29T12:07:00Z', 'tracker_claimed', '${cycleId}', 42,
          '${claimIds[2]}', '${runIds[2]}', 'windows-desktop-primary', '${trackerIds[2]}',
          'mml93-a01', '${fingerprints[2]}', 'normal', null,
          '2026-08-29T12:06:00Z', '2026-08-29T13:00:00Z', null, '{}'),
        (12, '2026-08-29T12:08:00Z', 'job_failed', '${cycleId}', 42,
          '${claimIds[3]}', '${runIds[2]}', 'windows-desktop-primary', '${trackerIds[3]}',
          'mml93-a01', '${fingerprints[3]}', 'normal', null,
          '2026-08-29T12:06:00Z', '2026-08-29T13:00:00Z', 'orphan_terminal', '{}'),
        (13, '2026-08-29T12:10:00Z', 'cycle_completed', '${cycleId}', 42,
          null, null, null, null, null, null, null, null, null, null, null, '{}');
      insert into naver_shopping_worker_coordination(
        lane_key, primary_worker_id, primary_seen_at, circuit_state, circuit_reason,
        cooldown_until, runtime_version, runtime_fingerprint, updated_at,
        lease_worker_id, lease_token, lease_until, run_id, current_stage, current_page,
        current_job_kind, current_tracker_id, current_job_started_at,
        probe_tracker_id, probe_started_at
      ) values (
        'global', 'windows-desktop-primary', '2026-08-29T13:25:00Z', 'closed', null,
        null, '1.1.20', '${N30_ACCOUNT_HEALTH_RUNTIME_FINGERPRINT}',
        '2026-08-29T13:25:00Z', null, null, null, null, null, 0, null, null, null, null, null
      );
    `);
    const queryAudit = async () => {
      const results = await database.exec(buildN30AccountRankHealthAuditSql({ observedAt }));
      return results.find((result) => result.command === "SELECT")?.rows[0]?.audit;
    };
    const audit = await queryAudit();
    assert.ok(audit);
    assert.equal(audit.cycleIntegrityOk, true);
    assert.equal(audit.activeTrackerCount, 4);
    assert.equal(audit.eligibleTrackerCount, 4);
    assert.equal(audit.claimedTrackerCount, 2);
    assert.equal(audit.terminalTrackerCount, 1);
    assert.equal(audit.unclaimedOpenTrackerCount, 1);
    assert.equal(audit.claimedOpenTrackerCount, 1);
    assert.equal(audit.preterminalIntegrityFailureTrackerCount, 1);
    assert.equal(audit.terminalIntegrityFailureTrackerCount, 1);
    assert.equal(audit.openTrackerCount, 2);
    assert.equal(audit.integrityFailureTrackerCount, 2);
    assert.equal(audit.controlPlaneOk, true);
    assert.equal(classifyN30AccountRankHealth(audit).accountHealthy, false);

    await database.exec(`
      update naver_shopping_worker_coordination
      set current_page = 1,
          current_job_started_at = '2026-08-29T13:25:00Z',
          probe_started_at = '2026-08-29T13:25:00Z',
          updated_at = '2026-08-29T13:27:00Z'
      where lane_key = 'global';
    `);
    assert.equal((await queryAudit()).controlPlaneOk, false);
    await database.exec(`
      update naver_shopping_worker_coordination
      set current_page = 0,
          current_job_started_at = null,
          probe_started_at = null,
          updated_at = '2026-08-29T13:25:00Z'
      where lane_key = 'global';
    `);

    await database.exec(`
      update naver_shopping_scheduler_events
      set group_fingerprint = '${fingerprints[1]}'
      where event_id = 2;
      update naver_shopping_scheduler_events
      set details = '{"memberCount":2}'
      where event_id = 6;
      insert into naver_shopping_scheduler_events(
        event_id, occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id,
        worker_id, tracker_id, agency_code, group_fingerprint, priority,
        lease_started_at, lease_until, details
      ) values (
        14, '2026-08-29T12:03:01Z', 'tracker_claimed', '${cycleId}', 42,
        '${claimIds[0]}', '${runIds[0]}', 'wrong-worker', '${trackerIds[0]}',
        'mml93-a01', '${fingerprints[1]}', 'normal', '2026-08-29T12:02:00Z',
        '2026-08-29T13:00:00Z', '{}'
      );
    `);
    const groupIdentityCorruption = await queryAudit();
    assert.equal(groupIdentityCorruption.claimedOpenTrackerCount, 0);
    assert.equal(groupIdentityCorruption.preterminalIntegrityFailureTrackerCount, 3);

    await database.exec(`
      update naver_shopping_scheduler_events
      set worker_id = 'windows-desktop-primary'
      where event_id = 14;
      delete from naver_shopping_scheduler_events where event_id = 2;
    `);
    const groupRosterCorruption = await queryAudit();
    assert.equal(groupRosterCorruption.eligibleTrackerCount, 3);
    assert.equal(groupRosterCorruption.claimedOpenTrackerCount, 0);
    assert.equal(groupRosterCorruption.preterminalIntegrityFailureTrackerCount, 2);

    await database.exec(`
      delete from naver_shopping_scheduler_events where event_id = 14;
      update naver_shopping_scheduler_events
      set details = '{"memberCount":1}'
      where event_id = 6;
      insert into naver_shopping_scheduler_events(
        event_id, occurred_at, event_type, cycle_id, cycle_number, tracker_id,
        agency_code, group_fingerprint, roster_state, details
      ) values (
        2, '2026-08-29T12:01:00Z', 'cycle_rostered', '${cycleId}', 42,
        '${trackerIds[0]}', 'mml93-a01', '${fingerprints[0]}', 'eligible', '{}'
      );
      delete from naver_shopping_scheduler_events where event_id = 1;
    `);
    const cycleCorruption = await queryAudit();
    assert.equal(cycleCorruption.cycleIntegrityOk, false);
    assert.equal(cycleCorruption.unclaimedOpenTrackerCount, 0);
    assert.equal(cycleCorruption.claimedOpenTrackerCount, 0);
    assert.equal(cycleCorruption.preterminalIntegrityFailureTrackerCount, 3);
  } finally {
    await database.close();
  }
});

const validTrackerEvidence = Object.freeze({
  claimCount: 1,
  terminalCount: 1,
  groupEventCount: 1,
  groupClaimCount: 3,
  groupDistinctTrackerCount: 3,
  groupMemberCount: 3,
  preclaimTerminalCount: 0,
  wrongRunTerminalCount: 0,
  otherClaimTerminalCount: 0,
  orphanTerminalCount: 0,
  claimWindowSnapshotCount: 1,
  rosterIntegrityOk: true,
  claimIdentityOk: true,
  eventOrderingOk: true,
  leaseWindowOk: true,
  runIdentityOk: true,
  terminalIdentityOk: true,
  currentMaterializationOk: true,
  terminalSnapshotKind: "atomic",
  terminalType: "tracker_committed",
  errorCodePresent: false,
});

test("accepts a valid member of a multi-tracker group without assuming memberCount one", () => {
  assert.equal(classifyN30AccountTrackerEvidence(validTrackerEvidence), "success");
});

test("keeps all four preterminal and terminal health partitions distinct", () => {
  const validUnclaimedEvidence = {
    ...validTrackerEvidence,
    claimCount: 0,
    terminalCount: 0,
    groupEventCount: 0,
    groupClaimCount: 0,
    groupDistinctTrackerCount: 0,
    groupMemberCount: 0,
    claimWindowSnapshotCount: 0,
    terminalSnapshotKind: "none",
    terminalType: null,
  };
  assert.equal(
    classifyN30AccountTrackerEvidence(validUnclaimedEvidence),
    "unclaimed_open",
  );
  assert.equal(
    classifyN30AccountTrackerEvidence({
      ...validUnclaimedEvidence,
      rosterIntegrityOk: false,
    }),
    "preterminal_integrity_failure",
  );
  for (const corruption of [
    { groupEventCount: 1 },
    { groupClaimCount: 1 },
    { groupDistinctTrackerCount: 1 },
    { groupMemberCount: 1 },
  ]) {
    assert.equal(
      classifyN30AccountTrackerEvidence({ ...validUnclaimedEvidence, ...corruption }),
      "preterminal_integrity_failure",
    );
  }
  for (const corruption of [
    { preclaimTerminalCount: 1 },
    { wrongRunTerminalCount: 1 },
    { otherClaimTerminalCount: 1 },
    { orphanTerminalCount: 1 },
  ]) {
    assert.equal(
      classifyN30AccountTrackerEvidence({ ...validUnclaimedEvidence, ...corruption }),
      "terminal_integrity_failure",
    );
  }
  assert.equal(
    classifyN30AccountTrackerEvidence({
      ...validTrackerEvidence,
      terminalCount: 0,
      claimWindowSnapshotCount: 0,
      terminalSnapshotKind: "none",
      terminalType: null,
    }),
    "claimed_open",
  );
  assert.equal(
    classifyN30AccountTrackerEvidence({
      ...validTrackerEvidence,
      claimCount: 2,
      terminalCount: 0,
      claimWindowSnapshotCount: 0,
      terminalSnapshotKind: "none",
      terminalType: null,
    }),
    "preterminal_integrity_failure",
  );
  assert.equal(
    classifyN30AccountTrackerEvidence({ ...validTrackerEvidence, claimCount: 0 }),
    "terminal_integrity_failure",
  );
});

test("fails closed for hidden duplicate, wrong-run, preclaim, orphan, and ordering evidence", () => {
  const corruptions = [
    { claimCount: 2 },
    { terminalCount: 2 },
    { groupEventCount: 2 },
    { groupMemberCount: 1 },
    { groupClaimCount: 4 },
    { preclaimTerminalCount: 1 },
    { wrongRunTerminalCount: 1 },
    { otherClaimTerminalCount: 1 },
    { orphanTerminalCount: 1 },
    { rosterIntegrityOk: false },
    { claimIdentityOk: false },
    { eventOrderingOk: false },
    { leaseWindowOk: false },
    { runIdentityOk: false },
    { terminalIdentityOk: false },
  ];
  for (const corruption of corruptions) {
    assert.equal(
      classifyN30AccountTrackerEvidence({ ...validTrackerEvidence, ...corruption }),
      "terminal_integrity_failure",
      JSON.stringify(corruption),
    );
  }
});

test("keeps terminal snapshot proof separate from current tracker materialization", () => {
  assert.equal(
    classifyN30AccountTrackerEvidence({
      ...validTrackerEvidence,
      terminalSnapshotKind: "invalid",
    }),
    "terminal_integrity_failure",
  );
  assert.equal(
    classifyN30AccountTrackerEvidence({
      ...validTrackerEvidence,
      currentMaterializationOk: false,
    }),
    "terminal_integrity_failure",
  );
});

test("classifies only an evidenced zero-snapshot job failure as failure", () => {
  const failure = {
    ...validTrackerEvidence,
    terminalType: "job_failed",
    terminalSnapshotKind: "none",
    claimWindowSnapshotCount: 0,
    errorCodePresent: true,
  };
  assert.equal(classifyN30AccountTrackerEvidence(failure), "failure");
  assert.equal(
    classifyN30AccountTrackerEvidence({ ...failure, errorCodePresent: false }),
    "terminal_integrity_failure",
  );
  assert.equal(
    classifyN30AccountTrackerEvidence({ ...failure, claimWindowSnapshotCount: 1 }),
    "terminal_integrity_failure",
  );
});

test("fails closed when one recent success hides ninety-nine stale trackers", () => {
  const result = classifyN30AccountRankHealth({
    activeTrackerCount: 100,
    eligibleTrackerCount: 100,
    claimedTrackerCount: 1,
    terminalTrackerCount: 1,
    validSuccessTrackerCount: 1,
    foundTrackerCount: 1,
    failureTrackerCount: 0,
    integrityFailureTrackerCount: 0,
    openTrackerCount: 99,
    unclaimedOpenTrackerCount: 99,
    claimedOpenTrackerCount: 0,
    preterminalIntegrityFailureTrackerCount: 0,
    terminalIntegrityFailureTrackerCount: 0,
    neverCheckedTrackerCount: 0,
    stale24hTrackerCount: 99,
    eventAgencyMismatchCount: 0,
    controlPlaneOk: true,
  });

  assert.equal(result.coverageRatio, 0.01);
  assert.equal(result.terminalSuccessRatio, 1);
  assert.equal(result.effectiveSuccessRatio, 0.01);
  assert.equal(result.foundRatio, 0.01);
  assert.equal(result.accountHealthy, false);
});

test("does not turn a valid atomic 300 not-found result into a collection error", () => {
  const result = classifyN30AccountRankHealth({
    activeTrackerCount: 100,
    eligibleTrackerCount: 100,
    claimedTrackerCount: 100,
    terminalTrackerCount: 100,
    validSuccessTrackerCount: 100,
    foundTrackerCount: 0,
    failureTrackerCount: 0,
    integrityFailureTrackerCount: 0,
    openTrackerCount: 0,
    unclaimedOpenTrackerCount: 0,
    claimedOpenTrackerCount: 0,
    preterminalIntegrityFailureTrackerCount: 0,
    terminalIntegrityFailureTrackerCount: 0,
    neverCheckedTrackerCount: 0,
    stale24hTrackerCount: 0,
    eventAgencyMismatchCount: 0,
    controlPlaneOk: true,
  });

  assert.equal(result.coverageRatio, 1);
  assert.equal(result.terminalSuccessRatio, 1);
  assert.equal(result.effectiveSuccessRatio, 1);
  assert.equal(result.foundRatio, 0);
  assert.equal(result.accountHealthy, true);
});

test("reproduces the observed mml93-a01 effective failure instead of trusting heartbeat alone", () => {
  const result = classifyN30AccountRankHealth({
    activeTrackerCount: 28,
    eligibleTrackerCount: 28,
    claimedTrackerCount: 28,
    terminalTrackerCount: 28,
    validSuccessTrackerCount: 15,
    foundTrackerCount: 15,
    failureTrackerCount: 13,
    integrityFailureTrackerCount: 0,
    openTrackerCount: 0,
    unclaimedOpenTrackerCount: 0,
    claimedOpenTrackerCount: 0,
    preterminalIntegrityFailureTrackerCount: 0,
    terminalIntegrityFailureTrackerCount: 0,
    neverCheckedTrackerCount: 1,
    stale24hTrackerCount: 13,
    eventAgencyMismatchCount: 0,
    controlPlaneOk: true,
  });

  assert.equal(result.coverageRatio, 1);
  assert.equal(result.terminalSuccessRatio, 15 / 28);
  assert.equal(result.effectiveSuccessRatio, 15 / 28);
  assert.equal(result.accountHealthy, false);
});

test("rejects impossible or incomplete account summaries", () => {
  assert.throws(
    () => classifyN30AccountRankHealth({ activeTrackerCount: 1 }),
    /eligibleTrackerCount/iu,
  );
  assert.throws(
    () => classifyN30AccountRankHealth({
      activeTrackerCount: 1,
      eligibleTrackerCount: 1,
      claimedTrackerCount: 1,
      terminalTrackerCount: 2,
      validSuccessTrackerCount: 1,
      foundTrackerCount: 1,
      failureTrackerCount: 1,
      integrityFailureTrackerCount: 0,
      openTrackerCount: 0,
      unclaimedOpenTrackerCount: 0,
      claimedOpenTrackerCount: 0,
      preterminalIntegrityFailureTrackerCount: 0,
      terminalIntegrityFailureTrackerCount: 0,
      neverCheckedTrackerCount: 0,
      stale24hTrackerCount: 0,
      eventAgencyMismatchCount: 0,
      controlPlaneOk: true,
    }),
    /eligible partition/iu,
  );
  assert.throws(
    () => classifyN30AccountRankHealth({
      activeTrackerCount: 1,
      eligibleTrackerCount: 1,
      claimedTrackerCount: 1,
      terminalTrackerCount: 1,
      validSuccessTrackerCount: 1,
      foundTrackerCount: 1,
      failureTrackerCount: 0,
      integrityFailureTrackerCount: 0,
      openTrackerCount: 0,
      unclaimedOpenTrackerCount: 0,
      claimedOpenTrackerCount: 0,
      preterminalIntegrityFailureTrackerCount: 0,
      terminalIntegrityFailureTrackerCount: 0,
      neverCheckedTrackerCount: 0,
      stale24hTrackerCount: 0,
      eventAgencyMismatchCount: 1,
      controlPlaneOk: true,
    }),
    /eventAgencyMismatchCount/iu,
  );
});

test("fails closed when terminal partitions are incomplete or control identity is unhealthy", () => {
  const base = {
    activeTrackerCount: 1,
    eligibleTrackerCount: 1,
    claimedTrackerCount: 1,
    terminalTrackerCount: 1,
    validSuccessTrackerCount: 0,
    foundTrackerCount: 0,
    failureTrackerCount: 0,
    integrityFailureTrackerCount: 0,
    openTrackerCount: 0,
    unclaimedOpenTrackerCount: 0,
    claimedOpenTrackerCount: 0,
    preterminalIntegrityFailureTrackerCount: 0,
    terminalIntegrityFailureTrackerCount: 0,
    neverCheckedTrackerCount: 0,
    stale24hTrackerCount: 0,
    eventAgencyMismatchCount: 0,
    controlPlaneOk: true,
  };
  assert.throws(() => classifyN30AccountRankHealth(base), /partition/iu);
  const result = classifyN30AccountRankHealth({
    ...base,
    integrityFailureTrackerCount: 1,
    terminalIntegrityFailureTrackerCount: 1,
    controlPlaneOk: false,
  });
  assert.equal(result.accountHealthy, false);
});
