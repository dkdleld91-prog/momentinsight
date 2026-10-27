-- N30 그룹상품 후보 (대표 승인 2026-10-27 A안): 관리자 카드의 '그룹상품으로 표시' 버튼 상태 칸 하나를 더한다.
-- 표시한 추적(또는 옵션 번호가 1개 이상 있는 추적)만, 대표 상품번호·넣은 옵션 번호가 300개 결과에 없을 때
-- 같은 스토어의 비슷한 오가닉 카드를 '후보'로 스냅샷에 남긴다(판정은 서버, 네이버 요청 증가 0).
-- 후보는 순위에 쓰지 않는다. 대표가 확인 창에서 골라 넣은 번호(option_product_ids)만 다음 확인부터 쓴다.
-- 이 칸은 표시 하나만 담는다(옵션 번호 칸과 뜻이 다르다). 다시 실행해도 안전하다.
-- 기존 행은 false(표시 안 함)로 시작해 동작이 그대로다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.naver_rank_trackers
  add column if not exists group_product_marked boolean not null default false;

comment on column public.naver_rank_trackers.group_product_marked is
  'N30 그룹상품 표시(관리자 카드 버튼, 같은 대표 상품번호 추적에 함께 적용). true 면 대표 상품번호·옵션 번호가 300개 결과에 없을 때 같은 스토어의 비슷한 오가닉 카드를 후보로 스냅샷에 남긴다(순위에는 쓰지 않음). 옵션 번호가 있는 추적은 이 칸과 상관없이 그룹상품이다. false 면 지금 동작 그대로다.';

notify pgrst, 'reload schema';

commit;
