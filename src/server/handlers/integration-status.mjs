import { protectedJson } from "../security.mjs";

function hasAny(names) {
  return names.some((name) => Boolean(process.env[name]));
}

function check(label, names, required) {
  return {
    label,
    required,
    configured: hasAny(names),
    envNames: names,
  };
}

function requiredMissing(checks) {
  return checks
    .filter((item) => item.required && !item.configured)
    .flatMap((item) => item.envNames);
}

function canExposeEnvDetails() {
  return process.env.NODE_ENV === "development" ||
    process.env.VERCEL_ENV !== "production" ||
    process.env.MI_EXPOSE_INTEGRATION_ENV_NAMES === "true";
}

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return protectedJson(request, { ok: false, message: "Method not allowed" }, 405);
    }

    const checks = [
      check("Naver SearchAd API key", ["NAVER_SEARCHAD_API_KEY"], true),
      check("Naver SearchAd secret", ["NAVER_SEARCHAD_SECRET_KEY"], true),
      check("Naver SearchAd customer", ["NAVER_SEARCHAD_CUSTOMER_ID"], true),
      check("Naver DataLab client", ["NAVER_DATALAB_CLIENT_ID", "NAVER_OPENAPI_CLIENT_ID"], true),
      check("Naver DataLab secret", ["NAVER_DATALAB_CLIENT_SECRET", "NAVER_OPENAPI_CLIENT_SECRET"], true),
      check("Naver OpenAPI client", ["NAVER_OPENAPI_CLIENT_ID", "NAVER_DATALAB_CLIENT_ID"], true),
      check("Naver OpenAPI secret", ["NAVER_OPENAPI_CLIENT_SECRET", "NAVER_DATALAB_CLIENT_SECRET"], true),
      check("Keyword API enabled", ["MI_KEYWORD_API_ENABLED"], true),
      check("Meta Ad Library access token", ["META_AD_LIBRARY_ACCESS_TOKEN", "META_ADS_LIBRARY_ACCESS_TOKEN"], false),
    ];
    const missing = requiredMissing(checks);
    const searchAdReady = checks.slice(0, 3).every((item) => item.configured);
    const datalabReady = checks.slice(3, 5).every((item) => item.configured);
    const openapiReady = checks.slice(5, 7).every((item) => item.configured);
    const keywordFeatureReady = process.env.MI_KEYWORD_API_ENABLED === "true";
    const metaAdsReady = checks[8].configured;
    const exposeDetails = canExposeEnvDetails();

    return protectedJson(request, {
      ok: missing.length === 0 && keywordFeatureReady,
      checkedAt: new Date().toISOString(),
      integrations: {
        keywordSearchVolume: {
          ready: searchAdReady && keywordFeatureReady,
          source: "naver_searchad",
        },
        keywordTrendAndRatios: {
          ready: searchAdReady && datalabReady && keywordFeatureReady,
          source: "naver_datalab",
        },
        shoppingReferenceAndRank: {
          ready: openapiReady,
          source: "naver_openapi_shopping",
        },
        metaAdLibrary: {
          ready: metaAdsReady,
          source: "meta_ad_library",
        },
      },
      checks: checks.map((item) => ({
        label: item.label,
        required: item.required,
        configured: item.configured,
        ...(exposeDetails ? { envNames: item.envNames } : {}),
      })),
      missingEnv: exposeDetails ? missing : [],
      missingEnvCount: missing.length,
    });
  },
};
