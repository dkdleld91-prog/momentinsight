// 구글 로그인 연동 안내 팝업(public/mi-google-nudge.js) 계약 테스트.
//
// 네 가지를 증명한다.
//  1) 대표님이 결재한 문구와 강조(기한 하이라이트·안내 pill)가 실제로 그려진다 —
//     문자열 추측이 아니라 가짜 DOM 에 렌더링해서 노드를 읽는다.
//  2) 연결된 계정에게는 열리지 않고, 해제 키는 계정마다 나뉜다.
//  3) 공유 스크립트와 페이지 글루의 "실행 순서"가 어느 쪽이든 정확히 한 번 뜬다 —
//     2026-08-26 운영 검증에서 팝업이 뜨지 않은 회귀의 재현·방지 테스트다.
//  4) admin.html · client.html 이 로그인 착지 지점에서 부르고, 마크업 리터럴이
//     페이지 인라인 스크립트로 새어 나가지 않으며, CSP 해시가 따라왔다.
//
// 네트워크·환경변수·브라우저 없이 돌아간다.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sharedSource = fs.readFileSync(new URL("../public/mi-google-nudge.js", import.meta.url), "utf8");
const adminSource = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");
const clientSource = fs.readFileSync(new URL("../src/pages/client.html", import.meta.url), "utf8");
const vercelConfig = fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const SCRIPT_TAG = '<script src="/mi-google-nudge.js?v=gnudge-v2-20260826"></script>';
const ROOT_ATTRIBUTE = "data-mi-google-nudge";

const LINKED_PAYLOAD = { ok: true, configured: true, storageReady: true, linked: true, googleEmail: "a@b.c" };
const UNLINKED_PAYLOAD = { ok: true, configured: true, storageReady: true, linked: false, googleEmail: null };

// ── 최소 DOM ─────────────────────────────────────────────────
// 실제 브라우저 대신 노드 트리만 흉내 낸다. 렌더 경로가 던지면 여기서 그대로 터지므로,
// "조용히 아무 것도 안 하는" 실패가 테스트를 통과할 수 없다.
function createDom() {
  const listeners = {};
  let activeElement = null;

  function makeNode(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      className: "",
      id: "",
      type: "",
      textContent: "",
      disabled: false,
      parentNode: null,
      listeners: {},
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter((node) => node !== child); child.parentNode = null; return child; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry !== fn); },
      focus() { activeElement = this; },
      click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); },
    };
  }

  const head = makeNode("head");
  const body = makeNode("body");

  function walk(node, out = []) {
    out.push(node);
    (node.children || []).forEach((child) => walk(child, out));
    return out;
  }

  const document = {
    head,
    body,
    createElement: makeNode,
    createTextNode(text) { return { tagName: "#text", children: [], attrs: {}, textContent: String(text) }; },
    getElementById(id) { return walk(head).concat(walk(body)).find((node) => node.id === id) || null; },
    querySelector(selector) {
      const attribute = /^\[([^\]=]+)\]$/.exec(selector);
      const all = walk(head).concat(walk(body));
      if (attribute) return all.find((node) => node.attrs && Object.prototype.hasOwnProperty.call(node.attrs, attribute[1])) || null;
      const className = /^\.([a-z0-9-]+)$/i.exec(selector);
      if (className) return all.find((node) => String(node.className).split(/\s+/).includes(className[1])) || null;
      return null;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((entry) => entry !== fn); },
    get activeElement() { return activeElement; },
    set activeElement(node) { activeElement = node; },
  };

  return {
    document,
    nodes: () => walk(body),
    // 노드 트리를 사람이 읽는 텍스트로 되돌린다 — <br> 는 줄바꿈으로 본다.
    text(node) {
      if (!node) return "";
      if (node.tagName === "#text") return node.textContent;
      if (node.tagName === "BR") return "\n";
      if (!node.children.length) return node.textContent;
      return node.children.map((child) => this.text(child)).join("");
    },
    findByClass(name) { return walk(body).filter((node) => String(node.className).split(/\s+/).includes(name)); },
    fireDocument(type, event) { (listeners[type] || []).forEach((fn) => fn(event)); },
  };
}

