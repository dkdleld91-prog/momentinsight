# Supabase 연결 설정

이 폴더는 모먼트 인사이트에서 Supabase를 붙일 때 쓰는 기본 연결 설정입니다.

## 현재 입력된 값

- Supabase URL: `https://unjduaxhykcrlotprsie.supabase.co`
- Publishable key: `.env.local`에 저장
- Secret key: `.env.local`에 저장

`publishable` 키는 브라우저에서 사용할 수 있는 공개용 키입니다. 다만 공개용 키라고 해서 아무 데이터나 열어도 된다는 뜻은 아닙니다. 실제 보안은 Supabase의 RLS(Row Level Security) 정책으로 강제해야 합니다.

`secret` 키는 서버 전용 관리자 키입니다. 이 키는 RLS를 우회할 수 있으므로 아임웹 HTML, 브라우저 스크립트, 공개 저장소에 절대 넣지 않습니다.

## @supabase/server 설정

프로젝트 루트에 `@supabase/server`와 `@supabase/supabase-js`를 설치했습니다.

```bash
npm install
npm run check:env
npm run check:supabase
npm run check:server
npm run check:admin-api
npm run dev:server
```

로컬 API 서버:

```text
http://127.0.0.1:8790
```

추가된 핸들러:

```text
GET /health
GET /api/health
GET /api/client/:resource
POST /api/client/agency-code/connect
GET /api/admin/:resource
POST /api/admin/:resource
PATCH /api/admin/:resource/:id
DELETE /api/admin/:resource/:id
POST /api/admin/storage/signed-upload
```

Supabase Edge Function:

```text
supabase/functions/moment-api/index.ts
```

배포 대상 URL:

```text
https://unjduaxhykcrlotprsie.supabase.co/functions/v1/moment-api
```

로컬 서버는 `/health`, Vercel 배포본은 `/api/health`로 상태를 확인합니다. `/api/health`의 `readiness.supabaseReady`가 `true`여야 Supabase 기반 API를 정상 운영할 수 있습니다.

`/health`는 secret 없이도 상태 확인이 가능하도록 fallback 처리되어 있습니다. secret key가 들어간 상태라면 `withSupabase({ auth: "none" })` 경로에서도 서버 컨텍스트가 생성됩니다.

핸들러 위치:

```text
src/server/handlers/health.mjs
src/server/handlers/dashboard.mjs
src/server/handlers/admin-clients.mjs
```

`dashboard.mjs`는 `withSupabase({ auth: "user" })`를 사용합니다. 사용자의 JWT가 있어야 하고, `ctx.supabase`는 RLS가 적용된 클라이언트입니다.

`admin-clients.mjs`는 `withSupabase({ auth: "secret" })`를 사용합니다. `SUPABASE_SECRET_KEY`가 있어야 하고, `ctx.supabaseAdmin`은 RLS를 우회합니다. 이 키는 절대 아임웹이나 브라우저 코드에 넣으면 안 됩니다.

`auth: "secret"` API는 호출자가 `Authorization: Bearer`가 아니라 `apikey` 헤더에 secret key를 보내야 합니다.

```http
apikey: sb_secret_...
```

## 백엔드 API 구조

관리자 API는 서버 전용 secret key로만 호출합니다.

```text
GET    /api/admin/overview?client_id=...

GET    /api/admin/clients
POST   /api/admin/clients
PATCH  /api/admin/clients/:id
DELETE /api/admin/clients/:id

GET    /api/admin/dashboard-snapshots
POST   /api/admin/dashboard-snapshots

GET    /api/admin/kpi-targets
POST   /api/admin/kpi-targets

GET    /api/admin/kpi-results
POST   /api/admin/kpi-results

GET    /api/admin/ad-performance
POST   /api/admin/ad-performance

GET    /api/admin/reports
POST   /api/admin/reports

GET    /api/admin/schedule-items
POST   /api/admin/schedule-items

GET    /api/admin/action-plans
POST   /api/admin/action-plans

GET    /api/admin/keywords
POST   /api/admin/keywords

GET    /api/admin/keyword-metrics
POST   /api/admin/keyword-metrics

POST   /api/admin/storage/signed-upload
```

광고주 API는 로그인 JWT와 Supabase RLS 기준으로 조회합니다.

```text
GET /api/client/overview
GET /api/client/me
GET /api/client/dashboard
GET /api/client/brands
GET /api/client/ad-performance
GET /api/client/kpi-targets
GET /api/client/kpi-results
GET /api/client/reports
GET /api/client/files
GET /api/client/schedule-items
GET /api/client/action-plans
GET /api/client/keywords
GET /api/client/keyword-metrics
POST /api/client/agency-code/connect
```

대행사 코드 연결 요청 예시:

