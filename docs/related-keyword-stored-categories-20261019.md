# 저장된 순위 상품 카테고리 재사용

현재 상태: 개발본 구현·운영 DB 읽기 검증·최종 전체 품질 검사 통과 후, 2026-10-19 사용자의 “배포해 주세요” 승인으로 운영 배포 검수를 진행 중이다. 아래 배포 전 기록은 해당 시점의 이력이며 운영 반영 성공 증거와 구분한다. 기존 키워드 조회/순위 수집·갱신 로직/확장프로그램/운영 DB 구조와 데이터는 보존한다.

## 승인 범위

- 연관 키워드 경로에만 기존 snapshot 읽기를 연결한다. 카테고리용 신규 네이버 호출·유료 API·Commerce·crawler fallback·DB 쓰기·migration은 하지 않는다. 최초 구현 요청에는 배포를 포함하지 않았고, 후속 명시적 승인으로 이 기능의 운영 배포만 진행한다.
- 기존 키워드 조회, rank collector/worker/scheduler/runtime/보호 잠금, 기존 사용자 dirty 문서는 변경하지 않는다. `work:autosave`가 보호 문서를 재작성하므로 사용자 보존 지시에 따라 이 파일에 기록한다.
- 로그인된 계정의 허용 agency만 읽는다. 비로그인/체험/불명 scope는 저장 데이터 접근 없이 확인 필요다. 다른 광고주 상품/순위/URL/ID/내부 증거는 응답에 포함하지 않는다.

## 구현 전 사실 확인

- 2026-10-19 14:20~14:22 KST Production REPEATABLE READ READ ONLY/service_role 감사: snapshot 6,008, 38 tracker/36 keywords. 실제 category2/3 보유 keyword36, 24h 이내35.
- 최신38 snapshot은 checked300, source=naver_shopping_results_collector, top_items각5. 190상품 모두 실제 중·소분류/상품ID/organic=true/ad=false 보유. 표본 기준 단일34keyword/복수2keyword. 전체300 상품 분류는 저장하지 않는다.
- 최신38은 snapshot(tracker_id,collection_id)→commit→claim 유일성38/38, 현재 keyword와 ledger fingerprint 일치38/38, agency mismatch0. ledger는 normalized keyword hash이므로 과거 원문 대소문자/공백까지 불변 증명이라고 주장하지 않는다.
- 현재 tracker의 키워드와 요청 문자열은 NFC/앞뒤 공백 정리 뒤 동일해야 하며 내부 공백 제거·유사어·브랜드/제목/이미지 분류를 금지한다. Ledger는 보조 무결성 증거이지 다른 조회어를 연결하는 키가 아니다.

## 계획 및 검증 게이트

1. 연관 경로 기본 category source를 stored-only로 전환. 기존 외부 category 모듈은 이 경로에서 호출하지 않는다.
2. 제한된 GET batch 3개 이내(tracker+최신 snapshot embed, terminal, claim/group), 전체 timeout/응답 크기/개수 상한, 재시도0, tenant+config별 짧은 캐시.
3. exact tracker/agency/collection/ledger/time/organic300 검증. 단일은 저장 표본 내부 일관성만 뜻하며 복수/부족/오래됨을 구분한다.
4. RED 회귀→대상검사→전체 quality→관리자/광고주 브라우저→독립 P0/P1→기존 파일 SHA/mode 보존 확인.
5. 실행 결과와 운영 연결을 분리해 보고한다. 최초 구현 요청과 후속 배포 승인을 구분하고, 운영 HTTP/UI 확인 후에만 배포 완료로 보고한다.

## 구현·실행 증거

