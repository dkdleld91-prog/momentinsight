begin;

-- Fail the migration rather than silently preserving ambiguous ownership.
-- Operators must resolve any pre-existing duplicate active assignments first.
create unique index if not exists clients_one_active_per_operation_team_idx
  on public.clients (issued_by_team_code)
  where issued_by_team_code is not null
    and status = 'active'
    and disconnected_at is null;

commit;
