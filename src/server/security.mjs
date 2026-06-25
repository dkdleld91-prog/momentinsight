const defaultAllowedOrigins = [
  "https://insight.momentlabs.co.kr",
  "http://127.0.0.1:8784",
  "http://127.0.0.1:8781",
  "http://127.0.0.1:8790",
  "http://127.0.0.1:8771",
  "http://127.0.0.1:8772",
  "http://127.0.0.1:8774",
  "http://127.0.0.1:8775",
  "http://localhost:8784",
  "http://localhost:8781",
  "http://localhost:8790",
  "http://localhost:8774",
  "http://localhost:8775"
];

export function allowedOrigins() {
  const raw = process.env.MI_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || "";
  const configured = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured.length ? configured : defaultAllowedOrigins;
}

export function isLocalRequest(request) {
  const url = new URL(request.url);
  return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
}

export function corsHeaders(request, options = {}) {
  const origin = request.headers.get("origin") || "";
  const allowed = allowedOrigins();
  const allowAll = allowed.includes("*");
  const allowOrigin = allowAll ? origin || "*" : allowed.includes(origin) ? origin : "";
  const headers = {
    "access-control-allow-methods": options.methods || "GET, OPTIONS",
    "access-control-allow-headers": options.headers || "content-type",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };

  if (allowOrigin) {
    headers["access-control-allow-origin"] = allowOrigin;
    headers.vary = "Origin";
  }

  return headers;
}

export function protectedJson(request, body, status = 200, options = {}) {
  return Response.json(body, {
    status,
    headers: corsHeaders(request, options),
  });
}

export function featureEnabled(request, envName) {
  return isLocalRequest(request) || process.env[envName] === "true";
}

export function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b || a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
