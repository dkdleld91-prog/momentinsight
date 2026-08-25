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

test("builds one fixed-wall read-only candidate audit with the full integrity contract", () => {
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
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, runtimeVersion: "1.1.14" }),
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
