// N 30일 카드 대표 결정(2026-10-17) 회귀 테스트 — 관리자(admin.html)·광고주(client.html) 양쪽.
//
//   1) 날짜 줄: 오늘(KST)부터 거꾸로 최대 30칸, 등록일(createdAt 의 KST 날짜) 이전 칸 없음, 측정이 빠진 날도
//      순위 없는 날과 같은 '-' 칸, 오늘 측정 전이면 오늘도 '-', '오늘' 꼬리표 없음, 오전·오후 칸 규칙 그대로.
//   2) '7일 평균': 오늘 포함 최근 7일(KST 날짜) 안에서 순위가 있는 측정의 반올림 평균, 없으면 '-'.
//   3) '선택 이미지 저장' 복제본: 운영줄 내부 알약(상태·판정·원부 확인 필요·그룹·최근·다음·권고·메시지)이 빠지고
//      현재·최고·전회 대비·7일 평균·날짜 줄은 남는다. 화면 카드는 그대로.
//   4) 그룹 필터: 카드 안 입력칸의 change 가 카드 자신의 data-rank-filter-group 상태 속성에 걸려 필터가 풀리지 않는다.
//   N 플레이스 30일: 같은 이름의 공용 함수(rankTrackerAverageRank·rankDateKey·플레이스 기록판·cloneRankCardForExport)
//   결과가 바뀌지 않는다.
//
// 규약은 scripts/rank-catalog-hint-ui.test.mjs 와 같다: 화면 원본에서 함수 블록을 그대로 떼어 vm 에서 실행한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readRepoFile = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");

const adminSource = readRepoFile("src/pages/admin.html");
const clientSource = readRepoFile("src/pages/client.html");
const PAGES = [["admin.html", adminSource], ["client.html", clientSource]];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 2026-10-17(토) 12:00 KST
const NOW = Date.parse("2026-10-17T03:00:00.000Z");
// KST 시각 → ISO
const kst = (day, hour = 9, minute = 0) => new Date(Date.parse(`${day}T00:00:00Z`) - 9 * HOUR + (hour * 60 + minute) * 60 * 1000).toISOString();

// ─────────────────────────────────────────────────────────────
// 추출기
// ─────────────────────────────────────────────────────────────
const PAGE_FUNCTION_CLOSE = "\n      }";

function htmlFunction(source, name, label) {
  let from = source.indexOf(`\n      function ${name}(`);
  if (from < 0) from = source.indexOf(`\n      async function ${name}(`);
  assert.ok(from >= 0, `page function not found: ${name} (${label || ""})`);
  const to = source.indexOf(PAGE_FUNCTION_CLOSE + "\n", from);
  assert.ok(to > from, `page function end not found: ${name} (${label || ""})`);
  return source.slice(from + 1, to + PAGE_FUNCTION_CLOSE.length);
}

// 중괄호 짝으로 블록 끝을 찾는다(문자열·주석 안 중괄호는 건너뛴다).
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
  assert.ok(match, `locked function not found: ${name}`);
  return blockFrom(source, match.index);
}

// ─────────────────────────────────────────────────────────────
// 아주 작은 DOM(이 테스트가 쓰는 만큼만): 카드 HTML 을 나무로 풀고 cloneNode·querySelectorAll·closest·remove 를 낸다.
// ─────────────────────────────────────────────────────────────
const VOID_TAGS = new Set(["input", "br", "img", "meta", "link"]);

