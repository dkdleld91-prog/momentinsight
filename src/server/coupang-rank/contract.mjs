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
