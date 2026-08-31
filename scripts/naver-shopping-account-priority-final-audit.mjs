import { pathToFileURL } from "node:url";

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;

export const N30_ACCOUNT_PRIORITY_FINAL_REQUEST_ID =
  "b5c3faec-a7f9-449b-b055-759abf3a019a";
export const N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE = "mml93-a01";
export const N30_ACCOUNT_PRIORITY_FINAL_COHORT_COUNT = 28;
export const N30_ACCOUNT_PRIORITY_FINAL_COHORT_HASH =
  "1b24b5b38979cb54f170cd10c3e53dcb";
export const N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID = "windows-desktop-primary";
export const N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_VERSION = "1.1.19";
export const N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_FINGERPRINT =
  "631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e";

function requireObservedAt(value) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("observedAt must be an ISO-8601 UTC timestamp");
  }
  return value;
}

function organicCollectorProof(alias) {
  return `${alias}.source = 'naver_shopping_results_collector'
      and ${alias}.collection_id ~ '^pw-chrome-'
      and ${alias}.item ->> 'collectionId' = ${alias}.collection_id
      and ${alias}.item ->> 'source' = 'naver_shopping_results_collector'
      and ${alias}.item -> 'adExcluded' = 'true'::jsonb
      and ${alias}.item ->> 'rankPolicy' = 'organic_only'
      and ${alias}.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
      and case
        when pg_catalog.jsonb_typeof(${alias}.item -> 'excludedAdCount') = 'number'
          and (${alias}.item ->> 'excludedAdCount') ~ '^[0-9]+$'
        then (${alias}.item ->> 'excludedAdCount')::numeric >= 0
        else false
      end
      and case
        when pg_catalog.jsonb_typeof(${alias}.top_items) = 'array' then (
          pg_catalog.jsonb_array_length(${alias}.top_items) between 1 and 100
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(${alias}.top_items) as top(item)
            where top.item -> 'isOrganic' is distinct from 'true'::jsonb
               or top.item -> 'isAd' is distinct from 'false'::jsonb
          )
        )
        else false
      end`;
}

function exactSellerOrParentProof(alias, productExpression) {
  return `(
        (
          ${alias}.item ->> 'trackingRankSource' = 'exact_product'
          and (
            ${alias}.item ->> 'sellerProductId' = ${productExpression}
            or (
              not (${alias}.item ? 'sellerProductId')
              and ${alias}.item ->> 'productId' = ${productExpression}
            )
          )
        )
        or (
          ${alias}.item ->> 'trackingRankSource' = 'related_catalog'
          and ${alias}.item ->> 'sourceLabel' = '원부'
          and ${alias}.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'
          and ${alias}.item ->> 'relatedCatalogProductId' ~ '^[0-9]{5,80}$'
          and ${alias}.item ->> 'catalogId' = ${alias}.item ->> 'relatedCatalogProductId'
          and ${alias}.item ->> 'catalogId' <> ${productExpression}
          and case
            when pg_catalog.jsonb_typeof(${alias}.item -> 'catalogSellerProductIds') = 'array' then (
              pg_catalog.jsonb_array_length(${alias}.item -> 'catalogSellerProductIds') between 1 and 100
              and exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  ${alias}.item -> 'catalogSellerProductIds'
                ) as seller_id(seller_id)
                where seller_id.seller_id = ${productExpression}
              )
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements_text(
                  ${alias}.item -> 'catalogSellerProductIds'
                ) as seller_id(seller_id)
                where seller_id.seller_id !~ '^[0-9]{5,80}$'
              )
            )
            else false
          end
        )
      )`;
}

function atomicSnapshotProof(alias, productExpression) {
  return `${organicCollectorProof(alias)}
      and ${alias}.checked_count = 300
      and ${alias}.matched is true
      and ${alias}.rank between 1 and 300
      and ${alias}.item -> 'isOrganic' = 'true'::jsonb
      and ${alias}.item -> 'isAd' = 'false'::jsonb
      and ${exactSellerOrParentProof(alias, productExpression)}`;
}

