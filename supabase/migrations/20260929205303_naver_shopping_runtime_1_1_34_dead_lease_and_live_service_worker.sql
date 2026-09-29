-- Runtime 1.1.34 (2026-09-29): a running service worker that proves its own build, and a
-- worker that reloads itself when its files moved on without it.
-- 2026-09-29 third failover drill (KST):
-- F1 The Windows primary claimed a group at 16:04:32 and its Chrome and native host were
--    killed mid-collection. The tracker claim was released at 16:04:39 (fail), but the
--    process died before record-failure and release, so the lane lease stood until
--    16:39:32 (35 minutes): the Mac standby and the primary that came back at 16:19:30
--    both got busy, and collection resumed only at 16:44:32 (commit 16:45:49).
--    Fixed by the separate runtime-neutral migration
--    20260929120000_naver_shopping_dead_lease_takeover.sql (applied before this one): a
--    lease with no holder write for 6 minutes and navigating for more than 16 minutes (or
--    never navigating) expires in place at the next claim.
-- F2 The commit alarm counted only the 300-rank commit (last 15:55:17, stalled 16:40:17):
--    the finite-window commit at 16:45:49 did not clear it and it stayed on until the next
--    300-rank commit at 16:56:00. Fixed server-side only (the latest of
--    coordination.last_success_at and the active trackers' last_checked_at); no DB change.
-- F3 The Mac standby's collection profile (Profile 5) ran the service worker registered on
--    09-19 from the previous release until 09-29 15:41 although the unpacked files and the
--    manifest on disk were already the newer runtime; a Chrome restart on 09-28 did not
--    register it again, a manual reload on chrome://extensions did. The runtime identity
--    (disk manifest + hashes of the files on disk) could not see it.
-- Now: service-worker.js carries SERVICE_WORKER_BUILD, reported as serviceWorkerBuild in
-- the runtime identity. The native host refuses a missing or different build before ready,
-- that is before any claim (native_host_service_worker_stale, no server request). The
-- worker compares its build with the loaded and the on-disk manifest and calls
-- chrome.runtime.reload() at most once per 30 minutes per target version. The Windows
-- updater waits up to 180 s for Secure Preferences to show the registered service worker at
-- the expected version (MI_EXTENSION_SW_STALE otherwise).
-- This migration only moves the runtime identity pins: the finite-window target
-- rows, the coordination row and the progress entry gate (the single
-- allowlisted runtime-literal carrier, scripts/migration-runtime-literal-audit.mjs).
-- Apply right after the 1.1.34 server release is live and the coordination row
-- is idle on 1.1.33 (the release itself stops the 1.1.33 worker at the HTTP gate).
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
    raise exception 'naver_shopping_runtime_1_1_34_requires_completed_account_priority';
  end if;

  if coordination_found is not true
    or current_row.runtime_version is distinct from '1.1.33'
    or current_row.runtime_fingerprint is distinct from
      'b0b47390774e8b935542773eec960779533f4b6e71b73a6dd603c58391a3d36e'
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
    raise exception 'naver_shopping_runtime_1_1_34_requires_idle_control_plane';
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
    where runtime_version is distinct from '1.1.33'
       or runtime_fingerprint is distinct from
         'b0b47390774e8b935542773eec960779533f4b6e71b73a6dd603c58391a3d36e'
  ) then
    raise exception 'naver_shopping_runtime_1_1_34_finite_target_identity_mismatch';
  end if;

  update public.naver_shopping_finite_window_targets
  set runtime_version = '1.1.34',
      runtime_fingerprint =
        '5db29dbd1ca354fb50756e073e57c52b2a95f978bea89ba57d7c8c1e41856daf'
  where runtime_version = '1.1.33'
    and runtime_fingerprint = 'b0b47390774e8b935542773eec960779533f4b6e71b73a6dd603c58391a3d36e';
  get diagnostics target_updated_count = row_count;

  if target_updated_count <> prior_target_count then
    raise exception 'naver_shopping_runtime_1_1_34_target_mismatch';
  end if;
end
$target_transition$;

alter table public.naver_shopping_finite_window_targets
  add constraint naver_shopping_finite_window_targets_runtime_version_check
    check (runtime_version = '1.1.34');

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
    and runtime_version = '1.1.33'
    and runtime_fingerprint = 'b0b47390774e8b935542773eec960779533f4b6e71b73a6dd603c58391a3d36e';
  get diagnostics coordination_updated_count = row_count;

  if coordination_updated_count <> 1 then
    raise exception 'naver_shopping_runtime_1_1_34_coordination_mismatch';
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
  expected_runtime_version constant text := '1.1.34';
  expected_runtime_fingerprint constant text :=
    '5db29dbd1ca354fb50756e073e57c52b2a95f978bea89ba57d7c8c1e41856daf';
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
