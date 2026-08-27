import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  N30_PARENT_CANARY,
  N30_PARENT_CANARY_RUNTIME_FINGERPRINT,
  N30_PARENT_CANARY_RUNTIME_VERSION,
  N30_PARENT_CANARY_WORKER_ID,
  buildN30ParentCanaryFiniteGateAuditSql,
} from "./naver-shopping-parent-canary-finite-gate-audit.mjs";

const observedAt = "2026-08-27T08:00:00.000000Z";

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

test("pins the exact parent canary identity and runtime contract", () => {
  assert.deepEqual(N30_PARENT_CANARY, {
    trackerId: "c0ccded2-9bf7-488e-af8d-00898c0a1ff8",
    normalizedKeyword: "아이쉘차량용거치대",
    sellerProductId: "13327339525",
    parentCatalogId: "59776958987",
    proofVersion: "stable-finite-window-v1",
    gateAt: "2026-08-27T07:33:51.715190Z",
    scheduledAnchorAt: "2026-08-26T14:04:05.740730Z",
    preGateControlStabilityStartedAt: "2026-08-26T13:59:49.161334Z",
    preGateLastGood: {
      currentRank: null,
      lastCheckedAt: null,
      checkCount: 0,
      foundCount: 0,
      retryCount: 10,
    },
  });
  assert.equal(N30_PARENT_CANARY_WORKER_ID, "windows-desktop-primary");
  assert.equal(N30_PARENT_CANARY_RUNTIME_VERSION, "1.1.16");
  assert.equal(
    N30_PARENT_CANARY_RUNTIME_FINGERPRINT,
    "570ffc52d411f2ae34e247b77d7fb645d36f4478b624ed56926a6ccc00b6159f",
  );
});

test("requires a fixed valid UTC observation timestamp", () => {
  assert.throws(
    () => buildN30ParentCanaryFiniteGateAuditSql(),
    /observedAt must be an ISO-8601 UTC timestamp/u,
  );
  assert.throws(
    () => buildN30ParentCanaryFiniteGateAuditSql({ observedAt: "2026-08-27 08:00:00" }),
    /observedAt must be an ISO-8601 UTC timestamp/u,
  );

  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });
  assert.match(sql, /'2026-08-27T08:00:00\.000000Z'::timestamptz as observed_at/u);
  assert.doesNotMatch(sql, /statement_timestamp|clock_timestamp|now\s*\(/iu);
});

test("builds one reproducible read-only transaction with no state mutation", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });

  assert.match(sql, /^begin transaction isolation level repeatable read read only;/iu);
  assert.match(sql, /set local role service_role;/iu);
  assert.match(sql, /commit;\s*$/iu);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|merge|alter|drop|truncate|create|call|grant|revoke)\b/iu);
  assert.doesNotMatch(sql, /\bfor\s+update\b/iu);
  assert.doesNotMatch(sql, /mi_set_naver_shopping_worker_cadence/iu);
});

test("selects the immutable first post-gate claim before validating its identity", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });
  const firstClaim = cteBody(sql, "first_claim", "claim_context");

  assert.match(firstClaim, /event\.event_type = 'tracker_claimed'/u);
  assert.match(firstClaim, /event\.tracker_id = p\.tracker_id/u);
  assert.match(firstClaim, /event\.occurred_at >= p\.gate_at/u);
  assert.match(firstClaim, /event\.occurred_at <= p\.observed_at/u);
  assert.match(firstClaim, /order by event\.event_id/u);
  assert.match(firstClaim, /limit 1/u);
  assert.doesNotMatch(firstClaim, /worker_id|run_trigger|runtime_version|runtime_fingerprint|cycle_number\s*=/u);

  assert.match(sql, /run_trigger is not distinct from 'rank-catch-up'/u);
  assert.match(sql, /run_worker_id is not distinct from worker_id/u);
  assert.match(sql, /run_runtime_version is not distinct from runtime_version/u);
  assert.match(sql, /run_runtime_fingerprint is not distinct from runtime_fingerprint/u);
  assert.match(sql, /group_at <= claim_at/u);
  assert.match(sql, /claim_at <= run_started_at/u);
  assert.match(sql, /run_started_at <= terminal_at/u);
  assert.doesNotMatch(sql, /interval '5 seconds'/u);
});

