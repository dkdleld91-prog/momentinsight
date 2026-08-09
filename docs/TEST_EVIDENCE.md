# Test Evidence

## 2026-08-10 Windows 수동 갱신 무한로딩 복구 v1.0.16

- 장애 증거: Windows native host PID와 자식 `node.exe`는 남아 있었지만 Supabase의 최근 10분 worker 요청과 processing tracker는 모두 0이었고 due tracker는 58건이었습니다.
- 수정 증거: launcher가 Chrome stdin을 자식 Node stdin으로, 자식 stdout을 Chrome stdout으로 binary relay합니다. 확장은 native host 첫 응답을 30초로 제한하고 수동 실행 UI에는 즉시 접수 응답을 반환합니다.
- 자동 검증: Windows/native-host 대상 16/16, 보호 잠금 22함수·64파일·15마이그레이션과 self-test, 서버 계약 39/39, 전체 `npm run check:release`, `git diff --check`를 통과했습니다.
- 배포 증거: 코드 `5049602`를 GitHub `main`에 푸시했고 Production `/health`·`/ready`는 릴리스 `504960286b26`, 서울 `icn1`, Supabase ready입니다.
- 설치 증거: `동빈 (개발)`의 `Profile 3`에 확장 1.0.16을 로드했습니다. DPAPI secret 해시는 보존됐고 정상 `.exe` 출력명으로 다시 컴파일한 launcher는 `MI_EXE_TEST_RUNNING=True`, 설치 경로 파일 크기 9216 bytes로 확인됐습니다.
- 운영 요청 증거: Windows 재가동 뒤 nonce `b4047c8b-ea3a-4c25-aa23-73c4b4918e2b`가 `2026-08-10 04:20:59 KST`에 소비됐고, 수동 실행 후에도 신규 nonce와 활성 tracker 59건 중 processing lease 1건이 확인됐습니다.
- 후속 실패 증거: 해당 lease는 시작 정확히 4분 뒤 `local_worker_collection_failed`로 해제되고 snapshot은 증가하지 않았습니다. native exchange `240000ms`와 request deadline `225000ms`가 8페이지 45~75초 분산보다 짧은 계약 불일치였습니다.
- 후속 수정 검증: 11분 1차 보완은 기존 4분 경계를 통과했지만 실회차가 정확히 11분을 사용해 명시적 `native_host_response_timeout`으로 안전 종료됐습니다. 요청 간격은 줄이지 않고 native/deadline 18분·lease 20분으로 정렬했습니다.
- 실수집 경계: 신규 `pw-chrome-*`·`checked_count=300` snapshot 생성 전에는 Windows 300위 수집 완료로 확대하지 않습니다. 네이버 제한·보안확인은 우회하지 않고 안전 실패와 마지막 정상값 보존을 확인합니다.

## 2026-08-10 N상품 Windows 작업용 데스크탑

- 원인: 기존 설치기와 wrapper는 macOS `/usr/bin/security`, `~/Library/Application Support`, LaunchAgent만 사용하므로 Windows Chrome에 확장이 자동 설치되지 않습니다.
- Windows 설치 경계: 표시 이름 `프로그램 개발` 정확 매칭, 런타임 사용자 전용 ACL, HKCU Native Messaging, 고정 확장 ID, 현재 사용자 DPAPI, Windows PowerShell 5.1 컴파일 launcher, 로그인 사용자 전용 10분 watchdog입니다.
- 바이너리 경계: Chrome과 Node 사이의 4-byte native messaging framing을 보존하도록 C# launcher가 stdin/stdout을 리다이렉트·텍스트 변환하지 않고 Node에 그대로 상속합니다. launcher stdout과 비밀키 로그는 금지합니다.
- 자동 검증: 신규 Windows 정적 회귀 4/4, native host 12/12, API·서버 401/401, 플레이스 51/51, 쇼핑 51/51, 서버 계약 39/39, Production 인증 18/18, 보호 잠금 22함수·64파일·15마이그레이션, 공개 빌드·CSP와 전체 `npm run check:release`를 통과했습니다.
- 미검증 경계: 현재 실행 환경은 macOS이므로 Windows PowerShell 5.1 C# launcher 실컴파일, HKCU 레지스트리, 작업 스케줄러, Chrome 압축해제 확장 연결은 Windows 데스크탑에서 확인해야 합니다.
- 실증 경계: Windows에서 신규 `pw-chrome-*`, `checked_count=300`, 광고 제외·정확 상품/원부 판정이 확인되기 전에는 주 작업자 전환 완료로 기록하지 않습니다.
- Production: 코드 `c22b5d6`을 GitHub `main`에 푸시했고 Vercel 커밋 상태 `success` 후 운영 별칭에 반영됐습니다. `/health`·`/ready`는 릴리스 `c22b5d65c491`·서울 `icn1`·Supabase ready이고 `/admin`·`/client`는 리다이렉트 후 200입니다.
- 별도 CI 경계: GitHub Quality Gate는 Windows 검사 전 단계인 `npm audit` 중 `pptxgenjs -> image-size` 상류 high 권고 2건으로 중단됐습니다. 현재 `image-size <=2.0.2` 전체가 권고 범위이고 npm의 자동 제안은 `pptxgenjs 1.1.5`로의 breaking downgrade이므로 이 Windows 작업에서 임의 적용하지 않았습니다. Vercel Production 빌드의 전체 릴리스 검사는 통과했습니다.

## 2026-08-09 N상품 당일 전체 순환·복구 v1.0.15

- 사용자·내부 분리: 관리자·광고주 화면의 `09:00 · 15:00` 안내와 `nextRankCheckAt` 표시는 유지하고, 내부 `rank-catch-up` 20분 회차가 사이트 전체를 멱등 등록하도록 고정했습니다.
- 운영 규모: Supabase 읽기 전용 SQL에서 `status=active` 59건, 고유 키워드 47개, due 56건·47키워드, 활성 processing lease 0건을 확인했습니다.
- 연속 처리: 회차당 `max_jobs=1`, 기존 30~45초 첫 대기와 페이지 간 45~75초 분산을 유지합니다. 47개 키워드는 오류가 없을 때 약 15시간 40분에 한 바퀴이며 기존 due·처리 중 행과 oldest-first 순서는 보존합니다.
- 장애 복구: 네트워크 제한·418·429 즉시 중단, `30/60/120분` 단계형 보호 대기와 이후 120분 상한, CAPTCHA 비우회, 회복 후 `rank-recovery` 1건, 실패 lease 해제와 마지막 정상 순위·30일 snapshot 보존을 정적 계약과 회귀검사에 고정했습니다.
- 전체 검증: native host 12/12, API·서버 397/397, 플레이스 51/51, 쇼핑 51/51, 서버 계약 38/38, Production 인증 18/18, 보호 잠금 22함수·60파일·15마이그레이션, 공개 빌드·CSP와 전체 `npm run check:release`를 통과했습니다.
- Production: 코드 `16a0488`, 배포 `dpl_J23S2KoAt34TbC4gafyxneBdADjG`, 운영 별칭 `https://insight.momentlabs.co.kr`입니다. `/health`·`/ready`는 `release=16a04882ff83`, `region=icn1`, Supabase ready이고 관리자·광고주 화면은 리다이렉트 후 200입니다.
- Mac: 설치 런타임 14/14 파일이 저장소와 byte-for-byte 일치합니다. native host는 고정 확장 ID `pflggephankeefaeoaafkmggampnaefm`만 허용하고 scheduler config는 `Profile 5`, LaunchAgent 최근 exit 0, 확장 소스 manifest는 1.0.15입니다.
- 남은 실증: 서비스 워커 변경은 사용자가 `동빈(개발)`의 `chrome://extensions`에서 한 번 재로드해야 적용됩니다. 로드 버전 1.0.15, 제한 해제·첫 신규 `pw-chrome-*`·`checked_count=300`과 다음 oldest-first 작업 재개를 확인합니다.

## 2026-08-09 N상품 가격비교 순위 저빈도 안정화

- 기준 URL: `https://search.shopping.naver.com/search/all`, `where=all`, `productSet=total`, `sort=rel`, `viewType=list`, 페이지 1~8·40개 단위입니다. 네이버플러스 `/ns/search`는 수집과 운영 링크에서 제외했습니다.
- 수집 계약: 동일 탭 순차 이동, 페이지 간 12~18초, 회차당 1개 키워드, 광고 제외 후 정확히 오가닉 300개가 완성된 경우만 원자 저장합니다. 정확 URL 상품 ID·판매자 ID가 다른 상품은 일치시키지 않습니다.
- 실패 계약: 보안확인·418·429·네트워크 제한·페이지/스키마 불일치·부분 수집은 즉시 중단하고 마지막 정상값·30일 이력·대기 순서를 유지합니다. CAPTCHA 우회 코드는 없습니다.
- 자동 검증: 앱·API 393/393, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 공개 빌드 9파일·inline script 6개·CSP SHA 4개, 보호 잠금 22함수·58파일·14마이그레이션과 self-test, 전체 `npm run check:release`, `git diff --check` 통과입니다.
- 설치 검증: 저장소와 중앙 Mac 설치 wrapper SHA-256은 모두 `bcfb8ec9437ae67d41a70ea8fc74db295a632d16d089e8388a3fecf1d8d3738c`, 설치 기본값 `max_jobs=1`, Chrome `동빈` 프로필 확장 1.0.10 활성입니다.
- 운영 실증 경계: 가격비교 1페이지를 직접 열자 네이버 보안확인이 반환됐습니다. 담당자 직접 완료 후 신규 `pw-chrome-*`·`checked_count=300` snapshot이 생기기 전에는 실수집 정상화와 배포 완료로 판정하지 않습니다.

## 2026-08-08 N상품 보안확인 안정화 기준

- 원인 로그: `2026-08-08T10:11:13Z max_jobs=2`와 `2026-08-08T11:19:57Z max_jobs=4` 모두 첫 작업에서 `naver_verification_required`로 중단됐습니다. 4건 연속 수집 증거는 없으며 기존 보안확인 미해결 상태의 재시도입니다.
- 필수 동작: 기존 확인 탭이 blocked/unknown이면 자동·수동 모두 native host 연결과 서버 claim 전에 중단하고, 정상 쇼핑 `__NEXT_DATA__`가 확인된 경우에만 상태를 지우고 안전 수집을 재개해야 합니다.
- 처리량: 기본 상한은 회차당 순차 2건, 10분 보정과 페이지별 3.5~6초 분산을 유지합니다.
- 자동 검증: native host·worker 대상 28/28, 앱·API 389/389, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·58파일·14마이그레이션 self-test와 전체 `check:release`를 통과했습니다.
- 설치 검증: 저장소와 중앙 Mac 설치 wrapper SHA-256은 `58c062eca4c392f2696110bc3840417ef71237c728aa066b9f5ce49f819615fd`로 일치하며 wrapper 기본값은 `max_jobs=2`, LaunchAgent 주기는 600초입니다.
- 미완료: Chrome 확장 1.0.6 재로드, 사용자의 현재 보안확인 완료, 이후 실제 원자 300개 snapshot 생성은 아직 확인하지 않았습니다.

## 2026-08-08 N상품 Mac 처리량·중복 대기열 검증 기준

- 처리량: native host 기본 상한은 회차당 4건이며 병렬 수집 없이 기존 10분 주기·페이지 분산·보안확인 중단·1시간 쿨다운을 유지합니다.
- 중복 방지: 첫 전체 갱신은 미래 예약 행만 due로 전환하고, 같은 계정 또는 사이트 전체의 반복 요청은 `queued=0`, `alreadyQueued` 증가로 끝나야 합니다.
- 공정성: 이미 due인 `next_check_at`은 다시 쓰지 않으며 중앙 claim은 기존 oldest-first와 조건부 lease를 유지해야 합니다.
- 필수 검증: handler 반복 요청, local worker, native host, release baseline, 보호 잠금 self-test와 전체 `npm run check:release`를 통과해야 완료로 판정합니다.
- 실행 결과: 대상 96/96, 전체 앱·API 389/389, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·58파일·14마이그레이션과 self-test, 공개 빌드·CSP 검사가 모두 통과했습니다.
- 변경 경계: 화면·DB 스키마·순위 판정·광고 제외·정확 상품/원부 판정·300개 원자 저장·기존 30일 이력은 변경하지 않았습니다.
- 배포 증거: 코드 `1d7b773`, Production `dpl_H5Jtb4sZR3yNGV75PKAxZnwLgvYp`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `1d7b77338bfc`·서울 `icn1`·Supabase ready이며 Vercel Production 빌드에서도 전체 릴리스 검사를 다시 통과했습니다.
- Mac 설치 증거: 저장소와 설치 wrapper SHA-256은 모두 `13edcfe18410dd657a9f5e9a3a2a6b779ba7ddd0a251465477a8e1b16afddbf8`, 설치 환경은 `MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS=4`, LaunchAgent 최근 exit 0입니다.
- 운영 관찰 경계: 설치 후 스케줄러의 `chrome_ready profile=Default`는 확인했지만 새 native-host 작업 기록이 없어 첫 자연 회차의 `max_jobs=4`와 신규 원자 300개 snapshot은 아직 미확인입니다.

## 2026-08-08 N상품 30일 순위 날짜별 단일 표시

- 대상: `src/pages/admin.html`, `src/pages/client.html`
- 동작: 날짜별 AM/PM 중 `checkedAt` 기준 최신 유효 순위 1개 표시, 한쪽만 수집된 날은 해당 순위 표시, 둘 다 없으면 `-`.
- 대상 동작 검증: 양쪽 존재·AM만 존재·PM만 존재·최신값 공란 fallback·양쪽 없음, 관리자·광고주 합계 `10/10`.
- `npm run check:baseline`: 통과, `rankTrackingDailySingleRank: true`.
- `npm run check:rank-feature-lock:self-test`: 통과, 보호 함수 22개·보호 파일 58개·migration discovery 확인.
- `npm run check:release`: 통과. server contract `37/37`, app tests `389/389`, place collector `51/51`, shopping collector `51/51`, production auth `18/18`, public build 9개 파일과 inline script 6개를 CSP SHA 4개로 허용.
- Production 배포: 코드 `01dd688`, 운영 릴리스 `01dd688b814b`, 서울 `icn1`, `/health`·`/ready` 200, Supabase ready.
- 운영 산출물: `/admin`과 `/client` HTML SHA-256이 각각 로컬 검증 빌드와 일치하며 두 파일 모두 `latestRankSnapshotForDay`와 단일 `renderRankSlot` 호출을 포함하고 기존 AM/PM 렌더 호출은 없습니다.
- 로그인 관리자 실데이터: 새로고침 후 날짜 카드 367개 모두 슬롯 1개, AM/PM 라벨 0개. 표본 `08-07 순위 68위`, `08-03 순위 121위`, `07-31 순위 101위` 확인.
- 광고주 실데이터 육안 검수: 현재 Chrome에 광고주 접속 코드 세션이 없어 미완료. 광고주 운영 HTML 해시 일치와 동일 동작 대상 테스트는 완료했습니다.

## 2026-08-03 확장 수동 갱신 사이트 전체 대기열

- 원인 증거: 기존 확장 수동 실행은 `next_check_at <= now()`인 due만 claim했다. 운영 DB 읽기 전용 집계는 active 71·고유 키워드 58·due 61·미도래 10·활성 lease 0으로, 수동 버튼을 눌러도 미래 예약 10건은 대상이 아니었다.
- 변경 증거: 수동 trigger만 서명된 `queue-all-active-trackers`를 먼저 호출한다. 서버는 모든 active를 계정 필터 없이 갱신하되 활성 lease는 제외하고, 총계·등록·처리 중 수만 반환하며 ID와 계정 코드는 반환하지 않는다. 신규 tracker의 즉시 due 계약도 유지한다.
- 처리 증거: 첫 회차는 기존 최대 2건, 남은 due는 10분 catch-up, 보안확인·418·429는 1시간 휴지한다. 자동 09:00·15:00·10분 trigger는 전체 재등록을 호출하지 않는다.
- 검증: 대상 워커·handler·native host·확장 42/42, API·서버 389/389, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 역할 5상태, 보호 잠금 22함수·58파일·14마이그레이션, 공개 빌드/CSP와 전체 `npm run check:release` 통과.
- 배포 증거: 코드 `2924d82`, Production `dpl_9zLh7gMu554Uo1tHnF7BcUtmWid9`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `2924d82801e5`·서울 `icn1`·Supabase ready이고 무서명 워커 요청은 401이다. 중앙 Mac native host·local worker 설치본 SHA-256은 저장소와 각각 일치하고 확장 소스는 1.0.5, LaunchAgent 최근 exit 0이다.
- 미완료: Chrome 보안 정책상 `chrome://extensions`의 재로드 버튼은 자동 조작하지 않았다. 사용자가 확장을 한 번 재로드하고 수동 버튼을 직접 누른 뒤 `전체 71개 등록`과 신규 `pw-chrome-*`·`checked_count=300` snapshot 증가를 확인해야 하며, 그 전에는 전체 실갱신 완료로 판단하지 않는다.

## 2026-08-03 N 쇼핑 일반 Chrome 자동 수집

