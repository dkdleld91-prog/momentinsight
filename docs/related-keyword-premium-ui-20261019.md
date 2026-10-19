# 연관 키워드 화면 정리·프리미엄 UI

상태: ‘활용’ 목업 승인에 따른 실제 기능 구현·배포 전 검수 완료. 기준 b98de46. 사용자 최신 승인 “좋습니다 배포해주세요”. 아래 증거를 바탕으로 정상 FF 배포를 진행한다.

- 사용자 요청: 확인 필요 원인 설명, 표 제목 카테고리, 반복 설명3줄 제거, 기존 플랫폼의 프리미엄 UI 개선.
- 기존 키워드/순위 수집/카테고리 판정/DB·API·CSV 계약은 보존한다. 추가 호출·비용·추정 없음.
- 운영 DOM 읽기(추가 검색 없음): 전기매트30개 중 단일3/복수0/확인필요27. 27개 모두 저장 표본 없음/0개였고 탄소매트·카본매트·전기요만 실제 경로와 표본5/5였다.
- 현재 재사용 범위는 허용 계정+정확한 동일 키워드+최근24h+검증된 top5다. 새 연관어 대부분이 이 저장 범위와 겹치지 않는다. 네이버 카테고리 없음이나 서버 오류라고 단정하지 않는다.
- 행 설명은 제거하되 미확인/복수/부분근거 상태는 남긴다. 상세 근거는 CSV와 화면 하단 안내1곳에 보존한다. 저장source 타입30개를 분류완료30개로 오인할 수 있는 status suffix도 삭제한다.
- 원본 dirty/보호 문서는 보존한다. work:autosave가 보호 문서를 재작성하므로 이 전용 문서에 기록한다.
- 검수: compact RED→GREEN, 양 화면/기존 inline·CSP/CSV/필터·키보드·모바일·오류·계정변경, source/handler 및 기존 keyword/rank 회귀, 전체 quality/독립검토/diff 확인.
- 개발 미리보기의 검수 예시와 실운영 결과를 구분한다. 이번 디자인 변경은 운영 배포 전에 확인받는다.

## 구현·검수 근거

- admin/client 공통 관련 화면에서만 scoped CSS를 적용한다. 기존 왼쪽 메뉴·다른 화면·inline application·CSP·CSV 함수는 기준 commit과 동일하다.
- `중분류 > 소분류` 표 제목을 `카테고리`로 변경했다. 행의 상시 표본/수집일/출처 설명은 제거했다. 저장 근거를 분류완료 건수로 오인할 수 있는 요약 suffix도 제거했다.
- 미확인 사유는 native details 배지, 부분근거는 복수 경로 details 안에 보존한다. 기본은 접힘이며 Enter·390px touchscreen tap으로 열기/닫기를 검증했다. CSV의 원인·경로·표본수·시각·기준은 그대로다.
- compact RED→GREEN 후 최종 UI16/16, admin/client browser6개 검사 PASS. PC1440/mobile390·필터·CSV·오류·키보드·터치·페이지 가로넘침0·작은 글자 대비4.5 이상을 확인했다.
- 독립 검토 P0/P1 blocker0. 지적된 작은 글자 대비(최종5.07~5.19:1)와 title-only 사유 접근성 P2도 보완/재검증했다.
- 기존 원본 checkout 보호9파일 SHA256·mode 모두 배포 전 기준과 동일하다. 이번 작업의 backend/수집/runtime/DB/migration/환경변수/vercel 변경0이다.
- 증거: `/Users/sindongbin/Documents/모먼트 인사이트/.codex-deployments/related-premium-ui-20261019/`의 a11y unit/browser log 및 admin-shell-desktop.png. 실제 플랫폼 shell을 사용한 캡처이며 눈에 보이는 개발본·검수 예시 표기가 있다. 운영 조회나 추가 네이버 수집은 실행하지 않았다.
- 전체 `check:quality` exit0: core3164/3164·Place59/59·Shopping104/104, 합계3327/3327·fail0·skip0. 보호잠금23함수/144파일/91migration, contract74/74, public build PASS. 전체검사 뒤 최종 동결 소스 UI16/16·browser6개도 재실행해 PASS했다.
- 최종 증거는 `check-quality.log`, `final-ui.log`, `final-browser.log`다. 신규 commit/push/배포는 미실행이다.

## 승인된 활용 구성 운영 반영

- 카테고리 기본 열·3개 분류 필터를 제거하고, 실제 연관어의 복사/상세분석 버튼 및 광고경쟁도 필터를 적용한다. 실제 지표와 CSV의 카테고리 원문/표본/기준 계약은 보존한다. 목업 예시 데이터는 반영하지 않는다.
- 복사는 실제 clipboard Promise 성공 뒤에만 완료를 알리고, 실패/2초 미확인은 실패 안내로 유한 종료한다. 자동 재시도/우회 복사 없음. 계정/조회 변경 뒤 늦은 피드백은 버린다.
- 상세 분석은 기존 링크와 input.value만 사용한다. input/change를 dispatch하면 SEO·순위 등록 폼까지 동기화되는 기존 부작용이 있어 dispatch하지 않는다. 자동 키워드 조회/순위등록/수집 실행0이다.
- 기존 키워드 화면의 작은 신규 handoff aside에 선택 키워드·아직 조회 전·이전 결과 잔존 가능을 명시한다. 확인된 카테고리만 접힌 참고 정보로 보존한다. 새 조회 버튼/직접 입력/세션 종료 뒤 이 안내는 지운다.
- backend/DB/env/collector/runtime/scheduler/vercel/원본 dirty/보호문서 변경은 제외한다. 이 전용 문서로 기록하여 보호 문서를 재작성하는 work:autosave는 실행하지 않는다.
- 기존 Git main Production 자동 배포를 사용한다. 검수 완료·최신 main 확인 뒤 정상 fast-forward push 1회, 생성된 단일 deployment의 종료 확인 및 운영 검증을 수행한다.
- 최종 `check:release` exit0: core3171/3171·Place59/59·Shopping104/104, 합계3334/3334·fail0·skip0, production-auth18/18, public build PASS. source/handler42/42·UI23/23·양 surface browser6개 PASS, 독립 P0/P1 blocker0.
- 경쟁도 옵션은 API 원문에서 동적으로 생성하여 `중간`과 `보통`을 임의 통합하지 않는다. late copy·숨겨진/위조 row·목적지 누락·input/change/submit0·세션변경·CSV 원문을 추가 회귀로 확인했다.
- 운영 배포의 exact SHA·deployment 및 후속 실검증은 `/Users/sindongbin/Documents/모먼트 인사이트/.codex-deployments/related-actions-20261019/deployment-state.md`에 기록한다. 배포 뒤 기록 커밋으로 중복 Production 빌드를 만들지 않는다.
