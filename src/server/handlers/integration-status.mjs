import { protectedJson } from "../security.mjs";
import {
  hasNaverApiHubConfig,
  hasNaverMigratedApiConfig,
  isNaverApiHubCutoverReady,
  NAVER_SHOPPING_SEARCH_LEGACY_ENDS_AT,
  naverApiProviderConfig,
  resolveNaverApiTransport,
} from "../naver-api-hub.mjs";
import { collectMobileTopFallbackWindow } from "../naver-shopping/mobile-top-fallback.mjs";
import {
  hasShoppingRankConfig,
  hasShoppingRankHybridConfig,
  hasShoppingRankProviderConfig,
  isMobileTopFallbackMode,
  shoppingCollectorFailureStatus,
  shoppingRankConfig,
} from "../naver-shopping/source-status.mjs";

const SHOPPING_COLLECTOR_SERVICE = "moment-naver-shopping-rank-collector";
const SHOPPING_COLLECTOR_SCHEMA_VERSION = "mi.naver-shopping-organic-window.v1";
const SHOPPING_COLLECTOR_READY_TIMEOUT_MS = 2_000;

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
  return { label, envNames: names, required, configured: Boolean(configured) };
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

async function verifyShoppingCollectorReadiness(urlValue, keyValue) {
  const providerUrl = String(urlValue || "").trim();
  const providerKeyConfigured = Boolean(String(keyValue || "").trim());
  const configured = Boolean(providerUrl && providerKeyConfigured);
  if (!configured) {
    return { configured: false, ready: false, verification: "not_configured" };
  }

  let readyUrl;
  try {
    const configuredUrl = new URL(providerUrl);
    if (configuredUrl.protocol !== "https:" && configuredUrl.protocol !== "http:") {
      throw new Error("unsupported_protocol");
    }
    readyUrl = new URL("/ready", configuredUrl);
  } catch {
    return { configured: true, ready: false, verification: "configured_unverified" };
  }

  const controller = new AbortController();
  let timeoutId;
  try {
    const request = fetch(readyUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      try {
        return { response, payload: await response.json() };
      } catch {
        return { response, payload: null };
      }
    }).catch(() => null);
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, SHOPPING_COLLECTOR_READY_TIMEOUT_MS);
    });
    const result = await Promise.race([request, timeout]);
    const response = result?.response;
    const payload = result?.payload;
    const ready = Boolean(
      response?.ok
      && payload
      && payload.ok === true
      && payload.ready === true
      && payload.service === SHOPPING_COLLECTOR_SERVICE
      && payload.schemaVersion === SHOPPING_COLLECTOR_SCHEMA_VERSION
      && payload.secretConfigured === true
      && payload.provider?.configured === true
      && payload.provider?.verified === true
    );
    return {
      configured: true,
      ready,
      verification: ready ? "verified" : "configured_unverified",
      status: ready
        ? "ready"
        : shoppingCollectorFailureStatus({
          status: response?.status || 0,
          message: "provider_not_ready",
          detail: payload?.provider?.reason || payload?.reason || "",
        }).status,
    };
  } catch {
    return { configured: true, ready: false, verification: "configured_unverified", status: "error" };
  } finally {
    clearTimeout(timeoutId);
  }
}

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return protectedJson(request, { ok: false, message: "Method not allowed" }, 405);
    }

    const naverApi = naverApiProviderConfig();
    const hubReady = hasNaverApiHubConfig(naverApi);
    const hubCutoverReady = isNaverApiHubCutoverReady(naverApi);
    const migratedSearchReady = hasNaverMigratedApiConfig(naverApi, "search");
    const shoppingRank = shoppingRankConfig();
    const shoppingFallbackConfigured = isMobileTopFallbackMode(shoppingRank);
    const shoppingHybridConfigured = hasShoppingRankHybridConfig(shoppingRank);
    const shoppingCollectorConfigured = hasShoppingRankProviderConfig(shoppingRank);
    const shoppingRankConfigured = hasShoppingRankConfig(shoppingRank);
    const shoppingCollectorStatus = shoppingCollectorConfigured
      ? await verifyShoppingCollectorReadiness(
        shoppingRank.providerUrl,
        shoppingRank.providerKey,
      )
      : { configured: false, ready: false, verification: "not_configured", status: "not_configured" };
    const shoppingCollectorReady = shoppingCollectorStatus.ready;
    let shoppingFallbackReady = false;
    let shoppingFallbackStatus = "not_checked";
    let shoppingFallbackVerifiedRankLimit = 0;
    if (shoppingFallbackConfigured) {
      try {
        const fallbackWindow = await collectMobileTopFallbackWindow("온열찜질기", { timeoutMs: 4_500 });
        const fallbackRanks = fallbackWindow.items.map((item) => Number(item?.organicRank || 0));
        shoppingFallbackReady = fallbackWindow.checkedCount >= 35
          && Number(fallbackWindow.verifiedThroughRank || 0) >= 40
          && fallbackWindow.checkedCount === fallbackWindow.items.length
          && fallbackWindow.items.every((item, index) => (
            item?.sourceType === "SAS"
            && item?.isAd === false
            && item?.isOrganic === true
            && Number(item?.organicRank) > 0
            && (index === 0 || Number(item?.organicRank) > fallbackRanks[index - 1])
          ));
        shoppingFallbackVerifiedRankLimit = shoppingFallbackReady
          ? Math.min(50, Number(fallbackWindow.verifiedThroughRank || 0))
          : 0;
        shoppingFallbackStatus = shoppingFallbackReady ? "verified" : "untrusted";
      } catch {
        shoppingFallbackStatus = "unavailable";
      }
    }
    const shoppingProductRankReady = shoppingCollectorReady || shoppingFallbackReady;
    const searchAdChecks = [
      check("Naver SearchAd API key", ["NAVER_SEARCHAD_API_KEY"], true),
      check("Naver SearchAd secret", ["NAVER_SEARCHAD_SECRET_KEY"], true),
      check("Naver SearchAd customer", ["NAVER_SEARCHAD_CUSTOMER_ID"], true),
    ];
    const datalabProviderCheck = configuredCheck(
      "Naver API Hub Search Trend/Shopping Insight provider",
      ["NAVER_API_HUB_CLIENT_ID", "NAVER_API_HUB_CLIENT_SECRET", "NAVER_API_HUB_MODE"],
      true,
      hubCutoverReady,
    );
    const shoppingRankCheck = configuredCheck(
      "Naver shopping reference/rank collector",
      [
        "NAVER_SHOPPING_RANK_MODE",
        "NAVER_SHOPPING_RANK_API_URL",
        "NAVER_SHOPPING_RANK_API_KEY",
      ],
      true,
      shoppingRankConfigured,
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
      shoppingRankCheck,
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
      ok: missing.length === 0 && keywordFeatureReady && shoppingProductRankReady,
      checkedAt: new Date().toISOString(),
      integrations: {
        keywordSearchVolume: {
          ready: searchAdReady && keywordFeatureReady,
          source: "naver_searchad",
        },
        keywordTrendAndRatios: {
          ready: searchAdReady && hubCutoverReady && keywordFeatureReady,
          source: resolveNaverApiTransport(naverApi, "datalab") === "hub" ? "naver_api_hub_datalab" : "not_configured",
        },
        shoppingReferenceAndRank: {
          ready: shoppingProductRankReady,
          configured: shoppingRankConfigured,
          verification: shoppingCollectorReady
            ? shoppingCollectorStatus.verification
            : (shoppingFallbackReady
              ? "mobile_top_verified"
              : (shoppingFallbackConfigured
                ? `mobile_top_${shoppingFallbackStatus}`
              : (!shoppingRankConfigured
                ? "not_configured"
                : (shoppingCollectorStatus.status === "unavailable"
                  ? "provider_unavailable"
                  : shoppingCollectorStatus.verification)))),
          contract: "naver_shopping_results_collector",
          rankEvidence: shoppingFallbackConfigured
            ? "naver_integrated_search_mobile_sas_rank"
            : "naver_shopping_organic_list",
          capabilities: {
            keywordReference: shoppingCollectorReady || shoppingFallbackReady,
            productRank: shoppingProductRankReady,
            // Configuration alone is not execution evidence. A signed local
            // worker becomes full-300 ready only after the separate live gate
            // proves a recent atomic 300-row snapshot.
            full300: shoppingCollectorReady,
            full300Configured: shoppingCollectorReady || shoppingHybridConfigured,
            verifiedRankLimit: shoppingFallbackReady ? shoppingFallbackVerifiedRankLimit : (shoppingCollectorReady ? 300 : 0),
            keywordReferenceMode: shoppingFallbackReady ? "partial_sample" : (shoppingCollectorReady ? "full_window" : "none"),
            full300Mode: shoppingCollectorReady
              ? "server_collector"
              : (shoppingHybridConfigured ? "signed_local_worker_configured" : "none"),
          },
          source: shoppingCollectorReady
            ? "verified_naver_shopping_results_collector"
            : shoppingFallbackReady && shoppingHybridConfigured
              ? "verified_mobile_top_plus_signed_local_worker_configured"
            : shoppingFallbackReady
              ? "verified_naver_integrated_search_mobile_top_fallback"
            : shoppingFallbackConfigured
              ? "mobile_top_fallback_unavailable"
            : shoppingCollectorStatus.status === "unavailable"
              ? "provider_unavailable"
            : shoppingRankConfigured
              ? "configured_unverified"
              : "unavailable_no_official_replacement",
          lifecycle: shoppingCollectorReady
            ? "server_collector"
            : shoppingFallbackReady && shoppingHybridConfigured
              ? "server_fallback_plus_signed_local_worker_pending_live_proof"
            : shoppingFallbackReady
              ? "server_fallback_preserve_on_miss"
            : shoppingFallbackConfigured
              ? "server_fallback_unavailable_preserve_existing"
            : shoppingCollectorStatus.status === "unavailable"
              ? "provider_unavailable_preserve_existing"
            : shoppingRankConfigured
              ? "collector_configured_unverified"
              : "ended_2026-07-31_no_official_replacement",
          endsAt: NAVER_SHOPPING_SEARCH_LEGACY_ENDS_AT,
        },
        naverApiHubMigration: {
          ready: hubCutoverReady,
          credentialsReady: hubReady,
          cutoverLocked: naverApi.mode === "hub",
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
