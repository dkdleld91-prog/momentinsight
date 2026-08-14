# Work Status

기준일: 2026-08-14

## 현재 상태

### 2026-08-14 준비작업 1번 24시간 감사 시작

- 17:27 KST 승인 후 Production `1ba1efc45bbe` 업데이터를 Windows에서 실행했지만 `native_host_manifest_missing`으로 fail-closed됐습니다. 재확인 결과 레지스트리뿐 아니라 `com.momentinsight.naver_shopping.json` 자체가 실제로 없었으며, runtime 파일·작업 순서에는 쓰기 변화가 없었습니다.
- 업데이터가 누락 manifest를 고정 host name·launcher path·`stdio`·정확 extension origin으로 재생성하고 다시 검증한 뒤에만 HKCU를 등록하도록 추가 보완했습니다. Windows 10/10·server contract 49/49·baseline은 통과했으나 새 배포와 Windows terminal 전에는 복구 완료가 아닙니다.
- manifest·HKCU를 복원한 뒤에도 Chrome 연결이 즉시 종료돼 Node를 동일 native framing으로 직접 실행했습니다. `local-worker-contract.mjs`가 새 `LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS` export를 요구하지만 Windows updater가 `local-worker-auth.mjs`를 갱신하지 않아 import 단계에서 종료된 것이 두 번째 직접 원인입니다. DB claim·순서·격리에는 변화가 없었습니다.
- v1.1.7은 전체 설치기의 실행 모듈 목록을 updater도 모두 동기화하고, native runtime fingerprint가 auth·rank handler·security·source status·provider runtime·mobile fallback까지 포함하게 합니다. 이후 새 의존 파일이 빠지면 Chrome 시작 전에 검사 또는 fingerprint 불일치로 fail-closed합니다.
- 복구 후보 전체 검증은 core 539/539·Place 51/51·Shopping 57/57, server contract 50/50, Production auth 18/18, 보호 잠금 22함수·81파일·31 migration으로 통과했습니다. 아직 Production·DB·Windows에는 v1.1.7을 반영하지 않았으므로 운영 복구 완료로 판정하지 않습니다.
- 18:19 KST Production `703bf0ca0e02`·DB runtime gate·Windows runtime `1.1.7`을 동기화했습니다. 업데이터는 `syntax=13`, 실로드 확장·native 등록·13개 실행 모듈 hash와 fingerprint `8eef01d43577…` 일치를 확인했습니다.
- 자연 순서 작업이 새 collection `pw-chrome-1786699070869-a689fd48726f639586bb`를 광고 30개 제외·오가닉 300개로 저장했고, circuit closed·cooldown 없음·lane/run/tracker lease 해제를 확인했습니다. 복구 terminal 시각인 18:17:51 KST부터 24시간 공정 순환 관측을 다시 시작하며 아직 전체 완료로 판정하지 않습니다.
- 18:27 KST ledger에서 cycle #8은 신규 group 1건을 먼저 원자 300으로 완료한 뒤 기존 cursor의 `resume` group 1건으로 복귀했습니다. 두 group·두 광고주 claim의 같은-cycle 중복은 0이며, resume 대상은 실제 cross-page overlap으로 fail-closed·30분 격리되고 다음 순환을 막지 않았습니다.
- 18:30 KST cycle 도중 추가된 신규 group 1건도 `new` 우선순위로 정확히 1회 claim돼 collection `pw-chrome-1786699855696-00657d0c90fcaf93a0a1`을 광고 30개 제외·오가닉 300개로 완료했습니다. 18:31 KST lane·run·tracker lease 해제와 circuit closed를 확인했으며 다음 기존 cursor 복귀는 후속 회차에서 계속 검증합니다.
- 18:36 KST 기존 cursor `resume` group이 tracker 2건을 한 collection으로 원자 300 완료했고, 18:40 KST 신규 1건 원자 300 완료 직후 6초 handoff로 기존 `resume` group tracker 4건을 다시 한 collection으로 완료했습니다. cycle #8 ledger 누적 6 group/10 tracker/4 agency, 신규 3·resume 3, group 중복 0, commit 9·typed failure 1이며 저장 snapshot 9건/collection 5개의 atomic 위반은 0입니다.
- 18:50 KST 추가 신규 group 1건이 `new`로 1회 claim돼 collection `pw-chrome-1786701052822-f5ccd4d18c1ef4028605`을 광고 45개 제외·오가닉 300개로 완료했습니다. terminal 뒤 circuit closed·lane/run 해제를 확인했으며, 이 신규 뒤 기존 cursor `resume` 여부는 다음 claim 전까지 합격으로 판정하지 않습니다.
- 19:00 KST 다음 claim은 예상대로 기존 cursor의 `resume`이었고 collection `pw-chrome-1786701656251-0450ccd03e5b7b66cdc1`을 광고 45개 제외·오가닉 300개로 완료했습니다. cycle #8 누적 new 4·resume 4가 교대로 성립했고 8 group/12 tracker/4 agency, group 중복 0, commit 11·typed failure 1입니다.
- 19:10 KST cycle 도중 추가된 신규 group 1건이 다시 `new`로 정확히 1회 claim돼 collection `pw-chrome-1786702255686-115a703b67a543194015`을 광고 30개 제외·오가닉 300개로 완료했습니다. cycle #8 누적 9 group/13 tracker/4 agency, new 5·resume 4, group 중복 0이며 복구 이후 12 snapshot/8 collection의 atomic 위반은 0입니다. never-checked는 3→2로 감소했고 terminal 뒤 lane·lease는 해제됐습니다.
- 19:20 KST 직전 신규 뒤 다음 claim은 기존 cursor의 `resume`이었으나 `provider_duplicate_identity:3:19:page_overlap:1`로 fail-closed됐습니다. 순위 snapshot은 저장하지 않았고 30분 격리 뒤 lane·lease를 해제했습니다. cycle #8 누적 new 5·resume 5, 10 group/14 tracker/4 agency, 같은-cycle group 중복 0이며 오류 없는 활성 44건의 stale24는 0입니다.
- 19:30 KST 신규 group 1건이 `new`로 1회 claim돼 collection `pw-chrome-1786703452418-883e83dd9be75c54245a`을 광고 30개 제외·오가닉 300개로 완료했습니다. DB cycle 기준 누적 claim은 25/57 group·32/72 tracker·9/9 agency이고, 복구 이후 13 snapshot/9 collection의 atomic 위반은 0입니다. 다음 기존 cursor 복귀는 후속 회차에서 계속 판정합니다.
- 19:40 KST 다음 claim은 기존 cursor의 `resume` group으로 복귀해 동일 키워드 tracker 2건을 함께 처리했습니다. 두 건 모두 같은 `provider_duplicate_identity:6:2:page_overlap:5`로 fail-closed·30분 격리됐고 snapshot 오염 없이 lane·lease를 해제했습니다. cycle #8 누적 26 group/34 tracker/9 agency이며 같은-cycle group 중복과 atomic 위반은 계속 0입니다.
- 19:50 KST 다음 `normal` group은 동일 키워드 tracker 4건을 collection `pw-chrome-1786704654007-cdc3898c817c769f6253` 하나로 묶어 모두 광고 제외 오가닉 300개로 완료했습니다. cycle #8 누적 27 group/38 tracker/9 agency, 복구 이후 17 snapshot/10 collection이며 atomic 위반과 같은-cycle group 중복은 0입니다.
- 17:05 KST SELECT-only 회차에서 작업기 runtime은 계속 `1.1.5`, heartbeat는 10,741초 경과했고 lane·processing·cooldown은 없었습니다. cycle #8은 cursor sort 400, 활성 72 tracker/57 group 중 17 tracker/14 group만 claim된 채 정지했으므로 공정 순환 진행으로 판정하지 않습니다.
- 활성 상태는 stale24 28, stale48 27, never-checked 7, 현재 격리 0입니다. 최근 24시간 49 collection/66 snapshot은 모두 source·광고 제외·오가닉 근거·`checkedCount=300`을 충족했지만 마지막 snapshot은 13:56 KST이며, 현 cycle ledger event가 없어 24시간 증거 수집도 재개되지 않았습니다.
- Windows 재연결 후 최초 실기 확인에서 확장 파일은 `1.1.6`이었지만 native manifest와 등록 경로가 모두 없었고, 이를 복구한 뒤에는 updater가 놓친 auth 모듈 때문에 native Node가 import 단계에서 종료됐습니다. DB heartbeat/runtime은 계속 `1.1.5`이며 무한루프나 queue 재선택이 원인은 아닙니다.
- 업데이터가 native manifest의 이름·허용 origin을 검증하고 HKCU 등록을 원자적으로 복원·재검증하도록 로컬 보완했습니다. Windows 10/10, server contract 49/49, baseline, 보호 잠금을 통과했지만 아직 새 커밋 배포·Windows 재실행·원자 300 terminal은 미검증이므로 복구 완료로 보고하지 않습니다.
- 10:01 KST부터 30분 간격 heartbeat `1-24`를 현재 작업에 연결했습니다. 2026-08-15 10:01 KST 전에는 전체 공정 순환 완료를 판정하지 않습니다.
- 시작 시 runtime `1.1.4`, heartbeat 48초, circuit closed, cooldown·lane·processing 없음, cycle #7 active/cursor sort 3200입니다.
- 활성 66 tracker/51 keyword group/9 agency 중 cycle #7 claim은 63 tracker/48 group입니다. 성공 collection 기준 같은 cycle 중복 group은 0이고 repair 대기는 0입니다.
- 24시간 미갱신 23, 48시간 미갱신 21, never-checked 1, 격리 2입니다. 최근 24시간 77 collection·113 snapshot은 전부 `checkedCount=300`이지만 duplicate 마지막 오류 28건과 strict partial 1건이 남아 있어 정상화 완료가 아닙니다.
- 감사 중에는 DB write·강제 wake·순서 재배치·격리 해제를 하지 않습니다. 확인된 결함만 최소 수정하고 전체 release·Production·Windows·운영 terminal을 다시 검증합니다.
- 10:16 KST cycle #7 terminal은 6시간 50분 동안 9/9 agency·51/51 group·66/66 tracker를 claim-time 중복 0으로 모두 한 번씩 처리했습니다. 성공은 26 group/26 collection/38 snapshot이며 전부 `checkedCount=300`이고 collection 교차 재사용도 0입니다.
- 그러나 나머지 25/51 group은 `provider_duplicate_identity` 24건과 strict `provider_partial_window` 1건으로 실패했습니다. circuit closed·processing 0·lane 해제는 확인했지만 절반 가까운 키워드가 새 순위를 저장하지 못했으므로 전체 갱신 정상화로 보고하지 않습니다.
- 원인 매트릭스는 24시간 미갱신 23 tracker를 cross-page overlap 16, same-page duplicate 6, strict partial 1로 전부 설명합니다. 성공했지만 stale인 tracker, lease 고립, 현재 circuit/cooldown 정체는 0입니다.
- 별도 가동률 문제로 보존된 약 24시간 signed traffic에서 5시간 29분 42초 공백 1회를 확인했습니다. 현재는 복구됐지만 장비·Windows 세션·네트워크·scheduler 중 정확 원인은 DB만으로 확정하지 않습니다. 추가 코드 감사에서는 partial 오류의 전역 circuit 오분류, 실패·cycle append-only 이력 부재, 본문 상한·부분 submit·100 tracker 경계를 P1로 분리했습니다.
- v1.1.5 로컬 보완은 한 SSR 페이지 안에서 네이버가 실제로 반복 노출한 같은 상품의 두 절대 순위 슬롯을 삭제·압축 없이 유지하고, 서로 다른 페이지 사이 반복은 계속 fail-closed합니다. strict partial은 해당 tracker만 실패 처리해 다른 광고주의 global circuit을 열지 않으며 `40_300` 같은 실제 확인 수를 보존합니다.
- 전체 release는 517 core + Place 51 + Shopping 57, server contract 46/46, Production auth 18/18, 보호 잠금 22함수·78파일·28 migration으로 통과했습니다. Production release `40da76857484`, DB runtime gate, Windows runtime `1.1.5`/fingerprint `7ec0891e023d…`를 동기화했고, 자연 순환 collection `pw-chrome-1786679023142-f1d2bb80ad9ea6963f70`이 `치아미백제`를 광고 제외 오가닉 300개·51위로 완료한 뒤 circuit closed와 lane·lease 해제를 확인했습니다.
- DB runtime 함수 3개는 모두 SECURITY INVOKER, 빈 search path, `postgres`·`service_role`만 실행 가능한 상태입니다. 다만 이는 24시간 공정 순환 완료 증거가 아니며, cross-page overlap 13 group과 5시간 29분 가동 공백 원인은 해결 완료로 보고하지 않습니다.
- 12:57 KST 읽기 전용 관측에서 cycle #8은 8/51 group claim·cursor sort 200으로 전진했고 같은 cycle 성공 중복은 0입니다. circuit closed, cooldown·lane·processing 없음이며 cycle 성공 snapshot 7행/4 collection은 원자 300 위반 0건입니다. 미갱신 24시간 23건·48시간 21건과 duplicate 28건·partial 1건은 그대로여서 정상화 판정은 보류합니다.
- 13:19 KST에는 cycle #8이 10/51 group까지 전진하고 stale24가 22건으로 1건 감소했습니다. `콘트로이친`은 새 원자 300 collection으로 성공했으나 `성장기칼슘`은 `local_worker_collection_failed`로 종료돼 원인 상세를 확정할 증거가 없습니다. 이후 circuit은 closed·failure streak 0·lane 해제이므로 전역 정지는 아니지만, generic failure의 원인 보존도 추가 결함으로 추적합니다.
- v1.1.7 로컬 보완은 malformed row 3종을 해당 keyword group으로 격리하고, 서명·수집창 시계 허용을 ±5분으로 통일하며, native request ID 불일치를 즉시 종료합니다. 제출 본문은 실제 300개 최대 계약을 수용하도록 4MiB로 고정했고 부분 submit은 서버가 확인한 `processedCount` 이후 항목만 해제합니다.
- 다음 완전 cycle부터 claim·terminal·격리·신규 우선·cursor 복귀를 append-only로 남기는 scheduler event ledger를 추가했습니다. 강제 RLS 아래 service role은 읽기만 가능하고 trigger write는 비공개 `mi_internal` SECURITY DEFINER 함수만 수행합니다. 역할 전환·동일 group 반복 claim·cycle 중 신규·성공/실패를 실제 PostgreSQL shadow transaction으로 실행하고 전체 rollback을 확인했습니다.
- 전체 `check:release`는 core 537/537·Place 51/51·Shopping 57/57, server contract 49/49, Production auth 18/18, 보호 잠금 22함수·80파일·30 migration으로 통과했습니다. 아직 Production·DB·Windows에는 배포하지 않았으며, 장부 적용 뒤 시작되는 다음 cycle부터 24시간 증거를 새로 판정합니다.

### 2026-08-13 N쇼핑 장기 미갱신 병목 보완

- 운영 읽기 전용 감사에서 활성 66건 중 24시간 이상 미갱신 23건을 확인했습니다. 이 중 22건은 `provider_duplicate_identity`, 나머지 1건은 실제 오가닉 결과가 38개뿐인 strict 300 미달이었습니다. 정상 데이터 40건에는 24시간 미갱신이 없었습니다.
- Windows runtime `1.1.4` heartbeat, cycle #6, circuit·cooldown·lane을 확인해 작업기 정지나 순환 무한루프가 아님을 확인했습니다. 최근 24시간 원자 300 snapshot 147건도 모두 `checkedCount=300`입니다.
- 누적 재시도 2회부터 중복 오류를 24시간 격리하던 공통 DB 정책을 해당 오류에 한해 30분 고정으로 제한했습니다. 기존 활성 중복 격리도 오류 시각+30분까지만 단축하며 순서·cursor·cycle 소유권·retry·last-good·이력은 변경하지 않습니다.
- 실제 결과가 300개 미만이거나 중복 경계가 제한된 재수집 안에 안정되지 않으면 계속 fail-closed하고 마지막 정상 순위를 유지합니다. 행 삭제·순위 압축으로 300개를 만들지 않습니다.
- Production release `1c778c655d2b`와 migration `naver_shopping_duplicate_quarantine_cap`을 적용해 활성 격리가 19건에서 3건으로 줄었습니다. 신규 1건 우선 처리 뒤 과거 격리 대상 `침구청소기`가 sort 2100 순서로 재진입했고, 실제 same-page 중복은 30분 격리·45위 last-good 보존·lane/lease 해제로 유한 종료해 전체 순환은 계속됐습니다.

### 2026-08-13 N쇼핑 이동 경계 복구 v1.1.4 완료

- v1.1.3 Windows 실기에서 `남자 사각팬티`는 광고 제외 오가닉 300개·17위로 정상 저장됐습니다. `남성 사각팬티`는 전체 수집과 suffix 2회 뒤에도 `provider_duplicate_identity:8:2:page_overlap:7`로 유한 종료했고 last-good 23위·이력은 보존됐습니다. 복구 큐는 재등록되지 않았고 정상 cycle cursor가 다음 키워드로 전진했습니다.
- v1.1.4는 최초 전체 8페이지 뒤 경계 suffix를 최대 4회, 실제 이동 총 16페이지와 원 요청 절대 deadline 안에서만 수행합니다. 각 교환 뒤 전체 오가닉 1~300·강한 identity 고유성·광고 제외를 다시 검증하며 행 skip·순위 압축은 금지합니다.
- native host와 실행 중 service worker가 `range-v1`을 상호 확인하지 못하면 DB claim 전에 fail-closed합니다. Windows updater도 scheduler와 관련 프로세스가 파일 교체 중 재실행되지 않도록 정지·복구합니다.
- Production·DB·Windows runtime `1.1.4`를 동기화했고, 남은 `남성 사각팬티`만 일회성 복구 큐로 처리했습니다. 새 `pw-chrome-*` collection에서 광고 제외 오가닉 300개·17위로 저장됐고 오류·격리·retry가 해제됐습니다. 복구 항목은 `consumed/claimed_once`로 종료됐으며 정상 cycle cursor가 다음 키워드 수집로 전진했습니다.
- 일반 Chrome이 떠 있으면 전용 프로필을 오인해 기동을 생략하던 Windows watchdog도 정확 프로필을 `--no-startup-window`로 무창 handoff하도록 보완했습니다.

### 2026-08-13 N쇼핑 경계 일관성 복구 v1.1.3

- 운영에서 `provider_duplicate_identity`가 두 요청 항목만이 아니라 24개 정규화 키워드 그룹·6개 광고주에 남아 있음을 확인했습니다. 과거 오류는 page/row 상세를 저장하지 않아 약한 상품 ID 충돌과 실제 페이지 겹침 중 어느 하나였는지 사후 단정하지 않습니다.
- 모든 키워드에 공통인 식별 규칙을 판매자 상품은 seller ID, 카탈로그는 catalog ID, 그 외는 정규 URL 순으로 단일화했습니다. 서로 다른 판매자 카드가 약한 product ID만 공유하면 정상 보존하고, 실제 강한 중복은 계속 fail-closed합니다.
- v1.1.2 운영 재검증에서 `남자 사각팬티`가 새 전체 수집 뒤에도 `provider_duplicate_identity:7:3:page_overlap:6`으로 유한 실패했습니다. 수집 중 6→7페이지 경계가 움직인 것으로 확인돼 같은 전체 수집을 더 반복하지 않습니다.
- v1.1.3은 전체 8페이지를 1회 수집한 뒤 충돌 origin page부터 8페이지까지만 최대 2회 다시 받아 전체 1~300을 매번 재검증합니다. 총 페이지 이동은 16 이하이고 원 요청 절대 deadline을 넘기지 않습니다. 행 삭제·압축은 없으며 same-page duplicate와 최종 overlap은 typed failure로 종료해 광고 제외 오가닉 300개·last-good 계약을 유지합니다.
- 지정된 `남자 사각팬티`, `남성 사각팬티`는 service-role 전용 1회 복구 큐에서 순서대로 처리하고, 각 claim 뒤 다음 wake 1회만 남긴 뒤 기존 durable cycle cursor로 복귀합니다. 실패해도 복구 큐에 자동 재등록하지 않습니다.
- DB·Production·Windows v1.1.3 반영과 두 건의 1회 복구는 완료했습니다. 한 건은 원자 300개로 성공했고 다른 한 건은 이동 경계가 제한 횟수 안에 안정되지 않아 last-good을 보존한 채 유한 실패했으므로 v1.1.4 보완으로 이어갑니다.

### 2026-08-12 N쇼핑 30일 영속 순환 정상화

- 운영 중복을 DB에서 확인했습니다. 최근 24시간 원자 300개 80건 중 고유 키워드 그룹은 25개였고, 소형 광고주 키워드는 최대 14회 반복되는 동안 일부 활성 키워드는 24시간 이상 미갱신됐습니다.
- DB 영속 cycle/cursor를 추가해 기존 키워드는 한 cycle에 한 번만 처리하고, 신규 키워드 1건 처리 뒤 저장 cursor로 복귀합니다. 같은 키워드는 광고주를 넘어 최대 100 tracker를 한 번의 오가닉 300개 수집으로 처리합니다.
- 개별·전체 갱신과 GitHub hybrid cron은 순서나 `next_check_at`을 바꾸지 않고 동일 cycle을 깨우기만 합니다. 원자 300·광고 제외·last-good·동시 실행 1개·보안 제한은 유지합니다.
- migration과 Production release `074c3a25d644`를 반영했고 Windows 설치본도 `MI_EXTENSION_UPDATE_OK release=074c3a2`, runtime fingerprint `9c637e5d554d…`로 동기화했습니다. 첫 cycle에서 서로 다른 keyword group 4개·tracker 7건이 재선택 없이 처리됐고 모두 오가닉 `checkedCount=300` terminal, circuit closed, lane·lease 해제를 확인했습니다. 신규→저장 cursor 인계와 24시간 전체 cycle 완주는 계속 관측하며 아직 운영 정상화 완료로 단정하지 않습니다.

### 2026-08-12 키워드 연령별 쇼핑 클릭 비중 복구

- 첫 Production 배포 `766d26faf8f3`은 운영 서버의 모바일 쇼핑 표본 수집 실패 때문에 category를 얻지 못했고, 실제 총관리자 재조회에서도 연령 그래프가 `조회 후 표시`에 머물렀습니다. 이 실패를 정상 완료로 보고하지 않습니다.
- 30일 추적과 공유 mobile fallback parser는 이전 코드로 복원했습니다. 키워드 handler 안에서만 공식 Shopping Insight 대분류 10개를 검사하고, 모든 요청 성공·최신 완료 월 6연령대·완전 월 6개월 이상인 후보가 정확히 하나일 때만 선택합니다.
- 관리자·광고주의 기존 5개 세로 막대그래프와 tooltip·최신 완료 월 선택 로직은 변경하지 않았습니다.
- 공식 API 실호출에서 `남자팬티`는 category `50000000`만 단일 강한 후보였고 2026-07 비중은 `0.5 / 3.9 / 18.3 / 35.2 / 42.1%`였습니다. 모호·stale은 값을 만들지 않고 일부 실패·429는 남은 탐색을 즉시 중단합니다. 성공 프로필은 30분, 미확정·제한 결과는 5분 TTL로 재사용해 반복 호출을 차단합니다.
- 최종 Production release `d2a087a54562`·deployment `dpl_4ofFYdX7xELkHXDyiw2g5g3wDRGz`는 READY이며 `/health`·`/ready`와 Supabase ready가 일치합니다. 로그인된 총관리자 화면에서 `남자팬티` 월 검색량 30,770과 연령 막대 5개 `0.5 / 3.9 / 18.3 / 35.2 / 42.1%`가 실제 표시되는 것을 확인했습니다.
- 사용자 지시에 따라 N 상품·N 플레이스 30일 추적과 Windows·DB 경계는 추가 요청 전까지 동결합니다. 30일 순위·광고 제외·300개·매칭·저장·스케줄·UI·migration과 공유 mobile fallback parser는 변경하지 않습니다.

### 2026-08-12 키워드 조회 공개·N 상품 단건 숨김

- 키워드 조회의 Production 환경변수 7종은 이미 등록돼 있습니다. SearchAd exact 월 검색량·연관 키워드와 API HUB 검색 추이 실호출을 확인했으며 별도 키 입력이나 교체는 필요하지 않습니다.
- `남자팬티` 실조회는 HTTP 200, 월 검색량 30,770, 검색 추이 37구간, 연관 키워드 10개, warning 0이었습니다. 일부 성별·연령 비율과 쇼핑 참고 지표는 현재 확인되지 않아 임의값 없이 대기로 유지합니다.
- 관리자·광고주·모바일의 `키워드 조회 (개발중)` 표기를 정식 `키워드 조회`로 변경하고 공식 데이터 기준을 화면에 명시했습니다.
- `N 상품 순위` 단건 메뉴와 화면은 양 역할에서 제거하고 구형 direct hash를 기본 화면으로 정규화했습니다. 공유 서버 API·SEO·N 30일 자동 추적·Windows 작업기는 변경하지 않았습니다.
- commit `a035a87f3854`를 GitHub `main`과 Production `dpl_EYbXYLFfekTnVP39zhG1PasR8aJm`에 반영했습니다. 운영 `/health`·`/ready`는 release `a035a87f3854`, 서울 `icn1`, Supabase ready입니다.
- 총관리자 운영 화면에서 `키워드 조회` 정식 메뉴와 `남자팬티` 월 검색량 30,770회·검색 추이·연관 키워드 렌더를 확인했습니다. `N 상품 순위` 단건 메뉴·화면은 없고 구형 direct hash는 운영 홈으로 복귀하며, `N 30일 순위`는 유지되고 콘솔 오류는 0건입니다.

### 2026-08-12 전체 품질 고도화 1차

- 운영 홈의 고정 서비스 안내가 신규 방문자의 hero와 CTA를 가리는 문제를 확인했습니다. 안내를 기본 접힘형 inline 상태 스트립으로 바꾸고 기존 문구·기능 상태·닫기·1주 숨김·카카오 문의를 유지했습니다.
- 보고서 직접 업로드는 연결할 `reportId`가 현재 광고주 소유인지 Storage 업로드 전에 확인합니다. 파일 DB 기록 실패 시 업로드 객체를 삭제하고, 잘못된 날짜·파일 메타데이터는 보고서 행 생성 전에 거절합니다.
- 기존 보고서에 파일을 연결할 때는 파일 행 생성 성공 후에만 보고서를 갱신합니다. 파일 실패는 보고서 UPDATE 0회, 후속 보고서 갱신 실패는 새 파일 행 제거로 종료하며 보상 실패도 별도 코드로 노출합니다. 신규·생성형 보고서의 DB/Storage 중간 실패도 정리 결과를 확인합니다.
- Supabase 운영 DB는 모든 확인 대상 테이블에 RLS가 활성화돼 있고 최대 테이블은 `naver_rank_snapshots` 약 15MB였습니다. security advisor 7건을 권한과 함수 정의로 대조한 결과 즉시 보안 migration이 필요한 권한 상승 경로는 없었습니다. 성능 advisor의 RLS initplan 2건과 중복 SELECT 정책 21건은 권한 매트릭스가 필요한 후속 migration 후보로 분리했습니다.
- 저장소는 추적 소스 약 4.8MB이며 즉시 삭제 가능한 생성물은 `dist` 약 1.4MB뿐으로 확인했습니다. 로컬 환경 파일 권한은 소유자 전용으로 조정했고 소스·환경 파일·수집기 의존성·Git 복구 이력은 삭제하지 않았습니다.
- 이번 작업은 Production·Supabase schema·Windows 확장을 배포하지 않았습니다. 인증 비밀 분리와 서버 세션 폐기 원장은 호환성·DB migration이 큰 후속 작업이므로 영향 보고와 승인 뒤 진행합니다.

### 2026-08-12 N쇼핑 수집 중 흰 controller 화면 제거

- 화면 원인을 내부 `popup.html?controller=1` 탭의 강제 활성화로 확정했습니다. 실제 네이버 수집 탭은 이미 백그라운드였고, 내부 popup 탭만 수집 내내 전면에 남아 흰 화면처럼 보였습니다.
- 가시 controller 탭 구조를 제거하고 service worker가 native port를 직접 소유하도록 정리했습니다. 작업 중에는 20초 간격 extension API heartbeat를 사용하고 terminal에서 heartbeat와 port를 유한 해제합니다.
- 업데이트·시작 시 남아 있는 구형 controller 탭을 자동 제거합니다. 일반 1~8페이지는 계속 `active:false`이며 보안확인·접속 제한 때만 해당 네이버 창을 정상 상태로 복원하고 앞으로 표시합니다.
- toolbar popup의 `지금 안전 갱신` 버튼·상태 확인은 유지합니다. v1.1.1 runtime version, 직접 경로·pacing, trigger coalesce, 광고 제외 원자 300개, last-good, global lane·lease는 변경하지 않습니다.
- 운영 반영 완료: commit `ecb9a99aab1b`, Vercel Production `dpl_FgYypGyHJH93jiiP5MZBjSyxX5Xu`가 운영 별칭에 반영됐고 `/health`·`/ready`가 같은 release와 Supabase ready를 반환했습니다. Windows `동빈 (개발)` 설치본은 `MI_EXTENSION_UPDATE_OK`, `loaded_extension_synced=true`, service worker SHA `975238a7488e16c207040f82cb74284d52184b6e38ee261db6ba5e46a040c8c4`, runtime fingerprint `fd95e1bd7cf9ede4c13ec25fa65195345e0b37a4ed3f5cc38586c293412c6a60`을 확인했습니다.
- 실기에서 toolbar popup 버튼을 1회 눌러 수집하는 동안 기존 확장 관리 화면이 그대로 유지되고 네이버 탭은 백그라운드에서 열렸다가 닫혔으며 흰 controller 탭은 다시 생성되지 않았습니다. collection `pw-chrome-1786470467501-e0fc34d1aad12f964b44`는 정확 상품 `12491798995`를 광고 45개 제외 오가닉 300개에서 93위로 완료했고, circuit closed와 run·probe·global lane·tracker lease 전부 해제를 확인했습니다.

### 2026-08-12 N플레이스 30일 지표 진실성·순위 카드 정리

- 일별 카드의 기존 `블로그`·`방문`은 대상 플레이스 수치가 아니라 해당 회차에 확인한 모든 오가닉 후보의 리뷰 합계였고, `업체`는 전체 업체 수가 아니라 확인 행 수였습니다. `월검색`은 장소별·일별 값이 아닌 별도 검색광고 키워드 지표라 일별 카드에서 제거했습니다.
- 운영 데이터에서 `구월동 맛집` place `2045794152`의 대상 직접값은 블로그 리뷰 232·방문자 리뷰 3,594였지만 기존 화면은 검색결과 합계 65,108·264,467을 표시해 원인을 재현했습니다.
- 관리자·광고주 화면은 `snapshot.place`의 대상 직접 리뷰값만 표시합니다. 대상 미확인 또는 직접값이 없으면 `-`로 표시하고 nested `place.metrics` 집계값은 읽지 않습니다.
- 30일 기록을 날짜·순위·직전 대비·검증 상태·오가닉 근거 중심의 compact navy 카드로 정리했습니다. 이미지 내보내기는 6열 전체 grid로 바꿔 30일 뒤쪽 기록이 잘리지 않게 했습니다.
- 순위 수집기·서버 저장·DB·스케줄은 변경하지 않았습니다. 플레이스 ID 정확 일치와 광고 제외 오가닉 순위를 유지하며, 부분 조회는 실제 `checkedCount`와 `rank=null` 이력으로 구분해 저장하되 확정 순위로 표시하지 않고 과거 정상 이력을 보존합니다.

