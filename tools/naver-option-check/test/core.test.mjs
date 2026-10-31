// 판정 부분(src/core.mjs) 단위 시험. 화면 없이 가짜 페이지 상태 객체만 넣는다. 네이버에는 요청하지 않는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as server from "../../../src/server/naver-rank-option-group.mjs";
import {
  OPTION_PRODUCT_IDS_MAX,
  OPTION_PRODUCT_ID_MAX_DIGITS,
  OPTION_PRODUCT_ID_MIN_DIGITS,
  REASON_CODES,
  findGroupOptions,
  isServerProductId,
  productPageFromUrl,
  reasonFor,
} from "../src/core.mjs";
import {
  DECASA_CURRENT,
  ISHELL_CURRENT,
  ISHELL_OPTION_IDS,
  PARALLEL_CHANNEL_IDS,
  PARALLEL_ORIGINAL_IDS,
  PRIVATE_VALUES,
  groupNestedNameState,
  groupNumberArrayState,
  groupObjectState,
  groupOfSize,
  groupParallelColumnsState,
  membersWithoutCurrentState,
  noGroupState,
  recommendedGroupState,
} from "./fixtures.mjs";

const reasonCodes = (result) => result.reasons.map((reason) => reason.code);
const NUMBER_MASK = "#n";

function assertNoNumbersHandedOut(result) {
  assert.deepEqual(result.items, []);
  assert.equal(result.copyText, "");
  assert.equal(result.optionCount, 0);
  if (result.diag.chosen) assert.deepEqual(result.diag.chosen.ids, []);
}

test("규칙: 자리 수·개수 상한이 서버(naver-rank-option-group.mjs)와 같다", () => {
  assert.equal(OPTION_PRODUCT_IDS_MAX, server.OPTION_PRODUCT_IDS_MAX);
  assert.equal(OPTION_PRODUCT_ID_MIN_DIGITS, server.OPTION_PRODUCT_ID_MIN_DIGITS);
  assert.equal(OPTION_PRODUCT_ID_MAX_DIGITS, server.OPTION_PRODUCT_ID_MAX_DIGITS);
  for (const id of ["1234", "12345", "1".repeat(20), "1".repeat(21), "12a45", ""]) {
    assert.equal(isServerProductId(id), server.isOptionProductId(id), id);
  }
});

test("core.mjs 는 순수 함수만: 화면·주소창·요청·저장소를 만지지 않는다", () => {
  const source = fs.readFileSync(new URL("../src/core.mjs", import.meta.url), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const word of ["document", "window", "navigator", "location", "fetch", "XMLHttpRequest", "localStorage", "import "]) {
    assert.equal(source.includes(word), false, word);
  }
});

test("주소: 스마트스토어·브랜드스토어 상품 페이지만 지금 상품번호를 돌려준다", () => {
  assert.deepEqual(productPageFromUrl(`https://smartstore.naver.com/i_shell/products/${ISHELL_CURRENT}?NaPm=ct%3Dabc`), { store: "i_shell", productId: ISHELL_CURRENT });
  assert.deepEqual(productPageFromUrl(`https://m.smartstore.naver.com/decasa/products/${DECASA_CURRENT}`), { store: "decasa", productId: DECASA_CURRENT });
  assert.deepEqual(productPageFromUrl(`https://brand.naver.com/somebrand/products/${DECASA_CURRENT}#review`), { store: "somebrand", productId: DECASA_CURRENT });
  for (const href of [
    "https://smartstore.naver.com/i_shell",
    `https://smartstore.naver.com.evil.example/i_shell/products/${ISHELL_CURRENT}`,
    `https://evilsmartstore.naver.com/i_shell/products/${ISHELL_CURRENT}`,
    `https://search.shopping.naver.com/catalog/${ISHELL_CURRENT}`,
    `javascript:alert(1)//smartstore.naver.com/a/products/${ISHELL_CURRENT}`,
    "",
    null,
  ]) {
    assert.equal(productPageFromUrl(href), null, String(href));
  }
});

test("그룹 객체 목록: 지금 상품 포함 24개를 고르고, 관련·추천 목록과 회원 정보는 쓰지 않는다", () => {
  const result = findGroupOptions(groupObjectState(), ISHELL_CURRENT);
  assert.equal(result.status, "found");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.items.length, 24);
  assert.equal(result.optionCount, 23);
  assert.deepEqual(result.items.map((item) => item.id), [ISHELL_CURRENT, ...ISHELL_OPTION_IDS]);
  assert.deepEqual(result.items.filter((item) => item.current).map((item) => item.id), [ISHELL_CURRENT]);
  assert.equal(result.items[0].name, "아이폰17 사생활보호");
  assert.equal(result.items[1].name, "옵션 0");
  // 복사 내용: 지금 상품 포함 번호 목록, 한 줄에 하나(주소 형식 아님)
  assert.equal(result.copyText, [ISHELL_CURRENT, ...ISHELL_OPTION_IDS].join("\n"));
  assert.equal(/https?:|\/products\//.test(result.copyText), false);
  assert.equal(result.diag.chosen.path, "STATE.groupProduct.products");
  assert.equal(result.diag.chosen.names.source, "item");
  assert.equal(result.diag.chosen.names.found, 24);
  assert.ok(result.diag.candidates.some((list) => list.path === "STATE.relatedProducts.list" && list.excluded && list.hasCurrent));
});

test("그룹 숫자 목록 + 같은 부모의 이름 목록: 이름을 짝지어 보여 준다", () => {
  const result = findGroupOptions(groupNumberArrayState(), DECASA_CURRENT);
  assert.equal(result.status, "found");
  assert.deepEqual(result.items.map((item) => [item.id, item.name, item.current]), [
    [DECASA_CURRENT, "수건 대표", true],
    ["13744375116", "수건 1", false],
    ["13744387323", "수건 2", false],
    ["13744387324", "수건 3", false],
  ]);
  assert.equal(result.diag.chosen.names.source, "sibling:optionNames");
  // 이름 목록이 없으면 번호만(상태 코드 같은 글자 목록은 이름으로 쓰지 않는다).
  const bare = findGroupOptions(groupNumberArrayState({ withNames: false }), DECASA_CURRENT);
  assert.equal(bare.status, "found");
  assert.deepEqual(bare.items.map((item) => item.name), ["", "", "", ""]);
  assert.equal(bare.diag.chosen.names.source, "none");
  assert.equal(bare.copyText.split("\n").length, 4);
});

test("이름이 항목 안 1~2단계에 있으면 찾고, 스토어 묶음 이름은 쓰지 않는다", () => {
  const result = findGroupOptions(groupNestedNameState(), DECASA_CURRENT);
  assert.equal(result.status, "found");
  assert.deepEqual(result.items.map((item) => item.name), ["화이트", "그레이 세트", ""]);
});

test("추천 구역(그룹 키가 들어 있어도)·관련 상품 목록은 지금 상품이 있고 더 커도 고르지 않는다", () => {
  const result = findGroupOptions(recommendedGroupState(), ISHELL_CURRENT);
  assert.equal(result.status, "found");
  assert.equal(result.diag.chosen.path, "STATE.groupProduct.products");
  assert.equal(result.items.length, 24);
  const recommended = result.diag.candidates.find((list) => list.path === "STATE.recommendGroup.products");
  assert.equal(recommended.excluded, true);
});