function decodeEntities(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

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
    this.value = attrs.get("value") || "";
  }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  get classList() { return String(this.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  cloneNode(deep) {
    const copy = new MiniElement(this.tagName, new Map(this.attrs));
    copy.value = this.value;
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
    const walk = (node) => {
      node.children.forEach((child) => {
        if (!(child instanceof MiniElement)) return;
        if (child.matches(selectorList)) found.push(child);
        walk(child);
      });
    };
    walk(this);
    return found;
  }
  querySelector(selectorList) { return this.querySelectorAll(selectorList)[0] || null; }
  closest(selectorList) {
    for (let node = this; node instanceof MiniElement; node = node.parent) {
      if (node.tagName !== "#root" && node.matches(selectorList)) return node;
    }
    return null;
  }
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
// 샌드박스
// ─────────────────────────────────────────────────────────────
const BOARD_FUNCTIONS = [
  "escapeHtml",
  "rankText",
  "rankSnapshotSourceLabel",
  "rankDayLabel",
  "rankDayClass",
  "rankKstParts",
  "rankKstDayKey",
  "rankKstDayShift",
  "rankKstDayDate",
  "groupRankSnapshotsByDay",
  "latestRankSnapshotForDay",
  "renderRankSlot",
  "rankTrackerSnapshotsMaybeTruncated",
  "rankTrackerBoardDayKeys",
  "renderTrackerDailyBoard",
  "rankTrackerRankValue",
  "rankTrackerRecentRanks",
  "rankTrackerAverageRank",
  "rankTrackerSevenDayAverageRank",
];

const CARD_FUNCTIONS = [
  "rankTrackerLatestRank",
  "rankTrackerPreviousRank",
  "rankTrackerTrend",
  "rankTrackerNeedsAttention",
  "rankTrackerInsight",
  "rankTrackerCatalogHint",
  "rankTrackerActionNote",
  "rankTrackerChangeLabel",
  "renderRankTrackerCard",
  "cloneRankCardForExport",
  "cloneRankTrackerCardForShare",
];

const CARD_STUBS = `
  var RANK_CHRONIC_ISOLATION_LABEL = "수집 방식 점검 중";
  function rankTrackerChronicIsolated() { return false; }
  function rankTrackerTitle(tracker) { return tracker.productTitle || "상품"; }
  function rankTrackerMallName() { return ""; }
  function rankTrackerCurrentSourceLabel() { return "상품"; }
  function renderRankKeywordName(keyword) { return '<span class="mi-rank-keyword-name">' + escapeHtml(keyword) + "</span>"; }
  function renderRankKeywordVolume() { return '<span class="mi-rank-keyword-volume">키워드검색량 1,000</span>'; }
  function rankTrackerProductId(tracker) { return tracker.productId || "-"; }
  function renderRankProductTitle(tracker, titleText) { return '<span class="mi-rank-product-title">' + escapeHtml(titleText) + "</span>"; }
  function rankTrackerStatusClass() { return ""; }
  function rankTrackerStatus() { return "운영중"; }
  function rankGroupDisplayName(group) { return group || "미분류"; }
  function rankTrackerGroupName(tracker) { return tracker.groupName || ""; }
  function formatRankShortAt() { return "10. 17. 오전 09:12"; }
  function formatRankRemain() { return "3시간"; }
`;

function sandbox(source, label, { card = false, now = NOW } = {}) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`Date.now = function () { return ${now}; };`, context);
  const names = card ? BOARD_FUNCTIONS.concat(CARD_FUNCTIONS) : BOARD_FUNCTIONS;
  vm.runInContext(names.map((name) => htmlFunction(source, name, label)).join("\n\n") + (card ? CARD_STUBS : ""), context);
  return context;
}

function run(context, expression, values = {}) {
  Object.entries(values).forEach(([key, value]) => { context[key] = value; });
  return vm.runInContext(expression, context);
}

function snapshot(checkedAt, rank, extra = {}) {
  return { checkedAt, rank, item: { trackingRankSource: "exact_product" }, ...extra };
}

// 날짜 줄 HTML → [{ label, value, empty, weekend }]
function boardCells(html) {
  const root = parseHtml(html);
  return root.querySelectorAll(".mi-rank-day-card").map((cell) => {
    const slot = cell.querySelector("span");
    return {
      label: cell.querySelector("strong").textContent,
      value: slot.querySelector("b").textContent,
      small: slot.querySelector("small").textContent,
      empty: slot.getAttribute("class") === "is-empty",
      weekend: cell.classList.find((name) => name === "is-sat" || name === "is-sun") || "",
    };
  });
}

function withTimeZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

