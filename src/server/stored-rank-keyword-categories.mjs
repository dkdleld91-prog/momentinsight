import crypto from "node:crypto";
import { PRIMARY_AGENCY_CODE, primaryAgencyConfiguration } from "./owner-identity.mjs";
import { readBoundedJson } from "./category-source-utils.mjs";

export const STORED_CATEGORY_SOURCE = "stored_rank_snapshot_categories";
const DAY = 86_400_000;
const MAX_TRACKERS = 60;
const MAX_BATCHES = 2;
const CACHE_LIMIT = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const agency = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(value) ? value : "";
export const storedKeywordKey = (value) => typeof value === "string" ? value.normalize("NFC").trim() : "";

// Internal headers are stripped/replaced by session-gate before this handler.
// No user query/body may widen this scope; public/trial requests read no rows.
export function storedCategoryScope(request, env = process.env) {
  if (!request?.headers || request.headers.get("x-mi-session-scope") === "trial") return null;
  const role = request.headers.get("x-mi-session-role");
  let code = request.headers.get("x-mi-agency-code") || "";
  if (role === "owner") {
    if (!primaryAgencyConfiguration(env).valid || request.headers.get("x-mi-owner-agency-code") !== PRIMARY_AGENCY_CODE) return null;
    if (!code || code === "owner-session" || code === "session") code = PRIMARY_AGENCY_CODE;
  } else if (role === "team") {
    if (!code && request.headers.get("x-mi-session-scope") === "account-only") code = request.headers.get("x-mi-team-code") || "";
  } else if (role !== "client") return null;
  return agency(code) ? { agencyCode: code } : null;
}

function unknown(reason, now) {
  return { status: "needs_confirmation", reason, middle: "", small: "", paths: [], sampleSize: 0, categorizedCount: 0, source: STORED_CATEGORY_SOURCE, basis: "stored_top5", checkedAt: null };
}
function sourceConfig(env) {
  try {
    const url = new URL(String(env.SUPABASE_URL || "").trim());
    const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/u.test(url.hostname) || url.username || url.password || url.search || url.hash || !key || /[\r\n]/u.test(key)) return null;
    return { url: url.origin, key, identity: crypto.createHash("sha256").update(url.origin + "\n" + key).digest("hex") };
  } catch { return null; }
}
const inValues = (values) => `in.(${values.map((value) => '"' + String(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"') + '"').join(",")})`;
const time = (value) => typeof value === "string" ? Date.parse(value) : NaN;
const eventNumber = (value) => /^\d+$/u.test(String(value)) ? BigInt(value) : -1n;
function name(value) {
  return typeof value === "string" && value.length <= 100 && !/[<>\u0000-\u001f\u007f]/u.test(value) ? value.normalize("NFC").trim() : "";
}
function signature(items) {
  return JSON.stringify(items.map((p) => [p?.productId, p?.category2, p?.category3, p?.isOrganic, p?.isAd]));
}