### 2026-08-11 총관리자 전용 개발 운영센터 분리

- 정확한 `mml93-a01` owner 세션에서만 서버가 `개발 </>` 메뉴 그룹, `N 쇼핑 수집 운영`, `부가세 계산기` 화면을 전달합니다. 공개 admin/client 정적 문서에는 해당 메뉴·화면·운영 패널 markup이 없습니다.
- `N 30일 순위` 화면에서는 운영센터를 완전히 제거했습니다. 기존 tracker GET이 받은 총관리자 전용 operations 데이터와 4개 제어는 동적으로 생성된 개발 화면의 패널만 참조합니다.
- 로그아웃·team 전환 시 메뉴·화면·스타일을 즉시 제거하고, non-owner의 `#mi-admin-owner-*` 직접 접근은 일반 화면으로 정규화합니다.
- 프리미엄 navy command surface를 실시간 실행, 장비·스케줄, 안전·복구 세 영역으로 정돈하고 데스크톱 4열·태블릿 2열·모바일 1열 반응형을 적용했습니다.
- 수집 엔진·DB·확장·Windows 설치본은 변경하지 않았습니다. 광고 제외 원자 `checkedCount=300`, last-good 보존, baseline 10분·동시 실행 1개 계약을 유지합니다.
- 운영 반영 완료: commit `6a1076899183`, Vercel Production `dpl_HUQadoTJ3qTP1DFxVnKfiNEvQfGb`가 운영 별칭에 반영됐고 `/health`·`/ready`는 같은 release, 서울 `icn1`, Supabase ready를 반환했습니다. 실제 `mml93-a01` owner 세션에서 개발 메뉴 그룹 1개·owner view 2개·운영 패널 표시와 N30 내부 운영 패널 0개·가로 넘침 0을 확인했습니다. 운영 지표는 계정 범위와 상태 조회 후 약 10초 내 표시됐으며 제어 버튼은 누르지 않았습니다.
- 운영 화면 문구는 `남자팬티 1건 검증`에서 `테스트 1건 검증`으로 정리했습니다. 버튼·확인창·완료/거절 안내만 변경했으며 실제 고정 canary tracker와 오가닉 300개 검증 계약은 유지합니다.

### 2026-08-11 N쇼핑 자동 순환 연속성 v1.1.1

- 운영에서 Windows heartbeat·circuit·cooldown·lane은 정상이었고 active tracker 65개가 모두 claim 가능했지만, `남자팬티` canary 뒤 자동 순환이 이어지지 않았습니다.
- 확인된 코드 원인은 1분 `rank-remote`와 10분 `rank-catch-up`이 겹칠 때 실행 중 요청을 `already_running`으로 버리며, 전체 tracker를 due로 만드는 유일한 catch-up 신호도 유실될 수 있는 경계입니다. 동일 시각의 실제 알람 선후는 과거 로그에 없어 추정으로 확정하지 않습니다.
- 실행 중 도착한 신호는 `manual > rank-catch-up > 09/15 > rank-remote` 순위로 하나만 합칩니다. Node는 terminal frame을 flush한 뒤 입력을 닫고, Windows launcher는 child 종료 직후 output relay join 전에 mutex를 해제하며, 다음 회차는 6초의 유한 handoff 뒤 한 번만 실행합니다. remote는 대기 신호를 만들거나 catch-up을 덮지 않습니다.
- 정상 closed 순환의 `provider_duplicate_identity:<page>:<row>`는 안전한 base code만 보존하고 해당 tracker group만 격리합니다. URL·키워드·상세 row는 DB·로그로 전달하지 않으며 다음 키워드는 계속 처리합니다. 단, half-open 단독 canary 실패는 검증 실패이므로 circuit을 다시 open합니다. 네트워크·보안 제한의 전역 중단은 유지합니다.
- 신규 후보는 오래된 due보다 먼저 선택하고 `created_at,id`, 기존 due는 `next_check_at,created_at,id`로 결정적 순서를 고정했습니다. 이후 aging·lookup·광고주 round-robin 계약은 유지합니다.
- runtime은 1.1.1로 분리했습니다. 기능 commit `35853810dfab`, 운영 migration `20260811120243_naver_shopping_queue_continuity`, Windows fingerprint `ed2e0692fb1d98d2f0eea26fa73e8eb1ecd5921f1dd2b8a82de10b1f214b926c`를 확인했습니다. 검증된 기능 Production은 commit `f49d93d061eb`, deployment `dpl_DeJghmAKeVPUSMZprGF6vUyjv7hp`이며 해당 배포 시점 `/health`·`/ready`가 같은 release로 정상입니다.
- `control_plane_failed`, 모든 `idle`, 알 수 없는 summary를 0건 완료로 표시하지 않습니다. idle은 대기, 제어면·알 수 없는 상태는 실패로 유한 종료합니다.
- 운영 연속 증거: 21:18 신규 `강아지사료`가 첫 슬롯에 선점됐고 `provider_duplicate_identity`로 snapshot 없이 tracker만 24시간 격리됐으며 circuit은 closed를 유지했습니다. 21:25 `남자팬티` canary collection `pw-chrome-1786451158772-13372ef3800e1ee373a8`은 오가닉 300개·광고 45개 제외·100위로 완료됐습니다. 21:28 다음 자동 catch-up은 기존 `치아미백제`를 선택해 collection `pw-chrome-1786451344481-f10f7157eb70e146d1e1`, 오가닉 300개·광고 44개 제외·46위로 완료했습니다. 각 terminal 뒤 circuit closed, probe·run·global lane·tracker lease 해제를 확인했습니다.
- 관리자 canary 버튼이 렌더된 tracker ID를 operations panel에 저장하고도 상위 card에서 읽던 UI 결함을 수정하고 회귀 잠금했습니다. 기능 배포 후보 2건은 보호 함수 잠금과 CSP hash 검사가 각각 차단해 운영 alias가 이전 정상 버전을 유지했고, 잠금 승인·CSP 동기화 뒤 기능 배포 `f49d93d061eb`가 READY가 됐습니다.

### 2026-08-11 준비작업 1번 대기·5차 보류

- 사용자 명칭을 고정했습니다. `준비작업 1번`은 기존 2차 DB 상태 머신, 3차 관리자 운영 관제, 4차 공정 순환의 **24시간 운영 감사와 누락 보완 작업**입니다.
- 2026-08-12 19:42 KST 이후 사용자가 `준비작업 1번 시작합시다`라고 직접 요청할 때만 시작합니다. 시간이 지나도 자동으로 개발·배포하지 않습니다.
- 이미 배포된 v1.1.0 제어면은 baseline으로 유지합니다. 시작 후 실제 24시간 DB 증거와 화면을 대조해 명세보다 부족한 상태 전이·관측·공정성만 수정하고 다시 검증합니다.
- 5차 속도 향상은 사용자 지시에 따라 보류합니다. baseline 10분·동시 실행 1개를 유지하며 8분 candidate를 자동 활성화하지 않습니다.
- 구형 `NEXT_ACTIONS` 466줄은 현재 계획에서 제거하고 상세 원문은 Git 이력에 보존했습니다. `docs/archive/NEXT_ACTIONS_HISTORY_THROUGH_2026-08-11.md`에는 찾기 위한 요약 인덱스만 남겼습니다.

### 2026-08-11 N쇼핑 운영 제어면 1~5차 v1.1.0

- 로컬 구현 완료: 동일 시스템 단계·오류 2회 circuit open, 보안 오류 즉시 cooldown, 유한 lease/CAS, page n/8·runtime fingerprint·원자 300 증거, lookup/new/due 공정 큐·aging·광고주 round-robin, tracker 격리, 총관리자 운영센터, baseline 10분→candidate 8분 안전 gate를 구현했습니다.
- 후보 간격은 자동 활성화하지 않습니다. exact runtime `1.1.0`, nonzero SHA-256, 원자 300개, 24시간 안정 구간과 성공 6회가 모두 있어야 하며, 모든 실패는 baseline 10분과 안정성 집계 초기화로 복귀합니다.
- 운영 Supabase migration `20260811095137_naver_shopping_worker_control_plane` 적용과 실제 SQL 파싱이 완료됐습니다. 12개 RPC는 모두 invoker, PUBLIC·anon·authenticated 실행 차단, service_role 전용, coordination RLS·force RLS, tracker 격리 컬럼을 확인했습니다. 초기 상태는 circuit closed·baseline 10분·lane/lease 0입니다.
- 운영 반영 완료: commit `2d16b3d425e8`, Production deployment `dpl_35bXeh7eJiwZA7n9NyaFhFQD1SiV`, `/health`·`/ready` 200을 확인했습니다. Windows `동빈 (개발)`에는 `MI_EXTENSION_UPDATE_OK`, version `1.1.0`, runtime fingerprint `d29f8b9e89b762eeee17bbe574ca66e9e7c14b02947acbca2bd0af26991871c4`, loaded extension 동기화를 확인했습니다.
- 설치 직후 일반 순환 1건이 `checkedCount=300`으로 성공한 뒤, `남자팬티` tracker `0aa6f887-496a-4ec6-bb28-f323a30f96d3` canary를 1회만 실행했습니다. collection `pw-chrome-1786444926878-415c0336e1c6a0df873c`는 정확 상품 `12491798995`, 오가닉 300개, 광고 45개 제외, 100위(3페이지 20번째), `atomic_ok=true`였고 circuit closed·lane/processing lease 해제를 확인했습니다.
- v1.1.0 기반 기능과 단건 운영 증거는 확인했습니다. 다만 2~4차의 24시간 운영 감사·누락 보완은 위 `준비작업 1번`으로 별도 대기하며, 5차 candidate 8분은 보류합니다.
- 폴더 정리는 프로젝트가 지정한 recoverable 생성물 `dist`, `.vercel/output`, `.DS_Store`만 삭제했고 소스·환경설정·사용자 파일과 `node_modules`는 보존했습니다.

### 2026-08-11 N쇼핑 실패·복구 원장과 무한반복 금지 계약

- `docs/08-work-spec-autosave.md` 최상단에 Windows 수집 실패 원인, 각 복구 조치, v1.0.48 `남자팬티` 원자 300개 운영 증거를 하나의 영구 원장으로 통합했습니다.
- 동일 단계·오류 2회 연속이면 추가 실기와 전체 순환을 중단하고 원인 확정·무외부 재현·단독 canary부터 다시 시작합니다. 이는 운영·개발 절차이며 자동 차단이 구현됐다고 과장하지 않습니다.
- 성공 판정은 원자 `checkedCount=300`, lane·lease 해제, 중복 pending 없음, 설치 바이트 일치, 릴리스 검사와 문서 증거가 모두 갖춰진 경우로 고정했습니다. 런타임·API·DB는 이번 문서 작업에서 변경하지 않습니다.

### 2026-08-11 native 요청 deadline 계약 정렬 v1.0.48

- Windows v1.0.47 `남자팬티` canary `c70da9f9-15c5-450a-aa0b-515d63f4e69f`는 `processing` 시작 45.452초 뒤 snapshot 없이 `pending`으로 복귀했습니다. 직접 8페이지 수집 뒤 native core가 요청을 검증할 때, 로컬 작업기의 29분 deadline이 collector의 최대 15분 계약을 넘겨 `invalid_request:deadlineAt`이 발생하고 안전 코드 경계에서 `local_worker_collection_failed`로 축약된 것이 확정 원인입니다.
- 로컬 요청 deadline 기본값과 환경 override 상한을 모두 14분으로 clamp했습니다. Windows launcher는 override를 주지 않으며, 14분 요청은 생성 45초 뒤 실제 collector 계약 검증을 통과합니다. 확장·설치 릴리스는 1.0.48로 구분했습니다.
- 대상 회귀 55/55, server contract 39/39, 보호 잠금 및 self-test, 전체 `npm run check:release`가 통과했습니다. direct 1~8페이지·controller·streaming·접속 제한 감지·광고 제외 원자 300개와 마지막 정상값 보존은 유지합니다.
- commit `674f088e3304`를 Production deployment `dpl_Fzs2WQk68yYDBcXAwthVGbaNr27b`에 반영하고 Windows `동빈 (개발)` 프로필에 1.0.48을 설치했습니다. 동일 canary `c70da9f9-15c5-450a-aa0b-515d63f4e69f` 재시도는 `completed`, `pw-chrome-*`, `checkedCount=300`, `complete=true`, `partial=false`, `organic_only`, `adExcluded=true`를 모두 통과했습니다. 정확 상품 `12491798995`는 광고 45개 제외 후 100위(3페이지 20번째)였고 lane·processing lease가 정상 해제되어 운영 정상화로 판정합니다.

### 2026-08-11 Chrome 수집 단계 진단·5일 전 직접 경로 복원 v1.0.47

- Windows 단독 회차가 4분 33초 뒤 실패했지만 최종 오류가 `local_worker_collection_failed`로 축약되어 어느 Chrome API 단계에서 멈췄는지 확인할 수 없었습니다. 기존 typed 오류가 아닌 Chrome 원문 오류가 로컬 작업기의 안전 코드 경계에서 일반화되는 진단 공백을 보완했습니다.
- 이미 분류된 `naver_*`·`provider_*`·`native_host_*` 코드는 그대로 보존하고, 그 외 원문 오류는 직접 페이지 이동·페이지 읽기·native 페이지 전달 중 현재 단계 코드로만 변환합니다. 검색어·URL·Chrome 원문 메시지는 저장하지 않습니다.
- 사용자 지시에 따라 5일 전 v1.0.5 수집 경로를 복원했습니다. `search.shopping.naver.com/search/all`의 관련도순·전체상품·40개 리스트를 `frm=NVSCTAB`으로 1~8페이지 직접 열고 페이지 간 3.5~6초 대기합니다. 홈·일반검색·가격비교 더보기 경로는 라이브 코드와 권한에서 제거했습니다.
- 각 페이지가 native host로 전달된 뒤의 진행 상태 저장과 8페이지 완료 후 확인 상태 정리는 UI용 best-effort로 분리했습니다. 이 저장소 정리 실패가 이미 완성된 300개 스트림을 `collection_error`로 폐기하지 않습니다.
- 현재 controller·페이지 스트리밍·접속 제한 감지·공용 차선·광고 제외 원자 `checkedCount=300`·실패 시 마지막 정상값 보존·lease 정밀도는 유지합니다. Windows 1.0.47 설치와 `남자팬티` 단독 회차의 신규 원자 300개 실증 전에는 정상화로 기록하지 않습니다.

### 2026-08-11 N쇼핑 lookup lease 정밀도 복구

- Windows가 단건 작업을 정상 선점했지만 약 5분 뒤 공용 차선만 해제되고 작업은 `processing`에 고립됐습니다. 직접 원인은 DB가 마이크로초 단위로 반환한 `processing_started_at`을 JavaScript가 밀리초 단위로 직렬화한 뒤, 완료·실패 RPC가 원본과 정확 비교해 둘 다 거부한 것입니다.
- 신규 claim은 하나의 밀리초 정렬 시각을 저장·반환하고, 완료·실패는 정확 일치 우선과 기존 마이크로초 lease용 밀리초 fallback을 함께 사용합니다. 행 잠금·만료·상태 검사와 service-role 전용 권한은 유지합니다.
- 로컬 회귀는 통과했지만 Supabase 적용과 `남자팬티` 단독 회차의 원자 `checkedCount=300` 또는 정확한 후속 오류 저장을 확인하기 전에는 정상화로 기록하지 않습니다.

### 2026-08-11 Windows 10분 watchdog 재최소화 차단 v1.0.46

- 1.0.44가 실행 전 Chrome을 복원했지만, 별도 watchdog가 10분마다 이미 실행 중인 동일 프로필을 `Minimized`로 재호출하는 충돌을 추가 확인했습니다.
- watchdog는 전용 사용자 세션에 정식 Chrome이 이미 있으면 아무 작업도 하지 않고 종료하며, 없을 때만 작업용 프로필 Chrome을 시작합니다. 1.0.46 설치 후 실수집 검증 전에는 정상화로 기록하지 않습니다.

### 2026-08-11 Windows 숨김 컨트롤러 동결 해제 v1.0.44

- 1.0.43에서 정확히 5분 경계의 중단이 재현됐고 다른 실행 계층에는 같은 timeout이 없어, Chrome 숨김 탭 freeze를 최우선 원인으로 판단했습니다. 실행 직전 컨트롤러 탭을 활성화하고 `frozen`이면 `false` 전환을 최대 15초 기다린 뒤에만 native 작업을 시작합니다.
- 컨트롤러는 실행 전후 `pinned`·`autoDiscardable:false`를 유지하고 Windows 창이 최소화된 경우 일반 상태로 복원합니다. 자동 알람은 네이버 보안확인·CAPTCHA 보호 시간이 남아 있으면 컨트롤러를 앞으로 가져오지 않고 안전 대기해 사용자의 확인 화면을 가리지 않습니다.
- 이번 변경은 설치·배포·운영 실수집을 수행하지 않았습니다. Windows 1.0.44 설치 후 `남자팬티` 단독 회차의 신규 원자 `checkedCount=300` 확인 전에는 정상화로 기록하지 않습니다.

### 2026-08-11 Windows 장시간 수집 컨트롤러·유한 폴링 v1.0.43

- 1.0.42 단독 실회차가 7분 이상 `processing`에 남은 뒤 반복 실행 신호가 관찰돼 추가 재시도를 중단했습니다. 장시간 수집을 MV3 서비스 워커 전역 상태에 두지 않고, 토큰으로 하나만 지목되는 고정·비폐기 작업 탭에서 native host 연결과 8페이지 수집을 유지합니다.
- 작업 탭 생성은 동시 실행 잠금, 폐기 탭 재로드, 중복 탭 토큰 격리, 실행 잠금 선점, 설치·시작 시 비수집 원칙을 적용합니다. standby·기존 작업·비활성·컨트롤러 실패는 완료로 표시하지 않습니다.
- 웹 폴링은 job 또는 processing lease가 경과하면 `pending:false`와 `RANK_LOOKUP_EXPIRED` 또는 `RANK_LOOKUP_WORKER_STALLED`로 종료하고, 확장 표시도 마지막 진행 갱신 후 20분을 상한으로 두어 화면 무한대기를 막습니다. 부분 결과는 저장하지 않고 마지막 정상 순위·30일 이력은 유지합니다.
- 조기 `return` 뒤 실행되지 않던 확장 회귀 검증을 제거하고 현재 스트리밍·입력 종료·컨트롤러 검증을 실제 테스트로 고정했습니다. 대상 13/13·job 8/8·서버 계약 39/39·앱/API 415/415·플레이스 51/51·쇼핑 52/52와 전체 `npm run check:release`가 통과했습니다.
- Windows 1.0.43 설치와 `남자팬티` 신규 원자 `checkedCount=300` 실증 전에는 정상화 또는 Production 배포 완료로 기록하지 않습니다.

### 2026-08-10 초기 검색 경로 결과 경쟁 제거 v1.0.34

- Windows 1.0.33도 같은 약 79초 경계에서 일반 `naver_navigation_invalid`로 종료됐고, 사용자 실화면의 `검색어 입력 후 검색 없이 종료` 현상과 일치합니다.
- 홈 화면에서 검색어와 실제 검색 버튼 존재를 먼저 확인한 뒤, 확장 컨텍스트가 공식 N플러스 `/ns/search` URL을 검증해 같은 탭을 이동합니다. 검색 결과의 실제 `네이버 가격비교` 링크도 URL을 반환받아 host·path·검색어를 재검증한 뒤 이동합니다.
- 페이지 문서가 이동하면서 `executeScript` 결과를 잃는 경쟁을 홈→검색→가격비교→2~8페이지 전 구간에서 제거했습니다. 기존 대기 간격·보안 제한 중단·원자 300개·마지막 정상값 보존은 유지합니다.

### 2026-08-10 페이지 이동 결과 경쟁 제거 v1.0.33

- 실제 `Profile 3` 로드 경로까지 1.0.32로 맞춘 실회차도 약 80초 뒤 `naver_navigation_invalid`로 안전 종료돼 설치 불일치와 별개의 페이지 이동 오류를 확정했습니다.
- 2~8페이지의 페이지 내부 `setTimeout(location.assign)`은 `executeScript` 결과가 Chrome에 반환되기 전에 문서를 닫을 수 있습니다. 이제 페이지에서는 검증된 다음 URL만 반환하고 확장이 `chrome.tabs.update`로 같은 탭을 이동해 결과 유실 경쟁을 제거합니다.
- 마지막 읽기 상태와 이동 결과 유실은 각각 `naver_page_read_state_unstable`, `naver_page_navigation_result_missing`으로 보존합니다. 신규 원자 300개 실증 전에는 정상화로 기록하지 않습니다.

### 2026-08-10 Windows 실제 프로필·확장 경로 고정

- 실기 점검에서 스케줄러 설정은 존재하지 않는 `Profile 8`이었고, 실제 `동빈 (개발)` 확장은 `Profile 3`의 `C:\Users\user\Desktop\momentinsightextension`에 1.0.27로 남아 있었습니다. 기존 업데이터 성공 문구는 별도 runtime 폴더 1.0.32만 검증해 실제 Chrome 확장을 갱신하지 못했습니다.
- Windows 업데이터는 이제 설정 프로필의 실제 존재, 고정 확장 ID·manifest key로 확인한 로드 경로, 사용자 홈 내부 경로, runtime·실로드 경로의 버전과 서비스 워커 해시 일치를 모두 통과해야만 성공합니다. 스케줄러도 없는 프로필이면 Chrome을 열지 않고 `chrome_profile_missing`으로 중단합니다.
- 전체 릴리스 검사는 통과했으며, Windows `Profile 3` 설정 교정·실로드 경로 동기화와 신규 원자 300개 운영 증거 전에는 정상화 또는 배포 완료로 기록하지 않습니다.

### 2026-08-10 가격비교 다음 페이지 검색어 복원 v1.0.32

- Windows 1.0.31 실회차는 초기 대기와 첫 페이지 후 요청 간격을 합친 79초 뒤 일반 `naver_navigation_invalid`로 안전 종료됐습니다. 이는 첫 가격비교 페이지 뒤 네이버가 URL 검색어 띄어쓰기를 바꿀 때 2페이지 이동 전의 엄격 비교가 중단시키는 경계와 일치합니다.
- 2~8페이지 이동 전에는 NFC 기준 공백만 제거해 같은 글자열인지 검증하고, 다음 URL에는 사용자가 등록한 정확한 검색어를 복원합니다. 글자가 다르면 기존처럼 즉시 중단합니다.
- 보안 제한 즉시 중단, 광고 제외, 원자 `checkedCount=300`, 실패 시 마지막 정상값 보존 정책은 변경하지 않습니다.

### 2026-08-10 화면 이동 단계 오류 보존 v1.0.31

- Windows 1.0.30은 데이터 불일치 코드가 아니라 기존 일반 `naver_navigation_invalid`로 종료됐습니다. 이는 데이터 읽기 이전의 화면 이동 대기 오류가 일반 코드로 치환되는 경계임을 확인한 결과입니다.
- 홈 진입, N플러스 일반검색, 가격비교 더보기, 2~8페이지 이동 실패를 값 없이 단계 코드로만 보존합니다. 해당 코드도 즉시 전체 회차를 중단하며 추가 요청을 보내지 않습니다.
- 원자 300개와 기존값 보존 계약은 유지하고, 단계 확정 뒤에만 최종 경로를 수정합니다.

### 2026-08-10 가격비교 경계 안전 진단 v1.0.30

- Windows 1.0.29도 같은 작업에서 `naver_navigation_invalid`로 실패해 띄어쓰기 정규화가 원인이 아님을 실기로 확인했습니다. 원자 snapshot은 없고 기존 정상값은 유지됐습니다.
- 다음 실회차는 검색어나 URL 값을 저장하지 않고 경로, URL 검색어, URL 페이지 번호, 내부 검색어, 내부 페이지 번호 중 불일치 경계만 제한된 안전 코드로 남깁니다. 어느 불일치든 현재 회차와 후속 요청을 즉시 중단합니다.
- 진단 코드 외 수집·저장 계약은 바꾸지 않으며, 원인 확정 전 정상화로 보고하지 않습니다.

### 2026-08-10 네이버 내부 검색어 띄어쓰기 정규화 v1.0.29

- Windows 1.0.28은 새 문서 대기 후에도 동일 키워드에서 `naver_navigation_invalid`로 안전 종료됐고 원자 snapshot은 생성되지 않았습니다. URL은 입력 키워드를 유지하지만 네이버 `__NEXT_DATA__`가 내부 검색어 띄어쓰기를 정규화하는 경계를 보완합니다.
- 브라우저 URL은 기존처럼 입력 키워드와 정확히 일치해야 합니다. 내부 데이터는 NFC 기준으로 공백만 제거해 같은 글자열인지 확인하며, 글자가 다른 검색어는 계속 실패 처리합니다.
- 광고 제외, 원자 `checkedCount=300`, 접속 제한 즉시 중단, 실패 시 마지막 정상값 보존은 변경하지 않습니다.

### 2026-08-10 가격비교 문서 전환 안정화 v1.0.28

- Windows 1.0.27은 아이콘 검색을 실행하고 원격 작업을 소비했지만, 가격비교 페이지 전환 중 새 URL과 이전 `__NEXT_DATA__`가 잠깐 섞여 `naver_navigation_invalid`로 안전 종료됐습니다. 기존 정상 순위·이력은 변경되지 않았습니다.
- 새 URL만 확인하고 즉시 읽지 않고, Chrome의 완료 상태가 0.5초 유지되며 URL과 페이지 데이터의 키워드·페이지 번호가 함께 일치할 때만 읽습니다. 확인은 로컬 DOM만 재검사하므로 네이버 네트워크 요청은 늘리지 않습니다.
- 접속 제한·CAPTCHA 즉시 중단, 광고 제외, 원자 `checkedCount=300`, 실패 시 마지막 정상값 보존 정책은 유지합니다.

### 2026-08-10 N플러스 아이콘 검색 실행 보완 v1.0.27

- Windows 실화면에서 키워드는 입력됐지만 자동완성만 열린 채 아이콘형 돋보기 검색 버튼을 찾지 못하고 창이 닫히는 현상을 확인했습니다.
- 검색 버튼의 글자뿐 아니라 `aria-label`·제목·이름과 입력창 바로 오른쪽의 실제 버튼 위치를 함께 검증합니다. 입력 이벤트 반영 후 실제 버튼을 클릭하며, 검색 결과 URL 이동이 확인된 경우에만 가격비교 더보기 단계로 진행합니다.
- 보안 제한 즉시 중단, 광고 제외, 원자 300개, 실패 시 마지막 정상 순위·30일 이력 보존 정책은 유지합니다.

### 2026-08-10 N쇼핑 실패 유형 보존·실행 경계 완성 v1.0.26

- Windows 1.0.25 실회차는 접속 제한·CAPTCHA·시간초과 없이 약 8분 34초 뒤 종료됐지만, 확장 화면·경로 오류 코드가 로컬 작업기에서 일반 오류로 치환되어 정확한 실패 지점이 보이지 않았습니다.
- 확장은 보안 제한 코드를 그대로 보존하고 검색창·가격비교 링크 누락은 `naver_selector_drift`, 화면 시간초과는 `naver_page_timeout`, 경로 이동 실패는 `naver_navigation_invalid`로만 전달합니다. 알 수 없는 원문 오류는 외부에 노출하지 않습니다.
- native host와 provider 응답 경계를 29분으로 맞췄고 Windows 안전 업데이터가 로컬 작업기 파일도 문법 검증 후 함께 교체하도록 보완했습니다. 35분 임대, 원자 300개, 광고 제외, 실패 시 마지막 정상값 보존은 유지합니다.

### 2026-08-10 N쇼핑 안전 수집 시간 경계 정렬 v1.0.25

- Windows `동빈 (개발)`에 1.0.24 정상 진입 경로를 설치했고 Chrome `Profile 3`, scheduler, primary heartbeat, 공용 lane 단독 선점을 확인했습니다. 접속 제한·CAPTCHA·공용 cooldown은 발생하지 않았습니다.
- 첫 실회차는 `러닝모자` 3개를 한 키워드 수집으로 묶어 시작했지만, 30~45초 초기 대기와 페이지별 45~75초 안전 간격을 유지한 상태에서 기존 native host·tracker·공용 lane의 20분 경계를 모두 사용해 원자 snapshot 직전에 안전 종료됐습니다. 기존 순위와 이력은 변경되지 않았습니다.
- 확장 실행 제한은 30분, tracker와 공용 lane 및 단건 lookup 임대는 35분으로 정렬했습니다. 처리량 1개·oldest-first·광고 제외·원자 `checkedCount=300`·실패 시 마지막 정상값 보존은 그대로 유지합니다.
- Supabase migration `extend_naver_shopping_worker_collection_lease`를 Production에 적용했고 세 함수 모두 기본 2,100초, anon/authenticated 실행 불가, service_role 전용임을 재검증했습니다.
- 대상 35/35, 앱·API 409/409, 플레이스·쇼핑 각 51/51, 서버 계약 39/39, Production 인증 18/18, 보호 잠금 22함수·67파일·18마이그레이션과 전체 `npm run check:release`가 통과했습니다. GitHub·Windows 1.0.25·신규 원자 300개·Production 안전문 검증을 이어갑니다.

### 2026-08-10 N쇼핑 정상 가격비교 진입 v1.0.24

- 실브라우저에서 `shopping.naver.com/ns/home → 키워드 검색 → /ns/search → 네이버 가격비교 검색에서 더보기 → /search/all?query=...` 흐름은 접속 제한 없이 열렸습니다.
- 기존 1.0.23은 이 정상 진입을 생략하고 `frm=NVSCTAB`·페이지 번호가 포함된 가격비교 URL을 처음부터 직접 열었습니다. 이전의 “경로 오류가 아니다”라는 판단은 이 진입 차이를 검증하지 않은 불완전한 결론이었습니다.
- 1.0.24는 실제 홈 검색창과 화면의 가격비교 링크를 거친 뒤에만 가격비교 데이터를 읽습니다. 2~8페이지는 첫 정상 결과에서 같은 탭·같은 출처 맥락으로 이동하며 `NVSCTAB`을 사용하지 않습니다.
- 터미널 직접 요청, 쿠키 삭제, CAPTCHA 우회는 적용하지 않았습니다. 광고 제외·원자 `checkedCount=300`·오류 시 마지막 정상 순위/이력 보존·제한 감지 즉시 추가 요청 중단은 유지합니다.
- 로컬 구현, 대상 회귀, 전체 `npm run check:release`가 통과했고 사용자 배포 승인을 받았습니다. GitHub 반영 → Windows 설치·원자 300개 실기 검증 → Production 안전문 확인 순서로 진행합니다.

### 2026-08-10 N쇼핑 접속 제한 안내·확장 브랜드 아이콘 v1.0.23

