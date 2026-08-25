# Next Actions

기준일: 2026-08-25

## 진행 중: N쇼핑 v1.1.13 안정화·5차 6분 실측

1. 완료: candidate8은 장기 상한 7.5그룹/시간이라 기존 8.75~8.77을 넘을 수 없음을 확인했고 활성화 대상에서 제외했습니다. 같은 단일 lane·maxJobs1 계약에서 가능한 최소 정수 우회안은 candidate6(이론 상한10)입니다.
2. 완료: manifest/runtime을 1.1.13, candidate exact 응답을 6분으로 바꾸고, signed `runTrigger`를 Chrome→native→local worker→server RPC까지 전달했습니다. 실제 job이 `navigating`에 진입한 run만 별도 service-role 전용 provenance 표에 append하며 remote 무작업 poll은 기록하지 않습니다.
3. 완료: 정확한 13파일 fingerprint는 `cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6`입니다. N30 집중 340/340, server contract71/71, release baseline PASS, Production auth18/18, 보호 lock 23함수·102파일·50migration 및 self-test가 통과했습니다.
4. 확인: `npm audit --omit=dev`는 기존 `pptxgenjs@4.0.1 → image-size@1.2.1`의 high DoS 권고 2건으로 exit1입니다. N30 실행 경로의 신규 의존성은 아니며 자동 수정은 breaking downgrade라 이번 범위에서 강제 적용하지 않습니다. 이를 보안 무결점으로 보고하지 않습니다.
5. 완료: 독립 감사의 migration lock-order P1과 provenance 보호 잠금 공백을 보완했고 재감사 P0/P1 blocker0, 전체 `check:release` core1071/place51/shopping64/auth18, 최종 diff-check를 통과했습니다. main `4fcba2a953b6`와 N30-only release `c3e809d67844`를 push했으며 data/drafts는 포함하지 않았습니다.
6. 완료: N30-only release를 Production `dpl_C9spGKA1VA7z15Ny2A3ZCizzNgkN`에 함수11개로 반영하고 health/ready를 확인했습니다. 운영 migration의 실제 compile·ACL·RLS·advisor와 Windows 관리자 updater exit0·runtime1.1.13 exact fingerprint heartbeat까지 확인했습니다. main 전체는 Vercel 함수12개 제한 때문에 배포 불가능하므로 사용하지 않았습니다.
7. 진행: DB anchor는 `2026-08-24T17:58:36.220664Z`로 유지됐습니다. 잔여 `12f5330a…`는 자연 순번에서 `provider_partial_window:137_300`으로 snapshot0·last-good 보존·24시간 격리됐고 cycle37은 중복0으로 완료됐습니다. 후속 cycle38도 정상 진행해 현재 provenance76(catch-up60·remote15·rank-0900 1), streak75입니다. 최신 catch-up `8e5cfb4f…`의 group/tracker/commit 각1과 snapshot1은 official organic/adExcluded atomic300·excluded60이고 cycle38 누적 group14·tracker/commit18에서 cursor 위반·same-cycle 중복·atomic invalid·open/incomplete·overlap·lane 위반0입니다. remote15·rank-0900 1·typed failure는 향후 성능 분자에서 제외합니다. 성공6회 조건은 충족했지만 anchor+24시간이 아직 false라 candidate_eligible=false입니다. 가장 이른 candidate 판정은 `2026-08-25T17:58:36.220664Z` 이후이며 그 시각에도 exact identity·fresh heartbeat·recent atomic300·closed/null·processing0·완전 idle을 다시 확인하기 전에는 setter를 호출하지 않습니다.
8. 대기: candidate6·baseline setter, coordination row-lock, 최종 exact post-state 판정식은 Production read-only `EXPLAIN/WHERE false`로 compile했고 marker는 `setter_called=false`·post baseline10·idle을 반환했습니다. 모든 gate가 참이고 이 목표의 시도 이력이 0회일 때만 같은 canonical template으로 setter를 정확히 1회 호출해 raw exact candidate/6과 같은 transaction의 post-state/idle을 캡처합니다. 단, 필수 120분 측정창 안에 알려진 residual partial 격리 만료가 예정돼 있으면 그 자연 terminal 결과와 post-idle을 먼저 확인해 이미 예견된 failure로 측정을 오염시키지 않습니다. timeout·응답 유실·불확실이면 재호출0·성공0입니다.
9. 대기: 전환 뒤 fixed-wall 120분 이상·bootstrap 제외 provenance `rank-catch-up` fully-terminal distinct group18개 이상으로 exact runtime/fingerprint/worker, run당 group1, 360초 grid, atomic300·중복0·순서·lane 해제·concurrency1을 확인합니다. signed provenance는 신뢰된 배포 워커의 운영 증거이며 침해된 signer/service-role에 대한 외부 증명은 아닙니다. 출처 누락·불일치 또는 실제 처리량 8.77 이하이면 canonical baseline10 1회 복귀·성공0입니다.

