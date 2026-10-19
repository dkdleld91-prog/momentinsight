import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync("public/mi-related-keywords.js", "utf8");
function api(overrides = {}) {
  const window = { setTimeout, clearTimeout, AbortController, ...overrides };
  vm.runInNewContext(source, { window, Blob, URL, Date });
  return window.MomentRelatedKeywords;
}
const categories = {
  single: { status: "single", middle: "냉온/찜질용품", small: "찜질기", paths: [{ middle: "냉온/찜질용품", small: "찜질기" }], sampleSize: 10, categorizedCount: 10 },
  multiple: { status: "multiple", middle: null, small: null, paths: [{ middle: "냉온/찜질용품", small: "찜질기" }, { middle: "건강관리용품", small: "기타건강관리용품" }], reason: "incomplete_sample", sampleSize: 10, categorizedCount: 8 },
  unknown: { status: "needs_confirmation", reason: "source_not_configured", paths: [] }
};
const storedCheckedAt = "2026-10-19T01:21:24.483Z";
const storedCategory = {
  status: "single", reason: "stored_sample_consistent", middle: "냉온/찜질용품", small: "찜질기",
  paths: [{ middle: "냉온/찜질용품", small: "찜질기" }], sampleSize: 5, categorizedCount: 5,
  checkedAt: storedCheckedAt, source: "stored_rank_snapshot_categories", basis: "stored_top5"
};
function rows(seed = "온열찜질기") {
  return api().normalizeRows([
    { keyword: "허리찜질기", volume: 100, pcVolume: 0, mobileVolume: 100, category: categories.single },
    { keyword: "찜질패드", volume: 80, category: categories.multiple },
    { keyword: "전기찜질팩", volume: null, pcVolume: null, pcVolumeLabel: "<10", mobileVolume: null, category: categories.unknown },
    { keyword: seed, volume: 1000, category: categories.single }
  ], seed);
}

test("related rows use only provided categories, deduplicate, exclude seed, and cap at 30 without padding", () => {
  const client = api();
  const list = rows();
  assert.equal(list.length, 3);
  assert.equal(list[0].category.status, "single");
  assert.equal(list[1].category.status, "multiple");
  assert.equal(list[1].category.reason, "incomplete_sample");
  assert.equal(list[1].category.sampleSize, 10);
  assert.equal(list[1].category.categorizedCount, 8);
  assert.equal(list[2].category.status, "needs_confirmation");
  assert.equal(list[2].category.paths.length, 0);
  assert.equal(list[2].volume, null);
  assert.equal(list[2].pcVolumeLabel, "<10");
  assert.equal(client.normalizeRows([], "seed").length, 0);
  assert.equal(client.normalizeRows([{ keyword: "허리찜질기" }, { keyword: "허리 찜질기" }], "seed").length, 1);
  assert.equal(client.normalizeRows(Array.from({ length: 45 }, (_, index) => ({ keyword: "연관어" + index })), "seed").length, 30);
  const invalid = client.normalizeRows([{ keyword: "invalid", category: { ...categories.single, middle: "틀린 분류" } }], "seed")[0];
  assert.equal(invalid.category.status, "needs_confirmation");
});

test("filters match actual middle/small paths including multiple categories and keep unknown separate", () => {
  const client = api();
  const list = rows();
  assert.equal(client.filterRows(list, "냉온/찜질용품", "찜질기", "").length, 2);
  assert.equal(client.filterRows(list, "건강관리용품", "찜질기", "").length, 0);
  assert.equal(client.filterRows(list, "", "", "needs_confirmation")[0].keyword, "전기찜질팩");
  assert.equal(client.filterRows(list, "", "", "multiple")[0].keyword, "찜질패드");
});

