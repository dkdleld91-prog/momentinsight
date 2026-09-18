---
name: mi-collection-incident
description: 모먼트 인사이트 N30 순위 수집 정지·인계 실패·UptimeRobot 경보를 진단하고 복구하는 절차. "수집이 멈췄어요", "인계가 안 됩니다", "서버 다운 알림", "순위 갱신 안 됨" 같은 요청에 사용한다.
---

# N30 수집 장애 진단·복구

## 0. 원칙
- 증거 먼저: 서버 기록(DB)과 작업기 로그를 동시에 본다. 추정은 추정이라고 표기한다.
- 서비스 키는 `~/.config/momentinsight/backup.env`에서만 읽고 **읽기 전용 조회**에만 쓴다(값 출력 금지). DB 변경은 대표가 SQL 편집기에서 실행한다(바탕화면 txt + TextEdit로 열어 줌).
- 익명 curl의 418(차단 페이지)만으로 차단이라 단정하지 않는다. 로그인된 수집 프로필은 다르게 동작한다.

## 1. 3분 진단
1. 코디네이션(`naver_shopping_worker_coordination`, lane_key=global): `primary_seen_at`, `lease_worker_id`, `circuit_state`/`circuit_reason`/`circuit_opened_at`, `cooldown_until`, `last_block_code`, `failure_streak`, `runtime_version`.
2. 최근 런(`naver_shopping_worker_runs`)과 이벤트(`naver_shopping_scheduler_events`: tracker_committed / finite_window_committed / job_failed / quarantine_set) — 누가, 언제까지, 어떤 코드로.
3. 집계: `node ~/.config/momentinsight/tools/tally126.mjs <sinceISO>` (LIST=1이면 커밋 내역), 증거: `naver_shopping_failure_evidence`(v2는 trace·diff 포함).
4. 맥 로그 `~/Library/Logs/MomentInsight/`: `naver-shopping-native-host.log`(1초 만에 `exit status=0` 반복 = 서버가 일을 안 줌, `status=1` = 게이트 거절), `mi-rank-watchdog.log`, `naver-shopping-chrome-scheduler.log`. 절전 이력 `pmset -g log | grep -E "Sleep|Wake"`, 전원 `pmset -g batt`.
5. 공개 상태: `curl https://insight.momentlabs.co.kr/api/rank-collection-health`, `/health`의 release.

## 2. 판정표
| 관찰 | 의미 | 조치 |
|---|---|---|
| 주작업기 `primary_seen_at` 3분 이상 과거 + 회로 closed | 대기기가 자동 인계(정상) | 맥 전원·뚜껑·Chrome 확인 |
| 회로 open + 사유 `navigating:naver_page_navigation_failed` + 주작업기 무신호 | 자동 복구가 주작업기 전용이라 대기기가 무기한 막힘(2026-09-18 11시간 정지) | 조건부 회로 정리 SQL |
| 회로 open + 일시 오류 계열(타임아웃·script_failed 등) | 30분 뒤 주작업기 자동 검증 2회, 이후 대기기 1회 인계 | 기다리거나 총관리자 [테스트 1건 검증] |
| `runtime_identity_invalid`/런 없음 + 서버 release 변경 직후 | 워커 버전 불일치 | 윈도우 PowerShell 한 줄(mi-runtime-release 참고) |
| `naver_verification_required`·로그인 리다이렉트 | 수집 프로필 네이버 로그인 풀림 | 대표가 해당 Chrome 프로필에서 재로그인(자격 증명은 절대 대신 입력하지 않음) |
| 418이 로그인 프로필에서도 발생 | 네트워크 일시 차단 | 요청량을 늘리지 말고 해제 대기 |

## 3. 조건부 회로 정리 SQL (대표 실행, 결과 1행이어야 정상)
```sql
update public.naver_shopping_worker_coordination
set circuit_state='closed', circuit_reason=null, circuit_opened_at=null, cooldown_until=null,
    failure_signature=null, failure_streak=0, current_stage=null, current_page=0, transient_system_probe_attempts=0
where lane_key='global' and circuit_state='open' and circuit_reason='<정확한 사유>'
  and lease_worker_id is null and run_id is null
returning lane_key, circuit_state, primary_worker_id, primary_seen_at;
```
실행 후 1~2분 안에 대기기 런이 생기고 `current_stage=collecting`으로 페이지가 넘어가는지 확인한다.

## 4. 설계 사실(설명할 때 쓸 것)
- 인계: 주작업기 180초 무신호 → 대기기 허용. 주작업기가 돌아오면 대기기는 `primary_online`으로 물러난다(종료가 아니라 대기). 작업 통로는 단일 임대(최대 35분)라 두 대 동시 수집은 불가능하며, 요청량 증가는 네이버 차단(2026-09-09 6시간 정지)을 부른다 → 동시 수집은 권하지 않는다.
- 맥은 절전·뚜껑 닫힘이면 인계도 워치독도 멈춘다. 전원 연결 + 뚜껑 열림, 필요 시 `caffeinate -i -t <초>`.
- UptimeRobot 모니터 3개: 사이트 다운 / 수집 상태 API / 수집 정체(Keyword). "Keyword is down"은 사이트 장애가 아니라 수집 정체 경보다.

## 5. 마무리
원인(확정/추정 구분)·조치·재발 방지안·대표가 할 일을 한국어 표로 보고하고, 메모리에 사고 기록을 남긴다.
