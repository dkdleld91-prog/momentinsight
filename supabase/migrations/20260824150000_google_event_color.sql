begin;

-- 일정별 색상(구글 event.colorId).
-- 구글 캘린더는 "캘린더 색"과 "일정에 지정한 색"이 따로 있고, 화면은 후자를
-- 우선해 칠한다. 그 우선순위를 재현하려면 일정마다 colorId 를 들고 있어야 한다.
-- 가산(additive) · 멱등(idempotent)이라 재실행해도 안전하다.
-- 새 테이블이 없으므로 RLS/권한은 schedule_items 의 것을 그대로 쓴다.

alter table public.schedule_items add column if not exists google_color_id text;

-- 이벤트 팔레트의 id 는 "1".."11" 뿐이다. 문자열로 들어오므로 길이만이 아니라
-- 값 자체를 좁혀 둔다 — 화면이 팔레트 표에서 못 찾는 값을 받으면 색이 사라진다.
do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_google_color_id_allowed
    check (google_color_id is null or google_color_id in (
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'
    ));
exception when duplicate_object then null; end $$;

comment on column public.schedule_items.google_color_id is
  '구글 event.colorId("1".."11"). 비어 있으면 이 일정은 캘린더 색을 따른다. 화면은 colorId 색을 먼저 쓴다.';

commit;
