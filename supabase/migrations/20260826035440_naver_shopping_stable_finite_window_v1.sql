-- Stable finite-window v1 is deliberately narrower than atomic300. It permits
-- one exact positive parent-catalog rank to be stored without turning that
-- snapshot into worker success, cadence stability or candidate evidence.

begin;

set local lock_timeout = '5s';
lock table public.naver_shopping_worker_coordination in access exclusive mode;

do $idle_guard$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  processing_count integer := 0;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  select (
    (select count(*) from public.naver_shopping_rank_lookup_jobs
      where status = 'processing' and processing_until > clock_timestamp())
    +
    (select count(*) from public.naver_rank_trackers
      where status = 'active' and processing_until > clock_timestamp())
  )::integer into processing_count;

  if not found
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
    raise exception 'naver_shopping_stable_finite_window_requires_idle_control_plane';
  end if;
end
$idle_guard$;

create table public.naver_shopping_finite_window_targets (
  tracker_id uuid primary key,
  seller_product_id text not null
    check (seller_product_id ~ '^[0-9]{5,80}$'),
  parent_catalog_id text not null
    check (parent_catalog_id ~ '^[0-9]{5,80}$'),
  normalized_keyword text not null
    check (char_length(normalized_keyword) between 1 and 120),
  proof_version text not null
    check (proof_version = 'stable-finite-window-v1'),
  runtime_version text not null
    check (runtime_version = '1.1.14'),
  runtime_fingerprint text not null
    check (
      runtime_fingerprint ~ '^[a-f0-9]{64}$'
      and runtime_fingerprint <> repeat('0', 64)
    ),
  enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  check (seller_product_id <> parent_catalog_id)
);

comment on table public.naver_shopping_finite_window_targets is
  'Migration-owned, service-role-readable exact-ID allowlist for stable finite-window rank commits.';

alter table public.naver_shopping_finite_window_targets enable row level security;
alter table public.naver_shopping_finite_window_targets force row level security;
revoke all on table public.naver_shopping_finite_window_targets
from public, anon, authenticated, service_role;
grant select on table public.naver_shopping_finite_window_targets
to service_role;

-- Snapshot history remains tenant/admin readable, but only trusted server
-- paths may mutate it. In particular, an authenticated admin must not be able
-- to forge a finite-looking row that reaches the SECURITY DEFINER audit
-- trigger while a real worker claim is live.
revoke insert, update, delete on table public.naver_rank_snapshots
from public, anon, authenticated;
drop policy if exists naver_rank_snapshots_admin_all
on public.naver_rank_snapshots;
drop policy if exists naver_rank_snapshots_service_role_write
on public.naver_rank_snapshots;
create policy naver_rank_snapshots_service_role_write
on public.naver_rank_snapshots
for all to service_role
using (true)
with check (true);
grant select on table public.naver_rank_snapshots
to authenticated, service_role;
grant insert, update, delete on table public.naver_rank_snapshots
to service_role;

insert into public.naver_shopping_finite_window_targets(
  tracker_id,
  seller_product_id,
  parent_catalog_id,
  normalized_keyword,
  proof_version,
  runtime_version,
  runtime_fingerprint,
  enabled
) values (
  'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid,
  '13327339525',
  '59776958987',
  '아이쉘차량용거치대',
  'stable-finite-window-v1',
  '1.1.14',
  '13e801cf18adaea7352d7c78bbe067f969e3fef5e756528335443d3122b2d405',
  true
);

-- Runtime 1.1.14 starts from baseline and may earn a new stability proof only
-- through the unchanged exact300 success RPC after the exact identity reports.
update public.naver_shopping_worker_coordination
set cadence_mode = 'baseline',
    cadence_minutes = 10,
    stability_started_at = null,
    success_streak = 0,
    updated_at = clock_timestamp()
where lane_key = 'global';

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
  target public.naver_shopping_finite_window_targets%rowtype;
  updated_count integer := 0;
  normalized_stage text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_stage, '')));
  normalized_kind text := nullif(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_job_kind, ''))), ''
  );
  normalized_trigger text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_run_trigger, '')));
  v_now timestamptz := clock_timestamp();
