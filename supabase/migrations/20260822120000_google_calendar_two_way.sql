begin;

-- 구글 캘린더 양방향 동기화.
-- schedule_items 에 구글 이벤트 상태 열을 더하고, 캘린더별 증분 동기화 토큰
-- 저장소를 만든다. 새 테이블은 정책 없는 RLS로 service_role만 접근한다.

-- ─────────────────────────────────────────────────────────────
-- 1) schedule_items: 구글 이벤트 동기화 상태
-- ─────────────────────────────────────────────────────────────
alter table public.schedule_items add column if not exists google_calendar_id text;
alter table public.schedule_items add column if not exists google_etag text;
alter table public.schedule_items add column if not exists google_updated_at timestamptz;
alter table public.schedule_items add column if not exists google_source text not null default 'mi';
alter table public.schedule_items add column if not exists google_sync_state text;
alter table public.schedule_items add column if not exists google_sync_error text;
alter table public.schedule_items add column if not exists google_synced_at timestamptz;
alter table public.schedule_items add column if not exists google_html_link text;
alter table public.schedule_items add column if not exists google_recurring_event_id text;
alter table public.schedule_items add column if not exists google_location text;
alter table public.schedule_items add column if not exists google_description text;
alter table public.schedule_items add column if not exists google_attendees jsonb;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_google_source_allowed
    check (google_source in ('mi', 'google'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_google_sync_state_allowed
    check (google_sync_state is null or google_sync_state in ('pending', 'synced', 'failed'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_google_sync_error_length
    check (google_sync_error is null or char_length(google_sync_error) <= 500);
exception when duplicate_object then null; end $$;

-- 캘린더 id가 있으면 이벤트 id도 반드시 있다(짝 무결성).
do $$ begin
  alter table public.schedule_items
    add constraint schedule_items_google_event_pairing
    check (google_calendar_id is null or google_event_id is not null);
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────
-- 2) 이미 구글로 밀린 기존 행 재연결.
--    상태를 'synced' 가 아니라 'pending' 으로 둔다: 첫 동기화가 이 행들을
--    한 번 다시 밀어 확장 속성(miStatus 등)을 심어야 이후 inbound 의
--    "✓ " 접두사 제거 규칙이 성립한다. 그 순서가 없으면 첫 full sync 가
--    "✓ 제목" 을 MI 제목에 그대로 덮어써 제목이 오염된다.
-- ─────────────────────────────────────────────────────────────
update public.schedule_items as item
set google_calendar_id = integration.calendar_id,
    google_source = 'mi',
    google_sync_state = 'pending'
from public.owner_google_integrations as integration
where integration.owner_agency_code = item.owner_agency_code
  and item.google_event_id is not null
  and item.google_calendar_id is null;

-- 백필 이후에 만든다. 부분 유니크 인덱스가 중복 import 를 물리적으로 막는다.
create unique index if not exists uq_schedule_items_google_event
on public.schedule_items (google_calendar_id, google_event_id)
where google_event_id is not null and google_calendar_id is not null;

create index if not exists idx_schedule_items_google_retry
on public.schedule_items (owner_agency_code, google_sync_state)
where google_sync_state in ('pending', 'failed');

-- ─────────────────────────────────────────────────────────────
-- 3) owner_google_integrations: 배너 상태 + 스로틀 기준점
-- ─────────────────────────────────────────────────────────────
alter table public.owner_google_integrations add column if not exists last_sync_at timestamptz;
alter table public.owner_google_integrations add column if not exists last_sync_attempt_at timestamptz;
alter table public.owner_google_integrations add column if not exists sync_status text not null default 'ok';
alter table public.owner_google_integrations add column if not exists sync_error text;

do $$ begin
  alter table public.owner_google_integrations
    add constraint owner_google_integrations_sync_status_allowed
    check (sync_status in ('ok', 'error', 'needs_reconnect'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.owner_google_integrations
    add constraint owner_google_integrations_sync_error_length
    check (sync_error is null or char_length(sync_error) <= 500);
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────
-- 4) 캘린더별 동기화 상태 (Phase 2 push 채널 열 포함)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.owner_google_calendar_sync (
  owner_agency_code text not null
    references public.owner_google_integrations(owner_agency_code) on delete cascade,
  google_calendar_id text not null,
  calendar_role text not null default 'secondary',
  sync_token text,
  full_sync_page_token text,
  window_start timestamptz,
  window_end timestamptz,
  last_synced_at timestamptz,
  last_full_sync_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  channel_id text,
  channel_resource_id text,
  channel_token text,
  channel_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_agency_code, google_calendar_id),
  constraint owner_google_calendar_sync_role_allowed
    check (calendar_role in ('primary', 'dedicated', 'secondary')),
  constraint owner_google_calendar_sync_error_length
    check (last_error is null or char_length(last_error) <= 500)
);

create unique index if not exists uq_owner_google_calendar_sync_channel
on public.owner_google_calendar_sync (channel_id)
where channel_id is not null;

alter table public.owner_google_calendar_sync enable row level security;
alter table public.owner_google_calendar_sync force row level security;

revoke all on table public.owner_google_calendar_sync
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.owner_google_calendar_sync to service_role;

drop trigger if exists trg_owner_google_calendar_sync_updated_at
  on public.owner_google_calendar_sync;
create trigger trg_owner_google_calendar_sync_updated_at
before update on public.owner_google_calendar_sync
for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 5) 서버 측 스로틀: 단일 UPDATE 로 경합 없이 슬롯을 선점한다.
--    NULL 반환 = 스로틀됨(또는 연동 없음).
-- ─────────────────────────────────────────────────────────────
create or replace function public.mi_claim_google_sync_slot(
  p_owner_agency_code text,
  p_min_seconds integer
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claimed timestamptz;
begin
  if p_min_seconds is null or p_min_seconds < 0 or p_min_seconds > 3600 then
    raise exception using errcode = '22023', message = 'invalid_sync_throttle_window';
  end if;

  update public.owner_google_integrations
  set last_sync_attempt_at = now()
  where owner_agency_code = lower(btrim(coalesce(p_owner_agency_code, '')))
    and (
      last_sync_attempt_at is null
      or last_sync_attempt_at < now() - make_interval(secs => p_min_seconds)
    )
  returning last_sync_attempt_at into v_claimed;

  return v_claimed;
end;
$$;

revoke execute on function public.mi_claim_google_sync_slot(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_google_sync_slot(text, integer) to service_role;

-- ─────────────────────────────────────────────────────────────
comment on table public.owner_google_calendar_sync is
  '대표 계정 구글 캘린더별 증분 동기화 토큰과 push 채널 상태. 정책 없는 RLS로 service_role만 접근한다.';
comment on column public.schedule_items.google_calendar_id is
  '이 일정이 실제로 존재하는 구글 캘린더 id. MI 발신은 전용 캘린더, 구글 유입은 원래 캘린더를 가리킨다.';
comment on column public.schedule_items.google_updated_at is
  '마지막으로 반영한 구글 updated 시각. 이보다 오래된 inbound 는 우리가 쓴 메아리로 보고 무시한다.';
comment on column public.schedule_items.google_sync_state is
  'NULL은 구글 동기화 대상이 아님. pending/failed 는 다음 동기화에서 재시도한다.';
comment on column public.schedule_items.google_source is
  'mi = MI에서 만든 일정, google = 구글 캘린더에서 유입된 일정.';

commit;
