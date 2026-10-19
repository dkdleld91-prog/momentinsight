import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createStoredRankCategoryLookup, storedCategoryScope, storedKeywordKey, STORED_CATEGORY_SOURCE } from "./stored-rank-keyword-categories.mjs";

const NOW = Date.parse("2026-10-19T03:00:00Z");
const KEYWORD = "온열찜질기";
const AGENCY = "mml93-a01";
const ID = {
  tracker: "11111111-1111-4111-8111-111111111111",
  snapshot: "22222222-2222-4222-8222-222222222222",
  claim: "33333333-3333-4333-8333-333333333333",
  cycle: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
};
const COLLECTION = "pw-chrome-1789340710996-fixture1";
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const config = () => ({ SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_fixture_private" });
const request = (code = AGENCY, extra = {}) => new Request("https://app.example/api/client/keyword-research?mode=related", {
  headers: { "x-mi-session-role": "client", "x-mi-agency-code": code, ...extra },
});
const json = (rows, status = 200) => new Response(JSON.stringify(rows), { status, headers: { "content-type": "application/json" } });
const fingerprint = (keyword, scope = ID.cycle) => crypto.createHash("sha256").update(`${scope}:${keyword.trim().toLowerCase().replace(/\s+/gu, "")}`).digest("hex");

function fixture(keyword = KEYWORD, agencyCode = AGENCY) {
  const topItems = Array.from({ length: 5 }, (_, index) => ({
    productId: String(12345000 + index), category2: "냉온/찜질용품", category3: "찜질기", isOrganic: true, isAd: false,
  }));
  const snapshot = {
    id: ID.snapshot, tracker_id: ID.tracker, checked_at: iso(-60_000), collected_at: iso(-120_000),
    evidence_collection_id: COLLECTION, checked_count: 300, collection_id: COLLECTION,
    source: "naver_shopping_results_collector", top_items: topItems,
  };
  const common = { claim_id: ID.claim, cycle_id: ID.cycle, run_id: ID.run, group_fingerprint: fingerprint(keyword) };
  return {
    trackers: [{ id: ID.tracker, keyword, agency_code: agencyCode, snapshots: [snapshot] }],
    terminals: [{ ...common, event_id: "13", event_type: "tracker_committed", occurred_at: iso(-59_000), tracker_id: ID.tracker, agency_code: agencyCode, collection_id: COLLECTION, checked_count: 300 }],
    events: [
      // Actual scheduler INSERT omits agency_code for a shared keyword group.
      { ...common, event_id: "10", event_type: "group_claimed", occurred_at: iso(-180_000), tracker_id: null, agency_code: null, collection_id: null, checked_count: null },
      { ...common, event_id: "11", event_type: "tracker_claimed", occurred_at: iso(-175_000), tracker_id: ID.tracker, agency_code: agencyCode, collection_id: null, checked_count: null },
    ],
  };
}

function harness({ data = fixture(), env = config(), clock = () => NOW, fetchHook } = {}) {
  const calls = [];
  const lookup = createStoredRankCategoryLookup({ env, now: clock, fetchImpl: async (value, options) => {
    const url = new URL(value);
    calls.push({ url, options });
    assert.equal(url.origin, new URL(env.SUPABASE_URL).origin);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
    assert.ok(options.signal instanceof AbortSignal);
    if (fetchHook) {
      const response = await fetchHook(url, options, calls.length);
      if (response !== undefined) return response;
    }
    if (url.pathname === "/rest/v1/naver_rank_trackers") return json(structuredClone(data.trackers));
    assert.equal(url.pathname, "/rest/v1/naver_shopping_scheduler_events");
    return json(structuredClone(url.searchParams.get("event_type") === "eq.tracker_committed" ? data.terminals : data.events));
  } });
  return { lookup, calls };
}

async function lookupOne(data, options = {}) {
  const h = harness({ data, ...options });
  const rows = await h.lookup([options.keyword || KEYWORD], { request: options.request || request(), ...(options.deadline ? { deadline: options.deadline } : {}) });
  return { category: rows[0]?.category, rows, ...h };
}

test("scope uses only trusted session headers and denies public, trial and invalid owner", () => {
  assert.equal(storedCategoryScope(new Request("https://app.example/?agencyCode=mml93-a01")), null);
  assert.equal(storedCategoryScope(request(AGENCY, { "x-mi-session-scope": "trial" })), null);
  assert.equal(storedCategoryScope(request(AGENCY, { "x-mi-session-role": "owner" })), null);
  assert.deepEqual(storedCategoryScope(request("owner-session", { "x-mi-session-role": "owner", "x-mi-owner-agency-code": AGENCY }), config()), { agencyCode: AGENCY });
  assert.equal(storedCategoryScope(request("owner-session", { "x-mi-session-role": "owner", "x-mi-owner-agency-code": AGENCY }), { ...config(), NODE_ENV: "production", MI_PRIMARY_AGENCY_CODE: "other" }), null);
  const team = new Request("https://app.example", { headers: { "x-mi-session-role": "team", "x-mi-session-scope": "account-only", "x-mi-team-code": "team-123" } });
  assert.deepEqual(storedCategoryScope(team), { agencyCode: "team-123" });
});

test("stored keyword matching trims and NFC-normalizes only; case and inner spaces remain exact", () => {
  assert.equal(storedKeywordKey(" A B "), "A B");
  assert.notEqual(storedKeywordKey("A B"), storedKeywordKey("AB"));
  assert.notEqual(storedKeywordKey("ABC"), storedKeywordKey("abc"));
  assert.equal(storedKeywordKey("\u1100\u1161"), "가");
});

test("real group-null-agency shape verifies one saved top-five sample with three read-only GETs", async () => {
  const { category, calls } = await lookupOne(fixture());
  assert.equal(category.status, "single");
  assert.equal(category.middle, "냉온/찜질용품");
  assert.equal(category.small, "찜질기");
  assert.equal(category.source, STORED_CATEGORY_SOURCE);
  assert.equal(category.basis, "stored_top5");
  assert.equal(category.sampleSize, 5);
  assert.equal(category.categorizedCount, 5);
  assert.equal(category.checkedAt, iso(-120_000));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.searchParams.get("agency_code"), `eq.${AGENCY}`);
  assert.match(calls[0].url.searchParams.get("select"), /collected_at:item->>collectedAt/u);
  assert.match(calls[0].url.searchParams.get("select"), /evidence_collection_id:item->>collectionId/u);
  assert.equal(calls[0].url.searchParams.get("snapshots.limit"), "1");
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(category), /fixture_private|collection_id|tracker_id|12345000/u);
});

