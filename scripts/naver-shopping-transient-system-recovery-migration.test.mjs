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

const taxonomyHardeningPath = new URL(
  "../supabase/migrations/20260821180001_naver_shopping_error_taxonomy_hardening.sql",
  import.meta.url,
);
const taxonomyHardening = fs.existsSync(taxonomyHardeningPath)
  ? fs.readFileSync(taxonomyHardeningPath, "utf8")
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

function hardeningFunctionSql(name) {
  return taxonomyHardening.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  ))?.[0] || "";
}

test("typed transient taxonomy extends the exact bounded recovery allowlist twice", () => {
  assert.ok(taxonomyHardening.length > 0, "the hardening must be a new additive migration");
  const claimSql = hardeningFunctionSql("mi_claim_naver_shopping_worker_lane");
  assert.ok(claimSql.length > 0, "the additive migration must redefine the lane claim RPC");

  const exactAllowlist = /'native_host_response_timeout',\s*'provider_deadline_exceeded',\s*'native_host_input_closed',\s*'naver_page_timeout',\s*'naver_page_script_timeout',\s*'local_worker_commit_unavailable'/giu;
  assert.equal(
    [...claimSql.matchAll(exactAllowlist)].length,
    2,
    "the eligibility IF and guarded UPDATE must share one exact timeout allowlist",
  );
  assert.match(claimSql, /normalized_worker_role = 'primary'/iu);
  assert.match(claimSql, /current_row\.transient_system_probe_attempts < 2/iu);
  assert.match(claimSql, /circuit_opened_at <= v_now - interval '30 minutes'/iu);
  assert.match(
    claimSql,
    /transient_system_probe_attempts = least\(2, current_row\.transient_system_probe_attempts \+ 1\)/iu,
  );
  assert.doesNotMatch(claimSql, /naver_access_blocked|naver_http_403/iu);
});

