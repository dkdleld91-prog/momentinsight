-- N30 그룹상품 옵션 번호 최대 개수 20 → 50 (대표 요청 2026-10-27: 핸드폰 필름 옵션 24개).
-- 칸 모양 검사(naver_rank_trackers_option_product_ids_shape)의 개수 상한만 바꾼다. 번호 모양 규칙(숫자 5~20자리,
-- 빈 칸·쉼표 칸·NULL 칸·2차원 거절)은 그대로다. 다시 실행해도 안전하다. 기존 행은 바뀌지 않는다.
-- 서버가 50개까지 받는 버전보다 먼저 실행해야 한다(이 SQL 전 서버는 20개까지만 보내므로 먼저 실행해도 안전).
-- 주의: 옛 사본 n30-group-1-option-product-ids.sql 을 다시 실행하면 상한이 20으로 돌아간다 — 그 뒤에는 이 파일을 다시 실행한다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.naver_rank_trackers
  drop constraint if exists naver_rank_trackers_option_product_ids_shape;

alter table public.naver_rank_trackers
  add constraint naver_rank_trackers_option_product_ids_shape check (
    pg_catalog.cardinality(option_product_ids) <= 50
    and pg_catalog.array_to_string(option_product_ids, ',')
      ~ '^([0-9]{5,20}(,[0-9]{5,20})*)?$'
    and pg_catalog.string_to_array(pg_catalog.array_to_string(option_product_ids, ','), ',')
      = option_product_ids
  );

notify pgrst, 'reload schema';

commit;
