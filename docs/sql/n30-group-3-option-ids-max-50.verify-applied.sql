-- 확인: 결과 1줄, has_50 = true 이면 적용됨.
select position('<= 50' in pg_get_constraintdef(oid)) > 0 as has_50
from pg_constraint
where conname = 'naver_rank_trackers_option_product_ids_shape';