test("그룹 표시가 없는 페이지: 못 찾음(추천 목록에 지금 상품이 있어도)", () => {
  const result = findGroupOptions(noGroupState(), DECASA_CURRENT);
  assert.equal(result.status, "not_found");
  assert.deepEqual(reasonCodes(result), ["no_group_list"]);
  assertNoNumbersHandedOut(result);
  assert.equal(result.diag.chosen, null);
});

test("지금 상품이 없는 그룹 목록: 못 찾음(비슷한 목록을 추정해 고르지 않는다)", () => {
  const result = findGroupOptions(membersWithoutCurrentState(), DECASA_CURRENT);
  assert.equal(result.status, "not_found");
  assert.deepEqual(reasonCodes(result), ["group_list_without_current"]);
  assertNoNumbersHandedOut(result);
});

test("거절: 고른 목록에 번호를 알아보지 못한 항목이 1개라도 있으면(80% 규칙 없음)", () => {
  const state = groupObjectState();
  state.groupProduct.products.push({ name: "번호 없는 옵션" });
  const result = findGroupOptions(state, ISHELL_CURRENT);
  assert.equal(result.status, "refused");
  assert.deepEqual(reasonCodes(result), ["unrecognized_items"]);
  assert.equal(result.reasons[0].count, 1);
  assertNoNumbersHandedOut(result);
  // 숫자 목록 안의 빈칸·글자도 같다.
  const numbers = groupNumberArrayState();
  numbers.productGroup.productNos.push("품절");
  numbers.productGroup.optionNames.push("품절 옵션");
  const numbersResult = findGroupOptions(numbers, DECASA_CURRENT);
  assert.equal(numbersResult.status, "refused");
  assert.deepEqual(reasonCodes(numbersResult), ["unrecognized_items"]);
});

test("거절: 지금 상품을 뺀 옵션이 50개 초과(51개)면, 정확히 50개는 통과", () => {
  const atLimit = findGroupOptions(groupOfSize(OPTION_PRODUCT_IDS_MAX + 1), ISHELL_CURRENT);
  assert.equal(atLimit.status, "found");
  assert.equal(atLimit.optionCount, 50);
  assert.equal(atLimit.items.length, 51);
  const over = findGroupOptions(groupOfSize(OPTION_PRODUCT_IDS_MAX + 2), ISHELL_CURRENT);
  assert.equal(over.status, "refused");
  assert.deepEqual(reasonCodes(over), ["too_many"]);
  assert.equal(over.reasons[0].count, 51);
  assertNoNumbersHandedOut(over);
});

test("거절: 숫자형 번호가 Number.MAX_SAFE_INTEGER 를 넘으면(반올림됐을 수 있음), 같은 번호가 글자면 통과", () => {
  const big = groupOfSize(3);
  big.groupProduct.products.push({ productNo: Number.MAX_SAFE_INTEGER + 2, name: "큰 번호" });
  const result = findGroupOptions(big, ISHELL_CURRENT);
  assert.equal(result.status, "refused");
  assert.deepEqual(reasonCodes(result), ["unsafe_number"]);
  assertNoNumbersHandedOut(result);
  const asText = groupOfSize(3);
  asText.groupProduct.products.push({ productNo: "90071992547409930", name: "큰 번호(글자)" });
  const textResult = findGroupOptions(asText, ISHELL_CURRENT);
  assert.equal(textResult.status, "found");
  assert.equal(textResult.items.at(-1).id, "90071992547409930");
});

test("거절: 자리 수가 서버 규칙(5~20자리) 밖인 번호가 있으면", () => {
  for (const odd of ["1234", "1".repeat(21)]) {
    const state = groupOfSize(3);
    state.groupProduct.products.push({ productNo: odd, name: "이상한 번호" });
    const result = findGroupOptions(state, ISHELL_CURRENT);
    assert.equal(result.status, "refused", odd);
    assert.deepEqual(reasonCodes(result), ["digit_length"], odd);
    assertNoNumbersHandedOut(result);
  }
  const edges = groupOfSize(2);
  edges.groupProduct.products.push({ productNo: "12345" }, { productNo: "9".repeat(20) });
  assert.equal(findGroupOptions(edges, ISHELL_CURRENT).status, "found");
});

const longRows = () => ({ rows: Array.from({ length: 5001 }, (_, index) => index) });

function deepChain(owner, levels = 40) {
  let cursor = owner;
  for (let depth = 0; depth < levels; depth += 1) cursor = cursor.next = {};
  return owner;
}

test("거절: 탐색 상한(노드·깊이·긴 목록·목록 수)은 그룹 구역 안에서 걸려도 내주지 않는다", () => {
  const byNodes = findGroupOptions(groupObjectState(), ISHELL_CURRENT, { limits: { nodes: 5 } });
  assert.equal(byNodes.status, "refused");
  assert.ok(reasonCodes(byNodes).includes("traversal_cap"));
  assert.equal(byNodes.diag.cut.nodes, true);
  assertNoNumbersHandedOut(byNodes);

  const deep = groupObjectState();
  deepChain(deep.groupProduct);
  const byDepth = findGroupOptions(deep, ISHELL_CURRENT);
  assert.equal(byDepth.status, "refused");
  assert.deepEqual(reasonCodes(byDepth), ["traversal_cap"]);
  assert.ok(byDepth.diag.cut.depth > 0);
  assertNoNumbersHandedOut(byDepth);

  const long = groupObjectState();
  long.groupProduct.someTable = longRows();
  const byArray = findGroupOptions(long, ISHELL_CURRENT);
  assert.equal(byArray.status, "refused");
  assert.deepEqual(reasonCodes(byArray), ["traversal_cap"]);
  assert.equal(byArray.diag.cut.arrays, 1);

  // 지금 상품이 든 그룹 목록이 목록 수 상한 뒤에 나오면(못 담음) 거절.
  const many = groupObjectState();
  many.groupProduct.productNos = [ISHELL_CURRENT, ...ISHELL_OPTION_IDS];
  const byLists = findGroupOptions(many, ISHELL_CURRENT, { limits: { lists: 1 } });
  assert.equal(byLists.status, "refused");
  assert.deepEqual(reasonCodes(byLists), ["traversal_cap"]);
  assert.ok(byLists.diag.cut.lists >= 1);

  // 그룹 목록을 못 찾았어도 다 못 훑었으면(노드 상한) '못 찾음'이 아니라 거절이다.
  const notFoundButCut = findGroupOptions(noGroupState(), DECASA_CURRENT, { limits: { nodes: 2 } });
  assert.equal(notFoundButCut.status, "refused");
  assert.deepEqual(reasonCodes(notFoundButCut), ["traversal_cap"]);
});

