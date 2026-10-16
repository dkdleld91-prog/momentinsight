-- C 30일 순위(쿠팡 검색 1쪽, 광고 제외 일반 순위) 저장소. 구현 명세 v3 §4.
-- 독립 모듈: 이 파일은 coupang_rank_* 표·함수만 만든다. 다른 표는 clients·operation_team_codes 를 읽기만 하고,
-- 추적기는 clients(id) 삭제를 따라 함께 지워진다(on delete cascade).
-- 다시 실행해도 안전하다(if not exists · on conflict do nothing · create or replace · drop trigger if exists).
-- 코드 배포 전후 어느 쪽에 실행해도 된다(settings.enabled 기본값 false).
-- 금지: 다른 순위 기능의 표·함수 이름(잠금 검사 정규식), 함수 본문의 'x.y.z' 버전 문자열·64자리 16진 리터럴.

begin;

-- ───────────────────────── 1. 표 ─────────────────────────

create table if not exists public.coupang_rank_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  team_access_enabled boolean not null default false,
  client_view_enabled boolean not null default false,
  checks_per_day smallint not null default 2 check (checks_per_day between 1 and 6),
  min_gap_seconds integer not null default 240 check (min_gap_seconds between 30 and 3600),
  gap_jitter_seconds integer not null default 120 check (gap_jitter_seconds between 0 and 600),
  max_runs_per_hour smallint not null default 12 check (max_runs_per_hour between 1 and 60),
  max_runs_per_day smallint not null default 120 check (max_runs_per_day between 1 and 1000),
  active_from_hour smallint not null default 8 check (active_from_hour between 0 and 23),
  active_to_hour smallint not null default 23 check (active_to_hour between 1 and 24),
  default_account_limit smallint not null default 20 check (default_account_limit between 0 and 1000),
  global_keyword_limit smallint not null default 150 check (global_keyword_limit between 1 and 1000),
  window_mode text not null default 'offscreen' check (window_mode in ('normal', 'offscreen', 'minimized')),
  min_collector_version text null
    check (min_collector_version is null or min_collector_version ~ '^[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}$'),
  max_storage_mb integer not null default 60 check (max_storage_mb between 10 and 400),
  db_size_stop_mb integer not null default 450 check (db_size_stop_mb between 100 and 8000),
  cooldown_until timestamptz null,
  cooldown_reason text null check (cooldown_reason is null or cooldown_reason in (
    'blocked', 'empty', 'empty_escalated', 'error_streak', 'error_escalated')),
  needs_owner_review boolean not null default false,
  review_reason text null check (review_reason is null or char_length(review_reason) <= 60),
  budget_blocked boolean not null default false,
  budget_reason text null check (budget_reason is null or budget_reason in ('storage', 'database')),
  error_streak smallint not null default 0,
  empty_streak smallint not null default 0,
  last_claim_at timestamptz null,
  next_claim_not_before timestamptz null,
  last_housekeeping_at timestamptz null,
  rate_changed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text null check (updated_by is null or char_length(updated_by) <= 40),
  constraint coupang_rank_settings_hours_chk check (active_from_hour < active_to_hour)
);
insert into public.coupang_rank_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.coupang_rank_account_limits (
  agency_code text primary key
    check (agency_code = lower(agency_code) and char_length(agency_code) between 1 and 64),
  keyword_limit smallint not null check (keyword_limit between 0 and 1000),
  updated_at timestamptz not null default now(),
  updated_by text null check (updated_by is null or char_length(updated_by) <= 40)
);
insert into public.coupang_rank_account_limits (agency_code, keyword_limit)
values ('mml93-a01', 100) on conflict (agency_code) do nothing;

create table if not exists public.coupang_rank_collectors (
  id uuid primary key default gen_random_uuid(),
  label text not null default '수집기' check (char_length(label) between 1 and 40),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_hint text not null check (char_length(token_hint) = 4),
  created_at timestamptz not null default now(),
  created_by text null check (created_by is null or char_length(created_by) <= 40),
  revoked_at timestamptz null,
  last_seen_at timestamptz null,
  platform text null check (platform is null or platform in ('windows', 'macos')),
  last_version text null check (last_version is null or char_length(last_version) <= 20),
  last_node text null check (last_node is null or char_length(last_node) <= 20),
  last_browser text null check (last_browser is null or char_length(last_browser) <= 60),
  last_os text null check (last_os is null or char_length(last_os) <= 60),
  last_guard text null check (last_guard is null or char_length(last_guard) <= 40),
  last_claim_at timestamptz null,
  last_claim_reply jsonb null
);

