import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveChromeExtensionId } from "./install-naver-shopping-chrome-bridge.mjs";
import {
  buildNativeWindowFromPages,
  createChromeNativeProvider,
} from "./naver-shopping-native-host-core.mjs";
import { SCHEMA_VERSION } from "../tools/naver-shopping-rank-collector/src/contract.mjs";

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

test("manifest public key produces a stable Chrome extension id", async () => {
  const manifest = await import("../tools/naver-shopping-chrome-extension/manifest.json", {
    with: { type: "json" },
  });
  assert.equal(deriveChromeExtensionId(manifest.default.key), "pflggephankeefaeoaafkmggampnaefm");
});

test("native host wrapper uses a stable path, bounded jobs and safe local canary config", () => {
  const wrapperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-naver-shopping-native-host.sh");
  const source = fs.readFileSync(wrapperPath, "utf8");
  assert.match(source, /naver-shopping-native-host\.conf/u);
  assert.match(source, /MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS="25"/u);
  assert.match(source, /127\\\.0\\\.0\\\.1\|localhost/u);
  assert.match(source, /naver-shopping-native-host\.log/u);
  assert.doesNotMatch(source, /WORKER_SECRET[^\n]*>>/u);
  const lint = spawnSync("/bin/zsh", ["-n", wrapperPath], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stderr);
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
  assert.match(serviceWorker, /if \(!existing\) await chrome\.alarms\.create\(name, definition\)/u);
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
