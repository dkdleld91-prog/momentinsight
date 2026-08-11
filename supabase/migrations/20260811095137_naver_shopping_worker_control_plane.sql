begin;

alter table public.naver_shopping_worker_coordination
  add column if not exists circuit_state text not null default 'closed',
  add column if not exists circuit_reason text,
  add column if not exists circuit_opened_at timestamptz,
  add column if not exists failure_signature text,
  add column if not exists failure_streak integer not null default 0,
  add column if not exists probe_tracker_id uuid,
  add column if not exists probe_started_at timestamptz,
  add column if not exists run_id uuid,
  add column if not exists runtime_version text,
  add column if not exists runtime_fingerprint text,
  add column if not exists current_stage text,
  add column if not exists current_page integer not null default 0,
  add column if not exists current_job_kind text,
  add column if not exists current_tracker_id uuid,
  add column if not exists current_job_started_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_failure_at timestamptz,
  add column if not exists last_failure_code text,
  add column if not exists last_collection_id text,
  add column if not exists last_checked_count integer,
  add column if not exists last_excluded_ad_count integer,
  add column if not exists last_duration_ms integer,
  add column if not exists last_source text,
  add column if not exists scheduler_urgent_streak integer not null default 0,
  add column if not exists scheduler_last_agency_code text,
  add column if not exists cadence_mode text not null default 'baseline',
  add column if not exists cadence_minutes integer not null default 10,
  add column if not exists stability_started_at timestamptz,
  add column if not exists success_streak integer not null default 0;

alter table public.naver_shopping_worker_coordination
  drop constraint if exists naver_shopping_worker_coordination_circuit_state_check,
  drop constraint if exists naver_shopping_worker_coordination_failure_streak_check,
  drop constraint if exists naver_shopping_worker_coordination_current_page_check,
  drop constraint if exists naver_shopping_worker_coordination_scheduler_urgent_streak_check,
  drop constraint if exists naver_shopping_worker_coordination_cadence_check,
  drop constraint if exists naver_shopping_worker_coordination_success_streak_check;

alter table public.naver_shopping_worker_coordination
  add constraint naver_shopping_worker_coordination_circuit_state_check
    check (circuit_state in ('closed', 'open', 'half_open')),
  add constraint naver_shopping_worker_coordination_failure_streak_check
    check (failure_streak between 0 and 100000),
  add constraint naver_shopping_worker_coordination_current_page_check
    check (current_page between 0 and 8),
  add constraint naver_shopping_worker_coordination_scheduler_urgent_streak_check
    check (scheduler_urgent_streak between 0 and 2),
  add constraint naver_shopping_worker_coordination_cadence_check
    check ((cadence_mode = 'baseline' and cadence_minutes = 10)
      or (cadence_mode = 'candidate' and cadence_minutes = 8)),
  add constraint naver_shopping_worker_coordination_success_streak_check
    check (success_streak between 0 and 100000);

alter table public.naver_rank_trackers
  add column if not exists worker_quarantined_until timestamptz;

alter table public.naver_shopping_worker_coordination enable row level security;
alter table public.naver_shopping_worker_coordination force row level security;
revoke all on table public.naver_shopping_worker_coordination
from public, anon, authenticated, service_role;
grant select, insert, update on table public.naver_shopping_worker_coordination
to service_role;

create index if not exists idx_naver_rank_trackers_worker_fair_queue
on public.naver_rank_trackers(status, next_check_at, agency_code, worker_quarantined_until)
where status = 'active';