test("거절(H3): 탐색 상한은 그룹 구역 밖(추천 구역 포함)에서 걸려도 거절이다 — 진단에 적기만 하던 완화를 되돌림", () => {
  const deep = deepChain(groupObjectState());
  const byDepth = findGroupOptions(deep, ISHELL_CURRENT);
  assert.equal(byDepth.status, "refused");
  assert.deepEqual(reasonCodes(byDepth), ["traversal_cap"]);
  assert.ok(byDepth.diag.cut.depth > 0);
  assertNoNumbersHandedOut(byDepth);

  const long = groupObjectState();
  long.someTable = longRows();
  const byArray = findGroupOptions(long, ISHELL_CURRENT);
  assert.equal(byArray.status, "refused");
  assert.deepEqual(reasonCodes(byArray), ["traversal_cap"]);
  assert.equal(byArray.diag.cut.arrays, 1);

  const recommended = recommendedGroupState();
  recommended.recommendGroup.table = longRows();
  const byRecommended = findGroupOptions(recommended, ISHELL_CURRENT);
  assert.equal(byRecommended.status, "refused");
  assert.deepEqual(reasonCodes(byRecommended), ["traversal_cap"]);

  // 지금 상품이 든 그룹 밖 목록(관련 상품)이 목록 수 상한에 걸려도 거절.
  const byLists = findGroupOptions(groupObjectState(), ISHELL_CURRENT, { limits: { lists: 1 } });
  assert.equal(byLists.status, "refused");
  assert.deepEqual(reasonCodes(byLists), ["traversal_cap"]);
  assert.equal(byLists.diag.cut.lists, 1);
  assertNoNumbersHandedOut(byLists);

  // 상한에 안 걸린 보통 페이지는 그대로 찾고, 진단의 상한 기록도 비어 있다.
  const clean = findGroupOptions(groupObjectState(), ISHELL_CURRENT);
  assert.equal(clean.status, "found");
  assert.deepEqual(clean.diag.cut, { nodes: false, depth: 0, arrays: 0, lists: 0 });
});

test("그룹 항목마다 작은 숫자 목록이 많아도(50개 × 13개) 지금 상품이 없는 목록은 담지 않아 목록 수 상한에 걸리지 않는다", () => {
  const state = groupOfSize(50);
  state.groupProduct.products.forEach((item, index) => {
    for (let slot = 0; slot < 13; slot += 1) item[`stat${slot}`] = [index * 100 + slot * 2 + 1, index * 100 + slot * 2 + 2];
  });
  const result = findGroupOptions(state, ISHELL_CURRENT);
  assert.equal(result.status, "found");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.items.length, 50);
  assert.equal(result.diag.cut.lists, 0);
  assert.equal(result.diag.groupListsWithoutCurrent, 650);
  assert.ok(result.diag.candidates.length <= 12);
});

test("거절: 지금 상품이 든 그룹 목록이 따로 있고 번호 묶음이 다르면(다른 번호·더 큰 목록·부분 목록) 하나로 정하지 않는다", () => {
  const state = groupObjectState();
  state.groupProduct.altProductNos = [ISHELL_CURRENT, "11463197546", "15555555555"];
  const result = findGroupOptions(state, ISHELL_CURRENT);
  assert.equal(result.status, "refused");
  assert.deepEqual(reasonCodes(result), ["ambiguous"]);
  assertNoNumbersHandedOut(result);

  // 스토어 전체 같은 더 큰 목록 + 진짜 그룹 목록: 큰 목록을 고르지 않고 거절.
  const superset = groupObjectState();
  superset.groupProduct.storeProductNos = [
    ISHELL_CURRENT, ...ISHELL_OPTION_IDS, ...Array.from({ length: 10 }, (_, index) => String(17100000000 + index)),
  ];
  const supersetResult = findGroupOptions(superset, ISHELL_CURRENT);
  assert.equal(supersetResult.status, "refused");
  assert.deepEqual(reasonCodes(supersetResult), ["ambiguous"]);
  assertNoNumbersHandedOut(supersetResult);

  // 번호 2개 이상인 부분 목록도 거절.
  const subset = groupObjectState();
  subset.groupProduct.productNos = [ISHELL_CURRENT, "11463197546", "11463197547"];
  const subsetResult = findGroupOptions(subset, ISHELL_CURRENT);
  assert.equal(subsetResult.status, "refused");
  assert.deepEqual(reasonCodes(subsetResult), ["ambiguous"]);

  // [지금 상품] 하나뿐인 목록, 같은 번호 묶음(순서·겹침만 다름), 고른 목록 항목 안에 든 하위 목록은 그대로 찾음.
  const fine = groupObjectState();
  fine.groupProduct.selectedNos = [ISHELL_CURRENT];
  fine.groupProduct.selectedTwice = [ISHELL_CURRENT, ISHELL_CURRENT];
  fine.groupProduct.sameNos = [...ISHELL_OPTION_IDS].reverse().concat(ISHELL_CURRENT, ISHELL_CURRENT);
  fine.groupProduct.products[1].groupSiblingNos = [ISHELL_CURRENT, "15555555555"];
  const fineResult = findGroupOptions(fine, ISHELL_CURRENT);
  assert.equal(fineResult.status, "found");
  assert.equal(fineResult.items.length, 24);
});

test("거절: 고른 목록 안쪽인지는 경로 글자가 아니라 객체로 가린다(groups[].members[].alsoNos)", () => {
  // 다른 묶음(groups[1]) 항목에는 상품번호 칸이 없다 — 지금 상품 없는 번호 목록이 groups 안에 또 있으면 '나뉜 조각'(B2)으로도
  // 거절되므로, 여기서는 안쪽/바깥 가리기만 본다.
  const makeState = () => ({
    groups: [
      {
        members: [
          { productNo: ISHELL_CURRENT, name: "대표" },
          { productNo: "11463197546", name: "옵션 1" },
          { productNo: "11463197547", name: "옵션 2" },
        ],
      },
      {
        members: [
          { name: "다른 묶음", alsoNos: [ISHELL_CURRENT, "15555555556"] },
          { name: "다른 묶음 2" },
        ],
      },
    ],
  });
  // 다른 묶음 항목 안의 목록은 경로(STATE.groups[].members[].alsoNos)가 고른 목록 안쪽처럼 보여도 바깥이다.
  const outside = findGroupOptions(makeState(), ISHELL_CURRENT);
  assert.equal(outside.status, "refused");
  assert.deepEqual(reasonCodes(outside), ["ambiguous"]);
  assert.equal(outside.diag.chosen.path, "STATE.groups[].members");
  assertNoNumbersHandedOut(outside);

  // 고른 목록 안에도 같은 경로·같은 번호의 목록이 있어도(경로+번호로 겹침을 지우면 바깥 것을 놓친다) 거절.
  const twin = makeState();
  twin.groups[0].members[0].alsoNos = [ISHELL_CURRENT, "15555555556"];
  const twinResult = findGroupOptions(twin, ISHELL_CURRENT);
  assert.equal(twinResult.status, "refused");
  assert.deepEqual(reasonCodes(twinResult), ["ambiguous"]);

  // 고른 목록 항목 안에만 있으면 찾음.
  const inside = makeState();
  delete inside.groups[1].members[0].alsoNos;
  inside.groups[0].members[0].alsoNos = [ISHELL_CURRENT, "15555555556"];
  const insideResult = findGroupOptions(inside, ISHELL_CURRENT);
  assert.equal(insideResult.status, "found");
  assert.deepEqual(insideResult.items.map((item) => item.id), [ISHELL_CURRENT, "11463197546", "11463197547"]);
});

