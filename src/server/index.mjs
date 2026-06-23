import health from "./handlers/health.mjs";
import dashboard from "./handlers/dashboard.mjs";
import adminClients from "./handlers/admin-clients.mjs";
import adminApi from "./handlers/admin-api.mjs";
import clientApi from "./handlers/client-api.mjs";
import demoApi from "./handlers/demo-api.mjs";
import naverKeyword from "./handlers/naver-keyword.mjs";

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
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-demo-admin-code"
        }
      });
    }

    if (url.pathname.startsWith("/api/admin/")) {
      return adminApi.fetch(request);
    }

    if (url.pathname.startsWith("/api/client/")) {
      return clientApi.fetch(request);
    }

    if (url.pathname.startsWith("/api/demo/")) {
      return demoApi.fetch(request);
    }

    if (url.pathname === "/api/naver-keyword") {
      return naverKeyword.fetch(request);
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
