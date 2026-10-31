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

import { GROUP_OPTION_DROPPED_TAIL_PATTERN, GROUP_OPTION_UNVERIFIED_TAIL } from "./naver-rank-option-group.mjs";

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
  "rankOptionCheckInfo", "rankTrackerOptionState", "renderRankOptionOpsPills", "renderRankOptionHitLine", "renderRankTrackerCard",
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
    "compactRankSnapshotForCache", "cloneRankTrackerCardForShare", "renderRankHistory", "rankOptionCheckInfo",
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

function editorEnv({ confirmAnswers = [], lookup = null, now = null, install = false } = {}) {
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
  // 옵션 확인 버튼 설치 안내(관리자 화면 정적 HTML 의 details)를 흉내 낸다: 편집창이 카드에서 떼어 창 안에 넣는다.
  let installBlock = null;
  if (install) {
    installBlock = documentRef.createElement("details");
    installBlock.className = "mi-rank-option-install";
    installBlock.setAttribute("data-rank-option-install", "");
    installBlock.hidden = true;
    const link = documentRef.createElement("a");
    link.className = "mi-rank-option-bookmarklet";
    link.setAttribute("data-rank-option-bookmarklet", "");
    link.setAttribute("href", "javascript:void(0)");
    link.textContent = "모먼트 옵션 확인";
    installBlock.appendChild(link);
    rankCard.appendChild(installBlock);
  }
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
    // 관리자 initRankTracking 이 채우는 목록 창구(그룹상품 후보, 2026-10-27). 없으면 null.
    rankTrackerLookupForEditor: lookup,
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
  context.URL = URL;
  vm.createContext(context);
  if (now !== null) vm.runInContext(`Date.now = function () { return ${now}; };`, context);
  // 편집창이 부르는 화면 공통 도우미(상품 주소·옵션 확인일)는 원본 그대로 싣는다.
  vm.runInContext([
    htmlFunction(adminSource, "setStatus"),
    htmlFunction(adminSource, "rankTrackerProductUrl"),
    htmlFunction(adminSource, "rankOptionCheckInfo"),
    htmlFunction(adminSource, "initRankOptionProductEditor"),
    "initRankOptionProductEditor();",
  ].join("\n"), context);
  const modal = () => root.querySelector("[data-rank-option-modal]");
  const q = (selector) => modal().querySelector(selector);
  return {
    root, rankCard, editButton, requests, events, timers, confirms, windowListeners, documentRef, modal, q, installBlock,
    respond(payload, status = 200) { responses.push({ payload, status }); },
    fail(message) { responses.push({ throws: message }); },
    saveButton: () => q("[data-rank-option-save]"),
    previewButton: () => q("[data-rank-option-preview-run]"),
    input: () => q("[data-rank-option-input]"),
    apply: () => q("[data-rank-option-apply]"),
    status: () => q("[data-rank-option-status]").textContent,
    preview: () => q("[data-rank-option-preview]"),
    checkOnly: () => q("[data-rank-option-check-only]"),
    checkLine: () => q("[data-rank-option-checkline]"),
    // 넓은 화면 확인일 글(좁은 화면은 짧은 글 checkShort 만 보인다).
    checkText: () => q("[data-rank-option-checkline-full]").textContent,
    checkShort: () => q("[data-rank-option-checkline-short]").textContent,
    diffRow: (kind) => {
      const row = q("[data-rank-option-preview]").querySelector(`[data-rank-option-diff-row="${kind}"]`);
      return row ? row.querySelector(".mi-rank-option-chips").querySelectorAll("li").map((node) => node.textContent) : [];
    },
  };
}

function sibling(extra = {}) {
  return {
    id: SIBLING_ID, keyword: "아이폰17 케이스", status: "active", groupName: "아이쉘", primaryProductId: PRIMARY,
    relation: "same_primary", optionProductCount: 0, beforeOptionProductIds: [], afterOptionProductIds: [OPTION_A, OPTION_B],
    addedCount: 2, removedCount: 0, ...extra,
  };
}

// 서버 약속(2026-10-31): 읽기·미리 보기는 checkedAtReady·tracker.optionCheckedAt·expectedOptionProductIds(이 추적과
// 같은 상품 추적 전부의 DB 저장값 그대로)를 함께 준다.
function optionsPayload({
  mode = "read", saved = [], parsed = null, siblings = [sibling()], suggestions = [], willUpdateCount = 1, message = "",
  removed = [], checkedAt = null, checkedAtReady = true, expected = undefined,
} = {}) {
  return {
    ok: true,
    mode,
    columnReady: true,
    checkedAtReady,
    tracker: {
      id: TRACKER_ID, keyword: "아이폰 17 필름", primaryProductId: PRIMARY, productUrl: `https://smartstore.naver.com/ishell/products/${PRIMARY}`,
      optionProductIds: saved, optionCheckedAt: checkedAt,
    },
    parsed,
    sameProduct: { trackers: siblings, siblingOptionProductIds: suggestions, shrinkingTrackerCount: 0, limit: 100 },
    applyToSameProduct: false,
    willUpdateCount,
    targetTrackerIds: [TRACKER_ID],
    removedOptionProductIds: removed,
    expectedOptionProductIds: expected !== undefined ? expected : Object.fromEntries([
      [TRACKER_ID, saved], ...siblings.map((row) => [row.id, row.beforeOptionProductIds || []]),
    ]),
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
  // 번호는 저장된 번호와 비교한 칸 안에 보인다(B1, 2026-10-31): 저장 A · 붙여 넣음 A, B → 새로 추가 B · 같음 A.
  assert.match(previewText, /저장된 번호와 비교 · 새로 추가 1 · 빠짐 0 · 같음 1/u);
  assert.deepEqual(env.diffRow("added"), [OPTION_B]);
  assert.deepEqual(env.diffRow("same"), [OPTION_A]);
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
    // 미리 보기 응답의 추적별 저장값 그대로(B4)·전체 목록을 보고 저장(B6 확인일).
    expectedOptionProductIds: { [TRACKER_ID]: [], [SIBLING_ID]: [] },
    fullReview: true,
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
  // 대상이 바뀌었으면(U4) 지금 저장된 번호를 다시 읽는다 — 그 사이 같은 상품 추적이 하나 생겼다.
  env.respond(optionsPayload({ saved: [] }));
  click(env.saveButton());
  await flush();
  assert.deepEqual(plain(env.requests.at(-2).body.expectedTrackerIds), [TRACKER_ID]);
  assert.deepEqual(plain(env.requests.at(-1).body), { action: "options", trackerId: TRACKER_ID, mode: "read" });
  assert.equal(env.events.length, 0, "실패하면 목록 다시 읽기 신호를 보내지 않는다");
  assert.equal(env.saveButton().disabled, true);
  assert.equal(env.preview().textContent, "");
  assert.equal(env.status(), "미리 보기 뒤에 함께 바뀌는 추적이 달라졌습니다. 다시 미리 보기 해주세요. 최신 번호로 다시 불러왔습니다.",
    "서버 문장 뒤에 안내를 겹쳐 붙이지 않는다");
  assert.equal(env.input().value, "", "입력칸을 다시 읽은 저장 번호로 맞춘다");
  assert.equal(env.q(".mi-rank-option-apply").hidden, false, "다시 읽은 같은 상품 추적이 보인다");
  assert.equal(env.previewButton().disabled, false, "다시 미리 보기 할 수 있다");
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

// ─────────────────────────────────────────────────────────────
// U10~U12 그룹상품 표시·후보(대표 승인 2026-10-27 A안)
// ─────────────────────────────────────────────────────────────
const CAND_A = "99900000011";
const CAND_B = "99900000012";
function candidateEntry(productId, extra = {}) {
  return {
    productId,
    title: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
    mallName: "아이쉘",
    lprice: 9900,
    link: `https://smartstore.naver.com/main/products/${productId}`,
    seenCount: 3,
    keywordCount: 2,
    latestRank: 41,
    bestRank: 39,
    lastSeenAt: kst("2026-10-23", 9),
    sightings: [
      { keyword: "아이폰 필름", checkedAt: kst("2026-10-23", 9), rank: 41 },
      { keyword: "아이폰 17 필름", checkedAt: kst("2026-10-22", 15), rank: 39 },
    ],
    warnings: [{ code: "model_differs", text: "기종 다름: 아이폰 16 프로", detail: "추적 상품은 아이폰 17입니다." }],
    ...extra,
  };
}

function groupState(extra = {}) {
  return baseTracker({
    optionProductIds: [], optionProductCount: 0, optionEditable: true, groupOptionSuggestionCount: 0,
    groupMarkReady: true, groupProductMarked: false, groupProduct: false, ...extra,
  });
}

const GROUP_FIELDS = ["groupMarkReady", "groupProductMarked", "groupProduct", "groupCandidates"];
const withoutGroupFields = (tracker) => Object.fromEntries(Object.entries(tracker).filter(([key]) => !GROUP_FIELDS.includes(key)));

for (const [label, source] of PAGES) {
  test(`${label}: U10 카드 그룹상품 상태 네 가지가 한눈에, 광고주 화면은 예전 그대로`, () => {
    const states = {
      off: groupState(),
      empty: groupState({ groupProductMarked: true, groupProduct: true, groupCandidates: [] }),
      candidates: groupState({ groupProductMarked: true, groupProduct: true, groupCandidates: [candidateEntry(CAND_A), candidateEntry(CAND_B)] }),
      inUse: groupState({ optionProductIds: [OPTION_A, OPTION_B], optionProductCount: 2, groupProduct: true, groupCandidates: [candidateEntry(CAND_A)] }),
    };
    const html = Object.fromEntries(Object.entries(states).map(([key, tracker]) => [key, renderCard(source, label, tracker)]));
    if (label === "client.html") {
      for (const [key, tracker] of Object.entries(states)) {
        assert.equal(html[key], renderCard(source, label, withoutGroupFields(tracker)), `광고주 화면 ${key} 는 새 칸이 있어도 같다`);
        assert.doesNotMatch(html[key], /data-rank-group-mark|그룹상품 후보|후보 없음|사용 중/u);
      }
      return;
    }
    const buttons = (key) => parseHtml(html[key]).querySelector(".mi-rank-ops-row").querySelectorAll("button")
      .filter((node) => node.classList.includes("mi-rank-option-edit"))
      .map((node) => [node.textContent, node.getAttribute("aria-pressed"), node.getAttribute("data-rank-group-mark-next"), node.getAttribute("data-rank-option-focus")]);
    assert.deepEqual(buttons("off"), [["그룹상품으로 표시", "false", "true", null], ["그룹상품 번호 넣기", null, null, null]], "표시 안 함");
    assert.deepEqual(buttons("empty"), [["✓ 그룹상품 · 후보 없음", "true", "false", null], ["그룹상품 번호 넣기", null, null, null]], "그룹상품·후보 없음");
    assert.deepEqual(buttons("candidates"), [
      ["✓ 그룹상품", "true", "false", null],
      ["그룹상품 후보 2개 · 확인", null, null, "candidates"],
      ["그룹상품 번호 넣기", null, null, null],
    ], "후보 n개 확인 필요 — '그룹상품 번호 넣기' 옆");
    assert.deepEqual(buttons("inUse"), [["그룹상품 후보 1개 · 확인", null, null, "candidates"], ["그룹상품 번호", null, null, null]], "번호가 있으면 표시 버튼 없이 자동 그룹상품");
    assert.equal(parseHtml(html.inUse).querySelector(".mi-rank-option-pill").textContent, "그룹상품 · 번호 2개 사용 중");
    const card = parseHtml(html.candidates).querySelector(".mi-rank-tracker-card");
    const mark = card.querySelector("[data-rank-group-mark]");
    assert.equal(mark.getAttribute("data-rank-group-mark"), "t-1");
    assert.ok(mark.classList.includes("is-on"));
    const open = card.querySelector(".mi-rank-group-candidates");
    assert.equal(open.getAttribute("data-rank-option-edit"), "t-1", "후보 버튼은 같은 편집창을 연다");
    assert.equal(open.getAttribute("aria-haspopup"), "dialog");
    assert.ok(open.classList.includes("is-suggest"), "'가져오기' 권유와 같은 색");
    for (const node of [mark, open]) assert.ok(node.hasAttribute("data-rank-export-omit"), "공유 이미지에서 빠진다");
    const shared = shareClone(source, label, html.candidates);
    assert.equal(shared.querySelector("[data-rank-group-mark]"), null);
    assert.doesNotMatch(shared.textContent, /그룹상품 후보|✓ 그룹상품/u);

    // 표시 칸이 없으면(대표 SQL 전) 버튼을 숨긴다 = U1 과 같은 카드. 종료 추적·광고주 역할에는 아무것도 없다.
    assert.equal(renderCard(source, label, groupState({ groupMarkReady: false })), renderCard(source, label, withoutGroupFields(groupState())));
    for (const [tracker, role] of [[groupState({ status: "completed", groupProductMarked: true, groupCandidates: [candidateEntry(CAND_A)] }), "owner"], [states.candidates, "client"]]) {
      assert.doesNotMatch(renderCard(source, label, tracker, role), /data-rank-group-mark|그룹상품 후보/u);
    }
  });
}

function candidateEnv(tracker, options = {}) {
  const env = editorEnv({ lookup: (id) => (id === TRACKER_ID ? tracker : null), ...options });
  const candButton = env.documentRef.createElement("button");
  candButton.setAttribute("data-rank-option-edit", TRACKER_ID);
  candButton.setAttribute("data-rank-option-keyword", "아이폰 17 필름");
  candButton.setAttribute("data-rank-option-primary", PRIMARY);
  candButton.setAttribute("data-rank-option-focus", "candidates");
  env.rankCard.appendChild(candButton);
  const cardStatus = env.documentRef.createElement("p");
  cardStatus.setAttribute("data-rank-status", "");
  env.rankCard.appendChild(cardStatus);
  return {
    ...env,
    candButton,
    cardStatus,
    section: () => env.q("[data-rank-cand]"),
    items: () => env.q("[data-rank-cand]").querySelectorAll("[data-rank-cand-item]"),
    pick: (index) => {
      const box = env.q("[data-rank-cand]").querySelectorAll("[data-rank-cand-pick]")[index];
      box.checked = !box.checked;
      dispatch(box, "change");
      return box;
    },
    add: () => env.q("[data-rank-cand-add]"),
    confirm: () => env.q("[data-rank-cand-confirm]"),
    confirmRun: () => env.q("[data-rank-cand-confirm-run]"),
    result: () => env.q(".mi-rank-cand-result").textContent,
  };
}

const candidateTracker = (extra = {}) => ({
  id: TRACKER_ID, groupMarkReady: true, groupProductMarked: true, groupProduct: true, optionProductCount: 1,
  groupCandidates: [candidateEntry(OPTION_A), candidateEntry(CAND_A), candidateEntry(CAND_B, { title: "아이쉘 아이폰17 프로 저반사 액정보호필름", lprice: null, seenCount: 2, keywordCount: 1, latestRank: 50, bestRank: 50, warnings: [] })],
  ...extra,
});

test("U11 후보 확인 창: 카드처럼 비교, '모두 고르기' 없음, 고른 개수 확인 뒤 기존 저장 경로(미리 보기 → 저장)", async () => {
  const env = candidateEnv(candidateTracker());
  env.respond(optionsPayload({ saved: [OPTION_A] }));
  click(env.candButton);
  await flush();
  assert.equal(env.section().hidden, false);
  assert.equal(env.q("[id=\"mi-rank-cand-title\"]").textContent, "그룹상품 후보 2개 · 확인 필요", "이미 넣은 번호는 후보에서 뺀다");
  assert.match(env.q(".mi-rank-cand-howto").textContent, /아직 순위에는 쓰지 않았습니다/u, "사용법 한 줄");
  const [first, second] = env.items();
  assert.equal(first.getAttribute("data-rank-cand-item"), CAND_A);
  assert.equal(first.querySelector(".mi-rank-cand-title").textContent, "아이쉘 아이폰16 프로 저반사 액정보호필름 2매");
  assert.deepEqual(first.querySelector(".mi-rank-cand-facts").querySelectorAll("li").map((node) => [node.textContent, node.className]), [
    ["스토어 아이쉘", ""],
    ["가격 9,900원", ""],
    ["최근 41위 · 최고 39위", ""],
    ["3번 보임 · 키워드 2개", "is-seen"],
    ["기종 다름: 아이폰 16 프로", "is-warn"],
  ]);
  assert.equal(first.querySelector(".mi-rank-cand-seen").textContent, "나온 곳 · 아이폰 필름 10/23 41위 · 아이폰 17 필름 10/22 39위");
  const link = first.querySelector(".mi-rank-cand-open");
  assert.equal(link.getAttribute("href"), `https://smartstore.naver.com/main/products/${CAND_A}`);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.match(second.querySelector(".mi-rank-cand-facts").textContent, /가격 정보 없음.*2번 보임/u);
  assert.equal(env.documentRef.activeElement, env.section().querySelector("[data-rank-cand-pick]"), "후보 버튼으로 열면 첫 후보에 초점");
  assert.equal(env.modal().querySelectorAll("button").filter((node) => /모두 고르기|모두 선택|전체 선택/u.test(node.textContent)).length, 0, "모두 고르기 없음");

  assert.equal(env.add().disabled, true, "고르기 전에는 넣기 꺼짐");
  env.pick(0);
  assert.equal(env.add().disabled, false);
  assert.equal(env.add().textContent, "고른 1개 넣기");
  assert.ok(env.items()[0].classList.contains("is-picked"));
  assert.deepEqual(env.items().map((node) => node.querySelector("[data-rank-cand-pick-label]").textContent), ["고름", "고르기"], "고른 카드는 글자로도 보인다");
  env.pick(1);
  assert.equal(env.add().textContent, "고른 2개 넣기");
  assert.equal(env.q(".mi-rank-cand-count").textContent, "고른 후보 2개");

  click(env.add());
  assert.equal(env.confirm().hidden, false, "저장 전 고른 개수 확인");
  assert.match(env.confirm().textContent, /고른 후보 2개를 그룹상품 번호에 넣고 바로 저장할까요\?/u);
  assert.equal(env.confirm().querySelector(".mi-rank-cand-confirm-warn").textContent,
    "고른 후보 중 1개에 경고(기종 다름 등)가 있습니다. 상품 페이지에서 같은 그룹상품의 옵션인지 확인했을 때만 넣으세요.", "경고 붙은 후보를 골랐으면 한 번 더 알린다");
  assert.deepEqual(env.confirm().querySelector(".mi-rank-option-chips").querySelectorAll("li").map((node) => node.textContent), [CAND_A, CAND_B]);
  assert.match(env.confirm().textContent, /넣은 뒤 그룹상품 번호 3개 · 적용: 이 추적과 같은 대표 상품번호를 쓰는 다른 키워드 추적 1개/u);
  assert.equal(env.confirmRun().textContent, "2개 넣고 저장");
  assert.equal(env.documentRef.activeElement, env.confirmRun());
  assert.ok(env.section().querySelectorAll("[data-rank-cand-pick]").every((box) => box.disabled), "확인 중에는 고르기를 바꿀 수 없다");
  assert.equal(env.requests.length, 1, "확인 전에는 요청하지 않는다");
  click(env.q("[data-rank-cand-cancel]"));
  assert.equal(env.confirm().hidden, true, "취소");
  assert.equal(env.add().textContent, "고른 2개 넣기", "고른 것은 그대로");
  click(env.add());

  env.respond({ ...optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A, CAND_A, CAND_B]), willUpdateCount: 2 }), targetTrackerIds: [TRACKER_ID, SIBLING_ID] });
  env.respond({ ok: true, mode: "save", updatedCount: 2, updatedTrackerIds: [TRACKER_ID, SIBLING_ID], optionProductIds: [OPTION_A, CAND_A, CAND_B], message: "저장" });
  click(env.confirmRun());
  await flush();
  assert.deepEqual(plain(env.requests[1].body), { action: "options", trackerId: TRACKER_ID, mode: "preview", optionInput: `${OPTION_A}\n${CAND_A}\n${CAND_B}`, applyToSameProduct: true });
  assert.deepEqual(plain(env.requests[2].body), {
    action: "options", trackerId: TRACKER_ID, mode: "save", optionInput: `${OPTION_A}\n${CAND_A}\n${CAND_B}`, applyToSameProduct: true,
    expectedTrackerIds: [TRACKER_ID, SIBLING_ID],
    // 후보 넣기도 미리 보기의 저장값 조건을 쓰지만(B4) 전체 목록 확인이 아니라 확인일은 바꾸지 않는다(B6).
    expectedOptionProductIds: { [TRACKER_ID]: [OPTION_A], [SIBLING_ID]: [] },
    fullReview: false,
  }, "저장은 기존 옵션 저장 API('다른 키워드에도 적용' 포함)");
  assert.equal(env.events.length, 1);
  assert.equal(env.events[0].type, "mi:rank-trackers-changed");
  const line = "후보 2개를 넣었습니다 · 그룹상품 번호 3개 · 추적 2개에 저장 · 다음 순위 확인부터 적용됩니다.";
  assert.equal(env.result(), line, "저장 뒤 결과 한 줄");
  assert.equal(env.cardStatus.textContent, line, "카드 상태 줄에도 남는다(창을 닫아도 보임)");
  assert.equal(env.q(".mi-rank-cand-actions").hidden, true);
  assert.deepEqual(env.items().map((node) => node.querySelector("[data-rank-cand-pick-label]").textContent), ["넣음", "넣음"], "넣은 뒤 카드 글자");
  assert.equal(env.input().value, `${OPTION_A}\n${CAND_A}\n${CAND_B}`);
  assert.equal(env.timers.length, 0, "결과를 읽게 저절로 닫지 않는다");
  assert.equal(env.documentRef.activeElement, env.q(".mi-rank-option-card"), "저장 뒤 초점은 창에 남는다");
});

