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
  COLLECTION_EVIDENCE_VERSION,
  buildCollectionEvidence,
  slotDiffSummary,
  summarizeCollectionPages,
  createNativePageStreamCollector,
  resolveNativeExchangeWait,
  validateCollectionProtocolAck,
} from "./naver-shopping-native-host-core.mjs";
import {
  SCHEMA_VERSION,
  STABLE_FINITE_WINDOW_PROOF_VERSION,
  STABLE_RENDERED_ORDER_PROOF_VERSION,
} from "../tools/naver-shopping-rank-collector/src/contract.mjs";
import {
  buildRankTarget,
  productExposureItemsFromOrganic,
} from "../src/server/handlers/naver-shopping-rank.mjs";
import { selectRepresentativeTrackingRank } from "../src/server/handlers/naver-rank-trackers.mjs";
import {
  sanitizeCollectionErrorDetail,
  validateStrictLocalWorkerWindow,
} from "../src/server/naver-shopping/local-worker-contract.mjs";

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

function ranklessCompositeHelper(pageIndex) {
  return {
    type: "recommendation",
    item: {
      collection: "recommendation",
      moduleIndex: pageIndex,
    },
  };
}

function supersavingComposite(pageIndex) {
  return {
    type: "supersaving",
    item: {
      collection: "product",
      rank: ((pageIndex - 1) * 40) + 1,
      id: String(99000000000 + pageIndex),
      parentCatalogId: "59776958987",
      mallProductId: "99999999999",
      mallId: "naver_model",
      stdCatalogMatchType: "2",
      lowMallList: [{ mallPid: "13327339525" }],
      mallProductUrl: "https://smartstore.naver.com/example/products/99999999999",
      productTitle: "온열찜질기 테스트 1",
      imageUrl: "https://shopping-phinf.pstatic.net/main/1.jpg",
    },
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

// Generalized from the sanitized eight-page Production shape: every page has
// fifteen explicit adId products, one explicit supersaving row and forty
// organic products in document order. The organic raw ranks have one bounded
// hole per page, so the strict parser rejects the payload while the candidate
// parser can only become authoritative after an independent matching pass.
function renderedOrderDriftPage(pageIndex) {
  const rawBase = (pageIndex - 1) * 41;
  let adSequence = 0;
  const rankedAd = (localRank) => ({
    type: "product",
    item: {
      collection: "product",
      rank: rawBase + localRank,
      adId: `rendered-ad-${pageIndex}-${++adSequence}`,
    },
  });
  const supersaving = supersavingComposite(pageIndex);
  supersaving.item.rank = rawBase + 4;
  const organic = (localRank) => ({
    type: "product",
    item: productItem(rawBase + localRank),
  });
  const list = [
    rankedAd(3),
    supersaving,
    ...[1, 4, 9, 11, 5, 10, 4].map(rankedAd),
    ...Array.from({ length: 12 }, (_, index) => organic(index + 1)),
    ...[14, 15, 16].map(organic),
    ...[8, 14, 22, 21, 37, 31, 18].map(rankedAd),
    ...Array.from({ length: 25 }, (_, index) => organic(index + 17)),
  ];
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

function renderedOrderDriftPages(mutate = null) {
  const pages = Array.from({ length: 8 }, (_, index) => renderedOrderDriftPage(index + 1));
  if (typeof mutate === "function") mutate(pages);
  return pages;
}

function renderedOrderBoundaryGapZeroPages() {
  return renderedOrderDriftPages((pages) => {
    mutateRenderedPage(pages, 2, (entries) => {
      for (const entry of renderedOrganicEntries(entries)) entry.item.rank -= 1;
    });
  });
}

// Deterministic seam reuse: every page after the first starts at the previous
// page's last organic raw number (gap 0) for `seamCount` consecutive seams.
function renderedOrderSeamOverlapPages(seamCount = 1) {
  return renderedOrderDriftPages((pages) => {
    for (let seam = 1; seam <= seamCount; seam += 1) {
      mutateRenderedPage(pages, seam + 1, (entries) => {
        for (const entry of renderedOrganicEntries(entries)) entry.item.rank -= seam;
      });
    }
  });
}

function renderedOrderBoundaryGapAboveLimitPages() {
  return renderedOrderDriftPages((pages) => {
    mutateRenderedPage(pages, 2, (entries) => {
      for (const entry of renderedOrganicEntries(entries)) entry.item.rank += 40;
    });
  });
}

// Regression beyond the duplicate-slot allowance (gap -3): a seam may step
// back by at most MAX_RENDERED_DUPLICATE_ORGANIC_SLOTS (2) raw numbers.
function renderedOrderBoundaryNegativeGapPages() {
  return renderedOrderDriftPages((pages) => {
    mutateRenderedPage(pages, 1, (entries) => {
      renderedOrganicEntries(entries).at(-1).item.rank += 4;
    });
  });
}

// Tolerated seam regression (gap -1): the twin listing on the previous page
// pushed its raw numbers one past the next page's first organic number
// (2026-09-11 production `page_boundary:2:gm1:l29`).
function renderedOrderBoundaryToleratedNegativeGapPages() {
  return renderedOrderDriftPages((pages) => {
    mutateRenderedPage(pages, 1, (entries) => {
      renderedOrganicEntries(entries).at(-1).item.rank += 2;
    });
  });
}

// 2026-09-11 production shape: the market total is a live counter that grows
// every page (2,017,140 → 2,017,342 across one 8-page window).
function renderedOrderDriftingTotalPages(step = 30) {
  return renderedOrderDriftPages((pages) => {
    pages.forEach((page, index) => {
      const payload = JSON.parse(page.nextDataText);
      payload.props.pageProps.compositeList.total = 204582 + (index * step);
      page.nextDataText = JSON.stringify(payload);
    });
  });
}

// 2026-09-10/11 production shape: page 1 lists two of its products twice
// (supersaving twin next to the ranked card), reusing the raw numbers.
function renderedOrderDuplicateSlotPages(duplicateCount = 2, pageIndex = 1) {
  return renderedOrderDriftPages((pages) => {
    mutateRenderedPage(pages, pageIndex, (entries) => {
      const organic = renderedOrganicEntries(entries);
      for (let offset = 0; offset < duplicateCount; offset += 1) {
        const twinSource = organic[offset];
        const twin = JSON.parse(JSON.stringify(twinSource));
        entries.splice(entries.indexOf(twinSource) + 1, 0, twin);
      }
    });
  });
}

// 2026-09-11/12 production shape (콘트로이친, page 5, eight cycles): one seller
// product rendered twice on one page under two Naver product ids, each with
// its own raw number — a same-page twin, not a repeated slot.
function renderedOrderSamePageTwinPages(twinCount = 1, pageIndex = 5) {
  return renderedOrderDriftPages((pages) => {
    mutateRenderedPage(pages, pageIndex, (entries) => {
      const organic = renderedOrganicEntries(entries);
      for (let offset = 0; offset < twinCount; offset += 1) {
        const source = organic[offset * 2].item;
        const twin = organic[(offset * 2) + 1].item;
        twin.mallProductId = source.mallProductId;
        twin.mallPcUrl = source.mallPcUrl;
      }
    });
  });
}

// 2026-09-13 production shape (일신한일의료기 탄소매트, 215 products): a finite
// market whose pages also drift (paid slots consume raw numbers). Pages past the
// end carry ads but no organic rows.
function renderedOrderFiniteDriftPages(total) {
  return renderedOrderDriftPages((pages) => {
    pages.forEach((page, index) => {
      const payload = JSON.parse(page.nextDataText);
      const list = payload.props.pageProps.compositeList.list;
      const keep = Math.max(0, Math.min(40, total - (index * 40)));
      let seen = 0;
      payload.props.pageProps.compositeList.list = list.filter((entry) => {
        if (entry.type !== "product" || entry.item.adId) return true;
        seen += 1;
        return seen <= keep;
      });
      payload.props.pageProps.compositeList.total = total;
      page.nextDataText = JSON.stringify(payload);
    });
  });
}

test("native provider proves a finite market whose pages drift (1.1.30, 탄소매트 `partial_window:215_300`)", async () => {
  const nowMs = Date.parse("2026-09-13T05:21:00.000Z");
  const { provider, messages } = renderedRecoveryProvider(() => renderedOrderFiniteDriftPages(215), "finite-drift", nowMs);
  const result = await provider.collect(request(nowMs), { allowStableFinite: true });
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 215);
  assert.equal(result.marketTotal, 215);
  assert.equal(result.sourceExhausted, true);
  assert.equal(result.finiteWindowProof?.version, "stable-finite-window-v1");
  assert.equal(result.renderedOrderProof, undefined);
  assert.deepEqual(result.items.map((item) => item.organicRank), Array.from({ length: 215 }, (_, index) => index + 1));
});

test("native provider still fails a drifting finite market when finite arbitration is not allowed", async () => {
  const nowMs = Date.parse("2026-09-13T05:21:00.000Z");
  const { provider } = renderedRecoveryProvider(() => renderedOrderFiniteDriftPages(215), "finite-drift-lookup", nowMs);
  await assert.rejects(
    provider.collect(request(nowMs)),
    (error) => error?.code === "provider_partial_window" && error?.detail === "215/300",
  );
});

test("native provider attaches bounded collection evidence to a failed collection (1.1.30)", async () => {
  const nowMs = Date.parse("2026-09-13T05:21:00.000Z");
  const { provider } = renderedRecoveryProvider(() => renderedOrderDriftingTotalPages(400), "evidence", nowMs);
  let caught = null;
  try { await provider.collect(request(nowMs)); } catch (error) { caught = error; }
  assert.equal(caught?.code, "provider_stable_rendered_order_unproven");
  const evidence = caught.evidence;
  assert.equal(evidence.version, COLLECTION_EVIDENCE_VERSION);
  assert.equal(evidence.version, "collection-evidence-v2");
  assert.equal(evidence.keyword, KEYWORD);
  assert.equal(evidence.passes.length, 2);
  assert.equal(evidence.passes[0].length, 8);
  const first = evidence.passes[0][0];
  assert.equal(first.p, 1);
  assert.equal(first.total, 204582);
  if (evidence.truncated === false) {
    assert.ok(first.rows.some((row) => row[0] === "a"), "ad rows are kept as [\"a\", rank] while nothing is trimmed");
  }
  assert.ok(first.rows.some((row) => Number.isSafeInteger(row[0]) && /^s:\d+$/u.test(row[1])), "organic rows are [rank, identity]");
  assert.ok(first.rows.every((row) => row.length <= 2 && row.every((cell) => cell === null || typeof cell === "number" || typeof cell === "string")));
  // 1.1.31: the branch trace rides along and ends with the thrown code.
  assert.ok(Array.isArray(evidence.trace) && evidence.trace.length >= 2, "trace is attached");
  assert.ok(evidence.trace.every((entry) => typeof entry === "string" && entry.length <= 80));
  assert.match(evidence.trace[0], /^p1 naver_next_data_rank_drift/u);
  assert.match(evidence.trace.at(-1), /^throw provider_stable_rendered_order_unproven/u);
  assert.ok(JSON.stringify(evidence).length <= 24000);
});

test("collection evidence stays within its size bound by trimming rows and passes", () => {
  const passes = Array.from({ length: 3 }, () => renderedOrderDriftPages());
  const evidence = buildCollectionEvidence(request(0), passes);
  assert.ok(JSON.stringify(evidence).length <= 24000);
  assert.equal(evidence.truncated, true);
  assert.ok(evidence.passes.length >= 1);
  const summary = summarizeCollectionPages(renderedOrderDriftPages().slice(0, 1), 3);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].rows.length, 3);
});
// 1.1.31: production rows 2026-09-15 ~ 09-17 (러그·칼슘쌀·콘트로이친·키크는
// `digest_mismatch`) were trimmed to the first 14 rows of every page — the
// paid rows at the top — and the organic rows where the captures differed
// were gone. The trim now drops paid/helper rows before organic slots.
test("collection evidence drops paid rows before organic slots and keeps the trace and diff (1.1.31)", () => {
  const organicOnly = summarizeCollectionPages(renderedOrderDriftPages().slice(0, 1), Infinity, { organicOnly: true });
  assert.ok(organicOnly[0].rows.length > 0);
  assert.ok(organicOnly[0].rows.every((row) => Number.isSafeInteger(row[0]) && typeof row[1] === "string"), "only [rank, identity] rows remain");
  const full = summarizeCollectionPages(renderedOrderDriftPages().slice(0, 1));
  assert.ok(full[0].rows.some((row) => row[0] === "a"), "the untrimmed summary still lists paid rows");
  assert.equal(full[0].rows.filter((row) => Number.isSafeInteger(row[0])).length, organicOnly[0].rows.length);

  const passes = Array.from({ length: 3 }, () => renderedOrderDriftPages());
  const trace = Array.from({ length: 30 }, (_, index) => `step ${index} ${"x".repeat(100)}`);
  const diff = slotDiffSummary(
    [{ organicRank: 1, sellerProductId: "1" }, { organicRank: 2, sellerProductId: "2" }],
    [{ organicRank: 1, sellerProductId: "1" }, { organicRank: 2, sellerProductId: "9" }],
  );
  assert.deepEqual(diff, { a: 2, b: 2, changed: 1, first: [[2, "sellerProductId", "2", "9"]] });
  const evidence = buildCollectionEvidence(request(0), passes, { trace, diff });
  assert.ok(JSON.stringify(evidence).length <= 24000);
  assert.equal(evidence.passes.length, 3, "three organic-only passes fit the bound");
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.trace.length, 24, "trace is bounded to 24 entries");
  assert.ok(evidence.trace.every((entry) => entry.length <= 80), "trace entries are bounded to 80 chars");
  assert.deepEqual(evidence.diff, diff);
  const organicPerPass = summarizeCollectionPages(renderedOrderDriftPages()).flatMap((page) => page.rows).filter((row) => Number.isSafeInteger(row[0])).length;
  const organicRows = evidence.passes.flat().flatMap((page) => page.rows).filter((row) => Number.isSafeInteger(row[0]));
  assert.equal(organicRows.length, evidence.passes.length * organicPerPass, "every organic slot of every kept pass survives the trim");
  assert.ok(evidence.passes.flat().every((page) => page.rows.every((row) => row[0] !== "a" && row[0] !== "h")), "paid and helper rows are the ones trimmed");
});

