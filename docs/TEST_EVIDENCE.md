# Test Evidence

## 2026-07-14 · 써큘레이터 원부 누락 원인 및 모델 식별 보강

- 대상: 키워드 `써큘레이터`, 판매자 상품 URL `https://smartstore.naver.com/eco/products/11687310806`.
- 원인: 정확 상품 제목에는 `서큘레이터`가 있지만 가격비교 원부 제목 `파세코 PCF-MSF1100 화이트`에는 키워드가 없어 기존 `keywordEvidence` 공통 포함 조건이 실제 원부를 누락했다.
- 보강: 원부 후보는 가격비교 원부형, 모델번호 정규화 완전 일치 또는 기존 키워드 근거, 브랜드·제조사·판매처 식별 근거, 상위 카테고리 일치를 모두 통과해야 한다.
- 오탐 방지: `PCF-MSF1100`과 접두가 유사한 다른 모델 `PCF-MSF11000`은 관련 원부로 연결하지 않는다.
- 공식 API 실조회: 원부 `53687717527` 8위, 정확 판매자 상품 `11687310806` 59위, 300개 확인, 대표 `related_catalog` 8위·원부형.
- 로그인 아이템스카우트 교차확인: 같은 시점 원부 9위·정확 상품 60위. 조회 시점 차이 1칸 범위에서 동일 두 상품과 우선순위를 확인했다.
- 회귀 실조회: `치아미백제`/`5145848584` 원부 9위·정확 상품 44위, `전동 칫솔`/`12649811979` 원부 34위·정확 상품 163위.
- 운영팀·광고주 로컬 빌드 실조회: 두 역할 모두 대표 원부 8위·정확 상품 59위, 1페이지 8위·2페이지 19위, 카드 2건과 각 키워드/상세 링크 정상.
- 반응형·브라우저: 광고주 390px에서 `scrollWidth=390`, 결과 카드 가로 넘침 없음. 운영팀·광고주 콘솔 경고·오류 0건, 두 화면 육안 확인 통과.
- 자동 검사: `check:rank-matching`, 전체 `check:quality` 독립 2회, 서버 13/13, 플레이스 수집기 25/25, Vercel 정적 빌드, `check:env:naver`, `check:supabase`, `git diff --check` 통과.
- `admin.html`, `client.html`, Supabase 스키마·RLS·Storage·운영 데이터는 수정하지 않았다.

## 2026-07-14 · 상품 순위 추적 광고 완전 제외

- 코드 경로: 단건 검색 배열 → 관련 원부·정확 상품 후보 → 30일 대표값 → 수동/자동 `runTrackerCheck` → Supabase 스냅샷까지 동일 오가닉 정책 적용
- 광고 혼입 차단: `isAdProduct`, `adId`, sponsored/paid, `supersaving`, `brand_ad` 후보는 순위·대표값·상위 결과에서 제거
- 오탐 방지: 실제 오가닉 상품에도 존재한 `cr.shopping.naver.com/adcr` 링크와 `organic_expose_order` 조합은 광고로 오판하지 않음
- 로그인 네이버 가격비교 `전동칫솔` 1페이지: `product` 40개, 별도 `supersaving` 5개, product 순번 1~40 연속 확인
- 광고 혼합 단위검사: 광고 정확 상품 1위·광고 원부 1위는 무효, 뒤의 오가닉 정확 상품 10위 또는 원부 7위만 대표값으로 선택
- 실조회 `전동칫솔`: 대표 원부 34위, 정확 상품 167위, 300개 확인, 노출 카드 모두 `isAd=false`, `isOrganic=true`
- Supabase 실제 추적 갱신 `치아미백제`: 대표 원부 8위, 정확 상품 44위, 300개 확인
- Supabase 최신 스냅샷: `rankPolicy=organic_only`, `adExcluded=true`, 대표 `isAd=false`, 대표 `isOrganic=true`, `top_items` 5개 전부 오가닉
- `npm run check:env:naver`, `npm run check:supabase`, `check:rank-matching`, `check:baseline`, 서버 문법, `git diff --check`: 통과
- 전체 `npm run check:quality`: 독립 2회 통과. 각 실행에서 서버 13/13, 플레이스 수집기 25/25, 크론·순위·키워드·Vercel 빌드 통과
- 관리자·광고주 로컬 빌드 화면: 두 역할 모두 광고 제외 40개 보기 안내, 오가닉 추적 UI·최근 기록 렌더링 정상
- Supabase 스키마·RLS·Storage 변경 없음. 유효한 신규 스냅샷 1건만 기존 추적에 추가
- 배포 커밋: `032c144`
- Production: `momentinsight-iddnfo068-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`: HTTP 200
- 운영 단건 API `전동칫솔`: 대표 원부 34위, 정확 상품 166위, 300개 확인, `rankPolicy=organic_only`, 모든 노출·상위 항목 오가닉
- 운영 추적 `치아미백제`: 대표 원부 8위, 정확 상품 44위, 300개 확인, 최신 스냅샷 `adExcluded=true`
- 운영 Supabase 직접 조회: 대표 `isAd=false`·`isOrganic=true`, `top_items` 5개 전부 오가닉
- 운영 광고주 화면: 현재 8위·원부, 자동추적 정상, 다음 오전 9시, 광고 제외 안내와 레이아웃 정상

