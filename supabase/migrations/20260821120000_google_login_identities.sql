begin;

-- 구글 계정(sub)과 기존 접속 코드를 잇는 계정 링킹 저장소.
-- RLS 정책을 만들지 않아 service_role(서버 핸들러) 전용으로만 접근한다.
create table if not exists public.login_identities (
  google_sub text primary key,
  google_email text,
  role text not null,
  code text not null,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 같은 역할의 같은 코드에는 구글 계정을 하나만 연결한다.
create unique index if not exists login_identities_role_code_key
on public.login_identities (role, code);

alter table public.login_identities enable row level security;
alter table public.login_identities force row level security;

revoke all on table public.login_identities from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.login_identities to service_role;

drop trigger if exists trg_login_identities_updated_at on public.login_identities;
create trigger trg_login_identities_updated_at
before update on public.login_identities
for each row execute function public.set_updated_at();

comment on table public.login_identities is
  '구글 계정과 기존 코드의 매핑(계정 링킹). 정책 없는 RLS로 service_role만 접근한다.';

commit;
