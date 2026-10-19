// Local fixture-only browser QA. Never loads credentials, the production API,
// a Shopping collector, rank state, or a database. Fixtures are not live proof.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "../tools/naver-shopping-rank-collector/node_modules/playwright/index.mjs";

const root = process.cwd();
const pages = new Map();
const assets = new Map();
for (const page of ["admin", "client"]) {
  const html = await fs.readFile(`${root}/src/pages/${page}.html`, "utf8");
  const start = html.search(/<section\b[^>]*\bdata-related-query(?:\s|>)/u);
  assert.ok(start >= 0, `${page}: related view exists`);
  const end = html.indexOf("</section>", start) + "</section>".length;
  const view = html.slice(start, end).replace('class="mi-view"', 'class="mi-view is-active"');
  const styles = [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gu)].map((match) => match[0]).join("\n");
  const id = page === "admin" ? "mi-admin" : "mi-clean";
  const cls = page === "admin" ? "mi-admin-wrap" : "mi-client-wrap";
  pages.set(`/${page}`, `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOCAL FIXTURE QA ONLY</title><link rel="stylesheet" href="/mi-tokens.css"><link rel="stylesheet" href="/mi-related-keywords.css">${styles}<body><p style="padding:12px">로컬 기능 검수 전용 · 아래 결과는 테스트 응답이며 실제 조회가 아닙니다.</p><section id="${id}" class="${cls} is-authed">${view}</section><script src="/mi-related-keywords.js" defer></script></body></html>`);
}
for (const asset of ["mi-tokens.css", "mi-related-keywords.css", "mi-related-keywords.js"]) assets.set(`/${asset}`, await fs.readFile(`${root}/public/${asset}`));
const server = http.createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("cache-control", "no-store");
  if (pages.has(path)) { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(pages.get(path)); return; }
  if (assets.has(path)) { response.setHeader("content-type", path.endsWith(".js") ? "application/javascript" : "text/css"); response.end(assets.get(path)); return; }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const storedCheckedAt = "2026-10-19T01:21:24.483Z";
const category = (status, paths, extra = {}) => ({
  status,
  reason: status === "single" ? "stored_sample_consistent" : status === "multiple" ? "incomplete_sample" : "no_stored_evidence",
  middle: status === "single" ? paths[0].middle : null,
  small: status === "single" ? paths[0].small : null,
  paths,
  sampleSize: 5,
  categorizedCount: status === "single" ? 5 : status === "multiple" ? 2 : 0,
  checkedAt: status === "needs_confirmation" ? null : storedCheckedAt,
  source: "stored_rank_snapshot_categories",
  basis: "stored_top5",
  ...extra
});
const one = { middle: "냉온/찜질용품", small: "찜질기" };
const other = { middle: "침구류", small: "전기매트" };
const rows = [
  { keyword: "허리찜질기", volume: 300, pcVolume: 100, mobileVolume: 200, category: category("single", [one]) },
  { keyword: "찜질패드", volume: 200, pcVolume: 50, mobileVolume: 150, category: category("multiple", [one, other]) },
  { keyword: "전기찜질팩", volume: null, volumeLabel: "< 20", pcVolume: null, pcVolumeLabel: "< 10", mobileVolume: null, mobileVolumeLabel: "< 10", category: category("needs_confirmation", []) },
];
let browser;
let checks = 0;
try {
  browser = await chromium.launch({ headless: true });
  for (const surface of ["admin", "client"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let categoryRequests = 0;
    await page.route("**/*", (route) => {
      // API routes below are fully mocked; every other request must be a
      // fixture asset served by this ephemeral loopback server.
      if (new URL(route.request().url()).origin === origin) return route.continue();
      return route.abort("blockedbyclient");
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      assert.ok([origin, "http://127.0.0.1:8790"].includes(url.origin), "QA API requests must remain local and fully intercepted");
      const headers = { "access-control-allow-origin": origin };
      if (url.pathname === "/api/session") {
        await route.fulfill({ headers, json: { ok: true, session: { role: surface === "admin" ? "owner" : "client", scopeKey: "fixture-session", clientId: "fixture-client" } } });
        return;
      }
      assert.equal(url.pathname, "/api/client/keyword-research", "no existing rank/keyword API call");
      assert.equal(url.searchParams.get("mode"), "related");
      categoryRequests += 1;
      const keyword = url.searchParams.get("keyword");
      if (keyword === "오류검수") await route.fulfill({ headers, status: 503, json: { ok: false, related: [] } });
      else await route.fulfill({ headers, json: { ok: true, keyword, related: rows } });
    });
    await page.goto(`${origin}/${surface}`, { waitUntil: "load" });
    const input = page.locator("[data-related-query-input]");
    await input.fill("온열찜질기");
    await page.locator("[data-related-query-run]").click();
    await page.locator("[data-related-query-body] tr").filter({ hasText: "허리찜질기" }).waitFor();
    assert.equal(await page.locator("[data-related-query-body] tr").count(), 3);
    const resultText = await page.locator("[data-related-query-body]").innerText();
    assert.match(resultText, /저장 표본 내 단일 카테고리/u);
    assert.match(resultText, /저장 표본 내 복수 카테고리 · 2개/u);
    assert.match(resultText, /일부 분류 확인 필요/u);
    assert.match(resultText, /저장된 순위 표본 5개 중 2개 분류 · 수집 2026\.10\.19 10:21:24 KST/u);
    assert.match(resultText, /저장 표본 기준 · 전체 분류 아님 · 추가 상품 조회 없음/u);
    assert.match(resultText, /저장된 순위 표본이 없어 확인 필요/u);
    assert.match(resultText, /< 10/u);
    assert.doesNotMatch(resultText, /전체 검색 카테고리를 보장하지 않습니다|카테고리 보완을 위한 추가 상품 조회 없이/u);
    await page.locator("[data-related-query-middle]").selectOption("침구류");
    assert.equal(await page.locator("[data-related-query-body] tr").count(), 1);
    assert.match(await page.locator("[data-related-query-body]").innerText(), /찜질패드/u);
    await page.locator("[data-related-query-middle]").selectOption("");
    await page.locator("[data-related-query-category-status]").selectOption("needs_confirmation");
    assert.match(await page.locator("[data-related-query-body]").innerText(), /전기찜질팩/u);
    const downloaded = page.waitForEvent("download");
    await page.locator("[data-related-query-export]").click();
    const stream = await (await downloaded).createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const csv = Buffer.concat(chunks).toString("utf8");
    assert.match(csv, /전기찜질팩/u);
    assert.match(csv, /확인 필요/u);
    assert.doesNotMatch(csv, /허리찜질기/u);
    checks += 1;
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${surface}: no whole-page mobile overflow`);
    checks += 1;
    await input.fill("오류검수");
    await page.locator("[data-related-query-run]").click();
    await page.locator("[data-related-query-status].is-error").waitFor();
    assert.equal(await page.locator("[data-related-query-export]").isDisabled(), true);
    assert.equal(categoryRequests, 2, "one explicit query sends one new category search, no retry");
    assert.deepEqual(errors, []);
    checks += 1;
    await page.close();
  }
  console.log(JSON.stringify({ ok: true, checks, surfaces: ["admin", "client"], mockOnly: true, productionRequests: 0, rankRequests: 0 }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
