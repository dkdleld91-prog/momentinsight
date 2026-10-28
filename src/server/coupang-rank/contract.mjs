// C 30일 순위 공용 계약(서버 쪽). tools/coupang-rank-collector/lib/contract.mjs 와 같은 이름의 값은 같아야 한다
// (scripts/coupang-rank-contract-parity.test.mjs). 이 모듈은 다른 서버 모듈을 import 하지 않는다.
export const COUPANG_TRACKERS_PATH = "/api/coupang-rank-trackers";
export const COUPANG_WORKER_PATH = "/api/coupang-rank-worker";
export const PUBLIC_ORIGIN = "https://insight.momentlabs.co.kr";
export const COLLECTOR_PUBLIC_PATH = "/coupang-collector";
export const COLLECTOR_BUNDLE_VERSION = "1.0.0";
export const COLLECTOR_VERSION_HEADER = "x-mi-coupang-collector";
export const COLLECTOR_TOKEN_PATTERN = /^mic1_[A-Za-z0-9_-]{43}$/;
export const VERSION_PATTERN = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
export const RELEASE_PATTERN = /^[0-9a-f]{7}$/;
export const UNKNOWN_RELEASE = "0000000";
export const WORKER_BODY_MAX_BYTES = 65536;
export const TRACKERS_BODY_MAX_BYTES = 32768;
export const RUN_BUDGET_SECONDS = 480;
export const CLAIM_MIN_REMAINING_SECONDS = 90;
export const MIN_BROWSER_GAP_SECONDS = 30;
export const BROWSER_HARD_CAP_SECONDS = 120;
export const NAV_TIMEOUT_MS = 45000;
export const LEASE_SECONDS = 180;
export const RECORD_MAX_AGE_MINUTES = 30;
export const OUTBOX_MAX_AGE_MINUTES = 25;
export const RANK_TOP = 50;
export const ORGANIC_MAX = 100;
export const ADS_MAX = 30;
export const TITLE_MAX = 80;
export const SLOT_MAX = 200;
export const MAX_ACTIVE_COLLECTORS = 3;
export const TRACKER_LIST_MAX = 500;
export const BULK_IDS_MAX = 100;
export const KEYWORD_MAX = 50;
export const GROUP_MAX = 30;
export const DEFAULT_GROUP = "기본 그룹";
export const KEYWORD_KEY_CASE_FOLD = true;
export const RATE_LADDER_PER_HOUR = Object.freeze([12, 24, 40, 60]);
export const PAGE_STATUSES = Object.freeze(["ok", "blocked", "timeout", "error"]);
export const RUN_STATUSES = Object.freeze(["leased", "expired", "released", "ok", "noresult", "partial", "blocked", "empty", "error", "timeout", "unsupported"]);
export const SUCCESS_RUN_STATUSES = Object.freeze(["ok", "noresult"]);
export const DAY_RESULTS = Object.freeze(["found", "out", "short", "noresult", "failed", "unsupported"]);
export const WINDOW_MODES = Object.freeze(["normal", "offscreen", "minimized"]);
export const RELEASE_REASONS = Object.freeze(["guard", "shutdown", "budget"]);
export const PLATFORMS = Object.freeze(["windows", "macos"]);
export const BROWSER_KINDS = Object.freeze(["edge", "chrome"]);
export const BLOCKED_HTTP_STATUSES = Object.freeze([403, 429, 503]);
export const RECORD_FINAL_CODES = Object.freeze(["JOB_NOT_FOUND", "JOB_LEASE_MISMATCH", "JOB_KEYWORD_MISMATCH", "JOB_TOO_OLD", "PAGE_INVALID", "RUN_STATUS_INVALID", "BODY_INVALID"]);
export function compareVersion(left, right) {
  const a = String(left || "0.0.0").split(".").map(Number);
  const b = String(right || "0.0.0").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
  }
  return 0;
}

// ── 여기부터 WP0 추가: 명세 §3(공유 계약) 값 중 위 원문(§5.1)에 없는 것 ──
// 위 원문 줄은 한 글자도 바꾸지 않는다. 아래 값은 §3 표를 그대로 옮긴 것이며, 어긋나면 §3 을 따른다.
// 수집기 사본(lib/contract.mjs)에 같은 이름이 있으면 값도 같아야 한다(패리티 테스트).

// §3.1 이름·경로·상수
export const TRACKER_LIST_FETCH_LIMIT = 501;
export const CLAIM_THROTTLE_MAX_SECONDS = 20;
export const DEFAULT_WINDOW_MODE = "offscreen";

