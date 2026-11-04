import assert from "node:assert/strict";
import test from "node:test";
import { TRIAL_ACCOUNT_CODE_PATTERN, legacyTrialAccountCode, trialAccountCode } from "./trial-account-code.mjs";
import { trialLoginAccess } from "./handlers/google-calendar-api.mjs";
import { trialSampleRankRows } from "./trial-sample-trackers.mjs";

test("two trial users whose Google ids share the first 8 digits get different account codes (F72)", () => {
  const a = trialAccountCode("104111111111111111111");
  const b = trialAccountCode("104111119999999999999");
  assert.notEqual(a, b);
  assert.match(a, /^trial-[0-9a-f]{16}$/);
  assert.equal(a, trialAccountCode(" 104111111111111111111 "), "같은 계정은 늘 같은 값");
  assert.equal(legacyTrialAccountCode("104111111111111111111"), legacyTrialAccountCode("104111119999999999999"), "옛 형식은 겹쳤다");
  assert.equal(trialAccountCode(""), "");
  for (const code of [a, "trial-10411111"]) assert.ok(TRIAL_ACCOUNT_CODE_PATTERN.test(code), code);
  for (const code of ["trial-team01", "trial-", "trial-1041111", "ofyou"]) assert.equal(TRIAL_ACCOUNT_CODE_PATTERN.test(code), false, code);
});

test("trial login uses the hashed code, and the home feed sample rows use the same tag as the gate", () => {
  const access = trialLoginAccess("104111111111111111111");
  assert.equal(access.agencyCode, trialAccountCode("104111111111111111111"));
  assert.equal(access.clientId, access.agencyCode);
  const rows = trialSampleRankRows(access.agencyCode, Date.parse("2026-11-04T00:00:00Z"));
  const tag = access.agencyCode.replace(/^trial-/, "");
  assert.ok(rows.trackers.length > 0);
  assert.ok(rows.trackers.every((tracker) => String(tracker.id).startsWith(`trial-${tag}-`)), "예시 id 태그가 구분값 전체");
});
