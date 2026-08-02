create table if not exists public.naver_shopping_rank_lookup_jobs (
  id uuid primary key default gen_random_uuid(),
  scope_hash text not null check (scope_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  keyword text not null check (char_length(keyword) between 1 and 100),
  product_url text,
  product_id text,
  target_catalog_id text,
  mall_name text,
  product_title text,
  max_rank smallint not null default 300 check (max_rank = 300),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'expired')),
  available_at timestamptz not null default now(),
  processing_started_at timestamptz,
  processing_until timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 3),
  collection_id text,
  checked_at timestamptz,
  result jsonb,
  message text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  check (product_url is not null or product_id is not null or target_catalog_id is not null)
);

alter table public.naver_shopping_rank_lookup_jobs enable row level security;
alter table public.naver_shopping_rank_lookup_jobs force row level security;

revoke all on table public.naver_shopping_rank_lookup_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.naver_shopping_rank_lookup_jobs to service_role;

create unique index if not exists naver_shopping_rank_lookup_jobs_active_request_uidx
  on public.naver_shopping_rank_lookup_jobs (scope_hash, request_hash)
  where status in ('pending', 'processing');

create index if not exists naver_shopping_rank_lookup_jobs_claim_idx
  on public.naver_shopping_rank_lookup_jobs (available_at, created_at)
  where status in ('pending', 'processing');

create index if not exists naver_shopping_rank_lookup_jobs_scope_poll_idx
  on public.naver_shopping_rank_lookup_jobs (scope_hash, id);

create or replace function public.mi_enqueue_naver_shopping_rank_lookup_job(
  p_scope_hash text,
  p_request_hash text,
  p_keyword text,
  p_product_url text default null,
  p_product_id text default null,
  p_target_catalog_id text default null,
  p_mall_name text default null,
  p_product_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.naver_shopping_rank_lookup_jobs%rowtype;
  v_inserted public.naver_shopping_rank_lookup_jobs%rowtype;
  v_active_count integer;
begin
  if p_scope_hash !~ '^[0-9a-f]{64}$'
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or nullif(btrim(p_keyword), '') is null
    or (nullif(btrim(coalesce(p_product_url, '')), '') is null
      and nullif(btrim(coalesce(p_product_id, '')), '') is null
      and nullif(btrim(coalesce(p_target_catalog_id, '')), '') is null) then
    raise exception 'rank_lookup_job_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_scope_hash, 0));

  update public.naver_shopping_rank_lookup_jobs
  set status = 'expired',
      processing_started_at = null,
      processing_until = null,
      updated_at = now()
  where scope_hash = p_scope_hash
    and status in ('pending', 'processing')
    and expires_at <= now();

  select * into v_existing
  from public.naver_shopping_rank_lookup_jobs
  where scope_hash = p_scope_hash
    and request_hash = p_request_hash
    and status in ('pending', 'processing')
    and expires_at > now()
  order by created_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'id', v_existing.id,
      'status', v_existing.status,
      'deduplicated', true,
      'expiresAt', v_existing.expires_at
    );
  end if;

  select count(*) into v_active_count
  from public.naver_shopping_rank_lookup_jobs
  where scope_hash = p_scope_hash
    and status in ('pending', 'processing')
    and expires_at > now();

  if v_active_count >= 5 then
    raise exception 'rank_lookup_queue_full';
  end if;

  insert into public.naver_shopping_rank_lookup_jobs (
    scope_hash,
    request_hash,
    keyword,
    product_url,
    product_id,
    target_catalog_id,
    mall_name,
    product_title
  ) values (
    p_scope_hash,
    p_request_hash,
    btrim(p_keyword),
    nullif(btrim(coalesce(p_product_url, '')), ''),
    nullif(btrim(coalesce(p_product_id, '')), ''),
    nullif(btrim(coalesce(p_target_catalog_id, '')), ''),
    nullif(btrim(coalesce(p_mall_name, '')), ''),
    nullif(btrim(coalesce(p_product_title, '')), '')
  )
  returning * into v_inserted;

  return jsonb_build_object(
    'id', v_inserted.id,
    'status', v_inserted.status,
    'deduplicated', false,
    'expiresAt', v_inserted.expires_at
  );
