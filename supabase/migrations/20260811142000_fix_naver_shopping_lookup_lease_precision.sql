begin;

create or replace function public.mi_claim_naver_shopping_rank_lookup_job(
  p_lease_seconds integer default 2100
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
declare
  v_lease_started_at timestamptz := date_trunc('milliseconds', clock_timestamp());
begin
  if p_lease_seconds < 60 or p_lease_seconds > 2100 then
    raise exception 'rank_lookup_lease_invalid';
  end if;

  return query
  with candidate as (
    select job.id
    from public.naver_shopping_rank_lookup_jobs as job
    where job.expires_at > v_lease_started_at
      and job.attempts < 3
      and (
        (job.status = 'pending' and job.available_at <= v_lease_started_at)
        or (job.status = 'processing' and job.processing_until < v_lease_started_at)
      )
    order by job.available_at asc, job.created_at asc
    limit 1
    for update skip locked
  )
  update public.naver_shopping_rank_lookup_jobs as job
  set status = 'processing',
      processing_started_at = v_lease_started_at,
      processing_until = v_lease_started_at + make_interval(secs => p_lease_seconds),
      updated_at = v_lease_started_at,
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
    or (
      v_job.processing_started_at is distinct from p_lease_started_at
      and date_trunc('milliseconds', v_job.processing_started_at)
        is distinct from date_trunc('milliseconds', p_lease_started_at)
    )
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
    and (
      processing_started_at = p_lease_started_at
      or date_trunc('milliseconds', processing_started_at)
        = date_trunc('milliseconds', p_lease_started_at)
    );

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.mi_claim_naver_shopping_rank_lookup_job(integer)
from public, anon, authenticated, service_role;
revoke all on function public.mi_complete_naver_shopping_rank_lookup_job(uuid, timestamptz, text, timestamptz, jsonb, text)
from public, anon, authenticated, service_role;
revoke all on function public.mi_fail_naver_shopping_rank_lookup_job(uuid, timestamptz, text)
from public, anon, authenticated, service_role;
grant execute on function public.mi_claim_naver_shopping_rank_lookup_job(integer)
to service_role;
grant execute on function public.mi_complete_naver_shopping_rank_lookup_job(uuid, timestamptz, text, timestamptz, jsonb, text)
to service_role;
grant execute on function public.mi_fail_naver_shopping_rank_lookup_job(uuid, timestamptz, text)
to service_role;

commit;
