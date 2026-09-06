import { loadPublicMarketNews } from "../../src/server/handlers/home-feed.mjs";

// 로그인 없이 보이는 공개 데이터만 서빙한다(플랫폼 뉴스). 광고주·세션 데이터는 절대 다루지 않으므로
// 세션 게이트를 거치지 않고 핸들러를 직접 부른다. CDN 1시간 캐시로 원본 호출을 줄인다.
const RESOURCE_PATTERN = /^[a-z0-9-]{1,64}$/;

function resourceOf(req) {
  const fromQuery = typeof req.query?.resource === "string" ? req.query.resource : "";
  const pathname = String(req.url || "").split("?")[0];
  const fromUrl = pathname.split("/").filter(Boolean)[2] || "";
  return String(fromQuery || fromUrl).trim().toLowerCase();
}

function send(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  if (cacheControl) res.setHeader("cache-control", cacheControl);
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  const resource = resourceOf(req);
  if (!RESOURCE_PATTERN.test(resource) || (resource !== "market-news" && resource !== "news-page")) return send(res, 404, { ok: false, message: "Not found" });
  if ((req.method || "GET") !== "GET") return send(res, 405, { ok: false, message: "Method not allowed" });
  // /news → 서버가 기사 목록을 넣은 HTML을 보낸다(검색 로봇용). 실패해도 빈 목록 페이지를 200으로 돌려준다.
  if (resource === "news-page") {
    const { renderNewsPage } = await import("../../src/server/handlers/news-page.mjs");
    let news = null;
    try {
      news = await loadPublicMarketNews();
    } catch (error) {
      news = { ok: false, reason: "news_unavailable" };
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", news && news.ok !== false ? "public, s-maxage=3600, stale-while-revalidate=600" : "public, s-maxage=300");
    res.end(renderNewsPage(news, Date.now()));
    return;
  }
  try {
    const news = await loadPublicMarketNews();
    return send(res, 200, { ok: true, news }, "public, s-maxage=3600, stale-while-revalidate=600");
  } catch (error) {
    return send(res, 200, { ok: true, news: { ok: false, reason: "news_unavailable" } }, "public, s-maxage=300");
  }
}