## 완료된 기반: N쇼핑 v1.1.10 partial 재수집·input-close 복구

1. 완료: 보호 잠금·self-test·전체 `check:release`를 통과했고 정확한 N30 변경만 commit `628e4ae0b2a9`로 push·Production 반영했습니다. `data/`와 다른 사용자 작업은 포함하지 않았습니다.
2. 완료: 운영 lane·processing 0을 확인하고 overflow→transient recovery→runtime 1.1.9 migration을 적용했습니다. Production health/ready와 Windows updater가 같은 SHA·version이며 exact runtime fingerprint가 일치합니다.
3. 완료: 기준 이후 별도 wake 요청이 없던 `normal` collection `pw-chrome-1787291671198-58f940f60934ff318d08`이 광고 30개 제외·checked300으로 저장됐고 circuit closed·cadence10·lane/lease 해제를 확인했습니다. ledger에는 알람 trigger명이 없으므로 trigger 종류 자체는 단정하지 않습니다. 새 24시간 안정성 시작점은 2026-08-21 14:54:31 KST입니다.
4. 완료(로컬): `native_host_input_closed`를 정확히 30분·최대2회 bounded half-open 대상으로 추가하고, 첫 `provider_partial_window`는 첫 pass를 폐기한 뒤 같은 deadline·16페이지 한도에서 full1..8을 딱 한 번 재수집하도록 v1.1.10을 구현했습니다. double-partial/overlap은 부분 저장·세 번째 pass 없이 fail-closed합니다.
5. 완료: exact clean commit `cdcd6c2c21e6`, Production health/ready, 170000→180000 migration, Windows 1.1.10 updater와 exact fingerprint를 확인했습니다. 첫 자연 run도 checked300·광고 제외·lane/lease 해제로 종료했습니다.
6. 완료: 과거 `native_host_input_closed` tracker가 cycle #28의 정상 cursor 순서에서 자연 재진입해 checked300·광고 제외 commit, 오류/retry 해제, lane/lease 반환까지 완료했습니다. 연속 2회 circuit-open 뒤 half-open은 인위적으로 장애를 만들지 않아 실운영 미확인으로 남깁니다.
7. 당시 진행 기록(폐기): v1.1.10 첫 atomic300 성공(2026-08-21 22:32:47 KST)부터 24시간+6회 proof를 관측했고, 2026-08-22 00:01:52 KST에는 streak16·경과1.47시간이었습니다. 당시 계획했던 candidate8 전환은 이후 상한 계산에서 목표 8.75~8.77을 넘을 수 없음이 확정되어 실행 대상에서 제외됐으며, 현재 실행 계약은 위 candidate6 항목만 유효합니다.
8. 당시 실패 계약은 baseline10 복귀·새 proof 초기화·last-good 보존이었고, 현재 candidate6에도 더 엄격한 단일 시도·120분 failure0 계약으로 이어집니다.

## 완료: N쇼핑 30일 추적 비활성 재발 방지

1. 완료: 운영 SELECT-only로 전역 작업기 정상 생존과 과거 진단용 paused 고아 1건을 분리했습니다. 자동 오류·격리나 cycle 정지는 현재 원인이 아닙니다.
2. 완료: Windows updater의 잘못된 native-host 이름을 canonical `co.kr.momentinsight.naver_shopping`으로 통일하고 RED/GREEN·전체 release·보호 잠금을 통과했습니다.
3. 완료: 동일 target 재등록 시 신규 행 없이 기존 paused ID만 안전하게 active로 복구하고 순서·격리·cycle 값을 보존하는 회귀를 추가했습니다.
4. 완료: commit `19756f2`·Production health/ready, 정확한 paused 1건의 status-only 복구, 자연 claim 1회·광고 제외 atomic300·오류 해제·lane/lease 해제·cursor 불변을 확인했습니다.
5. 완료: Windows 관리자 updater가 canonical registry·loaded extension·runtime fingerprint 동기화 성공을 반환했고, 재시작 후 첫 자연 작업도 광고 제외 atomic300으로 commit된 뒤 lane·lease를 해제했습니다. paused tracker는 0입니다.

