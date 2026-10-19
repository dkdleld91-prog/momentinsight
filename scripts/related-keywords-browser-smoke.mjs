// Local fixture-only browser QA. Never loads credentials, the production API,
// a Shopping collector, rank state, or a database. Fixtures are not live proof.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import JSZip from "jszip";
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
  const nav = page === "admin" ? 'data-mi-admin-screen="keyword"' : 'data-mi-screen="keyword-tool"';
  const keywordInput = page === "admin" ? "data-admin-keyword-input" : "data-mi-keyword-input";
  const handoff = html.match(/<aside\b[^>]*data-related-query-handoff[^>]*>[\s\S]*?<\/aside>/u)?.[0];
  assert.ok(handoff, `${page}: actual analysis handoff notice exists`);
  const existingId = page === "admin" ? "mi-admin-keyword" : "mi-keyword-tool";
  const existing = `<section class="mi-view" id="${existingId}" data-fixture-existing hidden>${handoff}<form data-fixture-existing-form><input ${keywordInput} value="기존 조회 키워드"><button type="submit">기존 키워드 조회</button></form><p data-fixture-old-result>기존 결과 · 이전 조회 데이터</p></section>`;
  const stub = `<script>window.__fixtureNavigation=0;window.__fixtureInputEvents=0;window.__fixtureSubmits=0;document.querySelector('[data-fixture-nav]').addEventListener('click',function(e){e.preventDefault();window.__fixtureNavigation++;var related=document.querySelector('[data-related-query]');related.hidden=true;related.classList.remove('is-active');var existing=document.querySelector('[data-fixture-existing]');existing.hidden=false;existing.classList.add('is-active');});var oldForm=document.querySelector('[data-fixture-existing-form]');oldForm.addEventListener('submit',function(e){e.preventDefault();window.__fixtureSubmits++;});oldForm.querySelector('input').addEventListener('input',function(){window.__fixtureInputEvents++;});oldForm.querySelector('input').addEventListener('change',function(){window.__fixtureInputEvents++;});</script>`;
  pages.set(`/${page}`, `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOCAL FIXTURE QA ONLY</title><link rel="stylesheet" href="/mi-tokens.css"><link rel="stylesheet" href="/mi-related-keywords.css">${styles}<body><p style="padding:12px">로컬 기능 검수 전용 · 아래 결과는 테스트 응답이며 실제 조회가 아닙니다.</p><section id="${id}" class="${cls} is-authed"><a href="#fixture-existing" ${nav} data-fixture-nav>기존 키워드 조회 · 검수용 연결</a>${view}${existing}</section>${stub}<script src="/mi-related-keywords-xlsx.js" defer></script><script src="/mi-related-keywords.js" defer></script></body></html>`);
}
for (const asset of ["mi-tokens.css", "mi-related-keywords.css", "mi-related-keywords-xlsx.js", "mi-related-keywords.js"]) assets.set(`/${asset}`, await fs.readFile(`${root}/public/${asset}`));
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
  { keyword: "허리찜질기", volume: 300, pcVolume: 100, mobileVolume: 200, clicks: 4, ctr: 1.2, competition: "보통", category: category("single", [one]) },
  { keyword: "찜질패드", volume: 200, pcVolume: 50, mobileVolume: 150, clicks: 0, ctr: 0, competition: "중간", category: category("multiple", [one, other]) },
  { keyword: "전기찜질팩", volume: null, volumeLabel: "< 20", pcVolume: null, pcVolumeLabel: "< 10", mobileVolume: null, mobileVolumeLabel: "< 10", competition: "낮음", category: category("needs_confirmation", []) },
];
const fiftyOneRows = Array.from({ length: 51 }, (_, index) => ({ keyword: "연관어" + String(index).padStart(2, "0"), volume: 1000 + index, pcVolume: index, mobileVolume: 1000, clicks: index, ctr: index / 100, competition: index % 2 ? "높음" : "중간", category: category("single", [one]) }));
let browser;
let checks = 0;
let checkedWorkbooks = 0;
try {
  browser = await chromium.launch({ headless: true });
  for (const surface of ["admin", "client"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, hasTouch: true });
    await page.addInitScript(() => {
      window.__fixtureClipboard = { writes: [], denied: false };
      window.__fixtureExportTypes = [];
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__fixtureExportTypes.push(blob.type); return createObjectURL(blob); };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => {
        window.__fixtureClipboard.writes.push(value);
        if (window.__fixtureClipboard.denied) throw new Error("fixture clipboard permission denied");
      } } });
    });
    const errors = [];
    let workbookDownloads = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    let categoryRequests = 0, apiRequests = 0;
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
      apiRequests += 1;
      if (url.pathname === "/api/session") {
        await route.fulfill({ headers, json: { ok: true, session: { role: surface === "admin" ? "owner" : "client", scopeKey: "fixture-session", clientId: "fixture-client" } } });
        return;
      }
      assert.equal(url.pathname, "/api/client/keyword-research", "no existing rank/keyword API call");
      assert.equal(url.searchParams.get("mode"), "related");
      categoryRequests += 1;
      const keyword = url.searchParams.get("keyword");
      if (keyword === "오류검수") await route.fulfill({ headers, status: 503, json: { ok: false, related: [] } });
      else await route.fulfill({ headers, json: { ok: true, keyword, related: keyword === "50개검수" ? fiftyOneRows : rows, checkedAt: storedCheckedAt } });
    });
    await page.goto(`${origin}/${surface}`, { waitUntil: "load" });
    const input = page.locator("[data-related-query-input]");
    await input.fill("온열찜질기");
    await page.locator("[data-related-query-run]").click();
    await page.locator("[data-related-query-body] tr").filter({ hasText: "허리찜질기" }).waitFor();
    assert.equal(await page.locator("[data-related-query-body] tr").count(), 3);
    assert.deepEqual((await page.locator(".mi-rq-table thead th").allInnerTexts()).map((value) => value.replace(/[↕↑↓]/gu, "").trim()), ["키워드", "통합 월 검색량", "PC", "모바일", "광고 경쟁도", "광고 평균 클릭", "광고 클릭률", "활용"]);
    assert.equal(await page.locator("[data-related-query-sort-key]").count(), 6);
    assert.equal(await page.locator(".mi-rq-result-head [data-related-query-export]").count(), 1);
    assert.equal(await page.locator("[data-related-query-export]").innerText(), "엑셀 다운로드");
    assert.equal(await page.locator(".mi-rq-controls [data-related-query-export]").count(), 0);
    assert.equal(await page.locator(".mi-rq-head h1").evaluate((node) => getComputedStyle(node).color), "rgb(255, 255, 255)", `${surface}: scoped navy hero is not overridden by the existing inline app`);
    for (const keyword of ["허리찜질기", "전기찜질팩"]) {
      const height = await page.locator("[data-related-query-body] tr").filter({ hasText: keyword }).evaluate((node) => node.getBoundingClientRect().height);
      assert.ok(height >= 48 && height <= 82, `${surface}: ${keyword} compact row height ${height}`);
    }
    const resultText = await page.locator("[data-related-query-body]").innerText();
    assert.equal(await page.locator("[data-related-query-body] small").count(), 0, "repeated source/sample/date descriptions are absent from the DOM");
    assert.doesNotMatch(resultText, /냉온\/찜질용품|저장 표본|카테고리 모두 보기/u);
    assert.equal(await page.locator("[data-related-query-copy]").count(), 3);
    assert.equal(await page.locator("[data-related-query-analyze]").count(), 3);
    assert.match(resultText, /< 10/u);
    const help = page.locator("details.mi-rq-help");
    assert.equal(await help.count(), 1);
    await help.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await help.evaluate((node) => node.open), true);
    assert.match(await help.innerText(), /정확히 같은 키워드로 저장된 최근 순위 수집 상품 5개 표본 기준/u);
    assert.match(await help.innerText(), /추가 상품 조회는 하지 않으며/u);
    const contrastChecks = await page.locator(".mi-rq-table th,.mi-rq-help summary,.mi-rq-help p,.mi-rq-eyebrow").evaluateAll((nodes) => nodes.map((node) => {
      function luminance(value) {
        const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => { const s = channel / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
        return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
      }
      let current = node;
      let background = "rgb(255,255,255)";
      while (current) { const color = getComputedStyle(current).backgroundColor; if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") { background = color; break; } current = current.parentElement; }
      const foreground = luminance(getComputedStyle(node).color), behind = luminance(background);
      return { text: node.textContent, ratio: (Math.max(foreground, behind) + .05) / (Math.min(foreground, behind) + .05) };
    }));
    assert.ok(contrastChecks.every((check) => check.ratio >= 4.5), `${surface}: small header/help text has AA contrast ${JSON.stringify(contrastChecks)}`);
    await page.keyboard.press("Enter");
    async function exportedWorkbook(expectedKeyword = "온열찜질기") {
      const downloaded = page.waitForEvent("download");
      await page.locator("[data-related-query-export]").click();
      const download = await downloaded;
      assert.match(download.suggestedFilename(), /\.xlsx$/u);
      assert.doesNotMatch(download.suggestedFilename(), /\.csv/iu);
      assert.equal((await page.evaluate(() => window.__fixtureExportTypes)).at(-1), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 3, 4], "download is a real ZIP workbook, not CSV renamed to XLSX");
      const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
      for (const file of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) assert.ok(zip.file(file), `required OOXML part ${file}`);
      assert.equal(zip.file("xl/worksheets/sheet2.xml"), null, "the downloaded workbook contains no category or hidden second worksheet");
      for (const file of ["[Content_Types].xml", "xl/_rels/workbook.xml.rels"]) assert.doesNotMatch(await zip.file(file).async("string"), /sheet2\.xml/u);
      const payload = { workbook: await zip.file("xl/workbook.xml").async("string"), styles: await zip.file("xl/styles.xml").async("string"), main: await zip.file("xl/worksheets/sheet1.xml").async("string") };
      const parsed = await page.evaluate((xml) => {
        const parser = new DOMParser();
        const parse = (value) => { const result = parser.parseFromString(value, "application/xml"); if (result.querySelector("parsererror")) throw new Error("invalid generated XLSX XML"); return result; };
        const book = parse(xml.workbook), styles = parse(xml.styles);
        const formats = Object.fromEntries([...styles.getElementsByTagName("numFmt")].map((node) => [node.getAttribute("numFmtId"), node.getAttribute("formatCode")]));
        const numberFormats = [...styles.getElementsByTagName("cellXfs")[0].children].map((node) => formats[node.getAttribute("numFmtId")] || node.getAttribute("numFmtId"));
        function sheet(value) {
          const document = parse(value);
          const cells = Object.fromEntries([...document.getElementsByTagName("c")].map((node) => {
            const type = node.getAttribute("t");
            const numeric = node.getElementsByTagName("v")[0]?.textContent;
            const value = type === "inlineStr" ? [...node.getElementsByTagName("t")].map((part) => part.textContent).join("") : numeric !== undefined ? Number(numeric) : "";
            return [node.getAttribute("r"), { value, type, format: numberFormats[Number(node.getAttribute("s") || 0)] }];
          }));
          const pane = document.getElementsByTagName("pane")[0];
          return { cells, rows: [...document.getElementsByTagName("row")].map((node) => Number(node.getAttribute("r"))), freeze: pane ? { x: pane.getAttribute("xSplit"), y: pane.getAttribute("ySplit"), topLeft: pane.getAttribute("topLeftCell") } : null, filter: document.getElementsByTagName("autoFilter")[0]?.getAttribute("ref"), dimension: document.getElementsByTagName("dimension")[0]?.getAttribute("ref"), merges: [...document.getElementsByTagName("mergeCell")].map((node) => node.getAttribute("ref")), text: [...document.getElementsByTagName("t")].map((node) => node.textContent).join(" ") };
        }
        return { names: [...book.getElementsByTagName("sheet")].map((node) => node.getAttribute("name")), main: sheet(xml.main) };
      }, payload);
      assert.deepEqual(parsed.names, ["연관 키워드"]);
      assert.deepEqual(parsed.main.freeze, { x: "2", y: "6", topLeft: "C7" });
      assert.equal(parsed.main.cells.B6.value, "키워드");
      parsed.mainRows = parsed.main.rows.filter((number) => number >= 7).map((number) => "ABCDEFGH".split("").map((column) => parsed.main.cells[column + number]?.value ?? ""));
      assert.equal(parsed.main.filter, `A6:H${6 + parsed.mainRows.length}`);
      assert.equal(parsed.main.dimension, `A2:H${6 + parsed.mainRows.length}`);
      assert.ok(parsed.mainRows.length > 0 && parsed.mainRows.length <= 50);
      assert.deepEqual(parsed.mainRows.map((row) => row[0]), parsed.mainRows.map((_, index) => index + 1));
      assert.ok(parsed.main.text.includes("기준어: " + expectedKeyword), "metadata contains the confirmed server query, not an arbitrary input");
      checkedWorkbooks += 1;
      workbookDownloads += 1;
      if (process.env.MI_RELATED_SMOKE_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.MI_RELATED_SMOKE_SCREENSHOT_DIR, { recursive: true });
        await fs.writeFile(`${process.env.MI_RELATED_SMOKE_SCREENSHOT_DIR}/${surface}-export-${workbookDownloads}.xlsx`, bytes);
      }
      return parsed;
    }
    const sortingApiBaseline = apiRequests;
    const visibleKeywords = () => page.locator("[data-related-query-body] tr td:first-child").allInnerTexts();
    async function sortState(field, direction, expected) {
      const button = page.locator(`[data-related-query-sort-key="${field}"]`);
      assert.equal(await button.locator("..").getAttribute("aria-sort"), direction === "asc" ? "ascending" : "descending");
      assert.equal(await button.locator("[data-related-query-sort-arrow]").innerText(), direction === "asc" ? "↑" : "↓");
      const label = await button.getAttribute("aria-label");
      assert.match(label, /오름차순/u);
      assert.match(label, /내림차순/u);
      assert.deepEqual(await visibleKeywords(), expected);
      assert.equal(new Set(await visibleKeywords()).size, 3, "sorting retains all three unique response rows");
      assert.equal(await page.locator('.mi-rq-table th[aria-sort="none"]').count(), 5);
      assert.equal(apiRequests, sortingApiBaseline, "sorting is local and never invokes another API");
    }
    const descending = ["허리찜질기", "찜질패드", "전기찜질팩"];
    const ascending = ["찜질패드", "허리찜질기", "전기찜질팩"];
    await sortState("volume", "desc", descending);
    await page.locator('[data-related-query-sort-key="volume"]').click();
    await sortState("volume", "asc", ascending);
    await page.locator('[data-related-query-sort-key="volume"]').click();
    await sortState("volume", "desc", descending);
    await page.locator('[data-related-query-sort-key="name"]').focus();
    await page.keyboard.press("Enter");
    await sortState("name", "asc", ["전기찜질팩", "찜질패드", "허리찜질기"]);
    await page.keyboard.press("Space");
    await sortState("name", "desc", ["허리찜질기", "찜질패드", "전기찜질팩"]);
    for (const field of ["pc", "mobile", "clicks", "ctr"]) {
      await page.locator(`[data-related-query-sort-key="${field}"]`).click();
      await sortState(field, "desc", descending);
      await page.locator(`[data-related-query-sort-key="${field}"]`).click();
      await sortState(field, "asc", ascending);
    }
    const sortedWorkbook = await exportedWorkbook();
    assert.deepEqual(sortedWorkbook.mainRows.map((row) => row[1]), ascending, "workbook row order exactly matches the current ascending result table");
    await page.locator("[data-related-query-sort]").selectOption("clicks");
    await sortState("clicks", "desc", descending);
    await page.locator("[data-related-query-sort]").selectOption("name");
    await sortState("name", "asc", ["전기찜질팩", "찜질패드", "허리찜질기"]);
    await page.locator("[data-related-query-sort]").selectOption("volume");
    await sortState("volume", "desc", descending);
    const completeWorkbook = await exportedWorkbook();
    assert.deepEqual(completeWorkbook.mainRows[0].slice(0, 7), [1, "허리찜질기", 300, 100, 200, "보통", 4]);
    assert.ok(Math.abs(completeWorkbook.mainRows[0][7] - .012) < 1e-12);
    assert.equal(completeWorkbook.main.cells.H7.format, "0.00%", "CTR cells are numeric Excel percentages");
    assert.equal(completeWorkbook.main.cells.C7.format, "#,##0");
    assert.equal(completeWorkbook.main.cells.G7.format, "#,##0.0");
    assert.deepEqual(completeWorkbook.mainRows[1].slice(6), [0, 0], "actual zero clicks and zero CTR remain numeric zero");
    assert.deepEqual(completeWorkbook.mainRows[2].slice(2, 5), ["< 20", "< 10", "< 10"]);
    assert.deepEqual(completeWorkbook.mainRows[2].slice(6), ["확인 필요", "확인 필요"]);
    assert.doesNotMatch(completeWorkbook.main.text, /카테고리 근거|저장 상위 5개 상품 표본/u, "the single-sheet download contains only the current result metrics");
    assert.equal(await page.locator('[data-related-query-competition] option[value="중간"]').innerText(), "중간");
    await page.locator("[data-related-query-competition]").selectOption("중간");
    assert.equal(await page.locator("[data-related-query-body] tr").count(), 1);
    assert.match(await page.locator("[data-related-query-body]").innerText(), /찜질패드/u);
    await page.locator("[data-related-query-competition]").selectOption("낮음");
    assert.match(await page.locator("[data-related-query-body]").innerText(), /전기찜질팩/u);
    const filteredWorkbook = await exportedWorkbook();
    assert.deepEqual(filteredWorkbook.mainRows.map((row) => row[1]), ["전기찜질팩"]);
    await page.evaluate(() => {
      window.__fixtureOriginalWriter = window.MomentRelatedKeywordXlsx;
      window.MomentRelatedKeywordXlsx = { create: () => { throw new Error("fixture workbook generation failure"); } };
    });
    const fallbackDownload = page.waitForEvent("download", { timeout: 250 }).then(() => true, () => false);
    await page.locator("[data-related-query-export]").click();
    await page.locator("[data-related-query-status].is-error").waitFor();
    assert.match(await page.locator("[data-related-query-status]").innerText(), /엑셀 파일을 만들지 못했습니다/u);
    assert.equal(await fallbackDownload, false, "writer failure never downloads a renamed CSV fallback");
    await page.evaluate(() => { window.MomentRelatedKeywordXlsx = window.__fixtureOriginalWriter; delete window.__fixtureOriginalWriter; });
    checks += 1;
    await page.locator("[data-related-query-competition]").selectOption("");
    const idleApiRequests = apiRequests;
    const firstCopy = page.locator("[data-related-query-copy]").first();
    await firstCopy.click();
    assert.deepEqual(await page.evaluate(() => window.__fixtureClipboard.writes), ["허리찜질기"]);
    assert.equal(await page.locator("[data-related-query-status]").evaluate((node) => node.classList.contains("is-error")), false);
    assert.match(await page.locator("[data-related-query-status]").innerText(), /복사/u);
    await page.evaluate(() => { window.__fixtureClipboard.denied = true; });
    await firstCopy.click();
    await page.locator("[data-related-query-status].is-error").waitFor();
    assert.equal(apiRequests, idleApiRequests, "copy and clipboard denial never query an API");
    await page.evaluate(() => { window.__fixtureClipboard.denied = false; });
    await firstCopy.click();
    await page.locator("[data-related-query-status]:not(.is-error)").waitFor();
    if (process.env.MI_RELATED_SMOKE_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.MI_RELATED_SMOKE_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.MI_RELATED_SMOKE_SCREENSHOT_DIR}/${surface}-desktop.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${surface}: no whole-page mobile overflow`);
    assert.equal(await page.locator(".mi-rq-scroll").evaluate((node) => node.scrollWidth > node.clientWidth), true);
    const touchSort = page.locator('[data-related-query-sort-key="volume"]');
    assert.ok(await touchSort.evaluate((node) => node.getBoundingClientRect().height >= 44), "mobile sort buttons retain a 44px touch target");
    await touchSort.tap();
    await sortState("volume", "asc", ascending);
    await touchSort.tap();
    await sortState("volume", "desc", descending);
    await page.locator("[data-related-query-copy]").last().tap();
    assert.equal((await page.evaluate(() => window.__fixtureClipboard.writes)).at(-1), "전기찜질팩");
    await page.locator(".mi-rq-scroll").evaluate((node) => { node.scrollLeft = 0; });
    if (process.env.MI_RELATED_SMOKE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.MI_RELATED_SMOKE_SCREENSHOT_DIR}/${surface}-mobile.png`, fullPage: true });
    checks += 1;
    const analysis = page.locator("[data-related-query-analyze]").filter({ hasText: "상세 분석" }).first();
    await analysis.tap();
    const existingInput = page.locator(surface === "admin" ? "[data-admin-keyword-input]" : "[data-mi-keyword-input]");
    assert.equal(await existingInput.inputValue(), "허리찜질기");
    assert.equal(await page.locator("[data-fixture-existing]").isVisible(), true);
    assert.equal(await page.locator("[data-fixture-old-result]").innerText(), "기존 결과 · 이전 조회 데이터");
    assert.equal(await page.evaluate(() => window.__fixtureNavigation), 1);
    assert.equal(await page.evaluate(() => window.__fixtureSubmits + window.__fixtureInputEvents), 0);
    assert.match(await page.locator("[data-related-query-handoff]").innerText(), /허리찜질기/u);
    assert.match(await page.locator("[data-related-query-handoff]").innerText(), /아직 이 키워드를 조회하지 않았습니다/u);
    assert.equal(apiRequests, idleApiRequests, "analysis handoff only navigates and prefills; it does not auto-query");
    await page.locator("[data-related-query-handoff] summary").focus();
    await page.keyboard.press("Enter");
    assert.match(await page.locator("[data-related-query-handoff]").innerText(), /냉온\/찜질용품 > 찜질기/u);
    await page.evaluate(() => { const old = document.querySelector("[data-fixture-existing]"); old.hidden = true; old.classList.remove("is-active"); const related = document.querySelector("[data-related-query]"); related.hidden = false; related.classList.add("is-active"); });
    await input.fill("오류검수");
    await page.locator("[data-related-query-run]").click();
    await page.locator("[data-related-query-status].is-error").waitFor();
    assert.equal(await page.locator("[data-related-query-export]").isDisabled(), true);
    assert.equal(categoryRequests, 2, "one explicit query sends one new category search, no retry");
    assert.deepEqual(errors, []);
    checks += 1;
    await page.setViewportSize({ width: 1440, height: 1050 });
    await input.fill("50개검수");
    await page.locator("[data-related-query-run]").click();
    await page.locator("[data-related-query-body] tr").filter({ hasText: "연관어49" }).waitFor();
    assert.equal(await page.locator("[data-related-query-body] tr").count(), 50, "a supplied 51-row response is capped at fifty real records");
    assert.match(await page.locator("[data-related-query-count]").innerText(), /전체 50개 · 표시 50개 · 최대 50개/u);
    const fiftyActual = fiftyOneRows.slice(0, 50);
    assert.deepEqual(await visibleKeywords(), fiftyActual.slice().reverse().map((row) => row.keyword));
    assert.equal(new Set(await visibleKeywords()).size, 50, "all fifty displayed records are unique and supplied by the response");
    const fiftyApiBaseline = apiRequests;
    await page.locator('[data-related-query-sort-key="volume"]').click();
    assert.deepEqual(await visibleKeywords(), fiftyActual.map((row) => row.keyword));
    const fiftyWorkbook = await exportedWorkbook("50개검수");
    assert.equal(fiftyWorkbook.mainRows.length, 50);
    assert.equal(fiftyWorkbook.main.dimension, "A2:H56");
    assert.deepEqual(fiftyWorkbook.mainRows.map((row) => row[1]), await visibleKeywords(), "all fifty exported rows match the current on-screen ascending order");
    for (const [index, actual] of fiftyWorkbook.mainRows.entries()) {
      assert.deepEqual(actual.slice(0, 7), [index + 1, fiftyActual[index].keyword, 1000 + index, index, 1000, fiftyActual[index].competition, index]);
      assert.ok(Math.abs(actual[7] - index / 10000) < 1e-12, "all fifty raw CTR values remain numeric percentage fractions");
      assert.equal(actual[2], actual[3] + actual[4], "PC plus mobile retains the exact supplied combined count");
    }
    await page.locator("[data-related-query-competition]").selectOption("중간");
    await page.locator('[data-related-query-sort-key="volume"]').click();
    const filteredFifty = fiftyActual.filter((row) => row.competition === "중간").reverse();
    assert.match(await page.locator("[data-related-query-count]").innerText(), /전체 50개 · 표시 25개 · 최대 50개/u);
    assert.deepEqual(await visibleKeywords(), filteredFifty.map((row) => row.keyword));
    const filteredFiftyWorkbook = await exportedWorkbook("50개검수");
    assert.equal(filteredFiftyWorkbook.mainRows.length, 25, "an active filter exports its actual visible count, not padded fifty records");
    assert.deepEqual(filteredFiftyWorkbook.mainRows.map((row) => row[1]), await visibleKeywords());
    assert.deepEqual(filteredFiftyWorkbook.mainRows.map((row) => row[2]), filteredFifty.map((row) => row.volume));
    assert.equal(apiRequests, fiftyApiBaseline, "fifty-row sorting, filtering and exports are fully local");
    assert.equal(categoryRequests, 3, "one explicit fifty-row query has no automatic retry");
    assert.deepEqual(errors, []);
    checks += 1;
    await page.close();
  }
  console.log(JSON.stringify({ ok: true, checks, checkedWorkbooks, workbookSheets: 1, fiftyRowSurfaces: 2, surfaces: ["admin", "client"], mockOnly: true, productionRequests: 0, rankRequests: 0 }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
