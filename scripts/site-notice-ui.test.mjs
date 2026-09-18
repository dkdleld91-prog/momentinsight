import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 운영 공지 팝업(대표 결정 2026-09-18): 광고주·관리자 화면에 같은 팝업이 있고, 편집 화면은 관리자(총관리자 전용)에만 있다.
const pageEntries = ["src/pages/client.html", "src/pages/admin.html"]
  .map((relative) => [relative, fs.readFileSync(path.join(process.cwd(), relative), "utf8")]);
const adminSource = pageEntries.find((entry) => entry[0] === "src/pages/admin.html")[1];
const clientSource = pageEntries.find((entry) => entry[0] === "src/pages/client.html")[1];

function namedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

test("both pages fetch the notice once after the session is applied and honour hide-for-today", () => {
  for (const [relative, source] of pageEntries) {
    const show = namedFunctionSource(source, "maybeShowSiteNotice");
    assert.match(show, /is-authed/u, relative);
    assert.match(show, /miFetch\(getSiteNoticeApiUrl\(\), \{ cache: "no-store" \}\)/u, relative);
    assert.match(show, /siteNoticeHiddenToday\(notice\)/u, relative);
    assert.match(show, /siteNoticeShownKey === key/u, relative);
    assert.match(namedFunctionSource(source, "getSiteNoticeApiUrl"), /\/api\/site-notice/u, relative);
    assert.match(namedFunctionSource(source, "siteNoticeHideKey"), /miSiteNoticeHide:/u, relative);
    const render = namedFunctionSource(source, "renderSiteNotice");
    assert.match(render, /data-site-notice-hide/u, relative);
    assert.match(render, /오늘 하루 보지 않기/u, relative);
    assert.match(render, /textContent = notice\.body/u, relative);
    assert.doesNotMatch(render, /innerHTML/u, relative);
    assert.match(source, /\.mi-site-notice-modal\.is-open \{ display: flex; \}/u, relative);
    assert.match(source, /root\.classList\.add\("is-authed"\);[\s\S]{0,200}maybeShowSiteNotice\(\);/u, relative);
  }
});

test("the client page has no editor and the admin page keeps the editor owner-only", () => {
  assert.equal(clientSource.includes("data-site-notice-editor"), false);
  assert.equal(clientSource.includes("loadSiteNoticeEditor"), false);
  assert.match(adminSource, /<a href="#mi-admin-site-notice" data-mi-admin-screen="site-notice" data-owner-only>운영 공지<\/a>/u);
  assert.match(adminSource, /<section class="mi-view" data-mi-admin-view="site-notice" id="mi-admin-site-notice">/u);
  for (const marker of ["data-site-notice-title", "data-site-notice-body", "data-site-notice-start", "data-site-notice-end", "data-site-notice-enabled", "data-site-notice-save", "data-site-notice-preview", "data-site-notice-status"]) {
    assert.ok(adminSource.includes(marker), marker);
  }
  assert.match(adminSource, /var rejectedNoticeTarget = target === "site-notice" && secureSession\.role !== "owner";/u);
  assert.match(adminSource, /if \(rejectedNoticeTarget\) target = "home";/u);
  assert.match(adminSource, /if \(target === "site-notice" && secureSession\.role === "owner"\) loadSiteNoticeEditor\(\);/u);
  const load = namedFunctionSource(adminSource, "loadSiteNoticeEditor");
  assert.match(load, /secureSession\.role !== "owner"\) return;/u);
  const save = namedFunctionSource(adminSource, "saveSiteNotice");
  assert.match(save, /method: "POST"/u);
  assert.match(save, /"content-type": "application\/json"/u);
  assert.match(namedFunctionSource(adminSource, "readSiteNoticeForm"), /action: "save"/u);
});
