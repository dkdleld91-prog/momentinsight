begin;

create table if not exists public.meta_ad_research_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  query text not null,
  page_name text,
  ad_url text,
  source_url text,
  platform text not null default 'ALL',
  media_type text not null default 'ALL',
  angle_type text not null default '후킹 카피',
  hook_text text,
  note text,
  created_by_role text not null default 'client',
  team_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_meta_ad_research_items_client_created
on public.meta_ad_research_items(client_id, created_at desc);

create index if not exists idx_meta_ad_research_items_query
on public.meta_ad_research_items(client_id, lower(query));

drop trigger if exists set_meta_ad_research_items_updated_at on public.meta_ad_research_items;
create trigger set_meta_ad_research_items_updated_at
before update on public.meta_ad_research_items
for each row execute function public.set_updated_at();

alter table public.meta_ad_research_items enable row level security;

drop policy if exists meta_ad_research_items_select_member_or_admin on public.meta_ad_research_items;
create policy meta_ad_research_items_select_member_or_admin on public.meta_ad_research_items
  for select to authenticated
  using (public.has_client_access(client_id));

drop policy if exists meta_ad_research_items_admin_all on public.meta_ad_research_items;
create policy meta_ad_research_items_admin_all on public.meta_ad_research_items
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.meta_ad_research_items to authenticated, service_role;

commit;
