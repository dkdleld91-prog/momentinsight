# 네이버 플레이스 순위 자체 수집 서버

네이버 공식 검색 API는 플레이스 URL 또는 플레이스ID 기준의 순위 매칭값을 안정적으로 반환하지 않습니다.
Moment Insight 본 서비스는 이미 외부 플레이스 순위 제공자를 호출할 수 있으므로, 이 폴더는 그 제공자 역할을 하는 별도 서버입니다.

## 구조

1. Moment Insight가 `/api/naver-place-rank-trackers`에서 추적 항목을 갱신합니다.
2. 환경변수 `NAVER_PLACE_RANK_API_URL`, `NAVER_PLACE_RANK_API_KEY`가 있으면 이 수집 서버를 호출합니다.
3. 수집 서버가 네이버 플레이스 검색 화면을 열어 오가닉 결과를 읽고 대상 플레이스의 순위를 반환합니다.
4. 결과는 Supabase의 `naver_place_rank_snapshots`에 저장됩니다.

## 요청 계약

`POST /rank/naver-place`

```json
{
  "keyword": "구월동 맛집",
  "placeId": "1565776290",
  "placeUrl": "https://naver.me/FTXD0JDp",
  "placeName": "상호명",
  "maxRank": 300
}
```

헤더:

```txt
Authorization: Bearer {PLACE_RANK_COLLECTOR_SECRET}
Content-Type: application/json
```

응답:

```json
{
  "ok": true,
  "matched": true,
  "rank": 21,
  "checkedCount": 300,
  "place": {
    "id": "1565776290",
    "name": "상호명",
    "url": "https://m.place.naver.com/place/1565776290"
  },
  "topPlaces": []
}
```

## 로컬 실행

```bash
cd tools/naver-place-rank-collector
npm install
npx playwright install chromium
cp .env.example .env
npm start
```

Render/Fly/Railway 같은 외부 서버에서는 필요하면 `HOST=0.0.0.0`으로 설정합니다. 로컬 기본값은 보안을 위해 `127.0.0.1`입니다.

테스트:

```bash
curl -X POST "http://127.0.0.1:8797/rank/naver-place" \
  -H "Authorization: Bearer change-this-shared-secret" \
  -H "Content-Type: application/json" \
  -d '{"keyword":"구월동 맛집","placeUrl":"https://naver.me/FTXD0JDp","maxRank":300}'
```

## Render 호스팅 경로

가장 쉬운 경로는 이 저장소의 `render.yaml` 기준으로 Docker Web Service를 올리는 방식입니다.
현재 설정은 저장소 루트에서 Dockerfile과 build context를 직접 지정합니다.

```yaml
rootDir: tools/naver-place-rank-collector
dockerfilePath: Dockerfile
dockerContext: .
```

Render 화면에서 수동으로 만든 서비스라면 아래처럼 맞춥니다.

```txt
Root Directory=tools/naver-place-rank-collector
Runtime 또는 Environment=Docker
Docker Build Context Directory=.
Dockerfile Path=Dockerfile
Docker Command=비워두기
Health Check Path=/health
```

중요: `Root Directory`에 `tools/naver-place-rank-collector`를 넣는 방식도 가능하지만,
그 경우 `Docker Build Context Directory`는 비워두기 또는 `.`이고 `Dockerfile Path`는 `Dockerfile`이어야 합니다.
두 위치에 같은 경로를 함께 넣으면 Render가
`tools/naver-place-rank-collector/tools/naver-place-rank-collector`처럼 중복 경로를 찾다가 배포가 실패합니다.

`Environment Variables`에는 아래 값을 넣습니다.

```txt
HOST=0.0.0.0
PLACE_RANK_COLLECTOR_SECRET=직접_정한_긴_비밀값
NAVER_PLACE_PROVIDER_HEADLESS=true
NAVER_PLACE_PROVIDER_DEEP_SCAN=false
NAVER_PLACE_PROVIDER_MAX_SCROLLS=90
NAVER_PLACE_PROVIDER_TIMEOUT_MS=90000
```

Render 무료 인스턴스는 브라우저 스크롤 기반의 300위 전체 조회가 요청 제한을 넘길 수 있습니다.
`NAVER_PLACE_PROVIDER_DEEP_SCAN=false`에서는 실제 네이버 지도 목록을 한 번만 끝까지 로딩해
현재 화면이 제공한 오가닉 결과만 확인하고, 응답의 `checkedCount`에도 실제 확인한 범위만 기록합니다.
유료 인스턴스나 장시간 작업 큐를 붙인 뒤에만 `true`로 변경합니다.

8. 배포가 끝나면 Render 서비스 URL을 복사합니다.
9. `/health`를 붙여 접속했을 때 `ok:true`가 나오면 서버가 켜진 상태입니다.

예:

```txt
https://moment-place-rank-collector.onrender.com/health
```

## 운영 연결

수집 서버 배포 후 Moment Insight Vercel Production에 아래 환경변수를 추가합니다.

```txt
NAVER_PLACE_RANK_API_URL=https://your-collector.example.com/rank/naver-place
NAVER_PLACE_RANK_API_KEY=PLACE_RANK_COLLECTOR_SECRET와 동일한 값
NAVER_PLACE_RANK_TIMEOUT_MS=90000
```

예를 들어 Render URL이 `https://moment-place-rank-collector.onrender.com`이면 Vercel에는 아래처럼 넣습니다.

```txt
NAVER_PLACE_RANK_API_URL=https://moment-place-rank-collector.onrender.com/rank/naver-place
NAVER_PLACE_RANK_API_KEY=Render의 PLACE_RANK_COLLECTOR_SECRET와 동일한 값
NAVER_PLACE_RANK_TIMEOUT_MS=45000
```

## 주의

- 이 서버는 임의 순위값을 만들지 않습니다. 네이버 화면에서 확인하지 못하면 `matched:false`를 반환합니다.
- `checkedCount`는 요청한 최대 순위가 아니라 실제로 확인한 오가닉 결과 수입니다.
- 네이버 화면 구조 변경, CAPTCHA, 접속 차단이 생기면 수집 실패가 발생할 수 있습니다.
- 장기 운영에서는 이 서버를 직접 운영하거나, 같은 응답 계약을 제공하는 유료 SERP/플레이스 데이터 API로 교체하는 방식이 안정적입니다.