create table if not exists public.coupang_rank_trackers (
  id uuid primary key default gen_random_uuid(),
  agency_code text not null
    check (agency_code = lower(agency_code) and char_length(agency_code) between 1 and 64),
  client_id uuid null references public.clients(id) on delete cascade,
  keyword text not null check (char_length(keyword) between 1 and 50),
  keyword_key text not null check (char_length(keyword_key) between 1 and 50 and keyword_key = btrim(keyword_key)),
  product_id text not null check (product_id ~ '^[0-9]{4,15}$'),
  product_url text not null check (char_length(product_url) between 1 and 200),
  vendor_item_id text null check (vendor_item_id is null or vendor_item_id ~ '^[0-9]{1,20}$'),
  product_title text null check (product_title is null or char_length(product_title) <= 120),
  group_name text not null default '기본 그룹' check (char_length(group_name) between 1 and 30),
  sort_order integer not null default 1000,
  status text not null default 'active' check (status in ('active', 'paused')),
  paused_at timestamptz null,
  created_kst_day date not null default ((now() at time zone 'Asia/Seoul')::date),
  current_result text null check (current_result is null or current_result in ('found', 'out', 'short', 'noresult')),
  current_rank smallint null check (current_rank is null or current_rank between 1 and 50),
  current_organic_count smallint null check (current_organic_count is null or current_organic_count between 0 and 100),
  current_ad_order smallint null check (current_ad_order is null or current_ad_order between 1 and 30),
  current_same_option boolean null,
  last_checked_at timestamptz null,
  last_found_at timestamptz null,
  check_count integer not null default 0,
  found_count integer not null default 0,
  created_by text null check (created_by is null or char_length(created_by) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists coupang_rank_trackers_scope_product_uq
  on public.coupang_rank_trackers (agency_code, keyword_key, product_id);
create index if not exists coupang_rank_trackers_scope_idx
  on public.coupang_rank_trackers (agency_code, group_name, sort_order, created_at desc);
create index if not exists coupang_rank_trackers_active_keyword_idx
  on public.coupang_rank_trackers (keyword_key) where status = 'active';
create index if not exists coupang_rank_trackers_client_idx
  on public.coupang_rank_trackers (client_id) where client_id is not null;

create table if not exists public.coupang_rank_keywords (
  keyword_key text primary key check (char_length(keyword_key) between 1 and 50),
  search_text text not null check (char_length(search_text) between 1 and 50),
  next_due_at timestamptz not null default now(),
  slot_day date null,
  slot_index smallint null check (slot_index is null or slot_index between 0 and 5),
  slot_ends_at timestamptz null,
  slot_attempts smallint not null default 0,
  lease_run_id uuid null,
  lease_until timestamptz null,
  last_run_at timestamptz null,
  last_success_at timestamptz null,
  last_status text null check (last_status is null or char_length(last_status) <= 20),
  consecutive_failures smallint not null default 0,
  consecutive_unsupported smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists coupang_rank_keywords_due_idx on public.coupang_rank_keywords (next_due_at);

create table if not exists public.coupang_rank_runs (
  id uuid primary key default gen_random_uuid(),
  keyword_key text not null,
  collector_id uuid null references public.coupang_rank_collectors(id) on delete set null,
  slot_day date null,
  slot_index smallint null,
  slot_minute smallint null check (slot_minute is null or slot_minute between 0 and 1439),
  claimed_at timestamptz not null default now(),
  lease_until timestamptz not null,
  completed_at timestamptz null,
  status text not null default 'leased' check (status in (
    'leased', 'expired', 'released', 'ok', 'noresult', 'partial', 'blocked', 'empty', 'error', 'timeout', 'unsupported')),
  late boolean not null default false,
  http_status smallint null check (http_status is null or http_status between 0 and 599),
  login_wall boolean null,
  stable boolean null,
  item_count smallint null check (item_count is null or item_count between 0 and 200),
  organic_count smallint null check (organic_count is null or organic_count between 0 and 100),
  ad_count smallint null check (ad_count is null or ad_count between 0 and 30),
  organic jsonb null check (organic is null or (jsonb_typeof(organic) = 'array' and jsonb_array_length(organic) <= 100)),
  ads jsonb null check (ads is null or (jsonb_typeof(ads) = 'array' and jsonb_array_length(ads) <= 30)),
  final_host text null check (final_host is null or char_length(final_host) <= 60),
  final_path text null check (final_path is null or char_length(final_path) <= 80),
  duration_ms integer null check (duration_ms is null or duration_ms between 0 and 600000),
  collector_version text null check (collector_version is null or char_length(collector_version) <= 20),
  browser text null check (browser is null or char_length(browser) <= 60),
  error_code text null check (error_code is null or char_length(error_code) <= 60),
  matched_count smallint null
);
create index if not exists coupang_rank_runs_keyword_idx on public.coupang_rank_runs (keyword_key, claimed_at desc);
create index if not exists coupang_rank_runs_claimed_idx on public.coupang_rank_runs (claimed_at desc);
create index if not exists coupang_rank_runs_leased_idx on public.coupang_rank_runs (lease_until) where status = 'leased';

-- 추적기별 측정 원본. 덧붙이기만 한다(서버 코드에 update 경로 없음 → db-export 증분 대상).
-- run_id 는 외래키를 두지 않는다: 회차(14일)를 지울 때 이 표의 줄을 고치지 않게 하려는 것이다(증분 백업 전제).
-- slot_minute = 그 회차 칸의 시작 시각(KST, 자정부터 분). 하루 횟수가 바뀌어도 같은 시간대끼리만 비교하는 열쇠다.
create table if not exists public.coupang_rank_snapshots (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.coupang_rank_trackers(id) on delete cascade,
  run_id uuid not null,
  checked_at timestamptz not null,
  kst_day date not null,
  slot_index smallint not null default 0 check (slot_index between 0 and 5),
  slot_minute smallint not null default 0 check (slot_minute between 0 and 1439),
  result text not null check (result in ('found', 'out', 'short', 'noresult')),
  rank smallint null check (rank is null or rank between 1 and 50),
  organic_count smallint not null check (organic_count between 0 and 100),
  organic_slot smallint null check (organic_slot is null or organic_slot between 1 and 200),
  ad_order smallint null check (ad_order is null or ad_order between 1 and 30),
  vendor_item_id text null check (vendor_item_id is null or char_length(vendor_item_id) <= 20),
  same_option boolean null,
  title text null check (title is null or char_length(title) <= 80),
  source text not null default 'coupang_search_page1',
  created_at timestamptz not null default now(),
  constraint coupang_rank_snapshots_rank_chk check ((result = 'found') = (rank is not null))
);
create unique index if not exists coupang_rank_snapshots_run_uq on public.coupang_rank_snapshots (tracker_id, run_id);
create index if not exists coupang_rank_snapshots_tracker_idx on public.coupang_rank_snapshots (tracker_id, checked_at desc);
create index if not exists coupang_rank_snapshots_created_idx on public.coupang_rank_snapshots (created_at);

-- KST 하루 × 칸(시작 분) 1줄. 화면이 읽는 유일한 기록 표.
create table if not exists public.coupang_rank_days (
  tracker_id uuid not null references public.coupang_rank_trackers(id) on delete cascade,
  kst_day date not null,
  slot_minute smallint not null default 0 check (slot_minute between 0 and 1439),
  slot_index smallint not null default 0 check (slot_index between 0 and 5),
  result text not null check (result in ('found', 'out', 'short', 'noresult', 'failed', 'unsupported')),
  rank smallint null check (rank is null or rank between 1 and 50),
  organic_count smallint null,
  ad_order smallint null,
  checked_at timestamptz not null,
  success_count smallint not null default 0,
  failure_count smallint not null default 0,
  best_rank smallint null,
  updated_at timestamptz not null default now(),
  primary key (tracker_id, kst_day, slot_minute)
);
create index if not exists coupang_rank_days_day_idx on public.coupang_rank_days (kst_day);

create table if not exists public.coupang_rank_cooldowns (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  reason text not null check (reason in ('blocked', 'empty', 'empty_escalated', 'error_streak', 'error_escalated')),
  level smallint null check (level is null or level between 1 and 3),
  run_id uuid null,
  cleared_at timestamptz null,
  cleared_by text null check (cleared_by is null or char_length(cleared_by) <= 40)
);
create index if not exists coupang_rank_cooldowns_started_idx on public.coupang_rank_cooldowns (started_at desc);

-- ───────────────────────── 2. updated_at 트리거 ─────────────────────────

drop trigger if exists trg_coupang_rank_settings_updated_at on public.coupang_rank_settings;
create trigger trg_coupang_rank_settings_updated_at before update on public.coupang_rank_settings
for each row execute function public.set_updated_at();
drop trigger if exists trg_coupang_rank_account_limits_updated_at on public.coupang_rank_account_limits;
create trigger trg_coupang_rank_account_limits_updated_at before update on public.coupang_rank_account_limits
for each row execute function public.set_updated_at();
drop trigger if exists trg_coupang_rank_trackers_updated_at on public.coupang_rank_trackers;
create trigger trg_coupang_rank_trackers_updated_at before update on public.coupang_rank_trackers
for each row execute function public.set_updated_at();
drop trigger if exists trg_coupang_rank_keywords_updated_at on public.coupang_rank_keywords;
create trigger trg_coupang_rank_keywords_updated_at before update on public.coupang_rank_keywords
for each row execute function public.set_updated_at();
drop trigger if exists trg_coupang_rank_days_updated_at on public.coupang_rank_days;
create trigger trg_coupang_rank_days_updated_at before update on public.coupang_rank_days
for each row execute function public.set_updated_at();

-- ───────────────────────── 3. 권한(RLS, service_role 전용, 정책 없음) ─────────────────────────

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'coupang_rank_settings', 'coupang_rank_account_limits', 'coupang_rank_collectors', 'coupang_rank_trackers',
    'coupang_rank_keywords', 'coupang_rank_runs', 'coupang_rank_snapshots', 'coupang_rank_days', 'coupang_rank_cooldowns']
  loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert, update, delete on table public.%I to service_role', v_table);
  end loop;
end;
$$;

-- ───────────────────────── 4. 함수 ─────────────────────────

-- 4.1 수집 대상 판정(A1): 광고주 범위는 연결 상태, 팀 코드 범위는 팀 코드 상태를 본다. 총관리자 범위는 늘 대상.
create or replace function public.coupang_rank_tracker_is_eligible(p_client_id uuid, p_agency_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_client_id is not null then exists (
      select 1 from public.clients c
       where c.id = p_client_id and c.status::text = 'active' and c.disconnected_at is null)
    else not exists (
      select 1 from public.operation_team_codes o
       where lower(o.team_code) = p_agency_code and o.status <> 'active')
  end;
$$;

-- 4.2 다음 측정 칸(B6): 수집 시간대를 하루 n칸으로 나누고, 키워드마다 칸 안의 고정 위치(앞 60% 안)에 둔다.
create or replace function public.coupang_rank_plan_next(p_keyword_key text, p_after timestamptz, p_first boolean)
returns table (due_at timestamptz, slot_day date, slot_index smallint, slot_ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_n integer;
  v_from integer;
  v_to integer;
  v_len interval;
  v_frac double precision;
  v_base date;
  v_start timestamptz;
  v_end timestamptz;
begin
  select s.checks_per_day, s.active_from_hour, s.active_to_hour into v_n, v_from, v_to
    from public.coupang_rank_settings s where s.id = 1;
  v_n := coalesce(v_n, 2);
  v_from := coalesce(v_from, 8);
  v_to := coalesce(v_to, 23);
  v_len := make_interval(secs => ((v_to - v_from) * 3600)::double precision / v_n);
  v_frac := ((hashtext(p_keyword_key)::bigint & 2147483647) % 1000) / 1000.0 * 0.6;
  v_base := (p_after at time zone 'Asia/Seoul')::date - 1;
  for d in 0..3 loop
    for i in 0..(v_n - 1) loop
      v_start := ((v_base + d) + make_interval(hours => v_from) + v_len * i) at time zone 'Asia/Seoul';
      v_end := v_start + v_len;
      continue when v_end - interval '60 seconds' <= p_after;
      due_at := case when p_first and v_start <= p_after then p_after
                     else greatest(v_start + v_len * v_frac, p_after) end;
      slot_day := v_base + d;
      slot_index := i::smallint;
      slot_ends_at := v_end;
      return next;
      return;
    end loop;
  end loop;
  due_at := p_after + interval '1 hour';
  slot_day := (p_after at time zone 'Asia/Seoul')::date;
  slot_index := 0;
  slot_ends_at := p_after + interval '2 hours';
  return next;
end;
$$;

-- 4.3 상품 맞추기(단일 출처): 광고를 뺀 일반 목록에서 같은 상품번호가 처음 나온 순번. 51번째 이후는 '50위 밖'(H3).
-- 옵션은 기록만 한다.
create or replace function public.coupang_rank_match(
  p_organic jsonb, p_ads jsonb, p_product_id text, p_vendor_item_id text, p_noresult boolean)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_count integer := coalesce(jsonb_array_length(p_organic), 0);
  v_ord integer;
  v_rank integer;
  v_slot integer;
  v_vendor text;
  v_title text;
  v_ad integer;
  v_ad_title text;
begin
  if p_noresult then
    return jsonb_build_object('result', 'noresult', 'rank', null, 'organicCount', 0, 'organicSlot', null,
      'adOrder', null, 'vendorItemId', null, 'sameOption', null, 'title', null);
  end if;
  select e.ord::integer, (e.item ->> 's')::integer, nullif(e.item ->> 'v', ''), left(nullif(e.item ->> 't', ''), 80)
    into v_ord, v_slot, v_vendor, v_title
    from jsonb_array_elements(coalesce(p_organic, '[]'::jsonb)) with ordinality as e(item, ord)
   where e.item ->> 'p' = p_product_id
   order by e.ord
   limit 1;
  v_rank := case when v_ord <= 50 then v_ord else null end;
  select e.ord::integer, left(nullif(e.item ->> 't', ''), 80)
    into v_ad, v_ad_title
    from jsonb_array_elements(coalesce(p_ads, '[]'::jsonb)) with ordinality as e(item, ord)
   where e.item ->> 'p' = p_product_id
   order by e.ord
   limit 1;
  return jsonb_build_object(
    'result', case when v_rank is not null then 'found' when v_count >= 50 then 'out' else 'short' end,
    'rank', v_rank,
    'organicCount', least(v_count, 100),
    'organicSlot', v_slot,
    'adOrder', v_ad,
    'vendorItemId', v_vendor,
    'sameOption', case when v_rank is null or p_vendor_item_id is null then null
                       else v_vendor is not distinct from p_vendor_item_id end,
    'title', coalesce(v_title, v_ad_title));
end;
$$;

-- 4.4 성공 회차 1건을 추적기 1개에 반영(스냅샷 → 일별 칸 → 추적기 현재값). 같은 (추적기, 회차)는 한 번만.
create or replace function public.coupang_rank_apply_success(
  p_run_id uuid, p_tracker_id uuid, p_page_organic jsonb, p_page_ads jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.coupang_rank_runs%rowtype;
  t public.coupang_rank_trackers%rowtype;
  m jsonb;
  v_day date;
  v_slot smallint;
  v_minute smallint;
  v_result text;
  v_rank smallint;
  v_inserted uuid;
begin
  select * into r from public.coupang_rank_runs where id = p_run_id;
  if not found or r.status not in ('ok', 'noresult') then return false; end if;
  select * into t from public.coupang_rank_trackers where id = p_tracker_id for update;
  if not found or t.status <> 'active' or t.keyword_key <> r.keyword_key then return false; end if;
  if not public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code) then return false; end if;
  m := public.coupang_rank_match(coalesce(p_page_organic, r.organic), coalesce(p_page_ads, r.ads),
                                 t.product_id, t.vendor_item_id, r.status = 'noresult');
  v_day := coalesce(r.slot_day, (r.claimed_at at time zone 'Asia/Seoul')::date);
  v_slot := coalesce(r.slot_index, 0);
  v_minute := coalesce(r.slot_minute, 0);
  v_result := m ->> 'result';
  v_rank := (m ->> 'rank')::smallint;
  insert into public.coupang_rank_snapshots (
    tracker_id, run_id, checked_at, kst_day, slot_index, slot_minute, result, rank, organic_count, organic_slot,
    ad_order, vendor_item_id, same_option, title)
  values (
    t.id, r.id, r.claimed_at, v_day, v_slot, v_minute, v_result, v_rank, (m ->> 'organicCount')::smallint,
    (m ->> 'organicSlot')::smallint, (m ->> 'adOrder')::smallint, m ->> 'vendorItemId',
    (m ->> 'sameOption')::boolean, m ->> 'title')
  on conflict (tracker_id, run_id) do nothing
  returning id into v_inserted;
  if v_inserted is null then return false; end if;

  insert into public.coupang_rank_days as d (
    tracker_id, kst_day, slot_minute, slot_index, result, rank, organic_count, ad_order, checked_at,
    success_count, failure_count, best_rank)
  values (
    t.id, v_day, v_minute, v_slot, v_result, v_rank, (m ->> 'organicCount')::smallint, (m ->> 'adOrder')::smallint,
    r.claimed_at, 1, 0, v_rank)
  on conflict (tracker_id, kst_day, slot_minute) do update set
    result = case when d.success_count = 0 or excluded.checked_at >= d.checked_at then excluded.result else d.result end,
    rank = case when d.success_count = 0 or excluded.checked_at >= d.checked_at then excluded.rank else d.rank end,
    organic_count = case when d.success_count = 0 or excluded.checked_at >= d.checked_at then excluded.organic_count else d.organic_count end,
    ad_order = case when d.success_count = 0 or excluded.checked_at >= d.checked_at then excluded.ad_order else d.ad_order end,
    checked_at = case when d.success_count = 0 or excluded.checked_at >= d.checked_at then excluded.checked_at else d.checked_at end,
    slot_index = excluded.slot_index,
    success_count = d.success_count + 1,
    best_rank = least(d.best_rank, excluded.best_rank),
    updated_at = now();

  update public.coupang_rank_trackers set
    current_result = case when r.claimed_at >= coalesce(last_checked_at, '-infinity'::timestamptz) then v_result else current_result end,
    current_rank = case when r.claimed_at >= coalesce(last_checked_at, '-infinity'::timestamptz) then v_rank else current_rank end,
    current_organic_count = case when r.claimed_at >= coalesce(last_checked_at, '-infinity'::timestamptz)
                                 then (m ->> 'organicCount')::smallint else current_organic_count end,
    current_ad_order = case when r.claimed_at >= coalesce(last_checked_at, '-infinity'::timestamptz)
                            then (m ->> 'adOrder')::smallint else current_ad_order end,
    current_same_option = case when r.claimed_at >= coalesce(last_checked_at, '-infinity'::timestamptz)
                               then (m ->> 'sameOption')::boolean else current_same_option end,
    last_checked_at = greatest(coalesce(last_checked_at, r.claimed_at), r.claimed_at),
    last_found_at = case when v_result = 'found' then greatest(coalesce(last_found_at, r.claimed_at), r.claimed_at)
                         else last_found_at end,
    check_count = check_count + 1,
    found_count = found_count + case when v_result = 'found' then 1 else 0 end,
    product_title = coalesce(product_title, m ->> 'title')
  where id = t.id;
  return true;
end;
$$;

-- 4.5 실패 회차: 그 키워드의 대상 추적기마다 그날·그 칸에 실패를 센다. 이미 성공한 칸은 값을 바꾸지 않는다.
create or replace function public.coupang_rank_mark_failed(p_run_id uuid, p_result text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.coupang_rank_runs%rowtype;
  v_day date;
  v_count integer := 0;
begin
  if p_result not in ('failed', 'unsupported') then return 0; end if;
  select * into r from public.coupang_rank_runs where id = p_run_id;
  if not found then return 0; end if;
  v_day := coalesce(r.slot_day, (r.claimed_at at time zone 'Asia/Seoul')::date);
  insert into public.coupang_rank_days as d (
    tracker_id, kst_day, slot_minute, slot_index, result, checked_at, success_count, failure_count)
  select t.id, v_day, coalesce(r.slot_minute, 0), coalesce(r.slot_index, 0), p_result, r.claimed_at, 0, 1
    from public.coupang_rank_trackers t
   where t.keyword_key = r.keyword_key
     and t.status = 'active'
     and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code)
  on conflict (tracker_id, kst_day, slot_minute) do update set
    failure_count = d.failure_count + 1,
    result = case when d.success_count = 0 then excluded.result else d.result end,
    checked_at = case when d.success_count = 0 then greatest(d.checked_at, excluded.checked_at) else d.checked_at end,
    updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 4.6 쉬기(B9): 차단 단계는 최근 7일 차단급 쉬기(blocked·empty_escalated·error_escalated) 횟수로 정한다.
-- 성공 한 번으로 초기화되지 않는다. 3번째부터 대표 확인. 사유는 더 길거나 같은 쉬기일 때만 덮어쓴다.
create or replace function public.coupang_rank_apply_cooldown(p_reason text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  v_level smallint;
  v_until timestamptz;
  v_review boolean := false;
begin
  if p_reason in ('blocked', 'empty_escalated', 'error_escalated') then
    select count(*) + 1 into v_n from public.coupang_rank_cooldowns c
     where c.reason in ('blocked', 'empty_escalated', 'error_escalated') and c.started_at > now() - interval '7 days';
    v_level := least(v_n, 3);
    v_until := now() + case v_level when 1 then interval '6 hours' when 2 then interval '12 hours' else interval '24 hours' end;
    v_review := v_n >= 3;
  elsif p_reason = 'empty' then
    v_until := now() + interval '1 hour';
  elsif p_reason = 'error_streak' then
    v_until := now() + interval '30 minutes';
  else
    return jsonb_build_object('ok', false);
  end if;
  insert into public.coupang_rank_cooldowns (ends_at, reason, level, run_id) values (v_until, p_reason, v_level, p_run_id);
  update public.coupang_rank_settings set
    cooldown_reason = case when cooldown_until is null or cooldown_until <= now() or v_until >= cooldown_until
                           then p_reason else cooldown_reason end,
    cooldown_until = greatest(coalesce(cooldown_until, v_until), v_until),
    needs_owner_review = needs_owner_review or v_review,
    review_reason = case when v_review then 'blocked_3_in_7d' else review_reason end
  where id = 1;
  return jsonb_build_object('ok', true, 'until', v_until, 'level', v_level, 'review', v_review);
end;
$$;

-- 4.7 연속 오류(P2·P3): 오류·시간 초과·임대 만료가 3번 이어지면 30분 쉬기. 24시간 안의 두 번째는 차단 단계로 올린다.
-- record(오류·시간 초과)와 claim(임대 만료 정리)이 같은 함수를 쓴다. 설정 행은 부르는 쪽이 이미 잠갔다.
create or replace function public.coupang_rank_note_error(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_streak integer;
  v_cool jsonb;
begin
  update public.coupang_rank_settings set error_streak = error_streak + 1 where id = 1
  returning error_streak into v_streak;
  if coalesce(v_streak, 0) < 3 then return null; end if;
  if exists (select 1 from public.coupang_rank_cooldowns c
              where c.reason = 'error_streak' and c.started_at > now() - interval '24 hours') then
    v_cool := public.coupang_rank_apply_cooldown('error_escalated', p_run_id);
  else
    v_cool := public.coupang_rank_apply_cooldown('error_streak', p_run_id);
  end if;
  update public.coupang_rank_settings set error_streak = 0 where id = 1;
  return v_cool;
end;
$$;

-- 4.8 실패 뒤 일정(A8): 키워드 임대가 이 회차일 때만 고친다(새 회차의 임대를 풀지 않는다).
create or replace function public.coupang_rank_reschedule_failure(p_keyword_key text, p_run_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.coupang_rank_keywords%rowtype;
  p record;
  v_now timestamptz := now();
begin
  select * into k from public.coupang_rank_keywords where keyword_key = p_keyword_key for update;
  if not found or k.lease_run_id is distinct from p_run_id then return false; end if;
  update public.coupang_rank_keywords
     set lease_run_id = null, lease_until = null, last_status = p_status
   where keyword_key = p_keyword_key;
  if p_status in ('blocked', 'empty') then
    return true;  -- 전역 쉬기가 막는다. 칸은 그대로 두고 쉬기가 끝난 뒤 같은 칸에서 다시 잰다.
  end if;
  if p_status = 'unsupported' then
    update public.coupang_rank_keywords set consecutive_unsupported = consecutive_unsupported + 1
     where keyword_key = p_keyword_key;
    select * into p from public.coupang_rank_plan_next(
      p_keyword_key,
      case when k.consecutive_unsupported + 1 >= 3 then v_now + interval '7 days'
           else (((v_now at time zone 'Asia/Seoul')::date + 1)::timestamp at time zone 'Asia/Seoul') end,
      false);
  else
    update public.coupang_rank_keywords set consecutive_failures = consecutive_failures + 1
     where keyword_key = p_keyword_key;
    if k.slot_attempts < 3 and k.slot_ends_at is not null
       and v_now + interval '20 minutes' < k.slot_ends_at - interval '60 seconds' then
      update public.coupang_rank_keywords set next_due_at = v_now + interval '20 minutes'
       where keyword_key = p_keyword_key;
      return true;
    end if;
    select * into p from public.coupang_rank_plan_next(
      p_keyword_key, greatest(coalesce(k.slot_ends_at, v_now), v_now), false);
  end if;
  update public.coupang_rank_keywords
     set next_due_at = p.due_at, slot_day = p.slot_day, slot_index = p.slot_index,
         slot_ends_at = p.slot_ends_at, slot_attempts = 0
   where keyword_key = p_keyword_key;
  return true;
end;
$$;

-- 4.9 성공 뒤 일정: 이 회차가 맡은 칸이 아직 키워드의 현재 칸이고 다른 회차가 임대 중이 아니면 다음 칸으로.
create or replace function public.coupang_rank_reschedule_success(p_keyword_key text, p_run_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.coupang_rank_keywords%rowtype;
  r public.coupang_rank_runs%rowtype;
  p record;
  v_now timestamptz := now();
begin
  select * into r from public.coupang_rank_runs where id = p_run_id;
  select * into k from public.coupang_rank_keywords where keyword_key = p_keyword_key for update;
  if not found then return false; end if;
  update public.coupang_rank_keywords set
    lease_run_id = case when lease_run_id = p_run_id then null else lease_run_id end,
    lease_until = case when lease_run_id = p_run_id then null else lease_until end,
    last_success_at = greatest(coalesce(last_success_at, r.claimed_at), r.claimed_at),
    last_status = p_status,
    consecutive_failures = 0,
    consecutive_unsupported = 0
  where keyword_key = p_keyword_key;
  if k.slot_day is not distinct from r.slot_day and k.slot_index is not distinct from r.slot_index
     and (k.lease_run_id is null or k.lease_run_id = p_run_id) then
    select * into p from public.coupang_rank_plan_next(
      p_keyword_key, greatest(coalesce(k.slot_ends_at, v_now), v_now), false);
    update public.coupang_rank_keywords
       set next_due_at = greatest(p.due_at, v_now), slot_day = p.slot_day, slot_index = p.slot_index,
           slot_ends_at = p.slot_ends_at, slot_attempts = 0
     where keyword_key = p_keyword_key;
  end if;
  return true;
end;
$$;

-- 4.10 키워드 한도(D2: 쿠팡 전용, 계정 기본 20·전체 고유 키워드 150). 수집 대상인 활성 추적기만 센다(H2).
-- 잠금 이름 공간은 다른 순위 기능과 다르다.
create or replace function public.coupang_rank_tracker_limit_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_count integer;
  v_global integer;
  v_keys integer;
begin
  if new.status <> 'active' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' and old.agency_code = new.agency_code
     and old.keyword_key = new.keyword_key then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('coupang_rank_limit:' || new.agency_code));
  select coalesce(
    (select l.keyword_limit::integer from public.coupang_rank_account_limits l where l.agency_code = new.agency_code),
    (select s.default_account_limit::integer from public.coupang_rank_settings s where s.id = 1),
    20) into v_limit;
  select count(*) into v_count from public.coupang_rank_trackers t
   where t.agency_code = new.agency_code and t.status = 'active' and t.id <> new.id
     and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code);
  if v_count >= v_limit then
    raise exception using errcode = 'P0001', message = 'COUPANG_KEYWORD_LIMIT_REACHED',
      detail = v_limit::text, hint = v_count::text;
  end if;
  if not exists (select 1 from public.coupang_rank_trackers t
                  where t.keyword_key = new.keyword_key and t.status = 'active' and t.id <> new.id
                    and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code)) then
    perform pg_advisory_xact_lock(hashtext('coupang_rank_limit:global'));
    select coalesce((select s.global_keyword_limit::integer from public.coupang_rank_settings s where s.id = 1), 150)
      into v_global;
    select count(distinct t.keyword_key) into v_keys from public.coupang_rank_trackers t
     where t.status = 'active' and t.id <> new.id
       and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code);
    if v_keys >= v_global then
      raise exception using errcode = 'P0001', message = 'COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED',
        detail = v_global::text, hint = v_keys::text;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_coupang_rank_tracker_limit on public.coupang_rank_trackers;
create trigger trg_coupang_rank_tracker_limit
  before insert or update of status, agency_code, keyword_key on public.coupang_rank_trackers
  for each row execute function public.coupang_rank_tracker_limit_guard();

create or replace function public.coupang_rank_limit_status(p_agency_code text, p_keyword_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'limit', coalesce(
      (select l.keyword_limit::integer from public.coupang_rank_account_limits l where l.agency_code = p_agency_code),
      (select s.default_account_limit::integer from public.coupang_rank_settings s where s.id = 1),
      20),
    'used', (select count(*) from public.coupang_rank_trackers t
              where t.agency_code = p_agency_code and t.status = 'active'
                and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code)),
    'globalLimit', coalesce((select s.global_keyword_limit::integer from public.coupang_rank_settings s where s.id = 1), 150),
    'globalUsed', (select count(distinct t.keyword_key) from public.coupang_rank_trackers t
                    where t.status = 'active' and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code)),
    'keywordActive', (p_keyword_key is not null and exists (
      select 1 from public.coupang_rank_trackers t
       where t.keyword_key = p_keyword_key and t.status = 'active'
         and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code))));
$$;

-- 4.11 등록·다시 시작 뒤(B5·B8·H6): 오늘(KST) 성공 회차가 있으면 바로 적용.
-- 한 번도 잰 적 없는 키워드(last_run_at 없음)만 지금 칸으로 당긴다 — 실패 뒤 미룸(20분·다음 날·7일)을 건너뛰지 않는다.
-- 잠금 순서는 record·claim 과 같은 추적기 → 키워드다: 추적기를 잡는 apply_success 를 키워드 행보다 먼저 부른다(교착 없음).
create or replace function public.coupang_rank_after_activate(p_tracker_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.coupang_rank_trackers%rowtype;
  k public.coupang_rank_keywords%rowtype;
  p record;
  v_run uuid;
  v_applied boolean := false;
begin
  select * into t from public.coupang_rank_trackers where id = p_tracker_id;
  if not found or t.status <> 'active' then
    return jsonb_build_object('firstCheck', 'none', 'nextDueAt', null);
  end if;
  select r.id into v_run from public.coupang_rank_runs r
   where r.keyword_key = t.keyword_key and r.status in ('ok', 'noresult')
     and (r.claimed_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
   order by r.claimed_at desc
   limit 1;
  if v_run is not null then
    v_applied := public.coupang_rank_apply_success(v_run, t.id, null, null);
  end if;
  insert into public.coupang_rank_keywords (keyword_key, search_text, next_due_at)
  values (t.keyword_key, t.keyword, now())
  on conflict (keyword_key) do nothing;
  select * into k from public.coupang_rank_keywords where keyword_key = t.keyword_key for update;
  if k.last_run_at is null and k.lease_run_id is null then
    select * into p from public.coupang_rank_plan_next(k.keyword_key, now(), true);
    update public.coupang_rank_keywords
       set next_due_at = p.due_at, slot_day = p.slot_day, slot_index = p.slot_index,
           slot_ends_at = p.slot_ends_at, slot_attempts = 0
     where keyword_key = k.keyword_key;
    k.next_due_at := p.due_at;
  end if;
  return jsonb_build_object('firstCheck', case when v_applied then 'recorded' else 'queued' end,
                            'nextDueAt', k.next_due_at);
end;
$$;

-- 4.12 일정 다시 짜기(설정의 하루 횟수·수집 시간대가 바뀐 뒤). 실패로 미뤄 둔 키워드는 미룬 시각 뒤에서 다시 짠다(H6).
create or replace function public.coupang_rank_replan_all()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.coupang_rank_keywords kk
     set (next_due_at, slot_day, slot_index, slot_ends_at, slot_attempts) =
         (select p.due_at, p.slot_day, p.slot_index, p.slot_ends_at, 0::smallint
            from public.coupang_rank_plan_next(
              kk.keyword_key,
              case when kk.consecutive_failures > 0 or kk.consecutive_unsupported > 0
                   then greatest(now(), kk.next_due_at) else now() end,
              kk.last_run_at is null) p)
   where kk.lease_run_id is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 4.13 임대(서버가 속도를 강제한다). 잠금 순서: 수집기 행 → 설정 행 → 회차 → 추적기 → 키워드.
-- record·release 도 설정 행을 회차·키워드보다 먼저 잠근다(교착 없음). 수집기 행은 claim 만 잠근다.
-- 추적기(apply_success 의 for update, mark_failed 의 외래키 확인)는 늘 키워드보다 먼저다. after_activate 도 같다.
create or replace function public.coupang_rank_claim(p_collector_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.coupang_rank_settings%rowtype;
  k public.coupang_rank_keywords%rowtype;
  x record;
  v_now timestamptz := now();
  v_local timestamp;
  v_hour integer;
  v_hour_count integer;
  v_oldest timestamptz;
  v_day_count integer;
  v_next timestamptz;
  v_run uuid;
  v_lease timestamptz;
  v_window_start timestamptz;
  v_minute smallint;
  v_reply jsonb;
  v_last_at timestamptz;
  v_last_reply jsonb;
  v_last_retry integer;
begin
  -- (0) 호출 빈도 조절(M9): 기다리라고 답한 뒤 그 시간(최대 20초)보다 일찍 다시 오면 무거운 처리 없이 같은 답을 준다.
  select c.last_claim_at, c.last_claim_reply into v_last_at, v_last_reply
    from public.coupang_rank_collectors c where c.id = p_collector_id for update;
  v_last_retry := greatest(1, coalesce((v_last_reply ->> 'retryAfterSec')::integer, 20));
  if v_last_at is not null and v_last_reply ->> 'state' = 'wait'
     and v_now < v_last_at + make_interval(secs => least(20, v_last_retry) - 1) then
    return v_last_reply || jsonb_build_object('throttled', true, 'retryAfterSec',
      greatest(1, ceil(extract(epoch from (v_last_at + make_interval(secs => v_last_retry) - v_now)))::integer));
  end if;

  <<gate>>
  begin
    select * into s from public.coupang_rank_settings where id = 1 for update;
    if not found then
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'disabled', 'retryAfterSec', 600);
      exit gate;
    end if;

    -- (1) 결과 보고 없이 끝난 임대(A8): 실패로 세고 20분 뒤(또는 다음 칸)로 미룬다. 연속 오류에 넣는다(P3).
    for x in
      select r.id, r.keyword_key from public.coupang_rank_runs r
       where r.status = 'leased' and r.lease_until < v_now
       order by r.claimed_at
       limit 20
       for update
    loop
      update public.coupang_rank_runs
         set status = 'expired', completed_at = v_now, error_code = coalesce(error_code, 'lease_expired')
       where id = x.id;
      perform public.coupang_rank_mark_failed(x.id, 'failed');
      perform public.coupang_rank_reschedule_failure(x.keyword_key, x.id, 'expired');
      perform public.coupang_rank_note_error(x.id);
    end loop;
    select * into s from public.coupang_rank_settings where id = 1;

    -- (2) 키워드 행 보충과 재계획(활성 추적기가 있는 키워드만): 지난 칸, 그리고 지금 하루 횟수에 없는 칸 번호.
    -- replan_all 은 임대 중 키워드를 건너뛰므로, 하루 횟수를 내린 뒤 그 임대가 실패·만료·차단으로 끝나면
    -- 옛 칸 번호가 남는다(그대로 쓰면 slot_minute 가 0~1439 를 넘는다). 칸이 아직 열린 채 번호만 틀린 키워드는
    -- replan_all 과 같이 실패로 미룬 시각 뒤에서 계획한다(H6).
    insert into public.coupang_rank_keywords (keyword_key, search_text, next_due_at)
    select distinct on (t.keyword_key) t.keyword_key, t.keyword, v_now
      from public.coupang_rank_trackers t
     where t.status = 'active'
       and not exists (select 1 from public.coupang_rank_keywords k2 where k2.keyword_key = t.keyword_key)
     order by t.keyword_key, t.created_at
    on conflict (keyword_key) do nothing;
    update public.coupang_rank_keywords kk
       set (next_due_at, slot_day, slot_index, slot_ends_at, slot_attempts) =
           (select p.due_at, p.slot_day, p.slot_index, p.slot_ends_at, 0::smallint
              from public.coupang_rank_plan_next(
                kk.keyword_key,
                case when kk.slot_ends_at > v_now and (kk.consecutive_failures > 0 or kk.consecutive_unsupported > 0)
                     then greatest(v_now, kk.next_due_at) else v_now end,
                kk.last_run_at is null) p)
     where kk.lease_run_id is null
       and (kk.slot_ends_at is null or kk.slot_ends_at <= v_now or kk.slot_index >= s.checks_per_day)
       and exists (select 1 from public.coupang_rank_trackers t
                    where t.keyword_key = kk.keyword_key and t.status = 'active');

    -- (3) 관문: 꺼짐 → 대표 확인 → 예산 → 쉬기 → 시간대 → 간격 → 시간당 → 하루
    if not s.enabled then
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'disabled', 'retryAfterSec', 600);
      exit gate;
    end if;
    if s.needs_owner_review then
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'review', 'retryAfterSec', 1800);
      exit gate;
    end if;
    if s.budget_blocked then
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'budget', 'retryAfterSec', 3600);
      exit gate;
    end if;
    if s.cooldown_until is not null and s.cooldown_until > v_now then
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'cooldown', 'cooldownUntil', s.cooldown_until,
        'retryAfterSec', least(3600, greatest(30, ceil(extract(epoch from (s.cooldown_until - v_now)))::integer)));
      exit gate;
    end if;
    v_local := v_now at time zone 'Asia/Seoul';
    v_hour := extract(hour from v_local)::integer;
    if v_hour < s.active_from_hour or v_hour >= s.active_to_hour then
      v_window_start := ((v_local::date + case when v_hour >= s.active_to_hour then 1 else 0 end)
                         + make_interval(hours => s.active_from_hour)) at time zone 'Asia/Seoul';
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'window',
        'retryAfterSec', least(3600, greatest(60, ceil(extract(epoch from (v_window_start - v_now)))::integer)));
      exit gate;
    end if;
    if s.next_claim_not_before is not null and s.next_claim_not_before > v_now then
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'gap',
        'retryAfterSec', greatest(1, ceil(extract(epoch from (s.next_claim_not_before - v_now)))::integer));
      exit gate;
    end if;
    select count(*), min(r.claimed_at) into v_hour_count, v_oldest
      from public.coupang_rank_runs r
     where r.claimed_at > v_now - interval '1 hour' and r.status <> 'released';
    if v_hour_count >= s.max_runs_per_hour then
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'hourly_cap',
        'retryAfterSec', least(3600, greatest(30, ceil(extract(epoch from (v_oldest + interval '1 hour' - v_now)))::integer)));
      exit gate;
    end if;
    select count(*) into v_day_count
      from public.coupang_rank_runs r
     where r.claimed_at >= (v_local::date)::timestamp at time zone 'Asia/Seoul' and r.status <> 'released';
    if v_day_count >= s.max_runs_per_day then
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'daily_cap', 'retryAfterSec', 3600);
      exit gate;
    end if;

    -- (4) 키워드 하나 고르기: 예정 시각이 지났고, 임대가 없고, 칸이 열려 있고(지금 하루 횟수에 있는 칸),
    -- 대상 추적기가 있는 것. 여러 개면 가장 오래 못 잰 것부터(H1: 용량이 모자랄 때 같은 키워드만 매일 빠지지 않게).
    select kk.* into k
      from public.coupang_rank_keywords kk
     where kk.next_due_at <= v_now
       and kk.lease_run_id is null
       and kk.slot_ends_at is not null and kk.slot_ends_at > v_now
       and coalesce(kk.slot_index, 0) < s.checks_per_day
       and exists (select 1 from public.coupang_rank_trackers t
                    where t.keyword_key = kk.keyword_key and t.status = 'active'
                      and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code))
     order by coalesce(kk.last_success_at, '-infinity'::timestamptz), kk.next_due_at, kk.keyword_key
     limit 1
     for update of kk skip locked;
    if not found then
      select min(kk.next_due_at) into v_next
        from public.coupang_rank_keywords kk
       where kk.lease_run_id is null
         and exists (select 1 from public.coupang_rank_trackers t
                      where t.keyword_key = kk.keyword_key and t.status = 'active'
                        and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code));
      v_reply := jsonb_build_object('state', 'wait', 'reason', 'idle',
        'retryAfterSec', case when v_next is null then 600
                              else least(600, greatest(60, ceil(extract(epoch from (v_next - v_now)))::integer)) end);
      exit gate;
    end if;

    -- (5) 회차 만들기 + 키워드 임대 + 다음 임대 허용 시각(최소 간격 + 흔들기)
    v_lease := v_now + interval '180 seconds';
    v_minute := (s.active_from_hour * 60
                 + floor((s.active_to_hour - s.active_from_hour) * 60.0 * coalesce(k.slot_index, 0) / s.checks_per_day))::smallint;
    insert into public.coupang_rank_runs (
      keyword_key, collector_id, slot_day, slot_index, slot_minute, claimed_at, lease_until)
    values (k.keyword_key, p_collector_id, k.slot_day, k.slot_index, v_minute, v_now, v_lease)
    returning id into v_run;
    update public.coupang_rank_keywords
       set lease_run_id = v_run, lease_until = v_lease, last_run_at = v_now, slot_attempts = slot_attempts + 1
     where keyword_key = k.keyword_key;
    update public.coupang_rank_settings
       set last_claim_at = v_now,
           next_claim_not_before = v_now + make_interval(secs => s.min_gap_seconds + floor(random() * (s.gap_jitter_seconds + 1)))
     where id = 1;
    v_reply := jsonb_build_object('state', 'job', 'runId', v_run, 'keyword', k.search_text, 'keywordKey', k.keyword_key,
      'leaseUntil', v_lease, 'windowMode', s.window_mode, 'slotDay', k.slot_day, 'slotIndex', k.slot_index);
  end gate;

  update public.coupang_rank_collectors
     set last_claim_at = v_now,
         last_claim_reply = jsonb_build_object('state', v_reply ->> 'state', 'reason', v_reply ->> 'reason',
                                               'retryAfterSec', (v_reply ->> 'retryAfterSec')::integer)
   where id = p_collector_id;
  return v_reply;
