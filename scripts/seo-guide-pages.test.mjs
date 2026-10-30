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

// ── 2026-10-30 고칠 목록(fix-1030, 대표 승인) ──────────────────────────────────────────────
const byslug = Object.fromEntries(pages.map((page) => [page.slug, page]));
const rankPage = byslug["naver-shopping-rank-tracking"];
const keywordPage = byslug["naver-keyword-search-volume"];
const mainText = (html) => html.slice(html.indexOf("<main>"), html.indexOf("</main>")).replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
const count = (text, needle) => text.split(needle).length - 1;

test("순위 페이지는 '순위 확인'이 아니라 '순위 추적·30일 변동 기록'을 앞세운다(주소는 그대로)", () => {
  const html = rankPage.html;
  const title = (html.match(/<title>([^<]+)<\/title>/u) || [])[1] || "";
  const heads = [title, meta(html, "name", "description"), meta(html, "property", "og:title"), meta(html, "property", "og:description"), meta(html, "name", "twitter:title"), meta(html, "name", "twitter:description")];
  for (const text of heads) {
    assert.ok(text, "머리 값 있음");
    assert.doesNotMatch(text, /순위 확인/u, text);
  }
  assert.ok(title.startsWith("네이버 쇼핑 순위 추적") && title.includes("30일 순위 변동 기록"), title);
  assert.match(meta(html, "property", "og:title"), /^네이버 쇼핑 순위 추적 · 30일 변동 기록/u);
  assert.match((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/u) || [])[1].replace(/<[^>]+>/gu, ""), /순위 추적.*30일 변동/u);
  assert.equal(rankPage.slug, "naver-shopping-rank-tracking");
});

test("두 페이지 모두 첫 화면 바로 아래에 '이럴 때 씁니다' 3가지와 가짜 데이터 예시 숫자 1개", () => {
  const expected = {
    "naver-shopping-rank-tracking": ["광고비를 쓰기 전에", "바꾼 뒤 효과 확인", "광고주에게 기록으로 보고", "23위 → 9위"],
    "naver-keyword-search-volume": ["상품 등록 전에 키워드 고르기", "시즌 전에 광고 준비", "광고비 예산 잡기", "5월 최다 → 4월 준비"],
  };
  for (const page of pages) {
    const start = page.html.indexOf('id="mi-guide-use"');
    const end = page.html.indexOf('id="mi-guide-what"');
    assert.ok(start > page.html.indexOf('class="mi-hero"') && start < end, `${page.slug}: 첫 화면 다음, 기능 카드 앞`);
    const block = page.html.slice(start, end);
    assert.equal((block.match(/<article class="mi-card">/gu) || []).length, 3, page.slug);
    assert.equal((block.match(/class="mi-example"/gu) || []).length, 1, `${page.slug}: 예시 숫자 1개`);
    assert.match(block, /<p class="mi-example"><span>예시 숫자 · 가짜 데이터<\/span><strong>[^<]+<\/strong><\/p>/u, page.slug);
    for (const phrase of expected[page.slug]) assert.ok(block.includes(phrase), `${page.slug}: ${phrase}`);
  }
});

test("순위 기능 카드는 4개, '몇 페이지 몇 번째'·'가격비교(원부)'는 자주 묻는 질문으로", () => {
  const html = rankPage.html;
  const cards = html.slice(html.indexOf('id="mi-guide-what"'), html.indexOf('id="mi-guide-how"'));
  assert.equal((cards.match(/<article class="mi-card">/gu) || []).length, 4);
  assert.doesNotMatch(cards, /몇 페이지 몇 번째|가격비교\(원부\)/u);
  const faq = html.slice(html.indexOf('id="mi-guide-faq"'), html.indexOf('id="mi-guide-related"'));
  assert.ok(faq.includes("몇 페이지 몇 번째인지도 나오나요?"));
  assert.ok(faq.includes("광고를 뺀 40개 보기 기준으로 몇 페이지 몇 번째인지도"));
  assert.ok(faq.includes("가격비교(원부) 카드로 묶인 상품은 어떻게 세나요?"));
});

test("같은 말 되풀이 줄이기: 본문에서 '하루 2~3회'·'광고를 뺀 상위 300개'는 두 번까지", () => {
  const text = mainText(rankPage.html);
  assert.ok(count(text, "하루 2~3회") <= 2, `하루 2~3회 ${count(text, "하루 2~3회")}번`);
  assert.ok(count(text, "광고를 뺀 상위 300개") + count(text, "광고를 뺀 상위 순위") <= 2, "광고를 뺀 상위 300개");
  for (const page of pages) {
    assert.doesNotMatch(page.html.slice(page.html.indexOf('<footer class="mi-footer">')), /하루 2~3회|수집/u, `${page.slug}: 바닥 줄`);
  }
  const keyword = mainText(keywordPage.html);
  assert.ok(count(keyword, "최대 5개") <= 2, `최대 5개 ${count(keyword, "최대 5개")}번`);
});

test("'오가닉·원부·회차'는 처음 나올 때 쉬운 말로 풀고, '수집'은 쓰지 않는다", () => {
  const text = mainText(rankPage.html);
  const near = (word, explain) => {
    const at = text.indexOf(word);
    assert.ok(at >= 0, word);
    assert.ok(text.slice(Math.max(0, at - 20), at + word.length + 40).includes(explain), `${word}: ${text.slice(at, at + 60)}`);
  };
  near("오가닉", "광고가 아닌 일반 상품");
  near("원부", "여러 판매처를 하나로 묶은 네이버 가격비교 카드");
  near("회차", "한 번 확인하는 것을");
  for (const page of pages) assert.doesNotMatch(mainText(page.html), /수집/u, page.slug);
});

test("키워드 페이지에는 '로그인 없이 연관 키워드 조회' 안내·링크가 없다(10/20 홈 결정)", () => {
  assert.doesNotMatch(keywordPage.html, /related-keywords|로그인 없이 연관|IP별/u);
  assert.equal((keywordPage.html.match(/itemtype="https:\/\/schema\.org\/Question"/gu) || []).length, 5);
});

test("가격은 비공개: 요금·금액 문구가 없다", () => {
  for (const page of pages) {
    const text = mainText(page.html);
    assert.doesNotMatch(text, /\d[\d,]*\s*(?:만\s*)?원(?!부)|요금|가격 안내|월\s*구독|₩|VAT/u, page.slug);
  }
});

test("예시 그림의 width·height 가 실제 webp 크기와 같다(광고주 화면 다시 찍기)", () => {
  const webpSize = (file) => {
    const b = fs.readFileSync(new URL(`../${file}`, import.meta.url));
    const chunk = b.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    const v = b.readUInt32LE(21);
    return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1];
  };
  for (const page of pages) {
    for (const match of page.html.matchAll(/(?:src|srcset)="(\/guide\/img\/[a-z0-9-]+\.webp)" width="(\d+)" height="(\d+)"/gu)) {
      assert.deepEqual(webpSize(`public${match[1]}`), [Number(match[2]), Number(match[3])], match[1]);
    }
    assert.equal([...page.html.matchAll(/(?:src|srcset)="\/guide\/img\/[a-z0-9-]+\.webp" width="\d+" height="\d+"/gu)].length, 2, page.slug);
  }
});