## 2026-07-14 · 상품 30일 대표 순위 원부 비교

- 선택 규칙: 정확 상품과 관련 원부 중 숫자가 더 낮은 공식 API 순번을 30일 대표 순위로 저장한다.
- 단위검사:
  - 상품 48·원부 7 → 대표 7, `related_catalog`
  - 상품 5·원부 12 → 대표 5, `exact_product`
  - 원부 후보 11·8 → 대표 원부 8, 무관 후보 3은 제외
- 로컬 공식 API 실조회:
  - `치아미백제`: 정확 상품 43, 관련 원부 9, 대표 9, 300개 확인
  - `치아미백`: 정확 상품 60, 관련 원부 14, 대표 14, 300개 확인
- 기존 단건 조회의 대상 상품ID와 상품 ID 일치 판정은 변경하지 않는다.
- 기존 과거 스냅샷은 관련 원부 원본이 없어 소급 변경하지 않는다.
- `check:rank-matching`, `check:baseline`, 서버 문법, `git diff --check`: 통과
- 전체 `npm run check:quality`: 독립 2회 통과
  - 서버 테스트 13/13, 플레이스 수집기 테스트 25/25, 릴리즈 기준선·순위 매칭·크론·키워드 트렌드·Vercel 빌드 통과
- 관리자·광고주 소스와 `dist` 빌드 HTML: 인라인 스크립트 문법, 비교 안내, `related_catalog`, 현재 출처, 오전·오후 출처 마커 통과
- 로컬 인앱 브라우저와 Chrome은 `localhost` 접근이 보안 정책으로 차단돼 우회하지 않았다. 운영 배포 후 실제 도메인 육안 검수가 필요하다.
- 배포: 현재 작업의 별도 배포 지시 전 대기

## 2026-07-14 · 네이버 상품 페이지 오표기 배포 전 재검증

- 대상 1: `전동칫솔` / 판매자 상품ID `12649811979`
  - 공식 API 결과 순번 168, 관련 원부 34, `checkedCount=300`
  - `matchedProductId=12649811979`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- 대상 2: `치아미백제` / 판매자 상품ID `5145848584`
  - 공식 API 결과 순번 43, 관련 원부 9, `checkedCount=300`
  - `matchedProductId=5145848584`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- `npm run check:quality` 독립 2회 통과
  - 서버 테스트 13/13, 플레이스 수집기 테스트 25/25, 순위 매칭·기준선·크론·키워드 트렌드·Vercel 빌드 통과
- 로컬 인앱 브라우저는 `127.0.0.1` 접근이 `ERR_BLOCKED_BY_CLIENT`로 차단되어 운영 배포 후 실제 도메인에서 관리자·광고주 화면을 재검증한다.
- 공식 Shopping Search API의 검색 순번은 제공되지만 실제 쇼핑 화면 페이지 위치와의 동일성은 공식 문서에서 보장되지 않으므로 페이지 환산을 금지한다.
- Production: `momentinsight-1z4jt31ot-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`: HTTP 200
- 운영 API 재조회:
  - `전동칫솔`: 공식 API 168번째, 관련 원부 34번째, 판매자 상품ID 일치, 300개 확인
  - `치아미백제`: 공식 API 43번째, 관련 원부 9번째, 판매자 상품ID 일치, 300개 확인
  - 두 응답 모두 `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`
- 운영 관리자 브라우저: 공식 API 168번째, 화면 위치 미검증, 300개 확인, 관련 원부/상품 ID 일치 카드와 각 링크 목적지 확인
- 운영 관리자·광고주 HTML: 공식 API 결과 순번·실제 화면 위치 아님·상품 ID 일치·프리미엄 사이드바 마커 확인, 40개 단위 페이지 환산 코드 없음

