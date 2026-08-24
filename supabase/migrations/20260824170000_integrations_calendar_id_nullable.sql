begin;

-- 전용 "모먼트 인사이트" 캘린더 폐지(2026-08-24 대개편) 이후 연결 저장은
-- calendar_id 를 null(기본 캘린더 사용)로 기록한다. 옛 설계의 not null 제약이
-- 남아 있어 재연결 upsert 가 23502 로 거부되던 결함을 해소한다. 재실행 안전.
alter table public.owner_google_integrations
  alter column calendar_id drop not null;

comment on column public.owner_google_integrations.calendar_id is
  'null = 대표 기본 캘린더 사용(전용 캘린더 폐지 이후 표준). 값이 있으면 레거시 전용 캘린더로, 동기화가 회수한다.';

commit;