// ─────────────────────────────────────────────────────────────
// 1) 날짜 줄
// ─────────────────────────────────────────────────────────────
for (const [label, source] of PAGES) {
  test(`${label}: 빠진 날도 '-' 칸, 등록일 이전 칸 없음, 오늘 측정 전이면 오늘도 '-', '오늘' 꼬리표 없음`, () => {
    const context = sandbox(source, label);
    const tracker = {
      createdAt: kst("2026-10-12", 8, 40),
      snapshots: [
        snapshot(kst("2026-10-16", 15, 27), 12),
        snapshot(kst("2026-10-14", 9, 12), 20),
        snapshot(kst("2026-10-13", 15, 27), null),
        snapshot(kst("2026-10-12", 9, 12), 31),
      ],
    };
    const html = run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: tracker });
    const cells = boardCells(html);
    assert.deepEqual(cells.map((cell) => cell.label), ["10-17(토)", "10-16(금)", "10-15(목)", "10-14(수)", "10-13(화)", "10-12(월)"]);
    assert.deepEqual(cells.map((cell) => cell.value), ["-", "12위", "-", "20위", "-", "31위"]);
    assert.deepEqual(cells.map((cell) => cell.empty), [true, false, true, false, true, false]);
    assert.equal(cells[0].weekend, "is-sat", "오늘(토) 칸도 주말 색 규칙을 따른다");
    assert.ok(!html.includes("오늘"), "'오늘' 꼬리표를 넣지 않는다");
    assert.ok(!html.includes("측정 없음"), "새 문구를 쓰지 않는다");
    // 빠진 날 칸(10-15)과 측정했지만 순위 없는 날 칸(10-13)은 같은 모양이다.
    const slotMarkup = (day) => {
      const part = html.split('<div class="mi-rank-day-card').find((piece) => piece.includes(day));
      return part.slice(part.indexOf('<div class="mi-rank-day-slots">'));
    };
    assert.equal(slotMarkup("10-15(목)"), slotMarkup("10-13(화)"));
    assert.ok(html.includes('<span class="is-empty"><small>순위</small><b>-</b></span>'));
  });

  test(`${label}: 30칸 상한(오늘부터 거꾸로 30일)과 등록일 하한`, () => {
    const context = sandbox(source, label);
    const snapshots = [];
    for (let back = 0; back < 45; back += 3) snapshots.push(snapshot(new Date(NOW - back * DAY - HOUR).toISOString(), 10 + back));
    const longTracker = { createdAt: new Date(NOW - 60 * DAY).toISOString(), snapshots };
    const cells = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: longTracker }));
    assert.equal(cells.length, 30);
    assert.equal(cells[0].label, "10-17(토)");
    assert.equal(cells[29].label, "09-18(금)");
    // 등록 3일 전: 4칸(오늘·1·2·3일 전)만
    const shortTracker = { createdAt: kst("2026-10-14", 23, 50), snapshots: [snapshot(kst("2026-10-15", 9, 0), 7)] };
    const shortCells = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: shortTracker }));
    assert.deepEqual(shortCells.map((cell) => cell.label + "=" + cell.value), ["10-17(토)=-", "10-16(금)=-", "10-15(목)=7위", "10-14(수)=-"]);
    // 오늘 등록·오늘 측정: 1칸
    const todayTracker = { createdAt: kst("2026-10-17", 0, 5), snapshots: [snapshot(kst("2026-10-17", 9, 12), 3)] };
    assert.deepEqual(boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: todayTracker })).map((cell) => cell.value), ["3위"]);
  });

  test(`${label}: 오전·오후 칸 규칙은 그대로(그날 오전·오후 마지막 측정 중 순위 있는 나중 값)`, () => {
    const context = sandbox(source, label);
    const tracker = {
      createdAt: kst("2026-10-13", 0, 0),
      snapshots: [
        // 10-16: 오전 10위, 오후 순위 없음 → 10위
        snapshot(kst("2026-10-16", 9, 0), 10),
        snapshot(kst("2026-10-16", 15, 0), null),
        // 10-15: 오전 10위, 오후 20위 → 20위
        snapshot(kst("2026-10-15", 9, 0), 10),
        snapshot(kst("2026-10-15", 15, 0), 20),
        // 10-14: 오후 13시 5위 뒤 16시 순위 없음 → 오후 칸은 16시 측정 → '-'
        snapshot(kst("2026-10-14", 13, 0), 5),
        snapshot(kst("2026-10-14", 16, 0), null),
        // 10-13: 오전 9시 7위 뒤 11시 순위 없음, 오후 18위 → 18위
        snapshot(kst("2026-10-13", 9, 0), 7),
        snapshot(kst("2026-10-13", 11, 0), null),
        snapshot(kst("2026-10-13", 18, 0), 18),
      ],
    };
    const cells = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: tracker }));
    assert.deepEqual(cells.map((cell) => cell.label + "=" + cell.value), ["10-17(토)=-", "10-16(금)=10위", "10-15(목)=20위", "10-14(수)=-", "10-13(화)=18위"]);
    // 원부 순위 칸은 작은 글이 '원부'
    const catalog = { createdAt: kst("2026-10-17", 0, 0), snapshots: [snapshot(kst("2026-10-17", 9, 0), 8, { item: { trackingRankSource: "related_catalog" } })] };
    assert.equal(boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: catalog }))[0].small, "원부");
  });

  test(`${label}: 날짜는 기기 시간대와 상관없이 KST 로 센다(자정 경계)`, () => {
    for (const zone of ["Asia/Seoul", "UTC", "America/Los_Angeles"]) {
      withTimeZone(zone, () => {
        const context = sandbox(source, label);
        const tracker = {
          createdAt: kst("2026-10-16", 0, 0),
          snapshots: [
            snapshot("2026-10-16T15:30:00.000Z", 4), // 10-17 00:30 KST(오전 칸)
            snapshot("2026-10-16T14:59:00.000Z", 9), // 10-16 23:59 KST(오후 칸)
          ],
        };
        const cells = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: tracker }));
        assert.deepEqual(cells.map((cell) => cell.label + "=" + cell.value), ["10-17(토)=4위", "10-16(금)=9위"], zone);
      });
    }
  });

  test(`${label}: 측정이 하나도 없으면 기존 안내 상자, 등록일을 모르면 가장 오래된 측정 날이 하한`, () => {
    const context = sandbox(source, label);
    assert.equal(
      run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: { createdAt: kst("2026-10-10"), snapshots: [] } }),
      '<div class="mi-rank-state">첫 오가닉 순위 확인 후 이 상품만의 일별 기록판이 생성됩니다.</div>',
    );
    const cells = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: { snapshots: [snapshot(kst("2026-10-15", 9, 0), 11)] } }));
    assert.deepEqual(cells.map((cell) => cell.label + "=" + cell.value), ["10-17(토)=-", "10-16(금)=-", "10-15(목)=11위"]);
  });
}

