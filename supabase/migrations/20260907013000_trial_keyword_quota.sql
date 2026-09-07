-- 체험 계정 키워드 조회 쿼터(2026-09-07 대표 승인): 구글 가입 체험 계정의 하루 조회 횟수를 센다.
-- 순위 수집·추적 표와 무관한 독립 표. 서비스 롤(서버 세션 게이트)만 접근한다.
-- 사양: docs/drafts/trial-account-google-signup-spec.md §1, §3

create table if not exists public.trial_keyword_quota (
  google_sub text not null,
  day date not null,
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (google_sub, day)
);

alter table public.trial_keyword_quota enable row level security;
revoke all on table public.trial_keyword_quota from public, anon, authenticated;
grant select, insert, update, delete on table public.trial_keyword_quota to service_role;

comment on table public.trial_keyword_quota is
  '체험(구글 가입) 계정의 날짜별 키워드 조회 횟수. 하루 기준은 Asia/Seoul. 서버 세션 게이트가 mi_trial_keyword_consume 로만 갱신한다.';

-- 원자적으로 1회 소비한다. 한도에 닿았으면 allowed=false 와 현재 사용량을 돌려준다.
create or replace function public.mi_trial_keyword_consume(p_sub text, p_limit integer)
returns table(allowed boolean, used_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_used integer;
begin
  if p_sub is null or length(trim(p_sub)) = 0 then
    return query select false, 0;
    return;
  end if;

  insert into public.trial_keyword_quota (google_sub, day, used)
  values (p_sub, v_day, 0)
  on conflict (google_sub, day) do nothing;

  select q.used into v_used
  from public.trial_keyword_quota q
  where q.google_sub = p_sub and q.day = v_day
  for update;

  if v_used >= coalesce(p_limit, 5) then
    return query select false, v_used;
    return;
  end if;

  update public.trial_keyword_quota q
  set used = q.used + 1, updated_at = now()
  where q.google_sub = p_sub and q.day = v_day
  returning q.used into v_used;

  return query select true, v_used;
end;
$$;

revoke all on function public.mi_trial_keyword_consume(text, integer) from public, anon, authenticated;
grant execute on function public.mi_trial_keyword_consume(text, integer) to service_role;
