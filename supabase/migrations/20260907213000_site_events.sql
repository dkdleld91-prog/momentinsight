-- 오늘 현황(대표 지시 2026-09-07 "총관리자 화면에 오늘 방문 n명 · 가입 n명"): 공개 페이지 방문(고유 방문자)·가입 클릭·
-- 문의 클릭·로그인 계정을 날짜별로 센다. 구글 애널리틱스와 별개로 우리 표에 남겨 총관리자 화면에서 바로 본다.
-- 개인 식별 정보는 넣지 않는다: visitor 는 서버가 (일별 소금 + IP + 브라우저)로 만든 해시, 로그인은 (역할 + 코드) 해시.
-- 순위 수집·추적 표와 무관한 독립 표. 서비스 롤(서버)만 접근한다.

create table if not exists public.site_events (
  day date not null,
  event text not null,
  path text not null default '/',
  visitor text not null,
  created_at timestamptz not null default now(),
  primary key (day, event, path, visitor)
);

alter table public.site_events enable row level security;
revoke all on table public.site_events from public, anon, authenticated;
grant select, insert, delete on table public.site_events to service_role;

comment on table public.site_events is
  '날짜별 방문·클릭·로그인 집계 원천. event = view | signup_click | inquiry_click | login. 하루 기준 Asia/Seoul. 같은 (day, event, path, visitor)는 한 번만 남는다.';

-- 한 건 기록. 같은 방문자의 같은 날 같은 경로 같은 이벤트는 한 번만 센다(고유 방문자 집계).
create or replace function public.mi_site_event_record(p_day date, p_event text, p_path text, p_visitor text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.site_events (day, event, path, visitor)
  values (p_day, p_event, coalesce(nullif(p_path, ''), '/'), p_visitor)
  on conflict do nothing;
$$;

revoke all on function public.mi_site_event_record(date, text, text, text) from public, anon, authenticated;
grant execute on function public.mi_site_event_record(date, text, text, text) to service_role;

-- 하루 요약. visitors = 고유 방문자(경로 무관), views = 고유 (방문자, 경로) 조합 수.
create or replace function public.mi_site_event_summary(p_day date)
returns json
language sql
security definer
stable
set search_path = public
as $$
  select json_build_object(
    'visitors', (select count(distinct visitor) from public.site_events where day = p_day and event = 'view'),
    'views', (select count(*) from public.site_events where day = p_day and event = 'view'),
    'signup_clicks', (select count(distinct visitor) from public.site_events where day = p_day and event = 'signup_click'),
    'inquiry_clicks', (select count(distinct visitor) from public.site_events where day = p_day and event = 'inquiry_click'),
    'logins', (select count(distinct visitor) from public.site_events where day = p_day and event = 'login')
  );
$$;

revoke all on function public.mi_site_event_summary(date) from public, anon, authenticated;
grant execute on function public.mi_site_event_summary(date) to service_role;

-- 오래된 행 정리(기본 120일). 총관리자 화면이 요약을 읽을 때 서버가 하루 한 번쯤 부른다.
create or replace function public.mi_site_event_prune(p_keep_days integer default 120)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.site_events
  where day < ((now() at time zone 'Asia/Seoul')::date - greatest(coalesce(p_keep_days, 120), 7));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.mi_site_event_prune(integer) from public, anon, authenticated;
grant execute on function public.mi_site_event_prune(integer) to service_role;
