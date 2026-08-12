import fs from "node:fs";
import vm from "node:vm";
import { shoppingCollectorFailureStatus } from "../src/server/naver-shopping/source-status.mjs";
import { shoppingProviderRuntimeConfig } from "../src/server/naver-shopping/provider-runtime.mjs";

const files = {
  productWorkflow: ".github/workflows/naver-rank-cron.yml",
  placeWorkflow: ".github/workflows/naver-place-rank-cron.yml",
  legacyDeploy: "06_Supabase_연동/deploy-backend.mjs",
  packageJson: "package.json",
  serverIndex: "src/server/index.mjs",
  sessionGate: "src/server/session-gate.mjs",
  ownerIdentity: "src/server/owner-identity.mjs",
  ownerTool: "src/server/handlers/owner-tool-api.mjs",
  ownerToolAdapter: "api/owner/tool.mjs",
  sessionAdapter: "api/session.mjs",
  responseAdapter: "api/response-adapter.mjs",
  runtime: "src/server/runtime.mjs",
  errorSafety: "src/server/error-safety.mjs",
  readiness: "src/server/handlers/ready.mjs",
  productCron: "src/server/handlers/naver-rank-cron.mjs",
  placeCron: "src/server/handlers/naver-place-rank-cron.mjs",
  productSeoAudit: "src/server/handlers/naver-product-seo-audit.mjs",
  productTrackers: "src/server/handlers/naver-rank-trackers.mjs",
  clientApi: "src/server/handlers/client-api.mjs",
  workItems: "src/server/handlers/work-items.mjs",
  workItemsMigration: "supabase/migrations/20260730074106_extend_schedule_items_for_work_operations.sql",
  shoppingRank: "src/server/handlers/naver-shopping-rank.mjs",
  shoppingSourceStatus: "src/server/naver-shopping/source-status.mjs",
  shoppingProviderRuntime: "src/server/naver-shopping/provider-runtime.mjs",
  shoppingCollectorContract: "tools/naver-shopping-rank-collector/src/contract.mjs",
  shoppingCollectorPackage: "tools/naver-shopping-rank-collector/package.json",
  shoppingCollectorPackageLock: "tools/naver-shopping-rank-collector/package-lock.json",
  shoppingLiveGate: "scripts/check-naver-shopping-collector-live.mjs",
  shoppingLocalWorker: "scripts/naver-shopping-local-worker.mjs",
  shoppingLocalWorkerWrapper: "scripts/run-naver-shopping-local-worker.sh",
  shoppingLocalWorkerPlist: "scripts/co.kr.momentinsight.naver-shopping-local-worker.plist.template",
  shoppingLocalWorkerAuth: "src/server/local-worker-auth.mjs",
  shoppingLocalWorkerHandler: "src/server/handlers/naver-shopping-local-worker.mjs",
  shoppingLocalWorkerContract: "src/server/naver-shopping/local-worker-contract.mjs",
  shoppingLocalWorkerMigration: "supabase/migrations/20260801125959_naver_shopping_local_worker.sql",
  shoppingWorkerWake: "src/server/naver-shopping/worker-wake.mjs",
  shoppingWorkerWakeMigration: "supabase/migrations/20260809113105_naver_shopping_worker_remote_wake.sql",
  shoppingWorkerLaneMigration: "supabase/migrations/20260809203826_naver_shopping_global_worker_lane.sql",
  shoppingWorkerControlMigration: "supabase/migrations/20260811095137_naver_shopping_worker_control_plane.sql",
  shoppingWorkerContinuityMigration: "supabase/migrations/20260811113622_naver_shopping_queue_continuity.sql",
  shoppingWorkerDurableCycleMigration: "supabase/migrations/20260812060826_naver_shopping_durable_cycle_probe.sql",
  shoppingRankLookupLeasePrecisionMigration: "supabase/migrations/20260811142000_fix_naver_shopping_lookup_lease_precision.sql",
  shoppingRankLookupJobs: "src/server/handlers/naver-shopping-rank-jobs.mjs",
  shoppingNativeHost: "scripts/naver-shopping-native-host.mjs",
  shoppingNativeHostCore: "scripts/naver-shopping-native-host-core.mjs",
  shoppingNativeHostInstaller: "scripts/install-naver-shopping-chrome-bridge.mjs",
  shoppingWindowsHostInstaller: "scripts/install-naver-shopping-chrome-bridge-windows.ps1",
  shoppingWindowsHostLauncher: "scripts/windows/MomentInsightNaverShoppingHost.cs",
  shoppingWindowsChromeScheduler: "scripts/windows/run-naver-shopping-chrome-scheduler.ps1",
  shoppingChromeSchedulerWrapper: "scripts/run-naver-shopping-chrome-scheduler.sh",
  shoppingNativeHostWrapper: "scripts/run-naver-shopping-native-host.sh",
  shoppingChromeManifest: "tools/naver-shopping-chrome-extension/manifest.json",
  shoppingChromeWorker: "tools/naver-shopping-chrome-extension/service-worker.js",
  shoppingChromePopup: "tools/naver-shopping-chrome-extension/popup.js",
  shoppingChromePopupHtml: "tools/naver-shopping-chrome-extension/popup.html",
  naverEnvExample: "05_네이버_API_연동/.env.example",
  adminPage: "src/pages/admin.html",
  clientPage: "src/pages/client.html",
  vercel: "vercel.json",
};

