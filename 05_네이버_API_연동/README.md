# 네이버 키워드 API 연결

이 폴더는 네이버 API 키 발급과 운영 환경변수 세팅을 정리하는 문서 폴더입니다.
공식 Hub 호출과 쇼핑 결과 수집은 각각 하나의 공용 계약으로 관리합니다.

## 운영 경로

- 운영 엔드포인트: `/api/naver-keyword`
- 운영 연결 진단: `/api/integration-status`
- Vercel 공용 진입점: `api/[...path].mjs`
- 키워드 서버 로직: `src/server/handlers/naver-keyword.mjs`
- 쇼핑 참고·순위 서버 로직: `src/server/handlers/naver-shopping-rank.mjs`
- 쇼핑 수집원 상태·장애 판정: `src/server/naver-shopping/source-status.mjs`
- 쇼핑 수집 구조 안내: `src/server/naver-shopping/README.md`
- 쇼핑 브라우저 수집기: `tools/naver-shopping-rank-collector`
- 서명된 300위 로컬 워커: `scripts/naver-shopping-local-worker.mjs`
- 로컬 서버: `npm run dev:server`

로컬 개발은 루트 `.env.local`을 가장 먼저 읽고, 기능 폴더의 `.env.local`은 호환용 보조 파일로만 사용합니다. 같은 키가 중복되면 루트 값이 우선합니다.

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
- `NAVER_API_HUB_MODE=hub`

Production은 `hub`로 고정합니다. Hub 키가 불완전하거나 모드가 다르면 배포 검사를 실패시켜 기존 Developers 경로로 조용히 되돌아가지 않습니다.

새 호출 규격은 다음과 같습니다.

- 기본 주소: `https://naverapihub.apigw.ntruss.com`
- 인증 헤더: `X-NCP-APIGW-API-KEY-ID`, `X-NCP-APIGW-API-KEY`
- 일반 검색: `/search/v1/*`
- 검색어 트렌드: `/search-trend/v1/search`
- 쇼핑 인사이트: `/shopping/v1/*`

### 네이버 쇼핑 참고·상품 순위 수집

종료된 네이버 Developers 쇼핑 검색 API는 활성 경로나 fallback으로 사용하지 않습니다. 기본 운영은 서버에서 빠르게 확인되는 상단 오가닉 범위와, 전용 Mac에서 실행되는 서명된 300위 워커를 분리한 이중 구조입니다.

- `NAVER_SHOPPING_RANK_MODE=hybrid_local_worker`
- `MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED=true`
- `MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET` (32바이트 이상, Vercel과 Mac Keychain에 동일하게 저장)
- `MI_NAVER_SHOPPING_PROVIDER_TIMEOUT_MS` (기본 90초)

로컬 워커는 HMAC 서명·5분 유효시간·1회용 nonce로 서버에 접속하고 다음 300위 요청 계약을 사용합니다.

```json
{
  "schemaVersion": "mi.naver-shopping-organic-window.v1",
  "keyword": "온열찜질기",
  "limit": 300,
  "sort": "relevance",
  "rankPolicy": "organic_only",
  "deadlineAt": "2026-08-01T06:00:00.000Z"
}
```

응답은 반드시 `source=naver_shopping_results_collector`, `rankEvidence=naver_shopping_organic_list`, `collectionId`, `collectedAt`, `checkedCount=300`, 배열형 `items`를 포함해야 합니다. 광고·중복·순위 공백·299개 이하 응답은 전부 거부하고 마지막 정상 순위와 30일 이력을 보존합니다. 성공 결과는 tracker와 snapshot을 하나의 DB 원자 처리로 반영하며 같은 `collectionId` 재전송은 중복 저장되지 않습니다.

`NAVER_SHOPPING_RANK_MODE`는 생략하거나 오타를 내면 실패하도록 고정합니다. 즉시 조회 경로는 네이버 통합검색 모바일의 SAS 상품 중 1위부터 연속 확인된 최대 상위 50위까지만 exact ID를 인정합니다. 범위 밖 미발견은 `없음`으로 저장하지 않습니다. 09시·15시에는 로컬 워커가 우선 처리하고, 서명 워커 활동이 확인되지 않을 때만 서버 fallback이 기존값 보존 방식으로 실행됩니다.

별도 검증된 300위 공급자가 생긴 경우에만 `provider` 모드와 URL/key 쌍을 대안으로 사용할 수 있습니다. Hub 키를 이 위치에 넣지 않습니다.

NAVER API Hub의 Search, Search Trend, Shopping Insight는 키워드 통계용입니다. 종료된 쇼핑 상품검색/상품순위 API의 대체물이 아니므로 Hub 키를 상품 순위 URL/key 위치에 넣지 않습니다.

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

Production 배포 검사는 네이버 SearchAd, Hub 키 쌍, `NAVER_API_HUB_MODE=hub`, 서명 워커 설정, 최근 실제 300위 snapshot, cron 비밀값과 `MI_KEYWORD_API_ENABLED=true`를 요구합니다. 운영에서는 실패를 무시하지 않습니다.

안전한 운영 검증 순서는 Hub blog/local·검색어 트렌드·쇼핑 인사이트 실호출 확인 → 서명 워커 claim/submit 확인 → 정확 상품·원부·광고 제외 300위 확인 → 중복 저장 차단·실패 시 기존값 보존 → 전체 갱신과 cron 2회 확인입니다. `/api/integration-status`는 로그인 세션에서 `naverApiHubMigration.ready=true`와 `shoppingReferenceAndRank.ready=true`를 모두 확인합니다. Hub 401/403, 호출 제한 429, 수집 실패를 임의 데이터로 대체하지 않습니다.

## 보안 기준

- 네이버 `SECRET_KEY`, Supabase `SECRET_KEY`, access token은 HTML에 넣지 않습니다.
- 실제 키는 Vercel Environment Variables 또는 로컬 `.env.local`에만 둡니다.
- `.env.example`에는 키 이름과 예시값만 남깁니다.
- API가 실패하거나 환경변수가 없을 때 임의 검색량/비율/그래프를 만들지 않습니다.
