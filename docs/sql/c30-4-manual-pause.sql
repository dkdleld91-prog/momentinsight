-- C 30일 ① '지금 확인' 차단 뒤 30분 쉬기 + 검색 간격 4분 (대표 승인 2026-10-27 "네 추천대로 진행해주세요").
-- 지금까지는 차단 신호 한 번에 그날 '지금 확인'을 모두 멈췄다(다음 날 09시). 쿠팡 차단은 30분쯤 뒤 풀려서 바꾼다:
--   ① 차단 신호(지금 그날 중지를 거는 모든 사유) 첫 번째 → 30분 쉼(서버 시계). 30분 뒤 다시 누를 수 있다.
--   ② 같은 날(KST) 두 번째 차단 → 그날 중지(지금처럼, 다음 날 09시에 풀림). 쿠팡 윙·광고센터와 같은 회선 보호.
--   ③ 검색 사이 최소 간격 180초 → 240초(기본값과 지금 행. 제약 180~3600 은 그대로).
-- 차단 한 번 = 실제 검색(확장 확인을 받은 요청) 하나. 같은 요청의 차단을 여러 번 알려도(확장 직접 알림 + 결과 보고) 한 번으로 센다.
-- 확장이 '앞서 차단을 봤다'고만 알리는 요청(확인 없음, extension_reported)은 서버가 그날 차단을 아직 모를 때만 첫 차단으로 센다.
-- 설정 칸 6개를 더하고 함수 2개(요약·차단 알림)만 다시 정의한다. 요청·확인·결과 함수는 그대로다(요약·차단 알림을 부른다).
-- 다시 실행해도 안전하다(add column if not exists · create or replace · 조건부 갱신). 코드 배포 전후 어느 쪽에 실행해도 된다.
-- 금지: 다른 순위 기능의 표·함수 이름(잠금 검사 정규식), 함수 본문의 'x.y.z' 버전 문자열·64자리 16진 리터럴.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ───────────────────────── 1. 설정 칸(전역 1행) ─────────────────────────
-- manual_paused_until: 30분 쉼이 끝나는 시각(서버 시계). manual_block_day·count: 그 날(KST) 센 차단 수.
-- manual_block_at·code·claim_id: 마지막으로 센 차단의 시각·사유·요청(화면 안내와 그날 중지 회차 id 채우기용).

alter table public.coupang_rank_settings
  add column if not exists manual_paused_until timestamptz null,
  add column if not exists manual_block_day date null,
  add column if not exists manual_block_count smallint not null default 0
    check (manual_block_count between 0 and 100),
  add column if not exists manual_block_at timestamptz null,
  add column if not exists manual_block_code text null
    check (manual_block_code is null or manual_block_code ~ '^[a-z0-9_]{1,60}$'),
  add column if not exists manual_block_claim_id uuid null;

-- 검색 사이 최소 간격 240초(대표 결정 2026-10-27). 지금 행이 예전 기본값(180)일 때만 바꾼다(다른 값은 그대로).
alter table public.coupang_rank_settings alter column manual_min_gap_seconds set default 240;
update public.coupang_rank_settings set manual_min_gap_seconds = 240 where id = 1 and manual_min_gap_seconds = 180;

-- ───────────────────────── 2. 함수 ─────────────────────────

-- 2.1 지금 상태(화면 버튼·claim·verify 관문이 같은 판정을 쓴다). 판정 순서:
-- 꺼짐 → 저장 용량 → 오늘 중지 → 30분 쉼 → 자동 수집 차단 쉬기 → 시간 밖 → 진행 중 → 하루 상한 → 간격 → 가능.
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
  -- 30분 쉼은 끝나는 시각만 본다(서버 시계). 오늘 센 차단 수는 그 날(KST)이 오늘일 때만(다음 날이면 0).
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
    'blocksToStop', 2,
    'cooldownUntil', case when v_state = 'cooldown' then s.cooldown_until else null end,
    'serverTime', v_now);
end;
$$;

-- 2.2 차단 알림(차단 신호). 더 엄격하게만 바꾸므로 요청 상태·나이와 상관없이 토큰이 맞으면 받는다.
-- 그 날 = 그 요청의 검색 날짜(확인 시각, 없으면 요청 시각의 KST 날짜). 요청 하나의 차단은 한 번만 센다(stop_applied).
-- 첫 차단(그 날 1번째)이 오늘이면 30분 쉼(지금부터, 이미 더 긴 쉼이면 그대로), 2번째면 그날 중지(이미 같은 날 멈췄으면 처음 사유를 남긴다).
-- 확인 없는 요청의 알림(확장이 앞서 본 차단을 알림)은 그 날 센 차단이 없을 때만 첫 차단으로 센다(같은 차단을 두 번 세지 않게).
-- 거꾸로, 그 알림이 먼저 세어진 뒤 그 알림 요청보다 먼저 검색한 요청의 차단 보고가 늦게 오면 같은 차단으로 보고 다시 세지 않는다.
-- 지난 날(이미 더 나중 날의 차단을 센 뒤 온 늦은 보고)은 세지 않는다. 잠금 순서: 설정 행 → 확인 표.
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
  v_run uuid;
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
  v_run := coalesce(p_run_id, c.run_id);

  if c.stop_applied then
    -- 같은 요청의 차단을 다시 알림(확장 직접 알림 뒤 결과 보고 등): 횟수·쉼은 그대로. 그날 중지를 건 요청이면 회차 id 만 채운다.
    if s.manual_stopped_day is not distinct from v_day and s.manual_stopped_run_id is null and v_run is not null
       and s.manual_block_claim_id is not distinct from c.id then
      update public.coupang_rank_settings set manual_stopped_run_id = v_run where id = 1;
    end if;
  elsif s.manual_block_day is null or s.manual_block_day <= v_day then
    v_count := case when s.manual_block_day is not distinct from v_day then s.manual_block_count else 0 end;
    -- 그 날 마지막으로 센 차단이 확인 없는 요청의 알림이고, 이 검색이 그 알림 요청보다 먼저였으면 확장이 알린 바로 그 차단이다.
    if c.verified_at is not null and v_count > 0 and s.manual_block_claim_id is not null then
      select * into p from public.coupang_rank_manual_claims where id = s.manual_block_claim_id;
      v_same := found and p.verified_at is null and c.verified_at <= p.claimed_at;
    end if;
    if not v_same and (c.verified_at is not null or v_count = 0) then
      v_count := v_count + 1;
      update public.coupang_rank_settings
         set manual_block_day = v_day, manual_block_count = least(v_count, 100), manual_block_at = v_now,
             manual_block_code = p_code, manual_block_claim_id = c.id,
             manual_paused_until = case
               when v_count < 2 and v_day = v_today
                 then greatest(coalesce(manual_paused_until, v_now), v_now + interval '30 minutes')
               else manual_paused_until end
       where id = 1;
      if v_count >= 2 and (s.manual_stopped_day is null or s.manual_stopped_day < v_day) then
        update public.coupang_rank_settings
           set manual_stopped_day = v_day, manual_stopped_at = v_now,
               manual_stopped_run_id = v_run, manual_stopped_code = p_code
         where id = 1;
      end if;
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
