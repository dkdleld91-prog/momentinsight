import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  buildChromeSchedulerPlist,
  deriveChromeExtensionId,
  installChromeBridge,
  resolveChromeApplicationPath,
  resolveChromeProfileDirectory,
} from "./install-naver-shopping-chrome-bridge.mjs";
import {
  COLLECTION_PROTOCOL,
  assertNativeExchangeRequestId,
  buildNativeWindowFromPages,
  buildNativeWindowFromRows,
  createChromeNativeProvider,
  createNativePageStreamCollector,
  resolveNativeExchangeWait,
  validateCollectionProtocolAck,
} from "./naver-shopping-native-host-core.mjs";
import {
  SCHEMA_VERSION,
  STABLE_FINITE_WINDOW_PROOF_VERSION,
} from "../tools/naver-shopping-rank-collector/src/contract.mjs";

function assertZshSyntax(scriptPath, source) {
  const lint = spawnSync("/bin/zsh", ["-n", scriptPath], { encoding: "utf8" });
  if (lint.error?.code === "ENOENT") {
    assert.match(source, /^#!\/bin\/zsh\r?\n/u);
    assert.doesNotMatch(source, /\r/u);
    return;
  }
  assert.equal(lint.status, 0, lint.stderr);
}

function nativeMessageFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function decodeNativeMessageFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    assert.ok(offset + 4 <= buffer.length);
    const length = buffer.readUInt32LE(offset);
    const end = offset + 4 + length;
    assert.ok(end <= buffer.length);
    messages.push(JSON.parse(buffer.subarray(offset + 4, end).toString("utf8")));
    offset = end;
  }
  return messages;
}

const KEYWORD = "온열찜질기";

function request(nowMs) {
  return {
    schemaVersion: SCHEMA_VERSION,
    keyword: KEYWORD,
    limit: 300,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: new Date(nowMs + 180_000).toISOString(),
  };
}

function productItem(rank) {
  const sellerProductId = rank === 91 ? "12149720593" : String(13000000000 + rank);
  return {
    collection: "product",
    rank,
    id: String(80000000000 + rank),
    parentCatalogId: "",
    mallId: "ncp_fixture_01",
    mallProductId: sellerProductId,
    stdCatalogMatchType: "0",
    productTitle: rank === 91 ? "일신한일의료기 온열찜질기" : `온열찜질기 테스트 ${rank}`,
    mallPcUrl: `https://smartstore.naver.com/example/products/${sellerProductId}`,
    imageUrl: `https://shopping-phinf.pstatic.net/main/${rank}.jpg`,
    mallName: "테스트몰",
    brand: "테스트",
    maker: "테스트",
    category1Name: "생활/건강",
    category2Name: "냉온/찜질용품",
    category3Name: "찜질기",
    category4Name: "",
    lowPrice: 10000 + rank,
  };
}

function page(pageIndex, options = {}) {
  const startRank = ((pageIndex - 1) * 40) + 1;
  const list = [0, 1, 2, 3].map((index) => ({
    type: "product",
    item: {
      collection: "product",
      adId: `ad-${pageIndex}-${index}`,
    },
  }));
  for (let offset = 0; offset < 40; offset += 1) {
    const rank = startRank + offset;
    list.push({ type: "product", item: productItem(rank) });
  }
  if (options.driftRank) list[4].item.rank = options.driftRank;
  return {
    pageIndex,
    nextDataText: JSON.stringify({
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
          compositeList: { total: 204582, list },
        },
      },
    }),
  };
}

function finiteMarketPages(total) {
  return Array.from({ length: 8 }, (_, index) => {
    const payload = page(index + 1);
    const data = JSON.parse(payload.nextDataText);
    const startRank = index * 40;
    const remaining = Math.max(0, total - startRank);
    const organicCount = Math.min(40, remaining);
    data.props.pageProps.compositeList.total = total;
    data.props.pageProps.compositeList.list = data.props.pageProps.compositeList.list
      .filter(({ item }) => item.adId || (Number(item.rank) > startRank && Number(item.rank) <= startRank + organicCount));
    return { ...payload, nextDataText: JSON.stringify(data) };
  });
}

function finiteMarketStrongIdentityVariant(total, variant) {
  const pages = finiteMarketPages(total);
  const data = JSON.parse(pages[0].nextDataText);
  const row = data.props.pageProps.compositeList.list.find((entry) => !entry.item.adId);
  const sellerProductId = String(23000000000 + variant);
  row.item.id = String(83000000000 + variant);
  row.item.mallProductId = sellerProductId;
  row.item.mallPcUrl = `https://smartstore.naver.com/example/products/${sellerProductId}`;
  pages[0].nextDataText = JSON.stringify(data);
  return pages;
}

function nplusRows() {
  const rows = [];
  let organicRank = 0;
  for (let rawRank = 1; organicRank < 300; rawRank += 1) {
    const isAd = rawRank % 21 === 0;
    if (isAd) {
      rows.push({
        extractionKey: `nplus:${rawRank}:ad-${rawRank}`,
        rawRank,
        isAd: true,
        payload: { adId: `nad-${rawRank}`, contentType: "SA_prod" },
      });
      continue;
    }
    organicRank += 1;
    const sellerProductId = String(14000000000 + organicRank);
    const catalogId = organicRank % 3 === 0 ? String(51000000000 + organicRank) : "";
    rows.push({
      extractionKey: `nplus:${rawRank}:organic-${organicRank}`,
      rawRank,
      isAd: false,
      title: `네이버플러스 테스트 상품 ${organicRank}`,
      mallName: "테스트몰",
      links: [`https://smartstore.naver.com/example/products/${sellerProductId}`],
      payload: {
        productName: `네이버플러스 테스트 상품 ${organicRank}`,
        nvMid: String(91000000000 + organicRank),
        channelProductNo: sellerProductId,
        catalogId,
        linkedCatalogId: catalogId,
        productType: catalogId ? 3 : 2,
        mallName: "테스트몰",
        lowPrice: String(10000 + organicRank),
      },
    });
  }
  return rows;
}

test("native page stream accepts the exact requested suffix", () => {
  const collector = createNativePageStreamCollector({ pageStart: 6, pageEnd: 8 });
  [6, 7, 8].forEach((pageIndex) => collector.append(page(pageIndex)));

  assert.deepEqual(collector.complete().map(({ pageIndex }) => pageIndex), [6, 7, 8]);
});

test("native page stream accepts a complete compatibility window for a suffix request", () => {
  const collector = createNativePageStreamCollector({
    pageStart: 6,
    pageEnd: 8,
    allowFullCompatibility: true,
  });
  Array.from({ length: 8 }, (_, index) => page(index + 1))
    .forEach((payload) => collector.append(payload));

  assert.deepEqual(
    collector.complete().map(({ pageIndex }) => pageIndex),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test("native page stream rejects a full compatibility window after the first suffix", () => {
  const collector = createNativePageStreamCollector({
    pageStart: 6,
    pageEnd: 8,
    allowFullCompatibility: false,
  });

  assert.throws(
    () => collector.append(page(1)),
    (error) => error?.code === "native_host_pages_out_of_order",
  );
});

test("native page stream rejects an invalid suffix frame order", () => {
  const collector = createNativePageStreamCollector({ pageStart: 6, pageEnd: 8 });
  collector.append(page(6));

  assert.throws(
    () => collector.append(page(8)),
    (error) => error?.code === "native_host_pages_out_of_order",
  );
});

test("native protocol handshake requires one exact range-v1 acknowledgement", () => {
  assert.equal(COLLECTION_PROTOCOL, "range-v1");
  assert.doesNotThrow(() => validateCollectionProtocolAck({
    action: "ready_ack",
    collectionProtocol: "range-v1",
  }));
  for (const message of [
    { action: "ready_ack" },
    { action: "ready_ack", collectionProtocol: "range-v0" },
    { action: "other", collectionProtocol: "range-v1" },
  ]) {
    assert.throws(
      () => validateCollectionProtocolAck(message),
      (error) => error?.code === "native_host_ready_ack_invalid",
    );
  }
});

test("native exchange rejects a wrong or missing request id immediately", () => {
  const expectedRequestId = "request-current";
  const valid = { type: "collection_complete", requestId: expectedRequestId };
  assert.equal(assertNativeExchangeRequestId(valid, expectedRequestId), valid);
  for (const response of [
    { type: "collection_page", requestId: "request-stale" },
    { type: "collection_complete" },
    null,
  ]) {
    assert.throws(
      () => assertNativeExchangeRequestId(response, expectedRequestId),
      (error) => error?.code === "native_host_request_id_mismatch",
    );
  }

  const nativeHost = fs.readFileSync(new URL("./naver-shopping-native-host.mjs", import.meta.url), "utf8");
  assert.match(nativeHost, /assertNativeExchangeRequestId\(response, requestId\)/u);
  assert.doesNotMatch(nativeHost, /response\?\.requestId !== requestId\) continue/u);
});

test("native exchange wait is clamped to one absolute request deadline", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  assert.deepEqual(resolveNativeExchangeWait(
    new Date(nowMs + 5_000).toISOString(),
    { nowMs, maximumMs: 14 * 60_000 },
  ), {
    timeoutMs: 5_000,
    timeoutCode: "provider_deadline_exceeded",
  });
  assert.deepEqual(resolveNativeExchangeWait(
    new Date(nowMs + (20 * 60_000)).toISOString(),
    { nowMs, maximumMs: 14 * 60_000 },
  ), {
    timeoutMs: 14 * 60_000,
    timeoutCode: "native_host_response_timeout",
  });
  assert.throws(
    () => resolveNativeExchangeWait(
      new Date(nowMs).toISOString(),
      { nowMs, maximumMs: 14 * 60_000 },
    ),
    (error) => error?.code === "provider_deadline_exceeded",
  );
});

test("builds one strict 300-rank window from the normal Chrome profile pages", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const result = buildNativeWindowFromPages(
    request(nowMs),
    Array.from({ length: 8 }, (_, index) => page(index + 1)),
    { nowMs },
  );
  assert.equal(result.checkedCount, 300);
  assert.equal(result.rawCount, 332);
  assert.equal(result.excludedAdCount, 32);
  assert.equal(result.items[90].organicRank, 91);
  assert.equal(result.items[90].sellerProductId, "12149720593");
  assert.match(result.collectionId, /^pw-chrome-/u);
});

test("fails closed without padding when Naver exposes fewer than 300 organic slots", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  for (const total of [37, 130]) {
    assert.throws(
      () => buildNativeWindowFromPages(request(nowMs), finiteMarketPages(total), { nowMs }),
      (error) => error?.code === "provider_partial_window" && error?.detail === `${total}/300`,
    );
  }
});

test("builds one strict 300-rank window from the Naver Plus virtual list", () => {
  const nowMs = Date.parse("2026-08-09T03:00:00.000Z");
  const result = buildNativeWindowFromRows(request(nowMs), nplusRows(), { nowMs });
  assert.equal(result.checkedCount, 300);
  assert.equal(result.rawCount, 314);
  assert.equal(result.excludedAdCount, 14);
  assert.equal(result.items[89].organicRank, 90);
  assert.equal(result.items[89].sellerProductId, "14000000090");
  assert.equal(result.items[89].catalogId, "51000000090");
  assert.match(result.collectionId, /^pw-chrome-/u);
});

test("fails closed when one Chrome page is missing or its absolute rank drifts", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  assert.throws(
    () => buildNativeWindowFromPages(
      request(nowMs),
      Array.from({ length: 7 }, (_, index) => page(index + 1)),
      { nowMs },
    ),
    /native_host_pages_incomplete/u,
  );
  const pages = Array.from({ length: 8 }, (_, index) => page(index + 1));
  pages[2] = page(3, { driftRank: 999 });
  assert.throws(
    () => buildNativeWindowFromPages(request(nowMs), pages, { nowMs }),
    /naver_next_data_rank_drift/u,
  );
});

test("native provider exchanges only a bounded public page collection", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let exchanged;
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      exchanged = message;
      return {
        type: "collection",
        pages: Array.from({ length: 8 }, (_, index) => page(index + 1)),
      };
    },
  });
  const result = await provider.collect(request(nowMs));
  assert.equal(exchanged.type, "collect");
  assert.equal(exchanged.request.keyword, KEYWORD);
  assert.equal(result.checkedCount, 300);
});

test("native provider discards one partial pass and retries one independent full window", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const partialPages = finiteMarketPages(137).map((payload) => {
    const data = JSON.parse(payload.nextDataText);
    for (const row of data.props.pageProps.compositeList.list) {
      if (row.item.adId) continue;
      const partialId = String(Number(row.item.mallProductId) + 1_000_000_000);
      row.item.mallProductId = partialId;
      row.item.mallPcUrl = `https://smartstore.naver.com/example/products/${partialId}`;
      row.item.productTitle = `discarded ${row.item.productTitle}`;
    }
    return { ...payload, nextDataText: JSON.stringify(data) };
  });
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return {
        type: "collection",
        captureId: `capture-pass-${messages.length}`,
        pages: messages.length === 1
          ? partialPages
          : Array.from({ length: 8 }, (_, index) => page(index + 1)),
      };
    },
  });

  const result = await provider.collect(request(nowMs));

  assert.equal(result.checkedCount, 300);
  assert.equal(result.items[0].sellerProductId, "13000000001");
  assert.doesNotMatch(result.items[0].title, /^discarded /u);
  assert.equal(result.crossPageProof, undefined);
  assert.deepEqual(messages.map(({ pageStart, pageEnd }) => [pageStart, pageEnd]), [
    [undefined, undefined],
    [1, 8],
  ]);
});

