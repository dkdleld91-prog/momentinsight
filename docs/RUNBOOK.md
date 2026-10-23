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
  종료가 안 돼 새 manifest 를 다시 읽지 못한 상태다. 다만 Chrome 재시작이 곧 확장 갱신은 아니다 — 재시작이 서비스 워커를
  다시 등록하지 않을 수 있다(2026-09-29 실측). 등록 버전을 확인하고 다르면 그 프로필의 `chrome://extensions` 에서 ↻ 한다.
  1.1.34 부터는 확장이 디스크 manifest 와 자기 빌드가 다르면 스스로 새로고침한다(아래 `### C 옛 서비스 워커 차단`).
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
  `drift_sync_ok` → `chrome_restarted` 확인(재시작만으로 서비스 워커 갱신은 보장되지 않는다 — 등록 버전 확인,
  `### C 옛 서비스 워커 차단`) → ⑥ Chrome 실행 → 첫 progress 보고 뒤 DB 행의
  `runtime_version`·`runtime_fingerprint`가 새 값으로 채워지는지 본다.
- **맥 대기기는 자동으로 따라온다(2026-09-13)**: 워치독이 10분마다 동기화 원본(맥 체크아웃 `main`)을
  `origin/main`으로 fast-forward 한 뒤(`sync_source_fast_forwarded from=… to=…`) 드리프트 동기화·Chrome
  재기동을 이어서 한다. 수동 `git pull`은 더 이상 필요 없다. Chrome 재기동이 확장 서비스 워커까지 바꾼다는 보장은
  없다(`### C 옛 서비스 워커 차단`). 보류 로그 `sync_source_behind action=none
  reason=diverged|repository_dirty` 또는 `sync_source_pull_skipped reason=not_on_main`이 보이면 체크아웃을
  사람이 정리해야 한다(로컬 커밋·더러운 런타임 파일·다른 브랜치). `sync_source_fetch_failed`는 네트워크/ssh.
  사고 기록: 2026-09-12 14:10(1.1.26 라이브)부터 09-13 13:27까지 체크아웃이 1.1.25에 머물러 대기기가 매분
  신원 불일치(exit 1)였고, 윈도우가 꺼진 00:45~13:20 사이 12.5시간 수집이 멈췄다.
