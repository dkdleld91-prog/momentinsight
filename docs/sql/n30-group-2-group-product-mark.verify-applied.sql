-- N30 그룹상품 표시 칸 적용 확인 (읽기 전용, Supabase SQL Editor 에서 실행).
-- 정상(적용 직후): column_type = boolean | column_default = false | is_nullable = NO | marked_rows = 0
-- marked_rows 는 '그룹상품으로 표시'한 추적 수다(표시한 뒤에는 0 보다 크다).
-- 칸이 없으면 column_type 이 비고 marked_rows 줄에서 오류가 난다 → 마이그레이션 미적용.
select
  (select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'group_product_marked') as column_type,
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'group_product_marked') as column_default,
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'group_product_marked') as is_nullable,
  (select count(*) from public.naver_rank_trackers
    where group_product_marked) as marked_rows;
