import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  N30_CANDIDATE_CADENCE_MINUTES,
  N30_BASELINE_CADENCE_MINUTES,
  N30_TARGET_RUNTIME_FINGERPRINT,
  N30_TARGET_RUNTIME_VERSION,
  N30_TARGET_WORKER_ID,
  buildN30CadenceTransitionSql,
} from "./naver-shopping-cadence-transition-sql.mjs";

function setterCallCount(sql) {
  return sql.match(/public\.mi_set_naver_shopping_worker_cadence\s*\(/giu)?.length || 0;
}

function assertCommonTransactionContract(sql, mode) {
  const expectedMinutes = mode === "candidate"
    ? N30_CANDIDATE_CADENCE_MINUTES
    : N30_BASELINE_CADENCE_MINUTES;
  const startIndex = sql.indexOf("mi.n30_transition_started_at");
  const lockIndex = sql.search(/for\s+update/iu);
  const setterIndex = sql.indexOf(`mi_set_naver_shopping_worker_cadence('${mode}')`);
  const rawIndex = sql.indexOf("mi.n30_transition_raw");
  const observedIndex = sql.indexOf("mi.n30_transition_observed_at");
  const finalIndex = sql.indexOf(`n30_${mode}${expectedMinutes}_transition_v1`);
  const commitIndex = sql.toLowerCase().lastIndexOf("commit;");

  assert.match(sql, /^begin;\n/iu);
  assert.match(sql, /set local transaction isolation level serializable;/iu);
  assert.match(sql, /set local lock_timeout = '5s';/iu);
  assert.match(sql, /set local statement_timeout = '30s';/iu);
  assert.ok(startIndex >= 0, "the transaction-local start timestamp must be captured");
  assert.ok(startIndex < lockIndex, "the start timestamp must be captured before waiting on the row lock");
  assert.ok(lockIndex < setterIndex, "the global coordination row must be locked before the setter call");
  assert.ok(setterIndex < rawIndex, "the exact setter response must be stored after the call");
  assert.ok(rawIndex < observedIndex, "the observation timestamp must be captured after the raw response");
  assert.ok(observedIndex < finalIndex, "the final evidence result must follow the transition");
  assert.ok(finalIndex < commitIndex, "the evidence result must be emitted before commit");
  assert.equal(setterCallCount(sql), 1, "the canonical setter must occur exactly once");
  assert.match(sql, /where lane_key = 'global'[\s\S]*for update/iu);
  assert.match(sql, /pg_catalog\.set_config\([^;]+,\s*true\)/iu);
  assert.match(sql, new RegExp(`'accepted', true[\\s\\S]*'activated', true[\\s\\S]*'mode', '${mode}'[\\s\\S]*'minutes', ${expectedMinutes}`, "iu"));
  assert.match(sql, /updated_at[\s\S]*(between|>=)[\s\S]*transaction_started_at/iu);
  assert.match(sql, /updated_at[\s\S]*(between|<=)[\s\S]*transaction_observed_at/iu);
  assert.match(sql, /processing_count\s*=\s*0/iu);
  assert.match(sql, /lease_worker_id is null/iu);
  assert.match(sql, /lease_token is null/iu);
  assert.match(sql, /lease_until is null/iu);
  assert.match(sql, /run_id is null/iu);
  assert.match(sql, /current_stage is null/iu);
  assert.match(sql, /current_page\s*=\s*0/iu);
  assert.match(sql, /current_job_kind is null/iu);
  assert.match(sql, /current_tracker_id is null/iu);
  assert.match(sql, /current_job_started_at is null/iu);
  assert.match(sql, /probe_tracker_id is null/iu);
  assert.match(sql, /probe_started_at is null/iu);
  assert.match(sql, /transitionAccepted/iu);
  assert.match(sql, /commit;\s*$/iu);
  assert.doesNotMatch(sql, /begin read only/iu);
  assert.doesNotMatch(sql, /\b(insert|delete|merge|truncate|alter|drop|create|grant|revoke)\b/iu);
  assert.doesNotMatch(sql.replaceAll(/for\s+update/giu, ""), /\bupdate\b/iu);
  assert.doesNotMatch(sql, /\b(explain|where\s+false|dry_run)\b/iu);
}

test("builds the one-shot candidate6 transaction with exact identity and full post-idle evidence", () => {
  const sql = buildN30CadenceTransitionSql({ mode: "candidate" });

  assertCommonTransactionContract(sql, "candidate");
  assert.equal(N30_CANDIDATE_CADENCE_MINUTES, 6);
  assert.match(sql, /cadence_mode\s*=\s*'baseline'[\s\S]*cadence_minutes\s*=\s*10/iu);
  assert.match(sql, /cadence_mode\s*=\s*'candidate'[\s\S]*cadence_minutes\s*=\s*6/iu);
  assert.match(sql, new RegExp(`primary_worker_id\\s*=\\s*'${N30_TARGET_WORKER_ID}'`, "iu"));
  assert.match(sql, new RegExp(`runtime_version\\s*=\\s*'${N30_TARGET_RUNTIME_VERSION.replaceAll(".", "\\.")}'`, "iu"));
  assert.match(sql, new RegExp(`runtime_fingerprint\\s*=\\s*'${N30_TARGET_RUNTIME_FINGERPRINT}'`, "iu"));
  assert.match(sql, /primary_seen_at\s*>\s*transaction_observed_at\s*-\s*interval '3 minutes'/iu);
  assert.match(sql, /stability_started_at\s*<=\s*transaction_observed_at\s*-\s*interval '24 hours'/iu);
  assert.match(sql, /success_streak\s*>=\s*6/iu);
  assert.match(sql, /last_success_at\s*>\s*transaction_observed_at\s*-\s*interval '15 minutes'/iu);
  assert.match(sql, /last_checked_count\s*=\s*300/iu);
  assert.match(sql, /last_source\s*=\s*'naver_shopping_results_collector'/iu);
  assert.match(sql, /circuit_state\s*=\s*'closed'/iu);
  assert.match(sql, /circuit_reason is null/iu);
  assert.match(sql, /cooldown_until is null/iu);
});

test("builds the one-shot baseline10 rollback from exact candidate6 without candidate-only eligibility gates", () => {
  const sql = buildN30CadenceTransitionSql({ mode: "baseline" });

  assertCommonTransactionContract(sql, "baseline");
  assert.equal(N30_BASELINE_CADENCE_MINUTES, 10);
  assert.match(sql, /cadence_mode\s*=\s*'candidate'[\s\S]*cadence_minutes\s*=\s*6/iu);
  assert.match(sql, /cadence_mode\s*=\s*'baseline'[\s\S]*cadence_minutes\s*=\s*10/iu);
  assert.doesNotMatch(sql, /stability_started_at\s*<=/iu);
  assert.doesNotMatch(sql, /success_streak\s*>=/iu);
  assert.doesNotMatch(sql, /last_success_at\s*>/iu);
});

test("rejects every mode except the two exact lowercase transition names", () => {
  for (const mode of [
    undefined,
    null,
    "",
    " candidate",
    "candidate ",
    "Candidate",
    "baseline;commit",
    "candidate');select pg_sleep(9);--",
    6,
    {},
  ]) {
    assert.throws(() => buildN30CadenceTransitionSql({ mode }), /mode must be exactly candidate or baseline/);
  }
});

test("is a pure synchronous generator included in the normal regression command", () => {
  const source = readFileSync(
    new URL("./naver-shopping-cadence-transition-sql.mjs", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const sql = buildN30CadenceTransitionSql({ mode: "candidate" });

  assert.equal(typeof sql, "string");
  assert.doesNotMatch(source, /@supabase|createClient|fetch\s*\(|node:child_process|\bexec\s*\(|\bspawn\s*\(|process\.env/iu);
  assert.match(packageJson.scripts.test, /naver-shopping-cadence-transition-sql\.test\.mjs/);
});
