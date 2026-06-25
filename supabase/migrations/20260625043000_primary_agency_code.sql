update public.clients
set agency_code = 'mml93-a01'
where id = '11111111-1111-4111-8111-111111111111'
  and not exists (
    select 1
    from public.clients existing
    where lower(existing.agency_code) = 'mml93-a01'
      and existing.id <> '11111111-1111-4111-8111-111111111111'
  );

update public.naver_rank_trackers
set agency_code = 'mml93-a01'
where client_id = '11111111-1111-4111-8111-111111111111';

alter table public.naver_rank_trackers
alter column agency_code set default 'mml93-a01';
