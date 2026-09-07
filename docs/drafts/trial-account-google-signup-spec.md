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
- `trialAllowsPath(path)`(구현 2026-09-07): `claims.trial === 1` 이면 허용 목록만: `/api/session`, `/api/naver-keyword`, `/api/client/keyword-research`, `/api/client/keyword-notes`, `/api/client/public-state`, `/api/client/home-feed`(뉴스만 의미 있음). 그 외 403 `{ code: "TRIAL_LOCKED" }`. `/api/my/google-login` 은 허용하지 않고, 화면이 체험 세션에서는 연동 넛지를 부르지 않는다.
- `internalRequestForSession`: trial 이면 `x-mi-session-role: client`, `x-mi-agency-code: trial-xxxxxxxx`, `x-mi-session-scope: trial`.
- 하루 5회(구현): `/api/naver-keyword` GET 이고 `profile` 이 `compare` 가 아닐 때만 `mi_trial_keyword_consume(sub, limit)` 호출(REST rpc, 한도는 `MI_TRIAL_KEYWORD_DAILY_LIMIT` 기본 5). `allowed=false` → 429 `{ ok:false, code:"TRIAL_QUOTA", message:"오늘 체험 조회 5회를 모두 썼습니다. 내일 다시 열리거나, 도입 문의로 제한 없이 이용하세요.", used, limit }` + 헤더 `x-mi-trial-quota: used/limit`(화면은 이 헤더가 있으면 재시도하지 않는다). RPC 장애·설정 누락은 fail-open(막지 않음). 성공 응답에는 헤더를 싣지 않고, 화면이 `/api/session` 의 `trialQuota { used, limit, day }` 를 다시 읽어 "오늘 조회 n/5" 칩을 맞춘다. 비교 프로필·조사 API는 세지 않으며, 체험 세션의 화면은 비교 키워드의 전체 프로필 재조회(연령 보강)를 건너뛴다 — 조회 1회 = 전체 지표 조회 1건. 캐시 적중도 센다(단순화).

## 4. 라우터 (index.mjs, 잠금·승인)
- 변경 최소: `/api/google-login/start` 는 이미 무세션 공개. 추가 라우트 없음 예상. 필요 시 `/api/client/trial-status`.

## 5. public-state (client-api.mjs, 비잠금)
- `x-mi-session-scope: trial` 이면 clients 조회 없이 합성 상태 반환: `{ ok:true, client:{agency_code, name:"체험 계정", trial:true}, reports:[], ... }` — client.html 초기화가 막히지 않게.

## 6. 화면 (client.html, 비잠금 구간만)
- 세션 복원 시 `session.trial` → `secureClientSession.trial = true`.
- 체험 모드: 사이드바에 "체험 계정 · 오늘 조회 n/5" 칩. 순위 추적·플레이스·SEO·메타·보고서·매출·일정 메뉴 클릭 → 화면 대신 잠금 카드(무엇을 받는지 3줄 + 카카오·이메일 버튼). 뉴스 화면의 내 키워드 지표·순위 요약 칸 → 잠금 카드.
- 키워드 화면: 조회 응답 헤더 `x-mi-trial-quota` 로 남은 횟수 표시(`fetchKeywordData` 비잠금). 429 TRIAL_QUOTA → 상태 문구 + 문의 버튼(잠긴 runKeywordLookup 은 error.message 를 그대로 보여주므로 서버 메시지로 충분).
- 로그인 화면(구현): 기존 구글 버튼 하나를 "Google로 시작하기 · 무료 체험" 으로 바꾸고 `mode=trial` 로 시작한다. 연결된 계정(owner/team/client)은 그대로 그 역할로 로그인되고, 처음 보는 구글 계정만 체험 계정이 된다. 코드 입력은 유지. 총관리자 화면(admin.html)의 구글 버튼은 그대로(연결된 계정만).
- 잠금 카드: 순위·플레이스·SEO·메타·매출·대시보드·대행사 연결·내 캘린더 화면은 `.is-trial-locked` 로 본문을 숨기고 `mi-trial-lock` 카드(무엇이 열리는지 2~3줄 + 카카오 채널 `https://pf.kakao.com/_ixoLxfX` · 이메일 `mml93@naver.com`)를 보인다. 뉴스 화면은 내 순위 요약·내 키워드 지표·내 키워드 뉴스 칸만 잠그고, "뉴스 전체 보기" 는 안내 모달을 띄운다(서버 응답에서도 `all` 제거). 한도 초과 429 는 안내 모달 + 상태 문구.

## 7. 넛지·30일 (2단계)
- 코드 세션 로그인 시 구글 연동 넛지(재로그인마다 재표시, 연동 완료 시 영구 미표시 — 기존 정책). `clients.google_nudge_started_at` 기록 → 30일 경과 + 미연동 → 대표 지시로 삭제 배치 실행(자동 실행 금지).

## 8. 검증
- 구현 상태(2026-09-07): 서버(세션 게이트·클레임·구글 콜백·세션 API·public-state·홈 피드)와 광고주 화면 구현 완료, 단위 테스트 추가(게이트 3·클레임 2·세션 API 1·구글 5·public-state 1). 실사용 검증은 "아직 연결되지 않은 구글 계정" 으로만 가능하다 — 대표 계정은 총관리자로 연결돼 있어 체험이 아니라 총관리자 로그인이 된다.
- 단위: session-gate 테스트(trial 허용/차단 경로, 쿼터 429), code-session-api 테스트(trial 클레임·/api/session 응답), google-calendar-api 테스트(콜백 trial 생성).
- 실측: 새 구글 계정으로 가입 → 키워드 5회 → 6회째 429 문구 → 순위 메뉴 잠금 카드 → 코드 로그인 회귀 없음(광고주·운영팀·총관리자 verify).
- 게이트: 잠금 해시 3파일 갱신, check:release, verify:live.
