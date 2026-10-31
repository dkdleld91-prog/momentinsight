-- N30 그룹상품 옵션 확인일 (대표 요청 2026-10-31, 옵션 번호 정식 기능 B6): 시각 칸 하나를 더한다.
-- 사람이 관리자 옵션 편집창에서 전체 목록을 보고 저장했거나 '확인만 기록'을 누른 시각이다.
-- 후보 넣기 저장(기존 목록에 후보 몇 개를 더하는 경로)은 이 칸을 바꾸지 않는다. 실제로 저장된 추적에만 쓴다.
-- 관리자 카드의 '옵션 확인 10/31' · '옵션 다시 확인'(30일) · '옵션 확인 기록 없음' 표시에만 쓴다. 순위 판정·수집에는 쓰지 않는다.
-- 기존 행은 비어 있음(기록 없음)으로 시작하고 기본값은 없다. 옵션 번호 칸·제약은 건드리지 않는다. 다시 실행해도 안전하다.
-- 칸 이름에 옵션 번호 칸 이름을 넣지 않는다 — 옵션 칸 없음 판정이 오류 문구의 그 글자를 보기 때문이다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.naver_rank_trackers
  add column if not exists option_checked_at timestamptz;

comment on column public.naver_rank_trackers.option_checked_at is
  'N30 그룹상품 옵션 확인일. 관리자 옵션 편집창에서 전체 목록을 보고 저장했거나 확인만 기록을 누른 시각(실제로 저장된 추적에만). 후보 넣기 저장은 바꾸지 않는다. 관리자 카드 표시에만 쓰고 순위 판정·수집에는 쓰지 않는다. 비어 있으면 기록 없음이다.';

notify pgrst, 'reload schema';

commit;
