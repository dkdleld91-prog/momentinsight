-- ROLLBACK for supabase/migrations/20261023090000_naver_rank_group_products.sql
-- (N30 그룹상품 번호 칸 되돌리기. 대표가 Supabase SQL Editor 에서 되돌릴 때만 실행한다.)
-- 서버 코드는 칸이 없어도 견딘다(옵션 없음 = 대표 번호만 보는 기존 동작). 권장 순서는 코드 되돌린 뒤.
-- 칸을 지우면 저장한 그룹상품 번호도 함께 사라진다. 이미 기록된 순위 기록(스냅샷)은 지우지 않는다.
-- 되돌린 뒤 적용 확인문(docs/sql/n30-group-1-option-product-ids.verify-applied.sql)을 돌리면
-- 'column "option_product_ids" does not exist' 오류로 끝난다. 칸이 지워졌다는 뜻이라 되돌린 뒤에는 이 오류가 정상이다.
-- 다시 적용하려면 docs/sql/n30-group-1-option-product-ids.sql 을 실행한다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.naver_rank_trackers
  drop constraint if exists naver_rank_trackers_option_product_ids_shape;

alter table public.naver_rank_trackers
  drop column if exists option_product_ids;

notify pgrst, 'reload schema';

commit;
