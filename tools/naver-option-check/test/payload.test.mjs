// 인사이트로 넘기는 값(#mi-optfill=…) 단위 시험(advertiser-impl-spec 1·3절, 2.1.0).
// core.mjs 의 값·진단 함수를 명세 글자(정규식·칸 규칙·이유 코드)와 따로 맞춰 본다. 화면에서 실제로 누르는 시험은 bookmarklet.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  OPTION_FILL_DIAG_MAX_CHARS,
  OPTION_FILL_FOUND_PATTERN,
  OPTION_FILL_HASH_MAX_CHARS,
  OPTION_FILL_REFUSED_PATTERN,
  OPTION_PRODUCT_IDS_MAX,
  REASON_CODES,
  base64UrlAscii,
  encodeOptionFillDiag,
  findGroupOptions,
  optionFillDiag,
  optionFillFoundPayload,
  optionFillRefusedPayload,
  reasonFor,
} from "../src/core.mjs";
import { ISHELL_CURRENT, ISHELL_OPTION_IDS, groupOfSize } from "./fixtures.mjs";

const SPEC_FOUND_SOURCE = String.raw`^2\.f\.([0-9]{5,20})\.([0-9]{5,20}(?:-[0-9]{5,20}){0,50})$`;
const SPEC_REFUSED_SOURCE = String.raw`^2\.r\.([0-9]{5,20})\.([A-Za-z0-9_-]{1,2000})$`;
const SPEC_REASON_CODES = [
  "source_unreadable", "traversal_cap", "ambiguous", "group_list_split", "mixed_id_keys",
  "unrecognized_items", "unsafe_number", "digit_length", "too_many", "no_group_list", "group_list_without_current", "not_found",
];

const decode = (encoded) => JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const ids = (count, start = 30000000000) => Array.from({ length: count }, (_, index) => String(start + index));

test("명세 글자: 정규식·이유 코드·길이 상한이 advertiser-impl-spec 1절과 같다", () => {
  assert.equal(OPTION_FILL_FOUND_PATTERN.source, SPEC_FOUND_SOURCE);
  assert.equal(OPTION_FILL_REFUSED_PATTERN.source, SPEC_REFUSED_SOURCE);
  assert.equal(OPTION_FILL_FOUND_PATTERN.flags, "");
  assert.equal(OPTION_FILL_REFUSED_PATTERN.flags, "");
  assert.deepEqual([...REASON_CODES], SPEC_REASON_CODES);
  assert.equal(OPTION_FILL_DIAG_MAX_CHARS, 2000);
  assert.equal(OPTION_FILL_HASH_MAX_CHARS, 2200);
  // 찾음 정규식의 개수(1~51)는 서버 한도(옵션 50 + 지금 상품)와 같다.
  assert.equal(OPTION_PRODUCT_IDS_MAX + 1, 51);
  assert.ok(reasonFor("not_found").text.length > 5);
});

test("찾음 값: 지금 상품 포함·겹침 없음·5~20자리·1~51개만 만들고, 어긋나면 빈 글자", () => {
  const page = ISHELL_CURRENT;
  const good = optionFillFoundPayload(page, [page, ...ISHELL_OPTION_IDS]);
  assert.equal(good, `2.f.${page}.${[page, ...ISHELL_OPTION_IDS].join("-")}`);
  assert.match(good, new RegExp(SPEC_FOUND_SOURCE));
  // 지금 상품이 목록 가운데 있어도 그 순서 그대로.
  assert.equal(optionFillFoundPayload(page, [ISHELL_OPTION_IDS[0], page]), `2.f.${page}.${ISHELL_OPTION_IDS[0]}-${page}`);
  // 지금 상품 하나뿐인 목록도 형식상 허용(1개).
  assert.equal(optionFillFoundPayload(page, [page]), `2.f.${page}.${page}`);
  const max = [page, ...ids(OPTION_PRODUCT_IDS_MAX)];
  assert.match(optionFillFoundPayload(page, max), new RegExp(SPEC_FOUND_SOURCE));
  for (const [name, pageId, list] of [
    ["지금 상품 없음", page, ISHELL_OPTION_IDS],
    ["겹침", page, [page, ISHELL_OPTION_IDS[0], ISHELL_OPTION_IDS[0]]],
    ["52개", page, [page, ...ids(OPTION_PRODUCT_IDS_MAX + 1)]],
    ["4자리 번호", page, [page, "1234"]],
    ["21자리 번호", page, [page, "1".repeat(21)]],
    ["숫자 아님", page, [page, "1234a678"]],
    ["pageId 4자리", "1234", ["1234", ISHELL_OPTION_IDS[0]]],
    ["pageId 숫자 아님", "12345x", ["12345x"]],
    ["빈 목록", page, []],
    ["목록 아님", page, `${page}-${ISHELL_OPTION_IDS[0]}`],
  ]) {
    assert.equal(optionFillFoundPayload(pageId, list), "", name);
  }
});