- Chrome 실화면: 동빈 프로필의 `온열찜질기` 가격비교 페이지에서 보안확인 문구 없음, `__NEXT_DATA__` 존재, 정상 검색결과 확인.
- 운영 DB 읽기 검증: 최근 3시간 `naver_shopping_results_collector` snapshot 17건 모두 `checked_count=300`; 17개 서로 다른 tracker의 원자 저장 확인.
- 장애 근거: 짧은 시간 연속 실행 뒤 28개 tracker가 실패해 페이지 간 1.25초 간격과 차단 시 현재 실행 중단을 적용. 실패 시 `submit` 없음·lease 해제·추가 claim 없음 회귀검사 통과.
- 설치 검증: LaunchAgent `co.kr.momentinsight.naver-shopping-chrome-scheduler`, 08:50·14:50 KST, 승인 Chrome 경로와 `Default(동빈)` 프로필, plist `OK`, 실행 exit 0·`chrome_ready profile=Default` 확인.
- 집중 검사: local worker·native host 25/25. 전체 릴리스 검사는 API·서버 371/371, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 22함수·54파일·12마이그레이션을 통과했다.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, Supabase 스키마·운영 이력·순위 계산·화면 렌더링 변경 없음. Production 배포 없음.

> 2026-07-31 이전의 공식 쇼핑 검색 API 순번·API 배열 기록은 과거 결함과 배포를 재현하기 위한 증거다. 현재 순위 소스 검증에는 2026-08-02 hybrid 경계와 `mi.naver-shopping-organic-window.v1` 원자 수집 계약만 적용한다.

## 2026-08-02 · N 쇼핑 hybrid 로컬 워커 전환·실증 대기

- 공식 경계: NAVER API Hub에는 쇼핑 오가닉 전체 순위를 반환하는 endpoint가 없다. 종료된 쇼핑 검색 API, Search·Search Trend·Shopping Insight·Commerce API를 순위 대체값으로 사용하지 않는다.
- 서버 경로: 모바일 통합검색의 명시적 SAS 상품에서 광고를 제외하고 1위부터 연속 검증된 최대 상위 50위 exact hit만 허용한다. 범위 밖 miss와 불완전 응답은 새 순위·snapshot을 만들지 않는다.
- 300위 경로: 사용자가 승인한 일반 `동빈` Chrome에 MV3 최소권한 확장을 로드한다. 권한은 `alarms`·`nativeMessaging`·`scripting`·`storage`·`tabs`와 `https://search.shopping.naver.com/*`만 허용하며 cookies·history·webRequest·localStorage 접근, 비밀번호·쿠키 서버 전송, CAPTCHA 자동 우회를 금지한다.
- 제출 경계: HMAC 서명, 제한된 유효시간, 1회용 nonce, 활성 lease, 정확히 300개, 광고 제외, 연속 순번, 고유 stable ID를 모두 강제한다. 성공 결과는 tracker와 snapshot에 원자 반영하고 실패는 마지막 정상값과 30일 이력을 보존한다.
- 실행 경계: 오전 9시·오후 3시에 로컬 워커가 먼저 실행되고 후속 재시도와 매시 안전 실행이 남은 due tracker를 처리한다. Mac이 꺼져 있으면 서버 상위 50위와 기존값 보존은 계속되지만 새 51~300위 증거는 생성되지 않는다.
- 비용 경계: 유료 외부 수집기·카드·자동 결제는 사용하지 않는다.
- 브라우저 증거: 사용자가 열어 둔 일반 Chrome에서 `온열찜질기` 페이지 1~8을 확인해 페이지마다 광고 4개+오가닉 40개, 오가닉 1~320 연속, 상품 `12149720593` 정확 91위를 확인했다. 별도 자동 Chrome의 보안확인 화면은 근거로 사용하지 않았다.
- 로컬 브리지 증거: Native Messaging manifest를 Chrome 표준 경로에 0600으로 설치하고 확장 ID `pflggephankeefaeoaafkmggampnaefm`만 허용했다. HMAC secret은 기존 macOS 키체인에서 길이만 확인했고 출력·파일 저장하지 않았다. 네이티브 300위·불완전/순번 drift 차단·교환·고정 ID·stdio framing 5/5와 최소권한·원자 수집 계약을 통과했다.
- 서버 배선 증거: 배포 전 운영 endpoint 무서명 POST가 `401 SESSION_REQUIRED`로 끝나 HMAC handler에 도달하지 못하는 결함을 발견했다. 정확한 워커 경로만 공통 로그인 세션 gate에서 제외하고 유사 하위 경로는 계속 잠기며, handler의 HMAC·timestamp·nonce 검증은 그대로 필수인 회귀를 추가했다. 운영 반영 후 무서명 요청이 세션 오류가 아닌 워커 서명 오류로 거부되는지 다시 확인해야 한다.
- 미완료 증거: Chrome 정책상 `chrome://extensions` 자동 조작이 차단되어 사용자 1회 수동 로드가 남았다. 최근 `collection_id=pw-chrome-*`, `checked_count=300` 실제 snapshot, 전체 활성 tracker, 두 정규 실행 창, 세 역할 동일 값은 아직 확인되지 않았으므로 실수집 정상화·Production 배포 완료로 기록하지 않는다.

## 2026-08-01 · 폐기된 원격 쇼핑 수집기 실험 이력

> 아래 내용은 Render/headless 공개 수집 경로를 검토하던 당시 증거다. 현재 실행 구조는 위 2026-08-02 hybrid 로컬 워커 계약을 따른다.

- 신규 경계: `tools/naver-shopping-rank-collector`를 본 Vercel API·플레이스 수집기와 분리했다. Bearer 인증과 16KB 요청 제한, `mi.naver-shopping-organic-window.v1`, 한 응답당 단일 `collectionId`·`collectedAt`, 광고 제외, 연속 오가닉 순번, 숫자형 상품·원부 ID를 강제한다. 부분·혼합 출처·증거 불일치·중복 stable ID는 2xx라도 거부한다.
- 실행 구조: Playwright Chromium 한 개를 재사용하고 요청별 context를 폐기한다. 동시성 1의 제한 큐, 동일 키워드 single-flight, 불변 TTL cache, 호출자 deadline, 허용된 `https://search.shopping.naver.com/search/all` 경로만 사용한다. HTTP 418·429, 캡차, 인증 리다이렉트, selector drift, deadline·부분 수집은 각각 명시 오류로 분류한다.
- 무료 하드닝 재검증: 쇼핑 Render 서비스 블록을 `region: singapore`, Playwright 공식 `channel=chromium` headless, 요청별 격리 context로 유지했다. Render의 플랫폼 health check는 `/health`로 바꾸고 실제 N 쇼핑 검증 readiness는 `/ready`에 남겼다. 공용 쿠키·세션, stealth·fingerprint 위장, 캡차 우회는 추가하지 않았다.
- 앱 통합: 키워드 상품 참고값과 N 상품 단건·30일 추적은 같은 원자 목록만 사용한다. exact seller ID와 직접 확인한 catalog ID만 비교하고, URL query의 가짜 catalog ID·유사 상품명·광고·불완전 조기 일치는 snapshot을 만들지 않는다. 수집 실패 시 processing lease를 안전하게 풀고 마지막 정상 순위·30일 이력을 유지한다.
- 독립 감사 회귀: 명시적 `전체 상품/검색 결과` 문구만 상품수로 인정하고, 빈 결과 페이지 외에는 소진을 추측하지 않는다. 하나의 document-order selector로 카드 순서를 유지한다. 상품수 누락·페이지별 변경·수집량 미만은 `marketTotal=null/unavailable`로만 폐기하고 완전한 순위 창과 readiness는 유지한다. 큐 대기 만료·포화는 HTTP 429 `provider_busy`로 반환하고 5분 재시도하며 전역 readiness를 내리지 않는다. 강제 canary가 포화 큐를 만나거나 구버전 502가 `provider_queue_full`을 포함해도 기존 readiness와 due queue를 유지하며, 실제 `provider_collection_failed:naver_http_418`만 첫 요청부터 회로차단까지 전달됨을 검증했다.
- 시간 계약: 수집기·본 서버 deadline/abort·Production 300 canary는 90초, provider cold-start prewarm은 75초, 관리자·광고주 단건/SEO 조회는 120초 외곽 제한이다. 이 값과 `/health`·`/ready` 역할이 어긋나면 서버 계약 검사가 실패한다.
- 현재 로컬 집중 검사: 쇼핑 수집기 49/49, 관련 서버 회귀 60/60, 서버 계약 36/36 통과. HTTP 418 사용 불가, 실제 Naver 429 재시도, 300개 원자 gate, Playwright 의존성과 Docker 이미지 버전 일치, canary 브랜치 격리까지 확인했다. 전체 릴리스 통과나 실수집 성공으로 확대하지 않는다.
- 재현 명령: `npm --prefix tools/naver-shopping-rank-collector test`, `node --test src/server/handlers/naver-rank-trackers.test.mjs src/server/handlers/naver-rank-cron.test.mjs src/server/handlers/naver-shopping-rank-runtime.test.mjs src/server/naver-shopping/provider-runtime.test.mjs src/server/naver-shopping/source-status.test.mjs`, `node scripts/check-server-contract.mjs`.
- 실 canary: 수정 후 실제 Playwright/Chromium은 정상 기동했으나 N 쇼핑 검색이 HTTP 418을 반환했다. 수집기 `/ready`는 HTTP 503, `secretConfigured=true`, `provider.configured=true`, `provider.verified=false`, `reason=naver_http_418`을 반환했다. 테스트 서버 종료 후 로컬 포트 접속 실패까지 확인했다. 앞선 사용자 브라우저 점검에서도 동일 공개 주소가 `보안 확인을 완료해 주세요` 캡차로 전환됐으며 캡차를 우회하거나 순위를 추정하지 않았다.
- 배포 gate: Vercel Preview의 `--vercel-build` live check는 의도대로 skip되지만 Production은 실제 collector `/ready`와 요청한 300개가 정확히 일치하는 원자 목록을 통과해야 한다. `sourceExhausted`만으로 짧은 목록을 300개 canary 성공으로 인정하지 않는다. 실상품 300개·`mml93-a01` 25/25·전체 71개·09시/15시 cron은 미완료이며 수집 서비스와 Production 배포는 대기다.
- 비용 확인: Render 계정은 Hobby $0, 결제 카드 없음, 현재 청구액 $0이고 blueprint의 쇼핑 수집 서비스도 무료 plan이다. 이는 비용 상태 증거일 뿐 서비스 생성·실수집·배포 완료 증거가 아니다.

## 2026-07-31 · 종료 쇼핑 API 제거·Hub/쇼핑 수집원 경계 통합

- 호출 계약: Search·Search Trend·Shopping Insight는 `NAVER_API_HUB_MODE=hub`와 NCP 인증만 사용한다. Search Ads는 별도 공식 `/keywordstool` 계약을 유지한다. 키워드 상품수·카테고리와 N 상품 단건·30일 순위는 동일한 Bearer POST 수집원과 `naver_shopping_results_collector`·`naver_shopping_organic_list` 증거만 허용한다.
- 종료 경로 차단: `naver-keyword.mjs`와 `naver-shopping-rank.mjs`의 `/v1/search/shop.json`, 직접 legacy 쇼핑 헤더, 기존 fallback을 제거했다. 수집원이 없을 때 종료 API 호출 0건·키워드 Hub/SearchAd 부분 응답·상품 순위 DB 무변경을 자동 검증하고, 재도입 시 기준선과 보호 잠금이 실패한다.
- 환경 일치: 로컬 서버와 런타임·Hub 실호출 검사가 모두 기능 폴더 fallback보다 루트 `.env.local`을 우선하고, 실행 프로세스 환경값을 최우선으로 사용한다. 중복 키가 생겨도 검사와 실제 서버가 서로 다른 인증값을 읽지 않도록 통일했다.
- 정확성 회귀: 300개 완전 수집, 광고 제외, 정확 상품·검증 원부 비교, 잘못된 유사 원부 거부, 빈/짧은/증거 불일치 응답, 401·429·5xx 성격의 실패에서 기존 순위·30일 이력 보존을 검증했다. 총관리자·연결 운영팀·단독 운영팀·광고주·해제 운영팀과 양 역할 화면 계약도 통과했다.
- 자동검사: API·서버 252/252, 플레이스 수집기 51/51, 서버 계약 29/29, Production 인증 18/18, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드 9파일·인라인 6개·CSP 해시 4개, 전체 `npm run check:release` 통과.
- 신규 Hub 실호출: blog HTTP 200·1건·209ms, Search Trend HTTP 200·31건·157ms, Shopping Insight age HTTP 200·12건·53ms. 모두 `hub` 모드이며 실제 키는 출력·문서·커밋하지 않았다.
- 미완료·배포 차단: Production에 쇼핑 수집원 키 쌍이 없어 실상품 300위, `mml93-a01` 25/25, 전체 71개, cron 2회 검증은 수행하지 못했다. 자동 테스트를 실수집 성공으로 대체하지 않으며 commit·push·Production 배포하지 않는다.

## 2026-07-30 · 업무 실행 요약·즉시 완료·등록창 단순화

- 화면 계약: 기존 상단 3카드를 `오늘 업무·지연 업무·확인 필요` 필터 버튼으로 전환한다. 활성 필터는 얇은 딥네이비 계층으로 표시하고 같은 버튼 또는 `전체`를 눌러 해제한다. 모바일은 설명을 숨긴 3열 압축형으로 유지한다.
- 완료 계약: 가까운 업무의 체크 버튼은 `PATCH`에 기존 전체 업무 payload와 `status=done`만 합쳐 전송한다. 일정·유형·우선순위·담당자·내부 메모·공개 제목·공개 안내·공개 여부를 변경하지 않는다. 저장 성공 후 서버를 다시 조회하며 실패 시 화면 상태를 완료로 과장하지 않는다.
- 등록 계약: 기본 영역에는 업무 제목·시작·상태·광고주 공개만 노출한다. 유형·종료·담당자·우선순위·내부 메모는 `상세 설정`에 보존하고 서버 입력 계약은 변경하지 않는다.
- 회귀 검증: 새 기준선 `workOperationExecutionSummaryAndQuickComplete`, 즉시 완료 보존 단위검사 포함 API·서버 236/236, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18, 역할 5상태, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드 9파일·인라인 6개·CSP 해시 4개와 전체 `npm run check:release` 통과. `client.html`, 업무 API·DB·운영 데이터와 보호 기능은 변경하지 않았다.
- 육안 검수 제한: 로컬 서버는 정상 실행됐지만 앱 브라우저가 localhost를 `ERR_BLOCKED_BY_CLIENT`로 차단해 변경 후 실화면 캡처는 확보하지 못했다. 자동·정적 검증을 육안 확인으로 대체하지 않으며 push·Production 배포 전 대표님 실계정 확인이 필요하다.

## 2026-07-30 · 업무 등록 팝업·날짜 셀 전체 클릭

- 디자인 계약: 팝업은 딥네이비·화이트·그레이 토큰, 43px 입력 높이, 동일한 선택 화살표, 공개 전용 스위치, 고정 헤더·하단 행동으로 통일한다. 입력 내용만 내부 스크롤되어 작은 화면에서도 취소·저장을 바로 사용할 수 있다.
- 동작 계약: 날짜 숫자와 셀의 빈 영역 모두 해당 날짜의 신규 등록창을 연다. 일정 카드 클릭은 기존 업무 수정, 카드 드래그·모바일 long-press는 기존 일정 이동이 먼저 처리되며 드래그 직후 셀 클릭은 500ms 차단한다.
- 결함 보완: 공통 버튼 CSS가 `hidden`을 덮어 신규 등록창에도 삭제가 보이던 상태를 `[data-work-delete][hidden]`으로 강제 차단했다. 삭제는 수정할 업무가 있을 때만 표시한다.
- 브라우저 검수: 1280px 팝업과 390×700 모바일 팝업에서 입력 행열·선택 UI·공개 스위치·고정 저장 영역·가로 넘침을 확인했다. 빈 셀 `2026-07-08` 클릭 전 팝업 비노출, 클릭 후 팝업 노출과 시작값 `2026-07-08T09:00`, 신규 삭제 버튼 비노출을 확인했다.
- 자동 검증: 새 기준선 `workOperationCalendarCellCreatesAndDialogIsPremium`, 역할 5상태, 보호 잠금 21함수·23파일·11마이그레이션, 서버 계약 29/29, 전체 API·서버 235/235, 플레이스 51/51, Production 인증 18/18, 공개 빌드 9파일·인라인 6개·CSP 해시 4개와 전체 `npm run check:quality`가 통과했다. `client.html`, 업무 API·DB·운영 데이터와 순위 기능은 변경하지 않았다.
- Production 증거: 코드 `1bf6859`, Vercel `dpl_7tQpFm3W5RKY7UvYbLpxrCyJqEqz`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `1bf68593e3af`·서울 `icn1`·Supabase ready, `/admin`·`/client`는 200, 비인증 `/api/work-items`는 401이다. 관리자 HTML에는 날짜 셀·팝업·스위치·삭제 숨김 마커가 있고 광고주 HTML에는 셀 등록 기능 없이 공개 일정 읽기 계약만 있다.

## 2026-07-30 · 업무 일정 드래그 이동·저장 확인

