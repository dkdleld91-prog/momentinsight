begin;

-- 구글 캘린더 일정 상세(반복 규칙 · 화상 회의 링크 · 캘린더 이름)와
-- 쓰기 가능한 캘린더 목록 캐시. 새 테이블 없이 기존 두 테이블에 열만 더한다.
-- 전부 가산(additive) · 멱등(idempotent)이라 재실행해도 안전하다.

-- ─────────────────────────────────────────────────────────────
-- 1) schedule_items: 구글 일정 상세 미러
-- ─────────────────────────────────────────────────────────────
alter table public.schedule_items add column if not exists google_recurrence jsonb;
alter table public.schedule_items add column if not exists google_conference_uri text;
alter table public.schedule_items add column if not exists google_calendar_name text;

-- 반복 규칙은 RFC5545 라인의 "배열" 이다. 객체가 들어오면 페이로드 조립이
-- 조용히 깨지므로 모양을 열 제약으로 고정한다.
-- 모양과 길이를 한 제약으로 묶는다. 따로 두면 배열이 아닌 값이 들어올 때
-- jsonb_array_length 가 먼저 평가되어 제약 위반 대신 함수 오류가 난다.
do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_google_recurrence_shape
    check (
      google_recurrence is null
      or (jsonb_typeof(google_recurrence) = 'array' and jsonb_array_length(google_recurrence) <= 8)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_google_conference_uri_length
    check (google_conference_uri is null or char_length(google_conference_uri) <= 1000);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_google_calendar_name_length
    check (google_calendar_name is null or char_length(google_calendar_name) <= 200);
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────
-- 2) owner_google_calendar_sync: 쓰기 가능한 캘린더 목록 캐시.
--    GET /api/work-items 는 hot path 라 구글을 부를 수 없다. 목록은
--    동기화나 명시적 새로고침 때만 채우고 조회는 이 캐시에서만 한다.
-- ─────────────────────────────────────────────────────────────
alter table public.owner_google_calendar_sync add column if not exists calendar_summary text;
alter table public.owner_google_calendar_sync add column if not exists calendar_access_role text;
alter table public.owner_google_calendar_sync add column if not exists calendar_is_primary boolean not null default false;
alter table public.owner_google_calendar_sync add column if not exists calendar_writable boolean not null default false;
alter table public.owner_google_calendar_sync add column if not exists calendar_catalog_at timestamptz;

do $$ begin
  alter table public.owner_google_calendar_sync
    add constraint owner_google_calendar_sync_summary_length
    check (calendar_summary is null or char_length(calendar_summary) <= 200);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.owner_google_calendar_sync
    add constraint owner_google_calendar_sync_access_role_allowed
    check (calendar_access_role is null or calendar_access_role in (
      'freeBusyReader', 'reader', 'writer', 'owner', 'writerWithoutPrivateAccess'
    ));
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────
comment on column public.schedule_items.google_recurrence is
  '마스터 일정의 RFC5545 반복 라인 배열(RRULE/EXRULE/RDATE/EXDATE). 인스턴스 행에는 표시용 사본만 남는다.';
comment on column public.schedule_items.google_conference_uri is
  'Google Meet 등 화상 회의 참가 주소. 응답에 conferenceData 가 없으면 갱신하지 않는다(버전 0 응답은 이 필드를 담지 않는다).';
comment on column public.schedule_items.google_calendar_name is
  '이 일정이 저장된 구글 캘린더의 표시 이름. 캘린더 id 만으로는 화면에 무엇인지 알 수 없어 함께 캐시한다.';
comment on column public.owner_google_calendar_sync.calendar_summary is
  'calendarList 의 summaryOverride 또는 summary. 다이얼로그의 캘린더 선택 라벨로 쓴다.';
comment on column public.owner_google_calendar_sync.calendar_access_role is
  'calendarList.accessRole. writer/owner 만 쓰기 가능하다.';
comment on column public.owner_google_calendar_sync.calendar_is_primary is
  '구글 기본 캘린더 여부(calendarList item.primary).';
comment on column public.owner_google_calendar_sync.calendar_writable is
  'minAccessRole=writer 목록에 포함되어 쓰기 가능함이 확인된 캘린더.';
comment on column public.owner_google_calendar_sync.calendar_catalog_at is
  '캘린더 목록을 마지막으로 구글에서 새로 받은 시각.';

commit;
