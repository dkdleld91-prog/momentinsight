import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateGroupTrackingRank,
  forgetOptionColumnMissing,
  GROUP_OPTION_DROPPED_TAIL_PATTERN,
  GROUP_OPTION_UNVERIFIED_TAIL,
  groupOptionSnapshotFields,
  groupOptionSuggestionCounts,
  groupTrackingRankMessage,
  isOptionColumnMissingError,
  normalizeStoredOptionProductIds,
  OPTION_DROPPED_VISIBLE_MAX,
  OPTION_DROPPED_VISIBLE_REASONS,
  OPTION_INPUT_MAX_CHARS,
  OPTION_LOOKUPS_PER_WINDOW_MAX,
  OPTION_PRODUCT_IDS_MAX,
  OPTION_SKIP_REASONS,
  optionColumnRecentlyMissing,
  optionStoreCheck,
  optionTitleCheck,
  parseOptionProductInput,
  planOptionGroupUpdate,
  primaryMallKeysFromHistory,
  rememberOptionColumnMissing,
  scanVisibleOptionProductIds,
  siblingOptionSuggestions,
  storeAddress,
  storeReferenceMallKeys,
  trackerOptionEligibility,
  trackerOptionProductIds,
} from "./naver-rank-option-group.mjs";
import { findShoppingRankFromWindow } from "./handlers/naver-shopping-rank.mjs";
import {
  buildProductRankSnapshotRecord,
  representativeTrackingRankMessage,
  selectRepresentativeTrackingRank,
} from "./handlers/naver-rank-trackers.mjs";

// 아이쉘 사례(2026-10-21~22): 대표 12356459438(아이폰17) 그룹상품의 대표 옵션이 아이폰16 프로로 바뀌었다.
// 옵션 번호는 가짜 숫자다(실제 번호는 대표 보유 — 지어내지 않는다).
const PRIMARY = "12356459438";
const OPTION_16PRO = "99900000001";
const OPTION_15 = "99900000002";
const PRIMARY_URL = `https://smartstore.naver.com/ishell/products/${PRIMARY}`;
const KEYWORD = "아이폰16 프로 필름";

function tracker(overrides = {}) {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    keyword: KEYWORD,
    product_id: PRIMARY,
    product_url: PRIMARY_URL,
    mall_name: "아이쉘",
    product_title: "아이쉘 아이폰17 저반사 액정보호필름 2매",
    status: "active",
    option_product_ids: [OPTION_16PRO, OPTION_15],
    ...overrides,
  };
}

function organicItem(rank) {
  return {
    organicRank: rank,
    isOrganic: true,
    isAd: false,
    productId: String(1000000000 + rank),
    sellerProductId: String(2000000000 + rank),
    title: `액정 보호 필름 ${rank}`,
    mallName: `판매처 ${rank}`,
    link: `https://smartstore.naver.com/store${rank}/products/${2000000000 + rank}`,
    productType: "2",
  };
}

function card(rank, sellerProductId, overrides = {}) {
  return {
    ...organicItem(rank),
    productId: String(3000000000 + rank),
    sellerProductId,
    title: sellerProductId === PRIMARY
      ? "아이쉘 아이폰17 저반사 액정보호필름 2매"
      : "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
    mallName: "아이쉘",
    link: `https://smartstore.naver.com/main/products/${sellerProductId}`,
    ...overrides,
  };
}

function windowWith(cards = {}, options = {}) {
  const count = options.count || 300;
  const items = Array.from({ length: count }, (_, index) => cards[index + 1] || organicItem(index + 1));
  const extraAds = options.ads || [];
  return {
    keyword: KEYWORD,
    source: "naver_shopping_results_collector",
    rankEvidence: "naver_shopping_organic_list",
    collectionId: "pw-unit-test-collection",
    collectedAt: new Date().toISOString(),
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: null,
    marketTotalStatus: "unavailable",
    checkedCount: count,
    rawCount: count + extraAds.length,
    excludedAdCount: extraAds.length,
    items: [...extraAds, ...items],
  };
}

const HISTORY = [{
  tracker_id: tracker().id,
  checked_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  matched: true,
  item: {
    trackingRankSource: "exact_product",
    isExactTarget: true,
    sellerProductId: PRIMARY,
    mallName: "아이쉘",
    isOrganic: true,
    isAd: false,
  },
}];

async function representative(window, row = tracker()) {
  const lookup = await findShoppingRankFromWindow(window, {
    keyword: row.keyword,
    targetProductId: row.product_id,
    targetUrl: row.product_url,
    targetMallName: row.mall_name,
    targetProductTitle: row.product_title,
    verifiedRelatedCatalogId: "",
    maxRank: 300,
    skipTargetMetadata: true,
  });
  return selectRepresentativeTrackingRank(lookup, row.product_id);
}

async function evaluate(window, overrides = {}) {
  const row = overrides.tracker || tracker();
  const representativeResult = overrides.representativeResult || await representative(window, row);
  const result = await evaluateGroupTrackingRank({
    window,
    tracker: row,
    representativeResult,
    optionProductIds: trackerOptionProductIds(row),
    historyRows: overrides.historyRows ?? HISTORY,
    maxRank: 300,
    selectRepresentative: overrides.selectRepresentative || selectRepresentativeTrackingRank,
    acceptResult: overrides.acceptResult || ((candidate) => candidate?.complete === true
      && Number(candidate.checkedCount) === window.checkedCount),
    ...(overrides.findRankFromWindow ? { findRankFromWindow: overrides.findRankFromWindow } : {}),
  });
  return { representativeResult, result };
}

// 옵션 판정 건너뜀(2026-10-30): 대표 결과의 모든 칸은 그대로이고 optionGroup 건너뜀 표시만 더해진다.
function assertSkippedOption({ result, representativeResult }, reason, extra = {}) {
  assert.notEqual(result, representativeResult);
  const { optionGroup, ...rest } = result;
  assert.deepEqual(rest, representativeResult, "순위·matched·문장 재료는 대표 결과 그대로");
  assert.equal("matchBasis" in result, false);
  assert.equal(optionGroup.skipped, reason);
  assert.deepEqual(Object.keys(optionGroup).filter((key) => !["checkedOptionCount", "skipped", "errorName", "errorMessage"].includes(key)), []);
  if (!("checkedOptionCount" in extra)) assert.ok(optionGroup.checkedOptionCount >= 1);
  for (const [key, value] of Object.entries(extra)) assert.equal(optionGroup[key], value, key);
  if (!("errorName" in extra)) assert.equal("errorName" in optionGroup, false);
  assert.equal(groupTrackingRankMessage(result, "대표 문장"), "대표 문장");
  assert.deepEqual(groupOptionSnapshotFields(result), { optionGroup: { ...optionGroup } });
}

async function quietWarnings(callback) {
  const original = console.warn;
  const lines = [];
  console.warn = (line) => lines.push(String(line));
  try {
    return { value: await callback(), lines };
  } finally {
    console.warn = original;
  }
}

// ───────────────────────── 붙여 넣기 해석 ─────────────────────────

test("A1 섞인 입력: 번호·URL 을 함께 받고 중복 1·거절 2(상품번호 아님, 원부 URL)", () => {
  const parsed = parseOptionProductInput(
    "12345678901, https://smartstore.naver.com/ishell/products/98765432101\n12345678901 abc https://search.shopping.naver.com/catalog/55555555555",
    { primaryProductIds: [PRIMARY], primaryProductUrl: PRIMARY_URL },
  );
  assert.deepEqual(parsed.optionProductIds, ["12345678901", "98765432101"]);
  assert.equal(parsed.inputTokenCount, 5);
  assert.equal(parsed.duplicatesRemoved, 1);
  assert.equal(parsed.primaryRemoved, false);
  assert.deepEqual(parsed.rejected.map((entry) => entry.reason), ["not_product_number", "catalog_url"]);
  assert.equal(parsed.rejected[0].token, "abc");
  assert.equal(parsed.rejected[1].label, "원부(가격비교) URL 은 넣을 수 없습니다");
  assert.equal(parsed.error, "");
  assert.equal(parsed.overLimit, false);
});

test("A2 대표 번호(숫자·URL)는 목록에서 빠지고 primaryRemoved 로 알린다", () => {
  const parsed = parseOptionProductInput(`${PRIMARY}\n${PRIMARY_URL}\n${OPTION_16PRO}`, {
    primaryProductIds: [PRIMARY],
    primaryProductUrl: PRIMARY_URL,
  });
  assert.deepEqual(parsed.optionProductIds, [OPTION_16PRO]);
  assert.equal(parsed.primaryRemoved, true);
  assert.equal(parsed.primaryRemovedCount, 2);
  assert.equal(parsed.duplicatesRemoved, 0);
});

test("A4 다른 스토어 URL 은 거절, 검색 카드 'main' 경로·brand 호스트·모바일 같은 스토어는 받는다", () => {
  const parsed = parseOptionProductInput([
    "https://smartstore.naver.com/otherstore/products/11111111111",
    "https://smartstore.naver.com/main/products/22222222222",
    "https://brand.naver.com/ishellbrand/products/33333333333",
    "https://m.smartstore.naver.com/ishell/products/44444444444?NaPm=ct%3Dabc",
    "smartstore.naver.com/ISHELL/products/55555555555",
  ].join("\n"), { primaryProductIds: [PRIMARY], primaryProductUrl: PRIMARY_URL });
  assert.deepEqual(parsed.rejected.map((entry) => entry.reason), ["other_store"]);
  assert.equal(parsed.rejected[0].label, "다른 스토어 상품 URL 입니다");
  assert.deepEqual(parsed.optionProductIds, ["22222222222", "33333333333", "44444444444", "55555555555"]);
});

test("붙여 넣기 해석 순서: 자리 수·천 단위 쉼표·목록 URL·상품 없는 URL·글자를 각각 다른 이유로 거절", () => {
  const parsed = parseOptionProductInput([
    "1234",
    "123456789012345678901",
    "12,356,459,438",
    "https://search.shopping.naver.com/search/all?query=%ED%95%84%EB%A6%84",
    "https://smartstore.naver.com/ishell",
    "naver.me/xAbCdE",
    "아이폰16",
    "(99900000011)",
    "'99900000012'.",
  ].join("\n"), { primaryProductIds: [PRIMARY], primaryProductUrl: PRIMARY_URL });
  assert.deepEqual(parsed.rejected.map((entry) => entry.reason), [
    "digit_length",
    "digit_length",
    "thousands_separator",
    "unsupported_url",
    "not_product_url",
    "not_product_url",
    "not_product_number",
  ]);
  assert.equal(parsed.rejected[2].label, "천 단위 쉼표를 빼고 숫자만 넣어주세요");
  assert.deepEqual(parsed.optionProductIds, ["99900000011", "99900000012"]);
});

test("A13 4만 자·61칸은 거절하고, ?NaPm 꼬리가 붙은 상품 URL 20개는 받는다", () => {
  assert.equal(parseOptionProductInput("1".repeat(OPTION_INPUT_MAX_CHARS + 1)).error, "too_long");
  const tokens = Array.from({ length: 121 }, (_, index) => String(99900000100 + index)).join(" ");
  assert.equal(parseOptionProductInput(tokens).error, "too_many_tokens");
  const urls = Array.from({ length: 20 }, (_, index) => (
    `https://smartstore.naver.com/ishell/products/${99900000200 + index}?NaPm=ct%3Dlwz0abcd%7Cci%3D${"a".repeat(180)}%7Ctr%3Dslsl`
  )).join("\n");
  assert.ok(urls.length > 4000, "옛 4000자 상한이면 막혔을 길이");
  const parsed = parseOptionProductInput(urls, { primaryProductIds: [PRIMARY], primaryProductUrl: PRIMARY_URL });
  assert.equal(parsed.error, "");
  assert.equal(parsed.optionProductIds.length, 20);
  assert.equal(parsed.overLimit, false);
});

test("A3 중복을 뺀 뒤 51개면 overLimit(자르지 않음) — 상한 50(2026-10-27 대표 요청, 옵션 24개)", () => {
  assert.equal(OPTION_PRODUCT_IDS_MAX, 50);
  const fifty = parseOptionProductInput(Array.from({ length: 50 }, (_, index) => String(99900000300 + index)).join(","));
  assert.equal(fifty.optionProductIds.length, 50);
  assert.equal(fifty.overLimit, false);
  const parsed = parseOptionProductInput(Array.from({ length: 51 }, (_, index) => String(99900000300 + index)).join(","));
  assert.equal(parsed.optionProductIds.length, 51);
  assert.equal(parsed.overLimit, true);
  assert.equal(parsed.limit, OPTION_PRODUCT_IDS_MAX);
});

// ───────────────────────── 저장값 정리·자격 ─────────────────────────

test("저장값 정리: 숫자 5~20자리만, 순서 유지 중복 제거, 대표 번호 제외, 앞에서 50개", () => {
  const many = Array.from({ length: 55 }, (_, index) => String(99900000400 + index));
  assert.deepEqual(
    normalizeStoredOptionProductIds([" 99900000001 ", "99900000001", "abc", null, PRIMARY, "1234", ...many], [PRIMARY]),
    ["99900000001", ...many.slice(0, 49)],
  );
  assert.deepEqual(normalizeStoredOptionProductIds("99900000001"), []);
  assert.deepEqual(normalizeStoredOptionProductIds(undefined), []);
});

