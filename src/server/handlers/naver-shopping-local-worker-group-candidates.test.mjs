import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { signLocalWorkerRequest } from "../local-worker-auth.mjs";
import { forgetGroupMarkColumnMissing, forgetOptionColumnMissing } from "../naver-rank-option-group.mjs";
import {
  STABLE_FINITE_WINDOW_PROOF_VERSION,
  stableFiniteWindowDigest,
} from "../../../tools/naver-shopping-rank-collector/src/contract.mjs";
import {
  calculateN30RuntimeFingerprint,
  N30_RUNTIME_COMPONENTS,
} from "../../../scripts/naver-shopping-runtime-fingerprint.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// N30 그룹상품 후보(대표 승인 2026-10-27 A안) — 로컬 워커 submit(운영 유일한 30일 기록 경로)을 서명된 요청으로 끝까지 돌린다.
//   W1 표시한 추적 + 대표 번호가 결과에 없음 → 스냅샷 item.groupCandidates(최대 5개), 순위·문장·다른 커밋 인자는 그대로
//   W2 표시 안 함·칸 없음·대표가 보임·후보 카드 없음 → 커밋 인자 바이트 동일(후보 계산 자체를 안 함)
//   W3 옵션 번호가 있는 추적은 표시 없이도 그룹상품, 옵션이 잡히면 후보 없음
//   W4 fail-soft: 후보 계산이 실패해도 순위 결과는 그대로 커밋
//   W5 표시 칸 없음(대표 SQL 전)·옵션 칸까지 없음 → 한 번 더 읽고 수집 정상, 10분 기억
//   W6 유한 창도 같은 규칙 · 외부 요청 0 · 런타임 1.1.34 지문 그대로

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
  forgetGroupMarkColumnMissing();
  try {
    return await callback();
  } finally {
    forgetOptionColumnMissing();
    forgetGroupMarkColumnMissing();
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
            const wantsMark = columns.includes("group_product_marked");
            let result;
            if (wantsMark && options.markColumnMissing && !options.optionColumnMissing) {
              result = { data: null, error: { code: "42703", message: "column naver_rank_trackers.group_product_marked does not exist" } };
            } else if (wantsOptions && options.optionColumnMissing) {
              result = { data: null, error: { code: "42703", message: "column naver_rank_trackers.option_product_ids does not exist" } };
            } else if (wantsOptions && options.optionReadError) {
              result = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
            } else {
              result = {
                data: rows.map((row) => {
                  const { option_product_ids: optionIds, group_product_marked: marked, ...legacy } = row;
                  return {
                    ...legacy,
                    ...(wantsOptions && optionIds !== undefined ? { option_product_ids: optionIds } : {}),
                    ...(wantsMark && marked !== undefined ? { group_product_marked: marked } : {}),
                  };
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

const CAND_A = "99900000011";
const CAND_B = "99900000012";

// 같은 임대 시각을 써야 두 번 돌린 커밋 인자를 바이트로 비교할 수 있다.
const LEASE_STARTED_AT = new Date().toISOString();
const LEASE_UNTIL = new Date(Date.now() + 12 * 60_000).toISOString();

function marked(overrides = {}) {
  return tracker({
    option_product_ids: [],
    group_product_marked: true,
    processing_started_at: LEASE_STARTED_AT,
    processing_until: LEASE_UNTIL,
    ...overrides,
  });
}

function candidateCard(rank, sellerProductId, overrides = {}) {
  return card(rank, sellerProductId, { title: "아이쉘 아이폰16 저반사 액정보호필름 2매", lprice: 9900, ...overrides });
}

const PRICED_HISTORY = () => {
  const row = PRIMARY_HISTORY();
  row.item.lprice = 9900;
  return row;
};

function withoutCandidates(args) {
  const copy = JSON.parse(JSON.stringify(args));
  delete copy.p_snapshot.item.groupCandidates;
  return copy;
}

function stableArgs(args) {
  // 커밋마다 새로 만드는 값(임대 시각은 고정값, 수집 id·시각은 창 값)만 남는다 — 비교는 같은 창으로 한다.
  return JSON.parse(JSON.stringify(args));
}

test("W1 표시한 추적의 대표 번호가 결과에 없으면 같은 스토어 비슷한 카드를 후보로 남기고, 순위·문장·다른 인자는 그대로다", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({
      40: candidateCard(40, CAND_A),
      55: candidateCard(55, CAND_B, { mallName: "다른몰" }),
      61: candidateCard(61, "99900000061", { title: "아이쉘 아이폰16 사생활보호 액정보호필름" }),
      62: candidateCard(62, "99900000062", { lprice: 30000 }),
    });
    const markedRun = await submit([marked()], window, { history: [PRICED_HISTORY()] });
    const plainRun = await submit([marked({ group_product_marked: false })], window, { history: [PRICED_HISTORY()] });
    assert.equal(markedRun.response.status, 200, JSON.stringify(markedRun.body));
    assert.equal(markedRun.body.committedCount, 1);
    const args = markedRun.state.commits[0].args;
    assert.equal(args.p_snapshot.matched, false);
    assert.equal(args.p_snapshot.rank, null);
    assert.deepEqual(args.p_snapshot.item.groupCandidates, [{
      productId: CAND_A,
      rank: 40,
      title: "아이쉘 아이폰16 저반사 액정보호필름 2매",
      mallName: "아이쉘",
      lprice: 9900,
      link: `https://smartstore.naver.com/main/products/${CAND_A}`,
    }], "다른 스토어·다른 종류·가격 차이 카드는 뺀다(광고 카드는 창 검증이 먼저 막고 판정 표 C1 이 본다)");
    assert.deepEqual(withoutCandidates(args), stableArgs(plainRun.state.commits[0].args), "후보 칸 말고는 표시 안 한 추적과 바이트 같다(순위·문장·스토어·제목 인자)");
    assert.ok(markedRun.state.trackerSelects[0].includes("group_product_marked"));
    assert.ok(JSON.stringify(args).length - JSON.stringify(plainRun.state.commits[0].args).length < 400, "스냅샷이 아주 조금만 커진다(egress)");
  });
});

test("W1 후보는 최대 5개, 순위 순", async () => {
  await withWorkerEnv(async () => {
    const cards = {};
    for (const rank of [90, 41, 42, 43, 44, 45, 46]) cards[rank] = candidateCard(rank, String(99900000000 + rank));
    const { state } = await submit([marked()], strictWindow(cards), { history: [PRICED_HISTORY()] });
    assert.deepEqual(state.commits[0].args.p_snapshot.item.groupCandidates.map((entry) => entry.rank), [41, 42, 43, 44, 45]);
  });
});

test("W2 표시 안 함·칸 없음·대표가 보임·후보 카드 없음이면 커밋 인자가 바이트 단위로 같다", async () => {
  await withWorkerEnv(async () => {
    const notFound = strictWindow({ 40: candidateCard(40, CAND_A) });
    const base = marked({ group_product_marked: false });
    const { group_product_marked: _mark, ...noMarkColumn } = base;
    const off = await submit([base], notFound, { history: [PRICED_HISTORY()] });
    const missing = await submit([noMarkColumn], notFound, { history: [PRICED_HISTORY()] });
    assert.deepEqual(missing.state.commits[0].args, off.state.commits[0].args);
    assert.equal(Object.hasOwn(off.state.commits[0].args.p_snapshot.item, "groupCandidates"), false);

    const found = strictWindow({ 12: card(12, PRIMARY), 40: candidateCard(40, CAND_A) });
    const foundOff = await submit([base], found, { history: [PRICED_HISTORY()] });
    const foundOn = await submit([marked()], found, { history: [PRICED_HISTORY()] });
    assert.equal(foundOn.state.commits[0].args.p_snapshot.rank, 12);
    assert.deepEqual(foundOn.state.commits[0].args, foundOff.state.commits[0].args, "대표가 보이면 표시해도 같다");

    const empty = strictWindow({ 40: candidateCard(40, CAND_A, { mallName: "다른몰" }) });
    const emptyOff = await submit([base], empty, { history: [PRICED_HISTORY()] });
    const emptyOn = await submit([marked()], empty, { history: [PRICED_HISTORY()] });
    assert.deepEqual(emptyOn.state.commits[0].args, emptyOff.state.commits[0].args, "후보가 0개면 예전 스냅샷 그대로");
  });
});

test("W3 옵션 번호가 있으면 표시 없이도 그룹상품: 옵션이 안 보이면 후보, 옵션이 잡히면 후보 없음", async () => {
  await withWorkerEnv(async () => {
    const withOption = marked({ group_product_marked: false, option_product_ids: [OPTION_15] });
    const missingRun = await submit([withOption], strictWindow({ 40: candidateCard(40, CAND_A) }), { history: [PRICED_HISTORY()] });
    const snapshot = missingRun.state.commits[0].args.p_snapshot;
    assert.equal(snapshot.item.matchBasis, "not_found");
    assert.deepEqual(snapshot.item.groupCandidates.map((entry) => entry.productId), [CAND_A]);
    assert.match(snapshot.message, /그룹상품 옵션 1개 모두/u, "문장은 예전 그대로");
    assert.equal(Object.hasOwn(snapshot.item, "groupCandidates") && !snapshot.message.includes("후보"), true, "후보는 문장에 넣지 않는다");

    const hitRun = await submit([withOption], strictWindow({ 37: card(37, OPTION_15), 40: candidateCard(40, CAND_A) }), { history: [PRICED_HISTORY()] });
    const hit = hitRun.state.commits[0].args.p_snapshot;
    assert.equal(hit.item.matchBasis, "group_option");
    assert.equal(hit.rank, 37);
    assert.equal(Object.hasOwn(hit.item, "groupCandidates"), false, "번호가 잡히면 후보를 찾지 않는다");
  });
});

test("W4 fail-soft: 후보 계산이 실패해도(이상한 기록 행) 순위 결과 그대로 커밋하고 경고 1줄", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({ 40: candidateCard(40, CAND_A) });
    const hostile = PRICED_HISTORY();
    Object.defineProperty(hostile.item, "lprice", { get() { throw new Error("boom"); }, enumerable: true });
    const { value, lines } = await withQuietWarnings(() => submit([marked()], window, { history: [hostile] }));
    const reference = await submit([marked({ group_product_marked: false })], window, { history: [PRICED_HISTORY()] });
    assert.equal(value.response.status, 200);
    assert.equal(value.body.committedCount, 1);
    assert.deepEqual(value.state.commits[0].args, reference.state.commits[0].args, "후보 없이 예전과 같은 커밋");
    assert.equal(lines.filter((line) => line.includes("naver_rank_group_candidates_failed")).length, 1);
  });
});

