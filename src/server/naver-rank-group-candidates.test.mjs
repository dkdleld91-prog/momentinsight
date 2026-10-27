import assert from "node:assert/strict";
import test from "node:test";

import {
  deviceModelLabels,
  findGroupProductCandidates,
  GROUP_CANDIDATES_PER_SNAPSHOT_MAX,
  groupCandidateCardCheck,
  groupCandidateKindKey,
  groupCandidateSummaries,
  primaryPriceFromHistory,
  trackerGroupProductState,
} from "./naver-rank-option-group.mjs";

// N30 그룹상품 후보(대표 승인 2026-10-27 A안) — 판정은 순수 함수라 운영 DB·네이버 없이 표로 확인한다.
//   C1 후보 조건 표: 스토어 같음/다름 × 종류 단어 같음/다름 × 가격 × 광고·원부 × 추적 번호
//   C2 창 훑기: 그룹상품만 · 번호가 보이면 안 함 · 기준 스토어 없으면 안 함 · 최대 5개·순위 순
//   C3 fail-soft: 오류는 빈 목록(던지지 않음)
//   C4 목록 모으기: 최근 7일 · 두 번 이상(다른 키워드 추적이나 다른 날) · 대표·넣은 번호 제외 · 표시 안 한 추적 제외
//   C5 기종 경고(조건 아님)·종류 단어 묶음

const PRIMARY = "12356459438";
const OPTION_SAVED = "99900000001";
const CAND_A = "99900000011";
const CAND_B = "99900000012";
const NOW = Date.parse("2026-10-27T03:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function tracker(extra = {}) {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    keyword: "아이폰17 필름",
    product_url: `https://smartstore.naver.com/ishell/products/${PRIMARY}`,
    product_id: PRIMARY,
    mall_name: "아이쉘",
    product_title: "아이쉘 아이폰17 저반사 액정보호필름 2매",
    option_product_ids: [],
    group_product_marked: true,
    ...extra,
  };
}

function card(rank, sellerProductId, extra = {}) {
  return {
    organicRank: rank,
    isOrganic: true,
    isAd: false,
    productId: String(3000000000 + rank),
    sellerProductId,
    title: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
    mallName: "아이쉘",
    link: `https://smartstore.naver.com/main/products/${sellerProductId}`,
    productType: "2",
    lprice: 9900,
    ...extra,
  };
}

function filler(rank) {
  return card(rank, String(2000000000 + rank), { title: `다른 필름 ${rank}`, mallName: `판매처 ${rank}`, link: `https://smartstore.naver.com/store${rank}/products/${2000000000 + rank}` });
}

function windowWith(cards = {}, count = 300) {
  return { checkedCount: count, items: Array.from({ length: count }, (_, index) => cards[index + 1] || filler(index + 1)) };
}

const history = (extra = {}) => ({
  tracker_id: tracker().id,
  checked_at: new Date(NOW - 24 * HOUR).toISOString(),
  matched: true,
  item: {
    trackingRankSource: "exact_product",
    isExactTarget: true,
    sellerProductId: PRIMARY,
    mallName: "아이쉘",
    isOrganic: true,
    isAd: false,
    lprice: 9900,
    ...extra,
  },
});

const NOT_FOUND = { matched: false, rank: null, complete: true, checkedCount: 300 };