test("native provider reports the latest partial count after exactly one full retry", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return {
        type: "collection",
        captureId: `capture-pass-${messages.length}`,
        pages: finiteMarketPages(messages.length === 1 ? 137 : 30),
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_partial_window" && error?.detail === "30/300",
  );
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ pageStart, pageEnd }) => [pageStart, pageEnd]), [
    [undefined, undefined],
    [1, 8],
  ]);
});

test("native provider accepts one stable finite market only after two independent identical captures", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return {
        type: "collection",
        captureId: `finite-capture-${messages.length}`,
        pages: finiteMarketPages(93),
      };
    },
  });

  const result = await provider.collect(request(nowMs), { allowStableFinite: true });

  assert.equal(result.checkedCount, 93);
  assert.equal(result.marketTotal, 93);
  assert.equal(result.marketTotalStatus, "verified");
  assert.equal(result.sourceExhausted, true);
  assert.equal(result.finiteWindowProof?.version, STABLE_FINITE_WINDOW_PROOF_VERSION);
  assert.deepEqual(result.finiteWindowProof?.captureIds, ["finite-capture-1", "finite-capture-2"]);
  assert.equal(result.finiteWindowProof?.passDigests[0], result.finiteWindowProof?.passDigests[1]);
  assert.equal(messages.length, 2);
});

test("native provider uses a bounded third canary capture to prove A,B,A or A,B,B", async (t) => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  for (const scenario of [
    { name: "A,B,A", variants: [1, 2, 1], proofCaptures: [1, 3] },
    { name: "A,B,B", variants: [1, 2, 2], proofCaptures: [2, 3] },
  ]) {
    await t.test(scenario.name, async () => {
      const messages = [];
      const provider = createChromeNativeProvider({
        nowMs: () => nowMs,
        async exchange(message) {
          messages.push(message);
          assert.ok(messages.length <= 3, "stable-finite arbitration must never start a fourth capture");
          return {
            type: "collection",
            captureId: `finite-capture-${messages.length}`,
            pages: finiteMarketStrongIdentityVariant(
              93,
              scenario.variants[messages.length - 1],
            ),
          };
        },
      });

      const result = await provider.collect(request(nowMs), { allowStableFinite: true });

      assert.equal(result.checkedCount, 93);
      assert.equal(result.finiteWindowProof?.version, STABLE_FINITE_WINDOW_PROOF_VERSION);
      assert.equal(result.finiteWindowProof?.passCount, 2);
      assert.deepEqual(
        result.finiteWindowProof?.captureIds,
        scenario.proofCaptures.map((index) => `finite-capture-${index}`),
      );
      assert.equal(result.finiteWindowProof?.passDigests.length, 2);
      assert.equal(result.finiteWindowProof?.passDigests[0], result.finiteWindowProof?.passDigests[1]);
      assert.equal(messages.length, 3);
      assert.deepEqual(messages.slice(1).map(({ pageStart, pageEnd }) => [pageStart, pageEnd]), [
        [1, 8],
        [1, 8],
      ]);
    });
  }
});

test("native provider uses the third exact-canary capture when one of the first two passes overlaps", async (t) => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  for (const scenario of [
    { name: "overlap,A,A", sequence: ["overlap", "A", "A"], proofCaptures: [2, 3] },
    { name: "A,overlap,A", sequence: ["A", "overlap", "A"], proofCaptures: [1, 3] },
  ]) {
    await t.test(scenario.name, async () => {
      const messages = [];
      const provider = createChromeNativeProvider({
        nowMs: () => nowMs,
        async exchange(message) {
          messages.push(message);
          assert.ok(messages.length <= 3, "stable-finite arbitration must never start a fourth capture");
          const pass = scenario.sequence[messages.length - 1];
          return {
            type: "collection",
            captureId: `finite-capture-${messages.length}`,
            pages: pass === "overlap"
              ? overlapPages({ originPage: 6, collisionPage: 7 })
              : finiteMarketStrongIdentityVariant(93, 1),
          };
        },
      });

      const result = await provider.collect(request(nowMs), { allowStableFinite: true });

      assert.equal(result.checkedCount, 93);
      assert.equal(result.finiteWindowProof?.version, STABLE_FINITE_WINDOW_PROOF_VERSION);
      assert.equal(result.finiteWindowProof?.passCount, 2);
      assert.deepEqual(
        result.finiteWindowProof?.captureIds,
        scenario.proofCaptures.map((index) => `finite-capture-${index}`),
      );
      assert.equal(messages.length, 3);
    });
  }
});

test("native provider rejects A,B,C after exactly three canary captures even when titles and thumbnails match", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 3, "stable-finite arbitration must never start a fourth capture");
      return {
        type: "collection",
        captureId: `finite-capture-${messages.length}`,
        pages: finiteMarketStrongIdentityVariant(93, messages.length),
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs), { allowStableFinite: true }),
    (error) => error?.code === "provider_stable_finite_window_unproven",
  );
  assert.equal(messages.length, 3);
});

test("native provider requires all three canary capture ids to be pairwise distinct", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const variants = [1, 2, 2];
  const captureIds = ["finite-capture-1", "finite-capture-2", "finite-capture-1"];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 3, "stable-finite arbitration must never start a fourth capture");
      return {
        type: "collection",
        captureId: captureIds[messages.length - 1],
        pages: finiteMarketStrongIdentityVariant(93, variants[messages.length - 1]),
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs), { allowStableFinite: true }),
    (error) => error?.code === "provider_stable_finite_window_unproven",
  );
  assert.equal(messages.length, 3);
});

test("native provider fails closed when the third canary capture cannot start before the deadline guard", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let clock = nowMs;
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => clock,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 2, "deadline guard must prevent the third capture");
      const response = {
        type: "collection",
        captureId: `finite-capture-${messages.length}`,
        pages: finiteMarketStrongIdentityVariant(93, messages.length),
      };
      if (messages.length === 2) clock = nowMs + 178_000;
      return response;
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs), { allowStableFinite: true }),
    (error) => error?.code === "provider_deadline_exceeded",
  );
  assert.equal(messages.length, 2);
});

test("native provider keeps a stable finite market typed as partial unless the caller allowlists it", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let exchanges = 0;
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange() {
      exchanges += 1;
      return {
        type: "collection",
        captureId: `non-canary-finite-${exchanges}`,
        pages: finiteMarketPages(93),
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_partial_window" && error?.detail === "93/300",
  );
  assert.equal(exchanges, 2);
});

test("native finite proof rejects replayed captures and three-way exact relationship-id drift", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  for (const drift of ["capture", "relationship"]) {
    let exchanges = 0;
    const provider = createChromeNativeProvider({
      nowMs: () => nowMs,
      async exchange() {
        exchanges += 1;
        const pages = finiteMarketPages(93);
        const data = JSON.parse(pages[0].nextDataText);
        const row = data.props.pageProps.compositeList.list.find((entry) => !entry.item.adId);
        row.item.id = "59776958987";
        row.item.parentCatalogId = "";
        row.item.mallId = "naver_model";
        row.item.mallProductId = "";
        row.item.stdCatalogMatchType = "1";
        row.item.mallPcUrl = "https://search.shopping.naver.com/catalog/59776958987";
        row.item.lowMallList = [{ mallPid: drift === "relationship"
          ? ["13327339525", "99999999999", "88888888888"][exchanges - 1]
          : "13327339525" }];
        pages[0].nextDataText = JSON.stringify(data);
        return {
          type: "collection",
          captureId: drift === "capture" ? "finite-capture-replayed" : `finite-capture-${exchanges}`,
          pages,
        };
      },
    });

    await assert.rejects(
      () => provider.collect(request(nowMs), { allowStableFinite: true }),
      (error) => error?.code === "provider_stable_finite_window_unproven",
    );
    assert.equal(exchanges, drift === "capture" ? 2 : 3);
  }
});

test("native provider never starts a third pass when a partial retry needs stable proof", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return {
        type: "collection",
        captureId: `capture-pass-${messages.length}`,
        pages: messages.length === 1
          ? finiteMarketPages(137)
          : overlapPages({ originPage: 6, collisionPage: 7 }),
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_stable_window_unproven"
      && error?.detail === "page_budget",
  );
  assert.equal(messages.length, 2);
});

test("native provider does not retry a partial window near the absolute deadline", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let clockReads = 0;
  let exchanges = 0;
  const provider = createChromeNativeProvider({
    nowMs: () => (clockReads++ === 0 ? nowMs : nowMs + 178_000),
    async exchange() {
      exchanges += 1;
      return { type: "collection", pages: finiteMarketPages(137) };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_deadline_exceeded",
  );
  assert.equal(exchanges, 1);
});

function overlapPages({ originPage = 1, collisionPage = 2 } = {}) {
  const pages = Array.from({ length: 8 }, (_, index) => page(index + 1));
  const collision = JSON.parse(pages[collisionPage - 1].nextDataText);
  collision.props.pageProps.compositeList.list[4].item = productItem(((originPage - 1) * 40) + 1);
  collision.props.pageProps.compositeList.list[4].item.rank = ((collisionPage - 1) * 40) + 1;
  pages[collisionPage - 1].nextDataText = JSON.stringify(collision);
  return pages;
}

function duplicateRowPages(pageIndex = 7) {
  const pages = Array.from({ length: 8 }, (_, index) => page(index + 1));
  const duplicate = JSON.parse(pages[pageIndex - 1].nextDataText);
  duplicate.props.pageProps.compositeList.list[5].item = {
    ...duplicate.props.pageProps.compositeList.list[4].item,
    rank: ((pageIndex - 1) * 40) + 2,
  };
  pages[pageIndex - 1].nextDataText = JSON.stringify(duplicate);
  return pages;
}

test("native provider repairs an early transient overlap within the 16-page budget", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return {
        type: "collection",
        pages: messages.length === 1
          ? overlapPages()
          : Array.from({ length: 8 }, (_, index) => page(index + 1)),
      };
    },
  });

  assert.equal((await provider.collect(request(nowMs))).checkedCount, 300);
  assert.deepEqual(messages.map(({ pageStart, pageEnd }) => [pageStart, pageEnd]), [
    [undefined, undefined],
    [1, 8],
  ]);
});

test("native provider repairs a transient overlap with one independent full pass", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return {
        type: "collection",
        captureId: `capture-pass-${messages.length}`,
        pages: messages.length === 1
          ? overlapPages({ originPage: 6, collisionPage: 7 })
          : Array.from({ length: 8 }, (_, index) => page(index + 1)),
      };
    },
  });

  const result = await provider.collect(request(nowMs));
  assert.equal(result.checkedCount, 300);
  assert.equal(result.crossPageProof, undefined);
  assert.deepEqual(messages.map(({ pageStart, pageEnd }) => [pageStart, pageEnd]), [
    [undefined, undefined],
    [1, 8],
  ]);
});

test("native provider accepts a stable cross-page rank slot only after two identical full passes", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return {
        type: "collection",
        captureId: `capture-pass-${messages.length}`,
        pages: overlapPages({ originPage: 6, collisionPage: 7 }),
      };
    },
  });

  const result = await provider.collect(request(nowMs));
  assert.equal(result.checkedCount, 300);
  assert.equal(result.crossPageProof?.version, "stable-full-window-v1");
  assert.deepEqual(result.crossPageProof?.captureIds, ["capture-pass-1", "capture-pass-2"]);
  assert.equal(result.items[200].sellerProductId, result.items[240].sellerProductId);
  assert.deepEqual(result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1));
  assert.deepEqual(messages.map(({ pageStart, pageEnd, stableProofPass }) => (
    [pageStart, pageEnd, stableProofPass]
  )), [
    [undefined, undefined, undefined],
    [1, 8, 2],
  ]);
});

test("native provider rejects a one-slot drift between stable proof passes", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let exchanges = 0;
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange() {
      exchanges += 1;
      const pages = overlapPages({ originPage: 6, collisionPage: 7 });
      if (exchanges === 2) {
        const changed = JSON.parse(pages[1].nextDataText);
        changed.props.pageProps.compositeList.list[10].item.mallProductId = "19999999999";
        changed.props.pageProps.compositeList.list[10].item.mallPcUrl = "https://smartstore.naver.com/example/products/19999999999";
        pages[1].nextDataText = JSON.stringify(changed);
      }
      return { type: "collection", captureId: `capture-pass-${exchanges}`, pages };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_stable_window_unproven"
      && error?.detail === "digest_mismatch",
  );
  assert.equal(exchanges, 2);
});

test("native provider rejects replayed capture identity and never starts a third pass", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let exchanges = 0;
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange() {
      exchanges += 1;
      return {
        type: "collection",
        captureId: "capture-replayed",
        pages: overlapPages({ originPage: 7, collisionPage: 8 }),
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_stable_window_unproven"
      && error?.detail === "capture_ids",
  );
  assert.equal(exchanges, 2);
});

test("native provider requires the second proof pass to contain all eight pages", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let exchanges = 0;
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange() {
      exchanges += 1;
      return {
        type: "collection",
        captureId: `capture-pass-${exchanges}`,
        pages: overlapPages({ originPage: 6, collisionPage: 7 }).slice(0, exchanges === 1 ? 8 : 7),
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_stable_window_unproven"
      && error?.detail === "page_budget",
  );
  assert.equal(exchanges, 2);
});