test("거절: 항목마다 번호 칸이 다르면(productNo 와 id 섞임) 고른 칸에 번호가 없는 항목이 생겨 거절한다", () => {
  // 키는 항목마다 고르지 않는다(B1): productNo 칸은 3칸 중 2칸만 번호가 있어 알아보지 못한 항목 1개.
  const state = { groupProduct: { products: [{ productNo: ISHELL_CURRENT }, { productNo: "11463197546" }, { productNo: null, id: 98765 }] } };
  const result = findGroupOptions(state, ISHELL_CURRENT);
  assert.equal(result.status, "refused");
  assert.deepEqual(reasonCodes(result), ["unrecognized_items"]);
  assert.equal(result.reasons[0].count, 1);
  assert.equal(result.diag.chosen.idKey, "productNo");
  assertNoNumbersHandedOut(result);
  // 번호 그 자체 항목과 객체 항목이 섞여도 거절.
  const shapes = findGroupOptions({ groupProduct: { products: [ISHELL_CURRENT, "11463197546", { productNo: "11463197547" }] } }, ISHELL_CURRENT);
  assert.equal(shapes.status, "refused");
  assert.deepEqual(reasonCodes(shapes), ["unrecognized_items"]);
  assert.equal(shapes.diag.chosen.idKey, "(값)");
  // 모두 같은 키면 찾음.
  const same = findGroupOptions({ groupProduct: { products: [{ id: ISHELL_CURRENT }, { id: 98765 }] } }, ISHELL_CURRENT);
  assert.equal(same.status, "found");
  assert.deepEqual(same.diag.chosen.idKeys, ["id"]);
});

// B1: 객체 목록 [{ id: 채널 번호(주소 번호), productNo: 원상품 번호 }] — 시험용 번호(주소 번호 = CHANNEL).
const CHANNEL_IDS = [ISHELL_CURRENT, "11463197546", "11463197547", "11463197548"];
const ORIGIN_IDS = ["10000000001", "10000000002", "10000000003", "10000000004"];
const channelOriginItems = () => CHANNEL_IDS.map((id, index) => ({ id: Number(id), productNo: Number(ORIGIN_IDS[index]), name: `옵션 ${index}` }));

test("B1: 항목마다 키를 고르지 않고 키별 번호 묶음 중 지금 상품번호가 든 키를 쓴다(id = 주소 번호, productNo = 원상품 번호)", () => {
  const byId = findGroupOptions({ groupProduct: { products: channelOriginItems() } }, ISHELL_CURRENT);
  assert.equal(byId.status, "found");
  assert.deepEqual(byId.items.map((item) => item.id), CHANNEL_IDS);
  assert.deepEqual(byId.items.map((item) => item.name), ["옵션 0", "옵션 1", "옵션 2", "옵션 3"]);
  assert.equal(byId.diag.chosen.idKey, "id");
  assert.deepEqual(byId.diag.chosen.idKeys, ["id"]);
  assert.equal(byId.copyText.includes(ORIGIN_IDS[0]), false, "원상품 번호는 복사하지 않는다");

  const byChannelNo = findGroupOptions({
    groupInfo: { members: CHANNEL_IDS.map((id, index) => ({ channelProductNo: id, productNo: ORIGIN_IDS[index], name: `색 ${index}` })) },
  }, ISHELL_CURRENT);
  assert.equal(byChannelNo.status, "found");
  assert.deepEqual(byChannelNo.items.map((item) => item.id), CHANNEL_IDS);
  assert.equal(byChannelNo.diag.chosen.idKey, "channelProductNo");

  // 두 키가 같은 번호 묶음이면(같은 번호를 두 칸에 둠) 그대로 찾음.
  const twin = findGroupOptions({ groupProduct: { products: CHANNEL_IDS.map((id) => ({ id, channelProductNo: id })) } }, ISHELL_CURRENT);
  assert.equal(twin.status, "found");
  assert.deepEqual(twin.diag.chosen.idKeys, ["channelProductNo", "id"]);
});

test("B1 거절: 지금 상품번호가 든 키가 둘 이상이고 번호 묶음이 다르면 mixed_id_keys", () => {
  const items = [
    { productNo: ISHELL_CURRENT, id: ISHELL_CURRENT },
    { productNo: "11463197546", id: "11463197547" },
    { productNo: "11463197548", id: "11463197549" },
  ];
  const result = findGroupOptions({ groupProduct: { products: items } }, ISHELL_CURRENT);
  assert.equal(result.status, "refused");
  assert.deepEqual(reasonCodes(result), ["mixed_id_keys"]);
  assert.equal(result.reasons[0].count, 2);
  assert.match(result.reasons[0].text, /지금 상품번호가 든 칸이 2가지/);
  assert.deepEqual(result.diag.chosen.idKeys, ["productNo", "id"]);
  assertNoNumbersHandedOut(result);
});

test("B1 거절: 진짜 그룹 목록(id = 주소 번호)과 스토어 전체 목록이 함께 있으면 큰 목록을 고르지 않고 ambiguous", () => {
  // 항목마다 첫 키(productNo = 원상품 번호)를 쓰면 진짜 그룹 목록에서 지금 상품을 못 보고 스토어 전체 목록만 남는다.
  const storeWide = [...CHANNEL_IDS, ...Array.from({ length: 10 }, (_, index) => String(17100000000 + index))];
  const attack = { groupProduct: { products: channelOriginItems(), channelProductNos: storeWide } };
  const result = findGroupOptions(attack, ISHELL_CURRENT);
  assert.equal(result.status, "refused");
  assert.deepEqual(reasonCodes(result), ["ambiguous"]);
  assert.equal(result.diag.chosen.path, "STATE.groupProduct.channelProductNos");
  assertNoNumbersHandedOut(result);
  // 스토어 전체 목록이 그룹 구역 밖이면 진짜 그룹 목록을 찾는다.
  const outside = findGroupOptions({ groupProduct: { products: channelOriginItems() }, channel: { productNos: storeWide } }, ISHELL_CURRENT);
  assert.equal(outside.status, "found");
  assert.deepEqual(outside.items.map((item) => item.id), CHANNEL_IDS);
});

