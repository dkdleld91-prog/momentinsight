// Local fixture-only QA of the real public page. No production, provider,
// database, account/session endpoint, or rank collector is contacted.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import JSZip from "jszip";
import { chromium } from "../tools/naver-shopping-rank-collector/node_modules/playwright/index.mjs";

const evidence = process.env.MI_PUBLIC_RELATED_SMOKE_DIR || "/Users/sindongbin/Documents/모먼트 인사이트/.codex-deployments/public-related-20261020/fixtures";
const assetNames = ["related-keywords.html", "mi-tokens.css", "mi-related-keywords.css", "mi-related-keywords-xlsx.js", "mi-related-keywords.js", "mi-public-related-keywords.js", "favicon.svg"];
const assets = new Map(await Promise.all(assetNames.map(async (name) => ["/" + name, await fs.readFile("public/" + name)])));
const vercel = JSON.parse(await fs.readFile("vercel.json", "utf8"));
const csp = vercel.headers.find((item) => item.source === "/(.*)").headers.find((header) => header.key === "Content-Security-Policy").value;
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", csp);
  response.setHeader("x-content-type-options", "nosniff");
  if (!assets.has(pathname)) { response.statusCode = 404; response.end(); return; }
  response.setHeader("content-type", pathname.endsWith(".html") ? "text/html; charset=utf-8" : pathname.endsWith(".js") ? "application/javascript; charset=utf-8" : pathname.endsWith(".svg") ? "image/svg+xml" : "text/css; charset=utf-8");
  response.end(assets.get(pathname));
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const endpoint = "/api/public/related-keywords";
const checkedAt = "2026-10-20T03:00:00.000Z";
const fifty = Array.from({ length: 50 }, (_, index) => ({ keyword: "연관어" + String(index).padStart(2, "0"), volume: 1000 + index, pcVolume: index, mobileVolume: 1000, competition: index % 2 ? "높음" : "중간", clicks: index, ctr: index / 100 }));
const few = [
  { keyword: "실제영", volume: 0, pcVolume: 0, mobileVolume: 0, competition: "낮음", clicks: 0, ctr: 0 },
  { keyword: "실제합계", volume: 350, pcVolume: 100, mobileVolume: 250, competition: "중간", clicks: 1.5, ctr: 1.23 },
  { keyword: "비공개값", volume: null, volumeLabel: "< 20", pcVolume: null, pcVolumeLabel: "< 10", mobileVolume: null, mobileVolumeLabel: "< 10", competition: "높음" },
  { keyword: "누락값" },
  { keyword: "소수지표", volume: 10, pcVolume: 5, mobileVolume: 5, competition: "중간", clicks: .1, ctr: .01 }
];
let browser, checks = 0, downloads = 0, apiRequests = 0, privateRequests = 0, externalRequests = 0;
try {
  await fs.mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ name: "desktop", width: 1440, height: 1050 }, { name: "mobile", width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true });
    // A private-looking fixture cookie is deliberately present in the browser.
    // The public fetch must still omit it from every API request.
    await context.addCookies([{ name: "fixture_private_cookie", value: "local-test-only", url: origin }]);
    const page = await context.newPage();
    const errors = [], queries = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__fixtureCsp = [];
      document.addEventListener("securitypolicyviolation", (event) => window.__fixtureCsp.push(event.effectiveDirective));
      window.__fixtureWrites = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { window.__fixtureWrites.push(value); } } });
      window.__fixtureFetch = [];
      const fetcher = window.fetch.bind(window);
      window.fetch = (url, options) => { window.__fixtureFetch.push({ url, credentials: options.credentials, method: options.method, redirect: options.redirect }); return fetcher(url, options); };
      window.__fixtureMime = [];
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__fixtureMime.push(blob.type); return create(blob); };
    });
    await page.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { externalRequests += 1; await route.abort("blockedbyclient"); return; }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      if (url.pathname !== endpoint) { privateRequests += 1; await route.abort("blockedbyclient"); return; }
      const headers = await request.allHeaders();
      assert.equal(headers.cookie, undefined, "public requests never forward even an existing browser cookie");
      for (const name of ["authorization", "x-mi-session", "x-mi-agency", "x-mi-rank", "x-csrf-token"]) assert.equal(headers[name], undefined);
      assert.equal(request.method(), "GET");
      const keyword = url.searchParams.get("keyword");
      queries.push(keyword);
      apiRequests += 1;
      if (keyword === "제한검수") await route.fulfill({ status: 429, json: { ok: false, code: "rate_limited", message: "INTERNAL_FIXTURE_DO_NOT_DISPLAY" } });
      else {
        assert.ok(["전체검수", "소수검수", "빈값검수"].includes(keyword));
        await route.fulfill({ json: { ok: true, keyword, checkedAt, related: keyword === "전체검수" ? fifty : keyword === "소수검수" ? few : [] } });
      }
    });
    await page.goto(origin + "/related-keywords.html", { waitUntil: "load" });
    assert.equal(queries.length, 0, "opening the real public page is API-idle");
    assert.match(await page.evaluate(() => document.cookie), /fixture_private_cookie=/u);
    assert.equal(await page.locator("#mi-public-related").getAttribute("data-public-related-mounted"), "true");
    assert.equal(await page.locator("#mi-admin,#mi-clean").count(), 0);
    assert.equal(await page.locator("[data-related-query-export]").isDisabled(), true);
    assert.equal(await page.locator(".mi-rq-head h1").evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)");
    await page.evaluate(() => { const label = document.createElement("p"); label.textContent = "로컬 검수 전용 · 아래는 예시 응답이며 실제 조회가 아닙니다."; label.style.cssText = "margin:0;padding:10px 20px;background:#e8eef8;color:#18385f;font:12px Arial,sans-serif"; document.body.prepend(label); });
    const input = page.locator("[data-related-query-input]");
    const run = page.locator("[data-related-query-run]");
    const status = page.locator("[data-related-query-status]");
    const visibleKeywords = () => page.locator("[data-related-query-body] tr td:first-child").allInnerTexts();
    async function query(keyword, ready) {
      const before = queries.length;
      await input.fill(keyword);
      await run.click();
      await ready();
      assert.equal(queries.length, before + 1, "one explicit click issues exactly one public query");
      assert.equal(queries.at(-1), keyword);
    }
    async function workbook(name, keyword, expectedRows) {
      const before = queries.length;
      const awaited = page.waitForEvent("download");
      await page.locator("[data-related-query-export]").click();
      const download = await awaited;
      assert.match(download.suggestedFilename(), /\.xlsx$/u);
      assert.equal((await page.evaluate(() => window.__fixtureMime)).at(-1), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 3, 4]);
      const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
      assert.deepEqual(Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"].sort());
      const xml = { workbook: await zip.file("xl/workbook.xml").async("string"), sheet: await zip.file("xl/worksheets/sheet1.xml").async("string"), styles: await zip.file("xl/styles.xml").async("string") };
      const parsed = await page.evaluate((xml) => {
        const parser = new DOMParser();
        function parse(value) { const doc = parser.parseFromString(value, "application/xml"); if (doc.querySelector("parsererror")) throw new Error("invalid workbook XML"); return doc; }
        const book = parse(xml.workbook), sheet = parse(xml.sheet), styles = parse(xml.styles);
        const formats = Object.fromEntries([...styles.getElementsByTagName("numFmt")].map((node) => [node.getAttribute("numFmtId"), node.getAttribute("formatCode")]));
        const styleFormats = [...styles.getElementsByTagName("cellXfs")[0].children].map((node) => formats[node.getAttribute("numFmtId")] || node.getAttribute("numFmtId"));
        const cells = Object.fromEntries([...sheet.getElementsByTagName("c")].map((node) => [node.getAttribute("r"), { value: node.getAttribute("t") === "inlineStr" ? [...node.getElementsByTagName("t")].map((node) => node.textContent).join("") : node.getElementsByTagName("v")[0] ? Number(node.getElementsByTagName("v")[0].textContent) : "", format: styleFormats[Number(node.getAttribute("s") || 0)] }]));
        const pane = sheet.getElementsByTagName("pane")[0];
        const numbers = [...sheet.getElementsByTagName("row")].map((node) => Number(node.getAttribute("r"))).filter((number) => number >= 7);
        return { names: [...book.getElementsByTagName("sheet")].map((node) => node.getAttribute("name")), cells, rows: numbers.map((number) => "ABCDEFGH".split("").map((letter) => cells[letter + number]?.value ?? "")), filter: sheet.getElementsByTagName("autoFilter")[0]?.getAttribute("ref"), dimension: sheet.getElementsByTagName("dimension")[0]?.getAttribute("ref"), freeze: { x: pane.getAttribute("xSplit"), y: pane.getAttribute("ySplit"), topLeft: pane.getAttribute("topLeftCell") }, text: [...sheet.getElementsByTagName("t")].map((node) => node.textContent).join(" "), formulas: sheet.getElementsByTagName("f").length };
      }, xml);
      assert.deepEqual(parsed.names, ["연관 키워드"]);
      assert.equal(parsed.rows.length, expectedRows.length);
      assert.deepEqual(parsed.rows.map((row) => row[1]), await visibleKeywords(), "download membership and ordering equal the current UI");
      assert.equal(parsed.dimension, `A2:H${6 + expectedRows.length}`);
      assert.equal(parsed.filter, `A6:H${6 + expectedRows.length}`);
      assert.deepEqual(parsed.freeze, { x: "2", y: "6", topLeft: "C7" });
      assert.equal(parsed.formulas, 0);
      assert.ok(parsed.text.includes("기준어: " + keyword));
      assert.doesNotMatch(parsed.text, /카테고리 근거|저장 상위 5개/u);
      const metric = (row, key) => row[key] === null || row[key] === undefined ? row[key + "Label"] || "확인 필요" : row[key];
      for (const [index, row] of parsed.rows.entries()) {
        const expected = expectedRows[index];
        assert.deepEqual(row.slice(0, 7), [index + 1, expected.keyword, metric(expected, "volume"), metric(expected, "pcVolume"), metric(expected, "mobileVolume"), expected.competition || "확인 필요", metric(expected, "clicks")]);
        if (expected.ctr === null || expected.ctr === undefined) assert.equal(row[7], "확인 필요");
        else { assert.ok(Math.abs(row[7] - expected.ctr / 100) < 1e-12); assert.equal(parsed.cells[`H${index + 7}`].format, "0.00%"); }
      }
      assert.equal(queries.length, before, "a workbook download sends no new API request");
      await fs.writeFile(`${evidence}/${viewport.name}-${name}.xlsx`, bytes);
      downloads += 1;
    }
    await query("전체검수", () => page.locator("[data-related-query-body] tr").filter({ hasText: "연관어49" }).waitFor());
    assert.equal(await page.locator("[data-related-query-body] tr").count(), 50);
    assert.match(await page.locator("[data-related-query-count]").innerText(), /전체 50개 · 표시 50개 · 최대 50개/u);
    assert.equal(new Set(await visibleKeywords()).size, 50);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "table overflow never becomes whole-page overflow");
    if (viewport.name === "mobile") assert.equal(await page.locator(".mi-rq-scroll").evaluate((node) => node.scrollWidth > node.clientWidth), true);
    const beforeLocalActions = queries.length;
    const sorter = page.locator('[data-related-query-sort-key="volume"]');
    await sorter.focus();
    await page.keyboard.press("Enter");
    assert.equal(await sorter.locator("..").getAttribute("aria-sort"), "ascending");
    assert.deepEqual(await visibleKeywords(), fifty.map((row) => row.keyword));
    await workbook("fifty-ascending", "전체검수", fifty);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${evidence}/${viewport.name}.png`, fullPage: false });
    if (viewport.name === "desktop") {
      await page.locator("[data-related-query-competition]").selectOption("중간");
      await sorter.click();
      const filtered = fifty.filter((row) => row.competition === "중간").reverse();
      assert.deepEqual(await visibleKeywords(), filtered.map((row) => row.keyword));
      assert.match(await page.locator("[data-related-query-count]").innerText(), /전체 50개 · 표시 25개/u);
      await workbook("filtered-twenty-five", "전체검수", filtered);
      await page.locator("[data-related-query-competition]").selectOption("");
    }
    checks += 2;
    const firstKeyword = (await visibleKeywords())[0];
    await page.locator("[data-related-query-copy]").first().click();
    assert.deepEqual(await page.evaluate(() => window.__fixtureWrites), [firstKeyword]);
    await page.locator("[data-related-query-analyze]").first().click();
    assert.equal(await page.locator("[data-public-related-login]").isVisible(), true);
    assert.match(await page.locator("[data-public-related-selection]").innerText(), new RegExp(firstKeyword, "u"));
    assert.equal(await page.locator("[data-public-related-cta]").getAttribute("href"), "/client");
    assert.equal(page.url(), origin + "/related-keywords.html", "analysis asks for login locally, never navigates or auto-queries");
    assert.equal(queries.length, beforeLocalActions);
    checks += 1;
    await query("소수검수", () => page.locator("[data-related-query-body] tr").filter({ hasText: "비공개값" }).waitFor());
    assert.equal(await page.locator("[data-public-related-login]").isVisible(), false, "a new query clears the old selection notice");
    assert.equal(await page.locator("[data-related-query-body] tr").count(), 5, "short results stay five, never padded to fifty");
    assert.match(await page.locator("[data-related-query-body]").innerText(), /< 10/u);
    assert.match(await page.locator("[data-related-query-count]").innerText(), /전체 5개 · 표시 5개 · 최대 50개/u);
    if (viewport.name === "desktop") {
      await page.locator("[data-related-query-sort]").selectOption("name");
      const expected = few.slice().sort((left, right) => left.keyword.localeCompare(right.keyword, "ko"));
      await workbook("five-with-zero-and-unknown", "소수검수", expected);
    }
    checks += 1;
    await query("빈값검수", () => status.filter({ hasText: "제공된 연관어가 없습니다" }).waitFor());
    assert.match(await page.locator("[data-related-query-count]").innerText(), /전체 0개 · 표시 0개/u);
    assert.equal(await page.locator("[data-related-query-export]").isDisabled(), true);
    assert.equal(await page.locator("[data-related-query-copy]").count(), 0);
    checks += 1;
    await query("제한검수", () => page.locator("[data-related-query-status].is-error").waitFor());
    assert.match(await status.innerText(), /IP별 1분 5회·1시간 30회/u);
    assert.doesNotMatch(await status.innerText(), /INTERNAL_FIXTURE_DO_NOT_DISPLAY/u);
    assert.equal(await page.locator("[data-related-query-export]").isDisabled(), true);
    assert.deepEqual(queries, ["전체검수", "소수검수", "빈값검수", "제한검수"]);
    const fetches = await page.evaluate(() => window.__fixtureFetch);
    assert.equal(fetches.length, 4);
    assert.ok(fetches.every((request) => request.url.startsWith(endpoint + "?") && request.credentials === "omit" && request.method === "GET" && request.redirect === "error"));
    assert.deepEqual(await page.evaluate(() => window.__fixtureCsp), [], "the actual enforced production CSP permits the page without inline exceptions");
    assert.deepEqual(errors, []);
    checks += 1;
    await context.close();
  }
  assert.equal(downloads, 4);
  assert.equal(apiRequests, 8);
  assert.equal(privateRequests, 0);
  assert.equal(externalRequests, 0);
  console.log(JSON.stringify({ ok: true, checks, downloads, workbookSheets: 1, maxRows: 50, apiRequests, privateRequests, externalRequests, sessionRequests: 0, rankRequests: 0, productionRequests: 0, mockOnly: true, evidence }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
