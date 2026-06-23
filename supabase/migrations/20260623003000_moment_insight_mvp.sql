begin;

create extension if not exists pgcrypto;

do $$ begin
  create type public.user_role as enum ('super_admin', 'manager', 'analyst', 'client_owner', 'client_viewer');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.user_status as enum ('active', 'invited', 'suspended');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.client_status as enum ('active', 'paused', 'archived');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.visibility_status as enum ('internal', 'client_visible');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.report_type as enum ('weekly', 'monthly', 'kpi', 'sales', 'ads', 'keyword', 'campaign', 'content');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.schedule_status as enum ('planned', 'in_progress', 'done', 'paused', 'needs_check');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.schedule_type as enum ('ad_setup', 'content_upload', 'distribution', 'review', 'shooting', 'promotion', 'report_due', 'meeting', 'creative', 'keyword');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.priority_level as enum ('high', 'medium', 'low');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.action_status as enum ('planned', 'in_progress', 'done', 'blocked');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.action_category as enum ('budget', 'keyword', 'content', 'campaign', 'report', 'client_check');
exception when duplicate_object then null;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  email text unique,
  role public.user_role not null default 'client_viewer',
  status public.user_status not null default 'invited',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business_name text,
  agency_code text unique not null default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  status public.client_status not null default 'active',
  public_summary text,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  category text,
  main_marketplace text,
  status public.client_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_members (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.user_role not null default 'client_viewer',
  created_at timestamptz not null default now(),
  unique (client_id, user_id)
);

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.dashboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  period date not null,
  sales numeric(14, 2) not null default 0,
  ad_spend numeric(14, 2) not null default 0,
  roas numeric(10, 2) generated always as (
    case when ad_spend > 0 then round((sales / ad_spend) * 100, 2) else null end
  ) stored,
  impressions integer not null default 0,
  clicks integer not null default 0,
  orders integer not null default 0,
  reviews integer not null default 0,
  conversion_rate numeric(8, 2),
  click_rate numeric(8, 2),
  achievement_rate numeric(8, 2),
  public_comment text,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, brand_id, period)
);

create table if not exists public.kpi_targets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  period_month date not null,
  target_revenue numeric(14, 2) not null default 0,
  target_ad_spend numeric(14, 2) not null default 0,
  target_roas numeric(10, 2),
  target_orders integer not null default 0,
  target_reviews integer not null default 0,
  target_keyword_rank numeric(8, 2),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, brand_id, period_month)
);

