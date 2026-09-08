import assert from "node:assert/strict";
import test from "node:test";
import {
  GOOGLE_LINK_DEADLINE,
  GOOGLE_LINK_EXPIRY_NOTE,
  GOOGLE_LINK_GRACE_DAYS,
  GOOGLE_LINK_PLAN_DAYS,
  PLAN_GRACE_DAYS,
  expiryFromDate,
  extendedExpiry,
  googleLinkDeadlineIso,
  googleLinkPlanExpiryIso,
  googleLinkPlanStartDate,
  normalizePlanDays,
  normalizePlanName,
  planGraceDays,
  planRestricted,
  planStatus,
} from "./account-plan.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-07T06:00:00Z");

test("plan status: no expiry means unlimited, and the warn/expired/grace boundaries follow the day math", () => {
  assert.equal(planStatus({}, NOW).state, "none");
  assert.equal(planStatus({ plan_expires_at: null }, NOW).expiresAt, null);

  const active = planStatus({ plan_expires_at: new Date(NOW + 10 * DAY).toISOString(), plan_name: "basic", plan_days: 30 }, NOW);
  assert.equal(active.state, "active");
  assert.equal(active.daysLeft, 10);
  assert.equal(active.label, "기본");
  assert.equal(active.days, 30);

  const expiring = planStatus({ plan_expires_at: new Date(NOW + 3 * DAY).toISOString() }, NOW);
  assert.equal(expiring.state, "expiring");
  assert.equal(expiring.daysLeft, 3);

  const expired = planStatus({ plan_expires_at: new Date(NOW - 1 * DAY).toISOString() }, NOW);
  assert.equal(expired.state, "expired");
  assert.equal(expired.graceDaysLeft, PLAN_GRACE_DAYS - 1);
  assert.equal(planRestricted(expired), true);

  const deleteDue = planStatus({ plan_expires_at: new Date(NOW - (PLAN_GRACE_DAYS + 1) * DAY).toISOString() }, NOW);
  assert.equal(deleteDue.state, "delete_due");
  assert.equal(planRestricted(deleteDue), true);
  assert.equal(planRestricted(active), false);
  assert.equal(planRestricted(planStatus({}, NOW)), false);
  assert.equal(expired.graceDays, PLAN_GRACE_DAYS);
});

// 구글 미연동 자동 만료는 유예 3일(대표 결정 2026-09-08 "읽기 전용에서 3일 뒤 삭제"), 그 밖의 만료는 5일 그대로.
test("plan status: unlinked-google expiry uses the 3-day grace, ordinary expiry keeps 5 days", () => {
  assert.equal(GOOGLE_LINK_GRACE_DAYS, 3);
  assert.equal(PLAN_GRACE_DAYS, 5);
  assert.equal(planGraceDays({ plan_note: GOOGLE_LINK_EXPIRY_NOTE }), 3);
  assert.equal(planGraceDays({ plan_note: null }), 5);
  assert.equal(planGraceDays({}), 5);

  const fourDaysAgo = new Date(NOW - 4 * DAY).toISOString();
  const unlinked = planStatus({ plan_expires_at: fourDaysAgo, plan_note: GOOGLE_LINK_EXPIRY_NOTE }, NOW);
  assert.equal(unlinked.graceDays, 3);
  assert.equal(unlinked.state, "delete_due");
  assert.equal(unlinked.graceEndsAt, new Date(NOW - 1 * DAY).toISOString());
  const ordinary = planStatus({ plan_expires_at: fourDaysAgo }, NOW);
  assert.equal(ordinary.graceDays, 5);
  assert.equal(ordinary.state, "expired");
  assert.equal(ordinary.graceDaysLeft, 1);

  const unlinkedFresh = planStatus({ plan_expires_at: new Date(NOW - 1 * DAY).toISOString(), plan_note: GOOGLE_LINK_EXPIRY_NOTE }, NOW);
  assert.equal(unlinkedFresh.state, "expired");
  assert.equal(unlinkedFresh.graceDaysLeft, 2);
});

// 연동한 계정의 첫 이용 기간: 기한 다음 날부터 30일(대표 결정 2026-09-08 "30일 지난 후부터 30일 카운팅").
test("google link plan window starts the day after the deadline and runs 30 days", () => {
  assert.equal(GOOGLE_LINK_DEADLINE, "2026-10-07");
  assert.equal(GOOGLE_LINK_PLAN_DAYS, 30);
  assert.equal(googleLinkDeadlineIso(), "2026-10-07T14:59:59.000Z");
  assert.equal(googleLinkPlanStartDate(), "2026-10-08");
  assert.equal(googleLinkPlanExpiryIso(), expiryFromDate("2026-11-06"));
  assert.equal(googleLinkPlanExpiryIso(), "2026-11-06T14:59:59.000Z");
  const status = planStatus({ plan_expires_at: googleLinkPlanExpiryIso(), plan_days: 30, plan_name: "basic" }, Date.parse("2026-10-08T00:00:00+09:00"));
  assert.equal(status.state, "active");
  assert.equal(status.daysLeft, 30);
});

test("plan helpers normalize names and days and extend from the later of now or the current expiry", () => {
  assert.equal(normalizePlanName("PREMIUM"), "premium");
  assert.equal(normalizePlanName("gold"), "");
  assert.equal(normalizePlanDays("45"), 45);
  assert.equal(normalizePlanDays("0"), 30);
  assert.equal(normalizePlanDays("abc", 7), 7);

  const future = new Date(NOW + 5 * DAY).toISOString();
  assert.equal(extendedExpiry({ plan_expires_at: future }, 30, NOW), new Date(NOW + 35 * DAY).toISOString());
  assert.equal(extendedExpiry({ plan_expires_at: new Date(NOW - 5 * DAY).toISOString() }, 30, NOW), new Date(NOW + 30 * DAY).toISOString());
  assert.equal(extendedExpiry({}, 10, NOW), new Date(NOW + 10 * DAY).toISOString());

  // 만료일 직접 지정은 그 날짜의 서울 23:59:59.
  assert.equal(expiryFromDate("2026-09-19"), "2026-09-19T14:59:59.000Z");
  assert.equal(expiryFromDate("2026/09/19"), null);
  assert.equal(expiryFromDate(""), null);
});
