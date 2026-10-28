-- C 30일 ① '지금 확인' 차단될 때마다 30분 쉼 (대표 결정 2026-10-28 "두번실패하면 내일로가는데 그냥 계속 30분씩만 텀 돌면 괜찮습니다").
-- c30-4(20261027180000) 위에 바꾼다. c30-4 는 그 날 첫 차단 30분 쉼, 같은 날 두 번째 차단은 그날 중지(다음 날 09시)였다:
--   ① 차단 신호(c30-4 가 세던 모든 사유)는 몇 번째든 30분 쉼(서버 시계). 차단 때문에 그날 중지는 걸지 않는다.
--   ② 그 날 센 차단 수(manual_block_count)는 기록·화면 표시용으로 그대로 센다(보호 판정에는 쓰지 않는다).
--   ③ 지금 오늘(KST)이 그날 중지로 걸려 있으면(c30-4 의 두 번째 차단 또는 그 전 규칙) 그 중지 시각부터 30분 쉼으로 바꾼다
--      (이미 30분이 지났으면 바로 다시 된다). 중지 시각·사유·회차 id 는 기록으로 남기고 그날 표시만 지운다.
-- 같은 요청의 차단은 한 번만 세고, 확장이 '앞서 차단을 봤다'고만 알린 요청(확인 없음)은 그 날 센 차단이 없을 때만 센다(c30-4 그대로).
-- 하루 횟수·확인 시간(09~19시)·검색 간격(240초)·지금 확인 끄기 등 다른 규칙은 그대로다. 칸은 더하지 않는다(c30-4 칸 그대로).
-- 함수 2개(요약·차단 알림)만 다시 정의한다. 요청·확인·결과 함수는 그대로다(요약·차단 알림을 부른다).
-- 다시 실행해도 안전하다(create or replace · 조건부 갱신). c30-4 가 먼저 적용돼 있어야 한다(칸이 없으면 오류로 멈추고 아무것도 바꾸지 않는다).
-- 금지: 다른 순위 기능의 표·함수 이름(잠금 검사 정규식), 함수 본문의 'x.y.z' 버전 문자열·64자리 16진 리터럴.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ───────────────────────── 1. 오늘 그날 중지 → 30분 쉼 ─────────────────────────
-- 지금 그날 중지가 걸린 곳은 차단뿐이다(coupang_rank_manual_stop). 오늘이면 중지 시각부터 30분 쉼으로 바꾼다(이미 더 긴 쉼이면 그대로).
update public.coupang_rank_settings
   set manual_paused_until = greatest(manual_paused_until, coalesce(manual_stopped_at, now()) + interval '30 minutes'),
       manual_stopped_day = null
 where id = 1
   and manual_stopped_day = (now() at time zone 'Asia/Seoul')::date;

-- ───────────────────────── 2. 함수 ─────────────────────────

-- 2.1 지금 상태(화면 버튼·claim·verify 관문이 같은 판정을 쓴다). 판정 순서(c30-4 그대로):
-- 꺼짐 → 저장 용량 → 오늘 중지(c30-5 뒤에는 걸리지 않음 — 되돌린 c30-4 가 건 날만) → 30분 쉼 → 자동 수집 차단 쉬기 → 시간 밖 → 진행 중 → 하루 상한 → 간격 → 가능.
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
  v_paused boolean;
  v_blocks integer;
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
  -- 30분 쉼은 끝나는 시각만 본다(서버 시계). 오늘 센 차단 수는 그 날(KST)이 오늘일 때만(다음 날이면 0, 기록·화면 표시용).
  v_paused := s.manual_paused_until is not null and s.manual_paused_until > v_now;
  v_blocks := case when s.manual_block_day is not distinct from v_today then s.manual_block_count else 0 end;
  v_state := case
    when not s.manual_enabled then 'off'
    when s.budget_blocked then 'budget'
    when s.manual_stopped_day is not distinct from v_today then 'stopped'
    when v_paused then 'paused'
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
    'pausedUntil', case when v_paused then s.manual_paused_until else null end,
    'blocksToday', v_blocks,
    'blockAt', case when v_blocks > 0 then s.manual_block_at else null end,
    'blockCode', case when v_blocks > 0 then s.manual_block_code else null end,
    'pauseMinutes', 30,
    'cooldownUntil', case when v_state = 'cooldown' then s.cooldown_until else null end,
    'serverTime', v_now);
