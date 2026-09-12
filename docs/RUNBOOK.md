# 운영 장애 런북 (1페이지)

증상 7개. 각 항목은 **판정 기준 / 확인 명령 1줄 / 조치 / 안 되면 다음** 순서다.
모든 명령은 저장소 루트(`~/Desktop/개발/모먼트 인사이트 개발`)에서 실행한다.
아래 "관측된 출력"은 2026-09-01 06:31 UTC에 실제로 1회 실행해 받은 값이다.

---

## ① 순위가 안 올라옴

- **판정 기준**: `queueStalled: true` → 수집 정체. `401 SESSION_REQUIRED` → 프로덕션이 이 경로를
  무세션 허용 목록에 넣기 전 버전이다(→ 증상 ②).
- **확인 명령**: `curl -s -m 15 -w '\n%{http_code}\n' https://insight.momentlabs.co.kr/api/rank-collection-health`
- **관측된 출력**: `{"ok":false,"code":"SESSION_REQUIRED","message":"안전한 접속 세션이 필요합니다."}` / `401`
- **조치**: 먼저 GitHub Actions의 상품 크론 실패 코드를 본다. 두 코드는 원인이 다르다.
  `503 NAVER_RANK_WORKER_SILENT` = 워커가 30분 넘게 **레인 확보도 수집 성공도 기록하지 않았다**
  (`naver_shopping_worker_coordination` 의 `primary_seen_at` · `last_success_at` 둘 다 정지) →
  대표님 맥에서 Chrome이 켜져 있고 순위 수집 확장이 살아 있는지 확인한다. 서명(nonce)이 계속
  들어오는 상태에서도 이 코드는 뜬다 — 서명은 진척의 증거가 아니다(아래 참고 절).
  `503 NAVER_RANK_WORKER_SIGNAL_UNKNOWN` = 진척 기록을 **읽지 못했다**(Supabase 권한·스키마·5xx,
  코디네이션 행 부재) → Chrome이 아니라 Supabase를 본다(증상 ⑤·③).
- **안 되면 다음**: 증상 ③(서버 자체), 증상 ⑥(워치독), 증상 ④(개별 추적기 잔존).

## ② 프로덕션이 잘못된 브랜치 (release ≠ origin/main)

- **판정 기준**: 검사 `1)`이 FAIL이면 프로덕션이 `origin/main`이 아니다(다른 브랜치 배포이거나 미배포).
  이 검사는 비교 전에 `git fetch origin main`을 먼저 돌린다. 출력의 `base=fetch_failed`는
  기준 해시가 낡았다는 뜻이라 그 자체로 FAIL이다 — 네트워크를 먼저 확인한다.
- **확인 명령**: `node scripts/verify-live.mjs`
- **관측된 출력**: `FAIL 1) /health.release == origin/main(00d6e1fe4d2b) — http=200 release=d8a99ce12e93`
- **조치**: Vercel에서 `main`의 최신 커밋으로 프로덕션을 재배포한다. 브랜치 배포였다면 그 브랜치를
  `main`에 병합한 뒤 배포한다 — `check:vercel-deploy` 최전방의 `check:deploy-branch`가
  `VERCEL_ENV=production` + `VERCEL_GIT_COMMIT_REF != main` 조합을 exit 1로 막는다.
- **안 되면 다음**: 빌드가 게이트에서 멈춘 경우, 수집기 증거 게이트라면 `MI_ALLOW_STALE_WORKER_PROOF=1`로
  1회 우회한다(빌드 로그에 `SHOPPING_RANK_HYBRID_WORKER_PROOF_BYPASSED` 경고가 반드시 남는다).

## ③ `/ready` 503