test("native provider does not start a suffix exchange near the absolute request deadline", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let clockReads = 0;
  let exchanges = 0;
  const provider = createChromeNativeProvider({
    nowMs: () => (clockReads++ === 0 ? nowMs : nowMs + 178_000),
    async exchange() {
      exchanges += 1;
      return { type: "collection", pages: overlapPages({ originPage: 6, collisionPage: 7 }) };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_deadline_exceeded",
  );
  assert.equal(exchanges, 1);
});

test("native provider preserves a same-page duplicate rank slot without retrying or compressing", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let exchanges = 0;
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange() {
      exchanges += 1;
      return { type: "collection", pages: duplicateRowPages(7) };
    },
  });

  const result = await provider.collect(request(nowMs));

  assert.equal(exchanges, 1);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1));
  const repeatedRanks = result.items
    .filter((item, index, items) => (
      items.findIndex((candidate) => candidate.sellerProductId === item.sellerProductId) !== index
    ))
    .map((item) => item.organicRank);
  assert.equal(repeatedRanks.length, 1);
  const firstRank = result.items.find((item) => (
    item.sellerProductId === result.items[repeatedRanks[0] - 1].sellerProductId
  )).organicRank;
  assert.equal(Math.ceil(firstRank / 40), Math.ceil(repeatedRanks[0] / 40));
});

test("manifest public key produces a stable Chrome extension id", async () => {
  const manifest = await import("../tools/naver-shopping-chrome-extension/manifest.json", {
    with: { type: "json" },
  });
  assert.equal(deriveChromeExtensionId(manifest.default.key), "pflggephankeefaeoaafkmggampnaefm");
});

test("native host installs an independent protected runtime outside the repository", async (context) => {
  const homeDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mi-native-host-home-"));
  context.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  const repositoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = installChromeBridge({
    repositoryPath,
    homeDirectory,
    keychainReady: () => true,
    disableOldAutomaticWorker: false,
    installChromeScheduler: false,
  });
  const installedManifest = JSON.parse(fs.readFileSync(result.hostManifestPath, "utf8"));

  assert.equal(installedManifest.path, result.wrapperPath);
  assert.ok(result.wrapperPath.startsWith(path.join(homeDirectory, "Library", "Application Support", "MomentInsight")));
  assert.ok(!result.wrapperPath.startsWith(repositoryPath));
  assert.equal(fs.statSync(result.wrapperPath).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(result.runtimePath, "scripts", "naver-shopping-native-host.mjs")).mode & 0o777, 0o600);
  assert.deepEqual(installedManifest.allowed_origins, [
    "chrome-extension://pflggephankeefaeoaafkmggampnaefm/",
  ]);
});

test("normal Chrome scheduler prepares the approved profile before both KST slots", async (context) => {
  const homeDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mi-chrome-scheduler-home-"));
  context.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  const chromeApplicationPath = path.join(homeDirectory, "Desktop", "Google Chrome.app");
  const chromeExecutable = path.join(chromeApplicationPath, "Contents", "MacOS", "Google Chrome");
  fs.mkdirSync(path.dirname(chromeExecutable), { recursive: true });
  fs.writeFileSync(chromeExecutable, "#!/bin/sh\n", { mode: 0o700 });
  const localStatePath = path.join(homeDirectory, "Library", "Application Support", "Google", "Chrome", "Local State");
  fs.mkdirSync(path.dirname(localStatePath), { recursive: true });
  fs.writeFileSync(localStatePath, JSON.stringify({
    profile: { info_cache: { Default: { name: "동빈" }, "Profile 1": { name: "다른 프로필" } } },
  }));

  assert.equal(resolveChromeApplicationPath(homeDirectory), chromeApplicationPath);
  assert.equal(resolveChromeProfileDirectory(homeDirectory), "Default");
  const plist = buildChromeSchedulerPlist({
    wrapperPath: "/tmp/Moment Insight/run scheduler.sh",
    logDirectory: "/tmp/Moment Insight/logs",
  });
  assert.match(plist, /<integer>8<\/integer><key>Minute<\/key><integer>50<\/integer>/u);
  assert.match(plist, /<integer>14<\/integer><key>Minute<\/key><integer>50<\/integer>/u);
  assert.match(plist, /RunAtLoad/u);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/u);
});

test("native host wrapper uses a stable path, bounded jobs and safe local canary config", () => {
  const wrapperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-naver-shopping-native-host.sh");
  const source = fs.readFileSync(wrapperPath, "utf8");
  assert.match(source, /naver-shopping-native-host\.conf/u);
  assert.match(source, /MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS="1"/u);
  assert.match(source, /MI_NAVER_SHOPPING_WORKER_ROLE="standby"/u);
  assert.match(source, /127\\\.0\\\.0\\\.1\|localhost/u);
  assert.match(source, /naver-shopping-native-host\.log/u);
  assert.doesNotMatch(source, /WORKER_SECRET[^\n]*>>/u);
  assertZshSyntax(wrapperPath, source);
});

