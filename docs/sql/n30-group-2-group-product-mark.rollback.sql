-- ROLLBACK for supabase/migrations/20261027090000_naver_rank_group_product_mark.sql
-- (N30 그룹상품 표시 칸 되돌리기. 대표가 Supabase SQL Editor 에서 되돌릴 때만 실행한다.)
-- 서버 코드는 칸이 없어도 견딘다(표시 버튼 숨김·옵션 번호가 있는 추적만 그룹상품 = 이 기능 전 동작). 권장 순서는 코드 되돌린 뒤.
-- 칸을 지우면 '그룹상품으로 표시'한 상태도 함께 사라진다. 넣은 옵션 번호·순위 기록(스냅샷)은 지우지 않는다.
-- 되돌린 뒤 적용 확인문(docs/sql/n30-group-2-group-product-mark.verify-applied.sql)을 돌리면
-- 'column "group_product_marked" does not exist' 오류로 끝난다. 칸이 지워졌다는 뜻이라 되돌린 뒤에는 이 오류가 정상이다.
-- 다시 적용하려면 docs/sql/n30-group-2-group-product-mark.sql 을 실행한다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.naver_rank_trackers
  drop column if exists group_product_marked;

notify pgrst, 'reload schema';

commit;