// 2026-09-11 production shape: ranked paid slots consume the first raw
// numbers, so page 1 opens at raw rank 3 after two ad rows.
function renderedOrderFirstPageAdOffsetPages(offset = 2) {
  return renderedOrderDriftPages((pages) => {
    mutateRenderedPage(pages, 1, (entries) => {
      for (const entry of renderedOrganicEntries(entries)) entry.item.rank += offset;
    });
  });
}

function renderedOrderIdentitySwapPages() {
  return renderedOrderDriftPages((pages) => {
    mutateRenderedPage(pages, 3, (entries) => {
      const [first, second] = renderedOrganicEntries(entries);
      for (const field of ["id", "mallProductId", "mallPcUrl"]) {
        [first.item[field], second.item[field]] = [second.item[field], first.item[field]];
      }
    });
  });
}

function mutateRenderedPage(pages, pageIndex, mutate) {
  const pagePayload = JSON.parse(pages[pageIndex - 1].nextDataText);
  mutate(pagePayload.props.pageProps.compositeList.list);
  pages[pageIndex - 1].nextDataText = JSON.stringify(pagePayload);
}

function renderedOrganicEntries(entries) {
  return entries.filter((entry) => entry.type === "product" && !entry.item.adId);
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

test("builds one strict 300-rank window while excluding rankless composite helpers", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const pages = Array.from({ length: 8 }, (_, index) => {
    const payload = page(index + 1);
    const data = JSON.parse(payload.nextDataText);
    data.props.pageProps.compositeList.list.splice(1, 0, ranklessCompositeHelper(index + 1));
    return { ...payload, nextDataText: JSON.stringify(data) };
  });

  const result = buildNativeWindowFromPages(request(nowMs), pages, { nowMs });

  assert.equal(result.checkedCount, 300);
  assert.equal(result.rawCount, 332);
  assert.equal(result.excludedAdCount, 32);
  assert.deepEqual(
    result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
});

test("builds one strict 300-rank window while excluding exact supersaving inventory", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const pages = Array.from({ length: 8 }, (_, index) => {
    const payload = page(index + 1);
    const data = JSON.parse(payload.nextDataText);
    data.props.pageProps.compositeList.list.splice(0, 0, supersavingComposite(index + 1));
    return { ...payload, nextDataText: JSON.stringify(data) };
  });

  const result = buildNativeWindowFromPages(request(nowMs), pages, { nowMs });

  assert.equal(result.checkedCount, 300);
  assert.equal(result.rawCount, 340);
  assert.equal(result.excludedAdCount, 40);
  assert.deepEqual(
    result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
  assert.equal(result.items.some((item) => item.sellerProductId === "99999999999"), false);
  assert.equal(result.items.some((item) => item.catalogId === "59776958987"), false);
  assert.equal(
    result.items.some((item) => item.catalogSellerProductIds?.includes("13327339525")),
    false,
  );

  const targetProductId = "13327339525";
  const productExposureItems = productExposureItemsFromOrganic(
    result.items.map((item) => ({ rank: item.organicRank, isOrganic: true, item })),
    null,
    buildRankTarget({ targetProductId }),
  );
  const representative = selectRepresentativeTrackingRank({
    matched: false,
    rank: null,
    targetProductId,
    productExposureItems,
  });
  assert.deepEqual(productExposureItems, []);
  assert.equal(representative.matched, false);
  assert.equal(representative.rank, null);
  assert.equal(representative.trackingRankSource, "not_found");
  assert.equal(representative.relatedCatalogRank, null);
});

test("fails closed with bounded diagnostics for an eight-page mixed-ad rank shift", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const pages = Array.from({ length: 8 }, (_, index) => page(index + 1));
  const data = JSON.parse(pages[0].nextDataText);
  const rankedAds = Array.from({ length: 15 }, (_, index) => ({
    type: "product",
    item: {
      collection: "product",
      rank: index + 1,
      adId: `mixed-ad-${index + 1}`,
    },
  }));
  const organics = Array.from({ length: 40 }, (_, index) => ({
    type: "product",
    item: productItem(index < 20 ? index + 1 : index + 2),
  }));
  data.props.pageProps.compositeList.list = [
    ...rankedAds,
    ...organics.slice(0, 20),
    supersavingComposite(1),
    ...organics.slice(20),
  ];
  pages[0] = { ...pages[0], nextDataText: JSON.stringify(data) };

  assert.throws(
    () => buildNativeWindowFromPages(request(nowMs), pages, { nowMs }),
    (error) => error?.code === "naver_next_data_rank_drift"
      && error?.detail === "p1:i10:rm:el:o0:ml:fz:zz:u1:d1:vk:n1:ag:qf:h0:s1"
      && `${error.code}:${error.detail}`.length <= 80,
  );
});

test("page-two first-organic drift includes the previous successful page structure", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const pages = Array.from({ length: 8 }, (_, index) => page(index + 1));
  const first = JSON.parse(pages[0].nextDataText);
  first.props.pageProps.compositeList.list = [
    supersavingComposite(1),
    ...Array.from({ length: 40 }, (_, index) => ({
      type: "product",
      item: productItem(index + 2),
    })),
  ];
  pages[0] = { ...pages[0], nextDataText: JSON.stringify(first) };
  const second = JSON.parse(pages[1].nextDataText);
  second.props.pageProps.compositeList.list = Array.from({ length: 40 }, (_, index) => ({
    type: "product",
    item: productItem(index + 42),
  }));
  pages[1] = { ...pages[1], nextDataText: JSON.stringify(second) };

  assert.throws(
    () => buildNativeWindowFromPages(request(nowMs), pages, { nowMs }),
    (error) => error?.code === "naver_next_data_rank_drift"
      && error?.detail === "p2:i0:r16:e15:o0:m15:a0:q0:h0:s0:l15:b1:c1:g1:t0:y1"
      && `${error.code}:${error.detail}`.length <= 80,
  );
});

test("fails closed when a non-product composite helper carries product evidence", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const pages = Array.from({ length: 8 }, (_, index) => page(index + 1));
  const data = JSON.parse(pages[0].nextDataText);
  data.props.pageProps.compositeList.list.splice(1, 0, {
    type: "recommendation",
    item: {
      collection: "product",
      rank: 1,
      mallProductId: "19999999999",
      productTitle: "상품 증거가 섞인 비허용 행",
    },
  });
  pages[0] = { ...pages[0], nextDataText: JSON.stringify(data) };

  assert.throws(
    () => buildNativeWindowFromPages(request(nowMs), pages, { nowMs }),
    (error) => error?.code === "naver_next_data_schema_drift"
      && error?.detail === "compositeList.list.1.type.recommendation",
  );
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

test("public native builder never accepts one unproven rendered-order candidate", () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  assert.throws(
    () => buildNativeWindowFromPages(request(nowMs), renderedOrderDriftPages(), {
      nowMs,
      renderedOrderCandidate: true,
    }),
    (error) => error?.code === "provider_stable_rendered_order_unproven"
      && error?.detail === "proof_missing",
  );
});

test("native provider accepts rendered order only after two distinct matching rank-drift passes", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const passes = [renderedOrderDriftPages(), renderedOrderDriftPages()];
  for (const pages of passes) {
    assert.throws(
      () => buildNativeWindowFromPages(request(nowMs), pages, { nowMs }),
      (error) => error?.code === "naver_next_data_rank_drift",
      "each pass must remain rejected by the strict parser",
    );
  }
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 2, "rendered-order proof must never start a third capture");
      return {
        type: "collection",
        captureId: `rendered-capture-${messages.length}`,
        pages: passes[messages.length - 1],
      };
    },
  });

  const result = await provider.collect(request(nowMs));

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ pageStart, pageEnd, stableProofPass }) => (
    [pageStart, pageEnd, stableProofPass]
  )), [
    [undefined, undefined, undefined],
    [1, 8, 2],
  ]);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(
    result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
  assert.equal(result.renderedOrderProof?.version, STABLE_RENDERED_ORDER_PROOF_VERSION);
  assert.equal(result.renderedOrderProof?.passCount, 2);
  assert.deepEqual(
    result.renderedOrderProof?.captureIds,
    ["rendered-capture-1", "rendered-capture-2"],
  );
  assert.equal(
    result.renderedOrderProof?.passDigests[0],
    result.renderedOrderProof?.passDigests[1],
  );
  assert.equal(
    result.renderedOrderProof?.structureDigests[0],
    result.renderedOrderProof?.structureDigests[1],
  );
});

test("native provider accepts one zero-gap page seam as a valid capture without a third pass", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const passes = [
    renderedOrderBoundaryGapZeroPages(),
    renderedOrderDriftPages(),
  ];
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 2, "a zero-gap seam must not require a third capture");
      return {
        type: "collection",
        captureId: `rendered-boundary-${messages.length}`,
        pages: passes[messages.length - 1],
      };
    },
  });

  const result = await provider.collect(request(nowMs));

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ pageStart, pageEnd, stableProofPass }) => (
    [pageStart, pageEnd, stableProofPass]
  )), [
    [undefined, undefined, undefined],
    [1, 8, 2],
  ]);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(
    result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
  assert.equal(result.renderedOrderProof?.passCount, 2);
  assert.deepEqual(
    result.renderedOrderProof?.captureIds,
    ["rendered-boundary-1", "rendered-boundary-2"],
  );
  assert.equal(
    result.renderedOrderProof?.passDigests[0],
    result.renderedOrderProof?.passDigests[1],
  );
});

// 2026-09-11 production shape (logged-in profile): page 1's last organic product
// is shown again as page 2's first organic product with the same raw rank, and
// page 2 then continues with the next raw rank. The strict parser still rejects
// the window (raw-rank drift elsewhere on the page), the rendered-order pass
// must absorb the one-product seam and still deliver 300 distinct products.
function renderedOrderSameProductSeamPages() {
  return renderedOrderDriftPages((pages) => {
    const firstPageList = JSON.parse(pages[0].nextDataText).props.pageProps.compositeList.list;
    const lastOrganic = renderedOrganicEntries(firstPageList).at(-1);
    mutateRenderedPage(pages, 2, (entries) => {
      const organicIndexes = entries
        .map((entry, index) => (entry.type === "product" && !entry.item.adId ? index : -1))
        .filter((index) => index >= 0);
      entries.splice(organicIndexes.at(-1), 1);
      entries.splice(organicIndexes[0], 0, JSON.parse(JSON.stringify(lastOrganic)));
    });
  });
}

// 1.1.30 (production 2026-09-11, 복부찜질기 `provider_duplicate_identity:2:7:page_overlap:1`
// every cycle): page 2 opens with page 1's second-to-last product, not its last.
function renderedOrderBoundaryReorderSeamPages() {
  return renderedOrderDriftPages((pages) => {
    const firstPageList = JSON.parse(pages[0].nextDataText).props.pageProps.compositeList.list;
    const secondToLast = renderedOrganicEntries(firstPageList).at(-2);
    mutateRenderedPage(pages, 2, (entries) => {
      const organicIndexes = entries
        .map((entry, index) => (entry.type === "product" && !entry.item.adId ? index : -1))
        .filter((index) => index >= 0);
      // The repeated product carries page 2's own opening raw number; the page
      // still lists 40 organic rows, so its last one drops off.
      const repeated = JSON.parse(JSON.stringify(secondToLast));
      repeated.item.rank = entries[organicIndexes[0]].item.rank;
      entries.splice(organicIndexes.at(-1), 1);
      entries.splice(organicIndexes[0], 0, repeated);
      for (let position = 1; position < organicIndexes.length; position += 1) {
        // Keep the remaining organic raw numbers contiguous after the shift.
        entries[organicIndexes[position]].item.rank = entries[organicIndexes[position - 1]].item.rank + 1;
      }
    });
  });
}

