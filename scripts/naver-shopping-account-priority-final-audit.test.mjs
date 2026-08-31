import assert from "node:assert/strict";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE,
  N30_ACCOUNT_PRIORITY_FINAL_COHORT_COUNT,
  N30_ACCOUNT_PRIORITY_FINAL_COHORT_HASH,
  N30_ACCOUNT_PRIORITY_FINAL_REQUEST_ID,
  N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_FINGERPRINT,
  N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_VERSION,
  N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID,
  buildN30AccountPriorityFinalAuditSql,
} from "./naver-shopping-account-priority-final-audit.mjs";

const observedAt = "2026-08-31T06:00:00.000000Z";
const requestCompletedAt = "2026-08-31T05:30:00.000000Z";

function uuid(namespace, index) {
  return `00000000-0000-${namespace.toString(16).padStart(4, "0")}-8000-${index
    .toString()
    .padStart(12, "0")}`;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function createAuditDatabase() {
  const database = new PGlite();
  await database.exec(`
    create role service_role;
    create table naver_shopping_account_priority_requests (
      request_id uuid primary key, agency_code text, cohort_count integer,
      cohort_hash text, required_runtime_version text,
      required_runtime_fingerprint text, requested_at timestamptz,
      expires_at timestamptz, requested_cycle_id uuid,
      requested_cycle_number bigint, state text, completed_at timestamptz,
      expired_at timestamptz, succeeded boolean
    );
    create table naver_shopping_account_priority_members (
      request_id uuid, position integer, tracker_id uuid, state text,
      claimed_at timestamptz, claimed_cycle_id uuid,
      claimed_cycle_number bigint, claimed_run_id uuid, claimed_worker_id text,
      claimed_lease_started_at timestamptz, claimed_lease_until timestamptz,
      claim_event_id bigint, claim_id uuid, terminal_at timestamptz,
      terminal_event_id bigint, terminal_event_type text, terminal_code text,
      cursor_sort_order_before integer, cursor_created_at_before timestamptz,
      cursor_tracker_id_before uuid, cursor_resume_before boolean,
      cursor_sort_order_after integer, cursor_created_at_after timestamptz,
      cursor_tracker_id_after uuid, cursor_resume_after boolean
    );
    create table naver_rank_trackers (
      id uuid primary key, agency_code text, product_id text, status text,
      current_rank integer, last_checked_at timestamptz,
      processing_until timestamptz
    );
    create table naver_shopping_scheduler_events (
      event_id bigint primary key, occurred_at timestamptz, event_type text,
      cycle_id uuid, cycle_number bigint, claim_id uuid, run_id uuid,
      worker_id text, tracker_id uuid, agency_code text, group_fingerprint text,
      priority text, lease_started_at timestamptz, lease_until timestamptz,
      collection_id text, checked_count integer, error_code text, details jsonb
    );
    create table naver_shopping_worker_runs (
      run_id uuid primary key, worker_id text, run_trigger text,
      runtime_version text, runtime_fingerprint text, started_at timestamptz
    );
    create table naver_rank_snapshots (
      id uuid primary key, tracker_id uuid, checked_at timestamptz, rank integer,
      matched boolean, source text, collection_id text, item jsonb,
      top_items jsonb, checked_count integer, total integer
    );
    create table naver_shopping_rank_lookup_jobs (
      status text, processing_until timestamptz
    );
    create table naver_shopping_worker_coordination (
      lane_key text primary key, primary_worker_id text,
      primary_seen_at timestamptz, circuit_state text, circuit_reason text,
      cooldown_until timestamptz, runtime_version text,
      runtime_fingerprint text, updated_at timestamptz, lease_worker_id text,
      lease_token text, lease_until timestamptz, run_id uuid,
      current_stage text, current_page integer, current_job_kind text,
      current_tracker_id uuid, current_job_started_at timestamptz,
      probe_tracker_id uuid, probe_started_at timestamptz
    );
    grant select on all tables in schema public to service_role;
  `);
  return database;
}

async function seedSuccessfulFinalRequest(database) {
  await database.exec(`
    insert into naver_shopping_account_priority_requests values (
      '${N30_ACCOUNT_PRIORITY_FINAL_REQUEST_ID}',
      '${N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE}',
      ${N30_ACCOUNT_PRIORITY_FINAL_COHORT_COUNT},
      '${N30_ACCOUNT_PRIORITY_FINAL_COHORT_HASH}',
      '${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_VERSION}',
      '${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_FINGERPRINT}',
      '2026-08-31T04:48:56.212Z',
      '2026-09-01T04:48:56.212Z',
      '${uuid(9, 1)}', 51, 'completed', '${requestCompletedAt}', null, true
    );
  `);

  const trackerRows = [];
  const memberRows = [];
  const eventRows = [];
  const runRows = [];
  const snapshotRows = [];
  const base = Date.parse("2026-08-31T04:50:00.000Z");
  const cursorTrackerId = uuid(7, 1);

  for (let position = 1; position <= N30_ACCOUNT_PRIORITY_FINAL_COHORT_COUNT; position += 1) {
    const trackerId = uuid(1, position);
    const cycleId = uuid(2, position);
    const runId = uuid(3, position);
    const claimId = uuid(4, position);
    const snapshotId = uuid(5, position);
    const productId = String(12149720000 + position);
    const eventBase = 20000 + position * 10;
    const leaseStartedAt = iso(base + position * 5_000);
    const groupAt = iso(base + position * 5_000 + 500);
    const claimAt = iso(base + position * 5_000 + 1_000);
    const runAt = iso(base + position * 5_000 + 1_500);
    const terminalAt = iso(base + position * 5_000 + 2_500);
    const leaseUntil = iso(base + position * 5_000 + 60_000);
    const collectionId = `pw-chrome-final-${position}`;
    const groupFingerprint = `frozen-${position}`;
    const item = {
      collectionId,
      source: "naver_shopping_results_collector",
      adExcluded: true,
      rankPolicy: "organic_only",
      rankEvidence: "naver_shopping_organic_list",
      excludedAdCount: 2,
      isOrganic: true,
      isAd: false,
      trackingRankSource: "exact_product",
      sellerProductId: productId,
      productId: String(89694230000 + position),
    };

    trackerRows.push(
      `('${trackerId}', '${N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE}', '${productId}', `
        + `'active', ${position}, '${terminalAt}', null)`,
    );
    memberRows.push(`(
      '${N30_ACCOUNT_PRIORITY_FINAL_REQUEST_ID}', ${position}, '${trackerId}',
      'terminal_success', '${leaseStartedAt}', '${cycleId}', ${position}, '${runId}',
      '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}', '${leaseStartedAt}', '${leaseUntil}',
      ${eventBase + 1}, '${claimId}', '${terminalAt}', ${eventBase + 2},
      'tracker_committed', null,
      777, '2026-08-31T04:40:00Z', '${cursorTrackerId}', true,
      777, '2026-08-31T04:40:00Z', '${cursorTrackerId}', true
    )`);
    eventRows.push(
      `(${eventBase}, '${groupAt}', 'group_claimed', '${cycleId}', ${position}, `
        + `'${claimId}', '${runId}', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}', `
        + `null, null, '${groupFingerprint}', 'normal', '${leaseStartedAt}', `
        + `'${leaseUntil}', null, null, null, '{}'::jsonb)`,
      `(${eventBase + 1}, '${claimAt}', 'tracker_claimed', '${cycleId}', ${position}, `
        + `'${claimId}', '${runId}', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}', `
        + `'${trackerId}', '${N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE}', `
        + `'${groupFingerprint}', 'normal', '${leaseStartedAt}', '${leaseUntil}', `
        + `null, null, null, '{}'::jsonb)`,
      `(${eventBase + 2}, '${terminalAt}', 'tracker_committed', '${cycleId}', ${position}, `
        + `'${claimId}', '${runId}', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}', `
        + `'${trackerId}', '${N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE}', `
        + `'${groupFingerprint}', 'normal', '${leaseStartedAt}', '${leaseUntil}', `
        + `'${collectionId}', 300, null, '{}'::jsonb)`,
    );
    runRows.push(
      `('${runId}', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}', 'rank-catch-up', `
        + `'${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_VERSION}', `
        + `'${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_FINGERPRINT}', '${runAt}')`,
    );
    snapshotRows.push(
      `('${snapshotId}', '${trackerId}', '${terminalAt}', ${position}, true, `
        + `'naver_shopping_results_collector', '${collectionId}', `
        + `${quote(JSON.stringify(item))}::jsonb, `
        + `'[{"isOrganic":true,"isAd":false}]'::jsonb, 300, 300)`,
    );
  }

  await database.exec(`
    insert into naver_rank_trackers values ${trackerRows.join(",\n")};
    insert into naver_shopping_account_priority_members values ${memberRows.join(",\n")};
    insert into naver_shopping_scheduler_events values ${eventRows.join(",\n")};
    insert into naver_shopping_worker_runs values ${runRows.join(",\n")};
    insert into naver_rank_snapshots values ${snapshotRows.join(",\n")};
  `);

  const resumeTrackerId = uuid(6, 1);
  const resumeCycleId = uuid(6, 2);
  const resumeRunId = uuid(6, 3);
  const resumeClaimId = uuid(6, 4);
  await database.exec(`
    insert into naver_rank_trackers values (
      '${resumeTrackerId}', 'another-account', '13327339999', 'active', 7,
      '2026-08-31T05:31:04Z', null
    );
    insert into naver_shopping_worker_runs values (
      '${resumeRunId}', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}', 'rank-catch-up',
      '${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_VERSION}',
      '${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_FINGERPRINT}',
      '2026-08-31T05:31:02Z'
    );
    insert into naver_shopping_scheduler_events values
      (30000, '2026-08-31T05:31:00Z', 'group_claimed', '${resumeCycleId}', 99,
       '${resumeClaimId}', '${resumeRunId}', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}',
       null, null, 'global-resume', 'normal', '2026-08-31T05:31:00Z',
       '2026-08-31T05:33:00Z', null, null, null, '{}'::jsonb),
      (30001, '2026-08-31T05:31:01Z', 'tracker_claimed', '${resumeCycleId}', 99,
       '${resumeClaimId}', '${resumeRunId}', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}',
       '${resumeTrackerId}', 'another-account', 'global-resume', 'normal',
       '2026-08-31T05:31:00Z', '2026-08-31T05:33:00Z', null, null, null, '{}'::jsonb),
      (30002, '2026-08-31T05:31:04Z', 'tracker_committed', '${resumeCycleId}', 99,
       '${resumeClaimId}', '${resumeRunId}', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}',
       '${resumeTrackerId}', 'another-account', 'global-resume', 'normal',
       '2026-08-31T05:31:00Z', '2026-08-31T05:33:00Z',
       'pw-chrome-resume', 300, null, '{}'::jsonb);
    insert into naver_shopping_worker_coordination values (
      'global', '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}', '2026-08-31T05:59:30Z',
      'closed', null, null, '${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_VERSION}',
      '${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_FINGERPRINT}', '2026-08-31T05:59:40Z',
      null, null, null, null, null, 0, null, null, null, null, null
    );
  `);
}

function extractAudit(results) {
  return results.find((result) => result.command === "SELECT")?.rows[0]?.audit;
}

test("builds a fixed one-transaction final audit without sensitive payloads or writes", () => {
  const sql = buildN30AccountPriorityFinalAuditSql({ observedAt });

  assert.equal(N30_ACCOUNT_PRIORITY_FINAL_COHORT_COUNT, 28);
  assert.equal(N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE, "mml93-a01");
  assert.match(N30_ACCOUNT_PRIORITY_FINAL_REQUEST_ID, /^[a-f0-9-]{36}$/u);
  assert.match(N30_ACCOUNT_PRIORITY_FINAL_COHORT_HASH, /^[a-f0-9]{32}$/u);
  assert.match(N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_FINGERPRINT, /^[a-f0-9]{64}$/u);
  assert.match(
    sql,
    /^begin transaction isolation level repeatable read read only;\nset local role service_role;/iu,
  );
  assert.match(sql, /'2026-08-31T06:00:00\.000000Z'::timestamptz as observed_at/iu);
  assert.match(sql, /request_state_partition|member_state_partition/iu);
  assert.match(sql, /group_event_id < evidence\.claim_event_id/iu);
  assert.match(sql, /evidence\.claim_event_id < evidence\.actual_terminal_event_id/iu);
  assert.match(sql, /evidence\.request_claim_count = 1/iu);
  assert.match(sql, /evidence\.group_at >= evidence\.request_requested_at/iu);
  assert.match(
    sql,
    /evidence\.actual_terminal_at <= coalesce\([\s\S]*?evidence\.request_completed_at, params\.observed_at/iu,
  );
  assert.match(sql, /evidence\.claimed_at <= evidence\.group_at/iu);
  assert.match(sql, /evidence\.group_at <= evidence\.actual_claim_at/iu);
  assert.match(sql, /evidence\.actual_claim_at <= evidence\.run_started_at/iu);
  assert.match(sql, /evidence\.actual_terminal_at <= evidence\.claimed_lease_until/iu);
  assert.match(sql, /claim_duplicate_count/iu);
  assert.match(sql, /terminal_duplicate_count/iu);
  assert.match(sql, /cursor_mismatch_count/iu);
  assert.match(sql, /invalid_success_snapshot_contract_count/iu);
  assert.match(sql, /invalid_success_materialization_contract_count/iu);
  assert.match(sql, /snapshot\.checked_count = 300/iu);
  assert.match(sql, /snapshot\.source = 'naver_shopping_results_collector'/iu);
  assert.match(sql, /snapshot\.item ->> 'sellerProductId' = member\.product_id/iu);
  assert.match(
    sql,
    /not \(snapshot\.item \? 'sellerProductId'\)[\s\S]*?snapshot\.item ->> 'productId' = member\.product_id/iu,
  );
  assert.match(sql, /relatedCatalogRelationBasis' = 'catalog_seller_product_id'/iu);
  assert.match(sql, /evidence\.current_rank is not distinct from evidence\.snapshot_rank/iu);
  assert.match(sql, /grouped\.agency_code is null/iu);
  assert.match(sql, /claim\.agency_code <> params\.agency_code/iu);
  assert.match(sql, /resume\.priority in \('new', 'resume', 'normal'\)/iu);
  assert.match(sql, /control\.primary_seen_at >= request\.completed_at/iu);
  assert.match(sql, /control\.updated_at >= request\.completed_at/iu);
  assert.match(sql, /'resumeObserved'/iu);
  assert.match(sql, /'accountSuccess'/iu);
  assert.match(sql, /'overallSuccess'/iu);
  assert.match(sql, /lease_token_is_null/iu);
  assert.equal((sql.match(/coordination\.lease_token/giu) || []).length, 1);
  assert.doesNotMatch(sql, /jsonb_build_object\([\s\S]*?'leaseToken'/iu);
  assert.doesNotMatch(sql, /\b(keyword|title|url)\b/iu);
  const aggregateOutput = sql.slice(sql.lastIndexOf("select pg_catalog.jsonb_build_object("));
  assert.doesNotMatch(
    aggregateOutput,
    /'(?:requestId|trackerId|productId|keyword|raw|leaseToken)'/iu,
  );
  assert.doesNotMatch(sql, /\bfor\s+update\b/iu);
  assert.doesNotMatch(
    sql,
    /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke)\b/iu,
  );
  assert.doesNotMatch(sql, /clock_timestamp|statement_timestamp|now\s*\(/iu);
  assert.match(sql, /commit;\s*$/iu);
});

test("executes fail closed when the frozen request is absent", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.ok(audit);
  assert.equal(audit.requestRowCount, 0);
  assert.equal(audit.accountSuccess, false);
  assert.equal(audit.resumeObserved, false);
});

test("accepts exactly 28 proven members and a later non-account global resume", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.deepEqual(
    {
      requestRowCount: audit.requestRowCount,
      memberCount: audit.memberCount,
      terminalSuccessCount: audit.terminalSuccessCount,
      proofSuccessCount: audit.proofSuccessCount,
      terminalFailureCount: audit.terminalFailureCount,
      integrityFailureCount: audit.integrityFailureCount,
      expiredCount: audit.expiredCount,
      openCount: audit.openCount,
      stale24hCount: audit.stale24hCount,
      fullIdle: audit.fullIdle,
      accountSuccess: audit.accountSuccess,
      overallSuccess: audit.overallSuccess,
      resumeObserved: audit.resumeObserved,
    },
    {
      requestRowCount: 1,
      memberCount: 28,
      terminalSuccessCount: 28,
      proofSuccessCount: 28,
      terminalFailureCount: 0,
      integrityFailureCount: 0,
      expiredCount: 0,
      openCount: 0,
      stale24hCount: 0,
      fullIdle: true,
      accountSuccess: true,
      overallSuccess: true,
      resumeObserved: true,
    },
  );
});

test("accepts the canonical lease then group then claim trigger timing with aggregate-only subconditions", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.deepEqual(
    {
      proofSuccessCount: audit.proofSuccessCount,
      invalidSuccessClaimContractCount: audit.invalidSuccessClaimContractCount,
      invalidSuccessClaimIdentityContractCount:
        audit.invalidSuccessClaimIdentityContractCount,
      invalidSuccessClaimLeaseContractCount: audit.invalidSuccessClaimLeaseContractCount,
      invalidSuccessWindowOrderContractCount: audit.invalidSuccessWindowOrderContractCount,
      invalidSuccessWindowBoundsContractCount: audit.invalidSuccessWindowBoundsContractCount,
      invalidSuccessEventOrderContractCount: audit.invalidSuccessEventOrderContractCount,
      invalidSuccessRunContractCount: audit.invalidSuccessRunContractCount,
      accountSuccess: audit.accountSuccess,
    },
    {
      proofSuccessCount: 28,
      invalidSuccessClaimContractCount: 0,
      invalidSuccessClaimIdentityContractCount: 0,
      invalidSuccessClaimLeaseContractCount: 0,
      invalidSuccessWindowOrderContractCount: 0,
      invalidSuccessWindowBoundsContractCount: 0,
      invalidSuccessEventOrderContractCount: 0,
      invalidSuccessRunContractCount: 0,
      accountSuccess: true,
    },
  );
});

test("aggregate-only subconditions still reject lease and event-order corruption", async (t) => {
  await t.test("claim-event lease drift", async () => {
    const database = await createAuditDatabase();
    try {
      await seedSuccessfulFinalRequest(database);
      await database.exec(`
        update naver_shopping_scheduler_events
        set lease_started_at = lease_started_at + interval '1 millisecond'
        where event_id = 20011
      `);

      const audit = extractAudit(await database.exec(
        buildN30AccountPriorityFinalAuditSql({ observedAt }),
      ));
      assert.deepEqual(
        {
          proofSuccessCount: audit.proofSuccessCount,
          invalidClaim: audit.invalidSuccessClaimContractCount,
          invalidClaimIdentity: audit.invalidSuccessClaimIdentityContractCount,
          invalidClaimLease: audit.invalidSuccessClaimLeaseContractCount,
          invalidWindow: audit.invalidSuccessWindowOrderContractCount,
          invalidWindowBounds: audit.invalidSuccessWindowBoundsContractCount,
          invalidEventOrder: audit.invalidSuccessEventOrderContractCount,
          invalidRun: audit.invalidSuccessRunContractCount,
        },
        {
          proofSuccessCount: 27,
          invalidClaim: 1,
          invalidClaimIdentity: 0,
          invalidClaimLease: 1,
          invalidWindow: 0,
          invalidWindowBounds: 0,
          invalidEventOrder: 0,
          invalidRun: 0,
        },
      );
    } finally {
      await database.close();
    }
  });

  await t.test("group event before frozen lease", async () => {
    const database = await createAuditDatabase();
    try {
      await seedSuccessfulFinalRequest(database);
      await database.exec(`
        update naver_shopping_scheduler_events
        set occurred_at = lease_started_at - interval '1 millisecond'
        where event_id = 20010
      `);

      const audit = extractAudit(await database.exec(
        buildN30AccountPriorityFinalAuditSql({ observedAt }),
      ));
      assert.deepEqual(
        {
          proofSuccessCount: audit.proofSuccessCount,
          invalidClaim: audit.invalidSuccessClaimContractCount,
          invalidClaimIdentity: audit.invalidSuccessClaimIdentityContractCount,
          invalidClaimLease: audit.invalidSuccessClaimLeaseContractCount,
          invalidWindow: audit.invalidSuccessWindowOrderContractCount,
          invalidWindowBounds: audit.invalidSuccessWindowBoundsContractCount,
          invalidEventOrder: audit.invalidSuccessEventOrderContractCount,
          invalidRun: audit.invalidSuccessRunContractCount,
        },
        {
          proofSuccessCount: 27,
          invalidClaim: 0,
          invalidClaimIdentity: 0,
          invalidClaimLease: 0,
          invalidWindow: 1,
          invalidWindowBounds: 0,
          invalidEventOrder: 1,
          invalidRun: 0,
        },
      );
    } finally {
      await database.close();
    }
  });
});

test("terminal and materialization guards remain fail closed", async (t) => {
  await t.test("terminal worker identity drift", async () => {
    const database = await createAuditDatabase();
    try {
      await seedSuccessfulFinalRequest(database);
      await database.exec(`
        update naver_shopping_scheduler_events
        set worker_id = 'windows-desktop-standby'
        where event_id = 20012
      `);

      const audit = extractAudit(await database.exec(
        buildN30AccountPriorityFinalAuditSql({ observedAt }),
      ));
      assert.equal(audit.proofSuccessCount, 27);
      assert.equal(audit.invalidSuccessTerminalContractCount, 1);
      assert.equal(audit.invalidSuccessSnapshotContractCount, 0);
      assert.equal(audit.invalidSuccessMaterializationContractCount, 0);
      assert.equal(audit.invalidSuccessCursorContractCount, 0);
    } finally {
      await database.close();
    }
  });

  await t.test("materialized tracker rank drift", async () => {
    const database = await createAuditDatabase();
    try {
      await seedSuccessfulFinalRequest(database);
      await database.exec(`
        update naver_rank_trackers
        set current_rank = current_rank + 1
        where id = '${uuid(1, 1)}'
      `);

      const audit = extractAudit(await database.exec(
        buildN30AccountPriorityFinalAuditSql({ observedAt }),
      ));
      assert.equal(audit.proofSuccessCount, 27);
      assert.equal(audit.invalidSuccessTerminalContractCount, 0);
      assert.equal(audit.invalidSuccessSnapshotContractCount, 0);
      assert.equal(audit.invalidSuccessMaterializationContractCount, 1);
      assert.equal(audit.invalidSuccessCursorContractCount, 0);
    } finally {
      await database.close();
    }
  });
});

test("keeps an active request contract valid while withholding final success", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);
  await database.exec(`
    update naver_shopping_account_priority_requests
    set state = 'active', completed_at = null, succeeded = null
    where request_id = '${N30_ACCOUNT_PRIORITY_FINAL_REQUEST_ID}'
  `);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.equal(audit.requestContractOk, true);
  assert.equal(audit.requestActiveCount, 1);
  assert.equal(audit.proofSuccessCount, 28);
  assert.equal(audit.requestCompletedSuccessfully, false);
  assert.equal(audit.fullIdle, false);
  assert.equal(audit.invalidSuccessEvidenceCount, 0);
  assert.equal(audit.invalidSuccessSnapshotContractCount, 0);
  assert.equal(audit.accountSuccess, false);
  assert.equal(audit.overallSuccess, false);
});

