-- N30 그룹상품 번호 칸 적용 확인 (읽기 전용, Supabase SQL Editor 에서 실행).
-- 정상(적용 직후): column_type = ARRAY | column_default = '{}'::text[] | is_nullable = NO
--                   | constraint_count = 1 | roundtrip_guard = true | grouped_rows = 0
-- grouped_rows 는 그룹상품 번호를 저장한 추적 수다(저장한 뒤에는 0 보다 크다).
-- 칸이 없으면 column_type 이 비고 grouped_rows 줄에서 오류가 난다 → 마이그레이션 미적용.
select
  (select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'option_product_ids') as column_type,
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'option_product_ids') as column_default,
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'naver_rank_trackers'
      and column_name = 'option_product_ids') as is_nullable,
  (select count(*) from pg_catalog.pg_constraint
    where conname = 'naver_rank_trackers_option_product_ids_shape'
      and conrelid = 'public.naver_rank_trackers'::regclass) as constraint_count,
  (select coalesce(bool_or(pg_catalog.pg_get_constraintdef(oid) like '%string_to_array%'), false)
    from pg_catalog.pg_constraint
    where conname = 'naver_rank_trackers_option_product_ids_shape'
      and conrelid = 'public.naver_rank_trackers'::regclass) as roundtrip_guard,
  (select count(*) from public.naver_rank_trackers
    where pg_catalog.cardinality(option_product_ids) > 0) as grouped_rows;