test("W5 표시 칸이 없으면(대표 SQL 전) 옵션 칸까지 읽어 수집 정상, 10분 기억 · 옵션 칸도 없으면 옛 조회", async () => {
  await withWorkerEnv(async () => {
    const window = strictWindow({ 37: card(37, OPTION_16PRO), 40: candidateCard(40, CAND_A) });
    const { value, lines } = await withQuietWarnings(async () => {
      const first = await submit([marked({ option_product_ids: [OPTION_16PRO] })], window, { history: [PRICED_HISTORY()], markColumnMissing: true });
      const second = await submit([marked({ option_product_ids: [OPTION_16PRO] })], window, { history: [PRICED_HISTORY()], markColumnMissing: true });
      return { first, second };
    });
    assert.equal(value.first.response.status, 200);
    assert.equal(value.first.state.commits[0].args.p_snapshot.item.matchBasis, "group_option", "옵션 판정은 그대로 돈다");
    assert.deepEqual(value.first.state.trackerSelects.map((columns) => columns.includes("group_product_marked")), [true, false]);
    assert.deepEqual(value.second.state.trackerSelects.map((columns) => columns.includes("group_product_marked")), [false], "10분 동안 다시 묻지 않는다");
    assert.equal(lines.filter((line) => line.includes("naver_rank_group_mark_column_missing")).length, 1);

    forgetGroupMarkColumnMissing();
    const both = await withQuietWarnings(() => submit([marked()], strictWindow({ 12: card(12, PRIMARY) }), { history: [PRICED_HISTORY()], optionColumnMissing: true }));
    assert.equal(both.value.response.status, 200);
    assert.equal(both.value.state.commits[0].args.p_snapshot.rank, 12);
    assert.equal(both.value.state.trackerSelects.length, 2);
    assert.equal(both.value.state.trackerSelects[1].includes("option_product_ids"), false, "옵션 칸도 없으면 옛 조회");
  });
});

