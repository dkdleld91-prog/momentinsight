import {
  N30_TARGET_RUNTIME_FINGERPRINT,
  N30_TARGET_RUNTIME_VERSION,
  N30_TARGET_WORKER_ID,
} from "./naver-shopping-candidate-performance-audit.mjs";

export {
  N30_TARGET_RUNTIME_FINGERPRINT,
  N30_TARGET_RUNTIME_VERSION,
  N30_TARGET_WORKER_ID,
};

export const N30_CANDIDATE_CADENCE_MINUTES = 6;
export const N30_BASELINE_CADENCE_MINUTES = 10;

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COLLECTION_ID_PATTERN = /^pw-chrome-[a-z0-9-]{8,150}$/;

const TRANSITIONS = Object.freeze({
  candidate: Object.freeze({
    marker: "n30_candidate6_transition_v1",
    preMode: "baseline",
    preMinutes: N30_BASELINE_CADENCE_MINUTES,
    postMode: "candidate",
    postMinutes: N30_CANDIDATE_CADENCE_MINUTES,
  }),
  baseline: Object.freeze({
    marker: "n30_baseline10_transition_v1",
    preMode: "candidate",
    preMinutes: N30_CANDIDATE_CADENCE_MINUTES,
    postMode: "baseline",
    postMinutes: N30_BASELINE_CADENCE_MINUTES,
  }),
});

function requireMode(mode) {
  if (mode !== "candidate" && mode !== "baseline") {
    throw new TypeError("mode must be exactly candidate or baseline");
  }
  return mode;
}

function requireCandidateAudit(options) {
  const expectedRunId = options.expectedRunId;
  const expectedCollectionId = options.expectedCollectionId;
  const expectedLastSuccessAt = options.expectedLastSuccessAt;
  if (typeof expectedRunId !== "string" || !UUID_PATTERN.test(expectedRunId)) {
    throw new TypeError("expectedRunId must be an exact UUID");
  }
  if (typeof expectedCollectionId !== "string" || !COLLECTION_ID_PATTERN.test(expectedCollectionId)) {
    throw new TypeError("expectedCollectionId must be an exact pw-chrome collection ID");
  }
  if (
    typeof expectedLastSuccessAt !== "string"
    || !ISO_UTC_PATTERN.test(expectedLastSuccessAt)
    || !Number.isFinite(Date.parse(expectedLastSuccessAt))
  ) {
    throw new TypeError("expectedLastSuccessAt must be an ISO-8601 UTC timestamp");
  }
  return Object.freeze({ expectedRunId, expectedCollectionId, expectedLastSuccessAt });
}

function buildCandidateDeclarations(audit) {
  return `
  expected_run_id uuid := '${audit.expectedRunId}';
  expected_collection_id text := '${audit.expectedCollectionId}';
  expected_last_success_at timestamptz := '${audit.expectedLastSuccessAt}';
  atomic_proof_ok boolean := false;`;
}

