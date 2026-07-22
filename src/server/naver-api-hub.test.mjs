import assert from "node:assert/strict";
import test from "node:test";

import {
  hasNaverApiHubConfig,
  hasNaverMigratedApiConfig,
  naverApiErrorMessage,
  naverApiFailureDisposition,
  naverApiProviderConfig,
  naverDatalabRequest,
  naverSearchRequest,
  resolveNaverApiTransport,
} from "./naver-api-hub.mjs";

const legacyEnv = {
  NAVER_OPENAPI_CLIENT_ID: "legacy-search-id",
  NAVER_OPENAPI_CLIENT_SECRET: "legacy-search-secret",
  NAVER_DATALAB_CLIENT_ID: "legacy-datalab-id",
  NAVER_DATALAB_CLIENT_SECRET: "legacy-datalab-secret",
};

const hubEnv = {
  NAVER_API_HUB_CLIENT_ID: "hub-id",
  NAVER_API_HUB_CLIENT_SECRET: "hub-secret",
};

test("auto mode preserves the legacy request contract until API Hub keys exist", () => {
  const config = naverApiProviderConfig({ ...legacyEnv, NAVER_API_HUB_MODE: "auto" });
  const search = naverSearchRequest(config, "blog", { query: "테스트", display: "1" });
  const trend = naverDatalabRequest(config, "search-trend");

  assert.equal(resolveNaverApiTransport(config, "search"), "legacy");
  assert.equal(resolveNaverApiTransport(config, "datalab"), "legacy");
  assert.match(search.url, /^https:\/\/openapi\.naver\.com\/v1\/search\/blog\.json\?/);
  assert.equal(search.headers["X-Naver-Client-Id"], "legacy-search-id");
  assert.equal(search.headers["X-Naver-Client-Secret"], "legacy-search-secret");
  assert.equal(trend.url, "https://openapi.naver.com/v1/datalab/search");
  assert.equal(trend.headers["X-Naver-Client-Id"], "legacy-datalab-id");
});

test("auto mode switches migrated Search and DataLab calls to NAVER API Hub when its key pair exists", () => {
  const config = naverApiProviderConfig({ ...legacyEnv, ...hubEnv, NAVER_API_HUB_MODE: "auto" });
  const local = naverSearchRequest(config, "local", { query: "부평 맛집", display: "5" });
  const trend = naverDatalabRequest(config, "search-trend");
  const age = naverDatalabRequest(config, "shopping-insight-keyword", "age");

  assert.equal(hasNaverApiHubConfig(config), true);
  assert.equal(resolveNaverApiTransport(config, "search"), "hub");
  assert.equal(resolveNaverApiTransport(config, "datalab"), "hub");
  assert.match(local.url, /^https:\/\/naverapihub\.apigw\.ntruss\.com\/search\/v1\/local\?/);
  assert.equal(local.headers["X-NCP-APIGW-API-KEY-ID"], "hub-id");
  assert.equal(local.headers["X-NCP-APIGW-API-KEY"], "hub-secret");
  assert.equal(trend.url, "https://naverapihub.apigw.ntruss.com/search-trend/v1/search");
  assert.equal(age.url, "https://naverapihub.apigw.ntruss.com/shopping/v1/category/keyword/age");
  assert.equal(age.headers["Content-Type"], "application/json");
});

test("explicit modes fail closed instead of silently mixing incomplete credential pairs", () => {
  const forcedHub = naverApiProviderConfig({ ...legacyEnv, NAVER_API_HUB_MODE: "hub" });
  const forcedLegacy = naverApiProviderConfig({ ...legacyEnv, ...hubEnv, NAVER_API_HUB_MODE: "legacy" });

  assert.equal(hasNaverMigratedApiConfig(forcedHub, "search"), false);
  assert.equal(resolveNaverApiTransport(forcedHub, "search"), "not-configured");
  assert.throws(() => naverSearchRequest(forcedHub, "blog"), { code: "NAVER_API_NOT_CONFIGURED" });
  assert.equal(resolveNaverApiTransport(forcedLegacy, "search"), "legacy");
});

test("API Hub alias key names are accepted as one complete pair", () => {
  const config = naverApiProviderConfig({
    NAVER_API_HUB_API_KEY_ID: "alias-id",
    NAVER_API_HUB_API_KEY: "alias-secret",
    NAVER_API_HUB_MODE: "hub",
  });
  const request = naverSearchRequest(config, "blog");

  assert.equal(request.provider, "hub");
  assert.equal(request.headers["X-NCP-APIGW-API-KEY-ID"], "alias-id");
  assert.equal(request.headers["X-NCP-APIGW-API-KEY"], "alias-secret");
});

test("missing or invalid mode keeps production on legacy until the cutover is explicit", () => {
  const missing = naverApiProviderConfig({ ...legacyEnv, ...hubEnv });
  const invalid = naverApiProviderConfig({ ...legacyEnv, ...hubEnv, NAVER_API_HUB_MODE: "unexpected" });

  assert.equal(missing.mode, "legacy");
  assert.equal(invalid.mode, "legacy");
  assert.equal(resolveNaverApiTransport(missing, "search"), "legacy");
  assert.equal(resolveNaverApiTransport(invalid, "datalab"), "legacy");
});

test("new API Gateway errors retain useful messages and lifecycle classification", () => {
  assert.equal(naverApiErrorMessage({ error: { message: "Authentication Failed" } }), "Authentication Failed");
  assert.equal(naverApiErrorMessage({ errMsg: "invalid category" }), "invalid category");
  assert.equal(naverApiFailureDisposition(401), "credentials_or_permission");
  assert.equal(naverApiFailureDisposition(404), "endpoint_removed");
  assert.equal(naverApiFailureDisposition(410), "endpoint_removed");
  assert.equal(naverApiFailureDisposition(429), "rate_limited");
  assert.equal(naverApiFailureDisposition(503), "temporary_provider_failure");
});
