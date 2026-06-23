# 네이버 키워드 API 연결

이 폴더는 모먼트 인사이트 키워드 조회 화면을 네이버 검색 기반 API와 연결하는 백엔드 프록시입니다.

## 가능한 것

- 네이버 검색광고 API로 월간 PC/모바일 검색수, 클릭수, 클릭률, 경쟁도, 연관 키워드 조회
- 네이버 데이터랩 API로 월별 추이, 성별/연령별 비율, 최근 28일 기준 요일별 추이 계산
- 아임웹 HTML에서 비밀키를 노출하지 않고 백엔드만 네이버 API 호출

## 불가능한 것

- 네이버 API 키 없이 실제 검색량 조회
- 아임웹 HTML 안에 `SECRET_KEY`를 넣는 방식
- 데이터랩 API만으로 절대 검색량 확인

## 실행

```bash
cd "/Users/sindongbin/Documents/모먼트 인사이트"
cp "05_네이버_API_연동/.env.example" "05_네이버_API_연동/.env"
```

`.env`에 네이버 키를 입력한 뒤:

```bash
set -a
source "05_네이버_API_연동/.env"
set +a
node "05_네이버_API_연동/naver-keyword-proxy.mjs"
```

상태 확인:

```bash
curl "http://127.0.0.1:8787/health"
```

키워드 조회:

```bash
curl "http://127.0.0.1:8787/api/naver-keyword?keyword=비타민%20앰플"
```

## 발급해야 하는 키

### 네이버 검색광고 API

검색광고센터에서 발급합니다.

- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

### 네이버 데이터랩 API

네이버 개발자센터에서 애플리케이션을 등록하고 `데이터랩(검색어트렌드)`를 추가합니다.

- `NAVER_DATALAB_CLIENT_ID`
- `NAVER_DATALAB_CLIENT_SECRET`

## 화면 연결

아임웹 HTML은 기본으로 아래 URL을 호출합니다.

```txt
http://127.0.0.1:8787/api/naver-keyword
```

실제 배포 시에는 페이지 상단이나 아임웹 공통 코드에 아래처럼 운영 API 주소를 넣으면 됩니다.

```html
<script>
  window.MI_NAVER_KEYWORD_API_URL = "https://api.your-domain.com/api/naver-keyword";
</script>
```

