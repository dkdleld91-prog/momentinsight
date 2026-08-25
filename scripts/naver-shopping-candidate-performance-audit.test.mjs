import assert from "node:assert/strict";
import test from "node:test";

import { buildN30CandidatePerformanceAuditSql } from "./naver-shopping-candidate-performance-audit.mjs";

const validOptions = {
  activationAt: "2026-08-25T18:40:00.000000Z",
  observedAt: "2026-08-25T20:45:00.000000Z",
  cadenceSeconds: 360,
  workerId: "windows-desktop-primary",
  runtimeVersion: "1.1.13",
  runtimeFingerprint: "cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6",
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
  assert.match(sql, /missing_or_identity_mismatch/);
  assert.match(sql, /n30_candidate_performance_audit_v1/);
  assert.match(sql, /candidate_success/);
  assert.match(sql, /commit;\s*$/i);

  assert.doesNotMatch(sql, /mi_set_naver_shopping_worker_cadence/i);
  assert.doesNotMatch(sql, /\bfor\s+update\b/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke)\b/i);
  assert.doesNotMatch(sql, /clock_timestamp|statement_timestamp|now\s*\(/i);
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
    () => buildN30CandidatePerformanceAuditSql({ ...validOptions, activationAt: "not-a-date" }),
    /activationAt/,
  );
});