test("stored rank snapshot evidence keeps partial multi-path samples distinct from unconfirmed evidence", () => {
  const client = api();
  const secondPath = { middle: "건강관리용품", small: "기타건강관리용품" };
  const list = client.normalizeRows([
    { keyword: "저장단일", category: storedCategory },
    { keyword: "저장복수", category: { ...storedCategory, status: "multiple", reason: "multiple_categories", middle: null, small: null, paths: [...storedCategory.paths, secondPath] } },
    { keyword: "일부복수", category: { ...storedCategory, status: "multiple", reason: "incomplete_sample", middle: null, small: null, paths: [...storedCategory.paths, secondPath], categorizedCount: 2 } },
    { keyword: "미확인0", category: { ...storedCategory, status: "needs_confirmation", reason: "incomplete_sample", middle: null, small: null, paths: [], categorizedCount: 0 } },
    { keyword: "미확인1", category: { ...storedCategory, status: "multiple", reason: "incomplete_sample", middle: null, small: null, paths: storedCategory.paths, categorizedCount: 1 } },
    { keyword: "저장부족", category: { ...storedCategory, sampleSize: 4, categorizedCount: 4 } },
    { keyword: "저장오래됨", category: { ...storedCategory, reason: "stale_source" } },
    { keyword: "근거불일치", category: { ...storedCategory, basis: "invented" } }
  ], "기준어");
  assert.deepEqual(list.slice(0, 2).map((row) => row.category.status), ["single", "multiple"]);
  assert.equal(list[0].category.source, "stored_rank_snapshot_categories");
  assert.equal(list[0].category.basis, "stored_top5");
  assert.equal(list[0].category.sampleSize, 5);
  assert.equal(list[0].category.categorizedCount, 5);
  assert.equal(list[0].category.checkedAt, storedCheckedAt);
  assert.equal(list[2].category.status, "multiple");
  assert.equal(list[2].category.reason, "incomplete_sample");
  assert.equal(list[2].category.sampleSize, 5);
  assert.equal(list[2].category.categorizedCount, 2);
  assert.equal(list[2].category.paths.length, 2);
  assert.deepEqual(list.slice(3, 6).map((row) => row.category.status), ["needs_confirmation", "needs_confirmation", "needs_confirmation"]);
  assert.equal(list[5].category.reason, "incomplete_sample");
  assert.equal(list[6].category.status, "needs_confirmation");
  assert.equal(list[6].category.reason, "stale_source");
  assert.equal(list[7].category.status, "needs_confirmation");
  assert.equal(list[7].category.reason, "evidence_unproven");
  const confirmationReasons = ["incomplete_sample", "no_stored_evidence", "stale_source", "keyword_mismatch", "evidence_unproven", "scope_unavailable", "source_unavailable", "source_timeout"];
  const confirmationRows = client.normalizeRows(confirmationReasons.map((reason, index) => ({
    keyword: "확인필요" + index,
    category: { ...storedCategory, status: "needs_confirmation", reason, middle: null, small: null, paths: [], sampleSize: reason === "incomplete_sample" ? 4 : 0, categorizedCount: reason === "incomplete_sample" ? 3 : 0, checkedAt: reason === "no_stored_evidence" ? null : storedCheckedAt }
  })), "기준어");
  assert.deepEqual(confirmationRows.map((row) => row.category.reason), confirmationReasons);
  assert.ok(confirmationRows.every((row) => row.category.status === "needs_confirmation" && row.category.source === "stored_rank_snapshot_categories" && row.category.basis === "stored_top5"));
});

test("CSV preserves null, small-volume labels, all category paths and incomplete evidence while neutralizing formulas", () => {
  const client = api();
  const list = rows();
  list.push(...client.normalizeRows([{ keyword: '=HYPERLINK("https://example.invalid")', category: categories.unknown }, { keyword: "\t@SUM(1)" }], "seed"));
  const csv = client.csvText(list);
  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, /"중분류","소분류","카테고리 상태","카테고리 경로"/u);
  assert.match(csv, /냉온\/찜질용품 > 찜질기 \| 건강관리용품 > 기타건강관리용품/u);
  assert.match(csv, /"일부 분류 확인 필요","10","8"/u);
  assert.match(csv, /"전기찜질팩","","","확인 필요","","","","","","","<10",""/u);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/u);
  assert.match(csv, /"'@SUM\(1\)"/u);
});