## 완료: 매월 반복 종료 방식

1. 완료: 월 반복 ON 시 `종료 예정 없음`과 유한 `반복 종료일 · 포함`을 선택하도록 분리했습니다. 유한 모드는 종료일 필수, no-end 모드는 종료일 비활성입니다.
2. 완료: no-end 의도를 DB에 보존하고 향후 60회를 서울 날짜 기준으로 원자 생성합니다. strict 입력·중복 방지·tenant·낙관적 잠금은 유지합니다.
3. 완료: 운영 migration, 전체 release gate, Production `a086666f62ae`, 로그인된 총관리자 UI 상태 전환을 확인했습니다. 운영 일정은 검증용으로 저장하지 않았습니다.
4. 후속 결정: 60회 이후도 자동 연장되는 문자 그대로의 무기한 반복은 아직 아닙니다. 필요하면 별도 series master·생성 horizon·중단 API를 설계·승인한 뒤 추가합니다.

## 완료: 대표실 개인 일정표 전환

1. 완료: 왼쪽 일정표 목록·색상·공유 권한·초대 코드·코드 연결 UI와 API 쓰기 경로를 비활성화하고 개인 일정 등록 패널과 월간 반복을 유지했습니다.
2. 완료: 대상 73/73, `work-items.mjs` branch 83.28%, 전체 `check:release`, 역할 parity, Production auth, 공개 build/CSP, N30 보호 잠금을 통과했습니다.
3. 완료: 운영 Supabase를 SELECT-only로 확인해 공유 calendar/member/invite/event 0행과 개인 일정 2행 보존을 확인했습니다. 적용된 migration·빈 공유 테이블은 삭제하지 않습니다.
4. 완료: 기능 commit `5ee9907`을 Production에 배포하고 `/health`·`/ready`의 release `5ee99078a22c`와 Supabase ready를 확인했습니다.
5. 완료: 로그인된 총관리자 대표실에서 2열 달력, 공유 UI 0, 날짜/추가 클릭 등록 패널, 매월 반복·광고주 공개 유지, calendar selector 0, console 오류 0을 확인했습니다. 실제 일정은 임의 생성하지 않았습니다.
6. 유지: N상품·N플레이스 30일 코드·migration·작업기·순위 이력은 이번 일정표 작업에서 수정하지 않습니다.

## 동결: N 상품·N 플레이스 30일 추적

- 대표님의 별도 수정 요청 전까지 30일 추적 코드·수집기·작업기·스케줄러·DB migration을 변경하지 않습니다. 다른 기능 작업은 이 잠금을 통과해야 하며 자연 순환과 기존 기능 사용은 계속됩니다.

## 완료: N쇼핑 `probe_incomplete` 영구정지 복구

- typed navigation failure가 `probe_incomplete`·`probe_interrupted`로 바뀌어도 10분 quiet period 뒤 primary worker가 정확히 한 ordered half-open 회차를 수행합니다. 반복 실패는 다시 10분 대기하며 순서·격리·wake·cursor는 변경하지 않습니다.
- Production `426637d6b6fa`와 DB migration 반영 뒤 자연 scheduler가 half-open→closed로 회복했고, 다음 normal 순서에서 광고 제외 원자 300 commit·cursor 전진·lane/lease 해제를 확인했습니다. 별도 24시간 공정 순환 검증은 계속합니다.
- 총관리자 자비스 완료 surface는 보호 잠금에 추가했습니다. 순위 핵심 기능과 자비스는 이후 별도 명시 승인 없이 수정하지 않습니다.

## 진행 중: `mml93-a01` 실장 운영 비서 canary (구 자비스)

