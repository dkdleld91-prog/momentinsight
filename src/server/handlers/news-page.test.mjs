import assert from "node:assert/strict";
import test from "node:test";
import { collectArticles, renderNewsPage } from "./news-page.mjs";

const article = (title) => ({ title, url: `https://example.com/${encodeURIComponent(title)}`, publishedAt: "2026-09-25T00:00:00.000Z" });
const section = (prefix) => ({
  ok: true,
  count7d: 12,
  lead: article(`${prefix}-리드`),
  items: [article(`${prefix}-1`), article(`${prefix}-2`), article(`${prefix}-3`)],
  all: Array.from({ length: 12 }, (_, index) => article(`${prefix}-all-${index}`)),
});

test("로그인 없는 /news 는 플랫폼별 최신 3건(리드+2)만 싣는다", () => {
  const news = { ok: true, naver: section("n"), coupang: section("c") };
  const items = collectArticles(news);
  assert.equal(items.filter((item) => item.platform === "naver").length, 3);
  assert.equal(items.filter((item) => item.platform === "coupang").length, 3);
  assert.equal(items.some((item) => item.title === "n-3"), false);
  assert.equal(collectArticles(news, { full: true }).filter((item) => item.platform === "naver").length, 12);
  const html = renderNewsPage(news, Date.parse("2026-09-25T03:00:00.000Z"));
  assert.equal(html.includes("n-3"), false);
  assert.equal(html.includes("n-2"), true);
});
