-- Runtime 1.1.18 keeps stable-finite-window-v1 as the sanitized database
-- proof. The trusted runtime performs the bounded third pass and the exact
-- runtime fingerprint identifies that verifier without persisting capture IDs
-- or pass digests in tenant-visible rank history.

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
    or current_row.runtime_version is distinct from '1.1.17'
    or current_row.runtime_fingerprint is distinct from
      '1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7'
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
    raise exception 'naver_shopping_runtime_1_1_18_requires_idle_control_plane';
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
    where runtime_version is distinct from '1.1.17'
       or runtime_fingerprint is distinct from
         '1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7'
  ) then
    raise exception 'naver_shopping_runtime_1_1_18_finite_target_identity_mismatch';
  end if;

  update public.naver_shopping_finite_window_targets
  set runtime_version = '1.1.18',
      runtime_fingerprint =
        '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c'
  where runtime_version = '1.1.17'
    and runtime_fingerprint = '1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7';
  get diagnostics target_updated_count = row_count;

  if target_updated_count <> prior_target_count then
    raise exception 'naver_shopping_runtime_1_1_18_target_mismatch';
  end if;
end
$target_transition$;

alter table public.naver_shopping_finite_window_targets
  add constraint naver_shopping_finite_window_targets_runtime_version_check
    check (runtime_version = '1.1.18');

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
    and runtime_version = '1.1.17'
    and runtime_fingerprint = '1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7';
  get diagnostics coordination_updated_count = row_count;

  if coordination_updated_count <> 1 then
    raise exception 'naver_shopping_runtime_1_1_18_coordination_mismatch';
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
  expected_runtime_version constant text := '1.1.18';
  expected_runtime_fingerprint constant text :=
    '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c';
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
  expected_runtime_version constant text := '1.1.18';
  expected_runtime_fingerprint constant text :=
    '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c';
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
  expected_runtime_version constant text := '1.1.18';
  expected_runtime_fingerprint constant text :=
    '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c';
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
  expected_runtime_version constant text := '1.1.18';
  expected_runtime_fingerprint constant text :=
    '65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c';
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