- **버전 이력**: 1.1.34 (2026-09-29 준비·배포일 별도, 마이그레이션 `20260929205303_naver_shopping_runtime_1_1_34_dead_lease_and_live_service_worker.sql`; 죽은 잠금 인계·유한창 경보·실행 중 서비스 워커 버전 확인·자가 새로고침) / 1.1.33 (2026-09-28 준비·배포일 별도, 마이그레이션 `20260928022048_naver_shopping_runtime_1_1_33_collection_window_and_probe.sql`; 수집 창 자동 생성·마지막 창 유지·원문 오류 보존·주작업기 즉시 탐침) / 1.1.32 (2026-09-19 준비·배포일 별도, 마이그레이션 `20260919020000_naver_shopping_runtime_1_1_32_finite_cross_page_repeats.sql`; 교차 페이지 중복이 있는 유한 시장(탄소매트 289행)을 유한 중재로 보내고 두 캡처 유한 다이제스트를 그 중복의 증명으로 인정) / 1.1.31 (2026-09-18 준비·배포일 별도, 마이그레이션 `20260918030000_naver_shopping_runtime_1_1_31_evidence_v2_third_pass.sql`; 실패 증거 v2(유기 행 우선 보존·분기 추적·슬롯 diff·24000자), 안정창 증명 3차 캡처(24페이지 상한), 유한 시장 카운터 1% 허용, 워커 사유 `three_passes` 통과) / 1.1.30 (2026-09-13 준비·배포일 별도, 마이그레이션 `20260913150000_naver_shopping_runtime_1_1_30_finite_drift_evidence.sql` + 증거 테이블
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
- 이 수정이 DB 에 적용되기 전에는 주작업기가 꺼진 상태에서 런타임 인상을 배포하지 않는다. 맥 Chrome 이 재시작되지 않으면(`chrome_quit_incomplete`) 확장이 옛 버전으로 남을 수 있고, 재시작해도 서비스 워커는 옛 것일 수 있다 — 등록 버전을 확인하고 다르면 ↻ 한다(`### C 옛 서비스 워커 차단`).

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

### C 옛 서비스 워커 차단

- 사고(F3): 맥 대기기 `Profile 5` 는 디스크의 확장 파일·manifest 가 1.1.33 인데도 09-19 에 등록된 1.1.32 서비스 워커를
  09-29 15:41 까지 실행했다(09-28 Chrome 재시작 뒤에도. `Secure Preferences` 의
  `extensions.settings.<id>.service_worker_registration_info.version` = `"1.1.32"`). 수동 ↻(`chrome://extensions` 새로고침)로
  1.1.33 이 다시 등록됐다. 서버 지문은 디스크 manifest + 디스크 파일 해시라 이것을 못 잡는다. 윈도우는 09-28 업데이터
  (Chrome 강제 종료·재시작) 뒤 1.1.33 으로 다시 등록됐다(이유 미확인).
- 전제 교정: "Chrome 재시작 = 확장 갱신"이 아니다. 재시작이 서비스 워커를 다시 등록하지 않을 수 있다(늘 그렇다는 뜻은 아니다).
  등록 버전을 확인하고, 다르면 그 프로필의 `chrome://extensions` 에서 ↻. 1.1.34 부터는 확장이 스스로 새로고침한다.
- 1.1.34 동작:
  - 확장: `service-worker.js` 의 `SERVICE_WORKER_BUILD`(bump.py 가 manifest 와 함께 옮긴다)를 신원 `serviceWorkerBuild` 로
    보낸다. 가드는 불러온 manifest(`getManifest().version`)와 디스크 manifest(`fetch(chrome.runtime.getURL('manifest.json'),
    {cache:'no-store'})`)를 BUILD 와 비교해 하나라도 다르면 `chrome.runtime.reload()` 한다. 도는 때: 시작·onInstalled·
    onStartup(초기화), 모든 알람과 팝업 실행의 작업 요청 전(`requestWorkerRun`), 대기 이어받기를 포함한 모든 런의 네이티브
    연결 전(`runWorker`), 호스트가 `service_worker_stale` 로 답했을 때(포트를 닫은 뒤). 같은 목표 버전(디스크 manifest,
    못 읽으면 불러온 manifest)당 30분에 1회(`chrome.storage.local` 의 `momentInsightServiceWorkerReload`), 네이티브 연결이
    열려 있으면 하지 않고, 시도를 먼저 기록하지 못하면 하지 않는다. 연결 여부는 `chrome.runtime.reload()` 바로 앞에서 한 번
    더 본다 — 자기 가드를 디스크가 바뀌기 전에 통과한 런이 기록·상태 저장을 기다리는 사이 연결을 열 수 있어서다(끊으면 F1 처럼
    임대가 남는다). 그때는 새로고침하지 않고 시도 기록을 되돌려, 그 런이 끝난 뒤의 가드가 30분을 기다리지 않게 한다. 런은
    `connectNative` 직전에 연결 표시를 켜고 포트를 닫은 뒤에 끈다. 그 밖에는 상태 `stale`(팝업 "확장 프로그램을 새로
    불러오는 중…"). 디스크를 보므로 Chrome 이 재시작되지 않은 경우(`chrome_quit_incomplete`)에도 발동한다. 둘 다 못 읽으면
    낡음으로 보지 않는다(호스트가 막는다).
  - 네이티브 호스트: `serviceWorkerBuild` 가 없거나(1.1.33 이하) 이 런의 `runtimeVersion` 과 다르면 `ready` 전, 곧 claim 전에
    거절한다(fail-closed). stderr 한 줄 `native_host_service_worker_stale build=<빌드|none> expected=<버전>`, 확장에
    `{type:"service_worker_stale"}`, 종료 코드 1. 서버 요청 0건이라 임대·`job_failed`·대기기 벤치 연속 실패가 없다. 확장은
    이것을 수집 실패(`failed`)가 아닌 `stale` 로 남긴다. 호스트 사본과 확장 버전의 일치는 예전대로 로컬 워커가 claim 전에
    확인한다(`local_worker_runtime_identity_invalid`). 지문 계산식은 그대로다(워커 파일 해시가 BUILD 를 이미 덮는다).
  - 윈도우 업데이터: 작업 복구(Chrome 재시작) 뒤 `Secure Preferences` 를 문자열 정규식으로 최대 180초, 5초 간격 확인한다
    (PS 5.1 `ConvertFrom-Json` 은 이 파일을 못 읽는다. 09-29 윈도우에서 실측한 확인 한 줄과 같은 방식). 등록 버전 =
    `-ExpectedVersion` 일 때만 `MI_EXTENSION_UPDATE_OK … extension_sw_registered_version=<버전>`. 다르면
    `MI_EXTENSION_SW_STALE … extension_sw_registered_version=<버전|none>` + ↻ 안내를 내고 종료 코드 1(파일 교체·작업 복구는
    이미 끝난 상태다). ↻ 뒤에는 읽기 전용 확인 한 줄로 다시 본다. 업데이트 전에 예약 작업이 꺼져 있었으면 업데이터는 작업을
    꺼진 채 두므로 Chrome 이 다시 켜지지 않는다 → 기다리지 않고(등록 버전이 이미 같으면 OK) `MI_EXTENSION_SW_UNVERIFIED
    reason=scheduled_task_disabled … extension_sw_registered_version=<버전|none>` + "작업을 켜고 시작한 뒤 확인 한 줄" 안내,
    종료 코드 1. 이때는 ↻ 가 아니라 Chrome 을 다시 켜는 것이 먼저다.
  - 맥 워치독: 수집 프로필 `Secure Preferences` 의 등록 버전을 디스크 manifest 와 비교해 로그만 남긴다 —
    `extension_sw_stale registered=<등록> expected=<디스크> profile=Profile_5`(매 틱), `extension_sw_current version=<버전>
    profile=Profile_5`(값이 바뀔 때 1회), 판독 실패 `extension_sw_check_failed reason=…`(node 판독 5초 상한, 넘으면
    `reason=probe_timeout`). 드리프트 재기동 틱에는 돌지 않는다. **launchd 가 실행하는 워치독은 설치 사본이고 드리프트
    동기화 대상이 아니라서, 이 패스는 워치독 재설치(`npm run install:rank-watchdog`, 대표 승인 별도 단계) 뒤부터 돈다.**
    그 전 맥 확인은 `Secure Preferences` 를 직접 읽는 확인 한 줄(D 절)로 한다.
- 실기 검증(2026-09-29, Chrome for Testing 149.0.7827.55, 임시 프로필·키를 뺀 확장이라 운영 네이티브 호스트와 무관):
  ① Chrome 이 떠 있는 채 디스크 파일만 1.1.34→1.1.35 로 바뀜 → 옛 워커의 `requestWorkerRun` 이
  `extension_service_worker_stale` 로 답하고 스스로 새로고침 → 새 워커 BUILD·manifest 1.1.35, 상태 `ready`, 등록 버전 1.1.35.
  ② 고칠 수 없는 불일치(manifest 1.1.36, BUILD 1.1.35)로 시작 → 새로고침 1회 뒤 `stale`(30분 제한), 반복 없음.
- 관측성 한계: 윈도우 주작업기의 거절은 서버에도 윈도우 로그에도 남지 않는다(런처 `RedirectStandardError = false`, 서버
  요청 0건). 겉으로는 주작업기 무신호와 같다 → 45분 커밋 경보·업데이터 출력·확인 한 줄·팝업 문구로 본다
  (`docs/skills/mi-collection-incident/SKILL.md` 판정표). 맥은 네이티브 호스트 로그에 거절 줄이 남는다.
- 1.1.33 → 1.1.34 에는 한 번 손이 필요할 수 있다: 1.1.33 서비스 워커에는 자기 새로고침이 없고 1.1.34 호스트는 그것을
  거절한다. 순서는 D 절(맥 ↻ 는 `drift_sync_ok` 뒤, 윈도우는 업데이터가 확인). ↻ 전에 그 프로필 `chrome://extensions` 의
  개발자 모드가 켜져 있는지 본다(꺼진 프로필에서는 새로고침 뒤 압축 해제 확장이 꺼질 수 있다 — Chrome for Testing 149 실측).
- 위험·한계: `SERVICE_WORKER_BUILD` 인상을 빠뜨리면 모든 기기가 30분마다 새로고침만 하고 수집하지 않는다(새 테스트와
  baseline 핀 `shoppingStaleServiceWorkerIsRefusedAndReloaded` 가 푸시 전에 막는다). 파일이 반쯤 바뀐 순간의 새로고침은 같은
  목표 버전 30분 제한 때문에 다음 시도가 최대 30분 늦어질 수 있다(↻ 로 즉시 해결). 브랜드 Chrome 에서
  `chrome.runtime.reload()` 가 ↻ 와 똑같이 다시 등록하는지는 미확인이다 — 1.1.35 배포 때 첫 실측.
- 되돌리기: 코드만 1.1.33 으로 되돌리면 가드가 `!==` 비교라 확장이 스스로 1.1.33 을 다시 불러온다. 런타임 SQL 적용 뒤에는
  역방향 정체 마이그레이션이 필요하고 그 도구는 없다 — 앞으로 고치는 것이 기본이다.

### D 배포·훈련 도구

- **배포 순서(1.1.34 확정 — 4)의 죽은 잠금 예외 하나 말고는 바꾸지 않는다)**:
  0. 사전: 두 기계의 등록 서비스 워커(SW) 버전을 본다. 윈도우는 1.1.34 판 `bash docs/skills/mi-runtime-release/scripts/windows-oneliner.sh <sha40> <버전>`(이 줄이 없는 옛 판이면 도구부터 갱신) 출력 가운데 **등록 SW 확인 한 줄만** 쓴다(일반 PowerShell, 읽기 전용, Secure Preferences 정규식 → `SW_VERSION=… DISK_VERSION=… PROFILE=… VERDICT=OK|STALE`). 같은 출력의 첫 줄(업데이터 `mi-update.ps1`)은 4) 전용이다 — 0) 에서 돌리면 크롬을 끄고 파일을 바꾼다. 맥은 `bash scripts/mac-naver-shopping-extension.sh check`(읽기 전용, 같은 형식)인데, 푸시 전에는 맥 원본 체크아웃에 이 스크립트가 없으므로 배포 준비 워크트리(이 커밋이 있는 곳)에서 돌린다(체크아웃 위치와 무관하게 `~/Library/Application Support` 의 설정·수집 프로필만 읽는다).
  1. 대표 SQL-A(`20260929120000`, 죽은 잠금 인계, 런타임 무관) → 확인 SQL(verify-applied) 전부 true.
  2. 푸시 1회(코드 + bump 1.1.34). 연속 푸시는 하지 않는다.
  3. 맥: 워치독이 10분 안에 원본 폴더를 fast-forward 한다(`sync_source_fast_forwarded` → `drift_sync_ok`). 다른 세션의 미커밋 문서로 막히면(`sync_source_fast_forward_failed`·`repository_dirty`) 대표 승인 뒤 겹치는 파일만 stash → ff 하고, pop 전에 겹침을 다시 검사한다 — 겹치면 pop 하지 않고 stash 를 보관한 채 보고한다. 이어서 `bash scripts/mac-naver-shopping-extension.sh open` → 대표가 그 창의 Moment Insight 카드 새로고침(↻) → `bash scripts/mac-naver-shopping-extension.sh check` 가 `SW_VERSION=1.1.34 DISK_VERSION=1.1.34 … VERDICT=OK`.
     - `open` 은 **새 창 하나만** 연다: 실행 전후 Chrome 창 id 를 비교해 새로 생긴 창이 정확히 하나이고, 그 탭이 스크립트가 연 `about:blank` 이며 최소화되지 않았을 때만 **그 id 의 창만** `chrome://extensions/?id=pflggephankeefaeoaafkmggampnaefm` 로 옮긴다. 대표의 다른 창·탭 주소는 바꾸지 않는다(09-29 에는 front window 의 활성 탭 주소를 바꿨다). 식별이 안 되면(`NO_NEW_WINDOW`·`AMBIGUOUS_NEW_WINDOWS`·`NOT_OUR_WINDOW`·`WINDOW_LIST_FAILED`) 아무 창도 옮기지 않으므로 대표에게 수집 프로필 창에서 주소 입력을 요청한다.
     - 등록 SW 가 이미 디스크와 같으면(`ALREADY_CURRENT`) 열지 않는다. 등록 SW·확장 경로·디스크 manifest 를 못 읽으면(`VERDICT=UNKNOWN` → `SW_UNKNOWN`, exit 7) 새로고침이 무해한지 몰라 열지 않는다 — 대표에게 카드의 버전·오류 확인을 요청한다. 네이티브 호스트가 도는 중(`HOST_RUNNING`, 수집 중일 수 있음)이면 열지 않는다(1분 뒤 다시). Chrome 이 꺼져 있으면 켜지 않는다(`CHROME_NOT_RUNNING`).
  4. `/health` release LIVE 확인 → 대표 SQL-런타임(1.1.34, 유휴 관문 — `requires_idle_control_plane` 이면 2~3분 뒤 재시도. **예외**: 계속 거절되고 코디네이션 잠금 열(`lease_worker_id`·`lease_token`·`lease_until`·`run_id` 등)이 남아 있으면 배포 창에 보유자가 죽은 것이다 — 1.1.33 작업기의 claim 은 HTTP 관문에서, 1.1.34 대기기는 `runtime_identity_invalid` 로 막혀 재시도·기다리기로는 열이 비지 않는다(살아 있는 1.1.33 작업기는 관문 밖 release-lane 으로 스스로 푼다). 그때는 증상 ⑦ 「안 되면 다음」대로 아래 윈도우 PS 를 먼저 실행해 새 주작업기를 띄운 뒤 SQL 을 재시도한다) → 윈도우 관리자 PowerShell 한 줄(업데이터가 크롬 재시작 뒤 등록 SW 까지 확인한다. `MI_EXTENSION_SW_STALE` 이면 대표가 윈도우 수집 프로필 chrome://extensions 에서 ↻ → 등록 SW 확인 한 줄 `VERDICT=OK`).
  5. 확인: 두 기계의 첫 1.1.34 런, 헬스 ok, 등록 SW 둘 다 1.1.34 → 아래 정상화 기준 N1~N10.
  - 워치독 재설치(`npm run install:rank-watchdog`, launchd 조작)는 **별도 대표 승인 단계**다. launchd 는 Application Support 사본을 실행하므로 fast-forward 만으로는 새 워치독(`extension_sw_current`/`extension_sw_stale` 로그)이 돌지 않는다. 재설치는 `pgrep -f mi-rank-watchdog.sh` 가 비어 있을 때(설치기의 `kickstart -k` 가 도는 틱을 죽인다), 반드시 맥 원본 체크아웃에서 한다(다른 워크트리에서 돌리면 동기화 원본 경로가 그 워크트리로 바뀐다).
  - 크롬 재시작은 확장 SW 재등록을 보장하지 않는다(맥 09-29 실측: 재시작 뒤에도 09-19 등록 1.1.32 SW 실행. 윈도우는 09-28 업데이터 뒤 재등록됨 — 이유 미확인). 워치독 `chrome_restarted` 는 SW 판정 근거가 아니다 → 판정은 등록 SW 확인으로만 한다.
- **훈련 도구(윈도우 주작업기 정지)**: `node docs/skills/mi-collection-incident/scripts/windows-drill.mjs [정지초=900] [중심초=25] [반폭=7] [catch-up 분 끝자리=4, 끄기=-1]` → 관리자 PowerShell(5.1) 한 줄 + 복구 전용 한 줄(`… windows-drill.mjs restore` 로 따로도 나온다). 모든 줄은 출력 전에 PS 5.1 구조 검사(한 줄·괄호 짝·`-and`/`-or` 혼용·PS7 전용 연산자)를 통과해야 하고, 다른 한 줄도 `… windows-drill.mjs check <파일>` 로 검사한다. 테스트: `scripts/mi-collection-incident-windows-drill.test.mjs`.
  - 멈추는 조건(모두 참일 때만): 호스트 프로세스(`MomentInsightNaverShoppingHost.exe`, `naver-shopping-native-host.mjs` 를 돌리는 `node.exe`)가 **12초 연속** 없음(확장은 수집 중 미뤄 둔 알람을 앞 런 종료 6초 뒤 연다 — `PENDING_TRIGGER_HANDOFF_MS`. 5초 기준으로는 그 연결 직전에 끌 수 있어 12초로 둔다) · 초가 [18,32] 밖(rank-remote 매분 :24~:27, 60 경계를 넘는 원형 거리) · 08:58~09:02·14:58~15:02 밖(rank-0900/1500 은 hh:00:01) · catch-up 분(그 분 전체 + 앞 분 50초~) 밖 · 크롬 본체 시작 120초 뒤 · 마지막으로 새로 잰 호스트 수 0(조회 실패 = 바쁨).
  - 순서: 관리자 확인 → 예약 작업 끄기(`Disable-ScheduledTask`, 실패하면 아무것도 끄지 않음) → 한가함 대기(최대 45분, 못 찾으면 `DRILL_ABORTED_BUSY` — 끄지 않고 되살리기만) → 크롬 → 남은 호스트 → `Stop-ScheduledTask` → `DRILL_STOPPED idle=…s` → 3초 뒤 `DRILL_LEFT 0` → 정지초 → finally 에서 `Enable-ScheduledTask` → `Start-ScheduledTask` → `DRILL_RESTORED`. 대기·정지 중 Ctrl+C 뒤에도 finally 가 되살리도록 짰지만 PS 5.1 실기에서는 확인하지 않았다(DRY 는 Enable/Disable/Start/Stop 을 돌리지 않는다) → Ctrl+C 뒤 `DRILL_RESTORED` 가 안 보이면, 또 창을 닫아 finally 가 못 돌았으면 함께 찍히는 복구 한 줄을 쓴다(여러 번 실행해도 안전). 창을 클릭(빠른 편집)하면 스크립트가 멈추니 Esc.
  - `DRY=1`: 아무것도 끄지 않는다. `DRILL_DRYRUN_WOULD_STOP … chrome=<n> host=0` 뒤 finally 가 복구 경로 `DRILL_DRYRUN_WOULD_RESTORE task=Ready restore=Enable-ScheduledTask,Start-ScheduledTask` 를 찍고, 생성기 출력에도 복구 한 줄이 붙는다. 여기에는 PowerShell 이 없으므로 DRY 실행이 PS 5.1 문법·CIM·관리자 판정·작업 이름을 실기에서 확인하는 첫 단계다.
  - 기본 900초 근거: 대기기 인계 180초(`p_primary_stale_seconds`) + 맥 catch-up 한 주기(기본 10분·후보 6분 중 긴 쪽) 600초 + 한 런 여유 120초. 맥 대기기의 1분 `rank-remote` 는 wake 가 있어야 수집하므로 인계 뒤 실제 수집은 다음 catch-up 이다.
  - 위상 측정(읽기 전용): `node docs/skills/mi-collection-incident/scripts/windows-drill.mjs phase [시간=2]` → rank-remote 초·catch-up 분 끝자리 최빈값으로 인자 한 줄. catch-up 주기가 10분이 아니거나(후보 6분) 표본 3개 미만·최빈 60% 미만이면 `PHASE_UNSTABLE` 로 exit 3 → 훈련을 미룬다. 위상은 확장이 갱신·새로고침되면 바뀐다(1.1.32→1.1.33 때 catch-up 분 끝자리 0→4) → 매 훈련 직전에 잰다.
  - 남은 경합: 마지막 한가함 확인과 크롬 종료 사이(1초 이내)에 제외 목록 밖 알람(절전 해제 직후 밀린 알람 등)이 claim 하면 임대가 남을 수 있다. 그때는 A 의 죽은 잠금 인계가 풀어 준다(보유자 쓰기 없음 6분 + navigating 뒤 16분).
- **정상화 기준(배포 뒤)**:

  | 기준 | 무엇을 보나 | 합격 |
  |---|---|---|
  | N1 배포 | `/health` release, Quality Gate, `npm run verify:live` | release 가 푸시 sha7 로 시작, Quality Gate 성공, verify:live 통과 |
  | N2 DB | SQL-A 확인 SQL, 코디네이션 행 | 확인 SQL 전부 true. 런타임 SQL 직후 `runtime_version` null → 첫 런 뒤 1.1.34·새 지문. `circuit_state=closed`, cooldown·bench 없음 |
  | N3 윈도우 | 업데이터 출력, 런 | `MI_EXTENSION_UPDATE_OK … version=1.1.34 … runtime_fingerprint=<새 지문>` 과 등록 SW 1.1.34(`extension_sw_registered_version=1.1.34` 또는 등록 SW 확인 한 줄 `VERDICT=OK`). PS 뒤 10분 안 1.1.34 런, 20분 안 첫 커밋 |
  | N4 맥 | 원본 HEAD, 워치독 로그, `check`, 네이티브 호스트 로그 | HEAD = 푸시 sha, `drift_sync_ok`, `check` 가 `SW_VERSION=1.1.34 … VERDICT=OK`. LIVE+SQL 뒤 호스트 로그 매분 `exit status=0`(`status=1`·`native_host_service_worker_stale` 없음) |
  | N5 헬스 | `/api/rank-collection-health` | `ok:true`, `workerOutdated:false`, `lanes.product.commitStalled:false`, `heartbeatAgeMinutes` ≤ 1 |
  | N6 임대 | 코디네이션 행 여러 번 | 런 사이마다 `lease_worker_id` null 이 관측된다(죽은 임대 없음) |
  | N7 경보 | 헬스 `lanes.product.lastCommitAgeMinutes` | LIVE 뒤 첫 `finite_window_committed` 직후 0~1 로 돌아온다(유한창 커밋도 커밋으로 센다) |
  | N8 훈련 DRY | `DRY=1` 한 줄(대표 관리자 PowerShell) | `DRILL_WAITING` → `DRILL_DRYRUN_WOULD_STOP … host=0` → `DRILL_DRYRUN_WOULD_RESTORE task=Ready`, 빨간 오류 없음 |
  | N9 훈련 실제 | 한 줄 + 15초 간격 읽기 전용 감시 | `DRILL_STOPPED idle=12s 이상`, `DRILL_LEFT 0`. 60초 안 코디네이션 임대가 윈도우 것이 아님. STOPPED + 3분 뒤부터 맥 claim granted(idle 포함), 맥 catch-up 한 주기(약 14분) 안 커밋(할 일이 있을 때) 또는 `errorDetail` 증거 행. `DRILL_RESTORED` 뒤 2분 안 윈도우 `primary_seen_at` 신선·커밋 재개. 커밋 공백 45분 미만(경보 없음) |
  | N10 24시간 | 집계(tally), 코디네이션, 맥 원본 | 실패율 2% 이하(1.1.33: 1.6%), 최대 커밋 공백 45분 미만, 1.1.34 발 신규 실패 코드 0, SW 자가 새로고침 기계당 1회 이하, 죽은 임대 사건 0, 맥 원본의 다른 세션 미커밋 문서 그대로 |

## C 30일 순위(쿠팡) (2026-10-16, 명세 v3)

- 무엇: 로그인 없는 쿠팡 검색 1쪽에서 광고(`sourceType=srp_product_ads`)를 뺀 일반 순번 1~50을 계정 × 키워드 × 상품으로 KST 하루 칸에 기록한다. 51번째 이후·1쪽에 없음은 '밖'.
- 독립 모듈: N30 코드·`naver_*` 표·크론·`/ready`·만료 크론·해지 모듈과 닿지 않는다(통합 계약 5줄: `docs/DECISIONS.md` 2026-10-16). C 장애는 N30 경보·헬스에 나타나지 않는다 — 이 절의 띠·패널로 본다.
- 화면: 관리자 메뉴 `C 30일 순위`(`#mi-admin-coupang-rank-tracking`). 총관리자에게만 수집기 패널(접힌 칸, `[data-coupang-rank-owner]`)이 보인다. API: 화면 `/api/coupang-rank-trackers`(세션), 수집기 `/api/coupang-rank-worker`(연결 코드 Bearer).
- 대표용 설치 순서·기대 출력: `docs/COUPANG_RANK_COLLECTOR_SETUP.md`. 대표 SQL 원문: `supabase/migrations/20261017090000_coupang_rank_tracking.sql` = `docs/sql/c30-1-tables.sql`(바이트 같음, sha256 `362b0fb5d111d5f339e5bc66be33d6760a0081647e49a95f34356458bf23a67c`). 바탕화면 준비: `bash ~/.claude/skills/mi-operator-feature/scripts/stage-sql.sh supabase/migrations/20261017090000_coupang_rank_tracking.sql C30-1-테이블만들기.txt`.

### 켜기·끄기

- **켜기 조건**(G8, 하나라도 아니면 보류하고 대표와 다시 논의)
  1. 맥 시험 결과(`~/.local/share/momentinsight-coupang-trial/results/*.jsonl`)에서 2026-10-16 05:30Z 뒤 `httpStatus ∈ {403,429,503}` 또는 `status=blocked` 0회
  2. 윈도우 0단계 시험(G7) `blocked=0`
  3. 무료 한도(G6): DB 400MB 미만, 이번 달 egress 한도의 80% 미만
- **켜기 순서**: 대표가 `checksPerDay`·시작 `maxRunsPerHour`(권장 6, [결정 필요])를 패널에 저장(내리기는 즉시) → 맥 시험 에이전트 내림 `launchctl bootout gui/$(id -u)/com.momentinsight.coupang-trial`(맥 터미널) → 새 연결 코드 → 설치 줄 → `MI_COUPANG_INSTALL_OK … auth=ok` → 대표 계정에 추적기 3~5개 → `수집 켜기`.
- **첫 2시간 기준**: 회차 ≥ 1, 차단 0, 시간당 회차 ≤ 설정값, 카드 오늘 칸 기록. **48~72시간(G9)**: `stats` 의 blocked48h = 0·empty48h = 0·성공률 ≥ 90%·남은 프로필 0, 수집기 로그 오류 코드 분포·`throttled` 빈도, N30 실패율(켜기 전 3일 대 뒤 3일, `~/.claude/skills/mi-runtime-release/scripts/tally.mjs`)이 기준선 1.5%보다 나빠지면 **끄고** 원인 확인.
- **끄기**: 패널 `수집 끄기` → 다음 claim 부터 `disabled`(즉시). 이미 받은 회차의 결과는 들어올 수 있다(record 는 늘 받음).
- **완전히 멈추기**: `수집 끄기` → 수집기 PC에서 제거 줄 → 패널에서 연결 코드 `폐기`(그 코드의 다음 요청부터 401).
- **속도 올리기**는 서버가 막는다: `confirmRaise` + 48시간 차단 0·빈 쪽 0·성공 ≥ 48 + 마지막 상향 뒤 48시간 + 사다리 한 칸(12→24→40→60, 사다리 밖 값은 바로 위 칸: 6→12). 어긋나면 409 `COUPANG_RAISE_NOT_ALLOWED`(`reasons`: `blocked_or_empty_48h`·`too_few_success_48h`·`quiet_window_short`·`ladder_step`). **내리기**는 언제든 즉시.

### 상태 띠별 조치(위에서부터 처음 맞는 것)

| state | 띠 문구 | 조치 |
|---|---|---|
| `setup_required` | 대표 SQL 실행 전입니다(설정 필요) | 대표 SQL(위) → 점검 SQL 결과 9·18·false·offscreen·100 |
| `not_connected` | 수집기 연결 안 됨 | 폐기 안 된 코드 0개 → 코드 발급·설치 |
| `disabled` | 수집 꺼짐 | 의도한 것이면 그대로. 켜려면 켜기 조건 확인 뒤 `수집 켜기` |
| `review` | 대표 확인 필요 — 차단이 7일 안 3번 감지됐습니다 | **대표 판단**. 원인(아래 '쉬는 중 해제 판단') 확인 전에는 해제하지 않는다. 해제 전에 대표와 원인·속도를 다시 논의한다(속도 내리기는 즉시 된다) |
| `budget` | 저장 용량 상한으로 멈춤 — 대표 확인 필요 | `budgetReason` = `storage`(C 저장 용량 > `maxStorageMb`) 또는 `database`(DB 크기 > `dbSizeStopMb`). Supabase 대시보드 DB 크기 확인 → 추적기 정리 또는 대표가 상한 조정 → `쉬는 중 해제` |
| `cooldown` | 쉬는 중 ~MM-DD HH:MM(쿠팡 차단 또는 연속 오류 감지) | 기본은 **기다림**(자동 재개). 해제는 아래 판단표 |
| `outdated` | 수집기 업데이트 필요 | 모든 활성 수집기가 `minCollectorVersion` 미만 → 패널 복사 줄(설치·업데이트)을 다시 실행 |
| `offline` | 수집기 응답 없음(30분 넘음) — 수집기 PC가 켜져 있는지 확인하세요 | 수집기 PC 켜짐·**그 사용자 로그인**(예약 작업은 대화형·Limited, 로그온 안 하면 돌지 않음·PC를 깨우지 않음) → 확인 줄로 `LastRunTime`·로그 `run_end` → 로그의 오류 코드(아래)로 원인 |
| `delayed` | 지연 — 예정 시각이 지난 키워드가 있습니다 | 패널 용량 줄이 `over` 면 '용량 맞추기'. 아니면 claim 사유(`gap`·`hourly_cap`·`daily_cap`)와 수집기 로그 확인 |
| `idle_hours` | 수집 시간이 아닙니다(08~23시) | 정상 |
| `ok` | 정상 · 마지막 수집 HH:MM · 하루 n회(08~23시) | 없음 |

### 쉬는 중 해제 판단(`쉬는 중 해제` 버튼)

- 원칙: **원인을 모르면 해제하지 않는다.** 자동 우회(프록시·UA 변경·로그인·캡차·재시도 폭주)는 없다. 해제해도 **7일 차단급 횟수는 지워지지 않아** 다음 차단은 곧바로 높은 단계(6시간 → 12시간 → 24시간 + 대표 확인)가 된다.
- 근거: 패널의 사유·7일 차단급 횟수·최근 쉬기 10건, `?view=runs` 의 실패 회차(`status`·`errorCode`).

| 사유(`cooldownReason`) | 뜻 | 판단 |
|---|---|---|
| `blocked` | 403·429·503·차단 문구·로그인 이동(차단 판정 1~3순위) | **해제하지 않고 기다린다.** 반복되면 끄고 대표와 다시 논의한다 |
| `empty` / `empty_escalated` | 일반 상품 0개가 2연속(약한 차단 의심) / 24시간 안 두 번째 | 기다린다. `empty_escalated` 는 차단급 |
| `error_streak` | 오류·시간 초과·임대 만료 3연속(30분) | 수집기 PC 문제일 수 있다. 로그 코드(`page_timeout`·`cdp_*`·`devtools_port_timeout`·`browser_launch_failed`·`browser_exit_early`·`browser_hard_cap`·`extract_failed`)로 원인을 고친 뒤에만 해제. 실패 회차에 `httpStatus` 403·429·503 이 섞였으면 해제 금지 |
| `error_escalated` | 24시간 안 두 번째 오류 쉬기(차단급) | 위와 같고, 차단급이라 기다리는 쪽이 기본 |

- `foreign_navigation`(쿠팡이 아닌 사이트로 감, 사람이 창을 건드린 경우 등)은 차단이 아니라 오류로 센다. `unsupported`(검색 결과가 아닌 쪽으로 보냄)는 그 키워드만 다음 날로 미루고 전역 쉬기를 걸지 않는다.

### 설치·확인·제거 줄

- **패널의 복사 버튼 6개를 쓴다**(윈도우 설치·업데이트 / 확인 / 제거, 맥 설치·업데이트 / 확인 / 제거). `-Release`·`--release` 에 지금 배포의 커밋 7자가 들어가고, 묶음 `release` 와 다르면 설치기가 `release_mismatch` 로 멈춘다. 아래는 모양만(`<release7>` 자리).
- 윈도우(관리자 Windows PowerShell 5.1, 설치·업데이트·0단계 시험·제거 모두 같은 줄 + 매개변수 `-TrialOnly`·`-ResetToken`·`-Uninstall`)
  ```powershell
  iwr -UseBasicParsing https://insight.momentlabs.co.kr/coupang-collector/install-windows.ps1 -OutFile "$env:TEMP\mi-coupang-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\mi-coupang-install.ps1" -Release <release7>
  Get-ScheduledTaskInfo -TaskName CoupangRank -TaskPath '\MomentInsight\' | Select-Object LastRunTime,LastTaskResult,NextRunTime; Get-Content "$env:LOCALAPPDATA\MomentInsight\CoupangRank\logs\worker.log" -Tail 10 -Encoding UTF8
  ```
  기대: 설치 `MI_COUPANG_INSTALL_OK release=… version=1.0.0 node=… browser=edge/… task=Ready auth=ok first_run=…`, 시험 `MI_COUPANG_TRIAL …`, 제거 `MI_COUPANG_UNINSTALL_OK`, 실패 `MI_COUPANG_INSTALL_FAIL code=…`.
- 맥(터미널, 관리자 아님, 매개변수 `--trial-only`·`--reset-token`·`--browser-app <path>`·`--uninstall`)
  ```bash
  curl -fsSL https://insight.momentlabs.co.kr/coupang-collector/install-macos.sh -o /tmp/mi-coupang-install.sh && /bin/zsh /tmp/mi-coupang-install.sh --release <release7>
  launchctl print gui/$(id -u)/co.kr.momentinsight.coupang-rank-collector | grep -E 'state|last exit code'; tail -n 10 "$HOME/Library/Application Support/MomentInsight/CoupangRank/logs/worker.log"
  ```
  기대: `MI_COUPANG_INSTALL_OK … browser=edge|chrome/… guard=none|n30-chrome agent=loaded auth=ok first_run=…`. 맥 시험 에이전트가 떠 있으면 `trial_agent_loaded` 로 멈춘다.
- 예약 작업 `\MomentInsight\CoupangRank`(10분마다, 로그온 시 2분 지연, BelowNormal), launchd `co.kr.momentinsight.coupang-rank-collector`(600초). 제거 뒤에는 **연결 코드도 폐기**한다.
- `--hello-only`·설치 확인의 `auth=` 값: `ok` / `rejected`(코드 틀림·폐기 → 새 코드 + 윈도우 `-ResetToken` / 맥 `--reset-token`) / `update_required`(줄 다시 실행) / `setup_required`(대표 SQL 전) / `route_missing`(경로가 없음 — 다른 배포가 덮었는지 `/health` release 대조, 증상 ②).

### 맥 미니 이전(약 2달 뒤)

1. 맥 미니에 Node 22 LTS와 **Microsoft Edge for Mac(필수, 무료)** 설치.
2. 패널에서 새 연결 코드(이름 "맥 미니"). 윈도우 코드는 그대로 둔다(새 코드는 옛 코드를 폐기하지 않는다, 활성 최대 3개).
3. 맥 미니 터미널에 맥 설치 줄 → `browser=edge guard=none auth=ok` 확인. **아니면 진행하지 않는다**(G11).
4. 하루 동안 두 대를 같이 돌린다. 속도 상한은 서버 전역(설정 행 잠금)이라 요청량은 늘지 않는다. 패널에서 두 수집기의 마지막 신호·claim 사유를 보고, 두 대 합계 시간당 회차가 상한 이하인지 확인.
5. 윈도우 코드 폐기 → 윈도우에서 제거 줄.
6. N30 도 맥 미니로 옮겨 Chrome 을 쓰게 되어도 C 는 Edge 라 서로 닿지 않는다.

### 점검 SQL(Supabase SQL 편집기용, 대표 SQL 실행 뒤)

```sql
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name like 'coupang\_rank\_%') as tables,        -- 9 (지금 확인 SQL 뒤 10)
  (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'coupang\_rank\_%') as functions,          -- 18 (지금 확인 SQL 뒤 23)
  (select enabled from public.coupang_rank_settings where id = 1) as enabled,             -- false
  (select window_mode from public.coupang_rank_settings where id = 1) as window_mode,     -- offscreen
  (select keyword_limit from public.coupang_rank_account_limits where agency_code = 'mml93-a01') as owner_limit; -- 100
```

### 일별 칸 재생성(백업 복원 때, Supabase SQL 편집기용)

`coupang_rank_days` 는 백업하지 않는다. 스냅숏(`coupang_rank_snapshots`)을 되살린 뒤 아래로 다시 만든다. 실패 칸 정보(`failure_count`)는 복원되지 않는다(0). PGlite 에서 실행 확인(명세 §4.7 시나리오 17).

```sql
insert into public.coupang_rank_days (
  tracker_id, kst_day, slot_minute, slot_index, result, rank, organic_count, ad_order, checked_at,
  success_count, failure_count, best_rank)
select distinct on (s.tracker_id, s.kst_day, s.slot_minute)
  s.tracker_id, s.kst_day, s.slot_minute, s.slot_index, s.result, s.rank, s.organic_count, s.ad_order, s.checked_at,
  count(*) over w, 0, min(s.rank) over w
from public.coupang_rank_snapshots s
window w as (partition by s.tracker_id, s.kst_day, s.slot_minute)
order by s.tracker_id, s.kst_day, s.slot_minute, s.checked_at desc
on conflict (tracker_id, kst_day, slot_minute) do nothing;
```

### 완전 제거(대표 승인 뒤에만)

1. 관리자 화면 `수집 끄기` → 수집기 PC에서 제거 줄 → 연결 코드 폐기.
2. 코드: C 커밋을 되돌리고 잠금을 재생성한다(명세 §7.4 와 같은 확인 — 실패 목록이 정확히 `shopping-local-worker-router`·`shopping-local-worker-session-boundary` 두 개).
3. SQL(Supabase SQL 편집기용, PGlite 에서 실행·재설치 확인 — `scripts/coupang-rank-manual-migration.test.mjs` 가 이 블록을 그대로 돌린다). 앞 두 줄은 ① 지금 확인 SQL 이 만든 함수 5개·요청 표다(표를 cascade 로 지워도 함수는 남으므로 먼저 지운다, 지금 확인 SQL 전이어도 `if exists` 라 그대로 돈다):

```sql
begin;
drop function if exists
  public.coupang_rank_manual_record(uuid, text, text, text, text, text, jsonb, text), public.coupang_rank_manual_stop(uuid, text, text, text, uuid),
  public.coupang_rank_manual_verify(uuid, text, text), public.coupang_rank_manual_claim(uuid, text, text, text, text),
  public.coupang_rank_manual_summary(uuid);
drop table if exists public.coupang_rank_manual_claims;
drop table if exists
  public.coupang_rank_days, public.coupang_rank_snapshots, public.coupang_rank_runs,
  public.coupang_rank_keywords, public.coupang_rank_trackers, public.coupang_rank_collectors,
  public.coupang_rank_account_limits, public.coupang_rank_cooldowns, public.coupang_rank_settings cascade;
drop function if exists
  public.coupang_rank_stats(), public.coupang_rank_housekeeping(), public.coupang_rank_release(uuid, uuid, text),
  public.coupang_rank_record(uuid, uuid, text, text, jsonb), public.coupang_rank_claim(uuid), public.coupang_rank_replan_all(),
  public.coupang_rank_after_activate(uuid), public.coupang_rank_limit_status(text, text), public.coupang_rank_tracker_limit_guard(),
  public.coupang_rank_reschedule_success(text, uuid, text), public.coupang_rank_reschedule_failure(text, uuid, text),
  public.coupang_rank_note_error(uuid), public.coupang_rank_apply_cooldown(text, uuid), public.coupang_rank_mark_failed(uuid, text),
  public.coupang_rank_apply_success(uuid, uuid, jsonb, jsonb), public.coupang_rank_match(jsonb, jsonb, text, text, boolean),
  public.coupang_rank_plan_next(text, timestamptz, boolean), public.coupang_rank_tracker_is_eligible(uuid, text);
commit;
```

### 수집기 로그 위치

| 무엇 | 윈도우(`%LOCALAPPDATA%\MomentInsight\CoupangRank\`) | 맥(`~/Library/Application Support/MomentInsight/CoupangRank/`) |
|---|---|---|
| 실행 기록 | `logs\worker.log`(한 줄 기록, 1MB 순환) | `logs/worker.log`, launchd 표준 출력 `logs/launchd.log` |
| 0단계 시험 결과 | `trial-results\<KST 날짜>.jsonl`(로컬이라 키워드 포함) | `trial-results/<KST 날짜>.jsonl` |
| 보고 실패 보관함 | `outbox\`(25분 지나면 버림, `RECORD_FINAL_CODES` 응답만 삭제) | `outbox/` |
| 띄운 브라우저 PID | `state\browser.pid` | `state/browser.pid` |
| 임시 프로필 | `runs\mi-coupang-run-<ms>-<hex8>`(끝나면 삭제, 남은 것은 1시간 뒤 청소) | `runs/` |

- `worker.log` 에는 키워드·토큰·제목을 남기지 않는다. 이벤트: `run_start`·`hello`·`claim_wait`(reason·retry·throttled)·`job`·`guard_wait`·`collect`(status·http·items·organic·ads·stable·ms)·`record`(accepted·matched·stop·late·code)·`release`·`outbox_saved`·`outbox_sent`·`record_dropped`·`api_route_missing`·`browser_orphan_killed`·`profile_cleanup_failed`·`run_end`.
- 실행 환경 오류 코드: `config_invalid`·`token_missing`·`node_version_unsupported`(윈도우 래퍼는 `dpapi_unprotect_failed`), 서버 보고: `api_unreachable`·`api_route_missing`·`record_dropped`·`outbox_dropped`, 맥 N30 보호(맥 + Chrome 일 때만): `guard_n30_*`.
- N30 폴더(`NaverShoppingBridge`)·N30 로그는 읽지도 쓰지도 않는다(맥 Chrome 예비 경로의 보호 판정만 N30 로그 두 개를 읽기 전용으로 연다).

### 용량 맞추기

- 패널 용량 줄: "하루 최대 측정 N회 → 하루 n번이면 키워드 약 M개 · 지금 활성 K개".
  - `runsPerDay` = min(`maxRunsPerDay`, `maxRunsPerHour` × (`activeToHour` − `activeFromHour`)), `keywordsAtChecks`(M) = floor(`runsPerDay` ÷ `checksPerDay`), K = 수집 대상인 활성 고유 키워드 수. 기본(12/시·120/일·08~23시·하루 2회) = 120회 → 60개, 시간당 6 = 90회 → 45개.
  - K > M(`over`)이면 경고색 "지연이 생깁니다". 기한이 지난 키워드는 가장 오래 못 잰 것부터 잰다(같은 키워드만 매일 빠지지 않음).
- 버튼 `전체 한도를 M으로 맞추기` → `settings-update { globalKeywordLimit: M }`. 이미 활성인 추적기는 그대로, **새 키워드 등록만** 막힌다.
- 다른 방법: 하루 횟수(`checksPerDay`)를 줄인다(내리기라 즉시, 저장 뒤 `replan_all`). 속도를 올리는 것은 위 상향 규칙을 따른다.
- '대상 아님 n개': 연결 해제 광고주·해지된 팀 코드 범위의 활성 추적기. 수집·한도에서 빠지고, 다시 연결되면 자동 재개, 광고주가 지워지면 FK 로 함께 지워진다.

### 백업(`scripts/db-export.mjs`)

- 백업하는 C 표: `coupang_rank_settings`·`coupang_rank_account_limits`·`coupang_rank_trackers`·`coupang_rank_snapshots`(증분 — id·created_at, insert·보관 기간 delete 만).
- 백업하지 않는 C 표: `coupang_rank_days`(스냅숏으로 재생성, 위 SQL)·`coupang_rank_runs`(14일 임시·증거)·`coupang_rank_keywords`(일정)·`coupang_rank_collectors`(토큰 해시·마지막 claim 답)·`coupang_rank_cooldowns`.
- 대표 SQL 실행 전에는 네 표가 없다 → manifest 에 `skipped: "table_missing"`, 실패가 아니다(종료 코드 0). 로그 끝에 `WARN 선택 표 n개 건너뜀: <이름들> — 대표 SQL 실행 뒤에도 보이면 표가 사라진 것` 한 줄. **SQL 실행 뒤에도 이 줄이 보이면** 표가 사라진 것이니 점검 SQL 부터 돌린다.
- 매일 03:00 백업은 메인 작업 트리(`~/Desktop/개발/모먼트 인사이트 개발`)의 스크립트를 쓴다. 메인 트리가 이 커밋으로 갱신되기 전에는 C 표가 백업에 없다(실패도 없다).
- 복원 순서: 추적기(`coupang_rank_trackers`, `clients` 가 먼저 있어야 함 — FK) → 스냅숏 → 위 '일별 칸 재생성'. 회차·일정·연결 코드는 복원하지 않는다(키워드 일정은 다음 claim 이 다시 만들고, 연결 코드는 새로 발급).
- ① 지금 확인의 요청 표(`coupang_rank_manual_claims`, 토큰 해시 포함)도 백업하지 않는다(명세 R14 — 백업 C 표 4개 고정). 그래서 **복원하면 어느 스냅숏이 수동 확인에서 왔는지 가를 근거가 사라진다**: 수동·자동 구분은 회차(`coupang_rank_runs.source`, 14일·백업 안 함)와 요청 표(`run_id`, 60일·백업 안 함)에만 있고, 스냅숏 `source` 는 자동과 같은 값이다[추정 — SQL 기본값 근거, 실제 복원은 안 해 봄]. 설정 표의 `manual_*` 칸은 `select=*` 라 백업에 들어간다. 구분이 필요해지면(대표·통합 담당 결정) 토큰 해시를 뺀 열만 받는 표별 열 목록을 db-export 에 두고 `db-export.test.mjs` 의 'C 표 4개' 단정을 고친다.

### ① 지금 확인(사람이 누를 때만, 2026-10-23 다시 구현)

- 무엇: 총관리자가 C 30일 카드의 **'지금 확인'**을 누를 때만, 대표 크롬의 전용 확장(`tools/coupang-rank-check-extension/`)이 새 시크릿 창으로 쿠팡 검색 1쪽을 **한 번** 열어 목록을 읽고 닫는다. 결과는 서버가 기존 page-result 규칙으로 판정해 기존 표(runs·snapshots·days·trackers)에 기존 함수(`apply_success`·`mark_failed`)로 저장한다. 예약·알람·자동 반복·전체 한꺼번에 확인은 없다. 자동 수집(`enabled`)은 그대로 꺼져 있고 별도 스위치 `manual_enabled` 로만 켠다.
- 흐름(모든 시간 판정은 서버 시계):
  1. 화면 → `POST /api/coupang-rank-trackers {action:"manual-claim", trackerId}`(총관리자 세션 + CSRF). 서버가 관문을 보고 1회용 요청(60초 안에 확장 확인 필요)과 토큰(`mcm1_…`, 원문은 이 응답에만, DB 에는 sha256)을 준다. **검색은 아직 없다.**
  2. 화면 → 확장 `check {claimId, claimToken, keyword}`.
  3. 확장이 빈 시크릿 창(`about:blank`, 쿠팡 요청 0)을 먼저 열어 정말 시크릿인지·다른 시크릿 창이 없는지 본다. 여기서 멈추면(창을 못 엶·일반 창·다른 시크릿 창) 서버 확인 전이라 **횟수·간격을 쓰지 않는다**.
  4. 확장 → `GET /api/coupang-rank-trackers?view=manual-verify&claimId=<id>` + 머리글 `x-mi-coupang-claim-token: <토큰>`(같은 크롬의 총관리자 세션 쿠키). 서버가 관문을 **다시** 보고 통과하면 이 시각을 **실제 검색 시각**으로 적는다(간격·하루 횟수의 기준). 확장은 `200 · ok:true · verified:true` 일 때만, 응답의 `keyword`(서버가 정한 검색어)로 그 탭에 쿠팡 주소를 넣는다(거절이면 빈 창을 닫는다). 1회용(두 번째는 409 `COUPANG_MANUAL_CLAIM_USED`). 확인 뒤에 멈추면(확인 중 사람이 창을 닫음 `window_closed_early` 등) 검색 0번이어도 횟수에 들고, 화면은 기록 응답의 `counted` 로 '이번 1번은 오늘 횟수에 들어갔고'를 보인다.
  5. 확장이 차단 신호(403·429·503·'사용권한이 없습니다|사용권한이 제한된'·검색 밖으로 보내져 읽지 못함)를 보면 → `GET …?view=manual-stop&claimId=<id>&reason=<사유>` + 같은 머리글(관리자 탭이 닫혀도 그날 중지가 걸리게). 순위는 저장하지 않고 그날 중지만 건다. 실패하면 같은 실행 안에서 3초·10초 뒤에 다시 보내고, 그래도 실패하면 다음 hello(관리자 화면을 열 때)·다음 누름 때 다시 보낸다(그 사이 그 크롬은 `report_pending` 으로 새 검색을 하지 않는다). 차단 신호는 load 확인(1초마다)·불러온 직후 짧은 읽기에서도 남기므로, 사람이 첫 읽기 전에 창을 닫거나 45초·120초 상한에 걸려도 잃지 않는다(권한 밖으로 보내져 읽지 못한 것을 봤으면 `page_unreadable`, D1).
  6. 화면 → `POST {action:"manual-record", claimId, claimToken, outcome, outcomeCode?, page?, durationMs?, extensionVersion?, browser?}`(본문 64KB 까지, 다른 동작은 32KB 그대로). 서버가 판정·저장한다.
- 확장 확인이 GET 인 이유(사실): 세션 게이트는 POST 에 출처(Origin)·CSRF 를 요구한다(`src/server/session-gate.mjs` `mutationOriginAllowed`·`csrfMatches`). 확장 서비스 워커의 출처는 `chrome-extension://…` 이고 운영 허용 목록은 https 출처만 받는다(`src/server/security.mjs` `allowedOrigins`). GET 은 게이트가 출처·CSRF 를 보지 않는다. 토큰은 주소가 아니라 머리글로 보낸다(기록에 남지 않게). 새 Vercel 함수·게이트·라우터 변경은 없다.
- [추정 — 대표 첫 시험에서 확인] 확장 서비스 워커의 `fetch(…, {credentials:"include"})` 에 대표 크롬 일반 프로필의 세션 쿠키(`SameSite=Strict`)가 실린다(호스트 권한이 있는 확장 요청은 같은 사이트로 취급된다고 알고 있음). 실리지 않으면 확인이 401 `SESSION_REQUIRED` 로 거절되고 **창은 열리지 않는다**(안전 쪽 실패). 호스트 권한이 있는 확장 요청은 CORS 사전 요청 없이 응답을 읽는다는 것도 [추정]이다 — 사전 요청이 나가면 라우터의 OPTIONS 204 에 허용 출처가 없어 역시 창이 열리지 않는다.
- 대표 SQL: `supabase/migrations/20261018090000_coupang_rank_manual_check.sql` = `docs/sql/c30-2-manual-check.sql`(바이트 같음, sha256 `7a958e9700c204122d03d81a8b6e7bc639aa90d8f3b676d19aa7047291414577`, begin/commit 1개씩, 다시 실행 안전, 코드 배포 전후 어느 쪽이든 — `manual_enabled` 기본 false). 바탕화면 준비: `bash ~/.claude/skills/mi-operator-feature/scripts/stage-sql.sh supabase/migrations/20261018090000_coupang_rank_manual_check.sql C30-2-지금확인.txt`. 앞선 C 함수 18개는 다시 정의하지 않는다.
- 실행 뒤 확인문(따로 Run):

```sql
select s.manual_enabled, s.manual_min_gap_seconds, s.manual_max_per_day, s.manual_from_hour, s.manual_to_hour,
  (select count(*) from pg_catalog.pg_proc where proname like 'coupang\_rank\_manual\_%') as fns,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'coupang_rank_manual_claims') as claims_table,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'coupang_rank_runs' and column_name in ('source', 'requested_by')) as run_cols
from public.coupang_rank_settings s where s.id = 1;
```

  기대: `false | 180 | 30 | 9 | 19 | 5 | 1 | 2`.

| 안전장치(대표 결정 2026-10-18) | 값 | 강제 위치 |
|---|---|---|
| 검색 사이 최소 간격 | 180초, 모든 사용자·모든 설치 합산. **확장 확인 시각**(실제 검색 직전)부터, 자동 수집의 마지막 임대가 더 늦으면 그것부터 | SQL 설정 행 잠금 + 제약 `between 180 and 3600`, claim·verify 둘 다 |
| 하루 최대 | 30번(KST 하루, 확장 확인을 받은 검색 수. 확인 전에 끝난 요청은 검색이 아니라 세지 않음) | 제약 `between 1 and 30` |
| 시간 | 09~19시(KST, 19:00 직전까지) | 제약 `from between 9 and 18`·`to between 10 and 19`·`from < to` |
| 차단 1번 | 그날(KST, 검색 날짜) 수동 확인 전체 중지 + 화면 알림. 다음 날 자동으로 풀림(D2: 푸는 버튼 없음) | `manual_stopped_day`·`manual_stopped_code` |
| 동시 진행 | 전역 1개(열린 요청 60초·검색 중 150초 동안 다른 요청 거절) | `busy` |
| 꾸민 결과(일부만 거절) | 거절하는 것은 셋뿐이다: 확장 확인이 없는 요청의 측정(409 `COUPANG_MANUAL_CLAIM_NOT_VERIFIED`), 확인 뒤 5초 안의 목록 결과(400 `timing`), 검색어가 요청 키워드와 다른 목록(오류 `query_mismatch`). **총관리자 세션의 같은 출처 스크립트가 claim → verify → 6초 뒤 같은 검색어의 꾸민 목록을 보내면 막지 못한다**(아래 '남은 한계') | SQL record · `manual.mjs` M2 |
| 보이는 사람 | 처음에는 총관리자만 | `MANUAL_ALLOWED_ROLES = ["owner"]` |

- 상태(`manual.state`, 판정 순서)와 조치

| state | 뜻 | 조치 |
|---|---|---|
| `setup_required` | 대표 SQL 전(수동 칸·함수 없음) | 위 대표 SQL → 확인문 |
| `off` | 꺼짐(버튼 숨김) | 총관리자 패널 '지금 확인 켜기' |
| `budget` | 저장 용량 상한(자동과 같은 신호) | 위 '상태 띠별 조치' `budget` |
| `stopped` | 오늘 차단 신호가 있어 멈춤. `stoppedCode` = `blocked_http_403/429/503`(쿠팡 응답)·`blocked_text`(차단 문구)·`blocked_page`(확장이 차단으로 본 쪽)·`login_redirect`(로그인 화면으로 보냄)·`page_unreadable`(검색 밖으로 보내 읽지 못함, D1)·`extension_reported`(확장이 오늘 차단을 봤다고 알림) | **기다린다**(다음 날 자동 해제). 같은 회선의 쿠팡 윙·광고센터에 이상이 없는지 대표가 확인. 반복되면 끄고 다시 논의 |
| `cooldown` | 자동 수집이 차단급 쉬기 중(`blocked`·`empty_escalated`·`error_escalated`. `error_streak` 는 막지 않음) | 쉬기가 끝날 때까지 기다림 |
| `hours` | 09~19시 밖 | 정상 |
| `busy` | 다른 확인 진행 중(`busyUntil`) | 기다림 |
| `daily_cap` | 오늘 30번 다 씀 | 내일 |
| `gap` | 마지막 검색 뒤 180초 안(`nextAt`) | 기다림 |
| `ready` | 누를 수 있음 | — |

- 결과별 처리(서버 판정 → 저장)

| 판정 | 일별 칸(같은 키워드의 활성 추적기 모두, 칸 0·시작 분 0) | 그날 중지 |
|---|---|---|
| ok | found / out / short | 아니오 |
| noresult | noresult | 아니오 |
| blocked(차단 신호·D1) | 성공 없는 칸은 failed(성공 칸 유지) | **예** |
| partial(측정 중 창이 숨음 `wasHidden` 이면 ok·empty 도 partial — 기본값, 대표 결정 대기)·empty(광고만 있고 일반 0개 포함)·error·timeout | failed | 아니오 |
| unsupported(쿠팡 안 다른 쪽) | unsupported. 단 확장이 `user_navigated`(사람이 창 안을 누름)라고 하면 error | 아니오 |
| 시작 못 함·응답 없음 | 없음. 확인 전이면 횟수·간격에 세지 않고, 확인 뒤면 셈(`counted`) | `blocked_today`·`report_pending`(확장이 오늘 차단을 봄)만 예 |

- 차단 신호는 어느 갈래에서든 그날 중지를 건다: 정상 저장, 같은 보고 다시 보내기, 이미 끝난 요청, 요청 뒤 10분 넘은 보고(410, 저장은 안 함), 확장 확인이 없는 요청, 모양 검사에 실패한 본문(400 + `stopped`), 확장의 직접 알림(`view=manual-stop`). 모두 더 엄격하게만 바뀌므로 꾸며도 해가 없다. 화면이 확장의 차단을 보고 스스로 멈추기만 하면 안 된다(서버 보고가 먼저).
- 비상 끄기: 총관리자 패널 '지금 확인 끄기'(확인 창 없이 즉시) → 서버가 모든 요청·확인을 `COUPANG_MANUAL_OFF` 로 거절. 확장 쪽: `chrome://extensions` 에서 확장 끄기·삭제(개발자 모드를 끄는 것도 확장 끄기다).
- 되돌리기(반드시 이 순서): ① 끄기 → ② 코드 되돌림·배포 → ③ (대표 승인 뒤) `docs/sql/c30-2-manual-check.rollback.sql`. 기록된 순위(일별 칸·스냅숏)는 남고 회차의 출처 표시만 사라진다. 코드가 남은 채 SQL 만 되돌리면 목록의 `manual` 이 `setup_required` 로 보이고 버튼이 숨는다(오류 아님).
- **자동 수집을 다시 켤 때 반드시 함께 볼 것**(지금 자동 수집 보류 중, `enabled=false`): 자동 claim(`coupang_rank_claim`, C 원문)은 수동 칸(`manual_last_search_at`·`manual_stopped_day`)을 보지 않는다. 수동 관문은 자동의 `last_claim_at` 을 보지만 반대 방향은 없다. 그래서 자동을 켜면 수동 검색 직후에도, 수동 '그날 중지' 날에도 자동 검색이 같은 회선으로 나갈 수 있다. **자동 재개 묶음에서 자동 claim 이 수동 간격·그날 중지를 함께 보게 고친 뒤 켠다**. 그 전까지 화면 API 가 둘이 함께 켜지는 것을 막는다(SQL·수집기 무접촉): '수집 켜기'(`collector-enable`)는 지금 확인이 켜져 있거나 오늘(KST) 지금 확인이 차단으로 멈춘 날이면 409 `COUPANG_COLLECTOR_MANUAL_CONFLICT`(`reason` = `manual_enabled`·`manual_stopped_today`), '지금 확인 켜기'는 자동 수집이 켜져 있으면 409 `COUPANG_MANUAL_COLLECTOR_CONFLICT`. 두 쓰기는 조건부 갱신이라(지금 확인 켜기 = `enabled=false` 일 때만, 수집 켜기 = `manual_enabled=false` 이고 그날 중지가 비었거나 오늘이 아닐 때만, 갱신 0행 = 409) 같은 순간 두 요청이 와도 하나만 저장된다(`reason` 에 `settings_changed` 가 올 수 있음 = 그 사이 설정이 다시 바뀜). 끄기는 언제나 된다. 자동 claim 을 고치는 묶음에서 이 거절을 푼다. 수동 회차(`source='manual'`)는 자동의 시간당·하루 상한 집계와 48시간 차단·빈 쪽 집계(`coupang_rank_stats`)에 들어간다 — 자동 재개 판단 때 수동 차단도 차단으로 보이는 보수적 효과다. 반대로 **성공 쪽은 빼고 센다**: 속도 올리기 관문('48시간 성공 48회')·수집기 관리의 '마지막 성공'·목록의 '최근 갱신(수집기 PC)'은 화면 API 가 수집기 회차(`source='collector'`)만 다시 센다(수동 성공만으로 관문이 열려 검증 안 된 두 배 속도로 자동을 다시 켜는 일을 막음, C 원문 `coupang_rank_stats` 는 그대로).
- 점검 SQL(읽기만): 오늘 요청 `select status, outcome_code, count(*) from public.coupang_rank_manual_claims where claimed_at >= (now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul' group by 1, 2 order by 1, 2;` · 중지 상태 `select manual_enabled, manual_stopped_day, manual_stopped_code, manual_stopped_at, manual_last_search_at from public.coupang_rank_settings;` · 수동 회차 `select claimed_at, status, http_status, organic_count, ad_count, duration_ms, error_code from public.coupang_rank_runs where source = 'manual' order by claimed_at desc limit 20;`
- 보관: 요청 표 `coupang_rank_manual_claims` 60일(스냅숏과 같음, 스냅숏.run_id = 요청.run_id 로 수동 기록을 가려낸다), 다음 요청 때 500줄씩 지운다. 백업하지 않는다. 회차는 자동과 같이 14일.
- 남은 한계: 총관리자 세션을 가진 같은 출처 스크립트(관리자 화면 콘솔·XSS)는 확인(`manual-verify`)도 직접 부를 수 있다 — '확인됨'은 '확장이 창을 열었다'는 증명이 아니다. **그런 스크립트가 쿠팡 창을 한 번도 열지 않고 claim → verify → 6초 뒤 같은 검색어·꾸민 목록으로 record 를 보내면 '확인 완료'로 저장되고, 같은 키워드의 다른 대행사 추적기에도 그 순위가 써진다**(재현됨). 막히는 것은 확인 없는 결과·5초 안 목록·다른 검색어뿐이다. 안전장치(3분·30번·시간·그날 중지)는 깨지지 않는다(꾸민 요청도 횟수·간격을 쓰고 쿠팡 요청은 없다). 결과는 같은 키워드의 모든 활성 추적기(다른 광고주 포함)에 쓴다 — 지금은 총관리자만 써서 받아들임. 결과를 확장만 만들 수 있게 묶을지(예: 확장 설치 때 키쌍을 만들고 공개키를 서버에 등록해 결과에 서명)와, 운영팀·광고주에게 열기 전에 '누른 사람(claim 의 대행사) 범위의 추적기에만 쓰기'는 대표 결정 항목이다. 화면이 확장 답을 받기 전에 관리자 탭을 닫으면 결과는 저장되지 않는다(검색 1번은 이미 셌다. 차단이었다면 확장의 직접 알림으로 중지는 걸린다).

## 헬스 스냅샷 RPC(로그 B안, 2026-10-16)

- 무엇: `/api/rank-collection-health` 가 캐시 미스 1회에 Supabase 를 12번(활성 상품 1,000행 이상이면 더) 읽던 것을 읽기 전용 함수 `public.mi_rank_collection_health_snapshot` 1번으로 읽는다. 왜: Supabase 무료 조직 로그 저장량 167%(2026-10-16). 응답(숫자·글자·상태 코드·헤더·60초 캐시·45분 경계·`ok`)은 그대로다. 결정 근거: `docs/DECISIONS.md` 2026-10-16 '헬스 캐시 미스'.
- 대표 SQL: `supabase/migrations/20261017100000_rank_collection_health_snapshot.sql` = `docs/sql/log-b-rank-health-snapshot.sql`(바이트 같음, 136줄, begin/commit 1개씩, sha256 `0034ff564b5875fcea13a89c3fe72876cc8cc1e91ed72ccaf8bf7563b88b0997`). 바탕화면 준비: `bash ~/.claude/skills/mi-operator-feature/scripts/stage-sql.sh supabase/migrations/20261017100000_rank_collection_health_snapshot.sql 로그B-헬스스냅샷.txt`. 표·색인·다른 함수는 바꾸지 않고, 다시 실행해도 안전하다(create or replace).
- SQL 전에 배포해도 안전한 이유: 함수가 없으면 PostgREST 가 404 `PGRST202` 를 돌려주고, 서버는 예전 개별 조회 12건으로 똑같이 답한다. 이때 그 서버 인스턴스는 10분 동안 RPC 를 다시 묻지 않아 요청 수도 예전과 같다. 그 밖의 오류·모양이 틀린 응답도 통째로 버리고 개별 조회로 간다. 코드 배포와 SQL 실행 순서는 상관없다.
- RPC 를 버린 뒤 쉬는 시간(인스턴스마다): 함수 없음·3xx·4xx(권한 없음 403 `42501`·인자 불일치 400 등, 408·429 는 뺌)·모양 틀림은 10분. 5xx·시간 초과·네트워크는 1분부터 연달아 나면 2·4·8분, 10분에서 멈춘다(쓸 수 있는 스냅샷이 오면 1분으로 돌아감). 쉬는 동안은 개별 조회 12건만 나간다. 그래서 RPC 가 계속 실패할 때 B안 전보다 더 나가는 요청은 인스턴스마다 이렇다: 없음·3xx·4xx·모양 틀림은 10분에 1건, 일시 실패는 처음 15분 동안 최대 4건(0·1·3·7분), 그 뒤 10분에 1건. 동시에 난 캐시 미스가 함께 실패하면 한 번으로 친다. RPC 1건은 2.5초에서 끊는다(느리게 실패하는 RPC 가 워치독 curl 15초를 잡아먹지 않게).
- 적용 확인(SQL 편집기, 읽기만): `select p.provolatile, pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon from pg_catalog.pg_proc as p where p.proname = 'mi_rank_collection_health_snapshot';` → 1행 `s`·`false`. 헬스 응답은 일부러 바뀌지 않으므로 응답으로는 경로를 구분할 수 없다. 함수가 있는 것과 서버가 실제로 그 경로를 쓰는 것은 따로 확인한다.
- 실제 경로 확인(SQL 실행 10분 뒤): ① Vercel 함수 로그에서 `"event":"rank_collection_health_snapshot_fallback"` 줄을 찾는다. RPC 를 버릴 때만 남는 한 줄(인스턴스마다 쉬는 시간에 1줄)이고 `reason`(missing·lasting·transient·malformed)·`status`·`errorCode`·`retryInMs` 만 담는다. 10분 넘게 새 줄이 없으면 RPC 경로다. `reason:"missing"` 이 이어지면 PostgREST 스키마 캐시가 함수를 아직 모르는 것일 수 있다 → SQL 편집기에서 `notify pgrst, 'reload schema';`(추정: Supabase 는 DDL 뒤 자동으로 다시 읽는다고 알려져 있으나 이번에 확인하지 않았다). `reason:"lasting"`·`status:403` 이면 실행 권한 grant 가 빠진 것이니 대표 SQL 을 다시 돌린다(다시 실행 안전). ② Supabase API 로그(대시보드 로그 화면, 메뉴 이름은 이번에 확인하지 않음)에서 `/rest/v1/rpc/mi_rank_collection_health_snapshot` 이 200 으로 찍히고, 헬스 개별 조회의 `/rest/v1/naver_shopping_worker_nonces?select=created_at` 요청이 헬스 주기(워치독 10분·관리자 화면 60초)로는 더 보이지 않는지 본다. 같은 조회를 `naver-rank-cron` 도 하지만 마지막 실행본 버전이 기대값과 다를 때만이므로, 수집기가 최신 버전일 때 기준으로 본다. 효과는 Supabase 사용량의 로그 저장량 추이로 본다(줄어드는 폭은 아직 실측 전).
- 되돌리기: `drop function if exists public.mi_rank_collection_health_snapshot(timestamptz, timestamptz, integer, integer, integer);` → 다음 캐시 미스부터 개별 조회(응답 같음). 코드는 되돌릴 필요 없다.
- 순위 잠금: 이 마이그레이션은 순위 표 이름을 읽으므로 `check:rank-feature-lock` 이 '잠금되지 않은 순위 마이그레이션'으로 잡는다. 통합 때 잠금 `files` 에 `rankMigration: true` 항목 1개를 더한다(기존 잠금 항목은 하나도 바뀌지 않는다).

## N30 그룹상품 추적 (2026-10-23)

- 무엇: 스마트스토어 그룹상품은 검색 결과 카드 1장에 그때의 대표 옵션 상품번호가 붙는다. 대표 옵션이 바뀌어 추적 번호로 '300위 밖'이 되면, 관리자 카드의 '그룹상품 번호'에 같은 그룹의 다른 옵션 번호(또는 옵션 상품 URL)를 넣어 둔다. 옵션 번호가 붙은 오가닉 카드가 보이면 그 위치를 순위 후보로 본다. 스토어 확인: ① 추적 상품 URL 과 카드 링크에 같은 종류의 스토어 주소(`smartstore.naver.com/<주소>`·`brand.naver.com/<주소>`)가 둘 다 있으면 주소가 같으면 확인됨, 다르면 다른 스토어 ② 주소가 한쪽이라도 없으면(검색 카드 링크는 보통 `…/main/products/…` 라 주소가 없다) 스토어 이름: 기준 = 지난 30일 대표 정확 기록의 스토어 이름, 없으면 추적 `mall_name`(입력 칸 없음, 첫 커밋 카드 스토어 이름으로 자동 채움) — 카드 이름과 같으면 확인됨, 다르면 다른 스토어, 기준이나 카드 이름이 비면 확인 안 됨. 원부(가격비교) 카드에서 온 값일 수 있는 이름('네이버', 원부 카드로 기록된 행의 이름, 지난 기록·이번 창 원부 카드와 같은 추적 `mall_name`)은 기준으로 쓰지 않는다. 순위 고르기(규칙 C'): 다른 스토어로 확인된 옵션만 빼고, 확인됨·확인 안 됨 옵션은 모두 대표(정확 상품·원부)와 비교해 가장 높은 순위를 쓴다(같으면 대표, 옵션끼리 같으면 확인됨 먼저). 대표가 보이든 안 보이든, 첫 확인·지난 기록 유무와 상관없이 같은 규칙이다. 결정 근거: `docs/DECISIONS.md` 2026-10-23 'N30 그룹상품 추적'.
- 바뀌지 않는 것: 네이버 검색 횟수·결과 수(300)·추적 개수·윈도우·맥 할 일 없음. 런타임 1.1.34·지문 `5db29dbd1ca354fb50756e073e57c52b2a95f978bea89ba57d7c8c1e41856daf` 그대로(`node scripts/naver-shopping-runtime-fingerprint.mjs 1.1.34`).
- 대표 SQL(1회): `supabase/migrations/20261023090000_naver_rank_group_products.sql` = `docs/sql/n30-group-1-option-product-ids.sql`(바이트 같음, begin/commit 1개씩, sha256 `54245429f9da75c53fe2eeb2876626fdf326b3dc6b16d994f1f0145df1fd8bfc`). 바탕화면 준비: `bash ~/.claude/skills/mi-operator-feature/scripts/stage-sql.sh supabase/migrations/20261023090000_naver_rank_group_products.sql N30-그룹상품-1-칸추가.txt`. 다시 실행해도 안전하다. `lock_timeout` 오류(수집 커밋과 겹침)가 나면 그대로 한 번 더 Run.
- 적용 확인(읽기만): `docs/sql/n30-group-1-option-product-ids.verify-applied.sql` → `ARRAY | '{}'::text[] | NO | 1 | true | 0`. 저장 시 '준비 전' 409 가 계속 나면 `notify pgrst, 'reload schema';` 한 줄(마이그레이션 끝에도 들어 있음).
- 순서: SQL 먼저 → 확인문 통과 → 배포. SQL 전에 배포돼도 안전하다(옵션 칸 없음 = 옵션 없음, 옛 조회로 한 번 더 읽음). 이때 함수 인스턴스마다 10분에 경고 1줄 `naver_rank_option_column_missing` 이 Vercel 로그에 남는다.
- 배포 직후 확인: `/health` release = 배포 커밋, N30 첫 claim 200·첫 commit(수집 정상). 맥 워치독 로그에 `sync_source_fast_forwarded` 가 찍혔는지, `sync_source_fast_forward_failed` 가 없는지(관리자·광고주 화면 파일만 바뀌어 런타임 14개 파일은 같다. ff 실패면 원본 체크아웃의 미커밋 변경을 대표 승인 받아 정리 — 다음 런타임 인상 때 맥이 뒤처지지 않게).
- 운영 확인(다음 자동 순위 확인 뒤, 하루 2~3회): 카드 알약 '현재 N위 · 옵션'(공유 이미지에는 '현재 N위'만), '잡힌 옵션 · 번호 · 제목' 줄, 날짜 칸 '순위 · 옵션'. DB 로는 최신 스냅샷 `item->>'matchBasis'`(`group_option`·`not_found`·`primary`)와 `item->>'matchedOptionProductId'`.
- 기록 문장(last_message, 광고주 화면 '메시지'에도 나감 — 아래 '스토어를 확인하지 못해' 꼬리만 광고주 화면에서 빠진다)
  - `그룹상품 옵션(상품번호 …)이 오가닉 N위로 잡혀 30일 대표 순위로 기록했습니다.` + `대표 상품번호는 이번 결과에 없습니다.` 또는 `대표 상품번호는 M위입니다.`(대표도 보였지만 옵션 카드가 더 높음) 또는 `대표 상품번호의 관련 원부는 M위입니다.`
  - 꼬리 `스토어를 확인하지 못해 확인 없이 기록했습니다.` = 스토어를 확인하지 못한 옵션 카드가 가장 높아(대표보다 높거나 대표가 300개 안에 없음) 그 순위를 기록했다(`mallCheck:"unverified"` — 기준 이름이 없었거나 카드에 스토어 이름이 없었다. 문장은 어느 쪽인지 단정하지 않는다). 다른 스토어 번호를 잘못 넣지 않았는지 확인한다. 이 꼬리는 DB 문장에는 남고 관리자 세션 화면(카드 '메시지'·'잡힌 옵션' 줄)에만 보이며, 광고주 화면 '메시지'에서는 빠진다.
  - `대표 상품번호와 그룹상품 옵션 n개 모두 … 찾지 못했습니다.` = 둘 다 300개 밖. 꼬리 `다른 스토어로 보여 뺀 옵션: …` = 그 번호 카드는 보였지만 스토어가 달라 순위에 넣지 않았다(명세 §7.2). 이 꼬리는 대표가 안 보인 날·옵션이 이긴 날에만 붙는다.
  - 대표가 이기면 문장은 옵션 없는 추적과 같다. 그날 다른 스토어로 뺀 번호가 있으면 문장에는 없고 스냅샷 확인 키(`mallMismatchProductIds`)와 관리자 줄 '다른 스토어로 보여 뺀 번호'에만 남는다(광고주 화면에는 안 보임).
- 관리자 확인 사항(스냅샷 `item->'optionGroup'` 키로 남아 관리자 카드 '잡힌 옵션'·'그룹상품 확인' 줄에 보임, 광고주 화면 줄에는 안 보임. 이 가운데 `mallCheck:"unverified"` 만 위 문장 꼬리에도 남는다 — 광고주 화면에서는 빠짐): `mallCheck:"unverified"` 스토어 확인 없이 기록 · `titleCheck:"low_overlap"` 제목이 많이 다름 · `cardCount` 서로 다른 카드 여러 장에서 잡힘 · `primaryProductRank`(+`primaryRankSource`) 대표 번호도 그 순위에 보였지만 옵션 카드가 더 높아 옵션으로 기록 · `otherCardCount`·`otherCardBestRank`(`matchBasis:"primary"`) 대표가 이겼고 다른 카드에서도 옵션 번호가 보임 · `mallMismatchCount`·`mallMismatchProductIds` 다른 스토어로 뺀 번호 수와 번호(대표가 이긴 날 `matchBasis:"primary"` 행에도 남는다. 대표 번호 카드 자신에 붙은 번호는 세지 않는다). 관리자 줄 '다른 스토어로 보여 뺀 번호 n개 · 번호'. 그룹상품은 카드 1장이므로 카드가 둘 이상이면 잘못 넣은 번호인지 확인한다.
- 판정 비용 상한: 같은 창(submit 한 번)에서 같은 옵션 번호의 정식 판정은 한 번만 하고, 창 하나에서 새로 도는 정식 판정은 200번까지(`OPTION_LOOKUPS_PER_WINDOW_MAX`). 넘으면 그 추적은 대표 결과 그대로 커밋하고 Vercel 로그에 `naver_rank_option_evaluation_failed`·`reason:"lookup_budget_exhausted"` 1줄. 이 경고가 보이면 같은 키워드 추적들에 넣은 번호를 점검한다.
- 편집 API: `POST /api/naver-rank-trackers` `{action:"options", trackerId, mode:"read"|"preview"|"save", optionInput, applyToSameProduct, expectedTrackerIds?}`. 광고주 세션·세션 없는 접속 코드는 403. 원부 추적 409 `RANK_OPTION_CATALOG_TRACKER`, 대표 번호를 확인할 수 없는 추적 409 `RANK_OPTION_PRIMARY_INVALID`, 칸 없음 409 `RANK_OPTION_NOT_READY`, 21개 이상 400 `RANK_OPTION_LIMIT`, 받지 않은 칸이 있는 저장 400 `RANK_OPTION_INPUT_REJECTED`, 미리 보기 뒤 대상 변경 409 `RANK_OPTION_TARGETS_CHANGED`, 일부만 저장 409 `RANK_OPTION_PARTIAL`(같은 내용으로 다시 저장 — 결과가 같아 안전). '다른 키워드에도 적용'은 같은 광고주 범위·같은 대표 상품번호(`product_id`)의 활성·일시중지 상품 기준 추적만 바꾼다(명세 §8.3-4, 대표 번호가 다른 그룹 구성원은 바꾸지 않음). 저장은 `option_product_ids` 한 칸만 바꾸고 순위 확인 시각·임대·깨우기·네이버 요청은 0. 서버 로그 `naver_rank_tracker_options_saved`(추적 수·번호 개수만).
- 되돌리기
  1. 가장 빠름(배포 없음): 편집창에서 번호를 지우고 저장('모두 지우기') → 다음 확인부터 대표 번호만 본다. 그 번호로 잡힌 지난 기록은 지우지도 숨기지도 않는다(실제 검색 결과 기록, 명세 §15-4). 날짜 칸 '옵션'·DB `item->>'matchBasis' = 'group_option'` 로 구분.
  2. 코드 되돌리기: 이 기능의 커밋 **전부**를 한 번에, 최신 것부터 revert 한다. 지금(배포 전 `n30-group` 브랜치) 기능 커밋은 여럿이다 — `b026b42`(1차 구현)·`ad87e64`(반박 검토 수정)·`e0601cc`(3차 수정: D2 예외·마이그레이션 설명·이 안내)·`55a8b4f`(4차 수정: 스토어 확인·순위 고르기 단순 규칙)·5차 수정 커밋(규칙 C'·흔적 E'·사용법 F·마이그레이션 설명)·통합 때 넣는 잠금 JSON·`vercel.json` CSP 커밋. 명령: `git revert --no-edit <통합 커밋> <5차 수정 커밋> 55a8b4f e0601cc ad87e64 b026b42`(통합 때 하나로 합쳤으면 그 커밋 하나). 하나라도 빼면 멈추거나 막힌다(반박 검토 재현): 뒤 커밋이 고친 파일(DECISIONS·RUNBOOK·admin.html·되돌리기 SQL·마이그레이션 테스트)에서 충돌로 revert 가 멈추고, 통합 커밋을 빼면 잠금에 남은 마이그레이션 항목이 ENOENT 로 `check:rank-feature-lock` 을, 남은 CSP 해시가 화면 테스트를 실패시켜 `vercel.json` buildCommand(`check:vercel-deploy` → `check:release`)에서 배포가 막힌다. revert 뒤 배포 전에 `npm run check:release` 통과와, 기능 전 커밋 대비 이 기능 파일이 남지 않았는지(`git diff --stat <기능 전 커밋>`) 확인한다. 칸은 DB 에 남아도 무해(기본 `'{}'`, 아무도 안 읽음).
     - 메모(통합 담당): 위 해시는 배포 전 브랜치 기준이다. 리베이스·커밋 합치기로 브랜치를 정리하면 해시가 바뀌므로, 배포 직전에 이 줄의 커밋 이름을 main 에 실제로 들어간 최종 커밋(들)로 갱신한다.
  3. DB 되돌리기(선택, 코드 되돌린 뒤 권장): `docs/sql/n30-group-1-option-product-ids.rollback.sql`(칸·제약 삭제, 저장한 번호도 사라짐, 다시 실행 안전). 되돌린 뒤 적용 확인문은 `column "option_product_ids" does not exist` 오류로 끝나는데 그것이 정상이다. 코드가 남아 있어도 목록·수집은 견딘다(칸 없음 = 옵션 없음, 옵션으로 잡힌 지난 기록은 그대로 보임).
- 한계: 'N 상품 순위' 단건 조회와 서버 즉시 경로(hybrid 가 아닐 때의 `runTrackerCheck`·크론)는 대표 번호만 본다. 운영 hybrid 모드에서는 이 경로들이 30일 기록을 만들지 않는다. 모드가 바뀌어 옵션 있는 추적이 그 경로로 들어오면 Vercel 로그에 `naver_rank_option_server_path_primary_only` 가 남는다.
- 백업(`scripts/db-export.mjs`): `naver_rank_trackers` 를 `select=*` 로 받으므로 새 칸도 자동으로 담긴다(칸이 생긴 첫날은 증분 검사에서 `columns_changed` 로 통째 백업).
- 순위 잠금(통합 담당)
  - 이 마이그레이션은 `naver_rank_trackers` 를 바꾸므로 잠금 `files` 에 `rankMigration: true` 로 등록해야 `check:rank-feature-lock` 이 통과한다. 스킬 도구 `lock-regen.py` 에는 **마이그레이션만** 넘긴다(`product-rank-group-products=supabase/migrations/20261023090000_naver_rank_group_products.sql`) — 이 도구는 넘긴 모든 항목에 `rankMigration: true` 를 붙인다.
  - 판정 파일 `src/server/naver-rank-option-group.mjs` 는 30일 기록 순위를 바꾸므로 잠금 `files` 에 `rankMigration` 없이 손으로 넣는다: `{"id":"product-option-group-match","file":"src/server/naver-rank-option-group.mjs","sha256":"<LF 기준 sha256>"}`. 넣지 않으면 판정 규칙을 바꿔도 잠금 검사가 통과한다(반박 검토 재현).
  - CSP: `csp-hash-swap.mjs` 는 HEAD 와 비교하므로 기능이 이미 커밋된 트리에서는 '교체 0건'이다. 기준 커밋(3c03f3a) 대비 admin.html·client.html 인라인 스크립트 해시를 직접 바꾸고 `node scripts/check-public-build-security.mjs dist`·`scripts/google-login-nudge-ui.test.mjs` 로 확인한다.
