-- N30 그룹상품 추적 (대표 승인 2026-10-23): 추적 하나에 같은 그룹상품의 다른 옵션 상품번호 목록을 붙인다.
-- 300개 결과에서 이 번호가 붙은 오가닉 카드가 보이면 그 위치도 순위 후보로 본다(판정은 서버). 넣은 옵션
-- 번호는 대표 상품번호(원부 포함)와 비교해 가장 높은 순위를 쓰고(같으면 대표), 다른 스토어로 확인된 번호만 뺀다.
-- 다시 실행해도 안전하다. 기존 행은 빈 목록('{}')으로 시작해 동작이 그대로다.
-- 최대 개수(20)를 나중에 바꾸면 이 파일을 고친 최신 사본만 실행한다(옛 사본을 다시 돌리면 20으로 돌아간다).
-- 대표 번호가 목록에 섞이는 것·중복은 서버가 막는다. 커밋 RPC 가 빈 product_id 를 채우는 갱신이
-- 이 제약에 걸려 수집이 실패하지 않도록, 제약은 product_id 를 보지 않는다.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.naver_rank_trackers
  add column if not exists option_product_ids text[] not null default '{}'::text[];

alter table public.naver_rank_trackers
  drop constraint if exists naver_rank_trackers_option_product_ids_shape;

-- 왕복 일치(string_to_array(array_to_string(x)) = x)가 빈 칸('')·쉼표가 든 칸·NULL 칸·2차원·
-- 첫 번호가 1이 아닌 배열을 모두 막는다. 정규식은 칸마다 숫자 5~20자리만 허용한다.
alter table public.naver_rank_trackers
  add constraint naver_rank_trackers_option_product_ids_shape check (
    pg_catalog.cardinality(option_product_ids) <= 20
    and pg_catalog.array_to_string(option_product_ids, ',')
      ~ '^([0-9]{5,20}(,[0-9]{5,20})*)?$'
    and pg_catalog.string_to_array(pg_catalog.array_to_string(option_product_ids, ','), ',')
      = option_product_ids
  );

comment on column public.naver_rank_trackers.option_product_ids is
  'N30 그룹상품: 같은 그룹상품의 다른 옵션 상품번호. 300개 결과에서 이 번호가 붙은 오가닉 카드가 보이면 그 위치도 순위 후보로 본다. 대표 번호(원부 포함)와 비교해 가장 높은 순위를 쓰고(같으면 대표), 다른 스토어로 확인된 번호만 뺀다. 빈 목록이면 대표 번호만 본다(기존 동작).';

notify pgrst, 'reload schema';

commit;
