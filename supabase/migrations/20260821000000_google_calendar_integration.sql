begin;

-- 대표(owner) 구글 캘린더 연동 자격 증명 저장소.
-- RLS 정책을 만들지 않아 service_role(서버 핸들러) 전용으로만 접근한다.
create table if not exists public.owner_google_integrations (
  owner_agency_code text primary key,
  refresh_token text not null,
  calendar_id text not null,
  google_email text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.owner_google_integrations enable row level security;
alter table public.owner_google_integrations force row level security;

revoke all on table public.owner_google_integrations from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.owner_google_integrations to service_role;

drop trigger if exists trg_owner_google_integrations_updated_at on public.owner_google_integrations;
create trigger trg_owner_google_integrations_updated_at
before update on public.owner_google_integrations
for each row execute function public.set_updated_at();

alter table public.schedule_items
add column if not exists google_event_id text;

comment on table public.owner_google_integrations is
  '대표 계정의 구글 캘린더 OAuth refresh token과 대상 캘린더. 정책 없는 RLS로 service_role만 접근한다.';
comment on column public.schedule_items.google_event_id is
  '구글 캘린더에 동기화된 일정의 이벤트 ID. NULL은 아직 동기화되지 않은 일정이다.';

commit;
