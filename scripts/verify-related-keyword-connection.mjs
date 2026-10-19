// Operator-only, in-process diagnostic for stored category evidence. No files,
// app router, Naver/SearchAd/Commerce API, collector, RPC or write capability.
import { pathToFileURL } from "node:url";
import { PRIMARY_AGENCY_CODE } from "../src/server/owner-identity.mjs";
import { createStoredRankCategoryLookup, storedCategoryScope, storedKeywordKey, STORED_CATEGORY_SOURCE } from "../src/server/stored-rank-keyword-categories.mjs";

const DEADLINE_MS = 4_000;
const SAFE_REASONS = new Set(["source_unavailable", "source_timeout", "source_busy", "evidence_unproven", "stale_source", "scope_unavailable", "no_stored_evidence", "incomplete_sample", "multiple_categories", "stored_sample_consistent"]);
const present = (env, name) => typeof env?.[name] === "string" && env[name].trim().length > 0;
const safeReason = (value) => SAFE_REASONS.has(value) ? value : "source_unavailable";

export function inspectConfig(env = process.env) {
  let urlValid = false;
  try {
    const url = new URL(String(env.SUPABASE_URL || "").trim());
    urlValid = url.protocol === "https:" && /^[a-z0-9-]+\.supabase\.co$/u.test(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { /* Never copy a malformed private value into diagnostics. */ }
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return {
    categorySource: STORED_CATEGORY_SOURCE, externalSourcesEnabled: false,
    storedDatabase: { urlPresent: present(env, "SUPABASE_URL"), urlValid, secretKeyPresent: Boolean(key), configured: urlValid && Boolean(key) && !/[\r\n]/u.test(key) },
    searchAd: { configured: ["NAVER_SEARCHAD_API_KEY", "NAVER_SEARCHAD_SECRET_KEY", "NAVER_SEARCHAD_CUSTOMER_ID"].every((name) => present(env, name)) },
    apiHub: { clientIdPresent: present(env, "NAVER_API_HUB_CLIENT_ID") || present(env, "NAVER_API_HUB_API_KEY_ID"), clientSecretPresent: present(env, "NAVER_API_HUB_CLIENT_SECRET") || present(env, "NAVER_API_HUB_API_KEY") },
  };
}

function routeFor(value, options, expectedOrigin) {
  let url;
  try { url = new URL(typeof value === "string" ? value : value?.url || value?.href); } catch { return ""; }
  if (url.origin !== expectedOrigin || url.username || url.password || url.hash || options?.redirect !== "error" || options?.method !== "GET") return "";
  if (url.pathname === "/rest/v1/naver_rank_trackers") return "trackers";
  if (url.pathname !== "/rest/v1/naver_shopping_scheduler_events") return "";
  if (url.searchParams.get("event_type") === "eq.tracker_committed") return "terminals";
  if (url.searchParams.get("event_type") === "in.(tracker_claimed,group_claimed)") return "claims";
  return "";
}

export async function verifyRelatedKeywordConnection({ args = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, now = Date.now, request } = {}) {
  let config;
  try { config = inspectConfig(env); } catch { return { exitCode: 2, report: { ok: false, liveVerified: false, reason: "source_unavailable", networkRequests: 0 } }; }
  const counts = { trackers: 0, terminals: 0, claims: 0 };
  let networkRequests = 0;
  let forbiddenRequests = 0;
  const baseReport = () => ({
    ok: false, mode: args.includes("--live") ? "live_stored_only" : "config_only", liveVerified: false,
    wordListVerified: false, categoriesVerified: false, count: 0,
    categories: { single: 0, multiple: 0, needs_confirmation: 0 }, reasons: {},
    configuration: config, networkRequests, networkCounts: { ...counts }, forbiddenRequests,
    externalRequests: 0, rankRequests: 0, databaseWrites: 0, retries: 0,
  });
  if (args.length === 0) return { exitCode: 0, report: { ...baseReport(), reason: "live_verification_not_run" } };
  const index = args.indexOf("--keyword");
  const keyword = index >= 0 ? args[index + 1] : "";
  if (args.length !== 3 || args.filter((arg) => arg === "--live").length !== 1 || args.filter((arg) => arg === "--keyword").length !== 1
    || ["--live", "--keyword"].includes(keyword) || typeof keyword !== "string" || !keyword.trim() || keyword.length > 60 || /[\u0000-\u001f\u007f]/u.test(keyword)) {
    return { exitCode: 2, report: { ...baseReport(), reason: "explicit_live_keyword_required" } };
  }
  // Synthetic owner headers stay inside this operator script. They never go
  // to an application HTTP endpoint or bypass its real session gate.
  const scopedRequest = request || new Request("https://connection-probe.invalid/stored", { headers: { "x-mi-session-role": "owner", "x-mi-owner-agency-code": PRIMARY_AGENCY_CODE } });
  if (!storedCategoryScope(scopedRequest, env)) return { exitCode: 2, report: { ...baseReport(), reason: "scope_unavailable" } };
  if (!config.storedDatabase.configured) return { exitCode: 2, report: { ...baseReport(), reason: "source_unavailable" } };
  let startedAt;
  try { startedAt = now(); } catch { /* Refuse invalid clocks before reading. */ }
  if (!Number.isFinite(startedAt)) return { exitCode: 2, report: { ...baseReport(), reason: "source_unavailable" } };
  const deadline = startedAt + DEADLINE_MS;
  const origin = new URL(env.SUPABASE_URL).origin;
  const controller = new AbortController();
  let active = true;
  let timer;
  const guardedFetch = async (url, options) => {
    if (!active || now() >= deadline || controller.signal.aborted) throw new Error("source_timeout");
    const route = routeFor(url, options, origin);
    if (!route) { forbiddenRequests += 1; throw new Error("source_unavailable"); }
    if (networkRequests >= 3 || counts[route] >= 1) throw new Error("source_unavailable");
    if (options.signal?.aborted) throw new Error("source_timeout");
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    networkRequests += 1;
    counts[route] += 1;
    const response = await fetchImpl(url, { ...options, signal, redirect: "error" });
    if (!active || now() >= deadline || signal.aborted) {
      await response?.body?.cancel().catch(() => {});
      throw new Error("source_timeout");
    }
    return response;
  };
  try {
    const lookup = createStoredRankCategoryLookup({ env, fetchImpl: guardedFetch, now });
    const rows = await Promise.race([
      lookup([keyword], { request: scopedRequest, deadline }),
      new Promise((_, reject) => { timer = setTimeout(() => { active = false; controller.abort(); reject(new Error("source_timeout")); }, DEADLINE_MS); }),
    ]);
    if (!active || now() >= deadline) throw new Error("source_timeout");
    const categories = { single: 0, multiple: 0, needs_confirmation: 0 };
    const reasons = {};
    for (const row of rows) {
      const status = ["single", "multiple"].includes(row?.category?.status) ? row.category.status : "needs_confirmation";
      categories[status] += 1;
      const reason = safeReason(row?.category?.reason);
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    const categoriesVerified = rows.length === 1 && rows[0].keyword === storedKeywordKey(keyword)
      && rows[0].category.source === STORED_CATEGORY_SOURCE && rows[0].category.sampleSize === 5 && rows[0].category.categorizedCount === 5
      && categories.needs_confirmation === 0 && forbiddenRequests === 0 && ["stored_sample_consistent", "multiple_categories"].includes(rows[0].category.reason);
    return { exitCode: categoriesVerified ? 0 : 1, report: {
      ...baseReport(), ok: categoriesVerified, liveVerified: categoriesVerified, categoriesVerified,
      count: rows.length, categories, reasons, reason: categoriesVerified ? "verified_stored_sample" : "category_confirmation_required",
    } };
  } catch (error) {
    return { exitCode: 1, report: { ...baseReport(), reason: safeReason(error?.message) } };
  } finally { active = false; clearTimeout(timer); controller.abort(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, report } = await verifyRelatedKeywordConnection();
  console.log(JSON.stringify(report));
  process.exitCode = exitCode;
}