test("does not fall back to productId when a conflicting sellerProductId is present", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);

  await database.exec(`
    update naver_rank_snapshots as snapshot
    set item = pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(snapshot.item, '{sellerProductId}', '"99999999999"'::jsonb),
      '{productId}', pg_catalog.to_jsonb(tracker.product_id)
    )
    from naver_rank_trackers as tracker
    where tracker.id = snapshot.tracker_id
      and tracker.agency_code = '${N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE}'
      and snapshot.tracker_id = '${uuid(1, 1)}'
  `);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.equal(audit.proofSuccessCount, 27);
  assert.equal(audit.invalidSuccessEvidenceCount, 1);
  assert.equal(audit.invalidSuccessSnapshotContractCount, 1);
  assert.equal(audit.invalidSuccessTrackerContractCount, 0);
  assert.equal(audit.invalidSuccessCardinalityContractCount, 0);
  assert.equal(audit.invalidSuccessClaimContractCount, 0);
  assert.equal(audit.invalidSuccessWindowOrderContractCount, 0);
  assert.equal(audit.invalidSuccessGroupContractCount, 0);
  assert.equal(audit.invalidSuccessRunContractCount, 0);
  assert.equal(audit.invalidSuccessTerminalContractCount, 0);
  assert.equal(audit.invalidSuccessMaterializationContractCount, 0);
  assert.equal(audit.invalidSuccessCursorContractCount, 0);
  assert.equal(audit.accountSuccess, false);
});