end;
$$;

-- 2.2 차단 알림(차단 신호). 더 엄격하게만 바꾸므로 요청 상태·나이와 상관없이 토큰이 맞으면 받는다.
-- 그 날 = 그 요청의 검색 날짜(확인 시각, 없으면 요청 시각의 KST 날짜). 요청 하나의 차단은 한 번만 센다(stop_applied).
-- 센 차단이 오늘이면 몇 번째든 30분 쉼(지금부터, 이미 더 긴 쉼이면 그대로). 그날 중지는 걸지 않는다(대표 결정 2026-10-28).
-- 확인 없는 요청의 알림(확장이 앞서 본 차단을 알림)은 그 날 센 차단이 없을 때만 센다(같은 차단을 두 번 세지 않게).
-- 거꾸로, 그 알림이 먼저 세어진 뒤 그 알림 요청보다 먼저 검색한 요청의 차단 보고가 늦게 오면 같은 차단으로 보고 다시 세지 않는다.
-- 그렇게 묶는 것은 한 번뿐이다(묶은 검색이 그 차단의 요청이 된다 — 알림 전의 다른 검색이 또 늦게 오면 다음 차단으로 센다).
-- 지난 날(이미 더 나중 날의 차단을 센 뒤 온 늦은 보고)은 세지 않는다. 잠금 순서: 설정 행 → 확인 표.
-- p_run_id 는 받기만 한다(그날 중지 회차 id 를 채우던 칸 — 함수 모양을 바꾸지 않으려고 남긴다).
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
  v_count integer;
  v_same boolean := false;
  p public.coupang_rank_manual_claims%rowtype;
  x public.coupang_rank_settings%rowtype;
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

  -- 같은 요청의 차단을 다시 알림(확장 직접 알림 뒤 결과 보고 등)이면 횟수·쉼은 그대로다(stop_applied).
  if not c.stop_applied and (s.manual_block_day is null or s.manual_block_day <= v_day) then
    v_count := case when s.manual_block_day is not distinct from v_day then s.manual_block_count else 0 end;
    -- 그 날 마지막으로 센 차단이 확인 없는 요청의 알림이고, 이 검색이 그 알림 요청보다 먼저였으면 확장이 알린 바로 그 차단이다.
    if c.verified_at is not null and v_count > 0 and s.manual_block_claim_id is not null then
      select * into p from public.coupang_rank_manual_claims where id = s.manual_block_claim_id;
      v_same := found and p.verified_at is null and c.verified_at <= p.claimed_at;
    end if;
    if v_same then
      -- 확장이 알린 차단 = 이 검색. 그 차단의 요청을 이 검색으로 바꿔 둔다(다음 늦은 보고는 묶지 않는다). 쉼은 그대로.
      update public.coupang_rank_settings set manual_block_claim_id = c.id where id = 1;
    elsif c.verified_at is not null or v_count = 0 then
      -- 몇 번째 차단이든 오늘이면 지금부터 30분 쉼(이미 더 긴 쉼이면 그대로). 그날 중지는 걸지 않는다.
      v_count := v_count + 1;
      update public.coupang_rank_settings
         set manual_block_day = v_day, manual_block_count = least(v_count, 100), manual_block_at = v_now,
             manual_block_code = p_code, manual_block_claim_id = c.id,
             manual_paused_until = case
               when v_day = v_today
                 then greatest(coalesce(manual_paused_until, v_now), v_now + interval '30 minutes')
               else manual_paused_until end
       where id = 1;
    end if;
  end if;
  update public.coupang_rank_manual_claims set stop_applied = true where id = c.id;
  select * into x from public.coupang_rank_settings where id = 1;
  return jsonb_build_object('ok', true,
    'stopped', coalesce(x.manual_stopped_day = v_today, false),
    'paused', coalesce(x.manual_paused_until > v_now, false),
    'pausedUntil', case when x.manual_paused_until > v_now then x.manual_paused_until else null end,
    'blocksToday', case when x.manual_block_day is not distinct from v_today then x.manual_block_count else 0 end,
    'stoppedDay', v_day, 'stopCode', p_code, 'manual', public.coupang_rank_manual_summary(null));
end;
$$;

-- ───────────────────────── 3. 함수 실행 권한(service_role 전용, 다시 정의한 2개도) ─────────────────────────

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
