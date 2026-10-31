// 묶은 즐겨찾기 버튼(build.mjs 결과) 시험: 금지 코드 정적 검사 + 가짜 화면(DOM)에서 실제로 돌려 보기.
// 가짜 화면에는 요청 함수 자리마다 기록기를 두어, 한 번이라도 불리면 실패한다. 실제 네이버 페이지는 열지 않는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { bookmarkletHref, buildBookmarkletCode, findForbiddenCode } from "../build.mjs";
import { OPTION_CHECK_VERSION, findGroupOptions, productPageFromUrl } from "../src/core.mjs";
import {
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

const code = buildBookmarkletCode();
const panelSource = fs.readFileSync(new URL("../src/panel.js", import.meta.url), "utf8");

// build.mjs 의 금지 목록과 따로, 명세(impl-spec 4절)에 적힌 금지를 여기서 다시 적는다(목록이 약해져도 시험이 잡게).
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
  ["글자 조합 속성 접근", /\[\s*["'`][^\]\n]*["'`]\s*\+|\[\s*`[^`\]]*\$\{/],
];

test("금지 코드: 묶은 코드에 요청·주소 이동·HTML 끼워 넣기 코드가 없다", () => {
  for (const [name, pattern] of SPEC_FORBIDDEN) assert.equal(pattern.test(code), false, name);
  assert.deepEqual(findForbiddenCode(code), []);
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
  ]) {
    assert.ok(findForbiddenCode(sample).length > 0, sample);
  }
  assert.deepEqual(findForbiddenCode("const page = new URL(String(location.href)); const x = location.href;"), []);
  // 화면 코드가 쓰는 모양은 잡지 않는다.
  for (const sample of [
    'panel.setAttribute("role", "dialog")', 'area.setAttribute("aria-label", label)', 'attachShadow({ mode: "open" })',
    'button.addEventListener("click", copy)', "names[entry.index]",
  ]) {
    assert.deepEqual(findForbiddenCode(sample), [], sample);
  }
});

test("화면 코드: 그림자 DOM·textContent 만 쓴다", () => {
  assert.ok(panelSource.includes("attachShadow"));
  assert.ok(panelSource.includes("textContent"));
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(panelSource), false);
});

test("묶은 코드: 문법이 맞고, 한 함수로 감싸 반환값이 없다(페이지를 덮어쓰지 않음)", () => {
  assert.doesNotThrow(() => new vm.Script(code));
  assert.ok(code.startsWith("(() => {\n\"use strict\";\n"));
  assert.ok(code.endsWith("})();\n"));
  assert.equal(/^\s*(export|import)\b/m.test(code), false);
});