- **판정 기준**: HTTP 503 또는 `ok:false`. `dependency.supabase`와 `missingCount`가 원인을 가른다.
- **확인 명령**: `curl -s -m 15 -w '\n%{http_code}\n' https://insight.momentlabs.co.kr/ready`
- **관측된 출력**: `{"ok":true,"status":"ready",...,"dependency":{"supabase":"ready"},"missingCount":0}` / `200`
- **조치**: `missingCount > 0`이면 Vercel Production 환경변수 누락이다 — `npm run check:env`로 어떤 키인지 확인한다.
  `dependency.supabase`가 ready가 아니면 Supabase 장애·키 만료다(증상 ⑤로).
- **안 되면 다음**: 증상 ②(잘못된 릴리스가 잘못된 환경변수를 요구하는 경우).

## ④ 재시도 소진 잔존

- **판정 기준**: `residualCount > 0`. `status='active'` + `last_error` 존재 + `retry_count >= 8`인 추적기 수다.
  상품 레인은 자동 재큐에서 구조적으로 제외되어 스스로 풀리지 않는다.
- **확인 명령**: `node scripts/check-rank-residual-failures.mjs`
- **관측된 출력**: `residualCount: 6` (product 2 / place 4), exit 1
- **조치**: 해당 추적기의 `last_error` 코드를 Supabase에서 확인한다. `rendered_order_unproven` ·
  `naver_next_data_rank_drift` 계열은 구조적 실패라 재시도만으로 풀리지 않으므로 키워드·상품 재등록이 필요하다.
- **안 되면 다음**: 일 1회 `Naver Rank Residual Audit` 워크플로가 같은 숫자를 보고한다 —
  숫자가 며칠째 그대로면 수집 방식 전환을 검토한다.

## ⑤ 마이그레이션 적용 실패

- **판정 기준**: Local과 Remote 열이 어긋나는 행이 있으면 미적용이다.
  `Cannot find project ref`가 나오면 아직 링크 전이므로 먼저 `npx --no-install supabase link` 를 한다.
- **확인 명령**: `npx --no-install supabase migration list --linked`
- **관측된 출력**: `{"_tag":"Error","error":{"code":"LegacyProjectNotLinkedError","message":"Cannot find project ref. Have you run supabase link?"}}`
- **조치**: 링크 후 다시 목록을 받아 미적용 SQL을 Supabase SQL 편집기에서 순서대로 1개씩 적용한다.
  순위 관련 마이그레이션은 잠금 대상이므로 파일을 고치지 말고 그대로 적용한다.
- **안 되면 다음**: `node scripts/check-protected-rank-features.mjs`로 저장소 쪽 마이그레이션 목록·해시가
  온전한지 먼저 확인한다(파일 자체가 사라졌으면 DB가 아니라 워킹트리 문제다).

## ⑥ 워치독을 재기동해도 안 풀림

- **판정 기준**: `rank-watchdog` 항목이 없으면 아직 설치 전이다. 있는데 두 번째 열(마지막 종료 코드)이
  0이 아니면 실행은 되지만 실패하고 있다.
- **확인 명령**: `launchctl list | grep momentinsight || echo "등록된 MomentInsight LaunchAgent 없음"`
- **관측된 출력**: `-	0	co.kr.momentinsight.naver-shopping-chrome-scheduler` (rank-watchdog 항목 없음 = 미설치)
- **조치**: 미설치면 `npm run install:rank-watchdog`. 설치돼 있으면
  `tail -n 20 ~/Library/Logs/MomentInsight/mi-rank-watchdog.log`로 최근 라인을 본다.
  워치독은 헬스 엔드포인트가 401이면 조용히 물러나므로, 증상 ①의 401이 먼저 풀려야 의미가 있다.
- **안 되면 다음**: 워치독은 증상을 알리는 장치일 뿐이다 — 수집 자체는 증상 ①,
  서버는 증상 ③, 배포는 증상 ②로 각각 판정한다.
