# 연관 키워드 공식 카테고리 대체 경로 (2026-10-18)

최신 구현은 추가 네이버 호출·유료 API 없이 저장된 rank snapshot 분류를 재사용한다. [2026-10-19 저장 데이터 구현·검수](related-keyword-stored-categories-20261019.md)를 현재 기준으로 하며, 아래 외부 소스 검토는 과거 기록이다. 기존 순위 수집기 실행은 여전히 금지하며 저장 결과 읽기만 사용한다.

## 최신 결정: Commerce 제외 (2026-10-19 KST)

사용자가 커머스API 없이 실제 중·소 카테고리를 조회하도록 요청했다. 아래 Commerce 인증 안내·구현 기록은 과거 검토 이력이며 현재 발급·연결·배포 지시가 아니다. Commerce 키 발급·연결, 기존 API 키 변경, 순위 수집기 재사용을 진행하지 않는다.

대체 경로 실측 및 검토:

- 공개 PC 쇼핑 검색 `search.shopping.naver.com/search/all?query=온열찜질기`: HTTP 418, 1회만 요청하고 중단했다. 브라우저 위장·프록시·차단 우회·자동 재시도는 하지 않았다.
- 공개 모바일 통합검색 `m.search.naver.com/search.naver?where=m&query=온열찜질기`: HTTP 200. 최초 필드 확인과 후속 구조 확인 각 1회로 `lCatId/mCatId/sCatId`의 실제 값이 상품 자료에 포함됨을 확인했다. `category2Name/category3Name/mCatName/sCatName/wholeCategoryName`은 없었다. ID를 임의 이름으로 치환하지 않았다.
- 모바일에서 얻은 분류 ID에 대해 과거 DataLab 분류 페이지를 확인했으나 HTTP 301로 `notfound.html`을 가리켰다. 응답과 이동 위치만 확인했으며 HTTP로 강등하거나 새 비공개 endpoint를 추측 호출하지 않았다. 현재 유효한 공식 중·소 이름 매핑 원부는 확보하지 못했다.
- SerpApi의 Naver shopping 공개 명세에는 상품 링크의 `cat_id`가 있지만 중·소 이름 사전이 없다. 이름을 추정해야 하는 상태이므로 완성된 공급원으로 채택하지 않았다.
- 독립 외부 수집 후보 `zen-studio/naver-shopping-scraper`는 제공자 문서상 상품 식별자와 `catalogDetail.categoryInfo.fullCategoryName/fullCategoryId`, `storeDetail.category.wholeCategoryName/wholeCategoryId`를 반환한다. 문서 예시는 여러 상품 필드를 합친 설명용이므로 실제 응답 정합성·수집 안정성의 증거로 사용하지 않는다. 실제 결과가 세 단계 이상 이름/ID 경로와 상품 직접 식별자를 함께 반환할 때에만 중·소 이름을 채택할 수 있다.
- 위 외부 후보는 별도 계정·인증과 과금 이벤트가 있다. 무료 플랜 한도·크레딧도 확인해야 하며 기존 16초 요청에 30개 외부 작업을 붙여서는 안 된다. 계정 연결과 비용 상한이 승인되지 않아 실제 실행 0회다. 가입·결제·유료 자원 생성·환경변수 쓰기·배포도 0회다. 연결 가능한 Apify 플러그인 검색 결과도 없었다.

출처:

- https://serpapi.com/naver-shopping-results
- https://apify.com/zen-studio/naver-shopping-scraper
- https://apify.com/zen-studio/naver-shopping-scraper/pricing

**현재 판정: Commerce 없는 자동 조회의 실제 운영 성공은 아직 검증하지 못했다.** 신규 분류 값을 만들거나 성공으로 표시하지 않는다. 추가 권한이 필요한 다음 단계는 외부 후보에서 키워드 1개·상품 최대 20개·실행 1회·명시 비용 상한으로 실제 분류 필드와 수집 시간을 검증하는 것이다. 이 검증 및 외부 공급원 선택에 대한 사용자 승인 전 새 통합 코드를 운영에 연결하지 않는다. 기존 키워드 조회·순위추적·DB·스케줄은 보존한다.

## 현재 상태

클로드 완료 후 최신 확정 `origin/main=36a87bf58219e70e7e04000a7d3789eb3d5e3214`를 기준으로 분리 작업한다. 원래 개발 폴더의 미커밋 변경과 클로드의 별도 worktree는 보존했다. 원본은 `24d0a3e`이며 21커밋 뒤처져 있으므로 그 파일을 최신에 덮어쓰지 않았다. 관리자 HTML의 Coupang CSS/script와 겹치는 두 삽입 위치만 최소 병합했다.

