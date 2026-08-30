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
target_cycle_start as (
  select event.event_id as started_event_id, event.occurred_at as started_at,
    event.cycle_id, event.cycle_number
  from public.naver_shopping_scheduler_events as event cross join params
  where event.event_type = 'cycle_started'
    and event.cycle_id is not null
    and event.occurred_at >= params.activation_at
    and event.occurred_at <= params.observed_at
  order by event.event_id
  limit 1
),
target_cycle as (
  select started.*,
    completed.event_id as completed_event_id,
    completed.occurred_at as completed_at,
    completed.cycle_number as completed_cycle_number
  from target_cycle_start as started
  left join lateral (
    select event.event_id, event.occurred_at, event.cycle_number
    from public.naver_shopping_scheduler_events as event cross join params
    where event.event_type = 'cycle_completed'
      and event.cycle_id = started.cycle_id
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as completed on true
),
claim_candidates as (
  select cohort.tracker_id, cohort.agency_code, event.event_id as claim_event_id,
    event.occurred_at as claim_at, event.claim_id, event.run_id,
    event.cycle_id as claim_cycle_id, event.cycle_number as claim_cycle_number,
    event.group_fingerprint as claim_group_fingerprint,
    event.priority as claim_priority, event.lease_started_at as claim_lease_started_at,
    event.lease_until as claim_lease_until,
    event.worker_id as claim_worker_id, event.agency_code as claim_agency_code,
    count(*) over (partition by cohort.tracker_id)::integer as claim_count,
    row_number() over (partition by cohort.tracker_id order by event.event_id)::integer as claim_sequence
  from cohort cross join params cross join target_cycle
  join public.naver_shopping_scheduler_events as event
    on event.tracker_id = cohort.tracker_id and event.event_type = 'tracker_claimed'
   and event.cycle_id = target_cycle.cycle_id
   and event.priority in ('new', 'resume', 'normal')
   and event.event_id > target_cycle.started_event_id
   and event.event_id < target_cycle.completed_event_id
   and event.occurred_at >= target_cycle.started_at
   and event.occurred_at <= target_cycle.completed_at
),
first_claim as (
  select * from claim_candidates where claim_sequence = 1
),
claim_provenance as (
  select claim.*,
    grouped.event_id as group_event_id, grouped.occurred_at as group_at,
    grouped.cycle_id as group_cycle_id, grouped.cycle_number as group_cycle_number,
    grouped.run_id as group_run_id, grouped.worker_id as group_worker_id,
    grouped.group_fingerprint, grouped.priority as group_priority,
    grouped.lease_started_at as group_lease_started_at,
    grouped.lease_until as group_lease_until,
    grouped.details ->> 'memberCount' as group_member_count_text,
    coalesce(grouped.group_event_count, 0) as group_event_count,
    roster.event_id as roster_event_id, roster.occurred_at as roster_at,
    roster.cycle_id as roster_cycle_id, roster.cycle_number as roster_cycle_number,
    roster.agency_code as roster_agency_code,
    roster.group_fingerprint as roster_group_fingerprint,
    roster.roster_state, coalesce(roster.roster_count, 0) as roster_count,
    coalesce(members.member_count, 0) as member_count,
    coalesce(members.distinct_member_count, 0) as distinct_member_count,
    coalesce(members.member_identity_or_order_violation_count, 0)
      as member_identity_or_order_violation_count
  from first_claim as claim cross join target_cycle
  left join lateral (
    select event.*, count(*) over ()::integer as group_event_count
    from public.naver_shopping_scheduler_events as event cross join params
    where event.event_type = 'group_claimed'
      and event.claim_id = claim.claim_id
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as grouped on true
  left join lateral (
    select event.*, count(*) over ()::integer as roster_count
    from public.naver_shopping_scheduler_events as event cross join params
    where event.event_type = 'cycle_rostered'
      and event.cycle_id = target_cycle.cycle_id
      and event.tracker_id = claim.tracker_id
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as roster on true
  left join lateral (
    select count(*)::integer as member_count,
      count(distinct event.tracker_id)::integer as distinct_member_count,
      count(*) filter (where event.tracker_id is null
        or event.run_id is distinct from grouped.run_id
        or event.worker_id is distinct from grouped.worker_id
        or event.cycle_id is distinct from grouped.cycle_id
        or event.cycle_number is distinct from grouped.cycle_number
        or event.group_fingerprint is distinct from grouped.group_fingerprint
        or event.priority is distinct from grouped.priority
        or event.lease_started_at is distinct from grouped.lease_started_at
        or event.lease_until is distinct from grouped.lease_until
        or event.lease_started_at is null or event.lease_until is null
        or event.lease_started_at >= event.lease_until
        or (event.lease_started_at <= event.occurred_at
          and event.occurred_at < event.lease_until) is not true
        or event.event_id <= grouped.event_id
        or event.event_id >= target_cycle.completed_event_id
        or event.occurred_at < grouped.occurred_at
        or event.occurred_at > target_cycle.completed_at
        or (select count(*)
          from public.naver_shopping_scheduler_events as member_roster
          where member_roster.event_type = 'cycle_rostered'
            and member_roster.cycle_id = target_cycle.cycle_id
            and member_roster.tracker_id = event.tracker_id
            and member_roster.agency_code is not distinct from event.agency_code
            and member_roster.group_fingerprint is not distinct from event.group_fingerprint
            and member_roster.roster_state = 'eligible'
            and member_roster.event_id > target_cycle.started_event_id
            and member_roster.event_id < grouped.event_id
            and member_roster.occurred_at >= target_cycle.started_at
            and member_roster.occurred_at <= grouped.occurred_at) <> 1)::integer
        as member_identity_or_order_violation_count
    from public.naver_shopping_scheduler_events as event cross join params
    where event.event_type = 'tracker_claimed'
      and event.claim_id = claim.claim_id
      and event.occurred_at <= params.observed_at
  ) as members on true
),
cycle_claim_scope_summary as (
  select count(*) filter (where event.event_id is not null and not exists (
    select 1 from cohort where cohort.tracker_id = event.tracker_id
  ))::integer as out_of_cohort_claim_count
  from target_cycle
  left join public.naver_shopping_scheduler_events as event
    on event.event_type = 'tracker_claimed'
   and event.cycle_id = target_cycle.cycle_id
   and event.priority in ('new', 'resume', 'normal')
   and event.event_id > target_cycle.started_event_id
   and event.event_id < target_cycle.completed_event_id
   and event.occurred_at >= target_cycle.started_at
   and event.occurred_at <= target_cycle.completed_at
),
terminal_evidence as (
  select claim.*,
    terminal.event_id as terminal_event_id, terminal.occurred_at as terminal_at,
    terminal.event_type as terminal_type, terminal.tracker_id as terminal_tracker_id,
    terminal.run_id as terminal_run_id, terminal.worker_id as terminal_worker_id,
    terminal.cycle_id as terminal_cycle_id, terminal.cycle_number as terminal_cycle_number,
    terminal.group_fingerprint as terminal_group_fingerprint,
    terminal.priority as terminal_priority,
    terminal.lease_started_at as terminal_lease_started_at,
    terminal.lease_until as terminal_lease_until,
    terminal.agency_code as terminal_agency_code, terminal.error_code,
    terminal.checked_count as terminal_checked_count,
    terminal.collection_id as terminal_collection_id,
    terminal.terminal_count
  from claim_provenance as claim
  left join lateral (
    select event.*,
      count(*) over ()::integer as terminal_count
    from public.naver_shopping_scheduler_events as event cross join params
    where event.claim_id = claim.claim_id
      and event.tracker_id = claim.tracker_id
      and event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as terminal on true
),
evidence as (
  select cohort.*, target_cycle.started_event_id, target_cycle.started_at,
    target_cycle.cycle_id as selected_cycle_id, target_cycle.cycle_number as selected_cycle_number,
    target_cycle.completed_event_id, target_cycle.completed_at,
    target_cycle.completed_cycle_number,
    claim.claim_event_id, claim.claim_at, claim.claim_id, claim.run_id,
    claim.claim_cycle_id, claim.claim_cycle_number, claim.claim_group_fingerprint,
    claim.claim_priority, claim.claim_lease_started_at, claim.claim_lease_until,
    claim.claim_worker_id, claim.claim_agency_code, coalesce(claim.claim_count, 0) as claim_count,
    claim.group_event_id, claim.group_at, claim.group_cycle_id, claim.group_cycle_number,
    claim.group_run_id, claim.group_worker_id, claim.group_fingerprint, claim.group_priority,
    claim.group_lease_started_at, claim.group_lease_until, claim.group_member_count_text,
    claim.group_event_count, claim.roster_event_id, claim.roster_at, claim.roster_cycle_id,
    claim.roster_cycle_number, claim.roster_agency_code, claim.roster_group_fingerprint,
    claim.roster_state, claim.roster_count, claim.member_count, claim.distinct_member_count,
    claim.member_identity_or_order_violation_count,
    claim.terminal_event_id, claim.terminal_at, claim.terminal_type,
    claim.terminal_tracker_id, claim.terminal_run_id, claim.terminal_worker_id,
    claim.terminal_cycle_id, claim.terminal_cycle_number, claim.terminal_group_fingerprint,
    claim.terminal_priority, claim.terminal_lease_started_at, claim.terminal_lease_until,
    claim.terminal_agency_code, claim.error_code, claim.terminal_checked_count,
    claim.terminal_collection_id, coalesce(claim.terminal_count, 0) as terminal_count,
    run.started_at as run_started_at, run.worker_id as run_worker_id,
    run.run_trigger, run.runtime_version, run.runtime_fingerprint,
    coalesce(snapshot.snapshot_count, 0) as snapshot_count,
    coalesce(snapshot.strict_snapshot_count, 0) as strict_snapshot_count,
    coalesce(current_snapshot.current_snapshot_count, 0) as current_snapshot_count,
    coalesce(current_snapshot.current_strict_snapshot_count, 0) as current_strict_snapshot_count,
    coalesce(current_snapshot.current_materialized_snapshot_count, 0)
      as current_materialized_snapshot_count
  from cohort
  left join target_cycle on true
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
      )::integer as strict_snapshot_count
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = cohort.tracker_id
      and snapshot.checked_at = claim.terminal_at
  ) as snapshot on true
  left join lateral (
    select count(*)::integer as current_snapshot_count,
      count(*) filter (where current.checked_count = 300
        and current.source = 'naver_shopping_results_collector'
        and current.item ->> 'collectionId' = current.collection_id
        and current.item ->> 'source' = 'naver_shopping_results_collector'
        and current.item -> 'adExcluded' = 'true'::jsonb
        and current.item ->> 'rankPolicy' = 'organic_only'
        and ((current.matched is false and current.rank is null)
          or (current.matched is true and current.rank between 1 and 300
            and current.item -> 'isOrganic' = 'true'::jsonb
            and current.item -> 'isAd' = 'false'::jsonb))
        and pg_catalog.jsonb_typeof(current.top_items) = 'array'
        and pg_catalog.jsonb_array_length(current.top_items) between 1 and 100
        and not exists (select 1 from pg_catalog.jsonb_array_elements(current.top_items) as top(item)
          where top.item -> 'isOrganic' is distinct from 'true'::jsonb
             or top.item -> 'isAd' is distinct from 'false'::jsonb)
      )::integer as current_strict_snapshot_count,
      count(*) filter (where cohort.last_checked_at >= claim.terminal_at
        and ((current.matched is false and cohort.current_rank is null)
          or (current.matched is true and cohort.current_rank = current.rank)))::integer
        as current_materialized_snapshot_count
    from public.naver_rank_snapshots as current
    where current.tracker_id = cohort.tracker_id
      and current.checked_at = cohort.last_checked_at
  ) as current_snapshot on true
),
classified as (
  select evidence.*,
    (claim_event_id is not null and (group_event_count <> 1 or roster_count <> 1
      or member_count < 1 or distinct_member_count <> member_count
      or member_identity_or_order_violation_count <> 0
      or case when group_member_count_text ~ '^[1-9][0-9]{0,5}$'
        then group_member_count_text::integer <> member_count else true end
      or roster_state is distinct from 'eligible'
      or group_lease_started_at is null or group_lease_until is null
      or group_lease_started_at >= group_lease_until
      or (group_lease_started_at <= group_at and group_at < group_lease_until) is not true
      or claim_lease_started_at is null or claim_lease_until is null
      or claim_lease_started_at >= claim_lease_until
      or (claim_lease_started_at <= claim_at and claim_at < claim_lease_until) is not true
      or group_cycle_id is distinct from selected_cycle_id
      or group_cycle_number is distinct from selected_cycle_number
      or group_run_id is distinct from run_id
      or group_worker_id is distinct from claim_worker_id
      or group_fingerprint is null
      or group_fingerprint is distinct from claim_group_fingerprint
      or group_priority is distinct from claim_priority
      or group_lease_started_at is distinct from claim_lease_started_at
      or group_lease_until is distinct from claim_lease_until
      or roster_cycle_id is distinct from selected_cycle_id
      or roster_cycle_number is distinct from selected_cycle_number
      or roster_agency_code is distinct from agency_code
      or roster_group_fingerprint is distinct from group_fingerprint
      or not (started_event_id < roster_event_id and roster_event_id < group_event_id
        and group_event_id < claim_event_id and claim_event_id < completed_event_id
        and started_at <= roster_at and roster_at <= group_at
        and group_at <= claim_at and claim_at <= completed_at))) as provenance_violation,
    (claim_event_id is not null and (claim_worker_id is distinct from params.worker_id
      or run_worker_id is distinct from params.worker_id
      or run_trigger is distinct from 'rank-catch-up'
      or evidence.runtime_version is distinct from params.runtime_version
      or evidence.runtime_fingerprint is distinct from params.runtime_fingerprint
      or terminal_worker_id is distinct from params.worker_id
      or terminal_tracker_id is distinct from tracker_id
      or terminal_run_id is distinct from run_id
      or terminal_cycle_id is distinct from claim_cycle_id
      or terminal_cycle_number is distinct from claim_cycle_number
      or terminal_group_fingerprint is distinct from claim_group_fingerprint
      or terminal_priority is distinct from claim_priority
      or terminal_lease_started_at is distinct from claim_lease_started_at
      or terminal_lease_until is distinct from claim_lease_until
      or terminal_lease_started_at is null or terminal_lease_until is null
      or terminal_lease_started_at >= terminal_lease_until)) as identity_violation,
    (claim_event_id is not null and (terminal_event_id is not null)
      and not (claim_event_id < terminal_event_id and terminal_event_id < completed_event_id
        and claim_at <= run_started_at and run_started_at <= terminal_at
        and terminal_at <= completed_at
        and claim_lease_started_at <= run_started_at and run_started_at < claim_lease_until
        and terminal_lease_started_at <= terminal_at
        and terminal_at < terminal_lease_until)) as order_violation,
    (claim_count > 1 or terminal_count > 1) as duplicate_violation,
    (claim_event_id is not null and (claim_agency_code is distinct from agency_code
      or (terminal_event_id is not null and terminal_agency_code is distinct from agency_code)))
      as agency_mismatch,
    case
      when claim_event_id is null then 'unclaimed'
      when terminal_event_id is null then 'open'
      when claim_count > 1 or terminal_count > 1 then 'integrity_duplicate'
      when group_event_count <> 1 or roster_count <> 1
        or member_count < 1 or distinct_member_count <> member_count
        or member_identity_or_order_violation_count <> 0
        or case when group_member_count_text ~ '^[1-9][0-9]{0,5}$'
          then group_member_count_text::integer <> member_count else true end
        or roster_state is distinct from 'eligible'
        or group_lease_started_at is null or group_lease_until is null
        or group_lease_started_at >= group_lease_until
        or (group_lease_started_at <= group_at and group_at < group_lease_until) is not true
        or claim_lease_started_at is null or claim_lease_until is null
        or claim_lease_started_at >= claim_lease_until
        or (claim_lease_started_at <= claim_at and claim_at < claim_lease_until) is not true
        or group_cycle_id is distinct from selected_cycle_id
        or group_cycle_number is distinct from selected_cycle_number
        or group_run_id is distinct from run_id
        or group_worker_id is distinct from claim_worker_id
        or group_fingerprint is null
        or group_fingerprint is distinct from claim_group_fingerprint
        or group_priority is distinct from claim_priority
        or group_lease_started_at is distinct from claim_lease_started_at
        or group_lease_until is distinct from claim_lease_until
        or roster_cycle_id is distinct from selected_cycle_id
        or roster_cycle_number is distinct from selected_cycle_number
        or roster_agency_code is distinct from agency_code
        or roster_group_fingerprint is distinct from group_fingerprint
        or not (started_event_id < roster_event_id and roster_event_id < group_event_id
          and group_event_id < claim_event_id and claim_event_id < completed_event_id
          and started_at <= roster_at and roster_at <= group_at
          and group_at <= claim_at and claim_at <= completed_at) then 'integrity_provenance'
      when claim_worker_id is distinct from params.worker_id
        or run_worker_id is distinct from params.worker_id
        or run_trigger is distinct from 'rank-catch-up'
        or evidence.runtime_version is distinct from params.runtime_version
        or evidence.runtime_fingerprint is distinct from params.runtime_fingerprint
        or terminal_worker_id is distinct from params.worker_id
        or terminal_tracker_id is distinct from tracker_id
        or terminal_run_id is distinct from run_id
        or terminal_cycle_id is distinct from claim_cycle_id
        or terminal_cycle_number is distinct from claim_cycle_number
        or terminal_group_fingerprint is distinct from claim_group_fingerprint
        or terminal_priority is distinct from claim_priority
        or terminal_lease_started_at is distinct from claim_lease_started_at
        or terminal_lease_until is distinct from claim_lease_until
        or terminal_lease_started_at is null or terminal_lease_until is null
        or terminal_lease_started_at >= terminal_lease_until then 'integrity_identity'
      when claim_agency_code is distinct from agency_code
        or terminal_agency_code is distinct from agency_code then 'integrity_agency'
      when not (claim_event_id < terminal_event_id and terminal_event_id < completed_event_id
        and claim_at <= run_started_at and run_started_at <= terminal_at
        and terminal_at <= completed_at
        and claim_lease_started_at <= run_started_at and run_started_at < claim_lease_until
        and terminal_lease_started_at <= terminal_at
        and terminal_at < terminal_lease_until) then 'integrity_order'
      when terminal_type = 'tracker_committed' and terminal_checked_count = 300
        and error_code is null and snapshot_count = 1 and strict_snapshot_count = 1
        and current_snapshot_count = 1 and current_strict_snapshot_count = 1
        and current_materialized_snapshot_count = 1 then 'success'
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
    count(*) filter (where provenance_violation)::integer as provenance_violation_count,
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
    count(*) filter (where provenance_violation)::integer as provenance_violation_count,
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
  select count(*) filter (where event.event_type = 'cycle_started')::integer as started_count,
    count(*) filter (where event.event_type = 'cycle_completed')::integer as completed_count,
    (count(*) filter (where event.event_type = 'cycle_started')
      - count(*) filter (where event.event_type = 'cycle_completed'))::integer as open_cycle_count,
    min(event.event_id) filter (where event.event_type = 'cycle_started') as started_event_id,
    min(event.event_id) filter (where event.event_type = 'cycle_completed') as completed_event_id,
    min(event.occurred_at) filter (where event.event_type = 'cycle_started') as started_at,
    min(event.occurred_at) filter (where event.event_type = 'cycle_completed') as completed_at,
    coalesce(count(*) filter (where event.event_type = 'cycle_started') = 1
      and count(*) filter (where event.event_type = 'cycle_completed') = 1
      and min(event.event_id) filter (where event.event_type = 'cycle_started')
        < min(event.event_id) filter (where event.event_type = 'cycle_completed')
      and min(event.occurred_at) filter (where event.event_type = 'cycle_started')
        <= min(event.occurred_at) filter (where event.event_type = 'cycle_completed'), false)
      as cycle_order_ok
  from target_cycle
  left join public.naver_shopping_scheduler_events as event
    on event.cycle_id = target_cycle.cycle_id
   and event.event_type in ('cycle_started', 'cycle_completed')
   and event.occurred_at <= (select observed_at from params)
),
cycle_group_release_evidence as (
  select grouped.event_id as group_event_id, grouped.occurred_at as group_at,
    grouped.claim_id, grouped.run_id,
    next_group.event_id as next_group_event_id, next_group.occurred_at as next_group_at,
    coalesce(members.claim_count, 0) as claim_count,
    coalesce(members.terminal_count, 0) as terminal_count,
    members.last_terminal_event_id, members.last_terminal_at,
    target_cycle.completed_event_id, target_cycle.completed_at
  from target_cycle
  join public.naver_shopping_scheduler_events as grouped
    on grouped.event_type = 'group_claimed'
   and grouped.cycle_id = target_cycle.cycle_id
   and grouped.event_id > target_cycle.started_event_id
   and grouped.event_id < target_cycle.completed_event_id
   and grouped.occurred_at >= target_cycle.started_at
   and grouped.occurred_at <= target_cycle.completed_at
  left join lateral (
    select event.event_id, event.occurred_at
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'group_claimed'
      and event.cycle_id = target_cycle.cycle_id
      and event.event_id > grouped.event_id
      and event.event_id < target_cycle.completed_event_id
      and event.occurred_at <= target_cycle.completed_at
    order by event.event_id
    limit 1
  ) as next_group on true
  left join lateral (
    select count(*) filter (where event.event_type = 'tracker_claimed')::integer as claim_count,
      count(*) filter (where event.event_type in (
        'tracker_committed', 'finite_window_committed', 'job_failed'))::integer as terminal_count,
      max(event.event_id) filter (where event.event_type in (
        'tracker_committed', 'finite_window_committed', 'job_failed')) as last_terminal_event_id,
      max(event.occurred_at) filter (where event.event_type in (
        'tracker_committed', 'finite_window_committed', 'job_failed')) as last_terminal_at
    from public.naver_shopping_scheduler_events as event cross join params
    where event.claim_id = grouped.claim_id and event.occurred_at <= params.observed_at
  ) as members on true
),
group_release_summary as (
  select count(*)::integer as group_count,
    count(*) filter (where claim_count < 1 or terminal_count <> claim_count
      or last_terminal_event_id is null or last_terminal_at is null
      or last_terminal_event_id >= coalesce(next_group_event_id, completed_event_id)
      or last_terminal_at > coalesce(next_group_at, completed_at))::integer
      as release_order_violation_count
  from cycle_group_release_evidence
),
all_run_evidence as (
  select run.run_id, run.run_trigger, run.started_at,
    max(event.occurred_at) filter (where event.event_type in (
      'tracker_committed', 'finite_window_committed', 'job_failed')) as last_terminal_at,
    count(*) filter (where event.event_type = 'tracker_claimed')::integer
      as all_tracker_claim_count,
    count(*) filter (where event.event_type in (
      'tracker_committed', 'finite_window_committed', 'job_failed'))::integer
      as all_terminal_count,
    count(*) filter (where event.event_type = 'tracker_claimed'
      and event.cycle_id = target_cycle.cycle_id
      and event.event_id > target_cycle.started_event_id
      and event.event_id < target_cycle.completed_event_id
      and event.occurred_at >= target_cycle.started_at
      and event.occurred_at <= target_cycle.completed_at)::integer as tracker_claim_count,
    count(*) filter (where event.event_type in (
      'tracker_committed', 'finite_window_committed', 'job_failed')
      and event.cycle_id = target_cycle.cycle_id
      and event.event_id > target_cycle.started_event_id
      and event.event_id < target_cycle.completed_event_id
      and event.occurred_at >= target_cycle.started_at
      and event.occurred_at <= target_cycle.completed_at)::integer as terminal_count,
    count(*) filter (where event.event_type = 'group_claimed'
      and event.cycle_id = target_cycle.cycle_id
      and event.event_id > target_cycle.started_event_id
      and event.event_id < target_cycle.completed_event_id
      and event.occurred_at >= target_cycle.started_at
      and event.occurred_at <= target_cycle.completed_at)::integer as target_group_count,
    target_cycle.started_at as cycle_started_at,
    target_cycle.completed_at as cycle_completed_at, params.observed_at
  from public.naver_shopping_worker_runs as run cross join target_cycle cross join params
  left join public.naver_shopping_scheduler_events as event
    on event.run_id = run.run_id and event.occurred_at <= params.observed_at
  where target_cycle.completed_at is not null
    and run.started_at <= target_cycle.completed_at
  group by run.run_id, run.run_trigger, run.started_at, target_cycle.started_at,
    target_cycle.completed_at, params.observed_at
  having run.started_at >= target_cycle.started_at
    or coalesce(bool_or(event.event_type = 'group_claimed'
      and event.cycle_id = target_cycle.cycle_id
      and event.event_id > target_cycle.started_event_id
      and event.event_id < target_cycle.completed_event_id
      and event.occurred_at >= target_cycle.started_at
      and event.occurred_at <= target_cycle.completed_at
      and event.lease_until >= target_cycle.started_at), false)
    or coalesce(max(event.occurred_at) filter (where event.event_type in (
      'tracker_committed', 'finite_window_committed', 'job_failed')) >= target_cycle.started_at, false)
),
run_intervals as (
  select run_id, run_trigger,
    greatest(started_at, cycle_started_at) as started_at,
    least(case when all_tracker_claim_count > 0
      and all_terminal_count = all_tracker_claim_count
      then last_terminal_at else observed_at end, cycle_completed_at) as ended_at,
    tracker_claim_count, terminal_count, target_group_count
  from all_run_evidence
  where case when all_tracker_claim_count > 0
    and all_terminal_count = all_tracker_claim_count
    then last_terminal_at else observed_at end >= cycle_started_at
),
concurrency as (
  select coalesce(max((select count(*) from run_intervals as other
    where other.started_at <= point.started_at and other.ended_at > point.started_at)), 0)::integer
      as max_concurrency,
    count(*)::integer as overlapping_run_count,
    count(*) filter (where run_trigger <> 'rank-catch-up')::integer as non_catch_up_run_count,
    count(*) filter (where tracker_claim_count <> terminal_count)::integer as incomplete_run_count,
    count(*) filter (where target_group_count <> 1)::integer as unattested_run_count
  from run_intervals as point
),
cycle_boundary_summary as (
  select count(*)::integer as boundary_violation_event_count,
    count(distinct coalesce(event.run_id::text,
      'missing-run:' || event.event_id::text))::integer as boundary_violation_run_count
  from target_cycle cross join params
  join public.naver_shopping_scheduler_events as event
    on event.cycle_id = target_cycle.cycle_id
   and event.event_type in ('group_claimed', 'tracker_claimed',
     'tracker_committed', 'finite_window_committed', 'job_failed')
   and event.occurred_at <= params.observed_at
  where not (event.event_id > target_cycle.started_event_id
    and event.event_id < target_cycle.completed_event_id
    and event.occurred_at >= target_cycle.started_at
    and event.occurred_at <= target_cycle.completed_at)
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
    'quarantineCount', quarantine_count, 'provenanceViolationCount', provenance_violation_count,
    'identityViolationCount', identity_violation_count,
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
  'outOfCohortClaimCount', cycle_claim_scope_summary.out_of_cohort_claim_count,
  'cycleIntegrityOk', cycle_summary.started_count = 1
    and cycle_summary.completed_count = 1 and cycle_summary.open_cycle_count = 0
    and cycle_summary.cycle_order_ok
    and cycle_claim_scope_summary.out_of_cohort_claim_count = 0,
  'maxConcurrency', concurrency.max_concurrency,
  'overlappingRunCount', concurrency.overlapping_run_count,
  'nonCatchUpRunCount', concurrency.non_catch_up_run_count,
  'incompleteRunCount', concurrency.incomplete_run_count,
  'unattestedRunCount', concurrency.unattested_run_count,
  'boundaryViolationEventCount', cycle_boundary_summary.boundary_violation_event_count,
  'boundaryViolationRunCount', cycle_boundary_summary.boundary_violation_run_count,
  'terminalLaneReleaseOrderOk', group_release_summary.group_count > 0
    and group_release_summary.release_order_violation_count = 0,
  'releaseBoundary', 'terminal_order_plus_observed_idle_not_release_timestamp',
  'historicalConcurrencyAttested', concurrency.max_concurrency <= 1
    and concurrency.non_catch_up_run_count = 0
    and concurrency.incomplete_run_count = 0 and concurrency.unattested_run_count = 0
    and cycle_boundary_summary.boundary_violation_run_count = 0
    and group_release_summary.group_count > 0
    and group_release_summary.release_order_violation_count = 0
    and lane.lane_count = 1 and lane.lane_idle and processing.processing_count = 0,
  'processingCount', processing.processing_count, 'laneCount', lane.lane_count,
  'leaseTokenIsNull', lane.lease_token_is_null,
  'fullIdle', lane.lane_count = 1 and lane.lane_idle and processing.processing_count = 0
) as audit
from params cross join cohort_readiness cross join global_summary cross join global_terminal_reasons cross join cycle_summary
cross join cycle_claim_scope_summary cross join group_release_summary cross join concurrency
cross join cycle_boundary_summary
cross join processing cross join lane cross join agency_json;
commit;`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [activationAt, observedAt, worker, runtime, fingerprint, mandatoryAgency, total, mandatory,
    expectedCohortHash, expectedMandatoryCohortHash] = process.argv.slice(2);
  process.stdout.write(`${buildGlobalAccountRankHealthAuditSql({ activationAt, observedAt, worker,
    runtime, fingerprint, mandatoryAgency, mustTotal: Number(total), mustMandatory: Number(mandatory),
    expectedCohortHash, expectedMandatoryCohortHash })}\n`);
}
