-- Runtime 1.1.19 adds a separate stable-rendered-order-v1 proof for the
-- bounded two-capture fallback while retaining stable-finite-window-v1 for
-- the exact-parent canary. The exact runtime fingerprint identifies both
-- verifiers without persisting capture IDs or pass digests in rank history.

begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;
lock table public.naver_shopping_finite_window_targets in share row exclusive mode;

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

  if coordination_found is not true
    or current_row.runtime_version is distinct from '1.1.18'
    or current_row.runtime_fingerprint is distinct from
      '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c'
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
    raise exception 'naver_shopping_runtime_1_1_19_requires_idle_control_plane';
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
    where runtime_version is distinct from '1.1.18'
       or runtime_fingerprint is distinct from
         '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c'
  ) then
    raise exception 'naver_shopping_runtime_1_1_19_finite_target_identity_mismatch';
  end if;

  update public.naver_shopping_finite_window_targets
  set runtime_version = '1.1.19',
      runtime_fingerprint =
        '631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e'
  where runtime_version = '1.1.18'
    and runtime_fingerprint = '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c';
  get diagnostics target_updated_count = row_count;

  if target_updated_count <> prior_target_count then
    raise exception 'naver_shopping_runtime_1_1_19_target_mismatch';
  end if;
end
$target_transition$;

alter table public.naver_shopping_finite_window_targets
  add constraint naver_shopping_finite_window_targets_runtime_version_check
    check (runtime_version = '1.1.19');

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
    and runtime_version = '1.1.18'
    and runtime_fingerprint = '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c';
  get diagnostics coordination_updated_count = row_count;

  if coordination_updated_count <> 1 then
    raise exception 'naver_shopping_runtime_1_1_19_coordination_mismatch';
  end if;
end
$coordination_transition$;

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
  expected_runtime_version constant text := '1.1.19';
  expected_runtime_fingerprint constant text :=
    '631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e';
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
  expected_runtime_version constant text := '1.1.19';
  expected_runtime_fingerprint constant text :=
    '631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e';
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
  expected_runtime_version constant text := '1.1.19';
  expected_runtime_fingerprint constant text :=
    '631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e';
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
  expected_runtime_version constant text := '1.1.19';
  expected_runtime_fingerprint constant text :=
    '631f2a556a1337ed9e9e9a72c8f07ed607928e97853b7d93611be04d97bfa13e';
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