test("C1 후보 조건 표(카드 한 장 판정)", () => {
  const base = {
    checkedCount: 300,
    excludeProductIds: new Set([PRIMARY, OPTION_SAVED]),
    referenceMallKeys: new Set(["아이쉘"]),
    trackerProductUrl: `https://smartstore.naver.com/ishell/products/${PRIMARY}`,
    trackerKindKey: groupCandidateKindKey("아이쉘 아이폰17 저반사 액정보호필름 2매"),
    referencePrice: 9900,
  };
  const rows = [
    ["같은 스토어·같은 종류·비슷한 가격 → 후보", card(40, CAND_A), {}, ""],
    ["스토어 이름 다름", card(40, CAND_A, { mallName: "다른몰" }), {}, "other_store"],
    ["스토어 이름 빈칸", card(40, CAND_A, { mallName: "" }), {}, "other_store"],
    ["기준 스토어 이름 없음", card(40, CAND_A), { referenceMallKeys: new Set() }, "other_store"],
    ["스토어 주소(slug) 다름", card(40, CAND_A, { link: `https://smartstore.naver.com/othershop/products/${CAND_A}` }), {}, "other_store"],
    ["스토어 주소 같음", card(40, CAND_A, { link: `https://smartstore.naver.com/ishell/products/${CAND_A}` }), {}, ""],
    ["종류 단어 다름(사생활보호 더함)", card(40, CAND_A, { title: "아이쉘 아이폰16 사생활보호 액정보호필름" }), {}, "kind"],
    ["종류 단어 다름(카메라 필름)", card(40, CAND_A, { title: "아이쉘 아이폰16 카메라 보호필름" }), {}, "kind"],
    ["종류 단어 다름(액정 없음)", card(40, CAND_A, { title: "아이쉘 아이폰16 필름 2매" }), {}, "kind"],
    ["가격 절반 미만", card(40, CAND_A, { lprice: 4900 }), {}, "price"],
    ["가격 두 배 넘음", card(40, CAND_A, { lprice: 19900 }), {}, "price"],
    ["가격 경계(절반·두 배)는 후보", card(40, CAND_A, { lprice: 4950 }), {}, ""],
    ["가격 경계 두 배", card(40, CAND_A, { lprice: 19800 }), {}, ""],
    ["기록 가격 없으면 가격 조건 생략", card(40, CAND_A, { lprice: 99000 }), { referencePrice: null }, ""],
    ["카드 가격 없으면 가격 조건 생략", card(40, CAND_A, { lprice: 0 }), {}, ""],
    ["광고 카드", card(40, CAND_A, { isAd: true, isOrganic: false }), {}, "ad"],
    ["광고 표시 칸", card(40, CAND_A, { adId: "nad-1" }), {}, "ad"],
    ["원부(가격비교) 카드", card(40, CAND_A, { productType: "1", link: "https://search.shopping.naver.com/catalog/51234567890" }), {}, "catalog"],
    ["대표 번호 카드", card(40, PRIMARY), {}, "tracked"],
    ["이미 넣은 옵션 번호 카드", card(40, OPTION_SAVED), {}, "tracked"],
    ["상품번호 없음", card(40, "", { link: "https://smartstore.naver.com/main/" }), {}, "no_product_id"],
    ["순위 없음", card(40, CAND_A, { organicRank: null }), {}, "no_rank"],
  ];
  for (const [label, item, overrides, reason] of rows) {
    const result = groupCandidateCardCheck({ ...base, ...overrides, item });
    assert.equal(result.reason, reason, label);
  }
  const accepted = groupCandidateCardCheck({ ...base, item: card(40, CAND_A) });
  assert.deepEqual(accepted.candidate, {
    productId: CAND_A,
    rank: 40,
    title: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
    mallName: "아이쉘",
    lprice: 9900,
    link: `https://smartstore.naver.com/main/products/${CAND_A}`,
  }, "스냅샷에는 번호·순위·제목·스토어·가격·링크만 남긴다");
  const longTitle = groupCandidateCardCheck({ ...base, item: card(40, CAND_A, { title: `${"아이쉘 ".repeat(30)}저반사 액정` }) });
  assert.equal(longTitle.candidate.title.length, 80, "제목 80자");
  const outsideLink = groupCandidateCardCheck({ ...base, item: card(40, CAND_A, { sellerProductId: CAND_A, link: "javascript:alert(1)" }) });
  assert.equal(outsideLink.reason, "");
  assert.equal(Object.hasOwn(outsideLink.candidate, "link"), false, "네이버 https 주소가 아니면 링크를 남기지 않는다");
});