- 동작 계약: 데스크톱은 캘린더 업무 카드를 드래그하고 모바일·펜은 320ms 길게 누른 뒤 이동한다. 대상 날짜는 딥네이비 계열의 얇은 강조선으로 표시하며, 놓는 즉시 카드가 새 날짜에 미리 표시된다.
- 저장 안전: 별도 `일정을 변경할까요?` 팝업에서 기존·변경 일시를 비교한다. `일정 변경` 확인 전에는 PATCH를 호출하지 않으며, 취소·ESC·바깥 클릭·저장 실패는 낙관적 이동을 원래 시작·종료 일시로 되돌린다. 확인 시 기존 시각·업무 길이·종일 여부·상태·우선순위·메모·공개값을 보존한 전체 업무 payload를 기존 권한 범위의 `/api/work-items`에 저장한다.
- 권한·비변경 범위: 수정 가능 역할은 기존과 동일한 총관리자·운영팀이며 광고주는 공개 일정 읽기만 유지한다. `client.html`, DB·마이그레이션·RLS, 보호된 키워드 조회·SEO·N 상품 순위·N 30일 순위·N 플레이스 30일 순위는 변경하지 않았다.
- 자동 검증: 이동된 시작·종료 90분 범위 단위검사를 포함한 업무 6/6, 역할 5상태, 새 기준선 `workOperationDragMoveRequiresConfirmation`, 서버 문법, 보호 잠금 21함수·23파일·11마이그레이션, 공개 빌드 9파일·인라인 6개·CSP 해시 4개가 통과했다.
- 전체·Production 검증: Vercel 빌드에서 전체 API·서버 235/235, 플레이스 51/51, 서버 계약 29/29, Production 인증 18/18과 전체 `check:release`가 통과했다. 코드 `d1e08f3`, Production `dpl_HQ6xoQJua3Cg5B46CvhM5d1RakuV`, 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다. `/health`·`/ready`는 릴리스 `d1e08f3607db`·서울 `icn1`·Supabase ready, `/admin`·`/client`는 200, 비인증 `/api/work-items`는 401이다. 관리자 HTML에는 드래그·날짜 대상·확인 팝업 마커가 있고 광고주 HTML에는 이동 기능 없이 공개 일정 읽기 계약만 있다.

## 2026-07-30 · 업무 운영 화면 격리·광고주 코드 비열거

- 원인: 공통 `.mi-view`는 비활성 화면을 숨기지만 뒤쪽의 `.mi-work-shell { display:grid }`가 같은 업무 화면에 다시 display를 부여했다. 총관리자 업무 범위 입력은 `ownerCodeSnapshot.clients` 전체를 HTML `datalist`로 직렬화해 클릭만으로 코드 목록이 보였다.
- 화면 수정: `.mi-view:not(.is-active)`를 비활성 화면의 최종 숨김 계약으로 고정하고 업무 grid는 `.mi-work-shell.is-active`에서만 사용한다. `대행사 연결`·`키워드 조회`·`업무 운영` 해시를 각각 로드한 브라우저 검수에서 표시 화면은 각각 해당 화면 1개뿐이고 display는 `block`·`block`·`grid`다.
- 코드 보호: 업무 범위 입력의 `datalist`, `list` 연결, 전체 광고주 코드 렌더링을 제거했다. 입력은 `광고주 코드 직접 입력`, `autocomplete=new-password`이며 다른 메뉴로 이동하면 입력값·불러온 업무 범위를 폐기한다. 업무 API는 기존처럼 입력된 단일 코드를 서버에서 활성 광고주와 대조하고 응답에는 광고주 ID·이름만 사용하며 코드 목록은 포함하지 않는다.
- 자동 검증: 새 기준선 `workOperationViewIsStrictlyScoped`, `workOperationOwnerCodeIsManualAndNonEnumerating`, 역할 5상태, 보호 잠금 21함수·23파일·11마이그레이션, 서버 계약 29/29, API·서버 234/234, 플레이스 수집기 51/51, Production 인증 18/18, 공개 빌드 9파일·인라인 스크립트 6개·CSP 해시 4개와 전체 `npm run check:release` 통과.
- 비변경 범위: `client.html`, Supabase 스키마·운영 데이터·RLS, 업무 API 권한 범위, 순위 수집·계산·저장·크론, 보호 잠금 해시는 변경하지 않았다.
- Production 증거: 기능 코드 `0e8a4b0`, 배포 증거 `f9be8ca`, 최종 배포 `dpl_9qB4m8GJrsEfUPSKWRt6PVLkxcaY`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `f9be8cadf997`·서울 `icn1`·Supabase ready, `/admin`·`/client`는 200, 비인증 `/api/work-items`는 401이다. 운영 브라우저 해시 전환에서도 `대행사 연결`·`키워드 조회`·`업무 운영`은 각각 해당 화면 1개만 표시되고 코드 추천 목록·list 연결은 모두 0건이다.

## 2026-07-30 · 업무 운영 워크플로 1차 로컬 검증

- 권한·공개 계약: 업무는 기본 비공개이며 광고주 미연결 운영팀은 내부 업무만 생성한다. 공개 전환에는 광고주 범위가 필요하고 광고주 응답은 공개 제목·일정·상태·공개 안내만 포함하며 내부 메모·광고주 ID·운영팀 ID·담당자는 제외한다.
- 대상 검증: 업무 전용 단위검사 5/5, 서버 계약 29/29, 역할 상태 회귀, 운영팀·광고주 parity, 보호 잠금 21함수·23파일·11마이그레이션, API·서버 232/232, 플레이스 수집기 51/51, 공개 빌드 9파일·인라인 스크립트 6개·CSP 해시 4개, `git diff --check`와 전체 `npm run check:quality` 통과.
- 미완료 증거: 앱 브라우저와 Chrome 모두 로컬 주소를 보안 정책으로 차단해 역할별 로그인 실화면 육안 검수는 수행하지 못했다. 마이그레이션은 파일만 생성했으며 Production DB에는 적용하지 않았고 push·배포도 하지 않았다.

## 2026-07-27 · 역할·연결 상태 자동 회귀 게이트

- 자동 행렬: 총관리자, 광고주 연결 운영팀, 광고주 미연결 운영팀, 광고주, 해제 운영팀의 5개 상태를 `키워드 조회`, `SEO 확인`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위` 5개 경로와 교차 검증한다. 실제 세션 게이트의 역할·활성 상태 판정도 함께 실행해 해제 운영팀은 401 `SESSION_REVOKED`로 닫힌다.
- 범위 경계: 광고주 전용 보고서 범위와 총관리자 전용 운영팀 관리 경계를 별도로 검사한다. 브라우저가 위조한 운영팀·광고주·순위 접근 헤더는 모두 제거되고 서버가 확인한 단독 운영팀 코드로 교체되는 계약을 상품·플레이스 양쪽에서 검증한다.
- 액션 경로: 광고주 미연결 운영팀은 상품 추적 등록·단건 갱신·중지·삭제·그룹·이동·정렬·대기열 갱신 8개와 플레이스 추적 등록·단건 갱신·그룹·삭제·대기열 갱신 5개 경로에서 광고주 연결 403이 아닌 각 액션의 실제 입력 검증 또는 정상 빈 대기열 응답까지 도달한다. 기존 핸들러 테스트의 생성·갱신·그룹·삭제·이력 계약과 결합해 권한만 통과하고 동작이 빠지는 경우를 함께 막는다.
- 화면·문서: 관리자 단독 운영팀 문구가 키워드·상품 순위·SEO와 두 30일 추적 사용 가능 상태를 표시하고, 광고주 핵심 화면이 모두 남아 있는지 검사한다. 현재 정책과 상충하던 과거 `연결 전 30일 추적 차단` 문구는 운영 문서에서 대체 기록으로 정정했다.
- 전체 검증: `npm run check:release` 통과. API·서버 222/222, 플레이스 수집기 51/51, 서버 계약 28/28, Production 인증 18/18, 역할 parity, 기준선, 공개 빌드/CSP, 보호 잠금 21함수·23파일·11마이그레이션이 통과했다.
- 브라우저 2차 검수: 광고주가 없는 운영팀 모의 세션에서 `N 30일 순위`와 `N 플레이스 30일 순위`를 차례로 열었다. 양 화면의 키워드·URL 입력과 `순위 추적` 버튼이 활성 상태였고 `관리자 코드 확인 후 순위 추적을 사용할 수 있습니다.` 경고는 0건이었다.
- Production 증거: 코드 `afe5bfa`를 GitHub `main`에 푸시했고 Vercel 커밋 상태 `success` 후 운영 별칭에 반영됐다. `/health`는 릴리스 `afe5bfa0a8a3`·서울 `icn1`, `/ready`는 Supabase ready를 반환했다. 운영 관리자·광고주 파일은 로컬 검증 빌드와 SHA-256이 각각 일치하고, 비인증 키워드·SEO·N 상품·N 상품 30일·N 플레이스 30일 API는 모두 401 `SESSION_REQUIRED`다.
- 비변경 범위: Supabase 스키마·운영 데이터·RLS·보호 잠금 해시를 변경하지 않았고, 검증 중 실계정 데이터 생성·수정·삭제를 실행하지 않았다.

## 2026-07-27 · 운영팀 단독 N 상품·플레이스 30일 순위 격리 정상화

- 원인: 광고주 미연결 운영팀을 독립 조회 도구만 허용하는 과거 권한 정책이 두 추적 API를 403으로 막았고, 화면은 이를 `관리자 코드 확인 후 순위 추적을 사용할 수 있습니다.`로 잘못 안내했다. 파일 용량·크롤러·Supabase 과부하 문제가 아니었다.
- 서버 격리: 서버가 검증한 운영팀 코드만 `x-mi-team-code`, `x-mi-agency-code`, `x-mi-rank-access-code`의 내부 신뢰 범위로 주입한다. 두 추적 API는 이 값이 일치하는 운영팀 단독 요청만 `team-account` 범위로 허용하며, 임의 헤더·다른 운영팀·광고주 범위 요청은 거부한다. 광고주 연결 시 기존 광고주 범위 계약을 그대로 사용한다.
- 데이터 확인: Supabase 운영 DB를 읽기 전용으로 조회해 활성 운영팀 3개, 광고주 미연결 2개, 연결 1개를 확인했다. 미연결 운영팀 코드 범위의 기존 상품 추적 2개는 활성 상태로 보존돼 있었으며 DB 데이터·스키마·RLS는 변경하지 않았다.
- 자동 검증: 운영팀 단독·연결 운영팀·광고주·총관리자와 교차 범위 차단 대상 89/89, 전체 API·서버 220/220, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 역할 parity, 기준선, 공개 빌드/CSP, 보호 잠금 21함수·23파일·11마이그레이션과 변조 self-test, 전체 `npm run check:release`가 통과했다.
- 브라우저 2차 검수: 광고주가 없는 운영팀 모의 세션으로 두 메뉴를 차례로 열어 상품 화면 `키워드와 상품 URL을 입력하면 최근 30일 대표 순위를 표시합니다.`, 플레이스 화면 `운영팀 격리 범위 연결 완료`를 확인했다. 두 화면의 비활성 버튼과 기존 관리자 코드 경고는 각각 0건이었다.
- Production 증거: 코드 `70f5c75`·배포 `dpl_ByyyBPzAhoPTEmG7zgZ2awh8YWRo`·운영 별칭 `https://insight.momentlabs.co.kr`. `/health`는 릴리스 `70f5c7574ec9`·서울 `icn1`, `/ready`는 Supabase ready를 반환했다. `/admin`·`/client`는 최종 200이고 검증 빌드와 SHA-256이 각각 일치한다. 비인증 상품·플레이스 추적 API는 모두 401이며 운영 관리자 파일에 과거 관리자 코드 경고가 없고 새 `team-account` 범위 계약이 포함돼 있다.

## 2026-07-26 · 프로젝트 파일 안전 정리·경로 단순화

- 삭제 근거: `dist`, `.vercel/output`, `03_운영시트_템플릿/outputs`, `.DS_Store`는 Git ignored이며 빌드·샘플 생성으로 다시 만들 수 있어 약 18MB를 삭제했다. `.env.local`, `.vercel/project.json`, `.vercel/.env.production.local`, 루트·플레이스 수집기 `node_modules`는 운영·검증에 필요해 보존했다.
- 추적 파일 정리: 현재 정적 HTML·Vercel 구조와 충돌하고 다른 파일에서 참조되지 않는 `docs/00-project-structure.md`, `src/README.md`만 제거했다. 초기 제품·정보 구조·화면·데이터·UI·로드맵·개발·DB 초안 8개는 삭제하지 않고 `docs/planning`으로 이동했다.
- 경로 고정: `00_프로젝트_폴더_가이드.md`와 `docs/README.md`에 현재 상태·다음 작업·작업명세·테스트 증거의 읽기 순서와 화면·서버·DB·수집기 원본 경로를 고정했다. 로컬 Markdown 22개 링크와 핵심 경로 존재, 제거 대상 부재 검사가 통과했다.
- 기능 무손실: 잠금 21함수·23파일·11마이그레이션, API·서버 218/218, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 공개 빌드/CSP와 전체 `npm run check:release`가 통과했다. 검증 빌드가 만든 `dist`를 다시 안전 정리한 후 `npm run clean:workspace:dry`가 정리 대상 0개를 반환했다.
- 비변경 범위: 정리 구현에서는 `src/pages`, `src/server`, `api`, `public`, `supabase`, `tools`의 운영 구현과 DB 데이터·환경변수를 변경하지 않았다. 이후 대표님 승인으로 동일 검증 결과를 Production에 반영했다.
- Production 증거: 코드 `548b997`·배포 `dpl_D73LagXA6oRCJu3CqrHC8MuCGQtj`·운영 별칭 `https://insight.momentlabs.co.kr`. `/health`는 릴리스 `548b9973383e`·서울 `icn1`, `/ready`는 Supabase ready를 반환했다. 운영 관리자·광고주 파일은 검증 빌드와 SHA-256이 각각 일치하고 비인증 키워드·SEO·N 상품·N 상품 30일·N 플레이스 30일 API는 모두 401로 차단됐다.

## 2026-07-26 · 5대 핵심 기능 보호 잠금·3역할 회귀 확장

- 보호 계약: 기존 `키워드 조회`, `N 상품 순위`, `N 30일 순위`, `N 플레이스 30일 순위`에 `SEO 확인`의 공통 점수 엔진·서버 자동 점검 수집기와 운영팀·광고주 조회·평가·표시 진입점을 추가했다. 총 21함수·23파일·11마이그레이션이 승인 없는 변경을 릴리스에서 차단하며 운영 사용자의 신규 조회·점검·추적 등록·갱신은 계속 허용한다.
- 역할 계약: 운영팀·광고주·총관리자는 각자 허용된 범위에서 다섯 기능을 사용한다. 이 릴리스 당시 광고주 미연결 운영팀의 두 30일 추적을 차단했던 계약은 2026-07-27 운영팀 격리 범위 계약으로 대체됐다.
- 자동 검증: 잠금 현재값 검사와 모든 보호 항목 변조·신규 순위 마이그레이션 탐지 self-test, 운영팀·광고주 화면 parity, 총관리자·연결 운영팀·광고주 5기능 API 권한, 기준선, SEO 18/18 포함 대상 31/31, API·서버 218/218, 플레이스 51/51, 서버 계약 27/27, Production 인증 18/18, 공개 빌드/CSP와 전체 `check:release`가 통과했다.
- Production 증거: 코드 `34431f5`·배포 `dpl_AaVnUcMpHonkbS8no3DhSDutzU2g`·운영 별칭 `https://insight.momentlabs.co.kr`. `/health`는 릴리스 `34431f5b2504`·서울 `icn1`, `/ready`는 Supabase ready를 반환했다. 운영 관리자·광고주·SEO 엔진 파일은 검증 빌드와 SHA-256이 각각 일치하고 양 역할 다섯 메뉴를 포함한다. 비인증 키워드·SEO·N 상품·N 상품 30일·N 플레이스 30일 API는 모두 401로 차단됐다.

## 2026-07-24 · Vercel 서울 리전·로그인 세션 지연 최적화

- 실행 지역·격리 계약: Vercel Functions는 `regions=["icn1"]`, Fluid Compute 활성으로 고정했다. `/api/session`은 별도 30초 함수, 나머지 catch-all API는 기존 300초 함수로 분리했다. `/health`는 비밀값 없이 실제 `VERCEL_REGION`을 반환해 배포 후 런타임 지역을 검증한다.
- 로그인 왕복 최적화: 동일 로그인 요청의 IP rate-limit과 IP·계정 rate-limit은 서로 독립된 Supabase RPC이므로 `Promise.all`로 동시에 시작한다. 두 검사는 그대로 모두 수행하며 Production DB 오류는 이전과 동일하게 fail-closed 처리한다.
- 테스트 환경 격리: Vercel Production 변수가 주입된 빌드에서 운영의 `MI_PRIMARY_AGENCY_CODE`·`VERCEL_ENV`가 플레이스 단위 테스트의 고정 계정과 충돌해 5건이 403이 되는 현상을 확인했다. 보호된 플레이스 구현은 수정하지 않고 해당 테스트가 자체 계정·환경을 설정하고 원래 값을 복원하도록 보정했다.
- 자동 검증: 대상 61/61, API·서버 207/207, 플레이스 수집기 51/51, 서버 계약 27/27, Production 인증 18/18, 순위 기능 잠금 13함수·21파일·11마이그레이션, 공개 빌드 9파일·CSP, 일반 환경 전체 `npm run check:release`, 실제 Production 환경변수가 주입된 `vercel build --prod`, `git diff --check` 통과.
- Production 배포: 코드 `31b70e4`·배포 `dpl_DZFaojbvvLfnGVVB7G7bVA3jzSgX`·운영 별칭 `https://insight.momentlabs.co.kr`. Vercel 배포 상세의 API 함수가 `icn1`, 운영 `/health`가 `region=icn1`·릴리스 `31b70e4fb469`를 반환했고 `/ready`는 Supabase ready를 유지했다.
- 운영 연속성 실측: `/health`·`/ready`·비인증 `/api/session`을 각 10회 연속 호출해 30/30 통과, 각 5회 동시 호출해 15/15 통과했다. 연속 p95는 각각 325ms·1,047ms·302ms, 동시 p95는 216ms·251ms·371ms였고 20초 제한 초과·5xx·네트워크 오류는 0건이다. 비인증 세션의 401은 정상 권한 차단으로 판정했다.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, 상품·플레이스 순위 계산·수집·저장·스냅샷, Supabase 스키마와 운영 데이터는 변경하지 않았다.