test("Chrome extension restores the direct eight-page price-comparison route with legacy pacing", () => {
  const extensionDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "naver-shopping-chrome-extension");
  const serviceWorker = fs.readFileSync(path.join(extensionDirectory, "service-worker.js"), "utf8");
  const popupHtml = fs.readFileSync(path.join(extensionDirectory, "popup.html"), "utf8");
  const popup = fs.readFileSync(path.join(extensionDirectory, "popup.js"), "utf8");
  const nativeHost = fs.readFileSync(new URL("./naver-shopping-native-host.mjs", import.meta.url), "utf8");
  const nativeHostCore = fs.readFileSync(new URL("./naver-shopping-native-host-core.mjs", import.meta.url), "utf8");
  const localWorker = fs.readFileSync(new URL("./naver-shopping-local-worker.mjs", import.meta.url), "utf8");
  const localWorkerContract = fs.readFileSync(new URL("../src/server/naver-shopping/local-worker-contract.mjs", import.meta.url), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDirectory, "manifest.json"), "utf8"));

  assert.equal(manifest.version, "1.1.16");
  assert.deepEqual(manifest.host_permissions, ["https://search.shopping.naver.com/*"]);
  assert.match(serviceWorker, /function searchUrl\(keyword, pageIndex\)/u);
  assert.match(serviceWorker, /new URL\("https:\/\/search\.shopping\.naver\.com\/search\/all"\)/u);
  assert.match(serviceWorker, /url\.searchParams\.set\("where", "all"\)/u);
  assert.match(serviceWorker, /url\.searchParams\.set\("frm", "NVSCTAB"\)/u);
  assert.match(serviceWorker, /url\.searchParams\.set\("pagingSize", "40"\)/u);
  assert.match(serviceWorker, /url\.searchParams\.set\("productSet", "total"\)/u);
  assert.match(serviceWorker, /url\.searchParams\.set\("sort", "rel"\)/u);
  assert.match(serviceWorker, /url\.searchParams\.set\("viewType", "list"\)/u);
  assert.match(serviceWorker, /PAGE_COUNT = 8/u);
  assert.match(serviceWorker, /for \(let pageIndex = pageStart; pageIndex <= pageEnd; pageIndex \+= 1\)/u);
  assert.match(serviceWorker, /PAGE_REQUEST_INTERVAL_MS = 3_500/u);
  assert.match(serviceWorker, /PAGE_REQUEST_JITTER_MS = 2_500/u);
  assert.match(serviceWorker, /chrome\.tabs\.create\(\{ url, active: false \}\)/u);
  assert.match(serviceWorker, /chrome\.tabs\.update\(tabId, \{ url, active: false \}\)/u);
  assert.doesNotMatch(serviceWorker, /www\.naver\.com|search\.naver\.com|네이버 가격비교 더보기|SEARCH_DWELL/u);
  assert.doesNotMatch(serviceWorker, /readPriceCompareEntry|waitForPriceCompareEntry|readNextPageTarget|naverSearchUrl/u);
  assert.match(serviceWorker, /PAGE_SCRIPT_TIMEOUT_MS = 15_000/u);
  assert.match(serviceWorker, /COLLECTION_TIMEOUT_MS = 12 \* 60_000/u);
  assert.match(serviceWorker, /naver_page_script_timeout/u);
  assert.match(serviceWorker, /provider_deadline_exceeded/u);
  assert.match(serviceWorker, /typedCollectionError\(error, collectionStageCode\)/u);
  assert.match(serviceWorker, /collectionStageCode = "naver_page_navigation_failed"/u);
  assert.match(serviceWorker, /collectionStageCode = "naver_page_script_failed"/u);
  assert.match(serviceWorker, /async function saveCollectionProgress\(pageIndex\)/u);
  assert.match(serviceWorker, /async function clearCompletedCollectionVerificationState\(\)/u);
  assert.match(serviceWorker, /await saveCollectionProgress\(pageIndex\)/u);
  assert.match(serviceWorker, /await clearCompletedCollectionVerificationState\(\)/u);
  assert.match(serviceWorker, /keepTabOpen = true;[\s\S]{0,180}surfaceVerificationTab\(tabId\)[\s\S]{0,220}throw typedError/u);
  assert.match(serviceWorker, /request\.limit !== 300/u);
  assert.match(serviceWorker, /request\.rankPolicy !== "organic_only"/u);
  assert.match(serviceWorker, /message\?\.type === "ready"/u);
  assert.match(serviceWorker, /COLLECTION_PROTOCOL = "range-v1"/u);
  assert.match(serviceWorker, /port\.postMessage\(nativeReadyAcknowledgement\(message\)\)/u);
  assert.match(serviceWorker, /\["rank-remote", \{ delayInMinutes: 1, periodInMinutes: 1 \}\]/u);
  assert.match(serviceWorker, /BASELINE_CADENCE_MINUTES = 10/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_MINUTES = 6/u);
  assert.match(serviceWorker, /\["rank-catch-up", \{ delayInMinutes: cadenceMinutes, periodInMinutes: cadenceMinutes \}\]/u);
  assert.match(serviceWorker, /naver_network_restricted/u);
  assert.match(nativeHost, /requireWakeSignal: trigger === "rank-remote"/u);
  assert.match(nativeHost, /runTrigger: trigger/u);
  assert.match(localWorker, /action: "claim-lane"/u);
  assert.match(localWorker, /action: "release-lane"/u);
  assert.match(localWorkerContract, /LOCAL_WORKER_REQUEST_TIMEOUT_MS = 14 \* 60_000/u);
  assert.match(
    localWorker,
    /NAVER_SHOPPING_PROVIDER_TIMEOUT_MS,\s*14 \* 60_000,\s*30_000,\s*14 \* 60_000/u,
  );
  assert.match(nativeHost, /RESPONSE_TIMEOUT_MS = 14 \* 60_000/u);
  assert.match(serviceWorker, /chrome\.runtime\.getManifest\(\)\.version/u);
  assert.match(serviceWorker, /crypto\.subtle\.digest\(\s*"SHA-256"/u);
  assert.match(serviceWorker, /port\.postMessage\(\{ action: "run", trigger, \.\.\.runtimeIdentity \}\)/u);
  assert.match(nativeHost, /async function runtimeIdentity\(start\)/u);
  assert.match(nativeHost, /native_host_runtime_identity_invalid/u);
  assert.match(nativeHost, /type: "ready", collectionProtocol: COLLECTION_PROTOCOL/u);
  assert.match(nativeHost, /validateCollectionProtocolAck\(readyAck\)/u);
  assert.ok(nativeHost.indexOf("validateCollectionProtocolAck(readyAck)")
    < nativeHost.indexOf("runLocalShoppingWorker({"));
  assert.match(nativeHost, /resolveNativeExchangeWait\(message\.request\?\.deadlineAt/u);
  assert.match(nativeHost, /nextMessage\(wait\.timeoutMs, wait\.timeoutCode\)/u);
  assert.match(nativeHostCore, /options\.allowFullCompatibility === true[\s\S]{0,100}requestedPageStart > 1[\s\S]{0,100}responsePageIndex === 1/u);
  assert.match(nativeHostCore, /responsePageStart = 1;[\s\S]{0,80}responsePageEnd = MAX_PAGES/u);
  assert.match(nativeHostCore, /PAGE_NAVIGATION_BUDGET = 16/u);
  assert.match(nativeHostCore, /stableProofPass: 2/u);
  assert.match(nativeHostCore, /buildStableFullWindowProof/u);
  assert.match(nativeHostCore, /pageStart: 1,[\s\S]{0,60}pageEnd: MAX_PAGES/u);
  assert.match(nativeHost, /captureId: requestId/u);
  assert.match(nativeHost, /allowFullCompatibility: message\.allowFullCompatibility === true/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\/naver-shopping-native-host-core\.mjs", import\.meta\.url\)\)/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\.\/src\/server\/local-worker-auth\.mjs", import\.meta\.url\)\)/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\.\/src\/server\/handlers\/naver-shopping-rank\.mjs", import\.meta\.url\)\)/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\.\/src\/server\/security\.mjs", import\.meta\.url\)\)/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\.\/src\/server\/naver-shopping\/source-status\.mjs", import\.meta\.url\)\)/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\.\/src\/server\/naver-shopping\/provider-runtime\.mjs", import\.meta\.url\)\)/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\.\/src\/server\/naver-shopping\/mobile-top-fallback\.mjs", import\.meta\.url\)\)/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\.\/tools\/naver-shopping-rank-collector\/src\/provider\.mjs", import\.meta\.url\)\)/u);
  assert.match(nativeHost, /sha256File\(new URL\("\.\.\/tools\/naver-shopping-rank-collector\/src\/contract\.mjs", import\.meta\.url\)\)/u);
  assert.match(
    nativeHost,
    /serviceWorkerSha256,[\s\S]{0,100}nativeHostSha256,[\s\S]{0,100}nativeHostCoreSha256,[\s\S]{0,100}localWorkerSha256,[\s\S]{0,100}localWorkerAuthSha256,[\s\S]{0,100}contractSha256,[\s\S]{0,100}shoppingRankHandlerSha256,[\s\S]{0,100}securitySha256,[\s\S]{0,100}sourceStatusSha256,[\s\S]{0,100}providerRuntimeSha256,[\s\S]{0,100}mobileTopFallbackSha256,[\s\S]{0,100}collectorProviderSha256,[\s\S]{0,100}collectorContractSha256,[\s\S]{0,40}\]\.join\("\\n"\)/u,
  );
  assert.match(nativeHost, /registerProgressSink\(sink\)/u);
  assert.match(nativeHost, /stage: "collect", page: page\.pageIndex/u);
  assert.match(serviceWorker, /type: "collection_page"/u);
  assert.match(serviceWorker, /pageStart: message\.pageStart, pageEnd: message\.pageEnd/u);
  assert.match(serviceWorker, /for \(let pageIndex = pageStart; pageIndex <= pageEnd; pageIndex \+= 1\)/u);
  assert.match(serviceWorker, /type: "collection_complete"/u);
  assert.match(nativeHost, /response\?\.type === "collection_page"/u);
  assert.match(nativeHost, /response\?\.type === "collection_complete"/u);
  assert.match(nativeHost, /native_host_input_closed/u);
  assert.match(nativeHost, /writeMessage\(\{ type: "ready", collectionProtocol: COLLECTION_PROTOCOL \}\)/u);
  assert.match(nativeHost, /const readyAck = await nextMessage\(30_000\)/u);
  assert.match(nativeHostCore, /native_host_ready_ack_invalid/u);
  assert.match(serviceWorker, /async function automaticVerificationCooldownActive\(trigger\)/u);
  assert.match(serviceWorker, /return verification\.blockedUntil > Date\.now\(\)/u);
  assert.match(serviceWorker, /return \{ ok: false, started: false, code: "naver_verification_cooldown" \}/u);
  assert.match(serviceWorker, /saveStatus\("standby", "다음 갱신 요청 대기 중"\)/u);
  assert.match(serviceWorker, /RUNNING_STATUS_STALE_MS = 20 \* 60_000/u);
  assert.match(serviceWorker, /updatedAt \+ RUNNING_STATUS_STALE_MS <= Date\.now\(\)/u);
  assert.match(serviceWorker, /saveStatus\("failed", "native_host_interrupted"\)/u);
  assert.match(serviceWorker, /return \{ ok: false, started: false, code: "already_running" \}/u);
  assert.match(serviceWorker, /if \(running\)[\s\S]{0,500}if \(pending\.queued\)[\s\S]{0,300}started: true,[\s\S]{0,120}queued: true/u);
  assert.match(serviceWorker, /return \{ ok: false, code: "native_host_already_running", summary: result \}/u);
  assert.doesNotMatch(serviceWorker, /onAlarm\.addListener\(\(alarm\) => \{\s*if \(RUN_ALARMS\.has\(alarm\.name\)\) runWorker/u);
  assert.deepEqual(
    Array.from(popupHtml.matchAll(/<script\s+src="([^"]+)"/gu), (match) => match[1]),
    ["popup.js"],
  );
  assert.match(popupHtml, /<button id="run" type="button">지금 안전 갱신<\/button>/u);
  assert.match(popup, /document\.getElementById\("run"\)/u);
  assert.match(popup, /chrome\.runtime\.sendMessage\(\{ action: "run-now" \}\)/u);
  assert.match(popup, /백그라운드에서 오가닉 순위를 확인합니다/u);
  assert.doesNotMatch(popup, /가격비교 탭이 열립니다/u);
  assert.doesNotMatch(popup, /controllerPage|runButton\.hidden/u);
  assert.match(serviceWorker, /function requestWorkerRun\(trigger\)/u);
  assert.match(serviceWorker, /if \(running\)[\s\S]{0,700}void runWorker\(trigger\)/u);
  assert.match(serviceWorker, /chrome\.alarms\.onAlarm\.addListener\([\s\S]{0,180}requestWorkerRun\(alarm\.name\)/u);
  assert.match(serviceWorker, /message\?\.action === "run-now"[\s\S]{0,180}requestWorkerRun\("manual"\)\.then\(sendResponse\)/u);
  assert.match(serviceWorker, /function removeLegacyControllerTabs\(/u);
  assert.doesNotMatch(serviceWorker, /ensureControllerTab|prepareControllerForDispatch|waitForControllerResumed|controller-run/u);
  assert.doesNotMatch(serviceWorker, /changeInfo\.frozen|autoDiscardable:\s*false/u);
  assert.doesNotMatch(serviceWorker, /chrome\.tabs\.create\(\{[\s\S]{0,160}popup\.html/u);
  const verificationSurfaceStart = serviceWorker.indexOf("async function surfaceVerificationTab(tabId)");
  const verificationSurfaceEnd = serviceWorker.indexOf("\nasync function ", verificationSurfaceStart + 1);
  assert.ok(verificationSurfaceStart >= 0 && verificationSurfaceEnd > verificationSurfaceStart);
  const verificationSurfaceSource = serviceWorker.slice(verificationSurfaceStart, verificationSurfaceEnd);
  assert.match(verificationSurfaceSource, /chrome\.windows\.update\(tab\.windowId, \{ state: "normal", focused: true \}\)/u);
  assert.match(verificationSurfaceSource, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/u);
  const nonVerificationSurfaceSource = `${serviceWorker.slice(0, verificationSurfaceStart)}${serviceWorker.slice(verificationSurfaceEnd)}`;
  assert.doesNotMatch(nonVerificationSurfaceSource, /active:\s*true/u);
  assert.doesNotMatch(nonVerificationSurfaceSource, /chrome\.windows\.update/u);
  const runWorkerSource = serviceWorker.slice(
    serviceWorker.indexOf('async function runWorker(trigger = "manual", options = {})'),
    serviceWorker.indexOf("chrome.runtime.onInstalled.addListener", serviceWorker.indexOf('async function runWorker(trigger = "manual", options = {})')),
  );
  assert.ok(runWorkerSource.indexOf("running = true") < runWorkerSource.indexOf("await verificationState()"));
  const workerRequestSource = serviceWorker.slice(
    serviceWorker.indexOf("function requestWorkerRun(trigger)"),
    serviceWorker.indexOf("function searchUrl"),
  );
  assert.ok(
    workerRequestSource.indexOf("automaticVerificationCooldownActive(trigger)")
      < workerRequestSource.indexOf("void runWorker(trigger)"),
  );
});

test("Chrome worker VM acknowledges only the exact range-v1 native protocol", () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const constantStart = serviceWorker.indexOf('const COLLECTION_PROTOCOL = "range-v1";');
  const constantEnd = serviceWorker.indexOf("\n", constantStart);
  const helperStart = serviceWorker.indexOf("function nativeReadyAcknowledgement(message)");
  const helperEnd = serviceWorker.indexOf("function startWorkerKeepAlive()", helperStart);
  assert.ok(constantStart >= 0 && constantEnd > constantStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const acknowledge = runInNewContext(
    `${serviceWorker.slice(constantStart, constantEnd)}\n${serviceWorker.slice(helperStart, helperEnd)}\nnativeReadyAcknowledgement;`,
  );

  assert.deepEqual(
    { ...acknowledge({ collectionProtocol: "range-v1" }) },
    { action: "ready_ack", collectionProtocol: "range-v1" },
  );
  assert.throws(
    () => acknowledge({}),
    /native_host_collection_protocol_mismatch/u,
  );
  assert.throws(
    () => acknowledge({ collectionProtocol: "range-v0" }),
    /native_host_collection_protocol_mismatch/u,
  );
});

test("candidate cadence requires durable post-failure atomic stability proof", async () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(serviceWorker, /CADENCE_CONFIRMED_AT_KEY/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_CONFIRMATION_TTL_MS = 20 \* 60_000/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_RESET_PENDING_KEY/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_STABILITY_STARTED_AT_KEY/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_SUCCESS_COUNT_KEY/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_REQUIRED_SUCCESSES = 6/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_STABILITY_MS = 24 \* 60 \* 60_000/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_RESET_PENDING_ALARM/u);
  assert.match(serviceWorker, /function cadenceFromWorkerSummary\(result\)/u);
  assert.match(serviceWorker, /function workerSummaryRequiresCadenceReset\(result\)/u);
  assert.match(
    serviceWorker,
    /async function markCandidateCadenceResetPending\(runtimeIdentity = null\)/u,
  );
  assert.match(serviceWorker, /async function updateCandidateCadenceEvidence\(result\)/u);
  assert.doesNotMatch(serviceWorker, /CANDIDATE_CADENCE_BLOCKED_UNTIL/u);

  const constantsStart = serviceWorker.indexOf("const BASELINE_CADENCE_MINUTES");
  const constantsEnd = serviceWorker.indexOf("// The Node host", constantsStart);
  const safeStart = serviceWorker.indexOf("async function safeCadenceMinutes");
  const safeEnd = serviceWorker.indexOf("async function configureAlarms", safeStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart);
  assert.ok(safeStart >= 0 && safeEnd > safeStart);

  let now = Date.parse("2026-08-21T07:00:00.000Z");
  const stored = {};
  const alarms = new Map();
  const runtimeIdentity = {
    runtimeVersion: "1.1.9",
    serviceWorkerSha256: "a".repeat(64),
  };
  let failRead = false;
  let failWrite = false;
  let failAlarmRead = false;
  let failAlarmCreate = false;
  let failAlarmClear = false;
  const createHelpers = () => runInNewContext(`
      ${serviceWorker.slice(constantsStart, constantsEnd)}
      ${serviceWorker.slice(safeStart, safeEnd)}
      ({
        safeCadenceMinutes,
        cadenceFromWorkerSummary,
        workerSummaryRequiresCadenceReset,
        markCandidateCadenceResetPending,
        updateCandidateCadenceEvidence,
      });
    `, {
      Date: { now: () => now },
      extensionRuntimeIdentity: async () => runtimeIdentity,
      chrome: {
        alarms: {
          async get(name) {
            if (failAlarmRead) throw new Error("alarm_read_failed");
            return alarms.get(name) || null;
          },
          async create(name, definition) {
            if (failAlarmCreate) throw new Error("alarm_create_failed");
            alarms.set(name, { name, ...definition });
          },
          async clear(name) {
            if (failAlarmClear) throw new Error("alarm_clear_failed");
            return alarms.delete(name);
          },
        },
        storage: {
          local: {
            async get(keys) {
              if (failRead) throw new Error("storage_read_failed");
              return Object.fromEntries(keys.map((key) => [key, stored[key]]));
            },
            async set(values) {
              if (failWrite) throw new Error("storage_write_failed");
              Object.assign(stored, values);
            },
          },
        },
      },
      stored,
      alarms,
    });
  let helpers = createHelpers();
  stored.momentInsightRankCadenceMinutes = 6;
  stored.momentInsightRankCadenceConfirmedAt = now;
  stored.momentInsightRankCandidateProofRuntimeVersion = runtimeIdentity.runtimeVersion;
  stored.momentInsightRankCandidateProofServiceWorkerSha256 = runtimeIdentity.serviceWorkerSha256;
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  assert.equal(await helpers.safeCadenceMinutes(), 10);
  for (const invalid of [null, 0, "false", "true"]) {
    stored.momentInsightRankCandidateResetPending = invalid;
    assert.equal(await helpers.safeCadenceMinutes(6), 10);
  }
  stored.momentInsightRankCandidateResetPending = false;
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  stored.momentInsightRankCandidateStabilityStartedAt = now - (24 * 60 * 60_000) - 1;
  stored.momentInsightRankCandidateSuccessCount = 5;
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  stored.momentInsightRankCandidateSuccessCount = 6;
  assert.equal(await helpers.safeCadenceMinutes(6), 6);
  assert.equal(await helpers.safeCadenceMinutes(), 6);
  helpers = createHelpers();
  assert.equal(await helpers.safeCadenceMinutes(6), 6);

  const failureSummary = {
    status: "completed",
    cadenceMinutes: 6,
    atomicSuccesses: 0,
    failed: 1,
    trackerPartialWindowFailures: 0,
    releaseFailed: 0,
    controlPlaneFailed: 0,
  };
  const successSummary = {
    status: "completed",
    cadenceMinutes: 6,
    atomicSuccesses: 1,
    failed: 0,
    trackerPartialWindowFailures: 0,
    releaseFailed: 0,
    controlPlaneFailed: 0,
  };
  const idleSummary = {
    status: "idle",
    cadenceMinutes: 10,
    atomicSuccesses: 0,
    failed: 0,
    trackerPartialWindowFailures: 0,
    releaseFailed: 0,
    controlPlaneFailed: 0,
  };
  assert.equal(await helpers.updateCandidateCadenceEvidence(failureSummary), false);
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  assert.equal(await helpers.updateCandidateCadenceEvidence(idleSummary), false);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  assert.equal(await helpers.updateCandidateCadenceEvidence(successSummary), false);
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, now);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 1);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await helpers.updateCandidateCadenceEvidence(successSummary), false);
  }
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 6);
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  now += 24 * 60 * 60_000 + 1;
  assert.equal(await helpers.updateCandidateCadenceEvidence(idleSummary), true);
  assert.equal(stored.momentInsightRankCandidateResetPending, false);
  assert.equal(alarms.has("rank-candidate-reset-pending"), false);
  assert.equal(await helpers.safeCadenceMinutes(6), 6);

  const trackerPartialWindowSummary = {
    status: "completed",
    cadenceMinutes: 6,
    atomicSuccesses: 0,
    failed: 1,
    trackerPartialWindowFailures: 1,
    releaseFailed: 0,
    controlPlaneFailed: 0,
  };
  const preservedProof = {
    resetPending: stored.momentInsightRankCandidateResetPending,
    startedAt: stored.momentInsightRankCandidateStabilityStartedAt,
    successCount: stored.momentInsightRankCandidateSuccessCount,
  };
  assert.equal(helpers.workerSummaryRequiresCadenceReset(trackerPartialWindowSummary), false);
  assert.equal(helpers.cadenceFromWorkerSummary(trackerPartialWindowSummary), 6);
  assert.equal(await helpers.updateCandidateCadenceEvidence(trackerPartialWindowSummary), true);
  assert.deepEqual({
    resetPending: stored.momentInsightRankCandidateResetPending,
    startedAt: stored.momentInsightRankCandidateStabilityStartedAt,
    successCount: stored.momentInsightRankCandidateSuccessCount,
  }, preservedProof);

  const trackerFiniteWindowSummary = {
    ...trackerPartialWindowSummary,
    trackerPartialWindowFailures: 0,
    trackerFiniteWindowFailures: 1,
  };
  assert.equal(helpers.workerSummaryRequiresCadenceReset(trackerFiniteWindowSummary), false);
  assert.equal(helpers.cadenceFromWorkerSummary(trackerFiniteWindowSummary), 6);
  assert.equal(await helpers.updateCandidateCadenceEvidence(trackerFiniteWindowSummary), true);
  assert.deepEqual({
    resetPending: stored.momentInsightRankCandidateResetPending,
    startedAt: stored.momentInsightRankCandidateStabilityStartedAt,
    successCount: stored.momentInsightRankCandidateSuccessCount,
  }, preservedProof);

  for (const summary of [
    { ...trackerPartialWindowSummary, trackerPartialWindowFailures: undefined },
    { ...trackerPartialWindowSummary, trackerPartialWindowFailures: "1" },
    { ...trackerPartialWindowSummary, trackerPartialWindowFailures: -1 },
    { ...trackerPartialWindowSummary, trackerPartialWindowFailures: 1.5 },
    { ...trackerPartialWindowSummary, trackerPartialWindowFailures: 0 },
    { ...trackerPartialWindowSummary, trackerPartialWindowFailures: 2 },
    { ...trackerFiniteWindowSummary, trackerFiniteWindowFailures: undefined },
    { ...trackerFiniteWindowSummary, trackerFiniteWindowFailures: "1" },
    { ...trackerFiniteWindowSummary, trackerFiniteWindowFailures: -1 },
    { ...trackerFiniteWindowSummary, trackerFiniteWindowFailures: 1.5 },
    { ...trackerFiniteWindowSummary, trackerFiniteWindowFailures: 0 },
    { ...trackerFiniteWindowSummary, trackerFiniteWindowFailures: 2 },
    { ...trackerPartialWindowSummary, failed: "1" },
    { ...trackerPartialWindowSummary, failed: 2 },
    { ...trackerPartialWindowSummary, releaseFailed: "0" },
    { ...trackerPartialWindowSummary, releaseFailed: 1 },
    { ...trackerPartialWindowSummary, controlPlaneFailed: "0" },
    { ...trackerPartialWindowSummary, controlPlaneFailed: 1 },
    { ...trackerPartialWindowSummary, atomicSuccesses: "0" },
    { ...trackerPartialWindowSummary, halted: true },
    { ...trackerPartialWindowSummary, haltedCode: "provider_partial_window:40_300" },
    { ...trackerPartialWindowSummary, status: "idle" },
  ]) {
    assert.equal(helpers.workerSummaryRequiresCadenceReset(summary), true);
    assert.equal(helpers.cadenceFromWorkerSummary(summary), 10);
  }

  for (const summary of [
    { status: "disabled", cadenceMinutes: 6, atomicSuccesses: 0 },
    { status: "control_plane_failed", cadenceMinutes: 6, atomicSuccesses: 0 },
    { status: "completed", cadenceMinutes: 6, atomicSuccesses: 0, failed: 1 },
    { status: "completed", cadenceMinutes: 6, atomicSuccesses: 0, releaseFailed: 1 },
    { status: "completed", cadenceMinutes: 6, atomicSuccesses: 0, halted: true },
    {
      status: "completed",
      cadenceMinutes: 6,
      atomicSuccesses: 0,
      haltedCode: "provider_deadline_exceeded",
    },
    { status: "completed", cadenceMinutes: 6, atomicSuccesses: 0, controlPlaneFailed: 1 },
    { status: "completed", cadenceMinutes: 6 },
    { status: "completed", cadenceMinutes: 6, atomicSuccesses: -1 },
    { status: "completed", cadenceMinutes: 6, atomicSuccesses: 1.5 },
    { status: "unexpected", cadenceMinutes: 6, atomicSuccesses: 0 },
  ]) {
    assert.equal(helpers.cadenceFromWorkerSummary(summary), 10);
    assert.equal(helpers.workerSummaryRequiresCadenceReset(summary), true);
  }
  for (const status of ["completed", "idle", "standby", "already_running"]) {
    const summary = {
      status,
      cadenceMinutes: 6,
      atomicSuccesses: status === "completed" ? 1 : 0,
      failed: 0,
      trackerPartialWindowFailures: 0,
      releaseFailed: 0,
      controlPlaneFailed: 0,
    };
    assert.equal(helpers.cadenceFromWorkerSummary(summary), 6);
    assert.equal(helpers.workerSummaryRequiresCadenceReset(summary), false);
  }

  failRead = true;
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  failRead = false;
  failAlarmRead = true;
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  failAlarmRead = false;

  Object.assign(stored, {
    momentInsightRankCandidateResetPending: false,
    momentInsightRankCandidateStabilityStartedAt: now - (24 * 60 * 60_000) - 1,
    momentInsightRankCandidateSuccessCount: 6,
  });
  alarms.clear();
  stored.momentInsightRankCandidateResetPending = false;
  helpers = createHelpers();
  failWrite = true;
  assert.equal(await helpers.updateCandidateCadenceEvidence(failureSummary), false);
  failWrite = false;
  assert.equal(stored.momentInsightRankCandidateResetPending, false);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);
  helpers = createHelpers();
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  assert.equal(await helpers.updateCandidateCadenceEvidence(idleSummary), false);
  assert.equal(await helpers.updateCandidateCadenceEvidence(successSummary), false);
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, now);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 1);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await helpers.updateCandidateCadenceEvidence(successSummary), false);
  }
  now += 24 * 60 * 60_000 + 1;
  assert.equal(await helpers.updateCandidateCadenceEvidence(idleSummary), true);
  assert.equal(alarms.has("rank-candidate-reset-pending"), false);
  assert.equal(await helpers.safeCadenceMinutes(6), 6);

  await helpers.updateCandidateCadenceEvidence(failureSummary);
  await helpers.updateCandidateCadenceEvidence(successSummary);
  for (let index = 0; index < 5; index += 1) {
    await helpers.updateCandidateCadenceEvidence(successSummary);
  }
  now += 24 * 60 * 60_000 + 1;
  failWrite = true;
  assert.equal(await helpers.updateCandidateCadenceEvidence(idleSummary), false);
  failWrite = false;
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(alarms.has("rank-candidate-reset-pending"), false);
  helpers = createHelpers();
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  assert.equal(await helpers.updateCandidateCadenceEvidence(idleSummary), true);
  assert.equal(stored.momentInsightRankCandidateResetPending, false);
  assert.equal(await helpers.safeCadenceMinutes(6), 6);

  await helpers.updateCandidateCadenceEvidence(failureSummary);
  await helpers.updateCandidateCadenceEvidence(successSummary);
  for (let index = 0; index < 5; index += 1) {
    await helpers.updateCandidateCadenceEvidence(successSummary);
  }
  now += 24 * 60 * 60_000 + 1;
  failAlarmClear = true;
  assert.equal(await helpers.updateCandidateCadenceEvidence(idleSummary), false);
  failAlarmClear = false;
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);
  helpers = createHelpers();
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
  assert.equal(await helpers.updateCandidateCadenceEvidence(idleSummary), true);
  assert.equal(stored.momentInsightRankCandidateResetPending, false);
  assert.equal(alarms.has("rank-candidate-reset-pending"), false);
  assert.equal(await helpers.safeCadenceMinutes(6), 6);

  stored.momentInsightRankCandidateResetPending = false;
  stored.momentInsightRankCandidateStabilityStartedAt = now - (24 * 60 * 60_000) - 1;
  stored.momentInsightRankCandidateSuccessCount = 6;
  alarms.clear();
  helpers = createHelpers();
  failAlarmCreate = true;
  assert.equal(await helpers.updateCandidateCadenceEvidence(failureSummary), false);
  failAlarmCreate = false;
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  helpers = createHelpers();
  assert.equal(await helpers.safeCadenceMinutes(6), 10);

  const evidenceStart = serviceWorker.indexOf("async function updateCandidateCadenceEvidence");
  const evidenceEnd = serviceWorker.indexOf("function cadenceFromWorkerSummary", evidenceStart);
  const evidenceSource = serviceWorker.slice(evidenceStart, evidenceEnd);
  assert.match(evidenceSource, /atomicSuccesses/u);
  assert.doesNotMatch(evidenceSource, /\b(?:claimed|submitted)\b/u);

  const configureStart = serviceWorker.indexOf("async function configureAlarms");
  const configureEnd = serviceWorker.indexOf("function isLegacyControllerTab", configureStart);
  const configureSource = serviceWorker.slice(configureStart, configureEnd);
  assert.match(
    configureSource,
    /catch \{[\s\S]{0,120}await markCandidateCadenceResetPending\(\)[\s\S]{0,120}cadenceMinutes = BASELINE_CADENCE_MINUTES/u,
  );

  const workerStart = serviceWorker.indexOf('async function runWorker(trigger = "manual"');
  const workerEnd = serviceWorker.indexOf("chrome.runtime.onInstalled.addListener", workerStart);
  const workerSource = serviceWorker.slice(workerStart, workerEnd);
  assert.match(workerSource, /updateCandidateCadenceEvidence\(result\)/u);
  assert.match(workerSource, /configureAlarms\(cadenceFromWorkerSummary\(result\)\)/u);
  assert.match(workerSource, /catch \(error\) \{[\s\S]{0,240}markCandidateCadenceResetPending\(\)[\s\S]{0,220}configureAlarms\(BASELINE_CADENCE_MINUTES\)/u);
});