function categoryFor(keyword, scope, trackers, terminals, events, now) {
  const candidates = trackers.filter((t) => storedKeywordKey(t.keyword) === keyword);
  if (!candidates.length) return unknown("no_stored_evidence", now);
  // Never skip a newer missing/invalid snapshot to cherry-pick an old success.
  if (candidates.some((t) => !Array.isArray(t.snapshots) || t.snapshots.length !== 1)) return unknown("no_stored_evidence", now);
  const snapshots = candidates.map((tracker) => ({ tracker, snapshot: tracker.snapshots[0] }));
  if (snapshots.some(({ snapshot }) => !Number.isFinite(time(snapshot.checked_at)) || !Number.isFinite(time(snapshot.collected_at)))) return unknown("evidence_unproven", now);
  snapshots.sort((a, b) => time(b.snapshot.checked_at) - time(a.snapshot.checked_at));
  const selected = snapshots[0];
  const s = selected.snapshot;
  const checked = time(s.checked_at);
  const captured = time(s.collected_at);
  if (!Number.isFinite(checked) || !Number.isFinite(captured) || captured > checked || checked > now + 60_000 || now - captured > DAY || captured > now + 60_000) return unknown("stale_source", now);
  const mirrors = snapshots.filter((entry) => entry.snapshot.collection_id === s.collection_id);
  for (const { tracker: t, snapshot: row } of mirrors) {
    if (!UUID.test(t.id) || row.tracker_id !== t.id || !UUID.test(row.id)
      || row.source !== "naver_shopping_results_collector" || row.checked_count !== 300
      || typeof row.collection_id !== "string" || !/^pw-chrome-[a-zA-Z0-9-]{1,140}$/u.test(row.collection_id)
      || row.evidence_collection_id !== row.collection_id || time(row.collected_at) !== captured
      || !Array.isArray(row.top_items) || row.top_items.length !== 5
      || signature(row.top_items) !== signature(s.top_items)) return unknown("evidence_unproven", now);
    const commits = terminals.filter((e) => e.tracker_id === t.id && e.collection_id === row.collection_id);
    if (commits.length !== 1) return unknown("evidence_unproven", now);
    const commit = commits[0];
    const claims = events.filter((e) => e.event_type === "tracker_claimed" && e.claim_id === commit.claim_id && e.tracker_id === t.id);
    const groups = events.filter((e) => e.event_type === "group_claimed" && e.claim_id === commit.claim_id);
    if (claims.length !== 1 || groups.length !== 1) return unknown("evidence_unproven", now);
    const claim = claims[0];
    const group = groups[0];
    const scopeId = claim.cycle_id || claim.run_id || claim.claim_id;
    const expected = UUID.test(scopeId || "") ? crypto.createHash("sha256").update(`${scopeId}:${keyword.trim().toLowerCase().replace(/\s+/gu, "")}`).digest("hex") : "";
    if (!UUID.test(commit.claim_id || "") || commit.event_type !== "tracker_committed" || !expected
      || [commit, claim].some((e) => e.agency_code !== scope.agencyCode)
      || (group.agency_code !== null && group.agency_code !== scope.agencyCode)
      || [commit, claim, group].some((e) => e.group_fingerprint !== expected || e.claim_id !== claim.claim_id
        || e.run_id !== claim.run_id || e.cycle_id !== claim.cycle_id)
      || commit.checked_count !== 300 || eventNumber(group.event_id) < 0n
      || !(eventNumber(group.event_id) < eventNumber(claim.event_id) && eventNumber(claim.event_id) < eventNumber(commit.event_id))
      || !(time(group.occurred_at) <= time(claim.occurred_at) && time(claim.occurred_at) <= time(row.checked_at) && time(row.checked_at) <= time(commit.occurred_at))
      || time(commit.occurred_at) > now + 60_000) return unknown("evidence_unproven", now);
  }
  const paths = new Map();
  const ids = new Set();
  let categorizedCount = 0;
  for (const item of s.top_items) {
    if (typeof item?.productId !== "string" || !/^\d{5,24}$/u.test(item.productId) || ids.has(item.productId) || item.isOrganic !== true || item.isAd !== false) return unknown("evidence_unproven", now);
    ids.add(item.productId);
    const middle = name(item.category2);
    const small = name(item.category3);
    if (!middle || !small) continue;
    categorizedCount += 1;
    const key = JSON.stringify([middle, small]);
    const path = paths.get(key) || { middle, small, sampleCount: 0 };
    path.sampleCount += 1;
    paths.set(key, path);
  }
  const observed = [...paths.values()].sort((a, b) => b.sampleCount - a.sampleCount || a.middle.localeCompare(b.middle, "ko") || a.small.localeCompare(b.small, "ko"));
  const complete = categorizedCount === s.top_items.length;
  const status = observed.length > 1 ? "multiple" : observed.length === 1 && complete ? "single" : "needs_confirmation";
  return { status, reason: !complete ? "incomplete_sample" : observed.length > 1 ? "multiple_categories" : "stored_sample_consistent",
    middle: status === "single" ? observed[0].middle : "", small: status === "single" ? observed[0].small : "", paths: observed,
    sampleSize: s.top_items.length, categorizedCount, source: STORED_CATEGORY_SOURCE, basis: "stored_top5", checkedAt: new Date(captured).toISOString() };
}

