export const SHOPPING_RANK_SOURCE_NOT_CONFIGURED = "SHOPPING_RANK_SOURCE_NOT_CONFIGURED";
export const SHOPPING_RANK_MODE_INVALID = "SHOPPING_RANK_MODE_INVALID";
export const SHOPPING_RANK_MODE_PROVIDER = "provider";
export const SHOPPING_RANK_MODE_MOBILE_TOP_FALLBACK = "mobile_top_fallback";
export const SHOPPING_RANK_MODE_HYBRID_LOCAL_WORKER = "hybrid_local_worker";

function normalizedShoppingRankMode(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedErrorText(value) {
  const status = Number(value?.status || 0);
  const source = value && typeof value === "object"
    ? [value.message, value.code, value.detail, status ? `http_${status}` : ""].filter(Boolean).join(":")
    : value;
  return String(source || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function shoppingRankConfig(env = process.env) {
  const configuredMode = normalizedShoppingRankMode(
    env?.NAVER_SHOPPING_RANK_MODE ?? env?.mode,
  );
  const providerUrl = String(env?.NAVER_SHOPPING_RANK_API_URL ?? env?.providerUrl ?? "").trim();
  const providerKey = String(env?.NAVER_SHOPPING_RANK_API_KEY ?? env?.providerKey ?? "").trim();
  const mode = configuredMode;
  const localWorkerEnabled = String(
    env?.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED ?? env?.localWorkerEnabled ?? "",
  ).trim().toLowerCase() === "true";
  const localWorkerSecretReady = Boolean(
    env?.localWorkerSecretReady === true
    || Buffer.byteLength(String(env?.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET || ""), "utf8") >= 32,
  );
  return {
    providerUrl,
    providerKey,
    mode,
    mobileTopFallbackOnly: [
      SHOPPING_RANK_MODE_MOBILE_TOP_FALLBACK,
      SHOPPING_RANK_MODE_HYBRID_LOCAL_WORKER,
    ].includes(mode),
    localWorkerEnabled,
    localWorkerSecretReady,
  };
}

export function isMobileTopFallbackMode(config) {
  return [
    SHOPPING_RANK_MODE_MOBILE_TOP_FALLBACK,
    SHOPPING_RANK_MODE_HYBRID_LOCAL_WORKER,
  ].includes(normalizedShoppingRankMode(config?.mode ?? config?.NAVER_SHOPPING_RANK_MODE));
}

export function isHybridLocalWorkerMode(config) {
  return normalizedShoppingRankMode(config?.mode ?? config?.NAVER_SHOPPING_RANK_MODE)
    === SHOPPING_RANK_MODE_HYBRID_LOCAL_WORKER;
}

export function hasShoppingRankHybridConfig(config) {
  const normalized = shoppingRankConfig(config);
  return isHybridLocalWorkerMode(normalized)
    && normalized.localWorkerEnabled
    && normalized.localWorkerSecretReady;
}

export function hasShoppingRankProviderConfig(config) {
  const normalized = shoppingRankConfig(config);
  return normalized.mode === SHOPPING_RANK_MODE_PROVIDER
    && Boolean(normalized.providerUrl && normalized.providerKey);
}

export function hasShoppingRankConfig(config) {
  const normalized = shoppingRankConfig(config);
  if (isHybridLocalWorkerMode(normalized)) return hasShoppingRankHybridConfig(normalized);
  return isMobileTopFallbackMode(normalized) || hasShoppingRankProviderConfig(normalized);
}

export function shoppingRankSourceStatus(config) {
  const normalized = shoppingRankConfig(config);
  const configured = hasShoppingRankConfig(normalized);
  const hybrid = isHybridLocalWorkerMode(normalized);
  const fallbackOnly = isMobileTopFallbackMode(normalized) && !hybrid;
  const invalidMode = Boolean(normalized.mode)
    && ![
      SHOPPING_RANK_MODE_PROVIDER,
      SHOPPING_RANK_MODE_MOBILE_TOP_FALLBACK,
      SHOPPING_RANK_MODE_HYBRID_LOCAL_WORKER,
    ].includes(normalized.mode);
  return {
    rankSourceReady: configured && !invalidMode,
    configured: configured && !invalidMode,
    mode: invalidMode ? "invalid" : normalized.mode,
    coverage: hybrid
      ? "verified_top_window_plus_local_300"
      : (fallbackOnly ? "verified_top_window" : (configured ? "verified_full_window" : "none")),
    fullCoverageReady: configured && !fallbackOnly,
    preserveOnMiss: fallbackOnly || hybrid,
    localWorkerEnabled: normalized.localWorkerEnabled,
    localWorkerSecretReady: normalized.localWorkerSecretReady,
    ...(!configured || invalidMode ? {
      errorCode: invalidMode ? SHOPPING_RANK_MODE_INVALID : SHOPPING_RANK_SOURCE_NOT_CONFIGURED,
      retryable: false,
    } : {}),
  };
}

export function shoppingCollectorFailureStatus(value) {
  const status = Number(value?.status || 0);
  const message = normalizedErrorText(value);
  const coverageLimited = /shopping[_ -]?rank[_ -]?top[_ -]?fallback[_ -]?inconclusive/i.test(message);
  if (coverageLimited) {
    return {
      status: "coverage_limited",
      errorCode: "SHOPPING_RANK_OUTSIDE_VERIFIED_WINDOW",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: 409,
    };
  }

  const mobileFallbackUnavailable = /shopping[_ -]?mobile[_ -]?top[_ -]?(?:http[_ -]?(?:403|418)|schema[_ -]?drift|content[_ -]?type|response[_ -]?too[_ -]?large)/i.test(message);
  if (mobileFallbackUnavailable) {
    return {
      status: "unavailable",
      errorCode: "SHOPPING_RANK_SOURCE_UNAVAILABLE",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: status || 503,
    };
  }

  const mobileCooldown = /shopping[_ -]?mobile[_ -]?top[_ -]?(?:http[_ -]?429|cooldown)/i.test(message);
  if (mobileCooldown) {
    return {
      status: "busy",
      errorCode: "SHOPPING_RANK_PROVIDER_BUSY",
      retryable: true,
      retryAfterSeconds: 900,
      httpStatus: status || 429,
    };
  }

  const busy = /provider[_ -]?(?:busy|queue[_ -]?(?:full|deadline[_ -]?exceeded))|shopping[_ -]?mobile[_ -]?top[_ -]?(?:busy|rate[_ -]?limited)/i.test(message);
  if (busy) {
    return {
      status: "busy",
      errorCode: "SHOPPING_RANK_PROVIDER_BUSY",
      retryable: true,
      retryAfterSeconds: /shopping[_ -]?mobile[_ -]?top/i.test(message) ? 60 : 5,
      httpStatus: status || 429,
    };
  }

  const authenticationFailure = status === 401
    || (status === 403 && !/naver[_ -]?http[_ -]?403/i.test(message))
    || /provider[_ -]?(?:unauthorized|authentication[_ -]?failed)|invalid[_ -]?(?:provider[_ -]?)?(?:key|secret)|naver[_ -]?auth[_ -]?required/i.test(message);
  if (authenticationFailure) {
    return {
      status: "unauthorized",
      errorCode: "SHOPPING_RANK_PROVIDER_UNAUTHORIZED",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: status || 401,
    };
  }

  const configurationFailure = /collector[_ -]?secret[_ -]?missing|verified[_ -]?provider[_ -]?not[_ -]?configured|unsupported[_ -]?provider[_ -]?mode|canary[_ -]?keyword[_ -]?missing|provider[_ -]?browser[_ -]?(?:dependency[_ -]?missing|launch[_ -]?failed)|shopping[_ -]?rank[_ -]?source[_ -]?not[_ -]?configured/i.test(message);
  if (configurationFailure) {
    return {
      status: "misconfigured",
      errorCode: "SHOPPING_RANK_PROVIDER_MISCONFIGURED",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: status || 503,
    };
  }

  // Only an explicit block from Naver's upstream may switch to the verified
  // first-party top-window fallback. Local configuration and authentication
  // failures must stay fail-closed.
  const definitivelyUnavailable = /naver[_ -]?(?:http[_ -]?(?:403|418)|captcha[_ -]?detected)/i.test(message);
  if (definitivelyUnavailable) {
    return {
      status: "unavailable",
      errorCode: "SHOPPING_RANK_SOURCE_UNAVAILABLE",
      retryable: false,
      retryAfterSeconds: 0,
      httpStatus: status || 503,
    };
  }

  const warming = status === 503
    || /provider[_ -]?not[_ -]?ready|collector[_ -]?not[_ -]?ready|readiness[_ -]?verification[_ -]?stale|provider[_ -]?warming|warmup[_ -]?timeout/i.test(message);
  if (warming) {
    return {
      status: "warming",
      errorCode: "SHOPPING_RANK_PROVIDER_WARMING",
      retryable: true,
      retryAfterSeconds: 15,
      httpStatus: status || 503,
    };
  }

  const transient = status === 408
    || status === 425
    || status === 429
    || status === 502
    || status === 504
    || value?.name === "AbortError"
    || /naver[_ -]?http[_ -]?429|timeout|timed[_ -]?out|network|fetch[_ -]?failed|socket|gateway/i.test(message);
  return {
    status: "error",
    errorCode: "SHOPPING_RANK_LOOKUP_FAILED",
    retryable: transient || value?.retryable !== false,
    retryAfterSeconds: transient ? 5 : 0,
    httpStatus: status || 502,
  };
}

export function isShoppingCollectorUnavailable(value) {
  return shoppingCollectorFailureStatus(value).status === "unavailable";
}

export function isShoppingRankSourceUnavailable(value) {
  const message = normalizedErrorText(value);
  return isShoppingCollectorUnavailable(value)
    || /invalid search api|존재하지 않는 검색 api|endpoint[_ -]?removed|shopping api.{0,20}(?:ended|removed|종료)/i.test(message);
}
