# 네이버 키워드 API 연결

이 폴더는 네이버 API 키 발급과 운영 환경변수 세팅을 정리하는 문서 폴더입니다.
실제 운영 API 구현은 `src/server/handlers/naver-keyword.mjs` 하나만 사용합니다.

## 운영 경로

- 운영 엔드포인트: `/api/naver-keyword`
- 운영 연결 진단: `/api/integration-status`
- Vercel wrapper: `api/naver-keyword.mjs`
- 실제 서버 로직: `src/server/handlers/naver-keyword.mjs`
- 로컬 서버: `npm run dev:server`

오래된 별도 프록시 파일은 충돌을 막기 위해 제거했습니다. 앞으로 네이버 키워드 로직은 `src/server/handlers/naver-keyword.mjs`만 수정합니다.

## 발급해야 하는 키

### 네이버 검색광고 API

검색광고센터에서 발급합니다. 월간 검색량 조회의 기준입니다.

- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

### NAVER API Hub

2026년 6월 출시된 NAVER API Hub에서 일반 검색, 검색어 트렌드, 쇼핑 인사이트를 사용합니다. NCP 콘솔에서 Hub 애플리케이션과 사용할 API를 선택한 뒤 아래 값을 등록합니다.

- `NAVER_API_HUB_CLIENT_ID`
- `NAVER_API_HUB_CLIENT_SECRET`
- `NAVER_API_HUB_MODE=legacy`

Production은 Hub 실호출과 표본 비교가 끝날 때까지 `legacy`로 유지합니다. 검증 후 선택할 수 있는 `auto`는 Hub 키 두 값이 모두 있을 때만 새 주소와 새 인증 헤더를 사용하고, 하나라도 없으면 기존 Developers 호출을 유지합니다. 환경변수가 없거나 허용되지 않은 값이면 안전하게 `legacy`로 유지됩니다. 값이 일부만 등록된 상태에서 서로 다른 키를 섞어 호출하지 않습니다.

새 호출 규격은 다음과 같습니다.

- 기본 주소: `https://naverapihub.apigw.ntruss.com`
- 인증 헤더: `X-NCP-APIGW-API-KEY-ID`, `X-NCP-APIGW-API-KEY`
- 일반 검색: `/search/v1/*`
- 검색어 트렌드: `/search-trend/v1/search`
- 쇼핑 인사이트: `/shopping/v1/*`

### 기존 네이버 데이터랩 API

이관 검증과 비상 복귀를 위한 legacy 값입니다. 공식 유예기간 종료 전까지 검색어 트렌드와 쇼핑 인사이트의 기존 호출에 사용할 수 있습니다.

- `NAVER_DATALAB_CLIENT_ID`
- `NAVER_DATALAB_CLIENT_SECRET`

### 네이버 Developers 쇼핑 검색

상품수·상품 단건·N 30일 순위에서 사용하는 legacy 쇼핑 검색용입니다. 이 API는 NAVER API Hub 이관 대상이 아니며, 2026년 7월 31일 종료되고 공식 대체 API가 없습니다. 따라서 Hub 키를 등록해도 이 기능의 데이터 소스는 자동 교체되지 않습니다.

- `NAVER_OPENAPI_CLIENT_ID`
- `NAVER_OPENAPI_CLIENT_SECRET`

DataLab과 OpenAPI가 같은 네이버 개발자 앱을 사용하더라도 legacy 환경변수 이름은 각각 명시해서 넣습니다. Hub 키는 별도 이름으로만 보관하며 공개 HTML·로그·문서에 실제 값을 남기지 않습니다.

### 네이버 플레이스 순위 수집

네이버 공식 검색 API는 플레이스 URL 또는 플레이스 ID를 기준으로 "검색 결과 몇 위인지"를 안정적으로 반환하지 않습니다. 그래서 플레이스 300위 추적은 별도 수집 서버가 필요합니다.