// ─────────────────────────────────────────────────────────────
// 1-b) 측정 목록이 잘렸을 수 있으면(캐시가 줄여 저장·서버 상한) 가장 오래된 측정 날까지만 칸을 만든다
// ─────────────────────────────────────────────────────────────
for (const [label, source] of PAGES) {
  test(`${label}: 잘린 측정 목록(캐시 30·62개, 서버 120개)으로 그리면 실제로 순위가 있던 앞쪽 날을 '-'로 만들지 않는다`, () => {
    const context = sandbox(source, label);
    // 하루 2회씩 30일 내내 순위가 있던 추적의 최근 15일분(30개)만 남은 캐시.
    const full = [];
    for (let back = 0; back < 30; back += 1) {
      const day = new Date(Date.parse("2026-10-17T00:00:00Z") - back * DAY).toISOString().slice(0, 10);
      full.push(snapshot(kst(day, 15, 0), 20 + (back % 5)), snapshot(kst(day, 9, 0), 21 + (back % 5)));
    }
    const createdAt = kst("2026-09-18", 8, 0);
    const fullCells = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: { createdAt, snapshots: full } }));
    assert.equal(fullCells.length, 30);
    assert.equal(fullCells.filter((cell) => cell.value === "-").length, 0, "서버 전체 목록이면 '-' 칸 없음");

    const cachedCells = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: { createdAt, snapshots: full.slice(0, 30), snapshotsTruncated: true } }));
    assert.equal(cachedCells.length, 15, "잘린 캐시는 가진 측정 가운데 가장 오래된 날(10-03)까지만");
    assert.equal(cachedCells[cachedCells.length - 1].label, "10-03(토)");
    assert.equal(cachedCells.filter((cell) => cell.value === "-").length, 0);

    // 잘렸다는 표시가 없으면(진짜로 측정이 없던 날) 예전처럼 등록일까지 '-' 칸을 만든다.
    const sparse = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: { createdAt, snapshots: full.slice(0, 30) } }));
    assert.equal(sparse.length, 30);
    assert.equal(sparse.filter((cell) => cell.value === "-").length, 15);

    // 서버 상한(120개)을 꽉 채운 목록도 잘렸을 수 있다고 본다. 오늘 측정 전이면 오늘 칸 '-'는 그대로.
    const dense = [];
    for (let back = 1; back <= 12; back += 1) {
      const day = new Date(Date.parse("2026-10-17T00:00:00Z") - back * DAY).toISOString().slice(0, 10);
      for (let n = 0; n < 10; n += 1) dense.push(snapshot(kst(day, 23 - n, 0), 7));
    }
    assert.equal(dense.length, 120);
    const denseCells = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: { createdAt, snapshots: dense } }));
    assert.deepEqual([denseCells.length, denseCells[0].label + "=" + denseCells[0].value, denseCells[denseCells.length - 1].label], [13, "10-17(토)=-", "10-05(월)"]);
    const under = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: { createdAt, snapshots: dense.slice(0, 119) } }));
    assert.equal(under.length, 30, "상한보다 적으면 등록일까지");

    // 잘린 목록이어도 가장 오래된 측정 날이 등록일이면 등록일까지(하한을 더 올리지 않는다).
    const lateCreated = boardCells(run(context, "renderTrackerDailyBoard(__tracker)", { __tracker: { createdAt: kst("2026-10-08", 8, 0), snapshots: full.slice(0, 20), snapshotsTruncated: true } }));
    assert.equal(lateCreated.length, 10);
    assert.equal(lateCreated[lateCreated.length - 1].label, "10-08(목)");
  });

  test(`${label}: 캐시는 N 30일 목록을 줄여 저장할 때만 snapshotsTruncated 를 남긴다(N 플레이스 캐시는 그대로)`, () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext(["compactRankSnapshotForCache", "compactRankTrackersForCache"].map((name) => htmlFunction(source, name, label)).join("\n\n"), context);
    const many = { id: "a", snapshots: Array.from({ length: 70 }, (_, index) => ({ checkedAt: new Date(NOW - index * HOUR).toISOString(), rank: 3 })) };
    const few = { id: "b", snapshots: [{ checkedAt: new Date(NOW).toISOString(), rank: 3 }] };
    const product = run(context, "compactRankTrackersForCache(__list, 62, true)", { __list: [many, few] });
    assert.deepEqual(product.map((tracker) => [tracker.snapshots.length, tracker.snapshotsTruncated === true]), [[62, true], [1, false]]);
    assert.equal(run(context, "compactRankTrackersForCache(__list, 30, true)", { __list: [many] })[0].snapshotsTruncated, true);
    const place = run(context, "compactRankTrackersForCache(__list, 62, false)", { __list: [many, few] });
    assert.deepEqual(place.map((tracker) => Object.prototype.hasOwnProperty.call(tracker, "snapshotsTruncated")), [false, false]);
    assert.deepEqual(place.map((tracker) => tracker.snapshots.length), [62, 1]);
    const write = htmlFunction(source, "writeRankTrackerLastGood", label);
    assert.ok(write.includes('compactRankTrackersForCache(trackers, 62, feature === "product")'));
    assert.ok(write.includes('compactRankTrackersForCache(trackers, 30, feature === "product")'));
  });
}