class Node {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.value = "";
    this.disabled = false;
    this.listeners = {};
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name), contains: (name) => this.classes.has(name) };
  }
  set textContent(value) { this.content = String(value); this.children = []; }
  get textContent() { return (this.content || "") + this.children.map((child) => child.textContent).join(""); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.content = ""; this.children = nodes; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() { this.focused = true; }
}
function fixture(windowOverrides = {}) {
  const client = api(windowOverrides);
  const names = ["form", "input", "run", "body", "status", "count", "title", "middle", "small", "category-status", "sort", "export"];
  const nodes = Object.fromEntries(names.map((name) => [name, new Node()]));
  const document = { createElement: (tag) => new Node(tag), body: new Node("body") };
  const host = { ownerDocument: document, querySelector: (selector) => nodes[selector.replace("[data-related-query-", "").replace("]", "")] };
  let session = "session-a";
  const requests = [];
  const controller = client.mount(host, {
    sessionKey: () => session,
    fetch: (url, options) => new Promise((resolve) => requests.push({ url, options, resolve }))
  });
  return { nodes, requests, controller, host, document, session: (next) => { session = next; } };
}
function response(keyword, related) { return { ok: true, json: async () => ({ ok: true, keyword, related }) }; }

test("one explicit search issues one request, shows true category states and keeps labels/text safe", async () => {
  const { nodes, requests, controller } = fixture();
  const task = controller.search("온열찜질기");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/client/keyword-research?mode=related&keyword=" + encodeURIComponent("온열찜질기"));
  assert.equal(requests[0].options.method, "GET");
  assert.equal(nodes.run.disabled, true);
  requests[0].resolve(response("온열찜질기", [...rows(), { keyword: "<img src=x onerror=alert(1)>", category: categories.unknown }]));
  await task;
  assert.equal(nodes.run.disabled, false);
  assert.equal(nodes.export.disabled, false);
  assert.match(nodes.body.textContent, /냉온\/찜질용품 > 찜질기/u);
  assert.match(nodes.body.textContent, /복수 카테고리 · 2개/u);
  assert.match(nodes.body.textContent, /일부 분류 확인 필요/u);
  assert.match(nodes.body.textContent, /카테고리 데이터 연결 필요/u);
  assert.match(nodes.body.textContent, /<10/u);
  assert.match(nodes.body.textContent, /<img src=x onerror=alert\(1\)>/u);
  assert.equal(nodes.body.children.flatMap((tr) => tr.children).some((td) => td.tagName === "img"), false);
});

test("late responses cannot overwrite a newer query and account changes clear results", async () => {
  const ui = fixture();
  const first = ui.controller.search("첫조회");
  const second = ui.controller.search("두번째");
  ui.requests[1].resolve(response("두번째", [{ keyword: "최신 연관어", category: categories.single }]));
  await second;
  ui.requests[0].resolve(response("첫조회", [{ keyword: "과거 연관어", category: categories.single }]));
  await first;
  assert.match(ui.nodes.body.textContent, /최신 연관어/u);
  assert.doesNotMatch(ui.nodes.body.textContent, /과거 연관어/u);
  const third = ui.controller.search("진행중");
  ui.session("session-b");
  ui.controller.syncSession();
  assert.equal(ui.nodes.input.value, "");
  assert.equal(ui.nodes.export.disabled, true);
  ui.requests[2].resolve(response("진행중", [{ keyword: "다른 계정 결과", category: categories.single }]));
  await third;
  assert.doesNotMatch(ui.nodes.body.textContent, /다른 계정 결과/u);
  assert.equal(ui.nodes.run.disabled, false);
});

test("Commerce categories expose their catalog sample basis and extra results in UI and CSV", async () => {
  const ui = fixture();
  const task = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", [{ keyword: "허리찜질기", category: { ...categories.single, source: "naver_commerce_catalog_sample", hasMore: true } }]));
  await task;
  assert.match(ui.nodes.body.textContent, /조회된 네이버 카탈로그 기준 · 10개/u);
  assert.match(ui.nodes.body.textContent, /추가 결과 있음 · 전체 검색 분류가 아닙니다/u);
  const csv = api().csvText(api().normalizeRows([{ keyword: "허리찜질기", category: { ...categories.single, source: "naver_commerce_catalog_sample", hasMore: true } }], "온열찜질기"));
  assert.match(csv, /"카테고리 기준","추가 결과 여부"/u);
  assert.match(csv, /"조회된 네이버 카탈로그 기준","추가 결과 있음"/u);
  assert.doesNotMatch(csv, /sourceExhausted|marketTotal/u);
});