create table if not exists public.kpi_results (
  id uuid primary key default gen_random_uuid(),
  kpi_target_id uuid not null unique references public.kpi_targets(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  actual_revenue numeric(14, 2) not null default 0,
  actual_ad_spend numeric(14, 2) not null default 0,
  actual_roas numeric(10, 2),
  actual_orders integer not null default 0,
  actual_cpa numeric(12, 2),
  actual_cpc numeric(12, 2),
  actual_ctr numeric(8, 2),
  actual_cvr numeric(8, 2),
  actual_reviews integer not null default 0,
  achievement_rate numeric(8, 2),
  public_comment text,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ad_performance (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  channel_id uuid references public.channels(id) on delete set null,
  period_start date not null,
  period_end date not null,
  ad_spend numeric(14, 2) not null default 0,
  revenue numeric(14, 2) not null default 0,
  roas numeric(10, 2) generated always as (
    case when ad_spend > 0 then round((revenue / ad_spend) * 100, 2) else null end
  ) stored,
  impressions integer not null default 0,
  clicks integer not null default 0,
  ctr numeric(8, 2) generated always as (
    case when impressions > 0 then round((clicks::numeric / impressions::numeric) * 100, 2) else null end
  ) stored,
  conversions integer not null default 0,
  cvr numeric(8, 2) generated always as (
    case when clicks > 0 then round((conversions::numeric / clicks::numeric) * 100, 2) else null end
  ) stored,
  orders integer not null default 0,
  cpa numeric(12, 2) generated always as (
    case when conversions > 0 then round(ad_spend / conversions::numeric, 2) else null end
  ) stored,
  cpc numeric(12, 2) generated always as (
    case when clicks > 0 then round(ad_spend / clicks::numeric, 2) else null end
  ) stored,
  previous_delta_rate numeric(8, 2),
  public_comment text,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.keywords (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  keyword text not null,
  priority public.priority_level not null default 'medium',
  target_channel text not null default 'naver',
  is_active boolean not null default true,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, brand_id, keyword, target_channel)
);

create table if not exists public.keyword_metrics (
  id uuid primary key default gen_random_uuid(),
  keyword_id uuid not null references public.keywords(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  period_date date not null,
  current_rank integer,
  previous_rank integer,
  rank_delta integer generated always as (
    case when current_rank is not null and previous_rank is not null then previous_rank - current_rank else null end
  ) stored,
  search_volume integer not null default 0,
  impressions integer not null default 0,
  ctr numeric(8, 2),
  conversion_contribution numeric(8, 2),
  naver_rank integer,
  coupang_rank integer,
  is_ad_exposed boolean not null default false,
  needs_seo_work boolean not null default false,
  monthly_search_volume jsonb not null default '{}'::jsonb,
  age_click_ratio jsonb not null default '{}'::jsonb,
  weekday_click_ratio jsonb not null default '{}'::jsonb,
  device_click_ratio jsonb not null default '{}'::jsonb,
  insight text,
  internal_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (keyword_id, period_date)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  report_type public.report_type not null,
  title text not null,
  report_date date not null,
  period_start date,
  period_end date,
  channel_id uuid references public.channels(id) on delete set null,
  summary text,
  public_comment text,
  internal_note text,
  visibility public.visibility_status not null default 'internal',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  report_id uuid references public.reports(id) on delete set null,
  title text not null,
  file_type text,
  url text,
  external_url text,
  storage_bucket text,
  storage_path text,
  visibility public.visibility_status not null default 'internal',
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint files_has_location check (
    url is not null
    or external_url is not null
    or (storage_bucket is not null and storage_path is not null)
  )
);

alter table public.files add column if not exists external_url text;
alter table public.files add column if not exists storage_bucket text;
alter table public.files add column if not exists storage_path text;
alter table public.files alter column url drop not null;

create table if not exists public.schedule_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  title text not null,
  schedule_type public.schedule_type not null,
  status public.schedule_status not null default 'planned',
  starts_at timestamptz not null,
  ends_at timestamptz,
  assignee_id uuid references auth.users(id) on delete set null,
  public_comment text,
  internal_note text,
  visibility public.visibility_status not null default 'client_visible',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.action_plans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  period_week date not null,
  title text not null,
  category public.action_category not null,
  priority public.priority_level not null default 'medium',
  status public.action_status not null default 'planned',
  description text,
  expected_impact text,
  client_request text,
  internal_note text,
  is_client_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clients add column if not exists internal_note text;
alter table public.dashboard_snapshots add column if not exists internal_note text;
alter table public.kpi_results add column if not exists internal_note text;
alter table public.ad_performance add column if not exists internal_note text;
alter table public.keywords add column if not exists internal_note text;
alter table public.keyword_metrics add column if not exists internal_note text;
alter table public.reports add column if not exists internal_note text;
alter table public.schedule_items add column if not exists internal_note text;
alter table public.action_plans add column if not exists internal_note text;

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  target_table text,
  target_id uuid,
  body text not null,
  visibility public.visibility_status not null default 'internal',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  action text not null,
  target_table text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_client_members_user_id on public.client_members(user_id);
create index if not exists idx_client_members_client_id on public.client_members(client_id);
create index if not exists idx_brands_client_id on public.brands(client_id);
create index if not exists idx_dashboard_snapshots_client_period on public.dashboard_snapshots(client_id, period desc);
create index if not exists idx_kpi_targets_client_month on public.kpi_targets(client_id, period_month desc);
create index if not exists idx_kpi_results_client_id on public.kpi_results(client_id);
create index if not exists idx_ad_performance_client_period on public.ad_performance(client_id, period_start desc);
create index if not exists idx_keywords_client_id on public.keywords(client_id);
create index if not exists idx_keyword_metrics_keyword_date on public.keyword_metrics(keyword_id, period_date desc);
create index if not exists idx_keyword_metrics_client_date on public.keyword_metrics(client_id, period_date desc);
create index if not exists idx_reports_client_date on public.reports(client_id, report_date desc);
create index if not exists idx_reports_client_type on public.reports(client_id, report_type);
create index if not exists idx_files_client_id on public.files(client_id);
create index if not exists idx_schedule_items_client_start on public.schedule_items(client_id, starts_at);
create index if not exists idx_action_plans_client_week on public.action_plans(client_id, period_week desc);
create index if not exists idx_comments_client_id on public.comments(client_id);
create index if not exists idx_audit_logs_client_id on public.audit_logs(client_id);

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_clients_updated_at on public.clients;
create trigger trg_clients_updated_at before update on public.clients
for each row execute function public.set_updated_at();

drop trigger if exists trg_brands_updated_at on public.brands;
create trigger trg_brands_updated_at before update on public.brands
for each row execute function public.set_updated_at();

drop trigger if exists trg_dashboard_snapshots_updated_at on public.dashboard_snapshots;
create trigger trg_dashboard_snapshots_updated_at before update on public.dashboard_snapshots
for each row execute function public.set_updated_at();

drop trigger if exists trg_kpi_targets_updated_at on public.kpi_targets;
create trigger trg_kpi_targets_updated_at before update on public.kpi_targets
for each row execute function public.set_updated_at();

drop trigger if exists trg_kpi_results_updated_at on public.kpi_results;
create trigger trg_kpi_results_updated_at before update on public.kpi_results
for each row execute function public.set_updated_at();

drop trigger if exists trg_ad_performance_updated_at on public.ad_performance;
create trigger trg_ad_performance_updated_at before update on public.ad_performance
for each row execute function public.set_updated_at();

drop trigger if exists trg_keywords_updated_at on public.keywords;
create trigger trg_keywords_updated_at before update on public.keywords
for each row execute function public.set_updated_at();

drop trigger if exists trg_keyword_metrics_updated_at on public.keyword_metrics;
create trigger trg_keyword_metrics_updated_at before update on public.keyword_metrics
for each row execute function public.set_updated_at();

drop trigger if exists trg_reports_updated_at on public.reports;
create trigger trg_reports_updated_at before update on public.reports
for each row execute function public.set_updated_at();

drop trigger if exists trg_schedule_items_updated_at on public.schedule_items;
create trigger trg_schedule_items_updated_at before update on public.schedule_items
for each row execute function public.set_updated_at();

drop trigger if exists trg_action_plans_updated_at on public.action_plans;
create trigger trg_action_plans_updated_at before update on public.action_plans
for each row execute function public.set_updated_at();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and status = 'active'
      and role in ('super_admin', 'manager', 'analyst')
  );
$$;

create or replace function public.has_client_access(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1
      from public.client_members
      where client_id = target_client_id
        and user_id = auth.uid()
    );
$$;

alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.brands enable row level security;
alter table public.client_members enable row level security;
alter table public.channels enable row level security;
alter table public.dashboard_snapshots enable row level security;
alter table public.kpi_targets enable row level security;
alter table public.kpi_results enable row level security;
alter table public.ad_performance enable row level security;
alter table public.keywords enable row level security;
alter table public.keyword_metrics enable row level security;
alter table public.reports enable row level security;
alter table public.files enable row level security;
alter table public.schedule_items enable row level security;
alter table public.action_plans enable row level security;
alter table public.comments enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin on public.profiles
for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists clients_select_member_or_admin on public.clients;
create policy clients_select_member_or_admin on public.clients
for select to authenticated
using (public.has_client_access(id));

drop policy if exists clients_admin_all on public.clients;
create policy clients_admin_all on public.clients
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists brands_select_member_or_admin on public.brands;
create policy brands_select_member_or_admin on public.brands
for select to authenticated
using (public.has_client_access(client_id));

drop policy if exists brands_admin_all on public.brands;
create policy brands_admin_all on public.brands
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists client_members_select_self_or_admin on public.client_members;
create policy client_members_select_self_or_admin on public.client_members
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists client_members_admin_all on public.client_members;
create policy client_members_admin_all on public.client_members
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists channels_read_authenticated on public.channels;
create policy channels_read_authenticated on public.channels
for select to authenticated
using (true);

drop policy if exists channels_admin_all on public.channels;
create policy channels_admin_all on public.channels
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists dashboard_snapshots_select_member_or_admin on public.dashboard_snapshots;
create policy dashboard_snapshots_select_member_or_admin on public.dashboard_snapshots
for select to authenticated
using (public.has_client_access(client_id));

drop policy if exists dashboard_snapshots_admin_all on public.dashboard_snapshots;
create policy dashboard_snapshots_admin_all on public.dashboard_snapshots
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists kpi_targets_select_member_or_admin on public.kpi_targets;
create policy kpi_targets_select_member_or_admin on public.kpi_targets
for select to authenticated
using (public.has_client_access(client_id));

drop policy if exists kpi_targets_admin_all on public.kpi_targets;
create policy kpi_targets_admin_all on public.kpi_targets
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists kpi_results_select_member_or_admin on public.kpi_results;
create policy kpi_results_select_member_or_admin on public.kpi_results
for select to authenticated
using (public.has_client_access(client_id));

drop policy if exists kpi_results_admin_all on public.kpi_results;
create policy kpi_results_admin_all on public.kpi_results
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists ad_performance_select_member_or_admin on public.ad_performance;
create policy ad_performance_select_member_or_admin on public.ad_performance
for select to authenticated
using (public.has_client_access(client_id));

drop policy if exists ad_performance_admin_all on public.ad_performance;
create policy ad_performance_admin_all on public.ad_performance
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists keywords_select_member_or_admin on public.keywords;
create policy keywords_select_member_or_admin on public.keywords
for select to authenticated
using (public.has_client_access(client_id));

drop policy if exists keywords_admin_all on public.keywords;
create policy keywords_admin_all on public.keywords
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists keyword_metrics_select_member_or_admin on public.keyword_metrics;
create policy keyword_metrics_select_member_or_admin on public.keyword_metrics
for select to authenticated
using (public.has_client_access(client_id));

drop policy if exists keyword_metrics_admin_all on public.keyword_metrics;
create policy keyword_metrics_admin_all on public.keyword_metrics
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists reports_select_visible_member_or_admin on public.reports;
create policy reports_select_visible_member_or_admin on public.reports
for select to authenticated
using (public.is_admin() or (visibility = 'client_visible' and public.has_client_access(client_id)));

drop policy if exists reports_admin_all on public.reports;
create policy reports_admin_all on public.reports
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists files_select_visible_member_or_admin on public.files;
create policy files_select_visible_member_or_admin on public.files
for select to authenticated
using (public.is_admin() or (visibility = 'client_visible' and public.has_client_access(client_id)));

drop policy if exists files_admin_all on public.files;
create policy files_admin_all on public.files
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists schedule_items_select_visible_member_or_admin on public.schedule_items;
create policy schedule_items_select_visible_member_or_admin on public.schedule_items
for select to authenticated
using (public.is_admin() or (visibility = 'client_visible' and public.has_client_access(client_id)));

drop policy if exists schedule_items_admin_all on public.schedule_items;
create policy schedule_items_admin_all on public.schedule_items
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists action_plans_select_visible_member_or_admin on public.action_plans;
create policy action_plans_select_visible_member_or_admin on public.action_plans
for select to authenticated
using (public.is_admin() or (is_client_visible and public.has_client_access(client_id)));

drop policy if exists action_plans_admin_all on public.action_plans;
create policy action_plans_admin_all on public.action_plans
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists comments_select_visible_member_or_admin on public.comments;
create policy comments_select_visible_member_or_admin on public.comments
for select to authenticated
using (public.is_admin() or (visibility = 'client_visible' and public.has_client_access(client_id)));

drop policy if exists comments_admin_all on public.comments;
create policy comments_admin_all on public.comments
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists audit_logs_admin_select on public.audit_logs;
create policy audit_logs_admin_select on public.audit_logs
for select to authenticated
using (public.is_admin());

drop policy if exists audit_logs_admin_insert on public.audit_logs;
create policy audit_logs_admin_insert on public.audit_logs
for insert to authenticated
with check (public.is_admin());

insert into public.channels (code, name, sort_order)
values
  ('naver', '네이버', 10),
  ('coupang', '쿠팡', 20),
  ('meta', '메타', 30),
  ('self_mall', '자사몰', 40),
  ('etc', '기타', 100)
on conflict (code) do update
set name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'moment-reports',
    'moment-reports',
    false,
    52428800,
    array[
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/png',
      'image/jpeg',
      'image/webp'
    ]
  ),
  (
    'moment-assets',
    'moment-assets',
    false,
    52428800,
    array[
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/mp4'
    ]
  )
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

grant usage on schema public to anon, authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.has_client_access(uuid) to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

commit;
