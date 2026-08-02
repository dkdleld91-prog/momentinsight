import assert from "node:assert/strict";
import test from "node:test";

import {
  localWorkerAuthInput,
  localWorkerEnabled,
  signLocalWorkerRequest,
  verifyLocalWorkerSignature,
} from "./local-worker-auth.mjs";

const CURRENT_SECRET = "current-local-worker-secret-with-more-than-32-bytes";
const PREVIOUS_SECRET = "previous-local-worker-secret-with-more-than-32-bytes";
const NOW_SECONDS = 1_785_552_000;

function signedInput(overrides = {}, secret = CURRENT_SECRET) {
  const input = {
    timestamp: String(NOW_SECONDS),
    nonce: "worker-request-00000001",
    method: "POST",
    audience: "https://insight.momentlabs.co.kr",
    path: "/api/naver-shopping-local-worker",
    body: JSON.stringify({ action: "claim" }),
    ...overrides,
  };
  return {
    ...input,
    signature: signLocalWorkerRequest(secret, input),
  };
}

function verify(input, overrides = {}) {
  return verifyLocalWorkerSignature(input, {
    nowSeconds: NOW_SECONDS,
    env: {
      MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
      MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: CURRENT_SECRET,
      MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET_PREVIOUS: PREVIOUS_SECRET,
    },
    ...overrides,
  });
}

test("local worker is disabled unless explicitly enabled", () => {
  assert.equal(localWorkerEnabled({}), false);
  assert.equal(localWorkerEnabled({ MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true" }), true);
  assert.equal(localWorkerEnabled({ MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "TRUE" }), true);
});

test("accepts an exact HMAC over timestamp, nonce, method, path and raw body", () => {
  const result = verify(signedInput());
  assert.equal(result.ok, true);
  assert.equal(result.usedPreviousSecret, false);
  assert.match(result.bodySha256, /^[a-f0-9]{64}$/u);
});

test("accepts the previous secret only for controlled rotation", () => {
  const result = verify(signedInput({}, PREVIOUS_SECRET));
  assert.equal(result.ok, true);
  assert.equal(result.usedPreviousSecret, true);
});

test("fails closed when disabled or when the server secret is absent", () => {
  const input = signedInput();
  assert.deepEqual(
    verifyLocalWorkerSignature(input, { env: {} }),
    { ok: false, code: "LOCAL_WORKER_DISABLED", status: 404 },
  );
  assert.deepEqual(
    verifyLocalWorkerSignature(input, {
      env: { MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true" },
    }),
    { ok: false, code: "LOCAL_WORKER_SECRET_MISSING", status: 503 },
  );
  assert.deepEqual(
    verifyLocalWorkerSignature(input, {
      env: {
        MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED: "true",
        MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET: "too-short",
      },
    }),
    { ok: false, code: "LOCAL_WORKER_SECRET_MISSING", status: 503 },
  );
});

test("rejects body, method, audience, path and signature tampering", () => {
  const input = signedInput();
  for (const changed of [
    { ...input, body: JSON.stringify({ action: "submit" }) },
    { ...input, method: "GET" },
    { ...input, audience: "https://preview.example.invalid" },
    { ...input, path: "/api/other" },
    { ...input, signature: `v1=${"0".repeat(64)}` },
  ]) {
    assert.equal(verify(changed).code, "LOCAL_WORKER_SIGNATURE_INVALID");
  }
});

test("rejects stale, future and malformed timestamps", () => {
  assert.equal(verify(signedInput({ timestamp: String(NOW_SECONDS - 301) })).code, "LOCAL_WORKER_TIMESTAMP_EXPIRED");
  assert.equal(verify(signedInput({ timestamp: String(NOW_SECONDS + 301) })).code, "LOCAL_WORKER_TIMESTAMP_EXPIRED");
  const malformed = signedInput();
  malformed.timestamp = "not-a-time";
  assert.equal(verify(malformed).code, "LOCAL_WORKER_TIMESTAMP_INVALID");
});

test("rejects short or malformed nonces", () => {
  const input = signedInput();
  input.nonce = "short";
  assert.equal(verify(input).code, "LOCAL_WORKER_NONCE_INVALID");
});

test("extracts the exact signed request path and headers", () => {
  const body = JSON.stringify({ action: "claim" });
  const input = signedInput({ body });
  const request = new Request(`https://insight.momentlabs.co.kr${input.path}?ignored=true`, {
    method: input.method,
    headers: {
      "x-mi-worker-timestamp": input.timestamp,
      "x-mi-worker-nonce": input.nonce,
      "x-mi-worker-signature": input.signature,
    },
    body,
  });
  assert.deepEqual(localWorkerAuthInput(request, body), input);
});