- **맥 대기 프로필이 안 열리는 경우(2026-09-11 실측)**: 대표가 다른 프로필로 Chrome을 쓰는 동안
  `/usr/bin/open --args --profile-directory=…`는 인자를 버리고 기존 창만 활성화한다 → 대기 프로필(Profile 5)이
  26시간 동안 열리지 않았고 `chrome_ready`만 찍혔다. 스케줄러·워치독은 Chrome이 떠 있으면 실행파일로
  명령줄을 전달해 프로필을 로드한다(`chrome_profile_forwarded profile=… loaded=1`). `loaded=0`이 반복되면
  `lsof -p $(pgrep -x -o 'Google Chrome') | grep 'Chrome/Profile 5/'`로 직접 확인. 워치독의 `chrome_quit_incomplete`는
  종료가 안 돼 확장 파일 재로딩이 안 된 상태이므로 대표가 Chrome을 완전히 종료(⌘Q)해야 새 확장이 실린다.
  대기 프로필은 네이버에 "로그인 상태 유지"로 로그인돼 있어야 한다(로그아웃 상태로 인계되면
  `naver_verification_required` → 레인 1시간 보호 대기가 주 작업기까지 막는다). 확인: 네이티브 호스트 로그
  `~/Library/Logs/MomentInsight/naver-shopping-native-host.log`에 1분마다 `start`가 찍혀야 대기기가 살아 있는 것.

## ⑦ 런타임 버전 불일치 (서명은 오는데 수집이 멈춤)

- **판정 기준**: `workerOutdated: true` 또는 `heartbeatAgeMinutes`가 계속 커지는데 nonce 서명은 매분
  들어온다. 서버·DB·확장(맥/윈도우) 세 곳의 런타임 버전(예: `1.1.22`)이 하나라도 다르면 이 증상이다.
  서버 코드만 새 버전이면 HTTP 관문은 통과하지만 progress RPC 상수가 옛 버전이라
  `LOCAL_WORKER_LANE_LOST(409)`가 반복되고, DB만 새 버전이면 HTTP 관문이
  `LOCAL_WORKER_RUNTIME_IDENTITY_INVALID(400)`으로 끊는다. 2026-09-01의 17시간 정지가 정확히 이 증상이다.
- **확인 명령**: `node scripts/verify-live.mjs` (`workerOutdated`·`heartbeatAgeMinutes` 행) — DB 쪽은
  Supabase SQL 편집기에서 `select runtime_version, runtime_fingerprint, primary_seen_at, last_success_at from naver_shopping_worker_coordination where lane_key='global';`
- **기대 출력 형식** (실측 아님): 정상이면 `workerOutdated: false`, `heartbeatAgeMinutes < 15`, DB 행의
  `runtime_version`이 서버 상수(`src/server/handlers/naver-shopping-local-worker.mjs`의
  `EXPECTED_WORKER_RUNTIME_VERSION`)와 같다. 불일치면 `runtime_version`이 옛 버전이거나 `null`로 남는다.
- **조치**: 세 곳을 같은 버전으로 맞춘다. 순서는 ① 맥·윈도우 Chrome 종료 → ② 제어 평면 유휴 확인
  (`lease_worker_id`·`run_id`·`current_stage`·`probe_tracker_id` 전부 null, `circuit_state='closed'`) →
  ③ `main` 배포(증상 ②의 검사 1 PASS) → ④ 해당 런타임 마이그레이션 1회 적용(증상 ⑤) → ⑤ 윈도우는
  관리자 PowerShell `mi-update.ps1 -ReleaseCommit <main 40자 해시> -ExpectedVersion <버전>` 출력의
  `MI_EXTENSION_UPDATE_OK ... version=<버전> runtime_fingerprint=<지문>` 확인, 맥은 워치독 로그의
  `drift_sync_ok` → `chrome_restarted` 확인 → ⑥ Chrome 실행 → 첫 progress 보고 뒤 DB 행의
  `runtime_version`·`runtime_fingerprint`가 새 값으로 채워지는지 본다.
