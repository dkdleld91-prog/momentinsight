import { pathToFileURL } from "node:url";

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

export const N30_PARENT_CANARY_RELEASE_AUDIT = Object.freeze({
  marker: "n30_parent_canary_release_audit_v2",
  releaseCommit: "f96a83b2bbc5835cde2997c30beaf100c5ceab3a",
  recoveryMigrationVersion: "20260828035245",
  recoveryCommit: "b4e341d057f6dfc7104219907366ec689bea8137",
  workerId: "windows-desktop-primary",
  runtimeVersion: "1.1.16",
  runtimeFingerprint: "9680164f90965609896b72c05b09e67946bc51d1df44c76d0cb5b9e5f0085478",
  trackerId: "c0ccded2-9bf7-488e-af8d-00898c0a1ff8",
  normalizedKeyword: "아이쉘차량용거치대",
  sellerProductId: "13327339525",
  parentCatalogId: "59776958987",
  proofVersion: "stable-finite-window-v1",
  releaseEvidenceAt: "2026-08-28T03:57:48.469739Z",
  preGateQuarantinedUntil: "2026-08-28T08:03:53.577688Z",
  scheduledAnchorAt: "2026-08-28T03:57:48.469739Z",
  preGateControlStabilityStartedAt: "2026-08-28T03:47:48.550280Z",
  preGateState: Object.freeze({
    currentRank: null,
    lastCheckedAt: null,
    checkCount: 0,
    foundCount: 0,
    retryCount: 11,
    lastError: "provider_partial_window:100_300",
    snapshotCount: 0,
  }),
});

function requireObservedAt(value) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("observedAt must be an ISO-8601 UTC timestamp");
  }
  return value;
}

