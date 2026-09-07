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
- POST `open-trial` `{ googleSub, name, planName, planDays, rankKeywordLimit? }`: 무작위 코드(12자) 생성 → clients insert(plan 포함, rank_keyword_limit) → login_identities(role trial, google_sub) 를 role client/code 로 update → 감사 `client.created_from_trial`. 코드 자동 생성은 이 액션에서만(코드 로그인 정책 테스트는 create-client 에만 해당).

## 3. 세션·게이트
- `/api/session`(client 역할): `plan` 포함(planStatus). `activeClientByCode` select 에 plan 열(없으면 폴백).
- 게이트(`session-gate.mjs`, 승인 파일): `activeClientForClaims` 가 `plan_expires_at` 을 함께 읽어 만료(expired/delete_due)면 제한 모드 — 허용: `/api/session`, 키워드 조회·조사·노트, public-state, home-feed, 순위 경로 GET(기록 보기). 그 외·POST 는 403 `PLAN_EXPIRED` "이용 기간이 끝났습니다. 연장 문의는 카카오톡 채널로 주세요." 수집 표는 건드리지 않는다(수집 자체는 2단계 결정).

## 4. 화면
- 광고주(`client.html`): 사이드바 로그아웃 위에 "이용 기간 · D-12 (09/19까지)" / "무기한" / 체험은 "체험 계정" 칩 그대로. D-3 이내: 하루 한 번 팝업(제목 "이용 기간이 N일 남았습니다", 만료일, "만료 후 5일 안에 연장하지 않으면 계정과 데이터가 삭제됩니다", "연장 문의는 카카오톡 채널" 버튼). 만료 후: 모든 화면 위 띠 "이용 기간이 끝났습니다 · N일 안에 연장하지 않으면 데이터가 삭제됩니다 · 연장 문의 카카오톡 채널".
- 총관리자(`admin.html` 대행사 연결 화면): 상단 검색칸(운영팀·광고주 이름·코드·구글 이메일), 각 카드에 구글 이메일 줄, 광고주 카드에 플랜 줄(플랜 · 만료일 · D-n, 만료 임박 붉게) + 기간(일) 입력 + 플랜 선택 + [오픈·연장] + 만료일 직접 지정 + [무기한], 새 카드 "무료 체험 계정"(이메일·가입일·오늘 조회) + [정식 전환](광고주명·플랜·기간·한도 입력).

## 5. 2단계 — 유예 뒤 데이터 삭제 (대표 결정 2026-09-07 "살릴 필요 없음, 서버·저장공간만 무거워짐" → 실행 승인)
- 일 1회 Vercel 크론 `/api/account-expiry-cron`(매일 03:30 KST, `Authorization: Bearer CRON_SECRET`, 세션 무관): `src/server/handlers/account-expiry-cron.mjs`. `plan_expires_at + 5일 < now` 이고 planStatus 가 `delete_due` 인 광고주(총관리자 코드 제외, 한 번에 20개)를 지운다 — 순서: naver_rank_trackers → naver_place_rank_trackers(스냅샷 FK cascade) → keyword_research_notes → login_identities(role client) → trial_keyword_quota(그 구글 sub) → clients 행(brands·reports·kpi 등 cascade, 운영팀 client_id set null) → audit_logs `client.deleted_after_grace`. 한 단계라도 실패하면 계정 행은 남겨 다음 날 재시도. `?dryRun=1` 은 대상만 보고, `MI_ACCOUNT_EXPIRY_DELETE_DISABLED=true` 면 항상 dryRun. 복구 기능은 두지 않는다.

## 6. 검증
- 단위: account-plan(planStatus 경계), super-admin-api(set-plan/open-trial), code-session-api(session.plan), session-gate(PLAN_EXPIRED). 실측: 총관리자 화면에서 체험 계정 정식 전환 → 광고주 화면 D-day 표시 → 만료일을 오늘로 지정해 팝업·띠 확인.
