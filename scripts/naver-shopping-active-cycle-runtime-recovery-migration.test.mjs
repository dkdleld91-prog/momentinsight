import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260831003000_naver_shopping_active_cycle_runtime_recovery.sql",
  import.meta.url,
), "utf8");

function functionBlock(name) {
  const start = migration.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = migration.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${name} must terminate`);
  return migration.slice(start, end + 4);
}

test("runtime recovery migration is transactional and has no top-level tracker repair", () => {
  assert.match(migration, /^begin;/iu);
  assert.match(migration, /commit;\s*$/iu);
  assert.match(migration, /set local lock_timeout = '5s'/iu);
  assert.match(migration, /lock table public\.naver_shopping_worker_coordination in access exclusive mode/iu);
  assert.match(migration, /runtime_version is distinct from '1\.1\.18'/iu);
  assert.match(migration, /processing_count <> 0/iu);
  assert.match(migration, /naver_shopping_active_cycle_runtime_recovery_requires_idle/iu);

  const withoutFunctions = migration
    .replace(functionBlock("mi_naver_shopping_cycle_runtime_recovery_eligible"), "")
    .replace(functionBlock("mi_claim_naver_shopping_cycle_keyword"), "");
  assert.doesNotMatch(withoutFunctions, /update\s+public\.naver_rank_trackers/iu);
  assert.doesNotMatch(withoutFunctions, /worker_(?:quarantined_until|last_cycle_id)\s*=/iu);
});

test("recovery is ledger-backed, old-runtime-only and closes after one current-runtime claim", () => {
  const helper = functionBlock("mi_naver_shopping_cycle_runtime_recovery_eligible");
  assert.match(helper, /candidate\.event_type in \(\s*'tracker_committed',\s*'finite_window_committed',\s*'job_failed'/iu);
  assert.match(helper, /terminal\.event_type = 'job_failed'/iu);
  assert.match(helper, /runtime_version is distinct from/iu);
  assert.match(helper, /runtime_fingerprint is distinct from/iu);
  assert.match(helper, /later_claim\.event_type = 'tracker_claimed'/iu);
  assert.doesNotMatch(helper, /run\.run_trigger = 'rank-catch-up'/iu);
  assert.match(helper, /later_claim\.event_id > terminal\.event_id/iu);
});

test("repair keeps cursor and quarantine semantics while ordinary fairness remains intact", () => {
  const claim = functionBlock("mi_claim_naver_shopping_cycle_keyword");
  assert.match(claim, /v_priority := 'repair'/iu);
  assert.match(claim, /worker_quarantined_until is null or tracker\.worker_quarantined_until <= v_now/iu);
  assert.match(claim, /p_probe_tracker_id is null and v_priority <> 'repair'/iu);
  assert.match(claim, /scheduler_cycle_cursor_sort_order = case when v_priority in \('normal', 'resume'\)/iu);
  assert.match(claim, /scheduler_cycle_resume_cursor = case when v_priority = 'new'/iu);
  assert.match(claim, /when v_priority = 'repair' then '오류 보완 후 1회 우선 재검증 중입니다.'/u);
  assert.doesNotMatch(claim, /worker_quarantined_until\s*=/iu);
});

test("a post-failure claim closes recovery before navigation provenance exists", () => {
  const helper = functionBlock("mi_naver_shopping_cycle_runtime_recovery_eligible");
  assert.match(helper, /select\s+event\.event_id,\s*event\.event_type/iu);
  assert.match(helper, /later_claim\.event_type = 'tracker_claimed'/iu);
  assert.match(helper, /later_claim\.event_id > terminal\.event_id/iu);
  assert.doesNotMatch(
    helper,
    /from public\.naver_shopping_scheduler_events as later_claim\s+(?:left\s+)?join/iu,
  );
});

test("new helper and canonical claim RPC remain service-role-only invoker functions", () => {
  for (const name of [
    "mi_naver_shopping_cycle_runtime_recovery_eligible",
    "mi_claim_naver_shopping_cycle_keyword",
  ]) {
    assert.match(functionBlock(name), /security invoker/iu);
    assert.match(functionBlock(name), /set search_path = ''/iu);
  }
  assert.match(
    migration,
    /revoke all on function public\.mi_naver_shopping_cycle_runtime_recovery_eligible\([\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute[\s\S]*?to service_role;/iu,
  );
  assert.match(
    migration,
    /revoke all on function public\.mi_claim_naver_shopping_cycle_keyword\([\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute[\s\S]*?to service_role;/iu,
  );
  assert.doesNotMatch(migration, /security definer/iu);
});