test("worker initialization turns an interrupted native run into a durable baseline reset", async () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(serviceWorker, /async function initializeWorker\(\)/u);
  assert.match(serviceWorker, /let initializationPromise/u);

  const constantsStart = serviceWorker.indexOf("const BASELINE_CADENCE_MINUTES");
  const constantsEnd = serviceWorker.indexOf("// The Node host", constantsStart);
  const safeStart = serviceWorker.indexOf("async function safeCadenceMinutes");
  const safeEnd = serviceWorker.indexOf("function isLegacyControllerTab", safeStart);
  const statusStart = serviceWorker.indexOf('async function saveStatus(status, detail = "")');
  const statusEnd = serviceWorker.indexOf("function nativeDisconnectCode", statusStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart);
  assert.ok(safeStart >= 0 && safeEnd > safeStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);

  let now = Date.parse("2026-08-21T07:00:00.000Z");
  const runtimeIdentity = {
    runtimeVersion: "1.1.9",
    serviceWorkerSha256: "b".repeat(64),
  };
  const stored = {
    momentInsightRankStatus: {
      status: "running",
      detail: "rank-catch-up",
      updatedAt: new Date(now - 1_000).toISOString(),
    },
    momentInsightRankCadenceMinutes: 6,
    momentInsightRankCadenceConfirmedAt: now,
    momentInsightRankCandidateResetPending: false,
    momentInsightRankCandidateStabilityStartedAt: now - (24 * 60 * 60_000) - 1,
    momentInsightRankCandidateSuccessCount: 6,
    momentInsightRankCandidateProofRuntimeVersion: runtimeIdentity.runtimeVersion,
    momentInsightRankCandidateProofServiceWorkerSha256: runtimeIdentity.serviceWorkerSha256,
  };
  const alarms = new Map();
  let failRead = false;
  class MockDate extends Date {
    static now() { return now; }
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const helpers = runInNewContext(`
      ${serviceWorker.slice(constantsStart, constantsEnd)}
      ${serviceWorker.slice(safeStart, safeEnd)}
      let initializationPromise = Promise.resolve();
      ${serviceWorker.slice(statusStart, statusEnd)}
      ({
        initializeWorker,
        startWorkerInitialization,
        safeCadenceMinutes,
        updateCandidateCadenceEvidence,
      });
    `, {
      Date: MockDate,
      extensionRuntimeIdentity: async () => runtimeIdentity,
      nextKstHour: (hour) => now + hour * 60 * 60_000,
      removeLegacyControllerTabs: async () => {},
      chrome: {
        alarms: {
          async get(name) { return alarms.get(name) || null; },
          async create(name, definition) { alarms.set(name, { name, ...definition }); },
          async clear(name) { return alarms.delete(name); },
        },
        storage: {
          local: {
            async get(keys) {
              if (failRead) throw new Error("storage_read_failed");
              const requested = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(requested.map((key) => [key, stored[key]]));
            },
            async set(values) { Object.assign(stored, values); },
          },
        },
      },
    });

  await helpers.startWorkerInitialization();
  assert.equal(stored.momentInsightRankStatus.status, "failed");
  assert.equal(stored.momentInsightRankStatus.detail, "native_host_interrupted");
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);
  assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 10);
  assert.equal(await helpers.safeCadenceMinutes(6), 10);

  await helpers.updateCandidateCadenceEvidence({
    status: "completed",
    cadenceMinutes: 6,
    atomicSuccesses: 1,
    failed: 0,
    releaseFailed: 0,
    controlPlaneFailed: 0,
  });
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, now);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 1);
  for (let index = 0; index < 5; index += 1) {
    await helpers.updateCandidateCadenceEvidence({
      status: "completed",
      cadenceMinutes: 6,
      atomicSuccesses: 1,
      failed: 0,
      releaseFailed: 0,
      controlPlaneFailed: 0,
    });
  }
  now += 24 * 60 * 60_000 + 1;
  await helpers.updateCandidateCadenceEvidence({
    status: "idle",
    cadenceMinutes: 10,
    atomicSuccesses: 0,
    failed: 0,
    releaseFailed: 0,
    controlPlaneFailed: 0,
  });

  Object.assign(stored, {
    momentInsightRankStatus: {
      status: "completed",
      detail: "갱신 1건",
      updatedAt: new Date(now).toISOString(),
    },
    momentInsightRankCadenceConfirmedAt: now,
  });
  await helpers.startWorkerInitialization();
  assert.equal(stored.momentInsightRankStatus.status, "completed");
  assert.equal(stored.momentInsightRankCandidateResetPending, false);
  assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 6);

  failRead = true;
  await assert.rejects(helpers.initializeWorker(), /storage_read_failed/u);
  failRead = false;
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);

  const requestStart = serviceWorker.indexOf("async function requestWorkerRun(trigger)");
  const requestEnd = serviceWorker.indexOf("function searchUrl", requestStart);
  const workerStart = serviceWorker.indexOf('async function runWorker(trigger = "manual"');
  const workerEnd = serviceWorker.indexOf("chrome.runtime.onInstalled.addListener", workerStart);
  const lifecycleSource = serviceWorker.slice(workerEnd);
  assert.match(serviceWorker.slice(requestStart, requestEnd), /await initializationPromise/u);
  assert.match(serviceWorker.slice(workerStart, workerEnd), /await initializationPromise/u);
  assert.match(lifecycleSource, /onInstalled\.addListener\(\(\) => \{[\s\S]{0,120}startWorkerInitialization\(\)/u);
  assert.match(lifecycleSource, /onStartup\.addListener\(\(\) => \{[\s\S]{0,120}startWorkerInitialization\(\)/u);
  assert.match(lifecycleSource, /void startWorkerInitialization\(\)/u);
  assert.equal((lifecycleSource.match(/void startWorkerInitialization\(\);/gu) || []).length, 3);
  assert.doesNotMatch(lifecycleSource, /void configureAlarms\(\)/u);
});

test("stale visible running status persists the cadence reset before a second restart", async () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const constantsStart = serviceWorker.indexOf("const BASELINE_CADENCE_MINUTES");
  const constantsEnd = serviceWorker.indexOf("// The Node host", constantsStart);
  const safeStart = serviceWorker.indexOf("async function safeCadenceMinutes");
  const safeEnd = serviceWorker.indexOf("function isLegacyControllerTab", safeStart);
  const statusStart = serviceWorker.indexOf('async function saveStatus(status, detail = "")');
  const statusEnd = serviceWorker.indexOf("function nativeDisconnectCode", statusStart);
  let now = Date.parse("2026-08-21T07:00:00.000Z");
  const runtimeIdentity = {
    runtimeVersion: "1.1.9",
    serviceWorkerSha256: "c".repeat(64),
  };
  const stored = {
    momentInsightRankStatus: {
      status: "running",
      detail: "page 8/8",
      updatedAt: new Date(now - (20 * 60_000) - 1).toISOString(),
    },
    momentInsightRankCadenceMinutes: 6,
    momentInsightRankCadenceConfirmedAt: now,
    momentInsightRankCandidateResetPending: false,
    momentInsightRankCandidateStabilityStartedAt: now - (24 * 60 * 60_000) - 1,
    momentInsightRankCandidateSuccessCount: 6,
    momentInsightRankCandidateProofRuntimeVersion: runtimeIdentity.runtimeVersion,
    momentInsightRankCandidateProofServiceWorkerSha256: runtimeIdentity.serviceWorkerSha256,
  };
  const alarms = new Map();
  class MockDate extends Date {
    static now() { return now; }
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const createHelpers = () => runInNewContext(`
      ${serviceWorker.slice(constantsStart, constantsEnd)}
      ${serviceWorker.slice(safeStart, safeEnd)}
      const RUNNING_STATUS_STALE_MS = 20 * 60_000;
      let initializationPromise = Promise.resolve();
      ${serviceWorker.slice(statusStart, statusEnd)}
      ({ loadVisibleStatus, initializeWorker, safeCadenceMinutes });
    `, {
      Date: MockDate,
      extensionRuntimeIdentity: async () => runtimeIdentity,
      nextKstHour: (hour) => now + hour * 60 * 60_000,
      removeLegacyControllerTabs: async () => {},
      chrome: {
        alarms: {
          async get(name) { return alarms.get(name) || null; },
          async create(name, definition) { alarms.set(name, { name, ...definition }); },
          async clear(name) { return alarms.delete(name); },
        },
        storage: {
          local: {
            async get(keys) {
              const requested = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(requested.map((key) => [key, stored[key]]));
            },
            async set(values) { Object.assign(stored, values); },
          },
        },
      },
    });

  let helpers = createHelpers();
  const visible = await helpers.loadVisibleStatus();
  assert.equal(visible.status, "failed");
  assert.equal(visible.detail, "native_host_interrupted");
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);

  helpers = createHelpers();
  await helpers.initializeWorker();
  assert.equal(stored.momentInsightRankStatus.status, "failed");
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);
  assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 10);
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
});

