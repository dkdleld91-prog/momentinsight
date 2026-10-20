import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync("public/mi-related-keywords.js", "utf8");
function api(overrides = {}, globals = {}) {
  const window = { setTimeout, clearTimeout, AbortController, ...overrides };
  vm.runInNewContext(source, { window, Blob, URL, Date, Uint8Array, ArrayBuffer, ...globals });
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
    { keyword: "허리찜질기", volume: 100, pcVolume: 0, mobileVolume: 100, competition: "보통", category: categories.single },
    { keyword: "찜질패드", volume: 80, competition: "높음", category: categories.multiple },
    { keyword: "전기찜질팩", volume: null, pcVolume: null, pcVolumeLabel: "<10", mobileVolume: null, competition: "낮음", category: categories.unknown },
    { keyword: seed, volume: 1000, category: categories.single }
  ], seed);
}

test("related rows use only provided categories, deduplicate, exclude seed, and cap at 50 without padding", () => {
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
  const supplied = Array.from({ length: 51 }, (_, index) => ({ keyword: "연관어" + index, volume: index, pcVolume: 0, mobileVolume: index }));
  const capped = client.normalizeRows(supplied, "seed");
  assert.equal(capped.length, 50);
  assert.deepEqual(Array.from(capped, (row) => row.keyword), supplied.slice(0, 50).map((row) => row.keyword));
  assert.deepEqual(Array.from(capped, (row) => row.volume), supplied.slice(0, 50).map((row) => row.volume));
  assert.equal(client.normalizeRows(supplied.slice(0, 14), "seed").length, 14, "a short real response is never padded to the limit");
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
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name), contains: (name) => this.classes.has(name) };
  }
  set textContent(value) { this.content = String(value); this.children = []; }
  get textContent() { return (this.content || "") + this.children.map((child) => child.textContent).join(""); }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  replaceChildren(...nodes) { this.content = ""; this.children = nodes; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  matches(selector) {
    return selector.split(",").some((part) => {
      const match = /^([a-z-]+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/u.exec(part.trim());
      return match && (!match[1] || match[1] === this.tagName) && (!match[2] || this.attributes.has(match[2]) && (match[3] === undefined || this.attributes.get(match[2]) === match[3]));
    });
  }
  closest(selector) {
    if (this.matches(selector)) return this;
    return this.parentNode?.closest(selector) || null;
  }
  querySelector(selector) { return descendants(this).find((node) => node.matches(selector)) || null; }
  querySelectorAll(selector) { return descendants(this).filter((node) => node.matches(selector)); }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { this.focused = true; }
  click() { this.clicked = true; this.listeners.click?.({ target: this, preventDefault() {} }); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
}
function fixture(windowOverrides = {}, optionOverrides = {}, globals = {}) {
  const client = api(windowOverrides, globals);
  const names = ["form", "input", "run", "body", "status", "count", "title", "competition", "middle", "small", "category-status", "sort", "export"];
  const nodes = Object.fromEntries(names.map((name) => [name, new Node()]));
  nodes.sort.value = "volume";
  const created = [];
  const document = { createElement: (tag) => { const node = new Node(tag); created.push(node); return node; }, body: new Node("body"), created };
  const headers = Object.fromEntries(["name", "volume", "pc", "mobile", "clicks", "ctr"].map((field) => {
    const header = new Node("th"), button = new Node("button"), arrow = new Node("span");
    header.setAttribute("aria-sort", "none");
    button.setAttribute("data-related-query-sort-key", field);
    arrow.setAttribute("data-related-query-sort-arrow", "");
    button.appendChild(arrow);
    header.appendChild(button);
    return [field, { header, button, arrow }];
  }));
  const host = {
    ownerDocument: document,
    listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
    contains: (node) => nodes.body.contains(node) || Object.values(headers).some((entry) => entry.header.contains(node)),
    querySelector: (selector) => nodes[selector.replace("[data-related-query-", "").replace("]", "")],
    querySelectorAll: (selector) => selector === "[data-related-query-sort-key]" ? Object.values(headers).map((entry) => entry.button) : []
  };
  let session = "session-a";
  const requests = [];
  const copies = [], analyses = [];
  const controller = client.mount(host, {
    sessionKey: () => session,
    fetch: (url, options) => new Promise((resolve) => requests.push({ url, options, resolve })),
    copy: async (keyword) => { copies.push(keyword); },
    analyze: (keyword, category) => { analyses.push({ keyword, category }); return true; },
    ...optionOverrides
  });
  return { nodes, requests, controller, host, document, headers, copies, analyses, session: (next) => { session = next; } };
}
function response(keyword, related, extra = {}) { return { ok: true, json: async () => ({ ok: true, keyword, related, checkedAt: storedCheckedAt, ...extra }) }; }
function descendants(node, tag) {
  return node.children.flatMap((child) => [...(!tag || child.tagName === tag ? [child] : []), ...descendants(child, tag)]);
}
function action(ui, index, name) { return descendants(ui.nodes.body.children[index], "button").find((node) => node.getAttribute("data-related-query-" + name) !== null); }
function clickAction(ui, index, name) {
  const button = action(ui, index, name);
  assert.ok(button, `row ${index}: ${name} action exists`);
  const event = { target: button, preventDefault() {} };
  return button.listeners.click ? button.listeners.click(event) : ui.nodes.body.listeners.click(event);
}

test("one explicit search issues one request, shows only metrics and explicit actions, and keeps labels/text safe", async () => {
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
  assert.equal(descendants(nodes.body, "button").length, 8, "each provided keyword has copy and analyze actions");
  assert.ok(nodes.body.children.every((row) => row.children.length === 8));
  assert.equal(descendants(nodes.body, "small").length, 0);
  assert.doesNotMatch(nodes.body.textContent, /냉온\/찜질용품|카테고리 모두 보기|저장 표본/u);
  assert.match(nodes.body.textContent, /복사.*상세 분석/u);
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

test("legacy Commerce metadata stays available without repeated row prose and is preserved in CSV", async () => {
  const ui = fixture();
  const task = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", [{ keyword: "허리찜질기", category: { ...categories.single, source: "naver_commerce_catalog_sample", hasMore: true } }]));
  await task;
  assert.doesNotMatch(ui.nodes.body.textContent, /냉온\/찜질용품|네이버 카탈로그/u);
  assert.equal(descendants(ui.nodes.body, "small").length, 0);
  const csv = api().csvText(api().normalizeRows([{ keyword: "허리찜질기", category: { ...categories.single, source: "naver_commerce_catalog_sample", hasMore: true } }], "온열찜질기"));
  assert.match(csv, /"카테고리 기준","추가 결과 여부"/u);
  assert.match(csv, /"조회된 네이버 카탈로그 기준","추가 결과 있음"/u);
  assert.doesNotMatch(csv, /sourceExhausted|marketTotal/u);
});

test("category evidence stays out of result rows but remains unchanged in CSV and analysis handoff", async () => {
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
  assert.equal(descendants(ui.nodes.body, "small").length, 0, "no per-row sample/date/source prose remains in the DOM");
  assert.equal(descendants(ui.nodes.body, "details").length, 0);
  assert.equal(descendants(ui.nodes.body, "button").length, 10);
  assert.doesNotMatch(ui.nodes.body.textContent, /냉온\/찜질용품|저장 표본|카테고리|수집 2026/u);
  await clickAction(ui, 1, "analyze");
  assert.equal(ui.analyses.length, 1);
  assert.equal(ui.analyses[0].keyword, "찜질패드");
  assert.equal(ui.analyses[0].category.reason, "incomplete_sample");
  assert.equal(ui.analyses[0].category.categorizedCount, 2);
  assert.equal(ui.analyses[0].category.paths.length, 2);
  assert.equal(ui.requests.length, 1, "handoff does not send any new lookup or rank request");

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

test("both existing keyword screens retain their preview, expose only action-based results, and share the independent controller", () => {
  for (const [page, screen] of [["admin", "data-mi-admin-screen"], ["client", "data-mi-screen"]]) {
    const html = fs.readFileSync("src/pages/" + page + ".html", "utf8");
    assert.match(html, new RegExp(`${screen}="(?:keyword|keyword-tool)">키워드 조회<\\/a>\\s*<a [^>]+${screen}="related-keywords">연관 키워드 조회<\\/a>`, "u"));
    assert.match(html, /data-keyword-related>[\s\S]*?전체 보기|전체 보기[\s\S]*?data-keyword-related>/u);
    assert.equal((html.match(/src="\/mi-related-keywords\.js/g) || []).length, 1);
    assert.equal((html.match(/data-related-query-body/g) || []).length, 1);
    assert.doesNotMatch(html, /data-keyword-related-full[=" >]/u);
    assert.match(html, /정확히 같은 키워드로 저장된 최근 순위 수집 상품 5개 표본 기준/u);
    assert.ok(/<th scope="col">활용<\/th>/u.test(html), `${page}: requested keyword actions replace sparse category column`);
    assert.ok(!/<th scope="col">중분류 &gt; 소분류<\/th>/u.test(html), `${page}: old structural heading removed`);
    for (const className of ["mi-rq-head", "mi-rq-search", "mi-rq-results", "mi-rq-result-head", "mi-rq-result-meta", "mi-rq-count"]) assert.ok(new RegExp(`class="[^"]*\\b${className}\\b`, "u").test(html), `${page}: scoped presentation hook ${className}`);
    const categoryHelp = html.match(/<details class="mi-rq-help">([\s\S]*?)<\/details>/u)?.[1] || "";
    assert.match(categoryHelp, /<summary>카테고리.*기준<\/summary>/u);
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

test("premium visual rules are scoped to the related view and preserve numeric alignment, focus and reduced motion", () => {
  const css = fs.readFileSync("public/mi-related-keywords.css", "utf8");
  const rules = css.split("\n").map((line) => line.trim()).filter((line) => line.includes("{") && !line.startsWith("@") && !line.startsWith("/*"));
  assert.ok(rules.length > 20);
  assert.ok(rules.every((line) => line.startsWith(":is(#mi-admin,#mi-clean,#mi-public-related) [data-related-query]") || line.startsWith(":is(#mi-admin,#mi-clean,#mi-public-related) .mi-rq-handoff") || line.startsWith("#mi-public-related")), "every visual rule must remain under the independent related view, its narrow handoff notice or the isolated public shell");
  assert.match(css, /font-variant-numeric:tabular-nums/u);
  assert.match(css, /overflow-x:auto/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /@media \(max-width:640px\)/u);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/u);
  assert.doesNotMatch(css, /@import|url\(|https?:/u, "visual update loads no external font or bitmap");
});

test("copy reports success only after the promised write succeeds and failures stay explicit", async () => {
  let finish;
  const copied = [];
  const ui = fixture({}, { copy: (keyword) => { copied.push(keyword); return new Promise((resolve) => { finish = resolve; }); } });
  const search = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", rows()));
  await search;
  clickAction(ui, 0, "copy");
  assert.deepEqual(copied, ["허리찜질기"]);
  assert.doesNotMatch(ui.nodes.status.textContent, /복사했|복사되었|복사 완료/u);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(ui.nodes.status.textContent, /복사/u);
  assert.equal(ui.nodes.status.classes.has("is-error"), false);
  assert.equal(ui.requests.length, 1, "clipboard action does not trigger another API call");
  const denied = fixture({}, { copy: async () => { throw new Error("permission denied"); } });
  const deniedSearch = denied.controller.search("온열찜질기");
  denied.requests[0].resolve(response("온열찜질기", rows()));
  await deniedSearch;
  await clickAction(denied, 0, "copy");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(denied.nodes.status.classes.has("is-error"), true);
  assert.match(denied.nodes.status.textContent, /복사/u);
  assert.doesNotMatch(denied.nodes.status.textContent, /복사했습니다|복사되었습니다|복사 완료[.!]?(?:$|\s*·)/u);
  assert.equal(denied.requests.length, 1);
});

test("copy completion after account change is discarded and analysis does not invoke a search", async () => {
  let finish;
  const ui = fixture({}, { copy: () => new Promise((resolve) => { finish = resolve; }) });
  const search = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", rows()));
  await search;
  await clickAction(ui, 0, "analyze");
  assert.equal(ui.analyses[0].keyword, "허리찜질기");
  assert.equal(ui.requests.length, 1);
  clickAction(ui, 0, "copy");
  ui.session("session-b");
  ui.controller.syncSession();
  const clearedStatus = ui.nodes.status.textContent;
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.nodes.status.textContent, clearedStatus);
  assert.equal(ui.nodes.export.disabled, true);
  assert.equal(ui.requests.length, 1);
});

test("a clipboard provider that never resolves times out once without retrying", async () => {
  let expire;
  let attempts = 0;
  const ui = fixture({ setTimeout: (handler, milliseconds) => {
    if (milliseconds === 2000) { expire = handler; return -1; }
    return setTimeout(handler, milliseconds);
  } }, { copy: () => { attempts += 1; return new Promise(() => {}); } });
  const search = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", rows()));
  await search;
  clickAction(ui, 0, "copy");
  assert.equal(typeof expire, "function");
  expire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.nodes.status.classes.has("is-error"), true);
  assert.equal(attempts, 1);
  assert.equal(ui.requests.length, 1);
});

test("overlapping copy actions keep the newest feedback and hidden or forged rows cannot trigger actions", async () => {
  const resolvers = [];
  let copyCalls = 0;
  const ui = fixture({}, { copy: () => { copyCalls += 1; return new Promise((resolve) => resolvers.push(resolve)); } });
  const task = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", rows()));
  await task;
  const older = ui.controller.copyKeyword("허리찜질기");
  const newer = ui.controller.copyKeyword("찜질패드");
  resolvers[1]();
  assert.equal(await newer, true);
  const newestFeedback = ui.nodes.status.textContent;
  assert.match(newestFeedback, /찜질패드/u);
  resolvers[0]();
  assert.equal(await older, false);
  assert.equal(ui.nodes.status.textContent, newestFeedback);
  ui.nodes.competition.value = "낮음";
  ui.nodes.competition.listeners.change();
  assert.equal(await ui.controller.copyKeyword("허리찜질기"), false);
  assert.equal(ui.controller.analyzeKeyword("허리찜질기"), false);
  assert.equal(await ui.controller.copyKeyword("조작된 키워드"), false);
  assert.equal(copyCalls, 2);
  assert.equal(ui.analyses.length, 0);
  assert.equal(ui.requests.length, 1);
});

test("missing analysis destinations fail visibly and the existing screen is only prefilled, never auto-submitted", async () => {
  const ui = fixture({}, { analyze: () => false });
  const task = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", rows()));
  await task;
  assert.equal(ui.controller.analyzeKeyword("허리찜질기"), false);
  assert.equal(ui.nodes.status.classes.has("is-error"), true);
  assert.match(ui.nodes.status.textContent, /이동하지 못했습니다/u);
  assert.equal(ui.requests.length, 1);
  for (const admin of [true, false]) {
    const input = new Node("input"), link = new Node("a"), view = new Node("section"), handoff = new Node("aside");
    input.value = "이전 키워드";
    input.dispatchEvent = () => { throw new Error("input/change dispatch must never happen"); };
    let navigation = 0;
    link.click = () => { navigation += 1; view.classes.add("is-active"); };
    const selectors = new Map([
      [admin ? "[data-admin-keyword-input]" : "[data-mi-keyword-input]", input],
      [admin ? 'a[data-mi-admin-screen="keyword"]' : 'a[data-mi-screen="keyword-tool"]', link],
      [admin ? "#mi-admin-keyword" : "#mi-keyword-tool", view],
      ["[data-related-query-handoff]", handoff]
    ]);
    const root = { id: admin ? "mi-admin" : "mi-clean", ownerDocument: { createElement: (tag) => new Node(tag) }, querySelector: (selector) => selectors.get(selector) };
    assert.equal(api().navigateKeyword(root, "허리찜질기", storedCategory), true);
    assert.equal(input.value, "허리찜질기");
    assert.equal(navigation, 1);
    assert.equal(handoff.hidden, false);
    assert.match(handoff.textContent, /아직 이 키워드를 조회하지 않았습니다/u);
    assert.match(handoff.textContent, /이전 조회 결과가 남아 있을 수 있습니다/u);
    assert.match(handoff.textContent, /냉온\/찜질용품 > 찜질기/u);
    selectors.delete(admin ? "#mi-admin-keyword" : "#mi-keyword-tool");
    input.value = "보존할 키워드";
    assert.equal(api().navigateKeyword(root, "전달 실패", storedCategory), false);
    assert.equal(input.value, "보존할 키워드");
    assert.equal(navigation, 1);
  }
});

test("related result tables replace sparse categories with two explicit safe actions", () => {
  for (const page of ["admin", "client"]) {
    const html = fs.readFileSync("src/pages/" + page + ".html", "utf8");
    const start = html.search(/<section\b[^>]*\bdata-related-query(?:\s|>)/u);
    const view = html.slice(start, html.indexOf("</section>", start));
    assert.ok(/<th scope="col">활용<\/th>/u.test(view), `${page}: actions are the final table column`);
    assert.ok(/data-related-query-competition/u.test(view), `${page}: competition filter remains based on provided real metrics`);
    assert.doesNotMatch(view, /data-related-query-middle|data-related-query-small|data-related-query-category-status/u);
    assert.ok(!/<th scope="col">카테고리<\/th>/u.test(view));
  }
});

test("competition choices preserve actual provider labels including 중간 and missing values are not invented", async () => {
  const ui = fixture();
  const task = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", [
    { keyword: "중간 경쟁", competition: "중간", volume: 100 },
    { keyword: "보통 경쟁", competition: "보통", volume: 80 },
    { keyword: "경쟁도 미제공", volume: null }
  ]));
  await task;
  assert.deepEqual(ui.nodes.competition.children.map((node) => node.value).sort(), ["", "보통", "중간"].sort());
  assert.equal(ui.nodes.competition.children.find((node) => node.value === "중간").textContent, "중간");
  ui.nodes.competition.value = "중간";
  ui.nodes.competition.listeners.change();
  assert.equal(ui.nodes.body.children.length, 1);
  assert.match(ui.nodes.body.textContent, /중간 경쟁/u);
  assert.doesNotMatch(ui.nodes.body.textContent, /보통 경쟁|경쟁도 미제공/u);
  const csv = api().csvText(api().normalizeRows([{ keyword: "중간 경쟁", competition: "중간" }], "기준어"));
  assert.match(csv, /"중간"/u);
  assert.doesNotMatch(csv, /"보통"/u);
});

test("sortable headers expose six explicit keyboard buttons and native column sort semantics on both surfaces", () => {
  for (const page of ["admin", "client"]) {
    const html = fs.readFileSync("src/pages/" + page + ".html", "utf8");
    const start = html.search(/<section\b[^>]*\bdata-related-query(?:\s|>)/u);
    const view = html.slice(start, html.indexOf("</section>", start));
    const keys = [...view.matchAll(/<button\b[^>]*data-related-query-sort-key="([^"]+)"[^>]*>/gu)].map((match) => match[1]);
    assert.deepEqual(keys, ["name", "volume", "pc", "mobile", "clicks", "ctr"], `${page}: sortable header keys`);
    assert.equal((view.match(/data-related-query-sort-arrow/g) || []).length, 6);
    assert.equal((view.match(/aria-sort="(?:ascending|descending|none)"/g) || []).length, 6);
    assert.ok(/<option value="clicks">/u.test(view));
    assert.ok(/<option value="ctr">/u.test(view));
  }
});

test("numeric asc/desc sorting always keeps null and suppressed labels last, zero valid, and row identity unchanged", () => {
  const client = api();
  assert.equal(typeof client.sortRows, "function");
  const list = client.normalizeRows([
    { keyword: "다", volume: 100, pcVolume: 5, mobileVolume: 80, clicks: 10, ctr: 2 },
    { keyword: "나", volume: 0, pcVolume: 0, mobileVolume: 0, clicks: 0, ctr: 0 },
    { keyword: "라", volume: null, volumeLabel: "< 20", pcVolume: null, pcVolumeLabel: "< 10", mobileVolume: null, clicks: null, ctr: null },
    { keyword: "가", volume: 50, pcVolume: 2, mobileVolume: 20, clicks: 4, ctr: .5 }
  ], "seed");
  const original = list.map((row) => row.keyword);
  for (const field of ["volume", "pc", "mobile", "clicks", "ctr"]) {
    assert.deepEqual(client.sortRows(list, field, "asc").map((row) => row.keyword), ["나", "가", "다", "라"], `${field}: asc null last`);
    assert.deepEqual(client.sortRows(list, field, "desc").map((row) => row.keyword), ["다", "가", "나", "라"], `${field}: desc null last`);
    assert.equal(new Set(client.sortRows(list, field, "asc")).size, list.length, `${field}: no added or duplicate rows`);
  }
  assert.deepEqual(client.sortRows(list, "name", "asc").map((row) => row.keyword), ["가", "나", "다", "라"]);
  assert.deepEqual(client.sortRows(list, "name", "desc").map((row) => row.keyword), ["라", "다", "나", "가"]);
  assert.deepEqual(list.map((row) => row.keyword), original, "sorting never mutates the source response order");
  for (const [field, value, label] of [["volume", "volume", "volumeLabel"], ["pc", "pcVolume", "pcVolumeLabel"], ["mobile", "mobileVolume", "mobileVolumeLabel"]]) {
    const contradictory = client.normalizeRows([
      { keyword: "표기 비공개", [value]: 999, [label]: " < 10 " },
      { keyword: "정확한 값", [value]: 10 },
      { keyword: "실제 영", [value]: 0 }
    ], "seed");
    assert.deepEqual(client.sortRows(contradictory, field, "asc").map((row) => row.keyword), ["실제 영", "정확한 값", "표기 비공개"], `${field}: a contradictory numeric value cannot override a suppressed label`);
    assert.deepEqual(client.sortRows(contradictory, field, "desc").map((row) => row.keyword), ["정확한 값", "실제 영", "표기 비공개"]);
  }
});

test("header toggles and field selection keep direction, arrows, aria-sort and local results synchronized", async () => {
  const ui = fixture();
  const task = ui.controller.search("온열찜질기");
  ui.requests[0].resolve(response("온열찜질기", [
    { keyword: "허리찜질기", volume: 100, pcVolume: 90, mobileVolume: 10, clicks: 4, ctr: 2, competition: "중간" },
    { keyword: "찜질패드", volume: 0, pcVolume: 0, mobileVolume: 0, clicks: 0, ctr: 0, competition: "낮음" },
    { keyword: "전기찜질팩", volume: null, volumeLabel: "< 20", pcVolume: null, mobileVolume: null, clicks: null, ctr: null }
  ]));
  await task;
  const order = () => ui.nodes.body.children.map((row) => row.children[0].textContent);
  function state(field, direction) {
    assert.equal(ui.headers[field].header.getAttribute("aria-sort"), direction === "asc" ? "ascending" : "descending");
    assert.equal(ui.headers[field].arrow.textContent, direction === "asc" ? "↑" : "↓");
    for (const other of Object.keys(ui.headers).filter((key) => key !== field)) {
      assert.equal(ui.headers[other].header.getAttribute("aria-sort"), "none");
      assert.equal(ui.headers[other].arrow.textContent, "↕");
    }
    assert.match(ui.headers[field].button.getAttribute("aria-label"), /오름차순/u);
    assert.match(ui.headers[field].button.getAttribute("aria-label"), /내림차순/u);
    assert.equal(ui.requests.length, 1, "no sort or filter operation sends another lookup");
  }
  state("volume", "desc");
  ui.controller.setSort("volume");
  state("volume", "asc");
  assert.deepEqual(order(), ["찜질패드", "허리찜질기", "전기찜질팩"]);
  ui.controller.setSort("volume");
  state("volume", "desc");
  assert.deepEqual(order(), ["허리찜질기", "찜질패드", "전기찜질팩"]);
  ui.controller.setSort("name");
  state("name", "asc");
  assert.deepEqual(order(), ["전기찜질팩", "찜질패드", "허리찜질기"]);
  ui.controller.setSort("name");
  state("name", "desc");
  for (const field of ["pc", "mobile", "clicks", "ctr"]) {
    ui.nodes.sort.value = field;
    ui.nodes.sort.listeners.change();
    state(field, "desc");
    assert.deepEqual(order(), ["허리찜질기", "찜질패드", "전기찜질팩"]);
    ui.controller.setSort(field);
    state(field, "asc");
    assert.deepEqual(order(), ["찜질패드", "허리찜질기", "전기찜질팩"]);
  }
  ui.nodes.competition.value = "중간";
  ui.nodes.competition.listeners.change();
  state("ctr", "asc");
  assert.deepEqual(order(), ["허리찜질기"]);
});

test("download UI loads the true XLSX helper before its controller and no longer promises a renamed CSV", () => {
  assert.equal(typeof api().workbookData, "function");
  for (const page of ["admin", "client"]) {
    const html = fs.readFileSync("src/pages/" + page + ".html", "utf8");
    const label = html.match(/<button\b[^>]*data-related-query-export[^>]*>([\s\S]*?)<\/button>/u)?.[1].replace(/<[^>]*>/gu, "").trim();
    assert.equal(label, "엑셀 다운로드", `${page}: true workbook download label`);
    assert.equal((html.match(/src="\/mi-related-keywords-xlsx\.js/gu) || []).length, 1);
    assert.ok(html.indexOf('src="/mi-related-keywords-xlsx.js') < html.indexOf('src="/mi-related-keywords.js'), `${page}: workbook writer is available before the controller`);
    const section = html.match(/<section\b[^>]*data-related-query(?:\s|>)[\s\S]*?<\/section>/u)?.[0];
    assert.match(section, /조회 전 · 최대 50개/u);
    assert.doesNotMatch(section, /카테고리 근거 시트/u);
    assert.match(section, /현재 표시된 키워드의 검색량·광고 지표만 한 시트/u);
  }
});

test("single-sheet workbook data preserves exact zero, suppressed labels, unavailable values and CTR fractions without category payload", () => {
  const client = api();
  const list = client.normalizeRows([
    { keyword: "실제 영", volume: 0, pcVolume: 0, mobileVolume: 0, competition: "중간", clicks: 0, ctr: 0, category: storedCategory },
    { keyword: "비공개", volume: null, volumeLabel: "< 20", pcVolume: null, pcVolumeLabel: "< 10", mobileVolume: null, mobileVolumeLabel: "< 10", category: categories.unknown },
    { keyword: "실제 값", volume: 100, pcVolume: 20, mobileVolume: 80, competition: "보통", clicks: 1.2, ctr: 1.23, category: categories.multiple }
  ], "확정 검색어");
  const meta = { keyword: "확정 검색어", queriedAt: storedCheckedAt, exportedAt: "2026-10-19T05:00:00.000Z", competition: "", sortLabel: "통합 월 검색량 · 오름차순" };
  const data = client.workbookData(list, meta);
  for (const key of Object.keys(meta)) assert.equal(data[key], meta[key], `confirmed export metadata ${key}`);
  assert.deepEqual(Array.from(data.mainRows[0]), [1, "실제 영", 0, 0, 0, "중간", 0, 0]);
  assert.deepEqual(Array.from(data.mainRows[1]), [2, "비공개", "< 20", "< 10", "< 10", "확인 필요", "확인 필요", "확인 필요"]);
  assert.equal(data.mainRows[2][6], 1.2);
  assert.ok(Math.abs(data.mainRows[2][7] - .0123) < 1e-12, "1.23% is stored as a numeric Excel fraction, not 1.23");
  assert.equal(Object.hasOwn(data, "categoryRows"), false, "the single-sheet writer receives no category sheet payload");
  assert.ok(data.mainRows.every((row) => row.length === 8), "only the current eight result columns are exported");
  assert.equal(list[0].category.status, "single", "category evidence remains available to the existing analysis handoff");
  assert.equal(list[2].category.status, "multiple");
  const contradictory = client.workbookData(client.normalizeRows([
    { keyword: "표시 우선", volume: 999, volumeLabel: "확인 필요", pcVolume: 900, pcVolumeLabel: "12", mobileVolume: 1000, mobileVolumeLabel: "1,000" }
  ], "seed"), meta);
  assert.equal(contradictory.mainRows[0][2], "확인 필요", "an unpublished underlying number never replaces the visible unknown label");
  assert.equal(contradictory.mainRows[0][3], "12", "a contradictory visible label remains literal text, not the hidden numeric value");
  assert.equal(contradictory.mainRows[0][4], 1000, "a matching formatted numeric label retains its numeric Excel type");
});

function workbookFixture(writer) {
  const blobs = [], revoked = [];
  const ui = fixture({ MomentRelatedKeywordXlsx: { create: writer }, setTimeout: (handler, milliseconds) => milliseconds === 1000 ? (handler(), -1) : setTimeout(handler, milliseconds) }, {}, {
    URL: { createObjectURL: (blob) => { blobs.push(blob); return "blob:fixture-" + blobs.length; }, revokeObjectURL: (url) => revoked.push(url) }
  });
  return { ...ui, blobs, revoked };
}

test("true XLSX export uses current filtered sorted rows and confirmed response metadata rather than edited input", async () => {
  const payloads = [];
  // Writer contract stub only; real ZIP/XML validity is independently checked by browser QA.
  const bytes = new Uint8Array(22);
  bytes.set([0x50, 0x4b, 3, 4]);
  const ui = workbookFixture((data) => { payloads.push(data); return bytes; });
  const task = ui.controller.search("확정 검색어");
  ui.requests[0].resolve(response("확정 검색어", [
    { keyword: "큰 값", volume: 300, pcVolume: 100, mobileVolume: 200, competition: "중간", category: storedCategory },
    { keyword: "작은 값", volume: 100, pcVolume: 50, mobileVolume: 50, competition: "중간", category: storedCategory },
    { keyword: "필터 제외", volume: 1, competition: "낮음", category: categories.unknown }
  ]));
  await task;
  ui.nodes.input.value = "아직 실행하지 않은 입력어";
  ui.nodes.competition.value = "중간";
  ui.nodes.competition.listeners.change();
  ui.controller.setSort("volume");
  assert.equal(await ui.controller.exportXlsx(), true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].keyword, "확정 검색어");
  assert.equal(payloads[0].queriedAt, storedCheckedAt);
  assert.equal(payloads[0].competition, "중간");
  assert.match(payloads[0].sortLabel, /오름차순/u);
  assert.deepEqual(Array.from(payloads[0].mainRows, (row) => row[1]), ["작은 값", "큰 값"]);
  assert.equal(Object.hasOwn(payloads[0], "categoryRows"), false);
  assert.equal(ui.blobs.length, 1);
  assert.equal(ui.blobs[0].type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.deepEqual(new Uint8Array(await ui.blobs[0].arrayBuffer()), bytes);
  const link = ui.document.created.find((node) => node.tagName === "a");
  assert.ok(link.clicked);
  assert.match(link.download, /\.xlsx$/u);
  assert.doesNotMatch(link.download, /\.csv/iu);
  assert.equal(ui.revoked.length, 1);
  assert.equal(ui.requests.length, 1, "export does not send another API request");
});

test("a 51-row provided response retains exactly 50 actual rows and exports all or only the current filter in local sort order", async () => {
  const payloads = [];
  const bytes = new Uint8Array(22);
  bytes.set([0x50, 0x4b, 3, 4]);
  const ui = workbookFixture((data) => { payloads.push(data); return bytes; });
  const supplied = Array.from({ length: 51 }, (_, index) => ({ keyword: "연관어" + String(index).padStart(2, "0"), volume: 1000 + index, pcVolume: index, mobileVolume: 1000, competition: index % 2 ? "높음" : "중간", clicks: index, ctr: index / 100, category: storedCategory }));
  const task = ui.controller.search("확정 검색어");
  ui.requests[0].resolve(response("확정 검색어", supplied));
  await task;
  assert.match(ui.nodes.count.textContent, /전체 50개 · 표시 50개 · 최대 50개/u);
  ui.controller.setSort("volume");
  assert.equal(ui.controller.exportXlsx(), true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].mainRows.length, 50);
  assert.equal(Object.hasOwn(payloads[0], "categoryRows"), false);
  assert.deepEqual(Array.from(payloads[0].mainRows, (row) => row[1]), supplied.slice(0, 50).map((row) => row.keyword));
  for (const [index, actual] of payloads[0].mainRows.entries()) {
    assert.deepEqual(Array.from(actual).slice(0, 7), [index + 1, supplied[index].keyword, 1000 + index, index, 1000, supplied[index].competition, index]);
    assert.ok(Math.abs(actual[7] - index / 10000) < 1e-12, "all fifty CTR values retain their numeric percentage fractions");
  }
  ui.nodes.competition.value = "중간";
  ui.nodes.competition.listeners.change();
  assert.match(ui.nodes.count.textContent, /전체 50개 · 표시 25개 · 최대 50개/u);
  assert.equal(ui.controller.exportXlsx(), true);
  const expected = supplied.slice(0, 50).filter((row) => row.competition === "중간");
  assert.deepEqual(Array.from(payloads[1].mainRows, (row) => row[1]), expected.map((row) => row.keyword));
  assert.deepEqual(Array.from(payloads[1].mainRows, (row) => row[0]), expected.map((_, index) => index + 1));
  assert.equal(ui.requests.length, 1, "all fifty rows, sorting, filtering and both exports share the one explicit request");
});

test("failed workbook creation and stale account data never download a CSV fallback or claim success", async () => {
  const ui = workbookFixture(() => { throw new Error("fixture workbook error"); });
  const task = ui.controller.search("확정 검색어");
  ui.requests[0].resolve(response("확정 검색어", rows()));
  await task;
  assert.equal(await ui.controller.exportXlsx(), false);
  assert.equal(ui.blobs.length, 0);
  assert.equal(ui.document.created.some((node) => node.tagName === "a" && node.clicked), false);
  assert.match(ui.nodes.status.textContent, /엑셀 파일을 만들지 못했습니다/u);
  assert.equal(ui.nodes.status.classes.has("is-error"), true);
  ui.session("session-b");
  assert.equal(await ui.controller.exportXlsx(), false);
  assert.equal(ui.blobs.length, 0);
  assert.equal(ui.requests.length, 1);
});

test("new in-flight queries and late old responses cannot export stale workbook rows or stale query metadata", async () => {
  const payloads = [];
  const bytes = new Uint8Array(22);
  bytes.set([0x50, 0x4b, 3, 4]);
  const ui = workbookFixture((data) => { payloads.push(data); return bytes; });
  const initial = ui.controller.search("이전 검색어");
  ui.requests[0].resolve(response("이전 검색어", [{ keyword: "이전 연관어", category: storedCategory }]));
  await initial;
  const earlier = ui.controller.search("다음 검색어");
  assert.equal(ui.controller.exportXlsx(), false);
  assert.equal(payloads.length, 0);
  const latest = ui.controller.search("최신 검색어");
  ui.requests[2].resolve(response("최신 검색어", [{ keyword: "최신 연관어", category: storedCategory }], { checkedAt: "2026-10-19T06:00:00.000Z" }));
  await latest;
  ui.requests[1].resolve(response("다음 검색어", [{ keyword: "늦은 과거 연관어", category: storedCategory }]));
  await earlier;
  assert.equal(ui.controller.exportXlsx(), true);
  assert.equal(payloads[0].keyword, "최신 검색어");
  assert.equal(payloads[0].queriedAt, "2026-10-19T06:00:00.000Z");
  assert.deepEqual(Array.from(payloads[0].mainRows, (row) => row[1]), ["최신 연관어"]);
  assert.equal(ui.requests.length, 3);
});

test("non-ZIP output is rejected rather than downloaded with an XLSX filename or CSV fallback", async () => {
  const ui = workbookFixture(() => new TextEncoder().encode("keyword,volume\r\nrenamed-csv,0\r\n"));
  const task = ui.controller.search("확정 검색어");
  ui.requests[0].resolve(response("확정 검색어", rows()));
  await task;
  assert.equal(ui.controller.exportXlsx(), false);
  assert.equal(ui.blobs.length, 0);
  assert.equal(ui.document.created.some((node) => node.tagName === "a" && node.clicked), false);
  assert.match(ui.nodes.status.textContent, /엑셀 파일을 만들지 못했습니다/u);
  assert.equal(ui.requests.length, 1);
});