- 호칭을 실장으로 전환하고 "○○ 완료로 해줘" 완료 명령, "브리핑 해줘" 브리핑 명령, 상시 호출 대기 토글(localStorage 기억·탭 숨김 대기·이탈 정지·권한 거부 자동 OFF)까지 반영했습니다(owner-tool 11/11·work-items 15/15·전체 release gate 통과, 보호 잠금 대표 지시로 갱신). 다음 실화면 확인 3단계: ① 상시 호출 버튼 1회 ON ② "실장님, 브리핑 해줘" 즉시 실행 ③ 새로고침 후 버튼 없이 같은 호출 자동 재개. 추가로 완료 명령 1건 실사용과 새로고침 보존을 확인합니다.
- 브리핑 우선 업무 목록에 완료 버튼을 연결해 확인창 승인 뒤 `assistant-complete` 낙관적 잠금 완료 처리와 감사 로그 기록까지 검증했습니다(테스트 15/15·전체 release gate 통과). 다음은 로그인된 운영 owner 화면에서 브리핑 완료 처리 1건과 새로고침 보존을 직접 확인하는 것입니다.

- 정적 조직 카드 보완은 완료로 보지 않고, 원본의 대표 방문·담당자 회의·자리 복귀를 모먼트 인사이트 비서실 운영실로 재구현했습니다. exact owner 화면이 활성일 때만 움직이고 이탈·로그아웃 시 정지하며, 독립 AI 실행으로 오해하지 않도록 화면 시각화임을 명시합니다.
- 로컬 데스크톱·390px 모바일 실제 렌더와 이동·대화·복귀·담당자 클릭·가로 넘침·console 0을 확인하고 기능 commit `7b7f6c5ee44a`를 exact `mml93-a01` 범위로 Production 반영했습니다. 다음은 로그인된 운영 owner 화면에서 동일 동작을 직접 확인하는 것입니다.
- 원본 전체 대조로 누락을 인정하고, 조직도·담당 카드·탭 음성입력·30초 호출대기·브리핑 읽기를 exact owner 전용으로 로컬 보완했습니다. 로컬 Claude CLI·shell·vault·예시 매출 기능은 SaaS 권한 경계를 넘으므로 제외합니다.
- 조직·음성 보완 commit `df4089405a77`을 대표님 승인에 따라 Production에 반영했습니다. 서버는 정확한 `mml93-a01` 총관리자에게만 payload를 전달하며 운영팀·광고주·다른 총관리자·로그아웃 정적 화면에는 비서 DOM을 전달하지 않습니다.
- Production `/health`·`/ready`의 `df4089405a77` 일치, Supabase ready, `/admin`·`/client` 200, 비인증 `/api/owner/tool` 401, 정적 owner-assistant DOM 0, `microphone=(self)`·`camera=()` 헤더를 확인했습니다. 다음은 `mml93-a01` 실세션에서 조직 렌더·마이크 허용·30초 종료·브리핑 읽기·내부 일정 1건 저장/새로고침 보존을 확인합니다.
- 운영팀·광고주 전체 공개와 Google Calendar 연동은 이번 배포에 포함하지 않습니다. canary 사용 중 tenant 범위·중복 저장·공개 전환·일정 해석 이상이 없는 근거를 확보한 뒤 별도 승인으로 확대합니다.

## 진행 중: N쇼핑 v1.1.8 안정 중복 증명·24시간 재검증