function buildCandidateAtomicProofSql() {
  return `

  select exists (
    select 1
    from public.naver_shopping_scheduler_events as group_claimed
    join public.naver_shopping_worker_runs as exact_run
      on exact_run.run_id = group_claimed.run_id
    where group_claimed.event_type = 'group_claimed'
      and group_claimed.run_id = expected_run_id
      and group_claimed.worker_id = '${N30_TARGET_WORKER_ID}'
      and group_claimed.occurred_at
        between exact_run.started_at - interval '5 seconds' and expected_last_success_at
      and exact_run.worker_id = '${N30_TARGET_WORKER_ID}'
      and exact_run.run_trigger = 'rank-catch-up'
      and exact_run.runtime_version = '${N30_TARGET_RUNTIME_VERSION}'
      and exact_run.runtime_fingerprint = '${N30_TARGET_RUNTIME_FINGERPRINT}'
      and (
        select count(*)
        from public.naver_shopping_scheduler_events as group_count
        where group_count.event_type = 'group_claimed'
          and group_count.run_id = expected_run_id
      ) = 1
      and (
        select count(*)
        from public.naver_shopping_scheduler_events as tracker_claimed
        where tracker_claimed.event_type = 'tracker_claimed'
          and tracker_claimed.claim_id = group_claimed.claim_id
      ) > 0
      and (
        select count(*) = count(distinct tracker_claimed.tracker_id)
        from public.naver_shopping_scheduler_events as tracker_claimed
        where tracker_claimed.event_type = 'tracker_claimed'
          and tracker_claimed.claim_id = group_claimed.claim_id
      )
      and not exists (
        select 1
        from public.naver_shopping_scheduler_events as failed
        where failed.event_type = 'job_failed'
          and (
            failed.claim_id = group_claimed.claim_id
            or failed.run_id = expected_run_id
          )
      )
      and not exists (
        select 1
        from public.naver_shopping_scheduler_events as run_event
        where run_event.event_type in ('tracker_claimed', 'tracker_committed', 'job_failed')
          and run_event.run_id = expected_run_id
          and run_event.claim_id is distinct from group_claimed.claim_id
      )
      and not exists (
        select 1
        from public.naver_shopping_scheduler_events as tracker_claimed
        where tracker_claimed.event_type = 'tracker_claimed'
          and tracker_claimed.claim_id = group_claimed.claim_id
          and (
            tracker_claimed.run_id is distinct from expected_run_id
            or tracker_claimed.worker_id is distinct from '${N30_TARGET_WORKER_ID}'
            or tracker_claimed.group_fingerprint is distinct from group_claimed.group_fingerprint
            or tracker_claimed.occurred_at < group_claimed.occurred_at
            or tracker_claimed.occurred_at > expected_last_success_at
            or (
              select count(*)
              from public.naver_shopping_scheduler_events as committed
              where committed.event_type = 'tracker_committed'
                and committed.claim_id = tracker_claimed.claim_id
                and committed.tracker_id = tracker_claimed.tracker_id
            ) <> 1
            or not exists (
              select 1
              from public.naver_shopping_scheduler_events as committed
              where committed.event_type = 'tracker_committed'
                and committed.claim_id = tracker_claimed.claim_id
                and committed.run_id = expected_run_id
                and committed.worker_id = '${N30_TARGET_WORKER_ID}'
                and committed.tracker_id = tracker_claimed.tracker_id
                and committed.group_fingerprint = tracker_claimed.group_fingerprint
                and committed.collection_id = expected_collection_id
                and committed.checked_count = 300
                and committed.details ->> 'source' = 'naver_shopping_results_collector'
                and committed.occurred_at between tracker_claimed.occurred_at and expected_last_success_at
                and (
                  select count(*)
                  from public.naver_rank_snapshots as snapshot
                  where snapshot.tracker_id = committed.tracker_id
                    and snapshot.collection_id = expected_collection_id
                    and snapshot.checked_at between tracker_claimed.occurred_at and committed.occurred_at
                    and snapshot.checked_count = 300
                    and snapshot.source = 'naver_shopping_results_collector'
                    and pg_catalog.jsonb_typeof(snapshot.item) = 'object'
                    and (snapshot.matched = false or snapshot.item -> 'isOrganic' = 'true'::jsonb)
                    and snapshot.item -> 'adExcluded' = 'true'::jsonb
                    and snapshot.item ->> 'rankPolicy' = 'organic_only'
                    and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
                    and snapshot.item ->> 'collectionId' = expected_collection_id
                    and case
                      when pg_catalog.jsonb_typeof(snapshot.item -> 'excludedAdCount') = 'number'
                        and (snapshot.item ->> 'excludedAdCount') ~ '^[0-9]+$'
                      then (snapshot.item ->> 'excludedAdCount')::numeric >= 0
                      else false
                    end
                    and pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
                    and not exists (
                      select 1
                      from pg_catalog.jsonb_array_elements(
                        case when pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
                          then snapshot.top_items else '[]'::jsonb end
                      ) as top_item
                      where top_item -> 'isOrganic' is distinct from 'true'::jsonb
                         or top_item -> 'isAd' is distinct from 'false'::jsonb
                    )
                ) = 1
            )
          )
      )
      and not exists (
        select 1
        from public.naver_shopping_scheduler_events as committed
        where committed.event_type = 'tracker_committed'
          and committed.claim_id = group_claimed.claim_id
          and (
            committed.run_id is distinct from expected_run_id
            or committed.worker_id is distinct from '${N30_TARGET_WORKER_ID}'
            or committed.group_fingerprint is distinct from group_claimed.group_fingerprint
            or committed.collection_id is distinct from expected_collection_id
            or committed.checked_count is distinct from 300
            or committed.details ->> 'source' is distinct from 'naver_shopping_results_collector'
            or committed.occurred_at < group_claimed.occurred_at
            or committed.occurred_at > expected_last_success_at
            or not exists (
              select 1
              from public.naver_shopping_scheduler_events as matching_claim
              where matching_claim.event_type = 'tracker_claimed'
                and matching_claim.claim_id = committed.claim_id
                and matching_claim.run_id = expected_run_id
                and matching_claim.worker_id = '${N30_TARGET_WORKER_ID}'
                and matching_claim.tracker_id = committed.tracker_id
                and matching_claim.group_fingerprint = committed.group_fingerprint
                and matching_claim.occurred_at between group_claimed.occurred_at and committed.occurred_at
            )
          )
      )
      and (
        select count(*)
        from public.naver_shopping_scheduler_events as committed_count
        where committed_count.event_type = 'tracker_committed'
          and committed_count.claim_id = group_claimed.claim_id
      ) = (
        select count(*)
        from public.naver_shopping_scheduler_events as claimed_count
        where claimed_count.event_type = 'tracker_claimed'
          and claimed_count.claim_id = group_claimed.claim_id
      )
      and (
        select count(distinct committed_count.tracker_id)
        from public.naver_shopping_scheduler_events as committed_count
        where committed_count.event_type = 'tracker_committed'
          and committed_count.claim_id = group_claimed.claim_id
      ) = (
        select count(*)
        from public.naver_shopping_scheduler_events as claimed_count
        where claimed_count.event_type = 'tracker_claimed'
          and claimed_count.claim_id = group_claimed.claim_id
      )
      and (
        select count(*) = count(distinct snapshot_set.tracker_id)
          and count(*) = (
            select count(*)
            from public.naver_shopping_scheduler_events as claimed_count
            where claimed_count.event_type = 'tracker_claimed'
              and claimed_count.claim_id = group_claimed.claim_id
          )
        from public.naver_rank_snapshots as snapshot_set
        where snapshot_set.collection_id = expected_collection_id
      )
      and (
        select max(committed_at.occurred_at)
        from public.naver_shopping_scheduler_events as committed_at
        where committed_at.event_type = 'tracker_committed'
          and committed_at.claim_id = group_claimed.claim_id
      ) between expected_last_success_at - interval '2 minutes' and expected_last_success_at
  ) into atomic_proof_ok;`;
}

