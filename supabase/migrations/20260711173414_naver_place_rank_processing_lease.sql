begin;

alter table public.naver_place_rank_trackers
  add column if not exists processing_token uuid,
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_until timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists retry_count integer not null default 0;

alter table public.naver_place_rank_trackers
  drop constraint if exists naver_place_rank_trackers_retry_count_check;

alter table public.naver_place_rank_trackers
  add constraint naver_place_rank_trackers_retry_count_check
  check (retry_count >= 0);

create index if not exists idx_naver_place_rank_trackers_due_claim
on public.naver_place_rank_trackers(next_check_at, processing_until)
where status = 'active';

create or replace function public.claim_due_naver_place_rank_tracker(
  requested_agency_codes text[] default null,
  lease_seconds integer default 180
)
returns setof public.naver_place_rank_trackers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed_id uuid;
  claimed_token uuid := gen_random_uuid();
begin
  select tracker.id
    into claimed_id
  from public.naver_place_rank_trackers tracker
  where tracker.status = 'active'
    and tracker.next_check_at <= now()
    and (tracker.processing_until is null or tracker.processing_until <= now())
    and (
      requested_agency_codes is null
      or cardinality(requested_agency_codes) = 0
      or tracker.agency_code = any(requested_agency_codes)
    )
  order by tracker.next_check_at asc, tracker.last_attempt_at asc nulls first, tracker.created_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
  update public.naver_place_rank_trackers tracker
  set processing_token = claimed_token,
      processing_started_at = now(),
      processing_until = now() + make_interval(secs => greatest(60, least(900, lease_seconds))),
      last_attempt_at = now()
  where tracker.id = claimed_id
  returning tracker.*;
end;
$$;

revoke all on function public.claim_due_naver_place_rank_tracker(text[], integer) from public;
revoke all on function public.claim_due_naver_place_rank_tracker(text[], integer) from anon;
revoke all on function public.claim_due_naver_place_rank_tracker(text[], integer) from authenticated;
grant execute on function public.claim_due_naver_place_rank_tracker(text[], integer) to service_role;

commit;
