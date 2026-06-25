do $$
begin
  if exists (
    select 1 from public.clients where lower(agency_code) = 'mml-a01'
  ) and not exists (
    select 1 from public.clients where lower(agency_code) = 'mml93-a01'
  ) then
    update public.clients
    set agency_code = 'mml93-a01'
    where lower(agency_code) = 'mml-a01';
  end if;
end $$;

update public.naver_rank_trackers
set agency_code = 'mml93-a01'
where lower(agency_code) = 'mml-a01';

alter table public.naver_rank_trackers
alter column agency_code set default 'mml93-a01';
