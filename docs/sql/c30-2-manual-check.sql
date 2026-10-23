-- C 30일 순위 · ① '지금 확인'(사람이 누를 때만, 그 사람 크롬의 새 시크릿 창으로 쿠팡 검색 1번). 명세 spec-manual §5,
-- 2026-10-23 다시 구현(지난 검토 결함 반영): 확장이 창을 열기 직전에 서버 확인(verify)을 받고, 간격·하루 횟수는
-- 그 확인 시각(= 실제 검색 직전, 서버 시계)으로 잰다. 시간 판정은 모두 서버 시계(now())만 쓴다.
-- 앞선 C 원문(20261017090000_coupang_rank_tracking)이 만든 표·함수 위에 칸·표 1개·함수 5개만 더한다.
-- 앞선 함수 18개는 다시 정의하지 않는다(자동 수집 경로·설정 enabled 는 그대로).
-- 다시 실행해도 안전하다(add column if not exists · create table if not exists · create or replace · 조건부 제약).
-- 코드 배포 전후 어느 쪽에 실행해도 된다(manual_enabled 기본값 false).
-- 금지: 다른 순위 기능의 표·함수 이름(잠금 검사 정규식), 함수 본문의 'x.y.z' 버전 문자열·64자리 16진 리터럴.

begin;

-- ───────────────────────── 1. 설정 칸(전역 1행) ─────────────────────────
-- 검색 사이 최소 180초·하루 30번·09~19시는 대표 결정(2026-10-18)이라 제약으로 막는다(더 엄격하게만 바꿀 수 있다).
-- 더 느슨하게 하려면 새 대표 SQL 이 필요하다.

alter table public.coupang_rank_settings
  add column if not exists manual_enabled boolean not null default false,
  add column if not exists manual_min_gap_seconds integer not null default 180
    check (manual_min_gap_seconds between 180 and 3600),
  add column if not exists manual_max_per_day smallint not null default 30
    check (manual_max_per_day between 1 and 30),
  add column if not exists manual_from_hour smallint not null default 9
    check (manual_from_hour between 9 and 18),
  add column if not exists manual_to_hour smallint not null default 19
    check (manual_to_hour between 10 and 19),
  add column if not exists manual_last_claim_at timestamptz null,
  add column if not exists manual_last_search_at timestamptz null,
  add column if not exists manual_stopped_day date null,
  add column if not exists manual_stopped_at timestamptz null,
  add column if not exists manual_stopped_run_id uuid null,
  add column if not exists manual_stopped_code text null
    check (manual_stopped_code is null or manual_stopped_code ~ '^[a-z0-9_]{1,60}$');

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'coupang_rank_settings_manual_hours_chk'
                    and conrelid = 'public.coupang_rank_settings'::regclass) then
    alter table public.coupang_rank_settings
      add constraint coupang_rank_settings_manual_hours_chk check (manual_from_hour < manual_to_hour);
  end if;
end;
$$;

-- ───────────────────────── 2. 회차 출처·누른 사람 ─────────────────────────

alter table public.coupang_rank_runs
  add column if not exists source text not null default 'collector'
    check (source in ('collector', 'manual')),
  add column if not exists requested_by text null
    check (requested_by is null or char_length(requested_by) <= 40);
create index if not exists coupang_rank_runs_manual_idx
  on public.coupang_rank_runs (claimed_at desc) where source = 'manual';

-- ───────────────────────── 3. 1회용 확인 요청 표(60일 보관, 백업 안 함) ─────────────────────────
-- 요청 1건 = 검색 1번 시도. 상태: open(확장 확인 전) → verified(확장이 서버 확인을 받음 = 창을 엶) → recorded(결과 저장).
-- 확인 전에 끝나면 cancelled·expired, 화면이 답을 못 받으면 lost(늦게 온 측정은 10분 안이면 그대로 받는다).
-- 하루 횟수·간격은 verified_at(서버 시계)만 센다: 확장은 서버 확인 없이는 창을 열지 않으므로 그 밖의 요청은 검색이 아니다.
-- 보관은 스냅숏(60일)과 같다: 회차(14일)가 지워진 뒤에도 스냅숏.run_id = 이 표의 run_id 로 수동 기록을 가려낸다.