- 가격비교 `/search/all`의 접속 제한은 경로 오류가 아니라 네이버의 네트워크 보호 상태입니다. 수집 우회나 쿠키 삭제 없이 공용 작업 차선을 일시정지합니다.
- 관리자·광고주 화면이 제한 상태, 실제 재시도 시각, 기존 정상 순위·30일 기록 보존을 동일하게 표시합니다. 제한 중 자동 동기화와 중복 요청은 보내지 않습니다.
- 서버는 작업기 식별자·토큰·lease를 노출하지 않고 `cooldown/running/ready/standby`와 허용된 제한 코드만 전달합니다.
- 아이콘이 없는 확장에 딥네이비·화이트·그린 `M` 브랜드 아이콘 16/32/48/128px와 팝업 브랜드 헤더를 추가했습니다. 확장 버전은 1.0.23입니다.
- 원자 `checkedCount=300`, 광고 제외, 실패 시 마지막 정상값 보존 계약은 변경하지 않았습니다. 대상 55/55, 앱·API 408/408, 전체 `npm run check:release`, 보호 잠금과 공개 CSP를 통과했습니다.
- 코드 `8b80c0d`·`e4089ac`은 GitHub `main`에 반영됐습니다. Vercel Production은 최신 정상 300개가 26.7시간 전이라 24시간 배포 안전문 `hybrid_worker_recent_300_proof_missing`에서 차단됐습니다. 안전문은 완화하지 않았고, Windows의 네이버 보안확인 완료 후 신규 정상 300개를 만든 뒤 자동 배포를 재개합니다.

### 2026-08-10 Windows 중복·고아 수집기 자동 복구 v1.0.20

- 수동 갱신이 4분 이상 가격비교 탭 없이 `진행 중`에 머문 실기 상태에서 Windows native host와 Node 프로세스가 서로 다른 시작 시각으로 중복 남은 것을 확인했습니다. 기존 실행을 종료한 직후 1분 원격 알람이 다시 프로세스를 만든 것도 확인했습니다.
- Windows launcher는 사용자 세션당 native host를 하나만 허용합니다. Chrome native messaging 입력이 끊기면 자식 stdin을 닫고 5초 안에 끝나지 않는 숨은 Node 프로세스를 종료해 공용 lane과 로컬 lock을 장시간 잡지 않게 했습니다.
- 확장 서비스 워커가 재시작돼 실제 실행 없이 저장된 `running` 상태만 2분 이상 남으면 `중단된 작업`으로 바꾸어 무한 진행 표시를 해제합니다. 1분 원격 알람은 다음 회차를 다시 시도합니다.
- Windows 안전 업데이터가 확장뿐 아니라 새 launcher도 원본 바이트로 받아 staging에서 컴파일·검증한 뒤 함께 교체합니다. 기존 DPAPI 운영 키는 읽거나 바꾸지 않습니다.
- 확장 버전은 1.0.20이며 대상 17/17, 앱·API 407/407, 플레이스·쇼핑 각 51/51, 서버 계약 39/39, Production 인증 18/18과 전체 `npm run check:release`를 통과했습니다.
- 코드 `0419439`·안전 업데이터 `48016f7`은 GitHub `main`과 Production 릴리스 `48016f734b96`에 반영됐습니다. `/health`·`/ready`는 서울 `icn1`·Supabase ready이고 관리자·광고주 화면은 200입니다. Windows Chrome 재시작 뒤 확장 카드 1.0.20을 확인했습니다.

### 2026-08-10 수동 갱신 가시성 v1.0.19

- 사용자가 확장 팝업에서 `지금 안전 갱신`을 누른 회차만 30~45초 안전 대기 뒤 네이버 가격비교 탭을 활성화합니다. 자동·원격 회차는 백그라운드로 유지합니다.
- 어느 회차든 보안확인·접속 제한을 감지하면 기존대로 해당 탭을 즉시 앞으로 표시합니다. 수동 회차가 보이지 않아 대응 시점을 놓치는 문제를 해소하면서 자동 작업의 방해는 막습니다.

### 2026-08-10 Windows 우선·Mac 대기 공용 수집 차선 v1.0.18

- 외부 웹/Codex 요청은 Production의 공용 Supabase 큐와 원격 wake를 거치며, Windows 로그인·Chrome `동빈 (개발)`·확장 실행이 살아 있을 때 데스크탑이 1분 이내 가져갑니다. Git 코드나 unpacked 확장 파일 자체는 자동 설치되지 않습니다.
- 기존 tracker별 `processing_until`은 같은 행 중복만 막았기 때문에, Windows와 Mac이 서로 다른 키워드를 동시에 조회할 수 있었습니다. 운영 DB에 전 기기 공용 20분 차선, Windows primary 3분 heartbeat, Mac standby handoff를 추가했습니다.
- Windows가 살아 있으면 Mac은 wake를 소비하지 않고 대기합니다. Windows 신호가 3분 이상 끊기고 기존 차선 lease가 끝나면 Mac이 oldest-first 미처리 항목만 이어받습니다. 제한·418·429는 전 기기 공용 30분, CAPTCHA·보안확인은 60분 쿨다운으로 공유합니다.
- 쿠키 상시 삭제는 적용하지 않습니다. IP 제한을 해제하지 못하고 신뢰 쿠키·세션을 잃어 오히려 새 기기 검증을 늘릴 수 있으므로 전용 프로필의 쿠키는 유지합니다. CAPTCHA 자동 풀이·VPN·우회도 사용하지 않습니다.
- Supabase migration `naver_shopping_global_worker_lane`은 운영 적용됐고 RLS 강제, anon 조회·RPC 실행 불가, service_role 실행만 허용됨을 확인했습니다. 전체 릴리스 검사, 서버 계약 39/39, 앱·API 405/405가 통과했습니다.
- 구현 커밋 `bb90e84`는 GitHub `main`과 Production에 반영됐고 `/health`·`/ready`는 릴리스 `bb90e846261e`·서울 `icn1`에서 200입니다. Mac native runtime은 standby 설정으로 재설치됐습니다.
- Windows `동빈 (개발)`에 1.0.18 runtime·확장을 설치하고 Chrome 재시작 뒤 버전 표시를 확인했습니다. DPAPI 운영 키와 `primary` 역할도 보존됐습니다.
- 첫 heartbeat를 막은 원인은 lane RPC의 PL/pgSQL 변수 `current_time`이 PostgreSQL 동명 키워드로 해석된 것이며, repair migration에서 `v_now`로 교체했습니다. 운영에서 `windows-desktop-primary` heartbeat와 lease 정상 해제를 확인했습니다. 신규 원자 `checked_count=300` 실수집은 계속 증거를 확인합니다.
- 첫 실수집은 Windows가 tracker 1건을 단독 선점했지만 18분 경계에서 `native_host_response_timeout`으로 안전 종료됐습니다. 기존 snapshot은 변경되지 않았고 tracker lease와 공용 lane은 즉시 해제됐으며 5분 뒤 due 상태로 전환됐습니다. Codex가 보낸 재시도 wake는 Windows가 1분 안에 소비해 공용 lane과 tracker 1건을 다시 단독 선점했습니다.

### 2026-08-10 Windows 수동 갱신 무한로딩 복구 v1.0.17

- 원인은 Windows native host가 자식 Node의 native messaging stdin/stdout을 Chrome에 직접 중계하지 않아, 프로세스만 남고 HMAC 요청이 나오지 않던 launcher 배선 결함이었습니다.
- C# launcher에 바이너리 relay를 추가하고 확장에는 30초 시작 제한과 즉시 접수 응답을 넣어 `지금 안전 갱신` 팝업이 전체 수집 동안 무한 대기하지 않도록 했습니다.
- 코드 `5049602`는 GitHub `main`과 Production에 반영됐고 `/health`·`/ready`는 같은 릴리스·서울 `icn1`·Supabase ready입니다. 전체 `npm run check:release`, 보호 잠금, Windows 대상 검사를 통과했습니다.
- Windows `동빈 (개발)`·`Profile 3`에 확장 1.0.16과 runtime을 설치했습니다. DPAPI 운영 키는 보존됐고 정상 `.exe` 이름으로 컴파일한 launcher의 Windows 실기 실행 상태는 `MI_EXE_TEST_RUNNING=True`입니다.
- 재가동 후 `2026-08-10 04:20:59 KST`와 수동 실행 이후에도 신규 서명 nonce가 생성됐습니다. 전체 활성 59건 중 1건이 processing lease를 획득해 Windows 작업자가 실제 큐를 선점하는 것까지 확인했습니다.
- 첫 실회차는 4분 고정 native host timeout 때문에 snapshot 전에 안전 실패했습니다. 11분 1차 보완은 4분 경계를 통과했지만 느린 실페이지 회차가 11분을 모두 사용했습니다. 네이버 보호 간격은 줄이지 않고 native 응답·request deadline 18분, server lease 20분으로 최종 정렬했습니다.
- 코드 `cdb86ba` 실회차는 `프로폴리스`에 정확히 1,200초 lease를 만들고 4분·11분 경계를 통과했지만 18분에 `native_host_response_timeout`으로 안전 종료됐습니다. 기존 11위·48회 이력은 유지됐습니다.
- 남은 원인은 Chrome 탭 내부 `executeScript`가 응답하지 않을 때 페이지 단위 제한이 없던 점입니다. 확장 1.0.17은 해당 작업을 45초로 제한하고 오류 탭 ID를 회수해 비보안 오류 탭을 닫습니다. 코드 `9ed047c`는 GitHub `main`과 Production에 반영됐고 전체 릴리스 검사를 통과했습니다.
- Windows 설치 경로에는 `MI_EXTENSION_UPDATE_OK release=9ed047c version=1.0.17 script_timeout=45s`까지 반영됐습니다. 직후 Windows 사용자 세션이 로그오프되어 Chrome과 1분 서명 신호가 중단됐고 원격 연결은 `연결 중`에 머뭅니다. 장치는 온라인이며 DB는 활성 59건·due 59건·processing 0건, 마지막 정상값 보존 상태입니다.
- CAPTCHA·보안확인·네트워크 제한은 우회하지 않습니다. 해당 오류면 현재 건만 안전 재시도하고 마지막 정상 순위와 30일 이력을 보존합니다.

### 2026-08-10 N상품 Windows 작업용 데스크탑 브리지

- Windows Chrome 확장 목록이 비어 있는 원인은 기존 설치기가 macOS Keychain·NativeMessagingHosts·LaunchAgent만 지원했기 때문입니다. 서버나 계정 오류가 아닙니다.
- Windows 전용 설치기는 Chrome 표시 이름 `프로그램 개발`을 내부 `Default`/`Profile N`에 정확 매칭하고, 런타임과 확장을 `%LOCALAPPDATA%\\MomentInsight\\NaverShoppingBridge`에 사용자 전용 ACL로 설치합니다.
- 운영 워커 비밀키는 현재 Windows 사용자 범위 DPAPI로 암호화합니다. Chrome native host는 공식 HKCU 등록 경로와 고정 확장 ID allowlist를 사용하고 Node 22~24·Production URL·회차 1건만 허용합니다.
- 로그인 사용자 전용 작업 스케줄러가 로그인 직후와 10분 간격으로 승인 프로필을 열며 `remote-debugging`·`no-sandbox`·별도 user-data-dir은 사용하지 않습니다.
- Windows에서는 저장소 루트의 `INSTALL-NAVER-SHOPPING-WINDOWS.cmd`를 관리자 실행한 뒤, Chrome 보안 경계상 `chrome://extensions`의 압축해제 확장 로드를 한 번 직접 해야 합니다.
- Windows 정적 계약 4/4, native host 12/12, API·서버 401/401, 플레이스·쇼핑 각 51/51, 서버 계약 39/39, Production 인증 18/18, 보호 잠금 22함수·64파일·15마이그레이션과 전체 `npm run check:release`를 통과했습니다. 코드 `c22b5d6`은 GitHub `main`과 Production에 반영되었고 `/health`·`/ready`는 릴리스 `c22b5d65c491`·서울 `icn1`·Supabase ready, 관리자·광고주 화면은 200을 확인했습니다. Windows 실설치·신규 원자 300개는 남은 실증 경계입니다.

### 2026-08-09 N상품 당일 전체 순환·복구 v1.0.15

- 오전 9시·오후 3시는 광고주에게 보여주는 갱신 기준으로 유지하고, 실제 개발 Chrome 수집은 20분마다 전체 활성 목록을 다시 확인하는 연속 순환 큐로 분리했습니다.
- 각 회차는 미래 예약된 활성 행만 현재 대기열 뒤에 멱등 등록하고, 이미 due인 행과 처리 중 lease는 변경하지 않습니다. 이후 oldest-first로 키워드 1개만 순차 수집하므로 계정별 반복 요청이 다른 광고주의 기존 순서를 밀지 않습니다.
- 운영 읽기 전용 확인은 `status=active` 59건·고유 키워드 47개·현재 due 키워드 47개·활성 lease 0건입니다. 오류가 없을 때 약 15시간 40분에 한 바퀴이며 병렬 브라우저 수집은 사용하지 않습니다.
- 네이버 제한·418·429는 30분·60분·120분 보호 대기 후 1건만 재개하고 이후에도 120분을 상한으로 유지합니다. CAPTCHA·보안확인은 우회하지 않고, 실패·부분 수집은 마지막 정상 순위와 30일 이력을 유지한 채 남은 oldest-first 큐를 이어갑니다.
- native host 12/12, API·서버 397/397, 플레이스·쇼핑 각 51/51, 서버 계약 38/38, Production 인증 18/18, 보호 잠금 22함수·60파일·15마이그레이션과 전체 `npm run check:release`를 통과했습니다.
- 코드 `16a0488`을 GitHub `main`과 Vercel Production `dpl_J23S2KoAt34TbC4gafyxneBdADjG`·운영 별칭에 반영했습니다. `/health`·`/ready`는 릴리스 `16a04882ff83`, 서울 `icn1`, Supabase ready이고 관리자·광고주 화면은 200입니다.
- Mac 브리지 14개 파일은 저장소와 byte-for-byte 일치하고 scheduler는 `Profile 5`, 10분·08:50·14:50, 최근 exit 0입니다. 고정 확장 ID allowlist와 확장 소스 1.0.15도 확인했습니다.
- Chrome 보안 정책상 `chrome://extensions` 재로드 버튼의 원격 조작은 차단됩니다. 서비스 워커 변경을 적용하려면 사용자가 `동빈(개발)`에서 확장 재로드를 한 번 누른 뒤 로드 버전 1.0.15와 제한 해제 후 신규 원자 300개를 확인해야 합니다.

### 2026-08-09 N상품 가격비교 순위 복구·저빈도 안정화 검증

- 사용자 기준을 다시 확정했습니다. N상품 순위의 원천은 네이버플러스 `/ns/search`가 아니라 가격비교 `/search/all`의 관련도순·전체상품·리스트형 오가닉 결과입니다.
- 확장프로그램 1.0.10은 가격비교 페이지 1~8을 한 탭에서 순차 확인하고 각 페이지의 `__NEXT_DATA__`를 서버의 기존 엄격 파서로 전달합니다. 광고는 제외하고 정확 URL 상품 ID·판매자 ID·검증 카탈로그 ID만 판정하며 오가닉 300개가 완성되지 않으면 저장하지 않습니다.
- 페이지 간 요청 간격을 3.5~6초에서 12~18초로 늘리고 10분 회차 처리량을 2개에서 1개 키워드로 줄였습니다. 보안확인·418·429·네트워크 제한·부분 수집은 즉시 중단하고 마지막 정상값과 기존 30일 이력을 유지합니다.
- 관리자·광고주 키워드 링크와 전용 프로필 부트스트랩도 동일 가격비교 URL 계약으로 맞췄습니다. 화면·DB·기존 순위 판정·대기열 멱등성·신규 키워드 우선 처리·플레이스 기능은 변경하지 않았습니다.
- 앱·API 393/393, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 공개 빌드·CSP, 보호 잠금 22함수·58파일·14마이그레이션과 self-test, 전체 `npm run check:release`, `git diff --check`를 통과했습니다.
- 중앙 Mac 브리지 설치본과 저장소 wrapper SHA-256 `bcfb8ec9437ae67d41a70ea8fc74db295a632d16d089e8388a3fecf1d8d3738c`가 일치하고 설치 기본값 `max_jobs=1`, Chrome `동빈` 프로필 확장 1.0.10 활성화를 확인했습니다.
- 실제 가격비교 URL을 직접 열었을 때 네이버 보안확인이 계속 반환됐습니다. CAPTCHA는 자동 우회하지 않으며, 담당자가 현재 열린 확인을 직접 완료한 뒤 신규 `pw-chrome-*`·`checked_count=300` 원자 snapshot을 확인하기 전에는 운영 실수집 정상화나 Production 배포 완료로 보고하지 않습니다. 현재 운영 릴리스는 `777dd919387f`입니다.

### 2026-08-08 N상품 네트워크 제한 수동 해제·신규 키워드 우선 처리 Production 반영

- 네이버 쇼핑의 `쇼핑 서비스 접속이 일시적으로 제한되었습니다` 화면을 일반 보안확인과 분리했습니다. 이 상태에서는 09:00·15:00·10분 보정 회차가 서버 작업을 선점하거나 네이버 페이지를 새로 요청하지 않으며 시간 경과만으로 자동 재시도하지 않습니다.
- 담당자가 이미 열린 네이버 탭을 정상 검색 화면으로 복구한 뒤 확장의 수동 재개를 눌러야 제한 상태가 해제됩니다. 실패·부분 수집 때는 마지막 정상값과 30일 이력을 유지합니다.
- `last_checked_at`이 없는 신규·미초기화 키워드 그룹을 한 번 먼저 처리하고, 이후 기존 `next_check_at` 오름차순 대기열로 복귀합니다. 신규 그룹끼리는 먼저 등록된 순서를 유지하며 전체 갱신·신규 등록·정확 상품·광고 제외·300개 원자 저장 계약은 유지합니다.
- 대상 45/45, 앱·API 392/392, 플레이스·쇼핑 각 51/51, Production 인증 18/18, 보호 잠금 22함수·58파일·14마이그레이션, self-test와 전체 `npm run check:release`, `git diff --check`를 통과했습니다.
- 중앙 Mac 브리지 설치본 일치와 Chrome `동빈` 프로필 확장 1.0.8 활성화를 확인했습니다. 현재 네이버 네트워크 제한이 실제로 남아 있어 신규 300개 실수집 증거는 없으며, 외부 제한 해제 전에는 실수집 정상 완료로 보고하지 않습니다.
- 코드 `3cb3557`을 GitHub `main`과 Production `dpl_AANxSpPzQXeD5XNSm3keASq7CQg4`·운영 별칭에 반영했습니다. `/health`·`/ready`는 운영 릴리스 `3cb355707396`, 서울 `icn1`, Supabase ready입니다. 배포 live gate의 기존 최근 300개 증거와 1.0.8 신규 실수집은 구분합니다.

### 2026-08-08 N상품 보안확인 반복 차단 안정화 배포 승인·실수집 확인 대기

- 보안확인은 4건 처리 전에 이미 `max_jobs=2`에서 발생했으며, 4건 설정 실행도 첫 작업에서 기존 확인 화면을 감지하고 중단했습니다.
- 안전 상한을 2건으로 복귀하고 기존 보안확인 탭이 해결되기 전에는 서버 작업을 선점하지 않도록 확장 1.0.6을 우선 보완했습니다.
- 1.0.6 첫 운영 재검증은 11:42:54 UTC에 `max_jobs=2`로 실행됐으나, 사용자가 해결한 정상 탭을 닫고 다음 키워드 `당뇨쌀`을 새 백그라운드 탭으로 연 직후 보안확인이 다시 발생했습니다. 처리량이 아니라 검증 완료 탭을 재사용하지 않는 흐름이 남은 직접 원인입니다.
- 확장 1.0.7은 해결된 탭을 닫지 않고 같은 탭에서 페이지 1~8과 회차 최대 2개 작업을 순차 처리한 뒤 성공 시에만 닫습니다. 페이지 간 3.5~6초, 보안확인 즉시 중단·1시간 쿨다운, 300개 원자 저장과 마지막 정상값 보존은 유지합니다.
- 전체 API·서버 389/389, 플레이스·쇼핑 각 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·58파일·14마이그레이션과 전체 `check:release`, `git diff --check`를 통과했습니다.
- 코드 `9f03a72`를 GitHub `main`과 Production `dpl_DuwFf2wiBejh1iR5MQmmNQsQjEdU`·운영 별칭에 반영했습니다. `/health`·`/ready`는 릴리스 `9f03a726a673`, 서울 `icn1`, Supabase ready입니다.
- 현재 `당뇨쌀` 보안확인은 자동 우회하지 않으며, 직접 확인 완료·확장 1.0.7 재로드 후 신규 `pw-chrome-*`·`checked_count=300` 실증 전에는 운영 실수집 정상화를 완료로 보고하지 않습니다. 배포 빌드의 live gate는 기존 최근 300개 원자 증거를 검증했으며 1.0.7 신규 수집 증거를 뜻하지 않습니다.

### 2026-08-08 N상품 Mac 안전 처리량·대기열 멱등화 Production 반영

- Mac Chrome 수집은 병렬화하지 않고 10분 회차 상한만 2건에서 4건으로 확대하는 범위입니다.
- 광고주별 `전체 순위 갱신`과 확장 수동 전체 갱신은 이미 대기 중인 행을 다시 갱신하지 않고, 새로 대기시킨 수·이미 대기 중인 수·처리 중 수를 분리합니다.
- 가장 오래 기다린 `next_check_at` 우선 claim과 조건부 lease는 유지하므로 반복 클릭이 다른 광고주의 기존 대기 순서를 밀어내지 않습니다.
- 대상 96/96, 전체 앱·API 389/389, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 self-test와 전체 `npm run check:release`, `git diff --check`를 통과했습니다.
- 코드 `1d7b773`을 GitHub `main`과 Production `dpl_H5Jtb4sZR3yNGV75PKAxZnwLgvYp`·운영 별칭에 반영했습니다. `/health`·`/ready`는 릴리스 `1d7b77338bfc`·서울 `icn1`·Supabase ready입니다.
- 중앙 Mac 브리지를 같은 코드로 재설치했고 저장소와 설치 wrapper의 SHA-256 `13edcfe18410dd657a9f5e9a3a2a6b779ba7ddd0a251465477a8e1b16afddbf8` 일치, 설치값 `max_jobs=4`, LaunchAgent 등록·최근 exit 0을 확인했습니다.
- 설치 후 스케줄러는 `Default` Chrome 준비를 계속 확인했으나 새 native-host 작업을 가져간 기록은 아직 없습니다. 따라서 첫 자연 회차의 `max_jobs=4`와 신규 `checked_count=300` 증거는 운영 관찰 대상으로 남기며, 이를 실수집 완료로 과장하지 않습니다.

### 2026-08-08 N상품 30일 순위 날짜별 단일 표시 Production 반영

- 관리자와 광고주 화면의 30일 순위 표에서 `AM`/`PM` 구분을 제거하고 날짜별 대표 순위 1개만 표시하도록 변경했습니다.
- 같은 날짜에 여러 수집값이 있으면 `checkedAt`이 가장 최신인 유효 순위를 사용하며, 오전 또는 오후 한쪽만 수집된 날은 존재하는 값을 사용합니다.
- 순위 수집 주기, 저장 데이터, 정확 상품 판정, 광고 제외, 300개 확인 규칙은 변경하지 않았습니다.
- 날짜별 양쪽/한쪽/공란 조합 동작 검증은 관리자·광고주 합계 `10/10`, 전체 `npm run check:release`는 통과했습니다.
- 코드 `01dd688`을 GitHub `main`과 운영 릴리스 `01dd688b814b`에 반영했습니다. `/health`·`/ready`는 200, 서울 `icn1`, Supabase ready이며 운영 관리자·광고주 HTML은 검증 빌드와 SHA-256이 일치합니다. 로그인된 관리자 실데이터 367개 날짜 카드가 모두 슬롯 1개이고 AM/PM 라벨은 0개인 것을 확인했습니다. 광고주 접속 코드 세션이 없어 광고주 실데이터 육안 검수는 하지 못했지만 동일 코드 대상 테스트와 운영 HTML 일치는 확인했습니다.

### 2026-08-03 확장 수동 갱신 → 사이트 전체 활성 추적 등록

- 공식 답변으로 쇼핑 검색 API가 2026-07-31 종료됐고 API Hub·별도 제휴·유료 대체 API도 현재 제공되지 않음을 재확인했다. 종료 API나 Hub 통계값을 순위로 재사용하지 않는다.
- 확장프로그램의 `지금 안전 갱신`만 HMAC·nonce 인증 서버 작업을 먼저 호출해 모든 계정의 `status=active` 상품 추적을 현재 대기열에 등록하도록 보완했다. 미래 시각으로 예약돼 기존 수동 실행에서 빠지던 항목과 신규 등록 키워드도 다음 수동 실행에 포함된다. 처리 중 lease는 건드리지 않고 계정 코드·tracker ID 목록은 응답하지 않는다.
- 수동 1회는 회차당 최대 2건만 즉시 처리하고, 남은 항목은 기존 10분 catch-up이 순차 처리한다. 자동 09:00·15:00·10분 보정은 전체를 매번 다시 등록하지 않고 기존 due만 처리해 네이버 요청 집중을 막는다.
- 운영 DB 읽기 전용 확인은 active 71·고유 키워드 58·기존 due 61·미도래 10·활성 lease 0이다. 새 수동 대기열은 기존 방식이 놓치던 미도래 10건까지 포함하도록 구현됐다. DB 스키마·기존 tracker·snapshot·순위 계산·운영팀/광고주 화면은 변경하지 않았다.
- 대상 42/42, API·서버 389/389, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 역할 5상태, 보호 잠금 22함수·58파일·14마이그레이션과 전체 `npm run check:release`를 통과했다.
- 코드 `2924d82`를 GitHub `main`과 Production `dpl_9zLh7gMu554Uo1tHnF7BcUtmWid9`·운영 별칭에 반영했다. `/health`·`/ready`는 릴리스 `2924d82801e5`·서울 `icn1`·Supabase ready이고 무서명 워커 요청은 401로 차단된다. 중앙 Mac 브리지 설치본 두 핵심 파일의 SHA-256은 저장소와 일치하며 LaunchAgent 최근 실행은 exit 0이다.
- Chrome 보안 정책상 `chrome://extensions` 내부 재로드 버튼은 자동 조작하지 않았다. 확장 소스는 1.0.5이며 사용자가 기존 확장 관리 화면에서 한 번 재로드한 뒤 `지금 안전 갱신`을 직접 눌러 `전체 71개 등록`과 신규 `pw-chrome-*`·`checked_count=300` 증가를 확인해야 한다. 이 실증 전에는 전체 순위 갱신 완료로 과장하지 않는다.

### 2026-08-03 N 30일 7월 31일 정체 전수 진단·완화 Production 반영

- 운영 DB의 사이트 전체 active 상품 추적 71건·고유 키워드 58개를 전수 확인했다. 29건·28개 키워드는 최신 snapshot 원천이 종료된 `naver_shopping_search_api`인 채 7월 31일에 남았고, 42건만 신규 수집 경로로 넘어갔다. 특정 키워드·계정·상품 매칭 문제가 아니라 전환 대기열 후반이 처리되지 않은 문제다.
- 중앙 워커가 한 회차 최대 25건을 처리하고 성공 직후 1분 후속 실행까지 이어 네이버 쇼핑 8페이지 요청이 짧은 시간에 집중됐다. 2026-08-03 02:05 KST부터 native host가 `naver_verification_required`로 반복 중단됐고, 이후 신규 strict 300 snapshot이 생성되지 않은 것이 직접 원인이다.
- 중앙 실행 기본값을 회차당 2건으로 제한하고 마지막 슬롯은 30일 tracker를 우선 claim해 단건 큐가 많아도 정기 추적이 밀리지 않게 했다. 페이지 간격은 3.5초에 0~2.5초 분산을 더하고, 보안확인·captcha·HTTP 418/429가 발생하면 실제 확인 탭 하나만 남긴 채 1시간 자동 휴지한다. 성공 직후 1분 재실행은 제거하고 기존 10분 보정으로만 이어 처리한다.
- 정확 상품·원부 판정, 광고 제외, 300개 원자 저장, 계정 격리와 기존 tracker/snapshot은 변경하지 않았다. 실패·보안확인·부분 수집은 새 순위로 저장하지 않고 마지막 정상값을 유지한다.
- 워커·native host·단건 큐 대상 45/45, 보호 잠금 self-test 22함수·58파일·14마이그레이션, API·서버 387/387, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, 인증 18/18과 전체 `npm run check:release`를 통과했다. 중앙 Mac 설치본의 worker·wrapper SHA-256도 저장소와 일치한다.
- 코드 `06443c4`를 GitHub `main`과 Production `dpl_4MX12SCV1m6jqKB3EHchCYuWLPzu`·운영 별칭에 반영했다. `/health`·`/ready`는 릴리스 `06443c402610`·서울 `icn1`·Supabase ready를 반환한다. 확장 재로드 후 2026-08-03 04:10:33 KST 운영 실행이 새 한도 `max_jobs=2`로 시작했으나 첫 키워드에서 기존 네이버 보안확인을 감지해 5초 안에 안전 중단됐다. 사용자가 열린 확인 탭을 완료한 뒤 신규 `pw-chrome-*`·`checked_count=300` 원자 snapshot과 정체 29건 감소를 확인하기 전에는 운영 정상 완료로 보고하지 않는다.

### 2026-08-03 NAVER API Hub·Ncloud 크레딧 활용 판단

- Production은 `NAVER_API_HUB_MODE=hub`와 Hub 전용 키 쌍으로 고정되어 있으며 공식 실호출은 Search 200·Search Trend 200·Shopping Insight 200이다. 종료 legacy 키는 이 세 기능의 런타임에 사용하지 않는다.
- NAVER API Hub의 쇼핑 기능은 카테고리·키워드 클릭 추이인 Shopping Insight다. 상품 검색 결과 1~300개나 광고 제외 오가닉 절대 순위를 반환하는 공식 endpoint는 없으므로, Hub 크레딧·키 교체만으로 N 상품 순위를 생성하지 않는다.
- 보유 크레딧을 활용할 수 있는 현실적인 후보는 한국 리전 Ncloud Server의 격리 브라우저 수집 canary다. 다만 클라우드 데이터센터 IP도 네이버 보안확인을 받을 수 있으므로 Production·Supabase에 연결하기 전에 무저장 단일 키워드 300개 수집을 3회 연속 통과해야 한다.
- 서버 생성은 종량 과금과 공인 IP·트래픽 비용이 발생할 수 있다. 사용자 승인 없이 유료 리소스·자동 결제·공인 IP를 만들지 않으며, canary 실패 시 즉시 반납하는 별도 절차로 진행한다.

### 2026-08-03 N 30일 계정별 전체 갱신·중앙 자동 드레인 정상화

