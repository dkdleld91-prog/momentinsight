import { corsHeaders, protectedJson } from "./security.mjs";
import { createHandlerResolver, executeRequest } from "./runtime.mjs";
import { authorizeCodeSession, boundedApiRequest } from "./session-gate.mjs";

const handlerLoaders = {
  health: () => import("./handlers/health.mjs"),
  ready: () => import("./handlers/ready.mjs"),
  dashboard: () => import("./handlers/dashboard.mjs"),
  adminClients: () => import("./handlers/admin-clients.mjs"),
  adminApi: () => import("./handlers/admin-api.mjs"),
  clientApi: () => import("./handlers/client-api.mjs"),
  demoApi: () => import("./handlers/demo-api.mjs"),
  integrationStatus: () => import("./handlers/integration-status.mjs"),
  codeSessionApi: () => import("./handlers/code-session-api.mjs"),
  ownerToolApi: () => import("./handlers/owner-tool-api.mjs"),
  agencyCodeApi: () => import("./handlers/agency-code-api.mjs"),
  metaAds: () => import("./handlers/meta-ads.mjs"),
  naverKeyword: () => import("./handlers/naver-keyword.mjs"),
  naverProductSeoAudit: () => import("./handlers/naver-product-seo-audit.mjs"),
  naverPlaceRankCron: () => import("./handlers/naver-place-rank-cron.mjs"),
  naverPlaceRankTrackers: () => import("./handlers/naver-place-rank-trackers.mjs"),
  naverRankCron: () => import("./handlers/naver-rank-cron.mjs"),
  naverRankTrackers: () => import("./handlers/naver-rank-trackers.mjs"),
  naverShoppingRank: () => import("./handlers/naver-shopping-rank.mjs"),
  reportCenter: () => import("./handlers/report-center.mjs"),
  superAdminApi: () => import("./handlers/super-admin-api.mjs"),
};

const handler = createHandlerResolver(handlerLoaders);

async function dispatch(name, request) {
  const app = await handler(name);
  return app.fetch(request);
}

const routes = [
  { method: "GET", path: "/health", handler: "health" },
  { method: "GET", path: "/api/health", handler: "health" },
  { method: "GET", path: "/ready", handler: "ready" },
  { method: "GET", path: "/api/ready", handler: "ready" },
  { method: "GET", path: "/api/client/dashboard", handler: "dashboard" },
  { method: "GET", path: "/api/admin/clients", handler: "adminClients" }
];

async function routeRequest(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, {
          methods: "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          headers: "authorization, x-client-info, apikey, content-type, x-retry-count, x-mi-csrf"
        })
      });
    }

    if (url.pathname === "/ready" || url.pathname === "/api/ready") {
      return dispatch("ready", request);
    }

    if (url.pathname === "/api/session") {
      return dispatch("codeSessionApi", request);
    }

    if (url.pathname === "/api/owner/tool") {
      return dispatch("ownerToolApi", request);
    }

    if (url.pathname.startsWith("/api/agency-code/") || url.pathname === "/api/agency-code-validate") {
      return dispatch("agencyCodeApi", request);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      return dispatch("adminApi", request);
    }

    if (url.pathname.startsWith("/api/client/")) {
      return dispatch("clientApi", request);
    }

    if (url.pathname.startsWith("/api/demo/")) {
      if (url.pathname === "/api/demo/public-state" && process.env.MI_DEMO_PUBLIC_STATE_ENABLED !== "true") {
        return protectedJson(request, {
          ok: false,
          message: "데모 공개 저장 API는 비공개 상태입니다."
        }, 403, {
          methods: "POST, OPTIONS",
          headers: "content-type, x-demo-admin-code, x-mi-agency-code, x-mi-rank-access-code"
        });
      }

      return dispatch("demoApi", request);
    }

    if (url.pathname.startsWith("/api/super-admin/") || url.pathname === "/api/super-admin-agency-codes") {
      return dispatch("superAdminApi", request);
    }

    if (url.pathname.startsWith("/api/team/") || url.pathname === "/api/team-agency-codes") {
      return dispatch("superAdminApi", request);
    }

    if (url.pathname === "/api/naver-keyword") {
      return dispatch("naverKeyword", request);
    }

    if (url.pathname === "/api/naver-product-seo-audit") {
      return dispatch("naverProductSeoAudit", request);
    }

    if (url.pathname === "/api/naver-shopping-rank") {
      return dispatch("naverShoppingRank", request);
    }

    if (url.pathname === "/api/naver-rank-trackers") {
      return dispatch("naverRankTrackers", request);
    }

    if (url.pathname === "/api/naver-rank-cron") {
      return dispatch("naverRankCron", request);
    }

    if (url.pathname === "/api/naver-place-rank-trackers") {
      return dispatch("naverPlaceRankTrackers", request);
    }

    if (url.pathname === "/api/naver-place-rank-cron") {
      return dispatch("naverPlaceRankCron", request);
    }

    if (url.pathname === "/api/meta-ads") {
      return dispatch("metaAds", request);
    }

    if (url.pathname === "/api/report-center") {
      return dispatch("reportCenter", request);
    }

    if (url.pathname === "/api/integration-status") {
      return dispatch("integrationStatus", request);
    }

    const route = routes.find((item) => item.method === request.method && item.path === url.pathname);

    if (!route) {
      return Response.json({
        ok: false,
        message: "Not found",
        routes: routes.map((item) => `${item.method} ${item.path}`)
      }, { status: 404 });
    }

    return dispatch(route.handler, request);
}

export default {
  fetch(request) {
    return executeRequest(request, async () => {
      const bounded = await boundedApiRequest(request);
      if (!bounded.ok) return bounded.response;
      const authorized = await authorizeCodeSession(bounded.request);
      if (!authorized.ok) return authorized.response;
      return routeRequest(authorized.request);
    });
  },
};
