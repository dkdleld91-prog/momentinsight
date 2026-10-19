# 연관 키워드 양방향 정렬 화살표

기준: `4f40ca8eaac90dddcf46f15622953a1f960bcb62`. 사용자 요청: “오름차순 내림차순 화살표도 넣어주세요”. 추가 배포 질문에 사용자가 “검수 후 배포”로 승인했다. 아래 전체 gate 통과 후 정상 Git main fast-forward 단일 배포를 진행한다.

## 변경 범위

- admin/client 연관 키워드 표의 키워드·통합 월 검색량·PC·모바일·광고 평균 클릭·광고 클릭률 6개 열에 native button을 추가한다.
- 현재 열 `↑` 오름차순 / `↓` 내림차순, 미선택 열 `↕`. 같은 열 재클릭은 방향 전환, 다른 숫자 열은 내림차순·키워드 열은 가나다순으로 시작한다. 상단 정렬 선택과 헤더가 동기화된다.
- 실제 수치 0은 유효하다. null/미제공/`<10` 등 비공개 정확 수치는 양방향 모두 마지막에 둔다. 같은 값은 입력 순서를 유지하며 원본 배열은 수정하지 않는다.
- 광고 경쟁도 필터와 현재 행 집합을 유지하며 화면 내에서만 정렬한다. 정렬로 네이버/API/순위 수집 요청을 추가하지 않는다. CSV 스키마·데이터는 유지하고 현재 화면 순서로 내보낸다.
- `aria-sort`, 다음 클릭 방향을 알리는 접근성 이름, Enter/Space, 모바일 터치 대상을 검수한다.
- 기존 inline app·CSP·키워드 조회·순위 추적·backend·DB·환경변수·runtime·scheduler·vercel 설정은 변경하지 않는다. 사용자 원본 dirty checkout은 보존한다.
- 보호 문서를 재작성하는 `work:autosave`는 실행하지 않고 이 전용 문서로 기록한다.

## 검수 진행

- RED: 기존 UI23개 PASS, 신규 헤더·순수 정렬 API 2개 FAIL 확인 후 구현했다.
- UI26/26·관련 source/handler42/42 PASS. admin/client PC1440·mobile390 브라우저6개 검사 PASS: 6개 필드 양방향, Enter/Space/tap, 화살표·접근성 상태·상단 선택 일치, 필터 유지, CSV 현재 순서, null/비공개 수치 마지막, 실제0 보존, 원본행 불변·중복/누락0, 정렬 추가 API0.
- 독립 read-only 검토 P0/P1 blocker0. 별도 경계6건도 PASS. 기존 inline app 및 CSV helper는 기준 commit과 byte-identical, backend/순위 추적 수정0이다.
- 원본 dirty checkout 보호9개 파일의 SHA256·권한은 배포 전 보존 기준과 모두 동일하다. `check:release` exit0: core3174/3174·Place59/59·Shopping104/104=3337/3337, fail0/skip0, production-auth18/18·public build PASS. 보호잠금23함수/144파일/91migration·server contract74/74 PASS.
- 증거: `/Users/sindongbin/Documents/모먼트 인사이트/.codex-deployments/related-sort-20261019/`의 `red-tests.log`, `ui-tests.log`, `related-source-handler-tests.log`, `browser-smoke.log`, admin/client PC/mobile PNG4개. 캡처를 직접 확인했다. 테스트 응답·로컬 캡처는 운영 실데이터 증거로 보고하지 않는다.
- 원격 main exact4f40ca8을 확인했다. 배포 exact SHA·단일 deployment·운영 HTTP/실제 UI 결과는 `/Users/sindongbin/Documents/모먼트 인사이트/.codex-deployments/related-sort-20261019/deployment-state.md`에 기록한다. 배포 뒤 증거 기록을 위한 추가 commit/build는 만들지 않는다.