// This adapter has no collector/RPC/write capability: only three bounded GETs.
export function createStoredRankCategoryLookup({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  return async function lookupStoredCategories(keywords, { request, deadline = now() + 4_000 } = {}) {
    const values = [...new Set((Array.isArray(keywords) ? keywords : []).map(storedKeywordKey).filter((v) => v && v.length <= 60 && !/[\u0000-\u001f\u007f]/u.test(v)))].slice(0, 30);
    const fallback = (reason) => values.map((keyword) => ({ keyword, category: unknown(reason, now()) }));
    const scope = storedCategoryScope(request, env);
    if (!scope) return fallback("scope_unavailable");
    const config = sourceConfig(env);
    if (!config) return fallback("source_unavailable");
    if (!values.length) return [];
    if (deadline <= now()) return fallback("source_timeout");
    const key = JSON.stringify([config.identity, scope.agencyCode, values]);
    for (const [id, entry] of cache) if (entry.expiresAt <= now()) cache.delete(id);
    if (cache.get(key)?.expiresAt > now()) return structuredClone(cache.get(key).value);
    if (pending.has(key)) {
      let waitTimer;
      try {
        // Sharing a read must not inherit another caller's longer deadline.
        return structuredClone(await Promise.race([
          pending.get(key).then((value) => now() >= deadline ? fallback("source_timeout") : value),
          new Promise((resolve) => { waitTimer = setTimeout(() => resolve(fallback("source_timeout")), Math.max(1, Math.min(4_000, deadline - now()))); }),
        ]));
      } finally { clearTimeout(waitTimer); }
    }
    if (pending.size >= MAX_BATCHES) return fallback("source_busy");
    const controller = new AbortController();
    const stopAt = Math.min(deadline, now() + 4_000);
    let timer;
    async function read(table, params, cap) {
      if (controller.signal.aborted || now() >= stopAt) throw new Error("source_timeout");
      const url = new URL(`/rest/v1/${table}`, config.url);
      for (const [field, value] of Object.entries(params)) url.searchParams.set(field, value);
      const headers = { apikey: config.key, accept: "application/json" };
      if (!config.key.startsWith("sb_secret_")) headers.authorization = `Bearer ${config.key}`;
      const response = await fetchImpl(url.href, { method: "GET", headers, redirect: "error", signal: controller.signal });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("source_unavailable"); }
      const rows = await readBoundedJson(response, 1024 * 1024);
      if (controller.signal.aborted || now() >= stopAt) throw new Error("source_timeout");
      if (!Array.isArray(rows) || rows.length > cap || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) throw new Error("evidence_unproven");
      return rows;
    }
    const work = (async () => {
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("source_timeout")); }, Math.max(1, stopAt - now())); });
        const reads = (async () => {
          const trackers = await read("naver_rank_trackers", {
            select: "id,keyword,agency_code,snapshots:naver_rank_snapshots(id,tracker_id,checked_at,collected_at:item->>collectedAt,evidence_collection_id:item->>collectionId,checked_count,collection_id,source,top_items)",
            agency_code: `eq.${scope.agencyCode}`, keyword: inValues(values), limit: String(MAX_TRACKERS + 1),
            "snapshots.order": "checked_at.desc,id.desc", "snapshots.limit": "1",
          }, MAX_TRACKERS);
          if (new Set(trackers.map((t) => t.id)).size !== trackers.length || trackers.some((t) => !UUID.test(t.id || "")
            || t.agency_code !== scope.agencyCode || !values.includes(storedKeywordKey(t.keyword))
            || !Array.isArray(t.snapshots) || t.snapshots.length > 1
            || t.snapshots.some((s) => !s || s.tracker_id !== t.id))) throw new Error("evidence_unproven");
          const collectionIds = [...new Set(trackers.flatMap((t) => (Array.isArray(t.snapshots) ? t.snapshots : []).map((s) => s.collection_id)).filter((v) => typeof v === "string" && /^pw-chrome-[a-zA-Z0-9-]{1,140}$/u.test(v)))];
          let terminals = [];
          let events = [];
          if (collectionIds.length) {
            const columns = "event_id,event_type,occurred_at,tracker_id,agency_code,claim_id,cycle_id,run_id,group_fingerprint,collection_id,checked_count";
            terminals = await read("naver_shopping_scheduler_events", { select: columns, tracker_id: inValues(trackers.map((t) => t.id)), collection_id: inValues(collectionIds), agency_code: `eq.${scope.agencyCode}`, event_type: "eq.tracker_committed", limit: String(MAX_TRACKERS + 1) }, MAX_TRACKERS);
            if (terminals.some((e) => e.agency_code !== scope.agencyCode || !trackers.some((t) => t.id === e.tracker_id)
              || !collectionIds.includes(e.collection_id) || !UUID.test(e.claim_id || ""))) throw new Error("evidence_unproven");
            const claims = [...new Set(terminals.map((e) => e.claim_id).filter((id) => UUID.test(id || "")))];
            if (claims.length) events = await read("naver_shopping_scheduler_events", { select: columns, claim_id: inValues(claims), or: `(agency_code.eq.${scope.agencyCode},and(event_type.eq.group_claimed,agency_code.is.null))`, event_type: "in.(tracker_claimed,group_claimed)", limit: String(MAX_TRACKERS * 2 + 1) }, MAX_TRACKERS * 2);
          }
          return values.map((keyword) => ({ keyword, category: categoryFor(keyword, scope, trackers, terminals, events, now()) }));
        })();
        return await Promise.race([reads, timeout]);
      } catch (error) {
        return fallback(["source_timeout", "evidence_unproven"].includes(error?.message) ? error.message : "source_unavailable");
      } finally { clearTimeout(timer); }
    })();
    pending.set(key, work);
    try {
      const value = await work;
      const successful = value.filter((r) => r.category.status !== "needs_confirmation");
      const expiry = Math.min(now() + (successful.length === value.length ? 300_000 : 30_000), ...successful.map((r) => time(r.category.checkedAt) + DAY));
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(key, { value: structuredClone(value), expiresAt: expiry });
      return value;
    } finally { pending.delete(key); }
  };
}