## 2026-07-24 · 광고주 코드 자동 제안 제거·명시 입력 강제

- 화면 계약: 운영팀·총관리자 광고주 생성 입력란은 `광고주 코드 직접 입력`의 빈 상태로 시작하며 `autocomplete=off`를 사용한다. 서버 목록·운영팀 검증 응답도 다음 광고주 코드를 내려주지 않는다.
- 서버 계약: Owner 직접 생성과 운영팀 연결 생성 모두 광고주 코드가 비어 있으면 `생성할 광고주 코드를 직접 입력해주세요.`와 HTTP 400을 반환한다. `mml93-aXX` 순차 코드 계산·대체 생성 함수는 제거했다.
- 데이터 보존: 기존 광고주 코드·운영팀 연결·세션·DB 행은 수정하거나 재발급하지 않았다. 실제 운영 광고주 생성은 검증 과정에서 실행하지 않는다.
- 전체 검증: 전용 7/7, API·서버 206/206, 플레이스 수집기 51/51, 서버 계약 24/24, 운영팀·광고주 parity, Production 인증 18/18, 보호 기능 잠금 13함수·21파일·11마이그레이션, Vercel 공개 빌드·CSP, 전체 `npm run check:release`, `git diff --check` 통과.
- Production 증거: 코드 `553a880`, 배포 `dpl_34DZvmNhn6mCBam2nEmaQ6nNARrV`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 릴리스 `553a8801e2fa`, live, Supabase ready를 반환했다. 운영 관리자 HTML은 로컬 `dist/admin.html`과 바이트 일치하고 `광고주 코드 직접 입력`·`autocomplete=off`를 포함하며 `다음 광고주 코드`·`nextAgencyCode`는 포함하지 않는다. 비인증 생성 요청은 401로 차단됐다.

## 2026-07-23 · 상품 SEO 트래픽·리뷰 평균·태그·상품정보고시 재정렬

- 점수 계약: 모든 자동 점검이 양호해도 정확 상품 순위가 6위 이하이면 100점을 금지한다. 상위 5위만 트래픽 점수 25/25를 받을 수 있고, 6~10위·11~20위·21~40위·41~100위·101~300위·300위 밖을 구간별 감점한다.
- 대상 회귀: `온열찜질기`와 상품ID `12149720593`의 정확 순위 11위 표본이 100점이 아니며 `트래픽·노출 보완`을 바로 수정할 항목 최상단에 표시하는 자동 검사가 통과했다.
- 리뷰 계약: 같은 키워드 상위 오가닉 상품 중 공개 페이지에서 실제 리뷰 수가 확인된 최대 5개 표본의 산술 평균과 내 상품 리뷰를 비교한다. 표본이 2개 미만이면 평균과 점수 카드를 만들지 않는다.
- 상세 자동 확인: 판매자 태그는 중복 제거 후 최대 10개 충족 여부를 평가한다. 상품정보제공고시는 공개 상품 상세 JSON에서 실제 필드를 읽고 `상세페이지 참조` 문구가 있으면 보완 대상으로 판정한다. 상세 근거가 없으면 통과로 추측하지 않는다.
- 화면 제거: 공식 브랜드·제조사 명칭, 동일 단어 반복, 홍보·가격·배송 문구, 전화번호 사용, 특수문자 사용, 동종 상품 카테고리 6개 카드를 양 역할 점검표와 수정 목록에서 제거했다.
- 전체 검증: SEO 대상 25/25, API·서버 204/204, 플레이스 수집기 51/51, 서버 계약 24/24, 운영팀·광고주 parity, 4대 기능 잠금 13함수·21파일·11마이그레이션, 기준선, 순위·크론·키워드 추이, Vercel 빌드와 공개 CSP, 전체 `npm run check:quality` 통과. 보호된 키워드 조회·N 상품 순위·N 30일 순위·N 플레이스 30일 순위 코드는 변경하지 않았다.
- 캐시·리디렉션 2차 검수: 운영 브라우저가 이전 SEO 자산을 재사용하는 문제를 `seo-v8-20260723` 쿼리로 차단했고, 네이버 모바일 상품 URL이 같은 상품의 데스크톱 URL로 이동할 때 실제 허용 호스트·경로를 보존하도록 보정했다. 후속 전체 검증은 API·서버 205/205, 플레이스 수집기 51/51, 서버 계약 24/24, Production 인증 18/18, 역할 parity·기준선·잠금·공개 빌드/CSP를 통과했다.
- Production 증거: 코드 `6b179a9`·배포 `dpl_CRdGneWLqgpw8KfVvZxKDEuQuBes`·운영 별칭 `https://insight.momentlabs.co.kr`. `/health`와 `/ready`는 릴리스 `6b179a9e51eb`, live, Supabase ready를 반환하고 운영 HTML은 `/seo-evaluation.js?v=seo-v8-20260723`을 로드한다.
- 운영 실조회: 광고주 화면에서 `온열찜질기`·상품 `12149720593`를 조회한 결과 정확 상품 순위 12위, 총점 80, 트래픽 15/25, `트래픽·노출 보완` 최상단, 삭제 대상 6개 카드 0건, 콘솔 경고·오류 0건을 확인했다. 순위는 조회 시점에 변할 수 있으므로 과거 11위 표본을 현재값으로 고정하지 않는다.
- 외부 제한: 같은 시점 네이버 공개 상품 상세·상세 조회는 429 제한을 반환했다. 따라서 리뷰 상위 평균·판매자 태그·상품정보고시의 운영 실데이터 카드는 표시하지 않았고, 통과·실패·100점을 추측하지 않았다. 자동 판정 코드와 단위 회귀는 통과했지만 이 세 항목의 운영 실데이터 확인은 외부 응답 정상화 전까지 미완료로 기록한다.

## 2026-07-23 · NAVER API Hub 이중 호환 준비

- 공식 근거: 네이버 개발자센터의 최신 공지와 NAVER API Hub 명세를 기준으로 Search·Search Trend·Shopping Insight의 Hub 인증 헤더와 경로를 확인했다. 쇼핑 검색은 Hub 이관 제외이며 2026-07-31 24:00 종료·공식 대체 API 없음으로 별도 분리했다.
- 새 계약 검증: `legacy|hub|auto` 공급자 선택, 모드 누락·오타의 legacy 안전 기본값, 공급자별 URL·인증 헤더, nested Hub 오류 파싱, 401/403·404/410·429·5xx 운영 판정을 자동 검사한다. 쇼핑 검색은 Hub 경로로 보내지 않는 회귀도 고정했다.
- 기능 회귀: 새 어댑터·키워드·플레이스 폴백·통합 상태 대상 66/66, 전체 API·서버 178/178, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, N 상품·N 플레이스 30일 보호 잠금·공개 빌드·전체 `npm run check:release`가 통과했다. 변조 차단 self-test와 `git diff --check`도 최종 변경 기준으로 별도 재검증했다.
- 실제 호출: 로컬 legacy 자격증명으로 `써큘레이터?profile=trend`를 호출해 HTTP 200, provider `legacy`, Search Trend·Shopping Insight 정상, 경고 0건을 확인했다. NCP Hub 키가 현재 환경에 없어 Hub 인증 실호출·양 공급자 결과 비교는 완료로 주장하지 않는다.

## 2026-07-22 · 키워드 시장 3지표 프리미엄 요약

- UI 계약: 운영팀·광고주 키워드 조회 결과 상단을 `KEYWORD MARKET` 카드와 기존 연관 키워드 미리보기의 2열 구조로 정리했다. 카드에는 정확 월 검색량, 경쟁 상태, `검색 수요`·`경쟁 강도`·`판매 기회율` 3개 진행 바와 산정 근거·오인 방지 고지만 노출한다. 900px 이하에서는 1열, 520px 이하에서는 간격·문자 크기를 줄인다.
- 산정 계약: 검색 수요는 정확 월 검색량을 로그 스케일 1~100으로 변환한다. 경쟁 강도는 검색광고 경쟁도 60%와 쇼핑 상품수/검색량 포화도 40%를 결합한다. 판매 기회율은 수요 65%와 역경쟁 35%의 참고 점수이며 실제 주문·매출 전환율이 아니다.
- 누락 방어: 네이버가 검색량을 `<10` 같은 범위값으로만 제공하면 `Number(null)=0` 경로를 차단하고 검색 수요·판매 기회율을 `확인 필요`로 유지한다. 경쟁 근거만 있으면 경쟁 강도만 표시하며 데이터를 임의 생성하지 않는다.
- 대상 회귀: 신규 3/3 통과. 모든 점수 0~100 범위, 검색량 범위값 fail-closed, 동일 수요에서 낮은 경쟁의 판매 기회율이 더 높음을 검증했다. 운영팀·광고주 마커와 API `market` 계약을 릴리즈 기준선에 고정했다.
- 모바일 2차 검수: 390px 첫 운영 렌더에서 고정 폭 4열 때문에 연관 키워드가 글자 단위로 줄바꿈되는 결함을 발견했다. 키워드 열 최소 100px·말줄임과 보조 3열을 카드 실사용 폭에 맞춰 양 역할에 동일 적용해 문서·시장 카드·연관 표·3개 지표 바의 가로 넘침을 모두 0으로 유지했으며 해당 CSS를 기준선에 추가했다.
- 전체 릴리스 검사: API·서버 165/165, 플레이스 수집기 51/51, Production 인증 18/18, 역할 query parity, 서버 계약, 순위·크론·키워드 추이, 공개 빌드 8파일·인라인 6개/CSP 해시 4개와 전체 `npm run check:release`를 통과했다.
- 비변경 범위: N 상품·N 플레이스 30일 기능 잠금은 4개 함수·20개 파일·11개 마이그레이션으로 통과했다. 순위 수집·매칭·크론·DB 스키마·기존 추적 행과 이력은 수정하지 않았다.

## 2026-07-22 · 키워드 연령별 쇼핑 클릭 비중 정상화

- 운영 증상: Production `온열찜질기` 조회는 10대 0.2%·20대 4.3%·30대 15.8%·40대 29.0%·50대 이상 50.7%를 `최근 1년 연령별 검색 비율`로 표시했다. 화면 합계는 100%였지만 원본은 절대 클릭 구성비가 아니라 각 월 최고값을 100으로 둔 상대지수였다.
- 공식 근거: NAVER API Hub의 `키워드 연령별 트렌드 조회` 명세는 `/shopping/v1/category/keyword/age`의 `ratio`를 `구간별 결과에서 가장 큰 값을 100으로 설정한 상댓값`으로 정의한다. 따라서 월별 전체 클릭량 가중치 없이 12개월 상대지수를 더한 값은 1년 클릭 구성비로 해석할 수 없다.
- 수정 계약: 최신 완료 월의 한 구간 안에서만 10·20·30·40·50·60대 상대값을 합계 100%로 정규화하고 50·60대를 `50대 이상`으로 합친다. 부분 진행 월은 제외하고, 응답에서 빠진 0값 연령은 0%로 유지하며 완료 월이 없으면 null을 반환한다. API는 `ageBasis`와 실제 `agePeriod`를 제공한다.
- 자동 회귀: 진행 중인 월 제외, 0값 연령 생략 허용, 월말 완료 월 선택, 완료 구간 없음 fail-closed 4개 검사가 모두 통과했다. 전체 API·서버 158/158, 플레이스 수집기 49/49, 서버 계약 22/22, Production 인증 18/18, 역할 query parity, 키워드 추이, 순위, CSP 공개 빌드 8개 파일·인라인 6개/해시 4개와 `git diff --check`를 통과했다.
- 역할 검증: `admin.html`과 `client.html`은 동일하게 `연령별 쇼핑 클릭 비중`, 최신 완료 월 설명, `쇼핑 클릭 비중` 툴팁을 사용한다. 상품·플레이스 순위·30일 저장·로그인·권한·보고서·Supabase 스키마는 변경하지 않았다.
- 운영 배포: 코드 `a4d68f3`, `/health`·`/ready` 릴리스 `a4d68f324d9b`, Supabase ready를 확인했다. Production 관리자·광고주 HTML에 새 제목·설명·툴팁이 모두 존재하고 보호 키워드 API의 비인증 401도 유지된다. 배포 직후 브라우저는 로그아웃 상태여서 인증 데이터의 새 `agePeriod` 실응답은 다음 로그인 조회에서 확인한다.

## 2026-07-22 · 운영팀·광고주 로그아웃 로그인 화면 복귀 정상화

- 원인 확정: 광고주 `logoutClient()`의 성공 경로는 서버 쿠키와 코드만 제거하고 `clearClientAuth()`를 호출하지 않아 루트의 `is-authed`가 남았다. 서버 `/api/session?action=logout`은 기존에도 CSRF를 확인하고 Production·개발 쿠키를 모두 만료시켰으며 응답 어댑터도 복수 `Set-Cookie`를 보존하므로 이번 잔류 화면의 직접 원인은 클라이언트 상태 전환이었다.
- 즉시 안전 전환: 운영팀·광고주 모두 서버 요청을 먼저 시작해 CSRF를 보존한 뒤, 응답을 기다리지 않고 로컬 세션·민감 상태를 지우고 로그인 화면 최상단으로 이동한다. 서버 확인은 요청당 5초, 네트워크/5xx만 최대 2회이며 HTTP 성공과 JSON `ok=true`가 모두 맞아야 완료로 표시한다.
- 비동기 경합 방어: 로그인·복원·보고서 동기화·원본 파일 FileReader/서버 업로드·PPTX 생성·Owner/운영팀 계정 조회/생성/해제·Meta·키워드·SEO·N상품 1회 조회는 요청 시점 generation·role·scope를 캡처한다. 로그아웃 또는 다른 계정 재로그인 뒤 도착한 이전 응답은 화면·다운로드·`currentOperationTeam`·저장소에 반영하지 않는다.
- 교차 계정 초기화: 로그아웃 시 Meta 검색어와 요약, 키워드·SEO 입력, 상품 1회 조회 결과, 상품·플레이스 추적 URL, 검색·그룹 필터와 그룹 임시값을 지운다. 초기 세션 확인은 별도 잠금 함수로 처리해 기존 서버 세션 자동 복원 generation을 바꾸거나 입력을 지우지 않는다.
- 자동 회귀: `roleLogoutAlwaysReturnsToLogin`, `roleLogoutInvalidatesStaleAuthWork`, `roleLogoutBlocksLatePrivilegedAndToolResponses`, `clientLoginButtonsRespectSessionGeneration`, `clientSessionRestoreKeepsInitialGeneration`, `adminLoginFailureCanRetry` 기준선을 추가했다. 광고주·운영팀 인라인 스크립트 문법, 로그아웃 세션·CSRF·쿠키 계약, `git diff --check`를 통과했다.
- 전체 릴리스 검사: API·서버 154/154, 플레이스 수집기 44/44, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 순위 매칭, CSP 공개 빌드 8개 파일·인라인 스크립트 6개/해시 4개를 통과했다. 기존 상품·플레이스 순위 수집·스냅샷·DB는 변경하지 않았다.
- 2차 검수: 초기 자동 복원, 로그인 재시도 버튼, 모든 민감 도구 응답·다운로드, Owner/운영팀 계정 작업과 교차 계정 입력 초기화를 적대적으로 재검수해 P0/P1 0건을 확인했다.
- 운영 배포: 코드 커밋 `b052e85`, `/health`·`/ready` 릴리스 `b052e8597fb4`, Supabase ready, `/client`·`/admin` 200, 실제 상품·플레이스 추적 보호 API 비인증 401, 새 admin/client CSP 해시 일치를 확인했다.
- 실제 브라우저: 기존 `우노헬스케어` 광고주 서버 세션이 자동 복원되는 것을 확인한 뒤 로그아웃 버튼을 클릭했다. 즉시 로그인 화면으로 전환돼 `로그아웃되었습니다. 다른 대행사 코드를 입력해주세요.`가 표시됐고 입력창으로 초점이 이동했으며, 새로고침 뒤에도 로그인 화면 잠금이 유지됐다. 운영팀 페이지도 로그인 잠금 상태였고 양 페이지 콘솔의 사이트 오류는 0건이다. 운영팀 인증 세션의 실제 클릭은 별도 로그인 비밀값을 사용하지 않고 자동·독립 검수 근거로 한정했다.

## 2026-07-20 · 플레이스 실목록 오가닉 순위 근거 정상화

