import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migrationPath = new URL(
  "../supabase/migrations/20260821153000_naver_shopping_transient_system_half_open.sql",
  import.meta.url,
);
const migration = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, "utf8")
  : "";

const nativeInputRecoveryPath = new URL(
  "../supabase/migrations/20260821170000_naver_shopping_native_input_closed_half_open.sql",
  import.meta.url,
);
const nativeInputRecovery = fs.existsSync(nativeInputRecoveryPath)
  ? fs.readFileSync(nativeInputRecoveryPath, "utf8")
  : "";

function functionSql(name) {
  return migration.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

function recoveryFunctionSql(name) {
  return nativeInputRecovery.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

test("native input closure gets one exact additive bounded recovery contract", () => {
  assert.ok(nativeInputRecovery.length > 0, "the fix must be a new additive migration");
  const claimSql = recoveryFunctionSql("mi_claim_naver_shopping_worker_lane");
  assert.ok(claimSql.length > 0, "the additive migration must redefine only the lane claim RPC");

  const exactAllowlist = /'native_host_response_timeout',\s*'provider_deadline_exceeded',\s*'native_host_input_closed'/giu;
  assert.equal(
    [...claimSql.matchAll(exactAllowlist)].length,
    2,
    "both the eligibility IF and guarded UPDATE must use the same exact allowlist",
  );
  assert.match(claimSql, /normalized_worker_role = 'primary'/iu);
  assert.match(claimSql, /current_row\.transient_system_probe_attempts < 2/iu);
  assert.match(claimSql, /circuit_opened_at <= v_now - interval '30 minutes'/iu);
  assert.match(
    claimSql,
    /transient_system_probe_attempts = least\(2, current_row\.transient_system_probe_attempts \+ 1\)/iu,
  );
  for (const excluded of [
    "native_host_input_failed",
    "naver_http_418",
    "naver_http_429",
    "naver_captcha_detected",
    "naver_auth_required",
    "naver_verification_required",
    "naver_network_restricted",
    "local_worker_collection_failed",
    "provider_partial_window",
  ]) {
    assert.doesNotMatch(claimSql, new RegExp(excluded, "iu"));
  }

  assert.match(claimSql, /security invoker/iu);
  assert.match(claimSql, /set search_path = ''/iu);
  assert.match(
    nativeInputRecovery,
    /revoke all on function public\.mi_claim_naver_shopping_worker_lane\(text, text, uuid, integer, integer\)\s+from public, anon, authenticated, service_role/iu,
  );
  assert.match(
    nativeInputRecovery,
    /grant execute on function public\.mi_claim_naver_shopping_worker_lane\(text, text, uuid, integer, integer\)\s+to service_role/iu,
  );
  assert.doesNotMatch(nativeInputRecovery, /(?:alter table|create index|drop index|mi_release_naver_shopping_worker_lane|mi_record_naver_shopping_worker_success)/iu);
});

test("transient system recovery is primary-only, quiet and strictly bounded", () => {
  const claimSql = functionSql("mi_claim_naver_shopping_worker_lane");
  assert.match(migration, /add column if not exists transient_system_probe_attempts integer not null default 0/iu);
  assert.match(migration, /check \(transient_system_probe_attempts between 0 and 2\)/iu);
  assert.match(claimSql, /normalized_worker_role = 'primary'/iu);
  assert.match(
    claimSql,
    /transient_failure_code in \(\s*'native_host_response_timeout',\s*'provider_deadline_exceeded'\s*\)/iu,
  );
  assert.match(claimSql, /current_row\.transient_system_probe_attempts < 2/iu);
  assert.match(claimSql, /circuit_opened_at <= v_now - interval '30 minutes'/iu);
  assert.match(claimSql, /circuit_reason = 'auto_transient_system_probe'/iu);
  assert.match(
    claimSql,
    /transient_system_probe_attempts = least\(2, current_row\.transient_system_probe_attempts \+ 1\)/iu,
  );
  assert.match(
    claimSql,
    /current_row\.circuit_state = 'half_open'[\s\S]*current_row\.circuit_reason in \([\s\S]*'auto_navigation_probe'[\s\S]*'auto_transient_system_probe'[\s\S]*normalized_worker_role <> 'primary'[\s\S]*'reason', 'primary_required'/iu,
    "a pending automatic half-open may only be resumed by the primary worker",
  );
});

test("transient recovery excludes security, network, generic and integrity failures", () => {
  const claimSql = functionSql("mi_claim_naver_shopping_worker_lane");
  const eligibility = claimSql.match(
    /transient_failure_code :=[\s\S]*?if current_row\.circuit_state = 'open'[\s\S]*?returning \* into current_row;/iu,
  )?.[0] || "";
  assert.match(
    eligibility,
    /circuit_reason is not distinct from current_row\.failure_signature[\s\S]*circuit_reason in \('probe_incomplete', 'probe_interrupted'\)[\s\S]*failure_signature is null[\s\S]*transient_system_probe_attempts > 0/iu,
  );
  for (const excluded of [
    "naver_http_418",
    "naver_http_429",
    "naver_captcha_detected",
    "naver_auth_required",
    "naver_verification_required",
    "naver_network_restricted",
    "local_worker_collection_failed",
    "provider_partial_window",
    "provider_duplicate_identity",
    "local_worker_post_commit_control_failed",
  ]) {
    assert.doesNotMatch(eligibility, new RegExp(excluded, "iu"));
  }
});

test("transient half-open success still requires atomic 300 and resets the retry budget", () => {
  const successSql = functionSql("mi_record_naver_shopping_worker_success");
  assert.match(successSql, /p_checked_count is distinct from 300/iu);
  assert.match(successSql, /p_source[\s\S]*naver_shopping_results_collector/iu);
  assert.match(
    successSql,
    /circuit_reason is distinct from 'auto_navigation_probe'[\s\S]*circuit_reason is distinct from 'auto_transient_system_probe'/iu,
  );
  assert.match(successSql, /circuit_state = 'closed'/iu);
  assert.match(successSql, /transient_system_probe_attempts = 0/iu);
});

test("a typed tracker terminal proves the transient runtime path without moving order", () => {
  const releaseSql = functionSql("mi_release_naver_shopping_worker_lane");
  assert.match(releaseSql, /transient_system_recovered := current_row\.circuit_state = 'half_open'/iu);
  assert.match(releaseSql, /current_row\.circuit_reason = 'auto_transient_system_probe'/iu);
  assert.match(releaseSql, /current_row\.current_stage = 'failed'/iu);
  assert.match(releaseSql, /provider_partial_window/iu);
  assert.match(releaseSql, /provider_duplicate_identity/iu);
  assert.match(releaseSql, /when transient_system_recovered then 'closed'/iu);
  assert.match(releaseSql, /transient_system_probe_attempts = case[\s\S]*when transient_system_recovered then 0/iu);
  assert.doesNotMatch(
    `${functionSql("mi_claim_naver_shopping_worker_lane")}\n${releaseSql}`,
    /(?:next_check_at|worker_quarantined_until|scheduler_cycle_cursor_\w+|worker_last_cycle_id)\s*=/iu,
  );
});

test("a remote poll with no wake preserves the pending half-open without spending another probe", () => {
  const releaseSql = functionSql("mi_release_naver_shopping_worker_lane");
  assert.match(
    migration,
    /create index if not exists idx_naver_shopping_scheduler_events_tracker_claim_run\s*on public\.naver_shopping_scheduler_events\(run_id, lease_started_at\)\s*where event_type = 'tracker_claimed'\s*and run_id is not null/iu,
    "the 90-day claim ledger lookup must use a matching partial index",
  );
  assert.match(
    releaseSql,
    /auto_recovery_no_work := current_row\.circuit_state = 'half_open'[\s\S]*current_row\.current_stage = 'claiming'[\s\S]*current_row\.current_job_kind is null[\s\S]*current_row\.current_tracker_id is null/iu,
  );
  assert.match(releaseSql, /when auto_recovery_no_work then 'half_open'/iu);
  assert.match(releaseSql, /when auto_recovery_no_work then current_row\.circuit_reason/iu);
  assert.match(
    releaseSql,
    /transient_system_probe_attempts = case[\s\S]*when auto_recovery_no_work then current_row\.transient_system_probe_attempts/iu,
  );
  assert.match(
    releaseSql,
    /probe_started_at = case[\s\S]*when auto_recovery_no_work then null/iu,
  );
  assert.match(
    releaseSql,
    /auto_recovery_no_work :=[\s\S]*current_row\.run_id is not null[\s\S]*current_row\.probe_started_at is not null[\s\S]*not exists \(\s*select 1\s*from public\.naver_shopping_scheduler_events as event\s*where event\.event_type = 'tracker_claimed'\s*and event\.run_id = current_row\.run_id\s*and event\.lease_started_at >= current_row\.probe_started_at\s*\)/iu,
    "a committed tracker claim in the same probe run must reopen as probe_incomplete instead of being mistaken for no work",
  );
  assert.match(
    releaseSql,
    /circuit_state = case\s*when auto_recovery_no_work then 'half_open'[\s\S]*when current_row\.circuit_state = 'half_open' then 'open'/iu,
  );
  assert.match(
    releaseSql,
    /circuit_reason = case\s*when auto_recovery_no_work then current_row\.circuit_reason[\s\S]*when current_row\.circuit_state = 'half_open' then 'probe_incomplete'/iu,
  );
});

test("coordination RLS and changed RPCs remain service-role only", () => {
  assert.match(migration, /alter table public\.naver_shopping_worker_coordination enable row level security/iu);
  assert.match(migration, /alter table public\.naver_shopping_worker_coordination force row level security/iu);
  assert.match(
    migration,
    /revoke all on table public\.naver_shopping_worker_coordination\s+from public, anon, authenticated, service_role/iu,
  );
  assert.match(
    migration,
    /grant select, insert, update on table public\.naver_shopping_worker_coordination\s+to service_role/iu,
  );
  for (const signature of [
    "mi_claim_naver_shopping_worker_lane\\(text, text, uuid, integer, integer\\)",
    "mi_record_naver_shopping_worker_success\\(text, uuid, uuid, uuid, text, integer, integer, integer, text\\)",
    "mi_release_naver_shopping_worker_lane\\(text, uuid\\)",
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${signature}\\s+from public, anon, authenticated, service_role`, "iu"),
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${signature}\\s+to service_role`, "iu"),
    );
  }
  assert.match(migration, /security invoker/iu);
  assert.doesNotMatch(migration, /security definer/iu);
});
