-- Runtime 1.1.13 candidate 6-minute cadence.
-- Candidate8 cannot exceed the existing 8.75-8.77 group/hour target: one
-- global lane and maxJobs=1 cap an 8-minute alarm at 7.5 group/hour. Six
-- minutes is the minimum integer cadence with a theoretical ceiling above the
-- target, while preserving atomic300, order, quarantine and lane safeguards.

begin;

-- Acquire the strongest coordination lock first. A heartbeat must never hold a
-- RowExclusive table lock while waiting on our row lock as this migration later
-- replaces the cadence constraint. Fail finitely if the control plane is busy.
set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;

create table if not exists public.naver_shopping_worker_runs (
  run_id uuid primary key,
  worker_id text not null
    check (worker_id ~ '^[a-z0-9][a-z0-9:_-]{2,63}$'),
  run_trigger text not null
    check (run_trigger in (
      'manual',
      'rank-catch-up',
      'rank-0900',
      'rank-1500',
      'rank-remote',
      'mac-standby',
      'github-cloud'
    )),
  runtime_version text not null
    check (runtime_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  runtime_fingerprint text not null
    check (runtime_fingerprint ~ '^[a-f0-9]{64}$'
      and runtime_fingerprint <> repeat('0', 64)),
  started_at timestamptz not null default clock_timestamp()
);

alter table public.naver_shopping_worker_runs enable row level security;
alter table public.naver_shopping_worker_runs force row level security;
revoke all on table public.naver_shopping_worker_runs
from public, anon, authenticated, service_role;
grant select, insert on table public.naver_shopping_worker_runs
to service_role;

do $migration_guard$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  coordination_found boolean := false;
  processing_count integer := 0;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  coordination_found := found;

  select (
    (select count(*) from public.naver_shopping_rank_lookup_jobs
      where status = 'processing' and processing_until > clock_timestamp())
    +
    (select count(*) from public.naver_rank_trackers
      where status = 'active' and processing_until > clock_timestamp())
  )::integer into processing_count;

  if coordination_found is not true
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
    raise exception 'naver_shopping_runtime_1_1_13_requires_idle_control_plane';
  end if;
end;
$migration_guard$;

-- Never inherit an older runtime's stability proof.
update public.naver_shopping_worker_coordination
set cadence_mode = 'baseline',
    cadence_minutes = 10,
    stability_started_at = null,
    success_streak = 0,
    updated_at = clock_timestamp()
where lane_key = 'global';

alter table public.naver_shopping_worker_coordination
  drop constraint if exists naver_shopping_worker_coordination_cadence_check;

alter table public.naver_shopping_worker_coordination
  add constraint naver_shopping_worker_coordination_cadence_check
    check ((cadence_mode = 'baseline' and cadence_minutes = 10)
      or (cadence_mode = 'candidate' and cadence_minutes = 6));

drop function if exists public.mi_report_naver_shopping_worker_progress(
  text, uuid, uuid, text, integer, text, uuid, text, text
);

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
  updated_count integer := 0;
  normalized_stage text := lower(trim(coalesce(p_stage, '')));
  normalized_kind text := nullif(lower(trim(coalesce(p_job_kind, ''))), '');
  normalized_trigger text := lower(trim(coalesce(p_run_trigger, '')));
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_stage not in ('claiming', 'navigating', 'collecting', 'submitting', 'completed', 'failed')
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
    or trim(coalesce(p_runtime_version, '')) <> '1.1.13'
    or lower(trim(coalesce(p_runtime_fingerprint, ''))) !~ '^[a-f0-9]{64}$'
    or lower(trim(coalesce(p_runtime_fingerprint, ''))) = repeat('0', 64) then
    return false;
  end if;

  update public.naver_shopping_worker_coordination
  set cadence_mode = case
        when runtime_version is distinct from trim(p_runtime_version)
          or runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))
        then 'baseline'
        else cadence_mode
      end,
      cadence_minutes = case
        when runtime_version is distinct from trim(p_runtime_version)
          or runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))
        then 10
        else cadence_minutes
      end,
      stability_started_at = case
        when runtime_version is distinct from trim(p_runtime_version)
          or runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))
        then null
        else stability_started_at
      end,
      success_streak = case
        when runtime_version is distinct from trim(p_runtime_version)
          or runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))
        then 0
        else success_streak
      end,
      run_id = p_run_id,
      runtime_version = trim(p_runtime_version),
      runtime_fingerprint = lower(trim(p_runtime_fingerprint)),
      current_stage = normalized_stage,
      current_page = p_page,
      current_job_kind = normalized_kind,
      current_tracker_id = p_tracker_id,
      current_job_started_at = coalesce(current_job_started_at, v_now),
      updated_at = v_now
  where lane_key = 'global'
    and lease_worker_id = lower(trim(coalesce(p_worker_id, '')))
    and lease_token = p_lane_token
    and lease_until > v_now
    and circuit_state <> 'open'
    and (run_id is null or run_id = p_run_id);
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    return false;
  end if;

  -- A remote poll with no wake never reaches navigating. Record only runs that
  -- actually claimed work so the append-only proof remains bounded and every
  -- performance numerator can join to one exact trigger.
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
      lower(trim(p_worker_id)),
      normalized_trigger,
      trim(p_runtime_version),
      lower(trim(p_runtime_fingerprint)),
      v_now
    )
    on conflict (run_id) do nothing;

    if not exists (
      select 1
      from public.naver_shopping_worker_runs as recorded_run
      where recorded_run.run_id = p_run_id
        and recorded_run.worker_id = lower(trim(p_worker_id))
        and recorded_run.run_trigger = normalized_trigger
        and recorded_run.runtime_version = trim(p_runtime_version)
        and recorded_run.runtime_fingerprint = lower(trim(p_runtime_fingerprint))
    ) then
      raise exception 'naver_shopping_worker_run_provenance_mismatch';
    end if;
  end if;

  return true;
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
    'candidate_eligible', coalesce((current_row.circuit_state = 'closed'
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
      and current_row.runtime_version = '1.1.13'
      and current_row.runtime_fingerprint = 'cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6'
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
  tracker_updated_count integer := 0;
  should_open boolean := false;
  cadence_proof_preserved boolean := normalized_scope = 'tracker'
    and normalized_error ~ '^provider_partial_window:([1-9]|[1-9][0-9]|[12][0-9]{2})_300$';
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null
    or normalized_error !~ '^[a-z0-9_:-]{3,80}$'
    or normalized_scope not in ('system', 'tracker', 'security', 'lookup')
    or (normalized_scope = 'tracker' and p_tracker_id is null)
    or (normalized_scope = 'lookup' and p_tracker_id is not null) then
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
    and (normalized_scope <> 'lookup' or circuit_state = 'closed')
  for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'lease_lost');
  end if;

  if normalized_scope = 'tracker' then
    update public.naver_rank_trackers
    set worker_quarantined_until = case
      when split_part(normalized_error, ':', 1) in (
        'provider_duplicate_identity',
        'provider_stable_window_unproven'
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

    cadence_proof_preserved := cadence_proof_preserved
      and tracker_updated_count = 1
      and current_row.circuit_state = 'closed'
      and current_row.circuit_reason is null
      and current_row.cooldown_until is null
      and current_row.probe_tracker_id is null
      and current_row.probe_started_at is null
      and (
        current_row.current_stage = 'collecting'
        or (
          current_row.current_stage = 'failed'
          and current_row.last_failure_code = normalized_error
          and current_row.last_failure_at is not null
          and current_row.last_failure_at >= current_row.current_job_started_at
        )
      )
      and current_row.current_page = 8
      and current_row.current_job_kind = 'tracker'
      and exists (
        select 1
        from public.naver_shopping_scheduler_events as failed_event
        join public.naver_shopping_scheduler_events as representative_claim
          on representative_claim.event_type = 'tracker_claimed'
          and representative_claim.run_id = failed_event.run_id
          and representative_claim.claim_id = failed_event.claim_id
          and representative_claim.group_fingerprint = failed_event.group_fingerprint
        where failed_event.event_type = 'job_failed'
          and failed_event.run_id = p_run_id
          and failed_event.worker_id = current_row.lease_worker_id
          and failed_event.tracker_id = p_tracker_id
          and failed_event.error_code = normalized_error
          and representative_claim.tracker_id = current_row.current_tracker_id
          and representative_claim.worker_id = current_row.lease_worker_id
      )
      and lower(trim(coalesce(p_worker_id, ''))) = 'windows-desktop-primary'
      and current_row.primary_worker_id = 'windows-desktop-primary'
      and current_row.primary_seen_at > v_now - interval '3 minutes'
      and current_row.runtime_version = '1.1.13'
      and current_row.runtime_fingerprint = 'cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6'
      and (
        (current_row.cadence_mode = 'baseline' and current_row.cadence_minutes = 10)
        or (current_row.cadence_mode = 'candidate' and current_row.cadence_minutes = 6)
      )
      and current_row.stability_started_at is not null
      and current_row.success_streak >= 1
      and current_row.last_collection_id ~ '^pw-chrome-'
      and current_row.last_checked_count = 300
      and current_row.last_source = 'naver_shopping_results_collector';

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
    return jsonb_build_object(
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
    return jsonb_build_object(
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
    return jsonb_build_object(
      'recorded', true,
      'circuitState', current_row.circuit_state,
      'failureStreak', current_row.failure_streak,
      'laneReleased', true,
      'quarantined', false
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
  normalized_collection_id text := trim(coalesce(p_collection_id, ''));
  v_now timestamptz;
  next_success_streak integer;
  next_stability_started_at timestamptz;
  representative_commit_count integer := 0;
  group_claim_count integer := 0;
  tracker_claim_count integer := 0;
  committed_count integer := 0;
  invalid_proof_count integer := 0;
  group_claim_id uuid;
  expected_group_fingerprint text;
begin
  if p_run_id is null
    or p_tracker_id is null
    or normalized_collection_id !~ '^pw-chrome-'
    or p_checked_count is distinct from 300
    or coalesce(p_excluded_ad_count, -1) < 0
    or coalesce(p_duration_ms, -1) not between 0 and 3600000
    or lower(trim(coalesce(p_source, ''))) <> 'naver_shopping_results_collector' then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_proof_invalid');
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;
  v_now := clock_timestamp();

  if not found
    or current_row.lease_worker_id is distinct from lower(trim(coalesce(p_worker_id, '')))
    or current_row.lease_token is distinct from p_lane_token
    or current_row.run_id is distinct from p_run_id
    or current_row.lease_until is null
    or current_row.lease_until <= v_now
    or current_row.circuit_state = 'open' then
    return jsonb_build_object('recorded', false, 'reason', 'lease_lost');
  end if;

  if current_row.current_job_kind is distinct from 'tracker'
    or current_row.current_tracker_id is distinct from p_tracker_id then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_current_job_mismatch');
  end if;

  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason is distinct from 'auto_navigation_probe'
    and current_row.circuit_reason is distinct from 'auto_transient_system_probe'
    and current_row.probe_tracker_id is distinct from p_tracker_id then
    return jsonb_build_object('recorded', false, 'reason', 'probe_mismatch');
  end if;
  if current_row.circuit_state = 'half_open'
    and current_row.circuit_reason in ('auto_navigation_probe', 'auto_transient_system_probe')
    and (current_row.probe_tracker_id is not null or p_tracker_id is null) then
    return jsonb_build_object('recorded', false, 'reason', 'probe_mismatch');
  end if;

  select count(*)::integer
  into representative_commit_count
  from public.naver_shopping_scheduler_events as committed
  where committed.event_type = 'tracker_committed'
    and committed.run_id = p_run_id
    and committed.worker_id = current_row.lease_worker_id
    and committed.tracker_id = p_tracker_id
    and committed.collection_id = normalized_collection_id
    and committed.checked_count = 300
    and committed.details ->> 'source' = 'naver_shopping_results_collector';
  if representative_commit_count <> 1 then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_representative_commit_invalid');
  end if;

  select committed.claim_id, committed.group_fingerprint
  into group_claim_id, expected_group_fingerprint
  from public.naver_shopping_scheduler_events as committed
  where committed.event_type = 'tracker_committed'
    and committed.run_id = p_run_id
    and committed.worker_id = current_row.lease_worker_id
    and committed.tracker_id = p_tracker_id
    and committed.collection_id = normalized_collection_id
    and committed.checked_count = 300
    and committed.details ->> 'source' = 'naver_shopping_results_collector'
  limit 1;

  select count(*)::integer
  into group_claim_count
  from public.naver_shopping_scheduler_events as event
  where event.event_type = 'group_claimed'
    and event.claim_id = group_claim_id
    and event.run_id = p_run_id
    and event.worker_id = current_row.lease_worker_id
    and event.group_fingerprint = expected_group_fingerprint;
  if group_claim_count <> 1 then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_group_proof_invalid');
  end if;

  if exists (
    select 1
    from public.naver_shopping_scheduler_events as failed
    where failed.event_type = 'job_failed'
      and failed.claim_id = group_claim_id
  ) then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_run_failed');
  end if;

  select count(*)::integer
  into tracker_claim_count
  from public.naver_shopping_scheduler_events as claimed
  where claimed.event_type = 'tracker_claimed'
    and claimed.claim_id = group_claim_id;
  if tracker_claim_count < 1 then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_tracker_proof_missing');
  end if;

  if not exists (
    select 1
    from public.naver_shopping_scheduler_events as claimed
    where claimed.event_type = 'tracker_claimed'
      and claimed.claim_id = group_claim_id
      and claimed.run_id = p_run_id
      and claimed.worker_id = current_row.lease_worker_id
      and claimed.tracker_id = p_tracker_id
      and claimed.group_fingerprint = expected_group_fingerprint
  ) then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_tracker_proof_mismatch');
  end if;

  select count(*)::integer
  into committed_count
  from public.naver_shopping_scheduler_events as committed
  where committed.event_type = 'tracker_committed'
    and committed.claim_id = group_claim_id
    and committed.run_id = p_run_id
    and committed.worker_id = current_row.lease_worker_id
    and committed.group_fingerprint = expected_group_fingerprint
    and committed.collection_id = normalized_collection_id
    and committed.checked_count = 300;
  if committed_count <> tracker_claim_count then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_commit_proof_incomplete');
  end if;

  if exists (
    select 1
    from public.naver_shopping_scheduler_events as committed
    where committed.event_type = 'tracker_committed'
      and committed.claim_id = group_claim_id
      and (
        committed.run_id is distinct from p_run_id
        or committed.worker_id is distinct from current_row.lease_worker_id
        or committed.group_fingerprint is distinct from expected_group_fingerprint
        or committed.collection_id is distinct from normalized_collection_id
        or committed.checked_count is distinct from 300
        or committed.details ->> 'source' is distinct from 'naver_shopping_results_collector'
      )
  ) then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_commit_proof_mismatch');
  end if;

  select count(*)::integer
  into invalid_proof_count
  from public.naver_shopping_scheduler_events as claimed
  where claimed.event_type = 'tracker_claimed'
    and claimed.claim_id = group_claim_id
    and (
      claimed.run_id is distinct from p_run_id
      or claimed.worker_id is distinct from current_row.lease_worker_id
      or claimed.group_fingerprint is distinct from expected_group_fingerprint
      or not exists (
        select 1
        from public.naver_shopping_scheduler_events as committed
        where committed.event_type = 'tracker_committed'
          and committed.claim_id = claimed.claim_id
          and committed.run_id = p_run_id
          and committed.worker_id = current_row.lease_worker_id
          and committed.tracker_id = claimed.tracker_id
          and committed.group_fingerprint = claimed.group_fingerprint
          and committed.collection_id = normalized_collection_id
          and committed.checked_count = 300
          and committed.details ->> 'source' = 'naver_shopping_results_collector'
      )
      or not exists (
        select 1
        from public.naver_rank_snapshots as snapshot
        where snapshot.tracker_id = claimed.tracker_id
          and snapshot.collection_id = normalized_collection_id
          and snapshot.checked_count = 300
          and snapshot.source = 'naver_shopping_results_collector'
          and pg_catalog.jsonb_typeof(snapshot.item) = 'object'
          and (snapshot.matched = false or snapshot.item -> 'isOrganic' = 'true'::jsonb)
          and snapshot.item -> 'adExcluded' = 'true'::jsonb
          and snapshot.item ->> 'rankPolicy' = 'organic_only'
          and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
          and snapshot.item ->> 'collectionId' = normalized_collection_id
          and snapshot.item -> 'excludedAdCount' = pg_catalog.to_jsonb(p_excluded_ad_count)
          and pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
                then snapshot.top_items else '[]'::jsonb end
            ) as top_item
            where top_item -> 'isOrganic' is distinct from 'true'::jsonb
              or top_item -> 'isAd' is distinct from 'false'::jsonb
          )
      )
    );
  if invalid_proof_count <> 0 then
    return jsonb_build_object('recorded', false, 'reason', 'atomic_snapshot_proof_invalid');
  end if;

  -- A lost HTTP response can replay the signed success action while the same
  -- lane/run is live. Revalidate proof, then return without changing the streak.
  if current_row.last_collection_id = normalized_collection_id then
    return jsonb_build_object(
      'recorded', true,
      'alreadyRecorded', true,
      'circuitState', current_row.circuit_state,
      'cadenceMinutes', current_row.cadence_minutes,
      'candidateEligible', current_row.stability_started_at is not null
        and current_row.stability_started_at <= v_now - interval '24 hours'
        and current_row.success_streak >= 6
    );
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
      transient_system_probe_attempts = 0,
      probe_tracker_id = null,
      probe_started_at = null,
      current_stage = 'completed',
      current_page = 8,
      last_success_at = v_now,
      last_collection_id = normalized_collection_id,
      last_checked_count = p_checked_count,
      last_excluded_ad_count = p_excluded_ad_count,
      last_duration_ms = p_duration_ms,
      last_source = lower(trim(p_source)),
      stability_started_at = next_stability_started_at,
      success_streak = next_success_streak,
      updated_at = v_now
  where lane_key = 'global';

  update public.naver_rank_trackers
  set worker_quarantined_until = null
  where id = p_tracker_id;

  return jsonb_build_object(
    'recorded', true,
    'alreadyRecorded', false,
    'circuitState', 'closed',
    'cadenceMinutes', current_row.cadence_minutes,
    'candidateEligible', next_stability_started_at <= v_now - interval '24 hours'
      and next_success_streak >= 6
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
  processing_count integer := 0;
  eligible boolean := false;
  v_now timestamptz;
begin
  if normalized_mode not in ('baseline', 'candidate') then
    return jsonb_build_object('accepted', false, 'reason', 'mode_invalid');
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
    return jsonb_build_object('accepted', true, 'activated', true, 'mode', 'baseline', 'minutes', 10);
  end if;

  eligible := coalesce((current_row.circuit_state = 'closed'
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
    and current_row.runtime_version = '1.1.13'
    and current_row.runtime_fingerprint = 'cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6'
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
  set cadence_mode = 'candidate', cadence_minutes = 6, updated_at = v_now
  where lane_key = 'global';
  return jsonb_build_object('accepted', true, 'activated', true, 'mode', 'candidate', 'minutes', 6);
end;
$$;

revoke all on function public.mi_report_naver_shopping_worker_progress(text, uuid, uuid, text, integer, text, uuid, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_get_naver_shopping_worker_operations()
from public, anon, authenticated, service_role;
revoke all on function public.mi_record_naver_shopping_worker_failure(text, uuid, uuid, text, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.mi_record_naver_shopping_worker_success(text, uuid, uuid, uuid, text, integer, integer, integer, text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_set_naver_shopping_worker_cadence(text)
from public, anon, authenticated, service_role;

grant execute on function public.mi_report_naver_shopping_worker_progress(text, uuid, uuid, text, integer, text, uuid, text, text, text)
to service_role;
grant execute on function public.mi_get_naver_shopping_worker_operations()
to service_role;
grant execute on function public.mi_record_naver_shopping_worker_failure(text, uuid, uuid, text, text, uuid)
to service_role;
grant execute on function public.mi_record_naver_shopping_worker_success(text, uuid, uuid, uuid, text, integer, integer, integer, text)
to service_role;
grant execute on function public.mi_set_naver_shopping_worker_cadence(text)
to service_role;

commit;
