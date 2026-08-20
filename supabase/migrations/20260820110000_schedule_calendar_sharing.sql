begin;

create table if not exists public.schedule_calendars (
  id uuid primary key default gen_random_uuid(),
  owner_principal_key text not null,
  owner_agency_code text,
  created_by_operation_team_id uuid references public.operation_team_codes(id) on delete set null,
  name text not null,
  color text not null default 'navy',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_calendars_owner_principal_length
    check (char_length(btrim(owner_principal_key)) between 3 and 200),
  constraint schedule_calendars_scope_required
    check (nullif(btrim(owner_agency_code), '') is not null or created_by_operation_team_id is not null),
  constraint schedule_calendars_name_length
    check (char_length(btrim(name)) between 1 and 60),
  constraint schedule_calendars_color_allowed
    check (color in ('navy', 'emerald', 'amber', 'rose', 'violet', 'sky', 'slate'))
);

create table if not exists public.schedule_calendar_memberships (
  calendar_id uuid not null references public.schedule_calendars(id) on delete cascade,
  principal_key text not null,
  role text not null default 'viewer',
  display_name text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (calendar_id, principal_key),
  constraint schedule_calendar_memberships_principal_length
    check (char_length(btrim(principal_key)) between 3 and 200),
  constraint schedule_calendar_memberships_role_allowed
    check (role in ('owner', 'editor', 'viewer')),
  constraint schedule_calendar_memberships_display_name_length
    check (display_name is null or char_length(btrim(display_name)) between 1 and 100)
);

create table if not exists public.schedule_calendar_invites (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.schedule_calendars(id) on delete cascade,
  code_digest text not null unique,
  code_hint text not null,
  grant_role text not null default 'editor',
  expires_at timestamptz not null,
  max_uses smallint not null default 1,
  used_count smallint not null default 0,
  revoked_at timestamptz,
  created_by_principal_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_calendar_invites_digest_shape
    check (code_digest ~ '^[0-9a-f]{64}$'),
  constraint schedule_calendar_invites_hint_shape
    check (code_hint ~ '^[A-Za-z0-9_-]{4}$'),
  constraint schedule_calendar_invites_grant_role_allowed
    check (grant_role in ('editor', 'viewer')),
  constraint schedule_calendar_invites_one_use
    check (max_uses = 1 and used_count between 0 and max_uses),
  constraint schedule_calendar_invites_expiry_order
    check (expires_at > created_at),
  constraint schedule_calendar_invites_creator_length
    check (char_length(btrim(created_by_principal_key)) between 3 and 200)
);

create index if not exists idx_schedule_calendar_memberships_principal
on public.schedule_calendar_memberships(principal_key, calendar_id);

create index if not exists idx_schedule_calendar_invites_calendar_active
on public.schedule_calendar_invites(calendar_id, expires_at)
where used_count < max_uses and revoked_at is null;

alter table public.schedule_items
add column if not exists calendar_id uuid references public.schedule_calendars(id) on delete set null;

alter table public.schedule_items
add column if not exists series_id uuid;

alter table public.schedule_items
add column if not exists recurrence_kind text;

alter table public.schedule_items
add column if not exists recurrence_month_day smallint;

alter table public.schedule_items
add column if not exists recurrence_until date;

alter table public.schedule_items
add column if not exists recurrence_timezone text;

alter table public.schedule_items
add column if not exists recurrence_day_policy text;