end;
$$;

-- 4.14 결과 보고(멱등: 회차 id). 분류(p_status)는 서버 JS 가 정하고, 맞추기·저장·쉬기는 여기서 한 트랜잭션으로 한다.
create or replace function public.coupang_rank_record(
  p_run_id uuid, p_collector_id uuid, p_keyword_key text, p_status text, p_run jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.coupang_rank_settings%rowtype;
  r public.coupang_rank_runs%rowtype;
  t record;
  v_now timestamptz := now();
  v_late boolean;
  v_success boolean;
  v_matched integer := 0;
  v_stop boolean := false;
  v_cool jsonb := null;
  v_organic jsonb;
  v_ads jsonb;
begin
  if p_status is null or p_status not in ('ok', 'noresult', 'partial', 'blocked', 'empty', 'error', 'timeout', 'unsupported') then
    return jsonb_build_object('ok', false, 'code', 'RUN_STATUS_INVALID');
  end if;
  select * into s from public.coupang_rank_settings where id = 1 for update;
  select * into r from public.coupang_rank_runs where id = p_run_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'JOB_NOT_FOUND'); end if;
  if r.collector_id is distinct from p_collector_id then
    return jsonb_build_object('ok', false, 'code', 'JOB_LEASE_MISMATCH');
  end if;
  if r.keyword_key is distinct from p_keyword_key then
    return jsonb_build_object('ok', false, 'code', 'JOB_KEYWORD_MISMATCH');
  end if;
  if r.status not in ('leased', 'expired') then
    return jsonb_build_object('ok', true, 'accepted', false, 'duplicate', true, 'status', r.status,
      'matched', coalesce(r.matched_count, 0), 'stop', false);
  end if;
  if r.claimed_at < v_now - interval '30 minutes' then
    return jsonb_build_object('ok', false, 'code', 'JOB_TOO_OLD');
  end if;

  v_late := r.status = 'expired';
  v_success := p_status in ('ok', 'noresult');
  v_organic := case when jsonb_typeof(p_run -> 'organic') = 'array' then p_run -> 'organic' else '[]'::jsonb end;
  v_ads := case when jsonb_typeof(p_run -> 'ads') = 'array' then p_run -> 'ads' else '[]'::jsonb end;

  update public.coupang_rank_runs set
    status = p_status,
    completed_at = v_now,
    late = v_late,
    http_status = (p_run ->> 'httpStatus')::smallint,
    login_wall = (p_run ->> 'loginWall')::boolean,
    stable = (p_run ->> 'stable')::boolean,
    item_count = (p_run ->> 'itemCount')::smallint,
    organic_count = jsonb_array_length(v_organic),
    ad_count = jsonb_array_length(v_ads),
    organic = (select coalesce(jsonb_agg(e.item - 't' order by e.ord), '[]'::jsonb)
                 from jsonb_array_elements(v_organic) with ordinality as e(item, ord)),
    ads = (select coalesce(jsonb_agg(e.item - 't' order by e.ord), '[]'::jsonb)
             from jsonb_array_elements(v_ads) with ordinality as e(item, ord)),
    final_host = left(p_run ->> 'finalHost', 60),
    final_path = left(p_run ->> 'finalPath', 80),
    duration_ms = (p_run ->> 'durationMs')::integer,
    collector_version = left(p_run ->> 'collectorVersion', 20),
    browser = left(p_run ->> 'browser', 60),
    error_code = left(p_run ->> 'errorCode', 60)
  where id = r.id;

  if v_success then
    for t in
      select tt.id from public.coupang_rank_trackers tt
       where tt.keyword_key = r.keyword_key and tt.status = 'active'
       order by tt.id
    loop
      if public.coupang_rank_apply_success(r.id, t.id, v_organic, v_ads) then
        v_matched := v_matched + 1;
      end if;
    end loop;
    perform public.coupang_rank_reschedule_success(r.keyword_key, r.id, p_status);
    if s.error_streak <> 0 or s.empty_streak <> 0 then
      update public.coupang_rank_settings set error_streak = 0, empty_streak = 0 where id = 1;
    end if;
  else
    -- 늦게 온 실패(만료 뒤)는 임대 정리 때 이미 실패 1회·연속 오류 1회로 셌다.
    if not v_late then
      perform public.coupang_rank_mark_failed(r.id, case when p_status = 'unsupported' then 'unsupported' else 'failed' end);
    end if;
    perform public.coupang_rank_reschedule_failure(r.keyword_key, r.id, p_status);
    if p_status = 'blocked' then
      v_cool := public.coupang_rank_apply_cooldown('blocked', r.id);
      v_stop := true;
    elsif p_status = 'empty' then
      if s.empty_streak + 1 >= 2 then
        if exists (select 1 from public.coupang_rank_cooldowns c
                    where c.reason = 'empty' and c.started_at > v_now - interval '24 hours') then
          v_cool := public.coupang_rank_apply_cooldown('empty_escalated', r.id);
        else
          v_cool := public.coupang_rank_apply_cooldown('empty', r.id);
        end if;
        update public.coupang_rank_settings set empty_streak = 0 where id = 1;
      else
        update public.coupang_rank_settings set empty_streak = empty_streak + 1 where id = 1;
      end if;
      v_stop := true;
    elsif p_status in ('error', 'timeout') and not v_late then
      v_cool := public.coupang_rank_note_error(r.id);
      v_stop := v_cool is not null;
    end if;
  end if;

  update public.coupang_rank_runs set matched_count = v_matched where id = r.id;
  select * into s from public.coupang_rank_settings where id = 1;
  v_stop := v_stop or not s.enabled or s.needs_owner_review or s.budget_blocked
            or (s.cooldown_until is not null and s.cooldown_until > v_now);
  return jsonb_build_object('ok', true, 'accepted', true, 'duplicate', false, 'late', v_late, 'status', p_status,
    'matched', v_matched, 'stop', v_stop, 'cooldownUntil', s.cooldown_until, 'reviewRequired', s.needs_owner_review);