test("U11 후보: 창을 연 뒤 다른 곳에서 번호가 바뀌면(미리 보기의 지금 목록 ≠ 읽은 목록) 저장하지 않고 입력칸을 최신으로 맞춘다", async () => {
  const env = candidateEnv(candidateTracker());
  env.respond(optionsPayload({ saved: [OPTION_A] }));
  click(env.candButton);
  await flush();
  env.pick(0);
  click(env.add());
  env.respond({ ...optionsPayload({ mode: "preview", saved: [OPTION_A, OPTION_B], parsed: parsedOf([OPTION_A, CAND_A]), willUpdateCount: 2 }), targetTrackerIds: [TRACKER_ID, SIBLING_ID] });
  click(env.confirmRun());
  await flush();
  assert.equal(env.requests.length, 2, "읽기·미리 보기만 하고 저장하지 않는다");
  assert.match(env.result(), /다른 곳에서 이 추적의 그룹상품 번호가 바뀌어\(지금 2개\) 저장하지 않았습니다/u);
  assert.equal(env.input().value, `${OPTION_A}\n${OPTION_B}`, "입력칸을 최신 번호로");
  assert.equal(env.confirm().hidden, true);
  assert.equal(env.add().textContent, "고른 1개 넣기", "고른 것은 그대로 — 다시 넣으면 최신 번호에 합친다");
});

test("U11 후보: 저장 안 한 입력·20개 초과·서버 거절은 막고 쉬운 말로 알린다, 빈 상태 문구, 고른 뒤 닫으면 묻는다", async () => {
  const env = candidateEnv(candidateTracker(), { confirmAnswers: [false, true] });
  env.respond(optionsPayload({ saved: [OPTION_A] }));
  click(env.editButton);
  await flush();
  assert.equal(env.documentRef.activeElement, env.input(), "'그룹상품 번호' 버튼으로 열면 입력칸에 초점");
  env.pick(0);
  env.input().value = `${OPTION_A}\n99900000099`;
  dispatch(env.input(), "input");
  click(env.add());
  assert.equal(env.confirm().hidden, true);
  assert.match(env.result(), /저장하지 않은 번호가 있습니다/u);
  env.input().value = OPTION_A;
  dispatch(env.input(), "input");
  click(env.add());
  assert.equal(env.confirm().hidden, false);
  env.respond({ ok: false, code: "RANK_OPTION_LIMIT", message: "그룹상품 번호는 최대 20개까지 넣을 수 있습니다." }, 400);
  click(env.confirmRun());
  await flush();
  assert.match(env.result(), /최대 20개.*저장하지 않았습니다/u);
  assert.equal(env.events.length, 0, "실패하면 목록 다시 읽기 없음");
  assert.equal(env.confirm().hidden, true);
  assert.equal(env.add().disabled, false, "다시 시도할 수 있다");
  // 고른 뒤 닫으면 묻는다(아니요 → 그대로, 예 → 닫힘).
  dispatch(env.q(".mi-rank-option-card"), "keydown", { key: "Escape" });
  assert.match(env.confirms.at(-1), /고른 그룹상품 후보를 넣지 않고 닫을까요/u);
  assert.equal(env.modal().hidden, false);
  dispatch(env.q(".mi-rank-option-card"), "keydown", { key: "Escape" });
  assert.equal(env.modal().hidden, true);

  const full = candidateEnv(candidateTracker());
  const twenty = Array.from({ length: 20 }, (_, index) => String(99900000100 + index));
  full.respond(optionsPayload({ saved: twenty }));
  click(full.candButton);
  await flush();
  full.pick(0);
  click(full.add());
  assert.equal(full.confirm().hidden, true);
  assert.match(full.result(), /최대 20개입니다\. 지금 20개라 0개까지 더 넣을 수 있습니다/u);

  const empty = candidateEnv(candidateTracker({ groupCandidates: [] }));
  empty.respond(optionsPayload({ saved: [] }));
  click(empty.editButton);
  await flush();
  assert.equal(empty.q("[id=\"mi-rank-cand-title\"]").textContent, "그룹상품 후보");
  assert.match(empty.q(".mi-rank-cand-howto").textContent, /아직 후보가 없습니다\. 대표 상품번호가 300개 결과에 없을 때/u);
  assert.equal(empty.q(".mi-rank-cand-actions").hidden, true);

  const notGroup = candidateEnv(candidateTracker({ groupProductMarked: false, groupProduct: false, optionProductCount: 0, groupCandidates: undefined }));
  notGroup.respond(optionsPayload({ saved: [] }));
  click(notGroup.editButton);
  await flush();
  assert.match(notGroup.q(".mi-rank-cand-howto").textContent, /그룹상품으로 표시돼 있지 않아 후보를 찾지 않습니다/u);

  const noColumn = candidateEnv(candidateTracker({ groupMarkReady: false, groupProductMarked: false, groupProduct: false, optionProductCount: 0, groupCandidates: undefined }));
  noColumn.respond(optionsPayload({ saved: [] }));
  click(noColumn.editButton);
  await flush();
  assert.equal(noColumn.section().hidden, true, "표시 칸이 없고 그룹상품이 아니면 후보 칸을 숨긴다");
});

test("U12 카드 '그룹상품으로 표시': 켜기는 한 번에, 끄기는 확인 뒤, action group-mark, 결과 한 줄·목록 다시 읽기", async () => {
  const env = candidateEnv(candidateTracker(), { confirmAnswers: [false, true] });
  const markButton = env.documentRef.createElement("button");
  markButton.setAttribute("data-rank-group-mark", TRACKER_ID);
  markButton.setAttribute("data-rank-group-mark-next", "true");
  env.rankCard.appendChild(markButton);
  env.respond({ ok: true, marked: true, updatedCount: 2, updatedTrackerIds: [TRACKER_ID, SIBLING_ID], message: "그룹상품으로 표시했습니다(같은 상품 추적 2개). 다음 순위 확인부터 대표 상품번호가 결과에 없으면 같은 스토어 후보를 찾습니다." });
  click(markButton);
  assert.equal(markButton.disabled, true, "요청 중 다시 못 누름");
  await flush();
  assert.deepEqual(plain(env.requests[0].body), { action: "group-mark", trackerId: TRACKER_ID, marked: true });
  assert.equal(env.modal(), null, "편집창은 열지 않는다");
  assert.match(env.cardStatus.textContent, /^그룹상품으로 표시했습니다\(같은 상품 추적 2개\)/u);
  assert.equal(env.events.length, 1);
  assert.deepEqual(plain(env.events[0].detail.trackerIds), [TRACKER_ID, SIBLING_ID]);
  assert.equal(markButton.disabled, false);

  markButton.setAttribute("data-rank-group-mark-next", "false");
  click(markButton);
  await flush();
  assert.match(env.confirms[0], /그룹상품 표시를 끌까요\?/u);
  assert.equal(env.requests.length, 1, "아니요 → 요청 없음");
  env.respond({ ok: false, code: "RANK_GROUP_MARK_NOT_READY", message: "그룹상품 표시 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요." }, 409);
  click(markButton);
  await flush();
  assert.deepEqual(plain(env.requests[1].body), { action: "group-mark", trackerId: TRACKER_ID, marked: false });
  assert.match(env.cardStatus.textContent, /대표 SQL 실행 뒤/u);
  assert.ok(env.cardStatus.classList.contains("is-warn"));
  assert.equal(env.events.length, 1, "실패하면 목록 다시 읽기 없음");
});

