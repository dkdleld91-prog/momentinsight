import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { signLocalWorkerRequest } from "../local-worker-auth.mjs";
import { forgetOptionColumnMissing } from "../naver-rank-option-group.mjs";
import {
  STABLE_FINITE_WINDOW_PROOF_VERSION,
  stableFiniteWindowDigest,
} from "../../../tools/naver-shopping-rank-collector/src/contract.mjs";
import {
  calculateN30RuntimeFingerprint,
  N30_RUNTIME_COMPONENTS,
} from "../../../scripts/naver-shopping-runtime-fingerprint.mjs";

// N30 그룹상품 추적(2026-10-23) — 로컬 워커 submit(운영 유일한 30일 기록 경로)을 서명된 요청으로 끝까지 돌린다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SECRET = "test-local-worker-secret-that-is-longer-than-32-bytes";
const ENDPOINT = "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker";
const WORKER_ID = "test-primary-worker";
const LANE_TOKEN = "223e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "323e4567-e89b-42d3-a456-426614174000";
const TRACKER_A = "123e4567-e89b-42d3-a456-426614174000";
const TRACKER_B = "123e4567-e89b-42d3-a456-426614174001";
const KEYWORD = "아이폰16 프로 필름";
const PRIMARY = "12356459438";
const OPTION_16PRO = "99900000001";
const OPTION_15 = "99900000002";
const RUNTIME_1_1_34_FINGERPRINT = "5db29dbd1ca354fb50756e073e57c52b2a95f978bea89ba57d7c8c1e41856daf";

function signedRequest(payload) {
  const body = JSON.stringify({
    ...payload,
    workerId: WORKER_ID,
    laneToken: LANE_TOKEN,
    runId: RUN_ID,
    runtimeVersion: "1.1.34",
    runtimeFingerprint: "a".repeat(64),
    runTrigger: "rank-catch-up",
  });
  const timestamp = String(Math.trunc(Date.now() / 1000));
  const nonce = `worker-test-${crypto.randomUUID()}`;
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mi-worker-timestamp": timestamp,
      "x-mi-worker-nonce": nonce,
      "x-mi-worker-signature": signLocalWorkerRequest(SECRET, {
        timestamp,
        nonce,
        method: "POST",
        audience: "https://insight.momentlabs.co.kr",
        path: "/api/naver-shopping-local-worker",
        body,
      }),
    },
    body,
  });
}

async function withWorkerEnv(callback) {
  const previous = {
    enabled: process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED,
    secret: process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET,
  };
  process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED = "true";
  process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET = SECRET;
  forgetOptionColumnMissing();
  try {
    return await callback();
  } finally {
    forgetOptionColumnMissing();
    if (previous.enabled === undefined) delete process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED;
    else process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED = previous.enabled;
    if (previous.secret === undefined) delete process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET;
    else process.env.MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET = previous.secret;
  }
}

function tracker(overrides = {}) {
  return {
    id: TRACKER_A,
    agency_code: "mml93-a01",
    keyword: KEYWORD,
    product_url: `https://smartstore.naver.com/ishell/products/${PRIMARY}`,
    product_id: PRIMARY,
    mall_name: "아이쉘",
    product_title: "아이쉘 아이폰17 저반사 액정보호필름 2매",
    max_rank: 300,
    status: "active",
    current_rank: 12,
    best_rank: 8,
    worst_rank: 20,
    check_count: 40,
    found_count: 40,
    retry_count: 0,
    processing_started_at: new Date().toISOString(),
    processing_until: new Date(Date.now() + 12 * 60_000).toISOString(),
    option_product_ids: [OPTION_16PRO, OPTION_15],
    ...overrides,
  };
}

function organicItem(rank) {
  return {
    organicRank: rank,
    isOrganic: true,
    isAd: false,
    productId: String(1000000000 + rank),
    sellerProductId: String(2000000000 + rank),
    title: `액정 보호 필름 ${rank}`,
    mallName: `판매처 ${rank}`,
    link: `https://smartstore.naver.com/store${rank}/products/${2000000000 + rank}`,
    productType: "2",
  };
}

function card(rank, sellerProductId, overrides = {}) {
  return {
    ...organicItem(rank),
    productId: String(3000000000 + rank),
    sellerProductId,
    title: sellerProductId === PRIMARY
      ? "아이쉘 아이폰17 저반사 액정보호필름 2매"
      : "아이쉘 아이폰16 프로 저반사 액정보호필름 2매",
    mallName: "아이쉘",
    link: `https://smartstore.naver.com/main/products/${sellerProductId}`,
    ...overrides,
  };
}