// 공유 스크립트를 하나의 realm 에 올린다. queue 를 미리 넣어 두면 "글루가 먼저 돈"
// 상황을, 넣지 않으면 "스크립트가 먼저 온" 상황을 그대로 재현한다.
function createRealm({ preloadQueue = null, session = new Map(), payload = UNLINKED_PAYLOAD, failFetch = false } = {}) {
  const dom = createDom();
  const calls = [];
  const window = {
    location: { hostname: "insight.momentlabs.co.kr", origin: "https://insight.momentlabs.co.kr", href: "" },
    sessionStorage: {
      getItem(key) { return session.has(key) ? session.get(key) : null; },
      setItem(key, value) { session.set(key, String(value)); },
    },
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  if (preloadQueue) window.MomentGoogleNudgeQueue = preloadQueue;

  const miFetch = async (url, options) => {
    calls.push({ url, method: (options && options.method) || "GET", body: options && options.body });
    if (failFetch) throw new Error("network down");
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };

  function load() {
    vm.runInNewContext(sharedSource, { window, document: dom.document, setTimeout, clearTimeout, console });
  }

  // 페이지 글루와 똑같은 모양의 호출. admin.html · client.html 에서 옮겨 적었다.
  function glue(role, accountTag) {
    const queue = window.MomentGoogleNudgeQueue || (window.MomentGoogleNudgeQueue = []);
    queue.push({ apiBase: "/api/my", fetch: miFetch, role, accountTag });
    if (window.MomentGoogleNudge && typeof window.MomentGoogleNudge.drain === "function") window.MomentGoogleNudge.drain();
  }

  // 렌더 경로는 rAF → setTimeout → fetch(마이크로태스크) 순서로 이어진다. 벽시계
  // 시간에 기대면 부하가 걸린 전체 실행에서 흔들리므로, 태스크 큐를 여러 번 비운다.
  const settle = async (turns = 30) => {
    for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { dom, window, calls, load, glue, settle, session };
}

function inlineScripts(html) {
  const scripts = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(match[1] || "")) continue;
    scripts.push(match[2] || "");
  }
  return scripts;
}

function functionBlock(source, header) {
  const from = source.indexOf(header);
  assert.ok(from >= 0, `함수를 찾지 못했습니다: ${header}`);
  const to = source.indexOf("\n      }", from);
  assert.ok(to > from, `함수의 끝을 찾지 못했습니다: ${header}`);
  return source.slice(from, to);
}

// ── 1. 문구와 강조 ───────────────────────────────────────────

test("대표 결재 문구가 그려진 노드에서 그대로 읽힌다", async () => {
  const realm = createRealm();
  realm.load();
  realm.glue("team", "team-01");
  await realm.settle();

  const [title] = realm.dom.findByClass("mi-google-nudge-title");
  const [body] = realm.dom.findByClass("mi-google-nudge-body");
  assert.equal(title.textContent, "로그인 방식이 구글 계정 연동으로 바뀝니다");
  assert.equal(
    realm.dom.text(body),
    "모먼트 인사이트가 더 안전하고 간편한 구글 계정 로그인으로 전환됩니다.\n30일 이내에 구글 계정을 연결해 주세요 — 연결 후에는 코드 입력 없이 바로 로그인할 수 있습니다.",
  );
  const [primary] = realm.dom.findByClass("mi-google-nudge-primary");
  const [secondary] = realm.dom.findByClass("mi-google-nudge-secondary");
  assert.equal(primary.textContent, "구글 계정 연결");
  assert.equal(secondary.textContent, "나중에 하기");
  assert.equal(sharedSource.includes("innerHTML"), false, "마크업을 문자열로 조립하면 안 됩니다.");
});

test("기한 강조와 안내 pill 이 warn 토큰으로 붙는다", async () => {
  const realm = createRealm();
  realm.load();
  realm.glue("client", "client-02");
  await realm.settle();

  // 본문 안의 "30일 이내" 만 강조 노드로 떨어져 나온다 — 승인 문구 자체는 그대로다.
  const [deadline] = realm.dom.findByClass("mi-google-nudge-deadline");
  assert.ok(deadline, "기한 강조 노드가 없습니다.");
  assert.equal(deadline.tagName, "STRONG");
  assert.equal(deadline.textContent, "30일 이내");
  assert.equal(deadline.parentNode.className, "mi-google-nudge-body");

  const [pill] = realm.dom.findByClass("mi-google-nudge-pill");
  assert.ok(pill, "안내 pill 이 없습니다.");
  assert.equal(pill.textContent, "적용 안내 · 30일 이내 전환");
  // pill 은 제목 위에 있다.
  const card = pill.parentNode;
  assert.ok(card.children.indexOf(pill) < card.children.findIndex((node) => node.tagName === "H2"));

  // 색·굵기·모서리는 전부 토큰에서 온다.
  assert.ok(sharedSource.includes("font-weight:var(--mi-weight-black,900);"));
  assert.ok(sharedSource.includes("-deadline{padding:0 var(--mi-space-1,4px);background:var(--mi-warn-bg,#fff4e6);color:var(--mi-warn,#a75f16);"));
  assert.ok(sharedSource.includes("-pill{display:inline-block;margin:0 0 var(--mi-space-3,12px);padding:var(--mi-space-1,4px) var(--mi-space-3,12px);background:var(--mi-warn-bg,#fff4e6);color:var(--mi-warn,#a75f16);border-radius:var(--mi-radius-pill,999px);"));
});