test("U11 후보: 함께 적용하면 다른 키워드 추적의 따로 넣은 번호가 빠질 때는 넣지 않는다(읽은 값·서버 미리 보기 두 번 확인), 확인 중에는 아래 입력을 잠근다", async () => {
  // 읽은 값으로 미리 안다: 다른 추적에 이 추적에 없는 번호(99900000007)가 있다.
  const env = candidateEnv(candidateTracker());
  env.respond(optionsPayload({ saved: [OPTION_A], siblings: [sibling({ optionProductCount: 2, beforeOptionProductIds: [OPTION_A, "99900000007"] })] }));
  click(env.candButton);
  await flush();
  env.pick(0);
  click(env.add());
  assert.equal(env.confirm().hidden, true, "확인 칸을 열지 않는다");
  assert.match(env.result(), /다른 키워드 추적 1개\(아이폰17 케이스\)에 따로 넣어 둔 번호가 있어, 함께 넣으면 그 번호가 빠집니다\. 저장하지 않았습니다/u);
  assert.equal(env.requests.length, 1, "요청 없음");
  // 체크를 끄면 이 추적에만 넣는다.
  env.apply().checked = false;
  dispatch(env.apply(), "change");
  click(env.add());
  assert.equal(env.confirm().hidden, false);
  assert.match(env.confirm().textContent, /적용: 이 추적만/u);
  assert.equal(env.input().disabled, true, "확인 중에는 입력칸 잠금");
  assert.equal(env.apply().disabled, true, "확인 중에는 함께 적용 체크 잠금");
  assert.equal(env.previewButton().disabled, true);
  assert.equal(env.saveButton().disabled, true);
  env.respond({ ...optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A, CAND_A]), siblings: [] }), targetTrackerIds: [TRACKER_ID] });
  env.respond({ ok: true, mode: "save", updatedCount: 1, updatedTrackerIds: [TRACKER_ID], optionProductIds: [OPTION_A, CAND_A], message: "저장" });
  click(env.confirmRun());
  await flush();
  assert.equal(plain(env.requests[1].body).applyToSameProduct, false);
  assert.deepEqual(plain(env.requests[2].body).expectedTrackerIds, [TRACKER_ID]);
  assert.match(env.result(), /추적 1개에 저장/u);

  // 읽은 값에는 없었지만 서버 미리 보기가 빠지는 추적을 알려 주면 저장하지 않는다.
  const late = candidateEnv(candidateTracker());
  late.respond(optionsPayload({ saved: [OPTION_A] }));
  click(late.candButton);
  await flush();
  late.pick(0);
  click(late.add());
  late.respond({ ...optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A, CAND_A]), siblings: [sibling({ removedCount: 1, beforeOptionProductIds: ["99900000008"], afterOptionProductIds: [OPTION_A, CAND_A] })] }), targetTrackerIds: [TRACKER_ID, SIBLING_ID] });
  click(late.confirmRun());
  await flush();
  assert.equal(late.requests.length, 2, "미리 보기만 하고 저장하지 않는다");
  assert.match(late.result(), /함께 넣으면 그 번호가 빠집니다/u);
  assert.equal(late.documentRef.activeElement, late.add(), "막힌 뒤 초점은 다시 보이는 '고른 후보 넣기'로");
  assert.equal(late.events.length, 0);

  // 확인 중 입력이 (스크립트 등으로) 바뀌었으면 저장 직전에 다시 막는다.
  const dirty = candidateEnv(candidateTracker());
  dirty.respond(optionsPayload({ saved: [OPTION_A], siblings: [] }));
  click(dirty.candButton);
  await flush();
  dirty.pick(0);
  click(dirty.add());
  dirty.input().value = `${OPTION_A}\n99900000099`;
  click(dirty.confirmRun());
  await flush();
  assert.equal(dirty.requests.length, 1);
  assert.match(dirty.result(), /저장하지 않은 번호가 있습니다/u);
});

test("U12 표시 끄기 확인 문구: 번호를 넣은 추적은 번호가 있는 동안 계속 그룹상품", async () => {
  const env = candidateEnv(candidateTracker(), { confirmAnswers: [false] });
  const markButton = env.documentRef.createElement("button");
  markButton.setAttribute("data-rank-group-mark", TRACKER_ID);
  markButton.setAttribute("data-rank-group-mark-next", "false");
  env.rankCard.appendChild(markButton);
  click(markButton);
  await flush();
  assert.match(env.confirms[0], /그룹상품 번호를 넣은 추적은 번호가 있는 동안 계속 그룹상품입니다/u);
  assert.equal(env.requests.length, 0);
});

// 옵션 판정 건너뜀(대표 승인 2026-10-30): 서버가 대표 결과 그대로 기록하며 남긴 이유를 관리자 카드 '그룹상품 확인' 줄에
// 한 줄로 보인다. 광고주 화면은 표시 없는 같은 측정과 HTML 이 글자 하나까지 같다.
for (const [label, source] of PAGES) {
  test(`${label}: 옵션 판정 건너뜀 이유는 관리자 카드 한 줄, 광고주 화면 출력은 그대로`, () => {
    const message = "네이버쇼핑 오가닉 300위 안에서 찾지 못했습니다.";
    const make = (optionGroup, extra = {}) => baseTracker({
      optionProductIds: [OPTION_A, OPTION_B], optionProductCount: 2, optionEditable: true, currentMatchBasis: null,
      currentRank: null, lastMessage: message,
      snapshots: [snapshot(kst("2026-10-23", 9), null, { trackingRankSource: "not_found", ...(optionGroup ? { optionGroup } : {}), ...extra })],
    });
    const plainHtml = renderCard(source, label, make(null));
    const cases = [
      [{ checkedOptionCount: 2, skipped: "lookup_budget_exhausted" }, "옵션 판정 건너뜀 · 같은 키워드에 확인할 번호가 너무 많음", /같은 키워드 추적들에 넣은 번호를 점검/u],
      [{ checkedOptionCount: 2, skipped: "evaluation_error", errorName: "TypeError", errorMessage: "x is not a function" }, "옵션 판정 건너뜀 · 확인 중 오류", /기록했습니다\. 번호를 확인하다 오류가 났습니다/u],
      [{ checkedOptionCount: 2, skipped: "final_result_rejected" }, "옵션 판정 건너뜀 · 잡힌 카드가 마지막 확인을 통과하지 못함", /마지막 확인을 통과하지 못했습니다/u],
      [{ checkedOptionCount: 2, skipped: "selector_missing" }, "옵션 판정 건너뜀 · 판정 준비 오류", /판정을 시작하지 못했습니다/u],
      [{ checkedOptionCount: 2, skipped: "constructor" }, "옵션 판정 건너뜀 · 기타", /다음 측정에서 다시 확인합니다/u],
    ];
    for (const [optionGroup, text, titlePattern] of cases) {
      const html = renderCard(source, label, make(optionGroup));
      if (label === "client.html") {
        assert.equal(html, plainHtml, "광고주 화면은 건너뜀 표시 없는 측정과 같은 HTML");
        continue;
      }
      const lines = parseHtml(html).querySelectorAll("[data-rank-option-hit]");
      assert.equal(lines.length, 1, "한 줄");
      assert.deepEqual(lines[0].children.filter((node) => node instanceof MiniElement).map((node) => node.textContent), ["그룹상품 확인", text]);
      const title = lines[0].querySelector(".is-warn").getAttribute("title");
      assert.match(title, /^이번 측정은 넣은 그룹상품 번호를 순위에 쓰지 못하고 대표 상품번호 결과 그대로 기록했습니다\. /u);
      assert.match(title, titlePattern);
      assert.equal(/x is not a function|TypeError/u.test(title), false, "오류 이름·문구는 화면에 싣지 않는다");
      assert.equal(parseHtml(html).querySelector(".mi-rank-ops-message").textContent, `메시지 ${message}`, "문장은 대표 결과 그대로");
    }
    // matchBasis 가 있는 측정(정상 판정)에는 건너뜀 키가 섞여 와도 보이지 않는다 — 정상 판정 카드는 예전과 같다.
    const normal = make({ checkedOptionCount: 2 }, { matchBasis: "not_found" });
    const normalSkipped = make({ checkedOptionCount: 2, skipped: "evaluation_error" }, { matchBasis: "not_found" });
    assert.equal(renderCard(source, label, normalSkipped), renderCard(source, label, normal));
    assert.doesNotMatch(plainHtml, /옵션 판정 건너뜀/u);
  });
}

// 창에 보였지만 순위에 못 쓴 번호(2026-10-30 추가): 관리자 카드 '그룹상품 확인' 줄에 한 줄. 광고주 화면에는 줄이 없고,
// '메시지'는 관리자용 꼬리를 뺀 문장이다(서버 GROUP_OPTION_DROPPED_TAIL_PATTERN 과 같은 글자로 뺀다).
const ISHELL_OPTION = "11463197547";
for (const [label, source] of PAGES) {
  test(`${label}: 창에 보였지만 순위에 못 쓴 번호는 관리자 카드 한 줄, 광고주 화면에는 줄·꼬리 없음`, () => {
    const main = "대표 상품번호와 그룹상품 옵션 3개 모두 오가닉 상위 300개 결과에서 순위로 잡지 못했습니다.";
    const tail = " 옵션 3개 중 1개는 결과에 보였지만 같은 상품으로 확인되지 않아 순위에 쓰지 않았습니다.";
    const make = (basis, optionGroup, extra = {}) => baseTracker({
      optionProductIds: [OPTION_A, ISHELL_OPTION, OPTION_B], optionProductCount: 3, optionEditable: true,
      currentMatchBasis: basis, currentRank: null, lastMessage: main + tail,
      snapshots: [snapshot(kst("2026-10-23", 9), null, { trackingRankSource: "not_found", matchBasis: basis, optionGroup })],
      ...extra,
    });
    const dropped = make("not_found", { checkedOptionCount: 3, droppedVisibleCount: 1, droppedVisible: [{ productId: ISHELL_OPTION, reason: "not_exact" }] });
    // 광고주 응답 모양(서버가 두 키를 뺀 item).
    const advertiserShape = make("not_found", { checkedOptionCount: 3 });
    const messageOf = (html) => parseHtml(html).querySelector(".mi-rank-ops-message");
    for (const role of ["owner", "client"]) {
      const html = renderCard(source, label, dropped, role);
      if (label === "admin.html" && role === "owner") {
        const lines = parseHtml(html).querySelectorAll("[data-rank-option-hit]");
        assert.equal(lines.length, 1, "한 줄");
        assert.deepEqual(lines[0].children.filter((node) => node instanceof MiniElement).map((node) => node.textContent),
          ["그룹상품 확인", `보였지만 순위에 못 쓴 번호 1개 · ${ISHELL_OPTION}`]);
        assert.equal(lines[0].querySelector(".is-warn").getAttribute("title"),
          `이번 결과에 보였지만 순위에 쓰지 않은 번호입니다: ${ISHELL_OPTION}(같은 상품으로 확인 안 됨). 순위에는 쓰지 않고 이 줄에만 남깁니다. 같은 그룹상품 번호가 맞는지 확인해주세요.`);
        assert.equal(messageOf(html).textContent, `메시지 ${main}${tail}`, "관리자 세션은 꼬리까지");
        continue;
      }
      assert.equal(parseHtml(html).querySelectorAll("[data-rank-option-hit]").length, 0, `${role}: 줄 없음`);
      assert.equal(messageOf(html).textContent, `메시지 ${main}`, `${role}: 꼬리를 뺀 문장`);
      assert.equal(html, renderCard(source, label, advertiserShape, role), `${role}: 상세 키가 있어도 없어도 같은 HTML`);
    }
    // 대표가 이긴 측정: 목록 상한(10개)을 넘은 개수는 '외 n개', 이유 모름은 '기타'.
    if (label === "admin.html") {
      const ids = Array.from({ length: 10 }, (_, index) => String(99900009100 + index));
      const many = make("primary", {
        checkedOptionCount: 12, droppedVisibleCount: 12,
        droppedVisible: ids.map((productId, index) => ({ productId, reason: index === 1 ? "rejected" : (index === 2 ? "x" : "not_exact") })),
      }, { currentRank: 12, lastMessage: "네이버쇼핑 오가닉 12위" });
      const note = parseHtml(renderCard(source, label, many)).querySelector("[data-rank-option-hit]").querySelector(".is-warn");
      assert.equal(note.textContent, `보였지만 순위에 못 쓴 번호 12개 · ${ids.slice(0, 3).join(", ")} 외 9개`);
      assert.match(note.getAttribute("title"), new RegExp(`${ids[1]}\\(순위 확인 통과 못함\\), ${ids[2]}\\(기타\\)`, "u"));
    }
    // 옵션이 이긴 측정에도 서버가 남긴다(2026-10-30): 관리자는 '잡힌 옵션' 줄 끝에 같은 한 줄, 광고주 화면은 키 없는 측정과 같은 HTML.
    const hit = optionHitTracker();
    const hitDropped = optionHitTracker();
    hitDropped.snapshots[0].item.optionGroup = { ...hitDropped.snapshots[0].item.optionGroup, droppedVisibleCount: 1, droppedVisible: [{ productId: ISHELL_OPTION, reason: "not_exact" }] };
    for (const role of ["owner", "client"]) {
      const html = renderCard(source, label, hitDropped, role);
      if (label === "admin.html" && role === "owner") {
        const line = parseHtml(html).querySelector("[data-rank-option-hit]");
        assert.equal(line.querySelector(".mi-rank-option-hit-label").textContent, "잡힌 옵션");
        const notes = line.querySelectorAll(".is-warn").map((node) => node.textContent);
        assert.equal(notes[notes.length - 1], `보였지만 순위에 못 쓴 번호 1개 · ${ISHELL_OPTION}`);
      } else {
        assert.equal(html, renderCard(source, label, hit, role), `${role}: 키가 있어도 없어도 같은 HTML`);
      }
    }
  });
}

