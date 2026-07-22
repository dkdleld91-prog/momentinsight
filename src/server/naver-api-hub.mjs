const LEGACY_BASE_URL = "https://openapi.naver.com";
const API_HUB_BASE_URL = "https://naverapihub.apigw.ntruss.com";
const VALID_MODES = new Set(["auto", "legacy", "hub"]);

function text(value) {
  return String(value || "").trim();
}

function providerMode(value) {
  const mode = text(value).toLowerCase();
  return VALID_MODES.has(mode) ? mode : "legacy";
}

export function naverApiProviderConfig(env = process.env) {
  return {
    mode: providerMode(env.NAVER_API_HUB_MODE),
    legacy: {
      searchClientId: text(env.NAVER_OPENAPI_CLIENT_ID || env.NAVER_DATALAB_CLIENT_ID),
      searchClientSecret: text(env.NAVER_OPENAPI_CLIENT_SECRET || env.NAVER_DATALAB_CLIENT_SECRET),
      datalabClientId: text(env.NAVER_DATALAB_CLIENT_ID || env.NAVER_OPENAPI_CLIENT_ID),
      datalabClientSecret: text(env.NAVER_DATALAB_CLIENT_SECRET || env.NAVER_OPENAPI_CLIENT_SECRET),
    },
    hub: {
      clientId: text(env.NAVER_API_HUB_CLIENT_ID || env.NAVER_API_HUB_API_KEY_ID),
      clientSecret: text(env.NAVER_API_HUB_CLIENT_SECRET || env.NAVER_API_HUB_API_KEY),
    },
  };
}

export function hasNaverApiHubConfig(config) {
  return Boolean(config?.hub?.clientId && config?.hub?.clientSecret);
}

export function hasLegacyNaverApiConfig(config, kind = "search") {
  if (kind === "datalab") {
    return Boolean(config?.legacy?.datalabClientId && config?.legacy?.datalabClientSecret);
  }
  return Boolean(config?.legacy?.searchClientId && config?.legacy?.searchClientSecret);
}

export function resolveNaverApiTransport(config, kind = "search") {
  const mode = providerMode(config?.mode);
  const hubReady = hasNaverApiHubConfig(config);
  const legacyReady = hasLegacyNaverApiConfig(config, kind);

  if (mode === "hub") return hubReady ? "hub" : "not-configured";
  if (mode === "legacy") return legacyReady ? "legacy" : "not-configured";
  if (hubReady) return "hub";
  if (legacyReady) return "legacy";
  return "not-configured";
}

export function hasNaverMigratedApiConfig(config, kind = "search") {
  return resolveNaverApiTransport(config, kind) !== "not-configured";
}

function requestHeaders(config, kind) {
  const provider = resolveNaverApiTransport(config, kind);
  if (provider === "hub") {
    return {
      provider,
      headers: {
        "X-NCP-APIGW-API-KEY-ID": config.hub.clientId,
        "X-NCP-APIGW-API-KEY": config.hub.clientSecret,
      },
    };
  }
  if (provider === "legacy") {
    const prefix = kind === "datalab" ? "datalab" : "search";
    return {
      provider,
      headers: {
        "X-Naver-Client-Id": config.legacy[`${prefix}ClientId`],
        "X-Naver-Client-Secret": config.legacy[`${prefix}ClientSecret`],
      },
    };
  }

  const error = new Error(`naver_${kind}_not_configured`);
  error.code = "NAVER_API_NOT_CONFIGURED";
  throw error;
}

export function naverSearchRequest(config, resource, params = new URLSearchParams()) {
  const { provider, headers } = requestHeaders(config, "search");
  const query = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params).toString();
  const path = provider === "hub" ? `/search/v1/${resource}` : `/v1/search/${resource}.json`;
  return {
    provider,
    url: `${provider === "hub" ? API_HUB_BASE_URL : LEGACY_BASE_URL}${path}${query ? `?${query}` : ""}`,
    headers,
  };
}

export function naverDatalabRequest(config, api, endpoint = "") {
  const { provider, headers } = requestHeaders(config, "datalab");
  let path;
  if (api === "search-trend") {
    path = provider === "hub" ? "/search-trend/v1/search" : "/v1/datalab/search";
  } else if (api === "shopping-insight-keyword") {
    const suffix = text(endpoint);
    if (!suffix) throw new Error("naver_shopping_insight_endpoint_required");
    path = provider === "hub"
      ? `/shopping/v1/category/keyword/${suffix}`
      : `/v1/datalab/shopping/category/keyword/${suffix}`;
  } else {
    throw new Error("naver_datalab_api_not_supported");
  }

  return {
    provider,
    url: `${provider === "hub" ? API_HUB_BASE_URL : LEGACY_BASE_URL}${path}`,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  };
}

export function naverApiErrorMessage(payload, fallback = "NAVER API request failed") {
  return text(
    payload?.errorMessage ||
    payload?.message ||
    payload?.error?.message ||
    payload?.error?.details ||
    payload?.errMsg ||
    payload?.title ||
    payload?.raw ||
    fallback,
  );
}

export function naverApiFailureDisposition(status) {
  const code = Number(status || 0);
  if (code === 401 || code === 403) return "credentials_or_permission";
  if (code === 404 || code === 410) return "endpoint_removed";
  if (code === 429) return "rate_limited";
  if (code >= 500) return "temporary_provider_failure";
  return "request_rejected";
}

export const NAVER_SHOPPING_SEARCH_LEGACY_ENDS_AT = "2026-07-31T15:00:00.000Z";