// ── 2. 표시·숨김 판정 ────────────────────────────────────────

test("연결된 계정과 환경변수 미설정 계정에게는 열리지 않는다", async () => {
  const linked = createRealm({ payload: LINKED_PAYLOAD });
  linked.load();
  linked.glue("team", "team-01");
  await linked.settle();
  assert.equal(linked.dom.document.querySelector(`[${ROOT_ATTRIBUTE}]`), null);
  assert.equal(linked.window.MomentGoogleNudge.lastResult, "linked");

  const unset = createRealm({ payload: { ok: true, configured: false, storageReady: true, linked: false } });
  unset.load();
  unset.glue("team", "team-01");
  await unset.settle();
  assert.equal(unset.dom.document.querySelector(`[${ROOT_ATTRIBUTE}]`), null);
  assert.equal(unset.window.MomentGoogleNudge.lastResult, "not-configured");

  // 조회가 실패하면 조용히 넘긴다 — 착지 화면을 팝업이 대신 차지하지 않는다.
  const broken = createRealm({ failFetch: true });
  broken.load();
  broken.glue("team", "team-01");
  await broken.settle();
  assert.equal(broken.dom.document.querySelector(`[${ROOT_ATTRIBUTE}]`), null);
  assert.equal(broken.window.MomentGoogleNudge.lastResult, "failed");
});

