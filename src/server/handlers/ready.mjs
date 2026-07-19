import { protectedJson } from "../security.mjs";

const CACHE_TTL_MS = 15_000;
const readinessCache = new Map();
const READINESS_PROBES = [
  { path: "/rest/v1/clients", select: "id" },
  { path: "/rest/v1/naver_rank_trackers", select: "id,processing_started_at,processing_until" },
  { path: "/rest/v1/naver_place_rank_trackers", select: "id,processing_token,processing_started_at,processing_until" },
];

function firstValue(env, names) {
  for (const name of names) {
    const value = String(env[name] || "").split(",")[0].trim();
    if (value) return value;
  }
  return "";
}

function namedKeyValue(env, pluralName, singularName) {
  const pluralRaw = String(env[pluralName] || "").trim();
  if (pluralRaw) {
    try {
      const parsed = JSON.parse(pluralRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return String(parsed.default || "").trim();
      }
    } catch {}
    return "";
  }
  return String(env[singularName] || "").split(",")[0].trim();
}

function isLegacyJwtKey(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function isConfiguredSupabaseKey(value, prefix) {
  const key = String(value || "").trim();
  return isLegacyJwtKey(key) || key.startsWith(prefix);
}

function jwksKeys(value) {
  const payload = typeof value === "string" ? JSON.parse(value) : value;
  const keys = Array.isArray(payload) ? payload : payload?.keys;
  return Array.isArray(keys) && keys.length > 0 && keys.every(validJwk)
    ? keys
    : null;
}

function validJwk(key) {
  if (!key || typeof key !== "object" || Array.isArray(key)) return false;
  const has = (...names) => names.every((name) => typeof key[name] === "string" && key[name].trim());
  if (key.kty === "RSA") return has("n", "e");
  if (key.kty === "EC") return has("crv", "x", "y");
  if (key.kty === "OKP") return has("crv", "x");
  if (key.kty === "oct") return has("k");
  return false;
}

function validInlineJwks(value) {
  try {
    return Boolean(jwksKeys(value));
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "[::1]"
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function validJwksUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

function probeHeaders(secretKey) {
  return {
    apikey: secretKey,
    ...(isLegacyJwtKey(secretKey) ? { authorization: `Bearer ${secretKey}` } : {}),
  };
}

function readinessConfig(env) {
  return {
    url: firstValue(env, ["SUPABASE_URL"]),
    publishableKey: namedKeyValue(env, "SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_PUBLISHABLE_KEY"),
    secretKey: namedKeyValue(env, "SUPABASE_SECRET_KEYS", "SUPABASE_SECRET_KEY"),
    jwksInline: String(env.SUPABASE_JWKS || "").trim(),
    jwksUrl: firstValue(env, ["SUPABASE_JWKS_URL"]),
  };
}

function cacheKey(config) {
  return `${config.url}|${config.secretKey.slice(-8)}|${config.jwksInline.length}|${config.jwksUrl}`;
}

export async function checkReadiness(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const timeoutMs = Math.max(500, Math.min(10_000, Number(options.timeoutMs || 3_500)));
  const cache = options.cache || readinessCache;
  const config = readinessConfig(env);
  const missingCount = [
    config.url,
    config.publishableKey,
    config.secretKey,
    config.jwksInline || config.jwksUrl,
  ].filter((value) => !value).length;
  const invalidCount = [
    config.publishableKey && !isConfiguredSupabaseKey(config.publishableKey, "sb_publishable_"),
    config.secretKey && !isConfiguredSupabaseKey(config.secretKey, "sb_secret_"),
    config.jwksInline && !validInlineJwks(config.jwksInline),
    !config.jwksInline && config.jwksUrl && !validJwksUrl(config.jwksUrl),
  ].filter(Boolean).length;

  if (missingCount || invalidCount) {
    return {
      ok: false,
      missingCount: missingCount + invalidCount,
      dependency: "not_configured",
      checkedAt: new Date(now()).toISOString(),
    };
  }

  const key = cacheKey(config);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) return cached.result;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let result;
  try {
    const restProbe = Promise.all(READINESS_PROBES.map(async ({ path, select }) => {
      const endpoint = new URL(path, config.url);
      endpoint.searchParams.set("select", select);
      endpoint.searchParams.set("limit", "1");
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: probeHeaders(config.secretKey),
        signal: controller.signal,
      });
      const ok = response.ok;
      await response.arrayBuffer();
      return ok;
    }));
    const authProbe = (async () => {
      const response = await fetchImpl(new URL("/auth/v1/settings", config.url), {
        method: "GET",
        headers: probeHeaders(config.publishableKey),
        signal: controller.signal,
      });
      const ok = response.ok;
      await response.arrayBuffer();
      return ok;
    })();
    const jwksProbe = config.jwksInline
      ? Promise.resolve(true)
      : (async () => {
        const response = await fetchImpl(new URL(config.jwksUrl), {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        return response.ok && Boolean(jwksKeys(payload));
      })();
    const [restStates, authReady, jwksReady] = await Promise.all([restProbe, authProbe, jwksProbe]);
    const probesReady = restStates.every(Boolean) && authReady && jwksReady;
    result = {
      ok: probesReady,
      missingCount: 0,
      dependency: probesReady ? "ready" : "unavailable",
      checkedAt: new Date(now()).toISOString(),
    };
  } catch {
    controller.abort();
    result = {
      ok: false,
      missingCount: 0,
      dependency: "unavailable",
      checkedAt: new Date(now()).toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }

  cache.set(key, { result, expiresAt: now() + CACHE_TTL_MS });
  return result;
}

export function createReadinessHandler(options = {}) {
  return async function readinessHandler(request) {
    if (request.method !== "GET") {
      return protectedJson(request, { ok: false, message: "Method not allowed" }, 405);
    }

    const result = await checkReadiness(options);
    const release = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "local";
    const body = {
      ok: result.ok,
      status: result.ok ? "ready" : "not_ready",
      service: "moment-insight-api",
      release: String(release).slice(0, 12),
      dependency: { supabase: result.dependency },
      missingCount: result.missingCount,
      checkedAt: result.checkedAt,
      ...(result.ok ? {} : { code: "SERVER_NOT_READY", message: "서버 연결 준비 상태를 확인해주세요." }),
    };
    return protectedJson(request, body, result.ok ? 200 : 503, result.ok ? {} : {
      extraHeaders: { "retry-after": "5" },
    });
  };
}

export default { fetch: createReadinessHandler() };