## 2026-07-14 · 네이버 상품 페이지 오표기 제거

- 운영 API 재현: `전동칫솔`/판매자 상품ID `12649811979`는 공식 쇼핑 검색 API 168번째 결과에서 링크 상품ID가 정확히 일치했다.
- 기존 오류: API 배열 순번 168을 40개 단위로 환산해 `5페이지 8위`로 표시했으나 실제 쇼핑 화면 위치를 검증하는 근거가 없었다.
- 실화면 접근: 인앱 브라우저, 사용자 Chrome, 직접 HTTP 요청 모두 네이버 쇼핑의 비정상 접근 제한(HTTP 418)으로 차단됐다. 우회하지 않고 미검증으로 처리했다.
- 로컬 API: `rank=168`, `rankBasis=official_api_result_order`, `page=null`, `position=null`, `pageSize=null`, `webPageVerified=false`, `matchedProductId=12649811979`.
- 카드 결과: 관련 원부 API 34번째, 입력 상품 API 168번째. 두 카드 모두 페이지 위치를 표시하지 않는다.
- `npm run check:rank-matching`: 통과. 40개 단위 환산 함수 제거, 41번째 결과도 페이지 필드가 없음을 회귀 검사했다.
- `npm run check:baseline`: `naverRankDoesNotFabricateWebPagePosition=true` 포함 전체 통과.
- `npm run check:quality`: 독립 실행 2회 통과. 각 실행에 서버 테스트 13개, 플레이스 수집기 25개, Vercel 정적 빌드 포함.
- `git diff --check`: 통과.
- 운영 배포: 없음.

> 아래 과거 기록의 `N페이지 N번째`, `광고 제외 오가닉 순위` 표현은 당시 API 배열 순번을 화면 순위로 해석한 기록이다. 현재 결정과 테스트는 위 기준이 우선한다.

기준일: 2026-07-14

## UI/UX 1차 고도화 · 상태 진실성 및 첫 화면 밀도

- 운영 홈: 실제 집계가 아닌 `12개·4건·3건·2건`, 브랜드 예시 3건, 과거 업데이트 날짜 제거
- 운영 홈 대체 흐름: 광고주 연결 → 운영 입력 → 공개 승인 → 보고서 관리 작업 카드 4개와 3단계 운영 순서 제공
- 광고주 빈 상태: `공개 준비 중`, `데이터 상태: 공개 데이터 연결 대기`, `데이터 대기`, `운영팀 공개 입력 전` 동시 전환 확인
- 광고주 데이터 상태 회귀: `4,180만원` 상태에서 `업데이트 완료`, `운영팀 검수 완료`, `공개용` 유지 확인
- 빈 보고서함: 오래된 기본 월간 보고서 대신 `공개 보고서 없음` 표시
- 모바일 광고주 390×844: 빈 요약 카드 401px, 핵심 지표 3열, 액션 2열, `scrollWidth=390`
- 모바일 운영팀 390×844: 작업 카드 4개, `scrollWidth=390`, 카드·메뉴 겹침 없음
- 운영팀 CTA: `광고주 연결` 카드가 `agency-code` 화면으로 정확히 이동
- 스크롤 복귀: 운영팀 `scrollY 554.5 → 0`, 광고주 `scrollY 539 → 0` 확인
- 로컬 브라우저 로그: 오류 0건
- `npm run check:quality`: 통과, 서버 테스트 13/13·플레이스 수집기 25/25·Vercel 빌드 포함
- `npm run check:supabase`: HTTP 200, publishable key·JWKS 정상
- `npm run check:env`: 필수 환경 항목 정상, 기존 선택 항목 미설정 상태는 유지
- Supabase 스키마·RLS·운영 데이터 변경 없음, 삭제·마이그레이션 없음
- 배포: 운영 영향 보고 전 대기

## 네이버 상품 대표 순위·페이지 표기 정상화