function strictWindow(cards = {}) {
  const items = Array.from({ length: 300 }, (_, index) => cards[index + 1] || organicItem(index + 1));
  return {
    ok: true,
    schemaVersion: "mi.naver-shopping-organic-window.v1",
    keyword: KEYWORD,
    source: "naver_shopping_results_collector",
    rankEvidence: "naver_shopping_organic_list",
    collectionId: `pw-${Date.now()}-group-option-test`,
    collectedAt: new Date().toISOString(),
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: null,
    marketTotalStatus: "unavailable",
    checkedCount: 300,
    rawCount: 300,
    excludedAdCount: 0,
    items,
  };
}

function finiteWindow(cards = {}, count = 40) {
  const items = Array.from({ length: count }, (_, index) => ({
    ...(cards[index + 1] || organicItem(index + 1)),
    organicRank: index + 1,
    productType: 2,
  }));
  const digest = stableFiniteWindowDigest(items, { keyword: KEYWORD, marketTotal: items.length });
  return {
    ...strictWindow(),
    collectionId: `pw-chrome-${Date.now()}-group-finite`,
    sourceExhausted: true,
    marketTotal: items.length,
    marketTotalStatus: "verified",
    checkedCount: items.length,
    rawCount: items.length,
    items,
    finiteWindowProof: {
      version: STABLE_FINITE_WINDOW_PROOF_VERSION,
      passCount: 2,
      pageCount: 8,
      pageSize: 40,
      captureIds: ["finite-capture-0001", "finite-capture-0002"],
      passDigests: [digest, digest],
      marketTotal: items.length,
      checkedCount: items.length,
    },
  };
}

const PRIMARY_HISTORY = (trackerId = TRACKER_A, mallName = "아이쉘") => ({
  tracker_id: trackerId,
  checked_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  matched: true,
  item: {
    trackingRankSource: "exact_product",
    isExactTarget: true,
    sellerProductId: PRIMARY,
    mallName,
    isOrganic: true,
    isAd: false,
  },
});

function jobFor(rows) {
  return {
    keyword: KEYWORD,
    limit: 300,
    claims: rows.map((row) => ({
      trackerId: row.id,
      leaseStartedAt: row.processing_started_at,
      leaseUntil: row.processing_until,
    })),
  };
}