최종 작업 위치: `/Users/sindongbin/Documents/모먼트 인사이트/.codex-worktrees/related-category-20261018`. 최초 임시 worktree에서 검수한 뒤 전체 통과 후 이 영구 위치로 옮겨 보존했다. 아직 커밋·배포·원본 트리 반영을 하지 않았다. 최신 쿠팡 UI, 상태 조회 개선, CSP, rank lock을 보존했다.

이전 종료된 Shopping 검색 API 대신 **공식 Commerce 카탈로그 이름 검색**을 사용하도록 연결 코드를 구현한다. 현재 로컬에 Commerce 인증키가 없으므로 실제 인증 및 실제 분류 응답 검증 전이다. 테스트 응답의 성공을 실운영 성공으로 보고하지 않는다.

## 실제 공식 경로와 의미

- `GET https://api.commerce.naver.com/external/v1/product-models?name=<각 연관어>&page=1&size=20`
- 공식 명세: https://apicenter.commerce.naver.com/docs/commerce-api/current/get-model-list-product
- 공식 Markdown: https://apicenter.commerce.naver.com/llms/get-v1-product-models.md
- 실제 `contents[].id + categoryId + wholeCategoryName` 조합만 사용한다. 브랜드·상품명 유사성을 자체 분류 근거로 사용하지 않는다.
- `wholeCategoryName` 경로의 두 번째·세 번째 단계가 중·소분류다. 경로 누락, 안전하지 않은 숫자 ID, 중복 ID, 불일치 metadata는 확인 필요다.
- 결과의 의미는 **조회된 네이버 카탈로그 기준**이다. 일반 쇼핑 검색의 전체 상품 분류나 순위 증거가 아니다. 카탈로그 미등록·빈 검색 결과로 카테고리 자체가 없다고 단정하지 않는다.
- 첫 페이지 최대 20개만 읽고 추가 페이지를 호출하지 않는다. `hasMore`를 화면/CSV에 남긴다. 이 값은 rank의 `sourceExhausted`, `marketTotal`과 무관하다.
- 같은 중·소분류가 관측되면 표본 내 단일, 여러 경로면 복수, 일부 분류 누락이면 확인 필요 또는 복수+일부 확인 필요다. 실제 source mode와 다른 출처를 주장하는 응답은 거부한다.

## 필요한 서버 설정

비밀값은 채팅·코드·로그에 넣지 않는다. 별도 승인 없는 배포 환경 변경도 하지 않는다.

```dotenv
NAVER_KEYWORD_CATEGORY_SOURCE=commerce
NAVER_COMMERCE_CLIENT_ID=<발급된 앱 Client ID>
NAVER_COMMERCE_CLIENT_SECRET=<발급된 앱 Client Secret>
NAVER_COMMERCE_TOKEN_TYPE=SELF
```

SELF에는 `NAVER_COMMERCE_ACCOUNT_ID`를 설정하지 않는다. 앱 유형·권한이 SELLER인 경우 `NAVER_COMMERCE_TOKEN_TYPE=SELLER`와 해당 `NAVER_COMMERCE_ACCOUNT_ID`가 필요하다. 앱의 상품 API 그룹 권한을 확인해야 한다. read-only OAuth scope가 존재한다고 가정하지 않으며 코드가 허용하는 요청만 실행한다.

공식 인증: https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth

서명은 공식 bcrypt 규칙으로 만들며 OAuth POST는 form-urlencoded다. `bcryptjs@3.0.2`를 exact pin하고 install lifecycle scripts를 실행하지 않았다. 토큰·서명·원본 응답을 클라이언트 또는 로그에 보내지 않는다. 인증 요청은 진행 중 중복을 합치고 응답 토큰 만료시각을 따른다. 인증 실패·timeout·unknown에 자동 재시도하지 않는다. 잘못된 인증이 앱 한도에 영향을 줄 수 있어 인증 실패는 credential별 1시간 quiet period를 적용하고, 키가 바뀌면 별도 상태로 분리한다.

## 기존 기능 격리

- 기존 keyword-research 일반 모드 로직은 그대로, `mode=related`만 새 독립 핸들러다.
- 기존 SearchAd 응답에서 기준어 제외·중복 제거한 실제 연관어 최대 30개를 사용한다. 없는 연관어를 만들지 않는다.
- category cache·동시성 2·분당 30개(프로세스별)·전체 deadline은 별도다. 기존 순위 runtime/worker/Chrome profile/cache/quota/DB/스케줄을 호출하거나 변경하지 않는다.
- OAuth POST와 카탈로그 GET 외 목적지는 없다. generic collector 모드는 기존대로 보존하되 official Commerce를 가장할 수 없다.
- 기존 HTML inline 앱 코드는 최신 HEAD와 동일하며 최신 CSP/`vercel.json`은 변경하지 않는다. 관리자·광고주 두 surface에서 동일하게 검수한다.

