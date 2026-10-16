// C 30일 순위 공용 계약(수집기 사본). src/server/coupang-rank/contract.mjs 와 같은 이름의 값은 같아야 한다
// (scripts/coupang-rank-contract-parity.test.mjs). 수집기는 이 폴더 밖을 import 하지 않으므로 값을 복사해 둔다.
// 명세 §9.2(공용 이름 목록) + §3. 서버 쪽 원문(§5.1) 줄을 그대로 옮긴다.
export const COUPANG_WORKER_PATH = "/api/coupang-rank-worker";
export const PUBLIC_ORIGIN = "https://insight.momentlabs.co.kr";
export const COLLECTOR_VERSION_HEADER = "x-mi-coupang-collector";
export const COLLECTOR_TOKEN_PATTERN = /^mic1_[A-Za-z0-9_-]{43}$/;
export const WORKER_BODY_MAX_BYTES = 65536;
export const RUN_BUDGET_SECONDS = 480;
export const CLAIM_MIN_REMAINING_SECONDS = 90;
export const MIN_BROWSER_GAP_SECONDS = 30;
export const BROWSER_HARD_CAP_SECONDS = 120;
export const NAV_TIMEOUT_MS = 45000;
export const LEASE_SECONDS = 180;
export const OUTBOX_MAX_AGE_MINUTES = 25;
export const ORGANIC_MAX = 100;
export const ADS_MAX = 30;
export const TITLE_MAX = 80;
export const SLOT_MAX = 200;
export const PAGE_STATUSES = Object.freeze(["ok", "blocked", "timeout", "error"]);
export const WINDOW_MODES = Object.freeze(["normal", "offscreen", "minimized"]);
export const RELEASE_REASONS = Object.freeze(["guard", "shutdown", "budget"]);
export const BLOCKED_HTTP_STATUSES = Object.freeze([403, 429, 503]);
export const RECORD_FINAL_CODES = Object.freeze(["JOB_NOT_FOUND", "JOB_LEASE_MISMATCH", "JOB_KEYWORD_MISMATCH", "JOB_TOO_OLD", "PAGE_INVALID", "RUN_STATUS_INVALID", "BODY_INVALID"]);
// 수집기는 순위를 세지 않는다(서버 SQL 이 센다). 패리티 테스트가 RANK_TOP 을 비교하므로(§6.8) 같은 값을 둔다.
export const RANK_TOP = 50;
// §3.1 기본 창 방식, §3.5 수집기 로컬 오류 코드(서버 사본과 같은 값)
export const DEFAULT_WINDOW_MODE = "offscreen";
export const COLLECTOR_ERROR_CODE_PATTERN = /^[a-z0-9_]{1,60}$/;
export const COLLECTOR_ERROR_CODES = Object.freeze([
  "page_timeout", "cdp_unreachable", "cdp_error", "devtools_port_timeout", "browser_launch_failed", "browser_exit_early", "browser_hard_cap", "extract_failed", "shutdown",
  "foreign_navigation",
  "profile_cleanup_failed", "browser_orphan_killed",
  "guard_n30_chrome_missing", "guard_n30_tick_window", "guard_n30_tick_unknown", "guard_n30_watchdog_busy",
  "node_version_unsupported", "config_invalid", "token_missing",
  "api_unreachable", "api_route_missing", "record_dropped", "outbox_dropped",
]);
// 수집기 묶음 버전. 서버의 COLLECTOR_BUNDLE_VERSION 과 같아야 한다.
export const COLLECTOR_VERSION = "1.0.0";
// 수집기에만 있는 값(§9.2 원문)
export const TOKEN_ENV = "MI_COUPANG_COLLECTOR_TOKEN";
export const OUTBOX_MAX_FILES = 20;
export const RECORD_RETRY_DELAYS_MS = Object.freeze([1000, 3000, 9000]);
export const AD_SOURCE_TYPE = "srp_product_ads";
export const PROFILE_DIR_PATTERN = /^mi-coupang-run-\d{13}-[0-9a-f]{8}$/;
export const STALE_PROFILE_MS = 3600000;
export const LOCK_STALE_MS = 1200000;
export const LOG_MAX_BYTES = 1048576;
export const NODE_MAJOR_MIN = 22;
export const NODE_MAJOR_MAX = 24;
export function coupangSearchUrl(keyword) {
  return `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}`;
}
export function clipTitle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return Array.from(text).slice(0, TITLE_MAX).join("").toWellFormed();
}
