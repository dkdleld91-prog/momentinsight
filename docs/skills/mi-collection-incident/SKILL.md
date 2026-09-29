---
name: mi-collection-incident
description: 모먼트 인사이트 N30 순위 수집 정지·인계 실패·UptimeRobot 경보를 진단하고 복구하는 절차. "수집이 멈췄어요", "인계가 안 됩니다", "서버 다운 알림", "순위 갱신 안 됨" 같은 요청에 사용한다.
---

## 실행 도구 (먼저 이것부터 쓴다)
| 할 일 | 명령 |
|---|---|
| 3분 진단 한 번에(코디네이션·런·실패·증거 trace·공개 상태·맥 로그·뚜껑·전원·판정 힌트) | `node ~/.claude/skills/mi-collection-incident/scripts/diagnose.mjs [시간=6]` |
| 조건부 회로 정리 SQL 생성(대표 실행용, 바탕화면+TextEdit) | `bash ~/.claude/skills/mi-collection-incident/scripts/recovery-sql.sh "<circuit_reason>"` |
| 기간 집계 | `LIST=1 node ~/.claude/skills/mi-collection-incident/scripts/tally.mjs <sinceISO>` |

2026-09-19 실측: 진단 도구가 "맥 뚜껑 닫힘+배터리 → 15분마다 40초만 깨어나 provider_deadline_exceeded" 정지를 잡아냄. 뚜껑 닫힘 절전은 caffeinate 로 못 막는다(대표가 뚜껑 열고 전원 연결).

# N30 수집 장애 진단·복구

## 0. 원칙
- 증거 먼저: 서버 기록(DB)과 작업기 로그를 동시에 본다. 추정은 추정이라고 표기한다.
- 서비스 키는 `~/.config/momentinsight/backup.env`에서만 읽고 **읽기 전용 조회**에만 쓴다(값 출력 금지). DB 변경은 대표가 SQL 편집기에서 실행한다(바탕화면 txt + TextEdit로 열어 줌).
- 익명 curl의 418(차단 페이지)만으로 차단이라 단정하지 않는다. 로그인된 수집 프로필은 다르게 동작한다.

