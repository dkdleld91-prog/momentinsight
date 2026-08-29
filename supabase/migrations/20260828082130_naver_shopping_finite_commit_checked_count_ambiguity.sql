begin;

set local lock_timeout = '5s';

-- The deployed finite commit function declared a PL/pgSQL variable with the
-- same name as the scheduler ledger column. PostgreSQL therefore rejected
-- committed.checked_count = checked_count as ambiguous before materializing
-- the exact-ID parent-catalog snapshot. Keep the function contract unchanged
-- and disambiguate only the local value.

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
  target public.naver_shopping_finite_window_targets%rowtype;
  claim public.naver_shopping_scheduler_events%rowtype;
  current_row public.naver_shopping_worker_coordination%rowtype;
  inserted_snapshot_id uuid;
  finite_checked_count integer;
  matched_rank integer;
  market_total integer;
  tracker_claim_count integer := 0;
  group_claim_count integer := 0;
  finite_event_count integer := 0;
  run_trigger text;
  item jsonb;
begin
  if p_tracker_id is null or p_lease_started_at is null
    or p_collection_id is null or p_collection_id !~ '^pw-chrome-'
    or char_length(p_collection_id) > 160
    or p_checked_at is null or p_next_check_at is null
    or p_snapshot is null or pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'checked_count') is distinct from 'number'
    or (p_snapshot ->> 'checked_count') !~ '^[0-9]+$'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'rank') is distinct from 'number'
    or (p_snapshot ->> 'rank') !~ '^[1-9][0-9]*$'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'total') is distinct from 'number'
    or (p_snapshot ->> 'total') !~ '^[1-9][0-9]*$'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'item') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'top_items') is distinct from 'array' then
    raise exception 'local_worker_finite_commit_invalid';
  end if;

  finite_checked_count := (p_snapshot ->> 'checked_count')::integer;
  matched_rank := (p_snapshot ->> 'rank')::integer;
  market_total := (p_snapshot ->> 'total')::integer;
  item := p_snapshot -> 'item';

  select * into target
  from public.naver_shopping_finite_window_targets
  where tracker_id = p_tracker_id
    and enabled = true;

  -- finite exact relation gate begin
  if not found
    or p_tracker_id is distinct from 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    or p_product_id is distinct from '13327339525'
    or target.seller_product_id is distinct from '13327339525'
    or target.parent_catalog_id is distinct from '59776958987'
    or target.proof_version is distinct from 'stable-finite-window-v1'
    or finite_checked_count not between 1 and 299
    or matched_rank not between 1 and finite_checked_count
    or market_total is distinct from finite_checked_count
    or p_snapshot -> 'matched' is distinct from 'true'::jsonb
    or p_snapshot ->> 'source' is distinct from 'naver_shopping_results_collector'
    or item ->> 'finiteWindowProofVersion' is distinct from 'stable-finite-window-v1'
    or item -> 'sourceExhausted' is distinct from 'true'::jsonb
    or item -> 'finiteMarketTotal' is distinct from pg_catalog.to_jsonb(market_total)
    or item -> 'atomicSuccessEligible' is distinct from 'false'::jsonb
    or item ->> 'trackingRankSource' is distinct from 'related_catalog'
    or item ->> 'relatedCatalogProductId' is distinct from target.parent_catalog_id
    or item ->> 'relatedCatalogRelationBasis' is distinct from 'catalog_seller_product_id'
    or item ->> 'catalogId' is distinct from target.parent_catalog_id
    or pg_catalog.jsonb_typeof(item -> 'catalogSellerProductIds') is distinct from 'array'
    or pg_catalog.jsonb_array_length(item -> 'catalogSellerProductIds') not between 1 and 100
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(item -> 'catalogSellerProductIds') as seller_id(seller_id)
      where seller_id.seller_id = target.seller_product_id
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(item -> 'catalogSellerProductIds') as seller_id(seller_id)
      where seller_id.seller_id !~ '^[0-9]{5,80}$'
    )
    or item ->> 'rankPolicy' is distinct from 'organic_only'
    or item -> 'adExcluded' is distinct from 'true'::jsonb
    or item ->> 'rankEvidence' is distinct from 'naver_shopping_organic_list'
    or item ->> 'collectionId' is distinct from p_collection_id
    or item -> 'isOrganic' is distinct from 'true'::jsonb
    or item -> 'isAd' is distinct from 'false'::jsonb
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_snapshot -> 'top_items') as top_item
      where top_item -> 'isOrganic' is distinct from 'true'::jsonb
        or top_item -> 'isAd' is distinct from 'false'::jsonb
    ) then
    raise exception 'local_worker_finite_exact_relation_invalid';
  end if;
  -- finite exact relation gate end

  select * into tracker
  from public.naver_rank_trackers
  where id = p_tracker_id
  for update;

  if not found then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.status <> 'active'
    or tracker.product_id is distinct from target.seller_product_id
    or pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\s+', '', 'g'
    ) is distinct from target.normalized_keyword then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.processing_started_at is null then
    select snapshot.id into inserted_snapshot_id
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = p_tracker_id
      and snapshot.collection_id = p_collection_id
      and snapshot.source = 'naver_shopping_results_collector'
      and snapshot.checked_count between 1 and 299
      and snapshot.matched = true
      and snapshot.rank between 1 and snapshot.checked_count
      and snapshot.total = snapshot.checked_count
      and snapshot.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'
      and snapshot.item -> 'sourceExhausted' = 'true'::jsonb
      and snapshot.item -> 'finiteMarketTotal' =
        pg_catalog.to_jsonb(snapshot.checked_count)
      and snapshot.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'
      and snapshot.item ->> 'relatedCatalogProductId' = target.parent_catalog_id
      and snapshot.item ->> 'trackingRankSource' = 'related_catalog'
      and snapshot.item ->> 'catalogId' = target.parent_catalog_id
      and pg_catalog.jsonb_typeof(
        snapshot.item -> 'catalogSellerProductIds'
      ) = 'array'
      and pg_catalog.jsonb_array_length(
        snapshot.item -> 'catalogSellerProductIds'
      ) between 1 and 100
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          snapshot.item -> 'catalogSellerProductIds'
        ) as seller_id(seller_id)
        where seller_id.seller_id = target.seller_product_id
      )
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          snapshot.item -> 'catalogSellerProductIds'
        ) as seller_id(seller_id)
        where seller_id.seller_id !~ '^[0-9]{5,80}$'
      )
      and snapshot.item ->> 'rankPolicy' = 'organic_only'
      and snapshot.item -> 'adExcluded' = 'true'::jsonb
      and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
      and snapshot.item ->> 'collectionId' = snapshot.collection_id
      and snapshot.item -> 'isOrganic' = 'true'::jsonb
      and snapshot.item -> 'isAd' = 'false'::jsonb
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
        join public.naver_shopping_scheduler_events as grouped
          on grouped.event_type = 'group_claimed'
         and grouped.claim_id = representative_claim.claim_id
         and grouped.run_id = representative_claim.run_id
         and grouped.worker_id = representative_claim.worker_id
         and grouped.group_fingerprint = representative_claim.group_fingerprint
         and grouped.details -> 'memberCount' = pg_catalog.to_jsonb(1)
         and grouped.event_id < representative_claim.event_id
        join public.naver_shopping_worker_runs as runs
          on runs.run_id = committed.run_id
         and runs.worker_id = committed.worker_id
         and runs.run_trigger = 'rank-catch-up'
         and runs.runtime_version = target.runtime_version
         and runs.runtime_fingerprint = target.runtime_fingerprint
        where committed.event_type = 'finite_window_committed'
          and committed.tracker_id = snapshot.tracker_id
          and committed.collection_id = snapshot.collection_id
          and committed.checked_count = snapshot.checked_count
          and committed.occurred_at = snapshot.checked_at
          and committed.worker_id = 'windows-desktop-primary'
          and committed.priority in ('new', 'resume', 'normal')
          and committed.details ->> 'source' is not distinct from snapshot.source
          and committed.details ->> 'finiteWindowProofVersion'
            is not distinct from 'stable-finite-window-v1'
          and committed.details -> 'sourceExhausted'
            is not distinct from 'true'::jsonb
          and committed.details -> 'marketTotal'
            is not distinct from pg_catalog.to_jsonb(snapshot.total)
          and committed.details -> 'matched'
            is not distinct from 'true'::jsonb
          and committed.details -> 'rank'
            is not distinct from pg_catalog.to_jsonb(snapshot.rank)
          and committed.details ->> 'relationBasis'
            is not distinct from 'catalog_seller_product_id'
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
    or claim.worker_id is distinct from 'windows-desktop-primary'
    or claim.priority not in ('new', 'resume', 'normal') then
    raise exception 'local_worker_finite_claim_invalid';
  end if;

  select count(*)::integer into tracker_claim_count
  from public.naver_shopping_scheduler_events as claimed
  where claimed.event_type = 'tracker_claimed'
    and claimed.claim_id = claim.claim_id;
  select count(*)::integer into group_claim_count
  from public.naver_shopping_scheduler_events as grouped
  where grouped.event_type = 'group_claimed'
    and grouped.claim_id = claim.claim_id
    and grouped.run_id = claim.run_id
    and grouped.worker_id = claim.worker_id
    and grouped.group_fingerprint = claim.group_fingerprint
    and grouped.details -> 'memberCount' = pg_catalog.to_jsonb(1);
  if tracker_claim_count <> 1 or group_claim_count <> 1 then
    raise exception 'local_worker_finite_group_invalid';
  end if;

  select runs.run_trigger into run_trigger
  from public.naver_shopping_worker_runs as runs
  where runs.run_id = claim.run_id
    and runs.worker_id = claim.worker_id
    and runs.runtime_version = target.runtime_version
    and runs.runtime_fingerprint = target.runtime_fingerprint;
  if not found or run_trigger <> 'rank-catch-up' then
    raise exception 'local_worker_finite_run_invalid';
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global';
  if not found
    or current_row.lease_worker_id is distinct from claim.worker_id
    or current_row.run_id is distinct from claim.run_id
    or current_row.runtime_version is distinct from target.runtime_version
    or current_row.runtime_fingerprint is distinct from target.runtime_fingerprint
    or current_row.current_job_kind is distinct from 'tracker'
    or current_row.current_tracker_id is distinct from p_tracker_id
    or current_row.lease_until is null
    or current_row.lease_until <= clock_timestamp()
    or current_row.circuit_state = 'open'
    or not exists (
      select 1
      from public.naver_shopping_worker_runs as runs
      where runs.run_id = claim.run_id
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
    nullif((p_snapshot ->> 'page')::integer, 0),
    nullif((p_snapshot ->> 'position')::integer, 0),
    true,
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
      best_rank = least(coalesce(best_rank, matched_rank), matched_rank),
      worst_rank = greatest(coalesce(worst_rank, matched_rank), matched_rank),
      check_count = coalesce(check_count, 0) + 1,
      found_count = coalesce(found_count, 0) + 1,
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

revoke all on function public.mi_commit_naver_shopping_finite_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_commit_naver_shopping_finite_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) to service_role;

commit;
