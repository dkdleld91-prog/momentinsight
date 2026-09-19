---
name: mi-runtime-release
description: 모먼트 인사이트 N30 순위 수집 런타임(1.1.x) 버전 인상·배포 절차. 수집기·네이티브 호스트·워커·계약 파일을 고치거나 "런타임 올려", "1.1.xx 배포", "윈도우 업데이트 한 줄" 같은 요청에 사용한다.
---

## 실행 도구 (먼저 이것부터 쓴다 — 손으로 다시 짜지 않는다)
| 할 일 | 명령 |
|---|---|
| 버전 인상 전체(리터럴·지문·감사·마이그레이션·테스트 생성/보관·baseline·contract·RUNBOOK) | `python3 ~/.claude/skills/mi-runtime-release/scripts/bump.py <워크트리> <새버전> <slug> --summary "한 줄" [--header-file f] [--behaviour-file f]` |
| 잠금 갱신(+새 순위 마이그레이션 등록) | `python3 ~/.claude/skills/mi-runtime-release/scripts/lock-regen.py <워크트리> [id=supabase/migrations/파일.sql]` |
| 전체 검사(요약만 출력) | `bash ~/.claude/skills/mi-runtime-release/scripts/pipeline.sh <워크트리>` (백그라운드 실행) |
| 라이브 대기 | `bash ~/.claude/skills/mi-runtime-release/scripts/wait-live.sh <sha7>` (백그라운드) |
| 대표용 SQL 준비(바탕화면+TextEdit) | `bash ~/.claude/skills/mi-runtime-release/scripts/stage-sql.sh <sql> <이름.txt>` |
| 윈도우 PowerShell 한 줄 생성 | `bash ~/.claude/skills/mi-runtime-release/scripts/windows-oneliner.sh <sha40> <버전>` |
| 배포 후 집계 | `LIST=1 node ~/.claude/skills/mi-runtime-release/scripts/tally.mjs <sinceISO>` |

bump.py 는 2026-09-19 가상 인상(1.1.32→1.1.33)으로 검증됨: 잠금·baseline·contract 73/73·테스트 55건 통과. 동작 테스트 블록은 `--behaviour-file` 로 넣는다(없으면 최소 테스트).

# N30 런타임 인상·배포

저장소 `~/Desktop/개발/모먼트 인사이트 개발` (main 체크아웃은 워치독 동기화 원본이자 맥 Chrome 확장 로드 경로 → 직접 수정 금지, 항상 워크트리에서 작업). 순위추적은 동결 영역이라 **대표의 명시적 요청이 있을 때만** 고치고 잠금 해시를 갱신한다.

## 1. 작업 준비
- `git worktree add <scratchpad>/wt-<이름> -b <브랜치> origin/main` 후 `ln -s <저장소>/node_modules <워크트리>/node_modules`.
- 세션이 재시작되면 스크래치패드·워크트리·바탕화면 산출물이 사라질 수 있다 → 커밋 원본에서 다시 만든다.
- 근거 없는 인상 금지: 실패 집계(`node ~/.config/momentinsight/tools/tally126.mjs <sinceISO>`)와 `naver_shopping_failure_evidence` 행으로 원인을 먼저 확정한다. 증상별 연속 인상은 대표가 질책한 방식이다.

