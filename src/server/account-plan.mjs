// 계정 플랜·이용 기간 상태(대표 결정 2026-09-07). 총관리자 API·세션 응답·세션 게이트·화면이 같은 계산을 쓴다.
// 순위 수집과 무관하다. 시각은 전부 UTC ISO 로 다루고 날짜 문구는 화면이 Asia/Seoul 로 그린다.

export const PLAN_GRACE_DAYS = 5; // 만료 후 연장 유예. 지나면 삭제 대상(2단계).
export const PLAN_WARN_DAYS = 3; // 만료 3일 전부터 팝업.
export const PLAN_DEFAULT_DAYS = 30;
export const PLAN_NAMES = new Map([
  ["basic", "기본"],
  ["premium", "프리미엄"],
  ["custom", "직접"],
]);

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizePlanName(value) {
  const key = String(value || "").trim().toLowerCase();
  return PLAN_NAMES.has(key) ? key : "";
}

export function planLabel(value) {
  return PLAN_NAMES.get(normalizePlanName(value)) || "";
}

export function normalizePlanDays(value, fallback = PLAN_DEFAULT_DAYS) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) return fallback;
  return parsed;
}

// row: clients 행(plan_* 열). 열이 아직 없으면(마이그레이션 전) 전부 undefined → 무기한으로 본다.
export function planStatus(row, nowMs = Date.now()) {
  const expiresMs = Date.parse(String(row?.plan_expires_at || ""));
  const startedMs = Date.parse(String(row?.plan_started_at || ""));
  const name = normalizePlanName(row?.plan_name);
  const days = normalizePlanDays(row?.plan_days);
  if (!Number.isFinite(expiresMs)) {
    return {
      name,
      label: planLabel(name),
      days,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
      expiresAt: null,
      daysLeft: null,
      graceEndsAt: null,
      graceDaysLeft: null,
      state: "none",
    };
  }
  const graceEndsMs = expiresMs + PLAN_GRACE_DAYS * DAY_MS;
  const daysLeft = Math.ceil((expiresMs - nowMs) / DAY_MS);
  const graceDaysLeft = Math.ceil((graceEndsMs - nowMs) / DAY_MS);
  let state = "active";
  if (nowMs >= graceEndsMs) state = "delete_due";
  else if (nowMs >= expiresMs) state = "expired";
  else if (daysLeft <= PLAN_WARN_DAYS) state = "expiring";
  return {
    name,
    label: planLabel(name),
    days,
    startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
    expiresAt: new Date(expiresMs).toISOString(),
    daysLeft,
    graceEndsAt: new Date(graceEndsMs).toISOString(),
    graceDaysLeft,
    state,
  };
}

export function planRestricted(status) {
  return Boolean(status) && (status.state === "expired" || status.state === "delete_due");
}

// 연장: 아직 남아 있으면 만료일에 더하고, 이미 지났으면 지금부터 센다.
export function extendedExpiry(row, days, nowMs = Date.now()) {
  const current = Date.parse(String(row?.plan_expires_at || ""));
  const base = Number.isFinite(current) && current > nowMs ? current : nowMs;
  return new Date(base + normalizePlanDays(days) * DAY_MS).toISOString();
}

// 구글 연동 기한(대표 지시 2026-09-08 "30일 카운트다운, 연동 안 한 계정은 없어지는 걸로"): 이 날(Asia/Seoul 23:59:59)까지
// 구글을 연결하지 않은 광고주 코드 계정은 크론이 만료일을 이 날로 찍는다 → 기존 흐름(만료 팝업·읽기 전용 → 유예 5일 → 삭제).
// 화면 카운트다운(public/mi-google-nudge.js 의 LINK_DEADLINE)과 같은 날짜여야 한다. 총관리자 코드·체험 계정은 대상이 아니다.
export const GOOGLE_LINK_DEADLINE = "2026-10-07";
export const GOOGLE_LINK_EXPIRY_NOTE = "구글 미연동 · 자동 만료";
export function googleLinkDeadlineIso() {
  return expiryFromDate(GOOGLE_LINK_DEADLINE);
}

// 만료일 직접 지정: 그 날짜의 Asia/Seoul 23:59:59 로 맞춘다("09/19까지"가 그날 끝까지라는 뜻).
export function expiryFromDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const endOfDayUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59) - 9 * 60 * 60 * 1000;
  if (!Number.isFinite(endOfDayUtc)) return null;
  return new Date(endOfDayUtc).toISOString();
}
