# Test Evidence

## 2026-07-23 · NAVER API Hub 이중 호환 준비

- 공식 근거: 네이버 개발자센터의 최신 공지와 NAVER API Hub 명세를 기준으로 Search·Search Trend·Shopping Insight의 Hub 인증 헤더와 경로를 확인했다. 쇼핑 검색은 Hub 이관 제외이며 2026-07-31 24:00 종료·공식 대체 API 없음으로 별도 분리했다.
- 새 계약 검증: `legacy|hub|auto` 공급자 선택, 모드 누락·오타의 legacy 안전 기본값, 공급자별 URL·인증 헤더, nested Hub 오류 파싱, 401/403·404/410·429·5xx 운영 판정을 자동 검사한다. 쇼핑 검색은 Hub 경로로 보내지 않는 회귀도 고정했다.
- 기능 회귀: 새 어댑터·키워드·플레이스 폴백·통합 상태 대상 66/66, 전체 API·서버 178/178, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, N 상품·N 플레이스 30일 보호 잠금·공개 빌드·전체 `npm run check:release`가 통과했다. 변조 차단 self-test와 `git diff --check`도 최종 변경 기준으로 별도 재검증했다.
- 실제 호출: 로컬 legacy 자격증명으로 `써큘레이터?profile=trend`를 호출해 HTTP 200, provider `legacy`, Search Trend·Shopping Insight 정상, 경고 0건을 확인했다. NCP Hub 키가 현재 환경에 없어 Hub 인증 실호출·양 공급자 결과 비교는 완료로 주장하지 않는다.

## 2026-07-22 · 키워드 시장 3지표 프리미엄 요약

- UI 계약: 운영팀·광고주 키워드 조회 결과 상단을 `KEYWORD MARKET` 카드와 기존 연관 키워드 미리보기의 2열 구조로 정리했다. 카드에는 정확 월 검색량, 경쟁 상태, `검색 수요`·`경쟁 강도`·`판매 기회율` 3개 진행 바와 산정 근거·오인 방지 고지만 노출한다. 900px 이하에서는 1열, 520px 이하에서는 간격·문자 크기를 줄인다.
- 산정 계약: 검색 수요는 정확 월 검색량을 로그 스케일 1~100으로 변환한다. 경쟁 강도는 검색광고 경쟁도 60%와 쇼핑 상품수/검색량 포화도 40%를 결합한다. 판매 기회율은 수요 65%와 역경쟁 35%의 참고 점수이며 실제 주문·매출 전환율이 아니다.
- 누락 방어: 네이버가 검색량을 `<10` 같은 범위값으로만 제공하면 `Number(null)=0` 경로를 차단하고 검색 수요·판매 기회율을 `확인 필요`로 유지한다. 경쟁 근거만 있으면 경쟁 강도만 표시하며 데이터를 임의 생성하지 않는다.
- 대상 회귀: 신규 3/3 통과. 모든 점수 0~100 범위, 검색량 범위값 fail-closed, 동일 수요에서 낮은 경쟁의 판매 기회율이 더 높음을 검증했다. 운영팀·광고주 마커와 API `market` 계약을 릴리즈 기준선에 고정했다.
- 모바일 2차 검수: 390px 첫 운영 렌더에서 고정 폭 4열 때문에 연관 키워드가 글자 단위로 줄바꿈되는 결함을 발견했다. 키워드 열 최소 100px·말줄임과 보조 3열을 카드 실사용 폭에 맞춰 양 역할에 동일 적용해 문서·시장 카드·연관 표·3개 지표 바의 가로 넘침을 모두 0으로 유지했으며 해당 CSS를 기준선에 추가했다.
- 전체 릴리스 검사: API·서버 165/165, 플레이스 수집기 51/51, Production 인증 18/18, 역할 query parity, 서버 계약, 순위·크론·키워드 추이, 공개 빌드 8파일·인라인 6개/CSP 해시 4개와 전체 `npm run check:release`를 통과했다.
- 비변경 범위: N 상품·N 플레이스 30일 기능 잠금은 4개 함수·20개 파일·11개 마이그레이션으로 통과했다. 순위 수집·매칭·크론·DB 스키마·기존 추적 행과 이력은 수정하지 않았다.

## 2026-07-22 · 키워드 연령별 쇼핑 클릭 비중 정상화

- 운영 증상: Production `온열찜질기` 조회는 10대 0.2%·20대 4.3%·30대 15.8%·40대 29.0%·50대 이상 50.7%를 `최근 1년 연령별 검색 비율`로 표시했다. 화면 합계는 100%였지만 원본은 절대 클릭 구성비가 아니라 각 월 최고값을 100으로 둔 상대지수였다.
- 공식 근거: NAVER API Hub의 `키워드 연령별 트렌드 조회` 명세는 `/shopping/v1/category/keyword/age`의 `ratio`를 `구간별 결과에서 가장 큰 값을 100으로 설정한 상댓값`으로 정의한다. 따라서 월별 전체 클릭량 가중치 없이 12개월 상대지수를 더한 값은 1년 클릭 구성비로 해석할 수 없다.
- 수정 계약: 최신 완료 월의 한 구간 안에서만 10·20·30·40·50·60대 상대값을 합계 100%로 정규화하고 50·60대를 `50대 이상`으로 합친다. 부분 진행 월은 제외하고, 응답에서 빠진 0값 연령은 0%로 유지하며 완료 월이 없으면 null을 반환한다. API는 `ageBasis`와 실제 `agePeriod`를 제공한다.
- 자동 회귀: 진행 중인 월 제외, 0값 연령 생략 허용, 월말 완료 월 선택, 완료 구간 없음 fail-closed 4개 검사가 모두 통과했다. 전체 API·서버 158/158, 플레이스 수집기 49/49, 서버 계약 22/22, Production 인증 18/18, 역할 query parity, 키워드 추이, 순위, CSP 공개 빌드 8개 파일·인라인 6개/해시 4개와 `git diff --check`를 통과했다.
- 역할 검증: `admin.html`과 `client.html`은 동일하게 `연령별 쇼핑 클릭 비중`, 최신 완료 월 설명, `쇼핑 클릭 비중` 툴팁을 사용한다. 상품·플레이스 순위·30일 저장·로그인·권한·보고서·Supabase 스키마는 변경하지 않았다.
- 운영 배포: 코드 `a4d68f3`, `/health`·`/ready` 릴리스 `a4d68f324d9b`, Supabase ready를 확인했다. Production 관리자·광고주 HTML에 새 제목·설명·툴팁이 모두 존재하고 보호 키워드 API의 비인증 401도 유지된다. 배포 직후 브라우저는 로그아웃 상태여서 인증 데이터의 새 `agePeriod` 실응답은 다음 로그인 조회에서 확인한다.