test("javascript: 주소: 되돌리면 같은 코드이고 HTML 특수 글자·#·공백이 없다", () => {
  const href = bookmarkletHref(code);
  assert.ok(href.startsWith("javascript:"));
  assert.equal(decodeURIComponent(href.slice("javascript:".length)), code);
  assert.equal(/[&<>"'#\s]/.test(href), false);
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
  // (화면 코드가 window 로 읽는 것은 __PRELOADED_STATE__ 하나뿐).
  context.window = stateThrows
    ? {
      get __PRELOADED_STATE__() {
        throw new Error("읽기 막힘");
      },
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

const tick = () => new Promise((resolve) => setImmediate(resolve));
const button = (run, label) => run.buttons.find((node) => node.textContent === label);
const ALLOWED_TAGS = new Set(["div", "style", "h1", "table", "tr", "td", "span", "textarea", "button", "details", "summary"]);

test("화면 코드: 요소는 el() 한 곳에서만 만들고, 만들 수 있는 요소 목록이 시험 목록과 같다", () => {
  assert.equal(panelSource.split("document.createElement(").length - 1, 1, "document.createElement 는 el() 안 한 번만");
  const declared = /const PANEL_TAGS = Object\.freeze\(\[([^\]]*)\]\);/.exec(panelSource);
  assert.ok(declared, "panel.js 에 PANEL_TAGS 목록이 있다");
  const tags = [...declared[1].matchAll(/"([a-z0-9]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...tags].sort(), [...ALLOWED_TAGS].sort());
  for (const risky of ["a", "area", "img", "script", "iframe", "link", "form", "audio", "video", "object", "embed", "base", "meta"]) {
    assert.equal(tags.includes(risky), false, risky);
  }
  // panel.js 를 혼자 돌려 el() 을 직접 불러 본다(목록 밖 요소는 던짐).
  const run = runBookmarklet({
    href: "https://www.naver.com/",
    state: undefined,
    source: panelSource,
    globals: { OPTION_CHECK_VERSION, findGroupOptions, productPageFromUrl },
  });
  assert.equal(typeof run.context.el, "function");
  for (const risky of ["a", "img", "script", "iframe", "A", "audio", "form"]) {
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

test("화면: 진단 복사에 상품번호 모양 키(5자리 이상 숫자)가 '#n' 으로만 나가고, 번호는 지금 상품뿐이다", async () => {
  const state = groupObjectState();
  state.groupProduct.byNo = { 15555555554: {}, 15555555555: { groupList: [ISHELL_CURRENT, "15555555556"] } };
  // 키 이름 안에 든 번호도 가린다(M3).
  state.groupProduct.byNo.groupProduct_15555555557 = { groupList_15555555558: [ISHELL_CURRENT, "15555555556"] };
  const run = runBookmarklet({ href: ISHELL_URL, state });
  assert.ok(run.text.includes("이 페이지는 버튼으로 다 읽지 못했습니다"));
  assert.ok(run.text.includes("groupProduct_#n"));
  assert.equal(/1555555555[4-8]/.test(run.text), false, "화면 진단 정보에도 없다");
  button(run, "진단 복사").click();
  await tick();
  const diagText = run.clipboardWrites[0];
  assert.ok(diagText.includes("#n"));
  assert.deepEqual([...new Set(diagText.match(/[0-9]{5,}/g) || [])], [ISHELL_CURRENT]);
  assert.deepEqual(run.network, []);
});

test("화면: 그룹 목록을 찾으면 개수·표·'번호 복사'·붙여 넣기 안내, 요청 0", async () => {
  const run = runBookmarklet({ href: ISHELL_URL, state: groupObjectState() });
  assert.ok(run.host, "패널이 붙는다");
  assert.ok(run.host.shadowRoot, "그림자 DOM");
  assert.ok(run.text.includes("그룹 옵션 24개를 찾았습니다(지금 상품 포함)"));
  assert.ok(run.text.includes("인사이트 옵션 편집창에 붙여 넣고 미리 보기 하세요"));
  assert.ok(run.text.includes(" ← 지금"));
  assert.ok(run.text.includes("옵션 0"));
  assert.equal(run.tables.length, 1);
  assert.equal(run.tables[0].children.length, 24);
  assert.ok(button(run, "번호 복사"));
  assert.ok(button(run, "진단 복사"));
  assert.ok(button(run, "닫기"));
  // 번호 칸은 숨겨 둔다(클립보드가 될 때는 보이지 않음).
  const numberArea = run.areas.find((node) => node.getAttribute("aria-label") === "옵션 번호 목록");
  assert.equal(numberArea.style.display, "none");
  button(run, "번호 복사").click();
  await tick();
  assert.deepEqual(run.clipboardWrites, [[ISHELL_CURRENT, ...ISHELL_OPTION_IDS].join("\n")]);
  assert.equal(numberArea.style.display, "none");
  assert.ok(run.text.length > 0);
  assert.ok(allNodes(run.host).some((node) => node.textContent.startsWith("복사했습니다.")));
  // 진단 복사: 값 없는 진단(개인정보·이름 없음)
  button(run, "진단 복사").click();
  await tick();
  const diagText = run.clipboardWrites[1];
  const diag = JSON.parse(diagText);
  assert.equal(diag.status, "found");
  assert.equal(diag.page, `i_shell/${ISHELL_CURRENT}`);
  for (const value of [...PRIVATE_VALUES, "옵션 0", "아이폰17 사생활보호"]) assert.equal(diagText.includes(value), false, value);
  assert.deepEqual(run.network, []);
  for (const tag of run.createdTags) assert.ok(ALLOWED_TAGS.has(tag), tag);
});

test("화면: 클립보드가 막히면 그때만 번호 칸을 보여 선택해 둔다", async () => {
  const run = runBookmarklet({ href: ISHELL_URL, state: groupObjectState(), clipboard: "fail" });
  const numberArea = run.areas.find((node) => node.getAttribute("aria-label") === "옵션 번호 목록");
  assert.equal(numberArea.style.display, "none");
  button(run, "번호 복사").click();
  await tick();
  assert.equal(numberArea.style.display, "block");
  assert.equal(numberArea.selected, true);
  assert.equal(numberArea.value, [ISHELL_CURRENT, ...ISHELL_OPTION_IDS].join("\n"));
  assert.deepEqual(run.execCommands, ["copy"]);
  assert.ok(allNodes(run.host).some((node) => node.textContent.startsWith("자동 복사가 막혔습니다")));
  // 클립보드 기능이 아예 없어도 같은 길로 간다.
  const none = runBookmarklet({ href: ISHELL_URL, state: groupObjectState(), clipboard: "none", execCommandResult: true });
  button(none, "번호 복사").click();
  const area = none.areas.find((node) => node.getAttribute("aria-label") === "옵션 번호 목록");
  assert.equal(area.style.display, "block");
  assert.deepEqual(none.network, []);
});

test("화면: 거절이면 번호 표·번호 칸·'번호 복사'를 아예 만들지 않고 이유를 보여 준다", async () => {
  const state = groupOfSize(53);
  const run = runBookmarklet({ href: ISHELL_URL, state, clipboard: "fail" });
  assert.ok(run.text.includes("이 페이지는 버튼으로 다 읽지 못했습니다 — 인사이트 편집창에 손으로 입력해 주세요"));
  assert.ok(run.text.includes("지금 상품을 뺀 옵션이 52개라 저장 한도 50개를 넘습니다."));
  assert.equal(button(run, "번호 복사"), undefined);
  assert.equal(run.tables.length, 0);
  assert.deepEqual(run.areas.map((node) => node.getAttribute("aria-label")), ["진단 정보"]);
  // 진단 칸(클립보드 실패로 보이게 돼도)에는 옵션 번호가 없다.
  button(run, "진단 복사").click();
  await tick();
  const diagArea = run.areas[0];
  assert.equal(diagArea.style.display, "block");
  assert.equal(diagArea.value.includes("20000000001"), false);
  assert.equal(diagArea.value.includes(ISHELL_CURRENT), true, "페이지 표시(지금 상품번호)는 남는다");
  assert.deepEqual(run.network, []);
});

test("화면: 지금 상품이 든 그룹 목록이 없으면 '못 찾음' 안내만", () => {
  const run = runBookmarklet({ href: DECASA_URL, state: membersWithoutCurrentState() });
  assert.ok(run.text.includes("못 찾음 — 인사이트 편집창에 손으로 입력해 주세요"));
  assert.ok(run.text.includes("그룹 목록은 있지만 지금 상품번호가 든 목록이 없습니다."));
  assert.equal(button(run, "번호 복사"), undefined);
  assert.equal(run.tables.length, 0);
  for (const value of PRIVATE_VALUES) assert.equal(run.text.includes(value), false, value);
  assert.deepEqual(run.network, []);
});

test("화면: JSON 스크립트에만 그룹 목록이 있어도 찾고, 깨진 검색용 정보(ld+json)는 건너뛰되 진단에 센다", async () => {
  const run = runBookmarklet({
    href: DECASA_URL,
    state: undefined,
    scripts: [{ type: "application/ld+json", text: "{broken" }, JSON.stringify(groupNumberArrayState())],
  });
  assert.ok(run.text.includes("그룹 옵션 4개를 찾았습니다(지금 상품 포함)"));
  assert.ok(run.text.includes("수건 1"));
  assert.ok(run.text.includes("못 읽은 검색용 정보(ld+json) 1개(무시)"));
  button(run, "진단 복사").click();
  await tick();
  const diag = JSON.parse(run.clipboardWrites[0]);
  assert.equal(diag.sources.ldJsonErrors, 1);
  assert.equal(diag.sources.unreadable, 0);
  assert.deepEqual(run.network, []);
});

const UNREADABLE_TEXT = "페이지 데이터 일부를 읽지 못했습니다.";

test("화면(H4): 깨진 application/json 스크립트가 하나라도 있으면 그룹 목록을 찾았어도 거절", () => {
  const run = runBookmarklet({
    href: DECASA_URL,
    state: undefined,
    scripts: ["{broken", JSON.stringify(groupNumberArrayState())],
  });
  assert.ok(run.text.includes("이 페이지는 버튼으로 다 읽지 못했습니다 — 인사이트 편집창에 손으로 입력해 주세요"));
  assert.ok(run.text.includes(UNREADABLE_TEXT));
  assert.ok(run.text.includes("못 읽은 JSON 스크립트 1개"));
  assert.equal(button(run, "번호 복사"), undefined);
  assert.equal(run.tables.length, 0);
  assert.deepEqual(run.network, []);
});

test("화면(H4): 페이지 상태 객체를 읽다 오류가 나면 JSON 스크립트에서 찾았어도 거절", () => {
  const run = runBookmarklet({
    href: DECASA_URL,
    stateThrows: true,
    scripts: [JSON.stringify(groupNumberArrayState())],
  });
  assert.ok(run.text.includes("이 페이지는 버튼으로 다 읽지 못했습니다"));
  assert.ok(run.text.includes(UNREADABLE_TEXT));
  assert.ok(run.text.includes("페이지 상태 읽기 실패"));
  assert.equal(button(run, "번호 복사"), undefined);
  assert.deepEqual(run.network, []);
});

test("화면(F3): 페이지 상태 안의 값을 읽다 오류가 나면(getter) 그룹 목록을 찾았어도 거절하고 진단에 센다", () => {
  const state = groupObjectState();
  Object.defineProperty(state.groupProduct, "trap", { enumerable: true, get() { throw new Error("읽기 막힘"); } });
  const run = runBookmarklet({ href: ISHELL_URL, state });
  assert.ok(run.text.includes("이 페이지는 버튼으로 다 읽지 못했습니다"));
  assert.ok(run.text.includes(UNREADABLE_TEXT));
  assert.match(run.text, /읽기 오류 [1-9][0-9]*번/);
  assert.equal(button(run, "번호 복사"), undefined);
  assert.equal(run.tables.length, 0);
  assert.deepEqual(run.network, []);
});

test("화면(F4): 채널 번호 목록 옆 원상품 번호 목록(나란한 칸)이 있어도 채널 번호·이름을 찾고, 진단에 나란한 칸을 적는다", async () => {
  const run = runBookmarklet({ href: ISHELL_URL, state: groupParallelColumnsState() });
  assert.ok(run.text.includes("그룹 옵션 4개를 찾았습니다(지금 상품 포함)"));
  assert.ok(run.text.includes("화이트"));
  assert.ok(run.text.includes("나란한 번호 칸(조각 아님) 1개: STATE.groupProduct.originalProductNos (4개)"));
  button(run, "번호 복사").click();
  await tick();
  assert.deepEqual(run.clipboardWrites, [PARALLEL_CHANNEL_IDS.join("\n")]);
  assert.deepEqual(run.network, []);
});

test("화면(H4): id 에 state·data 가 든 스크립트는 JSON 으로 읽고, 안 읽히면 거절한다(자바스크립트 코드 스크립트는 빼고)", () => {
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
  assert.ok(codeRun.text.includes("그룹 옵션 24개를 찾았습니다(지금 상품 포함)"));
  assert.ok(codeRun.text.includes("JSON 이 아닌 코드 스크립트 2개(무시)"));
  assert.ok(codeRun.selectors.every((selector) => selector.includes("script[id]")), "id 로도 스크립트를 고른다");
  // 자바스크립트가 아닌 type(또는 type 없이 JSON 이 든 __NEXT_DATA__)은 데이터로 읽는다.
  const nextData = runBookmarklet({
    href: DECASA_URL,
    state: undefined,
    scripts: [{ id: "__NEXT_DATA__", text: JSON.stringify(groupNumberArrayState()) }],
  });
  assert.ok(nextData.text.includes("그룹 옵션 4개를 찾았습니다(지금 상품 포함)"));
  const broken = runBookmarklet({
    href: ISHELL_URL,
    state: groupObjectState(),
    scripts: [{ id: "server-state", type: "text/x-state", text: "{broken" }],
  });
  assert.ok(broken.text.includes("이 페이지는 버튼으로 다 읽지 못했습니다"));
  assert.ok(broken.text.includes(UNREADABLE_TEXT));
  assert.equal(button(broken, "번호 복사"), undefined);
  // id 가 state·data 와 상관없는 코드 스크립트는 보지 않는다.
  const unrelated = runBookmarklet({ href: ISHELL_URL, state: groupObjectState(), scripts: [{ id: "gtm", text: "{broken" }] });
  assert.ok(unrelated.text.includes("그룹 옵션 24개를 찾았습니다(지금 상품 포함)"));
  for (const run of [codeRun, nextData, broken, unrelated]) assert.deepEqual(run.network, []);
});

test("화면: 상품 페이지가 아니면 안내만 하고 데이터를 훑지 않는다", () => {
  const run = runBookmarklet({ href: "https://www.naver.com/", state: groupObjectState() });
  assert.ok(run.text.includes("스마트스토어 상품 페이지에서 눌러 주세요"));
  assert.equal(button(run, "번호 복사"), undefined);
  assert.equal(run.tables.length, 0);
  assert.deepEqual(run.network, []);
});

test("화면: 다시 누르면 이전 패널을 지우고 하나만 남는다, '닫기'는 패널을 뗀다", () => {
  const first = runBookmarklet({ href: ISHELL_URL, state: groupObjectState() });
  const second = runBookmarklet({ href: ISHELL_URL, state: groupObjectState(), body: first.pageBody });
  assert.equal(second.pageBody.children.filter((node) => node.id === "mi-option-check-host").length, 1);
  button(second, "닫기").click();
  assert.equal(second.pageBody.children.length, 0);
});