test("multiple actual paths are distinct from missing category fields", async () => {
  const data = fixture();
  data.trackers[0].snapshots[0].top_items[4].category2 = "침구류";
  data.trackers[0].snapshots[0].top_items[4].category3 = "전기매트";
  const mixed = await lookupOne(data);
  assert.equal(mixed.category.status, "multiple");
  assert.equal(mixed.category.paths.length, 2);
  assert.equal(mixed.category.middle, "");
  data.trackers[0].snapshots[0].top_items[4].category3 = "";
  const partial = await lookupOne(data);
  assert.equal(partial.category.status, "needs_confirmation");
  assert.equal(partial.category.reason, "incomplete_sample");
  assert.equal(partial.category.categorizedCount, 4);
});

test("mixed observed paths with a missing field remain multiple with incomplete reason", async () => {
  const data = fixture();
  data.trackers[0].snapshots[0].top_items[3].category3 = "전기매트";
  data.trackers[0].snapshots[0].top_items[4].category3 = "";
  const { category } = await lookupOne(data);
  assert.equal(category.status, "multiple");
  assert.equal(category.reason, "incomplete_sample");
  assert.equal(category.categorizedCount, 4);
});

for (const [label, mutate] of [
  ["old capture", (d) => { d.trackers[0].snapshots[0].collected_at = iso(-86_400_001); }],
  ["future capture", (d) => { d.trackers[0].snapshots[0].collected_at = iso(61_000); }],
  ["missing collected time", (d) => { delete d.trackers[0].snapshots[0].collected_at; }],
  ["wrong collection alias", (d) => { d.trackers[0].snapshots[0].evidence_collection_id = "pw-chrome-other"; }],
  ["partial checked count", (d) => { d.trackers[0].snapshots[0].checked_count = 299; }],
  ["wrong provider", (d) => { d.trackers[0].snapshots[0].source = "product_url"; }],
  ["truncated four-product window", (d) => { d.trackers[0].snapshots[0].top_items.pop(); }],
  ["advertisement", (d) => { d.trackers[0].snapshots[0].top_items[0].isAd = true; }],
  ["nonorganic", (d) => { d.trackers[0].snapshots[0].top_items[0].isOrganic = false; }],
  ["duplicate product", (d) => { d.trackers[0].snapshots[0].top_items[1].productId = d.trackers[0].snapshots[0].top_items[0].productId; }],
  ["wrong returned tenant", (d) => { d.trackers[0].agency_code = "other-tenant"; }],
  ["wrong snapshot tracker", (d) => { d.trackers[0].snapshots[0].tracker_id = ID.snapshot; }],
  ["wrong terminal tenant", (d) => { d.terminals[0].agency_code = "other-tenant"; }],
  ["wrong claim tenant", (d) => { d.events[1].agency_code = "other-tenant"; }],
  ["explicit wrong group tenant", (d) => { d.events[0].agency_code = "other-tenant"; }],
  ["duplicate terminal", (d) => { d.terminals.push(structuredClone(d.terminals[0])); }],
  ["duplicate group", (d) => { d.events.push(structuredClone(d.events[0])); }],
  ["wrong event order", (d) => { d.events[0].event_id = "12"; }],
  ["wrong time order", (d) => { d.events[1].occurred_at = iso(-58_000); }],
  ["wrong immutable fingerprint", (d) => { d.events[0].group_fingerprint = "f".repeat(64); }],
  ["mismatched terminal run", (d) => { d.terminals[0].run_id = ID.snapshot; }],
  ["mismatched group cycle", (d) => { d.events[0].cycle_id = ID.snapshot; }],
]) {
  test(`${label} cannot become category success`, async () => {
    const data = fixture();
    mutate(data);
    assert.equal((await lookupOne(data)).category.status, "needs_confirmation");
  });
}