- 기능 release `68e6200ad826`, DB runtime gate와 Windows 실행 모듈을 `1.1.8`로 동기화했습니다. 증거 문서 커밋은 자동 Production 배포로 `/health` release를 이동시킬 수 있으므로 기능 식별은 Windows fingerprint `182cc973be96…`과 기능 커밋으로 고정하며, 첫 자연 작업은 광고 30개 제외·오가닉 300개로 완료됐습니다.
- 복구 terminal 기준은 2026-08-14 18:17:51 KST입니다. 2026-08-15 18:17:51 KST 전에는 cycle당 1회·신규 우선 후 cursor 복귀·전체 완료 뒤 다음 cycle·격리 skip·중복 0·원자 300만 저장을 최종 합격으로 판정하지 않습니다.
- cycle #9은 10:40 KST 완료됐습니다. 시작 roster 57 group/72 tracker/9 agency 중 시작 시 격리 1 tracker를 건너뛰고 56 group/71 tracker를 각 1회 claim했으며 group 중복은 0입니다. 성공 31 group/42 snapshot/31 collection은 모두 광고 제외 `checkedCount=300`이고, 실패 25 group은 snapshot을 저장하지 않았습니다.
- 미갱신의 직접 원인은 실패 25 group 중 23 group을 차지한 cross-page `page_overlap`입니다. `1.1.8`은 이를 행 삭제·순위 압축으로 숨기지 않고, 독립 전체 1~8페이지 두 번의 300개 절대 순위·강한 식별자 digest가 완전히 같을 때만 저장합니다. 한 슬롯이라도 다르면 기존처럼 fail-closed합니다.
- 검증된 stable proof는 snapshot·ledger에 버전명만 남기며 capture ID와 digest는 저장하지 않습니다. 증명 실패는 해당 tracker만 30분 격리하고 global circuit과 다음 순환은 계속합니다.
- `provider_partial_window`는 tracker 단위로 격리해 한 키워드의 300 미달이 전체 광고주 circuit을 열지 않게 합니다. 실제 300 미달 키워드는 last-good을 유지하며 성공으로 표시하지 않습니다.
- scheduler event ledger와 malformed-row 범위·시계오차·request ID·4MiB 상한·부분 submit 보완은 Production에 반영됐습니다. cycle #8 완료→#9 시작, 신규 1회 우선→cursor 복귀를 장부로 확인했습니다.
- 11:31 KST 과거 격리 대상의 자연 재진입에서 첫 `stable-full-window-v1` 성공이 확인됐습니다. collection `pw-chrome-1786761092364-8d83d6311c99da4190d7`은 광고 60개 제외·오가닉 300개를 저장하고 격리를 해제했으며 lane·lease도 null입니다. 단일 성공만으로 전체 page-overlap 정상화를 판정하지 않고 후속 자연 재진입과 24시간 오류 잔존을 계속 확인합니다.
- 24시간 종료 시점에는 cycle당 1회·신규 우선 후 cursor 복귀·전체 완료 뒤 다음 cycle·격리 skip·중복 0·atomic300만 저장과 오류 잔존을 다시 판정합니다. 강제 wake·격리 해제·cursor 변경은 하지 않습니다.

## 완료: N쇼핑 중복 오류 장기 격리 해소

- 중복 식별 오류만 누적 24시간 격리에서 30분 고정으로 바꾸고 기존 격리를 같은 상한으로 단축합니다. 정상 순환 순서와 last-good은 유지합니다.
- Production `1c778c655d2b`와 DB migration을 반영해 활성 격리가 19건에서 3건으로 감소했습니다. 과거 격리 대상 `침구청소기`가 신규 우선 작업 뒤 원래 sort 2100 순서로 재진입했고, 실제 중복은 30분 fail-closed·last-good 보존·lane/lease 해제로 유한 종료했습니다.

## 완료: N쇼핑 상품 식별 중복 전역 보완·두 건 1회 복구

- v1.1.3 실기에서 `남자 사각팬티`는 오가닉 300개·17위로 복구됐지만, `남성 사각팬티`는 7→8페이지 overlap이 제한된 suffix 2회에도 재현돼 last-good 23위를 보존하고 유한 종료했습니다. 정상 durable cycle은 즉시 다음 cursor로 복귀했습니다.
- v1.1.4는 전체 8페이지 뒤 충돌 suffix를 총 페이지 이동 16 이내에서 최대 4회 허용합니다. 매번 전체 1~300을 재검증하고 행 삭제·순위 압축은 하지 않으며, `range-v1` 실행 프로토콜이 일치하지 않으면 claim 전에 종료합니다.
- Production·DB·Windows를 1.1.4로 일치시킨 뒤 남은 `남성 사각팬티`만 복구 큐로 정확히 1회 검증했고 기존 durable cycle cursor 복귀를 확인했습니다.
- 각 항목의 합격 기준은 새 `pw-chrome-*`, 광고 제외 `checkedCount=300`, 오류·격리 해제, lane·lease 해제입니다. 실패 시 상세 typed code를 기록하고 같은 복구 요청을 반복하지 않습니다.
- 다른 duplicate 대상은 수정된 공통 규칙으로 자연 순환에서 확인하며 일괄 강제 갱신이나 격리 해제를 하지 않습니다.

## 진행 중: N쇼핑 30일 영속 순환 운영 증명

