import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { GUIDE_PAGES, SITE_URL, guidePath, sitemapXml } from "./public-guide-pages.mjs";

// 공개 사용 안내 페이지(/guide/*, 2026-10-29): 검색 노출용 기본값(제목·설명·canonical·OG)·sitemap·라우팅·
// CSP(인라인 script 없음)·홈과의 내부 링크·예시 화면 표기를 원본에서 확인한다.
const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const exists = (relative) => fs.existsSync(new URL(`../${relative}`, import.meta.url));
const pages = GUIDE_PAGES.map((page) => ({ ...page, html: read(`src/pages/${page.source}`), url: `${SITE_URL}${guidePath(page.slug)}` }));
const meta = (html, attr, name) => {
  const match = html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)" />`, "u"));
  return match ? match[1] : null;
};

test("안내 페이지는 짧은 영문 주소 두 개다", () => {
  assert.deepEqual(GUIDE_PAGES.map((page) => guidePath(page.slug)), [
    "/guide/naver-shopping-rank-tracking",
    "/guide/naver-keyword-search-volume",
  ]);
  for (const page of GUIDE_PAGES) assert.match(page.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
});

test("문서 뼈대·모바일 viewport·색인 허용", () => {
  for (const page of pages) {
    assert.ok(page.html.startsWith("<!doctype html>\n<html lang=\"ko\">"), page.slug);
    assert.ok(page.html.trimEnd().endsWith("</html>"), page.slug);
    assert.ok(page.html.includes('<meta name="viewport" content="width=device-width, initial-scale=1" />'), page.slug);
    assert.equal(meta(page.html, "name", "robots"), "index, follow", page.slug);
    assert.equal((page.html.match(/<h1\b/g) || []).length, 1, `${page.slug}: h1 하나`);
  }
});

test("제목·설명·canonical·OG 가 페이지 주소와 맞는다", () => {
  const titles = new Set();
  for (const page of pages) {
    const title = (page.html.match(/<title>([^<]+)<\/title>/u) || [])[1] || "";
    assert.ok(title.endsWith("| 모먼트 인사이트") && title.length <= 60, `${page.slug}: ${title}`);
    titles.add(title);
    const description = meta(page.html, "name", "description") || "";
    assert.ok(description.length >= 60 && description.length <= 160, `${page.slug}: 설명 길이 ${description.length}`);
    assert.ok(page.html.includes(`<link rel="canonical" href="${page.url}" />`), page.slug);
    assert.equal(meta(page.html, "property", "og:url"), page.url, page.slug);
    assert.equal(meta(page.html, "property", "og:type"), "article", page.slug);
    assert.ok(meta(page.html, "property", "og:title"), page.slug);
    assert.ok(meta(page.html, "property", "og:description"), page.slug);
    assert.equal(meta(page.html, "property", "og:image"), `${SITE_URL}/og-image.jpg`, page.slug);
  }
  assert.equal(titles.size, pages.length, "제목이 겹치지 않는다");
});

test("인라인 script 가 없어 CSP 해시를 늘리지 않는다(분석 스크립트만 외부 파일로)", () => {
  for (const page of pages) {
    const scripts = [...page.html.matchAll(/<script\b([^>]*)>/giu)].map((match) => match[1]);
    assert.deepEqual(scripts, [' src="/mi-analytics.js?v=site-v2-20260907" defer'], page.slug);
    assert.doesNotMatch(page.html, /\son[a-z]+=/iu, `${page.slug}: 인라인 이벤트 속성 없음`);
    assert.ok(page.html.includes('<link rel="stylesheet" href="/mi-tokens.css'), page.slug);
    assert.ok(page.html.includes('<link rel="stylesheet" href="/mi-guide.css'), page.slug);
  }
  assert.ok(exists("public/mi-guide.css"));
  const csp = JSON.parse(read("vercel.json")).headers.find((rule) => rule.source === "/(.*)")
    .headers.find((header) => header.key === "Content-Security-Policy").value;
  assert.doesNotMatch(csp.match(/script-src [^;]+/u)[0], /'unsafe-inline'/u);
});

test("홈·다른 안내·가입·카카오 문의로 이어지고, 쿠팡은 언급하지 않는다", () => {
  for (const page of pages) {
    assert.ok(page.html.includes('<a class="mi-brand" href="/"'), `${page.slug}: 홈 링크`);
    for (const other of GUIDE_PAGES) assert.ok(page.html.includes(`href="${guidePath(other.slug)}"`), `${page.slug} → ${other.slug}`);
    assert.ok(page.html.includes('href="/client?signup=1"'), `${page.slug}: 가입`);
    assert.ok(page.html.includes('href="https://pf.kakao.com/_ixoLxfX"'), `${page.slug}: 카카오 문의`);
    assert.ok(page.html.includes('class="mi-kakao-floating"'), `${page.slug}: 카카오 떠 있는 버튼`);
    assert.doesNotMatch(page.html, /쿠팡|coupang/iu, `${page.slug}: 쿠팡 언급 없음`);
  }
  const home = read("src/pages/home.html");
  for (const page of GUIDE_PAGES) assert.ok(home.includes(`href="${guidePath(page.slug)}"`), `홈 → ${page.slug}`);
});

test("무료 범위 문구가 홈과 같다(하루 5회 · 도입 후 30일 순위 추적)", () => {
  const home = read("src/pages/home.html");
  const sentence = "구글 계정으로 가입하면 키워드 조회를 하루 5회 무료로 쓸 수 있습니다. 30일 순위 추적과 전체 기능은 도입 후 열립니다.";
  assert.ok(home.includes(sentence), "홈 원문");
  for (const page of pages) assert.ok(page.html.includes(sentence), page.slug);
  assert.match(read("src/server/code-session.mjs"), /export const TRIAL_KEYWORD_DAILY_LIMIT = 5;/u);
});

test("예시 화면은 '예시 화면'으로 표시하고, 그림 파일이 있으며 가볍다", () => {
  for (const page of pages) {
    assert.ok(page.html.includes('<span class="mi-shot-label">예시 화면</span>'), page.slug);
    assert.ok(page.html.includes("가짜 데이터"), page.slug);
    const sources = [...page.html.matchAll(/(?:src|srcset)="(\/guide\/img\/[a-z0-9-]+\.webp)"/gu)].map((match) => match[1]);
    assert.equal(sources.length, 2, `${page.slug}: 넓은 화면·모바일 그림`);
    for (const source of sources) {
      const file = `public${source}`;
      assert.ok(exists(file), file);
      const bytes = fs.statSync(new URL(`../${file}`, import.meta.url)).size;
      assert.ok(bytes > 10_000 && bytes < 400_000, `${file}: ${bytes}B`);
      assert.equal(fs.readFileSync(new URL(`../${file}`, import.meta.url)).subarray(8, 12).toString("latin1"), "WEBP", file);
    }
    assert.match(page.html, /<img src="\/guide\/img\/[a-z0-9-]+\.webp" width="\d+" height="\d+" loading="lazy" decoding="async" alt="예시 화면: /u, page.slug);
  }
});

test("자주 묻는 질문 4~6개가 FAQPage 마이크로데이터로 붙어 있다", () => {
  for (const page of pages) {
    assert.ok(page.html.includes('itemscope itemtype="https://schema.org/FAQPage"'), page.slug);
    const questions = (page.html.match(/itemtype="https:\/\/schema\.org\/Question"/g) || []).length;
    const answers = (page.html.match(/itemtype="https:\/\/schema\.org\/Answer"/g) || []).length;
    assert.ok(questions >= 4 && questions <= 6, `${page.slug}: 질문 ${questions}`);
    assert.equal(answers, questions, page.slug);
  }
});

test("빌드가 dist/guide/<slug>.html 로 내보내고 sitemap·라우팅에 들어간다", () => {
  const build = read("scripts/build-vercel-static.mjs");
  assert.ok(build.includes('import { GUIDE_PAGES, SITE_URL, sitemapXml } from "./public-guide-pages.mjs";'));
  assert.ok(build.includes('path.join(outputDir, "guide", `${page.slug}.html`)'));
  const xml = sitemapXml();
  for (const page of pages) assert.ok(xml.includes(`<url><loc>${page.url}</loc></url>`), page.slug);
  for (const kept of ["/", "/news", "/privacy"]) assert.ok(xml.includes(`<loc>${SITE_URL}${kept}</loc>`), kept);
  assert.equal((xml.match(/<url>/g) || []).length, 3 + GUIDE_PAGES.length);
  const vercel = JSON.parse(read("vercel.json"));
  assert.equal(vercel.cleanUrls, true);
  // cleanUrls 가 dist/guide/<slug>.html 을 /guide/<slug> 로 내보낸다. 같은 주소를 가로채는 rewrite·redirect 는 두지 않는다.
  for (const page of GUIDE_PAGES) {
    for (const rule of [...(vercel.rewrites || []), ...(vercel.redirects || [])]) {
      assert.ok(!String(rule.source).startsWith("/guide"), `${page.slug}: ${rule.source}`);
    }
  }
  // 공개 빌드 검사도 안내 페이지를 필수 산출물로 본다.
  assert.ok(read("scripts/check-public-build-security.mjs").includes("GUIDE_PAGES.map((page) => `guide/${page.slug}.html`)"));
});
