import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  N30_TARGET_RUNTIME_FINGERPRINT,
  N30_TARGET_RUNTIME_VERSION,
  N30_TARGET_WORKER_ID,
  buildN30CandidatePerformanceAuditSql,
} from "./naver-shopping-candidate-performance-audit.mjs";

const validOptions = {
  activationAt: "2026-08-25T18:40:00.000000Z",
  observedAt: "2026-08-25T20:45:00.000000Z",
  cadenceSeconds: 360,
  workerId: N30_TARGET_WORKER_ID,
  runtimeVersion: N30_TARGET_RUNTIME_VERSION,
  runtimeFingerprint: N30_TARGET_RUNTIME_FINGERPRINT,
};

function classifyTerminalFixture({
  trackerClaimCount = 1,
  atomicCommitCount = 0,
  finiteCommitCount = 0,
  finiteNeutralFailureCount = 0,
  finiteInvalidTerminalCount = 0,
  failureCount = 0,
}) {
  const blockingFailureCount = failureCount - finiteNeutralFailureCount;
  const globallyComplete = trackerClaimCount > 0
    && atomicCommitCount + finiteCommitCount + failureCount === trackerClaimCount
    && blockingFailureCount === 0
    && finiteInvalidTerminalCount === 0;
  const fullyTerminalAtomic = trackerClaimCount > 0
    && atomicCommitCount === trackerClaimCount
    && finiteCommitCount === 0
    && failureCount === 0;
  return {
    globallyComplete,
    fullyTerminalAtomic,
    throughputContribution: Number(fullyTerminalAtomic),
    collectionCountContribution: Number(atomicCommitCount > 0),
  };
}

function isExactFiniteNeutralFailureFixture(fixture) {
  return fixture.runTrigger === "rank-catch-up"
    && fixture.workerId === N30_TARGET_WORKER_ID
    && fixture.runtimeVersion === N30_TARGET_RUNTIME_VERSION
    && fixture.runtimeFingerprint === N30_TARGET_RUNTIME_FINGERPRINT
    && [
      "provider_stable_finite_window_unproven",
      "local_worker_finite_match_invalid",
    ].includes(fixture.errorCode)
    && fixture.targetMatched === true
    && fixture.groupMemberCount === 1
    && fixture.trackerClaimCount === 1
    && fixture.failureCount === 1
    && fixture.quarantineCount === 1
    && fixture.quarantineDurationValid === true
    && fixture.groupBeforeClaim === true
    && fixture.claimBeforeFailure === true
    && fixture.failureBeforeQuarantine === true;
}

