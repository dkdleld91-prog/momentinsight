const defaultAllowedOrigins = [
  "https://insight.momentlabs.co.kr",
  "http://127.0.0.1:8784",
  "http://127.0.0.1:8786",
  "http://127.0.0.1:8781",
  "http://127.0.0.1:8790",
  "http://127.0.0.1:8793",
  "http://127.0.0.1:8771",
  "http://127.0.0.1:8772",
  "http://127.0.0.1:8774",
  "http://127.0.0.1:8775",
  "http://localhost:8784",
  "http://localhost:8786",
  "http://localhost:8781",
  "http://localhost:8790",
  "http://localhost:8793",
  "http://localhost:8774",
  "http://localhost:8775"
];

const productionAllowedOrigins = ["https://insight.momentlabs.co.kr"];

function productionEnvironment() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

export function allowedOrigins() {
  const raw = process.env.MI_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || "";
  const configured = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (productionEnvironment()) {
    const productionConfigured = configured.filter((origin) => origin !== "*" && /^https:\/\//i.test(origin));
    return productionConfigured.length ? [...new Set(productionConfigured)] : productionAllowedOrigins;
  }
  return configured.length ? [...new Set([...configured, ...defaultAllowedOrigins])] : defaultAllowedOrigins;
}

export function isLocalRequest(request) {
  if (productionEnvironment()) return false;
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
    "content-security-policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-src 'none'; script-src-attr 'none'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "origin-agent-cluster": "?1",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), browsing-topics=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-permitted-cross-domain-policies": "none",
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
    headers: { ...corsHeaders(request, options), ...(options.extraHeaders || {}) },
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