## 2026-07-22 · 운영팀·광고주 로그아웃 로그인 화면 복귀 정상화

- 원인 확정: 광고주 `logoutClient()`의 성공 경로는 서버 쿠키와 코드만 제거하고 `clearClientAuth()`를 호출하지 않아 루트의 `is-authed`가 남았다. 서버 `/api/session?action=logout`은 기존에도 CSRF를 확인하고 Production·개발 쿠키를 모두 만료시켰으며 응답 어댑터도 복수 `Set-Cookie`를 보존하므로 이번 잔류 화면의 직접 원인은 클라이언트 상태 전환이었다.
- 즉시 안전 전환: 운영팀·광고주 모두 서버 요청을 먼저 시작해 CSRF를 보존한 뒤, 응답을 기다리지 않고 로컬 세션·민감 상태를 지우고 로그인 화면 최상단으로 이동한다. 서버 확인은 요청당 5초, 네트워크/5xx만 최대 2회이며 HTTP 성공과 JSON `ok=true`가 모두 맞아야 완료로 표시한다.
- 비동기 경합 방어: 로그인·복원·보고서 동기화·원본 파일 FileReader/서버 업로드·PPTX 생성·Owner/운영팀 계정 조회/생성/해제·Meta·키워드·SEO·N상품 1회 조회는 요청 시점 generation·role·scope를 캡처한다. 로그아웃 또는 다른 계정 재로그인 뒤 도착한 이전 응답은 화면·다운로드·`currentOperationTeam`·저장소에 반영하지 않는다.
- 교차 계정 초기화: 로그아웃 시 Meta 검색어와 요약, 키워드·SEO 입력, 상품 1회 조회 결과, 상품·플레이스 추적 URL, 검색·그룹 필터와 그룹 임시값을 지운다. 초기 세션 확인은 별도 잠금 함수로 처리해 기존 서버 세션 자동 복원 generation을 바꾸거나 입력을 지우지 않는다.
- 자동 회귀: `roleLogoutAlwaysReturnsToLogin`, `roleLogoutInvalidatesStaleAuthWork`, `roleLogoutBlocksLatePrivilegedAndToolResponses`, `clientLoginButtonsRespectSessionGeneration`, `clientSessionRestoreKeepsInitialGeneration`, `adminLoginFailureCanRetry` 기준선을 추가했다. 광고주·운영팀 인라인 스크립트 문법, 로그아웃 세션·CSRF·쿠키 계약, `git diff --check`를 통과했다.
- 전체 릴리스 검사: API·서버 154/154, 플레이스 수집기 44/44, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 순위 매칭, CSP 공개 빌드 8개 파일·인라인 스크립트 6개/해시 4개를 통과했다. 기존 상품·플레이스 순위 수집·스냅샷·DB는 변경하지 않았다.
- 2차 검수: 초기 자동 복원, 로그인 재시도 버튼, 모든 민감 도구 응답·다운로드, Owner/운영팀 계정 작업과 교차 계정 입력 초기화를 적대적으로 재검수해 P0/P1 0건을 확인했다.
- 운영 배포: 코드 커밋 `b052e85`, `/health`·`/ready` 릴리스 `b052e8597fb4`, Supabase ready, `/client`·`/admin` 200, 실제 상품·플레이스 추적 보호 API 비인증 401, 새 admin/client CSP 해시 일치를 확인했다.
- 실제 브라우저: 기존 `우노헬스케어` 광고주 서버 세션이 자동 복원되는 것을 확인한 뒤 로그아웃 버튼을 클릭했다. 즉시 로그인 화면으로 전환돼 `로그아웃되었습니다. 다른 대행사 코드를 입력해주세요.`가 표시됐고 입력창으로 초점이 이동했으며, 새로고침 뒤에도 로그인 화면 잠금이 유지됐다. 운영팀 페이지도 로그인 잠금 상태였고 양 페이지 콘솔의 사이트 오류는 0건이다. 운영팀 인증 세션의 실제 클릭은 별도 로그인 비밀값을 사용하지 않고 자동·독립 검수 근거로 한정했다.

## 2026-07-20 · 플레이스 실목록 오가닉 순위 근거 정상화

