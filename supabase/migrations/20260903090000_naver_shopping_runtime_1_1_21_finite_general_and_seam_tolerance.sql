-- Runtime 1.1.21 generalizes the stable finite-window commit to every tracker
-- (F9), raises the catalog seller-id cap to 300 (S14) and tolerates a bounded
-- number of zero-gap page seams in rendered-order captures (K2, code only).
-- The finite path keeps every proof predicate that made it safe: two
-- independent captures with identical ordered direct-ID digests, a verified
-- market total equal to the row count, an exhausted source, organic-only rows
-- and a single tracker claim without a failure. What changes is only *who* may
-- commit (any tracker job on any worker and trigger) and *what* it may record
-- (the exact seller product, a directly linked parent catalog, or "not found"
-- with no rank). The exact300 commit RPC, the exact-parent snapshot guard, the
-- tracker_committed ledger CHECK and all account-priority evidence are
-- unchanged.

begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;
lock table public.naver_shopping_finite_window_targets in share row exclusive mode;
lock table public.naver_shopping_account_priority_requests in share row exclusive mode;
lock table public.naver_shopping_account_priority_members in share row exclusive mode;

do $migration_guard$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  coordination_found boolean := false;
  processing_count integer := 0;
  active_request_count integer := 0;
  unfinished_member_count integer := 0;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  coordination_found := found;

  select (
    (select count(*)
     from public.naver_shopping_rank_lookup_jobs
     where status = 'processing'
       and processing_until > clock_timestamp())
    +
    (select count(*)
     from public.naver_rank_trackers
     where status = 'active'
       and processing_until > clock_timestamp())
  )::integer into processing_count;

  select count(*)::integer into active_request_count
  from public.naver_shopping_account_priority_requests as request
  where request.state = 'active';

  select count(*)::integer into unfinished_member_count
  from public.naver_shopping_account_priority_members as member
  where member.state in ('pending', 'claimed');

  if active_request_count <> 0 or unfinished_member_count <> 0 then
    raise exception 'naver_shopping_runtime_1_1_21_requires_completed_account_priority';
  end if;

  if coordination_found is not true
    or current_row.runtime_version is distinct from '1.1.20'
    or current_row.runtime_fingerprint is distinct from
      '4e0f5fbde16a892e44986b2325865f33d61bdf7a5a13d3d7adcd501608aa8e5b'
    or current_row.cadence_mode is distinct from 'baseline'
    or current_row.cadence_minutes is distinct from 10
    or current_row.circuit_state is distinct from 'closed'
    or current_row.circuit_reason is not null
    or current_row.cooldown_until is not null
    or processing_count <> 0
    or current_row.lease_worker_id is not null
    or current_row.lease_token is not null
    or current_row.lease_until is not null
    or current_row.run_id is not null
    or current_row.current_stage is not null
    or current_row.current_page is distinct from 0
    or current_row.current_job_kind is not null
    or current_row.current_tracker_id is not null
    or current_row.current_job_started_at is not null
    or current_row.probe_tracker_id is not null
    or current_row.probe_started_at is not null then
    raise exception 'naver_shopping_runtime_1_1_21_requires_idle_control_plane';
  end if;
end
$migration_guard$;

alter table public.naver_shopping_finite_window_targets
  drop constraint if exists naver_shopping_finite_window_targets_runtime_version_check;

do $target_transition$
declare
  prior_target_count integer := 0;
  target_updated_count integer := 0;
begin
  select count(*)::integer into prior_target_count
  from public.naver_shopping_finite_window_targets;

  if exists (
    select 1
    from public.naver_shopping_finite_window_targets
    where runtime_version is distinct from '1.1.20'
       or runtime_fingerprint is distinct from
         '4e0f5fbde16a892e44986b2325865f33d61bdf7a5a13d3d7adcd501608aa8e5b'
  ) then
    raise exception 'naver_shopping_runtime_1_1_21_finite_target_identity_mismatch';
  end if;

  update public.naver_shopping_finite_window_targets
  set runtime_version = '1.1.21',
      runtime_fingerprint =
        '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0'
  where runtime_version = '1.1.20'
    and runtime_fingerprint = '4e0f5fbde16a892e44986b2325865f33d61bdf7a5a13d3d7adcd501608aa8e5b';
  get diagnostics target_updated_count = row_count;

  if target_updated_count <> prior_target_count then
    raise exception 'naver_shopping_runtime_1_1_21_target_mismatch';
  end if;
end
$target_transition$;

alter table public.naver_shopping_finite_window_targets
  add constraint naver_shopping_finite_window_targets_runtime_version_check
    check (runtime_version = '1.1.21');

alter table public.naver_shopping_finite_window_targets enable row level security;
alter table public.naver_shopping_finite_window_targets force row level security;
revoke all on table public.naver_shopping_finite_window_targets
from public, anon, authenticated, service_role;
grant select on table public.naver_shopping_finite_window_targets
to service_role;

-- Never inherit a prior runtime's cadence proof or report its identity as
-- current. Last-good atomic collection fields deliberately remain untouched.
do $coordination_transition$
declare
  coordination_updated_count integer := 0;
begin
  update public.naver_shopping_worker_coordination
  set cadence_mode = 'baseline',
      cadence_minutes = 10,
      stability_started_at = null,
      success_streak = 0,
      runtime_version = null,
      runtime_fingerprint = null,
      updated_at = clock_timestamp()
  where lane_key = 'global'
    and cadence_mode = 'baseline'
    and cadence_minutes = 10
    and runtime_version = '1.1.20'
    and runtime_fingerprint = '4e0f5fbde16a892e44986b2325865f33d61bdf7a5a13d3d7adcd501608aa8e5b';
  get diagnostics coordination_updated_count = row_count;

  if coordination_updated_count <> 1 then
    raise exception 'naver_shopping_runtime_1_1_21_coordination_mismatch';
  end if;
end
$coordination_transition$;

-- F9: a proven finite market may truthfully end as "not found". The finite
-- terminal keeps every proof predicate; only a matched terminal carries a rank
-- and only a related-catalog terminal carries a relation basis. Each predicate
-- is written so a missing key yields false, never null.
alter table public.naver_shopping_scheduler_events
  drop constraint if exists naver_shopping_scheduler_events_finite_window_committed_check,
  add constraint naver_shopping_scheduler_events_finite_window_committed_check check (
    event_type <> 'finite_window_committed'
    or (
      claim_id is not null
      and run_id is not null
      and worker_id is not null
      and tracker_id is not null
      and group_fingerprint is not null
      and collection_id ~ '^pw-chrome-'
      and checked_count is not null
      and checked_count between 1 and 299
      and details ->> 'source' is not distinct from 'naver_shopping_results_collector'
      and details ->> 'finiteWindowProofVersion' is not distinct from 'stable-finite-window-v1'
      and details -> 'sourceExhausted' is not distinct from 'true'::jsonb
      and details -> 'marketTotal' is not distinct from pg_catalog.to_jsonb(checked_count)
      and (
        (
          details -> 'matched' is not distinct from 'true'::jsonb
          and details ->> 'rank' is not null
          and details ->> 'rank' ~ '^[1-9][0-9]*$'
          and (details ->> 'rank')::integer between 1 and checked_count
        )
        or (
          details -> 'matched' is not distinct from 'false'::jsonb
          and details ->> 'rank' is null
        )
      )
      and (
        details ->> 'relationBasis' is null
        or details ->> 'relationBasis' = 'catalog_seller_product_id'
      )
      and details -> 'atomicSuccessEligible' is not distinct from 'false'::jsonb
    )
  );

