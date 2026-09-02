import assert from "node:assert/strict";
import test from "node:test";

import {
  N30_RESIDUAL_GATE_TARGETS,
  buildN30ResidualFiniteGateAuditSql,
} from "./naver-shopping-residual-finite-gate-audit.mjs";

test("residual audit pins both exact target identities and pre-gate last-good values", () => {
  assert.equal(N30_RESIDUAL_GATE_TARGETS.length, 2);
  assert.deepEqual(
    N30_RESIDUAL_GATE_TARGETS.map((target) => target.trackerId),
    [
      "1114f3af-c30c-4975-9b79-ecec9cfbf031",
      "12f5330a-e8ac-4d82-9317-5d092f5142d8",
    ],
  );

  const sql = buildN30ResidualFiniteGateAuditSql();
  for (const target of N30_RESIDUAL_GATE_TARGETS) {
    assert.match(sql, new RegExp(target.trackerId));
    assert.match(sql, new RegExp(target.gateAt.replaceAll(".", "\\.")));
    assert.match(sql, new RegExp(`${target.snapshotCount}::int`));
  }
});

test("residual audit is a single read-only transaction with no state mutation", () => {
  const sql = buildN30ResidualFiniteGateAuditSql();

  assert.match(sql, /^begin transaction isolation level repeatable read read only;/);
  assert.match(sql, /set local role service_role;/);
  assert.match(sql, /statement_timestamp\(\)/);
  assert.match(sql, /commit;$/);
  assert.doesNotMatch(
    sql,
    /\b(?:insert|update|delete|merge|alter|drop|truncate|create|call)\b/i,
  );
});

test("residual audit makes every finite classification fail closed", () => {
  const sql = buildN30ResidualFiniteGateAuditSql();

  for (const state of [
    "gate_not_reached",
    "awaiting_first_claim",
    "awaiting_terminal",
    "awaiting_post_idle",
    "success",
    "typed_failure",
    "integrity_failure",
  ]) {
    assert.match(sql, new RegExp(`'${state}'`));
  }

  assert.match(sql, /worker_id is distinct from 'windows-desktop-primary'/);
  assert.match(sql, /left join public\.naver_shopping_worker_runs as exact_run/);
  assert.match(sql, /group_count <> 1/);
  assert.match(sql, /run_trigger is distinct from 'rank-catch-up'/);
  assert.match(sql, /runtime_version is distinct from '1\.1\.13'/);
  assert.match(
    sql,
    /runtime_fingerprint is distinct from 'cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6'/,
  );
  assert.match(sql, /all_terminal_count <> 1 or exact_terminal_count <> 1/);
  assert.match(sql, /terminal_worker_id is distinct from worker_id/);
  assert.match(sql, /terminal_group_fingerprint is distinct from group_fingerprint/);
  assert.match(sql, /terminal_priority is distinct from priority/);
  assert.match(sql, /terminal_collection_id ~ '\^pw-chrome-'/);
  assert.match(sql, /claim_window_snapshot_count = 1/);
  assert.match(sql, /valid_success_snapshot_count = 1/);
  assert.match(sql, /claim_window_snapshot_count = 0/);
  assert.match(sql, /all_quarantine_count = 1/);
  assert.match(sql, /matching_quarantine_count = 1/);
  assert.match(sql, /worker_quarantined_until is not distinct from terminal_quarantine_until/);
  assert.match(sql, /total_snapshot_count = baseline_snapshot_count/);
  assert.match(sql, /when not control_integrity then 'integrity_failure'/);
  assert.match(sql, /tracker_status is distinct from 'active'/);
  assert.match(sql, /processing_until is not null/);
  assert.match(sql, /worker_quarantined_until > observed_at/);
  assert.match(sql, /all_terminal_count,0\) = 0 and claim_inflight/);
  assert.match(sql, /all_terminal_count,0\) = 0 then 'integrity_failure'/);
  assert.match(sql, /and lane_idle/);
  assert.match(sql, /coordination\.lease_token is null/);
  assert.match(sql, /coordination\.current_page = 0/);
  assert.match(sql, /coordination\.current_job_started_at is null/);
  assert.match(sql, /coordination\.circuit_state = 'closed'/);
  assert.match(sql, /coordination\.cooldown_until is null/);
  assert.match(sql, /worker_quarantined_until is null/);
  assert.match(sql, /and all_quarantine_count = 0/);
});

test("success quality contract remains atomic300 official organic and ad-excluded", () => {
  const sql = buildN30ResidualFiniteGateAuditSql();

  assert.match(sql, /snapshot\.checked_count = 300/);
  assert.match(sql, /snapshot\.source = 'naver_shopping_results_collector'/);
  assert.match(sql, /snapshot\.item -> 'adExcluded' = 'true'::jsonb/);
  assert.match(sql, /snapshot\.item ->> 'rankPolicy' = 'organic_only'/);
  assert.match(sql, /snapshot\.item ->> 'rankEvidence' = 'naver_shopping_organic_list'/);
  assert.match(sql, /top_item -> 'isOrganic' is distinct from 'true'::jsonb/);
  assert.match(sql, /top_item -> 'isAd' is distinct from 'false'::jsonb/);
});

test("finite terminal proof requires active tracker and strict ledger order", () => {
  const sql = buildN30ResidualFiniteGateAuditSql();

  assert.match(sql, /group_event_id >= claim_event_id/);
  assert.match(sql, /terminal_event_id <= claim_event_id/);
  assert.match(sql, /quarantine_event_id > terminal_event_id/);
  assert.match(sql, /terminal_quarantine_until > terminal_at/);
  assert.match(
    sql,
    /terminal_type = 'tracker_committed'[\s\S]*?tracker_status = 'active'[\s\S]*?then 'success'/,
  );
  assert.match(
    sql,
    /terminal_type = 'job_failed'[\s\S]*?tracker_status = 'active'[\s\S]*?then 'typed_failure'/,
  );
});
