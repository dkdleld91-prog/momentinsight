begin;

-- 계정 주체 키 확정 + 구글 이벤트 유일성 분리(P1).
-- 이 파일은 20260826090000_personal_calendar_workspaces.sql 다음에 실행한다.
-- 아래 유니크 인덱스가 그 파일이 만든 personal_role/personal_code 를 쓰므로,
-- 순서를 바꾸면 42703(열 없음)으로 실패한다.
-- 가산 · 멱등 · 재실행 안전. 새 테이블·정책·grant 없음.

-- ─────────────────────────────────────────────────────────────
-- 1) 계정 주체 키의 값 형식을 DB 에서 못 박는다.
--    테이블 구조는 건드리지 않는다. 대표님 행('mml93-a01')은 콜론이 없어
--    첫 갈래로 그대로 통과한다.
--    접두사를 두는 이유: 팀 코드 형식이 콜론을 허용하므로 접두사 없는 평면
--    키는 운영팀 키와 광고주 키가 같은 문자열이 될 수 있다. 코드가 실수해도
--    잘못된 키가 저장되지 않도록 형식 자체를 여기서 거절한다.
-- ─────────────────────────────────────────────────────────────
do $$ begin
  alter table public.owner_google_integrations
    add constraint owner_google_integrations_principal_shape
    check (
      owner_agency_code !~ ':'
      or owner_agency_code ~ '^(team|client):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    );
exception when duplicate_object then null; end $$;
-- owner_google_calendar_sync 는 FK 로 위 테이블을 가리키므로
-- (20260822120000_google_calendar_two_way.sql:97-98) 형식 검사가 그대로
-- 상속된다. 같은 제약을 한 번 더 걸 이유가 없다.

comment on column public.owner_google_integrations.owner_agency_code is
  '계정 주체 키. 대표=''mml93-a01''(불변), 그 외=''team:<uuid>'' / ''client:<uuid>''. 열 이름은 역사적 이유로 유지한다.';
comment on column public.owner_google_calendar_sync.owner_agency_code is
  '계정 주체 키(owner_google_integrations 와 동일 규칙). 열 이름은 역사적 이유로 유지한다.';

-- ─────────────────────────────────────────────────────────────
-- 2) 구글 이벤트 유일성을 계정별로 분리한다.
--    기존 uq_schedule_items_google_event 는 (google_calendar_id,
--    google_event_id) 전역 유일이라, 두 계정이 같은 공유 캘린더를 구독하면
--    두 번째 계정의 import 가 23505 로 통째로 실패한다. 개인 캘린더를 여러
--    계정에 여는 순간 반드시 터지는 지점이다.
--    coalesce 로 감싸는 이유: NULL <> NULL 이라 감싸지 않으면 레거시 운영
--    행(personal_role IS NULL)이 중복 제거 대상에서 통째로 빠진다.
--    새 인덱스를 먼저 만들고 옛 인덱스를 나중에 지우는 순서는 의도적이다.
--    반대로 하면 그 사이에 중복 방어가 없는 창이 생긴다.
-- ─────────────────────────────────────────────────────────────
create unique index if not exists uq_schedule_items_google_event_personal
on public.schedule_items (
  coalesce(personal_role, ''),
  coalesce(personal_code, ''),
  google_calendar_id,
  google_event_id
)
where google_event_id is not null and google_calendar_id is not null;

drop index if exists public.uq_schedule_items_google_event;

commit;