- DB migration, Production `074c3a25d644`, Windows `074c3a2`, 전체 release 검사를 완료했습니다.
- 첫 cycle의 서로 다른 keyword group 4개·tracker 7건은 재선택 없이 원자 300개 terminal과 lane·lease 해제를 확인했습니다. 실제 신규 1건 뒤 저장 cursor 복귀와 cycle 전체 중복 0은 계속 관측합니다.
- 24시간 전체 완주율은 한 번의 성공으로 대신하지 않고 별도 관측합니다. 5차 속도 향상은 계속 보류합니다.

## 완료: 키워드 연령별 쇼핑 클릭 비중 복구

- 첫 Production 배포는 운영 서버의 모바일 쇼핑 표본 수집 실패 때문에 월 검색량은 표시됐지만 연령 그래프가 `조회 후 표시`에 머물렀습니다. 이 상태를 정상으로 보고하지 않습니다.
- 키워드 handler 안에서만 공식 Shopping Insight 대분류 10개를 fail-closed로 검사하고, 단일 강한 후보가 확인될 때 기존 5개 세로 막대그래프에 최신 완료 월 비중을 표시합니다.
- N 30일 순위, Windows 수집기, DB, 그래프 UI와 공유 mobile fallback parser는 변경하지 않았습니다. 전체 릴리스와 Production `d2a087a54562` 배포를 통과했고, 총관리자 화면에서 `남자팬티` 연령 막대 5개를 실검증했습니다.

## 변경 금지: 30일 추적

- 2026-08-13 사용자가 승인한 N상품 중복 식별·두 건 유한 복구 범위만 예외로 수행합니다. 이 배포와 검증이 끝나면 N 상품·N 플레이스 30일 추적, Windows 작업기·스케줄러, 순위 DB·이력 로직은 다시 명시적 요청 전까지 동결합니다.
- 배포 전 30일 원본은 `checkpoint/n30-frozen-20260812-d0f5033`, 배포 후 정상 기준은 `checkpoint/keyword-age-click-share-production-20260812`로 저장합니다. 문제 시 DB를 삭제하지 않고 태그를 별도 worktree에서 검증해 코드만 비파괴적으로 회귀합니다.

## 완료: 키워드 조회 공개·N 상품 단건 숨김

- 키워드 조회는 Production 공식 API 환경과 `남자팬티` 실조회로 월 검색량 30,770·검색 추이 37구간·연관 키워드 10개를 확인해 `(개발중)` 표기를 제거했습니다.
- `N 상품 순위` 단건은 관리자·광고주·모바일 메뉴와 화면에서 제거하고 직접 hash 접근도 기본 화면으로 되돌립니다. N 30일 자동 추적은 유지합니다.
- 전체 릴리스·CSP·역할 회귀를 통과한 commit `a035a87f3854`를 Production에 반영했습니다. 운영 총관리자 실조회·구형 hash fallback·콘솔 오류 0건을 확인했고 정적 배포 계약으로 광고주 화면도 동일 정책을 검증했습니다.

## 다음: 전체 품질 고도화 2차

- UI/UX: 세션 복원 중 로그인 화면이 잠깐 노출되는 경계를 중립 로딩 상태로 분리하고, 운영 홈 조회 실패에 1회 재시도 동작을 제공합니다. 과거 미완료 일정은 `다음 일정`이 아니라 지연/확인 필요로 구분합니다.
- 인증: 공개 식별 코드와 로그인 비밀을 분리하고 해시·회전 정책을 적용하며, 서버 session ledger로 로그아웃 즉시 폐기와 cookie replay 차단을 설계합니다. 이는 DB migration·기존 로그인 호환성 영향 보고와 승인 전에는 적용하지 않습니다.
- Supabase: `profiles`·`client_members`의 RLS initplan 2건과 중복 permissive SELECT 정책을 권한 매트릭스 회귀와 함께 최적화합니다. advisor의 unused index만 보고 삭제하지 않습니다.
- 실행 제한: 아래 `준비작업 1번`과 5차 속도 향상은 기존 사용자 gate를 유지하며 이번 일반 품질 작업으로 자동 시작하지 않습니다.

## 완료: N플레이스 30일 기록 지표 진실성 정리