- 증상·DB 근거: 같은 키워드가 이전에는 62개였으나 최신 배치에서 9개만 확인됐고, `홍대 맛집`/`1907427831`은 미리보기 배열 7번째를 실제 7위처럼 저장했다. `부평 맛집`/`2019299673`도 9개 미리보기와 실제 목록이 달랐다.
- 원인 확정: 네이버 `/p/api/search/allSearch`는 지도 마커 미리보기이며 PC 장소 목록의 오가닉 정렬과 일치하지 않는다. 기존 selector fallback이 이 후보를 실제 목록 후보와 합쳐 미리보기 index를 순위로 확정했다.
- 추가 원인: 가상 목록을 처음부터 끝으로 점프하면 중간 장소 행이 DOM에 나타나지 않았고, `querySelectorAll("li")`는 실제 장소 카드 안의 `새로 오픈했어요` 중첩 프로모션 행까지 업체로 읽었다. 겹침 단계 스크롤로 모든 viewport를 수집하고 목록 최상위 `li`만 순위 후보로 제한했다.
- selector·타임아웃 재현: selector를 1ms로 강제 실패시킨 실조회에서 최초 9개 뒤 겹침 수집 68회로 100개까지 확장했고 top10 ID가 정상 경로와 10/10 일치했다. 정확 ID가 있는 상태로 `placeName`만 비운 실조회도 불필요한 상세 식별을 건너뛰어 39.827초·100개·rank null로 종료됐다. DOM 추출 오류는 빈 viewport로 삼지 않고 fail-closed로 재시도한다.
- 실목록 교차확인: 최종 독립 Chromium 세션과 수집기를 같은 시점에 대조했다. `홍대 맛집` 대상 `1907427831`은 양쪽 모두 오가닉 7위이고 top10 ID·순번 10개가 전부 일치했다. `부평 맛집` 대상 `2019299673`은 양쪽 모두 공개 목록 상위 100개에 없고 top10이 전부 일치했다. 프로모션에서 유입된 ID 없는 후보는 0개다.
- 수집 계약: 미리보기 후보는 순위 근거로 사용하지 않고 실제 `#_pcmap_list_scroll_container` 내부 최상위 행만 인정한다. ID 없는 실제 오가닉 행은 순번 슬롯으로 유지하되 body 메뉴·중첩 프로모션은 제외해 앞당김·밀림을 모두 막는다. 정확 대상 ID가 없으면 이름 유사도로 대체하지 않는다.
- 부분 조회: 300개를 완주하지 못한 미발견은 `complete=false`, `partial=true`, `rank=null`, `current_rank=null`로 저장하고 5분부터 재시도한다. 불완전 후보 목록은 캐시하거나 동일 키워드의 다른 추적 항목으로 전파하지 않는다.
- UI 계약: 운영팀·광고주 모두 부분 조회를 `N개 확인 · 이후 미검증`으로 표시한다. 최신 스냅샷이 null이면 현재 순위뿐 아니라 상태 요약·점검 필터·상승/하락·권고도 과거 `currentRank`를 사용하지 않는다. 두 역할 전용 helper·적용 경로·CSP 해시는 일치한다.
- 공개 범위 한계: 네이버 PC 공개 목록은 두 실조회 모두 오가닉 100개에서 종료돼 `complete=false`다. 따라서 확인된 순위는 정확히 기록하지만 미발견 대상의 101~300위는 `N개 확인 · 이후 미검증`으로 유지하고 5분부터 재시도한다.
- 자동 검증: API·서버 153/153, 플레이스 tracker 계약 42/42, 수집기 42/42, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 순위 매칭, 릴리즈 기준선, CSP 공개 빌드, `git diff --check` 통과. 미리보기 오인, ID 없는 실제 행의 순위 압축, body 메뉴·중첩 프로모션의 순위 팽창, 가상 목록 끝 점프, selector fallback 확장, DOM 추출 fail-closed, known-ID identity 생략, drain-mode degraded summary 전달을 각각 회귀 테스트로 고정했다.
- 2차 검수: 순위 수집·서버 저장·양 역할 UI를 분리 검수해 P0/P1 0건을 확인했다. 상품 N30 렌더 구간은 HEAD와 바이트 해시가 같고 상품 백엔드 diff도 없다. 기존 추적 행과 30일 스냅샷은 삭제·초기화하지 않았다.
- 운영 큐 재현: Vercel `8f0c6b5`·Render v14 반영 후 활성 13건의 `next_check_at`만 앞당겨 이력 비삭제 재수집을 실행했다. 첫 `부평맛집` 건은 오가닉 1위로 정상 저장됐지만 다음 `종로한의원` selector timeout 1건에서 workflow가 즉시 실패해 뒤의 11건이 미처리로 남았다.
- 큐 보강 계약: 개별 tracker 실패는 서버의 오류·지수 재시도 계약을 그대로 유지하면서 workflow가 다음 batch를 계속 처리한다. `totals.failed`는 queue drain 뒤 최종 실패로 보고하므로 오류가 성공처럼 숨겨지지 않는다.

## 2026-07-20 · 플레이스 검색결과 전체 업체 지표 정상화

- 원인: 수집기는 후보별 방문자·블로그 리뷰 값을 읽고 있었지만 대상 매장 또는 상위 일부 후보만 스냅샷에 전달했고, 양 역할 화면은 값 없음의 fallback `null`을 `Number(null)=0`으로 바꿔 실제 0처럼 표시했다. 외부 수집 경로에는 월검색량 보조 조회도 연결되지 않았다.
- 수집 계약: 광고를 제외한 실제 확인 오가닉 후보 전체에서 블로그·방문 합계를 계산하고 `scope=organic_search_results`, `businessCount`, 각 지표의 `knownCount/totalCount` coverage를 저장한다. 일부 후보 값이 누락되면 해당 합계는 null이며 명시적 0만 0으로 보존한다.
- 성능 보존: 합계는 전체 후보에서 계산하지만 `topPlaces` 저장은 기존 20개 제한을 유지한다. 신규 DB 컬럼·마이그레이션·기존 30일 스냅샷 재작성은 없다.
- 월검색량: 네이버 지도 응답에는 월검색량 필드가 없음을 실응답에서 확인했다. 서버가 기존 Search Ads 자격으로 키워드 월검색량을 별도 조회해 외부 수집 결과와 병합하고, 실패 시 리뷰·업체 지표 저장을 방해하지 않는다. `<10`처럼 범위로만 제공되는 값은 상한을 정확한 수치로 오인하지 않도록 null로 보존한다.
- 실조회 1: `부평 맛집`/플레이스ID `2019299673`은 대상 미발견·부분 조회를 유지하면서 오가닉 54개 전체 coverage 54/54, 블로그 56,310개·방문 173,749개·업체 54개를 반환했다.
- 실조회 2: `강남 맛집`은 오가닉 54개 전체 coverage 54/54, 블로그 61,503개·방문 145,192개·업체 54개를 반환했다.
- 자동 검증: 플레이스 서버 41/41, 수집기 35/35, 전체 API·서버 152/152, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 릴리즈 기준선, CSP 공개 빌드, `git diff --check` 통과. 불완전·불일치 coverage 합계 거부와 검색량 `<10` 비확정 처리를 별도 회귀 테스트로 고정했다.
- 역할 검증: 운영팀·광고주 `placeSnapshotMetric`·일별 카드 출력은 동일하며 누락은 `-`, 명시적 0은 `0`으로 표시한다. 상품 순위·플레이스 순위 판정·광고 제외·기존 30일 이력은 변경하지 않았다.

## 2026-07-19 · 부평 맛집 플레이스·상품 원부 연속 추적 정상화

- 플레이스 대상: 키워드 `부평 맛집`, 정확 플레이스ID `2019299673`. 공식 상세 페이지에서 상호명 `팽오리농장 부평점`을 확인했다.
- 플레이스 실조회: 광고 제외 네이버 공개 목록 54개를 확인했으나 정확 ID는 없었다. 결과를 `complete=false`, `partial=true`로 유지해 300위 미노출을 거짓 확정하지 않고 기존 확정 순위를 보존한다.
- 플레이스 보완: 정확 ID가 있으면 같은 이름의 다른 ID와 ID 없는 후보를 거부하고, 입력 URL의 `lng/lat` 좌표와 좌표별 캐시를 사용한다. 외부 제공자의 일치 응답도 동일한 명시 ID를 필수로 하며 원본 오가닉 순위를 재번호화하지 않는다.
- 플레이스 상호명: 공식 모바일 상세의 리다이렉트와 최대 768KiB 응답을 제한적으로 읽어 상호명을 채우며, 네이버 응답 끝의 제어문자는 저장 전에 제거한다.
- 상품 대상: 상품ID `12649811979`, 최근 확정 원부ID `57907660073`. 과거 스냅샷의 `matched=true`, `rankPolicy=organic_only`, `adExcluded=true`, `trackingRankSource=related_catalog`을 모두 충족한 정확 원부ID만 이어받는다.
- 상품 실조회: `음파 전동칫솔` 원부 15위, `전동칫솔` 원부 25위, 정확 판매자 상품은 두 키워드 모두 상위 300위 밖이다. 정확 상품과 검증 원부는 같은 300개 응답에서 비교하며 제목이 비슷한 다른 원부와 광고 후보는 제외한다.
- 데이터 보존: `naver_rank_trackers`, `naver_place_rank_trackers`와 기존 스냅샷을 삭제·초기화하지 않았다. `admin.html`, `client.html`도 변경하지 않았다.
- 자동 검증: `npm run check:release` 통과. API·서버 147/147, 플레이스 수집기 32/32, 서버 계약 22/22, Production 인증 18/18, 공개 빌드와 `git diff --check` 통과.
- 복구 지점: 원격 태그 `checkpoint/rank-hotfix-20260719-2048`은 커밋 `3fb98b9`를 가리키며 `recovery:verify --quality`를 통과했다.
- 운영 배포: `/health`·`/ready` 릴리즈 `3fb98b9e4622`, Supabase ready, Render 릴리즈 `2026-07-19-exact-id-coordinate-rank-v11`, 관리자·광고주 HTTP 200, 보호 순위 API 비인증 401.
- 운영 상품 저장: `음파 전동칫솔` 현재 15위, `전동칫솔` 현재 25위. 두 최신 스냅샷 모두 원부ID `57907660073`, `checked_count=300`, `matched=true`, `trackingRankSource=related_catalog`, `rankPolicy=organic_only`, `adExcluded=true`다.
- 운영 플레이스 저장: 플레이스ID `2019299673`의 상호명은 `팽오리농장 부평점`, 현재·최고·최저 순위는 미검증이므로 null을 유지한다. 공식 GraphQL `start=71` 재요청은 HTTP 429여서 54위 이후를 임의 계산하지 않았다.

## 2026-07-15 · 메인 기능 쇼케이스 우선순위·그룹 보정

- 요청: 기능 쇼케이스를 신뢰 기준보다 먼저 노출하고, 현재 지표와 30일 추적을 별도 카드 묶음으로 구분하며 네이비 배경을 더 프리미엄하게 보정한다. 배포는 하지 않는다.
- 순서: `Hero → Product Intelligence → Trust Standard → Workflow → CTA`. 1440px 기준 기능 섹션 상단 744px, Trust 상단 1,795px로 기능이 먼저 노출된다.
- 그룹: `현재 데이터`는 오가닉 상품 순위·키워드 시장 분석 2장, `30일 순위 추적`은 상품 순위 추적·플레이스 순위 추적 2장으로 고정했다.
- 색감: `#071421 → #0a1e36 → #102b4b` 저채도 잉크 네이비, 약한 우측 하이라이트, 얇은 인셋 보더와 흰 카드로 위계를 분리했다.
- 데스크톱 1440×900: 두 그룹 각 2카드, 문서 가로 넘침 0, 기능/Trust 순서 정상, 콘솔 로그 0건.
- 모바일 390×844: 두 그룹이 세로로 분리되고 각 그룹 내부만 독립 가로 탐색(`clientWidth=313`, `scrollWidth=545`). 카드 4장의 내부 오버플로와 문서 가로 넘침 모두 0건.
- 회귀 기준선: `homeFeatureShowcasePriorityAndGroups=true`. 섹션 순서뿐 아니라 snapshot에 rank+keyword, tracking에 trend+place만 존재하는지 직접 검사한다. `homeAnonymousFeatureShowcase=true`도 유지한다.
- 독립 2차 검토: 순서·그룹·프리미엄 톤·반응형·익명화·기능 비변경에서 차단 이슈 없음.
- 비변경 범위: 팝업, `admin.html`, `client.html`, 순위 수집·매칭·저장·크론, Supabase·운영 데이터 변경 없음.
- Production: 커밋 `9cdbaad`, `momentinsight-8rljvs8ue-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 검증: `/health`·`/`·`/home.html`·`/admin.html`·`/client.html` HTTP 200, health `ok=true`·`supabaseReady=true`, 운영 HTML과 로컬 `dist` SHA-256 일치. 1440×900·390×844에서 그룹별 2카드·가로 넘침·카드 잘림·콘솔 오류 0건.

## 2026-07-15 · 메인 홈페이지 익명 기능 쇼케이스

- 요청: 상품 오가닉 단건, 상품 30일 추적, 플레이스 30일 추적, 키워드 시장 분석·차트를 메인 홈페이지에서 짧고 프리미엄하게 소개하되 실제 광고주 자료는 노출하지 않는다.
- 구성: `For Brand Growth` 3카드와 `Core Features` 4카드를 삭제하고 `Product Intelligence` 단일 섹션의 4개 예시 카드로 교체.
- 익명화: `예시 키워드 A/B/C`, `예시 상품 A`, `예시 매장 A`만 사용. 실제 고객명·상품명·키워드·가격·상품ID·원부ID·플레이스ID·조회 시각·외부 링크·스크린샷·상품 이미지는 포함하지 않음.
- 표시 고지: `data-mi-showcase-privacy=synthetic-only`, `예시 데이터`, `실고객 정보 미사용`, 모든 화면·명칭·수치가 기능 설명용 예시라는 문구를 함께 표시.
- 데스크톱 1440×900: 카드 4개가 2×2로 노출되고 1행 619×246px/439×246px, 2행 619×281px/439×281px. 문서 `scrollWidth=clientWidth=1425`, 전체 높이 3,107px.
- 모바일 390×844: 4개 카드가 각각 277×277px의 한 줄 가로 탐색으로 렌더링되고 첫·마지막 카드 육안검수 통과. 쇼케이스 375×725px, 내부 패널 347×423px, 문서 `scrollWidth=clientWidth=375`, 전체 높이 3,729px.
- 콘텐츠 검사: 쇼케이스 카드 4개, `<img>` 0개, 외부 링크 0개, 내부 텍스트 오버플로 0건, 브라우저 콘솔 로그 0건.
- 독립 2차 검토: 실제 광고주·상품·키워드·매장·ID·URL·이미지 노출, HTML/CSS 이상, 문서 가로 넘침, 운영/광고주·순위 기능 변경 차단 이슈 없음.
- 개인정보 기준선: 실고객 문자열 NFKC 정규화 차단, 9자리 이상 숫자, 외부 URL, 상품/원부/플레이스 ID 문구, 임시 파일·스크린샷 경로 금지. `homeAnonymousFeatureShowcase=true`.
- 자동 검사: `npm run check:quality`, `npm run build:vercel`, `git diff --check` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 비변경 범위: `admin.html`, `client.html`, `src/server`, 플레이스 수집기, Supabase·운영 데이터 변경 없음.
- 배포: 커밋 `8d78d01`을 포함한 최종 `9cdbaad` Production `momentinsight-8rljvs8ue-momentlabs.vercel.app` · 운영 별칭 반영 완료.

## 2026-07-15 · 메인 홈페이지 프리미엄 보완 2차

- 범위: `src/pages/home.html`, 홈페이지 전용 릴리즈 기준선, 운영 문서만 변경. `admin.html`, `client.html`, 순위 수집·매칭·저장·크론·Supabase 코드는 변경하지 않음.
- 문서 기반: `<!doctype html>`, `lang=ko`, viewport, body 여백 초기화 적용. 브라우저 계산 body margin `0px`.
- 팝업 보존: 데스크톱 1440×900에서 348×489px·x72·y118, 모바일 390×844에서 높이 489px·x14·y82·좌우 14px. 외곽 위치·너비 규칙·헤더/본문 여백, 다섯 기능, 카카오 링크, 저장 키와 7일 계산식 유지.
- 팝업 동작: 닫기 버튼과 `1주일 동안 안보기` 버튼을 각각 실행해 `is-hidden=true` 확인.
- 데스크톱: 고정 헤더 69px, 샘플 대시보드 528×529px, CTA 주 행동 버튼 흰색 배경/딥네이비 글자, 문서 `scrollWidth=clientWidth=1425`, 브라우저 콘솔 로그 0건.
- 모바일: 헤더 65px 한 줄, 버튼 2개 동일 행, 샘플 대시보드 347×494px. 반복 3개 카드는 내부 가로 탐색으로 정리하고 페이지 높이를 검증 환경 기준 약 5,498px에서 4,220px로 압축. 문서 `scrollWidth=clientWidth=375`, 외부 가로 넘침 0건.
- 시각 확인: 딥네이비·화이트·절제된 블루 계층, 핵심 매출 카드 강조, 연결형 신뢰 패널·운영 흐름, 실제 경로만 둔 푸터를 1440×900·390×844에서 육안 검수.
- 릴리즈 기준선: `homeDocumentShellAndViewport=true`, `homePopupGeometryPreserved=true`, `homePremiumHierarchyVisible=true`, 기존 `homeDevelopmentNoticeVisible=true`.
- 자동 검사: `npm run check:quality`, `npm run build:vercel`, `git diff --check` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 배포: 커밋 `530839f`를 포함한 최종 `9cdbaad` Production `momentinsight-8rljvs8ue-momentlabs.vercel.app` · 운영 별칭 반영 완료. 거절된 `0886833`은 미사용.

## 2026-07-15 · N 30일 순위 슬롯 `상품` 문구 정리

- 요청: 일별 오전·오후 슬롯의 `PM · 상품`에서 중복되는 `상품` 문구를 제거한다.
- 수정 범위: 운영팀·광고주 `renderRankSlot()`에서 정확 상품 슬롯만 `PM`·`AM`으로 표시. 관련 원부는 `PM · 원부`·`AM · 원부`로 유지.
- 기능 보존: `rankSnapshotSourceLabel()`과 카드 상단 상품/원부 표시, 순위 조회·저장·갱신·크론·광고 제외·대표값 판정·Supabase 데이터 코드는 변경하지 않음.
- 런타임 함수 검사: 양 역할 모두 정확 상품 `<small>PM</small><b>9위</b>`, 관련 원부 `<small>AM · 원부</small><b>8위</b>` 출력.
- 릴리즈 기준선: `rankTrackingDailySlotOmitsExactProductLabel=true`, 기존 `rankTrackingDailySlotAlignment=true` 유지.
- 브라우저 빌드: 광고주 390px `scrollWidth=390`, 운영팀 데스크톱·광고주 모바일에서 신규 마커 반영, 구 문구 제거, 콘솔 오류 0건.
- 자동 검사: 전체 `npm run check:quality` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 배포 커밋: `368408d`만 `main`에 푸시.
- Production: `momentinsight-jly55k3zm-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY. `/health` HTTP 200·`ok=true`.
- 운영 소스: `/admin.html`·`/client.html`·`/home.html`이 `368408d` 산출물과 바이트 단위로 일치하고, 두 역할 HTML 모두 신규 조건식 1개·구 조건식 0개.
- 운영 브라우저: 로그인 운영팀·광고주 `N 30일 순위` 각 414개 일별 슬롯에서 정확 상품의 `상품` 문구 0건, `PM`·`AM` 및 원부 구분 유지, 콘솔 오류 0건.
- 배포 후 자동 작업: GitHub 품질 검사, 상품 순위 갱신, 플레이스 순위 갱신 모두 성공.
- 로컬 이력: 사용자 거절 커밋 `0886833`의 홈페이지·기준선·작업 문서 변경을 `main`에서 제거하고, 현재 홈페이지 소스가 `origin/main`과 일치함을 확인.