test("productId fallback is allowed only when sellerProductId is absent", async (t) => {
  await t.test("absent key", async () => {
    const database = await createAuditDatabase();
    try {
      await seedSuccessfulFinalRequest(database);
      await database.exec(`
        update naver_rank_snapshots as snapshot
        set item = pg_catalog.jsonb_set(
          snapshot.item - 'sellerProductId',
          '{productId}', pg_catalog.to_jsonb(tracker.product_id)
        )
        from naver_rank_trackers as tracker
        where tracker.id = snapshot.tracker_id
          and snapshot.tracker_id = '${uuid(1, 1)}'
      `);
      const audit = extractAudit(await database.exec(
        buildN30AccountPriorityFinalAuditSql({ observedAt }),
      ));
      assert.equal(audit.accountSuccess, true);
    } finally {
      await database.close();
    }
  });

  for (const [label, sellerValue] of [["empty key", '""'], ["json null key", "null"]]) {
    await t.test(label, async () => {
      const database = await createAuditDatabase();
      try {
        await seedSuccessfulFinalRequest(database);
        await database.exec(`
          update naver_rank_snapshots as snapshot
          set item = pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(snapshot.item, '{sellerProductId}', '${sellerValue}'::jsonb),
            '{productId}', pg_catalog.to_jsonb(tracker.product_id)
          )
          from naver_rank_trackers as tracker
          where tracker.id = snapshot.tracker_id
            and snapshot.tracker_id = '${uuid(1, 1)}'
        `);
        const audit = extractAudit(await database.exec(
          buildN30AccountPriorityFinalAuditSql({ observedAt }),
        ));
        assert.equal(audit.proofSuccessCount, 27);
        assert.equal(audit.accountSuccess, false);
      } finally {
        await database.close();
      }
    });
  }
});