이 저장소에는 기본 수집 서버 골격을 `tools/naver-place-rank-collector`에 추가했습니다. 이 서버는 키워드와 플레이스 URL/ID를 받아 네이버 플레이스 검색 화면 기준으로 대상 장소를 찾고 순위를 반환합니다.

운영 연결에 필요한 환경변수는 다음 2개입니다.

- `NAVER_PLACE_RANK_API_URL`: 예) `https://your-collector.example.com/rank/naver-place`
- `NAVER_PLACE_RANK_API_KEY`: 수집 서버의 `PLACE_RANK_COLLECTOR_SECRET`와 같은 값
- `NAVER_PLACE_RANK_TIMEOUT_MS`: 권장값 `90000`

권장 배포 위치는 Render, Fly.io, Railway, VPS처럼 Playwright 브라우저 실행이 가능한 Node 서버입니다. Vercel Hobby Functions는 브라우저 실행 시간과 용량 제약이 있어 플레이스 수집 서버에는 맞지 않습니다.

Moment Insight 본 서버는 위 URL로 POST 요청만 보냅니다. 따라서 수집 서버를 별도로 운영해도 기존 키워드 조회, 상품 순위, 보고서 기능과 충돌하지 않습니다.

가장 쉬운 Render 설정값은 아래와 같습니다.

- Web Service 생성
- Root Directory: `tools/naver-place-rank-collector`
- Runtime: `Docker`
- Environment Variables:
  - `HOST=0.0.0.0`
  - `PLACE_RANK_COLLECTOR_SECRET=직접 정한 긴 비밀값`
  - `NAVER_PLACE_PROVIDER_HEADLESS=true`
  - `NAVER_PLACE_PROVIDER_MAX_SCROLLS=90`
  - `NAVER_PLACE_PROVIDER_TIMEOUT_MS=90000`

Render 배포 후 Vercel Production에는 아래처럼 연결합니다.

- `NAVER_PLACE_RANK_API_URL=https://Render주소/rank/naver-place`
- `NAVER_PLACE_RANK_API_KEY=Render의 PLACE_RANK_COLLECTOR_SECRET와 동일한 값`
- `NAVER_PLACE_RANK_TIMEOUT_MS=90000`

## 현재 운영 상태 확인

```bash
npm run check:env
npm run check:env:naver
curl "https://insight.momentlabs.co.kr/api/health"
curl "https://insight.momentlabs.co.kr/api/integration-status"
curl "https://insight.momentlabs.co.kr/api/naver-keyword?keyword=냉감패드"
```

`check:env:naver`는 네이버 SearchAd, Hub 또는 legacy DataLab, 종료 전까지 필요한 legacy 쇼핑 검색, `MI_KEYWORD_API_ENABLED=true`가 없으면 실패합니다. 운영에서는 실패를 무시하지 않고 Vercel Environment Variables를 먼저 채웁니다.

안전한 Hub 전환 순서는 Production을 `legacy`로 고정 → Hub 키 등록 → `/api/integration-status`의 `naverApiHubMigration.ready=true` 확인 → Preview/로컬에서 `hub`로 검색어 트렌드·쇼핑 인사이트·blog/local 표본 비교 → 오류 0건 확인 → Production을 `auto` 또는 `hub`로 전환하는 방식입니다. Hub 콘솔의 API 선택 또는 키 권한이 빠지면 401/403이므로 즉시 키·권한을 점검하고, 존재하지 않거나 종료된 경로의 404/410을 임의 데이터로 대체하지 않습니다. 429는 호출 제한으로 분류해 재시도 간격과 사용량을 확인합니다.

## 보안 기준

- 네이버 `SECRET_KEY`, Supabase `SECRET_KEY`, access token은 HTML에 넣지 않습니다.
- 실제 키는 Vercel Environment Variables 또는 로컬 `.env.local`에만 둡니다.
- `.env.example`에는 키 이름과 예시값만 남깁니다.
- API가 실패하거나 환경변수가 없을 때 임의 검색량/비율/그래프를 만들지 않습니다.