function buildCandidateEligibilitySql() {
  return `
      and coordination_row.circuit_state = 'closed'
      and coordination_row.circuit_reason is null
      and coordination_row.cooldown_until is null
      and coordination_row.primary_worker_id = '${N30_TARGET_WORKER_ID}'
      and coordination_row.primary_seen_at > transaction_observed_at - interval '3 minutes'
      and coordination_row.runtime_version = '${N30_TARGET_RUNTIME_VERSION}'
      and coordination_row.runtime_fingerprint = '${N30_TARGET_RUNTIME_FINGERPRINT}'
      and coordination_row.stability_started_at is not null
      and coordination_row.stability_started_at <= transaction_observed_at - interval '24 hours'
      and coordination_row.success_streak >= 6
      and coordination_row.last_success_at is not null
      and coordination_row.last_success_at > transaction_observed_at - interval '15 minutes'
      and coordination_row.last_success_at = expected_last_success_at
      and coordination_row.last_collection_id = expected_collection_id
      and coordination_row.last_checked_count = 300
      and coordination_row.last_source = 'naver_shopping_results_collector'
      and atomic_proof_ok`;
}

function buildCandidatePostflightSql() {
  return `
      and coordination_row.circuit_state = 'closed'
      and coordination_row.circuit_reason is null
      and coordination_row.cooldown_until is null
      and coordination_row.primary_worker_id = '${N30_TARGET_WORKER_ID}'
      and coordination_row.runtime_version = '${N30_TARGET_RUNTIME_VERSION}'
      and coordination_row.runtime_fingerprint = '${N30_TARGET_RUNTIME_FINGERPRINT}'`;
}