// 운영 DB 대신 기록만 하는 가짜. 옵션 칸 없음(대표 SQL 전)·다른 읽기 오류를 흉내 낼 수 있다.
function workerContext(rows, options = {}) {
  const state = { commits: [], trackerSelects: [], historyCalls: 0 };
  const ctx = {
    supabaseAdmin: {
      async rpc(name, args) {
        if (name === "mi_consume_naver_shopping_worker_nonce") return { data: true, error: null };
        if (name === "mi_load_naver_shopping_worker_catalog_history") {
          state.historyCalls += 1;
          const ids = new Set(args.p_tracker_ids.map(String));
          return { data: (options.history || []).filter((row) => ids.has(String(row.tracker_id))), error: null };
        }
        if (name === "mi_commit_naver_shopping_worker_result" || name === "mi_commit_naver_shopping_finite_worker_result") {
          state.commits.push({ name, args });
          return { data: { status: "committed", snapshotId: crypto.randomUUID() }, error: null };
        }
        throw new Error(`unexpected rpc:${name}`);
      },
      from(table) {
        assert.equal(table, "naver_rank_trackers");
        let columns = "";
        const query = {
          select(value) { columns = String(value); return query; },
          in() { return query; },
          then(resolve, reject) {
            state.trackerSelects.push(columns);
            const wantsOptions = columns.includes("option_product_ids");
            let result;
            if (wantsOptions && options.optionColumnMissing) {
              result = { data: null, error: { code: "42703", message: "column naver_rank_trackers.option_product_ids does not exist" } };
            } else if (wantsOptions && options.optionReadError) {
              result = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
            } else {
              result = {
                data: rows.map((row) => {
                  if (wantsOptions) return row;
                  const { option_product_ids: _ignored, ...legacy } = row;
                  return legacy;
                }),
                error: null,
              };
            }
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return query;
      },
    },
  };
  return { ctx, state };
}

async function submit(rows, window, options = {}) {
  const { handleLocalWorkerRequest } = await import("./naver-shopping-local-worker.mjs");
  const { ctx, state } = workerContext(rows, options);
  const response = await handleLocalWorkerRequest(signedRequest({ action: "submit", job: jobFor(rows), window }), ctx);
  return { response, body: await response.json(), state };
}

async function withQuietWarnings(callback) {
  const original = console.warn;
  const lines = [];
  console.warn = (line) => lines.push(String(line));
  try {
    return { value: await callback(), lines };
  } finally {
    console.warn = original;
  }
}

test("처리기 모듈과 새 판정 모듈이 정상적으로 불러와진다(불러오기 실패 = 수집 전면 정지)", async () => {
  const handler = await import("./naver-shopping-local-worker.mjs");
  const optionGroup = await import("../naver-rank-option-group.mjs");
  assert.equal(typeof handler.handleLocalWorkerRequest, "function");
  assert.equal(typeof optionGroup.evaluateGroupTrackingRank, "function");
});

test("T1 실제 사례: 대표 옵션이 바뀌어 대표 번호가 없고 옵션 카드가 37위면 37위로 커밋한다", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({ 37: card(37, OPTION_16PRO) });
    const { response, body, state } = await submit([tracker()], window, { history: [PRIMARY_HISTORY()] });
    assert.equal(response.status, 200);
    assert.equal(body.committedCount, 1);
    assert.equal(state.commits.length, 1);
    const { name, args } = state.commits[0];
    assert.equal(name, "mi_commit_naver_shopping_worker_result");
    assert.equal(args.p_snapshot.matched, true);
    assert.equal(args.p_snapshot.rank, 37);
    assert.equal(args.p_snapshot.checked_count, 300);
    assert.equal(args.p_snapshot.item.trackingRankSource, "exact_product");
    assert.equal(args.p_snapshot.item.matchBasis, "group_option");
    assert.equal(args.p_snapshot.item.matchedOptionProductId, OPTION_16PRO);
    assert.equal(args.p_snapshot.item.sellerProductId, OPTION_16PRO);
    assert.equal(args.p_snapshot.item.relatedCatalogProductId, null);
    assert.equal(args.p_snapshot.item.optionGroup.mallCheck, "matched");
    assert.equal(args.p_product_id, PRIMARY);
    assert.equal(args.p_mall_name, "아이쉘");
    assert.equal(args.p_product_title, "아이쉘 아이폰17 저반사 액정보호필름 2매");
    assert.match(args.p_snapshot.message, new RegExp(`^그룹상품 옵션\\(상품번호 ${OPTION_16PRO}\\)이 오가닉 37위로`, "u"));
    assert.ok(state.trackerSelects[0].includes("option_product_ids"));
    assert.equal(state.historyCalls, 1);
  });
});

test("T3 번호 없는 기존 추적은 칸이 없을 때·빈 목록일 때·대표가 보일 때 커밋 인자가 바이트 단위로 같다", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({ 12: card(12, PRIMARY), 37: card(37, OPTION_16PRO) });
    const base = tracker();
    const { option_product_ids: _ignored, ...legacyRow } = base;
    const legacy = await submit([legacyRow], window);
    const empty = await submit([{ ...base, option_product_ids: [] }], window);
    const grouped = await submit([base], window, { history: [PRIMARY_HISTORY()] });
    for (const run of [legacy, empty, grouped]) {
      assert.equal(run.response.status, 200);
      assert.equal(run.state.commits.length, 1);
    }
    assert.deepEqual(empty.state.commits[0].args, legacy.state.commits[0].args);
    assert.equal(legacy.state.commits[0].args.p_snapshot.rank, 12);
    assert.equal("matchBasis" in legacy.state.commits[0].args.p_snapshot.item, false);
    assert.equal("optionGroup" in empty.state.commits[0].args.p_snapshot.item, false);
    // 대표가 보이면 옵션 카드가 다른 자리에 있어도 대표 순위 — 다른 카드 경고 키·문장만 더해진다.
    const groupedArgs = grouped.state.commits[0].args;
    assert.equal(groupedArgs.p_snapshot.rank, 12);
    assert.equal(groupedArgs.p_snapshot.item.matchBasis, "primary");
    assert.equal(groupedArgs.p_snapshot.item.optionGroup.otherCardBestRank, 37);
    assert.equal(groupedArgs.p_product_id, legacy.state.commits[0].args.p_product_id);
    assert.equal(groupedArgs.p_mall_name, legacy.state.commits[0].args.p_mall_name);
  });
});

