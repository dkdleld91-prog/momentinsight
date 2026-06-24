begin;

alter table public.naver_rank_trackers
add column if not exists sort_order integer not null default 1000;

with ranked as (
  select
    id,
    row_number() over (
      partition by agency_code
      order by created_at asc, id asc
    ) * 100 as next_sort_order
  from public.naver_rank_trackers
)
update public.naver_rank_trackers tracker
set sort_order = ranked.next_sort_order
from ranked
where tracker.id = ranked.id;

create index if not exists idx_naver_rank_trackers_agency_sort
on public.naver_rank_trackers(agency_code, sort_order asc, created_at desc);

commit;