end;
$$;

-- 4.15 측정하지 않고 임대만 반납(브라우저를 띄우기 전에만). 속도 상한에 세지 않는다.
create or replace function public.coupang_rank_release(p_run_id uuid, p_collector_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.coupang_rank_runs%rowtype;
begin
  if p_reason is null or p_reason not in ('guard', 'shutdown', 'budget') then
    return jsonb_build_object('ok', false, 'code', 'RELEASE_REASON_INVALID');
  end if;
  perform 1 from public.coupang_rank_settings where id = 1 for update;
  select * into r from public.coupang_rank_runs where id = p_run_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'JOB_NOT_FOUND'); end if;
  if r.collector_id is distinct from p_collector_id then
    return jsonb_build_object('ok', false, 'code', 'JOB_LEASE_MISMATCH');
  end if;
  if r.status <> 'leased' then
    return jsonb_build_object('ok', true, 'released', false, 'status', r.status);
  end if;
  update public.coupang_rank_runs
     set status = 'released', completed_at = now(), error_code = 'released_' || p_reason
   where id = r.id;
  update public.coupang_rank_keywords
     set lease_run_id = null, lease_until = null, slot_attempts = greatest(slot_attempts - 1, 0)
   where keyword_key = r.keyword_key and lease_run_id = r.id;
  return jsonb_build_object('ok', true, 'released', true);
