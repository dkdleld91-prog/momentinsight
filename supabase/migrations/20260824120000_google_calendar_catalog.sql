begin;

-- 구글 캘린더 목록(사이드바) 카탈로그.
-- 20260823090000 이 만든 owner_google_calendar_sync 캐시에 "화면에 그리는 데
-- 필요한 것"만 열로 더한다. 새 테이블이 없으므로 RLS/권한은 그 마이그레이션이
-- 세운 것(정책 없는 RLS + service_role 전용)을 그대로 쓴다.
-- 전부 가산(additive) · 멱등(idempotent)이라 재실행해도 안전하다.

-- ─────────────────────────────────────────────────────────────
-- 1) 캘린더 색상 · 표시 여부
--    calendar_selected 는 구글이 준 값의 사본이고,
--    calendar_visible 은 MI 안에서만 쓰는 토글이다. 두 값을 나눠 두는 이유:
--    MI 에서 체크를 끈다고 구글 쪽 표시가 바뀌면 안 되기 때문이다.
--    (calendarList.selected 는 쓰기 가능한 필드지만 우리는 절대 쓰지 않는다.)
-- ─────────────────────────────────────────────────────────────
alter table public.owner_google_calendar_sync
  add column if not exists calendar_background_color text;
alter table public.owner_google_calendar_sync
  add column if not exists calendar_foreground_color text;
alter table public.owner_google_calendar_sync
  add column if not exists calendar_selected boolean not null default true;
alter table public.owner_google_calendar_sync
  add column if not exists calendar_visible boolean not null default true;

do $$ begin
  alter table public.owner_google_calendar_sync
    add constraint owner_google_calendar_sync_background_color_format
    check (calendar_background_color is null or calendar_background_color ~ '^#[0-9a-fA-F]{6}$');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.owner_google_calendar_sync
    add constraint owner_google_calendar_sync_foreground_color_format
    check (calendar_foreground_color is null or calendar_foreground_color ~ '^#[0-9a-fA-F]{6}$');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────
-- 2) 목록 조회 인덱스.
--    한 대표 계정의 캘린더는 많아야 수십 개라 성능 때문이 아니라,
--    "숨긴 캘린더" 조회가 항상 owner 범위 안에서만 일어남을 못박기 위해서다.
-- ─────────────────────────────────────────────────────────────
create index if not exists idx_owner_google_calendar_sync_hidden
on public.owner_google_calendar_sync (owner_agency_code)
where calendar_visible = false;

-- ─────────────────────────────────────────────────────────────
comment on column public.owner_google_calendar_sync.calendar_background_color is
  'calendarList.backgroundColor(#rrggbb). 사이드바 체크박스와 일정 칩 색으로 쓴다.';
comment on column public.owner_google_calendar_sync.calendar_foreground_color is
  'calendarList.foregroundColor(#rrggbb). 색칠한 칩 위의 글자색으로 쓴다.';
comment on column public.owner_google_calendar_sync.calendar_selected is
  'calendarList.selected 사본(구글에서 체크되어 있는가). 최초 1회 calendar_visible 의 기본값으로만 쓴다.';
comment on column public.owner_google_calendar_sync.calendar_visible is
  'MI 사이드바 체크 상태. false 면 목록·월간·아젠다·실장 브리핑에서 모두 제외된다. 구글로는 절대 되쓰지 않는다.';

commit;
