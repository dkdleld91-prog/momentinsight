begin;

alter table public.schedule_items
alter column client_id drop not null;

alter table public.schedule_items
add column if not exists operation_team_id uuid references public.operation_team_codes(id) on delete set null;

alter table public.schedule_items
add column if not exists owner_agency_code text not null default 'mml93-a01';

alter table public.schedule_items
add column if not exists assignee_name text;

alter table public.schedule_items
add column if not exists priority public.priority_level not null default 'medium';

alter table public.schedule_items
add column if not exists public_title text;

alter table public.schedule_items
add column if not exists is_all_day boolean not null default false;

alter table public.schedule_items
alter column visibility set default 'internal';

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_scope_required
    check (
      nullif(btrim(owner_agency_code), '') is not null
      or operation_team_id is not null
      or client_id is not null
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_title_length
    check (char_length(btrim(title)) between 1 and 120);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_public_title_length
    check (public_title is null or char_length(btrim(public_title)) between 1 and 120);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_assignee_name_length
    check (assignee_name is null or char_length(btrim(assignee_name)) <= 60);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_date_order
    check (ends_at is null or ends_at >= starts_at);
exception when duplicate_object then null;
end $$;

create index if not exists idx_schedule_items_operation_team_start
on public.schedule_items(operation_team_id, starts_at);

create index if not exists idx_schedule_items_client_visibility_start
on public.schedule_items(client_id, visibility, starts_at);

create index if not exists idx_schedule_items_owner_start
on public.schedule_items(owner_agency_code, starts_at);

comment on column public.schedule_items.operation_team_id is
  '운영팀 단독 업무 범위. 광고주 연결 전에도 내부 업무를 보존한다.';

comment on column public.schedule_items.public_title is
  '광고주 공개 시에만 사용하는 공개용 제목. 내부 제목과 분리한다.';

comment on column public.schedule_items.visibility is
  '기본 internal. client_visible만 광고주 일정표에 반환한다.';

commit;
