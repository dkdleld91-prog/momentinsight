# 계정 플랜·이용 기간 관리 — 구현 사양 (2026-09-07 대표 결정)

대표 결정(2026-09-07 오후):
- 흐름: 구글 체험 가입 → 카카오 문의·결제(수기) → 총관리자가 계정 오픈(플랜·기간·추적 수량) → 총관리자 화면에 남은 기간(D-n) → 만료 3일 전부터 고객 화면 팝업("연장 문의는 카카오톡 채널", "만료 후 5일 안에 연장 없으면 데이터 삭제").
- 만료 후 5일 안에 연장이 없으면 해당 계정 데이터 삭제.
- 총관리자 화면에 구글 연동 계정의 구글 이메일 표시(문의 시 계정 찾기).
- 대행사(운영팀·광고주) 목록 검색, 기간 단위(일수) 총관리자 직접 설정, 고객 화면(로그아웃 근처)에 남은 기간 표시.

## 1. 데이터 (마이그레이션 `20260907170000_account_plans.sql`, 대표가 SQL Editor에서 실행)
- `clients` 열 추가: `plan_name text`, `plan_days integer`(기간 단위, 기본 30), `plan_started_at timestamptz`, `plan_expires_at timestamptz`(null=무기한), `plan_note text`, `plan_updated_at timestamptz`. 순위 수집 표 무접촉.
- 체험 계정은 `login_identities(role=trial)` 그대로. "정식 전환" 시 `clients` 행을 만들고 그 identity 를 `role=client, code=새 코드` 로 옮긴다(구글 로그인은 그대로 유지, 코드는 총관리자 화면에서 보임).
- 상태 계산(`src/server/account-plan.mjs`, 공용): `planStatus(row, nowMs)` → `{ name, days, startedAt, expiresAt, daysLeft, graceEndsAt, state }`, state = `none`(무기한) | `active` | `expiring`(D-3 이내) | `expired`(만료~유예 5일) | `delete_due`(유예 지남).

## 2. 총관리자 API (`super-admin-api.mjs`, 비잠금)
- GET 목록: 광고주·운영팀 payload 에 `googleEmail`(login_identities 조인), 광고주에 `plan`(planStatus). 추가로 `trials`: `[{ googleSub, googleEmail, linkedAt, todayUsed }]`.
- POST `set-plan` `{ agencyCode, planName?, planDays?, expiresAt?, mode: "extend"|"set" }`: extend = max(now, 기존 만료)+days, set = expiresAt 직접 지정. `plan_started_at` 이 비어 있으면 now. 감사 `client.plan_updated`.
- POST `clear-plan` `{ agencyCode }`: 무기한으로 되돌림. 감사 `client.plan_cleared`.
- 코드 규칙(2026-09-07 결함 수정): set-plan·clear-plan·set-rank-keyword-limit·revoke-client 처럼 "이미 있는 계정"을 고르는 조작은 `existingAccountCode`(5자 이상)로 받는다. 옛 5자 코드(ofyou 등)가 `normalizeAgencyCode`(6자 이상, 새 코드 발급 규칙)에 걸려 "광고주 코드를 입력해주세요"로 거부되던 문제.
- 무기한 오픈(2026-09-07 대표 요청): 연장 일수 칸에 `무기한` 항목. 광고주 카드에서 고르고 [오픈하기/연장하기] → `clear-plan`(기간이 있던 계정은 confirm 1회). 체험 전환에서 고르면 `open-trial { unlimited: true }` → `plan_expires_at`/`plan_started_at`/`plan_days` null.
- POST `open-trial` `{ googleSub, name, planName, planDays, rankKeywordLimit? }`: 무작위 코드(12자) 생성 → clients insert(plan 포함, rank_keyword_limit) → login_identities(role trial, google_sub) 를 role client/code 로 update → 감사 `client.created_from_trial`. 코드 자동 생성은 이 액션에서만(코드 로그인 정책 테스트는 create-client 에만 해당).