- 기본 related handler는 `createStoredRankCategoryLookup`만 사용한다. Commerce/독립 collector 설정이 남아 있어도 이 경로에서는 호출하지 않는다. 연관어 목록 자체의 기존 SearchAd 조회와 **카테고리 보완용 추가 네이버 호출 0**은 구분한다.
- GET1은 허용 agency+정확 keyword의 tracker와 tracker당 최신 snapshot 1개만 embed한다. GET2는 exact tracker/collection commit, GET3은 해당 claim의 group/claim 원장이다. 원장 group의 agency null은 실제 스키마 특성이므로 claim/fingerprint/run/cycle/order로 검증하고, claim/commit은 agency exact를 요구한다.
- 최대 30 keyword/60 tracker/60 commit/120 group+claim, GET당 1MiB/전체4초, 진행 batch2, 재시도0, config+tenant+keyword별 캐시 최대64. 정상5분/미확인30초 캐시는 실제 원본24h 만료를 넘기지 않는다. 별도 GET 간 snapshot isolation은 주장하지 않으며 원장 누락/변경은 확인 필요로 종료한다.
- 가장 최신 수집 collection 하나의 상위5개만 사용한다. mirror snapshot은 중복 집계하지 않는다. 오래됨/누락/잘못된 시각을 건너뛰어 이전 성공을 골라내지 않는다. 분류·광고·상품ID·원장 불명, 표본5개 누락, 응답 한도 초과는 확인 필요다.
- 2026-10-19T05:30:04Z 실제 Supabase GET3/HTTP200: 온열찜질기→냉온/찜질용품→찜질기(표본5, 원본2026-10-19T01:21:24.483Z). 내부공백이 다른 키워드/미저장어는 no_stored_evidence. 이 과정 네이버0/DB write0.
- 2026-10-19T05:31:23Z owner 자기 계정 저장 keyword33을 두 유한 batch로 검사: 단일31·복수2. adapter cold GET6/warm GET0. 최초 scope keyword 목록 읽기 GET1은 별도다. 원래 감사의 전역36과 계정 scope33을 혼동하지 않는다.
- 공유 pending 요청의 짧은 deadline 상속, 잘못된 날짜 후보의 sort NaN 우회, SearchAd 긴 조회어의60자 truncation/내부공백 병합으로 다른 저장어를 연결하는 경계를 RED→GREEN으로 보완했다.
- source 대상39/39, handler+source+UI+기존 integration73/73, 기존 키워드/권한81/81, 키워드+rank tracker+worker267/267 PASS. source line coverage100%, branch87.61%(해당 시점). 관리자/광고주·PC/모바일 fixture 브라우저6검사 PASS(실제 API0). fixture 결과와 실제 DB 검증은 별도 증거다.
- 원래 checkout 보호9파일 SHA256/mode 불변, 기존 admin/client inline byte 동일·보호 lock23함수/144파일/91migration PASS, 최종 public build PASS.

## 검수 진행 이력 (아래 최종 결과로 종료)

- 첫 전체 `check:quality` core3160:3155PASS/5FAIL. 4건은 과거 Commerce 진단기의 이전 기본소스 기대라 stored-only 계약으로 갱신한다. 1건은 보호 워치독 F2가 `sync_skipped=collection_active`를 관측했다. 동일 F2 단독 재검사는 PASS지만 최초 실패를 지우거나 전체 PASS로 주장하지 않는다.
- 최초에는 테스트도 고정한 채 같은 assertion 전체를 직렬 실행으로 분리했다. 그래도 환경 의존 실패가 남아 아래 기록대로 테스트 fixture만 격리 보완했고 운영 프로세스·잠금·워치독 원본은 변경하지 않았다.
- 아직 커밋·push·배포·DB 변경은 하지 않았다.

## 진단 도구 정합성 보완

- `verify-related-keyword-connection.mjs`도 stored-only로 전환했다. 기본 실행은 설정 존재 boolean만 출력하고 호출0, 명시적 `--live --keyword`도 Supabase GET 최대3/4초/재시도0이며 SearchAd/Commerce/collector를 호출하지 않는다. 예전 `wordListVerified`는 false로 유지해 연관어 조회까지 증명한 것처럼 보고하지 않는다.
- 진단기10+source39=49/49 fixture PASS. 실제 기존 환경변수를 메모리로만 주입한 온열찜질기 검증에서도 `verified_stored_sample`, GET3, external/rank/write/retry0을 확인했다. 비밀값·상품정보·원장ID는 출력하지 않았다.
- 최초 병렬 전체 검사에서 워치독이 실제 `collection_active` 신호를 관측한 사실은 유지한다. 순위 프로세스를 끄거나 테스트 assertion을 약화하지 않았다. 두 번째 전체 검사는 package.json의 동일 `check:quality`/`test` 명령을 메모리에서 조합하고 core Node test에만 `--test-concurrency=1`을 추가했다. 테스트 제외/파일 변경/운영 설정 변경은 없다.
- CSV에는 사용자용 분류명·상태·시각·표본 한계만 유지하고 source/basis/reason 기술 코드의 추가 열은 노출하지 않는다.

## 전체 검사 중 테스트 환경 결함 보완

