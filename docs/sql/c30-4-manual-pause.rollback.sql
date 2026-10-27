-- ROLLBACK for supabase/migrations/20261027180000_coupang_rank_manual_pause.sql
-- (C30 지금 확인 '차단 뒤 30분 쉼' 되돌리기. 대표가 Supabase SQL Editor 에서 되돌릴 때만 실행한다.)
-- 요약·차단 알림 함수를 c30-2(20261018090000) 원문으로 되돌리고(차단 한 번에 그날 중지), 더한 칸 6개를 지운다.
-- 지금 30분 쉬는 중이거나 오늘 센 차단이 있으면 칸을 지우기 전에 오늘을 그날 중지로 바꾼다(되돌려도 쿠팡 검색이 바로 열리지 않게).
-- 서버 코드는 칸이 없어도 견딘다(예전처럼 그날 중지로 동작). 순위 기록(회차·스냅샷)·요청 표는 지우지 않는다.
-- 검색 사이 간격은 지금 값(240초)을 그대로 둔다(쿠팡 요청을 늘리는 쪽으로 되돌리지 않는다). 기본값만 180 으로 되돌린다.
-- 3분으로 되돌리려면 대표가 따로: update public.coupang_rank_settings set manual_min_gap_seconds = 180 where id = 1;
-- 되돌린 뒤 적용 확인문(docs/sql/c30-4-manual-pause.verify-applied.sql)을 돌리면 결과 줄 없이
-- 'column "manual_paused_until" does not exist' 오류만 나온다. 칸이 지워졌다는 뜻이라 되돌린 뒤에는 정상이다.
-- 다시 적용하려면 docs/sql/c30-4-manual-pause.sql 을 실행한다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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

-- 되돌려도 보호를 풀지 않는다: 지금 30분 쉬는 중이거나 오늘 센 차단이 있으면 예전 규칙(차단 한 번 = 그날 중지)대로 오늘 그날 중지로 바꾼다.
-- (칸이 이미 없으면 — 두 번째 실행 — 건너뛴다.)
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'coupang_rank_settings'
                and column_name = 'manual_paused_until') then
    execute $q$
      update public.coupang_rank_settings
         set manual_stopped_day = (now() at time zone 'Asia/Seoul')::date,
             manual_stopped_at = coalesce(manual_block_at, now()),
             manual_stopped_run_id = null,
             manual_stopped_code = coalesce(manual_block_code, 'blocked_page')
       where id = 1
         and (manual_stopped_day is null or manual_stopped_day < (now() at time zone 'Asia/Seoul')::date)
         and ((manual_paused_until is not null and manual_paused_until > now())
              or (manual_block_day = (now() at time zone 'Asia/Seoul')::date and manual_block_count > 0))
    $q$;
  end if;
end;
$$;

alter table public.coupang_rank_settings alter column manual_min_gap_seconds set default 180;

alter table public.coupang_rank_settings
  drop column if exists manual_paused_until,
  drop column if exists manual_block_day,
  drop column if exists manual_block_count,
  drop column if exists manual_block_at,
  drop column if exists manual_block_code,
  drop column if exists manual_block_claim_id;

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
