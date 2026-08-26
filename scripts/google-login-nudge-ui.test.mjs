// 구글 로그인 연동 안내 팝업(public/mi-google-nudge.js) 계약 테스트.
//
// 세 가지를 증명한다.
//  1) 공유 스크립트가 대표님이 결재한 문구를 그대로 갖고, 연결된 계정에게는
//     열리지 않는다(linked 판정과 계정별 해제 키).
//  2) admin.html · client.html 이 로그인 착지 지점에서 실제로 부른다 —
//     그리고 마크업 리터럴이 페이지 인라인 스크립트로 새어 나가지 않는다.
//  3) 인라인 스크립트가 바뀐 만큼 vercel.json 의 CSP 해시가 따라왔다.
//
// 네트워크·환경변수·브라우저 DOM 없이 돌아간다.

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

const SCRIPT_TAG = '<script src="/mi-google-nudge.js?v=gnudge-v1-20260826"></script>';

// 로드 시점에 window 에 붙는 것 말고는 아무 부작용이 없다 — document 를 건드리는
// 코드는 전부 함수 안에 있다. 그 자체가 "띄우기 전에는 화면을 만지지 않는다" 의 증명이다.
function loadShared(sessionStore) {
  const store = sessionStore || new Map();
  const sandboxWindow = {
    location: { hostname: "insight.momentlabs.co.kr", origin: "https://insight.momentlabs.co.kr" },
    sessionStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
    },
  };
  const sandboxDocument = {
    querySelector() { throw new Error("document 를 만지면 안 되는 경로입니다."); },
  };
  vm.runInNewContext(sharedSource, { window: sandboxWindow, document: sandboxDocument });
  return { api: sandboxWindow.MomentGoogleNudge, store };
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

test("대표 결재 문구가 공유 스크립트에 그대로 있다", () => {
  assert.ok(sharedSource.includes('var TITLE_TEXT = "로그인 방식이 구글 계정 연동으로 바뀝니다";'));
  assert.ok(sharedSource.includes('var BODY_LINE_1 = "모먼트 인사이트가 더 안전하고 간편한 구글 계정 로그인으로 전환됩니다.";'));
  assert.ok(sharedSource.includes('var BODY_LINE_2 = "30일 이내에 구글 계정을 연결해 주세요 — 연결 후에는 코드 입력 없이 바로 로그인할 수 있습니다.";'));
  assert.ok(sharedSource.includes('var PRIMARY_TEXT = "구글 계정 연결";'));
  assert.ok(sharedSource.includes('var SECONDARY_TEXT = "나중에 하기";'));
  // 두 줄은 <br> 로 나뉜다 — innerHTML 조립이 아니라 텍스트 노드로 들어간다.
  assert.ok(sharedSource.includes("body.appendChild(document.createTextNode(BODY_LINE_1));"));
  assert.ok(sharedSource.includes('body.appendChild(document.createElement("br"));'));
  assert.ok(sharedSource.includes("body.appendChild(document.createTextNode(BODY_LINE_2));"));
  assert.equal(sharedSource.includes("innerHTML"), false, "마크업을 문자열로 조립하면 안 됩니다.");
});

test("연결된 계정은 절대 열리지 않고, 환경변수가 없으면 띄우지 않는다", () => {
  assert.ok(sharedSource.includes('var response = await doFetch(apiOrigin() + apiBase + "/google-login", { method: "GET", cache: "no-store" });'));
  assert.ok(sharedSource.includes("if (payload.linked === true || payload.configured !== true) return false;"));
  // 조회 실패는 조용히 넘긴다 — 팝업이 착지 화면을 대신 차지하면 안 된다.
  assert.ok(sharedSource.includes("if (!response.ok || !payload || payload.ok !== true) return false;"));
  assert.ok(sharedSource.includes("} catch (error) {\n      return false;\n    }"));
  // 첫 페인트 뒤에 조회한다.
  assert.ok(sharedSource.includes("await afterPaint();"));
  assert.ok(sharedSource.includes("window.requestAnimationFrame(function () {"));
});