test("W6 유한 창도 같은 규칙 · 외부 요청 0 · 런타임 1.1.34 지문 그대로", async () => {
  await withWorkerEnv(async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw new Error("unexpected_network_request");
    };
    try {
      const finite = finiteWindow({ 12: candidateCard(12, CAND_A) }, 40);
      const { response, state } = await submit([marked()], finite, { history: [PRICED_HISTORY()] });
      assert.equal(response.status, 200);
      assert.equal(state.commits[0].name, "mi_commit_naver_shopping_finite_worker_result");
      assert.deepEqual(state.commits[0].args.p_snapshot.item.groupCandidates.map((entry) => [entry.productId, entry.rank]), [[CAND_A, 12]]);
      await submit([marked()], strictWindow({ 40: candidateCard(40, CAND_A) }), { history: [PRICED_HISTORY()] });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(fetchCalls, [], "네이버·상품 페이지 요청 0");
  });
  const { fingerprint } = calculateN30RuntimeFingerprint({ repositoryRoot: root, version: "1.1.34" });
  assert.equal(fingerprint, RUNTIME_1_1_34_FINGERPRINT);
  for (const component of N30_RUNTIME_COMPONENTS) {
    const source = fs.readFileSync(path.join(root, component), "utf8");
    assert.equal(source.includes("group_product_marked") || source.includes("groupCandidates"), false, `${component} 는 후보를 알면 안 된다`);
  }
});