test("stored rank snapshot categories state the narrow sample, collection time and no-extra-lookup limits in UI and CSV", async () => {
  const ui = fixture();
  const task = ui.controller.search("온열찜질기");
  const multiple = { ...storedCategory, status: "multiple", reason: "incomplete_sample", middle: null, small: null, paths: [...storedCategory.paths, { middle: "건강관리용품", small: "기타건강관리용품" }], categorizedCount: 2 };
  const incomplete = { ...storedCategory, status: "needs_confirmation", reason: "incomplete_sample", middle: null, small: null, sampleSize: 4, categorizedCount: 3 };
  const stale = { ...storedCategory, status: "needs_confirmation", reason: "stale_source", middle: null, small: null };
  const noEvidence = { ...storedCategory, status: "needs_confirmation", reason: "no_stored_evidence", middle: null, small: null, paths: [], sampleSize: 0, categorizedCount: 0, checkedAt: null };
  ui.requests[0].resolve(response("온열찜질기", [
    { keyword: "허리찜질기", category: storedCategory },
    { keyword: "찜질패드", category: multiple },
    { keyword: "전기찜질팩", category: incomplete },
    { keyword: "복부찜질기", category: stale },
    { keyword: "온찜질기", category: noEvidence }
  ]));
  await task;
  assert.match(ui.nodes.body.textContent, /저장 표본 내 단일 카테고리/u);
  assert.match(ui.nodes.body.textContent, /저장 표본 내 복수 카테고리 · 2개/u);
  assert.match(ui.nodes.body.textContent, /저장된 순위 표본 5개 중 5개 분류 · 수집 2026\.10\.19 10:21:24 KST/u);
  assert.match(ui.nodes.body.textContent, /저장된 순위 표본 5개 중 2개 분류 · 수집 2026\.10\.19 10:21:24 KST/u);
  assert.match(ui.nodes.body.textContent, /저장 표본 기준 · 전체 분류 아님 · 추가 상품 조회 없음/u);
  assert.doesNotMatch(ui.nodes.body.textContent, /전체 검색 카테고리를 보장하지 않습니다|카테고리 보완을 위한 추가 상품 조회 없이/u);
  assert.match(ui.nodes.body.textContent, /저장 표본이 부족하거나 일부만 분류되어 확인 필요/u);
  assert.match(ui.nodes.body.textContent, /저장 표본이 오래되어 확인 필요/u);
  assert.match(ui.nodes.body.textContent, /저장된 순위 표본이 없어 확인 필요/u);
  assert.match(ui.nodes.body.textContent, /저장된 순위 표본 0개 중 0개 분류 · 수집 확인 필요/u);
  assert.match(ui.nodes.status.textContent, /저장 순위 표본 기준 5개 · 추가 상품 조회 없음/u);
  assert.doesNotMatch(ui.nodes.body.textContent, /조회된 네이버 카탈로그 기준|추가 결과 있음/u);

  const csv = api().csvText(api().normalizeRows([
    { keyword: "허리찜질기", volume: null, volumeLabel: "< 10", category: storedCategory },
    { keyword: "찜질패드", category: multiple },
    { keyword: "전기찜질팩", category: incomplete }
  ], "온열찜질기"));
  assert.match(csv, /"분류 표본 수","분류 확인 수","카테고리 확인 시각"/u);
  assert.match(csv, /"기존 순위 수집의 저장 상위 5개 상품 표본 기준","추가 상품 조회 없음"/u);
  assert.doesNotMatch(csv, /stored_rank_snapshot_categories|stored_top5|stored_sample_consistent|카테고리 사유 코드/u);
  assert.match(csv, new RegExp('"5","5","' + storedCheckedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"', "u"));
  assert.match(csv, /"저장 표본이 부족하거나 일부만 분류되어 확인 필요","4","3"/u);
  assert.match(csv, /"< 10"/u);
  assert.doesNotMatch(csv, /조회된 네이버 카탈로그 기준|추가 결과 있음|300개 표본/u);
});

test("failed and mismatched responses clear stale data and remain unavailable rather than showing zeros", async () => {
  const ui = fixture();
  let task = ui.controller.search("정상");
  ui.requests[0].resolve(response("정상", [{ keyword: "정상 연관어", category: categories.single }]));
  await task;
  task = ui.controller.search("실패");
  ui.requests[1].resolve({ ok: false, json: async () => ({ ok: false, related: [] }) });
  await task;
  assert.doesNotMatch(ui.nodes.body.textContent, /정상 연관어/u);
  assert.equal(ui.nodes.export.disabled, true);
  assert.ok(ui.nodes.status.classes.has("is-error"));
  task = ui.controller.search("요청키워드");
  ui.requests[2].resolve(response("다른키워드", [{ keyword: "잘못된 연관어" }]));
  await task;
  assert.doesNotMatch(ui.nodes.body.textContent, /잘못된 연관어/u);
});

test("a request times out finitely even without AbortController and does not retry", async () => {
  let expire;
  const ui = fixture({ AbortController: undefined, setTimeout: (handler) => { expire = handler; return 1; }, clearTimeout: () => {} });
  const task = ui.controller.search("시간초과");
  assert.equal(ui.requests.length, 1);
  expire();
  await task;
  assert.match(ui.nodes.status.textContent, /조회 시간이 초과/u);
  assert.equal(ui.nodes.run.disabled, false);
  assert.equal(ui.nodes.export.disabled, true);
  assert.equal(ui.requests.length, 1);
});

test("the self-contained request adapter checks the cookie session before and after the related response", async () => {
  const client = api();
  const requests = [];
  const session = { role: "team", scopeKey: "team-a", teamId: "a", csrfToken: "session-proof-a" };
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return url === "/api/session" ? { ok: true, json: async () => ({ ok: true, session }) } : response("seed", [{ keyword: "related" }]);
  };
  const verified = client.createVerifiedFetch(fetcher, "/api/session", () => "epoch-1");
  const result = await verified("/api/client/keyword-research?mode=related&keyword=seed", {});
  assert.equal((await result.json()).related[0].keyword, "related");
  assert.deepEqual(requests.map((request) => request.url), ["/api/session", "/api/client/keyword-research?mode=related&keyword=seed", "/api/session"]);
  for (const request of requests) {
    assert.equal(request.options.credentials, "same-origin");
    assert.equal(request.options.cache, "no-store");
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.headers, undefined);
  }
});

