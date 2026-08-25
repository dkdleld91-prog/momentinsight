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

const CANDIDATE_AUDIT = Object.freeze({
  expectedRunId: "11111111-1111-4111-8111-111111111111",
  expectedCollectionId: "pw-chrome-1787636918978-a047ffb226e8c42f5dd6",
  expectedLastSuccessAt: "2026-08-25T05:48:39.679133Z",
});

function buildCandidateSql() {
  return buildN30CadenceTransitionSql({ mode: "candidate", ...CANDIDATE_AUDIT });
}

function sliceContract(sql, start, end) {
  const startIndex = sql.indexOf(start);
  const endIndex = sql.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing contract start: ${start}`);
  assert.ok(endIndex > startIndex, `missing contract end: ${end}`);
  return sql.slice(startIndex, endIndex);
}

function assertFullIdleContract(sql) {
  assert.match(sql, /processing_count\s*=\s*0/iu);
  for (const field of [
    "lease_worker_id",
    "lease_token",
    "lease_until",
    "run_id",
    "current_stage",
    "current_job_kind",
    "current_tracker_id",
    "current_job_started_at",
    "probe_tracker_id",
    "probe_started_at",
  ]) {
    assert.match(sql, new RegExp(`${field} is null`, "iu"));
  }
  assert.match(sql, /current_page\s*=\s*0/iu);
}

function assertCommonTransactionContract(sql, mode) {
  const expectedMinutes = mode === "candidate"
    ? N30_CANDIDATE_CADENCE_MINUTES
    : N30_BASELINE_CADENCE_MINUTES;
  const startIndex = sql.indexOf("mi.n30_transition_started_at");
  const roleIndex = sql.search(/set local role service_role;/iu);
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
  assert.match(sql, /cross-execution exactly-once requires attempted=true to be persisted before dispatch; never retry any outcome/iu);
  assert.ok(roleIndex >= 0, "the transaction must assume the only role allowed to call the setter");
  assert.ok(roleIndex < startIndex, "the local service role must be set before any evidence or row access");
  assert.doesNotMatch(sql, /set\s+(?:local\s+)?role\s+(?:anon|authenticated|public)\b/iu);
  assert.ok(startIndex >= 0, "the transaction-local start timestamp must be captured");
  assert.ok(startIndex < lockIndex, "the start timestamp must be captured before waiting on the row lock");
  assert.ok(lockIndex < setterIndex, "the global coordination row must be locked before the setter call");
  assert.ok(setterIndex < rawIndex, "the exact setter response must be stored after the call");
  assert.ok(rawIndex < observedIndex, "the observation timestamp must be captured after the raw response");
  assert.ok(observedIndex < finalIndex, "the final evidence result must follow the transition");
  assert.ok(finalIndex < commitIndex, "the evidence result must be emitted before commit");
  assert.equal(setterCallCount(sql), 1, "the canonical setter must occur exactly once");
  assert.match(sql, /where lane_key = 'global'[\s\S]*for update/iu);
  const gucKeys = [
    "mi.n30_transition_started_at",
    "mi.n30_transition_preflight",
    "mi.n30_transition_raw",
    "mi.n30_transition_observed_at",
    "mi.n30_transition_postflight",
  ];
  assert.equal(sql.match(/pg_catalog\.set_config\s*\(/giu)?.length, gucKeys.length);
  let previousGucIndex = -1;
  for (const key of gucKeys) {
    const keyIndex = sql.indexOf(`'${key}'`);
    assert.ok(keyIndex > previousGucIndex, `${key} must be saved once in execution order`);
    const callStart = sql.lastIndexOf("pg_catalog.set_config(", keyIndex);
    const callEnd = sql.indexOf("\n  );", keyIndex);
    assert.ok(callStart >= 0 && callEnd > keyIndex, `${key} must be inside one complete set_config call`);
    const call = sql.slice(callStart, callEnd + "\n  );".length);
    assert.equal(
      sql.match(new RegExp(`pg_catalog\\.set_config\\(\\s*'${key.replaceAll(".", "\\.")}'`, "giu"))?.length,
      1,
      `${key} must be set exactly once`,
    );
    assert.match(call, /,\s*true\s*\n\s*\);$/iu, `${key} must be transaction-local`);
    previousGucIndex = keyIndex;
  }
  const rawPreservation = sliceContract(
    sql,
    `raw_result := public.mi_set_naver_shopping_worker_cadence('${mode}');`,
    "transaction_observed_at :=",
  );
  assert.match(rawPreservation, /set_config\(\s*'mi\.n30_transition_raw',\s*raw_result::text,\s*true\s*\)/iu);
  assert.match(sql, new RegExp(`'accepted', true[\\s\\S]*'activated', true[\\s\\S]*'mode', '${mode}'[\\s\\S]*'minutes', ${expectedMinutes}`, "iu"));
  assert.match(sql, /updated_at[\s\S]*(between|>=)[\s\S]*transaction_started_at/iu);
  assert.match(sql, /updated_at[\s\S]*(between|<=)[\s\S]*transaction_observed_at/iu);
  assertFullIdleContract(sql);
  const postflightAssignment = sliceContract(sql, "postflight_ok :=", "if postflight_ok is not true then");
  assert.match(postflightAssignment, /raw_result\s*=\s*expected_raw/iu);
  assert.match(postflightAssignment, /updated_at\s+between\s+transaction_started_at\s+and\s+transaction_observed_at/iu);
  assert.match(postflightAssignment, new RegExp(`cadence_mode = '${mode}'[\\s\\S]*cadence_minutes = ${expectedMinutes}`, "iu"));
  assertFullIdleContract(postflightAssignment);
  assert.match(sql, /if postflight_ok is not true then\s+raise exception/iu);

  const finalEvidence = sliceContract(sql, "'transitionAccepted',", ") as n30_cadence_transition_result");
  assert.match(finalEvidence, /preflight ->> 'eligible'\)::boolean is true/iu);
  assert.match(finalEvidence, new RegExp(`preflight ->> 'cadenceMode' = '${mode === "candidate" ? "baseline" : "candidate"}'`, "iu"));
  assert.match(finalEvidence, new RegExp(`preflight ->> 'cadenceMinutes'\\)::integer = ${mode === "candidate" ? 10 : 6}`, "iu"));
  assert.match(finalEvidence, new RegExp(`'mode', '${mode}'[\\s\\S]*'minutes', ${expectedMinutes}`, "iu"));
  assert.match(finalEvidence, /postflight\s*->>\s*'cadenceMode'\s*=\s*'[^']+'/iu);
  assert.match(finalEvidence, /postflight\s*->>\s*'updatedAt'[\s\S]*between\s+transaction_started_at\s+and\s+transaction_observed_at/iu);
  for (const field of [
    "leaseWorkerId",
    "leaseToken",
    "leaseUntil",
    "runId",
    "currentStage",
    "currentJobKind",
    "currentTrackerId",
    "currentJobStartedAt",
    "probeTrackerId",
    "probeStartedAt",
  ]) {
    assert.match(finalEvidence, new RegExp(`postflight ->> '${field}' is null`, "iu"));
  }
  assert.match(finalEvidence, /postflight ->> 'currentPage'\)::integer\s*=\s*0/iu);
  assert.match(sql, /transitionAccepted/iu);
  assert.match(sql, /'attemptContract', 'external_persist_before_dispatch_no_retry'/iu);
  assert.match(sql, /commit;\s*$/iu);
  assert.doesNotMatch(sql, /begin read only/iu);
  assert.doesNotMatch(sql, /pg_catalog\.coalesce/iu);
  assert.match(sql, /\bcoalesce\s*\(\(/iu);
  assert.doesNotMatch(sql, /\b(insert|delete|merge|truncate|alter|drop|create|grant|revoke)\b/iu);
  assert.doesNotMatch(sql.replaceAll(/for\s+update/giu, ""), /\bupdate\b/iu);
  assert.doesNotMatch(sql, /\b(explain|where\s+false|dry_run)\b/iu);
}

test("builds the one-shot candidate6 transaction with exact identity and full post-idle evidence", () => {
  const sql = buildCandidateSql();

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
  assert.match(sql, new RegExp(`expected_run_id uuid := '${CANDIDATE_AUDIT.expectedRunId}'`, "iu"));
  assert.match(sql, new RegExp(`expected_collection_id text := '${CANDIDATE_AUDIT.expectedCollectionId}'`, "iu"));
  assert.match(sql, new RegExp(`expected_last_success_at timestamptz := '${CANDIDATE_AUDIT.expectedLastSuccessAt.replaceAll(".", "\\.")}'`, "iu"));
  assert.match(sql, /(?:from|join) public\.naver_shopping_worker_runs/iu);
  assert.match(sql, /from public\.naver_shopping_scheduler_events/iu);
  assert.match(sql, /from public\.naver_rank_snapshots/iu);
  assert.match(sql, /run_trigger in \('rank-catch-up', 'rank-remote', 'rank-0900', 'rank-1500'\)/iu);
  assert.match(sql, /group_claimed\.occurred_at\s+between exact_run\.started_at - interval '5 seconds' and expected_last_success_at/iu);
  assert.match(sql, /snapshot\.checked_count = 300/iu);
  assert.match(sql, /snapshot\.source = 'naver_shopping_results_collector'/iu);
  assert.match(sql, /snapshot\.item -> 'adExcluded' = 'true'::jsonb/iu);
  assert.match(sql, /snapshot\.item ->> 'rankPolicy' = 'organic_only'/iu);
  assert.match(sql, /snapshot\.item ->> 'rankEvidence' = 'naver_shopping_organic_list'/iu);
  assert.match(sql, /jsonb_typeof\(snapshot\.item -> 'excludedAdCount'\) = 'number'/iu);
  assert.doesNotMatch(sql, /committed\.excluded_ad_count is not null/iu);
  assert.match(sql, /atomic_proof_ok/iu);

  const postflightAssignment = sliceContract(sql, "postflight_ok :=", "if postflight_ok is not true then");
  assert.match(postflightAssignment, new RegExp(`primary_worker_id = '${N30_TARGET_WORKER_ID}'`, "iu"));
  assert.match(postflightAssignment, new RegExp(`runtime_version = '${N30_TARGET_RUNTIME_VERSION.replaceAll(".", "\\.")}'`, "iu"));
  assert.match(postflightAssignment, new RegExp(`runtime_fingerprint = '${N30_TARGET_RUNTIME_FINGERPRINT}'`, "iu"));
  assert.match(postflightAssignment, /circuit_state = 'closed'/iu);
  assert.match(postflightAssignment, /circuit_reason is null/iu);
  assert.match(postflightAssignment, /cooldown_until is null/iu);

  const finalEvidence = sliceContract(sql, "'transitionAccepted',", ") as n30_cadence_transition_result");
  assert.match(finalEvidence, /preflight ->> 'atomicProofOk'\)::boolean is true/iu);
  assert.match(finalEvidence, new RegExp(`preflight ->> 'primaryWorkerId' = '${N30_TARGET_WORKER_ID}'`, "iu"));
  assert.match(finalEvidence, new RegExp(`postflight ->> 'runtimeFingerprint' = '${N30_TARGET_RUNTIME_FINGERPRINT}'`, "iu"));
});

test("proves the whole claim with exact tracker, commit, and single-snapshot sets", () => {
  const sql = buildCandidateSql();

  const claimProof = sliceContract(
    sql,
    "and (\n        select count(*)\n        from public.naver_shopping_scheduler_events as tracker_claimed",
    ") into atomic_proof_ok;",
  );
  assert.match(claimProof, /failed\.claim_id = group_claimed\.claim_id/iu);
  assert.match(claimProof, /or failed\.run_id\s*=\s*expected_run_id/iu);
  assert.match(claimProof, /tracker_claimed\.run_id is distinct from expected_run_id/iu);
  assert.match(claimProof, /committed\.run_id is distinct from expected_run_id/iu);
  assert.match(claimProof, /run_event\.run_id = expected_run_id/iu);
  assert.match(claimProof, /run_event\.claim_id is distinct from group_claimed\.claim_id/iu);
  assert.match(claimProof, /count\(distinct committed_count\.tracker_id\)/iu);
  assert.match(claimProof, /count\(distinct snapshot_set\.tracker_id\)/iu);
  assert.match(claimProof, /from public\.naver_rank_snapshots as snapshot[\s\S]*\) = 1/iu);
  assert.match(
    claimProof,
    /jsonb_array_elements\(\s*case\s+when pg_catalog\.jsonb_typeof\(snapshot\.top_items\) = 'array'[\s\S]*else '\[\]'::jsonb\s+end\s*\)/iu,
  );
  assert.match(
    claimProof,
    /case\s+when pg_catalog\.jsonb_typeof\(snapshot\.item -> 'excludedAdCount'\) = 'number'[\s\S]*else false\s+end/iu,
  );
  const collectionSet = sliceContract(
    claimProof,
    "select count(*) = count(distinct snapshot_set.tracker_id)",
    "and (\n        select max(committed_at.occurred_at)",
  );
  assert.match(collectionSet, /snapshot_set\.collection_id = expected_collection_id/iu);
  assert.doesNotMatch(collectionSet, /snapshot_set\.checked_at/iu);
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

test("requires a pinned current atomic proof for candidate and rejects malformed audit identities", () => {
  assert.throws(() => buildN30CadenceTransitionSql({ mode: "candidate" }), /expectedRunId/);
  assert.throws(
    () => buildN30CadenceTransitionSql({ mode: "candidate", ...CANDIDATE_AUDIT, expectedRunId: "bad" }),
    /expectedRunId/,
  );
  assert.throws(
    () => buildN30CadenceTransitionSql({ mode: "candidate", ...CANDIDATE_AUDIT, expectedCollectionId: "pw';commit;--" }),
    /expectedCollectionId/,
  );
  assert.throws(
    () => buildN30CadenceTransitionSql({ mode: "candidate", ...CANDIDATE_AUDIT, expectedLastSuccessAt: "today" }),
    /expectedLastSuccessAt/,
  );
});

test("is a pure synchronous generator included in the normal regression command", () => {
  const source = readFileSync(
    new URL("./naver-shopping-cadence-transition-sql.mjs", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const sql = buildCandidateSql();

  assert.equal(typeof sql, "string");
  assert.doesNotMatch(source, /@supabase|createClient|fetch\s*\(|node:child_process|\bexec\s*\(|\bspawn\s*\(|process\.env/iu);
  assert.match(packageJson.scripts.test, /naver-shopping-cadence-transition-sql\.test\.mjs/);
});
