import assert from "node:assert/strict";
import test from "node:test";
import {
  coupangKeywordKey,
  isUuid,
  normalizeCoupangGroupName,
  normalizeCoupangKeyword,
  parseCoupangProductInput,
  parseIdList,
} from "./inputs.mjs";
import { DEFAULT_GROUP, KEYWORD_KEY_CASE_FOLD } from "./contract.mjs";

test("키워드: NFC·공백류(전각·탭·줄바꿈)를 한 칸으로 바꾸고 trim", () => {
  assert.deepEqual(normalizeCoupangKeyword("  아이폰　 18프로\t사생활\n보호  필름 "), {
    ok: true,
    value: "아이폰 18프로 사생활 보호 필름",
  });
  // 조합형(NFD) 한글 → NFC
  const decomposed = "각";
  assert.equal(normalizeCoupangKeyword(decomposed).value, "각");
});

test("키워드: 빈값은 REQUIRED, 50자 초과·주소 모양은 INVALID", () => {
  for (const value of ["", "   ", "　\t\n", null, undefined]) {
    assert.equal(normalizeCoupangKeyword(value).code, "COUPANG_KEYWORD_REQUIRED", JSON.stringify(value));
  }
  assert.equal(normalizeCoupangKeyword("가".repeat(50)).ok, true);
  assert.equal(normalizeCoupangKeyword("가".repeat(51)).code, "COUPANG_KEYWORD_INVALID");
  // 코드 포인트 기준(DB char_length 와 같음): 이모지 50개는 통과
  assert.equal(normalizeCoupangKeyword("😀".repeat(50)).ok, true);
  assert.equal(normalizeCoupangKeyword("😀".repeat(51)).code, "COUPANG_KEYWORD_INVALID");
  for (const value of [
    "https://www.coupang.com/vp/products/1234",
    "http://example.com",
    "HTTPS://x",
    "www.coupang.com/vp/products/1234",
    "필름 coupang.com/np/search",
  ]) {
    assert.equal(normalizeCoupangKeyword(value).code, "COUPANG_KEYWORD_INVALID", value);
  }
  assert.equal(normalizeCoupangKeyword("\ud800필름").code, "COUPANG_KEYWORD_INVALID");
  assert.equal(normalizeCoupangKeyword({ text: "필름" }).code, "COUPANG_KEYWORD_INVALID");
  assert.equal(normalizeCoupangKeyword("필름\u0000").code, "COUPANG_KEYWORD_INVALID");
});

test("키워드 열쇠: KEYWORD_KEY_CASE_FOLD 이면 소문자", () => {
  assert.equal(KEYWORD_KEY_CASE_FOLD, true);
  assert.equal(coupangKeywordKey("iPhone 18 Pro 필름"), "iphone 18 pro 필름");
  assert.equal(coupangKeywordKey("아이폰"), "아이폰");
});

