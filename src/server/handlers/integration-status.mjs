import { protectedJson } from "../security.mjs";
import {
  hasLegacyNaverApiConfig,
  hasNaverApiHubConfig,
  hasNaverMigratedApiConfig,
  NAVER_SHOPPING_SEARCH_LEGACY_ENDS_AT,
  naverApiProviderConfig,
  resolveNaverApiTransport,
} from "../naver-api-hub.mjs";

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

function configuredCheck(label, names, required, configured) {
  return { label, names, required, configured: Boolean(configured) };
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

    const naverApi = naverApiProviderConfig();
    const hubReady = hasNaverApiHubConfig(naverApi);
    const migratedDatalabReady = hasNaverMigratedApiConfig(naverApi, "datalab");
    const migratedSearchReady = hasNaverMigratedApiConfig(naverApi, "search");
    const legacyShoppingReady = hasLegacyNaverApiConfig(naverApi, "search");
    const searchAdChecks = [
      check("Naver SearchAd API key", ["NAVER_SEARCHAD_API_KEY"], true),
      check("Naver SearchAd secret", ["NAVER_SEARCHAD_SECRET_KEY"], true),
      check("Naver SearchAd customer", ["NAVER_SEARCHAD_CUSTOMER_ID"], true),
    ];
    const datalabProviderCheck = configuredCheck(
      "Naver Search Trend/Shopping Insight provider",
      ["NAVER_API_HUB_CLIENT_ID", "NAVER_API_HUB_CLIENT_SECRET", "NAVER_DATALAB_CLIENT_ID", "NAVER_DATALAB_CLIENT_SECRET"],
      true,
      migratedDatalabReady,
    );
    const legacyShoppingCheck = configuredCheck(
      "Naver legacy shopping search provider",
      ["NAVER_OPENAPI_CLIENT_ID", "NAVER_OPENAPI_CLIENT_SECRET", "NAVER_DATALAB_CLIENT_ID", "NAVER_DATALAB_CLIENT_SECRET"],
      true,
      legacyShoppingReady,
    );
    const hubChecks = [
      check("Naver API Hub client", ["NAVER_API_HUB_CLIENT_ID", "NAVER_API_HUB_API_KEY_ID"], false),
      check("Naver API Hub secret", ["NAVER_API_HUB_CLIENT_SECRET", "NAVER_API_HUB_API_KEY"], false),
    ];
    const placeChecks = [
      check("Naver Place rank provider URL", ["NAVER_PLACE_RANK_API_URL"], false),
      check("Naver Place rank provider key", ["NAVER_PLACE_RANK_API_KEY"], false),
    ];
    const keywordFeatureCheck = check("Keyword API enabled", ["MI_KEYWORD_API_ENABLED"], true);
    const metaCheck = check("Meta Ad Library access token", ["META_AD_LIBRARY_ACCESS_TOKEN", "META_ADS_LIBRARY_ACCESS_TOKEN"], false);
    const checks = [
      ...searchAdChecks,
      datalabProviderCheck,
      legacyShoppingCheck,
      ...hubChecks,
      ...placeChecks,
      keywordFeatureCheck,
      metaCheck,
    ];
    const missing = requiredMissing(checks);
    const searchAdReady = searchAdChecks.every((item) => item.configured);
    const placeExternalReady = placeChecks.every((item) => item.configured);
    const keywordFeatureReady = process.env.MI_KEYWORD_API_ENABLED === "true";
    const metaAdsReady = metaCheck.configured;
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
          ready: searchAdReady && migratedDatalabReady && keywordFeatureReady,
          source: resolveNaverApiTransport(naverApi, "datalab") === "hub" ? "naver_api_hub_datalab" : "naver_developers_datalab",
        },
        shoppingReferenceAndRank: {
          ready: legacyShoppingReady,
          source: "naver_developers_shopping_search",
          lifecycle: "ends_2026-07-31_no_official_replacement",
          endsAt: NAVER_SHOPPING_SEARCH_LEGACY_ENDS_AT,
        },
        naverApiHubMigration: {
          ready: hubReady,
          mode: naverApi.mode,
          searchProvider: resolveNaverApiTransport(naverApi, "search"),
          datalabProvider: resolveNaverApiTransport(naverApi, "datalab"),
        },
        naverPlaceRank: {
          ready: placeExternalReady,
          source: placeExternalReady ? "external_place_rank_provider" : "naver_openapi_local_fallback",
          note: placeExternalReady
            ? "플레이스 URL 기준 순위 수집 서버가 연결되었습니다."
            : migratedSearchReady
              ? "네이버 공식 검색 API fallback 상태입니다. URL 기준 300위 순위 매칭은 자체 수집 서버 연결이 필요합니다."
              : "플레이스 수집기와 공식 검색 API fallback이 모두 연결되지 않았습니다.",
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
