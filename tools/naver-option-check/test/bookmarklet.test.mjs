// 묶은 즐겨찾기 버튼(build.mjs 결과) 시험: 금지 코드 정적 검사 + 가짜 화면(DOM)에서 실제로 돌려 보기.
// 가짜 화면에는 요청 함수 자리마다 기록기를 두어, 한 번이라도 불리면 실패한다. 실제 네이버 페이지는 열지 않는다.
// 2.1.0(advertiser-impl-spec 3절): 결과창 상태·버튼 표, 주 버튼을 누를 때만 고정 인사이트 주소 하나를 새 탭으로 여는지,
// 넘기는 값(#mi-optfill=…)이 1절 형식인지 본다. 창 열기는 기록기로 바꿔 넣어 인자만 적는다(진짜로 열지 않음).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { OPTION_FILL_TARGETS, bookmarkletHref, buildBookmarkletCode, countAllowedOpens, findForbiddenCode } from "../build.mjs";
import * as core from "../src/core.mjs";
import {
  DECASA_CURRENT,
  DECASA_URL,
  ISHELL_CURRENT,
  ISHELL_OPTION_IDS,
  ISHELL_URL,
  PARALLEL_CHANNEL_IDS,
  PRIVATE_VALUES,
  groupNumberArrayState,
  groupObjectState,
  groupOfSize,
  groupParallelColumnsState,
  membersWithoutCurrentState,
} from "./fixtures.mjs";

const { OPTION_CHECK_VERSION, findGroupOptions, productPageFromUrl } = core;
const codes = {
  admin: buildBookmarkletCode({ variant: "admin" }),
  client: buildBookmarkletCode({ variant: "client" }),
};
const code = codes.admin;
const panelSource = fs.readFileSync(new URL("../src/panel.js", import.meta.url), "utf8");
// panel.js 혼자 돌릴 때 넣어 주는 core 함수(묶은 코드에서는 core.mjs 가 바로 앞에 붙는다).
const CORE_GLOBALS = {
  OPTION_CHECK_VERSION,
  findGroupOptions,
  productPageFromUrl,
  isServerProductId: core.isServerProductId,
  optionFillFoundPayload: core.optionFillFoundPayload,
  optionFillRefusedPayload: core.optionFillRefusedPayload,
  optionFillDiag: core.optionFillDiag,
};

// 명세(advertiser-impl-spec 1절)를 글자 그대로 옮긴 것. core 의 값과 따로 둬서 한쪽이 바뀌면 시험이 잡는다.
const SPEC_TARGETS = { admin: "https://insight.momentlabs.co.kr/admin", client: "https://insight.momentlabs.co.kr/client" };
const SPEC_FOUND = /^2\.f\.([0-9]{5,20})\.([0-9]{5,20}(?:-[0-9]{5,20}){0,50})$/;
const SPEC_REFUSED = /^2\.r\.([0-9]{5,20})\.([A-Za-z0-9_-]{1,2000})$/;
const SPEC_REASON_CODES = [
  "source_unreadable", "traversal_cap", "ambiguous", "group_list_split", "mixed_id_keys",
  "unrecognized_items", "unsafe_number", "digit_length", "too_many", "no_group_list", "group_list_without_current", "not_found",
];
const HASH_KEY = "#mi-optfill=";

// 이 모양 하나만 허용한다(명세 3절). 묶은 코드에서 이 한 곳을 걷은 뒤 나머지에 금지 코드가 없어야 한다.
const ALLOWED_OPEN_TEXT = 'window.open(OPTION_FILL_TARGET + "#mi-optfill=" + payload, "_blank", "noopener,noreferrer")';

