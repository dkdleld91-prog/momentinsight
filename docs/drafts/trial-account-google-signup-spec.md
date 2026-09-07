# 구글 가입 체험 계정 — 구현 사양 (2026-09-07 대표 승인)

대표 결정: 구글 로그인(회원가입) → 체험 역할(키워드 조회만, 하루 5회) → 순위 추적·내 키워드 뉴스 등은 잠금 카드 + 카카오/이메일 문의. 기존 코드 계정은 구글 연동 넛지 30일 → 미연동 삭제 → 이후 전부 구글 로그인. 공개 /news 는 플랫폼별 3건 미리보기(완료), 7일치 전체는 로그인 후(완료).

승인된 잠긴 파일: `src/server/session-gate.mjs`, `src/server/index.mjs`, `src/server/handlers/naver-keyword.mjs`(필요 시). 순위 수집 코드는 무접촉. 잠금 해시는 배포 전 갱신.

## 1. 데이터
- `login_identities` 재사용: role = `trial`, code = google_sub (유니크 (role, code) 그대로 만족). google_email 저장.
- 신규 표 `trial_keyword_quota(google_sub text, day date, used int, primary key(google_sub, day))` + RPC `mi_trial_keyword_consume(p_sub text, p_limit int) returns (allowed bool, used int)` — 원자적 upsert 증가, security definer, service_role 전용. 마이그레이션 파일명에 naver_rank/naver_shopping 문구 금지(잠금 집계 회피).

## 2. 로그인 흐름 (google-calendar-api.mjs, 비잠금)
- 광고주 로그인 화면 버튼 "구글로 시작하기 · 무료 체험" → `/api/google-login/start?mode=trial&persist=1` (state 에 mode 포함).
- 콜백: identity 없음 + mode=trial → `upsertLoginIdentity({role:"trial", code:sub, email})` → 세션 발급. identity 있고 role=trial → 그대로 세션 발급. identity 가 client/team/owner 로 연결된 계정이면 기존 흐름(해당 역할 세션).
- 세션 클레임(코드 세션과 같은 형태로 client 화면이 그대로 동작): `{ role: "client", clientId: null, agencyCode: "trial-" + sub앞8자, trial: true, googleSub: sub }`.
- `/api/session` 응답: `session.role = "client"`, `session.trial = true`, `client = { agency_code, name: "체험 계정", trial: true }` (client.html 의 `payload.session.role !== "client" || !payload.client` 검사 통과).

## 3. 세션 게이트 (session-gate.mjs, 잠금·승인)
- `sessionActivityState`: `claims.trial` 이면 `login_identities`(role=trial, code=sub) 존재 확인 → active. 없으면 revoked.
- `roleAllowsPath(role, path, claims)`: `claims.trial` 이면 허용 목록만: `/api/session`, `/api/naver-keyword`, `/api/client/keyword-research`, `/api/client/keyword-notes`, `/api/client/public-state`, `/api/client/home-feed`(뉴스만 의미 있음), `/api/my/google-login`. 그 외 403 `{ code: "TRIAL_LOCKED" }`.
- `internalRequestForSession`: trial 이면 `x-mi-session-role: client`, `x-mi-agency-code: trial-xxxxxxxx`, `x-mi-session-scope: trial`.
- 하루 5회: `/api/naver-keyword` 이고 profile 이 full(또는 없음)일 때만 `mi_trial_keyword_consume(sub, 5)` 호출(REST rpc). `allowed=false` → 429 `{ ok:false, code:"TRIAL_QUOTA", message:"오늘 체험 조회 5회를 모두 썼습니다. 내일 다시 열리거나, 도입 문의로 제한 없이 이용하세요.", used, limit }`. 성공 시 응답 헤더 `x-mi-trial-quota: used/5`. 비교 프로필·조사 API·캐시 적중은 세지 않음(캐시 적중 판단은 핸들러 안이라 게이트에서는 모두 셈 — 단순화; 필요 시 naver-keyword.mjs 에서 캐시 적중 시 헤더로 알려 게이트가 되돌림).

## 4. 라우터 (index.mjs, 잠금·승인)
- 변경 최소: `/api/google-login/start` 는 이미 무세션 공개. 추가 라우트 없음 예상. 필요 시 `/api/client/trial-status`.

## 5. public-state (client-api.mjs, 비잠금)
- `x-mi-session-scope: trial` 이면 clients 조회 없이 합성 상태 반환: `{ ok:true, client:{agency_code, name:"체험 계정", trial:true}, reports:[], ... }` — client.html 초기화가 막히지 않게.

## 6. 화면 (client.html, 비잠금 구간만)
- 세션 복원 시 `session.trial` → `secureClientSession.trial = true`.
- 체험 모드: 사이드바에 "체험 계정 · 오늘 조회 n/5" 칩. 순위 추적·플레이스·SEO·메타·보고서·매출·일정 메뉴 클릭 → 화면 대신 잠금 카드(무엇을 받는지 3줄 + 카카오·이메일 버튼). 뉴스 화면의 내 키워드 지표·순위 요약 칸 → 잠금 카드.
- 키워드 화면: 조회 응답 헤더 `x-mi-trial-quota` 로 남은 횟수 표시(`fetchKeywordData` 비잠금). 429 TRIAL_QUOTA → 상태 문구 + 문의 버튼(잠긴 runKeywordLookup 은 error.message 를 그대로 보여주므로 서버 메시지로 충분).
- 로그인 화면: "구글로 시작하기 · 무료 체험" 버튼 추가(코드 입력 유지).

## 7. 넛지·30일 (2단계)
- 코드 세션 로그인 시 구글 연동 넛지(재로그인마다 재표시, 연동 완료 시 영구 미표시 — 기존 정책). `clients.google_nudge_started_at` 기록 → 30일 경과 + 미연동 → 대표 지시로 삭제 배치 실행(자동 실행 금지).

## 8. 검증
- 단위: session-gate 테스트(trial 허용/차단 경로, 쿼터 429), code-session-api 테스트(trial 클레임·/api/session 응답), google-calendar-api 테스트(콜백 trial 생성).
- 실측: 새 구글 계정으로 가입 → 키워드 5회 → 6회째 429 문구 → 순위 메뉴 잠금 카드 → 코드 로그인 회귀 없음(광고주·운영팀·총관리자 verify).
- 게이트: 잠금 해시 3파일 갱신, check:release, verify:live.
