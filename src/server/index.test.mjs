import assert from "node:assert/strict";
import test from "node:test";
import app from "./index.mjs";
import {
  LOCAL_WORKER_BODY_MAX_BYTES,
  LOCAL_WORKER_ENDPOINT_PATH,
} from "./naver-shopping/local-worker-contract.mjs";

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

test("local shopping worker accepts 4 MiB and rejects the next byte before authentication", async () => {
  assert.equal(LOCAL_WORKER_BODY_MAX_BYTES, 4 * 1024 * 1024);
  const accepted = await app.fetch(new Request(`https://insight.momentlabs.co.kr${LOCAL_WORKER_ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(LOCAL_WORKER_BODY_MAX_BYTES),
  }));
  assert.notEqual(accepted.status, 413);

  const rejected = await app.fetch(new Request(`https://insight.momentlabs.co.kr${LOCAL_WORKER_ENDPOINT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(LOCAL_WORKER_BODY_MAX_BYTES + 1),
  }));
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).ok, false);
});
