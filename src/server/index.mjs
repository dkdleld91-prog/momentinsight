import health from "./handlers/health.mjs";
import dashboard from "./handlers/dashboard.mjs";
import adminClients from "./handlers/admin-clients.mjs";
import adminApi from "./handlers/admin-api.mjs";
import clientApi from "./handlers/client-api.mjs";
import demoApi from "./handlers/demo-api.mjs";
import naverKeyword from "./handlers/naver-keyword.mjs";
import naverShoppingRank from "./handlers/naver-shopping-rank.mjs";
import { corsHeaders, protectedJson } from "./security.mjs";

const routes = [
  { method: "GET", path: "/health", app: health },
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
          headers: "authorization, x-client-info, apikey, content-type, x-demo-admin-code"
        })
      });
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
          headers: "content-type, x-demo-admin-code"
        });
      }

      return demoApi.fetch(request);
    }

    if (url.pathname === "/api/naver-keyword") {
      return naverKeyword.fetch(request);
    }

    if (url.pathname === "/api/naver-shopping-rank") {
      return naverShoppingRank.fetch(request);
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