-- F9: the finite commit no longer consults naver_shopping_finite_window_targets
-- or any tracker/product/catalog literal. The proof predicates, the single
-- tracker claim, the lane's registered runtime identity and the absence of a
-- failure for the claim are the whole gate. checked_count stays 1..299 so the
-- exact300 path can never be reached through this RPC.
create or replace function public.mi_commit_naver_shopping_finite_worker_result(
  p_tracker_id uuid,
  p_lease_started_at timestamptz,
  p_collection_id text,
  p_checked_at timestamptz,
  p_next_check_at timestamptz,
  p_snapshot jsonb,
  p_product_id text default null,
  p_mall_name text default null,
  p_product_title text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tracker public.naver_rank_trackers%rowtype;
  claim public.naver_shopping_scheduler_events%rowtype;
  current_row public.naver_shopping_worker_coordination%rowtype;
  inserted_snapshot_id uuid;
  finite_checked_count integer;
  finite_matched boolean;
  matched_rank integer;
  market_total integer;
  tracking_rank_source text;
  tracker_claim_count integer := 0;
  finite_event_count integer := 0;
  item jsonb;
begin
  if p_tracker_id is null or p_lease_started_at is null
    or p_collection_id is null or p_collection_id !~ '^pw-chrome-'
    or char_length(p_collection_id) > 160
    or p_checked_at is null or p_next_check_at is null
    or p_snapshot is null or pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'checked_count') is distinct from 'number'
    or (p_snapshot ->> 'checked_count') !~ '^[0-9]+$'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'matched') is distinct from 'boolean'
    or coalesce(pg_catalog.jsonb_typeof(p_snapshot -> 'rank'), 'null') not in ('number', 'null')
    or (
      pg_catalog.jsonb_typeof(p_snapshot -> 'rank') = 'number'
      and (p_snapshot ->> 'rank') !~ '^[1-9][0-9]*$'
    )
    or pg_catalog.jsonb_typeof(p_snapshot -> 'total') is distinct from 'number'
    or (p_snapshot ->> 'total') !~ '^[1-9][0-9]*$'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'item') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'top_items') is distinct from 'array' then
    raise exception 'local_worker_finite_commit_invalid';
  end if;

  finite_checked_count := (p_snapshot ->> 'checked_count')::integer;
  finite_matched := (p_snapshot -> 'matched') = 'true'::jsonb;
  matched_rank := case
    when pg_catalog.jsonb_typeof(p_snapshot -> 'rank') = 'number'
      then (p_snapshot ->> 'rank')::integer
    else null
  end;
  market_total := (p_snapshot ->> 'total')::integer;
  item := p_snapshot -> 'item';
  tracking_rank_source := item ->> 'trackingRankSource';

  -- finite general gate begin
  if finite_checked_count not between 1 and 299
    or market_total is distinct from finite_checked_count
    or (finite_matched and (
      matched_rank is null
      or matched_rank not between 1 and finite_checked_count
      or tracking_rank_source not in ('exact_product', 'related_catalog')
      or item -> 'isOrganic' is distinct from 'true'::jsonb
      or item -> 'isAd' is distinct from 'false'::jsonb
    ))
    or (not finite_matched and (
      matched_rank is not null
      or tracking_rank_source is distinct from 'not_found'
    ))
    or p_snapshot ->> 'source' is distinct from 'naver_shopping_results_collector'
    or item ->> 'finiteWindowProofVersion' is distinct from 'stable-finite-window-v1'
    or item -> 'sourceExhausted' is distinct from 'true'::jsonb
    or item -> 'finiteMarketTotal' is distinct from pg_catalog.to_jsonb(market_total)
    or item -> 'atomicSuccessEligible' is distinct from 'false'::jsonb
    or (tracking_rank_source = 'related_catalog' and (
      item ->> 'relatedCatalogRelationBasis' is distinct from 'catalog_seller_product_id'
      or nullif(pg_catalog.btrim(item ->> 'relatedCatalogProductId'), '') is null
      or item ->> 'catalogId' is distinct from item ->> 'relatedCatalogProductId'
      or pg_catalog.jsonb_typeof(item -> 'catalogSellerProductIds') is distinct from 'array'
      or pg_catalog.jsonb_array_length(item -> 'catalogSellerProductIds') not between 1 and 300
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(item -> 'catalogSellerProductIds') as seller_id(seller_id)
        where seller_id.seller_id !~ '^[0-9]{5,80}$'
      )
    ))
    or item ->> 'rankPolicy' is distinct from 'organic_only'
    or item -> 'adExcluded' is distinct from 'true'::jsonb
    or item ->> 'rankEvidence' is distinct from 'naver_shopping_organic_list'
    or item ->> 'collectionId' is distinct from p_collection_id
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_snapshot -> 'top_items') as top_item
      where top_item -> 'isOrganic' is distinct from 'true'::jsonb
        or top_item -> 'isAd' is distinct from 'false'::jsonb
    ) then
    raise exception 'local_worker_finite_exact_relation_invalid';
  end if;
  -- finite general gate end

  select * into tracker
  from public.naver_rank_trackers
  where id = p_tracker_id
  for update;

  if not found then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  -- A related catalog must list this tracker's own seller product. The
  -- exact-parent snapshot guard enforces the same relation at insert time.
  if tracking_rank_source = 'related_catalog' and (
    tracker.product_id is null
    or pg_catalog.btrim(tracker.product_id) = ''
    or item ->> 'relatedCatalogProductId' = pg_catalog.btrim(tracker.product_id)
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(item -> 'catalogSellerProductIds') as seller_id(seller_id)
      where seller_id.seller_id = pg_catalog.btrim(tracker.product_id)
    )
  ) then
    raise exception 'local_worker_finite_exact_relation_invalid';
  end if;

  if tracker.status <> 'active' then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.processing_started_at is null then
    select snapshot.id into inserted_snapshot_id
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = p_tracker_id
      and snapshot.collection_id = p_collection_id
      and snapshot.source = 'naver_shopping_results_collector'
      and snapshot.checked_count between 1 and 299
      and snapshot.total = snapshot.checked_count
      and (
        (
          snapshot.matched = true
          and snapshot.rank between 1 and snapshot.checked_count
          and snapshot.item ->> 'trackingRankSource' in ('exact_product', 'related_catalog')
        )
        or (
          snapshot.matched = false
          and snapshot.rank is null
          and snapshot.item ->> 'trackingRankSource' = 'not_found'
        )
      )
      and snapshot.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'
      and snapshot.item -> 'sourceExhausted' = 'true'::jsonb
      and snapshot.item -> 'finiteMarketTotal' =
        pg_catalog.to_jsonb(snapshot.checked_count)
      and snapshot.item ->> 'rankPolicy' = 'organic_only'
      and snapshot.item -> 'adExcluded' = 'true'::jsonb
      and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
      and snapshot.item ->> 'collectionId' = snapshot.collection_id
      and snapshot.item -> 'atomicSuccessEligible' = 'false'::jsonb
      and pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(snapshot.top_items) as top_item
        where top_item -> 'isOrganic' is distinct from 'true'::jsonb
          or top_item -> 'isAd' is distinct from 'false'::jsonb
      )
      and exists (
        select 1
        from public.naver_shopping_scheduler_events as committed
        join public.naver_shopping_scheduler_events as representative_claim
          on representative_claim.event_type = 'tracker_claimed'
         and representative_claim.claim_id = committed.claim_id
         and representative_claim.run_id = committed.run_id
         and representative_claim.worker_id = committed.worker_id
         and representative_claim.tracker_id = committed.tracker_id
         and representative_claim.group_fingerprint = committed.group_fingerprint
         and representative_claim.lease_started_at = committed.lease_started_at
         and representative_claim.priority = committed.priority
         and representative_claim.event_id < committed.event_id
        where committed.event_type = 'finite_window_committed'
          and committed.tracker_id = snapshot.tracker_id
          and committed.collection_id = snapshot.collection_id
          and committed.checked_count = snapshot.checked_count
          and committed.occurred_at = snapshot.checked_at
          and committed.priority in ('new', 'resume', 'normal', 'repair')
          and committed.details ->> 'source' is not distinct from snapshot.source
          and committed.details ->> 'finiteWindowProofVersion'
            is not distinct from 'stable-finite-window-v1'
          and committed.details -> 'sourceExhausted'
            is not distinct from 'true'::jsonb
          and committed.details -> 'marketTotal'
            is not distinct from pg_catalog.to_jsonb(snapshot.total)
          and committed.details -> 'matched'
            is not distinct from pg_catalog.to_jsonb(snapshot.matched)
          and committed.details -> 'rank'
            is not distinct from pg_catalog.to_jsonb(snapshot.rank)
          and committed.details ->> 'relationBasis'
            is not distinct from case
              when snapshot.item ->> 'trackingRankSource' = 'related_catalog'
                then 'catalog_seller_product_id'
              else null
            end
          and committed.details -> 'atomicSuccessEligible'
            is not distinct from 'false'::jsonb
          and (
            select count(*)
            from public.naver_shopping_scheduler_events as claimed
            where claimed.event_type = 'tracker_claimed'
              and claimed.claim_id = committed.claim_id
          ) = 1
          and (
            select count(*)
            from public.naver_shopping_scheduler_events as finite_terminal
            where finite_terminal.event_type = 'finite_window_committed'
              and finite_terminal.tracker_id = snapshot.tracker_id
              and finite_terminal.collection_id = snapshot.collection_id
          ) = 1
          and not exists (
            select 1
            from public.naver_shopping_scheduler_events as conflicting_terminal
            where conflicting_terminal.claim_id = committed.claim_id
              and conflicting_terminal.tracker_id = snapshot.tracker_id
              and conflicting_terminal.event_type in ('tracker_committed', 'job_failed')
          )
      );
    if inserted_snapshot_id is not null then
      return jsonb_build_object('status', 'already_committed', 'snapshotId', inserted_snapshot_id);
    end if;
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.processing_started_at is distinct from p_lease_started_at
    or tracker.processing_until is null
    or tracker.processing_until <= clock_timestamp() then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  select event.* into claim
  from public.naver_shopping_scheduler_events as event
  where event.event_type = 'tracker_claimed'
    and event.tracker_id = p_tracker_id
    and event.lease_started_at = p_lease_started_at
  order by event.event_id desc
  limit 1;
  if not found or claim.run_id is null or claim.claim_id is null
    or claim.worker_id is null
    or claim.priority not in ('new', 'resume', 'normal', 'repair') then
    raise exception 'local_worker_finite_claim_invalid';
  end if;

  select count(*)::integer into tracker_claim_count
  from public.naver_shopping_scheduler_events as claimed
  where claimed.event_type = 'tracker_claimed'
    and claimed.claim_id = claim.claim_id;
  if tracker_claim_count <> 1 then
    raise exception 'local_worker_finite_group_invalid';
  end if;

  -- The lane must still be held by the claiming worker and run, and that run
  -- must carry the runtime identity the lane registered through the progress
  -- RPC (which accepts only the expected runtime). Keyword groups may hold
  -- several trackers, so the lane's current tracker is not pinned here.
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global';
  if not found
    or current_row.lease_worker_id is distinct from claim.worker_id
    or current_row.run_id is distinct from claim.run_id
    or current_row.runtime_version is null
    or current_row.runtime_fingerprint is null
    or current_row.current_job_kind is distinct from 'tracker'
    or current_row.lease_until is null
    or current_row.lease_until <= clock_timestamp()
    or current_row.circuit_state = 'open'
    or not exists (
      select 1
      from public.naver_shopping_worker_runs as runs
      where runs.run_id = claim.run_id
        and runs.worker_id = claim.worker_id
        and runs.runtime_version = current_row.runtime_version
        and runs.runtime_fingerprint = current_row.runtime_fingerprint
    )
    or exists (
      select 1
      from public.naver_shopping_scheduler_events as failed
      where failed.event_type = 'job_failed'
        and failed.claim_id = claim.claim_id
    ) then
    raise exception 'local_worker_finite_control_invalid';
  end if;

  select id into inserted_snapshot_id
  from public.naver_rank_snapshots
  where tracker_id = p_tracker_id and collection_id = p_collection_id;
  if inserted_snapshot_id is not null then
    update public.naver_rank_trackers
    set processing_started_at = null,
        processing_until = null,
        next_check_at = clock_timestamp() + interval '5 minutes',
        last_message = '중복 수집 묶음을 차단하고 다시 갱신합니다. 마지막 정상 순위는 유지합니다.',
        last_error = 'local_worker_collection_conflict',
        retry_count = coalesce(retry_count, 0) + 1
    where id = p_tracker_id
      and status = 'active'
      and processing_started_at = p_lease_started_at;
    return jsonb_build_object('status', 'collection_conflict', 'snapshotId', inserted_snapshot_id);
  end if;

  insert into public.naver_rank_snapshots(
    tracker_id, checked_at, collection_id, rank, page, position, matched,
    checked_count, total, item, top_items, message, source
  ) values (
    p_tracker_id,
    p_checked_at,
    p_collection_id,
    matched_rank,
    case when finite_matched then nullif((p_snapshot ->> 'page')::integer, 0) else null end,
    case when finite_matched then nullif((p_snapshot ->> 'position')::integer, 0) else null end,
    finite_matched,
    finite_checked_count,
    market_total,
    item,
    p_snapshot -> 'top_items',
    nullif(p_snapshot ->> 'message', ''),
    'naver_shopping_results_collector'
  )
  on conflict (tracker_id, collection_id) where collection_id is not null do nothing
  returning id into inserted_snapshot_id;

  if inserted_snapshot_id is null then
    select id into inserted_snapshot_id
    from public.naver_rank_snapshots
    where tracker_id = p_tracker_id and collection_id = p_collection_id;
    update public.naver_rank_trackers
    set processing_started_at = null,
        processing_until = null,
        next_check_at = clock_timestamp() + interval '5 minutes',
        last_message = '중복 수집 묶음을 차단하고 다시 갱신합니다. 마지막 정상 순위는 유지합니다.',
        last_error = 'local_worker_collection_conflict',
        retry_count = coalesce(retry_count, 0) + 1
    where id = p_tracker_id
      and status = 'active'
      and processing_started_at = p_lease_started_at;
    return jsonb_build_object('status', 'collection_conflict', 'snapshotId', inserted_snapshot_id);
  end if;

  select count(*)::integer into finite_event_count
  from public.naver_shopping_scheduler_events as committed
  where committed.event_type = 'finite_window_committed'
    and committed.claim_id = claim.claim_id
    and committed.run_id = claim.run_id
    and committed.worker_id = claim.worker_id
    and committed.tracker_id = p_tracker_id
    and committed.collection_id = p_collection_id
    and committed.checked_count = finite_checked_count;
  if finite_event_count <> 1 then
    raise exception 'local_worker_finite_ledger_missing';
  end if;

  update public.naver_rank_trackers
  set last_checked_at = p_checked_at,
      next_check_at = p_next_check_at,
      current_rank = matched_rank,
      best_rank = case when matched_rank is null then best_rank
        else least(coalesce(best_rank, matched_rank), matched_rank) end,
      worst_rank = case when matched_rank is null then worst_rank
        else greatest(coalesce(worst_rank, matched_rank), matched_rank) end,
      check_count = coalesce(check_count, 0) + 1,
      found_count = coalesce(found_count, 0) + case when matched_rank is null then 0 else 1 end,
      last_message = nullif(p_snapshot ->> 'message', ''),
      last_error = null,
      retry_count = 0,
      processing_started_at = null,
      processing_until = null
  where id = p_tracker_id
    and status = 'active'
    and processing_started_at = p_lease_started_at
    and processing_until > clock_timestamp();

  if not found then
    raise exception 'local_worker_finite_lease_lost_after_snapshot';
  end if;

  return jsonb_build_object(
    'status', 'committed',
    'snapshotId', inserted_snapshot_id,
    'finiteWindow', true,
    'atomicSuccessEligible', false
  );