test("화면이 보는 서버 측정 상한(120개)이 서버 상수와 같다", () => {
  const server = readRepoFile("src/server/handlers/naver-rank-trackers.mjs");
  assert.ok(/const PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS = 120;/.test(server), "서버 상한이 바뀌면 rankTrackerSnapshotsMaybeTruncated 의 120 도 같이 바꾼다");
  for (const [label, source] of PAGES) {
    assert.ok(htmlFunction(source, "rankTrackerSnapshotsMaybeTruncated", label).includes(".length >= 120"), label);
  }
});

// ─────────────────────────────────────────────────────────────
// 2) 7일 평균
// ─────────────────────────────────────────────────────────────
for (const [label, source] of PAGES) {
  test(`${label}: '7일 평균'은 오늘 포함 최근 7일(KST) 안 순위 측정의 반올림 평균`, () => {
    for (const zone of ["Asia/Seoul", "UTC"]) {
      withTimeZone(zone, () => {
        const context = sandbox(source, label);
        const tracker = {
          snapshots: [
            snapshot(kst("2026-10-17", 9, 12), 11),
            snapshot(kst("2026-10-15", 15, 27), null), // 순위 없음 제외
            snapshot("2026-10-10T15:00:00.000Z", 10), // 10-11 00:00 KST = 7일 창 첫 순간(포함)
            snapshot("2026-10-10T14:59:59.000Z", 1), // 10-10 23:59:59 KST(제외)
            snapshot(kst("2026-10-01", 9, 0), 2), // 오래된 측정(제외)
          ],
        };
        assert.equal(run(context, "rankTrackerSevenDayAverageRank(__tracker)", { __tracker: tracker }), 11, zone); // (11+10)/2=10.5 → 11
        // 예전 계산(최근 순위 측정 14개)과 다르다는 것도 확인: 1·2 가 섞여 6
        assert.equal(run(context, "rankTrackerAverageRank(__tracker, 14)", { __tracker: tracker }), 6);
      });
    }
    const context = sandbox(source, label);
    assert.equal(run(context, "rankTrackerSevenDayAverageRank(__tracker)", { __tracker: { snapshots: [snapshot(kst("2026-10-17", 9, 0), 3), snapshot(kst("2026-10-16", 9, 0), 4)] } }), 4, "3.5 → 4");
    assert.equal(run(context, "rankTrackerSevenDayAverageRank(__tracker)", { __tracker: { snapshots: [snapshot(kst("2026-10-17", 9, 0), 3), snapshot(kst("2026-10-16", 9, 0), 3), snapshot(kst("2026-10-15", 9, 0), 4)] } }), 3, "3.33 → 3");
    assert.equal(run(context, "rankTrackerSevenDayAverageRank(__tracker)", { __tracker: { snapshots: [snapshot(kst("2026-10-17", 9, 0), null), snapshot(kst("2026-10-09", 9, 0), 5)] } }), 0, "7일 안 순위 없음 → 0");
    assert.equal(run(context, "rankTrackerSevenDayAverageRank(__tracker)", { __tracker: {} }), 0);
  });

  test(`${label}: 카드 '7일 평균' 알약이 새 계산을 쓰고, 7일 안 순위가 없으면 '-'`, () => {
    const context = sandbox(source, label, { card: true });
    const base = { id: "t1", keyword: "키워드", productId: "123", status: "active", currentRank: 11, bestRank: 2 };
    const found = run(context, "renderRankTrackerCard(__tracker, null)", { __tracker: { ...base, snapshots: [snapshot(kst("2026-10-17", 9, 12), 11), snapshot(kst("2026-10-16", 9, 12), 10), snapshot(kst("2026-10-02", 9, 0), 2)] } });
    assert.ok(found.includes("<span>7일 평균 11위</span>"), "(11+10)/2 = 10.5 → 11위 (10-02 의 2위는 7일 밖)");
    const none = run(context, "renderRankTrackerCard(__tracker, null)", { __tracker: { ...base, currentRank: null, snapshots: [snapshot(kst("2026-10-17", 9, 12), null), snapshot(kst("2026-10-05", 9, 0), 40)] } });
    assert.ok(none.includes("<span>7일 평균 -</span>"));
    assert.ok(source.includes("var avgRank = rankTrackerSevenDayAverageRank(tracker);"));
  });
}