test("server-side account changes or a root lock during the request reject the payload", async () => {
  const client = api();
  let checks = 0;
  const changing = client.createVerifiedFetch(async (url) => url === "/api/session"
    ? { ok: true, json: async () => ({ ok: true, session: { role: "client", scopeKey: ++checks === 1 ? "account-a" : "account-b" } }) }
    : response("seed", [{ keyword: "should not render" }]), "/api/session", () => "epoch-1");
  await assert.rejects(changing("/api/client/keyword-research?mode=related&keyword=seed", {}), /related_session_changed/u);
  let rootKey = "epoch-1";
  const locking = client.createVerifiedFetch(async (url) => {
    if (url === "/api/session") return { ok: true, json: async () => ({ ok: true, session: { role: "owner", scopeKey: "owner" } }) };
    rootKey = "";
    return response("seed", [{ keyword: "should not render" }]);
  }, "/api/session", () => rootKey);
  await assert.rejects(locking("/api/client/keyword-research?mode=related&keyword=seed", {}), /related_session_changed/u);
});

test("external bootstrap stays idle, observes logout, and discards a late category response without touching the old app", async () => {
  const ui = fixture();
  const root = new Node();
  root.classes.add("is-authed");
  root.querySelector = (selector) => selector === "[data-related-query]" ? ui.host : null;
  root.contains = () => true;
  const attributes = new Map();
  ui.host.getAttribute = (name) => attributes.get(name);
  ui.host.setAttribute = (name, value) => attributes.set(name, value);
  ui.document.readyState = "complete";
  ui.document.getElementById = (name) => name === "mi-admin" ? root : null;
  const requests = [];
  let observe;
  const categoryWait = new Promise((resolve) => { requests.completeCategory = resolve; });
  api({
    document: ui.document,
    location: { hostname: "insight.momentlabs.co.kr" },
    MutationObserver: class { constructor(callback) { observe = callback; } observe() {} },
    fetch: async (url) => {
      requests.push(url);
      if (url === "/api/session") return { ok: true, json: async () => ({ ok: true, session: { role: "owner", scopeKey: "owner" } }) };
      return categoryWait;
    }
  });
  assert.equal(requests.length, 0, "opening the screen does not invoke a collector or lookup");
  ui.nodes.input.value = "온열찜질기";
  ui.nodes.form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  root.classes.delete("is-authed");
  root.classes.add("is-locked");
  observe([{ oldValue: "is-authed" }]);
  assert.equal(ui.nodes.input.value, "");
  assert.equal(ui.nodes.export.disabled, true);
  requests.completeCategory(response("온열찜질기", [{ keyword: "과거 계정 결과", category: categories.single }]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(ui.nodes.body.textContent, /과거 계정 결과/u);
  assert.equal(ui.nodes.run.disabled, false);
  assert.equal(requests.length, 2, "a locked root stops the final session read and does not retry");
});

test("both existing keyword screens retain their preview and share only the independent related controller", () => {
  for (const [page, screen] of [["admin", "data-mi-admin-screen"], ["client", "data-mi-screen"]]) {
    const html = fs.readFileSync("src/pages/" + page + ".html", "utf8");
    assert.match(html, new RegExp(`${screen}="(?:keyword|keyword-tool)">키워드 조회<\\/a>\\s*<a [^>]+${screen}="related-keywords">연관 키워드 조회<\\/a>`, "u"));
    assert.match(html, /data-keyword-related>[\s\S]*?전체 보기|전체 보기[\s\S]*?data-keyword-related>/u);
    assert.equal((html.match(/src="\/mi-related-keywords\.js/g) || []).length, 1);
    assert.equal((html.match(/data-related-query-body/g) || []).length, 1);
    assert.doesNotMatch(html, /data-keyword-related-full[=" >]/u);
    assert.match(html, /정확히 같은 키워드로 저장된 최근 순위 수집 상품 5개 표본 기준/u);
    const categoryHelp = html.match(/<p class="mi-rq-help">([^<]+)<\/p>/u)?.[1] || "";
    assert.match(categoryHelp, /추가 상품 조회는 하지 않으며/u);
    assert.match(categoryHelp, /저장 근거가 없거나 오래된 항목은 확인 필요/u);
    assert.doesNotMatch(categoryHelp, /네이버 카탈로그 검색 기준/u);
  }
  assert.doesNotMatch(source, /keywordDatasets|keywordRelatedCache|renderKeywordChart|rank-tracker|shopping-rank|x-mi-agency-code|setInterval/u);
  assert.doesNotMatch(source, /innerHTML|outerHTML/u);
  assert.match(source, /new window\.MutationObserver/u);
  assert.match(source, /attributeOldValue: true/u);
  assert.match(source, /createVerifiedFetch\([\s\S]*?"\/api\/session"/u);
});

test("both existing inline applications remain byte-identical to HEAD so their CSP hashes and locked functions stay valid", () => {
  function hashes(html) {
    return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter((match) => !/\bsrc\s*=/i.test(match[1])).map((match) => createHash("sha256").update(match[2]).digest("hex"));
  }
  for (const page of ["admin", "client"]) {
    const path = "src/pages/" + page + ".html";
    const original = execFileSync("git", ["show", "HEAD:" + path], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.deepEqual(hashes(fs.readFileSync(path, "utf8")), hashes(original), path);
  }
});