test("상품 입력 표의 모든 행", () => {
  const productUrl = (id) => `https://www.coupang.com/vp/products/${id}`;
  // trim 뒤 빈값
  assert.equal(parseCoupangProductInput("   ").code, "COUPANG_PRODUCT_URL_REQUIRED");
  assert.equal(parseCoupangProductInput(undefined).code, "COUPANG_PRODUCT_URL_REQUIRED");
  // 숫자만 4~15자리
  assert.deepEqual(parseCoupangProductInput(" 8533720933 "), {
    ok: true, productId: "8533720933", vendorItemId: null, productUrl: productUrl("8533720933"),
  });
  assert.equal(parseCoupangProductInput("1234").productId, "1234");
  assert.equal(parseCoupangProductInput("123456789012345").productId, "123456789012345");
  assert.equal(parseCoupangProductInput("123").code, "COUPANG_NOT_PRODUCT_URL");
  assert.equal(parseCoupangProductInput("1234567890123456").code, "COUPANG_NOT_PRODUCT_URL");
  // www.·coupang.com·m.coupang.com 으로 시작 → https:// 를 붙여 해석
  assert.deepEqual(parseCoupangProductInput("www.coupang.com/vp/products/8533720933?itemId=1&vendorItemId=96009802650"), {
    ok: true, productId: "8533720933", vendorItemId: "96009802650", productUrl: productUrl("8533720933"),
  });
  assert.equal(parseCoupangProductInput("coupang.com/vp/products/8533720933").productId, "8533720933");
  assert.equal(parseCoupangProductInput("m.coupang.com/vm/products/8533720933?vendorItemId=1").vendorItemId, "1");
  // 짧은 링크
  for (const value of ["https://link.coupang.com/a/bCdEf", "link.coupang.com/a/x", "https://coupa.ng/abc", "coupa.ng/abc"]) {
    assert.equal(parseCoupangProductInput(value).code, "COUPANG_SHORT_LINK_UNSUPPORTED", value);
  }
  // 쿠팡 상품 경로(vp/vm)
  const full = parseCoupangProductInput("https://www.coupang.com/vp/products/8533720933?itemId=1&vendorItemId=96009802650");
  assert.deepEqual(full, { ok: true, productId: "8533720933", vendorItemId: "96009802650", productUrl: productUrl("8533720933") });
  assert.equal(parseCoupangProductInput("https://m.coupang.com/vm/products/8533720933").productId, "8533720933");
  assert.equal(parseCoupangProductInput("http://coupang.com/vp/products/8533720933/").productId, "8533720933");
  // vendorItemId 는 숫자 1~20자리일 때만
  assert.equal(parseCoupangProductInput("https://www.coupang.com/vp/products/8533720933?vendorItemId=abc").vendorItemId, null);
  assert.equal(parseCoupangProductInput(`https://www.coupang.com/vp/products/8533720933?vendorItemId=${"1".repeat(21)}`).vendorItemId, null);
  // 그 밖(검색·카테고리·기획전·다른 사이트)
  for (const value of [
    "https://www.coupang.com/np/search?q=%ED%95%84%EB%A6%84",
    "https://www.coupang.com/np/categories/12345",
    "https://www.coupang.com/np/campaigns/82",
    "https://www.coupang.com/vp/products/123",
    "https://www.coupang.com/vp/products/8533720933/items",
    "https://smartstore.naver.com/x/products/8533720933",
    "https://www.coupang.com.evil.example/vp/products/8533720933",
    "https://user:pw@www.coupang.com/vp/products/8533720933",
    "https://www.coupang.com:8443/vp/products/8533720933",
    "ftp://www.coupang.com/vp/products/8533720933",
    "www.example.com/vp/products/8533720933",
    "아무 글",
  ]) {
    assert.equal(parseCoupangProductInput(value).code, "COUPANG_NOT_PRODUCT_URL", value);
  }
  assert.equal(parseCoupangProductInput({}).code, "COUPANG_NOT_PRODUCT_URL");
});

test("그룹: NFC·공백 한 칸·trim, 비면 기본 그룹, 30자 초과면 INVALID", () => {
  assert.deepEqual(normalizeCoupangGroupName("  필름　  케이스 "), { ok: true, value: "필름 케이스" });
  assert.deepEqual(normalizeCoupangGroupName(""), { ok: true, value: DEFAULT_GROUP });
  assert.deepEqual(normalizeCoupangGroupName(undefined), { ok: true, value: DEFAULT_GROUP });
  assert.equal(normalizeCoupangGroupName("가".repeat(30)).ok, true);
  assert.equal(normalizeCoupangGroupName("가".repeat(31)).code, "COUPANG_GROUP_INVALID");
  assert.equal(normalizeCoupangGroupName(["a"]).code, "COUPANG_GROUP_INVALID");
});

test("id 목록: uuid 검사·소문자·중복 제거·1~100개, id 하나도 받음", () => {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  assert.deepEqual(parseIdList({ ids: [id(1), id(1).toUpperCase(), id(2)] }), { ok: true, ids: [id(1), id(2)] });
  assert.deepEqual(parseIdList({ id: id(3) }), { ok: true, ids: [id(3)] });
  assert.equal(parseIdList({ ids: [] }).code, "COUPANG_IDS_INVALID");
  assert.equal(parseIdList({}).code, "COUPANG_IDS_INVALID");
  assert.equal(parseIdList({ ids: "x" }).code, "COUPANG_IDS_INVALID");
  assert.equal(parseIdList({ ids: ["not-a-uuid"] }).code, "COUPANG_IDS_INVALID");
  assert.equal(parseIdList({ ids: [1] }).code, "COUPANG_IDS_INVALID");
  const hundred = Array.from({ length: 100 }, (_, n) => id(n));
  assert.equal(parseIdList({ ids: hundred }).ids.length, 100);
  assert.equal(parseIdList({ ids: [...hundred, id(100)] }).code, "COUPANG_IDS_INVALID");
  // 중복을 지운 뒤 100개 이하면 통과
  assert.equal(parseIdList({ ids: [...hundred, ...hundred] }).ids.length, 100);
  assert.equal(isUuid(id(1)), true);
  assert.equal(isUuid(`${id(1)} `), false);
});
