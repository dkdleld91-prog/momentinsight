begin;

create schema if not exists mi_internal authorization postgres;
revoke all on schema mi_internal from public, anon, authenticated, service_role;

-- Immutable operational evidence for the durable N Shopping scheduler.  This
-- table intentionally contains no raw keyword, product URL/title, browser
-- profile, signature, nonce or lane token.  Tracker and agency identifiers are
-- opaque operational identifiers and keyword grouping is represented only by
-- a cycle-scoped SHA-256 fingerprint.
create table if not exists public.naver_shopping_scheduler_events (
  event_id bigint generated always as identity primary key,
  occurred_at timestamptz not null default date_trunc('milliseconds', clock_timestamp()),
  retention_until timestamptz not null default (clock_timestamp() + interval '90 days'),
  event_type text not null check (event_type in (
    'ledger_enabled',
    'cycle_started',
    'cycle_rostered',
    'group_claimed',
    'tracker_claimed',
    'tracker_committed',
    'job_failed',
    'quarantine_set',
    'quarantine_cleared',
    'quarantine_repair_override',
    'cycle_completed'
  )),
  cycle_id uuid,
  cycle_number bigint,
  claim_id uuid,
  run_id uuid,
  worker_id text check (
    worker_id is null or worker_id ~ '^[a-z0-9][a-z0-9:_-]{2,63}$'
  ),
  tracker_id uuid,
  agency_code text check (
    agency_code is null or char_length(agency_code) between 1 and 80
  ),
  group_fingerprint text check (
    group_fingerprint is null or group_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  priority text check (
    priority is null or priority in ('new', 'resume', 'normal', 'probe', 'repair')
  ),
  roster_state text check (
    roster_state is null or roster_state in (
      'eligible',
      'quarantined',
      'new_after_start',
      'late_observed'
    )
  ),
  lease_started_at timestamptz,
  lease_until timestamptz,
  collection_id text check (
    collection_id is null or char_length(collection_id) between 8 and 160
  ),
  checked_count smallint check (
    checked_count is null or checked_count between 0 and 300
  ),
  excluded_ad_count integer check (
    excluded_ad_count is null or excluded_ad_count >= 0
  ),
  duration_ms integer check (
    duration_ms is null or duration_ms between 0 and 3600000
  ),
  error_code text check (
    error_code is null or error_code ~ '^[a-z0-9_:-]{3,80}$'
  ),
  quarantine_until timestamptz,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  check (retention_until > occurred_at),
  check (
    event_type not in ('cycle_started', 'cycle_rostered', 'cycle_completed')
    or cycle_id is not null
  ),
  check (
    event_type not in ('cycle_rostered', 'tracker_claimed', 'tracker_committed')
    or tracker_id is not null
  ),
  check (
    event_type not in ('group_claimed', 'tracker_claimed')
    or (claim_id is not null and group_fingerprint is not null and priority is not null)
  ),
  check (
    event_type <> 'tracker_committed'
    or (collection_id is not null and checked_count = 300)
  ),
  check (
    event_type <> 'quarantine_set'
    or (tracker_id is not null and quarantine_until is not null and error_code is not null)
  )
);

comment on table public.naver_shopping_scheduler_events is
  'Service-role-only append-only N Shopping scheduler evidence; detailed retention target is 90 days.';

create unique index if not exists idx_naver_shopping_scheduler_events_cycle_started_once
on public.naver_shopping_scheduler_events(cycle_id)
where event_type = 'cycle_started';

create unique index if not exists idx_naver_shopping_scheduler_events_cycle_completed_once
on public.naver_shopping_scheduler_events(cycle_id)
where event_type = 'cycle_completed';

create unique index if not exists idx_naver_shopping_scheduler_events_cycle_roster_once
on public.naver_shopping_scheduler_events(cycle_id, tracker_id)
where event_type = 'cycle_rostered';

create index if not exists idx_naver_shopping_scheduler_events_scheduled_group_sequence
on public.naver_shopping_scheduler_events(cycle_id, group_fingerprint)
where event_type = 'group_claimed'
  and priority in ('new', 'resume', 'normal');

create index if not exists idx_naver_shopping_scheduler_events_scheduled_tracker_sequence
on public.naver_shopping_scheduler_events(cycle_id, tracker_id)
where event_type = 'tracker_claimed'
  and priority in ('new', 'resume', 'normal');

create unique index if not exists idx_naver_shopping_scheduler_events_claim_group_once
on public.naver_shopping_scheduler_events(claim_id)
where event_type = 'group_claimed';

create unique index if not exists idx_naver_shopping_scheduler_events_claim_tracker_once
on public.naver_shopping_scheduler_events(claim_id, tracker_id)
where event_type = 'tracker_claimed';

create index if not exists idx_naver_shopping_scheduler_events_terminal_sequence
on public.naver_shopping_scheduler_events(claim_id, tracker_id)
where event_type in ('tracker_committed', 'job_failed')
  and claim_id is not null;

create unique index if not exists idx_naver_shopping_scheduler_events_collection_once
on public.naver_shopping_scheduler_events(tracker_id, collection_id)
where event_type = 'tracker_committed';

create index if not exists idx_naver_shopping_scheduler_events_cycle_sequence
on public.naver_shopping_scheduler_events(cycle_id, event_id);

create index if not exists idx_naver_shopping_scheduler_events_agency_time
on public.naver_shopping_scheduler_events(agency_code, occurred_at desc)
where agency_code is not null;

create index if not exists idx_naver_shopping_scheduler_events_retention
on public.naver_shopping_scheduler_events(retention_until);

alter table public.naver_shopping_scheduler_events enable row level security;
alter table public.naver_shopping_scheduler_events force row level security;

revoke all on table public.naver_shopping_scheduler_events
from public, anon, authenticated, service_role;
grant select on table public.naver_shopping_scheduler_events
to service_role;

revoke all on sequence public.naver_shopping_scheduler_events_event_id_seq
from public, anon, authenticated, service_role;

-- pgcrypto can live in either public or extensions depending on when the
-- Supabase project was created.  Resolve its installed schema once and bake an
-- explicitly-qualified digest call into the immutable helper.
do $ledger$
declare
  digest_schema text;
begin
  select pg_catalog.quote_ident(namespace.nspname)
  into digest_schema
  from pg_catalog.pg_extension as extension
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  if digest_schema is null then
    raise exception 'naver_shopping_scheduler_pgcrypto_missing';
  end if;

  execute pg_catalog.format($create_function$
    create or replace function mi_internal.mi_naver_shopping_scheduler_group_fingerprint(
      p_scope_id uuid,
      p_keyword text
    ) returns text
    language sql
    immutable
    strict
    security invoker
    set search_path = ''
    as $function$
      select pg_catalog.encode(
        %s.digest(
          pg_catalog.convert_to(
            p_scope_id::text || ':' ||
            pg_catalog.regexp_replace(
              pg_catalog.lower(pg_catalog.btrim(p_keyword)),
              '\s+',
              '',
              'g'
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
    $function$;
  $create_function$, digest_schema);
end
$ledger$;

revoke all on function mi_internal.mi_naver_shopping_scheduler_group_fingerprint(uuid, text)
from public, anon, authenticated, service_role;

create or replace function mi_internal.mi_audit_naver_shopping_cycle_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_active integer := 0;
  v_eligible integer := 0;
  v_quarantined integer := 0;
  v_claimed integer := 0;
  v_scheduled integer := 0;
  v_repair integer := 0;
  v_committed integer := 0;
  v_failed integer := 0;
begin
  if new.scheduler_cycle_status = 'active'
    and new.scheduler_cycle_id is not null
    and (
      old.scheduler_cycle_id is distinct from new.scheduler_cycle_id
      or old.scheduler_cycle_status is distinct from 'active'
    ) then
    -- The ledger is immutable during its evidence window.  Expired detail is
    -- pruned only when a new cycle starts, under this non-callable trigger
    -- function's owner privileges.
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
      jsonb_build_object(
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
      jsonb_build_object(
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
      count(*) filter (where event.event_type = 'job_failed')::integer
    into v_claimed, v_scheduled, v_repair, v_committed, v_failed
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
      jsonb_build_object(
        'distinctClaimedTrackers', v_claimed,
        'scheduledClaimedTrackers', v_scheduled,
        'repairClaimedTrackers', v_repair,
        'committedTrackers', v_committed,
        'failedTrackers', v_failed
      )
    );
  end if;

  return new;
end;
$$;

revoke all on function mi_internal.mi_audit_naver_shopping_cycle_transition()
from public, anon, authenticated, service_role;

drop trigger if exists trg_mi_audit_naver_shopping_cycle_transition
on public.naver_shopping_worker_coordination;
create trigger trg_mi_audit_naver_shopping_cycle_transition
after update on public.naver_shopping_worker_coordination
for each row execute function mi_internal.mi_audit_naver_shopping_cycle_transition();

create or replace function mi_internal.mi_audit_naver_shopping_tracker_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  claimed_group record;
  v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_cycle_id uuid;
  v_cycle_number bigint;
  v_claim_id uuid;
  v_scope_id uuid;
  v_fingerprint text;
  v_priority text;
begin
  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global';

  if found and current_row.lease_until > v_now and current_row.circuit_state <> 'open' then
    for claimed_group in
      select
        pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(new_row.keyword)),
          '\s+',
          '',
          'g'
        ) as keyword_key,
        min(new_row.keyword) as keyword_sample,
        min(new_row.processing_started_at) as lease_started_at,
        max(new_row.processing_until) as lease_until,
        bool_or(
          new_row.last_message = '오류 보완 후 1회 우선 재검증 중입니다.'
        ) as is_repair,
        bool_or(
          new_row.worker_last_cycle_claimed_at
            is distinct from old_row.worker_last_cycle_claimed_at
        ) as marks_cycle,
        bool_or(old_row.last_checked_at is null) as contains_new,
        count(*)::integer as member_count
      from new_rows as new_row
      join old_rows as old_row on old_row.id = new_row.id
      where new_row.processing_started_at is not null
        and new_row.processing_started_at is distinct from old_row.processing_started_at
        and (
          new_row.worker_last_cycle_claimed_at
            is distinct from old_row.worker_last_cycle_claimed_at
          or new_row.last_message = '오류 보완 후 1회 우선 재검증 중입니다.'
          or (
            current_row.circuit_state = 'half_open'
            and current_row.probe_tracker_id = new_row.id
          )
        )
      group by pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.btrim(new_row.keyword)),
        '\s+',
        '',
        'g'
      )
    loop
      if claimed_group.is_repair then
        v_priority := 'repair';
      elsif not claimed_group.marks_cycle then
        v_priority := 'probe';
      elsif current_row.scheduler_cycle_resume_cursor then
        v_priority := 'resume';
      elsif claimed_group.contains_new then
        v_priority := 'new';
      else
        v_priority := 'normal';
      end if;

      v_cycle_id := case
        when v_priority = 'probe' then null
        when current_row.scheduler_cycle_status = 'active'
          then current_row.scheduler_cycle_id
        else null
      end;
      v_cycle_number := case
        when v_cycle_id is not null then current_row.scheduler_cycle_number
        else null
      end;
      v_claim_id := gen_random_uuid();
      v_scope_id := coalesce(v_cycle_id, current_row.run_id, v_claim_id);
      v_fingerprint := mi_internal.mi_naver_shopping_scheduler_group_fingerprint(
        v_scope_id,
        claimed_group.keyword_sample
      );

      -- The cycle-start roster is the authoritative denominator.  A tracker
      -- registered after that snapshot is appended exactly when its priority
      -- claim occurs.  Applying the ledger during an already-active cycle is
      -- marked late_observed and excluded from full-cycle certification.
      if v_cycle_id is not null then
        insert into public.naver_shopping_scheduler_events(
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
          'cycle_rostered',
          v_cycle_id,
          v_cycle_number,
          new_row.id,
          new_row.agency_code,
          v_fingerprint,
          case
            when current_row.scheduler_cycle_started_at is not null
              and new_row.created_at > current_row.scheduler_cycle_started_at
              then 'new_after_start'
            else 'late_observed'
          end,
          new_row.worker_quarantined_until,
          jsonb_build_object(
            'sortOrder', new_row.sort_order,
            'registeredAt', new_row.created_at,
            'neverChecked', new_row.last_checked_at is null
          )
        from new_rows as new_row
        where new_row.processing_started_at is not null
          and pg_catalog.regexp_replace(
            pg_catalog.lower(pg_catalog.btrim(new_row.keyword)),
            '\s+',
            '',
            'g'
          ) = claimed_group.keyword_key
        on conflict do nothing;
      end if;

      insert into public.naver_shopping_scheduler_events(
        event_type,
        cycle_id,
        cycle_number,
        claim_id,
        run_id,
        worker_id,
        group_fingerprint,
        priority,
        lease_started_at,
        lease_until,
        details
      ) values (
        'group_claimed',
        v_cycle_id,
        v_cycle_number,
        v_claim_id,
        current_row.run_id,
        current_row.lease_worker_id,
        v_fingerprint,
        v_priority,
        claimed_group.lease_started_at,
        claimed_group.lease_until,
        jsonb_build_object(
          'memberCount', claimed_group.member_count,
          'resumeCursorBefore', current_row.scheduler_cycle_resume_cursor,
          'cursorSortOrderBefore', current_row.scheduler_cycle_cursor_sort_order,
          'cursorTrackerBefore', current_row.scheduler_cycle_cursor_tracker_id
        )
      );

      insert into public.naver_shopping_scheduler_events(
        event_type,
        cycle_id,
        cycle_number,
        claim_id,
        run_id,
        worker_id,
        tracker_id,
        agency_code,
        group_fingerprint,
        priority,
        lease_started_at,
        lease_until,
        details
      )
      select
        'tracker_claimed',
        v_cycle_id,
        v_cycle_number,
        v_claim_id,
        current_row.run_id,
        current_row.lease_worker_id,
        new_row.id,
        new_row.agency_code,
        v_fingerprint,
        v_priority,
        new_row.processing_started_at,
        new_row.processing_until,
        jsonb_build_object(
          'sortOrder', new_row.sort_order,
          'registeredAfterCycleStart',
            current_row.scheduler_cycle_started_at is not null
            and new_row.created_at > current_row.scheduler_cycle_started_at
        )
      from new_rows as new_row
      join old_rows as old_row on old_row.id = new_row.id
      where new_row.processing_started_at is not null
        and new_row.processing_started_at is distinct from old_row.processing_started_at
        and (
          new_row.worker_last_cycle_claimed_at
            is distinct from old_row.worker_last_cycle_claimed_at
          or new_row.last_message = '오류 보완 후 1회 우선 재검증 중입니다.'
          or (
            current_row.circuit_state = 'half_open'
            and current_row.probe_tracker_id = new_row.id
          )
        )
        and pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.btrim(new_row.keyword)),
          '\s+',
          '',
          'g'
        ) = claimed_group.keyword_key;
    end loop;
  end if;

  -- A terminal failure is written by the same transaction that clears the
  -- matching tracker lease.  Retried fail RPCs update no row and therefore
  -- cannot create a second event.
  insert into public.naver_shopping_scheduler_events(
    event_type,
    cycle_id,
    cycle_number,
    claim_id,
    run_id,
    worker_id,
    tracker_id,
    agency_code,
    group_fingerprint,
    priority,
    lease_started_at,
    lease_until,
    error_code,
    details
  )
  select
    'job_failed',
    claim.cycle_id,
    claim.cycle_number,
    claim.claim_id,
    claim.run_id,
    claim.worker_id,
    new_row.id,
    new_row.agency_code,
    claim.group_fingerprint,
    claim.priority,
    old_row.processing_started_at,
    old_row.processing_until,
    case
      when pg_catalog.lower(pg_catalog.btrim(new_row.last_error))
        ~ '^[a-z0-9_:-]{3,80}$'
        then pg_catalog.lower(pg_catalog.btrim(new_row.last_error))
      else 'local_worker_collection_failed'
    end,
    jsonb_build_object('retryCount', new_row.retry_count)
  from new_rows as new_row
  join old_rows as old_row on old_row.id = new_row.id
  join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.tracker_id = new_row.id
      and event.lease_started_at = old_row.processing_started_at
    order by event.event_id desc
    limit 1
  ) as claim on true
  where old_row.processing_started_at is not null
    and new_row.processing_started_at is null
    and new_row.last_error is not null;

  -- Quarantine evidence is independent from the mutable tracker state.  A
  -- repair override is distinguished from ordinary expiry/success clearing.
  insert into public.naver_shopping_scheduler_events(
    event_type,
    cycle_id,
    cycle_number,
    claim_id,
    run_id,
    worker_id,
    tracker_id,
    agency_code,
    group_fingerprint,
    priority,
    error_code,
    quarantine_until,
    details
  )
  select
    case
      when new_row.worker_quarantined_until is not null then 'quarantine_set'
      when new_row.last_message = '오류 보완 후 1회 우선 재검증 중입니다.'
        then 'quarantine_repair_override'
      else 'quarantine_cleared'
    end,
    claim.cycle_id,
    claim.cycle_number,
    claim.claim_id,
    claim.run_id,
    claim.worker_id,
    new_row.id,
    new_row.agency_code,
    claim.group_fingerprint,
    claim.priority,
    case
      when new_row.worker_quarantined_until is not null
        and pg_catalog.lower(pg_catalog.btrim(new_row.last_error))
          ~ '^[a-z0-9_:-]{3,80}$'
        then pg_catalog.lower(pg_catalog.btrim(new_row.last_error))
      when new_row.worker_quarantined_until is not null
        then 'local_worker_collection_failed'
      else null
    end,
    new_row.worker_quarantined_until,
    jsonb_build_object('previousUntil', old_row.worker_quarantined_until)
  from new_rows as new_row
  join old_rows as old_row on old_row.id = new_row.id
  left join lateral (
    select event.*
    from public.naver_shopping_scheduler_events as event
    where event.event_type = 'tracker_claimed'
      and event.tracker_id = new_row.id
    order by event.event_id desc
    limit 1
  ) as claim on true
  where new_row.worker_quarantined_until
      is distinct from old_row.worker_quarantined_until
    and (
      new_row.worker_quarantined_until is not null
      or old_row.worker_quarantined_until is not null
    );

  return null;