test("B2 거절: 그룹 목록이 여러 조각으로 나뉘어 있으면(옵션 축 묶음·쪽 나눔·감싼 쪽·같은 부모) group_list_split", () => {
  const [current, a, b, c, d, e] = [ISHELL_CURRENT, "11463197546", "11463197547", "11463197548", "11463197549", "11463197550"];
  const cases = [
    ["옵션 축 묶음", { groupProduct: { optionGroups: [{ optionValue: "빨강", products: [current, a] }, { optionValue: "파랑", products: [b, c] }] } }],
    ["쪽 나눔", { groupProduct: { pages: [[current, a, b], [c, d, e]] } }],
    ["감싼 쪽", { groupProduct: { pages: [{ items: [current, a] }, { items: [c, d] }] } }],
    ["같은 부모", { groupProduct: { firstNos: [current, a, b], restNos: [c, d] } }],
    // 다른 조각이 1개짜리여도 조각이다(옵션 값 하나에 상품 하나).
    ["1개짜리 조각", { groupProduct: { optionGroups: [{ optionValue: "빨강", products: [current, a] }, { optionValue: "파랑", products: [b] }] } }],
  ];
  for (const [name, state] of cases) {
    const result = findGroupOptions(state, current);
    assert.equal(result.status, "refused", name);
    assert.deepEqual(reasonCodes(result), ["group_list_split"], name);
    assert.ok(result.diag.chosen.split.length >= 1, name);
    assertNoNumbersHandedOut(result);
  }
  assert.equal(reasonFor("group_list_split").text, "그룹 목록이 여러 조각으로 나뉘어 있어 한 번에 읽지 못했습니다.");
});

test("B2 거절: [[채널 번호, 원상품 번호], …] 짝 목록은 목록으로 쓰지 않고 지금 상품이 들어 있으면 unrecognized_items", () => {
  const pairs = CHANNEL_IDS.map((id, index) => [id, ORIGIN_IDS[index]]);
  const result = findGroupOptions({ groupProduct: { pairs } }, ISHELL_CURRENT);
  assert.equal(result.status, "refused");
  assert.deepEqual(reasonCodes(result), ["unrecognized_items"]);
  assert.equal(result.reasons[0].count, 4);
  assert.deepEqual(result.diag.pairLists, [{ path: "STATE.groupProduct.pairs", count: 4 }]);
  assertNoNumbersHandedOut(result);
  // 짝 하나뿐이어도 같다(안쪽 [지금, 원상품] 을 그룹 목록으로 고르지 않음).
  const single = findGroupOptions({ groupProduct: { pairs: [[ISHELL_CURRENT, ORIGIN_IDS[0]]] } }, ISHELL_CURRENT);
  assert.equal(single.status, "refused");
  assert.deepEqual(reasonCodes(single), ["unrecognized_items"]);
});

test("B2: 조각으로 보지 않는 것 — 고른 목록 항목 안 목록, 다른 부모의 그룹 목록, 작은 번호 목록, 지금 상품 없는 짝 목록", () => {
  const state = groupObjectState();
  state.groupProduct.products[2].optionNos = ["15555555555", "15555555556"];
  state.groupProduct.priceRanges = [[10000, 20000], [20000, 30000]];
  state.groupProduct.imageIds = [1, 2, 3];
  state.groupProduct.selectedNos = [ISHELL_CURRENT];
  state.groupInfo = { soldOutNos: ["15555555557", "15555555558"] };
  const result = findGroupOptions(state, ISHELL_CURRENT);
  assert.equal(result.status, "found");
  assert.equal(result.items.length, 24);
  assert.deepEqual(result.diag.chosen.split, []);
  assert.deepEqual(result.diag.pairLists, []);
});

test("H2: 같은 목록 객체를 그룹 밖에서 먼저 만나도 그룹 구역(groupProduct.members)에서 다시 훑어 찾는다", () => {
  const members = [ISHELL_CURRENT, ...ISHELL_OPTION_IDS].map((id, index) => ({ productNo: id, name: `옵션 ${index}` }));
  const result = findGroupOptions({ cache: { members }, groupProduct: { members } }, ISHELL_CURRENT);
  assert.equal(result.status, "found");
  assert.equal(result.items.length, 24);
  assert.equal(result.diag.chosen.path, "STATE.groupProduct.members");
  // 묶음 객체를 통째로 함께 쓸 때도 같다.
  const shared = { list: members };
  const viaObject = findGroupOptions({ product: { info: shared }, groupProduct: { info: shared } }, ISHELL_CURRENT);
  assert.equal(viaObject.status, "found");
  assert.equal(viaObject.diag.chosen.path, "STATE.groupProduct.info.list");
  // 순환은 조상으로 막는다: 그룹 키가 바깥 묶음 전체를 가리켜도 관련 상품 목록이 그룹 목록이 되지 않는다.
  const cyclic = groupObjectState();
  cyclic.groupProduct.root = cyclic;
  const cyclicResult = findGroupOptions(cyclic, ISHELL_CURRENT);
  assert.equal(cyclicResult.status, "found");
  assert.equal(cyclicResult.items.length, 24);
});

test("H4: 페이지 데이터 일부를 못 읽었다고 알려 주면(unreadableSources) 그룹 목록을 찾았어도 거절", () => {
  const result = findGroupOptions(groupObjectState(), ISHELL_CURRENT, { unreadableSources: 1 });
  assert.equal(result.status, "refused");
  assert.deepEqual(reasonCodes(result), ["source_unreadable"]);
  assert.equal(result.reasons[0].text, "페이지 데이터 일부를 읽지 못했습니다.");
  assert.equal(result.diag.unreadableSources, 1);
  assertNoNumbersHandedOut(result);
  const notFound = findGroupOptions(noGroupState(), DECASA_CURRENT, { unreadableSources: 2 });
  assert.equal(notFound.status, "refused");
  assert.deepEqual(reasonCodes(notFound), ["source_unreadable"]);
  for (const ignored of [0, -1, "1", null, 1.5]) {
    assert.equal(findGroupOptions(groupObjectState(), ISHELL_CURRENT, { unreadableSources: ignored }).status, "found", String(ignored));
  }
});

test("F4: 같은 부모 아래 나란한 칸(channelProductNos 옆 같은 길이 originalProductNos)은 조각이 아니다 — 채널 번호·이름으로 찾는다", () => {
  const result = findGroupOptions(groupParallelColumnsState(), ISHELL_CURRENT);
  assert.equal(result.status, "found");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.items.map((item) => item.id), PARALLEL_CHANNEL_IDS);
  assert.deepEqual(result.items.map((item) => item.name), ["블랙", "화이트", "레드", "블루"]);
  assert.equal(result.copyText, PARALLEL_CHANNEL_IDS.join("\n"));
  for (const origin of PARALLEL_ORIGINAL_IDS) assert.equal(result.copyText.includes(origin), false, "원상품 번호는 복사하지 않는다");
  assert.equal(result.diag.chosen.path, "STATE.groupProduct.channelProductNos");
  assert.equal(result.diag.chosen.names.source, "sibling:optionNames");
  assert.deepEqual(result.diag.chosen.split, []);
  assert.deepEqual(result.diag.chosen.parallel, [{ path: "STATE.groupProduct.originalProductNos", count: 4 }]);

  // 이름 목록이 없어도 번호는 찾는다.
  const bare = findGroupOptions(groupParallelColumnsState({ withNames: false }), ISHELL_CURRENT);
  assert.equal(bare.status, "found");
  assert.deepEqual(bare.items.map((item) => item.id), PARALLEL_CHANNEL_IDS);

  // 키에 orig 가 없으면 길이가 같아도 나란한 칸으로 보지 않는다 — 크기가 같은 쪽 나눔과 가를 수 없어 거절 쪽(2026-11-01).
  const sameLength = groupParallelColumnsState();
  delete sameLength.groupProduct.originalProductNos;
  sameLength.groupProduct.baseProductNos = [...PARALLEL_ORIGINAL_IDS];
  const sameLengthResult = findGroupOptions(sameLength, ISHELL_CURRENT);
  assert.equal(sameLengthResult.status, "refused");
  assert.deepEqual(reasonCodes(sameLengthResult), ["group_list_split"]);

  // 키에 orig(origin·original)가 들면 길이가 달라도 나란한 칸이다(원상품 번호가 빠진 칸이 있음).
  for (const key of ["originalProductNos", "originProductNos", "origNos"]) {
    const state = groupParallelColumnsState();
    delete state.groupProduct.originalProductNos;
    state.groupProduct[key] = PARALLEL_ORIGINAL_IDS.slice(0, 3);
    const shorter = findGroupOptions(state, ISHELL_CURRENT);
    assert.equal(shorter.status, "found", key);
    assert.deepEqual(shorter.diag.chosen.parallel, [{ path: `STATE.groupProduct.${key}`, count: 3 }], key);
  }
});

