begin;

create or replace function public.mi_claim_naver_shopping_worker_lane(
  p_worker_id text,
  p_worker_role text,
  p_lease_token uuid,
  p_lease_seconds integer default 2100,
  p_primary_stale_seconds integer default 180
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_worker_id text := lower(trim(coalesce(p_worker_id, '')));
  normalized_worker_role text := lower(trim(coalesce(p_worker_role, '')));
  lease_seconds integer := greatest(60, least(2100, coalesce(p_lease_seconds, 2100)));
  primary_stale_seconds integer := greatest(60, least(900, coalesce(p_primary_stale_seconds, 180)));
  current_row public.naver_shopping_worker_coordination%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if normalized_worker_id !~ '^[a-z0-9][a-z0-9:_-]{2,63}$' then
    raise exception 'naver_shopping_worker_id_invalid';
  end if;
  if normalized_worker_role not in ('primary', 'standby') then
    raise exception 'naver_shopping_worker_role_invalid';
  end if;
  if p_lease_token is null then
    raise exception 'naver_shopping_worker_lane_token_invalid';
  end if;

  insert into public.naver_shopping_worker_coordination(lane_key)
  values ('global')
  on conflict (lane_key) do nothing;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if normalized_worker_role = 'primary' then
    update public.naver_shopping_worker_coordination
    set primary_worker_id = normalized_worker_id,
        primary_seen_at = v_now,
        updated_at = v_now
    where lane_key = 'global';
    current_row.primary_worker_id := normalized_worker_id;
    current_row.primary_seen_at := v_now;
  end if;

  if current_row.cooldown_until is not null
    and current_row.cooldown_until > v_now then
    return jsonb_build_object(
      'granted', false,
      'reason', 'cooldown',
      'cooldownUntil', current_row.cooldown_until
    );
  end if;

  if normalized_worker_role = 'standby'
    and current_row.primary_seen_at is not null
    and current_row.primary_seen_at > v_now - make_interval(secs => primary_stale_seconds) then
    return jsonb_build_object(
      'granted', false,
      'reason', 'primary_online',
      'primarySeenAt', current_row.primary_seen_at
    );
  end if;

  if current_row.lease_until is not null
    and current_row.lease_until > v_now
    and (current_row.lease_worker_id is distinct from normalized_worker_id
      or current_row.lease_token is distinct from p_lease_token) then
    return jsonb_build_object(
      'granted', false,
      'reason', 'busy',
      'leaseUntil', current_row.lease_until
    );
  end if;

  update public.naver_shopping_worker_coordination
  set lease_worker_id = normalized_worker_id,
      lease_token = p_lease_token,
      lease_until = v_now + make_interval(secs => lease_seconds),
      cooldown_until = null,
      last_block_code = null,
      updated_at = v_now
  where lane_key = 'global'
  returning * into current_row;

  return jsonb_build_object(
    'granted', true,
    'reason', 'granted',
    'leaseUntil', current_row.lease_until
  );
end;
$$;

create or replace function public.mi_touch_naver_shopping_worker_lane(
  p_worker_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 2100
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  touched_count integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  update public.naver_shopping_worker_coordination
  set lease_until = v_now + make_interval(
        secs => greatest(60, least(2100, coalesce(p_lease_seconds, 2100)))
      ),
      updated_at = v_now
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lease_token
    and lease_until > v_now
    and (cooldown_until is null or cooldown_until <= v_now);

  get diagnostics touched_count = row_count;
  return touched_count = 1;
end;
$$;

create or replace function public.mi_claim_naver_shopping_rank_lookup_job(
  p_lease_seconds integer default 2100
)
returns table (
  id uuid,
  keyword text,
  lease_started_at timestamptz,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds < 60 or p_lease_seconds > 2100 then
    raise exception 'rank_lookup_lease_invalid';
  end if;

  return query
  with candidate as (
    select job.id
    from public.naver_shopping_rank_lookup_jobs as job
    where job.expires_at > now()
      and job.attempts < 3
      and (
        (job.status = 'pending' and job.available_at <= now())
        or (job.status = 'processing' and job.processing_until < now())
      )
    order by job.available_at asc, job.created_at asc
    limit 1
    for update skip locked
  )
  update public.naver_shopping_rank_lookup_jobs as job
  set status = 'processing',
      processing_started_at = now(),
      processing_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now(),
      error_code = null
  from candidate
  where job.id = candidate.id
  returning job.id, job.keyword, job.processing_started_at, job.processing_until;
end;
$$;

revoke all on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function public.mi_touch_naver_shopping_worker_lane(text, uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function public.mi_claim_naver_shopping_rank_lookup_job(integer)
from public, anon, authenticated, service_role;

grant execute on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
to service_role;
grant execute on function public.mi_touch_naver_shopping_worker_lane(text, uuid, integer)
to service_role;
grant execute on function public.mi_claim_naver_shopping_rank_lookup_job(integer)
to service_role;

commit;
