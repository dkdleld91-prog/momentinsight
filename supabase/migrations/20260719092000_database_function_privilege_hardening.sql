begin;

-- Trigger and event-trigger helpers are internal database machinery. They do
-- not need to be callable through the exposed public RPC surface.
revoke execute on function public.enforce_naver_rank_tracker_limit() from public, anon, authenticated;
grant execute on function public.enforce_naver_rank_tracker_limit() to service_role;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
grant execute on function public.rls_auto_enable() to service_role;

-- Pin name resolution for the shared timestamp trigger and remove anonymous
-- RPC access while retaining the roles that can legitimately write rows.
alter function public.set_updated_at() set search_path = pg_catalog, public;
revoke execute on function public.set_updated_at() from public, anon;
grant execute on function public.set_updated_at() to authenticated, service_role;

-- These two helpers are intentionally executable by authenticated because
-- existing RLS policies call them. Anonymous and PUBLIC RPC access is not
-- required and is removed without changing those policies.
revoke execute on function public.has_client_access(uuid) from public, anon;
grant execute on function public.has_client_access(uuid) to authenticated, service_role;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

commit;