test("자격: 원부 추적·대표 번호 없는 옛 행·URL 과 다른 번호는 옵션을 쓰지 않는다", () => {
  assert.equal(trackerOptionEligibility(tracker()).eligible, true);
  const catalog = tracker({ product_id: "55555555555", product_url: "https://search.shopping.naver.com/catalog/55555555555" });
  assert.equal(trackerOptionEligibility(catalog).reason, "catalog_tracker");
  assert.deepEqual(trackerOptionProductIds(catalog), []);
  assert.equal(trackerOptionEligibility(tracker({ product_id: null })).reason, "primary_invalid");
  assert.deepEqual(trackerOptionProductIds(tracker({ product_id: "" })), []);
  assert.equal(trackerOptionEligibility(tracker({ product_id: "11111111111" })).reason, "primary_invalid");
  assert.equal(trackerOptionEligibility(tracker({ product_url: null })).eligible, true);
  assert.deepEqual(trackerOptionProductIds(tracker({ option_product_ids: [PRIMARY, OPTION_16PRO] })), [OPTION_16PRO]);
  // 퍼센트 인코딩이 깨진 옛 URL 행: buildRankTarget 이 URIError 를 던져도 자격 판정은 던지지 않는다(목록 GET 500 방지).
  for (const productUrl of [
    `https://smartstore.naver.com/%E0%A4%A/products/${PRIMARY}`,
    "https://search.shopping.naver.com/catalog/%E0%A4%A",
  ]) {
    const broken = tracker({ product_url: productUrl });
    assert.deepEqual(trackerOptionEligibility(broken), {
      eligible: false,
      reason: "primary_invalid",
      primaryProductId: PRIMARY,
      primaryProductIds: [],
    });
    assert.deepEqual(trackerOptionProductIds(broken), []);
    assert.deepEqual(planOptionGroupUpdate({ tracker: broken, optionProductIds: [OPTION_16PRO] }).siblings, []);
    assert.deepEqual(siblingOptionSuggestions(broken, [tracker()], []), []);
    assert.equal(groupOptionSuggestionCounts([broken, tracker()]).size, 0);
  }
});

// ───────────────────────── 판정 ─────────────────────────

test("T1 실제 사례: 대표 번호가 없고 옵션 카드가 37위면 그 자리를 exact_product 로 기록한다", async () => {
  const window = windowWith({ 37: card(37, OPTION_16PRO) });
  const { representativeResult, result } = await evaluate(window);
  assert.equal(representativeResult.matched, false);
  assert.equal(result.matched, true);
  assert.equal(result.rank, 37);
  assert.equal(result.page, 1);
  assert.equal(result.position, 37);
  assert.equal(result.trackingRankSource, "exact_product");
  assert.equal(result.matchBasis, "group_option");
  assert.equal(result.matchedOptionProductId, OPTION_16PRO);
  assert.equal(result.matchedProductId, OPTION_16PRO);
  assert.equal(result.targetProductId, PRIMARY);
  assert.deepEqual(result.targetProductIds, [PRIMARY, OPTION_16PRO, OPTION_15]);
  assert.equal(result.exactProductRank, null);
  assert.equal(result.relatedCatalogRank, null);
  assert.equal(result.relatedCatalogProductId, null);
  assert.equal(result.item.isExactTarget, true);
  assert.equal(result.item.sellerProductId, OPTION_16PRO);
  assert.equal(result.complete, true);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(result.optionGroup, {
    checkedOptionCount: 2,
    matchedOptionTitle: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
    mallCheck: "matched",
    titleCheck: "ok",
  });
  const message = groupTrackingRankMessage(result, representativeTrackingRankMessage(result));
  assert.equal(
    message,
    `그룹상품 옵션(상품번호 ${OPTION_16PRO})이 오가닉 37위로 잡혀 30일 대표 순위로 기록했습니다. 대표 상품번호는 이번 결과에 없습니다.`,
  );
  const record = buildProductRankSnapshotRecord(tracker(), window.collectedAt, result, message);
  assert.equal(record.rank, 37);
  assert.equal(record.matched, true);
  assert.equal(record.item.trackingRankSource, "exact_product");
  assert.equal(record.item.matchBasis, "group_option");
  assert.equal(record.item.matchedOptionProductId, OPTION_16PRO);
  assert.equal(record.item.relatedCatalogProductId, null);
  assert.equal(record.item.exactProductRank, null);
  assert.equal(record.item.optionGroup.mallCheck, "matched");
  // 감사용 번호 배열을 스냅샷마다 싣지 않는다(egress) — 개수만.
  assert.equal(JSON.stringify(record.item.optionGroup).includes(OPTION_15), false);
});

test("T2·T3 대표 번호가 보이고 옵션 카드가 없으면 대표 결과 객체를 그대로 돌려준다(새 키 0)", async () => {
  const window = windowWith({ 12: card(12, PRIMARY) });
  const { representativeResult, result } = await evaluate(window);
  assert.equal(result, representativeResult);
  assert.equal(result.rank, 12);
  assert.equal("matchBasis" in result, false);
  const message = groupTrackingRankMessage(result, representativeTrackingRankMessage(result));
  assert.equal(message, representativeTrackingRankMessage(representativeResult));
  const withOptions = buildProductRankSnapshotRecord(tracker(), window.collectedAt, result, message);
  const withoutOptions = buildProductRankSnapshotRecord(
    tracker({ option_product_ids: [] }),
    window.collectedAt,
    representativeResult,
    representativeTrackingRankMessage(representativeResult),
  );
  assert.deepEqual(withOptions, withoutOptions);
  assert.deepEqual(groupOptionSnapshotFields(result), {});
});

test("T5 대표·옵션 모두 300개 밖이면 not_found 그대로, 문장만 옵션 개수를 알린다", async () => {
  const window = windowWith();
  const { result } = await evaluate(window);
  assert.equal(result.matched, false);
  assert.equal(result.rank, null);
  assert.equal(result.trackingRankSource, "not_found");
  assert.equal(result.matchBasis, "not_found");
  assert.deepEqual(result.optionGroup, { checkedOptionCount: 2 });
  assert.equal(
    groupTrackingRankMessage(result, representativeTrackingRankMessage(result)),
    "대표 상품번호와 그룹상품 옵션 2개 모두 오가닉 상위 300개 결과에서 찾지 못했습니다.",
  );
  const record = buildProductRankSnapshotRecord(tracker(), window.collectedAt, result, "x");
  assert.equal(record.matched, false);
  assert.equal(record.item.matchBasis, "not_found");
  assert.equal("matchedOptionProductId" in record.item, false);
});

test("T6 [결정 D2 명세 원안] 대표와 옵션이 둘 다 보이면 더 높은 순위, 같으면 대표", async () => {
  // (a) 대표 50위·옵션 20위 → 옵션 20위. 대표가 보였던 순위는 optionGroup 과 문장에 남는다.
  const higherOption = windowWith({ 20: card(20, OPTION_16PRO), 50: card(50, PRIMARY) });
  const a = await evaluate(higherOption);
  assert.equal(a.representativeResult.rank, 50);
  assert.equal(a.result.rank, 20);
  assert.equal(a.result.trackingRankSource, "exact_product");
  assert.equal(a.result.matchBasis, "group_option");
  assert.equal(a.result.matchedOptionProductId, OPTION_16PRO);
  assert.equal(a.result.targetProductId, PRIMARY);
  assert.equal(a.result.exactProductRank, null);
  assert.deepEqual(a.result.optionGroup, {
    checkedOptionCount: 2,
    matchedOptionTitle: "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
    mallCheck: "matched",
    titleCheck: "ok",
    primaryProductRank: 50,
    primaryRankSource: "exact_product",
  });
  assert.equal(
    groupTrackingRankMessage(a.result, representativeTrackingRankMessage(a.result)),
    `그룹상품 옵션(상품번호 ${OPTION_16PRO})이 오가닉 20위로 잡혀 30일 대표 순위로 기록했습니다. 대표 상품번호는 50위입니다.`,
  );
  assert.deepEqual(groupOptionSnapshotFields(a.result).optionGroup.primaryProductRank, 50);

  // (b) 대표 10위·옵션 30위 → 대표 10위 그대로, 다른 카드 확인 키만(문장은 옵션 없는 추적과 같다).
  const lowerOption = windowWith({ 10: card(10, PRIMARY), 30: card(30, OPTION_16PRO) });
  const b = await evaluate(lowerOption);
  assert.equal(b.result.rank, 10);
  assert.equal(b.result.trackingRankSource, "exact_product");
  assert.equal(b.result.matchBasis, "primary");
  assert.deepEqual(b.result.optionGroup, { checkedOptionCount: 2, otherCardCount: 1, otherCardBestRank: 30 });
  assert.equal(
    groupTrackingRankMessage(b.result, representativeTrackingRankMessage(b.result)),
    representativeTrackingRankMessage(b.representativeResult),
  );

  // (c) 같은 카드(대표 번호 카드 링크가 옵션 번호)라 같은 순위 → 대표 결과 객체 그대로.
  const sameCard = windowWith({ 12: card(12, PRIMARY, { link: `https://smartstore.naver.com/main/products/${OPTION_16PRO}` }) });
  assert.deepEqual(scanVisibleOptionProductIds(sameCard, [OPTION_16PRO]), [OPTION_16PRO]);
  const c = await evaluate(sameCard);
  assert.equal(c.representativeResult.rank, 12);
  assert.equal(c.result, c.representativeResult);
});

test("T6 대표가 관련 원부로만 잡혀도 비교한다: 원부 150위 < 옵션 카드 37위면 옵션, 원부 10위면 원부 + 다른 카드 키", async () => {
  const catalog = (rank) => ({
    ...organicItem(rank),
    productId: "55555555555",
    sellerProductId: "",
    catalogId: "55555555555",
    catalogSellerProductIds: [PRIMARY],
    link: "https://search.shopping.naver.com/catalog/55555555555",
    mallName: "네이버",
    title: "아이폰 필름 가격비교",
    productType: "1",
  });
  const optionHigher = windowWith({ 37: card(37, OPTION_16PRO), 150: catalog(150) });
  const a = await evaluate(optionHigher);
  assert.equal(a.representativeResult.trackingRankSource, "related_catalog");
  assert.equal(a.representativeResult.rank, 150);
  assert.equal(a.result.rank, 37);
  assert.equal(a.result.trackingRankSource, "exact_product");
  assert.equal(a.result.matchBasis, "group_option");
  assert.equal(a.result.relatedCatalogRank, null);
  assert.equal(a.result.relatedCatalogProductId, null);
  assert.equal(a.result.optionGroup.primaryProductRank, 150);
  assert.equal(a.result.optionGroup.primaryRankSource, "related_catalog");
  assert.match(
    groupTrackingRankMessage(a.result, ""),
    /오가닉 37위로 잡혀 30일 대표 순위로 기록했습니다\. 대표 상품번호의 관련 원부는 150위입니다\.$/u,
  );

  const catalogHigher = windowWith({ 10: catalog(10), 37: card(37, OPTION_16PRO) });
  const b = await evaluate(catalogHigher);
  assert.equal(b.result.rank, 10);
  assert.equal(b.result.trackingRankSource, "related_catalog");
  assert.equal(b.result.matchBasis, "primary");
  assert.deepEqual(b.result.optionGroup, { checkedOptionCount: 2, otherCardCount: 1, otherCardBestRank: 37 });
  assert.equal(
    groupTrackingRankMessage(b.result, representativeTrackingRankMessage(b.result)),
    representativeTrackingRankMessage(b.representativeResult),
  );
});

test("T7 원부 규칙 그대로: 대표의 관련 원부 15위가 남고, 원부 판매자 목록에만 있는 옵션은 치지 않는다", async () => {
  const catalog = (rank, sellerIds) => ({
    ...organicItem(rank),
    productId: "55555555555",
    sellerProductId: "",
    catalogId: "55555555555",
    catalogSellerProductIds: sellerIds,
    link: "https://search.shopping.naver.com/catalog/55555555555",
    mallName: "네이버",
    title: "아이폰 필름 가격비교",
    productType: "1",
  });
  const primaryParent = windowWith({ 15: catalog(15, [PRIMARY]), 40: card(40, OPTION_16PRO) });
  const a = await evaluate(primaryParent);
  assert.equal(a.representativeResult.trackingRankSource, "related_catalog");
  assert.equal(a.result.rank, 15);
  assert.equal(a.result.trackingRankSource, "related_catalog");
  assert.equal(a.result.relatedCatalogProductId, a.representativeResult.relatedCatalogProductId);
  assert.equal(a.result.matchBasis, "primary");
  assert.deepEqual(a.result.optionGroup, { checkedOptionCount: 2, otherCardCount: 1, otherCardBestRank: 40 });
  const { matchBasis: _basis, optionGroup: _group, ...rest } = a.result;
  assert.deepEqual(rest, a.representativeResult, "원부 결과는 확인 키 말고 그대로");

  const optionParentOnly = windowWith({ 15: catalog(15, [OPTION_16PRO]) });
  const b = await evaluate(optionParentOnly);
  assert.equal(b.result.matched, false);
  assert.equal(b.result.matchBasis, "not_found");
  assert.deepEqual(scanVisibleOptionProductIds(optionParentOnly, [OPTION_16PRO]), []);
});