test("창에 보였지만 못 쓴 번호 꼬리: 두 화면이 빼는 패턴은 서버 GROUP_OPTION_DROPPED_TAIL_PATTERN 과 같은 글자", () => {
  for (const [label, source] of PAGES) {
    const card = htmlFunction(source, "renderRankTrackerCard", label);
    assert.ok(card.includes(`if (!optionState.admin && typeof lastMessage === "string") lastMessage = lastMessage.replace(/${GROUP_OPTION_DROPPED_TAIL_PATTERN.source}/${GROUP_OPTION_DROPPED_TAIL_PATTERN.flags}, "");`), label);
  }
});

// ─────────────────────────────────────────────────────────────
// U13~U17 옵션 번호 정식판(대표 승인 2026-10-31, 구현 명세 §3): 카드 옵션 확인일 배지(관리자만)·편집창 비교 표(B1)·
// 대표 상품번호 없음 경고(B2)·빠지는 번호 확인(B3)·저장값 조건 전송과 서버 거절 문장(B4)·상품 페이지 열기(B5)·
// 옵션 확인일과 '확인만 기록'(B6)·버튼 설치 안내(A7)
// ─────────────────────────────────────────────────────────────
const OPTION_C = "99900000003";
const checkTracker = (extra = {}) => baseTracker({
  optionProductIds: [OPTION_A, OPTION_B], optionProductCount: 2, optionEditable: true, optionCheckReady: true, optionCheckedAt: null, ...extra,
});
const CHECK_FIELDS = ["optionCheckReady", "optionCheckedAt"];
const withoutCheckFields = (tracker) => Object.fromEntries(Object.entries(tracker).filter(([key]) => !CHECK_FIELDS.includes(key)));
const checkBadge = (html) => parseHtml(html).querySelector("[data-rank-option-check]");

for (const [label, source] of PAGES) {
  test(`${label}: U13 옵션 확인일 배지 — 30일 안 '옵션 확인 M/D'·30일(한국 달력)부터 '옵션 다시 확인'·기록 없음, 관리자만`, () => {
    const render = (extra, role = "owner") => renderCard(source, label, checkTracker(extra), role);
    if (label === "client.html") {
      for (const extra of [{}, { optionCheckedAt: kst("2026-10-01") }, { optionCheckedAt: kst("2026-09-01") }]) {
        const html = render(extra);
        assert.doesNotMatch(html, /data-rank-option-check|옵션 확인|옵션 다시 확인/u, "광고주 화면에는 배지가 없다");
        assert.equal(html, renderCard(source, label, withoutCheckFields(checkTracker(extra))), "칸이 있어도 없어도 같은 HTML");
      }
      return;
    }
    // NOW = 2026-10-23 12:00 KST.
    const recent = checkBadge(render({ optionCheckedAt: kst("2026-10-01", 9) }));
    assert.equal(recent.textContent, "옵션 확인 10/1");
    assert.deepEqual(recent.classList, ["mi-rank-option-check"], "30일 안은 조용한 톤");
    assert.ok(recent.hasAttribute("data-rank-export-omit"), "공유 이미지에서 빠진다");
    assert.match(recent.getAttribute("title"), /^마지막 옵션 확인 2026-10-01\(22일 전\)\. /u);
    assert.equal(checkBadge(render({ optionCheckedAt: kst("2026-10-23", 8) })).getAttribute("title").slice(0, 26), "마지막 옵션 확인 2026-10-23(오늘). ");
    // 경계: 한국 달력 기준 29일은 그대로, 30일부터 '다시 확인'. UTC 날짜가 아니라 한국 날짜로 센다.
    assert.equal(checkBadge(render({ optionCheckedAt: "2026-09-23T15:30:00.000Z" })).textContent, "옵션 확인 9/24", "09-24 00:30 KST → 29일");
    const due = checkBadge(render({ optionCheckedAt: "2026-09-23T14:30:00.000Z" }));
    assert.equal(due.textContent, "옵션 다시 확인", "09-23 23:30 KST → 30일");
    assert.deepEqual(due.classList, ["mi-rank-option-check", "is-due"]);
    assert.match(due.getAttribute("title"), /2026-09-23\(30일 전\)/u);
    const none = checkBadge(render({ optionCheckedAt: null }));
    assert.equal(none.textContent, "옵션 확인 기록 없음");
    assert.ok(none.classList.includes("is-due"));
    assert.equal(checkBadge(render({ optionCheckedAt: "날짜 아님" })).textContent, "옵션 확인 기록 없음", "읽을 수 없는 값은 기록 없음");
    // 배지는 '그룹상품 · 번호 n개 사용 중' 알약 바로 뒤.
    const ops = parseHtml(render({})).querySelector(".mi-rank-ops-row");
    const pillIndex = ops.children.findIndex((node) => node instanceof MiniElement && node.classList.includes("mi-rank-option-pill"));
    assert.ok(ops.children[pillIndex + 1].hasAttribute("data-rank-option-check"));

    // 숨김: 칸이 없거나(대표 SQL 전 optionCheckReady false·옛 응답) 번호가 없거나 종료 추적이거나 광고주 역할 세션.
    const plainCard = renderCard(source, label, withoutCheckFields(checkTracker()));
    assert.equal(render({ optionCheckReady: false }), plainCard);
    assert.equal(renderCard(source, label, checkTracker({ optionCheckReady: undefined })), plainCard);
    assert.doesNotMatch(render({ optionProductIds: [], optionProductCount: 0 }), /data-rank-option-check/u);
    assert.doesNotMatch(render({ status: "completed" }), /data-rank-option-check/u);
    assert.doesNotMatch(render({}, "client"), /data-rank-option-check/u);
    // 공유 이미지 복제에는 없다.
    assert.equal(shareClone(source, label, render({ optionCheckedAt: kst("2026-09-01") })).querySelector("[data-rank-option-check]"), null);
  });
}

test("U13 옵션 확인일 도우미는 한국 달력 날짜로 센다(두 화면 같은 글자)", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${NOW}; };\n${htmlFunction(clientSource, "rankOptionCheckInfo")}`, context);
  const info = (value) => plain(vm.runInContext(`rankOptionCheckInfo(${JSON.stringify(value)})`, context));
  assert.deepEqual(info(kst("2026-10-23", 0)), { day: "2026-10-23", short: "10/23", days: 0, due: false });
  assert.deepEqual(info("2026-09-24T14:59:59.000Z"), { day: "2026-09-24", short: "9/24", days: 29, due: false });
  assert.deepEqual(info("2026-09-23T15:00:00.000Z"), { day: "2026-09-24", short: "9/24", days: 29, due: false });
  assert.deepEqual(info("2026-09-23T14:59:59.000Z"), { day: "2026-09-23", short: "9/23", days: 30, due: true });
  assert.deepEqual(info("2026-10-25T00:00:00.000Z"), { day: "2026-10-25", short: "10/25", days: 0, due: false }, "앞선 시각(시계 차이)은 오늘로");
  for (const value of [null, "", "x", undefined]) assert.equal(info(value), null);
});

async function openEditorWith(env, payload) {
  env.respond(payload);
  click(env.editButton);
  await flush();
}

async function previewWith(env, text, payload) {
  env.input().value = text;
  dispatch(env.input(), "input");
  env.respond(payload);
  click(env.previewButton());
  await flush();
}

test("U14 편집창 비교 표(B1)·대표 상품번호 없음 경고(B2)·빠지는 번호(B3)와 저장 버튼 글자, 한 번 누르면 저장", async () => {
  const env = editorEnv();
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A, OPTION_B], siblings: [] }));
  const alerts = () => ({
    primary: env.preview().querySelector("[data-rank-option-primary-warn]"),
    removed: env.preview().querySelector("[data-rank-option-removed-warn]"),
  });

  // 같은 목록: 비교만, 경고 없음, '저장'.
  await previewWith(env, `${OPTION_A}\n${OPTION_B}`, optionsPayload({ mode: "preview", saved: [OPTION_A, OPTION_B], siblings: [], parsed: parsedOf([OPTION_A, OPTION_B]) }));
  assert.match(env.preview().textContent, /저장된 번호와 비교 · 새로 추가 0 · 빠짐 0 · 같음 2/u);
  assert.deepEqual([env.diffRow("added"), env.diffRow("removed"), env.diffRow("same")], [[], [], [OPTION_A, OPTION_B]]);
  assert.deepEqual(alerts(), { primary: null, removed: null });
  assert.equal(env.saveButton().textContent, "저장");

  // 버튼으로 복사한 목록(대표 번호 포함): 새로 추가 C · 빠짐 B → 빨간 줄과 '빠지는 번호 1개 확인하고 저장'.
  await previewWith(env, `${PRIMARY}\n${OPTION_A}\n${OPTION_C}`, optionsPayload({
    mode: "preview", saved: [OPTION_A, OPTION_B], siblings: [], removed: [OPTION_B],
    parsed: parsedOf([OPTION_A, OPTION_C], { inputTokenCount: 3, primaryRemoved: true, primaryRemovedCount: 1 }),
  }));
  assert.match(env.preview().textContent, /새로 추가 1 · 빠짐 1 · 같음 1/u);
  assert.deepEqual([env.diffRow("added"), env.diffRow("removed"), env.diffRow("same")], [[OPTION_C], [OPTION_B], [OPTION_A]]);
  assert.equal(alerts().primary, null, "대표 상품번호가 들어 있으면 경고 없음");
  assert.ok(alerts().removed.classList.contains("is-danger"));
  assert.match(alerts().removed.textContent, new RegExp(`^저장하면 빠지는 번호 1개: ${OPTION_B}\\. 빠진 번호로는 더 이상 순위를 찾지 않습니다\\.`, "u"));
  assert.equal(env.saveButton().textContent, "빠지는 번호 1개 확인하고 저장");
  assert.equal(env.saveButton().disabled, false, "경고는 막지 않는다");

  // 대표 번호 없는 새 번호(다른 상품 페이지에서 복사했을 수 있음) + 빠지는 번호.
  await previewWith(env, `99900000008\n99900000009`, optionsPayload({
    mode: "preview", saved: [OPTION_A, OPTION_B], siblings: [], removed: [OPTION_A, OPTION_B], parsed: parsedOf(["99900000008", "99900000009"]),
  }));
  assert.ok(alerts().primary.classList.contains("is-warn"), "노란 경고");
  assert.match(alerts().primary.textContent, /^이 추적의 대표 상품번호가 목록에 없습니다\. 다른 상품 페이지에서 복사했을 수 있습니다\./u);
  assert.match(alerts().primary.textContent, new RegExp(`대표 상품번호\\(${PRIMARY}\\)`, "u"));
  assert.equal(env.saveButton().textContent, "경고·빠지는 번호 확인하고 저장");

  // 대표 번호 없는 새 번호만(빠짐 없음) → '경고 확인하고 저장'.
  await previewWith(env, `${OPTION_A}\n${OPTION_B}\n${OPTION_C}`, optionsPayload({
    mode: "preview", saved: [OPTION_A, OPTION_B], siblings: [], parsed: parsedOf([OPTION_A, OPTION_B, OPTION_C]),
  }));
  assert.ok(alerts().primary);
  assert.equal(alerts().removed, null);
  assert.equal(env.saveButton().textContent, "경고 확인하고 저장");
  // 입력이 바뀌면 지난 확인 사항 글자도 거둔다.
  env.input().value = OPTION_A;
  dispatch(env.input(), "input");
  assert.equal(env.saveButton().textContent, "저장");
  assert.equal(env.saveButton().disabled, true);

  // 저장된 번호를 빼기만 하면(새 번호 없음) 대표 번호 경고는 없다 — 빠지는 번호만.
  await previewWith(env, OPTION_A, optionsPayload({ mode: "preview", saved: [OPTION_A, OPTION_B], siblings: [], removed: [OPTION_B], parsed: parsedOf([OPTION_A]) }));
  assert.equal(alerts().primary, null);
  assert.equal(env.saveButton().textContent, "빠지는 번호 1개 확인하고 저장");
  // 버튼은 한 번 누르면 저장한다(묻지 않음).
  env.respond({ ok: true, mode: "save", updatedCount: 1, updatedTrackerIds: [TRACKER_ID], optionProductIds: [OPTION_A], checkedAtRecorded: true, message: "저장" });
  click(env.saveButton());
  await flush();
  assert.equal(env.confirms.length, 0);
  assert.equal(env.requests.at(-1).body.mode, "save");
  assert.equal(env.requests.at(-1).body.fullReview, true);
});

test("U14 대표 상품번호 경고(B2)는 '같은 상품의 다른 추적에서 가져오기'로 넣은 번호에는 뜨지 않는다(U1)", async () => {
  const env = editorEnv();
  await openEditorWith(env, optionsPayload({ saved: [], siblings: [], suggestions: [OPTION_A, OPTION_B] }));
  click(env.q("[data-rank-option-import]"));
  assert.equal(env.input().value, `${OPTION_A}\n${OPTION_B}`);
  // 서버 미리 보기의 같은 상품 번호(siblingOptionProductIds)는 입력에 든 번호를 빼고 온다 — 빈 목록이어도 읽을 때 받은 번호로 본다.
  env.respond(optionsPayload({ mode: "preview", saved: [], siblings: [], suggestions: [], parsed: parsedOf([OPTION_A, OPTION_B]) }));
  click(env.previewButton());
  await flush();
  assert.deepEqual(env.diffRow("added"), [OPTION_A, OPTION_B]);
  assert.equal(env.preview().querySelector("[data-rank-option-primary-warn]"), null, "가져온 번호는 다른 상품에서 복사한 번호가 아니다");
  assert.equal(env.saveButton().textContent, "저장");

  // 같은 상품 추적에 없던 번호가 하나라도 섞이면 경고(다른 상품 페이지에서 복사했을 수 있음).
  await previewWith(env, `${OPTION_A}\n${OPTION_B}\n${OPTION_C}`, optionsPayload({
    mode: "preview", saved: [], siblings: [], suggestions: [], parsed: parsedOf([OPTION_A, OPTION_B, OPTION_C]),
  }));
  assert.ok(env.preview().querySelector("[data-rank-option-primary-warn]"));
  assert.equal(env.saveButton().textContent, "경고 확인하고 저장");
});

test("U16 상품 페이지 열기(B5)는 카드 제목 링크와 같은 주소 — 목록 추적의 상품 주소가 비면 최근 순위 결과 링크(U6)", async () => {
  const link = `https://smartstore.naver.com/ishell/products/${PRIMARY}?NaPm=ct%3Dabc`;
  const listTracker = baseTracker({ id: TRACKER_ID, productUrl: "", product_url: "", snapshots: [snapshot(kst("2026-10-23", 9), 12, { link })] });
  // 카드 제목 링크(renderRankProductTitle 원본)가 쓰는 주소.
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(["escapeHtml", "rankTrackerProductUrl", "renderRankProductTitle"].map((name) => htmlFunction(adminSource, name)).join("\n"), context);
  context.__tracker = listTracker;
  const cardHref = decodeEntities(vm.runInContext('renderRankProductTitle(__tracker, "상품")', context).match(/href="([^"]*)"/u)[1]);
  assert.equal(cardHref, link);

  const env = editorEnv({ now: NOW, lookup: (id) => (id === TRACKER_ID ? listTracker : null) });
  const payload = optionsPayload({ saved: [OPTION_A] });
  payload.tracker.productUrl = ""; // 편집 API 는 product_url 칸만 준다.
  await openEditorWith(env, payload);
  const open = env.q("[data-rank-option-open]");
  assert.equal(open.hidden, false);
  assert.equal(open.getAttribute("href"), cardHref, "카드 제목 링크와 같은 주소");

  // 두 주소가 다르면 카드 제목과 같은 목록 추적 주소를 쓴다. 목록에 없으면 편집 API 주소(U16 위 시험).
  const own = editorEnv({ now: NOW, lookup: (id) => (id === TRACKER_ID ? baseTracker({ id: TRACKER_ID }) : null) });
  const otherPayload = optionsPayload({ saved: [OPTION_A] });
  otherPayload.tracker.productUrl = "https://smartstore.naver.com/other/products/99900000077";
  await openEditorWith(own, otherPayload);
  assert.equal(own.q("[data-rank-option-open]").getAttribute("href"), `https://smartstore.naver.com/ishell/products/${PRIMARY}`);
});