test("the first terminal failure cannot be replaced by a later success", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);

  const trackerId = uuid(1, 5);
  await database.exec(`
    update naver_shopping_account_priority_members
    set state = 'claimed', terminal_at = null, terminal_event_id = null,
        terminal_event_type = null, terminal_code = null
    where tracker_id = '${trackerId}';
    update naver_shopping_scheduler_events
    set event_type = 'job_failed', collection_id = null, checked_count = null,
        error_code = 'provider_stable_rendered_order_unproven:page_boundary:2'
    where event_id = 20052;
    insert into naver_shopping_scheduler_events
    select 20053, occurred_at + interval '1 second', 'tracker_committed',
           cycle_id, cycle_number, claim_id, run_id, worker_id, tracker_id,
           agency_code, group_fingerprint, priority, lease_started_at,
           lease_until, 'pw-chrome-later-success', 300, null, '{}'::jsonb
    from naver_shopping_scheduler_events where event_id = 20052;
  `);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.equal(audit.observedTerminalFailureCount, 1);
  assert.equal(audit.observedTerminalSuccessCount, 27);
  assert.equal(audit.terminalDuplicateCount, 1);
  assert.equal(audit.accountSuccess, false);
});

test("rejects a terminal event id that precedes its frozen claim event id", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);

  await database.exec(`
    update naver_shopping_scheduler_events
    set event_id = case event_id
      when 20010 then 40010
      when 20011 then 40012
      when 20012 then 40011
      else event_id
    end
    where event_id in (20010, 20011, 20012);
    update naver_shopping_account_priority_members
    set claim_event_id = 40012, terminal_event_id = 40011
    where tracker_id = '${uuid(1, 1)}';
  `);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.equal(audit.invalidSuccessEvidenceCount, 1);
  assert.equal(audit.invalidSuccessWindowOrderContractCount, 1);
  assert.equal(audit.accountSuccess, false);
});