test("native provider absorbs a re-ordered boundary product at the head of the next page (1.1.30)", async () => {
  const nowMs = Date.parse("2026-09-11T12:00:00.000Z");
  const { provider, messages } = renderedRecoveryProvider(() => renderedOrderBoundaryReorderSeamPages(), "boundary-reorder", nowMs);
  const result = await provider.collect(request(nowMs));
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(result.items.map((item) => item.organicRank), Array.from({ length: 300 }, (_, index) => index + 1));
  assert.equal(new Set(result.items.map((item) => item.productId)).size, 300);
});

test("native provider absorbs Naver's same-product page seam and still proves 300 distinct contiguous ranks", async () => {
  const nowMs = Date.parse("2026-09-11T00:00:00.000Z");
  const pages = renderedOrderSameProductSeamPages();
  assert.throws(
    () => buildNativeWindowFromPages(request(nowMs), pages, { nowMs }),
    (error) => error?.code === "naver_next_data_rank_drift",
    "the strict first pass keeps rejecting the drifting fixture",
  );
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return { type: "collection", captureId: `same-product-seam-${messages.length}`, pages };
    },
  });

  const result = await provider.collect(request(nowMs));

  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(
    result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
  const productIds = result.items.map((item) => item.productId);
  assert.equal(new Set(productIds).size, productIds.length, "the seam product appears exactly once");
  assert.equal(result.renderedOrderProof?.passCount, 2);
});

// 1.1.30 (2026-09-11 production shapes): the rendered-order recovery must
// absorb Naver's live market counter, twin listings and ad-consumed first
// numbers, while every regression beyond the evidence stays fatal.
function renderedRecoveryProvider(pagesFactory, label, nowMs) {
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return { type: "collection", captureId: `${label}-${messages.length}`, pages: pagesFactory() };
    },
  });
  return { provider, messages };
}

test("native provider tolerates the live market total drifting within 1% across one window", async () => {
  const nowMs = Date.parse("2026-09-11T03:00:00.000Z");
  const { provider, messages } = renderedRecoveryProvider(() => renderedOrderDriftingTotalPages(30), "drifting-total", nowMs);
  const result = await provider.collect(request(nowMs));
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.equal(result.marketTotalStatus, "verified");
  assert.equal(result.marketTotal, 204582 + (7 * 30), "the most recent page's count is reported");
  assert.equal(new Set(result.items.map((item) => item.productId)).size, 300);
});

test("native provider still fails a window whose market total moves more than 1% from the first page", async () => {
  const nowMs = Date.parse("2026-09-11T03:00:00.000Z");
  const { provider } = renderedRecoveryProvider(() => renderedOrderDriftingTotalPages(400), "runaway-total", nowMs);
  await assert.rejects(
    provider.collect(request(nowMs)),
    (error) => error?.code === "provider_stable_rendered_order_unproven" && error?.detail === "market_total",
  );
});

test("native provider keeps a same-page seller twin in the rendered-order proof (콘트로이친 page 5)", async () => {
  const nowMs = Date.parse("2026-09-12T09:43:00.000Z");
  const { provider, messages } = renderedRecoveryProvider(() => renderedOrderSamePageTwinPages(1, 5), "same-page-twin", nowMs);
  const result = await provider.collect(request(nowMs));
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.ok(result.renderedOrderProof);
  const twins = result.items.filter((item) => item.sellerProductId === result.items[160].sellerProductId);
  assert.deepEqual(twins.map((item) => item.organicRank), [161, 162]);
  assert.equal(new Set(result.items.map((item) => item.productId)).size, 300);
});

// 2026-09-13 13:25 production shape (콘트로이친 `6:7:page_overlap:4`): the seller
// product twinned on page 5 is also listed on pages 4 and 6 under its own
// Naver product ids — a cross-page repeat, not a moving boundary.
function renderedOrderCrossPageRepeatPages() {
  return renderedOrderDriftPages((pages) => {
    let source = null;
    mutateRenderedPage(pages, 4, (entries) => { source = renderedOrganicEntries(entries)[0].item; });
    mutateRenderedPage(pages, 6, (entries) => {
      const repeat = renderedOrganicEntries(entries)[7].item;
      repeat.mallProductId = source.mallProductId;
      repeat.mallPcUrl = source.mallPcUrl;
    });
  });
}

test("native provider keeps a cross-page repeat in the rendered-order proof (1.1.30, 콘트로이친 `6:7:page_overlap:4`)", async () => {
  const nowMs = Date.parse("2026-09-13T04:25:00.000Z");
  const { provider, messages } = renderedRecoveryProvider(renderedOrderCrossPageRepeatPages, "cross-page-repeat", nowMs);
  const result = await provider.collect(request(nowMs));
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.ok(result.renderedOrderProof);
  assert.equal(result.crossPageProof, undefined);
  const repeated = result.items.filter((item) => item.sellerProductId === result.items[120].sellerProductId);
  assert.deepEqual(repeated.map((item) => item.organicRank), [121, 208]);
  assert.equal(new Set(result.items.map((item) => item.productId)).size, 300);
});

test("native provider keeps three same-page twins in one window (1.1.30, 콘트로이친 `5:48:duplicate_row:5`)", async () => {
  const nowMs = Date.parse("2026-09-12T15:24:00.000Z");
  const { provider, messages } = renderedRecoveryProvider(() => renderedOrderSamePageTwinPages(3, 5), "three-twins", nowMs);
  const result = await provider.collect(request(nowMs));
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.ok(result.renderedOrderProof);
  for (const [first, second] of [[160, 161], [162, 163], [164, 165]]) {
    assert.equal(result.items[second].sellerProductId, result.items[first].sellerProductId);
  }
  assert.equal(new Set(result.items.map((item) => item.productId)).size, 300);
});

test("native provider absorbs up to two twin listings on one page and proves 300 distinct products", async () => {
  const nowMs = Date.parse("2026-09-11T03:00:00.000Z");
  const { provider, messages } = renderedRecoveryProvider(() => renderedOrderDuplicateSlotPages(2), "twin-slots", nowMs);
  const result = await provider.collect(request(nowMs));
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(result.items.map((item) => item.organicRank), Array.from({ length: 300 }, (_, index) => index + 1));
  assert.equal(new Set(result.items.map((item) => item.productId)).size, 300);
});

test("native provider rejects a third twin listing on one page as an invalid candidate", async () => {
  const nowMs = Date.parse("2026-09-11T03:00:00.000Z");
  const { provider } = renderedRecoveryProvider(() => renderedOrderDuplicateSlotPages(3), "triple-twin", nowMs);
  await assert.rejects(
    provider.collect(request(nowMs)),
    (error) => error?.code === "provider_rendered_order_candidate_invalid" && /^1:[0-9]{1,2}:duplicate_slot$/u.test(String(error?.detail)),
  );
});

test("native provider lets the first page open after its own ranked ad slots but not beyond them", async () => {
  const nowMs = Date.parse("2026-09-11T03:00:00.000Z");
  const tolerated = renderedRecoveryProvider(() => renderedOrderFirstPageAdOffsetPages(2), "ad-offset", nowMs);
  const result = await tolerated.provider.collect(request(nowMs));
  assert.equal(result.checkedCount, 300);
  const overLimit = renderedRecoveryProvider(() => renderedOrderFirstPageAdOffsetPages(40), "ad-offset-over", nowMs);
  await assert.rejects(
    overLimit.provider.collect(request(nowMs)),
    (error) => error?.code === "provider_stable_rendered_order_unproven" && /^page_boundary:1:g41:l[0-9]{1,3}$/u.test(String(error?.detail)),
  );
});

test("native provider tolerates a one-number seam regression caused by a twin listing", async () => {
  const nowMs = Date.parse("2026-09-11T03:00:00.000Z");
  const { provider, messages } = renderedRecoveryProvider(() => renderedOrderBoundaryToleratedNegativeGapPages(), "seam-minus-one", nowMs);
  const result = await provider.collect(request(nowMs));
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
});

test("readNextData maps a tab that Chrome refuses to script (Naver login redirect) to the verification code", async () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const start = serviceWorker.indexOf("function classifyOffHostTab(");
  const end = serviceWorker.indexOf("async function saveCollectionProgress(");
  assert.ok(start >= 0 && end > start);
  const build = (executeScriptImpl, tabUrl) => runInNewContext(`
    const PAGE_SCRIPT_TIMEOUT_MS = 1000;
    async function withTimeout(promise) { return promise; }
    ${serviceWorker.slice(start, end)}
    ({ readNextData, classifyOffHostTab });
  `, {
    chrome: {
      scripting: { executeScript: executeScriptImpl },
      tabs: { get: async () => ({ url: tabUrl }) },
    },
  });
  const refused = async () => {
    throw new Error('Cannot access contents of url "https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fsearch.shopping.naver.com". Extension manifest must request permission to access this host.');
  };

  const login = build(refused, "https://nid.naver.com/nidlogin.login?url=x");
  await assert.rejects(() => login.readNextData(7), (error) => error?.message === "naver_verification_required");
  assert.equal(login.classifyOffHostTab("https://ncpt.naver.com/v1/captcha"), "naver_verification_required");
  assert.equal(login.classifyOffHostTab("chrome-error://chromewebdata/"), "naver_page_navigation_failed");
  assert.equal(login.classifyOffHostTab(""), "naver_page_navigation_failed");
  assert.equal(login.classifyOffHostTab("https://search.shopping.naver.com/search/all?query=a"), null);
  assert.equal(login.classifyOffHostTab("https://example.com/"), null);

  // A script failure that is not a host-permission refusal keeps its original error.
  const other = build(async () => { throw new Error("boom"); }, "https://nid.naver.com/nidlogin.login");
  await assert.rejects(() => other.readNextData(7), (error) => error?.message === "boom");

  // A refusal on a host we cannot classify is still the generic script failure.
  const unknown = build(refused, "https://example.com/");
  await assert.rejects(
    () => unknown.readNextData(7),
    (error) => /Cannot access contents of url/u.test(String(error?.message)),
  );

  // Successful injection keeps the existing classification order.
  const restricted = build(async () => [{ result: { restricted: true, blocked: false, nextDataText: "", url: "https://search.shopping.naver.com/" } }], "");
  await assert.rejects(() => restricted.readNextData(7), (error) => error?.message === "naver_network_restricted");
  const healthy = build(async () => [{ result: { restricted: false, blocked: false, nextDataText: "{}", url: "https://search.shopping.naver.com/search/all" } }], "");
  assert.equal(await healthy.readNextData(7), "{}");
});

test("native provider proves a deterministic zero-gap seam from two matching captures", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  // The Production `page_boundary:2:g0:l29` signature repeats identically on
  // every capture, so both passes carry the same seam reuse.
  const passes = [renderedOrderSeamOverlapPages(1), renderedOrderSeamOverlapPages(1)];
  for (const pages of passes) {
    assert.throws(
      () => buildNativeWindowFromPages(request(nowMs), pages, { nowMs }),
      (error) => error?.code === "naver_next_data_rank_drift",
      "each seam pass must remain rejected by the strict parser",
    );
  }
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 2, "identical seam captures must never start a third capture");
      return {
        type: "collection",
        captureId: `rendered-seam-${messages.length}`,
        pages: passes[messages.length - 1],
      };
    },
  });

  const result = await provider.collect(request(nowMs));

  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(
    result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
  assert.equal(result.renderedOrderProof?.version, STABLE_RENDERED_ORDER_PROOF_VERSION);
  assert.deepEqual(result.renderedOrderProof?.captureIds, ["rendered-seam-1", "rendered-seam-2"]);
  assert.equal(
    result.renderedOrderProof?.passDigests[0],
    result.renderedOrderProof?.passDigests[1],
  );
  assert.equal(
    result.renderedOrderProof?.structureDigests[0],
    result.renderedOrderProof?.structureDigests[1],
  );
});

test("native provider bounds zero-gap seam tolerance to two seams per capture", async (t) => {
  await t.test("two seams stay valid", async () => {
    const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
    const passes = [renderedOrderSeamOverlapPages(2), renderedOrderSeamOverlapPages(2)];
    const messages = [];
    const provider = createChromeNativeProvider({
      nowMs: () => nowMs,
      async exchange(message) {
        messages.push(message);
        return {
          type: "collection",
          captureId: `rendered-two-seams-${messages.length}`,
          pages: passes[messages.length - 1],
        };
      },
    });
    const result = await provider.collect(request(nowMs));
    assert.equal(messages.length, 2);
    assert.equal(result.checkedCount, 300);
    assert.equal(result.renderedOrderProof?.passCount, 2);
  });

  await t.test("a third seam is a numeric boundary failure", async () => {
    const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
    const passes = [renderedOrderSeamOverlapPages(3), renderedOrderSeamOverlapPages(3)];
    const messages = [];
    const provider = createChromeNativeProvider({
      nowMs: () => nowMs,
      async exchange(message) {
        messages.push(message);
        assert.ok(messages.length <= 2, "two seam-overflow passes must never start pass C");
        return {
          type: "collection",
          captureId: `rendered-three-seams-${messages.length}`,
          pages: passes[messages.length - 1],
        };
      },
    });
    await assert.rejects(
      () => provider.collect(request(nowMs)),
      (error) => error?.code === "provider_stable_rendered_order_unproven"
        && /^page_boundary:4:g0:l[0-9]{1,3}$/u.test(String(error?.detail || "")),
    );
    assert.equal(messages.length, 2);
  });
});

