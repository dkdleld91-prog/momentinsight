-- ROLLBACK for supabase/migrations/20261024120000_coupang_rank_run_diagnostics.sql
-- (C30 지금 확인 진단 칸 되돌리기. 대표가 Supabase SQL Editor 에서 되돌릴 때만 실행한다.)
-- 서버 코드는 칸이 없어도 견딘다(진단만 건너뛰고 순위 기록은 그대로). 칸을 지우면 쌓인 진단도 함께 사라진다.
-- 순위 기록(회차·스냅샷)은 지우지 않는다.
-- 되돌린 뒤 적용 확인문(docs/sql/c30-3-run-diagnostics.verify-applied.sql)을 돌리면 결과 줄 없이
-- 'column "diagnostics" does not exist' 오류만 나온다. 칸이 지워졌다는 뜻이라 되돌린 뒤에는 정상이다.
-- 다시 적용하려면 docs/sql/c30-3-run-diagnostics.sql 을 실행한다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.coupang_rank_runs
  drop constraint if exists coupang_rank_runs_diagnostics_shape;

alter table public.coupang_rank_runs
  drop column if exists diagnostics;

notify pgrst, 'reload schema';

commit;