## 3. 세션·게이트
- `/api/session`(client 역할): `plan` 포함(planStatus). `activeClientByCode` select 에 plan 열(없으면 폴백).
- 게이트(`session-gate.mjs`, 승인 파일): `activeClientForClaims` 가 `plan_expires_at` 을 함께 읽어 만료(expired/delete_due)면 제한 모드 — 허용: `/api/session`, 키워드 조회·조사·노트, public-state, home-feed, 순위 경로 GET(기록 보기). 그 외·POST 는 403 `PLAN_EXPIRED` "이용 기간이 끝났습니다. 연장 문의는 카카오톡 채널로 주세요." 수집 표는 건드리지 않는다(수집 자체는 2단계 결정).

## 4. 화면
- 광고주(`client.html`): 사이드바 로그아웃 위에 "이용 기간 · D-12 (09/19까지)" / "무기한" / 체험은 "체험 계정" 칩 그대로. D-3 이내: 들어올 때마다 팝업(대표 결정 2026-09-07 "들어갈 때마다 나와야 함" — 로그인 1회당 한 번, 새로고침·재로그인이면 다시; 하루 한 번 localStorage 게이트는 제거)(제목 "이용 기간이 N일 남았습니다", 만료일, "만료 후 5일 안에 연장하지 않으면 계정과 데이터가 삭제됩니다", "연장 문의는 카카오톡 채널" 버튼). 만료 후: 모든 화면 위 띠 "이용 기간이 끝났습니다 · N일 안에 연장하지 않으면 데이터가 삭제됩니다 · 연장 문의 카카오톡 채널".
- 총관리자(`admin.html` 대행사 연결 화면): 상단 검색칸(운영팀·광고주 이름·코드·구글 이메일), 각 카드에 구글 이메일 줄, 광고주 카드에 플랜 줄(플랜 · 만료일 · D-n, 만료 임박 붉게) + 기간(일) 입력 + 플랜 선택 + [오픈·연장] + 만료일 직접 지정 + [무기한], 새 카드 "무료 체험 계정"(이메일·가입일·오늘 조회) + [정식 전환](광고주명·플랜·기간·한도 입력).

## 5. 2단계 — 유예 뒤 데이터 삭제 (대표 결정 2026-09-07 "살릴 필요 없음, 서버·저장공간만 무거워짐" → 실행 승인)
- 일 1회 Vercel 크론 `/api/account-expiry-cron`(매일 03:30 KST, `Authorization: Bearer CRON_SECRET`, 세션 무관): `src/server/handlers/account-expiry-cron.mjs`. `plan_expires_at + 5일 < now` 이고 planStatus 가 `delete_due` 인 광고주(총관리자 코드 제외, 한 번에 20개)를 지운다 — 순서: naver_rank_trackers → naver_place_rank_trackers(스냅샷 FK cascade) → keyword_research_notes → login_identities(role client) → trial_keyword_quota(그 구글 sub) → clients 행(brands·reports·kpi 등 cascade, 운영팀 client_id set null) → audit_logs `client.deleted_after_grace`. 한 단계라도 실패하면 계정 행은 남겨 다음 날 재시도. `?dryRun=1` 은 대상만 보고, `MI_ACCOUNT_EXPIRY_DELETE_DISABLED=true` 면 항상 dryRun. 복구 기능은 두지 않는다.