end;
$$;

-- F9: the finite ledger branch mirrors the exact300 branch. It no longer joins
-- naver_shopping_finite_window_targets, worker runs, the coordination row or a
-- single-member group, and it accepts repair-priority claims. The exact300
-- branch below is byte-for-byte the deployed definition.
create or replace function mi_internal.mi_audit_naver_shopping_snapshot_commit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.naver_shopping_scheduler_events(
    occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id,
    worker_id, tracker_id, agency_code, group_fingerprint, priority,
    lease_started_at, lease_until, collection_id, checked_count, details
  )
  select
    snapshot.checked_at,
    'tracker_committed',
    claim.cycle_id,
    claim.cycle_number,
    claim.claim_id,
    claim.run_id,
    claim.worker_id,
    snapshot.tracker_id,
    tracker.agency_code,
    claim.group_fingerprint,
    claim.priority,
    claim.lease_started_at,
    claim.lease_until,
    snapshot.collection_id,
    snapshot.checked_count::smallint,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'matched', snapshot.matched,
      'rank', snapshot.rank,
      'source', snapshot.source,
      'crossPageProofVersion', case
        when snapshot.item ->> 'crossPageProofVersion' = 'stable-full-window-v1'
          then 'stable-full-window-v1'
        else null
      end
    ))
  from new_snapshots as snapshot
  join public.naver_rank_trackers as tracker
    on tracker.id = snapshot.tracker_id
  join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.tracker_id = snapshot.tracker_id
      and event.lease_started_at = tracker.processing_started_at
    order by event.event_id desc
    limit 1
  ) as claim on true
  where snapshot.source = 'naver_shopping_results_collector'
    and snapshot.checked_count = 300
    and snapshot.collection_id ~ '^pw-chrome-';

  insert into public.naver_shopping_scheduler_events(
    occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id,
    worker_id, tracker_id, agency_code, group_fingerprint, priority,
    lease_started_at, lease_until, collection_id, checked_count, details
  )
  select
    snapshot.checked_at,
    'finite_window_committed',
    claim.cycle_id,
    claim.cycle_number,
    claim.claim_id,
    claim.run_id,
    claim.worker_id,
    snapshot.tracker_id,
    tracker.agency_code,
    claim.group_fingerprint,
    claim.priority,
    claim.lease_started_at,
    claim.lease_until,
    snapshot.collection_id,
    snapshot.checked_count::smallint,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'matched', snapshot.matched,
      'rank', snapshot.rank,
      'source', snapshot.source,
      'finiteWindowProofVersion', 'stable-finite-window-v1',
      'sourceExhausted', true,
      'marketTotal', snapshot.total,
      'relationBasis', case
        when snapshot.item ->> 'trackingRankSource' = 'related_catalog'
          then 'catalog_seller_product_id'
        else null
      end,
      'atomicSuccessEligible', false
    ))
  from new_snapshots as snapshot
  join public.naver_rank_trackers as tracker
    on tracker.id = snapshot.tracker_id
  join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.tracker_id = snapshot.tracker_id
      and event.lease_started_at = tracker.processing_started_at
    order by event.event_id desc
    limit 1
  ) as claim on true
  where snapshot.source = 'naver_shopping_results_collector'
    and snapshot.collection_id ~ '^pw-chrome-'
    and snapshot.checked_count between 1 and 299
    and snapshot.total = snapshot.checked_count
    and (
      (
        snapshot.matched = true
        and snapshot.rank between 1 and snapshot.checked_count
        and snapshot.item ->> 'trackingRankSource' in ('exact_product', 'related_catalog')
        and snapshot.item -> 'isOrganic' = 'true'::jsonb
        and snapshot.item -> 'isAd' = 'false'::jsonb
      )
      or (
        snapshot.matched = false
        and snapshot.rank is null
        and snapshot.item ->> 'trackingRankSource' = 'not_found'
      )
    )
    and (
      snapshot.item ->> 'trackingRankSource' <> 'related_catalog'
      or (
        snapshot.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'
        and snapshot.item ->> 'catalogId' = snapshot.item ->> 'relatedCatalogProductId'
        and pg_catalog.jsonb_typeof(snapshot.item -> 'catalogSellerProductIds') = 'array'
        and pg_catalog.jsonb_array_length(snapshot.item -> 'catalogSellerProductIds') between 1 and 300
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(
            snapshot.item -> 'catalogSellerProductIds'
          ) as seller_id(seller_id)
          where seller_id.seller_id = pg_catalog.btrim(tracker.product_id)
        )
      )
    )
    and snapshot.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'
    and snapshot.item -> 'sourceExhausted' = 'true'::jsonb
    and snapshot.item -> 'finiteMarketTotal' = pg_catalog.to_jsonb(snapshot.checked_count)
    and snapshot.item -> 'atomicSuccessEligible' = 'false'::jsonb
    and snapshot.item ->> 'rankPolicy' = 'organic_only'
    and snapshot.item -> 'adExcluded' = 'true'::jsonb
    and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
    and snapshot.item ->> 'collectionId' = snapshot.collection_id
    and claim.priority in ('new', 'resume', 'normal', 'repair')
    and pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(snapshot.top_items) as top_item
      where top_item -> 'isOrganic' is distinct from 'true'::jsonb
        or top_item -> 'isAd' is distinct from 'false'::jsonb
    )
    and (
      select count(*)
      from public.naver_shopping_scheduler_events as claimed
      where claimed.event_type = 'tracker_claimed'
        and claimed.claim_id = claim.claim_id
    ) = 1
    and not exists (
      select 1
      from public.naver_shopping_scheduler_events as failed
      where failed.event_type = 'job_failed'
        and failed.claim_id = claim.claim_id
    );

  return null;
