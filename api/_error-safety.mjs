import { safeErrorPayload } from "../src/server/error-safety.mjs";

export { safeErrorPayload };

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function nodeRequestId(req) {
  const supplied = String(req?.headers?.["x-request-id"] || "").trim();
  if (SAFE_REQUEST_ID.test(supplied)) return supplied;
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `mi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function logAdapterFailure(req, requestId, error) {
  console.error(JSON.stringify({
    level: "error",
    event: "api_adapter_failed",
    requestId,
    method: String(req?.method || "GET"),
    path: String(req?.url || "/").split("?")[0],
    errorType: error instanceof Error ? error.name : "UnknownError",
  }));
}
