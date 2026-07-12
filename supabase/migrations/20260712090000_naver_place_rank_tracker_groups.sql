begin;

alter table public.naver_place_rank_trackers
  add column if not exists group_name text;

update public.naver_place_rank_trackers
set group_name = '기본 그룹'
where group_name is null or btrim(group_name) = '';

alter table public.naver_place_rank_trackers
  alter column group_name set default '기본 그룹';

alter table public.naver_place_rank_trackers
  alter column group_name set not null;

create index if not exists idx_naver_place_rank_trackers_agency_group_sort
on public.naver_place_rank_trackers(agency_code, group_name, sort_order asc, created_at desc);

commit;