test("no stored rows, missing latest snapshot and strict keyword mismatch do not invent results", async () => {
  for (const data of [
    { trackers: [], terminals: [], events: [] },
    { ...fixture(), trackers: [{ ...fixture().trackers[0], snapshots: [] }] },
    fixture("온열 찜질기"),
    fixture("abc"),
  ]) {
    const { category } = await lookupOne(data, { keyword: data.trackers[0]?.keyword === "abc" ? "ABC" : KEYWORD });
    assert.equal(category.status, "needs_confirmation");
  }
});

test("newer invalid evidence is never replaced with an older successful tracker snapshot", async () => {
  const data = fixture();
  const older = structuredClone(data.trackers[0]);
  older.id = "66666666-6666-4666-8666-666666666666";
  older.snapshots[0].tracker_id = older.id;
  older.snapshots[0].checked_at = iso(-300_000);
  older.snapshots[0].collection_id = "pw-chrome-older";
  data.trackers.push(older);
  data.trackers[0].snapshots[0].top_items[0].isAd = true;
  assert.equal((await lookupOne(data)).category.status, "needs_confirmation");
});

test("same collection mirrored across trackers counts the saved five products only once", async () => {
  const data = fixture();
  const tracker = structuredClone(data.trackers[0]);
  tracker.id = "66666666-6666-4666-8666-666666666666";
  tracker.snapshots[0].id = "77777777-7777-4777-8777-777777777777";
  tracker.snapshots[0].tracker_id = tracker.id;
  data.trackers.push(tracker);
  data.terminals.push({ ...data.terminals[0], tracker_id: tracker.id, event_id: "14" });
  data.events.push({ ...data.events[1], tracker_id: tracker.id, event_id: "12" });
  const { category } = await lookupOne(data);
  assert.equal(category.status, "single");
  assert.equal(category.sampleSize, 5);
  assert.equal(category.paths[0].sampleCount, 5);
  tracker.snapshots[0].top_items[0].category3 = "충돌분류";
  assert.equal((await lookupOne(data)).category.status, "needs_confirmation");
});

test("keyword filter escapes quotes, backslashes and punctuation as data", async () => {
  const keyword = '찜질기"),agency_code.eq.other,\\기타';
  const data = fixture(keyword);
  const { category, calls } = await lookupOne(data, { keyword });
  const escaped = keyword.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  assert.equal(calls[0].url.searchParams.get("keyword"), `in.("${escaped}")`);
  assert.equal(calls[0].url.searchParams.get("agency_code"), `eq.${AGENCY}`);
  assert.equal(calls[0].url.searchParams.has("or"), false);
  assert.equal(category.status, "single");
});

test("tracker and ledger cap overflow fails closed instead of silently dropping rows", async () => {
  for (const stage of ["trackers", "terminals", "events"]) {
    const data = fixture();
    const cap = stage === "events" ? 120 : 60;
    data[stage] = Array.from({ length: cap + 1 }, () => structuredClone(data[stage][0]));
    assert.equal((await lookupOne(data)).category.status, "needs_confirmation");
  }
});