test("rejects request-member evidence outside the immutable request window", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);

  await database.exec(`
    update naver_shopping_scheduler_events
    set occurred_at = occurred_at - interval '2 hours',
        lease_started_at = lease_started_at - interval '2 hours',
        lease_until = lease_until - interval '2 hours'
    where event_id in (20010, 20011, 20012);
    update naver_shopping_worker_runs
    set started_at = started_at - interval '2 hours'
    where run_id = '${uuid(3, 1)}';
    update naver_shopping_account_priority_members
    set claimed_at = claimed_at - interval '2 hours',
        claimed_lease_started_at = claimed_lease_started_at - interval '2 hours',
        claimed_lease_until = claimed_lease_until - interval '2 hours',
        terminal_at = terminal_at - interval '2 hours'
    where tracker_id = '${uuid(1, 1)}';
    update naver_rank_snapshots
    set checked_at = checked_at - interval '2 hours'
    where tracker_id = '${uuid(1, 1)}';
    update naver_rank_trackers
    set last_checked_at = last_checked_at - interval '2 hours'
    where id = '${uuid(1, 1)}';
  `);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.equal(audit.invalidSuccessEvidenceCount, 1);
  assert.equal(audit.invalidSuccessWindowOrderContractCount, 1);
  assert.equal(audit.accountSuccess, false);
});

