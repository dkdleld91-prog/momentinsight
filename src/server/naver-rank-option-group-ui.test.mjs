// N 30일 그룹상품 추적(대표 요청 2026-10-23) 화면 테스트 — 관리자(admin.html)·광고주(client.html).
//
//   U1 번호도 옵션 기록도 없는 카드는 예전 HTML 그대로(관리자 화면만 서버가 편집 가능하다고 준 추적에 버튼 하나)
//   U2 '그룹상품 n개' 알약·관리자 편집 버튼·'가져오기' 권유, 광고주 화면에는 버튼 없음
//   U3 '잡힌 옵션' 줄과 관리자 전용 확인 사항, 현재 알약은 '상품' 그대로(공유 이미지 규칙, 대표 결정 D5)
//   U4 공유 이미지 복제에서 새 표시가 모두 빠진다
//   U5 날짜 칸: 옵션으로 잡힌 날만 화면에 ' · 옵션'
//   U6 두 화면의 공통 함수는 글자 하나까지 같다
//   U7 새 CSS 는 var(--mi-*) 토큰만
//   U8 저장 뒤 목록 다시 읽기는 관리자 initRankTracking 한 곳, 편집창 시작 호출은 관리자만
//   U9 편집창: 미리 보기 전·입력 바뀐 뒤·받지 않은 칸이 있으면 저장 꺼짐, 저장 요청·목록 다시 읽기 신호
//
// 규약은 scripts/rank-n30-board-ui.test.mjs 와 같다: 화면 원본에서 함수 블록을 그대로 떼어 vm 에서 실행한다.
// 이 파일은 package.json 의 `node --test src/server/*.test.mjs` 에 들어 있어 npm test 로 돈다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { GROUP_OPTION_UNVERIFIED_TAIL } from "./naver-rank-option-group.mjs";

const repositoryRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const readRepoFile = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");
const adminSource = readRepoFile("src/pages/admin.html");
const clientSource = readRepoFile("src/pages/client.html");
const PAGES = [["admin.html", adminSource], ["client.html", clientSource]];

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-23T03:00:00.000Z"); // 2026-10-23(금) 12:00 KST
const kst = (day, hour = 9) => new Date(Date.parse(`${day}T00:00:00Z`) - 9 * HOUR + hour * HOUR).toISOString();
const plain = (value) => JSON.parse(JSON.stringify(value));

const PAGE_FUNCTION_CLOSE = "\n      }";
function htmlFunction(source, name, label = "") {
  let from = source.indexOf(`\n      function ${name}(`);
  if (from < 0) from = source.indexOf(`\n      async function ${name}(`);
  assert.ok(from >= 0, `page function not found: ${name} (${label})`);
  const to = source.indexOf(PAGE_FUNCTION_CLOSE + "\n", from);
  assert.ok(to > from, `page function end not found: ${name} (${label})`);
  return source.slice(from + 1, to + PAGE_FUNCTION_CLOSE.length);
}

function blockFrom(source, startIndex) {
  const open = source.indexOf("{", startIndex);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, index + 1);
    }
  }
  throw new Error("block end not found");
}

function lockedFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `function not found: ${name}`);
  return blockFrom(source, match.index);
}

// ─────────────────────────────────────────────────────────────
// 아주 작은 DOM: 카드 HTML 을 나무로 풀어 복제·선택자·제거를 낸다(rank-n30-board-ui.test.mjs 와 같은 방식).
// ─────────────────────────────────────────────────────────────
const VOID_TAGS = new Set(["input", "br", "img", "meta", "link"]);
const decodeEntities = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

class MiniText {
  constructor(text) { this.text = text; this.parent = null; }
  cloneNode() { return new MiniText(this.text); }
  get textContent() { return decodeEntities(this.text); }
}

class MiniElement {
  constructor(tagName, attrs = new Map()) {
    this.tagName = tagName.toLowerCase();
    this.attrs = attrs;
    this.children = [];
    this.parent = null;
  }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  get classList() { return String(this.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  cloneNode(deep) {
    const copy = new MiniElement(this.tagName, new Map(this.attrs));
    if (deep) this.children.forEach((child) => copy.appendChild(child.cloneNode(true)));
    return copy;
  }
  get textContent() { return this.children.map((child) => child.textContent).join(""); }
  matches(selectorList) {
    return selectorList.split(",").map((part) => part.trim()).some((simple) => {
      const match = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/i.exec(simple);
      assert.ok(match, `mini DOM 이 모르는 선택자: ${simple}`);
      const [, tag, classes, attrs] = match;
      if (tag && tag.toLowerCase() !== this.tagName) return false;
      const own = this.classList;
      if (classes && !classes.split(".").filter(Boolean).every((name) => own.includes(name))) return false;
      if (attrs && !attrs.slice(1, -1).split("][").every((name) => this.hasAttribute(name))) return false;
      return true;
    });
  }
  querySelectorAll(selectorList) {
    const found = [];
    const walk = (node) => node.children.forEach((child) => {
      if (!(child instanceof MiniElement)) return;
      if (child.matches(selectorList)) found.push(child);
      walk(child);
    });
    walk(this);
    return found;
  }
  querySelector(selectorList) { return this.querySelectorAll(selectorList)[0] || null; }
}

function parseHtml(html) {
  const root = new MiniElement("#root");
  let current = root;
  const pattern = /<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
  let match;
  while ((match = pattern.exec(html))) {
    if (match[1]) {
      assert.equal(current.tagName, match[1].toLowerCase(), `닫는 태그가 맞지 않는다: ${match[1]}`);
      current = current.parent;
    } else if (match[2]) {
      const attrs = new Map();
      String(match[3] || "").replace(/([\w-]+)(?:="([^"]*)")?/g, (whole, name, value) => {
        attrs.set(name, value === undefined ? "" : decodeEntities(value));
        return whole;
      });
      const element = new MiniElement(match[2], attrs);
      current.appendChild(element);
      if (!VOID_TAGS.has(element.tagName)) current = element;
    } else if (match[4]) {
      current.appendChild(new MiniText(match[4]));
    }
  }
  assert.equal(current, root, "열린 태그가 남았다");
  return root;
}

// ─────────────────────────────────────────────────────────────
// 카드 샌드박스(날짜 줄·카드 함수는 원본 그대로, 카드 밖 도우미만 작은 대역)
// ─────────────────────────────────────────────────────────────
const CARD_FUNCTIONS = [
  "escapeHtml", "rankText", "rankSnapshotSourceLabel", "rankDayLabel", "rankDayClass", "rankKstParts", "rankKstDayKey",
  "rankKstDayShift", "rankKstDayDate", "groupRankSnapshotsByDay", "latestRankSnapshotForDay", "renderRankSlot",
  "rankTrackerSnapshotsMaybeTruncated", "rankTrackerBoardDayKeys", "renderTrackerDailyBoard", "rankTrackerRankValue",
  "rankTrackerRecentRanks", "rankTrackerAverageRank", "rankTrackerSevenDayAverageRank", "rankTrackerLatestRank",
  "rankTrackerPreviousRank", "rankTrackerTrend", "rankTrackerNeedsAttention", "rankTrackerInsight", "rankTrackerCatalogHint",
  "rankTrackerActionNote", "rankTrackerChangeLabel", "rankTrackerCurrentSourceLabel", "rankOptionEditAvailable",
  "rankTrackerOptionState", "renderRankOptionOpsPills", "renderRankOptionHitLine", "renderRankTrackerCard",
  "cloneRankCardForExport", "cloneRankTrackerCardForShare",
];

const CARD_STUBS = `
  var RANK_CHRONIC_ISOLATION_LABEL = "수집 방식 점검 중";
  function rankTrackerChronicIsolated() { return false; }
  function rankTrackerTitle(tracker) { return tracker.productTitle || "상품"; }
  function rankTrackerMallName() { return ""; }
  function renderRankKeywordName(keyword) { return '<span class="mi-rank-keyword-name">' + escapeHtml(keyword) + "</span>"; }
  function renderRankKeywordVolume() { return '<span class="mi-rank-keyword-volume">키워드검색량 1,000</span>'; }
  function rankTrackerProductId(tracker) { return tracker.productId || "-"; }
  function renderRankProductTitle(tracker, titleText) { return '<span class="mi-rank-product-title">' + escapeHtml(titleText) + "</span>"; }
  function rankTrackerStatusClass() { return ""; }
  function rankTrackerStatus() { return "운영중"; }
  function rankGroupDisplayName(group) { return group || "미분류"; }
  function rankTrackerGroupName(tracker) { return tracker.groupName || ""; }
  function formatRankShortAt() { return "10. 23. 오전 09:12"; }
  function formatRankRemain() { return "3시간"; }
`;