alter table public.schedule_items
add column if not exists occurrence_on date;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_recurrence_coherent
    check (
      (series_id is null and recurrence_kind is null and recurrence_month_day is null
        and recurrence_until is null and recurrence_timezone is null
        and recurrence_day_policy is null and occurrence_on is null)
      or
      (series_id is not null and recurrence_kind = 'monthly'
        and recurrence_month_day between 1 and 31 and recurrence_until is not null
        and recurrence_timezone = 'Asia/Seoul' and recurrence_day_policy = 'last_day'
        and occurrence_on is not null
        and occurrence_on <= recurrence_until)
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_occurrence_matches_seoul_start
    check (occurrence_on is null or occurrence_on = (starts_at at time zone 'Asia/Seoul')::date);
exception when duplicate_object then null;
end $$;

create index if not exists idx_schedule_items_calendar_start
on public.schedule_items(calendar_id, starts_at);

create unique index if not exists uq_schedule_items_series_occurrence
on public.schedule_items(series_id, occurrence_on)
where series_id is not null;

drop trigger if exists trg_schedule_calendars_updated_at on public.schedule_calendars;
create trigger trg_schedule_calendars_updated_at
before update on public.schedule_calendars
for each row execute function public.set_updated_at();

drop trigger if exists trg_schedule_calendar_memberships_updated_at on public.schedule_calendar_memberships;
create trigger trg_schedule_calendar_memberships_updated_at
before update on public.schedule_calendar_memberships
for each row execute function public.set_updated_at();

drop trigger if exists trg_schedule_calendar_invites_updated_at on public.schedule_calendar_invites;
create trigger trg_schedule_calendar_invites_updated_at
before update on public.schedule_calendar_invites
for each row execute function public.set_updated_at();

alter table public.schedule_calendars enable row level security;
alter table public.schedule_calendars force row level security;
alter table public.schedule_calendar_memberships enable row level security;
alter table public.schedule_calendar_memberships force row level security;
alter table public.schedule_calendar_invites enable row level security;
alter table public.schedule_calendar_invites force row level security;

revoke all on table public.schedule_calendars from public, anon, authenticated, service_role;
revoke all on table public.schedule_calendar_memberships from public, anon, authenticated, service_role;
revoke all on table public.schedule_calendar_invites from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.schedule_calendars to service_role;
grant select, insert, update, delete on table public.schedule_calendar_memberships to service_role;
grant select, insert, update, delete on table public.schedule_calendar_invites to service_role;

revoke all on table public.schedule_items from public, anon, authenticated;

create or replace function public.mi_create_schedule_calendar(
  p_owner_principal_key text,
  p_owner_agency_code text,
  p_operation_team_id uuid,
  p_name text,
  p_color text,
  p_display_name text
)
returns public.schedule_calendars
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_calendar public.schedule_calendars%rowtype;
  v_principal_key text := btrim(coalesce(p_owner_principal_key, ''));
  v_agency_code text := nullif(lower(btrim(coalesce(p_owner_agency_code, ''))), '');
  v_name text := btrim(coalesce(p_name, ''));
  v_color text := lower(btrim(coalesce(p_color, '')));
  v_display_name text := nullif(btrim(coalesce(p_display_name, '')), '');
begin
  if char_length(v_principal_key) not between 3 and 200 then
    raise exception using errcode = '22023', message = 'invalid_calendar_owner';
  end if;
  if v_agency_code is null and p_operation_team_id is null then
    raise exception using errcode = '22023', message = 'invalid_calendar_scope';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception using errcode = '22023', message = 'invalid_calendar_name';
  end if;
  if v_color not in ('navy', 'emerald', 'amber', 'rose', 'violet', 'sky', 'slate') then
    raise exception using errcode = '22023', message = 'invalid_calendar_color';
  end if;
  if v_display_name is not null and char_length(v_display_name) > 100 then
    raise exception using errcode = '22023', message = 'invalid_calendar_display_name';
  end if;

  insert into public.schedule_calendars (
    owner_principal_key,
    owner_agency_code,
    created_by_operation_team_id,
    name,
    color
  ) values (
    v_principal_key,
    v_agency_code,
    p_operation_team_id,
    v_name,
    v_color
  )
  returning * into v_calendar;

  insert into public.schedule_calendar_memberships (
    calendar_id,
    principal_key,
    role,
    display_name
  ) values (
    v_calendar.id,
    v_principal_key,
    'owner',
    v_display_name
  );

  return v_calendar;
end;
$$;

create or replace function public.mi_accept_schedule_calendar_invite(
  p_code_digest text,
  p_principal_key text,
  p_display_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_invite public.schedule_calendar_invites%rowtype;
  v_membership public.schedule_calendar_memberships%rowtype;
  v_was_member boolean := false;
  v_principal_key text := btrim(coalesce(p_principal_key, ''));
  v_display_name text := nullif(btrim(coalesce(p_display_name, '')), '');
begin
  if char_length(v_principal_key) not between 3 and 200
     or (v_display_name is not null and char_length(v_display_name) > 100) then
    raise exception using errcode = '22023', message = 'invalid_calendar_principal';
  end if;

  select invite.*
  into v_invite
  from public.schedule_calendar_invites as invite
  where invite.code_digest = lower(btrim(coalesce(p_code_digest, '')))
    and invite.revoked_at is null
    and invite.used_count < invite.max_uses
    and invite.expires_at > clock_timestamp()
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_or_expired_calendar_invite';
  end if;

  select exists (
    select 1
    from public.schedule_calendar_memberships as current_membership
    where current_membership.calendar_id = v_invite.calendar_id
      and current_membership.principal_key = v_principal_key
      and current_membership.revoked_at is null
  ) into v_was_member;

  insert into public.schedule_calendar_memberships as membership (
    calendar_id,
    principal_key,
    role,
    display_name
  ) values (
    v_invite.calendar_id,
    v_principal_key,
    v_invite.grant_role,
    v_display_name
  )
  on conflict (calendar_id, principal_key) do update
  set role = case
        when membership.revoked_at is null and membership.role = 'owner' then 'owner'
        when membership.revoked_at is null and (membership.role = 'editor' or excluded.role = 'editor') then 'editor'
        else 'viewer'
      end,
      display_name = coalesce(excluded.display_name, membership.display_name),
      revoked_at = null,
      updated_at = now()
  returning * into v_membership;

  update public.schedule_calendar_invites
  set used_count = used_count + 1,
      updated_at = statement_timestamp()
  where id = v_invite.id;

  return jsonb_build_object(
    'status', case when v_was_member then 'already_member' else 'joined' end,
    'calendarId', v_membership.calendar_id
  );
end;
$$;

create or replace function public.mi_insert_shared_schedule_items(
  p_calendar_id uuid,
  p_principal_key text,
  p_rows jsonb
)
returns setof public.schedule_items
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_calendar public.schedule_calendars%rowtype;
begin
  select calendar.*
  into v_calendar
  from public.schedule_calendar_memberships as membership
  join public.schedule_calendars as calendar on calendar.id = membership.calendar_id
  where membership.calendar_id = p_calendar_id
    and membership.principal_key = btrim(coalesce(p_principal_key, ''))
    and membership.revoked_at is null
    and membership.role in ('owner', 'editor')
    and calendar.archived_at is null
  for update of membership, calendar;

  if not found then
    raise exception using errcode = '42501', message = 'calendar_edit_forbidden';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 60 then
    raise exception using errcode = '22023', message = 'invalid_shared_schedule_rows';
  end if;

  return query
  insert into public.schedule_items (
    client_id,
    operation_team_id,
    owner_agency_code,
    title,
    schedule_type,
    status,
    priority,
    starts_at,
    ends_at,
    assignee_name,
    internal_note,
    public_title,
    public_comment,
    visibility,
    is_all_day,
    calendar_id,
    series_id,
    occurrence_on,
    recurrence_kind,
    recurrence_until,
    recurrence_month_day,
    recurrence_timezone,
    recurrence_day_policy
  )
  select
    null,
    null,
    v_calendar.owner_agency_code,
    row.title,
    row.schedule_type,
    row.status,
    row.priority,
    row.starts_at,
    row.ends_at,
    row.assignee_name,
    row.internal_note,
    null,
    null,
    'internal',
    coalesce(row.is_all_day, false),
    p_calendar_id,
    row.series_id,
    row.occurrence_on,
    row.recurrence_kind,
    row.recurrence_until,
    row.recurrence_month_day,
    row.recurrence_timezone,
    row.recurrence_day_policy
  from jsonb_to_recordset(p_rows) as row (
    title text,
    schedule_type public.schedule_type,
    status public.schedule_status,
    priority public.priority_level,
    starts_at timestamptz,
    ends_at timestamptz,
    assignee_name text,
    internal_note text,
    is_all_day boolean,
    series_id uuid,
    occurrence_on date,
    recurrence_kind text,
    recurrence_until date,
    recurrence_month_day smallint,
    recurrence_timezone text,
    recurrence_day_policy text
  )
  returning *;
end;
$$;

create or replace function public.mi_update_shared_schedule_item(
  p_calendar_id uuid,
  p_principal_key text,
  p_item_id uuid,
  p_expected_updated_at timestamptz,
  p_payload jsonb
)
returns setof public.schedule_items
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_calendar public.schedule_calendars%rowtype;
begin
  select calendar.*
  into v_calendar
  from public.schedule_calendar_memberships as membership
  join public.schedule_calendars as calendar on calendar.id = membership.calendar_id
  where membership.calendar_id = p_calendar_id
    and membership.principal_key = btrim(coalesce(p_principal_key, ''))
    and membership.revoked_at is null
    and membership.role in ('owner', 'editor')
    and calendar.archived_at is null
  for update of membership, calendar;

  if not found then
    raise exception using errcode = '42501', message = 'calendar_edit_forbidden';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_payload) as key(value)
       where key.value not in (
         'title', 'schedule_type', 'status', 'priority', 'starts_at', 'ends_at',
         'assignee_name', 'internal_note', 'is_all_day', 'occurrence_on'
       )
     ) then
    raise exception using errcode = '22023', message = 'invalid_shared_schedule_payload';
  end if;

  return query
  update public.schedule_items as item
  set title = btrim(coalesce(p_payload ->> 'title', '')),
      schedule_type = (p_payload ->> 'schedule_type')::public.schedule_type,
      status = (p_payload ->> 'status')::public.schedule_status,
      priority = (p_payload ->> 'priority')::public.priority_level,
      starts_at = (p_payload ->> 'starts_at')::timestamptz,
      ends_at = nullif(p_payload ->> 'ends_at', '')::timestamptz,
      assignee_name = nullif(btrim(coalesce(p_payload ->> 'assignee_name', '')), ''),
      internal_note = nullif(btrim(coalesce(p_payload ->> 'internal_note', '')), ''),
      public_title = null,
      public_comment = null,
      visibility = 'internal',
      is_all_day = coalesce((p_payload ->> 'is_all_day')::boolean, false),
      occurrence_on = case
        when item.series_id is null then null
        else nullif(p_payload ->> 'occurrence_on', '')::date
      end
  where item.id = p_item_id
    and item.calendar_id = p_calendar_id
    and item.updated_at = p_expected_updated_at
  returning item.*;