- 일별 카드에서 장소별·일별 의미가 아닌 `월검색`과 수집 행 수인 `업체`를 제거했습니다.
- 블로그·방문자 리뷰는 대상 플레이스 direct 값만 표시하며 검색결과 전체 합계를 사용하지 않습니다. 값이 없으면 추정하지 않고 `-`로 표시합니다.
- 순위·직전 대비·검증 상태·오가닉 근거를 중심으로 premium compact 카드와 30일 전체 이미지 내보내기를 적용했습니다.
- 수집기·DB·스케줄은 변경하지 않아 기존 플레이스 순위 자동 수집 계약을 유지합니다.

## 완료: 총관리자 전용 `개발 </>` 영역 분리

- `N 30일 순위` 안의 수집 운영센터를 제거하고 사이드바 하단의 별도 `개발 </>` 그룹과 `N 쇼핑 수집 운영` 화면으로 분리했습니다.
- 메뉴·화면·운영 패널은 정적 HTML에 두지 않습니다. 서버가 정확한 총관리자 `mml93-a01` 세션을 검증한 뒤에만 DOM을 생성하며, 운영팀·광고주·로그아웃 상태와 위조된 owner hash에서는 생성하지 않습니다.
- 기존 부가세 계산기는 같은 총관리자 전용 개발 그룹의 별도 화면으로 유지합니다.
- N쇼핑 수집 경로·DB·Windows runtime·baseline 10분·원자 300개 계약은 변경하지 않았습니다.
- Production `6a1076899183`에서 실제 `mml93-a01` owner 전용 메뉴·화면·운영 지표 표시, N30 내부 운영 패널 0개와 가로 넘침 0을 확인했습니다.

## 완료: v1.1.1 자동 순환 연속성 복구

- 1분 원격 신호와 10분 전체 순환 알람이 겹칠 때 전체 순환 신호가 사라지지 않도록 단일 우선순위 대기 신호로 인계합니다.
- 신규·미검증 키워드는 첫 슬롯에서 처리하고, 이후 기존 키워드는 결정적 순서와 광고주 공정성으로 계속 순환합니다.
- 정상 closed 순환의 `provider_duplicate_identity`는 해당 tracker만 격리하고 다음 키워드를 계속 처리합니다. half-open 단독 canary 실패는 안전 원칙대로 circuit을 다시 open하며, 보안·네트워크 제한은 즉시 전역 중단을 유지합니다.
- baseline 10분·동시 실행 1개·직접 1~8페이지·광고 제외 원자 300개·last-good 보존은 변경하지 않습니다.
- 완료 조건: 전체 release 검사, DB migration, Production·Windows 1.1.1 반영, `남자팬티` 원자 300개와 다음 자동 키워드 전환, lane·lease 해제를 확인합니다.
- 완료 증거: 신규 `강아지사료`를 첫 슬롯에서 선택해 `provider_duplicate_identity`를 해당 tracker만 격리했고 circuit은 closed를 유지했습니다. 이어 `남자팬티` canary는 오가닉 300개·광고 45개 제외·100위로 완료됐으며, 다음 10분 catch-up이 기존 `치아미백제`를 자동 선택해 오가닉 300개·광고 44개 제외·46위로 완료했습니다. 세 회차의 lane·lease는 모두 해제됐습니다.
- 운영 기준: runtime 1.1.1·baseline 10분·동시 실행 1개를 유지합니다. 이 연속 증거는 복구 완료 판정이며 24시간 완주 증거는 아닙니다.

## 진행 중: 준비작업 1번 24시간 공정 순환 감사

- 구성: 기존 2차 DB 상태 머신 + 3차 관리자 운영 관제 + 4차 24시간 공정 순환 개선
- 사용자 시작 승인: **준비작업 1번 시작합시다**
- 실제 시작: 2026-08-14 10:01 KST. 완료 판정은 2026-08-15 10:01 KST 이후의 전체 증거를 확인한 뒤에만 합니다.
- 자동 감사: 현재 작업에 연결된 30분 간격 heartbeat `1-24`가 운영 DB를 읽기 전용으로 관측합니다.
- 시작 기준: 활성 66 tracker/51 keyword group/9 agency, 24시간 미갱신 23, 48시간 미갱신 21, 격리 2, 처리 0입니다. cycle #7은 48/51 group을 한 번씩 claim했고 성공 collection 중 같은 cycle 중복 group은 0입니다.
- 품질 기준: 최근 24시간 collection 77건의 snapshot 113행은 모두 `checkedCount=300`이지만, 활성 tracker의 마지막 오류는 duplicate 28건·strict partial 1건입니다. 따라서 현재 상태를 정상화 완료로 판정하지 않습니다.
- 현재 동작: Windows primary, Mac standby, baseline 10분, 동시 실행 1개를 유지합니다.
- 변경 원칙: heartbeat는 순서·wake·lease·격리를 건드리지 않습니다. 실제 결함이 증거로 확인될 때만 최소 수정·회귀·승인된 배포·운영 재검증을 수행합니다.