end;
$$;

create or replace function public.mi_claim_naver_shopping_rank_lookup_job(
  p_lease_seconds integer default 720
)
returns table (
  id uuid,
  keyword text,
  lease_started_at timestamptz,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds < 60 or p_lease_seconds > 900 then
    raise exception 'rank_lookup_lease_invalid';
  end if;

  return query
  with candidate as (
    select job.id
    from public.naver_shopping_rank_lookup_jobs as job
    where job.expires_at > now()
      and job.attempts < 3
      and (
        (job.status = 'pending' and job.available_at <= now())
        or (job.status = 'processing' and job.processing_until < now())
      )
    order by job.available_at asc, job.created_at asc
    limit 1
    for update skip locked
  )
  update public.naver_shopping_rank_lookup_jobs as job
  set status = 'processing',
      processing_started_at = now(),
      processing_until = now() + make_interval(secs => p_lease_seconds),
      updated_at = now(),
      error_code = null
  from candidate
  where job.id = candidate.id
  returning job.id, job.keyword, job.processing_started_at, job.processing_until;
end;
$$;

create or replace function public.mi_complete_naver_shopping_rank_lookup_job(
  p_job_id uuid,
  p_lease_started_at timestamptz,
  p_collection_id text,
  p_checked_at timestamptz,
  p_result jsonb,
  p_message text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.naver_shopping_rank_lookup_jobs%rowtype;
begin
  select * into v_job
  from public.naver_shopping_rank_lookup_jobs
  where id = p_job_id
  for update;

  if not found then return 'lease_lost'; end if;
  if v_job.status = 'completed' and v_job.collection_id = p_collection_id then
    return 'already_committed';
  end if;
  if v_job.status = 'completed' then return 'collection_conflict'; end if;
  if v_job.status <> 'processing'
    or v_job.processing_started_at is distinct from p_lease_started_at
    or v_job.processing_until <= now() then
    return 'lease_lost';
  end if;

  update public.naver_shopping_rank_lookup_jobs
  set status = 'completed',
      collection_id = p_collection_id,
      checked_at = p_checked_at,
      result = p_result,
      message = nullif(btrim(coalesce(p_message, '')), ''),
      error_code = null,
      processing_until = null,
      updated_at = now()
  where id = p_job_id;

  return 'committed';
end;
$$;

create or replace function public.mi_fail_naver_shopping_rank_lookup_job(
  p_job_id uuid,
  p_lease_started_at timestamptz,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  update public.naver_shopping_rank_lookup_jobs
  set attempts = least(attempts + 1, 3),
      status = case
        when attempts + 1 >= 3 or expires_at <= now() + interval '5 minutes' then 'failed'
        else 'pending'
      end,
      available_at = now() + interval '5 minutes',
      processing_started_at = null,
      processing_until = null,
      error_code = left(lower(coalesce(p_error, 'local_worker_collection_failed')), 80),
      updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and processing_started_at = p_lease_started_at;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.mi_enqueue_naver_shopping_rank_lookup_job(text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.mi_claim_naver_shopping_rank_lookup_job(integer) from public, anon, authenticated;
revoke all on function public.mi_complete_naver_shopping_rank_lookup_job(uuid, timestamptz, text, timestamptz, jsonb, text) from public, anon, authenticated;
revoke all on function public.mi_fail_naver_shopping_rank_lookup_job(uuid, timestamptz, text) from public, anon, authenticated;

grant execute on function public.mi_enqueue_naver_shopping_rank_lookup_job(text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.mi_claim_naver_shopping_rank_lookup_job(integer) to service_role;
grant execute on function public.mi_complete_naver_shopping_rank_lookup_job(uuid, timestamptz, text, timestamptz, jsonb, text) to service_role;
grant execute on function public.mi_fail_naver_shopping_rank_lookup_job(uuid, timestamptz, text) to service_role;