test("initialization allowlist and generic failure preserve fail-closed restart evidence", async () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    serviceWorker,
    /INITIALIZATION_SAFE_STATUSES = new Set\(\["completed", "standby", "ready"\]\)/u,
  );
  const constantsStart = serviceWorker.indexOf("const BASELINE_CADENCE_MINUTES");
  const constantsEnd = serviceWorker.indexOf("// The Node host", constantsStart);
  const safeStart = serviceWorker.indexOf("async function safeCadenceMinutes");
  const safeEnd = serviceWorker.indexOf("function isLegacyControllerTab", safeStart);
  const statusStart = serviceWorker.indexOf('async function saveStatus(status, detail = "")');
  const statusEnd = serviceWorker.indexOf("function nativeDisconnectCode", statusStart);
  const now = Date.parse("2026-08-21T07:00:00.000Z");
  const runtimeIdentity = {
    runtimeVersion: "1.1.9",
    serviceWorkerSha256: "d".repeat(64),
  };
  const stored = {};
  const alarms = new Map();
  class MockDate extends Date {
    static now() { return now; }
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const createHelpers = () => runInNewContext(`
      ${serviceWorker.slice(constantsStart, constantsEnd)}
      ${serviceWorker.slice(safeStart, safeEnd)}
      const RUNNING_STATUS_STALE_MS = 20 * 60_000;
      let initializationPromise = Promise.resolve();
      ${serviceWorker.slice(statusStart, statusEnd)}
      ({ saveWorkerFailure, initializeWorker, safeCadenceMinutes });
    `, {
      Date: MockDate,
      extensionRuntimeIdentity: async () => runtimeIdentity,
      nextKstHour: (hour) => now + hour * 60 * 60_000,
      removeLegacyControllerTabs: async () => {},
      chrome: {
        alarms: {
          async get(name) { return alarms.get(name) || null; },
          async create(name, definition) { alarms.set(name, { name, ...definition }); },
          async clear(name) { return alarms.delete(name); },
        },
        storage: {
          local: {
            async get(keys) {
              const requested = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(requested.map((key) => [key, stored[key]]));
            },
            async set(values) { Object.assign(stored, values); },
          },
        },
      },
    });
  const seedOldProof = (status) => {
    if (status == null) delete stored.momentInsightRankStatus;
    else {
      stored.momentInsightRankStatus = {
        status,
        detail: "",
        updatedAt: new Date(now).toISOString(),
      };
    }
    Object.assign(stored, {
      momentInsightRankCadenceMinutes: 6,
      momentInsightRankCadenceConfirmedAt: now,
      momentInsightRankCandidateResetPending: false,
      momentInsightRankCandidateStabilityStartedAt: now - (24 * 60 * 60_000) - 1,
      momentInsightRankCandidateSuccessCount: 6,
      momentInsightRankCandidateProofRuntimeVersion: runtimeIdentity.runtimeVersion,
      momentInsightRankCandidateProofServiceWorkerSha256: runtimeIdentity.serviceWorkerSha256,
    });
    alarms.clear();
  };

  for (const status of [null, "unknown", "failed", "partial", "verification"]) {
    seedOldProof(status);
    const helpers = createHelpers();
    await helpers.initializeWorker();
    assert.equal(stored.momentInsightRankCandidateResetPending, true, String(status));
    assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0, String(status));
    assert.equal(stored.momentInsightRankCandidateSuccessCount, 0, String(status));
    assert.equal(alarms.has("rank-candidate-reset-pending"), true, String(status));
    assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 10, String(status));
  }
  for (const status of ["completed", "standby", "ready"]) {
    seedOldProof(status);
    const helpers = createHelpers();
    await helpers.initializeWorker();
    assert.equal(stored.momentInsightRankCandidateResetPending, false, status);
    assert.equal(alarms.has("rank-candidate-reset-pending"), false, status);
    assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 6, status);
  }

  seedOldProof("running");
  let helpers = createHelpers();
  await helpers.saveWorkerFailure();
  assert.equal(stored.momentInsightRankStatus.status, "failed");
  assert.equal(stored.momentInsightRankStatus.detail, "rank_worker_unavailable");
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);

  helpers = createHelpers();
  await helpers.initializeWorker();
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);
  assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 10);
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
});

test("candidate proof is bound to the exact extension runtime identity", async () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(serviceWorker, /CANDIDATE_CADENCE_PROOF_RUNTIME_VERSION_KEY/u);
  assert.match(serviceWorker, /CANDIDATE_CADENCE_PROOF_SERVICE_WORKER_SHA256_KEY/u);
  const constantsStart = serviceWorker.indexOf("const BASELINE_CADENCE_MINUTES");
  const constantsEnd = serviceWorker.indexOf("// The Node host", constantsStart);
  const safeStart = serviceWorker.indexOf("async function safeCadenceMinutes");
  const safeEnd = serviceWorker.indexOf("function isLegacyControllerTab", safeStart);
  const statusStart = serviceWorker.indexOf('async function saveStatus(status, detail = "")');
  const statusEnd = serviceWorker.indexOf("function nativeDisconnectCode", statusStart);
  let now = Date.parse("2026-08-21T07:00:00.000Z");
  let runtimeIdentity = {
    runtimeVersion: "1.1.9",
    serviceWorkerSha256: "f".repeat(64),
  };
  let failIdentity = false;
  const stored = {
    momentInsightRankStatus: {
      status: "completed",
      detail: "갱신 1건",
      updatedAt: new Date(now).toISOString(),
    },
    momentInsightRankCadenceMinutes: 6,
    momentInsightRankCadenceConfirmedAt: now,
    momentInsightRankCandidateResetPending: false,
    momentInsightRankCandidateStabilityStartedAt: now - (24 * 60 * 60_000) - 1,
    momentInsightRankCandidateSuccessCount: 6,
    momentInsightRankCandidateProofRuntimeVersion: "1.1.8",
    momentInsightRankCandidateProofServiceWorkerSha256: "e".repeat(64),
  };
  const alarms = new Map();
  class MockDate extends Date {
    static now() { return now; }
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const createHelpers = () => runInNewContext(`
      ${serviceWorker.slice(constantsStart, constantsEnd)}
      ${serviceWorker.slice(safeStart, safeEnd)}
      const RUNNING_STATUS_STALE_MS = 20 * 60_000;
      let initializationPromise = Promise.resolve();
      ${serviceWorker.slice(statusStart, statusEnd)}
      ({ initializeWorker, safeCadenceMinutes, updateCandidateCadenceEvidence });
    `, {
      Date: MockDate,
      extensionRuntimeIdentity: async () => {
        if (failIdentity) throw new Error("extension_runtime_identity_unavailable");
        return runtimeIdentity;
      },
      nextKstHour: (hour) => now + hour * 60 * 60_000,
      removeLegacyControllerTabs: async () => {},
      chrome: {
        alarms: {
          async get(name) { return alarms.get(name) || null; },
          async create(name, definition) { alarms.set(name, { name, ...definition }); },
          async clear(name) { return alarms.delete(name); },
        },
        storage: {
          local: {
            async get(keys) {
              const requested = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(requested.map((key) => [key, stored[key]]));
            },
            async set(values) { Object.assign(stored, values); },
          },
        },
      },
    });

  let helpers = createHelpers();
  await helpers.initializeWorker();
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  assert.equal(stored.momentInsightRankCandidateProofRuntimeVersion, "1.1.9");
  assert.equal(
    stored.momentInsightRankCandidateProofServiceWorkerSha256,
    runtimeIdentity.serviceWorkerSha256,
  );
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);
  assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 10);
  assert.equal(await helpers.safeCadenceMinutes(6), 10);

  await helpers.updateCandidateCadenceEvidence({
    status: "completed",
    cadenceMinutes: 6,
    atomicSuccesses: 1,
    failed: 0,
    releaseFailed: 0,
    controlPlaneFailed: 0,
  });
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, now);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 1);
  helpers = createHelpers();
  await helpers.initializeWorker();
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, now);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 1);
  assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 10);

  Object.assign(stored, {
    momentInsightRankCandidateResetPending: false,
    momentInsightRankCandidateStabilityStartedAt: now - (24 * 60 * 60_000) - 1,
    momentInsightRankCandidateSuccessCount: 6,
    momentInsightRankCandidateProofRuntimeVersion: runtimeIdentity.runtimeVersion,
    momentInsightRankCandidateProofServiceWorkerSha256: runtimeIdentity.serviceWorkerSha256,
    momentInsightRankCadenceConfirmedAt: now,
  });
  alarms.clear();
  helpers = createHelpers();
  await helpers.initializeWorker();
  assert.equal(stored.momentInsightRankCandidateResetPending, false);
  assert.equal(alarms.has("rank-candidate-reset-pending"), false);
  assert.equal(alarms.get("rank-catch-up")?.periodInMinutes, 6);

  runtimeIdentity = {
    runtimeVersion: "1.1.9",
    serviceWorkerSha256: "1".repeat(64),
  };
  helpers = createHelpers();
  await helpers.initializeWorker();
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateStabilityStartedAt, 0);
  assert.equal(stored.momentInsightRankCandidateSuccessCount, 0);
  assert.equal(
    stored.momentInsightRankCandidateProofServiceWorkerSha256,
    runtimeIdentity.serviceWorkerSha256,
  );
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);

  failIdentity = true;
  helpers = createHelpers();
  await assert.rejects(helpers.initializeWorker(), /extension_runtime_identity_unavailable/u);
  assert.equal(stored.momentInsightRankCandidateResetPending, true);
  assert.equal(stored.momentInsightRankCandidateProofRuntimeVersion, "");
  assert.equal(stored.momentInsightRankCandidateProofServiceWorkerSha256, "");
  assert.equal(alarms.has("rank-candidate-reset-pending"), true);
  assert.equal(await helpers.safeCadenceMinutes(6), 10);
});