// ─────────────────────────────────────────────────────────────
// 3) 공유 이미지 복제본
// ─────────────────────────────────────────────────────────────
const INTERNAL_PILL_PREFIXES = ["상태 ", "그룹 ", "최근 ", "다음 ", "권고 ", "메시지 "];

for (const [label, source] of PAGES) {
  test(`${label}: 이미지 복제본에서는 운영줄 내부 알약이 빠지고, 화면 카드는 그대로`, () => {
    const context = sandbox(source, label, { card: true });
    const tracker = {
      id: "t-share",
      keyword: "아이폰 필름",
      productId: "11223344551",
      productTitle: "미리보기 필름",
      status: "active",
      currentRank: null,
      bestRank: 14,
      neverFound: true,
      groupName: "필름",
      lastMessage: "네이버쇼핑 오가닉 상위 300개 결과에서 대상 상품을 찾지 못했습니다.",
      snapshots: [snapshot(kst("2026-10-16", 9, 12), null), snapshot(kst("2026-10-14", 9, 12), 14)],
      createdAt: kst("2026-10-13", 8, 0),
    };
    const html = run(context, "renderRankTrackerCard(__tracker, null)", { __tracker: tracker });
    const screenCard = parseHtml(html).querySelector(".mi-rank-tracker-card");
    const opsText = (card) => card.querySelector(".mi-rank-ops-row").children.filter((child) => child instanceof MiniElement).map((child) => child.textContent);

    // 화면 카드: 전부 보인다.
    const screenOps = opsText(screenCard);
    for (const prefix of INTERNAL_PILL_PREFIXES) assert.ok(screenOps.some((text) => text.startsWith(prefix)), `${label} 화면 카드에 '${prefix}' 알약이 있어야 한다`);
    assert.ok(screenOps.includes("점검 필요"));
    assert.ok(screenOps.includes("원부 확인 필요"));
    assert.ok(screenCard.querySelector(".mi-rank-catalog-hint"));

    const share = run(context, "cloneRankTrackerCardForShare(__source)", { __source: screenCard });
    const shareOps = opsText(share);
    assert.deepEqual(shareOps, ["전회 데이터 대기", "7일 평균 14위"], "운영줄에는 전회 대비·7일 평균만 남는다");
    assert.equal(share.querySelector(".mi-rank-catalog-hint"), null, "원부 안내문도 이미지에서 빠진다");
    assert.deepEqual(share.querySelector(".mi-rank-row-actions").querySelectorAll("span").map((node) => node.textContent), ["현재 - · 상품", "최고 14위"]);
    assert.equal(share.querySelectorAll(".mi-rank-day-card").length, 5, "날짜 줄(10-17~10-13)은 남는다");
    assert.equal(share.querySelectorAll("button, input").length, 0);
    assert.ok(share.textContent.includes("아이폰 필름") && share.textContent.includes("미리보기 필름"), "키워드·상품명은 남는다");

    // 복제가 화면 카드를 건드리지 않았다.
    assert.deepEqual(opsText(screenCard), screenOps);
    assert.ok(screenCard.querySelector(".mi-rank-catalog-hint"));
    assert.ok(screenCard.querySelectorAll("button").length > 0);

    // 공용 cloneRankCardForExport(N 플레이스 이미지가 쓰는 함수)는 알약을 빼지 않는다.
    const plain = run(context, "cloneRankCardForExport(__source)", { __source: screenCard });
    assert.equal(opsText(plain).filter((text) => text !== "그룹 변경").length, screenOps.filter((text) => text !== "그룹 변경").length);
  });

  test(`${label}: N 30일 이미지 시트만 공유용 복제를 쓰고 N 플레이스 이미지 경로는 그대로`, () => {
    const sheet = htmlFunction(source, "renderRankExportSheet", label);
    assert.ok(sheet.includes("list.appendChild(cloneRankTrackerCardForShare(source));"));
    assert.ok(sheet.includes('timeZone: "Asia/Seoul"'), "이미지 머리 시각도 날짜 칸과 같은 한국 시간");
    const placeBody = lockedFunction(source, "initPlaceRankTracking");
    assert.ok(placeBody.includes("cloneRankCardForExport("), "플레이스 이미지는 공용 복제를 그대로 쓴다");
    assert.ok(!placeBody.includes("cloneRankTrackerCardForShare"));
    assert.ok(!placeBody.includes("data-rank-export-omit"));
  });
}

