const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const TOKEN = /^[A-Za-z0-9._-]{1,100}$/u;
const AGENCY = /^[A-Za-z0-9_-]{1,80}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const COHORT_HASH = /^[a-f0-9]{32}$/u;

function timestamp(value, name) {
  if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function token(value, name, pattern = TOKEN) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

export function buildGlobalAccountRankHealthAuditSql({
  activationAt,
  observedAt,
  worker,
  runtime,
  fingerprint,
  mandatoryAgency,
  mustTotal,
  mustMandatory,
  expectedCohortHash,
  expectedMandatoryCohortHash,
} = {}) {
  const activation = timestamp(activationAt, "activationAt");
  const observed = timestamp(observedAt, "observedAt");
  if (Date.parse(observed) < Date.parse(activation)) throw new RangeError("observedAt must not precede activationAt");
  const workerId = token(worker, "worker");
  const runtimeVersion = token(runtime, "runtime");
  const runtimeFingerprint = token(fingerprint, "fingerprint", FINGERPRINT);
  const agencyCode = token(mandatoryAgency, "mandatoryAgency", AGENCY);
  const expectedTotal = count(mustTotal, "mustTotal");
  const expectedMandatory = count(mustMandatory, "mustMandatory");
  if (expectedMandatory > expectedTotal) throw new RangeError("mustMandatory must not exceed mustTotal");
  const requiredCohortHash = token(expectedCohortHash, "expectedCohortHash", COHORT_HASH);
  const requiredMandatoryCohortHash = token(
    expectedMandatoryCohortHash,
    "expectedMandatoryCohortHash",
    COHORT_HASH,
  );

  return `begin transaction isolation level repeatable read read only;
set local role service_role;
with
params as (
  select '${activation}'::timestamptz as activation_at,
    '${observed}'::timestamptz as observed_at,
    '${workerId}'::text as worker_id,
    '${runtimeVersion}'::text as runtime_version,
    '${runtimeFingerprint}'::text as runtime_fingerprint,
    '${agencyCode}'::text as mandatory_agency,
    ${expectedTotal}::integer as must_total,
    ${expectedMandatory}::integer as must_mandatory,
    '${requiredCohortHash}'::text as expected_cohort_hash,
    '${requiredMandatoryCohortHash}'::text as expected_mandatory_cohort_hash
),
cohort as (
  select tracker.id as tracker_id, tracker.agency_code,
    tracker.current_rank, tracker.last_checked_at, tracker.next_check_at,
    tracker.worker_quarantined_until, tracker.processing_until
  from public.naver_rank_trackers as tracker cross join params
  where tracker.status = 'active'
),
cohort_totals as (
  select count(*)::integer as total_count,
    count(*) filter (where agency_code = params.mandatory_agency)::integer as mandatory_count,
    pg_catalog.md5(coalesce(pg_catalog.string_agg(
      tracker_id::text || ':' || agency_code, ',' order by agency_code, tracker_id
    ), '')) as cohort_hash,
    pg_catalog.md5(coalesce(pg_catalog.string_agg(
      tracker_id::text || ':' || agency_code, ',' order by tracker_id
    ) filter (where agency_code = params.mandatory_agency), '')) as mandatory_cohort_hash
  from cohort cross join params
),
cohort_readiness as (
  select cohort_totals.*,
    (cohort_totals.total_count = params.must_total
      and cohort_totals.mandatory_count = params.must_mandatory) as exact_totals_ok,
    (cohort_totals.total_count = params.must_total
      and cohort_totals.mandatory_count = params.must_mandatory
      and cohort_totals.cohort_hash = params.expected_cohort_hash
      and cohort_totals.mandatory_cohort_hash = params.expected_mandatory_cohort_hash)
      as exact_cohort_ok
  from cohort_totals cross join params
),
claim_candidates as (
  select cohort.tracker_id, cohort.agency_code, event.event_id as claim_event_id,
    event.occurred_at as claim_at, event.claim_id, event.run_id,
    event.worker_id as claim_worker_id, event.agency_code as claim_agency_code,
    count(*) over (partition by cohort.tracker_id)::integer as claim_count,
    row_number() over (partition by cohort.tracker_id order by event.event_id)::integer as claim_sequence
  from cohort cross join params
  join public.naver_shopping_scheduler_events as event
    on event.tracker_id = cohort.tracker_id and event.event_type = 'tracker_claimed'
   and event.occurred_at >= params.activation_at and event.occurred_at <= params.observed_at
),
first_claim as (
  select * from claim_candidates where claim_sequence = 1
),
terminal_evidence as (
  select claim.*,
    terminal.event_id as terminal_event_id, terminal.occurred_at as terminal_at,
    terminal.event_type as terminal_type, terminal.tracker_id as terminal_tracker_id,
    terminal.run_id as terminal_run_id, terminal.worker_id as terminal_worker_id,
    terminal.agency_code as terminal_agency_code, terminal.error_code,
    terminal.checked_count as terminal_checked_count,
    terminal.collection_id as terminal_collection_id,
    terminal.terminal_count
  from first_claim as claim
  left join lateral (
    select event.*,
      count(*) over ()::integer as terminal_count
    from public.naver_shopping_scheduler_events as event cross join params
    where event.claim_id = claim.claim_id
      and event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as terminal on true
),
evidence as (
  select cohort.*, claim.claim_event_id, claim.claim_at, claim.claim_id, claim.run_id,
    claim.claim_worker_id, claim.claim_agency_code, coalesce(claim.claim_count, 0) as claim_count,
    claim.terminal_event_id, claim.terminal_at, claim.terminal_type,
    claim.terminal_tracker_id, claim.terminal_run_id, claim.terminal_worker_id,
    claim.terminal_agency_code, claim.error_code, claim.terminal_checked_count,
    claim.terminal_collection_id, coalesce(claim.terminal_count, 0) as terminal_count,
    run.started_at as run_started_at, run.worker_id as run_worker_id,
    run.runtime_version, run.runtime_fingerprint,
    coalesce(snapshot.snapshot_count, 0) as snapshot_count,
    coalesce(snapshot.strict_snapshot_count, 0) as strict_snapshot_count,
    coalesce(snapshot.materialized_snapshot_count, 0) as materialized_snapshot_count
  from cohort
  left join terminal_evidence as claim on claim.tracker_id = cohort.tracker_id
  left join public.naver_shopping_worker_runs as run on run.run_id = claim.run_id
  left join lateral (
    select count(*)::integer as snapshot_count,
      count(*) filter (where snapshot.checked_count = 300
        and snapshot.source = 'naver_shopping_results_collector'
        and snapshot.collection_id = claim.terminal_collection_id
        and snapshot.item ->> 'collectionId' = snapshot.collection_id
        and snapshot.item ->> 'source' = 'naver_shopping_results_collector'
        and snapshot.item -> 'adExcluded' = 'true'::jsonb
        and snapshot.item ->> 'rankPolicy' = 'organic_only'
        and ((snapshot.matched is false and snapshot.rank is null)
          or (snapshot.matched is true and snapshot.rank between 1 and 300
            and snapshot.item -> 'isOrganic' = 'true'::jsonb
            and snapshot.item -> 'isAd' = 'false'::jsonb))
        and pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
        and pg_catalog.jsonb_array_length(snapshot.top_items) between 1 and 100
        and not exists (select 1 from pg_catalog.jsonb_array_elements(snapshot.top_items) as top(item)
          where top.item -> 'isOrganic' is distinct from 'true'::jsonb
             or top.item -> 'isAd' is distinct from 'false'::jsonb)
      )::integer as strict_snapshot_count,
      count(*) filter (where cohort.last_checked_at = claim.terminal_at
        and ((snapshot.matched is false and cohort.current_rank is null)
          or (snapshot.matched is true and cohort.current_rank = snapshot.rank)))::integer
        as materialized_snapshot_count
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = cohort.tracker_id
      and snapshot.checked_at = claim.terminal_at
  ) as snapshot on true
),
classified as (
  select evidence.*,
    (claim_event_id is not null and (claim_worker_id is distinct from params.worker_id
      or run_worker_id is distinct from params.worker_id
      or evidence.runtime_version is distinct from params.runtime_version
      or evidence.runtime_fingerprint is distinct from params.runtime_fingerprint
      or terminal_worker_id is distinct from params.worker_id
      or terminal_tracker_id is distinct from tracker_id
      or terminal_run_id is distinct from run_id)) as identity_violation,
    (claim_event_id is not null and (terminal_event_id is not null)
      and not (claim_event_id < terminal_event_id and claim_at <= run_started_at
        and run_started_at <= terminal_at)) as order_violation,
    (claim_count > 1 or terminal_count > 1) as duplicate_violation,
    (claim_event_id is not null and (claim_agency_code is distinct from agency_code
      or (terminal_event_id is not null and terminal_agency_code is distinct from agency_code)))
      as agency_mismatch,
    case
      when claim_event_id is null then 'unclaimed'
      when terminal_event_id is null then 'open'
      when claim_count > 1 or terminal_count > 1 then 'integrity_duplicate'
      when claim_worker_id is distinct from params.worker_id
        or run_worker_id is distinct from params.worker_id
        or evidence.runtime_version is distinct from params.runtime_version
        or evidence.runtime_fingerprint is distinct from params.runtime_fingerprint
        or terminal_worker_id is distinct from params.worker_id
        or terminal_tracker_id is distinct from tracker_id
        or terminal_run_id is distinct from run_id then 'integrity_identity'
      when claim_agency_code is distinct from agency_code
        or terminal_agency_code is distinct from agency_code then 'integrity_agency'
      when not (claim_event_id < terminal_event_id and claim_at <= run_started_at
        and run_started_at <= terminal_at) then 'integrity_order'
      when terminal_type = 'tracker_committed' and terminal_checked_count = 300
        and error_code is null and snapshot_count = 1 and strict_snapshot_count = 1
        and materialized_snapshot_count = 1 then 'success'
      when terminal_type = 'job_failed' and error_code ~ '^[a-z0-9_:-]{3,80}$'
        and snapshot_count = 0 then 'failure'
      else 'integrity_terminal'
    end as verdict
  from evidence cross join params
),
partitioned as (
  select agency_code, count(*)::integer as tracker_count,
    count(*) filter (where claim_event_id is not null)::integer as claimed_count,
    count(*) filter (where terminal_event_id is not null)::integer as first_terminal_count,
    count(*) filter (where verdict = 'success')::integer as success_count,
    count(*) filter (where verdict = 'failure')::integer as failure_count,
    count(*) filter (where verdict like 'integrity_%')::integer as integrity_count,
    count(*) filter (where verdict = 'open')::integer as open_count,
    count(*) filter (where verdict = 'unclaimed')::integer as unclaimed_count,
    count(*) filter (where last_checked_at is null or last_checked_at <= params.observed_at - interval '24 hours')::integer as stale_count,
    count(*) filter (where next_check_at is null or next_check_at <= params.observed_at)::integer as due_count,
    count(*) filter (where worker_quarantined_until > params.observed_at)::integer as quarantine_count,
    count(*) filter (where identity_violation)::integer as identity_violation_count,
    count(*) filter (where order_violation)::integer as order_violation_count,
    count(*) filter (where duplicate_violation)::integer as duplicate_violation_count,
    count(*) filter (where agency_mismatch)::integer as agency_mismatch_count,
    pg_catalog.md5(pg_catalog.string_agg(tracker_id::text || ':' || agency_code, ',' order by tracker_id)) as cohort_hash
  from classified cross join params group by agency_code
),
agency_terminal_reasons as (
  select agency_code, pg_catalog.jsonb_object_agg(reason_code, reason_count) as reason_counts
  from (select agency_code, pg_catalog.split_part(error_code, ':', 1) as reason_code,
      count(*)::integer as reason_count
    from classified where error_code ~ '^[a-z0-9_:-]{3,80}$'
    group by agency_code, pg_catalog.split_part(error_code, ':', 1)) as reasons group by agency_code
),
global_terminal_reasons as (
  select coalesce(pg_catalog.jsonb_object_agg(reason_code, reason_count), '{}'::jsonb) as reason_counts
  from (select pg_catalog.split_part(error_code, ':', 1) as reason_code,
      count(*)::integer as reason_count
    from classified where error_code ~ '^[a-z0-9_:-]{3,80}$'
    group by pg_catalog.split_part(error_code, ':', 1)) as reasons
),
global_summary as (
  select count(*)::integer as tracker_count,
    count(*) filter (where claim_event_id is not null)::integer as claimed_count,
    count(*) filter (where terminal_event_id is not null)::integer as first_terminal_count,
    count(*) filter (where verdict = 'success')::integer as success_count,
    count(*) filter (where verdict = 'failure')::integer as failure_count,
    count(*) filter (where verdict like 'integrity_%')::integer as integrity_count,
    count(*) filter (where verdict = 'open')::integer as open_count,
    count(*) filter (where verdict = 'unclaimed')::integer as unclaimed_count,
    count(*) filter (where last_checked_at is null or last_checked_at <= params.observed_at - interval '24 hours')::integer as stale_count,
    count(*) filter (where next_check_at is null or next_check_at <= params.observed_at)::integer as due_count,
    count(*) filter (where worker_quarantined_until > params.observed_at)::integer as quarantine_count,
    count(*) filter (where identity_violation)::integer as identity_violation_count,
    count(*) filter (where order_violation)::integer as order_violation_count,
    count(*) filter (where duplicate_violation)::integer as duplicate_violation_count,
    count(*) filter (where agency_mismatch)::integer as agency_mismatch_count,
    coalesce(pg_catalog.jsonb_object_agg(verdict, verdict_count), '{}'::jsonb) as reason_counts
  from classified cross join params
  left join lateral (select verdict as reason, count(*)::integer as verdict_count
    from classified as reasons where reasons.verdict = classified.verdict group by verdict) as counts on true
),
cycle_summary as (
  select count(*) filter (where event_type = 'cycle_started')::integer as started_count,
    count(*) filter (where event_type = 'cycle_completed')::integer as completed_count,
    count(distinct cycle_id) filter (where event_type = 'cycle_started')::integer
      - count(distinct cycle_id) filter (where event_type = 'cycle_completed')::integer as open_cycle_count
  from public.naver_shopping_scheduler_events cross join params
  where occurred_at >= params.activation_at and occurred_at <= params.observed_at
),
run_intervals as (
  select run.run_id, run.started_at,
    coalesce(max(terminal.terminal_at), params.observed_at) as ended_at
  from public.naver_shopping_worker_runs as run cross join params
  left join terminal_evidence as terminal on terminal.run_id = run.run_id
  where run.started_at >= params.activation_at and run.started_at <= params.observed_at
  group by run.run_id, run.started_at, params.observed_at
),
concurrency as (
  select coalesce(max((select count(*) from run_intervals as other
    where other.started_at <= point.started_at and other.ended_at >= point.started_at)), 0)::integer as max_concurrency
  from run_intervals as point
),
processing as (
  select ((select count(*) from public.naver_rank_trackers as tracker cross join params
      where tracker.status = 'active' and tracker.processing_until > params.observed_at)
    + (select count(*) from public.naver_shopping_rank_lookup_jobs as job cross join params
      where job.status = 'processing' and job.processing_until > params.observed_at))::integer as processing_count
),
lane as (
  select count(*)::integer as lane_count,
    coalesce(bool_and(coordination.primary_worker_id = params.worker_id
      and coordination.primary_seen_at > params.observed_at - interval '3 minutes'
      and coordination.primary_seen_at <= params.observed_at
      and coordination.runtime_version = params.runtime_version
      and coordination.runtime_fingerprint = params.runtime_fingerprint
      and coordination.circuit_state = 'closed' and coordination.circuit_reason is null
      and coordination.cooldown_until is null and coordination.lease_worker_id is null
      and coordination.lease_token is null and coordination.lease_until is null
      and coordination.run_id is null and coordination.current_stage is null
      and coordination.current_page = 0 and coordination.current_job_kind is null
      and coordination.current_tracker_id is null and coordination.current_job_started_at is null
      and coordination.probe_tracker_id is null and coordination.probe_started_at is null), false) as lane_idle,
    coalesce(bool_and(coordination.lease_token is null), false) as lease_token_is_null
  from public.naver_shopping_worker_coordination as coordination cross join params
  where coordination.lane_key = 'global'
),
agency_json as (
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'agencyCode', agency_code, 'cohortHash', cohort_hash, 'trackerCount', tracker_count,
    'claimedCount', claimed_count, 'firstTerminalCount', first_terminal_count,
    'successCount', success_count, 'failureCount', failure_count,
    'integrityCount', integrity_count, 'openCount', open_count,
    'unclaimedCount', unclaimed_count, 'staleCount', stale_count, 'dueCount', due_count,
    'quarantineCount', quarantine_count, 'identityViolationCount', identity_violation_count,
    'orderViolationCount', order_violation_count, 'duplicateViolationCount', duplicate_violation_count,
    'agencyMismatchCount', agency_mismatch_count,
    'terminalReasonCounts', coalesce(reasons.reason_counts, '{}'::jsonb)) order by agency_code), '[]'::jsonb) as partitions
  from partitioned left join agency_terminal_reasons as reasons using (agency_code)
)
select pg_catalog.jsonb_build_object(
  'marker', 'n30_global_account_rank_health_audit_v1',
  'activationAt', params.activation_at, 'observedAt', params.observed_at,
  'cohortHash', cohort_readiness.cohort_hash,
  'mandatoryCohortHash', cohort_readiness.mandatory_cohort_hash,
  'totalCount', cohort_readiness.total_count,
  'mandatoryCount', cohort_readiness.mandatory_count,
  'exactTotalsOk', cohort_readiness.exact_totals_ok,
  'exactCohortOk', cohort_readiness.exact_cohort_ok,
  'global', pg_catalog.to_jsonb(global_summary), 'agencies', agency_json.partitions,
  'terminalReasonCounts', global_terminal_reasons.reason_counts,
  'globalPartitionOk', global_summary.success_count + global_summary.failure_count
    + global_summary.integrity_count + global_summary.open_count + global_summary.unclaimed_count
    = global_summary.tracker_count,
  'cycle', pg_catalog.to_jsonb(cycle_summary),
  'cycleIntegrityOk', cycle_summary.started_count = cycle_summary.completed_count
    and cycle_summary.open_cycle_count = 0,
  'maxConcurrency', concurrency.max_concurrency,
  'processingCount', processing.processing_count, 'laneCount', lane.lane_count,
  'leaseTokenIsNull', lane.lease_token_is_null,
  'fullIdle', lane.lane_count = 1 and lane.lane_idle and processing.processing_count = 0
) as audit
from params cross join cohort_readiness cross join global_summary cross join global_terminal_reasons cross join cycle_summary
cross join concurrency cross join processing cross join lane cross join agency_json;
commit;`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [activationAt, observedAt, worker, runtime, fingerprint, mandatoryAgency, total, mandatory,
    expectedCohortHash, expectedMandatoryCohortHash] = process.argv.slice(2);
  process.stdout.write(`${buildGlobalAccountRankHealthAuditSql({ activationAt, observedAt, worker,
    runtime, fingerprint, mandatoryAgency, mustTotal: Number(total), mustMandatory: Number(mandatory),
    expectedCohortHash, expectedMandatoryCohortHash })}\n`);
}