- 운영팀·광고주의 `전체 순위 갱신`을 tracker별 장시간 API 반복 호출에서 현재 로그인 계정의 운영 중 tracker 전체를 한 번에 대기열에 넣는 서버 작업으로 전환했다. 다른 계정, 중지 항목, 진행 중 lease는 변경하지 않는다.
- 중앙 Chrome 확장은 한 회차를 오류 없이 처리하면 1분 뒤 후속 회차를 자동 예약해 25개 한도 뒤 남은 사이트 전체 대기열을 이어 처리한다. 일부 실패는 더 이상 완료로 표시하지 않고 `갱신 N건 · 재시도 N건`으로 구분한다.
- 순위 판정·광고 제외·정확 상품/원부 판정·300개 원자 저장 계약은 변경하지 않았다. 실패·부분 수집은 새 snapshot을 만들지 않고 마지막 정상 순위와 30일 이력을 보존한다.
- 계정 격리·운영팀/광고주 parity·확장 자동 이어받기 대상 검사, API·서버 386/386, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, 인증 18/18, 보호 잠금 22함수·58파일·14마이그레이션과 전체 `npm run check:release`를 통과했다.
- 코드 `b70848c`를 Production `dpl_FPGs2Mt6kyimepmktqvNyBcWv4tL`와 운영 별칭에 반영했다. `/health`·`/ready` 200, 릴리스 `b70848c46736`, 서울 `icn1`, Supabase ready, 양 역할 배포 마커와 비인증 401을 확인했고 중앙 Mac 브리지 설치본도 같은 코드로 갱신했다.
- 현재 운영 DB는 active 71·due 17·진행 lease 0·최근 1시간 확인 11이다. Chrome 제어 확장 연결이 끊겨 사용자 Chrome을 강제 종료하지 않았으므로 Moment 확장 1회 재로드 뒤 후속 1분 자동 회차와 전체 due 완주는 신규 `pw-chrome-*`·`checked_count=300` snapshot으로 계속 확인한다.

### 2026-08-03 8월 운영 공지·N 상품 단건 중앙 Mac 300위 대기열 Production 반영

- 운영팀·광고주의 `N 상품 순위`는 기존 서버 즉시 exact 조회가 확정되지 않을 때 별도 단건 작업 큐에 등록하고, 중앙 Mac이 광고 제외 오가닉을 정확히 300개 수집한 뒤 같은 로그인 범위에만 결과를 반환하도록 연결했다. 메뉴명은 양 역할 모두 `N 상품 순위 (개발중)`으로 표시한다.
- 단건 큐는 30일 tracker·snapshot과 완전히 분리했다. 성공한 300개 결과만 단건 응답으로 원자 저장하며 실패·보안확인·부분 수집은 30일 순위와 마지막 정상값을 변경하지 않는다.
- DB에는 원문 계정 코드를 저장하지 않고 단방향 범위 해시만 저장한다. 강제 RLS·service-role 전용 RPC·활성 요청 중복 방지·`FOR UPDATE SKIP LOCKED` 임대 잠금·요청 범위당 동시 작업 상한을 적용했다.
- 중앙 워커는 단건 요청을 우선 처리하되 세 번째 claim마다 기존 30일 대기열을 우선해 정기 추적이 밀리지 않게 했다. 화면은 3초 간격으로 최대 10분 확인하며, 시간 초과 후 다시 누르면 같은 활성 요청을 이어받는다.
- 메인 서비스 안내를 `8월 서비스 운영 안내`로 정돈해 API 환경 변경에 따른 조회 지연 가능성과 개발 중 기능을 제외한 09:00·15:00 자동 갱신 일정을 알린다. 운영팀·광고주 메뉴의 `키워드 조회`, `SEO 확인`, `N 상품 순위`에는 모두 `(개발중)`을 표시한다.
- 대상 단위·통합 검사를 포함한 API·서버 384/384, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, 인증 18/18, 역할 5상태, 운영팀·광고주·총관리자 parity, 보호 잠금 22함수·58파일·14마이그레이션, 공개 빌드/CSP와 전체 `npm run check:release`를 통과했다.
- Production DB에 큐 마이그레이션과 최소권한 보정 마이그레이션을 적용했다. 강제 RLS와 service-role 전용 RPC를 유지하며 실제 테이블 권한은 `SELECT·INSERT·UPDATE·DELETE`만 남겼다.
- 코드 `2c44c2e`를 Production `dpl_2n8X63qVqaUzScvyUqurSNqgUWGs`와 운영 별칭에 반영했다. `/health`·`/ready` 200, 릴리스 `2c44c2e3df6f`, 서울 `icn1`, Supabase ready, 공지·세 개발중 메뉴·09:00/15:00 문구, 비인증 단건 큐 401·무서명 중앙 워커 401을 확인했다.
- 중앙 Mac 브리지와 LaunchAgent 설치본을 같은 코드로 재설치했고 스케줄러 등록·최근 exit 0을 확인했다. 현재 Chrome 원격 제어 연결이 응답하지 않아 실행 중인 사용자 탭을 강제 재시작하지 않았으며, 이번 버전의 실제 단건 `checkedCount=300` 완료 증거는 다음 자연 실행 또는 Chrome 확장 재로드 후 확인 대상으로 남긴다. 기존 30일 마지막 정상값과 이력은 변경하지 않았다.

### 2026-08-03 사이트 갱신과 중앙 Mac 300위 대기열 연결

- 운영팀·광고주의 `N 30일 순위` 단건/전체 갱신이 서버 상위 즉시조회 범위를 벗어나면 다음 정기시간으로 넘기지 않고 해당 tracker의 `next_check_at`을 현재 시각으로 되돌려 중앙 Mac 300위 수집 대기열에 남긴다.
- hybrid 모드의 화면 진입 `sync-due`는 서버 상위 범위 조회로 대기열을 선점하지 않고, 계정 범위의 대기 건수만 반환한다. 중앙 워커의 HMAC·nonce·lease·정확히 300개 원자 저장 계약은 그대로 유지한다.
- Mac이 켜진 동안 수동 갱신을 최대 약 10분 안에 받아가도록 일반 Chrome 준비 LaunchAgent에 600초 보정을 추가하고 확장프로그램 catch-up도 10분으로 맞췄다. 09:00·15:00 정규 실행은 그대로다.
- 수집 실패·보안확인·부분 300개는 새 snapshot을 만들지 않고 마지막 정상 순위와 30일 이력을 유지한다. 관리자·광고주 HTML, 순위 계산·원부/정확 상품 판정, Supabase 스키마·기존 데이터는 변경하지 않았다.
- `N 상품 순위` 단건은 서버가 검증한 상위 즉시조회 범위 안의 정확 ID는 계속 바로 확인할 수 있다. 그 범위 밖의 300위 단건은 현재 임시 작업 큐가 없으므로 `N 30일 순위`에 등록한 뒤 중앙 Mac 수집으로 확인한다.
- 대상 63/63, 전체 API·서버 376/376, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·55파일·12마이그레이션, 배포정책 3/3, LaunchAgent plist·exit 0과 전체 `npm run check:release`를 통과했다.
- Production 배포 검사는 중앙 Mac의 최근 원자 300개 증거를 필수로 유지한다. 네이버 상단 즉시조회가 일시 구조 변형으로 닫혀도 잘못된 순위를 허용하지 않고 단건 exact만 `일시 사용 불가`로 실패시키며, 검증된 중앙 300위 대기열·마지막 정상값 보존·사이트 갱신 배포는 계속 허용하도록 두 증거를 분리했다.
- 코드 `3061f7b`를 Production `dpl_F7Csp8xqRwVDyJSF7E3UnqK92KWB`와 운영 별칭에 반영했다. 배포 게이트는 15분 전 `pw-*`·300개 원자 증거를 통과했고, 운영 `/health`·`/ready` 200·릴리스 `3061f7be5a9b`·서울 `icn1`, 비인증 순위 API 401·무서명 중앙 워커 401을 확인했다.

### 2026-08-03 N 쇼핑 일반 Chrome 자동 수집 전환

- 운영 기준을 유료 클라우드 수집기가 아니라 `Mac 전원·인터넷이 켜진 상태의 동빈 Chrome`으로 확정했다. 고객 브라우저 설치가 아니라 모먼트랩스 중앙 Mac 1대가 사이트 전체의 도래 tracker를 처리한다.
- macOS LaunchAgent가 매일 08:50·14:50 KST와 10분 보정 주기로 승인된 `/Users/sindongbin/Desktop/Google Chrome.app`의 `Default(동빈)` 프로필만 준비한다. 확장 프로그램은 09:00·15:00 정규 실행과 10분 미처리 보정을 유지한다.
- 8페이지 요청 사이에 1.25초 간격을 두고, 보안확인·418·429·페이지 근거 누락이 발생하면 현재 lease만 안전 해제한 뒤 해당 실행을 즉시 중단한다. 남은 tracker를 계속 호출하지 않으며 마지막 정상 순위와 30일 이력은 보존한다.
- 현재 일반 Chrome의 `온열찜질기` 가격비교 화면은 보안확인 없음·`__NEXT_DATA__` 존재를 확인했다. 최근 운영 DB에는 `checked_count=300` 원자 snapshot 17건이 있으며, 이후 짧은 시간에 연속 호출한 실행의 실패 28건은 이번 속도 제한·즉시 중단 대상으로 고정했다.
- 스케줄러 plist는 문법 정상, 실행 시 승인 프로필 준비 로그와 exit 0을 확인했다. 소스 반영을 위한 Chrome 확장프로그램 1회 재로드는 사용 중인 Chrome 창을 강제로 종료하지 않기 위해 남겨 두었다.
- 관리자·광고주 HTML, 순위 계산·표시, 기존 snapshot과 Supabase 스키마는 변경하지 않았다. 로컬 설치만 완료했으며 GitHub push·Vercel Production 배포는 별도 승인 전 진행하지 않는다.
- 전체 `npm run check:release`에서 API·서버 371/371, 플레이스 수집기 51/51, 쇼핑 수집기 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·54파일·12마이그레이션을 통과했다.

- N 상품 순위는 종료된 쇼핑 검색 API나 NAVER API Hub의 연장이 아니다. Hub에는 전체 쇼핑 오가닉 순위 endpoint가 없으며 키워드 상품 참고값, N 상품 단건, N 30일 추적은 `mi.naver-shopping-organic-window.v1`과 정확 ID 근거만 사용한다.
- 현재 로컬 변경의 목표 모드는 `hybrid_local_worker`다. 서버 즉시 경로는 네이버 모바일 통합검색이 반환한 명시적 SAS 상품에서 광고를 제외하고 각 상품의 공식 절대 순위 exact hit만 확정한다. 반환되지 않은 슬롯은 순위를 압축하지 않고, miss는 연속 확인 범위까지만 판단하며 그 밖은 기존값을 보존한다.
- 정확한 1~300위 수집은 사용자가 승인한 일반 `동빈` Chrome 프로필의 최소권한 확장 프로그램으로 수행한다. 공개 쇼핑 페이지의 `__NEXT_DATA__`만 읽고 쿠키·비밀번호·방문기록 권한은 가지지 않으며 HMAC 비밀값은 macOS 키체인에만 둔다. HMAC 서명·유효시간·1회용 nonce·lease·원자 DB commit을 강제하고 부분·광고·중복·순위 공백·collection 충돌은 전체 거부한다.
- 오전 9시·오후 3시에 로컬 워커가 먼저 처리하고 후속 재시도와 매시 안전 실행이 남은 due tracker를 처리한다. Mac이 꺼져 있으면 새 51~300위 증거는 만들 수 없지만 서버 상위 50위 경로와 마지막 정상 순위·snapshot·30일 이력 보존은 계속된다.
- 유료 외부 수집기·카드·자동 결제, 비밀번호·쿠키 서버 전송, CAPTCHA 자동 우회는 허용하지 않는다.
- 일반 Chrome 실화면에서 `온열찜질기` 페이지 1~8의 광고 4+오가닉 40 구성과 오가닉 1~320 연속, 상품 `12149720593` 정확 91위를 확인했다. 운영 API 실점검에서 공통 로그인 세션 장벽이 HMAC 워커보다 먼저 `401 SESSION_REQUIRED`를 반환하는 배선 결함도 찾아, 정확한 `/api/naver-shopping-local-worker`만 세션 장벽 밖에 두고 기존 HMAC·nonce 검증이 직접 인증하도록 수정했다.
- 확장 설치 후 `native_host_disconnected`가 발생한 직접 원인은 Chrome이 Desktop 개발 저장소의 실행 파일을 직접 열도록 설치된 구조와 실행 중 설치된 manifest 캐시였다. 실행 파일과 필요한 모듈만 권한 700/600의 `$HOME/Library/Application Support/MomentInsight/NaverShoppingBridge`에 독립 설치하고 Chrome manifest도 이 경로만 가리키도록 수정했다. 비밀값·검색어·상품정보는 로그에 기록하지 않는다.
- `chrome://restart` 후 수동 안전 갱신은 세 번 연속 네이티브 호스트 `status=0`으로 종료됐다. 2026-08-02 23:19 KST DB에 `collection_id=pw-chrome-*`, `checked_count=300`, `source=naver_shopping_results_collector`인 원자 snapshot이 저장됐고 exact 상품은 16위로 매칭됐다. 광고·부분·중복·순위 공백은 기존 계약대로 저장 전에 거부한다.
- 중앙 워커의 claim은 총관리자나 `mml93-a01`에 고정되지 않고 사이트 전체에서 `status=active`이고 `next_check_at`이 도래한 tracker를 가져온다. Chrome이 다시 깨어날 때 기존 09시·15시·매시 보정 알람을 재생성해 시간을 밀던 가능성도 차단해, 없는 알람만 생성한다. 집중 18/18, API·서버 364/364, 플레이스 51/51, 쇼핑 수집기 49/49, 서버 계약 37/37, 인증 18/18, 보호 잠금 22함수·53파일·12마이그레이션과 전체 `check:release`를 통과했다.
- 실페이지 재검사에서 네이버 BFF가 요청 50개에 `pageSize=49`·슬롯 49개를 반환하는 현재 구조를 확인했다. 응답 pageSize가 실제 슬롯 수 이상·최대 50이고 공식 절대 순위가 증가할 때만 허용하도록 보완했으며, 실호출은 광고 제외 SAS 44개·정확 순위 45위까지 확인, 미발견 판단 연속 범위 9위, Chrome 원자 300개 증거를 함께 통과해 `SHOPPING_RANK_HYBRID_LIVE_READY`·배포 가능 상태다.
- 코드 `98254b3`을 Production `momentinsight-5vefl2vyq-momentlabs.vercel.app`과 운영 별칭에 반영했다. `/health`·`/ready`는 HTTP 200·릴리스 `98254b32c54d`·서울 `icn1`이고, 무서명 워커 요청은 전용 인증 401, 키체인 서명 요청은 인증 통과 뒤 무해한 잘못된 action 400으로 끝나 운영 HMAC 비밀값 일치와 세션 경계 분리를 확인했다.
- 고객 브라우저마다 확장을 설치하는 구조가 아니라 모먼트랩스 중앙 수집 장비 1대가 전체 계정의 도래 작업을 처리한다. 다만 그 장비의 Mac 또는 Chrome이 완전히 꺼져 있으면 새 51~300위 수집은 실행될 수 없다.

> 아래 항목은 각 작성 시점의 전환·장애·배포 이력이다. 현재 N 상품 실행 판단은 위 2026-08-02 hybrid 계약과 최근 `pw-*` 300위 실증 여부를 기준으로 한다.

- 2026-07-31 종료 쇼핑 API 전수 제거·공용 수집 계약 통합 로컬 완료: 키워드 조회와 N 상품 단건·30일 순위가 더 이상 종료된 `/v1/search/shop.json` 또는 legacy 쇼핑 키를 호출하지 않는다. 두 기능은 하나의 검증 수집원 `NAVER_SHOPPING_RANK_API_URL/KEY`와 `naver_shopping_results_collector`·`naver_shopping_organic_list` 증거 계약만 사용한다. 수집원이 없거나 응답이 불완전하면 키워드의 지원 API 결과만 부분 제공하고, 상품 순위·snapshot·기존 30일 이력은 변경하지 않는다. 모드 누락·오타도 legacy로 조용히 되돌아가지 않고 fail-closed 처리하며 로컬 서버와 두 환경 검증 스크립트 모두 루트 `.env.local`을 같은 우선순위로 사용한다.
- 자동·2차 검증은 API·서버 252/252, 플레이스 수집기 51/51, 서버 계약 29/29, Production 인증 18/18, 역할 5상태·운영팀/광고주 parity, 보호 잠금 21함수/23파일/11마이그레이션, 공개 빌드·CSP와 전체 `npm run check:release`를 통과했다. 신규 Hub 실호출은 blog 200·1건·209ms, Search Trend 200·31건·157ms, Shopping Insight age 200·12건·53ms다. 런타임 코드의 종료 쇼핑 URL은 0건이며 이를 릴리스 기준선으로 고정했다.
- 배포 보류 사유: Production에 검증 쇼핑 수집원 키 쌍이 없어 실상품 300위 canary, `mml93-a01` 25/25, 사이트 전체 71개, cron 2회 검증을 수행할 수 없다. 네이버 공식 Hub에는 N 쇼핑 상품검색 대체 API가 없으므로 Hub URL 치환만으로 이 증거를 만들 수 없다. 따라서 로컬 변경과 기존 DB 5,554개 상품·플레이스 snapshot은 보존하고 push·Production 배포는 하지 않는다.

- 2026-07-31 NAVER API Hub 운영 고정·실호출 검증 완료: 등록된 공식 키 쌍과 `NAVER_API_HUB_MODE=hub`를 배포 필수 조건으로 승격하고, `auto/legacy` 오설정·불완전 키 쌍을 배포 전에 차단한다. Hub Search에서 지원하지 않는 `shop` 등 리소스는 요청 전에 거부해 잘못된 대체 경로를 만들지 않는다. 공식 실키로 블로그 검색 200/195ms·검색어 트렌드 200/77ms·쇼핑 인사이트 연령 200/165ms를 확인했고 비밀값은 출력·커밋하지 않았다. N 상품 단건·30일 순위는 공식 Hub 이관 대상이 아니므로 마지막 정상값·이력 보호만 배포하며 신규 순위를 발명하지 않는다.
- 코드 `6d70f56`·상품 보호 코드 `b6466a3`을 Production `dpl_99XvbXnx3qnk94Xs9R5P4NPrEtLe`에 배포했다. 운영 릴리스 `6d70f56364a7`·서울 `icn1`, `/health`·`/ready` 200, 관리자·광고주 검증 빌드 완전 일치, 비인증 보호 API 401을 확인했다. 배포 후 공식 Hub 재검사는 블로그 검색 200/154ms·검색어 트렌드 200/139ms·쇼핑 인사이트 연령 200/53ms다.

- N 상품 30일 전체 갱신 `성공 0개·재시도 25개` 재진단 완료: 운영 `mml93-a01`의 25개 추적기 모두 신규 snapshot 없이 `shopping_rank_source_unavailable`로 끝났고, Production에는 검증 수집원 환경값 `NAVER_SHOPPING_RANK_API_URL`·`NAVER_SHOPPING_RANK_API_KEY`가 없다. 종료된 legacy `/v1/search/shop.json` 키를 순위 수집 준비 완료로 잘못 판단해 25건을 호출한 뒤 화면이 전건을 한 번 더 재시도해 최대 50회 실패했고, cron의 부분 실패 502도 공통 오류 보호층에서 500으로 바뀌어 후속 배치가 멈추던 것이 직접 원인이다. Supabase 용량·잠금·세션·Mac 전원은 원인이 아니며 기존 순위와 30일 snapshot은 보존돼 있다.
- 로컬 보호 수정·검증 완료, 실수집 복구·배포 대기: legacy 키는 순위 수집원으로 인정하지 않고 검증된 외부 오가닉 300 수집원 키 쌍만 준비 완료로 판단한다. 미연결 상태에서는 단건·전체 갱신·자동 cron이 DB claim·순위 변경·snapshot 생성 없이 한 번에 중단하며 마지막 정상값을 유지하고, 화면은 재시도 대상이 아닌 `수집원 미연결`로 표시한다. 실행 중 수집원이 끊기면 최대 동시 2건까지만 종료하고 나머지는 보류하며 영구 오류 전건 2차 재호출을 차단한다. cron 502 타입·집계는 보안층을 통과해도 유지하되 키워드·추적기 ID·상품값은 노출하지 않는다. 전체 API·서버 251/251, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18, 역할 5상태·운영팀/광고주 parity·보호 잠금 21함수/23파일/11마이그레이션, 공개 빌드·CSP와 전체 `check:release`가 통과했다. Production 빌드는 실제 수집원 두 환경값 없이는 실패하도록 차단했다. 실제 수집원이 아직 없으므로 실상품 canary·25/25·사이트 전체 71개·cron 2회 증명은 미완료이며 push·Production 배포하지 않는다.

- 업무 완료 체크 양방향 해제 수정·Production 반영 완료: 완료된 업무 버튼이 `disabled` 처리되고 처리 함수도 완료 상태를 조기 종료해 해제 경로가 없던 원인을 확정했다. 같은 체크 버튼으로 `완료 ↔ 예정`을 전환하고, 일정·업무 유형·우선순위·내부 메모·광고주 공개값은 기존 payload로 그대로 보존한다. 완료 상태에서도 버튼을 다시 누를 수 있으며 상태별 접근성 안내와 처리 결과 문구를 제공한다.
- 검증·배포 상태: 완료·해제 보존 단위검사 8/8, API·서버 237/237, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18, 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드·CSP와 전체 `check:release`가 통과했다. `client.html`, 업무 서버·DB·운영 데이터와 5대 보호 기능은 변경하지 않았다. 코드 `ba5fc23`을 GitHub `main`에 푸시했고 운영 `/health`·`/ready`는 릴리스 `ba5fc233c111`·서울 `icn1`·Supabase ready·누락 0건을 반환했다. 운영 HTML에서 양방향 함수·완료 해제·접근성 마커가 있고 기존 완료 버튼 `disabled` 표식이 제거된 것을 확인했다.

- 업무 운영 실행 중심 압축·즉시 완료 Production 반영 완료: 상단 요약을 `오늘 업무·지연 업무·확인 필요` 필터로 전환해 캘린더와 가까운 업무 목록을 즉시 좁혀 볼 수 있다. 가까운 업무의 체크 버튼은 편집창을 열지 않고 완료 상태만 저장하며 기존 일정·업무 유형·우선순위·내부 메모·광고주 공개값을 그대로 보존한다. 등록창은 제목·시작·상태·광고주 공개를 우선 노출하고 나머지는 `상세 설정`에 접어 기본 입력 밀도를 낮췄다. 모바일 요약은 3열 압축형이다.
- 검증·배포 상태: 새 회귀 기준선과 즉시 완료 보존 단위검사를 추가했다. API·서버 236/236, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18, 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드·CSP와 전체 `check:release`를 배포 직전 재통과했다. `client.html`, 업무 서버·DB·운영 데이터와 5대 보호 기능은 변경하지 않았다. 코드 `2aeb67d`를 GitHub `main`에 푸시했고 운영 `/health`·`/ready`는 릴리스 `2aeb67d3c563`·서울 `icn1`·Supabase ready·누락 0건을 반환했다. 운영 관리자 HTML에서 세 요약 필터·빠른 완료·상세 설정 마커를 재확인했다. 앱 브라우저의 localhost 차단으로 변경 후 실계정 육안 검수는 대표님 확인 항목으로 남긴다.

- 업무 등록 팝업·날짜 칸 전체 클릭 개선 완료·Production 반영: 팝업의 브라우저 기본 선택 UI와 일반 체크박스를 현재 딥네이비 입력·선택·공개 스위치로 통일하고 헤더·입력·하단 행동의 정보 위계를 정리했다. 입력부만 스크롤해 취소·저장 버튼은 데스크톱과 모바일에서 항상 보인다. 신규 등록창의 잘못 보이던 삭제 버튼은 숨기고 일정 수정에서만 유지한다. 날짜 숫자와 캘린더 셀의 빈 영역 모두 해당 날짜 09:00 등록창을 열며 일정 카드 클릭·드래그는 기존 수정·이동 동작을 우선 유지한다.
- 검증 상태: 로컬 브라우저 1280px·390×700에서 팝업 여백·행열·버튼 고정·가로 넘침을 확인했다. 빈 셀 `2026-07-08` 클릭은 `2026-07-08T09:00`을 입력한 등록창을 열고 신규 삭제 버튼은 보이지 않는다. 전체 API·서버 235/235, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18, 역할 5상태, 기준선, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드·CSP와 전체 `check:quality`가 로컬·Vercel에서 통과했다. `client.html`, 업무 API·DB·운영 데이터와 보호된 조회·추적 기능은 변경하지 않았다. 코드 `1bf6859`·Production `dpl_7tQpFm3W5RKY7UvYbLpxrCyJqEqz`, 운영 릴리스 `1bf68593e3af`·서울 `icn1`·Supabase ready다.

- 업무 일정 드래그 이동·확인 팝업 Production 반영 완료: 운영팀·총관리자 `업무 운영` 캘린더의 일정 카드를 데스크톱에서는 드래그하고 모바일에서는 320ms 길게 눌러 다른 날짜로 옮길 수 있다. 놓는 즉시 새 날짜에 미리 반영하지만 `기존 일정 → 변경 일정` 확인 팝업의 `일정 변경`을 눌러야 서버에 저장한다. 취소·ESC·팝업 바깥 클릭·저장 실패 시 시작·종료 일시를 원래 값으로 되돌린다.
- 보존·검증 상태: 기존 시간과 업무 길이, 종일 일정, 상태·우선순위·내부 메모·광고주 공개값을 함께 보존한다. 광고주 화면은 읽기 전용이며 이동 기능은 운영 화면에만 있다. 업무 6/6, 전체 API·서버 235/235, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18, 역할 5상태, 기준선, 서버 문법, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드 9파일·인라인 6개·CSP 해시 4개와 전체 릴리스 검사를 통과했다. `client.html`, Supabase 스키마·운영 데이터, 키워드·SEO·상품/플레이스 순위 수집·계산·저장은 변경하지 않았다. 코드 `d1e08f3`·Production `dpl_HQ6xoQJua3Cg5B46CvhM5d1RakuV`, 운영 릴리스 `d1e08f3607db`·서울 `icn1`·Supabase ready다.

- 업무 운영 화면 격리·광고주 코드 열거 차단 완료·Production 반영: `mi-work-shell`의 상시 `display:grid`가 공통 비활성 화면 숨김을 덮어 다른 메뉴에서도 캘린더가 남던 원인을 확정했다. 비활성 `mi-view`를 강제로 숨기고 업무 grid는 활성 화면에서만 적용한다. 총관리자 업무 범위 입력의 전체 광고주 코드 `datalist`와 연결 로직을 제거해 직접 입력한 단일 코드만 서버가 활성 광고주와 정확히 대조한다. 다른 메뉴로 이동하면 입력 코드·불러온 업무 범위를 폐기한다. 업무 API는 기존처럼 코드 목록을 반환하지 않고 공개 업무의 내부 메모·범위 값도 광고주에게 전달하지 않는다.
- 검증 상태: 로컬 브라우저에서 `대행사 연결`·`키워드 조회`·`업무 운영`을 각각 열었을 때 대상 화면 1개만 노출되고 업무 화면은 앞의 두 메뉴에서 `display:none`, 업무 메뉴에서만 `display:grid`다. 광고주 코드 `datalist`·`list` 연결은 0건이다. 역할 5상태, 보호 잠금 21함수·23파일·11마이그레이션, 서버 계약 29/29, API·서버 234/234, 플레이스 51/51, Production 인증 18/18, 공개 빌드 9파일·인라인 6개·CSP 해시 4개와 전체 `check:release`가 통과했다. `client.html`, DB, 순위 수집·계산·저장 기능은 변경하지 않았다.
- 배포 상태: 기능 코드 `0e8a4b0`과 배포 증거 `f9be8ca`를 GitHub `main`에 보존하고 Vercel Production `dpl_9qB4m8GJrsEfUPSKWRt6PVLkxcaY`에 반영했다. 운영 `/health`·`/ready`는 릴리스 `f9be8cadf997`·서울 `icn1`·Supabase ready, 관리자·광고주 화면 200, 비인증 업무 API 401이다. 운영 브라우저에서도 `대행사 연결`·`키워드 조회`·`업무 운영`의 단독 노출과 코드 `datalist`·`list` 0건을 재확인했다.

- 업무 운영 워크플로 1차 Production 반영 완료: 총관리자와 운영팀에 `업무 운영` 화면을 추가해 월간 캘린더, 오늘·내일·다음 업무, 업무 등록·수정·삭제, 담당자·상태·우선순위·내부 메모를 관리한다. 광고주가 없는 운영팀도 내부 업무를 사용할 수 있고, 광고주가 연결된 업무에서만 `광고주에게 일정 공개`를 켤 수 있다. 공개 기본값은 비공개이며 공개 시에도 광고주 API에는 공개 제목·일정·상태·공개 안내만 전달하고 내부 메모·계정 범위 값은 반환하지 않는다.
- 구현·검증 상태: `/api/work-items`, 역할별 서버 범위, 감사 로그, 광고주 `공유된 업무 일정` 화면과 `schedule_items` 확장 마이그레이션을 반영했다. Production Supabase의 컬럼 8개·제약 5개·인덱스 3개, 업무 전용 5/5, 서버 계약 29/29, 전체 API·서버 234/234, 플레이스 51/51, Production 인증 18/18, 역할·양 화면 parity, 보호 잠금, 공개 빌드·CSP와 전체 `check:release`를 확인했다. 코드 `5f73982`는 Production `dpl_DfTvnkrm9Fwbyuri3ie4bxm2gU15`에 포함됐다.
- 온열찜질기 오원부 3위 오류 수정·Production 반영 완료: 상품 `12149720593`은 네이버 상품유형 `2`인 원부 미연결 단일상품인데 동일 제조사·카테고리·키워드만으로 카탈로그 `59031763223`을 붙이고 35회 재사용한 원인을 확정했다. 상품유형 2/5/8/11에는 관련 원부를 생성·재사용하지 않고, 과거 원부는 최초 직접 관계 근거가 있을 때만 연속성 값으로 허용한다. 오원부 연결 스냅샷 52개를 정확 상품 순위로 교정했으며 새 Production 코드 자동 갱신에서도 300개 확인·정확 상품 76위·오원부 ID/순위 없음·오류/재시도 0건이다. 최고 2위는 과거 정확 상품ID `89694231298` 기록으로 확인했다. 코드 `fa07878`, Production `dpl_DfTvnkrm9Fwbyuri3ie4bxm2gU15`, 운영 릴리스 `fa07878aef0b`·서울 `icn1`·Supabase ready다.

- 전체 제품 E2E 고도화 1단계·운영팀 코드 수동 입력 고정 완료·배포 대기: Production 총관리자 화면을 읽기 전용 점검한 결과 `대행사 연결`의 운영팀 코드가 기존 규칙값으로 자동 채워지는 실제 보안·사용성 결함을 확인했다. 프런트 자동 제안과 서버의 빈 요청 자동 생성을 모두 제거하고 운영팀 코드를 직접 입력하지 않으면 400으로 거부하도록 고정했다. 기존 운영팀·광고주 계정, 연결, 권한, DB, `client.html`과 보호된 5대 조회·추적 기능은 변경하지 않았다.
- 검증 상태: 총관리자 운영 홈·광고주 미리보기·대행사 연결·운영 입력·보고서·공개 관리 Production 육안 점검, 대상 10/10, 보호 잠금 21함수·23파일·11마이그레이션, 역할 5상태, 운영팀·광고주 parity, 서버 계약 28/28, API·서버 227/227, 플레이스 51/51, 공개 빌드·CSP와 전체 `check:quality`가 통과했다. 앱 브라우저 localhost 차단과 Chrome 뷰포트 미적용으로 변경 후 실계정 모바일 육안 증명은 완료하지 못했으며 자동 반응형 계약만 통과했다. push·Production 배포는 하지 않았고, 전체 제품 고도화 지시는 이번 단일 결함으로 완료 처리하지 않고 다음 UI/UX 단계로 이어간다.