begin
  select * into target
  from public.naver_shopping_finite_window_targets
  where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and seller_product_id = '13327339525'
    and parent_catalog_id = '59776958987'
    and proof_version = 'stable-finite-window-v1'
    and enabled = true;

  if not found
    or target.runtime_version is distinct from '1.1.14'
    or target.runtime_fingerprint !~ '^[a-f0-9]{64}$'
    or target.runtime_fingerprint = repeat('0', 64)
    or p_run_id is null
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
      is distinct from target.runtime_version
    or pg_catalog.lower(pg_catalog.btrim(coalesce(p_runtime_fingerprint, '')))
      is distinct from target.runtime_fingerprint then
    return false;
  end if;

  update public.naver_shopping_worker_coordination
  set cadence_mode = case
        when runtime_version is distinct from target.runtime_version
          or runtime_fingerprint is distinct from target.runtime_fingerprint
        then 'baseline'
        else cadence_mode
      end,
      cadence_minutes = case
        when runtime_version is distinct from target.runtime_version
          or runtime_fingerprint is distinct from target.runtime_fingerprint
        then 10
        else cadence_minutes
      end,
      stability_started_at = case
        when runtime_version is distinct from target.runtime_version
          or runtime_fingerprint is distinct from target.runtime_fingerprint
        then null
        else stability_started_at
      end,
      success_streak = case
        when runtime_version is distinct from target.runtime_version
          or runtime_fingerprint is distinct from target.runtime_fingerprint
        then 0
        else success_streak
      end,
      run_id = p_run_id,
      runtime_version = target.runtime_version,
      runtime_fingerprint = target.runtime_fingerprint,
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
      target.runtime_version,
      target.runtime_fingerprint,
      v_now
    )
    on conflict (run_id) do nothing;

    if not exists (
      select 1
      from public.naver_shopping_worker_runs as recorded_run
      where recorded_run.run_id = p_run_id
        and recorded_run.worker_id = pg_catalog.lower(pg_catalog.btrim(p_worker_id))
        and recorded_run.run_trigger = normalized_trigger
        and recorded_run.runtime_version = target.runtime_version
        and recorded_run.runtime_fingerprint = target.runtime_fingerprint
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
  target public.naver_shopping_finite_window_targets%rowtype;
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

  select * into target
  from public.naver_shopping_finite_window_targets
  where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and seller_product_id = '13327339525'
    and parent_catalog_id = '59776958987'
    and proof_version = 'stable-finite-window-v1'
    and runtime_version = '1.1.14'
    and enabled = true;

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
      target.tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
      and target.runtime_version = '1.1.14'
      and target.runtime_fingerprint ~ '^[a-f0-9]{64}$'
      and target.runtime_fingerprint <> repeat('0', 64)
      and current_row.circuit_state = 'closed'
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
      and current_row.runtime_version = target.runtime_version
      and current_row.runtime_fingerprint = target.runtime_fingerprint
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
  target public.naver_shopping_finite_window_targets%rowtype;
  processing_count integer := 0;
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

  select * into target
  from public.naver_shopping_finite_window_targets
  where tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and seller_product_id = '13327339525'
    and parent_catalog_id = '59776958987'
    and proof_version = 'stable-finite-window-v1'
    and runtime_version = '1.1.14'
    and enabled = true;

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
    return pg_catalog.jsonb_build_object(
      'accepted', true,
      'activated', true,
      'mode', 'baseline',
      'minutes', 10
    );
  end if;

  eligible := coalesce((
    target.tracker_id = 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    and target.runtime_version = '1.1.14'
    and target.runtime_fingerprint ~ '^[a-f0-9]{64}$'
    and target.runtime_fingerprint <> repeat('0', 64)
    and current_row.circuit_state = 'closed'
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
    and current_row.runtime_version = target.runtime_version
    and current_row.runtime_fingerprint = target.runtime_fingerprint
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

-- Preserve every prior event class, including bounded-cycle deferral. A finite
-- positive match is a terminal of its own type and never tracker_committed.
alter table public.naver_shopping_scheduler_events
  drop constraint if exists naver_shopping_scheduler_events_event_type_check,
  drop constraint if exists naver_shopping_scheduler_events_atomic_committed_check,
  drop constraint if exists naver_shopping_scheduler_events_finite_window_committed_check,
  add constraint naver_shopping_scheduler_events_event_type_check check (event_type in (
    'ledger_enabled',
    'cycle_started',
    'cycle_rostered',
    'group_claimed',
    'tracker_claimed',
    'tracker_deferred',
    'tracker_committed',
    'finite_window_committed',
    'job_failed',
    'quarantine_set',
    'quarantine_cleared',
    'quarantine_repair_override',
    'cycle_completed'
  )),
  add constraint naver_shopping_scheduler_events_atomic_committed_check check (
    event_type <> 'tracker_committed'
    or (collection_id is not null and checked_count is not distinct from 300)
  ),
  add constraint naver_shopping_scheduler_events_finite_window_committed_check check (
    event_type <> 'finite_window_committed'
    or (
      claim_id is not null
      and run_id is not null
      and worker_id is not null
      and tracker_id is not null
      and group_fingerprint is not null
      and collection_id ~ '^pw-chrome-'
      and checked_count is not null
      and checked_count between 1 and 299
      and details ->> 'source' is not distinct from 'naver_shopping_results_collector'
      and details ->> 'finiteWindowProofVersion' is not distinct from 'stable-finite-window-v1'
      and details -> 'sourceExhausted' is not distinct from 'true'::jsonb
      and details -> 'marketTotal' is not distinct from pg_catalog.to_jsonb(checked_count)
      and details -> 'matched' is not distinct from 'true'::jsonb
      and details ->> 'rank' is not null
      and details ->> 'rank' ~ '^[1-9][0-9]*$'
      and (details ->> 'rank')::integer between 1 and checked_count
      and details ->> 'relationBasis' is not distinct from 'catalog_seller_product_id'
      and details -> 'atomicSuccessEligible' is not distinct from 'false'::jsonb
    )
  );

drop index if exists public.idx_naver_shopping_scheduler_events_terminal_sequence;
create index idx_naver_shopping_scheduler_events_terminal_sequence
on public.naver_shopping_scheduler_events(claim_id, tracker_id, event_id)
where event_type in ('tracker_committed', 'finite_window_committed', 'job_failed')
  and claim_id is not null;

create index if not exists idx_naver_shopping_scheduler_events_finite_terminal_sequence
on public.naver_shopping_scheduler_events(claim_id, tracker_id, event_id)
where event_type = 'finite_window_committed' and claim_id is not null;

create unique index if not exists idx_naver_shopping_scheduler_events_finite_collection_once
on public.naver_shopping_scheduler_events(tracker_id, collection_id)
where event_type = 'finite_window_committed';

-- Cycle evidence reports a finite terminal independently. committedTrackers
-- remains the exact300 atomic count used by the existing success protocol.
create or replace function mi_internal.mi_audit_naver_shopping_cycle_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.date_trunc('milliseconds', clock_timestamp());
  v_active integer := 0;
  v_eligible integer := 0;
  v_quarantined integer := 0;
  v_claimed integer := 0;
  v_scheduled integer := 0;
  v_repair integer := 0;
  v_committed integer := 0;
  v_finite_window_committed integer := 0;
  v_failed integer := 0;
begin
  if new.scheduler_cycle_status = 'active'
    and new.scheduler_cycle_id is not null
    and (
      old.scheduler_cycle_id is distinct from new.scheduler_cycle_id
      or old.scheduler_cycle_status is distinct from 'active'
    ) then
    delete from public.naver_shopping_scheduler_events
    where retention_until <= v_now;

    select
      count(*)::integer,
      count(*) filter (
        where tracker.worker_quarantined_until is null
          or tracker.worker_quarantined_until <= v_now
      )::integer,
      count(*) filter (
        where tracker.worker_quarantined_until > v_now
      )::integer
    into v_active, v_eligible, v_quarantined
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active';

    insert into public.naver_shopping_scheduler_events(
      occurred_at,
      retention_until,
      event_type,
      cycle_id,
      cycle_number,
      details
    ) values (
      coalesce(new.scheduler_cycle_started_at, v_now),
      v_now + interval '90 days',
      'cycle_started',
      new.scheduler_cycle_id,
      new.scheduler_cycle_number,
      pg_catalog.jsonb_build_object(
        'activeCount', v_active,
        'eligibleCount', v_eligible,
        'quarantinedCount', v_quarantined
      )
    );

    insert into public.naver_shopping_scheduler_events(
      occurred_at,
      retention_until,
      event_type,
      cycle_id,
      cycle_number,
      tracker_id,
      agency_code,
      group_fingerprint,
      roster_state,
      quarantine_until,
      details
    )
    select
      coalesce(new.scheduler_cycle_started_at, v_now),
      v_now + interval '90 days',
      'cycle_rostered',
      new.scheduler_cycle_id,
      new.scheduler_cycle_number,
      tracker.id,
      tracker.agency_code,
      mi_internal.mi_naver_shopping_scheduler_group_fingerprint(
        new.scheduler_cycle_id,
        tracker.keyword
      ),
      case
        when tracker.worker_quarantined_until > v_now then 'quarantined'
        else 'eligible'
      end,
      tracker.worker_quarantined_until,
      pg_catalog.jsonb_build_object(
        'sortOrder', tracker.sort_order,
        'registeredAt', tracker.created_at,
        'neverChecked', tracker.last_checked_at is null
      )
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active';
  end if;

  if new.scheduler_cycle_status = 'completed'
    and new.scheduler_cycle_id is not null
    and (
      old.scheduler_cycle_id is distinct from new.scheduler_cycle_id
      or old.scheduler_cycle_status is distinct from 'completed'
    ) then
    select
      count(distinct event.tracker_id) filter (
        where event.event_type = 'tracker_claimed'
      )::integer,
      count(distinct event.tracker_id) filter (
        where event.event_type = 'tracker_claimed'
          and event.priority in ('new', 'resume', 'normal')
      )::integer,
      count(distinct event.tracker_id) filter (
        where event.event_type = 'tracker_claimed'
          and event.priority = 'repair'
      )::integer,
      count(*) filter (where event.event_type = 'tracker_committed')::integer,
      count(distinct event.tracker_id) filter (
        where event.event_type = 'finite_window_committed'
      )::integer,
      count(*) filter (where event.event_type = 'job_failed')::integer
    into v_claimed, v_scheduled, v_repair, v_committed,
      v_finite_window_committed, v_failed
    from public.naver_shopping_scheduler_events as event
    where event.cycle_id = new.scheduler_cycle_id;

    insert into public.naver_shopping_scheduler_events(
      occurred_at,
      retention_until,
      event_type,
      cycle_id,
      cycle_number,
      details
    ) values (
      coalesce(new.scheduler_cycle_completed_at, v_now),
      v_now + interval '90 days',
      'cycle_completed',
      new.scheduler_cycle_id,
      new.scheduler_cycle_number,
      pg_catalog.jsonb_build_object(
        'distinctClaimedTrackers', v_claimed,
        'scheduledClaimedTrackers', v_scheduled,
        'repairClaimedTrackers', v_repair,
        'committedTrackers', v_committed,
        'finiteWindowCommittedTrackers', v_finite_window_committed,
        'failedTrackers', v_failed
      )
    );
  end if;

  return new;
end;
$$;

revoke all on function mi_internal.mi_audit_naver_shopping_cycle_transition()
from public, anon, authenticated, service_role;

-- The long-standing public commit endpoint remains exact300-only. Stable finite
-- windows use the dedicated endpoint below and therefore cannot accidentally
-- inherit atomic success semantics.
create or replace function public.mi_commit_naver_shopping_worker_result(
  p_tracker_id uuid,
  p_lease_started_at timestamptz,
  p_collection_id text,
  p_checked_at timestamptz,
  p_next_check_at timestamptz,
  p_snapshot jsonb,
  p_product_id text default null,
  p_mall_name text default null,
  p_product_title text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tracker public.naver_rank_trackers%rowtype;
  inserted_snapshot_id uuid;
  matched_rank integer;
begin
  if p_tracker_id is null or p_lease_started_at is null
    or p_collection_id is null or char_length(p_collection_id) < 8
    or char_length(p_collection_id) > 160
    or p_checked_at is null or p_next_check_at is null
    or p_snapshot is null or pg_catalog.jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'local_worker_commit_invalid';
  end if;
  if pg_catalog.jsonb_typeof(p_snapshot -> 'checked_count') is distinct from 'number'
    or (p_snapshot ->> 'checked_count') !~ '^[0-9]+$'
    or (p_snapshot ->> 'checked_count')::integer is distinct from 300 then
    raise exception 'local_worker_commit_requires_atomic_300';
  end if;

  select * into tracker
  from public.naver_rank_trackers
  where id = p_tracker_id
  for update;

  if not found then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.processing_started_at is null then
    select id into inserted_snapshot_id
    from public.naver_rank_snapshots
    where tracker_id = p_tracker_id and collection_id = p_collection_id;
    if inserted_snapshot_id is not null then
      return jsonb_build_object('status', 'already_committed', 'snapshotId', inserted_snapshot_id);
    end if;
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.status <> 'active'
    or tracker.processing_started_at is distinct from p_lease_started_at
    or tracker.processing_until is null
    or tracker.processing_until <= clock_timestamp() then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  select id into inserted_snapshot_id
  from public.naver_rank_snapshots
  where tracker_id = p_tracker_id and collection_id = p_collection_id;
  if inserted_snapshot_id is not null then
    update public.naver_rank_trackers
    set processing_started_at = null,
        processing_until = null,
        next_check_at = clock_timestamp() + interval '5 minutes',
        last_message = '중복 수집 묶음을 차단하고 다시 갱신합니다. 마지막 정상 순위는 유지합니다.',
        last_error = 'local_worker_collection_conflict',
        retry_count = coalesce(retry_count, 0) + 1
    where id = p_tracker_id
      and status = 'active'
      and processing_started_at = p_lease_started_at;
    return jsonb_build_object('status', 'collection_conflict', 'snapshotId', inserted_snapshot_id);
  end if;

  matched_rank := case
    when coalesce((p_snapshot ->> 'matched')::boolean, false)
      then nullif((p_snapshot ->> 'rank')::integer, 0)
    else null
  end;

  insert into public.naver_rank_snapshots(
    tracker_id, checked_at, collection_id, rank, page, position, matched,
    checked_count, total, item, top_items, message, source
  ) values (
    p_tracker_id,
    p_checked_at,
    p_collection_id,
    nullif((p_snapshot ->> 'rank')::integer, 0),
    nullif((p_snapshot ->> 'page')::integer, 0),
    nullif((p_snapshot ->> 'position')::integer, 0),
    coalesce((p_snapshot ->> 'matched')::boolean, false),
    nullif((p_snapshot ->> 'checked_count')::integer, 0),
    nullif((p_snapshot ->> 'total')::integer, 0),
    coalesce(p_snapshot -> 'item', '{}'::jsonb),
    coalesce(p_snapshot -> 'top_items', '[]'::jsonb),
    nullif(p_snapshot ->> 'message', ''),
    coalesce(nullif(p_snapshot ->> 'source', ''), 'naver_shopping_results_collector')
  )
  on conflict (tracker_id, collection_id) where collection_id is not null do nothing
  returning id into inserted_snapshot_id;

  if inserted_snapshot_id is null then
    select id into inserted_snapshot_id
    from public.naver_rank_snapshots
    where tracker_id = p_tracker_id and collection_id = p_collection_id;
    update public.naver_rank_trackers
    set processing_started_at = null,
        processing_until = null,
        next_check_at = clock_timestamp() + interval '5 minutes',
        last_message = '중복 수집 묶음을 차단하고 다시 갱신합니다. 마지막 정상 순위는 유지합니다.',
        last_error = 'local_worker_collection_conflict',
        retry_count = coalesce(retry_count, 0) + 1
    where id = p_tracker_id
      and status = 'active'
      and processing_started_at = p_lease_started_at;
    return jsonb_build_object('status', 'collection_conflict', 'snapshotId', inserted_snapshot_id);
  end if;

  update public.naver_rank_trackers
  set last_checked_at = p_checked_at,
      next_check_at = p_next_check_at,
      current_rank = matched_rank,
      best_rank = case when matched_rank is null then best_rank else least(coalesce(best_rank, matched_rank), matched_rank) end,
      worst_rank = case when matched_rank is null then worst_rank else greatest(coalesce(worst_rank, matched_rank), matched_rank) end,
      check_count = coalesce(check_count, 0) + 1,
      found_count = coalesce(found_count, 0) + case when matched_rank is null then 0 else 1 end,
      last_message = nullif(p_snapshot ->> 'message', ''),
      last_error = null,
      retry_count = 0,
      product_id = coalesce(nullif(product_id, ''), nullif(p_product_id, '')),
      mall_name = coalesce(nullif(mall_name, ''), nullif(p_mall_name, '')),
      product_title = coalesce(nullif(product_title, ''), nullif(p_product_title, '')),
      processing_started_at = null,
      processing_until = null
  where id = p_tracker_id
    and status = 'active'
    and processing_started_at = p_lease_started_at
    and processing_until > clock_timestamp();

  if not found then
    raise exception 'local_worker_lease_lost_after_snapshot';
  end if;

  return jsonb_build_object('status', 'committed', 'snapshotId', inserted_snapshot_id);
end;
$$;

create or replace function public.mi_commit_naver_shopping_finite_worker_result(
  p_tracker_id uuid,
  p_lease_started_at timestamptz,
  p_collection_id text,
  p_checked_at timestamptz,
  p_next_check_at timestamptz,
  p_snapshot jsonb,
  p_product_id text default null,
  p_mall_name text default null,
  p_product_title text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tracker public.naver_rank_trackers%rowtype;
  target public.naver_shopping_finite_window_targets%rowtype;
  claim public.naver_shopping_scheduler_events%rowtype;
  current_row public.naver_shopping_worker_coordination%rowtype;
  inserted_snapshot_id uuid;
  checked_count integer;
  matched_rank integer;
  market_total integer;
  tracker_claim_count integer := 0;
  group_claim_count integer := 0;
  finite_event_count integer := 0;
  run_trigger text;
  item jsonb;
begin
  if p_tracker_id is null or p_lease_started_at is null
    or p_collection_id is null or p_collection_id !~ '^pw-chrome-'
    or char_length(p_collection_id) > 160
    or p_checked_at is null or p_next_check_at is null
    or p_snapshot is null or pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'checked_count') is distinct from 'number'
    or (p_snapshot ->> 'checked_count') !~ '^[0-9]+$'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'rank') is distinct from 'number'
    or (p_snapshot ->> 'rank') !~ '^[1-9][0-9]*$'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'total') is distinct from 'number'
    or (p_snapshot ->> 'total') !~ '^[1-9][0-9]*$'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'item') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_snapshot -> 'top_items') is distinct from 'array' then
    raise exception 'local_worker_finite_commit_invalid';
  end if;

  checked_count := (p_snapshot ->> 'checked_count')::integer;
  matched_rank := (p_snapshot ->> 'rank')::integer;
  market_total := (p_snapshot ->> 'total')::integer;
  item := p_snapshot -> 'item';

  select * into target
  from public.naver_shopping_finite_window_targets
  where tracker_id = p_tracker_id
    and enabled = true;

  -- finite exact relation gate begin
  if not found
    or p_tracker_id is distinct from 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid
    or p_product_id is distinct from '13327339525'
    or target.seller_product_id is distinct from '13327339525'
    or target.parent_catalog_id is distinct from '59776958987'
    or target.proof_version is distinct from 'stable-finite-window-v1'
    or checked_count not between 1 and 299
    or matched_rank not between 1 and checked_count
    or market_total is distinct from checked_count
    or p_snapshot -> 'matched' is distinct from 'true'::jsonb
    or p_snapshot ->> 'source' is distinct from 'naver_shopping_results_collector'
    or item ->> 'finiteWindowProofVersion' is distinct from 'stable-finite-window-v1'
    or item -> 'sourceExhausted' is distinct from 'true'::jsonb
    or item -> 'finiteMarketTotal' is distinct from pg_catalog.to_jsonb(market_total)
    or item -> 'atomicSuccessEligible' is distinct from 'false'::jsonb
    or item ->> 'trackingRankSource' is distinct from 'related_catalog'
    or item ->> 'relatedCatalogProductId' is distinct from target.parent_catalog_id
    or item ->> 'relatedCatalogRelationBasis' is distinct from 'catalog_seller_product_id'
    or item ->> 'catalogId' is distinct from target.parent_catalog_id
    or pg_catalog.jsonb_typeof(item -> 'catalogSellerProductIds') is distinct from 'array'
    or pg_catalog.jsonb_array_length(item -> 'catalogSellerProductIds') not between 1 and 100
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(item -> 'catalogSellerProductIds') as seller_id(seller_id)
      where seller_id.seller_id = target.seller_product_id
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(item -> 'catalogSellerProductIds') as seller_id(seller_id)
      where seller_id.seller_id !~ '^[0-9]{5,80}$'
    )
    or item ->> 'rankPolicy' is distinct from 'organic_only'
    or item -> 'adExcluded' is distinct from 'true'::jsonb
    or item ->> 'rankEvidence' is distinct from 'naver_shopping_organic_list'
    or item ->> 'collectionId' is distinct from p_collection_id
    or item -> 'isOrganic' is distinct from 'true'::jsonb
    or item -> 'isAd' is distinct from 'false'::jsonb
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_snapshot -> 'top_items') as top_item
      where top_item -> 'isOrganic' is distinct from 'true'::jsonb
        or top_item -> 'isAd' is distinct from 'false'::jsonb
    ) then
    raise exception 'local_worker_finite_exact_relation_invalid';
  end if;
  -- finite exact relation gate end

  select * into tracker
  from public.naver_rank_trackers
  where id = p_tracker_id
  for update;

  if not found then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.status <> 'active'
    or tracker.product_id is distinct from target.seller_product_id
    or pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\s+', '', 'g'
    ) is distinct from target.normalized_keyword then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.processing_started_at is null then
    select snapshot.id into inserted_snapshot_id
    from public.naver_rank_snapshots as snapshot
    where snapshot.tracker_id = p_tracker_id
      and snapshot.collection_id = p_collection_id
      and snapshot.source = 'naver_shopping_results_collector'
      and snapshot.checked_count between 1 and 299
      and snapshot.matched = true
      and snapshot.rank between 1 and snapshot.checked_count
      and snapshot.total = snapshot.checked_count
      and snapshot.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'
      and snapshot.item -> 'sourceExhausted' = 'true'::jsonb
      and snapshot.item -> 'finiteMarketTotal' =
        pg_catalog.to_jsonb(snapshot.checked_count)
      and snapshot.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'
      and snapshot.item ->> 'relatedCatalogProductId' = target.parent_catalog_id
      and snapshot.item ->> 'trackingRankSource' = 'related_catalog'
      and snapshot.item ->> 'catalogId' = target.parent_catalog_id
      and pg_catalog.jsonb_typeof(
        snapshot.item -> 'catalogSellerProductIds'
      ) = 'array'
      and pg_catalog.jsonb_array_length(
        snapshot.item -> 'catalogSellerProductIds'
      ) between 1 and 100
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          snapshot.item -> 'catalogSellerProductIds'
        ) as seller_id(seller_id)
        where seller_id.seller_id = target.seller_product_id
      )
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          snapshot.item -> 'catalogSellerProductIds'
        ) as seller_id(seller_id)
        where seller_id.seller_id !~ '^[0-9]{5,80}$'
      )
      and snapshot.item ->> 'rankPolicy' = 'organic_only'
      and snapshot.item -> 'adExcluded' = 'true'::jsonb
      and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
      and snapshot.item ->> 'collectionId' = snapshot.collection_id
      and snapshot.item -> 'isOrganic' = 'true'::jsonb
      and snapshot.item -> 'isAd' = 'false'::jsonb
      and snapshot.item -> 'atomicSuccessEligible' = 'false'::jsonb
      and pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(snapshot.top_items) as top_item
        where top_item -> 'isOrganic' is distinct from 'true'::jsonb
          or top_item -> 'isAd' is distinct from 'false'::jsonb
      )
      and exists (
        select 1
        from public.naver_shopping_scheduler_events as committed
        join public.naver_shopping_scheduler_events as representative_claim
          on representative_claim.event_type = 'tracker_claimed'
         and representative_claim.claim_id = committed.claim_id
         and representative_claim.run_id = committed.run_id
         and representative_claim.worker_id = committed.worker_id
         and representative_claim.tracker_id = committed.tracker_id
         and representative_claim.group_fingerprint = committed.group_fingerprint
         and representative_claim.lease_started_at = committed.lease_started_at
         and representative_claim.priority = committed.priority
         and representative_claim.event_id < committed.event_id
        join public.naver_shopping_scheduler_events as grouped
          on grouped.event_type = 'group_claimed'
         and grouped.claim_id = representative_claim.claim_id
         and grouped.run_id = representative_claim.run_id
         and grouped.worker_id = representative_claim.worker_id
         and grouped.group_fingerprint = representative_claim.group_fingerprint
         and grouped.details -> 'memberCount' = pg_catalog.to_jsonb(1)
         and grouped.event_id < representative_claim.event_id
        join public.naver_shopping_worker_runs as runs
          on runs.run_id = committed.run_id
         and runs.worker_id = committed.worker_id
         and runs.run_trigger = 'rank-catch-up'
         and runs.runtime_version = target.runtime_version
         and runs.runtime_fingerprint = target.runtime_fingerprint
        where committed.event_type = 'finite_window_committed'
          and committed.tracker_id = snapshot.tracker_id
          and committed.collection_id = snapshot.collection_id
          and committed.checked_count = snapshot.checked_count
          and committed.occurred_at = snapshot.checked_at
          and committed.worker_id = 'windows-desktop-primary'
          and committed.priority in ('new', 'resume', 'normal')
          and committed.details ->> 'source' is not distinct from snapshot.source
          and committed.details ->> 'finiteWindowProofVersion'
            is not distinct from 'stable-finite-window-v1'
          and committed.details -> 'sourceExhausted'
            is not distinct from 'true'::jsonb
          and committed.details -> 'marketTotal'
            is not distinct from pg_catalog.to_jsonb(snapshot.total)
          and committed.details -> 'matched'
            is not distinct from 'true'::jsonb
          and committed.details -> 'rank'
            is not distinct from pg_catalog.to_jsonb(snapshot.rank)
          and committed.details ->> 'relationBasis'
            is not distinct from 'catalog_seller_product_id'
          and committed.details -> 'atomicSuccessEligible'
            is not distinct from 'false'::jsonb
          and (
            select count(*)
            from public.naver_shopping_scheduler_events as claimed
            where claimed.event_type = 'tracker_claimed'
              and claimed.claim_id = committed.claim_id
          ) = 1
          and (
            select count(*)
            from public.naver_shopping_scheduler_events as finite_terminal
            where finite_terminal.event_type = 'finite_window_committed'
              and finite_terminal.tracker_id = snapshot.tracker_id
              and finite_terminal.collection_id = snapshot.collection_id
          ) = 1
          and not exists (
            select 1
            from public.naver_shopping_scheduler_events as conflicting_terminal
            where conflicting_terminal.claim_id = committed.claim_id
              and conflicting_terminal.tracker_id = snapshot.tracker_id
              and conflicting_terminal.event_type in ('tracker_committed', 'job_failed')
          )
      );
    if inserted_snapshot_id is not null then
      return jsonb_build_object('status', 'already_committed', 'snapshotId', inserted_snapshot_id);
    end if;
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if tracker.processing_started_at is distinct from p_lease_started_at
    or tracker.processing_until is null
    or tracker.processing_until <= clock_timestamp() then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  select event.* into claim
  from public.naver_shopping_scheduler_events as event
  where event.event_type = 'tracker_claimed'
    and event.tracker_id = p_tracker_id
    and event.lease_started_at = p_lease_started_at
  order by event.event_id desc
  limit 1;
  if not found or claim.run_id is null or claim.claim_id is null
    or claim.worker_id is distinct from 'windows-desktop-primary'
    or claim.priority not in ('new', 'resume', 'normal') then
    raise exception 'local_worker_finite_claim_invalid';
  end if;

  select count(*)::integer into tracker_claim_count
  from public.naver_shopping_scheduler_events as claimed
  where claimed.event_type = 'tracker_claimed'
    and claimed.claim_id = claim.claim_id;
  select count(*)::integer into group_claim_count
  from public.naver_shopping_scheduler_events as grouped
  where grouped.event_type = 'group_claimed'
    and grouped.claim_id = claim.claim_id
    and grouped.run_id = claim.run_id
    and grouped.worker_id = claim.worker_id
    and grouped.group_fingerprint = claim.group_fingerprint
    and grouped.details -> 'memberCount' = pg_catalog.to_jsonb(1);
  if tracker_claim_count <> 1 or group_claim_count <> 1 then
    raise exception 'local_worker_finite_group_invalid';
  end if;

  select runs.run_trigger into run_trigger
  from public.naver_shopping_worker_runs as runs
  where runs.run_id = claim.run_id
    and runs.worker_id = claim.worker_id
    and runs.runtime_version = target.runtime_version
    and runs.runtime_fingerprint = target.runtime_fingerprint;
  if not found or run_trigger <> 'rank-catch-up' then
    raise exception 'local_worker_finite_run_invalid';
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global';
  if not found
    or current_row.lease_worker_id is distinct from claim.worker_id
    or current_row.run_id is distinct from claim.run_id
    or current_row.runtime_version is distinct from target.runtime_version
    or current_row.runtime_fingerprint is distinct from target.runtime_fingerprint
    or current_row.current_job_kind is distinct from 'tracker'
    or current_row.current_tracker_id is distinct from p_tracker_id
    or current_row.lease_until is null
    or current_row.lease_until <= clock_timestamp()
    or current_row.circuit_state = 'open'
    or not exists (
      select 1
      from public.naver_shopping_worker_runs as runs
      where runs.run_id = claim.run_id
        and runs.runtime_fingerprint = current_row.runtime_fingerprint
    )
    or exists (
      select 1
      from public.naver_shopping_scheduler_events as failed
      where failed.event_type = 'job_failed'
        and failed.claim_id = claim.claim_id
    ) then
    raise exception 'local_worker_finite_control_invalid';
  end if;

  select id into inserted_snapshot_id
  from public.naver_rank_snapshots
  where tracker_id = p_tracker_id and collection_id = p_collection_id;
  if inserted_snapshot_id is not null then
    update public.naver_rank_trackers
    set processing_started_at = null,
        processing_until = null,
        next_check_at = clock_timestamp() + interval '5 minutes',
        last_message = '중복 수집 묶음을 차단하고 다시 갱신합니다. 마지막 정상 순위는 유지합니다.',
        last_error = 'local_worker_collection_conflict',
        retry_count = coalesce(retry_count, 0) + 1
    where id = p_tracker_id
      and status = 'active'
      and processing_started_at = p_lease_started_at;
    return jsonb_build_object('status', 'collection_conflict', 'snapshotId', inserted_snapshot_id);
  end if;

  insert into public.naver_rank_snapshots(
    tracker_id, checked_at, collection_id, rank, page, position, matched,
    checked_count, total, item, top_items, message, source
  ) values (
    p_tracker_id,
    p_checked_at,
    p_collection_id,
    matched_rank,
    nullif((p_snapshot ->> 'page')::integer, 0),
    nullif((p_snapshot ->> 'position')::integer, 0),
    true,
    checked_count,
    market_total,
    item,
    p_snapshot -> 'top_items',
    nullif(p_snapshot ->> 'message', ''),
    'naver_shopping_results_collector'
  )
  on conflict (tracker_id, collection_id) where collection_id is not null do nothing
  returning id into inserted_snapshot_id;

  if inserted_snapshot_id is null then
    select id into inserted_snapshot_id
    from public.naver_rank_snapshots
    where tracker_id = p_tracker_id and collection_id = p_collection_id;
    update public.naver_rank_trackers
    set processing_started_at = null,
        processing_until = null,
        next_check_at = clock_timestamp() + interval '5 minutes',
        last_message = '중복 수집 묶음을 차단하고 다시 갱신합니다. 마지막 정상 순위는 유지합니다.',
        last_error = 'local_worker_collection_conflict',
        retry_count = coalesce(retry_count, 0) + 1
    where id = p_tracker_id
      and status = 'active'
      and processing_started_at = p_lease_started_at;
    return jsonb_build_object('status', 'collection_conflict', 'snapshotId', inserted_snapshot_id);
  end if;

  select count(*)::integer into finite_event_count
  from public.naver_shopping_scheduler_events as committed
  where committed.event_type = 'finite_window_committed'
    and committed.claim_id = claim.claim_id
    and committed.run_id = claim.run_id
    and committed.worker_id = claim.worker_id
    and committed.tracker_id = p_tracker_id
    and committed.collection_id = p_collection_id
    and committed.checked_count = checked_count;
  if finite_event_count <> 1 then
    raise exception 'local_worker_finite_ledger_missing';
  end if;

  update public.naver_rank_trackers
  set last_checked_at = p_checked_at,
      next_check_at = p_next_check_at,
      current_rank = matched_rank,
      best_rank = least(coalesce(best_rank, matched_rank), matched_rank),
      worst_rank = greatest(coalesce(worst_rank, matched_rank), matched_rank),
      check_count = coalesce(check_count, 0) + 1,
      found_count = coalesce(found_count, 0) + 1,
      last_message = nullif(p_snapshot ->> 'message', ''),
      last_error = null,
      retry_count = 0,
      processing_started_at = null,
      processing_until = null
  where id = p_tracker_id
    and status = 'active'
    and processing_started_at = p_lease_started_at
    and processing_until > clock_timestamp();

  if not found then
    raise exception 'local_worker_finite_lease_lost_after_snapshot';
  end if;

  return jsonb_build_object(
    'status', 'committed',
    'snapshotId', inserted_snapshot_id,
    'finiteWindow', true,
    'atomicSuccessEligible', false
  );