test("T3 대표가 보이고 옵션 카드가 없으면 옵션 있는 추적도 옵션 없는 추적과 커밋 인자가 같다", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({ 12: card(12, PRIMARY) });
    const base = tracker();
    const empty = await submit([{ ...base, option_product_ids: [] }], window);
    const grouped = await submit([base], window, { history: [PRIMARY_HISTORY()] });
    assert.deepEqual(grouped.state.commits[0].args, empty.state.commits[0].args);
  });
});

test("T3b 옵션 칸이 없으면(대표 SQL 전) 옛 조회로 한 번 더 읽고, 같은 인스턴스의 다음 submit 은 실패 조회를 보내지 않는다", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({ 37: card(37, OPTION_16PRO) });
    const { value, lines } = await withQuietWarnings(async () => {
      const first = await submit([tracker()], window, { optionColumnMissing: true });
      const second = await submit([tracker()], { ...window, collectionId: `${window.collectionId}-2` }, { optionColumnMissing: true });
      return { first, second };
    });
    const { first, second } = value;
    assert.equal(first.response.status, 200);
    assert.equal(first.state.commits.length, 1);
    assert.deepEqual(first.state.trackerSelects.map((columns) => columns.includes("option_product_ids")), [true, false]);
    // 옵션을 읽지 못했으니 지금 동작(대표 번호만) 그대로: 300개 밖.
    assert.equal(first.state.commits[0].args.p_snapshot.matched, false);
    assert.equal("matchBasis" in first.state.commits[0].args.p_snapshot.item, false);
    assert.deepEqual(second.state.trackerSelects.map((columns) => columns.includes("option_product_ids")), [false]);
    assert.equal(second.state.commits.length, 1);
    assert.equal(lines.filter((line) => line.includes("naver_rank_option_column_missing")).length, 1);
  });
});

test("T14 옵션 칸 없음이 아닌 읽기 오류는 지금처럼 0건 처리·LOCAL_WORKER_COMMIT_UNAVAILABLE", async () => {
  await withWorkerEnv(async () => {
    const { response, body, state } = await submit([tracker()], strictWindow(), { optionReadError: true });
    assert.equal(response.status, 409);
    assert.equal(body.code, "LOCAL_WORKER_SUBMIT_PARTIAL");
    assert.equal(body.partial.causeCode, "LOCAL_WORKER_COMMIT_UNAVAILABLE");
    assert.equal(body.partial.processedCount, 0);
    assert.equal(state.commits.length, 0);
    assert.equal(state.trackerSelects.length, 1);
  });
});

test("T4 원부 추적은 DB 에 옵션이 (가정상) 있어도 무시한다", async () => {
  await withWorkerEnv(async () => {
    const catalogTracker = tracker({
      product_id: "55555555555",
      product_url: "https://search.shopping.naver.com/catalog/55555555555",
      option_product_ids: [OPTION_16PRO],
    });
    const window = strictWindow({ 37: card(37, OPTION_16PRO) });
    const grouped = await submit([catalogTracker], window);
    const plain = await submit([{ ...catalogTracker, option_product_ids: [] }], window);
    assert.deepEqual(grouped.state.commits[0].args, plain.state.commits[0].args);
    assert.equal(grouped.state.commits[0].args.p_snapshot.matched, false);
  });
});

test("T5 대표·옵션 모두 300개 밖이면 not_found 로 커밋하고 문장에 옵션 개수를 남긴다", async () => {
  await withWorkerEnv(async () => {
    const { response, state } = await submit([tracker()], strictWindow(), { history: [PRIMARY_HISTORY()] });
    assert.equal(response.status, 200);
    const { args } = state.commits[0];
    assert.equal(args.p_snapshot.matched, false);
    assert.equal(args.p_snapshot.rank, null);
    assert.equal(args.p_snapshot.item.trackingRankSource, "not_found");
    assert.equal(args.p_snapshot.item.matchBasis, "not_found");
    assert.equal(args.p_snapshot.message, "대표 상품번호와 그룹상품 옵션 2개 모두 오가닉 상위 300개 결과에서 찾지 못했습니다.");
  });
});

