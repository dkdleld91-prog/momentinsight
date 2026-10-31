-- ROLLBACK for supabase/migrations/20261031120000_naver_rank_option_checked_at.sql
-- (N30 그룹상품 옵션 확인일 칸 되돌리기. 대표가 Supabase SQL Editor 에서 되돌릴 때만 실행한다.)
-- 서버 코드는 칸이 없어도 견딘다(번호 저장은 그대로 되고 확인일만 기록 안 됨·카드 확인일 표시 숨김). 권장 순서는 코드 되돌린 뒤.
-- 칸을 지우면 기록한 옵션 확인일도 함께 사라진다. 넣은 옵션 번호·그룹상품 표시·순위 기록(스냅샷)은 지우지 않는다.
-- 되돌린 뒤 적용 확인문(docs/sql/n30-group-4-option-checked-at.verify-applied.sql)을 돌리면
-- 'column "option_checked_at" does not exist' 오류로 끝난다. 칸이 지워졌다는 뜻이라 되돌린 뒤에는 이 오류가 정상이다.
-- 다시 적용하려면 docs/sql/n30-group-4-option-checked-at.sql 을 실행한다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.naver_rank_trackers
  drop column if exists option_checked_at;

notify pgrst, 'reload schema';

commit;
