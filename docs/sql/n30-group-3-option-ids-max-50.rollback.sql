-- 되돌리기: 옵션 번호 상한 50 → 20. 21개 이상 넣은 추적이 있으면 실패한다(먼저 그 추적의 번호를 20개 이하로 줄인다).
begin;
set local lock_timeout = '5s';
alter table public.naver_rank_trackers
  drop constraint if exists naver_rank_trackers_option_product_ids_shape;
alter table public.naver_rank_trackers
  add constraint naver_rank_trackers_option_product_ids_shape check (
    pg_catalog.cardinality(option_product_ids) <= 20
    and pg_catalog.array_to_string(option_product_ids, ',')
      ~ '^([0-9]{5,20}(,[0-9]{5,20})*)?$'
    and pg_catalog.string_to_array(pg_catalog.array_to_string(option_product_ids, ','), ',')
      = option_product_ids
  );
notify pgrst, 'reload schema';
commit;
