-- Runtime 1.1.22 (2026-09-11): two collector-side fixes for the logged-in
-- collector profile; scheduler and commit-gate semantics are unchanged.
--   (1) Page-seam repeat: Naver now shows the last organic product of page N
--       again as the first organic product of page N+1 (production evidence
--       2026-09-11, keyword 침대패드: raw rank 41 on both pages). The collector
--       skips that single product instead of failing the window
--       (provider_duplicate_identity … page_overlap): at most two seams per
--       window, and only when the repeat is the immediately preceding page's
--       last appended product (tools/naver-shopping-rank-collector/src/provider.mjs).
--   (2) Login redirect: a search tab Naver redirects to nid.naver.com (or any
--       other naver.com host outside search.shopping) cannot be scripted by the
--       extension; it is now reported as naver_verification_required (cooldown +
--       surfaced tab) instead of naver_page_script_failed (2026-09-10 outage,
--       tools/naver-shopping-chrome-extension/service-worker.js).
-- This migration only moves the runtime identity pins: the finite-window target
-- rows, the coordination row and the progress entry gate (the single
-- allowlisted runtime-literal carrier, scripts/migration-runtime-literal-audit.mjs).
-- Every other RPC has been runtime-neutral since 20260903213000. Apply inside the
-- stop window (both Chromes closed) right after the 1.1.22 server release is
-- live; from this point a 1.1.21 worker is rejected by the progress gate until
-- it is updated.
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
    raise exception 'naver_shopping_runtime_1_1_22_requires_completed_account_priority';
  end if;

  if coordination_found is not true
    or current_row.runtime_version is distinct from '1.1.21'
    or current_row.runtime_fingerprint is distinct from
      '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0'
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
    raise exception 'naver_shopping_runtime_1_1_22_requires_idle_control_plane';
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
    where runtime_version is distinct from '1.1.21'
       or runtime_fingerprint is distinct from
         '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0'
  ) then
    raise exception 'naver_shopping_runtime_1_1_22_finite_target_identity_mismatch';
  end if;

  update public.naver_shopping_finite_window_targets
  set runtime_version = '1.1.22',
      runtime_fingerprint =
        '98f404a50ac89ce34092b0906a0923d197a3ca14024e098e1e4d4e510020509e'
  where runtime_version = '1.1.21'
    and runtime_fingerprint = '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0';
  get diagnostics target_updated_count = row_count;

  if target_updated_count <> prior_target_count then
    raise exception 'naver_shopping_runtime_1_1_22_target_mismatch';
  end if;
end
$target_transition$;

alter table public.naver_shopping_finite_window_targets
  add constraint naver_shopping_finite_window_targets_runtime_version_check
    check (runtime_version = '1.1.22');

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
    and runtime_version = '1.1.21'
    and runtime_fingerprint = '84334f5a68291a170b57c999840d50b42c0ef1301b2c3e817190bc7f242f20e0';
  get diagnostics coordination_updated_count = row_count;

  if coordination_updated_count <> 1 then
    raise exception 'naver_shopping_runtime_1_1_22_coordination_mismatch';
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
  expected_runtime_version constant text := '1.1.22';
  expected_runtime_fingerprint constant text :=
    '98f404a50ac89ce34092b0906a0923d197a3ca14024e098e1e4d4e510020509e';
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
revoke all on function public.mi_report_naver_shopping_worker_progress(
  text, uuid, uuid, text, integer, text, uuid, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_report_naver_shopping_worker_progress(
  text, uuid, uuid, text, integer, text, uuid, text, text, text
) to service_role;
commit;