// ─────────────────────────────────────────────────────────────
// 4) 그룹 필터가 입력칸 change 로 풀리지 않는다
// ─────────────────────────────────────────────────────────────
function n30ChangeHandler(source, label) {
  const body = lockedFunction(source, "initRankTracking");
  let from = -1;
  let cursor = 0;
  for (;;) {
    const index = body.indexOf('card.addEventListener("change", function (event) {', cursor);
    if (index < 0) break;
    const block = blockFrom(body, index);
    if (block.includes("[data-rank-group-select]")) { from = index; break; }
    cursor = index + 1;
  }
  assert.ok(from >= 0, `${label}: N 30일 change 처리기를 찾지 못했다`);
  return blockFrom(body, from) + ");";
}

function changeSandbox(source, label) {
  const root = parseHtml(
    '<article class="mi-rank-card" data-rank-card data-rank-filter-group="필름" data-rank-filter-text="">' +
      '<label data-rank-filter-group-wrap><select data-rank-filter-group></select></label>' +
      '<input data-rank-filter-search value="필름" />' +
      '<div class="mi-rank-bulk-bar" data-rank-bulk-bar><input data-rank-bulk-group value="새그룹" />' +
      '<button data-rank-bulk-move>그룹 생성/적용</button></div>' +
      '<section data-rank-group-section><input type="checkbox" data-rank-select value="t1" /></section>' +
    "</article>",
  );
  const card = root.querySelector("[data-rank-card]");
  card.querySelector("select[data-rank-filter-group]").value = "필름";
  const handlers = [];
  card.addEventListener = (type, handler) => { if (type === "change") handlers.push(handler); };
  const context = {
    card,
    rankHistory: {},
    rankTrackers: [],
    renders: 0,
    selected: new Set(),
  };
  vm.createContext(context);
  vm.runInContext(`
    function renderRankHistory() { renders += 1; }
    function rankSelectedSet() { return selected; }
    function setRankSelectedSet(cardNode, next) { selected = next; }
    function setRankBulkGroupDraft(cardNode, value) { cardNode.setAttribute("data-rank-bulk-group-draft", value); }
  `, context);
  vm.runInContext(n30ChangeHandler(source, label), context);
  assert.equal(handlers.length, 1);
  return { card, context, fire: (target) => handlers[0]({ target }) };
}

