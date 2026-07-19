import assert from "node:assert/strict";
import test from "node:test";

import { cronAuthorized } from "./cron-auth.mjs";

function request(token = "") {
  return new Request("https://insight.momentlabs.co.kr/api/naver-rank-cron", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test("accepts either Vercel or GitHub cron secret when both are configured", () => {
  const env = {
    CRON_SECRET: "vercel-cron-secret-value",
    MI_RANK_CRON_SECRET: "github-cron-secret-value",
  };

  assert.equal(cronAuthorized(request(env.CRON_SECRET), env), true);
  assert.equal(cronAuthorized(request(env.MI_RANK_CRON_SECRET), env), true);
});

test("fails closed for missing, malformed, or unrelated cron credentials", () => {
  const env = {
    CRON_SECRET: "vercel-cron-secret-value",
    MI_RANK_CRON_SECRET: "github-cron-secret-value",
  };

  assert.equal(cronAuthorized(request("unrelated-secret-value"), env), false);
  assert.equal(cronAuthorized(request(), env), false);
  assert.equal(cronAuthorized(request(env.CRON_SECRET), {}), false);
});
