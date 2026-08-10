begin;

create or replace function public.mi_claim_naver_shopping_worker_lane(
  p_worker_id text,
  p_worker_role text,
  p_lease_token uuid,
  p_lease_seconds integer default 1200,
  p_primary_stale_seconds integer default 180
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_worker_id text := lower(trim(coalesce(p_worker_id, '')));
  normalized_worker_role text := lower(trim(coalesce(p_worker_role, '')));
  lease_seconds integer := greatest(60, least(1200, coalesce(p_lease_seconds, 1200)));
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
  p_lease_seconds integer default 1200
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
        secs => greatest(60, least(1200, coalesce(p_lease_seconds, 1200)))
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

create or replace function public.mi_block_naver_shopping_worker_lane(
  p_worker_id text,
  p_lease_token uuid,
  p_error_code text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_error text := lower(trim(coalesce(p_error_code, '')));
  cooldown_seconds integer;
  blocked_count integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  cooldown_seconds := case
    when normalized_error in ('naver_http_418', 'naver_http_429', 'naver_network_restricted') then 1800
    when normalized_error in (
      'naver_captcha_detected',
      'naver_auth_required',
      'naver_verification_required'
    ) then 3600
    else null
  end;
  if cooldown_seconds is null then
    return false;
  end if;

  update public.naver_shopping_worker_coordination
  set lease_worker_id = null,
      lease_token = null,
      lease_until = null,
      cooldown_until = greatest(
        coalesce(cooldown_until, v_now),
        v_now + make_interval(secs => cooldown_seconds)
      ),
      last_block_code = normalized_error,
      updated_at = v_now
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lease_token;

  get diagnostics blocked_count = row_count;
  return blocked_count = 1;
end;
$$;

revoke all on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function public.mi_touch_naver_shopping_worker_lane(text, uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function public.mi_block_naver_shopping_worker_lane(text, uuid, text)
from public, anon, authenticated, service_role;

grant execute on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
to service_role;
grant execute on function public.mi_touch_naver_shopping_worker_lane(text, uuid, integer)
to service_role;
grant execute on function public.mi_block_naver_shopping_worker_lane(text, uuid, text)
to service_role;

commit;