test("T9 다른 스토어 카드는 순위에 넣지 않고, T9b 스토어 기준이 없어도 추적 스토어 칸을 옵션 카드 값으로 채우지 않는다", async () => {
  await withWorkerEnv(async () => {
    const otherStore = await submit(
      [tracker()],
      strictWindow({ 37: card(37, OPTION_16PRO, { mallName: "다른몰" }) }),
      { history: [PRIMARY_HISTORY()] },
    );
    const otherArgs = otherStore.state.commits[0].args;
    assert.equal(otherArgs.p_snapshot.matched, false);
    assert.equal(otherArgs.p_snapshot.item.optionGroup.mallMismatchCount, 1);
    assert.match(otherArgs.p_snapshot.message, new RegExp(`다른 스토어로 보여 뺀 옵션: ${OPTION_16PRO}\\.$`, "u"));

    const unverified = await submit(
      [tracker({ mall_name: null, product_title: null })],
      strictWindow({ 37: card(37, OPTION_16PRO) }),
    );
    const args = unverified.state.commits[0].args;
    assert.equal(args.p_snapshot.rank, 37);
    assert.equal(args.p_snapshot.item.optionGroup.mallCheck, "unverified");
    assert.equal(args.p_snapshot.item.optionGroup.titleCheck, "unverified");
    assert.equal(args.p_mall_name, null);
    assert.equal(args.p_product_title, null);
    assert.equal(args.p_product_id, PRIMARY);
    assert.match(args.p_snapshot.message, /대표 상품번호는 이번 결과에 없습니다\. 스토어를 확인하지 못해 확인 없이 기록했습니다\.$/u);
  });
});

test("[규칙 B·C'·E'] 첫 확인(기록 없음)에도 추적 mall_name 이 기준: 다른몰 옵션만 빼고(흔적 키), 기준이 없으면 확인 안 됨 옵션도 대표와 겨룬다(커밋 끝까지)", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({ 20: card(20, OPTION_16PRO, { mallName: "다른몰" }), 50: card(50, PRIMARY) });
    // (a) 추적 mall_name '아이쉘' + 기록 없음: 다른몰 카드는 다른 스토어 → 대표 50위. 문장·추적 칸 인자는 옵션 없는 추적과
    //     같고, 스냅샷 item 에 matchBasis 'primary' 와 뺀 번호 흔적 키만 더해진다(규칙 E').
    const grouped = await submit([tracker()], window);
    const plain = await submit([tracker({ option_product_ids: [] })], window);
    assert.equal(grouped.response.status, 200);
    assert.equal(grouped.state.commits.length, 1);
    const groupedArgs = grouped.state.commits[0].args;
    const plainGroupArgs = plain.state.commits[0].args;
    assert.equal(groupedArgs.p_snapshot.rank, 50);
    assert.equal(groupedArgs.p_snapshot.item.matchBasis, "primary");
    assert.deepEqual(groupedArgs.p_snapshot.item.optionGroup, {
      checkedOptionCount: 2,
      mallMismatchCount: 1,
      mallMismatchProductIds: [OPTION_16PRO],
    });
    const { matchBasis: _basis, optionGroup: _group, ...groupedItem } = groupedArgs.p_snapshot.item;
    assert.deepEqual({ ...groupedArgs.p_snapshot, item: groupedItem }, plainGroupArgs.p_snapshot);
    assert.equal(groupedArgs.p_snapshot.message, plainGroupArgs.p_snapshot.message);
    assert.doesNotMatch(groupedArgs.p_snapshot.message, /다른 스토어/u, "광고주 화면에도 나가는 문장에는 넣지 않는다");
    for (const key of ["p_product_id", "p_mall_name", "p_product_title", "p_checked_at", "p_next_check_at"]) {
      assert.equal(groupedArgs[key], plainGroupArgs[key], key);
    }

    // (b) 추적 mall_name 빈 값 + 기록 없음: 카드 이름을 대조할 기준이 없어 확인 안 됨 → 그래도 대표 50위보다 높은 20위를
    //     쓴다(규칙 C'). 꼬리를 붙이고, 추적 칸은 옵션 카드 값으로 채우지 않는다.
    const noReference = await submit([tracker({ mall_name: null })], window);
    const args = noReference.state.commits[0].args;
    assert.equal(args.p_snapshot.rank, 20);
    assert.equal(args.p_snapshot.item.trackingRankSource, "exact_product");
    assert.equal(args.p_snapshot.item.matchBasis, "group_option");
    assert.equal(args.p_snapshot.item.optionGroup.mallCheck, "unverified");
    assert.equal(args.p_snapshot.item.optionGroup.primaryProductRank, 50);
    assert.equal("unverifiedHigherRank" in args.p_snapshot.item.optionGroup, false);
    assert.match(args.p_snapshot.message, /대표 상품번호는 50위입니다\. 스토어를 확인하지 못해 확인 없이 기록했습니다\.$/u);
    assert.equal(args.p_mall_name, null);
    assert.equal(args.p_product_id, PRIMARY);

    // (c) 같은 스토어(아이쉘) 옵션 20위 + 대표 50위, 기록 없음(첫 확인): 추적 mall_name 으로 확인돼 옵션 20위(튀지 않음).
    const sameStore = await submit([tracker()], strictWindow({ 20: card(20, OPTION_16PRO), 50: card(50, PRIMARY) }));
    const sameArgs = sameStore.state.commits[0].args;
    assert.equal(sameArgs.p_snapshot.rank, 20);
    assert.equal(sameArgs.p_snapshot.item.matchBasis, "group_option");
    assert.equal(sameArgs.p_snapshot.item.optionGroup.mallCheck, "matched");
    assert.equal(sameArgs.p_snapshot.item.optionGroup.primaryProductRank, 50);
    assert.equal(sameArgs.p_mall_name, "아이쉘");
    assert.equal(sameArgs.p_product_id, PRIMARY);
  });
});

