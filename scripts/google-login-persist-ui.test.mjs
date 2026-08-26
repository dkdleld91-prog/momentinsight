// 구글 로그인 "자동 로그인"(30일) 체크박스의 화면 계약 테스트.
//
// 네 가지를 증명한다.
//  1) 두 로그인 화면에 같은 라벨·같은 속성으로 정확히 한 번씩 붙었다.
//  2) 체크했을 때만 ?persist=1 로 가고, 체크하지 않은 경로는 바이트 그대로 남았다.
//  3) 색은 토큰에서만 온다 — 새 색을 만들지 않는다.
//  4) 코드 로그인 요청(/api/session)에는 persist 가 한 글자도 섞이지 않는다.
//
// 네트워크·환경변수·브라우저 없이 원문만 읽는다(다른 UI 테스트와 같은 방식).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const adminSource = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");
const clientSource = fs.readFileSync(new URL("../src/pages/client.html", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const PERSIST_LABEL = '<label class="mi-login-persist"><input type="checkbox" data-google-login-persist />자동 로그인 · 이 기기에서 30일 유지</label>';
const PAGES = [["admin.html", adminSource, "#mi-admin"], ["client.html", clientSource, "#mi-clean"]];

function occurrences(source, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

// 한 CSS 규칙만 잘라 낸다 — 선언 안에 중괄호가 없는 평범한 규칙 전제.
function cssRule(source, selector) {
  const from = source.indexOf(selector);
  assert.ok(from >= 0, `CSS 규칙을 찾지 못했습니다: ${selector}`);
  const to = source.indexOf("}", from);
  assert.ok(to > from, `CSS 규칙의 끝을 찾지 못했습니다: ${selector}`);
  return source.slice(from, to + 1);
}

test("두 로그인 화면에 같은 자동 로그인 체크박스가 한 번씩 붙는다", () => {
  for (const [label, page] of PAGES) {
    assert.ok(page.includes(PERSIST_LABEL), `${label}: 자동 로그인 라벨이 없습니다.`);
    // 마크업 1 + 쿼리셀렉터 1 — 그 이상은 중복 바인딩이다.
    assert.equal(occurrences(page, "data-google-login-persist"), 2, `${label}: 속성이 두 번(마크업·선택자)만 나와야 합니다.`);
    assert.equal(occurrences(page, PERSIST_LABEL), 1, `${label}: 라벨이 두 번 그려졌습니다.`);
    // 승인된 기존 두 줄은 그대로 남고 뒤에 붙기만 했다.
    assert.ok(page.includes('<button class="mi-button is-ghost" type="button" data-google-login-start>Google 계정으로 로그인</button>'));
    assert.ok(page.includes('<small class="mi-login-google-note">연결해 둔 계정만 로그인됩니다</small>'));
    const noteAt = page.indexOf('<small class="mi-login-google-note">');
    assert.ok(noteAt >= 0 && page.indexOf(PERSIST_LABEL) > noteAt, `${label}: 체크박스는 안내 문구 다음이어야 합니다.`);
  }
});

test("체크했을 때만 persist=1 로 가고, 체크 해제 경로는 그대로다", () => {
  for (const [label, page] of PAGES) {
    assert.ok(page.includes('var googleLoginPersist = root.querySelector("[data-google-login-persist]");'), `${label}: 선택자 바인딩이 없습니다.`);
    assert.ok(page.includes("if (googleLoginPersist && googleLoginPersist.checked === true) {"), `${label}: 체크 판정이 없습니다.`);
    assert.ok(page.includes('window.location.href = "/api/google-login/start?persist=1";'), `${label}: 자동 로그인 목적지가 없습니다.`);
    // 체크하지 않은 경로는 오늘의 리터럴 그대로여야 한다(기존 핀 테스트와 같은 문자열).
    assert.ok(page.includes('window.location.href = "/api/google-login/start";'), `${label}: 기존 목적지가 사라졌습니다.`);
    // 주소를 문자열로 잇지 않는다 — 목적지는 고정된 두 개뿐이다.
    assert.equal(/location\.href\s*=\s*"\/api\/google-login\/start[^"]*"\s*\+/.test(page), false, `${label}: 목적지를 문자열로 이었습니다.`);
    assert.equal(occurrences(page, '"/api/google-login/start'), 2, `${label}: 구글 로그인 시작 주소는 두 개뿐이어야 합니다.`);
  }
});

test("자동 로그인 체크박스의 색은 토큰에서만 온다", () => {
  for (const [label, page, prefix] of PAGES) {
    const rule = cssRule(page, `${prefix} .mi-login-persist {`);
    const inputRule = cssRule(page, `${prefix} .mi-login-persist input {`);
    assert.ok(rule.includes("color: var(--mi-muted);"), `${label}: 안내 색이 토큰이 아닙니다.`);
    assert.ok(rule.includes("display: flex;"));
    assert.ok(rule.includes("font-size: 12px;"));
    assert.ok(inputRule.includes("accent-color: var(--mi-navy-2);"), `${label}: 체크 색이 토큰이 아닙니다.`);
    for (const block of [rule, inputRule]) {
      assert.equal(/#[0-9a-f]{3,6}/i.test(block), false, `${label}: 토큰 밖의 색이 있습니다.`);
    }
  }
});

test("코드 로그인은 한 글자도 바뀌지 않았다", () => {
  assert.ok(adminSource.includes('var loginButton = root.querySelector("[data-admin-login-button]");'));
  assert.ok(clientSource.includes('var loginButton = root.querySelector("[data-mi-login-button]");'));
  for (const [label, page] of PAGES) {
    // 코드 로그인 요청 경로는 그대로다 — persist 가 붙을 자리가 없다.
    assert.ok(page.includes('var response = await miFetch(getSessionApiUrl() + "?action=login", {'), `${label}: 코드 로그인 요청이 바뀌었습니다.`);
    assert.ok(page.includes('await miFetch(getSessionApiUrl(), { method: "GET", cache: "no-store" });'), `${label}: 세션 복원 요청이 바뀌었습니다.`);
    assert.equal(/getSessionApiUrl\(\)[^;\n]*persist/.test(page), false, `${label}: 코드 로그인 경로에 persist 가 섞였습니다.`);
    assert.equal(page.includes("?action=login&persist"), false);
    // persist 라는 낱말이 나오는 자리를 전부 세어 둔다. 늘어나면 이 테스트가 먼저 깨진다.
    const known = ["mi-login-persist", "data-google-login-persist", "googleLoginPersist", "persist=1", "persistPublicState"];
    let remaining = page;
    for (const token of known) remaining = remaining.split(token).join("");
    assert.equal(remaining.toLowerCase().includes("persist"), false, `${label}: 알 수 없는 persist 사용처가 있습니다.`);
  }
});

test("새 스위트가 npm test 에 등록되어 있다", () => {
  assert.ok(packageJson.scripts.test.includes("scripts/google-login-persist-ui.test.mjs"));
});