test("builds one fixed-wall read-only candidate audit with the full integrity contract", () => {
  assert.equal(N30_TARGET_RUNTIME_VERSION, "1.1.16");
  assert.equal(
    N30_TARGET_RUNTIME_FINGERPRINT,
    "9680164f90965609896b72c05b09e67946bc51d1df44c76d0cb5b9e5f0085478",
  );
  const sql = buildN30CandidatePerformanceAuditSql(validOptions);

  assert.match(sql, /^begin read only;/i);
  assert.match(sql, /set local transaction isolation level repeatable read;/i);
  assert.match(sql, /'2026-08-25T18:40:00\.000000Z'::timestamptz/);
  assert.match(sql, /'2026-08-25T20:45:00\.000000Z'::timestamptz/);
  assert.match(sql, /360::integer as cadence_seconds/);
  assert.match(sql, /120::integer as grid_tolerance_seconds/);
  assert.match(sql, /run_trigger = 'rank-catch-up'/);
  assert.match(sql, /runtime_version = p\.runtime_version/);
  assert.match(sql, /runtime_fingerprint = p\.runtime_fingerprint/);
  assert.match(sql, /worker_id = p\.worker_id/);
  assert.match(sql, /e\.worker_id is distinct from p\.worker_id/);
  assert.match(sql, /tc\.worker_id is distinct from p\.worker_id/);
  assert.match(sql, /group_count = 1/);
  assert.match(sql, /tracker_claim_count = distinct_tracker_claim_count/);
  assert.match(sql, /commit_count = tracker_claim_count/);
  assert.match(sql, /failure_count = 0/);
  assert.match(sql, /checked_count = 300/);
  assert.match(sql, /naver_shopping_results_collector/);
  assert.match(sql, /naver_shopping_organic_list/);
  assert.match(sql, /organic_only/);
  assert.match(sql, /adExcluded/);
  assert.match(sql, /isOrganic/);
  assert.match(sql, /isAd/);
  assert.match(sql, /post_bootstrap_groups/);
  assert.match(sql, /grid_violation_count/);
  assert.match(sql, /overlap_pairs/);
  assert.match(sql, /all_groups_per_run_violation/);
  assert.match(sql, /all_tracker_or_commit_duplicate_count/);
  assert.match(sql, /all_collection_count_violation/);
  assert.match(sql, /all_failure_count/);
  assert.match(sql, /all_atomic_invalid_commit_count/);
  assert.match(sql, /commit_membership_mismatch_count/);
  assert.match(sql, /event_order_violation_count/);
  assert.match(sql, /tc\.tracker_id = cm\.tracker_id/);
  assert.match(sql, /s\.checked_at <= cm\.occurred_at/);
  assert.match(sql, /s\.checked_at >=/);
  assert.match(sql, /cm\.collection_id !~ '\^pw-chrome-'/);
  assert.match(sql, /window_cycles as/);
  assert.match(sql, /group_event_id/);
  assert.match(sql, /all_cycle_identity_missing_count/);
  assert.match(sql, /prior\.event_id < cf\.group_event_id/);
  assert.match(sql, /prior\.priority in \('normal', 'resume'\)/);
  assert.match(sql, /cursor_evidence_invalid_count/);
  assert.match(sql, /cursor_nonforward_or_fallback_count/);
  assert.match(
    sql,
    /cursor_audit as \([\s\S]+cross join params p[\s\S]+and exists \([\s\S]+tc\.occurred_at <= p\.observed_at[\s\S]+<= row\([\s\S]+\),\s*global_integrity/,
  );
  assert.match(sql, /missing_or_identity_mismatch/);
  assert.match(sql, /c\.updated_at/);
  assert.match(sql, /cp\.updated_at <= p\.observed_at/);
  assert.match(sql, /\(c\.lease_token is null\) as lease_token_is_null/);
  assert.match(sql, /cp\.lease_token_is_null/);
  assert.equal((sql.match(/\bc\.lease_token\b/gu) || []).length, 1);
  assert.doesNotMatch(sql, /\n\s*c\.lease_token,\n/u);
  assert.doesNotMatch(sql, /cp\.lease_token is null/u);
  assert.match(sql, /pg_catalog\.jsonb_array_elements\(\s*case/);
  assert.match(sql, /n30_candidate_performance_audit_v1/);
  assert.match(sql, /candidate_success/);
  assert.match(sql, /commit;\s*$/i);

  assert.doesNotMatch(sql, /mi_set_naver_shopping_worker_cadence/i);
  assert.doesNotMatch(sql, /\bfor\s+update\b/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke)\b/i);
  assert.doesNotMatch(sql, /clock_timestamp|statement_timestamp|now\s*\(/i);
  assert.doesNotMatch(sql, /representative_tracker_id/);
  assert.doesNotMatch(sql, /offset_seconds - slot_number/);
  assert.doesNotMatch(sql, /excludedAdCount'\)::integer/);
});

test("supports the baseline cadence while keeping the same query contract", () => {
  const sql = buildN30CandidatePerformanceAuditSql({
    ...validOptions,
    cadenceSeconds: 600,
  });

  assert.match(sql, /600::integer as cadence_seconds/);
  assert.match(sql, /n30_candidate_performance_audit_v1/);
});

test("treats an exact finite terminal as global completion but never atomic performance", () => {
  const finiteTerminalFixture = {
    eventType: "finite_window_committed",
    checkedCount: 137,
    source: "naver_shopping_results_collector",
    proofVersion: "stable-finite-window-v1",
    sourceExhausted: true,
    matched: true,
    rank: 1,
    marketTotal: 137,
    relationBasis: "catalog_seller_product_id",
    atomicSuccessEligible: false,
  };
  const sql = buildN30CandidatePerformanceAuditSql(validOptions);

  assert.equal(finiteTerminalFixture.eventType, "finite_window_committed");
  assert.ok(finiteTerminalFixture.checkedCount > 0 && finiteTerminalFixture.checkedCount < 300);
  assert.deepEqual(classifyTerminalFixture({ finiteCommitCount: 1 }), {
    globallyComplete: true,
    fullyTerminalAtomic: false,
    throughputContribution: 0,
    collectionCountContribution: 0,
  });
  assert.match(sql, /as finite_commit_count/);
  assert.match(sql, /as distinct_finite_commit_tracker_count/);
  assert.match(sql, /as finite_invalid_terminal_count/);
  assert.match(
    sql,
    /te\.event_type in \('tracker_committed', 'finite_window_committed', 'job_failed'\)/,
  );
  assert.match(
    sql,
    /commit_count \+ finite_commit_count \+ failure_count <> tracker_claim_count/,
  );
  assert.match(sql, /finite_commit_count = 0[\s\S]+as fully_terminal_atomic/);
  assert.match(
    sql,
    /count\(\*\) filter \(\s*where fully_terminal_atomic and atomic_sequence_no > 1\s*\)/,
  );
  assert.match(sql, /where fully_terminal_atomic\s+group by slot_number/);
  assert.match(sql, /where commit_count > 0\s+and collection_count <> 1/);

  assert.match(sql, /fw\.event_type = 'finite_window_committed'/);
  assert.match(sql, /fw\.checked_count not between 1 and 299/);
  assert.match(sql, /fw\.details ->> 'finiteWindowProofVersion' is distinct from 'stable-finite-window-v1'/);
  assert.match(sql, /fw\.details -> 'sourceExhausted' is distinct from 'true'::jsonb/);
  assert.match(sql, /fw\.details -> 'marketTotal' is distinct from pg_catalog\.to_jsonb\(fw\.checked_count\)/);
  assert.match(sql, /fw\.details -> 'matched' is distinct from 'true'::jsonb/);
  assert.match(sql, /fw\.details ->> 'relationBasis' is distinct from 'catalog_seller_product_id'/);
  assert.match(sql, /fw\.details -> 'atomicSuccessEligible' is distinct from 'false'::jsonb/);
  assert.match(sql, /s\.checked_count = fw\.checked_count/);
  assert.match(sql, /s\.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'/);
  assert.match(sql, /s\.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'/);
  assert.match(sql, /s\.item -> 'adExcluded' = 'true'::jsonb/);
  assert.match(sql, /s\.item -> 'isOrganic' = 'true'::jsonb/);
  assert.match(sql, /s\.item -> 'isAd' = 'false'::jsonb/);
  assert.match(sql, /target\.runtime_version = p\.runtime_version/);
  assert.match(sql, /target\.runtime_fingerprint = p\.runtime_fingerprint/);
});

test("fails closed for malformed or duplicate finite terminal fixtures", () => {
  const fixtures = [
    {
      name: "malformed finite proof",
      finiteTerminalCount: 1,
      distinctFiniteTrackerCount: 1,
      finiteInvalidTerminalCount: 1,
      expectedComplete: false,
    },
    {
      name: "duplicate finite terminal",
      finiteTerminalCount: 2,
      distinctFiniteTrackerCount: 1,
      finiteInvalidTerminalCount: 0,
      expectedComplete: false,
    },
  ];
  const sql = buildN30CandidatePerformanceAuditSql(validOptions);

  for (const fixture of fixtures) {
    assert.equal(fixture.expectedComplete, false, fixture.name);
  }
  assert.equal(classifyTerminalFixture({
    finiteCommitCount: fixtures[0].finiteTerminalCount,
    finiteInvalidTerminalCount: fixtures[0].finiteInvalidTerminalCount,
  }).globallyComplete, false);
  assert.equal(classifyTerminalFixture({
    finiteCommitCount: fixtures[1].finiteTerminalCount,
    finiteInvalidTerminalCount: fixtures[1].finiteInvalidTerminalCount,
  }).globallyComplete, false);
  assert.match(
    sql,
    /finite_commit_count <> distinct_finite_commit_tracker_count/,
  );
  assert.match(sql, /coalesce\(sum\(finite_invalid_terminal_count\), 0\)::integer/);
  assert.doesNotMatch(sql, /perf\.finite_invalid_terminal_count/);
  assert.match(sql, /gi\.all_finite_invalid_terminal_count = 0/);
});

test("accepts only an exact finite canary failure as global neutral completion", () => {
  const exactNeutralFixture = {
    runTrigger: "rank-catch-up",
    workerId: N30_TARGET_WORKER_ID,
    runtimeVersion: N30_TARGET_RUNTIME_VERSION,
    runtimeFingerprint: N30_TARGET_RUNTIME_FINGERPRINT,
    errorCode: "provider_stable_finite_window_unproven",
    targetMatched: true,
    groupMemberCount: 1,
    trackerClaimCount: 1,
    failureCount: 1,
    quarantineCount: 1,
    quarantineDurationValid: true,
    groupBeforeClaim: true,
    claimBeforeFailure: true,
    failureBeforeQuarantine: true,
  };
  const malformedFixtures = [
    { ...exactNeutralFixture, runTrigger: "rank-0900" },
    { ...exactNeutralFixture, workerId: "mac-standby" },
    { ...exactNeutralFixture, errorCode: "provider_partial_window:137_300" },
    { ...exactNeutralFixture, failureCount: 2 },
    { ...exactNeutralFixture, quarantineCount: 0 },
    { ...exactNeutralFixture, quarantineCount: 2 },
    { ...exactNeutralFixture, quarantineDurationValid: false },
  ];
  const sql = buildN30CandidatePerformanceAuditSql(validOptions);

  assert.equal(isExactFiniteNeutralFailureFixture(exactNeutralFixture), true);
  assert.deepEqual(classifyTerminalFixture({
    failureCount: 1,
    finiteNeutralFailureCount: Number(isExactFiniteNeutralFailureFixture(exactNeutralFixture)),
  }), {
    globallyComplete: true,
    fullyTerminalAtomic: false,
    throughputContribution: 0,
    collectionCountContribution: 0,
  });
  for (const fixture of malformedFixtures) {
    assert.equal(isExactFiniteNeutralFailureFixture(fixture), false);
    assert.equal(classifyTerminalFixture({
      failureCount: fixture.failureCount,
      finiteNeutralFailureCount: Number(isExactFiniteNeutralFailureFixture(fixture)),
    }).globallyComplete, false);
  }

  assert.match(sql, /as finite_neutral_failure_count/);
  assert.match(
    sql,
    /nf\.error_code in \(\s*'provider_stable_finite_window_unproven',\s*'local_worker_finite_match_invalid'\s*\)/,
  );
  assert.match(sql, /rg\.run_trigger = 'rank-catch-up'/);
  assert.match(sql, /target\.runtime_version = p\.runtime_version/);
  assert.match(sql, /target\.runtime_fingerprint = p\.runtime_fingerprint/);
  assert.match(sql, /q\.event_type = 'quarantine_set'/);
  assert.match(sql, /q\.event_id > nf\.event_id/);
  assert.match(
    sql,
    /q\.quarantine_until >= nf\.occurred_at \+ interval '30 minutes'/,
  );
  assert.match(
    sql,
    /q\.quarantine_until <= q\.occurred_at \+ interval '30 minutes'/,
  );
  assert.match(
    sql,
    /q\.event_type = 'quarantine_set'[\s\S]*q\.claim_id = nf\.claim_id[\s\S]*q\.run_id = nf\.run_id[\s\S]*q\.tracker_id = nf\.tracker_id[\s\S]*q\.occurred_at <= p\.observed_at[\s\S]*\) = 1/,
  );
  assert.match(sql, /failure_count - finite_neutral_failure_count > 0/);
  assert.match(sql, /as all_finite_neutral_failure_count/);
  assert.doesNotMatch(sql, /fully_terminal_atomic[\s\S]{0,500}finite_neutral_failure_count/);
});

test("rejects mutable, reversed, or malformed audit inputs", () => {
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, observedAt: validOptions.activationAt }),
    /observedAt must be after activationAt/,
  );
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, cadenceSeconds: 480 }),
    /cadenceSeconds must be 360 or 600/,
  );
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, workerId: "worker'; drop table x;--" }),
    /workerId/,
  );
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, runtimeVersion: "1.1" }),
    /runtimeVersion/,
  );
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, runtimeFingerprint: "0".repeat(64) }),
    /runtimeFingerprint/,
  );
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, workerId: "windows-desktop-secondary" }),
    /workerId must equal the pinned target/,
  );
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, runtimeVersion: "1.1.13" }),
    /runtimeVersion must equal the pinned target/,
  );
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, runtimeFingerprint: "a".repeat(64) }),
    /runtimeFingerprint must equal the pinned target/,
  );
  assert.throws(
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, activationAt: "not-a-date" }),
    /activationAt/,
  );
});

test("is included in the normal npm regression command", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.test, /naver-shopping-candidate-performance-audit\.test\.mjs/);
});