test("[원부 추적] 원부로만 잡혀 mall_name 이 원부 카드 이름('네이버')으로 채워진 추적도 같은 스토어 옵션 37위를 커밋한다", async () => {
  await withWorkerEnv(async () => {
    const catalog = {
      ...organicItem(150),
      productId: "55555555555",
      sellerProductId: "",
      catalogId: "55555555555",
      catalogSellerProductIds: [PRIMARY],
      link: "https://search.shopping.naver.com/catalog/55555555555",
      mallName: "네이버",
      title: "아이폰 필름 가격비교",
      productType: "1",
    };
    const catalogHistory = {
      tracker_id: TRACKER_A,
      checked_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      matched: true,
      item: {
        trackingRankSource: "related_catalog",
        relatedCatalogProductId: "55555555555",
        relatedCatalogRelationBasis: "catalog_seller_product_id",
        catalogId: "55555555555",
        productId: "55555555555",
        catalogSellerProductIds: [PRIMARY],
        isRelatedCatalog: true,
        mallName: "네이버",
        isOrganic: true,
        isAd: false,
      },
    };
    const window = strictWindow({ 37: card(37, OPTION_16PRO), 150: catalog });
    const { response, state } = await submit([tracker({ mall_name: "네이버" })], window, { history: [catalogHistory] });
    assert.equal(response.status, 200);
    const { args } = state.commits[0];
    assert.equal(args.p_snapshot.rank, 37);
    assert.equal(args.p_snapshot.item.trackingRankSource, "exact_product");
    assert.equal(args.p_snapshot.item.matchBasis, "group_option");
    // '네이버'는 원부 카드 이름일 수 있어 기준으로 쓰지 않는다 → 다른 스토어로 빠지지 않고 확인 안 됨.
    assert.equal(args.p_snapshot.item.optionGroup.mallCheck, "unverified");
    assert.equal(args.p_snapshot.item.optionGroup.primaryRankSource, "related_catalog");
    assert.equal(args.p_snapshot.item.optionGroup.primaryProductRank, 150);
    assert.equal(args.p_snapshot.item.relatedCatalogProductId, null);
    assert.match(args.p_snapshot.message, /대표 상품번호의 관련 원부는 150위입니다\. 스토어를 확인하지 못해 확인 없이 기록했습니다\.$/u);
    assert.equal(args.p_mall_name, "네이버", "옵션 커밋은 추적 칸을 바꾸지 않는다");
    assert.equal(args.p_product_id, PRIMARY);
  });
});