test("derives cycle identity from the first claim and rejects roster or same-cycle duplicates", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });

  assert.match(sql, /event\.event_type = 'cycle_rostered'/u);
  assert.match(sql, /event\.cycle_id is not distinct from terminal\.claim_cycle_id/u);
  assert.match(sql, /event\.cycle_number is not distinct from terminal\.claim_cycle_number/u);
  assert.match(sql, /event\.tracker_id = terminal\.tracker_id/u);
  assert.match(sql, /event\.group_fingerprint is not distinct from terminal\.claim_group_fingerprint/u);
  assert.match(sql, /roster_count = 1/u);
  assert.match(sql, /same_cycle_group_count = 1/u);
  assert.match(sql, /same_cycle_tracker_claim_count = 1/u);
  assert.match(sql, /claim_id_tracker_claim_count = 1/u);
  assert.match(sql, /claim_id_distinct_tracker_count = 1/u);
  assert.match(sql, /claim_id_distinct_run_count = 1/u);
  assert.doesNotMatch(sql, /cycle_number\s*=\s*43/u);
});

test("selects the first terminal across all terminal types before classifying it", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });
  const firstTerminal = cteBody(sql, "first_terminal", "terminal_context");

  assert.match(
    firstTerminal,
    /event\.event_type in \('tracker_committed', 'finite_window_committed', 'job_failed'\)/u,
  );
  assert.match(firstTerminal, /event\.claim_id = claim\.claim_id/u);
  assert.doesNotMatch(firstTerminal, /event\.run_id\s*=/u);
  assert.doesNotMatch(firstTerminal, /event\.tracker_id\s*=/u);
  assert.match(firstTerminal, /order by event\.event_id/u);
  assert.match(firstTerminal, /limit 1/u);
  assert.doesNotMatch(firstTerminal, /error_code\s+in|checked_count\s+between|worker_id\s*=/u);

  assert.match(sql, /terminal_count = 1/u);
  assert.match(sql, /terminal_event_id > claim_event_id/u);
  assert.match(sql, /terminal_run_id is not distinct from run_id/u);
  assert.match(sql, /terminal_tracker_id is not distinct from tracker_id/u);

  const terminalCounts = sqlSlice(
    sql,
    "select\n      count(*)::integer as terminal_count,",
    ") terminal_counts on true",
  );
  assert.match(terminalCounts, /event\.claim_id = terminal\.claim_id/u);
  assert.doesNotMatch(terminalCounts, /event\.run_id\s*=/u);
  assert.doesNotMatch(terminalCounts, /event\.tracker_id\s*=/u);
});

test("validates the full group, claim, and terminal lease tuple", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });

  assert.match(sql, /claim_lease_started_at is not null/u);
  assert.match(sql, /claim_lease_until is not null/u);
  assert.match(sql, /group_lease_started_at is not null/u);
  assert.match(sql, /group_lease_until is not null/u);
  assert.match(sql, /group_lease_started_at is not distinct from claim_lease_started_at/u);
  assert.match(sql, /group_lease_until is not distinct from claim_lease_until/u);
  assert.match(sql, /claim_lease_started_at <= group_at/u);
  assert.match(sql, /claim_at < claim_lease_until/u);
  assert.match(sql, /terminal_lease_started_at is not null/u);
  assert.match(sql, /terminal_lease_until is not null/u);
  assert.match(sql, /terminal_lease_started_at is not distinct from claim_lease_started_at/u);
  assert.match(sql, /terminal_lease_until is not distinct from claim_lease_until/u);
  assert.match(sql, /terminal_at < terminal_lease_until/u);
});