- N 상품 30일 순위 이미지 숫자 굵기 이전 상태 원복·Production 반영 완료: 직전 추가한 export 전용 `font-weight: 600` 규칙과 그 회귀 마커만 운영팀·광고주에서 제거해 `N위` 숫자를 이전 800 굵기로 복원했다. 15일×2단 배치, 날짜·실제 화면·순위 계산·수집·저장·AM/PM·대표값 로직은 변경하지 않았다. 관리자·광고주·기준선 3파일은 이전 배포 기준 `4a65c18`과 완전히 일치하며 역할 3종 parity·5상태, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 226/226, 플레이스 51/51, 서버 계약 28/28, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`를 로컬·Vercel에서 통과했다. 코드 `852581e`·Production `dpl_CecSdRr18gJ9vFLqVNrHHxKRjx9e`를 운영 별칭에 반영했고 `/health`·`/ready`는 릴리스 `852581e549d1`·서울 `icn1`·Supabase ready다. 관리자·광고주 HTML 200, 기존 800 규칙·600 규칙 제거·15칸 2단 유지를 확인했다.

- N 상품 30일 순위 이미지 숫자 굵기 경량화·Production 반영 완료: 운영팀·광고주 다운로드 이미지의 일별 `N위` 숫자만 `font-weight: 800`에서 `600`으로 낮춰 화면의 묵직함을 줄였다. 날짜는 800을 유지해 날짜와 값의 정보 계층을 보존했고, 15일×2단 배치·실제 화면·순위 계산·수집·저장·AM/PM·대표값 로직은 변경하지 않았다. 격리 브라우저 실측은 순위값 60개 전부 600·날짜 30개 전부 800·2단·가로 넘침 0이며 새 기준선, 역할 3종 parity·5상태, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 226/226, 플레이스 51/51, 서버 계약 28/28, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`를 로컬·Vercel에서 통과했다. 코드 `6b9e2b7`·Production `dpl_HNz8t2XLwcJ8nmmSxPKf5TTFdgTL`을 운영 별칭에 반영했고 `/health`·`/ready`는 릴리스 `a1766afbfa48`·서울 `icn1`·Supabase ready다. 관리자·광고주 HTML 200과 새 600 굵기 마커를 확인했다.

- N 상품 30일 순위 이미지 15일×2단 배치·Production 반영 완료: 운영팀·광고주 공통 다운로드 이미지의 일별 기록만 15칸씩 두 줄로 배치해 가로로 지나치게 길어지던 문제를 보완했다. 일반 화면의 가로 스크롤과 날짜·순위·AM/PM·대표값·수집·저장 로직은 변경하지 않았다. 격리 브라우저 실측은 30칸 `15+15`, 각 84px, 가로 넘침 0이며 새 기준선 `rankTrackingShareImageTwoRowHistory`, 역할 3종 parity·5상태, 보호 잠금 self-test와 현재값 21함수·23파일·11마이그레이션, API·서버 226/226, 플레이스 51/51, 서버 계약 28/28, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`를 로컬·Vercel에서 통과했다. 코드 `655473a`·Production `dpl_6XecRP7zgUWFcE7TvkwxFqKH1i4i`를 운영 별칭에 반영했고 `/health`·`/ready`는 릴리스 `655473a0e06d`·서울 `icn1`·Supabase ready다. 관리자·광고주 HTML 200, 새 15칸·2단 마커와 로컬 검증 빌드 SHA-256 일치를 확인했다.

- 총관리자 대행사 연결 생성 표식·활성 계정 요약 보완·Production 반영 완료: 운영팀·광고주 생성 카드의 불필요한 `선택 01`·`필수 02` 소형 배지를 제거했다. 대행사 연결의 활성 계정 요약은 운영팀 개별 계정·보고서/원본·추적 상태 행을 나열하지 않고 `운영팀 N팀 운영 중`·`광고주 N곳 운영 중` 2행만 표시한다. 실제 집계는 기존 총관리자 계정 API 응답의 활성 운영팀·활성 광고주 배열 길이를 사용하며 임의 값을 만들지 않는다. 상세 연결과 권한 해제는 기존 `전체보기`에 보존했고 계정 생성·해제 API, DB, `client.html`, 보호된 5대 조회·추적 기능은 변경하지 않았다. 1280×720 브라우저 실측에서 생성 배지 0건·요약 2행·개별 행 0건·가로 넘침 0이며, 역할 5상태·운영팀/광고주 parity·보호 잠금 21함수·23파일·11마이그레이션·API/서버 226/226·플레이스 51/51·서버 계약 28/28·Production 인증 18/18·CSP와 전체 `check:release`가 로컬·Vercel에서 통과했다. 코드 `e29339f`·Production `dpl_8he7h77pd7Zct8k4h92JsSdxPdRD`를 운영 별칭에 반영했고 `/health`·`/ready`는 릴리스 `e29339f8a0b1`·서울 `icn1`·Supabase ready다. 관리자·광고주 HTML 200, 배포 관리자 HTML의 배지 0건·집계형 렌더·상세 권한 관리 보존과 새 CSP 해시를 확인했다.

- 대행사 연결 화면 역할 정리·Production 반영 완료: 총관리자·운영팀의 `대행사 연결`에는 운영팀·광고주 발급, 활성 계정 조회·권한 해제만 남겼다. 실제 저장 기능이 연결된 `공개 데이터 설정`은 삭제하지 않고 전용 `공개 관리` 화면으로 이동했으며, 중복 `현재 연결 상태`와 사용자에게 불필요한 `권한 관리 구조`·`공개/비공개 기준` 설명은 제거했다. 공개 데이터 입력·저장 훅, 내부 메모·광고주 공개 코멘트, 계정 API·DB·`client.html`과 보호된 5대 조회·추적 기능은 변경하지 않았다. 1280×720 브라우저에서 대행사 연결의 제거 대상 0건·필수 버튼 4개·가로 넘침 0, 공개 관리의 입력·저장·메모 훅 보존·가로 넘침 0을 확인했다. 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 226/226, 플레이스 51/51, 서버 계약 28/28, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`가 로컬·Vercel에서 통과했다. 코드 `72e1576`·Production `dpl_3CwNgQnXgkJMBNS5K9zWLD3hbZWs`를 운영 별칭에 반영했고 `/health`·`/ready`는 릴리스 `72e157695c52`·서울 `icn1`·Supabase ready다. 운영 관리자·광고주 HTML 200과 배포 관리자 HTML의 두 화면 역할 분리를 확인했다.

- 인증 화면 검수 전달 규칙 고정 완료: 로그인할 수 없는 관리자 대시보드 링크나 `다음에서 열기` 카드만 검수 자료로 전달하지 않는다. 로그인 필수 UI는 비실데이터 격리 목업 또는 직접 확인 가능한 캡처를 역할별로 제공하고, 실제 세션 확인 수단이 없으면 육안 검수 미완료로 명시한다. Production 인증 우회·실계정 코드 노출은 금지하며 임시 검수 자산은 확인 후 제거한다. 문서만 변경했고 기능·화면·DB·서버·배포 상태는 변경하지 않았다.

- 총관리자 전용 대행사 연결 UI·UX 2차 보완 완료·배포 대기: `mml93-a01` Owner 화면의 좌우 분할과 큰 세로 카드를 제거하고 `진행 순서 → 권한·보안 → 운영팀 선택 생성 → 광고주 필수 생성 → 연결 현황`을 한 방향으로 읽는 전체 폭 구조로 압축했다. 제목·설명·배지·입력·CTA의 크기와 그림자를 낮추고 두 생성 카드를 동일 높이의 가로 행으로 맞췄다. 문구는 직속 발급·선택/필수·보안 재검증에 필요한 사실만 남겼다. 운영팀 모드는 기존 `광고주 코드 생성` 단일 구조·문구·placeholder를 유지하며 `client.html`, DB, 서버, 계정 생성 API와 보호된 5대 조회·추적 기능은 변경하지 않았다.
- 버튼 행 정렬 보정·Production 반영 완료: 두 CTA가 이름이 없는 첫 라벨 행의 빈 칸에 자동 배치돼 입력칸보다 위로 떠 있던 원인을 확정했다. 운영팀 버튼은 `team-action`, 광고주 버튼은 `client-action` 영역에 직접 고정해 각 입력칸과 같은 작성 행에 배치했다. 1280×720 브라우저 실측에서 운영팀 입력·버튼 `y=542`, 광고주 입력·버튼 `y=654`, 모든 높이 40px, 가로 넘침 0이다. 총관리자 전용 CSS와 회귀 기준선만 수정했으며 운영팀·광고주 생성 요청, `client.html`, DB, 서버와 보호된 5대 조회·추적 기능은 변경하지 않았다. 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 226/226, 플레이스 수집기 51/51, 서버 계약 28/28, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`가 로컬·Vercel에서 통과했다. 코드 `1638124`·Production `dpl_HtCvfVaBtyWRzBiRkUrGowayuJXp`를 운영 별칭에 반영했다. `/health`·`/ready`는 릴리스 `1638124c7eeb`·서울 `icn1`·Supabase ready이고 운영 관리자 `/admin`·광고주 `/client`가 200이며 관리자 HTML에서 두 grid-area 고정 규칙을 확인했다.

- 전문 개발사·UI/UX 협업 원칙 고정·Production 반영 완료: 앞으로 대표님의 의견을 핵심 요구로 존중하되 기계적으로 반영하지 않고, 실제 운영 목적·사용자 흐름·데이터 진실성·보안·접근성·반응형·유지보수성·회귀 위험을 개발사 관점에서 함께 검토한다. 더 나은 구조나 위험이 있으면 근거와 대안을 먼저 제시하고, 최종 결정권과 승인 범위는 대표님에게 유지한다. UI/UX는 취향이 아니라 정보 계층·여백·정렬·타이포그래피·상태·CTA·오류 복구·양 화면 실사용성으로 검수한다. 이 기준을 `AGENTS.md`와 작업명세서에 영구 운영 원칙으로 기록했다. 기능 코드·화면·DB·보호된 5대 기능은 변경하지 않았으며 코드 `874a676`을 GitHub `main`과 Production `dpl_NsxhroTpR5enjVvMi4BkHb92cVDf`에 반영했다. 로컬·Vercel 전체 릴리스 검사에서 API·서버 226/226, 플레이스 51/51, 보호 잠금 21함수·23파일·11마이그레이션, 서버 계약 28/28, Production 인증 18/18이 통과했다. 운영 `/health`·`/ready`는 릴리스 `874a6763fa2b`·서울 `icn1`·Supabase ready이고 양 역할 화면 200·비인증 세션 401이다.

- 기존 5자리 광고주 로그인 호환·Production 반영 완료: 2026-07-19 보안 세션 강화 전 생성된 활성 광고주 2개가 로그인 최소 6자리 검증에서 DB 조회 전에 차단되던 원인을 수정했다. 광고주 로그인만 5자리 후보를 활성 `clients` 행의 정확 코드 일치 검사까지 허용하고, 운영팀·총관리자 로그인과 신규 광고주·운영팀 코드 생성은 계속 6자리 이상을 요구한다. 고객 코드는 소스에 하드코딩하지 않았고 DB·스키마·기존 계정·화면·보호된 5대 조회·추적 기능은 변경하지 않았다.
- 검증·배포 상태: 5자리 광고주 허용·4자리 차단·5자리 운영팀/총관리자 차단·6자리 표준 허용·신규 생성 6자리 유지 대상검사 22/22, API·서버 226/226, 플레이스 51/51, 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, 서버 계약 28/28, Production 인증 18/18과 전체 `check:release`를 로컬·Vercel에서 통과했다. 운영 DB는 활성 5자리 광고주 2개·4자리 이하 0개·표준 6자리 이상 12개다. 코드 `a440415`를 GitHub `main`과 Production `dpl_3pyFqZVYjBHY84vmQH9eKLZEgthH`에 반영했고 `/health`·`/ready`는 릴리스 `a440415e94de`·서울 `icn1`·Supabase ready다. 두 기존 계정의 로그인·세션 복원은 모두 200이며 원문 코드는 응답에 노출되지 않았다. 4자리 광고주·5자리 운영팀은 400, DB에 없는 5자리 광고주는 401로 차단되고 양 역할 화면 최종 응답은 200·비인증 세션은 401이다.

- 운영 입력 `공개 전 확인` 단일 압축 체크리스트·Production 반영 완료: 세 개의 큰 개별 카드를 하나의 흰 패널 안 3개 목록 행으로 통합했다. 데스크톱의 남은 높이 강제 1:1:1 확장을 제거하고 패널을 콘텐츠 높이에 맞췄으며, 641~900px에서는 같은 패널 안 3열, 520px 이하에서는 다시 3행으로 전환한다. 1280px 실측에서 외부 확인 카드 357px·내부 목록 200px·각 행 66px·가로 넘침 0이며 기존 라벨 태그와 어절 단위 줄바꿈을 유지한다. `client.html`, 계산식·데이터·검수·공개·CSV 훅, DB, 서버와 보호된 5대 조회·추적 기능은 변경하지 않았다.
- 검증·배포 상태: 로컬과 Vercel에서 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 224/224, 플레이스 51/51, 서버 계약 28/28, Production 인증 18/18과 전체 `check:release`를 통과했다. 코드 `a3ba5b4`·`64a6e81`을 GitHub `main`과 Vercel Production `dpl_7c5K42ccVF86a2e5P5YL4E5b425o`에 반영했다. 운영 `/health`·`/ready`는 릴리스 `64a6e814766f`·서울 `icn1`·Supabase ready이며 관리자·광고주 HTML 200, 비인증 세션 401, 운영 관리자 HTML과 검증 빌드 SHA-256 일치를 확인했다.

- 운영 입력 결과 여백·공개 확인 타이포 보정·Production 반영 완료: 핵심 결과값이 행의 오른쪽 테두리에 붙어 보이던 문제를 좌우 20px 내부 여백과 공통 2열 기준선으로 보정하고, 숫자는 14px·tabular 숫자폭으로 통일했다. `공개 전 확인`은 라벨을 작은 중립 태그로 정돈하고 문장을 글자 단위가 아닌 어절 단위로 줄바꿈하도록 보완했다. 1280px 실측에서 6개 결과값 모두 오른쪽 여백 21px·가로 넘침 0이며, 세 확인 문구는 한 글자 고립 없이 표시된다. 기존 계산식·입력값·검수·공개·CSV 훅과 `client.html`, DB, 서버, 보호된 5대 조회·추적 기능은 변경하지 않았다.
- 검증·배포 상태: 입력 검수 5/6, CSV `3,280만원·456%·1,080건`, 브라우저 경고/오류 0건과 전체 릴리스 검사를 로컬·Vercel에서 통과했다. 코드 `a3ba5b4`는 압축 체크리스트 코드 `64a6e81`과 함께 Production `dpl_7c5K42ccVF86a2e5P5YL4E5b425o`에 반영됐고 운영 릴리스 `64a6e814766f`의 HTML 200·비인증 401·빌드 SHA-256 일치를 확인했다.

- 운영 입력 프리미엄 정보 계층·행열 정렬 보정·Production 반영 완료: 기존의 여섯 카드가 같은 중요도로 펼쳐지던 화면을 `운영 원본 → 진행 상태 → 핵심 결과 → 공개 전 확인` 순서로 재구성하고, 공개 설정과 CSV 계산은 접이식 보조 영역으로 낮췄다. 중간 폭에서 진행·확인 카드가 불필요하게 늘어나던 여백은 3열 요약으로 정돈하고, 계산 결과 행은 동일한 2열 기준선에 맞췄다. 모바일은 제목·상태 배지·결과값을 한 열로 안전하게 전환한다. 기존 업로드·다운로드·삭제, 검수 기준 6개, 월간 자동 계산, 공개 반영과 CSV 데이터 훅은 그대로 유지했으며 `client.html`, DB, 서버와 보호된 5대 조회·추적 기능은 변경하지 않았다.
- 검증·배포 상태: 로컬 운영팀 단독 세션에서 입력값 검수 5/6 정상·원본 미선택 경고, 공개 설정 펼침, CSV `3,280만원·456%·1,080건` 계산과 공개 반영을 확인했다. 1440·1180·1024·900·771·390px에서 가로 넘침 0, 모든 결과 행 시작·끝 기준선 일치, 900·771px 진행·확인 3열 균등 정렬, 390px 한 열 전환과 브라우저 경고/오류 0건을 확인했다. 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 224/224, 플레이스 51/51, 서버 계약 28/28, Production 인증 18/18과 Vercel 전체 `check:release`를 통과했다. 코드 `38c8a65`·정렬 보정 `d4d9dc2`를 GitHub `main`과 Vercel Production `dpl_66Ye7ppneaWEkzc8sqf6XyYTPG7e`에 반영했고 운영 `/health`·`/ready`는 릴리스 `d4d9dc2bcfd2`·서울 `icn1`·Supabase ready다. 관리자·광고주 HTML 200, 비인증 세션 401, 운영 관리자 HTML과 검증 빌드 SHA-256 일치를 확인했다.

- 운영 홈 여백·정보 계층 재설계·Production 반영 완료: 반복 사용자가 안내보다 현재 상태와 즉시 실행을 먼저 확인하도록 `이번 달 운영 현황 → 빠른 실행 → 운영 루틴 → 공개 전 확인` 순서로 바로잡았다. 현황은 밝은 독립 영역, 빠른 실행은 넓은 2×2 카드, 운영 루틴은 짧은 전체 폭 타임라인, 공개 전 확인은 전체 폭 2열 목록으로 유지했다. 실제 매출·보고서 상태 계산과 각 화면 이동은 그대로이며 운영 홈 밖 기능과 `client.html`, 보호된 5대 핵심 기능·DB·서버 계약은 변경하지 않았다.
- 검증·배포 상태: 로컬 운영팀 세션에서 `현황 → 실행 → 안내 → 검수` DOM 순서, 1440×900 데스크톱, 390×844 모바일 `scrollWidth=390`, 매출 입력·보고서 제출 카드 이동을 확인했다. 총관리자·연결 운영팀·단독 운영팀·광고주·해제 운영팀 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 224/224, 플레이스 51/51, 서버 계약 28/28, Production 인증 18/18과 로컬·Vercel 전체 `check:release`가 통과했다. 코드 `b0db9eb`을 GitHub `main`과 Vercel Production `dpl_5WyEEpZqjSEa74yTWbPHiA9eoiAa`에 반영했으며 운영 `/health`·`/ready`는 릴리스 `b0db9eb5150e`·서울 `icn1`·Supabase ready다. 관리자·광고주 HTML 200, 운영 HTML의 새 순서, 비인증 세션 401과 로그인 화면 정상 렌더링을 확인했다.

- 운영팀 운영 홈 UI·UX 정리·월 운영 현황 Production 반영 완료: 기존 화면을 `빠른 실행 4개 → 운영 루틴 4단계 → 공개 전 확인 4항목`으로 압축하고, 비어 보이던 운영 루틴 하단에는 `매출 입력`과 `보고서 제출`의 이번 달 상태를 추가했다. 매출은 기존 공개 매출·저장일, 보고서는 서버 보고서함의 이번 달 기록·광고주 공개 상태만 사용해 `입력/제출 전`, `갱신 필요/검수 중`, `입력/제출 완료`를 구분하며 완료값을 임의 생성하지 않는다. 운영 홈 외 화면과 `키워드 조회`, `SEO 확인`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위` 보호 소스·DB·서버 계약은 변경하지 않았다.
- 검증·배포 상태: 데스크톱 1280·1440px와 모바일 390px에서 두 현황 카드가 정돈되고 가로 넘침은 0이다. 로컬 격리 표본으로 매출 입력 전→완료, 보고서 제출 전·검수 중·완료, 각 상세 화면 이동과 브라우저 경고/오류 0을 확인했다. 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, 기준선, API·서버 224/224, 플레이스 51/51, Production 인증 18/18과 전체 `check:release`를 통과했다. 코드 `bef7011`을 GitHub `main`과 Vercel Production에 반영했고 운영 `/health`·`/ready`는 릴리스 `bef7011dee54`·서울 `icn1`·Supabase ready다. 배포 관리자 HTML의 새 운영 현황 문구·로직과 비인증 세션 401도 확인했다.

- 5대 핵심 기능 안정 기준 동결·Production 반영 완료: 대표님이 현재 `키워드 조회`, `SEO 확인`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위`를 현재 최선의 운영 기준으로 확정했다. 이후 다른 작업에서는 보호된 21함수·23파일·11마이그레이션을 수정하지 않으며, 대표님의 명시적 수정 요청이 있을 때만 변경 사유·대상 회귀·양 역할/5상태 회귀·잠금 self-test·전체 릴리스 검사를 거쳐 새 기준을 고정한다. 신규 조회·SEO 점검·추적 등록·자동/수동 갱신은 계속 허용한다. 현재 잠금과 변조 self-test, 총관리자·연결 운영팀·단독 운영팀·광고주·해제 운영팀의 5상태, 양 역할 parity, API·서버 224/224, 플레이스 수집기 51/51, 서버 계약 28/28, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`를 통과했다. 커밋 `fbe3946`을 GitHub `main`과 Vercel Production에 반영했고 `/health`·`/ready`는 릴리스 `fbe3946f45bd`·서울 `icn1`·Supabase ready다. 운영팀·광고주 파일은 검증 빌드와 SHA-256이 일치하고 비인증 5기능 API는 모두 401이며 원격 품질·상품·플레이스 작업도 성공했다. 기능 코드·DB·운영 데이터는 변경하지 않았고 복구 체크포인트 `checkpoint/core-five-stable-20260727`을 보존한다.

- 로그인 없는 N 상품 30일 자동 추적 대기열 보완·운영 반영 완료: GitHub Actions 크론과 `MI_RANK_CRON_SECRET`은 정상 실행 중이었으나 상품 워크플로가 1회에 최대 10개만 처리해 활성 71개 중 35개가 밀렸고, 로그인 화면의 1건 보정이 실행 원인처럼 보였다. 플레이스는 활성 13개·대기 0개로 로그인 없이 정상 처리되고 있어 별도 수집기·순위 로직은 변경하지 않았다.
- 수정·보호·운영 검증: 상품 크론 요청은 최대 5건을 기존처럼 순차 처리하고 한 작업 창은 최대 20회·100건까지만 처리한다. 기본 Vercel 백업 요청 1건과 DB 임대 잠금·광고 제외·300위·대표 순위·실패 재시도 계약은 그대로다. 새 경계 단위검사 포함 API·서버 224/224, 플레이스 수집기 51/51, 서버 계약 28/28, 역할 5상태·핵심 5기능, 운영팀·광고주 parity, 공개 빌드/CSP, Production 인증 18/18과 전체 `check:release`를 독립 2회 통과했다. 코드 `d576d0f` 배포 후 무로그인 GitHub 작업 `30238482719`가 6개 배치에서 26/26 성공·실패 0·`drained=true`로 끝났고, DB는 상품 71개·플레이스 13개 모두 대기 0·처리 잠금 0이다. `/health`·`/ready`는 릴리스 `d576d0fcaeb7`·서울 `icn1`·Supabase ready이며 원격 품질·플레이스 작업도 성공했다. 운영팀·광고주 1280px·390px 화면은 가로 넘침·브라우저 경고/오류 0건이다. `admin.html`·`client.html`·Supabase 스키마·기존 데이터는 변경하지 않았고 승인된 두 상품 크론 파일만 보호 잠금 새 기준으로 다시 고정했다.