- 직렬 전체 core3163 중3162PASS/1FAIL. F2의 `(j) 시계 역행` fixture가 실제 `collection_active` 관측으로 실패했다. 진단기4건은 해소됐으며 동일한 기계 외부 신호 문제는 직렬화만으로 해결되지 않았다. 실패 기록은 보존한다.
- 독립 검토 후 `scripts/rank-collection-stability.test.mjs`의 테스트 fixture만 보완했다. 원본 watchdog/worker/수집기/guard/manifest와 기존 assertion·skip은 바꾸지 않는다.
- 기존 F12 방식처럼 임시 watchdog 사본에서 외부 pgrep/Darwin 전역 임시경로/전역 /tmp 관측만 격리한다. 치환 각각 정확1곳 여부를 assert한다. 실제 TMPDIR→owner.json→kill -0 보호 가드는 그대로 실행한다.
- F2 drift·F13 fake git 설치본 시나리오는 각각 자기 임시폴더를 사용한다. live process.pid 잠금은 동기화/fast-forward를 막고, deadPID/no-lock은 기존 기대 동작을 유지하는 추가 assertion을 넣었다. DRY_RUN=1이며 실제 설치·Chrome·운영 잠금 조작0이다.
- 이 변경은 운영 순위 오류 수정이 아니라 검수의 환경 의존성을 제거하는 테스트 보완이다. 순위 수집 중인 기계에서 보호 가드를 꺼서 검사를 통과시키지 않는다. 대상 검수와 전체 `npm run check:quality`를 변경 후 다시 실행한다.

## 최종 검수 결과

- 보완 후 원래 명령 그대로 `npm run check:quality` exit0. core3163/3163·Place59/59·Shopping104/104, 합계3326/3326 PASS(실패0/skip0).
- 공급망·역할 상태/쿼리 parity·개인 영역 격리·서버 계약74/74·서버 문법·cron·rank matching·키워드 trend·공개 build 모두 PASS. 보호 lock23함수/144파일/91migration PASS. 공개30파일, inline6/고유CSP hash4, private artifact/secret signature 없음.
- 마지막 실패 경로 cleanup 보완 후 watchdog F2/F12/F13 대상3/3 PASS. 원본 watchdog/installer/manifest 변경0, 기존 assertion·기대값·skip 삭제0, fake live PID의 동기화/fast-forward 차단까지 검사했다.
- 새 source+handler+UI+진단기 focused73/73 PASS. 관련 기존 provider fixture까지 포함한114검사도 통과했고, 추가된 진단기10/10은 별도 통과했다. 이 숫자는 전체3326에 포함되는 항목이며 별도 성능/운영 성공 횟수로 합산하지 않는다.
- source 검수·fixture 독립검토와 UI/CSV/paired inline 독립검토 P0/P1 blocker0. UI15/15, 관리자/광고주 PC·모바일 browser6검사 PASS. 실제 데이터 증거는 앞의 DB GET 결과이고 browser QA는 fixture임을 유지한다.
- 원래 checkout 보호9파일 SHA256+mode 모두 이전 기준과 동일. `git diff --check` PASS. `data/`/기존 운영문서/원부 데이터/개인일정/Google/Vercel/Windows runtime 수정0.
- 실제 운영 앱의 새 기능 HTTP/UI 배포 검증은 아직 하지 않았다. 배포하지 않았으므로 구현 완료와 운영 반영을 구분한다. 별도 유료 자원/결제/API키 추가 없음; 카테고리 보완용 네이버 호출0·운영 데이터 쓰기0.
- 로그: `/tmp/mi-stored-category-quality-final-20261019.log`, `/tmp/mi-stored-final-focused-20261019.log`, `/tmp/mi-stored-category-browser-final-20261019.log`, `/tmp/mi-watchdog-cleanup-final-20261019.log`. 최초 병렬/직렬 실패 로그는 별도로 보존했다.

## 운영 배포 승인 및 사전 확인

- 2026-10-19T06:07Z 원격 main/작업 기준/운영 `/health`·`/ready` release는 모두 `36a87bf58219e70e7e04000a7d3789eb3d5e3214`로 일치했다. 두 HTTP200, live icn1/Supabase ready였다. 다른 개발자의 새 커밋을 덮어쓰는 병합·reset은 하지 않았다.
- 직전 Production deployment `dpl_WFioXDx4xLSkkKK8WGY1kxRVtmtw` READY를 확인했다. 기존 운영 설정·환경변수·DB·확장프로그램은 변경하지 않는다.
- 새 배포 전 원래 명령 `npm run check:release`(전체 quality+production-auth)를 다시 실행한다. 기존 원래 checkout의 보호 파일과 사용자 dirty 변경은 이 분리 worktree의 릴리스에 포함하지 않는다.
- 이번 배포에서는 정상 세션을 사용한 실제 연관어 화면/저장 표본 분류, 기존 키워드 화면, 비로그인 차단, 새 release/health/readiness를 확인한다. 순위 조회·크롤링 시작/수동 wake는 실행하지 않는다.