test("T8 광고 카드에만 있는 옵션 번호는 치지 않는다(이중 방어)", async () => {
  const ad = { ...card(0, OPTION_16PRO), organicRank: undefined, isAd: true, isOrganic: false, adId: "ad-1" };
  const window = windowWith({}, { ads: [ad] });
  assert.deepEqual(scanVisibleOptionProductIds(window, [OPTION_16PRO]), []);
  const { result } = await evaluate(window);
  assert.equal(result.matched, false);
  assert.equal(result.matchBasis, "not_found");
});

test("T9 다른 스토어: 대표가 정확 상품으로 잡혔던 스토어와 이름이 다르면 순위에 넣지 않고 문장에 남긴다", async () => {
  const window = windowWith({ 37: card(37, OPTION_16PRO, { mallName: "다른몰" }) });
  const { result } = await evaluate(window);
  assert.equal(result.matched, false);
  assert.equal(result.matchBasis, "not_found");
  assert.deepEqual(result.optionGroup, { checkedOptionCount: 2, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO] });
  assert.deepEqual(result.optionMallMismatchProductIds, [OPTION_16PRO]);
  assert.match(
    groupTrackingRankMessage(result, ""),
    new RegExp(`다른 스토어로 보여 뺀 옵션: ${OPTION_16PRO}\\.$`, "u"),
  );
  // 스냅샷 item 에는 넣은 번호 전체(OPTION_15 포함) 대신 다른 스토어로 뺀 번호만 남는다(규칙 E').
  const fields = groupOptionSnapshotFields(result);
  assert.deepEqual(fields, {
    matchBasis: "not_found",
    optionGroup: { checkedOptionCount: 2, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO] },
  });
  assert.equal(JSON.stringify(fields).includes(OPTION_15), false);
});

test("T9 다른 스토어: 기록이 없어도 카드 링크의 스토어 주소가 추적 URL 과 다르면 뺀다", async () => {
  const window = windowWith({
    37: card(37, OPTION_16PRO, { link: `https://smartstore.naver.com/otherstore/products/${OPTION_16PRO}` }),
  });
  const { result } = await evaluate(window, { historyRows: [] });
  assert.equal(result.matched, false);
  assert.equal(result.optionGroup.mallMismatchCount, 1);
});

test("T9b 스토어를 확인하지 못하면(기준 이름 없음·링크 main) 그대로 순위로 겨루고 unverified·문장 꼬리로 남긴다", async () => {
  const window = windowWith({ 37: card(37, OPTION_16PRO) });
  const { result } = await evaluate(window, { historyRows: [], tracker: tracker({ mall_name: null }) });
  assert.equal(result.matchBasis, "group_option");
  assert.equal(result.optionGroup.mallCheck, "unverified");
  // 확인 안 됨 옵션이 최종 순위로 쓰였을 때만 꼬리(규칙 D'). 기준이 없었는지 카드 이름이 없었는지는 단정하지 않는다.
  assert.equal(GROUP_OPTION_UNVERIFIED_TAIL, " 스토어를 확인하지 못해 확인 없이 기록했습니다.");
  assert.equal(
    groupTrackingRankMessage(result, ""),
    `그룹상품 옵션(상품번호 ${OPTION_16PRO})이 오가닉 37위로 잡혀 30일 대표 순위로 기록했습니다. 대표 상품번호는 이번 결과에 없습니다. 스토어를 확인하지 못해 확인 없이 기록했습니다.`,
  );
  // 스토어가 확인된 옵션 문장에는 꼬리가 없다(T1 과 같은 문장).
  const verified = await evaluate(window);
  assert.equal(verified.result.optionGroup.mallCheck, "matched");
  assert.doesNotMatch(groupTrackingRankMessage(verified.result, ""), /스토어를 확인하지 못해/u);
});

test("[규칙 A] 스토어 주소: 스마트스토어·브랜드스토어(모바일 포함)만, 검색 카드 'main' 경로는 주소가 아니다", () => {
  assert.deepEqual(storeAddress(`https://smartstore.naver.com/ISHELL/products/${OPTION_16PRO}?NaPm=ct%3Dabc`), { kind: "smartstore", slug: "ishell" });
  assert.deepEqual(storeAddress(`m.smartstore.naver.com/ishell/products/${OPTION_16PRO}`), { kind: "smartstore", slug: "ishell" });
  assert.deepEqual(storeAddress("https://brand.naver.com/lav/products/5145848584"), { kind: "brand", slug: "lav" });
  assert.deepEqual(storeAddress("https://m.brand.naver.com/lav/products/5145848584"), { kind: "brand", slug: "lav" });
  for (const value of [
    `https://smartstore.naver.com/main/products/${OPTION_16PRO}`,
    "https://brand.naver.com/main/products/5145848584",
    "https://search.shopping.naver.com/catalog/55555555555",
    "https://shopping.naver.com/window-products/1234567890",
    "",
    null,
    "http://[",
  ]) {
    assert.equal(storeAddress(value), null, String(value));
  }
  const check = (cardLink, cardMallName, references = ["아이쉘"]) => optionStoreCheck({
    cardMallName,
    cardLinks: [cardLink, `https://smartstore.naver.com/main/products/${OPTION_16PRO}`],
    referenceMallKeys: new Set(references),
    trackerProductUrl: PRIMARY_URL,
  });
  // 둘 다 주소가 있으면 주소만 본다(이름은 보지 않음).
  assert.equal(check(`https://smartstore.naver.com/ishell/products/${OPTION_16PRO}`, "다른몰"), "matched");
  assert.equal(check(`https://m.smartstore.naver.com/ISHELL/products/${OPTION_16PRO}`, ""), "matched");
  assert.equal(check(`https://smartstore.naver.com/otherstore/products/${OPTION_16PRO}`, "아이쉘"), "mismatch");
  assert.equal(check(`https://smartstore.naver.com/otherstore/products/${OPTION_16PRO}`, "", []), "mismatch");
  // 종류가 다른 주소(스마트스토어 추적 ↔ 브랜드스토어 카드)끼리는 비교하지 않고 이름으로 간다.
  assert.equal(check(`https://brand.naver.com/ishellbrand/products/${OPTION_16PRO}`, "아이쉘"), "matched");
  assert.equal(check(`https://brand.naver.com/ishellbrand/products/${OPTION_16PRO}`, "다른몰"), "mismatch");
  // 브랜드스토어 추적은 브랜드스토어 카드 주소와 비교한다.
  const brandCheck = (cardLink) => optionStoreCheck({
    cardMallName: "아이쉘",
    cardLinks: [cardLink],
    referenceMallKeys: new Set(["아이쉘"]),
    trackerProductUrl: "https://brand.naver.com/ishellbrand/products/12356459438",
  });
  assert.equal(brandCheck(`https://brand.naver.com/ishellbrand/products/${OPTION_16PRO}`), "matched");
  assert.equal(brandCheck(`https://brand.naver.com/other/products/${OPTION_16PRO}`), "mismatch");
});

test("[규칙 B] 기준 이름 = 지난 30일 대표 정확 기록의 스토어 이름, 없으면 추적 mall_name", () => {
  assert.deepEqual([...storeReferenceMallKeys(HISTORY, [PRIMARY], "다른이름")], ["아이쉘"], "기록이 있으면 기록이 기준");
  assert.deepEqual([...storeReferenceMallKeys([], [PRIMARY], " 아이 쉘 ")], ["아이쉘"], "기록이 없으면 추적 mall_name(첫 커밋 때 자동으로 채워진 값)");
  const optionRow = { matched: true, item: { ...HISTORY[0].item, matchBasis: "group_option", mallName: "다른몰" } };
  const catalogRow = { matched: true, item: { ...HISTORY[0].item, trackingRankSource: "related_catalog", mallName: "네이버" } };
  assert.deepEqual([...primaryMallKeysFromHistory([optionRow, catalogRow], [PRIMARY])], [], "옵션·원부 행은 대표 정확 기록이 아니다");
  assert.deepEqual([...storeReferenceMallKeys([optionRow, catalogRow], [PRIMARY], "아이쉘")], ["아이쉘"], "그럴 때도 추적 mall_name");
  assert.deepEqual([...storeReferenceMallKeys([], [PRIMARY], "")], []);
  assert.deepEqual([...storeReferenceMallKeys([], [PRIMARY], null)], []);
  // 원부 카드에서 온 값일 수 있는 이름은 기준으로 쓰지 않는다(5차 수정, 판별 가능한 범위).
  // (1) 원부 카드 표시 이름 '네이버' — 추적 mall_name 이든 정확 상품 기록이든.
  assert.deepEqual([...storeReferenceMallKeys([], [PRIMARY], "네이버")], [], "'네이버' mall_name 은 원부 카드 이름일 수 있다");
  const naverExactRow = { matched: true, item: { ...HISTORY[0].item, mallName: "네이버" } };
  assert.deepEqual([...primaryMallKeysFromHistory([naverExactRow], [PRIMARY])], []);
  // (2) 정확 상품으로 기록됐어도 기록된 카드가 원부 카드(원부형 상품 형태·/catalog/ 주소·관련 원부 표시)면 쓰지 않는다.
  for (const catalogLike of [
    { productType: "1" },
    { link: "https://search.shopping.naver.com/catalog/55555555555" },
    { isPriceCompareCatalog: true },
    { isRelatedCatalog: true },
  ]) {
    const row = { matched: true, item: { ...HISTORY[0].item, mallName: "최저가몰", ...catalogLike } };
    assert.deepEqual([...primaryMallKeysFromHistory([row], [PRIMARY])], [], JSON.stringify(catalogLike));
  }
  // (3) 추적 mall_name 이 지난 기록의 원부 행 이름이나 이번 창 대표 결과의 원부 카드 이름과 같으면 쓰지 않는다
  //     (커밋 RPC 가 빈 mall_name 을 첫 결과 카드 이름으로 채우므로, 원부로 잡힌 첫 결과면 원부 카드 이름이 들어간다).
  const lowestMallCatalogRow = { matched: true, item: { trackingRankSource: "related_catalog", mallName: "최저가몰", isOrganic: true, isAd: false } };
  assert.deepEqual([...storeReferenceMallKeys([lowestMallCatalogRow], [PRIMARY], "최저가 몰")], []);
  const currentCatalog = { trackingRankSource: "related_catalog", item: { isRelatedCatalog: true, mallName: "최저가몰" } };
  assert.deepEqual([...storeReferenceMallKeys([], [PRIMARY], "최저가몰", { representativeResult: currentCatalog })], []);
  assert.deepEqual([...storeReferenceMallKeys([lowestMallCatalogRow], [PRIMARY], "아이쉘")], ["아이쉘"], "다른 이름이면 그대로 기준");
  // (4) 판별 못 하는 것: 원부 카드 이름('네이버' 아님)으로 채워졌어도 지난 기록·이번 창에 그 원부 카드가 없으면 구별할
  //     수 없어 그대로 기준으로 쓴다(알려진 한계 — DECISIONS 5차 수정 '남는 위험').
  assert.deepEqual([...storeReferenceMallKeys([], [PRIMARY], "최저가몰")], ["최저가몰"]);
  // 이름 비교(주소가 한쪽이라도 없을 때).
  const byName = (cardMallName, references) => optionStoreCheck({
    cardMallName,
    cardLinks: [`https://smartstore.naver.com/main/products/${OPTION_16PRO}`],
    referenceMallKeys: new Set(references),
    trackerProductUrl: PRIMARY_URL,
  });
  assert.equal(byName("아이 쉘", ["아이쉘"]), "matched");
  assert.equal(byName("ISHELL", ["ishell"]), "matched");
  assert.equal(byName("다른몰", ["아이쉘"]), "mismatch");
  assert.equal(byName("", ["아이쉘"]), "unverified");
  assert.equal(byName("아이쉘", []), "unverified");
  // 추적 URL 에 스토어 주소가 없어도(번호만 있는 옛 추적 등) 카드 주소만으로는 정하지 않고 이름을 본다.
  assert.equal(optionStoreCheck({
    cardMallName: "아이쉘",
    cardLinks: [`https://smartstore.naver.com/otherstore/products/${OPTION_16PRO}`],
    referenceMallKeys: new Set(["아이쉘"]),
    trackerProductUrl: "",
  }), "matched");
});