end;
$$;

-- 4.16 정리와 예산(B10·B11): 임대 트랜잭션 밖에서(수집기 hello 때 6시간에 한 번) 표마다 500줄씩 지운다.
create or replace function public.coupang_rank_housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snap integer := 0;
  v_days integer := 0;
  v_runs integer := 0;
  v_cool integer := 0;
  v_kw integer := 0;
  v_coupang bigint := 0;
  v_db bigint := 0;
  s public.coupang_rank_settings%rowtype;
begin
  delete from public.coupang_rank_snapshots
   where id in (select x.id from public.coupang_rank_snapshots x
                 where x.created_at < now() - interval '60 days' limit 500);
  get diagnostics v_snap = row_count;
  delete from public.coupang_rank_days
   where (tracker_id, kst_day, slot_minute) in (
     select x.tracker_id, x.kst_day, x.slot_minute from public.coupang_rank_days x
      where x.kst_day < (now() at time zone 'Asia/Seoul')::date - 60 limit 500);
  get diagnostics v_days = row_count;
  delete from public.coupang_rank_runs
   where id in (select x.id from public.coupang_rank_runs x
                 where x.claimed_at < now() - interval '14 days' and x.status <> 'leased' limit 500);
  get diagnostics v_runs = row_count;
  delete from public.coupang_rank_cooldowns
   where id in (select x.id from public.coupang_rank_cooldowns x
                 where x.started_at < now() - interval '90 days' limit 500);
  get diagnostics v_cool = row_count;
  delete from public.coupang_rank_keywords
   where keyword_key in (
     select x.keyword_key from public.coupang_rank_keywords x
      where x.lease_run_id is null and x.updated_at < now() - interval '40 days'
        and not exists (select 1 from public.coupang_rank_trackers t
                         where t.keyword_key = x.keyword_key and t.status = 'active')
      limit 500);
  get diagnostics v_kw = row_count;

  select coalesce(sum(pg_catalog.pg_total_relation_size(c.oid)), 0) into v_coupang
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'coupang\_rank\_%';
  v_db := pg_catalog.pg_database_size(current_database());

  select * into s from public.coupang_rank_settings where id = 1 for update;
  if v_coupang > s.max_storage_mb::bigint * 1024 * 1024 then
    update public.coupang_rank_settings set budget_blocked = true, budget_reason = 'storage', last_housekeeping_at = now() where id = 1;
  elsif v_db > s.db_size_stop_mb::bigint * 1024 * 1024 then
    update public.coupang_rank_settings set budget_blocked = true, budget_reason = 'database', last_housekeeping_at = now() where id = 1;
  else
    update public.coupang_rank_settings set last_housekeeping_at = now() where id = 1;
  end if;
  return jsonb_build_object('snapshots', v_snap, 'days', v_days, 'runs', v_runs, 'cooldowns', v_cool,
    'keywords', v_kw, 'coupangBytes', v_coupang, 'databaseBytes', v_db);