-- The cycle cursor is stamped when a tracker is claimed. If the Windows/native
-- process disappears before emitting any terminal event, that stamp must not
-- silently remove the tracker from the rest of the active cycle. One expired
-- unmatched claim receives exactly one repair claim. A second unmatched claim
-- makes the predicate false, so process crashes cannot create an unbounded
-- scheduler retry loop.
create or replace function public.mi_naver_shopping_cycle_orphan_recovery_eligible(
  p_tracker_id uuid,
  p_cycle_id uuid
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  with latest_claim as (
    select
      claimed.event_id,
      claimed.claim_id
    from public.naver_shopping_scheduler_events as claimed
    where claimed.cycle_id = p_cycle_id
      and claimed.tracker_id = p_tracker_id
      and claimed.event_type = 'tracker_claimed'
    order by claimed.event_id desc
    limit 1
  ), unmatched_claims as (
    select claimed.event_id
    from public.naver_shopping_scheduler_events as claimed
    where claimed.cycle_id = p_cycle_id
      and claimed.tracker_id = p_tracker_id
      and claimed.event_type = 'tracker_claimed'
      and claimed.claim_id is not null
      and not exists (
        select 1
        from public.naver_shopping_scheduler_events as terminal
        where terminal.claim_id = claimed.claim_id
          and terminal.tracker_id = claimed.tracker_id
          and terminal.event_type in (
            'tracker_committed',
            'finite_window_committed',
            'job_failed'
          )
      )
  )
  select
    p_tracker_id is not null
    and p_cycle_id is not null
    and coalesce((
      select
        latest.claim_id is not null
        and (
          tracker.processing_until is null
          or tracker.processing_until <= pg_catalog.statement_timestamp()
        )
        and not exists (
          select 1
          from public.naver_shopping_scheduler_events as terminal
          where terminal.claim_id = latest.claim_id
            and terminal.tracker_id = p_tracker_id
            and terminal.event_type in (
              'tracker_committed',
              'finite_window_committed',
              'job_failed'
            )
        )
        and (select count(*) from unmatched_claims) = 1
      from latest_claim as latest
      join public.naver_rank_trackers as tracker
        on tracker.id = p_tracker_id
    ), false)
$$;

revoke all on function public.mi_naver_shopping_cycle_orphan_recovery_eligible(
  uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_naver_shopping_cycle_orphan_recovery_eligible(
  uuid, uuid
) to service_role;

-- Runtime 1.1.19 fixes the scheduler cohort as-of cycle start. Never-checked
-- registrations made after that boundary wait for the next natural cycle; they
-- cannot jump ahead of the saved cursor. Existing cohort members are selected
-- only by canonical (sort_order, created_at, id), while runtime failures and a
-- single expired orphan opportunity remain bounded repair claims that never
-- move or reset the ordinary cursor.
create or replace function public.mi_claim_naver_shopping_cycle_keyword(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_lease_seconds integer default 2100,
  p_probe_tracker_id uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  seed public.naver_rank_trackers%rowtype;
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_lease_until timestamptz;
  v_keyword_key text;
  v_priority text;
  v_claims jsonb := '[]'::jsonb;
  v_claim_count integer := 0;
  v_deferred_count integer := 0;
  v_waiting integer := 0;
  v_resume boolean := false;
begin
  seed := null;
  if lower(trim(coalesce(p_worker_id, ''))) !~ '^[a-z0-9][a-z0-9:_-]{2,63}$'
    or p_lane_token is null
    or p_run_id is null
    or p_lease_seconds < 60
    or p_lease_seconds > 2100 then
    raise exception 'naver_shopping_cycle_claim_invalid';
  end if;
  v_lease_until := v_now + make_interval(secs => p_lease_seconds);

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found
    or current_row.lease_worker_id is distinct from lower(trim(p_worker_id))
    or current_row.lease_token is distinct from p_lane_token
    or current_row.run_id is distinct from p_run_id
    or current_row.lease_until is null
    or current_row.lease_until <= v_now
    or current_row.circuit_state = 'open' then
    raise exception 'naver_shopping_cycle_lane_lost';
  end if;

  if p_probe_tracker_id is not null then
    select * into seed
    from public.naver_rank_trackers as tracker
    where tracker.id = p_probe_tracker_id
      and tracker.status = 'active'
      and (tracker.processing_until is null or tracker.processing_until <= v_now)
    for update skip locked;
    if seed.id is null then
      return jsonb_build_object(
        'status', 'waiting', 'cycleId', null, 'priority', 'probe',
        'claims', '[]'::jsonb, 'deferredCount', 0, 'groupSize', 0
      );
    end if;
    v_priority := 'probe';
  else
    if current_row.scheduler_cycle_status <> 'active'
      or current_row.scheduler_cycle_id is null then
      return jsonb_build_object(
        'status', 'no_cycle', 'cycleId', null, 'claims', '[]'::jsonb,
        'deferredCount', 0, 'groupSize', 0
      );
    end if;

    -- Both repair predicates are immutable-ledger-backed and bounded. Neither
    -- path updates the ordinary cohort cursor.
    select * into seed
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and exists (
        select 1
        from public.naver_shopping_scheduler_events as roster
        where roster.event_type = 'cycle_rostered'
          and roster.cycle_id = current_row.scheduler_cycle_id
          and roster.tracker_id = tracker.id
          and roster.roster_state is distinct from 'new_after_start'
      )
      and tracker.worker_last_cycle_id = current_row.scheduler_cycle_id
      and (
        public.mi_naver_shopping_cycle_runtime_recovery_eligible(
          tracker.id,
          current_row.scheduler_cycle_id,
          current_row.runtime_version,
          current_row.runtime_fingerprint
        )
        or public.mi_naver_shopping_cycle_orphan_recovery_eligible(
          tracker.id,
          current_row.scheduler_cycle_id
        )
      )
      and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
      and (tracker.processing_until is null or tracker.processing_until <= v_now)
    order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
    limit 1
    for update skip locked;
    if seed.id is not null then v_priority := 'repair'; end if;

    if seed.id is null then
      v_resume := current_row.scheduler_cycle_resume_cursor;
      select * into seed
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and roster.roster_state is distinct from 'new_after_start'
        )
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
        and (
          current_row.scheduler_cycle_cursor_tracker_id is null
          or (tracker.sort_order, tracker.created_at, tracker.id) >
             (current_row.scheduler_cycle_cursor_sort_order,
              current_row.scheduler_cycle_cursor_created_at,
              current_row.scheduler_cycle_cursor_tracker_id)
        )
      order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
      limit 1
      for update skip locked;
      if seed.id is not null then
        v_priority := case when v_resume then 'resume' else 'normal' end;
      end if;
    end if;

    -- A temporarily locked/quarantined cohort row may sit behind the cursor.
    -- This bounded wrap selects only cycle-start members and worker_last_cycle_id
    -- still prevents a second ordinary claim in the same cycle.
    if seed.id is null then
      select * into seed
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and roster.roster_state is distinct from 'new_after_start'
        )
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
      order by tracker.sort_order asc, tracker.created_at asc, tracker.id asc
      limit 1
      for update skip locked;
      if seed.id is not null then
        v_priority := case when v_resume then 'resume' else 'normal' end;
      end if;
    end if;

    if seed.id is null then
      select count(*)::integer into v_waiting
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and roster.roster_state is distinct from 'new_after_start'
        )
        and tracker.processing_until > v_now;
      if v_waiting > 0 then
        return jsonb_build_object(
          'status', 'waiting', 'cycleId', current_row.scheduler_cycle_id,
          'claims', '[]'::jsonb, 'deferredCount', 0, 'groupSize', 0
        );
      end if;
      update public.naver_shopping_worker_coordination
      set scheduler_cycle_status = 'completed',
          scheduler_cycle_completed_at = v_now,
          scheduler_cycle_resume_cursor = false,
          updated_at = v_now
      where lane_key = 'global';
      return jsonb_build_object(
        'status', 'cycle_completed', 'cycleId', current_row.scheduler_cycle_id,
        'claims', '[]'::jsonb, 'deferredCount', 0, 'groupSize', 0
      );
    end if;
  end if;

  v_keyword_key := regexp_replace(lower(trim(seed.keyword)), '\s+', '', 'g');

  -- A cycle-stamped row with the same normalized keyword may have been a
  -- bounded repair claim that did not include this ordinary cohort member.
  -- Never infer materialization from the keyword alone: the still-unclaimed
  -- seed must receive its own finite normal claim opportunity. The legacy
  -- overflow rotation below runs only after an actual ordinary claim; it can
  -- no longer erase the seed's claim opportunity before any work occurs.

  if p_probe_tracker_id is null and exists (
    select 1
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and exists (
        select 1
        from public.naver_shopping_scheduler_events as roster
        where roster.event_type = 'cycle_rostered'
          and roster.cycle_id = current_row.scheduler_cycle_id
          and roster.tracker_id = tracker.id
          and roster.roster_state is distinct from 'new_after_start'
      )
      and tracker.id <> seed.id
      and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
      and tracker.processing_until > v_now
  ) then
    return jsonb_build_object(
      'status', 'waiting',
      'cycleId', current_row.scheduler_cycle_id,
      'priority', v_priority,
      'claims', '[]'::jsonb,
      'deferredCount', 0,
      'groupSize', 0
    );
  end if;

  with group_candidates as (
    select tracker.id
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
      and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
      and (tracker.processing_until is null or tracker.processing_until <= v_now)
      and ((p_probe_tracker_id is not null and tracker.id = p_probe_tracker_id) or (
        p_probe_tracker_id is null
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and roster.roster_state is distinct from 'new_after_start'
        )
        and (
          (
            v_priority = 'repair'
            and tracker.worker_last_cycle_id = current_row.scheduler_cycle_id
            and (
              public.mi_naver_shopping_cycle_runtime_recovery_eligible(
                tracker.id,
                current_row.scheduler_cycle_id,
                current_row.runtime_version,
                current_row.runtime_fingerprint
              )
              or public.mi_naver_shopping_cycle_orphan_recovery_eligible(
                tracker.id,
                current_row.scheduler_cycle_id
              )
            )
          )
          or (
            v_priority <> 'repair'
            and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
          )
        )
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
      ))
    order by
      case when tracker.id = seed.id then 0 else 1 end asc,
      tracker.last_checked_at asc nulls first,
      tracker.worker_last_cycle_claimed_at asc nulls first,
      tracker.sort_order asc,
      tracker.created_at asc,
      tracker.id asc
    limit 100
    for update skip locked
  ), claimed as (
    update public.naver_rank_trackers as tracker
    set processing_started_at = v_now,
        processing_until = v_lease_until,
        worker_last_cycle_id = case when p_probe_tracker_id is null then current_row.scheduler_cycle_id else tracker.worker_last_cycle_id end,
        worker_last_cycle_claimed_at = case when p_probe_tracker_id is null then v_now else tracker.worker_last_cycle_claimed_at end,
        worker_last_cycle_deferred_at = case when p_probe_tracker_id is null then null else tracker.worker_last_cycle_deferred_at end,
        last_message = case
          when v_priority = 'repair' then '오류 보완 후 1회 우선 재검증 중입니다.'
          else '자동 순위 갱신 처리 중입니다.'
        end
    from group_candidates
    where tracker.id = group_candidates.id
    returning tracker.id
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'trackerId', claimed.id,
           'leaseStartedAt', v_now,
           'leaseUntil', v_lease_until
         ) order by claimed.id), '[]'::jsonb)
  into v_claim_count, v_claims
  from claimed;

  if v_claim_count = 0 then
    return jsonb_build_object(
      'status', 'waiting',
      'cycleId', case when p_probe_tracker_id is null then current_row.scheduler_cycle_id else null end,
      'priority', v_priority,
      'claims', '[]'::jsonb,
      'deferredCount', 0,
      'groupSize', 0
    );
  end if;

  if p_probe_tracker_id is null and v_priority <> 'repair' then
    with deferred_group_members as (
      update public.naver_rank_trackers as tracker
      set worker_last_cycle_id = current_row.scheduler_cycle_id,
          worker_last_cycle_deferred_at = v_now
      where tracker.status = 'active'
        and exists (
          select 1
          from public.naver_shopping_scheduler_events as roster
          where roster.event_type = 'cycle_rostered'
            and roster.cycle_id = current_row.scheduler_cycle_id
            and roster.tracker_id = tracker.id
            and roster.roster_state is distinct from 'new_after_start'
        )
        and regexp_replace(lower(trim(tracker.keyword)), '\s+', '', 'g') = v_keyword_key
        and tracker.worker_last_cycle_id is distinct from current_row.scheduler_cycle_id
        and (tracker.worker_quarantined_until is null or tracker.worker_quarantined_until <= v_now)
        and (tracker.processing_until is null or tracker.processing_until <= v_now)
      returning tracker.id
    )
    select count(*)::integer into v_deferred_count
    from deferred_group_members;

    update public.naver_shopping_worker_coordination
    set scheduler_cycle_cursor_sort_order = case when v_priority in ('normal', 'resume') then seed.sort_order else scheduler_cycle_cursor_sort_order end,
        scheduler_cycle_cursor_created_at = case when v_priority in ('normal', 'resume') then seed.created_at else scheduler_cycle_cursor_created_at end,
        scheduler_cycle_cursor_tracker_id = case when v_priority in ('normal', 'resume') then seed.id else scheduler_cycle_cursor_tracker_id end,
        scheduler_cycle_resume_cursor = false,
        updated_at = v_now
    where lane_key = 'global';
  end if;

  return jsonb_build_object(
    'status', 'claimed',
    'cycleId', case when p_probe_tracker_id is null then current_row.scheduler_cycle_id else null end,
    'keyword', seed.keyword,
    'priority', v_priority,
    'claims', v_claims,
    'deferredCount', v_deferred_count,
    'groupSize', v_claim_count + v_deferred_count
  );
end;
$$;

revoke all on function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_cycle_keyword(
  text, uuid, uuid, integer, uuid
) to service_role;

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

commit;