## 2026-07-14 · N 30일 순위 오전·오후 행 정렬 복구

- 증상: `PM · 상품` 또는 `AM · 원부`처럼 선택 기준이 붙은 슬롯 라벨만 고정 폭에서 두 줄로 접혀 해당 순위 숫자가 인접 순위보다 아래에 표시됨.
- 원인: `.mi-rank-day-slots small`에 한 줄 제약이 없고, 108px 일별 카드의 반쪽 슬롯에서 기준 문구 너비가 사용 가능 폭을 초과함.
- 수정 범위: 운영팀·광고주 일별 슬롯 CSS의 수평 여백, 라벨 크기, `white-space`·오버플로 처리와 릴리즈 기준선만 변경.
- 기능 보존: 순위 조회·저장·갱신·자동 크론·광고 제외·원부/상품 대표 순위·Supabase 데이터 코드 변경 없음.
- 운영팀 로컬 저장 데이터: 보이는 일별 카드 207개, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 광고주 로컬 저장 데이터: 보이는 일별 카드 207개, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 390px: 운영팀·광고주 오전·오후 순위 상단 좌표 최대 차이 0px, 슬롯 라벨 오버플로 0건.
- 브라우저: 양 역할 데스크톱·390px 콘솔 경고/오류 0건, 육안 확인에서 `PM · 상품`과 `AM` 순위가 같은 행으로 표시됨.
- 자동 검사: `rankTrackingDailySlotAlignment=true`, 전체 `npm run check:quality` 독립 2회, 서버 13/13, 플레이스 수집기 25/25, 릴리즈 기준선·순위 매칭·크론·Vercel 정적 빌드 통과.
- `git diff --check`: 통과.
- 커밋: `01935d2` (`fix: align Naver rank daily slots`)을 `main`에 푸시.
- Production: `momentinsight-fhgibit9c-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 HTTP: `/health`·`/admin.html`·`/client.html` HTTP 200, 두 HTML의 한 줄 라벨·오버플로 방지 CSS 마커 확인.
- 운영팀·광고주 데스크톱: 각 207개 일별 카드, 오전·오후 순위 상단 좌표 최대 차이 0px, `PM · 상품` 포함 라벨 오버플로 0건.
- 운영팀 390px: 207개 일별 카드, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 운영 브라우저: 운영팀 데스크톱·390px, 광고주 데스크톱 콘솔 경고/오류 0건. 육안으로 첫 카드의 PM 4위·AM 4위 동일 행 확인.

## 2026-07-14 · 플레이스 30일 순위 컴팩트 프리미엄 UI

- 범위: 운영팀·광고주 `네이버 플레이스 30일 순위` 카드의 정보 밀도와 반응형 표시만 변경. 순위 수집·매칭·광고 제외·저장·갱신·삭제·그룹·공유 로직은 변경하지 않음.
- 데스크톱: 두 역할 모두 첫 카드 858×264px, 헤더 856×46px, 상태 영역 856×68px, 일별 셀 140×129px.
- 모바일 390px: 두 역할 모두 첫 카드 248×285px, 헤더 246×95px, 상태 영역 246×43px, 일별 셀 140×127px.
- 반응형: 문서 `scrollWidth=390`, 일별 기록과 상태 배지만 카드 내부 가로 탐색을 사용. 긴 수치 셀 오버플로 0건.
- 육안 확인: 딥네이비 현재 순위, 절제된 그레이 보조지표, 낮은 그림자와 작은 라운드, 헤더 2행·상태 1행 구조가 운영팀·광고주에서 동일하게 렌더링됨.
- 브라우저: 운영팀·광고주 데스크톱·390px 콘솔 경고/오류 0건.
- 릴리즈 기준선: `placeRankPremiumCompactCards=true`.
- 자동 검사: 전체 `npm run check:quality` 독립 2회 통과. 각 실행에서 서버 13/13, 플레이스 수집기 25/25, 릴리즈 기준선·서버 문법·크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 통과.
- `git diff --check`: 통과.
- 커밋: `7710008` (`style: compact Place rank tracking cards`)을 `main`에 푸시.
- Production: `momentinsight-m19imug8x-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 HTTP: `/health` 200, 리다이렉트 후 `/admin.html`·`/client.html` 최종 200, 두 HTML의 140px 카드·2×2 지표 마커 확인.
- 운영 데스크톱: 운영팀·광고주 모두 첫 카드 858×264px, 일별 셀 140×129px, 긴 수치 오버플로 0건.
- 운영 390px: 운영팀·광고주 모두 첫 카드 248×285px, 상태 영역 246×43px, 일별 셀 140×127px, 문서 `scrollWidth=390`, 상태 영역 `nowrap`, 긴 수치 오버플로 0건.
- 운영 브라우저: 운영팀·광고주 데스크톱·모바일 콘솔 경고/오류 0건.

## 2026-07-14 · 써큘레이터 원부 누락 원인 및 모델 식별 보강

- 대상: 키워드 `써큘레이터`, 판매자 상품 URL `https://smartstore.naver.com/eco/products/11687310806`.
- 원인: 정확 상품 제목에는 `서큘레이터`가 있지만 가격비교 원부 제목 `파세코 PCF-MSF1100 화이트`에는 키워드가 없어 기존 `keywordEvidence` 공통 포함 조건이 실제 원부를 누락했다.
- 보강: 원부 후보는 가격비교 원부형, 모델번호 정규화 완전 일치 또는 기존 키워드 근거, 브랜드·제조사·판매처 식별 근거, 상위 카테고리 일치를 모두 통과해야 한다.
- 오탐 방지: `PCF-MSF1100`과 접두가 유사한 다른 모델 `PCF-MSF11000`은 관련 원부로 연결하지 않는다.
- 공식 API 실조회: 원부 `53687717527` 8위, 정확 판매자 상품 `11687310806` 59위, 300개 확인, 대표 `related_catalog` 8위·원부형.
- 로그인 아이템스카우트 교차확인: 같은 시점 원부 9위·정확 상품 60위. 조회 시점 차이 1칸 범위에서 동일 두 상품과 우선순위를 확인했다.
- 회귀 실조회: `치아미백제`/`5145848584` 원부 9위·정확 상품 44위, `전동 칫솔`/`12649811979` 원부 34위·정확 상품 163위.
- 운영팀·광고주 로컬 빌드 실조회: 두 역할 모두 대표 원부 8위·정확 상품 59위, 1페이지 8위·2페이지 19위, 카드 2건과 각 키워드/상세 링크 정상.
- 반응형·브라우저: 광고주 390px에서 `scrollWidth=390`, 결과 카드 가로 넘침 없음. 운영팀·광고주 콘솔 경고·오류 0건, 두 화면 육안 확인 통과.
- 자동 검사: `check:rank-matching`, 전체 `check:quality` 독립 2회, 서버 13/13, 플레이스 수집기 25/25, Vercel 정적 빌드, `check:env:naver`, `check:supabase`, `git diff --check` 통과.
- `admin.html`, `client.html`, Supabase 스키마·RLS·Storage·운영 데이터는 수정하지 않았다.
- 커밋·배포: `d9b97ca`를 `main`에 푸시하고 Production `momentinsight-cjx4bkodl-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 검증: `/health`와 순위 API HTTP 200, 대표 원부 `53687717527` 8위·정확 판매자 상품 `11687310806` 59위·`checkedCount=300`·`rankPolicy=organic_only`.
- 운영팀·광고주 실화면: 두 역할 모두 원부 8위·정확 상품 59위 카드, 상품명 키워드 검색 링크와 각 상세 링크 정상, 콘솔 경고·오류 0건. 광고주 390px `scrollWidth=390`.

## 2026-07-14 · 상품 순위 추적 광고 완전 제외

- 코드 경로: 단건 검색 배열 → 관련 원부·정확 상품 후보 → 30일 대표값 → 수동/자동 `runTrackerCheck` → Supabase 스냅샷까지 동일 오가닉 정책 적용
- 광고 혼입 차단: `isAdProduct`, `adId`, sponsored/paid, `supersaving`, `brand_ad` 후보는 순위·대표값·상위 결과에서 제거
- 오탐 방지: 실제 오가닉 상품에도 존재한 `cr.shopping.naver.com/adcr` 링크와 `organic_expose_order` 조합은 광고로 오판하지 않음
- 로그인 네이버 가격비교 `전동칫솔` 1페이지: `product` 40개, 별도 `supersaving` 5개, product 순번 1~40 연속 확인
- 광고 혼합 단위검사: 광고 정확 상품 1위·광고 원부 1위는 무효, 뒤의 오가닉 정확 상품 10위 또는 원부 7위만 대표값으로 선택
- 실조회 `전동칫솔`: 대표 원부 34위, 정확 상품 167위, 300개 확인, 노출 카드 모두 `isAd=false`, `isOrganic=true`
- Supabase 실제 추적 갱신 `치아미백제`: 대표 원부 8위, 정확 상품 44위, 300개 확인
- Supabase 최신 스냅샷: `rankPolicy=organic_only`, `adExcluded=true`, 대표 `isAd=false`, 대표 `isOrganic=true`, `top_items` 5개 전부 오가닉
- `npm run check:env:naver`, `npm run check:supabase`, `check:rank-matching`, `check:baseline`, 서버 문법, `git diff --check`: 통과
- 전체 `npm run check:quality`: 독립 2회 통과. 각 실행에서 서버 13/13, 플레이스 수집기 25/25, 크론·순위·키워드·Vercel 빌드 통과
- 관리자·광고주 로컬 빌드 화면: 두 역할 모두 광고 제외 40개 보기 안내, 오가닉 추적 UI·최근 기록 렌더링 정상
- Supabase 스키마·RLS·Storage 변경 없음. 유효한 신규 스냅샷 1건만 기존 추적에 추가
- 배포 커밋: `032c144`
- Production: `momentinsight-iddnfo068-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`: HTTP 200
- 운영 단건 API `전동칫솔`: 대표 원부 34위, 정확 상품 166위, 300개 확인, `rankPolicy=organic_only`, 모든 노출·상위 항목 오가닉
- 운영 추적 `치아미백제`: 대표 원부 8위, 정확 상품 44위, 300개 확인, 최신 스냅샷 `adExcluded=true`
- 운영 Supabase 직접 조회: 대표 `isAd=false`·`isOrganic=true`, `top_items` 5개 전부 오가닉
- 운영 광고주 화면: 현재 8위·원부, 자동추적 정상, 다음 오전 9시, 광고 제외 안내와 레이아웃 정상

## 2026-07-14 · 상품 30일 대표 순위 원부 비교

- 선택 규칙: 정확 상품과 관련 원부 중 숫자가 더 낮은 공식 API 순번을 30일 대표 순위로 저장한다.
- 단위검사:
  - 상품 48·원부 7 → 대표 7, `related_catalog`
  - 상품 5·원부 12 → 대표 5, `exact_product`
  - 원부 후보 11·8 → 대표 원부 8, 무관 후보 3은 제외
- 로컬 공식 API 실조회:
  - `치아미백제`: 정확 상품 43, 관련 원부 9, 대표 9, 300개 확인
  - `치아미백`: 정확 상품 60, 관련 원부 14, 대표 14, 300개 확인
- 기존 단건 조회의 대상 상품ID와 상품 ID 일치 판정은 변경하지 않는다.
- 기존 과거 스냅샷은 관련 원부 원본이 없어 소급 변경하지 않는다.
- `check:rank-matching`, `check:baseline`, 서버 문법, `git diff --check`: 통과
- 전체 `npm run check:quality`: 독립 2회 통과
  - 서버 테스트 13/13, 플레이스 수집기 테스트 25/25, 릴리즈 기준선·순위 매칭·크론·키워드 트렌드·Vercel 빌드 통과
- 관리자·광고주 소스와 `dist` 빌드 HTML: 인라인 스크립트 문법, 비교 안내, `related_catalog`, 현재 출처, 오전·오후 출처 마커 통과
- 로컬 인앱 브라우저와 Chrome은 `localhost` 접근이 보안 정책으로 차단돼 우회하지 않았다. 운영 배포 후 실제 도메인 육안 검수가 필요하다.
- 배포: 현재 작업의 별도 배포 지시 전 대기

## 2026-07-14 · 네이버 상품 페이지 오표기 배포 전 재검증

- 대상 1: `전동칫솔` / 판매자 상품ID `12649811979`
  - 공식 API 결과 순번 168, 관련 원부 34, `checkedCount=300`
  - `matchedProductId=12649811979`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- 대상 2: `치아미백제` / 판매자 상품ID `5145848584`
  - 공식 API 결과 순번 43, 관련 원부 9, `checkedCount=300`
  - `matchedProductId=5145848584`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- `npm run check:quality` 독립 2회 통과
  - 서버 테스트 13/13, 플레이스 수집기 테스트 25/25, 순위 매칭·기준선·크론·키워드 트렌드·Vercel 빌드 통과
- 로컬 인앱 브라우저는 `127.0.0.1` 접근이 `ERR_BLOCKED_BY_CLIENT`로 차단되어 운영 배포 후 실제 도메인에서 관리자·광고주 화면을 재검증한다.
- 공식 Shopping Search API의 검색 순번은 제공되지만 실제 쇼핑 화면 페이지 위치와의 동일성은 공식 문서에서 보장되지 않으므로 페이지 환산을 금지한다.
- Production: `momentinsight-1z4jt31ot-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`: HTTP 200
- 운영 API 재조회:
  - `전동칫솔`: 공식 API 168번째, 관련 원부 34번째, 판매자 상품ID 일치, 300개 확인
  - `치아미백제`: 공식 API 43번째, 관련 원부 9번째, 판매자 상품ID 일치, 300개 확인
  - 두 응답 모두 `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- 운영 관리자 브라우저: 공식 API 168번째, 화면 위치 미검증, 300개 확인, 관련 원부/상품 ID 일치 카드와 각 링크 목적지 확인
- 운영 관리자·광고주 HTML: 공식 API 결과 순번·실제 화면 위치 아님·상품 ID 일치·프리미엄 사이드바 마커 확인, 40개 단위 페이지 환산 코드 없음

## 2026-07-14 · 네이버 상품 페이지 오표기 제거