- 증상·DB 근거: 같은 키워드가 이전에는 62개였으나 최신 배치에서 9개만 확인됐고, `홍대 맛집`/`1907427831`은 미리보기 배열 7번째를 실제 7위처럼 저장했다. `부평 맛집`/`2019299673`도 9개 미리보기와 실제 목록이 달랐다.
- 원인 확정: 네이버 `/p/api/search/allSearch`는 지도 마커 미리보기이며 PC 장소 목록의 오가닉 정렬과 일치하지 않는다. 기존 selector fallback이 이 후보를 실제 목록 후보와 합쳐 미리보기 index를 순위로 확정했다.
- 추가 원인: 가상 목록을 처음부터 끝으로 점프하면 중간 장소 행이 DOM에 나타나지 않았고, `querySelectorAll("li")`는 실제 장소 카드 안의 `새로 오픈했어요` 중첩 프로모션 행까지 업체로 읽었다. 겹침 단계 스크롤로 모든 viewport를 수집하고 목록 최상위 `li`만 순위 후보로 제한했다.
- selector·타임아웃 재현: selector를 1ms로 강제 실패시킨 실조회에서 최초 9개 뒤 겹침 수집 68회로 100개까지 확장했고 top10 ID가 정상 경로와 10/10 일치했다. 정확 ID가 있는 상태로 `placeName`만 비운 실조회도 불필요한 상세 식별을 건너뛰어 39.827초·100개·rank null로 종료됐다. DOM 추출 오류는 빈 viewport로 삼지 않고 fail-closed로 재시도한다.
- 실목록 교차확인: 최종 독립 Chromium 세션과 수집기를 같은 시점에 대조했다. `홍대 맛집` 대상 `1907427831`은 양쪽 모두 오가닉 7위이고 top10 ID·순번 10개가 전부 일치했다. `부평 맛집` 대상 `2019299673`은 양쪽 모두 공개 목록 상위 100개에 없고 top10이 전부 일치했다. 프로모션에서 유입된 ID 없는 후보는 0개다.
- 수집 계약: 미리보기 후보는 순위 근거로 사용하지 않고 실제 `#_pcmap_list_scroll_container` 내부 최상위 행만 인정한다. ID 없는 실제 오가닉 행은 순번 슬롯으로 유지하되 body 메뉴·중첩 프로모션은 제외해 앞당김·밀림을 모두 막는다. 정확 대상 ID가 없으면 이름 유사도로 대체하지 않는다.
- 부분 조회: 300개를 완주하지 못한 미발견은 `complete=false`, `partial=true`, `rank=null`, `current_rank=null`로 저장하고 5분부터 재시도한다. 불완전 후보 목록은 캐시하거나 동일 키워드의 다른 추적 항목으로 전파하지 않는다.
- UI 계약: 운영팀·광고주 모두 부분 조회를 `N개 확인 · 이후 미검증`으로 표시한다. 최신 스냅샷이 null이면 현재 순위뿐 아니라 상태 요약·점검 필터·상승/하락·권고도 과거 `currentRank`를 사용하지 않는다. 두 역할 전용 helper·적용 경로·CSP 해시는 일치한다.
- 공개 범위 한계: 네이버 PC 공개 목록은 두 실조회 모두 오가닉 100개에서 종료돼 `complete=false`다. 따라서 확인된 순위는 정확히 기록하지만 미발견 대상의 101~300위는 `N개 확인 · 이후 미검증`으로 유지하고 5분부터 재시도한다.
- 자동 검증: API·서버 153/153, 플레이스 tracker 계약 42/42, 수집기 42/42, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 순위 매칭, 릴리즈 기준선, CSP 공개 빌드, `git diff --check` 통과. 미리보기 오인, ID 없는 실제 행의 순위 압축, body 메뉴·중첩 프로모션의 순위 팽창, 가상 목록 끝 점프, selector fallback 확장, DOM 추출 fail-closed, known-ID identity 생략, drain-mode degraded summary 전달을 각각 회귀 테스트로 고정했다.
- 2차 검수: 순위 수집·서버 저장·양 역할 UI를 분리 검수해 P0/P1 0건을 확인했다. 상품 N30 렌더 구간은 HEAD와 바이트 해시가 같고 상품 백엔드 diff도 없다. 기존 추적 행과 30일 스냅샷은 삭제·초기화하지 않았다.
- 운영 큐 재현: Vercel `8f0c6b5`·Render v14 반영 후 활성 13건의 `next_check_at`만 앞당겨 이력 비삭제 재수집을 실행했다. 첫 `부평맛집` 건은 오가닉 1위로 정상 저장됐지만 다음 `종로한의원` selector timeout 1건에서 workflow가 즉시 실패해 뒤의 11건이 미처리로 남았다.
- 큐 보강 계약: 개별 tracker 실패는 서버의 오류·지수 재시도 계약을 그대로 유지하면서 workflow가 다음 batch를 계속 처리한다. `totals.failed`는 queue drain 뒤 최종 실패로 보고하므로 오류가 성공처럼 숨겨지지 않는다.

## 2026-07-20 · 플레이스 검색결과 전체 업체 지표 정상화

- 원인: 수집기는 후보별 방문자·블로그 리뷰 값을 읽고 있었지만 대상 매장 또는 상위 일부 후보만 스냅샷에 전달했고, 양 역할 화면은 값 없음의 fallback `null`을 `Number(null)=0`으로 바꿔 실제 0처럼 표시했다. 외부 수집 경로에는 월검색량 보조 조회도 연결되지 않았다.
- 수집 계약: 광고를 제외한 실제 확인 오가닉 후보 전체에서 블로그·방문 합계를 계산하고 `scope=organic_search_results`, `businessCount`, 각 지표의 `knownCount/totalCount` coverage를 저장한다. 일부 후보 값이 누락되면 해당 합계는 null이며 명시적 0만 0으로 보존한다.
- 성능 보존: 합계는 전체 후보에서 계산하지만 `topPlaces` 저장은 기존 20개 제한을 유지한다. 신규 DB 컬럼·마이그레이션·기존 30일 스냅샷 재작성은 없다.
- 월검색량: 네이버 지도 응답에는 월검색량 필드가 없음을 실응답에서 확인했다. 서버가 기존 Search Ads 자격으로 키워드 월검색량을 별도 조회해 외부 수집 결과와 병합하고, 실패 시 리뷰·업체 지표 저장을 방해하지 않는다. `<10`처럼 범위로만 제공되는 값은 상한을 정확한 수치로 오인하지 않도록 null로 보존한다.
- 실조회 1: `부평 맛집`/플레이스ID `2019299673`은 대상 미발견·부분 조회를 유지하면서 오가닉 54개 전체 coverage 54/54, 블로그 56,310개·방문 173,749개·업체 54개를 반환했다.
- 실조회 2: `강남 맛집`은 오가닉 54개 전체 coverage 54/54, 블로그 61,503개·방문 145,192개·업체 54개를 반환했다.
- 자동 검증: 플레이스 서버 41/41, 수집기 35/35, 전체 API·서버 152/152, 서버 계약 22/22, Production 인증 18/18, 역할 parity, 릴리즈 기준선, CSP 공개 빌드, `git diff --check` 통과. 불완전·불일치 coverage 합계 거부와 검색량 `<10` 비확정 처리를 별도 회귀 테스트로 고정했다.
- 역할 검증: 운영팀·광고주 `placeSnapshotMetric`·일별 카드 출력은 동일하며 누락은 `-`, 명시적 0은 `0`으로 표시한다. 상품 순위·플레이스 순위 판정·광고 제외·기존 30일 이력은 변경하지 않았다.

