// 모먼트 옵션 확인 즐겨찾기 버튼 만들기(formal-plan A, impl-spec 4절 → advertiser-impl-spec 3절, 2.1.0).
//
// src/core.mjs(판정, export 를 걷어 냄) + src/panel.js(화면)를 한 함수로 묶고, panel.js 의 OPTION_FILL_TARGET 자리에
// 고정 인사이트 주소를 박아 두 변형을 만든다.
//   dist/bookmarklet-admin.js · dist/bookmarklet-admin-href.txt   — 관리자 화면용(…/admin)
//   dist/bookmarklet-client.js · dist/bookmarklet-client-href.txt — 광고주 화면용(…/client)
// (.js 는 사람이 읽는 확인용 묶은 코드, -href.txt 는 즐겨찾기에 넣는 javascript: 주소). dist/ 는 저장소에 넣지 않는다(.gitignore).
//
// node tools/naver-option-check/build.mjs [--out <폴더>] [--embed <화면 파일>]…
// --embed: 여러 번 줄 수 있다. 파일마다 변형을 정한다 — src/pages/admin.html → …/admin, src/pages/client.html → …/client,
//   그 밖의 파일이면 실패. <!-- mi-option-check-bookmarklet:start --> … <!-- mi-option-check-bookmarklet:end --> 사이 링크 하나의
//   href 만 그 변형의 주소로 바꾼다(다른 속성·글자·표식 밖 내용은 그대로). 표식이 없거나 두 번 이상 있거나 순서가 틀리거나,
//   사이에 href 가 있는 링크가 정확히 1개가 아니면 실패한다. 한 파일이라도 실패하면 어느 파일도 쓰지 않는다.
//
// 만들지 않는 경우(큰 소리로 실패)
// - core.mjs 의 자리 수·개수 규칙이 서버(src/server/naver-rank-option-group.mjs)와 다르다.
// - 묶은 코드에 요청·주소 이동·HTML 끼워 넣기 같은 금지 코드가 보인다(FORBIDDEN_CODE_PATTERNS).
// - 창 열기(window.open)가 정확히 1곳이 아니거나, 그 첫 인자가 고정 주소 상수(OPTION_FILL_TARGET)로 시작하지 않는다.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  OPTION_PRODUCT_IDS_MAX,
  OPTION_PRODUCT_ID_MAX_DIGITS,
  OPTION_PRODUCT_ID_MIN_DIGITS,
} from "./src/core.mjs";

