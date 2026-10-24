/*!
 * 모먼트 인사이트 · C 30일 순위(쿠팡 검색 순위) 화면 모듈 — 명세 v3 §8(WP5)
 *
 * - 독립 모듈이다. 전역에는 window.MomentCoupangRank 하나만 둔다.
 * - 페이지(admin.html, 2b 때 client.html)는 mount(host, deps) 로 붙이고, 인라인의 공용 도우미
 *   (miFetch · verifiedRankTrackerScope · 내보내기 도구 4개 등)를 deps 로 넘긴다. 여기서는 그 함수를
 *   부르기만 하고 고치지 않는다.
 * - 그리기는 createElement + textContent 만 쓴다. 인라인 이벤트 속성은 쓰지 않는다.
 *   속성은 data-coupang-rank-* 만 쓴다(N30 속성 이름과 겹치지 않게).
 * - 수치·날짜는 서버가 계산해 보낸다(§5.3.3). 화면은 그리기만 한다.
 */
(function () {
  "use strict";

  var API_PATH = "/api/coupang-rank-trackers";
  var CACHE_PREFIX = "miCoupangRank:v1:";
  var CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  var CACHE_MAX_CHARS = 200000;
  var LIST_LIMIT = 500;
  var BULK_IDS_MAX = 100;
  var KEYWORD_MAX = 50;
  var GROUP_MAX = 30;
  var DEFAULT_GROUP = "기본 그룹";
  // 화면에만 쓰는 기본 그룹 이름(N30 RANK_UNGROUPED_LABEL 과 같은 말). 서버에는 '기본 그룹' 그대로 보낸다.
  var UNGROUPED_LABEL = "미분류";
  var RANK_TOP = 50;
  var COUPANG_SEARCH_URL = "https://www.coupang.com/np/search?q=";
  var OWNER_POLL_MS = 60000;
  // 연결 코드를 만든 뒤 이 시간 안에는 자동 수집이 꺼져 있어도 60초마다 수집기 상태를 다시 받는다(새 수집기 연결 확인).
  var OWNER_TOKEN_POLL_MS = 30 * 60 * 1000;
  // 화면 열기(show)가 짧은 간격으로 두 번 오면(메뉴 클릭의 setScreen + hashchange, 세션 동기화의
  // scope-changed + auth-ready) 같은 범위 목록·수집기 상태를 다시 받지 않는 시간.
  var LIST_REUSE_MS = 2000;
  var EXPORT_MAX_HEIGHT = 30000;
  var DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

  // ── 문구 표(§8.3) ─────────────────────────────────────────────

  var STRIP_ADMIN = {
    delayed: "지연 — 예정 시각이 지난 키워드가 있습니다",
    offline: "수집기 응답 없음(30분 넘음) — 수집기 PC가 켜져 있는지 확인하세요",
    review: "대표 확인 필요 — 차단이 7일 안 3번 감지됐습니다",
    budget: "저장 용량 상한으로 멈춤 — 대표 확인 필요",
    outdated: "수집기 업데이트 필요",
    disabled: "수집 꺼짐",
    not_connected: "수집기 연결 안 됨",
    setup_required: "대표 SQL 실행 전입니다(설정 필요)"
  };
  var STRIP_READONLY = {
    ok: "정상",
    delayed: "갱신 대기",
    idle_hours: "갱신 대기",
    offline: "갱신 대기",
    cooldown: "일시 중단",
    review: "일시 중단",
    budget: "일시 중단",
    outdated: "일시 중단",
    disabled: "일시 중단",
    not_connected: "일시 중단",
    setup_required: "설정 필요"
  };
  var STRIP_TONE = {
    ok: "is-ok",
    delayed: "is-info",
    idle_hours: "is-info",
    offline: "is-warn",
    cooldown: "is-warn",
    review: "is-warn",
    budget: "is-warn",
    outdated: "is-warn",
    disabled: "is-muted",
    not_connected: "is-muted",
    setup_required: "is-muted"
  };
  var STRIP_SUB = "수집기 PC가 켜져 있을 때만 수집합니다";

  // 수집이 멈춘 상태(다음 회차가 오지 않는다). 카드 '다음'은 '정지', 요약칸 '다음 갱신'도 '정지'.
  // 읽기 전용(광고주) 화면은 내부 상태 대신 STRIP_READONLY 문구('일시 중단' 등)를 쓴다.
  var STOPPED_STATES = { disabled: true, review: true, budget: true, outdated: true, not_connected: true, setup_required: true };
  // 카드 '다음'의 남은 시간(N분)을 다시 계산하는 간격. N30 은 60초 건강 신호마다 순위판을 다시 그린다.
  var NEXT_TICK_MS = 60000;
  // 요약칸 상태 알약(관리자). 위에서부터 처음 맞는 것을 쓴다(N30 자동추적 칸과 같은 자리·같은 색 규칙).
  var AUTO_STATUS_ADMIN = {
    disabled: ["수집 꺼짐", "is-error"],
    review: ["수집 꺼짐", "is-error"],
    budget: ["수집 꺼짐", "is-error"],
    outdated: ["수집 꺼짐", "is-error"],
    not_connected: ["연결 안 됨", "is-error"],
    offline: ["응답 없음", "is-error"],
    setup_required: ["설정 필요", "is-warn"],
    cooldown: ["쉬는 중", "is-warn"],
    delayed: ["갱신 대기", "is-warn"]
  };
  // 수집기가 정상으로 도는 상태. 이때만 요약칸 작은 글에 'N개 운영 · N개 대기 · N개 확인'을 쓴다.
  var NORMAL_STATES = { ok: true, idle_hours: true };

  // 첫 기록 전 안내. 공유 이미지(광고주용)는 이 문구 그대로, 화면 카드는 지금 방식에 맞춘 문구(firstBoardHint)를 쓴다.
  var FIRST_BOARD_TEXT = "첫 순위 확인 후 이 상품만의 일별 기록판이 생성됩니다.";
  var NO_RECENT_BOARD_TEXT = "최근 30일 측정 기록이 없습니다.";
  var TITLE_PENDING_HINT = "상품명은 검색 1쪽에서 이 상품을 찾은 뒤 채워집니다";
  // 등록 줄 아래 안내(옛 '일반 50위 이내' 칩·카드 머리 규칙 상자를 한 줄로).
  var FORM_HINT_TEXT = "상품 페이지 주소창의 주소(또는 상품번호) · 일반 상품 50위까지 기록 · 같은 상품이면 옵션이 달라도 인정";
  // 지금 확인 상태판의 한 줄 설명(바로 확인 가능·간격 기다리는 중일 때). 숫자는 옆 칸이 보인다.
  var MANUAL_BOARD_DESCRIPTION = "카드의 '지금 확인'을 누르면 이 크롬이 새 시크릿 창으로 쿠팡 검색 1쪽을 한 번 열고 닫습니다.";
  // 빈 날 칸 설명. 원인을 하나로 단정하지 않는다(지금 확인 이전 날·꺼진 날·시간 밖·그날 중지·자동 수집이 멈춘 날이 섞여 있다).
  var EMPTY_DAY_TEXT = "그날 기록 없음(지금 확인을 누르지 않았거나, 꺼짐·시간 밖·그날 중지·자동 수집 멈춤이었을 수 있습니다)";
  // 자동 수집을 쓰지 않는 상태(수집기 0대·수집 꺼짐·SQL 전). 이때는 자동추적 칸과 카드 '다음' 알약을 숨긴다.
  var AUTO_IDLE_STATES = { not_connected: true, disabled: true, setup_required: true };
  // 자동 수집이 '기록 중'이라고 말해도 되는 상태(정상·갱신 대기·시간 밖). 켜 둔 뒤의 경보(review·budget·cooldown·outdated·offline)는
  // 자동추적 칸을 보이되 '기록 중'이라고 하지 않는다. 모르는 상태 이름도 '기록 중'에서 뺀다(2026-10-23 재검사).
  var AUTO_RECORDING_STATES = { ok: true, delayed: true, idle_hours: true };
  var AUTO_ALARM_STATES = { review: true, budget: true, cooldown: true, outdated: true, offline: true };
  // 진행 중에 '지금 확인 끄기'를 눌렀을 때 상태판에 덧붙이는 말. 끄기는 새 확인만 막는다: 확장이 서버 확인(verify)을 받은 뒤면
  // 결과를 끝까지 기록하고, 그 전이면 서버가 그 확인을 닫아 검색 없이 끝난다(SQL coupang_rank_manual_verify).
  var MANUAL_RUN_OFF_TEXT = "지금 확인을 껐지만, 이미 시작한 이 확인은 끝까지 마치고 결과를 기록합니다(시크릿 창이 열리기 전이었다면 검색하지 않고 끝납니다).";
  // 확인 중 경고(금지 네 가지: 창 닫기·창 안 누르기·창 내리기/가리기·이 화면 닫기). 카드 '지금 확인'과 '전체 확인'이 같은 문장을 쓴다.
  var MANUAL_WARN_TEXT = "새 시크릿 창이 약 20초 열렸다 저절로 닫힙니다. 그 창을 닫거나 누르거나 내리지(가리지) 말고, 이 화면도 닫지 마세요.";
  // 선택 항목 정리 결과 한 줄을 휴대폰 아래 막대에 남겨 두는 시간(선택이 0개가 되어 막대가 접혀도).
  var BULK_NOTE_FLOAT_MS = 6000;
  // 날짜 줄: 오른쪽 끝 흐림 폭(CSS .mi-coupang-rank-days-scroll::after · scroll-padding-inline 과 같다)과, 흐리지 않는 작은 넘침(px).
  var DAY_FADE_PX = 40;
  var DAY_FADE_SLACK_PX = 16;

  var ATTENTION_TEXT = {
    drop10: "10위 이상 하락",
    exit: "50위 밖으로 이탈",
    keyword_failing: "이 키워드 측정이 연속 실패",
    unsupported: "쿠팡이 검색 결과가 아닌 쪽으로 보냄"
  };

  // 등록 결과의 첫 기록 안내. queued 는 지금 방식(지금 확인·자동 수집·둘 다 꺼짐)에 따라 firstCheckText 가 고른다.
  var FIRST_CHECK_TEXT = {
    recorded: "오늘 같은 키워드를 확인한 기록으로 바로 채웠습니다",
    queued: "다음 수집 때(수집기가 켜져 있을 때) 첫 순위가 기록됩니다",
    manual: "새 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다",
    off: "'지금 확인'을 켠 뒤 새 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다",
    stalled: "자동 수집이 멈췄거나 확인이 필요한 상태라 첫 순위가 언제 기록될지 알 수 없습니다(자동추적 칸 참고)"
  };

  // 상태 필터. '오늘 안 함'(대표 결정 2026-10-23)은 일시중지가 아니면서 오늘 칸이 없는 추적이다(checkedToday).
  var FILTER_STATUSES = [
    ["all", "전체"],
    ["attention", "확인 필요"],
    ["up", "상승"],
    ["down", "하락"],
    ["out", "50위 밖"],
    ["paused", "일시중지"],
    ["today-none", "오늘 안 함"]
  ];

  var RUN_STATUS_TEXT = {
    leased: "측정 중",
    expired: "임대 만료",
    released: "반납",
    ok: "성공",
    noresult: "결과 없음",
    partial: "일부만 읽음",
    blocked: "차단",
    empty: "빈 쪽",
    error: "오류",
    timeout: "시간 초과",
    unsupported: "이동"
  };

  var COOLDOWN_REASON_TEXT = {
    blocked: "쿠팡 차단 감지",
    empty: "빈 쪽 연속",
    empty_escalated: "빈 쪽 반복(차단 단계)",
    error_streak: "연속 오류",
    error_escalated: "연속 오류 반복(차단 단계)"
  };

  var CLAIM_REASON_TEXT = {
    job: "측정 배정",
    disabled: "수집 꺼짐",
    review: "대표 확인 필요",
    budget: "용량 상한",
    cooldown: "쉬는 중",
    window: "수집 시간 밖",
    gap: "간격 대기",
    hourly_cap: "시간당 상한",
    daily_cap: "하루 상한",
    idle: "잴 키워드 없음"
  };

  var BUDGET_REASON_TEXT = { storage: "C 저장 용량", database: "DB 전체 용량" };

  var RAISE_REASON_TEXT = {
    blocked_or_empty_48h: "최근 48시간 안에 차단 또는 빈 쪽이 있었습니다",
    too_few_success_48h: "최근 48시간 성공이 48회 미만입니다",
    quiet_window_short: "마지막 속도 변경 뒤 48시간이 지나지 않았습니다",
    ladder_step: "한 번에 한 단계(12→24→40→60)만 올릴 수 있습니다"
  };

  var ACCOUNT_KIND_TEXT = { owner: "총관리자", advertiser: "광고주", team: "운영팀", unknown: "연결 없음" };
  var PLATFORM_TEXT = { windows: "윈도우", macos: "맥" };
  var GUARD_TEXT = { none: "보호 없음(Edge)", "n30-chrome": "N30 크롬 보호" };

  var ONE_LINERS = [
    ["windowsInstall", "윈도우 설치·업데이트(관리자 PowerShell)", false],
    ["windowsCheck", "윈도우 확인", false],
    ["windowsUninstall", "윈도우 제거(관리자 PowerShell)", true],
    ["macInstall", "맥 설치·업데이트(터미널)", false],
    ["macCheck", "맥 확인", false],
    ["macUninstall", "맥 제거(터미널)", true]
  ];

  // §5.9 편집 칸. 범위는 서버 검사와 같고, 서버가 마지막으로 다시 검사한다.
  // 운영팀·광고주 공개 칸은 없다: C 30일 순위는 총관리자 전용이다(대표 결정 2026-10-23).
  var SETTING_FIELDS = [
    { key: "checksPerDay", label: "하루 측정 횟수", type: "int", min: 1, max: 6, help: "바꾸면 모든 키워드 일정을 다시 계산합니다." },
    { key: "activeFromHour", label: "수집 시작(시)", type: "int", min: 0, max: 23 },
    { key: "activeToHour", label: "수집 끝(시)", type: "int", min: 1, max: 24 },
    { key: "maxRunsPerHour", label: "시간당 최대 측정", type: "int", min: 1, max: 60, help: "올리기는 12→24→40→60 한 단계씩, 48시간 조용할 때만 됩니다." },
    { key: "maxRunsPerDay", label: "하루 최대 측정", type: "int", min: 1, max: 1000 },
    { key: "minGapSeconds", label: "측정 사이 최소 간격(초)", type: "int", min: 30, max: 3600 },
    { key: "gapJitterSeconds", label: "간격 흔들기(초)", type: "int", min: 0, max: 600 },
    { key: "defaultAccountLimit", label: "계정 기본 한도(키워드)", type: "int", min: 0, max: 1000 },
    { key: "globalKeywordLimit", label: "전체 고유 키워드 한도", type: "int", min: 1, max: 1000, help: "줄여도 이미 활성인 추적은 그대로이고, 새 키워드 등록만 막힙니다." },
    { key: "windowMode", label: "창 방식", type: "enum", options: [["offscreen", "화면 밖(기본)"], ["minimized", "최소화"], ["normal", "보통 창"]] },
    { key: "minCollectorVersion", label: "최소 수집기 버전", type: "version", help: "비우면 제한 없음. x.y.z 형식." },
    { key: "maxStorageMb", label: "C 저장 용량 상한(MB)", type: "int", min: 10, max: 400 },
    { key: "dbSizeStopMb", label: "DB 전체 멈춤 기준(MB)", type: "int", min: 100, max: 8000 }
  ];

  var ERROR_TEXT = {
    SESSION_REQUIRED: "로그인이 필요합니다. 다시 로그인해주세요.",
    COUPANG_SESSION_REQUIRED: "로그인이 필요합니다. 다시 로그인해주세요.",
    TRIAL_LOCKED: "체험 계정에서는 쓸 수 없는 기능입니다.",
    PLAN_EXPIRED: "이용 기간이 끝나 바꿀 수 없습니다. 기록은 계속 볼 수 있습니다.",
    COUPANG_READ_ONLY: "읽기 전용 화면이라 바꿀 수 없습니다.",
    COUPANG_SCOPE_NO_CREATE: "이 팀 코드 범위에서는 새로 등록하거나 다시 시작할 수 없습니다(조회·중지·삭제만)",
    COUPANG_OWNER_ONLY: "총관리자만 할 수 있습니다.",
    COUPANG_SCOPE_NOT_FOUND: "대상 범위를 찾을 수 없습니다. 상단에서 대상 광고주를 다시 고르세요.",
    COUPANG_ACCESS_DENIED: "접근 코드가 맞지 않습니다. 다시 로그인해주세요.",
    COUPANG_KEYWORD_REQUIRED: "키워드를 입력하세요.",
    COUPANG_KEYWORD_INVALID: "키워드는 50자 이하의 검색어로 입력하세요(주소는 넣지 않습니다).",
    COUPANG_PRODUCT_URL_REQUIRED: "쿠팡 상품 주소를 입력하세요.",
    COUPANG_SHORT_LINK_UNSUPPORTED: "상품 페이지를 연 뒤 주소창 주소를 붙여 주세요",
    COUPANG_NOT_PRODUCT_URL: "쿠팡 상품 페이지 주소(/vp/products/…)가 아닙니다. 검색·카테고리·기획전 주소는 쓸 수 없습니다.",
    COUPANG_GROUP_INVALID: "그룹 이름은 30자 이하로 입력하세요.",
    COUPANG_IDS_INVALID: "선택 항목을 확인할 수 없습니다(한 번에 100개까지).",
    COUPANG_ACTION_INVALID: "요청 형식이 올바르지 않습니다.",
    COUPANG_LIMIT_INVALID: "계정 코드 또는 한도 값(0~1000)이 올바르지 않습니다.",
    COUPANG_COLLECTOR_LABEL_INVALID: "수집기 이름은 1~40자로 입력하세요.",
    COUPANG_RAISE_CONFIRM_REQUIRED: "속도를 올리는 변경은 확인이 필요합니다.",
    COUPANG_TRACKER_NOT_FOUND: "추적 항목을 찾을 수 없습니다. 목록을 다시 받아 주세요.",
    COUPANG_COLLECTOR_NOT_FOUND: "연결 코드를 찾을 수 없습니다.",
    COUPANG_COLLECTOR_LIMIT: "활성 연결 코드는 3개까지입니다. 쓰지 않는 코드를 먼저 폐기하세요.",
    COUPANG_NO_COLLECTOR: "연결 코드가 없습니다. 먼저 연결 코드를 만들고 수집기를 설치하세요.",
    BODY_TOO_LARGE: "요청이 너무 큽니다.",
    METHOD_NOT_ALLOWED: "허용되지 않은 요청입니다.",
    COUPANG_SETUP_REQUIRED: "대표 SQL 실행 전입니다(설정 필요).",
    COUPANG_RANK_TRACKERS_FAILED: "서버 처리 중 오류가 났습니다. 잠시 뒤 다시 시도하세요.",
    // ① 지금 확인(spec-manual §6.2). 원인을 모르는 경우는 단정하지 않는다.
    COUPANG_MANUAL_SETUP_REQUIRED: "지금 확인용 대표 SQL 실행 전입니다.",
    COUPANG_MANUAL_OFF: "지금 확인이 꺼져 있습니다(위 '지금 확인' 상태판 → 지금 확인 켜기).",
    COUPANG_MANUAL_BUDGET: "저장 용량 상한으로 멈춰 있습니다(대표 확인 필요).",
    COUPANG_MANUAL_STOPPED: "오늘 쿠팡 확인 중 차단으로 보이는 화면이 나와 지금 확인을 멈췄습니다. 내일 다시 됩니다.",
    COUPANG_MANUAL_COOLDOWN: "쿠팡 차단 감지로 쉬는 중입니다.",
    COUPANG_MANUAL_REVIEW: "대표 확인이 필요한 상태라 지금 확인이 멈춰 있습니다.",
    COUPANG_MANUAL_HOURS: "지금 확인은 정해진 시간에만 됩니다.",
    COUPANG_MANUAL_BUSY: "다른 확인이 진행 중입니다. 잠시 뒤 다시 눌러 주세요.",
    COUPANG_MANUAL_DAILY_CAP: "오늘 확인 횟수를 모두 썼습니다. 내일 다시 됩니다.",
    COUPANG_MANUAL_GAP: "검색 사이 간격을 기다리는 중입니다.",
    COUPANG_MANUAL_TRACKER_PAUSED: "일시중지한 추적은 확인할 수 없습니다.",
    COUPANG_MANUAL_TRACKER_INELIGIBLE: "연결이 끊긴 범위라 확인할 수 없습니다.",
    COUPANG_MANUAL_CLAIM_NOT_FOUND: "확인 요청을 서버에서 찾지 못했습니다.",
    COUPANG_MANUAL_CLAIM_MISMATCH: "확인 요청이 맞지 않아 결과를 저장하지 않았습니다.",
    COUPANG_MANUAL_CLAIM_CLOSED: "이미 끝난 확인 요청이라 결과를 저장하지 않았습니다.",
    COUPANG_MANUAL_CLAIM_USED: "이미 쓴 확인 요청입니다(한 요청으로 검색은 한 번만 합니다).",
    COUPANG_MANUAL_CLAIM_NOT_VERIFIED: "확장이 서버 확인을 받지 않은 요청이라 결과를 저장하지 않았습니다.",
    COUPANG_MANUAL_CLAIM_EXPIRED: "확인 요청 기한(10분)이 지나 결과를 저장하지 않았습니다.",
    COUPANG_MANUAL_RECORD_INVALID: "확인 결과 형식이 맞지 않아 저장하지 못했습니다.",
    // 지금 확인 ↔ 자동 수집이 함께 켜지지 않게(자동 수집이 아직 지금 확인의 간격·그날 중지를 보지 않는다)
    COUPANG_MANUAL_COLLECTOR_CONFLICT: "자동 수집이 켜져 있어 '지금 확인'을 켜지 않았습니다. 먼저 아래 '자동 수집' 칸에서 '수집 끄기'를 누르세요.",
    // 서버 거절 사유(reason)를 모르는 경우의 문구. 사유가 오면 COLLECTOR_CONFLICT_REASON_TEXT 를 쓴다.
    COUPANG_COLLECTOR_MANUAL_CONFLICT: "'지금 확인'이 켜져 있거나 오늘 지금 확인이 차단으로 멈춘 날이라 자동 수집을 켜지 않았습니다. '지금 확인 끄기'를 누르고, 그날 중지였다면 다음 날 켜 주세요."
  };

  // 자동 수집 켜기 거절 사유(handler manualAutoConflict 의 reason) → 짧은 문구.
  var COLLECTOR_CONFLICT_REASON_TEXT = {
    manual_enabled: "지금 확인이 켜져 있어 자동 수집을 켜지 않았습니다. 먼저 위 상태판에서 '지금 확인 끄기'를 누르세요.",
    manual_stopped_today: "오늘은 지금 확인이 차단으로 멈춘 날이라 자동 수집을 켜지 않았습니다. 내일 다시 켜 주세요."
  };

  // ── 순수 도우미 ───────────────────────────────────────────────

  function isNum(value) {
    return typeof value === "number" && isFinite(value);
  }

  function pad2(value) {
    var number = Math.max(0, Math.floor(Number(value) || 0));
    return (number < 10 ? "0" : "") + number;
  }

  function hoursText(from, to) {
    if (!isNum(from) || !isNum(to)) return "";
    return pad2(from) + "~" + pad2(to) + "시";
  }

  function defaultNormalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function kstClock(iso) {
    var time = Date.parse(iso);
    if (!isFinite(time)) return "";
    try {
      return new Date(time).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });
    } catch (error) {
      return "";
    }
  }

  function kstDate(iso) {
    var time = Date.parse(iso);
    if (!isFinite(time)) return "";
    try {
      var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(time));
      var map = {};
      parts.forEach(function (part) { map[part.type] = part.value; });
      return map.year && map.month && map.day ? map.year + "-" + map.month + "-" + map.day : "";
    } catch (error) {
      return "";
    }
  }

  // 오늘(서버가 보낸 KST 날짜)이면 HH:MM, 아니면 MM-DD HH:MM.
  function kstStamp(iso, todayKst) {
    var clock = kstClock(iso);
    if (!clock) return "";
    var day = kstDate(iso);
    return day && day !== todayKst ? day.slice(5) + " " + clock : clock;
  }

  // 카드·요약칸의 '최근'·'다음 갱신' 시각. N30 formatRankShortAt 과 같은 모양이고 KST 로 고정한다.
  function shortAt(iso) {
    var time = Date.parse(iso);
    if (!iso || !isFinite(time)) return "-";
    try {
      return new Date(time).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
    } catch (error) {
      return "-";
    }
  }

  // 남은 시간. N30 formatRankRemain 과 같은 계산(올림, 분→시간→일).
  function remainText(iso, now) {
    var time = Date.parse(iso);
    if (!iso || !isFinite(time)) return "-";
    var diff = time - (isNum(now) ? now : Date.now());
    if (diff <= 0) return "대기";
    var minutes = Math.ceil(diff / 60000);
    if (minutes < 60) return minutes + "분";
    var hours = Math.ceil(minutes / 60);
    if (hours < 24) return hours + "시간";
    return Math.ceil(hours / 24) + "일";
  }

  function dayLabel(d) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ""));
    if (!match) return String(d || "");
    var weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
    return match[2] + "-" + match[3] + "(" + DAY_NAMES[weekday] + ")";
  }

  function dayClass(d) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ""));
    if (!match) return "";
    var weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
    if (weekday === 0) return "is-sun";
    if (weekday === 6) return "is-sat";
    return "";
  }

  // 응답 범위 검증 — N30 scopedRankTrackerPayload(admin.html)의 원문 규칙을 그대로 옮겼다(M4).
  function scopedPayload(payload, scope, deps) {
    var tools = deps || {};
    var normalize = typeof tools.normalizeCode === "function" ? tools.normalizeCode : defaultNormalize;
    var isPlaceholder = typeof tools.isOwnerScopePlaceholder === "function" ? tools.isOwnerScopePlaceholder : function (value) {
      var normalized = normalize(value);
      return !normalized || normalized === "owner-session" || normalized === "session";
    };
    var ownerPrimaryCode = typeof tools.ownerPrimaryCode === "function" ? tools.ownerPrimaryCode : function () { return ""; };
    if (!payload || payload.ok !== true || !Array.isArray(payload.trackers) || !scope) return false;
    if (!Number.isSafeInteger(payload.returnedCount) || payload.returnedCount !== payload.trackers.length) return false;
    var trackerIds = new Set();
    for (var index = 0; index < payload.trackers.length; index += 1) {
      var trackerId = String(payload.trackers[index] && payload.trackers[index].id || "").trim();
      if (!trackerId || trackerIds.has(trackerId)) return false;
      trackerIds.add(trackerId);
    }
    if (scope.role === "owner") {
      var echoedAgencyCode = normalize(payload.scopeAgencyCode);
      // 자리표시자로 보낸 내부 범위는 서버가 대표 코드로 풀어 되돌려 준다.
      // 대표 코드를 이미 받아 둔 화면은 그 값과 대조하고, 아직 모르면 비어 있지 않은 응답 범위만 인정한다.
      if (!isPlaceholder(scope.agencyCode)) return echoedAgencyCode === scope.agencyCode;
      var resolvedOwnerCode = normalize(ownerPrimaryCode());
      if (!isPlaceholder(resolvedOwnerCode)) return echoedAgencyCode === resolvedOwnerCode;
      return Boolean(echoedAgencyCode);
    }
    if (scope.accountOnly) {
      return payload.scopeMode === "team-account" && !normalize(payload.scopeClientId);
    }
    return payload.scopeMode !== "team-account" && normalize(payload.scopeClientId) === scope.clientId;
  }

  // 30일 판 칸 글자(§8.3 표). 칸 모양은 N30 하루 칸(작은 글 + 굵은 값)과 같다.
  function cellText(cell, d, createdDay) {
    if (!cell) return createdDay && d && String(d) < String(createdDay) ? "" : "-";
    switch (cell.s) {
      case "found": return isNum(cell.r) ? cell.r + "위" : "-";
      case "out": return RANK_TOP + "위 밖";
      case "short": return "없음";
      case "noresult": return "결과 없음";
      case "failed": return "실패";
      case "unsupported": return "이동";
      default: return "-";
    }
  }

  // 칸의 작은 글(공유 이미지에서만 쓴다. 화면 칸은 2026-10-23 부터 작은 글 없이 값만). 실패·이동은 '측정', 결과 없음은 '검색', 그 밖은 '순위'.
  function cellLabel(cell) {
    var status = cell && cell.s;
    if (status === "failed" || status === "unsupported") return "측정";
    if (status === "noresult") return "검색";
    return "순위";
  }

  // 날짜 줄 범위: 서버 days30(오늘부터 거꾸로) 가운데 등록일 이후만. 등록일을 모르면 30칸 모두.
  function boardDays(tracker, days30) {
    var byDay = {};
    (tracker && Array.isArray(tracker.days) ? tracker.days : []).forEach(function (cell) {
      if (cell && cell.d && !byDay[cell.d]) byDay[cell.d] = cell;
    });
    var created = String(tracker && tracker.createdDay || "");
    var dates = Array.isArray(days30) && days30.length ? days30.slice() : Object.keys(byDay).sort().reverse();
    if (/^\d{4}-\d{2}-\d{2}$/.test(created)) dates = dates.filter(function (d) { return String(d) >= created; });
    return { dates: dates, byDay: byDay };
  }

  // 날짜 줄 대신 띄울 안내. 한 번도 성공 측정이 없으면(현재 값·마지막 발견 시각도 없음) N30 과 같은 '첫 순위 확인 후…'.
  // 예전에는 쟀지만 최근 30일 창 안 기록이 없으면(30일 넘게 일시중지·수집 정지) 안내 대신 범위 칸을 '-'로 보인다.
  // 빈 문자열이면 날짜 줄을 그린다.
  function emptyBoardText(tracker, days30) {
    var days = tracker && Array.isArray(tracker.days) ? tracker.days : [];
    if (days.length) return "";
    var summary = tracker && tracker.summary || {};
    if (!(tracker && tracker.current) && !summary.lastFoundAt) return FIRST_BOARD_TEXT;
    return boardDays(tracker, days30).dates.length ? "" : NO_RECENT_BOARD_TEXT;
  }

  function cellTooltip(cell, d, createdDay) {
    if (!cell) {
      if (createdDay && d && String(d) < String(createdDay)) return "";
      return EMPTY_DAY_TEXT;
    }
    switch (cell.s) {
      case "found": {
        var parts = [(cell.t ? cell.t + " " : "") + "일반 " + cell.r + "위"];
        if (isNum(cell.a)) parts.push("광고 " + cell.a + "번째");
        parts.push("하루 " + (isNum(cell.c) ? cell.c : 0) + "회(실패 " + (isNum(cell.f) ? cell.f : 0) + ")");
        if (isNum(cell.b)) parts.push("그날 최고 " + cell.b + "위");
        return parts.join(" · ");
      }
      case "out": return "50위 밖 · " + (isNum(cell.n) ? "일반 " + cell.n + "개 중 1~50위에 없음" : "일반 상품 1~50위에 없음");
      case "short": return (isNum(cell.n) ? "일반 " + cell.n + "개 중 없음" : "일반 상품 중 없음");
      case "noresult": return "검색 결과 없음";
      case "failed": return (isNum(cell.f) ? cell.f : 0) + "회 모두 실패";
      case "unsupported": return "쿠팡이 검색 결과가 아닌 쪽으로 보냈습니다";
      default: return "";
    }
  }

  function cellTone(cell, d, createdDay) {
    if (!cell) return createdDay && d && String(d) < String(createdDay) ? "is-before" : "is-empty";
    return "is-" + (cell.s === "noresult" ? "noresult" : String(cell.s || "empty"));
  }

  // 화면 날짜 칸 모양(C30 만, 대표 결정 2026-10-23): 안 잰 날(-) · 잰 결과 순위 밖(50위 밖·없음·결과 없음) · 실패·이동 · 순위.
  function dayKind(cell) {
    if (!cell) return "is-none";
    var status = cell.s;
    if (status === "failed" || status === "unsupported") return "is-fail";
    if (status === "out" || status === "short" || status === "noresult") return "is-out";
    if (status === "found" && isNum(cell.r)) return "is-found";
    return "is-none";
  }

  // 칸을 눌렀을 때 카드 아래 한 줄. 일시중지 기간의 빈 날만 '일시중지 중'으로 단정하고, 그 밖의 빈 날은 가능한 이유를 나열한다.
  function dayDetailText(cell, d, tracker) {
    var info = tracker || {};
    var label = dayLabel(d) + " · " + (cellText(cell, d, info.createdDay) || "-");
    if (!cell) {
      var pausedDay = String(info.pausedDay || "");
      if (info.status === "paused" && pausedDay && String(d) >= pausedDay) return label + " — 일시중지 중이라 확인하지 않았습니다";
      return label + " — " + EMPTY_DAY_TEXT;
    }
    var detail = cellTooltip(cell, d, info.createdDay);
    if (cell.s === "failed") detail += ". 자세한 사유는 '측정 기록'에서 봅니다";
    return label + " — " + detail;
  }

  // '오늘 확인' 판정은 이 함수 하나다(카드 알약 · '오늘 안 함' 필터 · 상태판 '오늘 확인한 상품'이 같이 쓴다).
  // 기준 날짜는 브라우저 날짜가 아니라 서버 응답의 todayKst 다. 실패한 날도 그날 칸이 생기므로 '오늘 확인함'으로 센다.
  function todayCellOf(tracker, todayKst) {
    var day = String(todayKst || "");
    if (!day || !tracker || !Array.isArray(tracker.days)) return null;
    for (var index = 0; index < tracker.days.length; index += 1) {
      var cell = tracker.days[index];
      if (cell && cell.d === day) return cell;
    }
    return null;
  }

  function checkedToday(tracker, todayKst) {
    return Boolean(todayCellOf(tracker, todayKst));
  }

  // 카드 운영줄의 '오늘' 알약. 일시중지면 마지막 확인만 보인다. todayKst 를 모르면 null(옛 '최근' 알약을 쓴다).
  function todayPill(tracker, todayKst) {
    if (!todayKst || !tracker) return null;
    var cell = todayCellOf(tracker, todayKst);
    if (cell && tracker.status !== "paused") {
      var at = cell.t ? " " + cell.t : "";
      if (cell.s === "failed") return { text: "오늘 실패" + at, tone: "is-warn" };
      if (cell.s === "unsupported") return { text: "오늘 이동" + at, tone: "is-warn" };
      return { text: "오늘" + at + " 확인", tone: "is-today" };
    }
    var last = null;
    (Array.isArray(tracker.days) ? tracker.days : []).forEach(function (item) {
      if (item && item.d && (!last || String(item.d) > String(last.d))) last = item;
    });
    var lastText = last ? String(last.d).slice(5) + (last.t ? " " + last.t : "") : "";
    if (tracker.status === "paused") return lastText ? { text: "마지막 확인 " + lastText, tone: "" } : null;
    if (!last) return { text: "아직 확인 전", tone: "" };
    return { text: "오늘 아직 · 마지막 " + lastText, tone: "" };
  }

  function currentBadge(tracker) {
    var current = tracker && tracker.current;
    if (!current) return { text: "측정 전", tone: "is-pending" };
    if (current.result === "found" && isNum(current.rank)) return { text: current.rank + "위", tone: "is-found" };
    if (current.result === "out") return { text: RANK_TOP + "위 밖", tone: "is-out" };
    if (current.result === "short") {
      return { text: isNum(current.organicCount) ? "일반 " + current.organicCount + "개 중 없음" : "일반 상품 중 없음", tone: "is-out" };
    }
    if (current.result === "noresult") return { text: "결과 없음", tone: "is-out" };
    return { text: "측정 전", tone: "is-pending" };
  }

  // 카드 '현재' 값. 측정 전이면 N30 처럼 '-'.
  function currentText(tracker) {
    var badge = currentBadge(tracker);
    return badge.tone === "is-pending" ? "-" : badge.text;
  }

  // 전회 대비 문구(N30 rankTrackerChangeLabel 과 같은 말). 서버 trend 는 같은 시간대 회차끼리 비교한 값이다.
  function changeText(summary) {
    var trend = summary && summary.trend;
    var delta = summary && summary.trendDelta;
    if (trend === "up") return isNum(delta) ? "전회 대비 " + Math.abs(delta) + "위 상승" : "전회 대비 상승";
    if (trend === "down") return isNum(delta) ? "전회 대비 " + Math.abs(delta) + "위 하락" : "전회 대비 하락";
    if (trend === "same") return "전회 대비 변동 없음";
    if (trend === "enter") return "전회 대비 " + RANK_TOP + "위 안 진입";
    if (trend === "exit") return "전회 대비 " + RANK_TOP + "위 밖 이탈";
    return "전회 데이터 대기";
  }

  // '7일 평균' 문구. 카드 운영줄과 공유 이미지가 같은 글을 쓴다(서버 avg7: 최근 7일 가운데 50위 안에 든 날만 평균).
  function avg7Text(summary) {
    var value = summary || {};
    return "7일 평균 " + (isNum(value.avg7) ? value.avg7 + "위(50위 안 " + (isNum(value.foundDays7) ? value.foundDays7 : 0) + "일)" : "-");
  }

  // 마지막 성공 측정이 최근 30일 창(서버 days30, 오늘부터 거꾸로) 밖인지. days30 이 없으면 판단하지 않는다(false).
  function currentIsStale(current, days30) {
    if (!current || !current.checkedAt || !Array.isArray(days30) || !days30.length) return false;
    var oldest = String(days30[days30.length - 1] || "");
    var checkedDay = kstDate(current.checkedAt);
    return Boolean(oldest && checkedDay && checkedDay < oldest);
  }

  // 지금 일반 50위 안에 없는지('50위 밖' 필터와 같은 기준: 50위 밖 · 일반 N개 중 없음).
  function outOfTop(tracker) {
    var current = tracker && tracker.current;
    return Boolean(current && (current.result === "out" || current.result === "short"));
  }

  // '확인 필요' 기준. 판정 알약·요약칸 '확인 필요' 개수·'확인 필요' 필터가 모두 이 함수를 쓴다.
  // 서버 확인 사유가 있거나, 지금 일반 50위 안에 없으면 확인 필요다. 뒤쪽은 N30 이 현재 순위가 없는
  // 추적(300위 밖)을 '점검 필요'로 보이고 확인 필요로 세는 규칙(admin.html rankTrackerNeedsAttention 의
  // !rankTrackerLatestRank, rankTrackerOpsSummary 의 errors)을 C30 의 50위 밖에 옮긴 것이다.
  // N30 처럼 일시중지한 추적도 센다.
  function needsAttention(tracker) {
    var summary = tracker && tracker.summary || {};
    return summary.attention === true || outOfTop(tracker);
  }

  // 판정 자리 알약(N30 rankTrackerInsight 자리). 서버 확인 사유가 있으면 그것을, 지금 50위 밖이면
  // N30 300위 밖과 같은 '점검 필요'(빨강)를 보인다. 서버 '50위 밖으로 이탈' 사유는 50위 안 → 밖으로
  // 바뀐 회차에만 붙으므로, 50위 밖이 이어지는 카드는 '점검 필요'로 남는다(이탈 알약이 있으면 겹쳐 쓰지 않는다).
  // 둘 다 없으면 N30 과 같은 규칙. 측정 전처럼 지금 순위가 없으면 판정을 단정하지 않는다(알약 없음).
  // 일시중지한 추적이나 마지막 측정이 30일 창 밖이면(days30 을 받았을 때) 옛 값으로 흐름을 단정하지 않는다.
  // 확인 필요 알약은 '확인 필요' 필터·개수와 같은 기준(needsAttention)이라 일시중지여도 그대로 보인다.
  function verdictPills(tracker, days30) {
    var summary = tracker && tracker.summary || {};
    var reasons = Array.isArray(summary.attentionReasons) ? summary.attentionReasons : [];
    var flagged = reasons.map(function (reason) {
      return { text: ATTENTION_TEXT[reason] || String(reason), tone: reason === "drop10" ? "is-warn" : "is-error" };
    });
    if (outOfTop(tracker) && reasons.indexOf("exit") < 0) flagged.push({ text: "점검 필요", tone: "is-error" });
    if (flagged.length) return flagged;
    var current = tracker && tracker.current;
    if (!current || current.result !== "found" || !isNum(current.rank)) return [];
    if (tracker.status === "paused" || currentIsStale(current, days30)) return [];
    if (summary.trend === "up" || summary.trend === "enter") return [{ text: "상승 흐름", tone: "is-ok" }];
    if (summary.trend === "down") return [{ text: "하락 확인", tone: "is-warn" }];
    if (current.rank <= 10) return [{ text: "상위권 유지", tone: "is-ok" }];
    return [{ text: "정상 추적", tone: "is-ok" }];
  }

  // 카드 '다음'. 일시중지가 먼저, 그다음 수집기가 멈췄거나 쉬는 중이면 그 사실을 쓴다
  // (요약칸은 '수집 꺼짐'인데 카드는 '대기'로 엇갈리지 않게). 수집기 응답이 없을 때(offline) 예정 시각이
  // 지난 항목은 '대기' 대신 '응답 대기'(요약칸 '응답 없음'과 같은 뜻)로 쓴다. 남은 시간이 있으면 그대로 보인다
  // (수집기 PC가 돌아오면 그 시각에 잰다). mode 가 'readonly'(광고주)면 내부 상태 대신 광고주 문구를 쓴다.
  function nextCheckText(tracker, collectorState, now, mode) {
    var readonly = mode === "readonly";
    var stateName = tracker && tracker.nextCheckState;
    if (stateName === "paused" || (tracker && tracker.status === "paused")) return "-";
    if (STOPPED_STATES[collectorState] || collectorState === "cooldown") {
      if (readonly) return STRIP_READONLY[collectorState];
      return collectorState === "cooldown" ? "쉬는 중" : "정지";
    }
    if (stateName === "replan") return "다음 수집 때 정함";
    var text = "-";
    if (stateName === "due") text = "대기";
    else if (stateName === "scheduled") text = remainText(tracker.nextCheckAt, now);
    if (text === "대기" && collectorState === "offline") return readonly ? STRIP_READONLY.offline : "응답 대기";
    return text;
  }

  // todayKst: 서버 응답의 오늘(KST). '오늘 안 함' 필터에만 쓴다(모르면 그 필터에는 아무것도 걸리지 않는다).
  function filterMatches(tracker, filter, todayKst) {
    var options = filter || {};
    var status = options.status || "all";
    if (!tracker) return false;
    if (options.group && String(tracker.groupName || DEFAULT_GROUP) !== options.group) return false;
    var query = String(options.query || "").trim().toLowerCase();
    if (query) {
      // 그룹은 화면에 보이는 이름으로 찾는다(기본 그룹은 '미분류'). 서버 값 '기본 그룹'으로는 걸리지 않는다.
      var haystack = [tracker.keyword, tracker.productId, tracker.productTitle, groupDisplayName(tracker.groupName)].map(function (value) {
        return String(value || "").toLowerCase();
      }).join("\n");
      if (haystack.indexOf(query) < 0) return false;
    }
    var summary = tracker.summary || {};
    var trend = summary.trend;
    if (status === "attention") return needsAttention(tracker);
    if (status === "up") return trend === "up" || trend === "enter";
    if (status === "down") return trend === "down" || trend === "exit";
    if (status === "out") return outOfTop(tracker);
    if (status === "paused") return tracker.status === "paused";
    if (status === "today-none") return Boolean(todayKst) && tracker.status !== "paused" && !checkedToday(tracker, todayKst);
    return true;
  }

  // 등록 줄 오른쪽 한도 알약: 이 계정 추적 수만. 여러 계정이 나눠 쓰는 전체 고유 키워드 한도는 '자동 수집' 칸 용량 줄에 둔다.
  function limitText(limit) {
    if (!limit) return "";
    var show = function (value) { return isNum(value) ? String(value) : "-"; };
    return "추적 " + show(limit.used) + " / " + show(limit.max) + "개";
  }

  function globalLimitText(limit) {
    if (!limit || (!isNum(limit.globalUsed) && !isNum(limit.globalMax))) return "";
    var show = function (value) { return isNum(value) ? String(value) : "-"; };
    return "전체 고유 키워드 " + show(limit.globalUsed) + " / " + show(limit.globalMax) + "개(모든 계정 합)";
  }

  // 용량 경고(H1): 전체 고유 키워드가 지금 설정으로 제때 잴 수 있는 수를 넘으면 경고한다.
  function capacityText(limit, checksPerDay) {
    if (!limit || !isNum(limit.capacity) || !isNum(limit.globalUsed)) return "";
    if (limit.globalUsed <= limit.capacity) return "";
    var perDay = isNum(checksPerDay) ? "하루 " + checksPerDay + "번 " : "";
    return "지금 설정으로는 " + perDay + "키워드 약 " + limit.capacity + "개까지 제때 잽니다(지금 " + limit.globalUsed + "개). 더 등록하면 일부 키워드가 늦게 잡힙니다";
  }

  function cacheKey(scope) {
    return CACHE_PREFIX + String(scope && scope.key || "");
  }

  function exportFileName(trackers, ext) {
    var list = Array.isArray(trackers) ? trackers : [];
    var first = String(list[0] && list[0].keyword || "").trim() || "쿠팡순위";
    var suffix = list.length > 1 ? "-외-" + (list.length - 1) + "개" : "";
    var extension = String(ext || "png").replace(/[^a-z0-9]+/gi, "").toLowerCase() || "png";
    var base = String(first + suffix + "-C30일순위")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-");
    // 전체 90자 이하. 확장자는 잘리지 않게 이름 쪽을 자른다.
    return base.slice(0, 90 - extension.length - 1) + "." + extension;
  }

  function stripText(collector, mode) {
    var info = collector || {};
    var stateName = STRIP_TONE[info.state] ? info.state : "not_connected";
    var text;
    if (mode === "readonly") {
      text = STRIP_READONLY[stateName];
    } else if (stateName === "ok") {
      var parts = ["정상"];
      var last = kstClock(info.lastSuccessAt);
      if (last) parts.push("마지막 수집 " + last);
      if (isNum(info.checksPerDay)) parts.push("하루 " + info.checksPerDay + "회" + (hoursText(info.activeFromHour, info.activeToHour) ? "(" + hoursText(info.activeFromHour, info.activeToHour) + ")" : ""));
      text = parts.join(" · ");
    } else if (stateName === "idle_hours") {
      var hours = hoursText(info.activeFromHour, info.activeToHour);
      text = "수집 시간이 아닙니다" + (hours ? "(" + hours + ")" : "");
    } else if (stateName === "cooldown") {
      var until = info.cooldownUntil ? kstDate(info.cooldownUntil).slice(5) + " " + kstClock(info.cooldownUntil) : "";
      text = "쉬는 중" + (until.trim() ? " ~" + until : "") + "(쿠팡 차단 또는 연속 오류 감지)";
    } else {
      text = STRIP_ADMIN[stateName];
    }
    return { state: stateName, text: text, tone: STRIP_TONE[stateName], sub: STRIP_SUB };
  }

  // 목록 맨 위 '자동추적' 요약칸(N30 rankTrackerOpsSummary 의 .mi-rank-auto-center 와 같은 칸·같은 순서).
  // 내용은 쿠팡 수집기 PC 상태(collector.state)와 받은 추적 목록에서만 센다. 화면은 계산하지 않고 센다.
  function autoSummary(collector, list, options) {
    var opts = options || {};
    var info = collector || null;
    var items = (Array.isArray(list) ? list : []).filter(Boolean);
    var readonly = opts.mode === "readonly";
    var active = items.filter(function (tracker) { return tracker.status !== "paused"; });
    var due = active.filter(function (tracker) { return tracker.nextCheckState === "due"; }).length;
    // 확인 필요 개수는 카드 판정 알약·'확인 필요' 필터와 같은 기준(needsAttention)으로 센다.
    var attention = items.filter(function (tracker) { return needsAttention(tracker); }).length;
    var stateName = info ? (STRIP_TONE[info.state] ? info.state : "not_connected") : "";
    var pill;
    if (!info) pill = ["확인 중", "is-warn"];
    else if (readonly) pill = [STRIP_READONLY[stateName], stateName === "ok" ? "" : "is-warn"];
    else if (AUTO_STATUS_ADMIN[stateName]) pill = AUTO_STATUS_ADMIN[stateName];
    else if (attention) pill = ["확인 필요", "is-error"];
    else if (due) pill = ["갱신 대기", "is-warn"];
    else if (stateName === "idle_hours") pill = ["수집 시간 아님", ""];
    else if (active.length) pill = ["정상 운영", ""];
    else pill = ["대기", ""];
    var small;
    if (!info) small = opts.loading ? "수집 상태 확인 중 · " + STRIP_SUB : "수집 상태를 아직 받지 못했습니다 · " + STRIP_SUB;
    else if (NORMAL_STATES[stateName]) small = active.length + "개 운영 · " + due + "개 대기 · " + attention + "개 확인";
    else small = readonly ? STRIP_SUB : stripText(info, "admin").text + " · " + STRIP_SUB;
    var nextAt = 0;
    active.forEach(function (tracker) {
      if (tracker.nextCheckState !== "scheduled" && tracker.nextCheckState !== "due") return;
      var time = Date.parse(tracker.nextCheckAt);
      if (isFinite(time) && (!nextAt || time < nextAt)) nextAt = time;
    });
    var next;
    if (!info) next = { value: "-", tone: "" };
    // 광고주 화면은 알약과 같은 광고주 문구('일시 중단'·'설정 필요')로, 내부 상태(정지·쉬는 중 ~시각)를 보이지 않는다.
    else if (readonly && (STOPPED_STATES[stateName] || stateName === "cooldown")) next = { value: STRIP_READONLY[stateName], tone: "is-warn" };
    else if (STOPPED_STATES[stateName]) next = { value: "정지", tone: "is-error" };
    else if (stateName === "cooldown") next = { value: info.cooldownUntil ? "쉬는 중 ~" + shortAt(info.cooldownUntil) : "쉬는 중", tone: "is-warn" };
    else next = { value: nextAt ? shortAt(new Date(nextAt).toISOString()) : "대기", tone: stateName === "offline" || stateName === "delayed" || due ? "is-warn" : "is-ok" };
    var perDay = info && isNum(info.checksPerDay) ? info.checksPerDay : "n";
    var hours = info ? hoursText(info.activeFromHour, info.activeToHour) : "";
    return {
      state: stateName,
      pill: { text: pill[0], tone: pill[1] },
      small: small,
      metrics: [
        { label: "최근 갱신", value: info ? shortAt(info.lastSuccessAt) : "-", note: "수집기 PC", tone: "" },
        { label: "다음 갱신", value: next.value, note: "하루 " + perDay + "회 자동 갱신 · " + (hours || "08~23시"), tone: next.tone },
        { label: "확인 필요", value: attention + "개", note: "확인 필요 필터와 같은 기준", tone: attention ? "is-error" : "is-ok" }
      ],
      counts: { active: active.length, due: due, attention: attention }
    };
  }

  function raiseReasonText(reasons) {
    var list = Array.isArray(reasons) ? reasons : [];
    if (!list.length) return "조건을 확인하지 못했습니다";
    return list.map(function (reason) { return RAISE_REASON_TEXT[reason] || String(reason); }).join(" · ");
  }

  function settingLabel(key) {
    for (var index = 0; index < SETTING_FIELDS.length; index += 1) {
      if (SETTING_FIELDS[index].key === key) return SETTING_FIELDS[index].label;
    }
    return String(key || "");
  }

  function errorText(payload) {
    var body = payload || {};
    var code = String(body.code || "");
    if (code === "COUPANG_KEYWORD_LIMIT_REACHED") {
      return "이 계정의 키워드 한도(" + body.limit + "개)에 도달했습니다(지금 " + body.count + "개). 쓰지 않는 추적을 지우거나 총관리자에게 한도를 요청하세요.";
    }
    if (code === "COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED") {
      return "전체 고유 키워드 한도(" + body.limit + "개)에 도달했습니다(지금 " + body.count + "개). 이미 추적 중인 키워드는 더 등록할 수 있습니다.";
    }
    if (code === "COUPANG_SETTINGS_INVALID") return "설정 값이 범위를 벗어났습니다" + (body.field ? "(" + settingLabel(body.field) + ")" : "") + ".";
    if (code === "COUPANG_RAISE_NOT_ALLOWED") return "지금은 속도를 올릴 수 없습니다: " + raiseReasonText(body.reasons);
    if (code === "COUPANG_MANUAL_RECORD_INVALID" && body.field) return "확인 결과 형식이 맞지 않아 저장하지 못했습니다(칸 " + String(body.field).slice(0, 40) + ").";
    if (code === "COUPANG_COLLECTOR_MANUAL_CONFLICT" && COLLECTOR_CONFLICT_REASON_TEXT[body.reason]) return COLLECTOR_CONFLICT_REASON_TEXT[body.reason];
    if (ERROR_TEXT[code]) return ERROR_TEXT[code];
    return String(body.message || "요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.");
  }

  // 설정 폼 값 → 바뀐 칸만 담은 patch 와 칸별 오류.
  function settingsPatch(current, values) {
    var base = current || {};
    var input = values || {};
    var patch = {};
    var errors = {};
    var parsed = {};
    SETTING_FIELDS.forEach(function (field) {
      if (!Object.prototype.hasOwnProperty.call(input, field.key)) return;
      var raw = input[field.key];
      var value;
      if (field.type === "bool") {
        value = raw === true;
      } else if (field.type === "enum") {
        value = String(raw || "");
        if (!field.options.some(function (option) { return option[0] === value; })) {
          errors[field.key] = "목록에서 고르세요.";
          return;
        }
      } else if (field.type === "version") {
        var text = String(raw == null ? "" : raw).trim();
        if (!text) value = null;
        else if (/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(text)) value = text;
        else {
          errors[field.key] = "x.y.z 형식으로 입력하세요(비우면 제한 없음).";
          return;
        }
      } else {
        var textValue = String(raw == null ? "" : raw).trim();
        if (!/^-?[0-9]+$/.test(textValue)) {
          errors[field.key] = field.min + "~" + field.max + " 사이의 정수로 입력하세요.";
          return;
        }
        value = Number(textValue);
        if (value < field.min || value > field.max) {
          errors[field.key] = field.min + "~" + field.max + " 사이로 입력하세요.";
          return;
        }
      }
      parsed[field.key] = value;
      if (value !== (base[field.key] === undefined ? null : base[field.key])) patch[field.key] = value;
    });
    var from = Object.prototype.hasOwnProperty.call(parsed, "activeFromHour") ? parsed.activeFromHour : base.activeFromHour;
    var to = Object.prototype.hasOwnProperty.call(parsed, "activeToHour") ? parsed.activeToHour : base.activeToHour;
    if (isNum(from) && isNum(to) && from >= to && !errors.activeToHour && !errors.activeFromHour) {
      errors.activeToHour = "끝 시각은 시작 시각보다 커야 합니다.";
      delete patch.activeToHour;
      delete patch.activeFromHour;
    }
    return { patch: patch, errors: errors };
  }

  // 속도를 올리는 변경인지(§5.9). 시간당·하루 상한 증가, 최소 간격 감소, 수집 시간대 넓힘.
  function isRaise(current, patch) {
    var base = current || {};
    var next = patch || {};
    var has = function (key) { return Object.prototype.hasOwnProperty.call(next, key) && isNum(next[key]) && isNum(base[key]); };
    if (has("maxRunsPerHour") && next.maxRunsPerHour > base.maxRunsPerHour) return true;
    if (has("maxRunsPerDay") && next.maxRunsPerDay > base.maxRunsPerDay) return true;
    if (has("minGapSeconds") && next.minGapSeconds < base.minGapSeconds) return true;
    if (has("activeFromHour") && next.activeFromHour < base.activeFromHour) return true;
    if (has("activeToHour") && next.activeToHour > base.activeToHour) return true;
    return false;
  }

  function megabytes(bytes) {
    return isNum(bytes) ? (Math.round(bytes / 1048576 * 10) / 10) + "MB" : "-";
  }

  function hoursSince(iso, now) {
    var time = Date.parse(iso);
    if (!isFinite(time)) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - time) / 3600000));
  }

  function snapshotResultText(snapshot) {
    if (!snapshot) return "";
    if (snapshot.result === "found" && isNum(snapshot.rank)) return snapshot.rank + "위";
    if (snapshot.result === "out") return RANK_TOP + "위 밖";
    if (snapshot.result === "short") return isNum(snapshot.organicCount) ? "일반 " + snapshot.organicCount + "개 중 없음" : "일반 상품 중 없음";
    if (snapshot.result === "noresult") return "결과 없음";
    return String(snapshot.result || "");
  }

  // 화면에서 '미분류'라고 적으면 기본 그룹(빈 값)으로 본다. '미분류'라는 이름의 그룹이 따로 생기지 않게 한다.
  function normalizeGroupInput(value) {
    var name = String(value || "").normalize("NFC").replace(/\s+/g, " ").trim();
    return name === UNGROUPED_LABEL ? "" : name;
  }

  function isDefaultGroup(name) {
    return !String(name || "").trim() || String(name) === DEFAULT_GROUP;
  }

  function groupDisplayName(name) {
    return isDefaultGroup(name) ? UNGROUPED_LABEL : String(name);
  }

  function keywordSearchUrl(keyword) {
    var text = String(keyword || "").trim();
    return text ? COUPANG_SEARCH_URL + encodeURIComponent(text) : "";
  }

  // ── ① 지금 확인(spec-manual §7) ───────────────────────────────
  // 사람이 카드의 '지금 확인'을 누를 때만, 그 사람 크롬의 전용 확장이 새 시크릿 창으로 쿠팡 검색 1쪽을 한 번 연다.
  // 화면 순서: 확장에 묻기(hello) → 서버 1회용 확인(manual-claim) → 확장에 맡기기(check: 확장이 창을 열기 전에
  // 서버에 그 확인을 직접 확인받는다) → 결과를 서버에 보내기(manual-record) → 목록 다시 받기.
  // 간격·하루 상한·시간·그날 중지는 서버가 서버 시각으로 정한다. 화면은 서버가 준 시각(serverTime)과 내 시계의
  // 차이만 보정해 남은 시간을 보여 준다. 예약·자동 반복은 없다(확장에 check 를 보내는 곳은 startManualCheck 하나).
  // 상태판 '전체 확인'(대표 승인 2026-10-24)도 누를 때만 시작하고, 같은 startManualCheck 를 키워드마다 한 번씩 차례로 부른다.
  // 확장이 따로 기억한 '오늘 차단'으로 화면이 먼저 막지 않는다. 차단 보고는 언제나 서버 기록 경로로 보낸다.

  var MANUAL_HELLO_TYPE = "mi-coupang-hello";
  var MANUAL_CHECK_TYPE = "mi-coupang-check";
  // 서버가 결과를 받은 뒤 확장에 '남겨 둔 결과를 지워도 된다'고 알린다(검색 아님).
  var MANUAL_ACK_TYPE = "mi-coupang-ack";
  var MANUAL_EXTENSION_NAME = "모먼트 인사이트 쿠팡 순위 확인";
  var MANUAL_FOLDER_NAME = "mi-coupang-check";
  var MANUAL_FOLDER_PATTERN = /^[a-z0-9-]{1,40}$/;
  var MANUAL_ZIP_PATH_PATTERN = /^\/coupang-check\/[A-Za-z0-9._-]{1,80}\.zip$/;
  var MANUAL_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
  var MANUAL_CODE_PATTERN = /^[a-z0-9_]{1,60}$/;
  var MANUAL_VERSION_PATTERN = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
  // 측정 중 쿼리만 바뀐 이동(user_navigated)에 확장이 싣는 바뀐 쿼리 이름(page.changedParams, 값 없음)의 상한(contract MANUAL_CHANGED_*).
  var MANUAL_CHANGED_PARAMS_MAX = 10;
  var MANUAL_CHANGED_PARAM_NAME_MAX = 40;
  var MANUAL_HELLO_TIMEOUT_MS = 5000;
  var MANUAL_HELLO_CACHE_MS = 30000;
  var MANUAL_CLAIM_TIMEOUT_MS = 20000;
  // 확장은 창을 연 뒤 120초 안에 끝낸다. 150초가 지나면 '늦습니다'만 알리고, 늦은 보고 창(10분) 안인 9분까지 기다린다.
  var MANUAL_CHECK_SLOW_MS = 150000;
  var MANUAL_CHECK_GIVE_UP_MS = 540000;
  var MANUAL_RECORD_TIMEOUT_MS = 30000;
  var MANUAL_RECORD_RETRY_MS = [3000, 10000];
  // 서버는 확장 확인 뒤 150초 동안 그 확인을 '진행 중'으로 센다(contract MANUAL_SEARCH_WINDOW_SECONDS).
  var MANUAL_LOST_BUSY_MS = 150000;
  // 결과를 보내지 못했을 때 다시 보내려고 남겨 두는 자리(새 탭에서도 보이게 localStorage). 10분 뒤에는 버린다.
  var MANUAL_PENDING_KEY = "miCoupangRankManual:v1:pending";
  var MANUAL_PENDING_MAX_MS = 10 * 60 * 1000;
  var MANUAL_RESUME_POLL_MS = 15000;
  var MANUAL_RESUME_POLL_MAX = 40;
  var MANUAL_RESUME_GAP_MS = 30000;
  var MANUAL_TICK_MS = 1000;
  var MANUAL_BUSY_REFRESH_PAD_MS = 2000;
  var KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  // 확장·서버가 주는 사유 코드 → 쉬운 문구(끝 마침표 없음). 원인을 모르는 경우는 단정하지 않는다.
  var MANUAL_CODE_TEXT = {
    // 확장이 쿠팡 주소를 넣기 전에 멈춘 사유(not_started) — 이때는 쿠팡 검색을 하지 않았다
    // (서버 확인 뒤에 멈췄으면 횟수에는 들 수 있다 — 기록 응답의 counted 로 따로 알린다)
    extension_missing: "이 크롬에서 '" + MANUAL_EXTENSION_NAME + "' 확장을 찾지 못했습니다(설치 안 됨·꺼짐·개발자 모드 꺼짐)",
    extension_outdated: "확장 버전이 낮아 시작하지 않았습니다",
    extension_refused: "확장이 시작하지 않았습니다",
    incognito_not_allowed: "확장의 '시크릿 모드에서 허용'이 꺼져 있어 시작하지 않았습니다",
    host_access_withheld: "확장의 '사이트 액세스'가 막혀 있어 시작하지 않았습니다",
    incognito_window_open: "다른 시크릿 창이 열려 있어 시작하지 않았습니다(모든 시크릿 창을 닫아 주세요)",
    busy: "확장이 다른 확인을 하는 중이라 시작하지 않았습니다",
    too_soon: "확장이 방금 확인해서 시작하지 않았습니다(검색 사이 3분)",
    bad_request: "확장이 요청 형식을 받지 않았습니다(확장 버전을 확인해 주세요)",
    origin_rejected: "확장이 이 화면에서 온 요청을 받지 않았습니다(주소가 insight.momentlabs.co.kr 인지 확인해 주세요)",
    window_create_failed: "시크릿 창을 열지 못했습니다(크롬 설정에서 시크릿 모드가 막혀 있을 수 있습니다)",
    window_create_null: "시크릿 창을 열었지만 확장이 그 창을 다룰 수 없어 멈췄습니다(열린 시크릿 창을 직접 닫고 '시크릿 모드에서 허용'을 켜 주세요)",
    window_closed_early: "쿠팡 검색 전에 시크릿 창이 닫혀 확장이 검색하지 않았습니다(확장이 연 창은 직접 닫지 마세요)",
    claim_reused: "이미 쓴 확인 요청이라 확장이 시작하지 않았습니다",
    report_pending: "앞서 차단으로 보인 결과가 아직 서버에 가지 않아 확장이 새 검색을 하지 않았습니다(그 결과를 먼저 보냅니다)",
    verify_refused: "서버가 이번 확인을 허락하지 않아 확장이 시작하지 않았습니다",
    // 확장의 서버 확인이 401 로 거절됨. 화면은 같은 세션으로 방금 요청을 받았으므로 '다시 로그인'이 답이 아닐 수 있다
    // (확장 요청에 로그인 정보가 실리지 않는 경우 — 첫 실제 시험에서 확인할 [추정] 항목)
    verify_session_required: "확장이 서버에 확인받으려 했지만 서버가 로그인 정보를 받지 못했다고 해 시작하지 않았습니다(화면은 로그인돼 있어도 확장 요청에 로그인 정보가 실리지 않았을 수 있습니다. 다시 로그인해도 같으면 이 문구를 그대로 개발 담당에게 알려 주세요)",
    verify_claim_expired: "확인 요청의 1분 기한이 지나 확장이 시작하지 않았습니다. 다시 눌러 주세요",
    verify_unreachable: "확장이 서버에 연결하지 못해 시작하지 않았습니다(인터넷 연결 확인)",
    verify_invalid: "확장이 서버 확인 응답을 알아보지 못해 시작하지 않았습니다(확장 버전을 확인해 주세요)",
    extension_error: "확장 안에서 오류가 나 시작하지 않았습니다(chrome://extensions 에서 확장을 새로고침(↻)해 주세요)",
    browser_unsupported: "지금 확인은 크롬에서만 됩니다",
    blocked_today: "오늘 차단으로 보이는 화면이 있어 확장이 시작하지 않았습니다",
    stopped: "오늘 '지금 확인'이 멈춰 있어 시작하지 않았습니다",
    daily_cap: "오늘 확인 횟수를 모두 써서 시작하지 않았습니다",
    hours: "정해진 시간 밖이라 시작하지 않았습니다",
    gap: "검색 사이 간격이 지나지 않아 시작하지 않았습니다",
    // 확장 답이 없음(lost) — 검색이 됐는지 화면은 모른다
    extension_no_response: "확장이 답하지 않았습니다(확인 중에 확장이 멈췄거나 꺼졌을 수 있습니다)",
    extension_timeout: "확장 응답을 9분 동안 받지 못해 기다리기를 멈췄습니다",
    // 창을 연 뒤의 실패(확장 page.errorCode · 서버 판정 코드)
    page_timeout: "쿠팡 화면이 45초 안에 다 열리지 않았습니다",
    window_closed: "확인 중에 시크릿 창이 닫혔습니다",
    browser_hard_cap: "2분 안에 끝나지 않아 확장이 창을 닫았습니다",
    page_load_failed: "쿠팡 화면을 불러오지 못했습니다(인터넷 연결 확인)",
    page_unreadable: "쿠팡이 검색이 아닌 곳(로그인 화면 등)으로 보내 화면을 읽지 못했습니다",
    extract_failed: "화면에서 상품 목록을 읽지 못했습니다",
    user_navigated: "확인 중에 창 안에서 다른 쪽으로 옮겨졌습니다(창 안을 누르지 마세요)",
    query_mismatch: "창의 검색어가 요청한 키워드와 달랐습니다(창 안에서 검색하지 마세요)",
    login_state_unknown: "로그인하지 않은 화면인지 확인하지 못해 순위를 기록하지 않았습니다",
    foreign_navigation: "쿠팡 밖 주소로 옮겨졌습니다",
    empty_page: "일반 상품 목록이 비어 있었습니다(원인은 확인하지 못했습니다)",
    record_invalid: "확인 결과 형식이 맞지 않았습니다"
  };

  // 서버 판정(실패 쪽) → 문구. 성공(ok·noresult)과 차단(blocked)은 따로 쓴다.
  var MANUAL_STATUS_TEXT = {
    partial: "목록을 끝까지 읽지 못했습니다(읽는 동안 상품 수가 바뀌었습니다)",
    empty: "일반 상품을 읽지 못했습니다(목록이 비어 있었거나 광고만 보였습니다. 원인은 확인하지 못했고, 차단으로 보지 않았습니다)",
    error: "확인하지 못했습니다",
    timeout: "쿠팡 화면이 제때 열리지 않았습니다",
    unsupported: "쿠팡이 검색 결과가 아닌 쪽으로 보내 순위를 기록하지 못했습니다('이동'으로 기록)"
  };

  // 그날 중지 사유(서버 manual.stoppedCode · 기록 응답 stopCode = contract MANUAL_STOP_CODES) → 짧은 말.
  // 모르는 코드면 사유를 쓰지 않는다(원인을 단정하지 않는다).
  var MANUAL_STOP_REASON_TEXT = {
    blocked_http_403: "쿠팡 응답 HTTP 403",
    blocked_http_429: "쿠팡 응답 HTTP 429",
    blocked_http_503: "쿠팡 응답 HTTP 503",
    blocked_text: "쿠팡 '사용권한' 안내 화면",
    blocked_page: "확장이 차단으로 본 화면",
    login_redirect: "로그인 화면으로 보내짐",
    page_unreadable: "검색이 아닌 곳(로그인 화면 등)으로 보내져 읽지 못함",
    extension_reported: "확장이 오늘 차단으로 보이는 화면을 봤다고 알림"
  };

  function manualSafeCode(value) {
    var code = String(value == null ? "" : value);
    return MANUAL_CODE_PATTERN.test(code) ? code : "";
  }

  function manualCodeText(code) {
    var safe = manualSafeCode(code);
    if (safe && MANUAL_CODE_TEXT[safe]) return MANUAL_CODE_TEXT[safe];
    return safe ? "확장이 끝내지 못했습니다(사유 코드 " + safe + ")" : "확장이 끝내지 못했습니다(사유를 받지 못함)";
  }

  // 확장 결과의 바뀐 쿼리 이름(서버 manualChangedParams 와 같은 규칙): 문자열·1~40 코드 포인트·제어 문자 없음만, 같은 이름 하나,
  // 앞에서부터 10개. 배열이 아니면 null(경로·q 가 바뀐 이동이거나 이름을 싣지 않는 확장).
  function manualChangedParams(page) {
    var list = page && typeof page === "object" && Array.isArray(page.changedParams) ? page.changedParams : null;
    if (!list) return null;
    var out = [];
    for (var index = 0; index < list.length && out.length < MANUAL_CHANGED_PARAMS_MAX; index += 1) {
      var name = list[index];
      if (typeof name !== "string" || !name || /[\u0000-\u001f\u007f]/.test(name)) continue;
      if (Array.from(name).length > MANUAL_CHANGED_PARAM_NAME_MAX || out.indexOf(name) >= 0) continue;
      out.push(name);
    }
    return out;
  }

  // 측정 중 검색 창 주소의 쿼리만 바뀌어 user_navigated 로 끝난 경우의 문구(사람 탓을 하지 않는다). 경로나 검색어(q)가 바뀌었거나
  // 이름을 받지 못하면 null — 그때는 '다른 쪽으로 옮겨졌습니다' 문구(MANUAL_CODE_TEXT.user_navigated)를 쓴다.
  function manualQueryChangedText(page) {
    var names = manualChangedParams(page);
    if (!names || names.indexOf("q") >= 0) return null;
    return "확인 중에 검색 창 주소가 바뀌어 순위를 기록하지 않았습니다" + (names.length ? "(바뀐 값: " + names.join(", ") + ")" : "") +
      ". 창 안을 누르지 않았다면 알려 주세요.";
  }

  // x.y.z 비교(contract.mjs compareVersion 과 같은 규칙).
  function compareVersionText(left, right) {
    var a = String(left || "0.0.0").split(".").map(Number);
    var b = String(right || "0.0.0").split(".").map(Number);
    for (var index = 0; index < 3; index += 1) {
      if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
    }
    return 0;
  }

  // 한국은 서머타임이 없어 KST = UTC+9 로 고정 계산한다(내 컴퓨터 시간대와 무관).
  function kstDayAt(ms) {
    if (!isNum(ms)) return "";
    return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
  }

  function kstHourAt(ms) {
    if (!isNum(ms)) return null;
    return new Date(ms + KST_OFFSET_MS).getUTCHours();
  }

  function countdownText(ms) {
    var seconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes ? minutes + "분 " + pad2(rest) + "초" : rest + "초";
  }

  function manualHours(info) {
    var from = info && isNum(info.fromHour) ? info.fromHour : 9;
    var to = info && isNum(info.toHour) ? info.toHour : 19;
    return { from: from, to: to, text: pad2(from) + "~" + pad2(to) + "시" };
  }

  function manualGapMinutes(info) {
    var seconds = info && isNum(info.minGapSeconds) ? info.minGapSeconds : 180;
    return Math.round(seconds / 6) / 10;
  }

  // 서버가 보낸 상태(그 시각의 사진)를 지금 시각(서버 시각으로 보정한 값)에 맞춰 옮긴다. 화면 표시용이다.
  // 누를 때는 서버가 다시 정한다. 간격이 지났으면 가능, 하루가 바뀌면 그날 중지·하루 상한은 풀린 것으로 본다.
  function manualProjected(server, now) {
    var info = server || {};
    var stateName = String(info.state || "");
    var hours = manualHours(info);
    var today = kstDayAt(now);
    var serverDay = kstDayAt(Date.parse(info.serverTime));
    var newDay = Boolean(today && serverDay && today !== serverDay);
    var hour = kstHourAt(now);
    var inHours = hour === null ? true : (hour >= hours.from && hour < hours.to);
    var nextAt = Date.parse(info.nextAt);
    var busyUntil = Date.parse(info.busyUntil);
    if (stateName === "stopped") {
      if (!newDay && (!info.stoppedDay || String(info.stoppedDay) === today)) stateName = "stopped";
      else stateName = "ready";
    }
    if (stateName === "daily_cap" && newDay) stateName = "ready";
    if (stateName === "busy" && isFinite(busyUntil) && busyUntil <= now) stateName = "ready";
    if (stateName === "gap" && (!isFinite(nextAt) || nextAt <= now)) stateName = "ready";
    if (stateName === "hours" && inHours && !newDay) stateName = "ready";
    if ((stateName === "ready" || stateName === "gap") && !inHours) stateName = "hours";
    if (stateName === "ready" && isFinite(nextAt) && nextAt > now) stateName = "gap";
    return {
      state: stateName,
      used: newDay ? 0 : (isNum(info.usedToday) ? info.usedToday : 0),
      max: isNum(info.maxPerDay) ? info.maxPerDay : 30,
      hours: hours,
      remainingMs: stateName === "gap" && isFinite(nextAt) ? nextAt - now : 0
    };
  }

  function manualIsChromeAgent(userAgent) {
    var ua = String(userAgent || "");
    if (!ua) return true;
    return /Chrome\//.test(ua) && !/Edg\/|OPR\/|Whale\/|SamsungBrowser\//.test(ua);
  }

  // 확장 hello 답 → 화면이 쓰는 모양. version 이 x.y.z 가 아니면 알 수 없는 답으로 본다.
  function parseHelloReply(result) {
    if (!result || result.ok !== true) return { status: "missing", code: manualSafeCode(result && result.code) };
    var reply = result.reply;
    if (!reply || typeof reply !== "object") return { status: "invalid" };
    if (reply.ok === false) return { status: reply.code === "origin_rejected" ? "rejected" : "invalid", code: manualSafeCode(reply.code) };
    if (reply.ok !== true || typeof reply.version !== "string" || !MANUAL_VERSION_PATTERN.test(reply.version)) return { status: "invalid" };
    var flag = function (value) { return value === true ? true : (value === false ? false : null); };
    var leftover = reply.leftover && typeof reply.leftover === "object" ? reply.leftover : {};
    return {
      status: "ok",
      version: reply.version,
      incognitoAllowed: flag(reply.incognitoAllowed),
      hostAccess: flag(reply.hostAccess),
      incognitoWindowOpen: flag(reply.incognitoWindowOpen),
      busy: reply.busy === true,
      // 확장이 지난번 창을 닫지 못했는지(leftover.unknown) · 이번에 닫은 남은 창 수(leftover.closed)
      leftoverWindow: leftover.unknown === true,
      leftoverClosed: isNum(leftover.closed) && leftover.closed > 0 ? leftover.closed : 0,
      browser: typeof reply.browser === "string" ? reply.browser.slice(0, 60) : "",
      pending: parseHeldResult(reply.pending)
    };
  }

  // 확장이 서버에 보내기 전까지 남겨 둔 결과(hello.pending · check report_pending). { claimId, claimToken, stop, reply }
  function parseHeldResult(value) {
    if (!value || typeof value !== "object" || typeof value.claimId !== "string" || !value.claimId) return null;
    return {
      claimId: value.claimId,
      claimToken: typeof value.claimToken === "string" ? value.claimToken : "",
      stop: value.stop === true,
      reply: value.reply && typeof value.reply === "object" ? value.reply : null
    };
  }

  // 확장 check 답 → measured / not_started / lost. 결과는 화면이 서버에 보낸다(확장은 ack 를 받을 때까지 결과를 들고 있다).
  function parseCheckReply(result) {
    if (!result || result.ok !== true) {
      var code = result && result.code;
      if (code === "extension_missing") return { outcome: "not_started", code: "extension_missing" };
      return { outcome: "lost", code: code === "extension_timeout" ? "extension_timeout" : "extension_no_response" };
    }
    var reply = result.reply;
    if (!reply || typeof reply !== "object") return { outcome: "lost", code: "extension_no_response" };
    if (reply.outcome === "measured" && reply.page && typeof reply.page === "object") {
      return {
        outcome: "measured",
        page: reply.page,
        durationMs: Number.isSafeInteger(reply.durationMs) && reply.durationMs >= 0 ? reply.durationMs : null,
        extensionVersion: typeof reply.extensionVersion === "string" && MANUAL_VERSION_PATTERN.test(reply.extensionVersion) ? reply.extensionVersion : "",
        browser: typeof reply.browser === "string" ? reply.browser.slice(0, 60) : "",
        windowLeftOpen: reply.windowLeftOpen === true
      };
    }
    if (reply.outcome === "not_started" || reply.ok === false) {
      return {
        outcome: "not_started",
        code: manualSafeCode(reply.code) || "extension_refused",
        windowLeftOpen: reply.windowLeftOpen === true,
        retryAfterSec: Number.isSafeInteger(reply.retryAfterSec) && reply.retryAfterSec > 0 ? reply.retryAfterSec : null,
        serverCode: typeof reply.serverCode === "string" && /^[A-Z][A-Z0-9_]{0,59}$/.test(reply.serverCode) ? reply.serverCode : "",
        httpStatus: Number.isSafeInteger(reply.httpStatus) && reply.httpStatus >= 100 && reply.httpStatus <= 599 ? reply.httpStatus : null,
        held: parseHeldResult(reply.pending)
      };
    }
    return { outcome: "lost", code: "extension_no_response" };
  }

  // manual-record 본문(spec-manual §6.4). 확장 버전·브라우저가 답에 없으면 hello 값을 쓴다.
  function manualRecordBody(claim, parsed, hello) {
    var body = { action: "manual-record", claimId: claim.claimId, claimToken: claim.claimToken, outcome: parsed.outcome };
    if (parsed.outcome === "measured") {
      body.page = parsed.page;
      if (isNum(parsed.durationMs)) body.durationMs = parsed.durationMs;
      var version = parsed.extensionVersion || (hello && hello.status === "ok" ? hello.version : "");
      var browser = parsed.browser || (hello && hello.status === "ok" ? hello.browser : "");
      if (version) body.extensionVersion = version;
      if (browser) body.browser = browser;
    } else if (manualSafeCode(parsed.code)) {
      body.outcomeCode = parsed.code;
    }
    return body;
  }

  // 차단으로 본 화면의 짧은 사유(보낸 쪽 결과에서). 모르면 빈 글.
  function manualBlockDetail(page, errorCode) {
    var info = page && typeof page === "object" ? page : {};
    var status = isNum(info.httpStatus) ? info.httpStatus : null;
    if (status === 403 || status === 429 || status === 503) return "쿠팡 응답 HTTP " + status;
    if (info.blockedText === true) return "쿠팡 '사용권한' 안내 화면";
    var code = manualSafeCode(errorCode) || manualSafeCode(info.errorCode);
    if (code === "page_unreadable") return MANUAL_STOP_REASON_TEXT.page_unreadable;
    if (String(info.finalHost || "") === "login.coupang.com") return MANUAL_STOP_REASON_TEXT.login_redirect;
    return "";
  }

  function manualStopText(server, detail) {
    var info = server || {};
    var at = kstClock(info.stoppedAt);
    var reason = detail || MANUAL_STOP_REASON_TEXT[manualSafeCode(info.stoppedCode)] || "";
    var extra = [at, reason].filter(Boolean).join(" · ");
    return "오늘 쿠팡 확인 중 차단으로 보이는 화면이 나와 '지금 확인'을 모두 멈췄습니다" + (extra ? "(" + extra + ")" : "") +
      ". 내일 " + pad2(manualHours(info).from) + "시부터 저절로 다시 됩니다.";
  }

  function manualUsage(info) {
    if (!info || !isNum(info.usedToday) || !isNum(info.maxPerDay)) return "";
    return " (오늘 " + info.usedToday + "/" + info.maxPerDay + "번 사용)";
  }

  // 확장 쪽 문제(창을 열 수 없는 상태). 막히면 { text, guide } 를, 아니면 null.
  function manualHelloBlock(hello, server, userAgent) {
    var info = hello || {};
    var minimum = server && MANUAL_VERSION_PATTERN.test(String(server.minExtensionVersion || "")) ? server.minExtensionVersion : "";
    if (info.status === "noid") return { text: "지금 확인: 서버가 확장 ID 를 보내지 않아 확장을 찾을 수 없습니다(배포 확인 필요).", guide: false };
    if (info.status === "missing" || info.status === "invalid" || info.status === "rejected") {
      if (!manualIsChromeAgent(userAgent)) return { text: "지금 확인은 크롬에서만 됩니다. 크롬으로 이 화면을 열어 주세요.", guide: false };
      if (info.status === "rejected") return { text: "지금 확인: " + MANUAL_CODE_TEXT.origin_rejected + ".", guide: false };
      if (info.status === "invalid") return { text: "지금 확인: 확장이 알 수 없는 답을 했습니다. chrome://extensions 에서 확장을 새로고침(↻)하거나 설치 안내대로 다시 설치해 주세요.", guide: true };
      return { text: "지금 확인: 이 크롬에 '" + MANUAL_EXTENSION_NAME + "' 확장이 없거나 꺼져 있습니다. chrome://extensions 에서 개발자 모드와 확장 스위치가 켜져 있는지 확인하고, 처음이면 설치 안내를 따라 주세요.", guide: true };
    }
    if (info.status !== "ok") return null;
    if (minimum && compareVersionText(info.version, minimum) < 0) {
      return { text: "지금 확인: 확장을 새 버전으로 바꿔 주세요(지금 v" + info.version + ", 필요 v" + minimum + "). 설치 안내의 '업데이트' 순서를 따라 주세요.", guide: true };
    }
    if (/^edge\b/i.test(info.browser || "") || !manualIsChromeAgent(userAgent)) return { text: "지금 확인은 크롬에서만 됩니다. 크롬으로 이 화면을 열어 주세요.", guide: false };
    if (info.incognitoAllowed !== true) {
      return { text: "지금 확인: 확장의 '시크릿 모드에서 허용'이 꺼져 있습니다. 주소창에 chrome://extensions 입력 → 확장 '세부정보' → '시크릿 모드에서 허용'을 켜 주세요.", guide: true };
    }
    if (info.hostAccess === false) {
      return { text: "지금 확인: 확장의 '사이트 액세스'가 막혀 있습니다. chrome://extensions → 확장 '세부정보' → '사이트 액세스'를 '모든 사이트에서'로 바꿔 주세요(쿠팡 쪽 읽기와 서버 확인에 필요합니다).", guide: true };
    }
    // 확장은 사이트 액세스·다른 시크릿 창을 확인하지 못하면 창을 열지 않는다. 누르기 전에 같은 기준으로 멈춘다(요청 횟수를 쓰지 않게).
    if (info.hostAccess !== true) {
      return { text: "지금 확인: 확장이 '사이트 액세스' 상태를 알려 주지 않았습니다. chrome://extensions 에서 확장을 새로고침(↻)한 뒤 다시 열어 주세요.", guide: false };
    }
    if (info.incognitoWindowOpen !== true && info.incognitoWindowOpen !== false) {
      return { text: "지금 확인: 확장이 다른 시크릿 창이 있는지 알려 주지 않았습니다. 확장을 새로고침(↻)한 뒤 다시 눌러 주세요.", guide: false };
    }
    return null;
  }

  // 누르기 직전 검사: 확장 쪽 문제 + 다른 시크릿 창 + 확장 작업 중. 막히면 문구, 아니면 "".
  function manualPreflightText(hello, server, userAgent) {
    var block = manualHelloBlock(hello, server, userAgent);
    if (block) return block.text;
    var info = hello || {};
    if (info.status !== "ok") return "지금 확인: 확장 상태를 확인하지 못했습니다. 잠시 뒤 다시 눌러 주세요.";
    if (info.incognitoWindowOpen === true) return manualIncognitoText(info) + " 쿠팡 검색은 하지 않았습니다.";
    if (info.busy) return "지금 확인: 확장이 다른 확인을 하는 중입니다. 잠시 뒤 다시 눌러 주세요.";
    return "";
  }

  function manualIncognitoText(hello) {
    if (hello && hello.leftoverWindow) return "지금 확인: 확장이 지난번에 연 시크릿 창이 남아 있습니다. 열린 시크릿 창을 모두 직접 닫은 뒤 눌러 주세요.";
    return "지금 확인: 다른 시크릿 창이 열려 있습니다. 모든 시크릿 창을 닫고 눌러 주세요(같은 시크릿 세션을 쓰지 않으려는 규칙).";
  }

  function manualRunText(run) {
    var phase = run && run.phase;
    if (phase === "hello") return "지금 확인: 이 크롬의 확장 상태를 확인하는 중입니다…";
    if (phase === "claim") return "지금 확인: 서버에 확인 요청을 받는 중입니다…";
    if (phase === "record") return run.resumed ? "지금 확인: 앞서 보내지 못한 확인 결과를 서버에 보내는 중입니다…" : "지금 확인: 결과를 서버에 기록하는 중입니다…";
    if (run && run.slow) return "지금 확인: 확장 응답이 늦습니다. 최대 9분까지 기다립니다. 이 화면을 닫지 마세요.";
    // 금지 네 가지(창 닫기·창 안 누르기·창 내리기/가리기·이 화면 닫기)는 줄이지 않는다. 결과는 이 화면이 서버에 보낸다.
    return "확인 중입니다… " + MANUAL_WARN_TEXT;
  }

  // 상태 줄 하나(spec-manual §7.3 표 + 반박 검토 반영). 위에서부터 처음 맞는 것을 쓴다.
  // input: { server, now(서버 시각으로 보정한 ms), hello, run, stopDetail, ownPending, ownLost, userAgent }
  // ownLost: 이 화면의 방금 확인이 확장 응답 없이 끝났다(서버는 그 확인을 150초 동안 '진행 중'으로 센다).
  // 서버가 '진행 중'이라고 센 확인이 이 요청(claimId)인지. 서버 요약이 그 확인의 요청 id(busyClaimId)를 줄 때만 안다:
  // 같으면 true, 다르면 false, 주지 않으면 null(모름). 요청한 사람으로 가리는 길은 없다 — 이 화면에는 '나'를 알아볼 값이 없다.
  // [사실] 지금 서버 요약(SQL coupang_rank_manual_summary → manualPayload)은 busyClaimId 도, 요청한 사람도 주지 않는다 → 늘 null.
  var MANUAL_CLAIM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function manualBusyMine(server, claimId) {
    var busyClaimId = server && typeof server.busyClaimId === "string" ? server.busyClaimId : "";
    if (!MANUAL_CLAIM_ID_PATTERN.test(busyClaimId) || typeof claimId !== "string" || !claimId) return null;
    return busyClaimId.toLowerCase() === claimId.toLowerCase();
  }

  // 반환: { visible, enabled(버튼), text, tone, banner(그날 중지 띠), countdown(1초 초 세기), guide(설치 안내 열기), state, kind }
  // kind: 상태판 알약을 고르는 갈래(off · setup_required · stopped · run · hello_pending · hello_block · budget · review · cooldown · hours ·
  // own_unsent · unsent_maybe · own_lost · own_pending · busy_other · daily_cap · gap · ext_busy · incognito · ready · unknown). 판정 순서는 그대로다.
  function manualView(input) {
    var options = input || {};
    var server = options.server;
    var hidden = { visible: false, enabled: false, text: "", tone: "", banner: false, countdown: false, guide: false, state: "", kind: "" };
    if (!server || typeof server !== "object") return hidden;
    var serverState = String(server.state || "");
    if (!serverState || serverState === "setup_required") return Object.assign(hidden, { state: serverState, kind: "setup_required" });
    if (serverState === "off") {
      // 진행 중에 껐다: 그 확인은 끝까지 간다(끄기는 새 확인만 막는다). 끝날 때까지 경고 네 가지를 그대로 보인다(2026-10-23 재검사).
      if (options.run) {
        return { visible: true, enabled: false, text: manualRunText(options.run) + " " + MANUAL_RUN_OFF_TEXT, tone: "", banner: false, countdown: false, guide: false, state: "off", kind: "run" };
      }
      return Object.assign(hidden, { state: "off", kind: "off" });
    }
    var now = isNum(options.now) ? options.now : Date.now();
    var projected = manualProjected(server, now);
    var make = function (kind, enabled, text, tone, extra) {
      return Object.assign({ visible: true, enabled: enabled, text: text, tone: tone || "", banner: false, countdown: false, guide: false, state: projected.state, kind: kind }, extra || {});
    };
    var hours = projected.hours;
    // 그날 중지는 가장 중요한 알림이라 확장 상태보다 먼저 띠로 보인다(확장이 없어도 보여야 한다).
    if (projected.state === "stopped") return make("stopped", false, manualStopText(server, options.stopDetail), "is-warn", { banner: true });
    if (options.run) return make("run", false, manualRunText(options.run), "");
    var hello = options.hello;
    if (!hello || hello.status === "pending") return make("hello_pending", false, "지금 확인: 이 크롬의 확장을 확인하는 중입니다…", "");
    var block = manualHelloBlock(hello, server, options.userAgent);
    if (block) return make("hello_block", false, block.text, "is-warn", { guide: block.guide === true });
    switch (projected.state) {
      case "budget": return make("budget", false, "지금 확인: 저장 용량 상한으로 멈춰 있습니다(대표 확인 필요).", "is-warn");
      case "review": return make("review", false, "지금 확인: 대표 확인이 필요한 상태라 멈춰 있습니다.", "is-warn");
      case "cooldown": {
        var until = server.cooldownUntil ? shortAt(server.cooldownUntil) : "";
        return make("cooldown", false, "지금 확인: 쿠팡 차단 감지로 쉬는 중입니다" + (until && until !== "-" ? "(~" + until + ")" : "") + ".", "is-warn");
      }
      case "hours": return make("hours", false, "지금 확인은 " + hours.text + "에만 됩니다(서버 시각 기준).", "");
      case "busy": {
        var busyLeft = Date.parse(server.busyUntil) - now;
        // 이 화면이 방금 결과를 서버에 보내지 못했고(연결 실패·로그인 풀림·5xx), 서버가 '진행 중'이라고 센 확인이 바로 그 요청이다
        // (서버 요약의 busyClaimId 가 같을 때만 — manualBusyMine).
        if (options.ownUnsent) {
          return make("own_unsent", false, "지금 확인: 방금 확인 결과를 서버에 보내지 못했습니다. 이 화면을 열어 두면 잠시 뒤" +
            (isFinite(busyLeft) && busyLeft > 0 ? "(약 " + countdownText(busyLeft) + ")" : "") +
            " 저절로 다시 보냅니다. 안 되면 버튼이 켜질 때 다시 눌러 주세요(앞 결과부터 보냅니다).", "is-warn", { countdown: true });
        }
        // 보내지 못한 결과는 있지만 '진행 중' 확인이 누구 것인지 서버가 알려 주지 않았다 — 본인 확인이라고도, 다른 사람이라고도 하지 않는다.
        if (options.unsentMaybe) {
          return make("unsent_maybe", false, "지금 확인: 진행 중인 확인이 있습니다" +
            (isFinite(busyLeft) && busyLeft > 0 ? "(약 " + countdownText(busyLeft) + " 뒤 끝남)" : "") +
            ". 이 화면이 서버에 보내지 못한 결과는 화면을 열어 두면 잠시 뒤 저절로 다시 보냅니다. 안 되면 버튼이 켜질 때 다시 눌러 주세요(앞 결과부터 보냅니다).", "is-warn", { countdown: true });
        }
        if (options.ownLost) {
          return make("own_lost", false, "지금 확인: 방금 확인이 확장 응답 없이 끝났습니다" +
            (isFinite(busyLeft) && busyLeft > 0 ? "(약 " + countdownText(busyLeft) + " 뒤 다시 누를 수 있습니다)" : "") + ".", "is-warn", { countdown: true });
        }
        if (options.ownPending) return make("own_pending", false, "지금 확인: 방금 누른 확인이 아직 진행 중입니다. 이 화면을 닫지 마세요.", "");
        // 다른 확인: 카드 버튼 글자가 남은 시간('약 N분 NN초 뒤')이라 1초마다 다시 센다.
        return make("busy_other", false, "지금 확인: 다른 확인이 진행 중입니다. 잠시 뒤 다시 눌러 주세요.", "", { countdown: true });
      }
      case "daily_cap": return make("daily_cap", false, "지금 확인: 오늘 " + projected.max + "번을 모두 썼습니다. 내일 " + pad2(hours.from) + "시부터 다시 됩니다.", "");
      case "gap":
        return make("gap", false, "다음 확인은 " + countdownText(projected.remainingMs) + " 뒤에 할 수 있습니다(검색 사이 " + manualGapMinutes(server) + "분 · 오늘 " + projected.used + "/" + projected.max + "번).", "", { countdown: true });
      default:
        break;
    }
    if (hello.busy) return make("ext_busy", false, "지금 확인: 확장이 다른 확인을 하는 중입니다. 잠시 뒤 다시 눌러 주세요.", "");
    // 다른 시크릿 창은 누를 때 확장에 다시 묻는다(닫았으면 그대로 진행). 그래서 버튼은 켜 둔다.
    if (hello.incognitoWindowOpen === true) return make("incognito", true, manualIncognitoText(hello), "is-warn");
    if (projected.state === "ready") {
      return make("ready", true, "지금 확인: 오늘 " + projected.used + "/" + projected.max + "번 · " + hours.text + " · 검색 사이 " + manualGapMinutes(server) +
        "분 · 누르면 새 시크릿 창이 잠깐 열렸다 닫힙니다.", "");
    }
    return make("unknown", false, "지금 확인: 상태를 알 수 없습니다(" + (manualSafeCode(projected.state) || "?") + "). 화면을 새로고침해 주세요.", "is-warn");
  }

  // 시간 밖일 때 다음에 열리는 시각(서버 시각 기준). 아직 시작 전이면 오늘, 지났으면 내일.
  function manualNextOpenText(hours, now) {
    var hour = kstHourAt(now);
    var head = hour !== null && hour < hours.from ? "오늘 " : "내일 ";
    return head + pad2(hours.from) + ":00";
  }

  // 상태판 알약(manualView 의 모든 갈래 + 꺼짐). 하루 상한·간격은 서버 숫자로 따로 만든다. 모르는 갈래는 '확인 필요(코드 …)'.
  var MANUAL_PILL = {
    off: ["꺼짐", "is-muted"],
    stopped: ["오늘은 멈춤", "is-warn"],
    run: ["확인 중", "is-wait"],
    hello_pending: ["확장 확인 중", "is-muted"],
    hello_block: ["확장 확인 필요", "is-warn"],
    budget: ["용량 상한으로 멈춤", "is-warn"],
    review: ["대표 확인 필요", "is-warn"],
    cooldown: ["쉬는 중", "is-warn"],
    hours: ["시간 밖", "is-muted"],
    own_unsent: ["결과 보내지 못함", "is-warn"],
    unsent_maybe: ["보내지 못한 결과 있음", "is-warn"],
    own_lost: ["응답 없이 끝남", "is-warn"],
    own_pending: ["확인 중", "is-wait"],
    busy_other: ["다른 확인 진행 중", "is-wait"],
    ext_busy: ["확장 작업 중", "is-wait"],
    incognito: ["다른 시크릿 창 열림", "is-warn"],
    ready: ["바로 확인 가능", "is-ok"]
  };

  // 꺼짐(off) 한 줄: 자동 수집이 실제로 기록 중일 때만 '기록 중'이라고 한다. 켜 둔 뒤의 경보·모르는 상태는 단정하지 않고 자동추적 칸으로 보낸다.
  // autoState: "recording"(ok·delayed·idle_hours) · "alarm"(review·budget·cooldown·outdated·offline) · "unknown"(모르는 이름) · ""(자동 수집 안 씀)
  function manualOffLine(autoState, autoCode) {
    var tail = "(지금 확인은 꺼짐). 카드의 '지금 확인' 버튼은 숨겨져 있습니다.";
    if (autoState === "recording") return "자동 수집으로 기록 중입니다" + tail;
    if (autoState === "alarm") return "자동 수집이 켜져 있지만 멈췄거나 확인이 필요한 상태입니다. 아래 자동추적 칸의 경보를 확인하세요" + tail;
    if (autoState === "unknown") return "자동 수집 상태를 알 수 없습니다(코드 " + (manualSafeCode(autoCode) || "?") + "). 아래 자동추적 칸을 확인하세요" + tail;
    return "꺼져 있어 지금은 새 순위를 기록하지 않습니다. 카드의 '지금 확인' 버튼도 숨겨져 있습니다.";
  }

  // '지금 확인' 상태판(목록 맨 위, N30 요약칸 자리). 서버 manual 칸과 받은 추적 목록(오늘 칸)만으로 센다(서버 변경 없음).
  // input: { view(manualView 결과), server, now(서버 시각으로 보정한 ms), trackers, todayKst, autoState, autoCode }
  // (옛 입력 autoActive: true 는 autoState "recording" 과 같다)
  function manualBoardModel(input) {
    var options = input || {};
    var view = options.view || {};
    var server = options.server || {};
    var now = isNum(options.now) ? options.now : Date.now();
    var kind = view.kind || (server.state === "off" ? "off" : "unknown");
    var projected = manualProjected(server, now);
    var hours = projected.hours;
    var pillEntry = kind === "daily_cap"
      ? ["오늘 " + projected.max + "번 다 씀", "is-muted"]
      : (kind === "gap" ? [manualGapMinutes(server) + "분 간격 기다리는 중", "is-wait"] : MANUAL_PILL[kind]);
    if (!pillEntry) pillEntry = ["확인 필요(코드 " + (manualSafeCode(projected.state || server.state) || "?") + ")", "is-warn"];
    var line;
    if (kind === "ready" || kind === "gap") line = MANUAL_BOARD_DESCRIPTION;
    else if (kind === "off") {
      var autoState = typeof options.autoState === "string" ? options.autoState : (options.autoActive ? "recording" : "");
      line = manualOffLine(autoState, options.autoCode);
    } else line = String(view.text || "").replace(/^지금 확인:\s*/, "");
    var busyLeft = Date.parse(server.busyUntil) - now;
    var next;
    if (kind === "gap") next = { value: countdownText(projected.remainingMs) + " 뒤", tone: "is-wait" };
    else if (kind === "ready" || kind === "incognito") next = { value: "지금 가능", tone: "is-ok" };
    else if (kind === "run" || kind === "own_pending") next = { value: "확인 중", tone: "is-wait" };
    else if (kind === "busy_other" || kind === "own_unsent" || kind === "unsent_maybe" || kind === "own_lost") {
      next = { value: isFinite(busyLeft) && busyLeft > 0 ? "약 " + countdownText(busyLeft) + " 뒤" : "잠시 뒤", tone: "is-wait" };
    } else if (kind === "hours") next = { value: manualNextOpenText(hours, now), tone: "" };
    else if (kind === "daily_cap" || kind === "stopped") next = { value: "내일 " + pad2(hours.from) + ":00", tone: "" };
    else if (kind === "off") next = { value: "꺼짐", tone: "" };
    else if (kind === "cooldown") next = { value: server.cooldownUntil && shortAt(server.cooldownUntil) !== "-" ? "~" + shortAt(server.cooldownUntil) : "멈춤", tone: "is-warn" };
    else if (kind === "budget" || kind === "review") next = { value: "멈춤", tone: "is-warn" };
    else if (kind === "ext_busy") next = { value: "잠시 뒤", tone: "is-wait" };
    else if (kind === "hello_block") next = { value: "확장 확인 필요", tone: "is-warn" };
    else next = { value: "-", tone: "" };
    var list = (Array.isArray(options.trackers) ? options.trackers : []).filter(Boolean);
    var active = list.filter(function (tracker) { return tracker.status !== "paused"; });
    var paused = list.length - active.length;
    var todayKst = String(options.todayKst || "");
    var done = todayKst ? active.filter(function (tracker) { return checkedToday(tracker, todayKst); }).length : 0;
    var pending = todayKst ? active.length - done : 0;
    var note = !todayKst ? "오늘 날짜를 받지 못했습니다" : (!active.length ? "확인할 활성 추적이 없습니다" : (pending ? "" : "모두 확인했습니다"));
    if (todayKst && paused) note += (note ? " · " : "") + "일시중지 " + paused + "개 빼고";
    // 횟수가 다시 차는 때: 시작 시각 전(이른 아침)이면 오늘, 아니면 내일(옆 '다음 확인'과 같은 판정, 서버 시각 기준).
    var hourNow = kstHourAt(now);
    var refill = hourNow !== null && hourNow < hours.from
      ? "오늘 " + pad2(hours.from) + "시부터 " + projected.max + "번"
      : "내일 " + pad2(hours.from) + "시에 다시 " + projected.max + "번";
    return {
      kind: kind,
      pill: { text: pillEntry[0], tone: pillEntry[1] },
      line: line,
      lineTone: view.tone === "is-warn" ? "is-warn" : "",
      banner: view.banner === true,
      bannerText: view.banner === true ? String(view.text || "") : "",
      guide: view.guide === true,
      jump: kind === "budget" || kind === "review" || kind === "cooldown",
      // 버튼은 서버 상태를 따른다(진행 중에 꺼서 상태판이 '확인 중'을 보이는 동안에도 '켜기').
      toggle: kind === "off" || server.state === "off" ? "enable" : "disable",
      metrics: {
        next: { label: "다음 확인", value: next.value, note: "검색 사이 " + manualGapMinutes(server) + "분", tone: next.tone },
        used: { label: "오늘 쓴 횟수", value: projected.used + " / " + projected.max + "번", note: hours.text + " · " + refill, tone: "" },
        today: { label: "오늘 확인한 상품", value: todayKst ? done + " / " + active.length + "개" : "-", note: note, pending: pending, paused: paused, tone: "" }
      }
    };
  }

  // 카드 '지금 확인' 버튼 글자(버튼 글자가 곧 상태다 — 마우스를 올리지 않아도 왜 못 누르는지 보인다). mine = 이 카드를 확인하는 중.
  // 켜진 버튼(ready·다른 시크릿 창)과 다른 카드를 확인하는 동안(run)·모르는 상태만 '지금 확인'이다.
  function manualButtonLabel(view, mine, server, now) {
    if (mine) return "확인 중…";
    var info = view || {};
    var at = isNum(now) ? now : Date.now();
    var projected = manualProjected(server || {}, at);
    switch (info.kind) {
      case "gap": return countdownText(projected.remainingMs) + " 뒤";
      case "daily_cap":
      case "stopped": return "내일 " + pad2(projected.hours.from) + ":00";
      case "hours": return manualNextOpenText(projected.hours, at);
      case "busy_other":
      case "own_lost":
      case "own_unsent":
      case "unsent_maybe": {
        var left = Date.parse(server && server.busyUntil) - at;
        return isFinite(left) && left > 0 ? "약 " + countdownText(left) + " 뒤" : "잠시 뒤";
      }
      case "own_pending": return "확인 중…";
      case "ext_busy": return "잠시 뒤";
      case "hello_pending": return "확장 확인 중";
      case "hello_block": return "확장 확인 필요";
      case "budget":
      case "review":
      case "cooldown": return "멈춤";
      default: return "지금 확인";
    }
  }

  // 누른 카드 운영줄 첫 칸의 짧은 결과(앞에 '방금 확인 HH:MM · '를 붙여 보인다 — 확인을 시작하지 않았으면(notStarted) '방금 누름 HH:MM · ').
  // 자세한 문구는 상태판 '직전 확인' 줄에 늘 남는다. outcome = manualRecordText 결과.
  function manualCardNote(outcome, recorded, parsed) {
    var prefix = "";
    var result = recorded || {};
    var payload = result.payload || {};
    var check = parsed || { outcome: "lost" };
    var warn = function (text) { return { text: prefix + text, tone: "is-warn" }; };
    if (outcome && outcome.stopped) return warn("차단으로 보여 오늘 멈춤");
    if (result.transport || result.httpStatus === 401 || payload.code === "SESSION_REQUIRED" || payload.code === "COUPANG_SESSION_REQUIRED" ||
      (!payload.code && payload.ok !== true && result.httpStatus >= 500)) return warn("결과를 서버에 보내지 못함(위 상태판 참고)");
    if (check.outcome === "not_started") return { text: prefix + "시작하지 않음 · 쿠팡 검색 안 함", tone: "is-warn", notStarted: true };
    if (check.outcome !== "measured") return warn("확장 응답 없음 · 검색 여부 모름");
    if (payload.ok !== true) return warn("저장하지 못함(위 상태판 참고)");
    var matched = isNum(payload.matched) && payload.matched > 1 ? " · 같은 키워드 " + payload.matched + "개 함께" : "";
    var tracker = payload.tracker || null;
    if (payload.status === "ok") {
      var text = "기록함";
      if (tracker && tracker.result === "found" && isNum(tracker.rank)) text = "일반 " + tracker.rank + "위로 기록";
      else if (tracker && tracker.result === "out") text = RANK_TOP + "위 밖으로 기록";
      else if (tracker && tracker.result === "short") text = "'없음'으로 기록";
      return { text: prefix + text + matched, tone: "is-ok" };
    }
    if (payload.status === "noresult") return { text: prefix + "'결과 없음'으로 기록" + matched, tone: "is-ok" };
    return warn("실패: 순위를 기록하지 않음(사유는 위 '직전 확인')");
  }

  // claim 거절 문구(쿠팡 검색 전). result = { payload, transport, httpStatus }
  function manualClaimRefusalText(result, server) {
    var payload = result && result.payload || {};
    var info = payload.manual || server || {};
    var tail = " 쿠팡 검색은 하지 않았습니다.";
    if (result && result.transport) return "서버에 연결하지 못해 확인을 시작하지 않았습니다(인터넷 연결을 확인해 주세요)." + tail;
    var code = String(payload.code || "");
    if (code === "COUPANG_MANUAL_GAP") {
      var wait = isNum(payload.retryAfterSec) ? payload.retryAfterSec * 1000 : NaN;
      return "검색 사이 간격(" + manualGapMinutes(info) + "분)을 기다리는 중입니다" + (isFinite(wait) && wait > 0 ? "(" + countdownText(wait) + " 남음)" : "") + "." + tail;
    }
    if (code === "COUPANG_MANUAL_BUSY" && isNum(payload.retryAfterSec) && payload.retryAfterSec > 0) {
      return "다른 확인이 진행 중입니다(약 " + countdownText(payload.retryAfterSec * 1000) + " 뒤 다시 눌러 주세요)." + tail;
    }
    if (code === "COUPANG_MANUAL_HOURS") return "지금 확인은 " + manualHours(info).text + "에만 됩니다." + tail;
    if (code === "COUPANG_MANUAL_DAILY_CAP") return "오늘 확인 " + (isNum(info.maxPerDay) ? info.maxPerDay + "번" : "횟수") + "을 모두 썼습니다. 내일 다시 됩니다." + tail;
    if (!code && result && result.httpStatus >= 500) return "서버 처리 중 오류가 나 확인을 시작하지 않았습니다. 잠시 뒤 다시 눌러 주세요." + tail;
    if (code === "COUPANG_MANUAL_STOPPED") return manualStopText(info, "");
    return errorText(payload) + tail;
  }

  // 시작 못 함·응답 없음 사유. 서버가 거절한 코드(serverCode)·다시 누를 수 있는 시간(retryAfterSec)을 덧붙인다.
  function manualNotStartedText(check) {
    var code = check && check.code;
    var serverCode = check && check.serverCode;
    // 확장의 서버 확인 거절 중 화면 쪽 문구와 원인이 다른 것: 로그인(화면은 방금 같은 세션으로 요청을 받았다 — 확장 요청에
    // 로그인 정보가 안 실렸을 수 있음)·확인 요청 1분 기한(결과 저장 기한 10분과 다르다).
    if (code === "verify_refused" && (serverCode === "SESSION_REQUIRED" || serverCode === "COUPANG_SESSION_REQUIRED" || check.httpStatus === 401)) {
      return MANUAL_CODE_TEXT.verify_session_required;
    }
    if (code === "verify_refused" && serverCode === "COUPANG_MANUAL_CLAIM_EXPIRED") return MANUAL_CODE_TEXT.verify_claim_expired;
    var text = manualCodeText(code);
    if (check && check.serverCode && ERROR_TEXT[check.serverCode]) text += "(" + ERROR_TEXT[check.serverCode].replace(/\.$/, "") + ")";
    if (check && isNum(check.retryAfterSec) && check.retryAfterSec > 0) text += " " + countdownText(check.retryAfterSec * 1000) + " 뒤에 다시 눌러 주세요";
    return text;
  }

  // 결과 문구. recorded = { payload, transport, httpStatus }, parsed = parseCheckReply 결과.
  // 반환 { text, tone, stopped, detail }
  function manualRecordText(recorded, parsed, keyword, server) {
    var result = recorded || {};
    var payload = result.payload || {};
    var info = payload.manual || server || null;
    var check = parsed || { outcome: "lost", code: "extension_no_response" };
    var quoted = keyword ? "'" + keyword + "' " : "";
    var left = check.windowLeftOpen ? " 확장이 연 시크릿 창이 남아 있을 수 있습니다. 열린 시크릿 창을 직접 닫아 주세요." : "";
    if (result.transport) return { text: "결과를 서버에 보내지 못했습니다(인터넷 연결을 확인해 주세요). 이 화면을 10분 안에 다시 열면 저절로 다시 보냅니다." + left, tone: "is-warn" };
    if (result.httpStatus === 401 || payload.code === "SESSION_REQUIRED" || payload.code === "COUPANG_SESSION_REQUIRED") {
      return { text: "로그인이 풀려 결과를 보내지 못했습니다. 10분 안에 다시 로그인하면 이 화면이 저절로 다시 보냅니다." + left, tone: "is-warn" };
    }
    if (!payload.code && payload.ok !== true && result.httpStatus >= 500) {
      return { text: "서버 처리 중 오류가 나 결과를 저장하지 못했습니다. 이 화면을 10분 안에 다시 열면 저절로 다시 보냅니다." + left, tone: "is-warn" };
    }
    var detail = MANUAL_STOP_REASON_TEXT[manualSafeCode(payload.stopCode)] || (check.outcome === "measured" ? manualBlockDetail(check.page, payload.errorCode) : "");
    if (payload.stopped === true || payload.status === "blocked") {
      return {
        text: "확인한 화면이 차단으로 보여" + (detail ? "(" + detail + ")" : "") + " 오늘 '지금 확인'을 모두 멈췄습니다. 내일 " + pad2(manualHours(info).from) + "시부터 저절로 다시 됩니다." + left,
        tone: "is-warn",
        stopped: true,
        detail: detail
      };
    }
    var usage = manualUsage(info);
    if (check.outcome !== "measured") {
      var head = manualNotStartedText(check) + ".";
      var searched = check.outcome === "not_started" ? " 쿠팡 검색은 하지 않았습니다." : " 검색이 됐는지는 확인하지 못했습니다.";
      // 서버가 '확장 확인 뒤'라 횟수에 셌다고 하면(counted) 그 사실을 함께 적는다(검색 0번이어도 하루 1번·간격을 썼다).
      if (check.outcome === "not_started" && payload.counted === true) {
        searched = " 쿠팡 검색은 하지 않았지만 이번 1번은 오늘 횟수에 들어갔고, " + manualGapMinutes(info) + "분 뒤 다시 누를 수 있습니다.";
      }
      if (payload.ok === true || payload.code === "COUPANG_MANUAL_CLAIM_CLOSED") return { text: head + searched + usage + left, tone: "is-warn" };
      return { text: head + searched + " " + errorText(payload) + left, tone: "is-warn" };
    }
    if (payload.ok !== true) return { text: "확인 결과를 저장하지 못했습니다: " + errorText(payload) + left, tone: "is-warn" };
    var status = String(payload.status || "");
    var prefix = payload.duplicate === true ? "이미 기록한 확인입니다. " : "";
    if (status === "ok") {
      var tracker = payload.tracker || null;
      var matched = isNum(payload.matched) && payload.matched > 1 ? " · 같은 키워드 추적 " + payload.matched + "개에 기록" : "";
      var text;
      if (tracker && tracker.result === "found" && isNum(tracker.rank)) {
        text = "확인 완료: " + quoted + "일반 " + tracker.rank + "위" + (isNum(tracker.organicCount) ? "(일반 " + tracker.organicCount + "개 중)" : "") + matched + ".";
      } else if (tracker && tracker.result === "out") {
        text = "확인 완료: " + quoted + "1쪽 일반 상품 1~" + RANK_TOP + "위 안에 없어 '" + RANK_TOP + "위 밖'으로 기록했습니다" +
          (isNum(tracker.adOrder) ? "(광고 칸 " + tracker.adOrder + "번째에만 보임)" : "") + matched + ".";
      } else if (tracker && tracker.result === "short") {
        text = "확인 완료: " + quoted + "1쪽 일반 상품" + (isNum(tracker.organicCount) ? " " + tracker.organicCount + "개" : "") + " 안에 없어 '없음'으로 기록했습니다" + matched + ".";
      } else {
        text = "확인 완료: " + quoted + "기록했습니다" + matched + ". 카드의 '현재' 값을 새로 받습니다.";
      }
      return { text: prefix + text + usage + left, tone: "is-ok" };
    }
    if (status === "noresult") return { text: prefix + "확인 완료: " + quoted + "쿠팡 검색 결과가 없어 '결과 없음'으로 기록했습니다." + usage + left, tone: "is-ok" };
    var code = manualSafeCode(payload.errorCode) || manualSafeCode(check.page && check.page.errorCode);
    var queryChanged = code === "user_navigated" ? manualQueryChangedText(check.page) : null;
    if (queryChanged) return { text: prefix + quoted + queryChanged + usage + left, tone: "is-warn" };
    var reason;
    if (status === "partial" && check.page && check.page.wasHidden === true) reason = "확인 중에 창이 가려지거나 내려가 목록을 끝까지 읽지 못했습니다(다음에는 창을 가리지 마세요)";
    else if (code && MANUAL_CODE_TEXT[code]) reason = MANUAL_CODE_TEXT[code];
    else reason = MANUAL_STATUS_TEXT[status] || "확인하지 못했습니다";
    var keep = status === "unsupported" ? "" : " 순위는 기록하지 않았습니다.";
    return { text: prefix + quoted + reason + "." + keep + usage + left, tone: "is-warn" };
  }

  // ── 전체 확인(대표 승인 2026-10-24) ─────────────────────────────
  // 상태판 '지금 확인 끄기' 옆 '전체 확인': 오늘 아직 확인 안 한 활성 상품(일시중지 빼고)을 키워드마다 한 번씩, 카드 '지금 확인'
  // 한 건 흐름(startManualCheck → finishManualRun)을 그대로 차례로 부른다. 서버 요청 모양·순서는 카드 버튼 한 번과 같다(새 API·파라미터 없음).
  // 다음 건은 서버가 준 간격(manual.nextAt, 상태판 '다음 확인'과 같은 근거)이 지난 뒤에만 시작한다. 절대 시각으로 1초마다 다시 보고,
  // 숨은 탭에서 타이머가 늦으면 늦게 시작할 뿐 앞당기지 않는다. 서버가 간격으로 거절하면 한 번만 다시 기다리고, 그 밖의 거절·실패는 멈춘다.

  var MANUAL_ALL_TICK_MS = 1000;
  // 서버 간격이 끝난 뒤 이만큼 더 기다린다(내 시계 보정 오차로 서버보다 먼저 누르지 않게).
  var MANUAL_ALL_PAD_MS = 2000;
  var MANUAL_ALL_WAIT_TEXT = "전체 확인 중입니다. 키워드마다 " + MANUAL_WARN_TEXT;
  var MANUAL_ALL_BLOCKED_TEXT = "쿠팡 차단으로 보이는 화면이 나와 오늘 지금 확인이 멈췄습니다";
  // 위 그날 중지 띠(role=alert)가 같은 사유를 이미 보이고 읽을 때 끝 요약에 쓰는 짧은 말(같은 문장을 두 번 보이거나 읽지 않게).
  var MANUAL_ALL_BLOCKED_REF = "그날 중지(위 안내 참고)";
  // 대기열이 끝난 직후 이 시간 안에 같은 자리를 누르면 '전체 확인' 시작으로 받지 않는다('멈추기' 두 번 누름 · Enter 반복이
  // 바로 바뀐 '전체 확인'을 누르는 것을 막는다). 더블클릭의 두 번째 누름(event.detail > 1)도 받지 않는다.
  var MANUAL_ALL_RESTART_GUARD_MS = 1000;
  var MANUAL_ALL_BUSY_KINDS ={ run: true, own_pending: true, busy_other: true, own_lost: true, own_unsent: true, unsent_maybe: true, ext_busy: true };

  function manualKeywordKey(tracker) {
    return String(tracker && (tracker.keywordKey || tracker.keyword) || "").trim().toLowerCase();
  }

  // 화면 차례(그룹이 처음 나온 차례 → 그룹 안 목록 차례, 목록 그리기와 같다)로 펼친 추적 목록.
  function manualDisplayOrder(list) {
    var names = [];
    // 그룹 이름·키워드는 사람이 적은 글이라 'constructor' 같은 이름도 올 수 있다 → 원형 없는 객체를 쓴다.
    var groups = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (tracker) {
      if (!tracker) return;
      var name = String(tracker.groupName || DEFAULT_GROUP);
      if (!groups[name]) {
        groups[name] = [];
        names.push(name);
      }
      groups[name].push(tracker);
    });
    var out = [];
    names.forEach(function (name) { out.push.apply(out, groups[name]); });
    return out;
  }

  // 오늘 아직 확인 안 한 활성 상품을 같은 키워드(keywordKey)끼리 하나로 묶은 대기열 후보. 서버가 같은 키워드를 한 번에 함께 기록한다.
  // 반환 { items: [{ key, keyword, trackerIds }], products(상품 수) }
  function manualAllPlan(list, todayKst) {
    var day = String(todayKst || "");
    var items = [];
    var byKey = Object.create(null);
    var products = 0;
    if (!day) return { items: items, products: 0 };
    manualDisplayOrder(list).forEach(function (tracker) {
      if (tracker.status !== "active" || checkedToday(tracker, day)) return;
      var key = manualKeywordKey(tracker);
      if (!key) return;
      products += 1;
      if (!byKey[key]) {
        byKey[key] = { key: key, keyword: String(tracker.keyword || "").trim(), trackerIds: [] };
        items.push(byKey[key]);
      }
      byKey[key].trackerIds.push(tracker.id);
    });
    return { items: items, products: products };
  }

  // '전체 확인'을 못 누르는 사유(짧은 말, 버튼 옆에 그대로 보인다). 누를 수 있으면 "".
  // input: { view(manualView 결과), keywords(대상 키워드 수), remaining(오늘 남은 횟수), busy, cleanup, running }
  function manualAllBlock(input) {
    var options = input || {};
    var kind = options.view && options.view.kind || "";
    if (options.cleanup) return "정리용 화면이라 쓸 수 없음";
    if (kind === "stopped") return "그날 중지";
    if (kind === "daily_cap") return "오늘 횟수 다 씀";
    if (kind === "hours") return "시간 밖";
    if (MANUAL_ALL_BUSY_KINDS[kind] || options.running) return "다른 확인 진행 중";
    if (kind === "hello_pending") return "확장 확인 중";
    if (kind === "hello_block") return "확장 확인 필요";
    if (kind === "budget") return "용량 상한으로 멈춤";
    if (kind === "review") return "대표 확인 필요";
    if (kind === "cooldown") return "쉬는 중";
    if (kind !== "ready" && kind !== "gap" && kind !== "incognito") return "상태를 알 수 없음";
    if (!(options.keywords > 0)) return "확인할 상품 없음";
    if (!(options.remaining > 0)) return "오늘 횟수 다 씀";
    if (options.busy) return "다른 작업 중";
    return "";
  }

  // 걸리는 시간(대략): 키워드 수 × 검색 사이 간격(기본 3분).
  function manualAllMinutes(count, server) {
    return Math.max(1, Math.round((Number(count) || 0) * manualGapMinutes(server)));
  }

  // 대상(오늘 남은 횟수만큼 자른 것) · 모자란 키워드 수.
  function manualAllTake(plan, remaining) {
    var total = plan && Array.isArray(plan.items) ? plan.items.length : 0;
    var room = Math.max(0, Math.floor(Number(remaining) || 0));
    var take = Math.min(total, room);
    return { take: take, shortage: total - take };
  }

  function manualAllHint(take, shortage, server) {
    return "키워드 " + take + "개 · 약 " + manualAllMinutes(take, server) + "분" + (shortage > 0 ? " · " + shortage + "개는 횟수 모자람" : "");
  }

  // 시작 전 확인 창(기존 확인 창 방식). input: { plan, take, shortage, remaining, server, now }
  function manualAllConfirmText(input) {
    var options = input || {};
    var server = options.server || {};
    var plan = options.plan || { items: [], products: 0 };
    var take = options.take;
    var minutes = manualAllMinutes(take, server);
    var hours = manualHours(server);
    var lines = ["'전체 확인'을 시작합니다.",
      "오늘 아직 확인 안 한 상품 " + plan.products + "개(일시중지 빼고 · 키워드 " + plan.items.length + "개)를 키워드마다 한 번씩 차례로 확인합니다. 같은 키워드 상품은 함께 기록됩니다."];
    if (options.shortage > 0) lines.push("오늘 남은 횟수가 " + options.remaining + "번이라 키워드 " + take + "개만 하고, " + options.shortage + "개는 오늘 횟수가 모자라 못 합니다.");
    lines.push("키워드 " + take + "개 · 약 " + minutes + "분(검색 사이 " + manualGapMinutes(server) + "분)");
    var now = isNum(options.now) ? options.now : Date.now();
    var endAt = now + minutes * 60000;
    if (kstDayAt(endAt) !== kstDayAt(now) || kstHourAt(endAt) >= hours.to) lines.push("정해진 시간(" + hours.text + ")이 지나면 남은 키워드는 하지 못하고 멈춥니다.");
    // 금지 네 가지(창 닫기·창 안 누르기·창 내리기/가리기·이 화면 닫기)는 지금 확인 경고 문장(MANUAL_WARN_TEXT)을 그대로 쓴다.
    lines.push("진행하는 동안 키워드마다 " + MANUAL_WARN_TEXT + " '멈추기'로 언제든 멈출 수 있습니다(이미 진행 중인 1건은 끝까지 기록).");
    lines.push("시작할까요?");
    return lines.join("\n");
  }

  // 서버 상태(지금 시각으로 옮긴 것) 또는 claim 거절 코드 → 대기열을 멈추는 사유. 기다리면 되는 상태(간격·진행 중·바로 가능)는 "".
  var MANUAL_ALL_CODE_STATE = {
    COUPANG_MANUAL_STOPPED: "stopped", COUPANG_MANUAL_DAILY_CAP: "daily_cap", COUPANG_MANUAL_HOURS: "hours", COUPANG_MANUAL_BUDGET: "budget",
    COUPANG_MANUAL_COOLDOWN: "cooldown", COUPANG_MANUAL_OFF: "off", COUPANG_MANUAL_SETUP_REQUIRED: "setup_required"
  };
  function manualAllStateStopText(stateName, server) {
    switch (stateName) {
      case "ready":
      case "gap":
      case "busy":
        return "";
      case "stopped": return MANUAL_ALL_BLOCKED_TEXT;
      case "daily_cap": return "오늘 확인 횟수를 모두 써서 멈췄습니다";
      case "hours": return "정해진 시간(" + manualHours(server).text + ") 밖이 되어 멈췄습니다";
      case "budget": return "저장 용량 상한으로 지금 확인이 멈춘 상태라 멈췄습니다";
      case "review": return "대표 확인이 필요한 상태라 멈췄습니다";
      case "cooldown": return "쿠팡 차단 감지로 쉬는 중이라 멈췄습니다";
      case "off": return "지금 확인이 꺼져 멈췄습니다";
      case "setup_required": return "지금 확인을 쓸 수 없는 상태(SQL 전)라 멈췄습니다";
      default: return "지금 확인 상태를 알 수 없어 멈췄습니다(코드 " + (manualSafeCode(stateName) || "?") + ")";
    }
  }

  // claim 거절(쿠팡 검색 전) → 멈춤 사유. 간격 거절 1번째는 부르는 쪽이 다시 기다린다.
  function manualAllClaimStopText(result, server) {
    var info = result || {};
    if (info.transport) return "서버에 연결하지 못해 멈췄습니다";
    var code = String(info.code || "");
    if (code === "COUPANG_MANUAL_GAP") return "간격을 기다린 뒤에도 서버가 간격을 이유로 받지 않아 멈췄습니다";
    if (code === "COUPANG_MANUAL_BUSY") return "다른 확인이 진행 중이라 멈췄습니다";
    if (Object.prototype.hasOwnProperty.call(MANUAL_ALL_CODE_STATE, code)) return manualAllStateStopText(MANUAL_ALL_CODE_STATE[code], server);
    return "서버가 확인을 받지 않아 멈췄습니다(위 '직전 확인' 참고)";
  }

  // 한 건이 끝난 결과(startManualCheck 의 record 갈래) → { success, matched } 또는 { success: false, reason }.
  // 기록 성공(ok·결과 없음)만 다음 키워드로 간다. 차단·보내지 못함·시작 안 함·응답 없음·기록 실패는 모두 멈춘다.
  function manualAllRecordVerdict(result) {
    var info = result || {};
    var payload = info.payload || {};
    if (info.stopped === true || payload.stopped === true || payload.status === "blocked") return { success: false, reason: MANUAL_ALL_BLOCKED_TEXT };
    if (info.final !== true) return { success: false, reason: "결과를 서버에 보내지 못해 멈췄습니다(위 '직전 확인' 참고)" };
    if (info.outcome === "not_started") return { success: false, reason: "확장이 확인을 시작하지 않아 멈췄습니다(위 '직전 확인' 참고)" };
    if (info.outcome !== "measured") return { success: false, reason: "확장 응답이 없어 멈췄습니다(위 '직전 확인' 참고)" };
    if (payload.ok !== true) return { success: false, reason: "확인 결과를 저장하지 못해 멈췄습니다(위 '직전 확인' 참고)" };
    if (payload.status === "ok" || payload.status === "noresult") return { success: true, matched: isNum(payload.matched) && payload.matched > 0 ? payload.matched : 1 };
    return { success: false, reason: "순위를 기록하지 못해 멈췄습니다(위 '직전 확인' 참고)" };
  }

  // 끝 요약 한 줄. input: { reason(멈춘 사유, 끝까지 했으면 ""), at({ number, keyword }), total, checked, recorded, failed, skipped, left, shortage }
  function manualAllSummary(input) {
    var info = input || {};
    var count = function (value) { return isNum(value) ? value : 0; };
    // '상품 n개 기록': 같은 키워드 상품을 함께 기록하므로 키워드 수와 다르다(기록한 것이 상품이라는 것을 글로 밝힌다).
    var tail = count(info.checked) + "개 키워드 · 상품 " + count(info.recorded) + "개 기록 · 실패 " + count(info.failed);
    if (count(info.skipped)) tail += " · 건너뜀 " + count(info.skipped) + "개(일시중지·삭제·이미 확인)";
    if (count(info.left)) tail += " · 남은 " + count(info.left) + "개 키워드는 하지 않음";
    if (count(info.shortage)) tail += " · 키워드 " + count(info.shortage) + "개는 오늘 횟수가 모자라 못 함";
    if (!info.reason) return { text: "전체 확인 끝: " + tail + ".", tone: count(info.failed) ? "is-warn" : "is-ok" };
    var at = info.at && isNum(info.at.number) ? "(" + info.at.number + " / " + count(info.total) + (info.at.keyword ? " '" + info.at.keyword + "'" : "") + "에서)" : "";
    return { text: "전체 확인 멈춤" + at + ": " + info.reason + ". " + tail + ".", tone: "is-warn" };
  }

  // 설치 안내(대표가 따라 할 순서). 문자열은 그대로, { b } 는 굵게.
  function manualGuideSteps(zipName, folderName) {
    var folder = MANUAL_FOLDER_PATTERN.test(String(folderName || "")) ? String(folderName) : MANUAL_FOLDER_NAME;
    var file = zipName || (folder + "-버전.zip");
    return [
      ["크롬 전용입니다. 대표가 평소 쓰는 크롬 프로필에 설치합니다. ", { b: "네이버 수집용 크롬(데스크탑 Profile 3)과 맥 대기 수집 프로필(Profile 5)에는 설치하지 마세요." },
        " 확인: 주소창에 chrome://version → '프로필 경로' 끝이 Profile 3·Profile 5 가 아니어야 합니다."],
      ["위 '확장 내려받기(zip)'를 누릅니다. 다운로드 폴더에 " + file + " 이 생깁니다."],
      ["zip 을 두 번 눌러 풉니다. 생긴 " + folder + " 폴더를 홈 폴더(Finder → 이동 → 홈) 아래 새 폴더 '모먼트인사이트'로 옮깁니다(문서·다운로드·데스크탑 폴더는 쓰지 않습니다)."],
      ["주소창에 chrome://extensions 를 입력하고 오른쪽 위 '개발자 모드(Developer mode)'를 켭니다. ", { b: "개발자 모드는 계속 켜 두세요. 끄면 이 확장도 바로 꺼집니다." }],
      ["'압축해제된 확장 프로그램 로드(Load unpacked)'를 누르고, 3번의 " + folder + " 폴더(manifest.json 이 바로 보이는 폴더)를 고릅니다."],
      ["확장 카드의 '세부정보(Details)' → '시크릿 모드에서 허용(Allow in Incognito)'을 켭니다. '사이트 액세스'는 바꾸지 않습니다(막으면 확인이 멈춥니다). 다른 확장의 '시크릿 모드에서 허용'은 꺼 두세요."],
      ["이 화면을 새로고침하고 '확장 상태 다시 보기'를 누릅니다. '설치됨 · 시크릿 허용 켜짐'이 보이면 끝입니다(안 보이면 아래 확장 ID 를 알려 주세요)."],
      ["업데이트: 홈/모먼트인사이트 의 옛 " + folder + " 폴더를 휴지통에 버리고, 새 zip 을 풀어 같은 자리에 둔 뒤 chrome://extensions 카드의 새로고침(↻)을 누릅니다. 확장을 '삭제(Remove)'했다가 다시 올렸다면 '시크릿 모드에서 허용'을 다시 켭니다."],
      ["멈추기: 위 '지금 확인 끄기'(바로 멈춤). 지우기: chrome://extensions → 확장 카드 '삭제(Remove)'. 이 맥의 크롬은 N30 대기 수집(Profile 5)과 같은 앱이라, N30 크롬 재시작과 겹치면 확인이 중간에 끊길 수 있습니다."]
    ];
  }

  function manualExtensionText(hello) {
    var info = hello || null;
    if (!info || info.status === "pending") return "확장: 확인하는 중…";
    if (info.status === "noid") return "확장: 서버가 확장 ID 를 보내지 않았습니다";
    if (info.status === "missing") return "확장: 이 크롬에서 찾지 못함(설치 안 됨·꺼짐·개발자 모드 꺼짐)";
    if (info.status === "rejected") return "확장: 이 주소에서 온 요청을 받지 않음";
    if (info.status !== "ok") return "확장: 알 수 없는 답(확장을 새로고침하거나 다시 설치해 주세요)";
    var parts = ["설치됨 v" + info.version, info.incognitoAllowed === true ? "시크릿 허용 켜짐" : "시크릿 허용 꺼짐"];
    if (info.hostAccess === false) parts.push("사이트 액세스 막힘");
    else if (info.hostAccess === true) parts.push("사이트 액세스 허용");
    if (info.incognitoWindowOpen === true) parts.push("다른 시크릿 창 열림");
    if (info.leftoverWindow) parts.push("남은 시크릿 창 있음(직접 닫기)");
    if (info.leftoverClosed) parts.push("지난번 남은 시크릿 창 " + info.leftoverClosed + "개를 닫음");
    if (info.busy) parts.push("확인 중");
    return "확장: " + parts.join(" · ");
  }

  // 기본 확장 다리: 페이지 → 확장(externally_connectable). chrome.runtime.lastError 는 콜백 안에서 읽어
  // 콘솔 경고를 막는다. 맞는 확장이 없거나 꺼져 있으면(개발자 모드 꺼짐 포함) extension_missing / no_response.
  function chromeExtensionBridge() {
    return {
      send: function (extensionId, message, timeoutMs) {
        return new Promise(function (resolve) {
          var settled = false;
          var timer = 0;
          var finish = function (result) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
          };
          var runtime = null;
          try {
            runtime = window.chrome && window.chrome.runtime ? window.chrome.runtime : null;
          } catch (error) {
            runtime = null;
          }
          if (!runtime || typeof runtime.sendMessage !== "function") {
            finish({ ok: false, code: "extension_missing" });
            return;
          }
          try {
            runtime.sendMessage(extensionId, message, function (reply) {
              var lastError = null;
              try {
                lastError = runtime.lastError || null;
              } catch (error) {
                lastError = null;
              }
              if (lastError) finish({ ok: false, code: "extension_no_response" });
              else finish({ ok: true, reply: reply });
            });
          } catch (error) {
            finish({ ok: false, code: "extension_missing" });
            return;
          }
          if (isNum(timeoutMs) && timeoutMs > 0) timer = setTimeout(function () { finish({ ok: false, code: "extension_timeout" }); }, timeoutMs);
        });
      }
    };
  }

  function localStore() {
    try {
      return window.localStorage || null;
    } catch (error) {
      return null;
    }
  }

  // ── DOM 도우미(createElement + textContent 만) ───────────────

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    var options = attrs || {};
    Object.keys(options).forEach(function (key) {
      var value = options[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else node.setAttribute(key, value === true ? "" : String(value));
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function button(label, action, extra) {
    var attrs = Object.assign({ type: "button", "data-coupang-rank-action": action, text: label }, extra || {});
    if (!attrs.className) attrs.className = "mi-link-button";
    return el("button", attrs);
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(function () { resolve(); });
      else setTimeout(resolve, 16);
    });
  }

  function confirmAction(message) {
    try {
      return typeof window.confirm === "function" ? window.confirm(message) === true : false;
    } catch (error) {
      return false;
    }
  }

  function storage() {
    try {
      return window.sessionStorage || null;
    } catch (error) {
      return null;
    }
  }

  function pruneCache(keepKey) {
    var store = storage();
    if (!store) return;
    try {
      for (var index = store.length - 1; index >= 0; index -= 1) {
        var key = store.key(index) || "";
        if (key.indexOf(CACHE_PREFIX) === 0 && key !== keepKey) store.removeItem(key);
      }
    } catch (error) {}
  }

  // ── 화면 ─────────────────────────────────────────────────────

  function mount(host, rawDeps) {
    if (!host) throw new Error("MomentCoupangRank.mount: host 가 없습니다.");
    var given = rawDeps || {};
    var deps = {
      mode: given.mode === "readonly" ? "readonly" : "admin",
      fetch: typeof given.fetch === "function" ? given.fetch : function () { return Promise.reject(new Error("fetch 가 연결되지 않았습니다.")); },
      scope: typeof given.scope === "function" ? given.scope : function () { return null; },
      isOwner: typeof given.isOwner === "function" ? given.isOwner : function () { return false; },
      ownerPrimaryCode: typeof given.ownerPrimaryCode === "function" ? given.ownerPrimaryCode : function () { return ""; },
      isOwnerScopePlaceholder: typeof given.isOwnerScopePlaceholder === "function" ? given.isOwnerScopePlaceholder : null,
      normalizeCode: typeof given.normalizeCode === "function" ? given.normalizeCode : defaultNormalize,
      exportTools: given.exportTools || null,
      // ① 지금 확인: 페이지 → 확장 다리. 시험은 가짜를 넘기고, 화면(admin.html)은 넘기지 않아 기본(chrome.runtime)을 쓴다.
      extensionBridge: given.extensionBridge && typeof given.extensionBridge.send === "function" ? given.extensionBridge : chromeExtensionBridge()
    };
    if (!deps.isOwnerScopePlaceholder) {
      deps.isOwnerScopePlaceholder = function (value) {
        var normalized = deps.normalizeCode(value);
        return !normalized || normalized === "owner-session" || normalized === "session";
      };
    }

    var state = freshState();
    var shell = null;
    var observer = null;
    var observedRoot = host.closest ? host.closest("#mi-admin, #mi-clean") : null;
    var wasLocked = Boolean(observedRoot && observedRoot.classList.contains("is-locked"));
    var searchTimer = 0;
    // 카드 '다음'(남은 시간)을 다시 계산하는 타이머. 요청은 보내지 않고 글자만 바꾼다.
    var nextTimer = 0;
    // 요청 순번은 reset 뒤에도 계속 커진다(옛 응답이 새 화면에 끼어들지 않게).
    var seqCounter = 0;
    // ① 지금 확인 간격 초 세기(1초). 화면이 보이고 간격 대기일 때만 돈다.
    var manualTimer = 0;
    // 전체 확인 대기열 재확인(1초 setTimeout 사슬). 숨은 탭에서도 돈다(늦어지면 늦게 시작할 뿐). reset·destroy 에서 지운다.
    var allTimer = 0;
    // 휴대폰 아래 막대 높이 지켜보기(ResizeObserver)와 창 크기 바뀜(날짜 줄 흐림 다시 맞추기) 타이머.
    var dockObserver = null;
    var resizeTimer = 0;

    function freshState() {
      return {
        destroyed: false,
        scopeKey: "",
        payload: null,
        // true 면 500개를 넘은 범위의 일부 목록(정리용): 일시중지·삭제만 허용한다.
        partial: false,
        setupRequired: false,
        loading: false,
        listSeq: 0,
        // 합치기용: 마지막 목록 요청의 범위 키, 받는 중인 요청 순번, 받아 쓴 시각.
        listKey: "",
        listFlight: 0,
        listDoneAt: 0,
        listNote: { text: "", tone: "", detail: "" },
        status: { text: "", tone: "" },
        // 선택 항목 정리 막대 안 결과 한 줄(막대가 한 줄로 접혀도 보인다). bulkNoteAt = 그 글을 쓴 시각(휴대폰 아래 막대에 잠시 남길 때).
        bulkNote: { text: "", tone: "" },
        bulkNoteAt: 0,
        // 휴대폰 아래 막대(선택 항목 정리)를 펼쳤는지. 선택이 0개가 되면 접는다.
        bulkExpanded: false,
        // 카드 한 장의 결과(지금 확인·일시중지 등). 가장 최근 것 하나만 그 카드 운영줄 첫 칸에 보인다(화면 안에서만 기억).
        cardNote: null,
        // 방금 결과를 보인 카드: 상태 필터('오늘 안 함' 등)에서 빠져도 필터·검색·그룹을 바꾸기 전까지 목록에 남긴다.
        sticky: new Set(),
        // 펼친 날짜 칸(추적 id → 날짜). 목록을 다시 그려도 유지한다.
        dayDetails: {},
        // 날짜 줄의 키보드 위치(추적 id → 날짜, roving tabindex). 다시 그려도 그 칸이 탭 정지다.
        dayFocus: {},
        // 다시 그릴 때 되돌릴 포커스 자리(누른 버튼이 잠시 꺼져 카드에 맡겨 둔 경우). renderList 가 쓴다.
        pendingFocus: null,
        selected: new Set(),
        filter: { query: "", group: "", status: "all" },
        collapsed: new Set(),
        runs: {},
        editingGroupId: "",
        busy: false,
        owner: { open: false, seq: 0, loading: false, data: null, error: "", note: { text: "", tone: "" }, timer: 0, freshToken: null, tokenAt: 0, dirty: false, fieldErrors: {}, key: "", flight: 0, doneAt: 0 },
        // ① 지금 확인. server 는 목록 GET 의 manual 칸(총관리자만, 캐시에 남기지 않음), offsetMs 는 서버 시각 - 내 시계.
        // note 는 켜기·끄기 결과(상태판 안 한 줄), extNote 는 확장 상태 다시 보기 결과('내 크롬 확장' 칸 안 한 줄).
        manual: { server: null, offsetMs: 0, hello: null, helloFlight: null, run: null, result: null, stopDetail: "", busyRefreshFor: "", toggling: false,
          resuming: false, resumePolls: 0, resumeTriedAt: {}, settled: {}, lost: null, unsent: null, note: { text: "", tone: "" }, extNote: { text: "", tone: "" }, announced: "", announcedWarn: "",
          // 전체 확인: all = 진행 중인 대기열(없으면 null), allSummary = 마지막 대기열의 끝 요약 한 줄 { text, tone }.
          all: null, allSummary: null }
      };
    }

    function currentScope() {
      try {
        return deps.scope() || null;
      } catch (error) {
        return null;
      }
    }

    function isOwnerSession() {
      try {
        return deps.isOwner() === true;
      } catch (error) {
        return false;
      }
    }

    function canWrite() {
      return deps.mode === "admin" && !(state.payload && state.payload.readOnly === true);
    }

    // 읽기 전용 문구(광고주 문구)를 쓰는 화면인지. 요약칸 알약·'다음 갱신'과 카드 '다음'이 같은 기준을 쓴다.
    function readonlyView() {
      return deps.mode === "readonly" || Boolean(state.payload && state.payload.readOnly === true);
    }

    // 500개를 넘은 범위의 일부 목록을 정리용으로 그리는 중인지.
    function cleanupMode() {
      return state.partial === true && Boolean(state.payload);
    }

    function cleanupAllows(action) {
      return action === "pause" || action === "delete";
    }

    function isHostVisible() {
      if (observedRoot && observedRoot.classList.contains("is-locked")) return false;
      var view = host.closest ? host.closest(".mi-view") : null;
      return !view || view.classList.contains("is-active");
    }

    function sameScope(scope) {
      var now = currentScope();
      return Boolean(scope && now && now.key === scope.key);
    }

    function requestHeaders(scope, extra) {
      var headers = Object.assign({}, extra || {});
      if (isOwnerSession() && scope && scope.role === "owner" && scope.agencyCode) headers["x-mi-agency-code"] = scope.agencyCode;
      return headers;
    }

    async function readJson(response) {
      var payload = null;
      try {
        payload = response && typeof response.json === "function" ? await response.json() : null;
      } catch (error) {
        payload = null;
      }
      if (!payload || typeof payload !== "object") {
        payload = { ok: false, code: "", message: "응답을 확인할 수 없습니다" + (response && response.status ? "(HTTP " + response.status + ")" : "") + "." };
      }
      if (response && response.ok === false && payload.ok !== false) payload.ok = false;
      return payload;
    }

    async function getView(query, scope) {
      var response = await deps.fetch(API_PATH + "?" + query, {
        method: "GET",
        cache: "no-store",
        headers: requestHeaders(scope),
        timeoutMs: 30000
      });
      return readJson(response);
    }

    async function postAction(body) {
      var scope = currentScope();
      if (!scope) return { ok: false, message: "대상 광고주를 먼저 고르세요." };
      var payload;
      try {
        var response = await deps.fetch(API_PATH, {
          method: "POST",
          cache: "no-store",
          headers: requestHeaders(scope, { "content-type": "application/json" }),
          body: JSON.stringify(body),
          timeoutMs: 20000
        });
        payload = await readJson(response);
      } catch (error) {
        // 브라우저 영어 오류(Failed to fetch 등)는 화면에 그대로 보이지 않는다(원문은 detail 에만 둔다).
        payload = { ok: false, message: "서버에 연결하지 못했습니다(인터넷 연결 확인). 잠시 뒤 다시 시도하세요.", detail: String(error && error.message || "") };
      }
      if (!sameScope(scope)) return { ok: false, stale: true, message: "요청 중 대상 광고주가 바뀌어 결과를 버렸습니다." };
      return payload;
    }

    // ── 캐시(sessionStorage) ──

    function readCache(scope) {
      var store = storage();
      if (!store || !scope) return null;
      var key = cacheKey(scope);
      try {
        var raw = store.getItem(key);
        if (!raw) return null;
        var cached = JSON.parse(raw);
        var savedAt = Number(cached && cached.savedAt || 0);
        var payload = cached && cached.payload;
        if (!savedAt || Date.now() - savedAt > CACHE_TTL_MS || savedAt - Date.now() > 60000 ||
          !scopedPayload(payload, scope, deps) || payload.complete !== true || payload.hasMore !== false) {
          store.removeItem(key);
          return null;
        }
        return payload;
      } catch (error) {
        try { store.removeItem(key); } catch (ignored) {}
        return null;
      }
    }

    function writeCache(scope, payload) {
      var store = storage();
      if (!store || !scope) return;
      var key = cacheKey(scope);
      try {
        pruneCache(key);
        var text = JSON.stringify({ savedAt: Date.now(), payload: payload });
        if (text.length <= CACHE_MAX_CHARS) store.setItem(key, text);
        else store.removeItem(key);
      } catch (error) {
        try { store.removeItem(key); } catch (ignored) {}
      }
    }

    function removeCache(scope) {
      var store = storage();
      if (!store || !scope) return;
      try { store.removeItem(cacheKey(scope)); } catch (error) {}
    }

    // ── 목록 받기 ──

    function stillCurrent(seq, scope) {
      return !state.destroyed && seq === state.listSeq && sameScope(scope);
    }

    function recentlyDone(doneAt) {
      if (!doneAt) return false;
      var age = Date.now() - doneAt;
      return age >= 0 && age < LIST_REUSE_MS;
    }

    // 같은 범위 목록을 받는 중이거나 방금(2초 안) 받아 썼으면 true. 실패한 요청은 합치지 않는다.
    function listReusable(scope) {
      if (!scope || state.listKey !== scope.key) return false;
      if (state.listFlight && state.listFlight === state.listSeq) return true;
      return recentlyDone(state.listDoneAt);
    }

    function ownerReusable(scope) {
      var owner = state.owner;
      if (!scope || owner.key !== scope.key) return false;
      if (owner.flight && owner.flight === owner.seq) return true;
      return recentlyDone(owner.doneAt);
    }

    // options.reuse: 화면 열기(show)에서만 true — 같은 범위 목록을 받는 중이거나 방금 받았으면 보내지 않는다.
    // options.afterWrite: 추적기를 바꾼 직후 새로 받기(runBulk). 화면의 옛 목록이 낡았다는 뜻이다.
    // 쓰기 뒤 새로 받기는 합치지 않는다(받는 중인 요청은 쓰기 전 목록일 수 있다).
    async function loadList(options) {
      var opts = options || {};
      var scope = currentScope();
      if (!scope) {
        renderAll();
        return;
      }
      if (opts.reuse === true && listReusable(scope)) return;
      var seq = state.listSeq = ++seqCounter;
      state.listKey = scope.key;
      state.listFlight = seq;
      state.listDoneAt = 0;
      try {
        state.loading = true;
        renderListNote();
        var url = API_PATH + "?limit=" + LIST_LIMIT;
        var requestOptions = { method: "GET", cache: "no-store", headers: requestHeaders(scope), timeoutMs: 30000 };
        var response;
        try {
          try {
            response = await deps.fetch(url, requestOptions);
          } catch (firstError) {
            // 일시적 연결 실패·시간 초과면 1.5초 뒤 한 번만 다시 시도한다(N30 목록 조회와 같은 규칙).
            if (!stillCurrent(seq, scope)) return;
            await wait(1500);
            if (!stillCurrent(seq, scope)) return;
            response = await deps.fetch(url, requestOptions);
          }
        } catch (error) {
          if (!stillCurrent(seq, scope)) return;
          state.loading = false;
          // 원문(브라우저 영어 오류)은 마우스를 올리면 보이는 title 에만 둔다.
          state.listNote = { text: "서버에 연결하지 못해 목록을 받지 못했습니다(인터넷 연결 확인). 화면의 이전 목록을 그대로 둡니다.", tone: "is-warn", detail: String(error && error.message || "") };
          renderAll();
          return;
        }
        var payload = await readJson(response);
        if (!stillCurrent(seq, scope)) return;
        state.loading = false;
        if (applyListPayload(payload, scope, opts.afterWrite === true)) {
          state.listDoneAt = Date.now();
          ensureManualHello();
        }
      } finally {
        if (state.listFlight === seq) state.listFlight = 0;
      }
    }

    function cleanupNoteText(payload) {
      var total = isNum(payload.totalCount) ? payload.totalCount : "?";
      var head = "추적이 " + LIST_LIMIT + "개를 넘어(전체 " + total + "개) " + payload.trackers.length + "개만 받았습니다.";
      if (!canWrite()) return head + " 받은 목록만 보여 줍니다.";
      return head + " 정리용 화면이라 일시중지·삭제만 됩니다(등록·다시 시작·그룹 변경은 막아 둡니다). " +
        "일시중지한 추적도 " + LIST_LIMIT + "개에 세므로, 전체 목록을 다시 보려면 삭제로 " + LIST_LIMIT + "개 이하로 줄이세요.";
    }

    // 받은 응답을 화면 상태에 반영한다. 정상 응답(설정 필요·전체 목록·500개 초과 일부 목록)이면 true 를
    // 돌려준다 — 그때만 2초 합치기 창을 연다. 목록을 불러왔다는 알림은 두지 않는다(맨 위 상태줄은 할 말이 있을 때만).
    function applyListPayload(payload, scope, afterWrite) {
      // ① 지금 확인 칸(총관리자에게만 온다)은 목록과 따로 둔다. 캐시(sessionStorage)에 남기지 않는다.
      var manualInfo = takeManualInfo(payload);
      if (payload && payload.ok === true && payload.setupRequired === true) {
        state.setupRequired = true;
        state.payload = null;
        state.partial = false;
        state.selected.clear();
        state.listNote = { text: "", tone: "" };
        setManualServer(null);
        removeCache(scope);
        renderAll();
        return true;
      }
      if (!payload || payload.ok !== true) {
        state.listNote = { text: errorText(payload) + " 화면의 이전 목록을 그대로 둡니다.", tone: "is-warn" };
        renderAll();
        return false;
      }
      if (!scopedPayload(payload, scope, deps)) {
        state.listNote = { text: "받은 목록의 범위가 지금 대상과 달라 화면을 바꾸지 않았습니다. 대상 광고주를 확인한 뒤 다시 여세요.", tone: "is-warn" };
        renderAll();
        return false;
      }
      if (payload.complete !== true || payload.hasMore !== false) {
        var totalText = "목록 일부만 받아 화면을 바꾸지 않았습니다(전체 " + (isNum(payload.totalCount) ? payload.totalCount : "?") + "개). 추적을 500개 이하로 줄여 주세요.";
        if (payload.hasMore !== true) {
          // 행 수와 count 가 어긋난 일시적 불일치: 이전 목록을 그대로 둔다(§8.2).
          state.listNote = { text: totalText, tone: "is-warn" };
          renderAll();
          return false;
        }
        // 범위 추적이 500개를 넘었다(활성+일시중지). 옛 캐시는 이제 맞지 않으므로 지운다.
        removeCache(scope);
        if (payload.trackers.length > 0 && (!state.payload || state.partial || afterWrite === true)) {
          // 화면에 목록이 없거나(첫 진입·캐시 없음) 이미 정리용이거나 방금 지운 뒤라 옛 목록이 낡았으면,
          // 빈 화면 대신 받은 목록을 정리용으로 그린다(일시중지·삭제만, 캐시하지 않음).
          state.setupRequired = false;
          state.payload = payload;
          state.partial = true;
          state.editingGroupId = "";
          state.listNote = { text: cleanupNoteText(payload), tone: "is-warn" };
          pruneSelection();
          setManualServer(manualInfo);
          renderAll();
          return true;
        }
        // 화면에 전체 목록이 있으면 그 목록을 그대로 둔다(§8.2). 그 목록에서도 일시중지·삭제할 수 있다.
        state.listNote = { text: totalText + " 일시중지한 추적도 500개에 세므로 개수를 줄이려면 삭제하세요.", tone: "is-warn" };
        setManualServer(manualInfo);
        renderAll();
        return true;
      }
      state.setupRequired = false;
      state.payload = payload;
      state.partial = false;
      state.listNote = { text: "", tone: "" };
      pruneSelection();
      setManualServer(manualInfo);
      writeCache(scope, payload);
      renderAll();
      return true;
    }

    function pruneSelection() {
      var ids = new Set(trackers().map(function (tracker) { return tracker.id; }));
      Array.from(state.selected).forEach(function (id) { if (!ids.has(id)) state.selected.delete(id); });
      Object.keys(state.runs).forEach(function (id) { if (!ids.has(id)) delete state.runs[id]; });
      Object.keys(state.dayDetails).forEach(function (id) { if (!ids.has(id)) delete state.dayDetails[id]; });
      Array.from(state.sticky).forEach(function (id) { if (!ids.has(id)) state.sticky.delete(id); });
      if (state.cardNote && !ids.has(state.cardNote.trackerId)) state.cardNote = null;
      if (state.editingGroupId && !ids.has(state.editingGroupId)) state.editingGroupId = "";
    }

    function trackers() {
      return state.payload && Array.isArray(state.payload.trackers) ? state.payload.trackers : [];
    }

    function findTracker(id) {
      var list = trackers();
      for (var index = 0; index < list.length; index += 1) if (list[index].id === id) return list[index];
      return null;
    }

    // 서버 응답의 오늘(KST). 없으면 days30 의 첫 날(오늘). 둘 다 없으면 ''(오늘 판정을 하지 않는다).
    function todayKstValue() {
      var payload = state.payload;
      if (!payload) return "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(payload.todayKst || ""))) return String(payload.todayKst);
      return Array.isArray(payload.days30) && payload.days30.length ? String(payload.days30[0] || "") : "";
    }

    // 상태 필터에 맞는 추적 + 방금 결과를 보인 카드(sticky: 상태 필터만 건너뛰고 검색·그룹은 그대로 본다).
    function visibleTrackers() {
      var todayKst = todayKstValue();
      var loose = { query: state.filter.query, group: state.filter.group, status: "all" };
      return trackers().filter(function (tracker) {
        if (filterMatches(tracker, state.filter, todayKst)) return true;
        return state.sticky.has(tracker.id) && filterMatches(tracker, loose, todayKst);
      });
    }

    function clearSticky() {
      state.sticky.clear();
    }

    // 상태 버튼마다 붙는 개수(검색·그룹은 지금 값 그대로, 상태만 바꿔 센다).
    function filterCounts() {
      var todayKst = todayKstValue();
      var base = { query: state.filter.query, group: state.filter.group, status: "all" };
      var matched = trackers().filter(function (tracker) { return filterMatches(tracker, base, todayKst); });
      var counts = {};
      FILTER_STATUSES.forEach(function (entry) {
        var filter = { status: entry[0] };
        counts[entry[0]] = entry[0] === "all" ? matched.length : matched.filter(function (tracker) { return filterMatches(tracker, filter, todayKst); }).length;
      });
      return counts;
    }

    // 고를 수 있는 그룹 이름: 기본 그룹을 뺀 이름을 가나다순으로(N30 rankGroupNamesForCard 와 같은 규칙).
    function groupNames() {
      var names = [];
      trackers().forEach(function (tracker) {
        var name = String(tracker.groupName || DEFAULT_GROUP);
        if (!isDefaultGroup(name) && names.indexOf(name) < 0) names.push(name);
      });
      return names.sort(function (left, right) { return left.localeCompare(right, "ko"); });
    }

    function collectorStateName() {
      if (state.setupRequired) return "setup_required";
      var info = collectorInfo();
      return info && info.state ? String(info.state) : "";
    }

    function collectorInfo() {
      return state.payload && state.payload.collector ? state.payload.collector : null;
    }

    // 자동 수집이 돌거나 돌 수 있는 상태인지(수집기 0대·수집 꺼짐·SQL 전이 아님). 목록 응답에는 enabled 가 없어 상태 이름으로만 가린다.
    // review·budget·outdated·offline 처럼 켜 둔 뒤의 경보도 '돈다' 쪽이다(경보를 숨기지 않는다).
    function autoActive() {
      var name = collectorStateName();
      return Boolean(name) && !AUTO_IDLE_STATES[name];
    }

    // '기록 중'이라고 말해도 되는지는 autoActive 와 따로 가린다(①자동추적 칸을 보일지 ≠ ②자동 수집이 기록하고 있다고 말할지).
    // "recording" · "alarm"(켜 둔 뒤의 경보) · "unknown"(모르는 상태 이름) · ""(자동 수집 안 씀).
    function autoMode() {
      var name = collectorStateName();
      if (!name || AUTO_IDLE_STATES[name]) return "";
      if (AUTO_RECORDING_STATES[name]) return "recording";
      return AUTO_ALARM_STATES[name] ? "alarm" : "unknown";
    }

    function checksPerDay() {
      var info = collectorInfo();
      if (info && isNum(info.checksPerDay)) return info.checksPerDay;
      var settings = state.owner.data && state.owner.data.settings;
      return settings && isNum(settings.checksPerDay) ? settings.checksPerDay : null;
    }

    // ── 뼈대 ──

    // 큰 카드 하나 안에 등록 줄(+안내 한 줄·한도) → 상태줄(할 말이 있을 때만) → 목록 패널. 목록 패널은 제목·개수 → 목록 알림 →
    // '지금 확인' 상태판(N30 요약칸 자리) → (자동 수집이 돌 때만) 자동추적 칸 → 필터 줄 → 선택 항목 정리 → 그룹·카드 순서다.
    // 보조 칸(사용 방법 · 내 크롬 확장 · 자동 수집)은 큰 카드 아래 한 상자에 접힌 줄로 둔다. 화면 머리는 admin.html 의 한 겹뿐이다
    // (C30 만 N30 과 다름, 대표 결정 2026-10-23). data-coupang-rank-* 훅 이름은 그대로다.
    function ensureShell() {
      if (shell && host.contains(shell.main)) return shell;
      host.classList.add("mi-coupang-rank-root");
      host.replaceChildren();
      shell = {};
      shell.main = el("article", { className: "mi-card mi-card-pad mi-rank-card mi-coupang-rank-main" });
      shell.limit = el("span", { className: "mi-coupang-rank-limit", "data-coupang-rank-limit": true, hidden: true,
        title: "이 계정이 추적할 수 있는 상품 수입니다. 여러 계정이 나눠 쓰는 전체 한도는 아래 '자동 수집' 칸에 있습니다." });
      shell.form = el("div", { className: "mi-coupang-rank-form", "data-coupang-rank-form": true, hidden: true });
      shell.status = el("p", { className: "mi-code-status mi-coupang-rank-status", "data-coupang-rank-status": true, "aria-live": "polite", hidden: true });
      shell.capacity = el("p", { className: "mi-coupang-rank-capacity", "data-coupang-rank-capacity": true, hidden: true });
      shell.board = el("div", { className: "mi-rank-panel mi-rank-history mi-coupang-rank-board", "data-coupang-rank-board": true });
      shell.main.appendChild(shell.form);
      shell.main.appendChild(shell.status);
      shell.main.appendChild(shell.capacity);
      shell.main.appendChild(el("div", { className: "mi-rank-grid mi-coupang-rank-grid" }, [shell.board]));
      // 카드 한 장 동작(일시중지·다시 시작·그룹 저장)의 성공 결과를 화면 읽기 프로그램에 알리는 자리(카드 알약은 다시 그릴 때 새로 생겨 읽히지 않는다).
      shell.srLive = el("p", { className: "mi-coupang-rank-sr", "aria-live": "polite", "data-coupang-rank-sr-live": true });
      shell.main.appendChild(shell.srLive);
      shell.aux = el("section", { className: "mi-card mi-coupang-rank-aux", "data-coupang-rank-aux": true, "aria-label": "사용 방법 · 내 크롬 확장 · 자동 수집" });
      shell.guide = el("details", { className: "mi-coupang-rank-guide", "data-coupang-rank-guide": true });
      shell.ext = el("details", { className: "mi-coupang-rank-ext", "data-coupang-rank-ext": true, hidden: true });
      shell.owner = el("details", { className: "mi-coupang-rank-owner", "data-coupang-rank-owner": true, hidden: true });
      shell.aux.appendChild(shell.guide);
      shell.aux.appendChild(shell.ext);
      shell.aux.appendChild(shell.owner);
      host.appendChild(shell.main);
      host.appendChild(shell.aux);
      buildForm();
      buildBoard();
      buildExtFrame();
      buildOwnerFrame();
      watchDock();
      return shell;
    }

    // 휴대폰 아래 막대(선택 항목 정리)의 높이만큼 화면 맨 아래 여백을 늘린다(막대가 마지막 칸·보조 상자를 가리지 않게).
    // 넓은 화면에서는 막대가 제자리(display: contents)라 높이가 0 이다.
    function watchDock() {
      if (dockObserver) {
        try { dockObserver.disconnect(); } catch (error) {}
        dockObserver = null;
      }
      if (typeof ResizeObserver !== "function" || !shell || !shell.bulkDock) return;
      try {
        dockObserver = new ResizeObserver(function () { syncDockSpace(); });
        dockObserver.observe(shell.bulkDock);
      } catch (error) {
        dockObserver = null;
      }
    }

    function syncDockSpace() {
      if (!shell || !shell.bulkDock || !host.style || typeof host.style.setProperty !== "function") return;
      var height = 0;
      if (!shell.bulk.hidden && shell.bulkDock.classList.contains("is-shown") && typeof shell.bulkDock.getBoundingClientRect === "function") {
        var rect = shell.bulkDock.getBoundingClientRect();
        height = rect && isNum(rect.height) ? Math.ceil(rect.height) : 0;
      }
      host.style.setProperty("--mi-coupang-rank-dock-space", height + "px");
      host.classList.toggle("is-docked", height > 0);
    }

    function announce(text) {
      if (!shell || !shell.srLive || !text) return;
      // 같은 글을 다시 써도 바뀐 것으로 알도록 끝 공백을 번갈아 붙인다.
      shell.srLive.textContent = shell.srLive.textContent === text ? text + " " : text;
    }

    function setStatus(text, tone) {
      state.status = { text: text || "", tone: tone || "" };
      renderStatus();
    }

    // 맨 위 상태줄은 할 말이 있을 때만 보인다(등록 결과·화면 오류·실패). 목록을 불러왔다는 알림·기본 안내문은 두지 않는다.
    function renderStatus() {
      if (!shell) return;
      var text = state.status.text;
      shell.status.textContent = text;
      shell.status.hidden = !text;
      shell.status.classList.remove("is-ok", "is-warn");
      if (text && state.status.tone) shell.status.classList.add(state.status.tone);
    }

    // 결과 한 줄은 두 곳에 쓴다: 막대 안 줄(aria-live, 넓은 화면) + 휴대폰 아래 막대 안 줄(같은 글, 화면 읽기에는 한 번만).
    // 휴대폰에서 선택이 0개가 되어(삭제·그룹 옮김) 아래 막대가 접혀도 결과 줄은 BULK_NOTE_FLOAT_MS 동안 화면 아래에 남는다.
    function setBulkNote(text, tone) {
      state.bulkNote = { text: text || "", tone: tone || "" };
      state.bulkNoteAt = text ? Date.now() : 0;
      if (!shell) return;
      renderBulkBar();
      if (!text) return;
      var owner = state;
      var at = state.bulkNoteAt;
      setTimeout(function () {
        if (owner !== state || state.destroyed || !shell || state.bulkNoteAt !== at) return;
        renderBulkBar();
      }, BULK_NOTE_FLOAT_MS + 100);
    }

    function bulkNoteFloating() {
      return Boolean(state.bulkNote.text) && Date.now() - (state.bulkNoteAt || 0) < BULK_NOTE_FLOAT_MS;
    }

    function renderBulkNote() {
      if (!shell) return;
      var note = state.bulkNote;
      var className = "mi-coupang-rank-bulk-note" + (note.tone ? " " + note.tone : "");
      shell.bulkNote.textContent = note.text;
      shell.bulkNote.hidden = !note.text;
      shell.bulkNote.className = className;
      shell.bulkDockNote.textContent = note.text;
      shell.bulkDockNote.hidden = !note.text;
      shell.bulkDockNote.className = "mi-coupang-rank-bulk-dock-note" + (note.tone ? " " + note.tone : "");
    }

    // 카드 한 장의 결과. 다시 그릴 때 그 카드 운영줄 첫 칸에 보이고, 상태 필터에서 빠져도 목록에 남긴다(sticky).
    function setCardNote(id, text, tone) {
      if (!id || !text) return;
      state.cardNote = { trackerId: id, text: text, tone: tone || "" };
      state.sticky.add(id);
    }

    function renderAll() {
      if (state.destroyed) return;
      ensureShell();
      renderForm();
      renderStatus();
      renderStrip();
      renderOwnerVisibility();
      renderFilterBar();
      renderBulkBar();
      renderListNote();
      renderList();
      renderManual();
      renderManualOwner();
      renderGuide();
    }

    // ── 1. 자동추적 요약칸(N30 .mi-rank-auto-center 와 같은 칸). 자동 수집이 돌 때만 지금 확인 상태판 아래에 보인다. ──
    // 조건은 거꾸로 쓴다: 수집기 0대·수집 꺼짐·SQL 전이 아니면 보인다(켜 둔 뒤의 경보 review·budget·outdated 를 숨기지 않게).
    // 지금 확인 상태판이 없는 화면(읽기 전용·서버 manual 칸 없음)은 예전처럼 늘 보인다.
    function stripVisible() {
      if (!currentScope()) return false;
      if (readonlyView() || state.setupRequired) return true;
      if (!state.payload) return deps.mode !== "admin";
      return autoActive() || !manualBoardVisible();
    }

    function renderStrip() {
      shell.strip.replaceChildren();
      if (!stripVisible()) {
        shell.strip.hidden = true;
        return;
      }
      var collector = state.setupRequired ? { state: "setup_required" } : collectorInfo();
      var summary = autoSummary(collector, state.setupRequired ? [] : trackers(), { mode: readonlyView() ? "readonly" : "admin", loading: state.loading });
      shell.strip.hidden = false;
      shell.strip.setAttribute("data-coupang-rank-strip", summary.state || "unknown");
      shell.strip.appendChild(el("div", { className: "mi-rank-auto-head" }, [
        el("span", { className: "mi-rank-auto-status" + (summary.pill.tone ? " " + summary.pill.tone : ""), "data-coupang-rank-strip-status": true, text: summary.pill.text }),
        el("strong", { text: "자동추적" }),
        el("small", { text: summary.small })
      ]));
      shell.strip.appendChild(el("div", { className: "mi-rank-auto-metrics" }, summary.metrics.map(function (metric) {
        return el("div", { className: "mi-rank-auto-metric" + (metric.tone ? " " + metric.tone : "") }, [
          el("span", { text: metric.label }),
          el("strong", { text: metric.value }),
          el("small", { text: metric.note })
        ]);
      })));
    }

    // ── 2. 등록 줄(키워드·URL·그룹·버튼 4칸) + 안내 한 줄·한도 알약 ──

    function buildForm() {
      var form = el("form", { className: "mi-rank-form mi-coupang-rank-create", "data-coupang-rank-create-form": true, novalidate: true });
      var groupListId = "mi-coupang-rank-groups-" + Math.random().toString(36).slice(2, 10);
      shell.groupListId = groupListId;
      shell.keyword = el("input", { className: "mi-input", type: "text", name: "keyword", maxlength: String(KEYWORD_MAX), autocomplete: "off", placeholder: "키워드", "aria-label": "쿠팡 검색 키워드", "data-coupang-rank-keyword": true });
      shell.productUrl = el("input", { className: "mi-input", type: "text", name: "productUrl", autocomplete: "off", placeholder: "쿠팡 상품 URL 붙여넣기", "aria-label": "쿠팡 상품 URL", "data-coupang-rank-product-url": true });
      shell.groupInput = el("input", { className: "mi-input", type: "text", name: "groupName", maxlength: String(GROUP_MAX), autocomplete: "off", placeholder: "그룹(비우면 " + UNGROUPED_LABEL + ")", "aria-label": "그룹 선택 또는 새 그룹 이름", list: groupListId, "data-coupang-rank-group-input": true });
      shell.groupList = el("datalist", { id: groupListId });
      shell.createButton = el("button", { className: "mi-button", type: "submit", text: "순위 추적", "data-coupang-rank-create": true });
      form.appendChild(shell.keyword);
      form.appendChild(shell.productUrl);
      form.appendChild(shell.groupInput);
      form.appendChild(shell.groupList);
      form.appendChild(shell.createButton);
      shell.form.appendChild(form);
      shell.form.appendChild(el("div", { className: "mi-coupang-rank-form-foot" }, [
        el("p", { className: "mi-coupang-rank-form-hint", text: FORM_HINT_TEXT }),
        shell.limit
      ]));
    }

    function renderForm() {
      var scope = currentScope();
      var visible = Boolean(scope) && canWrite() && !state.setupRequired;
      shell.form.hidden = !visible;
      if (!visible) {
        shell.limit.hidden = true;
        shell.capacity.hidden = true;
        return;
      }
      var limit = state.payload ? state.payload.limit : null;
      shell.limit.textContent = limitText(limit);
      shell.limit.hidden = !limit;
      var cleanup = cleanupMode();
      // 정리용 화면에서는 등록을 막는다(행이 더 늘어나 500개 아래로 내려갈 수 없다).
      var warning = cleanup
        ? "추적이 " + LIST_LIMIT + "개를 넘어 정리하는 동안에는 등록할 수 없습니다. 삭제로 " + LIST_LIMIT + "개 이하로 줄이면 다시 등록할 수 있습니다."
        : capacityText(limit, checksPerDay());
      shell.capacity.textContent = warning;
      shell.capacity.hidden = !warning;
      shell.groupList.replaceChildren();
      groupNames().forEach(function (name) { shell.groupList.appendChild(el("option", { value: name })); });
      shell.createButton.disabled = state.busy || !state.payload || cleanup;
    }

    // 등록 결과의 첫 기록 안내. 서버 firstCheck(recorded/queued)는 그대로 쓰고, queued 의 말만 지금 방식에 맞춘다.
    function firstCheckText(code) {
      if (code === "recorded") return FIRST_CHECK_TEXT.recorded + ".";
      if (code !== "queued") return "";
      if (manualVisible()) return FIRST_CHECK_TEXT.manual + ".";
      var mode = autoMode();
      if (mode === "recording") return FIRST_CHECK_TEXT.queued + ".";
      if (mode) return FIRST_CHECK_TEXT.stalled + ".";
      return FIRST_CHECK_TEXT.off + ".";
    }

    async function submitCreate() {
      if (!canWrite() || state.busy || cleanupMode()) return;
      var keyword = String(shell.keyword.value || "").replace(/\s+/g, " ").trim();
      var productUrl = String(shell.productUrl.value || "").trim();
      var groupName = normalizeGroupInput(shell.groupInput.value);
      // 빈 칸 안내는 N30 등록 줄과 같은 말투로 쓴다. 서버 응답 문구(ERROR_TEXT)는 그대로 둔다.
      if (!keyword) {
        setStatus("키워드를 입력해주세요.", "is-warn");
        shell.keyword.focus();
        return;
      }
      if (!productUrl) {
        setStatus("쿠팡 상품 URL을 입력해주세요.", "is-warn");
        shell.productUrl.focus();
        return;
      }
      if (Array.from(groupName).length > GROUP_MAX) {
        setStatus(ERROR_TEXT.COUPANG_GROUP_INVALID, "is-warn");
        return;
      }
      var body = { action: "create", keyword: keyword, productUrl: productUrl };
      if (groupName) body.groupName = groupName;
      state.busy = true;
      renderForm();
      setStatus("등록하는 중입니다…", "");
      var result = await postAction(body);
      state.busy = false;
      if (result.stale) {
        renderAll();
        return;
      }
      if (!result.ok) {
        setStatus(errorText(result), "is-warn");
        renderForm();
        return;
      }
      var createdId = result.tracker && result.tracker.id ? String(result.tracker.id) : "";
      if (createdId) {
        mergeTracker(result.tracker);
        // 상태 필터에 걸려도 새 카드를 보이게 한다(그 자리로 옮겨 강조한다).
        state.sticky.add(createdId);
      }
      if (result.limit && state.payload) state.payload.limit = result.limit;
      var message;
      if (result.alreadyTracking) message = "이미 추적 중입니다";
      else if (result.resumed) message = "일시중지했던 추적을 다시 시작했습니다. " + firstCheckText(result.firstCheck);
      else message = "등록했습니다. " + firstCheckText(result.firstCheck);
      if (!result.alreadyTracking) {
        shell.keyword.value = "";
        shell.productUrl.value = "";
      }
      setStatus(message.trim(), result.alreadyTracking ? "is-warn" : "is-ok");
      var scope = currentScope();
      if (state.payload && scope) writeCache(scope, state.payload);
      renderAll();
      if (createdId) revealCard(createdId);
    }

    // 등록한(또는 이미 있던) 카드로 옮기고 2초 동안 테두리로 강조한다. 접힌 그룹이면 그리지 않았으므로 옮기지 않는다.
    function revealCard(id) {
      if (!shell || !id) return;
      var card = shell.list.querySelector('[data-coupang-rank-card][data-coupang-rank-id="' + String(id).replace(/["\\]/g, "") + '"]');
      if (!card) return;
      card.classList.add("is-new");
      try {
        if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (error) {}
      var owner = state;
      setTimeout(function () {
        if (owner !== state) return;
        card.classList.remove("is-new");
      }, 2000);
    }

    function mergeTracker(tracker) {
      if (!state.payload) return;
      var list = state.payload.trackers.slice();
      var found = false;
      for (var index = 0; index < list.length; index += 1) {
        if (list[index].id === tracker.id) {
          list[index] = tracker;
          found = true;
        }
      }
      if (!found) list.push(tracker);
      state.payload = Object.assign({}, state.payload, {
        trackers: list,
        returnedCount: list.length,
        totalCount: Math.max(list.length, isNum(state.payload.totalCount) ? state.payload.totalCount + (found ? 0 : 1) : list.length)
      });
    }

    // ── 3. 목록 패널: 제목·개수 · 지금 확인 상태판 · 필터 줄 · 선택 항목 정리 ──

    function buildBoard() {
      shell.filterCount = el("span", { className: "mi-coupang-rank-count", "data-coupang-rank-filter-count": true });
      shell.boardHead = el("div", { className: "mi-coupang-rank-board-head" }, [el("h3", { text: "상품별 일별 순위" }), shell.filterCount]);

      shell.filterBar = el("div", { className: "mi-rank-filterbar mi-coupang-rank-filterbar", "data-coupang-rank-filter": true });
      shell.search = el("input", { className: "mi-input", type: "search", placeholder: "키워드, 상품명, 상품번호 검색", "aria-label": "쿠팡 순위 추적 검색", "data-coupang-rank-filter-search": true });
      shell.groupFilter = el("select", { className: "mi-input", "aria-label": "쿠팡 순위 추적 그룹 필터", "data-coupang-rank-filter-group": true });
      shell.groupFilterWrap = el("label", { className: "mi-rank-group-filter" }, [el("span", { text: "그룹" }), shell.groupFilter]);
      shell.statusButtons = el("div", { className: "mi-rank-filter-actions mi-coupang-rank-filter-actions", role: "group", "aria-label": "쿠팡 순위 추적 상태 필터" });
      shell.statusCounts = {};
      FILTER_STATUSES.forEach(function (entry) {
        if (entry[0] === "today-none") shell.statusButtons.appendChild(el("span", { className: "mi-coupang-rank-filter-sep", "aria-hidden": "true" }));
        var count = el("em", { className: "mi-coupang-rank-filter-num" });
        shell.statusCounts[entry[0]] = count;
        shell.statusButtons.appendChild(el("button", { className: "mi-rank-filter-button", type: "button", "data-coupang-rank-filter-status": entry[0] }, [entry[1] + " ", count]));
      });
      shell.filterBar.appendChild(shell.search);
      shell.filterBar.appendChild(shell.groupFilterWrap);
      shell.filterBar.appendChild(shell.statusButtons);

      // 선택 항목 정리: [제목 · n개 선택 | 보이는 항목 전체 선택] 아래 한 칸에 '안내 글'과 '동작 줄'을 겹쳐 두고 고르면 바꿔 보인다.
      // 두 내용이 같은 칸을 쓰므로 카드를 체크하는 순간 막대 높이가 바뀌지 않는다(목록이 밀리지 않음, 2026-10-23 재검사).
      // 휴대폰(900px 이하)에서는 동작 줄을 화면 아래 막대(dock)에 띄운다: 접힌 한 줄('n개 선택 · 정리 열기') → 누르면 펼침.
      // 동작 8개·action 값·삭제 확인 창은 그대로이고, 위험한 '선택 삭제'는 맨 끝에 떨어뜨린다. 결과는 막대 안 한 줄(bulkNote)과
      // 휴대폰 아래 막대 안 한 줄(bulkDockNote)에 보인다.
      shell.bulk = el("div", { className: "mi-rank-bulk-bar mi-coupang-rank-bulk", "data-coupang-rank-bulk": true });
      shell.bulkCount = el("span", { className: "mi-coupang-rank-bulk-count", "data-coupang-rank-selected-count": true, hidden: true });
      shell.bulkHint = el("small", { className: "mi-coupang-rank-bulk-hint" });
      shell.bulkSheetHint = el("small", { className: "mi-coupang-rank-bulk-sheet-hint", text: "아래 막대에서 정리합니다" });
      shell.bulkSelectVisible = button("보이는 항목 전체 선택", "select-visible", { className: "mi-button subtle mi-coupang-rank-bulk-select" });
      shell.bulkGroupInput = el("input", { className: "mi-input", type: "text", maxlength: String(GROUP_MAX), autocomplete: "off", list: shell.groupListId, placeholder: "그룹명 선택 또는 입력", "aria-label": "선택 항목 이동 그룹", "data-coupang-rank-bulk-group-input": true });
      shell.bulkGroupWrap = el("span", { className: "mi-coupang-rank-bulk-group" }, [
        shell.bulkGroupInput,
        button("그룹으로 옮기기", "bulk-group", { className: "mi-button", "data-coupang-rank-write": true }),
        button("그룹 해제", "bulk-ungroup", { className: "mi-button subtle", "data-coupang-rank-write": true })
      ]);
      // 휴대폰 아래 막대 머리: 'n개 선택'과 펼치기 단추(넓은 화면에서는 숨김 — 동작 줄이 막대 안에 바로 보인다).
      var actionsId = "mi-coupang-rank-bulk-actions-" + Math.random().toString(36).slice(2, 10);
      shell.bulkSheetCount = el("strong", { className: "mi-coupang-rank-bulk-sheet-count", "aria-hidden": "true" });
      shell.bulkSheetToggle = button("정리 열기 ▴", "bulk-sheet-toggle", { className: "mi-button subtle mi-coupang-rank-bulk-sheet-toggle", "aria-expanded": "false", "aria-controls": actionsId });
      shell.bulkActions = el("div", { className: "mi-coupang-rank-bulk-actions", id: actionsId, "data-coupang-rank-bulk-actions": true, "aria-hidden": "true" }, [
        shell.bulkGroupWrap,
        el("span", { className: "mi-coupang-rank-bulk-set" }, [
          button("일시중지", "bulk-pause", { className: "mi-button subtle", "data-coupang-rank-write": true }),
          button("다시 시작", "bulk-resume", { className: "mi-button subtle", "data-coupang-rank-write": true })
        ]),
        el("span", { className: "mi-coupang-rank-bulk-set" }, [
          button("선택 이미지 저장", "bulk-export", { className: "mi-rank-share-image" }),
          button("선택 해제", "clear-selection", { className: "mi-button subtle" })
        ]),
        button("선택 삭제", "bulk-delete", { className: "mi-button subtle mi-coupang-rank-danger mi-coupang-rank-bulk-delete", "data-coupang-rank-write": true })
      ]);
      shell.bulkNote = el("p", { className: "mi-coupang-rank-bulk-note", "data-coupang-rank-bulk-note": true, "aria-live": "polite", hidden: true });
      // 아래 막대 안 결과 줄은 같은 글이라 화면 읽기에는 숨긴다(위 bulkNote 가 aria-live 로 한 번 읽는다).
      shell.bulkDockNote = el("p", { className: "mi-coupang-rank-bulk-dock-note", "data-coupang-rank-bulk-dock-note": true, "aria-hidden": "true", hidden: true });
      shell.bulkDock = el("div", { className: "mi-coupang-rank-bulk-dock", "data-coupang-rank-bulk-dock": true }, [
        el("div", { className: "mi-coupang-rank-bulk-dock-head" }, [shell.bulkSheetCount, shell.bulkSheetToggle]),
        shell.bulkDockNote,
        shell.bulkActions
      ]);
      shell.bulk.appendChild(el("div", { className: "mi-rank-bulk-title mi-coupang-rank-bulk-title" }, [
        el("strong", { text: "선택 항목 정리" }),
        shell.bulkCount
      ]));
      shell.bulk.appendChild(shell.bulkSelectVisible);
      shell.bulk.appendChild(el("div", { className: "mi-coupang-rank-bulk-stack" }, [
        el("div", { className: "mi-coupang-rank-bulk-msg" }, [shell.bulkHint, shell.bulkSheetHint]),
        shell.bulkDock
      ]));
      shell.bulk.appendChild(shell.bulkNote);

      shell.listNote = el("p", { className: "mi-coupang-rank-list-note", "data-coupang-rank-list-note": true, "aria-live": "polite", hidden: true });
      shell.strip = el("div", { className: "mi-rank-auto-center mi-coupang-rank-auto", "data-coupang-rank-strip": true, role: "status", hidden: true });
      shell.list = el("div", { className: "mi-coupang-rank-list", "data-coupang-rank-list": true });
      buildManualBoard();
      shell.board.appendChild(shell.boardHead);
      shell.board.appendChild(shell.listNote);
      shell.board.appendChild(shell.manualBox);
      shell.board.appendChild(shell.strip);
      shell.board.appendChild(shell.filterBar);
      shell.board.appendChild(shell.bulk);
      shell.board.appendChild(shell.list);
    }

    // ① 지금 확인 상태판(N30 .mi-rank-auto-center 와 같은 자리·같은 칸 모양): [상태 알약 · 제목 · 한 줄] [다음 확인 · 오늘 쓴 횟수 ·
    // 오늘 확인한 상품] [끄기/켜기]. 아래 넓은 줄에 그날 중지 띠(role=alert) · 켜기/끄기 결과 · 직전 확인 결과를 둔다.
    // 1초 초 세기는 aria-live 밖(칸·버튼 글자)에서만 바뀌고, 화면 읽기 프로그램에는 상태 알약이 바뀔 때만 알린다.
    function buildManualBoard() {
      shell.manualBox = el("div", { className: "mi-rank-auto-center mi-coupang-rank-manual", "data-coupang-rank-manual-box": true, role: "group", "aria-label": "지금 확인 상태", hidden: true });
      shell.manualPill = el("span", { className: "mi-rank-auto-status mi-coupang-rank-manual-pill", "data-coupang-rank-manual-state": true });
      shell.manualLine = el("small", { className: "mi-coupang-rank-manual-line", "data-coupang-rank-manual-line": true });
      shell.manualBox.appendChild(el("div", { className: "mi-rank-auto-head mi-coupang-rank-manual-head" }, [shell.manualPill, el("strong", { text: "지금 확인" }), shell.manualLine]));
      shell.manualMetrics = {};
      var metrics = el("div", { className: "mi-rank-auto-metrics mi-coupang-rank-manual-metrics" });
      ["next", "used", "today"].forEach(function (key) {
        var node = { box: el("div", { className: "mi-rank-auto-metric", "data-coupang-rank-manual-metric": key }), label: el("span"), value: el("strong"), note: el("small") };
        node.box.appendChild(node.label);
        node.box.appendChild(node.value);
        node.box.appendChild(node.note);
        shell.manualMetrics[key] = node;
        metrics.appendChild(node.box);
      });
      shell.manualBox.appendChild(metrics);
      shell.manualToggle = el("button", { type: "button", className: "mi-button subtle", "data-coupang-rank-action": "manual-disable", "data-coupang-rank-manual-toggle": true, text: "지금 확인 끄기" });
      shell.manualToggleHint = el("small", { className: "mi-coupang-rank-manual-hint" });
      shell.manualGuideButton = button("설치 안내 열기", "manual-guide-open", { className: "mi-button subtle mi-coupang-rank-manual-guide-open", hidden: true });
      shell.manualJump = button("자동 수집 칸에서 해제하기", "owner-jump", { className: "mi-button subtle", "data-coupang-rank-manual-jump": true, hidden: true });
      // 전체 확인: '지금 확인 끄기' 옆(위). 누를 수 없으면 그 사유를, 누를 수 있으면 키워드 수·걸리는 시간을 아래 작은 글로 보인다.
      // 진행 중에는 같은 자리가 '멈추기'가 된다.
      shell.allButton = el("button", { type: "button", className: "mi-button mi-coupang-rank-all-button", "data-coupang-rank-action": "manual-all-start", "data-coupang-rank-all-button": true, text: "전체 확인" });
      shell.allHint = el("small", { className: "mi-coupang-rank-manual-hint mi-coupang-rank-all-hint", "data-coupang-rank-all-hint": true });
      shell.allBlock = el("div", { className: "mi-coupang-rank-all", "data-coupang-rank-all": true, hidden: true }, [shell.allButton, shell.allHint]);
      shell.manualBox.appendChild(el("div", { className: "mi-coupang-rank-manual-side" }, [shell.allBlock, shell.manualToggle, shell.manualToggleHint, shell.manualGuideButton, shell.manualJump]));
      shell.manualBanner = el("div", { className: "mi-coupang-rank-manual-banner is-warn", role: "alert", "data-coupang-rank-manual-banner": true, hidden: true });
      shell.manualNote = el("p", { className: "mi-coupang-rank-manual-note", "data-coupang-rank-manual-note": true, "aria-live": "polite", hidden: true });
      shell.manualResult = el("p", { className: "mi-coupang-rank-manual-result", "data-coupang-rank-manual-result": true, "aria-live": "polite", hidden: true });
      shell.manualAnnounce = el("span", { className: "mi-coupang-rank-sr", "aria-live": "polite", "data-coupang-rank-manual-announce": true });
      // 전체 확인 진행 줄: '전체 확인 2 / 5 · 키워드'(aria-live, 한 건이 바뀔 때만 바뀐다) + 남은 시간(1초 초 세기, aria-live 밖). 끝나면 요약 한 줄.
      shell.allStep = el("span", { className: "mi-coupang-rank-all-step", "aria-live": "polite", "data-coupang-rank-all-step": true });
      shell.allCountdown = el("span", { className: "mi-coupang-rank-all-countdown", "data-coupang-rank-all-countdown": true });
      shell.allProgress = el("p", { className: "mi-coupang-rank-all-progress", "data-coupang-rank-all-progress": true, hidden: true }, [shell.allStep, shell.allCountdown]);
      shell.allSummary = el("p", { className: "mi-coupang-rank-all-summary", "data-coupang-rank-all-summary": true, "aria-live": "polite", hidden: true });
      shell.manualBox.appendChild(shell.manualBanner);
      shell.manualBox.appendChild(shell.allProgress);
      shell.manualBox.appendChild(shell.allSummary);
      shell.manualBox.appendChild(shell.manualNote);
      shell.manualBox.appendChild(shell.manualResult);
      shell.manualBox.appendChild(shell.manualAnnounce);
    }

    function renderFilterBar() {
      var hasData = Boolean(state.payload) && !state.setupRequired;
      shell.filterBar.hidden = !hasData;
      shell.filterCount.hidden = !hasData;
      if (!hasData) return;
      var names = groupNames();
      if (state.filter.group && names.indexOf(state.filter.group) < 0) state.filter.group = "";
      var todayKst = todayKstValue();
      if (state.filter.status === "today-none" && !todayKst) state.filter.status = "all";
      shell.groupFilter.replaceChildren(el("option", { value: "", text: "전체 그룹" }));
      names.forEach(function (name) { shell.groupFilter.appendChild(el("option", { value: name, text: name })); });
      shell.groupFilter.value = state.filter.group;
      shell.groupFilterWrap.classList.toggle("is-filtered", Boolean(state.filter.group));
      if (shell.search.value !== state.filter.query && document.activeElement !== shell.search) shell.search.value = state.filter.query;
      var counts = filterCounts();
      Array.prototype.forEach.call(shell.statusButtons.querySelectorAll("[data-coupang-rank-filter-status]"), function (node) {
        var key = node.getAttribute("data-coupang-rank-filter-status");
        var active = key === state.filter.status;
        node.classList.toggle("is-active", active);
        node.setAttribute("aria-pressed", active ? "true" : "false");
        if (key === "today-none") node.hidden = !todayKst;
        if (shell.statusCounts[key]) setText(shell.statusCounts[key], String(counts[key] || 0));
      });
      var sep = shell.statusButtons.querySelector(".mi-coupang-rank-filter-sep");
      if (sep) sep.hidden = !todayKst;
      var shown = visibleTrackers().length;
      shell.filterCount.textContent = cleanupMode()
        ? "받은 " + trackers().length + "개(전체 " + (isNum(state.payload.totalCount) ? state.payload.totalCount : "?") + "개) 중 " + shown + "개 표시"
        : trackers().length + "개 중 " + shown + "개 표시";
    }

    function renderBulkBar() {
      var hasData = Boolean(state.payload) && !state.setupRequired && trackers().length > 0;
      // 모두 지워 목록이 비어도 결과 한 줄이 떠 있는 동안은 막대를 '결과 줄만' 모양(is-note-only)으로 남긴다: 넓은 화면은 CSS 가 막대를 감추고
      // (결과는 맨 위 상태줄 — runBulk), 휴대폰은 화면 아래 막대 안 결과 줄만 보인다(맨 위 상태줄은 화면 밖이라 안 보였다, 2026-10-23 재검사).
      var noteOnly = !hasData && Boolean(state.payload) && !state.setupRequired && bulkNoteFloating();
      shell.bulk.hidden = !hasData && !noteOnly;
      shell.bulk.classList.toggle("is-note-only", noteOnly);
      if (noteOnly) {
        state.bulkExpanded = false;
        shell.bulk.classList.remove("is-open");
        shell.bulkCount.hidden = true;
        shell.bulkSheetToggle.hidden = true;
        shell.bulkActions.setAttribute("aria-hidden", "true");
        shell.bulkDock.classList.add("is-shown");
        shell.bulkDock.classList.remove("is-expanded");
        renderBulkNote();
        syncDockSpace();
        return;
      }
      if (!hasData) {
        syncDockSpace();
        return;
      }
      var count = state.selected.size;
      var open = count > 0;
      var writable = canWrite();
      var cleanup = cleanupMode();
      if (!open) state.bulkExpanded = false;
      shell.bulk.classList.toggle("is-open", open);
      // 정리용 화면은 펼쳤을 때 안내 글 자리를 동작 줄이 쓰므로 제한을 'n개 선택' 옆에 붙인다.
      var countText = open ? count + "개 선택" + (cleanup ? " · 일시중지·삭제만" : "") : "";
      shell.bulkCount.textContent = countText;
      shell.bulkSheetCount.textContent = countText;
      shell.bulkCount.hidden = !open;
      // 안내 글은 접혀도 펼쳐도 같은 글을 둔다(겹친 칸의 높이를 지킨다). 펼치면 CSS 가 감추고 동작 줄을 보인다.
      shell.bulkHint.textContent = cleanup
        ? "정리용 화면이라 선택 항목의 일시중지·삭제만 됩니다."
        : (writable
          ? "카드를 체크하면 그룹 옮기기 · 일시중지 · 삭제 · 이미지 저장을 한 번에 할 수 있습니다."
          : "카드를 체크하면 한 장의 이미지로 저장할 수 있습니다.");
      shell.bulkActions.setAttribute("aria-hidden", open ? "false" : "true");
      // 휴대폰 아래 막대: 고르면 보이고(접힌 한 줄), 결과 한 줄이 있으면 선택이 0개여도 잠시 남는다. 펼침은 단추로.
      var expanded = open && state.bulkExpanded === true;
      shell.bulkDock.classList.toggle("is-shown", open || bulkNoteFloating());
      shell.bulkDock.classList.toggle("is-expanded", expanded);
      setText(shell.bulkSheetToggle, expanded ? "접기 ▾" : "정리 열기 ▴");
      shell.bulkSheetToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      shell.bulkSheetToggle.hidden = !open;
      Array.prototype.forEach.call(shell.bulk.querySelectorAll("[data-coupang-rank-write]"), function (node) {
        // 정리용 화면에서는 일시중지·삭제만 보인다.
        var action = String(node.getAttribute("data-coupang-rank-action") || "").replace(/^bulk-/, "");
        node.hidden = !writable || (cleanup && !cleanupAllows(action));
        node.disabled = state.busy || count === 0;
      });
      shell.bulkGroupInput.hidden = !writable || cleanup;
      // 입력·버튼을 다 숨기면 빈 칸만 남으므로 묶음째 숨긴다.
      shell.bulkGroupWrap.hidden = !writable || cleanup;
      Array.prototype.forEach.call(shell.bulk.querySelectorAll('[data-coupang-rank-action="clear-selection"], [data-coupang-rank-action="bulk-export"]'), function (node) {
        node.disabled = state.busy || count === 0;
      });
      Array.prototype.forEach.call(shell.bulk.querySelectorAll(".mi-coupang-rank-bulk-set"), function (set) {
        set.hidden = Array.prototype.every.call(set.children, function (child) { return child.hidden; });
      });
      shell.bulkSelectVisible.disabled = state.busy;
      renderBulkNote();
      syncDockSpace();
    }

    function renderListNote() {
      if (!shell) return;
      var note = state.listNote;
      var text = note.text;
      if (!text && state.loading) text = state.payload ? "새 목록을 받는 중입니다…" : "";
      // aria-live 줄이라 같은 글이면 다시 쓰지 않는다(다시 쓰면 화면 읽기 프로그램이 같은 말을 또 읽는다 — 전체 확인이 끝나는 순간처럼
      // 목록을 받는 중에 다시 그리면 두 번 읽었다).
      setText(shell.listNote, text);
      shell.listNote.hidden = !text;
      shell.listNote.className = "mi-coupang-rank-list-note" + (note.tone ? " " + note.tone : "");
      if (note.text && note.detail) shell.listNote.setAttribute("title", note.detail);
      else shell.listNote.removeAttribute("title");
    }

    // ── 5. 그룹 구역 + 카드 ──

    function stateBox(text) {
      return el("div", { className: "mi-rank-state", text: text });
    }

    // 카드마다 같은 값을 다시 계산하지 않게 renderList 한 번에 한 번 센다(지금 확인 상태·같은 키워드 수·오늘·자동 수집).
    var cardContext = null;

    function keywordKeyOf(tracker) {
      return manualKeywordKey(tracker);
    }

    function makeCardContext() {
      var counts = {};
      trackers().forEach(function (tracker) {
        if (tracker.status !== "active") return;
        var key = keywordKeyOf(tracker);
        if (key) counts[key] = (counts[key] || 0) + 1;
      });
      var showManual = manualVisible();
      // 진행 중에 '지금 확인'을 껐으면 버튼은 모두 숨기되, 재고 있는 카드만 끝날 때까지 '확인 중…'을 남긴다(2026-10-23 재검사).
      var runOnly = !showManual && manualRunWhileOff() ? state.manual.run.trackerId : "";
      return {
        manual: showManual,
        runOnly: runOnly,
        view: showManual || runOnly ? currentManualView() : null,
        keywordCounts: counts,
        todayKst: todayKstValue(),
        auto: autoActive() || readonlyView(),
        // 전체 확인 중이면 키워드 → 차례(0 = 확인 중, n = 대기 n번째). 카드마다 다시 세지 않게 한 번만 센다.
        allPositions: allQueuePositions()
      };
    }

    // 목록은 다시 그릴 때 통째로 새로 만든다. 그리기 전에 키보드 포커스 자리를 기억해 같은 버튼(없거나 꺼졌으면 그 카드)으로 되돌린다.
    // 꺼진 버튼 대신 카드에 맡겨 둔 자리(pendingFocus)는 버튼이 다시 켜져 그려질 때 원래 버튼으로 돌아간다.
    // 날짜 줄을 옆으로 민 자리(카드 id → scrollLeft)도 다시 그리기 전에 기억해 되돌린다(새 줄은 0 에서 시작해 되돌린 포커스 칸이 가려졌다,
    // 2026-10-23 재검사). 되돌린 포커스 칸은 revealInRow 가 줄 안(오른쪽 흐림 밖)에 보이게 한 번 더 맞춘다.
    function renderList() {
      var focus = captureListFocus();
      var rows = captureRowScroll();
      drawList();
      restoreRowScroll(rows);
      restoreListFocus(focus);
      syncDayFades();
    }

    function rowCardId(grid) {
      var card = grid && grid.closest ? grid.closest("[data-coupang-rank-card]") : null;
      return card ? String(card.getAttribute("data-coupang-rank-id") || "") : "";
    }

    function captureRowScroll() {
      var saved = {};
      if (!shell) return saved;
      Array.prototype.forEach.call(shell.list.querySelectorAll(".mi-rank-day-grid"), function (grid) {
        var id = rowCardId(grid);
        var left = Number(grid.scrollLeft) || 0;
        if (id && left > 0) saved[id] = left;
      });
      return saved;
    }

    function restoreRowScroll(saved) {
      if (!shell || !saved) return;
      Array.prototype.forEach.call(shell.list.querySelectorAll(".mi-rank-day-grid"), function (grid) {
        var id = rowCardId(grid);
        if (id && saved[id]) grid.scrollLeft = saved[id];
      });
    }

    // 옆으로 미는 줄(날짜 줄 · 휴대폰 필터 줄) 안의 칸이 줄 보이는 폭 안에 다 들어오게 그 줄만 옆으로 민다(화면은 위아래로 움직이지 않는다).
    // 날짜 줄은 칸(버튼의 부모)을 기준으로, 오른쪽 끝 흐림 폭(DAY_FADE_PX)만큼 비워 둔다. 끝까지 밀면 흐림이 사라지므로 끝 칸은 끝까지.
    function revealInRow(node) {
      if (!node || !node.closest) return;
      var row = node.closest(".mi-rank-day-grid, .mi-coupang-rank-filter-actions");
      if (!row || typeof row.getBoundingClientRect !== "function" || !shell || !host.contains(row)) return;
      var client = Number(row.clientWidth) || 0;
      var width = Number(row.scrollWidth) || 0;
      if (client <= 0 || width - client < 1) return;
      var isDays = row.classList.contains("mi-rank-day-grid");
      var item = isDays && node.parentNode && node.parentNode !== row ? node.parentNode : node;
      if (typeof item.getBoundingClientRect !== "function") return;
      var box = row.getBoundingClientRect();
      var rect = item.getBoundingClientRect();
      if (!box || !rect || !isNum(box.left) || !isNum(rect.left) || !isNum(rect.right)) return;
      var left = Number(row.scrollLeft) || 0;
      var max = width - client;
      var viewLeft = box.left + (Number(row.clientLeft) || 0);
      var endPad = isDays ? DAY_FADE_PX : 0;
      var next = left;
      if (rect.left < viewLeft) next = left - (viewLeft - rect.left);
      else if (rect.right > viewLeft + client - endPad) next = left + (rect.right - (viewLeft + client - endPad));
      next = Math.max(0, Math.min(max, Math.round(next)));
      if (Math.abs(next - left) >= 1) row.scrollLeft = next;
    }

    // 키보드로 들어온 포커스(Tab·되돌린 포커스)가 옆으로 미는 줄 안에서 일부만 보이면 그 줄을 민다. 마우스로 누를 때(:focus-visible 아님)는
    // 누르는 사이 칸이 움직여 다른 칸에 손이 떨어지지 않게 그대로 둔다.
    function onFocusIn(event) {
      var target = event && event.target;
      if (!target || !target.closest || !host.contains(target)) return;
      var keyboard = true;
      try { keyboard = typeof target.matches !== "function" || target.matches(":focus-visible"); } catch (error) { keyboard = true; }
      if (keyboard) revealInRow(target);
    }

    var FOCUS_ALIAS = { pause: "resume", resume: "pause", "group-save": "group-edit", "group-cancel": "group-edit" };

    function findByAttr(root, attr, value, test) {
      var nodes = root.querySelectorAll("[" + attr + "]");
      for (var index = 0; index < nodes.length; index += 1) {
        if (value !== null && nodes[index].getAttribute(attr) !== value) continue;
        if (test && !test(nodes[index])) continue;
        return nodes[index];
      }
      return null;
    }

    function cardNode(id) {
      if (!shell || !id) return null;
      return findByAttr(shell.list, "data-coupang-rank-card", null, function (node) { return node.getAttribute("data-coupang-rank-id") === id; });
    }

    function focusKey(node) {
      var card = node.closest ? node.closest("[data-coupang-rank-card]") : null;
      var cardId = card ? String(card.getAttribute("data-coupang-rank-id") || "") : "";
      if (node === card) return { kind: "card", id: cardId };
      if (node.hasAttribute("data-coupang-rank-select")) return { kind: "select", value: node.getAttribute("data-coupang-rank-select") };
      if (node.hasAttribute("data-coupang-rank-group-select")) return { kind: "group-select", value: node.getAttribute("data-coupang-rank-group-select") };
      var action = node.getAttribute("data-coupang-rank-action");
      if (action) {
        return { kind: "action", action: action, id: String(node.getAttribute("data-coupang-rank-id") || cardId), day: String(node.getAttribute("data-coupang-rank-day") || ""),
          group: node.getAttribute("data-coupang-rank-group-name") };
      }
      if (node.classList && node.classList.contains("mi-rank-keyword-name")) return { kind: "link", cls: "mi-rank-keyword-name", id: cardId };
      if (node.classList && node.classList.contains("mi-rank-product-title")) return { kind: "link", cls: "mi-rank-product-title", id: cardId };
      return cardId ? { kind: "card", id: cardId } : null;
    }

    function captureListFocus() {
      var active = typeof document !== "undefined" && document ? document.activeElement : null;
      if (!shell || !active || active === shell.list || typeof active.getAttribute !== "function" || !shell.list.contains(active)) return null;
      var key = focusKey(active);
      if (key && key.kind === "card" && state.pendingFocus && state.pendingFocus.id === key.id) return state.pendingFocus;
      return key;
    }

    function findFocusTarget(key) {
      if (key.kind === "select") return findByAttr(shell.list, "data-coupang-rank-select", key.value);
      if (key.kind === "group-select") return findByAttr(shell.list, "data-coupang-rank-group-select", key.value);
      var card = cardNode(key.id);
      if (key.kind === "card") return card;
      if (key.kind === "link") return card ? card.querySelector("." + key.cls) || card : null;
      if (key.kind !== "action") return null;
      var root = card || shell.list;
      var match = function (action) {
        return findByAttr(root, "data-coupang-rank-action", action, function (node) {
          var id = node.getAttribute("data-coupang-rank-id");
          if (key.id && id !== null && id !== key.id) return false;
          if (key.group !== null && key.group !== undefined && node.getAttribute("data-coupang-rank-group-name") !== key.group) return false;
          if (key.day && node.getAttribute("data-coupang-rank-day") !== key.day) return false;
          return true;
        });
      };
      var found = match(key.action) || (FOCUS_ALIAS[key.action] ? match(FOCUS_ALIAS[key.action]) : null);
      // 그 날짜 칸이 없어졌으면 그 줄의 탭 정지 칸으로
      if (!found && key.action === "day-detail" && card) found = findByAttr(card, "data-coupang-rank-day", null, function (node) { return node.getAttribute("tabindex") === "0"; });
      return found || card;
    }

    function focusNode(node) {
      if (!node || typeof node.focus !== "function") return;
      try {
        node.focus({ preventScroll: true });
      } catch (error) {
        try { node.focus(); } catch (ignored) {}
      }
    }

    // 누른 버튼이 잠시 꺼지면(확인 중·처리 중) 포커스를 그 카드에 맡긴다(몸통으로 사라지지 않게).
    function parkFocusOnCard(card, key) {
      if (!card) return;
      card.setAttribute("tabindex", "-1");
      state.pendingFocus = key || null;
      focusNode(card);
    }

    function restoreListFocus(key) {
      if (!key || !shell) return;
      var target = findFocusTarget(key);
      if (!target) {
        state.pendingFocus = null;
        return;
      }
      var card = target.closest ? target.closest("[data-coupang-rank-card]") : null;
      if (target.disabled === true || (target === card && key.kind !== "card")) {
        parkFocusOnCard(card, key);
        return;
      }
      if (target === card) card.setAttribute("tabindex", "-1");
      state.pendingFocus = null;
      focusNode(target);
      // 포커스는 화면을 움직이지 않게(preventScroll) 돌리므로, 옆으로 미는 줄 안에서 가려졌으면 그 줄만 민다.
      revealInRow(target);
    }

    // 날짜 줄 오른쪽 끝 흐림은 옆으로 더 있을 때만(넘침이 있고 끝까지 밀지 않았을 때). 읽기를 먼저 모두 하고 쓴다.
    // 가려진 몫이 DAY_FADE_SLACK_PX 이하(칸 오른쪽 여백·테두리뿐 — 칸 글자는 왼쪽 9px 부터 시작)면 흐리지 않는다:
    // 1440~1920px 의 12칸 카드는 4px 만 넘치는데 40px 흐림이 마지막 칸 글자를 덮었다(2026-10-23 재검사). 문턱 16px: 실측(헤드리스)
    // 마지막 칸 '10-12(월)' 글자가 처음 잘리는 넘침은 20px 이라 글꼴 폭 차이를 남겨 둔다(17~19px 넘침은 흐림이 남는다).
    function dayFadeWanted(wrap) {
      var grid = wrap.querySelector(".mi-rank-day-grid");
      if (!grid) return false;
      var width = Number(grid.scrollWidth) || 0;
      var client = Number(grid.clientWidth) || 0;
      var left = Math.abs(Number(grid.scrollLeft) || 0);
      return client > 0 && width - (left + client) > DAY_FADE_SLACK_PX;
    }

    function syncDayFades() {
      if (!shell) return;
      var wraps = shell.list.querySelectorAll(".mi-coupang-rank-days-scroll");
      var wanted = Array.prototype.map.call(wraps, dayFadeWanted);
      Array.prototype.forEach.call(wraps, function (wrap, index) { wrap.classList.toggle("has-more", wanted[index]); });
    }

    function drawList() {
      shell.list.replaceChildren();
      var scope = currentScope();
      if (!scope) {
        shell.list.appendChild(stateBox("대상 광고주를 먼저 고르세요"));
        return;
      }
      if (state.setupRequired) {
        shell.list.appendChild(stateBox("대표 SQL 실행 전입니다(설정 필요). 총관리자가 SQL을 실행하면 이 화면이 '수집기 연결 안 됨'으로 바뀌고 등록할 수 있습니다."));
        return;
      }
      if (!state.payload) {
        shell.list.appendChild(stateBox(state.loading ? "목록을 불러오는 중입니다…" : "목록을 아직 받지 못했습니다."));
        return;
      }
      var all = trackers();
      if (!all.length) {
        shell.list.appendChild(stateBox(canWrite()
          ? "아직 등록한 상품이 없습니다. 위에 키워드와 쿠팡 상품 주소를 넣고 '순위 추적'을 누르세요."
          : "추적 등록 후 상품별 일별 순위판이 생성됩니다."));
        return;
      }
      var visible = visibleTrackers();
      if (!visible.length) {
        shell.list.appendChild(stateBox("조건에 맞는 순위 추적 항목이 없습니다. 검색어 또는 상태 필터를 조정해주세요."));
        return;
      }
      var groups = [];
      var byName = {};
      visible.forEach(function (tracker) {
        var name = String(tracker.groupName || DEFAULT_GROUP);
        if (!byName[name]) {
          byName[name] = [];
          groups.push(name);
        }
        byName[name].push(tracker);
      });
      cardContext = makeCardContext();
      var groupList = el("div", { className: "mi-rank-group-list" });
      try {
        groups.forEach(function (name) {
          groupList.appendChild(renderGroup(name, byName[name]));
        });
      } finally {
        cardContext = null;
      }
      shell.list.appendChild(groupList);
    }

    function groupSelectText(items) {
      var picked = items.filter(function (tracker) { return state.selected.has(tracker.id); }).length;
      return picked && picked < items.length ? "전체 선택 (" + picked + "/" + items.length + ")" : "전체 선택";
    }

    // 그룹 머리: N30 renderRankHistory 와 같은 틀('전체 선택 (n/m)' · '미분류' · 'N개 추적 · 지금 최고 N위').
    // 서버 값과 data 속성은 '기본 그룹' 그대로 두고 보이는 이름만 '미분류'로 쓴다.
    function renderGroup(name, items) {
      var collapsed = state.collapsed.has(name);
      var allSelected = items.every(function (tracker) { return state.selected.has(tracker.id); });
      var someSelected = items.some(function (tracker) { return state.selected.has(tracker.id); });
      var shown = groupDisplayName(name);
      var groupCheck = el("input", { type: "checkbox", "data-coupang-rank-group-select": name, "aria-label": shown + " 그룹 전체 선택" });
      groupCheck.checked = allSelected;
      groupCheck.indeterminate = !allSelected && someSelected;
      var best = 0;
      items.forEach(function (tracker) {
        var current = tracker.current;
        if (current && current.result === "found" && isNum(current.rank) && (!best || current.rank < best)) best = current.rank;
      });
      var section = el("section", { className: "mi-rank-group-section mi-coupang-rank-group" + (collapsed ? " is-collapsed" : ""), "data-coupang-rank-group": name });
      var head = el("div", { className: "mi-rank-group-head-row" }, [
        el("label", { className: "mi-rank-group-select", title: "이 그룹의 추적 항목을 한 번에 선택하거나 해제합니다" }, [
          groupCheck,
          el("span", { "data-coupang-rank-group-select-text": true, text: groupSelectText(items) })
        ]),
        el("button", { className: "mi-rank-group-head", type: "button", "data-coupang-rank-action": "group-toggle", "data-coupang-rank-group-name": name, "aria-expanded": collapsed ? "false" : "true" }, [
          el("span", {}, [
            el("span", { className: "mi-rank-group-title" }, [
              shown,
              el("span", { className: "mi-rank-group-meta", text: items.length + "개 추적" + (best ? " · 지금 최고 " + best + "위" : "") })
            ])
          ]),
          el("span", { className: "mi-rank-group-toggle", text: collapsed ? "펼치기" : "접기" })
        ])
      ]);
      var body = el("div", { className: "mi-rank-group-items mi-rank-daily-list" });
      if (!collapsed) items.forEach(function (tracker) { body.appendChild(renderCard(tracker)); });
      section.appendChild(head);
      section.appendChild(body);
      return section;
    }

    function pill(text, className, extra) {
      return el("span", Object.assign({ className: className || null, text: text }, extra || {}));
    }

    // 상품명 자리. 상품명은 첫 성공 측정에서 상품이 1쪽에 있을 때만 채워진다(migration: coalesce).
    // 아직 없으면 같은 글(상품번호·키워드)을 두 번 쓰지 않고 '상품 페이지 열기'를 둔다.
    function productTitleNode(tracker) {
      var title = String(tracker.productTitle || "").trim();
      var url = String(tracker.productUrl || "").trim();
      if (!/^https:\/\//i.test(url)) url = "";
      if (!url) return el("span", { className: "mi-rank-product-title", title: title || TITLE_PENDING_HINT, text: title || "상품명 확인 전" });
      return el("a", {
        className: "mi-rank-product-title",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        title: title || TITLE_PENDING_HINT,
        text: title || "상품 페이지 열기"
      });
    }

    // 키워드는 쿠팡 검색으로 열리는 링크다(링크임이 보이게 '↗'를 붙인다).
    function keywordNode(tracker) {
      var label = String(tracker.keyword || "").trim() || "-";
      var url = keywordSearchUrl(tracker.keyword);
      if (!url) return el("strong", { className: "mi-rank-keyword-name", title: label, text: label });
      return el("a", {
        className: "mi-rank-keyword-name",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        title: label + " 쿠팡 검색으로 열기(로그인 상태면 순서가 다를 수 있음)"
      }, [label, el("span", { className: "mi-coupang-rank-ext-mark", "aria-hidden": "true", text: "↗" })]);
    }

    // 카드: N30 renderRankTrackerCard 와 같은 3행 뼈대·클래스(admin.html 인라인 CSS 가 그대로 적용된다). C30 만 다른 점(대표 결정 2026-10-23):
    // 1행 [선택(체크칸)][키워드↗][상품번호 …][상품명] | [현재][30일 최고][지금 확인(주 버튼)] · [일시중지/다시 시작][삭제]
    // 2행 운영줄: (방금 결과) · (일시중지 · MM-DD부터) · 판정 · (다른 옵션) · 전회 대비(이탈 판정이 있으면 생략) · 7일 평균 · (광고 N번째) ·
    //     오늘 표시 · (자동 수집이 돌 때만 '다음') · [그룹 변경][측정 기록]
    // 3행 날짜 줄(칸을 누르면 그날 기록 한 줄). 늘 같은 '상태 운영중'·'그룹 X'·'광고 -'는 두지 않는다(그룹은 그룹 머리에 있다).
    function renderCard(tracker) {
      var context = cardContext || makeCardContext();
      var summary = tracker.summary || {};
      var current = tracker.current || null;
      var paused = tracker.status === "paused";
      var writable = canWrite();
      var cleanup = cleanupMode();
      var collectorState = collectorStateName();
      var check = el("input", { type: "checkbox", "data-coupang-rank-select": tracker.id, "aria-label": String(tracker.keyword || "") + " 선택" });
      check.checked = state.selected.has(tracker.id);

      var actions = [
        el("span", { className: "mi-rank-pill mi-coupang-rank-current" + (outOfTop(tracker) ? " is-out" : "") }, ["현재 ", el("b", { text: currentText(tracker) })]),
        el("span", { className: "mi-rank-pill mi-coupang-rank-best", title: "최근 30일 하루 칸 가운데 가장 높은 순위" }, ["30일 최고 ", el("b", { text: isNum(summary.best30) ? summary.best30 + "위" : "-" })])
      ];
      if (writable) {
        var tools = [];
        // 정리용 화면에서는 다시 시작을 그리지 않는다(일시중지·삭제만).
        if (paused) {
          if (!cleanup) tools.push(button("다시 시작", "resume", { "data-coupang-rank-id": tracker.id, disabled: state.busy }));
        } else {
          // ① 지금 확인: 총관리자·지금 확인 켜짐·활성 추적·정리용 아님일 때만. 같은 키워드 카드는 한 번에 함께 기록된다.
          if (!cleanup && context.manual) {
            actions.push(manualCardButton(tracker, context.view, context.todayKst, context.allPositions));
            var same = context.keywordCounts[keywordKeyOf(tracker)] || 0;
            if (same > 1) actions.push(el("small", { className: "mi-coupang-rank-same-kw", title: "같은 키워드 카드는 한 번 누르면 모두 기록됩니다(하루 횟수도 1번만 씁니다)", text: "같은 키워드 " + same + "개 함께 기록" }));
          } else if (!cleanup && context.runOnly && context.runOnly === tracker.id) {
            actions.push(manualCardButton(tracker, context.view, context.todayKst, context.allPositions));
          }
          tools.push(button("일시중지", "pause", { "data-coupang-rank-id": tracker.id, disabled: state.busy }));
        }
        tools.push(button("삭제", "delete", { className: "mi-link-button is-danger", "data-coupang-rank-id": tracker.id, disabled: state.busy }));
        actions.push(el("div", { className: "mi-coupang-rank-card-tools" }, tools));
      }

      var head = el("div", { className: "mi-rank-track-row-head" }, [
        el("div", { className: "mi-rank-track-main" }, [
          el("div", { className: "mi-rank-track-primary" }, [
            el("div", { className: "mi-rank-track-controls" }, [
              // 글자는 시각적으로만 숨기고 label 은 그대로 둔다(누르는 자리를 줄이지 않는다).
              el("label", { className: "mi-rank-select" }, [check, el("span", { className: "mi-coupang-rank-sr", text: "선택" })])
            ]),
            keywordNode(tracker),
            el("span", { className: "mi-rank-product-info", title: "상품번호 " + (tracker.productId || "-"), text: "상품번호 " + (tracker.productId || "-") }),
            productTitleNode(tracker)
          ])
        ]),
        el("div", { className: "mi-rank-row-actions" }, actions)
      ]);

      var days30 = state.payload && state.payload.days30;
      var ops = [];
      var note = state.cardNote && state.cardNote.trackerId === tracker.id ? state.cardNote : null;
      if (note) ops.push(pill(note.text, "mi-coupang-rank-card-note" + (note.tone ? " " + note.tone : ""), { "data-coupang-rank-card-note": true }));
      if (paused) ops.push(pill("일시중지" + (tracker.pausedDay ? " · " + String(tracker.pausedDay).slice(5) + "부터" : ""), "mi-coupang-rank-paused-pill", { "data-coupang-rank-state-pill": true }));
      verdictPills(tracker, days30).forEach(function (verdict) {
        ops.push(pill(verdict.text, "mi-rank-insight-pill " + verdict.tone));
      });
      if (current && current.sameOption === false) ops.push(pill("다른 옵션으로 노출", "mi-rank-insight-pill is-warn", { title: "같은 상품의 다른 옵션이 검색 결과에 나왔습니다(순위는 인정)" }));
      // 이탈은 한 번만: 판정 알약이 이미 '50위 밖으로 이탈'이면 같은 뜻의 '전회 대비 50위 밖 이탈'은 두지 않는다.
      var reasons = Array.isArray(summary.attentionReasons) ? summary.attentionReasons : [];
      if (!(summary.trend === "exit" && reasons.indexOf("exit") >= 0)) ops.push(pill(changeText(summary), null, { title: "같은 시간대 회차끼리 비교" }));
      ops.push(pill(avg7Text(summary), null, { title: "최근 7일 가운데 50위 안에 든 날만 평균" }));
      if (current && isNum(current.adOrder)) ops.push(pill("광고 " + current.adOrder + "번째", null, { title: "광고 순번은 참고용입니다(순위는 광고를 뺀 일반 상품 순서)" }));
      var today = todayPill(tracker, context.todayKst);
      if (today) ops.push(pill(today.text, "mi-coupang-rank-today" + (today.tone ? " " + today.tone : ""), { "data-coupang-rank-today": true }));
      else ops.push(pill("최근 " + (current && current.checkedAt ? shortAt(current.checkedAt) : "-")));
      // '다음'은 자동 수집이 돌 때만(읽기 전용은 예전처럼 늘). 지금 확인만 쓸 때는 늘 '정지'라 소음이다.
      if (context.auto) {
        var nextText = nextCheckText(tracker, collectorState, Date.now(), readonlyView() ? "readonly" : "admin");
        ops.push(pill("다음 " + nextText, nextText === "대기" ? "is-wait" : null, { "data-coupang-rank-next": true }));
      }
      var runs = state.runs[tracker.id];
      var opsButtons = [];
      if (writable && !cleanup) opsButtons.push(button("그룹 변경", "group-edit", { className: "mi-rank-group-edit", "data-coupang-rank-id": tracker.id, disabled: state.busy }));
      opsButtons.push(button(runs && runs.open ? "측정 기록 닫기" : "측정 기록", "runs", { className: "mi-rank-group-edit", "data-coupang-rank-id": tracker.id, "aria-expanded": runs && runs.open ? "true" : "false" }));
      ops.push(el("div", { className: "mi-coupang-rank-ops-buttons" }, opsButtons));

      var card = el("section", { className: "mi-rank-tracker-card mi-coupang-rank-card" + (paused ? " is-paused" : ""), "data-coupang-rank-card": true, "data-coupang-rank-id": tracker.id });
      card.appendChild(head);
      card.appendChild(el("div", { className: "mi-rank-ops-row" }, ops));
      card.appendChild(renderDays(tracker, days30, context.todayKst));
      if (state.editingGroupId === tracker.id) card.appendChild(renderGroupEditor(tracker));
      if (runs && runs.open) card.appendChild(renderRuns(tracker));
      return card;
    }

    // 첫 기록 전 안내(화면 카드). 무엇을 누르면 기록되는지 지금 방식대로 쓴다. 공유 이미지·읽기 전용은 FIRST_BOARD_TEXT 그대로.
    function firstBoardHint() {
      if (readonlyView()) return FIRST_BOARD_TEXT;
      if (manualVisible()) return "아직 순위 기록이 없습니다. 이 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다(검색 1번).";
      var mode = autoMode();
      if (mode === "recording") return "아직 순위 기록이 없습니다. 다음 자동 수집 때 첫 순위가 기록됩니다.";
      if (mode) return "아직 순위 기록이 없습니다. 자동 수집이 멈췄거나 확인이 필요한 상태라 언제 기록될지 알 수 없습니다(위 자동추적 칸 참고).";
      if (manualBoardVisible()) return "아직 순위 기록이 없습니다. 위 상태판에서 '지금 확인'을 켜면 이 카드에서 첫 순위를 기록할 수 있습니다.";
      return FIRST_BOARD_TEXT;
    }

    // 날짜 줄: 오늘부터 왼쪽, 등록한 날까지. 칸마다 날짜와 값만(작은 글 없음). 안 잰 날은 회색 칸 '-', 잰 결과(50위 밖·없음·결과 없음)는
    // 흰 칸 진한 글, 실패·이동은 주황, 오늘 칸은 위쪽 남색 줄. 칸은 버튼이고 누르면(마우스·터치·Enter) 카드 아래 한 줄에 그날 기록이 나온다.
    // 키보드는 줄마다 탭 정지 하나(roving tabindex) + 화살표·Home·End 로 옮긴다. 펼친 날은 state.dayDetails 에 남아 다시 그려도 유지된다.
    function renderDays(tracker, days30, todayKst) {
      var empty = emptyBoardText(tracker, days30);
      if (empty) return el("div", { className: "mi-rank-state mi-coupang-rank-board-empty", text: empty === FIRST_BOARD_TEXT ? firstBoardHint() : empty });
      var range = boardDays(tracker, days30);
      var selected = String(state.dayDetails[tracker.id] || "");
      if (selected && range.dates.indexOf(selected) < 0) selected = "";
      // 탭 정지: 화살표로 옮겨 둔 칸 → 펼친 날 → 오늘(맨 왼쪽) 순서(다시 그려도 키보드 위치를 잃지 않는다).
      var remembered = String(state.dayFocus[tracker.id] || "");
      if (remembered && range.dates.indexOf(remembered) < 0) remembered = "";
      var focusDay = remembered || selected || range.dates[0] || "";
      var grid = el("div", { className: "mi-rank-day-grid", role: "list", "aria-label": "일별 순위(칸을 누르면 그날 기록, 화살표로 옮김)" });
      range.dates.forEach(function (d) {
        var cell = range.byDay[d] || null;
        var weekend = dayClass(d);
        var isToday = Boolean(todayKst) && d === todayKst;
        var classes = ["mi-rank-day-card", "mi-coupang-rank-day", dayKind(cell)];
        if (weekend) classes.push(weekend);
        if (isToday) classes.push("is-today");
        if (d === selected) classes.push("is-selected");
        var value = cellText(cell, d, tracker.createdDay) || "-";
        grid.appendChild(el("div", { className: classes.join(" "), role: "listitem", title: cellTooltip(cell, d, tracker.createdDay) || null }, [
          el("button", {
            type: "button",
            className: "mi-coupang-rank-day-button",
            "data-coupang-rank-action": "day-detail",
            "data-coupang-rank-id": tracker.id,
            "data-coupang-rank-day": d,
            tabindex: d === focusDay ? "0" : "-1",
            "aria-pressed": d === selected ? "true" : "false",
            "aria-label": dayLabel(d) + (isToday ? "(오늘)" : "") + " " + value
          }, [
            el("strong", { text: isToday ? "오늘 " + String(d).slice(5) : dayLabel(d) }),
            el("b", { text: value })
          ])
        ]));
      });
      var detail = el("p", {
        className: "mi-coupang-rank-day-detail",
        "data-coupang-rank-day-detail": tracker.id,
        "aria-live": "polite",
        hidden: !selected,
        text: selected ? dayDetailText(range.byDay[selected] || null, selected, tracker) : ""
      });
      return el("div", { className: "mi-coupang-rank-days" }, [el("div", { className: "mi-coupang-rank-days-scroll" }, [grid]), detail]);
    }

    // 날짜 칸 누름: 목록을 다시 그리지 않고 그 카드만 바꾼다(키보드 위치를 잃지 않게).
    function toggleDayDetail(node) {
      var id = node.getAttribute("data-coupang-rank-id") || "";
      var d = node.getAttribute("data-coupang-rank-day") || "";
      var tracker = findTracker(id);
      if (!tracker || !d) return;
      var closing = state.dayDetails[id] === d;
      if (closing) delete state.dayDetails[id];
      else state.dayDetails[id] = d;
      state.dayFocus[id] = d;
      var card = node.closest ? node.closest("[data-coupang-rank-card]") : null;
      if (!card) return;
      Array.prototype.forEach.call(card.querySelectorAll("[data-coupang-rank-day]"), function (dayButton) {
        var on = !closing && dayButton.getAttribute("data-coupang-rank-day") === d;
        dayButton.setAttribute("aria-pressed", on ? "true" : "false");
        dayButton.setAttribute("tabindex", dayButton === node ? "0" : "-1");
        if (dayButton.parentNode && dayButton.parentNode.classList) dayButton.parentNode.classList.toggle("is-selected", on);
      });
      var detail = card.querySelector("[data-coupang-rank-day-detail]");
      if (!detail) return;
      var range = boardDays(tracker, state.payload && state.payload.days30);
      detail.textContent = closing ? "" : dayDetailText(range.byDay[d] || null, d, tracker);
      detail.hidden = closing;
    }

    function moveDayFocus(target, key) {
      var grid = target.closest ? target.closest(".mi-rank-day-grid") : null;
      if (!grid) return false;
      var buttons = grid.querySelectorAll("[data-coupang-rank-day]");
      var index = Array.prototype.indexOf.call(buttons, target);
      if (index < 0) return false;
      var next = key === "Home" ? 0 : (key === "End" ? buttons.length - 1 : index + (key === "ArrowRight" ? 1 : -1));
      if (next < 0 || next >= buttons.length || next === index) return false;
      Array.prototype.forEach.call(buttons, function (dayButton, position) { dayButton.setAttribute("tabindex", position === next ? "0" : "-1"); });
      var nextButton = buttons[next];
      var trackerId = nextButton.getAttribute("data-coupang-rank-id") || "";
      if (trackerId) state.dayFocus[trackerId] = nextButton.getAttribute("data-coupang-rank-day") || "";
      if (typeof nextButton.focus === "function") nextButton.focus();
      // 칸 전체가 줄 안(오른쪽 흐림 밖)에 오게 옮긴다(CSS scroll-padding 이 흐림 폭만큼 비워 둔다).
      var cell = nextButton.parentNode;
      if (cell && typeof cell.scrollIntoView === "function") {
        try { cell.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (error) {}
      }
      return true;
    }

    function renderGroupEditor(tracker) {
      var current = isDefaultGroup(tracker.groupName) ? "" : String(tracker.groupName);
      var input = el("input", { className: "mi-input", type: "text", maxlength: String(GROUP_MAX), autocomplete: "off", list: shell.groupListId, value: current, placeholder: "비우면 " + UNGROUPED_LABEL, "aria-label": "새 그룹 이름", "data-coupang-rank-group-edit-input": tracker.id });
      return el("div", { className: "mi-coupang-rank-group-editor" }, [
        el("span", { text: "그룹 변경" }),
        input,
        button("저장", "group-save", { className: "mi-button", "data-coupang-rank-id": tracker.id, disabled: state.busy }),
        button("취소", "group-cancel", { "data-coupang-rank-id": tracker.id })
      ]);
    }

    // 측정 기록의 실패 사유: 아는 코드는 쉬운 말로, 원래 코드는 뒤에 작게(문의할 때 필요). 모르는 코드는 '기타 오류(코드 …)'.
    function failureReasonText(code) {
      var raw = String(code == null ? "" : code).slice(0, 60);
      if (!raw) return "";
      var safe = manualSafeCode(raw);
      if (safe && MANUAL_CODE_TEXT[safe]) return MANUAL_CODE_TEXT[safe] + " (코드 " + safe + ")";
      return "기타 오류(코드 " + raw + ")";
    }

    function renderRuns(tracker) {
      var entry = state.runs[tracker.id] || {};
      var todayKst = state.payload && state.payload.todayKst || "";
      var box = el("div", { className: "mi-coupang-rank-runs", "data-coupang-rank-runs": tracker.id });
      if (entry.loading) {
        box.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "측정 기록을 불러오는 중입니다…" }));
        return box;
      }
      if (entry.error) {
        box.appendChild(el("p", { className: "mi-coupang-rank-muted is-warn", text: entry.error }));
        return box;
      }
      var data = entry.data || {};
      var snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
      var failures = Array.isArray(data.failures) ? data.failures : [];
      box.appendChild(el("h4", { text: "최근 30일 기록 " + snapshots.length + "건" }));
      if (!snapshots.length) box.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "아직 기록이 없습니다." }));
      else {
        var list = el("ul", { className: "mi-coupang-rank-run-list" });
        snapshots.forEach(function (snapshot) {
          var parts = [kstStamp(snapshot.checkedAt, todayKst) || String(snapshot.day || ""), "칸 " + (isNum(snapshot.slot) ? snapshot.slot + 1 : "-"), snapshotResultText(snapshot)];
          if (isNum(snapshot.organicCount)) parts.push("일반 " + snapshot.organicCount + "개");
          if (isNum(snapshot.organicSlot)) parts.push("쪽 위치 " + snapshot.organicSlot + "번째");
          if (isNum(snapshot.adOrder)) parts.push("광고 " + snapshot.adOrder + "번째");
          if (snapshot.sameOption === false) parts.push("다른 옵션");
          list.appendChild(el("li", { text: parts.join(" · ") }));
        });
        box.appendChild(list);
      }
      box.appendChild(el("h4", { text: "같은 키워드 최근 14일 실패 " + failures.length + "건" }));
      if (!failures.length) box.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "실패 기록이 없습니다." }));
      else {
        var failList = el("ul", { className: "mi-coupang-rank-run-list" });
        failures.forEach(function (failure) {
          var parts = [kstStamp(failure.claimedAt, todayKst), RUN_STATUS_TEXT[failure.status] || String(failure.status || "")];
          if (failure.errorCode) parts.push(failureReasonText(failure.errorCode));
          if (isNum(failure.slot)) parts.push("칸 " + (failure.slot + 1));
          failList.appendChild(el("li", { text: parts.join(" · ") }));
        });
        box.appendChild(failList);
      }
      return box;
    }

    async function toggleRuns(id) {
      var entry = state.runs[id] || { open: false };
      entry.open = !entry.open;
      state.runs[id] = entry;
      if (entry.open && !entry.data && !entry.loading) {
        entry.loading = true;
        entry.error = "";
        renderList();
        var scope = currentScope();
        var payload;
        try {
          payload = await getView("view=runs&trackerId=" + encodeURIComponent(id), scope);
        } catch (error) {
          payload = { ok: false, message: "서버에 연결하지 못해 측정 기록을 받지 못했습니다(인터넷 연결 확인)." };
        }
        if (state.destroyed || !sameScope(scope) || state.runs[id] !== entry) return;
        entry.loading = false;
        if (payload.ok === true) entry.data = payload;
        else entry.error = errorText(payload);
      }
      renderList();
    }

    // ── 동작(일시중지·다시 시작·그룹·삭제) ──

    function chunkIds(ids) {
      var chunks = [];
      for (var index = 0; index < ids.length; index += BULK_IDS_MAX) chunks.push(ids.slice(index, index + BULK_IDS_MAX));
      return chunks;
    }

    function selectedIdsInOrder() {
      return trackers().filter(function (tracker) { return state.selected.has(tracker.id); }).map(function (tracker) { return tracker.id; });
    }

    // options.okText(total): 성공 문구(없으면 동작별 기본 문구). options.after(total): 모두 성공했을 때 목록을 다시 받기 전에 부른다.
    // options.origin: "bulk"(선택 항목 정리 막대) · "card"(카드 한 장의 버튼, options.cardId). 결과는 누른 자리에 보인다 —
    // 막대 안 한 줄(막대가 한 줄로 접혀도 보임) 또는 그 카드 운영줄 첫 칸. 카드에서 지운 결과(카드가 사라짐)와 모든 실패(한도·오류)는
    // 화면 위 상태줄에도 남긴다.
    async function runBulk(action, ids, extra, options) {
      var opts = options || {};
      var origin = opts.origin === "card" ? "card" : "bulk";
      var lastReport = null;
      var report = function (text, tone) {
        lastReport = { text: text, tone: tone };
        var toStatus = tone === "is-warn" || (origin === "card" && action === "delete");
        if (origin === "card" && opts.cardId && action !== "delete") {
          setCardNote(opts.cardId, text, tone);
          // 카드 알약은 다시 그릴 때 새로 생겨 읽히지 않으므로 화면 읽기 자리에도 쓴다(상태줄에 쓰는 실패는 그쪽이 읽는다).
          if (!toStatus) announce(text);
        }
        if (origin === "bulk") setBulkNote(text, tone);
        if (toStatus) setStatus(text, tone);
      };
      if (!canWrite() || state.busy || !ids.length) return;
      // 앞선 동작이 남긴 결과(맨 위 상태줄의 등록 결과 · 막대 안 결과 줄)는 다음 동작을 시작할 때 지운다.
      if (state.status.text) setStatus("", "");
      if (state.bulkNote.text) setBulkNote("", "");
      if (cleanupMode() && !cleanupAllows(action)) {
        report("추적이 " + LIST_LIMIT + "개를 넘어 정리하는 동안에는 일시중지·삭제만 할 수 있습니다.", "is-warn");
        // 카드 결과는 그 카드에 보이도록 다시 그린다(막대 결과는 setBulkNote 가 바로 그린다).
        if (origin === "card") renderList();
        return;
      }
      state.busy = true;
      renderBulkBar();
      renderList();
      var total = 0;
      var stopped = null;
      var failure = null;
      var chunks = chunkIds(ids);
      for (var index = 0; index < chunks.length; index += 1) {
        var result = await postAction(Object.assign({ action: action, ids: chunks[index] }, extra || {}));
        if (result.stale) {
          state.busy = false;
          renderAll();
          return;
        }
        if (!result.ok) {
          failure = result;
          break;
        }
        total += Number(result.updated || result.deleted || 0);
        if (result.stoppedAt) {
          stopped = result.stoppedAt;
          break;
        }
      }
      state.busy = false;
      if (action === "delete") ids.forEach(function (id) { state.selected.delete(id); });
      var labels = { pause: "일시중지했습니다", resume: "다시 시작했습니다", delete: "삭제했습니다", group: "그룹을 옮겼습니다" };
      if (failure) {
        report((total ? total + "개는 처리했지만 " : "") + errorText(failure), "is-warn");
      } else if (stopped) {
        var name = (findTracker(stopped.id) || {}).keyword || "한 항목";
        var stopText = stopped.code ? errorText({ code: stopped.code, limit: stopped.limit, count: stopped.count }) : "한도에 걸렸습니다.";
        report(total + "개를 다시 시작했고, '" + name + "'에서 멈췄습니다. " + stopText, "is-warn");
      } else {
        if (typeof opts.after === "function") opts.after(total);
        report(typeof opts.okText === "function" ? opts.okText(total) : total + "개 " + labels[action] + ".", total ? "is-ok" : "is-warn");
      }
      await loadList({ afterWrite: true });
      // 모두 지워 목록이 비면 선택 항목 정리 막대는 '결과 줄만' 모양이 된다(넓은 화면은 숨김) → 결과를 맨 위 상태줄에도 쓴다
      // (넓은 화면·화면 읽기용. 휴대폰은 아래 막대 안 결과 줄이 잠시 보인다).
      if (!state.destroyed && origin === "bulk" && state.bulkNote.text && state.payload && !state.setupRequired && !trackers().length && state.status.text !== state.bulkNote.text) {
        setStatus(state.bulkNote.text, state.bulkNote.tone);
      }
      // 카드 '삭제'로 마지막 카드를 지워 목록이 비면 결과는 맨 위 상태줄에만 있어 휴대폰에서 화면 밖이었다(2026-10-23 재검사 3차) →
      // 막대 '결과 줄만' 모양에도 같은 글을 띄운다(넓은 화면은 막대를 감추므로 상태줄 그대로, 휴대폰은 아래 막대 안 결과 줄).
      if (!state.destroyed && origin === "card" && action === "delete" && lastReport && lastReport.text && state.payload && !state.setupRequired && !trackers().length) {
        setBulkNote(lastReport.text, lastReport.tone);
      }
    }

    function startGroupEdit(id) {
      if (cleanupMode()) return;
      state.editingGroupId = state.editingGroupId === id ? "" : id;
      renderList();
      var input = shell.list.querySelector('[data-coupang-rank-group-edit-input]');
      if (input) input.focus();
    }

    // 비우거나 '미분류'로 적으면 기본 그룹(서버가 빈 이름을 '기본 그룹'으로 저장한다: inputs.mjs normalizeCoupangGroupName).
    function saveGroupEdit(id) {
      var input = shell.list.querySelector('[data-coupang-rank-group-edit-input]');
      var name = normalizeGroupInput(input ? input.value : "");
      if (Array.from(name).length > GROUP_MAX) {
        setStatus(ERROR_TEXT.COUPANG_GROUP_INVALID, "is-warn");
        return;
      }
      state.editingGroupId = "";
      runBulk("group", [id], { groupName: name }, {
        origin: "card",
        cardId: id,
        okText: function (total) {
          if (!total) return "그룹을 바꾸지 못했습니다. 목록을 다시 받아 확인해주세요.";
          return name ? "그룹을 " + name + "(으)로 바꿨습니다." : "그룹을 해제했습니다(" + UNGROUPED_LABEL + ").";
        }
      });
    }

    // '그룹으로 옮기기'(N30 '그룹 생성/적용'과 같은 흐름): 적용 뒤 선택·그룹 필터·입력을 비우고 전체 그룹으로 돌아온다.
    function bulkGroup() {
      var raw = String(shell.bulkGroupInput.value || "").trim();
      var name = normalizeGroupInput(raw);
      var ids = selectedIdsInOrder();
      if (!raw) {
        setBulkNote("만들거나 이동할 그룹명을 입력해주세요.", "is-warn");
        shell.bulkGroupInput.focus();
        return;
      }
      if (!ids.length) {
        setBulkNote("그룹에 넣을 추적 항목을 먼저 체크해주세요.", "is-warn");
        return;
      }
      if (!name) {
        // '미분류'라고 적었다: 그룹 해제와 같다.
        bulkUngroup();
        return;
      }
      if (Array.from(name).length > GROUP_MAX) {
        setBulkNote(ERROR_TEXT.COUPANG_GROUP_INVALID, "is-warn");
        return;
      }
      runBulk("group", ids, { groupName: name }, {
        after: resetAfterGroupMove,
        okText: function (total) { return total + "개 추적 항목을 " + name + " 그룹으로 넣고 전체 그룹으로 돌아왔습니다."; }
      });
    }

    // N30 '그룹 해제'. 새 API 없이 기존 group 동작에 빈 그룹 이름을 보낸다(서버가 '기본 그룹'으로 저장).
    function bulkUngroup() {
      var ids = selectedIdsInOrder();
      if (!ids.length) {
        setBulkNote("그룹 해제할 추적 항목을 먼저 체크해주세요.", "is-warn");
        return;
      }
      runBulk("group", ids, { groupName: "" }, {
        after: resetAfterGroupMove,
        okText: function (total) { return total + "개 추적 항목을 그룹에서 해제했습니다."; }
      });
    }

    function resetAfterGroupMove() {
      state.selected.clear();
      state.filter.group = "";
      shell.bulkGroupInput.value = "";
    }

    function deleteIds(ids, options) {
      if (!ids.length) return;
      if (!confirmAction(ids.length + "개와 30일 기록이 지워집니다. 삭제할까요?\n(멈추기만 하려면 '일시중지'를 쓰세요. 일시중지는 기록을 보존합니다.)")) return;
      runBulk("delete", ids, null, options);
    }

    // ── 선택 이미지 저장(§8.5) ──
    // 시트는 화면 카드를 복제하지 않고 따로 만든다(공용 mi-rank-* 클래스 + var(--mi-*) 인라인 style 만).
    // 광고주에게 보내는 이미지라 운영줄의 내부용 알약(상태·판정·광고·그룹·측정 기록·최근·다음)은 넣지 않는다
    // (대표 결정 2026-10-17, N30 이미지와 같은 항목). 남기는 것은 '현재'·'최고'·'전회 대비'·'7일 평균'과 날짜 줄이다.
    // 알약 순서는 C30 화면 카드 운영줄·N30 이미지와 같게 '전회 대비' 다음 '7일 평균'.
    // 날짜 범위는 화면 카드와 같다(등록한 날부터 오늘까지, 측정 없는 날은 '-'). 공유 이미지는 구성을 바꾸지 않는다(대표 결정 2026-10-23):
    // 화면 카드의 '오늘' 표시·작은 글 뺀 칸·'30일 최고'·'상품번호' 글은 넣지 않고 예전 모양 그대로다.

    function inlineCell(cell, d, createdDay) {
      var tone = cellTone(cell, d, createdDay);
      var color = tone === "is-found" ? "var(--mi-navy)" : (tone === "is-failed" || tone === "is-unsupported" ? "var(--mi-orange)" : "var(--mi-muted)");
      return el("span", { style: "display:block;font-size:15px;font-weight:900;color:" + color + ";", text: cellText(cell, d, createdDay) });
    }

    function exportPill(text) {
      return el("span", { style: "border:1px solid var(--mi-line);border-radius:999px;padding:5px 10px;font-size:12px;font-weight:800;color:var(--mi-navy);background:var(--mi-grey-50);white-space:nowrap;", text: text });
    }

    function renderCoupangExportSheet(selectedTrackers) {
      var stage = deps.exportTools.ensureStage(host);
      var payload = state.payload || {};
      var nowLabel = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      var sheet = document.createElement("section");
      sheet.className = "mi-rank-export-sheet";
      sheet.appendChild(el("header", { className: "mi-rank-export-header" }, [
        el("div", {}, [
          el("small", { text: "Moment Insight · Coupang Search Rank" }),
          el("h2", { text: "선택 상품 쿠팡 30일 순위 공유" }),
          el("p", { text: "로그인하지 않은 검색 1쪽에서 광고를 뺀 일반 상품 순위입니다. 하루 칸은 그날 마지막 측정입니다." })
        ]),
        el("span", { className: "mi-rank-export-date", text: nowLabel })
      ]));
      var list = el("div", { className: "mi-rank-export-list" });
      selectedTrackers.forEach(function (tracker) {
        var summary = tracker.summary || {};
        var board;
        var emptyText = emptyBoardText(tracker, payload.days30);
        if (emptyText) {
          board = el("div", { style: "border:1px dashed var(--mi-line);border-radius:8px;padding:18px;color:var(--mi-muted);background:var(--mi-grey-50);font-size:12px;font-weight:800;text-align:center;", text: emptyText });
        } else {
          var range = boardDays(tracker, payload.days30);
          board = el("div", { className: "mi-rank-day-grid" });
          range.dates.forEach(function (d) {
            var weekend = dayClass(d);
            var cell = range.byDay[d] || null;
            board.appendChild(el("div", { className: "mi-rank-day-card" + (weekend ? " " + weekend : ""), style: "background:var(--mi-panel);" }, [
              el("strong", { style: "font-size:11px;", text: dayLabel(d) }),
              el("small", { style: "display:block;font-size:10px;font-weight:700;color:var(--mi-muted);", text: cellLabel(cell) }),
              inlineCell(cell, d, tracker.createdDay)
            ]));
          });
        }
        var title = String(tracker.productTitle || "").trim();
        var card = el("article", { className: "mi-rank-tracker-card", style: "padding:14px 16px;background:var(--mi-panel);border:1px solid var(--mi-line);" }, [
          el("div", { style: "display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:10px;" }, [
            el("div", { style: "min-width:0;" }, [
              el("strong", { style: "display:block;font-size:17px;font-weight:900;color:var(--mi-navy);", text: tracker.keyword || "" }),
              el("span", { style: "display:block;margin-top:4px;font-size:12px;font-weight:700;color:var(--mi-muted);", text: "상품정보 · " + (tracker.productId || "-") + (title ? " · " + title : "") })
            ]),
            el("div", { style: "display:flex;gap:6px;flex:0 0 auto;align-items:center;" }, [
              el("span", { style: "border:1px solid var(--mi-line);border-radius:999px;padding:6px 12px;font-size:14px;font-weight:900;color:var(--mi-navy);background:var(--mi-gold-soft);white-space:nowrap;", text: "현재 " + currentText(tracker) }),
              exportPill("최고 " + (isNum(summary.best30) ? summary.best30 + "위" : "-")),
              exportPill(changeText(summary)),
              exportPill(avg7Text(summary))
            ])
          ]),
          board
        ]);
        list.appendChild(card);
      });
      sheet.appendChild(list);
      stage.replaceChildren(sheet);
      return { stage: stage, sheet: sheet };
    }

    async function exportSelected(selectedTrackers) {
      var tools = deps.exportTools;
      if (!tools || typeof tools.ensureStage !== "function" || typeof tools.serialize !== "function" || typeof tools.toBlob !== "function" || typeof tools.showReady !== "function") {
        setBulkNote("이미지 저장 도구가 연결되지 않았습니다.", "is-warn");
        return;
      }
      var rootId = (host.closest("#mi-admin, #mi-clean") || { id: "mi-admin" }).id;
      var rendered = renderCoupangExportSheet(selectedTrackers);
      await nextFrame();
      var width = Math.max(960, Math.ceil(rendered.sheet.scrollWidth || 1320));
      var height = Math.max(420, Math.ceil(rendered.sheet.scrollHeight || 420));
      if (height > EXPORT_MAX_HEIGHT) {
        rendered.stage.replaceChildren();
        setBulkNote("선택 항목이 너무 많습니다. 20개 이하로 나눠 저장해주세요.", "is-warn");
        return;
      }
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%">' +
        tools.serialize(rendered.sheet, rootId) + "</foreignObject></svg>";
      try {
        var exported = await tools.toBlob(rendered, svg, width, height);
        var link = tools.showReady(host, exported.blob, exportFileName(selectedTrackers, exported.ext), selectedTrackers.length);
        if (link) link.click();
        // N30 과 같은 안내 문구(admin.html 이미지 저장: 'N개 순위 항목의 공유 이미지(PNG)가 준비되었습니다.').
        setBulkNote(selectedTrackers.length + "개 순위 항목의 공유 이미지(" + String(exported.ext).toUpperCase() + ")가 준비되었습니다.", "is-ok");
      } catch (error) {
        var fallback = tools.showReady(host, new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), exportFileName(selectedTrackers, "svg"), selectedTrackers.length);
        if (fallback) fallback.click();
        setBulkNote("이미지 변환이 막혀 SVG 파일로 준비했습니다. 크롬 브라우저에서 다시 시도해주세요.", "is-warn");
      } finally {
        rendered.stage.replaceChildren();
      }
    }

    function exportSelection() {
      var selectedTrackers = trackers().filter(function (tracker) { return state.selected.has(tracker.id); });
      if (!selectedTrackers.length) {
        setBulkNote("이미지로 저장할 항목을 먼저 체크해주세요.", "is-warn");
        return Promise.resolve();
      }
      return exportSelected(selectedTrackers).catch(function (error) {
        var failed = "이미지를 만들지 못했습니다: " + (error && error.message || "알 수 없는 오류");
        setBulkNote(failed, "is-warn");
        setStatus(failed, "is-warn");
      });
    }

    // ── 6. 사용 방법(보조 상자의 첫 줄, 접힘) ──
    // 지금 방식 세 갈래에 맞는 문장만 쓴다(2026-10-23 재검사): 지금 확인 켜짐 · 자동 수집(지금 확인 꺼짐) · 둘 다 꺼짐.
    // 숫자는 서버 manual 칸 값으로 채운다. 지금 확인 칸이 없는 화면(읽기 전용 등)은 자동 수집 설명(legacy)을 쓴다.
    // 갈래 판정 순서는 등록 결과 안내(firstCheckText)·첫 기록 전 카드 안내(firstBoardHint)와 같다(지금 확인 켜짐 → 자동 수집 → 둘 다 꺼짐).

    function guideMode(server) {
      var manualField = Boolean(server) && server.state !== "setup_required" && deps.mode === "admin" && isOwnerSession();
      if (!manualField) return "legacy";
      if (server.state !== "off") return "manual";
      return autoMode() ? "auto" : "none";
    }

    function renderGuide() {
      var scope = currentScope();
      shell.guide.hidden = !scope;
      if (!scope) return;
      var info = collectorInfo() || {};
      var n = checksPerDay();
      var hours = hoursText(info.activeFromHour, info.activeToHour) || "08~23시";
      var server = state.manual.server;
      var mode = guideMode(server);
      var manualOn = mode === "manual";
      var wasOpen = shell.guide.open;
      shell.guide.replaceChildren();
      var sub = { manual: "지금 확인 · 칸 읽는 법 · 필터 · 멈추기와 삭제", none: "켜는 법 · 칸 읽는 법 · 필터 · 멈추기와 삭제" }[mode] || "등록 · 읽는 법 · 멈추기 · 수집 시간";
      shell.guide.appendChild(el("summary", {}, [
        el("strong", { text: "사용 방법" }),
        el("span", { className: "mi-coupang-rank-aux-sub", text: sub })
      ]));
      var autoWhen = "수집기 PC가 켜져 있을 때, 하루 " + (isNum(n) ? n : "n") + "회, " + hours;
      var autoLine = "자동 수집: " + autoWhen + "에 잽니다.";
      var register = "등록: 쿠팡 상품 페이지를 연 뒤 주소창의 주소를 붙여 넣습니다(짧은 링크 link.coupang.com·coupa.ng는 안 됩니다). 상품번호만 넣어도 됩니다.";
      var manualRule = "";
      if (mode !== "legacy") {
        var max = isNum(server.maxPerDay) ? server.maxPerDay : 30;
        manualRule = "검색 사이 " + manualGapMinutes(server) + "분 · 하루 " + max + "번 · " + manualHours(server).text;
      }
      var items = [];
      if (mode === "manual") {
        items.push("기록: 카드의 '지금 확인'을 누를 때만 잽니다(" + manualRule +
          "). 쿠팡이 차단으로 보이는 화면을 보내면 그날은 멈추고, 다음 날 " + pad2(manualHours(server).from) + "시부터 다시 됩니다.");
        items.push("같은 키워드 카드는 한 번 누르면 함께 기록됩니다(하루 횟수도 1번만 씁니다). 그래서 같은 키워드 카드를 따로 누를 필요가 없습니다.");
        items.push("전체 확인: 위 상태판의 '전체 확인'을 누르면 오늘 아직 확인 안 한 상품(일시중지 빼고)을 키워드마다 한 번씩, 검색 사이 " + manualGapMinutes(server) +
          "분을 기다리며 차례로 확인합니다(키워드 수 × 약 " + manualGapMinutes(server) + "분). 진행하는 동안 키워드마다 " + MANUAL_WARN_TEXT +
          " '멈추기'를 누르면 남은 키워드를 바로 취소합니다.");
        items.push(register + " 등록한 뒤 새 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다.");
      } else if (mode === "auto") {
        // 지금 확인은 꺼져 있고 자동 수집이 켜져 있다. 켜 둔 뒤의 경보(멈춤·확인 필요)면 '다음 수집 때 기록'이라고 단정하지 않는다.
        var recording = autoMode() === "recording";
        items.push("기록: 자동 수집으로 잽니다(" + autoWhen + "). 지금 확인은 꺼져 있어 카드에 '지금 확인' 버튼이 없습니다(지금 확인과 자동 수집은 함께 켜지지 않습니다)." +
          (recording ? "" : " 지금은 자동 수집이 멈췄거나 확인이 필요한 상태입니다(위 자동추적 칸 참고)."));
        items.push(register);
        items.push(recording
          ? "첫 기록: 오늘 같은 키워드를 이미 쟀으면 바로 기록되고, 없으면 다음 수집 때 기록됩니다."
          : "첫 기록: 오늘 같은 키워드를 이미 쟀으면 바로 기록됩니다. 그 밖에는 자동 수집이 멈췄거나 확인이 필요한 상태라 언제 기록될지 알 수 없습니다.");
      } else if (mode === "none") {
        items.push("기록: 지금은 지금 확인과 자동 수집이 모두 꺼져 있어 새 순위를 기록하지 않습니다. 위 상태판의 '지금 확인 켜기'를 누르면 카드에 '지금 확인' 버튼이 생기고, 그 버튼을 누를 때만 잽니다(" +
          manualRule + ").");
        items.push(register + " 꺼져 있어도 등록은 되고, '지금 확인'을 켠 뒤 새 카드의 '지금 확인'을 누르면 첫 순위가 기록됩니다.");
      } else {
        items.push(register);
        items.push("첫 기록: 오늘 같은 키워드를 이미 쟀으면 바로 기록되고, 없으면 다음 수집 때 기록됩니다.");
        items.push(autoLine);
      }
      items.push("칸 읽는 법: N위 = 일반 순위, 50위 밖 = 1쪽 일반 상품 1~50위 안에 없음(51위 이후 포함), 없음 = 일반 상품이 50개보다 적고 그 안에 없음, 결과 없음 = 검색 결과 없음, 실패 = 그날 확인이 모두 실패, 이동 = 쿠팡이 검색 결과가 아닌 쪽으로 보냄, - = 그날 기록 없음(회색 칸). 하루 칸은 그날 마지막 확인의 성공값이고, 등록한 날부터 칸이 생깁니다.");
      items.push("칸을 누르면(키보드는 화살표로 옮기고 Enter) 그날 기록이 카드 아래 한 줄에 보입니다. 다시 누르면 닫힙니다.");
      items.push("필터: 전체 그룹은 모든 추적을, 그룹을 고르면 그 그룹만 보여 줍니다. '오늘 안 함'은 일시중지가 아니면서 오늘 아직 확인하지 않은 상품입니다.");
      items.push("일시중지·다시 시작은 기록을 보존하고, 삭제는 30일 기록도 함께 지웁니다.");
      items.push("광고 순번은 참고용입니다. 순위는 광고를 뺀 일반 상품 순서입니다.");
      items.push("상승·하락(전회 대비)은 같은 시간대 회차끼리 비교합니다(하루 횟수를 바꾼 날은 비교할 짝이 없어 '전회 데이터 대기'로 보일 수 있습니다).");
      // 자동 수집 보류 안내는 자동 수집이 돌지 않는 두 갈래(지금 확인 켜짐 · 둘 다 꺼짐)에만 붙인다.
      if (manualOn && autoActive()) items.push(autoLine + " 지금 확인과 자동 수집은 함께 켜지지 않습니다.");
      else if (manualOn || mode === "none") {
        items.push("자동 수집(수집기 PC로 하루 여러 번 자동으로 재는 방식)은 대표 결정(2026-10-17)으로 보류 중입니다. 같은 회선의 윙·광고센터를 보호하려는 결정이고, 설정·연결 코드·설치 줄은 맨 아래 '자동 수집' 칸에 그대로 있습니다.");
      }
      shell.guide.appendChild(el("ol", { className: "mi-coupang-rank-guide-list" }, items.map(function (text) { return el("li", { text: text }); })));
      shell.guide.open = wasOpen;
    }

    // ── 보조 상자: '내 크롬 확장' 줄(지금 확인 확장의 상태·내려받기·확장 ID·설치 안내) ──
    // 설치 안내 열기는 이 줄만 연다(자동 수집 칸을 펼치지 않으므로 수집기 상태 요청도 따라가지 않는다).

    function buildExtFrame() {
      shell.extState = el("span", { className: "mi-coupang-rank-owner-state", "data-coupang-rank-owner-manual-state": true });
      shell.extSummaryText = el("span", { className: "mi-coupang-rank-aux-sub" });
      shell.ext.appendChild(el("summary", {}, [el("strong", { text: "내 크롬 확장" }), shell.extState, shell.extSummaryText]));
      shell.extNote = el("p", { className: "mi-code-status mi-coupang-rank-ext-note", "data-coupang-rank-ext-note": true, "aria-live": "polite", hidden: true });
      shell.ownerManualSection = el("div", { className: "mi-coupang-rank-owner-section mi-coupang-rank-manual-owner", "data-coupang-rank-owner-section": "manual" });
      shell.manualGuide = el("details", { className: "mi-coupang-rank-manual-guide", "data-coupang-rank-manual-guide": true });
      shell.ext.appendChild(el("div", { className: "mi-coupang-rank-owner-body mi-coupang-rank-ext-body" }, [shell.ownerManualSection]));
    }

    function setExtNote(text, tone) {
      state.manual.extNote = { text: text || "", tone: tone || "" };
      renderExtNote();
    }

    function renderExtNote() {
      if (!shell) return;
      var note = state.manual.extNote;
      shell.extNote.textContent = note.text;
      shell.extNote.hidden = !note.text;
      shell.extNote.classList.remove("is-ok", "is-warn");
      if (note.tone) shell.extNote.classList.add(note.tone);
    }

    // ── 보조 상자: '자동 수집' 줄(옛 '수집기 관리', §8.4). 대표 결정(2026-10-17)으로 보류 중이지만 기능은 모두 그대로 둔다. ──

    function buildOwnerFrame() {
      shell.ownerSummaryState = el("span", { className: "mi-coupang-rank-owner-state", "data-coupang-rank-owner-summary-state": true });
      shell.ownerSummaryText = el("span", { className: "mi-coupang-rank-aux-sub" });
      shell.owner.appendChild(el("summary", {}, [
        el("strong", { text: "자동 수집" }),
        shell.ownerSummaryState,
        shell.ownerSummaryText
      ]));
      // 보류 안내 문장은 지금 확인 상태에 따라 renderOwnerVisibility 가 고른다(상태판과 다른 말을 하지 않게).
      shell.ownerHold = el("p", { className: "mi-coupang-rank-owner-hold", "data-coupang-rank-owner-hold": true, hidden: true });
      shell.ownerNote = el("p", { className: "mi-code-status mi-coupang-rank-owner-note", "data-coupang-rank-owner-status": true, "aria-live": "polite", hidden: true });
      shell.ownerStatusSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "status" });
      shell.ownerSettingsSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "settings" });
      shell.ownerLimitsSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "limits" });
      shell.ownerTokensSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "tokens" });
      shell.ownerTokenBox = el("div", { className: "mi-coupang-rank-token-box", "data-coupang-rank-token-box": true, hidden: true });
      shell.ownerLinesSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "lines" });
      shell.ownerStatsSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "stats" });
      var body = el("div", { className: "mi-coupang-rank-owner-body" }, [
        shell.ownerHold,
        el("ol", { className: "mi-coupang-rank-owner-steps" }, [
          el("li", { text: "아래 '연결 코드'에서 새 연결 코드를 만들고, 수집기 PC에서 설치 줄을 실행해 코드를 붙여 넣습니다." }),
          el("li", { text: "연결이 확인되면 '수집 켜기'를 누릅니다. 꺼져 있으면 아무것도 수집하지 않습니다." }),
          el("li", { text: "멈추기는 '수집 끄기'(즉시). 완전히 지우려면 제거 줄을 실행하고 연결 코드를 폐기합니다." }),
          el("li", { text: "속도 올리기는 48시간 동안 차단·빈 쪽이 0이고 성공이 48회 이상일 때 한 단계씩만 됩니다(서버가 막습니다)." })
        ]),
        shell.ownerNote,
        shell.ownerStatusSection,
        shell.ownerSettingsSection,
        shell.ownerLimitsSection,
        shell.ownerTokensSection,
        shell.ownerTokenBox,
        shell.ownerLinesSection,
        shell.ownerStatsSection
      ]);
      shell.owner.appendChild(body);
    }

    // 자동 수집 패널 안의 문구 자리(자동 수집 동작 결과에만 쓴다. 지금 확인 켜기·끄기·확장 상태는 누른 자리 옆에 쓴다).
    function setOwnerNote(text, tone) {
      state.owner.note = { text: text || "", tone: tone || "" };
      if (!shell) return;
      shell.ownerNote.textContent = state.owner.note.text;
      shell.ownerNote.hidden = !state.owner.note.text;
      shell.ownerNote.classList.remove("is-ok", "is-warn");
      if (state.owner.note.tone) shell.ownerNote.classList.add(state.owner.note.tone);
    }

    // 접힌 머리는 목록 응답의 collector.state 로만 채운다(따로 요청하지 않는다). not_connected = 수집기 0대, disabled = 꺼짐.
    function ownerSummary() {
      var name = collectorStateName();
      if (!name) return { pill: "", tone: "", text: "", idle: false };
      if (name === "setup_required") return { pill: "SQL 전", tone: "is-muted", text: "대표 SQL 실행 전입니다", idle: false };
      if (name === "not_connected") return { pill: "보류 중", tone: "is-muted", text: "수집기 0대 · 설정·연결 코드·설치 줄은 그대로 있습니다", idle: true };
      if (name === "disabled") return { pill: "보류 중", tone: "is-muted", text: "수집 꺼짐 · 설정·연결 코드·설치 줄은 그대로 있습니다", idle: true };
      var strip = stripText(collectorInfo(), "admin");
      if (name === "ok" || name === "idle_hours") return { pill: "켜짐", tone: "is-ok", text: strip.text, idle: false };
      return { pill: "켜짐 · 확인 필요", tone: "is-warn", text: strip.text, idle: false };
    }

    function renderOwnerVisibility() {
      var visible = deps.mode === "admin" && isOwnerSession() && Boolean(currentScope());
      shell.owner.hidden = !visible;
      if (!visible) {
        if (shell.owner.open) shell.owner.open = false;
        stopOwnerPoll();
        state.owner.freshToken = null;
        return;
      }
      var summary = ownerSummary();
      shell.ownerSummaryState.textContent = summary.pill;
      shell.ownerSummaryState.className = "mi-coupang-rank-owner-state" + (summary.tone ? " " + summary.tone : "");
      shell.ownerSummaryText.textContent = summary.text;
      shell.ownerHold.hidden = !summary.idle;
      if (summary.idle) setText(shell.ownerHold, ownerHoldText());
    }

    // 자동 수집 보류 안내: 지금 확인이 켜져 있으면 '지금 확인으로만 기록', 꺼져 있으면 '지금은 기록하지 않음'(상태판의 '꺼짐'과 같은 말).
    function ownerHoldText() {
      var server = state.manual.server;
      var manualState = server && typeof server.state === "string" ? server.state : "";
      var head = "자동 수집은 꺼져 있습니다(보류 중). ";
      if (manualState && manualState !== "off" && manualState !== "setup_required") {
        return head + "지금은 카드의 '지금 확인'으로만 기록합니다. 다시 켜려면 먼저 위 상태판의 '지금 확인 끄기'를 누르고, 연결 코드를 만들어 수집기를 설치한 뒤 '수집 켜기'를 누릅니다.";
      }
      if (manualState === "off") {
        return head + "지금 확인도 꺼져 있어 지금은 새 순위를 기록하지 않습니다. 기록하려면 위 상태판에서 '지금 확인 켜기'를 누르거나, 연결 코드를 만들어 수집기를 설치한 뒤 '수집 켜기'를 누릅니다.";
      }
      return head + "다시 켜려면 연결 코드를 만들어 수집기를 설치한 뒤 '수집 켜기'를 누릅니다.";
    }

    function stopOwnerPoll() {
      if (state.owner.timer) {
        clearInterval(state.owner.timer);
        state.owner.timer = 0;
      }
    }

    // 60초 다시 받기는 '패널이 열려 있고, 수집이 켜져 있거나 연결 코드를 만든 뒤 30분 안'일 때만 요청한다(새 수집기 연결을 기다리는 동안).
    // 꺼져 있으면 펼칠 때 1번과 '새로 받기'로만 받는다(집계 DB 조회를 줄인다).
    function ownerPollWanted() {
      var data = state.owner.data;
      if (data && data.settings && data.settings.enabled === true) return true;
      var tokenAge = Date.now() - Number(state.owner.tokenAt || 0);
      if (state.owner.tokenAt && tokenAge >= 0 && tokenAge < OWNER_TOKEN_POLL_MS) return true;
      return autoActive();
    }

    function onOwnerToggle() {
      state.owner.open = shell.owner.open;
      if (state.owner.open && isOwnerSession()) {
        loadOwner();
        stopOwnerPoll();
        state.owner.timer = setInterval(function () {
          if (state.destroyed || !shell || !shell.owner.open) {
            stopOwnerPoll();
            return;
          }
          if ((typeof document !== "undefined" && document.hidden) || !isHostVisible()) return;
          if (!ownerPollWanted()) return;
          loadOwner();
        }, OWNER_POLL_MS);
      } else {
        stopOwnerPoll();
        // 연결 코드 원문은 패널을 닫으면 지운다(다시 볼 수 없다는 안내 그대로).
        state.owner.freshToken = null;
        renderTokenBox();
      }
    }

    // 상태판의 '자동 수집 칸에서 해제하기'(쉬는 중·대표 확인·용량 상한): 자동 수집 줄을 열고 그 자리로 옮긴다.
    // 펼치면 브라우저가 toggle 을 보내 상태를 받는다(onOwnerToggle).
    function openOwnerPanel() {
      if (!shell || shell.owner.hidden) return;
      if (!shell.owner.open) shell.owner.open = true;
      var panel = shell.owner;
      setTimeout(function () {
        if (state.destroyed || !panel || typeof panel.scrollIntoView !== "function") return;
        try { panel.scrollIntoView({ block: "start" }); } catch (error) {}
      }, 150);
    }

    async function loadOwner() {
      if (!isOwnerSession()) return;
      var scope = currentScope();
      if (!scope) return;
      var seq = state.owner.seq = ++seqCounter;
      state.owner.key = scope.key;
      state.owner.flight = seq;
      state.owner.doneAt = 0;
      state.owner.loading = true;
      if (!state.owner.data) renderOwnerBody();
      var payload;
      try {
        payload = await getView("view=collector", scope);
      } catch (error) {
        payload = { ok: false, message: "수집기 상태를 받지 못했습니다(" + (error && error.message || "연결 실패") + ")." };
      }
      if (state.owner.flight === seq) state.owner.flight = 0;
      if (state.destroyed || seq !== state.owner.seq) return;
      state.owner.loading = false;
      if (payload.ok === true) state.owner.doneAt = Date.now();
      if (payload.ok === true && payload.setupRequired !== true && payload.settings) {
        state.owner.data = payload;
        state.owner.error = "";
      } else if (payload.ok === true && payload.setupRequired === true) {
        state.owner.data = null;
        state.owner.error = "대표 SQL 실행 전입니다(설정 필요). SQL을 실행한 뒤 이 패널을 다시 여세요.";
      } else {
        state.owner.error = errorText(payload);
      }
      renderOwnerVisibility();
      renderOwnerBody();
    }

    // 자동 수집 켜기를 서버가 거절할 사유(handler manualAutoConflict · COUPANG_NO_COLLECTOR)를 화면이 받은 값으로 미리 본다.
    // 서버 검사는 그대로라, 화면이 놓쳐도 서버가 마지막에 막는다. 막을 이유가 없으면 "".
    function collectorEnableBlock(data) {
      var server = state.manual.server;
      if (server && server.state !== "setup_required" && (server.enabled === true || (server.state && server.state !== "off"))) {
        return "지금 확인이 켜져 있어 켤 수 없습니다(먼저 위 상태판의 '지금 확인 끄기').";
      }
      var today = todayKstValue();
      if (server && server.stoppedDay && today && String(server.stoppedDay) === today) return "오늘은 지금 확인이 차단으로 멈춘 날이라 내일 켤 수 있습니다.";
      var collectors = data && Array.isArray(data.collectors) ? data.collectors.filter(function (row) { return row && !row.revokedAt; }) : null;
      if (collectorStateName() === "not_connected" || (collectors && !collectors.length)) return "연결된 수집기가 없어 켤 수 없습니다(아래 '연결 코드'부터).";
      return "";
    }

    function sectionBusy(section) {
      if (!section) return false;
      if (section.getAttribute("data-coupang-rank-dirty") === "true") return true;
      return typeof document !== "undefined" && document.activeElement && section.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    }

    function renderOwnerBody(force) {
      if (!shell) return;
      setOwnerNote(state.owner.note.text, state.owner.note.tone);
      var data = state.owner.data;
      [shell.ownerStatusSection, shell.ownerLinesSection, shell.ownerStatsSection].forEach(function (section) { section.replaceChildren(); });
      if (!data) {
        shell.ownerStatusSection.appendChild(el("p", { className: "mi-coupang-rank-muted" + (state.owner.error ? " is-warn" : ""), text: state.owner.error || (state.owner.loading ? "수집기 상태를 받는 중입니다…" : "패널을 펼치면 상태를 받습니다.") }));
        shell.ownerSettingsSection.replaceChildren();
        shell.ownerLimitsSection.replaceChildren();
        shell.ownerTokensSection.replaceChildren();
        renderTokenBox();
        return;
      }
      if (state.owner.error) shell.ownerStatusSection.appendChild(el("p", { className: "mi-coupang-rank-muted is-warn", text: state.owner.error + " 마지막으로 받은 값을 보여 줍니다." }));
      renderOwnerStatus(data);
      if (force || !sectionBusy(shell.ownerSettingsSection)) renderOwnerSettings(data);
      if (force || !sectionBusy(shell.ownerLimitsSection)) renderOwnerLimits(data);
      if (force || !sectionBusy(shell.ownerTokensSection)) renderOwnerTokens(data);
      renderTokenBox();
      renderOwnerLines(data);
      renderOwnerStats(data);
    }

    function ownerHeading(text) {
      return el("h4", { className: "mi-coupang-rank-owner-title", text: text });
    }

    function renderOwnerStatus(data) {
      var settings = data.settings || {};
      var stats = data.stats || {};
      var capacity = data.capacity || {};
      var section = shell.ownerStatusSection;
      var now = Date.now();
      var cooling = settings.cooldownUntil && Date.parse(settings.cooldownUntil) > now;
      var lines = [];
      lines.push(settings.enabled ? "수집 켜짐" : "수집 꺼짐 — 켜기 전에는 아무것도 수집하지 않습니다");
      if (cooling) lines.push("쉬는 중 ~" + kstStamp(settings.cooldownUntil, "") + " · " + (COOLDOWN_REASON_TEXT[settings.cooldownReason] || settings.cooldownReason || "사유 미확인"));
      if (settings.needsOwnerReview) lines.push("대표 확인 필요" + (settings.reviewReason ? " · " + (COOLDOWN_REASON_TEXT[settings.reviewReason] || settings.reviewReason) : ""));
      if (settings.budgetBlocked) lines.push("용량 상한으로 멈춤 · " + (BUDGET_REASON_TEXT[settings.budgetReason] || settings.budgetReason || "사유 미확인"));
      lines.push("7일 안 차단급 쉬기 " + (isNum(stats.blockCooldowns7d) ? stats.blockCooldowns7d : 0) + "번");
      lines.push("서버 release " + (data.release || "-") + " · 수집기 묶음 " + (data.bundleVersion || "-"));
      section.appendChild(ownerHeading("상태"));
      section.appendChild(el("ul", { className: "mi-coupang-rank-owner-lines" }, lines.map(function (line) { return el("li", { text: line }); })));
      var canClear = Boolean(cooling || settings.needsOwnerReview || settings.budgetBlocked);
      // '수집 켜기'는 보조 버튼 모양이다(보류 중인 기능이 가장 권하는 동작처럼 보이지 않게). 서버가 거절할 것이 분명하면 미리 막고 이유를 쓴다.
      var enableBlock = settings.enabled === true ? "" : collectorEnableBlock(data);
      section.appendChild(el("div", { className: "mi-coupang-rank-owner-actions" }, [
        button("수집 켜기", "collector-enable", { disabled: settings.enabled === true || state.busy || Boolean(enableBlock) }),
        button("수집 끄기", "collector-disable", { disabled: settings.enabled !== true || state.busy }),
        button("쉬는 중 해제", "cooldown-clear", { className: "mi-link-button mi-coupang-rank-danger", disabled: !canClear || state.busy }),
        button("새로 받기", "owner-refresh", {})
      ]));
      if (enableBlock) section.appendChild(el("p", { className: "mi-coupang-rank-muted", "data-coupang-rank-enable-block": true, text: enableBlock }));

      // 용량 줄(H1)
      var keywordsAtChecks = isNum(capacity.keywordsAtChecks) ? capacity.keywordsAtChecks : null;
      var fit = keywordsAtChecks === null ? null : Math.min(1000, Math.max(1, keywordsAtChecks));
      var capacityLine = "하루 최대 측정 " + (isNum(capacity.runsPerDay) ? capacity.runsPerDay : "-") + "회 → 하루 " + (isNum(settings.checksPerDay) ? settings.checksPerDay : "n") +
        "번이면 키워드 약 " + (keywordsAtChecks === null ? "-" : keywordsAtChecks) + "개 · 지금 활성 " + (isNum(capacity.activeKeywords) ? capacity.activeKeywords : "-") + "개";
      section.appendChild(ownerHeading("용량"));
      section.appendChild(el("p", { className: "mi-coupang-rank-capacity-line" + (capacity.over ? " is-warn" : "") }, [
        capacityLine,
        capacity.over ? el("strong", { text: " · 지연이 생깁니다" }) : null
      ]));
      var globalLine = globalLimitText(state.payload && state.payload.limit);
      if (globalLine) section.appendChild(el("p", { className: "mi-coupang-rank-capacity-line", text: globalLine }));
      if (fit !== null) {
        section.appendChild(el("div", { className: "mi-coupang-rank-owner-actions" }, [
          button("전체 한도를 " + fit + "으로 맞추기", "capacity-fit", { "data-coupang-rank-value": String(fit), disabled: fit === settings.globalKeywordLimit || state.busy })
        ]));
      }
      if (isNum(stats.ineligibleActiveTrackers) && stats.ineligibleActiveTrackers > 0) {
        section.appendChild(el("p", { className: "mi-coupang-rank-muted is-warn", text: "연결 해제·해지된 범위의 활성 추적기 " + stats.ineligibleActiveTrackers + "개(수집·한도에서 제외, 다시 연결되면 자동 재개)" }));
      }
    }

    function renderOwnerSettings(data) {
      var settings = data.settings || {};
      var section = shell.ownerSettingsSection;
      section.replaceChildren();
      section.removeAttribute("data-coupang-rank-dirty");
      section.appendChild(ownerHeading("설정"));
      var manual = state.manual.server;
      var manualPart = manual && manual.state !== "setup_required"
        ? "(검색 사이 " + manualGapMinutes(manual) + "분 · 하루 " + (isNum(manual.maxPerDay) ? manual.maxPerDay : 30) + "번 · " + manualHours(manual).text + ")"
        : "";
      section.appendChild(el("p", { className: "mi-coupang-rank-muted", "data-coupang-rank-settings-scope": true, text: "이 설정은 자동 수집에만 적용됩니다. 지금 확인" + manualPart + "과는 따로입니다." }));
      var form = el("form", { className: "mi-coupang-rank-settings", "data-coupang-rank-settings-form": true, novalidate: true });
      SETTING_FIELDS.forEach(function (field) {
        var control;
        if (field.type === "bool") {
          control = el("input", { type: "checkbox", "data-coupang-rank-setting": field.key });
          control.checked = settings[field.key] === true;
        } else if (field.type === "enum") {
          control = el("select", { className: "mi-input", "data-coupang-rank-setting": field.key }, field.options.map(function (option) {
            return el("option", { value: option[0], text: option[1] });
          }));
          control.value = settings[field.key] || field.options[0][0];
        } else if (field.type === "version") {
          control = el("input", { className: "mi-input", type: "text", inputmode: "decimal", placeholder: "예: 1.0.0", "data-coupang-rank-setting": field.key, value: settings[field.key] || "" });
        } else {
          control = el("input", { className: "mi-input", type: "number", inputmode: "numeric", min: String(field.min), max: String(field.max), step: "1", "data-coupang-rank-setting": field.key, value: isNum(settings[field.key]) ? String(settings[field.key]) : "" });
        }
        var error = state.owner.fieldErrors[field.key] || "";
        var label = field.type === "bool"
          ? el("label", { className: "mi-coupang-rank-setting" }, [
            el("span", { text: field.label }),
            el("span", { className: "mi-coupang-rank-toggle" }, [control, el("span", { text: "켜기" })])
          ])
          : el("label", { className: "mi-coupang-rank-setting" }, [
            el("span", { text: field.label + (field.type === "int" ? " (" + field.min + "~" + field.max + ")" : "") }),
            control
          ]);
        var wrap = el("div", { className: "mi-coupang-rank-setting-wrap" }, [
          label,
          field.help ? el("small", { className: "mi-coupang-rank-muted", text: field.help }) : null,
          el("small", { className: "mi-coupang-rank-field-error", "data-coupang-rank-field-error": field.key, hidden: !error, text: error })
        ]);
        form.appendChild(wrap);
      });
      form.appendChild(el("div", { className: "mi-coupang-rank-owner-actions" }, [
        el("button", { className: "mi-button", type: "submit", text: "설정 저장", disabled: state.busy }),
        button("되돌리기(저장 전 값)", "settings-revert", {})
      ]));
      section.appendChild(form);
      section.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "내리는 변경은 바로 됩니다. 속도를 올리는 변경(시간당·하루 상한 증가, 최소 간격 감소, 수집 시간 넓힘)은 확인 창을 거치고 서버가 조건을 다시 확인합니다." }));
    }

    function readSettingsForm() {
      var values = {};
      Array.prototype.forEach.call(shell.ownerSettingsSection.querySelectorAll("[data-coupang-rank-setting]"), function (node) {
        var key = node.getAttribute("data-coupang-rank-setting");
        values[key] = node.type === "checkbox" ? node.checked === true : node.value;
      });
      return values;
    }

    function showFieldErrors(errors) {
      state.owner.fieldErrors = errors || {};
      Array.prototype.forEach.call(shell.ownerSettingsSection.querySelectorAll("[data-coupang-rank-field-error]"), function (node) {
        var key = node.getAttribute("data-coupang-rank-field-error");
        var message = state.owner.fieldErrors[key] || "";
        node.textContent = message;
        node.hidden = !message;
      });
    }

    function raiseConfirmText(data, patch) {
      var stats = data.stats || {};
      var settings = data.settings || {};
      var raise = data.raise || {};
      var hours = hoursSince(settings.rateChangedAt);
      var lines = [
        "속도를 올리는 변경입니다.",
        "48시간 차단 " + (isNum(stats.blocked48h) ? stats.blocked48h : "-") + " · 빈 쪽 " + (isNum(stats.empty48h) ? stats.empty48h : "-") +
          " · 성공 " + (isNum(stats.success48h) ? stats.success48h : "-") + "회 · 마지막 상향 뒤 " + (hours === null ? "-" : hours) + "시간",
        "다음 단계: 시간당 " + (isNum(raise.nextStep) ? raise.nextStep : "-") + "회" + (isNum(patch.maxRunsPerHour) ? " (요청 " + patch.maxRunsPerHour + "회)" : ""),
        "조건: 48시간 차단·빈 쪽 0, 성공 48회 이상, 마지막 상향 뒤 48시간, 한 번에 한 단계.",
        "쿠팡이 막으면 더 길게 쉬게 됩니다. 저장할까요?"
      ];
      return lines.join("\n");
    }

    async function saveSettings() {
      var data = state.owner.data;
      if (!data || !data.settings || state.busy) return;
      var result = settingsPatch(data.settings, readSettingsForm());
      showFieldErrors(result.errors);
      if (Object.keys(result.errors).length) {
        setOwnerNote("범위를 벗어난 칸이 있습니다. 칸 아래 안내를 확인하세요.", "is-warn");
        return;
      }
      var keys = Object.keys(result.patch);
      if (!keys.length) {
        setOwnerNote("바뀐 값이 없습니다.", "");
        return;
      }
      var body = { action: "settings-update", settings: result.patch };
      if (isRaise(data.settings, result.patch)) {
        if (!confirmAction(raiseConfirmText(data, result.patch))) return;
        body.confirmRaise = true;
      }
      await ownerPost(body, function (payload) {
        return "설정을 저장했습니다." + (isNum(payload.replanned) && payload.replanned > 0 ? " 키워드 " + payload.replanned + "개의 일정을 다시 계산했습니다." : "");
      }, function (payload) {
        if (payload.code === "COUPANG_SETTINGS_INVALID" && payload.field) {
          var errors = {};
          errors[payload.field] = "서버가 이 값을 받지 않았습니다. 범위를 확인하세요.";
          showFieldErrors(errors);
        }
      });
    }

    async function ownerPost(body, okText, handleError) {
      if (state.busy) return null;
      state.busy = true;
      renderOwnerBody();
      var payload = await postAction(body);
      state.busy = false;
      if (payload.stale) {
        renderOwnerBody();
        return null;
      }
      if (payload.ok) {
        state.owner.fieldErrors = {};
        if (payload.settings && state.owner.data) state.owner.data.settings = payload.settings;
        if (payload.accountLimits && state.owner.data) state.owner.data.accountLimits = payload.accountLimits;
        setOwnerNote(typeof okText === "function" ? okText(payload) : okText, "is-ok");
        renderOwnerBody(true);
        renderOwnerVisibility();
        loadOwner();
        if (/^(settings-update|collector-enable|collector-disable|cooldown-clear)$/.test(body.action)) loadList();
      } else {
        setOwnerNote(errorText(payload), "is-warn");
        renderOwnerBody();
        if (typeof handleError === "function") handleError(payload);
      }
      return payload;
    }

    function ownerButton(action, node) {
      var data = state.owner.data;
      var settings = data && data.settings || {};
      var stats = data && data.stats || {};
      if (action === "owner-refresh") {
        loadOwner();
        return;
      }
      if (action === "settings-revert") {
        showFieldErrors({});
        renderOwnerSettings(data || { settings: {} });
        setOwnerNote("저장 전 값으로 되돌렸습니다.", "");
        return;
      }
      if (action === "collector-enable") {
        if (!confirmAction("수집을 켭니다. 수집기 PC가 켜져 있으면 다음 회차부터 쿠팡 검색을 잽니다.\n" +
          "'지금 확인'이 켜져 있거나 오늘 지금 확인이 차단으로 멈춘 날이면 서버가 켜지 않습니다(자동 수집이 아직 지금 확인의 간격·그날 중지를 보지 않으므로, 먼저 '지금 확인 끄기'). 켤까요?")) return;
        ownerPost({ action: "collector-enable" }, "수집을 켰습니다.");
        return;
      }
      if (action === "collector-disable") {
        if (!confirmAction("수집을 끕니다. 다음 요청부터 바로 멈추고, 기록은 그대로 남습니다. 끌까요?")) return;
        ownerPost({ action: "collector-disable" }, "수집을 껐습니다.");
        return;
      }
      if (action === "cooldown-clear") {
        var reason = COOLDOWN_REASON_TEXT[settings.cooldownReason] || COOLDOWN_REASON_TEXT[settings.reviewReason] || BUDGET_REASON_TEXT[settings.budgetReason] || "사유 미확인";
        if (!confirmAction("쉬는 중을 해제합니다.\n사유: " + reason + " · 7일 차단급 " + (isNum(stats.blockCooldowns7d) ? stats.blockCooldowns7d : 0) + "번\n쿠팡이 막은 상태에서 다시 돌리면 더 길게 막힐 수 있습니다. 7일 차단 횟수는 지워지지 않습니다. 해제할까요?")) return;
        ownerPost({ action: "cooldown-clear" }, "쉬는 중을 해제했습니다.");
        return;
      }
      if (action === "capacity-fit") {
        var value = Number(node.getAttribute("data-coupang-rank-value"));
        if (!isNum(value) || value < 1) return;
        if (!confirmAction("전체 고유 키워드 한도를 " + value + "개로 바꿉니다. 이미 활성인 추적은 그대로이고, 새 키워드 등록만 막힙니다. 바꿀까요?")) return;
        ownerPost({ action: "settings-update", settings: { globalKeywordLimit: value } }, "전체 한도를 " + value + "개로 맞췄습니다.");
        return;
      }
      if (action === "limit-save" || action === "limit-delete") {
        var code = node.getAttribute("data-coupang-rank-code") || "";
        if (action === "limit-delete") {
          if (!confirmAction(code + " 계정별 한도를 지우면 기본 한도(" + (isNum(settings.defaultAccountLimit) ? settings.defaultAccountLimit : "-") + "개)를 씁니다. 지울까요?")) return;
          ownerPost({ action: "account-limit-set", agencyCode: code, keywordLimit: null }, code + " 계정별 한도를 지웠습니다.");
          return;
        }
        var input = shell.ownerLimitsSection.querySelector('[data-coupang-rank-limit-input="' + code.replace(/["\\]/g, "") + '"]');
        var limitValue = parseLimit(input ? input.value : "");
        if (limitValue === null) {
          setOwnerNote("한도는 0~1000 사이의 정수로 입력하세요.", "is-warn");
          return;
        }
        ownerPost({ action: "account-limit-set", agencyCode: code, keywordLimit: limitValue }, code + " 한도를 " + limitValue + "개로 저장했습니다.");
        return;
      }
      if (action === "token-revoke") {
        var id = node.getAttribute("data-coupang-rank-collector-id") || "";
        var name = node.getAttribute("data-coupang-rank-collector-label") || "수집기";
        if (!confirmAction("'" + name + "' 연결 코드를 폐기하면 그 수집기는 다음 요청부터 막힙니다. 폐기할까요?")) return;
        ownerPost({ action: "collector-token-revoke", id: id }, "'" + name + "' 연결 코드를 폐기했습니다.");
        return;
      }
      if (action === "token-close") {
        state.owner.freshToken = null;
        renderTokenBox();
        return;
      }
      if (action === "token-copy") {
        if (state.owner.freshToken) copyOwnerText(state.owner.freshToken.token, "연결 코드를 복사했습니다. 수집기 PC의 설치 창에만 붙여 넣으세요.");
        return;
      }
      if (action === "line-copy") {
        var key = node.getAttribute("data-coupang-rank-line") || "";
        var lines = data && data.oneLiners || {};
        if (lines[key]) copyOwnerText(lines[key], "복사했습니다. 수집기 PC의 터미널(윈도우는 관리자 PowerShell)에 붙여 넣으세요.");
      }
    }

    function copyOwnerText(text, okMessage) {
      try {
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).then(function () { setOwnerNote(okMessage, "is-ok"); }, function () {
            setOwnerNote("자동 복사가 막혔습니다. 칸의 글을 직접 선택해 복사하세요.", "is-warn");
          });
          return;
        }
      } catch (error) {}
      setOwnerNote("자동 복사가 막혔습니다. 칸의 글을 직접 선택해 복사하세요.", "is-warn");
    }

    function parseLimit(raw) {
      var text = String(raw == null ? "" : raw).trim();
      if (!/^[0-9]+$/.test(text)) return null;
      var value = Number(text);
      return value >= 0 && value <= 1000 ? value : null;
    }

    function renderOwnerLimits(data) {
      var settings = data.settings || {};
      var section = shell.ownerLimitsSection;
      section.replaceChildren();
      section.removeAttribute("data-coupang-rank-dirty");
      section.appendChild(ownerHeading("계정별 한도"));
      section.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "표에 없는 계정은 기본 한도 " + (isNum(settings.defaultAccountLimit) ? settings.defaultAccountLimit : "-") + "개를 씁니다. 수집 대상인 활성 추적만 셉니다." }));
      var rows = Array.isArray(data.accountLimits) ? data.accountLimits : [];
      var table = el("div", { className: "mi-coupang-rank-table", role: "table", "aria-label": "계정별 한도" });
      table.appendChild(el("div", { className: "mi-coupang-rank-row is-head", role: "row" }, ["코드", "이름 · 종류", "한도", ""].map(function (text) {
        return el("span", { role: "columnheader", text: text });
      })));
      rows.forEach(function (row) {
        var code = String(row.agencyCode || "");
        var kind = ACCOUNT_KIND_TEXT[row.kind] || String(row.kind || "");
        var name = row.kind === "unknown" ? "연결 없음" : (String(row.label || "") + (row.kind === "owner" ? "" : " · " + kind));
        table.appendChild(el("div", { className: "mi-coupang-rank-row" + (row.kind === "unknown" ? " is-orphan" : ""), role: "row" }, [
          el("span", { role: "cell", className: "mi-coupang-rank-code", text: code }),
          el("span", { role: "cell", text: name }),
          el("span", { role: "cell" }, [el("input", { className: "mi-input", type: "number", min: "0", max: "1000", step: "1", value: isNum(row.keywordLimit) ? String(row.keywordLimit) : "", "aria-label": code + " 한도", "data-coupang-rank-limit-input": code })]),
          el("span", { role: "cell", className: "mi-coupang-rank-row-actions" }, [
            button("저장", "limit-save", { "data-coupang-rank-code": code, disabled: state.busy }),
            button("지우기", "limit-delete", { className: "mi-link-button mi-coupang-rank-danger", "data-coupang-rank-code": code, disabled: state.busy })
          ])
        ]));
      });
      if (!rows.length) table.appendChild(el("div", { className: "mi-coupang-rank-row", role: "row" }, [el("span", { role: "cell", text: "따로 정한 계정이 없습니다." })]));
      section.appendChild(table);
      var add = el("form", { className: "mi-coupang-rank-inline-form", "data-coupang-rank-limit-form": true, novalidate: true }, [
        el("input", { className: "mi-input", type: "text", maxlength: "64", placeholder: "계정 코드(예: mml93-a01)", "aria-label": "한도를 정할 계정 코드", "data-coupang-rank-limit-new-code": true }),
        el("input", { className: "mi-input", type: "number", min: "0", max: "1000", step: "1", placeholder: "한도(0~1000)", "aria-label": "새 계정 한도", "data-coupang-rank-limit-new-value": true }),
        el("button", { className: "mi-button", type: "submit", text: "한도 추가", disabled: state.busy })
      ]);
      section.appendChild(add);
    }

    function submitLimitForm() {
      var codeInput = shell.ownerLimitsSection.querySelector("[data-coupang-rank-limit-new-code]");
      var valueInput = shell.ownerLimitsSection.querySelector("[data-coupang-rank-limit-new-value]");
      var code = String(codeInput && codeInput.value || "").trim().toLowerCase();
      var value = parseLimit(valueInput ? valueInput.value : "");
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
        setOwnerNote("계정 코드는 영문 소문자·숫자·-·_ 로 입력하세요.", "is-warn");
        return;
      }
      if (value === null) {
        setOwnerNote("한도는 0~1000 사이의 정수로 입력하세요.", "is-warn");
        return;
      }
      ownerPost({ action: "account-limit-set", agencyCode: code, keywordLimit: value }, code + " 한도를 " + value + "개로 저장했습니다.");
    }

    function renderOwnerTokens(data) {
      var section = shell.ownerTokensSection;
      section.replaceChildren();
      section.removeAttribute("data-coupang-rank-dirty");
      section.appendChild(ownerHeading("연결 코드(수집기 최대 3대)"));
      var collectors = Array.isArray(data.collectors) ? data.collectors : [];
      var todayKst = state.payload && state.payload.todayKst || "";
      if (!collectors.length) section.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "아직 연결 코드가 없습니다. 아래에서 만든 뒤 수집기 PC에 설치하세요." }));
      collectors.forEach(function (collector) {
        var revoked = Boolean(collector.revokedAt);
        var details = [
          PLATFORM_TEXT[collector.platform] || "플랫폼 미확인",
          "끝 4자리 " + (collector.tokenHint || "-"),
          "만든 날 " + (kstDate(collector.createdAt).slice(5) || "-"),
          "마지막 신호 " + (collector.lastSeenAt ? kstStamp(collector.lastSeenAt, todayKst) : "없음")
        ];
        var versions = [
          collector.lastVersion ? "수집기 " + collector.lastVersion : "",
          collector.lastNode ? "Node " + collector.lastNode : "",
          collector.lastBrowser ? String(collector.lastBrowser) : "",
          collector.lastGuard ? GUARD_TEXT[collector.lastGuard] || String(collector.lastGuard) : ""
        ].filter(Boolean);
        var claim = collector.lastClaimReason ? "마지막 요청 답 " + (CLAIM_REASON_TEXT[collector.lastClaimReason] || String(collector.lastClaimReason)) + (collector.lastClaimAt ? " · " + kstStamp(collector.lastClaimAt, todayKst) : "") : "";
        section.appendChild(el("div", { className: "mi-coupang-rank-collector" + (revoked ? " is-revoked" : "") }, [
          el("div", {}, [
            el("strong", { text: String(collector.label || "수집기") + (revoked ? " · 폐기됨" : "") }),
            el("span", { text: details.join(" · ") }),
            versions.length ? el("span", { text: versions.join(" · ") }) : null,
            claim ? el("span", { text: claim }) : null
          ]),
          revoked ? null : button("폐기", "token-revoke", { className: "mi-link-button mi-coupang-rank-danger", "data-coupang-rank-collector-id": collector.id, "data-coupang-rank-collector-label": collector.label || "수집기", disabled: state.busy })
        ]));
      });
      section.appendChild(el("form", { className: "mi-coupang-rank-inline-form", "data-coupang-rank-token-form": true, novalidate: true }, [
        el("input", { className: "mi-input", type: "text", maxlength: "40", placeholder: "수집기 이름(예: 윈도우 데스크탑)", "aria-label": "새 연결 코드 이름", "data-coupang-rank-token-label": true }),
        el("button", { className: "mi-button", type: "submit", text: "새 연결 코드 만들기", disabled: state.busy })
      ]));
      section.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "새 코드를 만들어도 기존 코드는 폐기되지 않습니다(맥 미니로 옮길 때 두 대를 겹쳐 쓸 수 있습니다)." }));
    }

    async function submitTokenForm() {
      var input = shell.ownerTokensSection.querySelector("[data-coupang-rank-token-label]");
      var label = String(input && input.value || "").replace(/\s+/g, " ").trim() || "수집기";
      if (Array.from(label).length > 40) {
        setOwnerNote(ERROR_TEXT.COUPANG_COLLECTOR_LABEL_INVALID, "is-warn");
        return;
      }
      var payload = await ownerPost({ action: "collector-token-create", label: label }, "'" + label + "' 연결 코드를 만들었습니다. 아래 코드는 지금 한 번만 보입니다.");
      if (payload && payload.ok && payload.token) {
        state.owner.tokenAt = Date.now();
        state.owner.freshToken = { label: payload.label || label, token: payload.token, hint: payload.tokenHint || "" };
        renderTokenBox();
      }
    }

    function renderTokenBox() {
      if (!shell) return;
      var box = shell.ownerTokenBox;
      box.replaceChildren();
      var fresh = state.owner.freshToken;
      box.hidden = !fresh;
      if (!fresh) return;
      var field = el("input", { className: "mi-input mi-coupang-rank-code-field", type: "text", readonly: true, "aria-label": "새 연결 코드", spellcheck: "false", autocomplete: "off" });
      field.value = fresh.token;
      box.appendChild(el("strong", { text: "'" + fresh.label + "' 연결 코드" }));
      box.appendChild(field);
      box.appendChild(el("p", { className: "mi-coupang-rank-token-warning", text: "이 창을 닫으면 다시 볼 수 없습니다. 수집기 PC의 설치 창에만 붙여 넣으세요" }));
      box.appendChild(el("div", { className: "mi-coupang-rank-owner-actions" }, [
        button("복사", "token-copy", { className: "mi-button" }),
        button("닫기", "token-close", {})
      ]));
    }

    function renderOwnerLines(data) {
      var section = shell.ownerLinesSection;
      var lines = data.oneLiners || {};
      section.appendChild(ownerHeading("수집기 설치 · 확인 · 제거 줄"));
      section.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "윈도우는 Edge, 맥은 Edge를 씁니다(N30 크롬과 분리). 같은 줄로 업데이트도 합니다." }));
      ONE_LINERS.forEach(function (entry) {
        var text = lines[entry[0]];
        if (!text) return;
        section.appendChild(el("div", { className: "mi-coupang-rank-line" }, [
          el("div", { className: "mi-coupang-rank-line-head" }, [
            el("strong", { text: entry[1] }),
            button("복사", "line-copy", { "data-coupang-rank-line": entry[0] })
          ]),
          el("code", { className: "mi-coupang-rank-code-block", text: text }),
          entry[2] ? el("small", { className: "mi-coupang-rank-muted is-warn", text: "제거 뒤 연결 코드도 폐기하세요" }) : null
        ]));
      });
    }

    function renderOwnerStats(data) {
      var section = shell.ownerStatsSection;
      var stats = data.stats || {};
      var settings = data.settings || {};
      var todayKst = state.payload && state.payload.todayKst || "";
      section.appendChild(ownerHeading("집계"));
      var runs = stats.runs24h && typeof stats.runs24h === "object" ? stats.runs24h : {};
      var runParts = Object.keys(runs).filter(function (key) { return Number(runs[key]) > 0; }).map(function (key) {
        return (RUN_STATUS_TEXT[key] || key) + " " + runs[key];
      });
      // 서버가 '성공'을 수집기 회차로만 셌으면(지금 확인 SQL 뒤) 그렇다고 적는다. 차단·빈 쪽에는 지금 확인도 들어간다.
      var collectorOnly = stats.successSource === "collector";
      var lines = [
        "최근 24시간 회차: " + (runParts.length ? runParts.join(" · ") : "없음"),
        "지난 1시간 " + (isNum(stats.runsLastHour) ? stats.runsLastHour : 0) + "회 · 오늘 " + (isNum(stats.runsToday) ? stats.runsToday : 0) + "회" +
          (isNum(stats.avgDurationMs24h) ? " · 성공 평균 " + (Math.round(stats.avgDurationMs24h / 100) / 10) + "초" : ""),
        "48시간: 차단 " + (isNum(stats.blocked48h) ? stats.blocked48h : 0) + " · 빈 쪽 " + (isNum(stats.empty48h) ? stats.empty48h : 0) +
          (collectorOnly ? "(지금 확인 포함)" : "") + " · 성공 " + (isNum(stats.success48h) ? stats.success48h : 0) + (collectorOnly ? "(수집기만)" : ""),
        "마지막 수집 " + (stats.lastRunAt ? kstStamp(stats.lastRunAt, todayKst) : "없음") + " · 마지막 성공" + (collectorOnly ? "(수집기)" : "") + " " +
          (stats.lastSuccessAt ? kstStamp(stats.lastSuccessAt, todayKst) : "없음") +
          (stats.lastErrorCode ? " · 마지막 오류 " + stats.lastErrorCode : ""),
        "예정 시각 지난 키워드 " + (isNum(stats.overdueKeywords) ? stats.overdueKeywords : 0) + "개",
        "저장 용량: C 표 " + megabytes(stats.storage && stats.storage.coupangBytes) + " / 상한 " + (isNum(settings.maxStorageMb) ? settings.maxStorageMb + "MB" : "-") +
          " · DB 전체 " + megabytes(stats.storage && stats.storage.databaseBytes) + " / 멈춤 기준 " + (isNum(settings.dbSizeStopMb) ? settings.dbSizeStopMb + "MB" : "-")
      ];
      section.appendChild(el("ul", { className: "mi-coupang-rank-owner-lines" }, lines.map(function (line) { return el("li", { text: line }); })));
      var cooldowns = Array.isArray(stats.recentCooldowns) ? stats.recentCooldowns : [];
      section.appendChild(el("strong", { className: "mi-coupang-rank-owner-subtitle", text: "최근 쉬기 " + cooldowns.length + "건" }));
      if (cooldowns.length) {
        section.appendChild(el("ul", { className: "mi-coupang-rank-owner-lines" }, cooldowns.slice(0, 10).map(function (item) {
          var text = kstStamp(item.startedAt, todayKst) + " ~ " + kstStamp(item.endsAt, todayKst) + " · " + (COOLDOWN_REASON_TEXT[item.reason] || item.reason || "") +
            (isNum(item.level) ? " · 단계 " + item.level : "") + (item.clearedAt ? " · 해제 " + kstStamp(item.clearedAt, todayKst) : "");
          return el("li", { text: text });
        })));
      }
    }

    // ── ① 지금 확인(spec-manual §7) ──

    function takeManualInfo(payload) {
      if (!payload || typeof payload !== "object" || !Object.prototype.hasOwnProperty.call(payload, "manual")) return null;
      var info = payload.manual;
      delete payload.manual;
      return info && typeof info === "object" ? info : null;
    }

    function setManualServer(info) {
      var manual = state.manual;
      if (!info || typeof info !== "object" || typeof info.state !== "string") {
        manual.server = null;
        return;
      }
      manual.server = info;
      var serverTime = Date.parse(info.serverTime);
      // 시간 판정은 서버 시각만 쓴다. 내 시계와의 차이는 남은 시간 표시에만 보정한다.
      manual.offsetMs = isFinite(serverTime) ? serverTime - Date.now() : 0;
      if (info.state !== "stopped") manual.stopDetail = "";
    }

    function manualNow() {
      return Date.now() + (state.manual.offsetMs || 0);
    }

    function userAgentText() {
      try {
        return typeof navigator !== "undefined" && navigator && typeof navigator.userAgent === "string" ? navigator.userAgent : "";
      } catch (error) {
        return "";
      }
    }

    // 카드 버튼·확장 확인을 쓸지(spec-manual §7.1): 관리자 화면 · 총관리자 · 쓰기 가능 · 서버 manual 칸이 켜짐.
    function manualVisible() {
      if (deps.mode !== "admin" || !isOwnerSession() || !canWrite() || state.setupRequired || !state.payload || !currentScope()) return false;
      var server = state.manual.server;
      return Boolean(server) && server.state !== "off" && server.state !== "setup_required";
    }

    // 진행 중에 껐다(서버는 off, 이 화면의 확인은 끝까지 간다 — manualView 의 off + run 갈래). 그 카드 버튼만 '확인 중…'으로 남긴다.
    function manualRunWhileOff() {
      if (deps.mode !== "admin" || !isOwnerSession() || !canWrite() || state.setupRequired || !state.payload || !currentScope()) return false;
      var server = state.manual.server;
      var run = state.manual.run;
      return Boolean(server) && server.state === "off" && Boolean(run) && typeof run.trackerId === "string" && Boolean(run.trackerId);
    }

    // 상태판을 보일지: 위와 같되 꺼짐(off)이어도 보인다(꺼졌다는 사실과 '지금 확인 켜기'가 본문에 남게). SQL 전·서버 칸 없음이면 숨긴다.
    function manualBoardVisible() {
      if (deps.mode !== "admin" || !isOwnerSession() || !canWrite() || state.setupRequired || !state.payload || !currentScope()) return false;
      var server = state.manual.server;
      return Boolean(server) && typeof server.state === "string" && Boolean(server.state) && server.state !== "setup_required";
    }

    function manualExtensionId() {
      var server = state.manual.server;
      var id = server ? String(server.extensionId || "") : "";
      return MANUAL_EXTENSION_ID_PATTERN.test(id) ? id : "";
    }

    function manualZipPath() {
      var server = state.manual.server;
      var path = server ? String(server.extensionZipPath || "") : "";
      return MANUAL_ZIP_PATH_PATTERN.test(path) ? path : "";
    }

    function readPending() {
      var store = localStore();
      if (!store) return null;
      try {
        var raw = store.getItem(MANUAL_PENDING_KEY);
        if (!raw) return null;
        var pending = JSON.parse(raw);
        var age = Date.now() - Number(pending && pending.savedAt || 0);
        if (!pending || typeof pending.claimId !== "string" || typeof pending.claimToken !== "string" || !(age >= -60000 && age < MANUAL_PENDING_MAX_MS)) {
          store.removeItem(MANUAL_PENDING_KEY);
          return null;
        }
        return pending;
      } catch (error) {
        try { store.removeItem(MANUAL_PENDING_KEY); } catch (ignored) {}
        return null;
      }
    }

    function writePending(pending) {
      var store = localStore();
      if (!store) return;
      try {
        store.setItem(MANUAL_PENDING_KEY, JSON.stringify(pending));
      } catch (error) {}
    }

    function clearPending(claimId) {
      var store = localStore();
      if (!store) return;
      try {
        var current = readPending();
        if (!current || !claimId || current.claimId === claimId) store.removeItem(MANUAL_PENDING_KEY);
      } catch (error) {}
    }

    // 이 브라우저에서 방금 받은 확인(아직 결과 전)이 있는지. 서버가 busy 라고 할 때 문구만 바꾼다.
    function ownPendingActive() {
      var pending = readPending();
      if (!pending || pending.report) return false;
      var age = Date.now() - Number(pending.savedAt || 0);
      return age >= 0 && age < MANUAL_CHECK_GIVE_UP_MS;
    }

    // 이 화면의 방금 확인이 확장 응답 없이 끝났는지(서버는 확인 뒤 150초 동안 그 확인을 '진행 중'으로 센다).
    // 응답 없음은 확인 뒤에 오므로, 그 뒤 150초 안의 '진행 중'은 다른 사람이 아니라 이 확인이다.
    function ownLostActive() {
      var lost = state.manual.lost;
      if (!lost) return false;
      var age = Date.now() - Number(lost.at || 0);
      return age >= 0 && age < MANUAL_LOST_BUSY_MS;
    }

    // 이 화면이 결과(manual-record)를 서버에 보내지 못한 요청을 claimId 로 기억한다(연결 실패·로그인 풀림·5xx).
    // at 은 그 요청을 처음 보내지 못한 시각이고, 같은 요청을 다시 보내다 또 실패해도 바꾸지 않는다.
    // 결과를 끝내 보내면(settleManualRecord 의 끝난 답) 지운다.
    function rememberUnsent(claimId) {
      var manual = state.manual;
      if (manual.unsent && manual.unsent.claimId === claimId) return;
      manual.unsent = { claimId: claimId, at: Date.now() };
    }

    // 서버가 '진행 중'이라고 할 때 보내지 못한 결과에 맞는 문구: "own"(서버가 준 진행 중 요청 id 가 이 요청) ·
    // "maybe"(서버가 누구 것인지 알려 주지 않았고, 처음 보내지 못한 뒤 150초 안이라 이 요청일 수도 있음) · ""(해당 없음).
    // 서버는 확인 뒤 150초까지만 그 확인을 '진행 중'으로 세고 보내기 실패는 확인 뒤에 오므로, 처음 실패 뒤 150초가 지나면
    // 이 요청은 더는 '진행 중'이 아니다 → 다른 확인(일반 문구). 시각만 보고 본인 확인이라고 하지는 않는다(2026-10-23 재검사 2차).
    function unsentBusyView() {
      var unsent = state.manual.unsent;
      if (!unsent) return "";
      var mine = manualBusyMine(state.manual.server, unsent.claimId);
      if (mine !== null) return mine ? "own" : "";
      var age = Date.now() - Number(unsent.at || 0);
      return age >= 0 && age < MANUAL_LOST_BUSY_MS ? "maybe" : "";
    }

    function currentManualView() {
      var manual = state.manual;
      var busy = Boolean(manual.server && manual.server.state === "busy");
      var unsentView = busy ? unsentBusyView() : "";
      var ownUnsent = unsentView === "own";
      var unsentMaybe = unsentView === "maybe";
      var ownLost = busy && !unsentView ? ownLostActive() : false;
      return manualView({
        server: manual.server,
        now: manualNow(),
        hello: manual.hello,
        run: manual.run,
        stopDetail: manual.stopDetail,
        ownPending: busy && !ownLost && !unsentView ? ownPendingActive() : false,
        ownLost: ownLost,
        ownUnsent: ownUnsent,
        unsentMaybe: unsentMaybe,
        userAgent: userAgentText()
      });
    }

    function manualButtonTitle(view) {
      if (state.manual.all) return "전체 확인이 진행 중이라 카드의 '지금 확인'은 막아 두었습니다(위 상태판의 '멈추기'로 멈출 수 있습니다)";
      if (view.enabled) return "누르면 이 크롬이 새 시크릿 창으로 쿠팡 검색 1쪽을 한 번 열어 순위를 확인합니다";
      if (view.kind === "busy_other") return "다른 확인이 끝나기를 기다리는 중입니다";
      if (view.countdown && view.state === "busy") return "방금 확인이 끝나기를 기다리는 중입니다";
      if (view.countdown) return "검색 사이 간격을 기다리는 중입니다";
      return "지금은 확인할 수 없습니다(위 '지금 확인' 상태판 참고)";
    }

    // 카드 '지금 확인'(주 버튼). 버튼 글자가 곧 상태다('지금 확인' / '1분 58초 뒤' / '확인 중…' / '내일 09:00').
    // 오늘 이미 확인한 카드는 테두리 모양(is-done)으로 두어 남색 주 버튼이 '오늘 아직'인 카드에만 남게 한다.
    function manualCardButton(tracker, view, todayKst) {
      var running = state.manual.run;
      var position = allQueuePosition(tracker);
      var mine = Boolean(running && running.trackerId === tracker.id) || position === 0;
      var done = checkedToday(tracker, todayKst);
      return button(manualCardLabel(position, view, mine, state.manual.server, manualNow()), "manual-check", {
        className: "mi-link-button mi-coupang-rank-manual-button" + (done ? " is-done" : "") + (mine ? " is-running" : ""),
        "data-coupang-rank-id": tracker.id,
        "data-coupang-rank-manual": true,
        title: manualButtonTitle(view),
        disabled: !view.enabled || Boolean(running) || state.busy || Boolean(state.manual.all)
      });
    }

    // 전체 확인 대기열에서 이 카드 키워드의 차례: 0 = 지금 확인 중, n = 대기 n번째(1 = 다음), -1 = 대기열에 없음(또는 대기열 없음).
    function allQueuePosition(tracker) {
      var queue = state.manual.all;
      if (!queue || !tracker) return -1;
      var key = keywordKeyOf(tracker);
      var position = 0;
      for (var index = queue.index; index < queue.items.length; index += 1) {
        var item = queue.items[index];
        if (item.status === "run") {
          if (item.key === key) return 0;
          continue;
        }
        if (item.status !== "wait") continue;
        position += 1;
        if (item.key === key) return position;
      }
      return -1;
    }

    // 카드 버튼 글자: 전체 확인 중이면 '확인 중…' · '대기 n번째' · '전체 확인 중'(대기열 밖 카드), 아니면 예전 글자(manualButtonLabel).
    function manualCardLabel(position, view, mine, server, now) {
      if (state.manual.all) {
        if (mine || position === 0) return "확인 중…";
        if (position > 0) return "대기 " + position + "번째";
        return "전체 확인 중";
      }
      return manualButtonLabel(view, mine, server, now);
    }

    function setText(node, text) {
      if (node.textContent !== text) node.textContent = text;
    }

    function syncManualButtons(view) {
      if (!shell) return;
      var running = state.manual.run;
      var server = state.manual.server;
      var now = manualNow();
      var title = manualButtonTitle(view);
      var active = typeof document !== "undefined" && document ? document.activeElement : null;
      var queued = Boolean(state.manual.all);
      var byId = {};
      if (queued) trackers().forEach(function (tracker) { byId[tracker.id] = tracker; });
      Array.prototype.forEach.call(shell.list.querySelectorAll("[data-coupang-rank-manual]"), function (node) {
        var id = node.getAttribute("data-coupang-rank-id");
        var position = queued ? allQueuePosition(byId[id]) : -1;
        var mine = Boolean(running && running.trackerId === id) || position === 0;
        setText(node, manualCardLabel(position, view, mine, server, now));
        var off = !view.enabled || Boolean(running) || state.busy || queued;
        // 키보드로 누른 버튼이 꺼지면 포커스가 몸통으로 사라진다 → 그 카드에 맡기고, 다시 그릴 때 버튼으로 돌린다.
        if (off && !node.disabled && active === node) parkFocusOnCard(node.closest ? node.closest("[data-coupang-rank-card]") : null, focusKey(node));
        node.disabled = off;
        node.classList.toggle("is-running", mine);
        if (node.getAttribute("title") !== title) node.setAttribute("title", title);
      });
    }

    // '오늘 확인한 상품' 칸의 아래 줄: 안 한 상품이 있으면 '안 한 상품 N개 보기'('오늘 안 함' 필터) 단추를 둔다.
    function renderTodayNote(metric) {
      var node = shell.manualMetrics.today.note;
      var key = metric.pending + "|" + metric.note;
      if (node.getAttribute("data-coupang-rank-note-key") === key) return;
      node.setAttribute("data-coupang-rank-note-key", key);
      node.replaceChildren();
      if (metric.pending > 0) {
        node.appendChild(button("안 한 상품 " + metric.pending + "개 보기", "filter-today-none", { className: "mi-coupang-rank-text-button", "data-coupang-rank-manual-today": true }));
        if (metric.paused) node.appendChild(document.createTextNode(" · 일시중지 " + metric.paused + "개 빼고"));
      } else if (metric.note) {
        node.appendChild(document.createTextNode(metric.note));
      }
    }

    // 지금 확인 상태판. 꺼져 있어도(off) 본문에 남겨 '꺼짐'과 '지금 확인 켜기'를 보인다. 서버 SQL 전·서버 칸 없음이면 숨긴다.
    // 1초 초 세기(간격·진행 중)는 이 함수를 다시 부른다 — 글자만 바꾸고 목록은 다시 그리지 않는다.
    function renderManual() {
      if (!shell || state.destroyed) return;
      var box = shell.manualBox;
      if (!manualBoardVisible()) {
        box.hidden = true;
        stopManualTicker();
        return;
      }
      var view = currentManualView();
      var model = manualBoardModel({ view: view, server: state.manual.server, now: manualNow(), trackers: trackers(), todayKst: todayKstValue(), autoState: autoMode(), autoCode: collectorStateName() });
      box.hidden = false;
      box.setAttribute("data-coupang-rank-manual-kind", model.kind);
      // 전체 확인 중: 알약은 '전체 확인 n / N', 다음 건을 기다리는 동안 한 줄은 경고 문장(확인 중 단계는 지금 확인 경고 그대로).
      var queue = state.manual.all;
      if (queue) {
        model.pill = { text: "전체 확인 " + allNumber(queue) + " / " + queue.items.length, tone: "is-wait" };
        if (queue.phase === "wait" && !model.banner) {
          model.line = MANUAL_ALL_WAIT_TEXT;
          model.lineTone = "";
        }
      }
      setText(shell.manualPill, model.pill.text);
      shell.manualPill.className = "mi-rank-auto-status mi-coupang-rank-manual-pill" + (model.pill.tone ? " " + model.pill.tone : "");
      shell.manualLine.hidden = model.banner;
      setText(shell.manualLine, model.banner ? "" : model.line);
      shell.manualLine.classList.toggle("is-warn", model.lineTone === "is-warn");
      shell.manualBanner.hidden = !model.banner;
      setText(shell.manualBanner, model.bannerText);
      ["next", "used", "today"].forEach(function (key) {
        var metric = model.metrics[key];
        var node = shell.manualMetrics[key];
        setText(node.label, metric.label);
        setText(node.value, metric.value);
        var className = "mi-rank-auto-metric" + (metric.tone ? " " + metric.tone : "");
        if (node.box.className !== className) node.box.className = className;
        if (key !== "today") setText(node.note, metric.note);
      });
      renderTodayNote(model.metrics.today);
      var enable = model.toggle === "enable";
      shell.manualToggle.setAttribute("data-coupang-rank-action", enable ? "manual-enable" : "manual-disable");
      setText(shell.manualToggle, enable ? "지금 확인 켜기" : "지금 확인 끄기");
      var toggleClass = enable ? "mi-button" : "mi-button subtle";
      if (shell.manualToggle.className !== toggleClass) shell.manualToggle.className = toggleClass;
      shell.manualToggle.disabled = state.manual.toggling === true;
      setText(shell.manualToggleHint, enable ? "켜기 전에 확인 창이 뜹니다" : "누르면 바로 멈춥니다");
      shell.manualGuideButton.hidden = !model.guide;
      shell.manualJump.hidden = !model.jump || shell.owner.hidden;
      renderManualAll(view);
      var note = state.manual.note;
      shell.manualNote.hidden = !note.text;
      setText(shell.manualNote, note.text);
      shell.manualNote.classList.toggle("is-ok", note.tone === "is-ok");
      shell.manualNote.classList.toggle("is-warn", note.tone === "is-warn");
      // 직전 확인 결과는 늘 여기 한 줄에 남는다(누른 카드가 필터·접힌 그룹에 가려도, 보내지 못함처럼 할 일이 있는 결과도).
      // 그날 중지 띠가 같은 말을 하고 있으면 겹쳐 보이지 않는다.
      var result = state.manual.result;
      shell.manualResult.hidden = !result || (model.banner && result.stopped === true);
      if (result) {
        setText(shell.manualResult, "직전 확인" + (result.clock ? "(" + result.clock + ")" : "") + ": " + result.text);
        shell.manualResult.classList.toggle("is-ok", result.tone === "is-ok");
        shell.manualResult.classList.toggle("is-warn", result.tone === "is-warn");
      }
      // 화면 읽기 프로그램에는 상태 알약이 바뀔 때만 알린다(초 세기는 알리지 않는다). 시크릿 창이 열리는 단계(check)와
      // 응답이 늦을 때는 경고 문장(창을 닫거나 누르거나 내리지 말고, 이 화면도 닫지 말기)을 한 번 함께 읽는다.
      var running = state.manual.run;
      var warnPhase = model.kind === "run" && running && running.phase === "check" ? (running.slow ? "|slow" : "|check") : "";
      var pillChanged = state.manual.announced !== model.pill.text;
      var warnChanged = Boolean(warnPhase) && state.manual.announcedWarn !== warnPhase;
      if (pillChanged || warnChanged) {
        state.manual.announced = model.pill.text;
        // 전체 확인 중의 차례 바뀜은 진행 줄(aria-live)이 읽는다. 여기서는 경고 문장만 읽는다(같은 말을 두 번 읽지 않게).
        if (warnPhase || !queue) setText(shell.manualAnnounce, "지금 확인 상태: " + (warnPhase ? model.line : model.pill.text));
      }
      state.manual.announcedWarn = warnPhase;
      syncManualButtons(view);
      var visibleNow = !(typeof document !== "undefined" && document.hidden) && isHostVisible();
      if (view.countdown && visibleNow) startManualTicker();
      else stopManualTicker();
      scheduleManualBusyRefresh();
    }

    function startManualTicker() {
      if (manualTimer || state.destroyed) return;
      manualTimer = setInterval(function () {
        if (state.destroyed || !shell || (typeof document !== "undefined" && document.hidden) || !isHostVisible()) {
          stopManualTicker();
          return;
        }
        renderManual();
      }, MANUAL_TICK_MS);
      if (manualTimer && typeof manualTimer.unref === "function") manualTimer.unref();
    }

    function stopManualTicker() {
      if (manualTimer) {
        clearInterval(manualTimer);
        manualTimer = 0;
      }
    }

    // 서버가 '다른 확인이 진행 중'이라고 하면, 그 확인이 끝날 시각 + 2초에 목록을 한 번만 다시 받는다.
    function scheduleManualBusyRefresh() {
      var manual = state.manual;
      var server = manual.server;
      if (!server || server.state !== "busy" || manual.run) return;
      var until = Date.parse(server.busyUntil);
      if (!isFinite(until)) return;
      var key = String(server.busyUntil);
      if (manual.busyRefreshFor === key) return;
      manual.busyRefreshFor = key;
      var owner = state;
      setTimeout(function () {
        if (owner !== state || state.destroyed) return;
        loadList();
      }, Math.max(0, until - manualNow()) + MANUAL_BUSY_REFRESH_PAD_MS);
    }

    // 확장 hello(30초 캐시). force 면 새로 묻는다. 결과는 { status: ok|missing|invalid|rejected|noid, … }.
    function refreshHello(force) {
      var manual = state.manual;
      var id = manualExtensionId();
      if (!id) {
        var changed = !manual.hello || manual.hello.status !== "noid";
        manual.hello = { status: "noid", at: Date.now(), id: "" };
        if (changed) {
          renderManual();
          renderManualOwner();
        }
        return Promise.resolve(manual.hello);
      }
      var cached = manual.hello;
      var age = cached ? Date.now() - cached.at : Infinity;
      if (!force && cached && cached.status !== "pending" && cached.id === id && age >= 0 && age < MANUAL_HELLO_CACHE_MS) return Promise.resolve(cached);
      if (manual.helloFlight && manual.helloFlight.id === id) return manual.helloFlight.promise;
      var owner = state;
      if (!cached || cached.id !== id) manual.hello = { status: "pending", at: Date.now(), id: id };
      var promise = Promise.resolve().then(function () {
        return deps.extensionBridge.send(id, { type: MANUAL_HELLO_TYPE }, MANUAL_HELLO_TIMEOUT_MS);
      }).then(parseHelloReply, function () {
        return { status: "missing" };
      }).then(function (hello) {
        hello.at = Date.now();
        hello.id = id;
        if (owner !== state) return hello;
        if (manual.helloFlight && manual.helloFlight.promise === promise) manual.helloFlight = null;
        manual.hello = hello;
        renderManual();
        renderManualOwner();
        return hello;
      });
      manual.helloFlight = { id: id, promise: promise };
      return promise;
    }

    function ensureManualHello() {
      if (state.destroyed || !manualVisible() || !isHostVisible()) return;
      refreshHello(false).then(function (hello) {
        return resumeManualPending(hello);
      }).catch(function () {});
    }

    function onManualVisibility() {
      if (state.destroyed || !shell) return;
      if (typeof document !== "undefined" && document.hidden) {
        stopManualTicker();
        return;
      }
      // 전체 확인: 숨은 탭에서 늦어진 재확인을 바로 한 번 한다(절대 시각으로 보므로 앞당기지 않는다).
      if (state.manual.all && state.manual.all.phase === "wait") allTick();
      if (!manualVisible() || !isHostVisible()) return;
      renderManual();
      ensureManualHello();
    }

    // 지금 확인 요청. 범위가 바뀌어도 결과를 버리지 않는다(쿠팡 검색은 이미 끝났을 수 있다).
    // 반환: { payload, httpStatus, transport(연결 실패·시간 초과) }
    async function postManual(body, timeoutMs, scope) {
      var target = scope || currentScope();
      try {
        var response = await deps.fetch(API_PATH, {
          method: "POST",
          cache: "no-store",
          headers: requestHeaders(target, { "content-type": "application/json" }),
          body: JSON.stringify(body),
          timeoutMs: timeoutMs
        });
        var payload = await readJson(response);
        return { payload: payload, httpStatus: response && isNum(response.status) ? response.status : 0, transport: false };
      } catch (error) {
        return { payload: { ok: false }, httpStatus: 0, transport: true };
      }
    }

    function manualRetryable(result) {
      return Boolean(result && (result.transport || result.httpStatus >= 500));
    }

    // 서버가 '끝난 일'로 답했는지(다시 보내도 같은 답). 연결 실패·5xx·로그인 풀림이면 남겨 두고 다시 보낸다.
    function manualRecordFinal(result) {
      if (!result || manualRetryable(result)) return false;
      var payload = result.payload || {};
      if (result.httpStatus === 401 || payload.code === "SESSION_REQUIRED" || payload.code === "COUPANG_SESSION_REQUIRED") return false;
      return payload.ok === true || Boolean(payload.code);
    }

    async function postManualRecord(body, scope, owner) {
      var attempt = await postManual(body, MANUAL_RECORD_TIMEOUT_MS, scope);
      for (var index = 0; index < MANUAL_RECORD_RETRY_MS.length && manualRetryable(attempt); index += 1) {
        await wait(MANUAL_RECORD_RETRY_MS[index]);
        if (owner && owner !== state) break;
        attempt = await postManual(body, MANUAL_RECORD_TIMEOUT_MS, scope);
      }
      return attempt;
    }

    // 결과는 두 곳에 보인다: 상태판의 '직전 확인' 한 줄(늘 — 누른 카드가 필터·접힌 그룹에 가려 있거나 추적 id 를 모르는 경우에도)과,
    // 누른 카드 운영줄 첫 칸의 짧은 표시(card = { trackerId?, text, tone }). 맨 위 상태줄에는 겹쳐 쓰지 않는다.
    // 누른 카드는 서버 응답의 tracker.trackerId 를 먼저, 없으면 이 화면이 누른 카드 id 를 쓴다. 상태 필터에서 빠져도 목록에 남긴다.
    function finishManualRun(text, tone, reload, stopped, card) {
      var manual = state.manual;
      var pressedId = manual.run && manual.run.trackerId || "";
      manual.run = null;
      manual.resuming = false;
      var clock = kstClock(new Date(manualNow()).toISOString());
      manual.result = { text: text, tone: tone || "", stopped: stopped === true, clock: clock };
      var targetId = card && card.trackerId || pressedId;
      // 확인을 시작하지 않은 결과(간격·서버 거절·확장 막힘 등)는 '방금 확인'이 아니라 '방금 누름'으로 쓴다.
      var head = card && card.notStarted === true ? "방금 누름" : "방금 확인";
      if (card && card.text && targetId) setCardNote(targetId, head + (clock ? " " + clock : "") + " · " + card.text, card.tone || tone || "");
      renderAll();
      if (reload) loadList({ afterWrite: true });
    }

    function parsedFromReport(report) {
      var body = report || {};
      return { outcome: body.outcome, page: body.page || null, code: body.outcomeCode || "" };
    }

    // 서버가 결과를 받았으면(받음·중복·기한 지남 등 끝난 답) 확장에 남겨 둔 결과를 지우게 한다. 검색이 아니다.
    function sendManualAck(claimId) {
      var id = manualExtensionId();
      if (!id || !claimId) return;
      Promise.resolve().then(function () {
        return deps.extensionBridge.send(id, { type: MANUAL_ACK_TYPE, claimId: claimId }, MANUAL_HELLO_TIMEOUT_MS);
      }).catch(function () {});
    }

    function settleManualRecord(recorded, parsed, claim, prefix) {
      var manual = state.manual;
      var payload = recorded && recorded.payload || {};
      if (payload.manual) setManualServer(payload.manual);
      if (manualRecordFinal(recorded)) {
        clearPending(claim.claimId);
        manual.settled[claim.claimId] = true;
        manual.resumePolls = 0;
        if (manual.unsent && manual.unsent.claimId === claim.claimId) manual.unsent = null;
        if (parsed && parsed.outcome === "measured") sendManualAck(claim.claimId);
        // 30초 캐시의 hello 가 아직 이 결과를 들고 있다고 하면 지운다(다시 보내거나 다시 ack 하지 않게).
        if (manual.hello && manual.hello.pending && manual.hello.pending.claimId === claim.claimId) manual.hello.pending = null;
      } else {
        // 방금 보내지 못했다. 화면을 다시 열거나 탭이 다시 보일 때(30초 뒤부터) 저절로 다시 보낸다.
        manual.resumeTriedAt[claim.claimId] = Date.now();
        // 서버가 그동안 이 확인을 '진행 중'으로 세는 사이 상태 줄이 '다른 확인'이라고 단정하지 않게 요청 id 로 기억한다.
        rememberUnsent(claim.claimId);
      }
      var outcome = manualRecordText(recorded, parsed, claim.keyword, manual.server);
      if (outcome.stopped) {
        manual.stopDetail = outcome.detail || "";
        // 서버가 그날 중지를 걸었다고 답했다. 옛 manual 칸이면 띠를 바로 보이고, 목록을 다시 받아 서버 값으로 맞춘다.
        if (payload.stopped === true && manual.server && manual.server.state !== "stopped") {
          manual.server = Object.assign({}, manual.server, { state: "stopped", stoppedDay: kstDayAt(manualNow()), stoppedAt: new Date(manualNow()).toISOString() });
        }
      }
      var cardNote = manualCardNote(outcome, recorded, parsed);
      var recordedId = payload.tracker && typeof payload.tracker.trackerId === "string" ? payload.tracker.trackerId : "";
      cardNote.trackerId = recordedId || claim.trackerId || "";
      finishManualRun((prefix || "") + outcome.text, outcome.tone, true, outcome.stopped === true, cardNote);
      return outcome;
    }

    // 보내지 못한 결과 찾기: 이 브라우저에 남긴 결과 → 확장이 서버에 보내기 전까지 들고 있는 결과(hello.pending,
    // 탭을 닫았거나 다른 탭에서 받은 확인이어도 토큰과 함께 있다). 이미 보낸 결과면 확장에 지우라고만 알린다.
    function manualResumeCandidate(hello) {
      var manual = state.manual;
      var pending = readPending();
      if (pending && manual.settled[pending.claimId]) {
        clearPending(pending.claimId);
        pending = null;
      }
      if (pending && pending.report) return { claim: pending, body: pending.report, parsed: parsedFromReport(pending.report) };
      var held = hello && hello.status === "ok" ? hello.pending : null;
      if (held && held.reply) {
        if (manual.settled[held.claimId]) return { ackOnly: held.claimId };
        var mine = pending && pending.claimId === held.claimId ? pending : null;
        var token = held.claimToken || (mine ? mine.claimToken : "");
        var parsedHeld = parseCheckReply({ ok: true, reply: held.reply });
        if (token && parsedHeld.outcome !== "lost") {
          var claim = {
            claimId: held.claimId,
            claimToken: token,
            trackerId: mine ? mine.trackerId : "",
            keyword: mine ? mine.keyword : (typeof held.reply.keyword === "string" ? held.reply.keyword : ""),
            savedAt: mine ? mine.savedAt : Date.now()
          };
          return { claim: claim, body: manualRecordBody(claim, parsedHeld, hello), parsed: parsedHeld };
        }
      }
      if (pending && hello && hello.status === "ok" && hello.busy) return { wait: true };
      return null;
    }

    async function resumeManualPending(hello) {
      var manual = state.manual;
      if (manual.run || manual.resuming || !manualVisible()) return;
      var candidate = manualResumeCandidate(hello);
      if (!candidate) return;
      var owner = state;
      if (candidate.ackOnly) {
        sendManualAck(candidate.ackOnly);
        return;
      }
      if (candidate.wait) {
        // 확장이 아직 그 확인을 하는 중이다. 15초 뒤 다시 묻는다(한 번에 하나, 최대 40번).
        if (manual.resumePollScheduled || manual.resumePolls >= MANUAL_RESUME_POLL_MAX) return;
        manual.resumePolls += 1;
        manual.resumePollScheduled = true;
        setTimeout(function () {
          if (owner !== state || state.destroyed) return;
          manual.resumePollScheduled = false;
          refreshHello(true).then(function (next) { return resumeManualPending(next); }).catch(function () {});
        }, MANUAL_RESUME_POLL_MS);
        return;
      }
      var key = candidate.claim.claimId;
      var tried = manual.resumeTriedAt[key];
      if (tried && Date.now() - tried >= 0 && Date.now() - tried < MANUAL_RESUME_GAP_MS) return;
      manual.resumeTriedAt[key] = Date.now();
      manual.resuming = true;
      manual.run = { trackerId: candidate.claim.trackerId || "", keyword: candidate.claim.keyword || "", phase: "record", resumed: true };
      renderManual();
      var recorded = await postManualRecord(candidate.body, currentScope(), owner);
      if (owner !== state) return;
      settleManualRecord(recorded, candidate.parsed, candidate.claim, "앞서 끝나지 않은 확인 결과를 보냈습니다. ");
    }

    // 카드 '지금 확인'(사람이 누를 때만)과 상태판 '전체 확인'(사람이 누른 뒤 키워드마다 한 번씩)이 함께 쓴다.
    // 확장에 check 를 보내는 곳은 이 함수 하나다. 반환값은 끝난 단계({ step: skip·gone·preflight·resend·claim·record, … })이고 요청 모양에는 영향이 없다.
    async function startManualCheck(trackerId) {
      var manual = state.manual;
      if (manual.run || manual.resuming || state.busy || !manualVisible() || cleanupMode()) return { step: "skip" };
      var tracker = findTracker(trackerId);
      if (!tracker || tracker.status !== "active") return { step: "skip" };
      var owner = state;
      var scope = currentScope();
      var keyword = String(tracker.keyword || "");
      manual.run = { trackerId: trackerId, keyword: keyword, phase: "hello", slow: false };
      manual.result = null;
      manual.lost = null;
      manual.note = { text: "", tone: "" };
      // 앞선 동작이 남긴 맨 위 상태줄(등록 결과 등)은 지운다. 이 확인의 결과는 상태판 '직전 확인' 줄에 쓴다.
      if (state.status.text) setStatus("", "");
      renderManual();
      // 1. 누르기 직전에 확장 상태를 새로 묻는다. 막히면 서버 요청 없이 끝낸다(횟수도 쓰지 않는다).
      var hello = await refreshHello(true);
      if (owner !== state) return { step: "gone" };
      var blocked = manualPreflightText(hello, manual.server, userAgentText());
      if (blocked) {
        finishManualRun(blocked, "is-warn", false, false, { text: "시작하지 않음 · 쿠팡 검색 안 함", tone: "is-warn", notStarted: true });
        return { step: "preflight" };
      }
      // 2. 앞서 보내지 못한 결과(이 브라우저에 남긴 것 · 확장이 들고 있는 것)가 있으면 먼저 보낸다.
      //    차단 보고가 새 검색보다 먼저 서버에 닿아야 한다. 보냈으면 새 확인은 대표가 다시 누를 때 한다.
      var earlier = manualResumeCandidate(hello);
      if (earlier && earlier.ackOnly) sendManualAck(earlier.ackOnly);
      if (earlier && earlier.body) {
        manual.run.phase = "record";
        manual.run.resumed = true;
        renderManual();
        var resent = await postManualRecord(earlier.body, scope, owner);
        if (owner !== state) return { step: "gone" };
        if (!manualRecordFinal(resent)) {
          rememberUnsent(earlier.claim.claimId);
          finishManualRun("앞서 보내지 못한 확인 결과를 먼저 보내야 하는데 아직 보내지 못했습니다(인터넷 연결 확인). 새 확인은 시작하지 않았고, 쿠팡 검색도 하지 않았습니다.", "is-warn", false, false,
            { text: "앞 결과를 먼저 보내야 해 시작하지 않음", tone: "is-warn", notStarted: true });
          return { step: "resend", ok: false };
        }
        var resentOutcome = settleManualRecord(resent, earlier.parsed, earlier.claim, "앞서 끝나지 않은 확인 결과를 먼저 보냈습니다. 새 확인은 다시 눌러 주세요. ");
        return { step: "resend", ok: true, stopped: resentOutcome.stopped === true };
      }
      // 3. 서버 1회용 확인(간격·하루 상한·시간·그날 중지는 서버가 서버 시각으로 정한다)
      manual.run.phase = "claim";
      renderManual();
      var claimed = await postManual({ action: "manual-claim", trackerId: trackerId }, MANUAL_CLAIM_TIMEOUT_MS, scope);
      if (owner !== state) return { step: "gone" };
      var claim = claimed.payload || {};
      if (claim.manual) setManualServer(claim.manual);
      if (claim.ok !== true || typeof claim.claimId !== "string" || !claim.claimId || typeof claim.claimToken !== "string" || !claim.claimToken) {
        finishManualRun(manualClaimRefusalText(claimed, manual.server), "is-warn", false, false, { text: "시작하지 않음 · 쿠팡 검색 안 함", tone: "is-warn", notStarted: true });
        return { step: "claim", code: typeof claim.code === "string" ? claim.code : "", transport: claimed.transport === true, httpStatus: claimed.httpStatus,
          retryAfterSec: isNum(claim.retryAfterSec) ? claim.retryAfterSec : null };
      }
      var record = { claimId: claim.claimId, claimToken: claim.claimToken, trackerId: trackerId, keyword: String(claim.keyword || keyword), savedAt: Date.now() };
      writePending(record);
      // 4. 확장에 맡긴다. 확장은 창을 열기 전에 이 확인(claimId·claimToken)이 유효한지 서버에 직접 확인받는다.
      manual.run.phase = "check";
      renderManual();
      var slowTimer = setTimeout(function () {
        if (owner === state && manual.run && manual.run.phase === "check") {
          manual.run.slow = true;
          renderManual();
        }
      }, MANUAL_CHECK_SLOW_MS);
      var sent;
      try {
        sent = await deps.extensionBridge.send(manualExtensionId(), {
          type: MANUAL_CHECK_TYPE,
          claimId: record.claimId,
          claimToken: record.claimToken,
          keyword: record.keyword
        }, MANUAL_CHECK_GIVE_UP_MS);
      } catch (error) {
        sent = { ok: false, code: "extension_no_response" };
      }
      clearTimeout(slowTimer);
      var parsed = parseCheckReply(sent);
      record.report = manualRecordBody(record, parsed, hello);
      writePending(record);
      // 화면이 잠겼으면(로그아웃 등) 남긴 결과를 다음에 화면을 열 때 보낸다.
      if (owner !== state) return { step: "gone" };
      // 5. 결과를 서버에 보낸다(차단 신호면 서버가 그날 중지를 건다). 받으면 확장에 ack 를 보낸다.
      manual.run.phase = "record";
      renderManual();
      var recorded = await postManualRecord(record.report, scope, owner);
      if (owner !== state) return { step: "gone" };
      // 응답 없음이면 서버가 이 확인을 잠시 '진행 중'으로 센다. 그동안 상태 줄이 '다른 확인'이라고 하지 않게 기억한다.
      if (parsed.outcome === "lost") manual.lost = { claimId: record.claimId, at: Date.now() };
      var outcome = settleManualRecord(recorded, parsed, record, "");
      // 확장이 '보고 안 된 앞 결과가 있다'며 시작하지 않았으면 그 결과를 바로 보낸다(차단 보고가 먼저).
      if (parsed.outcome === "not_started" && parsed.code === "report_pending" && parsed.held) {
        resumeManualPending({ status: "ok", busy: false, pending: parsed.held }).catch(function () {});
      }
      // 확장이 답 없이 멈췄으면 한 번 깨워 남은 시크릿 창을 정리하게 한다(캐시 무시).
      if (parsed.outcome === "lost") refreshHello(true).catch(function () {});
      // 전체 확인이 이 결과로 다음 키워드로 갈지·멈출지 정한다(카드 한 번 누름에는 쓰지 않는다).
      return { step: "record", outcome: parsed.outcome, final: manualRecordFinal(recorded), payload: recorded && recorded.payload || {}, stopped: outcome.stopped === true };
    }

    function runManualCheck(trackerId) {
      // 전체 확인 중에는 카드 '지금 확인'을 막는다(겹침 방지 — 버튼도 꺼져 있다).
      if (state.manual.all) return;
      startManualCheck(trackerId).catch(function () {
        if (state.destroyed) return;
        state.manual.run = null;
        state.manual.resuming = false;
        setStatus("지금 확인 중 화면 오류가 났습니다. 화면을 새로고침한 뒤 다시 눌러 주세요.", "is-warn");
        renderAll();
      });
    }

    // ── 전체 확인(대표 승인 2026-10-24) ──
    // 상태판 '전체 확인' → 확인 창 → 대기열(오늘 아직 확인 안 한 활성 상품의 키워드, 화면 차례, 오늘 남은 횟수만큼) →
    // 키워드마다 startManualCheck 한 번(카드 한 번 누름과 같은 요청) → 서버 간격(nextAt) + 2초가 지나면 다음 키워드. 1초마다 절대 시각으로 다시 본다.

    // 지금 대기열의 차례(1부터, 진행 중이거나 다음에 할 키워드).
    function allNumber(queue) {
      return Math.min(queue.index + 1, queue.items.length);
    }

    // 시작 전 판단: { reason(못 누르는 사유), plan, take, shortage, remaining, hint }
    function allCheckInfo(view) {
      var server = state.manual.server || {};
      var plan = manualAllPlan(trackers(), todayKstValue());
      var projected = manualProjected(server, manualNow());
      var remaining = Math.max(0, projected.max - projected.used);
      var cut = manualAllTake(plan, remaining);
      var reason = manualAllBlock({
        view: view, keywords: plan.items.length, remaining: remaining, busy: state.busy, cleanup: cleanupMode(),
        running: Boolean(state.manual.run) || state.manual.resuming === true
      });
      return { reason: reason, plan: plan, take: cut.take, shortage: cut.shortage, remaining: remaining, hint: reason || manualAllHint(cut.take, cut.shortage, server) };
    }

    // 상태판의 전체 확인 자리(버튼·작은 글·진행 줄·끝 요약). renderManual 이 부른다(1초 초 세기 포함).
    function renderManualAll(view) {
      var manual = state.manual;
      var queue = manual.all;
      var allButton = shell.allButton;
      shell.allBlock.hidden = !queue && !manualVisible();
      if (queue) {
        var stopping = queue.phase === "stopping";
        allButton.setAttribute("data-coupang-rank-action", "manual-all-stop");
        setText(allButton, stopping ? "멈추는 중…" : "멈추기");
        var stopClass = "mi-button subtle mi-coupang-rank-all-button is-stop";
        if (allButton.className !== stopClass) allButton.className = stopClass;
        allButton.disabled = stopping;
        allButton.setAttribute("title", "남은 키워드를 취소합니다(이미 진행 중인 1건은 끝까지 기록합니다)");
        var waiting = queue.items.filter(function (item) { return item.status === "wait"; }).length;
        setText(shell.allHint, stopping ? "진행 중인 1건은 끝까지 기록" : (waiting ? "남은 키워드 " + waiting + "개 취소" : "누르면 바로 멈춥니다"));
        shell.allHint.classList.remove("is-warn");
      } else if (manualVisible()) {
        var info = allCheckInfo(view);
        allButton.setAttribute("data-coupang-rank-action", "manual-all-start");
        setText(allButton, "전체 확인");
        var startClass = "mi-button mi-coupang-rank-all-button";
        if (allButton.className !== startClass) allButton.className = startClass;
        allButton.disabled = Boolean(info.reason) || manual.toggling === true;
        allButton.setAttribute("title", info.reason
          ? "지금은 전체 확인을 할 수 없습니다: " + info.reason
          : "오늘 아직 확인 안 한 상품을 키워드마다 한 번씩 차례로 확인합니다(누르면 확인 창이 뜹니다)");
        setText(shell.allHint, info.hint);
        shell.allHint.classList.toggle("is-warn", !info.reason && info.shortage > 0);
      }
      // 진행 줄
      shell.allProgress.hidden = !queue;
      if (queue) {
        var item = queue.items[Math.min(queue.index, queue.items.length - 1)] || null;
        var step = "전체 확인 " + allNumber(queue) + " / " + queue.items.length + (item && item.keyword ? " · '" + item.keyword + "'" : "");
        if (queue.phase === "stopping") step += " · 멈추는 중(진행 중인 1건은 끝까지 기록합니다)";
        setText(shell.allStep, step);
        setText(shell.allCountdown, allCountdownText(queue));
      } else {
        setText(shell.allStep, "");
        setText(shell.allCountdown, "");
      }
      var summary = manual.allSummary;
      shell.allSummary.hidden = Boolean(queue) || !summary;
      setText(shell.allSummary, !queue && summary ? summary.text : "");
      shell.allSummary.classList.toggle("is-ok", Boolean(summary) && summary.tone === "is-ok");
      shell.allSummary.classList.toggle("is-warn", Boolean(summary) && summary.tone === "is-warn");
    }

    // 진행 줄 뒤쪽(aria-live 밖): 다음 확인까지 남은 시간(상태판 '다음 확인'과 같은 서버 근거) · 확인 중 · 곧 시작.
    function allCountdownText(queue) {
      if (queue.phase === "run") return " · 확인 중";
      if (queue.phase !== "wait") return "";
      var server = state.manual.server || {};
      var now = manualNow();
      var projected = manualProjected(server, now);
      if (projected.state === "gap" && projected.remainingMs > 0) return " · 다음 확인 " + countdownText(projected.remainingMs) + " 뒤";
      if (projected.state === "busy") return " · 다른 확인이 끝나기를 기다리는 중";
      return " · 곧 시작";
    }

    function manualAllStart() {
      var manual = state.manual;
      if (manual.all || state.destroyed || !manualVisible()) return;
      var view = currentManualView();
      var info = allCheckInfo(view);
      if (info.reason || !info.take) {
        renderManual();
        return;
      }
      var server = manual.server || {};
      var agreed = confirmAction(manualAllConfirmText({ plan: info.plan, take: info.take, shortage: info.shortage, remaining: info.remaining, server: server, now: manualNow() }));
      if (!agreed || manual.all || state.destroyed) return;
      var scope = currentScope();
      manual.all = {
        scopeKey: scope ? scope.key : "",
        items: info.plan.items.slice(0, info.take).map(function (item) {
          return { key: item.key, keyword: item.keyword, status: "wait", gapRetried: false };
        }),
        shortage: info.shortage,
        index: 0,
        phase: "wait",
        // 간격 거절 응답의 retryAfterSec 로 정한 '이 시각 전에는 누르지 않음'(서버 시각 기준 ms, 0 = 없음)
        notBefore: 0,
        resent: false,
        checked: 0,
        recorded: 0,
        failed: 0,
        skipped: 0,
        stopReason: ""
      };
      manual.allSummary = null;
      manual.note = { text: "", tone: "" };
      renderAll();
      allTick();
    }

    function scheduleAllTick() {
      if (allTimer) clearTimeout(allTimer);
      allTimer = setTimeout(function () {
        allTimer = 0;
        allTick();
      }, MANUAL_ALL_TICK_MS);
      if (allTimer && typeof allTimer.unref === "function") allTimer.unref();
    }

    function clearAllTimer() {
      if (allTimer) {
        clearTimeout(allTimer);
        allTimer = 0;
      }
    }

    // 다음 건 전에 대기열을 멈춰야 하는 화면 쪽 사유(화면 이동·잠김·대상 바뀜·지금 확인 꺼짐 등). 없으면 "".
    function allInterruptText(queue) {
      if (!isHostVisible()) return "화면을 옮기거나 화면이 잠겨 멈췄습니다";
      var scope = currentScope();
      if (!scope || scope.key !== queue.scopeKey) return "대상 광고주가 바뀌어 멈췄습니다";
      if (!manualVisible()) {
        var server = state.manual.server;
        return server && server.state === "off" ? "지금 확인이 꺼져 멈췄습니다" : "지금 확인을 쓸 수 없는 상태가 되어 멈췄습니다";
      }
      if (cleanupMode()) return "정리용 화면이 되어 멈췄습니다";
      return "";
    }

    // 이 키워드로 지금 확인할 카드(화면 차례로 첫 번째, 활성 · 오늘 아직). 없으면 null(일시중지·삭제·이미 오늘 확인 — 건너뛴다).
    function allTrackerFor(key) {
      var todayKst = todayKstValue();
      if (!todayKst) return null;
      var list = manualDisplayOrder(trackers());
      for (var index = 0; index < list.length; index += 1) {
        var tracker = list[index];
        if (tracker.status === "active" && keywordKeyOf(tracker) === key && !checkedToday(tracker, todayKst)) return tracker;
      }
      return null;
    }

    // 매 건 시작 직전에 대상을 다시 고른다. 할 카드가 없는 키워드는 건너뛴다.
    function allNextPick(queue) {
      while (queue.index < queue.items.length) {
        var item = queue.items[queue.index];
        var tracker = allTrackerFor(item.key);
        if (tracker) return { item: item, tracker: tracker };
        item.status = "skipped";
        queue.skipped += 1;
        queue.index += 1;
      }
      return null;
    }

    // 1초마다(그리고 시작·탭이 다시 보일 때) 부른다. 서버가 준 간격이 지났는지 절대 시각으로 다시 보고, 지났을 때만 다음 건을 시작한다.
    function allTick() {
      clearAllTimer();
      var manual = state.manual;
      var queue = manual.all;
      if (!queue || state.destroyed || queue.phase !== "wait") return;
      var interrupt = allInterruptText(queue);
      if (interrupt) {
        allEnd(queue, interrupt, queue.items[queue.index] || null);
        return;
      }
      var picked = allNextPick(queue);
      if (!picked) {
        allEnd(queue, "", null);
        return;
      }
      var server = manual.server || {};
      var now = manualNow();
      var projected = manualProjected(server, now);
      var serverStop = manualAllStateStopText(projected.state, server);
      if (serverStop) {
        allEnd(queue, serverStop, picked.item);
        return;
      }
      var nextAt = Date.parse(server.nextAt);
      var busyUntil = Date.parse(server.busyUntil);
      var waiting = projected.state !== "ready" ||
        (isFinite(nextAt) && now < nextAt + MANUAL_ALL_PAD_MS) ||
        (isFinite(busyUntil) && now < busyUntil + MANUAL_ALL_PAD_MS) ||
        (queue.notBefore > 0 && now < queue.notBefore) ||
        Boolean(manual.run) || manual.resuming === true || state.busy;
      if (waiting) {
        renderManual();
        scheduleAllTick();
        return;
      }
      allStartItem(queue, picked.item, picked.tracker);
    }

    function allStartItem(queue, item, tracker) {
      var owner = state;
      queue.phase = "run";
      queue.notBefore = 0;
      item.status = "run";
      startManualCheck(tracker.id).then(function (result) {
        allAfterRun(queue, item, result);
      }, function () {
        if (owner !== state || state.destroyed) return;
        state.manual.run = null;
        state.manual.resuming = false;
        setStatus("지금 확인 중 화면 오류가 났습니다. 화면을 새로고침한 뒤 다시 눌러 주세요.", "is-warn");
        allAfterRun(queue, item, { step: "error" });
      });
    }

    // 한 건이 끝난 뒤: 기록 성공이면 다음 키워드, 간격 거절 1번째면 같은 키워드를 다시 기다림, 그 밖은 멈춤.
    function allAfterRun(queue, item, result) {
      var manual = state.manual;
      if (manual.all !== queue || state.destroyed) return;
      var info = result || { step: "error" };
      if (info.step === "gone") return;
      var stopping = queue.phase === "stopping" ? (queue.stopReason || "멈추기를 눌러 멈췄습니다") : "";
      queue.phase = "wait";
      item.status = "wait";
      var stop = "";
      if (info.step === "record") {
        var verdict = manualAllRecordVerdict(info);
        queue.index += 1;
        if (verdict.success) {
          item.status = "done";
          queue.checked += 1;
          queue.recorded += verdict.matched;
        } else {
          item.status = "failed";
          queue.failed += 1;
          stop = verdict.reason;
        }
      } else if (info.step === "claim") {
        if (info.code === "COUPANG_MANUAL_GAP" && !info.transport && !item.gapRetried) {
          // 서버 간격으로 거절: 응답의 manual(nextAt)로 한 번만 다시 기다린다(쿠팡 검색 안 함 · 횟수 안 씀).
          // 응답에 manual 이 없어도 서버가 준 남은 초(retryAfterSec)만큼은 기다린다.
          item.gapRetried = true;
          if (isNum(info.retryAfterSec) && info.retryAfterSec > 0) queue.notBefore = manualNow() + info.retryAfterSec * 1000 + MANUAL_ALL_PAD_MS;
        } else if (info.code === "COUPANG_MANUAL_TRACKER_PAUSED" || info.code === "COUPANG_TRACKER_NOT_FOUND") {
          item.status = "skipped";
          queue.skipped += 1;
          queue.index += 1;
        } else {
          stop = manualAllClaimStopText(info, manual.server);
        }
      } else if (info.step === "resend") {
        if (info.ok && info.stopped) stop = MANUAL_ALL_BLOCKED_TEXT;
        else if (info.ok && !queue.resent) queue.resent = true;
        else stop = "앞서 보내지 못한 확인 결과를 먼저 보내지 못해 멈췄습니다(위 '직전 확인' 참고)";
      } else if (info.step === "preflight") {
        stop = "확장 확인이 필요해 멈췄습니다(위 '직전 확인' 참고)";
      } else if (info.step !== "skip") {
        stop = "화면 오류가 나 멈췄습니다. 화면을 새로고침해 주세요";
      }
      if (stop || stopping) {
        allEnd(queue, stop || stopping, item);
        return;
      }
      // 남은 키워드에 할 카드가 없으면(마지막까지 했거나 남은 것이 모두 건너뛸 것) 다음 재확인을 기다리지 않고 바로 끝낸다.
      // 시작 직전에는 다시 고른다(allTick).
      if (!allNextPick(queue)) {
        allEnd(queue, "", null);
        return;
      }
      renderManual();
      scheduleAllTick();
    }

    // '멈추기' · '지금 확인 끄기' · 대상 바뀜: 남은 대기열을 바로 취소한다. 진행 중인 1건은 지금 확인 규칙대로 끝까지 가고, 끝나면 요약을 쓴다.
    function allStop(reason) {
      var queue = state.manual.all;
      if (!queue || queue.phase === "stopping") return;
      if (queue.phase === "run") {
        queue.phase = "stopping";
        queue.stopReason = reason;
        queue.items.forEach(function (item) { if (item.status === "wait") item.status = "canceled"; });
        renderManual();
        syncManualButtons(currentManualView());
        return;
      }
      allEnd(queue, reason, queue.items[queue.index] || null);
    }

    function allEnd(queue, reason, atItem) {
      var manual = state.manual;
      if (manual.all !== queue) return;
      clearAllTimer();
      manual.all = null;
      var left = 0;
      queue.items.forEach(function (item) {
        if (item.status === "wait" || item.status === "canceled") {
          left += 1;
          item.status = "canceled";
        }
      });
      var position = atItem ? queue.items.indexOf(atItem) : -1;
      manual.allSummary = manualAllSummary({
        reason: reason,
        at: reason && position >= 0 ? { number: position + 1, keyword: atItem.keyword } : null,
        total: queue.items.length,
        checked: queue.checked,
        recorded: queue.recorded,
        failed: queue.failed,
        skipped: queue.skipped,
        left: left,
        shortage: queue.shortage
      });
      renderAll();
    }

    // 상태판의 '지금 확인 끄기·켜기'. 결과·오류는 상태판 안 한 줄(aria-live)에 쓴다(자동 수집 패널 문구 자리와 섞지 않는다).
    async function manualToggle(enable) {
      var manual = state.manual;
      if (manual.toggling) return;
      var server = manual.server || {};
      // 끄기는 전체 확인 대기열도 바로 멈춘다(진행 중인 1건은 끝까지 기록).
      if (!enable && manual.all) allStop("지금 확인을 꺼서 멈췄습니다");
      if (enable) {
        var max = isNum(server.maxPerDay) ? server.maxPerDay : 30;
        var agreed = confirmAction("'지금 확인'을 켭니다.\n총관리자 카드에 '지금 확인' 버튼이 보이고, 누를 때만 이 크롬이 새 시크릿 창으로 쿠팡 검색을 한 번 합니다(검색 사이 " +
          manualGapMinutes(server) + "분 · 하루 " + max + "번 · " + manualHours(server).text + ", 차단으로 보이는 화면이 나오면 그날 중지).\n내 크롬에 확장을 설치했나요? 켤까요?");
        if (!agreed) return;
      }
      manual.toggling = true;
      manual.note = { text: enable ? "지금 확인을 켜는 중입니다…" : "지금 확인을 끄는 중입니다…", tone: "" };
      var owner = state;
      // 끄기는 확인 창 없이 바로 숨긴다(비상 정지). 실패하면 목록을 다시 받아 서버 값으로 돌리고, 그 이유를 상태판에 남긴다.
      if (!enable && manual.server) manual.server = Object.assign({}, manual.server, { state: "off", enabled: false });
      renderAll();
      var result = await postAction({ action: "settings-update", settings: { manualEnabled: enable } });
      if (owner !== state) return;
      manual.toggling = false;
      if (result.ok) {
        if (result.settings && state.owner.data) state.owner.data.settings = result.settings;
        manual.note = { text: enable ? "지금 확인을 켰습니다. 카드마다 '지금 확인' 버튼이 보입니다." : "지금 확인을 껐습니다. 카드의 '지금 확인' 버튼이 사라지고, 서버도 새 확인을 받지 않습니다.", tone: "is-ok" };
      } else if (!result.stale) {
        manual.note = { text: (enable ? "켜지 못했습니다: " : "끄지 못해 원래 상태로 돌렸습니다: ") + errorText(result), tone: "is-warn" };
      } else {
        manual.note = { text: "", tone: "" };
      }
      await loadList({ afterWrite: true });
      if (owner === state) renderManual();
    }

    // 상태판의 '설치 안내 열기': 보조 상자의 '내 크롬 확장' 줄과 그 안의 설치 안내만 열고 그 자리로 옮긴다.
    function openManualGuide() {
      if (!shell) return;
      if (shell.ext.hidden) return;
      shell.ext.open = true;
      shell.manualGuide.open = true;
      // 펼친 뒤에 옮긴다(바로 부르면 브라우저가 펼침 중에 부드러운 스크롤을 멈춘다).
      var guide = shell.manualGuide;
      setTimeout(function () {
        if (state.destroyed || !guide || typeof guide.scrollIntoView !== "function") return;
        try { guide.scrollIntoView({ block: "start" }); } catch (error) {}
      }, 150);
    }

    function renderManualGuide(file, folder) {
      var guide = shell.manualGuide;
      var mark = (file || "-") + "|" + (folder || "-");
      if (guide.getAttribute("data-coupang-rank-manual-file") === mark && guide.childNodes.length) return;
      var wasOpen = guide.open;
      guide.replaceChildren();
      guide.setAttribute("data-coupang-rank-manual-file", mark);
      guide.appendChild(el("summary", {}, [el("strong", { text: "설치 안내" }), el("span", { text: "처음 한 번 · 업데이트 · 멈추기·지우기" })]));
      guide.appendChild(el("ol", { className: "mi-coupang-rank-manual-steps" }, manualGuideSteps(file, folder).map(function (parts) {
        return el("li", {}, parts.map(function (part) { return typeof part === "string" ? part : el("strong", { text: part.b }); }));
      })));
      guide.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "크롬 메뉴 이름은 버전에 따라 조금 다를 수 있습니다. 괄호 안 영어 이름과 위치로 찾아 주세요." }));
      guide.open = wasOpen;
    }

    // 보조 상자 '내 크롬 확장' 줄(spec-manual §7.5). 서버 manual 칸이 있을 때만 보인다. 켜기·끄기는 상태판에 있다.
    function renderManualOwner() {
      if (!shell) return;
      var section = shell.ownerManualSection;
      var server = state.manual.server;
      var visible = deps.mode === "admin" && isOwnerSession() && Boolean(currentScope()) && Boolean(server);
      shell.ext.hidden = !visible;
      if (!visible) {
        if (shell.ext.open) shell.ext.open = false;
        return;
      }
      var stateName = String(server.state || "");
      var setup = stateName === "setup_required";
      var on = !setup && stateName !== "off";
      var hello = state.manual.hello;
      var block = hello && hello.status !== "pending" ? manualHelloBlock(hello, server, userAgentText()) : null;
      var headPill;
      if (setup) headPill = ["SQL 전", "is-muted"];
      else if (!on) headPill = ["지금 확인 꺼짐", "is-muted"];
      else if (!hello || hello.status === "pending") headPill = ["확인 중", "is-muted"];
      else if (hello.status === "ok" && !block) headPill = ["정상", "is-ok"];
      else headPill = ["확인 필요", "is-warn"];
      shell.extState.textContent = headPill[0];
      shell.extState.className = "mi-coupang-rank-owner-state " + headPill[1];
      shell.extSummaryText.textContent = setup
        ? "대표 SQL(지금 확인) 실행 전입니다"
        : (on ? manualExtensionText(hello).replace(/^확장:\s*/, "") : "지금 확인이 꺼져 있어 확장에 묻지 않습니다") + " · 확장 내려받기 · 설치 안내";
      section.replaceChildren();
      section.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "누를 때만 이 크롬의 전용 확장이 새 시크릿 창으로 쿠팡 검색 1쪽을 한 번 열어 목록을 읽고 닫습니다('전체 확인'도 누를 때만, 키워드마다 한 번씩 차례로). 예약·자동 반복은 없습니다. 검색 사이 간격·하루 횟수·시간·차단 시 그날 중지는 서버가 지킵니다." }));
      var lines = [];
      if (setup) {
        lines.push("대표 SQL(지금 확인) 실행 전입니다. SQL 을 실행하면 위 상태판에 켜기 버튼이 생깁니다.");
      } else {
        var projected = manualProjected(server, manualNow());
        lines.push((on ? "켜짐" : "꺼짐 — 위 '지금 확인' 상태판에서 켤 수 있습니다") + " · 오늘 " + projected.used + "/" + projected.max + "번 · " +
          projected.hours.text + " · 검색 사이 " + manualGapMinutes(server) + "분");
        if (projected.state === "stopped") lines.push(manualStopText(server, state.manual.stopDetail));
      }
      lines.push(manualExtensionText(hello));
      section.appendChild(el("ul", { className: "mi-coupang-rank-owner-lines", "data-coupang-rank-manual-owner-lines": true }, lines.map(function (line) { return el("li", { text: line }); })));
      section.appendChild(el("div", { className: "mi-coupang-rank-owner-actions" }, [button("확장 상태 다시 보기", "manual-hello", {})]));
      section.appendChild(shell.extNote);
      renderExtNote();
      var id = manualExtensionId();
      var zip = manualZipPath();
      var file = zip ? zip.slice(zip.lastIndexOf("/") + 1) : "";
      section.appendChild(el("div", { className: "mi-coupang-rank-manual-ext" }, [
        zip
          ? el("a", { className: "mi-link-button mi-coupang-rank-manual-download", href: zip, download: file, "data-coupang-rank-manual-download": true, text: "확장 내려받기(zip)" })
          : null,
        el("span", { text: "확장 ID" }),
        el("code", { className: "mi-coupang-rank-manual-id", "data-coupang-rank-manual-id": true, text: id || "서버에서 받지 못함" })
      ]));
      if (!zip) section.appendChild(el("p", { className: "mi-coupang-rank-muted is-warn", text: "확장 내려받기 파일 경로를 서버에서 받지 못했습니다(배포 확인 필요)." }));
      renderManualGuide(file, server.extensionFolder);
      section.appendChild(shell.manualGuide);
    }

    // ── 이벤트 ──

    // 필터·검색·그룹을 바꾸면 '방금 결과를 보인 카드'(sticky)도 놓아 준다.
    function applyFilterChange() {
      clearSticky();
      renderFilterBar();
      renderBulkBar();
      renderList();
    }

    function onClick(event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var statusButton = target.closest("[data-coupang-rank-filter-status]");
      if (statusButton && host.contains(statusButton)) {
        state.filter.status = statusButton.getAttribute("data-coupang-rank-filter-status") || "all";
        applyFilterChange();
        return;
      }
      var node = target.closest("[data-coupang-rank-action]");
      if (!node || !host.contains(node) || node.disabled) return;
      var action = node.getAttribute("data-coupang-rank-action");
      var id = node.getAttribute("data-coupang-rank-id") || "";
      switch (action) {
        case "group-toggle": {
          var name = node.getAttribute("data-coupang-rank-group-name") || "";
          if (state.collapsed.has(name)) state.collapsed.delete(name);
          else state.collapsed.add(name);
          renderList();
          return;
        }
        case "select-visible":
          visibleTrackers().forEach(function (tracker) { state.selected.add(tracker.id); });
          renderBulkBar();
          renderList();
          return;
        case "clear-selection":
          state.selected.clear();
          renderBulkBar();
          renderList();
          return;
        case "bulk-sheet-toggle":
          state.bulkExpanded = !state.bulkExpanded;
          renderBulkBar();
          return;
        case "bulk-pause":
          runBulk("pause", selectedIdsInOrder());
          return;
        case "bulk-resume":
          runBulk("resume", selectedIdsInOrder());
          return;
        case "bulk-delete":
          deleteIds(selectedIdsInOrder());
          return;
        case "bulk-group":
          bulkGroup();
          return;
        case "bulk-ungroup":
          bulkUngroup();
          return;
        case "bulk-export":
          exportSelection();
          return;
        case "pause":
          runBulk("pause", [id], null, { origin: "card", cardId: id });
          return;
        case "resume":
          runBulk("resume", [id], null, { origin: "card", cardId: id });
          return;
        case "delete":
          deleteIds([id], { origin: "card", cardId: id });
          return;
        case "group-edit":
          startGroupEdit(id);
          return;
        case "group-save":
          saveGroupEdit(id);
          return;
        case "group-cancel":
          state.editingGroupId = "";
          renderList();
          return;
        case "runs":
          toggleRuns(id);
          return;
        case "day-detail":
          toggleDayDetail(node);
          return;
        case "filter-today-none":
          state.filter.status = "today-none";
          applyFilterChange();
          return;
        case "manual-check":
          runManualCheck(id);
          return;
        case "manual-enable":
          manualToggle(true);
          return;
        case "manual-disable":
          manualToggle(false);
          return;
        case "manual-all-start":
          manualAllStart();
          return;
        case "manual-all-stop":
          allStop("멈추기를 눌러 멈췄습니다");
          return;
        case "manual-hello":
          setExtNote("확장 상태를 다시 확인하는 중입니다…", "");
          refreshHello(true).then(function (hello) {
            setExtNote("확장 상태를 다시 확인했습니다. " + manualExtensionText(hello), hello.status === "ok" && hello.incognitoAllowed === true ? "is-ok" : "is-warn");
            renderManual();
            renderManualOwner();
            return resumeManualPending(hello);
          }).catch(function () {});
          return;
        case "manual-guide-open":
          openManualGuide();
          return;
        case "owner-jump":
          openOwnerPanel();
          return;
        default:
          ownerButton(action, node);
      }
    }

    function onChange(event) {
      var target = event.target;
      if (!target || !target.getAttribute) return;
      if (target.hasAttribute("data-coupang-rank-select")) {
        var id = target.getAttribute("data-coupang-rank-select");
        keepInPlace(target, function () {
          if (target.checked) state.selected.add(id);
          else state.selected.delete(id);
          renderBulkBar();
          syncGroupChecks();
        });
        return;
      }
      if (target.hasAttribute("data-coupang-rank-group-select")) {
        var name = target.getAttribute("data-coupang-rank-group-select");
        keepInPlace(target, function () {
          visibleTrackers().forEach(function (tracker) {
            if (String(tracker.groupName || DEFAULT_GROUP) !== name) return;
            if (target.checked) state.selected.add(tracker.id);
            else state.selected.delete(tracker.id);
          });
          renderBulkBar();
          renderList();
        }, function () { return findByAttr(shell.list, "data-coupang-rank-group-select", name); });
        return;
      }
      if (target.hasAttribute("data-coupang-rank-filter-group")) {
        state.filter.group = target.value || "";
        applyFilterChange();
        return;
      }
      markDirty(target);
    }

    // 체크칸을 누르는 순간 누른 체크칸이 화면에서 밀렸으면 그 차이만큼 화면을 함께 옮기는 안전장치다. 막대는 동작 줄 자리를 늘 잡아 두므로
    // (CSS visibility) 보통 차이는 0 이라 옮기지 않는다(그룹 체크칸은 목록을 다시 그려 findAgain 으로 다시 찾는다). 휴대폰은 동작 줄이
    // 화면 아래 막대에 떠 있어 높이가 바뀌지 않는다.
    function keepInPlace(anchor, change, findAgain) {
      var before = viewportTop(anchor);
      change();
      if (before === null) return;
      var after = viewportTop(findAgain ? findAgain() : anchor);
      if (after === null) return;
      var delta = after - before;
      if (Math.abs(delta) < 1 || typeof window === "undefined" || !window || typeof window.scrollBy !== "function") return;
      try { window.scrollBy(0, delta); } catch (error) {}
    }

    function viewportTop(node) {
      if (!node || typeof node.getBoundingClientRect !== "function" || node.isConnected === false) return null;
      var rect = node.getBoundingClientRect();
      return rect && isNum(rect.top) ? rect.top : null;
    }

    function markDirty(target) {
      if (!shell || !target.closest) return;
      var section = target.closest("[data-coupang-rank-owner-section]");
      if (section && (section === shell.ownerSettingsSection || section === shell.ownerLimitsSection || section === shell.ownerTokensSection)) {
        section.setAttribute("data-coupang-rank-dirty", "true");
      }
    }

    function syncGroupChecks() {
      var visible = visibleTrackers();
      Array.prototype.forEach.call(shell.list.querySelectorAll("[data-coupang-rank-group-select]"), function (check) {
        var name = check.getAttribute("data-coupang-rank-group-select");
        var items = visible.filter(function (tracker) { return String(tracker.groupName || DEFAULT_GROUP) === name; });
        var all = items.length > 0 && items.every(function (tracker) { return state.selected.has(tracker.id); });
        var some = items.some(function (tracker) { return state.selected.has(tracker.id); });
        check.checked = all;
        check.indeterminate = !all && some;
        var label = check.parentNode && check.parentNode.querySelector ? check.parentNode.querySelector("[data-coupang-rank-group-select-text]") : null;
        if (label) label.textContent = groupSelectText(items);
      });
    }

    function onInput(event) {
      var target = event.target;
      if (!target || !target.hasAttribute) return;
      if (target.hasAttribute("data-coupang-rank-filter-search")) {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          state.filter.query = target.value || "";
          applyFilterChange();
        }, 150);
        return;
      }
      markDirty(target);
    }

    // 날짜 줄: 탭 정지는 한 칸뿐이고 화살표(←→)·Home·End 로 칸을 옮긴다(roving tabindex). Enter·Space 는 버튼 기본 동작(누름)이다.
    function onKeydown(event) {
      var target = event && event.target;
      if (!target || !target.hasAttribute || !target.hasAttribute("data-coupang-rank-day")) return;
      var key = event.key;
      if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
      if (moveDayFocus(target, key) && typeof event.preventDefault === "function") event.preventDefault();
    }

    function onSubmit(event) {
      var form = event.target;
      if (!form || !form.hasAttribute || !host.contains(form)) return;
      event.preventDefault();
      if (form.hasAttribute("data-coupang-rank-create-form")) submitCreate();
      else if (form.hasAttribute("data-coupang-rank-settings-form")) saveSettings();
      else if (form.hasAttribute("data-coupang-rank-limit-form")) submitLimitForm();
      else if (form.hasAttribute("data-coupang-rank-token-form")) submitTokenForm();
    }

    function onToggle(event) {
      if (shell && event.target === shell.owner) onOwnerToggle();
    }

    // 날짜 줄을 옆으로 밀면 오른쪽 끝 흐림을 다시 맞춘다(scroll 은 올라오지 않아 붙잡기 단계로 듣는다).
    function onScroll(event) {
      var target = event && event.target;
      if (!target || !target.classList || !target.classList.contains("mi-rank-day-grid")) return;
      var wrap = target.parentNode;
      if (wrap && wrap.classList && wrap.classList.contains("mi-coupang-rank-days-scroll")) wrap.classList.toggle("has-more", dayFadeWanted(wrap));
    }

    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.destroyed || !shell) return;
        syncDayFades();
        syncDockSpace();
      }, 150);
    }

    host.addEventListener("click", onClick);
    host.addEventListener("change", onChange);
    host.addEventListener("input", onInput);
    host.addEventListener("keydown", onKeydown);
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("submit", onSubmit);
    host.addEventListener("toggle", onToggle, true);
    host.addEventListener("scroll", onScroll, true);
    // ① 지금 확인: 탭이 다시 보이면 확장 상태를 다시 묻고(30초 캐시) 간격 초 세기를 다시 켠다.
    var visibilityTarget = typeof document !== "undefined" && document && typeof document.addEventListener === "function" ? document : null;
    if (visibilityTarget) visibilityTarget.addEventListener("visibilitychange", onManualVisibility);
    var resizeTarget = typeof window !== "undefined" && window && typeof window.addEventListener === "function" ? window : null;
    if (resizeTarget) resizeTarget.addEventListener("resize", onResize);

    if (observedRoot && typeof MutationObserver === "function") {
      observer = new MutationObserver(function () {
        var locked = observedRoot.classList.contains("is-locked");
        if (locked && !wasLocked) reset();
        wasLocked = locked;
      });
      observer.observe(observedRoot, { attributes: true, attributeFilter: ["class"] });
    }

    // ── 카드 '다음' 남은 시간 다시 계산(N30 은 60초 건강 신호마다 순위판을 다시 그린다) ──
    // 목록을 다시 받지 않고, 그려 둔 카드의 '다음' 글자와 대기색만 바꾼다(입력 중인 칸·열린 측정 기록을 건드리지 않게).
    // '다음' 알약은 자동 수집이 돌 때만 있다(지금 확인만 쓸 때는 없음).
    // 탭이 숨었거나 화면이 안 보이면 건너뛴다.

    function refreshNextPills() {
      if (!shell || !state.payload) return;
      var collectorState = collectorStateName();
      var mode = readonlyView() ? "readonly" : "admin";
      var now = Date.now();
      Array.prototype.forEach.call(shell.list.querySelectorAll("[data-coupang-rank-card]"), function (card) {
        var tracker = findTracker(card.getAttribute("data-coupang-rank-id"));
        if (!tracker) return;
        var text = nextCheckText(tracker, collectorState, now, mode);
        var nextNode = card.querySelector("[data-coupang-rank-next]");
        if (!nextNode) return;
        if (nextNode.textContent !== "다음 " + text) nextNode.textContent = "다음 " + text;
        nextNode.classList.toggle("is-wait", text === "대기");
      });
    }

    function stopNextTicker() {
      if (nextTimer) {
        clearInterval(nextTimer);
        nextTimer = 0;
      }
    }

    function startNextTicker() {
      if (nextTimer || state.destroyed) return;
      nextTimer = setInterval(function () {
        if (state.destroyed || !shell) {
          stopNextTicker();
          return;
        }
        if ((typeof document !== "undefined" && document.hidden) || !isHostVisible()) return;
        refreshNextPills();
      }, NEXT_TICK_MS);
      // 노드(시험)에서는 이 타이머 때문에 프로세스가 끝나지 않는 일이 없게 한다. 브라우저 숫자 id 에는 없다.
      if (nextTimer && typeof nextTimer.unref === "function") nextTimer.unref();
    }

    // ── 공개 동작 ──

    function show() {
      if (state.destroyed) return;
      ensureShell();
      var scope = currentScope();
      if (!scope) {
        state.listSeq = ++seqCounter;
        state.scopeKey = "";
        state.payload = null;
        state.partial = false;
        state.setupRequired = false;
        state.loading = false;
        state.selected.clear();
        state.listNote = { text: "", tone: "", detail: "" };
        renderAll();
        return;
      }
      if (scope.key !== state.scopeKey) {
        // 대상 광고주가 바뀌면 전체 확인을 멈춘다(요약은 남긴다). 대기열이 없으면 옛 대상의 요약을 지운다.
        if (state.manual.all) allStop("대상 광고주가 바뀌어 멈췄습니다");
        else state.manual.allSummary = null;
        state.scopeKey = scope.key;
        state.payload = null;
        state.partial = false;
        state.setupRequired = false;
        state.selected.clear();
        state.runs = {};
        state.editingGroupId = "";
        state.status = { text: "", tone: "" };
        state.listNote = { text: "", tone: "", detail: "" };
        state.bulkNote = { text: "", tone: "" };
        state.bulkNoteAt = 0;
        state.bulkExpanded = false;
        state.cardNote = null;
        state.sticky.clear();
        state.dayDetails = {};
        state.dayFocus = {};
        state.pendingFocus = null;
        pruneCache(cacheKey(scope));
      }
      if (!state.payload) {
        var cached = readCache(scope);
        if (cached) {
          state.payload = cached;
          state.listNote = { text: "저장해 둔 목록을 먼저 보여 줍니다. 새 목록을 받는 중입니다.", tone: "" };
        }
      }
      renderAll();
      ensureManualHello();
      // 메뉴 한 번에 setScreen 과 hashchange 가 show() 를 두 번 부르고, 세션 동기화도 scope-changed 와
      // auth-ready 로 두 번 부른다. 같은 범위를 받는 중이거나 2초 안에 받았으면 다시 보내지 않는다.
      loadList({ reuse: true });
      startNextTicker();
      if (shell.owner.open && isOwnerSession() && !ownerReusable(scope)) loadOwner();
    }

    function scopeChanged() {
      if (state.destroyed) return;
      if (isHostVisible()) show();
    }

    function reset() {
      state.listSeq = ++seqCounter;
      state.owner.seq = ++seqCounter;
      stopOwnerPoll();
      stopNextTicker();
      stopManualTicker();
      clearAllTimer();
      clearTimeout(searchTimer);
      clearTimeout(resizeTimer);
      if (dockObserver) {
        try { dockObserver.disconnect(); } catch (error) {}
        dockObserver = null;
      }
      var destroyed = state.destroyed;
      state = freshState();
      state.destroyed = destroyed;
      pruneCache("");
      shell = null;
      host.replaceChildren();
      host.classList.remove("is-docked");
      if (host.style && typeof host.style.removeProperty === "function") host.style.removeProperty("--mi-coupang-rank-dock-space");
    }

    function destroy() {
      reset();
      state.destroyed = true;
      if (observer) observer.disconnect();
      observer = null;
      host.removeEventListener("click", onClick);
      host.removeEventListener("change", onChange);
      host.removeEventListener("input", onInput);
      host.removeEventListener("keydown", onKeydown);
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("submit", onSubmit);
      host.removeEventListener("toggle", onToggle, true);
      host.removeEventListener("scroll", onScroll, true);
      if (visibilityTarget && typeof visibilityTarget.removeEventListener === "function") visibilityTarget.removeEventListener("visibilitychange", onManualVisibility);
      if (resizeTarget && typeof resizeTarget.removeEventListener === "function") resizeTarget.removeEventListener("resize", onResize);
      host.classList.remove("mi-coupang-rank-root");
    }

    return { show: show, scopeChanged: scopeChanged, reset: reset, destroy: destroy };
  }

  window.MomentCoupangRank = {
    mount: mount,
    internals: {
      scopedPayload: scopedPayload,
      cellText: cellText,
      cellTooltip: cellTooltip,
      currentBadge: currentBadge,
      currentText: currentText,
      changeText: changeText,
      avg7Text: avg7Text,
      needsAttention: needsAttention,
      verdictPills: verdictPills,
      emptyBoardText: emptyBoardText,
      nextCheckText: nextCheckText,
      shortAt: shortAt,
      remainText: remainText,
      cellLabel: cellLabel,
      dayKind: dayKind,
      dayDetailText: dayDetailText,
      todayCellOf: todayCellOf,
      checkedToday: checkedToday,
      todayPill: todayPill,
      boardDays: boardDays,
      autoSummary: autoSummary,
      normalizeGroupInput: normalizeGroupInput,
      filterMatches: filterMatches,
      capacityText: capacityText,
      cacheKey: cacheKey,
      exportFileName: exportFileName,
      stripText: stripText,
      limitText: limitText,
      globalLimitText: globalLimitText,
      dayLabel: dayLabel,
      errorText: errorText,
      raiseReasonText: raiseReasonText,
      settingsPatch: settingsPatch,
      isRaise: isRaise,
      // ① 지금 확인
      manualView: manualView,
      manualBoardModel: manualBoardModel,
      // 전체 확인
      manualAllPlan: manualAllPlan,
      manualAllBlock: manualAllBlock,
      manualAllTake: manualAllTake,
      manualAllHint: manualAllHint,
      manualAllConfirmText: manualAllConfirmText,
      manualAllStateStopText: manualAllStateStopText,
      manualAllClaimStopText: manualAllClaimStopText,
      manualAllRecordVerdict: manualAllRecordVerdict,
      manualAllSummary: manualAllSummary,
      manualDisplayOrder: manualDisplayOrder,
      manualOffLine: manualOffLine,
      manualButtonLabel: manualButtonLabel,
      manualCardNote: manualCardNote,
      manualBusyMine: manualBusyMine,
      manualProjected: manualProjected,
      manualPreflightText: manualPreflightText,
      manualRecordText: manualRecordText,
      manualClaimRefusalText: manualClaimRefusalText,
      manualCodeText: manualCodeText,
      manualChangedParams: manualChangedParams,
      manualStopText: manualStopText,
      manualExtensionText: manualExtensionText,
      manualGuideSteps: manualGuideSteps,
      parseHelloReply: parseHelloReply,
      parseCheckReply: parseCheckReply,
      manualRecordBody: manualRecordBody,
      countdownText: countdownText,
      compareVersionText: compareVersionText,
      kstDayAt: kstDayAt,
      kstHourAt: kstHourAt
    }
  };
})();