### 시작 후 수행 범위

1. DB 상태 머신
   - `queued → claimed → collecting → validating → committing → completed`를 DB 기준 상태로 대조하고 누락된 전이를 보완합니다.
   - 실패는 `failed`, 네이버 제한은 `blocked`, 반복 시스템 장애는 `maintenance`로 유한 종료합니다.
   - 모든 전이는 lease token·CAS 원자 처리로 검증하고 Chrome·PC 종료 뒤 영구 `processing`을 DB에서 정리합니다.
2. 관리자 운영 관제
   - Windows primary·Mac standby heartbeat, 확장 버전·Git commit·서비스 워커/native host fingerprint를 확인합니다.
   - 현재 키워드·page n/8, 신규·대기·처리·실패·격리 수, oldest wait를 한 화면에서 검수하고 누락을 보완합니다.
   - 마지막 성공의 원자 300개·광고 제외·순위·lane 해제와 마지막 실패의 단계·typed code·시도 횟수를 검증합니다.
   - `전체 중지`, `테스트 1건 검증`, `자동 순환 재개`가 오작동·중복 wake 없이 동작하도록 확인합니다. 테스트의 고정 표본은 기존 `남자팬티` tracker를 유지합니다.
3. 24시간 공정 순환
   - 신규 첫 슬롯 우선 후 lookup/new/due 가중치·대기시간 aging·광고주 round-robin을 검증하고 기아 가능성을 보완합니다.
   - 실패 tracker만 `next_retry_at`/격리 대상으로 두고 보안 제한만 global cooldown에 적용합니다.
   - 정확히 300개를 확인했지만 대상이 없으면 `300위 밖` 정상 완료로 처리하며 실패 재시도를 만들지 않습니다.
4. 완료 검증
   - 24시간 운영 증거와 회귀·동시성·중단복구 테스트를 대조하고 필요한 코드만 수정합니다.
   - 전체 release 검사, `git diff --check`, 문서 동기화, 승인 범위의 Production·Windows 반영과 운영 재검증까지 수행합니다.

### 불변 조건

- 광고 제외 `checkedCount=300`만 저장하고 부분 결과·제한 결과는 저장하지 않습니다.
- 마지막 정상 순위와 30일 이력을 보존합니다.
- 운영팀 계정은 광고주 연결 전에도 두 추적 기능의 조회·등록·갱신이 가능하며 보고서·광고주 공개 데이터는 기존 권한 경계를 유지합니다.
- CAPTCHA 풀이, 접속 제한 우회, VPN, 쿠키 상시 삭제, 요청 연타를 구현하지 않습니다.
- 작업 도중 같은 단계·오류가 2회 연속이면 추가 실기와 전체 순환을 중단하고 원인부터 확정합니다.

## 과거 기록: 5차 속도 향상 보류 해제

- 과거에는 사용자 지시에 따라 무기한 보류했습니다.
- 2026-08-21 사용자가 5번 속도 개선 실행을 명시 승인해 보류를 해제했습니다.
- 현재도 안전 gate가 끝날 때까지 baseline 10분과 한 번에 한 키워드를 유지하며, 동시 실행·수집 경로·페이지 간격은 변경하지 않습니다.
- 새 runtime 1.1.9의 24시간+원자 성공 6회와 idle gate를 모두 충족한 뒤에만 candidate8을 활성화합니다.

## 완료·과거 작업

- 이전 v1.0.x 작업과 v1.1.0 배포 기록은 `archive/NEXT_ACTIONS_HISTORY_THROUGH_2026-08-11.md`에 보관했습니다.
- 현재 운영 상태는 `WORK_STATUS.md`, 검증 증거는 `TEST_EVIDENCE.md`, 영구 계약은 `08-work-spec-autosave.md`를 기준으로 확인합니다.
