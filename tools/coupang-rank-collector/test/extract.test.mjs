import assert from "node:assert/strict";
import test from "node:test";
import { AD_SOURCE_TYPE, ADS_MAX, ORGANIC_MAX, TITLE_MAX, clipTitle } from "../lib/contract.mjs";
import { EXTRACT_SOURCE, parseExtractResult, splitItems } from "../lib/extract.mjs";
import { fixture } from "./helpers.mjs";

const LONE_HIGH = String.fromCharCode(0xd83d);
const SMILE = String.fromCodePoint(0x1f600);

test("쪽 읽기 함수 원문: 광고 표식·제목 200자·차단 문구·화면을 바꾸지 않음", () => {
  assert.ok(EXTRACT_SOURCE.includes(`=== "${AD_SOURCE_TYPE}"`));
  assert.ok(EXTRACT_SOURCE.includes("li[class*=\"ProductUnit\"]"));
  assert.ok(EXTRACT_SOURCE.includes("a[href*=\"/vp/products/\"]"));
  assert.ok(EXTRACT_SOURCE.includes(".slice(0, 200)"));
  assert.ok(EXTRACT_SOURCE.includes("Access Denied|permission to access|비정상적인 접근|자동입력 방지|captcha"));
  assert.ok(EXTRACT_SOURCE.includes("검색결과가 없습니다"));
  assert.ok(EXTRACT_SOURCE.includes("로그인하고 더 많은 상품"));
  assert.doesNotMatch(EXTRACT_SOURCE, /\.click\(|scrollBy|location\.(?:href|assign|replace)\s*=|\.submit\(/);
  // 문자열로 보내므로 그대로 해석되어야 한다.
  assert.doesNotThrow(() => new Function(`return ${EXTRACT_SOURCE.slice(0, -2)}`));
});

test("고정본 page-full: 광고 10 + 일반 50, s 는 광고 포함 쪽 위치, 대상 상품 광고 8번째·일반 28위 자리", () => {
  const raw = parseExtractResult(JSON.stringify(fixture("page-full.json")));
  const split = splitItems(raw);
  assert.equal(split.itemCount, 60);
  assert.equal(split.ads.length, 10);
  assert.equal(split.organic.length, 50);
  const slots = [...split.ads, ...split.organic].map((item) => item.s).sort((a, b) => a - b);
  assert.deepEqual(slots, Array.from({ length: 60 }, (_, index) => index + 1));
  for (const list of [split.ads, split.organic]) {
    for (let index = 1; index < list.length; index += 1) assert.ok(list[index].s > list[index - 1].s);
  }
  const adHit = split.ads.findIndex((item) => item.p === "8533720933");
  assert.equal(adHit + 1, 8);
  assert.equal(split.ads[adHit].s, 22);
  const organicHit = split.organic.findIndex((item) => item.p === "8533720933");
  assert.equal(organicHit + 1, 28);
  assert.equal(split.organic[organicHit].s, 38);
  assert.equal(split.organic[organicHit].v, "96009802650");
  for (const item of [...split.ads, ...split.organic]) {
    assert.deepEqual(Object.keys(item).filter((key) => !["p", "v", "s", "t"].includes(key)), []);
    assert.match(item.p, /^[0-9]{4,15}$/);
    assert.match(item.v, /^[0-9]{0,20}$/);
  }
  assert.equal(raw.loginWall, true);
  assert.equal(raw.host, "www.coupang.com");
  assert.equal(raw.path, "/np/search");
});

test("고정본 page-no-result·page-short", () => {
  const none = splitItems(parseExtractResult(JSON.stringify(fixture("page-no-result.json"))));
  assert.deepEqual(none, { organic: [], ads: [], itemCount: 0 });
  assert.equal(parseExtractResult(JSON.stringify(fixture("page-no-result.json"))).noResultText, true);
  const short = splitItems(parseExtractResult(JSON.stringify(fixture("page-short.json"))));
  assert.equal(short.itemCount, 23);
  assert.equal(short.ads.length, 3);
  assert.equal(short.organic.length, 20);
  assert.ok(short.organic.some((item) => item.v === ""));
});

test("splitItems: 상품번호 형식이 틀린 항목은 빼되 위치는 걸러지기 전 순서, v 는 숫자 20자리까지만, 상한", () => {
  const raw = {
    items: [
      { p: "", v: "1", ad: false, t: "링크 없음" },
      { p: "123", v: "1", ad: false, t: "짧은 번호" },
      { p: "12345", v: "abc", ad: false, t: "옵션 이상" },
      { p: "123456", v: "1".repeat(21), ad: true, t: "" },
      { p: "1234567", v: "42", ad: false },
    ],
  };
  const split = splitItems(raw);
  assert.equal(split.itemCount, 5);
  assert.deepEqual(split.organic, [{ p: "12345", v: "", s: 3, t: "옵션 이상" }, { p: "1234567", v: "42", s: 5 }]);
  assert.deepEqual(split.ads, [{ p: "123456", v: "", s: 4 }]);
  const many = { items: Array.from({ length: 250 }, (_, index) => ({ p: String(10000 + index), v: "", ad: index % 5 === 0, t: "x" })) };
  const capped = splitItems(many);
  assert.equal(capped.itemCount, 200);
  assert.ok(capped.organic.length <= ORGANIC_MAX);
  assert.ok(capped.ads.length <= ADS_MAX);
  assert.ok([...capped.organic, ...capped.ads].every((item) => item.s <= 200));
});

test("parseExtractResult: 모양이 틀리면 extract_failed", () => {
  for (const value of [undefined, 3, "not json", JSON.stringify({ items: "x" }), JSON.stringify(null)]) {
    assert.throws(() => parseExtractResult(value), (error) => error.code === "extract_failed");
  }
});

test("clipTitle: 80 코드 포인트, 이모지 경계, 홀로 남은 서러게이트, 빈 문자열", () => {
  assert.equal(clipTitle(""), "");
  assert.equal(clipTitle("   "), "");
  assert.equal(clipTitle(null), "");
  const eightyOne = "가".repeat(81);
  assert.equal(Array.from(clipTitle(eightyOne)).length, TITLE_MAX);
  const emojis = SMILE.repeat(81);
  const clipped = clipTitle(emojis);
  assert.equal(Array.from(clipped).length, 80);
  assert.ok(clipped.isWellFormed());
  assert.equal(clipped.length, 160);
  const lone = `상품${LONE_HIGH}이름`;
  const fixed = clipTitle(lone);
  assert.ok(fixed.isWellFormed());
  assert.equal(Array.from(fixed).length, 5);
  // 쪽 함수는 UTF-16 200 단위로 자르므로 이모지가 반으로 잘릴 수 있다. 다듬은 뒤에는 늘 올바른 UTF-16 이다.
  const halfCut = `${"a".repeat(199)}${SMILE}`.slice(0, 200);
  assert.equal(halfCut.isWellFormed(), false);
  assert.ok(clipTitle(halfCut).isWellFormed());
  const split = splitItems({ items: [{ p: "12345", v: "", ad: false, t: halfCut }] });
  assert.ok(split.organic[0].t.isWellFormed());
  assert.equal(Array.from(split.organic[0].t).length, 80);
});