test("U14 모두 지우기·함께 바뀌는 다른 추적에서 빠지는 번호도 B3 로 센다", async () => {
  const env = editorEnv({ confirmAnswers: [true] });
  const shrinking = sibling({ optionProductCount: 2, beforeOptionProductIds: [OPTION_A, "99900000007"], afterOptionProductIds: [OPTION_A, OPTION_C], addedCount: 1, removedCount: 1 });
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A], siblings: [sibling({ beforeOptionProductIds: [OPTION_A, "99900000007"], optionProductCount: 2 })] }));
  await previewWith(env, `${PRIMARY}\n${OPTION_A}\n${OPTION_C}`, optionsPayload({
    mode: "preview", saved: [OPTION_A], siblings: [shrinking], willUpdateCount: 2,
    parsed: parsedOf([OPTION_A, OPTION_C], { inputTokenCount: 3, primaryRemoved: true }),
  }));
  const removedWarn = env.preview().querySelector("[data-rank-option-removed-warn]");
  assert.match(removedWarn.textContent, /빠지는 번호 1개: 99900000007\. .*다른 키워드 추적 1개에서도 번호가 빠집니다\./u);
  assert.equal(env.diffRow("removed").length, 0, "이 추적 비교 칸에는 이 추적에서 빠지는 번호만");
  assert.equal(env.saveButton().textContent, "빠지는 번호 1개 확인하고 저장");
  // 체크를 끄면(이 추적만) 다른 추적은 빠지지 않는다.
  env.apply().checked = false;
  dispatch(env.apply(), "change");
  await previewWith(env, `${PRIMARY}\n${OPTION_A}\n${OPTION_C}`, optionsPayload({
    mode: "preview", saved: [OPTION_A], siblings: [shrinking], parsed: parsedOf([OPTION_A, OPTION_C], { inputTokenCount: 3, primaryRemoved: true }),
  }));
  assert.equal(env.preview().querySelector("[data-rank-option-removed-warn]"), null);
  assert.equal(env.saveButton().textContent, "저장");

  // 모두 지우기: 목록이 비면 빨간 줄이 '모두 지웁니다'로 시작한다.
  const clearEnv = editorEnv({ confirmAnswers: [true] });
  await openEditorWith(clearEnv, optionsPayload({ saved: [OPTION_A, OPTION_B], siblings: [] }));
  clearEnv.respond(optionsPayload({ mode: "preview", saved: [OPTION_A, OPTION_B], siblings: [], removed: [OPTION_A, OPTION_B], parsed: parsedOf([]) }));
  click(clearEnv.q("[data-rank-option-clear]"));
  await flush();
  assert.match(clearEnv.preview().querySelector("[data-rank-option-removed-warn]").textContent, new RegExp(`^이 추적의 그룹상품 번호를 모두 지웁니다\\. 저장하면 빠지는 번호 2개: ${OPTION_A}, ${OPTION_B}\\.`, "u"));
  assert.match(clearEnv.preview().textContent, /번호 0개 — 저장하면 그룹상품 번호를 비우고 대표 상품번호만 찾습니다/u);
  assert.equal(clearEnv.saveButton().textContent, "빠지는 번호 2개 확인하고 저장");
});

test("U15 저장 거절(B4): 동시 변경·되돌림 기록 실패·옛 화면·일부 저장은 서버 문장 그대로, 이미 바뀐 추적은 개수를 알리고 목록 다시 읽기", async () => {
  const typed = `${PRIMARY}\n${OPTION_A}\n${OPTION_B}`;
  const cases = [
    // 동시 변경(U4): 지금 저장된 번호를 다시 읽어 입력칸을 맞춘다. 이미 바뀐 추적이 있으면 개수를 알린다(U5).
    {
      failure: { ok: false, code: "RANK_OPTION_CHANGED", message: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요.", updatedTrackerIds: [SIBLING_ID] },
      reread: optionsPayload({ saved: [OPTION_A, OPTION_C] }),
      status: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요. 추적 1개는 이미 새 번호로 저장됐습니다. 최신 번호로 다시 불러왔습니다.",
      input: `${OPTION_A}\n${OPTION_C}`,
      reloaded: [SIBLING_ID],
    },
    // 다시 읽기가 끊기면 저장 결과 문장은 그대로 두고 창을 다시 열라고 한다.
    {
      failure: { ok: false, code: "RANK_OPTION_CHANGED", message: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요." },
      rereadFails: true,
      status: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요. 최신 번호를 다시 불러오지 못했습니다. 창을 닫고 다시 열어주세요.",
      input: typed,
      reloaded: null,
    },
    {
      failure: { ok: false, code: "RANK_OPTION_AUDIT_FAILED", message: "되돌림 기록을 남기지 못해 저장하지 않았습니다. 잠시 뒤 다시 저장해주세요." },
      status: "되돌림 기록을 남기지 못해 저장하지 않았습니다. 잠시 뒤 다시 저장해주세요.",
      input: typed,
      reloaded: null,
    },
    {
      failure: { ok: false, code: "RANK_OPTION_PREVIEW_REQUIRED", message: "화면을 새로 고친 뒤 다시 미리 보기 해주세요." },
      status: "화면을 새로 고친 뒤 다시 미리 보기 해주세요.",
      input: typed,
      reloaded: null,
    },
    // 일부 저장(U5): 서버 문장(다시 미리 보기 안내 포함)에 이미 새 번호로 바뀐 추적 수를 붙인다. 이미 바뀐 추적은 저장값이
    // 미리 보기 때와 달라졌으므로 지금 저장된 번호를 다시 읽어 저장값·입력칸을 DB 에 맞춘다(M2).
    {
      failure: { ok: false, code: "RANK_OPTION_PARTIAL", message: "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.", updatedTrackerIds: [TRACKER_ID] },
      reread: optionsPayload({ saved: [OPTION_A, OPTION_B] }),
      status: "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요. 추적 1개는 이미 새 번호로 저장됐습니다. 최신 번호로 다시 불러왔습니다.",
      input: `${OPTION_A}\n${OPTION_B}`,
      reloaded: [TRACKER_ID],
    },
  ];
  for (const { failure, reread, rereadFails, status, input, reloaded } of cases) {
    const env = editorEnv();
    await openEditorWith(env, optionsPayload({ saved: [OPTION_A] }));
    await previewWith(env, typed, optionsPayload({
      mode: "preview", saved: [OPTION_A], willUpdateCount: 2, parsed: parsedOf([OPTION_A, OPTION_B], { primaryRemoved: true }),
      expected: { [TRACKER_ID]: [OPTION_A], [SIBLING_ID]: [] },
    }));
    env.respond(failure, 409);
    if (reread) env.respond(reread);
    if (rereadFails) env.fail("Failed to fetch");
    const before = env.requests.length;
    click(env.saveButton());
    await flush();
    const sent = env.requests.slice(before).map((request) => plain(request.body));
    assert.deepEqual(sent[0].expectedOptionProductIds, { [TRACKER_ID]: [OPTION_A], [SIBLING_ID]: [] }, "미리 보기 값 그대로 보낸다");
    assert.deepEqual(sent.slice(1), reread || rereadFails ? [{ action: "options", trackerId: TRACKER_ID, mode: "read" }] : [],
      `${failure.code}: 번호·대상이 바뀐 거절·일부 저장만 다시 읽는다`);
    assert.equal(env.status(), status, `${failure.code}: 서버 문장 그대로`);
    assert.equal(env.input().value, input, `${failure.code}: 입력칸`);
    assert.equal(env.preview().textContent, "", "다시 미리 보기 하게 둔다");
    assert.equal(env.saveButton().disabled, true);
    assert.equal(env.saveButton().textContent, "저장");
    assert.equal(env.previewButton().disabled, false, "다시 미리 보기 할 수 있다");
    assert.deepEqual(env.events.map((event) => plain(event.detail.trackerIds)), reloaded ? [reloaded] : [], `${failure.code}: 이미 바뀐 추적만 다시 읽기`);
  }
});

test("U15 후보 넣기 저장 거절(U5·U7): 서버 문장 + 이미 바뀐 추적 수 + '후보를 다시 골라 넣어주세요.'", async () => {
  // 그 사이 다른 곳에서 CAND_B 가 들어갔다(동시 변경·대상 바뀜 뒤 다시 읽는 지금 저장값, M2).
  const latest = optionsPayload({ saved: [OPTION_A, CAND_B], expected: { [TRACKER_ID]: [CAND_B, OPTION_A], [SIBLING_ID]: [] } });
  const cases = [
    {
      failure: { ok: false, code: "RANK_OPTION_CHANGED", message: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요.", updatedTrackerIds: [SIBLING_ID] },
      line: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요. 추적 1개는 이미 새 번호로 저장됐습니다. 후보를 다시 골라 넣어주세요. 최신 번호로 다시 불러왔습니다.",
      reread: latest,
    },
    {
      failure: { ok: false, code: "RANK_OPTION_TARGETS_CHANGED", message: "미리 보기 뒤에 함께 바뀌는 추적이 달라졌습니다. 다시 미리 보기 해주세요." },
      line: "미리 보기 뒤에 함께 바뀌는 추적이 달라졌습니다. 다시 미리 보기 해주세요. 후보를 다시 골라 넣어주세요. 최신 번호로 다시 불러왔습니다.",
      reread: latest,
    },
    {
      failure: { ok: false, code: "RANK_OPTION_AUDIT_FAILED", message: "되돌림 기록을 남기지 못해 저장하지 않았습니다. 잠시 뒤 다시 저장해주세요." },
      line: "되돌림 기록을 남기지 못해 저장하지 않았습니다. 잠시 뒤 다시 저장해주세요. 후보를 다시 골라 넣어주세요.",
    },
    // 일부 저장(F5): 다른 추적만 저장되고 이 추적은 그 사이 바뀐 번호라 저장되지 않았다 → 일반 저장처럼 다시 읽는다.
    {
      failure: { ok: false, code: "RANK_OPTION_PARTIAL", message: "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.", updatedTrackerIds: [SIBLING_ID] },
      line: "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요. 추적 1개는 이미 새 번호로 저장됐습니다. 후보를 다시 골라 넣어주세요. 최신 번호로 다시 불러왔습니다.",
      reread: latest,
    },
    // 그 밖의 거절은 예전처럼 서버 문장 + ' 다시 골라 넣어주세요.'(이미 바뀐 추적 수는 그 앞에).
    {
      failure: { ok: false, code: "RANK_OPTION_NOT_READY", message: "그룹상품 번호 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요." },
      line: "그룹상품 번호 칸이 아직 DB 에 없습니다. 대표 SQL 실행 뒤 다시 시도해주세요. 다시 골라 넣어주세요.",
    },
  ];
  for (const { failure, line, reread } of cases) {
    const env = candidateEnv(candidateTracker());
    env.respond(optionsPayload({ saved: [OPTION_A] }));
    click(env.candButton);
    await flush();
    env.pick(0);
    click(env.add());
    env.respond({ ...optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A, CAND_A]), willUpdateCount: 2 }), targetTrackerIds: [TRACKER_ID, SIBLING_ID] });
    env.respond(failure, 409);
    if (reread) env.respond(reread);
    click(env.confirmRun());
    await flush();
    const modes = env.requests.map((request) => request.body.mode);
    assert.deepEqual(modes, reread ? ["read", "preview", "save", "read"] : ["read", "preview", "save"], `${failure.code}: 번호·대상이 바뀐 거절·일부 저장만 다시 읽는다`);
    assert.equal(env.result(), line, failure.code);
    assert.equal(env.add().disabled, false, `${failure.code}: 다시 고를 수 있다`);
    if (!reread) {
      assert.equal(env.input().value, OPTION_A, `${failure.code}: 입력칸 그대로`);
      continue;
    }
    // 저장값·입력칸·후보 목록이 DB 의 지금 번호에 맞는다: 입력칸은 최신 번호, 이미 들어간 CAND_B 는 후보에서 빠지고 고른 CAND_A 는 그대로.
    assert.equal(env.input().value, `${OPTION_A}\n${CAND_B}`, `${failure.code}: 입력칸을 최신 번호로`);
    assert.deepEqual(env.items().map((node) => node.getAttribute("data-rank-cand-item")), [CAND_A], `${failure.code}: 후보 목록도 최신 번호 기준`);
    assert.equal(env.add().textContent, "고른 1개 넣기");
    // 다시 읽은 저장값이 다음 '확인만 기록' 조건으로 간다(열린 창의 저장값 = DB).
    env.apply().checked = false;
    dispatch(env.apply(), "change");
    env.respond({ ok: true, mode: "save", updatedCount: 1, updatedTrackerIds: [TRACKER_ID], optionProductIds: [OPTION_A, CAND_B], checkedAtRecorded: true, optionCheckedAt: "2026-10-23T03:00:00.000Z", message: "저장" });
    env.respond(latest);
    click(env.checkOnly());
    await flush();
    const checkBody = plain(env.requests.at(-2).body);
    assert.equal(checkBody.checkOnly, true);
    assert.equal(checkBody.optionInput, `${OPTION_A}\n${CAND_B}`);
    assert.deepEqual(checkBody.expectedOptionProductIds, { [TRACKER_ID]: [CAND_B, OPTION_A], [SIBLING_ID]: [] }, `${failure.code}: 다시 읽은 저장값`);
  }
});