```json
{
  "agency_code": "MI-DEMO-01"
}
```

Storage signed upload 요청 예시:

```json
{
  "bucket": "moment-reports",
  "path": "clients/{client_id}/reports/2026-06-weekly.pdf"
}
```

로컬 테스트 URL:

```text
http://127.0.0.1:8790
```

Supabase 배포 후 URL:

```text
https://unjduaxhykcrlotprsie.supabase.co/functions/v1/moment-api
```

## 지금 가능한 것

- 아임웹 화면에서 Supabase 클라이언트 초기화
- RLS가 허용한 공개/광고주 범위 데이터 조회
- 로그인 적용 후 사용자 세션 기반 조회
- `@supabase/server` 기반 request handler 구조
- publishable key 유효성 확인

## 아직 하면 안 되는 것

- Secret key를 아임웹 HTML에 넣기
- RLS 없이 광고주 데이터를 브라우저에서 직접 조회하기
- 관리자용 원천 데이터 입력을 브라우저 키만으로 처리하기

관리자 입력, 공개 승인, 보고서 업로드처럼 권한이 필요한 기능은 백엔드 API 또는 Supabase Edge Function을 통해 처리하는 구조가 맞습니다.

## 아임웹 연결 흐름

```text
아임웹 화면
→ Supabase publishable key로 클라이언트 생성
→ 로그인 세션 확인
→ RLS가 허용한 데이터만 조회
```

관리자 권한 작업은 아래 구조가 맞습니다.

```text
아임웹 관리자 화면
→ 백엔드 API / Supabase Edge Function
→ secret key 또는 서버 세션으로 검증
→ DB 저장 / 공개 승인 / 파일 업로드
```

## 필요한 환경변수

```env
SUPABASE_URL=https://unjduaxhykcrlotprsie.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_JWKS_URL=https://unjduaxhykcrlotprsie.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_SECRET_KEY=sb_secret_...
```

현재 `.env.local`에는 publishable key, JWKS URL, secret key가 저장되어 있습니다. `.env.local`은 로컬 전용 파일로 유지하고 공개 저장소에 올리지 않습니다.

## DB 스키마 적용

관리자 API가 실제 데이터를 읽으려면 Supabase DB에 MVP 테이블을 먼저 만들어야 합니다.

마이그레이션 파일:

```text
supabase/migrations/20260623003000_moment_insight_mvp.sql
```

Supabase Dashboard의 SQL Editor에서 위 SQL을 실행하면 다음 테이블이 생성됩니다.

```text
clients
brands
client_members
channels
dashboard_snapshots
kpi_targets
kpi_results
ad_performance
keywords
keyword_metrics
reports
files
schedule_items
action_plans
comments
audit_logs
```

파일 저장 버킷도 함께 준비됩니다.

```text
moment-reports
moment-assets
```

테스트 데이터 파일:

```text
supabase/seed.sql
```

이 파일은 선택 사항입니다. 화면 확인용 데모 광고주, 대시보드, 보고서, 일정, 액션 플랜을 넣을 때만 실행합니다.

적용 후 확인:

```bash
npm run check:server
npm run check:admin-api
```

정상 적용 전에는 `public.clients` 테이블을 찾을 수 없다는 응답이 나올 수 있습니다. 이는 키 문제가 아니라 DB 테이블 미생성 상태입니다.

## 배포 명령

DB 마이그레이션 적용:

```bash
npm run supabase:db:push
```

샘플 데이터 적용:

```text
Supabase Dashboard → SQL Editor → supabase/seed.sql 내용 실행
```

주의: `seed.sql`은 화면 확인용 데모 데이터입니다. 실제 광고주 데이터가 들어간 뒤에는 운영 데이터와 섞이지 않게 실행하지 않습니다.

Edge Function 배포:

```bash
npm run supabase:functions:deploy
```

전체 배포:

```bash
npm run deploy:backend
```

배포 API 확인:

```bash
npm run check:edge-api
```

현재 Codex MCP 연결은 `read_only=false`로 바꿔두었습니다. 다만 현재 세션에 Supabase 쓰기 도구가 직접 노출되지 않으면, 위 명령 또는 Supabase SQL Editor를 통해 적용해야 합니다.

## Supabase Edge Functions 참고

Supabase Edge Functions에서 `auth: "publishable"`, `auth: "secret"`, `auth: "none"`를 쓰는 함수는 플랫폼 JWT 검증을 꺼야 합니다.

```toml
[functions.moment-health]
verify_jwt = false

[functions.moment-admin-clients]
verify_jwt = false
```

이 설정은 `supabase/config.toml`에 추가해두었습니다.

## 검증 결과

`/auth/v1/settings` endpoint 기준으로 현재 publishable key는 HTTP 200 응답을 반환했습니다.