test("accepts only an exact finite parent snapshot as success", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });

  assert.match(sql, /terminal_type = 'finite_window_committed'/u);
  assert.match(sql, /terminal_checked_count between 1 and 299/u);
  assert.match(
    sql,
    /terminal_details ->> 'source'\s+is not distinct from 'naver_shopping_results_collector'/u,
  );
  assert.match(sql, /finiteWindowProofVersion/u);
  assert.match(sql, /sourceExhausted/u);
  assert.match(sql, /marketTotal/u);
  assert.match(sql, /relationBasis/u);
  assert.match(sql, /catalog_seller_product_id/u);
  assert.match(sql, /atomicSuccessEligible/u);
  assert.match(sql, /snapshot\.checked_at = terminal\.terminal_at/u);
  assert.match(sql, /snapshot\.collection_id = terminal\.terminal_collection_id/u);
  assert.match(sql, /snapshot\.checked_count = terminal\.terminal_checked_count/u);
  assert.match(sql, /snapshot\.source = 'naver_shopping_results_collector'/u);
  assert.match(sql, /snapshot\.matched = true/u);
  assert.match(sql, /snapshot\.rank between 1 and snapshot\.checked_count/u);
  assert.match(sql, /snapshot\.total = snapshot\.checked_count/u);
  assert.match(sql, /trackingRankSource/u);
  assert.match(sql, /related_catalog/u);
  assert.match(sql, /relatedCatalogRelationBasis/u);
  assert.match(sql, /relatedCatalogProductId/u);
  assert.match(sql, /catalogSellerProductIds/u);
  assert.match(sql, /snapshot\.item -> 'adExcluded' = 'true'::jsonb/u);
  assert.match(sql, /snapshot\.item -> 'isOrganic' = 'true'::jsonb/u);
  assert.match(sql, /snapshot\.item -> 'isAd' = 'false'::jsonb/u);
  assert.match(sql, /top_item -> 'isOrganic' is distinct from 'true'::jsonb/u);
  assert.match(sql, /top_item -> 'isAd' is distinct from 'false'::jsonb/u);
  assert.match(sql, /snapshot_before_gate_count = 0/u);
  assert.match(sql, /snapshot_through_terminal_count = 1/u);
  assert.match(sql, /valid_finite_snapshot_count = 1/u);
  assert.match(sql, /tracker_commit_count = 0/u);
  assert.match(sql, /job_failure_count = 0/u);
  assert.match(sql, /claim_quarantine_count = 0/u);

  assert.doesNotMatch(sql, /(?:title|thumbnail|image_url|imageUrl)/iu);
  assert.doesNotMatch(sql, /sourceLabel[^,\n]*is not distinct from/iu);

  const snapshots = sqlSlice(
    sql,
    "count(*) filter (\n        where snapshot.checked_at < terminal.gate_at",
    ") snapshots on true",
  );
  assert.match(snapshots, /snapshot\.checked_at <= terminal\.terminal_at/u);
  assert.doesNotMatch(snapshots, /snapshot\.checked_at >= terminal\.claim_at/u);
  assert.match(
    snapshots,
    /jsonb_array_elements_text\(\s*case\s+when pg_catalog\.jsonb_typeof\([\s\S]*?snapshot\.item -> 'catalogSellerProductIds'[\s\S]*?\) = 'array'/u,
  );
  assert.match(
    snapshots,
    /jsonb_array_elements\(\s*case\s+when pg_catalog\.jsonb_typeof\(snapshot\.top_items\) = 'array'/u,
  );
});

test("accepts only the two exact finite failures from immutable first-terminal evidence", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });

  assert.match(
    sql,
    /terminal_error_code in \(\s*'provider_stable_finite_window_unproven',\s*'local_worker_finite_match_invalid'\s*\)/u,
  );
  assert.match(sql, /snapshot_through_terminal_count = 0/u);
  assert.match(sql, /finite_commit_count = 0/u);
  assert.match(sql, /tracker_commit_count = 0/u);
  assert.match(sql, /matching_quarantine_count = 1/u);
  assert.match(sql, /quarantine_event_id > terminal_event_id/u);
  assert.match(sql, /quarantine_until >= terminal_at \+ interval '30 minutes'/u);
  assert.match(sql, /quarantine_until <= quarantine_at \+ interval '30 minutes 1 second'/u);
  assert.match(
    sql,
    /terminal_details -> 'retryCount'\s+is not distinct from pg_catalog\.to_jsonb\(pre_gate_retry_count \+ 1\)/u,
  );

  const quarantine = sqlSlice(
    sql,
    "count(*)::integer as claim_quarantine_count,",
    ") quarantine on true",
  );
  assert.doesNotMatch(quarantine, /lease_started_at/u);
  assert.match(quarantine, /event\.claim_id = terminal\.claim_id/u);
  assert.match(quarantine, /event\.run_id = terminal\.run_id/u);
  assert.match(quarantine, /event\.tracker_id = terminal\.tracker_id/u);
  assert.match(
    quarantine,
    /event\.details -> 'previousUntil'\s+is not distinct from pg_catalog\.to_jsonb\(terminal\.gate_at\)/u,
  );

  assert.match(sql, /target_current_rank is not distinct from pre_gate_current_rank/u);
  assert.match(sql, /target_last_checked_at is not distinct from pre_gate_last_checked_at/u);
  assert.match(sql, /target_check_count is not distinct from pre_gate_check_count/u);
  assert.match(sql, /target_found_count is not distinct from pre_gate_found_count/u);
  assert.match(sql, /target_retry_count is not distinct from pre_gate_retry_count \+ 1/u);
  assert.match(sql, /target_last_error is not distinct from terminal_error_code/u);
  assert.match(sql, /target_quarantined_until is not distinct from quarantine_until/u);
});