test("U15 일반 저장 일부 저장(M2): 다시 읽은 저장값·입력칸이 DB 와 같아 다음 '확인만 기록'이 그 값으로 간다", async () => {
  const env = editorEnv({ now: NOW });
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A], siblings: [] }));
  await previewWith(env, `${PRIMARY}\n${OPTION_A}\n${OPTION_B}`, optionsPayload({
    mode: "preview", saved: [OPTION_A], siblings: [], parsed: parsedOf([OPTION_A, OPTION_B], { primaryRemoved: true }),
  }));
  env.respond({ ok: false, code: "RANK_OPTION_PARTIAL", message: "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.", updatedTrackerIds: [TRACKER_ID] }, 409);
  // 이 추적은 새 번호로 저장됐다(DB 저장값은 순서까지 그대로 받는다).
  env.respond(optionsPayload({ saved: [OPTION_B, OPTION_A], siblings: [], expected: { [TRACKER_ID]: [OPTION_B, OPTION_A] } }));
  click(env.saveButton());
  await flush();
  assert.deepEqual(plain(env.requests.at(-1).body), READ_BODY);
  assert.equal(env.input().value, `${OPTION_B}\n${OPTION_A}`, "입력칸 = DB 의 지금 번호");
  env.respond({ ok: true, mode: "save", updatedCount: 1, updatedTrackerIds: [TRACKER_ID], optionProductIds: [OPTION_B, OPTION_A], checkedAtRecorded: true, optionCheckedAt: "2026-10-23T03:00:00.000Z", message: "저장" });
  env.respond(optionsPayload({ saved: [OPTION_B, OPTION_A], siblings: [], expected: { [TRACKER_ID]: [OPTION_B, OPTION_A] } }));
  click(env.checkOnly());
  await flush();
  const body = plain(env.requests.at(-2).body);
  assert.equal(body.checkOnly, true, "저장 안 한 입력으로 막히지 않는다");
  assert.equal(body.optionInput, `${OPTION_B}\n${OPTION_A}`);
  assert.deepEqual(body.expectedOptionProductIds, { [TRACKER_ID]: [OPTION_B, OPTION_A] }, "다시 읽은 저장값(미리 보기 때 값이 아님)");
});

test("U15 저장됐는지 알 수 없는 추적(H1 uncertainTrackerIds): 서버 문장 그대로 + 다시 읽기 + 카드 다시 읽기 — 일반 저장·후보 넣기·확인만 기록", async () => {
  // 서버 모양(2026-10-31): 쓰기 결과를 모르는 묶음이 있으면 RANK_OPTION_PARTIAL + uncertainTrackerIds, 문장에 안내가 들어 있다.
  const uncertainMessage = "저장 중 오류가 났습니다. 추적 1개는 저장됐는지 확인하지 못했습니다. 편집창을 다시 열어 확인해주세요.";
  const failure = (extra = {}) => ({ ok: false, code: "RANK_OPTION_PARTIAL", message: uncertainMessage, updatedTrackerIds: [], uncertainTrackerIds: [SIBLING_ID], ...extra });
  const typed = `${PRIMARY}\n${OPTION_A}\n${OPTION_B}`;
  const previewPayload = () => optionsPayload({ mode: "preview", saved: [OPTION_A], willUpdateCount: 2, parsed: parsedOf([OPTION_A, OPTION_B], { primaryRemoved: true }) });

  // 일반 저장: 서버 문장(그 안내 포함) + 이미 바뀐 추적 수 + 다시 읽기. 화면 안내(' 미리 보기를 다시 눌러주세요.')는 붙이지 않는다.
  const savedMessage = "추적 2개 중 1개를 저장했습니다. 추적 1개는 저장됐는지 확인하지 못했습니다. 편집창을 다시 열어 확인해주세요.";
  const env = editorEnv();
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A] }));
  await previewWith(env, typed, previewPayload());
  env.respond(failure({ message: savedMessage, updatedTrackerIds: [TRACKER_ID] }), 409);
  env.respond(optionsPayload({ saved: [OPTION_A, OPTION_B] }));
  click(env.saveButton());
  await flush();
  assert.deepEqual(plain(env.requests.at(-1).body), READ_BODY, "다시 읽는다");
  assert.equal(env.status(), `${savedMessage} 추적 1개는 이미 새 번호로 저장됐습니다. 최신 번호로 다시 불러왔습니다.`);
  assert.equal(env.input().value, `${OPTION_A}\n${OPTION_B}`, "입력칸 = DB 의 지금 번호");
  assert.equal(env.preview().textContent, "");
  assert.deepEqual(env.events.map((event) => plain(event.detail.trackerIds)), [[TRACKER_ID, SIBLING_ID]], "저장됐는지 알 수 없는 추적도 카드 다시 읽기");

  // 코드가 서버 문장을 그대로 보이는 목록 밖이어도 uncertainTrackerIds 가 있으면 같은 처리를 한다.
  const other = editorEnv();
  await openEditorWith(other, optionsPayload({ saved: [OPTION_A] }));
  await previewWith(other, typed, previewPayload());
  other.respond(failure({ code: "RANK_OPTION_SAVE_FAILED" }), 500);
  other.respond(optionsPayload({ saved: [OPTION_A] }));
  click(other.saveButton());
  await flush();
  assert.deepEqual(plain(other.requests.at(-1).body), READ_BODY);
  assert.equal(other.status(), `${uncertainMessage} 최신 번호로 다시 불러왔습니다.`);
  assert.equal(other.input().value, OPTION_A);
  assert.deepEqual(other.events.map((event) => plain(event.detail.trackerIds)), [[SIBLING_ID]]);

  // 같은 거절이라도 uncertainTrackerIds 가 비면 예전 그대로(다시 읽기 없음·화면 안내 덧붙임).
  const quiet = editorEnv();
  await openEditorWith(quiet, optionsPayload({ saved: [OPTION_A] }));
  await previewWith(quiet, typed, previewPayload());
  quiet.respond({ ok: false, code: "RANK_OPTION_SAVE_FAILED", message: "저장하지 못했습니다.", uncertainTrackerIds: [] }, 500);
  click(quiet.saveButton());
  await flush();
  assert.equal(quiet.requests.at(-1).body.mode, "save");
  assert.equal(quiet.status(), "저장하지 못했습니다. 미리 보기를 다시 눌러주세요.");
  assert.equal(quiet.input().value, typed);
  assert.equal(quiet.events.length, 0);

  // 후보 넣기: 서버 문장 + ' 후보를 다시 골라 넣어주세요.' + 다시 읽기.
  const cand = candidateEnv(candidateTracker());
  cand.respond(optionsPayload({ saved: [OPTION_A] }));
  click(cand.candButton);
  await flush();
  cand.pick(0);
  click(cand.add());
  cand.respond({ ...optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A, CAND_A]), willUpdateCount: 2 }), targetTrackerIds: [TRACKER_ID, SIBLING_ID] });
  cand.respond(failure(), 409);
  cand.respond(optionsPayload({ saved: [OPTION_A] }));
  click(cand.confirmRun());
  await flush();
  assert.deepEqual(cand.requests.map((request) => request.body.mode), ["read", "preview", "save", "read"]);
  assert.equal(cand.result(), `${uncertainMessage} 후보를 다시 골라 넣어주세요. 최신 번호로 다시 불러왔습니다.`);
  assert.deepEqual(cand.events.map((event) => plain(event.detail.trackerIds)), [[SIBLING_ID]]);
  assert.equal(cand.add().disabled, false);

  // 확인만 기록: 서버 문장 그대로 + 다시 읽기.
  const check = editorEnv({ now: NOW });
  await openEditorWith(check, optionsPayload({ saved: [OPTION_A], siblings: [] }));
  check.respond(failure(), 409);
  check.respond(optionsPayload({ saved: [OPTION_A], siblings: [] }));
  click(check.checkOnly());
  await flush();
  assert.equal(check.requests.at(-2).body.checkOnly, true);
  assert.deepEqual(plain(check.requests.at(-1).body), READ_BODY);
  assert.equal(check.status(), `${uncertainMessage} 최신 번호로 다시 불러왔습니다.`);
  assert.deepEqual(check.events.map((event) => plain(event.detail.trackerIds)), [[SIBLING_ID]]);
});

test("U15 후보 넣기 일부 저장(F5): RANK_OPTION_PARTIAL 은 uncertainTrackerIds 가 있든 없든 다시 읽고 후보 목록을 지금 번호 기준으로 다시 그린다", async () => {
  const partialMessage = "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.";
  for (const extra of [{}, { uncertainTrackerIds: [SIBLING_ID] }]) {
    const label = extra.uncertainTrackerIds ? "uncertainTrackerIds 있음" : "uncertainTrackerIds 없음";
    const env = candidateEnv(candidateTracker());
    env.respond(optionsPayload({ saved: [OPTION_A] }));
    click(env.candButton);
    await flush();
    env.pick(0);
    click(env.add());
    env.respond({ ...optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A, CAND_A]), willUpdateCount: 2 }), targetTrackerIds: [TRACKER_ID, SIBLING_ID] });
    env.respond({ ok: false, code: "RANK_OPTION_PARTIAL", message: partialMessage, updatedTrackerIds: [TRACKER_ID], ...extra }, 409);
    // 이 추적은 고른 후보까지 저장됐다(다른 추적은 저장되지 않았거나 저장됐는지 모른다).
    env.respond(optionsPayload({ saved: [OPTION_A, CAND_A] }));
    click(env.confirmRun());
    await flush();
    assert.deepEqual(env.requests.map((request) => request.body.mode), ["read", "preview", "save", "read"], `${label}: 다시 읽는다`);
    assert.deepEqual(plain(env.requests.at(-1).body), READ_BODY, label);
    assert.equal(env.result(), `${partialMessage} 추적 1개는 이미 새 번호로 저장됐습니다. 후보를 다시 골라 넣어주세요. 최신 번호로 다시 불러왔습니다.`, label);
    assert.equal(env.input().value, `${OPTION_A}\n${CAND_A}`, `${label}: 입력칸 = DB 의 지금 번호`);
    assert.deepEqual(env.items().map((node) => node.getAttribute("data-rank-cand-item")), [CAND_B], `${label}: 이미 들어간 CAND_A 는 후보에서 빠진다`);
    assert.equal(env.add().textContent, "고른 후보 넣기", `${label}: 고른 후보도 지금 번호 기준`);
    assert.equal(env.add().disabled, true, label);
    assert.equal(env.q("[data-rank-option-kept]").hidden, true, `${label}: 넣으려던 목록이 그대로 저장돼 보관할 것이 없다`);
    assert.deepEqual(env.events.map((event) => plain(event.detail.trackerIds)), [extra.uncertainTrackerIds ? [TRACKER_ID, SIBLING_ID] : [TRACKER_ID]], `${label}: 카드 다시 읽기`);
  }
});