test("F4 거절: 같은 부모 아래 길이가 다르고 원상품 칸이 아닌 번호 목록은 조각, 옵션 축 묶음·쪽 나눔은 길이가 같아도 조각", () => {
  const [current, a, b, c, d, e] = [ISHELL_CURRENT, "11463197546", "11463197547", "11463197548", "11463197549", "11463197550"];
  const cases = [
    // 같은 부모, 길이 다름(4 대 2), 키에 orig 없음.
    ["같은 부모 다른 길이", { groupProduct: { channelProductNos: [...PARALLEL_CHANNEL_IDS], moreProductNos: [d, e] } }],
    // 나란한 원상품 칸이 있어도 다른 길이의 조각이 함께 있으면 거절.
    ["나란한 칸 + 조각", { groupProduct: { channelProductNos: [...PARALLEL_CHANNEL_IDS], originalProductNos: [...PARALLEL_ORIGINAL_IDS], nextPageNos: [d] } }],
    // 조상 목록 규칙은 그대로: 각 묶음·쪽 안에 나란한 칸이 있어도, 다른 묶음·쪽의 목록은 조각이다.
    ["옵션 축 묶음(같은 길이)", { groupProduct: { optionGroups: [
      { optionValue: "빨강", channelProductNos: [current, a], originalProductNos: ["10000000001", "10000000002"] },
      { optionValue: "파랑", channelProductNos: [b, c], originalProductNos: ["10000000003", "10000000004"] },
    ] } }],
    ["쪽 나눔(같은 길이)", { groupProduct: { pages: [{ channelProductNos: [current, a, b], originalProductNos: ["10000000001", "10000000002", "10000000003"] }, { channelProductNos: [c, d, e] }] } }],
    ["쪽 나눔(목록 안 목록)", { groupProduct: { pages: [[current, a, b], [c, d, e]] } }],
    // 같은 부모 아래 크기가 같은 쪽·축 묶음(형제 키) — 길이가 같아도 orig 칸이 아니면 조각(Codex·반박 검토 2026-11-01).
    ["쪽 나눔(번호 키 객체)", { groupProduct: { pages: { 1: [current, a, b], 2: [c, d, e] } } }],
    ["옵션 축(키 객체)", { groupProduct: { optionGroups: { red: [current, a, b], blue: [c, d, e] } } }],
    ["다음 쪽 칸", { groupProduct: { channelProductNos: [current, a, b], nextPageChannelProductNos: [c, d, e] } }],
    // 쪽 묶음을 객체로 나누고 그 안에 같은 키 목록(할아버지 객체가 같음).
    ["쪽 묶음 객체 안 같은 키", { groupProduct: { pages: { 1: { channelProductNos: [current, a, b] }, 2: { channelProductNos: [c, d, e] } } } }],
  ];
  for (const [name, state] of cases) {
    const result = findGroupOptions(state, current);
    assert.equal(result.status, "refused", name);
    assert.deepEqual(reasonCodes(result), ["group_list_split"], name);
    assert.ok(result.diag.chosen.split.length >= 1, name);
    assertNoNumbersHandedOut(result);
  }
});

test("F1: 같은 쪽 목록이 캐시 쪽과 그룹의 둘째 쪽에 함께 걸려 있어도 자리마다 다시 훑어 쪼개짐을 찾는다(첫 쪽만 찾지 않음)", () => {
  const makePages = () => {
    const page1 = [ISHELL_CURRENT, "11463197546", "11463197547"];
    const page2 = ["11463197548", "11463197549", "11463197550"];
    return { page1, page2 };
  };
  const cases = [
    // 캐시가 그룹 구역 안에 있고 둘째 쪽보다 먼저 훑힘.
    ["그룹 안 캐시", () => { const { page1, page2 } = makePages(); return { groupProduct: { cache: { lastPage: page2 }, pages: [page1, page2] } }; }],
    // 캐시가 다른 그룹 키 아래에 있음.
    ["다른 그룹 키 캐시", () => { const { page1, page2 } = makePages(); return { groupCache: { lastPage: page2 }, groupProduct: { pages: [page1, page2] } }; }],
    // 캐시가 그룹 밖.
    ["그룹 밖 캐시", () => { const { page1, page2 } = makePages(); return { cache: { lastPage: page2 }, groupProduct: { pages: [page1, page2] } }; }],
    // 첫 쪽(지금 상품 든 목록)이 쪽 목록보다 먼저 다른 그룹 자리에서 보임 — 고른 목록이 보인 자리마다 조각을 본다.
    ["첫 쪽이 다른 자리에도", () => { const { page1, page2 } = makePages(); return { groupCurrent: { nos: page1 }, groupProduct: { pages: [page1, page2] } }; }],
  ];
  for (const [name, make] of cases) {
    const result = findGroupOptions(make(), ISHELL_CURRENT);
    assert.equal(result.status, "refused", name);
    assert.deepEqual(reasonCodes(result), ["group_list_split"], name);
    assert.equal(result.reasons[0].count, 1, `${name}: 같은 목록은 한 번만 센다`);
    assertNoNumbersHandedOut(result);
  }
  // 공유가 많아 같은 묶음을 셀 수 없이 다시 훑게 되면 노드 상한에 걸려 거절한다(멈추지 않음).
  const diamond = groupObjectState();
  let level = {};
  for (let depth = 0; depth < 28; depth += 1) level = { left: level, right: level };
  diamond.groupProduct.shared = level;
  const blown = findGroupOptions(diamond, ISHELL_CURRENT);
  assert.equal(blown.status, "refused");
  assert.deepEqual(reasonCodes(blown), ["traversal_cap"]);
  assert.equal(blown.diag.cut.nodes, true);
  assertNoNumbersHandedOut(blown);
});

