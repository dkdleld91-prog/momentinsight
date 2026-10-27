-- C30 지금 확인 '차단 뒤 30분 쉼 · 간격 4분' 적용 확인 (읽기 전용, Supabase SQL Editor 에서 실행).
-- 정상(적용 직후): new_columns = 6 | gap_default = 240 | gap_now = 240 | summary_paused = true | stop_counts = true | fn_count = 5 | paused_until_now = NULL
-- gap_now 는 지금 행의 간격이다(대표가 따로 더 길게 바꿨다면 그 값 — 240 보다 크면 정상).
-- paused_until_now 는 지금 30분 쉼이 끝나는 시각이다(쉬는 중이 아니면 NULL, 적용 직후에는 NULL).
-- 칸이 없으면 결과 줄 없이 'column "manual_paused_until" does not exist' 오류만 나온다 → 마이그레이션 미적용(되돌린 뒤라면 정상).
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'coupang_rank_settings'
      and column_name in ('manual_paused_until', 'manual_block_day', 'manual_block_count',
                          'manual_block_at', 'manual_block_code', 'manual_block_claim_id')) as new_columns,
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'coupang_rank_settings'
      and column_name = 'manual_min_gap_seconds') as gap_default,
  (select s.manual_min_gap_seconds from public.coupang_rank_settings s where s.id = 1) as gap_now,
  (select coalesce(bool_or(p.prosrc like '%then ''paused''%'), false) from pg_catalog.pg_proc p
    where p.proname = 'coupang_rank_manual_summary') as summary_paused,
  (select coalesce(bool_or(p.prosrc like '%manual_block_count%'), false) from pg_catalog.pg_proc p
    where p.proname = 'coupang_rank_manual_stop') as stop_counts,
  (select count(*) from pg_catalog.pg_proc p where p.proname like 'coupang\_rank\_manual\_%') as fn_count,
  (select s.manual_paused_until from public.coupang_rank_settings s where s.id = 1) as paused_until_now;
