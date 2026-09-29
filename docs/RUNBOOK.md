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
- **맥 대기기는 자동으로 따라온다(2026-09-13)**: 워치독이 10분마다 동기화 원본(맥 체크아웃 `main`)을
  `origin/main`으로 fast-forward 한 뒤(`sync_source_fast_forwarded from=… to=…`) 드리프트 동기화·Chrome
  재기동을 이어서 한다. 수동 `git pull`은 더 이상 필요 없다. 보류 로그 `sync_source_behind action=none
  reason=diverged|repository_dirty` 또는 `sync_source_pull_skipped reason=not_on_main`이 보이면 체크아웃을
  사람이 정리해야 한다(로컬 커밋·더러운 런타임 파일·다른 브랜치). `sync_source_fetch_failed`는 네트워크/ssh.
  사고 기록: 2026-09-12 14:10(1.1.26 라이브)부터 09-13 13:27까지 체크아웃이 1.1.25에 머물러 대기기가 매분
  신원 불일치(exit 1)였고, 윈도우가 꺼진 00:45~13:20 사이 12.5시간 수집이 멈췄다.
- **버전 이력**: 1.1.33 (2026-09-28 준비·배포일 별도, 마이그레이션 `20260928022048_naver_shopping_runtime_1_1_33_collection_window_and_probe.sql`; 수집 창 자동 생성·마지막 창 유지·원문 오류 보존·주작업기 즉시 탐침) / 1.1.32 (2026-09-19 준비·배포일 별도, 마이그레이션 `20260919020000_naver_shopping_runtime_1_1_32_finite_cross_page_repeats.sql`; 교차 페이지 중복이 있는 유한 시장(탄소매트 289행)을 유한 중재로 보내고 두 캡처 유한 다이제스트를 그 중복의 증명으로 인정) / 1.1.31 (2026-09-18 준비·배포일 별도, 마이그레이션 `20260918030000_naver_shopping_runtime_1_1_31_evidence_v2_third_pass.sql`; 실패 증거 v2(유기 행 우선 보존·분기 추적·슬롯 diff·24000자), 안정창 증명 3차 캡처(24페이지 상한), 유한 시장 카운터 1% 허용, 워커 사유 `three_passes` 통과) / 1.1.30 (2026-09-13 준비·배포일 별도, 마이그레이션 `20260913150000_naver_shopping_runtime_1_1_30_finite_drift_evidence.sql` + 증거 테이블
  `20260913140000_naver_shopping_failure_evidence.sql`)
  — 유한 시장+드리프트 복합(탄소매트 fke 4회 연속 실패): 어느 패스든 부분창이면 유한 시장 중재로 진입하고 후보는
  드리프트 시 위치 기반 파싱으로 대체, 시장 끝 뒤 빈 페이지 허용. 실패 증거 캡처: 네이티브 호스트가 실패한 수집의
  모든 캡처를 요약(식별자·순위번호만, ≤12KB)해 실패 보고에 실어 보내고 서버가 `naver_shopping_failure_evidence`에
  30일 보관 — 이후 실패 원인은 이 표의 evidence(passes[i][page].rows=[[순위번호, s:판매자번호|c:원부|n:상품번호] | [\"a\", 순위번호]])로 읽는다.
  1.1.29 (2026-09-13, 마이그레이션 `20260913050000_naver_shopping_runtime_1_1_29_rendered_cross_page_repeats.sql`)
  — 정렬 복구 경로에서 페이지 간 반복 보존: 1.1.28 첫 런(13:25, 콘트로이친) `6:7:page_overlap:4` — 같은 판매자
  상품이 4·6페이지에도 노출. 엄격 경로의 안정 전체창 증명처럼 정렬 복구 후보·두 캡처 증명·서버 신뢰창이 모두
  보존(이음매 스킵은 유지). 유한 시장 실패 사유(`provider_stable_finite_window_unproven:<사유>`) 이벤트에 노출.
  1.1.28 (2026-09-13, 마이그레이션 `20260912160000_naver_shopping_runtime_1_1_28_same_page_twins_unbounded.sql`)
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
- **안 되면 다음**: 마이그레이션 관문이 `requires_idle_control_plane`으로 거부하면 코디네이션 행의 잠금 열
  (`lease_worker_id`·`lease_token`·`lease_until`·`run_id`·`current_stage`)과 활성 추적기의 `processing_until`을 본다.
  잠금이 만료돼도(`lease_until` 경과든 아래 3차 훈련 후속 A 의 죽은 잠금 인계든) 이 열은 남는다 — 기다리기만 해서는
  비지 않는다. 비우는 것은 보유자의 release, 또는 만료 뒤 서버 관문을 통과한 작업기의 claim(부여 → `claiming` 이
  DB progress 관문에서 거절 → 서버 release)뿐이다. 배포 창(서버 새 런타임·DB 옛 관문)에서 그런 작업기는 새 런타임
  주작업기 하나다: 옛 런타임 작업기는 서버가 400 으로 DB 전에 막고, 새 런타임 대기기는 코디네이션 정체가 옛 버전이라
  `runtime_identity_invalid`(인계 전 단계)로 거절된다. 그래서 윈도우 갱신(⑤)을 먼저 해 새 주작업기를 띄운다(관문 뒤
  옛 윈도우는 어차피 수집하지 못한다). 그 claim 은 죽은 잠금이면 max(마지막 보유자 쓰기 + 6분, `navigating` + 16분)
  뒤(20260929120000 적용 뒤), 아니면 `lease_until`(부여 + 최대 35분, `WORKER_COLLECTION_LEASE_SECONDS`) 뒤에 열을
  비운다. 추적기 `processing_until`(claim + 35분)도 지나야 한다. 그 뒤 재적용한다. 되돌려야 하면 사전에 작성한 역전환 SQL을
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

## 순위 목록 조회 안정화 (2026-09-13)
- 증상: 추적 화면에 "순위 추적 서버 연결 실패로 마지막 정상 순위와 이력을 유지합니다" — 브라우저의 목록 GET 이
  던져진 경우(시간 초과·네트워크)다. 5xx JSON 응답은 이 배너가 아니라 "전체 순위 목록 검증에 실패…"로 나온다.
- 서버: `listTrackers` 가 그룹·스냅샷·검색량·워커 상태·운영 정보를 동시에 읽는다(`loadTrackerListDetails`). 검색량은
  목록에서 2.5초 예산만 쓴다(`MI_RANK_LIST_KEYWORD_VOLUME_BUDGET_MS`). 2초 이상 걸린 목록은 Vercel 로그에
  `naver_rank_trackers_list_slow` 한 줄(accessMs·trackersMs·detailsMs·totalMs)로 남는다(`MI_RANK_LIST_SLOW_LOG_MS`).
- 브라우저: 목록 GET 제한 30초, 실패 시 1.5초 뒤 1회 재시도, 배너에 사유(시간 초과/네트워크) 표기.
- 다음 재현 시: 배너 사유와 시각을 받아 Vercel 로그의 `naver_rank_trackers_list_slow`/`naver_rank_trackers_failed` 와 대조한다.

## 운영 공지 팝업 (2026-09-18)

- 총관리자 화면 `운영 공지`(#mi-admin-site-notice)에서 제목·내용·시작일·종료일·표시 여부를 저장한다. 저장 즉시 반영되고 종료일 23:59(KST)가 지나면 자동으로 내려간다.
- 로그인한 모든 화면(광고주·운영팀·총관리자·체험·만료)이 `/api/site-notice` GET 으로 읽어 세션당 한 번 팝업으로 본다. "오늘 하루 보지 않기"는 기기별(localStorage)이며 공지를 다시 저장하면 다시 뜬다.
- 저장은 총관리자 세션(POST)만 가능하다. 테이블 `site_notices`(단일 행 id=1, 마이그레이션 `20260918050000_site_notices.sql`, 첫 공지 9/18~9/20 점검 안내가 함께 들어간다).

## 대기기 navigation 회로 복구 (2026-09-19)

- 사고: 09-18 13:34 주작업기 정지 → 14:28 맥 인계 → 절전 해제 직후 `naver_page_navigation_failed` 2연속으로 회로 open → 자동 복구가 주작업기 전용이라 대기기가 11시간 `circuit_open` 거절(09-19 00:27 조건부 SQL로 복구).
- 수정: `20260919010000_naver_shopping_standby_navigation_recovery.sql` — 주작업기가 180초 이상 무신호일 때에 한해 대기기도 10분 정적 뒤 navigation 검증(`auto_navigation_probe`)을 열고 수행한다. 일시 오류 검증(30분·2회)은 주작업기 전용 그대로.
- 수동 복구 절차와 판정표: `docs/skills/mi-collection-incident/SKILL.md`.

## 대기기 런타임 정체 등록 (2026-09-19)

- 사고: 주작업기가 꺼진 채 런타임 1.1.32 를 올리자 대기기가 70분간 `runtime_identity_invalid` 로 거절(런타임 마이그레이션이 코디네이션 정체를 NULL 로 비우고 주작업기 첫 런으로만 채워졌다). 임시 복구는 대표가 코디네이션에 기대 정체를 채우는 조건부 SQL.
- 수정: `20260919030000_naver_shopping_standby_runtime_identity_registration.sql` — 정체가 통째로 비어 있고 주작업기가 180초 이상 무신호일 때에 한해 대기기를 허용. 정체 고정은 진행 관문이 그대로 수행.
- 이 수정이 DB 에 적용되기 전에는 주작업기가 꺼진 상태에서 런타임 인상을 배포하지 않는다. 맥 Chrome 이 재시작되지 않으면(`chrome_quit_incomplete`) 확장이 옛 버전으로 남으므로 대표에게 ⌘Q 후 재실행을 요청한다.

## N30 70분 정지 후속 (2026-09-27)

- 사고: 09-27 19:33 데스크탑 주작업기 종료 → 맥 대기기는 수집 프로필에 창이 없어 매번 `naver_page_navigation_failed` → 전역 회로 open → 20:21 주작업기 복귀 뒤 20:34:48 탐침 커밋. 커밋 공백 70분 동안 헬스는 `ok:true`(경보 없음).

### S1 경보·플레이스

- **경보 판정**: `/api/rank-collection-health` 의 `lanes.product.commitStalled: true` = 활성 상품 추적기가 있는데
  마지막 커밋 뒤 **45분 이상** 커밋이 없다. 이때 최상위 `ok:false`. 마지막 커밋 = `naver_shopping_worker_coordination.last_success_at`
  (300위 묶음 커밋만 찍는다)과 `naver_rank_trackers` 의 `max(last_checked_at)`(300위·유한 창 커밋 둘 다 찍는다) 중 최신이다
  (1.1.34 부터 — 아래 `### B 경보: 유한창 커밋`). 크론 `NAVER_RANK_WORKER_NO_COMMIT`·`NAVER_RANK_WORKER_SILENT` 도 같은 "마지막 커밋"을 본다.
  어느 작업기가 살아 있는지와 무관하다(주작업기가 꺼져 하트비트가 낡아도 뜬다). 의도된 정지(`manual_stop`·`manual_canary`·
  네이버 쿨다운)·수동복구 대기(`transient_recovery_manual_required`)·활성 0건은 예전처럼 제외한다.
  09-27 기준: 19:24:28.823 커밋 → 20:09:28.823 부터 `ok:false` → 20:34:48.822 커밋에 해제. 헬스 60초 캐시는 45분 경계를 넘겨 들고 있지 않는다.
- **폰 경보가 오는 시각(정직한 상한)**: 마지막 커밋 뒤 **45분** + CDN 캐시 + UptimeRobot 점검 간격(**최대 5분**).
  - CDN 캐시: 핸들러는 `s-maxage=60, stale-while-revalidate=120` 을 싣는다. 이 값이 살아 있으면 최대 약 3분(60 + 120초)이 더 붙는다.
    다만 지금은 런타임 래퍼(`src/server/runtime.mjs`)가 `cache-control: no-store` 로 덮어 CDN 이 캐시하지 않는다
    (2026-09-28 라이브 실측 `cache-control: no-store`·`x-vercel-cache: MISS`) — 현재 실제 추가분은 0 이고, 이 덮어쓰기가 풀리면 약 3분이 붙는다.
  - 인프로세스 60초 캐시는 45분 경계에서 끊으므로(`rankHealthCacheExpiresAt`) 늦추지 않는다.
  - 그래서 지금 기준 폰 경보는 커밋 뒤 45~50분(CDN 캐시가 살아나면 최대 약 53분) 사이에 온다.
  - 1.1.34 부터: `last_checked_at` 은 작업기 시계로 찍힌 수집 시각이라, 작업기 시계가 서버보다 앞서면 그만큼(서버 허용 최대 5분) 더 늦을 수 있다(최악 약 55분). 2분을 넘게 앞선 값은 그동안 커밋으로 세지 않는다. 실제 시계 차 크기는 미확인.
- **런타임 배포 중에는 정상 경보가 뜬다**: 런타임 인상 배포 창(서버 release 변경 → 윈도우 워커 갱신 → 첫 커밋)에서 커밋 공백이
  45분을 넘으면 `ok:false`(`commitStalled:true`)가 **정상적으로** 뜬다. 오탐이 아니라 실제 커밋 공백이며, 첫 커밋 뒤 인프로세스 캐시(최대 60초)가 지나고 다음 UptimeRobot 점검에서 풀린다.
- **근거**: 14일 커밋 공백 실측 — 45분 초과 11건은 전부 실제 정지(최소 69.3분), 정상 최대 38.2분(300위 커밋 `tracker_committed` 만 센 값). 예전 기준(90분 초과 + 하트비트 15분 안쪽)은 09-27 을 못 잡았다.
  1.1.34 재료(유한 창 포함) 기준 14일(09-15~09-29): 45분 이상 12건 — 09-29 훈련 3 의 50.5분, 09-19 대기기 단독 47.0분 포함 — 그 밖의 최대 40.0분.
- **크론과의 차이**: 상품 크론은 같은 판정 함수를 쓰되 주작업기 진척이 30분 안이면 `503 NAVER_RANK_WORKER_NO_COMMIT`(문구 "45분 이상"),
  30분 넘게 끊기면 `503 NAVER_RANK_WORKER_SILENT`, 09:05·15:05 슬롯 뒤 60분 유예 중이면 판정하지 않는다. 헬스는 유예가 없다.
  1.1.34 부터 진척에도 유한 창 커밋(`max(last_checked_at)`)이 들어간다. 남는 차이는 축 길이뿐이다: 마지막 커밋이 30~45분 전이고
  주작업기 하트비트도 30분 넘게 낡았으면 크론은 SILENT, 헬스는 `ok:true`(1.1.33 부터 있던 차이).
- **경보를 받으면**: 코디네이션 행의 `circuit_state`·`circuit_reason`·`primary_seen_at`·`last_failure_code` 부터 본다(`docs/skills/mi-collection-incident/SKILL.md`).
  맥 워치독은 `commit_stalled action=none` 으로 기록만 하고 Chrome 을 재기동하지 않는다 — 원인이 주작업기·서버·DB 어디든 켜지는 신호라서다.
  1.1.34 부터 코디네이션 행을 못 읽는 틱은 `health_not_recoverable action=none continuity=reset` 대신 이 줄이 남을 수 있다(조치는 같다, `### B` 참고).
- **배포 검증**: `verify-live` 4) 의 상품 커밋 나이 상한은 `< 45`. 커밋이 45분 넘게 없는 중에 배포하면 FAIL 이 정상이다(첫 커밋 뒤 다시 돌린다).
- **확인 필요(대표)**: UptimeRobot 수집 모니터 키워드가 `"ok":true`(없으면 DOWN) 또는 `"commitStalled":false`(없으면 DOWN)인지. 다른 키워드면 이 경보가 폰에 오지 않는다.
- **플레이스 러너**(`scripts/place-rank-actions-worker.mjs`): 20건 상한을 없앴다. 서버가 '할 일 없음'이라 할 때까지 한 건씩(동시 1) 처리하고,
  새 할 일은 시작 후 45분 안에서만 받는다. 로그 `Naver place rank worker window` 의 `stopReason`:

  | stopReason | 뜻 | 실행 결과 |
  |---|---|---|
  | `drained` | 받을 일 없음 | 성공 |
  | `time_budget` | 45분 지남, 남은 일은 다음 예약 실행(매시 :37 등) | 성공 + `::notice::` 한 줄 |
  | `job_cap` | 안전 상한 200건 | 성공 + `::notice::` 한 줄 |
  | `revisit` | 이번 실행에 결과를 기록한 추적기가 재시도 일정으로 다시 옴(= 밀린 일을 다 받음) | 성공 + `::notice::` 한 줄 |
  | `lookup_timeout` | 조회가 보호 시간(서버 조회 마감 `providerDeadlineAt` + 60초, 최대 330초 < 서버 리스 360초) 안에 안 끝남, 두 번째 브라우저를 띄우지 않고 멈춤 | 실패(결과 전송이 `lease_lost` 여도) |
  | `lookup_failing` | 저장한 뒤 조회 3연속 실패(차단 의심), 또는 저장 0건에서 2연속 실패인데 예전 경로로 넘길 수 없음(아래) | 실패(결과 전송이 `lease_lost` 여도) |
  | `worker_api_lost` | 워커 API 불가인데 예전 경로로 넘길 수 없음(아래) | 실패 |

  조회 실패·부분 결과·결과 전송 실패가 한 건이라도 있으면 지금처럼 실패(빨간 X)다. 판정은 합계만이 아니라 `stopReason` 도 본다 —
  `lookup_timeout`·`lookup_failing`·`worker_api_lost` 는 결과 전송이 `lease_lost` 로 돌아와 실패 건수가 0 이어도 빨간 X 다.
  결과 전송에 실패한 추적기가 처리 권한(360초) 만료로 다시 오면 다시 세지 않고 건너뛴 뒤 남은 일을 계속 받는다(한 실행 3번까지).
- **예전 경로(서버 → Render)로 넘기기(fallback)**: 계기는 그대로(워커 API 불가, 또는 저장 0건에서 조회 연속 2회 실패)지만 **늦은 넘김은 없다**.
  세 조건을 모두 채울 때만 넘긴다: ① 아무것도 저장하지 않았다 ② 이 러너에서 조회가 한 번도 성공하지 않았다(`ok:false` 가 아닌 결과를 돌려준 적 없음)
  ③ 수집 단계 시작 후 10분이 지나지 않았다. 하나라도 어기면 넘기지 않고 실패로 끝내며, 로그 `Naver place rank worker stopped {"action":"no_handoff","handoffBlockedBy":…}`
  와 `window` 줄의 `handoffBlockedBy`(`saved` · `lookup_succeeded` · `late`), 오류 줄에 이유를 남긴다. 저장 0건 2연속 실패 자리에서 멈추므로 러너 요청 수는 예전과 같다.
  워크플로 yml 은 바꾸지 않았다(`timeout-minutes: 100` ≥ 준비 4 + 예산 45 + 꼬리 10 + 예전 단계 여유 40, 테스트가 고정). 넘김은 시작 후 10분 안뿐이라
  예전 단계는 적어도 100 − 4 − 10 = 86분을 갖는다(예전 단계 최악 ≈ 89분은 20묶음이 전부 260초 제한 직전까지 걸릴 때뿐).

### S2 대기기 실패 격리

- 사고: 09-27 19:33 주작업기 종료 → 맥 대기기 인계. 수집 프로필(Profile 5)에 창이 0개라 `chrome.tabs.create` 가 "No current window" 로 즉시 거절(`naver_page_navigation_failed`) → 대기기 실패 2건(19:42:33·19:52:06)이 전역 회로를 열고, 대기기 검증 실패 2건(20:03:00·20:19:58)이 다시 열어 20:20 에 돌아온 주작업기의 첫 커밋이 20:34:48.
- 수정: `supabase/migrations/20260927120000_naver_shopping_standby_failure_isolation.sql` (런타임 무관·RPC 서명 불변·새 열 6개, 1.1.32 워커 그대로 호환)
  - 대기기 기기 쪽 실패 11종(브라우저·확장·네이티브 호스트·로컬 기한, 목록과 출처는 마이그레이션 머리말)을 등록된 주작업기가 아닌 워커가 보고하면 전역 실패 서명·회로를 건드리지 않고 임대만 돌려준다. 같은 대기기가 한 사건에서 2회째면 30분, 3회 이상이면 60분 쉰다(벤치, 거절 사유 `standby_benched`). 3시간 넘게 끊기거나 그 사이 원자 커밋이 있으면 다음 실패는 새 사건(1회째). 주작업기 성공은 걸려 있는 벤치를 풀지 않는다(주작업기가 살아 있으면 벤치는 영향이 없다).
  - 대기기의 반쪽 열림 검증이 실패하면 회로는 지금처럼 다시 열린다(fail-closed). 회로 사건을 시작한 워커를 `circuit_opened_by_worker` 에 남긴다: 닫힌 회로를 실패로 연 워커, 단 같은 실패 서명의 앞선 1회째 실패가 주작업기 것이었으면 주작업기(두 기기가 같은 네이버 페이지 실패를 봤으면 대기기에서만 난 사슬이 아니다 → 예전 대기). 그래서 닫힌 동안에는 서명 연속 1회째 실패의 워커를 적어 둔다. 반쪽 열림 동안에도 그대로 두고, 주작업기가 잡은 검증이 실패·미완료 해제·임대 만료로 끝나면 주작업기로 바꾼다. 대기기가 잡은 자동 검증(`auto_navigation_probe`·`auto_transient_system_probe`)이 그렇게 끝나면 값은 그대로, 대기기가 잡은 canary(`manual_canary`)가 그렇게 끝나면 값을 비운다(예전 규칙). 해제에서 검증이 회로를 복구하면 지운다.
  - 대기기에서 시작된 회로이고 주작업기가 그 회로에서 자기 자동 검증을 아직 쓰지 않았으면(`transient_system_probe_attempts` = 0, 자기 검증 실패 없음) 주작업기는 정적 대기 없이 반쪽 열림 검증 1건을 바로 받는다(수동 종단 `transient_recovery_manual_required`, 서명 없는 `probe_incomplete` 포함). 사유가 자동 경로만 쓰는 것이고 회로가 멈춘 코드가 일시 오류·대기기 기기 코드(18종)일 때만 해당한다: 실패 함수가 쓴 서명(`circuit_reason = failure_signature`)은 그 서명의 코드, `probe_incomplete`·`probe_interrupted`·`transient_recovery_manual_required` 는 마지막 실패 코드(`last_failure_code`)를 본다. 그래서 대기기 검증 중 네이버 차단(보안)이 기록됐는데 차단 호출(block-lane)이 실패해 그냥 해제됐거나 워커가 죽어 임대가 만료된 경우, 추적기 코드로 끝난 검증은 예전 그대로다(자동 출구 없음 → 판정표의 조건부 회로 정리 SQL). 살아 있는 임대·보안 cooldown 이 있으면 예전 응답 그대로다. 그 검증이 실패·미완료·만료되면 주작업기가 연 회로가 되어 예전 규칙(10/30분 대기, 일시 오류 2회 예산, 대기기 인계 1회, 수동 종단)이 그대로 적용된다 → 회로당 이른 검증 최대 1건, 반복 없음. 주작업기가 연 회로, 주작업기가 일시 오류 검증 2회를 다 쓰고 대기기 인계까지 실패한 회로는 예전처럼 수동 종단이 유지된다. `manual_stop` 등 수동 정지(콜론이 든 사유 포함)·`probe_security_block`·자동 출구 없는 네이버 페이지 서명은 해당 없음(원자 커밋·수동 정지·수동 닫기는 이 마이그레이션이 다시 선언하지 않아 열 값을 남기지만, 사유 허용 목록이 막는다).
  - 네이버 차단 계열(scope `security`: 보안 확인·접속 제한·418/429/403·캡차·로그인·접근 차단)은 전역 cooldown 30/60분 그대로. 차단 호출이 실패해 cooldown 이 안 걸린 경우에도 주작업기 즉시 검증은 없다(위).
- 적용 확인(대표, 읽기 전용): `docs/sql/20260927120000_naver_shopping_standby_failure_isolation.verify-applied.sql` 실행 → 9행 모두 `applied = true`.
- 되돌리기(필요할 때만): `docs/sql/20260927120000_naver_shopping_standby_failure_isolation.rollback.sql` — 옛 함수 3개를 그대로 복원하고 새 열은 남긴 채 값만 비운다.
- 벤치 수동 해제(맥을 고친 뒤 벤치가 끝나기를 기다리기 싫을 때, 대표 실행, 결과 1행):
  ```sql
  update public.naver_shopping_worker_coordination
  set standby_benched_until = null, standby_failure_streak = 0
  where lane_key = 'global' and standby_benched_until is not null
  returning standby_failure_worker_id, standby_last_failure_code, standby_last_failure_at;
  ```
- 진단: 대기기의 기기 쪽 즉시 실패는 이제 회로를 열지 않으므로 `circuit_state` 만으로는 안 보인다 → `standby_benched_until`·`standby_last_failure_code`·`circuit_opened_by_worker` 를 본다(`docs/skills/mi-collection-incident/scripts/diagnose.mjs` 가 출력, 대기기에서 시작돼 주작업기 즉시 검증 대상인지도 판정 힌트에 찍는다. 최근 실패 증거는 5행, `evidence.errorDetail` 이 있으면 함께). 관리자 운영 화면에는 아직 벤치가 나오지 않는다.
- 남은 위험(기존 그대로): 주작업기 자신의 자동 검증이 해제 복구 목록에 없는 추적기 범위 코드(예: `provider_stable_rendered_order_unproven`)로 끝나면 `probe_incomplete` 에서 자동 출구가 없다 → 판정표의 조건부 회로 정리 SQL.
- canary(`mi_request_naver_shopping_worker_probe`, 사유 `manual_canary`): 요청 함수는 다시 선언하지 않았지만 canary 가 끝나는 곳(실패·미완료 해제·임대 만료)은 이 마이그레이션의 세 함수다. 대기기가 잡은 canary 는 값을 비우고 주작업기가 잡은 canary 는 주작업기로 바꾸므로, 앞 사건의 대기기 값이 남아 있어도 canary 뒤에는 예전 그대로다(실패 → 30분 대기, 미완료·만료 → 자동 출구 없음 → 판정표의 조건부 회로 정리 SQL).
- 알려진 한계(이 마이그레이션): 원자 커밋·수동 정지·수동 닫기는 다시 선언하지 않아 `circuit_opened_by_worker` 에 예전 값이 남을 수 있다. 수동 정지 사유는 허용 목록에 없어 막히지만, 손 SQL 로 `mi_stop_naver_shopping_worker` 에 현재 `failure_signature` 와 글자까지 같은 사유를 넣으면 남은 대기기 값 때문에 돌아온 주작업기가 즉시 검증 1건을 받는다(앱 버튼은 항상 `manual_stop`, `mi_stop` 은 `failure_signature` 를 지우지 않음). 손 SQL 로만 생기는 경우라 영향은 작다. 다음 변경 때 원자 커밋·정지가 이 열을 비우도록 다시 선언한다.

### S3 1.1.33 수집 창·원문 오류·즉시 탐침

- 사고 고리: 맥 대기기 `Profile 5` 에 일반 창이 0개 → 확장의 `chrome.tabs.create` 가 `No current window` 로 거절 → `naver_page_navigation_failed` 4회 → 전역 회로 open. 서버에는 코드만 남아 원문을 알 수 없었고, 20:21 돌아온 주작업기의 1분 `rank-remote` 는 half_open 부여를 wake 가 없다며 풀어 20:34 `rank-catch-up` 까지 기다렸다.
- 수집 창(확장 `service-worker.js`):
  - 프로필에 (시크릿 제외) 일반 창이 0개일 때만 `chrome.windows.create({ url, focused: false, state: "minimized" })` 로 수집 창을 한 번 열고, 150ms 간격 최대 4회 최소화를 확인한다. 창이 있으면 예전 그대로 `chrome.tabs.create({ url, active: false })`.
  - 그 탭은 다음 수집에 다시 쓴다. 조건: 유일한 비시크릿 창 = 기록된 수집 창, 탭 1개, 창이 최소화 상태, 주소가 `about:blank` 또는 `https://search.shopping.naver.com/…`, 주소창 이동 중(pendingUrl 다름)이 아님.
  - 기록(`chrome.storage.session`)은 Chrome 재시작·확장 다시 불러오기 때 지워진다. 기록이 아예 없을 때만, 유일한 비시크릿 창이 최소화 상태이고 탭 1개가 정확히 `about:blank`(이동 중 아님)이면 그 창을 수집 창으로 받아 기록하고 `tabs.update` 로 다시 쓴다(맥에서 최소화 창에 `tabs.create` 하면 창이 다시 보인다). 보이는 창, 다른 주소(검색 페이지 포함)의 탭, 탭 2개 이상, 창 2개 이상, 기록을 읽을 수 없거나 모양이 틀린 경우는 받지 않고 예전처럼 새 탭을 연다.
  - 수집 탭이 마지막 비시크릿 창의 마지막 탭이면 닫지 않고 `about:blank` 로 비우고 최소화한다(마지막 창을 닫으면 Chrome 이 프로필과 확장을 내린다 — 09-27 대표 맥 실기). 비운 뒤 `about:blank` 가 확정될 때까지 150ms 간격으로 최대 5번 확인한다(최대 0.6초). 네이티브 호스트가 곧바로 보내는 다음 패스가 이동 중인 탭을 거절하고 최소화 창에 새 탭을 여는(맥에서 창이 다시 보이는) 틈을 막기 위해서다. 검증 탭 정리도 같은 규칙. 사람의 탭만 남은 창, 다른 비시크릿 창이 있는 경우에는 예전처럼 수집 탭만 닫는다. 정리는 예외를 던지지 않는다.
  - 대표가 보게 되는 것: Dock·작업표시줄에 최소화된 `개발` 창 1개. 이 창을 닫으면 그 기기 수집은 스케줄러 재전달(10분 이내)까지 쉰다(예전과 같음). 맥은 창을 처음 만들 때 0.2초 남짓 보였다가 최소화된다. 주작업기가 복귀 직후(1~2분) 탐침할 때도 이 창이 생길 수 있다.
- 원문 오류(`errorDetail`, 확장 → 네이티브 호스트 → 로컬 워커 → 서버):
  - 정제: 출력 가능한 ASCII 만 → 첫 `http` / `://` / ` url` / `?` 부터 잘라냄 → 공백 정리 → 최대 120자 → 남은 ASCII 키워드(토큰 사이 공백 제외 3자 이상)는 그 부분만 `<kw>`. 확장은 키워드 없이 먼저 120자로 자르므로 사슬 전체 순서는 120자 → 키워드다. 실패 코드·회로 서명·RPC 인자는 그대로다. 이름은 `errorDetail` 만 쓴다(`detail` 은 워커가 일부 실패 코드에 이어 붙인다).
  - 저장: `naver_shopping_failure_evidence.evidence->>'errorDetail'`. 캡처 증거가 없는 실패는 `{"version":"collection-error-v1","errorDetail":…}` 행(keyword 열은 빈 문자열, run_id·tracker_id 로 job_failed 와 조인). DB 변경 없음. 1.1.32 워커 본문(필드 없음)도 그대로 받는다.
  - 조회(읽기 전용): `GET /rest/v1/naver_shopping_failure_evidence?select=occurred_at,worker_id,run_id,tracker_id,error_code,evidence->>version,evidence->>errorDetail&order=occurred_at.desc&limit=10`
  - 원문이 없는 것이 정상인 실패: 스스로 코드를 만든 실패(`naver_page_timeout`, `naver_page_script_timeout`, `provider_deadline_exceeded`, `naver_next_data_missing` 등). 맥 대기기는 네이티브 호스트 로그에도 `local_worker_collection_error_detail:…` 한 줄(안전 코드 형태, 80자)이 남는다. 윈도우는 서버 행이 유일한 기록이다.
- 즉시 탐침(로컬 워커):
  - 주작업기(`workerRole` primary)의 1분 `rank-remote` 가 claim-lane 에서 `autoRecovery === true && circuitState === "half_open"` 부여를 받으면 wake 없이 1건만 즉시 검증한다. 대기 중인 wake 는 같은 실행이 소비한다.
  - 언제 부여하는지(회로당 검증 1회, 정적 대기, cooldown)는 DB 가 정한 그대로다. 1c 는 부여 시각을 바꾸지 않는다. 주작업기가 받은 부여를 버리지 않고 바로 쓸 뿐이다. S2 마이그레이션(`20260927120000`) 적용 뒤에는 대기기에서 시작된 회로(`circuit_opened_by_worker` 가 주작업기가 아님)가 위 S2 절의 조건(주작업기가 그 회로에서 자기 자동 검증을 아직 쓰지 않음, 살아 있는 임대·보안 cooldown 없음, 멈춘 코드가 일시 오류·대기기 기기 코드, 수동 종단·서명 없는 `probe_incomplete` 포함)을 채우면 돌아온 주작업기에 정적 대기 없이 부여된다(사유 `auto_navigation_probe`/`auto_transient_system_probe` 라 `autoRecovery: true`). 주작업기가 연 회로(주작업기 검증이 실패·미완료·만료돼 주작업기로 바뀐 회로 포함)는 예전 정적 대기(10/30분)·수동 종단 그대로다. 1c 는 그 부여가 `granted: true`, `autoRecovery: true`, `circuitState: "half_open"` 세 값을 모두 돌려줄 때만 동작한다(하나라도 빠지면 예전처럼 wake 를 기다린다).
  - 계정 우선 요청이 활성인 동안에는 서버가 `rank-catch-up` 이 아닌 실행에 `waiting`(`account_priority_active` / `account_rank_catch_up_trigger_required`)을 준다. 그래서 주작업기의 `rank-remote` 탐침은 매분 claim-lane → claim-wake → queue-all → claim → release 로 빈손으로 끝나고(네이버 요청 0, 서버 요청은 1c 전보다 분당 2건 많음), 검증은 다음 `rank-catch-up`(최대 10분)이 한다. 이때는 '1건 즉시 검증'이 일어나지 않는 것이 정상이다.
  - 대기기는 예전 그대로(wake 가 있을 때만) — 대기기 1회 인계를 더 자주 쓰지 않게 하려는 것이다.
  - 불변식 "1분 폴링은 신호가 없으면 네이버를 열지 않는다"의 유일한 예외다. 관측 가능한 표지는 DB 뿐이다: 회로 half_open 부여 직후의 `naver_shopping_worker_runs.run_trigger = 'rank-remote'` 런(윈도우 주작업기, 런 행은 작업을 받아 `navigating` 을 보고할 때만 생긴다). 요약 `autoRecoveryProbe: true`·로그 `local_worker_auto_recovery_probe` 는 주작업기에서만 생기는데, 윈도우 주작업기는 stderr 를 남기지 않고(`RedirectStandardError = false`) 맥은 늘 대기기(`MI_NAVER_SHOPPING_WORKER_ROLE=standby`)라 맥 로그에 이 표지가 없는 것이 정상이다.
- 네이버 요청량: 페이지당 이동 1회 그대로(`about:blank` 비우기는 네트워크 요청 없음). 1분 폴링은 회로 창당 1회 상한 안에서 검증 시점만 앞당긴다(계속 실패하는 주작업기의 검증 간격 평균 약 15분 → 약 11분).

## 3차 훈련 후속 1.1.34 (2026-09-29)

### A 죽은 잠금 인계

- 사고(3차 훈련): 주작업기가 16:04:32 묶음을 잡고 수집하던 중 크롬·네이티브 호스트 강제 종료 → 16:04:39 추적기 claim 만 풀고(`fail`) record-failure·release 전에 죽어 레인 잠금이 16:39:32(35분)까지 남음 → 맥 대기기와 16:19:30 에 돌아온 주작업기 모두 `busy` → 16:44:32 에야 수집(16:45:49 커밋). 14일 원장에 같은 모양 2건 더(09-17 10:38Z 주작업기, 09-18 19:10Z 대기기).
- 수정: `supabase/migrations/20260929120000_naver_shopping_dead_lease_takeover.sql` (런타임 무관·RPC 서명 불변·progress 관문 미변경, 새 열 7개 + BEFORE UPDATE 트리거 1개 + claim 재선언)
  - 트리거가 잠금 보유자의 쓰기마다 `lease_heartbeat_at` 을 찍는다: 부여(새 토큰), touch(`lease_until`), 모든 progress 보고(단계·페이지·job), 원자 성공(`last_success_at`), 실패(`last_failure_at`). 주작업기 1분 폴(`primary_seen_at`·`updated_at`)·스케줄러 커서·회로 기록은 찍지 않는다. `navigating` 보고에는 `lease_collection_started_at` 도 찍는다(서버가 job 마다 `claiming` 을 먼저 쓰므로 한 런의 job 마다 다시 찍힌다). 둘 다 잠금과 함께 비워지고, 손 SQL 로 넣은 값은 트리거가 덮어쓴다.
  - claim(`mi_claim_naver_shopping_worker_lane`)은 런타임 식별 검사 바로 뒤에서, 다른 (작업기, 토큰)의 잠금이 **보유자 쓰기 없음 6분** 이고 **그 잠금에서 시작한 수집이 16분 넘음(또는 수집 없음)** 이면 `lease_until` 만 지금으로 옮긴다(제자리 만료). 그 뒤는 기존 만료와 똑같다: 같은 작업기의 새 런은 바로 받고, 대기기는 주작업기 무신호(180초)일 때만 받는다(아니면 `primary_online`, 잠금은 만료로 돌려 둔다). 반쯤 열린 검증은 `probe_interrupted`/`transient_recovery_manual_required`(09-27 규칙 그대로)가 된다. 추적기 잠금은 건드리지 않는다(죽은 런의 추적기는 `processing_until` 뒤 기존 고아 복구). `runtime_identity_invalid` 로 거절되는 호출은 인계하지 않는다.
  - 인계 기록(마지막 1건): `lease_reaped_at`·`lease_reaped_worker_id`·`lease_reaped_run_id`·`lease_reaped_stage`·`lease_reaped_by_worker_id`.
  - 적용 순간 살아 있던 잠금은 심장박동이 없어 예전처럼 `lease_until`(35분) 만료만 한다.
- 언제 풀리나: max(마지막 보유자 쓰기 + 6분, `navigating` + 16분) 뒤의 첫 claim. 주작업기가 살아 매분 폴하면 그 뒤 1분 안, 주작업기 예약 작업이 꺼져 있으면 맥 대기기의 다음 알람(최대 10분, 최악 `navigating` + 26분). 3차 훈련 재현(테스트): 16:04:32 `navigating` → 16:21:25 폴이 인계(부여 뒤 wake 없이 release) → 16:24:32 `rank-catch-up` 수집(전에는 16:44:32).
- 왜 6분: 수집 중 한 페이지는 45초 탭 적재 + 15초 스크립트 + 6초 간격 + 30초 progress 응답 ≈ 96초 안에 보고되고, `submitting` 뒤 최장 무신호는 기본 타임아웃에서 submit 120초 + reconcile·fail·record-failure 각 30초 = 210초다. 실측: 1초 표본 최장 무신호 8.0초, 14일 묶음 전체(잡기 → 마지막 커밋) 최대 130.6초. 타임아웃 환경변수를 최대(240초/120초)로 올리면 submit 뒤 600초까지 가능하지만 그때는 네이버 요청이 없어 인계돼도 무해하다(커밋은 추적기 잠금이 지키고 옛 작업기의 성공·실패 기록은 `lease_lost`).
- 왜 16분: 워커는 `navigating` 응답을 받은 뒤 요청 기한 = 그 시각 + 14분(`LOCAL_WORKER_REQUEST_TIMEOUT_MS`)을 정하고, 확장은 매 이동 전·매 적재 뒤, 네이티브 호스트는 매 교환 전에 기한을 본다. DB `navigating` + progress 응답 30초(기본값 — `MI_NAVER_SHOPPING_LOCAL_WORKER_API_TIMEOUT_MS` 는 어느 설치기·래퍼·설정도 쓰지 않는다) + 14분 + 마지막 이동의 적재 45초 + 스크립트 15초 = 15.5분 < 16분. 이 산술은 `scripts/naver-shopping-dead-lease-takeover-migration.test.mjs` 가 코드 상수를 읽어 고정한다(상수·순서가 바뀌거나 그 변수를 설정하는 파일이 생기면 테스트가 깨진다).
- 동시 수집: 깨어 있고 벽시계가 단조인 작업기는 `navigating` 16분 뒤 새 네이버 이동을 시작하지 않는다. 그래서 두 작업기가 동시에 수집하지 않고 네이버 요청량도 그대로다(인계는 기존 claim 호출 안에서만 일어나고 새 폴·알람·재시도는 없다). 예외는 잠자기 복귀와 시계 역행뿐이다. 잠든 보유자(노트북)는 깰 때 로딩 중이던 1페이지까지만 끝내고 기한 확인에서 멈춘다. 벽시계가 뒤로 간 보유자는 다음 페이지 보고가 `lease_lost`(409)로 거절돼 네이티브 호스트가 멈추는데, 확장은 페이지 보고를 기다리지 않고 다음 페이지로 가므로 호스트가 끝날 때까지 그 패스의 페이지를 더 열 수 있다(호스트 종료는 보통 몇 초라 1페이지 안팎). 어느 경우든 옛 작업기의 다음 잠금 호출(progress·touch·성공·실패)은 `lease_lost` 다. 35분 만료에도 있던 잔여이며 이제 16분부터 생긴다.
- 인계만으로는 런타임 마이그레이션의 유휴 관문(`requires_idle_control_plane`)이 풀리지 않는다: 만료는 잠금 열을 비우지 않는다. 비우는 경로는 증상 ⑦ 「안 되면 다음」.
- 적용(대표, Supabase SQL 편집기, 런타임 배포보다 먼저): 레인이 빈 때(매시 x5:30~x3:30, x4:32 알람을 피해서) 마이그레이션 1회. `lock_timeout`(5초)에 걸리면 다시 실행한다.
- 적용 확인(읽기 전용): `docs/sql/20260929120000_naver_shopping_dead_lease_takeover.verify-applied.sql` → 10행 모두 `applied = true`(함수 2·트리거 1·열 7). 다음 수집에서 `lease_heartbeat_at` 이 페이지마다(5~8초) 움직이고 `lease_collection_started_at` 이 `navigating` 시각이며, release 뒤 둘 다 null 이면 정상.
- 되돌리기(필요할 때만): `docs/sql/20260929120000_naver_shopping_dead_lease_takeover.rollback.sql` — 트리거·트리거 함수를 지우고 claim 을 20260927120000 본문 그대로 복원한다(열 7개는 남기고 값만 비움). **20260927120000 되돌리기보다 먼저** 실행한다(09-27 되돌리기를 먼저 돌리면 트리거가 남고 claim 은 인계 없는 옛 본문이 된다 — 무해하지만 적용 확인이 헷갈린다).
- 이후 claim 을 다시 선언하는 마이그레이션은 20260929120000 본문에서 복사한다(테스트가 최신 정의의 두 표지와 6/16분 조건을 검사한다). 타임스탬프를 옮기는 손 SQL·테스트는 트리거를 끄고 해야 하고(아니면 `lease_heartbeat_at` 이 다시 찍힌다), `lease_worker_id`/`lease_token` 을 바꾸는 손 SQL 은 새 부여로 취급된다.

### B 경보: 유한창 커밋

- 결함: 훈련 3 에서 레인이 16:04:32~16:39:32 잠겼다. 마지막 300위 커밋 15:55:17 → 16:40:17 `ok:false`(정상). 그런데 16:45:49 유한 창 커밋(`finite_window_committed`)이
  `last_success_at` 을 갱신하지 않아 다음 300위 커밋 16:56:00 까지 `ok:false` 가 이어졌다(경보 15.7분, 실제 무커밋은 5.5분).
- 수정(서버만, DB 변경 없음, 런타임 무관): "마지막 커밋" = `naver_shopping_worker_coordination.last_success_at` 과 `naver_rank_trackers` 의 `max(last_checked_at)` 중 최신.
  두 커밋 RPC(300위 `mi_commit_naver_shopping_worker_result`, 유한 창 `mi_commit_naver_shopping_finite_worker_result`)가 같은 트랜잭션에서 `last_checked_at = p_checked_at` 을 찍고, 실패 경로는 이 열을 쓰지 않는다.
  판정 함수는 `src/server/naver-shopping/worker-runtime-expectation.mjs` 의 `latestCommitInstant` 하나다. 45분 임계값·"이상" 경계·8키/상품 레인 5키 표면은 그대로다.
  - 헬스(`/api/rank-collection-health`): 상품 레인이 이미 읽는 `max(last_checked_at)` 을 그대로 쓴다 → 새 조회 0. 60초 캐시는 두 표식 중 최신 + 45분 경계에서 끊는다(예: 16:45:49 → 17:30:49).
  - 크론(`/api/naver-rank-cron`): 코디네이션만으로 SILENT·NO_COMMIT 으로 보일 때(또는 `last_success_at` 이 비었을 때)만 상품 표를 한 번 더 읽는다 → 정상 경로 왕복 불변.
    읽기 실패면 1.1.33 판정 그대로. SILENT(진척) 축도 같은 "마지막 커밋"을 진척으로 센다. 헬스와 같은 입력이면 같은 판정이다(대조표 테스트 `naver-rank-cron.test.mjs`).
    남는 차이는 축 길이(크론 진척 30분 / 헬스 45분)뿐이다 — S1 "크론과의 차이".
  - 시계 앞섬 가드: `last_checked_at` 은 작업기 시계다. 서버 now 보다 2분을 넘게 앞선 값은 그동안 커밋·진척으로 세지 않는다(`WORKER_CHECKED_AT_MAX_AHEAD_MS`) — 먼 미래 값(손 SQL·시계 고장)이 경보를 무기한 가리지 못한다.
    한계: 서버가 받는 5분 안의 앞섬은 경보를 최대 그만큼 늦출 수 있다(S1 상한 줄). 실제 시계 차 크기는 미확인. `last_success_at`(서버 시각)에는 걸지 않는다.
- 효과와 대가(반박 검토의 읽기 전용 14일 실측, 09-15~09-29): 300위 커밋만 셌을 때 45분 이상 공백 12건 가운데 **바뀌는 것은 2건**, 나머지 10건(69.3~658.1분)은 안에 유한 창 커밋이 없어 그대로다.
  - 09-29 훈련 3: 60.7분(50.5 + 10.2) → 경보 15.7분 → 5.5분(의도한 수정).
  - 09-19 15:36:39~17:03:38 대기기 단독 저속 구간: 87.0분(47.0 + 40.0, 그 안에 `group_claimed` 3건·`job_failed` 0건·16:23:38 유한 창 1건) → 경보 42.0분 → 2.0분.
    1.1.33 결정은 이 공백을 "실제 정지"로 분류했었다. 즉 이 변경의 대가는 **대기기 단독·저처리량 구간과 300위 경로만 고장 난 구간에서 경보가 짧아지거나 켜졌다 꺼졌다 하는 것**이다
    (유한 창 커밋만으로 커밋 나이가 45분 미만으로 유지되는 시간은 14일 중 26.1%, 유한 창 커밋 간격 중앙값 166.9분). 대표 승인 범위의 대가로 받아들인다.
    "경보가 더 빨리 풀린다"만 보고하지 않는다 — 09-19 사례(42분 → 2분)를 함께 적는다.
- 코디네이션 행을 못 읽는 경우(`reliable=false`, `ok` 는 어차피 false): 헬스의 커밋 축은 상품 표 하나로 잰다 → `commitStalled:true` 가 될 수 있다(1.1.33 은 `null`·`false`).
  크론은 그대로 `NAVER_RANK_WORKER_SIGNAL_UNKNOWN`(상품 표로 메우지 않는다).
- 맥 워치독 로그 변화(조치는 모두 그대로 — 재기동 없음):
  - 유한 창 커밋만 45분 안에 있던 틱: `commit_stalled action=none` → `healthy stalled_minutes=…`.
  - 코디네이션 판독 불가 + 상품 45분 이상: `health_not_recoverable action=none continuity=reset` → `commit_stalled action=none`(둘 다 연속 관측 리셋).
- 배포: 1.1.34 푸시 커밋 하나에 함께 싣는다(서버 전용 선배포 없음 — D 절 순서). `naver-rank-cron.mjs` 는 잠금 파일이라 병합 뒤 `lock-regen.py` 로 sha 를 다시 만든다.
- 배포 뒤 확인: `npm run verify:live` 4) PASS. 다음 유한 창 커밋(`diagnose.mjs` 의 마지막 커밋이 finite 인 시점) 뒤 60초 안에 `lanes.product.lastCommitAgeMinutes` 가 0~1 로 떨어지는지.
  `diagnose.mjs`·`tally.mjs` 는 이미 두 이벤트를 모두 커밋으로 센다(변경 없음).
- 되돌리기: 서버 커밋 revert + 잠금 sha 복원. DB 되돌리기 없음.
- 범위 밖(그대로): `heartbeatAgeMinutes`(워치독 재기동 가드 재료), 45분 임계값.
