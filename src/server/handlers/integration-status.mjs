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
      check("Naver Place rank provider URL", ["NAVER_PLACE_RANK_API_URL"], false),
      check("Naver Place rank provider key", ["NAVER_PLACE_RANK_API_KEY"], false),
      check("Keyword API enabled", ["MI_KEYWORD_API_ENABLED"], true),
      check("Meta Ad Library access token", ["META_AD_LIBRARY_ACCESS_TOKEN", "META_ADS_LIBRARY_ACCESS_TOKEN"], false),
    ];
    const missing = requiredMissing(checks);
    const searchAdReady = checks.slice(0, 3).every((item) => item.configured);
    const datalabReady = checks.slice(3, 5).every((item) => item.configured);
    const openapiReady = checks.slice(5, 7).every((item) => item.configured);
    const placeExternalReady = checks.slice(7, 9).every((item) => item.configured);
    const keywordFeatureReady = process.env.MI_KEYWORD_API_ENABLED === "true";
    const metaAdsReady = checks[10].configured;
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
        naverPlaceRank: {
          ready: placeExternalReady,
          source: placeExternalReady ? "external_place_rank_provider" : "naver_openapi_local_fallback",
          note: placeExternalReady
            ? "플레이스 URL 기준 순위 수집 서버가 연결되었습니다."
            : "네이버 공식 검색 API fallback 상태입니다. URL 기준 300위 순위 매칭은 자체 수집 서버 연결이 필요합니다.",
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
