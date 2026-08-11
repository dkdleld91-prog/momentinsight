# Moment Insight N Shopping Chrome Bridge

이 확장 프로그램은 전용 Chrome 프로필에서 네이버쇼핑 공개 가격비교 결과의 `__NEXT_DATA__`만 읽습니다.

- 비밀번호, 쿠키, localStorage, 방문 기록을 읽지 않습니다.
- 각 키워드는 검증된 `search.shopping.naver.com/search/all` 1~8페이지를 순서대로 확인합니다.
- 검색 결과 탭은 비활성 상태로 열고 수집 직후 닫습니다. 내부 작업 화면이나 흰 controller 탭을 사용자 앞에 열지 않습니다.
- CAPTCHA·보안확인·접속 제한을 감지한 경우에만 해당 네이버 탭을 앞으로 표시하며 자동 우회하지 않습니다.
- 광고를 제외한 오가닉 1~300위가 연속일 때만 Native Messaging 로컬 연결기로 전달합니다.
- HMAC 비밀키는 Windows 현재 사용자 DPAPI 또는 macOS 키체인에만 있으며 확장 프로그램에는 포함되지 않습니다.
- 오전 9시·오후 3시는 사용자 안내 기준입니다. 내부 baseline은 10분마다 전체 활성 대기열을 확인하고 한 번에 키워드 1개만 처리합니다.
- Windows primary가 중단된 경우에만 Mac standby가 같은 global lane을 인계하며, 다음 실행에서 due tracker를 이어갑니다.

macOS는 `node scripts/install-naver-shopping-chrome-bridge.mjs`를 실행한 뒤 Chrome의 `확장 프로그램 관리`에서 개발자 모드로 이 디렉터리를 한 번 로드합니다.

Windows는 Chrome 표시 이름이 `동빈 (개발)`인 전용 프로필을 먼저 만든 뒤 저장소 루트의 `INSTALL-NAVER-SHOPPING-WINDOWS.cmd`를 해당 Windows 사용자로 관리자 실행합니다. 설치가 연 `chrome://extensions`에서 결과의 `extensionPath`를 `압축해제된 확장 프로그램`으로 한 번 로드합니다. Windows 비밀키는 현재 사용자 범위 DPAPI로 암호화하고 native host는 Chrome 공식 HKCU 등록 경로만 사용합니다.