test("C2 창 훑기: 그룹상품 추적·번호가 결과에 없을 때만, 최대 5개·순위 순", () => {
  const cards = {
    90: card(90, "99900000090"),
    40: card(40, CAND_A),
    55: card(55, CAND_B, { mallName: "다른몰" }),
    61: card(61, "99900000061"),
    62: card(62, "99900000062"),
    63: card(63, "99900000063"),
    64: card(64, "99900000064"),
    70: card(70, CAND_A), // 같은 번호 두 번째 카드는 한 번만
  };
  const window = windowWith(cards);
  const found = findGroupProductCandidates({ window, tracker: tracker(), result: NOT_FOUND, historyRows: [history()] });
  assert.deepEqual(found.map((entry) => [entry.productId, entry.rank]), [
    [CAND_A, 40], ["99900000061", 61], ["99900000062", 62], ["99900000063", 63], ["99900000064", 64],
  ]);
  assert.equal(found.length, GROUP_CANDIDATES_PER_SNAPSHOT_MAX);

  // 그룹상품이 아니면(표시 안 함·칸 없음·옵션 없음) 계산하지 않는다.
  for (const extra of [{ group_product_marked: false }, { group_product_marked: undefined }, { group_product_marked: null }]) {
    assert.deepEqual(findGroupProductCandidates({ window, tracker: tracker(extra), result: NOT_FOUND, historyRows: [history()] }), [], JSON.stringify(extra));
  }
  // 옵션 번호가 있으면 표시 없이도 그룹상품이다(넣은 번호는 후보에서 뺀다).
  const withOption = findGroupProductCandidates({ window, tracker: tracker({ group_product_marked: false, option_product_ids: [CAND_A] }), result: NOT_FOUND, historyRows: [history()] });
  assert.ok(withOption.length > 0);
  assert.ok(withOption.every((entry) => entry.productId !== CAND_A));
  // 대표·옵션·원부 어느 쪽으로든 잡혔으면 후보를 찾지 않는다.
  assert.deepEqual(findGroupProductCandidates({ window, tracker: tracker(), result: { matched: true, rank: 12 }, historyRows: [history()] }), []);
  // 원부 추적·대표 번호를 확인할 수 없는 추적은 그룹상품이 아니다.
  assert.deepEqual(findGroupProductCandidates({ window, tracker: tracker({ product_url: "https://search.shopping.naver.com/catalog/51234567890", product_id: "51234567890" }), result: NOT_FOUND }), []);
  assert.deepEqual(findGroupProductCandidates({ window, tracker: tracker({ product_id: "" }), result: NOT_FOUND }), []);
  // 기준 스토어 이름이 없으면(기록 없음·추적 mall_name 없음) 만들지 않는다. 추적 mall_name 만 있어도 된다.
  assert.deepEqual(findGroupProductCandidates({ window, tracker: tracker({ mall_name: "" }), result: NOT_FOUND, historyRows: [] }), []);
  assert.ok(findGroupProductCandidates({ window, tracker: tracker(), result: NOT_FOUND, historyRows: [] }).length > 0);
  // 추적 제목이 없으면 종류를 비교할 수 없어 만들지 않는다.
  assert.deepEqual(findGroupProductCandidates({ window, tracker: tracker({ product_title: "" }), result: NOT_FOUND, historyRows: [history()] }), []);
  // 가격: 지난 기록 가격 대비 크게 다른 카드는 뺀다.
  const pricey = windowWith({ 40: card(40, CAND_A, { lprice: 30000 }), 41: card(41, CAND_B) });
  assert.deepEqual(findGroupProductCandidates({ window: pricey, tracker: tracker(), result: NOT_FOUND, historyRows: [history()] }).map((entry) => entry.productId), [CAND_B]);
  // 유한 창(checkedCount 40)은 40위 안 카드만.
  const finite = windowWith({ 12: card(12, CAND_A) }, 40);
  assert.deepEqual(findGroupProductCandidates({ window: finite, tracker: tracker(), result: { ...NOT_FOUND, checkedCount: 40 }, historyRows: [history()] }).map((entry) => entry.rank), [12]);
});

test("C2 지난 기록 가격: 대표 정확 기록의 가장 최근 lprice(옵션·원부·광고 행 제외)", () => {
  const older = history({ lprice: 8000 });
  older.checked_at = new Date(NOW - 72 * HOUR).toISOString();
  const option = history({ lprice: 1000, matchBasis: "group_option", sellerProductId: OPTION_SAVED, isExactTarget: true });
  option.checked_at = new Date(NOW - 1 * HOUR).toISOString();
  const catalog = history({ lprice: 2000, trackingRankSource: "related_catalog" });
  catalog.checked_at = new Date(NOW - 2 * HOUR).toISOString();
  assert.equal(primaryPriceFromHistory([older, history(), option, catalog], [PRIMARY]), 9900);
  assert.equal(primaryPriceFromHistory([], [PRIMARY]), null);
});