end;
$$;

-- Finite proof failures are tracker-local. Only the exact canary, exact 1.1.14
-- identity and same-claim failure ledger may preserve an existing cadence
-- proof. Every other failure keeps the pre-existing fail-closed behavior.
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
    and runtime_version = '1.1.14'
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
      and pg_catalog.lower(pg_catalog.btrim(coalesce(p_worker_id, ''))) = 'windows-desktop-primary'
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
          and (
            (
              current_row.runtime_version = '1.1.13'
              and current_row.runtime_fingerprint =
                'cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6'
            )
            or (
              finite_target_available
              and current_row.runtime_version = target.runtime_version
              and current_row.runtime_fingerprint = target.runtime_fingerprint
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
          and finite_target_available
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
          and current_row.runtime_version = target.runtime_version
          and current_row.runtime_fingerprint = target.runtime_fingerprint
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
             and runs.runtime_version = target.runtime_version
             and runs.runtime_fingerprint = target.runtime_fingerprint
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

-- Keep the exact300 audit branch byte-for-byte equivalent in meaning, then add
-- a mutually exclusive finite branch. Capture IDs and ordered digests are
-- intentionally not persisted in the ledger.
create or replace function mi_internal.mi_audit_naver_shopping_snapshot_commit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.naver_shopping_scheduler_events(
    occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id,
    worker_id, tracker_id, agency_code, group_fingerprint, priority,
    lease_started_at, lease_until, collection_id, checked_count, details
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
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
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

  insert into public.naver_shopping_scheduler_events(
    occurred_at, event_type, cycle_id, cycle_number, claim_id, run_id,
    worker_id, tracker_id, agency_code, group_fingerprint, priority,
    lease_started_at, lease_until, collection_id, checked_count, details
  )
  select
    snapshot.checked_at,
    'finite_window_committed',
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
    pg_catalog.jsonb_build_object(
      'matched', true,
      'rank', snapshot.rank,
      'source', snapshot.source,
      'finiteWindowProofVersion', 'stable-finite-window-v1',
      'sourceExhausted', true,
      'marketTotal', snapshot.total,
      'relationBasis', 'catalog_seller_product_id',
      'atomicSuccessEligible', false
    )
  from new_snapshots as snapshot
  join public.naver_rank_trackers as tracker
    on tracker.id = snapshot.tracker_id
  join public.naver_shopping_finite_window_targets as target
    on target.tracker_id = snapshot.tracker_id
   and target.enabled = true
   and target.seller_product_id = tracker.product_id
   and target.proof_version = 'stable-finite-window-v1'
  join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.tracker_id = snapshot.tracker_id
      and event.lease_started_at = tracker.processing_started_at
    order by event.event_id desc
    limit 1
  ) as claim on true
  join public.naver_shopping_scheduler_events as grouped
    on grouped.event_type = 'group_claimed'
   and grouped.claim_id = claim.claim_id
   and grouped.run_id = claim.run_id
   and grouped.worker_id = claim.worker_id
   and grouped.group_fingerprint = claim.group_fingerprint
   and grouped.details -> 'memberCount' = pg_catalog.to_jsonb(1)
  join public.naver_shopping_worker_runs as runs
    on runs.run_id = claim.run_id
   and runs.worker_id = claim.worker_id
   and runs.run_trigger = 'rank-catch-up'
   and runs.runtime_version = target.runtime_version
   and runs.runtime_fingerprint = target.runtime_fingerprint
  join public.naver_shopping_worker_coordination as control
    on control.lane_key = 'global'
   and control.lease_worker_id = claim.worker_id
   and control.run_id = claim.run_id
   and control.runtime_version = runs.runtime_version
   and control.runtime_fingerprint = runs.runtime_fingerprint
   and control.current_job_kind = 'tracker'
   and control.current_tracker_id = snapshot.tracker_id
   and control.lease_until > clock_timestamp()
   and control.circuit_state <> 'open'
  where snapshot.source = 'naver_shopping_results_collector'
    and snapshot.collection_id ~ '^pw-chrome-'
    and snapshot.checked_count between 1 and 299
    and snapshot.matched = true
    and snapshot.rank between 1 and snapshot.checked_count
    and snapshot.total = snapshot.checked_count
    and snapshot.item ->> 'finiteWindowProofVersion' = 'stable-finite-window-v1'
    and snapshot.item -> 'sourceExhausted' = 'true'::jsonb
    and snapshot.item -> 'finiteMarketTotal' = pg_catalog.to_jsonb(snapshot.checked_count)
    and snapshot.item -> 'atomicSuccessEligible' = 'false'::jsonb
    and snapshot.item ->> 'trackingRankSource' = 'related_catalog'
    and snapshot.item ->> 'relatedCatalogRelationBasis' = 'catalog_seller_product_id'
    and snapshot.item ->> 'relatedCatalogProductId' = target.parent_catalog_id
    and snapshot.item ->> 'catalogId' = target.parent_catalog_id
    and snapshot.item ->> 'rankPolicy' = 'organic_only'
    and snapshot.item -> 'adExcluded' = 'true'::jsonb
    and snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'
    and snapshot.item ->> 'collectionId' = snapshot.collection_id
    and snapshot.item -> 'isOrganic' = 'true'::jsonb
    and snapshot.item -> 'isAd' = 'false'::jsonb
    and claim.priority in ('new', 'resume', 'normal')
    and pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(tracker.keyword)), '\s+', '', 'g'
    ) = target.normalized_keyword
    and pg_catalog.jsonb_typeof(snapshot.item -> 'catalogSellerProductIds') = 'array'
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        snapshot.item -> 'catalogSellerProductIds'
      ) as seller_id(seller_id)
      where seller_id.seller_id = target.seller_product_id
    )
    and pg_catalog.jsonb_typeof(snapshot.top_items) = 'array'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(snapshot.top_items) as top_item
      where top_item -> 'isOrganic' is distinct from 'true'::jsonb
        or top_item -> 'isAd' is distinct from 'false'::jsonb
    )
    and (
      select count(*)
      from public.naver_shopping_scheduler_events as claimed
      where claimed.event_type = 'tracker_claimed'
        and claimed.claim_id = claim.claim_id
    ) = 1
    and not exists (
      select 1
      from public.naver_shopping_scheduler_events as failed
      where failed.event_type = 'job_failed'
        and failed.claim_id = claim.claim_id
    );

  return null;
end;
$$;

revoke all on function public.mi_commit_naver_shopping_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_commit_naver_shopping_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) to service_role;

revoke all on function public.mi_commit_naver_shopping_finite_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mi_commit_naver_shopping_finite_worker_result(
  uuid, timestamptz, text, timestamptz, timestamptz, jsonb, text, text, text
) to service_role;

revoke all on function public.mi_record_naver_shopping_worker_failure(
  text, uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.mi_record_naver_shopping_worker_failure(
  text, uuid, uuid, text, text, uuid
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

revoke all on function mi_internal.mi_audit_naver_shopping_snapshot_commit()
from public, anon, authenticated, service_role;

commit;
