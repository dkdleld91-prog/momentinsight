-- Manual Supabase engine test.  The runner replaces public/mi_internal in the
-- migration with these shadow schemas, inserts it at the marker, and executes
-- the whole script in one rolled-back transaction.  Production rows are read
-- only to copy a representative same-keyword pair.
begin;
drop schema if exists ledger_test cascade;
drop schema if exists ledger_test_internal cascade;
create schema ledger_test authorization postgres;
grant usage on schema ledger_test to anon, authenticated, service_role;

create table ledger_test.naver_rank_trackers
  (like public.naver_rank_trackers including all);
create table ledger_test.naver_rank_snapshots
  (like public.naver_rank_snapshots including all);
create table ledger_test.naver_shopping_worker_coordination
  (like public.naver_shopping_worker_coordination including all);

insert into ledger_test.naver_shopping_worker_coordination
select * from public.naver_shopping_worker_coordination where lane_key = 'global';

with selected_key as (
  select lower(regexp_replace(keyword, '\s+', '', 'g')) as keyword_key
  from public.naver_rank_trackers
  where status::text = 'active'
  group by 1
  having count(*) >= 2
  order by count(*) desc, 1
  limit 1
)
insert into ledger_test.naver_rank_trackers
select tracker.*
from public.naver_rank_trackers as tracker, selected_key
where tracker.status::text = 'active'
  and lower(regexp_replace(tracker.keyword, '\s+', '', 'g')) = selected_key.keyword_key
order by tracker.id
limit 2;

-- @ledger-migration

grant select, insert, update on
  ledger_test.naver_rank_trackers,
  ledger_test.naver_rank_snapshots,
  ledger_test.naver_shopping_worker_coordination
to authenticated, service_role;

set local role authenticated;
update ledger_test.naver_rank_trackers set group_name = group_name;
update ledger_test.naver_rank_trackers
set last_error = 'provider_row_invalid:1:1',
    worker_quarantined_until = clock_timestamp() + interval '30 minutes'
where id = (select id from ledger_test.naver_rank_trackers order by id limit 1);
update ledger_test.naver_rank_trackers
set worker_quarantined_until = null
where id = (select id from ledger_test.naver_rank_trackers order by id limit 1);
reset role;

set local role service_role;
update ledger_test.naver_shopping_worker_coordination
set scheduler_cycle_status = 'completed',
    scheduler_cycle_completed_at = clock_timestamp()
where lane_key = 'global';
update ledger_test.naver_shopping_worker_coordination
set scheduler_cycle_id = gen_random_uuid(),
    scheduler_cycle_number = scheduler_cycle_number + 1000,
    scheduler_cycle_status = 'active',
    scheduler_cycle_started_at = clock_timestamp(),
    scheduler_cycle_completed_at = null,
    scheduler_cycle_cursor_sort_order = null,
    scheduler_cycle_cursor_created_at = null,
    scheduler_cycle_cursor_tracker_id = null,
    scheduler_cycle_resume_cursor = false,
    circuit_state = 'closed',
    lease_worker_id = 'windows-desktop-primary',
    lease_token = gen_random_uuid(),
    lease_until = clock_timestamp() + interval '1 hour',
    run_id = gen_random_uuid()
where lane_key = 'global';

update ledger_test.naver_rank_trackers
set processing_started_at = date_trunc('milliseconds', clock_timestamp()),
    processing_until = clock_timestamp() + interval '35 minutes',
    worker_last_cycle_id = (
      select scheduler_cycle_id
      from ledger_test.naver_shopping_worker_coordination
      where lane_key = 'global'
    ),
    worker_last_cycle_claimed_at = date_trunc('milliseconds', clock_timestamp()),
    last_error = null;

insert into ledger_test.naver_rank_snapshots(
  tracker_id, checked_at, rank, matched, checked_count, total,
  item, top_items, source, collection_id
)
select id, clock_timestamp(), 7, true, 300, 300,
  '{"rankEvidence":"naver_shopping_organic_list","adExcluded":true}'::jsonb,
  '[]'::jsonb, 'naver_shopping_results_collector',
  'pw-chrome-ledger-shadow-0001'
from ledger_test.naver_rank_trackers order by id limit 1;

update ledger_test.naver_rank_trackers
set processing_started_at = null,
    processing_until = null,
    last_error = case
      when id = (
        select id from ledger_test.naver_rank_trackers order by id desc limit 1
      ) then 'provider_row_identity_missing:2:3'
      else null
    end;

-- A second same-cycle claim is deliberately recorded instead of blocking the
-- scheduler.  The final audit detects it as an invariant violation.
update ledger_test.naver_rank_trackers
set processing_started_at = date_trunc('milliseconds', clock_timestamp()),
    processing_until = clock_timestamp() + interval '35 minutes',
    worker_last_cycle_claimed_at =
      date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond',
    last_error = null;