- 로그인 네이버 가격비교: `전동칫솔`, 네이버 랭킹순, 40개씩 보기
- 실화면 원부: `57907660073`, 오가닉 34위, 1페이지 34위
- 실화면 정확 상품: 판매자 상품ID `12649811979`, API 항목 ID `90194322885`, 오가닉 168위, 5페이지 8위
- 정확 상품 DOM 근거: `chnl_prod_no=12649811979`, `organic_expose_order=8`, 페이지 `5`
- 로컬 API: 대표 34위·원부형·1페이지 34위, 정확 상품 168위·단일형·5페이지 8위, 300개 확인
- `치아미백제` 회귀: 대표 원부 9위·정확 상품 43위, 원부형 정상
- 관리자 로컬 실조회: 대표 카드와 노출 카드 2건, 상품명은 키워드 검색, 상품 열기는 원부/입력 상품 상세로 분리
- 광고주 로컬 실조회: 관리자와 동일한 숫자·형태·링크 확인
- 광고주 390×844: `innerWidth=390`, 문서 `scrollWidth=375`, 전체 가로 넘침 없음
- 관리자·광고주 브라우저 경고·오류: 0건
- 서버형 Playwright 네이버 화면 접근: HTTP 418 재현, 운영 수집 성공으로 오인하지 않음
- `npm run check:env:naver`: 필수 네이버·Supabase 환경 준비
- `npm run check:quality`: 독립 1차 통과
- `npm run check:quality`: 독립 2차 통과
- 서버 테스트 13/13, 플레이스 수집기 25/25, 릴리즈 기준선과 Vercel 빌드 통과
- `git diff --check`: 통과
- Production 배포: `momentinsight-3whvmsjzo-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY
- 운영 `/health`, 관리자·광고주 HTML, 순위 API: HTTP 200
- 운영 API: 대표 원부 34위·1페이지 34위, 정확 상품 168위·5페이지 8위, `checkedCount=300`
- 운영 관리자·광고주 실조회: 대표 원부형 34위, 정확 단일형 168위, 두 카드의 페이지 위치와 원부·스마트스토어 상세 링크 정상
- 운영 데스크톱 육안검수: 상태 메시지·순위 요약·카드 구분·프리미엄 레이아웃 겹침 없음

## 네이버 상품 정확 일치·300위 완주 재검증

- 입력: `전동칫솔`, `https://brand.naver.com/lav/products/12649811979`, 300위
- 네이버 공식 API 원문 300개: 관련 원부 `57907660073` 33위, 입력 URL 판매자 상품ID `12649811979` 173위
- 173위 API 항목: API `productId=90194322885`, 결과 링크 판매자 상품ID `12649811979`, 판매처 `라이브오랄스`, 69,000원
- 실제 입력 상품 페이지: 상품번호 `12649811979`, 제목 `라이브오랄스 음파 전동칫솔 회전 IPX8 방수 C타입 충전식 초극세모 칫솔모 3P`, 판매처·가격까지 API 항목과 일치
- 판정: 173위는 다른 업체가 아니라 입력 URL의 동일 판매자 상품이며, 원부 33위와 판매처 단일 상품 173위가 함께 노출되는 구조
- 보강 후 일치 근거: `seller_link_product_id`; API `productId`만 같은 다른 링크 상품은 불일치
- 보강 후 수집 범위: 정확 상품 173위를 찾은 뒤에도 오가닉 300개 확인, 카드 2건 유지
- 상세 링크: 관련 원부는 `catalog/57907660073`, 정확 상품은 입력 원본 `brand.naver.com/lav/products/12649811979`
- 정상 회귀: `치아미백제`/`5145848584` 관련 원부 7위·정확 상품 48위·300개 확인
- 오판 회귀: `게이밍노트북`/`12649811979`는 오가닉 300개 확인 후 미발견
- 임의 중복 제거 실험은 원부를 33위에서 29위로 변경해 제외; 공식 API 슬롯 순서 유지
- 로컬 운영팀 1280px: 카드 2건, 카드 높이 128px, `scrollWidth=1280`, 콘솔 오류 0건
- 로컬 광고주 390×844: 카드 폭 276px, `scrollWidth=390`, 콘솔 오류 0건
- 전체 `npm run check:quality`: 1차 통과, 서버 테스트 13개·플레이스 수집기 테스트 25개·Vercel 빌드 포함
- 전체 `npm run check:quality`: 동일 기준 2차 통과
- `npm run check:env:naver`, `npm run check:supabase`: 정상
- Production: `momentinsight-mmeqlbh43-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`
- 운영 API: `rank=173`, `checkedCount=300`, `matchEvidence=seller_link_product_id`, `matchedProductId=12649811979`
- 운영팀 1280px 실조회: 원부 33위·정확 상품 173위·300개 확인, 카드 128px, `scrollWidth=1280`, 콘솔 오류 0건
- 운영 광고주 390×844 실조회: 카드 폭 276px, `scrollWidth=390`, 원부/정확 상품 상세 링크 정상, 콘솔 오류 0건
- 라이브 `/health`: HTTP 200

