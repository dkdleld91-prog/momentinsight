begin;

-- 계정(광고주 코드 · 운영팀 코드)별 순위 추적 키워드 등록 한도.
-- null = 총관리자가 지정하지 않음 → 서버와 트리거 모두 기존 기본값 50 을 쓴다.
-- 총관리자 코드(mml93-a01)는 값과 무관하게 무제한(아래 트리거 조기 반환).
-- 상한 10000 은 오타 방어용 안전장치이며, 실제 운영 상한은 서버 상수로 좁힌다.
alter table public.clients
  add column if not exists rank_keyword_limit integer;

alter table public.operation_team_codes
  add column if not exists rank_keyword_limit integer;

do $$ begin
  alter table public.clients
    add constraint clients_rank_keyword_limit_range
    check (rank_keyword_limit is null or rank_keyword_limit between 1 and 10000);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.operation_team_codes
    add constraint operation_team_codes_rank_keyword_limit_range
    check (rank_keyword_limit is null or rank_keyword_limit between 1 and 10000);
exception when duplicate_object then null;
end $$;

comment on column public.clients.rank_keyword_limit is
  '총관리자가 지정한 순위 추적 키워드 등록 한도. null 이면 기본값 50.';
comment on column public.operation_team_codes.rank_keyword_limit is
  '광고주 미연결 운영팀 계정의 순위 추적 키워드 등록 한도. null 이면 기본값 50.';

-- DB 최후 방어선도 같은 한도를 읽는다(서버만 고치면 상향 계정이 하드코딩 50 에 막힌다).
-- 조회 순서: clients 행이 이기고(null 이어도 기본값 50), 없을 때만 operation_team_codes.
create or replace function public.enforce_naver_rank_tracker_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_count integer;
  allowed_limit integer;
  entering_active boolean;
begin
  -- `update of agency_code, status` 바인딩은 값이 그대로여도 대입만으로 깨어난다. 수집기가
  -- 회차마다 status 를 다시 써넣으므로 '활성 진입'(삽입 · 상태 전환 · 광고주 코드 변경)만
  -- 검사해야 한도를 내려 잡아도 기존 활성 행의 갱신이 P0001 로 죽지 않는다. INSERT 에는 old
  -- 가 배정돼 있지 않으므로 or 단락 평가에 기대지 않고 분기를 갈라 UPDATE 에서만 읽는다.
  if TG_OP = 'INSERT' then
    entering_active := new.status = 'active';
  else
    entering_active := new.status = 'active' and (old.status is distinct from new.status
      or old.agency_code is distinct from new.agency_code);
  end if;
  if entering_active then
    if lower(coalesce(new.agency_code, '')) = 'mml93-a01' then
      return new;
    end if;

    select c.rank_keyword_limit
      into allowed_limit
      from public.clients c
      where lower(c.agency_code) = lower(coalesce(new.agency_code, ''))
      limit 1;

    if not found then
      select t.rank_keyword_limit
        into allowed_limit
        from public.operation_team_codes t
        where lower(t.team_code) = lower(coalesce(new.agency_code, ''))
        limit 1;
    end if;

    allowed_limit := coalesce(allowed_limit, 50);

    perform pg_advisory_xact_lock(hashtext(lower(new.agency_code)));

    select count(*)
      into active_count
      from public.naver_rank_trackers
      where lower(agency_code) = lower(new.agency_code)
        and status = 'active'
        and id <> new.id;

    if active_count >= allowed_limit then
      raise exception '키워드 등록 한도 %개를 모두 사용했습니다. 한도 상향이 필요하시면 관리자에게 문의해주세요.', allowed_limit
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_naver_rank_tracker_limit() from public, anon, authenticated;
grant execute on function public.enforce_naver_rank_tracker_limit() to service_role;

commit;