function cardSandbox(source, label, role = "owner") {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; }; var secureSession = { role: ${JSON.stringify(role)} };`, context);
  vm.runInContext(CARD_FUNCTIONS.map((name) => htmlFunction(source, name, label)).join("\n\n") + CARD_STUBS, context);
  return context;
}

function renderCard(source, label, tracker, role = "owner") {
  const context = cardSandbox(source, label, role);
  context.__tracker = tracker;
  return vm.runInContext("renderRankTrackerCard(__tracker, null)", context);
}

function shareClone(source, label, html) {
  const context = cardSandbox(source, label);
  context.__source = parseHtml(html).querySelector(".mi-rank-tracker-card");
  return vm.runInContext("cloneRankTrackerCardForShare(__source)", context);
}

const PRIMARY = "12356459438";
const OPTION_A = "99900000001"; // 가짜 번호(실제 옵션 번호는 대표가 가진 값)
const OPTION_B = "99900000002";
const snapshot = (checkedAt, rank, item = {}) => ({ checkedAt, rank, item: { trackingRankSource: "exact_product", ...item } });

function baseTracker(extra = {}) {
  return {
    id: "t-1",
    keyword: "아이폰 16 프로 필름",
    productId: PRIMARY,
    productUrl: `https://smartstore.naver.com/ishell/products/${PRIMARY}`,
    productTitle: "아이쉘 아이폰17 강화유리 필름",
    status: "active",
    currentRank: 12,
    bestRank: 9,
    groupName: "아이쉘",
    lastMessage: "네이버쇼핑 오가닉 12위",
    createdAt: kst("2026-10-20", 8),
    snapshots: [snapshot(kst("2026-10-23", 9), 12), snapshot(kst("2026-10-22", 9), 11)],
    ...extra,
  };
}

const EDIT_BUTTON = /<button class="mi-rank-option-edit[^"]*"[^>]*>[^<]*<\/button>/g;