create table if not exists public.coupang_rank_manual_claims (
  id uuid primary key default gen_random_uuid(),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  tracker_id uuid null references public.coupang_rank_trackers(id) on delete set null,
  keyword_key text not null check (char_length(keyword_key) between 1 and 50),
  search_text text not null check (char_length(search_text) between 1 and 50),
  requested_by text not null check (char_length(requested_by) between 1 and 40),
  requested_role text not null check (requested_role in ('owner', 'team', 'client')),
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz null,
  status text not null default 'open'
    check (status in ('open', 'verified', 'recorded', 'cancelled', 'lost', 'expired')),
  finished_at timestamptz null,
  run_id uuid null,
  outcome_code text null check (outcome_code is null or outcome_code ~ '^[a-z0-9_]{1,60}$'),
  stop_applied boolean not null default false,
  constraint coupang_rank_manual_claims_verified_chk check (status <> 'verified' or verified_at is not null)
);
create index if not exists coupang_rank_manual_claims_claimed_idx
  on public.coupang_rank_manual_claims (claimed_at desc);
create index if not exists coupang_rank_manual_claims_verified_idx
  on public.coupang_rank_manual_claims (verified_at desc) where verified_at is not null;

alter table public.coupang_rank_manual_claims enable row level security;
alter table public.coupang_rank_manual_claims force row level security;
revoke all on table public.coupang_rank_manual_claims from public, anon, authenticated;
grant select, insert, update, delete on table public.coupang_rank_manual_claims to service_role;

-- ───────────────────────── 4. 함수 ─────────────────────────