const productWorkflow = fs.readFileSync(files.productWorkflow, "utf8");
const placeWorkflow = fs.readFileSync(files.placeWorkflow, "utf8");
const legacyDeploy = fs.readFileSync(files.legacyDeploy, "utf8");
const packageJson = JSON.parse(fs.readFileSync(files.packageJson, "utf8"));
const serverIndex = fs.readFileSync(files.serverIndex, "utf8");
const sessionGate = fs.readFileSync(files.sessionGate, "utf8");
const sessionFreePathsBlock = sessionGate.match(/const SESSION_FREE_PATHS = new Set\(\[[\s\S]*?\]\);/)?.[0] || "";
const teamAccountOnlyPathsBlock = sessionGate.match(/const TEAM_ACCOUNT_ONLY_TOOL_PATHS = new Set\(\[[\s\S]*?\]\);/)?.[0] || "";
const ownerIdentity = fs.readFileSync(files.ownerIdentity, "utf8");
const ownerTool = fs.readFileSync(files.ownerTool, "utf8");
const ownerToolAdapter = fs.readFileSync(files.ownerToolAdapter, "utf8");
const sessionAdapter = fs.readFileSync(files.sessionAdapter, "utf8");
const responseAdapter = fs.readFileSync(files.responseAdapter, "utf8");
const runtime = fs.readFileSync(files.runtime, "utf8");
const errorSafety = fs.readFileSync(files.errorSafety, "utf8");
const readiness = fs.readFileSync(files.readiness, "utf8");
const productCron = fs.readFileSync(files.productCron, "utf8");
const placeCron = fs.readFileSync(files.placeCron, "utf8");
const productSeoAudit = fs.readFileSync(files.productSeoAudit, "utf8");
const productTrackers = fs.readFileSync(files.productTrackers, "utf8");
const clientApi = fs.readFileSync(files.clientApi, "utf8");
const workItems = fs.readFileSync(files.workItems, "utf8");
const workItemsMigration = fs.readFileSync(files.workItemsMigration, "utf8");
const shoppingRank = fs.readFileSync(files.shoppingRank, "utf8");
const shoppingSourceStatus = fs.readFileSync(files.shoppingSourceStatus, "utf8");
const shoppingProviderRuntime = fs.readFileSync(files.shoppingProviderRuntime, "utf8");
const shoppingCollectorContract = fs.readFileSync(files.shoppingCollectorContract, "utf8");
const shoppingCollectorPackage = JSON.parse(fs.readFileSync(files.shoppingCollectorPackage, "utf8"));
const shoppingCollectorPackageLock = JSON.parse(fs.readFileSync(files.shoppingCollectorPackageLock, "utf8"));
const shoppingLiveGate = fs.readFileSync(files.shoppingLiveGate, "utf8");
const shoppingLocalWorker = fs.readFileSync(files.shoppingLocalWorker, "utf8");
const shoppingLocalWorkerWrapper = fs.readFileSync(files.shoppingLocalWorkerWrapper, "utf8");
const shoppingLocalWorkerPlist = fs.readFileSync(files.shoppingLocalWorkerPlist, "utf8");
const shoppingLocalWorkerAuth = fs.readFileSync(files.shoppingLocalWorkerAuth, "utf8");
const shoppingLocalWorkerHandler = fs.readFileSync(files.shoppingLocalWorkerHandler, "utf8");
const shoppingLocalWorkerContract = fs.readFileSync(files.shoppingLocalWorkerContract, "utf8");
const shoppingLocalWorkerMigration = fs.readFileSync(files.shoppingLocalWorkerMigration, "utf8");
const shoppingWorkerWake = fs.readFileSync(files.shoppingWorkerWake, "utf8");
const shoppingWorkerWakeMigration = fs.readFileSync(files.shoppingWorkerWakeMigration, "utf8");
const shoppingWorkerLaneMigration = fs.readFileSync(files.shoppingWorkerLaneMigration, "utf8");
const shoppingWorkerControlMigration = fs.readFileSync(files.shoppingWorkerControlMigration, "utf8");
const shoppingWorkerContinuityMigration = fs.readFileSync(files.shoppingWorkerContinuityMigration, "utf8");
const shoppingWorkerDurableCycleMigration = fs.readFileSync(files.shoppingWorkerDurableCycleMigration, "utf8");
const shoppingRankLookupLeasePrecisionMigration = fs.readFileSync(files.shoppingRankLookupLeasePrecisionMigration, "utf8");
const shoppingRankLookupJobs = fs.readFileSync(files.shoppingRankLookupJobs, "utf8");
const shoppingNativeHost = fs.readFileSync(files.shoppingNativeHost, "utf8");
const shoppingNativeHostCore = fs.readFileSync(files.shoppingNativeHostCore, "utf8");
const shoppingNativeHostInstaller = fs.readFileSync(files.shoppingNativeHostInstaller, "utf8");
const shoppingWindowsHostInstaller = fs.readFileSync(files.shoppingWindowsHostInstaller, "utf8");
const shoppingWindowsHostLauncher = fs.readFileSync(files.shoppingWindowsHostLauncher, "utf8");
const shoppingWindowsChromeScheduler = fs.readFileSync(files.shoppingWindowsChromeScheduler, "utf8");
const shoppingChromeSchedulerWrapper = fs.readFileSync(files.shoppingChromeSchedulerWrapper, "utf8");
const shoppingNativeHostWrapper = fs.readFileSync(files.shoppingNativeHostWrapper, "utf8");
const shoppingChromeManifest = JSON.parse(fs.readFileSync(files.shoppingChromeManifest, "utf8"));
const shoppingChromeWorker = fs.readFileSync(files.shoppingChromeWorker, "utf8");
const shoppingChromePopup = fs.readFileSync(files.shoppingChromePopup, "utf8");
const shoppingChromePopupHtml = fs.readFileSync(files.shoppingChromePopupHtml, "utf8");
const naverEnvExample = fs.readFileSync(files.naverEnvExample, "utf8");
const adminPage = fs.readFileSync(files.adminPage, "utf8");
const clientPage = fs.readFileSync(files.clientPage, "utf8");
const vercel = JSON.parse(fs.readFileSync(files.vercel, "utf8"));
const shopping418Failure = shoppingCollectorFailureStatus({
  status: 418,
  message: "provider_collection_failed:naver_http_418",
});
const shopping429Failure = shoppingCollectorFailureStatus({
  status: 429,
  message: "provider_collection_failed:naver_http_429",
});
const shoppingProviderDefaults = shoppingProviderRuntimeConfig({});
const shoppingPlaywrightVersion = String(shoppingCollectorPackage.dependencies?.playwright || "");
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
}

function hasAll(source, patterns) {
  return patterns.every((pattern) => pattern.test(source));
}

function inlineModuleCompiles(source) {
  const opening = "node --input-type=module <<'NODE'\n";
  const start = source.indexOf(opening);
  if (start < 0) return false;
  const bodyStart = start + opening.length;
  const end = source.indexOf("\n          NODE", bodyStart);
  if (end < 0) return false;

  const body = source.slice(bodyStart, end)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
  try {
    new vm.Script(`(async () => {\n${body}\n})()`);
    return true;
  } catch {
    return false;
  }
}