test("native provider keeps negative, over-limit and digest-mismatch seams fatal after the zero-gap tolerance", async (t) => {
  for (const scenario of [
    {
      name: "negative gap in both passes",
      passes: [renderedOrderBoundaryNegativeGapPages(), renderedOrderBoundaryNegativeGapPages()],
      expectedDetail: /^page_boundary:2:gm3:l[0-9]{1,3}$/u,
    },
    {
      name: "gap above the ad-slot limit in both passes",
      passes: [renderedOrderBoundaryGapAboveLimitPages(), renderedOrderBoundaryGapAboveLimitPages()],
      expectedDetail: /^page_boundary:2:g4[0-9]:l[0-9]{1,3}$/u,
    },
    {
      name: "zero-gap seam whose direct-ID order differs between captures",
      passes: [renderedOrderBoundaryGapZeroPages(), renderedOrderIdentitySwapPages()],
      expectedDetail: "digest_mismatch",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
      const messages = [];
      const provider = createChromeNativeProvider({
        nowMs: () => nowMs,
        async exchange(message) {
          messages.push(message);
          assert.ok(messages.length <= 2, "fatal seams must never start pass C");
          return {
            type: "collection",
            captureId: `rendered-fatal-seam-${messages.length}`,
            pages: scenario.passes[messages.length - 1],
          };
        },
      });
      await assert.rejects(
        () => provider.collect(request(nowMs)),
        (error) => error?.code === "provider_stable_rendered_order_unproven"
          && (scenario.expectedDetail instanceof RegExp
            ? scenario.expectedDetail.test(String(error?.detail || ""))
            : error?.detail === scenario.expectedDetail),
        scenario.name,
      );
      assert.equal(messages.length, 2);
    });
  }
});

test("native provider recovers one transient negative rendered page boundary only with a matching third pass", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const passes = [
    renderedOrderBoundaryNegativeGapPages(),
    renderedOrderDriftPages(),
    renderedOrderDriftPages(),
  ];
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 3, "rendered-order recovery must remain bounded");
      return {
        type: "collection",
        captureId: `rendered-boundary-${messages.length}`,
        pages: passes[messages.length - 1],
      };
    },
  });

  const result = await provider.collect(request(nowMs));

  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map(({ pageStart, pageEnd, stableProofPass }) => (
    [pageStart, pageEnd, stableProofPass]
  )), [
    [undefined, undefined, undefined],
    [1, 8, 2],
    [1, 8, undefined],
  ]);
  assert.equal(result.checkedCount, 300);
  assert.equal(result.renderedOrderProof?.passCount, 2);
  assert.deepEqual(
    result.renderedOrderProof?.captureIds,
    ["rendered-boundary-2", "rendered-boundary-3"],
  );
  assert.equal(
    result.renderedOrderProof?.passDigests[0],
    result.renderedOrderProof?.passDigests[1],
  );
});

test("native provider discards any one boundary-invalid A or B and proves only valid plus C", async (t) => {
  for (const scenario of [
    {
      name: "negative A, valid B",
      passes: [
        renderedOrderBoundaryNegativeGapPages(),
        renderedOrderDriftPages(),
        renderedOrderDriftPages(),
      ],
      proofCaptureIds: ["rendered-boundary-2", "rendered-boundary-3"],
    },
    {
      name: "valid A, negative B",
      passes: [
        renderedOrderDriftPages(),
        renderedOrderBoundaryNegativeGapPages(),
        renderedOrderDriftPages(),
      ],
      proofCaptureIds: ["rendered-boundary-1", "rendered-boundary-3"],
    },
    {
      name: "above-limit A, valid B",
      passes: [
        renderedOrderBoundaryGapAboveLimitPages(),
        renderedOrderDriftPages(),
        renderedOrderDriftPages(),
      ],
      proofCaptureIds: ["rendered-boundary-2", "rendered-boundary-3"],
    },
    {
      name: "valid A, above-limit B",
      passes: [
        renderedOrderDriftPages(),
        renderedOrderBoundaryGapAboveLimitPages(),
        renderedOrderDriftPages(),
      ],
      proofCaptureIds: ["rendered-boundary-1", "rendered-boundary-3"],
    },
  ]) {
    await t.test(scenario.name, async () => {
      const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
      const messages = [];
      const provider = createChromeNativeProvider({
        nowMs: () => nowMs,
        async exchange(message) {
          messages.push(message);
          assert.ok(messages.length <= 3, "boundary arbitration must never start pass D");
          return {
            type: "collection",
            captureId: `rendered-boundary-${messages.length}`,
            pages: scenario.passes[messages.length - 1],
          };
        },
      });

      const result = await provider.collect(request(nowMs));

      assert.equal(messages.length, 3);
      assert.equal(result.checkedCount, 300);
      assert.deepEqual(
        result.renderedOrderProof?.captureIds,
        scenario.proofCaptureIds,
      );
      assert.equal(
        result.renderedOrderProof?.passDigests[0],
        result.renderedOrderProof?.passDigests[1],
      );
    });
  }
});

test("native provider never starts C when both rendered-order passes are boundary-invalid", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const passes = [
    renderedOrderBoundaryNegativeGapPages(),
    renderedOrderBoundaryGapAboveLimitPages(),
  ];
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 2, "two invalid passes must never start pass C");
      return {
        type: "collection",
        captureId: `rendered-double-boundary-${messages.length}`,
        pages: passes[messages.length - 1],
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_stable_rendered_order_unproven"
      && /^page_boundary:[1-8]:g(?:m?[0-9]{1,3}):l[0-9]{1,3}$/u
        .test(String(error?.detail || "")),
  );
  assert.equal(messages.length, 2);
});

test("native provider rejects every unsafe third rendered-order pass without a fourth capture", async (t) => {
  const scenarios = [
    {
      name: "direct identity order mismatch",
      thirdPages: renderedOrderIdentitySwapPages,
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: "digest_mismatch",
    },
    {
      name: "capture replay",
      thirdPages: renderedOrderDriftPages,
      captureId: () => "rendered-third-1",
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: "capture_ids",
    },
    {
      name: "strict third capture replay",
      thirdPages: () => Array.from({ length: 8 }, (_, index) => page(index + 1)),
      captureId: (pass) => (pass === 3 ? "rendered-third-2" : `rendered-third-${pass}`),
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: "capture_ids",
    },
    {
      name: "second negative-gap boundary",
      thirdPages: renderedOrderBoundaryNegativeGapPages,
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: /^page_boundary:2:gm3:l[0-9]{1,3}$/u,
    },
    {
      name: "zero-gap seam overflow in the third pass",
      thirdPages: () => renderedOrderSeamOverlapPages(3),
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: /^page_boundary:4:g0:l[0-9]{1,3}$/u,
    },
    {
      // 1.1.30: a cross-page repeat is kept as a rank slot, so a third pass
      // that shows one where the valid pass did not is an order mismatch.
      name: "cross-page direct identity overlap",
      thirdPages() {
        return renderedOrderDriftPages((pages) => {
          mutateRenderedPage(pages, 2, (entries) => {
            const target = renderedOrganicEntries(entries)[0].item;
            const duplicate = productItem(1);
            for (const field of ["id", "mallProductId", "mallPcUrl"]) {
              target[field] = duplicate[field];
            }
          });
        });
      },
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: "digest_mismatch",
    },
    {
      name: "partial third pass",
      thirdPages: () => finiteMarketPages(299),
      expectedCode: "provider_partial_window",
      expectedDetail: "299/300",
    },
    {
      name: "third pass page budget",
      thirdPages: () => renderedOrderDriftPages().slice(0, 7),
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: "page_budget",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
      const passes = [
        renderedOrderBoundaryNegativeGapPages(),
        renderedOrderDriftPages(),
        scenario.thirdPages(),
      ];
      const messages = [];
      const provider = createChromeNativeProvider({
        nowMs: () => nowMs,
        async exchange(message) {
          messages.push(message);
          assert.ok(messages.length <= 3, "unsafe pass C must never start pass D");
          return {
            type: "collection",
            captureId: scenario.captureId?.(messages.length)
              || `rendered-third-${messages.length}`,
            pages: passes[messages.length - 1],
          };
        },
      });

      await assert.rejects(
        () => provider.collect(request(nowMs)),
        (error) => error?.code === scenario.expectedCode
          && (scenario.expectedDetail == null
            || (scenario.expectedDetail instanceof RegExp
              ? scenario.expectedDetail.test(String(error?.detail || ""))
              : error?.detail === scenario.expectedDetail)),
        scenario.name,
      );
      assert.equal(messages.length, 3);
    });
  }
});

test("native provider does not start C when its final deadline guard is reached", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let nearDeadline = false;
  const messages = [];
  const passes = [renderedOrderBoundaryNegativeGapPages(), renderedOrderDriftPages()];
  const provider = createChromeNativeProvider({
    nowMs: () => (nearDeadline ? nowMs + 178_000 : nowMs),
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 2, "deadline guard must prevent pass C");
      const response = {
        type: "collection",
        captureId: `rendered-deadline-${messages.length}`,
        pages: passes[messages.length - 1],
      };
      if (messages.length === 2) nearDeadline = true;
      return response;
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_deadline_exceeded",
  );
  assert.equal(messages.length, 2);
});

test("native provider never accepts one rendered-order capture near the shared deadline", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  let clockReads = 0;
  let exchanges = 0;
  const provider = createChromeNativeProvider({
    nowMs: () => (clockReads++ === 0 ? nowMs : nowMs + 178_000),
    async exchange() {
      exchanges += 1;
      return {
        type: "collection",
        captureId: "rendered-capture-only",
        pages: renderedOrderDriftPages(),
      };
    },
  });

  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_deadline_exceeded",
  );
  assert.equal(exchanges, 1);
});

test("native provider accepts matching direct-ID order across volatile rendered structures", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const firstPages = renderedOrderDriftPages();
  const secondPages = renderedOrderDriftPages((pages) => {
    for (const pagePayload of pages) {
      const data = JSON.parse(pagePayload.nextDataText);
      data.props.pageProps.compositeList.total += 1;
      pagePayload.nextDataText = JSON.stringify(data);
    }
    mutateRenderedPage(pages, 4, (entries) => {
      const rankedAdIndex = entries.findIndex(
        (entry) => entry.type === "product" && entry.item.adId,
      );
      entries.splice(rankedAdIndex, 1);
      renderedOrganicEntries(entries)[12].item.rank -= 1;
    });
  });
  const passes = [firstPages, secondPages];
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 2, "rendered-order proof must remain bounded to two captures");
      return {
        type: "collection",
        captureId: `rendered-volatile-${messages.length}`,
        pages: passes[messages.length - 1],
      };
    },
  });

  const result = await provider.collect(request(nowMs));

  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 300);
  assert.deepEqual(
    result.items.map((item) => item.organicRank),
    Array.from({ length: 300 }, (_, index) => index + 1),
  );
  assert.equal(
    result.renderedOrderProof?.passDigests[0],
    result.renderedOrderProof?.passDigests[1],
  );
  assert.notEqual(
    result.renderedOrderProof?.structureDigests[0],
    result.renderedOrderProof?.structureDigests[1],
  );
});