test("base64url: Buffer 와 같은 결과(무패딩), ASCII 밖 글자는 던진다", () => {
  const samples = ["", "a", "ab", "abc", "abcd", "{\"v\":\"2.1.0\"}", "~!@#$%^&*()_+-=[]{}|;':,./<>?", "\u007f\u0000 x"];
  for (let length = 0; length < 70; length += 1) samples.push(Array.from({ length }, (_, index) => String.fromCharCode(32 + ((index * 37 + length) % 95))).join(""));
  for (const sample of samples) {
    const encoded = base64UrlAscii(sample);
    assert.equal(encoded, Buffer.from(sample, "latin1").toString("base64url"), JSON.stringify(sample));
    assert.match(encoded, /^[A-Za-z0-9_-]*$/);
  }
  assert.throws(() => base64UrlAscii("이름"), /ASCII/);
  assert.throws(() => base64UrlAscii("é"), /ASCII/);
});

test("진단 만들기: 정해진 네 칸만, counts 8개 이하 정수, keys 는 칸 규칙에 맞게 고쳐 20개 이하", () => {
  const result = {
    status: "refused",
    reasons: [reasonFor("mixed_id_keys", 2), reasonFor("unrecognized_items", 3), { code: "made_up", count: 1 }, reasonFor("too_many", 60)],
    diag: {
      nodes: 20_000_000,
      unreadableSources: 1,
      readErrors: 2,
      cut: { nodes: true, depth: 1, arrays: 0, lists: 2 },
      groupListsWithoutCurrent: 3,
      pairLists: [{ path: "STATE.groupPairs", count: 2 }],
      chosen: {
        path: "SCRIPT0.group$x.list[].items",
        count: 7,
        idKeys: ["productNo", "(값)"],
        split: [{ path: "STATE.groupProduct.page2[]", count: 3 }],
        parallel: [{ path: "STATE.groupProduct.originalProductNos", count: 7 }],
      },
      candidates: Array.from({ length: 30 }, (_, index) => ({ path: `STATE.groupProduct.c${index}?`, count: 2 })),
      groupKeys: [{ path: "STATE.groupProduct_99887766554.x", type: "묶음" }],
      // 아래 칸은 진단으로 넘기지 않는다.
      ids: [ISHELL_CURRENT],
      names: ["홍길동"],
    },
    items: [{ id: ISHELL_CURRENT, name: "홍길동" }],
  };
  const diag = optionFillDiag(result, { sources: { jsonScripts: 4 } });
  assert.deepEqual(Object.keys(diag), ["v", "reason", "counts", "keys"]);
  assert.equal(diag.v, "2.1.0");
  assert.equal(diag.reason, "mixed_id_keys");
  assert.deepEqual(diag.counts, {
    nodes: 10_000_000, jsonScripts: 4, unreadable: 3, capped: 4, reasonCount: 2, chosenCount: 7, splitPieces: 1, groupLists: 3,
  });
  assert.equal(diag.keys.length, 20);
  assert.deepEqual(diag.keys.slice(0, 7), [
    "reason.unrecognized_items",
    "reason.too_many",
    "SCRIPT0.group_x.list_.items",
    "idKey.productNo",
    "idKey.value",
    "STATE.groupProduct.page2_",
    "STATE.groupProduct.originalProductNos",
  ]);
  for (const key of diag.keys) assert.match(key, /^[A-Za-z0-9_#.-]{1,40}$/);
  // 상품번호 모양 숫자는 keys 에 없다(counts 값은 개수라 5자리를 넘을 수 있음).
  assert.equal(/[0-9]{5,}/.test(diag.keys.join(" ")), false);
  const text = JSON.stringify(diag);
  assert.equal(text.includes(ISHELL_CURRENT), false);
  assert.equal(text.includes("홍길동"), false);
  assert.equal(text.includes("made_up"), false);

  // 이유가 없으면 not_found, 실행 오류면 source_unreadable 과 runtimeError 만.
  assert.equal(optionFillDiag({ status: "not_found", reasons: [], diag: null }).reason, "not_found");
  assert.deepEqual(optionFillDiag(null, { runtimeError: true }), { v: "2.1.0", reason: "source_unreadable", counts: { runtimeError: 1 }, keys: [] });
});

test("진단 만들기: 실제 판정 결과(거절·못 찾음)에서 이유가 판정 이유 그대로다", () => {
  const refused = findGroupOptions(groupOfSize(53), ISHELL_CURRENT);
  assert.equal(optionFillDiag(refused).reason, "too_many");
  const missing = findGroupOptions({ groupProduct: { products: [{ productNo: "30000000001" }, { productNo: "30000000002" }] } }, ISHELL_CURRENT);
  assert.equal(missing.status, "not_found");
  assert.equal(optionFillDiag(missing).reason, "group_list_without_current");
  const nothing = findGroupOptions({}, ISHELL_CURRENT);
  assert.equal(optionFillDiag(nothing).reason, "no_group_list");
});

test("진단 글자: 칸 규칙 밖 값·칸은 버리고 다시 만든다(이상한 칸·이유·키·숫자)", () => {
  const encoded = encodeOptionFillDiag({
    v: "9.9.9",
    reason: "<script>",
    counts: { ok: 3, big: 99_999_999, neg: -1, float: 1.5, flag: true, "bad key": 1, a1: 2, str: "4", n: 0 },
    keys: ["ok.key", "bad key", "x".repeat(41), "STATE.groupProduct_12345", "#n.fine", 42, "", ...Array.from({ length: 30 }, (_, index) => `k${index}`)],
    extra: "버림",
  });
  const diag = decode(encoded);
  assert.deepEqual(Object.keys(diag), ["v", "reason", "counts", "keys"]);
  assert.equal(diag.v, "2.1.0");
  assert.equal(diag.reason, "not_found");
  assert.deepEqual(diag.counts, { ok: 3, big: 10_000_000, n: 0 });
  assert.equal(diag.keys.length, 20);
  assert.deepEqual(diag.keys.slice(0, 3), ["ok.key", "#n.fine", "k0"]);
  // counts 는 8개까지만.
  const many = decode(encodeOptionFillDiag({ reason: "too_many", counts: Object.fromEntries("abcdefghijkl".split("").map((key, index) => [key, index])), keys: [] }));
  assert.deepEqual(Object.keys(many.counts), "abcdefgh".split(""));
  assert.equal(many.reason, "too_many");
});

test("진단 길이: 2000자(또는 주어진 상한)를 넘으면 keys 를 뒤에서부터 줄이고, 그래도 넘으면 빈 글자", () => {
  const keys = Array.from({ length: 20 }, (_, index) => `${String.fromCharCode(97 + index)}${"x".repeat(39)}`);
  const full = { reason: "ambiguous", counts: { nodes: 10_000_000, chosenCount: 51 }, keys };
  const encoded = encodeOptionFillDiag(full);
  assert.ok(encoded.length <= OPTION_FILL_DIAG_MAX_CHARS);
  assert.deepEqual(decode(encoded).keys, keys, "최대 크기 진단도 2000자 안이라 다 담긴다");
  const trimmed = encodeOptionFillDiag(full, { maxChars: 600 });
  assert.ok(trimmed.length <= 600);
  const kept = decode(trimmed).keys;
  assert.ok(kept.length > 0 && kept.length < keys.length);
  assert.deepEqual(kept, keys.slice(0, kept.length), "앞쪽 키를 남기고 뒤에서부터 줄인다");
  // 한 개라도 더 담으면 상한을 넘는다(필요한 만큼만 줄임).
  assert.ok(base64UrlAscii(JSON.stringify({ v: "2.1.0", reason: "ambiguous", counts: full.counts, keys: keys.slice(0, kept.length + 1) })).length > 600);
  assert.equal(encodeOptionFillDiag(full, { maxChars: 10 }), "");
});

test("확인 못 함 값: 2.r.<pageId>.<진단>, 해시 전체 2200자 이하, pageId 가 규칙 밖이면 빈 글자", () => {
  const keys = Array.from({ length: 20 }, (_, index) => `${String.fromCharCode(97 + index)}${"x".repeat(39)}`);
  const diag = { reason: "traversal_cap", counts: Object.fromEntries("abcdefgh".split("").map((key) => [key, 10_000_000])), keys };
  const pageId = "9".repeat(20);
  const payload = optionFillRefusedPayload(pageId, diag);
  const match = new RegExp(SPEC_REFUSED_SOURCE).exec(payload);
  assert.ok(match);
  assert.equal(match[1], pageId);
  assert.ok(payload.length <= OPTION_FILL_HASH_MAX_CHARS);
  assert.deepEqual(decode(match[2]).keys, keys);
  assert.equal(optionFillRefusedPayload("1234", diag), "");
  assert.equal(optionFillRefusedPayload(ISHELL_CURRENT, diag, { maxChars: 10 }), "");
  // 찾음 값 최대(51개·20자리)도 해시 상한 안이다.
  const found = optionFillFoundPayload(pageId, [pageId, ...Array.from({ length: 50 }, (_, index) => String(10n ** 19n + BigInt(index)))]);
  assert.ok(found && found.length <= OPTION_FILL_HASH_MAX_CHARS, String(found.length));
});