- 운영 API 재현: `전동칫솔`/판매자 상품ID `12649811979`는 공식 쇼핑 검색 API 168번째 결과에서 링크 상품ID가 정확히 일치했다.
- 기존 오류: API 배열 순번 168을 40개 단위로 환산해 `5페이지 8위`로 표시했으나 실제 쇼핑 화면 위치를 검증하는 근거가 없었다.
- 실화면 접근: 인앱 브라우저, 사용자 Chrome, 직접 HTTP 요청 모두 네이버 쇼핑의 비정상 접근 제한(HTTP 418)으로 차단됐다. 우회하지 않고 미검증으로 처리했다.
- 로컬 API: `rank=168`, `rankBasis=official_api_result_order`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`, `matchedProductId=12649811979`.
- 카드 결과: 관련 원부 API 34번째, 입력 상품 API 168번째. 두 카드 모두 페이지 위치를 표시하지 않는다.
- `npm run check:rank-matching`: 통과. 40개 단위 환산 함수 제거, 41번째 결과도 페이지 필드가 없음을 회귀 검사했다.
- `npm run check:baseline`: `naverRankDoesNotFabricateWebPagePosition=true` 포함 전체 통과.
- `npm run check:quality`: 독립 실행 2회 통과. 각 실행에 서버 테스트 13개, 플레이스 수집기 25개, Vercel 정적 빌드 포함.
- `git diff --check`: 통과.
- 운영 배포: 없음.

> 아래 과거 기록의 `N페이지 N번째`, `광고 제외 오가닉 순위` 표현은 당시 API 배열 순번을 화면 순위로 해석한 기록이다. 현재 순위 원천은 문서 최상단의 2026-08-02 hybrid 원자 수집 계약이며 과거 API 결과는 신규 순위 근거가 아니다.

기준일: 2026-07-14

## UI/UX 1차 고도화 · 상태 진실성 및 첫 화면 밀도

- 운영 홈: 실제 집계가 아닌 `12개·4건·3건·2건`, 브랜드 예시 3건, 과거 업데이트 날짜 제거
- 운영 홈 대체 흐름: 광고주 연결 → 운영 입력 → 공개 승인 → 보고서 관리 작업 카드 4개와 3단계 운영 순서 제공
- 광고주 빈 상태: `공개 준비 중`, `데이터 상태: 공개 데이터 연결 대기`, `데이터 대기`, `운영팀 공개 입력 전` 동시 전환 확인
- 광고주 데이터 상태 회귀: `4,180만원` 상태에서 `업데이트 완료`, `운영팀 검수 완료`, `공개용` 유지 확인
- 빈 보고서함: 오래된 기본 월간 보고서 대신 `공개 보고서 없음` 표시
- 모바일 광고주 390×844: 빈 요약 카드 401px, 핵심 지표 3열, 액션 2열, `scrollWidth=390`
- 모바일 운영팀 390×844: 작업 카드 4개, `scrollWidth=390`, 카드·메뉴 겹침 없음
- 운영팀 CTA: `광고주 연결` 카드가 `agency-code` 화면으로 정확히 이동
- 스크롤 복귀: 운영팀 `scrollY 554.5 → 0`, 광고주 `scrollY 539 → 0` 확인
- 로컬 브라우저 로그: 오류 0건
- `npm run check:quality`: 통과, 서버 테스트 13/13·플레이스 수집기 25/25·Vercel 빌드 포함
- `npm run check:supabase`: HTTP 200, publishable key·JWKS 정상
- `npm run check:env`: 필수 환경 항목 정상, 기존 선택 항목 미설정 상태는 유지
- Supabase 스키마·RLS·운영 데이터 변경 없음, 삭제·마이그레이션 없음
- 배포: 운영 영향 보고 전 대기

## 네이버 상품 대표 순위·페이지 표기 정상화

- 로그인 네이버 가격비교: `전동칫솔`, 네이버 랭킹순, 40개씩 보기
- 실화면 원부: `57907660073`, 오가닉 34위, 1페이지 34위
- 실화면 정확 상품: 판매자 상품ID `12649811979`, API 항목 ID `90194322885`, 오가닉 168위, 5페이지 8위
- 정확 상품 DOM 근거: `chnl_prod_no=12649811979`, `organic_expose_order=8`, 페이지 `5`
- 로컬 API: 대표 34위·원부형·1페이지 34위, 정확 상품 168위·단일형·5페이지 8위, 300개 확인
- `치아미백제` 회귀: 대표 원부 9위·정확 상품 43위, 원부형 정상
- 관리자 로컬 실조회: 대표 카드와 노출 카드 2건, 상품명은 키워드 검색, 상품 열기는 원부/입력 상품 상세로 분리
- 광고주 로컬 실조회: 관리자와 동일한 숫자·형태·링크 확인
- 광고주 390×844: `innerWidth=390`, 문서 `scrollWidth=375`, 전체 가로 넘침 없음
- 관리자·광고주 브라우저 경고·오류: 0건
- 서버형 Playwright 네이버 화면 접근: HTTP 418 재현, 운영 수집 성공으로 오인하지 않음
- `npm run check:env:naver`: 필수 네이버·Supabase 환경 준비
- `npm run check:quality`: 독립 1차 통과
- `npm run check:quality`: 독립 2차 통과
- 서버 테스트 13/13, 플레이스 수집기 25/25, 릴리즈 기준선과 Vercel 빌드 통과
- `git diff --check`: 통과
- Production 배포: `momentinsight-3whvmsjzo-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`, 관리자·광고주 HTML, 순위 API: HTTP 200
- 운영 API: 대표 원부 34위·1페이지 34위, 정확 상품 168위·5페이지 8위, `checkedCount=300`
- 운영 관리자·광고주 실조회: 대표 원부형 34위, 정확 단일형 168위, 두 카드의 페이지 위치와 원부·스마트스토어 상세 링크 정상
- 운영 데스크톱 육안검수: 상태 메시지·순위 요약·카드 구분·프리미엄 레이아웃 겹침 없음

## 네이버 상품 정확 일치·300위 완주 재검증

- 입력: `전동칫솔`, `https://brand.naver.com/lav/products/12649811979`, 300위
- 네이버 공식 API 원문 300개: 관련 원부 `57907660073` 33위, 입력 URL 판매자 상품ID `12649811979` 173위
- 173위 API 항목: API `productId=90194322885`, 결과 링크 판매자 상품ID `12649811979`, 판매처 `라이브오랄스`, 69,000원
- 실제 입력 상품 페이지: 상품번호 `12649811979`, 제목 `라이브오랄스 음파 전동칫솔 회전 IPX8 방수 C타입 충전식 초극세모 칫솔모 3P`, 판매처·가격까지 API 항목과 일치
- 판정: 173위는 다른 업체가 아니라 입력 URL의 동일 판매자 상품이며, 원부 33위와 판매처 단일 상품 173위가 함께 노출되는 구조
- 보강 후 일치 근거: `seller_link_product_id`; API `productId`만 같은 다른 링크 상품은 불일치
- 보강 후 수집 범위: 정확 상품 173위를 찾은 뒤에도 오가닉 300개 확인, 카드 2건 유지
- 상세 링크: 관련 원부는 `catalog/57907660073`, 정확 상품은 입력 원본 `brand.naver.com/lav/products/12649811979`
- 정상 회귀: `치아미백제`/`5145848584` 관련 원부 7위·정확 상품 48위·300개 확인
- 오판 회귀: `게이밍노트북`/`12649811979`는 오가닉 300개 확인 후 미발견
- 임의 중복 제거 실험은 원부를 33위에서 29위로 변경해 제외; 공식 API 슬롯 순서 유지
- 로컬 운영팀 1280px: 카드 2건, 카드 높이 128px, `scrollWidth=1280`, 콘솔 오류 0건
- 로컬 광고주 390×844: 카드 폭 276px, `scrollWidth=390`, 콘솔 오류 0건
- 전체 `npm run check:quality`: 1차 통과, 서버 테스트 13개·플레이스 수집기 테스트 25개·Vercel 빌드 포함
- 전체 `npm run check:quality`: 동일 기준 2차 통과
- `npm run check:env:naver`, `npm run check:supabase`: 정상
- Production: `momentinsight-mmeqlbh43-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`
- 운영 API: `rank=173`, `checkedCount=300`, `matchEvidence=seller_link_product_id`, `matchedProductId=12649811979`
- 운영팀 1280px 실조회: 원부 33위·정확 상품 173위·300개 확인, 카드 128px, `scrollWidth=1280`, 콘솔 오류 0건
- 운영 광고주 390×844 실조회: 카드 폭 276px, `scrollWidth=390`, 원부/정확 상품 상세 링크 정상, 콘솔 오류 0건
- 라이브 `/health`: HTTP 200

## 오가닉 노출 카드 컴팩트 프리미엄화

- 관리자·광고주 공통 카드: 이미지 84×84px, 최소 높이 116px, 14px 보드 라운드와 낮은 그림자 적용
- 관련 원부 배지: `#eaf9f0` 배경, `#087f45` 글자, `#bcebd0` 테두리의 네이버 민트·그린 톤 적용
- 상품명 링크: 조회 키워드를 포함한 `search.shopping.naver.com/search/all` 검색 결과 주소
- `상품 열기` 링크: 각 `productExposureItems`의 기존 상품 상세 URL
- 릴리즈 기준선: 두 역할의 키워드 링크, 상품 상세 링크, 그린 배지 마커 검사 통과
- 전체 `npm run check:quality`: 통과, 서버 테스트 13개·플레이스 수집기 테스트 25개·Vercel 빌드 포함
- Vercel Preview: `momentinsight-533u2sq4m-momentlabs.vercel.app`, 빌드 READY
- Preview 브라우저 조회: 화면·입력·300위 옵션은 정상이며 네이버 쇼핑 API 환경변수 미연결 메시지를 확인. 실조회 UI는 Production에서 최종 검증했다.
- Production: `momentinsight-c4ylvfjb4-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr` 반영
- 운영 실조회: `치아미백제`/상품 `5145848584`, 정확 상품 48위·2페이지 8번째, 관련 원부 `56704991367` 7위·1페이지 7번째
- 운영팀·광고주 데스크톱: 카드 2건, 카드 높이 각각 127px, 이미지 84×84px, 관련 원부 계산 색상 `rgb(234, 249, 240)`·`rgb(8, 127, 69)`
- 운영팀·광고주 390×844: 카드 폭 각각 276px, 이미지 72×72px, 문서 `scrollWidth=390`, 가로 넘침 없음
- 두 역할 상품명 2개: 모두 `search.shopping.naver.com/search/all`의 `치아미백제` 검색 결과로 연결
- 두 역할 `상품 열기` 2개: 관련 원부 `catalog/56704991367`, 정확 상품 `products/5145848584` 상세로 연결
- 운영팀·광고주 브라우저 콘솔 오류: 0건
- 라이브 `/health`, `/admin`, `/client`: HTTP 200, 컴팩트 카드·키워드 링크·민트 배지 마커 확인

## 운영팀·광고주 공통 사이드바

- 전체 `npm run check:quality`: 통과
- 릴리즈 기준선: `clientNavigationTaxonomy`, `roleSidebarsSharePremiumShell` 포함 전체 통과
- Vercel Preview: `momentinsight-5fm1vq6dw-momentlabs.vercel.app`, 빌드 READY
- 운영팀 1280×720 실화면: 사이드바 236px, 높이 720px, 문서 `scrollWidth=1280`, 네 개 공통 메뉴 분류 확인
- 운영팀 활성 메뉴: 딥네이비 왼쪽 라인, 프리미엄 그라데이션 배경과 그림자 계산값 확인
- 광고주 Preview DOM: `운영`, `키워드·SEO`, `순위 조회·추적`, `광고 조사` 순서와 10개 역할 허용 메뉴 확인
- 광고주 계산 CSS: 236px 그리드, 운영팀과 동일한 배경·그림자·활성 그라데이션·42px 브랜드 높이 확인
- 광고주 390×844 반응형 규칙: 데스크톱 메뉴 숨김, 모바일 메뉴 flex, 최대 폭 366px, 동일 메뉴 순서 확인
- Production: `momentinsight-1eo93tbd5-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr` 반영
- 운영 광고주 데스크톱 실로그인: 사이드바 236px, 네 개 공통 메뉴 분류, 운영팀과 동일한 배경·그림자·활성 그라데이션 확인
- 운영 광고주 390×844 실로그인: 모바일 메뉴 flex, 문서 `scrollWidth=390`, 카드·텍스트 겹침 및 전체 가로 넘침 없음
- 운영 관리자·광고주 콘솔 오류: 0건
- 라이브 `/health`, `/admin`, `/client`: HTTP 200, 두 HTML 모두 `data-mi-shell="premium-sidebar"` 확인

## 연속 개발 운영 규칙 검증

- 기존 플레이스 수정 커밋 `3638a73`과 배포 대기 상태를 보존한 채 문서만 변경했다.
- 작업 전 `git status --short --branch`, 최근 커밋, 작업명세, 작업 상태, 결정, 다음 작업, 검증 근거를 확인했다.
- `npm run work:autosave`로 작업 시작 기준점을 기록했다.
- `AGENTS.md`, 작업명세, 프로젝트 기억, 상태, 결정, 다음 작업에 사전 확인·중복 검색·기존 diff 보존·2차 검증·논리 단위 커밋·배포 게이트가 함께 기록됐는지 검색 검사한다.
- 문서 변경 후 `npm run check:baseline`, `git diff --check`, 최종 diff·Git 상태를 재확인한다.

## 네이버 플레이스 장애 재현

- 키워드: `부평 맛집`
- 플레이스 URL/ID: `2019299673`
- 자동 식별 상호명: `팽오리농장 부평점`
- 운영 실패 원문: 세 Apify Actor 모두 `Monthly usage hard limit exceeded`
- 자체 브라우저 수집: 광고 제외 오가닉 54개, 약 70초, 대상 미발견, `collection_deadline_reached`
- 판정: 300위 밖으로 확정하지 않고 `54위까지 확인 · 이후 미검증`
- `npm run check:quality`: 통과
- 플레이스 수집기: 25개 테스트 통과
- 플레이스 서버: 9개 테스트 통과
- `git diff --check`: 통과

## 실제 네이버 조회

- 키워드: `치아미백제`
- 입력 URL: `https://brand.naver.com/lav/products/5145848584`
- 정확 대상 상품ID: `5145848584`
- 결과: 광고 제외 오가닉 48위
- 페이지·위치: 2페이지 8번째
- 매칭: `product_id`
- 대상 모드: `product`
- 잘못 연결되던 카탈로그 ID `59606749556`: 결과에서 사용되지 않음
- 상품 노출 카드: 2건
  - 7위, 1페이지 7번째: 관련 원부 `56704991367`
  - 48위, 2페이지 8번째: 정확 상품 `5145848584`
- 같은 판매처의 무관한 44위 불소 상품: 카드에서 제외
- 잘못 연결되던 원부 `59606749556`: 카드에서 제외

순위는 조회 시점에 따라 바뀔 수 있으며, 이 기록은 정확 일치 로직 검증 증거다.

## 자동 검사

- `npm run check:quality`: 통과
  - 릴리즈 기준선 통과
  - 서버 문법 검사 통과
  - 순위 크론 일정 검사 통과
  - 네이버 상품 매칭 회귀 검사 통과
  - 키워드 트렌드 검사 통과
  - 서버 테스트 12개 통과
  - 플레이스 수집기 테스트 22개 통과
  - Vercel 정적 빌드 통과
- `npm run check:env:naver`: 필수 네이버·Supabase 실행환경 준비 확인
- `npm run check:supabase`: HTTP 200과 JWKS 연결 확인
- `git diff --check`: 공백 오류 없음

## 브라우저 QA

관리자와 광고주 화면에서 각각 로그인 → 키워드/URL 입력 → 순위 조회를 실제 수행했다.

- 데스크톱: 1280×720 브라우저 실조회
- 모바일: 390×844
- 두 화면 모두 오가닉 48위, 관련 원부 7위, 정확 상품 48위 확인
- 두 화면 모두 카드 2개, 이미지 2개, 상품 링크 2개 확인
- 두 화면 모두 잘못된 카탈로그 ID와 무관한 불소 상품 미표시
- 데스크톱 `scrollWidth=1280`, 모바일 `scrollWidth=390`으로 가로 넘침 없음
- 모바일 카드 폭 276px, 상품명 줄바꿈, 버튼과 안내 문구 정상 확인

## Production 배포 후 검증

- 배포: `momentinsight-d7nu7j61r-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`
- `/health`: HTTP 200, API 정상, Supabase 준비 상태 정상
- 관리자·광고주 화면: HTTP 200, `renderProductExposureCards`, 카드 스타일, `광고상품 미연결` 마커 확인
- 라이브 상품 순위 API: HTTP 200, `matchType=product_id`, `targetProductId=5145848584`, `targetCatalogId` 빈값
- 라이브 노출 결과: 관련 원부 `56704991367` 7위, 정확 상품 `5145848584` 48위
- 라이브 관리자·광고주 데스크톱: 카드·이미지·링크 각각 2개, 가로 넘침 없음
- 라이브 관리자·광고주 390×844: 카드·이미지·링크 각각 2개, `scrollWidth=390`
- 잘못된 원부 `59606749556`과 같은 판매처의 무관한 불소 상품: 라이브 화면 미표시

## 2026-07-20 플레이스 네이티브 오가닉 v16·네이버 API 공지 감사

