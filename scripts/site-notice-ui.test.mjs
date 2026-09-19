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
    // 2026-09-19 디자인 개편: 표식이 카드 폭으로 늘어나 닫기와 겹치던 구성을 머리·본문·바닥 세 구역으로 나눴다.
    for (const zone of ["mi-site-notice-head", "mi-site-notice-main", "mi-site-notice-foot", "mi-site-notice-tag"]) assert.ok(render.includes(zone), `${relative} ${zone}`);
    assert.doesNotMatch(render, /mi-kicker|is-ghost/u, relative);
    assert.match(source, /\.mi-site-notice-head \{ display: flex; align-items: center; justify-content: space-between;/u, relative);
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

// 대표 지시 2026-09-19: 저장만 있고 내리기·사용법·복붙 문구가 없었다. 운영자 화면은 되돌리기·사용 방법·템플릿을 함께 갖는다.
test("the owner editor can take the popup down, explains how to publish, and offers one-click templates", () => {
  assert.match(adminSource, /<button class="mi-button is-ghost mi-site-notice-clear" type="button" data-site-notice-clear>팝업 내리기<\/button>/u);
  const clear = namedFunctionSource(adminSource, "clearSiteNotice");
  assert.match(clear, /secureSession\.role !== "owner"\) throw/u);
  assert.match(clear, /JSON\.stringify\(\{ action: "clear" \}\)/u);
  assert.match(clear, /closeSiteNotice\(\);/u);
  assert.match(adminSource, /window\.confirm\("지금 떠 있는 공지 팝업을 내립니다\./u);
  for (const step of ["올리기", "확인하기", "고치기", "내리기", "자동 종료"]) assert.ok(adminSource.includes(`<li><strong>${step}</strong>`), step);
  assert.ok(adminSource.includes("<h2>사용 방법</h2>"));
  // 대표 질문(2026-09-19): "공지할 때마다 Supabase 배포가 필요한가" → 화면이 먼저 답한다.
  assert.ok(adminSource.includes("<strong>저장이 곧 배포입니다.</strong>"));
  assert.ok(adminSource.includes("SQL 실행이나 배포 작업은 필요 없습니다."));
  assert.ok(adminSource.includes("data-site-notice-templates"));
  for (const label of ["점검 안내", "점검 완료", "업데이트 안내", "장애 안내"]) assert.ok(adminSource.includes(`label: "${label}"`), label);
  const apply = namedFunctionSource(adminSource, "applySiteNoticeTemplate");
  assert.match(apply, /replace\("\{종료일\}", siteNoticeKoreanDate\(endDate\)\)/u);
  assert.match(apply, /저장을 눌러야 반영됩니다/u);
  assert.doesNotMatch(apply, /miFetch/u, "템플릿은 입력란만 채우고 저장하지 않는다");
  assert.equal(clientSource.includes("data-site-notice-clear"), false);
  assert.equal(clientSource.includes("SITE_NOTICE_TEMPLATES"), false);
});
