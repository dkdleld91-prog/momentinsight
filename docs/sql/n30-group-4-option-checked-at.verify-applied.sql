-- N30 그룹상품 옵션 확인일 칸 적용 확인 (읽기 전용, Supabase SQL Editor 에서 실행).
-- 정상(적용 직후): column_type = timestamp with time zone | column_default = (비어 있음) | is_nullable = YES | checked_rows = 0
-- checked_rows 는 옵션 확인일이 기록된 추적 수다(저장하거나 '확인만 기록'을 누른 뒤에는 0 보다 크다).
-- 칸이 없으면 column_type 이 비고 checked_rows 줄에서 오류가 난다 → 마이그레이션 미적용.
select
  (select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'option_checked_at') as column_type,
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'option_checked_at') as column_default,
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'option_checked_at') as is_nullable,
  (select count(*) from public.naver_rank_trackers
    where option_checked_at is not null) as checked_rows;
