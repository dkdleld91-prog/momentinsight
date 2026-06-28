begin;

alter table public.clients add column if not exists disconnected_at timestamptz;

create or replace function public.has_client_access(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1
      from public.client_members cm
      join public.clients c on c.id = cm.client_id
      where cm.client_id = target_client_id
        and cm.user_id = auth.uid()
        and c.status = 'active'
        and c.disconnected_at is null
    );
$$;

create index if not exists idx_clients_active_access
on public.clients(id, status, disconnected_at);

create index if not exists idx_audit_logs_action_created
on public.audit_logs(action, created_at desc);

create index if not exists idx_audit_logs_target
on public.audit_logs(target_table, target_id);

grant execute on function public.has_client_access(uuid) to authenticated, service_role;

commit;