// 규칙 표(지휘 결정 2026-10-23, 규칙 C'): 스토어 주소(같음/다름/없음) × 스토어 이름(같음/다름/없음) × 대표(보임/안 보임/원부).
// 옵션 카드는 언제나 20위, 대표 정확 상품은 50위, 대표 원부는 150위다. 기준 이름은 두 가지 출처로 모두 돌려 같은
// 결과인지 본다 — (i) 지난 30일 대표 정확 기록 '아이쉘' + 추적 mall_name 빈 값 (ii) 기록 없음(첫 확인) + 추적 mall_name '아이쉘'.
test("[규칙 표] 주소 × 이름 × 대표 27칸: 다른 스토어만 빼고, 확인됨·확인 안 됨은 대표와 똑같이 더 높은 순위", async () => {
  const catalogCard = {
    ...organicItem(150),
    productId: "55555555555",
    sellerProductId: "",
    catalogId: "55555555555",
    catalogSellerProductIds: [PRIMARY],
    link: "https://search.shopping.naver.com/catalog/55555555555",
    mallName: "네이버",
    title: "아이폰 필름 가격비교",
    productType: "1",
  };
  const ADDRESS = {
    same: `https://smartstore.naver.com/ishell/products/${OPTION_16PRO}`,
    different: `https://smartstore.naver.com/otherstore/products/${OPTION_16PRO}`,
    none: `https://smartstore.naver.com/main/products/${OPTION_16PRO}`,
  };
  const NAME = { same: "아이쉘", different: "다른몰", none: "" };
  const PRIMARY_CARD = { visible: { 50: card(50, PRIMARY) }, absent: {}, catalog: { 150: catalogCard } };
  const expectedCheck = (address, name) => {
    if (address === "same") return "matched";
    if (address === "different") return "mismatch";
    return { same: "matched", different: "mismatch", none: "unverified" }[name];
  };
  const REFERENCE_SOURCES = [
    { label: "기록 기준", historyRows: HISTORY, tracker: tracker({ mall_name: "" }) },
    { label: "첫 확인·추적 mall_name 기준", historyRows: [], tracker: tracker({ mall_name: "아이쉘" }) },
  ];
  let rows = 0;
  for (const address of Object.keys(ADDRESS)) {
    for (const name of Object.keys(NAME)) {
      for (const primary of Object.keys(PRIMARY_CARD)) {
        const label = `주소 ${address} · 이름 ${name} · 대표 ${primary}`;
        const window = windowWith({
          20: card(20, OPTION_16PRO, { link: ADDRESS[address], mallName: NAME[name] }),
          ...PRIMARY_CARD[primary],
        });
        const outcomes = [];
        for (const source of REFERENCE_SOURCES) {
          // eslint-disable-next-line no-await-in-loop
          const { representativeResult, result } = await evaluate(window, { historyRows: source.historyRows, tracker: source.tracker });
          const message = groupTrackingRankMessage(result, representativeTrackingRankMessage(result));
          const representativeMessage = representativeTrackingRankMessage(representativeResult);
          const check = expectedCheck(address, name);
          const at = `${label} (${source.label})`;
          if (check !== "mismatch") {
            // 확인됨·확인 안 됨: 대표가 보이든 원부든 없든 더 높은 옵션 20위(규칙 C').
            assert.equal(result.rank, 20, at);
            assert.equal(result.matchBasis, "group_option", at);
            assert.equal(result.optionGroup.mallCheck, check, at);
            assert.equal(result.trackingRankSource, "exact_product", at);
            const primaryTail = { visible: " 대표 상품번호는 50위입니다.", absent: " 대표 상품번호는 이번 결과에 없습니다.", catalog: " 대표 상품번호의 관련 원부는 150위입니다." }[primary];
            const unverifiedTail = check === "unverified" ? GROUP_OPTION_UNVERIFIED_TAIL : "";
            assert.equal(message, `그룹상품 옵션(상품번호 ${OPTION_16PRO})이 오가닉 20위로 잡혀 30일 대표 순위로 기록했습니다.${primaryTail}${unverifiedTail}`, at);
            if (primary === "absent") assert.equal("primaryProductRank" in result.optionGroup, false, at);
            else assert.equal(result.optionGroup.primaryProductRank, primary === "visible" ? 50 : 150, at);
          } else if (primary === "absent") {
            // 다른 스토어 + 대표 없음: 순위 없음, 뺀 번호는 문장과 스냅샷 키에 남는다.
            assert.equal(result.matched, false, at);
            assert.equal(result.matchBasis, "not_found", at);
            assert.deepEqual(result.optionGroup, { checkedOptionCount: 2, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO] }, at);
            assert.equal(message, `대표 상품번호와 그룹상품 옵션 2개 모두 오가닉 상위 300개 결과에서 찾지 못했습니다. 다른 스토어로 보여 뺀 옵션: ${OPTION_16PRO}.`, at);
          } else {
            // 다른 스토어 + 대표 보임(정확·원부): 대표 순위 그대로, 문장도 대표 그대로(광고주 화면에 안 나감).
            // 뺀 번호는 흔적 키로만 남는다(규칙 E').
            assert.equal(result.rank, primary === "visible" ? 50 : 150, at);
            assert.equal(result.trackingRankSource, representativeResult.trackingRankSource, at);
            assert.equal(result.matchBasis, "primary", at);
            assert.deepEqual(result.optionGroup, { checkedOptionCount: 2, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO] }, at);
            assert.equal(message, representativeMessage, at);
            const { matchBasis: _basis, optionGroup: _group, optionMallMismatchProductIds: _ids, ...rest } = result;
            assert.deepEqual(rest, representativeResult, `${at}: 흔적 키 말고는 대표 결과 그대로`);
          }
          // 꼬리는 확인 안 됨 옵션이 최종 순위로 쓰였을 때만(대표가 보였든 안 보였든, 규칙 D').
          assert.equal(message.includes(GROUP_OPTION_UNVERIFIED_TAIL.trim()), check === "unverified", at);
          outcomes.push(JSON.stringify({ rank: result.rank, matchBasis: result.matchBasis ?? null, optionGroup: result.optionGroup ?? null, message }));
        }
        // 기준 이름의 출처(지난 기록·첫 확인의 추적 mall_name)가 달라도 결과가 같다(튀지 않음).
        assert.equal(outcomes[0], outcomes[1], label);
        rows += 1;
      }
    }
  }
  assert.equal(rows, 27);
});

test("[규칙 C'] 기준 이름이 아예 없으면(기록 없음·추적 mall_name 빈 값) 주소 없는 카드는 확인 안 됨이지만 대표와 똑같이 겨룬다", async () => {
  const none = { historyRows: [], tracker: tracker({ mall_name: null }) };
  const sameName = card(20, OPTION_16PRO, { mallName: "아이쉘" });
  // 대표 50위가 보여도 확인 안 됨 옵션 20위가 더 높으면 20위(3차 재검사 결함 1·3 — 예전에는 대표 50위로 덮었다).
  const visible = await evaluate(windowWith({ 20: sameName, 50: card(50, PRIMARY) }), none);
  assert.equal(visible.result.rank, 20);
  assert.equal(visible.result.matchBasis, "group_option");
  assert.equal(visible.result.optionGroup.mallCheck, "unverified");
  assert.equal(visible.result.optionGroup.primaryProductRank, 50);
  assert.equal("unverifiedHigherRank" in visible.result.optionGroup, false, "없어진 키");
  assert.equal(
    groupTrackingRankMessage(visible.result, ""),
    `그룹상품 옵션(상품번호 ${OPTION_16PRO})이 오가닉 20위로 잡혀 30일 대표 순위로 기록했습니다. 대표 상품번호는 50위입니다.${GROUP_OPTION_UNVERIFIED_TAIL}`,
  );
  const absent = await evaluate(windowWith({ 20: sameName }), none);
  assert.equal(absent.result.rank, 20);
  assert.equal(absent.result.optionGroup.mallCheck, "unverified");
  assert.ok(groupTrackingRankMessage(absent.result, "").endsWith(GROUP_OPTION_UNVERIFIED_TAIL));
  // 주소가 있으면 기준 이름이 없어도 주소로 정한다.
  const byAddress = await evaluate(windowWith({
    20: card(20, OPTION_16PRO, { link: `https://smartstore.naver.com/ishell/products/${OPTION_16PRO}`, mallName: "" }),
    50: card(50, PRIMARY),
  }), none);
  assert.equal(byAddress.result.rank, 20);
  assert.equal(byAddress.result.optionGroup.mallCheck, "matched");
  assert.doesNotMatch(groupTrackingRankMessage(byAddress.result, ""), /스토어를 확인하지 못해/u);
  // 확인 안 됨 20위·확인됨 30위·대표 50위: 가장 높은 20위(확인 안 됨)를 쓰고 꼬리를 붙인다.
  const mixed = await evaluate(windowWith({
    20: card(20, OPTION_16PRO, { mallName: "다른몰" }),
    30: card(30, OPTION_15, { link: `https://smartstore.naver.com/ishell/products/${OPTION_15}` }),
    50: card(50, PRIMARY),
  }), none);
  assert.equal(mixed.result.rank, 20);
  assert.equal(mixed.result.matchedOptionProductId, OPTION_16PRO);
  assert.equal(mixed.result.optionGroup.mallCheck, "unverified");
  assert.equal(mixed.result.optionGroup.cardCount, 2);
  assert.equal(mixed.result.optionGroup.primaryProductRank, 50);
  assert.ok(groupTrackingRankMessage(mixed.result, "").endsWith(GROUP_OPTION_UNVERIFIED_TAIL));
  // 확인 못 한 옵션이 대표보다 낮으면 대표 그대로 + 다른 카드 확인 키만.
  const lower = await evaluate(windowWith({ 10: card(10, PRIMARY), 30: card(30, OPTION_16PRO, { mallName: "다른몰" }) }), none);
  assert.equal(lower.result.rank, 10);
  assert.deepEqual(lower.result.optionGroup, { checkedOptionCount: 2, otherCardCount: 1, otherCardBestRank: 30 });
});

test("[규칙 C'] 같은 순위: 대표와 같으면 대표, 옵션끼리 같으면 확인됨 먼저", async () => {
  // 옵션 두 번호가 한 카드(20위)에 함께 붙은 경우: 같은 카드라 같은 순위·같은 확인 결과다(어느 번호가 카드 대표든).
  const shared = (first) => card(20, first, {
    sellerProductIds: [OPTION_16PRO, OPTION_15],
    mallName: "아이쉘",
  });
  for (const first of [OPTION_16PRO, OPTION_15]) {
    // eslint-disable-next-line no-await-in-loop
    const { result } = await evaluate(windowWith({ 20: shared(first) }));
    assert.equal(result.rank, 20, first);
    assert.equal(result.optionGroup.mallCheck, "matched", first);
  }
  // 서로 다른 카드가 같은 순위일 수는 없어, 선택 함수를 직접 갈라 본다: 확인 안 됨 카드가 창 앞쪽이어도 확인됨이 이긴다.
  const tie = windowWith({
    20: card(20, OPTION_16PRO, { mallName: "" }),
    21: card(21, OPTION_15, { mallName: "아이쉘" }),
  });
  const tieRun = await evaluate(tie, {
    selectRepresentative: (lookup, id) => {
      const picked = selectRepresentativeTrackingRank(lookup, id);
      return id === OPTION_15 && picked.matched ? { ...picked, rank: 20, page: 1, position: 20 } : picked;
    },
  });
  assert.equal(tieRun.result.rank, 20);
  assert.equal(tieRun.result.matchedOptionProductId, OPTION_15);
  assert.equal(tieRun.result.optionGroup.mallCheck, "matched");
  // 대표와 같은 순위(같은 카드)면 대표 결과 객체 그대로.
  const samePrimary = windowWith({ 12: card(12, PRIMARY, { sellerProductIds: [PRIMARY, OPTION_16PRO], mallName: "" }) });
  const same = await evaluate(samePrimary, { historyRows: [], tracker: tracker({ mall_name: null }) });
  assert.equal(same.result, same.representativeResult);
});