## 2026-07-19 · 부평 맛집 플레이스·상품 원부 연속 추적 정상화

- 플레이스 대상: 키워드 `부평 맛집`, 정확 플레이스ID `2019299673`. 공식 상세 페이지에서 상호명 `팽오리농장 부평점`을 확인했다.
- 플레이스 실조회: 광고 제외 네이버 공개 목록 54개를 확인했으나 정확 ID는 없었다. 결과를 `complete=false`, `partial=true`로 유지해 300위 미노출을 거짓 확정하지 않고 기존 확정 순위를 보존한다.
- 플레이스 보완: 정확 ID가 있으면 같은 이름의 다른 ID와 ID 없는 후보를 거부하고, 입력 URL의 `lng/lat` 좌표와 좌표별 캐시를 사용한다. 외부 제공자의 일치 응답도 동일한 명시 ID를 필수로 하며 원본 오가닉 순위를 재번호화하지 않는다.
- 플레이스 상호명: 공식 모바일 상세의 리다이렉트와 최대 768KiB 응답을 제한적으로 읽어 상호명을 채우며, 네이버 응답 끝의 제어문자는 저장 전에 제거한다.
- 상품 대상: 상품ID `12649811979`, 최근 확정 원부ID `57907660073`. 과거 스냅샷의 `matched=true`, `rankPolicy=organic_only`, `adExcluded=true`, `trackingRankSource=related_catalog`을 모두 충족한 정확 원부ID만 이어받는다.
- 상품 실조회: `음파 전동칫솔` 원부 15위, `전동칫솔` 원부 25위, 정확 판매자 상품은 두 키워드 모두 상위 300위 밖이다. 정확 상품과 검증 원부는 같은 300개 응답에서 비교하며 제목이 비슷한 다른 원부와 광고 후보는 제외한다.
- 데이터 보존: `naver_rank_trackers`, `naver_place_rank_trackers`와 기존 스냅샷을 삭제·초기화하지 않았다. `admin.html`, `client.html`도 변경하지 않았다.
- 자동 검증: `npm run check:release` 통과. API·서버 147/147, 플레이스 수집기 32/32, 서버 계약 22/22, Production 인증 18/18, 공개 빌드와 `git diff --check` 통과.
- 복구 지점: 원격 태그 `checkpoint/rank-hotfix-20260719-2048`은 커밋 `3fb98b9`를 가리키며 `recovery:verify --quality`를 통과했다.
- 운영 배포: `/health`·`/ready` 릴리즈 `3fb98b9e4622`, Supabase ready, Render 릴리즈 `2026-07-19-exact-id-coordinate-rank-v11`, 관리자·광고주 HTTP 200, 보호 순위 API 비인증 401.
- 운영 상품 저장: `음파 전동칫솔` 현재 15위, `전동칫솔` 현재 25위. 두 최신 스냅샷 모두 원부ID `57907660073`, `checked_count=300`, `matched=true`, `trackingRankSource=related_catalog`, `rankPolicy=organic_only`, `adExcluded=true`다.
- 운영 플레이스 저장: 플레이스ID `2019299673`의 상호명은 `팽오리농장 부평점`, 현재·최고·최저 순위는 미검증이므로 null을 유지한다. 공식 GraphQL `start=71` 재요청은 HTTP 429여서 54위 이후를 임의 계산하지 않았다.

## 2026-07-15 · 메인 기능 쇼케이스 우선순위·그룹 보정