test("T10 유한 창(40개)에서도 옵션 8위가 finite 커밋으로 들어간다", async () => {
  await withWorkerEnv(async () => {
    const window = finiteWindow({ 8: card(8, OPTION_16PRO) });
    const { response, body, state } = await submit([tracker()], window, { history: [PRIMARY_HISTORY()] });
    assert.equal(response.status, 200);
    assert.equal(body.finiteCommittedCount, 1);
    const { name, args } = state.commits[0];
    assert.equal(name, "mi_commit_naver_shopping_finite_worker_result");
    assert.equal(args.p_snapshot.rank, 8);
    assert.equal(args.p_snapshot.checked_count, 40);
    assert.equal(args.p_snapshot.total, 40);
    assert.equal(args.p_snapshot.item.trackingRankSource, "exact_product");
    assert.equal(args.p_snapshot.item.finiteWindowProofVersion, STABLE_FINITE_WINDOW_PROOF_VERSION);
    assert.equal(args.p_snapshot.item.finiteMarketTotal, 40);
    assert.equal(args.p_snapshot.item.sourceExhausted, true);
    assert.equal(args.p_snapshot.item.isOrganic, true);
    assert.equal(args.p_snapshot.item.isAd, false);
    assert.equal(args.p_snapshot.item.matchBasis, "group_option");
  });
});

test("T12 한 키워드 묶음: 옵션 있는 A 는 옵션 판정, 옵션 없는 B 는 지금과 같고 둘 다 커밋된다", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({ 37: card(37, OPTION_16PRO), 90: card(90, "2000000090", { mallName: "판매처 90" }) });
    const a = tracker();
    const b = tracker({
      id: TRACKER_B,
      product_id: "2000000090",
      product_url: "https://smartstore.naver.com/store90/products/2000000090",
      mall_name: "판매처 90",
      product_title: "액정 보호 필름 90",
      option_product_ids: [],
    });
    const both = await submit([a, b], window, { history: [PRIMARY_HISTORY()] });
    assert.equal(both.response.status, 200);
    assert.equal(both.body.committedCount, 2);
    const [commitA, commitB] = both.state.commits.map((commit) => commit.args);
    assert.equal(commitA.p_tracker_id, TRACKER_A);
    assert.equal(commitA.p_snapshot.item.matchBasis, "group_option");
    const bOnly = await submit([b], window);
    const { p_lease_started_at: _leaseOne, ...bInBatch } = commitB;
    const { p_lease_started_at: _leaseTwo, ...bAlone } = bOnly.state.commits[0].args;
    assert.deepEqual(bInBatch, bAlone);
    assert.equal(commitB.p_snapshot.rank, 90);
    assert.equal("matchBasis" in commitB.p_snapshot.item, false);
  });
});

test("T13 성능: 같은 키워드 100추적 × 옵션 20개 × 300개 창 submit 이 옵션 없는 경우보다 1.5초 넘게 느려지지 않는다", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow();
    const options = Array.from({ length: 20 }, (_, index) => String(99900002000 + index));
    const rows = Array.from({ length: 100 }, (_, index) => tracker({
      id: `123e4567-e89b-42d3-a456-${String(426614175000 + index).padStart(12, "0")}`,
      option_product_ids: options,
    }));
    const plainRows = rows.map((row) => ({ ...row, option_product_ids: [] }));
    const plainStarted = performance.now();
    const plain = await submit(plainRows, window);
    const plainMs = performance.now() - plainStarted;
    const groupedStarted = performance.now();
    const grouped = await submit(rows, { ...window, collectionId: `${window.collectionId}-grouped` });
    const groupedMs = performance.now() - groupedStarted;
    assert.equal(plain.body.committedCount, 100);
    assert.equal(grouped.body.committedCount, 100);
    assert.ok(groupedMs - plainMs < 1500, `옵션 판정 추가 시간 ${Math.round(groupedMs - plainMs)}ms`);
  });
});