test("C3 fail-soft: 창·기록이 이상해도 던지지 않고 빈 목록(경고 1줄)", () => {
  const original = console.warn;
  const lines = [];
  console.warn = (line) => lines.push(String(line));
  try {
    const hostile = { checkedCount: 300 };
    Object.defineProperty(hostile, "items", { get() { throw new Error("boom"); } });
    assert.deepEqual(findGroupProductCandidates({ window: hostile, tracker: tracker(), result: NOT_FOUND, historyRows: [history()] }), []);
    const badHistory = history();
    Object.defineProperty(badHistory.item, "lprice", { get() { throw new Error("boom"); } });
    assert.deepEqual(findGroupProductCandidates({ window: windowWith({ 40: card(40, CAND_A) }), tracker: tracker(), result: NOT_FOUND, historyRows: [badHistory] }), []);
    assert.deepEqual(findGroupProductCandidates(), []);
    assert.deepEqual(findGroupProductCandidates({ window: null, tracker: tracker(), result: NOT_FOUND }), []);
  } finally {
    console.warn = original;
  }
  assert.equal(lines.filter((line) => line.includes("naver_rank_group_candidates_failed")).length, 2);
});

function listRow(id, extra = {}) {
  return {
    id,
    keyword: `키워드 ${id}`,
    product_url: `https://smartstore.naver.com/ishell/products/${PRIMARY}`,
    product_id: PRIMARY,
    mall_name: "아이쉘",
    product_title: "아이쉘 아이폰17 저반사 액정보호필름 2매",
    option_product_ids: [],
    group_product_marked: true,
    ...extra,
  };
}

function snap(checkedAtMs, candidates) {
  return { checked_at: new Date(checkedAtMs).toISOString(), matched: false, item: { trackingRankSource: "not_found", groupCandidates: candidates } };
}

