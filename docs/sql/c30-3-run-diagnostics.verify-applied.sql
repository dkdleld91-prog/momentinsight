-- C30 지금 확인 진단 칸 적용 확인 (읽기 전용, Supabase SQL Editor 에서 실행).
-- 정상(적용 직후): column_type = jsonb | is_nullable = YES | constraint_count = 1 | size_guard = true | diagnosed_runs = 0
-- diagnosed_runs 는 진단이 적힌 회차 수다(확장 1.0.1 로 '지금 확인'을 한 뒤에는 0 보다 크다).
-- 칸이 없으면 column_type 이 비고 diagnosed_runs 줄에서 오류가 난다 → 마이그레이션 미적용.
select
  (select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'coupang_rank_runs'
      and column_name = 'diagnostics') as column_type,
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'coupang_rank_runs'
      and column_name = 'diagnostics') as is_nullable,
  (select count(*) from pg_catalog.pg_constraint
    where conname = 'coupang_rank_runs_diagnostics_shape'
      and conrelid = 'public.coupang_rank_runs'::regclass) as constraint_count,
  (select coalesce(bool_or(pg_catalog.pg_get_constraintdef(oid) like '%pg_column_size%8192%'), false)
    from pg_catalog.pg_constraint
    where conname = 'coupang_rank_runs_diagnostics_shape'
      and conrelid = 'public.coupang_rank_runs'::regclass) as size_guard,
  (select count(*) from public.coupang_rank_runs where diagnostics is not null) as diagnosed_runs;
