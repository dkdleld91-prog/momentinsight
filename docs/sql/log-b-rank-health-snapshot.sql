-- /api/rank-collection-health 스냅샷 읽기 함수(B안, 2026-10-16 대표 승인). Supabase 로그 저장량 167% 대응.
-- 무엇: 헬스 핸들러가 캐시 미스 1회에 따로 보내던 읽기 12건(레인 최신 확인 시각 2·지연 2·코디네이션 1·
--       실행 기록 1·서명 1·추적기 집계 4·용량 원문 1 이상)을 이 함수 호출 1건으로 묶는다.
-- 읽기 전용: stable · security invoker. 표·색인·다른 함수는 만들지도 바꾸지도 않는다.
-- 판정하지 않는다: 원자료(시각·불리언·정수·검색어 원문 배열)만 돌려준다. 정체·정지·ok 판정과 검색어
--       정규화는 지금처럼 서버 JS 가 한다. 함수 안에 now() 가 없다 — 시각 경계와 임계값은 서버 JS
--       상수가 원본이라 인자로 받는다.
-- 다시 실행해도 안전하다(create or replace). 코드 배포 전후 어느 쪽에 실행해도 된다 — 함수가 없으면
--       서버는 예전 개별 조회로 똑같이 답한다.
-- 되돌리기: drop function if exists public.mi_rank_collection_health_snapshot(timestamptz, timestamptz, integer, integer, integer);
--       서버는 다음 캐시 미스부터 개별 조회로 돌아간다(응답은 같다).

begin;

create or replace function public.mi_rank_collection_health_snapshot(
  p_overdue_cutoff timestamptz,
  p_stuck_cutoff timestamptz,
  p_never_found_min_checks integer,
  p_place_partial_min_retries integer,
  p_keyword_row_limit integer
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  -- 용량 원문. 개별 조회 경로의 페이지 상한(10페이지 × 1000행)과 같은 행 수까지만 읽는다.
  -- 순서는 정하지 않는다(개별 조회 경로도 정하지 않는다). 배열과 상한 표시는 같은 행 묶음에서 낸다.
  with product_keyword_sample as materialized (
    select tracker.keyword
    from public.naver_rank_trackers as tracker
    where tracker.status = 'active'
    limit p_keyword_row_limit
  )
  select pg_catalog.jsonb_build_object(
    -- 레인 최신 확인 시각. status 와 무관하게 null 이 아닌 값 중 최신 1건이다.
    'product_latest_checked_at', (
      select tracker.last_checked_at
      from public.naver_rank_trackers as tracker
      where tracker.last_checked_at is not null
      order by tracker.last_checked_at desc
      limit 1
    ),
    'place_latest_checked_at', (
      select tracker.last_checked_at
      from public.naver_place_rank_trackers as tracker
      where tracker.last_checked_at is not null
      order by tracker.last_checked_at desc
      limit 1
    ),
    -- 예정 시각이 경계보다 앞선(같으면 아님) active 추적기가 1건이라도 있는가.
    'product_overdue', exists (
      select 1
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.next_check_at < p_overdue_cutoff
    ),
    'place_overdue', exists (
      select 1
      from public.naver_place_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.next_check_at < p_overdue_cutoff
    ),
    -- global 행이 없으면 null(서버가 제어면 소실로 본다).
    'coordination', (
      select pg_catalog.jsonb_build_object(
        'circuit_state', lane.circuit_state,
        'circuit_reason', lane.circuit_reason,
        'cooldown_until', lane.cooldown_until,
        'primary_seen_at', lane.primary_seen_at,
        'last_success_at', lane.last_success_at
      )
      from public.naver_shopping_worker_coordination as lane
      where lane.lane_key = 'global'
    ),
    'latest_run_runtime_version', (
      select run.runtime_version
      from public.naver_shopping_worker_runs as run
      order by run.started_at desc
      limit 1
    ),
    'latest_signature_at', (
      select nonce.created_at
      from public.naver_shopping_worker_nonces as nonce
      order by nonce.created_at desc
      limit 1
    ),
    'never_found', (
      select pg_catalog.count(*)
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.check_count >= p_never_found_min_checks
        and tracker.found_count = 0
    ),
    -- 성공 이력이 있으면 last_checked_at, 없으면 created_at 이 앵커다. 경계와 같으면 아니다.
    'stuck', (
      select pg_catalog.count(*)
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.last_error is not null
        and (
          tracker.last_checked_at < p_stuck_cutoff
          or (tracker.last_checked_at is null and tracker.created_at < p_stuck_cutoff)
        )
    ),
    'place_partial', (
      select pg_catalog.count(*)
      from public.naver_place_rank_trackers as tracker
      where tracker.status = 'active'
        and tracker.last_error is null
        and tracker.retry_count >= p_place_partial_min_retries
    ),
    'active_product', (
      select pg_catalog.count(*)
      from public.naver_rank_trackers as tracker
      where tracker.status = 'active'
    ),
    'active_product_keywords', coalesce(
      (select pg_catalog.jsonb_agg(sample.keyword) from product_keyword_sample as sample),
      '[]'::jsonb
    ),
    -- 상한까지 꽉 찼으면 뒤에 행이 더 있는지 모른다(개별 조회 경로의 "마지막 허용 페이지도 꽉 찼다").
    'active_product_keywords_truncated', (
      select pg_catalog.count(*) from product_keyword_sample
    ) >= p_keyword_row_limit
  );
$$;

revoke all on function public.mi_rank_collection_health_snapshot(
  timestamptz, timestamptz, integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.mi_rank_collection_health_snapshot(
  timestamptz, timestamptz, integer, integer, integer
) to service_role;

commit;