insert into ledger_test.naver_rank_trackers
select (
  jsonb_populate_record(
    null::ledger_test.naver_rank_trackers,
    to_jsonb(seed) || jsonb_build_object(
      'id', gen_random_uuid(),
      'keyword', 'ledger-new-keyword',
      'created_at', clock_timestamp(),
      'updated_at', clock_timestamp(),
      'last_checked_at', null,
      'current_rank', null,
      'processing_started_at', null,
      'processing_until', null,
      'worker_last_cycle_id', null,
      'worker_last_cycle_claimed_at', null,
      'worker_quarantined_until', null,
      'last_error', null,
      'retry_count', 0,
      'sort_order', 9999
    )
  )
).*
from ledger_test.naver_rank_trackers as seed
order by seed.id
limit 1;

update ledger_test.naver_rank_trackers
set processing_started_at =
      date_trunc('milliseconds', clock_timestamp()) + interval '2 milliseconds',
    processing_until = clock_timestamp() + interval '35 minutes',
    worker_last_cycle_id = (
      select scheduler_cycle_id
      from ledger_test.naver_shopping_worker_coordination
      where lane_key = 'global'
    ),
    worker_last_cycle_claimed_at =
      date_trunc('milliseconds', clock_timestamp()) + interval '2 milliseconds',
    last_error = null
where keyword = 'ledger-new-keyword';
reset role;

do $assertions$
declare
  v_cycle_id uuid;
  event_count integer;
  first_group text;
begin
  select scheduler_cycle_id into v_cycle_id
  from ledger_test.naver_shopping_worker_coordination
  where lane_key = 'global';

  select count(*) into event_count
  from ledger_test.naver_shopping_scheduler_events
  where event_type = 'cycle_started' and naver_shopping_scheduler_events.cycle_id = v_cycle_id;
  if event_count <> 1 then raise exception 'shadow_cycle_started_%', event_count; end if;

  select count(*) into event_count
  from ledger_test.naver_shopping_scheduler_events
  where event_type = 'cycle_rostered' and naver_shopping_scheduler_events.cycle_id = v_cycle_id;
  if event_count <> 3 then raise exception 'shadow_roster_%', event_count; end if;

  select count(*) into event_count
  from ledger_test.naver_shopping_scheduler_events
  where event_type = 'cycle_rostered'
    and naver_shopping_scheduler_events.cycle_id = v_cycle_id
    and roster_state = 'new_after_start';
  if event_count <> 1 then raise exception 'shadow_new_roster_%', event_count; end if;

  select group_fingerprint into first_group
  from ledger_test.naver_shopping_scheduler_events
  where event_type = 'group_claimed' and naver_shopping_scheduler_events.cycle_id = v_cycle_id
  order by event_id limit 1;
  select count(*) into event_count
  from ledger_test.naver_shopping_scheduler_events
  where event_type = 'group_claimed'
    and naver_shopping_scheduler_events.cycle_id = v_cycle_id
    and group_fingerprint = first_group;
  if event_count <> 2 then raise exception 'shadow_repeat_group_%', event_count; end if;

  select count(*) into event_count
  from ledger_test.naver_shopping_scheduler_events
  where event_type = 'tracker_committed' and checked_count = 300;
  if event_count <> 1 then raise exception 'shadow_commit_%', event_count; end if;

  select count(*) into event_count
  from ledger_test.naver_shopping_scheduler_events
  where event_type = 'job_failed' and error_code like 'provider_row_identity_missing%';
  if event_count <> 1 then raise exception 'shadow_failure_%', event_count; end if;

  select count(*) into event_count
  from ledger_test.naver_shopping_scheduler_events
  where event_type in ('quarantine_set', 'quarantine_cleared');
  if event_count <> 2 then raise exception 'shadow_quarantine_%', event_count; end if;

  if has_function_privilege(
    'service_role',
    'ledger_test_internal.mi_audit_naver_shopping_cycle_transition()',
    'execute'
  ) then raise exception 'shadow_trigger_execute_exposed'; end if;
end
$assertions$;

set local role service_role;
do $service_role_denial$
begin
  begin
    insert into ledger_test.naver_shopping_scheduler_events(event_type)
    values ('ledger_enabled');
    raise exception 'shadow_service_role_insert_allowed';
  exception when insufficient_privilege then null;
  end;
end
$service_role_denial$;
reset role;

set local role anon;
do $anon_denial$
begin
  begin
    perform count(*) from ledger_test.naver_shopping_scheduler_events;
    raise exception 'shadow_anon_select_allowed';
  exception when insufficient_privilege then null;
  end;
end
$anon_denial$;
reset role;

rollback;