export function buildN30AccountPriorityFinalAuditSql({ observedAt } = {}) {
  const fixedObservedAt = requireObservedAt(observedAt);

  return `begin transaction isolation level repeatable read read only;
set local role service_role;
with
params as (
  select
    '${N30_ACCOUNT_PRIORITY_FINAL_REQUEST_ID}'::uuid as request_id,
    '${N30_ACCOUNT_PRIORITY_FINAL_AGENCY_CODE}'::text as agency_code,
    ${N30_ACCOUNT_PRIORITY_FINAL_COHORT_COUNT}::integer as cohort_count,
    '${N30_ACCOUNT_PRIORITY_FINAL_COHORT_HASH}'::text as cohort_hash,
    '${N30_ACCOUNT_PRIORITY_FINAL_WORKER_ID}'::text as worker_id,
    '${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_VERSION}'::text as runtime_version,
    '${N30_ACCOUNT_PRIORITY_FINAL_RUNTIME_FINGERPRINT}'::text as runtime_fingerprint,
    '${fixedObservedAt}'::timestamptz as observed_at
),
request_row as (
  select
    request.request_id,
    request.requested_at,
    request.expires_at,
    request.state,
    request.completed_at,
    request.expired_at,
    request.succeeded,
    (
      request.request_id = params.request_id
      and request.agency_code = params.agency_code
      and request.cohort_count = params.cohort_count
      and request.cohort_hash = params.cohort_hash
      and request.required_runtime_version = params.runtime_version
      and request.required_runtime_fingerprint = params.runtime_fingerprint
      and request.requested_at <= params.observed_at
      and request.expires_at = request.requested_at + interval '24 hours'
      and (
        (
          request.state = 'active'
          and request.completed_at is null
          and request.expired_at is null
          and request.succeeded is null
          and params.observed_at <= request.expires_at
        )
        or (
          request.state = 'completed'
          and request.completed_at is not null
          and request.completed_at <= params.observed_at
          and request.succeeded is not null
        )
      )
    ) as contract_ok
  from params
  left join public.naver_shopping_account_priority_requests as request
    on request.request_id = params.request_id
),
request_state_partition as (
  select
    count(*) filter (where request_id is not null)::integer as request_row_count,
    count(*) filter (where state = 'active')::integer as request_active_count,
    count(*) filter (where state = 'completed')::integer as request_completed_count,
    count(*) filter (where expired_at is not null)::integer as request_expired_count,
    count(*) filter (where request_id is null)::integer as request_missing_count,
    coalesce(pg_catalog.bool_and(contract_ok) filter (where request_id is not null), false)
      as request_contract_ok,
    coalesce(pg_catalog.bool_and(
      state = 'completed' and succeeded is true and expired_at is null
    ) filter (where request_id is not null), false) as request_completed_successfully
  from request_row
),
members as (
  select
    member.request_id,
    member.position,
    member.tracker_id,
    member.state,
    member.claimed_at,
    member.claimed_cycle_id,
    member.claimed_cycle_number,
    member.claimed_run_id,
    member.claimed_worker_id,
    member.claimed_lease_started_at,
    member.claimed_lease_until,
    member.claim_event_id,
    member.claim_id,
    member.terminal_at,
    member.terminal_event_id,
    member.terminal_event_type,
    member.terminal_code,
    member.cursor_sort_order_before,
    member.cursor_created_at_before,
    member.cursor_tracker_id_before,
    member.cursor_resume_before,
    member.cursor_sort_order_after,
    member.cursor_created_at_after,
    member.cursor_tracker_id_after,
    member.cursor_resume_after,
    request.requested_at as request_requested_at,
    request.completed_at as request_completed_at,
    tracker.product_id,
    tracker.agency_code as tracker_agency_code,
    tracker.status as tracker_status,
    tracker.current_rank,
    tracker.last_checked_at
  from params
  cross join request_row as request
  join public.naver_shopping_account_priority_members as member
    on member.request_id = params.request_id
  left join public.naver_rank_trackers as tracker on tracker.id = member.tracker_id
),
member_state_partition as (
  select
    count(*)::integer as member_count,
    count(distinct tracker_id)::integer as distinct_tracker_count,
    count(distinct position)::integer as distinct_position_count,
    min(position)::integer as minimum_position,
    max(position)::integer as maximum_position,
    count(*) filter (where state = 'terminal_success')::integer as terminal_success_count,
    count(*) filter (where state = 'terminal_failure')::integer as terminal_failure_count,
    count(*) filter (where state in ('integrity_failure', 'terminal_missing'))::integer
      as integrity_failure_count,
    count(*) filter (where state = 'expired')::integer as expired_count,
    count(*) filter (where state in ('pending', 'claimed'))::integer as open_count
  from members
),
member_evidence as (
  select
    member.*,
    claim.event_id as actual_claim_event_id,
    claim.occurred_at as actual_claim_at,
    claim.claim_id as actual_claim_id,
    claim.run_id as actual_claim_run_id,
    claim.worker_id as actual_claim_worker_id,
    claim.tracker_id as actual_claim_tracker_id,
    claim.agency_code as actual_claim_agency_code,
    claim.cycle_id as actual_claim_cycle_id,
    claim.cycle_number as actual_claim_cycle_number,
    claim.group_fingerprint as actual_claim_group_fingerprint,
    claim.priority as actual_claim_priority,
    claim.lease_started_at as actual_claim_lease_started_at,
    claim.lease_until as actual_claim_lease_until,
    run.worker_id as run_worker_id,
    run.run_trigger,
    run.runtime_version,
    run.runtime_fingerprint,
    run.started_at as run_started_at,
    grouped.event_id as group_event_id,
    grouped.occurred_at as group_at,
    grouped.run_id as group_run_id,
    grouped.worker_id as group_worker_id,
    grouped.agency_code as group_agency_code,
    grouped.cycle_id as group_cycle_id,
    grouped.cycle_number as group_cycle_number,
    grouped.group_fingerprint,
    grouped.priority as group_priority,
    grouped.lease_started_at as group_lease_started_at,
    grouped.lease_until as group_lease_until,
    terminal.event_id as actual_terminal_event_id,
    terminal.occurred_at as actual_terminal_at,
    terminal.event_type as actual_terminal_type,
    terminal.run_id as terminal_run_id,
    terminal.worker_id as terminal_worker_id,
    terminal.tracker_id as terminal_tracker_id,
    terminal.agency_code as terminal_agency_code,
    terminal.cycle_id as terminal_cycle_id,
    terminal.cycle_number as terminal_cycle_number,
    terminal.group_fingerprint as terminal_group_fingerprint,
    terminal.priority as terminal_priority,
    terminal.lease_started_at as terminal_lease_started_at,
    terminal.lease_until as terminal_lease_until,
    terminal.collection_id,
    terminal.checked_count as terminal_checked_count,
    event_counts.claim_count,
    request_claim_counts.request_claim_count,
    event_counts.group_count,
    event_counts.terminal_count,
    snapshot_counts.claim_window_snapshot_count,
    snapshot_counts.terminal_snapshot_count,
    snapshot_counts.valid_atomic_snapshot_count,
    snapshot_counts.snapshot_checked_at,
    snapshot_counts.snapshot_rank
  from members as member
  cross join params
  left join public.naver_shopping_scheduler_events as claim
    on claim.event_id = member.claim_event_id
   and claim.event_type = 'tracker_claimed'
  left join public.naver_shopping_worker_runs as run
    on run.run_id = member.claimed_run_id
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'group_claimed'
      and event.claim_id = member.claim_id
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as grouped on true
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.claim_id = member.claim_id
      and event.tracker_id = member.tracker_id
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as terminal on true
  left join lateral (
    select
      count(*) filter (
        where event.event_type = 'tracker_claimed'
          and event.tracker_id = member.tracker_id
      )::integer as claim_count,
      count(*) filter (where event.event_type = 'group_claimed')::integer as group_count,
      count(*) filter (
        where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
          and event.tracker_id = member.tracker_id
      )::integer as terminal_count
    from public.naver_shopping_scheduler_events as event
    where event.claim_id = member.claim_id
      and event.occurred_at <= params.observed_at
  ) as event_counts on true
  left join lateral (
    select count(*)::integer as request_claim_count
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.tracker_id = member.tracker_id
      and event.occurred_at >= member.request_requested_at
      and event.occurred_at <= coalesce(member.request_completed_at, params.observed_at)
      and event.occurred_at <= params.observed_at
  ) as request_claim_counts on true
  left join lateral (
    select
      count(*) filter (
        where terminal.occurred_at is not null
          and snapshot.checked_at >= member.claimed_at
          and snapshot.checked_at <= terminal.occurred_at
      )::integer as claim_window_snapshot_count,
      count(*) filter (
        where terminal.occurred_at is not null
          and snapshot.checked_at = terminal.occurred_at
          and snapshot.collection_id = terminal.collection_id
      )::integer as terminal_snapshot_count,
      count(*) filter (
        where terminal.occurred_at is not null
          and snapshot.checked_at = terminal.occurred_at
          and snapshot.collection_id = terminal.collection_id
          and snapshot.checked_count = terminal.checked_count
          and (${atomicSnapshotProof("snapshot", "member.product_id")})
      )::integer as valid_atomic_snapshot_count,
      min(snapshot.checked_at) filter (
        where terminal.occurred_at is not null
          and snapshot.checked_at = terminal.occurred_at
          and snapshot.collection_id = terminal.collection_id
      ) as snapshot_checked_at,
      min(snapshot.rank) filter (
        where terminal.occurred_at is not null
          and snapshot.checked_at = terminal.occurred_at
          and snapshot.collection_id = terminal.collection_id
      )::integer as snapshot_rank
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = member.tracker_id
      and snapshot.checked_at <= params.observed_at
  ) as snapshot_counts on true
),
member_subconditions as (
  select
    evidence.*,
    coalesce((
      evidence.terminal_code is null
      and evidence.tracker_agency_code = params.agency_code
      and evidence.tracker_status = 'active'
    ), false) as proof_tracker_contract,
    coalesce((
      evidence.claim_count = 1
      and evidence.request_claim_count = 1
      and evidence.group_count = 1
      and evidence.terminal_count = 1
    ), false) as proof_cardinality_contract,
    coalesce((
      evidence.actual_claim_event_id = evidence.claim_event_id
      and evidence.actual_claim_id = evidence.claim_id
      and evidence.actual_claim_run_id = evidence.claimed_run_id
      and evidence.actual_claim_worker_id = params.worker_id
      and evidence.actual_claim_worker_id = evidence.claimed_worker_id
      and evidence.actual_claim_tracker_id = evidence.tracker_id
      and evidence.actual_claim_agency_code = params.agency_code
      and evidence.actual_claim_cycle_id is not distinct from evidence.claimed_cycle_id
      and evidence.actual_claim_cycle_number is not distinct from evidence.claimed_cycle_number
      and evidence.actual_claim_group_fingerprint is not null
    ), false) as proof_claim_identity_contract,
    coalesce((
      evidence.claimed_at = evidence.claimed_lease_started_at
      and evidence.actual_claim_lease_started_at = evidence.claimed_lease_started_at
      and evidence.actual_claim_lease_until = evidence.claimed_lease_until
      and evidence.actual_claim_at >= evidence.claimed_at
      and evidence.actual_claim_at <= evidence.claimed_lease_until
    ), false) as proof_claim_lease_contract,
    coalesce((
      evidence.claimed_at >= evidence.request_requested_at
      and evidence.group_at >= evidence.request_requested_at
      and evidence.actual_claim_at >= evidence.request_requested_at
      and evidence.actual_terminal_at >= evidence.request_requested_at
      and evidence.claimed_at <= coalesce(evidence.request_completed_at, params.observed_at)
      and evidence.group_at <= coalesce(evidence.request_completed_at, params.observed_at)
      and evidence.actual_claim_at <= coalesce(
        evidence.request_completed_at, params.observed_at
      )
      and evidence.actual_terminal_at <= coalesce(
        evidence.request_completed_at, params.observed_at
      )
    ), false) as proof_window_bounds_contract,
    coalesce((
      evidence.group_event_id < evidence.claim_event_id
      and evidence.claim_event_id < evidence.actual_terminal_event_id
      and evidence.claimed_at <= evidence.group_at
      and evidence.group_at <= evidence.actual_claim_at
      and evidence.actual_claim_at <= evidence.actual_terminal_at
    ), false) as proof_event_order_contract,
    coalesce((
      evidence.group_run_id = evidence.claimed_run_id
      and evidence.group_worker_id = params.worker_id
      and evidence.group_agency_code is null
      and evidence.group_cycle_id is not distinct from evidence.claimed_cycle_id
      and evidence.group_cycle_number is not distinct from evidence.claimed_cycle_number
      and evidence.group_fingerprint is not distinct from evidence.actual_claim_group_fingerprint
      and evidence.group_priority is not distinct from evidence.actual_claim_priority
      and evidence.group_lease_started_at = evidence.claimed_lease_started_at
      and evidence.group_lease_until = evidence.claimed_lease_until
    ), false) as proof_group_contract,
    coalesce((
      evidence.run_worker_id = params.worker_id
      and evidence.run_trigger = 'rank-catch-up'
      and evidence.runtime_version = params.runtime_version
      and evidence.runtime_fingerprint = params.runtime_fingerprint
      and evidence.actual_claim_at <= evidence.run_started_at
      and evidence.run_started_at <= evidence.actual_terminal_at
      and evidence.actual_terminal_at <= evidence.claimed_lease_until
    ), false) as proof_run_contract,
    coalesce((
      evidence.actual_terminal_event_id = evidence.terminal_event_id
      and evidence.actual_terminal_at = evidence.terminal_at
      and evidence.actual_terminal_type = 'tracker_committed'
      and evidence.actual_terminal_type = evidence.terminal_event_type
      and evidence.terminal_run_id = evidence.claimed_run_id
      and evidence.terminal_worker_id = params.worker_id
      and evidence.terminal_tracker_id = evidence.tracker_id
      and evidence.terminal_agency_code = params.agency_code
      and evidence.terminal_cycle_id is not distinct from evidence.claimed_cycle_id
      and evidence.terminal_cycle_number is not distinct from evidence.claimed_cycle_number
      and evidence.terminal_group_fingerprint is not distinct from evidence.actual_claim_group_fingerprint
      and evidence.terminal_priority is not distinct from evidence.actual_claim_priority
      and evidence.terminal_lease_started_at is not distinct from evidence.claimed_lease_started_at
      and evidence.terminal_lease_until is not distinct from evidence.claimed_lease_until
      and evidence.terminal_checked_count = 300
    ), false) as proof_terminal_contract,
    coalesce((
      evidence.claim_window_snapshot_count = 1
      and evidence.terminal_snapshot_count = 1
      and evidence.valid_atomic_snapshot_count = 1
    ), false) as proof_snapshot_contract,
    coalesce((
      evidence.current_rank is not distinct from evidence.snapshot_rank
      and evidence.last_checked_at is not distinct from evidence.snapshot_checked_at
    ), false) as proof_materialization_contract,
    coalesce((
      evidence.cursor_sort_order_before is not distinct from evidence.cursor_sort_order_after
      and evidence.cursor_created_at_before is not distinct from evidence.cursor_created_at_after
      and evidence.cursor_tracker_id_before is not distinct from evidence.cursor_tracker_id_after
      and evidence.cursor_resume_before is not distinct from evidence.cursor_resume_after
    ), false) as proof_cursor_contract
  from member_evidence as evidence
  cross join params
),
member_contracts as (
  select
    subcondition.*,
    coalesce((
      subcondition.proof_claim_identity_contract
      and subcondition.proof_claim_lease_contract
    ), false) as proof_claim_contract,
    coalesce((
      subcondition.proof_window_bounds_contract
      and subcondition.proof_event_order_contract
    ), false) as proof_window_order_contract
  from member_subconditions as subcondition
),
member_verdicts as (
  select
    contract.*,
    coalesce((
      contract.state = 'terminal_success'
      and contract.proof_tracker_contract
      and contract.proof_cardinality_contract
      and contract.proof_claim_contract
      and contract.proof_window_order_contract
      and contract.proof_group_contract
      and contract.proof_run_contract
      and contract.proof_terminal_contract
      and contract.proof_snapshot_contract
      and contract.proof_materialization_contract
      and contract.proof_cursor_contract
    ), false) as proof_success,
    (
      contract.last_checked_at is null
      or contract.last_checked_at < params.observed_at - interval '24 hours'
    ) as stale_24h
  from member_contracts as contract
  cross join params
),
proof_partition as (
  select
    count(*) filter (where proof_success)::integer as proof_success_count,
    count(*) filter (where actual_terminal_type = 'tracker_committed')::integer
      as observed_terminal_success_count,
    count(*) filter (where actual_terminal_type = 'job_failed')::integer
      as observed_terminal_failure_count,
    count(*) filter (where actual_terminal_event_id is null)::integer
      as observed_terminal_open_count,
    count(*) filter (where state = 'terminal_success' and not proof_success)::integer
      as invalid_success_evidence_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_tracker_contract
    )::integer as invalid_success_tracker_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_cardinality_contract
    )::integer as invalid_success_cardinality_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_claim_contract
    )::integer as invalid_success_claim_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_claim_identity_contract
    )::integer as invalid_success_claim_identity_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_claim_lease_contract
    )::integer as invalid_success_claim_lease_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_window_order_contract
    )::integer as invalid_success_window_order_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_window_bounds_contract
    )::integer as invalid_success_window_bounds_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_event_order_contract
    )::integer as invalid_success_event_order_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_group_contract
    )::integer as invalid_success_group_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_run_contract
    )::integer as invalid_success_run_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_terminal_contract
    )::integer as invalid_success_terminal_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_snapshot_contract
    )::integer as invalid_success_snapshot_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_materialization_contract
    )::integer as invalid_success_materialization_contract_count,
    count(*) filter (
      where state = 'terminal_success' and not proof_cursor_contract
    )::integer as invalid_success_cursor_contract_count,
    count(*) filter (where claim_count > 1 or request_claim_count > 1)::integer
      as claim_duplicate_count,
    count(*) filter (where terminal_count > 1)::integer as terminal_duplicate_count,
    count(*) filter (
      where cursor_sort_order_before is distinct from cursor_sort_order_after
         or cursor_created_at_before is distinct from cursor_created_at_after
         or cursor_tracker_id_before is distinct from cursor_tracker_id_after
         or cursor_resume_before is distinct from cursor_resume_after
    )::integer as cursor_mismatch_count,
    count(*) filter (where stale_24h)::integer as stale_24h_count
  from member_verdicts
),
control_source as (
  select
    coordination.primary_worker_id,
    coordination.primary_seen_at,
    coordination.circuit_state,
    coordination.circuit_reason,
    coordination.cooldown_until,
    coordination.runtime_version,
    coordination.runtime_fingerprint,
    coordination.updated_at,
    coordination.lease_worker_id,
    (coordination.lease_token is null) as lease_token_is_null,
    coordination.lease_until,
    coordination.run_id,
    coordination.current_stage,
    coordination.current_page,
    coordination.current_job_kind,
    coordination.current_tracker_id,
    coordination.current_job_started_at,
    coordination.probe_tracker_id,
    coordination.probe_started_at
  from public.naver_shopping_worker_coordination as coordination
  where coordination.lane_key = 'global'
),
control_plane as (
  select
    count(*) filter (where control.primary_worker_id is not null)::integer
      as control_row_count,
    coalesce(pg_catalog.bool_and(
      control.primary_worker_id = params.worker_id
      and control.primary_seen_at >= request.completed_at
      and control.primary_seen_at between params.observed_at - interval '5 minutes'
        and params.observed_at
      and control.circuit_state = 'closed'
      and control.circuit_reason is null
      and control.cooldown_until is null
      and control.runtime_version = params.runtime_version
      and control.runtime_fingerprint = params.runtime_fingerprint
      and control.updated_at >= request.completed_at
      and control.updated_at between params.observed_at - interval '5 minutes'
        and params.observed_at
      and control.lease_worker_id is null
      and control.lease_token_is_null
      and control.lease_until is null
      and control.run_id is null
      and control.current_stage is null
      and control.current_page = 0
      and control.current_job_kind is null
      and control.current_tracker_id is null
      and control.current_job_started_at is null
      and control.probe_tracker_id is null
      and control.probe_started_at is null
    ), false) as control_identity_idle,
    (
      select count(*)::integer
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.processing_until > params.observed_at
    ) as tracker_processing_count,
    (
      select count(*)::integer
      from public.naver_shopping_rank_lookup_jobs as job
      where job.status = 'processing'
        and job.processing_until > params.observed_at
    ) as job_processing_count
  from params
  cross join request_row as request
  left join control_source as control on true
  group by params.observed_at, request.completed_at
),
full_idle as (
  select
    (
      control_row_count = 1
      and control_identity_idle
      and tracker_processing_count = 0
      and job_processing_count = 0
    ) as full_idle
  from control_plane
),
resume_candidates as (
  select
    grouped.event_id as group_event_id,
    grouped.occurred_at as group_at,
    grouped.claim_id,
    grouped.run_id,
    grouped.worker_id,
    grouped.cycle_id,
    grouped.cycle_number,
    grouped.group_fingerprint,
    grouped.priority,
    grouped.lease_started_at,
    grouped.lease_until,
    claim.event_id as claim_event_id,
    claim.occurred_at as claim_at,
    claim.run_id as claim_run_id,
    claim.worker_id as claim_worker_id,
    claim.tracker_id,
    claim.agency_code as claim_agency_code,
    claim.cycle_id as claim_cycle_id,
    claim.cycle_number as claim_cycle_number,
    claim.group_fingerprint as claim_group_fingerprint,
    claim.priority as claim_priority,
    claim.lease_started_at as claim_lease_started_at,
    claim.lease_until as claim_lease_until,
    terminal.event_id as terminal_event_id,
    terminal.occurred_at as terminal_at,
    terminal.event_type as terminal_type,
    terminal.run_id as terminal_run_id,
    terminal.worker_id as terminal_worker_id,
    terminal.agency_code as terminal_agency_code,
    terminal.cycle_id as terminal_cycle_id,
    terminal.cycle_number as terminal_cycle_number,
    terminal.group_fingerprint as terminal_group_fingerprint,
    terminal.priority as terminal_priority,
    terminal.lease_started_at as terminal_lease_started_at,
    terminal.lease_until as terminal_lease_until,
    terminal.checked_count,
    run.started_at as run_started_at,
    run.worker_id as run_worker_id,
    run.run_trigger,
    run.runtime_version,
    run.runtime_fingerprint,
    counts.group_count,
    counts.claim_count,
    counts.terminal_count
  from params
  cross join request_row as request
  join public.naver_shopping_scheduler_events as grouped
    on grouped.event_type = 'group_claimed'
   and grouped.agency_code is null
   and grouped.occurred_at > request.completed_at
   and grouped.occurred_at <= params.observed_at
  join public.naver_shopping_scheduler_events as claim
    on claim.event_type = 'tracker_claimed'
   and claim.claim_id = grouped.claim_id
   and claim.event_id > grouped.event_id
   and claim.agency_code is not null
   and claim.agency_code <> params.agency_code
  join public.naver_rank_trackers as tracker
    on tracker.id = claim.tracker_id
   and tracker.agency_code = claim.agency_code
  join public.naver_shopping_worker_runs as run on run.run_id = claim.run_id
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
      and event.claim_id = claim.claim_id
      and event.tracker_id = claim.tracker_id
      and event.occurred_at <= params.observed_at
    order by event.event_id
    limit 1
  ) as terminal on true
  left join lateral (
    select
      count(*) filter (where event.event_type = 'group_claimed')::integer as group_count,
      count(*) filter (
        where event.event_type = 'tracker_claimed'
          and event.tracker_id = claim.tracker_id
      )::integer as claim_count,
      count(*) filter (
        where event.event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
          and event.tracker_id = claim.tracker_id
      )::integer as terminal_count
    from public.naver_shopping_scheduler_events as event
    where event.claim_id = claim.claim_id
      and event.occurred_at <= params.observed_at
  ) as counts on true
),
resume_summary as (
  select
    count(*)::integer as resume_candidate_count,
    count(*) filter (
      where resume.group_count = 1
        and resume.claim_count = 1
        and resume.terminal_count = 1
        and resume.group_event_id < resume.claim_event_id
        and resume.group_at <= resume.claim_at
        and resume.run_id is not null
        and resume.run_id = resume.claim_run_id
        and resume.worker_id = params.worker_id
        and resume.claim_worker_id = params.worker_id
        and resume.run_worker_id = params.worker_id
        and resume.cycle_id is not distinct from resume.claim_cycle_id
        and resume.cycle_number is not distinct from resume.claim_cycle_number
        and resume.group_fingerprint is not distinct from resume.claim_group_fingerprint
        and resume.priority is not distinct from resume.claim_priority
        and resume.priority in ('new', 'resume', 'normal')
        and resume.lease_started_at is not distinct from resume.claim_lease_started_at
        and resume.lease_until is not distinct from resume.claim_lease_until
        and resume.run_trigger = 'rank-catch-up'
        and resume.runtime_version = params.runtime_version
        and resume.runtime_fingerprint = params.runtime_fingerprint
        and resume.claim_at <= resume.run_started_at
        and resume.run_started_at <= resume.terminal_at
        and resume.terminal_at <= resume.lease_until
        and resume.terminal_event_id > resume.claim_event_id
        and resume.terminal_type = 'tracker_committed'
        and resume.terminal_run_id = resume.claim_run_id
        and resume.terminal_worker_id = resume.claim_worker_id
        and resume.terminal_agency_code = resume.claim_agency_code
        and resume.terminal_cycle_id is not distinct from resume.claim_cycle_id
        and resume.terminal_cycle_number is not distinct from resume.claim_cycle_number
        and resume.terminal_group_fingerprint is not distinct from resume.claim_group_fingerprint
        and resume.terminal_priority is not distinct from resume.claim_priority
        and resume.terminal_lease_started_at is not distinct from resume.claim_lease_started_at
        and resume.terminal_lease_until is not distinct from resume.claim_lease_until
        and resume.checked_count = 300
    )::integer as valid_resume_count
  from resume_candidates as resume
  cross join params
),
verdict as (
  select
    request_partition.*,
    partition.*,
    proof.*,
    idle.full_idle,
    resume.resume_candidate_count,
    resume.valid_resume_count,
    (resume.valid_resume_count > 0) as resume_observed
  from request_state_partition as request_partition
  cross join member_state_partition as partition
  cross join proof_partition as proof
  cross join full_idle as idle
  cross join resume_summary as resume
),
final_verdict as (
  select
    verdict.*,
    (
      verdict.request_row_count = 1
      and verdict.request_active_count = 0
      and verdict.request_completed_count = 1
      and verdict.request_expired_count = 0
      and verdict.request_missing_count = 0
      and verdict.request_contract_ok
      and verdict.request_completed_successfully
      and verdict.member_count = params.cohort_count
      and verdict.distinct_tracker_count = params.cohort_count
      and verdict.distinct_position_count = params.cohort_count
      and verdict.minimum_position = 1
      and verdict.maximum_position = params.cohort_count
      and verdict.terminal_success_count = params.cohort_count
      and verdict.proof_success_count = params.cohort_count
      and verdict.observed_terminal_success_count = params.cohort_count
      and verdict.observed_terminal_failure_count = 0
      and verdict.observed_terminal_open_count = 0
      and verdict.terminal_failure_count = 0
      and verdict.integrity_failure_count = 0
      and verdict.expired_count = 0
      and verdict.open_count = 0
      and verdict.invalid_success_evidence_count = 0
      and verdict.claim_duplicate_count = 0
      and verdict.terminal_duplicate_count = 0
      and verdict.cursor_mismatch_count = 0
      and verdict.stale_24h_count = 0
      and verdict.full_idle
    ) as account_success
  from verdict
  cross join params
)
select pg_catalog.jsonb_build_object(
  'marker', 'n30_account_priority_final_audit_v1',
  'observedAt', params.observed_at,
  'requestRowCount', verdict.request_row_count,
  'requestActiveCount', verdict.request_active_count,
  'requestCompletedCount', verdict.request_completed_count,
  'requestExpiredCount', verdict.request_expired_count,
  'requestMissingCount', verdict.request_missing_count,
  'requestContractOk', verdict.request_contract_ok,
  'requestCompletedSuccessfully', verdict.request_completed_successfully,
  'memberCount', verdict.member_count,
  'distinctTrackerCount', verdict.distinct_tracker_count,
  'distinctPositionCount', verdict.distinct_position_count,
  'minimumPosition', verdict.minimum_position,
  'maximumPosition', verdict.maximum_position,
  'terminalSuccessCount', verdict.terminal_success_count,
  'terminalFailureCount', verdict.terminal_failure_count,
  'integrityFailureCount', verdict.integrity_failure_count,
  'expiredCount', verdict.expired_count,
  'openCount', verdict.open_count,
  'proofSuccessCount', verdict.proof_success_count,
  'observedTerminalSuccessCount', verdict.observed_terminal_success_count,
  'observedTerminalFailureCount', verdict.observed_terminal_failure_count,
  'observedTerminalOpenCount', verdict.observed_terminal_open_count,
  'invalidSuccessEvidenceCount', verdict.invalid_success_evidence_count,
  'invalidSuccessTrackerContractCount', verdict.invalid_success_tracker_contract_count,
  'invalidSuccessCardinalityContractCount', verdict.invalid_success_cardinality_contract_count,
  'invalidSuccessClaimContractCount', verdict.invalid_success_claim_contract_count,
  'invalidSuccessClaimIdentityContractCount', verdict.invalid_success_claim_identity_contract_count,
  'invalidSuccessClaimLeaseContractCount', verdict.invalid_success_claim_lease_contract_count,
  'invalidSuccessWindowOrderContractCount', verdict.invalid_success_window_order_contract_count,
  'invalidSuccessWindowBoundsContractCount', verdict.invalid_success_window_bounds_contract_count,
  'invalidSuccessEventOrderContractCount', verdict.invalid_success_event_order_contract_count,
  'invalidSuccessGroupContractCount', verdict.invalid_success_group_contract_count,
  'invalidSuccessRunContractCount', verdict.invalid_success_run_contract_count,
  'invalidSuccessTerminalContractCount', verdict.invalid_success_terminal_contract_count,
  'invalidSuccessSnapshotContractCount', verdict.invalid_success_snapshot_contract_count,
  'invalidSuccessMaterializationContractCount', verdict.invalid_success_materialization_contract_count,
  'invalidSuccessCursorContractCount', verdict.invalid_success_cursor_contract_count,
  'claimDuplicateCount', verdict.claim_duplicate_count,
  'terminalDuplicateCount', verdict.terminal_duplicate_count,
  'cursorMismatchCount', verdict.cursor_mismatch_count,
  'stale24hCount', verdict.stale_24h_count,
  'fullIdle', verdict.full_idle,
  'resumeCandidateCount', verdict.resume_candidate_count,
  'validResumeCount', verdict.valid_resume_count,
  'resumeObserved', verdict.resume_observed,
  'accountSuccess', verdict.account_success,
  'overallSuccess', verdict.account_success and verdict.resume_observed
) as audit
from final_verdict as verdict
cross join params;
commit;
`;
}

function parseObservedAt(argv) {
  const match = argv.find((argument) => argument.startsWith("--observed-at="));
  return match?.slice("--observed-at=".length);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(buildN30AccountPriorityFinalAuditSql({
    observedAt: parseObservedAt(process.argv.slice(2)),
  }));
}