## 1. 3분 진단
1. 코디네이션(`naver_shopping_worker_coordination`, lane_key=global): `primary_seen_at`, `lease_worker_id`, `circuit_state`/`circuit_reason`/`circuit_opened_at`/`circuit_opened_by_worker`, `cooldown_until`, `last_block_code`, `failure_streak`, `runtime_version`, 대기기 벤치 `standby_failure_worker_id`/`standby_failure_streak`/`standby_last_failure_code`/`standby_benched_until`(2026-09-27~).
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
| 공개 상태 `ok:false` + `lanes.product.commitStalled:true`(UptimeRobot 수집 경보) | 활성 상품 추적기가 있는데 마지막 커밋(코디네이션 `last_success_at` 과 `naver_rank_trackers` 의 `max(last_checked_at)` 중 최신 — 유한 창 커밋 포함, 1.1.34~) 뒤 **45분 이상** 추적기 커밋이 없다. 하트비트(`heartbeatAgeMinutes`·`primary_seen_at`)가 신선해도, 주작업기가 꺼져 낡아도 똑같이 뜬다 — 누가 살아 있는지가 아니라 "커밋이 없다"는 사실만 말한다(2026-09-27~). 의도된 정지(`manual_stop`·`manual_canary`·쿨다운)·수동 종단·활성 0건이면 안 뜬다. 런타임 배포 창에서 45분 넘게 커밋이 없으면 정상적으로 뜬다(`docs/RUNBOOK.md` S1) | 이 순서로 본다. ① 주작업기(윈도우) 전원·종료: 윈도우 PowerShell `Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,42,107,1074,6006,6008; StartTime=(Get-Date).AddHours(-6)} -ErrorAction SilentlyContinue` (41·6008 전원 끊김·비정상 종료, 1074 사용자·업데이트 종료/재시작, 6006 정상 종료, 42 절전 진입, 107 절전 복귀) ② 맥 대기기 벤치 열 `standby_benched_until`·`standby_failure_streak`·`standby_last_failure_code`·`standby_failure_worker_id`(미래면 아래 벤치 행) ③ 회로 `circuit_state`·`circuit_reason`·`circuit_opened_by_worker`(open 이면 그 사유의 행). 셋 다 정상이면 1 의 런·이벤트(`job_failed`)와 실패 증거로 |
| 실패 증거 `evidence->>'version'`=`collection-error-v1` + `errorDetail` 에 `No current window`(보통 `error_code`=`naver_page_navigation_failed`) | 그 작업기의 수집 프로필(맥 `Profile 5` 등)에 일반 창이 0개라 확장의 `chrome.tabs.create` 가 거절됐다(09-27 70분 정지의 첫 고리). 1.1.33 확장은 창이 0개면 최소화된 수집 창을 스스로 만들고 마지막 창을 닫지 않으므로 **1.1.33 에서는 나오면 안 된다** | 그 행의 `worker_id`·`run_id` 로 런의 `runtime_version` 부터 확인. 1.1.32 이하면 그 기기 워커 갱신(mi-runtime-release)·수집 프로필 창 1개 열기. **1.1.33 에서 보이면 조사 대상**: 확장이 실제 1.1.33 인지(설치기 지문·`chrome://extensions`), 맥이면 네이티브 호스트 로그 `local_worker_collection_error_detail:` 줄, 수집 창 생성·최소화 확인이 실패한 흔적 — 원인 확정 전에 회로 정리 SQL 만 반복하지 않는다(조회 SQL: `docs/RUNBOOK.md` S3) |
| `standby_benched_until` 이 미래(대기기 요약 `collectorLaneReason=standby_benched`) | 대기기 자기 기기 문제(창 없음·확장·네이티브 호스트·로컬 기한)로 한 사건에서 2회 이상 실패 → 대기기만 30분(2회)/60분(3회+) 쉼. 전역 회로·주작업기는 영향 없음 | 맥 Chrome 수집 프로필 창·확장·네이티브 호스트 로그 확인 → 고쳤으면 3-1 벤치 해제 SQL(안 풀어도 시간이 지나면 자동 해제) |
| 회로 open + `circuit_opened_by_worker` 가 대기기(diagnose.mjs "대기기에서 시작된 회로") | 대기기 실패로 시작된 회로(대기기 검증 실패·수동 종단 `transient_recovery_manual_required` 포함). 주작업기가 이 회로에서 자기 자동 검증을 아직 안 썼으면(`transient_system_probe_attempts`=0) 돌아와 첫 claim 에서 바로 검증 1건. **예외 — 즉시 검증 없이 예전 규칙 그대로**: ① `manual_stop` 등 수동 정지(`mi_stop_naver_shopping_worker`, 콜론이 든 사유 포함) ② `probe_security_block` ③ 보안 `cooldown_until` 이 아직 미래(끝난 뒤에야 적용) ④ 임대가 살아 있음 ⑤ 자동 출구 없는 네이버 페이지 서명(예: `naver_next_data_schema_drift`) ⑥ 주작업기가 연 회로, 주작업기 실패가 같은 서명 사슬의 1회째였던 회로, 주작업기 검증이 이미 실패·미완료·만료된 회로(열 값이 주작업기로 바뀜, 일시 오류 2회 뒤 대기기 인계 실패 → 수동 종단 유지) ⑦ 사유가 `probe_incomplete`·`probe_interrupted`·수동 종단인데 `last_failure_code` 가 일시 오류·대기기 기기 코드가 아님(예: 차단 호출이 안 된 채 해제·만료된 네이버 차단 `naver_http_429`, 추적기 코드). canary(`manual_canary`)는 끝나면(실패·미완료·만료) 열 값이 비거나(대기기가 잡음) 주작업기로 바뀌어(주작업기가 잡음) 예전 규칙 그대로. **알려진 한계**: 손 SQL 로 `mi_stop_naver_shopping_worker` 에 현재 실패 서명과 글자까지 같은 사유를 넣은 경우만 남은 대기기 값으로 즉시 검증(`docs/RUNBOOK.md` S2 절) | 주작업기 전원·Chrome 확인. 예외면 그 사유의 행대로(수동 정지는 대표 판단, 보안 차단은 cooldown 대기, 수동 종단은 3 의 조건부 회로 정리 SQL) |

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

### 3-1. 대기기 벤치 해제 SQL (대표 실행, 결과 1행이어야 정상)
```sql
update public.naver_shopping_worker_coordination
set standby_benched_until = null, standby_failure_streak = 0
where lane_key = 'global' and standby_benched_until is not null
returning standby_failure_worker_id, standby_last_failure_code, standby_last_failure_at;
```
벤치는 대기기 기기 문제를 고친 뒤에만 푼다. 고치지 않고 풀면 다시 2회 실패한 뒤 또 걸린다(격리 규칙: `docs/RUNBOOK.md` "S2 대기기 실패 격리").

## 4. 설계 사실(설명할 때 쓸 것)
- 인계: 주작업기 180초 무신호 → 대기기 허용. 주작업기가 돌아오면 대기기는 `primary_online`으로 물러난다(종료가 아니라 대기). 작업 통로는 단일 임대(최대 35분)라 두 대 동시 수집은 불가능하며, 요청량 증가는 네이버 차단(2026-09-09 6시간 정지)을 부른다 → 동시 수집은 권하지 않는다.
- 맥은 절전·뚜껑 닫힘이면 인계도 워치독도 멈춘다. 전원 연결 + 뚜껑 열림, 필요 시 `caffeinate -i -t <초>`.
- UptimeRobot 모니터 3개: 사이트 다운 / 수집 상태 API / 수집 정체(Keyword). "Keyword is down"은 사이트 장애가 아니라 수집 정체 경보다.

## 5. 마무리
원인(확정/추정 구분)·조치·재발 방지안·대표가 할 일을 한국어 표로 보고하고, 메모리에 사고 기록을 남긴다.
