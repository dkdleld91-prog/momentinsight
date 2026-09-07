# 총관리자 "오늘 현황" 카드 — 구현 사양 (2026-09-07 대표 지시 "오늘 방문 n명 · 가입 n명 구현합시다")

## 결정
- 구글 애널리틱스(GA4, G-J4TPHH3BZE)는 그대로 둔다(상세 분석용). 총관리자 화면에 바로 뜨는 숫자는 우리 표 `site_events` 에서 만든다 — GA API 키 연결(서비스 계정·권한 부여) 없이 SQL 한 번으로 끝난다.
- 개인 식별 정보는 저장하지 않는다. 방문자 = sha256(세션 비밀 + 날짜 + IP + 브라우저) 앞 32자(날이 바뀌면 다른 값), 로그인 = sha256(역할 + 코드).

## 1. 데이터 (`supabase/migrations/20260907213000_site_events.sql`, 대표가 SQL Editor 실행 → `notify pgrst, 'reload schema';`)
- `site_events(day, event, path, visitor, created_at)` PK (day, event, path, visitor) → 같은 방문자의 같은 날 같은 경로는 한 번만.
- RPC `mi_site_event_record(day, event, path, visitor)` insert on conflict do nothing · `mi_site_event_summary(day)` → json {visitors, views, signup_clicks, inquiry_clicks, logins} · `mi_site_event_prune(keep_days=120)`.
- 서비스 롤만 접근(RLS on, anon/authenticated 권한 없음).

## 2. 서버
- `src/server/handlers/site-events.mjs`: `POST /api/site-event {event, path}` — 세션·CSRF 없음(SESSION_FREE_PATHS), 로봇 UA·이상 경로·2KB 초과·login 이벤트는 버림, 무조건 204. `recordLoginEvent(ctx, {role, code})` 는 코드 로그인(code-session-api)·구글 로그인(google-calendar-api) 성공 직후 호출(최대 1초 대기, 실패해도 로그인 그대로). `siteSummary(ctx)` → 오늘·어제 + 체험 가입(login_identities role=trial, linked_at 그 날) + 정리 RPC.
- 총관리자 API: `GET /api/super-admin-agency-codes?view=site-summary`(총관리자 인증 뒤) → siteSummary. 표가 없으면 `pending:true` + 마이그레이션 안내 문구.
- 라우팅 `src/server/index.mjs`(잠금 해시 갱신) · 게이트 `src/server/session-gate.mjs`(잠금 해시 갱신).

## 3. 화면
- `public/mi-analytics.js`(홈·/news·/privacy 에만 포함): 페이지 로드 시 `view`, 카카오/이메일 문의 클릭 `inquiry_click`, 무료 체험 가입 클릭 `signup_click` 을 `navigator.sendBeacon` 으로 보낸다. 로그인 안쪽 화면에는 넣지 않는다(기존 원칙).
- `src/pages/admin.html` 대행사 연결 화면 맨 위 "오늘 현황" 카드: 방문(고유) · 가입 클릭 · 문의 클릭 · 체험 가입 · 로그인 계정, 각 칸 아래 "어제 n" 비교. 계정 목록을 불러올 때 함께 읽고 [새로고침] 버튼 있음.

## 4. 한계(정직하게)
- 방문 수는 로봇 UA 를 걸러도 GA 보다 많이 나올 수 있다(GA 는 더 정교하게 거른다). 상세는 GA 에서 본다.
- 같은 사람이 와이파이→LTE 로 바꾸면 다른 방문자로 센다(IP 기반). 쿠키를 쓰지 않기로 한 대가다.
- 마이그레이션 전에는 카드가 "집계 표가 아직 없습니다"를 보이고 0 으로 나온다.