- 요청: 기능 쇼케이스를 신뢰 기준보다 먼저 노출하고, 현재 지표와 30일 추적을 별도 카드 묶음으로 구분하며 네이비 배경을 더 프리미엄하게 보정한다. 배포는 하지 않는다.
- 순서: `Hero → Product Intelligence → Trust Standard → Workflow → CTA`. 1440px 기준 기능 섹션 상단 744px, Trust 상단 1,795px로 기능이 먼저 노출된다.
- 그룹: `현재 데이터`는 오가닉 상품 순위·키워드 시장 분석 2장, `30일 순위 추적`은 상품 순위 추적·플레이스 순위 추적 2장으로 고정했다.
- 색감: `#071421 → #0a1e36 → #102b4b` 저채도 잉크 네이비, 약한 우측 하이라이트, 얇은 인셋 보더와 흰 카드로 위계를 분리했다.
- 데스크톱 1440×900: 두 그룹 각 2카드, 문서 가로 넘침 0, 기능/Trust 순서 정상, 콘솔 로그 0건.
- 모바일 390×844: 두 그룹이 세로로 분리되고 각 그룹 내부만 독립 가로 탐색(`clientWidth=313`, `scrollWidth=545`). 카드 4장의 내부 오버플로와 문서 가로 넘침 모두 0건.
- 회귀 기준선: `homeFeatureShowcasePriorityAndGroups=true`. 섹션 순서뿐 아니라 snapshot에 rank+keyword, tracking에 trend+place만 존재하는지 직접 검사한다. `homeAnonymousFeatureShowcase=true`도 유지한다.
- 독립 2차 검토: 순서·그룹·프리미엄 톤·반응형·익명화·기능 비변경에서 차단 이슈 없음.
- 비변경 범위: 팝업, `admin.html`, `client.html`, 순위 수집·매칭·저장·크론, Supabase·운영 데이터 변경 없음.
- Production: 커밋 `9cdbaad`, `momentinsight-8rljvs8ue-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 검증: `/health`·`/`·`/home.html`·`/admin.html`·`/client.html` HTTP 200, health `ok=true`·`supabaseReady=true`, 운영 HTML과 로컬 `dist` SHA-256 일치. 1440×900·390×844에서 그룹별 2카드·가로 넘침·카드 잘림·콘솔 오류 0건.

## 2026-07-15 · 메인 홈페이지 익명 기능 쇼케이스

- 요청: 상품 오가닉 단건, 상품 30일 추적, 플레이스 30일 추적, 키워드 시장 분석·차트를 메인 홈페이지에서 짧고 프리미엄하게 소개하되 실제 광고주 자료는 노출하지 않는다.
- 구성: `For Brand Growth` 3카드와 `Core Features` 4카드를 삭제하고 `Product Intelligence` 단일 섹션의 4개 예시 카드로 교체.
- 익명화: `예시 키워드 A/B/C`, `예시 상품 A`, `예시 매장 A`만 사용. 실제 고객명·상품명·키워드·가격·상품ID·원부ID·플레이스ID·조회 시각·외부 링크·스크린샷·상품 이미지는 포함하지 않음.
- 표시 고지: `data-mi-showcase-privacy=synthetic-only`, `예시 데이터`, `실고객 정보 미사용`, 모든 화면·명칭·수치가 기능 설명용 예시라는 문구를 함께 표시.
- 데스크톱 1440×900: 카드 4개가 2×2로 노출되고 1행 619×246px/439×246px, 2행 619×281px/439×281px. 문서 `scrollWidth=clientWidth=1425`, 전체 높이 3,107px.
- 모바일 390×844: 4개 카드가 각각 277×277px의 한 줄 가로 탐색으로 렌더링되고 첫·마지막 카드 육안검수 통과. 쇼케이스 375×725px, 내부 패널 347×423px, 문서 `scrollWidth=clientWidth=375`, 전체 높이 3,729px.
- 콘텐츠 검사: 쇼케이스 카드 4개, `<img>` 0개, 외부 링크 0개, 내부 텍스트 오버플로 0건, 브라우저 콘솔 로그 0건.
- 독립 2차 검토: 실제 광고주·상품·키워드·매장·ID·URL·이미지 노출, HTML/CSS 이상, 문서 가로 넘침, 운영/광고주·순위 기능 변경 차단 이슈 없음.
- 개인정보 기준선: 실고객 문자열 NFKC 정규화 차단, 9자리 이상 숫자, 외부 URL, 상품/원부/플레이스 ID 문구, 임시 파일·스크린샷 경로 금지. `homeAnonymousFeatureShowcase=true`.
- 자동 검사: `npm run check:quality`, `npm run build:vercel`, `git diff --check` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 비변경 범위: `admin.html`, `client.html`, `src/server`, 플레이스 수집기, Supabase·운영 데이터 변경 없음.
- 배포: 커밋 `8d78d01`을 포함한 최종 `9cdbaad` Production `momentinsight-8rljvs8ue-momentlabs.vercel.app` · 운영 별칭 반영 완료.

## 2026-07-15 · 메인 홈페이지 프리미엄 보완 2차

- 범위: `src/pages/home.html`, 홈페이지 전용 릴리즈 기준선, 운영 문서만 변경. `admin.html`, `client.html`, 순위 수집·매칭·저장·크론·Supabase 코드는 변경하지 않음.
- 문서 기반: `<!doctype html>`, `lang=ko`, viewport, body 여백 초기화 적용. 브라우저 계산 body margin `0px`.
- 팝업 보존: 데스크톱 1440×900에서 348×489px·x72·y118, 모바일 390×844에서 높이 489px·x14·y82·좌우 14px. 외곽 위치·너비 규칙·헤더/본문 여백, 다섯 기능, 카카오 링크, 저장 키와 7일 계산식 유지.
- 팝업 동작: 닫기 버튼과 `1주일 동안 안보기` 버튼을 각각 실행해 `is-hidden=true` 확인.
- 데스크톱: 고정 헤더 69px, 샘플 대시보드 528×529px, CTA 주 행동 버튼 흰색 배경/딥네이비 글자, 문서 `scrollWidth=clientWidth=1425`, 브라우저 콘솔 로그 0건.
- 모바일: 헤더 65px 한 줄, 버튼 2개 동일 행, 샘플 대시보드 347×494px. 반복 3개 카드는 내부 가로 탐색으로 정리하고 페이지 높이를 검증 환경 기준 약 5,498px에서 4,220px로 압축. 문서 `scrollWidth=clientWidth=375`, 외부 가로 넘침 0건.
- 시각 확인: 딥네이비·화이트·절제된 블루 계층, 핵심 매출 카드 강조, 연결형 신뢰 패널·운영 흐름, 실제 경로만 둔 푸터를 1440×900·390×844에서 육안 검수.
- 릴리즈 기준선: `homeDocumentShellAndViewport=true`, `homePopupGeometryPreserved=true`, `homePremiumHierarchyVisible=true`, 기존 `homeDevelopmentNoticeVisible=true`.
- 자동 검사: `npm run check:quality`, `npm run build:vercel`, `git diff --check` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 배포: 커밋 `530839f`를 포함한 최종 `9cdbaad` Production `momentinsight-8rljvs8ue-momentlabs.vercel.app` · 운영 별칭 반영 완료. 거절된 `0886833`은 미사용.

## 2026-07-15 · N 30일 순위 슬롯 `상품` 문구 정리

- 요청: 일별 오전·오후 슬롯의 `PM · 상품`에서 중복되는 `상품` 문구를 제거한다.
- 수정 범위: 운영팀·광고주 `renderRankSlot()`에서 정확 상품 슬롯만 `PM`·`AM`으로 표시. 관련 원부는 `PM · 원부`·`AM · 원부`로 유지.
- 기능 보존: `rankSnapshotSourceLabel()`과 카드 상단 상품/원부 표시, 순위 조회·저장·갱신·크론·광고 제외·대표값 판정·Supabase 데이터 코드는 변경하지 않음.
- 런타임 함수 검사: 양 역할 모두 정확 상품 `<small>PM</small><b>9위</b>`, 관련 원부 `<small>AM · 원부</small><b>8위</b>` 출력.
- 릴리즈 기준선: `rankTrackingDailySlotOmitsExactProductLabel=true`, 기존 `rankTrackingDailySlotAlignment=true` 유지.
- 브라우저 빌드: 광고주 390px `scrollWidth=390`, 운영팀 데스크톱·광고주 모바일에서 신규 마커 반영, 구 문구 제거, 콘솔 오류 0건.
- 자동 검사: 전체 `npm run check:quality` 통과. 서버 13/13, 플레이스 수집기 25/25, 크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 정상.
- 배포 커밋: `368408d`만 `main`에 푸시.
- Production: `momentinsight-jly55k3zm-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY. `/health` HTTP 200·`ok=true`.
- 운영 소스: `/admin.html`·`/client.html`·`/home.html`이 `368408d` 산출물과 바이트 단위로 일치하고, 두 역할 HTML 모두 신규 조건식 1개·구 조건식 0개.
- 운영 브라우저: 로그인 운영팀·광고주 `N 30일 순위` 각 414개 일별 슬롯에서 정확 상품의 `상품` 문구 0건, `PM`·`AM` 및 원부 구분 유지, 콘솔 오류 0건.
- 배포 후 자동 작업: GitHub 품질 검사, 상품 순위 갱신, 플레이스 순위 갱신 모두 성공.
- 로컬 이력: 사용자 거절 커밋 `0886833`의 홈페이지·기준선·작업 문서 변경을 `main`에서 제거하고, 현재 홈페이지 소스가 `origin/main`과 일치함을 확인.

