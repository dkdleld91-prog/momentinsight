import assert from "node:assert/strict";
import test from "node:test";

import { renderedBoundaryDiagnostic } from "./naver-shopping-rendered-boundary-diagnostic.mjs";

const KEYWORD = "구조 검증";

function product(rank) {
  const sellerProductId = String(17000000000 + rank);
  return {
    type: "product",
    item: {
      collection: "product",
      rank,
      id: String(87000000000 + rank),
      parentCatalogId: "",
      mallId: "fixture",
      mallProductId: sellerProductId,
      stdCatalogMatchType: "0",
      productTitle: `fixture ${rank}`,
      mallProductUrl: `https://smartstore.naver.com/fixture/products/${sellerProductId}`,
      imageUrl: `https://shopping-phinf.pstatic.net/fixture/${rank}.jpg`,
      mallName: "fixture",
      lowPrice: String(10_000 + rank),
    },
  };
}

function ad(rank, page) {
  return {
    type: "product",
    item: {
      collection: "product",
      rank,
      adId: `fixture-ad-${page}`,
    },
  };
}

function page(pageIndex, firstRank) {
  const payload = {
    props: {
      pageProps: {
        searchParam: {
          sort: "rel",
          pagingIndex: pageIndex,
          pagingSize: 40,
          viewType: "list",
          productSet: "total",
          query: KEYWORD,
        },
        compositeList: {
          total: 300,
          list: [
            ad(pageIndex === 1 ? 1 : 41, pageIndex),
            ...Array.from({ length: 40 }, (_, index) => product(firstRank + index)),
          ],
        },
      },
    },
  };
  return { pageIndex, nextDataText: JSON.stringify(payload) };
}

test("projects only bounded numeric page-boundary evidence", () => {
  const result = renderedBoundaryDiagnostic([
    page(1, 1),
    page(2, 42),
  ], { keyword: KEYWORD, pass: 1 });

  assert.deepEqual(result, {
    pass: 1,
    pages: [
      {
        page: 1,
        organic: 40,
        ad: 1,
        helper: 0,
        first: 1,
        last: 40,
        gap: 1,
        limit: 1,
      },
      {
        page: 2,
        organic: 40,
        ad: 1,
        helper: 0,
        first: 42,
        last: 81,
        gap: 2,
        limit: 3,
      },
    ],
  });

  assert.deepEqual(Object.keys(result), ["pass", "pages"]);
  assert.deepEqual(
    Object.keys(result.pages[0]),
    ["page", "organic", "ad", "helper", "first", "last", "gap", "limit"],
  );

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /(?:nextData|rawRankDigest|keyword|product|seller|catalog|title|image|url|cookie|token|identity)/iu,
  );
});

test("reports an unexplained page-2 gap without altering or accepting it", () => {
  const result = renderedBoundaryDiagnostic([
    page(1, 1),
    page(2, 50),
  ], { keyword: KEYWORD, pass: 2 });

  assert.equal(result.pages[1].gap, 10);
  assert.equal(result.pages[1].limit, 3);
  assert.equal(Object.hasOwn(result.pages[1], "accepted"), false);
});

test("fails closed outside one exact two-page, two-pass diagnostic", () => {
  assert.throws(
    () => renderedBoundaryDiagnostic([page(1, 1)], { keyword: KEYWORD, pass: 1 }),
    /rendered_boundary_page_count_invalid/u,
  );
  assert.throws(
    () => renderedBoundaryDiagnostic([page(1, 1), page(2, 41)], { keyword: KEYWORD, pass: 3 }),
    /rendered_boundary_pass_invalid/u,
  );
  assert.throws(
    () => renderedBoundaryDiagnostic([page(2, 1), page(1, 41)], { keyword: KEYWORD, pass: 1 }),
    /rendered_boundary_page_order_invalid/u,
  );
});