- 역할·연결 상태 자동 회귀 게이트·Production 반영 완료: 총관리자, 광고주 연결 운영팀, 광고주 미연결 운영팀, 광고주, 해제 운영팀의 5개 상태를 `키워드 조회`, `SEO 확인`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위` 5개 핵심 경로와 교차 검증하는 `check:role-state-regression`을 추가했다. 보고서 범위·운영팀 관리 경계, 위조 범위 헤더 교체, 해제 세션 401, 운영팀 단독 화면 문구와 광고주 핵심 화면 존재 여부도 함께 검사하며 이후 전체 품질·릴리스에서 자동 실행된다.
- 액션·검증·배포 상태: 광고주 미연결 운영팀은 상품 추적의 등록·단건 갱신·중지·삭제·그룹·이동·정렬·대기열 갱신과 플레이스 추적의 등록·단건 갱신·그룹·삭제·대기열 갱신 권한 경로를 광고주 없이 통과하고, 기존 핸들러 테스트의 실제 액션 계약과 결합해 검증한다. 전체 `check:release`에서 API·서버 222/222, 플레이스 수집기 51/51, 서버 계약 28/28, Production 인증 18/18, 역할 parity·공개 빌드/CSP·보호 잠금 21함수·23파일·11마이그레이션이 통과했다. 코드 `afe5bfa`를 GitHub `main`과 Vercel Production에 반영했고 `/health`·`/ready`는 릴리스 `afe5bfa0a8a3`·서울 `icn1`·Supabase ready다. 운영 관리자·광고주 파일은 검증 빌드와 SHA-256이 일치하며 비인증 5기능 API는 모두 401이다. DB·Supabase 스키마·운영 데이터·잠금 해시는 변경하지 않았다.

- 운영팀 단독 계정의 두 30일 순위 격리 정상화·운영 반영 완료: 광고주가 연결되지 않은 실제 운영팀 계정도 `N 30일 순위`와 `N 플레이스 30일 순위`를 운영팀 코드 기반의 별도 격리 범위에서 조회·등록·갱신할 수 있도록 세션 게이트와 두 API 권한 계약을 수정했다. 광고주 연결 후에는 기존 광고주 범위로 자동 전환하며, 보고서·공개 데이터·원본 파일 등 광고주 전용 영역은 연결 전 계속 차단한다. 기존 `관리자 코드 확인 후 순위 추적을 사용할 수 있습니다.` 경고는 제거하고 인증 범위를 확인할 수 없을 때만 재로그인 안내를 표시한다.
- 검증·배포 상태: Supabase 운영 DB를 읽기 전용으로 확인해 활성 운영팀 3개 중 광고주 미연결 2개와 해당 운영팀 코드 범위의 기존 상품 추적 2개가 보존된 사실을 확인했으며 DB·스키마는 변경하지 않았다. 운영팀 단독·연결 운영팀·광고주·총관리자와 교차 범위 차단 대상 89/89, 전체 API·서버 220/220, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 역할 parity·기준선·공개 빌드/CSP·보호 잠금 21함수·23파일·11마이그레이션·전체 `check:release`가 로컬과 Vercel Production에서 통과했다. 로컬 운영팀 단독 세션 브라우저 2차 검수에서 두 메뉴 진입·입력 버튼 활성·경고 문구 0건을 확인했다. 코드 `70f5c75`·Production `dpl_ByyyBPzAhoPTEmG7zgZ2awh8YWRo`를 운영 별칭에 반영했고 `/health`·`/ready`는 릴리스 `70f5c7574ec9`·서울 `icn1`·Supabase ready다. 운영 관리자·광고주 파일은 검증 빌드와 SHA-256이 일치하고 두 비인증 추적 API는 401이며 과거 경고 문구는 운영 관리자 파일에 없다.

- 프로젝트 파일 안전 정리·Production 반영 완료: 추적 파일 158개와 로컬 ignored 영역의 실제 참조·빌드·배포 사용 여부를 확인했다. `dist`, `.vercel/output`, 운영시트 샘플 출력, `.DS_Store` 약 18MB를 삭제했고 재검사 결과 작업공간 정리 대상이 0개다. 현재 Vercel 정적 HTML 구조와 충돌하며 참조가 없는 오래된 Next.js 안내 2개만 제거했고 초기 기획 8개는 `docs/planning`으로 이동했다. 운영 소스·테스트·배포 설정·작업 기록·DB·비밀값·Vercel 연결·의존성은 보존했다. 문서 링크 22개, 핵심 경로, 전체 `check:release`, API·서버 218/218, 플레이스 51/51, 서버 계약 27/27, Production 인증 18/18이 통과했다. 코드 `548b997`·Production `dpl_D73LagXA6oRCJu3CqrHC8MuCGQtj`를 운영 반영했고 `/health`·`/ready`는 릴리스 `548b9973383e`·서울 `icn1`·Supabase ready다. 관리자·광고주 운영 파일은 검증 빌드와 SHA-256이 일치하고 비인증 5기능 API는 모두 401이다.

- 5대 핵심 기능 보호 잠금 확장·Production 배포 완료: 기존 `키워드 조회`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위`에 `SEO 확인`의 공통 점수 엔진·서버 자동 점검 수집기와 양 역할 조회·평가·표시 진입점을 추가해 21함수·23파일·11마이그레이션을 보호한다. 잠금은 운영 사용자의 신규 조회·점검·추적 등록·갱신을 막지 않고 승인 없는 소스 변경만 릴리스에서 차단한다.
- 역할·전체·운영 검증: 운영팀·광고주·총관리자의 다섯 기능 API 계약과 양 역할 화면 진입점을 확인했다. 이 릴리스 당시 광고주 미연결 운영팀의 두 30일 추적을 차단했던 정책은 2026-07-27 운영팀 격리 범위 정상화로 대체됐다. 잠금 현재값·모든 항목 변조 self-test·역할 parity·기준선·SEO 18/18 포함 대상 31/31, API·서버 218/218, 플레이스 51/51, 서버 계약 27/27, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`가 통과했다. 코드 `34431f5`·Production `dpl_AaVnUcMpHonkbS8no3DhSDutzU2g`를 운영 반영했고 `/health`·`/ready`는 릴리스 `34431f5b2504`·서울 `icn1`·Supabase ready다. 양 역할·SEO 운영 파일 해시 일치와 비인증 5기능 API 401도 확인했다.

- 상품 SEO 전 키워드 동일 정책 검증 완료: 기존 배점을 특정 아이쉘 상품의 예외값으로 두지 않고 공통 정책 ID `uniform_keyword_evidence_v1`로 식별한다. 모든 조회는 키워드·상위 5개 오가닉·세부 카테고리·브랜드/제조사·대표 이미지·수기 리뷰·광고 제외 순위의 실제 입력 근거만 달라지고 배점 계산식은 동일하다. 운영팀·광고주 화면도 v13 공통 엔진과 동일 계산식 안내를 함께 사용한다.
- 다상품군·전체 검증: 아이쉘 기존 76점을 보존하면서 같은 부분 근거의 무선청소기·여성러닝화·차량용방향제는 모두 76점, 정확 키워드 근거의 써큘레이터·온열찜질기·강아지사료·아이폰16케이스는 모두 95점으로 계산됐다. 무관 상품 역검증과 순위 경계 포함 SEO 18/18, API·서버 217/217, 플레이스 51/51, 서버 계약 27/27, Production 인증 18/18, 역할 parity·기준선·공개 빌드/CSP·전체 `check:release`가 통과했다. 보호 잠금은 해시를 갱신하지 않고 self-test와 현재 잠금 13함수·21파일·11마이그레이션을 통과했으며 소스·빌드 엔진 SHA-256도 일치한다. 코드 `3ba297f`·Production `dpl_GrTrGF9C3E7UgbTqLRzsPjUh6pX1`를 운영 반영했고 `/health`·`/ready`는 릴리스 `3ba297fad36d`·서울 `icn1`·Supabase ready다. 양 역할 v13 로드와 운영 엔진 7개 교차 표본 점수 재현도 확인했다.

- 상품 SEO 균형 점수 보정 검증 완료: 정확 키워드가 없더라도 상위 오가닉과 동일 세부 카테고리이며 핵심어 관련성이 실제 확인되면 상품명 부분 점수 6~8점을 반영하고, 관련 근거가 없는 다른 상품명은 기존처럼 감점한다. 상위 핵심어 40% 이상 반영은 6점, 브랜드만 등록은 7점, 광고 제외 오가닉 순위는 5위 10점·40위 9점·100위 8점·200위 5점·300위 3점으로 단계화했다.
- 아이쉘 상품 표본·전체 검증: 사용자 제공 실조회 조건인 `46자·정확 키워드 미포함·상품군 관련·상위 핵심어 2개 반영·브랜드 아이쉘·제조사 미등록·리뷰 133개·45위`에서 `상품명 16·상위 핵심어 6·카테고리 15·브랜드/제조사 7·이미지 10·리뷰 14·트래픽 8`, 총 76점을 확인했다. 무관 상품 역검증과 5·40·100·200·300위 경계 포함 SEO 16/16, 전체 API·서버 215/215, 플레이스 51/51, 서버 계약 27/27, Production 인증 18/18, 역할 parity·기준선·공개 빌드/CSP·전체 `check:release`가 통과했다. 4대 핵심 기능은 잠금 해시를 갱신하지 않고 self-test와 현재 잠금 13함수·21파일·11마이그레이션을 모두 통과했다. 코드 `ef6a4ba`·Production `dpl_29QtNh13TgGd6f9fyBPZ4o9DfRED`를 운영 반영했고 `/health`·`/ready`는 릴리스 `ef6a4bae9632`·서울 `icn1`·Supabase ready다. 운영팀·광고주 화면의 v12 로드와 배포 엔진 동일 표본 76점 재현도 확인했다.

- 직전 v11 릴리스 기록: 운영팀·광고주 공통 엔진과 화면에서 원부형/단일형 `상품 노출 구조` 참고 카드를 제거했고, 원부형·단일형 판별을 사용하는 N 상품 순위 기능은 변경하지 않았다. 코드 `3cf5422`·Production `dpl_2Ch1ztEz6tDpqiGEH1xsDaD4nLxm`의 카드 제거 상태는 유지하며 점수 구간만 위 v12 기준으로 대체한다.

- 4대 핵심 기능 재잠금·3역할 회귀 점검 완료: 키워드 조회, N 상품 순위, N 30일 순위, N 플레이스 30일 순위는 기존 해시를 다시 생성하지 않고 13함수·21파일·11마이그레이션 보호 상태를 유지한다. 잠금 self-test와 현재 잠금 검사 모두 통과해 보호 대상이 바뀌면 릴리스가 실패하는 계약을 재확인했다.
- 역할별 결과: 현재 운영팀은 광고주 연결 전에도 독립 조회 도구와 두 30일 추적을 운영팀 격리 범위에서 사용하고, 연결 후 보고서·공개 데이터와 광고주 추적 범위로 전환한다. 광고주는 자기 광고주 범위의 6개 조회·분석 도구만 사용하며 다른 광고주·총관리자 도구에 접근하지 않는다. 총관리자는 정확한 `mml93-a01` 세션에만 전용 도구가 열리고 선택한 광고주 범위가 프로그램으로 바뀌면 추적 데이터를 새 범위로 다시 불러온다.
- 전체·운영 검증: 역할 parity, 기준선, 서버 계약 27/27, Production 인증 18/18, API·서버 208/208, 플레이스 수집기 51/51, 공개 빌드·CSP와 전체 `check:release`가 통과했다. 운영 릴리스 `202287bea5d3`의 `/health`·`/ready`는 200·서울 `icn1`·Supabase ready이고 비인증 세션·키워드·상품 순위·상품/플레이스 추적 API는 모두 401이다. 운영 관리자·광고주 파일은 검증 빌드와 SHA-256이 일치한다. 실제 계정으로 데이터를 생성·수정·삭제하는 검증은 하지 않았고 코드·DB·잠금 해시·배포 변경도 없다.

- N 플레이스 30일 부분조회·순위 UX 정상화 검증 완료: 운영 DB의 `mml93-a01` 플레이스 추적 10개 최신값을 대조한 결과 8개는 실제 순위가 정상 저장됐고, `호르몬치치 구월점`·`팽오리농장 부평점`만 최신 수집에서 정확 ID를 찾지 못해 `rank=null`과 확인 범위가 저장됐다. 현재 네이버 PC 오가닉 직접 재수집에서도 호르몬치치 구월점은 100개 전체에 정확 ID가 없어 부분 조회가 재현됐다.
- 원인·수정 범위: 확인 개수는 순위가 아니지만 일별 카드의 큰 순위 위치에 표시되어 실제 순위처럼 보였다. 운영팀·광고주 모두 확정 순위가 없는 일별 칸은 `-`로 표시하고, `N개 확인 · 이후 미검증`은 기존 상태 안내와 업체 지표에만 남긴다. 과거 순위를 현재 순위로 대체하거나 숫자를 발명하지 않으며 서버·수집기·Supabase 데이터는 변경하지 않는다.
- 검증·보호 상태: API·서버 208/208, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 운영팀·광고주 query parity, 릴리스 기준선, 공개 빌드·CSP, 전체 `check:release`, 보호 잠금 self-test·잠금 검사와 `git diff --check`가 통과했다. 변경이 보호된 순위 계산·수집·저장 함수 밖의 표시 헬퍼에 한정돼 잠금은 해제하지 않고 계속 유지했으며 13함수·21파일·11마이그레이션이 모두 보호 상태다.
- 운영 반영: 코드 `603a82c`·Production `dpl_4v46G5x7vBP8LJ4T4PBEqzj6TKLm`가 운영 별칭에 반영됐다. `/health`·`/ready`는 릴리스 `603a82c6b0be`·서울 `icn1`·Supabase ready이며 비인증 세션은 401이다. 운영 관리자·광고주 파일은 로컬 빌드와 SHA-256이 각각 일치하고 새 `순위값 또는 -` 계약을 포함하며 과거 `확인 개수의 순위 위치 표시` 계약은 없다. 로그인 화면 브라우저 경고·오류는 0건이고, 브라우저가 로그아웃 상태라 인증값을 임의 입력하는 실사용 갱신은 수행하지 않았다.

- 운영팀 단독 계정·광고주 후연결 정상화 운영 반영 완료: 광고주가 없는 운영팀도 키워드 조회, N 상품 단건 순위, 상품 SEO 점검, Meta 광고 조회를 바로 사용할 수 있다. 이 기록의 당시 두 30일 추적 차단 정책은 2026-07-27 운영팀 코드 기반 격리 추적으로 대체됐고, 보고서·공개 데이터·원본 파일은 광고주 연결 전 계속 차단한다.
- 광고주 생성·연결 해제 전환 및 배포 상태: 운영팀이 광고주를 생성하거나 연결을 해제하면 서버 세션을 즉시 재검증·재발급하고 데이터 범위와 순위 인증을 새 상태로 다시 초기화한다. 재로그인 없이 광고주 기능이 활성화·비활성화되며 이전 범위의 캐시를 재사용하지 않는다. 전체 API·서버 208/208, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 역할 parity·기준선·공개 빌드/CSP·4대 기능 잠금 13함수·21파일·11마이그레이션과 전체 `check:release`가 통과했다. 코드 `7e2fbd5`·Production `dpl_HYfQD3avuxuqjipYfyQ1aHbUANDL`를 운영 별칭에 반영했고 `/health`·`/ready` 200, 서울 `icn1`, Supabase ready, 운영 관리자 파일과 로컬 빌드의 SHA-256 일치, 비인증 세션 401을 확인했다. Supabase 스키마·운영 데이터·보호된 순위 계산/수집/저장은 변경하지 않았다.

- Vercel 서버 서울 리전·세션 지연 최적화 운영 반영 완료: 모든 함수 실행 지역을 Supabase와 같은 `icn1`로 고정하고 Fluid Compute를 명시했다. `/api/session`은 장시간 순위 API가 사용하는 catch-all 함수와 별도 30초 함수로 분리했으며, 로그인 IP·자격증명 rate-limit의 독립 DB 요청은 동시에 시작한다. 권한·쿠키·CSRF·차단 정책과 기존 300초 장시간 API 한도는 유지했다.
- 검증·배포 상태: 대상 61/61, 전체 API·서버 207/207, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 4대 기능 잠금 13함수·21파일·11마이그레이션, 일반 환경 전체 `check:release`와 실제 Production 환경변수가 주입된 Vercel Production 빌드가 모두 통과했다. 코드 `31b70e4`·Production `dpl_DZFaojbvvLfnGVVB7G7bVA3jzSgX`를 운영 별칭에 반영했고 실제 함수와 `/health`가 `icn1`을 반환했다. `/health`·`/ready`·비인증 `/api/session` 연속 30/30·동시 15/15, 실패·시간초과 0건이다. Production 변수와 고정 테스트 계정 충돌도 구현을 바꾸지 않고 테스트 환경 격리로 보정했다. `admin.html`·`client.html`, 순위 계산·수집·저장, Supabase 데이터는 변경하지 않았다.

- 광고주 코드 명시 입력 보안 보완 완료: 운영팀·총관리자 광고주 생성 화면에서 `mml93-aXX` 다음 코드를 자동 제안·자동 입력하지 않는다. 사용자가 광고주 코드를 비워 제출해도 서버가 순차 코드를 대신 생성하지 않고 400으로 거부한다. 기존 광고주 코드·연결·세션·DB 데이터는 변경하지 않았다.
- 검증·배포 상태: 전용 7/7, API·서버 206/206, 플레이스 수집기 51/51, 서버 계약 24/24, 운영팀·광고주 parity, Production 인증 18/18, 4대 기능 잠금 13함수·21파일·11마이그레이션, Vercel 공개 빌드·CSP와 전체 `check:release`가 통과했다. 코드 `553a880`과 Production `momentinsight-pms5xuqh4-momentlabs.vercel.app`을 운영 별칭에 반영했다. `/health`·`/ready`는 릴리스 `553a8801e2fa`·Supabase ready이며, 비인증 생성은 401, 운영 관리자 번들은 직접 입력 문구를 포함하고 자동 제안 문자열은 포함하지 않는다.

- 상품 SEO 트래픽·리뷰 평균·태그·상품정보고시 재정렬 검증 완료: 100점은 모든 자동 점검을 충족하고 정확 상품이 상위 5위일 때만 허용한다. 6위 이하에는 순위 구간별 트래픽·노출 감점을 적용하고 `트래픽·노출 보완`을 바로 수정할 항목 최상단에 표시한다. 리뷰 수량은 같은 키워드 상위 오가닉 상품 최대 5개의 실제 확인 표본 평균과 비교한다. 판매자 태그 10개와 상품정보제공고시의 `상세페이지 참조` 사용 여부는 공개 상품 상세에서 자동 확인하며, 확인 근거가 없으면 점수나 카드를 발명하지 않는다.
- 화면 정리: 공식 브랜드·제조사 명칭, 동일 단어 반복, 홍보·가격·배송 문구, 전화번호, 특수문자, 동종 상품 카테고리의 6개 점검 카드는 운영팀·광고주 양쪽에서 제거했다. 운영 실조회 시점의 `온열찜질기`·상품 `12149720593` 정확 순위는 12위로 변동됐고 점수는 80점이며, `트래픽·노출 보완`이 바로 수정할 항목 최상단이다.
- 최종 검증·운영 반영: SEO 대상 25/25, API·서버 205/205, 플레이스 수집기 51/51, 서버 계약 24/24, 운영팀·광고주 parity, 4대 기능 잠금 13함수·21파일·11마이그레이션, 기준선, Vercel 빌드·CSP와 전체 릴리스 검사가 통과했다. 코드 `251edd8`·캐시 보정 `3ef72f6`·공개 URL 리디렉션 보정 `6b179a9`를 GitHub `main`과 Vercel Production `dpl_CRdGneWLqgpw8KfVvZxKDEuQuBes`에 반영했다. 운영 `/health`·`/ready`는 릴리스 `6b179a9e51eb`·Supabase ready이고, 광고주 실조회 콘솔 경고·오류는 0건이다. 네이버 공개 상품 상세가 현재 429로 제한된 환경에서는 리뷰 평균·태그·상품정보고시를 추측하지 않고 숨기며, 상세 근거가 다시 제공되면 자동 점검 카드가 표시된다. 키워드 조회, N 상품 순위, N 30일 순위, N 플레이스 30일 순위의 보호 코드는 변경하지 않았다.
- Owner 부가세 포함 금액 역산 운영 반영 완료: 정확한 `mml93-a01` Owner 세션 전용 계산기의 입력 기준을 공급가액에서 부가세 포함 합계금액으로 변경했다. 공급가액은 포함금액×10/11을 원 단위 반올림하고 부가세액은 합계금액-공급가액으로 계산해 입력 합계를 보존한다. `776,602원 → 공급가액 706,002원·부가세 70,600원·합계 776,602원`과 0원·소액·최대값·잘못된 입력을 검증했다.
- 결합 릴리스 상태: SEO 커밋 `896c3f6`과 부가세 커밋 `4a1c8be`를 포함한 전체 `check:release`, API·서버 202/202, 플레이스 수집기 51/51, Production 인증 18/18, 양 역할 parity·기준선·4대 기능 잠금 13함수·21파일·11마이그레이션 및 변조 self-test·공개 빌드/CSP가 통과했다. GitHub `dkdleld91-prog/momentinsight`의 `main`과 Vercel Production에 반영했고 운영 `/health`·`/ready`는 릴리스 `8318a4d897a3`·Supabase ready, 비인증 Owner API는 401을 반환한다. 관리자 번들의 새 `total` 요청과 SEO v7도 확인했다. 로컬 브라우저 URL 정책으로 인증 Owner 실화면 육안 검수는 완료로 과장하지 않는다.

- 네이버 상품명 가이드·상위 리뷰 비교 SEO 강화 검증 완료: 상품명 키워드·50자 이내·공식 브랜드/제조사 포함·의미 단어 반복·홍보/혜택 문구·전화번호·과도한 특수문자를 공개 데이터로 자동 판정한다. 검색 API에 없는 경쟁 상품 리뷰 수는 추정하지 않고, 동일 키워드 상위 상품의 직접 공개 URL에서 리뷰가 실제 확인된 표본 2~3개만 중앙값으로 비교한다. 표본이 부족하면 비교 카드·점수·수정 항목을 만들지 않는다.
- 트래픽 진단·보호 상태: 확인 가능한 핵심 SEO 항목이 모두 75% 이상이고 총점 85점 이상인데 상품ID 정확 일치 순위가 40위 밖이거나 300위 완주 후 미노출일 때만 `트래픽 부족 가능성`을 표시한다. 순위 상승을 보장하는 표현은 제거했다. SEO 전용 23/23, API·서버 202/202, 플레이스 수집기 51/51, 양 역할 parity·기준선·4대 기능 잠금 13함수·21파일·11마이그레이션·서버 계약·Production 인증·공개 빌드/CSP와 전체 `check:quality`가 통과했다. 인앱 브라우저와 Chrome의 localhost 접근은 앱 정책으로 차단되어 육안 검수 완료로 기록하지 않으며, 현재 배포 승인도 없어 로컬 커밋 상태로 보관한다.

- 상품 SEO 기준 정정·불확정 항목 제거 검증 완료: 상품명 권장 길이를 `50자 이내`로 정정했다. 상품명 키워드·길이·동종 카테고리와 공개 화면에서 실제 자동 확인된 리뷰·할인·리뷰 포인트만 점검표·점수·수정 항목에 반영한다. 서버 공개 응답으로 안정적으로 판정할 수 없는 상품정보고시와 상세페이지 8컷 여부는 `미확인` 카드도 만들지 않고 화면·점수·수정 목록에서 완전히 제외한다.
- 순위 표기·검증 상태: 상품 노출 카드의 `API 참고 N번째`를 `순위 N위`로 변경하고 상세 근거는 `공식 검색 API 기준 순위 N위 · 상품ID 정확 일치`로 정돈했다. 순위 계산·상품ID 정확 일치 로직은 변경하지 않았다. 전용 17/17, API·서버 196/196, 플레이스 수집기 51/51, 서버 계약 24/24, Production 인증 18/18, 운영팀·광고주 parity, 기준선, 4대 기능 잠금 13함수·21파일·11마이그레이션, Vercel 공개 빌드·CSP와 전체 `check:release`가 통과했다. 코드 `4326e24`·Production `momentinsight-9gcm2wujh-momentlabs.vercel.app`·운영 별칭에 반영한 뒤 실제 상품 `12149720593`에서 `순위 11위` 3곳, `50자 이내` 3곳을 확인했고 `API 참고`·`자동 확인 불가`·`미확인`·`80%`·`상품정보고시` 노출은 모두 0건이다. `/health`·`/ready` 릴리스 `4326e24118b8`, Supabase ready, 비인증 SEO API 401도 확인했다.

- 4대 핵심 조회·추적 기능 변경 잠금 확장·운영 반영 완료: `키워드 조회`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위`의 운영팀·광고주 진입 함수와 키워드/상품/플레이스 핵심 서버 계약을 13함수·21파일·11마이그레이션으로 고정했다. 잠금은 런타임 기능을 비활성화하지 않고 승인 없는 소스 변경만 품질·릴리스에서 차단한다. 신규 키워드 조회·상품 순위 조회·상품/플레이스 추적 등록·갱신과 보호 범위 밖 신규 기능 개발은 계속 허용한다.
- 잠금 검증 상태: 모든 보호 함수·파일의 개별 변조와 신규 순위 마이그레이션 탐지를 self-test로 확인했다. 양 역할 4기능 진입점·서버 create/refresh 경로와 런타임 잠금 비포함 회귀, 역할 parity, API·서버 179/179, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 공개 빌드·CSP·전체 `check:release`를 통과했다. 코드 `6c5d10d`·Production `momentinsight-htm9llc9v-momentlabs.vercel.app` 반영 후 운영 별칭에서 릴리스 `6c5d10d1deef`, `/health` live, `/ready` Supabase ready를 확인했다. 실제 조회·순위 계산·수집·저장 코드와 `admin.html`·`client.html`은 수정하지 않았다.

- N 30일 전체 갱신 문구 간소화·운영 반영 완료: 운영팀·광고주 화면의 시작·진행 상태에서 내부 구현 표현 `안전 동시 갱신 2개`만 제거해 `전체 순위 갱신을 시작합니다.`와 `전체 순위 갱신 중입니다. X/Y`로 정돈했다. 실제 제한 동시성 2개, 자동·수동 중첩 차단, 서버 최신 상태 재대조, 미완료 1회 재시도, 순위 계산·저장·조회는 그대로 유지했다.
- 보호·검증 상태: 대표님의 보호 UI 변경 승인을 근거로 운영팀·광고주 `initRankTracking` 해시만 갱신했고 N 플레이스 함수, 상품·플레이스 서버·크론·수집기·워크플로·11개 순위 DB 마이그레이션은 바꾸지 않았다. 잠금 4함수·20파일·11마이그레이션과 변조 차단 self-test, 기준선·역할 parity, API·서버 179/179, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 공개 빌드·CSP와 전체 `check:release`가 통과했다. 코드 `b2955e3`·Production `b2955e3142de` 반영 후 운영팀 실갱신이 25/25로 완료됐고 광고주도 동일 25개를 로드했다. 양 역할 요청 문구 0건·가로 넘침 0·콘솔 오류 0건, `/health` live·`/ready` Supabase ready와 기존 카드·이력 보존을 확인했다.

- 키워드 종합차트 3년 범위 수정·배포 진행: 화면에는 1년·3년 선택과 36개월 슬라이싱이 이미 있었지만 서버가 Search Trend를 12개월만 요청해, 운영팀·광고주 모두 3년 선택 시 실제로는 13개 월 시점만 표시됐다. 기존 Hub 호출을 추가하지 않고 동일한 1회 요청의 시작일만 36개월 전으로 확장했으며, 1년은 최근 12개월, 3년은 최근 36개월과 `YY.MM` 축으로 표시한다.
- 안정성·UI/UX 보존: Hub 실키 읽기 조회는 HTTP 200·330ms·37개 월 시점을 반환했다. 기존 네트워크·408·425·429·5xx 한정 1회 재시도와 영구 오류 즉시 반환 계약은 유지했고 추가 병렬 호출·무제한 재시도는 넣지 않았다. 첫 운영 2차 검수에서 모바일 3년 축 13개 라벨이 밀집되는 것을 발견해 데이터 36개는 유지하고 640px 미만의 축 라벨만 6개 기준으로 압축했다. 프리미엄 카드 계층·데스크톱 레이아웃과 운영팀·광고주 기능 동등성을 보존했다.
- 검증·보호 범위: API·서버 179/179, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 역할 parity·기준선·공개 빌드·CSP·전체 `check:release`·`git diff --check`가 통과했다. N 상품·N 플레이스 30일 잠금은 4함수·20파일·11마이그레이션 모두 통과했으며 해당 조회·등록·갱신·수집·저장 로직은 변경하지 않았다. 코드 `2f0b9b3`·모바일 보정 `eaaeed9`와 Production `eaaeed9226d2` 반영 후 운영팀·광고주 각 3년 36개 시점, 모바일 7개 축 라벨, 기존 1년 12개 시점, 가로 넘침·콘솔 경고/오류 0건을 확인했다.

- NAVER API Hub 이관 가능 범위 운영 전환 완료·안정화 배포 대기: Search Trend·Shopping Insight·blog/local 요청을 `legacy|hub|auto` 모드와 공급자별 인증 헤더·기본 주소·경로로 분리하고 Production의 `NAVER_API_HUB_MODE=hub`를 명시 적용했다. NCP 실키로 Search Trend HTTP 200·30개 시계열, Shopping Insight age HTTP 200·153개 데이터를 확인했다. Hub 읽기 요청은 네트워크·408·425·429·5xx만 최대 1회, 2초 이내 대기 후 재시도하고 401/403 등 영구 오류는 즉시 사실대로 반환하는 안정화를 완료했다.
- 영향 범위 분리: 상품 단건·N 상품 30일·SEO가 사용하는 쇼핑 검색은 Hub 이관 대상이 아니므로 기존 OpenAPI 전용 호출로 유지했다. 공식 최신 공지 기준 2026-07-31 24:00 종료·공식 대체 API 없음이며, 이 기능은 Hub 전환과 별도로 검증 가능한 새 상품 순위 소스가 필요하다. N 상품·N 플레이스 30일의 사용자 등록·갱신·기존 스냅샷·광고 제외·정확 ID 계약은 변경하지 않았다.
- 검증 상태: 전환 커밋 `9705862`는 Production Ready이며 운영 `/health` 200, 비인증 세션 401 정상 차단을 확인했다. 후속 안정화의 Hub 503→200 제한 재시도 회귀를 포함한 API·서버 179/179, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 순위 기능 잠금·공개 빌드·전체 `check:release`·`git diff --check`가 통과했다. 안정화 커밋은 별도 배포 승인 전까지 로컬에 보관한다.

- 키워드 시장 경쟁강도 수요·상품규모 비례 보정 완료·배포 진행: 대표키워드는 검색수요와 상품 등록 규모가 함께 클 때 경쟁이 높고, 수요가 충분해도 상품 등록이 적으면 저경쟁·고기회 후보가 되도록 전 키워드 공통 모델을 수정했다. 수요점수×절대 상품규모를 비례 결합하고 수요 대비 과잉 상품밀도를 안전 신호로 사용하며 검색광고 경쟁도는 보조 반영한다. 표본 `71,400회·상품 약 34만·광고경쟁 보통`은 `경쟁 83·매우 높음`, 같은 검색량·상품 2만은 `32·낮음`·판매 기회 `87·매우 높음`으로 분리된다. 실제 매출 데이터가 없어 판매 기회율은 매출 보장이 아닌 공급 공백 참고값으로 유지한다. 신규 비례형 회귀 4개를 포함한 API·서버 169/169, 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 역할 parity·CSP·전체 `check:release`가 통과했고 N 상품·플레이스 30일 잠금 4함수·20파일·11마이그레이션은 변경되지 않았다. 사용자 승인에 따라 커밋·Production 배포·운영 실조회 검증을 진행한다.

- N 상품·N 플레이스 30일 핵심 기능 잠금·운영 반영 완료: 운영팀·광고주 추적 함수 4개와 상품·플레이스 서버, 크론, 플레이스 수집기, GitHub 워크플로, 순위 DB 마이그레이션을 해시로 고정했다. 이 잠금은 사용자 사용을 막는 런타임 잠금이 아니라 보호 코드 변경을 배포 전에 차단하는 품질 게이트다. 신규 키워드 조회와 상품·플레이스 추적 등록·갱신은 계속 허용한다. 정상 잠금 4개 함수·20개 파일·11개 마이그레이션, 가상 함수 변조 차단 self-test, 신규 사용 경로 회귀와 전체 `check:release`에서 API·서버 162/162, 수집기 51/51, 역할 parity·기준선·공개 빌드·CSP·Production 인증 18/18을 통과했다. 운영에서 신규 조회·추적 버튼 활성, 상품 25개·플레이스 10개 기존 이력 로드도 확인했다.

- N 상품·플레이스 30일 갱신 적용 범위 재확정: `6fd007d`는 기능 커밋이 아니라 운영 실측 문구만 바로잡은 문서 커밋이며, 실제 갱신 코드는 운영팀·광고주 공통 페이지와 사이트 전체 크론에 적용되어 있다. `mml93-a01`은 당시 운영 실측 표본일 뿐 기능 기준 계정이 아니다. 임의 광고주 코드 `agency-b02`의 계정별 갱신 범위와 계정 필터가 없는 사이트 전체 크론을 상품·플레이스 양쪽에서 회귀 검사하도록 보강했다. 상품 27/27·플레이스 46/46, 역할 parity·기준선·전체 `check:release`·Production 인증 18/18을 통과했다.

- 홈페이지 서비스 안내 팝업 기능명 통일·운영 반영 완료: 내부 메뉴와 달랐던 `네이버 상품순위`·`네이버 30일 순위`·`네이버 플레이스 30일 순위`만 `N 상품 순위`·`N 30일 순위`·`N 플레이스 30일 순위`로 변경했다. 팝업 크기·위치·노출·닫기·1주일 숨김 로직은 변경하지 않았다. 전체 `check:quality`와 기준선·공개 빌드·CSP를 통과했고 운영 데스크톱 348×489px, 가로 넘침·브라우저 경고/오류 0건과 새 기능명 3개 노출을 확인했다.

- N 상품 30일 전체 갱신 안전 가속: 사이트 공통 UI 전체 갱신을 동시 2개로 제한했다. 페이지 진입 시 숨은 `sync-due`도 50개에서 2개로 줄이고 자동·수동 중첩을 차단했다. 운영 2차 실측은 표본 계정 `mml93-a01`에서 기존 약 186초 대비 115초, 화면 25개 완료·DB 25/25 정상·오류/재시도 0건이었다. 성공 응답을 브라우저가 놓친 경우 서버의 최신 확인 시각으로 재대조한 뒤 진짜 미완료 항목만 1회 재시도한다.
- N 플레이스 30일 전체 갱신 안전 가속: 수집기는 단일 브라우저·직렬 처리를 유지한다. 완주·네이버 목록 정상 소진 결과는 기존처럼 공유하고, 시간 마감·스크롤 한도 부분 결과는 이후 추적의 정확 Place ID가 이미 그 목록에 존재할 때만 3분 동안 재사용한다. 미발견·ID 없음·선택자 폴백은 새로 수집하므로 짧은 목록을 순위권 밖으로 오판하지 않는다. `429 collector_busy`도 절대 마감 안에서만 재시도한다.
- 운영 실측·정확성 보존: 플레이스 10건은 고유 키워드 3개(`구월동 맛집` 8건·`홍대 맛집` 1건·`부평 맛집` 1건) 기준 721초에 화면 10개 완료, DB 오류 0건으로 끝났다. 진행 계측은 첫 동일 키워드 수집 후 226초 3/10에서 267초 9/10으로 이어졌고, 최종 구월동 8/8 순위 일치·홍대 7위 일치·부평 실제 77개 미발견 부분 확인을 기록했다. 상품의 정확 상품ID·검증 원부ID·광고 제외와 플레이스 네이티브 PC 오가닉·부분조회 진실성, DB 스키마·기존 이력은 변경하지 않았다.
- 검증·배포 상태: API·서버 160/160, 플레이스 수집기 51/51, 서버 계약 22/22, Production 인증 18/18, 운영팀·광고주 parity·CSP 공개 빌드·전체 `check:release`·`git diff --check`를 통과했다. Vercel `c71d565f4140` live·Supabase ready, Render `2026-07-22-safe-exact-match-cache-v20` healthy를 확인했다. 운영 DB는 상품 추적 25개·스냅샷 1,985개, 플레이스 추적 10개·스냅샷 366개로 증가했고 기존 행·이력 감소가 없다.

- 키워드 연령 집계 원인 확정·수정: NAVER 쇼핑인사이트 연령 API의 `ratio`는 월별 최고 연령을 100으로 둔 상대 클릭지수인데, 기존 서버가 최근 1년의 월별 상대지수를 단순 합산해 `최근 1년 검색 비율`로 표시했다. 월별 전체 클릭량이 다른 상태에서 이 값들을 같은 가중치로 합칠 수 없어 다른 서비스의 최신 연령 구성과 달라질 수 있는 직접 원인이다.
- 새 집계 계약: 최신 완료 월의 같은 구간 안에서만 10·20·30·40대와 50·60대를 합친 `50대 이상`을 합계 100%로 정규화한다. 진행 중인 이번 달은 제외하고, API가 0값 연령 행을 생략해도 0%로 처리하며 완료된 비교 구간이 없으면 비율을 발명하지 않는다. API에 `ageBasis=latest_complete_month_shopping_keyword_share`와 `agePeriod`를 함께 남긴다.
- 역할·검증 상태: 운영팀과 광고주 모두 제목·설명·툴팁을 `연령별 쇼핑 클릭 비중`과 `최신 완료 월` 기준으로 통일했다. 신규 회귀 4/4, 전체 API·서버 158/158, 플레이스 수집기 49/49, 서버 계약 22/22, Production 인증 18/18, 역할 query parity, CSP 공개 빌드와 전체 `check:release`, `git diff --check`를 통과했다. 상품·플레이스 순위, 추적 이력, 로그인·권한, DB 스키마는 변경하지 않았다.
- 운영 반영: 코드 `a4d68f3`·Production 릴리스 `a4d68f324d9b`가 운영 별칭에 반영됐다. `/health` live, `/ready` Supabase ready, 운영 `admin`·`client`의 새 제목·설명·툴팁과 비인증 키워드 API 401을 확인했다. 브라우저 운영 세션은 재검증 시점에 로그아웃 상태여서 인증 후 동적 새 값 확인은 다음 실사용 조회에서 이어간다.