test("U15 저장 거절 뒤 다시 읽기(F2): 넣으려던 번호를 보관하고 '넣으려던 번호 다시 넣기'로 입력칸에 돌린다 — 일반 저장·후보 넣기(확인만 기록은 보관할 글 없음)", async () => {
  const typed = `${PRIMARY}\n${OPTION_A}\n${OPTION_B}`;
  const changed = { ok: false, code: "RANK_OPTION_CHANGED", message: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요." };
  const kept = (env) => env.q("[data-rank-option-kept]");
  const restore = (env) => env.q("[data-rank-option-kept-restore]");
  const previewPayload = (saved = [OPTION_A], extra = {}) => optionsPayload({
    mode: "preview", saved, parsed: parsedOf([OPTION_A, OPTION_B], { primaryRemoved: true }), ...extra,
  });

  // 일반 저장: 동시 변경 거절 → 다시 읽기가 입력칸을 DB 의 지금 번호로 바꾼다 → 붙여 넣었던 글을 보관한다.
  const env = editorEnv();
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A] }));
  assert.equal(kept(env).hidden, true, "처음에는 보관한 번호가 없다");
  await previewWith(env, typed, previewPayload());
  env.respond(changed, 409);
  env.respond(optionsPayload({ saved: [OPTION_A, OPTION_C] }));
  click(env.saveButton());
  await flush();
  assert.equal(env.input().value, `${OPTION_A}\n${OPTION_C}`, "입력칸 = DB 의 지금 번호");
  assert.equal(env.status(), `${changed.message} 최신 번호로 다시 불러왔습니다.`, "저장 결과 문장은 그대로");
  assert.equal(kept(env).hidden, false, "넣으려던 번호를 보관했다고 알린다");
  assert.equal(kept(env).querySelector("span").textContent, "넣으려던 번호를 보관했습니다.");
  assert.equal(restore(env).textContent, "넣으려던 번호 다시 넣기");
  assert.equal(restore(env).disabled, false);
  // 다시 넣으면 붙여 넣었던 글 그대로 돌아오고 줄은 사라진다. 요청은 없고, 저장은 미리 보기부터 다시.
  const before = env.requests.length;
  click(restore(env));
  assert.equal(env.requests.length, before, "다시 넣기는 요청을 보내지 않는다");
  assert.equal(env.input().value, typed);
  assert.equal(kept(env).hidden, true);
  assert.equal(env.saveButton().disabled, true, "미리 보기 전에는 저장할 수 없다");
  assert.equal(env.previewButton().disabled, false);
  assert.equal(env.status(), "넣으려던 번호를 다시 넣었습니다. 아직 저장 전입니다. 미리 보기로 지금 저장된 번호와 비교한 뒤 저장해주세요.");
  // 다시 미리 보기(지금 저장값 기준 비교) → 저장하면 붙여 넣었던 글 그대로 보낸다.
  env.respond(previewPayload([OPTION_A, OPTION_C], { removed: [OPTION_C], expected: { [TRACKER_ID]: [OPTION_A, OPTION_C], [SIBLING_ID]: [] } }));
  click(env.previewButton());
  await flush();
  assert.deepEqual(env.diffRow("removed"), [OPTION_C], "다시 읽은 번호와 비교한다");
  env.respond({ ok: true, mode: "save", updatedCount: 1, updatedTrackerIds: [TRACKER_ID], optionProductIds: [OPTION_A, OPTION_B], checkedAtRecorded: true, message: "저장" });
  click(env.saveButton());
  await flush();
  const saveBody = plain(env.requests.at(-1).body);
  assert.equal(saveBody.mode, "save");
  assert.equal(saveBody.optionInput, typed);
  assert.deepEqual(saveBody.expectedOptionProductIds, { [TRACKER_ID]: [OPTION_A, OPTION_C], [SIBLING_ID]: [] }, "다시 미리 본 저장값 조건");

  // 다시 읽은 번호가 붙여 넣은 번호와 같으면(이 추적은 저장됨) 잃을 것이 없어 보관하지 않는다.
  const same = editorEnv();
  await openEditorWith(same, optionsPayload({ saved: [OPTION_A] }));
  await previewWith(same, typed, previewPayload());
  same.respond({ ok: false, code: "RANK_OPTION_PARTIAL", message: "추적 2개 중 1개만 저장했습니다. 다시 미리 보기 한 뒤 저장해주세요.", updatedTrackerIds: [TRACKER_ID] }, 409);
  same.respond(optionsPayload({ saved: [OPTION_B, OPTION_A] }));
  click(same.saveButton());
  await flush();
  assert.equal(same.input().value, `${OPTION_B}\n${OPTION_A}`);
  assert.equal(kept(same).hidden, true, "같은 번호면 보관 줄 없음");

  // 다시 읽기가 끊기면 입력칸이 붙여 넣었던 글 그대로라 보관 줄이 필요 없다.
  const offline = editorEnv();
  await openEditorWith(offline, optionsPayload({ saved: [OPTION_A] }));
  await previewWith(offline, typed, previewPayload());
  offline.respond(changed, 409);
  offline.fail("Failed to fetch");
  click(offline.saveButton());
  await flush();
  assert.equal(offline.input().value, typed);
  assert.equal(kept(offline).hidden, true);

  // 후보 넣기: 넣으려던 목록을 **다시 읽은 최신 번호 + 고른 후보**로 보관한다(예전 저장 번호 기준이면 그 사이 다른 사람이
  // 더한 CAND_B 가 빠지거나 지운 번호가 되살아난다 — 반박 검토 2026-11-01). 다시 넣으면 아래 입력칸에 그 목록이 들어간다.
  const cand = candidateEnv(candidateTracker());
  cand.respond(optionsPayload({ saved: [OPTION_A] }));
  click(cand.candButton);
  await flush();
  cand.pick(0);
  click(cand.add());
  cand.respond({ ...optionsPayload({ mode: "preview", saved: [OPTION_A], parsed: parsedOf([OPTION_A, CAND_A]), willUpdateCount: 2 }), targetTrackerIds: [TRACKER_ID, SIBLING_ID] });
  cand.respond(changed, 409);
  cand.respond(optionsPayload({ saved: [OPTION_A, CAND_B] }));
  click(cand.confirmRun());
  await flush();
  assert.equal(cand.input().value, `${OPTION_A}\n${CAND_B}`, "입력칸 = DB 의 지금 번호");
  assert.equal(kept(cand).hidden, false, "후보 넣기도 넣으려던 목록을 보관한다");
  assert.equal(restore(cand).disabled, false);
  click(restore(cand));
  assert.equal(cand.input().value, `${OPTION_A}\n${CAND_B}\n${CAND_A}`, "최신 번호(다른 사람이 더한 CAND_B 포함) + 고른 후보");
  assert.equal(kept(cand).hidden, true);
  assert.equal(cand.saveButton().disabled, true, "미리 보기부터 다시");

  // 확인만 기록: 입력칸이 저장값 그대로일 때만 눌리므로 거절 뒤 다시 읽어도 보관할 글이 없다.
  const check = editorEnv({ now: NOW });
  await openEditorWith(check, optionsPayload({ saved: [OPTION_A], siblings: [] }));
  check.respond({ ok: false, code: "RANK_OPTION_CHECK_ONLY_MISMATCH", message: "번호가 바뀌었습니다. 다시 확인해주세요." }, 409);
  check.respond(optionsPayload({ saved: [OPTION_A, OPTION_C], siblings: [] }));
  click(check.checkOnly());
  await flush();
  assert.deepEqual(plain(check.requests.at(-1).body), READ_BODY);
  assert.equal(check.input().value, `${OPTION_A}\n${OPTION_C}`);
  assert.equal(kept(check).hidden, true, "확인만 기록은 보관 줄 없음");

  // 창을 닫았다 다시 열면 보관한 번호는 없다(보관은 그 창 안에서만).
  const reopen = editorEnv();
  await openEditorWith(reopen, optionsPayload({ saved: [OPTION_A] }));
  await previewWith(reopen, typed, previewPayload());
  reopen.respond(changed, 409);
  reopen.respond(optionsPayload({ saved: [OPTION_A, OPTION_C] }));
  click(reopen.saveButton());
  await flush();
  assert.equal(kept(reopen).hidden, false);
  click(reopen.q("[data-rank-option-close]"));
  assert.equal(reopen.modal().hidden, true, "입력칸 = 저장값이라 묻지 않고 닫힌다");
  await openEditorWith(reopen, optionsPayload({ saved: [OPTION_A, OPTION_C] }));
  assert.equal(kept(reopen).hidden, true, "다시 연 창에는 보관 줄 없음");
});

test("V1·V2 좁은 화면: 편집창 버튼은 낱말 중간에서 끊지 않고, 머리 확인일은 짧은 글 한 줄 + '상품 페이지 열기'·'확인만 기록' 한 줄(넓은 화면 그대로)", () => {
  const css = adminSource.slice(adminSource.indexOf("/* N 30일 그룹상품 시작"), adminSource.indexOf("/* N 30일 그룹상품 끝 */"));
  const rule = (selector, from = 0) => {
    const at = css.indexOf(`${selector} {`, from);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf("}", at));
  };
  // V1: 창 안 모든 .mi-button(저장·미리 보기·확인만 기록·후보 넣기 등). 긴 낱말만 아무 데서나 끊는다.
  const buttons = rule("#mi-admin .mi-rank-option-card .mi-button");
  assert.match(buttons, /word-break: keep-all;/u);
  assert.match(buttons, /overflow-wrap: anywhere;/u);
  // V2: 넓은 화면은 긴 글만(짧은 글 숨김). 좁은 화면 묶음에서만 짧은 글로 바꾸고 확인일 줄을 맨 위 한 줄로 둔다.
  const shortAt = css.indexOf("#mi-admin .mi-rank-option-checkline-short {");
  assert.match(rule("#mi-admin .mi-rank-option-checkline-short"), /display: none;/u);
  const mediaAt = css.indexOf("@media (max-width: 520px) {", shortAt);
  assert.ok(mediaAt > shortAt, "짧은 글 기본 규칙 뒤의 좁은 화면 묶음");
  const media = blockFrom(css, mediaAt);
  assert.match(media, /\.mi-rank-option-checkline \{\s*flex: 1 1 100%;\s*order: -1;\s*\}/u, "확인일 줄은 한 줄 전체 → 아래 줄에 링크·버튼");
  assert.match(media, /\.mi-rank-option-checkline-full \{\s*display: none;\s*\}/u);
  assert.match(media, /\.mi-rank-option-checkline-short \{\s*display: inline;\s*\}/u);
  assert.doesNotMatch(media, /mi-rank-option-open|mi-rank-option-check-only|\border: [1-9]/u, "링크·버튼 순서는 그대로(초점 순서와 같음)");
  assert.doesNotMatch(css, HEX);
});

test("U16 편집창 머리: 상품 페이지 열기(B5)·마지막 옵션 확인일(B6) 줄, 칸이 없으면 줄·버튼을 숨긴다", async () => {
  const env = editorEnv({ now: NOW });
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A, OPTION_B], checkedAt: kst("2026-10-01", 15) }));
  const open = env.q("[data-rank-option-open]");
  assert.equal(open.hidden, false);
  assert.equal(open.getAttribute("href"), `https://smartstore.naver.com/ishell/products/${PRIMARY}`, "카드 제목 링크와 같은 주소");
  assert.equal(open.getAttribute("target"), "_blank");
  assert.match(open.getAttribute("rel"), /\bnoopener\b/u);
  assert.equal(env.checkText(), "마지막 옵션 확인: 2026-10-01(22일 전)");
  assert.equal(env.checkShort(), "마지막 옵션 확인 10/1 (22일 전)", "좁은 화면용 짧은 글(V2)");
  assert.equal(env.checkLine().classList.contains("is-due"), false);
  assert.equal(env.checkOnly().hidden, false);
  assert.equal(env.checkOnly().textContent, "확인만 기록");

  const old = editorEnv({ now: NOW });
  await openEditorWith(old, optionsPayload({ saved: [OPTION_A], checkedAt: kst("2026-09-20", 9) }));
  assert.equal(old.checkText(), "마지막 옵션 확인: 2026-09-20(33일 전) · 다시 확인할 때입니다");
  assert.equal(old.checkShort(), "마지막 옵션 확인 9/20 (33일 전)", "짧은 글은 다시 확인 안내 없이 색(is-due)으로만");
  assert.ok(old.checkLine().classList.contains("is-due"));

  const none = editorEnv({ now: NOW });
  await openEditorWith(none, optionsPayload({ saved: [OPTION_A], checkedAt: null }));
  assert.equal(none.checkText(), "옵션 확인 기록 없음");
  assert.equal(none.checkShort(), "옵션 확인 기록 없음");
  assert.ok(none.checkLine().classList.contains("is-due"));

  // 확인일 칸이 없으면(대표 SQL 전) 줄과 '확인만 기록'을 숨긴다. 번호가 없으면 '확인만 기록'이 없다.
  const notReady = editorEnv({ now: NOW });
  await openEditorWith(notReady, optionsPayload({ saved: [OPTION_A], checkedAtReady: false }));
  assert.equal(notReady.checkLine().hidden, true);
  assert.equal(notReady.checkOnly().hidden, true);
  const empty = editorEnv({ now: NOW });
  await openEditorWith(empty, optionsPayload({ saved: [] }));
  assert.equal(empty.checkOnly().hidden, true);
  assert.equal(empty.checkLine().hidden, true, "번호도 기록도 없으면 줄도 없다");

  // 주소가 없거나 http(s) 가 아니면 링크를 숨긴다.
  const noUrl = editorEnv({ now: NOW });
  const payload = optionsPayload({ saved: [OPTION_A] });
  payload.tracker.productUrl = "";
  await openEditorWith(noUrl, payload);
  assert.equal(noUrl.q("[data-rank-option-open]").hidden, true);
  assert.equal(noUrl.q("[data-rank-option-open]").getAttribute("href"), null);
});

const READ_BODY = { action: "options", trackerId: TRACKER_ID, mode: "read" };