// ─────────────────────────────────────────────────────────────
// U1 무변경
// ─────────────────────────────────────────────────────────────
for (const [label, source] of PAGES) {
  test(`${label}: U1 그룹상품 칸이 없거나 비어 있는 카드는 예전 HTML 그대로(관리자는 편집 버튼 하나만 더)`, () => {
    const legacy = renderCard(source, label, baseTracker());
    assert.doesNotMatch(legacy, /mi-rank-option|data-rank-option|그룹상품|slot-option/u, "옛 응답(칸 없음) 카드에는 새 표시가 없다");

    const empty = renderCard(source, label, baseTracker({
      optionProductIds: [], optionProductCount: 0, optionEditable: true, currentMatchBasis: "",
      currentMatchedOptionProductId: null, currentMatchedOptionTitle: null, groupOptionSuggestionCount: 0,
    }));
    if (label === "client.html") {
      assert.equal(empty, legacy, "광고주 화면은 바이트 단위로 같다");
    } else {
      assert.equal((empty.match(EDIT_BUTTON) || []).length, 1, "관리자 화면은 편집 버튼 하나만 붙는다");
      assert.equal(empty.replace(EDIT_BUTTON, ""), legacy, "버튼을 빼면 예전 HTML 과 같다");
      assert.match(empty, />그룹상품 번호 넣기<\/button>/u);
      // 광고주 역할 세션이 관리자 화면을 열어도 버튼은 없다(서버도 403).
      assert.equal(renderCard(source, label, baseTracker({ optionProductIds: [], optionEditable: true }), "client"), legacy);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// U2 알약·버튼
// ─────────────────────────────────────────────────────────────
for (const [label, source] of PAGES) {
  test(`${label}: U2 '그룹상품 n개' 알약과 관리자 편집 버튼·가져오기 권유`, () => {
    const html = renderCard(source, label, baseTracker({
      optionProductIds: [OPTION_A, OPTION_B, "99900000003"], optionProductCount: 3, optionEditable: true,
    }));
    const card = parseHtml(html).querySelector(".mi-rank-tracker-card");
    const pill = card.querySelector(".mi-rank-option-pill");
    assert.ok(pill, "알약이 있다");
    // 관리자 편집 카드는 상태를 한눈에(2026-10-27 A안 '번호 n개 사용 중'), 광고주 화면은 예전 글자 그대로.
    assert.equal(pill.textContent, label === "client.html" ? "그룹상품 3개" : "그룹상품 · 번호 3개 사용 중");
    assert.ok(pill.hasAttribute("data-rank-export-omit"), "공유 이미지에서 빠진다");
    assert.equal(pill.parent.classList.includes("mi-rank-ops-row"), true, "운영줄에 있다");
    const button = card.querySelector("[data-rank-option-edit]");
    if (label === "client.html") {
      assert.equal(button, null, "광고주 화면에는 편집 버튼이 없다(표시만)");
      assert.doesNotMatch(html, /data-rank-option-edit/u);
    } else {
      assert.ok(button);
      assert.equal(button.getAttribute("data-rank-option-edit"), "t-1");
      assert.equal(button.getAttribute("data-rank-option-primary"), PRIMARY);
      assert.equal(button.getAttribute("data-rank-option-keyword"), "아이폰 16 프로 필름");
      assert.equal(button.getAttribute("aria-haspopup"), "dialog");
      assert.equal(button.textContent, "그룹상품 번호");
    }

    // 같은 그룹의 다른 추적에만 있는 번호(서버 groupOptionSuggestionCount)가 있으면 '가져오기'를 권한다.
    const suggestEmpty = renderCard(source, label, baseTracker({ optionProductIds: [], optionEditable: true, groupOptionSuggestionCount: 2 }));
    const suggestMore = renderCard(source, label, baseTracker({ optionProductIds: [OPTION_A], optionProductCount: 1, optionEditable: true, groupOptionSuggestionCount: 2 }));
    if (label === "client.html") {
      assert.doesNotMatch(suggestEmpty + suggestMore, /가져오기|data-rank-option-edit/u);
    } else {
      assert.match(suggestEmpty, /class="mi-rank-option-edit is-suggest"[^>]*>그룹상품 번호 가져오기<\/button>/u);
      assert.match(suggestMore, /class="mi-rank-option-edit is-suggest"[^>]*>그룹상품 번호 \+2<\/button>/u);
    }

    // 원부 추적(서버 optionEditable:false)·종료 추적에는 버튼이 없다. 알약은 저장된 번호가 있을 때만.
    for (const extra of [{ optionEditable: false }, { optionEditable: true, status: "completed" }]) {
      const none = renderCard(source, label, baseTracker({ optionProductIds: [], ...extra }));
      assert.doesNotMatch(none, /data-rank-option-edit|mi-rank-option-pill/u, JSON.stringify(extra));
    }
  });
}

// ─────────────────────────────────────────────────────────────
// U3 잡힌 옵션 줄
// ─────────────────────────────────────────────────────────────
function optionHitTracker(extra = {}) {
  return baseTracker({
    currentRank: 37,
    optionProductIds: [OPTION_A, OPTION_B],
    optionProductCount: 2,
    optionEditable: true,
    currentMatchBasis: "group_option",
    currentMatchedOptionProductId: OPTION_A,
    currentMatchedOptionTitle: "아이쉘 아이폰16 프로 강화유리 필름 2매",
    currentOptionMallCheck: "matched",
    currentOptionTitleCheck: "ok",
    snapshots: [
      snapshot(kst("2026-10-23", 9), 37, {
        matchBasis: "group_option",
        matchedOptionProductId: OPTION_A,
        optionGroup: { checkedOptionCount: 2, matchedOptionTitle: "아이쉘 아이폰16 프로 강화유리 필름 2매", mallCheck: "matched", titleCheck: "ok" },
      }),
      snapshot(kst("2026-10-22", 9), 11),
    ],
    ...extra,
  });
}

for (const [label, source] of PAGES) {
  test(`${label}: U3 옵션으로 잡히면 '잡힌 옵션 · 상품번호 · 제목' 줄, 현재 알약은 '현재 37위 · 옵션'(명세 §9.2-2)`, () => {
    const html = renderCard(source, label, optionHitTracker());
    const card = parseHtml(html).querySelector(".mi-rank-tracker-card");
    const line = card.querySelector("[data-rank-option-hit]");
    assert.ok(line, "잡힌 옵션 줄이 있다");
    assert.ok(line.hasAttribute("data-rank-export-omit"));
    assert.deepEqual(line.children.filter((node) => node instanceof MiniElement).map((node) => node.textContent), [
      "잡힌 옵션", `상품번호 ${OPTION_A}`, "아이쉘 아이폰16 프로 강화유리 필름 2매",
    ]);
    assert.equal(line.querySelector(".mi-rank-option-hit-title").getAttribute("title"), "아이쉘 아이폰16 프로 강화유리 필름 2매");
    // 날짜 줄 바로 위(운영줄 아래)에 놓인다.
    const order = card.children.filter((node) => node instanceof MiniElement).map((node) => node.classList[0]);
    assert.deepEqual(order, ["mi-rank-track-row-head", "mi-rank-ops-row", "mi-rank-option-hit", "mi-rank-day-grid"]);
    // 현재 알약: 옵션으로 잡힌 최신 순위는 '옵션'. ' · 옵션' 조각만 공유 이미지에서 빠진다(U4).
    const pill = card.querySelector(".mi-rank-row-actions").querySelectorAll("span")[0];
    assert.equal(pill.textContent, "현재 37위 · 옵션");
    const pillOption = pill.querySelector(".mi-rank-pill-option");
    assert.ok(pillOption && pillOption.hasAttribute("data-rank-export-omit"));
    assert.equal(card.querySelector(".mi-rank-row-actions").querySelectorAll("span")[1].textContent, "최고 9위");
    assert.doesNotMatch(html, /is-warn" title="스토어/u, "스토어 대조된 옵션에는 확인 사항이 없다");

    // 서버 칸이 없을 때(캐시 등)는 최신 측정 item 으로 같은 줄을 그린다.
    const fromSnapshot = renderCard(source, label, optionHitTracker({
      currentMatchBasis: undefined, currentMatchedOptionProductId: undefined, currentMatchedOptionTitle: undefined,
    }));
    assert.equal(parseHtml(fromSnapshot).querySelector("[data-rank-option-hit]").textContent, line.textContent);
  });

  test(`${label}: U3 관리자 화면만 서버 확인 사항(스토어 확인 없음·제목 차이·여러 카드·다른 스토어)을 붙인다`, () => {
    const warned = optionHitTracker({
      currentOptionMallCheck: "unverified",
      currentOptionTitleCheck: "low_overlap",
    });
    warned.snapshots[0].item.optionGroup = { ...warned.snapshots[0].item.optionGroup, mallCheck: "unverified", titleCheck: "low_overlap", cardCount: 2, mallMismatchCount: 1 };
    const warnedLine = parseHtml(renderCard(source, label, warned)).querySelector("[data-rank-option-hit]");
    const notes = warnedLine.querySelectorAll(".is-warn").map((node) => node.textContent);
    // 대표도 보였지만 옵션 카드가 더 높아 옵션 순위로 기록된 경우(서버 D2 명세 원안).
    const overPrimary = optionHitTracker();
    overPrimary.snapshots[0].item.optionGroup = { ...overPrimary.snapshots[0].item.optionGroup, primaryProductRank: 50, primaryRankSource: "exact_product" };
    const overPrimaryNotes = parseHtml(renderCard(source, label, overPrimary)).querySelector("[data-rank-option-hit]")
      .querySelectorAll(".is-warn").map((node) => node.textContent);
    const overCatalog = optionHitTracker();
    overCatalog.snapshots[0].item.optionGroup = { ...overCatalog.snapshots[0].item.optionGroup, primaryProductRank: 150, primaryRankSource: "related_catalog" };
    const overCatalogNotes = parseHtml(renderCard(source, label, overCatalog)).querySelector("[data-rank-option-hit]")
      .querySelectorAll(".is-warn").map((node) => node.textContent);
    // 대표가 잡혔지만 그룹상품 번호가 다른 카드(더 낮은 순위)에서도 보인 경우(서버 D2: 대표 그대로, 확인 키만).
    const primary = baseTracker({
      optionProductIds: [OPTION_A], optionProductCount: 1, optionEditable: true, currentMatchBasis: "primary",
      snapshots: [snapshot(kst("2026-10-23", 9), 12, { matchBasis: "primary", optionGroup: { checkedOptionCount: 1, otherCardCount: 1, otherCardBestRank: 5 } })],
    });
    const primaryHtml = renderCard(source, label, primary);
    if (label === "client.html") {
      assert.deepEqual(notes, [], "광고주 화면에는 내부 확인 사항을 보이지 않는다");
      assert.deepEqual(overPrimaryNotes, []);
      assert.deepEqual(overCatalogNotes, []);
      assert.doesNotMatch(primaryHtml, /data-rank-option-hit/u, "대표로 잡힌 카드에는 줄이 없다");
    } else {
      assert.deepEqual(notes, [
        "스토어 확인 없이 기록",
        "제목이 추적 상품과 많이 다름 · 확인",
        "서로 다른 카드 2장에서 잡힘 · 확인",
        "다른 스토어로 보여 뺀 번호 1개",
      ]);
      assert.deepEqual(overPrimaryNotes, ["대표 상품번호 50위보다 높아 옵션 순위로 기록 · 확인"]);
      assert.deepEqual(overCatalogNotes, ["대표 상품번호 관련 원부 150위보다 높아 옵션 순위로 기록 · 확인"]);
      const line = parseHtml(primaryHtml).querySelector("[data-rank-option-hit]");
      assert.deepEqual(line.children.filter((node) => node instanceof MiniElement).map((node) => node.textContent), [
        "그룹상품 확인", "그룹상품 번호가 다른 카드 1장에서도 잡힘 · 확인",
      ]);
      assert.match(line.querySelector(".is-warn").getAttribute("title"), /가장 높은 5위/u);
      assert.match(line.querySelector(".is-warn").getAttribute("title"), /^대표 상품번호 순위가 더 높거나 같아/u);
    }
  });

  test(`${label}: [흔적 E'] 대표가 이긴 날에도 다른 스토어로 뺀 번호를 관리자 줄에 보인다(광고주 화면·메시지에는 없음)`, () => {
    // 서버: 대표 50위가 보였고 넣은 번호 카드(20위)는 다른 스토어로 확인돼 뺐다 → 대표 그대로 + 흔적 키(규칙 E').
    const message = "입력 상품의 오가닉 50위를 30일 대표 순위로 기록했습니다.";
    const held = baseTracker({
      optionProductIds: [OPTION_A, OPTION_B], optionProductCount: 2, optionEditable: true, currentMatchBasis: "primary",
      lastMessage: message,
      snapshots: [snapshot(kst("2026-10-23", 9), 50, {
        matchBasis: "primary",
        optionGroup: { checkedOptionCount: 2, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_B] },
      })],
    });
    const heldHtml = renderCard(source, label, held);
    const messageNode = parseHtml(heldHtml).querySelector(".mi-rank-ops-message");
    assert.equal(messageNode.textContent, `메시지 ${message}`, "문장은 대표 결과 그대로");
    // 여러 카드에서 잡혀 옵션으로 기록한 경우의 안내(규칙 C' — 확인 안 됨 카드도 겨룬다).
    const multi = optionHitTracker();
    multi.snapshots[0].item.optionGroup = { ...multi.snapshots[0].item.optionGroup, cardCount: 2, mallCheck: "unverified", primaryProductRank: 50, primaryRankSource: "exact_product" };
    const multiHtml = renderCard(source, label, multi);
    if (label === "client.html") {
      assert.doesNotMatch(heldHtml, /data-rank-option-hit/u, "광고주 화면에는 내부 확인 사항이 없다");
      assert.doesNotMatch(heldHtml, new RegExp(OPTION_B), "광고주 화면에는 뺀 번호가 없다");
      assert.deepEqual(parseHtml(multiHtml).querySelector("[data-rank-option-hit]").querySelectorAll(".is-warn"), []);
      return;
    }
    const line = parseHtml(heldHtml).querySelector("[data-rank-option-hit]");
    assert.deepEqual(line.children.filter((node) => node instanceof MiniElement).map((node) => node.textContent), [
      "그룹상품 확인", `다른 스토어로 보여 뺀 번호 1개 · ${OPTION_B}`,
    ]);
    const title = line.querySelector(".is-warn").getAttribute("title");
    assert.equal(title, `스토어가 추적과 달라 순위에 넣지 않은 번호입니다: ${OPTION_B}. 대표 순위로 기록한 날은 메시지에 넣지 않고 이 줄에만 남깁니다. 같은 스토어 그룹상품 번호가 맞는지 확인해주세요.`);
    // 번호가 많으면 줄에는 앞 3개 + '외 n개', 마우스 설명에는 전부.
    const many = baseTracker({
      optionProductIds: [OPTION_A], optionProductCount: 1, optionEditable: true, currentMatchBasis: "primary",
      snapshots: [snapshot(kst("2026-10-23", 9), 50, {
        matchBasis: "primary",
        optionGroup: { checkedOptionCount: 5, mallMismatchCount: 5, mallMismatchProductIds: ["11111111111", "22222222222", "33333333333", "44444444444", "55555555555"] },
      })],
    });
    const manyNote = parseHtml(renderCard(source, label, many)).querySelector("[data-rank-option-hit]").querySelector(".is-warn");
    assert.equal(manyNote.textContent, "다른 스토어로 보여 뺀 번호 5개 · 11111111111, 22222222222, 33333333333 외 2개");
    assert.match(manyNote.getAttribute("title"), /55555555555/u);
    // 번호 목록이 없는 옛 꼴(개수만)도 그린다.
    const countOnly = baseTracker({
      optionProductIds: [OPTION_A], optionProductCount: 1, optionEditable: true, currentMatchBasis: "not_found",
      snapshots: [snapshot(kst("2026-10-23", 9), null, { matchBasis: "not_found", optionGroup: { checkedOptionCount: 1, mallMismatchCount: 1 } })],
    });
    assert.equal(parseHtml(renderCard(source, label, countOnly)).querySelector("[data-rank-option-hit]").querySelector(".is-warn").textContent, "다른 스토어로 보여 뺀 번호 1개");
    const multiTitles = parseHtml(multiHtml).querySelector("[data-rank-option-hit]").querySelectorAll(".is-warn")
      .map((node) => node.getAttribute("title"));
    assert.ok(multiTitles.includes("그룹상품은 카드 한 장으로 나옵니다. 넣은 번호가 서로 다른 카드에서 잡혀 가장 높은 순위를 기록했습니다."));
    assert.ok(multiTitles.every((text) => !/대표 상품번호가 이번 결과에 없을 때만|쓰지 않음/u.test(text)), "규칙 C 시절 안내는 없다");
  });
}

// [규칙 D] 확인 안 됨으로 기록한 문장 꼬리는 관리자 세션 화면에서만 보이고, 광고주 화면 '메시지'에서는 빠진다.
for (const [label, source] of PAGES) {
  test(`${label}: [규칙 D] '스토어를 확인하지 못해 확인 없이 기록했습니다.' 꼬리는 광고주 화면 메시지에 보이지 않는다`, () => {
    const base = `그룹상품 옵션(상품번호 ${OPTION_A})이 오가닉 37위로 잡혀 30일 대표 순위로 기록했습니다. 대표 상품번호는 이번 결과에 없습니다.`;
    const mismatchTail = " 다른 스토어로 보여 뺀 옵션: 99900000002.";
    const unverified = (extra = {}) => {
      const row = optionHitTracker({ currentOptionMallCheck: "unverified", ...extra });
      row.snapshots[0].item.optionGroup = { ...row.snapshots[0].item.optionGroup, mallCheck: "unverified" };
      return row;
    };
    const messageOf = (html) => parseHtml(html).querySelector(".mi-rank-ops-message");
    const cases = [
      ["last_message", unverified({ lastMessage: base + GROUP_OPTION_UNVERIFIED_TAIL + mismatchTail })],
      ["스냅샷 문장(last_message 없음)", (() => {
        const row = unverified({ lastMessage: null });
        row.snapshots[0].message = base + GROUP_OPTION_UNVERIFIED_TAIL;
        return row;
      })()],
    ];
    for (const [caseLabel, row] of cases) {
      const fullText = row.lastMessage || row.snapshots[0].message;
      const ownerNode = messageOf(renderCard(source, label, row, "owner"));
      const clientNode = messageOf(renderCard(source, label, row, "client"));
      const stripped = fullText.split(GROUP_OPTION_UNVERIFIED_TAIL).join("");
      assert.equal(clientNode.textContent, `메시지 ${stripped}`, `${caseLabel}: 광고주 역할 세션은 꼬리를 뺀 문장`);
      assert.equal(clientNode.getAttribute("title"), stripped, `${caseLabel}: 마우스 설명에도 꼬리가 없다`);
      if (label === "client.html") {
        assert.equal(ownerNode.textContent, `메시지 ${stripped}`, `${caseLabel}: 광고주 화면은 세션과 상관없이 꼬리를 뺀다`);
      } else {
        assert.equal(ownerNode.textContent, `메시지 ${fullText}`, `${caseLabel}: 관리자 세션 화면은 꼬리까지 보인다`);
        const notes = parseHtml(renderCard(source, label, row, "owner")).querySelector("[data-rank-option-hit]").querySelectorAll(".is-warn");
        assert.equal(notes[0].textContent, "스토어 확인 없이 기록");
        assert.match(notes[0].getAttribute("title"), /^스토어를 확인하지 못한 옵션 카드가 가장 높아\(대표 상품번호보다 높거나 대표 상품번호가 결과에 없음\) 그 순위를 확인 없이 기록했습니다\./u);
        assert.doesNotMatch(notes[0].getAttribute("title"), /없을 때만/u, "규칙 C' 에서는 대표가 보여도 확인 안 됨 옵션을 쓴다");
        assert.doesNotMatch(notes[0].getAttribute("title"), /기준이 없어/u);
      }
    }
    // 꼬리가 없는 문장(옵션 없는 추적 등)은 두 세션 모두 예전 글자 그대로.
    const legacy = baseTracker();
    assert.equal(messageOf(renderCard(source, label, legacy, "client")).textContent, "메시지 네이버쇼핑 오가닉 12위");
    assert.equal(messageOf(renderCard(source, label, legacy, "owner")).textContent, "메시지 네이버쇼핑 오가닉 12위");
  });
}

test("[규칙 D] 화면이 빼는 꼬리 글자는 서버 꼬리(GROUP_OPTION_UNVERIFIED_TAIL)와 같다", () => {
  for (const [label, source] of PAGES) {
    const card = htmlFunction(source, "renderRankTrackerCard", label);
    assert.ok(card.includes(`lastMessage.split(${JSON.stringify(GROUP_OPTION_UNVERIFIED_TAIL)}).join("")`), label);
    assert.ok(card.includes("if (!optionState.admin && typeof lastMessage === \"string\")"), label);
  }
});

// ─────────────────────────────────────────────────────────────
// U4·U5 공유 이미지·날짜 칸
// ─────────────────────────────────────────────────────────────
for (const [label, source] of PAGES) {
  test(`${label}: U4 공유 이미지 복제에서 그룹상품 표시가 모두 빠지고, U5 화면 날짜 칸은 옵션 날만 ' · 옵션'`, () => {
    const html = renderCard(source, label, optionHitTracker());
    const screen = parseHtml(html).querySelector(".mi-rank-tracker-card");
    const cells = screen.querySelectorAll(".mi-rank-day-card").map((cell) => [cell.querySelector("strong").textContent, cell.querySelector("small").textContent, cell.querySelector("b").textContent]);
    assert.deepEqual(cells.slice(0, 2), [["10-23(금)", "순위 · 옵션", "37위"], ["10-22(목)", "순위", "11위"]]);
    const mark = screen.querySelector(".mi-rank-slot-option");
    assert.ok(mark.hasAttribute("data-rank-export-omit"));
    assert.ok(html.includes('<span><small>순위</small><b>11위</b></span>'), "옵션 아닌 날 칸은 예전 글자 그대로");

    const share = shareClone(source, label, html);
    assert.equal(share.querySelector(".mi-rank-option-pill"), null);
    assert.equal(share.querySelector("[data-rank-option-hit]"), null);
    assert.equal(share.querySelector(".mi-rank-slot-option"), null);
    assert.equal(share.querySelectorAll("button").length, 0);
    assert.doesNotMatch(share.textContent, /그룹상품|옵션/u, "공유 이미지에는 그룹상품·옵션 글자가 없다(대표 결정 D5)");
    assert.deepEqual(share.querySelectorAll(".mi-rank-day-card").slice(0, 2).map((cell) => cell.querySelector("small").textContent), ["순위", "순위"]);
    assert.equal(share.querySelector(".mi-rank-pill-option"), null);
    assert.equal(share.querySelector(".mi-rank-row-actions").querySelectorAll("span")[0].textContent, "현재 37위");
  });
}

// ─────────────────────────────────────────────────────────────
// U6 두 화면 같은 글자 · 캐시 압축
// ─────────────────────────────────────────────────────────────
test("U6 admin.html·client.html 의 그룹상품 공통 함수와 카드·날짜 칸·캐시 함수는 글자 하나까지 같다", () => {
  for (const name of [
    "rankTrackerOptionState", "renderRankOptionOpsPills", "renderRankOptionHitLine", "renderRankTrackerCard", "renderRankSlot",
    "compactRankSnapshotForCache", "cloneRankTrackerCardForShare", "renderRankHistory",
  ]) {
    assert.equal(htmlFunction(adminSource, name, "admin"), htmlFunction(clientSource, name, "client"), name);
  }
  // 편집 가능 여부만 화면별로 다르다.
  const run = (source, role) => {
    const context = {};
    vm.createContext(context);
    vm.runInContext(`var secureSession = { role: ${JSON.stringify(role)} };\n${htmlFunction(source, "rankOptionEditAvailable")}`, context);
    return vm.runInContext("rankOptionEditAvailable()", context);
  };
  assert.deepEqual(["owner", "team", "client", ""].map((role) => run(adminSource, role)), [true, true, false, false]);
  assert.deepEqual(["owner", "team", "client", ""].map((role) => run(clientSource, role)), [false, false, false, false]);
});

for (const [label, source] of PAGES) {
  test(`${label}: U6 마지막 정상 순위 캐시가 matchBasis·matchedOptionProductId·optionGroup 을 남긴다`, () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext(htmlFunction(source, "compactRankSnapshotForCache", label), context);
    context.__snapshot = {
      id: "s1", checkedAt: kst("2026-10-23", 9), rank: 37,
      item: { trackingRankSource: "exact_product", title: "카드", productId: OPTION_A, matchBasis: "group_option", matchedOptionProductId: OPTION_A, optionGroup: { mallCheck: "matched" }, sellerProductId: OPTION_A, extra: "버림" },
    };
    assert.deepEqual(plain(vm.runInContext("compactRankSnapshotForCache(__snapshot)", context).item), {
      trackingRankSource: "exact_product", title: "카드", productId: OPTION_A, matchBasis: "group_option", matchedOptionProductId: OPTION_A, optionGroup: { mallCheck: "matched" },
    });
    // 옵션 없는 측정은 예전 모양 그대로.
    context.__snapshot = { id: "s2", rank: 3, item: { trackingRankSource: "exact_product", title: "카드" } };
    assert.deepEqual(plain(vm.runInContext("compactRankSnapshotForCache(__snapshot)", context).item), { trackingRankSource: "exact_product", title: "카드" });
  });
}

// ─────────────────────────────────────────────────────────────
// U7 CSS 토큰
// ─────────────────────────────────────────────────────────────
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/u;
for (const [label, source] of PAGES) {
  test(`${label}: U7 그룹상품 CSS 는 var(--mi-*) 토큰만 쓴다(hex·rgb·hsl 0건)`, () => {
    const from = source.indexOf("/* N 30일 그룹상품 시작");
    const to = source.indexOf("/* N 30일 그룹상품 끝 */");
    assert.ok(from > 0 && to > from, "CSS 묶음 표식");
    assert.equal(source.indexOf("/* N 30일 그룹상품 시작", from + 1), -1, "묶음은 하나");
    const css = source.slice(from, to);
    assert.doesNotMatch(css, HEX);
    assert.doesNotMatch(css, /\brgba?\(|\bhsla?\(/u);
    assert.match(css, /var\(--mi-/u);
    for (const selector of [".mi-rank-option-pill", ".mi-rank-option-hit", ".mi-rank-slot-option"]) assert.ok(css.includes(selector), selector);
    if (label === "admin.html") {
      for (const selector of [".mi-rank-option-edit:focus-visible", ".mi-rank-option-edit:disabled", ".mi-rank-option-modal[hidden]", "@media (max-width: 520px)"]) {
        assert.ok(css.includes(selector), selector);
      }
    } else {
      assert.ok(!css.includes(".mi-rank-option-modal"), "광고주 화면에는 편집창 CSS 가 없다");
    }
  });
}

// ─────────────────────────────────────────────────────────────
// U8 연결 지점
// ─────────────────────────────────────────────────────────────
test("U8 저장 뒤 목록 다시 읽기는 관리자 initRankTracking 한 곳, 편집창은 관리자만 시작한다", () => {
  const adminTracking = lockedFunction(adminSource, "initRankTracking");
  const listener = adminTracking.match(/window\.addEventListener\("mi:rank-trackers-changed", function \(\) \{\s*loadRankTrackers\(true, true, true\);\s*\}\);/gu) || [];
  assert.equal(listener.length, 1, "자동 밀린 갱신(sync-due) 없이 목록만 다시 읽는다");
  assert.ok(!lockedFunction(clientSource, "initRankTracking").includes("mi:rank-trackers-changed"), "광고주 initRankTracking 은 그대로");
  assert.ok(adminSource.includes("      initRankTracking(keywordInput);\n      initRankOptionProductEditor();\n"), "관리자 화면은 initRankTracking 바로 뒤에서 편집창을 연결한다");
  assert.ok(!clientSource.includes("initRankOptionProductEditor"), "광고주 화면에는 편집창이 없다");
  assert.ok(!clientSource.includes('action: "options"'), "광고주 화면은 그룹상품 저장 요청을 보내지 않는다");
  const editor = htmlFunction(adminSource, "initRankOptionProductEditor");
  assert.doesNotMatch(editor, /innerHTML|insertAdjacentHTML|outerHTML/u, "편집창은 textContent 로만 채운다");
  assert.match(editor, /miFetch\(getRankTrackerApiUrl\(\), \{/u, "요청은 기존 순위 추적 API 한 곳뿐");
  assert.equal((editor.match(/miFetch\(/gu) || []).length, 1);
  assert.doesNotMatch(editor, /action: "(?:check|sync-due|queue-refresh-all|create)"/u, "확인·갱신·등록 요청을 보내지 않는다");
  assert.doesNotMatch(editor, /next_check_at|requestShoppingWorkerWake/u);
});

// ─────────────────────────────────────────────────────────────
// U9 편집창(작은 가짜 DOM)
// ─────────────────────────────────────────────────────────────
class FakeClassList {
  constructor(node) { this.node = node; }
  values() { return String(this.node.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
  add(...names) { const set = new Set(this.values()); names.forEach((name) => set.add(name)); this.node.setAttribute("class", [...set].join(" ")); }
  remove(...names) { this.node.setAttribute("class", this.values().filter((name) => !names.includes(name)).join(" ")); }
  toggle(name, force) {
    const has = this.values().includes(name);
    const next = force === undefined ? !has : Boolean(force);
    if (next && !has) this.add(name);
    if (!next && has) this.remove(name);
    return next;
  }
  contains(name) { return this.values().includes(name); }
}

class FakeElement {
  constructor(tag, documentRef) {
    this.localName = String(tag).toLowerCase();
    this.ownerDocument = documentRef;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.ownText = "";
    this.value = "";
    this.checked = false;
    this.classList = new FakeClassList(this);
  }
  get children() { return this.childNodes; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get type() { return this.getAttribute("type") || ""; }
  set type(value) { this.setAttribute("type", value); }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(value) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(value) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get textContent() { return this.ownText + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.childNodes.forEach((child) => { child.parentNode = null; }); this.childNodes = []; this.ownText = String(value); }
  appendChild(node) { if (node.parentNode) node.remove(); node.parentNode = this; this.childNodes.push(node); return node; }
  remove() { if (!this.parentNode) return; this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this); this.parentNode = null; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.documentElement; }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  focus() { this.ownerDocument.activeElement = this; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  matches(selectorList) {
    return selectorList.split(",").map((part) => part.trim()).some((simple) => {
      const match = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(simple);
      assert.ok(match, `가짜 DOM 이 모르는 선택자: ${simple}`);
      const [, tag, classes, attrs] = match;
      if (tag && tag.toLowerCase() !== this.localName) return false;
      if (classes && !classes.split(".").filter(Boolean).every((name) => this.classList.contains(name))) return false;
      for (const attr of attrs.match(/\[[^\]]+\]/g) || []) {
        const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(attr);
        if (!this.hasAttribute(name)) return false;
        if (value !== undefined && this.getAttribute(name) !== value) return false;
      }
      return true;
    });
  }
  querySelectorAll(selectorList) {
    const found = [];
    const walk = (node) => node.childNodes.forEach((child) => { if (child.matches(selectorList)) found.push(child); walk(child); });
    walk(this);
    return found;
  }
  querySelector(selectorList) { return this.querySelectorAll(selectorList)[0] || null; }
  closest(selectorList) { for (let node = this; node && node.matches; node = node.parentNode) if (node.matches(selectorList)) return node; return null; }
}

function dispatch(target, type, extra = {}) {
  const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  for (let node = target; node; node = node.parentNode) {
    (node.listeners[type] || []).slice().forEach((handler) => handler.call(node, event));
  }
  return event;
}

function click(node) {
  assert.ok(node, "누를 대상이 있다");
  if (node.disabled) return false; // 브라우저처럼 꺼진 버튼은 눌리지 않는다.
  dispatch(node, "click");
  return true;
}

const flush = async () => { for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
const TRACKER_ID = "0f8a3c1e-1111-4a2b-9c3d-000000000001";
const SIBLING_ID = "0f8a3c1e-2222-4a2b-9c3d-000000000002";
const MEMBER_ID = "0f8a3c1e-3333-4a2b-9c3d-000000000003";

function editorEnv({ confirmAnswers = [] } = {}) {
  const documentRef = { activeElement: null };
  documentRef.createElement = (tag) => new FakeElement(tag, documentRef);
  const html = new FakeElement("html", documentRef);
  documentRef.documentElement = html;
  const root = documentRef.createElement("div");
  root.id = "mi-admin";
  html.appendChild(root);
  const rankCard = documentRef.createElement("article");
  rankCard.setAttribute("data-rank-card", "");
  root.appendChild(rankCard);
  const editButton = documentRef.createElement("button");
  editButton.setAttribute("data-rank-option-edit", TRACKER_ID);
  editButton.setAttribute("data-rank-option-keyword", "아이폰 17 필름");
  editButton.setAttribute("data-rank-option-primary", PRIMARY);
  rankCard.appendChild(editButton);

  const responses = [];
  const requests = [];
  const events = [];
  const timers = [];
  const windowListeners = {};
  const confirms = [];
  const scope = { key: "owner:ishell", role: "owner", agencyCode: "ishell" };
  const context = {
    root,
    document: documentRef,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    window: {
      confirm(message) { confirms.push(message); return confirmAnswers.length ? confirmAnswers.shift() : true; },
      setTimeout(handler, ms) { timers.push({ handler, ms }); return timers.length; },
      clearTimeout() {},
      dispatchEvent(event) { events.push(event); },
      addEventListener(type, handler) { (windowListeners[type] ||= []).push(handler); },
    },
    verifiedRankTrackerScope: () => scope,
    sameRankTrackerScope: (value) => Boolean(value && value.key === scope.key),
    rankAgencyCode: () => "ishell",
    canManageOwnerCodes: () => true,
    getRankTrackerApiUrl: () => "https://insight.test/api/naver-rank-trackers",
    async miFetch(url, options) {
      requests.push({ url, options, body: JSON.parse(options.body) });
      const next = responses.shift();
      if (!next) throw new Error("준비한 응답이 없다");
      if (next.throws) throw new Error(next.throws);
      return { ok: next.status < 300, status: next.status, json: async () => next.payload };
    },
  };
  vm.createContext(context);
  vm.runInContext(`${htmlFunction(adminSource, "setStatus")}\n${htmlFunction(adminSource, "initRankOptionProductEditor")}\ninitRankOptionProductEditor();`, context);
  const modal = () => root.querySelector("[data-rank-option-modal]");
  const q = (selector) => modal().querySelector(selector);
  return {
    root, rankCard, editButton, requests, events, timers, confirms, windowListeners, documentRef, modal, q,
    respond(payload, status = 200) { responses.push({ payload, status }); },
    fail(message) { responses.push({ throws: message }); },
    saveButton: () => q("[data-rank-option-save]"),
    previewButton: () => q("[data-rank-option-preview-run]"),
    input: () => q("[data-rank-option-input]"),
    apply: () => q("[data-rank-option-apply]"),
    status: () => q("[data-rank-option-status]").textContent,
    preview: () => q("[data-rank-option-preview]"),
  };
}

function sibling(extra = {}) {
  return {
    id: SIBLING_ID, keyword: "아이폰17 케이스", status: "active", groupName: "아이쉘", primaryProductId: PRIMARY,
    relation: "same_primary", optionProductCount: 0, beforeOptionProductIds: [], afterOptionProductIds: [OPTION_A, OPTION_B],
    addedCount: 2, removedCount: 0, ...extra,
  };
}

function optionsPayload({ mode = "read", saved = [], parsed = null, siblings = [sibling()], suggestions = [], willUpdateCount = 1, message = "" } = {}) {
  return {
    ok: true,
    mode,
    columnReady: true,
    tracker: { id: TRACKER_ID, keyword: "아이폰 17 필름", primaryProductId: PRIMARY, productUrl: `https://smartstore.naver.com/ishell/products/${PRIMARY}`, optionProductIds: saved },
    parsed,
    sameProduct: { trackers: siblings, siblingOptionProductIds: suggestions, shrinkingTrackerCount: 0, limit: 100 },
    applyToSameProduct: false,
    willUpdateCount,
    targetTrackerIds: [TRACKER_ID],
    removedOptionProductIds: [],
    limit: 20,
    message: message || `그룹상품 번호 ${saved.length}개`,
  };
}

const parsedOf = (ids, extra = {}) => ({
  optionProductIds: ids, inputTokenCount: ids.length, duplicatesRemoved: 0, primaryRemoved: false, primaryRemovedCount: 0,
  rejected: [], limit: 20, overLimit: false, error: "", ...extra,
});

test("U9 편집창: 열면 저장값을 읽고, 미리 보기 전·입력 바뀐 뒤·받지 않은 칸이 있으면 저장이 꺼진다", async () => {
  const env = editorEnv();
  env.respond(optionsPayload({ saved: [OPTION_A] }));
  click(env.editButton);
  assert.equal(env.modal().hidden, false, "버튼을 누르면 창이 열린다");
  const dialog = env.q("[role=\"dialog\"]");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("aria-labelledby"), "mi-rank-option-title");
  await flush();
  assert.deepEqual(plain(env.requests[0].body), { action: "options", trackerId: TRACKER_ID, mode: "read" });
  assert.equal(env.requests[0].url, "https://insight.test/api/naver-rank-trackers");
  assert.equal(env.requests[0].options.method, "POST");
  assert.equal(env.requests[0].options.headers["x-mi-agency-code"], "ishell");
  assert.equal(env.input().value, OPTION_A, "저장된 번호를 한 줄에 하나씩 채운다");
  assert.equal(env.documentRef.activeElement, env.input(), "열면 입력칸에 초점");
  assert.equal(env.saveButton().disabled, true, "미리 보기 전에는 저장 꺼짐");
  assert.match(env.q("[id=\"mi-rank-option-title\"]").textContent, /그룹상품 번호 — 아이폰 17 필름/u);
  assert.match(env.q(".mi-rank-option-primary").textContent, new RegExp(PRIMARY));
  assert.equal(env.q(".mi-rank-option-apply").hidden, false, "같은 그룹 다른 추적이 있으면 함께 적용 체크가 보인다");
  assert.equal(env.apply().checked, true, "기본 켬(대표 결정 D8)");
  assert.match(env.q(".mi-rank-option-apply").textContent, /다른 키워드 추적 1개에도 똑같이 적용/u);
  const guideLines = env.q(".mi-rank-option-guide").querySelectorAll("li").map((node) => node.textContent);
  assert.equal(guideLines.length, 6, "화면 안 사용법");
  // 순위 고르기 규칙(지휘 결정 규칙 C')을 한 줄로 쉽게 적는다.
  assert.deepEqual(guideLines.filter((line) => line.startsWith("순위 고르기:")), [
    "순위 고르기: 입력한 옵션 번호는 대표 상품번호(원부 포함)와 비교해 가장 높은 순위를 씁니다(같으면 대표). 다른 스토어로 확인된 번호만 뺍니다.",
  ]);
  assert.ok(guideLines.every((line) => !/대표 상품번호가 결과에 없을 때만/u.test(line)), "규칙 C 시절 문장은 없다");
  assert.ok(guideLines.some((line) => line.includes("카드의 '다른 스토어로 보여 뺀 번호' 줄에 남깁니다")), "다른 스토어 번호가 어디에 남는지");
  assert.ok(guideLines.every((line) => !/더 높은 순위를 기록하고, 같으면 대표 순위를 씁니다/u.test(line)), "예전 D2 문장(확인 조건 없음)은 없다");

  // 미리 보기: 받지 않은 칸 없음 → 저장 켜짐.
  env.input().value = `${OPTION_A}\n${OPTION_B}`;
  dispatch(env.input(), "input");
  env.respond(optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A, OPTION_B]), willUpdateCount: 2 }));
  click(env.previewButton());
  assert.equal(env.saveButton().disabled, true, "요청 중에는 저장 꺼짐");
  await flush();
  assert.deepEqual(plain(env.requests[1].body), { action: "options", trackerId: TRACKER_ID, mode: "preview", optionInput: `${OPTION_A}\n${OPTION_B}`, applyToSameProduct: true });
  assert.equal(env.saveButton().disabled, false, "미리 보기 성공 뒤 저장 켜짐");
  const previewText = env.preview().textContent;
  assert.match(previewText, /넣은 칸 2개 → 번호 2개/u);
  assert.deepEqual(env.preview().querySelector(".mi-rank-option-chips").querySelectorAll("li").map((node) => node.textContent), [OPTION_A, OPTION_B]);
  assert.match(previewText, /함께 바뀌는 추적 2개/u);
  assert.match(previewText, /이 추적\(아이폰 17 필름\) · 지금 1개 → 2개 · 더함 1/u);
  assert.match(previewText, /아이폰17 케이스 · 운영중 · 지금 0개 → 2개 · 더함 2/u);

  // 입력을 바꾸면 다시 꺼지고, 되돌리면 다시 켜진다.
  env.input().value = `${OPTION_A}\n${OPTION_B}\n99900000003`;
  dispatch(env.input(), "input");
  assert.equal(env.saveButton().disabled, true, "입력이 바뀌면 저장 꺼짐");
  assert.match(env.status(), /미리 보기를 다시/u);
  assert.ok(env.preview().classList.contains("is-stale"));
  env.input().value = `${OPTION_A}\n${OPTION_B}`;
  dispatch(env.input(), "input");
  assert.equal(env.saveButton().disabled, false);
  // 체크를 바꿔도 다시 꺼진다.
  env.apply().checked = false;
  dispatch(env.apply(), "change");
  assert.equal(env.saveButton().disabled, true, "함께 적용 체크가 바뀌면 저장 꺼짐");

  // 받지 않은 칸이 있으면 저장 꺼짐 → '받은 번호만 남기기'가 입력을 고치고 다시 미리 본다.
  env.input().value = `${OPTION_A} abc`;
  dispatch(env.input(), "input");
  env.respond(optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A], { inputTokenCount: 2, rejected: [{ token: "abc", reason: "not_product_number", label: "상품번호가 아닙니다" }] }) }));
  click(env.previewButton());
  await flush();
  assert.equal(env.saveButton().disabled, true, "받지 않은 칸이 있으면 저장 꺼짐");
  assert.match(env.preview().querySelector(".mi-rank-option-rejected").textContent, /받지 않은 칸 1개.*abc상품번호가 아닙니다/u);
  env.respond(optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A]) }));
  click(env.preview().querySelector("[data-rank-option-keep-valid]"));
  await flush();
  assert.equal(env.input().value, OPTION_A);
  assert.equal(env.requests.at(-1).body.optionInput, OPTION_A);
  assert.equal(env.saveButton().disabled, false);
  assert.ok(env.requests.every((request) => request.url === "https://insight.test/api/naver-rank-trackers" && request.body.action === "options"),
    "편집창은 순위 추적 API 의 options 작업만 부른다(네이버·확인·갱신 요청 없음)");
});

