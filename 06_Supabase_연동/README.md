# Supabase DB·인증 연결

Supabase는 모먼트 인사이트의 PostgreSQL DB, 인증, Storage로만 사용합니다. 운영 API는 `src/server`의 Vercel 백엔드 한 경로를 사용하며 브라우저가 Secret key로 DB를 직접 호출하지 않습니다.

## 표준 경로

| 역할 | 경로 |
| --- | --- |
| 서버 API | `src/server` |
| Vercel 공용 진입점 | `api/[...path].mjs` |
| DB 마이그레이션 | `supabase/migrations` |
| 선택형 데모 데이터 | `supabase/seed.sql` |
| 환경·연결 점검 | `06_Supabase_연동/check-supabase.mjs` |
| 관리자 API 점검 | `06_Supabase_연동/check-admin-api.mjs` |

운영 API는 `src/server`와 Vercel 공용 진입점만 사용합니다. 배포·검증도 이 단일 경로를 기준으로 수행합니다.

## 환경변수와 보안

- `SUPABASE_URL`: 프로젝트 URL
- `SUPABASE_PUBLISHABLE_KEY`: 브라우저에서 사용 가능한 공개 키
- `SUPABASE_SECRET_KEY`: 서버 전용 비밀 키
- `SUPABASE_JWKS_URL`: 서버 세션 검증용 JWKS

실제 값은 루트 `.env.local` 또는 Vercel Environment Variables에만 저장합니다. Secret key는 RLS를 우회할 수 있으므로 HTML, 브라우저 스크립트, 공개 저장소, 요청 헤더 예시에 넣지 않습니다. 서버는 로그인 세션과 역할 범위를 검증한 뒤 필요한 작업만 수행합니다.

## 로컬 점검

```bash
npm run check:env
npm run check:supabase
npm run check:server
npm run check:admin-api
npm run dev:server
```

로컬 API는 `http://127.0.0.1:8790`, 운영 API는 `https://insight.momentlabs.co.kr/api`입니다. 상태 확인은 `/api/health`와 `/api/ready`를 사용합니다.

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

운영 API URL:

```text
https://insight.momentlabs.co.kr/api
```

## 지금 가능한 것

- 로그인 세션과 역할 범위에 따른 운영팀·광고주 데이터 조회
- Vercel 서버에서만 Secret key를 사용하는 관리자 작업
- RLS가 적용된 광고주 범위 조회
- 서버 API를 통한 데이터 입력·공개 승인·파일 업로드

## 아직 하면 안 되는 것

- Secret key를 HTML 또는 브라우저 JavaScript에 넣기
- RLS 없이 광고주 데이터를 브라우저에서 직접 조회하기
- 관리자용 원천 데이터 입력을 브라우저 키만으로 처리하기
- 운영 백엔드를 다른 런타임에 중복 배포하기

## 표준 요청 흐름

```text
관리자·운영팀·광고주 화면
→ Vercel API
→ 로그인 세션·역할·광고주 범위 검증
→ 서버 전용 Supabase 클라이언트
→ DB 저장 / 공개 승인 / 파일 업로드
```

## 필요한 환경변수

```env
SUPABASE_URL=https://unjduaxhykcrlotprsie.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_JWKS_URL=https://unjduaxhykcrlotprsie.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_SECRET_KEY=sb_secret_...
```

실제 값은 `.env.local` 또는 Vercel Environment Variables에서만 관리합니다. `.env.local`은 로컬 전용 파일로 유지하고 공개 저장소에 올리지 않습니다.

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

## DB 적용과 서버 배포

DB 마이그레이션 적용:

```bash
npm run supabase:db:push
```

샘플 데이터 적용:

```text
Supabase Dashboard → SQL Editor → supabase/seed.sql 내용 실행
```

주의: `seed.sql`은 화면 확인용 데모 데이터입니다. 실제 광고주 데이터가 들어간 뒤에는 운영 데이터와 섞이지 않게 실행하지 않습니다.

서버 릴리스 검사:

```bash
npm run check:release
```

Vercel Production 배포는 현재 승인과 릴리스 검사 통과 뒤에만 진행합니다. Supabase 마이그레이션과 Vercel 배포는 서로 다른 작업이므로 한 명령으로 묶지 않습니다.