test("조회는 /api/my/google-login 하나만 부르고 자체 fetch 를 쓰지 않는다", async () => {
  const realm = createRealm();
  realm.load();
  realm.glue("team", "team-01");
  await realm.settle();
  assert.deepEqual(realm.calls.map((entry) => `${entry.method} ${entry.url}`), [
    "GET https://insight.momentlabs.co.kr/api/my/google-login",
  ]);
  for (const forbidden of ["/api/owner/", "/api/admin/", "/api/auth/", '"/api/work-items"']) {
    assert.equal(sharedSource.includes(forbidden), false, `금지된 경로를 부릅니다: ${forbidden}`);
  }
  assert.equal(/[^A-Za-z_$.]fetch\s*\(/.test(sharedSource), false, "공유 스크립트는 자체 fetch 를 호출하면 안 됩니다.");
  assert.equal(sharedSource.includes("XMLHttpRequest"), false);
  assert.equal(sharedSource.includes("window.fetch"), false);
});

test("연결 버튼은 기존 배너와 같은 link-url 계약을 그대로 쓴다", async () => {
  const realm = createRealm({ payload: UNLINKED_PAYLOAD });
  realm.load();
  realm.glue("team", "team-01");
  await realm.settle();
  const [primary] = realm.dom.findByClass("mi-google-nudge-primary");
  primary.click();
  await realm.settle();
  const post = realm.calls.find((entry) => entry.method === "POST");
  assert.ok(post, "link-url 요청이 없습니다.");
  assert.equal(post.url, "https://insight.momentlabs.co.kr/api/my/google-login");
  assert.deepEqual(JSON.parse(post.body), { action: "link-url" });
});

// ── 3. 해제 키와 실행 순서 ───────────────────────────────────

test("해제 키는 계정마다 나뉘고 세션이 끝나면 사라진다", async () => {
  const realm = createRealm();
  realm.load();
  const api = realm.window.MomentGoogleNudge;
  assert.equal(api.dismissKey("team", "MML93-A01"), "mi-google-nudge-dismissed:team:mml93-a01");
  assert.notEqual(api.dismissKey("team", "abc"), api.dismissKey("client", "abc"));
  // 태그를 못 만들면 공용 키로 떨어지지 않고 아예 띄우지 않는다.
  assert.equal(api.dismissKey("team", ""), "");
  assert.equal(api.dismissKey("", "abc"), "");
  assert.equal(await api.maybeShow({ fetch() {}, role: "team", accountTag: "" }), false);
  assert.equal(api.lastResult, "no-account");
  // 다음 로그인에서 다시 떠야 하므로 localStorage 를 쓰지 않는다.
  assert.equal(sharedSource.includes("localStorage"), false);
});

test("닫으면 그 로그인 세션 동안만 사라지고, 이미 닫은 계정은 조회조차 하지 않는다", async () => {
  const session = new Map();
  const first = createRealm({ session });
  first.load();
  first.glue("team", "team-01");
  await first.settle();
  const [secondary] = first.dom.findByClass("mi-google-nudge-secondary");
  secondary.click();
  assert.equal(first.dom.document.querySelector(`[${ROOT_ATTRIBUTE}]`), null);
  assert.equal(session.get("mi-google-nudge-dismissed:team:team-01"), "1");

  // 같은 세션 저장소를 물려받은 다음 렌더는 조회조차 하지 않는다.
  const again = createRealm({ session });
  again.load();
  again.glue("team", "team-01");
  await again.settle();
  assert.equal(again.calls.length, 0);
  assert.equal(again.window.MomentGoogleNudge.lastResult, "already-dismissed");

  // 새 로그인 세션(빈 저장소)에서는 다시 뜬다.
  const fresh = createRealm();
  fresh.load();
  fresh.glue("team", "team-01");
  await fresh.settle();
  assert.ok(fresh.dom.document.querySelector(`[${ROOT_ATTRIBUTE}]`));
});

test("회귀: 페이지 글루가 공유 스크립트보다 먼저 돌아도 뜬다", async () => {
  // 2026-08-26 운영 검증에서 팝업이 뜨지 않은 경로. 예전 글루는 window.MomentGoogleNudge
  // 가 없으면 조용히 끝났고 다시 시도하지 않았다. 이제는 큐에 남고 로드 시점에 비워진다.
  const realm = createRealm({ preloadQueue: [] });
  realm.glue("team", "team-01");            // 스크립트가 아직 안 왔다
  assert.equal(realm.window.MomentGoogleNudge, undefined);
  assert.equal(realm.window.MomentGoogleNudgeQueue.length, 1);
  realm.load();                              // 늦게 도착한 외부 스크립트
  await realm.settle();
  assert.ok(realm.dom.document.querySelector(`[${ROOT_ATTRIBUTE}]`), "늦게 로드된 경우 팝업이 뜨지 않았습니다.");
  assert.equal(realm.window.MomentGoogleNudge.lastResult, "shown");
  assert.equal(realm.window.MomentGoogleNudgeQueue.length, 0);
});

test("회귀: 로그인과 세션 복원이 겹쳐 두 번 불려도 팝업은 하나뿐이다", async () => {
  const realm = createRealm();
  realm.load();
  realm.glue("team", "team-01");   // 코드 로그인
  realm.glue("team", "team-01");   // 세션 복원이 겹친 경우
  await realm.settle();
  assert.equal(realm.dom.findByClass("mi-google-nudge-card").length, 1);
  assert.equal(realm.calls.filter((entry) => entry.method === "GET").length, 1);
});

test("Esc 와 X 도 같은 해제 경로를 타고 포커스를 되돌린다", async () => {
  const realm = createRealm();
  realm.load();
  realm.glue("team", "team-01");
  await realm.settle();
  const [primary] = realm.dom.findByClass("mi-google-nudge-primary");
  assert.equal(realm.dom.document.activeElement, primary, "열릴 때 기본 버튼에 포커스가 가야 합니다.");
  realm.dom.fireDocument("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(realm.dom.document.querySelector(`[${ROOT_ATTRIBUTE}]`), null);
  assert.equal(realm.window.MomentGoogleNudge.lastResult, "dismissed");
  assert.ok(sharedSource.includes('if (event.key !== "Tab") return;'), "가벼운 포커스 트랩이 없습니다.");
  assert.ok(sharedSource.includes('card.setAttribute("aria-modal", "true");'));
});

test("인라인 핸들러가 없다 — CSP script-src-attr 'none' 을 지킨다", () => {
  assert.equal(/\son[a-z]+\s*=\s*["']/i.test(sharedSource), false, "인라인 핸들러가 남아 있습니다.");
  assert.equal(sharedSource.includes("javascript:"), false);
  assert.equal(sharedSource.includes("eval("), false);
});

// ── 4. 페이지 글루와 CSP ─────────────────────────────────────

test("두 페이지가 순서에 기대지 않는 큐 글루로 부른다", () => {
  for (const page of [adminSource, clientSource]) {
    assert.equal((page.match(/<script src="\/mi-google-nudge\.js/g) || []).length, 1);
    assert.ok(page.includes(SCRIPT_TAG));
    // 언제나 큐에 넣는다 — 공유 스크립트가 아직 없어도 요청이 사라지지 않는다.
    assert.ok(page.includes("var queue = window.MomentGoogleNudgeQueue || (window.MomentGoogleNudgeQueue = []);"));
    assert.ok(page.includes('if (window.MomentGoogleNudge && typeof window.MomentGoogleNudge.drain === "function") {'));
    assert.ok(page.includes("accountTag: googleNudgeAccountTag()"));
    assert.ok(page.includes('apiBase: "/api/my",'));
    // 옛 글루(있으면 부르고 없으면 조용히 끝나기)는 남아 있으면 안 된다.
    assert.equal(page.includes('typeof window.MomentGoogleNudge.maybeShow !== "function") return;'), false);
  }
  const activate = functionBlock(adminSource, "async function activateAdminSession(payload, restored, requestGeneration) {");
  assert.ok(activate.includes("maybeShowGoogleNudge();"));
  assert.equal((adminSource.match(/maybeShowGoogleNudge\(\);/g) || []).length, 1);
  assert.ok(adminSource.includes('return secureSession.teamId || secureSession.clientId || secureSession.scopeKey || "";'));
  // 광고주: 코드 로그인과 세션 복원 두 곳 모두.
  assert.equal((clientSource.match(/maybeShowGoogleNudge\(\);/g) || []).length, 2);
  assert.ok(clientSource.includes('return secureClientSession.clientId || secureClientSession.scopeKey || "";'));
});

test("팝업 마크업은 공유 스크립트 안에만 있다", () => {
  for (const page of [adminSource, clientSource]) {
    assert.equal(page.includes("mi-google-nudge-card"), false);
    assert.equal(page.includes(ROOT_ATTRIBUTE), false);
    assert.equal(page.includes("로그인 방식이 구글 계정 연동으로"), false);
  }
  // 화면 이름 리터럴이 인라인 스크립트로 들어가면 대표실 메뉴 회귀 테스트가 오탐한다.
  assert.equal(inlineScripts(adminSource)[0].includes('data-mi-admin-screen="my-calendar"'), false);
  // 색은 토큰에서만 온다 — 새 색·변형을 만들지 않는다.
  assert.equal(
    /#[0-9a-f]{6}/i.test(sharedSource.replace(/var\(--mi-[a-z0-9-]+,\s*#[0-9a-f]{3,6}\)/gi, "")),
    false,
    "토큰 밖의 색이 있습니다.",
  );
  assert.ok(sharedSource.includes("background:rgba(6,26,58,0.55);"));
  assert.ok(sharedSource.includes("border-radius:var(--mi-radius,8px)"));
  assert.ok(sharedSource.includes("min-height:var(--mi-button-primary-h,44px)"));
});

test("선택자는 이름 그대로 검색된다", async () => {
  // 운영 검증이 [data-mi-google-nudge] · [class*="google-nudge"] 로 찾아 실패한 적이 있다.
  // 줄임말 선택자로 되돌아가지 않도록 못을 박는다.
  const realm = createRealm();
  realm.load();
  realm.glue("team", "team-01");
  await realm.settle();
  assert.ok(realm.dom.document.querySelector(`[${ROOT_ATTRIBUTE}]`));
  for (const name of ["mi-google-nudge-card", "mi-google-nudge-title", "mi-google-nudge-primary", "mi-google-nudge-pill", "mi-google-nudge-deadline"]) {
    assert.equal(realm.dom.findByClass(name).length, 1, `클래스가 없습니다: ${name}`);
  }
  assert.equal(sharedSource.includes("mi-gnudge"), false, "줄임말 선택자가 남아 있습니다.");
  // 운영에서 원인을 바로 읽을 수 있게 판정 결과를 남긴다.
  assert.equal(realm.window.MomentGoogleNudge.lastResult, "shown");
});

test("바뀐 인라인 스크립트만큼 CSP 해시가 따라왔다", () => {
  for (const [label, page] of [["admin.html", adminSource], ["client.html", clientSource]]) {
    const scripts = inlineScripts(page);
    assert.equal(scripts.length, 1, `${label}: 인라인 스크립트는 하나여야 합니다.`);
    const hash = `'sha256-${createHash("sha256").update(scripts[0], "utf8").digest("base64")}'`;
    assert.ok(vercelConfig.includes(hash), `${label}: vercel.json 에 CSP 해시가 없습니다 ${hash}`);
  }
  // 새 외부 스크립트는 해시가 필요 없다 — script-src 'self' 로 로드된다.
  assert.equal(vercelConfig.includes("mi-google-nudge"), false);
});

test("새 스위트가 npm test 에 등록되어 있다", () => {
  assert.ok(packageJson.scripts.test.includes("scripts/google-login-nudge-ui.test.mjs"));
});