for (const [label, source] of PAGES) {
  test(`${label}: 그룹명 입력칸·검색칸 change 가 그룹 필터를 풀거나 목록을 다시 그리지 않는다`, () => {
    const { card, context, fire } = changeSandbox(source, label);
    const bulkInput = card.querySelector("[data-rank-bulk-group]");
    // 예전 선택자 "[data-rank-filter-group]" 은 입력칸에서 카드 자신을 잡았다(결함의 원인).
    assert.equal(bulkInput.closest("[data-rank-filter-group]"), card);
    assert.equal(bulkInput.closest("select[data-rank-filter-group]"), null);

    fire(bulkInput);
    fire(card.querySelector("[data-rank-filter-search]"));
    assert.equal(card.getAttribute("data-rank-filter-group"), "필름", "필터가 그대로 남는다");
    assert.equal(context.renders, 0, "목록을 다시 그리지 않아 '그룹 생성/적용' 버튼이 그대로 있다(첫 클릭이 사라지지 않음)");

    // 그룹 필터 select 의 change 는 예전처럼 처리한다.
    const select = card.querySelector("select[data-rank-filter-group]");
    select.value = "";
    fire(select);
    assert.equal(card.getAttribute("data-rank-filter-group"), "");
    assert.equal(context.renders, 1);

    // 항목 선택 체크는 예전처럼 선택 집합을 바꾸고 다시 그린다.
    const check = card.querySelector("[data-rank-select]");
    check.checked = true;
    fire(check);
    assert.ok(context.selected.has("t1"));
    assert.equal(context.renders, 2);
    assert.equal(card.getAttribute("data-rank-bulk-group-draft"), "새그룹");
  });
}

// ─────────────────────────────────────────────────────────────
// N 플레이스 30일 공용 함수 결과 무변경
// ─────────────────────────────────────────────────────────────
for (const [label, source] of PAGES) {
  test(`${label}: N 플레이스가 쓰는 공용 함수 결과는 그대로(최근 측정 7개 평균·기기 날짜·측정한 날만)`, () => {
    const context = sandbox(source, label);
    const snapshots = [30, 0, 20, 10, 40, 50, 60, 70, 80].map((rank, index) => snapshot(new Date(NOW - index * 5 * DAY).toISOString(), rank || null));
    // 날짜와 상관없이 순위 있는 최근 측정 7개: 30,20,10,40,50,60,70 → 40
    assert.equal(run(context, "rankTrackerAverageRank(__tracker, 7)", { __tracker: { snapshots } }), 40);
    assert.equal(run(context, "rankTrackerAverageRank(__tracker, 14)", { __tracker: { snapshots } }), 45);
    assert.equal(run(context, "rankTrackerAverageRank(__tracker)", { __tracker: { snapshots: [] } }), 0);

    // rankDateKey 는 기기 시각 기준 그대로.
    vm.runInContext(htmlFunction(source, "rankDateKey", label), context);
    withTimeZone("UTC", () => {
      assert.equal(run(context, 'rankDateKey(new Date("2026-10-16T15:30:00.000Z"))'), "2026-10-16");
    });

    // 플레이스 기록판: 측정한 날만 칸이 된다(빠진 날 채우기는 N 30일만).
    const placeContext = {};
    vm.createContext(placeContext);
    vm.runInContext(`Date.now = function () { return ${NOW}; };`, placeContext);
    vm.runInContext([
      "escapeHtml", "rankText", "formatNumber", "rankDateKey", "rankDayLabel", "rankDayClass", "rankTrackerRankValue",
      "placeSnapshotTargetMetric", "placeDaySnapshotState", "groupPlaceSnapshotsByDay", "renderPlaceTrackerDailyBoard",
    ].map((name) => htmlFunction(source, name, label)).join("\n\n"), placeContext);
    const placeHtml = run(placeContext, "renderPlaceTrackerDailyBoard(__tracker)", {
      __tracker: {
        createdAt: new Date(NOW - 20 * DAY).toISOString(),
        snapshots: [
          { checkedAt: new Date(NOW - HOUR).toISOString(), rank: 3, checkedCount: 3, requestedMaxRank: 300 },
          { checkedAt: new Date(NOW - 4 * DAY).toISOString(), rank: 5, checkedCount: 5, requestedMaxRank: 300 },
        ],
      },
    });
    assert.equal((placeHtml.match(/class="mi-place-day-card/g) || []).length, 2);
  });
}

test("admin.html·client.html 의 N 30일 날짜 줄·7일 평균·이미지 함수는 글자 하나까지 같다(관리자·광고주가 같은 숫자)", () => {
  for (const name of [
    "rankKstParts", "rankKstDayKey", "rankKstDayShift", "rankKstDayDate", "groupRankSnapshotsByDay", "latestRankSnapshotForDay",
    "renderRankSlot", "rankTrackerSnapshotsMaybeTruncated", "rankTrackerBoardDayKeys", "renderTrackerDailyBoard",
    "rankTrackerSevenDayAverageRank", "renderRankTrackerCard", "cloneRankCardForExport", "cloneRankTrackerCardForShare",
    "renderRankExportSheet", "compactRankTrackersForCache", "writeRankTrackerLastGood",
  ]) {
    assert.equal(htmlFunction(adminSource, name, "admin"), htmlFunction(clientSource, name, "client"), name);
  }
});