- 순위 권위: `source=naver_map_pc_list_collector`, `rankEvidence=naver_pc_organic_list`인 네이버 PC 실제 장소 목록만 저장한다. 두 표식 중 하나라도 누락·불일치하면 `place_rank_provider_untrusted_evidence`로 실패하고 새 snapshot을 만들지 않으며 기존 current/best/check_count·30일 이력을 보존한다.
- 수집 예산: Vercel이 Render cold start를 포함한 절대 `providerDeadlineAt`을 전달하고, 수집기는 최대 225초 안에서 응답·브라우저 종료 여유 12초를 확보한다. viewport 1440×1600과 겹침 스크롤을 사용한다.
- 로컬 실조회 1차: `홍대 맛집`/`1907427831` 100개 확인·정확 ID 오가닉 7위·30.770초, `부평 맛집`/`2019299673` 100개 확인·미발견·rank null·31.024초. 두 결과 모두 네이티브 source/evidence를 반환했다.
- 육안 2차: 네이버 PC 목록의 상단 광고 3건을 순위에서 제외했고, 첫 오가닉 1~5위가 수집 결과와 일치했다. 동일 시점 독립 수집의 top10 ID·순서도 일치했다. 공개 목록이 100개에서 끝나므로 101~300위는 확정하지 않는다.
- 자동 검증: 전체 `npm run check:release` 통과. API·서버 154/154, 플레이스 tracker 43/43, 플레이스 수집기 44/44, 서버 계약 22/22, Production 인증 18/18, 역할 query parity·공개 빌드 CSP 통과.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, N상품 수집·대표값 판정, 기존 30일 snapshot 조회·저장 로직은 diff 없음.
- 독립 코드 재검수: 최초 P1이었던 공급자 근거 미강제를 보완한 뒤 P0/P1 0건으로 통과했다.
- 공식 메일 확인: 발신자·공지 링크를 네이버 개발자센터 공식 공지와 대조했다. Search Trend·Shopping Insight·일반 Search 일부는 NAVER API Hub 이관 대상이지만 쇼핑 검색은 별도 공지상 이관 제외, 2026-07-31 종료, 대체 API 없음이다.
- 2026-07-20 legacy 실호출: 기존 Search Trend·쇼핑 검색은 HTTP 200으로 응답해 이번 플레이스 오류의 직접 원인이 아님을 확인했다.
- 공식 근거: `https://developers.naver.com/notice/article/32530`, `https://developers.naver.com/notice/article/32564`, `https://guide.ncloud-docs.com/docs/apihub-migration`.
- 운영 배포: Vercel `/health`·`/ready` 릴리즈 `bfa97e38304d`(기능 코드 `5014d1a` 포함), Supabase `ready`; Render `/health` 릴리즈 `2026-07-20-native-organic-deadline-v16`, `configured=true`, `busy=false` 확인.
- 운영 snapshot: `홍대 맛집`/`1907427831`은 `checked_count=97`, `rank=7`, `matched=true`; `부평 맛집`/`2019299673`은 `checked_count=77`, `rank=null`, `matched=false`. 두 source 모두 `naver_map_pc_list_collector`, place ID 정확 일치, 블로그·방문 coverage 전체 충족.
- 이력 보존: 과거 `_fallback` snapshot은 그대로 남겼고 새 v16 snapshot만 추가했다. 현재값·best·기존 30일 기록 삭제·소급 재작성 없음.
- workflow 판정: 두 호출과 저장은 정상 완료했으나 `부평 맛집`의 300위 미완주를 숨기지 않도록 `partial>0` 정책이 첫 실행을 경고 실패로 종료했다. transport·provider 오류와 tracker `last_error`는 없음.

## 2026-07-22 플레이스 의료 키워드 네이티브 경로 정상화

- 운영 데이터 진단: 플레이스ID `1531240094`의 `종로3가한의원`·`종로한의원` 추적은 각각 retry 31회·30회, snapshot 0건이며 마지막 오류는 모두 `#_pcmap_list_scroll_container` 8초 timeout이었다. 기존 추적 행과 이력은 삭제·수정하지 않았다.
- 직접 원인: 네이버 실제 검색 화면은 두 키워드를 `https://pcmap.place.naver.com/hospital/list`로 열고 정확 ID `1531240094`를 목록에 포함한다. 기존 수집기는 이를 `place/list?display=300`으로 다시 열어 `조건에 맞는 업체가 없습니다` 페이지로 리디렉션됐다.
- 수정 기준: 검색 화면이 만든 정확한 HTTPS `pcmap.place.naver.com` 목록 URL만 허용한다. `hospital/list`는 네이티브 `display=70`, `clientX`·`clientY`·`searchText` 문맥을 보존하고, `restaurant/list`는 기존 `display=300` 확장을 유지한다. 호스트 문자열만 포함한 비네이버 URL은 거부한다.
- 대상 실조회: 광고 제외 네이버 PC 오가닉 목록에서 `종로3가한의원` 3위, `종로한의원` 12위이며 두 건 모두 정확 ID `1531240094`, `source=naver_map_pc_list_collector`, `rankEvidence=naver_pc_organic_list`다.
- 2차 회귀: `홍대 맛집`/`1907427831`은 100개 확인·7위, `부평 맛집`/`2019299673`은 100개 확인·미발견·partial이며 기존 진실 표기가 유지됐다.
- 자동 검증: 플레이스 수집기 47/47, API·서버 154/154, 서버 계약 22/22, Production 인증 18/18, 전체 `npm run check:release`, 공개 빌드·역할 parity·`git diff --check` 통과.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, 서버 snapshot 저장 계약, Supabase 스키마, N상품 순위와 기존 30일 기록은 변경하지 않았다.

### 느린 운영 프레임 회귀 검증

- 운영 v17 재실행: 두 tracker 모두 selector 8초 timeout 재현. 원인은 네이티브 프레임 6초 대기 만료 뒤 일반 목록 URL을 만든 폴백이었다.
- 단위 회귀: 첫 네이티브 프레임 미발견 후 두 번째 검색 성공, 두 번 모두 미발견 시 fail-closed를 각각 검사한다.
- 플레이스 수집기: 49/49 통과.
- 전체 `npm run check:release`: 통과. API·서버 154/154, 서버 계약 22/22, Production 인증 18/18.
- 로컬 실제 네이버 PC 오가닉: `종로3가한의원` 3위, `종로한의원` 10위, 각각 70개 확인·정확 ID `1531240094` 일치.

### v18 Production 저장 증거

- Render `/health`: `release=2026-07-22-native-medical-list-v18`, `configured=true`.
- Vercel `/health`: `release=b7919bc86348`, HTTP 200.
- `종로3가한의원`: 2026-07-22 15:51 KST, 오가닉 3위, 정확 ID `1531240094`, `matched=true`, `checked_count=70`, `source=naver_map_pc_list_collector`.
- `종로한의원`: 2026-07-22 15:56 KST, 오가닉 10위, 정확 ID `1531240094`, `matched=true`, `checked_count=70`, `source=naver_map_pc_list_collector`.
- 두 tracker 현재 상태: `retry_count=0`, `last_error=null`, `check_count=1`, `found_count=1`, 처리 임대 해제, 다음 정규 실행 2026-07-23 09:00 KST.

## 2026-07-22 N 상품·N 플레이스 30일 보호 잠금·운영 배포

- 잠금 의미: `scripts/check-protected-rank-features.mjs`는 보호 코드의 해시와 새 순위 마이그레이션을 빌드·릴리스에서 검사할 뿐 런타임 요청 경로에는 포함되지 않는다. 신규 키워드 조회, N 상품 단건 조회, N 상품·플레이스 추적 등록과 갱신은 계속 허용한다.
- 회귀 고정: 기준선 `rankFeatureLockIsBuildOnlyAndUsageStaysOpen`이 운영팀·광고주 신규 키워드 조회 버튼, 상품 단건 조회, 상품·플레이스 추적 등록 버튼과 양 서버의 `action=create` 경로를 확인한다.
- 자동 검증: 정상 잠금 4개 함수·20개 파일·11개 마이그레이션, 의도적 변조 self-test 차단, API·서버 162/162, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 역할 parity·공개 빌드·CSP 통과.
- 배포 빌드: Vercel CLI가 수집기 `.dockerignore`를 업로드에서 제외하는 환경 차이를 확인했다. 로컬·CI는 실제 `.dockerignore`와 `dockerignore.policy`의 완전 일치를 강제하고, Vercel은 같은 정책 사본을 검사하도록 보완해 공급망 검사를 우회하지 않았다.
- 운영 API: `/health` HTTP 200·`release=f8bf0a3b37a1`, `/ready` HTTP 200·Supabase ready, 상품·플레이스 보호 API 비인증 401.
- 운영 UI: 홈페이지 팝업 348×489px, `N 상품 순위`·`N 30일 순위`·`N 플레이스 30일 순위` 각 1건, 1280px 가로 넘침 0. 총관리자에서 신규 키워드 조회·상품 추적·플레이스 추적 버튼 모두 활성, 기존 상품 추적 25개·플레이스 추적 10개와 30일 이력 로드 확인.
- 배포: Production `https://momentinsight-idchb9x5n-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`. 이번 범위는 Render 수집기 런타임 변경이 없어 Render는 재배포하지 않았다.

## 2026-07-23 4대 핵심 조회·추적 기능 변경 잠금 확장

- 보호 범위: 운영팀·광고주의 `runKeywordLookup`, `initRankCheck`, `initRankTracking`, `initPlaceRankTracking`과 키워드 API Hub 핵심 함수, 키워드·상품 단건·상품/플레이스 30일 서버·크론·수집기·워크플로·순위 DB 마이그레이션을 13함수·21파일·11마이그레이션으로 고정했다.
- 잠금 의미: 런타임 버튼이나 API를 닫는 기능이 아니다. 승인 없이 보호 코드를 바꾸면 `check:quality`와 `check:release`가 실패하며, 신규 키워드 조회·N 상품 순위 조회·상품/플레이스 추적 등록·갱신과 보호 범위 밖 신규 기능은 계속 동작한다.
- 변조 2차 검수: self-test가 13개 보호 함수와 21개 보호 파일을 각각 하나씩 변조해 모두 차단했고, 가상 신규 순위 마이그레이션도 자동 탐지했다.
- 사용 경로 회귀: 운영팀·광고주 양쪽에서 4개 기능 진입 함수와 버튼, 상품·플레이스 `action=create` 및 갱신 경로를 확인했다. 빌드 잠금 스크립트는 페이지·키워드·상품·플레이스 런타임 소스에 포함되지 않는다.
- 전체 자동 검증: API·서버 179/179, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 역할 parity, 기준선 `rankFeatureLockIsBuildOnlyAndUsageStaysOpen`, 공개 빌드·CSP와 전체 `npm run check:release`가 통과했다.
- 변경 비범위: 실제 키워드 조회·상품 순위 계산·상품/플레이스 수집·스냅샷 저장 코드와 `src/pages/admin.html`, `src/pages/client.html`, Supabase 데이터는 수정하지 않았다.
- 운영 배포: 사용자 승인 후 코드 `6c5d10d`를 원격 `main`과 Production `https://momentinsight-htm9llc9v-momentlabs.vercel.app`·운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다. 운영 `/health`와 `/ready`가 릴리스 `6c5d10d1deef`, live, Supabase ready를 반환했다.

## 2026-08-09 N 쇼핑 가격비교 v1.0.11 안정화 검증

- 실화면: Chrome `동빈` 프로필에서 가격비교 `/search/all`, `pagingSize=40`, `productSet=total`, `sort=rel` 정상 결과를 확인했다.
- 실패 안전: 2026-08-09 18:32 KST 수동 실행은 2페이지에서 `naver_network_restricted`로 중단됐고 native host는 `max_jobs=1`, `exit status=0`으로 종료했다. 완전 300개가 아니므로 DB 제출·현재값 교체를 하지 않는다.
- 요청 안정화: 첫 요청 30~45초, 페이지 간 45~75초, catch-up 30분, 순차 1개 키워드를 정적 계약과 테스트로 고정했다.
- 자동 검증: 네이티브 호스트 12/12, API·서버 393/393, 플레이스 51/51, 쇼핑 51/51, 서버 계약 37/37, Production 인증 18/18, 보호 잠금 self-test와 전체 `npm run check:release`, `git diff --check` 통과.
- Production gate: 공식 상단 실응답 `checkedCount=44`, 광고 제외·정확 매칭 가능 상태와 최근 원자 수집 `checkedCount=300`, `source=naver_shopping_results_collector`를 함께 확인해 `SHOPPING_RANK_HYBRID_LIVE_READY`·`deploymentEligible=true`로 통과했다.
- 배포: 코드 `c29b381`을 GitHub `main`과 Production `dpl_DottuAAAw2adGYwBTC1xAvK1xxps`에 반영했다. 운영 별칭은 `https://insight.momentlabs.co.kr`, `/health`·`/ready`는 릴리스 `c29b3812dd8f`, 서울 `icn1`, Supabase ready다.
- Mac 동기화: Production 반영 뒤 브리지를 재설치했다. 설치된 네이티브 호스트 wrapper SHA-256은 저장소와 일치하고 한 회차 `max_jobs=1`, 확장 프로그램 소스 버전 `1.0.11`, 08:50·14:50 KST 사전 기동 스케줄을 유지한다.
- 운영 한계: 2026-08-09 19:50 KST 확인 시 열린 가격비교 탭은 네이버 네트워크 제한 상태다. 이 외부 제한은 배포 성공과 별개이며 제한 중 새 300개 수집을 주장하지 않는다. 부분 데이터는 저장하지 않고 마지막 정상값을 유지한다.

## 2026-08-09 동빈 → 개발 프로필 원격 갱신 v1.0.12

- 집중 회귀: 원격 신호 없음 시 네이버 미접속, 신호 1회당 최대 1작업, signed `claim-wake`, 300위 조회 wake, 계정 범위 전체 갱신 wake, RLS·service-role 전용 마이그레이션을 포함해 109/109 통과.
- 전체 회귀: API·서버 397/397, 플레이스 수집기 51/51, 쇼핑 수집기 51/51 통과.
- 계약: 서버 계약 38/38, Production 인증 18/18, 역할 5상태·관리자/광고주 parity, 보호 잠금 22함수·60파일·15마이그레이션 통과.
- 공개 빌드: 관리자·광고주 변경 스크립트의 CSP SHA-256을 갱신하고 9파일·인라인 6개·고유 해시 4개·비밀 서명 0건으로 통과.
- 최종 검증: `npm run check:release`와 `git diff --check` 통과.
- 운영 쓰기 없음: Supabase 마이그레이션·운영 데이터·GitHub push·Vercel Production·Mac 브리지/확장 `1.0.12` 설치는 승인 전이라 실행하지 않았다.

## 2026-08-09 N 쇼핑 접속 제한 자동 복구 v1.0.13

- 입력 증거: `search.shopping.naver.com/search/all`에서 `쇼핑 서비스 접속이 일시적으로 제한되었습니다` 화면과 네이버가 안내한 짧은 시간 다수 요청·VPN·특정 확장 프로그램 제한 사유를 확인했다.
- 실패 안전: 제한·HTTP 418·429는 즉시 중단하고 완전한 300개가 아니면 제출하지 않는다. 제한 대기 중 DOM 상태 확인 외 네이버 탐색·새로고침을 하지 않는다.
- 자동 복구 계약: 2시간·6시간·12시간·24시간 단계형 대기, 만료 후 `rank-recovery` 1건, 성공 시 단계 초기화, 재제한 시 다음 단계 이동을 확장 소스와 정적 회귀로 고정했다.
- 보안확인 계약: CAPTCHA 풀이·쿠키 접근·로컬스토리지·요청 가로채기·브라우저 기록 접근은 사용하지 않는다. 사람이 정상 화면으로 돌리면 1분 알람이 감지해 1건만 재개한다.
- 팝업 계약: 다음 재시도 시각과 `이후 1건 자동 재시도`를 표시하고 수동 재시작 요구 문구를 제거했다.
- 검증: 네이티브 호스트·로컬 워커 32/32, API·서버 397/397, 플레이스 51/51, 쇼핑 51/51, 서버 계약 38/38, Production 인증 18/18, 공개 빌드·CSP, 전체 `npm run check:release`, JavaScript 문법과 `git diff --check` 통과.
- Supabase: 마이그레이션 `20260809115100_naver_shopping_worker_remote_wake` 적용. `rls_enabled=true`, `rls_forced=true`, anon/authenticated table select=false, service_role select/insert/update=true. 두 RPC는 `security_definer=false`, anon/authenticated execute=false, service_role execute=true다.
- 원자 신호: 트랜잭션 안에서 service_role request 후 첫 claim=true·중복 claim=false를 확인하고 롤백했다. 이후 `naver_shopping_worker_wakes` 운영 행은 0건이다.
- 보안 advisor: 신규 wake 테이블의 `RLS enabled no policy` INFO는 사용자 정책을 의도적으로 0개로 둔 fail-closed 설계다. 이번 RPC 관련 신규 WARN은 없고 기존 `has_client_access`·`is_admin` SECURITY DEFINER WARN은 이번 변경 비범위로 유지했다.
- Production: `dpl_R1YAvtYrTgfqHJ1jAuDFQ3GaPRDX`, `https://momentinsight-8dcpd51mh-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`. `/health`·`/ready`는 `release=062ba5935d15`, `region=icn1`, Supabase ready이며 관리자·광고주 HTML 200과 원격 실행 안내를 확인했다.
- Mac: 설치 브리지 14개 파일이 저장소와 byte-for-byte 일치하고 native host allowlist는 고정 확장 ID 1개뿐이다. scheduler config는 `Profile 5`, 10분·08:50·14:50이다.
- Chrome: `동빈(개발)` 확장 `1.0.13` 활성·재로드, 팝업 `접속 제한 보호 중 · 2026. 8. 9. 오후 10:56:10 이후 1건 자동 재시도`를 확인했다. `동빈(Default)`의 같은 ID는 `사용 안함`이다.
- 제한 중 운영 쓰기: 원격 전체 갱신·네이버 새 검색·새 300위 저장은 실행하지 않았다. 현재/최고/최저 순위와 기존 30일 snapshot은 변경하지 않았다.