## 2. 인상 체크리스트 (N = 새 버전)
1. 버전 리터럴 5곳: `tools/naver-shopping-chrome-extension/manifest.json`, `scripts/naver-shopping-local-worker.mjs`(EXPECTED_RUNTIME_VERSION), `src/server/handlers/naver-shopping-local-worker.mjs`, `src/server/naver-shopping/worker-runtime-expectation.mjs`(2곳), `src/server/handlers/naver-rank-trackers.mjs`.
2. 지문: `node scripts/naver-shopping-runtime-fingerprint.mjs <N>` (13개 구성 파일 → 파일을 다 고친 뒤 계산).
3. 감사 스크립트 2개(`naver-shopping-candidate-performance-audit.mjs`, `naver-shopping-account-rank-health-audit.mjs`)의 버전·지문.
4. 마이그레이션: 직전 런타임 마이그레이션을 "begin;" 기준으로 나눠 지문·버전·`runtime_1_1_N_`만 치환(정체 핀만 이동), 머리말은 이번 변경의 실측 근거로 새로 쓴다.
5. 테스트: 직전 `scripts/naver-shopping-runtime-1-1-(N-1)-migration.test.mjs`에서 새 테스트 생성(priorMigrationName은 치환 루프 전에 자리표시자로 보호), 직전 테스트는 보관용으로 전환(최신 여부 단정 → 과거 지문 고정, 라이브 표면 단정 제거, 구현 세부 단정 완화). `package.json` test 목록에 추가.
6. 라이브 표면 테스트의 버전·지문 치환: native-host, local-worker(스크립트·서버), runtime-neutral-admission, literal-audit, 감사 테스트 2개, naver-rank-trackers.
7. `scripts/check-release-baseline.mjs`·`scripts/check-server-contract.mjs`: 새 마이그레이션 read/files, 새 지문 상수, 핀 블록, 매니페스트 버전, EXPECTED 상수. **함정**: ① 직전 버전 지문은 계산식이 아니라 문자열 리터럴로 바꿔야 한다(버전만 올리면 과거 지문이 재계산되어 달라짐) ② 계약에는 문자열 핀 말고 정규식 핀(`/const EXPECTED… = "1\.1\.N";/`)도 있다 ③ 리터럴 감사 carrier 지문 검사도 새 지문으로.
8. `docs/RUNBOOK.md` ⑦ 버전 이력, 잠금 갱신(`node scripts/check-protected-rank-features.mjs --print-current` 결과에 version/baselineCommit/policy/n30Freeze 유지 + 새 런타임 마이그레이션 항목 `rankMigration:true`).

## 3. 검사 → 배포
- 파이프라인: `GOOGLE_OAUTH_CLIENT_ID=x GOOGLE_OAUTH_CLIENT_SECRET=y npm run check:vercel-deploy && git diff --check && node scripts/check-protected-rank-features.mjs`.
- 알려진 가짜 실패: "Public build check blocked"는 오래된 dist 때문(파이프라인이 다시 빌드) / 워치독 F2·F13은 **이 맥이 실제 수집 중이면** `collection_active`로 어긋남 → 수집이 없을 때 재실행.
- 라이브되는 순간 구버전 워커는 서버 게이트에서 막힌다 → **대표가 15분 안에 작업 가능할 때만 푸시**. 순서: 푸시 → `/health` release 폴링(약 12~14분) → 대표 ① Supabase SQL(바탕화면 `1.1.N-migration.txt`, TextEdit로 열어 둠, `requires_idle_control_plane`이면 2~3분 뒤 재시도) ② 윈도우 관리자 PowerShell 한 줄 → 맥은 워치독 자동.
- 윈도우 한 줄: `Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/dkdleld91-prog/momentinsight/<40자sha>/scripts/windows/update-naver-shopping-chrome-extension.ps1 -OutFile "$env:TEMP\mi-update.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\mi-update.ps1" -ReleaseCommit <7자sha> -ExpectedVersion 1.1.N` → `MI_EXTENSION_UPDATE_OK`.

## 4. 배포 후 검증과 기록
- 첫 런의 `runtime_version`·지문, 코디네이션 핀, 회로 closed, 첫 커밋, 맥 워치독 로그(`sync_source_fast_forwarded` → `drift_sync_ok` → `chrome_restarted`).
- 24시간 뒤 집계로 효과 판정(실패율·유형별). 효과가 없으면 없다고 보고한다.
- 메모리에 결과·지문·집계 기준 시각을 남긴다. 예약 점검은 별도 세션에 보고가 남아 대표가 못 본다 → 대표에게 "점검"이라고 보내 달라고 요청한다.