end;
$$;

create or replace function public.mi_delete_shared_schedule_item(
  p_calendar_id uuid,
  p_principal_key text,
  p_item_id uuid,
  p_expected_updated_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_calendar public.schedule_calendars%rowtype;
  v_item_id uuid;
begin
  select calendar.*
  into v_calendar
  from public.schedule_calendar_memberships as membership
  join public.schedule_calendars as calendar on calendar.id = membership.calendar_id
  where membership.calendar_id = p_calendar_id
    and membership.principal_key = btrim(coalesce(p_principal_key, ''))
    and membership.revoked_at is null
    and membership.role in ('owner', 'editor')
    and calendar.archived_at is null
  for update of membership, calendar;

  if not found then
    raise exception using errcode = '42501', message = 'calendar_edit_forbidden';
  end if;

  delete from public.schedule_items as item
  where item.id = p_item_id
    and item.calendar_id = p_calendar_id
    and item.updated_at = p_expected_updated_at
  returning item.id into v_item_id;

  return v_item_id;
end;
$$;

revoke execute on function public.mi_create_schedule_calendar(text, text, uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.mi_create_schedule_calendar(text, text, uuid, text, text, text)
to service_role;

revoke execute on function public.mi_accept_schedule_calendar_invite(text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.mi_accept_schedule_calendar_invite(text, text, text)
to service_role;

revoke execute on function public.mi_insert_shared_schedule_items(uuid, text, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.mi_insert_shared_schedule_items(uuid, text, jsonb)
to service_role;

revoke execute on function public.mi_update_shared_schedule_item(uuid, text, uuid, timestamptz, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.mi_update_shared_schedule_item(uuid, text, uuid, timestamptz, jsonb)
to service_role;

revoke execute on function public.mi_delete_shared_schedule_item(uuid, text, uuid, timestamptz)
from public, anon, authenticated, service_role;
grant execute on function public.mi_delete_shared_schedule_item(uuid, text, uuid, timestamptz)
to service_role;

comment on column public.schedule_items.calendar_id is
  'NULL은 기존 개인 일정이다. 기존 행을 추론하거나 자동 공유 캘린더로 이전하지 않는다.';
comment on column public.schedule_items.occurrence_on is
  '월간 반복 시리즈의 Asia/Seoul 기준 발생일. series_id와 함께 재시도 중복을 막는다.';
comment on column public.schedule_calendar_invites.code_digest is
  '128-bit base64url 원문은 저장하지 않고 SHA-256 digest만 저장한다.';

commit;
