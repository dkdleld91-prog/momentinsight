create or replace function public.enforce_naver_rank_tracker_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_count integer;
begin
  if new.status = 'active' then
    if lower(coalesce(new.agency_code, '')) = 'mml93-a01' then
      return new;
    end if;

    perform pg_advisory_xact_lock(hashtext(lower(new.agency_code)));

    select count(*)
      into active_count
      from public.naver_rank_trackers
      where lower(agency_code) = lower(new.agency_code)
        and status = 'active'
        and id <> new.id;

    if active_count >= 50 then
      raise exception '순위 추적은 광고주 코드당 최대 50개까지만 등록할 수 있습니다.'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;
