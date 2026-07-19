begin;

create table if not exists public.code_login_rate_limits (
  key_hash text primary key check (length(key_hash) = 64),
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now()
);

alter table public.code_login_rate_limits enable row level security;
create index if not exists code_login_rate_limits_updated_at_idx
  on public.code_login_rate_limits(updated_at);
revoke all on table public.code_login_rate_limits from anon, authenticated;
grant all on table public.code_login_rate_limits to service_role;

create or replace function public.consume_code_login_rate_limit(
  p_key_hash text,
  p_window_seconds integer default 900,
  p_attempt_limit integer default 5
)
returns table(allowed boolean, retry_after integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval;
  v_row public.code_login_rate_limits%rowtype;
begin
  if p_key_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid rate limit key';
  end if;
  if p_window_seconds < 60 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit window';
  end if;
  if p_attempt_limit < 3 or p_attempt_limit > 100 then
    raise exception 'invalid attempt limit';
  end if;

  v_window := make_interval(secs => p_window_seconds);
  delete from public.code_login_rate_limits
  where updated_at < v_now - interval '7 days';
  perform pg_advisory_xact_lock(hashtextextended(p_key_hash, 0));

  select * into v_row
  from public.code_login_rate_limits
  where key_hash = p_key_hash
  for update;

  if not found or v_row.window_started_at + v_window <= v_now then
    insert into public.code_login_rate_limits(key_hash, window_started_at, attempt_count, updated_at)
    values (p_key_hash, v_now, 1, v_now)
    on conflict (key_hash) do update
      set window_started_at = excluded.window_started_at,
          attempt_count = 1,
          updated_at = excluded.updated_at;
    return query select true, 0;
    return;
  end if;

  if v_row.attempt_count >= p_attempt_limit then
    return query select false, greatest(1, ceil(extract(epoch from (v_row.window_started_at + v_window - v_now)))::integer);
    return;
  end if;

  update public.code_login_rate_limits
  set attempt_count = attempt_count + 1,
      updated_at = v_now
  where key_hash = p_key_hash;
  return query select true, 0;
end;
$$;

revoke all on function public.consume_code_login_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_code_login_rate_limit(text, integer, integer) to service_role;

commit;
