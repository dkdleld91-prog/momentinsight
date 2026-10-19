import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { inspectConfig, verifyRelatedKeywordConnection } from "../../scripts/verify-related-keyword-connection.mjs";

const NOW = Date.parse("2026-10-19T01:00:00Z");
const args = ["--live", "--keyword", "온열찜질기"];
const env = () => ({ SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_private", MI_PRIMARY_AGENCY_CODE: "mml93-a01", NODE_ENV: "production" });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const id = { tracker: "11111111-1111-4111-8111-111111111111", snapshot: "22222222-2222-4222-8222-222222222222", claim: "33333333-3333-4333-8333-333333333333", cycle: "44444444-4444-4444-8444-444444444444", run: "55555555-5555-4555-8555-555555555555" };
const collection = "pw-chrome-private-fixture-1234";
const iso = (offset) => new Date(NOW + offset).toISOString();

function fixture() {
  const top_items = Array.from({ length: 5 }, (_, i) => ({ productId: String(12345000 + i), category2: "냉온/찜질용품", category3: "찜질기", isOrganic: true, isAd: false }));
  const snapshot = { id: id.snapshot, tracker_id: id.tracker, checked_at: iso(-60_000), collected_at: iso(-120_000), evidence_collection_id: collection, checked_count: 300, collection_id: collection, source: "naver_shopping_results_collector", top_items };
  const shared = { claim_id: id.claim, cycle_id: id.cycle, run_id: id.run, group_fingerprint: crypto.createHash("sha256").update(`${id.cycle}:온열찜질기`).digest("hex") };
  return {
    trackers: [{ id: id.tracker, keyword: "온열찜질기", agency_code: "mml93-a01", snapshots: [snapshot] }],
    terminals: [{ ...shared, event_id: "13", event_type: "tracker_committed", occurred_at: iso(-59_000), tracker_id: id.tracker, agency_code: "mml93-a01", collection_id: collection, checked_count: 300 }],
    claims: [
      { ...shared, event_id: "10", event_type: "group_claimed", occurred_at: iso(-180_000), agency_code: null },
      { ...shared, event_id: "11", event_type: "tracker_claimed", occurred_at: iso(-175_000), tracker_id: id.tracker, agency_code: "mml93-a01" },
    ],
  };
}

function harness(data = fixture(), extra = {}) {
  const calls = [];
  return { calls, input: { args, env: env(), now: () => NOW, ...extra, fetchImpl: async (value, options) => {
    const url = new URL(value);
    calls.push({ url, options });
    assert.equal(url.origin, "https://fixture.supabase.co");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.apikey, (extra.env || env()).SUPABASE_SECRET_KEY);
    assert.ok(options.signal instanceof AbortSignal);
    if (extra.fetchImpl) return extra.fetchImpl(value, options);
    if (url.pathname === "/rest/v1/naver_rank_trackers") return json(data.trackers);
    assert.equal(url.pathname, "/rest/v1/naver_shopping_scheduler_events");
    return json(url.searchParams.get("event_type") === "eq.tracker_committed" ? data.terminals : data.claims);
  } } };
}

test("config inspection returns booleans only and does not infer category evidence from SearchAd", async () => {
  let calls = 0;
  const credentials = { ...env(), NAVER_SEARCHAD_API_KEY: "private-api", NAVER_SEARCHAD_SECRET_KEY: "private-secret", NAVER_SEARCHAD_CUSTOMER_ID: "private-customer", NAVER_API_HUB_CLIENT_ID: "private-hub", NAVER_API_HUB_CLIENT_SECRET: "private-hub-secret" };
  const config = inspectConfig(credentials);
  assert.equal(config.categorySource, "stored_rank_snapshot_categories");
  assert.equal(config.storedDatabase.configured, true);
  assert.equal(config.searchAd.configured, true);
  assert.equal(config.externalSourcesEnabled, false);
  const result = await verifyRelatedKeywordConnection({ args: [], env: credentials, fetchImpl: async () => { calls += 1; } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.mode, "config_only");
  assert.equal(result.report.ok, false);
  assert.equal(result.report.liveVerified, false);
  assert.equal(result.report.wordListVerified, false);
  assert.equal(result.report.networkRequests, 0);
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result.report), /private-|sb_secret_/u);
});

test("explicit live and exact keyword are required before all DB requests", async () => {
  for (const supplied of [["--keyword", "온열찜질기"], ["--live"], ["--live", "--keyword", "--live"], [...args, "--live"], ["--live", "--keyword", "\n"]]) {
    const h = harness();
    const result = await verifyRelatedKeywordConnection({ ...h.input, args: supplied });
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.reason, "explicit_live_keyword_required");
    assert.equal(h.calls.length, 0);
  }
});

test("saved evidence verifies with exactly three bounded GETs and zero external calls", async () => {
  const h = harness();
  const result = await verifyRelatedKeywordConnection(h.input);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.ok, true);
  assert.equal(result.report.liveVerified, true);
  assert.equal(result.report.categoriesVerified, true);
  assert.equal(result.report.wordListVerified, false);
  assert.equal(result.report.count, 1);
  assert.equal(result.report.reason, "verified_stored_sample");
  assert.deepEqual(result.report.categories, { single: 1, multiple: 0, needs_confirmation: 0 });
  assert.deepEqual(result.report.networkCounts, { trackers: 1, terminals: 1, claims: 1 });
  assert.equal(result.report.networkRequests, 3);
  assert.equal(result.report.externalRequests, 0);
  assert.equal(result.report.rankRequests, 0);
  assert.equal(result.report.databaseWrites, 0);
  assert.equal(result.report.retries, 0);
  assert.equal(result.report.forbiddenRequests, 0);
  assert.equal(h.calls[0].options.headers.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(result.report), /private|온열찜질기|냉온|collection_id|12345000|11111111/u);
});