- 플레이스 의료 키워드 미추적 원인 확정·로컬 정상화: `종로3가한의원`·`종로한의원`/플레이스ID `1531240094`는 순위권 밖이 아니라 운영에서 30~31회 모두 `#_pcmap_list_scroll_container` timeout으로 실패해 snapshot이 0건이었다. 네이버가 의료 검색을 `hospital/list`로 여는데 수집기가 이를 일반 `place/list?display=300`으로 다시 열어 `조건에 맞는 업체가 없습니다` 페이지를 읽은 것이 직접 원인이다.
- 수정·실조회: 네이버 검색 화면이 생성한 정확한 HTTPS `pcmap.place.naver.com` 목록 경로와 검색 문맥을 신뢰하되 `hospital/list`의 네이티브 `display=70`은 보존한다. 기존 `restaurant/list`의 300개 확장은 유지한다. 광고를 제외한 실제 PC 오가닉 목록에서 정확 ID `1531240094`는 `종로3가한의원` 3위, `종로한의원` 12위로 확인됐고 `홍대 맛집` 7위·`부평 맛집` 100개 부분 미발견 회귀도 그대로다.
- 검증·보존 범위: 수집기 47/47, API·서버 154/154, 서버 계약 22/22, Production 인증 18/18과 전체 `check:release`, 비네이버 프레임 URL 차단, `git diff --check`를 통과했다. `admin.html`·`client.html`·서버 저장 계약·Supabase 스키마·기존 추적 행과 30일 이력은 변경하지 않았다. 사용자 승인에 따라 코드 커밋·운영 배포와 새 snapshot 저장 검증을 진행한다.

- 운영팀·광고주 로그아웃 화면 복귀 정상화: 서버 로그아웃 성공 시 광고주 화면이 코드만 지우고 `is-authed`를 유지하던 조건 역전을 원인으로 확정했다. 이제 두 역할 모두 로그아웃 클릭 즉시 민감 화면을 잠그고 로그인 화면 최상단으로 복귀하며, 서버 세션 종료는 캡처한 CSRF로 5초 제한·최대 2회 확인한다. HTTP 성공과 JSON `ok=true`를 모두 충족한 경우에만 서버 로그아웃 완료로 안내한다.
- 교차 세션 방어: 로그인·세션 복원·보고서 동기화·원본 파일 읽기/업로드·PPTX 생성·Owner/운영팀 계정 조회/생성/해제·Meta·키워드·SEO·N상품 1회 조회 응답에 세션 generation·role·scope 검증을 적용했다. 로그아웃 시 상품·플레이스 URL, 키워드, 필터·그룹 임시값, 조회 결과와 요약도 지워 이전 계정의 입력과 지연 응답이 다음 계정 화면·파일·브라우저 저장소를 덮지 못한다.
- 검증·운영 반영: 초기 로그인 화면 잠금이 기존 서버 세션 자동 복원 generation을 무효화하던 2차 회귀까지 수정하고 기준선에 고정했다. 전체 `check:release`에서 API·서버 154/154, 플레이스 수집기 44/44, 서버 계약 22/22, Production 인증 18/18, 역할 parity·CSP 공개 빌드와 인라인 문법·`git diff --check`를 통과했고 독립 적대적 재검수도 P0/P1 0건이다. 코드 `b052e85`·Production `b052e8597fb4` 반영 후 실제 `우노헬스케어` 광고주 세션 자동 복원→로그아웃 즉시 로그인 화면→새로고침 후 잠금 유지, 운영팀 로그인 잠금, 양 페이지 콘솔 오류 0건, 상품·플레이스 보호 API 401을 확인했다.

- 플레이스 순위 v16 운영 상태: 순위 근거를 네이버 PC 실제 장소 목록의 광고 제외 오가닉 행으로 단일화하고, Apify 배열 순번은 운영 순위에 사용하지 않는다. Vercel이 Render cold start를 포함한 절대 마감 시각을 전달하며 수집기는 1600px viewport와 겹침 스크롤로 마감 전 실제 확인 범위만 반환한다. 본 서버도 `source=naver_map_pc_list_collector`와 `rankEvidence=naver_pc_organic_list`를 모두 강제해 구버전·오염 응답은 스냅샷으로 저장하지 않고 기존 순위·30일 이력을 보존한 채 재시도한다. 코드 `5014d1a`와 Render `2026-07-20-native-organic-deadline-v16`이 운영 반영됐고 `/health`·`/ready`·Supabase ready를 확인했다.
- v16 실조회·검증: `홍대 맛집`/`1907427831`은 100개를 확인해 실제 PC 오가닉 7위, `부평 맛집`/`2019299673`은 100개를 확인해 미발견·rank null로 종료됐다. 전체 `check:release`는 API·서버 154/154, 플레이스 수집기 44/44, 서버 계약 22/22, Production 인증 18/18, 역할 parity·CSP·공개 빌드와 `git diff --check`를 통과했다. 독립 재검수 결과 P0/P1 0건이며 `admin.html`·`client.html`·N상품·30일 이력 코드는 변경하지 않았다.
- v16 운영 스냅샷: `홍대 맛집`은 실제 97개·정확 ID 7위, `부평 맛집`은 실제 77개·미발견/null로 새 저장됐다. 두 snapshot source는 모두 `naver_map_pc_list_collector`이고 블로그·방문 coverage도 각각 97/97·77/77이다. 기존 `_fallback` 이력은 삭제·재작성하지 않았다. 첫 workflow는 이 정상 부분 결과를 경고하는 정책 때문에 실패 결론을 냈으며 transport·수집기 오류나 데이터 소실은 없었다.
- 네이버 API 공지 감사: 메일과 공식 공지를 대조한 결과 Search Trend·Shopping Insight·일반 Search 일부는 NAVER API Hub 이관 대상이다. 반면 현재 상품 단건·N 30일·SEO에 쓰는 쇼핑 검색 API는 이관 제외이며 2026-07-31 종료·대체 API 없음이 별도 공지로 확정됐다. 2026-07-20 legacy 실호출은 아직 200이므로 이번 플레이스 오류의 직접 원인은 아니며, 종료 전에 상품 순위 소스 교체와 이관 가능 API의 Hub 어댑터를 별도 작업으로 진행해야 한다.

- 플레이스 실위치 순위 근거 정상화: `/p/api/search/allSearch`는 지도 마커 미리보기라 PC 장소 목록의 오가닉 순서와 다르므로 순위 근거에서 완전히 제외했다. 실제 `#_pcmap_list_scroll_container` 안에서 확인된 행만 순번에 포함하고, 광고는 제외하되 ID를 읽지 못한 실제 목록 행은 순서 슬롯으로 보존해 이후 대상 순위의 압축·팽창을 모두 차단했다.
- 부분 조회 진실성: 300개를 완주하지 못한 미발견 결과는 `current_rank=null`로 두고 5분부터 재시도한다. 불완전 후보는 캐시·다른 추적 항목에 재사용하지 않으며, 화면은 `N위까지` 대신 `N개 확인 · 이후 미검증`으로 표시한다. 최신 스냅샷이 null이면 운영팀·광고주 모두 현재값·요약·필터·추세·권고를 과거 순위로 판정하지 않는다.
- 실조회: 가상 목록을 끝으로 점프해 중간 행을 놓치고, 장소 카드 내부 프로모션 `li`를 업체로 세던 추가 원인도 제거했다. selector가 늦게 잡히는 경로도 첫 9개에서 멈추지 않고 겹침 수집 68회로 100개까지 확장됨을 강제 재현했다. 최종 독립 조회에서 `홍대 맛집`/`1907427831`은 실제 목록과 수집기가 같은 오가닉 7위, `부평 맛집`/`2019299673`은 양쪽 모두 상위 100개 미발견이며 두 키워드 top10 ID·순위가 전부 일치했다. 네이버 공개 목록은 현재 100개에서 종료되므로 101~300위는 임의 확정하지 않는다.
- 타임아웃·누락 방어: 정확 Place ID가 있으면 상호명 누락만으로 상세 페이지를 다시 열지 않고, 선택 메타데이터 대기는 1초로 제한했다. DOM viewport 추출 오류는 빈 화면으로 넘기지 않고 즉시 실패·재시도하며, 마감 후 신규 DOM 작업도 시작하지 않는다. `placeName`을 비운 부평 실조회도 39.827초에 100개/null로 종료됐다.
- 회귀 범위: 상품 N 30일 순위의 조회·광고 제외·원부/정확 상품 대표 판정은 변경하지 않았다. 전체 `check:release`는 API·서버 153/153, 플레이스 tracker 계약 42/42, 플레이스 수집기 42/42, Production 인증 18/18, 서버 계약 22/22, 역할 parity·CSP 공개 빌드를 통과했다. 독립 2차 검수의 최종 판정은 P0 0건·P1 0건이다.
- 큐 연속성: 배포 후 전건 재수집에서 `종로한의원` 1건의 네이버 목록 selector 실패가 뒤의 정상 추적까지 중단시키는 운영 결함을 추가 확인했다. 개별 실패는 재시도 예약·오류 기록을 유지하되 나머지 due 큐를 끝까지 처리하고, 전체 처리 후 workflow를 실패로 보고하도록 바꿔 실패 은폐와 정상 건 누락을 함께 막았다.

- 플레이스 전체 업체 지표 정상화: 대상 매장 일치 여부와 무관하게 키워드 검색에서 실제 확인한 모든 오가닉 업체의 `visitorReviewCount`·`blogCafeReviewCount`를 합산해 스냅샷 `place.metrics`에 저장한다. 광고 후보는 제외하고 `businessCount`는 실제 `checkedCount`와 동일하게 유지한다.
- 지표 진실성: 전체 후보가 값을 제공하고 coverage의 전체 수가 실제 확인 업체 수와 일치한 경우에만 블로그·방문 합계를 확정한다. 누락은 `0`으로 바꾸지 않고 `-`로 표시하며, 실제 명시값 `0`은 `0`으로 보존한다. 월검색량은 지도 응답에 없는 값이므로 서버의 네이버 검색광고 키워드 API에서 별도로 병합하되 `<10` 같은 범위값은 정확한 숫자로 저장하지 않는다.
- 실조회·검증: `부평 맛집`은 오가닉 54개 전체 coverage 54/54, 블로그 56,310개·방문 173,749개로 확인됐고 `강남 맛집`도 54개 전체 coverage 54/54, 블로그 61,503개·방문 145,192개로 확인됐다. 대상 미발견 시 순위는 계속 null·부분 조회로 보존한다. 전체 `check:release`는 API·서버 152/152, 수집기 35/35, Production 인증 18/18, 양 역할 parity·CSP 공개 빌드·`git diff --check`를 통과했다.

- 순위 연속성 긴급 수정: 상품ID `12649811979`는 최근 30일의 확정 스냅샷에서 광고 제외·오가닉 근거가 있는 정확 원부ID `57907660073`만 이어받아 정확 상품과 같은 300개 응답에서 비교한다. 제목·브랜드·카테고리가 비슷한 다른 원부는 연속성 후보로 쓰지 않는다.
- 플레이스 정확성 수정: 플레이스ID `2019299673`은 이름 유사도보다 정확 ID를 강제하고 공식 모바일 플레이스에서 `팽오리농장 부평점` 상호명을 보강한다. 대상 URL의 `lng/lat`는 키워드 검색 순서를 편향하므로 순위 조회에 사용하지 않는다. 네이버 공개 목록이 54개에서 끝난 실조회는 300위 미노출로 확정하지 않고 부분 조회로 저장하며 현재 순위는 null로 두고 짧게 재시도한다.
- 검증 상태: 상품 실조회는 검증 원부가 `음파 전동칫솔` 15위·`전동칫솔` 25위, 정확 판매자 상품은 두 키워드 모두 상위 300위 밖이다. `check:release`, API·서버 147/147, 플레이스 수집기 32/32, Production 인증 18/18, 공개 빌드와 `git diff --check`를 통과했다. `admin.html`·`client.html`과 기존 추적 행·스냅샷은 변경하지 않았다.
- 운영 반영: 코드 `3fb98b9`가 Vercel 운영 별칭에 반영돼 `/health`·`/ready`가 같은 릴리즈와 Supabase ready를 반환하며, Render는 `2026-07-19-exact-id-coordinate-rank-v11`이다. 운영 DB 새 스냅샷은 두 상품 모두 `checked_count=300`, `matched=true`, `rankPolicy=organic_only`, `adExcluded=true`이고 현재 순위는 15위·25위다. 플레이스 상호명은 `팽오리농장 부평점`으로 복원했으며 미검증 순위는 null로 유지했다.

- Owner 코드 생성 UI: 운영팀·광고주 생성 행을 전용 2열 그리드로 통일하고 두 `바로 생성` CTA를 같은 2행 2열에 정렬했다. 1220px 이하에서는 한 열·전폭 CTA로 전환하며, 카드 안의 배경·테두리·간격만 절제된 네이비 톤으로 보완했다. `data-owner-team-create`, `data-team-client-create` 등 기존 권한·생성 훅과 서버 요청은 변경하지 않았고 `client.html`도 수정하지 않았다.
- UI 검증·배포 상태: 로컬 1440·1280px에서 두 버튼의 X좌표·폭·높이 일치, 1180·1024·390px에서 한 열 전환과 문서 가로 넘침 0을 확인했다. `check:release`, 서버 계약 22/22, API·서버 133/133, 플레이스 29/29, Production 인증 18/18, 공개 빌드와 `git diff --check`를 통과했으며 커밋 `e648fc6`을 운영 별칭에 반영했다.

- 사용 중 기능 비소실 보호: 세션·API·네트워크 장애가 상품·플레이스 30일 목록과 기존 이력을 빈 화면으로 덮지 않도록 last-good 캐시, 완전 목록 계약, 이력 페이지네이션, 실패 안전 판정을 운영팀·광고주 공통 경로에 적용했다.
- 운영 배포 확인: Vercel `/health`·`/ready`는 릴리즈 `e648fc6c6519`와 Supabase ready를 반환하고, 관리자·광고주 페이지는 200·브라우저 콘솔 오류 0건, 보호 API는 비인증 401이다. Render 수집기는 `2026-07-19-organic-selector-fallback-resilience-v10`으로 전환됐다.

- 30일 순위 복구: 보안 세션 전환 후 총관리자 기본 조회 대상이 실제 `mml93-a01`이 아니라 `session`으로 남아 상품·플레이스 목록 API가 403을 반환했고, UI가 이를 0개 목록처럼 표시한 회귀를 확정했다. DB에는 상품 추적 88개·플레이스 추적 13개와 기존 스냅샷이 그대로 보존되어 있었다.
- 복구 구현: 총관리자는 서버가 반환한 Owner 코드 또는 활성 광고주 코드만 대상 범위로 사용하고 세션 placeholder는 API 헤더로 보내지 않는다. 상품·플레이스 양 역할 화면은 일시적인 API 실패 시 이미 표시 중인 카드를 빈 목록으로 덮지 않는다.
- 복구 검증·배포: 역할별 조회 계약과 CSP 회귀 기준, 서버 계약 22/22, API·서버 122/122, 플레이스 26/26, 전체 `check:quality`와 공개 빌드 무결성을 통과했다. 커밋 `7459d49`를 운영 별칭에 반영한 뒤 총관리자 상품 25개·플레이스 10개, 광고주 격리 범위 상품 25개·플레이스 1개와 기존 일별 이력을 실화면에서 재확인했다. 운영 `/health` 릴리즈는 `7459d49246fb`다.

- 상태: 운영 Production 기준 커밋 `b37ca5f`에서 보안 강화만 분리 통합했다. 이전 이메일·매직링크 목업과 월간/PPT·보고서 실험 변경은 릴리즈 범위에서 제외했다.
- 보안: 암호화 HttpOnly 세션, CSRF·동일 출처 검사, DB 기반 로그인 속도 제한, 역할·테넌트 범위 강제, 업로드·SSRF·오류 응답·CSP·공급망·크론 실패 안전화와 DB 함수 실행 권한 축소를 적용했다.
- Owner 도구: 부가세 계산기는 공개 HTML·광고주 화면에 포함하지 않고, 서버가 검증한 정확한 `mml93-a01` Owner 세션에서만 동적으로 제공하고 계산도 서버에서 수행한다.
- 검증·배포 상태: `check:release`에서 서버 계약 22/22, API·서버 122/122, 플레이스 수집기 26/26, Production 인증 14/14와 빌드·공개 산출물 검사를 통과했다. 코드 릴리즈 `cc548b2`를 Production `momentinsight-82hrf7a65-momentlabs.vercel.app`과 운영 별칭에 반영하고 실화면 재검증까지 완료했다.

- 상태: 메인 홈페이지의 `Product Intelligence`를 `Trust Standard`보다 먼저 배치하고, 4개 기능 카드를 `현재 데이터`와 `30일 순위 추적` 두 그룹으로 분리했다.
- 디자인: 쇼케이스 배경을 채도 낮은 잉크 네이비 그라데이션과 얇은 인셋 하이라이트로 보정했다. 기존 카드 내용·팝업·운영팀/광고주 기능은 변경하지 않았다.
- 검증·배포 상태: 1440×900·390×844 로컬·운영 화면에서 섹션 순서, 그룹별 2카드, 문서 가로 넘침·카드 내부 잘림·콘솔 오류 0건을 확인했다. `9cdbaad`를 Production `momentinsight-8rljvs8ue-momentlabs.vercel.app`과 운영 별칭에 반영했다.

- 상태: 메인 홈페이지의 중복 `For Brand Growth`·`Core Features` 섹션을 제거하고, 오가닉 상품 순위·상품 30일 추적·플레이스 30일 추적·키워드 시장 분석을 한 번에 보여주는 익명 기능 쇼케이스로 교체했다.
- 개인정보 보호: 사용자 제공 화면은 이미지로 삽입하지 않았고 실제 광고주명·상품명·키워드·가격·상품/원부/플레이스 ID·조회 시각·외부 링크를 사용하지 않았다. 모든 명칭과 수치는 예시임을 화면에 명시했다.
- 검증·배포 상태: 전체 품질검사와 1440×900·390×844 로컬·운영 화면, 카드 4개, 모바일 그룹별 가로 탐색, 문서 가로 넘침·텍스트 잘림·콘솔 오류 0건을 확인했다. 운영 HTML은 로컬 `dist`와 바이트 단위로 일치한다.

## 완료

- Production 기준에서 보안 관련 커밋만 재구성해 승인되지 않은 보고서·PPT·이메일 목업이 함께 배포되지 않도록 릴리즈 경계를 고정했다.
- Supabase 로그인 속도 제한·활성 운영팀별 단일 광고주 제약·DB 함수 권한 축소 마이그레이션을 적용했다. 공개·익명 함수 실행 권한은 제거했고, 기존 RLS가 사용하는 `has_client_access`·`is_admin`만 로그인 역할에 유지했다.
- Vercel Production에 Owner 식별·로그인 해시·세션 암호화·크론 보안값을 민감 환경변수로 등록했으며 값은 코드·문서·출력에 남기지 않았다.
- 204·205·304 응답에 본문을 붙여 브라우저 preflight가 500이 되던 런타임 결함을 수정하고 회귀 검사를 추가했다.
- 첫 운영 점검에서 중첩 Owner API 경로가 Vercel catch-all에 도달하지 않아 404가 된 사실을 확인하고, `/api/owner/tool` 전용 서버리스 어댑터와 릴리즈 계약 검사를 추가했다.
- 운영 로그아웃 재검증에서 다중 `Set-Cookie` 중 개발용 삭제 쿠키만 전달되어 Production 세션이 남는 결함을 확인했다. 공통 Vercel 응답 어댑터가 모든 쿠키 삭제 헤더를 배열로 보존하도록 수정하고 자동 검사를 추가했다.
- 운영 `/health`·`/ready`는 200, 크론 익명 호출과 Owner 도구 익명 호출은 401, preflight는 204다. 브라우저에서 로그인 전·광고주 화면 계산기 0건, `mml93-a01` 로그인 후 메뉴·100,000→100,000/10,000/110,000 계산·복사 완료, 로그아웃 후 메뉴 제거와 API 401을 확인했다.

- `Hero → Product Intelligence → Trust Standard → Workflow → CTA` 순서로 기능 설명을 우선 노출했다.
- `현재 데이터`에는 오가닉 상품 순위·키워드 시장 분석, `30일 순위 추적`에는 상품·플레이스 추적을 배치했다. 모바일은 두 그룹별 독립 가로 탐색을 유지한다.
- 그룹별 카드 구성과 섹션 순서를 직접 검사하는 `homeFeatureShowcasePriorityAndGroups` 기준선을 추가했다. 익명 예시 데이터 기준선과 팝업 보존 기준선도 계속 통과한다.
- `admin.html`, `client.html`, 서버·수집·저장·크론·Supabase는 변경하지 않았고, 승인된 홈페이지 4개 커밋만 `main`과 Production에 반영했다.
- Production `momentinsight-8rljvs8ue-momentlabs.vercel.app`은 READY이며 `https://insight.momentlabs.co.kr` 별칭이 연결됐다. `/health`는 HTTP 200·`ok=true`·`supabaseReady=true`다.

- 딥네이비 쇼케이스 안에 `오가닉 상품 순위`, `키워드 시장 분석`, `상품 순위 추적`, `플레이스 순위 추적` 4개 HTML/CSS 샘플 카드를 구성했다. 실제 스크린샷·상품 이미지 대신 중립 MI 플레이스홀더와 인라인 미니 차트를 사용했다.
- 데스크톱은 7:5 비율 2×2 Bento, 모바일은 277px 카드 가로 탐색으로 구성해 4개 기능을 한 섹션 안에서만 보여준다. 전체 페이지 높이는 검증 환경 기준 데스크톱 3,175→3,107px, 모바일 4,220→3,729px로 감소했다.
- 쇼케이스에 `synthetic-only`, `예시 데이터`, `실고객 정보 미사용` 표시를 넣고, 실고객 문자열·9자리 이상 ID·외부 URL·`img`·상품/원부/플레이스 ID 문구를 금지하는 `homeAnonymousFeatureShowcase` 릴리즈 기준선을 추가했다.
- `npm run check:quality`, `npm run build:vercel`, `git diff --check`를 통과했다. `admin.html`, `client.html`, 서버·순위 수집·매칭·저장·크론·Supabase 코드는 변경하지 않았다.

- `src/pages/home.html`에 정식 문서 구조와 viewport, body 여백 초기화를 추가해 모바일이 데스크톱 폭으로 축소 렌더링되던 기반 문제를 제거했다.
- 팝업의 데스크톱 348×489px, 모바일 높이 489px, 데스크톱 `left/top`, 모바일 `left/right/top`, 다섯 기능·카카오 링크·닫기·1주일 숨김 훅과 저장 키를 그대로 보존하고 색·테두리·그림자만 정돈했다.
- 모바일 헤더는 99px 두 줄에서 65px 한 줄로, 전체 페이지 높이는 검증 환경 기준 약 5,498px에서 4,220px로 줄였다. 반복 3개 카드는 카드 내용을 삭제하지 않고 가로 탐색으로 압축했다.
- 대시보드 수치는 `샘플 화면`·`예시 데이터`로 명시하고, 신뢰 기준은 연결 패널, 운영 흐름은 단일 단계 보드, CTA는 흰색 주 행동 버튼, 푸터는 실제 이동 링크 3개로 재구성했다.
- `homeDocumentShellAndViewport`, `homePopupGeometryPreserved`, `homePremiumHierarchyVisible` 릴리즈 기준선을 추가했고 `npm run check:quality`, `npm run build:vercel`, `git diff --check`를 통과했다. `admin.html`, `client.html`, 순위 수집·저장·판정 코드는 변경하지 않았다.

- 운영팀·광고주 `renderRankSlot()`에서 정확 상품의 작은 일별 슬롯 라벨만 숨겼다. 카드 상단 상품/원부 기준, 순위 조회·저장·갱신·크론·대표값 판정은 수정하지 않았다.
- 실제 함수 런타임 출력은 양 역할 모두 정확 상품 `<small>PM</small><b>9위</b>`, 관련 원부 `<small>AM · 원부</small><b>8위</b>`로 확인됐다.
- `rankTrackingDailySlotOmitsExactProductLabel` 릴리즈 기준선을 추가했고 전체 `npm run check:quality`에서 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드·Vercel 빌드가 통과했다.
- 광고주 390px 빌드는 `scrollWidth=390`, 운영팀 데스크톱과 광고주 모바일의 신규 마커 반영·기존 문구 제거·콘솔 오류 0건을 확인했다.
- 승인 커밋 `368408d`만 `main`에 푸시하고 Production `momentinsight-jly55k3zm-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 `/health` HTTP 200, 운영팀·광고주 HTML은 승인 커밋과 바이트 단위로 일치한다. 로그인 실데이터의 두 역할 각 414개 슬롯에서 정확 상품의 `상품` 문구 0건, 원부 구분 유지, 콘솔 오류 0건을 확인했으며 GitHub 품질·상품 순위 갱신·플레이스 순위 갱신 작업도 모두 성공했다.
- 거절된 홈페이지 고도화 커밋 `0886833`과 해당 작업 문서는 로컬 `main`에서 제거했으며 운영 홈페이지와 현재 소스는 `368408d` 기준을 유지한다.

- 원인은 고정 폭 오전·오후 슬롯에서 선택 기준이 붙은 `PM · 상품` 라벨만 자동 줄바꿈되어 아래 순위 숫자를 한 줄 밀어낸 것이었다.
- `N 30일 순위`의 일별 카드 CSS만 조정해 기준 라벨을 한 줄로 고정하고 슬롯 안쪽 여백과 라벨 크기를 맞췄다. 순위 조회·저장·갱신·크론·원부/상품 대표값 판정 코드는 수정하지 않았다.
- 운영팀·광고주 각각 207개 일별 카드의 오전·오후 숫자 상단 좌표 차이는 최대 0px이고, `PM · 상품`·`PM · 원부` 라벨의 줄바꿈·잘림은 0건이다. 390px에서도 같은 기준선 정렬을 확인했다.
- 양 역할 브라우저 콘솔 경고·오류 0건, `rankTrackingDailySlotAlignment` 릴리즈 기준선, 전체 `npm run check:quality` 독립 2회, 서버 13/13, 플레이스 수집기 25/25, Vercel 빌드와 `git diff --check`를 통과했다.
- 코드 커밋 `01935d2`을 `main`에 푸시하고 Production `momentinsight-fhgibit9c-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 `/health`, 관리자·광고주 HTML이 HTTP 200이며 운영팀·광고주 각 207개 일별 카드의 기준선 차이 0px, 라벨 오버플로 0건, 운영 콘솔 경고·오류 0건을 재확인했다.

- 플레이스 30일 일별 기록을 폭 140px의 작은 카드, 17px 핵심 순위, 2×2 보조지표 구조로 바꾸고 그림자·테두리·간격을 낮춰 한 화면의 비교 밀도를 높였다.
- 현재 순위는 딥네이비 강조, 날짜·보조지표는 절제된 그레이로 계층을 분리했으며 기존 상태 배지·버튼·그룹·30일 기록과 내부 가로 탐색은 보존했다.
- 모바일은 헤더를 2행으로 압축하고 상태 배지를 한 줄 가로 탐색으로 바꿨다. 운영팀·광고주 모두 390px에서 첫 카드 248×285px, 상태 영역 43px, 문서 `scrollWidth=390`이며 긴 수치 잘림이 없다.
- 데스크톱은 두 역할 모두 첫 카드 858×264px, 일별 셀 140px이며 긴 값 오버플로 0건이다. 브라우저 콘솔 경고·오류도 양 역할 데스크톱·모바일 모두 0건이다.
- `placeRankPremiumCompactCards` 릴리즈 기준선을 추가하고 전체 `npm run check:quality`를 독립 2회 통과했다. 각 실행에서 서버 13/13, 플레이스 수집기 25/25, 크론·순위·키워드·Vercel 빌드가 정상이다.
- 순위 수집·매칭·광고 제외·Supabase 스키마·운영 데이터는 수정하지 않았다.
- 코드 커밋 `7710008`을 `main`에 푸시하고 Production `momentinsight-m19imug8x-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 `/health`, 관리자·광고주 HTML이 HTTP 200이며 두 역할 데스크톱 264px·390px 모바일 285px 카드, 긴 수치 오버플로 0건, 운영 콘솔 경고·오류 0건을 재확인했다.

- 오류 원인은 정확 상품 제목 `파세코 접이식 선풍기 BLDC 서큘레이터 아리아 PCF-MSF1100`과 원부 제목 `파세코 PCF-MSF1100 화이트` 사이에 검색 키워드 `써큘레이터`가 공통으로 존재하지 않아 기존 원부 후보가 제거된 것이었다.
- 관련 원부 연결은 모델번호 정규화 완전 일치 또는 기존 키워드 근거, 브랜드·제조사·판매처 식별 근거, 상위 카테고리 일치를 모두 요구한다. `PCF-MSF1100`과 접두가 유사한 `PCF-MSF11000`은 별도 모델로 제외한다.
- 로컬 API는 300개를 확인해 원부 `53687717527` 8위·정확 판매자 상품 `11687310806` 59위를 반환하고 대표값은 원부 8위·원부형·`related_catalog`로 선택한다.
- 회귀 실조회는 `치아미백제` 원부 9위·정확 상품 44위, `전동 칫솔` 원부 34위·정확 상품 163위이며 기존 정확 상품 ID와 원부 대표 규칙을 유지했다.
- 운영팀·광고주 화면에서 같은 원부 8위·정확 상품 59위 카드, 상품명 키워드 검색 링크, 원부·정확 상품 상세 링크를 확인했다. 광고주 390px 문서 `scrollWidth=390`, 양 역할 콘솔 경고·오류 0건이다.
- `check:rank-matching`, 전체 `check:quality` 독립 2회, 서버 13/13, 플레이스 25/25, Vercel 빌드, 네이버 실행환경, Supabase HTTP 200, `git diff --check`를 통과했다.
- 코드 커밋 `d9b97ca`를 `main`에 푸시하고 Production `momentinsight-cjx4bkodl-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 `/health`와 순위 API는 HTTP 200이며, 운영팀·광고주 화면에서 원부 8위·정확 상품 59위·300개 확인·두 링크·콘솔 오류 0건을 재확인했다.

