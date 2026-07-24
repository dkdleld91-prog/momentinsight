import assert from "node:assert/strict";
import test from "node:test";
import app from "./index.mjs";

test("health is a lightweight liveness response with runtime trace headers", async () => {
  const response = await app.fetch(new Request("https://insight.momentlabs.co.kr/health", {
    headers: { "x-request-id": "health-check-1234" },
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "live");
  assert.equal(body.region, String(process.env.VERCEL_REGION || "local"));
  assert.equal(response.headers.get("x-request-id"), "health-check-1234");
});

test("readiness route returns method not allowed instead of falling through", async () => {
  const response = await app.fetch(new Request("https://insight.momentlabs.co.kr/api/ready", {
    method: "POST",
  }));
  assert.equal(response.status, 405);
  assert.equal((await response.json()).ok, false);
});