test("U9 편집창: 저장은 미리 본 대상 추적 id 를 함께 보내고, 성공하면 목록 다시 읽기 신호를 보낸 뒤 닫힌다", async () => {
  const env = editorEnv();
  env.respond(optionsPayload({ saved: [] }));
  click(env.editButton);
  await flush();
  env.input().value = `${OPTION_A}, ${OPTION_B}`;
  dispatch(env.input(), "input");
  env.respond(optionsPayload({ mode: "preview", parsed: parsedOf([OPTION_A, OPTION_B]), willUpdateCount: 2 }));
  click(env.previewButton());
  await flush();
  env.respond({ ok: true, mode: "save", updatedCount: 2, updatedTrackerIds: [TRACKER_ID, SIBLING_ID], optionProductIds: [OPTION_A, OPTION_B], message: "그룹상품 번호 2개를 추적 2개에 저장했습니다. 다음 순위 확인부터 적용됩니다." });
  click(env.saveButton());
  await flush();
  const saveBody = plain(env.requests.at(-1).body);
  assert.deepEqual(saveBody, {
    action: "options", trackerId: TRACKER_ID, mode: "save", optionInput: `${OPTION_A}, ${OPTION_B}`, applyToSameProduct: true,
    expectedTrackerIds: [TRACKER_ID, SIBLING_ID],
  });
  assert.equal(env.events.length, 1);
  assert.equal(env.events[0].type, "mi:rank-trackers-changed");
  assert.deepEqual(plain(env.events[0].detail.trackerIds), [TRACKER_ID, SIBLING_ID]);
  assert.match(env.status(), /추적 2개에 저장했습니다/u);
  assert.equal(env.saveButton().disabled, true, "저장 뒤 다시 누를 수 없다");
  assert.equal(env.timers.at(-1).ms, 1200);
  env.timers.at(-1).handler();
  assert.equal(env.modal().hidden, true, "1.2초 뒤 닫힌다");
  assert.equal(env.documentRef.activeElement, env.editButton, "닫으면 연 버튼으로 초점이 돌아간다");
});