test("[규칙 C' 튀지 않음 ①] 같은 스토어 그룹 추적은 첫 확인·기준 만료·원부로만 기록된 추적에서도 같은 순위를 고른다(2차 재검사 결함 1·2)", async () => {
  const sameStoreWindow = windowWith({ 20: card(20, OPTION_16PRO), 50: card(50, PRIMARY) });
  const historyRow = (result, message) => {
    const record = buildProductRankSnapshotRecord(tracker(), sameStoreWindow.collectedAt, result, message);
    return { matched: record.matched, item: record.item };
  };
  const run = async (historyRows) => {
    const { result } = await evaluate(sameStoreWindow, { historyRows });
    return { result, message: groupTrackingRankMessage(result, representativeTrackingRankMessage(result)) };
  };
  const day1 = await run([]);
  const day2 = await run([historyRow(day1.result, day1.message)]);
  const optionRows = Array.from({ length: 60 }, () => historyRow(day2.result, day2.message));
  const day32 = await run(optionRows);
  const day33 = await run([historyRow(day32.result, day32.message), ...optionRows.slice(0, 59)]);
  for (const [label, day] of [["첫 확인", day1], ["둘째 날", day2], ["30일 기록이 모두 옵션 행", day32], ["그다음 날", day33]]) {
    assert.equal(day.result.rank, 20, label);
    assert.equal(day.result.matchBasis, "group_option", label);
    assert.equal(day.result.optionGroup.mallCheck, "matched", label);
    assert.equal(day.message, `그룹상품 옵션(상품번호 ${OPTION_16PRO})이 오가닉 20위로 잡혀 30일 대표 순위로 기록했습니다. 대표 상품번호는 50위입니다.`, label);
  }
  // 30일 기록이 모두 원부 행인 추적도 같은 스토어 옵션 37위가 원부 150위를 이긴다.
  const catalog = {
    ...organicItem(150),
    productId: "55555555555",
    sellerProductId: "",
    catalogId: "55555555555",
    catalogSellerProductIds: [PRIMARY],
    link: "https://search.shopping.naver.com/catalog/55555555555",
    mallName: "네이버",
    title: "아이폰 필름 가격비교",
    productType: "1",
  };
  const catalogRows = Array.from({ length: 60 }, () => ({ matched: true, item: { trackingRankSource: "related_catalog", mallName: "네이버", isOrganic: true, isAd: false } }));
  const catalogOnly = await evaluate(windowWith({ 37: card(37, OPTION_16PRO), 150: catalog }), { historyRows: catalogRows });
  assert.equal(catalogOnly.result.rank, 37);
  assert.equal(catalogOnly.result.matchBasis, "group_option");
  assert.equal(catalogOnly.result.optionGroup.mallCheck, "matched");
  assert.equal(catalogOnly.result.optionGroup.primaryRankSource, "related_catalog");
  // 추적 mall_name 이 '아이쉘'이면, 기록이 없거나 옵션 행뿐이어도 대표가 없는 창의 다른몰 옵션은 다른 스토어로 뺀다(결함 3).
  const otherStoreOnly = windowWith({ 20: card(20, OPTION_16PRO, { mallName: "다른몰" }) });
  for (const historyRows of [[], optionRows]) {
    // eslint-disable-next-line no-await-in-loop
    const { result } = await evaluate(otherStoreOnly, { historyRows });
    assert.equal(result.matched, false);
    assert.equal(result.matchBasis, "not_found");
    assert.equal(result.optionGroup.mallMismatchCount, 1);
    assert.deepEqual(result.optionGroup.mallMismatchProductIds, [OPTION_16PRO]);
  }
});

// 여러 날을 실제 커밋처럼 이어 돌린다: 그날 결과로 스냅샷(buildProductRankSnapshotRecord)을 만들어 지난 기록 맨 앞에 넣고
// (최대 60행), 커밋 RPC 처럼 빈 추적 mall_name 을 한 번만 채운다(handlers/naver-shopping-local-worker.mjs 의 p_mall_name 식:
// 옵션으로 잡힌 날은 추적 값 그대로, 아니면 정확 상품 카드 → 결과 카드 이름).
async function simulateDays(startTracker, windows, startHistory = []) {
  let row = { ...startTracker };
  let history = [...startHistory];
  const days = [];
  for (const window of windows) {
    // eslint-disable-next-line no-await-in-loop
    const { representativeResult, result } = await evaluate(window, { tracker: row, historyRows: history });
    const message = groupTrackingRankMessage(result, representativeTrackingRankMessage(result));
    const record = buildProductRankSnapshotRecord(row, window.collectedAt, result, message);
    history = [{ matched: record.matched, item: record.item }, ...history].slice(0, 60);
    const fill = result?.matchBasis === "group_option"
      ? row.mall_name
      : (result?.exactItem?.mallName || result?.item?.mallName || row.mall_name);
    if (!row.mall_name && fill) row = { ...row, mall_name: fill };
    days.push({ representativeResult, result, message, record, mallName: row.mall_name });
  }
  return { days, history, tracker: row };
}

const CATALOG_150 = (mallName = "네이버") => ({
  ...organicItem(150),
  productId: "55555555555",
  sellerProductId: "",
  catalogId: "55555555555",
  catalogSellerProductIds: [PRIMARY],
  link: "https://search.shopping.naver.com/catalog/55555555555",
  mallName,
  title: "아이폰 필름 가격비교",
  productType: "1",
});

test("[규칙 C' 튀지 않음 ②] 대표 보임·안 보임·원부만 보임 날이 번갈아도 같은 옵션이 이기면 같은 순위(3차 재검사 결함 3·4)", async () => {
  const option20 = (overrides = {}) => card(20, OPTION_16PRO, { mallName: "아이쉘", ...overrides });
  const pattern = (option, extra = {}) => [
    windowWith({ 20: option, 50: card(50, PRIMARY), ...extra }),
    windowWith({ 20: option, ...extra }),
    windowWith({ 20: option, 50: card(50, PRIMARY), ...extra }),
    windowWith({ 20: option, 150: CATALOG_150(), ...extra }),
    windowWith({ 20: option, ...extra }),
    windowWith({ 20: option, 50: card(50, PRIMARY), ...extra }),
  ];
  // (가) 화면 등록 추적(mall_name 빈 값) — 대표가 한 번도 이기지 않아 기준 이름이 끝까지 없다: 매일 확인 안 됨 20위.
  //     예전(규칙 C)에는 대표가 보인 날만 50위로 튀었다(결함 3: 20→50→20).
  const blank = await simulateDays(tracker({ mall_name: null }), pattern(option20()), []);
  // (나) 추적 mall_name '아이쉘': 매일 확인됨 20위.
  const named = await simulateDays(tracker({ mall_name: "아이쉘" }), pattern(option20()), []);
  for (const [label, run, check] of [["mall_name 빈 값", blank, "unverified"], ["mall_name 아이쉘", named, "matched"]]) {
    run.days.forEach((day, index) => {
      const at = `${label} ${index + 1}일째`;
      assert.equal(day.result.rank, 20, at);
      assert.equal(day.result.matchBasis, "group_option", at);
      assert.equal(day.result.matchedOptionProductId, OPTION_16PRO, at);
      assert.equal(day.result.optionGroup.mallCheck, check, at);
      assert.equal(day.message.endsWith(GROUP_OPTION_UNVERIFIED_TAIL), check === "unverified", at);
    });
  }
  assert.equal(blank.tracker.mall_name, null, "옵션으로 잡힌 커밋은 mall_name 을 채우지 않는다");

  // (다) 결함 4: 대표가 없을 때 확인됨 30위(OPTION_15, 주소 확인)와 확인 안 됨 20위(OPTION_16PRO, 카드 이름 없음)가 함께
  //     보이는 추적. 대표 50위가 보이는 날과 번갈아도 매일 20위(같은 번호).
  const mixedOption = option20({ mallName: "" });
  const matched30 = { 30: card(30, OPTION_15, { link: `https://smartstore.naver.com/ishell/products/${OPTION_15}` }) };
  const mixed = await simulateDays(tracker({ mall_name: null }), pattern(mixedOption, matched30), []);
  mixed.days.forEach((day, index) => {
    const at = `확인됨 30 + 확인 안 됨 20 ${index + 1}일째`;
    assert.equal(day.result.rank, 20, at);
    assert.equal(day.result.matchedOptionProductId, OPTION_16PRO, at);
    assert.equal(day.result.optionGroup.mallCheck, "unverified", at);
    assert.equal(day.result.optionGroup.cardCount, 2, at);
  });

  // (라) 대표가 더 높은 날(10위)만 대표 10위, 그날 커밋이 mall_name 을 '아이쉘'로 채우고 정확 기록이 생겨 그다음부터는
  //     같은 옵션이 확인됨으로 20위 — 옵션이 이기는 날의 순위는 그대로 20위다.
  const primaryHigh = windowWith({ 10: card(10, PRIMARY), 20: option20() });
  const turn = await simulateDays(tracker({ mall_name: null }), [
    ...pattern(option20()).slice(0, 2),
    primaryHigh,
    ...pattern(option20()).slice(0, 3),
  ], []);
  assert.deepEqual(turn.days.map((day) => day.result.rank), [20, 20, 10, 20, 20, 20]);
  assert.deepEqual(turn.days.map((day) => day.result.optionGroup?.mallCheck ?? null), ["unverified", "unverified", null, "matched", "matched", "matched"]);
  assert.equal(turn.days[2].result.matchBasis, "primary");
  assert.deepEqual(turn.days[2].result.optionGroup, { checkedOptionCount: 2, otherCardCount: 1, otherCardBestRank: 20 });
  assert.equal(turn.tracker.mall_name, "아이쉘");
});

test("[원부 추적] 원부로만 잡혀 온 추적도 같은 스토어 옵션 카드가 원부보다 높으면 옵션 순위(3차 재검사 결함 1)", async () => {
  const optionCard = card(37, OPTION_16PRO, { mallName: "아이쉘" });
  const catalogRows = (mallName) => Array.from({ length: 60 }, () => ({
    matched: true,
    item: { trackingRankSource: "related_catalog", relatedCatalogProductId: "55555555555", catalogId: "55555555555", mallName, isOrganic: true, isAd: false },
  }));
  const cases = [
    { label: "mall_name 빈 값 + 원부 카드 이름 빈 값", mall: null, history: catalogRows(""), catalogName: "" },
    { label: "mall_name '네이버'(원부 카드 이름으로 채워짐) + 원부 행 '네이버'", mall: "네이버", history: catalogRows("네이버"), catalogName: "네이버" },
    { label: "mall_name '네이버' + 지난 기록 없음(만료)", mall: "네이버", history: [], catalogName: "네이버" },
    { label: "mall_name '최저가몰'(원부 카드 이름) + 원부 행 '최저가몰'", mall: "최저가몰", history: catalogRows("최저가몰"), catalogName: "최저가몰" },
    { label: "mall_name '최저가몰' + 지난 기록 없음 + 이번 창 원부 카드 '최저가몰'", mall: "최저가몰", history: [], catalogName: "최저가몰" },
  ];
  for (const item of cases) {
    // eslint-disable-next-line no-await-in-loop
    const { representativeResult, result } = await evaluate(
      windowWith({ 37: optionCard, 150: CATALOG_150(item.catalogName) }),
      { tracker: tracker({ mall_name: item.mall }), historyRows: item.history },
    );
    assert.equal(representativeResult.trackingRankSource, "related_catalog", item.label);
    assert.equal(result.rank, 37, item.label);
    assert.equal(result.trackingRankSource, "exact_product", item.label);
    assert.equal(result.matchBasis, "group_option", item.label);
    // 원부 카드에서 온 이름은 기준으로 쓰지 않아 확인 안 됨(다른 스토어로 빠지지 않음).
    assert.equal(result.optionGroup.mallCheck, "unverified", item.label);
    assert.equal(result.optionGroup.primaryRankSource, "related_catalog", item.label);
    assert.equal(result.optionGroup.primaryProductRank, 150, item.label);
    assert.equal(
      groupTrackingRankMessage(result, ""),
      `그룹상품 옵션(상품번호 ${OPTION_16PRO})이 오가닉 37위로 잡혀 30일 대표 순위로 기록했습니다. 대표 상품번호의 관련 원부는 150위입니다.${GROUP_OPTION_UNVERIFIED_TAIL}`,
      item.label,
    );
  }
  // 실제 흐름: 옵션을 넣기 전 원부로 잡힌 첫 커밋이 mall_name 을 원부 카드 이름으로 채운 뒤 옵션을 넣은 추적.
  const before = await simulateDays(tracker({ mall_name: null, option_product_ids: [] }), [windowWith({ 150: CATALOG_150() })], []);
  assert.equal(before.tracker.mall_name, "네이버", "원부로 잡힌 첫 커밋이 원부 카드 이름으로 채운다(지금 RPC 동작)");
  const after = await simulateDays(
    { ...before.tracker, option_product_ids: [OPTION_16PRO, OPTION_15] },
    [windowWith({ 37: optionCard, 150: CATALOG_150() }), windowWith({ 37: optionCard })],
    before.history,
  );
  assert.deepEqual(after.days.map((day) => day.result.rank), [37, 37]);
  assert.deepEqual(after.days.map((day) => day.result.optionGroup.mallCheck), ["unverified", "unverified"]);
  // 원부가 더 높으면 원부 그대로 + 다른 카드 확인 키(문장은 대표 그대로).
  const catalogHigher = await evaluate(windowWith({ 10: { ...CATALOG_150(), organicRank: 10 }, 37: optionCard }), {
    tracker: tracker({ mall_name: null }), historyRows: catalogRows(""),
  });
  assert.equal(catalogHigher.result.rank, 10);
  assert.equal(catalogHigher.result.trackingRankSource, "related_catalog");
  assert.deepEqual(catalogHigher.result.optionGroup, { checkedOptionCount: 2, otherCardCount: 1, otherCardBestRank: 37 });
  assert.equal(
    groupTrackingRankMessage(catalogHigher.result, representativeTrackingRankMessage(catalogHigher.result)),
    representativeTrackingRankMessage(catalogHigher.representativeResult),
  );
});