test("native provider fails closed for every unsafe rendered-order second pass without a third capture", async (t) => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const scenarios = [
    {
      name: "direct identity order mismatch",
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: "digest_mismatch",
      secondPages() {
        return renderedOrderDriftPages((pages) => {
          mutateRenderedPage(pages, 3, (entries) => {
            const [first, second] = renderedOrganicEntries(entries);
            for (const field of ["id", "mallProductId", "mallPcUrl"]) {
              [first.item[field], second.item[field]] = [second.item[field], first.item[field]];
            }
          });
        });
      },
    },
    {
      name: "capture replay",
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: "capture_ids",
      captureId: () => "rendered-capture-replayed",
      secondPages: () => renderedOrderDriftPages(),
    },
    {
      // 1.1.30: a cross-page repeat is kept as a rank slot, so a second pass
      // that shows one where the first did not is an order mismatch.
      name: "cross-page direct identity overlap",
      expectedCode: "provider_stable_rendered_order_unproven",
      expectedDetail: "digest_mismatch",
      secondPages() {
        return renderedOrderDriftPages((pages) => {
          mutateRenderedPage(pages, 2, (entries) => {
            const target = renderedOrganicEntries(entries)[0].item;
            const duplicate = productItem(1);
            for (const field of ["id", "mallProductId", "mallPcUrl"]) {
              target[field] = duplicate[field];
            }
          });
        });
      },
    },
    {
      name: "rankless helper",
      expectedCode: "provider_rendered_order_candidate_invalid",
      secondPages() {
        return renderedOrderDriftPages((pages) => {
          mutateRenderedPage(pages, 5, (entries) => {
            entries.splice(10, 0, ranklessCompositeHelper(5));
          });
        });
      },
    },
    {
      name: "partial organic page",
      expectedCode: "provider_rendered_order_candidate_invalid",
      secondPages() {
        return renderedOrderDriftPages((pages) => {
          mutateRenderedPage(pages, 6, (entries) => {
            const lastOrganicIndex = entries.findLastIndex(
              (entry) => entry.type === "product" && !entry.item.adId,
            );
            entries.splice(lastOrganicIndex, 1);
          });
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const messages = [];
      const passes = [renderedOrderDriftPages(), scenario.secondPages()];
      const provider = createChromeNativeProvider({
        nowMs: () => nowMs,
        async exchange(message) {
          messages.push(message);
          assert.ok(messages.length <= 2, "unsafe rendered order must never start a third capture");
          return {
            type: "collection",
            captureId: scenario.captureId?.(messages.length)
              || `rendered-capture-${messages.length}`,
            pages: passes[messages.length - 1],
          };
        },
      });

      await assert.rejects(
        () => provider.collect(request(nowMs)),
        (error) => error?.code === scenario.expectedCode
          && (scenario.expectedDetail == null || error?.detail === scenario.expectedDetail),
        scenario.name,
      );
      assert.equal(messages.length, 2, `${scenario.name} must stop after pass B`);
    });
  }
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

// 1.1.32 (production 2026-09-14 → 09-19, 일신한일의료기 탄소매트 `partial_window:288_300`, evidence v2 trace
// `p1 …page_overlap:3 -> stable-proof` / `finite allow=true arbitration=false`): 289 organic rows with
// continuous raw ranks, and the last product of one page listed again one row into the next page. A finite
// market with a cross-page repeat is neither a broken 300-window nor a plain finite market.
function finiteMarketCrossPageRepeatPages(total, { originPage = 3, collisionPage = 4, variant = 0 } = {}) {
  const pages = finiteMarketPages(total);
  const collision = JSON.parse(pages[collisionPage - 1].nextDataText);
  const organic = collision.props.pageProps.compositeList.list.filter((entry) => !entry.item.adId);
  const target = organic[1];
  const rank = target.item.rank;
  target.item = { ...productItem(originPage * 40), rank };
  if (variant) {
    const other = organic[5];
    const sellerProductId = String(24000000000 + variant);
    other.item.id = String(84000000000 + variant);
    other.item.mallProductId = sellerProductId;
    other.item.mallPcUrl = `https://smartstore.naver.com/example/products/${sellerProductId}`;
  }
  pages[collisionPage - 1].nextDataText = JSON.stringify(collision);
  return pages;
}

test("native provider proves a finite market that repeats a product across pages (1.1.32, 탄소매트 `partial_window:288_300`)", async () => {
  const nowMs = Date.parse("2026-09-19T00:30:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return { type: "collection", captureId: `finite-repeat-${messages.length}`, pages: finiteMarketCrossPageRepeatPages(250) };
    },
  });
  const result = await provider.collect(request(nowMs), { allowStableFinite: true });
  assert.equal(messages.length, 2, "two identical captures are enough");
  assert.equal(result.checkedCount, 250);
  assert.equal(result.marketTotal, 250);
  assert.equal(result.sourceExhausted, true);
  assert.equal(result.finiteWindowProof?.version, STABLE_FINITE_WINDOW_PROOF_VERSION);
  assert.equal(result.crossPageProof, undefined, "the finite digest is the only proof");
  assert.equal(result.items[119].sellerProductId, result.items[121].sellerProductId, "both rank slots of the repeat are kept");
  assert.deepEqual(result.items.map((item) => item.organicRank), Array.from({ length: 250 }, (_, index) => index + 1));
  // the server-side strict window accepts it only because it carries the finite proof
  const trusted = validateStrictLocalWorkerWindow(result, { keyword: KEYWORD, nowMs, allowStableFinite: true });
  assert.equal(trusted.checkedCount, 250);
  const { finiteWindowProof: _dropped, ...withoutProof } = result;
  assert.throws(() => validateStrictLocalWorkerWindow(withoutProof, { keyword: KEYWORD, nowMs, allowStableFinite: true }));
});

test("a finite market with cross-page repeats stays fail-closed without permission or when three captures disagree (1.1.32)", async () => {
  const nowMs = Date.parse("2026-09-19T00:30:00.000Z");
  const denied = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange() { return { type: "collection", captureId: `finite-denied-${Math.random()}`, pages: finiteMarketCrossPageRepeatPages(250) }; },
  });
  await assert.rejects(
    () => denied.collect(request(nowMs)),
    (error) => error?.code === "provider_partial_window" && error?.detail === "250/300",
  );
  const messages = [];
  const drifting = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 3, "finite arbitration must never start a fourth capture");
      return { type: "collection", captureId: `finite-drift-${messages.length}`, pages: finiteMarketCrossPageRepeatPages(250, { variant: messages.length }) };
    },
  });
  let caught = null;
  try { await drifting.collect(request(nowMs), { allowStableFinite: true }); } catch (error) { caught = error; }
  assert.equal(caught?.code, "provider_stable_finite_window_unproven");
  assert.equal(caught?.detail, "three_passes");
  assert.equal(messages.length, 3);
  assert.ok(caught.evidence?.trace?.some((entry) => /^stable candidates provider_partial_window:250\/300 -> finite/u.test(entry)));
  assert.equal(caught.evidence?.diff?.changed, 1);
});

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

  // 1.1.31: the third independent capture reproduces the first one, so the
  // proof is A,C; the one-slot drift on B is no longer the final answer.
  const result = await provider.collect(request(nowMs));
  assert.equal(exchanges, 3);
  assert.equal(result.checkedCount, 300);
  assert.equal(result.crossPageProof?.version, "stable-full-window-v1");
  assert.deepEqual(result.crossPageProof?.captureIds, ["capture-pass-1", "capture-pass-3"]);
});
test("native provider fails closed when none of three stable proof captures agree and never starts a fourth (1.1.31)", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      assert.ok(messages.length <= 3, "stable full-window arbitration must never start a fourth capture");
      const pages = overlapPages({ originPage: 6, collisionPage: 7 });
      const changed = JSON.parse(pages[1].nextDataText);
      changed.props.pageProps.compositeList.list[10].item.mallProductId = `1999999999${messages.length}`;
      changed.props.pageProps.compositeList.list[10].item.mallPcUrl = `https://smartstore.naver.com/example/products/1999999999${messages.length}`;
      pages[1].nextDataText = JSON.stringify(changed);
      return { type: "collection", captureId: `capture-pass-${messages.length}`, pages };
    },
  });
  let caught = null;
  try { await provider.collect(request(nowMs)); } catch (error) { caught = error; }
  assert.equal(caught?.code, "provider_stable_window_unproven");
  assert.equal(caught?.detail, "three_passes");
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map(({ pageStart, pageEnd, stableProofPass }) => [pageStart, pageEnd, stableProofPass]), [
    [undefined, undefined, undefined],
    [1, 8, 2],
    [1, 8, 3],
  ]);
  assert.equal(caught.evidence?.version, "collection-evidence-v2");
  assert.ok(caught.evidence?.passes?.length >= 2);
  assert.equal(caught.evidence?.diff?.changed, 1, "the slot diff of the first digest comparison is attached");
  assert.equal(caught.evidence?.diff?.first?.[0]?.[1], "sellerProductId");
  assert.ok(caught.evidence?.trace?.some((entry) => /^stable pair 1,2 digest_mismatch/u.test(entry)));
  assert.ok(caught.evidence?.trace?.some((entry) => /^stable pair 2,3 digest_mismatch/u.test(entry)));
});
test("native provider does not spend a third stable proof capture on a replayed pair", async () => {
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
      return { type: "collection", captureId: exchanges === 3 ? "capture-pass-1" : `capture-pass-${exchanges}`, pages };
    },
  });
  await assert.rejects(
    () => provider.collect(request(nowMs)),
    (error) => error?.code === "provider_stable_window_unproven" && error?.detail === "capture_ids",
  );
  assert.equal(exchanges, 3);
});
test("native provider proves a finite market whose live counter jitters by a unit between pages (1.1.31, 탄소매트 `partial_window:220_300`)", async () => {
  const nowMs = Date.parse("2026-09-14T19:13:00.000Z");
  const totals = [223, 223, 223, 222, 223, 222, 222, 223];
  const jitter = (pages) => pages.map((page, index) => {
    const data = JSON.parse(page.nextDataText);
    data.props.pageProps.compositeList.total = totals[index];
    return { ...page, nextDataText: JSON.stringify(data) };
  });
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return { type: "collection", captureId: `finite-jitter-${messages.length}`, pages: jitter(renderedOrderFiniteDriftPages(222)) };
    },
  });
  const result = await provider.collect(request(nowMs), { allowStableFinite: true });
  assert.equal(messages.length, 2);
  assert.equal(result.checkedCount, 222);
  assert.equal(result.marketTotal, 222, "the rendered count is the reported market size");
  assert.equal(result.marketTotalStatus, "verified");
  assert.equal(result.sourceExhausted, true);
  assert.equal(result.finiteWindowProof?.version, STABLE_FINITE_WINDOW_PROOF_VERSION);
  assert.equal(result.finiteWindowProof?.marketTotal, 222);
  // Beyond the shared tolerance the window stays unproven.
  const far = (pages) => pages.map((page) => {
    const data = JSON.parse(page.nextDataText);
    data.props.pageProps.compositeList.total = 240;
    return { ...page, nextDataText: JSON.stringify(data) };
  });
  const strict = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange() { return { type: "collection", captureId: `finite-far-${Math.random()}`, pages: far(renderedOrderFiniteDriftPages(222)) }; },
  });
  await assert.rejects(
    () => strict.collect(request(nowMs), { allowStableFinite: true }),
    (error) => typeof error?.code === "string" && error.code.startsWith("provider_") && error.finiteWindowProof === undefined,
  );
});
test("native finite three-capture rejection carries the slot diff and branch trace (1.1.31)", async () => {
  const nowMs = Date.parse("2026-08-02T08:00:00.000Z");
  const messages = [];
  const provider = createChromeNativeProvider({
    nowMs: () => nowMs,
    async exchange(message) {
      messages.push(message);
      return { type: "collection", captureId: `finite-variant-${messages.length}`, pages: finiteMarketStrongIdentityVariant(93, messages.length) };
    },
  });
  let caught = null;
  try { await provider.collect(request(nowMs), { allowStableFinite: true }); } catch (error) { caught = error; }
  assert.equal(caught?.code, "provider_stable_finite_window_unproven");
  assert.equal(caught?.detail, "three_passes");
  assert.equal(messages.length, 3);
  assert.equal(caught.evidence?.passes?.length, 3);
  assert.equal(caught.evidence?.diff?.changed, 1);
  assert.equal(caught.evidence?.diff?.a, 93);
  assert.ok(caught.evidence?.diff?.first?.some((entry) => entry[1] === "sellerProductId"));
  assert.ok(caught.evidence?.trace?.some((entry) => /^finite candidates ok,ok/u.test(entry)));
  assert.ok(caught.evidence?.trace?.some((entry) => /^finite pair 2,3 digest_mismatch 93\/93/u.test(entry)));
  assert.match(caught.evidence?.trace?.at(-1), /^throw provider_stable_finite_window_unproven:three_passes/u);
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

  assert.equal(manifest.version, "1.1.32");
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
  assert.doesNotMatch(nonVerificationSurfaceSource, /active:\s*true|focused:\s*true/u);
  // Outside verification the collector may only hide its own window.
  assert.deepEqual(
    Array.from(nonVerificationSurfaceSource.matchAll(/chrome\.windows\.update\(([^)]*)\)/gu), (match) => match[1]),
    ['windowId, { state: "minimized" }'],
  );
  assert.match(serviceWorker, /chrome\.windows\.create\(\{ url, focused: false, state: "minimized" \}\)/u);
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

// 2026-09-27 incident: the Mac standby profile had no normal window, so
// chrome.tabs.create() rejected "No current window" four times and opened the
// global circuit. A fake Chrome models what was measured on Chrome 149: a
// window closes with its last tab, tabs.create needs a current window, macOS
// shows an unfocused window as normal despite state "minimized", and a
// minimize issued too early can be undone.
function fakeCollectionChrome({
  windows = [],
  getAllThrows = false,
  createRejects = "",
  tabsCreateRejects = "",
  sessionThrows = false,
  minimizeIgnored = 0,
} = {}) {
  const calls = [];
  const windowMap = new Map();
  const tabMap = new Map();
  const session = {};
  const local = {};
  let nextId = 1000;
  let ignoredMinimizes = minimizeIgnored;
  const addTab = (windowId, url, pendingUrl) => {
    const id = nextId;
    nextId += 1;
    tabMap.set(id, { id, windowId, url, ...(pendingUrl ? { pendingUrl } : {}) });
    windowMap.get(windowId).tabIds.push(id);
    return id;
  };
  const removeTab = (id) => {
    const tab = tabMap.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    tabMap.delete(id);
    const window = windowMap.get(tab.windowId);
    window.tabIds = window.tabIds.filter((tabId) => tabId !== id);
    // Chrome closes a window whose last tab is removed.
    if (window.tabIds.length === 0) windowMap.delete(window.id);
  };
  for (const seed of windows) {
    windowMap.set(seed.id, {
      id: seed.id,
      state: seed.state || "normal",
      incognito: seed.incognito === true,
      tabIds: [],
    });
    for (const tab of seed.tabs || []) {
      if (typeof tab === "string") addTab(seed.id, tab);
      else addTab(seed.id, tab.url, tab.pendingUrl);
    }
  }
  const chrome = {
    windows: {
      async getAll(query) {
        calls.push(["windows.getAll", JSON.parse(JSON.stringify(query))]);
        if (getAllThrows) throw new Error("windows_unavailable");
        return [...windowMap.values()].map((window) => ({
          id: window.id,
          state: window.state,
          type: "normal",
          incognito: window.incognito,
          tabs: window.tabIds.map((id) => ({ ...tabMap.get(id) })),
        }));
      },
      async create(properties) {
        calls.push(["windows.create", { ...properties }]);
        if (createRejects) throw new Error(createRejects);
        const id = nextId;
        nextId += 1;
        // macOS shows an unfocused window as normal despite state: "minimized".
        windowMap.set(id, { id, state: "normal", incognito: false, tabIds: [] });
        const tabId = addTab(id, properties.url);
        return { id, state: "normal", focused: false, tabs: [{ id: tabId, windowId: id }] };
      },
      async update(id, properties) {
        calls.push(["windows.update", id, { ...properties }]);
        const window = windowMap.get(id);
        if (!window) throw new Error(`No window with id: ${id}.`);
        if (properties.state === "minimized" && ignoredMinimizes > 0) {
          ignoredMinimizes -= 1;
          return { id, state: window.state };
        }
        if (properties.state) window.state = properties.state;
        return { id, state: window.state };
      },
      async get(id) {
        const window = windowMap.get(id);
        if (!window) throw new Error(`No window with id: ${id}.`);
        return { id, state: window.state };
      },
    },
    tabs: {
      async create(properties) {
        calls.push(["tabs.create", { ...properties }]);
        if (tabsCreateRejects) throw new Error(tabsCreateRejects);
        const [current] = windowMap.values();
        if (!current) throw new Error("No current window");
        const id = addTab(current.id, properties.url);
        return { id, windowId: current.id };
      },
      async update(id, properties) {
        calls.push(["tabs.update", id, { ...properties }]);
        const tab = tabMap.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        if (properties.url) {
          tab.url = properties.url;
          delete tab.pendingUrl;
        }
        return { id, windowId: tab.windowId };
      },
      async get(id) {
        const tab = tabMap.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { id, windowId: tab.windowId, url: tab.url };
      },
      async remove(id) {
        calls.push(["tabs.remove", id]);
        removeTab(id);
      },
    },
    storage: {
      session: {
        async get(key) {
          if (sessionThrows) throw new Error("session_unavailable");
          return { [key]: session[key] };
        },
        async set(values) {
          if (sessionThrows) throw new Error("session_unavailable");
          Object.assign(session, JSON.parse(JSON.stringify(values)));
        },
      },
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, local[key]]));
        },
        async set(values) { Object.assign(local, values); },
        async remove(keys) { for (const key of keys) delete local[key]; },
      },
    },
  };
  return {
    chrome,
    calls,
    windowMap,
    tabMap,
    session,
    local,
    closeWindow(id) {
      for (const tabId of [...windowMap.get(id).tabIds]) removeTab(tabId);
    },
  };
}

