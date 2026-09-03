-- 프로덕션 2026-09-03 08:00Z 선적용(핫픽스), 본 파일은 정식 편입.
-- 핫픽스 2026-09-03: account-priority 트리거 게이트의 런타임 1.1.20 하드코딩 제거
-- 원인: 20260831100525 의 mi_naver_shopping_account_priority_trigger_gate 가
--       runtime_version='1.1.20' + 구지문을 리터럴로 검사 → 1.1.21 전환 후
--       모든 수집 클레임(wake/repair/cycle/lookup)이 P0001 로 거부됨.
-- 수정: 두 리터럴 줄을 "레인이 런타임 아이덴티티를 등록했는가(null 아님)"로 완화.
--       계정우선 코호트 정합성은 아래 required_runtime_version/fingerprint
--       동등 검사가 그대로 지킴. 그 외 로직은 원본과 동일.
-- 되돌리기: 20260831100525 의 153~299줄 원본 블록을 다시 실행.

begin;

create or replace function mi_internal.mi_naver_shopping_account_priority_trigger_gate(
  p_worker_id text,
  p_lane_token uuid,
  p_run_id uuid,
  p_run_trigger text,
  p_require_lane boolean
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_row public.naver_shopping_worker_coordination%rowtype;
  active_request public.naver_shopping_account_priority_requests%rowtype;
  v_now timestamptz := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
  normalized_worker_id text := pg_catalog.lower(pg_catalog.btrim(
    coalesce(p_worker_id, '')
  ));
  normalized_trigger text := pg_catalog.lower(pg_catalog.btrim(
    coalesce(p_run_trigger, '')
  ));
  v_expiry_reconciled boolean := false;
begin
  if coalesce(p_require_lane, false) then
    if normalized_trigger not in (
      'manual', 'rank-catch-up', 'rank-0900', 'rank-1500', 'rank-remote',
      'mac-standby', 'github-cloud'
    ) then
      raise exception 'naver_shopping_account_priority_run_trigger_invalid';
    end if;
    if normalized_worker_id !~ '^[a-z0-9][a-z0-9:_-]{2,63}$'
      or p_lane_token is null
      or p_run_id is null then
      raise exception 'naver_shopping_account_priority_trigger_gate_invalid';
    end if;
  elsif p_worker_id is not null
    or p_lane_token is not null
    or p_run_id is not null
    or p_run_trigger is not null then
    raise exception 'naver_shopping_account_priority_legacy_gate_invalid';
  end if;

  select * into current_row
  from public.naver_shopping_worker_coordination
  where lane_key = 'global'
  for update;

  if not found then
    raise exception 'naver_shopping_account_priority_coordination_missing';
  end if;

  select * into active_request
  from public.naver_shopping_account_priority_requests as request
  where request.state = 'active'
  order by request.requested_at asc, request.request_id asc
  limit 1
  for update;

  -- Use a clock sampled after both locks so time spent waiting for the single
  -- winner cannot make an already-expired request appear live.
  v_now := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );

  -- Expiry is ledger-only and must remain possible after the exact primary,
  -- lane or runtime identity has disappeared.  The coordination row and the
  -- active request are already locked in that order.  Reconcile once from the
  -- database clock, then block this transport call even if the request closed;
  -- the next independent natural call may delegate the ordinary transport.
  if active_request.request_id is not null
    and active_request.expires_at <= v_now then
    perform mi_internal.mi_reconcile_naver_shopping_account_priority(v_now);
    v_expiry_reconciled := true;

    select * into active_request
    from public.naver_shopping_account_priority_requests as request
    where request.state = 'active'
    order by request.requested_at asc, request.request_id asc
    limit 1
    for update;
  end if;

  if v_expiry_reconciled then
    return pg_catalog.jsonb_build_object(
      'active', active_request.request_id is not null,
      'expiryReconciled', true,
      'transportBlocked', true,
      'rankCatchUp', normalized_trigger = 'rank-catch-up',
      'accountPrimary',
        normalized_worker_id = 'windows-desktop-primary'
        and current_row.primary_worker_id = 'windows-desktop-primary',
      'circuitState', current_row.circuit_state,
      'circuitReason', current_row.circuit_reason,
      'cooldownUntil', current_row.cooldown_until,
      'controlClosed',
        current_row.circuit_state = 'closed'
        and current_row.circuit_reason is null
        and current_row.cooldown_until is null
    );
  end if;

  if coalesce(p_require_lane, false) and (
    current_row.lease_worker_id is distinct from normalized_worker_id
    or current_row.lease_token is distinct from p_lane_token
    or current_row.run_id is distinct from p_run_id
    or current_row.lease_until is null
    or current_row.lease_until <= v_now
    or current_row.current_stage is distinct from 'claiming'
    or current_row.current_page is distinct from 0
    or current_row.current_job_kind is not null
    or current_row.current_tracker_id is not null
    or current_row.runtime_version is null
    or current_row.runtime_fingerprint is null
  ) then
    raise exception 'naver_shopping_account_priority_trigger_gate_lane_lost';
  end if;

  if active_request.request_id is not null and (
    current_row.runtime_version is distinct from
      active_request.required_runtime_version
    or current_row.runtime_fingerprint is distinct from
      active_request.required_runtime_fingerprint
  ) then
    raise exception 'naver_shopping_account_priority_trigger_gate_identity_lost';
  end if;

  return pg_catalog.jsonb_build_object(
    'active', active_request.request_id is not null,
    'expiryReconciled', false,
    'transportBlocked', false,
    'rankCatchUp', normalized_trigger = 'rank-catch-up',
    'accountPrimary',
      normalized_worker_id = 'windows-desktop-primary'
      and current_row.primary_worker_id = 'windows-desktop-primary',
    'circuitState', current_row.circuit_state,
    'circuitReason', current_row.circuit_reason,
    'cooldownUntil', current_row.cooldown_until,
    'controlClosed',
      current_row.circuit_state = 'closed'
      and current_row.circuit_reason is null
      and current_row.cooldown_until is null
  );
end;
$$;

commit;