test("cached category objects are cloned and isolated by tenant and credential config", async () => {
  const env = config();
  let current = fixture();
  const h = harness({ env, fetchHook: (url) => {
    if (url.pathname.endsWith("naver_rank_trackers")) return json(current.trackers);
    return json(url.searchParams.get("event_type") === "eq.tracker_committed" ? current.terminals : current.events);
  } });
  const first = await h.lookup([KEYWORD], { request: request() });
  first[0].category.middle = "로컬변경";
  const cached = await h.lookup([KEYWORD], { request: request() });
  assert.equal(cached[0].category.middle, "냉온/찜질용품");
  assert.equal(h.calls.length, 3);
  current = fixture(KEYWORD, "other-tenant");
  current.trackers[0].snapshots[0].top_items.forEach((item) => { item.category2 = "다른계정분류"; });
  const other = await h.lookup([KEYWORD], { request: request("other-tenant") });
  assert.equal(other[0].category.middle, "다른계정분류");
  assert.equal(h.calls.length, 6);
  env.SUPABASE_SECRET_KEY = "sb_secret_rotated_private";
  await h.lookup([KEYWORD], { request: request("other-tenant") });
  assert.equal(h.calls.length, 9);
});

test("legacy JWT header is supported but category failures never trigger an external fallback", async () => {
  const env = { ...config(), SUPABASE_SECRET_KEY: "eyJfixture.payload.signature", NAVER_KEYWORD_CATEGORY_SOURCE: "commerce", NAVER_COMMERCE_CLIENT_ID: "private", NAVER_KEYWORD_CATEGORY_COLLECTOR_URL: "https://must-not-call.invalid" };
  const { category, calls } = await lookupOne(fixture(), { env });
  assert.equal(category.status, "single");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${env.SUPABASE_SECRET_KEY}`);
  assert.equal(calls.length, 3);
  const denied = await lookupOne(fixture(), { env, fetchHook: () => json({ message: "secret-token traceback" }, 403) });
  assert.equal(denied.category.status, "needs_confirmation");
  assert.equal(denied.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(denied.rows), /secret-token|traceback|private|must-not-call/u);
});

test("missing source, unsafe URL, public scope and expired deadline all make zero requests", async () => {
  for (const options of [
    { env: {} },
    { env: { ...config(), SUPABASE_URL: "https://fixture.supabase.co.evil.invalid" } },
    { request: new Request("https://app.example/?agencyCode=mml93-a01") },
    { deadline: NOW - 1 },
  ]) {
    const { category, calls } = await lookupOne(fixture(), options);
    assert.equal(category.status, "needs_confirmation");
    assert.equal(calls.length, 0);
  }
});

test("injected deadline blocks a late response before another DB GET or a successful result", async () => {
  let time = NOW;
  const { category, calls } = await lookupOne(fixture(), { clock: () => time, deadline: NOW + 100, fetchHook: (_url, _options, number) => {
    if (number === 1) time += 101;
  } });
  assert.equal(category.status, "needs_confirmation");
  assert.equal(category.reason, "source_timeout");
  assert.equal(calls.length, 1);
});

test("a transport ignoring cancellation returns finite timeout without starting more requests", async () => {
  const { category, calls } = await lookupOne(fixture(), { deadline: NOW + 20, fetchHook: () => new Promise(() => {}) });
  assert.equal(category.status, "needs_confirmation");
  assert.equal(category.reason, "source_timeout");
  assert.equal(calls.length, 1);
});

test("a shared pending read cannot make a shorter-deadline caller wait for the first caller", async () => {
  const data = fixture();
  const h = harness({ data, fetchHook: (_url, _options, call) => call === 1
    ? new Promise((resolve) => setTimeout(() => resolve(json(data.trackers)), 40)) : undefined });
  const first = h.lookup([KEYWORD], { request: request() });
  const second = await h.lookup([KEYWORD], { request: request(), deadline: NOW + 5 });
  assert.equal(second[0].category.reason, "source_timeout");
  assert.equal((await first)[0].category.status, "single");
  assert.equal(h.calls.length, 3);
});

test("a missing candidate timestamp cannot be sorted behind a valid older success", async () => {
  const data = fixture();
  const candidate = structuredClone(data.trackers[0]);
  candidate.id = "66666666-6666-4666-8666-666666666666";
  candidate.snapshots[0].tracker_id = candidate.id;
  candidate.snapshots[0].checked_at = null;
  candidate.snapshots[0].collection_id = "pw-chrome-other-unknown";
  data.trackers.push(candidate);
  assert.equal((await lookupOne(data)).category.reason, "evidence_unproven");
});