test("attests current tracker state when unsuperseded and preserves delayed first-terminal audit", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });

  assert.match(sql, /subsequent_terminal_count/u);
  assert.match(sql, /event\.event_id > terminal\.terminal_event_id/u);
  assert.match(sql, /event\.tracker_id = terminal\.tracker_id/u);
  assert.match(sql, /event\.event_type in \('tracker_committed', 'finite_window_committed', 'job_failed'\)/u);
  assert.match(sql, /target_current_rank is not distinct from terminal_snapshot_rank/u);
  assert.match(sql, /target_last_checked_at is not distinct from terminal_at/u);
  assert.match(sql, /target_check_count is not distinct from pre_gate_check_count \+ 1/u);
  assert.match(sql, /target_found_count is not distinct from pre_gate_found_count \+ 1/u);
  assert.match(sql, /target_retry_count = 0/u);
  assert.match(sql, /target_last_error is null/u);
  assert.match(sql, /target_quarantined_until is not distinct from gate_at/u);
  assert.match(sql, /current_tracker_state_attested/u);
  assert.match(sql, /tracker_state_superseded/u);
  assert.match(sql, /first_terminal_materialization_integrity/u);
  assert.match(sql, /subsequent_terminal_count > 0/u);
  assert.match(sql, /first_terminal_materialization_integrity is not true/u);
  assert.match(sql, /'currentTrackerStateAttested', current_tracker_state_attested/u);
  assert.match(sql, /'trackerStateSuperseded', tracker_state_superseded/u);
});

test("fails closed on SQL NULL invariants and never overstates unproved evidence", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });

  assert.match(
    sql,
    /group_details -> 'memberCount' is not distinct from pg_catalog\.to_jsonb\(1\)/u,
  );
  for (const invariant of [
    "control_integrity",
    "claim_integrity",
    "terminal_integrity",
    "finite_success_integrity",
    "typed_failure_integrity",
    "full_idle",
  ]) {
    assert.match(sql, new RegExp(`${invariant} is not true`, "u"));
  }
  assert.match(
    sql,
    /'runtimeEnforcedFiniteProof',\s*finite_state = 'success' and finite_success_integrity is true/u,
  );
  assert.match(
    sql,
    /'relationshipProven',\s*finite_state = 'success' and finite_success_integrity is true/u,
  );
  assert.match(sql, /'cadenceNeutralAttested', false/u);
  assert.match(
    sql,
    /'cadenceContractConsistent',[\s\S]*finite_state in \('success', 'typed_failure'\)[\s\S]*control_integrity is true/u,
  );
  assert.doesNotMatch(sql, /'cadenceNeutral',\s*control_integrity/u);
});

test("reports finite states and evidence limits without claiming unavailable raw proof", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });

  for (const state of [
    "gate_not_reached",
    "awaiting_first_claim",
    "awaiting_terminal",
    "awaiting_post_idle",
    "success",
    "typed_failure",
    "integrity_failure",
  ]) {
    assert.match(sql, new RegExp(`'${state}'`, "u"));
  }
  assert.match(sql, /n30_parent_canary_finite_gate_audit_v1/u);
  assert.match(sql, /'rawDigestAttested', false/u);
  assert.match(sql, /'sourceLabelAuthoritative', false/u);
  assert.match(sql, /'relationshipAuthority', 'exact_catalog_seller_product_id'/u);
  assert.match(sql, /'normalizedKeyword', normalized_keyword/u);
  assert.match(sql, /'workerId', worker_id/u);
  assert.match(sql, /'runtimeVersion', runtime_version/u);
  assert.match(sql, /'runtimeFingerprint', runtime_fingerprint/u);
  assert.match(sql, /'proofVersion', proof_version/u);
  assert.match(sql, /processing_count = 0/u);
  assert.match(sql, /coordination_lane_idle/u);
  assert.match(sql, /control_integrity/u);
  assert.match(
    sql,
    /coordination\.stability_started_at\s+is not distinct from p\.pre_gate_stability_started_at/u,
  );
  assert.match(sql, /coordination\.primary_seen_at > p\.observed_at - interval '3 minutes'/u);
  assert.doesNotMatch(sql, /coordination\.primary_seen_at between/u);
});

test("keeps every PostgreSQL jsonb_build_object call within the 100 argument limit", () => {
  const sql = buildN30ParentCanaryFiniteGateAuditSql({ observedAt });
  const output = sqlSlice(
    sql,
    "select (pg_catalog.jsonb_build_object(",
    ") as result\nfrom classified;",
  );
  const parts = output.split(")\n  || pg_catalog.jsonb_build_object(");

  assert.equal(parts.length, 2);
  for (const part of parts) {
    const keyCount = (part.match(/^\s{2}'[^']+',/gmu) || []).length;
    assert.ok(keyCount > 0 && keyCount <= 50, `jsonb_build_object key count=${keyCount}`);
  }
});

test("prints only the generated SQL and stays in the default regression suite", () => {
  const scriptUrl = new URL("./naver-shopping-parent-canary-finite-gate-audit.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(scriptUrl), observedAt], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `${buildN30ParentCanaryFiniteGateAuditSql({ observedAt })}\n`,
  );

  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    packageJson.scripts.test,
    /scripts\/naver-shopping-parent-canary-finite-gate-audit\.test\.mjs/u,
  );

  const invalid = spawnSync(process.execPath, [fileURLToPath(scriptUrl)], {
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /observedAt must be an ISO-8601 UTC timestamp/u);
});