test("U9 편집창: 저장이 거절되면(409 대상 바뀜) 미리 보기를 지우고 다시 미리 보기를 요구한다", async () => {
  const env = editorEnv();
  env.respond(optionsPayload({ saved: [], siblings: [] }));
  click(env.editButton);
  await flush();
  assert.equal(env.q(".mi-rank-option-apply").hidden, true, "함께 바꿀 추적이 없으면 체크를 숨긴다");
  env.input().value = OPTION_A;
  dispatch(env.input(), "input");
  env.respond(optionsPayload({ mode: "preview", parsed: parsedOf([OPTION_A]), siblings: [] }));
  click(env.previewButton());
  await flush();
  assert.equal(plain(env.requests.at(-1).body).applyToSameProduct, false, "체크가 숨으면 함께 적용하지 않는다");
  env.respond({ ok: false, code: "RANK_OPTION_TARGETS_CHANGED", message: "미리 보기 뒤에 함께 바뀌는 추적이 달라졌습니다. 다시 미리 보기 해주세요." }, 409);
  click(env.saveButton());
  await flush();
  assert.deepEqual(plain(env.requests.at(-1).body.expectedTrackerIds), [TRACKER_ID]);
  assert.equal(env.events.length, 0, "실패하면 목록 다시 읽기 신호를 보내지 않는다");
  assert.equal(env.saveButton().disabled, true);
  assert.equal(env.preview().textContent, "");
  assert.match(env.status(), /함께 바뀌는 추적이 달라졌습니다/u);
});