// §3.2 열거값(배열 순서도 §3.2 그대로. COLLECTOR_STATES 는 판정 순서)
export const TRACKER_STATUSES = Object.freeze(["active", "paused"]);
export const SNAPSHOT_RESULTS = Object.freeze(["found", "out", "short", "noresult"]);
export const TRENDS = Object.freeze(["up", "down", "same", "enter", "exit", "new"]);
export const ATTENTION_REASONS = Object.freeze(["drop10", "exit", "keyword_failing", "unsupported"]);
export const COLLECTOR_STATES = Object.freeze(["setup_required", "not_connected", "disabled", "review", "budget", "cooldown", "outdated", "offline", "delayed", "idle_hours", "ok"]);
export const NEXT_CHECK_STATES = Object.freeze(["scheduled", "due", "replan", "paused"]);
export const CLAIM_WAIT_REASONS = Object.freeze(["disabled", "review", "budget", "cooldown", "window", "gap", "hourly_cap", "daily_cap", "idle"]);
export const HELLO_STATES = Object.freeze(["run", "disabled", "review", "budget", "cooldown", "window"]);
export const COOLDOWN_REASONS = Object.freeze(["blocked", "empty", "empty_escalated", "error_streak", "error_escalated"]);
export const BLOCKING_COOLDOWN_REASONS = Object.freeze(["blocked", "empty_escalated", "error_escalated"]);
export const BUDGET_REASONS = Object.freeze(["storage", "database"]);
export const GUARD_MODES = Object.freeze(["none", "n30-chrome"]);
export const SCOPE_MODES = Object.freeze(["owner", "advertiser", "team-account"]);
export const FIRST_CHECKS = Object.freeze(["recorded", "queued"]);

// §3.4 오류 코드 → HTTP 상태. 응답 모양은 { ok:false, code, message, ... }.
// SESSION_REQUIRED·TRIAL_LOCKED·PLAN_EXPIRED 는 게이트가 이미 쓰는 기존 코드다(여기 값은 참고용, 게이트는 고치지 않는다).
export const ERROR_HTTP_STATUS = Object.freeze({
  SESSION_REQUIRED: 401,
  COUPANG_SESSION_REQUIRED: 401,
  TRIAL_LOCKED: 403,
  PLAN_EXPIRED: 403,
  COUPANG_TEAM_NOT_OPEN: 403,
  COUPANG_CLIENT_NOT_OPEN: 403,
  COUPANG_READ_ONLY: 403,
  COUPANG_SCOPE_NO_CREATE: 403,
  COUPANG_OWNER_ONLY: 403,
  COUPANG_SCOPE_NOT_FOUND: 403,
  COUPANG_ACCESS_DENIED: 403,
  COUPANG_KEYWORD_LIMIT_REACHED: 403,
  COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED: 403,
  COUPANG_KEYWORD_REQUIRED: 400,
  COUPANG_KEYWORD_INVALID: 400,
  COUPANG_PRODUCT_URL_REQUIRED: 400,
  COUPANG_SHORT_LINK_UNSUPPORTED: 400,
  COUPANG_NOT_PRODUCT_URL: 400,
  COUPANG_GROUP_INVALID: 400,
  COUPANG_IDS_INVALID: 400,
  COUPANG_ACTION_INVALID: 400,
  COUPANG_SETTINGS_INVALID: 400,
  COUPANG_LIMIT_INVALID: 400,
  COUPANG_COLLECTOR_LABEL_INVALID: 400,
  COUPANG_RAISE_CONFIRM_REQUIRED: 400,
  COUPANG_TRACKER_NOT_FOUND: 404,
  COUPANG_COLLECTOR_NOT_FOUND: 404,
  COUPANG_RAISE_NOT_ALLOWED: 409,
  COUPANG_COLLECTOR_LIMIT: 409,
  COUPANG_NO_COLLECTOR: 409,
  BODY_TOO_LARGE: 413,
  METHOD_NOT_ALLOWED: 405,
  COUPANG_SETUP_REQUIRED: 503,
  COUPANG_RANK_TRACKERS_FAILED: 500,
  COUPANG_RANK_WORKER_FAILED: 500,
  COLLECTOR_AUTH_REJECTED: 401,
  BODY_INVALID: 400,
  ACTION_INVALID: 400,
  COLLECTOR_VERSION_INVALID: 400,
  PAGE_INVALID: 400,
  RUN_STATUS_INVALID: 400,
  RELEASE_REASON_INVALID: 400,
  COLLECTOR_UPDATE_REQUIRED: 426,
  JOB_NOT_FOUND: 404,
  JOB_LEASE_MISMATCH: 409,
  JOB_KEYWORD_MISMATCH: 409,
  JOB_TOO_OLD: 410,
  // ① 지금 확인(spec-manual §6.2 + 2026-10-23 재구현). 모두 4xx(5xx 는 위 3개로 고정 — error-safety 테스트).
  COUPANG_MANUAL_SETUP_REQUIRED: 409,
  COUPANG_MANUAL_OFF: 403,
  COUPANG_MANUAL_BUDGET: 409,
  COUPANG_MANUAL_STOPPED: 409,
  COUPANG_MANUAL_PAUSED: 409, // 차단 뒤 30분 쉼(c30-4)
  COUPANG_MANUAL_COOLDOWN: 409,
  COUPANG_MANUAL_HOURS: 409,
  COUPANG_MANUAL_BUSY: 409,
  COUPANG_MANUAL_DAILY_CAP: 409,
  COUPANG_MANUAL_GAP: 409,
  COUPANG_MANUAL_TRACKER_PAUSED: 409,
  COUPANG_MANUAL_TRACKER_INELIGIBLE: 409,
  COUPANG_MANUAL_CLAIM_NOT_FOUND: 404,
  COUPANG_MANUAL_CLAIM_MISMATCH: 409,
  COUPANG_MANUAL_CLAIM_CLOSED: 409,
  COUPANG_MANUAL_CLAIM_USED: 409,
  COUPANG_MANUAL_CLAIM_NOT_VERIFIED: 409,
  COUPANG_MANUAL_CLAIM_EXPIRED: 410,
  COUPANG_MANUAL_RECORD_INVALID: 400,
  // 지금 확인 ↔ 자동 수집이 함께 켜지지 않게(자동 claim 이 수동 간격·그날 중지를 보기 전까지). 핸들러만 거절한다.
  COUPANG_COLLECTOR_MANUAL_CONFLICT: 409, // 수집 켜기 거절: 지금 확인이 켜져 있거나 오늘 지금 확인이 차단으로 멈춤
  COUPANG_MANUAL_COLLECTOR_CONFLICT: 409, // 지금 확인 켜기 거절: 자동 수집이 켜져 있음
});