## 오가닉 노출 카드 컴팩트 프리미엄화

- 관리자·광고주 공통 카드: 이미지 84×84px, 최소 높이 116px, 14px 보드 라운드와 낮은 그림자 적용
- 관련 원부 배지: `#eaf9f0` 배경, `#087f45` 글자, `#bcebd0` 테두리의 네이버 민트·그린 톤 적용
- 상품명 링크: 조회 키워드를 포함한 `search.shopping.naver.com/search/all` 검색 결과 주소
- `상품 열기` 링크: 각 `productExposureItems`의 기존 상품 상세 URL
- 릴리즈 기준선: 두 역할의 키워드 링크, 상품 상세 링크, 그린 배지 마커 검사 통과
- 전체 `npm run check:quality`: 통과, 서버 테스트 13개·플레이스 수집기 테스트 25개·Vercel 빌드 포함
- Vercel Preview: `momentinsight-533u2sq4m-momentlabs.vercel.app`, 빌드 READY
- Preview 브라우저 조회: 화면·입력·300위 옵션은 정상이며 네이버 쇼핑 API 환경변수 미연결 메시지를 확인. 실조회 UI는 Production에서 최종 검증했다.
- Production: `momentinsight-c4ylvfjb4-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr` 반영
- 운영 실조회: `치아미백제`/상품 `5145848584`, 정확 상품 48위·2페이지 8번째, 관련 원부 `56704991367` 7위·1페이지 7번째
- 운영팀·광고주 데스크톱: 카드 2건, 카드 높이 각각 127px, 이미지 84×84px, 관련 원부 계산 색상 `rgb(234, 249, 240)`·`rgb(8, 127, 69)`
- 운영팀·광고주 390×844: 카드 폭 각각 276px, 이미지 72×72px, 문서 `scrollWidth=390`, 가로 넘침 없음
- 두 역할 상품명 2개: 모두 `search.shopping.naver.com/search/all`의 `치아미백제` 검색 결과로 연결
- 두 역할 `상품 열기` 2개: 관련 원부 `catalog/56704991367`, 정확 상품 `products/5145848584` 상세로 연결
- 운영팀·광고주 브라우저 콘솔 오류: 0건
- 라이브 `/health`, `/admin`, `/client`: HTTP 200, 컴팩트 카드·키워드 링크·민트 배지 마커 확인

## 운영팀·광고주 공통 사이드바

- 전체 `npm run check:quality`: 통과
- 릴리즈 기준선: `clientNavigationTaxonomy`, `roleSidebarsSharePremiumShell` 포함 전체 통과
- Vercel Preview: `momentinsight-5fm1vq6dw-momentlabs.vercel.app`, 빌드 READY
- 운영팀 1280×720 실화면: 사이드바 236px, 높이 720px, 문서 `scrollWidth=1280`, 네 개 공통 메뉴 분류 확인
- 운영팀 활성 메뉴: 딥네이비 왼쪽 라인, 프리미엄 그라데이션 배경과 그림자 계산값 확인
- 광고주 Preview DOM: `운영`, `키워드·SEO`, `순위 조회·추적`, `광고 조사` 순서와 10개 역할 허용 메뉴 확인
- 광고주 계산 CSS: 236px 그리드, 운영팀과 동일한 배경·그림자·활성 그라데이션·42px 브랜드 높이 확인
- 광고주 390×844 반응형 규칙: 데스크톱 메뉴 숨김, 모바일 메뉴 flex, 최대 폭 366px, 동일 메뉴 순서 확인
- Production: `momentinsight-1eo93tbd5-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr` 반영
- 운영 광고주 데스크톱 실로그인: 사이드바 236px, 네 개 공통 메뉴 분류, 운영팀과 동일한 배경·그림자·활성 그라데이션 확인
- 운영 광고주 390×844 실로그인: 모바일 메뉴 flex, 문서 `scrollWidth=390`, 카드·텍스트 겹침 및 전체 가로 넘침 없음
- 운영 관리자·광고주 콘솔 오류: 0건
- 라이브 `/health`, `/admin`, `/client`: HTTP 200, 두 HTML 모두 `data-mi-shell="premium-sidebar"` 확인

## 연속 개발 운영 규칙 검증

