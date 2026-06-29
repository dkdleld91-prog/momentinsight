begin;

alter table public.naver_rank_trackers
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_until timestamptz,
  add column if not exists last_error text,
  add column if not exists retry_count integer not null default 0;

create index if not exists idx_naver_rank_trackers_due_processing
on public.naver_rank_trackers(status, next_check_at, processing_until)
where status = 'active';

commit;
