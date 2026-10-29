// 공개 사용 안내 페이지(/guide/<slug>) 목록과 sitemap 주소 — 빌드(build-vercel-static.mjs)와 시험이 같이 읽는다(2026-10-29).
// 새 안내 페이지는 여기에 한 줄 더하면 dist/guide/<slug>.html 복사·sitemap·시험이 함께 따라온다.
// 주소는 vercel.json cleanUrls 로 /guide/<slug> 에서 열린다. cleanUrls 와 겹치는 .html rewrite 는 두지 않는다(Codex 검수 2026-10-29).
export const SITE_URL = "https://insight.momentlabs.co.kr";

export const GUIDE_PAGES = Object.freeze([
  Object.freeze({ slug: "naver-shopping-rank-tracking", source: "guide-naver-shopping-rank-tracking.html" }),
  Object.freeze({ slug: "naver-keyword-search-volume", source: "guide-naver-keyword-search-volume.html" }),
]);

export function guidePath(slug) {
  return `/guide/${slug}`;
}

export function sitemapXml(siteUrl = SITE_URL) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${siteUrl}/</loc></url>`,
    `  <url><loc>${siteUrl}/news</loc><changefreq>hourly</changefreq></url>`,
    ...GUIDE_PAGES.map((page) => `  <url><loc>${siteUrl}${guidePath(page.slug)}</loc></url>`),
    `  <url><loc>${siteUrl}/privacy</loc></url>`,
    "</urlset>",
    "",
  ].join("\n");
}