test("U9 편집창: 주소 추적 꼬리 줄이기·같은 그룹 번호 가져오기·번호가 줄어드는 추적 경고·개수 초과", async () => {
  const env = editorEnv();
  env.respond(optionsPayload({
    saved: [],
    suggestions: [OPTION_A, OPTION_B],
    siblings: [
      sibling({ optionProductCount: 3, beforeOptionProductIds: [OPTION_A, "99900000007", "99900000008"], afterOptionProductIds: [OPTION_A], addedCount: 0, removedCount: 2 }),
      sibling({ id: MEMBER_ID, keyword: "아이폰17 필름 2매", beforeOptionProductIds: [], afterOptionProductIds: [OPTION_A], addedCount: 1 }),
    ],
  }));
  click(env.editButton);
  await flush();
  const importButton = env.q("[data-rank-option-import]");
  assert.equal(importButton.hidden, false, "입력이 비었고 같은 그룹 번호가 있으면 가져오기 버튼");
  assert.equal(importButton.textContent, "같은 상품의 다른 추적에서 가져오기 (2개)");
  click(importButton);
  assert.equal(env.input().value, `${OPTION_A}\n${OPTION_B}`);
  assert.equal(env.requests.length, 1, "가져오기는 입력칸만 채운다(저장·요청 없음)");
  assert.equal(env.q("[data-rank-option-import]").hidden, true);

  env.input().value = `https://smartstore.naver.com/ishell/products/${OPTION_A}?NaPm=ct%3Dabc%7Cci%3Ddef%7Ctr%3Dslsl`;
  dispatch(env.input(), "input");
  env.respond(optionsPayload({
    mode: "preview",
    parsed: parsedOf([OPTION_A]),
    willUpdateCount: 3,
    siblings: [
      sibling({ optionProductCount: 3, beforeOptionProductIds: [OPTION_A, "99900000007", "99900000008"], afterOptionProductIds: [OPTION_A], addedCount: 0, removedCount: 2 }),
      sibling({ id: MEMBER_ID, keyword: "아이폰17 필름 2매", beforeOptionProductIds: [], afterOptionProductIds: [OPTION_A], addedCount: 1 }),
    ],
  }));
  click(env.previewButton());
  await flush();
  assert.equal(env.requests.at(-1).body.optionInput, `https://smartstore.naver.com/ishell/products/${OPTION_A}`, "경로에 상품번호가 있는 네이버 주소는 ? 뒤를 잘라 보낸다");
  assert.equal(env.input().value, `https://smartstore.naver.com/ishell/products/${OPTION_A}`, "잘라 낸 글을 입력칸에도 보인다");
  assert.match(env.status(), /추적용 꼬리\(\?…\)를 1개 지웠습니다/u);
  const targets = env.preview().querySelector(".mi-rank-option-targets");
  assert.deepEqual(targets.querySelectorAll("li").map((node) => [node.textContent, node.className]), [
    ["이 추적(아이폰 17 필름) · 지금 0개 → 1개 · 더함 1", ""],
    ["아이폰17 케이스 · 운영중 · 지금 3개 → 1개 · 뺌 2", "is-shrink"],
    ["아이폰17 필름 2매 · 운영중 · 지금 0개 → 1개 · 더함 1", ""],
  ]);
  assert.match(targets.textContent, /번호가 빠지는 다른 추적 1개/u);
  assert.equal(env.saveButton().disabled, false, "경고는 막지 않는다(체크를 끄면 이 추적만)");

  // 21개 이상(서버 400 + parsed): 무엇을 받았는지 보이되 저장은 켜지 않는다.
  env.input().value = Array.from({ length: 21 }, (_, index) => String(99900000100 + index)).join("\n");
  dispatch(env.input(), "input");
  env.respond({ ok: false, code: "RANK_OPTION_LIMIT", message: "그룹상품 번호는 최대 20개까지 넣을 수 있습니다.", parsed: parsedOf(Array.from({ length: 21 }, (_, index) => String(99900000100 + index)), { overLimit: true }) }, 400);
  click(env.previewButton());
  await flush();
  assert.equal(env.saveButton().disabled, true);
  assert.match(env.status(), /최대 20개/u);
  assert.match(env.preview().textContent, /넣은 칸 21개 → 번호 21개/u);
  assert.equal(env.preview().querySelector(".mi-rank-option-targets"), null, "실패한 미리 보기는 대상 목록을 그리지 않는다");
  assert.doesNotMatch(env.preview().textContent, /저장하면/u, "실패한 미리 보기에는 저장 안내를 쓰지 않는다");

  // 글이 너무 길면(서버 parsed.error) 해석 전이라 결과를 그리지 않고 서버 문장만 보인다.
  env.input().value = "1".repeat(30);
  dispatch(env.input(), "input");
  env.respond({ ok: false, code: "RANK_OPTION_INPUT_TOO_LONG", message: "붙여 넣은 글이 너무 깁니다. 한 번에 2만 자·60칸까지 넣을 수 있습니다.", parsed: parsedOf([], { error: "too_long" }) }, 400);
  click(env.previewButton());
  await flush();
  assert.equal(env.preview().textContent, "");
  assert.match(env.status(), /너무 깁니다/u);
  assert.equal(env.saveButton().disabled, true);
});

