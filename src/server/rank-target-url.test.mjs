import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RANK_PRODUCT_URL_REJECTION_MESSAGE,
  rankProductUrlRejection,
  rankProductUrlShape,
} from "./rank-target-url.mjs";

// 실제로 등록에 쓰이는 형태(저장소 전체에서 확인된 product_url 모양 + 윈도우 상품).
const REGISTRABLE = [
  "https://smartstore.naver.com/haedenprime/products/12149720593",
  "https://m.smartstore.naver.com/sample-store/products/1234567890",
  "https://brand.naver.com/lav/products/5145848584",
  "https://smartstore.naver.com/haedenprime/products/12149720593?NaPm=ct%3Dabc",
  "https://search.shopping.naver.com/catalog/57907660073",
  "https://shopping.naver.com/catalog/59776958987?query=%EC%B0%9C%EC%A7%88%EA%B8%B0",
  // 윈도우 상품처럼 /products/ 를 쓰지 않는 정상 상품 URL(8자리 폴백이 있는 이유).
  "https://shopping.naver.com/window-products/style/12345678",
  // 신뢰 호스트가 아니면 판정하지 않는다(단축링크 + 숫자 상품ID 등록 형태).
  "https://naver.me/example",
  "https://merchant.example/items/shared",
  "12149720593",
  "",
];

const REJECTED = [
  "https://shopping.naver.com/ns/category/50000167",
  "https://smartstore.naver.com/haedenprime/category/50000000",
  "https://brand.naver.com/lav/category/12345678",
  "https://search.shopping.naver.com/search/all?query=%EC%B0%9C%EC%A7%88%EA%B8%B0",
  "https://shopping.naver.com/plan2/p/index.naver?planId=12345678",
  "https://shopping.naver.com/exhibition/12345678",
  "https://shopping.naver.com/best/12345678",
];

test("정상 등록 형태는 하나도 막히지 않는다", () => {
  REGISTRABLE.forEach((url) => {
    assert.equal(rankProductUrlRejection(url), "", `막히면 안 되는 URL: ${url}`);
  });
});

test("카테고리·검색·기획전 URL 은 안내와 함께 막힌다", () => {
  REJECTED.forEach((url) => {
    assert.equal(rankProductUrlRejection(url), RANK_PRODUCT_URL_REJECTION_MESSAGE, `막아야 하는 URL: ${url}`);
    assert.equal(rankProductUrlShape(url).ok, false);
  });
  assert.equal(RANK_PRODUCT_URL_REJECTION_MESSAGE, "상품 URL 또는 원부(카탈로그) URL을 입력해주세요.");
});

test("정식 상품·원부 경로는 금지 낱말이 섞여 있어도 통과한다", () => {
  // 판정 순서(정식 경로 우선)가 무너지면 정상 등록이 막힌다.
  assert.equal(rankProductUrlShape("https://search.shopping.naver.com/catalog/57907660073").kind, "canonical");
  assert.equal(rankProductUrlShape("https://smartstore.naver.com/best-store/products/12149720593").ok, true);
  assert.equal(rankProductUrlShape("https://shopping.naver.com/plan/products/12149720593").ok, true);
});

test("경로에 식별자가 없으면 이 게이트가 아니라 기존 게이트가 판정한다", () => {
  // hasDirectTarget 이 없는 URL 은 createTracker 의 기존 400 이 처리한다.
  assert.deepEqual(rankProductUrlShape("https://smartstore.naver.com/haedenprime"), { ok: true, kind: "no-path-id" });
  assert.equal(rankProductUrlShape("https://naver.me/example").kind, "untrusted-host");
  // 숫자만 있는 값은 URL 로 해석되지 않는다(상품ID 직접 입력 경로).
  assert.equal(rankProductUrlShape("12149720593").kind, "not-a-url");
});

test("신뢰 호스트 목록은 식별자 추출 쪽과 같은 집합을 쓴다", async () => {
  const shoppingRank = await readFile(new URL("./handlers/naver-shopping-rank.mjs", import.meta.url), "utf8");
  const validator = await readFile(new URL("./rank-target-url.mjs", import.meta.url), "utf8");
  // 두 목록이 갈라지면 식별자는 뽑히는데 등록은 막히는(또는 그 반대) 상태가 된다.
  const hosts = (source) => {
    const start = source.indexOf("function isTrustedNaverShoppingProductHost(value) {");
    assert.notEqual(start, -1, "신뢰 호스트 판정 함수를 찾지 못했습니다.");
    const block = source.slice(start, source.indexOf("\n}", start));
    return [...block.matchAll(/"([a-z.]*naver\.com)"/g)].map((match) => match[1]).sort();
  };
  const shoppingHosts = hosts(shoppingRank);
  assert.equal(shoppingHosts.length, 5);
  assert.deepEqual(hosts(validator), shoppingHosts);
});