export const TOOL_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TOOL_ROOT, "..", "..");
export const SERVER_RULE_FILE = "src/server/naver-rank-option-group.mjs";
export const MARKER_START = "<!-- mi-option-check-bookmarklet:start -->";
export const MARKER_END = "<!-- mi-option-check-bookmarklet:end -->";
export const HREF_MAX_CHARS = 200_000;
// 버튼이 여는 주소는 이 둘뿐이다(advertiser-impl-spec 1절). 버튼 안에서 주소를 조합하지 않고 빌드가 상수로 박는다.
export const OPTION_FILL_TARGETS = Object.freeze({
  admin: "https://insight.momentlabs.co.kr/admin",
  client: "https://insight.momentlabs.co.kr/client",
});
export const OPTION_FILL_VARIANTS = Object.freeze(Object.keys(OPTION_FILL_TARGETS));
// --embed 가 받는 화면 파일(저장소 기준 경로 끝) → 변형.
export const EMBED_PAGE_VARIANTS = Object.freeze({ "src/pages/admin.html": "admin", "src/pages/client.html": "client" });
// panel.js 의 자리 글자. 빌드가 정확히 1번 바꿔 끼운다.
export const TARGET_PLACEHOLDER_LINE = 'const OPTION_FILL_TARGET = "__MI_OPTION_FILL_TARGET__";';
// 허용하는 창 열기 한 곳의 모양: window.open( 바로 뒤가 고정 주소 상수 + … 인 식.
const ALLOWED_OPEN = /\bwindow\s*\.\s*open\s*\(\s*OPTION_FILL_TARGET\s*\+/g;

// 묶은 코드에 있으면 안 되는 것. 시험(test/bookmarklet.test.mjs)은 이 목록과 별도로 같은 금지를 다시 검사한다.
// 글자로 찾는 검사라 완전하지 않다. 그래서 화면 코드는 만들 수 있는 요소를 목록으로 묶고(panel.js PANEL_TAGS),
// 시험은 가짜 화면에서 요청·이동 자리마다 기록기를 두어 실제로 불리는지도 본다.
export const FORBIDDEN_CODE_PATTERNS = Object.freeze([
  // fetchLater·prefetch 같은 변형도 함께 막는다.
  ["fetch", /fetch/i],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["sendBeacon", /sendBeacon/],
  ["WebSocket", /WebSocket/],
  ["EventSource", /EventSource/],
  ["new Image", /\bnew\s+Image\b|\bImage\s*\(/],
  ["Audio", /\bAudio\b/],
  ["import", /\bimport\b/],
  ["src 대입", /\.\s*src(set)?\s*=(?!=)|["'`]src(set)?["'`]/],
  ["요청 속성 대입", /\.\s*(?:href|srcdoc|action|formAction|ping|poster)\s*=(?!=)/i],
  ["요청 속성 쓰기", /setAttribute\s*\(\s*["'`](?:href|src|srcset|srcdoc|action|formaction|ping|poster|data|background|xlink:href)["'`]|setAttributeNS/i],
  ["location 변경", /\blocation\s*=(?!=)|\blocation\s*\.\s*(href|hash|search|pathname|host|hostname|protocol|port)\s*=(?!=)|\blocation\s*\.\s*(assign|replace|reload)\b/],
  // window.open(…) 뿐 아니라 그냥 open(…)·["open"] 도 막는다. 허용하는 한 곳(ALLOWED_OPEN)은 findForbiddenCode 가 미리 걷는다.
  ["창 열기", /\bopen\s*\(|\[\s*["'`]open["'`]\s*\]/],
  ["링크 누르기", /\.\s*click\s*\(|dispatchEvent|\bMouseEvent\b|\bPointerEvent\b/],
  ["HTML 끼워 넣기", /innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write/],
  ["요청 요소 만들기", /createElement\(\s*["'`](a|area|img|image|script|iframe|link|form|input|object|embed|audio|video|source|track|frame|base|meta|portal|svg)["'`]|createElementNS/i],
  // new URL(…) 은 주소 글자를 나눠 읽기만 하므로 뺀다. CSS 의 url(…) 은 대소문자 모두 막는다.
  ["CSS 바깥 자원", /(?<!new\s)\burl\s*\(|@import/i],
  ["다른 창·작업자 통신", /postMessage|\bWorker\b|serviceWorker|RTCPeerConnection|BroadcastChannel/],
  ["코드 실행", /\beval\b|new\s+Function|\bFunction\s*\(|set(?:Timeout|Interval)\s*\(\s*["'`]/],
  // 이름을 글자 조각으로 만들어 숨기는 접근(window["fe" + "tch"], self[`fe${x}`] 같은 것)을 어림으로 막는다.
  ["전역 우회 접근", /\b(?:window|self|top|parent|frames|document|navigator|location)\s*\[|\bglobalThis\b|\bReflect\b|\bProxy\b|\.\s*constructor\b/],
  ["글자 조합 속성 접근", /\[\s*["'`][^\]\n]*["'`]\s*\+|\+\s*["'`][^[\n]*["'`]\s*\]|\[\s*`[^`\]]*\$\{/],
  ["숨긴 글자 풀기", /\batob\b|fromCharCode|fromCodePoint|\bunescape\b|\bdecodeURI(?:Component)?\b/],
  ["브라우저 저장소", /document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|caches\s*\./],
  ["양식 보내기", /\.\s*submit\s*\(|requestSubmit/],
]);

export function countAllowedOpens(code) {
  return [...String(code).matchAll(ALLOWED_OPEN)].length;
}

// 허용 모양의 창 열기가 정확히 1곳이면 그 한 곳만 걷고 나머지를 검사한다(2곳 이상이면 아무것도 걷지 않아 '창 열기'로 걸림).
// 고정 주소 상수를 다른 값으로 다시 선언·대입하는 코드도 막는다(첫 인자가 늘 빌드가 박은 주소로 시작하게).
export function findForbiddenCode(code) {
  const text = String(code);
  const checked = countAllowedOpens(text) === 1 ? text.replace(ALLOWED_OPEN, "allowedOpenSlot(OPTION_FILL_TARGET +") : text;
  const found = FORBIDDEN_CODE_PATTERNS.filter(([, pattern]) => pattern.test(checked)).map(([name]) => name);
  if ((text.match(/\bOPTION_FILL_TARGET\s*=(?!=)/g) || []).length > 1) found.push("고정 주소 상수 다시 대입");
  return found;
}

// 서버 파일을 불러오지 않고 글자에서 규칙 값만 읽는다(서버 쪽 import 사슬을 빌드에 끌어오지 않으려고).
export function readServerOptionRules(repoRoot = REPO_ROOT) {
  const source = fs.readFileSync(path.join(repoRoot, SERVER_RULE_FILE), "utf8");
  const read = (name) => {
    const matches = [...source.matchAll(new RegExp(`^export const ${name} = ([0-9_]+);`, "gm"))];
    if (matches.length !== 1) throw new Error(`naver-option-check: ${SERVER_RULE_FILE} 에서 ${name} 를 정확히 1번 찾지 못했습니다(${matches.length}번)`);
    return Number(matches[0][1].replaceAll("_", ""));
  };
  return {
    OPTION_PRODUCT_IDS_MAX: read("OPTION_PRODUCT_IDS_MAX"),
    OPTION_PRODUCT_ID_MIN_DIGITS: read("OPTION_PRODUCT_ID_MIN_DIGITS"),
    OPTION_PRODUCT_ID_MAX_DIGITS: read("OPTION_PRODUCT_ID_MAX_DIGITS"),
  };
}

export function assertServerRulesMatch(repoRoot = REPO_ROOT) {
  const server = readServerOptionRules(repoRoot);
  const core = { OPTION_PRODUCT_IDS_MAX, OPTION_PRODUCT_ID_MIN_DIGITS, OPTION_PRODUCT_ID_MAX_DIGITS };
  for (const [name, value] of Object.entries(server)) {
    if (core[name] !== value) {
      throw new Error(`naver-option-check: core.mjs ${name}=${core[name]} 이 서버 규칙 ${value} 과 다릅니다. core.mjs 를 서버에 맞추세요.`);
    }
  }
  return server;
}

// 줄 맨 앞 주석·빈 줄·앞뒤 공백만 걷는다(글자·정규식 안은 건드리지 않게 줄 끝 주석은 쓰지 않는다).
function stripSource(source) {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .join("\n");
}

export function targetForVariant(variant) {
  if (!Object.hasOwn(OPTION_FILL_TARGETS, variant)) {
    throw new Error(`naver-option-check: 변형은 ${OPTION_FILL_VARIANTS.join("·")} 중 하나여야 합니다(${String(variant).slice(0, 20)})`);
  }
  return OPTION_FILL_TARGETS[variant];
}

// variant: "admin" | "client". 그 변형의 고정 주소를 panel.js 자리에 박은 묶은 코드를 돌려준다.
export function buildBookmarkletCode({ variant, toolRoot = TOOL_ROOT } = {}) {
  const target = targetForVariant(variant);
  const coreSource = fs.readFileSync(path.join(toolRoot, "src", "core.mjs"), "utf8");
  const panelSource = fs.readFileSync(path.join(toolRoot, "src", "panel.js"), "utf8");
  const core = stripSource(coreSource).replace(/^export\s+(?=(?:const|function|let|class)\b)/gm, "");
  let panel = stripSource(panelSource);
  for (const [name, part] of [["core.mjs", core], ["panel.js", panel]]) {
    if (/^\s*(?:export|import)\b/m.test(part)) throw new Error(`naver-option-check: ${name} 에 묶을 수 없는 export/import 가 남았습니다`);
  }
  const placeholders = panel.split("\n").filter((line) => line === TARGET_PLACEHOLDER_LINE).length;
  if (placeholders !== 1 || countOf(panel, "__MI_OPTION_FILL_TARGET__") !== 1) {
    throw new Error(`naver-option-check: panel.js 에 고정 주소 자리(${TARGET_PLACEHOLDER_LINE})가 정확히 1줄이어야 합니다(${placeholders}줄)`);
  }
  panel = panel.replace(TARGET_PLACEHOLDER_LINE, `const OPTION_FILL_TARGET = ${JSON.stringify(target)};`);
  const code = `(() => {\n"use strict";\n${core}\n${panel}\n})();\n`;
  new vm.Script(code, { filename: "naver-option-check-bookmarklet.js" });
  const forbidden = findForbiddenCode(code);
  if (forbidden.length) throw new Error(`naver-option-check: 금지 코드가 있습니다: ${forbidden.join(", ")}`);
  const opens = countAllowedOpens(code);
  if (opens !== 1) throw new Error(`naver-option-check: 고정 주소로 여는 창 열기가 정확히 1곳이어야 합니다(${opens}곳)`);
  return code;
}

// --embed 파일 → 변형. 저장소 기준 경로(src/pages/admin.html·src/pages/client.html)로 끝나는 파일만 받는다.
export function variantForEmbedPath(filePath) {
  const normalized = path.resolve(String(filePath)).split(path.sep).join("/");
  for (const [suffix, variant] of Object.entries(EMBED_PAGE_VARIANTS)) {
    if (normalized.endsWith(`/${suffix}`)) return variant;
  }
  throw new Error(`naver-option-check: --embed 는 ${Object.keys(EMBED_PAGE_VARIANTS).join("·")} 만 받습니다(${shownPath(filePath)})`);
}

// 주소 안에 HTML 특수 글자(&<>"')·# 이 하나도 남지 않게 만든다(' 는 %27 로).
export function bookmarkletHref(code) {
  const href = `javascript:${encodeURIComponent(code).replace(/'/g, "%27")}`;
  if (href.length > HREF_MAX_CHARS) throw new Error(`naver-option-check: 주소가 너무 깁니다(${href.length}자)`);
  if (/[&<>"'#\s]/.test(href)) throw new Error("naver-option-check: 주소에 HTML 특수 글자가 남았습니다");
  return href;
}

export function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function unescapeAttribute(value) {
  return String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name]);
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

// 표식 사이 구간과 그 안의 링크 여는 태그 하나를 찾는다. 표식이 아예 없으면 null, 모양이 틀리면 던진다.
function locateAnchor(html, { required }) {
  const starts = countOf(html, MARKER_START);
  const ends = countOf(html, MARKER_END);
  if (starts === 0 && ends === 0 && !required) return null;
  if (starts !== 1 || ends !== 1) throw new Error(`naver-option-check: 표식이 정확히 1쌍이어야 합니다(시작 ${starts}개, 끝 ${ends}개)`);
  const from = html.indexOf(MARKER_START) + MARKER_START.length;
  const to = html.indexOf(MARKER_END);
  if (to < from) throw new Error("naver-option-check: 끝 표식이 시작 표식보다 앞에 있습니다");
  const inner = html.slice(from, to);
  const anchors = [...inner.matchAll(/<a\b[^>]*>/gi)];
  if (anchors.length !== 1) throw new Error(`naver-option-check: 표식 사이에 링크가 정확히 1개여야 합니다(${anchors.length}개)`);
  const tag = anchors[0][0];
  const hrefs = [...tag.matchAll(/\shref="([^"]*)"/gi)];
  if (hrefs.length !== 1) throw new Error(`naver-option-check: 링크에 큰따옴표 href 가 정확히 1개여야 합니다(${hrefs.length}개)`);
  return { from, to, inner, tag, tagIndex: anchors[0].index, href: hrefs[0] };
}

export function readEmbeddedHref(html) {
  const found = locateAnchor(html, { required: false });
  return found ? unescapeAttribute(found.href[1]) : null;
}

export function embedBookmarklet(html, href) {
  const found = locateAnchor(html, { required: true });
  const hrefAttr = found.href;
  const newTag = `${found.tag.slice(0, hrefAttr.index)} href="${escapeAttribute(href)}"${found.tag.slice(hrefAttr.index + hrefAttr[0].length)}`;
  const inner = `${found.inner.slice(0, found.tagIndex)}${newTag}${found.inner.slice(found.tagIndex + found.tag.length)}`;
  return `${html.slice(0, found.from)}${inner}${html.slice(found.to)}`;
}

export function build({ outDir = path.join(TOOL_ROOT, "dist"), embedPaths = [], toolRoot = TOOL_ROOT, repoRoot = REPO_ROOT } = {}) {
  assertServerRulesMatch(repoRoot);
  const variants = {};
  for (const variant of OPTION_FILL_VARIANTS) {
    const code = buildBookmarkletCode({ variant, toolRoot });
    variants[variant] = { code, href: bookmarkletHref(code), target: OPTION_FILL_TARGETS[variant] };
  }
  // 모든 --embed 파일을 먼저 읽고 바꿔 본 뒤, 하나도 실패하지 않았을 때만 쓴다.
  const seen = new Set();
  const plans = embedPaths.map((embedPath) => {
    const resolved = path.resolve(embedPath);
    if (seen.has(resolved)) throw new Error(`naver-option-check: --embed 파일이 겹칩니다(${shownPath(resolved)})`);
    seen.add(resolved);
    const variant = variantForEmbedPath(resolved);
    const before = fs.readFileSync(resolved, "utf8");
    const after = embedBookmarklet(before, variants[variant].href);
    return { path: resolved, variant, before, after };
  });
  const embedded = plans.map((plan) => {
    if (plan.after !== plan.before) fs.writeFileSync(plan.path, plan.after, "utf8");
    return { path: plan.path, variant: plan.variant, changed: plan.after !== plan.before };
  });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [variant, built] of Object.entries(variants)) {
    fs.writeFileSync(path.join(outDir, `bookmarklet-${variant}.js`), built.code, "utf8");
    fs.writeFileSync(path.join(outDir, `bookmarklet-${variant}-href.txt`), `${built.href}\n`, "utf8");
  }
  return { variants, outDir, embedded };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--embed" || arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`naver-option-check: ${arg} 뒤에 경로가 필요합니다`);
      if (arg === "--embed") (options.embedPaths ||= []).push(path.resolve(value));
      else options.outDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`naver-option-check: 모르는 인자 ${arg}`);
    }
  }
  return options;
}

function shownPath(target) {
  const relative = path.relative(process.cwd(), target);
  return relative && !relative.startsWith("..") ? relative : target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = build(parseArgs(process.argv.slice(2)));
    const sizes = Object.entries(result.variants).map(([variant, built]) => `${variant} 코드 ${built.code.length}자·주소 ${built.href.length}자`).join(" / ");
    const embedNote = result.embedded.map((entry) => ` · ${shownPath(entry.path)}(${entry.variant}) ${entry.changed ? "바꿈" : "이미 같음"}`).join("");
    console.log(`naver-option-check: ${sizes} -> ${shownPath(result.outDir)}${embedNote}`);
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  }
}