## 5-1. 구글 연동 기한 (대표 지시 2026-09-08 "30일 카운트다운, 연동 안 한 계정은 없어지는 걸로")
- 대표 정리(2026-09-08 22:15): "지금부터 30일은 구글 연동 기간. 연동 안 된 사람은 읽기 전용에서 3일 뒤 삭제. 연동한 사람은 30일이 지난 후부터 30일 카운팅."
- 기한 `GOOGLE_LINK_DEADLINE = 2026-10-07`(KST 23:59:59, `src/server/account-plan.mjs`). 화면 카운트다운은 `public/mi-google-nudge.js` 의 `LINK_DEADLINE`(같은 날짜) — 팝업 pill "적용 안내 · D-n", 본문 "10월 7일까지 (D-n) 구글 계정을 연결해 주세요 — 기한이 지나면 연결하지 않은 계정은 이용이 만료되어 3일 뒤 삭제되고, 연결한 계정은 10월 8일부터 30일 이용 기간이 시작됩니다."
- 기한 뒤(미연동): `account-expiry-cron` 이 매일 `expireUnlinkedClients` 를 먼저 돌린다 — 활성 광고주 중 `login_identities(role client)` 에 코드가 없는 계정에 `plan_expires_at = 기한`, `plan_note = "구글 미연동 · 자동 만료"`, 감사 `client.expired_unlinked`. 총관리자 코드·이미 기한 전에 만료된 계정·체험 계정(구글 연동이 곧 계정)은 제외. 유예는 `plan_note` 로 판정해 **3일**(`GOOGLE_LINK_GRACE_DAYS`, `planGraceDays(row)`): 읽기 전용 10/08 03:30 → 10/11 03:30 KST 삭제. 일반 만료(총관리자가 정한 기간)는 5일 그대로.
- 기한 뒤(연동): 같은 크론의 `startLinkedClientPlans` 가 구글을 연결한 활성 광고주 중 **무기한** 계정에 이용 기간을 찍는다 — `plan_started_at = 기한`, `plan_days = 30`, `plan_expires_at = 2026-11-06 23:59:59 KST`(`googleLinkPlanExpiryIso`, 기한 + 30일), `plan_note = "구글 연동 · 기한 뒤 30일 이용"`, 플랜 이름은 있으면 유지·없으면 basic, 감사 `client.plan_started_linked`. 제외: 총관리자 코드, 이미 이용 기간이 있는 계정(총관리자가 정한 기간 유지), 기한 뒤 총관리자가 손댄 계정(`plan_updated_at ≥ 기한`, 일부러 무기한으로 돌린 경우), 체험 계정(clients 행 없음). 이후는 일반 흐름(11/04 D-3 팝업 → 11/07 읽기 전용 → 유예 5일 → 11/12 03:30 삭제 — 연장은 총관리자 카드).
- 운영팀 포함(대표 지시 2026-09-08 "운영팀도 포함"): 운영팀 코드는 플랜 열이 없어 유예 표시 없이, 기한 + 유예 3일이 지난 날(미연동 광고주 삭제와 같은 10/11 03:30)에 `revokeUnlinkedTeams` 가 `login_identities(role team)` 에 없는 활성 운영팀 코드를 `status=revoked`(revoked_at, client_id null)로 바꾼다. 연결된 광고주는 일시중지하지 않는다(총관리자 수동 해제와 다른 점). 감사 `operation_team.revoked_unlinked`. 경고는 넛지 팝업 카운트다운으로만 나간다. 연결한 운영팀은 그대로다(운영팀에는 이용 기간이 없다).
- 광고주 팝업·띠는 plan.note 로 문구를 바꾼다("구글 계정을 연결하지 않아 이용이 만료되었습니다 · n일 안에 구글 연결 + 카카오 채널로 연장 요청", n 은 `graceDaysLeft` 라 자동으로 3일 기준). 총관리자 카드 플랜 줄에 메모가 붙는다. 기한 뒤 구글을 연결해도 만료가 자동으로 풀리지는 않는다 — 총관리자가 연장/무기한으로 살린다(자동 복구는 대표 결정 대기).
- 날짜를 바꾸려면 두 파일의 날짜 상수를 같이 바꾼다.

## 6. 검증
- 단위: account-plan(planStatus 경계), super-admin-api(set-plan/open-trial), code-session-api(session.plan), session-gate(PLAN_EXPIRED). 실측: 총관리자 화면에서 체험 계정 정식 전환 → 광고주 화면 D-day 표시 → 만료일을 오늘로 지정해 팝업·띠 확인.