end;
$$;

revoke all on function mi_internal.mi_audit_naver_shopping_tracker_transition()
from public, anon, authenticated, service_role;

drop trigger if exists trg_mi_audit_naver_shopping_tracker_transition
on public.naver_rank_trackers;
create trigger trg_mi_audit_naver_shopping_tracker_transition
after update on public.naver_rank_trackers
referencing old table as old_rows new table as new_rows
for each statement execute function mi_internal.mi_audit_naver_shopping_tracker_transition();

create or replace function mi_internal.mi_audit_naver_shopping_snapshot_commit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.naver_shopping_scheduler_events(
    occurred_at,
    event_type,
    cycle_id,
    cycle_number,
    claim_id,
    run_id,
    worker_id,
    tracker_id,
    agency_code,
    group_fingerprint,
    priority,
    lease_started_at,
    lease_until,
    collection_id,
    checked_count,
    details
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
    jsonb_build_object(
      'matched', snapshot.matched,
      'rank', snapshot.rank,
      'source', snapshot.source
    )
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

  return null;
end;
$$;

revoke all on function mi_internal.mi_audit_naver_shopping_snapshot_commit()
from public, anon, authenticated, service_role;

drop trigger if exists trg_mi_audit_naver_shopping_snapshot_commit
on public.naver_rank_snapshots;
create trigger trg_mi_audit_naver_shopping_snapshot_commit
after insert on public.naver_rank_snapshots
referencing new table as new_snapshots
for each statement execute function mi_internal.mi_audit_naver_shopping_snapshot_commit();

insert into public.naver_shopping_scheduler_events(
  event_type,
  details
) values (
  'ledger_enabled',
  jsonb_build_object(
    'schemaVersion', 1,
    'fullCycleEvidenceStartsWithNextCycle', true
  )
);

commit;
