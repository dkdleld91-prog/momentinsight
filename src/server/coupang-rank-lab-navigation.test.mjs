// C 30일 순위 메뉴 자리만 본다. 앱·수집기·DB 는 띄우지 않는다.
// 대표 결정 2026-10-23: C 30일 순위는 '실험실 · 개발 중'에서 빠져 '순위 조회·추적'의 N 플레이스 30일 순위 다음에 있고,
// '(개발중)' 표시가 없으며, 총관리자에게만 보인다(운영팀·광고주 없음).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (page) => fs.readFileSync(`src/pages/${page}.html`, "utf8").replace(/\r\n/g, "\n");
const anchors = (html) => [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gu)].map((match) => match[0]);
const c30Links = (html) => anchors(html).filter((anchor) => /\bdata-coupang-rank-nav(?:\s|>)/u.test(anchor));
const rankGroup = (html) => html.match(/<div class="mi-nav-group">\s*<p class="mi-nav-title">순위 조회·추적<\/p>([\s\S]*?)<\/div>/u)?.[1] || "";
const labItems = (html, page) => html.match(new RegExp(`<div class="mi-nav-lab-items" id="mi-${page}-nav-lab">([\\s\\S]*?)<\\/div>`, "u"))?.[1] || "";
const screenOf = (anchor) => anchor.match(/data-mi-(?:admin-)?screen="([^"]+)"/u)?.[1] || "";

const N30_LINK = '<a href="#mi-admin-naver-rank-tracking" data-mi-admin-screen="naver-rank-tracking">N 30일 순위</a>';
const P30_LINK = '<a href="#mi-admin-naver-place-rank-tracking" data-mi-admin-screen="naver-place-rank-tracking">N 플레이스 30일 순위</a>';
const C30_LINK = '<a href="#mi-admin-coupang-rank-tracking" data-mi-admin-screen="coupang-rank-tracking" data-coupang-rank-nav hidden>C 30일 순위</a>';

test("C30 은 '순위 조회·추적' 묶음의 N 플레이스 30일 순위 바로 다음에 하나만 있고 개발중 표시가 없다", () => {
  const html = read("admin");
  assert.deepEqual(c30Links(html), [C30_LINK], "C30 메뉴는 하나뿐이다");
  assert.deepEqual(anchors(rankGroup(html)), [N30_LINK, P30_LINK, C30_LINK], "N30·P30 순서는 그대로, C30 은 맨 뒤");
  assert.doesNotMatch(C30_LINK, /개발중|<small>/u);
  // 세션 확인 전에는 숨겨 두고(총관리자만 연결 코드가 연다), 화면 주소는 그대로다.
  assert.match(C30_LINK, /\shidden>/u);
  assert.match(C30_LINK, /href="#mi-admin-coupang-rank-tracking"/u);
  assert.match(C30_LINK, /data-mi-admin-screen="coupang-rank-tracking"/u);
  // #mi-admin .mi-nav a 는 display:flex 라 [hidden] 규칙이 있어야 실제로 숨는다.
  assert.ok(html.includes("#mi-admin .mi-nav a[hidden]"));
});

test("실험실 · 개발 중 묶음에서 C30 만 빠지고 나머지 항목·접힘은 그대로다", () => {
  const html = read("admin");
  const lab = labItems(html, "admin");
  assert.ok(lab, "실험실 묶음은 남는다");
  assert.doesNotMatch(lab, /coupang-rank-tracking|data-coupang-rank-nav/u);
  assert.deepEqual(anchors(lab).map(screenOf), ["seo-check", "meta-ads", "excel", "reports", "publish"]);
  assert.match(html, /class="mi-nav-group mi-nav-lab" data-mi-nav-lab/u);
  assert.match(html, /data-mi-nav-lab-toggle aria-expanded="false" aria-controls="mi-admin-nav-lab">실험실 · 개발 중/u, "실험실은 기본으로 접혀 있다");
});

test("광고주 화면(client.html)에는 C30 메뉴·화면·모듈이 없다", () => {
  const html = read("client");
  assert.equal(c30Links(html).length, 0);
  assert.doesNotMatch(html, /coupang-rank-tracking|data-coupang-rank-root|MomentCoupangRank|\/mi-coupang-rank\.js/u);
  assert.doesNotMatch(rankGroup(html), /coupang/u);
  assert.doesNotMatch(labItems(html, "client"), /coupang/u);
});