test("U9 편집창: 모두 지우기는 확인 뒤 이 추적만 비우는 미리 보기, 저장 안 한 입력은 닫기 전에 묻는다, Esc 로 닫힌다", async () => {
  const env = editorEnv({ confirmAnswers: [true, false, true] });
  env.respond(optionsPayload({ saved: [OPTION_A, OPTION_B] }));
  click(env.editButton);
  await flush();
  const clear = env.q("[data-rank-option-clear]");
  assert.equal(clear.hidden, false, "번호가 있으면 모두 지우기 버튼");
  env.respond(optionsPayload({ mode: "preview", saved: [OPTION_A, OPTION_B], parsed: parsedOf([]) }));
  click(clear);
  await flush();
  assert.match(env.confirms[0], /모두 지울까요/u);
  assert.deepEqual(plain(env.requests.at(-1).body), { action: "options", trackerId: TRACKER_ID, mode: "preview", optionInput: "", applyToSameProduct: false });
  assert.equal(env.apply().checked, false, "모두 지우기는 함께 적용 체크를 끈다");
  assert.match(env.preview().textContent, /번호 0개 — 저장하면 그룹상품 번호를 비우고 대표 상품번호만 찾습니다/u);
  assert.match(env.preview().textContent, /이 추적\(아이폰 17 필름\) · 지금 2개 → 0개 · 뺌 2/u);
  assert.equal(env.saveButton().disabled, false);

  // 저장하지 않은 입력이 있으면 닫기 전에 묻는다(아니요 → 그대로).
  dispatch(env.q(".mi-rank-option-card"), "keydown", { key: "Escape" });
  assert.match(env.confirms[1], /저장하지 않고 닫을까요/u);
  assert.equal(env.modal().hidden, false);
  dispatch(env.q(".mi-rank-option-card"), "keydown", { key: "Escape" });
  assert.equal(env.modal().hidden, true, "예 → 닫힘");

  // 범위(광고주)가 바뀌면 열린 창을 닫는다.
  env.respond(optionsPayload({ saved: [] }));
  click(env.editButton);
  await flush();
  assert.equal(env.modal().hidden, false);
  env.windowListeners["mi:rank-scope-changed"].forEach((handler) => handler());
  assert.equal(env.modal().hidden, true);
});

test("U9 편집창: 읽기가 실패하면(원부 추적 409·연결 실패) 입력·미리 보기·저장을 모두 막는다", async () => {
  const env = editorEnv();
  env.respond({ ok: false, code: "RANK_OPTION_CATALOG_TRACKER", message: "원부(가격비교) 추적에는 그룹상품 번호를 붙일 수 없습니다. 원부 순위는 원부 번호로 따로 추적하세요." }, 409);
  click(env.editButton);
  await flush();
  assert.match(env.status(), /원부\(가격비교\) 추적에는/u);
  assert.equal(env.input().disabled, true);
  assert.equal(env.previewButton().disabled, true);
  assert.equal(env.saveButton().disabled, true);
  dispatch(env.q(".mi-rank-option-card"), "keydown", { key: "Escape" });
  assert.equal(env.modal().hidden, true);

  env.fail("Failed to fetch");
  click(env.editButton);
  await flush();
  assert.match(env.status(), /연결을 확인한 뒤/u);
  assert.equal(env.previewButton().disabled, true);
});