## 2026-07-14 · N 30일 순위 오전·오후 행 정렬 복구

- 증상: `PM · 상품` 또는 `AM · 원부`처럼 선택 기준이 붙은 슬롯 라벨만 고정 폭에서 두 줄로 접혀 해당 순위 숫자가 인접 순위보다 아래에 표시됨.
- 원인: `.mi-rank-day-slots small`에 한 줄 제약이 없고, 108px 일별 카드의 반쪽 슬롯에서 기준 문구 너비가 사용 가능 폭을 초과함.
- 수정 범위: 운영팀·광고주 일별 슬롯 CSS의 수평 여백, 라벨 크기, `white-space`·오버플로 처리와 릴리즈 기준선만 변경.
- 기능 보존: 순위 조회·저장·갱신·자동 크론·광고 제외·원부/상품 대표 순위·Supabase 데이터 코드 변경 없음.
- 운영팀 로컬 저장 데이터: 보이는 일별 카드 207개, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 광고주 로컬 저장 데이터: 보이는 일별 카드 207개, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 390px: 운영팀·광고주 오전·오후 순위 상단 좌표 최대 차이 0px, 슬롯 라벨 오버플로 0건.
- 브라우저: 양 역할 데스크톱·390px 콘솔 경고/오류 0건, 육안 확인에서 `PM · 상품`과 `AM` 순위가 같은 행으로 표시됨.
- 자동 검사: `rankTrackingDailySlotAlignment=true`, 전체 `npm run check:quality` 독립 2회, 서버 13/13, 플레이스 수집기 25/25, 릴리즈 기준선·순위 매칭·크론·Vercel 정적 빌드 통과.
- `git diff --check`: 통과.
- 커밋: `01935d2` (`fix: align Naver rank daily slots`)을 `main`에 푸시.
- Production: `momentinsight-fhgibit9c-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 HTTP: `/health`·`/admin.html`·`/client.html` HTTP 200, 두 HTML의 한 줄 라벨·오버플로 방지 CSS 마커 확인.
- 운영팀·광고주 데스크톱: 각 207개 일별 카드, 오전·오후 순위 상단 좌표 최대 차이 0px, `PM · 상품` 포함 라벨 오버플로 0건.
- 운영팀 390px: 207개 일별 카드, 오전·오후 순위 상단 좌표 최대 차이 0px, 라벨 오버플로 0건.
- 운영 브라우저: 운영팀 데스크톱·390px, 광고주 데스크톱 콘솔 경고/오류 0건. 육안으로 첫 카드의 PM 4위·AM 4위 동일 행 확인.

## 2026-07-14 · 플레이스 30일 순위 컴팩트 프리미엄 UI

- 범위: 운영팀·광고주 `네이버 플레이스 30일 순위` 카드의 정보 밀도와 반응형 표시만 변경. 순위 수집·매칭·광고 제외·저장·갱신·삭제·그룹·공유 로직은 변경하지 않음.
- 데스크톱: 두 역할 모두 첫 카드 858×264px, 헤더 856×46px, 상태 영역 856×68px, 일별 셀 140×129px.
- 모바일 390px: 두 역할 모두 첫 카드 248×285px, 헤더 246×95px, 상태 영역 246×43px, 일별 셀 140×127px.
- 반응형: 문서 `scrollWidth=390`, 일별 기록과 상태 배지만 카드 내부 가로 탐색을 사용. 긴 수치 셀 오버플로 0건.
- 육안 확인: 딥네이비 현재 순위, 절제된 그레이 보조지표, 낮은 그림자와 작은 라운드, 헤더 2행·상태 1행 구조가 운영팀·광고주에서 동일하게 렌더링됨.
- 브라우저: 운영팀·광고주 데스크톱·390px 콘솔 경고/오류 0건.
- 릴리즈 기준선: `placeRankPremiumCompactCards=true`.
- 자동 검사: 전체 `npm run check:quality` 독립 2회 통과. 각 실행에서 서버 13/13, 플레이스 수집기 25/25, 릴리즈 기준선·서버 문법·크론·순위 매칭·키워드 트렌드·Vercel 정적 빌드 통과.
- `git diff --check`: 통과.
- 커밋: `7710008` (`style: compact Place rank tracking cards`)을 `main`에 푸시.
- Production: `momentinsight-m19imug8x-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`, READY.
- 운영 HTTP: `/health` 200, 리다이렉트 후 `/admin.html`·`/client.html` 최종 200, 두 HTML의 140px 카드·2×2 지표 마커 확인.
- 운영 데스크톱: 운영팀·광고주 모두 첫 카드 858×264px, 일별 셀 140×129px, 긴 수치 오버플로 0건.
- 운영 390px: 운영팀·광고주 모두 첫 카드 248×285px, 상태 영역 246×43px, 일별 셀 140×127px, 문서 `scrollWidth=390`, 상태 영역 `nowrap`, 긴 수치 오버플로 0건.
- 운영 브라우저: 운영팀·광고주 데스크톱·모바일 콘솔 경고/오류 0건.

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
- 커밋·배포: `d9b97ca`를 `main`에 푸시하고 Production `momentinsight-cjx4bkodl-momentlabs.vercel.app`을 운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다.
- 운영 검증: `/health`와 순위 API HTTP 200, 대표 원부 `53687717527` 8위·정확 판매자 상품 `11687310806` 59위·`checkedCount=300`·`rankPolicy=organic_only`.
- 운영팀·광고주 실화면: 두 역할 모두 원부 8위·정확 상품 59위 카드, 상품명 키워드 검색 링크와 각 상세 링크 정상, 콘솔 경고·오류 0건. 광고주 390px `scrollWidth=390`.

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

## 2026-07-20 플레이스 네이티브 오가닉 v16·네이버 API 공지 감사

- 순위 권위: `source=naver_map_pc_list_collector`, `rankEvidence=naver_pc_organic_list`인 네이버 PC 실제 장소 목록만 저장한다. 두 표식 중 하나라도 누락·불일치하면 `place_rank_provider_untrusted_evidence`로 실패하고 새 snapshot을 만들지 않으며 기존 current/best/check_count·30일 이력을 보존한다.
- 수집 예산: Vercel이 Render cold start를 포함한 절대 `providerDeadlineAt`을 전달하고, 수집기는 최대 225초 안에서 응답·브라우저 종료 여유 12초를 확보한다. viewport 1440×1600과 겹침 스크롤을 사용한다.
- 로컬 실조회 1차: `홍대 맛집`/`1907427831` 100개 확인·정확 ID 오가닉 7위·30.770초, `부평 맛집`/`2019299673` 100개 확인·미발견·rank null·31.024초. 두 결과 모두 네이티브 source/evidence를 반환했다.
- 육안 2차: 네이버 PC 목록의 상단 광고 3건을 순위에서 제외했고, 첫 오가닉 1~5위가 수집 결과와 일치했다. 동일 시점 독립 수집의 top10 ID·순서도 일치했다. 공개 목록이 100개에서 끝나므로 101~300위는 확정하지 않는다.
- 자동 검증: 전체 `npm run check:release` 통과. API·서버 154/154, 플레이스 tracker 43/43, 플레이스 수집기 44/44, 서버 계약 22/22, Production 인증 18/18, 역할 query parity·공개 빌드 CSP 통과.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, N상품 수집·대표값 판정, 기존 30일 snapshot 조회·저장 로직은 diff 없음.
- 독립 코드 재검수: 최초 P1이었던 공급자 근거 미강제를 보완한 뒤 P0/P1 0건으로 통과했다.
- 공식 메일 확인: 발신자·공지 링크를 네이버 개발자센터 공식 공지와 대조했다. Search Trend·Shopping Insight·일반 Search 일부는 NAVER API Hub 이관 대상이지만 쇼핑 검색은 별도 공지상 이관 제외, 2026-07-31 종료, 대체 API 없음이다.
- 2026-07-20 legacy 실호출: 기존 Search Trend·쇼핑 검색은 HTTP 200으로 응답해 이번 플레이스 오류의 직접 원인이 아님을 확인했다.
- 공식 근거: `https://developers.naver.com/notice/article/32530`, `https://developers.naver.com/notice/article/32564`, `https://guide.ncloud-docs.com/docs/apihub-migration`.
- 운영 배포: Vercel `/health`·`/ready` 릴리즈 `bfa97e38304d`(기능 코드 `5014d1a` 포함), Supabase `ready`; Render `/health` 릴리즈 `2026-07-20-native-organic-deadline-v16`, `configured=true`, `busy=false` 확인.
- 운영 snapshot: `홍대 맛집`/`1907427831`은 `checked_count=97`, `rank=7`, `matched=true`; `부평 맛집`/`2019299673`은 `checked_count=77`, `rank=null`, `matched=false`. 두 source 모두 `naver_map_pc_list_collector`, place ID 정확 일치, 블로그·방문 coverage 전체 충족.
- 이력 보존: 과거 `_fallback` snapshot은 그대로 남겼고 새 v16 snapshot만 추가했다. 현재값·best·기존 30일 기록 삭제·소급 재작성 없음.
- workflow 판정: 두 호출과 저장은 정상 완료했으나 `부평 맛집`의 300위 미완주를 숨기지 않도록 `partial>0` 정책이 첫 실행을 경고 실패로 종료했다. transport·provider 오류와 tracker `last_error`는 없음.

