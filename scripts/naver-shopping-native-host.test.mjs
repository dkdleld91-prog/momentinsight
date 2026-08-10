import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildChromeSchedulerPlist,
  deriveChromeExtensionId,
  installChromeBridge,
  resolveChromeApplicationPath,
  resolveChromeProfileDirectory,
} from "./install-naver-shopping-chrome-bridge.mjs";
import {
  buildNativeWindowFromPages,
  buildNativeWindowFromRows,
  createChromeNativeProvider,
} from "./naver-shopping-native-host-core.mjs";
import { SCHEMA_VERSION } from "../tools/naver-shopping-rank-collector/src/contract.mjs";

function assertZshSyntax(scriptPath, source) {
  const lint = spawnSync("/bin/zsh", ["-n", scriptPath], { encoding: "utf8" });
  if (lint.error?.code === "ENOENT") {
    assert.match(source, /^#!\/bin\/zsh\r?\n/u);
    assert.doesNotMatch(source, /\r/u);
    return;
  }
  assert.equal(lint.status, 0, lint.stderr);
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

test("Chrome extension drains safely and reports verification recovery truthfully", () => {
  const extensionDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "naver-shopping-chrome-extension");
  const serviceWorker = fs.readFileSync(path.join(extensionDirectory, "service-worker.js"), "utf8");
  const popup = fs.readFileSync(path.join(extensionDirectory, "popup.js"), "utf8");
  const nativeHost = fs.readFileSync(new URL("./naver-shopping-native-host.mjs", import.meta.url), "utf8");
  const localWorker = fs.readFileSync(new URL("./naver-shopping-local-worker.mjs", import.meta.url), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDirectory, "manifest.json"), "utf8"));

  assert.equal(manifest.version, "1.0.25");
  assert.deepEqual(manifest.icons, {
    16: "icon16.png",
    32: "icon32.png",
    48: "icon48.png",
    128: "icon128.png",
  });
  assert.equal(manifest.action.default_icon[16], "icon16.png");
  assert.equal(manifest.action.default_icon[32], "icon32.png");
  for (const iconName of Object.values(manifest.icons)) {
    assert.ok(fs.statSync(path.join(extensionDirectory, iconName)).size > 0);
  }
  assert.match(serviceWorker, /"rank-remote"/u);
  assert.match(serviceWorker, /NATIVE_HOST_RUN_TIMEOUT_MS = 30 \* 60_000/u);
  assert.match(serviceWorker, /\["rank-remote", \{ delayInMinutes: 1, periodInMinutes: 1 \}\]/u);
  assert.match(serviceWorker, /result\.status === "standby"/u);
  assert.match(serviceWorker, /result\.status === "idle" && result\.remoteWake === false/u);
  assert.match(localWorker, /action: "claim-lane"/u);
  assert.match(localWorker, /action: "release-lane"/u);
  assert.match(localWorker, /action: "block-lane"/u);
  assert.doesNotMatch(serviceWorker, /rank-drain-follow-up/u);
  assert.match(serviceWorker, /VERIFICATION_COOLDOWN_MS = 60 \* 60_000/u);
  assert.match(serviceWorker, /NAVER_ACCESS_COOLDOWN_CODES/u);
  assert.match(serviceWorker, /NAVER_MANUAL_RESUME_CODES/u);
  assert.match(serviceWorker, /MANUAL_RESUME_REQUIRED_KEY/u);
  assert.match(serviceWorker, /NETWORK_RETRY_COUNT_KEY/u);
  assert.match(serviceWorker, /NETWORK_RESTRICTION_RETRY_DELAYS_MS = \[/u);
  assert.match(serviceWorker, /NETWORK_RESTRICTION_RETRY_DELAYS_MS = \[\s*30 \* 60_000,\s*60 \* 60_000,\s*120 \* 60_000,\s*\]/u);
  assert.match(serviceWorker, /scheduleNetworkRestrictionRetry/u);
  assert.match(serviceWorker, /preserveNetworkRetryCount: true/u);
  assert.match(serviceWorker, /naver_network_restricted/u);
  assert.match(serviceWorker, /findResolvedNaverTab/u);
  assert.match(serviceWorker, /surfaceVerificationTab/u);
  assert.match(serviceWorker, /prepareVerificationState/u);
  assert.match(serviceWorker, /inspectNaverTab/u);
  assert.match(serviceWorker, /closeTab: false,[\s\S]{0,100}preserveNetworkRetryCount: true/u);
  assert.match(serviceWorker, /const verificationPreparation = await prepareVerificationState\(trigger, verification\)/u);
  assert.ok(
    serviceWorker.indexOf("await prepareVerificationState(trigger, verification)")
      < serviceWorker.indexOf("chrome.runtime.connectNative(NATIVE_HOST)"),
  );
  assert.match(serviceWorker, /collectPriceComparePages\(message\.request, collectionTabId, \{[\s\S]+activateTab: trigger === "manual"/u);
  assert.match(serviceWorker, /NAVER_SHOPPING_HOME_URL = "https:\/\/shopping\.naver\.com\/ns\/home"/u);
  assert.match(serviceWorker, /NPLUS_SEARCH_PATH = "\/ns\/search"/u);
  assert.match(serviceWorker, /enterPriceCompareNormally/u);
  assert.match(serviceWorker, /naver_price_compare_link_missing/u);
  assert.match(serviceWorker, /location\.assign\(anchor\.href\)/u);
  assert.match(serviceWorker, /chrome\.tabs\.create\(\{ url: NAVER_SHOPPING_HOME_URL, active: activateTab \}\)/u);
  assert.ok(
    serviceWorker.indexOf("await enterPriceCompareNormally(tabId, request.keyword, activateTab)")
      < serviceWorker.indexOf("for (let pageIndex = 1; pageIndex <= PAGE_COUNT; pageIndex += 1)"),
  );
  assert.ok(
    serviceWorker.indexOf("url.pathname === NPLUS_SEARCH_PATH")
      < serviceWorker.indexOf("location.assign(anchor.href)"),
  );
  assert.match(serviceWorker, /surfaceVerificationTab/u);
  assert.match(serviceWorker, /surfaceNetworkRestrictionTab/u);
  assert.match(serviceWorker, /PRICE_COMPARE_SEARCH_PATH = "\/search\/all"/u);
  assert.match(serviceWorker, /pagingIndex/u);
  assert.match(serviceWorker, /productSet/u);
  assert.match(serviceWorker, /nextDataText/u);
  assert.doesNotMatch(serviceWorker, /NVSCTAB|data-shp-contents-rank/u);
  assert.match(serviceWorker, /CHROME_OPERATION_TIMEOUT_MS = 45_000/u);
  assert.match(serviceWorker, /withTimeout\(chrome\.scripting\.executeScript/u);
  assert.match(serviceWorker, /naver_page_script_timeout/u);
  assert.match(serviceWorker, /if \(tabId != null && !error\.tabId\) error\.tabId = tabId/u);
  assert.match(serviceWorker, /if \(error\?\.tabId\) collectionTabId = error\.tabId/u);
  assert.match(serviceWorker, /if \(collectionTabId != null && !keepCollectionTabOpen\)/u);
  assert.match(serviceWorker, /naver_verification_cooldown/u);
  assert.match(serviceWorker, /failed > 0 \? "partial" : "completed"/u);
  assert.match(serviceWorker, /재시도 \$\{failed\}건/u);
  assert.match(popup, /status\?\.status === "partial"/u);
  assert.match(popup, /확인 후 다시 시작/u);
  assert.match(popup, /일부 갱신 완료/u);
  assert.match(serviceWorker, /const workerTrigger = verificationPreparation\.recovered \? "rank-recovery" : trigger/u);
  assert.match(serviceWorker, /if \(verification\.blockedUntil > 0\)[\s\S]{0,160}recovered: true/u);
  assert.match(serviceWorker, /port\.postMessage\(\{ action: "run", trigger: workerTrigger \}\)/u);
  assert.match(serviceWorker, /NATIVE_HOST_START_TIMEOUT_MS = 30_000/u);
  assert.match(serviceWorker, /native_host_start_timeout/u);
  assert.match(serviceWorker, /STALE_RUNNING_STATUS_MS = 2 \* 60_000/u);
  assert.match(serviceWorker, /native_host_interrupted/u);
  assert.match(popup, /중단된 작업을 정리했습니다/u);
  assert.match(serviceWorker, /sendResponse\(\{ ok: true, started: true \}\)/u);
  assert.match(popup, /30~45초 안전 대기 후 가격비교 탭이 열립니다/u);
  assert.match(nativeHost, /WHOLE_SITE_QUEUE_TRIGGERS = new Set\(\["manual", "rank-catch-up"\]\)/u);
  assert.match(nativeHost, /RESPONSE_TIMEOUT_MS = 18 \* 60_000/u);
  assert.match(nativeHost, /writeMessage\(\{ type: "ready" \}\)/u);
  assert.match(nativeHost, /readyAck = await nextMessage\(30_000\)/u);
  assert.match(nativeHost, /native_host_ready_ack_invalid/u);
  assert.match(serviceWorker, /message\?\.type === "ready"/u);
  assert.match(serviceWorker, /port\.postMessage\(\{ action: "ready_ack" \}\)/u);
  assert.match(localWorker, /NAVER_SHOPPING_PROVIDER_TIMEOUT_MS,[\s\S]{0,120}18 \* 60_000/u);
  assert.match(localWorker, /"native_host_response_timeout"/u);
  assert.match(nativeHost, /queueAllTrackers: WHOLE_SITE_QUEUE_TRIGGERS\.has\(start\.trigger\)/u);
  assert.match(nativeHost, /requireWakeSignal: start\.trigger === "rank-remote"/u);
  assert.match(popup, /전체 \$\{queuedTotal\}개 등록/u);
  assert.match(popup, /retryAt/u);
  assert.match(popup, /이후 1건 자동 재시도/u);
  assert.doesNotMatch(popup, /접속 제한이 해제된 뒤 수동으로 다시 시작/u);
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
  assert.match(serviceWorker, /\["rank-catch-up", \{ delayInMinutes: 20, periodInMinutes: 20 \}\]/u);
  assert.match(serviceWorker, /existing\.periodInMinutes/u);
  assert.match(serviceWorker, /await chrome\.alarms\.create\(name, definition\)/u);
  assert.match(serviceWorker, /INITIAL_REQUEST_DELAY_MS = 30_000/u);
  assert.match(serviceWorker, /INITIAL_REQUEST_JITTER_MS = 15_000/u);
  assert.match(serviceWorker, /PAGE_REQUEST_INTERVAL_MS = 45_000/u);
  assert.match(serviceWorker, /PAGE_REQUEST_JITTER_MS = 30_000/u);
  assert.match(serviceWorker, /await wait\(initialRequestDelay\(\)\)/u);
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
