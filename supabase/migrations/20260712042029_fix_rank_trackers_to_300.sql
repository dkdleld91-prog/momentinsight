begin;

update public.naver_rank_trackers
set max_rank = 300
where max_rank is distinct from 300;

alter table public.naver_rank_trackers
  drop constraint if exists naver_rank_trackers_max_rank_check;

alter table public.naver_rank_trackers
  alter column max_rank set default 300;

alter table public.naver_rank_trackers
  add constraint naver_rank_trackers_max_rank_check
  check (max_rank = 300);

update public.naver_place_rank_trackers
set max_rank = 300
where max_rank is distinct from 300;

alter table public.naver_place_rank_trackers
  drop constraint if exists naver_place_rank_trackers_max_rank_check;

alter table public.naver_place_rank_trackers
  alter column max_rank set default 300;

alter table public.naver_place_rank_trackers
  add constraint naver_place_rank_trackers_max_rank_check
  check (max_rank = 300);

commit;
