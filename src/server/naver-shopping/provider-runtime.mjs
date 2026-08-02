import {
  hasShoppingRankProviderConfig,
  isMobileTopFallbackMode,
  shoppingCollectorFailureStatus,
} from "./source-status.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_PREWARM_TIMEOUT_MS = 75_000;
const DEFAULT_PREWARM_POLL_MS = 750;
const DEFAULT_READY_CACHE_TTL_MS = 5 * 60_000;
const providerPrewarmCache = new Map();

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

export function shoppingProviderRequestTimeoutMs(value = process.env.MI_NAVER_SHOPPING_PROVIDER_TIMEOUT_MS) {
  return boundedInteger(value, DEFAULT_REQUEST_TIMEOUT_MS, 30_000, 120_000);
}

export function shoppingProviderRuntimeConfig(env = process.env) {
  return {
    requestTimeoutMs: shoppingProviderRequestTimeoutMs(env?.MI_NAVER_SHOPPING_PROVIDER_TIMEOUT_MS),
    prewarmTimeoutMs: boundedInteger(
      env?.MI_NAVER_SHOPPING_PREWARM_TIMEOUT_MS,
      DEFAULT_PREWARM_TIMEOUT_MS,
      1_000,
      90_000,
    ),
    prewarmPollMs: boundedInteger(
      env?.MI_NAVER_SHOPPING_PREWARM_POLL_MS,
      DEFAULT_PREWARM_POLL_MS,
      250,
      3_000,
    ),
    readyCacheTtlMs: boundedInteger(
      env?.MI_NAVER_SHOPPING_READY_CACHE_TTL_MS,
      DEFAULT_READY_CACHE_TTL_MS,
      30_000,
      15 * 60_000,
    ),
  };
}

