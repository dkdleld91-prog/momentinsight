---
name: mi-operator-feature
description: 모먼트 인사이트에 대표·운영팀이 직접 쓰는 관리자 기능(공지, 설정, 편집 화면 등)을 만들 때의 완결성 기준과 저장소 함정 체크리스트. 관리자 화면·광고주 화면에 새 UI나 API 경로를 추가할 때 사용한다.
---

## 실행 도구 (먼저 이것부터 쓴다)
| 할 일 | 명령 |
|---|---|
| 페이지 인라인 스크립트가 바뀐 뒤 CSP 해시 교체(HEAD 대비 자동 대응) | `node ~/.claude/skills/mi-operator-feature/scripts/csp-hash-swap.mjs <워크트리>` |
| 잠금 갱신 | `python3 ~/.claude/skills/mi-operator-feature/scripts/lock-regen.py <워크트리>` |
| 전체 검사 | `bash ~/.claude/skills/mi-operator-feature/scripts/pipeline.sh <워크트리>` (백그라운드) |
| 라이브 대기 → 실제 화면 소스 확인 | `bash ~/.claude/skills/mi-operator-feature/scripts/wait-live.sh <sha7>` → `bash ~/.claude/skills/mi-operator-feature/scripts/verify-live.sh <표식...>` |
| 대표용 SQL 준비 | `bash ~/.claude/skills/mi-operator-feature/scripts/stage-sql.sh <sql> <이름.txt>` |

# 운영자 기능 출시 체크리스트

## 1. 기능 완결성 (대표 지시 2026-09-19)
저장 버튼 하나로 끝내지 않는다. 한 번에 넣을 것:
1. **되돌리기**: 끄기·내리기·삭제 버튼(즉시 반영, 확인 대화상자, 내용은 가능하면 보존).
2. **화면 안 사용 방법**: 올리기·확인·고치기·내리기·자동 종료 순서를 그 화면에 적는다. 채팅 설명으로 대신하지 않는다.
3. **복붙/원클릭 템플릿**: 자주 쓸 문구를 버튼으로. 누르면 입력란만 채우고 저장은 따로.
4. **미리보기**와 현재 상태 배지(지금 표시 중 / 꺼짐 / 기간 아님).
5. **디자인**: 실제 마크업·CSS를 읽고 기존 토큰으로 만든다. 출시 전 실제 모양을 확인하고, 대표에게 스크린샷 기준으로 보고한다.

## 2. 설계 기본값
- 권한: 읽기는 필요한 세션 전체, 쓰기는 총관리자(`x-mi-session-role=owner` + `x-mi-owner-agency-code`)만. 역할 검사는 핸들러에서.
- 핸들러: `withSupabase({ auth: "none" }, handler)` + `ctx.supabaseAdmin`, 응답은 `protectedJson`, DB 오류 문구는 숨긴다. 테스트는 내부 핸들러에 가짜 ctx를 넣어 호출.
- 테이블: RLS 켜고 public/anon/authenticated 회수, service_role만 부여. 마이그레이션은 바탕화면 txt로 대표에게(라이브 전 실행해도 무해하게 작성).
- 시간: KST 달력일 ↔ UTC 변환을 명시하고 경계(23:59:59.999)를 테스트한다.
- DOM: `textContent`만, `innerHTML` 금지.

## 3. 이 저장소의 함정 (전부 실제로 걸렸던 것)
- **세션 게이트**: 새 `/api/*` 경로는 기본이 세션 필수. 광고주 미연결 운영팀·체험·만료 세션도 써야 하면 `session-gate.mjs`의 세 집합에 추가 + 테스트.
- **CSP**: 페이지 인라인 스크립트가 바뀌면 `vercel.json`의 sha256 해시 교체(페이지당 인라인 스크립트 1개). "Public build check blocked"는 오래된 dist일 수 있다.
- **색상 가드**: `stage5-ui.test`가 새 hex 색상 리터럴 추가를 막는다 → `var(--mi-*)` 토큰만.
- **관리자 메뉴 수**: `data-mi-admin-screen` 개수가 `check-release-baseline.mjs`(adminMenuCount)와 `personal-calendar-ui.test.mjs` 2곳에 고정.
- **캘린더 글루 블록**: `var personalCalendarController = null;` ~ `function setScreen(` 사이는 60줄 제한 → 새 JS는 그 앞에.
- **역할 패리티**: `miFetch`, `requestRankTrackers` 등 비교 대상 함수는 건드리지 않는다.
- **총관리자 전용 화면**: 나브 링크에 `data-owner-only`, `setScreen`에서 비총관리자 해시 진입을 홈으로 돌린다.
- **잠금**: admin/client/index/session-gate는 잠금 대상 → 끝에 `--print-current`로 갱신.
- **diff --check**: 템플릿으로 생성한 코드의 공백 줄 주의.

## 4. 마무리
전체 파이프라인 통과 → 커밋 → 푸시 → `/health` release 확인 → 라이브 HTML에 새 마크업이 있는지 curl로 확인 → 대표에게 한국어로: 무엇이 생겼는지, 어디를 누르는지, 대표가 할 일.