## 검증 및 남은 작업

현재까지의 검증:

- 신규 source 28/28: 공식 bcrypt/form 인증, SELF/SELLER 구분, 키별 토큰 분리·만료·진행 중 중복 제거, 실패 1시간 quiet period, 공유 요청의 독립 취소/deadline, 늦은 토큰 캐시 차단, ID·분류·page 정합, 응답 크기 제한을 검사했다.
- source/분류/handler/UI 최종 대상 69/69 PASS. 카탈로그의 clock deadline 추가 회귀를 포함한다.
- CSS 순서 보완 후 Coupang UI+source+통합+화면 116/116 PASS. 새 카테고리 CSS가 calendar/Coupang CSS 사이에 들어가던 문제를 실제 검사에서 확인하고 카테고리 CSS만 Coupang 뒤로 옮겼다. 기존 C30 검사를 약화하지 않았다.
- 관리자·광고주 실제 view/CSS 기반 브라우저 검수 6개 항목 PASS. API는 전부 로컬 fixture이며 Production/순위 API 요청 0회다.
- 독립 검수에서 generic collector의 official Commerce 출처 가장과 timeout 뒤 늦은 token state 반영을 재현·수정 확인했다. 현재 추가 P0/P1 발견 0. catalog 응답 직후 clock deadline 확인도 보완했다.
- 최신 보호 잠금 23함수/144파일/91migration PASS, 기존 inline 앱 HEAD 동일, CSP/`vercel.json` 변경 0.
- 공급망 검사 PASS. 새 runtime 의존성은 `bcryptjs@3.0.2` 한 개만 exact pin했다. `npm audit --omit=dev`: 알려진 취약점 0(검사 시점 기준).
- 1차 전체 quality는 core 3,107개 중 3,106 PASS, 위 CSS 순서 1 FAIL로 종료했다. 실패 원인을 보완한 뒤 전체 quality를 다시 실행했으며 실패 결과를 숨기거나 제외하지 않았다.
- 최종 `npm run check:quality` exit0: core 3,108/3,108, Place 59/59, Shopping 104/104 PASS(총 3,271개). 최신 C30 테스트도 포함했다. role/state/baseline/parity/개인 격리/서버 계약/문법/cron/rank matching/trend/공급망/보호 잠금 및 build PASS. 공개 빌드 30파일·inline 6개/고유 CSP hash 4개·비공개 산출물/비밀값 검사 PASS.
- 원본 트리의 보호 문서·HTML·기존 handler·vercel·워치독 9개 파일 SHA-256과 권한이 작업 시작 시점과 동일함을 확인했다. 원본의 watchdog `0700`은 임의 변경하지 않았고, 새 Git checkout은 Git에 저장된 canonical 실행 권한 `0755`로 검수했다.
- 실검증 CLI 실행은 `source_unavailable`, `networkRequests=0`, exit2였다. 현재 shell/env 파일에서 Commerce 키를 확인하지 못했다. 이를 실제 인증·실제 자동 분류 성공으로 보고하지 않는다.

로그: `/tmp/mi-category-commerce-{targeted,targeted-final,compat,quality,quality-final}-20261018.log`. 전체 PASS는 최신 기준 격리 작업본의 로컬 검증이며 실제 API 인증·분류 및 Production 작동 증거와는 다르다.

실제 인증키 연결 뒤 한정 확인 명령:

```sh
node scripts/verify-related-keyword-commerce.mjs --live --keyword 온열찜질기
```

이 명령은 환경변수만 사용하며 env 파일을 읽거나 DB/순위/배포를 실행하지 않는다. 한정된 인증 1회+첫 catalog GET 1회이며 재시도 0이다. 키 미설정은 외부 요청 0회로 종료한다. 이 단일 source 확인 뒤 실제 연관어별 화면 조회·필터·CSV까지 확인해야 자동 조회 운영 완료를 판정할 수 있다.

## 2026-10-19 KST 기존 Production 연결 직접 확인 및 통합 보완

사용자 요청에 따라 로컬 파일의 추측이 아니라 연결된 Vercel 프로젝트 `momentlabs/momentinsight`의 Production 환경변수 목록을 직접 읽었다. `/health`는 HTTP 200, `live`, `icn1`, release `36a87bf58219`를 반환했다. 이는 웹 헬스 확인이며 순위추적이나 신규 카테고리 기능의 실작동 증거는 아니다.