function loadCollectionWindowRuntime(fake, { readNextData, recordWait = () => {} } = {}) {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const slice = (startText, endText) => {
    const start = serviceWorker.indexOf(startText);
    const end = serviceWorker.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, startText);
    return serviceWorker.slice(start, end);
  };
  return runInNewContext(`
    const PAGE_COUNT = 8;
    const COLLECTION_TIMEOUT_MS = 12 * 60_000;
    const VERIFICATION_COOLDOWN_MS = 60 * 60_000;
    const VERIFICATION_BLOCKED_UNTIL_KEY = "momentInsightRankBlockedUntil";
    const VERIFICATION_TAB_ID_KEY = "momentInsightRankVerificationTabId";
    ${slice("const COLLECTION_WINDOW_ANCHOR_KEY", "const LEGACY_CONTROLLER_PAGE_URL")}
    ${slice("const TYPED_COLLECTION_ERROR_PATTERN", "function wait(milliseconds)")}
    ${slice("async function verificationState()", "function nextKstHour(hour)")}
    async function wait(milliseconds) { recordWait(milliseconds); }
    function pageRequestDelay() { return 3_500; }
    function searchUrl(keyword, pageIndex) {
      return \`https://search.shopping.naver.com/search/all?query=\${keyword}&pagingIndex=\${pageIndex}\`;
    }
    async function waitForTabComplete() {}
    async function saveStatus() {}
    ${slice("async function saveCollectionProgress(pageIndex)", 'async function saveStatus(status, detail = "")')}
    ({ collectPages, clearVerificationState, surfaceVerificationTab, releaseCollectionTab });
  `, {
    chrome: fake.chrome,
    readNextData: readNextData || (async (tabId) => `next-data-${tabId}`),
    recordWait,
  });
}

const collectionWindowRequest = () => ({
  keyword: "남자팬티",
  limit: 300,
  rankPolicy: "organic_only",
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
});
const collectionWindowPageUrl = (pageIndex) =>
  `https://search.shopping.naver.com/search/all?query=남자팬티&pagingIndex=${pageIndex}`;
const collectionWindowCalls = (fake, name) => fake.calls.filter(([callName]) => callName === name);
const collectionTabUpdates = (fake) => collectionWindowCalls(fake, "tabs.update")
  .map(([, id, properties]) => [id, properties.url, properties.active]);