test("F3: 훑다가 값·키 목록 읽기가 던지면(getter·프록시 함정) 세어서 거절한다(source_unreadable)", () => {
  const throwing = () => { throw new Error("읽기 금지"); };
  const cases = [
    ["그룹 목록 옆 getter", (state) => Object.defineProperty(state.groupProduct, "trap", { enumerable: true, get: throwing })],
    // 번호를 못 읽은 항목은 알아보지 못한 항목으로도 센다.
    ["목록 항목의 번호 getter", (state) => Object.defineProperty(state.groupProduct.products[1], "productNo", { enumerable: true, get: throwing }), ["source_unreadable", "unrecognized_items"]],
    ["추천 구역 getter", (state) => Object.defineProperty(state.recommend, "trap", { enumerable: true, get: throwing })],
    ["키 목록 프록시 함정", (state) => { state.groupProduct.proxy = new Proxy({}, { ownKeys: throwing }); }],
    ["값 읽기 프록시 함정", (state) => { state.groupProduct.proxy = new Proxy({ a: 1 }, { get: throwing }); }],
    ["목록 길이 프록시 함정", (state) => { state.groupProduct.proxyList = new Proxy([1, 2], { get: throwing }); }],
    ["폐기된 프록시", (state) => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      state.groupProduct.revoked = proxy;
    }],
  ];
  for (const [name, spoil, expected = ["source_unreadable"]] of cases) {
    const state = groupObjectState();
    spoil(state);
    let result = null;
    assert.doesNotThrow(() => { result = findGroupOptions(state, ISHELL_CURRENT); }, name);
    assert.equal(result.status, "refused", name);
    assert.deepEqual(reasonCodes(result), expected, name);
    assert.ok(result.diag.readErrors >= 1, name);
    assert.equal(result.diag.unreadableSources, 0, name);
    assertNoNumbersHandedOut(result);
  }
  // 패널이 알려 준 못 읽은 묶음과 합쳐 센다.
  const both = groupObjectState();
  Object.defineProperty(both.groupProduct, "trap", { enumerable: true, get: throwing });
  const bothResult = findGroupOptions(both, ISHELL_CURRENT, { unreadableSources: 2 });
  assert.equal(bothResult.reasons[0].count, 3);
  assert.equal(bothResult.diag.readErrors, 1);
  // 들어가지 않는 민감 키(token 등)는 읽지 않으므로 던지는 getter 가 있어도 그대로 찾는다.
  const sensitive = groupObjectState();
  Object.defineProperty(sensitive.groupProduct, "token", { enumerable: true, get: throwing });
  const sensitiveResult = findGroupOptions(sensitive, ISHELL_CURRENT);
  assert.equal(sensitiveResult.status, "found");
  assert.equal(sensitiveResult.diag.readErrors, 0);
});

test("이름 짝: 글자만 든 목록은 키에 name 이 있을 때만 쓰고, 상태 목록(statusText '판매중'·'품절')·배지 이름은 쓰지 않는다", () => {
  const state = groupNumberArrayState({ withNames: false });
  state.productGroup.statusText = ["판매중", "품절", "판매중", "품절"];
  state.productGroup.badgeName = ["신상", "인기", "신상", "인기"];
  const result = findGroupOptions(state, DECASA_CURRENT);
  assert.equal(result.status, "found");
  assert.deepEqual(result.items.map((item) => item.name), ["", "", "", ""]);
  assert.equal(result.diag.chosen.names.source, "none");
  // name 이 든 키(valueName)면 짝짓는다.
  state.productGroup.valueName = ["흰색", "회색", "검정", "파랑"];
  const named = findGroupOptions(state, DECASA_CURRENT);
  assert.deepEqual(named.items.map((item) => item.name), ["흰색", "회색", "검정", "파랑"]);
  assert.equal(named.diag.chosen.names.source, "sibling:valueName");
});

// 진단 안의 글자·키를 하나씩 꺼낸다(통째로 넣으면 서버가 칸 수 상한으로 먼저 거절해 시험이 비게 됨).
function diagLeaves(value, out = []) {
  if (typeof value === "string" || typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) diagLeaves(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      diagLeaves(item, out);
    }
  }
  return out;
}

test("진단: 상품번호 모양 키(5자리 이상 숫자, 키 이름 안에 든 것 포함)는 '#n' 으로 가려, 서버 입력 해석에 넣어도 지금 상품 말고는 번호가 안 나온다", () => {
  for (const byNo of [
    { 15555555555: {} },
    { 15555555554: {}, 15555555555: { groupInfo: { list: [1, 2] } } },
    // M3: 키 이름 안의 숫자(groupProduct_9988776655 같은 키)도 경로·묶음 키 목록·group 키 어디서든 가린다.
    { groupProduct_9988776655: { optionGroup_15555555553: { list: [1, 2] } }, item15555555552x: { a: 1 }, v1234: {} },
  ]) {
    const state = groupObjectState();
    state.groupProduct.byNo = byNo;
    state.groupProduct.products.push({ name: "번호 없는 옵션" });
    const result = findGroupOptions(state, ISHELL_CURRENT);
    assert.equal(result.status, "refused");
    // 패널 '진단 복사'와 같은 모양(지금 상품번호는 page 칸에만).
    const diag = { ...result.diag, page: `i_shell/${ISHELL_CURRENT}` };
    const diagText = JSON.stringify(diag);
    assert.ok(diagText.includes(NUMBER_MASK), "가린 표시가 남는다");
    assert.deepEqual([...new Set(diagText.match(/[0-9]{5,}/g) || [])], [ISHELL_CURRENT]);
    const whole = server.parseOptionProductInput(diagText, { primaryProductIds: [ISHELL_CURRENT] });
    assert.deepEqual(whole.optionProductIds, []);
    for (const leaf of diagLeaves(diag)) {
      const parsed = server.parseOptionProductInput(leaf, { primaryProductIds: [ISHELL_CURRENT] });
      assert.deepEqual(parsed.optionProductIds, [], leaf);
    }
  }
  // 경로·group 키·후보 경로도 가린다.
  const keyed = groupObjectState();
  keyed.groupProduct.byNo = { 15555555555: { groupList: [ISHELL_CURRENT, "11463197546"] } };
  const keyedResult = findGroupOptions(keyed, ISHELL_CURRENT);
  assert.equal(keyedResult.status, "refused");
  assert.ok(keyedResult.diag.candidates.some((list) => list.path === "STATE.groupProduct.byNo.#n.groupList"));
  assert.ok(keyedResult.diag.groupKeys.some((entry) => entry.path === "STATE.groupProduct.byNo.#n.groupList"));
  assert.equal(JSON.stringify(keyedResult.diag).includes("15555555555"), false);
  // 키 이름 안의 숫자는 그 부분만 가린다(4자리 이하는 그대로).
  const inner = groupObjectState();
  inner.groupProduct.byNo = { groupProduct_9988776655: { groupList: [ISHELL_CURRENT, "11463197546"] }, v1234: {} };
  const innerResult = findGroupOptions(inner, ISHELL_CURRENT);
  assert.ok(innerResult.diag.candidates.some((list) => list.path === "STATE.groupProduct.byNo.groupProduct_#n.groupList"));
  assert.ok(innerResult.diag.groupKeys.some((entry) => entry.path === "STATE.groupProduct.byNo.groupProduct_#n"));
  assert.ok(innerResult.diag.chosen.parentKeys.some((entry) => entry.key === "byNo" && entry.type === "묶음(groupProduct_#n,v1234)"));
  assert.equal(JSON.stringify(innerResult.diag).includes("9988776655"), false);
});