test("access blocked and HTTP 403 stay in a 60-minute security block lane, never half-open", () => {
  const claimSql = hardeningFunctionSql("mi_claim_naver_shopping_worker_lane");
  const blockSql = hardeningFunctionSql("mi_block_naver_shopping_worker_lane");
  assert.ok(blockSql.length > 0, "the additive migration must redefine the block-lane RPC");
  assert.match(
    blockSql,
    /normalized_error in \(\s*'naver_captcha_detected',\s*'naver_auth_required',\s*'naver_verification_required',\s*'naver_access_blocked',\s*'naver_http_403'\s*\) then 3600/iu,
  );
  assert.match(
    blockSql,
    /circuit_state = case when current_row\.circuit_state = 'half_open' then 'open' else current_row\.circuit_state end/iu,
    "a normal closed circuit stays closed while an in-flight probe fails closed",
  );
  assert.match(blockSql, /cooldown_until = greatest\([\s\S]*v_now \+ make_interval\(secs => cooldown_seconds\)/iu);
  assert.doesNotMatch(claimSql, /naver_access_blocked|naver_http_403/iu);
  assert.doesNotMatch(blockSql, /auto_transient_system_probe|transient_system_probe_attempts/iu);
});

test("two repeated lookup failures release only the lane and preserve a closed zero-streak circuit", () => {
  const failureSql = hardeningFunctionSql("mi_record_naver_shopping_worker_failure");
  assert.ok(failureSql.length > 0, "the additive migration must redefine the failure RPC");
  assert.match(failureSql, /normalized_scope not in \('system', 'tracker', 'security', 'lookup'\)/iu);
  assert.match(failureSql, /normalized_scope = 'lookup' and p_tracker_id is not null/iu);
  assert.match(
    failureSql,
    /normalized_scope <> 'lookup' or circuit_state = 'closed'/iu,
    "lookup isolation may only release an ordinary closed-circuit lane",
  );

  const lookupSql = failureSql.match(
    /if normalized_scope = 'lookup' then[\s\S]*?\n  end if;/iu,
  )?.[0] || "";
  assert.ok(lookupSql.length > 0, "lookup needs an explicit isolated branch before system escalation");
  assert.match(lookupSql, /lease_worker_id = null/iu);
  assert.match(lookupSql, /lease_token = null/iu);
  assert.match(lookupSql, /lease_until = null/iu);
  assert.match(lookupSql, /run_id = null/iu);
  assert.match(lookupSql, /current_stage = null/iu);
  assert.match(lookupSql, /current_job_kind = null/iu);
  assert.match(lookupSql, /current_tracker_id = null/iu);
  assert.match(lookupSql, /cadence_mode = 'baseline'/iu);
  assert.match(lookupSql, /cadence_minutes = 10/iu);
  assert.match(lookupSql, /stability_started_at = null/iu);
  assert.match(lookupSql, /success_streak = 0/iu);
  assert.match(lookupSql, /'recorded', true/iu);
  assert.match(lookupSql, /'circuitState', current_row\.circuit_state/iu);
  assert.match(lookupSql, /'failureStreak', current_row\.failure_streak/iu);
  assert.match(lookupSql, /'laneReleased', true/iu);
  assert.match(lookupSql, /'quarantined', false/iu);
  assert.doesNotMatch(
    lookupSql,
    /(?:failure_signature|failure_streak|circuit_state|circuit_reason|circuit_opened_at|next_signature|next_streak|should_open)\s*=/iu,
    "repetition must not increment or rewrite the global circuit evidence",
  );
  assert.doesNotMatch(
    lookupSql,
    /(?:update public\.naver_rank_trackers|worker_quarantined_until|next_check_at|worker_last_cycle_id|scheduler_cycle_cursor_\w+)\s*=?/iu,
    "lookup isolation must not move durable order or quarantine a tracker",
  );
});

test("half-open release treats the new tracker-only failures as a recovered transport probe", () => {
  const releaseSql = hardeningFunctionSql("mi_release_naver_shopping_worker_lane");
  assert.ok(releaseSql.length > 0, "the additive hardening must redefine the release RPC");
  const recoveredAllowlist = /'local_worker_submit_body_too_large',\s*'local_worker_window_not_300',\s*'local_worker_match_result_incomplete',\s*'provider_duplicate_identity',\s*'provider_stable_window_unproven',\s*'provider_partial_window',\s*'provider_row_invalid',\s*'provider_row_title_missing',\s*'provider_row_identity_missing'/giu;
  assert.equal(
    [...releaseSql.matchAll(recoveredAllowlist)].length,
    2,
    "navigation and transient half-open paths must share one exact tracker-only allowlist",
  );
  assert.match(releaseSql, /when auto_navigation_recovered then 'closed'/iu);
  assert.match(releaseSql, /when transient_system_recovered then 'closed'/iu);
  assert.match(releaseSql, /when current_row\.circuit_state = 'half_open' then 'open'/iu);
});

test("taxonomy hardening preserves existing failure scopes and service-role-only RPC security", () => {
  const failureSql = hardeningFunctionSql("mi_record_naver_shopping_worker_failure");
  assert.match(failureSql, /if normalized_scope = 'tracker' then[\s\S]*update public\.naver_rank_trackers/iu);
  assert.match(failureSql, /provider_duplicate_identity[\s\S]*provider_stable_window_unproven[\s\S]*interval '30 minutes'/iu);
  assert.match(failureSql, /if normalized_scope = 'security' then[\s\S]*'laneReleased', false/iu);
  assert.match(failureSql, /next_signature :=[\s\S]*next_streak :=[\s\S]*should_open :=/iu);

  const functionNames = [...taxonomyHardening.matchAll(/create or replace function public\.(mi_[a-z0-9_]+)\(/giu)]
    .map((match) => match[1]);
  assert.deepEqual(functionNames, [
    "mi_claim_naver_shopping_worker_lane",
    "mi_block_naver_shopping_worker_lane",
    "mi_record_naver_shopping_worker_failure",
    "mi_release_naver_shopping_worker_lane",
  ]);
  assert.doesNotMatch(taxonomyHardening, /security definer/iu);
  for (const signature of [
    "mi_claim_naver_shopping_worker_lane\\(text, text, uuid, integer, integer\\)",
    "mi_block_naver_shopping_worker_lane\\(text, uuid, text\\)",
    "mi_record_naver_shopping_worker_failure\\(text, uuid, uuid, text, text, uuid\\)",
    "mi_release_naver_shopping_worker_lane\\(text, uuid\\)",
  ]) {
    assert.match(
      taxonomyHardening,
      new RegExp(`revoke all on function public\\.${signature}\\s+from public, anon, authenticated, service_role`, "iu"),
    );
    assert.match(
      taxonomyHardening,
      new RegExp(`grant execute on function public\\.${signature}\\s+to service_role`, "iu"),
    );
  }
  assert.equal([...taxonomyHardening.matchAll(/security invoker/giu)].length, 4);
  assert.equal([...taxonomyHardening.matchAll(/set search_path = ''/giu)].length, 4);
});

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