test("[흔적 E'] 대표가 이겨도 다른 스토어로 뺀 번호는 스냅샷에 남고, 문장·나머지 칸은 대표 결과 그대로", async () => {
  const otherStore = (rank, id = OPTION_16PRO) => card(rank, id, { mallName: "다른몰" });
  const optionless = (window, representativeResult) => buildProductRankSnapshotRecord(
    tracker({ option_product_ids: [] }),
    window.collectedAt,
    representativeResult,
    representativeTrackingRankMessage(representativeResult),
  );
  const scenes = [
    { label: "대표 50 + 다른 스토어 20", window: windowWith({ 20: otherStore(20), 50: card(50, PRIMARY) }), rank: 50, extra: {} },
    { label: "원부 150 + 다른 스토어 37", window: windowWith({ 37: otherStore(37), 150: CATALOG_150() }), rank: 150, extra: {} },
    {
      label: "대표 50 + 다른 스토어 20 + 같은 스토어 70",
      window: windowWith({ 20: otherStore(20), 50: card(50, PRIMARY), 70: card(70, OPTION_15) }),
      rank: 50,
      extra: { otherCardCount: 1, otherCardBestRank: 70 },
    },
  ];
  for (const scene of scenes) {
    // eslint-disable-next-line no-await-in-loop
    const { representativeResult, result } = await evaluate(scene.window);
    const at = scene.label;
    assert.equal(result.rank, scene.rank, at);
    assert.equal(result.trackingRankSource, representativeResult.trackingRankSource, at);
    assert.equal(result.matchBasis, "primary", at);
    assert.deepEqual(result.optionGroup, { checkedOptionCount: 2, ...scene.extra, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO] }, at);
    const message = groupTrackingRankMessage(result, representativeTrackingRankMessage(result));
    assert.equal(message, representativeTrackingRankMessage(representativeResult), `${at}: 광고주 화면에도 나가는 문장은 대표 그대로`);
    assert.doesNotMatch(message, /다른 스토어/u, at);
    const record = buildProductRankSnapshotRecord(tracker(), scene.window.collectedAt, result, message);
    assert.equal(record.item.matchBasis, "primary", at);
    assert.deepEqual(record.item.optionGroup, result.optionGroup, at);
    // 옵션 없는 추적의 같은 창 기록과 비교: item 의 matchBasis·optionGroup 두 칸만 더해지고 나머지는 바이트 같다.
    const plainRecord = optionless(scene.window, representativeResult);
    const { matchBasis: _basis, optionGroup: _group, ...itemRest } = record.item;
    assert.deepEqual({ ...record, item: itemRest }, plainRecord, at);
  }
  // 다른 스토어로 보인 번호가 대표 카드 자신(같은 자리)이면 흔적을 남기지 않는다 — 대표 결과 객체 그대로.
  const ownCard = windowWith({ 50: card(50, PRIMARY, { sellerProductIds: [PRIMARY, OPTION_16PRO], mallName: "다른몰" }) });
  const own = await evaluate(ownCard);
  assert.equal(own.result, own.representativeResult);
  // 뺀 번호도 다른 카드도 없으면 대표 결과 객체 그대로(옵션 없는 추적과 바이트 같음).
  const clean = await evaluate(windowWith({ 50: card(50, PRIMARY) }));
  assert.equal(clean.result, clean.representativeResult);
  assert.deepEqual(groupOptionSnapshotFields(clean.result), {});
  // 옵션이 이긴 날에도 뺀 번호는 스냅샷 키와 (예전처럼) 문장 꼬리에 남는다.
  const optionWins = await evaluate(windowWith({ 20: otherStore(20), 30: card(30, OPTION_15), 50: card(50, PRIMARY) }));
  assert.equal(optionWins.result.rank, 30);
  assert.deepEqual(optionWins.result.optionGroup.mallMismatchProductIds, [OPTION_16PRO]);
  assert.match(groupTrackingRankMessage(optionWins.result, ""), new RegExp(`다른 스토어로 보여 뺀 옵션: ${OPTION_16PRO}\\.$`, "u"));
});

test("여러 옵션이 서로 다른 카드에서 잡히면 가장 높은 순위 + 확인 키(문장에는 넣지 않음)", async () => {
  const window = windowWith({ 45: card(45, OPTION_15), 30: card(30, OPTION_16PRO) });
  const { result } = await evaluate(window);
  assert.equal(result.rank, 30);
  assert.equal(result.matchedOptionProductId, OPTION_16PRO);
  assert.equal(result.optionGroup.cardCount, 2);
  assert.equal(groupOptionSnapshotFields(result).optionGroup.cardCount, 2);
  assert.doesNotMatch(groupTrackingRankMessage(result, ""), /카드|확인해주세요/u);
});

test("잡힌 카드 제목이 추적 제목과 많이 다르면 경고(차단은 아님)", async () => {
  assert.equal(optionTitleCheck("아이쉘 아이폰17 저반사 액정보호필름 2매", "강아지 사료 대용량 10kg"), "low_overlap");
  assert.equal(optionTitleCheck("", "아무 제목"), "unverified");
  const window = windowWith({ 37: card(37, OPTION_16PRO, { title: "강아지 사료 대용량 10kg" }) });
  const { result } = await evaluate(window);
  assert.equal(result.matchBasis, "group_option");
  assert.equal(result.optionGroup.titleCheck, "low_overlap");
  assert.doesNotMatch(groupTrackingRankMessage(result, ""), /제목|확인해주세요/u);
});

test("T11 옵션 판정은 던지지 않는다: 도우미 예외·원부로 둔갑·최종 검사 실패 모두 대표 결과로 돌아간다", async () => {
  const window = windowWith({ 37: card(37, OPTION_16PRO) });
  const throwingFind = await quietWarnings(() => evaluate(window, {
    findRankFromWindow: async () => { throw new Error("helper exploded"); },
  }));
  assertSkippedOption(throwingFind.value, "evaluation_error", { errorName: "Error", errorMessage: "helper exploded" });
  assert.equal(throwingFind.lines.length, 1);
  assert.match(throwingFind.lines[0], /naver_rank_option_evaluation_failed/u);
  assert.match(throwingFind.lines[0], /"reason":"evaluation_error"/u);
  assert.equal(throwingFind.lines[0].includes(OPTION_16PRO), false);
  assert.equal(throwingFind.lines[0].includes("helper exploded"), false);

  const throwingSelect = await quietWarnings(() => evaluate(window, {
    selectRepresentative: () => { throw new TypeError("select exploded"); },
  }));
  assertSkippedOption(throwingSelect.value, "evaluation_error", { errorName: "TypeError", errorMessage: "select exploded" });

  const throwingAccept = await quietWarnings(() => evaluate(window, {
    acceptResult: () => { throw new Error("accept exploded"); },
  }));
  assertSkippedOption(throwingAccept.value, "evaluation_error", { errorName: "Error", errorMessage: "accept exploded" });

  const forcedCatalog = await evaluate(window, {
    selectRepresentative: (result, id) => ({
      ...selectRepresentativeTrackingRank(result, id),
      trackingRankSource: "related_catalog",
    }),
  });
  assert.notEqual(forcedCatalog.result.matchBasis, "group_option");
  assert.equal(forcedCatalog.result.trackingRankSource, forcedCatalog.representativeResult.trackingRankSource);
  assert.equal(forcedCatalog.result.matched, false);

  const finalRejected = await quietWarnings(() => evaluate(window, {
    acceptResult: (candidate) => candidate?.matchBasis !== "group_option",
  }));
  assertSkippedOption(finalRejected.value, "final_result_rejected");
  assert.equal(finalRejected.lines.length, 1);
  assert.match(finalRejected.lines[0], /final_result_rejected/u);
});

test("T16 옵션 판정은 네이버(외부) 요청을 하지 않는다", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("unexpected_fetch");
  };
  try {
    await evaluate(windowWith({ 37: card(37, OPTION_16PRO) }));
    await evaluate(windowWith());
    await evaluate(windowWith({ 37: card(37, OPTION_16PRO, { mallName: "다른몰" }) }));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("T13 성능: 옵션 20개 추적 100개 × 300개 창 판정이 수 초 안에 끝난다", async () => {
  const window = windowWith();
  const options = Array.from({ length: 20 }, (_, index) => String(99900001000 + index));
  const row = tracker({ option_product_ids: options });
  const representativeResult = await representative(window, row);
  const startedAt = performance.now();
  for (let index = 0; index < 100; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await evaluateGroupTrackingRank({
      window,
      tracker: row,
      representativeResult,
      optionProductIds: options,
      historyRows: HISTORY,
      selectRepresentative: selectRepresentativeTrackingRank,
    });
  }
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1500, `옵션 훑기 ${Math.round(elapsedMs)}ms`);
});

test("T13 성능: 창에 실제로 보이는 번호 20개 × 100추적도 같은 번호는 창마다 정식 판정 1번(기억)", async () => {
  // 같은 스토어 다른 상품 20개가 창에 보이는 경우(잘못 넣은 번호). 반박 검토 전에는 추적마다 20번 = 2,000번 돌았다.
  const visible = Array.from({ length: 20 }, (_, index) => String(99900002000 + index));
  const window = windowWith(Object.fromEntries(visible.map((id, index) => [11 + index * 13, card(11 + index * 13, id)])));
  const rows = Array.from({ length: 100 }, (_, index) => tracker({
    id: `123e4567-e89b-42d3-a456-${String(426614175000 + index).padStart(12, "0")}`,
    option_product_ids: visible,
  }));
  const representativeResult = await representative(window, rows[0]);
  let finderCalls = 0;
  const countingFind = async (...args) => {
    finderCalls += 1;
    return findShoppingRankFromWindow(...args);
  };
  const results = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await evaluateGroupTrackingRank({
      window,
      tracker: row,
      representativeResult,
      optionProductIds: visible,
      historyRows: HISTORY,
      selectRepresentative: selectRepresentativeTrackingRank,
      findRankFromWindow: countingFind,
    }));
  }
  // 시간 대신 정식 판정 횟수로 막는다(반박 검토 전 2,000번, 이 맥 부하 없음 약 6초 → 지금 20번, 약 0.3초).
  // 전체 테스트와 함께 돌면 시간이 크게 흔들려서다. submit 끝까지의 시간 비교는 워커 테스트 T13 에 있다.
  assert.equal(finderCalls, 20, "같은 창·같은 번호는 한 번만 판정한다");
  assert.ok(results.every((result) => result.matchBasis === "group_option" && result.rank === 11));
  assert.ok(results.every((result) => result.optionGroup.cardCount === 20));
});

test("T13 창 하나의 정식 판정 상한: 넘으면 그 추적은 대표 결과 그대로, 경고 1줄, 판정 횟수는 상한 안", async () => {
  const visibleCount = OPTION_LOOKUPS_PER_WINDOW_MAX + 40;
  const allIds = Array.from({ length: visibleCount }, (_, index) => String(99900005000 + index));
  const window = windowWith(Object.fromEntries(allIds.slice(0, 300).map((id, index) => [index + 1, card(index + 1, id, { mallName: "다른몰" })])));
  const representativeResult = await representative(window);
  let finderCalls = 0;
  const countingFind = async (...args) => {
    finderCalls += 1;
    return findShoppingRankFromWindow(...args);
  };
  const { value: results, lines } = await quietWarnings(async () => {
    const out = [];
    for (let index = 0; index * 20 < visibleCount; index += 1) {
      const ids = allIds.slice(index * 20, index * 20 + 20);
      // eslint-disable-next-line no-await-in-loop
      out.push(await evaluateGroupTrackingRank({
        window,
        tracker: tracker({ option_product_ids: ids }),
        representativeResult,
        optionProductIds: ids,
        historyRows: HISTORY,
        selectRepresentative: selectRepresentativeTrackingRank,
        findRankFromWindow: countingFind,
      }));
    }
    return out;
  });
  assert.ok(finderCalls <= OPTION_LOOKUPS_PER_WINDOW_MAX, `판정 ${finderCalls}번`);
  assert.equal(finderCalls, OPTION_LOOKUPS_PER_WINDOW_MAX);
  const fallback = results.slice(OPTION_LOOKUPS_PER_WINDOW_MAX / 20);
  assert.ok(fallback.length > 0);
  // 상한을 넘은 추적은 대표 결과 그대로에 건너뜀 표시만 더한다(2026-10-30).
  for (const result of fallback) assertSkippedOption({ result, representativeResult }, "lookup_budget_exhausted", { checkedOptionCount: 20 });
  assert.equal(lines.length, 1, "경고는 창마다 1줄");
  assert.match(lines[0], /lookup_budget_exhausted/u);
  // 다른 창은 새로 센다.
  const fresh = await evaluate(windowWith({ 37: card(37, OPTION_16PRO) }));
  assert.equal(fresh.result.matchBasis, "group_option");
});

// ───────────────────────── 함께 적용·목록·숨김 ─────────────────────────