export function buildN30ParentCanaryReleaseAuditSql(options = {}) {
  const observedAt = requireObservedAt(options.observedAt);
  const contract = N30_PARENT_CANARY_RELEASE_AUDIT;

  return `begin transaction isolation level repeatable read read only;
select pg_catalog.set_config(
  'n30.recovery_migration_count',
  (select count(*)::text
   from supabase_migrations.schema_migrations migration
   where migration.version = '${contract.recoveryMigrationVersion}'),
  true
);
select pg_catalog.set_config(
  'n30.exact_parent_guard',
  (
    with guard_function as (
      select
        procedure_row.oid,
        procedure_row.prosecdef,
        procedure_row.proconfig,
        pg_catalog.pg_get_functiondef(procedure_row.oid) as definition
      from pg_catalog.pg_proc procedure_row
      join pg_catalog.pg_namespace namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'mi_internal'
        and procedure_row.proname = 'mi_guard_naver_shopping_exact_parent_snapshot'
        and procedure_row.pronargs = 0
    ),
    guard_trigger as (
      select count(*)::integer as trigger_count
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_class relation_row on relation_row.oid = trigger_row.tgrelid
      join pg_catalog.pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
      join guard_function procedure_row on procedure_row.oid = trigger_row.tgfoid
      where namespace_row.nspname = 'public'
        and relation_row.relname = 'naver_rank_snapshots'
        and trigger_row.tgname = 'naver_shopping_exact_parent_relation_guard'
        and trigger_row.tgtype = 23
        and trigger_row.tgenabled <> 'D'
        and not trigger_row.tgisinternal
    )
    select pg_catalog.jsonb_build_object(
      'functionCount', (select count(*)::integer from guard_function),
      'functionIntegrity', coalesce((select pg_catalog.bool_and(
        procedure_row.prosecdef = false
        and procedure_row.proconfig @> array['search_path=""']::text[]
        and pg_catalog.has_function_privilege('service_role', procedure_row.oid, 'EXECUTE') = false
        and pg_catalog.strpos(procedure_row.definition, 'relatedCatalogRelationBasis') > 0
        and pg_catalog.strpos(procedure_row.definition, 'catalogSellerProductIds') > 0
        and pg_catalog.strpos(procedure_row.definition, 'catalog_seller_product_id') > 0
        and pg_catalog.strpos(procedure_row.definition, 'pg_catalog.nullif') = 0
        and pg_catalog.strpos(procedure_row.definition, 'pg_catalog.coalesce') = 0
      ) from guard_function procedure_row), false),
      'triggerCount', (select trigger_count from guard_trigger)
    )::text
  ),
  true
);
set local role service_role;
with
base_params as (
  select
    '${observedAt}'::timestamptz as observed_at,
    '${contract.releaseEvidenceAt}'::timestamptz as release_evidence_at,
    '${contract.preGateQuarantinedUntil}'::timestamptz as pre_gate_quarantined_until,
    '${contract.scheduledAnchorAt}'::timestamptz as scheduled_anchor_at,
    '${contract.preGateControlStabilityStartedAt}'::timestamptz as pre_gate_stability_started_at,
    null::integer as pre_gate_current_rank,
    null::timestamptz as pre_gate_last_checked_at,
    ${contract.preGateState.checkCount}::integer as pre_gate_check_count,
    ${contract.preGateState.foundCount}::integer as pre_gate_found_count,
    ${contract.preGateState.retryCount}::integer as pre_gate_retry_count,
    '${contract.preGateState.lastError}'::text as pre_gate_last_error,
    ${contract.preGateState.snapshotCount}::integer as pre_gate_snapshot_count,
    '${contract.recoveryMigrationVersion}'::text as recovery_migration_version,
    pg_catalog.current_setting('n30.recovery_migration_count', true)::integer
      as recovery_migration_count,
    '${contract.workerId}'::text as worker_id,
    '${contract.runtimeVersion}'::text as runtime_version,
    '${contract.runtimeFingerprint}'::text as runtime_fingerprint,
    '${contract.trackerId}'::uuid as tracker_id,
    '${contract.normalizedKeyword}'::text as normalized_keyword,
    '${contract.sellerProductId}'::text as seller_product_id,
    '${contract.parentCatalogId}'::text as parent_catalog_id,
    '${contract.proofVersion}'::text as proof_version
),
eligibility_params as (
  select
    base_params.*,
    greatest(release_evidence_at, pre_gate_quarantined_until) as eligible_at
  from base_params
),
params as (
  select
    eligibility_params.*,
    eligible_at + interval '24 hours' as claim_deadline_at
  from eligibility_params
),
target_contract as (
  select
    count(*)::integer as exact_target_count,
    min(tracker.current_rank) as target_current_rank,
    min(tracker.last_checked_at) as target_last_checked_at,
    min(tracker.check_count)::integer as target_check_count,
    min(tracker.found_count)::integer as target_found_count,
    min(tracker.retry_count)::integer as target_retry_count,
    min(tracker.last_error) as target_last_error,
    min(tracker.worker_quarantined_until) as target_quarantined_until,
    min(snapshot_count.snapshot_count)::integer as target_snapshot_count
  from params p
  join public.naver_shopping_finite_window_targets target
    on target.tracker_id = p.tracker_id
   and target.seller_product_id = p.seller_product_id
   and target.parent_catalog_id = p.parent_catalog_id
   and target.normalized_keyword = p.normalized_keyword
   and target.proof_version = p.proof_version
   and target.runtime_version = p.runtime_version
   and target.runtime_fingerprint = p.runtime_fingerprint
   and target.enabled = true
  join public.naver_rank_trackers tracker
    on tracker.id = target.tracker_id
   and tracker.status = 'active'
   and tracker.product_id = target.seller_product_id
   and pg_catalog.regexp_replace(
     pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\\s+', '', 'g'
   ) = target.normalized_keyword
  cross join lateral (
    select count(*)::integer as snapshot_count
    from public.naver_rank_snapshots snapshot
    where snapshot.tracker_id = tracker.id
  ) snapshot_count
),
exact_parent_guard as (
  select
    p.recovery_migration_count::integer as migration_count,
    coalesce((guard.payload ->> 'functionCount')::integer, 0) as function_count,
    coalesce((guard.payload ->> 'functionIntegrity')::boolean, false) as function_integrity,
    coalesce((guard.payload ->> 'triggerCount')::integer, 0) as trigger_count
  from params p
  cross join lateral (
    select pg_catalog.current_setting('n30.exact_parent_guard', true)::jsonb as payload
  ) guard
),
control_plane as (
  select
    count(*)::integer as control_row_count,
    coalesce(pg_catalog.bool_and(
      coordination.cadence_mode = 'baseline'
      and coordination.cadence_minutes = 10
      and coordination.primary_worker_id = p.worker_id
      and coordination.primary_seen_at > p.observed_at - interval '3 minutes'
      and coordination.runtime_version = p.runtime_version
      and coordination.runtime_fingerprint = p.runtime_fingerprint
      and coordination.circuit_state = 'closed'
      and coordination.circuit_reason is null
      and coordination.cooldown_until is null
      and coordination.stability_started_at is not distinct from p.pre_gate_stability_started_at
      and coordination.last_success_at >= p.scheduled_anchor_at
      and coordination.last_collection_id ~ '^pw-chrome-'
      and coordination.last_checked_count = 300
      and coordination.last_source = 'naver_shopping_results_collector'
    ), false) as control_integrity,
    coalesce(pg_catalog.bool_and(
      coordination.lease_worker_id is null
      and coordination.lease_token is null
      and coordination.lease_until is null
      and coordination.run_id is null
      and coordination.current_stage is null
      and coordination.current_page = 0
      and coordination.current_job_kind is null
      and coordination.current_tracker_id is null
      and coordination.current_job_started_at is null
      and coordination.probe_tracker_id is null
      and coordination.probe_started_at is null
    ), false) as coordination_lane_idle,
    min(coordination.success_streak)::integer as success_streak,
    min(coordination.last_success_at) as last_success_at,
    min(coordination.last_collection_id) as last_collection_id,
    ((select count(*) from public.naver_shopping_rank_lookup_jobs job, params p2
       where job.status = 'processing' and job.processing_until > p2.observed_at)
     +
     (select count(*) from public.naver_rank_trackers tracker, params p2
       where tracker.status = 'active' and tracker.processing_until > p2.observed_at)
    )::integer as processing_count
  from public.naver_shopping_worker_coordination coordination
  cross join params p
  where coordination.lane_key = 'global'
),
premature_claims as (
  select count(*)::integer as premature_claim_count
  from public.naver_shopping_scheduler_events event
  cross join params p
  where event.event_type = 'tracker_claimed'
    and event.tracker_id = p.tracker_id
    and event.occurred_at >= p.release_evidence_at
    and event.occurred_at < p.eligible_at
),
first_claim as (
  select event.*
  from public.naver_shopping_scheduler_events event
  cross join params p
  where event.event_type = 'tracker_claimed'
    and event.tracker_id = p.tracker_id
    and event.occurred_at >= p.eligible_at
    and event.occurred_at <= p.observed_at
  order by event.event_id
  limit 1
),
claim_context as (
  select
    p.*,
    claim.event_id as claim_event_id,
    claim.occurred_at as claim_at,
    claim.claim_id,
    claim.run_id,
    claim.worker_id as claim_worker_id,
    claim.cycle_id as claim_cycle_id,
    claim.cycle_number as claim_cycle_number,
    claim.group_fingerprint as claim_group_fingerprint,
    claim.priority as claim_priority,
    claim.lease_started_at as claim_lease_started_at,
    claim.lease_until as claim_lease_until,
    run.worker_id as run_worker_id,
    run.run_trigger,
    run.runtime_version as run_runtime_version,
    run.runtime_fingerprint as run_runtime_fingerprint,
    run.started_at as run_started_at,
    grouped.event_id as group_event_id,
    grouped.occurred_at as group_at,
    grouped.worker_id as group_worker_id,
    grouped.cycle_id as group_cycle_id,
    grouped.cycle_number as group_cycle_number,
    grouped.group_fingerprint,
    grouped.priority as group_priority,
    grouped.lease_started_at as group_lease_started_at,
    grouped.lease_until as group_lease_until,
    grouped.details as group_details
  from params p
  left join first_claim claim on true
  left join public.naver_shopping_worker_runs run on run.run_id = claim.run_id
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events event
    where event.event_type = 'group_claimed'
      and event.claim_id = claim.claim_id
      and event.run_id = claim.run_id
    order by event.event_id
    limit 1
  ) grouped on true
),
first_terminal as (
  select event.*
  from public.naver_shopping_scheduler_events event
  cross join first_claim claim
  cross join params p
  where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
    and event.claim_id = claim.claim_id
    and event.occurred_at <= p.observed_at
  order by event.event_id
  limit 1
),
terminal_context as (
  select
    claim.*,
    terminal.event_id as terminal_event_id,
    terminal.occurred_at as terminal_at,
    terminal.event_type as terminal_type,
    terminal.run_id as terminal_run_id,
    terminal.tracker_id as terminal_tracker_id,
    terminal.worker_id as terminal_worker_id,
    terminal.cycle_id as terminal_cycle_id,
    terminal.cycle_number as terminal_cycle_number,
    terminal.group_fingerprint as terminal_group_fingerprint,
    terminal.priority as terminal_priority,
    terminal.lease_started_at as terminal_lease_started_at,
    terminal.lease_until as terminal_lease_until,
    terminal.collection_id as terminal_collection_id,
    terminal.checked_count as terminal_checked_count,
    terminal.error_code as terminal_error_code,
    terminal.details as terminal_details
  from claim_context claim
  left join first_terminal terminal on true
),
evidence as (
  select
    terminal.*,
    target.*,
    guard.migration_count,
    guard.function_count,
    guard.function_integrity,
    guard.trigger_count,
    control.*,
    premature.premature_claim_count,
    group_counts.run_group_count,
    group_counts.matching_group_count,
    duplicates.same_cycle_group_count,
    duplicates.same_cycle_tracker_claim_count,
    claim_counts.exact_claim_count,
    claim_counts.claim_id_tracker_claim_count,
    claim_counts.claim_id_distinct_tracker_count,
    claim_counts.claim_id_distinct_run_count,
    roster.roster_count,
    roster.roster_event_id,
    terminals.terminal_count,
    terminals.finite_commit_count,
    terminals.tracker_commit_count,
    terminals.job_failure_count,
    subsequent.subsequent_terminal_count,
    snapshots.snapshot_through_terminal_count,
    snapshots.valid_finite_snapshot_count,
    snapshots.terminal_snapshot_rank,
    quarantine.claim_quarantine_count,
    quarantine.matching_quarantine_count,
    quarantine.quarantine_event_id,
    quarantine.quarantine_at,
    quarantine.quarantine_until
  from terminal_context terminal
  cross join target_contract target
  cross join exact_parent_guard guard
  cross join control_plane control
  cross join premature_claims premature
  left join lateral (
    select
      count(*) filter (where event.run_id = terminal.run_id)::integer as run_group_count,
      count(*) filter (where event.claim_id = terminal.claim_id and event.run_id = terminal.run_id)::integer as matching_group_count
    from public.naver_shopping_scheduler_events event
    where event.event_type = 'group_claimed' and event.occurred_at <= terminal.observed_at
  ) group_counts on true
  left join lateral (
    select
      count(*) filter (where event.event_type = 'group_claimed' and event.group_fingerprint is not distinct from terminal.claim_group_fingerprint)::integer as same_cycle_group_count,
      count(*) filter (where event.event_type = 'tracker_claimed' and event.tracker_id = terminal.tracker_id)::integer as same_cycle_tracker_claim_count
    from public.naver_shopping_scheduler_events event
    where event.cycle_id is not distinct from terminal.claim_cycle_id
      and event.occurred_at <= terminal.observed_at
  ) duplicates on true
  left join lateral (
    select
      count(*) filter (where event.run_id = terminal.run_id and event.tracker_id = terminal.tracker_id)::integer as exact_claim_count,
      count(*)::integer as claim_id_tracker_claim_count,
      count(distinct event.tracker_id)::integer as claim_id_distinct_tracker_count,
      count(distinct event.run_id)::integer as claim_id_distinct_run_count
    from public.naver_shopping_scheduler_events event
    where event.event_type = 'tracker_claimed'
      and event.claim_id = terminal.claim_id
      and event.occurred_at <= terminal.observed_at
  ) claim_counts on true
  left join lateral (
    select count(*)::integer as roster_count, min(event.event_id) as roster_event_id
    from public.naver_shopping_scheduler_events event
    where event.event_type = 'cycle_rostered'
      and event.cycle_id is not distinct from terminal.claim_cycle_id
      and event.cycle_number is not distinct from terminal.claim_cycle_number
      and event.tracker_id = terminal.tracker_id
      and event.group_fingerprint is not distinct from terminal.claim_group_fingerprint
      and event.occurred_at <= terminal.observed_at
  ) roster on true
  left join lateral (
    select
      count(*)::integer as terminal_count,
      count(*) filter (where event.event_type = 'finite_window_committed')::integer as finite_commit_count,
      count(*) filter (where event.event_type = 'tracker_committed')::integer as tracker_commit_count,
      count(*) filter (where event.event_type = 'job_failed')::integer as job_failure_count
    from public.naver_shopping_scheduler_events event
    where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.claim_id = terminal.claim_id
      and event.occurred_at <= terminal.observed_at
  ) terminals on true
  left join lateral (
    select count(*)::integer as subsequent_terminal_count
    from public.naver_shopping_scheduler_events event
    where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.tracker_id = terminal.tracker_id
      and event.event_id > terminal.terminal_event_id
      and event.occurred_at <= terminal.observed_at
  ) subsequent on true
  left join lateral (
    select
      count(*) filter (
        where terminal.terminal_at is not null and snapshot.checked_at <= terminal.terminal_at
      )::integer as snapshot_through_terminal_count,
      count(*) filter (
        where terminal.terminal_type = 'finite_window_committed'
          and snapshot.checked_at = terminal.terminal_at
          and snapshot.collection_id = terminal.terminal_collection_id
          and snapshot.checked_count = terminal.terminal_checked_count
          and snapshot.checked_count between 1 and 299
          and snapshot.source = 'naver_shopping_results_collector'
          and snapshot.matched = true
          and snapshot.rank between 1 and snapshot.checked_count
          and snapshot.total = snapshot.checked_count
          and snapshot.item ->> 'finiteWindowProofVersion' = terminal.proof_version
          and snapshot.item -> 'sourceExhausted' = 'true'::jsonb
          and snapshot.item -> 'finiteMarketTotal' = pg_catalog.to_jsonb(snapshot.checked_count)
          and snapshot.item -> 'atomicSuccessEligible' = 'false'::jsonb
          and snapshot.item ->> 'trackingRankSource' = 'related_catalog'
          and snapshot.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'
          and snapshot.item ->> 'relatedCatalogProductId' = terminal.parent_catalog_id
          and snapshot.item ->> 'catalogId' = terminal.parent_catalog_id
          and case
            when pg_catalog.jsonb_typeof(snapshot.item -> 'catalogSellerProductIds') = 'array' then (
              pg_catalog.jsonb_array_length(snapshot.item -> 'catalogSellerProductIds') between 1 and 100
              and exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(snapshot.item -> 'catalogSellerProductIds') seller_id(seller_id)
                where seller_id.seller_id = terminal.seller_product_id
              )
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(snapshot.item -> 'catalogSellerProductIds') seller_id(seller_id)
                where seller_id.seller_id !~ '^[0-9]{5,80}$'
              )
            )
            else false
          end
          and snapshot.item ->> 'rankPolicy' = 'organic_only'
          and snapshot.item -> 'adExcluded' = 'true'::jsonb
          and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
          and snapshot.item ->> 'collectionId' = snapshot.collection_id
          and snapshot.item -> 'isOrganic' = 'true'::jsonb
          and snapshot.item -> 'isAd' = 'false'::jsonb
          and case
            when pg_catalog.jsonb_typeof(snapshot.top_items) = 'array' then not exists (
              select 1 from pg_catalog.jsonb_array_elements(snapshot.top_items) top_item
              where top_item -> 'isOrganic' is distinct from 'true'::jsonb
                 or top_item -> 'isAd' is distinct from 'false'::jsonb
            )
            else false
          end
      )::integer as valid_finite_snapshot_count,
      min(snapshot.rank) filter (
        where terminal.terminal_type = 'finite_window_committed'
          and snapshot.checked_at = terminal.terminal_at
          and snapshot.collection_id = terminal.terminal_collection_id
      )::integer as terminal_snapshot_rank
    from public.naver_rank_snapshots snapshot
    where snapshot.tracker_id = terminal.tracker_id
  ) snapshots on true
  left join lateral (
    select
      count(*)::integer as claim_quarantine_count,
      count(*) filter (
        where event.worker_id is not distinct from terminal.terminal_worker_id
          and event.cycle_id is not distinct from terminal.terminal_cycle_id
          and event.cycle_number is not distinct from terminal.terminal_cycle_number
          and event.group_fingerprint is not distinct from terminal.terminal_group_fingerprint
          and event.priority is not distinct from terminal.terminal_priority
          and event.error_code is not distinct from terminal.terminal_error_code
          and event.details -> 'previousUntil' is not distinct from pg_catalog.to_jsonb(terminal.eligible_at)
      )::integer as matching_quarantine_count,
      min(event.event_id) as quarantine_event_id,
      min(event.occurred_at) as quarantine_at,
      min(event.quarantine_until) as quarantine_until
    from public.naver_shopping_scheduler_events event
    where event.event_type = 'quarantine_set'
      and event.claim_id = terminal.claim_id
      and event.run_id = terminal.run_id
      and event.tracker_id = terminal.tracker_id
      and event.occurred_at <= terminal.observed_at
  ) quarantine on true
),
invariants as (
  select
    evidence.*,
    (migration_count = 1 and function_count = 1 and function_integrity and trigger_count = 1)
      as exact_parent_guard_integrity,
    (
      exact_target_count = 1
      and claim_id is not null
      and run_id is not null
      and claim_cycle_id is not null
      and claim_cycle_number is not null
      and claim_group_fingerprint is not null
      and claim_worker_id is not distinct from worker_id
      and claim_priority in ('new', 'resume', 'normal')
      and claim_at >= eligible_at
      and run_worker_id is not distinct from worker_id
      and run_trigger is not distinct from 'rank-catch-up'
      and run_runtime_version is not distinct from runtime_version
      and run_runtime_fingerprint is not distinct from runtime_fingerprint
      and group_at >= eligible_at
      and group_at < claim_at
      and claim_at < run_started_at
      and run_group_count = 1
      and matching_group_count = 1
      and group_event_id < claim_event_id
      and group_worker_id is not distinct from claim_worker_id
      and group_cycle_id is not distinct from claim_cycle_id
      and group_cycle_number is not distinct from claim_cycle_number
      and group_fingerprint is not distinct from claim_group_fingerprint
      and group_priority is not distinct from claim_priority
      and group_details -> 'memberCount' is not distinct from pg_catalog.to_jsonb(1)
      and claim_lease_started_at is not null
      and claim_lease_until is not null
      and group_lease_started_at is not null
      and group_lease_until is not null
      and group_lease_started_at is not distinct from claim_lease_started_at
      and group_lease_until is not distinct from claim_lease_until
      and claim_lease_started_at < claim_lease_until
      and claim_lease_started_at <= group_at
      and claim_at < claim_lease_until
      and exact_claim_count = 1
      and claim_id_tracker_claim_count = 1
      and claim_id_distinct_tracker_count = 1
      and claim_id_distinct_run_count = 1
      and roster_count = 1
      and roster_event_id < group_event_id
      and same_cycle_group_count = 1
      and same_cycle_tracker_claim_count = 1
    ) as claim_integrity,
    (
      terminal_count = 1
      and terminal_event_id > claim_event_id
      and terminal_at > claim_at
      and run_started_at < terminal_at
      and terminal_run_id is not distinct from run_id
      and terminal_tracker_id is not distinct from tracker_id
      and terminal_worker_id is not distinct from claim_worker_id
      and terminal_cycle_id is not distinct from claim_cycle_id
      and terminal_cycle_number is not distinct from claim_cycle_number
      and terminal_group_fingerprint is not distinct from claim_group_fingerprint
      and terminal_priority is not distinct from claim_priority
      and terminal_lease_started_at is not null
      and terminal_lease_until is not null
      and terminal_lease_started_at is not distinct from claim_lease_started_at
      and terminal_lease_until is not distinct from claim_lease_until
      and terminal_lease_started_at < terminal_lease_until
      and terminal_lease_started_at <= terminal_at
      and terminal_at < terminal_lease_until
    ) as terminal_integrity,
    (
      terminal_type = 'finite_window_committed'
      and terminal_checked_count between 1 and 299
      and terminal_collection_id ~ '^pw-chrome-'
      and terminal_details ->> 'source' is not distinct from 'naver_shopping_results_collector'
      and terminal_details ->> 'finiteWindowProofVersion' is not distinct from proof_version
      and terminal_details -> 'sourceExhausted' is not distinct from 'true'::jsonb
      and terminal_details -> 'marketTotal' is not distinct from pg_catalog.to_jsonb(terminal_checked_count)
      and terminal_details -> 'matched' is not distinct from 'true'::jsonb
      and terminal_details -> 'rank' is not distinct from pg_catalog.to_jsonb(terminal_snapshot_rank)
      and terminal_details ->> 'relationBasis' is not distinct from 'catalog_seller_product_id'
      and terminal_details -> 'atomicSuccessEligible' is not distinct from 'false'::jsonb
      and target_snapshot_count = pre_gate_snapshot_count + 1
      and snapshot_through_terminal_count = 1
      and valid_finite_snapshot_count = 1
      and finite_commit_count = 1
      and tracker_commit_count = 0
      and job_failure_count = 0
      and claim_quarantine_count = 0
    ) as finite_success_integrity,
    (
      terminal_type = 'job_failed'
      and terminal_error_code in (
        'provider_stable_finite_window_unproven',
        'local_worker_finite_match_invalid'
      )
      and target_snapshot_count = pre_gate_snapshot_count
      and snapshot_through_terminal_count = 0
      and finite_commit_count = 0
      and tracker_commit_count = 0
      and job_failure_count = 1
      and claim_quarantine_count = 1
      and matching_quarantine_count = 1
      and quarantine_event_id > terminal_event_id
      and quarantine_at >= terminal_at
      and quarantine_until >= terminal_at + interval '30 minutes'
      and quarantine_until <= quarantine_at + interval '30 minutes 1 second'
      and target_current_rank is not distinct from pre_gate_current_rank
      and target_last_checked_at is not distinct from pre_gate_last_checked_at
      and target_check_count is not distinct from pre_gate_check_count
      and target_found_count is not distinct from pre_gate_found_count
      and target_retry_count is not distinct from pre_gate_retry_count + 1
      and target_last_error is not distinct from terminal_error_code
    ) as typed_failure_integrity,
    (terminal_type = 'job_failed' and terminal_error_code ~ '^provider_partial_window:([1-9]|[1-9][0-9]|[12][0-9]{2})_300$')
      as plain_partial_failure,
    (
      terminal_type = 'job_failed'
      and terminal_error_code ~ '^provider_partial_window:([1-9]|[1-9][0-9]|[12][0-9]{2})_300$'
      and target_snapshot_count = pre_gate_snapshot_count
      and snapshot_through_terminal_count = 0
      and finite_commit_count = 0
      and tracker_commit_count = 0
      and job_failure_count = 1
      and claim_quarantine_count = 1
      and matching_quarantine_count = 1
      and target_current_rank is not distinct from pre_gate_current_rank
      and target_last_checked_at is not distinct from pre_gate_last_checked_at
      and target_check_count is not distinct from pre_gate_check_count
      and target_found_count is not distinct from pre_gate_found_count
      and target_retry_count is not distinct from pre_gate_retry_count + 1
      and target_last_error is not distinct from terminal_error_code
    ) as plain_partial_failure_integrity,
    (control_row_count = 1 and control_integrity) as current_control_healthy,
    (
      control_row_count = 1
      and control_integrity
      and coordination_lane_idle
      and processing_count = 0
    ) as full_idle
  from evidence
),
tracker_state as (
  select
    invariants.*,
    (subsequent_terminal_count > 0) as tracker_state_superseded,
    case
      when subsequent_terminal_count > 0 then false
      when finite_success_integrity is true then (
        target_current_rank is not distinct from terminal_snapshot_rank
        and target_last_checked_at is not distinct from terminal_at
        and target_check_count is not distinct from pre_gate_check_count + 1
        and target_found_count is not distinct from pre_gate_found_count + 1
        and target_retry_count = 0
        and target_last_error is null
        and target_quarantined_until is not distinct from eligible_at
      )
      when typed_failure_integrity is true then (
        target_current_rank is not distinct from pre_gate_current_rank
        and target_last_checked_at is not distinct from pre_gate_last_checked_at
        and target_check_count is not distinct from pre_gate_check_count
        and target_found_count is not distinct from pre_gate_found_count
        and target_retry_count is not distinct from pre_gate_retry_count + 1
        and target_last_error is not distinct from terminal_error_code
        and target_quarantined_until is not distinct from quarantine_until
      )
      else false
    end as current_tracker_state_attested
  from invariants
),
materialized_invariants as (
  select
    tracker_state.*,
    case
      when terminal_type in ('finite_window_committed', 'job_failed') then (
        tracker_state_superseded is false
        and current_tracker_state_attested is true
      )
      else false
    end as first_terminal_materialization_integrity
  from tracker_state
),
classified as (
  select
    materialized_invariants.*,
    case
      when exact_target_count <> 1 or exact_parent_guard_integrity is not true or premature_claim_count <> 0
        then 'integrity_failure'
      when observed_at < eligible_at then 'awaiting_eligible_time'
      when current_control_healthy is not true then 'integrity_failure'
      when claim_id is null and observed_at < claim_deadline_at then 'awaiting_first_claim'
      when claim_id is null then 'integrity_failure'
      when claim_integrity is not true then 'integrity_failure'
      when terminal_count = 0
        and full_idle is not true
        and observed_at < claim_lease_until
        then 'awaiting_terminal'
      when terminal_count = 0 then 'integrity_failure'
      when terminal_integrity is not true then 'integrity_failure'
      when plain_partial_failure is true then 'integrity_failure'
      when terminal_type = 'finite_window_committed' and finite_success_integrity is not true
        then 'integrity_failure'
      when terminal_type = 'job_failed' and typed_failure_integrity is not true
        then 'integrity_failure'
      when terminal_type = 'tracker_committed' then 'integrity_failure'
      when first_terminal_materialization_integrity is not true then 'integrity_failure'
      when full_idle is not true and observed_at < terminal_at + interval '5 minutes'
        then 'awaiting_post_idle'
      when full_idle is not true then 'integrity_failure'
      when terminal_type = 'finite_window_committed' then 'success'
      when terminal_type = 'job_failed' then 'typed_failure'
      else 'integrity_failure'
    end as finite_state
  from materialized_invariants
)
select (pg_catalog.jsonb_build_object(
  'marker', '${contract.marker}',
  'observedAt', observed_at,
  'releaseCommit', '${contract.releaseCommit}',
  'recoveryCommit', '${contract.recoveryCommit}',
  'releaseEvidenceAt', release_evidence_at,
  'eligibleAt', eligible_at,
  'claimDeadlineAt', claim_deadline_at,
  'scheduledAnchorAt', scheduled_anchor_at,
  'trackerId', tracker_id,
  'sellerProductId', seller_product_id,
  'parentCatalogId', parent_catalog_id,
  'runtimeVersion', runtime_version,
  'runtimeFingerprint', runtime_fingerprint,
  'finiteState', finite_state,
  'prematureClaimCount', premature_claim_count,
  'claimEventId', claim_event_id,
  'claimAt', claim_at,
  'claimId', claim_id,
  'runId', run_id,
  'terminalEventId', terminal_event_id,
  'terminalAt', terminal_at,
  'terminalType', terminal_type,
  'terminalErrorCode', terminal_error_code,
  'terminalCheckedCount', terminal_checked_count,
  'terminalCollectionId', terminal_collection_id,
  'validFiniteSnapshotCount', valid_finite_snapshot_count
)
  || pg_catalog.jsonb_build_object(
  'targetSnapshotCount', target_snapshot_count,
  'targetCurrentRank', target_current_rank,
  'targetLastCheckedAt', target_last_checked_at,
  'targetRetryCount', target_retry_count,
  'targetLastError', target_last_error,
  'targetQuarantinedUntil', target_quarantined_until,
  'claimIntegrity', claim_integrity,
  'terminalIntegrity', terminal_integrity,
  'finiteSuccessIntegrity', finite_success_integrity,
  'typedFailureIntegrity', typed_failure_integrity,
  'trackerStateSuperseded', tracker_state_superseded,
  'currentTrackerStateAttested', current_tracker_state_attested,
  'firstTerminalMaterializationIntegrity', first_terminal_materialization_integrity,
  'plainPartialFailure', plain_partial_failure,
  'plainPartialFailureIntegrity', plain_partial_failure_integrity,
  'subsequentTerminalCount', subsequent_terminal_count,
  'recoveryMigrationCount', migration_count,
  'guardFunctionCount', function_count,
  'guardFunctionIntegrity', function_integrity,
  'guardTriggerCount', trigger_count,
  'exactParentGuardIntegrity', exact_parent_guard_integrity,
  'currentControlHealthy', current_control_healthy,
  'fullIdle', full_idle,
  'relationshipAuthority', 'exact_catalog_seller_product_id',
  'relationshipProven', finite_state = 'success' and finite_success_integrity is true,
  'rawDigestAttested', false,
  'captureIndependenceAttested', false,
  'releaseArtifactAttested', false
)) as result
from classified;
commit;`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${buildN30ParentCanaryReleaseAuditSql({ observedAt: process.argv[2] })}\n`);
}
