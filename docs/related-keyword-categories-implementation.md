# 연관 키워드 중·소 카테고리 — 구현 및 검증 기록

## 최신 작업 (2026-10-19)

현재 승인된 경로는 외부 API/Commerce가 아닌 기존 순위 snapshot의 실제 저장 분류 재사용이다. 정확 keyword·계정·원장 검증을 통과한 최신 상위5개 표본만 읽는다. 실제 DB 연결 및 단일/복수/미저장 검증을 수행했으며, 최신 상태·전체 검수 결과·배포 여부는 [최신 기록](related-keyword-stored-categories-20261019.md)을 기준으로 한다. 아래 날짜별 독립 provider/Commerce 계획과 과거 실패 기록은 이력이다.

## 범위와 상태 (2026-10-14)

- 요청: 모먼트 인사이트 기존 키워드 조회를 보존하고, 별도 연관 키워드 조회에서 각 연관어의 중·소 카테고리를 자동 조회한다. 복수 카테고리와 확인 필요를 분리한다.
- 현재 상태: 로컬 구현·대상/브라우저 검수 통과. 전체 품질 검사에 기존 워치독 권한 실패 1건이 남았고 실제 카테고리 데이터 연결도 검증하지 못해 운영 완료·배포 준비 상태가 아니다. 커밋·배포하지 않았다.
- 기존 키워드 조회와 순위추적의 잠금 함수·수집기·worker·DB·스케줄·runtime은 수정하지 않는다. 새 카테고리 조회는 별도 캐시, 제한된 동시성/시간/요청 수로 격리한다.
- 기존 미커밋 문서 4개와 data/, drafts/, marketing/, vercel.json, 개인 일정은 보존한다. `work:autosave`는 보호된 기존 문서를 재작성하므로 사용자 보호 지시에 따라 실행하지 않고 이 별도 기록을 사용한다.

## 실제 데이터 경로의 제약

- 네이버 공식 Shopping 상품 검색 API는 2026-07-31 종료되었다. 종료된 `shop.json`을 새 기능의 정상 데이터 소스로 사용하지 않는다. 대체 API 제공 여부도 공식 공지상 없다.
- 공식 공지: https://developers.naver.com/notice/article/32530
- 공식 이용약관: https://developers.naver.com/products/terms/
- 공개 모바일 검색 bootstrap을 별도 프로세스로 1회 읽었으나 HTTP 200 응답에 현재 순수 parser가 요구하는 `initProps.byPassBFFParams`가 없어 `shopping_mobile_top_schema_drift`로 종료했다. paged-slot 호출·재시도·기존 순위 collector 호출은 각각 0회다. HTTP 200만으로 수집 성공을 보고하지 않는다.
- 추가 모바일 GET 1회에서 실제 embedded `initialState.initProps.pagedSlot[].slots[].data` 구조를 확인했으나 알려진 중·소분류 직접 필드와 ID+분류 조합은 0개였다. PC 공개 쇼핑 검색 GET 1회는 HTTP 418로 즉시 종료했다. 전체 실소스 진단은 모바일 GET 2회 + PC GET 1회, 재시도 0회로 끝냈다. 차단 우회, 쿠키/인증, UA 위장, BFF token 사용, Chrome/순위 worker 호출은 하지 않았다. 더 반복 수집하지 않는다.
- 대표 키워드의 카테고리를 모든 연관어에 복사하거나 제목·브랜드·이미지 유사성으로 분류하지 않는다.

## 분류 계약

- 각 연관어별 실제 상품 표본의 중·소분류 조합을 사용한다. 이는 해당 검색의 상품 표본 분류이며 키워드 고유 카테고리 또는 순위·원부 관계를 증명하지 않는다.
- 완전하고 유효한 표본에 중·소분류 조합이 1개이면 단일, 2개 이상이면 복수 카테고리다.
- 미설정, 접근 실패, 시간 초과, 잘못된 키워드/스키마/출처, 오래된 자료, 빈 표본, 일부 누락은 확인 필요다. 복수 조합이 실제 관찰되었으나 일부 누락이면 복수 상태와 불완전 사유를 함께 보존한다.
- 검색량 미공개/확인 불가는 0으로 만들지 않는다. `<10`은 상한 표기로 보존한다.

## 검증 결과

