import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  N30_PARENT_CANARY_RELEASE_AUDIT,
  buildN30ParentCanaryReleaseAuditSql,
} from "./naver-shopping-parent-canary-release-audit.mjs";

const observedAt = "2026-08-28T08:10:00.000000Z";

function cteBody(sql, name, nextName) {
  const match = sql.match(new RegExp(`${name} as \\(([\\s\\S]*?)\\n\\),\\n${nextName} as`, "u"));
  assert.ok(match, `${name} CTE not found`);
  return match[1];
}

function sqlSlice(sql, startMarker, endMarker) {
  const start = sql.indexOf(startMarker);
  const end = sql.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} SQL slice not found`);
  return sql.slice(start, end);
}

test("pins the current release, exact parent identity, and immutable pre-gate state", () => {
  assert.deepEqual(N30_PARENT_CANARY_RELEASE_AUDIT, {
    marker: "n30_parent_canary_release_audit_v2",
    releaseCommit: "f96a83b2bbc5835cde2997c30beaf100c5ceab3a",
    recoveryMigrationVersion: "20260828035245",
    recoveryCommit: "b4e341d057f6dfc7104219907366ec689bea8137",
    workerId: "windows-desktop-primary",
    runtimeVersion: "1.1.16",
    runtimeFingerprint: "9680164f90965609896b72c05b09e67946bc51d1df44c76d0cb5b9e5f0085478",
    trackerId: "c0ccded2-9bf7-488e-af8d-00898c0a1ff8",
    normalizedKeyword: "아이쉘차량용거치대",
    sellerProductId: "13327339525",
    parentCatalogId: "59776958987",
    proofVersion: "stable-finite-window-v1",
    releaseEvidenceAt: "2026-08-28T03:57:48.469739Z",
    preGateQuarantinedUntil: "2026-08-28T08:03:53.577688Z",
    scheduledAnchorAt: "2026-08-28T03:57:48.469739Z",
    preGateControlStabilityStartedAt: "2026-08-28T03:47:48.550280Z",
    preGateState: {
      currentRank: null,
      lastCheckedAt: null,
      checkCount: 0,
      foundCount: 0,
      retryCount: 11,
      lastError: "provider_partial_window:100_300",
      snapshotCount: 0,
    },
  });
});

test("requires one fixed UTC observation and emits a read-only transaction", () => {
  assert.throws(() => buildN30ParentCanaryReleaseAuditSql(), /observedAt must be an ISO-8601 UTC timestamp/u);
  assert.throws(
    () => buildN30ParentCanaryReleaseAuditSql({ observedAt: "2026-08-28 08:10:00" }),
    /observedAt must be an ISO-8601 UTC timestamp/u,
  );
  const sql = buildN30ParentCanaryReleaseAuditSql({ observedAt });
  assert.match(sql, /^begin transaction isolation level repeatable read read only;/iu);
  assert.match(sql, /set local role service_role;/iu);
  assert.match(sql, /'2026-08-28T08:10:00\.000000Z'::timestamptz as observed_at/u);
  assert.match(sql, /commit;\s*$/iu);
  assert.doesNotMatch(sql, /statement_timestamp|clock_timestamp|now\s*\(/iu);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|merge|alter|drop|truncate|create|call|grant|revoke)\b/iu);
  assert.doesNotMatch(sql, /\bfor\s+update\b|mi_set_naver_shopping_worker_cadence/iu);
});

test("waits for the later release or quarantine gate and rejects premature claims", () => {
  const sql = buildN30ParentCanaryReleaseAuditSql({ observedAt });
  assert.match(sql, /greatest\(release_evidence_at, pre_gate_quarantined_until\) as eligible_at/u);
  assert.match(sql, /eligible_at \+ interval '24 hours' as claim_deadline_at/u);
  assert.match(sql, /occurred_at >= p\.release_evidence_at/u);
  assert.match(sql, /occurred_at < p\.eligible_at/u);
  assert.match(sql, /premature_claim_count <> 0/u);
  assert.match(sql, /'awaiting_eligible_time'/u);
  assert.match(
    sql,
    /when claim_id is null and observed_at < claim_deadline_at then 'awaiting_first_claim'/u,
  );
  assert.match(sql, /when claim_id is null then 'integrity_failure'/u);
  assert.ok(
    sql.indexOf("when exact_target_count <> 1") < sql.indexOf("when observed_at < eligible_at"),
    "integrity defects must not be hidden behind the time gate",
  );
});

test("selects the immutable first eligible claim before validating its identity", () => {
  const sql = buildN30ParentCanaryReleaseAuditSql({ observedAt });
  const firstClaim = cteBody(sql, "first_claim", "claim_context");
  assert.match(firstClaim, /event\.event_type = 'tracker_claimed'/u);
  assert.match(firstClaim, /event\.tracker_id = p\.tracker_id/u);
  assert.match(firstClaim, /event\.occurred_at >= p\.eligible_at/u);
  assert.match(firstClaim, /event\.occurred_at <= p\.observed_at/u);
  assert.match(firstClaim, /order by event\.event_id/u);
  assert.match(firstClaim, /limit 1/u);
  assert.doesNotMatch(firstClaim, /worker_id|run_trigger|runtime_version|runtime_fingerprint/u);
  assert.match(sql, /run_trigger is not distinct from 'rank-catch-up'/u);
  assert.match(sql, /run_runtime_fingerprint is not distinct from runtime_fingerprint/u);
  assert.match(sql, /claim_cycle_id is not null/u);
  assert.match(sql, /claim_cycle_number is not null/u);
  assert.match(sql, /claim_group_fingerprint is not null/u);
  assert.match(sql, /claim_priority in \('new', 'resume', 'normal'\)/u);
  assert.match(sql, /claim_at >= eligible_at/u);
  assert.match(sql, /group_at >= eligible_at/u);
  assert.match(sql, /group_at < claim_at/u);
  assert.match(sql, /claim_at < run_started_at/u);
  assert.match(sql, /same_cycle_group_count = 1/u);
  assert.match(sql, /same_cycle_tracker_claim_count = 1/u);
  assert.match(sql, /group_details -> 'memberCount' is not distinct from pg_catalog\.to_jsonb\(1\)/u);
  assert.match(sql, /claim_lease_started_at is not null/u);
  assert.match(sql, /claim_lease_started_at < claim_lease_until/u);
  assert.match(sql, /terminal_lease_until is not distinct from claim_lease_until/u);
  assert.match(sql, /terminal_lease_started_at < terminal_lease_until/u);
});

test("selects the first terminal without hiding an invalid outcome", () => {
  const sql = buildN30ParentCanaryReleaseAuditSql({ observedAt });
  const firstTerminal = cteBody(sql, "first_terminal", "terminal_context");
  assert.match(firstTerminal, /event\.event_type in \('tracker_committed', 'finite_window_committed', 'job_failed'\)/u);
  assert.match(firstTerminal, /event\.claim_id = claim\.claim_id/u);
  assert.match(firstTerminal, /order by event\.event_id/u);
  assert.match(firstTerminal, /limit 1/u);
  assert.doesNotMatch(firstTerminal, /error_code\s+in|checked_count\s+between|worker_id\s*=/u);
  assert.match(sql, /terminal_count = 1/u);
  assert.match(sql, /terminal_event_id > claim_event_id/u);
  assert.match(sql, /run_started_at < terminal_at/u);
  assert.match(
    sql,
    /when terminal_count = 0\s+and full_idle is not true\s+and observed_at < claim_lease_until\s+then 'awaiting_terminal'/u,
  );
  assert.match(sql, /when terminal_count = 0 then 'integrity_failure'/u);
  assert.match(
    sql,
    /when full_idle is not true and observed_at < terminal_at \+ interval '5 minutes'\s+then 'awaiting_post_idle'/u,
  );
  assert.match(sql, /when full_idle is not true then 'integrity_failure'/u);
});

test("accepts only exact direct-ID finite snapshots as success", () => {
  const sql = buildN30ParentCanaryReleaseAuditSql({ observedAt });
  assert.match(sql, /terminal_type = 'finite_window_committed'/u);
  assert.match(sql, /terminal_checked_count between 1 and 299/u);
  assert.match(sql, /sourceExhausted/u);
  assert.match(sql, /marketTotal/u);
  assert.match(sql, /trackingRankSource/u);
  assert.match(sql, /related_catalog/u);
  assert.match(sql, /relatedCatalogRelationBasis/u);
  assert.match(sql, /catalog_seller_product_id/u);
  assert.match(sql, /relatedCatalogProductId/u);
  assert.match(sql, /catalogSellerProductIds/u);
  assert.match(sql, /jsonb_array_length\(snapshot\.item -> 'catalogSellerProductIds'\) between 1 and 100/u);
  assert.match(sql, /seller_id\.seller_id = terminal\.seller_product_id/u);
  assert.match(sql, /snapshot\.item ->> 'rankEvidence' = 'naver_shopping_organic_list'/u);
  assert.match(sql, /snapshot\.item ->> 'collectionId' = snapshot\.collection_id/u);
  assert.match(sql, /snapshot\.item -> 'adExcluded' = 'true'::jsonb/u);
  assert.match(sql, /snapshot\.item -> 'isOrganic' = 'true'::jsonb/u);
  assert.match(sql, /snapshot\.item -> 'isAd' = 'false'::jsonb/u);
  assert.match(sql, /valid_finite_snapshot_count = 1/u);
  assert.match(sql, /terminal_details -> 'matched' is not distinct from 'true'::jsonb/u);
  assert.match(sql, /terminal_details -> 'rank' is not distinct from pg_catalog\.to_jsonb\(terminal_snapshot_rank\)/u);
  assert.match(sql, /terminal_details -> 'atomicSuccessEligible' is not distinct from 'false'::jsonb/u);
  assert.match(sql, /tracker_commit_count = 0/u);
  assert.match(sql, /job_failure_count = 0/u);
  assert.match(sql, /target_current_rank is not distinct from terminal_snapshot_rank/u);
  assert.match(sql, /target_last_checked_at is not distinct from terminal_at/u);
  assert.match(sql, /target_check_count is not distinct from pre_gate_check_count \+ 1/u);
  assert.match(sql, /target_found_count is not distinct from pre_gate_found_count \+ 1/u);
  assert.match(sql, /target_retry_count = 0/u);
  assert.match(sql, /target_last_error is null/u);
  assert.match(
    sql,
    /tracker_state_superseded is false\s+and current_tracker_state_attested is true/u,
  );
  assert.match(sql, /first_terminal_materialization_integrity/u);
  assert.match(sql, /when current_control_healthy is not true then 'integrity_failure'/u);
  assert.doesNotMatch(sql, /(?:thumbnail|image_url|imageUrl|product_title|model|brand|category)/iu);
});

test("keeps plain partial windows as integrity failures, not accepted finite failures", () => {
  const sql = buildN30ParentCanaryReleaseAuditSql({ observedAt });
  assert.match(sql, /terminal_error_code ~ '\^provider_partial_window:/u);
  assert.match(sql, /plain_partial_failure/u);
  assert.match(sql, /terminal_error_code in \(\s*'provider_stable_finite_window_unproven',\s*'local_worker_finite_match_invalid'\s*\)/u);
  assert.match(sql, /when plain_partial_failure is true then 'integrity_failure'/u);
  assert.doesNotMatch(sql, /terminal_error_code in \([^)]+provider_partial_window/iu);
  assert.match(sql, /snapshot_through_terminal_count = 0/u);
  assert.match(sql, /target_retry_count is not distinct from pre_gate_retry_count \+ 1/u);
  assert.match(sql, /quarantine_at >= terminal_at/u);
  assert.match(sql, /event\.cycle_id is not distinct from terminal\.terminal_cycle_id/u);
  assert.match(sql, /event\.cycle_number is not distinct from terminal\.terminal_cycle_number/u);
  assert.match(sql, /event\.group_fingerprint is not distinct from terminal\.terminal_group_fingerprint/u);
  assert.match(sql, /event\.priority is not distinct from terminal\.terminal_priority/u);
});

test("attests the deployed exact-parent database guard without overstating artifacts", () => {
  const sql = buildN30ParentCanaryReleaseAuditSql({ observedAt });
  const migrationCapture = sql.indexOf("'n30.recovery_migration_count'");
  const guardCapture = sql.indexOf("'n30.exact_parent_guard'");
  const roleDrop = sql.indexOf("set local role service_role;");
  assert.ok(migrationCapture > 0 && migrationCapture < roleDrop);
  assert.ok(guardCapture > migrationCapture && guardCapture < roleDrop);
  assert.match(sql, /supabase_migrations\.schema_migrations/u);
  assert.match(sql, /current_setting\('n30\.recovery_migration_count'/u);
  assert.match(sql, /current_setting\('n30\.exact_parent_guard'/u);
  assert.match(sql, /naver_shopping_exact_parent_relation_guard/u);
  assert.match(sql, /mi_guard_naver_shopping_exact_parent_snapshot/u);
  assert.match(sql, /procedure_row\.prosecdef = false/u);
  assert.match(sql, /search_path=/u);
  assert.match(sql, /has_function_privilege\('service_role', procedure_row\.oid, 'EXECUTE'\) = false/u);
  assert.match(sql, /pg_catalog\.nullif/u);
  assert.match(sql, /pg_catalog\.coalesce/u);
  assert.match(sql, /exact_parent_guard_integrity/u);
  assert.match(sql, /'recoveryMigrationCount', migration_count/u);
  assert.match(sql, /'guardFunctionCount', function_count/u);
  assert.match(sql, /'guardFunctionIntegrity', function_integrity/u);
  assert.match(sql, /'guardTriggerCount', trigger_count/u);
  assert.match(sql, /'releaseArtifactAttested', false/u);
  assert.match(sql, /'captureIndependenceAttested', false/u);
  assert.match(sql, /'rawDigestAttested', false/u);
  assert.match(sql, /coordination\.primary_seen_at > p\.observed_at - interval '3 minutes'/u);
  assert.doesNotMatch(sql, /coordination\.primary_seen_at between/u);
});

test("keeps every final PostgreSQL jsonb_build_object within the 100 argument limit", () => {
  const sql = buildN30ParentCanaryReleaseAuditSql({ observedAt });
  const output = sqlSlice(
    sql,
    "select (pg_catalog.jsonb_build_object(",
    ") as result\nfrom classified;",
  );
  const parts = output.split(")\n  || pg_catalog.jsonb_build_object(");
  assert.ok(parts.length >= 2);
  for (const part of parts) {
    const keyCount = (part.match(/^\s{2}'[^']+',/gmu) || []).length;
    assert.ok(keyCount > 0 && keyCount <= 50, `jsonb_build_object key count=${keyCount}`);
  }
});

test("prints only release-specific SQL and stays in the default suite", () => {
  const scriptUrl = new URL("./naver-shopping-parent-canary-release-audit.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(scriptUrl), observedAt], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${buildN30ParentCanaryReleaseAuditSql({ observedAt })}\n`);
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.test, /scripts\/naver-shopping-parent-canary-release-audit\.test\.mjs/u);
});