-- 4.1 지금 상태(화면 버튼·claim·verify 관문이 같은 판정을 쓴다). 판정 순서:
-- 꺼짐 → 저장 용량 → 오늘 중지 → 자동 수집 차단 쉬기 → 시간 밖 → 진행 중 → 하루 상한 → 간격 → 가능.
-- p_exclude_claim: verify 가 자기 요청을 '진행 중'으로 세지 않게 뺀다(화면·claim 은 null).
create or replace function public.coupang_rank_manual_summary(p_exclude_claim uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.coupang_rank_settings%rowtype;
  v_now timestamptz := now();
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_hour integer := extract(hour from (now() at time zone 'Asia/Seoul'))::integer;
  v_used integer := 0;
  v_busy_until timestamptz;
  v_last timestamptz;
  v_next timestamptz;
  v_state text;
begin
  select * into s from public.coupang_rank_settings where id = 1;
  if not found then
    return jsonb_build_object('state', 'setup_required', 'serverTime', v_now);
  end if;
  -- 하루 횟수 = 오늘(KST) 서버 확인을 받은 검색 수.
  select count(*) into v_used from public.coupang_rank_manual_claims c
   where c.verified_at >= (v_today::timestamp at time zone 'Asia/Seoul');
  -- 진행 중 = 확장 확인을 기다리는 요청(만료 전) 또는 검색 중인 요청(확인 뒤 150초 안).
  select max(case when c.status = 'open' then c.expires_at else c.verified_at + interval '150 seconds' end)
    into v_busy_until
    from public.coupang_rank_manual_claims c
   where c.id is distinct from p_exclude_claim
     and ((c.status = 'open' and c.expires_at > v_now)
          or (c.status in ('verified', 'lost') and c.verified_at > v_now - interval '150 seconds'));
  -- 간격은 마지막 실제 검색(수동 확인 시각)과 자동 수집의 마지막 임대 중 늦은 쪽부터 잰다(같은 회선 보호).
  v_last := greatest(s.manual_last_search_at, s.last_claim_at);
  v_next := v_last + make_interval(secs => s.manual_min_gap_seconds);
  v_state := case
    when not s.manual_enabled then 'off'
    when s.budget_blocked then 'budget'
    when s.manual_stopped_day is not distinct from v_today then 'stopped'
    when s.cooldown_until is not null and s.cooldown_until > v_now
         and s.cooldown_reason in ('blocked', 'empty_escalated', 'error_escalated') then 'cooldown'
    when v_hour < s.manual_from_hour or v_hour >= s.manual_to_hour then 'hours'
    when v_busy_until is not null then 'busy'
    when v_used >= s.manual_max_per_day then 'daily_cap'
    when v_next is not null and v_next > v_now then 'gap'
    else 'ready' end;
  return jsonb_build_object(
    'state', v_state,
    'enabled', s.manual_enabled,
    'usedToday', v_used,
    'maxPerDay', s.manual_max_per_day,
    'minGapSeconds', s.manual_min_gap_seconds,
    'fromHour', s.manual_from_hour,
    'toHour', s.manual_to_hour,
    'nextAt', case when v_next is not null and v_next > v_now then v_next else null end,
    'busyUntil', v_busy_until,
    'lastSearchAt', s.manual_last_search_at,
    'stoppedDay', s.manual_stopped_day,
    'stoppedAt', s.manual_stopped_at,
    'stoppedCode', s.manual_stopped_code,
    'cooldownUntil', case when v_state = 'cooldown' then s.cooldown_until else null end,
    'serverTime', v_now);
end;
$$;

-- 4.2 확인 요청 받기(화면이 부름, 1회용, 60초 안에 확장 확인이 와야 한다). 잠금 순서: 설정 행 → 확인 표 → (읽기만) 추적기·키워드.
-- 동시에 여러 명이 눌러도 설정 행에서 한 줄로 서므로 진행 중·하루 상한·간격이 전역으로 지켜진다.
create or replace function public.coupang_rank_manual_claim(
  p_tracker_id uuid, p_agency_code text, p_requested_by text, p_requested_role text, p_token_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.coupang_rank_settings%rowtype;
  t public.coupang_rank_trackers%rowtype;
  v_now timestamptz := now();
  v_summary jsonb;
  v_search text;
  v_claim uuid;
  v_expires timestamptz;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_requested_by is null or char_length(p_requested_by) not between 1 and 40
     or p_requested_role is null or p_requested_role not in ('owner', 'team', 'client') then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_ACTION_INVALID');
  end if;
  select * into s from public.coupang_rank_settings where id = 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_SETUP_REQUIRED');
  end if;

  -- 끝나지 않은 요청 정리: 확인 없이 기한이 지난 것은 expired(no_verify), 확인 뒤 10분 안에 결과가 없던 것은
  -- expired(no_record). 60일 지난 줄은 500줄씩 지운다.
  update public.coupang_rank_manual_claims
     set status = 'expired', finished_at = v_now, outcome_code = coalesce(outcome_code, 'no_verify')
   where status = 'open' and expires_at <= v_now;
  update public.coupang_rank_manual_claims
     set status = 'expired', finished_at = v_now, outcome_code = coalesce(outcome_code, 'no_record')
   where status = 'verified' and claimed_at <= v_now - interval '10 minutes';
  delete from public.coupang_rank_manual_claims
   where id in (select x.id from public.coupang_rank_manual_claims x
                 where x.claimed_at < v_now - interval '60 days' limit 500);

  select * into t from public.coupang_rank_trackers
   where id = p_tracker_id and agency_code = p_agency_code;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_TRACKER_NOT_FOUND');
  end if;
  if t.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_TRACKER_PAUSED');
  end if;
  if not public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code) then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_TRACKER_INELIGIBLE');
  end if;

  v_summary := public.coupang_rank_manual_summary(null);
  if v_summary ->> 'state' <> 'ready' then
    return jsonb_build_object('ok', false, 'state', v_summary ->> 'state', 'manual', v_summary);
  end if;

  select k.search_text into v_search from public.coupang_rank_keywords k where k.keyword_key = t.keyword_key;
  v_search := coalesce(v_search, t.keyword);
  v_expires := v_now + interval '60 seconds';
  insert into public.coupang_rank_manual_claims (
    token_sha256, tracker_id, keyword_key, search_text, requested_by, requested_role, claimed_at, expires_at)
  values (p_token_sha256, t.id, t.keyword_key, v_search, p_requested_by, p_requested_role, v_now, v_expires)
  returning id into v_claim;
  update public.coupang_rank_settings set manual_last_claim_at = v_now where id = 1;
  return jsonb_build_object('ok', true, 'claimId', v_claim, 'keyword', v_search, 'keywordKey', t.keyword_key,
    'expiresAt', v_expires, 'serverTime', v_now, 'manual', public.coupang_rank_manual_summary(null));
end;
$$;

-- 4.3 확장 확인(확장이 창을 열기 직전에 부름, 1회용). 서버 시계로 관문을 다시 보고, 통과하면 이 시각을
-- '실제 검색 시각'으로 적는다(간격·하루 횟수의 기준). 확장은 여기서 받은 검색어로만 창을 연다.
-- 잠금 순서: 설정 행 → 확인 표 → (읽기만) 추적기.
create or replace function public.coupang_rank_manual_verify(
  p_claim_id uuid, p_token_sha256 text, p_requested_by text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.coupang_rank_settings%rowtype;
  c public.coupang_rank_manual_claims%rowtype;
  v_now timestamptz := now();
  v_summary jsonb;
  v_state text;
begin
  if p_claim_id is null or p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$'
     or p_requested_by is null or char_length(p_requested_by) not between 1 and 40 then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_ACTION_INVALID');
  end if;
  select * into s from public.coupang_rank_settings where id = 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_SETUP_REQUIRED');
  end if;
  select * into c from public.coupang_rank_manual_claims where id = p_claim_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_NOT_FOUND');
  end if;
  if c.token_sha256 is distinct from p_token_sha256 or c.requested_by is distinct from p_requested_by then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_MISMATCH');
  end if;
  if c.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', case
      when c.verified_at is not null then 'COUPANG_MANUAL_CLAIM_USED'
      when c.status = 'expired' then 'COUPANG_MANUAL_CLAIM_EXPIRED'
      else 'COUPANG_MANUAL_CLAIM_CLOSED' end);
  end if;
  if c.expires_at <= v_now then
    update public.coupang_rank_manual_claims
       set status = 'expired', finished_at = v_now, outcome_code = 'verify_late'
     where id = c.id;
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_EXPIRED');
  end if;
  if not exists (select 1 from public.coupang_rank_trackers t
                  where t.keyword_key = c.keyword_key and t.status = 'active'
                    and public.coupang_rank_tracker_is_eligible(t.client_id, t.agency_code)) then
    update public.coupang_rank_manual_claims
       set status = 'cancelled', finished_at = v_now, outcome_code = 'verify_no_tracker'
     where id = c.id;
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_TRACKER_PAUSED');
  end if;

  v_summary := public.coupang_rank_manual_summary(c.id);
  v_state := v_summary ->> 'state';
  if v_state <> 'ready' then
    update public.coupang_rank_manual_claims
       set status = 'cancelled', finished_at = v_now, outcome_code = 'verify_' || v_state
     where id = c.id;
    return jsonb_build_object('ok', false, 'state', v_state, 'manual', public.coupang_rank_manual_summary(null));
  end if;

  update public.coupang_rank_manual_claims set status = 'verified', verified_at = v_now where id = c.id;
  update public.coupang_rank_settings set manual_last_search_at = v_now where id = 1;
  return jsonb_build_object('ok', true, 'verified', true, 'claimId', c.id, 'keyword', c.search_text,
    'keywordKey', c.keyword_key, 'verifiedAt', v_now, 'recordUntil', c.claimed_at + interval '10 minutes',
    'serverTime', v_now);
end;
$$;

-- 4.4 그날 중지(차단 신호). 더 엄격하게만 바꾸므로 요청 상태·나이와 상관없이 토큰이 맞으면 건다.
-- 그날 = 그 요청의 검색 날짜(확인 시각, 없으면 요청 시각의 KST 날짜). 이미 같은 날 멈췄으면 처음 사유를 남긴다.
-- record 가 부르고, 확장이 결과 보고 전에 직접 알릴 때(GET view=manual-stop)와 모양이 틀린 결과에 차단 신호가 보일 때도 쓴다.
create or replace function public.coupang_rank_manual_stop(
  p_claim_id uuid, p_token_sha256 text, p_requested_by text, p_code text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.coupang_rank_settings%rowtype;
  c public.coupang_rank_manual_claims%rowtype;
  v_now timestamptz := now();
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_day date;
begin
  if p_code is null or p_code !~ '^[a-z0-9_]{1,60}$' then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_ACTION_INVALID', 'field', 'reason');
  end if;
  select * into s from public.coupang_rank_settings where id = 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_SETUP_REQUIRED');
  end if;
  select * into c from public.coupang_rank_manual_claims where id = p_claim_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_NOT_FOUND');
  end if;
  if c.token_sha256 is distinct from p_token_sha256 or c.requested_by is distinct from p_requested_by then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_MISMATCH');
  end if;
  v_day := (coalesce(c.verified_at, c.claimed_at) at time zone 'Asia/Seoul')::date;
  if s.manual_stopped_day is null or s.manual_stopped_day < v_day then
    update public.coupang_rank_settings
       set manual_stopped_day = v_day, manual_stopped_at = v_now,
           manual_stopped_run_id = coalesce(p_run_id, c.run_id), manual_stopped_code = p_code
     where id = 1;
  elsif s.manual_stopped_day = v_day and s.manual_stopped_run_id is null
        and coalesce(p_run_id, c.run_id) is not null then
    update public.coupang_rank_settings set manual_stopped_run_id = coalesce(p_run_id, c.run_id) where id = 1;
  end if;
  update public.coupang_rank_manual_claims set stop_applied = true where id = c.id;
  return jsonb_build_object('ok', true,
    'stopped', coalesce((select x.manual_stopped_day = v_today from public.coupang_rank_settings x where x.id = 1), false),
    'stoppedDay', v_day, 'stopCode', p_code, 'manual', public.coupang_rank_manual_summary(null));
end;
$$;

-- 4.5 결과 받기(화면이 부름, 멱등: 요청 id). 판정(p_status)·중지 사유(p_stop_code)는 서버 JS 가 page-result 규칙으로 정한다.
-- 측정 결과는 확장 확인(verified_at)을 받은 요청만 저장한다(확인 없이 열린 창은 없으므로 그 밖의 결과는 꾸민 것).
-- 저장은 자동 수집과 같은 함수(apply_success·mark_failed)를 쓰고, 키워드 일정·자동 쉬기·연속 오류는 건드리지 않는다.
-- 차단 신호는 어느 갈래(중복·늦음·끝난 요청·확인 없음)에서든 그날 중지를 건다. 잠금 순서: 설정 행 → 확인 표 → 회차 → 추적기.
create or replace function public.coupang_rank_manual_record(
  p_claim_id uuid, p_token_sha256 text, p_requested_by text, p_outcome text, p_outcome_code text,
  p_status text, p_run jsonb, p_stop_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.coupang_rank_settings%rowtype;
  c public.coupang_rank_manual_claims%rowtype;
  t record;
  v_now timestamptz := now();
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_code text;
  v_stop_code text;
  v_error text;
  v_run uuid;
  v_success boolean;
  v_matched integer := 0;
  v_organic jsonb;
  v_ads jsonb;
  v_tracker jsonb := null;
  v_counted boolean;
  v_stopped boolean;
  v_run_status text;
  v_run_error text;
begin
  if p_outcome is null or p_outcome not in ('measured', 'not_started', 'lost') then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_RECORD_INVALID', 'field', 'outcome');
  end if;
  if p_outcome = 'measured' and (p_status is null or p_status not in (
       'ok', 'noresult', 'partial', 'blocked', 'empty', 'error', 'timeout', 'unsupported')) then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_RECORD_INVALID', 'field', 'status');
  end if;
  if p_stop_code is not null and p_stop_code !~ '^[a-z0-9_]{1,60}$' then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_RECORD_INVALID', 'field', 'stopCode');
  end if;
  v_code := case when p_outcome_code ~ '^[a-z0-9_]{1,60}$' then p_outcome_code else null end;
  v_stop_code := coalesce(p_stop_code,
    case when p_outcome = 'measured' and p_status = 'blocked' then 'blocked_page' else null end);

  select * into s from public.coupang_rank_settings where id = 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_SETUP_REQUIRED');
  end if;
  select * into c from public.coupang_rank_manual_claims where id = p_claim_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_NOT_FOUND');
  end if;
  if c.token_sha256 is distinct from p_token_sha256 or c.requested_by is distinct from p_requested_by then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_MISMATCH');
  end if;
  v_counted := c.verified_at is not null;

  -- (1) 이미 저장한 요청: 같은 보고를 다시 보낸 것. 차단 신호면 중지만 다시 확인한다.
  if c.status = 'recorded' then
    if v_stop_code is not null then
      perform public.coupang_rank_manual_stop(c.id, p_token_sha256, p_requested_by, v_stop_code, c.run_id);
    end if;
    select r.status, r.error_code into v_run_status, v_run_error from public.coupang_rank_runs r where r.id = c.run_id;
    v_stopped := coalesce((select x.manual_stopped_day = v_today from public.coupang_rank_settings x where x.id = 1), false);
    return jsonb_build_object('ok', true, 'accepted', false, 'duplicate', true, 'status', v_run_status,
      'errorCode', v_run_error, 'counted', v_counted, 'stopped', v_stopped,
      'manual', public.coupang_rank_manual_summary(null));
  end if;

  -- (2) 측정하지 않음(시작 못 함·응답 없음). 확인 전이면 검색이 없었으므로 횟수에 세지 않는다(counted false).
  if p_outcome <> 'measured' then
    if v_stop_code is not null then
      perform public.coupang_rank_manual_stop(c.id, p_token_sha256, p_requested_by, v_stop_code, null);
    end if;
    v_stopped := coalesce((select x.manual_stopped_day = v_today from public.coupang_rank_settings x where x.id = 1), false);
    if c.status in ('open', 'verified') then
      update public.coupang_rank_manual_claims
         set status = case when p_outcome = 'lost' then 'lost' else 'cancelled' end,
             finished_at = v_now, outcome_code = v_code
       where id = c.id;
      return jsonb_build_object('ok', true, 'accepted', false, 'duplicate', false, 'outcome', p_outcome,
        'counted', v_counted, 'stopped', v_stopped, 'manual', public.coupang_rank_manual_summary(null));
    end if;
    return jsonb_build_object('ok', true, 'accepted', false, 'duplicate', true, 'outcome', p_outcome,
      'counted', v_counted, 'stopped', v_stopped, 'manual', public.coupang_rank_manual_summary(null));
  end if;

  -- (3) 측정 결과인데 확장 확인을 받은 적이 없는 요청: 창이 열린 적이 없으므로 저장하지 않는다.
  if c.verified_at is null then
    if v_stop_code is not null then
      perform public.coupang_rank_manual_stop(c.id, p_token_sha256, p_requested_by, v_stop_code, null);
    end if;
    if c.status = 'open' then
      update public.coupang_rank_manual_claims
         set status = 'cancelled', finished_at = v_now, outcome_code = 'not_verified'
       where id = c.id;
    end if;
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_NOT_VERIFIED',
      'stopped', coalesce((select x.manual_stopped_day = v_today from public.coupang_rank_settings x where x.id = 1), false));
  end if;

  -- (4) 너무 늦은 보고(요청 뒤 10분 넘음)는 저장하지 않는다. 차단이었다면 그날 중지는 건다.
  if c.claimed_at < v_now - interval '10 minutes' then
    if v_stop_code is not null then
      perform public.coupang_rank_manual_stop(c.id, p_token_sha256, p_requested_by, v_stop_code, null);
    end if;
    update public.coupang_rank_manual_claims
       set status = 'expired', finished_at = coalesce(finished_at, v_now), outcome_code = 'late_record'
     where id = c.id;
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_EXPIRED',
      'stopped', coalesce((select x.manual_stopped_day = v_today from public.coupang_rank_settings x where x.id = 1), false));
  end if;

  -- (5) 이미 '시작 못 함'으로 닫은 요청에 측정이 오면 저장하지 않는다(차단이면 중지는 건다).
  if c.status not in ('verified', 'lost', 'expired') then
    if v_stop_code is not null then
      perform public.coupang_rank_manual_stop(c.id, p_token_sha256, p_requested_by, v_stop_code, null);
    end if;
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_CLAIM_CLOSED',
      'stopped', coalesce((select x.manual_stopped_day = v_today from public.coupang_rank_settings x where x.id = 1), false));
  end if;

  -- (6) 목록을 읽은 결과가 확인 뒤 5초 안에 오면 꾸민 것이다(확장 측정은 쉬기 2.5초 + 스크롤 8번 + 읽기 2번).
  if p_status in ('ok', 'noresult', 'partial', 'empty') and v_now < c.verified_at + interval '5 seconds' then
    return jsonb_build_object('ok', false, 'code', 'COUPANG_MANUAL_RECORD_INVALID', 'field', 'timing');
  end if;

  v_success := p_status in ('ok', 'noresult');
  v_organic := case when jsonb_typeof(p_run -> 'organic') = 'array' then p_run -> 'organic' else '[]'::jsonb end;
  v_ads := case when jsonb_typeof(p_run -> 'ads') = 'array' then p_run -> 'ads' else '[]'::jsonb end;
  v_error := case when (p_run ->> 'errorCode') ~ '^[a-z0-9_]{1,60}$' then p_run ->> 'errorCode' else null end;

  -- 회차 칸: 검색 날짜(확인 시각의 KST 날짜), 칸 0, 시작 분 0(자동 칸 480·930분과 겹치지 않는다).
  insert into public.coupang_rank_runs (
    keyword_key, collector_id, slot_day, slot_index, slot_minute, claimed_at, lease_until, completed_at,
    status, late, http_status, login_wall, stable, item_count, organic_count, ad_count, organic, ads,
    final_host, final_path, duration_ms, collector_version, browser, error_code, source, requested_by)
  values (
    c.keyword_key, null, (c.verified_at at time zone 'Asia/Seoul')::date, 0, 0, c.verified_at,
    c.verified_at + interval '150 seconds', v_now,
    p_status, v_now > c.verified_at + interval '150 seconds',
    (p_run ->> 'httpStatus')::smallint, (p_run ->> 'loginWall')::boolean, (p_run ->> 'stable')::boolean,
    (p_run ->> 'itemCount')::smallint, jsonb_array_length(v_organic), jsonb_array_length(v_ads),
    (select coalesce(jsonb_agg(e.item - 't' order by e.ord), '[]'::jsonb)
       from jsonb_array_elements(v_organic) with ordinality as e(item, ord)),
    (select coalesce(jsonb_agg(e.item - 't' order by e.ord), '[]'::jsonb)
       from jsonb_array_elements(v_ads) with ordinality as e(item, ord)),
    left(p_run ->> 'finalHost', 60), left(p_run ->> 'finalPath', 80), (p_run ->> 'durationMs')::integer,
    left(p_run ->> 'collectorVersion', 20), left(p_run ->> 'browser', 60), v_error,
    'manual', c.requested_by)
  returning id into v_run;

  if v_success then
    for t in
      select tt.id from public.coupang_rank_trackers tt
       where tt.keyword_key = c.keyword_key and tt.status = 'active'
       order by tt.id
    loop
      if public.coupang_rank_apply_success(v_run, t.id, v_organic, v_ads) then
        v_matched := v_matched + 1;
      end if;
    end loop;
  else
    perform public.coupang_rank_mark_failed(v_run, case when p_status = 'unsupported' then 'unsupported' else 'failed' end);
  end if;
  update public.coupang_rank_runs set matched_count = v_matched where id = v_run;

  if v_stop_code is not null then
    perform public.coupang_rank_manual_stop(c.id, p_token_sha256, p_requested_by, v_stop_code, v_run);
  end if;

  update public.coupang_rank_manual_claims
     set status = 'recorded', finished_at = v_now, run_id = v_run, outcome_code = coalesce(v_code, v_error)
   where id = c.id;
  if c.tracker_id is not null then
    select jsonb_build_object('trackerId', tr.id, 'result', tr.current_result, 'rank', tr.current_rank,
                              'organicCount', tr.current_organic_count, 'adOrder', tr.current_ad_order,
                              'checkedAt', tr.last_checked_at)
      into v_tracker
      from public.coupang_rank_trackers tr where tr.id = c.tracker_id;
  end if;
  v_stopped := coalesce((select x.manual_stopped_day = v_today from public.coupang_rank_settings x where x.id = 1), false);
  return jsonb_build_object('ok', true, 'accepted', true, 'duplicate', false, 'status', p_status,
    'errorCode', v_error, 'matched', v_matched, 'counted', true, 'stopped', v_stopped,
    'stopCode', v_stop_code, 'late', v_now > c.verified_at + interval '150 seconds', 'tracker', v_tracker,
    'manual', public.coupang_rank_manual_summary(null));
end;
$$;

-- ───────────────────────── 5. 함수 실행 권한(service_role 전용) ─────────────────────────

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'coupang\_rank\_manual\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

commit;