test("연결 버튼은 기존 배너와 같은 link-url 계약을 그대로 쓴다", () => {
  assert.ok(sharedSource.includes('body: JSON.stringify({ action: "link-url" })'));
  assert.ok(sharedSource.includes("window.location.href = payload.url;"));
  assert.ok(sharedSource.includes('var apiBase = String(config.apiBase || "/api/my");'));
});

test("호출 대상은 /api/my 안의 google-login 하나뿐이고 자체 fetch 를 부르지 않는다", () => {
  const targets = [...new Set([...sharedSource.matchAll(/apiBase \+ "([^"]+)"/g)].map((entry) => entry[1]))];
  assert.deepEqual(targets, ["/google-login"]);
  for (const forbidden of ["/api/owner/", "/api/admin/", "/api/auth/", '"/api/work-items"']) {
    assert.equal(sharedSource.includes(forbidden), false, `금지된 경로를 부릅니다: ${forbidden}`);
  }
  // 페이지가 주입한 구현만 쓴다 — CSRF 토큰과 자격 헤더 규칙이 miFetch 안에 남아야 한다.
  assert.equal(/[^A-Za-z_$.]fetch\s*\(/.test(sharedSource), false, "공유 스크립트는 자체 fetch 를 호출하면 안 됩니다.");
  assert.equal(sharedSource.includes("XMLHttpRequest"), false);
  assert.equal(sharedSource.includes("window.fetch"), false);
});

test("해제 키는 계정마다 나뉘고 세션이 끝나면 사라진다", () => {
  const { api } = loadShared();
  assert.equal(api.dismissKey("team", "MML93-A01"), "mi-google-nudge-dismissed:team:mml93-a01");
  assert.equal(api.dismissKey("client", "Client_02"), "mi-google-nudge-dismissed:client:client_02");
  // 역할이 다르면 키도 다르다 — 한 브라우저에서 번갈아 로그인해도 서로 물려받지 않는다.
  assert.notEqual(api.dismissKey("team", "abc"), api.dismissKey("client", "abc"));
  // 태그를 못 만들면 공용 키로 떨어지지 않고 아예 띄우지 않는다.
  assert.equal(api.dismissKey("team", ""), "");
  assert.equal(api.dismissKey("", "abc"), "");
  assert.ok(sharedSource.includes('var DISMISS_PREFIX = "mi-google-nudge-dismissed:";'));
  // localStorage 가 아니라 sessionStorage 다 — 다음 로그인에서 다시 뜬다.
  assert.equal(sharedSource.includes("localStorage"), false, "다음 로그인에서 다시 떠야 하므로 localStorage 를 쓰면 안 됩니다.");
  assert.ok(sharedSource.includes("window.sessionStorage.getItem(key)"));
  assert.ok(sharedSource.includes('window.sessionStorage.setItem(key, "1");'));
});

test("이미 닫은 계정은 조회조차 하지 않는다", async () => {
  const store = new Map([["mi-google-nudge-dismissed:team:team-01", "1"]]);
  const { api } = loadShared(store);
  let calls = 0;
  const spy = () => { calls += 1; throw new Error("불려서는 안 됩니다."); };
  assert.equal(await api.maybeShow({ fetch: spy, role: "team", accountTag: "team-01" }), false);
  assert.equal(calls, 0);
  // fetch 를 주입하지 않으면 아무 것도 하지 않는다.
  assert.equal(await api.maybeShow({ role: "team", accountTag: "team-02" }), false);
  assert.equal(await api.maybeShow({ fetch: spy, role: "team", accountTag: "" }), false);
  assert.equal(calls, 0);
});

test("닫기·나중에 하기·Esc 가 모두 같은 해제 경로를 탄다", () => {
  assert.ok(sharedSource.includes("markDismissed(key);"));
  assert.ok(sharedSource.includes('parts.close.addEventListener("click", close);'));
  assert.ok(sharedSource.includes('parts.secondary.addEventListener("click", close);'));
  assert.ok(sharedSource.includes('if (event.key === "Escape") {'));
  // 가벼운 포커스 트랩: 카드 안 세 버튼만 순환하고, 닫으면 원래 자리로 돌아간다.
  assert.ok(sharedSource.includes('if (event.key !== "Tab") return;'));
  assert.ok(sharedSource.includes("var previousFocus = document.activeElement;"));
  assert.ok(sharedSource.includes("parts.primary.focus();"));
  assert.ok(sharedSource.includes('card.setAttribute("aria-modal", "true");'));
});

test("인라인 핸들러가 없다 — CSP script-src-attr 'none' 을 지킨다", () => {
  assert.equal(/\son[a-z]+\s*=\s*["']/i.test(sharedSource), false, "인라인 핸들러가 남아 있습니다.");
  assert.equal(sharedSource.includes("javascript:"), false);
  assert.equal(sharedSource.includes("eval("), false);
});

test("두 페이지가 같은 외부 스크립트를 싣고 착지 지점에서 부른다", () => {
  for (const page of [adminSource, clientSource]) {
    assert.equal((page.match(/<script src="\/mi-google-nudge\.js/g) || []).length, 1);
    assert.ok(page.includes(SCRIPT_TAG));
    assert.ok(page.includes('accountTag: googleNudgeAccountTag()'));
    assert.ok(page.includes('apiBase: "/api/my",'));
  }
  // 운영팀·총관리자: 로그인과 세션 복원이 같은 함수로 들어온다.
  const activate = functionBlock(adminSource, "async function activateAdminSession(payload, restored, requestGeneration) {");
  assert.ok(activate.includes("maybeShowGoogleNudge();"));
  assert.ok(adminSource.includes("fetch: miFetch,\n          role: secureSession.role,"));
  assert.ok(adminSource.includes("return secureSession.teamId || secureSession.clientId || secureSession.scopeKey || \"\";"));
  // 광고주: 코드 로그인과 세션 복원 두 곳 모두.
  assert.equal((clientSource.match(/maybeShowGoogleNudge\(\);/g) || []).length, 2);
  assert.ok(clientSource.includes("fetch: miFetch,\n          role: secureClientSession.role,"));
  assert.ok(clientSource.includes("return secureClientSession.clientId || secureClientSession.scopeKey || \"\";"));
  // 로그아웃 뒤에 다시 뜨는 일은 없어야 하므로, 착지 지점 밖에서는 부르지 않는다.
  assert.equal((adminSource.match(/maybeShowGoogleNudge\(\);/g) || []).length, 1);
});

test("팝업 마크업은 공유 스크립트 안에만 있다", () => {
  // 마크업이 페이지 인라인 스크립트로 새어 나가면 CSP 해시가 다시 움직인다.
  for (const page of [adminSource, clientSource]) {
    assert.equal(page.includes("mi-gnudge"), false);
    assert.equal(page.includes("data-mi-gnudge"), false);
    assert.equal(page.includes("로그인 방식이 구글 계정 연동으로"), false);
  }
  // 화면 이름 리터럴이 늘어나면 대표실 메뉴 회귀 테스트가 오탐한다.
  assert.equal(adminSource.includes('data-mi-admin-screen="my-calendar"') && inlineScripts(adminSource)[0].includes('data-mi-admin-screen="my-calendar"'), false);
  // 색은 토큰에서만 온다 — 새 색·변형을 만들지 않는다.
  assert.equal(/#[0-9a-f]{6}(?![^(]*\))/i.test(sharedSource.replace(/var\(--mi-[a-z0-9-]+,\s*#[0-9a-f]{3,6}\)/gi, "")), false, "토큰 밖의 색이 있습니다.");
  assert.ok(sharedSource.includes("background:rgba(6,26,58,0.55);"));
  assert.ok(sharedSource.includes("border-radius:var(--mi-radius,8px)"));
  assert.ok(sharedSource.includes("min-height:var(--mi-button-primary-h,44px)"));
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