const entry = (productId, rank, extra = {}) => ({ productId, rank, title: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매", mallName: "아이쉘", lprice: 9900, ...extra });

test("C4 목록 모으기: 7일 · 두 번 이상 · 같은 대표 상품번호끼리 · 대표·넣은 번호 제외", () => {
  const rows = [
    listRow("t-a"),
    listRow("t-b", { keyword: "아이폰 필름" }),
    listRow("t-c", { group_product_marked: false }), // 표시 안 함 → 모으지도 보이지도 않음
    listRow("t-d", { group_product_marked: false, option_product_ids: [CAND_B] }), // 옵션 있음 = 그룹상품
    listRow("t-e", { product_id: "88800000001", product_url: "https://smartstore.naver.com/ishell/products/88800000001" }), // 다른 대표 번호
  ];
  const day = 24 * HOUR;
  const snapshots = new Map([
    ["t-a", [
      snap(NOW - 1 * HOUR, [entry(CAND_A, 41), entry(CAND_B, 50), entry("99900000077", 77)]),
      snap(NOW - 3 * HOUR, [entry(CAND_A, 45), entry("99900000077", 70)]), // 같은 날 두 번 = 한 번
      snap(NOW - 2 * day, [entry(CAND_A, 39, { title: "아이쉘 아이폰17 프로 저반사 액정보호필름 2매" })]),
      snap(NOW - 8 * day, [entry("99900000088", 30)]), // 7일 밖
    ]],
    ["t-b", [snap(NOW - 2 * HOUR, [entry(CAND_B, 33)])]],
    ["t-c", [snap(NOW - 2 * HOUR, [entry("99900000077", 60)]), snap(NOW - 4 * day, [entry("99900000077", 61)])]],
    ["t-e", [snap(NOW - 2 * HOUR, [entry(CAND_A, 20)]), snap(NOW - day, [entry(CAND_A, 21)])]],
  ]);
  const result = groupCandidateSummaries(rows, snapshots, { nowMs: NOW });
  assert.equal(result.has("t-c"), false, "표시 안 한 추적은 후보 칸이 없다");
  const a = result.get("t-a");
  assert.deepEqual(a.map((item) => [item.productId, item.seenCount, item.keywordCount]), [
    [CAND_B, 2, 2], // 다른 키워드 추적 두 곳(최고 33위라 먼저)
    [CAND_A, 2, 1], // 다른 날 두 번
  ], "같은 날 같은 추적에서만 두 번 보인 번호(…077)와 7일 밖(…088)은 없다");
  a.reverse();
  assert.equal(a[0].latestRank, 41);
  assert.equal(a[0].bestRank, 39);
  assert.equal(a[0].title, "아이쉘 아이폰16 프로 저반사 액정보호필름 2매", "가장 최근 기록의 제목");
  assert.equal(a[0].link, `https://smartstore.naver.com/main/products/${CAND_A}`, "링크가 없으면 상품 주소를 만든다");
  assert.deepEqual(a[0].sightings.map((sighting) => [sighting.keyword, sighting.rank]), [["키워드 t-a", 41], ["키워드 t-a", 39]]);
  assert.deepEqual(a[0].warnings.map((warning) => warning.code), ["model_differs"]);
  assert.equal(a[0].warnings[0].text, "기종 다름: 아이폰 16 프로");
  assert.match(a[0].warnings[0].detail, /추적 상품은 아이폰 17입니다/u);
  // t-d 는 CAND_B 를 이미 넣었으므로 그 번호는 빠진다.
  assert.deepEqual(result.get("t-d").map((item) => item.productId), [CAND_A]);
  assert.deepEqual(result.get("t-b").map((item) => item.productId), [CAND_B, CAND_A]);
  // 다른 대표 번호 그룹은 따로 모인다.
  assert.deepEqual(result.get("t-e").map((item) => [item.productId, item.seenCount]), [[CAND_A, 2]]);
  // 대표 번호와 같은 번호는 후보가 아니다.
  const self = groupCandidateSummaries([listRow("t-a")], new Map([["t-a", [snap(NOW - HOUR, [entry(PRIMARY, 3)]), snap(NOW - 2 * day, [entry(PRIMARY, 4)])]]]), { nowMs: NOW });
  assert.deepEqual(self.get("t-a"), []);
  // 깨진 항목은 건너뛴다.
  const broken = groupCandidateSummaries([listRow("t-a")], new Map([["t-a", [snap(NOW - HOUR, [null, { productId: "abc" }, "x"]), { checked_at: "bad", item: {} }]]]), { nowMs: NOW });
  assert.deepEqual(broken.get("t-a"), []);
});

test("C4 상태: 표시 칸을 못 읽으면 markReady:false, 옵션이 있으면 표시 없이도 그룹상품", () => {
  assert.deepEqual(
    (({ markReady, marked, groupProduct }) => ({ markReady, marked, groupProduct }))(trackerGroupProductState(listRow("x", { group_product_marked: null }))),
    { markReady: false, marked: false, groupProduct: false },
  );
  assert.equal(trackerGroupProductState(listRow("x", { group_product_marked: false, option_product_ids: [CAND_A] })).groupProduct, true);
  assert.equal(trackerGroupProductState(listRow("x", { group_product_marked: true })).groupProduct, true);
  assert.equal(trackerGroupProductState({ product_url: "%E0%A4%A", product_id: "12" }).groupProduct, false, "깨진 행도 던지지 않는다");
});

test("C5 기종 경고 이름·종류 단어 묶음", () => {
  assert.deepEqual(deviceModelLabels("아이쉘 아이폰16 프로 저반사 필름"), ["아이폰 16 프로"]);
  assert.deepEqual(deviceModelLabels("아이폰 17 Pro Max 케이스"), ["아이폰 17 프로 맥스"]);
  assert.deepEqual(deviceModelLabels("iPhone16e 강화유리"), ["아이폰 16e"]);
  assert.deepEqual(deviceModelLabels("갤럭시 S25 울트라 필름"), ["갤럭시 S25 울트라"]);
  assert.deepEqual(deviceModelLabels("갤럭시 Z폴드6 필름"), ["갤럭시 Z 폴드6"]);
  assert.deepEqual(deviceModelLabels("액정보호필름 2매"), []);
  assert.equal(groupCandidateKindKey("사생활 보호 강화유리"), "privacy+tempered");
  assert.equal(groupCandidateKindKey("프라이버시 필름"), "privacy");
  assert.equal(groupCandidateKindKey("고투명 하이드로겔"), "clear+hydrogel");
  assert.equal(groupCandidateKindKey("카메라 렌즈 필름"), "camera");
  assert.equal(groupCandidateKindKey("투명 케이스"), "clear+case");
  assert.equal(groupCandidateKindKey("필름"), "");
});
