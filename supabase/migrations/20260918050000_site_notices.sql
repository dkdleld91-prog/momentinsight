-- 2026-09-18: 운영 공지 팝업(대표 결정). 총관리자가 관리자 화면에서 제목·본문·표시 기간·표시 여부를
-- 저장하고, 로그인한 모든 화면(광고주·운영팀·총관리자)이 활성 공지를 팝업으로 한 번 본다.
-- 공지는 단일 행(id = 1)만 쓴다. 첫 공지(9/18 ~ 9/20 KST, 추적 서버 점검)를 함께 심는다.
begin;
create table if not exists public.site_notices (
  id smallint primary key,
  title text not null,
  body text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint site_notices_single_row check (id = 1),
  constraint site_notices_title_length check (char_length(title) between 1 and 80),
  constraint site_notices_body_length check (char_length(body) between 1 and 600),
  constraint site_notices_window check (ends_at >= starts_at)
);
alter table public.site_notices enable row level security;
revoke all on table public.site_notices from public, anon, authenticated;
grant select, insert, update on table public.site_notices to service_role;
insert into public.site_notices (id, title, body, starts_at, ends_at, enabled, updated_by)
values (
  1,
  'N 30일 추적 서버 점검 안내',
  '프로그램 개발로 인한 N 30일 추적 서버 점검이 진행 중입니다.
점검 기간 동안 순위 수집이 지연되거나 결과 반영이 늦어질 수 있습니다.
9월 20일 완료 예정입니다.',
  '2026-09-17 15:00:00+00',
  '2026-09-20 14:59:59.999+00',
  true,
  'migration'
)
on conflict (id) do nothing;
commit;
