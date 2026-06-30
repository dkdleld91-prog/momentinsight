import health from "./handlers/health.mjs";
import dashboard from "./handlers/dashboard.mjs";
import adminClients from "./handlers/admin-clients.mjs";
import adminApi from "./handlers/admin-api.mjs";
import clientApi from "./handlers/client-api.mjs";
import demoApi from "./handlers/demo-api.mjs";
import integrationStatus from "./handlers/integration-status.mjs";
import agencyCodeApi from "./handlers/agency-code-api.mjs";
import metaAds from "./handlers/meta-ads.mjs";
import metaResearch from "./handlers/meta-research.mjs";
import naverKeyword from "./handlers/naver-keyword.mjs";
import naverRankCron from "./handlers/naver-rank-cron.mjs";
import naverRankTrackers from "./handlers/naver-rank-trackers.mjs";
import naverShoppingRank from "./handlers/naver-shopping-rank.mjs";
import reportCenter from "./handlers/report-center.mjs";
import superAdminApi from "./handlers/super-admin-api.mjs";
import { corsHeaders, protectedJson } from "./security.mjs";

const routes = [
  { method: "GET", path: "/health", app: health },
  { method: "GET", path: "/api/health", app: health },
  { method: "GET", path: "/api/client/dashboard", app: dashboard },
  { method: "GET", path: "/api/admin/clients", app: adminClients }
];

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, {
          methods: "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          headers: "authorization, x-client-info, apikey, content-type, x-retry-count, x-demo-admin-code, x-mi-agency-code, x-mi-rank-access-code, x-mi-super-admin-code, x-mi-owner-agency-code, x-mi-team-code"
        })
      });
    }

    if (url.pathname.startsWith("/api/agency-code/") || url.pathname === "/api/agency-code-validate") {
      return agencyCodeApi.fetch(request);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      return adminApi.fetch(request);
    }

    if (url.pathname.startsWith("/api/client/")) {
      return clientApi.fetch(request);
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

      return demoApi.fetch(request);
    }

    if (url.pathname.startsWith("/api/super-admin/") || url.pathname === "/api/super-admin-agency-codes") {
      return superAdminApi.fetch(request);
    }

    if (url.pathname.startsWith("/api/team/") || url.pathname === "/api/team-agency-codes") {
      return superAdminApi.fetch(request);
    }

    if (url.pathname === "/api/naver-keyword") {
      return naverKeyword.fetch(request);
    }

    if (url.pathname === "/api/naver-shopping-rank") {
      return naverShoppingRank.fetch(request);
    }

    if (url.pathname === "/api/naver-rank-trackers") {
      return naverRankTrackers.fetch(request);
    }

    if (url.pathname === "/api/naver-rank-cron") {
      return naverRankCron.fetch(request);
    }

    if (url.pathname === "/api/meta-ads") {
      return metaAds.fetch(request);
    }

    if (url.pathname === "/api/meta-research") {
      return metaResearch.fetch(request);
    }

    if (url.pathname === "/api/report-center") {
      return reportCenter.fetch(request);
    }

    if (url.pathname === "/api/integration-status") {
      return integrationStatus.fetch(request);
    }

    const route = routes.find((item) => item.method === request.method && item.path === url.pathname);

    if (!route) {
      return Response.json({
        ok: false,
        message: "Not found",
        routes: routes.map((item) => `${item.method} ${item.path}`)
      }, { status: 404 });
    }

    return route.app.fetch(request);
  }
};