test("collector opens one minimized own window only when the profile has no normal window and parks it", async () => {
  const fake = fakeCollectionChrome({ minimizeIgnored: 1 });
  const runtime = loadCollectionWindowRuntime(fake);
  const delivered = [];
  let statesAtFirstPage = null;
  await runtime.collectPages(collectionWindowRequest(), async (page) => {
    delivered.push(page.pageIndex);
    if (page.pageIndex === 1) statesAtFirstPage = [...fake.windowMap.values()].map((window) => window.state);
  });

  assert.deepEqual(delivered, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(collectionWindowCalls(fake, "windows.getAll")[0], [
    "windows.getAll",
    { windowTypes: ["normal"], populate: true },
  ]);
  // Minimized before the first page is read, not only at release.
  assert.deepEqual(statesAtFirstPage, ["minimized"]);
  assert.deepEqual(collectionWindowCalls(fake, "windows.create"), [
    ["windows.create", { url: collectionWindowPageUrl(1), focused: false, state: "minimized" }],
  ]);
  assert.deepEqual(collectionWindowCalls(fake, "tabs.create"), []);
  assert.deepEqual(collectionWindowCalls(fake, "tabs.remove"), []);
  assert.equal(fake.windowMap.size, 1);
  const [[windowId, window]] = [...fake.windowMap.entries()];
  const [tabId] = window.tabIds;
  assert.equal(window.state, "minimized");
  // The first minimize is undone by Chrome's asynchronous show; the retry sticks.
  assert.deepEqual(collectionWindowCalls(fake, "windows.update"), [
    ["windows.update", windowId, { state: "minimized" }],
    ["windows.update", windowId, { state: "minimized" }],
  ]);
  assert.deepEqual(fake.session, { momentInsightRankCollectionWindow: { windowId, tabId } });
  assert.deepEqual(collectionTabUpdates(fake), [
    ...[2, 3, 4, 5, 6, 7, 8].map((pageIndex) => [tabId, collectionWindowPageUrl(pageIndex), false]),
    [tabId, "about:blank", undefined],
  ]);
  assert.equal(fake.tabMap.get(tabId).url, "about:blank");

  // The next collection reuses the parked tab: no window, no tabs.create.
  fake.calls.length = 0;
  await runtime.collectPages(collectionWindowRequest(), async () => {}, { pageStart: 6, pageEnd: 8 });
  assert.deepEqual(collectionWindowCalls(fake, "windows.create"), []);
  assert.deepEqual(collectionWindowCalls(fake, "tabs.create"), []);
  assert.deepEqual(collectionWindowCalls(fake, "tabs.remove"), []);
  assert.deepEqual(collectionWindowCalls(fake, "windows.update"), []);
  assert.deepEqual(collectionTabUpdates(fake), [
    [tabId, collectionWindowPageUrl(6), false],
    [tabId, collectionWindowPageUrl(7), false],
    [tabId, collectionWindowPageUrl(8), false],
    [tabId, "about:blank", undefined],
  ]);
  assert.equal(fake.windowMap.size, 1);
  assert.equal(fake.windowMap.get(windowId).state, "minimized");
});

test("collector keeps the unchanged tab lifecycle whenever a normal window exists", async () => {
  for (const seed of [
    [{ id: 7, tabs: ["chrome://newtab/"] }],
    [{ id: 7, tabs: ["chrome://newtab/"] }, { id: 8, tabs: ["https://example.com/"] }],
    // A minimized window of the person's own is still a normal window.
    [{ id: 7, state: "minimized", tabs: ["about:blank"] }],
  ]) {
    const fake = fakeCollectionChrome({ windows: seed });
    fake.session.momentInsightRankCollectionWindow = { windowId: 8, tabId: 1001 };
    const runtime = loadCollectionWindowRuntime(fake);
    await runtime.collectPages(collectionWindowRequest(), async () => {});
    assert.deepEqual(collectionWindowCalls(fake, "tabs.create"), [
      ["tabs.create", { url: collectionWindowPageUrl(1), active: false }],
    ]);
    assert.deepEqual(collectionWindowCalls(fake, "windows.create"), []);
    assert.deepEqual(collectionWindowCalls(fake, "windows.update"), []);
    const collectionTabId = collectionWindowCalls(fake, "tabs.update")[0][1];
    assert.deepEqual(collectionWindowCalls(fake, "tabs.remove"), [["tabs.remove", collectionTabId]]);
    assert.equal(fake.windowMap.size, seed.length);
    assert.equal(fake.tabMap.size, seed.reduce((total, window) => total + window.tabs.length, 0));
  }
});

test("collector counts only non-incognito windows as the profile's own", async () => {
  // An incognito window alone does not keep a collection surface: open our own.
  const onlyIncognito = fakeCollectionChrome({ windows: [{ id: 9, incognito: true, tabs: ["chrome://newtab/"] }] });
  await loadCollectionWindowRuntime(onlyIncognito).collectPages(collectionWindowRequest(), async () => {});
  assert.deepEqual(collectionWindowCalls(onlyIncognito, "windows.create"), [
    ["windows.create", { url: collectionWindowPageUrl(1), focused: false, state: "minimized" }],
  ]);
  assert.deepEqual(collectionWindowCalls(onlyIncognito, "tabs.create"), []);
  assert.equal(onlyIncognito.windowMap.get(9).tabIds.length, 1);
  const ownWindow = [...onlyIncognito.windowMap.values()].find((window) => !window.incognito);
  assert.equal(onlyIncognito.tabMap.get(ownWindow.tabIds[0]).url, "about:blank");
  assert.equal(ownWindow.state, "minimized");

  // The last tab of the last non-incognito window is parked even while an
  // incognito window is open.
  const mixed = fakeCollectionChrome({ windows: [
    { id: 7, tabs: ["https://search.shopping.naver.com/"] },
    { id: 9, incognito: true, tabs: ["chrome://newtab/"] },
  ] });
  const [tabId] = mixed.windowMap.get(7).tabIds;
  await loadCollectionWindowRuntime(mixed).releaseCollectionTab(tabId);
  assert.deepEqual(collectionWindowCalls(mixed, "tabs.remove"), []);
  assert.equal(mixed.tabMap.get(tabId).url, "about:blank");
  assert.deepEqual(mixed.session, { momentInsightRankCollectionWindow: { windowId: 7, tabId } });
});

test("collector falls back to the unchanged tab path when Chrome cannot list windows", async () => {
  const withWindow = fakeCollectionChrome({ windows: [{ id: 7, tabs: ["chrome://newtab/"] }], getAllThrows: true });
  await loadCollectionWindowRuntime(withWindow).collectPages(collectionWindowRequest(), async () => {});
  assert.equal(collectionWindowCalls(withWindow, "tabs.create").length, 1);
  assert.equal(collectionWindowCalls(withWindow, "tabs.remove").length, 1);
  assert.deepEqual(collectionWindowCalls(withWindow, "windows.create"), []);

  const withoutWindow = fakeCollectionChrome({ getAllThrows: true });
  await assert.rejects(
    loadCollectionWindowRuntime(withoutWindow).collectPages(collectionWindowRequest(), async () => {}),
    (error) => error?.message === "naver_page_navigation_failed" && error.errorDetail === "No current window",
  );
  assert.deepEqual(collectionWindowCalls(withoutWindow, "windows.create"), []);
});

test("collector types window creation and mid-collection window loss as navigation failures", async () => {
  const refused = fakeCollectionChrome({ createRejects: "Browser window creation is not allowed." });
  await assert.rejects(
    loadCollectionWindowRuntime(refused).collectPages(collectionWindowRequest(), async () => {}),
    (error) => error?.message === "naver_page_navigation_failed"
      && error.errorDetail === "Browser window creation is not allowed.",
  );
  assert.deepEqual(collectionWindowCalls(refused, "tabs.update"), []);
  assert.deepEqual(collectionWindowCalls(refused, "tabs.remove"), []);
  assert.deepEqual(refused.session, {});

  const closed = fakeCollectionChrome();
  const delivered = [];
  const runtime = loadCollectionWindowRuntime(closed);
  await assert.rejects(
    runtime.collectPages(collectionWindowRequest(), async (page) => {
      delivered.push(page.pageIndex);
      // The person closes the collector window while page 1 is delivered.
      if (page.pageIndex === 1) closed.closeWindow([...closed.windowMap.keys()][0]);
    }),
    (error) => error?.message === "naver_page_navigation_failed" && /^No tab with id: \d+\.$/u.test(error.errorDetail),
  );
  assert.deepEqual(delivered, [1]);
  assert.equal(closed.windowMap.size, 0);
});

test("collector never closes the profile's last window when it releases a tab", async () => {
  // A person closed every other tab while the collection tab was open.
  const fake = fakeCollectionChrome({ windows: [{ id: 7, tabs: ["chrome://newtab/"] }] });
  const runtime = loadCollectionWindowRuntime(fake, {
    readNextData: async (tabId) => {
      const ownerTab = fake.windowMap.get(7).tabIds.find((id) => id !== tabId);
      if (ownerTab != null) await fake.chrome.tabs.remove(ownerTab);
      return `next-data-${tabId}`;
    },
  });
  await runtime.collectPages(collectionWindowRequest(), async () => {});
  assert.equal(collectionWindowCalls(fake, "tabs.create").length, 1);
  const [collectionTabId] = fake.windowMap.get(7).tabIds;
  assert.ok(Number.isInteger(collectionTabId));
  assert.deepEqual(
    collectionWindowCalls(fake, "tabs.remove").map(([, id]) => id).filter((id) => id === collectionTabId),
    [],
  );
  assert.equal(fake.tabMap.get(collectionTabId).url, "about:blank");
  assert.equal(fake.windowMap.get(7).state, "minimized");
  assert.deepEqual(fake.session, { momentInsightRankCollectionWindow: { windowId: 7, tabId: collectionTabId } });
});

test("collector tab release never throws and leaves the tab rather than closing it blindly", async () => {
  const fake = fakeCollectionChrome({ windows: [{ id: 7, tabs: ["https://search.shopping.naver.com/"] }] });
  const [tabId] = fake.windowMap.get(7).tabIds;
  fake.chrome.tabs.update = () => { throw new TypeError("tabs.update is unavailable"); };
  const runtime = loadCollectionWindowRuntime(fake);
  assert.equal(await runtime.releaseCollectionTab(tabId), undefined);
  assert.deepEqual(collectionWindowCalls(fake, "tabs.remove"), []);
  assert.equal(fake.windowMap.get(7).tabIds.length, 1);

  // A slice without the window constants (as other VM tests load collectPages)
  // still completes: the release swallows its own ReferenceError.
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const bestEffortStart = serviceWorker.indexOf("async function saveCollectionProgress(pageIndex)");
  const collectEnd = serviceWorker.indexOf("async function saveStatus(status, detail = \"\")", bestEffortStart);
  const handlerStart = serviceWorker.indexOf('if (message?.type === "collect") {');
  const handlerEnd = serviceWorker.indexOf('if (message?.type === "summary")', handlerStart);
  const helperStart = serviceWorker.indexOf("const TYPED_COLLECTION_ERROR_PATTERN");
  const helperEnd = serviceWorker.indexOf("function wait(milliseconds)", helperStart);
  for (const [label, readNextData, expected] of [
    ["complete", async () => "page", ["collection_complete", undefined]],
    ["typed failure", async () => { throw new Error("naver_page_script_timeout"); }, ["collection_error", "naver_page_script_timeout"]],
  ]) {
    const lonely = fakeCollectionChrome({ windows: [{ id: 7, state: "normal", tabs: [] }] });
    const handlerRuntime = runInNewContext(`
      const PAGE_COUNT = 8;
      const COLLECTION_TIMEOUT_MS = 12 * 60_000;
      ${serviceWorker.slice(helperStart, helperEnd)}
      async function wait() {}
      function pageRequestDelay() { return 3_500; }
      function searchUrl(keyword, pageIndex) { return \`https://search.shopping.naver.com/search/all?pagingIndex=\${pageIndex}\`; }
      async function waitForTabComplete() {}
      async function saveStatus() {}
      async function clearVerificationState() {}
      async function surfaceVerificationTab(tabId) { return tabId; }
      ${serviceWorker.slice(bestEffortStart, collectEnd)}
      async function handleCollect(message, port) {
        ${serviceWorker.slice(handlerStart, handlerEnd)}
      }
      ({ handleCollect });
    `, { chrome: lonely.chrome, readNextData });
    const messages = [];
    await handlerRuntime.handleCollect({
      type: "collect",
      requestId: "request-release",
      request: collectionWindowRequest(),
    }, { postMessage: (message) => messages.push(message) });
    const last = messages.at(-1);
    assert.deepEqual([last.type, last.code], expected, label);
    // The profile's only window keeps its tab: nothing was removed.
    assert.deepEqual(collectionWindowCalls(lonely, "tabs.remove"), [], label);
    assert.equal(lonely.windowMap.get(7).tabIds.length, 1, label);
  }
});

test("verification keeps the collector tab open and its later cleanup parks instead of closing", async () => {
  const fake = fakeCollectionChrome();
  const runtime = loadCollectionWindowRuntime(fake, {
    readNextData: async () => { throw new Error("naver_verification_required"); },
  });
  await assert.rejects(
    runtime.collectPages(collectionWindowRequest(), async () => {}),
    (error) => error?.message === "naver_verification_required",
  );
  const [[windowId, window]] = [...fake.windowMap.entries()];
  const [tabId] = window.tabIds;
  assert.equal(window.state, "normal");
  assert.equal(fake.local.momentInsightRankVerificationTabId, tabId);
  assert.deepEqual(collectionWindowCalls(fake, "tabs.remove"), []);
  assert.deepEqual(collectionWindowCalls(fake, "windows.update").at(-1), [
    "windows.update",
    windowId,
    { state: "normal", focused: true },
  ]);

  fake.calls.length = 0;
  await runtime.clearVerificationState();
  assert.equal(fake.local.momentInsightRankVerificationTabId, undefined);
  assert.deepEqual(collectionWindowCalls(fake, "tabs.remove"), []);
  assert.equal(fake.tabMap.get(tabId).url, "about:blank");
  assert.equal(fake.windowMap.get(windowId).state, "minimized");

  // A verification tab that shares its window with other tabs is still removed.
  const shared = fakeCollectionChrome({ windows: [{ id: 7, tabs: ["chrome://newtab/", "https://nid.naver.com/"] }] });
  const verificationTabId = shared.windowMap.get(7).tabIds[1];
  shared.local.momentInsightRankVerificationTabId = verificationTabId;
  await loadCollectionWindowRuntime(shared).clearVerificationState();
  assert.deepEqual(collectionWindowCalls(shared, "tabs.remove"), [["tabs.remove", verificationTabId]]);

  // Surfacing a newer verification tab releases the older one by the same rule.
  const surfaced = fakeCollectionChrome({ windows: [{ id: 7, tabs: ["https://nid.naver.com/", "https://search.shopping.naver.com/"] }] });
  const [olderTabId, newerTabId] = surfaced.windowMap.get(7).tabIds;
  surfaced.local.momentInsightRankVerificationTabId = olderTabId;
  assert.equal(await loadCollectionWindowRuntime(surfaced).surfaceVerificationTab(newerTabId), newerTabId);
  assert.deepEqual(collectionWindowCalls(surfaced, "tabs.remove"), [["tabs.remove", olderTabId]]);
  assert.equal(surfaced.local.momentInsightRankVerificationTabId, newerTabId);

  // ...so an older verification tab that is the last tab of the profile's last
  // non-incognito window is parked, not closed, while the newer one is shown.
  const lastWindow = fakeCollectionChrome({ windows: [
    { id: 7, tabs: ["https://nid.naver.com/"] },
    { id: 9, incognito: true, tabs: ["https://search.shopping.naver.com/"] },
  ] });
  const [lastOlderTabId] = lastWindow.windowMap.get(7).tabIds;
  const [incognitoNewerTabId] = lastWindow.windowMap.get(9).tabIds;
  lastWindow.local.momentInsightRankVerificationTabId = lastOlderTabId;
  assert.equal(
    await loadCollectionWindowRuntime(lastWindow).surfaceVerificationTab(incognitoNewerTabId),
    incognitoNewerTabId,
  );
  assert.deepEqual(collectionWindowCalls(lastWindow, "tabs.remove"), []);
  assert.deepEqual(lastWindow.windowMap.get(7).tabIds, [lastOlderTabId]);
  assert.equal(lastWindow.tabMap.get(lastOlderTabId).url, "about:blank");
  assert.equal(lastWindow.windowMap.get(7).state, "minimized");
  assert.deepEqual(lastWindow.session, { momentInsightRankCollectionWindow: { windowId: 7, tabId: lastOlderTabId } });
  assert.equal(lastWindow.windowMap.get(9).state, "normal");
  assert.equal(lastWindow.local.momentInsightRankVerificationTabId, incognitoNewerTabId);
});

test("collector reuses its minimized parked tab left on a search page, also while that page settles", async () => {
  // A service-worker restart mid-collection leaves the parked tab on its last
  // search page instead of about:blank. tabs.create into the minimized window
  // would restore it on macOS (measured), so that tab is reused as it is.
  const searchPageUrl = "https://search.shopping.naver.com/search/all?query=x&pagingIndex=8";
  for (const [label, disturb] of [
    ["left on a search page", (tab) => { tab.url = searchPageUrl; }],
    ["search page committing to the same address", (tab) => {
      tab.url = searchPageUrl;
      tab.pendingUrl = searchPageUrl;
    }],
    ["about:blank committing to itself", (tab) => { tab.pendingUrl = "about:blank"; }],
  ]) {
    const fake = fakeCollectionChrome();
    const runtime = loadCollectionWindowRuntime(fake);
    await runtime.collectPages(collectionWindowRequest(), async () => {});
    const [[windowId, window]] = [...fake.windowMap.entries()];
    const [anchorTabId] = window.tabIds;
    assert.equal(window.state, "minimized", label);
    disturb(fake.tabMap.get(anchorTabId));

    fake.calls.length = 0;
    await runtime.collectPages(collectionWindowRequest(), async () => {}, { pageStart: 6, pageEnd: 8 });
    assert.deepEqual(collectionWindowCalls(fake, "tabs.create"), [], label);
    assert.deepEqual(collectionWindowCalls(fake, "windows.create"), [], label);
    assert.deepEqual(collectionWindowCalls(fake, "windows.update"), [], label);
    assert.deepEqual(collectionTabUpdates(fake)[0], [anchorTabId, collectionWindowPageUrl(6), false], label);
    assert.deepEqual(fake.windowMap.get(windowId).tabIds, [anchorTabId], label);
    assert.equal(fake.windowMap.get(windowId).state, "minimized", label);
    assert.equal(fake.tabMap.get(anchorTabId).url, "about:blank", label);
  }
});

test("collector never takes over its parked tab once it is visible or someone navigates it", async () => {
  for (const [label, disturb] of [
    ["navigated elsewhere", (tab) => { tab.url = "https://example.com/owner"; }],
    ["navigated to a look-alike host", (tab) => { tab.url = "https://search.shopping.naver.com.example/owner"; }],
    ["address typed into the parked tab", (tab) => { tab.pendingUrl = "https://mail.example.com/owner"; }],
    ["restored by verification or a person", (_tab, window) => { window.state = "normal"; }],
    ["another tab opened in the parked window", (_tab, window, fake) => {
      const id = 9_999;
      fake.tabMap.set(id, { id, windowId: window.id, url: "https://example.com/second" });
      window.tabIds.push(id);
    }],
  ]) {
    const fake = fakeCollectionChrome();
    const runtime = loadCollectionWindowRuntime(fake);
    await runtime.collectPages(collectionWindowRequest(), async () => {});
    const [[windowId, window]] = [...fake.windowMap.entries()];
    const [anchorTabId] = window.tabIds;
    assert.deepEqual(fake.session, { momentInsightRankCollectionWindow: { windowId, tabId: anchorTabId } }, label);
    disturb(fake.tabMap.get(anchorTabId), window, fake);
    const before = { ...fake.tabMap.get(anchorTabId) };
    const tabsBefore = [...window.tabIds];

    fake.calls.length = 0;
    await runtime.collectPages(collectionWindowRequest(), async () => {});
    assert.equal(collectionWindowCalls(fake, "tabs.create").length, 1, label);
    assert.equal(collectionWindowCalls(fake, "tabs.update").some(([, id]) => id === anchorTabId), false, label);
    // Nothing is minimized or surfaced while the person's window is in view.
    assert.deepEqual(collectionWindowCalls(fake, "windows.update"), [], label);
    assert.deepEqual(fake.windowMap.get(windowId).tabIds, tabsBefore, label);
    assert.deepEqual(fake.tabMap.get(anchorTabId), before, label);
  }
});

test("collector bounds its minimize retries to four, 150 ms apart", async () => {
  // A window manager that never honours the minimize: the collector still
  // collects, tries exactly four times per attempt window and never loops.
  const waits = [];
  const fake = fakeCollectionChrome({ minimizeIgnored: 100 });
  const runtime = loadCollectionWindowRuntime(fake, { recordWait: (milliseconds) => waits.push(milliseconds) });
  await runtime.collectPages(collectionWindowRequest(), async () => {}, { pageStart: 1, pageEnd: 1 });
  const [[windowId]] = [...fake.windowMap.entries()];
  // Four at creation, four more when the still-visible window is parked.
  assert.deepEqual(collectionWindowCalls(fake, "windows.update"), Array(8).fill(
    ["windows.update", windowId, { state: "minimized" }],
  ));
  assert.deepEqual(waits, Array(16).fill(150));
  assert.equal(fake.tabMap.get(fake.windowMap.get(windowId).tabIds[0]).url, "about:blank");
});

test("collector survives an unavailable session store without ever closing the last window", async () => {
  const fake = fakeCollectionChrome({ sessionThrows: true });
  const runtime = loadCollectionWindowRuntime(fake);
  await runtime.collectPages(collectionWindowRequest(), async () => {});
  assert.equal(fake.windowMap.size, 1);
  const [[windowId, window]] = [...fake.windowMap.entries()];
  const [parkedTabId] = window.tabIds;
  assert.equal(fake.tabMap.get(parkedTabId).url, "about:blank");

  // Without the session marker the parked window is treated like any window.
  fake.calls.length = 0;
  await runtime.collectPages(collectionWindowRequest(), async () => {});
  assert.equal(collectionWindowCalls(fake, "tabs.create").length, 1);
  assert.deepEqual(collectionWindowCalls(fake, "windows.create"), []);
  assert.equal(fake.windowMap.size, 1);
  assert.deepEqual(fake.windowMap.get(windowId).tabIds, [parkedTabId]);
});

// 2026-09-27: only the stage code reached the server. The extension keeps a
// sanitized copy of Chrome's own text beside the unchanged code.
test("extension keeps a sanitized Chrome error text beside the stage code, never inside it", () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const helperStart = serviceWorker.indexOf("const TYPED_COLLECTION_ERROR_PATTERN");
  const helperEnd = serviceWorker.indexOf("function wait(milliseconds)", helperStart);
  const { typedCollectionError, collectionErrorDetail } = runInNewContext(
    `${serviceWorker.slice(helperStart, helperEnd)}\n({ typedCollectionError, collectionErrorDetail });`,
  );
  const typed = (error, fallback = "naver_page_navigation_failed") => typedCollectionError(error, fallback);

  const noWindow = typed(new Error("No current window"));
  assert.equal(noWindow.message, "naver_page_navigation_failed");
  assert.equal(noWindow.errorDetail, "No current window");
  const refused = typed(new Error('Cannot access contents of url "https://search.shopping.naver.com/search/all?query=남자팬티&pagingIndex=2". Extension manifest must request permission to access this host.'), "naver_page_script_failed");
  assert.equal(refused.message, "naver_page_script_failed");
  assert.equal(refused.errorDetail, "Cannot access contents of");
  assert.equal(typed(new Error("탭 오류 tab error")).errorDetail, "tab error");
  assert.equal(typed(new Error("x".repeat(500))).errorDetail.length, 120);
  // A self-typed failure (its message is the code) carries no detail.
  for (const code of ["naver_page_timeout", "provider_deadline_exceeded", "naver_verification_required"]) {
    assert.equal(Object.hasOwn(typed(new Error(code)), "errorDetail"), false, code);
  }
  // A code-only error keeps its code and its Chrome text rides beside it.
  const codeOnlyError = new Error("Could not establish connection. Receiving end does not exist.");
  codeOnlyError.code = "native_host_communication_failed";
  const codeOnly = typed(codeOnlyError, "naver_page_script_failed");
  assert.equal(codeOnly.message, "native_host_communication_failed");
  assert.equal(codeOnly.errorDetail, "Could not establish connection. Receiving end does not exist.");
  // An explicit detail is kept (sanitized) over the message.
  const explicit = new Error("naver_page_navigation_failed");
  explicit.errorDetail = "Frame with ID 0 is showing error page https://x.example/?q=1";
  assert.equal(typed(explicit).errorDetail, "Frame with ID 0 is showing error page");
  // An address-only text leaves nothing to keep.
  assert.equal(Object.hasOwn(typed(new Error("https://nid.naver.com/nidlogin.login")), "errorDetail"), false);

  // The extension rule is the shared contract rule without its keyword step.
  for (const value of [
    "No current window",
    "No tab with id: 41.",
    "net::ERR_ABORTED",
    'Cannot access contents of url "https://nid.naver.com/nidlogin.login?url=x"',
    "Cannot access a chrome:// URL",
    "탭 오류 tab error",
    "x".repeat(500),
    `  ${"word \t".repeat(40)}`,
    "",
    42,
    null,
  ]) {
    const detail = collectionErrorDetail(value);
    assert.equal(detail, sanitizeCollectionErrorDetail(value), String(value));
    assert.match(detail, /^[\x20-\x7E]{0,120}$/u);
    assert.equal(collectionErrorDetail(detail), detail);
  }
});

