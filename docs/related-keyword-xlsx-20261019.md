# 연관 키워드 Excel·최대50개 배포 기록

기준 HEAD/운영 release: `963e131c12a08c091a643ad19f67536a41ebc53d`.
사용자 승인: 기존 테스트의1ms 불일치를 수정하고 전체 검수 후 개선된 Excel을 배포한다. Excel의 카테고리 근거 시트는 제거하고 실제 연관 키워드는 최대50개로 늘린다. 기존 키워드 조회·순위추적은 유지한다.

추가 승인: C30일 순위를 기존 '실험실 · 개발 중' 메뉴로 옮긴다. C30 화면/권한/수집은 수정하지 않고 기존 hidden 게이트/주소/데이터를 보존한다. client에 새 C30 노출은 만들지 않는다.

## 구현 범위

- 이전 예시14행은 경쟁도 '중간' 필터가 적용된 실제 데이터였다. 운영 코드에는 별도로30개 상한이 있었다. 연관어 전용 서버/브라우저/export 상한을50개로 바꾸며, 원천 응답이50개보다 적으면 실제 수만 제공하고 패딩하지 않는다.
- 현재 검색 필터·정렬 순서의 표시 행을 내보낸다. 전체50개와 필터 표시25개 등을 분리해 표시한다. 데이터 추가 조회 없이 현재 응답을 사용한다.
- 다운로드는 실제 OOXML `.xlsx`의 `연관 키워드` 단일 시트다. 번호/키워드/통합·PC·모바일 월검색량/광고경쟁도/광고평균클릭수/광고클릭률 8열, 네이비 헤더와 흰 본문, 통합검색량 강조, 숫자 오른쪽/번호·경쟁도 중앙, 헤더·키워드 고정/필터를 유지한다.
- 카테고리 근거 시트·XML·관계·ContentType 및 categoryRows 내보내기 입력을 제거한다. 기존 API/화면 분석의 카테고리 정보와 exact/복수/확인필요 구분은 유지한다.
- 숫자는 numeric, CTR은 fraction+`0.00%`, 실제0은0, 비공개/미확인/표시 불일치는 원문으로 유지한다. 원 조회시각을 모르면 내보낸 시각으로 대체하지 않는다.
- 브라우저 생성기는 고정6part ZIP/CRC32이며 외부 라이브러리/CDN/네트워크/수식/매크로/외부링크를 사용하지 않는다. 51행·희소/중복/부정확번호·invalid XML·과대한 문자열/409pt초과는 유한 거부한다.
- 단일 SearchAd 응답에서 최대50개를 추출한다. 추가 네이버 호출·추정 연관어·임의 지표는 없다. 저장 카테고리 adapter의 입력 bound만50으로 맞추고 GET3회 이하/트래커60행/시간·계정·exact키워드·provenance 경계는 유지한다.

## 1ms 테스트 수정

- 실제 원인은 테스트 fixture가 requested_at/expires_at을 별도 `clock_timestamp()`로 평가해 exact24h CHECK에서1ms 어긋난 INSERT였다. 제품 동작 검증 전 fixture setup 실패다.
- 동일 파일의 같은 원인4곳은 materialized CTE의 한 시각을 재사용한다. 운영 migration/DB 함수/랭크 로직/CHECK/기존 행동 기대는 변경하지 않는다.
- 실제 CHECK가24h+1ms를23514로 거부하고 exact24h를 허용하는 경계 회귀를 추가했다. 해당 테스트 파일16/16 PASS. 이전 단독 재실행으로 우회한 것이 아니라 원인을 수정했다.

## 보존 경계와 검수

- 실제 작업은 격리 worktree이며 원본 dirty checkout의 보호9파일 SHA256/권한을 보존한다. 보호 문서를 재작성하는 work:autosave 대신 이 전용 기록을 사용한다.
- paired admin/client의 기존 inline 앱·CSP/권한·기존 키워드 일반모드·랭크 수집/갱신/runtime/scheduler/DB/env/vercel·개인 일정·unrelated Google은 수정하지 않는다.
- source/handler/stored-category MAX50 RED→GREEN51/51, UI33/33, writer19/19의 대상 회귀를 확인했다. 양 화면 PC/mobile 브라우저의 실제 XLSX/50·필터25행 검증과 전체 check:release 및 독립 P0/P1 검토를 진행한다.
- max50+1ms 전체 1차 release는 core3204/3204·Place59/59·Shopping104/104=3367/3367·fail/skip0, auth18/18·public31파일 PASS였다. 이후 C30 메뉴 추가 요청을 반영했으므로 이 결과를 최종 소스 전체 검수로 대신하지 않고 새 전체 release 검사를 실행한다.
- 양 화면 브라우저8검사·실제 다운로드10파일은 단일 시트/전체50·필터25·정렬·행 순서·원값·숫자/CTR을 확인했다. 추가 API/순위 요청0(mock). 독립 openpyxl 재열기10파일 모두 PASS이고 실제 Excel 앱 실행으로 과장하지 않는다. Artifact Tool은 브라우저가 생성한 원본 XLSX를 읽기 전용 import/recalculate/render해 첫/마지막50행 가독성을 확인했다. 도구 export로 runtime 파일을 대체하지 않는다.
- C30은 일반 순위 그룹에서 lab으로 링크1개만 이동하고 '(개발중)'을 붙였다. 기존 메뉴 고정 테스트도 새 계약에 맞춰 hidden/중복0/N30·P30 위치 보존으로 강화했다. 신규4개 포함 C30 관련78/78 PASS, 기존 화면·inline·역할노출 동일. 최종 전체 검수 및 독립 최종 diff 검토 뒤 함께 배포한다.
- C30 포함 최종 `check:release` exit0: core3208/3208·Place59/59·Shopping104/104=3371/3371·fail0·skip0, auth18/18·public build31파일 PASS. 대상103/103·C30 별도 독립71/71·XML/CRC·원본 보호9파일/권한 동일 및 독립 P0/P1 blocker0까지 확인했다. 최종 diff 검토 후 배포 단계로 이동한다.
- 전체 검수와 diff 검증 완료 전 commit/push/배포하지 않는다. 그 뒤 normal fast-forward push1회가 생성한 Git Production 배포1건만 추적하며, 추가 CLI deploy/promote는 하지 않는다. 운영 exact release·health/ready·양 화면 assets/실제 연관어50/필터/단일시트 XLSX를 검증한 뒤 결과를 기록한다.
- 증거 폴더: `/Users/sindongbin/Documents/모먼트 인사이트/.codex-deployments/related-xlsx-20261019/`. 이전 두 시트 디자인과 거절된 예시는 과거 이력이며 이번 최종 계약에 포함하지 않는다.
