begin;

-- Keep only the verified proof protocol version in the append-only scheduler
-- ledger. Capture identifiers and digests are intentionally never persisted.
create or replace function mi_internal.mi_audit_naver_shopping_snapshot_commit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.naver_shopping_scheduler_events(
    occurred_at,
    event_type,
    cycle_id,
    cycle_number,
    claim_id,
    run_id,
    worker_id,
    tracker_id,
    agency_code,
    group_fingerprint,
    priority,
    lease_started_at,
    lease_until,
    collection_id,
    checked_count,
    details
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
    jsonb_strip_nulls(jsonb_build_object(
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

  return null;
end;
$$;

revoke all on function mi_internal.mi_audit_naver_shopping_snapshot_commit()
from public, anon, authenticated, service_role;

commit;