test("같은 번호가 두 번 있으면 한 번만, 지금 상품만 있는 목록은 목록으로 보지 않는다", () => {
  const dup = groupOfSize(3);
  dup.groupProduct.products.push({ productNo: ISHELL_CURRENT, name: "다시 대표" });
  const result = findGroupOptions(dup, ISHELL_CURRENT);
  assert.equal(result.status, "found");
  assert.equal(result.items.length, 3);
  assert.equal(result.diag.chosen.duplicates, 1);
  const alone = findGroupOptions({ groupProduct: { products: [{ productNo: ISHELL_CURRENT }, { productNo: ISHELL_CURRENT }] } }, ISHELL_CURRENT);
  assert.equal(alone.status, "not_found");
});

test("여러 데이터 묶음([{ label, value }])을 함께 훑는다(JSON 스크립트 쪽에만 그룹이 있어도)", () => {
  const result = findGroupOptions([
    { label: "STATE", value: noGroupState() },
    { label: "SCRIPT0", value: groupNumberArrayState() },
  ], DECASA_CURRENT);
  assert.equal(result.status, "found");
  assert.equal(result.diag.chosen.path, "SCRIPT0.productGroup.productNos");
  assert.deepEqual(result.diag.roots, ["STATE", "SCRIPT0"]);
});

test("진단: 키 경로·개수·값 종류만 — 이름·개인정보 값은 없고, 거절이면 번호도 없다", () => {
  const found = findGroupOptions(groupObjectState(), ISHELL_CURRENT);
  const foundText = JSON.stringify(found.diag);
  for (const value of [...PRIVATE_VALUES, "아이폰17 사생활보호", "옵션 0", "아이쉘 대표", "아이쉘"]) {
    assert.equal(foundText.includes(value), false, value);
  }
  assert.equal(foundText.includes("email"), false);
  assert.equal(foundText.includes("memberNo"), false);
  assert.deepEqual(found.diag.chosen.ids, [ISHELL_CURRENT, ...ISHELL_OPTION_IDS]);
  assert.deepEqual(found.diag.chosen.firstItem, [{ key: "productNo", type: "숫자" }, { key: "name", type: "글자 11자" }]);
  assert.ok(found.diag.chosen.parentKeys.some((entry) => entry.key === "products" && entry.chosen === true && entry.type === "목록 24개"));

  const members = findGroupOptions(membersWithoutCurrentState(), DECASA_CURRENT);
  const membersText = JSON.stringify(members.diag);
  for (const value of [...PRIVATE_VALUES, "수건 0"]) assert.equal(membersText.includes(value), false, value);
  assert.ok(members.diag.groupKeys.some((entry) => entry.path === "STATE.groupStatus" && entry.type === "글자 13자"));

  // 키 이름이 영문·숫자 모양이 아니면 '?' 로만 남긴다.
  const odd = findGroupOptions({ "그룹 a@b.c": { groupList: [ISHELL_CURRENT, "11463197546"] } }, ISHELL_CURRENT);
  assert.equal(odd.status, "found");
  assert.equal(odd.diag.chosen.path, "STATE.?.groupList");
  assert.equal(JSON.stringify(odd.diag).includes("a@b.c"), false);
});

test("이상한 입력에도 던지지 않는다(읽으면 던지는 값·순환 참조·빈 입력)", () => {
  const state = groupOfSize(3);
  state.groupProduct.self = state;
  assert.equal(findGroupOptions(state, ISHELL_CURRENT).status, "found");
  // 읽으면 던지는 값은 던지지 않고 거절한다(F3, 자세한 시험은 아래 'F3').
  Object.defineProperty(state.groupProduct, "trap", { enumerable: true, get() { throw new Error("읽기 금지"); } });
  const trapped = findGroupOptions(state, ISHELL_CURRENT);
  assert.equal(trapped.status, "refused");
  assert.deepEqual(reasonCodes(trapped), ["source_unreadable"]);
  for (const empty of [null, undefined, 42, "text", []]) {
    const result = findGroupOptions(empty, ISHELL_CURRENT);
    assert.equal(result.status, "not_found");
    assertNoNumbersHandedOut(result);
  }
  assert.equal(findGroupOptions(groupObjectState(), "").status, "not_found");
});

test("복사 내용을 서버 입력 해석(parseOptionProductInput)에 넣으면 대표 번호를 알아보고 옵션만 남는다", () => {
  const ishell = findGroupOptions(groupObjectState(), ISHELL_CURRENT);
  const parsed = server.parseOptionProductInput(ishell.copyText, { primaryProductIds: [ISHELL_CURRENT] });
  assert.equal(parsed.error, "");
  assert.deepEqual(parsed.rejected, []);
  assert.equal(parsed.primaryRemoved, true);
  assert.deepEqual(parsed.optionProductIds, ISHELL_OPTION_IDS);
  // 버튼이 통과시키는 최대(지금 상품 + 옵션 50개)는 서버 한도 안이다.
  const full = findGroupOptions(groupOfSize(OPTION_PRODUCT_IDS_MAX + 1), ISHELL_CURRENT);
  const fullParsed = server.parseOptionProductInput(full.copyText, { primaryProductIds: [ISHELL_CURRENT] });
  assert.equal(fullParsed.error, "");
  assert.equal(fullParsed.overLimit, false);
  assert.equal(fullParsed.optionProductIds.length, OPTION_PRODUCT_IDS_MAX);
});

test("거절 이유 글: 모든 코드에 쉬운 한국어 문장이 있다", () => {
  for (const code of REASON_CODES) {
    const reason = reasonFor(code, 3);
    assert.equal(reason.code, code);
    assert.ok(reason.text.length > 5 && /[가-힣]/.test(reason.text), code);
  }
});

test("공유 목록이 겹겹이어도 탭이 멈추지 않는다 — 숫자만 든 목록은 두 번째 자리부터 칸 읽기·순회를 건너뜀(2026-11-01)", () => {
  // 다이아몬드: 각 층의 l·r 이 같은 객체를 가리켜 자리 수가 2^깊이로 불어난다. 맨 끝에 숫자 5000개 목록 하나를 공유한다.
  const big = Array.from({ length: 5000 }, (_, index) => String(20000000000 + index));
  let node = { tail: big };
  for (let level = 0; level < 15; level += 1) node = { l: node, r: node };
  const state = { groupProduct: { channelProductNos: [ISHELL_CURRENT, "11463197546", "11463197547"] }, cache: node };
  const started = process.hrtime.bigint();
  const result = findGroupOptions(state, ISHELL_CURRENT);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1500, `너무 오래 걸림 ${Math.round(elapsedMs)}ms`);
  // 판정은 그대로다(그룹 밖 공유 목록은 조각이 아님).
  assert.equal(result.status, "found");
  assert.deepEqual(result.items.map((item) => item.id), [ISHELL_CURRENT, "11463197546", "11463197547"]);
});