- backend 대상 테스트 20/20 PASS. 단일/복수/부분 누락/빈 표본/출처·키워드 불일치/상품 ID 중복/오래된 원본/미설정/차단/응답 크기/timeout/cache/dedupe/격리를 검사했다.
- UI 대상 테스트 12/12 PASS. 최대 30개, 필터, 상태/부분 누락/`<10` 보존, CSV 수식 방어, 세션 전후 동일성, 계정 변경·로그아웃·늦은 응답·무한 대기 방지, 기존 inline hash 보존을 검사했다.
- `node scripts/related-keywords-browser-smoke.mjs`: 관리자·광고주 두 surface, PC 1440px/모바일 390px, 상태 구분·필터·CSV·오류 복구 6개 항목 PASS. 실제 view/CSS 및 새 external bootstrap을 사용하지만 API는 전부 로컬 테스트 응답이다. 운영·순위 API 호출 0회다.
- `npm run check:rank-feature-lock`: 23함수/143파일/90migration PASS. 잠금 파일을 갱신하지 않았다.
- 기존 admin/client inline 앱 스크립트는 HEAD와 byte-identical이다. CSP/`vercel.json`을 변경하지 않고 새 독립 외부 스크립트만 추가했다.
- 독립 검수에서 URL canonical/DNS trailing-dot 격리, 원본 시각 기반 캐시 만료를 보완했다. root 실행에서 드러난 timeout 경계 추가 fan-out도 고정 시계 RED→GREEN으로 보완했다.
- 보호된 기존 미커밋 문서 4개 SHA-256이 시작 시각과 동일함을 확인했다.
- 최종 독립 검수: backend+UI 32/32 PASS, 추가 blocking P0/P1 발견 0. 단, 실수집 source 미연결은 별도의 기능 미완료 조건이다.
- 전체 `check:quality`: 공급망/보호 잠금/역할 상태/기준 화면/역할 parity/개인 영역 격리/서버 계약/서버 문법/cron/순위 matching/키워드 trend 검사를 통과한 뒤 core 2,640개 중 2,639 PASS, 1 FAIL로 종료했다. 실패는 `scripts/rank-collection-stability.test.mjs`의 F2 파일 모드 검사다. 기존 `scripts/watchdog/mi-rank-watchdog.sh`가 `0700`이며 테스트는 `0755`를 요구한다. 작업에서 이 파일의 내용·권한을 수정하지 않았고 Git diff도 없다. 다른 워치독 설치 셸은 `0755`다. 전체 품질 검사를 PASS로 보고하지 않는다.
- 위 실패로 자동 실행되지 못한 후속 항목을 따로 실행했다: Place collector 59/59, Shopping collector 104/104, `npm run build:vercel` PASS. public build 25파일, inline script 6개/고유 hash 4개 커버, 비밀값·비공개 산출물 검사 PASS.
- 검증 로그: `/tmp/moment-insight-related-category-{quality,place,shopping,build}-20261014.log`. core 전체 재실행으로 기존 실패를 덮어쓰거나 실패 테스트를 제외하지 않았다.

테스트용 응답과 실제 네이버 응답은 다른 증거다. 위 통과를 운영 자동 분류 성공으로 보고하지 않는다.

## 구현 경로와 연결 계약

- 기존 `GET /api/client/keyword-research`는 유지하며 `mode=related`에만 새 독립 핸들러를 사용한다. 일반 조회 로직은 변경하지 않았다.
- SearchAd 키워드 도구 응답에서 기준어를 제외하고 중복 제거한 실제 연관어 최대 30개를 사용한다. 30개가 없으면 지어내어 채우지 않는다.
- 새 category provider만 `NAVER_KEYWORD_CATEGORY_COLLECTOR_URL`(독립 HTTPS endpoint) 및 `NAVER_KEYWORD_CATEGORY_COLLECTOR_TOKEN`(서버 전용 Bearer)을 사용한다. 미설정 상태는 `needs_confirmation/source_unavailable`이다. 현재 실제 provider를 구축·배포하거나 연결한 것은 아니다.
- provider 요청: `GET <URL>?keyword=<해당 연관어>&limit=20`, redirects 금지. 기존 순위 collector의 같은 host는 포트/경로/DNS 끝점 변형도 차단한다.
- provider JSON 계약:

```json
{
  "schemaVersion": "mi.keyword-category-sample.v1",
  "source": "naver_shopping_product_categories",
  "keyword": "조회한 정확한 연관어",
  "complete": true,
  "collectedAt": "실제 수집시각 ISO8601",
  "items": [
    { "productId": "실제 숫자 상품 ID", "category2": "실제 중분류", "category3": "실제 소분류" }
  ]
}
```

이 JSON은 계약 설명이지 수집 결과가 아니다. 인증된 독립 provider에서도 실제 공식 상품 분류 필드의 근거를 확보해야 한다. 24시간을 넘긴 원본은 성공 캐시로 재사용하지 않는다.
- 보호된 기존 수집기/worker/DB/Windows runtime/일정/순위 상태는 변경하지 않았다. 캐시와 제한은 프로세스 인스턴스 단위이며 분산 전역 제한으로 과장하지 않는다.
- 현재 권한은 기존 로그인된 keyword-research 보조 경로를 유지한다. 기존 키워드 조회 일일 quota RPC는 변경하지 않았으며 새 보조 경로는 독립 분당 6회 제한이다. 비로그인 공개 정책·체험 일일 quota 공유는 별도 결정 없이 변경하지 않았다.

## 남은 조건

1. 검증 가능한 독립 category provider의 실제 응답을 확보하고 실제 연관어별 분류를 검증해야 한다. 기존 rank collector에 연관어 30개 fan-out을 추가하거나 외부 유료 자원을 임의 생성하지 않는다. 현 공식 API 종료·직접 공개 표면 제약 때문에 현재 연결 가능한 정상 소스를 확보한 것은 아니다. 실소스가 확인되지 않으면 새 UI는 확인 필요를 표시한다.
2. 기존 워치독 `0700` 권한과 기준 `0755` 불일치는 별도 운영 변경 검토 대상이다. 순위 운영 파일 보호에 따라 이번 카테고리 작업에서 임의 보정하지 않았다.
3. 두 조건을 해결하고 실연동을 검증하기 전 기능 운영 완료·배포 준비를 주장하지 않는다. 배포는 현재 작업에 대한 사용자 승인 후에만 한다.
