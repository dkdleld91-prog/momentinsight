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

### 네이버 데이터랩 API

네이버 개발자센터에서 애플리케이션을 등록하고 `데이터랩(검색어트렌드)`를 추가합니다. 월별, 요일별, 연령별 비율 조회에 필요합니다.

- `NAVER_DATALAB_CLIENT_ID`
- `NAVER_DATALAB_CLIENT_SECRET`

### 네이버 OpenAPI 쇼핑

네이버 개발자센터에서 쇼핑 검색 API를 사용할 때 필요합니다. 상품수/쇼핑 참고 지표에만 사용합니다.

- `NAVER_OPENAPI_CLIENT_ID`
- `NAVER_OPENAPI_CLIENT_SECRET`

DataLab과 OpenAPI가 같은 네이버 개발자 앱을 사용하더라도 환경변수 이름은 각각 명시해서 넣습니다. 자동 대체를 쓰면 어떤 API 키로 호출됐는지 추적이 어려워집니다.

### 네이버 플레이스 순위 수집

네이버 공식 검색 API는 플레이스 URL 또는 플레이스 ID를 기준으로 "검색 결과 몇 위인지"를 안정적으로 반환하지 않습니다. 그래서 플레이스 300위 추적은 별도 수집 서버가 필요합니다.

이 저장소에는 기본 수집 서버 골격을 `tools/naver-place-rank-collector`에 추가했습니다. 이 서버는 키워드와 플레이스 URL/ID를 받아 네이버 플레이스 검색 화면 기준으로 대상 장소를 찾고 순위를 반환합니다.

운영 연결에 필요한 환경변수는 다음 2개입니다.

- `NAVER_PLACE_RANK_API_URL`: 예) `https://your-collector.example.com/rank/naver-place`
- `NAVER_PLACE_RANK_API_KEY`: 수집 서버의 `PLACE_RANK_COLLECTOR_SECRET`와 같은 값
- `NAVER_PLACE_RANK_TIMEOUT_MS`: 권장값 `45000`

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
  - `NAVER_PLACE_PROVIDER_MAX_SCROLLS=8`
  - `NAVER_PLACE_PROVIDER_TIMEOUT_MS=30000`

Render 배포 후 Vercel Production에는 아래처럼 연결합니다.

- `NAVER_PLACE_RANK_API_URL=https://Render주소/rank/naver-place`
- `NAVER_PLACE_RANK_API_KEY=Render의 PLACE_RANK_COLLECTOR_SECRET와 동일한 값`
- `NAVER_PLACE_RANK_TIMEOUT_MS=45000`

## 현재 운영 상태 확인

```bash
npm run check:env
npm run check:env:naver
curl "https://insight.momentlabs.co.kr/api/health"
curl "https://insight.momentlabs.co.kr/api/integration-status"
curl "https://insight.momentlabs.co.kr/api/naver-keyword?keyword=냉감패드"
```

`check:env:naver`는 네이버 SearchAd, DataLab/OpenAPI, `MI_KEYWORD_API_ENABLED=true`가 없으면 실패합니다. 운영에서는 실패를 무시하지 않고 Vercel Environment Variables를 먼저 채웁니다.

## 보안 기준

- 네이버 `SECRET_KEY`, Supabase `SECRET_KEY`, access token은 HTML에 넣지 않습니다.
- 실제 키는 Vercel Environment Variables 또는 로컬 `.env.local`에만 둡니다.
- `.env.example`에는 키 이름과 예시값만 남깁니다.
- API가 실패하거나 환경변수가 없을 때 임의 검색량/비율/그래프를 만들지 않습니다.