export function shoppingProviderReadyUrl(providerUrl) {
  const parsed = new URL(String(providerUrl || ""));
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("shopping_rank_provider_url_invalid");
  parsed.pathname = "/ready";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function safeProviderReason(payload) {
  const raw = String(payload?.provider?.reason || payload?.reason || payload?.message || "")
    .trim()
    .toLowerCase();
  const known = raw.match(/(?:collector_secret_missing|naver_http_(?:403|418|429)|naver_captcha_detected|naver_auth_required|provider_browser_dependency_missing|provider_browser_launch_failed|verified_provider_not_configured|unsupported_provider_mode|canary_keyword_missing|readiness_verification_stale|provider_not_ready)/)?.[0];
  return known || "provider_not_ready";
}

function readinessResult(response, payload) {
  const provider = payload?.provider && typeof payload.provider === "object" ? payload.provider : {};
  const ready = response.ok
    && payload?.ready === true
    && provider.configured === true
    && provider.verified === true;
  if (ready) {
    return {
      ready: true,
      status: "ready",
      errorCode: "",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: response.status,
    };
  }

  const failure = shoppingCollectorFailureStatus({
    status: response.status,
    message: "provider_not_ready",
    detail: safeProviderReason(payload),
  });
  const terminalStatuses = ["unavailable", "unauthorized", "misconfigured"];
  return {
    ready: false,
    status: terminalStatuses.includes(failure.status) ? failure.status : "warming",
    errorCode: failure.status === "unavailable"
      ? "SHOPPING_RANK_SOURCE_UNAVAILABLE"
      : (failure.status === "unauthorized"
        ? "SHOPPING_RANK_PROVIDER_UNAUTHORIZED"
        : (failure.status === "misconfigured"
          ? "SHOPPING_RANK_PROVIDER_MISCONFIGURED"
          : "SHOPPING_RANK_PROVIDER_WARMING")),
    retryable: !terminalStatuses.includes(failure.status),
    retryAfterSeconds: terminalStatuses.includes(failure.status) ? 0 : 15,
    httpStatus: response.status || 503,
  };
}

async function fetchProviderReadiness(readyUrl, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(readyUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.providerKey}`,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    return readinessResult(response, payload);
  } catch (error) {
    const failure = shoppingCollectorFailureStatus(
      controller.signal.aborted
        ? { name: "AbortError", status: 504, message: "provider_warmup_timeout" }
        : error,
    );
    return {
      ready: false,
      status: ["unavailable", "unauthorized"].includes(failure.status) ? failure.status : "warming",
      errorCode: failure.status === "unavailable"
        ? "SHOPPING_RANK_SOURCE_UNAVAILABLE"
        : (failure.status === "unauthorized" ? "SHOPPING_RANK_PROVIDER_UNAUTHORIZED" : "SHOPPING_RANK_PROVIDER_WARMING"),
      retryable: !["unavailable", "unauthorized"].includes(failure.status),
      retryAfterSeconds: ["unavailable", "unauthorized"].includes(failure.status) ? 0 : 15,
      httpStatus: failure.httpStatus,
    };
  } finally {
    clearTimeout(timer);
  }
}

function pruneProviderPrewarmCache(now) {
  for (const [key, entry] of providerPrewarmCache.entries()) {
    if (!entry || (!entry.promise && entry.expiresAt <= now)) providerPrewarmCache.delete(key);
  }
}

export function clearShoppingProviderPrewarmCache() {
  providerPrewarmCache.clear();
}

export async function prewarmShoppingRankProvider(config, options = {}) {
  if (!hasShoppingRankProviderConfig(config)) {
    return {
      ready: false,
      status: "not_configured",
      errorCode: "SHOPPING_RANK_SOURCE_NOT_CONFIGURED",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: 503,
    };
  }

  const runtime = shoppingProviderRuntimeConfig(options.env || process.env);
  const timeoutMs = boundedInteger(options.timeoutMs, runtime.prewarmTimeoutMs, 1_000, 90_000);
  const pollMs = boundedInteger(options.pollMs, runtime.prewarmPollMs, 250, 3_000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const readyUrl = shoppingProviderReadyUrl(config.providerUrl);
  const cacheKey = readyUrl.toLowerCase();
  const startedAt = now();
  pruneProviderPrewarmCache(startedAt);
  const cached = providerPrewarmCache.get(cacheKey);
  if (cached?.promise) return cached.promise;
  if (cached?.result?.ready && cached.expiresAt > startedAt) return cached.result;

  const promise = (async () => {
    const deadline = startedAt + timeoutMs;
    let lastResult = null;
    while (now() < deadline) {
      const remaining = Math.max(1, deadline - now());
      // Keep one readiness probe short so an unresponsive cold instance cannot
      // consume the entire rank request envelope by itself.
      lastResult = await fetchProviderReadiness(readyUrl, {
        fetchImpl,
        timeoutMs: Math.min(2_500, remaining),
        providerKey: config.providerKey,
      });
      if (lastResult.ready || ["unavailable", "unauthorized", "misconfigured"].includes(lastResult.status)) {
        return lastResult;
      }
      const delay = Math.min(pollMs, Math.max(0, deadline - now()));
      if (delay <= 0) break;
      await sleep(delay);
    }
    return lastResult || {
      ready: false,
      status: "warming",
      errorCode: "SHOPPING_RANK_PROVIDER_WARMING",
      retryable: true,
      retryAfterSeconds: 15,
      httpStatus: 503,
    };
  })();

  providerPrewarmCache.set(cacheKey, { promise, expiresAt: startedAt + timeoutMs });
  try {
    const result = await promise;
    if (result.ready) {
      providerPrewarmCache.set(cacheKey, {
        result,
        expiresAt: now() + runtime.readyCacheTtlMs,
      });
    } else {
      providerPrewarmCache.delete(cacheKey);
    }
    return result;
  } catch (error) {
    providerPrewarmCache.delete(cacheKey);
    throw error;
  }
}

export function shoppingProviderExecutionMode(readiness = {}) {
  if (readiness.ready === true) {
    return { run: true, mobileTopFallbackOnly: false };
  }
  return { run: false, mobileTopFallbackOnly: false };
}

export async function resolveShoppingRankProvider(config, options = {}) {
  if (isMobileTopFallbackMode(config)) {
    const readiness = {
      ready: true,
      status: "mobile_top_fallback_ready",
      errorCode: "",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: 200,
      fullCoverageReady: false,
    };
    return {
      run: true,
      mobileTopFallbackOnly: true,
      readiness,
      env: { ...config, mobileTopFallbackOnly: true },
    };
  }
  if (!hasShoppingRankProviderConfig(config)) {
    const readiness = {
      ready: false,
      status: "not_configured",
      errorCode: "SHOPPING_RANK_SOURCE_NOT_CONFIGURED",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: 503,
    };
    return { ...shoppingProviderExecutionMode(readiness), readiness, env: config };
  }
  const prewarm = options.prewarm || prewarmShoppingRankProvider;
  const readiness = await prewarm(config, options);
  const mode = shoppingProviderExecutionMode(readiness);
  return {
    ...mode,
    readiness,
    env: mode.mobileTopFallbackOnly ? { ...config, mobileTopFallbackOnly: true } : config,
  };
}
