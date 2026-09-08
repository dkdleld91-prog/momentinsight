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

// 유예 일수는 행마다 다르다(대표 결정 2026-09-08 "구글 연동 안 된 사람은 읽기 전용에서 3일 뒤 삭제"): 크론이 plan_note 에
// "구글 미연동" 을 남긴 계정은 3일, 그 밖의 만료는 5일. 게이트·세션·총관리자·크론이 전부 이 계산을 쓴다.
export function isGoogleUnlinkedExpiry(row) {
  return /구글 미연동/.test(String(row?.plan_note || ""));
}

export function planGraceDays(row) {
  return isGoogleUnlinkedExpiry(row) ? GOOGLE_LINK_GRACE_DAYS : PLAN_GRACE_DAYS;
}

// row: clients 행(plan_* 열). 열이 아직 없으면(마이그레이션 전) 전부 undefined → 무기한으로 본다.
export function planStatus(row, nowMs = Date.now()) {
  const expiresMs = Date.parse(String(row?.plan_expires_at || ""));
  const startedMs = Date.parse(String(row?.plan_started_at || ""));
  const name = normalizePlanName(row?.plan_name);
  const days = normalizePlanDays(row?.plan_days);
  const graceDays = planGraceDays(row);
  if (!Number.isFinite(expiresMs)) {
    return {
      name,
      label: planLabel(name),
      days,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
      expiresAt: null,
      daysLeft: null,
      graceDays,
      graceEndsAt: null,
      graceDaysLeft: null,
      state: "none",
    };
  }
  const graceEndsMs = expiresMs + graceDays * DAY_MS;
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
    graceDays,
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

// 구글 연동 기한(대표 지시 2026-09-08 "지금부터 30일은 구글 연동 기간"): 이 날(Asia/Seoul 23:59:59)까지가 연동 기간이다.
// - 연결하지 않은 광고주 코드 계정: 크론이 만료일을 이 날로 찍는다 → 읽기 전용 → 유예 3일(GOOGLE_LINK_GRACE_DAYS) → 삭제.
// - 연결한 광고주(무기한 상태): 기한 다음 날(10/08)부터 30일(GOOGLE_LINK_PLAN_DAYS) 이용 기간을 크론이 시작한다 → 이후는 일반 플랜 흐름.
// 화면 카운트다운(public/mi-google-nudge.js 의 LINK_DEADLINE)과 같은 날짜여야 한다. 총관리자 코드·체험 계정은 대상이 아니다.
export const GOOGLE_LINK_DEADLINE = "2026-10-07";
export const GOOGLE_LINK_EXPIRY_NOTE = "구글 미연동 · 자동 만료";
export const GOOGLE_LINK_GRACE_DAYS = 3; // 미연동 만료 뒤 삭제까지(대표 결정 2026-09-08 "읽기 전용에서 3일 뒤 삭제").
export const GOOGLE_LINK_PLAN_DAYS = 30; // 연동한 계정의 첫 이용 기간(대표 결정 2026-09-08 "30일 지난 후부터 30일 카운팅").
export const GOOGLE_LINKED_PLAN_NOTE = "구글 연동 · 기한 뒤 30일 이용";
export function googleLinkDeadlineIso() {
  return expiryFromDate(GOOGLE_LINK_DEADLINE);
}

// 연동한 계정의 이용 기간: 기한 다음 날 ~ 기한 + 30일(Asia/Seoul 23:59:59). 2026-10-07 기준 10/08 ~ 11/06.
export function googleLinkPlanStartDate() {
  return shiftDate(GOOGLE_LINK_DEADLINE, 1);
}
export function googleLinkPlanExpiryIso() {
  return expiryFromDate(shiftDate(GOOGLE_LINK_DEADLINE, GOOGLE_LINK_PLAN_DAYS));
}

function shiftDate(value, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days || 0)));
  return Number.isFinite(shifted.getTime()) ? shifted.toISOString().slice(0, 10) : null;
}

// 만료일 직접 지정: 그 날짜의 Asia/Seoul 23:59:59 로 맞춘다("09/19까지"가 그날 끝까지라는 뜻).
export function expiryFromDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const endOfDayUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59) - 9 * 60 * 60 * 1000;
  if (!Number.isFinite(endOfDayUtc)) return null;
  return new Date(endOfDayUtc).toISOString();
}
