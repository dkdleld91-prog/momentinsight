# Moment Insight N Shopping Chrome Bridge

이 확장 프로그램은 사용자가 평소 사용하는 Chrome 프로필에서 네이버쇼핑 공개 검색 결과의 `__NEXT_DATA__`만 읽습니다.

- 비밀번호, 쿠키, localStorage, 방문 기록을 읽지 않습니다.
- 검색 결과 탭은 비활성 상태로 열고 수집 직후 닫습니다.
- 광고를 제외한 오가닉 1~300위가 연속일 때만 macOS Native Messaging으로 로컬 연결기에 전달합니다.
- HMAC 비밀키는 macOS 키체인에만 있으며 확장 프로그램에는 포함되지 않습니다.
- 오전 9시·오후 3시는 사용자 안내 기준입니다. 내부에서는 30분마다 전체 활성 대기열을 확인하고 키워드 1개씩 순차 처리합니다.
- 네트워크 제한·418·429는 단계형 보호 대기 후 1건만 재개하고, CAPTCHA·보안확인은 자동 우회하지 않습니다.
- macOS 또는 Chrome이 꺼져 있으면 신규 51~300위 수집은 멈추고, 다음 실행 때 due tracker를 따라잡습니다.

설치 전 `node scripts/install-naver-shopping-chrome-bridge.mjs`를 실행한 뒤 Chrome의 `확장 프로그램 관리`에서 개발자 모드로 이 디렉터리를 한 번 로드합니다.
