import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAN_GRACE_DAYS,
  expiryFromDate,
  extendedExpiry,
  normalizePlanDays,
  normalizePlanName,
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