## 2026-07-22 플레이스 의료 키워드 네이티브 경로 정상화

- 운영 데이터 진단: 플레이스ID `1531240094`의 `종로3가한의원`·`종로한의원` 추적은 각각 retry 31회·30회, snapshot 0건이며 마지막 오류는 모두 `#_pcmap_list_scroll_container` 8초 timeout이었다. 기존 추적 행과 이력은 삭제·수정하지 않았다.
- 직접 원인: 네이버 실제 검색 화면은 두 키워드를 `https://pcmap.place.naver.com/hospital/list`로 열고 정확 ID `1531240094`를 목록에 포함한다. 기존 수집기는 이를 `place/list?display=300`으로 다시 열어 `조건에 맞는 업체가 없습니다` 페이지로 리디렉션됐다.
- 수정 기준: 검색 화면이 만든 정확한 HTTPS `pcmap.place.naver.com` 목록 URL만 허용한다. `hospital/list`는 네이티브 `display=70`, `clientX`·`clientY`·`searchText` 문맥을 보존하고, `restaurant/list`는 기존 `display=300` 확장을 유지한다. 호스트 문자열만 포함한 비네이버 URL은 거부한다.
- 대상 실조회: 광고 제외 네이버 PC 오가닉 목록에서 `종로3가한의원` 3위, `종로한의원` 12위이며 두 건 모두 정확 ID `1531240094`, `source=naver_map_pc_list_collector`, `rankEvidence=naver_pc_organic_list`다.
- 2차 회귀: `홍대 맛집`/`1907427831`은 100개 확인·7위, `부평 맛집`/`2019299673`은 100개 확인·미발견·partial이며 기존 진실 표기가 유지됐다.
- 자동 검증: 플레이스 수집기 47/47, API·서버 154/154, 서버 계약 22/22, Production 인증 18/18, 전체 `npm run check:release`, 공개 빌드·역할 parity·`git diff --check` 통과.
- 변경 비범위: `src/pages/admin.html`, `src/pages/client.html`, 서버 snapshot 저장 계약, Supabase 스키마, N상품 순위와 기존 30일 기록은 변경하지 않았다.

