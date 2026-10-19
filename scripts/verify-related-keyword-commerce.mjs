// Explicit, bounded live source verification. No env files are read and no
// database, rank worker, tracker, or production deployment is invoked.
import { pathToFileURL } from "node:url";
import { createCommerceCategorySource, commerceCategoryConfigReason } from "../src/server/naver-commerce-category-source.mjs";
import { categoriesFromSample } from "../src/server/related-keyword-categories.mjs";

export async function verifyCommerceCategory({ args = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const index = args.indexOf("--keyword");
  const keyword = index >= 0 ? args[index + 1] : "";
  if (!args.includes("--live") || typeof keyword !== "string" || !keyword.trim() || keyword.length > 60 || /[\u0000-\u001f\u007f]/u.test(keyword)) {
    return { exitCode: 2, report: { ok: false, reason: "explicit_live_keyword_required", networkRequests: 0 } };
  }
  const reason = commerceCategoryConfigReason(env);
  if (reason) return { exitCode: 2, report: { ok: false, reason, networkRequests: 0 } };
  let networkRequests = 0;
  const source = createCommerceCategorySource({ env, now, fetchImpl: (...values) => { networkRequests += 1; return fetchImpl(...values); } });
  try {
    const sample = await source(keyword, { deadline: now() + 8_000 });
    const result = categoriesFromSample(sample, keyword, now());
    return { exitCode: result.status === "needs_confirmation" ? 1 : 0, report: {
      ok: result.status !== "needs_confirmation", liveSourceCall: true, source: result.source,
      status: result.status, reason: result.reason, paths: result.paths,
      sampleSize: result.sampleSize, categorizedCount: result.categorizedCount,
      hasMore: result.hasMore ?? null, checkedAt: result.checkedAt, networkRequests,
      rankRequests: 0, databaseWrites: 0, retries: 0,
    } };
  } catch (error) {
    const safe = new Set(["source_unavailable", "source_config_invalid", "source_permission", "source_timeout", "source_aborted", "source_cooldown", "rate_limited", "deadline_exceeded", "response_too_large", "invalid_response", "invalid_sample", "invalid_keyword"]);
    return { exitCode: 1, report: { ok: false, reason: safe.has(error?.message) ? error.message : "source_unavailable", networkRequests, retries: 0 } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, report } = await verifyCommerceCategory();
  console.log(JSON.stringify(report));
  process.exitCode = exitCode;
}
