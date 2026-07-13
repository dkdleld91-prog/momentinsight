# Test Evidence

기준일: 2026-07-14

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
