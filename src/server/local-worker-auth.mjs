import crypto from "node:crypto";

const WORKER_SIGNATURE_VERSION = "v1";
export const LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const NONCE_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function normalizeSecret(value) {
  return String(value || "").trim();
}

function bodyBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value || ""), "utf8");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(bodyBuffer(value)).digest("hex");
}

function workerSignaturePayload({ timestamp, nonce, method, audience, path, body }) {
  return [
    String(timestamp || ""),
    String(nonce || ""),
    String(method || "POST").toUpperCase(),
    String(audience || "").toLowerCase(),
    String(path || ""),
    sha256Hex(body),
  ].join("\n");
}

function hmacHex(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function timingSafeHexEqual(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  if (!HEX_SHA256_PATTERN.test(a) || !HEX_SHA256_PATTERN.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function localWorkerEnabled(env = process.env) {
  return String(env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED || "").trim().toLowerCase() === "true";
}

export function localWorkerSecrets(env = process.env) {
  return [...new Set([
    normalizeSecret(env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET),
    normalizeSecret(env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET_PREVIOUS),
  ].filter((value) => Buffer.byteLength(value, "utf8") >= 32))];
}

export function signLocalWorkerRequest(secret, input = {}) {
  const normalizedSecret = normalizeSecret(secret);
  if (!normalizedSecret) throw new Error("local_worker_secret_missing");
  const payload = workerSignaturePayload(input);
  return `${WORKER_SIGNATURE_VERSION}=${hmacHex(normalizedSecret, payload)}`;
}

export function localWorkerAuthInput(request, body = "") {
  const url = new URL(request.url);
  return {
    timestamp: request.headers.get("x-mi-worker-timestamp") || "",
    nonce: request.headers.get("x-mi-worker-nonce") || "",
    signature: request.headers.get("x-mi-worker-signature") || "",
    method: request.method,
    audience: url.origin,
    path: url.pathname,
    body,
  };
}

export function verifyLocalWorkerSignature(input = {}, options = {}) {
  const env = options.env || process.env;
  if (!localWorkerEnabled(env)) {
    return { ok: false, code: "LOCAL_WORKER_DISABLED", status: 404 };
  }

  const secrets = options.secrets || localWorkerSecrets(env);
  if (!secrets.length) {
    return { ok: false, code: "LOCAL_WORKER_SECRET_MISSING", status: 503 };
  }

  const nowSeconds = Math.trunc(Number(options.nowSeconds ?? Date.now() / 1000));
  const maxSkewSeconds = Math.max(30, Math.min(
    15 * 60,
    Math.trunc(Number(options.maxSkewSeconds || LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS)),
  ));
  const timestamp = String(input.timestamp || "").trim();
  const timestampSeconds = Number(timestamp);
  const nonce = String(input.nonce || "").trim();
  const signatureHeader = String(input.signature || "").trim().toLowerCase();
  const signatureMatch = signatureHeader.match(/^v1=([a-f0-9]{64})$/u);

  if (!/^\d{10,13}$/u.test(timestamp) || !Number.isSafeInteger(timestampSeconds)) {
    return { ok: false, code: "LOCAL_WORKER_TIMESTAMP_INVALID", status: 401 };
  }
  if (Math.abs(nowSeconds - timestampSeconds) > maxSkewSeconds) {
    return { ok: false, code: "LOCAL_WORKER_TIMESTAMP_EXPIRED", status: 401 };
  }
  if (!NONCE_PATTERN.test(nonce)) {
    return { ok: false, code: "LOCAL_WORKER_NONCE_INVALID", status: 401 };
  }
  if (!signatureMatch) {
    return { ok: false, code: "LOCAL_WORKER_SIGNATURE_INVALID", status: 401 };
  }

  const payload = workerSignaturePayload({ ...input, timestamp, nonce });
  const matchedSecretIndex = secrets.findIndex((secret) => (
    timingSafeHexEqual(signatureMatch[1], hmacHex(secret, payload))
  ));
  if (matchedSecretIndex < 0) {
    return { ok: false, code: "LOCAL_WORKER_SIGNATURE_INVALID", status: 401 };
  }

  return {
    ok: true,
    code: "LOCAL_WORKER_AUTHORIZED",
    status: 200,
    nonce,
    timestampSeconds,
    usedPreviousSecret: matchedSecretIndex > 0,
    bodySha256: sha256Hex(input.body),
  };
}

export const LOCAL_WORKER_SIGNATURE_VERSION = WORKER_SIGNATURE_VERSION;