test("reports aggregate-only overlapping proof contract failures", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);

  const trackerId = uuid(1, 1);
  await database.exec(`
    update naver_shopping_worker_runs
    set runtime_fingerprint = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    where run_id = '${uuid(3, 1)}';
    update naver_shopping_account_priority_members
    set cursor_resume_after = false
    where tracker_id = '${trackerId}';
    update naver_rank_snapshots as snapshot
    set item = pg_catalog.jsonb_set(snapshot.item, '{sellerProductId}', '"99999999999"'::jsonb)
    where snapshot.tracker_id = '${trackerId}'
  `);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.equal(audit.invalidSuccessEvidenceCount, 1);
  assert.equal(audit.invalidSuccessRunContractCount, 1);
  assert.equal(audit.invalidSuccessSnapshotContractCount, 1);
  assert.equal(audit.invalidSuccessCursorContractCount, 1);
  assert.equal(audit.invalidSuccessTrackerContractCount, 0);
  assert.equal(audit.invalidSuccessCardinalityContractCount, 0);
  assert.equal(audit.invalidSuccessClaimContractCount, 0);
  assert.equal(audit.invalidSuccessWindowOrderContractCount, 0);
  assert.equal(audit.invalidSuccessGroupContractCount, 0);
  assert.equal(audit.invalidSuccessTerminalContractCount, 0);
  assert.equal(audit.invalidSuccessMaterializationContractCount, 0);
  assert.equal(audit.accountSuccess, false);
});

test("does not call a repair chain a resumed global scheduler chain", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);
  await database.exec(`
    update naver_shopping_scheduler_events
    set priority = 'repair'
    where event_id in (30000, 30001, 30002)
  `);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.equal(audit.accountSuccess, true);
  assert.equal(audit.validResumeCount, 0);
  assert.equal(audit.resumeObserved, false);
  assert.equal(audit.overallSuccess, false);
});

test("requires idle heartbeat evidence after request completion", async (t) => {
  const database = await createAuditDatabase();
  t.after(() => database.close());
  await seedSuccessfulFinalRequest(database);
  await database.exec(`
    update naver_shopping_account_priority_requests
    set completed_at = '2026-08-31T05:59:35Z'
    where request_id = '${N30_ACCOUNT_PRIORITY_FINAL_REQUEST_ID}'
  `);

  const audit = extractAudit(await database.exec(
    buildN30AccountPriorityFinalAuditSql({ observedAt }),
  ));
  assert.equal(audit.fullIdle, false);
  assert.equal(audit.accountSuccess, false);
});