### 느린 운영 프레임 회귀 검증

- 운영 v17 재실행: 두 tracker 모두 selector 8초 timeout 재현. 원인은 네이티브 프레임 6초 대기 만료 뒤 일반 목록 URL을 만든 폴백이었다.
- 단위 회귀: 첫 네이티브 프레임 미발견 후 두 번째 검색 성공, 두 번 모두 미발견 시 fail-closed를 각각 검사한다.
- 플레이스 수집기: 49/49 통과.
- 전체 `npm run check:release`: 통과. API·서버 154/154, 서버 계약 22/22, Production 인증 18/18.
- 로컬 실제 네이버 PC 오가닉: `종로3가한의원` 3위, `종로한의원` 10위, 각각 70개 확인·정확 ID `1531240094` 일치.

### v18 Production 저장 증거

- Render `/health`: `release=2026-07-22-native-medical-list-v18`, `configured=true`.
- Vercel `/health`: `release=b7919bc86348`, HTTP 200.
- `종로3가한의원`: 2026-07-22 15:51 KST, 오가닉 3위, 정확 ID `1531240094`, `matched=true`, `checked_count=70`, `source=naver_map_pc_list_collector`.
- `종로한의원`: 2026-07-22 15:56 KST, 오가닉 10위, 정확 ID `1531240094`, `matched=true`, `checked_count=70`, `source=naver_map_pc_list_collector`.
- 두 tracker 현재 상태: `retry_count=0`, `last_error=null`, `check_count=1`, `found_count=1`, 처리 임대 해제, 다음 정규 실행 2026-07-23 09:00 KST.

## 2026-07-22 N 상품·N 플레이스 30일 보호 잠금·운영 배포

- 잠금 의미: `scripts/check-protected-rank-features.mjs`는 보호 코드의 해시와 새 순위 마이그레이션을 빌드·릴리스에서 검사할 뿐 런타임 요청 경로에는 포함되지 않는다. 신규 키워드 조회, N 상품 단건 조회, N 상품·플레이스 추적 등록과 갱신은 계속 허용한다.
- 회귀 고정: 기준선 `rankFeatureLockIsBuildOnlyAndUsageStaysOpen`이 운영팀·광고주 신규 키워드 조회 버튼, 상품 단건 조회, 상품·플레이스 추적 등록 버튼과 양 서버의 `action=create` 경로를 확인한다.
- 자동 검증: 정상 잠금 4개 함수·20개 파일·11개 마이그레이션, 의도적 변조 self-test 차단, API·서버 162/162, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 역할 parity·공개 빌드·CSP 통과.
- 배포 빌드: Vercel CLI가 수집기 `.dockerignore`를 업로드에서 제외하는 환경 차이를 확인했다. 로컬·CI는 실제 `.dockerignore`와 `dockerignore.policy`의 완전 일치를 강제하고, Vercel은 같은 정책 사본을 검사하도록 보완해 공급망 검사를 우회하지 않았다.
- 운영 API: `/health` HTTP 200·`release=f8bf0a3b37a1`, `/ready` HTTP 200·Supabase ready, 상품·플레이스 보호 API 비인증 401.
- 운영 UI: 홈페이지 팝업 348×489px, `N 상품 순위`·`N 30일 순위`·`N 플레이스 30일 순위` 각 1건, 1280px 가로 넘침 0. 총관리자에서 신규 키워드 조회·상품 추적·플레이스 추적 버튼 모두 활성, 기존 상품 추적 25개·플레이스 추적 10개와 30일 이력 로드 확인.
- 배포: Production `https://momentinsight-idchb9x5n-momentlabs.vercel.app`, 운영 별칭 `https://insight.momentlabs.co.kr`. 이번 범위는 Render 수집기 런타임 변경이 없어 Render는 재배포하지 않았다.

## 2026-07-23 4대 핵심 조회·추적 기능 변경 잠금 확장

- 보호 범위: 운영팀·광고주의 `runKeywordLookup`, `initRankCheck`, `initRankTracking`, `initPlaceRankTracking`과 키워드 API Hub 핵심 함수, 키워드·상품 단건·상품/플레이스 30일 서버·크론·수집기·워크플로·순위 DB 마이그레이션을 13함수·21파일·11마이그레이션으로 고정했다.
- 잠금 의미: 런타임 버튼이나 API를 닫는 기능이 아니다. 승인 없이 보호 코드를 바꾸면 `check:quality`와 `check:release`가 실패하며, 신규 키워드 조회·N 상품 순위 조회·상품/플레이스 추적 등록·갱신과 보호 범위 밖 신규 기능은 계속 동작한다.
- 변조 2차 검수: self-test가 13개 보호 함수와 21개 보호 파일을 각각 하나씩 변조해 모두 차단했고, 가상 신규 순위 마이그레이션도 자동 탐지했다.
- 사용 경로 회귀: 운영팀·광고주 양쪽에서 4개 기능 진입 함수와 버튼, 상품·플레이스 `action=create` 및 갱신 경로를 확인했다. 빌드 잠금 스크립트는 페이지·키워드·상품·플레이스 런타임 소스에 포함되지 않는다.
- 전체 자동 검증: API·서버 179/179, 플레이스 수집기 51/51, 서버 계약 23/23, Production 인증 18/18, 역할 parity, 기준선 `rankFeatureLockIsBuildOnlyAndUsageStaysOpen`, 공개 빌드·CSP와 전체 `npm run check:release`가 통과했다.
- 변경 비범위: 실제 키워드 조회·상품 순위 계산·상품/플레이스 수집·스냅샷 저장 코드와 `src/pages/admin.html`, `src/pages/client.html`, Supabase 데이터는 수정하지 않았다.
- 운영 배포: 사용자 승인 후 코드 `6c5d10d`를 원격 `main`과 Production `https://momentinsight-htm9llc9v-momentlabs.vercel.app`·운영 별칭 `https://insight.momentlabs.co.kr`에 반영했다. 운영 `/health`와 `/ready`가 릴리스 `6c5d10d1deef`, live, Supabase ready를 반환했다.
