import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync("public/mi-public-related-keywords.js", "utf8");
const origin = "https://insight.momentlabs.co.kr";
const pathname = "/api/public/related-keywords";
// Frozen from the pre-public Production release b5c02f73bd08cfeebc0fe537b3f73b18c88e21da.
// HEAD changes after commit, and a deployment checkout need not contain its history.
const privateBaseline = Object.freeze({
  css: "0a65adfc3365e0cc66f75a1060e3f043c505148294c3f2c6672890aba0defcfb",
  homeInline: ["99105621d423b52d0eee5e32459f4f11f567839e14452d3cde36d1f18a894f20", "f2fee52f1d35d9d62b113931d72a2062d374fbad946271a76fa0f702a6602039"],
  // 2026-10-23 N30 그룹상품(대표 승인): 광고주 카드에 '그룹상품 n개'·잡힌 옵션 줄·현재 알약 ' · 옵션' 표시를 더해
  // 인라인 스크립트가 바뀌었다(반박 검토 반영 포함). 이전 값 b6f74a7cf4a262b80453d38783bdab2b8531af0ba1fc310ae1234a49823e60bd.
  // vercel.json CSP 해시도 같이 바뀐다. 3차 수정(D2 예외: 관리자 안내 문구 분기 — 광고주 화면에는 안 보임)으로
  // 다시 바뀌었다. 2차 값 50974bea9b316ebf32364f9107e519e5840e28bf5e69b811de764a9b5769115a.
  // 4차 수정(스토어 확인 단순 규칙: 광고주 메시지에서 관리자용 꼬리 빼기·관리자 안내 문구)으로 또 바뀌었다.
  // 3차 값 2014316a30fa71ee220b78f3c5a3dafb2436719a953e4b2b065514623e07fd8c.
  // 5차 수정(규칙 C'·E': 관리자 안내 문구·'다른 스토어로 보여 뺀 번호' 줄에 번호 — 광고주 화면에는 안 보임)으로 또
  // 바뀌었다. 4차 값 ce8c478877e5c80da84422729d4dbcdfd634e877ce8fd935f5339144cd7f79dc.
  // 2026-10-27 N30 그룹상품 후보(대표 승인 A안): 두 화면 공통 카드 함수(rankTrackerOptionState·renderRankOptionOpsPills)에
  // 관리자 전용 상태 알약이 더해져 바뀌었다(광고주 화면 출력은 바이트 동일 — 화면 시험 U10). 5차 값
  // 20c86c95a026a1cd46329d6e3e8c3e8c71cda0d9d1a03d6f3eed3e3fb17a5870.
  clientInline: ["8d81d268f49b511aad2604a660ad7ca5447b238b4c27a29b9b50d3ed9d543781"],
  clientRelatedView: "5091beda36875524aab52f97eeac425fe7bc60530eb84b572983974e31f89822",
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
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
  const boundary = css.indexOf("/* Public related-query shell only;");
  assert.ok(boundary > 0);
  const restoredPrivateCss = css.slice(0, boundary).trimEnd().replaceAll(":is(#mi-admin,#mi-clean,#mi-public-related)", ":is(#mi-admin,#mi-clean)");
  assert.equal(sha256(restoredPrivateCss), privateBaseline.css);
  const newRules = css.slice(boundary).split("\n").map((line) => line.trim()).filter((line) => line.includes("{") && !line.startsWith("@") && !line.startsWith("/*"));
  assert.ok(newRules.every((rule) => rule.startsWith("#mi-public-related")));
});

test("home keeps only login and signup actions while the client public entry and private views remain unchanged", () => {
  const inline = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)].filter((match) => !/\bsrc\s*=/iu.test(match[1])).map((match) => createHash("sha256").update(match[2]).digest("hex"));
  for (const page of ["home", "client"]) {
    const current = fs.readFileSync(`src/pages/${page}.html`, "utf8");
    assert.deepEqual(inline(current), privateBaseline[page + "Inline"], `${page}: all pre-existing inline bytes and CSP hashes are unchanged`);
    if (page === "home") {
      const header = current.match(/<header class="mi-topbar">[\s\S]*?<\/header>/u)?.[0];
      assert.ok(header);
      assert.doesNotMatch(header, /related-keywords/u, "the homepage header must not expose a related-keyword action");
      const actions = header.match(/<div class="mi-actions">([\s\S]*?)<\/div>/u)?.[1];
      assert.ok(actions);
      assert.deepEqual([...actions.matchAll(/\bhref="([^"]+)"/gu)].map((match) => match[1]), ["/client", "/client?signup=1"]);
    }
    if (page === "client") {
      assert.match(current, /href="\/related-keywords\.html"/u);
      const privateView = (html) => html.match(/<section\b[^>]*data-related-query(?:\s|>)[\s\S]*?<\/section>/u)?.[0];
      assert.ok(privateView(current));
      assert.equal(sha256(privateView(current)), privateBaseline.clientRelatedView);
      assert.match(current, /로그인 없이 연관 키워드 조회/u);
    }
  }
});
