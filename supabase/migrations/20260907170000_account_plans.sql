-- 계정 플랜·이용 기간(대표 결정 2026-09-07): 총관리자가 수기로 오픈·연장한다. 만료 후 5일(유예) 안에 연장이
-- 없으면 계정 데이터 삭제 대상이 된다(삭제 실행은 2단계, 별도 승인). 순위 수집 표와 무관한 열 추가만 한다.
-- 사양: docs/drafts/account-plan-management-spec.md §1

alter table public.clients
  add column if not exists plan_name text,
  add column if not exists plan_days integer,
  add column if not exists plan_started_at timestamptz,
  add column if not exists plan_expires_at timestamptz,
  add column if not exists plan_note text,
  add column if not exists plan_updated_at timestamptz;

do $$ begin
  alter table public.clients
    add constraint clients_plan_days_range
    check (plan_days is null or plan_days between 1 and 3650);
exception when duplicate_object then null;
end $$;

create index if not exists clients_plan_expires_at_idx
  on public.clients (plan_expires_at)
  where plan_expires_at is not null;

comment on column public.clients.plan_name is '플랜 이름(기본·프리미엄·직접). null = 미설정.';
comment on column public.clients.plan_days is '기간 단위(일). 연장 시 기본값. null = 30.';
comment on column public.clients.plan_started_at is '이용 시작 시각(첫 오픈).';
comment on column public.clients.plan_expires_at is '이용 만료 시각. null = 무기한. 만료 후 5일 유예, 그 뒤 삭제 대상.';
comment on column public.clients.plan_note is '총관리자 메모(결제 방식·담당자 등).';