end;
$$;

-- The deployed exact-parent guard (20260827050000) spells NULLIF/COALESCE as
-- pg_catalog.nullif/pg_catalog.coalesce. They are grammar constructs, not
-- functions, so PostgreSQL raises 42883 on every related_catalog snapshot
-- insert. This is the guard that replaces the canary allowlist for parent
-- catalogs, so it is re-declared with byte-identical logic and the plain
-- constructs. The trigger binding itself is unchanged.
create or replace function mi_internal.mi_guard_naver_shopping_exact_parent_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_product_id text;
  related_catalog_id text;
  selected_catalog_id text;
begin
  if new.item ->> 'trackingRankSource' is distinct from 'related_catalog' then
    return new;
  end if;

  select tracker.product_id
  into target_product_id
  from public.naver_rank_trackers as tracker
  where tracker.id = new.tracker_id;

  if not found then
    raise exception 'naver_shopping_exact_parent_relation_invalid'
      using errcode = 'check_violation';
  end if;

  related_catalog_id := nullif(
    pg_catalog.btrim(new.item ->> 'relatedCatalogProductId'),
    ''
  );
  selected_catalog_id := coalesce(
    nullif(pg_catalog.btrim(new.item ->> 'catalogId'), ''),
    nullif(pg_catalog.btrim(new.item ->> 'productId'), '')
  );

  if target_product_id is null
    or pg_catalog.btrim(target_product_id) = ''
    or related_catalog_id is null
    or related_catalog_id = pg_catalog.btrim(target_product_id)
    or selected_catalog_id is distinct from related_catalog_id
    or new.item ->> 'relatedCatalogRelationBasis'
      is distinct from 'catalog_seller_product_id'
    or pg_catalog.jsonb_typeof(new.item -> 'catalogSellerProductIds')
      is distinct from 'array'
    or not (
      new.item -> 'catalogSellerProductIds'
        @> pg_catalog.jsonb_build_array(pg_catalog.btrim(target_product_id))
    ) then
    raise exception 'naver_shopping_exact_parent_relation_invalid'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function mi_internal.mi_guard_naver_shopping_exact_parent_snapshot()
from public, anon, authenticated, service_role;

