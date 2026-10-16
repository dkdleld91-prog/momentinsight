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
  // 화면 열기(show)가 짧은 간격으로 두 번 오면(메뉴 클릭의 setScreen + hashchange, 운영팀 세션 동기화의
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

  var STATUS_DEFAULT = "키워드와 쿠팡 상품 URL을 입력하면 최근 30일 순위 기록을 표시합니다.";
  var FIRST_BOARD_TEXT = "첫 순위 확인 후 이 상품만의 일별 기록판이 생성됩니다.";
  var NO_RECENT_BOARD_TEXT = "최근 30일 측정 기록이 없습니다.";
  var LOADED_TEXT = "등록된 쿠팡 순위 추적을 불러왔습니다.";
  var TITLE_PENDING_HINT = "상품명은 검색 1쪽에서 이 상품을 찾은 뒤 채워집니다";

  var ATTENTION_TEXT = {
    drop10: "10위 이상 하락",
    exit: "50위 밖으로 이탈",
    keyword_failing: "이 키워드 측정이 연속 실패",
    unsupported: "쿠팡이 검색 결과가 아닌 쪽으로 보냄"
  };

  var FIRST_CHECK_TEXT = {
    recorded: "오늘 측정으로 바로 기록했습니다",
    queued: "다음 수집 때(수집기가 켜져 있을 때) 첫 순위가 기록됩니다"
  };

  var FILTER_STATUSES = [
    ["all", "전체"],
    ["attention", "확인 필요"],
    ["up", "상승"],
    ["down", "하락"],
    ["out", "50위 밖"],
    ["paused", "일시중지"]
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
  var SETTING_FIELDS = [
    { key: "teamAccessEnabled", label: "운영팀 공개", type: "bool", help: "켜면 운영팀 메뉴에 C 30일 순위가 보입니다(2a)." },
    { key: "clientViewEnabled", label: "광고주 공개", type: "bool", help: "광고주 화면 연결(2b) 뒤에 켭니다." },
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
    COUPANG_TEAM_NOT_OPEN: "운영팀 공개가 아직 꺼져 있습니다.",
    COUPANG_CLIENT_NOT_OPEN: "광고주 공개가 아직 꺼져 있습니다.",
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
    COUPANG_RANK_TRACKERS_FAILED: "서버 처리 중 오류가 났습니다. 잠시 뒤 다시 시도하세요."
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

  // 칸의 작은 글. 실패·이동은 측정 자체의 결과라 '측정', 결과 없음은 '검색', 그 밖은 N30 처럼 '순위'.
  function cellLabel(cell) {
    var status = cell && cell.s;
    if (status === "failed" || status === "unsupported") return "측정";
    if (status === "noresult") return "검색";
    return "순위";
  }

  // 순위가 없는 칸(N30 의 연회색 '-' 칸과 같은 취급).
  function cellIsEmpty(cell) {
    var status = cell && cell.s;
    return !cell || status === "out" || status === "short" || status === "noresult" || (status === "found" && !isNum(cell.r));
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
      return "측정 없음(수집기 꺼짐·시간대 밖·일시중지·쉬는 중)";
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

  function filterMatches(tracker, filter) {
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
    return true;
  }

  function limitText(limit) {
    if (!limit) return "";
    var show = function (value) { return isNum(value) ? String(value) : "-"; };
    return "사용 " + show(limit.used) + " / " + show(limit.max) + " · 전체 " + show(limit.globalUsed) + " / " + show(limit.globalMax);
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

  function templateText(checksPerDay) {
    var count = isNum(checksPerDay) ? checksPerDay : "n";
    return "쿠팡 순위는 로그인하지 않은 검색 1쪽에서 광고를 뺀 일반 상품 순서입니다. 하루 " + count +
      "회 측정하고, 그날 마지막 측정을 기록합니다. '50위 밖'은 1쪽 일반 상품 1~50위 안에 없다는 뜻입니다.";
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
      exportTools: given.exportTools || null
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
        listNote: { text: "", tone: "" },
        status: { text: "", tone: "" },
        selected: new Set(),
        filter: { query: "", group: "", status: "all" },
        collapsed: new Set(),
        runs: {},
        editingGroupId: "",
        busy: false,
        owner: { open: false, seq: 0, loading: false, data: null, error: "", note: { text: "", tone: "" }, timer: 0, freshToken: null, dirty: false, fieldErrors: {}, key: "", flight: 0, doneAt: 0 }
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
        payload = { ok: false, message: "요청을 보내지 못했습니다: " + (error && error.message || "연결 실패") };
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
          state.listNote = { text: "목록을 받지 못했습니다(" + (error && error.message || "연결 실패") + "). 화면의 이전 목록을 그대로 둡니다.", tone: "is-warn" };
          renderAll();
          return;
        }
        var payload = await readJson(response);
        if (!stillCurrent(seq, scope)) return;
        state.loading = false;
        if (applyListPayload(payload, scope, opts.afterWrite === true, opts.announce === true)) state.listDoneAt = Date.now();
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
    // 돌려준다 — 그때만 2초 합치기 창을 연다. announce(화면 열기)면 N30 처럼 상태줄에 불러온 결과를 알린다.
    function applyListPayload(payload, scope, afterWrite, announce) {
      if (payload && payload.ok === true && payload.setupRequired === true) {
        state.setupRequired = true;
        state.payload = null;
        state.partial = false;
        state.selected.clear();
        state.listNote = { text: "", tone: "" };
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
          renderAll();
          return true;
        }
        // 화면에 전체 목록이 있으면 그 목록을 그대로 둔다(§8.2). 그 목록에서도 일시중지·삭제할 수 있다.
        state.listNote = { text: totalText + " 일시중지한 추적도 500개에 세므로 개수를 줄이려면 삭제하세요.", tone: "is-warn" };
        renderAll();
        return true;
      }
      state.setupRequired = false;
      state.payload = payload;
      state.partial = false;
      state.listNote = { text: "", tone: "" };
      pruneSelection();
      writeCache(scope, payload);
      // N30 목록 조회와 같은 알림: 추적이 있으면 '불러왔습니다'(초록), 없으면 기본 안내문. 등록 줄이 있는 화면에서만.
      if (announce && canWrite()) state.status = payload.trackers.length ? { text: LOADED_TEXT, tone: "is-ok" } : { text: "", tone: "" };
      renderAll();
      return true;
    }

    function pruneSelection() {
      var ids = new Set(trackers().map(function (tracker) { return tracker.id; }));
      Array.from(state.selected).forEach(function (id) { if (!ids.has(id)) state.selected.delete(id); });
      Object.keys(state.runs).forEach(function (id) { if (!ids.has(id)) delete state.runs[id]; });
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

    function visibleTrackers() {
      return trackers().filter(function (tracker) { return filterMatches(tracker, state.filter); });
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

    function checksPerDay() {
      var info = collectorInfo();
      if (info && isNum(info.checksPerDay)) return info.checksPerDay;
      var settings = state.owner.data && state.owner.data.settings;
      return settings && isNum(settings.checksPerDay) ? settings.checksPerDay : null;
    }

    // ── 뼈대 ──

    // N30 화면(admin.html 네이버 30일 순위의 상품 카드)과 같은 틀: 큰 카드 하나 안에 카드 머리 → 등록 줄 → 상태줄 →
    // 목록 제목 → 필터 줄 → 도움말 → 요약칸 → 선택 항목 정리 → 그룹. 보조 구역(사용 방법·안내 문구·
    // 총관리자 수집기 관리)은 큰 카드 아래에 둔다. data-coupang-rank-* 훅 이름은 그대로다.
    function ensureShell() {
      if (shell && host.contains(shell.main)) return shell;
      host.classList.add("mi-coupang-rank-root");
      host.replaceChildren();
      shell = {};
      shell.main = el("article", { className: "mi-card mi-card-pad mi-rank-card mi-coupang-rank-main" });
      shell.limit = el("span", { className: "mi-coupang-rank-limit", "data-coupang-rank-limit": true, hidden: true });
      shell.main.appendChild(el("div", { className: "mi-card-head mi-coupang-rank-head" }, [
        el("div", {}, [
          el("span", { className: "mi-kicker", text: "쿠팡 일반 순위" }),
          el("h2", { text: "30일 순위 추적을 시작합니다." }),
          el("p", { text: "쿠팡 검색 1쪽에서 광고를 뺀 일반 상품 순위와 광고 순번을 함께 관리합니다." }),
          el("p", { className: "mi-code-status mi-coupang-rank-rule", text: "비로그인 검색 1쪽 · 광고 제외 일반 순위 · 같은 상품이면 옵션이 달라도 인정합니다." })
        ]),
        shell.limit
      ]));
      shell.form = el("div", { className: "mi-coupang-rank-form", "data-coupang-rank-form": true, hidden: true });
      shell.status = el("p", { className: "mi-code-status mi-coupang-rank-status", "data-coupang-rank-status": true, "aria-live": "polite", hidden: true });
      shell.capacity = el("p", { className: "mi-coupang-rank-capacity", "data-coupang-rank-capacity": true, hidden: true });
      shell.board = el("div", { className: "mi-rank-panel mi-rank-history mi-coupang-rank-board", "data-coupang-rank-board": true });
      shell.main.appendChild(shell.form);
      shell.main.appendChild(shell.status);
      shell.main.appendChild(shell.capacity);
      shell.main.appendChild(el("div", { className: "mi-rank-grid mi-coupang-rank-grid" }, [shell.board]));
      shell.guide = el("details", { className: "mi-card mi-coupang-rank-guide", "data-coupang-rank-guide": true });
      shell.template = el("section", { className: "mi-card mi-card-pad mi-coupang-rank-template", "data-coupang-rank-template": true, hidden: true });
      shell.owner = el("details", { className: "mi-card mi-coupang-rank-owner", "data-coupang-rank-owner": true, hidden: true });
      host.appendChild(shell.main);
      host.appendChild(shell.guide);
      host.appendChild(shell.template);
      host.appendChild(shell.owner);
      buildForm();
      buildBoard();
      buildOwnerFrame();
      buildTemplate();
      return shell;
    }

    function setStatus(text, tone) {
      state.status = { text: text || "", tone: tone || "" };
      renderStatus();
    }

    // 상태줄은 N30 처럼 등록 줄 바로 아래에 늘 보인다(등록 줄이 보일 때). 결과 문구가 없으면 기본 안내문으로 돌아간다.
    // 등록 줄이 없는 화면(읽기 전용·설정 전·대상 없음)에서는 결과 문구가 있을 때만 보인다.
    function renderStatus() {
      if (!shell) return;
      var text = state.status.text || (shell.form.hidden ? "" : STATUS_DEFAULT);
      shell.status.textContent = text;
      shell.status.hidden = !text;
      shell.status.classList.remove("is-ok", "is-warn");
      if (state.status.text && state.status.tone) shell.status.classList.add(state.status.tone);
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
      renderGuide();
      renderTemplate();
    }

    // ── 1. 자동추적 요약칸(N30 .mi-rank-auto-center 와 같은 칸, 목록 맨 위) ──

    function renderStrip() {
      var scope = currentScope();
      shell.strip.replaceChildren();
      if (!scope) {
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

    // ── 2. 등록 줄(N30 .mi-rank-form 과 같은 5칸: 키워드·URL·그룹·고정 범위·버튼) ──

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
      form.appendChild(el("span", { className: "mi-rank-fixed-range", "aria-label": "조회 범위 일반 50위 이내", text: "일반 50위 이내" }));
      form.appendChild(shell.createButton);
      shell.form.appendChild(form);
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
      if (result.tracker && result.tracker.id) mergeTracker(result.tracker);
      if (result.limit && state.payload) state.payload.limit = result.limit;
      var message;
      if (result.alreadyTracking) message = "이미 추적 중입니다";
      else if (result.resumed) message = "일시중지했던 추적을 다시 시작했습니다. " + (FIRST_CHECK_TEXT[result.firstCheck] || "");
      else message = "등록했습니다. " + (FIRST_CHECK_TEXT[result.firstCheck] || "");
      if (!result.alreadyTracking) {
        shell.keyword.value = "";
        shell.productUrl.value = "";
      }
      setStatus(message.trim(), result.alreadyTracking ? "is-warn" : "is-ok");
      var scope = currentScope();
      if (state.payload && scope) writeCache(scope, state.payload);
      renderAll();
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

    // ── 3·4. 필터 줄과 선택 항목 정리(N30 과 같은 문구·같은 순서) ──

    function buildBoard() {
      shell.filterBar = el("div", { className: "mi-rank-filterbar mi-coupang-rank-filterbar", "data-coupang-rank-filter": true });
      shell.search = el("input", { className: "mi-input", type: "search", placeholder: "키워드, 상품명, 상품번호 검색", "aria-label": "쿠팡 순위 추적 검색", "data-coupang-rank-filter-search": true });
      shell.groupFilter = el("select", { className: "mi-input", "aria-label": "쿠팡 순위 추적 그룹 필터", "data-coupang-rank-filter-group": true });
      shell.groupFilterWrap = el("label", { className: "mi-rank-group-filter" }, [el("span", { text: "그룹" }), shell.groupFilter]);
      shell.statusButtons = el("div", { className: "mi-rank-filter-actions", role: "group", "aria-label": "쿠팡 순위 추적 상태 필터" });
      FILTER_STATUSES.forEach(function (entry) {
        shell.statusButtons.appendChild(el("button", { className: "mi-rank-filter-button", type: "button", "data-coupang-rank-filter-status": entry[0], text: entry[1] }));
      });
      shell.filterCount = el("span", { className: "mi-rank-filter-count", "data-coupang-rank-filter-count": true });
      shell.filterBar.appendChild(shell.search);
      shell.filterBar.appendChild(shell.groupFilterWrap);
      shell.filterBar.appendChild(shell.statusButtons);
      shell.filterBar.appendChild(shell.filterCount);

      shell.filterHelp = el("p", { className: "mi-rank-filter-help", text: "전체 그룹은 모든 추적을 보여주고, 그룹을 선택하면 해당 그룹만 정리해서 볼 수 있습니다. 하루 칸에 마우스를 올리면 그날 기록이 보입니다." });

      // 선택 항목 정리: N30 renderRankBulkBar 와 같은 제목·문구·공통 버튼 순서
      // [그룹명 입력][그룹 생성/적용][그룹 해제][선택 해제] 뒤에 C30 전용(일시중지·다시 시작·삭제·표시 항목 전체 선택),
      // 마지막에 [선택 이미지 저장]. '전체 순위 갱신'은 쿠팡 차단을 막으려고 두지 않는다.
      // 동작 칸은 N30 .mi-rank-bulk-actions(6칸 grid) 대신 C30 칸(flex wrap)을 쓴다.
      shell.bulk = el("div", { className: "mi-rank-bulk-bar mi-coupang-rank-bulk", "data-coupang-rank-bulk": true });
      shell.bulkCount = el("span", { "data-coupang-rank-selected-count": true, text: "항목 선택 후 적용" });
      shell.bulkHint = el("small", { text: "" });
      shell.bulkGroupInput = el("input", { className: "mi-input", type: "text", maxlength: String(GROUP_MAX), autocomplete: "off", list: shell.groupListId, placeholder: "그룹명 선택 또는 입력", "aria-label": "선택 항목 이동 그룹", "data-coupang-rank-bulk-group-input": true });
      shell.bulkGroupWrap = el("span", { className: "mi-coupang-rank-bulk-group" }, [
        shell.bulkGroupInput,
        button("그룹 생성/적용", "bulk-group", { className: "mi-button", "data-coupang-rank-write": true }),
        button("그룹 해제", "bulk-ungroup", { className: "mi-button subtle", "data-coupang-rank-write": true })
      ]);
      var bulkActions = el("div", { className: "mi-coupang-rank-bulk-actions" }, [
        shell.bulkGroupWrap,
        button("선택 해제", "clear-selection", { className: "mi-button subtle" }),
        button("일시중지", "bulk-pause", { className: "mi-button subtle", "data-coupang-rank-write": true }),
        button("다시 시작", "bulk-resume", { className: "mi-button subtle", "data-coupang-rank-write": true }),
        button("삭제", "bulk-delete", { className: "mi-button subtle mi-coupang-rank-danger", "data-coupang-rank-write": true }),
        button("표시 항목 전체 선택", "select-visible", { className: "mi-button subtle" }),
        button("선택 이미지 저장", "bulk-export", { className: "mi-rank-share-image" })
      ]);
      shell.bulk.appendChild(el("div", { className: "mi-rank-bulk-title" }, [
        el("strong", { text: "선택 항목 정리" }),
        shell.bulkCount,
        shell.bulkHint
      ]));
      shell.bulk.appendChild(bulkActions);

      shell.listNote = el("p", { className: "mi-coupang-rank-list-note", "data-coupang-rank-list-note": true, "aria-live": "polite", hidden: true });
      shell.strip = el("div", { className: "mi-rank-auto-center mi-coupang-rank-auto", "data-coupang-rank-strip": true, role: "status", hidden: true });
      shell.list = el("div", { className: "mi-coupang-rank-list", "data-coupang-rank-list": true });
      shell.board.appendChild(el("h3", { text: "상품별 일별 순위" }));
      shell.board.appendChild(shell.filterBar);
      shell.board.appendChild(shell.filterHelp);
      shell.board.appendChild(shell.listNote);
      shell.board.appendChild(shell.strip);
      shell.board.appendChild(shell.bulk);
      shell.board.appendChild(shell.list);
    }

    function renderFilterBar() {
      var hasData = Boolean(state.payload) && !state.setupRequired;
      shell.filterBar.hidden = !hasData;
      shell.filterHelp.hidden = !hasData;
      if (!hasData) return;
      var names = groupNames();
      if (state.filter.group && names.indexOf(state.filter.group) < 0) state.filter.group = "";
      shell.groupFilter.replaceChildren(el("option", { value: "", text: "전체 그룹" }));
      names.forEach(function (name) { shell.groupFilter.appendChild(el("option", { value: name, text: name })); });
      shell.groupFilter.value = state.filter.group;
      shell.groupFilterWrap.classList.toggle("is-filtered", Boolean(state.filter.group));
      if (shell.search.value !== state.filter.query && document.activeElement !== shell.search) shell.search.value = state.filter.query;
      Array.prototype.forEach.call(shell.statusButtons.querySelectorAll("[data-coupang-rank-filter-status]"), function (node) {
        var active = node.getAttribute("data-coupang-rank-filter-status") === state.filter.status;
        node.classList.toggle("is-active", active);
        node.setAttribute("aria-pressed", active ? "true" : "false");
      });
      shell.filterCount.textContent = cleanupMode()
        ? visibleTrackers().length + "개 표시 / 받은 " + trackers().length + "개(전체 " + (isNum(state.payload.totalCount) ? state.payload.totalCount : "?") + "개)"
        : visibleTrackers().length + "개 표시 / 전체 " + trackers().length + "개";
    }

    function renderBulkBar() {
      var hasData = Boolean(state.payload) && !state.setupRequired && trackers().length > 0;
      shell.bulk.hidden = !hasData;
      if (!hasData) return;
      var count = state.selected.size;
      var writable = canWrite();
      var cleanup = cleanupMode();
      shell.bulkCount.textContent = count ? count + "개 선택" : "항목 선택 후 적용";
      shell.bulkHint.textContent = !writable
        ? "체크한 항목을 한 장의 이미지로 저장할 수 있습니다."
        : (cleanup
          ? "정리용 화면이라 선택 항목의 일시중지·삭제만 됩니다."
          : "그룹명을 입력하거나 목록에서 선택하면 새 그룹 생성과 이동을 한 번에 처리합니다.");
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
    }

    function renderListNote() {
      if (!shell) return;
      var note = state.listNote;
      var text = note.text;
      if (!text && state.loading) text = state.payload ? "새 목록을 받는 중입니다…" : "";
      shell.listNote.textContent = text;
      shell.listNote.hidden = !text;
      shell.listNote.className = "mi-coupang-rank-list-note" + (note.tone ? " " + note.tone : "");
    }

    // ── 5. 그룹 구역 + 카드 ──

    function stateBox(text) {
      return el("div", { className: "mi-rank-state", text: text });
    }

    function renderList() {
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
        shell.list.appendChild(stateBox("추적 등록 후 상품별 일별 순위판이 생성됩니다."));
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
      var groupList = el("div", { className: "mi-rank-group-list" });
      groups.forEach(function (name) {
        groupList.appendChild(renderGroup(name, byName[name]));
      });
      shell.list.appendChild(groupList);
    }

    function groupSelectText(items) {
      var picked = items.filter(function (tracker) { return state.selected.has(tracker.id); }).length;
      return picked && picked < items.length ? "전체 선택 (" + picked + "/" + items.length + ")" : "전체 선택";
    }

    // 그룹 머리: N30 renderRankHistory 와 같은 글('전체 선택 (n/m)' · '미분류' · 'N개 추적 · 현재 최고 N위').
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
              el("span", { className: "mi-rank-group-meta", text: items.length + "개 추적" + (best ? " · 현재 최고 " + best + "위" : "") })
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

    function keywordNode(tracker) {
      var label = String(tracker.keyword || "").trim() || "-";
      var url = keywordSearchUrl(tracker.keyword);
      if (!url) return el("strong", { className: "mi-rank-keyword-name", title: label, text: label });
      return el("a", {
        className: "mi-rank-keyword-name",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        title: label + " 쿠팡 검색으로 열기(로그인 상태면 순서가 다를 수 있음)",
        text: label
      });
    }

    // 카드: N30 renderRankTrackerCard 와 같은 뼈대·클래스(admin.html 인라인 CSS 가 그대로 적용된다).
    // 1행 [선택][키워드][상품정보 · 번호][상품명] | [현재][최고][일시중지/다시 시작][삭제]
    // 2행 운영줄 알약: 상태 · 판정 · (다른 옵션) · 전회 대비 · 7일 평균 · 광고 · 그룹 · [그룹 변경] · [측정 기록] · 최근 · 다음
    // 3행 날짜 줄(N30 하루 칸). 끌기 손잡이·검색량·갱신 버튼은 없다(쿠팡은 정해진 간격으로만 잰다).
    function renderCard(tracker) {
      var summary = tracker.summary || {};
      var current = tracker.current || null;
      var paused = tracker.status === "paused";
      var writable = canWrite();
      var cleanup = cleanupMode();
      var collectorState = collectorStateName();
      var check = el("input", { type: "checkbox", "data-coupang-rank-select": tracker.id, "aria-label": String(tracker.keyword || "") + " 선택" });
      check.checked = state.selected.has(tracker.id);

      var actions = [
        pill("현재 " + currentText(tracker), "mi-rank-pill"),
        pill("최고 " + (isNum(summary.best30) ? summary.best30 + "위" : "-"), "mi-rank-pill", { title: "최근 30일 하루 칸 가운데 가장 높은 순위" })
      ];
      if (writable) {
        // 정리용 화면에서는 다시 시작을 그리지 않는다(일시중지·삭제만). N30 '갱신' 자리에 일시중지를 둔다.
        if (paused) {
          if (!cleanup) actions.push(button("다시 시작", "resume", { "data-coupang-rank-id": tracker.id, disabled: state.busy }));
        } else {
          actions.push(button("일시중지", "pause", { "data-coupang-rank-id": tracker.id, disabled: state.busy }));
        }
        actions.push(button("삭제", "delete", { className: "mi-link-button is-danger", "data-coupang-rank-id": tracker.id, disabled: state.busy }));
      }

      var head = el("div", { className: "mi-rank-track-row-head" }, [
        el("div", { className: "mi-rank-track-main" }, [
          el("div", { className: "mi-rank-track-primary" }, [
            el("div", { className: "mi-rank-track-controls" }, [
              el("label", { className: "mi-rank-select" }, [check, el("span", { text: "선택" })])
            ]),
            keywordNode(tracker),
            el("span", { className: "mi-rank-product-info", text: "상품정보 · " + (tracker.productId || "-") }),
            productTitleNode(tracker)
          ])
        ]),
        el("div", { className: "mi-rank-row-actions" }, actions)
      ]);

      var days30 = state.payload && state.payload.days30;
      var nextText = nextCheckText(tracker, collectorState, Date.now(), readonlyView() ? "readonly" : "admin");
      var statusText = paused
        ? "상태 중지" + (tracker.pausedDay ? " · " + String(tracker.pausedDay).slice(5) + "부터" : "")
        : "상태 운영중";
      // N30 rankTrackerStatusClass 처럼 '다음'이 '대기'일 때만 파란 대기색(수집기가 멈췄거나 응답이 없으면 '대기'가 아니다).
      var ops = [pill(statusText, nextText === "대기" ? "is-wait" : null, { "data-coupang-rank-state-pill": true })];
      verdictPills(tracker, days30).forEach(function (verdict) {
        ops.push(pill(verdict.text, "mi-rank-insight-pill " + verdict.tone));
      });
      if (current && current.sameOption === false) ops.push(pill("다른 옵션으로 노출", "mi-rank-insight-pill is-warn", { title: "같은 상품의 다른 옵션이 검색 결과에 나왔습니다(순위는 인정)" }));
      ops.push(pill(changeText(summary), null, { title: "같은 시간대 회차끼리 비교" }));
      ops.push(pill(avg7Text(summary), null, { title: "최근 7일 가운데 50위 안에 든 날만 평균" }));
      ops.push(pill("광고 " + (current && isNum(current.adOrder) ? current.adOrder + "번째" : "-"), null, { title: "광고 순번은 참고용입니다(순위는 광고를 뺀 일반 상품 순서)" }));
      ops.push(pill("그룹 " + groupDisplayName(tracker.groupName)));
      if (writable && !cleanup) ops.push(button("그룹 변경", "group-edit", { className: "mi-rank-group-edit", "data-coupang-rank-id": tracker.id, disabled: state.busy }));
      var runs = state.runs[tracker.id];
      ops.push(button(runs && runs.open ? "측정 기록 닫기" : "측정 기록", "runs", { className: "mi-rank-group-edit", "data-coupang-rank-id": tracker.id, "aria-expanded": runs && runs.open ? "true" : "false" }));
      ops.push(pill("최근 " + (current && current.checkedAt ? shortAt(current.checkedAt) : "-")));
      ops.push(pill("다음 " + nextText, null, { "data-coupang-rank-next": true }));

      var card = el("section", { className: "mi-rank-tracker-card mi-coupang-rank-card" + (paused ? " is-paused" : ""), "data-coupang-rank-card": true, "data-coupang-rank-id": tracker.id });
      card.appendChild(head);
      card.appendChild(el("div", { className: "mi-rank-ops-row" }, ops));
      card.appendChild(renderDays(tracker, days30));
      if (state.editingGroupId === tracker.id) card.appendChild(renderGroupEditor(tracker));
      if (runs && runs.open) card.appendChild(renderRuns(tracker));
      return card;
    }

    // 날짜 줄: N30 renderTrackerDailyBoard 와 같은 칸(MM-DD(요) + 작은 글 '순위' + 굵은 값). 등록한 날부터 오늘까지
    // 이어서 보여 준다(서버 days30 덕분에 '측정 없음(-)'과 '50위 밖'을 나눠 쓸 수 있다). 기록이 하나도 없으면 N30 과 같은 안내 상자.
    function renderDays(tracker, days30) {
      var empty = emptyBoardText(tracker, days30);
      if (empty) return el("div", { className: "mi-rank-state mi-coupang-rank-board-empty", text: empty });
      var range = boardDays(tracker, days30);
      var grid = el("div", { className: "mi-rank-day-grid", role: "list", "aria-label": "일별 순위" });
      range.dates.forEach(function (d) {
        var cell = range.byDay[d] || null;
        var weekend = dayClass(d);
        var warn = cell && (cell.s === "failed" || cell.s === "unsupported");
        var slotClass = cellIsEmpty(cell) ? "is-empty" : (warn ? "mi-coupang-rank-slot-warn" : null);
        grid.appendChild(el("div", { className: "mi-rank-day-card" + (weekend ? " " + weekend : ""), role: "listitem", title: cellTooltip(cell, d, tracker.createdDay) || null }, [
          el("strong", { text: dayLabel(d) }),
          el("div", { className: "mi-rank-day-slots" }, [
            el("span", { className: slotClass }, [el("small", { text: cellLabel(cell) }), el("b", { text: cellText(cell, d, tracker.createdDay) })])
          ])
        ]));
      });
      return grid;
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
      box.appendChild(el("h4", { text: "최근 30일 측정 " + snapshots.length + "건" }));
      if (!snapshots.length) box.appendChild(el("p", { className: "mi-coupang-rank-muted", text: "아직 측정이 없습니다." }));
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
          if (failure.errorCode) parts.push(String(failure.errorCode));
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
          payload = { ok: false, message: "측정 기록을 받지 못했습니다(" + (error && error.message || "연결 실패") + ")." };
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
    async function runBulk(action, ids, extra, options) {
      var opts = options || {};
      if (!canWrite() || state.busy || !ids.length) return;
      if (cleanupMode() && !cleanupAllows(action)) {
        setStatus("추적이 " + LIST_LIMIT + "개를 넘어 정리하는 동안에는 일시중지·삭제만 할 수 있습니다.", "is-warn");
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
        setStatus((total ? total + "개는 처리했지만 " : "") + errorText(failure), "is-warn");
      } else if (stopped) {
        var name = (findTracker(stopped.id) || {}).keyword || "한 항목";
        var stopText = stopped.code ? errorText({ code: stopped.code, limit: stopped.limit, count: stopped.count }) : "한도에 걸렸습니다.";
        setStatus(total + "개를 다시 시작했고, '" + name + "'에서 멈췄습니다. " + stopText, "is-warn");
      } else {
        if (typeof opts.after === "function") opts.after(total);
        setStatus(typeof opts.okText === "function" ? opts.okText(total) : total + "개 " + labels[action] + ".", total ? "is-ok" : "is-warn");
      }
      await loadList({ afterWrite: true });
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
        okText: function (total) {
          if (!total) return "그룹을 바꾸지 못했습니다. 목록을 다시 받아 확인해주세요.";
          return name ? "그룹을 " + name + "(으)로 바꿨습니다." : "그룹을 해제했습니다(" + UNGROUPED_LABEL + ").";
        }
      });
    }

    // N30 '그룹 생성/적용'과 같은 흐름: 적용 뒤 선택·그룹 필터·입력을 비우고 전체 그룹으로 돌아온다.
    function bulkGroup() {
      var raw = String(shell.bulkGroupInput.value || "").trim();
      var name = normalizeGroupInput(raw);
      var ids = selectedIdsInOrder();
      if (!raw) {
        setStatus("만들거나 이동할 그룹명을 입력해주세요.", "is-warn");
        shell.bulkGroupInput.focus();
        return;
      }
      if (!ids.length) {
        setStatus("그룹에 넣을 추적 항목을 먼저 체크해주세요.", "is-warn");
        return;
      }
      if (!name) {
        // '미분류'라고 적었다: 그룹 해제와 같다.
        bulkUngroup();
        return;
      }
      if (Array.from(name).length > GROUP_MAX) {
        setStatus(ERROR_TEXT.COUPANG_GROUP_INVALID, "is-warn");
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
        setStatus("그룹 해제할 추적 항목을 먼저 체크해주세요.", "is-warn");
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

    function deleteIds(ids) {
      if (!ids.length) return;
      if (!confirmAction(ids.length + "개와 30일 기록이 지워집니다. 삭제할까요?\n(멈추기만 하려면 '일시중지'를 쓰세요. 일시중지는 기록을 보존합니다.)")) return;
      runBulk("delete", ids);
    }

    // ── 선택 이미지 저장(§8.5) ──
    // 시트는 화면 카드를 복제하지 않고 따로 만든다(공용 mi-rank-* 클래스 + var(--mi-*) 인라인 style 만).
    // 광고주에게 보내는 이미지라 운영줄의 내부용 알약(상태·판정·광고·그룹·측정 기록·최근·다음)은 넣지 않는다
    // (대표 결정 2026-10-17, N30 이미지와 같은 항목). 남기는 것은 '현재'·'최고'·'전회 대비'·'7일 평균'과 날짜 줄이다.
    // 알약 순서는 C30 화면 카드 운영줄·N30 이미지와 같게 '전회 대비' 다음 '7일 평균'.
    // 문구·날짜 범위는 화면 카드와 같다(등록한 날부터 오늘까지, 측정 없는 날은 '-', '오늘' 표시 없음).

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
        setStatus("이미지 저장 도구가 연결되지 않았습니다.", "is-warn");
        return;
      }
      var rootId = (host.closest("#mi-admin, #mi-clean") || { id: "mi-admin" }).id;
      var rendered = renderCoupangExportSheet(selectedTrackers);
      await nextFrame();
      var width = Math.max(960, Math.ceil(rendered.sheet.scrollWidth || 1320));
      var height = Math.max(420, Math.ceil(rendered.sheet.scrollHeight || 420));
      if (height > EXPORT_MAX_HEIGHT) {
        rendered.stage.replaceChildren();
        setStatus("선택 항목이 너무 많습니다. 20개 이하로 나눠 저장해주세요.", "is-warn");
        return;
      }
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%">' +
        tools.serialize(rendered.sheet, rootId) + "</foreignObject></svg>";
      try {
        var exported = await tools.toBlob(rendered, svg, width, height);
        var link = tools.showReady(host, exported.blob, exportFileName(selectedTrackers, exported.ext), selectedTrackers.length);
        if (link) link.click();
        // N30 과 같은 안내 문구(admin.html 이미지 저장: 'N개 순위 항목의 공유 이미지(PNG)가 준비되었습니다.').
        setStatus(selectedTrackers.length + "개 순위 항목의 공유 이미지(" + String(exported.ext).toUpperCase() + ")가 준비되었습니다.", "is-ok");
      } catch (error) {
        var fallback = tools.showReady(host, new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), exportFileName(selectedTrackers, "svg"), selectedTrackers.length);
        if (fallback) fallback.click();
        setStatus("이미지 변환이 막혀 SVG 파일로 준비했습니다. 크롬 브라우저에서 다시 시도해주세요.", "is-warn");
      } finally {
        rendered.stage.replaceChildren();
      }
    }

    function exportSelection() {
      var selectedTrackers = trackers().filter(function (tracker) { return state.selected.has(tracker.id); });
      if (!selectedTrackers.length) {
        setStatus("이미지로 저장할 항목을 먼저 체크해주세요.", "is-warn");
        return Promise.resolve();
      }
      return exportSelected(selectedTrackers).catch(function (error) {
        setStatus("이미지를 만들지 못했습니다: " + (error && error.message || "알 수 없는 오류"), "is-warn");
      });
    }

    // ── 6. 사용 방법 ──

    function renderGuide() {
      var scope = currentScope();
      shell.guide.hidden = !scope;
      if (!scope) return;
      var info = collectorInfo() || {};
      var n = checksPerDay();
      var hours = hoursText(info.activeFromHour, info.activeToHour) || "08~23시";
      var wasOpen = shell.guide.open;
      shell.guide.replaceChildren();
      shell.guide.appendChild(el("summary", {}, [el("strong", { text: "사용 방법" }), el("span", { text: "등록 · 읽는 법 · 멈추기 · 수집 시간" })]));
      var items = [
        "등록: 쿠팡 상품 페이지를 연 뒤 주소창의 주소를 붙여 넣습니다(짧은 링크 link.coupang.com·coupa.ng는 안 됩니다). 상품번호만 넣어도 됩니다.",
        "첫 기록: 오늘 같은 키워드를 이미 쟀으면 바로 기록되고, 없으면 다음 수집 때 기록됩니다.",
        "읽는 법: N위 = 일반 순위, 50위 밖 = 1쪽 일반 상품 1~50위 안에 없음(51위 이후 포함), 없음 = 일반 상품이 50개보다 적고 그 안에 없음, 결과 없음 = 검색 결과 없음, 실패 = 그날 측정이 모두 실패, 이동 = 쿠팡이 검색 결과가 아닌 쪽으로 보냄, - = 측정 없음. 하루 칸은 그날 마지막 회차의 성공값이고, 등록한 날부터 칸이 생깁니다.",
        "멈추기·다시 시작은 기록을 보존하고, 삭제는 30일 기록도 함께 지웁니다.",
        "수집 시간: 수집기 PC가 켜져 있을 때, 하루 " + (isNum(n) ? n : "n") + "회, " + hours + "에 잽니다.",
        "즉시 갱신 버튼은 없습니다. 쿠팡 차단을 막으려고 정해진 간격으로만 잽니다.",
        "광고 순번은 참고용입니다. 순위는 광고를 뺀 일반 상품 순서입니다.",
        "상승·하락(전회 대비)은 같은 시간대 회차끼리 비교합니다(하루 횟수를 바꾼 날은 비교할 짝이 없어 '전회 데이터 대기'로 보일 수 있습니다)."
      ];
      shell.guide.appendChild(el("ol", { className: "mi-coupang-rank-guide-list" }, items.map(function (text) { return el("li", { text: text }); })));
      shell.guide.open = wasOpen;
    }

    // ── 7. 복붙 템플릿 ──

    function buildTemplate() {
      shell.templateText = el("textarea", { className: "mi-input mi-coupang-rank-template-text", rows: "3", "aria-label": "광고주 안내 문구", "data-coupang-rank-template-text": true, placeholder: "'광고주 안내 문구 복사'를 누르면 여기에 문구가 채워집니다." });
      shell.template.appendChild(el("div", { className: "mi-coupang-rank-form-head" }, [
        el("h3", { text: "광고주 안내 문구" }),
        button("광고주 안내 문구 복사", "template-fill", { className: "mi-button" })
      ]));
      shell.template.appendChild(el("p", { className: "mi-coupang-rank-help", text: "누르면 아래 입력란을 채우고 복사합니다. 어디에도 자동으로 저장되지 않으니, 보낼 곳에 직접 붙여 넣으세요." }));
      shell.template.appendChild(shell.templateText);
    }

    function renderTemplate() {
      shell.template.hidden = !(currentScope() && canWrite() && !state.setupRequired);
    }

    function copyText(text, okMessage) {
      var done = function (copied) {
        setStatus(copied ? okMessage : "자동 복사가 막혔습니다. 입력란의 글을 직접 선택해 복사하세요.", copied ? "is-ok" : "is-warn");
      };
      try {
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
          return;
        }
      } catch (error) {}
      done(false);
    }

    function fillTemplate() {
      var text = templateText(checksPerDay());
      shell.templateText.value = text;
      copyText(text, "문구를 입력란에 채우고 복사했습니다. 보낼 곳에 붙여 넣으세요.");
    }

    // ── 총관리자 수집기 패널(§8.4) ──

    function buildOwnerFrame() {
      shell.ownerSummaryState = el("span", { className: "mi-coupang-rank-owner-state" });
      shell.owner.appendChild(el("summary", {}, [
        el("strong", { text: "수집기 관리" }),
        el("span", { className: "mi-badge", text: "총관리자 전용" }),
        shell.ownerSummaryState
      ]));
      shell.ownerNote = el("p", { className: "mi-code-status mi-coupang-rank-owner-note", "data-coupang-rank-owner-status": true, "aria-live": "polite", hidden: true });
      shell.ownerStatusSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "status" });
      shell.ownerSettingsSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "settings" });
      shell.ownerLimitsSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "limits" });
      shell.ownerTokensSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "tokens" });
      shell.ownerTokenBox = el("div", { className: "mi-coupang-rank-token-box", "data-coupang-rank-token-box": true, hidden: true });
      shell.ownerLinesSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "lines" });
      shell.ownerStatsSection = el("div", { className: "mi-coupang-rank-owner-section", "data-coupang-rank-owner-section": "stats" });
      var body = el("div", { className: "mi-coupang-rank-owner-body" }, [
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

    function setOwnerNote(text, tone) {
      state.owner.note = { text: text || "", tone: tone || "" };
      if (!shell) return;
      shell.ownerNote.textContent = state.owner.note.text;
      shell.ownerNote.hidden = !state.owner.note.text;
      shell.ownerNote.classList.remove("is-ok", "is-warn");
      if (state.owner.note.tone) shell.ownerNote.classList.add(state.owner.note.tone);
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
      var data = state.owner.data;
      var settings = data && data.settings;
      shell.ownerSummaryState.textContent = settings ? (settings.enabled ? "수집 켜짐" : "수집 꺼짐") : (state.owner.open ? "" : "펼치면 상태를 받습니다");
      shell.ownerSummaryState.className = "mi-coupang-rank-owner-state" + (settings ? (settings.enabled ? " is-ok" : " is-muted") : "");
    }

    function stopOwnerPoll() {
      if (state.owner.timer) {
        clearInterval(state.owner.timer);
        state.owner.timer = 0;
      }
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
          loadOwner();
        }, OWNER_POLL_MS);
      } else {
        stopOwnerPoll();
        // 연결 코드 원문은 패널을 닫으면 지운다(다시 볼 수 없다는 안내 그대로).
        state.owner.freshToken = null;
        renderTokenBox();
      }
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
      section.appendChild(el("div", { className: "mi-coupang-rank-owner-actions" }, [
        button("수집 켜기", "collector-enable", { className: "mi-button", disabled: settings.enabled === true || state.busy }),
        button("수집 끄기", "collector-disable", { disabled: settings.enabled !== true || state.busy }),
        button("쉬는 중 해제", "cooldown-clear", { className: "mi-link-button mi-coupang-rank-danger", disabled: !canClear || state.busy }),
        button("새로 받기", "owner-refresh", {})
      ]));

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
      } else if (result.patch.teamAccessEnabled === true || result.patch.clientViewEnabled === true) {
        var opened = [];
        if (result.patch.teamAccessEnabled === true) opened.push("운영팀 메뉴");
        if (result.patch.clientViewEnabled === true) opened.push("광고주 읽기 화면");
        if (!confirmAction(opened.join("·") + "에 C 30일 순위가 열립니다. 저장할까요?")) return;
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
        if (!confirmAction("수집을 켭니다. 수집기 PC가 켜져 있으면 다음 회차부터 쿠팡 검색을 잽니다. 켤까요?")) return;
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
      var lines = [
        "최근 24시간 회차: " + (runParts.length ? runParts.join(" · ") : "없음"),
        "지난 1시간 " + (isNum(stats.runsLastHour) ? stats.runsLastHour : 0) + "회 · 오늘 " + (isNum(stats.runsToday) ? stats.runsToday : 0) + "회" +
          (isNum(stats.avgDurationMs24h) ? " · 성공 평균 " + (Math.round(stats.avgDurationMs24h / 100) / 10) + "초" : ""),
        "48시간: 차단 " + (isNum(stats.blocked48h) ? stats.blocked48h : 0) + " · 빈 쪽 " + (isNum(stats.empty48h) ? stats.empty48h : 0) + " · 성공 " + (isNum(stats.success48h) ? stats.success48h : 0),
        "마지막 수집 " + (stats.lastRunAt ? kstStamp(stats.lastRunAt, todayKst) : "없음") + " · 마지막 성공 " + (stats.lastSuccessAt ? kstStamp(stats.lastSuccessAt, todayKst) : "없음") +
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

    // ── 이벤트 ──

    function onClick(event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var statusButton = target.closest("[data-coupang-rank-filter-status]");
      if (statusButton && host.contains(statusButton)) {
        state.filter.status = statusButton.getAttribute("data-coupang-rank-filter-status") || "all";
        renderFilterBar();
        renderBulkBar();
        renderList();
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
          runBulk("pause", [id]);
          return;
        case "resume":
          runBulk("resume", [id]);
          return;
        case "delete":
          deleteIds([id]);
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
        case "template-fill":
          fillTemplate();
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
        if (target.checked) state.selected.add(id);
        else state.selected.delete(id);
        renderBulkBar();
        syncGroupChecks();
        return;
      }
      if (target.hasAttribute("data-coupang-rank-group-select")) {
        var name = target.getAttribute("data-coupang-rank-group-select");
        visibleTrackers().forEach(function (tracker) {
          if (String(tracker.groupName || DEFAULT_GROUP) !== name) return;
          if (target.checked) state.selected.add(tracker.id);
          else state.selected.delete(tracker.id);
        });
        renderBulkBar();
        renderList();
        return;
      }
      if (target.hasAttribute("data-coupang-rank-filter-group")) {
        state.filter.group = target.value || "";
        renderFilterBar();
        renderBulkBar();
        renderList();
        return;
      }
      markDirty(target);
    }

    function markDirty(target) {
      if (!shell || !target.closest) return;
      var section = target.closest("[data-coupang-rank-owner-section]");
      if (section && (section === shell.ownerSettingsSection || section === shell.ownerLimitsSection || section === shell.ownerTokensSection)) {
        section.setAttribute("data-coupang-rank-dirty", "true");
      }
    }

    function syncGroupChecks() {
      Array.prototype.forEach.call(shell.list.querySelectorAll("[data-coupang-rank-group-select]"), function (check) {
        var name = check.getAttribute("data-coupang-rank-group-select");
        var items = visibleTrackers().filter(function (tracker) { return String(tracker.groupName || DEFAULT_GROUP) === name; });
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
          renderFilterBar();
          renderBulkBar();
          renderList();
        }, 150);
        return;
      }
      markDirty(target);
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

    host.addEventListener("click", onClick);
    host.addEventListener("change", onChange);
    host.addEventListener("input", onInput);
    host.addEventListener("submit", onSubmit);
    host.addEventListener("toggle", onToggle, true);

    if (observedRoot && typeof MutationObserver === "function") {
      observer = new MutationObserver(function () {
        var locked = observedRoot.classList.contains("is-locked");
        if (locked && !wasLocked) reset();
        wasLocked = locked;
      });
      observer.observe(observedRoot, { attributes: true, attributeFilter: ["class"] });
    }

    // ── 카드 '다음' 남은 시간 다시 계산(N30 은 60초 건강 신호마다 순위판을 다시 그린다) ──
    // 목록을 다시 받지 않고, 그려 둔 카드의 '다음' 글자와 상태 알약의 대기색만 바꾼다(입력 중인 칸·열린 측정 기록을 건드리지 않게).
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
        if (nextNode && nextNode.textContent !== "다음 " + text) nextNode.textContent = "다음 " + text;
        var stateNode = card.querySelector("[data-coupang-rank-state-pill]");
        if (stateNode) stateNode.classList.toggle("is-wait", text === "대기");
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
        state.listNote = { text: "", tone: "" };
        renderAll();
        return;
      }
      if (scope.key !== state.scopeKey) {
        state.scopeKey = scope.key;
        state.payload = null;
        state.partial = false;
        state.setupRequired = false;
        state.selected.clear();
        state.runs = {};
        state.editingGroupId = "";
        state.status = { text: "", tone: "" };
        state.listNote = { text: "", tone: "" };
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
      // 메뉴 한 번에 setScreen 과 hashchange 가 show() 를 두 번 부르고, 운영팀 세션 동기화도 scope-changed 와
      // auth-ready 로 두 번 부른다. 같은 범위를 받는 중이거나 2초 안에 받았으면 다시 보내지 않는다.
      loadList({ reuse: true, announce: true });
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
      clearTimeout(searchTimer);
      var destroyed = state.destroyed;
      state = freshState();
      state.destroyed = destroyed;
      pruneCache("");
      shell = null;
      host.replaceChildren();
    }

    function destroy() {
      reset();
      state.destroyed = true;
      if (observer) observer.disconnect();
      observer = null;
      host.removeEventListener("click", onClick);
      host.removeEventListener("change", onChange);
      host.removeEventListener("input", onInput);
      host.removeEventListener("submit", onSubmit);
      host.removeEventListener("toggle", onToggle, true);
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
      boardDays: boardDays,
      autoSummary: autoSummary,
      normalizeGroupInput: normalizeGroupInput,
      filterMatches: filterMatches,
      capacityText: capacityText,
      cacheKey: cacheKey,
      exportFileName: exportFileName,
      stripText: stripText,
      limitText: limitText,
      dayLabel: dayLabel,
      errorText: errorText,
      raiseReasonText: raiseReasonText,
      settingsPatch: settingsPatch,
      isRaise: isRaise,
      templateText: templateText
    }
  };
})();