- **버전 이력**: 1.1.28 (2026-09-13, 마이그레이션 `20260912160000_naver_shopping_runtime_1_1_28_same_page_twins_unbounded.sql`)
  — 같은 페이지 판매자 쌍둥이 상한(창당 2건) 제거: 1.1.27 첫 런(00:24, 콘트로이친)이 `5:48:duplicate_row:5`로
  여전히 실패 → 한 페이지에 같은 판매자 상품이 3회 이상 노출됨. 엄격 경로와 동일하게 무제한 보존, 페이지 간 반복은 계속 거부.
  1.1.27 (2026-09-12, 마이그레이션 `20260912150000_naver_shopping_runtime_1_1_27_same_page_twins.sql`)
  — 같은 페이지 판매자 쌍둥이(한 판매자 상품이 상품번호 둘로 한 페이지에 두 번 노출) 허용: 엄격 경로처럼
  정렬 복구 후보·증명도 두 슬롯 모두 보존(창당 2건 상한, 페이지 간 반복은 계속 거부). 콘트로이친 8사이클 연속
  `5:4x:duplicate_row:5` 해소.
  1.1.26 (2026-09-12, 마이그레이션 `20260912060000_naver_shopping_runtime_1_1_26_rendered_identity_fallback.sql`)
  — 정렬 복구 증명의 식별자를 엄격 경로와 동일하게(판매자번호→원부→URL→상품번호); 1.1.25의 URL 대체로도
  못 잡던 카드(링크도 판매자번호도 없음, 찜질기·탄소매트 6연속 실패) 해소. 이음매 허용 폭 앞 3행·뒤 5행.
  1.1.25 (2026-09-12, 마이그레이션 `20260911170000_naver_shopping_runtime_1_1_25_rendered_identity.sql`)
  — 정렬 복구 증명의 직접 식별자: 판매자 상품번호가 숫자가 아닌 카드는 정규 상품 URL로 식별(1.1.24가 드러낸
  `renderedorderproof_direct_identity` 실패 해소, 배찜질기 그룹).
  1.1.24 (2026-09-11, 마이그레이션 `20260911120000_naver_shopping_runtime_1_1_24_failure_evidence.sql`)
  — 정렬 복구 경로에서 다음 페이지 머리(앞 2행)에 앞 페이지 꼬리(뒤 3행) 상품이 다시 나오면 이음매로
  건너뜀(복부찜질기 `2:7:page_overlap:1` 매 사이클 실패 해소, `SEAM_LEADING_ORGANIC_ROWS`·
  `SEAM_TRAILING_ORGANIC_ROWS`); 워커가 목록 밖 정렬 복구 실패 사유를 지우지 않고 같은 안전 문자셋으로 기록(사유 없는
  `provider_stable_rendered_order_unproven` 근절). 같은 페이지 판매자 중복(`duplicate_row`)은 창 계약이
  동일 식별자 중복을 금지하므로 그대로 실패 유지(계약 변경 없이는 커밋 불가).
  1.1.23 (2026-09-11, 마이그레이션 `20260911090000_naver_shopping_runtime_1_1_23_rendered_page_tolerance.sql`)
  — 정렬 복구 경로를 네이버 실제 페이지에 맞춤: 전체 상품 수는 실시간 집계라 8페이지 동일 대신 1% 이내
  (`MARKET_TOTAL_TOLERANCE_RATIO`), 한 페이지 안 같은 상품 두 번 노출은 한 슬롯으로 건너뜀(페이지당 최대
  `MAX_RENDERED_DUPLICATE_ORGANIC_SLOTS`=2), 1페이지는 자기 광고 슬롯 수만큼 뒤에서 시작 가능, 이음매는 최대 2칸
  후퇴 허용. 실패 사유 `page_budget`·`invalid_window`·`duplicate_slot`이 코드에 붙어 기록됨.
  1.1.22 (2026-09-11, 마이그레이션 `20260911003000_naver_shopping_runtime_1_1_22_seam_repeat_and_login_redirect.sql`)
  — 페이지 이음매에서 같은 상품이 두 번 나오면 창을 실패시키지 않고 한 번만 건너뛴다(창당 최대 2회,
  `provider.mjs`의 `MAX_SEAM_REPEAT_SKIPS`), 수집 프로필이 `nid.naver.com`으로 리다이렉트되면
  `naver_page_script_failed` 대신 `naver_verification_required`(보호 대기 + 탭 노출)로 보고한다.
  1.1.21 (2026-09-03) 유한 창 일반화·이음매 허용. 마이그레이션은 런타임 식별자(유한 창 대상 행·coordination 행·
  progress 입구 게이트)만 옮기며, 관문이 직전 버전의 유휴 제어 평면을 요구하므로 반드시 위 순서 ③ 다음에 적용한다.