test("U16 '확인만 기록'(B6): checkOnly 로 지금 목록 그대로·읽은 저장값 조건·fullReview, 기록 뒤 다시 읽기, 다른 추적 번호가 다르면 함께 기록하지 않는다", async () => {
  const sameSibling = sibling({ optionProductCount: 2, beforeOptionProductIds: [OPTION_B, OPTION_A], afterOptionProductIds: [OPTION_A, OPTION_B], addedCount: 0 });
  const env = editorEnv({ now: NOW });
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A, OPTION_B], siblings: [sameSibling], checkedAt: null }));
  env.respond({
    ok: true, mode: "save", updatedCount: 2, updatedTrackerIds: [TRACKER_ID, SIBLING_ID], optionProductIds: [OPTION_A, OPTION_B],
    checkedAtRecorded: true, optionCheckedAt: "2026-10-23T03:00:00.000Z", message: "저장",
  });
  env.respond(optionsPayload({ saved: [OPTION_A, OPTION_B], siblings: [sameSibling], checkedAt: "2026-10-23T03:00:00.000Z" }));
  click(env.checkOnly());
  assert.equal(env.checkOnly().disabled, true, "기록·다시 읽기 중에는 다시 못 누른다");
  await flush();
  assert.deepEqual(plain(env.requests[1].body), {
    action: "options", trackerId: TRACKER_ID, mode: "save", checkOnly: true, optionInput: `${OPTION_A}\n${OPTION_B}`, applyToSameProduct: true,
    expectedTrackerIds: [TRACKER_ID, SIBLING_ID],
    expectedOptionProductIds: { [TRACKER_ID]: [OPTION_A, OPTION_B], [SIBLING_ID]: [OPTION_B, OPTION_A] },
    fullReview: true,
  }, "서버가 확인일만 쓰게 checkOnly 를 보낸다(U2)");
  assert.deepEqual(plain(env.requests[2].body), READ_BODY, "기록 뒤 읽기로 최신 저장값을 받는다(U3)");
  assert.equal(env.requests.length, 3);
  assert.equal(env.status(), "옵션 확인일을 기록했습니다(추적 2개 · 번호 2개 그대로).");
  assert.equal(env.checkText(), "마지막 옵션 확인: 2026-10-23(오늘)");
  assert.equal(env.checkShort(), "마지막 옵션 확인 10/23 (오늘)");
  assert.deepEqual(env.events.map((event) => plain(event.detail.trackerIds)), [[TRACKER_ID, SIBLING_ID]], "카드 배지를 바꾸게 목록 다시 읽기");
  assert.equal(env.modal().hidden, false, "창은 열어 둔다");
  assert.equal(env.checkOnly().disabled, false);

  // 다른 키워드 추적의 번호가 다르면 읽은 값으로 먼저 알리고(요청 없음), 체크를 끄면 이 추적만.
  const differ = editorEnv({ now: NOW });
  await openEditorWith(differ, optionsPayload({ saved: [OPTION_A, OPTION_B], siblings: [sibling({ optionProductCount: 1, beforeOptionProductIds: [OPTION_A] })] }));
  click(differ.checkOnly());
  await flush();
  assert.equal(differ.requests.length, 1, "읽기만");
  assert.match(differ.status(), /다른 키워드 추적 1개\(아이폰17 케이스\)의 번호가 이 추적과 달라.*기록하지 않았습니다/u);
  assert.doesNotMatch(differ.status(), /번호가 바뀝니다/u, "확인만 기록은 번호를 바꾸지 않는다");
  differ.apply().checked = false;
  dispatch(differ.apply(), "change");
  differ.respond({ ok: true, mode: "save", updatedCount: 1, updatedTrackerIds: [TRACKER_ID], optionProductIds: [OPTION_A, OPTION_B], checkedAtRecorded: false, message: "저장" });
  differ.respond(optionsPayload({ saved: [OPTION_A, OPTION_B], siblings: [sibling({ optionProductCount: 1, beforeOptionProductIds: [OPTION_A] })] }));
  click(differ.checkOnly());
  await flush();
  const differBody = plain(differ.requests.at(-2).body);
  assert.equal(differBody.checkOnly, true);
  assert.equal(differBody.applyToSameProduct, false);
  assert.deepEqual(differBody.expectedTrackerIds, [TRACKER_ID]);
  assert.deepEqual(plain(differ.requests.at(-1).body), READ_BODY);
  assert.equal(differ.status(), "번호는 그대로입니다. 확인일은 기록되지 않았습니다(DB 준비 전).");
  assert.equal(differ.checkText(), "옵션 확인 기록 없음", "기록되지 않았으면 줄은 그대로");
  assert.equal(differ.apply().checked, false, "다시 읽어도 체크는 사용자가 둔 그대로");

  // 저장하지 않은 입력이 있으면 막는다. 서버가 동시 변경으로 거절하면 서버 문장 + 지금 번호를 다시 읽어 입력칸을 맞춘다(U4).
  const dirty = editorEnv({ now: NOW });
  await openEditorWith(dirty, optionsPayload({ saved: [OPTION_A], siblings: [] }));
  dirty.input().value = `${OPTION_A}\n${OPTION_B}`;
  dispatch(dirty.input(), "input");
  click(dirty.checkOnly());
  await flush();
  assert.equal(dirty.requests.length, 1);
  assert.match(dirty.status(), /저장하지 않은 번호가 있습니다/u);
  dirty.input().value = OPTION_A;
  dispatch(dirty.input(), "input");
  dirty.respond({ ok: false, code: "RANK_OPTION_CHANGED", message: "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요." }, 409);
  dirty.respond(optionsPayload({ saved: [OPTION_A, OPTION_C], siblings: [] }));
  click(dirty.checkOnly());
  await flush();
  assert.deepEqual(plain(dirty.requests.at(-1).body), READ_BODY);
  assert.equal(dirty.status(), "다른 사람이 먼저 바꿨습니다. 다시 미리 보기 해주세요. 최신 번호로 다시 불러왔습니다.");
  assert.equal(dirty.input().value, `${OPTION_A}\n${OPTION_C}`, "입력칸을 최신 번호로");
  assert.equal(dirty.events.length, 0);
});

test("U16 '확인만 기록' 두 번: 기록 뒤 다시 읽은 저장값을 다음 기록에 보낸다(U3)", async () => {
  const env = editorEnv({ now: NOW });
  await openEditorWith(env, optionsPayload({
    saved: [OPTION_B, OPTION_A], siblings: [], checkedAt: kst("2026-09-01"), expected: { [TRACKER_ID]: [OPTION_B, OPTION_A] },
  }));
  const saved = (checkedAt) => ({
    ok: true, mode: "save", updatedCount: 1, updatedTrackerIds: [TRACKER_ID], optionProductIds: [OPTION_A, OPTION_B], checkedAtRecorded: true, optionCheckedAt: checkedAt, message: "저장",
  });
  // 그 사이 다른 창에서 같은 번호를 순서만 바꿔 저장했다(DB 저장값 그대로 비교라 이 값이 조건이 된다).
  env.respond(saved("2026-10-23T02:00:00.000Z"));
  env.respond(optionsPayload({ saved: [OPTION_A, OPTION_B], siblings: [], checkedAt: "2026-10-23T02:00:00.000Z", expected: { [TRACKER_ID]: [OPTION_A, OPTION_B] } }));
  click(env.checkOnly());
  await flush();
  env.respond(saved("2026-10-23T03:00:00.000Z"));
  env.respond(optionsPayload({ saved: [OPTION_A, OPTION_B], siblings: [], checkedAt: "2026-10-23T03:00:00.000Z", expected: { [TRACKER_ID]: [OPTION_A, OPTION_B] } }));
  click(env.checkOnly());
  await flush();
  const bodies = env.requests.map((request) => plain(request.body));
  assert.deepEqual(bodies.map((body) => [body.mode, body.checkOnly === true]), [["read", false], ["save", true], ["read", false], ["save", true], ["read", false]]);
  assert.deepEqual(bodies[1].expectedOptionProductIds, { [TRACKER_ID]: [OPTION_B, OPTION_A] }, "첫 기록은 창을 열 때 읽은 값");
  assert.deepEqual(bodies[3].expectedOptionProductIds, { [TRACKER_ID]: [OPTION_A, OPTION_B] }, "두 번째 기록은 다시 읽은 값");
  assert.equal(bodies[3].optionInput, `${OPTION_A}\n${OPTION_B}`, "지금 목록도 다시 읽은 목록");
  assert.equal(env.status(), "옵션 확인일을 기록했습니다(추적 1개 · 번호 2개 그대로).");
  assert.equal(env.checkText(), "마지막 옵션 확인: 2026-10-23(오늘)");
});

test("U16 '확인만 기록': 읽은 값으로는 같아 보여도 서버가 번호가 다르다고 거절하면(RANK_OPTION_CHECK_ONLY_MISMATCH) 서버 문장 + 다시 읽기", async () => {
  const sameSibling = sibling({ optionProductCount: 1, beforeOptionProductIds: [OPTION_A], afterOptionProductIds: [OPTION_A], addedCount: 0 });
  const env = editorEnv({ now: NOW });
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A], siblings: [sameSibling] }));
  // 같은 목록을 미리 본 뒤 '확인만 기록'을 눌렀다(입력은 저장값 그대로).
  await previewWith(env, OPTION_A, optionsPayload({ mode: "preview", saved: [OPTION_A], siblings: [sameSibling], parsed: parsedOf([OPTION_A]) }));
  assert.notEqual(env.preview().textContent, "");
  const mismatch = "함께 기록할 추적의 번호가 이 추적과 달라 확인일을 기록하지 않았습니다.";
  env.respond({ ok: false, code: "RANK_OPTION_CHECK_ONLY_MISMATCH", message: mismatch }, 409);
  // 그 사이 다른 키워드 추적에 번호가 하나 더 들어갔다.
  const changedSibling = sibling({ optionProductCount: 2, beforeOptionProductIds: [OPTION_A, OPTION_C], afterOptionProductIds: [OPTION_A], addedCount: 0, removedCount: 1 });
  env.respond(optionsPayload({ saved: [OPTION_A], siblings: [changedSibling] }));
  click(env.checkOnly());
  await flush();
  assert.equal(env.requests.length, 4);
  assert.equal(plain(env.requests[2].body).checkOnly, true);
  assert.deepEqual(plain(env.requests[3].body), READ_BODY);
  assert.equal(env.status(), `${mismatch} 최신 번호로 다시 불러왔습니다.`, "서버 문장 그대로 + 다시 읽음");
  assert.ok(env.q("[data-rank-option-status]").classList.contains("is-warn"));
  assert.equal(env.preview().textContent, "", "다시 읽으면 지난 미리 보기는 지운다");
  assert.equal(env.saveButton().disabled, true);
  assert.equal(env.events.length, 0);
  // 다시 읽은 값으로는 이제 화면이 먼저 알린다(요청 없음).
  click(env.checkOnly());
  await flush();
  assert.equal(env.requests.length, 4);
  assert.match(env.status(), /다른 키워드 추적 1개\(아이폰17 케이스\)의 번호가 이 추적과 달라/u);
});

test("U16 일반 저장: 확인일 칸이 없어 번호만 저장되면(checkedAtRecorded:false) 창과 카드 상태 줄에 알린다", async () => {
  const env = editorEnv();
  const cardStatus = env.documentRef.createElement("p");
  cardStatus.setAttribute("data-rank-status", "");
  env.rankCard.appendChild(cardStatus);
  await openEditorWith(env, optionsPayload({ saved: [], siblings: [] }));
  await previewWith(env, `${PRIMARY}\n${OPTION_A}`, optionsPayload({ mode: "preview", saved: [], siblings: [], parsed: parsedOf([OPTION_A], { primaryRemoved: true }) }));
  env.respond({ ok: true, mode: "save", updatedCount: 1, updatedTrackerIds: [TRACKER_ID], optionProductIds: [OPTION_A], checkedAtRecorded: false, message: "그룹상품 번호 1개를 추적 1개에 저장했습니다. 다음 순위 확인부터 적용됩니다." });
  click(env.saveButton());
  await flush();
  assert.match(env.status(), /저장했습니다\. 다음 순위 확인부터 적용됩니다\. 확인일은 기록되지 않았습니다\(DB 준비 전\)\.$/u);
  assert.equal(cardStatus.textContent, env.status());
  assert.ok(cardStatus.classList.contains("is-warn"));
});

test("U17 버튼 설치 안내(A7): 정적 HTML 표식 사이 링크, 편집창 안으로 옮겨지고 눌러도 아무 일 없음", async () => {
  // 원본: 표식은 관리자 화면 N 30일 카드 안에 한 번씩, 그 사이에는 끌어 놓기 링크 하나(빌드가 href 를 바꿔 끼운다).
  const start = "<!-- mi-option-check-bookmarklet:start -->";
  const end = "<!-- mi-option-check-bookmarklet:end -->";
  assert.equal(adminSource.split(start).length, 2);
  assert.equal(adminSource.split(end).length, 2);
  assert.ok(!clientSource.includes("mi-option-check-bookmarklet") && !clientSource.includes("data-rank-option-install"), "광고주 화면에는 없다");
  const between = adminSource.slice(adminSource.indexOf(start) + start.length, adminSource.indexOf(end));
  assert.match(between, /^<a class="mi-rank-option-bookmarklet" data-rank-option-bookmarklet href="javascript:[^"]*" title="즐겨찾기 줄로 끌어다 놓으세요">모먼트 옵션 확인<\/a>$/u);
  const cardFrom = adminSource.indexOf('<article class="mi-card mi-card-pad mi-rank-card" data-rank-card>');
  const cardTo = adminSource.indexOf("</article>", cardFrom);
  const installFrom = adminSource.indexOf('<details class="mi-rank-option-install" data-rank-option-install hidden>');
  assert.ok(cardFrom > 0 && installFrom > cardFrom && adminSource.indexOf(start) > installFrom && adminSource.indexOf(end) < cardTo, "N 30일 카드 안의 접힌 안내");
  const installHtml = adminSource.slice(installFrom, adminSource.indexOf("</details>", installFrom));
  assert.doesNotMatch(installHtml, /\son[a-z]+\s*=/iu, "인라인 핸들러 없음(CSP)");
  assert.equal((installHtml.match(/<li>/gu) || []).length, 3, "짧은 3단계 안내");

  const env = editorEnv({ install: true });
  assert.equal(env.installBlock.parentNode, null, "편집창을 열기 전에는 카드에서 떼어 둔다");
  await openEditorWith(env, optionsPayload({ saved: [OPTION_A] }));
  const install = env.q("[data-rank-option-install]");
  assert.equal(install, env.installBlock);
  assert.equal(install.hidden, false);
  assert.equal(env.rankCard.querySelector("[data-rank-option-install]"), null);
  const event = dispatch(install.querySelector("[data-rank-option-bookmarklet]"), "click");
  assert.equal(event.defaultPrevented, true, "관리자 화면에서 눌러도 실행하지 않는다");
  assert.match(install.querySelector(".mi-rank-option-install-note").textContent, /즐겨찾기 줄로 끌어 놓은 뒤/u);
  assert.equal(env.requests.length, 1, "요청 없음");
  assert.equal(env.modal().hidden, false);
});

test("U7 정식판 새 CSS 도 그룹상품 묶음 안에서 var(--mi-*) 토큰만 쓴다", () => {
  const css = adminSource.slice(adminSource.indexOf("/* N 30일 그룹상품 시작"), adminSource.indexOf("/* N 30일 그룹상품 끝 */"));
  for (const selector of [
    ".mi-rank-ops-row .mi-rank-option-check.is-due", ".mi-rank-option-diff-row.is-added li", ".mi-rank-option-diff-row.is-removed li",
    ".mi-rank-option-alert.is-danger", ".mi-rank-option-bookmarklet", ".mi-rank-option-checkline.is-due",
  ]) assert.ok(css.includes(selector), selector);
});
