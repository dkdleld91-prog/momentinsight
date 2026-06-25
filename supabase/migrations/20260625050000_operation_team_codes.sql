create table if not exists public.operation_team_codes (
  id uuid primary key default gen_random_uuid(),
  owner_agency_code text not null default 'mml93-a01',
  team_name text not null,
  team_code text unique not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  client_id uuid unique references public.clients(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table public.clients
add column if not exists issued_by_team_code text references public.operation_team_codes(team_code) on delete set null;

alter table public.clients
add column if not exists disconnected_at timestamptz;

drop trigger if exists trg_operation_team_codes_updated_at on public.operation_team_codes;
create trigger trg_operation_team_codes_updated_at before update on public.operation_team_codes
for each row execute function public.set_updated_at();

create index if not exists idx_operation_team_codes_owner_status
on public.operation_team_codes(owner_agency_code, status, created_at desc);

create index if not exists idx_clients_issued_by_team_code
on public.clients(issued_by_team_code, status);

alter table public.operation_team_codes enable row level security;

drop policy if exists operation_team_codes_admin_all on public.operation_team_codes;
create policy operation_team_codes_admin_all on public.operation_team_codes
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select, insert, update, delete on public.operation_team_codes to authenticated, service_role;