test("T13 성능: 창에 실제로 보이는 다른 카드 번호 50개(상한, 2026-10-27) × 100추적도 submit 이 몇 초 안에 끝나고 모두 커밋된다", async () => {
  // 반박 검토(2026-10-23) 재현: 추적마다 보이는 번호마다 300개 전체 판정을 다시 돌아 옵션 없음 0.2~0.5초가
  // 5.6~6.9초가 됐다(부하 없음). 같은 창·같은 번호 판정 기억 + 창당 정식 판정 상한으로 막는다.
  await withWorkerEnv(async () => {
    const visible = Array.from({ length: 50 }, (_, index) => String(99900002000 + index));
    const window = strictWindow(Object.fromEntries(visible.map((id, index) => [
      11 + index * 5,
      card(11 + index * 5, id, { mallName: `다른몰 ${index}` }),
    ])));
    const rows = Array.from({ length: 100 }, (_, index) => tracker({
      id: `123e4567-e89b-42d3-a456-${String(426614175000 + index).padStart(12, "0")}`,
      option_product_ids: visible,
    }));
    const plainRows = rows.map((row) => ({ ...row, option_product_ids: [] }));
    const history = rows.map((row) => PRIMARY_HISTORY(row.id));
    const timed = async (label, rowsToSubmit) => {
      const startedAt = performance.now();
      const result = await submit(rowsToSubmit, { ...window, collectionId: `${window.collectionId}-${label}` }, { history });
      return { result, ms: performance.now() - startedAt };
    };
    // 첫 submit 은 모듈 준비(JIT) 시간이 섞여 기준이 부풀므로 재지 않고 한 번 먼저 돌린다. 옵션 없음을 앞뒤로 두 번
    // 재고 큰 쪽을 기준으로 삼는다(전체 테스트와 함께 돌 때 부하가 바뀌어도 비교가 맞게).
    await timed("warm-up", plainRows);
    const plainBefore = await timed("plain-before", plainRows);
    const grouped = await timed("visible", rows);
    const plainAfter = await timed("plain-after", plainRows);
    assert.equal(plainBefore.result.body.committedCount, 100);
    assert.equal(grouped.result.body.committedCount, 100);
    assert.equal(plainAfter.result.body.committedCount, 100);
    // 다른 스토어 카드라 모두 빠지고 not_found 로 커밋된다(다른 스토어 꼬리 포함).
    const first = grouped.result.state.commits[0].args.p_snapshot;
    assert.equal(first.item.matchBasis, "not_found");
    assert.equal(first.item.optionGroup.mallMismatchCount, 50);
    // 반박 검토 전 코드는 옵션 없음의 약 16~20배(이 맥 부하 없음 0.33초 → 5.4초, 반박 검토 측정 부하 중 3초 → 62~86초),
    // 지금은 약 2배(0.33초 → 0.65초)다. 절대 시간 대신 같은 테스트 안의 옵션 없음과 비교한다(부하 중에도 흔들리지 않게).
    const plainMs = Math.max(plainBefore.ms, plainAfter.ms);
    assert.ok(
      grouped.ms < plainMs * 4 + 500,
      `보이는 번호 50개 × 100추적 ${Math.round(grouped.ms)}ms, 옵션 없음 ${Math.round(plainMs)}ms`,
    );
  });
});

test("T16 submit 중 옵션 판정은 외부 요청(네이버 상품·스토어 페이지)을 하지 않는다", async () => {
  await withWorkerEnv(async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("unexpected_external_fetch");
    };
    try {
      await submit([tracker()], strictWindow({ 37: card(37, OPTION_16PRO) }), { history: [PRIMARY_HISTORY()] });
      await submit([tracker()], strictWindow());
      await submit([tracker({ mall_name: null })], strictWindow({ 37: card(37, OPTION_16PRO) }));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls, 0);
  });
});

test("T15 런타임 지문·워커 무변경: 1.1.34 지문 그대로, 지문 부품·워커 진입점은 새 판정 모듈을 모른다", () => {
  const { fingerprint } = calculateN30RuntimeFingerprint({ repositoryRoot: root, version: "1.1.34" });
  assert.equal(fingerprint, RUNTIME_1_1_34_FINGERPRINT);
  const migration = fs.readFileSync(
    path.join(root, "supabase/migrations/20260929205303_naver_shopping_runtime_1_1_34_dead_lease_and_live_service_worker.sql"),
    "utf8",
  );
  assert.ok(migration.includes(RUNTIME_1_1_34_FINGERPRINT));
  assert.equal(N30_RUNTIME_COMPONENTS.includes("src/server/naver-rank-option-group.mjs"), false);
  assert.equal(N30_RUNTIME_COMPONENTS.includes("src/server/handlers/naver-shopping-local-worker.mjs"), false);
  assert.equal(N30_RUNTIME_COMPONENTS.includes("src/server/handlers/naver-rank-trackers.mjs"), false);
  for (const component of N30_RUNTIME_COMPONENTS) {
    const source = fs.readFileSync(path.join(root, component), "utf8");
    assert.equal(source.includes("naver-rank-option-group"), false, `${component} 가 새 모듈을 불러오면 안 된다`);
    assert.equal(source.includes("option_product_ids"), false, `${component} 는 옵션 번호를 알면 안 된다`);
  }
});