check(
  "product cron uses repeated small batches",
  hasAll(productWorkflow, [
    /node --input-type=module <<'NODE'/,
    /const batchSize = 1;/,
    /const maxBatches = 100;/,
    /for \(let batch = 1; batch <= maxBatches;/,
    /searchParams\.set\("limit", String\(batchSize\)\)/,
    /await sleep\(8000\)/,
    /preserved/,
  ]) && !/limit=100/.test(productWorkflow) && !/\n\s*push:/.test(productWorkflow),
  files.productWorkflow,
);
check(
  "product cron validates responses, drains bounded failures and reports degradation",
  hasAll(productWorkflow, [
    /AbortController/,
    /requestTimeoutMs/,
    /const itemFailureResponse = response\.status === 502/,
    /if \(!response\.ok && !itemFailureResponse\)/,
    /JSON\.parse\(body\)/,
    /payload\.ok !== true/,
    /totals\.failed > 0/,
    /drained the queue with/,
  ]) && !/requestBatchWithRetry|retryable/.test(productWorkflow),
  files.productWorkflow,
);
check(
  "product cron inline module compiles",
  inlineModuleCompiles(productWorkflow),
  files.productWorkflow,
);
check(
  "place cron validates timeout, HTTP, JSON, ok and failed",
  hasAll(placeWorkflow, [
    /node --input-type=module <<'NODE'/,
    /AbortController/,
    /requestTimeoutMs/,
    /if \(!response\.ok\)/,
    /JSON\.parse\(body\)/,
    /payload\.ok !== true/,
    /safe\.failed > 0/,
    /continuing the remaining queue/,
    /totals\.failed > 0/,
    /drained the queue with/,
  ]) && hasAll(placeCron, [
    /placeRankCronResult/,
    /drainMode/,
    /status: 200/,
    /degraded: failed > 0 \|\| partial > 0/,
  ]),
  `${files.placeWorkflow}, ${files.placeCron}`,
);
check(
  "place cron inline module compiles",
  inlineModuleCompiles(placeWorkflow),
  files.placeWorkflow,
);
check(
  "legacy Edge deploy is blocked before side effects",
  hasAll(legacyDeploy, [
    /LEGACY_EDGE_DEPLOY_DISABLED/,
    /process\.exit\(1\)/,
  ]) && !/(?:spawnSync|child_process|\bnpx\b|\bnpm\b)/.test(legacyDeploy),
  files.legacyDeploy,
);
check(
  "package deploy command points to the blocked legacy entrypoint",
  packageJson.scripts?.["deploy:backend"] === "node 06_Supabase_연동/deploy-backend.mjs",
  files.packageJson,
);
check(
  "direct Supabase Edge deploy alias is blocked",
  packageJson.scripts?.["supabase:functions:deploy"] === "node 06_Supabase_연동/deploy-backend.mjs",
  files.packageJson,
);
check(
  "server contract check is part of the quality gate",
  packageJson.scripts?.["check:server-contract"] === "node scripts/check-server-contract.mjs"
    && String(packageJson.scripts?.["check:quality"] || "").includes("npm run check:server-contract"),
  files.packageJson,
);
check(
  "protected rank feature lock is part of the quality gate",
  packageJson.scripts?.["check:rank-feature-lock"] === "node scripts/check-protected-rank-features.mjs"
    && String(packageJson.scripts?.["check:quality"] || "").includes("npm run check:rank-feature-lock"),
  files.packageJson,
);
check(
  "role-state regression is part of the quality gate",
  packageJson.scripts?.["check:role-state-regression"] === "node scripts/check-role-state-regression.mjs"
    && String(packageJson.scripts?.["check:quality"] || "").includes("npm run check:role-state-regression"),
  files.packageJson,
);
check(
  "work operations are session-scoped, account-only capable and client-safe",
  hasAll(serverIndex, [
    /workItems: \(\) => import\("\.\/handlers\/work-items\.mjs"\)/,
    /url\.pathname === "\/api\/work-items"/,
    /dispatch\("workItems", request\)/,
  ]) && teamAccountOnlyPathsBlock.includes('"/api/work-items"')
    && hasAll(workItems, [
      /x-mi-session-role/,
      /roleCanMutateWorkItems/,
      /applyAccessScope/,
      /operation_team_id/,
      /eq\("visibility", VISIBLE\)/,
      /clientWorkItemPayload/,
      /internalNote: row\.internal_note/,
      /work_item_created/,
      /work_item_updated/,
      /work_item_deleted/,
    ])
    && hasAll(workItemsMigration, [
      /alter column client_id drop not null/,
      /operation_team_id uuid references public\.operation_team_codes/,
      /alter column visibility set default 'internal'/,
      /idx_schedule_items_operation_team_start/,
      /idx_schedule_items_client_visibility_start/,
    ]),
  `${files.serverIndex}, ${files.sessionGate}, ${files.workItems}, ${files.workItemsMigration}`,
);
check(
  "all routed requests use the shared runtime boundary",
  hasAll(serverIndex, [
    /createHandlerResolver/,
    /executeRequest/,
    /path: "\/api\/ready"/,
  ]) && hasAll(runtime, [
    /api_request_failed/,
    /x-request-id/,
    /cache\.delete\(name\)/,
  ]),
  `${files.serverIndex}, ${files.runtime}`,
);
check(
  "product SEO audit requires a session, permits exact account-only access and fails closed to verified public evidence",
  hasAll(serverIndex, [
    /naverProductSeoAudit: \(\) => import\("\.\/handlers\/naver-product-seo-audit\.mjs"\)/,
    /url\.pathname === "\/api\/naver-product-seo-audit"/,
    /dispatch\("naverProductSeoAudit", request\)/,
  ]) && !sessionFreePathsBlock.includes('"/api/naver-product-seo-audit"')
    && teamAccountOnlyPathsBlock.includes('"/api/naver-product-seo-audit"')
    && /TEAM_ACCOUNT_ONLY_TOOL_PATHS\.has\(path\)/.test(sessionGate)
    && hasAll(productSeoAudit, [
      /ALLOWED_HOSTS/,
      /SEO_AUDIT_TIMEOUT_MS/,
      /SEO_AUDIT_MAX_BYTES/,
      /SEO_AUDIT_RATE_LIMIT/,
      /redirectCount >= 2/,
      /expectedProductId/,
      /const signals = \{\}/,
      /if \(reviewCount !== null\)/,
      /if \(discountConfigured\)/,
      /if \(reviewPoint\.configured\)/,
      /parseNaverProductDetailJson/,
      /signals\.sellerTags/,
      /signals\.productNotice/,
      /signals\.detailImages/,
      /product\.brandName/,
      /product\.manufacturerName/,
      /total: 6/,
      /verifiedCount/,
      /protectedJson/,
    ]),
  `${files.serverIndex}, ${files.productSeoAudit}`,
);
check(
  "owner tool is server-delivered behind exact owner session authorization",
  hasAll(serverIndex, [
    /ownerToolApi: \(\) => import\("\.\/handlers\/owner-tool-api\.mjs"\)/,
    /url\.pathname === "\/api\/owner\/tool"/,
  ]) && hasAll(sessionGate, [
    /!path\.startsWith\("\/api\/owner\/"\)/,
    /ownerClaimsMatchPrimary\(claims, env\)/,
  ]) && hasAll(ownerIdentity, [
    /PRIMARY_AGENCY_CODE = "mml93-a01"/,
    /claims\.agencyCode === PRIMARY_AGENCY_CODE/,
  ]) && hasAll(ownerTool, [
    /x-mi-session-role/,
    /x-mi-owner-agency-code/,
    /const supply = \(\(total \* 10n\) \+ 5n\) \/ 11n/,
    /const tax = total - supply/,
  ]),
  `${files.serverIndex}, ${files.sessionGate}, ${files.ownerIdentity}, ${files.ownerTool}`,
);
check(
  "owner tool has an explicit nested Vercel function adapter",
  hasAll(ownerToolAdapter, [
    /createHandler/,
    /createHandler\("\/api\/owner\/tool"\)/,
  ]),
  files.ownerToolAdapter,
);
check(
  "login session has a dedicated Vercel function adapter",
  hasAll(sessionAdapter, [
    /createHandler/,
    /createHandler\("\/api\/session"\)/,
  ]),
  files.sessionAdapter,
);
check(
  "Vercel response adapter preserves multiple session cookie headers",
  hasAll(responseAdapter, [
    /getSetCookie/,
    /normalized === "set-cookie"/,
    /res\.setHeader\("set-cookie", setCookies\)/,
  ]),
  files.responseAdapter,
);
check(
  "shared runtime strips handler database and secret details from server errors",
  hasAll(runtime, [
    /safeErrorPayload/,
    /await response\.arrayBuffer\(\)/,
    /safeError\.body/,
  ]) && hasAll(errorSafety, [
    /response\.status < 500/,
    /SERVER_CONFIGURATION_PENDING/,
    /SERVER_ERROR/,
    /SERVER_NOT_READY/,
  ]),
  `${files.runtime}, ${files.errorSafety}`,
);
check(
  "readiness performs a bounded Supabase dependency probe",
  hasAll(readiness, [
    /\/rest\/v1\/clients/,
    /\/rest\/v1\/naver_rank_trackers/,
    /\/rest\/v1\/naver_place_rank_trackers/,
    /\/auth\/v1\/settings/,
    /AbortController/,
    /validJwksUrl/,
    /return String\(parsed\.default \|\| ""\)\.trim\(\)/,
    /SERVER_NOT_READY/,
    /result\.ok \? 200 : 503/,
  ]),
  files.readiness,
);
check(
  "rank cron handlers fail closed when providers are unavailable",
  hasAll(productCron, [
    /MAX_CRON_BATCH = 5/,
    /limit: productRankCronBatchLimit\(url\)/,
    /drainMode/,
    /!summary\.configured/,
    /!summary\.drained && !drainMode/,
    /}, 503\)/,
  ]) && hasAll(placeCron, [
    /limit: DEFAULT_CRON_BATCH/,
    /drainMode/,
    /!summary\?\.configured/,
    /!drainMode && partial > 0/,
    /!summary\.drained && !drainMode/,
    /status: 503/,
    /status: 502/,
    /degraded: failed > 0 \|\| partial > 0/,
  ]),
  `${files.productCron}, ${files.placeCron}`,
);
check(
  "product due selection skips rows with active processing leases",
  /lte\("next_check_at", now\)[\s\S]{0,160}or\(`processing_until\.is\.null,processing_until\.lt\.\$\{now\}`\)/.test(productTrackers),
  files.productTrackers,
);
check(
  "cron workflows require typed drain truth and surface partial place checks",
  hasAll(productWorkflow, [
    /typeof value !== "number"/,
    /typeof value !== "boolean"/,
    /safe\.drained !== \(safe\.remaining === 0\)/,
    /safe\.checked === 0 && !safe\.drained/,
    /!safe\.configured/,
    /searchParams\.set\("mode", "drain"\)/,
  ]) && hasAll(placeWorkflow, [
    /safe\.drained !== \(safe\.remaining === 0\)/,
    /safe\.checked === 0 && !safe\.drained/,
    /totals\.partial > 0/,
    /searchParams\.set\("mode", "drain"\)/,
  ]),
  `${files.productWorkflow}, ${files.placeWorkflow}`,
);
check(
  "client self-connect is fail-closed",
  hasAll(clientApi, [
    /MI_CLIENT_SELF_CONNECT_ENABLED === "true"/,
    /CLIENT_SELF_CONNECT_DISABLED/,
    /if \(!clientSelfConnectEnabled\(\)\)/,
  ]),
  files.clientApi,
);
check(
  "Vercel exposes the readiness route",
  (vercel.rewrites || []).some((rewrite) => rewrite.source === "/ready" && rewrite.destination === "/api/ready"),
  files.vercel,
);
check(
  "Vercel functions run with Fluid Compute in the Seoul database region",
  Array.isArray(vercel.regions)
    && vercel.regions.length === 1
    && vercel.regions[0] === "icn1"
    && vercel.fluid === true,
  files.vercel,
);
check(
  "Vercel isolates session latency from long-running API work",
  vercel.functions?.["api/session.mjs"]?.maxDuration === 30
    && vercel.functions?.["api/[...path].mjs"]?.maxDuration === 300,
  `${files.vercel}, ${files.sessionAdapter}`,
);
check(
  "Vercel production build requires environment, quality and authentication gates",
  vercel.buildCommand === "npm run check:vercel-deploy"
    && packageJson.scripts?.["check:vercel-env"] === "node scripts/check-runtime-env.mjs --vercel-build"
    && packageJson.scripts?.["check:vercel-deploy"] === "npm run check:vercel-env && npm run check:release && node scripts/check-naver-shopping-collector-live.mjs --vercel-build"
    && packageJson.scripts?.["check:production-auth"] === "node scripts/check-production-auth.mjs"
    && String(packageJson.scripts?.["check:release"] || "").includes("npm run check:quality")
    && String(packageJson.scripts?.["check:release"] || "").includes("npm run check:production-auth"),
  `${files.vercel}, ${files.packageJson}`,
);
check(
  "N Shopping local worker is signed, replay-safe and atomic",
  sessionFreePathsBlock.includes('"/api/naver-shopping-local-worker"')
    && hasAll(shoppingLocalWorkerAuth, [
    /createHmac\("sha256"/,
    /timingSafeEqual/,
    /x-mi-worker-nonce/,
  ])
    && hasAll(shoppingLocalWorkerContract, [
      /LOCAL_WORKER_ORGANIC_LIMIT = 300/,
      /validateStrictLocalWorkerWindow/,
      /localWorkerCollectionKey/,
    ])
    && hasAll(shoppingLocalWorkerHandler, [
      /mi_consume_naver_shopping_worker_nonce/,
      /mi_commit_naver_shopping_worker_result/,
      /mi_fail_naver_shopping_worker_claim/,
    ])
    && hasAll(shoppingLocalWorkerMigration, [
      /idx_naver_rank_snapshots_tracker_collection/,
      /security definer/,
      /to service_role/,
    ]),
  `${files.sessionGate}, ${files.shoppingLocalWorkerAuth}, ${files.shoppingLocalWorkerContract}, ${files.shoppingLocalWorkerHandler}, ${files.shoppingLocalWorkerMigration}`,
);
check(
  "N Shopping verified direct Chrome bridge is least-privilege and preserves the signed atomic worker",
  JSON.stringify(shoppingChromeManifest.permissions) === JSON.stringify([
    "alarms", "nativeMessaging", "scripting", "storage", "tabs",
    ])
    && JSON.stringify(shoppingChromeManifest.host_permissions) === JSON.stringify([
      "https://search.shopping.naver.com/*",
    ])
    && hasAll(shoppingChromeWorker, [
      /function searchUrl\(keyword, pageIndex\)/,
      /new URL\("https:\/\/search\.shopping\.naver\.com\/search\/all"\)/,
      /searchParams\.set\("where", "all"\)/,
      /searchParams\.set\("frm", "NVSCTAB"\)/,
      /searchParams\.set\("pagingSize", "40"\)/,
      /searchParams\.set\("productSet", "total"\)/,
      /searchParams\.set\("sort", "rel"\)/,
      /searchParams\.set\("viewType", "list"\)/,
      /PAGE_REQUEST_INTERVAL_MS = 3_500/,
      /PAGE_REQUEST_JITTER_MS = 2_500/,
      /async function saveCollectionProgress\(pageIndex\)/,
      /async function clearCompletedCollectionVerificationState\(\)/,
      /await saveCollectionProgress\(pageIndex\)/,
      /await clearCompletedCollectionVerificationState\(\)/,
      /collectPages/,
      /pagingIndex/,
      /productSet/,
      /nextDataText/,
      /naver_verification_required/,
      /request\.limit !== 300/,
      /request\.rankPolicy !== "organic_only"/,
      /chrome\.tabs\.remove\(tabId\)/,
      /naver_network_restricted/,
    ])
    && !/www\.naver\.com|search\.naver\.com|네이버 가격비교 더보기|SEARCH_DWELL|readPriceCompareEntry|readNextPageTarget/u.test(shoppingChromeWorker)
    && !/\bcookies\b|localStorage|webRequest|browsingData|history/iu.test(shoppingChromeWorker)
    && hasAll(shoppingNativeHostCore, [
      /parseNaverNextDataPage/,
      /buildNativeWindowFromRows/,
      /appendNormalizedPage/,
      /state\.items\.length !== REQUIRED_LIMIT/,
      /validateProviderWindow/,
      /pw-chrome-/,
    ])
    && hasAll(shoppingNativeHost, [
      /runLocalShoppingWorker/,
      /MAX_MESSAGE_BYTES = 24 \* 1024 \* 1024/,
      /native_host_input_invalid_json/,
      /inputFailure/,
    ])
    && hasAll(shoppingNativeHostInstaller, [
      /allowed_origins/,
      /chrome-extension:\/\//,
      /oldAutomaticBrowserWorkerDisabled: true/,
    ])
    && hasAll(shoppingNativeHostWrapper, [
      /security find-generic-password/,
      /MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET/,
    ])
    && hasAll(shoppingNativeHostInstaller, [
      /StartCalendarInterval/,
      /<key>StartInterval<\/key>\s*<integer>600<\/integer>/,
      /resolveChromeProfileDirectory/,
      /activateChromeScheduler/,
    ])
    && /BASELINE_CADENCE_MINUTES = 10/.test(shoppingChromeWorker)
    && /CANDIDATE_CADENCE_MINUTES = 8/.test(shoppingChromeWorker)
    && /\["rank-catch-up", \{ delayInMinutes: cadenceMinutes, periodInMinutes: cadenceMinutes \}\]/.test(shoppingChromeWorker)
    && hasAll(shoppingChromeSchedulerWrapper, [
      /\/usr\/bin\/open -gj/,
      /--profile-directory=/,
      /chrome_ready/,
    ])
    && !/remote-debugging|no-sandbox|user-data-dir/iu.test(shoppingChromeSchedulerWrapper),
  `${files.shoppingChromeManifest}, ${files.shoppingChromeWorker}, ${files.shoppingNativeHostCore}, ${files.shoppingNativeHost}, ${files.shoppingNativeHostInstaller}, ${files.shoppingNativeHostWrapper}, ${files.shoppingChromeSchedulerWrapper}`,
);
check(
  "N Shopping worker control plane is fail-closed, fair and service-role only",
  hasAll(shoppingWorkerControlMigration, [
    /circuit_state in \('closed', 'open', 'half_open'\)/,
    /mi_report_naver_shopping_worker_progress/,
    /mi_record_naver_shopping_worker_success/,
    /mi_record_naver_shopping_worker_failure/,
    /mi_choose_naver_shopping_worker_turn/,
    /probe_active/,
    /scheduler_urgent_streak between 0 and 2/,
    /worker_quarantined_until/,
    /current_row\.runtime_version = '1\.1\.0'/,
    /current_row\.last_checked_count = 300/,
    /current_row\.last_source = 'naver_shopping_results_collector'/,
    /force row level security/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerControlMigration),
  files.shoppingWorkerControlMigration,
);
check(
  "N Shopping queue continuity prioritizes new trackers and pins runtime 1.1.1",
  hasAll(shoppingWorkerContinuityMigration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.1'/,
    /if coalesce\(p_has_new, false\) then\s*work_class := 'new'/,
    /scheduler_urgent_streak >= 2/,
    /p_oldest_due_at[\s\S]+interval '30 minutes'/,
    /scheduler_last_agency_code/,
    /current_row\.runtime_version = '1\.1\.1'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerContinuityMigration)
    && hasAll(shoppingWorkerDurableCycleMigration, [
      /mi_queue_naver_shopping_cycle/,
      /mi_claim_naver_shopping_cycle_keyword/,
      /scheduler_cycle_resume_cursor/,
      /order by tracker\.sort_order asc, tracker\.created_at asc, tracker\.id asc/,
      /limit 100/,
      /to service_role/,
    ])
    && /body\.schedulerVersion === "v2"/.test(shoppingLocalWorkerHandler)
    && /LOCAL_WORKER_SCHEDULER_VERSION_STALE/.test(shoppingLocalWorkerHandler),
  `${files.shoppingWorkerContinuityMigration}, ${files.shoppingWorkerDurableCycleMigration}, ${files.shoppingLocalWorkerHandler}`,
);
check(
  "N Shopping Windows bridge uses an exact profile, user-scoped DPAPI and interactive watchdog",
  hasAll(shoppingWindowsHostInstaller, [
    /Read-Host "Chrome profile visible name or number"/,
    /Google\\Chrome\\User Data\\Local State/,
    /Add-Type -AssemblyName System\.Security -ErrorAction Stop/,
    /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts/,
    /allowed_origins/,
    /DataProtectionScope\]::CurrentUser/,
    /Read-Host[\s\S]{0,120}-AsSecureString/,
    /SetAccessRuleProtection\(\$true, \$false\)/,
    /New-ScheduledTaskTrigger -AtLogOn/,
    /Schedule\.Service/,
    /CreateFolder\("MomentInsight"\)/,
    /New-TimeSpan -Minutes 10/,
    /-LogonType Interactive -RunLevel Limited/,
    /tools\/naver-shopping-chrome-extension\/service-worker\.js/,
    /chrome:\/\/extensions/,
  ])
    && !/-AsPlainText|cmdkey|remote-debugging|no-sandbox|user-data-dir/iu.test(shoppingWindowsHostInstaller)
    && hasAll(shoppingWindowsHostLauncher, [
      /ProtectedData\.Unprotect/,
      /DataProtectionScope\.CurrentUser/,
      /RedirectStandardInput = false/,
      /RedirectStandardOutput = true/,
      /child\.StandardOutput\.BaseStream\.CopyTo\(output\)/,
      /outputRelay\.Join\(5000\)/,
      /child\.WaitForExit\(\)/,
      /MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET/,
      /String\.Equals\(maxJobs, "1"/,
    ])
    && !/NAVER_SHOPPING_PROVIDER_TIMEOUT_MS/u.test(shoppingWindowsHostLauncher)
    && !/Console\.(?:Write|WriteLine)|StandardInput\.BaseStream/u.test(shoppingWindowsHostLauncher)
    && hasAll(shoppingWindowsChromeScheduler, [
      /'--profile-directory="\{0\}"' -f \$profileDirectory/,
      /chrome_ready profile=/,
    ])
    && !/remote-debugging|no-sandbox|user-data-dir/iu.test(shoppingWindowsChromeScheduler),
  `${files.shoppingWindowsHostInstaller}, ${files.shoppingWindowsHostLauncher}, ${files.shoppingWindowsChromeScheduler}`,
);
check(
  "N Shopping website wakes the development Chrome profile within one minute and runs one job",
  shoppingChromeManifest.version === "1.1.1"
    && shoppingChromeManifest.icons?.[16] === "icon16.png"
    && shoppingChromeManifest.icons?.[128] === "icon128.png"
    && /\["rank-remote", \{ delayInMinutes: 1, periodInMinutes: 1 \}\]/.test(shoppingChromeWorker)
    && /result\.status === "standby" \|\| result\.status === "idle"/.test(shoppingChromeWorker)
    && /result\.status === "standby"/.test(shoppingChromeWorker)
    && /naver_network_restricted/.test(shoppingChromeWorker)
    && /typedCollectionError\(error, collectionStageCode\)/.test(shoppingChromeWorker)
    && /collectionStageCode = "naver_page_navigation_failed"/.test(shoppingChromeWorker)
    && /native_host_timeout"\)\), 30 \* 60_000/.test(shoppingChromeWorker)
    && /WORKER_COLLECTION_LEASE_SECONDS = 35 \* 60/.test(shoppingLocalWorkerHandler)
    && /MIN_RANK_TRACKER_LEASE_MS = 1000 \* 60 \* 35/.test(productTrackers)
    && /port\.postMessage\(\{ action: "run", trigger, \.\.\.runtimeIdentity \}\)/.test(shoppingChromeWorker)
    && /chrome\.runtime\.getManifest\(\)\.version/.test(shoppingChromeWorker)
    && /crypto\.subtle\.digest/.test(shoppingChromeWorker)
    && /async function requestWorkerRun\(trigger\)[\s\S]*?void runWorker\(trigger\)/.test(shoppingChromeWorker)
    && /chrome\.runtime\.connectNative\(NATIVE_HOST\)/.test(shoppingChromeWorker)
    && /WORKER_KEEPALIVE_INTERVAL_MS = 20_000/.test(shoppingChromeWorker)
    && /function startWorkerKeepAlive\(\)/.test(shoppingChromeWorker)
    && /const timer = setInterval\(heartbeat, WORKER_KEEPALIVE_INTERVAL_MS\)/.test(shoppingChromeWorker)
    && /return \(\) => clearInterval\(timer\)/.test(shoppingChromeWorker)
    && /if \(stopKeepAlive\) stopKeepAlive\(\)/.test(shoppingChromeWorker)
    && /async function removeLegacyControllerTabs\(\)/.test(shoppingChromeWorker)
    && /void removeLegacyControllerTabs\(\)/.test(shoppingChromeWorker)
    && !/<script src="service-worker\.js"><\/script>/.test(shoppingChromePopupHtml)
    && /chrome\.runtime\.sendMessage\(\{ action: "run-now" \}\)/.test(shoppingChromePopup)
    && /<button id="run" type="button">지금 안전 갱신<\/button>/.test(shoppingChromePopupHtml)
    && /automaticVerificationCooldownActive\(trigger\)/.test(shoppingChromeWorker)
    && /selectPendingTrigger\(currentTrigger, candidateTrigger\)/.test(shoppingChromeWorker)
    && /candidate === "rank-remote"/.test(shoppingChromeWorker)
    && /const nextTrigger = takePendingTrigger\(\)/.test(shoppingChromeWorker)
    && /PENDING_TRIGGER_HANDOFF_MS = 6_000/.test(shoppingChromeWorker)
    && /result\.status === "control_plane_failed"/.test(shoppingChromeWorker)
    && /result\.status !== "completed"/.test(shoppingChromeWorker)
    && /verification\.blockedUntil > Date\.now\(\)/.test(shoppingChromeWorker)
    && /chrome_already_running profile=/.test(shoppingWindowsChromeScheduler)
    && /RANK_LOOKUP_EXPIRED/.test(shoppingRankLookupJobs)
    && /RANK_LOOKUP_WORKER_STALLED/.test(shoppingRankLookupJobs)
    && /pending: false/.test(shoppingRankLookupJobs)
    && /chrome\.tabs\.create\(\{ url, active: false \}\)/.test(shoppingChromeWorker)
    && /WHOLE_SITE_QUEUE_TRIGGERS = new Set\(\["manual", "rank-catch-up"\]\)/.test(shoppingNativeHost)
    && /writeMessage\(\{ type: "ready" \}\)/.test(shoppingNativeHost)
    && /readyAck = await nextMessage\(30_000\)/.test(shoppingNativeHost)
    && /port\.postMessage\(\{ action: "ready_ack" \}\)/.test(shoppingChromeWorker)
    && /queueAllTrackers: WHOLE_SITE_QUEUE_TRIGGERS\.has\(start\.trigger\)/.test(shoppingNativeHost)
    && /await writeTerminalMessage\(\{ type: "summary", summary \}\)/.test(shoppingNativeHost)
    && /process\.stdin\.destroy\(\)/.test(shoppingNativeHost)
    && shoppingWindowsHostLauncher.indexOf("child.WaitForExit();")
      < shoppingWindowsHostLauncher.indexOf("singleInstance.ReleaseMutex();")
    && shoppingWindowsHostLauncher.indexOf("singleInstance.ReleaseMutex();")
      < shoppingWindowsHostLauncher.indexOf("outputRelay.Join(5000)")
    && /requireWakeSignal: start\.trigger === "rank-remote"/.test(shoppingNativeHost)
    && /async function runtimeIdentity\(start\)/.test(shoppingNativeHost)
    && /registerProgressSink\(sink\)/.test(shoppingNativeHost)
    && /options\.requireWakeSignal === true\s*\? 1/.test(shoppingLocalWorker)
    && /action\(\{ action: "claim-wake", \.\.\.lanePayload \}\)/.test(shoppingLocalWorker)
    && /action: "claim-lane"/.test(shoppingLocalWorker)
    && /action: "release-lane"/.test(shoppingLocalWorker)
    && /action: "block-lane"/.test(shoppingLocalWorker)
    && /body\.action === "claim-wake"/.test(shoppingLocalWorkerHandler)
    && /mi_request_naver_shopping_worker_wake/.test(shoppingWorkerWake)
    && /mi_claim_naver_shopping_worker_wake/.test(shoppingWorkerWake)
    && /force row level security/.test(shoppingWorkerWakeMigration)
    && /security invoker/.test(shoppingWorkerWakeMigration)
    && !/security definer/.test(shoppingWorkerWakeMigration)
    && /consumed_at is null or consumed_at < requested_at/.test(shoppingWorkerWakeMigration)
    && /primary_seen_at/.test(shoppingWorkerLaneMigration)
    && /mi_claim_naver_shopping_worker_lane/.test(shoppingWorkerLaneMigration)
    && /mi_block_naver_shopping_worker_lane/.test(shoppingWorkerLaneMigration)
    && /security invoker/.test(shoppingWorkerLaneMigration)
    && !/security definer/.test(shoppingWorkerLaneMigration)
    && /date_trunc\('milliseconds', clock_timestamp\(\)\)/.test(shoppingRankLookupLeasePrecisionMigration)
    && /processing_started_at = v_lease_started_at/.test(shoppingRankLookupLeasePrecisionMigration)
    && /date_trunc\('milliseconds', v_job\.processing_started_at\)/.test(shoppingRankLookupLeasePrecisionMigration)
    && /date_trunc\('milliseconds', processing_started_at\)/.test(shoppingRankLookupLeasePrecisionMigration)
    && /to service_role/.test(shoppingRankLookupLeasePrecisionMigration)
    && /requestShoppingWorkerWake\(ctx, "tracker-refresh-all"\)/.test(productTrackers)
    && /requestShoppingWorkerWake\(ctx, "rank-lookup"\)/.test(shoppingRankLookupJobs)
    && [adminPage, clientPage].every((source) =>
      /queuedPayload\.remoteWakeRequested === true/.test(source)
        && /개발 프로필에 원격 실행을 요청했습니다\./.test(source)),
  `${files.productTrackers}, ${files.shoppingRankLookupJobs}, ${files.shoppingWorkerWake}, ${files.shoppingWorkerWakeMigration}, ${files.shoppingWorkerLaneMigration}, ${files.shoppingRankLookupLeasePrecisionMigration}, ${files.shoppingLocalWorkerHandler}, ${files.shoppingLocalWorker}, ${files.shoppingNativeHost}, ${files.shoppingChromeManifest}, ${files.shoppingChromeWorker}, ${files.shoppingChromePopup}, ${files.shoppingChromePopupHtml}, ${files.adminPage}, ${files.clientPage}`,
);
check(
  "N Shopping source classifies 418 as unavailable and 429 as retryable",
  shopping418Failure.status === "unavailable"
    && shopping418Failure.retryable === false
    && shopping418Failure.retryAfterSeconds === 0
    && shopping429Failure.status === "error"
    && shopping429Failure.retryable === true
    && shopping429Failure.retryAfterSeconds === 5
    && /status === 429/.test(shoppingSourceStatus)
    && /naver\[_ -\]\?http\[_ -\]\?429/.test(shoppingSourceStatus),
  files.shoppingSourceStatus,
);
check(
  "N Shopping provider preserves the 90-second request and 75-second cold-start budgets",
  shoppingProviderDefaults.requestTimeoutMs === 90_000
    && shoppingProviderDefaults.prewarmTimeoutMs === 75_000
    && /const DEFAULT_REQUEST_TIMEOUT_MS = 90_000/.test(shoppingProviderRuntime)
    && /const DEFAULT_PREWARM_TIMEOUT_MS = 75_000/.test(shoppingProviderRuntime)
    && /runtime\.prewarmTimeoutMs, 1_000, 90_000/.test(shoppingProviderRuntime)
    && /lastResult\.ready \|\| \["unavailable", "unauthorized", "misconfigured"\]\.includes\(lastResult\.status\)/.test(shoppingProviderRuntime)
    && /providerPrewarmCache\.delete\(cacheKey\)/.test(shoppingProviderRuntime),
  files.shoppingProviderRuntime,
);
check(
  "N Shopping local launch is bounded and keeps the server rescue available",
  hasAll(shoppingLocalWorker, [
    /MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS/,
    /acquireWorkerLock/,
    /local_worker_window_not_300/,
  ])
    && hasAll(shoppingLocalWorkerWrapper, [
      /MAX_ATTEMPTS=3/,
      /security find-generic-password/,
      /caffeinate -i -s/,
    ])
    && hasAll(shoppingLocalWorkerPlist, [
      /<key>StartInterval<\/key>\s*<integer>300<\/integer>/,
      /<key>Hour<\/key>\s*<integer>9<\/integer>/,
      /<key>Hour<\/key>\s*<integer>15<\/integer>/,
    ])
    && /verifiedHybridWorkerEvidence/.test(shoppingLiveGate),
  `${files.shoppingLocalWorker}, ${files.shoppingLocalWorkerWrapper}, ${files.shoppingLocalWorkerPlist}, ${files.shoppingLiveGate}`,
);
check(
  "N Shopping local engine keeps Playwright exactly pinned in its lockfile",
  /^\d+\.\d+\.\d+$/u.test(shoppingPlaywrightVersion)
    && shoppingCollectorPackageLock.lockfileVersion === 3
    && shoppingCollectorPackageLock.packages?.[""]?.dependencies?.playwright === shoppingPlaywrightVersion,
  `${files.shoppingCollectorPackage}, ${files.shoppingCollectorPackageLock}`,
);
check(
  "N Shopping production gate requires one complete atomic 300-item organic window",
  /const MAX_RANK_LIMIT = 300/.test(shoppingCollectorContract)
    && /value\.items\.length !== value\.checkedCount/.test(shoppingCollectorContract)
    && /validateItem\(item, index \+ 1, request\.limit\)/.test(shoppingCollectorContract)
    && /provider_ad_item_rejected/.test(shoppingCollectorContract)
    && /argValue\("limit", "300"\)/.test(shoppingLiveGate)
    && /window\.complete !== true/.test(shoppingLiveGate)
    && /window\.checkedCount !== limit/.test(shoppingLiveGate)
    && /collector_window_short/.test(shoppingLiveGate),
  `${files.shoppingCollectorContract}, ${files.shoppingLiveGate}`,
);
check(
  "N Shopping server and local worker keep bounded collection envelopes",
  hasAll(shoppingRank, [
    /const SHOPPING_PROVIDER_TIMEOUT_MS = 90_000;/,
    /MI_NAVER_SHOPPING_PROVIDER_TIMEOUT_MS \|\| SHOPPING_PROVIDER_TIMEOUT_MS/,
  ])
    && hasAll(shoppingLiveGate, [
      /timeoutMs = 90_000/,
      /Date\.now\(\) \+ 90_000/,
      /}, 90_000\);/,
    ])
    && /MI_NAVER_SHOPPING_PROVIDER_TIMEOUT_MS=90000/.test(naverEnvExample)
    && /NAVER_SHOPPING_PROVIDER_TIMEOUT_MS[\s\S]{0,100}14 \* 60_000/.test(shoppingLocalWorker)
    && /LOCAL_WORKER_REQUEST_TIMEOUT_MS = 14 \* 60_000/.test(shoppingLocalWorkerContract)
    && /getShoppingRankApiUrl\(\)[\s\S]{0,180}timeoutMs:\s*120000/.test(adminPage)
    && /getShoppingRankApiUrl\(\)[\s\S]{0,180}timeoutMs:\s*120000/.test(clientPage),
  `${files.shoppingRank}, ${files.shoppingLiveGate}, ${files.shoppingLocalWorker}, ${files.shoppingLocalWorkerContract}, ${files.naverEnvExample}, ${files.adminPage}, ${files.clientPage}`,
);
const globalSecurityHeaders = Object.fromEntries(
  ((vercel.headers || []).find((entry) => entry.source === "/(.*)")?.headers || [])
    .map((header) => [String(header.key || "").toLowerCase(), header.value]),
);
check(
  "Vercel applies transport, clickjacking and browser capability protections",
  globalSecurityHeaders["strict-transport-security"] === "max-age=31536000; includeSubDomains"
    && globalSecurityHeaders["x-frame-options"] === "DENY"
    && /frame-ancestors 'none'/.test(globalSecurityHeaders["content-security-policy"] || "")
    && /camera=\(\)/.test(globalSecurityHeaders["permissions-policy"] || ""),
  files.vercel,
);

for (const result of checks) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.detail})`);
}

const failed = checks.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`Server contract check failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}

console.log(`Server contract check passed: ${checks.length}/${checks.length}`);
