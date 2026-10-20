import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync("public/mi-public-related-keywords.js", "utf8");
const origin = "https://insight.momentlabs.co.kr";
const pathname = "/api/public/related-keywords";
function load(overrides = {}) {
  const window = { location: { origin }, ...overrides };
  vm.runInNewContext(source, { window, URL, Promise });
  return { window, api: window.MomentPublicRelatedKeywords };
}
function fixture(overrides = {}) {
  const attributes = new Map(), requests = [], mounted = [];
  const status = { textContent: "" }, selection = { textContent: "" }, notice = { hidden: true };
  const login = { focused: false, focus() { this.focused = true; } };
  const form = { listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } };
  const host = { querySelector: (selector) => ({ "[data-related-query-status]": status, "[data-related-query-form]": form })[selector] || null };
  const root = {
    querySelector: (selector) => ({ "[data-related-query]": host, "[data-public-related-login]": notice, "[data-public-related-selection]": selection, "[data-public-related-cta]": login })[selector] || null,
    getAttribute: (name) => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value)
  };
  const document = { readyState: "complete", getElementById: (id) => id === "mi-public-related" ? root : null };
  const controller = { name: "fixture controller" };
  const loaded = load({ document, fetch: async (...args) => { requests.push(args); return { ok: true }; }, MomentRelatedKeywords: { mount: (node, options) => { mounted.push({ node, options }); return controller; } }, ...overrides });
  return { ...loaded, attributes, requests, mounted, root, host, form, status, selection, notice, login, controller };
}

test("public bootstrap is idle, mounts exactly once and uses only the isolated public root", () => {
  const ui = fixture();
  assert.equal(ui.requests.length, 0, "opening the page never automatically queries or checks a session");
  assert.equal(ui.mounted.length, 1);
  assert.equal(ui.mounted[0].node, ui.host);
  assert.equal(ui.mounted[0].options.apiUrl, pathname);
  assert.equal(ui.mounted[0].options.sessionKey(), "public-related");
  assert.equal(ui.attributes.get("data-public-related-mounted"), "true");
  assert.equal(ui.api.bootstrap(), null);
  assert.equal(ui.mounted.length, 1, "a second initialization cannot double-bind query events");
  const ids = [], mounts = [];
  load({ document: { readyState: "complete", getElementById: (id) => { ids.push(id); return id === "mi-clean" ? {} : null; } }, fetch: () => assert.fail("no public root, no fetch"), MomentRelatedKeywords: { mount: (...args) => mounts.push(args) } });
  assert.deepEqual(ids, ["mi-public-related"]);
  assert.equal(mounts.length, 0, "the public bridge never mounts the private client application");
});

test("public requests omit credentials and headers, preserve cancellation and never retry", async () => {
  const calls = [];
  const response = { ok: true, status: 200 };
  const bridge = load().api.createPublicFetch(async (...args) => { calls.push(args); return response; }, origin);
  const controller = new AbortController();
  const result = await bridge(pathname + "?mode=related&keyword=" + encodeURIComponent("온열 찜질기"), { method: "GET", credentials: "include", headers: { authorization: "must-not-forward", "x-mi-session": "must-not-forward" }, signal: controller.signal });
  assert.equal(result, response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], pathname + "?mode=related&keyword=" + encodeURIComponent("온열 찜질기"));
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["cache", "credentials", "method", "redirect", "signal"]);
  assert.equal(calls[0][1].credentials, "omit");
  assert.equal(calls[0][1].redirect, "error", "a redirect cannot silently turn a public request into a private request");
  assert.equal(calls[0][1].signal, controller.signal);
  const failure = load().api.createPublicFetch(async () => { calls.push("failure"); throw new Error("fixture network failure"); }, origin);
  await assert.rejects(failure(pathname), /fixture network failure/u);
  assert.equal(calls.filter((value) => value === "failure").length, 1);
});

test("the public fetch adapter rejects private APIs, cross-origin targets, fragments, embedded credentials and writes", async () => {
  let calls = 0;
  const fetcher = load().api.createPublicFetch(async () => { calls += 1; }, origin);
  for (const url of ["/api/session", "/api/client/keyword-research?mode=related", "/api/client/naver-rank-trackers", "https://example.invalid" + pathname, "//example.invalid" + pathname, "https://user:secret@insight.momentlabs.co.kr" + pathname, pathname + "#fragment"]) await assert.rejects(fetcher(url), /public_related_path_invalid/u);
  await assert.rejects(fetcher(pathname, { method: "POST" }), /public_related_path_invalid/u);
  assert.equal(calls, 0);
});

test("analysis is only a local login notice with literal keyword text, no navigation or private query", () => {
  const ui = fixture();
  const options = ui.mounted[0].options;
  assert.equal(options.analyze('<img src=x onerror="alert(1)">'), true);
  assert.equal(ui.selection.textContent, '선택 키워드 · <img src=x onerror="alert(1)">');
  assert.equal(ui.notice.hidden, false);
  assert.equal(ui.login.focused, true);
  assert.equal(ui.requests.length, 0);
  options.onReset();
  assert.equal(ui.notice.hidden, true);
  assert.equal(ui.selection.textContent, "");
  options.analyze("이전 선택어");
  ui.form.listeners.submit();
  assert.equal(ui.notice.hidden, true, "a new explicit query clears the previous login handoff notice");
  assert.equal(ui.selection.textContent, "");
});