test("background worker coalesces one highest-priority finite trigger behind an active run", () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const windowsLauncher = fs.readFileSync(
    new URL("windows/MomentInsightNaverShoppingHost.cs", import.meta.url),
    "utf8",
  );
  const priorityStart = serviceWorker.indexOf("const RUN_TRIGGER_PRIORITY");
  const priorityEnd = serviceWorker.indexOf("const VERIFICATION_COOLDOWN_MS");
  const selectorStart = serviceWorker.indexOf("function selectPendingTrigger");
  const selectorEnd = serviceWorker.indexOf("let running = false;");
  assert.ok(priorityStart >= 0 && priorityEnd > priorityStart);
  assert.ok(selectorStart >= 0 && selectorEnd > selectorStart);
  const selectPendingTrigger = runInNewContext(
    `${serviceWorker.slice(priorityStart, priorityEnd)}\n${serviceWorker.slice(selectorStart, selectorEnd)}\nselectPendingTrigger;`,
  );

  assert.equal(selectPendingTrigger(null, "rank-remote"), null);
  assert.equal(selectPendingTrigger(null, "rank-0900"), "rank-0900");
  assert.equal(selectPendingTrigger("rank-0900", "rank-catch-up"), "rank-catch-up");
  assert.equal(selectPendingTrigger("rank-catch-up", "rank-remote"), "rank-catch-up");
  assert.equal(selectPendingTrigger("rank-catch-up", "manual"), "manual");
  assert.equal(selectPendingTrigger("manual", "rank-catch-up"), "manual");

  const queueStart = serviceWorker.indexOf("function queuePendingTrigger");
  const queueEnd = serviceWorker.indexOf("function bytesToHex");
  const triggerQueue = runInNewContext(`
    ${serviceWorker.slice(priorityStart, priorityEnd)}
    ${serviceWorker.slice(selectorStart, selectorEnd)}
    let pendingTrigger = null;
    ${serviceWorker.slice(queueStart, queueEnd)}
    ({ queuePendingTrigger, takePendingTrigger });
  `);
  assert.deepEqual(
    { ...triggerQueue.queuePendingTrigger("rank-remote") },
    { queued: false, pendingTrigger: null },
  );
  assert.equal(triggerQueue.queuePendingTrigger("rank-0900").pendingTrigger, "rank-0900");
  assert.equal(triggerQueue.queuePendingTrigger("rank-catch-up").pendingTrigger, "rank-catch-up");
  assert.deepEqual(
    { ...triggerQueue.queuePendingTrigger("rank-remote") },
    { queued: false, pendingTrigger: "rank-catch-up" },
  );
  assert.equal(triggerQueue.queuePendingTrigger("manual").pendingTrigger, "manual");
  assert.equal(triggerQueue.queuePendingTrigger("rank-1500").pendingTrigger, "manual");
  assert.equal(triggerQueue.takePendingTrigger(), "manual");
  assert.equal(triggerQueue.takePendingTrigger(), null);

  const requestStart = serviceWorker.indexOf("function requestWorkerRun(trigger)");
  const requestEnd = serviceWorker.indexOf("function searchUrl", requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  const requestSource = serviceWorker.slice(
    requestStart,
    requestEnd,
  );
  assert.match(requestSource, /if \(running\) \{[\s\S]{0,120}const pending = queuePendingTrigger\(trigger\)/u);
  assert.match(requestSource, /if \(pending\.queued\)[\s\S]{0,220}queued: true/u);
  assert.match(requestSource, /pendingTrigger: String\(pending\.pendingTrigger/u);
  assert.match(requestSource, /void runWorker\(trigger\)/u);
  assert.doesNotMatch(requestSource, /chrome\.runtime\.sendMessage|ensureControllerTab|controller-run/u);

  const workerStart = serviceWorker.indexOf('async function runWorker(trigger = "manual"');
  const workerEnd = serviceWorker.indexOf("chrome.runtime.onInstalled.addListener", workerStart);
  assert.ok(workerStart >= 0 && workerEnd > workerStart);
  const workerSource = serviceWorker.slice(
    workerStart,
    workerEnd,
  );
  assert.match(workerSource, /options\.respectVerificationCooldown === true/u);
  assert.match(
    workerSource,
    /const nextTrigger = takePendingTrigger\(\)[\s\S]{0,500}runWorker\(nextTrigger, \{[\s\S]{0,120}respectVerificationCooldown: true,[\s\S]{0,120}waitForNativeHandoff: true/u,
  );
  assert.equal((workerSource.match(/takePendingTrigger\(\)/gu) || []).length, 1);
  assert.match(workerSource, /options\.waitForNativeHandoff === true\) await wait\(PENDING_TRIGGER_HANDOFF_MS\)/u);
  assert.match(serviceWorker, /PENDING_TRIGGER_HANDOFF_MS = 6_000/u);
  assert.match(workerSource, /result\.status === "control_plane_failed"/u);
  assert.match(workerSource, /result\.status !== "completed"/u);
  assert.match(workerSource, /result\.status === "standby" \|\| result\.status === "idle"/u);
  const nativeHost = fs.readFileSync(new URL("naver-shopping-native-host.mjs", import.meta.url), "utf8");
  assert.match(nativeHost, /await writeTerminalMessage\(\{ type: "summary", summary \}\)/u);
  assert.match(nativeHost, /process\.stdin\.destroy\(\)/u);
  assert.ok(
    windowsLauncher.indexOf("child.WaitForExit();")
      < windowsLauncher.indexOf("singleInstance.ReleaseMutex();"),
  );
  assert.ok(
    windowsLauncher.indexOf("singleInstance.ReleaseMutex();")
      < windowsLauncher.indexOf("outputRelay.Join(5000)"),
  );
  assert.ok(
    workerSource.indexOf('await saveStatus("running", trigger)')
      < workerSource.indexOf("await wait(PENDING_TRIGGER_HANDOFF_MS)"),
  );
  assert.ok(
    workerSource.indexOf("await wait(PENDING_TRIGGER_HANDOFF_MS)")
      < workerSource.indexOf("chrome.runtime.connectNative"),
  );
});

test("direct shopping route builds the exact 남자팬티 page URL and 3.5-6 second delay", () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const constants = serviceWorker.slice(
    serviceWorker.indexOf("const PAGE_REQUEST_INTERVAL_MS"),
    serviceWorker.indexOf("const VERIFICATION_COOLDOWN_MS"),
  );
  const delay = serviceWorker.slice(
    serviceWorker.indexOf("function pageRequestDelay()"),
    serviceWorker.indexOf("async function verificationState()"),
  );
  const route = serviceWorker.slice(
    serviceWorker.indexOf("function searchUrl(keyword, pageIndex)"),
    serviceWorker.indexOf("function waitForTabComplete(tabId)"),
  );
  const source = `${constants}\n${delay}\n${route}\n({ searchUrl, pageRequestDelay });`;
  const minimum = runInNewContext(source, {
    URL,
    Math: { floor: Math.floor, random: () => 0 },
  });
  const maximum = runInNewContext(source, {
    URL,
    Math: { floor: Math.floor, random: () => 0.999999 },
  });

  assert.equal(
    minimum.searchUrl("남자팬티", 8),
    "https://search.shopping.naver.com/search/all?where=all&frm=NVSCTAB&query=%EB%82%A8%EC%9E%90%ED%8C%AC%ED%8B%B0&pagingIndex=8&pagingSize=40&productSet=total&sort=rel&viewType=list",
  );
  assert.equal(minimum.pageRequestDelay(), 3_500);
  assert.equal(maximum.pageRequestDelay(), 6_000);
});

test("page-eight status and verification cleanup failures still emit collection_complete", async () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const bestEffortStart = serviceWorker.indexOf("async function saveCollectionProgress(pageIndex)");
  const collectStart = serviceWorker.indexOf("async function collectPages(request, onPage = null, options = {})");
  const collectEnd = serviceWorker.indexOf("async function saveStatus(status, detail = \"\")", collectStart);
  const handlerStart = serviceWorker.indexOf('if (message?.type === "collect") {');
  const handlerEnd = serviceWorker.indexOf('if (message?.type === "summary")', handlerStart);
  assert.ok(bestEffortStart >= 0 && collectStart > bestEffortStart && collectEnd > collectStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);

  const runtime = runInNewContext(`
    const PAGE_COUNT = 8;
    const COLLECTION_TIMEOUT_MS = 12 * 60_000;
    const statusAttempts = [];
    let clearAttempts = 0;
    async function wait() {}
    function pageRequestDelay() { return 3_500; }
    function searchUrl(keyword, pageIndex) { return \`https://search.shopping.naver.com/search/all?query=\${keyword}&pagingIndex=\${pageIndex}\`; }
    async function waitForTabComplete() {}
    let readCount = 0;
    async function readNextData() { readCount += 1; return \`page-\${readCount}\`; }
    async function saveStatus(_status, detail) {
      statusAttempts.push(detail);
      if (detail === "page 8/8") throw new Error("storage_write_failed");
    }
    async function clearVerificationState() {
      clearAttempts += 1;
      throw new Error("storage_cleanup_failed");
    }
    function typedCollectionError(error, fallbackCode) {
      return error?.message === "provider_deadline_exceeded" ? error : new Error(fallbackCode);
    }
    async function surfaceVerificationTab(tabId) { return tabId; }
    ${serviceWorker.slice(bestEffortStart, collectEnd)}
    async function handleCollect(message, port) {
      ${serviceWorker.slice(handlerStart, handlerEnd)}
    }
    ({ handleCollect, statusAttempts, clearAttempts: () => clearAttempts, readCount: () => readCount });
  `, {
    chrome: {
      tabs: {
        create: async () => ({ id: 41 }),
        update: async () => ({ id: 41 }),
        remove: async () => {},
      },
    },
  });
  const messages = [];
  await runtime.handleCollect({
    type: "collect",
    requestId: "request-1",
    request: {
      keyword: "남자팬티",
      limit: 300,
      rankPolicy: "organic_only",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    },
  }, {
    postMessage: (message) => messages.push(message),
  });

  assert.deepEqual(Array.from(messages, (message) => message.type), [
    ...Array(8).fill("collection_page"),
    "collection_complete",
  ]);
  assert.deepEqual(Array.from(messages.slice(0, 8), (message) => message.page.pageIndex), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(messages.some((message) => message.type === "collection_error"), false);
  assert.equal(runtime.statusAttempts.includes("page 8/8"), true);
  assert.equal(runtime.clearAttempts(), 1);

  const rangeMessages = [];
  await runtime.handleCollect({
    type: "collect",
    requestId: "request-range-6-8",
    pageStart: 6,
    pageEnd: 8,
    request: {
      keyword: "남자팬티",
      limit: 300,
      rankPolicy: "organic_only",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    },
  }, {
    postMessage: (message) => rangeMessages.push(message),
  });
  assert.deepEqual(Array.from(rangeMessages, (message) => message.type), [
    "collection_page",
    "collection_page",
    "collection_page",
    "collection_complete",
  ]);
  assert.deepEqual(
    Array.from(rangeMessages.slice(0, 3), (message) => message.page.pageIndex),
    [6, 7, 8],
  );

  const expiredMessages = [];
  const readsBeforeExpiredRequest = runtime.readCount();
  await runtime.handleCollect({
    type: "collect",
    requestId: "request-expired",
    request: {
      keyword: "남자팬티",
      limit: 300,
      rankPolicy: "organic_only",
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    },
  }, {
    postMessage: (message) => expiredMessages.push(message),
  });
  assert.deepEqual(Array.from(expiredMessages, (message) => [message.type, message.code]), [
    ["collection_error", "provider_deadline_exceeded"],
  ]);
  assert.equal(runtime.readCount(), readsBeforeExpiredRequest);
});

test("Chrome worker removes legacy controller tabs and only surfaces Naver verification", () => {
  const extensionDirectory = new URL("../tools/naver-shopping-chrome-extension/", import.meta.url);
  const serviceWorker = fs.readFileSync(new URL("service-worker.js", extensionDirectory), "utf8");
  const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", extensionDirectory), "utf8"));
  const verificationGuardSource = serviceWorker.slice(
    serviceWorker.indexOf("async function automaticVerificationCooldownActive(trigger)"),
    serviceWorker.indexOf("async function requestWorkerRun(trigger)"),
  );
  const cleanupSource = serviceWorker.slice(
    serviceWorker.indexOf("function isLegacyControllerTab(tab)"),
    serviceWorker.indexOf("async function automaticVerificationCooldownActive(trigger)"),
  );
  const requestSource = serviceWorker.slice(
    serviceWorker.indexOf("async function requestWorkerRun(trigger)"),
    serviceWorker.indexOf("function searchUrl"),
  );
  const verificationSurfaceStart = serviceWorker.indexOf("async function surfaceVerificationTab(tabId)");
  const verificationSurfaceEnd = serviceWorker.indexOf("\nasync function ", verificationSurfaceStart + 1);
  const verificationSurfaceSource = serviceWorker.slice(verificationSurfaceStart, verificationSurfaceEnd);
  const nonVerificationSurfaceSource = `${serviceWorker.slice(0, verificationSurfaceStart)}${serviceWorker.slice(verificationSurfaceEnd)}`;

  assert.equal(manifest.version, "1.1.16");
  assert.match(verificationGuardSource, /if \(trigger === "manual"\) return false/u);
  assert.match(verificationGuardSource, /await verificationState\(\)/u);
  assert.match(verificationGuardSource, /verification\.blockedUntil > Date\.now\(\)/u);
  assert.match(cleanupSource, /url\.searchParams\.get\("controller"\) === "1"/u);
  assert.match(cleanupSource, /chrome\.tabs\.query\(\{\}\)/u);
  assert.match(cleanupSource, /chrome\.tabs\.remove\(tabId\)/u);
  assert.doesNotMatch(cleanupSource, /chrome\.tabs\.(?:create|update|reload)|chrome\.windows\.update|frozen|pinned|autoDiscardable/u);
  assert.ok(requestSource.indexOf("automaticVerificationCooldownActive(trigger)") < requestSource.indexOf("void runWorker(trigger)"));
  assert.doesNotMatch(requestSource, /chrome\.runtime\.sendMessage|chrome\.tabs\.|chrome\.windows\.|controller-run/u);
  assert.match(verificationSurfaceSource, /chrome\.windows\.update\(tab\.windowId, \{ state: "normal", focused: true \}\)/u);
  assert.match(verificationSurfaceSource, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/u);
  assert.doesNotMatch(nonVerificationSurfaceSource, /active:\s*true|chrome\.windows\.update/u);
  assert.match(serviceWorker, /chrome\.tabs\.create\(\{ url, active: false \}\)/u);
  assert.match(serviceWorker, /chrome\.tabs\.update\(tabId, \{ url, active: false \}\)/u);
  assert.doesNotMatch(serviceWorker, /CONTROLLER_RESUME_TIMEOUT_MS|ensureControllerTab|prepareControllerForDispatch|waitForControllerResumed|changeInfo\.frozen|autoDiscardable:\s*false|controller-run/u);
  assert.match(serviceWorker, /chrome\.alarms\.onAlarm\.addListener\([\s\S]{0,180}requestWorkerRun\(alarm\.name\)/u);
});

test("direct worker keepalive starts immediately, repeats every 20 seconds and stops finitely", () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const keepAliveConstant = serviceWorker.match(/const WORKER_KEEPALIVE_INTERVAL_MS = 20_000;/u)?.[0] || "";
  const keepAliveStart = serviceWorker.indexOf("function startWorkerKeepAlive()");
  const keepAliveEnd = serviceWorker.indexOf("async function runWorker", keepAliveStart);
  assert.equal(keepAliveConstant, "const WORKER_KEEPALIVE_INTERVAL_MS = 20_000;");
  assert.ok(keepAliveStart >= 0 && keepAliveEnd > keepAliveStart);

  let heartbeatCount = 0;
  const scheduled = [];
  const cleared = [];
  const startWorkerKeepAlive = runInNewContext(`
    ${keepAliveConstant}
    ${serviceWorker.slice(keepAliveStart, keepAliveEnd)}
    startWorkerKeepAlive;
  `, {
    chrome: {
      runtime: {
        getPlatformInfo() {
          heartbeatCount += 1;
          return Promise.resolve({ os: "win" });
        },
      },
    },
    setInterval(callback, milliseconds) {
      const timer = { callback, milliseconds };
      scheduled.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    },
  });

  const stop = startWorkerKeepAlive();
  assert.equal(heartbeatCount, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].milliseconds, 20_000);
  scheduled[0].callback();
  assert.equal(heartbeatCount, 2);
  stop();
  assert.deepEqual(cleared, [scheduled[0]]);

  const workerStart = serviceWorker.indexOf('async function runWorker(trigger = "manual"');
  const workerEnd = serviceWorker.indexOf("chrome.runtime.onInstalled.addListener", workerStart);
  const workerSource = serviceWorker.slice(workerStart, workerEnd);
  assert.ok(workerSource.indexOf("chrome.runtime.connectNative") < workerSource.indexOf("startWorkerKeepAlive()"));
  assert.match(workerSource, /if \(stopKeepAlive\) stopKeepAlive\(\)/u);
  assert.ok(workerSource.indexOf("stopKeepAlive()") < workerSource.indexOf("port.disconnect()"));
});

test("extension preserves typed collection errors and maps raw Chrome errors to their stage", () => {
  const extensionDirectory = new URL("../tools/naver-shopping-chrome-extension/", import.meta.url);
  const serviceWorker = fs.readFileSync(new URL("service-worker.js", extensionDirectory), "utf8");
  const helperStart = serviceWorker.indexOf("const TYPED_COLLECTION_ERROR_PATTERN");
  const helperEnd = serviceWorker.indexOf("function wait(milliseconds)", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const typedCollectionError = runInNewContext(
    `${serviceWorker.slice(helperStart, helperEnd)}\ntypedCollectionError;`,
  );

  for (const code of [
    "naver_network_restricted",
    "provider_deadline_exceeded",
    "native_host_pages_incomplete",
  ]) {
    assert.equal(typedCollectionError(new Error(code), "naver_page_script_failed").message, code);
  }
  const codeOnlyError = new Error("Could not establish connection. Receiving end does not exist.");
  codeOnlyError.code = "native_host_communication_failed";
  assert.equal(
    typedCollectionError(codeOnlyError, "naver_page_script_failed").message,
    "native_host_communication_failed",
  );
  const rawError = typedCollectionError(
    new Error("Could not establish connection. Receiving end does not exist."),
    "naver_page_navigation_failed",
  );
  assert.equal(rawError.message, "naver_page_navigation_failed");
  assert.doesNotMatch(rawError.message, /could not establish connection/iu);
});

test("extension locally holds every explicit Naver access-denial code for one hour", () => {
  const extensionDirectory = new URL("../tools/naver-shopping-chrome-extension/", import.meta.url);
  const serviceWorker = fs.readFileSync(new URL("service-worker.js", extensionDirectory), "utf8");
  const helperStart = serviceWorker.indexOf("const NAVER_ACCESS_COOLDOWN_CODES");
  const helperEnd = serviceWorker.indexOf("const TYPED_COLLECTION_ERROR_PATTERN", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const accessCodes = runInNewContext(
    `${serviceWorker.slice(helperStart, helperEnd)}\nNAVER_ACCESS_COOLDOWN_CODES;`,
  );
  for (const code of [
    "naver_verification_required",
    "naver_captcha_detected",
    "naver_http_403",
    "naver_access_blocked",
  ]) {
    assert.equal(accessCodes.has(code), true, code);
  }
});

test("Chrome scheduler opens only the approved normal profile without debug or sandbox bypass", () => {
  const schedulerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-naver-shopping-chrome-scheduler.sh");
  const source = fs.readFileSync(schedulerPath, "utf8");
  assert.match(source, /\/usr\/bin\/open -gj/u);
  assert.match(source, /--profile-directory=/u);
  assert.match(source, /chrome_ready/u);
  assert.doesNotMatch(source, /remote-debugging|no-sandbox|user-data-dir/iu);
  assertZshSyntax(schedulerPath, source);
});

test("extension translates native disconnects and never exposes raw runtime errors", () => {
  const extensionDirectory = new URL("../tools/naver-shopping-chrome-extension/", import.meta.url);
  const serviceWorker = fs.readFileSync(new URL("service-worker.js", extensionDirectory), "utf8");
  const popup = fs.readFileSync(new URL("popup.js", extensionDirectory), "utf8");
  assert.match(serviceWorker, /native_host_not_found/u);
  assert.match(serviceWorker, /호스트를 찾을 수 없/u);
  assert.match(serviceWorker, /native_host_origin_not_allowed/u);
  assert.match(serviceWorker, /native_host_exited/u);
  assert.match(serviceWorker, /await chrome\.alarms\.get\(name\)/u);
  assert.match(serviceWorker, /\["rank-catch-up", \{ delayInMinutes: cadenceMinutes, periodInMinutes: cadenceMinutes \}\]/u);
  assert.match(serviceWorker, /existing\.periodInMinutes/u);
  assert.match(serviceWorker, /await chrome\.alarms\.create\(name, definition\)/u);
  assert.match(serviceWorker, /PAGE_REQUEST_INTERVAL_MS = 3_500/u);
  assert.match(serviceWorker, /PAGE_REQUEST_JITTER_MS = 2_500/u);
  assert.match(serviceWorker, /await wait\(pageRequestDelay\(\)\)/u);
  assert.match(popup, /naver_verification_required/u);
  assert.match(popup, /Chrome을 완전히 종료한 뒤 다시 실행해 주세요/u);
  assert.match(popup, /failureText\(status\.detail\)/u);
  assert.match(popup, /failureText\(result\?\.code\)/u);
});

test("native host framing returns a bounded typed error for an invalid start message", () => {
  const body = Buffer.from(JSON.stringify({ action: "invalid" }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const hostPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "naver-shopping-native-host.mjs");
  const result = spawnSync(process.execPath, [hostPath], {
    input: Buffer.concat([header, body]),
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.readUInt32LE(0), result.stdout.length - 4);
  assert.deepEqual(JSON.parse(result.stdout.subarray(4).toString("utf8")), {
    type: "error",
    code: "native_host_start_invalid",
  });
});

test("native host rejects an unknown run trigger before runtime handoff", () => {
  const body = Buffer.from(JSON.stringify({
    action: "run",
    trigger: "unknown-trigger",
    runtimeVersion: "1.1.16",
    serviceWorkerSha256: "0".repeat(64),
  }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const hostPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "naver-shopping-native-host.mjs");
  const result = spawnSync(process.execPath, [hostPath], {
    input: Buffer.concat([header, body]),
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(decodeNativeMessageFrames(result.stdout), [
    { type: "error", code: "native_host_trigger_invalid" },
  ]);
});

test("native host framing rejects a stale ready acknowledgement before lane claim", () => {
  const hostPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "naver-shopping-native-host.mjs");
  const result = spawnSync(process.execPath, [hostPath], {
    input: Buffer.concat([
      nativeMessageFrame({
        action: "run",
        trigger: "rank-remote",
        runtimeVersion: "1.1.9",
        serviceWorkerSha256: "0".repeat(64),
      }),
      nativeMessageFrame({ action: "ready_ack" }),
    ]),
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(decodeNativeMessageFrames(result.stdout), [
    { type: "ready", collectionProtocol: "range-v1" },
    { type: "error", code: "native_host_ready_ack_invalid" },
  ]);
});

test("native host fails immediately when Chrome closes its input pipe", () => {
  const body = Buffer.from(JSON.stringify({
    action: "run",
    trigger: "rank-remote",
    runtimeVersion: "1.1.9",
    serviceWorkerSha256: "0".repeat(64),
  }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const hostPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "naver-shopping-native-host.mjs");
  const result = spawnSync(process.execPath, [hostPath], {
    input: Buffer.concat([header, body]),
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  const firstLength = result.stdout.readUInt32LE(0);
  const firstEnd = 4 + firstLength;
  assert.deepEqual(JSON.parse(result.stdout.subarray(4, firstEnd).toString("utf8")), {
    type: "ready",
    collectionProtocol: "range-v1",
  });
  const secondLength = result.stdout.readUInt32LE(firstEnd);
  assert.equal(firstEnd + 4 + secondLength, result.stdout.length);
  assert.deepEqual(JSON.parse(result.stdout.subarray(firstEnd + 4).toString("utf8")), {
    type: "error",
    code: "native_host_input_closed",
  });
});