- 기존 플레이스 수정 커밋 `3638a73`과 배포 대기 상태를 보존한 채 문서만 변경했다.
- 작업 전 `git status --short --branch`, 최근 커밋, 작업명세, 작업 상태, 결정, 다음 작업, 검증 근거를 확인했다.
- `npm run work:autosave`로 작업 시작 기준점을 기록했다.
- `AGENTS.md`, 작업명세, 프로젝트 기억, 상태, 결정, 다음 작업에 사전 확인·중복 검색·기존 diff 보존·2차 검증·논리 단위 커밋·배포 게이트가 함께 기록됐는지 검색 검사한다.
- 문서 변경 후 `npm run check:baseline`, `git diff --check`, 최종 diff·Git 상태를 재확인한다.

## 네이버 플레이스 장애 재현

- 키워드: `부평 맛집`
- 플레이스 URL/ID: `2019299673`
- 자동 식별 상호명: `팽오리농장 부평점`
- 운영 실패 원문: 세 Apify Actor 모두 `Monthly usage hard limit exceeded`
- 자체 브라우저 수집: 광고 제외 오가닉 54개, 약 70초, 대상 미발견, `collection_deadline_reached`
- 판정: 300위 밖으로 확정하지 않고 `54위까지 확인 · 이후 미검증`
- `npm run check:quality`: 통과
- 플레이스 수집기: 25개 테스트 통과
- 플레이스 서버: 9개 테스트 통과
- `git diff --check`: 통과

## 실제 네이버 조회

- 키워드: `치아미백제`
- 입력 URL: `https://brand.naver.com/lav/products/5145848584`
- 정확 대상 상품ID: `5145848584`
- 결과: 광고 제외 오가닉 48위
- 페이지·위치: 2페이지 8번째
- 매칭: `product_id`
- 대상 모드: `product`
- 잘못 연결되던 카탈로그 ID `59606749556`: 결과에서 사용되지 않음
- 상품 노출 카드: 2건
  - 7위, 1페이지 7번째: 관련 원부 `56704991367`
  - 48위, 2페이지 8번째: 정확 상품 `5145848584`
- 같은 판매처의 무관한 44위 불소 상품: 카드에서 제외
- 잘못 연결되던 원부 `59606749556`: 카드에서 제외

순위는 조회 시점에 따라 바뀔 수 있으며, 이 기록은 정확 일치 로직 검증 증거다.

## 자동 검사

- `npm run check:quality`: 통과
  - 릴리즈 기준선 통과
  - 서버 문법 검사 통과
  - 순위 크론 일정 검사 통과
  - 네이버 상품 매칭 회귀 검사 통과
  - 키워드 트렌드 검사 통과
  - 서버 테스트 12개 통과
  - 플레이스 수집기 테스트 22개 통과
  - Vercel 정적 빌드 통과
- `npm run check:env:naver`: 필수 네이버·Supabase 실행환경 준비 확인
- `npm run check:supabase`: HTTP 200과 JWKS 연결 확인
- `git diff --check`: 공백 오류 없음

## 브라우저 QA

관리자와 광고주 화면에서 각각 로그인 → 키워드/URL 입력 → 순위 조회를 실제 수행했다.

- 데스크톱: 1280×720 브라우저 실조회
- 모바일: 390×844
- 두 화면 모두 오가닉 48위, 관련 원부 7위, 정확 상품 48위 확인
- 두 화면 모두 카드 2개, 이미지 2개, 상품 링크 2개 확인
- 두 화면 모두 잘못된 카탈로그 ID와 무관한 불소 상품 미표시
- 데스크톱 `scrollWidth=1280`, 모바일 `scrollWidth=390`으로 가로 넘침 없음
- 모바일 카드 폭 276px, 상품명 줄바꿈, 버튼과 안내 문구 정상 확인

## Production 배포 후 검증

- 배포: `momentinsight-d7nu7j61r-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`
- `/health`: HTTP 200, API 정상, Supabase 준비 상태 정상
- 관리자·광고주 화면: HTTP 200, `renderProductExposureCards`, 카드 스타일, `광고상품 미연결` 마커 확인
- 라이브 상품 순위 API: HTTP 200, `matchType=product_id`, `targetProductId=5145848584`, `targetCatalogId` 빈값
- 라이브 노출 결과: 관련 원부 `56704991367` 7위, 정확 상품 `5145848584` 48위
- 라이브 관리자·광고주 데스크톱: 카드·이미지·링크 각각 2개, 가로 넘침 없음
- 라이브 관리자·광고주 390×844: 카드·이미지·링크 각각 2개, `scrollWidth=390`
- 잘못된 원부 `59606749556`과 같은 판매처의 무관한 불소 상품: 라이브 화면 미표시