test("함께 적용 계획: 같은 대표 번호 추적만(명세 §8.3-4), 같은 그룹 다른 옵션을 대표로 쓴 추적·원부·종료·다른 상품은 제외", () => {
  const self = tracker({ option_product_ids: [OPTION_15] });
  const candidates = [
    self,
    tracker({ id: "a1", keyword: "아이폰17 케이스", option_product_ids: [] }),
    tracker({
      id: "a2",
      keyword: "아이폰16 프로 필름",
      product_id: OPTION_16PRO,
      product_url: `https://smartstore.naver.com/ishell/products/${OPTION_16PRO}`,
      option_product_ids: ["99900000077"],
    }),
    tracker({ id: "a3", status: "completed" }),
    tracker({ id: "a4", product_id: "55555555555", product_url: "https://search.shopping.naver.com/catalog/55555555555" }),
    tracker({ id: "a5", product_id: "88888888888", product_url: "https://smartstore.naver.com/ishell/products/88888888888" }),
  ];
  const plan = planOptionGroupUpdate({
    tracker: self,
    optionProductIds: [OPTION_16PRO],
    candidates,
    applyToSameProduct: true,
  });
  assert.deepEqual(plan.group, [PRIMARY, OPTION_16PRO]);
  assert.deepEqual(plan.selfTarget.before, [OPTION_15]);
  assert.deepEqual(plan.selfTarget.after, [OPTION_16PRO]);
  assert.deepEqual(plan.removedOptionProductIds, [OPTION_15]);
  assert.deepEqual(plan.siblings.map((sibling) => [sibling.id, sibling.relation, sibling.after, sibling.addedCount, sibling.removedCount]), [
    ["a1", "same_primary", [OPTION_16PRO], 1, 0],
  ]);
  // 대표 번호가 다른 추적(a2: 대표 OPTION_16PRO)은 이 그룹 목록에 들어 있어도 덮어쓰지 않는다(명세 §17-3).
  assert.deepEqual(plan.targets.map((target) => target.id), [self.id, "a1"]);
  const wrongPaste = planOptionGroupUpdate({
    tracker: self,
    optionProductIds: ["88888888888", OPTION_16PRO],
    candidates,
    applyToSameProduct: true,
  });
  assert.deepEqual(wrongPaste.targets.map((target) => target.id), [self.id, "a1"], "다른 상품 대표 번호를 붙여 넣어도 그 추적은 그대로");
  const selfOnly = planOptionGroupUpdate({ tracker: self, optionProductIds: [OPTION_16PRO], candidates, applyToSameProduct: false });
  assert.deepEqual(selfOnly.targets.map((target) => target.id), [self.id]);
});

test("가져오기 후보·목록 알림 개수: 같은 그룹 다른 추적에만 있는 번호", () => {
  const a = tracker({ id: "a", option_product_ids: [OPTION_16PRO] });
  const b = tracker({ id: "b", option_product_ids: [] });
  const c = tracker({
    id: "c",
    product_id: OPTION_16PRO,
    product_url: `https://smartstore.naver.com/ishell/products/${OPTION_16PRO}`,
    option_product_ids: [],
  });
  const d = tracker({ id: "d", product_id: "88888888888", product_url: "", option_product_ids: [] });
  const counts = groupOptionSuggestionCounts([a, b, c, d]);
  assert.deepEqual([...counts.entries()].sort(), [["b", 1], ["c", 1]]);
  assert.deepEqual(groupOptionSuggestionCounts([b, d]).size, 0);
  assert.deepEqual(siblingOptionSuggestions(b, [a, c], []), [OPTION_16PRO]);
  assert.deepEqual(siblingOptionSuggestions(c, [a], []), [PRIMARY]);
});

// ───────────────────────── 칸 없음 견디기 ─────────────────────────

