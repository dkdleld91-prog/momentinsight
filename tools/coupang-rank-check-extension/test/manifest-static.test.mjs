// manifest·폴더·정적 금지 규칙. 권한을 넓히거나, 자동 반복·우회·클릭 코드를 넣으면 여기서 막힌다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { EXTENSION_ROOT, SHIPPED_FILES, readExtension } from "./helpers.mjs";
import { EXTENSION_VERSION, NOT_STARTED_CODES, PAGE_ERROR_CODES } from "../lib/protocol.js";

const manifest = JSON.parse(readExtension("manifest.json"));
const SHIPPED_JS = SHIPPED_FILES.filter((file) => file.endsWith(".js"));
const EXPECTED_ID = "onbmdfamcmbljplkgalameendlmgnjeg";

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

test("manifest: 키 목록과 값이 정확하다(MV3·spanning·권한 2개·호스트 2개·관리자 화면만 연결)", () => {
  assert.deepEqual(Object.keys(manifest).sort(), [
    "background", "description", "externally_connectable", "host_permissions", "incognito", "key", "manifest_version",
    "minimum_chrome_version", "name", "permissions", "short_name", "version",
  ].sort());
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, EXTENSION_VERSION);
  assert.equal(manifest.minimum_chrome_version, "110");
  assert.equal(manifest.incognito, "spanning");
  assert.deepEqual(manifest.permissions, ["scripting", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.coupang.com/*", "https://insight.momentlabs.co.kr/*"]);
  assert.deepEqual(manifest.background, { service_worker: "background.js", type: "module" });
  assert.deepEqual(manifest.externally_connectable, { matches: ["https://insight.momentlabs.co.kr/admin*"] });
  assert.ok(manifest.description.length <= 132, "크롬 설명 상한 132자");
  assert.ok(manifest.name.length <= 75);
});

test("manifest: 넣지 않는 권한·키(알람·탭·요청 가로채기·쿠키·디버거·프록시·내용 스크립트·아이콘 버튼 등) 0개", () => {
  const forbiddenPermissions = [
    "alarms", "tabs", "webRequest", "webRequestBlocking", "webNavigation", "cookies", "debugger", "proxy",
    "declarativeNetRequest", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback", "nativeMessaging",
    "history", "notifications", "management", "downloads", "privacy", "contentSettings", "browsingData", "identity",
    "offscreen", "sidePanel", "background", "<all_urls>", "activeTab",
  ];
  const all = [...manifest.permissions, ...manifest.host_permissions];
  for (const name of forbiddenPermissions) assert.ok(!all.includes(name), name);
  for (const key of [
    "content_scripts", "web_accessible_resources", "action", "browser_action", "page_action", "optional_permissions",
    "optional_host_permissions", "commands", "declarative_net_request", "chrome_url_overrides", "devtools_page",
    "options_page", "options_ui", "side_panel", "oauth2", "sandbox", "update_url", "content_security_policy", "icons",
  ]) {
    assert.ok(!Object.hasOwn(manifest, key), key);
  }
  assert.ok(!Object.hasOwn(manifest.externally_connectable, "ids"), "다른 확장은 연결하지 못한다");
  assert.ok(!Object.hasOwn(manifest.externally_connectable, "accepts_tls_channel_id"));
});

test("manifest key: RSA 2048 공개키(SPKI)이고, 계산한 확장 ID 가 고정값이다", () => {
  const der = Buffer.from(manifest.key, "base64");
  assert.equal(der.toString("base64"), manifest.key, "base64 한 줄");
  assert.ok(der.length >= 290 && der.length <= 300, `SPKI ${der.length}바이트`);
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = Array.from(hex, (char) => String.fromCharCode(97 + parseInt(char, 16))).join("");
  assert.equal(id, EXPECTED_ID);
});

test("폴더: 배포 5개 + README + test 만, 비밀키·바이너리 없음", () => {
  const names = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(EXTENSION_ROOT, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) walk(absolute);
      else names.push(rel);
    }
  };
  walk(EXTENSION_ROOT);
  const outside = names.filter((name) => !SHIPPED_FILES.includes(name) && name !== "README.md" && !/^test\/[a-z0-9-]+(?:\.test)?\.mjs$/.test(name));
  assert.deepEqual(outside, []);
  for (const name of names) {
    assert.ok(!/\.(pem|key|crx|zip|p12|pfx|png|jpg|ico)$/i.test(name), name);
    const text = fs.readFileSync(path.join(EXTENSION_ROOT, name), "utf8");
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `${name} 에 비밀키`);
  }
  for (const file of SHIPPED_JS) assert.ok(!file.endsWith(".mjs"), "공개 빌드는 .mjs 를 막는다");
});

test("정적 금지: 클릭·입력·포커스·주소 바꾸기·브라우저 표식 숨기기·알람·쿠키·요청 가로채기·새 탭 0개", () => {
  const patterns = [
    [/\.click\(/, ".click("],
    [/dispatchEvent/, "dispatchEvent"],
    [/\.focus\(/, ".focus("],
    [/\.submit\(/, ".submit("],
    [/webdriver/i, "webdriver"],
    [/navigator\.userAgent\s*=(?!=)/, "userAgent ="],
    [/defineProperty\(\s*navigator/, "defineProperty(navigator"],
    [/window\.open\s*\(/, "window.open"],
    [/location\.href\s*=(?!=)/, "location.href ="],
    [/location\.(?:assign|replace)\s*\(/, "location.assign/replace"],
    [/\bhistory\./, "history."],
    [/\.value\s*=(?!=)/, "입력란 쓰기"],
    [/innerHTML|outerHTML|insertAdjacentHTML/, "HTML 쓰기"],
    [/chrome\.alarms|\balarms\b/, "alarms"],
    [/chrome\.cookies/, "cookies API"],
    [/chrome\.(?:webRequest|declarativeNetRequest|debugger|proxy|history|webNavigation)/, "금지 API"],
    [/chrome\.tabs\.create|chrome\.runtime\.onInstalled|chrome\.runtime\.onStartup|onInstalled|onStartup/, "새 탭·설치 이벤트"],
    [/XMLHttpRequest|sendBeacon|WebSocket|EventSource/, "다른 통신"],
    [/\beval\s*\(|new Function\s*\(/, "eval"],
    [/files\s*:\s*\[/, "파일 주입"],
  ];
  for (const file of SHIPPED_JS) {
    const source = stripComments(readExtension(file));
    for (const [pattern, label] of patterns) assert.doesNotMatch(source, pattern, `${file}: ${label}`);
  }
});

test("정적: 서버 요청은 protocol.js verifyClaim 한 곳(fetchImpl 1번), 전역 fetch 는 background 의 기본값 1곳뿐", () => {
  const sources = Object.fromEntries(SHIPPED_JS.map((file) => [file, stripComments(readExtension(file))]));
  const globalFetch = Object.entries(sources).flatMap(([file, source]) => (source.match(/\bfetch\s*\(/g) || []).map(() => file));
  assert.deepEqual(globalFetch, ["background.js"]);
  assert.match(sources["background.js"], /\(url, init\) => globalThis\.fetch\(url, init\)/);
  const callers = Object.entries(sources).flatMap(([file, source]) => (source.match(/\bfetchImpl\s*\(/g) || []).map(() => file));
  assert.deepEqual(callers, ["lib/protocol.js"]);
  assert.doesNotMatch(sources["lib/measure.js"], /fetch/);
  assert.doesNotMatch(sources["lib/assemble.js"], /fetch/);
  // 쿠팡 주소는 창 이동(tabs.update)에만 쓴다.
  assert.equal((sources["background.js"].match(/c\.tabs\.update\(/g) || []).length, 1);
  assert.equal((sources["background.js"].match(/c\.windows\.create\(/g) || []).length, 1);
  assert.match(sources["background.js"], /url: "about:blank", incognito: true/);
});

test("정적: 쪽 주입은 우리 함수 2개(func)뿐이고 문자열 코드·파일 주입·MAIN 세계 없음", () => {
  const background = stripComments(readExtension("background.js"));
  const funcs = [...background.matchAll(/func:\s*([A-Za-z]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(funcs)].sort(), ["miCoupangMeasure", "miCoupangProbe"]);
  const injections = [...background.matchAll(/executeScript\(\{([\s\S]*?)\}\)/g)].map((match) => match[1]);
  assert.equal(injections.length, 3);
  for (const body of injections) {
    assert.match(body, /target: \{ tabId \}/);
    assert.doesNotMatch(body, /\bworld\s*:|\bcode\s*:|\bfiles\s*:|allFrames/);
  }
  assert.equal((background.match(/executeScript\(/g) || []).length, 3, "측정·짧은 읽기·load 확인");
});

test("정적: 네이버 이름 0개, 리스너는 onMessageExternal 하나", () => {
  for (const file of SHIPPED_FILES) assert.doesNotMatch(readExtension(file), /naver/i, file);
  const background = stripComments(readExtension("background.js"));
  assert.equal((background.match(/onMessageExternal\.addListener/g) || []).length, 1);
  assert.doesNotMatch(background, /runtime\.onMessage\./);
  assert.doesNotMatch(background, /onConnect/);
});

test("코드 목록: 시작 안 함·쪽 오류 코드는 소문자 밑줄 60자 이하, 서로 겹치지 않는다", () => {
  for (const code of [...NOT_STARTED_CODES, ...PAGE_ERROR_CODES]) assert.match(code, /^[a-z0-9_]{1,60}$/);
  assert.equal(new Set([...NOT_STARTED_CODES, ...PAGE_ERROR_CODES]).size, NOT_STARTED_CODES.length + PAGE_ERROR_CODES.length);
  const background = readExtension("background.js");
  for (const match of background.matchAll(/notStarted\("([a-z0-9_]+)"/g)) assert.ok(NOT_STARTED_CODES.includes(match[1]), match[1]);
  for (const match of background.matchAll(/errorCode: "([a-z0-9_]+)"/g)) assert.ok(PAGE_ERROR_CODES.includes(match[1]), match[1]);
});