end;
$$;

-- 4.17 총관리자 패널용 집계
create or replace function public.coupang_rank_stats()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with r24 as (
    select r.status, r.duration_ms, r.error_code, r.claimed_at
      from public.coupang_rank_runs r where r.claimed_at > now() - interval '24 hours'
  ), r48 as (
    select r.status from public.coupang_rank_runs r where r.claimed_at > now() - interval '48 hours'
  ), act as (
    select t.keyword_key, public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code) as eligible
      from public.coupang_rank_trackers t where t.status = 'active'
  )
  select jsonb_build_object(
    'runs24h', (select coalesce(jsonb_object_agg(q.status, q.n), '{}'::jsonb)
                  from (select status, count(*) as n from r24 group by status) q),
    'avgDurationMs24h', (select round(avg(duration_ms)) from r24 where status in ('ok', 'noresult')),
    'lastErrorCode', (select error_code from r24 where error_code is not null order by claimed_at desc limit 1),
    'lastRunAt', (select max(r.claimed_at) from public.coupang_rank_runs r),
    'lastSuccessAt', (select max(r.claimed_at) from public.coupang_rank_runs r where r.status in ('ok', 'noresult')),
    'runsLastHour', (select count(*) from public.coupang_rank_runs r
                      where r.claimed_at > now() - interval '1 hour' and r.status <> 'released'),
    'runsToday', (select count(*) from public.coupang_rank_runs r
                   where r.claimed_at >= ((now() at time zone 'Asia/Seoul')::date)::timestamp at time zone 'Asia/Seoul'
                     and r.status <> 'released'),
    'blocked48h', (select count(*) from r48 where status = 'blocked'),
    'empty48h', (select count(*) from r48 where status = 'empty'),
    'success48h', (select count(*) from r48 where status in ('ok', 'noresult')),
    'blockCooldowns7d', (select count(*) from public.coupang_rank_cooldowns c
                          where c.reason in ('blocked', 'empty_escalated', 'error_escalated')
                            and c.started_at > now() - interval '7 days'),
    'activeKeywords', (select count(distinct keyword_key) from act where eligible),
    'ineligibleActiveTrackers', (select count(*) from act where not eligible),
    'overdueKeywords', (select count(*) from public.coupang_rank_keywords k
                         where k.lease_run_id is null and k.next_due_at < now() - interval '60 minutes'
                           and k.slot_ends_at > now()
                           and exists (select 1 from act a where a.keyword_key = k.keyword_key and a.eligible)),
    'recentCooldowns', (select coalesce(jsonb_agg(jsonb_build_object('startedAt', c.started_at, 'endsAt', c.ends_at,
                          'reason', c.reason, 'level', c.level, 'clearedAt', c.cleared_at) order by c.started_at desc), '[]'::jsonb)
                          from (select * from public.coupang_rank_cooldowns order by started_at desc limit 10) c),
    'storage', jsonb_build_object(
      'coupangBytes', (select coalesce(sum(pg_catalog.pg_total_relation_size(c.oid)), 0)
                         from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'coupang\_rank\_%'),
      'databaseBytes', pg_catalog.pg_database_size(current_database())));
$$;

-- ───────────────────────── 5. 함수 실행 권한(service_role 전용) ─────────────────────────

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'coupang\_rank\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

commit;