test("multiple full saved paths pass but incomplete multiple paths are never verified", async () => {
  const data = fixture();
  data.trackers[0].snapshots[0].top_items[3].category3 = "전기매트";
  const mixed = await verifyRelatedKeywordConnection(harness(data).input);
  assert.equal(mixed.report.categories.multiple, 1);
  assert.equal(mixed.report.categoriesVerified, true);
  data.trackers[0].snapshots[0].top_items[4].category3 = "";
  const incomplete = await verifyRelatedKeywordConnection(harness(data).input);
  assert.equal(incomplete.report.categories.multiple, 1);
  assert.equal(incomplete.report.reasons.incomplete_sample, 1);
  assert.equal(incomplete.report.categoriesVerified, false);
  assert.equal(incomplete.report.ok, false);
  assert.equal(incomplete.exitCode, 1);
});

test("missing data, stale data and broken ledger stay unverified without another source", async () => {
  for (const change of [
    (d) => { d.trackers = []; },
    (d) => { d.trackers[0].snapshots[0].collected_at = iso(-86_400_001); },
    (d) => { d.claims[0].group_fingerprint = "f".repeat(64); },
  ]) {
    const data = fixture();
    change(data);
    const h = harness(data);
    const result = await verifyRelatedKeywordConnection(h.input);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.ok, false);
    assert.equal(result.report.categoriesVerified, false);
    assert.equal(result.report.wordListVerified, false);
    assert.equal(result.report.categories.needs_confirmation, 1);
    assert.equal(result.report.externalRequests, 0);
    assert.ok(h.calls.length <= 3);
  }
});

test("old external credentials and provider switches cannot enable API traffic", async () => {
  const credentials = { ...env(), NAVER_KEYWORD_CATEGORY_SOURCE: "commerce", NAVER_COMMERCE_CLIENT_ID: "private-client", NAVER_COMMERCE_CLIENT_SECRET: "private-commerce-secret", NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "https://private.invalid", NAVER_KEYWORD_CATEGORY_COLLECTOR_TOKEN: "private-token", NAVER_SEARCHAD_API_KEY: "private-search" };
  const h = harness(fixture(), { env: credentials });
  const result = await verifyRelatedKeywordConnection(h.input);
  assert.equal(result.report.ok, true);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every((c) => c.url.hostname === "fixture.supabase.co"));
  assert.doesNotMatch(JSON.stringify(result.report), /private-/u);
  const missing = await verifyRelatedKeywordConnection({ ...h.input, env: { NAVER_SEARCHAD_API_KEY: "private-search" } });
  assert.equal(missing.report.networkRequests, 0);
  assert.equal(missing.report.reason, "source_unavailable");
});

test("owner proof, public/trial scope and unsafe config fail before network", async () => {
  for (const change of [
    { request: new Request("https://app.example", { headers: { "x-mi-session-role": "owner" } }) },
    { request: new Request("https://app.example") },
    { request: new Request("https://app.example", { headers: { "x-mi-session-role": "client", "x-mi-agency-code": "mml93-a01", "x-mi-session-scope": "trial" } }) },
    { env: { ...env(), MI_PRIMARY_AGENCY_CODE: "other" } },
    { env: { ...env(), SUPABASE_URL: "https://private.invalid" } },
    { env: { ...env(), SUPABASE_SECRET_KEY: "" } },
  ]) {
    const h = harness(fixture(), change);
    const result = await verifyRelatedKeywordConnection(h.input);
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.networkRequests, 0);
    assert.equal(h.calls.length, 0);
  }
});

test("transport secrets and denied provider bodies never escape reports", async () => {
  for (const fetchImpl of [async () => { throw new Error("private-token secret traceback"); }, async () => json({ message: "private-token secret traceback" }, 403)]) {
    const h = harness(fixture(), { fetchImpl });
    const result = await verifyRelatedKeywordConnection(h.input);
    assert.equal(result.report.networkRequests, 1);
    assert.equal(result.report.categoriesVerified, false);
    assert.equal(result.report.reasons.source_unavailable, 1);
    assert.doesNotMatch(JSON.stringify(result.report), /private-|secret traceback/u);
  }
});

test("legacy JWT headers follow existing conventions without reporting their values", async () => {
  const credentials = { ...env(), SUPABASE_SECRET_KEY: "eyJprivate.payload.signature" };
  const h = harness(fixture(), { env: credentials });
  const result = await verifyRelatedKeywordConnection(h.input);
  assert.equal(result.report.ok, true);
  assert.equal(h.calls[0].options.headers.authorization, `Bearer ${credentials.SUPABASE_SECRET_KEY}`);
  assert.doesNotMatch(JSON.stringify(result.report), /eyJprivate/u);
});

test("late deadline ends after one read with no retry or alternate source", async () => {
  let time = NOW;
  const h = harness(fixture(), { now: () => time, fetchImpl: async () => { time += 4_001; return json(fixture().trackers); } });
  const result = await verifyRelatedKeywordConnection(h.input);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.reason, "source_timeout");
  assert.equal(result.report.networkRequests, 1);
  assert.equal(result.report.ok, false);
});
