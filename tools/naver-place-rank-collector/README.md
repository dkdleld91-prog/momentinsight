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

가장 쉬운 경로는 Render에 Docker Web Service로 올리는 방식입니다.

1. Render 접속 후 `New +`를 누릅니다.
2. `Web Service`를 선택합니다.
3. GitHub 저장소 `dkdleld91-prog/momentinsight`를 연결합니다.
4. `Root Directory`에 아래 값을 넣습니다.

```txt
tools/naver-place-rank-collector
```

5. `Runtime` 또는 `Environment`는 `Docker`로 선택합니다.
6. `Environment Variables`에 아래 값을 넣습니다.

```txt
HOST=0.0.0.0
PLACE_RANK_COLLECTOR_SECRET=직접_정한_긴_비밀값
NAVER_PLACE_PROVIDER_HEADLESS=true
NAVER_PLACE_PROVIDER_MAX_SCROLLS=8
NAVER_PLACE_PROVIDER_TIMEOUT_MS=30000
```

7. 배포가 끝나면 Render 서비스 URL을 복사합니다.
8. `/health`를 붙여 접속했을 때 `ok:true`가 나오면 서버가 켜진 상태입니다.

예:

```txt
https://moment-place-rank-collector.onrender.com/health
```

## 운영 연결

수집 서버 배포 후 Moment Insight Vercel Production에 아래 환경변수를 추가합니다.

```txt
NAVER_PLACE_RANK_API_URL=https://your-collector.example.com/rank/naver-place
NAVER_PLACE_RANK_API_KEY=PLACE_RANK_COLLECTOR_SECRET와 동일한 값
NAVER_PLACE_RANK_TIMEOUT_MS=45000
```

예를 들어 Render URL이 `https://moment-place-rank-collector.onrender.com`이면 Vercel에는 아래처럼 넣습니다.

```txt
NAVER_PLACE_RANK_API_URL=https://moment-place-rank-collector.onrender.com/rank/naver-place
NAVER_PLACE_RANK_API_KEY=Render의 PLACE_RANK_COLLECTOR_SECRET와 동일한 값
NAVER_PLACE_RANK_TIMEOUT_MS=45000
```

## 주의

- 이 서버는 임의 순위값을 만들지 않습니다. 네이버 화면에서 확인하지 못하면 `matched:false`를 반환합니다.
- 네이버 화면 구조 변경, CAPTCHA, 접속 차단이 생기면 수집 실패가 발생할 수 있습니다.
- 장기 운영에서는 이 서버를 직접 운영하거나, 같은 응답 계약을 제공하는 유료 SERP/플레이스 데이터 API로 교체하는 방식이 안정적입니다.