- 네이버 가격비교 `전동칫솔` 1페이지 원문은 `product` 오가닉 40개와 별도 `supersaving` 삽입 5개로 구성됐고, 오가닉 상품 순번은 삽입 카드와 독립적으로 1~40임을 확인했다.
- `adcr` 추적 URL은 정상 오가닉 상품에도 사용되므로 광고 판정 근거에서 제외했다. 광고 전용 플래그 `isAdProduct`, `adId`, sponsored/paid 계열과 `supersaving`·`brand_ad` 같은 비오가닉 타입만 제거한다.
- 검색 응답, 관련 원부·정확 상품 대표 선택, 30일 추적 재선택, Supabase 스냅샷 `item`·`top_items` 단계마다 광고 후보를 재차 제거한다.
- 실제 `치아미백제` 추적을 갱신해 대표 원부 8위·정확 상품 44위·300개 확인을 저장했고, 최신 스냅샷은 `rankPolicy=organic_only`, `adExcluded=true`, 대표 항목 `isAd=false`, 상위 5개 전부 오가닉이다.
- `check:rank-matching` 광고 혼입·오가닉 오탐 회귀, 릴리즈 기준선, 서버 문법, Supabase 연결, 네이버 환경 검사와 전체 `check:quality` 독립 2회를 통과했다.
- 관리자·광고주 30일 화면은 모두 `광고 제외 오가닉` 안내와 기존 프리미엄 추적 UI를 유지하며 빌드 화면에서 정상 렌더링됐다.
- 커밋 `032c144`을 `main`에 푸시하고 Production `momentinsight-iddnfo068-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 단건 API는 대표 원부 34위·정확 상품 166위·300개 확인과 `organic_only`를 반환했다. 운영 30일 추적은 원부 8위·정확 상품 44위를 저장했고 최신 Supabase 대표·상위 5개가 모두 오가닉이다.
- 운영 광고주 화면에서 자동추적 정상, 현재 원부 8위, 다음 오전 9시 갱신, 광고 제외 안내와 프리미엄 레이아웃을 확인했다.

- 로그인된 네이버 가격비교 `네이버 랭킹순·40개씩 보기`에서 `전동칫솔` 원부 `57907660073`이 오가닉 34위(1페이지 34위), 판매자 상품 `12649811979`가 오가닉 168위(5페이지 8위)임을 확인했다.
- 판매자 상품 카드의 `data-shp-contents-dtl`에서 `chnl_prod_no=12649811979`, `organic_expose_order=8`, 페이지 `5`를 확인해 다른 업체 상품 오일치가 아님을 재확정했다.
- 단건 조회의 대표 `rank`, `page`, `position`, 상품 형태는 관련 원부와 정확 상품 중 숫자가 더 낮은 오가닉 결과를 사용한다. 정확 상품 ID·카드·원본 링크는 `exactItem`으로 별도 보존한다.
- `전동칫솔` 로컬 API는 대표 34위·원부형·1페이지 34위, 정확 상품 168위·단일형·5페이지 8위·300개 확인을 반환한다. `치아미백제`는 대표 원부 9위·정확 상품 43위로 정상 회귀했다.
- 관리자·광고주 카드의 `공식 API N번째` 문구를 `N위·N페이지 N위`로 교체하고, 두 역할 모두 동일한 대표 기준·카드 링크·컴팩트 프리미엄 레이아웃을 유지했다.
- 관리자 데스크톱과 광고주 데스크톱·390×844에서 실조회했으며 모바일 문서 가로 넘침 없음, 두 역할 브라우저 경고·오류 0건이다.
- 전체 `npm run check:quality`를 독립적으로 2회 통과했다. 서버 테스트 13/13, 플레이스 수집기 25/25, 릴리즈 기준선과 Vercel 빌드가 정상이다.
- 커밋 `6424f58`을 `main`에 푸시하고 Vercel Production `momentinsight-3whvmsjzo-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 `/health`와 순위 API, 관리자·광고주 HTML이 HTTP 200이다. 두 역할에서 `전동칫솔`을 다시 조회해 대표 원부 34위·1페이지 34위, 정확 상품 168위·5페이지 8위, 300개 확인, 원부·상품 상세 링크를 재확인했다.

- 30일 추적이 단건 조회의 정확 상품 순번만 저장해 관련 원부가 더 높아도 반영하지 못한 원인을 확정했다.
- 단건 상품 ID 일치 기준은 유지하고, 30일 저장 직전에 정확 상품과 관련 원부를 비교하는 대표 순위 선택 단계를 추가했다.
- `치아미백제` 실조회는 상품 43번째·원부 9번째에서 대표 9위, `치아미백`은 상품 60번째·원부 14번째에서 대표 14위로 선택됐다.
- 스냅샷 JSON에 선택 출처·상품 순번·원부 순번·원부 ID를 보존하고 관리자·광고주 카드와 오전/오후 칸에 기준을 표시한다.
- 기존 과거 기록은 원부 순번 원본이 없으므로 임의로 변경하지 않고 다음 갱신부터 새 기준을 적용한다.
- 전체 `npm run check:quality`를 독립적으로 2회 통과했고 서버 테스트 13/13, 플레이스 수집기 25/25, Vercel 빌드가 정상이다.
- 관리자·광고주 소스와 빌드 HTML의 인라인 스크립트 문법, 대표 기준 문구, 현재·오전·오후 출처 마커를 확인했다.
- 인앱 브라우저와 Chrome의 로컬 주소 접근은 브라우저 보안 정책으로 차단돼 우회하지 않았으며, 이번 작업은 별도 배포 지시 전까지 운영에 반영하지 않는다.

- 운영 API 원문에서 판매자 상품ID `12649811979`가 공식 쇼핑 검색 API 168번째 결과와 정확히 일치함을 재확인했다.
- 오류는 상품 ID 매칭이 아니라 API 배열 순번 `168`을 고정 40개로 나눠 실제 쇼핑 화면 `5페이지 8위`로 표시한 환산 로직이었다.
- 서버의 `page`, `position`, `pageSize`를 `null`로 고정하고 `rankBasis=official_api_result_order`, `webPageVerified=false`를 반환한다.
- 관리자·광고주 단건·30일·SEO 화면에서 `오가닉 순위`, `광고 제외`, `페이지 N위` 표현을 `공식 API 결과 순번`, `화면 위치 미검증`으로 교체했다.
- 카드의 `정확 상품` 배지는 실화면 노출로 오해하지 않도록 `상품 ID 일치`로 변경했다.
- 로컬 실조회는 `rank=168`, `matchedProductId=12649811979`, `page=null`, `position=null`, `webPageVerified=false`를 반환했다.
- 전체 `npm run check:quality`를 독립적으로 2회 통과했다.
- 기존 `52d9a33` UI 변경은 그대로 보존했고 Supabase·운영 데이터·배포 환경은 변경하지 않았다.
- 배포 직전 재실조회에서 `전동칫솔` 입력 상품은 공식 API 168번째·관련 원부 34번째, `치아미백제` 입력 상품은 43번째·관련 원부 9번째였고 두 조회 모두 300개를 끝까지 확인했다.
- 네이버 공식 문서의 `display` 최대 100·`start` 최대 1000·정확도순 정렬 범위는 확인했지만 실제 쇼핑 화면 페이지와 동일하다는 근거는 없어 화면 위치 환산을 계속 금지한다.
- 2026-07-31 쇼핑 검색 API 종료 공지와 별도 Search API HUB 이관 공지가 함께 존재하나, 쇼핑 검색의 공식 대체 엔드포인트가 확인되지 않아 추정 주소나 비공식 크롤러는 운영에 추가하지 않는다.
- 커밋 `04ae40a`와 관련 UI 변경 `52d9a33`, 배포 명세 `5020825`를 `main`에 푸시했다.
- Vercel Production `momentinsight-1z4jt31ot-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 `/health`와 두 상품 API가 HTTP 200이며, 관리자 실화면에서 `공식 API 168번째`, `화면 위치 미검증`, `300개 확인`, 관련 원부 34번째, 상품 ID 일치 카드와 원본 상품 링크를 재확인했다.
- 광고주 배포 HTML에도 동일 문구·카드 렌더러·페이지 환산 제거·프리미엄 사이드바가 포함된 것을 확인했다.

- 운영 홈에서 실제 집계가 아닌 `12개·4건·3건·2건`, 예시 브랜드 상태, 과거 업데이트 날짜를 제거했다.
- 숫자형 가상 현황 대신 광고주 연결, 운영 입력, 공개 승인, 보고서 관리로 바로 이동하는 작업 카드 4개와 운영 순서를 제공한다.
- 광고주 공개 데이터가 비어 있을 때 `업데이트 완료·검수 완료·공개용`이 표시되지 않고 `공개 준비 중·공개 데이터 연결 대기·데이터 대기`로 전환된다.
- 데이터가 있는 상태에서는 기존 완료·검수·공개 상태와 핵심 수치를 유지하는 회귀 검증을 통과했다.
- 보고서 렌더러가 현재 `reportCenterSynced`를 직접 받아 빈 상태에 기본 월간 보고서가 다시 나타나는 경합을 차단했다.
- 모바일 빈 상태는 KPI 3열·액션 2열로 압축하고 중복 판단 카드를 숨겨 요약 카드 높이를 401px로 줄였다.
- 운영팀·광고주 메뉴 전환 시 `scrollY`가 0으로 복귀해 새 화면이 중간부터 열리지 않는다.
- 1280px·390×844 화면, CTA 이동, 데이터 있음/없음 상태, 가로 넘침, 브라우저 로그를 육안 검수했다.
- 전체 `check:quality`, 서버 13/13, 플레이스 수집기 25/25, Vercel 빌드, Supabase HTTP 200, 필수 환경 검사를 통과했다.
- Supabase 스키마·RLS·Storage·운영 데이터는 변경하거나 삭제하지 않았다.

- `전동칫솔`/`12649811979` 운영 결과와 네이버 공식 API 300개 원문, 실제 입력 상품 페이지를 대조했다.
- 관련 원부 `57907660073`은 33위이고 입력 상품은 판매자 상품ID `12649811979`, API 항목 ID `90194322885`, 173위로 서로 다른 ID 역할을 가진 동일 입력 상품임을 확인했다.
- 실제 입력 페이지 제목, API 제목, 판매처 `라이브오랄스`, 가격 69,000원, 상품번호가 모두 일치해 173위가 다른 업체 상품이라는 오판은 재현되지 않았다.
- 잠재 오판 원인이었던 API `productId` 직접 비교를 제거하고 결과 링크의 판매자 상품ID만 정확 일치에 사용하도록 보강했다.
- 정확 상품을 찾은 뒤에도 300위 선택 범위를 끝까지 확인해 화면의 `173개 확인`을 `300개 확인`으로 정상화했다.
- 임의 중복 제거는 원부 33위를 29위로 변경하는 역효과가 있어 공식 API 노출 슬롯 순서를 유지하도록 제외했다.
- 정확 카드의 `상품 열기`는 입력 원본 `brand.naver.com/lav/products/12649811979`로 유지한다.
- 오판 방지·원부 모드·첫 매치 후 계속 수집 회귀 검사, 전체 `check:quality`, 운영팀·광고주 로컬 실조회와 390px 육안 검증을 통과했다.
- 전체 `check:quality`를 독립적으로 2회 통과하고 네이버 실행환경·Supabase 연결도 정상 확인했다.
- 커밋 `9b82b08`을 `main`에 푸시하고 Production `momentinsight-mmeqlbh43-momentlabs.vercel.app`을 운영 별칭에 반영했다.
- 운영 API와 운영팀 1280px·광고주 390×844에서 원부 33위, 입력 URL 상품 173위, 300개 확인, 원본 상품 링크, 콘솔 오류 0건을 재확인했다.

- 관리자·광고주 상품 노출 카드의 높이, 이미지, 여백, 글자 크기와 그림자를 줄여 한 화면에서 결과를 비교할 수 있는 컴팩트 프리미엄 레이아웃으로 통일했다.
- 관련 원부 배지를 갈색에서 옅은 네이버 민트·그린 톤으로 교체하고 정확 상품의 딥네이비 구분은 유지했다.
- 상품명은 조회 키워드의 네이버 쇼핑 검색 결과로, `상품 열기`는 기존 상품 상세로 연결되도록 링크 역할을 분리했다.
- 두 역할의 링크 목적지와 그린 배지 스타일을 릴리즈 기준선에 추가했고 전체 `check:quality`, Vercel Preview 빌드, `git diff --check`를 통과했다.
- Preview는 네이버 쇼핑 API 환경변수가 없어 실조회가 차단됨을 확인했고, 동일 코드를 환경이 연결된 Production에서 실제 조회로 최종 검증했다.
- 코드 커밋 `b39a77e`를 `main`에 푸시하고 Production `momentinsight-c4ylvfjb4-momentlabs.vercel.app`을 운영 별칭에 반영했다.
- 운영팀·광고주에서 `치아미백제`를 실제 조회해 정확 상품 48위와 관련 원부 7위, 카드 2건을 동일하게 확인했다.
- 두 역할 데스크톱은 카드 높이 127px·이미지 84px, 두 역할 390×844 모바일은 카드 폭 276px·이미지 72px·문서 `scrollWidth=390`이며 콘솔 오류는 0건이다.
- 두 상품명은 키워드 검색 결과로, 두 `상품 열기`는 원부 카탈로그와 정확 상품 상세로 연결되는 것을 운영 DOM에서 확인했다.

- 운영팀과 광고주 사이드바의 메뉴 분류를 `운영 → 키워드·SEO → 순위 조회·추적 → 광고 조사`로 통일했다.
- 광고주 기능과 권한은 유지하면서 두 역할에 동일한 236px 프리미엄 사이드바, 브랜드 마크, 메뉴 hover·active, 인증 패널 스타일을 적용했다.
- 광고주 모바일 메뉴 순서를 같은 정보 구조로 정리하고 공통 쉘 회귀 검사를 릴리즈 기준선에 추가했다.
- 전체 `check:quality`와 Vercel Preview 빌드를 통과했으며, 운영팀 1280px 실화면과 광고주 DOM·계산 CSS·390px 반응형 규칙을 확인했다.
- 커밋 `7a1c19d`를 `main`에 푸시하고 Vercel Production `momentinsight-1eo93tbd5-momentlabs.vercel.app`을 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 광고주 계정으로 데스크톱과 390×844 모바일을 실제 로그인해 사이드바 236px, 모바일 메뉴 가로 스크롤, `scrollWidth=390`, 관리자·광고주 콘솔 오류 0건을 확인했다.
- 라이브 `/health`, 관리자 HTML, 광고주 HTML이 HTTP 200이고 두 화면 모두 `premium-sidebar` 마커를 포함하는 것을 확인했다.
- 이전 개발 이력을 유지하면서 작업명세 기반 연속 개발·충돌 방지 규칙을 `AGENTS.md`와 핵심 운영 문서에 고정했다.
- 작업 전 상태·최근 커밋 확인, 오토세이브, 중복 검색, 기존 diff 보존, 두 관점 검증, 문서 동기화, 논리 단위 커밋 순서를 표준 절차로 확정했다.
- `admin.html`과 `client.html`의 기존 변경 보존 및 양쪽 화면 동시 검증을 명시해 한쪽 수정으로 생기는 회귀를 방지한다.
- 현재 플레이스 작업의 Apify 외부 한도 차단과 배포 대기 상태는 그대로 보존했다.
- `부평 맛집`과 플레이스ID `2019299673`을 운영에서 직접 등록해 세 Actor 모두 Apify 월 사용 한도 초과로 실패하는 원문을 확인했다.
- 대상 URL은 플레이스ID와 상호명 `팽오리농장 부평점`으로 정상 식별됐다.
- 자체 네이버 지도 수집기는 70초 동안 광고 제외 오가닉 54개를 순서대로 확인했고 대상은 확인 범위 안에 없었다.
- Apify 계정 공통 한도 오류는 첫 Actor에서 중단하고 자체 브라우저 수집기로 자동 전환하도록 보강했다.
- Actor 행이 뒤섞여 와도 명시된 `organicRank`, `searchRank`, `rank`, `position` 순서로 정렬한 뒤 오가닉 순위를 다시 매기도록 수정했다.
- 300개 미만 부분조회는 `300위 이내 미노출`로 단정하지 않고 `54위까지 확인 · 이후 미검증`으로 표시한다.
- 수집기 테스트 25개, 플레이스 서버 테스트 9개, 전체 `check:quality`, `git diff --check`를 통과했다.

- 기존 `admin.html`, `client.html`과 시작 시점의 미커밋 변경을 되돌리지 않고 보존했다.
- 판매자 상품 URL을 원부 카탈로그로 자동 승격하던 로직을 제거했다.
- URL 상품ID `5145848584`를 정확 일치 기준으로 고정했다.
- 같은 원부의 다른 상품, 다른 판매자, 광고 결과를 정확 대상에서 제외했다.
- 정확 상품 순위는 판매자 상품ID로 유지하고, 관련 원부는 키워드·브랜드·카테고리 일치 참고 노출로 분리했다.
- 관련 원부 7위와 정확 상품 48위를 이미지·가격·페이지 위치·링크가 포함된 프리미엄 카드 2개로 표시했다.
- 같은 판매처의 무관한 불소 상품과 잘못 연결됐던 카탈로그 `59606749556`은 카드에서 제외했다.
- 관리자·광고주 화면의 기존 동일 판매처 표와 상위 오가닉 표를 간결한 상품 노출 카드로 교체했다.
- 공식 API의 광고 데이터 미제공 사실을 `광고상품 미연결`로 명시했다.
- 데스크톱 1280px와 모바일 390×844에서 카드 겹침·가로 넘침 없이 확인했다.
- 30일 추적 저장 시 URL의 상품ID를 우선 보존하도록 보강했다.
- 전체 품질검사에서 릴리즈 기준선, 서버 문법, 크론, 순위 매칭, 키워드 트렌드, 서버 테스트 12개, 플레이스 수집기 테스트 22개, Vercel 빌드를 통과했다.
- 코드 커밋 `76131b9`를 `main`에 푸시했다.
- Vercel Production 배포 `momentinsight-d7nu7j61r-momentlabs.vercel.app`을 완료하고 `https://insight.momentlabs.co.kr` 별칭 반영을 확인했다.
- 라이브 `/health`, 관리자·광고주 HTML, 상품 순위 API, 데스크톱·390px 모바일 실제 화면을 재검증했다.

## 진행 중인 필수 작업

### 2026-08-02 N 쇼핑 Mac 비의존 수집 전환

- GitHub 서버용 수동 무저장 300위 canary와 KST 09:00·15:00 자동 수집 workflow를 로컬에 구현했다.
- 자동 수집은 repository variable `MI_NAVER_SHOPPING_CLOUD_ENABLED=true` 전까지 완전히 비활성이다. canary 통과 전 secret 등록·DB claim·순위 저장·운영 배포는 진행하지 않았다.
- 300개 완주 검증 후에만 기존 signed endpoint와 원자 commit RPC를 사용한다. 실패·418·CAPTCHA·부분 수집은 claim 전 중단하거나 lease만 해제하고 기존 정상값·30일 이력을 보존한다.
- 기존 `pw-*` Mac 결과와 새 `gh-*` GitHub 결과를 구분하며, 과거 이력은 그대로 보존한다. Mac Chrome은 수동 비상 경로로 유지한다.
- 로컬 headless와 GitHub-hosted Azure `eastus` 무저장 canary가 모두 `naver_http_418`로 차단됐다. GitHub run `30753247124`는 Chromium 설치·기동 성공 후 수집 단계에서 실패했고 DB claim·쓰기는 0건이다.
- GitHub-hosted macOS 15 ARM의 실제 SafariDriver run `30753696199`도 Safari 기동·세션 생성 성공 후 첫 검색 화면에서 `naver_access_blocked`로 실패했다. Azure `westus` 공용 IP였으며 DB claim·쓰기는 0건이다.
- Chromium과 Safari가 모두 차단돼 브라우저가 아닌 GitHub 미국 공용 IP 제약으로 확정했다. `MI_NAVER_SHOPPING_CLOUD_ENABLED`는 미설정 상태로 유지하고 유료 서버·프록시는 대표님 승인 없이 개설하지 않는다.
- 신규 4/4, API·서버 368/368, 플레이스 51/51, 쇼핑 49/49, 공급망·일정·보호 잠금 검사를 통과했다. Production 배포는 하지 않았다.

- 오가닉 카드 작업은 완료됐다. 아래 플레이스 외부 한도 작업은 별도 과제로 유지한다.
- Apify 사용 한도 해제 또는 새 유효 토큰 연결 후 동일 키워드 300개 완주 실조회
- 조건 충족 후 Render 수집기와 Vercel Production 배포, 운영 재검증

## 보류

- Apify 사용 한도 상향은 외부 유료 계정 변경이므로 대표님 계정에서 결제/한도 조정이 필요하다.
- 아이템스카우트처럼 광고 상품 위치까지 표시하려면 공식 쇼핑 검색 API 외에 검증 가능한 별도 데이터 공급자가 필요하다.

## 2026-07-22 의료 플레이스 v18 운영 재시도 보강

- v17 운영 재실행에서도 selector timeout이 재현됐고, Render가 6초 안에 의료 목록 프레임을 연결하지 못했을 때 일반 목록 폴백이 다시 사용되는 것을 확정했다.
- v18은 네이티브 프레임을 최대 20초 기다리고 검색을 한 번 새로 열며, 끝내 네이티브 목록을 얻지 못하면 명시적으로 실패한다. 일반 `place/list`로 의료 순위를 계산하지 않는다.
- 자동 검증은 수집기 49/49, API·서버 154/154, 서버 계약 22/22, Production 인증 18/18과 전체 릴리스 검사를 통과했다.
- 배포 후 두 운영 tracker의 새 snapshot과 정확 ID·source·rankEvidence를 확인하기 전까지 완료로 판정하지 않는다.
- 운영 완료: v18과 Vercel `b7919bc86348` 반영 후 `종로3가한의원` 3위, `종로한의원` 10위를 저장했다. 두 tracker 모두 정확 ID `1531240094`, `source=naver_map_pc_list_collector`, 70개 확인, `retry_count=0`, `last_error=null`, `check_count=1`, `found_count=1`이다.

## 2026-07-22 키워드 시장 경쟁강도 비례 모델

- 검색량과 상품 등록 규모가 함께 큰 대표 키워드를 포화 시장으로, 검색수요 대비 상품 등록이 적은 키워드를 SEO 우선 후보로 분리하는 계산을 적용했다.
- 운영 실조회에서 핵심 카드만 `매우 높음`이고 하단 조회 결과·판단 메모가 검색광고 원본값 `보통`을 표시하던 불일치를 발견해 두 역할 화면과 SEO 판단을 종합값으로 통일했다.
- 연관 키워드 표는 해당 키워드별 쇼핑 상품수를 추가 조회하지 않으므로 검색광고 원본 경쟁도를 그대로 유지한다.
- 1차 단위·역할·보호 잠금 검사와 2차 전체 릴리스 검사를 모두 통과했다. CSP는 변경된 두 역할 스크립트의 신규 SHA-256 해시로 교체하고 공개 빌드 검사를 재통과했다.
- 커밋 `c380eb7`을 원격 `main`에 푸시하고 Production `momentinsight-cxwj85zkx-momentlabs.vercel.app`·운영 별칭에 반영했다.
- 라이브 `/health`·`/ready`는 릴리스 `c380eb7622c1`과 Supabase ready를 반환했다. 관리자·광고주 HTML 200, 비인증 키워드 API 401을 확인했다.
- 운영 총관리자 실조회에서 `써큘레이터` 검색 수요 97, 종합 경쟁강도 83 `매우 높음`, 판매 기회율 69 `높음`, 조회 결과 `71,400 · 매우 높음`, 대표 포화 키워드 추천, 상품수 348,978개 판단 문구가 모두 일치했다.

## 2026-08-09 N 쇼핑 가격비교 수집 안정화 v1.0.11

- Chrome 업데이트 후 `search.shopping.naver.com/search/all` 가격비교 화면이 정상 표시되는 것을 확인했다.
- 수동 갱신은 1페이지를 읽은 뒤 2페이지에서 `naver_network_restricted`로 중단됐다. 300개 미완주 결과는 저장하지 않았고 기존 정상 순위와 30일 이력은 유지했다.
- 네이버 제한 상태에서 반복 호출하지 않도록 첫 요청을 30~45초 지연하고 페이지 간격을 45~75초로 늘렸다. 자동 보충은 10분에서 30분으로 낮추고 한 회차 1개 키워드 순차 처리를 유지한다.
- 확장 프로그램 버전은 `1.0.11`이며 가격비교 8페이지·광고 제외·정확 300개·원자 저장 계약과 관리자·광고주 화면은 변경하지 않았다.
- API·서버 393/393, 플레이스 51/51, 쇼핑 51/51, 네이티브 호스트 12/12, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·58파일·14마이그레이션 및 전체 `npm run check:release`를 통과했다.
- Production gate는 최근 광고 제외 오가닉 300개 원자 수집 증거와 공식 상단 실응답을 확인해 통과했다. 코드 `c29b381`을 GitHub `main`과 Vercel Production `dpl_DottuAAAw2adGYwBTC1xAvK1xxps`·운영 별칭에 반영했다.
- 운영 `/health`·`/ready`는 릴리스 `c29b3812dd8f`, 서울 `icn1`, Supabase ready를 반환했다. Production 반영 뒤 Mac 브리지를 재설치해 소스·네이티브 호스트·스케줄러를 동기화했다.
- 현재 열린 가격비교 탭의 네이버 네트워크 제한은 별도 외부 상태다. 제한 중에는 자동 재시도와 부분 저장을 하지 않으며 마지막 정상 순위와 30일 이력을 유지한다.

## 2026-08-09 N 쇼핑 중앙 Chrome 개발 프로필 전환

- 중앙 수집 전용 Chrome 프로필을 기존 `동빈(Default)`에서 `동빈(개발)`의 내부 디렉터리 `Profile 5`로 전환했다.
- Mac 브리지와 `co.kr.momentinsight.naver-shopping-chrome-scheduler`를 다시 설치해 10분 준비 실행과 08:50·14:50 Chrome 준비가 `Profile 5`를 열도록 맞췄다.
- `동빈(개발)` 프로필에 `Moment Insight N Shopping Rank` 1.0.11을 압축해제 확장으로 로드·활성화·툴바 고정하고 팝업의 `자동 갱신 준비 완료`를 확인했다. 수동 `지금 안전 갱신`은 실행하지 않았다.
- 중복 수집 방지를 위해 기존 `동빈(Default)` 프로필의 같은 확장은 한 번 비활성화해야 한다. Chrome 내부 보안 화면은 자동 제어가 차단돼 해당 비활성화 완료 증거는 아직 없다.

## 2026-08-09 동빈 → 개발 프로필 원격 갱신 v1.0.12

- 상태: 구현·보안 기준·전체 릴리스 검증 완료 / Supabase·Production·Mac 재설치 승인 대기.
- 동빈 프로필의 N 상품 단건·전체 갱신과 300위 조회가 서버의 단일 원격 신호를 요청하도록 연결했다.
- `동빈(개발)`의 `Profile 5` 확장 프로그램은 1분마다 신호만 확인하고, 신호가 있을 때 최대 1개 대기 작업만 실행한다. 신호가 없으면 네이버 페이지를 열지 않는다.
- 원격 신호는 한 행에 합쳐 중복 대기열을 만들지 않으며, 남은 순위는 기존 30분 catch-up과 09:00·15:00 일정으로 안전하게 순차 처리한다.
- 신호 테이블은 RLS를 강제하고 `anon`·`authenticated` 접근을 제거했다. RPC는 `security invoker`와 `service_role` 실행 권한만 사용한다.
- 관리자·광고주 양 화면에 `개발 프로필 원격 실행 요청·약 1분 내 첫 작업·나머지 안전 간격` 안내를 동일하게 적용했다.
- 확장 프로그램은 `1.0.12`, 보호 잠금은 22함수·60파일·15마이그레이션으로 갱신했다.
- 전체 `npm run check:release`, API·서버 397/397, 플레이스 51/51, 쇼핑 51/51, 서버 계약 38/38, Production 인증 18/18, 공개 빌드·CSP, `git diff --check`를 통과했다.
- 아직 Supabase 마이그레이션 적용, Production 배포, Profile 5 브리지·확장 재설치, 동빈 프로필 실클릭 검증은 하지 않았다.

## 2026-08-09 N 쇼핑 접속 제한 자동 복구 v1.0.13

- 상태: 안전 복구 구현·전체 회귀·Supabase·Production·Profile 5 배포 완료 / 첫 자동 재시도 운영 관찰.
- 네이버 `쇼핑 서비스 접속이 일시적으로 제한되었습니다`, HTTP 418·429를 감지하면 진행 중인 수집을 즉시 멈추고 미완주 결과를 저장하지 않는다.
- 접속 제한 재시도는 `2시간 → 6시간 → 12시간 → 24시간` 단계로 늘리며, 대기 중에는 열린 제한 탭의 문구만 1분 단위로 확인하고 새로고침·검색 요청을 만들지 않는다.
- 제한 시간이 끝나면 제한 탭을 닫고 대기열의 1건만 `rank-recovery`로 재시도한다. 다시 제한되면 다음 단계로 이동하고, 성공하면 재시도 횟수를 초기화한다.
- CAPTCHA·보안확인은 자동 풀이·우회하지 않는다. 사용자가 열린 탭에서 확인을 마쳐 정상 가격비교 화면이 되면 1분 내 감지해 별도 클릭 없이 대기 작업 1건을 재개한다.
- 확장 팝업에는 다음 자동 재시도 시각을 표시한다. 기존 `1.0.12`의 수동 재개 대기 상태도 업데이트 후 첫 2시간 보호 대기로 자동 전환한다.
- 네이티브 호스트·로컬 워커 집중 회귀 32/32, API·서버 397/397, 플레이스 51/51, 쇼핑 51/51, 서버 계약 38/38, Production 인증 18/18과 전체 `npm run check:release`를 통과했다.
- Supabase 운영 마이그레이션 `20260809115100_naver_shopping_worker_remote_wake`를 적용했다. 테이블은 RLS·FORCE RLS, 익명·로그인 권한 없음, 두 RPC는 `security invoker`·`service_role` 전용이며 롤백 검증 뒤 wake 행은 0건이다.
- 코드 `062ba59`를 GitHub `main`과 Vercel Production `dpl_R1YAvtYrTgfqHJ1jAuDFQ3GaPRDX`·운영 별칭에 반영했다. `/health`·`/ready`는 릴리스 `062ba5935d15`, 서울 `icn1`, Supabase ready다.
- Mac 브리지의 14개 보호 런타임 파일을 같은 소스로 재설치했고 Chrome 준비 스케줄은 `Profile 5`, 10분·08:50·14:50으로 확인했다.
- `동빈(개발)` 확장 `1.0.13` 활성·재로드와 `2026-08-09 22:56:10 KST 이후 1건 자동 재시도` 표시를 확인했다. 기존 `동빈(Default)`의 같은 확장은 `사용 안함`으로 확인돼 중복 실행하지 않는다.
- 네이버 제한을 반복 호출하지 않기 위해 원격 전체 갱신과 새 300개 실수집은 실행하지 않았다. 마지막 정상 순위와 30일 이력은 유지한다.
### 2026-08-10 Windows native host 시작 확인 v1.0.21

- Windows 실기에서 `rank-remote → native_host_start_timeout`이 1분마다 반복되고 launcher 등록·manifest·exe는 정상임을 확인했습니다. native host가 서버 작업을 조회하는 동안 첫 메시지가 없어 확장이 30초 뒤 정상 프로세스를 끊는 것이 원인이었습니다.
- native host는 실행 요청을 검증한 즉시 `ready`를 응답합니다. Windows 안전 업데이터는 확장·launcher뿐 아니라 `naver-shopping-native-host.mjs`도 원자적으로 내려받아 문법 검사 후 교체하고 SHA-256을 출력합니다.

### 2026-08-10 Windows native host 양방향 준비 확인 v1.0.22

- Windows 첫 실수집은 작업 임대 후 `native_host_response_timeout`으로 실패했고, 부분 결과는 저장하지 않은 채 마지막 정상 순위를 유지했습니다.
- `ready` 직후 확장이 `ready_ack`를 회신해야 서버 작업을 청구하도록 양방향 준비 확인을 추가했습니다. 첫 메시지만 전달되고 후속 수집 메시지가 누락되는 상태를 30초 안에 실패 처리합니다.
- 대상 회귀 17/17, 서버 계약 39/39, 보호 잠금 self-test, 전체 `npm run check:release`와 `git diff --check`를 통과했습니다.