test("collection_error carries the sanitized Chrome text beside the unchanged code", async () => {
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  const slice = (startText, endText) => {
    const start = serviceWorker.indexOf(startText);
    const end = serviceWorker.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, startText);
    return serviceWorker.slice(start, end);
  };
  for (const [label, fakeOptions, expectedDetail] of [
    // 09-27: a profile with windows but a stale current window.
    ["tabs.create refused", { windows: [{ id: 7, tabs: ["chrome://newtab/"] }], tabsCreateRejects: "No current window" }, "No current window"],
    ["windows.create refused", { createRejects: "Browser window creation is not allowed." }, "Browser window creation is not allowed."],
  ]) {
    const fake = fakeCollectionChrome(fakeOptions);
    const runtime = runInNewContext(`
      const PAGE_COUNT = 8;
      const COLLECTION_TIMEOUT_MS = 12 * 60_000;
      ${slice("const COLLECTION_WINDOW_ANCHOR_KEY", "const LEGACY_CONTROLLER_PAGE_URL")}
      ${slice("const TYPED_COLLECTION_ERROR_PATTERN", "function wait(milliseconds)")}
      async function wait() {}
      function pageRequestDelay() { return 3_500; }
      function searchUrl(keyword, pageIndex) { return \`https://search.shopping.naver.com/search/all?pagingIndex=\${pageIndex}\`; }
      async function waitForTabComplete() {}
      async function readNextData() { return "page"; }
      async function saveStatus() {}
      async function clearVerificationState() {}
      async function surfaceVerificationTab(tabId) { return tabId; }
      ${slice("async function saveCollectionProgress(pageIndex)", 'async function saveStatus(status, detail = "")')}
      async function handleCollect(message, port) {
        ${slice('if (message?.type === "collect") {', 'if (message?.type === "summary")')}
      }
      ({ handleCollect });
    `, { chrome: fake.chrome });
    const messages = [];
    await runtime.handleCollect({
      type: "collect",
      requestId: "request-detail",
      request: collectionWindowRequest(),
    }, { postMessage: (message) => messages.push({ ...message }) });
    assert.deepEqual(messages, [{
      type: "collection_error",
      requestId: "request-detail",
      code: "naver_page_navigation_failed",
      errorDetail: expectedDetail,
    }], label);

    // A failure raised before Chrome is touched carries no detail key.
    const expired = [];
    await runtime.handleCollect({
      type: "collect",
      requestId: "request-expired",
      request: { ...collectionWindowRequest(), deadlineAt: new Date(Date.now() - 1).toISOString() },
    }, { postMessage: (message) => expired.push({ ...message }) });
    assert.deepEqual(expired, [{
      type: "collection_error",
      requestId: "request-expired",
      code: "provider_deadline_exceeded",
    }], label);
  }
});

test("native host re-sanitizes the extension's Chrome text with the request keyword and never folds it into the code", () => {
  const nativeHost = fs.readFileSync(new URL("./naver-shopping-native-host.mjs", import.meta.url), "utf8");
  const serviceWorker = fs.readFileSync(
    new URL("../tools/naver-shopping-chrome-extension/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    nativeHost,
    /import \{ sanitizeCollectionErrorDetail \} from "\.\.\/src\/server\/naver-shopping\/local-worker-contract\.mjs";/u,
  );
  const branch = nativeHost.slice(
    nativeHost.indexOf('if (response?.type === "collection_error") {'),
    nativeHost.indexOf('if (response?.type === "collection_page") {'),
  );
  assert.match(branch, /const code = safeCode\(response\?\.code \|\| "native_host_collection_failed"\);/u);
  assert.match(branch, /const error = new Error\(code\);\s*error\.code = code;/u);
  assert.match(
    branch,
    /sanitizeCollectionErrorDetail\(response\?\.errorDetail, \{\s*keyword: message\.request\?\.keyword,\s*\}\)/u,
  );
  assert.match(branch, /if \(errorDetail\) error\.errorDetail = errorDetail;\s*throw error;/u);
  // `detail` would be appended to some failure codes by the worker; never use it.
  assert.doesNotMatch(nativeHost, /error\.detail = /u);
  assert.doesNotMatch(serviceWorker, /\.detail = /u);
  assert.match(serviceWorker, /errorDetail: error\.errorDetail/u);
});

test("native host exchange rethrows a collection_error with its code unchanged and the request keyword masked", async () => {
  const nativeHost = fs.readFileSync(new URL("./naver-shopping-native-host.mjs", import.meta.url), "utf8");
  const slice = (startText, endText) => {
    const start = nativeHost.indexOf(startText);
    const end = nativeHost.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, startText);
    return nativeHost.slice(start, end);
  };
  const safeCodeSource = slice("function safeCode(error) {", "function runTrigger(start) {");
  const exchangeSource = slice("    async exchange(message) {", "\n  });\n  const summary = await runLocalShoppingWorker(");
  const exchangeError = async (response, keyword) => {
    const written = [];
    const { exchange } = runInNewContext(`
      const RESPONSE_TIMEOUT_MS = 14 * 60_000;
      let progressSink = null;
      ${safeCodeSource}
      ({
        ${exchangeSource}
      });
    `, {
      crypto: { randomUUID: () => "request-exchange" },
      writeMessage: (payload) => written.push(payload),
      nextMessage: async () => ({ requestId: "request-exchange", ...response }),
      assertNativeExchangeRequestId,
      createNativePageStreamCollector,
      resolveNativeExchangeWait,
      sanitizeCollectionErrorDetail,
    });
    let thrown = null;
    try {
      await exchange({
        type: "collect",
        pageStart: 1,
        pageEnd: 8,
        request: { keyword, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "collection_error must reject the exchange");
    assert.deepEqual(written.map((payload) => [payload.type, payload.requestId]), [["collect", "request-exchange"]]);
    return thrown;
  };
  const detailOf = (error) => (Object.hasOwn(error, "errorDetail") ? error.errorDetail : undefined);

  for (const [label, response, keyword, expected] of [
    ["ASCII keyword masked",
      { type: "collection_error", code: "naver_page_navigation_failed", errorDetail: "x Nike Air failed" },
      "nike air", ["naver_page_navigation_failed", "x <kw> failed"]],
    ["Chrome text kept as it is",
      { type: "collection_error", code: "naver_page_navigation_failed", errorDetail: "No current window" },
      "남자팬티", ["naver_page_navigation_failed", "No current window"]],
    ["address cut before the keyword step",
      { type: "collection_error", code: "naver_page_script_failed", errorDetail: 'Cannot access contents of url "https://search.shopping.naver.com/search/all?query=nike"' },
      "nike", ["naver_page_script_failed", "Cannot access contents of"]],
    ["no detail from an extension without the field",
      { type: "collection_error", code: "naver_page_timeout" },
      "nike air", ["naver_page_timeout", undefined]],
    ["a malformed detail is dropped",
      { type: "collection_error", code: "naver_page_timeout", errorDetail: 42 },
      "nike air", ["naver_page_timeout", undefined]],
    ["the detail never enters the fallback code",
      { type: "collection_error", errorDetail: "No current window" },
      "nike air", ["native_host_collection_failed", "No current window"]],
    ["the code is typed exactly as before",
      { type: "collection_error", code: "Naver Page Failed!", errorDetail: "No current window" },
      "nike air", ["naver_page_failed_", "No current window"]],
  ]) {
    const error = await exchangeError(response, keyword);
    assert.deepEqual([error.message, error.code, detailOf(error)], [expected[0], expected[0], expected[1]], label);
    assert.equal(Object.hasOwn(error, "detail"), false, label);
  }
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

  assert.equal(manifest.version, "1.1.32");
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
  assert.doesNotMatch(nonVerificationSurfaceSource, /active:\s*true|focused:\s*true/u);
  assert.deepEqual(
    Array.from(nonVerificationSurfaceSource.matchAll(/chrome\.windows\.update\(([^)]*)\)/gu), (match) => match[1]),
    ['windowId, { state: "minimized" }'],
  );
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
    runtimeVersion: "1.1.32",
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