test("칸 없음 오류만 옵션 칸 없음으로 본다(그룹 칸·다른 오류와 구분)", () => {
  assert.equal(isOptionColumnMissingError({ code: "42703", message: "column naver_rank_trackers.option_product_ids does not exist" }), true);
  assert.equal(isOptionColumnMissingError({
    code: "PGRST204",
    message: "Could not find the 'option_product_ids' column of 'naver_rank_trackers' in the schema cache",
  }), true);
  assert.equal(isOptionColumnMissingError({ code: "42703", message: "column naver_rank_trackers.group_name does not exist" }), false);
  assert.equal(isOptionColumnMissingError({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(isOptionColumnMissingError(null), false);
  // 코드 없이 문구만 오는 옛 경로는 message 의 칸 없음 문구로 본다.
  assert.equal(isOptionColumnMissingError({ message: "column naver_rank_trackers.option_product_ids does not exist" }), true);
  // CHECK 위반(23514): 제약 이름에 option_product_ids, details 의 상품번호에 '42703' 이 섞여도 칸 없음이 아니다.
  assert.equal(isOptionColumnMissingError({
    code: "23514",
    message: 'new row for relation "naver_rank_trackers" violates check constraint "naver_rank_trackers_option_product_ids_shape"',
    details: "Failing row contains (123e4567-e89b-42d3-a456-426614174000, 99427031234, ...).",
    hint: null,
  }), false);
  // details·hint 에만 칸 이름이 있으면 보지 않는다.
  assert.equal(isOptionColumnMissingError({
    code: "42703",
    message: "column naver_rank_trackers.group_name does not exist",
    details: "option_product_ids",
  }), false);
});

test("칸 없음 기억: 함수 인스턴스당 경고 1줄, 10분 동안 기억, 잊기 가능", async () => {
  forgetOptionColumnMissing();
  const { lines } = await quietWarnings(() => {
    rememberOptionColumnMissing("unit-test", 1_000);
    rememberOptionColumnMissing("unit-test", 2_000);
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /naver_rank_option_column_missing/u);
  assert.equal(optionColumnRecentlyMissing(2_000 + 9 * 60_000), true);
  assert.equal(optionColumnRecentlyMissing(2_000 + 10 * 60_000), false);
  forgetOptionColumnMissing();
  assert.equal(optionColumnRecentlyMissing(3_000), false);
});

test("스냅샷 키는 허용 목록만, matchBasis 가 없으면 빈 객체", () => {
  assert.deepEqual(groupOptionSnapshotFields({}), {});
  assert.deepEqual(groupOptionSnapshotFields({ matchBasis: "weird" }), {});
  assert.deepEqual(groupOptionSnapshotFields({
    matchBasis: "group_option",
    matchedOptionProductId: OPTION_16PRO,
    optionGroup: { checkedOptionCount: 2, mallCheck: "matched", secret: "x", checkedProductIds: [OPTION_15] },
  }), {
    matchBasis: "group_option",
    matchedOptionProductId: OPTION_16PRO,
    optionGroup: { checkedOptionCount: 2, mallCheck: "matched" },
  });
  // 다른 스토어로 뺀 번호 목록은 번호 모양만, 빈 목록은 싣지 않는다. 없어진 키(unverifiedHigherRank)는 허용하지 않는다.
  assert.deepEqual(groupOptionSnapshotFields({
    matchBasis: "primary",
    optionGroup: { checkedOptionCount: 2, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO, "x", ""], unverifiedHigherRank: 20 },
  }), {
    matchBasis: "primary",
    optionGroup: { checkedOptionCount: 2, mallMismatchCount: 1, mallMismatchProductIds: [OPTION_16PRO] },
  });
  assert.deepEqual(groupOptionSnapshotFields({
    matchBasis: "not_found",
    optionGroup: { checkedOptionCount: 2, mallMismatchProductIds: [] },
  }), { matchBasis: "not_found", optionGroup: { checkedOptionCount: 2 } });
});

// ───────────────────────── 옵션 판정 건너뜀 이유(대표 승인 2026-10-30) ─────────────────────────
// 아이쉘(12356459438) 장면: 옵션 목록에 있는 번호(11463197547)가 300개 창 204위에 보이는데 대표 번호는 없다.
// 판정이 건너뛰거나(창당 상한) 실패하면(예외·최종 검사) 대표 결과 그대로 커밋되므로, 각각 이유 코드가 남아야 한다.
const ISHELL_OPTION = "11463197547";
const ishellTracker = (overrides = {}) => tracker({ option_product_ids: [OPTION_16PRO, ISHELL_OPTION, OPTION_15], ...overrides });
const ishellWindow = (cards = {}) => windowWith({ ...cards, 204: card(204, ISHELL_OPTION) });

test("아이쉘 장면: 같은 창에서 정상 판정이면 204위 옵션으로 잡힌다(번호가 보이고 판정 가능한 창)", async () => {
  const { result } = await evaluate(ishellWindow(), { tracker: ishellTracker() });
  assert.equal(result.matchBasis, "group_option");
  assert.equal(result.rank, 204);
  assert.equal(result.matchedOptionProductId, ISHELL_OPTION);
  assert.equal("skipped" in result.optionGroup, false);
});

test("아이쉘 장면: 판정 예외(evaluation_error)·최종 검사 실패(final_result_rejected)·판정 함수 없음(selector_missing)은 각각 이유가 남는다", async () => {
  const window = ishellWindow();
  const row = ishellTracker();
  const thrown = await quietWarnings(() => evaluate(window, {
    tracker: row,
    findRankFromWindow: async () => {
      throw new RangeError(`lookup failed 010-1234-5678 ab.cd@example.com https://a.naver.com/s?query=${encodeURIComponent("아이폰 필름")}&pagingIndex=7 /api/x?token=abc#frag ${"x".repeat(120)}`);
    },
  }));
  assertSkippedOption(thrown.value, "evaluation_error", { checkedOptionCount: 3, errorName: "RangeError" });
  const text = thrown.value.result.optionGroup.errorMessage;
  assert.ok(text.length <= 80, `문구 ${text.length}자`);
  assert.match(text, /^lookup failed \[phone\] \[email\] https:\/\/a\.naver\.com\/s \/api\/x x+…$/u);
  assert.doesNotMatch(text, /query|pagingIndex|token|frag|example\.com|1234-5678/u);
  assert.equal(thrown.lines.length, 1);
  assert.match(thrown.lines[0], /"reason":"evaluation_error"/u);
  assert.match(thrown.lines[0], /"errorType":"RangeError"/u);
  assert.equal(thrown.lines[0].includes("lookup failed"), false, "로그에는 문구·번호를 싣지 않는다");
  assert.equal(thrown.lines[0].includes(ISHELL_OPTION), false);

  // 문자열을 던지면 이름·문구 없이 이유만.
  const thrownString = await quietWarnings(() => evaluate(window, { tracker: row, findRankFromWindow: async () => { throw "boom"; } }));
  assertSkippedOption(thrownString.value, "evaluation_error", { checkedOptionCount: 3 });
  assert.equal("errorMessage" in thrownString.value.result.optionGroup, false);

  const rejected = await quietWarnings(() => evaluate(window, {
    tracker: row,
    acceptResult: (candidate) => candidate?.matchBasis !== "group_option",
  }));
  assertSkippedOption(rejected.value, "final_result_rejected", { checkedOptionCount: 3 });
  assert.match(rejected.lines[0], /"reason":"final_result_rejected"/u);

  const representativeResult = await representative(window, row);
  const noSelector = await quietWarnings(() => evaluateGroupTrackingRank({
    window, tracker: row, representativeResult, optionProductIds: row.option_product_ids, historyRows: HISTORY,
  }));
  assertSkippedOption({ result: noSelector.value, representativeResult }, "selector_missing", { checkedOptionCount: 3 });
  assert.match(noSelector.lines[0], /"reason":"selector_missing"/u);
});

test("아이쉘 장면: 창당 판정 상한을 앞선 추적들이 다 쓰면(lookup_budget_exhausted) 204위 번호를 건너뛴 이유가 추적마다 남고 경고는 1줄", async () => {
  const others = Array.from({ length: OPTION_LOOKUPS_PER_WINDOW_MAX }, (_, index) => String(99900007000 + index));
  const window = ishellWindow(Object.fromEntries(others.map((id, index) => [index + 1, card(index + 1, id, { mallName: "다른몰" })])));
  const { value, lines } = await quietWarnings(async () => {
    for (let index = 0; index < others.length; index += 20) {
      const ids = others.slice(index, index + 20);
      // eslint-disable-next-line no-await-in-loop
      await evaluate(window, { tracker: tracker({ option_product_ids: ids }) });
    }
    const first = await evaluate(window, { tracker: ishellTracker() });
    const second = await evaluate(window, { tracker: ishellTracker({ keyword: `${KEYWORD} 2` }) });
    return { first, second };
  });
  assertSkippedOption(value.first, "lookup_budget_exhausted", { checkedOptionCount: 3 });
  assertSkippedOption(value.second, "lookup_budget_exhausted", { checkedOptionCount: 3 });
  assert.equal(value.first.result.matched, false);
  assert.equal(lines.length, 1, "경고는 창마다 1줄");
  assert.match(lines[0], /"reason":"lookup_budget_exhausted"/u);
});

test("정상 판정·옵션 없음은 결과 객체·스냅샷 키가 예전과 바이트 동일(건너뜀 표시 없음)", async () => {
  // 옵션 없음: 대표 결과 객체 그대로, 스냅샷 키 없음.
  const plainWindow = ishellWindow();
  const noOption = await evaluate(plainWindow, { tracker: tracker({ option_product_ids: [] }) });
  assert.equal(noOption.result, noOption.representativeResult);
  assert.equal(JSON.stringify(groupOptionSnapshotFields(noOption.result)), "{}");
  // 대표가 보이고 옵션 카드가 없음 / 대표가 이기고 다른 카드 없음: 대표 결과 객체 그대로.
  const primaryOnly = await evaluate(windowWith({ 12: card(12, PRIMARY) }), { tracker: ishellTracker() });
  assert.equal(primaryOnly.result, primaryOnly.representativeResult);
  const primaryWins = await evaluate(windowWith({ 12: card(12, PRIMARY) }), {
    tracker: ishellTracker(),
    acceptResult: () => false,
  });
  assert.equal(primaryWins.result, primaryWins.representativeResult);
  assert.equal(JSON.stringify(groupOptionSnapshotFields(primaryWins.result)), "{}");
  // 옵션으로 잡힘·둘 다 없음: 스냅샷 키 글자 그대로.
  const hit = await evaluate(plainWindow, { tracker: ishellTracker() });
  assert.equal(JSON.stringify(groupOptionSnapshotFields(hit.result)),
    `{"matchBasis":"group_option","matchedOptionProductId":"${ISHELL_OPTION}","optionGroup":{"checkedOptionCount":3,"matchedOptionTitle":"아이쉘 아이폰16 프로 저반사 액정보호필름 2매","mallCheck":"matched","titleCheck":"ok"}}`);
  const missing = await evaluate(windowWith(), { tracker: ishellTracker() });
  assert.equal(JSON.stringify(groupOptionSnapshotFields(missing.result)), '{"matchBasis":"not_found","optionGroup":{"checkedOptionCount":3}}');
  for (const run of [hit, missing]) assert.equal(JSON.stringify(run.result.optionGroup).includes("skipped"), false);
});

test("건너뜀 스냅샷 키는 허용 목록·알려진 이유·옵션 1개 이상만, matchBasis 가 있으면 건너뜀 키를 싣지 않는다", () => {
  assert.deepEqual([...OPTION_SKIP_REASONS], ["lookup_budget_exhausted", "evaluation_error", "final_result_rejected", "selector_missing"]);
  assert.deepEqual(groupOptionSnapshotFields({ optionGroup: { checkedOptionCount: 2, skipped: "weird" } }), {});
  assert.deepEqual(groupOptionSnapshotFields({ optionGroup: { checkedOptionCount: 0, skipped: "evaluation_error" } }), {});
  assert.deepEqual(groupOptionSnapshotFields({ optionGroup: [] }), {});
  assert.deepEqual(groupOptionSnapshotFields({
    optionGroup: { checkedOptionCount: 2, skipped: "evaluation_error", errorName: "E".repeat(60), errorMessage: "m".repeat(120), secret: "x", mallCheck: "matched" },
  }), { optionGroup: { checkedOptionCount: 2, skipped: "evaluation_error", errorName: "E".repeat(40), errorMessage: "m".repeat(80) } });
  assert.deepEqual(groupOptionSnapshotFields({
    matchBasis: "not_found",
    optionGroup: { checkedOptionCount: 2, skipped: "evaluation_error", errorName: "Error" },
  }), { matchBasis: "not_found", optionGroup: { checkedOptionCount: 2 } });
});

// ───────────────────────── 창에 보였지만 순위에 못 쓴 번호(2026-10-30 추가) ─────────────────────────
// 아이쉘 4추적(not_found)이 '번호가 창에 보였는데 정식 판정에서 빠진' 경우인지 가리려고 남기는 흔적이다. 실제로 왜
// 빠졌는지는 모른다(그래서 기록한다) — 시험은 정확 상품 아님(not_exact)을 도우미로, 순위 확인 불통과(rejected)를
// acceptResult 로 만든다.
const notExactFinder = async (window, options) => {
  const lookup = await findShoppingRankFromWindow(window, options);
  return {
    ...lookup,
    exactItem: null,
    productExposureItems: (lookup.productExposureItems || []).map((item) => ({ ...item, isExactTarget: false })),
  };
};
const CHECKED_AT = "2026-10-30T03:00:00.000Z";

// 대표 결과와 다른 것은 matchBasis·optionGroup(·문장 재료 optionMallMismatchProductIds)뿐이다. 커밋 행도 item 의 두 키와
// 문장 말고는 대표 결과로 만든 행과 같다.
function assertRankUntouched({ result, representativeResult }, row, basis) {
  const { matchBasis, optionGroup, optionMallMismatchProductIds, ...rest } = result;
  assert.deepEqual(rest, representativeResult, "순위·matched·rank 는 대표 결과 그대로");
  assert.equal(matchBasis, basis);
  const before = buildProductRankSnapshotRecord(row, CHECKED_AT, representativeResult, "문장");
  const after = buildProductRankSnapshotRecord(row, CHECKED_AT, result, "문장");
  const { item: beforeItem, ...beforeRow } = before;
  const { item: afterItem, ...afterRow } = after;
  assert.deepEqual(afterRow, beforeRow, "커밋 인자(item 밖)는 같다");
  const { matchBasis: _basis, optionGroup: _group, ...afterItemRest } = afterItem;
  assert.deepEqual(afterItemRest, beforeItem, "item 도 두 키 말고는 같다");
  return optionGroup;
}

test("아이쉘 장면: 옵션 번호가 204위에 보이지만 정확 상품이 아니면 not_found 문장이 사실대로, droppedVisible 이 남는다", async () => {
  const row = ishellTracker();
  const window = ishellWindow();
  const run = await evaluate(window, { tracker: row, findRankFromWindow: notExactFinder });
  const optionGroup = assertRankUntouched(run, row, "not_found");
  assert.equal(run.result.matched, false);
  assert.equal(run.result.rank, run.representativeResult.rank);
  assert.deepEqual(optionGroup, {
    checkedOptionCount: 3,
    droppedVisibleCount: 1,
    droppedVisible: [{ productId: ISHELL_OPTION, reason: "not_exact" }],
  });
  const message = groupTrackingRankMessage(run.result, representativeTrackingRankMessage(run.result));
  assert.equal(message, "대표 상품번호와 그룹상품 옵션 3개 모두 오가닉 상위 300개 결과에서 순위로 잡지 못했습니다."
    + " 옵션 3개 중 1개는 결과에 보였지만 같은 상품으로 확인되지 않아 순위에 쓰지 않았습니다.");
  // 광고주 화면은 관리자용 꼬리를 뺀 문장(두 화면이 같은 패턴으로 뺀다) — 남는 문장도 사실이다.
  assert.equal(message.replace(GROUP_OPTION_DROPPED_TAIL_PATTERN, ""),
    "대표 상품번호와 그룹상품 옵션 3개 모두 오가닉 상위 300개 결과에서 순위로 잡지 못했습니다.");
  assert.equal(JSON.stringify(groupOptionSnapshotFields(run.result)),
    `{"matchBasis":"not_found","optionGroup":{"checkedOptionCount":3,"droppedVisibleCount":1,"droppedVisible":[{"productId":"${ISHELL_OPTION}","reason":"not_exact"}]}}`);
  // 같은 창을 정상 도우미로 보면 204위 옵션으로 잡힌다(번호가 보이는 장면임을 확인).
  assert.equal((await evaluate(window, { tracker: row })).result.rank, 204);
  // 번호가 창에 없으면 예전 문장 글자 그대로.
  const missing = await evaluate(windowWith(), { tracker: row, findRankFromWindow: notExactFinder });
  assert.equal(groupTrackingRankMessage(missing.result, "대표 문장"), "대표 상품번호와 그룹상품 옵션 3개 모두 오가닉 상위 300개 결과에서 찾지 못했습니다.");
  assert.deepEqual(missing.result.optionGroup, { checkedOptionCount: 3 });
});

test("아이쉘 장면: acceptResult 불통과(rejected)도 남고 문장은 '순위 확인을 통과하지 못해', 대표가 이기면 문장은 대표 그대로", async () => {
  const row = ishellTracker();
  const rejected = await evaluate(ishellWindow(), { tracker: row, acceptResult: () => false });
  assert.deepEqual(assertRankUntouched(rejected, row, "not_found").droppedVisible, [{ productId: ISHELL_OPTION, reason: "rejected" }]);
  assert.equal(groupTrackingRankMessage(rejected.result, "대표 문장"), "대표 상품번호와 그룹상품 옵션 3개 모두 오가닉 상위 300개 결과에서 순위로 잡지 못했습니다."
    + " 옵션 3개 중 1개는 결과에 보였지만 순위 확인을 통과하지 못해 순위에 쓰지 않았습니다.");

  // 대표 12위가 이기고 204위 옵션은 정확 상품 아님: matchBasis 'primary' 흔적만, 순위·문장은 대표 결과 그대로.
  const primaryWindow = ishellWindow({ 12: card(12, PRIMARY) });
  const primary = await evaluate(primaryWindow, { tracker: row, findRankFromWindow: notExactFinder });
  assert.deepEqual(assertRankUntouched(primary, row, "primary"), {
    checkedOptionCount: 3,
    droppedVisibleCount: 1,
    droppedVisible: [{ productId: ISHELL_OPTION, reason: "not_exact" }],
  });
  assert.equal(primary.result.rank, 12);
  assert.equal("optionMallMismatchProductIds" in primary.result, false);
  assert.equal(groupTrackingRankMessage(primary.result, "대표 문장"), "대표 문장");
  // 빠진 번호가 없는 정상 판정(대표가 이기고 다른 카드 없음)은 대표 결과 객체 그대로.
  const clean = await evaluate(windowWith({ 12: card(12, PRIMARY) }), { tracker: row, findRankFromWindow: notExactFinder });
  assert.equal(clean.result, clean.representativeResult);
});

test("창에 보였지만 못 쓴 번호: 목록은 최대 10개·개수는 전체, 이유가 다 확인되지 않거나 섞이면 일반 문구", async () => {
  assert.equal(OPTION_DROPPED_VISIBLE_MAX, 10);
  assert.deepEqual([...OPTION_DROPPED_VISIBLE_REASONS], ["not_exact", "rejected"]);
  const ids = Array.from({ length: 12 }, (_, index) => String(99900009100 + index));
  const row = tracker({ option_product_ids: ids });
  const window = windowWith(Object.fromEntries(ids.map((id, index) => [101 + index, card(101 + index, id)])));
  const many = await evaluate(window, { tracker: row, findRankFromWindow: notExactFinder });
  const group = assertRankUntouched(many, row, "not_found");
  assert.equal(group.droppedVisibleCount, 12);
  assert.deepEqual(group.droppedVisible, ids.slice(0, 10).map((productId) => ({ productId, reason: "not_exact" })));
  assert.match(groupTrackingRankMessage(many.result, ""), / 옵션 12개 중 12개는 결과에 보였지만 순위 확인을 통과하지 못해 순위에 쓰지 않았습니다\.$/u);

  // 하나는 정확 상품 아님, 하나는 순위 확인 불통과.
  const mixedRow = tracker({ option_product_ids: ids.slice(0, 2) });
  const mixed = await evaluate(window, {
    tracker: mixedRow,
    findRankFromWindow: async (win, options) => (options.targetProductId === ids[0] ? notExactFinder(win, options) : findShoppingRankFromWindow(win, options)),
    acceptResult: () => false,
  });
  assert.deepEqual(assertRankUntouched(mixed, mixedRow, "not_found").droppedVisible, [
    { productId: ids[0], reason: "not_exact" },
    { productId: ids[1], reason: "rejected" },
  ]);
  assert.match(groupTrackingRankMessage(mixed.result, ""), /옵션 2개 중 2개는 결과에 보였지만 순위 확인을 통과하지 못해/u);
});

test("창에 보였지만 못 쓴 번호 스냅샷 키: 번호·이유 두 칸만, 알려진 이유·번호 모양만, 최대 10개", () => {
  const entries = [
    { productId: ISHELL_OPTION, reason: "not_exact", title: "x" },
    { productId: "12", reason: "not_exact" },
    { productId: "99900009999", reason: "weird" },
    null,
    ...Array.from({ length: 12 }, (_, index) => ({ productId: String(99900009200 + index), reason: "rejected" })),
  ];
  const fields = groupOptionSnapshotFields({
    matchBasis: "not_found",
    optionGroup: { checkedOptionCount: 3, droppedVisibleCount: 14, droppedVisible: entries },
  });
  assert.equal(fields.optionGroup.droppedVisibleCount, 14);
  assert.equal(fields.optionGroup.droppedVisible.length, 10);
  assert.deepEqual(fields.optionGroup.droppedVisible[0], { productId: ISHELL_OPTION, reason: "not_exact" });
  assert.ok(fields.optionGroup.droppedVisible.slice(1).every((entry) => entry.reason === "rejected"));
  assert.deepEqual(groupOptionSnapshotFields({
    matchBasis: "primary",
    optionGroup: { checkedOptionCount: 3, droppedVisibleCount: 0, droppedVisible: "x" },
  }), { matchBasis: "primary", optionGroup: { checkedOptionCount: 3 } });
  // 건너뜀 표시(matchBasis 없음)에는 싣지 않는다.
  assert.deepEqual(groupOptionSnapshotFields({
    optionGroup: { checkedOptionCount: 3, skipped: "evaluation_error", droppedVisibleCount: 1, droppedVisible: [entries[0]] },
  }), { optionGroup: { checkedOptionCount: 3, skipped: "evaluation_error" } });
});