- Production에 SearchAd 키 3개, API Hub 키 쌍과 모드, 기존 DataLab/OpenAPI 설정이 등록돼 있다. 비밀값을 출력하지 않았다.
- `NAVER_COMMERCE_*`, `NAVER_KEYWORD_CATEGORY_*`는 Production 목록에 없었다. 커머스API/독립 카테고리 수집원이 이미 연결돼 있다고 보고할 근거가 없다.
- 공식 개별 Secret 읽기는 메타데이터만 반환했다(`decrypted=false`, `value` 필드 없음). 응답 구조만 한 번 추가 확인했고, 비밀값을 우회 추출하거나 권한·암호화 설정을 바꾸지 않았다. 이를 네이버 인증 실패 또는 운영 장애로 판정하지 않았다.
- 따라서 이번 Production 직접 검증은 **설정의 등록 여부와 웹 릴리스 확인**까지다. 실제 키를 새 조회 코드에 전달한 실검증 또는 Commerce OAuth/카탈로그 실호출은 하지 않았다. 기존 로컬 키 사본을 현재 Production 키라고 가정하지 않았다.
- SearchAd 공식 `RelKwdStat`은 연관어·PC/MO 검색량·광고 클릭·CTR·경쟁도 등을 제공하지만 상품 중·소 카테고리 필드는 없다. API Hub 검색 리소스에도 상품검색은 없으며, Shopping Insight의 category는 발견 결과가 아니라 요청값이다. 기존 키를 Commerce 인증 변수에 복사하지 않았다.

공식 근거:

- https://api.ncloud-docs.com/docs/naver-api-hub-overview
- https://naver.github.io/searchad-apidoc/assets/json/ncc-keywordstool.json
- https://api.ncloud-docs.com/docs/naver-api-hub-shopping-insight-keywords
- https://apicenter.commerce.naver.com/docs/auth

### 이번 보완

`createRelatedKeywordsHandler({env, fetchImpl, now})`의 기본 카테고리 함수가 별도 모듈 singleton의 process 환경·통신·시계를 사용하던 연결 누락을 재현했다. 별도 설정을 넣은 통합 검사 2개가 먼저 FAIL하는 것을 확인한 뒤, handler 생성 시 동일한 설정으로 `createCategoryLookup`를 한 번 생성하도록 수정했다. 명시적인 override와 handler별 캐시·호출 제한은 유지한다. 기본 Production 생성 경로의 장애를 관측한 것은 아니므로 이를 기존 플랫폼 장애 원인이라고 단정하지 않는다.

새 `scripts/verify-related-keyword-connection.mjs`는 설정 유무와 실제 조회 검증을 분리한다. 기본 실행은 설정 존재 여부만 출력하고 외부 요청은 0회다. `--live --keyword`를 명시할 때만 SearchAd 1회·OAuth 최대 1회·카탈로그 최대 30회를 허용하며 전체 16초·재시도 0회다. 공식 호스트/경로/메서드 3조합 외 통신과 generic collector 모드는 이 검사에서 거부한다. 키·토큰·서명·원본 응답·상품 ID를 출력하지 않고, 연관어만 조회됐거나 카테고리가 비어 있으면 성공으로 보고하지 않는다. in-process handler 검증은 실제 배포 라우터·로그인·화면 검증과 구분한다.

### 검수 및 남은 조건

- 새 연결 진단 9/9 PASS, source/분류/handler/화면 기존 대상 71/71 PASS.
- 전체 `npm run check:quality` exit0: core 3,119/3,119 + Place 59/59 + Shopping 104/104 = 3,282/3,282 PASS. 서버 계약·역할/계정 격리·기존 순위 보호 잠금·공급망·문법·빌드·공개 산출물 검사도 통과했다.
- 독립 P0/P1 검토 차단 0. `git diff --check` PASS. 원본 보호 파일 9개의 SHA-256 및 권한이 기존 기준과 동일하다. 원본 HTML·기존 keyword handler·vercel·워치독·보호 문서 수정 0.
- 기존 키워드 조회의 일반 모드, 순위 런타임/수집기/DB/스케줄 변경 0. 운영 환경변수 쓰기·커밋·push·배포 0.
- 로그: `/tmp/mi-category-connection-quality-20261019.log`.

**실제 자동 조회는 아직 완료가 아니다.** 남은 외부 조건은 상품 API 그룹 권한이 있는 Commerce 인증정보를 서버 환경으로 연결하는 것이다. 기존 SearchAd/API Hub 키를 교체·재발급할 필요는 없다. 이미 Commerce 앱이 있다면 그 앱의 인증을 사용하고, 없다면 별도 등록·권한 확보가 필요하다. 비밀값은 채팅이 아니라 비공개 서버 환경에 입력한다. 위 한정 source 검사 뒤에만 실제 연관어별 중·소분류, 복수/확인 필요, 양 화면·필터·CSV를 실제 데이터로 판정하고 배포를 결정한다.
