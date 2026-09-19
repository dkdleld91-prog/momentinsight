#!/bin/bash
# 조건부 회로 정리 SQL 생성(대표 실행용): bash recovery-sql.sh "<circuit_reason 정확히>"  → ~/Desktop/failover-recovery.txt + TextEdit
R="$1"; [ -z "$R" ] && { echo "사유를 넣으세요. 예: navigating:naver_page_navigation_failed"; exit 2; }
cat > "$HOME/Desktop/failover-recovery.txt" <<SQL
-- Supabase SQL 편집기용. "그 사유로 열려 있고 임대·실행 중인 작업이 없을 때만" 회로를 닫습니다. 결과가 1행이어야 정상입니다.
update public.naver_shopping_worker_coordination
set circuit_state = 'closed', circuit_reason = null, circuit_opened_at = null, cooldown_until = null,
    failure_signature = null, failure_streak = 0, current_stage = null, current_page = 0, transient_system_probe_attempts = 0,
    transient_standby_handoff_at = null, transient_standby_handoff_worker_id = null, transient_standby_handoff_success_at = null
where lane_key = 'global' and circuit_state = 'open' and circuit_reason = '$R'
  and lease_worker_id is null and run_id is null
returning lane_key, circuit_state, primary_worker_id, primary_seen_at;
SQL
open -a TextEdit "$HOME/Desktop/failover-recovery.txt" && echo "준비됨: ~/Desktop/failover-recovery.txt (Supabase SQL 편집기용, 결과 1행 기대)"