- **재발 방지**: 버전 인상 시 account-priority 게이트 등 runtime 리터럴을 품은 DB 함수를 전수 grep 한다 (`grep -rn "runtime_version is distinct from '" supabase/migrations` — 최종 정의의 무버전 유지는 `npm run check:release` 의 `shoppingAccountPriorityGateRuntimeNeutralOnRuntimeBump` 검사가 강제).
- **안 되면 다음**: 마이그레이션 관문이 `requires_idle_control_plane`으로 거부하면 lease 만료(최대 35분,
  `WORKER_COLLECTION_LEASE_SECONDS`)를 기다린 뒤 재적용한다. 되돌려야 하면 사전에 작성한 역전환 SQL을
  같은 정지 창 안에서 적용하고 직전 `main` 커밋으로 ③·⑤를 반복한다. 서명만 오고 진척이 없는 상태는
  증상 ①의 `NAVER_RANK_WORKER_SILENT`와 겹치므로 버전 대조를 먼저 끝낸 뒤 ①로 넘어간다.

---

## 참고 (실측 근거)

- 상품 크론이 하이브리드 워커 상태를 보고하는 코드: `src/server/handlers/naver-rank-cron.mjs`
  (슬롯 + 60분 유예 이후 판정. 최근 30분 진척 0 → `NAVER_RANK_WORKER_SILENT`,
  코디네이션 행 조회 자체가 실패 → `NAVER_RANK_WORKER_SIGNAL_UNKNOWN`. 둘 다 503).
- **서명(nonce)은 진척의 증거가 아니다.** nonce 는 서명 검증 직후, 본문 `JSON.parse` 와 모든
  `action` 분기보다 먼저 삽입된다(`src/server/handlers/naver-shopping-local-worker.mjs` 의
  `consumeNonce`). 그래서 아무 일도 하지 못하는 워커도 매분 서명을 남긴다.
  실측(2026-09-01T08:30Z 프로덕션 읽기 전용 조회): 최신 nonce 54초 전 · 최신 스냅샷 15.1시간 전 ·
  `primary_seen_at` 14.4시간 전 · 깨우기 요청 2.5시간째 미소비. 서명 기준이면 이 15시간 중단이
  202 `ok:true` 로 나갔다. 그래서 판정을 `primary_seen_at`·`last_success_at` 로 옮겼다.
  30분 기준의 근거: `naver_shopping_worker_runs` 14일 표본 713건에서 실행 간격 p50 9.99분 ·
  p90 10.01분(= 확장 프로그램 `rank-catch-up` 알람 10분 주기). 30분은 그 3배다.
- 배포 브랜치 게이트: `scripts/check-deploy-branch.mjs` (`npm run check:deploy-branch`).
- 수집기 증거 우회: `MI_ALLOW_STALE_WORKER_PROOF=1` (`scripts/check-naver-shopping-collector-live.mjs`).
- 배포 후 검증: `npm run verify:live` (`scripts/verify-live.mjs`).
- 잔존 실패 감시: `scripts/check-rank-residual-failures.mjs` + `.github/workflows/naver-rank-residual-audit.yml`.
