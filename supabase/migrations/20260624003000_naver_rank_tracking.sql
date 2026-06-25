begin;

do $$ begin
  create type public.naver_rank_tracker_status as enum ('active', 'paused', 'completed', 'failed');
exception when duplicate_object then null;
end $$;

create table if not exists public.naver_rank_trackers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  agency_code text not null default 'mml93-a01',
  keyword text not null,
  product_url text,
  product_id text,
  mall_name text,
  product_title text,
  max_rank integer not null default 300 check (max_rank between 100 and 1000),
  status public.naver_rank_tracker_status not null default 'active',
  started_at timestamptz not null default now(),
  ends_at timestamptz not null default (now() + interval '30 days'),
  last_checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  current_rank integer,
  best_rank integer,
  worst_rank integer,
  check_count integer not null default 0,
  found_count integer not null default 0,
  last_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint naver_rank_trackers_has_target check (
    product_url is not null
    or product_id is not null
    or mall_name is not null
  )
);

create table if not exists public.naver_rank_snapshots (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.naver_rank_trackers(id) on delete cascade,
  checked_at timestamptz not null default now(),
  rank integer,
  page integer,
  position integer,
  matched boolean not null default false,
  checked_count integer,
  total integer,
  item jsonb not null default '{}'::jsonb,
  top_items jsonb not null default '[]'::jsonb,
  message text,
  source text not null default 'naver_shopping_search_api',
  created_at timestamptz not null default now()
);

create index if not exists idx_naver_rank_trackers_agency_status
on public.naver_rank_trackers(agency_code, status, created_at desc);

create index if not exists idx_naver_rank_trackers_next_check
on public.naver_rank_trackers(status, next_check_at)
where status = 'active';

create index if not exists idx_naver_rank_snapshots_tracker_checked
on public.naver_rank_snapshots(tracker_id, checked_at desc);

create unique index if not exists idx_naver_rank_trackers_active_target
on public.naver_rank_trackers(
  agency_code,
  lower(keyword),
  coalesce(product_id, ''),
  coalesce(product_url, ''),
  coalesce(mall_name, '')
)
where status = 'active';

drop trigger if exists trg_naver_rank_trackers_updated_at on public.naver_rank_trackers;
create trigger trg_naver_rank_trackers_updated_at before update on public.naver_rank_trackers
for each row execute function public.set_updated_at();

alter table public.naver_rank_trackers enable row level security;
alter table public.naver_rank_snapshots enable row level security;

drop policy if exists naver_rank_trackers_select_member_or_admin on public.naver_rank_trackers;
create policy naver_rank_trackers_select_member_or_admin on public.naver_rank_trackers
for select to authenticated
using (public.is_admin() or (client_id is not null and public.has_client_access(client_id)));

drop policy if exists naver_rank_trackers_admin_all on public.naver_rank_trackers;
create policy naver_rank_trackers_admin_all on public.naver_rank_trackers
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists naver_rank_snapshots_select_member_or_admin on public.naver_rank_snapshots;
create policy naver_rank_snapshots_select_member_or_admin on public.naver_rank_snapshots
for select to authenticated
using (
  exists (
    select 1
    from public.naver_rank_trackers tracker
    where tracker.id = tracker_id
      and (public.is_admin() or (tracker.client_id is not null and public.has_client_access(tracker.client_id)))
  )
);

drop policy if exists naver_rank_snapshots_admin_all on public.naver_rank_snapshots;
create policy naver_rank_snapshots_admin_all on public.naver_rank_snapshots
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select, insert, update, delete on public.naver_rank_trackers to authenticated, service_role;
grant select, insert, update, delete on public.naver_rank_snapshots to authenticated, service_role;

commit;