test("copy resolves only from the actual clipboard promise and denial is not disguised as success", async () => {
  const writes = [];
  const ui = fixture({ navigator: { clipboard: { writeText: async (value) => { writes.push(value); return "native promise result"; } } } });
  assert.equal(await ui.mounted[0].options.copy("허리찜질기"), "native promise result");
  assert.deepEqual(writes, ["허리찜질기"]);
  const missing = fixture();
  await assert.rejects(missing.mounted[0].options.copy("허리찜질기"), /clipboard_unavailable/u);
  const denied = fixture({ navigator: { clipboard: { writeText: async () => { throw new Error("fixture denial"); } } } });
  await assert.rejects(denied.mounted[0].options.copy("허리찜질기"), /fixture denial/u);
});

test("429 has a fixed public limit notice without leaking response messages or changing default errors", () => {
  const api = load().api;
  const limited = api.errorMessage({ status: 429, message: "private provider detail", payload: { secret: "never display" } });
  assert.match(limited, /IP별 1분 5회·1시간 30회/u);
  assert.doesNotMatch(limited, /private|provider|secret|never display/u);
  assert.equal(api.errorMessage({ status: 503 }), "");
  assert.equal(api.errorMessage({ name: "AbortError" }), "");
});

test("public page reuses the same 50-row, eight-column and single-XLSX interface without private scripts or inline code", () => {
  const html = fs.readFileSync("public/related-keywords.html", "utf8");
  assert.match(html, /<body id="mi-public-related">/u);
  assert.doesNotMatch(html, /id="mi-admin"|id="mi-clean"|data-related-query-handoff|data-rank-|data-mi-login-code/u);
  assert.equal((html.match(/\sdata-related-query(?:\s|>)/gu) || []).length, 1);
  assert.equal((html.match(/<th\b/gu) || []).length, 8);
  assert.equal((html.match(/data-related-query-sort-key=/gu) || []).length, 6);
  assert.match(html, /조회 전 · 최대 50개/u);
  assert.match(html, /엑셀 다운로드/u);
  assert.match(html, /IP별 1분 5회 \/ 1시간 30회/u);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)];
  assert.equal(scripts.length, 3);
  assert.ok(scripts.every((match) => /\bsrc="\//u.test(match[1]) && /\bdefer\b/u.test(match[1]) && match[2].trim() === ""));
  assert.ok(html.indexOf("/mi-related-keywords-xlsx.js") < html.indexOf('src="/mi-related-keywords.js'));
  assert.ok(html.indexOf('src="/mi-related-keywords.js') < html.indexOf("/mi-public-related-keywords.js"));
  assert.doesNotMatch(html, /onclick=|onerror=|javascript:|src="https?:|<iframe\b|mi-capture\.js|mi-coupang-rank\.js/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|\/api\/session|\/api\/client\/|createVerifiedFetch|navigateKeyword|MutationObserver/u);
});

test("public styling adds only its ID scope and shell, preserving every existing private visual declaration", () => {
  const css = fs.readFileSync("public/mi-related-keywords.css", "utf8");
  const previous = execFileSync("git", ["show", "HEAD:public/mi-related-keywords.css"], { encoding: "utf8" });
  const boundary = css.indexOf("/* Public related-query shell only;");
  assert.ok(boundary > 0);
  assert.equal(css.slice(0, boundary).trimEnd().replaceAll(":is(#mi-admin,#mi-clean,#mi-public-related)", ":is(#mi-admin,#mi-clean)"), previous.trimEnd());
  const newRules = css.slice(boundary).split("\n").map((line) => line.trim()).filter((line) => line.includes("{") && !line.startsWith("@") && !line.startsWith("/*"));
  assert.ok(newRules.every((rule) => rule.startsWith("#mi-public-related")));
});

test("home and login entry links do not change existing inline applications, CSP hashes or the private related view", () => {
  const inline = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)].filter((match) => !/\bsrc\s*=/iu.test(match[1])).map((match) => createHash("sha256").update(match[2]).digest("hex"));
  for (const page of ["home", "client"]) {
    const current = fs.readFileSync(`src/pages/${page}.html`, "utf8");
    const previous = execFileSync("git", ["show", `HEAD:src/pages/${page}.html`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.deepEqual(inline(current), inline(previous), `${page}: all pre-existing inline bytes and CSP hashes are unchanged`);
    assert.match(current, /href="\/related-keywords\.html"/u);
    if (page === "client") {
      const privateView = (html) => html.match(/<section\b[^>]*data-related-query(?:\s|>)[\s\S]*?<\/section>/u)?.[0];
      assert.ok(privateView(previous));
      assert.equal(privateView(current), privateView(previous));
      assert.match(current, /로그인 없이 연관 키워드 조회/u);
    }
  }
});