create or replace function public.mi_report_naver_shopping_worker_progress(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_stage text,
  p_page integer,
  p_job_kind text,
  p_tracker_id uuid,
  p_runtime_version text,
  p_runtime_fingerprint text,
  p_run_trigger text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  expected_runtime_version constant text := '1.1.21';
  expected_runtime_fingerprint constant text :=
    '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0';
  updated_count integer := 0;
  normalized_stage text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_stage, '')));
  normalized_kind text := nullif(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_job_kind, ''))), ''
  );
  normalized_trigger text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_run_trigger, '')));
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_stage not in (
      'claiming', 'navigating', 'collecting', 'submitting', 'completed', 'failed'
    )
    or coalesce(p_page, -1) not between 0 and 8
    or (normalized_kind is not null and normalized_kind not in ('lookup', 'tracker'))
    or normalized_trigger not in (
      'manual',
      'rank-catch-up',
      'rank-0900',
      'rank-1500',
      'rank-remote',
      'mac-standby',
      'github-cloud'
    )
    or pg_catalog.btrim(coalesce(p_runtime_version, ''))
      is distinct from expected_runtime_version
    or pg_catalog.lower(pg_catalog.btrim(coalesce(p_runtime_fingerprint, '')))
      is distinct from expected_runtime_fingerprint then
    return false;
  end if;

  update public.naver_shopping_worker_coordination
  set cadence_mode = case
        when runtime_version is distinct from expected_runtime_version
          or runtime_fingerprint is distinct from expected_runtime_fingerprint
        then 'baseline'
        else cadence_mode
      end,
      cadence_minutes = case
        when runtime_version is distinct from expected_runtime_version
          or runtime_fingerprint is distinct from expected_runtime_fingerprint
        then 10
        else cadence_minutes
      end,
      stability_started_at = case
        when runtime_version is distinct from expected_runtime_version
          or runtime_fingerprint is distinct from expected_runtime_fingerprint
        then null
        else stability_started_at
      end,
      success_streak = case
        when runtime_version is distinct from expected_runtime_version
          or runtime_fingerprint is distinct from expected_runtime_fingerprint
        then 0
        else success_streak
      end,
      run_id = p_run_id,
      runtime_version = expected_runtime_version,
      runtime_fingerprint = expected_runtime_fingerprint,
      current_stage = normalized_stage,
      current_page = p_page,
      current_job_kind = normalized_kind,
      current_tracker_id = p_tracker_id,
      current_job_started_at = coalesce(current_job_started_at, v_now),
      updated_at = v_now
  where lane_key = 'global'
    and lease_worker_id = pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and lease_until > v_now
    and circuit_state <> 'open'
    and (run_id is null or run_id = p_run_id);
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    return false;
  end if;

  if normalized_stage = 'navigating' then
    insert into public.naver_shopping_worker_runs(
      run_id,
      worker_id,
      run_trigger,
      runtime_version,
      runtime_fingerprint,
      started_at
    ) values (
      p_run_id,
      pg_catalog.lower(pg_catalog.btrim(p_worker_id)),
      normalized_trigger,
      expected_runtime_version,
      expected_runtime_fingerprint,
      v_now
    )
    on conflict (run_id) do nothing;

    if not exists (
      select 1
      from public.naver_shopping_worker_runs as recorded_run
      where recorded_run.run_id = p_run_id
        and recorded_run.worker_id = pg_catalog.lower(pg_catalog.btrim(p_worker_id))
        and recorded_run.run_trigger = normalized_trigger
        and recorded_run.runtime_version = expected_runtime_version
        and recorded_run.runtime_fingerprint = expected_runtime_fingerprint
    ) then
      raise exception 'naver_shopping_worker_run_provenance_mismatch';
    end if;
  end if;

  return true;
end;
$$;

create or replace function public.mi_set_naver_shopping_worker_cadence(
  p_mode text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_mode text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_mode, '')));
  current_row public.naver_shopping_worker_coordination%rowtype;
  expected_runtime_version constant text := '1.1.21';
  expected_runtime_fingerprint constant text :=
    '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0';
  processing_count integer := 0;
  updated_count integer := 0;
  eligible boolean := false;
  v_now timestamptz;
begin
  if normalized_mode not in ('baseline', 'candidate') then
    return pg_catalog.jsonb_build_object('accepted', false, 'reason', 'mode_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  v_now := clock_timestamp();

  select (
    (select count(*) from public.naver_shopping_rank_lookup_jobs
      where status = 'processing' and processing_until > v_now)
    +
    (select count(*) from public.naver_rank_trackers
      where status = 'active' and processing_until > v_now)
  )::integer into processing_count;

  if normalized_mode = 'baseline' then
    update public.naver_shopping_worker_coordination
    set cadence_mode = 'baseline', cadence_minutes = 10, updated_at = v_now
    where lane_key = 'global';
    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      return pg_catalog.jsonb_build_object(
        'accepted', false,
        'activated', false,
        'reason', 'coordination_missing',
        'mode', null,
        'minutes', null
      );
    end if;
    select * into current_row
    from public.naver_shopping_worker_coordination
    where lane_key = 'global';
    if current_row.cadence_mode is distinct from 'baseline'
      or current_row.cadence_minutes is distinct from 10 then
      return pg_catalog.jsonb_build_object(
        'accepted', false,
        'activated', false,
        'reason', 'baseline_postcheck_failed',
        'mode', current_row.cadence_mode,
        'minutes', current_row.cadence_minutes
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true,
      'activated', true,
      'mode', 'baseline',
      'minutes', 10
    );
  end if;

  eligible := coalesce((
    current_row.circuit_state = 'closed'
    and current_row.circuit_reason is null
    and processing_count = 0
    and current_row.lease_worker_id is null
    and current_row.lease_token is null
    and current_row.lease_until is null
    and current_row.run_id is null
    and current_row.current_stage is null
    and current_row.current_page = 0
    and current_row.current_job_kind is null
    and current_row.current_tracker_id is null
    and current_row.current_job_started_at is null
    and current_row.probe_started_at is null
    and current_row.probe_tracker_id is null
    and current_row.cooldown_until is null
    and current_row.primary_worker_id = 'windows-desktop-primary'
    and current_row.primary_seen_at > v_now - interval '3 minutes'
    and current_row.cadence_mode = 'baseline'
    and current_row.cadence_minutes = 10
    and current_row.stability_started_at is not null
    and current_row.stability_started_at <= v_now - interval '24 hours'
    and current_row.success_streak >= 6
    and current_row.last_success_at is not null
    and current_row.last_success_at > v_now - interval '15 minutes'
    and current_row.runtime_version = expected_runtime_version
    and current_row.runtime_fingerprint = expected_runtime_fingerprint
    and current_row.last_collection_id ~ '^pw-chrome-'
    and current_row.last_checked_count = 300
    and current_row.last_source = 'naver_shopping_results_collector'
  ), false);
  if eligible is not true then
    return pg_catalog.jsonb_build_object(
      'accepted', false,
      'activated', false,
      'reason', 'not_eligible',
      'mode', current_row.cadence_mode,
      'minutes', current_row.cadence_minutes
    );
  end if;

  update public.naver_shopping_worker_coordination
  set cadence_mode = 'candidate', cadence_minutes = 6, updated_at = v_now
  where lane_key = 'global';
  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'activated', true,
    'mode', 'candidate',
    'minutes', 6
  );
end;
$$;