// §3.5 수집기 로컬 오류 코드(errorCode·로그). 서버는 형식만 검사하고, foreign_navigation 은 서버가 덮어쓴다.
export const COLLECTOR_ERROR_CODE_PATTERN = /^[a-z0-9_]{1,60}$/;
export const FOREIGN_NAVIGATION_ERROR_CODE = "foreign_navigation";
export const COLLECTOR_ERROR_CODES = Object.freeze([
  "page_timeout", "cdp_unreachable", "cdp_error", "devtools_port_timeout", "browser_launch_failed", "browser_exit_early", "browser_hard_cap", "extract_failed", "shutdown",
  "foreign_navigation",
  "profile_cleanup_failed", "browser_orphan_killed",
  "guard_n30_chrome_missing", "guard_n30_tick_window", "guard_n30_tick_unknown", "guard_n30_watchdog_busy",
  "node_version_unsupported", "config_invalid", "token_missing",
  "api_unreachable", "api_route_missing", "record_dropped", "outbox_dropped",
]);

// ── ① 지금 확인(spec-manual §6, 2026-10-23 재구현) ──
// 흐름: 화면 POST manual-claim(총관리자 세션) → 확장 GET view=manual-verify(같은 크롬의 총관리자 세션 쿠키 + 요청 토큰
// 머리글, 창을 열기 직전) → 창 열고 읽기 → [차단 신호면 확장 GET view=manual-stop] → 화면 POST manual-record.
// 확장 확인이 GET 인 이유: 세션 게이트가 POST 에 출처(Origin)·CSRF 를 요구하는데 확장 서비스 워커의 출처는
// chrome-extension:// 이라 운영 허용 목록(https 만)에 들 수 없다. GET 은 게이트가 출처·CSRF 를 보지 않는다.
// 서버는 시간 판정에 서버 시계만 쓴다(확장·화면 시계를 받지 않는다).
export const MANUAL_EXTENSION_ID = "onbmdfamcmbljplkgalameendlmgnjeg"; // manifest key 에서 계산(확장 테스트가 대조)
export const MANUAL_EXTENSION_VERSION = "1.0.2"; // 내려받기 zip 의 버전(1.0.2 = 차단 뒤 30분 쉼 · 같은 날 두 번째 차단이면 그날 중지)
// 화면이 '새 버전으로 바꿔 주세요'로 막는 아래 버전. 1.0.0 은 그대로 받는다(진단만 없음 — 서버는 확장 버전을 형식만 본다).
export const MANUAL_MIN_EXTENSION_VERSION = "1.0.0";
export const MANUAL_EXTENSION_ZIP_PATH = "/coupang-check/mi-coupang-check-1.0.2.zip";
export const MANUAL_EXTENSION_FOLDER = "mi-coupang-check"; // zip 안 폴더 이름(버전 없음 — 업데이트 때 같은 자리에 덮어 풀기)
export const MANUAL_ALLOWED_ROLES = Object.freeze(["owner"]); // 공개 순서: owner → team → client
export const MANUAL_CLAIM_TTL_SECONDS = 60; // 요청 뒤 이 안에 확장 확인이 와야 한다(SQL interval '60 seconds')
export const MANUAL_SEARCH_WINDOW_SECONDS = 150; // 확인 뒤 '검색 중'으로 보는 시간(SQL interval '150 seconds')
export const MANUAL_RECORD_MAX_AGE_MINUTES = 10; // 요청 뒤 이만큼 지나면 결과를 저장하지 않는다(SQL interval '10 minutes')
export const MANUAL_MIN_MEASURE_SECONDS = 5; // 확인 뒤 이보다 빨리 온 목록 결과는 꾸민 것으로 본다(SQL interval '5 seconds')
export const MANUAL_CLAIM_KEEP_DAYS = 60; // 요청 표 보관(SQL interval '60 days')
export const MANUAL_MIN_GAP_SECONDS = 180; // SQL 제약 하한(c30-2 기본값)
export const MANUAL_DEFAULT_GAP_SECONDS = 240; // 대표 결정 2026-10-27(c30-4 기본값·지금 행)
// 차단 뒤 쉼(대표 결정 2026-10-28, c30-5): 차단될 때마다 30분 쉼(SQL interval '30 minutes'), 차단 때문에 그날 중지는 없다.
// (c30-4 는 같은 날 두 번째 차단이면 그날 중지였다 — c30-5 SQL 전 서버.)
export const MANUAL_PAUSE_MINUTES = 30;
export const MANUAL_MAX_PER_DAY = 30; // 대표 결정(SQL 기본값·제약 상한)
export const MANUAL_FROM_HOUR = 9; // 대표 결정(KST, SQL 기본값·제약)
export const MANUAL_TO_HOUR = 19;
export const MANUAL_RECORD_BODY_MAX_BYTES = 65536; // manual-record 만(= WORKER_BODY_MAX_BYTES), 나머지는 TRACKERS_BODY_MAX_BYTES
export const MANUAL_TOKEN_PATTERN = /^mcm1_[A-Za-z0-9_-]{43}$/;
export const MANUAL_VERIFY_VIEW = "manual-verify";
export const MANUAL_STOP_VIEW = "manual-stop";
export const MANUAL_CLAIM_ID_PARAM = "claimId";
export const MANUAL_STOP_REASON_PARAM = "reason";
export const MANUAL_CLAIM_TOKEN_HEADER = "x-mi-coupang-claim-token";
export const MANUAL_STATES = Object.freeze(["setup_required", "off", "budget", "stopped", "paused", "cooldown", "hours", "busy", "daily_cap", "gap", "ready"]);
export const MANUAL_OUTCOMES = Object.freeze(["measured", "not_started", "lost"]);
export const MANUAL_CLAIM_STATUSES = Object.freeze(["open", "verified", "recorded", "cancelled", "lost", "expired"]);
// 차단 사유(settings.manual_stopped_code · c30-4 manual_block_code). 화면은 사유별로 다른 문구를 쓴다(원인을 단정하지 않는다).
// c30-5 뒤: 차단될 때마다 30분 쉼(SQL coupang_rank_manual_stop 이 센다 — 센 수는 기록용). c30-4 SQL 뒤·c30-5 전: 첫 차단 30분 쉼,
// 같은 날 두 번째 그날 중지. c30-4 SQL 전: 한 번에 그날 중지.
// blocked_http_*: 쿠팡 응답 403·429·503 / blocked_text: 차단 문구 / blocked_page: 확장이 차단으로 본 쪽 /
// login_redirect: 로그인 화면으로 보냄 / page_unreadable: 쿠팡이 검색 밖 쪽으로 보내 읽지 못함(D1) /
// extension_reported: 확장이 '오늘 차단을 봤다'고만 알림(시작 못 함 blocked_today·blocked_pause·report_pending).
export const MANUAL_STOP_CODES = Object.freeze([
  "blocked_http_403", "blocked_http_429", "blocked_http_503", "blocked_text", "blocked_page",
  "login_redirect", "page_unreadable", "extension_reported",
]);
// 확장이 '오늘 차단을 봤다'는 뜻으로 시작하지 않은 코드: blocked_today(그날 중지한 날 — 1.0.1 은 첫 차단, 1.0.2 는 두 번째 차단),
// blocked_pause(1.0.2: 첫 차단 뒤 30분 쉬는 중), report_pending(차단 결과를 아직 서버에 못 보냄). 서버는 셋 다 차단 알림
// (extension_reported)으로 받는다(확인 없는 요청이라 서버가 그 날 차단을 아직 모를 때만 첫 차단으로 센다).
export const MANUAL_STOP_NOT_STARTED_CODES = Object.freeze(["blocked_today", "blocked_pause", "report_pending"]);
export const MANUAL_UNREADABLE_ERROR_CODE = "page_unreadable";
export const MANUAL_QUERY_MISMATCH_ERROR_CODE = "query_mismatch";
export const MANUAL_USER_NAVIGATED_ERROR_CODE = "user_navigated";
// user_navigated 중 측정 중 쿼리만 바뀐 회차: 확장이 page.changedParams 에 바뀐 쿼리 이름(값 없음)을 싣는다(확장 protocol 과 같은 상한).
// 서버는 그 회차 final_path 에 '경로?이름&이름'으로 남긴다(manual.mjs manualNavigatedFinalPath, 마이그레이션 없음).
export const MANUAL_CHANGED_PARAMS_MAX = 10;
export const MANUAL_CHANGED_PARAM_NAME_MAX = 40; // 코드 포인트
// 확장 1.0.1 실패 진단(page.diagnostics 또는 본문 diagnostics): 서버가 모양·크기를 보고 통과한 것만 회차 diagnostics 칸
// (대표 SQL docs/sql/c30-3-run-diagnostics.sql)에 따로 둔다. 진단이 틀려도 순위 기록은 거절하지 않는다(진단만 버림).
export const MANUAL_DIAGNOSTICS_SCHEMA = 1; // = 확장 DIAGNOSTICS_SCHEMA
export const MANUAL_DIAGNOSTICS_MAX_BYTES = 4096; // 직렬화(UTF-8) 상한 = 확장 DIAGNOSTICS_MAX_BYTES
// 값 개수 상한(= 확장 DIAGNOSTICS_NODES_MAX). jsonb 는 작은 수·짧은 칸마다 글자보다 크게 저장돼(값 하나에 최대 약 16바이트 더)
// 직렬화 4KB 만으로는 SQL 칸 제약(pg_column_size ≤ 8192)을 넘을 수 있다. 4KB + 값 120개면 최악도 8KB 안(PGlite 시험으로 잰다).
export const MANUAL_DIAGNOSTICS_NODES_MAX = 120;
export const MANUAL_DIAGNOSTICS_TEXT_MAX = 200; // 글자 칸 하나의 상한(코드 포인트) = 확장 DIAG_TEXT_MAX
// 진단 맨 위 칸 이름(= 확장 DIAGNOSTICS_TOP_KEYS). 이 밖의 칸이 있으면 진단을 버린다.
export const MANUAL_DIAGNOSTICS_TOP_KEYS = Object.freeze([
  "v", "ext", "ok", "code", "ms", "load", "retry", "tries", "doc", "firstDoc", "hidden", "unexpected", "seen", "cut",
]);
// 아래 세 목록은 화면·확장 공용 이름이다. 서버는 outcomeCode·errorCode 의 형식(^[a-z0-9_]{1,60}$)만 검사한다.
export const MANUAL_EXTENSION_ERROR_CODES = Object.freeze([
  "page_timeout", "window_closed", "browser_hard_cap", "page_load_failed", "page_unreadable", "extract_failed", "user_navigated",
]);
export const MANUAL_NOT_STARTED_CODES = Object.freeze([
  "incognito_not_allowed", "incognito_window_open", "host_access_withheld", "busy", "too_soon", "bad_request",
  "window_create_failed", "window_create_null", "window_closed_early", "verify_refused", "verify_unreachable", "blocked_today", "blocked_pause", "report_pending", "extension_error",
  "extension_missing", "extension_outdated", "origin_rejected", "browser_unsupported",
]);
export const MANUAL_LOST_CODES = Object.freeze(["extension_no_response", "extension_timeout"]);
