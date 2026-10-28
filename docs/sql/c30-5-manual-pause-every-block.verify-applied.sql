-- C30 지금 확인 '차단될 때마다 30분 쉼' 적용 확인 (읽기 전용, Supabase SQL Editor 에서 실행).
-- 정상(적용 직후): every_block = true | summary_no_stop_rule = true | fn_count = 5 | stopped_today = false | blocks_today = (오늘 센 차단 수, 없으면 0) | paused_until_now = (쉬는 중이면 끝 시각, 아니면 NULL)
-- every_block 이 false 면 차단 알림 함수가 아직 c30-4(두 번째 차단 그날 중지)다 → c30-5 미적용(되돌린 뒤라면 정상).
-- stopped_today 는 오늘이 그날 중지로 걸려 있는지다(적용 뒤에는 늘 false — 적용할 때 오늘 그날 중지는 30분 쉼으로 바뀐다).
-- 칸이 없으면 결과 줄 없이 'column "manual_paused_until" does not exist' 오류만 나온다 → c30-4 부터 미적용.
select
  (select coalesce(bool_or(p.prosrc like '%manual_paused_until%' and p.prosrc not like '%set manual_stopped_day%'), false)
     from pg_catalog.pg_proc p where p.proname = 'coupang_rank_manual_stop') as every_block,
  (select coalesce(bool_or(p.prosrc like '%then ''paused''%' and p.prosrc not like '%blocksToStop%'), false)
     from pg_catalog.pg_proc p where p.proname = 'coupang_rank_manual_summary') as summary_no_stop_rule,
  (select count(*) from pg_catalog.pg_proc p where p.proname like 'coupang\_rank\_manual\_%') as fn_count,
  (select coalesce(s.manual_stopped_day = (now() at time zone 'Asia/Seoul')::date, false)
     from public.coupang_rank_settings s where s.id = 1) as stopped_today,
  (select case when s.manual_block_day = (now() at time zone 'Asia/Seoul')::date then s.manual_block_count else 0 end
     from public.coupang_rank_settings s where s.id = 1) as blocks_today,
  (select case when s.manual_paused_until > now() then s.manual_paused_until end
     from public.coupang_rank_settings s where s.id = 1) as paused_until_now;
