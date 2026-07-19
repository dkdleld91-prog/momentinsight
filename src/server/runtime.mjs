import { corsHeaders } from "./security.mjs";
import { safeErrorPayload } from "./error-safety.mjs";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function generatedRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `mi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function requestIdFor(request) {
  const supplied = String(request?.headers?.get?.("x-request-id") || "").trim();
  return REQUEST_ID_PATTERN.test(supplied) ? supplied : generatedRequestId();
}

export function createHandlerResolver(loaders) {
  const cache = new Map();

  return async function resolveHandler(name) {
    const loader = loaders[name];
    if (typeof loader !== "function") throw new Error("unknown_handler");

    if (!cache.has(name)) {
      const pending = Promise.resolve()
        .then(() => loader())
        .then((module) => {
          const app = module?.default;
          if (!app || typeof app.fetch !== "function") throw new Error("invalid_handler");
          return app;
        });
      cache.set(name, pending);
      pending.catch(() => {
        if (cache.get(name) === pending) cache.delete(name);
      });
    }

    return cache.get(name);
  };
}

async function runtimeResponse(request, response, requestId, startedAt) {
  const headers = new Headers(response.headers);
  const runtimeCors = corsHeaders(request);
  const allowedOrigin = runtimeCors["access-control-allow-origin"] || "";
  const rawBuffer = response.body ? await response.arrayBuffer() : new ArrayBuffer(0);
  const rawText = new TextDecoder().decode(rawBuffer);
  const safeError = safeErrorPayload(response, rawText);

  // Handler libraries may emit a wildcard. The public API must follow the
  // same explicit-origin policy as preflight responses.
  headers.delete("access-control-allow-origin");
  if (allowedOrigin) headers.set("access-control-allow-origin", allowedOrigin);
  if (runtimeCors.vary) {
    const existing = headers.get("vary") || "";
    headers.set("vary", [...new Set([...existing.split(","), ...runtimeCors.vary.split(",")]
      .map((item) => item.trim()).filter(Boolean))].join(", "));
  }

  // Keep runtime responses on the same central security policy as direct
  // handler responses without replacing handler-specific CORS methods.
  for (const [name, value] of Object.entries(runtimeCors)) {
    if (name === "vary" || name.startsWith("access-control-")) continue;
    headers.set(name, value);
  }
  headers.set("x-request-id", requestId);
  headers.set("server-timing", `app;dur=${Math.max(0, Date.now() - startedAt)}`);

  if (safeError) {
    headers.delete("content-length");
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return new Response(safeError
    ? JSON.stringify({ ...safeError.body, requestId: safeError.body.requestId || requestId })
    : rawBuffer, {
    status: safeError ? safeError.status : response.status,
    statusText: safeError ? undefined : response.statusText,
    headers,
  });
}

export async function executeRequest(request, operation) {
  const requestId = requestIdFor(request);
  const startedAt = Date.now();

  try {
    const response = await operation();
    if (!(response instanceof Response)) throw new Error("invalid_response");
    return await runtimeResponse(request, response, requestId, startedAt);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "api_request_failed",
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      errorType: error instanceof Error ? error.name : "UnknownError",
    }));

    return await runtimeResponse(request, Response.json({
      ok: false,
      message: "서버 처리 중 오류가 발생했습니다.",
      code: "SERVER_ERROR",
      requestId,
    }, { status: 500 }), requestId, startedAt);
  }
}