// build.mjs 의 금지 목록과 따로, 명세(impl-spec 4절·advertiser-impl-spec 3절)에 적힌 금지를 여기서 다시 적는다(목록이 약해져도 시험이 잡게).
const SPEC_FORBIDDEN = [
  ["fetch", /fetch/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["sendBeacon", /sendBeacon/],
  ["WebSocket", /WebSocket/],
  ["EventSource", /EventSource/],
  ["new Image", /new\s+Image/],
  ["import(", /import\s*\(/],
  [".src=", /\.\s*src\s*=/],
  ["location 대입", /location\s*=[^=]|location\s*\.\s*(href|hash|search|pathname)\s*=[^=]/],
  ["location 이동 함수", /location\s*\.\s*(assign|replace|reload)/],
  ["window.open", /window\s*\.\s*open/],
  ["open(", /\bopen\s*\(/],
  ["innerHTML", /innerHTML|outerHTML|insertAdjacentHTML/],
  ["Audio", /Audio/],
  ["setAttribute 요청 속성", /setAttribute\s*\(\s*["'`](href|src|srcdoc|action)["'`]/i],
  [".click()", /\.\s*click\s*\(/],
  ["양식 보내기", /\.\s*submit\s*\(|requestSubmit/],
  ["클립보드·글 칸", /clipboard|execCommand|textarea/],
  ["글자 조합 속성 접근", /\[\s*["'`][^\]\n]*["'`]\s*\+|\[\s*`[^`\]]*\$\{/],
];

test("금지 코드: 두 변형 모두 창 열기는 정확히 1곳(고정 주소 상수로 시작)이고, 그 한 곳을 걷으면 요청·이동·HTML 끼워 넣기 코드가 없다", () => {
  for (const [variant, built] of Object.entries(codes)) {
    assert.equal(built.split(ALLOWED_OPEN_TEXT).length - 1, 1, `${variant}: 허용 모양 창 열기 1곳`);
    assert.equal((built.match(/\bopen\s*\(/g) || []).length, 1, `${variant}: open( 은 그 1곳뿐`);
    assert.equal(countAllowedOpens(built), 1);
    assert.equal(built.split(`const OPTION_FILL_TARGET = ${JSON.stringify(SPEC_TARGETS[variant])};`).length - 1, 1, `${variant}: 고정 주소 상수`);
    assert.equal((built.match(/\bOPTION_FILL_TARGET\s*=(?!=)/g) || []).length, 1, `${variant}: 상수 대입은 선언 1번`);
    assert.equal(built.includes("__MI_OPTION_FILL_TARGET__"), false, `${variant}: 자리 글자가 남지 않음`);
    assert.equal(/insight\.momentlabs\.co\.kr/.test(built.replace(SPEC_TARGETS[variant], "")), false, `${variant}: 다른 주소 글자 없음`);
    const rest = built.replace(ALLOWED_OPEN_TEXT, "");
    for (const [name, pattern] of SPEC_FORBIDDEN) assert.equal(pattern.test(rest), false, `${variant}: ${name}`);
    assert.deepEqual(findForbiddenCode(built), []);
  }
  assert.deepEqual(OPTION_FILL_TARGETS, SPEC_TARGETS);
  assert.notEqual(codes.admin, codes.client);
  assert.equal(codes.admin.replace(SPEC_TARGETS.admin, SPEC_TARGETS.client), codes.client, "두 변형은 고정 주소만 다르다");
});

test("금지 코드 검사기가 실제로 잡는다(빈 검사 방지)", () => {
  for (const sample of [
    "fetch('/x')", "new XMLHttpRequest()", "navigator.sendBeacon('/x')", "new WebSocket('wss://x')", "new EventSource('/x')",
    "new Image()", "import('x')", "img.src = 'x'", "location.href = 'x'", "location = 'x'", "location.assign('x')",
    "window.open('x')", "el.innerHTML = s", "document.createElement('img')", "a{background:url(x)}", "eval('1')",
    "localStorage.setItem('a','b')", "document.cookie", "form.submit()",
    // 2026-10-31 더함(K6): 그냥 open(·Audio·fetchLater·요청 속성 쓰기·링크 누르기·글자 조합 접근
    "open('x')", "self['open']('x')", "new Audio('x')", "fetchLater('/x')", "a.setAttribute('href', u)", "a.setAttribute(\"src\", u)",
    "f.setAttribute('srcdoc', h)", "f.setAttribute('action', u)", "a.href = u", "link.click()", "a.dispatchEvent(e)",
    "document.createElement('a')", "window['fe' + 'tch']('/x')", "x[y + 'tch']('/x')", "self[`fe${t}`]('/x')", "globalThis.fetch",
    "setTimeout('go()')", "atob('Zm')",
    // 2.1.0: 허용 모양 밖 창 열기·두 곳·상수 다시 대입
    "window.open('https://evil.example/' + p)", "window.open(p + OPTION_FILL_TARGET)", "window.open(OPTION_FILL_TARGET)",
    "open(OPTION_FILL_TARGET + p)", "self.open(OPTION_FILL_TARGET + p)",
    "window.open(OPTION_FILL_TARGET + a); window.open(OPTION_FILL_TARGET + b)",
    "window.open(OPTION_FILL_TARGET + a); open('x')",
    "const OPTION_FILL_TARGET = 'a'; OPTION_FILL_TARGET = 'b'; window.open(OPTION_FILL_TARGET + p)",
  ]) {
    assert.ok(findForbiddenCode(sample).length > 0, sample);
  }
  assert.deepEqual(findForbiddenCode("const page = new URL(String(location.href)); const x = location.href;"), []);
  // 허용 모양 한 곳은 잡지 않는다.
  assert.deepEqual(findForbiddenCode(`const OPTION_FILL_TARGET = "x"; ${ALLOWED_OPEN_TEXT};`), []);
  assert.equal(countAllowedOpens(ALLOWED_OPEN_TEXT), 1);
  // 화면 코드가 쓰는 모양은 잡지 않는다.
  for (const sample of [
    'panel.setAttribute("role", "dialog")', 'attachShadow({ mode: "open" })',
    'button.addEventListener("click", copy)', "names[entry.index]", "BASE64_URL_ALPHABET.charAt(chunk & 63)",
  ]) {
    assert.deepEqual(findForbiddenCode(sample), [], sample);
  }
});

test("빌드: 변형 이름이 admin·client 가 아니면 만들지 않는다", () => {
  for (const variant of [undefined, "", "Admin", "public", "https://insight.momentlabs.co.kr/admin"]) {
    assert.throws(() => buildBookmarkletCode({ variant }), /변형은 admin·client 중 하나/, String(variant));
  }
});

test("화면 코드: 그림자 DOM·textContent 만 쓴다", () => {
  assert.ok(panelSource.includes("attachShadow"));
  assert.ok(panelSource.includes("textContent"));
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(panelSource), false);
});

test("묶은 코드: 문법이 맞고, 한 함수로 감싸 반환값이 없다(페이지를 덮어쓰지 않음)", () => {
  for (const built of Object.values(codes)) {
    assert.doesNotThrow(() => new vm.Script(built));
    assert.ok(built.startsWith("(() => {\n\"use strict\";\n"));
    assert.ok(built.endsWith("})();\n"));
    assert.equal(/^\s*(export|import)\b/m.test(built), false);
  }
});

test("javascript: 주소: 되돌리면 같은 코드이고 HTML 특수 글자·#·공백이 없다(두 변형)", () => {
  for (const built of Object.values(codes)) {
    const href = bookmarkletHref(built);
    assert.ok(href.startsWith("javascript:"));
    assert.equal(decodeURIComponent(href.slice("javascript:".length)), built);
    assert.equal(/[&<>"'#\s]/.test(href), false);
  }
});

// 이 속성을 쓰면 요청이나 이동이 일어날 수 있다(가짜 화면에서는 기록만 함).
const NAVIGATING_ATTRIBUTES = new Set(["href", "src", "srcset", "srcdoc", "action", "formaction", "ping", "poster"]);

class FakeNode {
  constructor(tag, hooks = null) {
    this.hooks = hooks;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.ownText = "";
    this.style = { cssText: "", display: "" };
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.id = "";
    this.value = "";
    this.readOnly = false;
    this.focused = false;
    this.selected = false;
  }

  appendChild(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  set textContent(value) {
    this.children = [];
    this.ownText = String(value);
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set innerHTML(_) {
    throw new Error("innerHTML 금지");
  }

  setAttribute(name, value) {
    if (NAVIGATING_ATTRIBUTES.has(String(name).toLowerCase())) this.navigate(`setAttribute ${name}`);
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  set href(value) {
    this.navigate("href 대입");
    this.attributes.href = String(value);
  }

  get href() {
    return this.attributes.href ?? "";
  }

  set src(value) {
    this.navigate("src 대입");
    this.attributes.src = String(value);
  }

  get src() {
    return this.attributes.src ?? "";
  }

  navigate(name) {
    if (this.hooks) this.hooks.navigate(name);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  click() {
    // 링크를 누르면 실제 브라우저는 주소로 이동한다(요청).
    if (this.tagName === "A" || this.tagName === "AREA") this.navigate("링크 누르기");
    for (const listener of this.listeners.click || []) listener({ preventDefault() {} });
  }

  attachShadow(options) {
    assert.equal(options && options.mode, "open");
    this.shadowRoot = new FakeNode("#shadow-root");
    return this.shadowRoot;
  }

  focus() {
    this.focused = true;
  }

  select() {
    this.selected = true;
  }
}

function allNodes(node) {
  const list = [node];
  for (const child of node.children) list.push(...allNodes(child));
  if (node.shadowRoot) list.push(...allNodes(node.shadowRoot));
  return list;
}

// 가짜 페이지에서 버튼 코드를 한 번 실행한다. 요청·이동 자리(요청 함수, Audio, 링크 누르기, 요청 속성 쓰기,
// 주소 바꾸기)는 모두 기록기다. source·globals 로 다른 코드(panel.js 혼자, 시험용 조각)를 같은 가짜 화면에서 돌린다.
// scripts: 글자면 type="application/json" 스크립트, { text, type, id } 면 그 속성의 스크립트.
// stateThrows: 페이지 상태 객체(__PRELOADED_STATE__)를 읽으면 오류가 나는 페이지.
function runBookmarklet({ href, state, scripts = [], stateThrows = false, clipboard = "ok", execCommandResult = false, body = null, source = code, globals = {} }) {
  const network = [];
  const record = (name) => function recorder(...args) {
    network.push([name, args.length]);
    throw new Error(`요청 금지: ${name}`);
  };
  const hooks = { navigate: (name) => network.push([name, 1]) };
  const createdTags = [];
  const clipboardWrites = [];
  const execCommands = [];
  const selectors = [];
  const pageBody = body || new FakeNode("body");
  const locationStub = {
    get href() {
      return href;
    },
    set href(_) {
      network.push(["location.href 대입", 1]);
    },
    assign: record("location.assign"),
    replace: record("location.replace"),
    reload: record("location.reload"),
  };
  const documentStub = {
    body: pageBody,
    documentElement: new FakeNode("html"),
    createElement(tag) {
      createdTags.push(String(tag).toLowerCase());
      return new FakeNode(tag, hooks);
    },
    getElementById(id) {
      return allNodes(pageBody).find((node) => node.id === id) || null;
    },
    querySelectorAll(selector) {
      selectors.push(selector);
      return scripts.map((script) => (typeof script === "string"
        ? { type: "application/json", id: "", textContent: script }
        : { type: script.type || "", id: script.id || "", textContent: script.text }));
    },
    execCommand(command) {
      execCommands.push(command);
      return execCommandResult;
    },
  };
  const navigatorStub = {
    clipboard: clipboard === "none" ? undefined : {
      writeText(text) {
        clipboardWrites.push(text);
        return clipboard === "ok" ? Promise.resolve() : Promise.reject(new Error("막힘"));
      },
    },
    sendBeacon: record("sendBeacon"),
  };
  const context = {
    document: documentStub,
    navigator: navigatorStub,
    URL,
    JSON,
    __PRELOADED_STATE__: state,
    fetch: record("fetch"),
    fetchLater: record("fetchLater"),
    XMLHttpRequest: record("XMLHttpRequest"),
    WebSocket: record("WebSocket"),
    EventSource: record("EventSource"),
    Image: record("Image"),
    Audio: record("Audio"),
    open: record("open"),
    ...globals,
  };
  // location = "…" 처럼 통째로 바꾸는 것도 기록한다.
  Object.defineProperty(context, "location", {
    enumerable: true,
    get: () => locationStub,
    set: () => network.push(["location 대입", 1]),
  });
  // vm 의 전역 객체는 window.X 로 읽을 때 접근자(get)를 부르지 않아, 읽기 오류 페이지는 window 를 따로 둔다
  // (화면 코드가 window 로 읽는 것은 __PRELOADED_STATE__ 와 주 버튼의 open 뿐).
  context.window = stateThrows
    ? {
      get __PRELOADED_STATE__() {
        throw new Error("읽기 막힘");
      },
      open: (...args) => context.open(...args),
    }
    : context;
  vm.runInNewContext(source, context, { filename: "naver-option-check-bookmarklet.js" });
  const host = pageBody.children.find((node) => node.id === "mi-option-check-host");
  const nodes = host ? allNodes(host) : [];
  return {
    context,
    host,
    nodes,
    text: nodes.map((node) => node.ownText).join("\n"),
    buttons: nodes.filter((node) => node.tagName === "BUTTON"),
    areas: nodes.filter((node) => node.tagName === "TEXTAREA"),
    tables: nodes.filter((node) => node.tagName === "TABLE"),
    network,
    execCommands,
    createdTags,
    clipboardWrites,
    selectors,
    pageBody,
  };
}


const button = (run, label) => run.buttons.find((node) => node.textContent === label);
const labels = (run) => run.buttons.map((node) => node.textContent);
const statusLines = (run) => run.nodes.filter((node) => String(node.className).split(" ").includes("st")).map((node) => node.textContent);
const ALLOWED_TAGS = new Set(["div", "style", "h1", "button"]);
const FOUND_TEXT = (count) => `그룹상품 옵션 ${count}개를 찾았습니다.`;
const COULD_NOT_TEXT = "이 페이지에서 그룹상품 옵션을 자동으로 확인하지 못했습니다.";
const NOT_PRODUCT_TEXT = "스마트스토어 상품 페이지에서 눌러 주세요.";
const SAVE_LABEL = "모먼트에서 확인하고 저장";
const MANUAL_LABEL = "모먼트에서 직접 입력";

// 창 열기 기록기. 실제로 열지 않고 인자만 적는다(이것을 넣지 않은 실행에서는 open 이 요청 기록기라 불리면 실패).
function openRecorder() {
  const calls = [];
  return { calls, open: (...args) => { calls.push(args); return null; } };
}

// 버튼을 눌러 연 주소 하나를 돌려준다(정확히 1번 열렸는지·인자 모양까지 본다).
function clickAndRead(run, recorder, label, target) {
  assert.equal(recorder.calls.length, 0, "누르기 전에는 창을 열지 않는다");
  button(run, label).click();
  assert.equal(recorder.calls.length, 1, "누르면 정확히 1번 연다");
  const args = recorder.calls[0];
  assert.equal(args.length, 3);
  const [url, name, features] = args;
  assert.equal(name, "_blank");
  assert.equal(features, "noopener,noreferrer");
  assert.equal(typeof url, "string");
  assert.ok(url.startsWith(`${target}${HASH_KEY}2.`), url.slice(0, 80));
  assert.equal(url.includes("?"), false, "쿼리 없음");
  assert.equal(url.split("#").length, 2, "# 은 하나뿐");
  const hash = url.slice(url.indexOf(HASH_KEY) + HASH_KEY.length);
  assert.ok(hash.length <= core.OPTION_FILL_HASH_MAX_CHARS, `${hash.length}자`);
  assert.equal(run.host.parent, null, "연 뒤 결과창을 닫는다");
  return hash;
}

function decodeDiag(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

// 명세 1절 진단 모양: { v, reason, counts(≤8), keys(≤20) } 만, 키에 상품번호 모양 숫자 없음.
function assertDiagShape(encoded) {
  assert.ok(encoded.length >= 1 && encoded.length <= 2000, `${encoded.length}자`);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  const text = Buffer.from(encoded, "base64url").toString("utf8");
  const diag = JSON.parse(text);
  assert.deepEqual(Object.keys(diag), ["v", "reason", "counts", "keys"]);
  assert.equal(diag.v, "2.1.0");
  assert.ok(SPEC_REASON_CODES.includes(diag.reason), diag.reason);
  assert.ok(diag.counts && typeof diag.counts === "object" && !Array.isArray(diag.counts));
  assert.ok(Object.keys(diag.counts).length <= 8);
  for (const [key, value] of Object.entries(diag.counts)) {
    assert.match(key, /^[A-Za-z]{1,24}$/);
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 10_000_000, `${key}=${value}`);
  }
  assert.ok(Array.isArray(diag.keys) && diag.keys.length <= 20);
  for (const key of diag.keys) assert.match(key, /^[A-Za-z0-9_#.-]{1,40}$/);
  // 상품번호 모양 숫자(5자리 이상)는 이유·키에 없다. counts 값은 개수라(훑은 묶음 수 등) 5자리를 넘을 수 있어 따로 본다.
  assert.equal(/[0-9]{5,}/.test(`${diag.reason} ${diag.keys.join(" ")}`), false, "진단 키에 상품번호 모양 숫자 없음");
  return { diag, text };
}

function assertQuiet(run) {
  assert.deepEqual(run.network, []);
  assert.deepEqual(run.clipboardWrites, []);
  assert.deepEqual(run.execCommands, []);
  for (const tag of run.createdTags) assert.ok(ALLOWED_TAGS.has(tag), tag);
}

test("화면 코드: 요소는 el() 한 곳에서만 만들고, 만들 수 있는 요소 목록이 시험 목록과 같다", () => {
  assert.equal(panelSource.split("document.createElement(").length - 1, 1, "document.createElement 는 el() 안 한 번만");
  const declared = /const PANEL_TAGS = Object\.freeze\(\[([^\]]*)\]\);/.exec(panelSource);
  assert.ok(declared, "panel.js 에 PANEL_TAGS 목록이 있다");
  const tags = [...declared[1].matchAll(/"([a-z0-9]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...tags].sort(), [...ALLOWED_TAGS].sort());
  for (const risky of ["a", "area", "img", "script", "iframe", "link", "form", "audio", "video", "object", "embed", "base", "meta", "textarea", "input"]) {
    assert.equal(tags.includes(risky), false, risky);
  }
  // panel.js 를 혼자 돌려 el() 을 직접 불러 본다(목록 밖 요소는 던짐).
  const run = runBookmarklet({ href: "https://www.naver.com/", state: undefined, source: panelSource, globals: CORE_GLOBALS });
  assert.equal(typeof run.context.el, "function");
  for (const risky of ["a", "img", "script", "iframe", "A", "audio", "form", "textarea", "table"]) {
    assert.throws(() => run.context.el(risky), /만들 수 없는 요소/, risky);
  }
  for (const tag of ALLOWED_TAGS) assert.equal(run.context.el(tag).tagName, tag.toUpperCase());
  assert.deepEqual(run.network, []);
});

test("가짜 화면 기록기가 실제로 잡는다(Audio·링크 누르기·요청 속성·주소 바꾸기, 빈 검사 방지)", () => {
  const cases = [
    ["new Audio('x')", "Audio"],
    ["fetchLater('/x')", "fetchLater"],
    ["open('x')", "open"],
    ["window.open('x')", "open"],
    ["document.createElement('a').click()", "링크 누르기"],
    ["document.createElement('a').href = 'x'", "href 대입"],
    ["document.createElement('a').setAttribute('href', 'x')", "setAttribute href"],
    ["document.createElement('iframe').setAttribute('srcdoc', 'x')", "setAttribute srcdoc"],
    ["document.createElement('form').setAttribute('action', 'x')", "setAttribute action"],
    ["document.createElement('img').src = 'x'", "src 대입"],
    ["location.href = 'x'", "location.href 대입"],
    ["location = 'x'", "location 대입"],
    ["location.assign('x')", "location.assign"],
  ];
  for (const [snippet, name] of cases) {
    const run = runBookmarklet({ href: ISHELL_URL, state: undefined, source: `try { ${snippet}; } catch (error) {}` });
    assert.deepEqual(run.network.map(([recorded]) => recorded), [name], snippet);
  }
});

test("상태·버튼 표(명세 3절): 찾음·확인 못 함(거절·목록 없음)·상품 페이지 아님 — 그 밖의 버튼·표·글 칸·복사 없음, 요청 0", () => {
  const cases = [
    ["찾음", { href: ISHELL_URL, state: groupObjectState() }, [FOUND_TEXT(24)], [SAVE_LABEL, "닫기"]],
    ["거절(옵션 52개)", { href: ISHELL_URL, state: groupOfSize(53) }, [COULD_NOT_TEXT], [MANUAL_LABEL, "닫기"]],
    ["목록 없음(지금 상품 없는 그룹 목록)", { href: DECASA_URL, state: membersWithoutCurrentState() }, [COULD_NOT_TEXT], [MANUAL_LABEL, "닫기"]],
    ["목록 없음(그룹 표시 없음)", { href: DECASA_URL, state: { product: { A: { productNo: Number(DECASA_CURRENT) } } } }, [COULD_NOT_TEXT], [MANUAL_LABEL, "닫기"]],
    ["상품 페이지 아님", { href: "https://www.naver.com/", state: groupObjectState() }, [NOT_PRODUCT_TEXT], ["닫기"]],
    ["상품번호가 서버 규칙(5~20자리) 밖", { href: "https://smartstore.naver.com/i_shell/products/1234", state: groupOfSize(3, "1234") }, [NOT_PRODUCT_TEXT], ["닫기"]],
  ];
  for (const [name, options, statuses, buttons] of cases) {
    const run = runBookmarklet(options);
    assert.ok(run.host && run.host.shadowRoot, name);
    assert.deepEqual(statusLines(run), statuses, name);
    assert.deepEqual(labels(run), buttons, name);
    assert.equal(run.nodes.some((node) => ["TEXTAREA", "TABLE", "DETAILS", "INPUT"].includes(node.tagName)), false, name);
    for (const gone of ["번호 복사", "진단 복사", "진단 정보"]) assert.equal(run.text.includes(gone), false, `${name}: ${gone}`);
    assert.ok(run.text.includes(`버전 ${OPTION_CHECK_VERSION}`));
    for (const value of PRIVATE_VALUES) assert.equal(run.text.includes(value), false, `${name}: ${value}`);
    assertQuiet(run);
  }
  assert.equal(OPTION_CHECK_VERSION, "2.1.0");
});

test("찾음: 상품명 줄만 보이고 번호 표는 없다(번호는 화면에 그리지 않음)", () => {
  const run = runBookmarklet({ href: ISHELL_URL, state: groupObjectState() });
  const nameLine = run.nodes.find((node) => node.className === "nm");
  assert.equal(nameLine.textContent, "아이폰17 사생활보호");
  for (const id of ISHELL_OPTION_IDS) assert.equal(run.text.includes(id), false, id);
  // 이름이 없으면 상품명 줄을 만들지 않는다.
  const bare = runBookmarklet({ href: DECASA_URL, state: groupNumberArrayState({ withNames: false }) });
  assert.deepEqual(statusLines(bare), [FOUND_TEXT(4)]);
  assert.equal(bare.nodes.some((node) => node.className === "nm"), false);
  assertQuiet(run);
  assertQuiet(bare);
});

test("찾음: 주 버튼을 누를 때만 고정 주소 하나를 새 탭으로 연다 — 두 변형, 1회·_blank·noopener,noreferrer·쿼리 없음, 값에 지금 상품 포함", () => {
  for (const variant of ["admin", "client"]) {
    const recorder = openRecorder();
    const run = runBookmarklet({ href: ISHELL_URL, state: groupObjectState(), source: codes[variant], globals: { open: recorder.open } });
    const hash = clickAndRead(run, recorder, SAVE_LABEL, SPEC_TARGETS[variant]);
    const match = SPEC_FOUND.exec(hash);
    assert.ok(match, hash.slice(0, 60));
    assert.equal(match[1], ISHELL_CURRENT);
    const ids = match[2].split("-");
    assert.deepEqual(ids, [ISHELL_CURRENT, ...ISHELL_OPTION_IDS]);
    assert.ok(ids.includes(match[1]), "pageId 포함");
    assert.equal(new Set(ids).size, ids.length, "겹침 없음");
    const url = new URL(recorder.calls[0][0]);
    assert.equal(`${url.origin}${url.pathname}`, SPEC_TARGETS[variant]);
    assert.equal(url.search, "");
    assertQuiet(run);
  }
});

test("찾음 값: 나란한 칸(F4)·JSON 스크립트(깨진 ld+json 무시)에서도 고른 번호가 그대로 넘어간다", () => {
  const recorder = openRecorder();
  const parallel = runBookmarklet({ href: ISHELL_URL, state: groupParallelColumnsState(), globals: { open: recorder.open } });
  assert.deepEqual(statusLines(parallel), [FOUND_TEXT(4)]);
  assert.equal(parallel.nodes.find((node) => node.className === "nm").textContent, "블랙");
  assert.equal(clickAndRead(parallel, recorder, SAVE_LABEL, SPEC_TARGETS.admin), `2.f.${ISHELL_CURRENT}.${PARALLEL_CHANNEL_IDS.join("-")}`);
  assertQuiet(parallel);

  const scriptRecorder = openRecorder();
  const scripted = runBookmarklet({
    href: DECASA_URL,
    state: undefined,
    scripts: [{ type: "application/ld+json", text: "{broken" }, JSON.stringify(groupNumberArrayState())],
    globals: { open: scriptRecorder.open },
  });
  assert.deepEqual(statusLines(scripted), [FOUND_TEXT(4)]);
  assert.equal(scripted.nodes.find((node) => node.className === "nm").textContent, "수건 대표");
  assert.equal(
    clickAndRead(scripted, scriptRecorder, SAVE_LABEL, SPEC_TARGETS.admin),
    `2.f.${DECASA_CURRENT}.${[DECASA_CURRENT, "13744375116", "13744387323", "13744387324"].join("-")}`,
  );
  assertQuiet(scripted);
});

test("확인 못 함(거절): '모먼트에서 직접 입력'은 2.r 값 — 진단은 1절 형식·2000자 이하, 옵션 번호·이름 없음(두 변형)", () => {
  for (const variant of ["admin", "client"]) {
    const recorder = openRecorder();
    const run = runBookmarklet({ href: ISHELL_URL, state: groupOfSize(53), source: codes[variant], globals: { open: recorder.open } });
    const hash = clickAndRead(run, recorder, MANUAL_LABEL, SPEC_TARGETS[variant]);
    const match = SPEC_REFUSED.exec(hash);
    assert.ok(match, hash.slice(0, 60));
    assert.equal(match[1], ISHELL_CURRENT);
    const { diag, text } = assertDiagShape(match[2]);
    assert.equal(diag.reason, "too_many");
    assert.equal(diag.counts.reasonCount, 52);
    assert.equal(diag.counts.chosenCount, 53);
    assert.ok(diag.keys.includes("STATE.groupProduct.products"), diag.keys.join(","));
    assert.equal(text.includes("옵션"), false);
    assert.equal(hash.includes("20000000001"), false);
    assertQuiet(run);
  }
});

test("확인 못 함(목록 없음): 같은 문장·버튼, 진단 이유는 판정 이유 그대로이고 개인정보·상품번호가 없다", () => {
  const cases = [
    [membersWithoutCurrentState(), "group_list_without_current"],
    [{ product: { A: { productNo: Number(DECASA_CURRENT) } } }, "no_group_list"],
  ];
  for (const [state, reason] of cases) {
    const recorder = openRecorder();
    const run = runBookmarklet({ href: DECASA_URL, state, globals: { open: recorder.open } });
    const match = SPEC_REFUSED.exec(clickAndRead(run, recorder, MANUAL_LABEL, SPEC_TARGETS.admin));
    assert.ok(match);
    assert.equal(match[1], DECASA_CURRENT);
    const { diag, text } = assertDiagShape(match[2]);
    assert.equal(diag.reason, reason);
    for (const value of PRIVATE_VALUES) assert.equal(text.includes(value), false, value);
    assertQuiet(run);
  }
});

test("진단 키: 상품번호 모양 키(5자리 이상 숫자)는 '#n' 으로만 나가고, 경로 글자는 칸 규칙에 맞춘다", () => {
  const state = groupObjectState();
  state.groupProduct.byNo = { 15555555554: {}, 15555555555: { groupList: [ISHELL_CURRENT, "15555555556"] } };
  // 키 이름 안에 든 번호도 가린다(M3).
  state.groupProduct.byNo.groupProduct_15555555557 = { groupList_15555555558: [ISHELL_CURRENT, "15555555556"] };
  const recorder = openRecorder();
  const run = runBookmarklet({ href: ISHELL_URL, state, globals: { open: recorder.open } });
  assert.deepEqual(statusLines(run), [COULD_NOT_TEXT]);
  const match = SPEC_REFUSED.exec(clickAndRead(run, recorder, MANUAL_LABEL, SPEC_TARGETS.admin));
  const { diag, text } = assertDiagShape(match[2]);
  assert.equal(diag.reason, "ambiguous");
  assert.ok(text.includes("#n"));
  assert.equal(/1555555555[4-8]/.test(text), false);
  // 40자를 넘는 경로는 끝 쪽(잎 키)을 남기고 앞을 '_' 로 줄인다.
  assert.ok(diag.keys.includes("STATE.groupProduct.byNo.#n.groupList"), diag.keys.join(","));
  assert.ok(diag.keys.includes("_oduct.byNo.groupProduct_#n.groupList_#n"), diag.keys.join(","));
  assertQuiet(run);
});

const UNREADABLE = "source_unreadable";

test("확인 못 함(H4): 깨진 application/json 스크립트·페이지 상태 읽기 오류·값 읽기 오류(F3)면 찾았어도 넘기지 않고 진단만", () => {
  const cases = [
    ["깨진 JSON 스크립트", { href: DECASA_URL, state: undefined, scripts: ["{broken", JSON.stringify(groupNumberArrayState())] }, DECASA_CURRENT],
    ["페이지 상태 읽기 오류", { href: DECASA_URL, stateThrows: true, scripts: [JSON.stringify(groupNumberArrayState())] }, DECASA_CURRENT],
    ["값 읽기 오류(getter)", (() => {
      const state = groupObjectState();
      Object.defineProperty(state.groupProduct, "trap", { enumerable: true, get() { throw new Error("읽기 막힘"); } });
      return { href: ISHELL_URL, state };
    })(), ISHELL_CURRENT],
  ];
  for (const [name, options, pageId] of cases) {
    const recorder = openRecorder();
    const run = runBookmarklet({ ...options, globals: { open: recorder.open } });
    assert.deepEqual(statusLines(run), [COULD_NOT_TEXT], name);
    assert.deepEqual(labels(run), [MANUAL_LABEL, "닫기"], name);
    const match = SPEC_REFUSED.exec(clickAndRead(run, recorder, MANUAL_LABEL, SPEC_TARGETS.admin));
    assert.ok(match, name);
    assert.equal(match[1], pageId);
    const { diag } = assertDiagShape(match[2]);
    assert.equal(diag.reason, UNREADABLE, name);
    assert.ok(diag.counts.unreadable >= 1, name);
    assertQuiet(run);
  }
});

test("데이터 스크립트(H4): id 에 state·data 가 든 스크립트는 JSON 으로 읽고, 안 읽히면 확인 못 함(자바스크립트 코드 스크립트는 빼고)", () => {
  // type 이 없거나 자바스크립트인 코드 스크립트는 id 가 맞아도 못 읽었다고 거절하지 않는다.
  const codeRun = runBookmarklet({
    href: ISHELL_URL,
    state: groupObjectState(),
    scripts: [
      { id: "initial-state", text: "window.__APP_STATE__ = { a: 1 };" },
      { id: "app-data", type: "text/javascript", text: "var x = 1;" },
      { id: "page-data", type: "module", text: "" },
    ],
  });
  assert.deepEqual(statusLines(codeRun), [FOUND_TEXT(24)]);
  assert.ok(codeRun.selectors.every((selector) => selector.includes("script[id]")), "id 로도 스크립트를 고른다");
  // 자바스크립트가 아닌 type(또는 type 없이 JSON 이 든 __NEXT_DATA__)은 데이터로 읽는다.
  const nextData = runBookmarklet({
    href: DECASA_URL,
    state: undefined,
    scripts: [{ id: "__NEXT_DATA__", text: JSON.stringify(groupNumberArrayState()) }],
  });
  assert.deepEqual(statusLines(nextData), [FOUND_TEXT(4)]);
  const broken = runBookmarklet({
    href: ISHELL_URL,
    state: groupObjectState(),
    scripts: [{ id: "server-state", type: "text/x-state", text: "{broken" }],
  });
  assert.deepEqual(statusLines(broken), [COULD_NOT_TEXT]);
  assert.deepEqual(labels(broken), [MANUAL_LABEL, "닫기"]);
  // id 가 state·data 와 상관없는 코드 스크립트는 보지 않는다.
  const unrelated = runBookmarklet({ href: ISHELL_URL, state: groupObjectState(), scripts: [{ id: "gtm", text: "{broken" }] });
  assert.deepEqual(statusLines(unrelated), [FOUND_TEXT(24)]);
  for (const run of [codeRun, nextData, broken, unrelated]) assertQuiet(run);
});

test("실행 중 오류: 상품번호를 알면 '확인 못 함'(진단 runtimeError), 주소부터 못 읽으면 '상품 페이지 아님'", () => {
  const recorder = openRecorder();
  const run = runBookmarklet({
    href: ISHELL_URL,
    state: groupObjectState(),
    source: panelSource,
    globals: { ...CORE_GLOBALS, findGroupOptions: () => { throw new Error("판정 오류"); }, open: recorder.open },
  });
  assert.deepEqual(statusLines(run), [COULD_NOT_TEXT]);
  assert.deepEqual(labels(run), [MANUAL_LABEL, "닫기"]);
  // panel.js 혼자 돌리면 고정 주소 자리 글자가 그대로다(빌드가 바꿔 끼움).
  const match = SPEC_REFUSED.exec(clickAndRead(run, recorder, MANUAL_LABEL, "__MI_OPTION_FILL_TARGET__"));
  assert.ok(match);
  const { diag } = assertDiagShape(match[2]);
  assert.equal(diag.reason, UNREADABLE);
  assert.deepEqual(diag.counts, { runtimeError: 1 });
  assert.deepEqual(diag.keys, []);
  assertQuiet(run);

  const noPage = runBookmarklet({
    href: ISHELL_URL,
    state: groupObjectState(),
    source: panelSource,
    globals: { ...CORE_GLOBALS, productPageFromUrl: () => { throw new Error("주소 오류"); } },
  });
  assert.deepEqual(statusLines(noPage), [NOT_PRODUCT_TEXT]);
  assert.deepEqual(labels(noPage), ["닫기"]);
  assertQuiet(noPage);
});

test("화면: 다시 누르면 이전 패널을 지우고 하나만 남는다, '닫기'는 패널만 떼고 창을 열지 않는다", () => {
  const first = runBookmarklet({ href: ISHELL_URL, state: groupObjectState() });
  const second = runBookmarklet({ href: ISHELL_URL, state: groupObjectState(), body: first.pageBody });
  assert.equal(second.pageBody.children.filter((node) => node.id === "mi-option-check-host").length, 1);
  button(second, "닫기").click();
  assert.equal(second.pageBody.children.length, 0);
  // open 은 요청 기록기 그대로라 불렸다면 network 에 남는다.
  assert.deepEqual(second.network, []);
  const notProduct = runBookmarklet({ href: "https://www.naver.com/", state: undefined });
  button(notProduct, "닫기").click();
  assert.equal(notProduct.pageBody.children.length, 0);
  assert.deepEqual(notProduct.network, []);
});

test("주 버튼: 창 열기가 막혀(던져) 실패하면 결과창을 남겨 다시 누를 수 있다", () => {
  const run = runBookmarklet({ href: ISHELL_URL, state: groupObjectState(), globals: { open: () => { throw new Error("막힘"); } } });
  button(run, SAVE_LABEL).click();
  assert.equal(run.pageBody.children.filter((node) => node.id === "mi-option-check-host").length, 1);
  assert.deepEqual(run.network, []);
});