insert into public.naver_shopping_worker_coordination(lane_key)
values ('global')
on conflict (lane_key) do nothing;

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

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if normalized_worker_role = 'primary' then
    update public.naver_shopping_worker_coordination
    set primary_worker_id = normalized_worker_id,
        primary_seen_at = v_now,
        updated_at = v_now
    where lane_key = 'global'
    returning * into current_row;
  end if;

  if current_row.cooldown_until is not null and current_row.cooldown_until > v_now then
    return jsonb_build_object(
      'granted', false,
      'reason', 'cooldown',
      'cooldownUntil', current_row.cooldown_until,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  if current_row.circuit_state = 'open' then
    return jsonb_build_object(
      'granted', false,
      'reason', 'circuit_open',
      'circuitState', 'open',
      'circuitReason', current_row.circuit_reason,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  if normalized_worker_role = 'standby'
    and current_row.primary_seen_at is not null
    and current_row.primary_seen_at > v_now - make_interval(secs => primary_stale_seconds) then
    return jsonb_build_object(
      'granted', false,
      'reason', 'primary_online',
      'primarySeenAt', current_row.primary_seen_at,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  if current_row.lease_until is not null
    and current_row.lease_until > v_now
    and (current_row.lease_worker_id is distinct from normalized_worker_id
      or current_row.lease_token is distinct from p_lease_token) then
    return jsonb_build_object(
      'granted', false,
      'reason', 'busy',
      'leaseUntil', current_row.lease_until,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes
    );
  end if;

  if current_row.circuit_state = 'half_open'
    and current_row.probe_started_at is not null
    and (current_row.lease_until is null or current_row.lease_until <= v_now) then
    update public.naver_shopping_worker_coordination
    set circuit_state = 'open',
        circuit_reason = 'probe_interrupted',
        circuit_opened_at = v_now,
        probe_started_at = null,
        lease_worker_id = null,
        lease_token = null,
        lease_until = null,
        current_stage = null,
        current_page = 0,
        current_job_kind = null,
        current_tracker_id = null,
        current_job_started_at = null,
        run_id = null,
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        updated_at = v_now
    where lane_key = 'global';
    return jsonb_build_object(
      'granted', false,
      'reason', 'circuit_open',
      'circuitState', 'open',
      'circuitReason', 'probe_interrupted',
      'cadenceMinutes', 10
    );
  end if;

  update public.naver_shopping_worker_coordination
  set lease_worker_id = normalized_worker_id,
      lease_token = p_lease_token,
      lease_until = v_now + make_interval(secs => lease_seconds),
      cooldown_until = null,
      last_block_code = null,
      run_id = null,
      current_stage = 'claiming',
      current_page = 0,
      current_job_kind = null,
      current_tracker_id = null,
      current_job_started_at = v_now,
      probe_started_at = case when circuit_state = 'half_open' then v_now else probe_started_at end,
      updated_at = v_now
  where lane_key = 'global'
  returning * into current_row;

  return jsonb_build_object(
    'granted', true,
    'reason', 'granted',
    'leaseUntil', current_row.lease_until,
    'circuitState', current_row.circuit_state,
    'probeTrackerId', current_row.probe_tracker_id,
    'cadenceMinutes', current_row.cadence_minutes
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
      primary_seen_at = case
        when primary_worker_id = lower(trim(coalesce(p_worker_id, ''))) then v_now
        else primary_seen_at
      end,
      updated_at = v_now
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lease_token
    and lease_until > v_now
    and circuit_state <> 'open'
    and (cooldown_until is null or cooldown_until <= v_now);

  get diagnostics touched_count = row_count;
  return touched_count = 1;
end;
$$;

create or replace function public.mi_release_naver_shopping_worker_lane(
  p_worker_id text,
  p_lease_token uuid
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lease_token
  for update;
  if not found then return false; end if;

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
      circuit_state = case when current_row.circuit_state = 'half_open' then 'open' else current_row.circuit_state end,
      circuit_reason = case when current_row.circuit_state = 'half_open' then 'probe_incomplete' else current_row.circuit_reason end,
      circuit_opened_at = case when current_row.circuit_state = 'half_open' then v_now else current_row.circuit_opened_at end,
      probe_started_at = case when current_row.circuit_state = 'half_open' then null else current_row.probe_started_at end,
      cadence_mode = case when current_row.circuit_state = 'half_open' then 'baseline' else current_row.cadence_mode end,
      cadence_minutes = case when current_row.circuit_state = 'half_open' then 10 else current_row.cadence_minutes end,
      stability_started_at = case when current_row.circuit_state = 'half_open' then null else current_row.stability_started_at end,
      success_streak = case when current_row.circuit_state = 'half_open' then 0 else current_row.success_streak end,
      updated_at = v_now
  where lane_key = 'global';
  return true;
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
  current_row public.naver_shopping_worker_coordination%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  cooldown_seconds := case
    when normalized_error in ('naver_http_418', 'naver_http_429', 'naver_network_restricted') then 1800
    when normalized_error in ('naver_captcha_detected', 'naver_auth_required', 'naver_verification_required') then 3600
    else null
  end;
  if cooldown_seconds is null then return false; end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lease_token
  for update;
  if not found then return false; end if;

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
      cooldown_until = greatest(
        coalesce(cooldown_until, v_now),
        v_now + make_interval(secs => cooldown_seconds)
      ),
      last_block_code = normalized_error,
      last_failure_at = v_now,
      last_failure_code = normalized_error,
      circuit_state = case when current_row.circuit_state = 'half_open' then 'open' else current_row.circuit_state end,
      circuit_reason = case when current_row.circuit_state = 'half_open' then 'probe_security_block' else current_row.circuit_reason end,
      circuit_opened_at = case when current_row.circuit_state = 'half_open' then v_now else current_row.circuit_opened_at end,
      probe_started_at = null,
      cadence_mode = 'baseline',
      cadence_minutes = 10,
      stability_started_at = null,
      success_streak = 0,
      updated_at = v_now
  where lane_key = 'global';
  return true;
end;
$$;

create or replace function public.mi_report_naver_shopping_worker_progress(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_stage text,
  p_page integer,
  p_job_kind text,
  p_tracker_id uuid,
  p_runtime_version text,
  p_runtime_fingerprint text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_count integer := 0;
  normalized_stage text := lower(trim(coalesce(p_stage, '')));
  normalized_kind text := nullif(lower(trim(coalesce(p_job_kind, ''))), '');
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_stage not in ('claiming', 'navigating', 'collecting', 'submitting', 'completed', 'failed')
    or coalesce(p_page, -1) not between 0 and 8
    or (normalized_kind is not null and normalized_kind not in ('lookup', 'tracker'))
    or trim(coalesce(p_runtime_version, '')) <> '1.1.0'
    or lower(trim(coalesce(p_runtime_fingerprint, ''))) !~ '^[a-f0-9]{64}$'
    or lower(trim(coalesce(p_runtime_fingerprint, ''))) = repeat('0', 64) then
    return false;
  end if;

  update public.naver_shopping_worker_coordination
  set run_id = p_run_id,
      runtime_version = trim(p_runtime_version),
      runtime_fingerprint = lower(trim(p_runtime_fingerprint)),
      current_stage = normalized_stage,
      current_page = p_page,
      current_job_kind = normalized_kind,
      current_tracker_id = p_tracker_id,
      current_job_started_at = case
        when normalized_stage = 'claiming' then coalesce(current_job_started_at, v_now)
        else coalesce(current_job_started_at, v_now)
      end,
      updated_at = v_now
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and lease_until > v_now
    and circuit_state <> 'open'
    and (run_id is null or run_id = p_run_id);
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

create or replace function public.mi_record_naver_shopping_worker_success(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_tracker_id uuid,
  p_collection_id text,
  p_checked_count integer,
  p_excluded_ad_count integer,
  p_duration_ms integer,
  p_source text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  v_now timestamptz := clock_timestamp();
  next_success_streak integer;
  next_stability_started_at timestamptz;
begin
  if p_run_id is null
    or trim(coalesce(p_collection_id, '')) !~ '^pw-chrome-'
    or p_checked_count is distinct from 300
    or coalesce(p_excluded_ad_count, -1) < 0
    or coalesce(p_duration_ms, -1) not between 0 and 3600000
    or lower(trim(coalesce(p_source, ''))) <> 'naver_shopping_results_collector' then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_proof_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and run_id = p_run_id
    and lease_until > v_now
    and circuit_state <> 'open'
  for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'lease_lost');
  end if;
  if current_row.circuit_state = 'half_open'
    and current_row.probe_tracker_id is distinct from p_tracker_id then
    return jsonb_build_object('recorded', false, 'reason', 'probe_mismatch');
  end if;

  next_success_streak := case
    when current_row.circuit_state = 'half_open' then 1
    else least(100000, current_row.success_streak + 1)
  end;
  next_stability_started_at := case
    when current_row.circuit_state = 'half_open' or current_row.stability_started_at is null then v_now
    else current_row.stability_started_at
  end;

  update public.naver_shopping_worker_coordination
  set circuit_state = 'closed',
      circuit_reason = null,
      circuit_opened_at = null,
      failure_signature = null,
      failure_streak = 0,
      probe_tracker_id = null,
      probe_started_at = null,
      current_stage = 'completed',
      current_page = 8,
      last_success_at = v_now,
      last_collection_id = trim(p_collection_id),
      last_checked_count = p_checked_count,
      last_excluded_ad_count = p_excluded_ad_count,
      last_duration_ms = p_duration_ms,
      last_source = lower(trim(p_source)),
      stability_started_at = next_stability_started_at,
      success_streak = next_success_streak,
      updated_at = v_now
  where lane_key = 'global';

  if p_tracker_id is not null then
    update public.naver_rank_trackers
    set worker_quarantined_until = null
    where id = p_tracker_id;
  end if;

  return jsonb_build_object(
    'recorded', true,
    'circuitState', 'closed',
    'cadenceMinutes', current_row.cadence_minutes,
    'candidateEligible', next_stability_started_at <= v_now - interval '24 hours'
      and next_success_streak >= 6
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
  normalized_error text := lower(trim(coalesce(p_error_code, '')));
  normalized_scope text := lower(trim(coalesce(p_scope, '')));
  next_signature text;
  next_streak integer;
  should_open boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_error !~ '^[a-z0-9_:-]{3,80}$'
    or normalized_scope not in ('system', 'tracker', 'security')
    or (normalized_scope = 'tracker' and p_tracker_id is null) then
    return jsonb_build_object('recorded', false, 'reason', 'failure_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and run_id = p_run_id
    and lease_until > v_now
    and circuit_state <> 'open'
  for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'lease_lost');
  end if;

  if normalized_scope = 'tracker' then
    update public.naver_rank_trackers
    set worker_quarantined_until = greatest(
      coalesce(worker_quarantined_until, v_now),
      v_now + case
        when coalesce(retry_count, 0) >= 2 then interval '24 hours'
        else interval '30 minutes'
      end
    )
    where id = p_tracker_id;
    update public.naver_shopping_worker_coordination
    set last_failure_at = v_now,
        last_failure_code = normalized_error,
        current_stage = 'failed',
        cadence_mode = 'baseline',
        cadence_minutes = 10,
        stability_started_at = null,
        success_streak = 0,
        updated_at = v_now
    where lane_key = 'global';
    return jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false,
      'quarantined', true
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
    return jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', false
    );
  end if;

  next_signature := coalesce(nullif(current_row.current_stage, ''), 'unknown') || ':' || normalized_error;
  next_streak := case
    when current_row.failure_signature = next_signature then least(100000, current_row.failure_streak + 1)
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

  return jsonb_build_object(
    'recorded', true,
    'circuitState', case when should_open then 'open' else current_row.circuit_state end,
    'failureStreak', next_streak,
    'laneReleased', should_open
  );
end;
$$;

create or replace function public.mi_choose_naver_shopping_worker_turn(
  p_has_lookup boolean,
  p_has_new boolean,
  p_has_due boolean,
  p_due_agencies text[],
  p_oldest_due_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  work_class text := 'none';
  agency_code text := null;
  v_now timestamptz := clock_timestamp();
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if current_row.circuit_state = 'open'
    or current_row.lease_until is null
    or current_row.lease_until <= v_now then
    return jsonb_build_object('workClass', 'none', 'agencyCode', null);
  end if;

  if coalesce(p_has_due, false)
    and (current_row.scheduler_urgent_streak >= 2
      or (p_oldest_due_at is not null and p_oldest_due_at <= v_now - interval '30 minutes')) then
    work_class := 'due';
  elsif coalesce(p_has_lookup, false)
    and coalesce(p_has_new, false)
    and current_row.scheduler_urgent_streak = 0 then
    work_class := 'new';
  elsif coalesce(p_has_lookup, false) then
    work_class := 'lookup';
  elsif coalesce(p_has_new, false) then
    work_class := 'new';
  elsif coalesce(p_has_due, false) then
    work_class := 'due';
  end if;

  if work_class = 'due' then
    select min(lower(trim(value))) into agency_code
    from unnest(coalesce(p_due_agencies, array[]::text[])) as value
    where trim(value) <> ''
      and (current_row.scheduler_last_agency_code is null
        or lower(trim(value)) > current_row.scheduler_last_agency_code);
    if agency_code is null then
      select min(lower(trim(value))) into agency_code
      from unnest(coalesce(p_due_agencies, array[]::text[])) as value
      where trim(value) <> '';
    end if;
  end if;

  update public.naver_shopping_worker_coordination
  set scheduler_urgent_streak = case
        when work_class in ('lookup', 'new') and coalesce(p_has_due, false)
          then least(2, scheduler_urgent_streak + 1)
        when work_class in ('lookup', 'new') and scheduler_urgent_streak = 0 then 1
        when work_class in ('lookup', 'new') then 0
        when work_class = 'due' then 0
        else scheduler_urgent_streak
      end,
      scheduler_last_agency_code = case
        when work_class = 'due' then agency_code
        else scheduler_last_agency_code
      end,
      updated_at = v_now
  where lane_key = 'global';

  return jsonb_build_object('workClass', work_class, 'agencyCode', agency_code);
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
    and ((status = 'pending' and available_at <= v_now)
      or (status = 'processing' and processing_until <= v_now));

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
    and regexp_replace(lower(trim(keyword)), '\s+', '', 'g') = '남자팬티'
    and product_id = '12491798995'
  order by created_at asc
  limit 1;

  return jsonb_build_object(
    'circuit_state', current_row.circuit_state,
    'circuit_reason', current_row.circuit_reason,
    'circuit_opened_at', current_row.circuit_opened_at,
    'failure_signature', current_row.failure_signature,
    'failure_streak', current_row.failure_streak,
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
    'candidate_eligible', coalesce((current_row.circuit_state = 'closed'
      and current_row.stability_started_at is not null
      and current_row.stability_started_at <= v_now - interval '24 hours'
      and current_row.success_streak >= 6
      and current_row.runtime_version = '1.1.0'
      and current_row.runtime_fingerprint ~ '^[a-f0-9]{64}$'
      and current_row.runtime_fingerprint <> repeat('0', 64)
      and current_row.last_collection_id ~ '^pw-chrome-'
      and current_row.last_checked_count = 300
      and current_row.last_source = 'naver_shopping_results_collector'), false),
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

create or replace function public.mi_stop_naver_shopping_worker(
  p_reason text default 'manual_stop'
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_reason text := lower(trim(coalesce(p_reason, 'manual_stop')));
  v_now timestamptz := clock_timestamp();
begin
  if normalized_reason !~ '^[a-z0-9_:-]{3,80}$' then normalized_reason := 'manual_stop'; end if;
  update public.naver_shopping_worker_coordination
  set circuit_state = 'open',
      circuit_reason = normalized_reason,
      circuit_opened_at = v_now,
      probe_tracker_id = null,
      probe_started_at = null,
      lease_worker_id = null,
      lease_token = null,
      lease_until = null,
      run_id = null,
      current_stage = null,
      current_page = 0,
      current_job_kind = null,
      current_tracker_id = null,
      current_job_started_at = null,
      cadence_mode = 'baseline',
      cadence_minutes = 10,
      stability_started_at = null,
      success_streak = 0,
      updated_at = v_now
  where lane_key = 'global';
  return jsonb_build_object('accepted', true, 'state', 'open', 'reason', normalized_reason);
end;
$$;

create or replace function public.mi_request_naver_shopping_worker_probe(
  p_tracker_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  canary_row public.naver_rank_trackers%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  if current_row.circuit_state = 'half_open' then
    return jsonb_build_object('accepted', false, 'reason', 'probe_active', 'state', 'half_open');
  end if;
  if current_row.lease_until is not null and current_row.lease_until > v_now then
    return jsonb_build_object('accepted', false, 'reason', 'busy', 'state', current_row.circuit_state);
  end if;
  if current_row.cooldown_until is not null and current_row.cooldown_until > v_now then
    return jsonb_build_object('accepted', false, 'reason', 'cooldown', 'state', current_row.circuit_state);
  end if;

  select * into canary_row
  from public.naver_rank_trackers
  where id = p_tracker_id
    and status = 'active'
    and regexp_replace(lower(trim(keyword)), '\s+', '', 'g') = '남자팬티'
    and product_id = '12491798995'
  for update;
  if not found then
    return jsonb_build_object('accepted', false, 'reason', 'canary_mismatch', 'state', current_row.circuit_state);
  end if;

  update public.naver_rank_trackers
  set next_check_at = v_now,
      worker_quarantined_until = null
  where id = p_tracker_id;
  update public.naver_shopping_worker_coordination
  set circuit_state = 'half_open',
      circuit_reason = 'manual_canary',
      circuit_opened_at = null,
      probe_tracker_id = p_tracker_id,
      probe_started_at = null,
      failure_signature = null,
      failure_streak = 0,
      cadence_mode = 'baseline',
      cadence_minutes = 10,
      updated_at = v_now
  where lane_key = 'global';
  return jsonb_build_object(
    'accepted', true,
    'activated', true,
    'state', 'half_open',
    'trackerId', p_tracker_id,
    'minutes', 10
  );
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
  normalized_mode text := lower(trim(coalesce(p_mode, '')));
  current_row public.naver_shopping_worker_coordination%rowtype;
  eligible boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if normalized_mode not in ('baseline', 'candidate') then
    return jsonb_build_object('accepted', false, 'reason', 'mode_invalid');
  end if;
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  if normalized_mode = 'baseline' then
    update public.naver_shopping_worker_coordination
    set cadence_mode = 'baseline', cadence_minutes = 10, updated_at = v_now
    where lane_key = 'global';
    return jsonb_build_object('accepted', true, 'activated', true, 'mode', 'baseline', 'minutes', 10);
  end if;

  eligible := coalesce((current_row.circuit_state = 'closed'
    and (current_row.lease_until is null or current_row.lease_until <= v_now)
    and (current_row.cooldown_until is null or current_row.cooldown_until <= v_now)
    and current_row.stability_started_at is not null
    and current_row.stability_started_at <= v_now - interval '24 hours'
    and current_row.success_streak >= 6
    and current_row.runtime_version = '1.1.0'
    and current_row.runtime_fingerprint ~ '^[a-f0-9]{64}$'
    and current_row.runtime_fingerprint <> repeat('0', 64)
    and current_row.last_collection_id ~ '^pw-chrome-'
    and current_row.last_checked_count = 300
    and current_row.last_source = 'naver_shopping_results_collector'), false);
  if eligible is not true then
    return jsonb_build_object(
      'accepted', false,
      'activated', false,
      'reason', 'not_eligible',
      'mode', current_row.cadence_mode,
      'minutes', current_row.cadence_minutes
    );
  end if;
  update public.naver_shopping_worker_coordination
  set cadence_mode = 'candidate', cadence_minutes = 8, updated_at = v_now
  where lane_key = 'global';
  return jsonb_build_object('accepted', true, 'activated', true, 'mode', 'candidate', 'minutes', 8);
end;
$$;

revoke all on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer)
from public, anon, authenticated, service_role;
revoke all on function public.mi_touch_naver_shopping_worker_lane(text, uuid, integer)
from public, anon, authenticated, service_role;
revoke all on function public.mi_release_naver_shopping_worker_lane(text, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.mi_block_naver_shopping_worker_lane(text, uuid, text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_report_naver_shopping_worker_progress(text, uuid, uuid, text, integer, text, uuid, text, text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_record_naver_shopping_worker_success(text, uuid, uuid, uuid, text, integer, integer, integer, text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_record_naver_shopping_worker_failure(text, uuid, uuid, text, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.mi_choose_naver_shopping_worker_turn(boolean, boolean, boolean, text[], timestamptz)
from public, anon, authenticated, service_role;
revoke all on function public.mi_get_naver_shopping_worker_operations()
from public, anon, authenticated, service_role;
revoke all on function public.mi_stop_naver_shopping_worker(text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_request_naver_shopping_worker_probe(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.mi_set_naver_shopping_worker_cadence(text)
from public, anon, authenticated, service_role;

grant execute on function public.mi_claim_naver_shopping_worker_lane(text, text, uuid, integer, integer) to service_role;
grant execute on function public.mi_touch_naver_shopping_worker_lane(text, uuid, integer) to service_role;
grant execute on function public.mi_release_naver_shopping_worker_lane(text, uuid) to service_role;
grant execute on function public.mi_block_naver_shopping_worker_lane(text, uuid, text) to service_role;
grant execute on function public.mi_report_naver_shopping_worker_progress(text, uuid, uuid, text, integer, text, uuid, text, text) to service_role;
grant execute on function public.mi_record_naver_shopping_worker_success(text, uuid, uuid, uuid, text, integer, integer, integer, text) to service_role;
grant execute on function public.mi_record_naver_shopping_worker_failure(text, uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.mi_choose_naver_shopping_worker_turn(boolean, boolean, boolean, text[], timestamptz) to service_role;
grant execute on function public.mi_get_naver_shopping_worker_operations() to service_role;
grant execute on function public.mi_stop_naver_shopping_worker(text) to service_role;
grant execute on function public.mi_request_naver_shopping_worker_probe(uuid) to service_role;
grant execute on function public.mi_set_naver_shopping_worker_cadence(text) to service_role;

commit;
