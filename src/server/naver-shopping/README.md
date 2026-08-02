# N 쇼핑 순위 수집 경로

이 폴더는 N 상품 단건 순위와 30일 자동 추적이 공유하는 수집 경계를 관리합니다.

## Production 계약

- 기본 운영 모드는 `NAVER_SHOPPING_RANK_MODE=hybrid_local_worker`입니다.
- 서버의 즉시 조회 경로와 전용 Mac의 300위 수집 경로는 같은 `mi.naver-shopping-organic-window.v1` 결과 계약을 사용합니다.
- 300위 워커의 성공 응답은 동일한 `collectionId`·`collectedAt`의 광고 제외 오가닉 1~300위 원자 목록이어야 합니다. 서버 상위 50위 응답은 확인 범위 밖을 완전 수집으로 표시하지 않습니다.
- exact 판매자 상품 ID와 실제 연결 원부 ID만 비교합니다. 제목·브랜드·카테고리 유사성으로 다른 상품을 붙이지 않습니다.
- 부분 목록, 순번 불연속, 중복 ID, 광고 혼입, 인증·스키마 오류는 순위와 이력을 변경하지 않습니다.
- NAVER API Hub에는 쇼핑 오가닉 300위 전체 목록을 반환하는 공식 API가 없습니다. Search·Search Trend·Shopping Insight 값을 상품 순위로 대체하지 않습니다.
- 유료 외부 수집기는 사용하지 않습니다. 별도로 검증된 공급자가 생긴 경우에만 `provider` 모드를 대안으로 검토합니다.

## 서버 상위 50위 경로

서버는 네이버 모바일 통합검색의 명시적 `SAS` 상품 슬롯만 읽습니다. 광고를 제외하고 1위부터 끊김 없이 검증된 최대 상위 50위 안의 exact ID만 즉시 확정합니다.

- exact hit: 해당 공식 순위만 사용할 수 있습니다.
- miss: 범위 밖으로 분류하고 기존 정상값을 보존합니다.
- 광고 및 비-SAS 슬롯: 순위 후보에서 제외하되 연속 범위 확인에는 슬롯 rank만 사용합니다.
- 검증 범위 밖: `없음`이나 새 순위를 저장하지 않습니다.
- 이 경로만으로 300위 전체 수집 성공을 주장하지 않습니다.

## 전용 Mac 300위 작업자

`scripts/naver-shopping-local-worker.mjs`는 전용 Mac의 독립 브라우저 프로필과 사용자가 직접 완료한 네이버 로그인 세션으로 정확히 300개를 수집합니다. 개인 Chrome 프로필을 빌리지 않으며 비밀번호·쿠키를 서버로 보내거나 CAPTCHA를 자동 우회하지 않습니다.

- 워커 요청은 HMAC 서명, 제한된 유효시간, 1회용 nonce를 사용합니다.
- nonce 재사용, 만료 서명, lease 상실, 299개 이하, 광고·중복·순위 공백, 중복 `collectionId`는 모두 거부합니다.
- 검증된 300개는 tracker와 snapshot을 DB 함수 하나에서 원자 반영합니다. 실패하면 기존 현재 순위와 30일 이력을 보존합니다.
- 오전 9시·오후 3시에 로컬 워커가 먼저 실행되고, 후속 재시도와 매시 안전 실행이 남은 due tracker를 처리합니다.
- 인증 프로필을 가진 Mac이 켜져 있고 사용자 세션이 유지돼야 새 300위 수집이 가능합니다. Mac이 꺼져 있어도 서버 상위 50위 즉시 경로와 기존값 보존 안전망은 계속 작동하지만, 새로운 51~300위 증거는 만들 수 없습니다.

## 릴리스 증거

코드·계약 검사는 실수집 성공 증거가 아닙니다. Production 반영 전에는 `collection_id`가 `pw-*`, `checked_count=300`인 최근 원자 snapshot, 광고 제외·연속 순번·정확 상품/원부 일치, 실패 시 기존값 보존을 확인해야 합니다. 현재 문서 기준으로 이 실증은 아직 대기 상태이며 배포·운영 정상화로 기록하지 않습니다.

## 변경 후 필수 검사

```bash
node --test src/server/naver-shopping/*.test.mjs src/server/handlers/naver-shopping-rank-runtime.test.mjs src/server/handlers/naver-rank-trackers.test.mjs src/server/handlers/naver-rank-cron.test.mjs
npm run check:rank-matching
npm run check:rank-cron
npm run check:server-contract
```