create or replace function public.mi_get_naver_shopping_worker_operations()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  expected_runtime_version constant text := '1.1.21';
  expected_runtime_fingerprint constant text :=
    '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0';
  lookup_pending_count integer := 0;
  tracker_pending_count integer := 0;
  processing_count integer := 0;
  lookup_oldest_at timestamptz;
  tracker_oldest_at timestamptz;
  canary_tracker_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global';

  select count(*)::integer, min(available_at)
  into lookup_pending_count, lookup_oldest_at
  from public.naver_shopping_rank_lookup_jobs
  where expires_at > v_now
    and attempts < 3
    and (
      (status = 'pending' and available_at <= v_now)
      or (status = 'processing' and processing_until <= v_now)
    );

  select count(*)::integer, min(next_check_at)
  into tracker_pending_count, tracker_oldest_at
  from public.naver_rank_trackers
  where status = 'active'
    and next_check_at <= v_now
    and (processing_until is null or processing_until <= v_now)
    and (worker_quarantined_until is null or worker_quarantined_until <= v_now);

  select (
    (select count(*) from public.naver_shopping_rank_lookup_jobs
      where status = 'processing' and processing_until > v_now)
    +
    (select count(*) from public.naver_rank_trackers
      where status = 'active' and processing_until > v_now)
  )::integer into processing_count;

  select id into canary_tracker_id
  from public.naver_rank_trackers
  where status = 'active'
    and pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(keyword)), '\s+', '', 'g'
    ) = '남자팬티'
    and product_id = '12491798995'
  order by created_at asc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'circuit_state', current_row.circuit_state,
    'circuit_reason', current_row.circuit_reason,
    'circuit_opened_at', current_row.circuit_opened_at,
    'failure_signature', current_row.failure_signature,
    'failure_streak', current_row.failure_streak,
    'transient_system_probe_attempts', current_row.transient_system_probe_attempts,
    'probe_tracker_id', current_row.probe_tracker_id,
    'probe_started_at', current_row.probe_started_at,
    'primary_worker_id', current_row.primary_worker_id,
    'primary_seen_at', current_row.primary_seen_at,
    'lease_worker_id', current_row.lease_worker_id,
    'lease_until', current_row.lease_until,
    'cooldown_until', current_row.cooldown_until,
    'last_block_code', current_row.last_block_code,
    'run_id', current_row.run_id,
    'runtime_version', current_row.runtime_version,
    'runtime_fingerprint', current_row.runtime_fingerprint,
    'current_stage', current_row.current_stage,
    'current_page', current_row.current_page,
    'current_job_kind', current_row.current_job_kind,
    'current_tracker_id', current_row.current_tracker_id,
    'current_job_started_at', current_row.current_job_started_at,
    'last_success_at', current_row.last_success_at,
    'last_failure_at', current_row.last_failure_at,
    'last_failure_code', current_row.last_failure_code,
    'last_collection_id', current_row.last_collection_id,
    'last_checked_count', current_row.last_checked_count,
    'last_excluded_ad_count', current_row.last_excluded_ad_count,
    'last_duration_ms', current_row.last_duration_ms,
    'last_source', current_row.last_source,
    'scheduler_urgent_streak', current_row.scheduler_urgent_streak,
    'scheduler_last_agency_code', current_row.scheduler_last_agency_code,
    'cadence_mode', current_row.cadence_mode,
    'cadence_minutes', current_row.cadence_minutes,
    'stability_started_at', current_row.stability_started_at,
    'success_streak', current_row.success_streak,
    'candidate_eligible', coalesce((
      current_row.circuit_state = 'closed'
      and current_row.circuit_reason is null
      and processing_count = 0
      and current_row.lease_worker_id is null
      and current_row.lease_token is null
      and current_row.lease_until is null
      and current_row.run_id is null
      and current_row.current_stage is null
      and current_row.current_page = 0
      and current_row.current_job_kind is null
      and current_row.current_tracker_id is null
      and current_row.current_job_started_at is null
      and current_row.probe_started_at is null
      and current_row.probe_tracker_id is null
      and current_row.cooldown_until is null
      and current_row.primary_worker_id = 'windows-desktop-primary'
      and current_row.primary_seen_at > v_now - interval '3 minutes'
      and current_row.cadence_mode = 'baseline'
      and current_row.cadence_minutes = 10
      and current_row.stability_started_at is not null
      and current_row.stability_started_at <= v_now - interval '24 hours'
      and current_row.success_streak >= 6
      and current_row.last_success_at is not null
      and current_row.last_success_at > v_now - interval '15 minutes'
      and current_row.runtime_version = expected_runtime_version
      and current_row.runtime_fingerprint = expected_runtime_fingerprint
      and current_row.last_collection_id ~ '^pw-chrome-'
      and current_row.last_checked_count = 300
      and current_row.last_source = 'naver_shopping_results_collector'
    ), false),
    'canary_tracker_id', canary_tracker_id,
    'pending_count', lookup_pending_count + tracker_pending_count,
    'lookup_pending_count', lookup_pending_count,
    'tracker_pending_count', tracker_pending_count,
    'processing_count', processing_count,
    'oldest_pending_at', case
      when lookup_oldest_at is null then tracker_oldest_at
      when tracker_oldest_at is null then lookup_oldest_at
      else least(lookup_oldest_at, tracker_oldest_at)
    end
  );
end;
$$;

