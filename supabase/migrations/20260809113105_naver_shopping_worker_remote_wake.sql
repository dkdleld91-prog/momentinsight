begin;

create table if not exists public.naver_shopping_worker_wakes (
  worker_key text primary key check (worker_key = 'chrome-primary'),
  requested_at timestamptz not null,
  consumed_at timestamptz,
  source text not null check (char_length(source) between 3 and 64),
  updated_at timestamptz not null default now(),
  check (consumed_at is null or consumed_at <= requested_at)
);

alter table public.naver_shopping_worker_wakes enable row level security;
alter table public.naver_shopping_worker_wakes force row level security;
revoke all on table public.naver_shopping_worker_wakes from public, anon, authenticated, service_role;
grant select, insert, update on table public.naver_shopping_worker_wakes to service_role;

create or replace function public.mi_request_naver_shopping_worker_wake(
  p_source text
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_source text;
begin
  normalized_source := left(lower(trim(coalesce(p_source, ''))), 64);
  if normalized_source !~ '^[a-z0-9][a-z0-9:_-]{2,63}$' then
    raise exception 'naver_shopping_worker_wake_source_invalid';
  end if;

  insert into public.naver_shopping_worker_wakes(
    worker_key,
    requested_at,
    consumed_at,
    source,
    updated_at
  ) values (
    'chrome-primary',
    clock_timestamp(),
    null,
    normalized_source,
    clock_timestamp()
  )
  on conflict (worker_key) do update
  set requested_at = clock_timestamp(),
      source = excluded.source,
      updated_at = clock_timestamp();

  return true;
end;
$$;

revoke all on function public.mi_request_naver_shopping_worker_wake(text)
from public, anon, authenticated, service_role;
grant execute on function public.mi_request_naver_shopping_worker_wake(text)
to service_role;

create or replace function public.mi_claim_naver_shopping_worker_wake()
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed_count integer := 0;
begin
  update public.naver_shopping_worker_wakes
  set consumed_at = requested_at,
      updated_at = clock_timestamp()
  where worker_key = 'chrome-primary'
    and (consumed_at is null or consumed_at < requested_at);

  get diagnostics claimed_count = row_count;
  return claimed_count = 1;
end;
$$;

revoke all on function public.mi_claim_naver_shopping_worker_wake()
from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_worker_wake()
to service_role;

commit;
