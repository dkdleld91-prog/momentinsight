-- C 30일 ① '지금 확인' 확장 1.0.1 실패 진단 칸 (대표 승인 2026-10-24 "네 추천대로 진행해주세요").
-- 회차 표(coupang_rank_runs)에 진단 칸 하나를 더한다. 확장이 실패(또는 성공) 때 남긴 짧은 기록(단계별 경과·load 횟수·
-- 쪽 함수 결과 종류·쪽 모양 요약·재시도 여부)을 서버가 모양·크기를 본 뒤 그 회차에 따로 적는다(지금 확인 회차만).
-- 다시 실행해도 안전하다. 기존 행은 빈 칸(null)으로 시작하고, 순위 기록·자동 수집·화면 동작은 그대로다.
-- 칸이 없어도(이 SQL 전) 서버는 진단만 건너뛰고 기록은 그대로 한다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.coupang_rank_runs
  add column if not exists diagnostics jsonb null;

alter table public.coupang_rank_runs
  drop constraint if exists coupang_rank_runs_diagnostics_shape;

-- 객체 하나, 8KB 이하. 서버는 직렬화 4KB·값 120개 이하만 보낸다(jsonb 는 작은 수·짧은 칸마다 글자보다 크게 저장되지만
-- 그 범위의 최악도 약 5.4KB — PGlite 시험). 그래서 이 제약은 넉넉한 바깥 울타리다.
alter table public.coupang_rank_runs
  add constraint coupang_rank_runs_diagnostics_shape check (
    diagnostics is null
    or (pg_catalog.jsonb_typeof(diagnostics) = 'object' and pg_catalog.pg_column_size(diagnostics) <= 8192)
  );

comment on column public.coupang_rank_runs.diagnostics is
  'C30 지금 확인 확장(1.0.1~) 진단: 단계별 경과 ms·탭 load 횟수·쪽 함수 결과 종류·쪽 모양 요약(제목·본문 앞부분·상품 칸 수)·재시도 여부. 개인 정보 없음, 서버가 모양·4KB 를 본 뒤 기록 RPC 가 성공한 회차에만 따로 적는다. 자동 수집 회차는 비어 있다.';

notify pgrst, 'reload schema';

commit;