create or replace function public.mi_record_naver_shopping_worker_failure(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_error_code text,
  p_scope text,
  p_tracker_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  target public.naver_shopping_finite_window_targets%rowtype;
  expected_runtime_version constant text := '1.1.21';
  expected_runtime_fingerprint constant text :=
    '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0';
  normalized_error text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, '')));
  normalized_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_scope, '')));
  next_signature text;
  next_streak integer;
  tracker_updated_count integer := 0;
  should_open boolean := false;
  partial_window_failure boolean := normalized_scope = 'tracker'
    and normalized_error ~ '^provider_partial_window:([1-9]|[1-9][0-9]|[12][0-9]{2})_300$';
  finite_canary_failure boolean := normalized_scope = 'tracker'
    and p_tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and normalized_error in (
      'provider_stable_finite_window_unproven',
      'local_worker_finite_match_invalid'
    );
  finite_target_available boolean := false;
  finite_tracker_exact boolean := false;
  cadence_proof_preserved boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_error !~ '^[a-z0-9_:-]{3,80}$'
    or normalized_scope not in ('system', 'tracker', 'security', 'lookup')
    or (normalized_scope = 'tracker' and p_tracker_id is null)
    or (normalized_scope = 'lookup' and p_tracker_id is not null) then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'failure_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and run_id = p_run_id
    and lease_until > v_now
    and circuit_state <> 'open'
    and (normalized_scope <> 'lookup' or circuit_state = 'closed')
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'lease_lost');
  end if;

  select * into target
  from public.naver_shopping_finite_window_targets
  where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and seller_product_id = '13327339525'
    and parent_catalog_id = '59776958987'
    and proof_version = 'stable-finite-window-v1'
    and runtime_version = expected_runtime_version
    and runtime_fingerprint = expected_runtime_fingerprint
    and enabled = true;
  finite_target_available := found;

  select exists (
    select 1
    from public.naver_rank_trackers as tracker
    where tracker.id = p_tracker_id
      and tracker.status = 'active'
      and tracker.product_id = target.seller_product_id
      and pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.btrim(tracker.keyword)),
        '\s+',
        '',
        'g'
      ) = target.normalized_keyword
  ) into finite_tracker_exact;

  if normalized_scope = 'tracker' then
    update public.naver_rank_trackers
    set worker_quarantined_until = case
      when finite_canary_failure
        and finite_target_available
        and finite_tracker_exact
        and current_row.runtime_version = target.runtime_version
        and current_row.runtime_fingerprint = target.runtime_fingerprint
      then v_now + interval '30 minutes'
      when pg_catalog.split_part(normalized_error, ':', 1) in (
        'provider_duplicate_identity',
        'provider_stable_window_unproven',
        'provider_stable_rendered_order_unproven',
        'provider_rendered_order_candidate_invalid'
      ) then v_now + interval '30 minutes'
      else greatest(
        coalesce(worker_quarantined_until, v_now),
        v_now + case
          when coalesce(retry_count, 0) >= 2 then interval '24 hours'
          else interval '30 minutes'
        end
      )
    end
    where id = p_tracker_id;
    get diagnostics tracker_updated_count = row_count;

    cadence_proof_preserved := tracker_updated_count = 1
      and current_row.circuit_state = 'closed'
      and current_row.circuit_reason is null
      and current_row.cooldown_until is null
      and current_row.probe_tracker_id is null
      and current_row.probe_started_at is null
      and current_row.current_job_kind = 'tracker'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, '')))
        = 'windows-desktop-primary'
      and current_row.primary_worker_id = 'windows-desktop-primary'
      and current_row.primary_seen_at > v_now - interval '3 minutes'
      and (
        (current_row.cadence_mode = 'baseline' and current_row.cadence_minutes = 10)
        or (current_row.cadence_mode = 'candidate' and current_row.cadence_minutes = 6)
      )
      and current_row.stability_started_at is not null
      and current_row.success_streak >= 1
      and current_row.last_collection_id ~ '^pw-chrome-'
      and current_row.last_checked_count = 300
      and current_row.last_source = 'naver_shopping_results_collector'
      and current_row.runtime_version = expected_runtime_version
      and current_row.runtime_fingerprint = expected_runtime_fingerprint
      and (
        (
          partial_window_failure
          and current_row.current_page = 8
          and (
            current_row.current_stage = 'collecting'
            or (
              current_row.current_stage = 'failed'
              and current_row.last_failure_code = normalized_error
              and current_row.last_failure_at is not null
              and current_row.last_failure_at >= current_row.current_job_started_at
            )
          )
          and exists (
            select 1
            from public.naver_shopping_scheduler_events as failed_event
            join public.naver_shopping_scheduler_events as representative_claim
              on representative_claim.event_type = 'tracker_claimed'
             and representative_claim.run_id = failed_event.run_id
             and representative_claim.claim_id = failed_event.claim_id
             and representative_claim.group_fingerprint = failed_event.group_fingerprint
            join public.naver_shopping_worker_runs as runs
              on runs.run_id = failed_event.run_id
             and runs.worker_id = failed_event.worker_id
             and runs.runtime_version = expected_runtime_version
             and runs.runtime_fingerprint = expected_runtime_fingerprint
            where failed_event.event_type = 'job_failed'
              and failed_event.run_id = p_run_id
              and failed_event.worker_id = current_row.lease_worker_id
              and failed_event.tracker_id = p_tracker_id
              and failed_event.error_code = normalized_error
              and representative_claim.tracker_id = current_row.current_tracker_id
              and representative_claim.worker_id = current_row.lease_worker_id
          )
        )
        or (
          finite_canary_failure
          and finite_tracker_exact
          and current_row.current_tracker_id = p_tracker_id
          and current_row.current_page between 1 and 8
          and (
            (
              current_row.current_stage = 'collecting'
              and normalized_error = 'provider_stable_finite_window_unproven'
            )
            or (
              current_row.current_stage = 'submitting'
              and normalized_error = 'local_worker_finite_match_invalid'
            )
            or (
              current_row.current_stage = 'failed'
              and current_row.last_failure_code = normalized_error
              and current_row.last_failure_at is not null
              and current_row.last_failure_at >= current_row.current_job_started_at
            )
          )
          and exists (
            select 1
            from public.naver_shopping_scheduler_events as failed_event
            join public.naver_shopping_scheduler_events as representative_claim
              on representative_claim.event_type = 'tracker_claimed'
             and representative_claim.run_id = failed_event.run_id
             and representative_claim.claim_id = failed_event.claim_id
             and representative_claim.group_fingerprint = failed_event.group_fingerprint
             and representative_claim.tracker_id = p_tracker_id
             and representative_claim.worker_id = failed_event.worker_id
             and representative_claim.event_id < failed_event.event_id
             and representative_claim.priority in ('new', 'resume', 'normal')
            join public.naver_shopping_scheduler_events as grouped
              on grouped.event_type = 'group_claimed'
             and grouped.claim_id = representative_claim.claim_id
             and grouped.run_id = representative_claim.run_id
             and grouped.worker_id = representative_claim.worker_id
             and grouped.group_fingerprint = representative_claim.group_fingerprint
             and grouped.details -> 'memberCount' = pg_catalog.to_jsonb(1)
             and grouped.event_id < representative_claim.event_id
            join public.naver_shopping_worker_runs as runs
              on runs.run_id = failed_event.run_id
             and runs.worker_id = failed_event.worker_id
             and runs.run_trigger = 'rank-catch-up'
             and runs.runtime_version = expected_runtime_version
             and runs.runtime_fingerprint = expected_runtime_fingerprint
            where failed_event.event_type = 'job_failed'
              and failed_event.run_id = p_run_id
              and failed_event.worker_id = current_row.lease_worker_id
              and failed_event.tracker_id = p_tracker_id
              and failed_event.error_code = normalized_error
              and (
                select count(*)
                from public.naver_shopping_scheduler_events as claimed
                where claimed.event_type = 'tracker_claimed'
                  and claimed.claim_id = representative_claim.claim_id
              ) = 1
              and not exists (
                select 1
                from public.naver_shopping_scheduler_events as terminal
                where terminal.claim_id = representative_claim.claim_id
                  and terminal.tracker_id = p_tracker_id
                  and terminal.event_type in (
                    'tracker_committed',
                    'finite_window_committed'
                  )
              )
              and (
                select count(*)
                from public.naver_shopping_scheduler_events as finite_failed_count
                where finite_failed_count.event_type = 'job_failed'
                  and finite_failed_count.claim_id = representative_claim.claim_id
                  and finite_failed_count.run_id = p_run_id
                  and finite_failed_count.worker_id = current_row.lease_worker_id
                  and finite_failed_count.tracker_id = p_tracker_id
                  and finite_failed_count.error_code = normalized_error
              ) = 1
          )
        )
      );

    update public.naver_shopping_worker_coordination
    set last_failure_at = v_now,
        last_failure_code = normalized_error,
        current_stage = 'failed',
        cadence_mode = case
          when cadence_proof_preserved then current_row.cadence_mode
          else 'baseline'
        end,
        cadence_minutes = case
          when cadence_proof_preserved then current_row.cadence_minutes
          else 10
        end,
        stability_started_at = case
          when cadence_proof_preserved then current_row.stability_started_at
          else null
        end,
        success_streak = case
          when cadence_proof_preserved then current_row.success_streak
          else 0
        end,
        updated_at = v_now
    where lane_key = 'global';
    return pg_catalog.jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false,
      'quarantined', true,
      'cadenceProofPreserved', cadence_proof_preserved
    );
  end if;

  if normalized_scope = 'security' then
    update public.naver_shopping_worker_coordination
    set last_failure_at = v_now,
        last_failure_code = normalized_error,
        current_stage = 'failed',
        stability_started_at = null,
        success_streak = 0,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        updated_at = v_now
    where lane_key = 'global';
    return pg_catalog.jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false
    );
  end if;

  if normalized_scope = 'lookup' then
    update public.naver_shopping_worker_coordination
    set lease_worker_id = null,
        lease_token = null,
        lease_until = null,
        run_id = null,
        current_stage = null,
        current_page = 0,
        current_job_kind = null,
        current_tracker_id = null,
        current_job_started_at = null,
        last_failure_at = v_now,
        last_failure_code = normalized_error,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        updated_at = v_now
    where lane_key = 'global';
    return pg_catalog.jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', true,
      'quarantined', false
    );
  end if;

  next_signature := coalesce(nullif(current_row.current_stage, ''), 'unknown')
    || ':' || normalized_error;
  next_streak := case
    when current_row.failure_signature = next_signature
      then least(100000, current_row.failure_streak + 1)
    else 1
  end;
  should_open := current_row.circuit_state = 'half_open' or next_streak >= 2;

  update public.naver_shopping_worker_coordination
  set failure_signature = next_signature,
      failure_streak = next_streak,
      last_failure_at = v_now,
      last_failure_code = normalized_error,
      current_stage = 'failed',
      circuit_state = case when should_open then 'open' else circuit_state end,
      circuit_reason = case when should_open then next_signature else circuit_reason end,
      circuit_opened_at = case when should_open then v_now else circuit_opened_at end,
      probe_started_at = case when should_open then null else probe_started_at end,
      lease_worker_id = case when should_open then null else lease_worker_id end,
      lease_token = case when should_open then null else lease_token end,
      lease_until = case when should_open then null else lease_until end,
      run_id = case when should_open then null else run_id end,
      current_job_kind = case when should_open then null else current_job_kind end,
      current_tracker_id = case when should_open then null else current_tracker_id end,
      current_job_started_at = case when should_open then null else current_job_started_at end,
      cadence_mode = 'baseline',
      cadence_minutes = 10,
      stability_started_at = null,
      success_streak = 0,
      updated_at = v_now
  where lane_key = 'global';

  return pg_catalog.jsonb_build_object(
    'recorded', true,
    'circuitState', case when should_open then 'open' else current_row.circuit_state end,
    'failureStreak', next_streak,
    'laneReleased', should_open
  );
end;
$$;

create or replace function public.mi_enqueue_naver_shopping_account_priority(
  p_request_id uuid,
  p_agency_code text,
  p_expected_cohort_count integer,
  p_expected_cohort_hash text,
  p_expected_runtime_version text,
  p_expected_runtime_fingerprint text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  existing_request public.naver_shopping_account_priority_requests%rowtype;
  v_now timestamptz := date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_agency_code text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_agency_code, '')));
  v_expected_cohort_hash text := pg_catalog.lower(pg_catalog.btrim(
    coalesce(p_expected_cohort_hash, '')
  ));
  v_expected_runtime_version text := pg_catalog.btrim(
    coalesce(p_expected_runtime_version, '')
  );
  v_expected_runtime_fingerprint text := pg_catalog.lower(pg_catalog.btrim(
    coalesce(p_expected_runtime_fingerprint, '')
  ));
  v_cohort_count integer := 0;
  v_cohort_hash text;