function buildCandidateFinalEvidenceSql() {
  return `
    and (preflight ->> 'atomicProofOk')::boolean is true
    and preflight ->> 'primaryWorkerId' = '${N30_TARGET_WORKER_ID}'
    and preflight ->> 'runtimeVersion' = '${N30_TARGET_RUNTIME_VERSION}'
    and preflight ->> 'runtimeFingerprint' = '${N30_TARGET_RUNTIME_FINGERPRINT}'
    and preflight ->> 'circuitState' = 'closed'
    and preflight ->> 'circuitReason' is null
    and preflight ->> 'cooldownUntil' is null
    and postflight ->> 'primaryWorkerId' = '${N30_TARGET_WORKER_ID}'
    and postflight ->> 'runtimeVersion' = '${N30_TARGET_RUNTIME_VERSION}'
    and postflight ->> 'runtimeFingerprint' = '${N30_TARGET_RUNTIME_FINGERPRINT}'`;
}

export function buildN30CadenceTransitionSql(options = {}) {
  const mode = requireMode(options.mode);
  const transition = TRANSITIONS[mode];
  const candidateAudit = mode === "candidate" ? requireCandidateAudit(options) : null;
  const candidateDeclarations = candidateAudit ? buildCandidateDeclarations(candidateAudit) : "";
  const candidateAtomicProof = candidateAudit ? buildCandidateAtomicProofSql() : "";
  const candidateEligibility = mode === "candidate" ? buildCandidateEligibilitySql() : "";
  const candidatePostflight = mode === "candidate" ? buildCandidatePostflightSql() : "";
  const candidateFinalEvidence = mode === "candidate" ? buildCandidateFinalEvidenceSql() : "";

  return `begin;
set local transaction isolation level serializable;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local role service_role;
-- Cross-execution exactly-once requires attempted=true to be persisted before dispatch; never retry any outcome.
do $n30_started$
begin
  perform pg_catalog.set_config(
    'mi.n30_transition_started_at',
    pg_catalog.clock_timestamp()::text,
    true
  );
end;
$n30_started$;
do $n30_transition$
declare
  coordination_row public.naver_shopping_worker_coordination%rowtype;
  coordination_found boolean := false;
  processing_count integer := 0;
  preflight_ok boolean := false;
  postflight_ok boolean := false;
  transaction_started_at timestamptz := pg_catalog.current_setting(
    'mi.n30_transition_started_at'
  )::timestamptz;
  transaction_observed_at timestamptz;
  raw_result jsonb;
  expected_raw jsonb := pg_catalog.jsonb_build_object(
    'accepted', true,
    'activated', true,
    'mode', '${transition.postMode}',
    'minutes', ${transition.postMinutes}
  );${candidateDeclarations}
begin
  select * into coordination_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  coordination_found := found;
  transaction_observed_at := pg_catalog.clock_timestamp();

  select (
    (select count(*) from public.naver_shopping_rank_lookup_jobs
      where status = 'processing' and processing_until > transaction_observed_at)
    +
    (select count(*) from public.naver_rank_trackers
      where status = 'active' and processing_until > transaction_observed_at)
  )::integer into processing_count;${candidateAtomicProof}

  preflight_ok := coalesce((
    coordination_found
      and processing_count = 0
      and coordination_row.cadence_mode = '${transition.preMode}'
      and coordination_row.cadence_minutes = ${transition.preMinutes}
      and coordination_row.lease_worker_id is null
      and coordination_row.lease_token is null
      and coordination_row.lease_until is null
      and coordination_row.run_id is null
      and coordination_row.current_stage is null
      and coordination_row.current_page = 0
      and coordination_row.current_job_kind is null
      and coordination_row.current_tracker_id is null
      and coordination_row.current_job_started_at is null
      and coordination_row.probe_tracker_id is null
      and coordination_row.probe_started_at is null${candidateEligibility}
  ), false);
  if preflight_ok is not true then
    raise exception 'n30_${mode}${transition.postMinutes}_preflight_rejected';
  end if;

  perform pg_catalog.set_config(
    'mi.n30_transition_preflight',
    pg_catalog.jsonb_build_object(
      'eligible', preflight_ok,
      'cadenceMode', coordination_row.cadence_mode,
      'cadenceMinutes', coordination_row.cadence_minutes,
      'processingCount', processing_count,
      'primaryWorkerId', coordination_row.primary_worker_id,
      'primarySeenAt', coordination_row.primary_seen_at,
      'runtimeVersion', coordination_row.runtime_version,
      'runtimeFingerprint', coordination_row.runtime_fingerprint,
      'stabilityStartedAt', coordination_row.stability_started_at,
      'successStreak', coordination_row.success_streak,
      'lastSuccessAt', coordination_row.last_success_at,
      'lastCollectionId', coordination_row.last_collection_id,
      'lastCheckedCount', coordination_row.last_checked_count,
      'lastSource', coordination_row.last_source,
      'atomicProofOk', ${mode === "candidate" ? "atomic_proof_ok" : "null"},
      'expectedRunId', ${mode === "candidate" ? "expected_run_id" : "null"},
      'circuitState', coordination_row.circuit_state,
      'circuitReason', coordination_row.circuit_reason,
      'cooldownUntil', coordination_row.cooldown_until
    )::text,
    true
  );

  raw_result := public.mi_set_naver_shopping_worker_cadence('${mode}');
  perform pg_catalog.set_config(
    'mi.n30_transition_raw',
    raw_result::text,
    true
  );
  transaction_observed_at := pg_catalog.clock_timestamp();
  perform pg_catalog.set_config(
    'mi.n30_transition_observed_at',
    transaction_observed_at::text,
    true
  );

  select * into coordination_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global';

  select (
    (select count(*) from public.naver_shopping_rank_lookup_jobs
      where status = 'processing' and processing_until > transaction_observed_at)
    +
    (select count(*) from public.naver_rank_trackers
      where status = 'active' and processing_until > transaction_observed_at)
  )::integer into processing_count;

  postflight_ok := coalesce((
    raw_result = expected_raw
      and processing_count = 0
      and coordination_row.cadence_mode = '${transition.postMode}'
      and coordination_row.cadence_minutes = ${transition.postMinutes}
      and coordination_row.updated_at between transaction_started_at and transaction_observed_at
      and coordination_row.lease_worker_id is null
      and coordination_row.lease_token is null
      and coordination_row.lease_until is null
      and coordination_row.run_id is null
      and coordination_row.current_stage is null
      and coordination_row.current_page = 0
      and coordination_row.current_job_kind is null
      and coordination_row.current_tracker_id is null
      and coordination_row.current_job_started_at is null
      and coordination_row.probe_tracker_id is null
      and coordination_row.probe_started_at is null${candidatePostflight}
  ), false);
  if postflight_ok is not true then
    raise exception 'n30_${mode}${transition.postMinutes}_postflight_rejected'
      using detail = pg_catalog.jsonb_build_object(
        'raw', raw_result,
        'processingCount', processing_count,
        'cadenceMode', coordination_row.cadence_mode,
        'cadenceMinutes', coordination_row.cadence_minutes,
        'updatedAt', coordination_row.updated_at,
        'transactionStartedAt', transaction_started_at,
        'transactionObservedAt', transaction_observed_at
      )::text;
  end if;

  perform pg_catalog.set_config(
    'mi.n30_transition_postflight',
    pg_catalog.jsonb_build_object(
      'accepted', postflight_ok,
      'cadenceMode', coordination_row.cadence_mode,
      'cadenceMinutes', coordination_row.cadence_minutes,
      'processingCount', processing_count,
      'updatedAt', coordination_row.updated_at,
      'leaseWorkerId', coordination_row.lease_worker_id,
      'leaseToken', coordination_row.lease_token,
      'leaseUntil', coordination_row.lease_until,
      'runId', coordination_row.run_id,
      'currentStage', coordination_row.current_stage,
      'currentPage', coordination_row.current_page,
      'currentJobKind', coordination_row.current_job_kind,
      'currentTrackerId', coordination_row.current_tracker_id,
      'currentJobStartedAt', coordination_row.current_job_started_at,
      'probeTrackerId', coordination_row.probe_tracker_id,
      'probeStartedAt', coordination_row.probe_started_at,
      'primaryWorkerId', coordination_row.primary_worker_id,
      'runtimeVersion', coordination_row.runtime_version,
      'runtimeFingerprint', coordination_row.runtime_fingerprint,
      'circuitState', coordination_row.circuit_state,
      'circuitReason', coordination_row.circuit_reason,
      'cooldownUntil', coordination_row.cooldown_until
    )::text,
    true
  );
end;
$n30_transition$;
with evidence as (
  select
    pg_catalog.current_setting('mi.n30_transition_started_at')::timestamptz
      as transaction_started_at,
    pg_catalog.current_setting('mi.n30_transition_observed_at')::timestamptz
      as transaction_observed_at,
    pg_catalog.current_setting('mi.n30_transition_raw')::jsonb as raw_result,
    pg_catalog.current_setting('mi.n30_transition_preflight')::jsonb as preflight,
    pg_catalog.current_setting('mi.n30_transition_postflight')::jsonb as postflight
)
select pg_catalog.jsonb_build_object(
  'marker', '${transition.marker}',
  'transactionStartedAt', transaction_started_at,
  'transactionObservedAt', transaction_observed_at,
  'raw', raw_result,
  'preflight', preflight,
  'postflight', postflight,
  'attemptContract', 'external_persist_before_dispatch_no_retry',
  'transitionAccepted',
    (preflight ->> 'eligible')::boolean is true
    and preflight ->> 'cadenceMode' = '${transition.preMode}'
    and (preflight ->> 'cadenceMinutes')::integer = ${transition.preMinutes}
    and raw_result = pg_catalog.jsonb_build_object(
      'accepted', true,
      'activated', true,
      'mode', '${transition.postMode}',
      'minutes', ${transition.postMinutes}
    )
    and postflight ->> 'cadenceMode' = '${transition.postMode}'
    and (postflight ->> 'cadenceMinutes')::integer = ${transition.postMinutes}
    and (postflight ->> 'processingCount')::integer = 0
    and (postflight ->> 'updatedAt')::timestamptz
      between transaction_started_at and transaction_observed_at
    and postflight ->> 'leaseWorkerId' is null
    and postflight ->> 'leaseToken' is null
    and postflight ->> 'leaseUntil' is null
    and postflight ->> 'runId' is null
    and postflight ->> 'currentStage' is null
    and (postflight ->> 'currentPage')::integer = 0
    and postflight ->> 'currentJobKind' is null
    and postflight ->> 'currentTrackerId' is null
    and postflight ->> 'currentJobStartedAt' is null
    and postflight ->> 'probeTrackerId' is null
    and postflight ->> 'probeStartedAt' is null
    and (postflight ->> 'accepted')::boolean is true${candidateFinalEvidence}
) as n30_cadence_transition_result
from evidence;
commit;
`;
}