begin
  if p_request_id is null
    or v_agency_code !~ '^[a-z0-9][a-z0-9:_-]{2,79}$'
    or p_expected_cohort_count is null
    or p_expected_cohort_count < 1
    or p_expected_cohort_count > 1000
    or v_expected_cohort_hash !~ '^[a-f0-9]{32}$'
    or v_expected_runtime_version <> '1.1.21'
    or v_expected_runtime_fingerprint <>
      '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0' then
    raise exception 'naver_shopping_account_priority_invalid';
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found
    or current_row.runtime_version is distinct from v_expected_runtime_version
    or current_row.runtime_fingerprint is distinct from
      v_expected_runtime_fingerprint
    or current_row.cadence_mode is distinct from 'baseline'
    or current_row.cadence_minutes is distinct from 10
    or current_row.scheduler_cycle_status is distinct from 'active'
    or current_row.scheduler_cycle_id is null
    or current_row.primary_worker_id is distinct from 'windows-desktop-primary'
    or current_row.primary_seen_at is null
    or current_row.primary_seen_at < v_now - interval '180 seconds'
    or current_row.circuit_state is distinct from 'closed'
    or current_row.circuit_reason is not null
    or current_row.cooldown_until is not null
    or current_row.lease_worker_id is not null
    or current_row.lease_token is not null
    or current_row.lease_until is not null
    or current_row.run_id is not null
    or current_row.current_stage is not null
    or current_row.current_page is distinct from 0
    or current_row.current_job_kind is not null
    or current_row.current_tracker_id is not null
    or current_row.current_job_started_at is not null
    or current_row.probe_tracker_id is not null
    or current_row.probe_started_at is not null
    or exists (
      select 1 from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.processing_until > v_now
    )
    or exists (
      select 1 from public.naver_shopping_rank_lookup_jobs as job
      where job.status = 'processing'
        and job.processing_until > v_now
    ) then
    raise exception 'naver_shopping_account_priority_requires_idle_control';
  end if;

  perform mi_internal.mi_reconcile_naver_shopping_account_priority(v_now);

  select * into existing_request
  from public.naver_shopping_account_priority_requests as request
  where request.request_id = p_request_id;
  if existing_request.request_id is not null then
    if existing_request.agency_code is distinct from v_agency_code
      or existing_request.cohort_count is distinct from p_expected_cohort_count
      or existing_request.cohort_hash is distinct from v_expected_cohort_hash
      or existing_request.required_runtime_version is distinct from
        v_expected_runtime_version
      or existing_request.required_runtime_fingerprint is distinct from
        v_expected_runtime_fingerprint then
      raise exception 'naver_shopping_account_priority_request_conflict';
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true,
      'idempotent', true,
      'requestId', existing_request.request_id,
      'state', existing_request.state,
      'cohortCount', existing_request.cohort_count,
      'cohortHash', existing_request.cohort_hash,
      'expiresAt', existing_request.expires_at,
      'wakeRequested', false
    );
  end if;

  if exists (
    select 1
    from public.naver_shopping_account_priority_requests as request
    where request.state = 'active'
  ) then
    raise exception 'naver_shopping_account_priority_active_conflict';
  end if;

  if exists (
    select 1
    from public.naver_shopping_repair_priority_items as item
    join public.naver_rank_trackers as tracker on tracker.id = item.tracker_id
    where item.state = 'queued'
       or (
         item.state = 'consumed'
         and item.claimed_lease_started_at is not null
         and tracker.processing_started_at = item.claimed_lease_started_at
         and tracker.processing_until > v_now
       )
  ) then
    raise exception 'naver_shopping_account_priority_legacy_conflict';
  end if;

  select count(*)::integer,
         pg_catalog.md5(
           v_agency_code || ':' ||
           pg_catalog.string_agg(
             pg_catalog.format(
               '%s|%s|%s',
               tracker.sort_order,
               extract(epoch from tracker.created_at),
               tracker.id
             ),
             ',' order by tracker.sort_order, tracker.created_at, tracker.id
           )
         )
  into v_cohort_count, v_cohort_hash
  from public.naver_rank_trackers as tracker
  where tracker.status = 'active'
    and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) = v_agency_code;

  if v_cohort_count < 1 or v_cohort_count > 1000 or v_cohort_hash is null then
    raise exception 'naver_shopping_account_priority_empty_or_oversized';
  end if;

  if v_cohort_count <> p_expected_cohort_count
    or v_cohort_hash is distinct from v_expected_cohort_hash then
    raise exception 'naver_shopping_account_priority_cohort_precondition_failed';
  end if;

  if exists (
    select 1
    from public.naver_shopping_account_priority_requests as request
    where request.agency_code = v_agency_code
      and request.cohort_hash = v_cohort_hash
      and request.required_runtime_version = v_expected_runtime_version
      and request.required_runtime_fingerprint =
        v_expected_runtime_fingerprint
  ) then
    raise exception 'naver_shopping_account_priority_cohort_already_requested';
  end if;

  insert into public.naver_shopping_account_priority_requests(
    request_id,
    agency_code,
    cohort_count,
    cohort_hash,
    required_runtime_version,
    required_runtime_fingerprint,
    requested_at,
    expires_at,
    requested_cycle_id,
    requested_cycle_number
  ) values (
    p_request_id,
    v_agency_code,
    v_cohort_count,
    v_cohort_hash,
    current_row.runtime_version,
    current_row.runtime_fingerprint,
    v_now,
    v_now + interval '24 hours',
    case when current_row.scheduler_cycle_status = 'active'
      then current_row.scheduler_cycle_id else null end,
    case when current_row.scheduler_cycle_status = 'active'
      then current_row.scheduler_cycle_number else null end
  );

  insert into public.naver_shopping_account_priority_members(
    request_id, position, tracker_id
  )
  select
    p_request_id,
    pg_catalog.row_number() over (
      order by tracker.sort_order, tracker.created_at, tracker.id
    )::integer,
    tracker.id
  from public.naver_rank_trackers as tracker
  where tracker.status = 'active'
    and pg_catalog.lower(pg_catalog.btrim(tracker.agency_code)) = v_agency_code
  order by tracker.sort_order, tracker.created_at, tracker.id;

  if (select count(*) from public.naver_shopping_account_priority_members
      where request_id = p_request_id) <> v_cohort_count then
    raise exception 'naver_shopping_account_priority_cohort_insert_mismatch';
  end if;

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'idempotent', false,
    'requestId', p_request_id,
    'state', 'active',
    'cohortCount', v_cohort_count,
    'cohortHash', v_cohort_hash,
    'expiresAt', v_now + interval '24 hours',
    'wakeRequested', false
  );
end;
$$;

revoke all on function public.mi_report_naver_shopping_worker_progress(
  text, uuid, uuid, text, integer, text, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_report_naver_shopping_worker_progress(
  text, uuid, uuid, text, integer, text, uuid, text, text, text
) to service_role;

revoke all on function public.mi_get_naver_shopping_worker_operations()
from public, anon, authenticated, service_role;
grant execute on function public.mi_get_naver_shopping_worker_operations()
to service_role;

revoke all on function public.mi_set_naver_shopping_worker_cadence(text)
from public, anon, authenticated, service_role;
grant execute on function public.mi_set_naver_shopping_worker_cadence(text)
to service_role;

revoke all on function public.mi_record_naver_shopping_worker_failure(
  text, uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_record_naver_shopping_worker_failure(
  text, uuid, uuid, text, text, uuid
) to service_role;

revoke all on function public.mi_enqueue_naver_shopping_account_priority(
  uuid, text, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_enqueue_naver_shopping_account_priority(
  uuid, text, integer, text, text, text
) to service_role;

revoke all on function public.mi_commit_naver_shopping_finite_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_commit_naver_shopping_finite_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) to service_role;

revoke all on function mi_internal.mi_audit_naver_shopping_snapshot_commit()
from public, anon, authenticated, service_role;

commit;
