import fs from "node:fs";
import crypto from "node:crypto";
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
  personalAssistant: "src/server/handlers/personal-assistant-api.mjs",
  personalAssistantAdapter: "api/my/assistant-chat.mjs",
  sessionAdapter: "api/session.mjs",
  responseAdapter: "api/_response-adapter.mjs",
  runtime: "src/server/runtime.mjs",
  errorSafety: "src/server/error-safety.mjs",
  readiness: "src/server/handlers/ready.mjs",
  productCron: "src/server/handlers/naver-rank-cron.mjs",
  placeCron: "src/server/handlers/naver-place-rank-cron.mjs",
  productSeoAudit: "src/server/handlers/naver-product-seo-audit.mjs",
  productTrackers: "src/server/handlers/naver-rank-trackers.mjs",
  adminApi: "src/server/handlers/admin-api.mjs",
  clientApi: "src/server/handlers/client-api.mjs",
  workItems: "src/server/handlers/work-items.mjs",
  workItemsMigration: "supabase/migrations/20260730074106_extend_schedule_items_for_work_operations.sql",
  calendarDomain: "src/server/calendar-domain.mjs",
  calendarHandlerTests: "src/server/handlers/work-items-calendar.test.mjs",
  calendarMigration: "supabase/migrations/20260820110000_schedule_calendar_sharing.sql",
  calendarMigrationTests: "scripts/calendar-sharing-migration.test.mjs",
  calendarNoEndMigration: "supabase/migrations/20260820152359_schedule_monthly_no_end_mode.sql",
  calendarNoEndMigrationTests: "scripts/schedule-monthly-no-end-migration.test.mjs",
  calendarUiTests: "scripts/work-calendar-ui.test.mjs",
  shoppingRank: "src/server/handlers/naver-shopping-rank.mjs",
  shoppingSourceStatus: "src/server/naver-shopping/source-status.mjs",
  shoppingProviderRuntime: "src/server/naver-shopping/provider-runtime.mjs",
  shoppingCollectorContract: "tools/naver-shopping-rank-collector/src/contract.mjs",
  shoppingCollectorProvider: "tools/naver-shopping-rank-collector/src/provider.mjs",
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
  shoppingWorkerCycleOverflowMigration: "supabase/migrations/20260821042129_naver_shopping_cycle_keyword_overflow.sql",
  shoppingWorkerRuntime112Migration: "supabase/migrations/20260813070000_naver_shopping_runtime_1_1_2.sql",
  shoppingWorkerRuntime113Migration: "supabase/migrations/20260813072500_naver_shopping_runtime_1_1_3.sql",
  shoppingWorkerRuntime114Migration: "supabase/migrations/20260813084000_naver_shopping_runtime_1_1_4.sql",
  shoppingWorkerRuntime115Migration: "supabase/migrations/20260814110000_naver_shopping_runtime_1_1_5.sql",
  shoppingSchedulerEventLedgerMigration: "supabase/migrations/20260814130826_naver_shopping_scheduler_event_ledger.sql",
  shoppingWorkerRuntime116Migration: "supabase/migrations/20260814140000_naver_shopping_runtime_1_1_6.sql",
  shoppingWorkerRuntime117Migration: "supabase/migrations/20260814173500_naver_shopping_runtime_1_1_7.sql",
  shoppingWorkerRuntime118Migration: "supabase/migrations/20260815014135_naver_shopping_runtime_1_1_8.sql",
  shoppingWorkerRuntime119Migration: "supabase/migrations/20260821160000_naver_shopping_runtime_1_1_9.sql",
  shoppingWorkerRuntime110Migration: "supabase/migrations/20260821180000_naver_shopping_runtime_1_1_10.sql",
  shoppingWorkerRuntime111Migration: "supabase/migrations/20260821180002_naver_shopping_runtime_1_1_11.sql",
  shoppingWorkerRuntime1112Migration: "supabase/migrations/20260824042226_naver_shopping_runtime_1_1_12.sql",
  shoppingWorkerRuntime1113Candidate6Migration: "supabase/migrations/20260824165332_naver_shopping_runtime_1_1_13_candidate_6_minute_cadence.sql",
  shoppingStableFiniteWindowMigration: "supabase/migrations/20260826035440_naver_shopping_stable_finite_window_v1.sql",
  shoppingStableFiniteWindowRuntime1115Migration: "supabase/migrations/20260826083450_naver_shopping_runtime_1_1_15_stable_finite_third_pass.sql",
  shoppingExactParentRelationGuardMigration: "supabase/migrations/20260827050000_naver_shopping_exact_parent_relation_guard.sql",
  shoppingStableFiniteWindowRuntime1116Migration: "supabase/migrations/20260827051000_naver_shopping_runtime_1_1_16_exact_parent.sql",
  shoppingNextDataSchemaDriftRecoveryMigration: "supabase/migrations/20260827194500_naver_shopping_next_data_schema_drift_recovery.sql",
  shoppingSupersavingCompositeRecoveryMigration: "supabase/migrations/20260828025000_naver_shopping_supersaving_composite_recovery.sql",
  shoppingExactParentGuardRuntimeRecoveryMigration: "supabase/migrations/20260828034500_naver_shopping_exact_parent_guard_runtime_recovery.sql",
  shoppingCandidatePerformanceAudit: "scripts/naver-shopping-candidate-performance-audit.mjs",
  shoppingWorkerCandidate111ExactIdentityMigration: "supabase/migrations/20260822061741_naver_shopping_candidate_exact_identity_gate.sql",
  shoppingWorkerCandidateExactIdentityMigration: "supabase/migrations/20260824042232_naver_shopping_runtime_1_1_12_exact_candidate_gate.sql",
  shoppingAtomicSuccessProofHardeningMigration: "supabase/migrations/20260824133751_naver_shopping_atomic_success_proof_hardening.sql",
  shoppingStableProofLedgerMigration: "supabase/migrations/20260815015239_naver_shopping_stable_proof_ledger.sql",
  shoppingStableProofQuarantineMigration: "supabase/migrations/20260815015618_naver_shopping_stable_proof_quarantine.sql",
  shoppingAutoNavigationHalfOpenMigration: "supabase/migrations/20260814182150_naver_shopping_auto_navigation_half_open.sql",
  shoppingAutoNavigationTrackerFailureRecoveryMigration: "supabase/migrations/20260814183217_naver_shopping_auto_navigation_tracker_failure_recovery.sql",
  shoppingProbeIncompleteAutoRecoveryMigration: "supabase/migrations/20260819022043_naver_shopping_probe_incomplete_auto_recovery.sql",
  shoppingTransientSystemRecoveryMigration: "supabase/migrations/20260821153000_naver_shopping_transient_system_half_open.sql",
  shoppingNativeInputClosedHalfOpenMigration: "supabase/migrations/20260821170000_naver_shopping_native_input_closed_half_open.sql",
  shoppingErrorTaxonomyHardeningMigration: "supabase/migrations/20260821180001_naver_shopping_error_taxonomy_hardening.sql",
  shoppingTransientSystemRecoveryTests: "scripts/naver-shopping-transient-system-recovery-migration.test.mjs",
  shoppingDuplicateQuarantineMigration: "supabase/migrations/20260813144700_naver_shopping_duplicate_quarantine_cap.sql",
  shoppingRankLookupLeasePrecisionMigration: "supabase/migrations/20260811142000_fix_naver_shopping_lookup_lease_precision.sql",
  shoppingRankLookupJobs: "src/server/handlers/naver-shopping-rank-jobs.mjs",
  shoppingNativeHost: "scripts/naver-shopping-native-host.mjs",
  shoppingNativeHostCore: "scripts/naver-shopping-native-host-core.mjs",
  shoppingNativeHostInstaller: "scripts/install-naver-shopping-chrome-bridge.mjs",
  shoppingWindowsHostInstaller: "scripts/install-naver-shopping-chrome-bridge-windows.ps1",
  shoppingWindowsExtensionUpdater: "scripts/windows/update-naver-shopping-chrome-extension.ps1",
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
const personalAssistant = fs.readFileSync(files.personalAssistant, "utf8");
const personalAssistantAdapter = fs.readFileSync(files.personalAssistantAdapter, "utf8");
const sessionAdapter = fs.readFileSync(files.sessionAdapter, "utf8");
const responseAdapter = fs.readFileSync(files.responseAdapter, "utf8");
const runtime = fs.readFileSync(files.runtime, "utf8");
const errorSafety = fs.readFileSync(files.errorSafety, "utf8");
const readiness = fs.readFileSync(files.readiness, "utf8");
const productCron = fs.readFileSync(files.productCron, "utf8");
const placeCron = fs.readFileSync(files.placeCron, "utf8");
const productSeoAudit = fs.readFileSync(files.productSeoAudit, "utf8");
const productTrackers = fs.readFileSync(files.productTrackers, "utf8");
const adminApi = fs.readFileSync(files.adminApi, "utf8");
const clientApi = fs.readFileSync(files.clientApi, "utf8");
const workItems = fs.readFileSync(files.workItems, "utf8");
const workItemsMigration = fs.readFileSync(files.workItemsMigration, "utf8");
const calendarDomain = fs.readFileSync(files.calendarDomain, "utf8");
const calendarHandlerTests = fs.readFileSync(files.calendarHandlerTests, "utf8");
const calendarMigration = fs.readFileSync(files.calendarMigration, "utf8");
const calendarMigrationTests = fs.readFileSync(files.calendarMigrationTests, "utf8");
const calendarNoEndMigration = fs.readFileSync(files.calendarNoEndMigration, "utf8");
const calendarNoEndMigrationTests = fs.readFileSync(files.calendarNoEndMigrationTests, "utf8");
const calendarUiTests = fs.readFileSync(files.calendarUiTests, "utf8");
const shoppingRank = fs.readFileSync(files.shoppingRank, "utf8");
const shoppingSourceStatus = fs.readFileSync(files.shoppingSourceStatus, "utf8");
const shoppingProviderRuntime = fs.readFileSync(files.shoppingProviderRuntime, "utf8");
const shoppingCollectorContract = fs.readFileSync(files.shoppingCollectorContract, "utf8");
const shoppingCollectorProvider = fs.readFileSync(files.shoppingCollectorProvider, "utf8");
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
const shoppingWorkerCycleOverflowMigration = fs.readFileSync(files.shoppingWorkerCycleOverflowMigration, "utf8");
const shoppingWorkerRuntime112Migration = fs.readFileSync(files.shoppingWorkerRuntime112Migration, "utf8");
const shoppingWorkerRuntime113Migration = fs.readFileSync(files.shoppingWorkerRuntime113Migration, "utf8");
const shoppingWorkerRuntime114Migration = fs.readFileSync(files.shoppingWorkerRuntime114Migration, "utf8");
const shoppingWorkerRuntime115Migration = fs.readFileSync(files.shoppingWorkerRuntime115Migration, "utf8");
const shoppingSchedulerEventLedgerMigration = fs.readFileSync(files.shoppingSchedulerEventLedgerMigration, "utf8");
const shoppingWorkerRuntime116Migration = fs.readFileSync(files.shoppingWorkerRuntime116Migration, "utf8");
const shoppingWorkerRuntime117Migration = fs.readFileSync(files.shoppingWorkerRuntime117Migration, "utf8");
const shoppingWorkerRuntime118Migration = fs.readFileSync(files.shoppingWorkerRuntime118Migration, "utf8");
const shoppingWorkerRuntime119Migration = fs.readFileSync(files.shoppingWorkerRuntime119Migration, "utf8");
const shoppingWorkerRuntime110Migration = fs.readFileSync(files.shoppingWorkerRuntime110Migration, "utf8");
const shoppingWorkerRuntime111Migration = fs.readFileSync(files.shoppingWorkerRuntime111Migration, "utf8");
const shoppingWorkerRuntime1112Migration = fs.readFileSync(files.shoppingWorkerRuntime1112Migration, "utf8");
const shoppingWorkerRuntime1113Candidate6Migration = fs.readFileSync(files.shoppingWorkerRuntime1113Candidate6Migration, "utf8");
const shoppingStableFiniteWindowMigration = fs.readFileSync(files.shoppingStableFiniteWindowMigration, "utf8");
const shoppingStableFiniteWindowRuntime1115Migration = fs.readFileSync(files.shoppingStableFiniteWindowRuntime1115Migration, "utf8");
const shoppingExactParentRelationGuardMigration = fs.readFileSync(files.shoppingExactParentRelationGuardMigration, "utf8");
const shoppingStableFiniteWindowRuntime1116Migration = fs.readFileSync(files.shoppingStableFiniteWindowRuntime1116Migration, "utf8");
const shoppingNextDataSchemaDriftRecoveryMigration = fs.readFileSync(files.shoppingNextDataSchemaDriftRecoveryMigration, "utf8");
const shoppingSupersavingCompositeRecoveryMigration = fs.readFileSync(files.shoppingSupersavingCompositeRecoveryMigration, "utf8");
const shoppingExactParentGuardRuntimeRecoveryMigration = fs.readFileSync(files.shoppingExactParentGuardRuntimeRecoveryMigration, "utf8");
const shoppingCandidatePerformanceAudit = fs.readFileSync(files.shoppingCandidatePerformanceAudit, "utf8");
const shoppingWorkerCandidate111ExactIdentityMigration = fs.readFileSync(files.shoppingWorkerCandidate111ExactIdentityMigration, "utf8");
const shoppingWorkerCandidateExactIdentityMigration = fs.readFileSync(files.shoppingWorkerCandidateExactIdentityMigration, "utf8");
const shoppingAtomicSuccessProofHardeningMigration = fs.readFileSync(files.shoppingAtomicSuccessProofHardeningMigration, "utf8");
const shoppingStableProofLedgerMigration = fs.readFileSync(files.shoppingStableProofLedgerMigration, "utf8");
const shoppingStableProofQuarantineMigration = fs.readFileSync(files.shoppingStableProofQuarantineMigration, "utf8");
const shoppingAutoNavigationHalfOpenMigration = fs.readFileSync(files.shoppingAutoNavigationHalfOpenMigration, "utf8");
const shoppingAutoNavigationTrackerFailureRecoveryMigration = fs.readFileSync(files.shoppingAutoNavigationTrackerFailureRecoveryMigration, "utf8");
const shoppingProbeIncompleteAutoRecoveryMigration = fs.readFileSync(files.shoppingProbeIncompleteAutoRecoveryMigration, "utf8");
const shoppingTransientSystemRecoveryMigration = fs.readFileSync(files.shoppingTransientSystemRecoveryMigration, "utf8");
const shoppingNativeInputClosedHalfOpenMigration = fs.readFileSync(files.shoppingNativeInputClosedHalfOpenMigration, "utf8");
const shoppingErrorTaxonomyHardeningMigration = fs.readFileSync(files.shoppingErrorTaxonomyHardeningMigration, "utf8");
const shoppingTransientSystemRecoveryTests = fs.readFileSync(files.shoppingTransientSystemRecoveryTests, "utf8");
const shoppingDuplicateQuarantineMigration = fs.readFileSync(files.shoppingDuplicateQuarantineMigration, "utf8");
const shoppingRankLookupLeasePrecisionMigration = fs.readFileSync(files.shoppingRankLookupLeasePrecisionMigration, "utf8");
const shoppingRankLookupJobs = fs.readFileSync(files.shoppingRankLookupJobs, "utf8");
const shoppingNativeHost = fs.readFileSync(files.shoppingNativeHost, "utf8");
const shoppingNativeHostCore = fs.readFileSync(files.shoppingNativeHostCore, "utf8");
const shoppingNativeHostInstaller = fs.readFileSync(files.shoppingNativeHostInstaller, "utf8");
const shoppingWindowsHostInstaller = fs.readFileSync(files.shoppingWindowsHostInstaller, "utf8");
const shoppingWindowsExtensionUpdater = fs.readFileSync(files.shoppingWindowsExtensionUpdater, "utf8");
const shoppingWindowsHostLauncher = fs.readFileSync(files.shoppingWindowsHostLauncher, "utf8");
const shoppingWindowsChromeScheduler = fs.readFileSync(files.shoppingWindowsChromeScheduler, "utf8");
const shoppingChromeSchedulerWrapper = fs.readFileSync(files.shoppingChromeSchedulerWrapper, "utf8");
const shoppingNativeHostWrapper = fs.readFileSync(files.shoppingNativeHostWrapper, "utf8");
const shoppingChromeManifest = JSON.parse(fs.readFileSync(files.shoppingChromeManifest, "utf8"));
const shoppingChromeWorker = fs.readFileSync(files.shoppingChromeWorker, "utf8");
const shoppingChromePopup = fs.readFileSync(files.shoppingChromePopup, "utf8");
const shoppingChromePopupHtml = fs.readFileSync(files.shoppingChromePopupHtml, "utf8");
const shoppingWorkerRuntime1113Fingerprint =
  "cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6";
const shoppingWorkerRuntime1114Fingerprint =
  "13e801cf18adaea7352d7c78bbe067f969e3fef5e756528335443d3122b2d405";
const shoppingWorkerRuntime1115Fingerprint =
  "c7941930ccabd1206f19cc9ae5cfcd744f12313974c37d5143ed5f795ec9b46c";
const shoppingWorkerRuntime1116Fingerprint = crypto.createHash("sha256").update([
  "1.1.16",
  files.shoppingChromeWorker,
  files.shoppingNativeHost,
  files.shoppingNativeHostCore,
  files.shoppingLocalWorker,
  files.shoppingLocalWorkerAuth,
  files.shoppingLocalWorkerContract,
  files.shoppingRank,
  "src/server/security.mjs",
  files.shoppingSourceStatus,
  files.shoppingProviderRuntime,
  "src/server/naver-shopping/mobile-top-fallback.mjs",
  files.shoppingCollectorProvider,
  files.shoppingCollectorContract,
].map((value, index) => index === 0 ? value : crypto.createHash("sha256")
  .update(fs.readFileSync(value))
  .digest("hex")).join("\n"), "utf8").digest("hex");
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
  "personal schedules stay scoped and bounded while monthly no-end intent is explicit",
  hasAll(workItems, [
    /buildMonthlyOccurrences/,
    /error\.code === "23505"/,
    /exactOriginalScope/,
    /workItemsDateRange/,
    /cleanText\(body\.action\)\.startsWith\("calendar-"\)/,
    /calendars:\s*\[\]/,
    /\.is\("calendar_id", null\)/,
    /typeof body\.repeatNoEnd !== "boolean"/,
    /recurrence_no_end/,
  ])
    && !/schedule_calendar_memberships|mi_(?:insert|update|delete)_shared_schedule/iu.test(workItems)
    && hasAll(adminApi, [
      /personalOnly:\s*true/,
      /query\.is\("calendar_id", null\)/,
      /nonPersonalCalendarRequested/,
    ])
    && hasAll(clientApi, [
      /personalOnly:\s*true/,
      /query\.is\("calendar_id", null\)/,
    ])
    && hasAll(calendarDomain, [
      /DEFAULT_MAX_OCCURRENCES = 60/,
      /timeZone: "Asia\/Seoul"/,
      /Math\.min\(localStart\.day, daysInMonth/,
      /repeatNoEnd/,
    ])
    && hasAll(calendarMigration, [
      /create table if not exists public\.schedule_calendars/,
      /create table if not exists public\.schedule_calendar_memberships/,
      /create table if not exists public\.schedule_calendar_invites/,
      /force row level security/,
      /revoke all on table public\.schedule_items from public, anon, authenticated/,
      /create unique index[^;]+\(series_id, occurrence_on\)/,
      /for update/,
      /security invoker/,
      /grant execute on function public\.mi_accept_schedule_calendar_invite[^;]+to service_role/,
    ])
    && !/grant\s+(?:select|insert|update|delete)[^;]*on table public\.schedule_items to (?:public|anon|authenticated)/i.test(calendarMigration)
    && !/update\s+public\.schedule_items\s+set\s+calendar_id/i.test(calendarMigration)
    && hasAll(calendarNoEndMigration, [
      /add column if not exists recurrence_no_end boolean not null default false/,
      /schedule_items_recurrence_no_end_coherent/,
      /comment on column public\.schedule_items\.recurrence_no_end/,
    ])
    && !/grant\s+(?:select|insert|update|delete)[^;]*to\s+(?:public|anon|authenticated)/i.test(calendarNoEndMigration)
    && calendarHandlerTests.includes("concurrent monthly retries resolve the unique series race as unchanged")
    && calendarHandlerTests.includes("monthly no-end POST stores intent and an exact 60-occurrence materialized horizon")
    && calendarHandlerTests.includes("personal-only contract: sharing, list, create, join, invite, and leave actions are disabled")
    && calendarHandlerTests.includes("existing shared rows reject PATCH, DELETE, and assistant completion")
    && calendarMigrationTests.includes("service-role-only")
    && calendarNoEndMigrationTests.includes("stores explicit intent")
    && calendarUiTests.includes("wide personal calendar without list or sharing controls")
    && calendarUiTests.includes("preserving existing work fields")
    && calendarUiTests.includes("no planned end")
    && String(packageJson.scripts?.test || "").includes("scripts/calendar-sharing-migration.test.mjs")
    && String(packageJson.scripts?.test || "").includes("scripts/schedule-monthly-no-end-migration.test.mjs")
    && String(packageJson.scripts?.test || "").includes("scripts/work-calendar-ui.test.mjs"),
  `${files.workItems}, ${files.adminApi}, ${files.clientApi}, ${files.calendarDomain}, ${files.calendarMigration}, ${files.calendarNoEndMigration}, ${files.calendarHandlerTests}, ${files.calendarMigrationTests}, ${files.calendarNoEndMigrationTests}, ${files.calendarUiTests}`,
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
  "owner assistant canary is exact-owner-only, deterministic, internal and confirmation-gated",
  hasAll(ownerTool, [
    /data-mi-admin-screen="owner-assistant"/,
    /data-mi-admin-view="owner-assistant"/,
    /모먼트랩스 비서실 운영실/,
    /data-owner-assistant-office/,
    /data-owner-assistant-agent/,
    /자리 대기, 담당 회의, 비서실장 방문/,
    /독립 AI 직원의 자동 실행 상태는 아닙니다/,
    /data-owner-assistant-mic/,
    /data-owner-assistant-wake/,
    /data-owner-assistant-read/,
    /body\?\.action === "assistant-draft"/,
    /source: "deterministic-private-v1"/,
    /visibility: "internal"/,
    /날짜가 확인되는 문장만/,
  ]) && hasAll(adminPage, [
    /getAttribute\("data-mi-admin-view"\) === "owner-assistant"/,
    /window\.confirm\(targetLabel \+ " 일정으로 등록할까요\?/,
    /await requestWorkItems\("POST", workItemPayload\(draft\)\)/,
    /renderOwnerAssistantBriefing/,
    /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/,
    /new window\.SpeechSynthesisUtterance\(briefing\)/,
    /function runOfficeScene\(\)/,
    /ownerAssistantOfficeController\.setActive\(target === "owner-assistant" && secureSession\.role === "owner"\)/,
    /ownerAssistantOfficeController\.destroy\(\)/,
  ]),
  `${files.ownerTool}, ${files.adminPage}`,
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
  "personal assistant chat is routed per account, rate limited and never reads schedule rows",
  hasAll(serverIndex, [
    /personalAssistantApi: \(\) => import\("\.\/handlers\/personal-assistant-api\.mjs"\)/,
    /url\.pathname === "\/api\/my\/assistant-chat"/,
    /dispatch\("personalAssistantApi", request\)/,
  ]) && hasAll(sessionGate, [
    /"\/api\/my\/assistant-chat"/,
  ]) && hasAll(personalAssistant, [
    /resolvePersonalAccess/,
    /consume_code_login_rate_limit/,
    /code: "rate_limited"/,
    /code: "missing_api_key"/,
    /claude-haiku-4-5/,
  ]) && hasAll(personalAssistantAdapter, [
    /createHandler/,
    /createHandler\("\/api\/my\/assistant-chat"\)/,
  // 개인 비서는 브라우저가 보낸 스냅샷만 본다. 서버가 일정 행을 직접 읽는 순간
  // 다른 계정의 행이 프롬프트로 새는 경로가 생기므로 그 부재를 계약으로 못 박는다.
  ]) && !/supabaseAdmin\.from\(|schedule_items/.test(personalAssistant),
  `${files.serverIndex}, ${files.sessionGate}, ${files.personalAssistant}, ${files.personalAssistantAdapter}`,
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
    && /CANDIDATE_CADENCE_MINUTES = 6/.test(shoppingChromeWorker)
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
  "N Shopping normalized-keyword overflow stays one collection per cycle and rotates bounded coverage",
  hasAll(shoppingWorkerCycleOverflowMigration, [
    /worker_last_cycle_deferred_at/,
    /case when tracker\.id = seed\.id then 0 else 1 end asc/,
    /tracker\.last_checked_at asc nulls first/,
    /limit 100\s+for update skip locked/,
    /worker_last_cycle_id = current_row\.scheduler_cycle_id/,
    /'deferredCount', v_deferred_count/,
    /'groupSize', v_claim_count \+ v_deferred_count/,
    /'tracker_deferred'/,
    /idx_naver_shopping_scheduler_events_cycle_deferred_once/,
    /mi_audit_naver_shopping_tracker_deferred/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/set\s+(?:current_rank|last_checked_at|next_check_at|last_error|retry_count)\s*=/i
      .test(shoppingWorkerCycleOverflowMigration)
    && /rawClaims\.length > 100/.test(shoppingLocalWorkerHandler),
  `${files.shoppingWorkerCycleOverflowMigration}, ${files.shoppingLocalWorkerHandler}`,
);
check(
  "N Shopping duplicate-identity release pins runtime 1.1.2 fail-closed",
  hasAll(shoppingWorkerRuntime112Migration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.2'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.2'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerRuntime112Migration),
  files.shoppingWorkerRuntime112Migration,
);
check(
  "N Shopping coherent-boundary release pins runtime 1.1.4 fail-closed",
  hasAll(shoppingWorkerRuntime114Migration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.4'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.4'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerRuntime114Migration),
  files.shoppingWorkerRuntime114Migration,
);
check(
  "N Shopping same-page rank preservation release pins runtime 1.1.5 fail-closed",
  hasAll(shoppingWorkerRuntime115Migration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.5'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.5'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerRuntime115Migration),
  files.shoppingWorkerRuntime115Migration,
);
check(
  "N Shopping hardening release pins runtime 1.1.6 fail-closed",
  hasAll(shoppingWorkerRuntime116Migration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.6'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.6'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerRuntime116Migration),
  files.shoppingWorkerRuntime116Migration,
);
check(
  "N Shopping complete Windows dependency release pins runtime 1.1.7 fail-closed",
  hasAll(shoppingWorkerRuntime117Migration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.7'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.7'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerRuntime117Migration),
  files.shoppingWorkerRuntime117Migration,
);
check(
  "N Shopping stable full-window release pins runtime 1.1.8 fail-closed",
  hasAll(shoppingWorkerRuntime118Migration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.8'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.8'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerRuntime118Migration),
  files.shoppingWorkerRuntime118Migration,
);
check(
  "N Shopping prior worker bytes keep runtime 1.1.9 fail-closed",
  hasAll(shoppingWorkerRuntime119Migration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.9'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.9'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /set cadence_mode = 'baseline',[\s\S]+cadence_minutes = 10,[\s\S]+stability_started_at = null,[\s\S]+success_streak = 0/,
    /cadence_mode = case[\s\S]+runtime_version is distinct from trim\(p_runtime_version\)[\s\S]+runtime_fingerprint is distinct from lower\(trim\(p_runtime_fingerprint\)\)[\s\S]+then 'baseline'/,
    /'transient_system_probe_attempts', current_row\.transient_system_probe_attempts/,
    /'candidate_eligible',[\s\S]+current_row\.circuit_state = 'closed'[\s\S]+and processing_count = 0[\s\S]+current_row\.runtime_version = '1\.1\.9'/,
    /for update;[\s\S]+status = 'processing' and processing_until > v_now[\s\S]+status = 'active' and processing_until > v_now[\s\S]+into processing_count;[\s\S]+eligible :=[\s\S]+and processing_count = 0/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerRuntime119Migration),
  files.shoppingWorkerRuntime119Migration,
);
check(
  "N Shopping partial-retry worker bytes pin runtime 1.1.10 fail-closed",
  hasAll(shoppingWorkerRuntime110Migration, [
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.10'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.10'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /set cadence_mode = 'baseline',[\s\S]+cadence_minutes = 10,[\s\S]+stability_started_at = null,[\s\S]+success_streak = 0/,
    /cadence_mode = case[\s\S]+runtime_version is distinct from trim\(p_runtime_version\)[\s\S]+runtime_fingerprint is distinct from lower\(trim\(p_runtime_fingerprint\)\)[\s\S]+then 'baseline'/,
    /'transient_system_probe_attempts', current_row\.transient_system_probe_attempts/,
    /'candidate_eligible',[\s\S]+current_row\.circuit_state = 'closed'[\s\S]+and processing_count = 0[\s\S]+current_row\.runtime_version = '1\.1\.10'/,
    /for update;[\s\S]+status = 'processing' and processing_until > v_now[\s\S]+status = 'active' and processing_until > v_now[\s\S]+into processing_count;[\s\S]+eligible :=[\s\S]+and processing_count = 0/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingWorkerRuntime110Migration),
  files.shoppingWorkerRuntime110Migration,
);
check(
  "N Shopping taxonomy-hardened worker bytes pin runtime 1.1.11 fail-closed",
  hasAll(shoppingWorkerRuntime111Migration, [
    /-- Runtime 1\.1\.11/,
    /mi_report_naver_shopping_worker_progress/,
    /p_runtime_version, ''\)\) <> '1\.1\.11'/,
    /mi_get_naver_shopping_worker_operations/,
    /current_row\.runtime_version = '1\.1\.11'/,
    /last_collection_id ~ '\^pw-chrome-'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /set cadence_mode = 'baseline',[\s\S]+cadence_minutes = 10,[\s\S]+stability_started_at = null,[\s\S]+success_streak = 0/,
    /cadence_mode = case[\s\S]+runtime_version is distinct from trim\(p_runtime_version\)[\s\S]+runtime_fingerprint is distinct from lower\(trim\(p_runtime_fingerprint\)\)[\s\S]+then 'baseline'/,
    /'candidate_eligible',[\s\S]+current_row\.circuit_state = 'closed'[\s\S]+and processing_count = 0[\s\S]+current_row\.runtime_version = '1\.1\.11'/,
    /for update;[\s\S]+status = 'processing' and processing_until > v_now[\s\S]+status = 'active' and processing_until > v_now[\s\S]+into processing_count;[\s\S]+eligible :=[\s\S]+and processing_count = 0/,
    /mi_set_naver_shopping_worker_cadence/,
    /security invoker/,
    /set search_path = ''/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && shoppingWorkerRuntime111Migration.replaceAll("1.1.11", "1.1.10") === shoppingWorkerRuntime110Migration
    && !/security definer/.test(shoppingWorkerRuntime111Migration),
  files.shoppingWorkerRuntime111Migration,
);
check(
  "N Shopping cadence-proof isolation worker bytes pin runtime 1.1.12 fail-closed",
  hasAll(shoppingWorkerRuntime1112Migration, [
    /-- Runtime 1\.1\.12/,
    /p_runtime_version, ''\)\) <> '1\.1\.12'/,
    /current_row\.runtime_version = '1\.1\.12'/,
    /last_collection_id ~ '\^pw-chrome-'/,
    /last_checked_count = 300/,
    /last_source = 'naver_shopping_results_collector'/,
    /set cadence_mode = 'baseline',[\s\S]+cadence_minutes = 10,[\s\S]+stability_started_at = null,[\s\S]+success_streak = 0/,
    /security invoker/,
    /set search_path = ''/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && shoppingWorkerRuntime1112Migration.replaceAll("1.1.12", "1.1.11") === shoppingWorkerRuntime111Migration
    && !/security definer/.test(shoppingWorkerRuntime1112Migration),
  files.shoppingWorkerRuntime1112Migration,
);
check(
  "N Shopping runtime 1.1.13 candidate6 keeps exact identity, idle gate and run provenance",
  hasAll(shoppingWorkerRuntime1113Candidate6Migration, [
    /-- Runtime 1\.1\.13 candidate 6-minute cadence/,
    /create table if not exists public\.naver_shopping_worker_runs/,
    /run_id uuid primary key/,
    /run_trigger text not null/,
    /on conflict \(run_id\) do nothing/,
    /naver_shopping_worker_run_provenance_mismatch/,
    /p_runtime_version, ''\)\) <> '1\.1\.13'/,
    /p_run_trigger text/,
    /cadence_mode = 'candidate' and cadence_minutes = 6/,
    /set cadence_mode = 'candidate', cadence_minutes = 6/,
    /'mode', 'candidate', 'minutes', 6/,
    /grant select, insert on table public\.naver_shopping_worker_runs\s+to service_role/,
    /security invoker/,
    /set search_path = ''/,
  ])
    && (shoppingWorkerRuntime1113Candidate6Migration.match(
      new RegExp(`runtime_fingerprint = '${shoppingWorkerRuntime1113Fingerprint}'`, "g"),
    ) || []).length === 3
    && !/cadence_mode = 'candidate' and cadence_minutes = 8/.test(shoppingWorkerRuntime1113Candidate6Migration)
    && !/'mode', 'candidate', 'minutes', 8/.test(shoppingWorkerRuntime1113Candidate6Migration)
    && !/security definer/.test(shoppingWorkerRuntime1113Candidate6Migration),
  files.shoppingWorkerRuntime1113Candidate6Migration,
);
check(
  "N Shopping runtime 1.1.16 globally enforces exact parent ids and pins the Windows identity",
  hasAll(shoppingStableFiniteWindowMigration, [
    /stable-finite-window-v1/,
    /'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'/,
    /'13327339525'/,
    /'59776958987'/,
    /'finite_window_committed'/,
    /'atomicSuccessEligible'.*'false'/,
    /checked_count between 1 and 299/,
    /set cadence_mode = 'baseline',[\s\S]*cadence_minutes = 10/,
    /revoke insert, update, delete on table public\.naver_rank_snapshots[\s\S]*from public, anon, authenticated/,
  ])
    && shoppingStableFiniteWindowMigration.includes(shoppingWorkerRuntime1114Fingerprint)
    && hasAll(shoppingStableFiniteWindowRuntime1115Migration, [
      /target\.runtime_version is distinct from '1\.1\.14'/,
      /target\.runtime_fingerprint is distinct from '13e801cf18adaea7352d7c78bbe067f969e3fef5e756528335443d3122b2d405'/,
      /set runtime_version = '1\.1\.15'/,
      /runtime_version = '1\.1\.15'/,
      /set cadence_mode = 'baseline',\s*cadence_minutes = 10/,
      /set cadence_mode = 'candidate', cadence_minutes = 6/,
      /security invoker/,
      /set search_path = ''/,
      /from public, anon, authenticated, service_role/,
      /to service_role/,
    ])
    && shoppingStableFiniteWindowRuntime1115Migration.includes(shoppingWorkerRuntime1115Fingerprint)
    && hasAll(shoppingExactParentRelationGuardMigration, [
      /create or replace function mi_internal\.mi_guard_naver_shopping_exact_parent_snapshot\(\)/,
      /trackingRankSource'[\s\S]*'related_catalog'/,
      /relatedCatalogRelationBasis'[\s\S]*'catalog_seller_product_id'/,
      /catalogSellerProductIds'[\s\S]*jsonb_build_array/,
      /create trigger naver_shopping_exact_parent_relation_guard/,
      /security invoker/,
      /set search_path = ''/,
    ])
    && hasAll(shoppingStableFiniteWindowRuntime1116Migration, [
      /target\.runtime_version is distinct from '1\.1\.15'/,
      /target\.runtime_fingerprint is distinct from 'c7941930ccabd1206f19cc9ae5cfcd744f12313974c37d5143ed5f795ec9b46c'/,
      /set runtime_version = '1\.1\.16'/,
      /runtime_version = '1\.1\.16'/,
      /set cadence_mode = 'baseline',\s*cadence_minutes = 10/,
      /set cadence_mode = 'candidate', cadence_minutes = 6/,
      /security invoker/,
      /set search_path = ''/,
      /from public, anon, authenticated, service_role/,
      /to service_role/,
    ])
    && shoppingStableFiniteWindowRuntime1116Migration.includes(
      "570ffc52d411f2ae34e247b77d7fb645d36f4478b624ed56926a6ccc00b6159f",
    )
    && hasAll(shoppingNextDataSchemaDriftRecoveryMigration, [
      /570ffc52d411f2ae34e247b77d7fb645d36f4478b624ed56926a6ccc00b6159f/,
      /8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1/,
      /naver_next_data_schema_drift:compositelist_list_\[0-9\]\+_type/,
      /last_checked_count is distinct from 300/,
      /circuit_state = 'closed'/,
      /runtime_fingerprint = null/,
    ])
    && hasAll(shoppingSupersavingCompositeRecoveryMigration, [
      /8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1/,
      /\^collecting:naver_next_data_schema_drift:compositelist_list_\[0-9\]\+_type_supersaving\$/,
      /\^naver_next_data_schema_drift:compositelist_list_\[0-9\]\+_type_supersaving\$/,
      /last_checked_count is distinct from 300/,
      /set cadence_mode = 'baseline'/,
      /circuit_state = 'closed'/,
      /runtime_fingerprint = null/,
      /post_row\.scheduler_cycle_cursor_tracker_id is distinct from prior_row\.scheduler_cycle_cursor_tracker_id/,
      /post_row\.last_collection_id is distinct from prior_row\.last_collection_id/,
      /post_row\.last_failure_code is distinct from prior_row\.last_failure_code/,
    ])
    && shoppingSupersavingCompositeRecoveryMigration.includes(shoppingWorkerRuntime1116Fingerprint)
    && !/update public\.naver_rank_trackers|update public\.naver_shopping_rank_lookup_jobs|insert into public\.naver_shopping_worker_events|create or replace function public\./iu.test(
      shoppingSupersavingCompositeRecoveryMigration,
    )
    && hasAll(shoppingExactParentGuardRuntimeRecoveryMigration, [
      /create or replace function mi_internal\.mi_guard_naver_shopping_exact_parent_snapshot\(\)/,
      /trackingRankSource'[\s\S]*'related_catalog'/,
      /relatedCatalogRelationBasis'[\s\S]*'catalog_seller_product_id'/,
      /catalogSellerProductIds'[\s\S]*jsonb_build_array/,
      /selected_catalog_id is distinct from related_catalog_id/,
      /pg_catalog\.strpos\(function_definition, 'pg_catalog\.nullif'\)/,
      /pg_catalog\.strpos\(function_definition, 'pg_catalog\.coalesce'\)/,
      /trigger_row\.tgfoid = pg_catalog\.to_regprocedure/,
      /trigger_row\.tgtype = 23/,
      /trigger_row\.tgenabled <> 'D'/,
      /exact_trigger_count <> 1/,
      /security invoker/,
      /set search_path = ''/,
    ])
    && !/pg_catalog\.(?:nullif|coalesce)\s*\(/iu.test(
      shoppingExactParentGuardRuntimeRecoveryMigration,
    )
    && !/drop\s+trigger|create\s+trigger|update\s+public\.|insert\s+into\s+public\.|delete\s+from\s+public\./iu.test(
      shoppingExactParentGuardRuntimeRecoveryMigration,
    )
    && shoppingCandidatePerformanceAudit.includes(
      `export const N30_TARGET_RUNTIME_VERSION = "1.1.16";`,
    )
    && shoppingCandidatePerformanceAudit.includes(shoppingWorkerRuntime1116Fingerprint)
    && !shoppingStableFiniteWindowMigration.includes("__N30_RUNTIME_1_1_14_FINGERPRINT__")
    && !shoppingStableFiniteWindowRuntime1116Migration.includes("__N30_RUNTIME_1_1_16_FINGERPRINT__")
    && !shoppingNextDataSchemaDriftRecoveryMigration.includes("__N30_RUNTIME_1_1_16_FINGERPRINT__")
    && !shoppingSupersavingCompositeRecoveryMigration.includes("__N30_RUNTIME_1_1_16_FINGERPRINT__"),
  `${files.shoppingStableFiniteWindowMigration}, ${files.shoppingStableFiniteWindowRuntime1115Migration}, ${files.shoppingExactParentRelationGuardMigration}, ${files.shoppingStableFiniteWindowRuntime1116Migration}, ${files.shoppingNextDataSchemaDriftRecoveryMigration}, ${files.shoppingSupersavingCompositeRecoveryMigration}, ${files.shoppingExactParentGuardRuntimeRecoveryMigration}`,
);
check(
  "N Shopping prior runtime 1.1.11 exact candidate gate remains unchanged",
  shoppingWorkerCandidateExactIdentityMigration
    .replaceAll("1.1.12", "1.1.11")
    .replaceAll(
      "862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e",
      "6461e835e840ff873711f38a223ab1a7a06b3e2945822a92cce49e50a295cf00",
    ) === shoppingWorkerCandidate111ExactIdentityMigration,
  files.shoppingWorkerCandidate111ExactIdentityMigration,
);
check(
  "N Shopping candidate cadence requires the exact runtime identity and a completely idle lane",
  hasAll(shoppingWorkerCandidateExactIdentityMigration, [
    /-- Runtime 1\.1\.12 exact candidate gate/,
    /create or replace function public\.mi_get_naver_shopping_worker_operations\(\)/,
    /create or replace function public\.mi_set_naver_shopping_worker_cadence\(/,
    /current_row\.circuit_state = 'closed'/,
    /current_row\.circuit_reason is null/,
    /processing_count = 0/,
    /current_row\.lease_worker_id is null/,
    /current_row\.lease_token is null/,
    /current_row\.lease_until is null/,
    /current_row\.run_id is null/,
    /current_row\.current_stage is null/,
    /current_row\.current_page = 0/,
    /current_row\.current_job_kind is null/,
    /current_row\.current_tracker_id is null/,
    /current_row\.current_job_started_at is null/,
    /current_row\.probe_started_at is null/,
    /current_row\.probe_tracker_id is null/,
    /current_row\.cooldown_until is null/,
    /current_row\.primary_worker_id = 'windows-desktop-primary'/,
    /current_row\.primary_seen_at > v_now - interval '3 minutes'/,
    /current_row\.cadence_mode = 'baseline'/,
    /current_row\.cadence_minutes = 10/,
    /current_row\.stability_started_at is not null/,
    /current_row\.stability_started_at <= v_now - interval '24 hours'/,
    /current_row\.success_streak >= 6/,
    /current_row\.last_success_at is not null/,
    /current_row\.last_success_at > v_now - interval '15 minutes'/,
    /current_row\.runtime_version = '1\.1\.12'/,
    /current_row\.runtime_fingerprint = '862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e'/,
    /current_row\.last_collection_id ~ '\^pw-chrome-'/,
    /current_row\.last_checked_count = 300/,
    /current_row\.last_source = 'naver_shopping_results_collector'/,
    /where lane_key = 'global'\s+for update;[\s\S]+into processing_count;[\s\S]+eligible :=/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && (shoppingWorkerCandidateExactIdentityMigration.match(/create or replace function public\./g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/security invoker/g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/set search_path = ''/g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/runtime_fingerprint = '862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e'/g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/primary_worker_id = 'windows-desktop-primary'/g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/primary_seen_at > v_now - interval '3 minutes'/g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.cadence_mode = 'baseline'/g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.cadence_minutes = 10/g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.last_success_at is not null/g) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.last_success_at > v_now - interval '15 minutes'/g) || []).length === 2
    && !/stability_started_at\s*=/.test(shoppingWorkerCandidateExactIdentityMigration)
    && !/success_streak\s*=/.test(shoppingWorkerCandidateExactIdentityMigration)
    && !/security definer/.test(shoppingWorkerCandidateExactIdentityMigration),
  files.shoppingWorkerCandidateExactIdentityMigration,
);
check(
  "N Shopping atomic success proof is ledger-backed, snapshot-backed and idempotent under lock",
  hasAll(shoppingAtomicSuccessProofHardeningMigration, [
    /-- N Shopping atomic success proof hardening/,
    /into representative_commit_count[\s\S]+committed\.event_type = 'tracker_committed'[\s\S]+committed\.run_id = p_run_id[\s\S]+committed\.worker_id = current_row\.lease_worker_id[\s\S]+committed\.tracker_id = p_tracker_id[\s\S]+committed\.collection_id = normalized_collection_id[\s\S]+committed\.checked_count = 300[\s\S]+committed\.details ->> 'source' = 'naver_shopping_results_collector'[\s\S]+representative_commit_count <> 1/,
    /select committed\.claim_id, committed\.group_fingerprint\s+into group_claim_id, expected_group_fingerprint[\s\S]+committed\.event_type = 'tracker_committed'[\s\S]+committed\.run_id = p_run_id[\s\S]+committed\.worker_id = current_row\.lease_worker_id[\s\S]+committed\.tracker_id = p_tracker_id[\s\S]+committed\.collection_id = normalized_collection_id[\s\S]+committed\.checked_count = 300[\s\S]+committed\.details ->> 'source' = 'naver_shopping_results_collector'/,
    /current_row\.current_job_kind is distinct from 'tracker'[\s\S]+current_row\.current_tracker_id is distinct from p_tracker_id[\s\S]+atomic_current_job_mismatch/,
    /event\.claim_id = group_claim_id[\s\S]+failed\.claim_id = group_claim_id[\s\S]+claimed\.claim_id = group_claim_id[\s\S]+claimed\.claim_id = group_claim_id[\s\S]+committed\.claim_id = group_claim_id[\s\S]+committed\.claim_id = group_claim_id[\s\S]+claimed\.claim_id = group_claim_id[\s\S]+committed\.claim_id = claimed\.claim_id/,
    /event\.event_type = 'group_claimed'[\s\S]+group_claim_count <> 1/,
    /failed\.event_type = 'job_failed'[\s\S]+atomic_run_failed/,
    /claimed\.event_type = 'tracker_claimed'[\s\S]+tracker_claim_count < 1/,
    /committed\.event_type = 'tracker_committed'[\s\S]+committed_count <> tracker_claim_count/,
    /from public\.naver_rank_snapshots as snapshot[\s\S]+snapshot\.checked_count = 300[\s\S]+snapshot\.source = 'naver_shopping_results_collector'/,
    /snapshot\.matched = false or snapshot\.item -> 'isOrganic' = 'true'::jsonb/,
    /snapshot\.item -> 'adExcluded' = 'true'::jsonb/,
    /snapshot\.item ->> 'rankPolicy' = 'organic_only'/,
    /snapshot\.item ->> 'rankEvidence' = 'naver_shopping_organic_list'/,
    /top_item -> 'isOrganic' is distinct from 'true'::jsonb[\s\S]+top_item -> 'isAd' is distinct from 'false'::jsonb/,
    /if current_row\.last_collection_id = normalized_collection_id then[\s\S]+'alreadyRecorded', true[\s\S]+end if;[\s\S]+next_success_streak :=/,
    /'alreadyRecorded', false/,
    /revoke all on function public\.mi_record_naver_shopping_worker_success\([^)]+\)\s+from public, anon, authenticated, service_role;/,
    /grant execute on function public\.mi_record_naver_shopping_worker_success\([^)]+\)\s+to service_role;/,
    /revoke all on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s+from public, anon, authenticated, service_role;/,
    /grant execute on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s+to service_role;/,
  ])
    && (shoppingAtomicSuccessProofHardeningMigration.match(/security invoker/g) || []).length === 2
    && (shoppingAtomicSuccessProofHardeningMigration.match(/set search_path = ''/g) || []).length === 2
    && (shoppingAtomicSuccessProofHardeningMigration.match(/v_now timestamptz;/g) || []).length === 2
    && (shoppingAtomicSuccessProofHardeningMigration.match(/for update;\s+v_now := clock_timestamp\(\);/g) || []).length === 2
    && (shoppingAtomicSuccessProofHardeningMigration.match(/grant execute on function public\./g) || []).length === 2
    && !/v_now timestamptz\s*:=/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && !/grant execute on function public\.[\s\S]+to (?:public|anon|authenticated)/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && !/security definer/u.test(shoppingAtomicSuccessProofHardeningMigration),
  files.shoppingAtomicSuccessProofHardeningMigration,
);
check(
  "N Shopping cadence response succeeds only for the exact requested mode and minutes",
  hasAll(productTrackers, [
    /if \(result\?\.accepted !== true\) return false;/,
    /if \(result\?\.activated !== true\) return false;/,
    /if \(mode === "candidate"\) return result\?\.mode === "candidate" && result\?\.minutes === 6;/,
    /if \(mode === "baseline"\) return result\?\.mode === "baseline" && result\?\.minutes === 10;/,
    /shoppingWorkerControlAccepted\(action, result, cadenceMode\)/,
    /rejected \? 409 : 200/,
  ]),
  files.productTrackers,
);
check(
  "N Shopping ledger stores only the verified stable proof protocol version",
  hasAll(shoppingStableProofLedgerMigration, [
    /mi_internal\.mi_audit_naver_shopping_snapshot_commit/,
    /crossPageProofVersion/,
    /stable-full-window-v1/,
    /snapshot\.checked_count = 300/,
    /security definer/,
    /from public, anon, authenticated, service_role/,
  ])
    && !/(?:captureIds|passDigests|collisionDigest)/.test(shoppingStableProofLedgerMigration),
  files.shoppingStableProofLedgerMigration,
);
check(
  "N Shopping stable proof mismatch stays tracker-scoped with a 30-minute retry",
  hasAll(shoppingStableProofQuarantineMigration, [
    /provider_stable_window_unproven/,
    /normalized_scope = 'tracker'/,
    /then v_now \+ interval '30 minutes'/,
    /mi_release_naver_shopping_worker_lane/,
    /auto_navigation_recovered/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingStableProofQuarantineMigration),
  files.shoppingStableProofQuarantineMigration,
);
check(
  "N Shopping navigation circuit makes one ordered automatic half-open attempt",
  hasAll(shoppingAutoNavigationHalfOpenMigration, [
    /mi_claim_naver_shopping_worker_lane/,
    /normalized_worker_role = 'primary'/,
    /circuit_reason = 'navigating:naver_page_navigation_failed'/,
    /circuit_opened_at <= v_now - interval '10 minutes'/,
    /circuit_state = 'half_open'/,
    /circuit_reason = 'auto_navigation_probe'/,
    /probe_tracker_id = null/,
    /'autoRecovery', current_row\.circuit_reason = 'auto_navigation_probe'/,
    /mi_record_naver_shopping_worker_success/,
    /p_checked_count is distinct from 300/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingAutoNavigationHalfOpenMigration)
    && !/(?:next_check_at|scheduler_cycle_cursor_\w+)\s*=/i.test(shoppingAutoNavigationHalfOpenMigration),
  files.shoppingAutoNavigationHalfOpenMigration,
);
check(
  "N Shopping tracker-scoped half-open failure releases only the recovered navigation circuit",
  hasAll(shoppingAutoNavigationTrackerFailureRecoveryMigration, [
    /mi_release_naver_shopping_worker_lane/,
    /circuit_state = 'half_open'/,
    /circuit_reason = 'auto_navigation_probe'/,
    /current_stage = 'failed'/,
    /provider_duplicate_identity/,
    /provider_partial_window/,
    /when auto_navigation_recovered then 'closed'/,
    /when current_row\.circuit_state = 'half_open' then 'open'/,
    /circuit_reason = 'probe_incomplete'/,
    /primary_seen_at > clock_timestamp\(\) - interval '5 minutes'/,
    /last_failure_at > clock_timestamp\(\) - interval '1 day'/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingAutoNavigationTrackerFailureRecoveryMigration)
    && !/(?:next_check_at|worker_quarantined_until|scheduler_cycle_cursor_\w+|worker_last_cycle_id)\s*=/i.test(shoppingAutoNavigationTrackerFailureRecoveryMigration),
  files.shoppingAutoNavigationTrackerFailureRecoveryMigration,
);
check(
  "N Shopping navigation probe terminal states retry only the typed navigation failure",
  hasAll(shoppingProbeIncompleteAutoRecoveryMigration, [
    /mi_claim_naver_shopping_worker_lane/,
    /normalized_worker_role = 'primary'/,
    /'probe_incomplete'/,
    /'probe_interrupted'/,
    /last_failure_code/,
    /= 'naver_page_navigation_failed'/,
    /circuit_opened_at <= v_now - interval '10 minutes'/,
    /circuit_reason = 'auto_navigation_probe'/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingProbeIncompleteAutoRecoveryMigration)
    && !/(?:next_check_at|worker_quarantined_until|scheduler_cycle_cursor_\w+|worker_last_cycle_id)\s*=/i.test(shoppingProbeIncompleteAutoRecoveryMigration),
  files.shoppingProbeIncompleteAutoRecoveryMigration,
);
check(
  "N Shopping transient system circuit recovery is exact, quiet and bounded",
  hasAll(shoppingTransientSystemRecoveryMigration, [
    /transient_system_probe_attempts integer not null default 0/,
    /check \(transient_system_probe_attempts between 0 and 2\)/,
    /normalized_worker_role = 'primary'/,
    /transient_failure_code in \([\s\S]*'native_host_response_timeout'[\s\S]*'provider_deadline_exceeded'[\s\S]*\)/,
    /current_row\.transient_system_probe_attempts < 2/,
    /circuit_opened_at <= v_now - interval '30 minutes'/,
    /circuit_reason = 'auto_transient_system_probe'/,
    /p_checked_count is distinct from 300/,
    /transient_system_recovered/,
    /force row level security/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingTransientSystemRecoveryMigration)
    && shoppingTransientSystemRecoveryTests.includes("transient recovery excludes security, network, generic and integrity failures")
    && String(packageJson.scripts?.test || "").includes("scripts/naver-shopping-transient-system-recovery-migration.test.mjs"),
  `${files.shoppingTransientSystemRecoveryMigration}, ${files.shoppingTransientSystemRecoveryTests}`,
);
check(
  "N Shopping native input-closed retry extends the exact guarded transient allowlist",
  hasAll(shoppingNativeInputClosedHalfOpenMigration, [
    /create or replace function public\.mi_claim_naver_shopping_worker_lane/,
    /if current_row\.circuit_state = 'open'[\s\S]*normalized_worker_role = 'primary'[\s\S]*transient_failure_code in \(\s*'native_host_response_timeout',\s*'provider_deadline_exceeded',\s*'native_host_input_closed'\s*\)[\s\S]*current_row\.transient_system_probe_attempts < 2[\s\S]*circuit_opened_at <= v_now - interval '30 minutes'[\s\S]*update public\.naver_shopping_worker_coordination/,
    /where lane_key = 'global'\s*and circuit_state = 'open'[\s\S]*split_part\(lower\(trim\(coalesce\(last_failure_code, ''\)\)\), ':', 1\) in \(\s*'native_host_response_timeout',\s*'provider_deadline_exceeded',\s*'native_host_input_closed'\s*\)[\s\S]*and transient_system_probe_attempts < 2[\s\S]*and circuit_opened_at <= v_now - interval '30 minutes'[\s\S]*and \(lease_until is null or lease_until <= v_now\)/,
    /transient_system_probe_attempts = least\(2, current_row\.transient_system_probe_attempts \+ 1\)/,
    /circuit_reason = 'auto_transient_system_probe'/,
    /security invoker/,
    /revoke all on function public\.mi_claim_naver_shopping_worker_lane\(text, text, uuid, integer, integer\)[\s\S]*from public, anon, authenticated, service_role;/,
    /grant execute on function public\.mi_claim_naver_shopping_worker_lane\(text, text, uuid, integer, integer\)[\s\S]*to service_role;/,
  ])
    && (shoppingNativeInputClosedHalfOpenMigration.match(/'native_host_input_closed'/g) || []).length === 2
    && !/security definer/.test(shoppingNativeInputClosedHalfOpenMigration)
    && !/(?:update public\.naver_rank_trackers|next_check_at\s*=|worker_quarantined_until\s*=|scheduler_cycle_cursor_\w+\s*=|insert into public\.naver_shopping_worker_wakes)/i.test(shoppingNativeInputClosedHalfOpenMigration),
  files.shoppingNativeInputClosedHalfOpenMigration,
);
check(
  "N Shopping error taxonomy keeps timeouts bounded, security blocked and lookup isolated",
  hasAll(shoppingErrorTaxonomyHardeningMigration, [
    /create or replace function public\.mi_claim_naver_shopping_worker_lane/,
    /transient_failure_code in \(\s*'native_host_response_timeout',\s*'provider_deadline_exceeded',\s*'native_host_input_closed',\s*'naver_page_timeout',\s*'naver_page_script_timeout',\s*'local_worker_commit_unavailable'\s*\)/,
    /normalized_worker_role = 'primary'/,
    /current_row\.transient_system_probe_attempts < 2/,
    /circuit_opened_at <= v_now - interval '30 minutes'/,
    /create or replace function public\.mi_block_naver_shopping_worker_lane/,
    /normalized_error in \(\s*'naver_captcha_detected',\s*'naver_auth_required',\s*'naver_verification_required',\s*'naver_access_blocked',\s*'naver_http_403'\s*\) then 3600/,
    /create or replace function public\.mi_record_naver_shopping_worker_failure/,
    /normalized_scope not in \('system', 'tracker', 'security', 'lookup'\)/,
    /normalized_scope = 'lookup' and p_tracker_id is not null/,
    /normalized_scope <> 'lookup' or circuit_state = 'closed'/,
    /if normalized_scope = 'lookup' then[\s\S]*lease_worker_id = null[\s\S]*cadence_mode = 'baseline'[\s\S]*cadence_minutes = 10[\s\S]*stability_started_at = null[\s\S]*success_streak = 0[\s\S]*'laneReleased', true/,
    /create or replace function public\.mi_release_naver_shopping_worker_lane/,
    /transient_system_recovered := current_row\.circuit_state = 'half_open'[\s\S]*split_part\(lower\(trim\(coalesce\(current_row\.last_failure_code, ''\)\)\), ':', 1\) in \([\s\S]*'local_worker_window_not_300'[\s\S]*'local_worker_match_result_incomplete'[\s\S]*\)/,
    /revoke all on function public\.mi_release_naver_shopping_worker_lane\(text, uuid\)[\s\S]*from public, anon, authenticated, service_role;/,
    /grant execute on function public\.mi_release_naver_shopping_worker_lane\(text, uuid\)[\s\S]*to service_role;/,
    /security invoker/,
    /set search_path = ''/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && (shoppingErrorTaxonomyHardeningMigration.match(/'naver_page_timeout'/g) || []).length === 2
    && (shoppingErrorTaxonomyHardeningMigration.match(/'naver_page_script_timeout'/g) || []).length === 2
    && (shoppingErrorTaxonomyHardeningMigration.match(/'local_worker_commit_unavailable'/g) || []).length === 2
    && !/transient_failure_code in \([^)]*(?:naver_access_blocked|naver_http_403)/i.test(shoppingErrorTaxonomyHardeningMigration)
    && !/security definer/.test(shoppingErrorTaxonomyHardeningMigration)
    && shoppingTransientSystemRecoveryTests.includes("typed transient taxonomy extends the exact bounded recovery allowlist twice")
    && shoppingTransientSystemRecoveryTests.includes("two repeated lookup failures release only the lane and preserve a closed zero-streak circuit")
    && shoppingTransientSystemRecoveryTests.includes("access blocked and HTTP 403 stay in a 60-minute security block lane, never half-open")
    && shoppingTransientSystemRecoveryTests.includes("half-open release treats the new tracker-only failures as a recovered transport probe"),
  `${files.shoppingErrorTaxonomyHardeningMigration}, ${files.shoppingTransientSystemRecoveryTests}`,
);
check(
  "N Shopping scheduler ledger is append-only evidence and cannot block tenant writes",
  hasAll(shoppingSchedulerEventLedgerMigration, [
    /create schema if not exists mi_internal authorization postgres/,
    /revoke all on schema mi_internal from public, anon, authenticated, service_role/,
    /alter table public\.naver_shopping_scheduler_events force row level security/,
    /grant select on table public\.naver_shopping_scheduler_events\s+to service_role/,
    /security definer/,
    /set search_path = ''/,
    /'new_after_start'/,
    /'fullCycleEvidenceStartsWithNextCycle', true/,
    /on conflict do nothing/,
  ])
    && !/grant execute on function (?:public|mi_internal)\.mi_audit_/i.test(shoppingSchedulerEventLedgerMigration)
    && !/create unique index[^;]*scheduled_(?:group|tracker)/i.test(shoppingSchedulerEventLedgerMigration),
  files.shoppingSchedulerEventLedgerMigration,
);
check(
  "N Shopping duplicate identity quarantine is capped without changing durable order",
  hasAll(shoppingDuplicateQuarantineMigration, [
    /mi_record_naver_shopping_worker_failure/,
    /split_part\(normalized_error, ':', 1\) = 'provider_duplicate_identity'/,
    /then v_now \+ interval '30 minutes'/,
    /coalesce\(retry_count, 0\) >= 2 then interval '24 hours'/,
    /last_error, ''\)\)\) ~ '\^provider_duplicate_identity\(\?:\:\|\$\)'/,
    /worker_quarantined_until > greatest\(v_now, updated_at \+ interval '30 minutes'\)/,
    /security invoker/,
    /from public, anon, authenticated, service_role/,
    /to service_role/,
  ])
    && !/security definer/.test(shoppingDuplicateQuarantineMigration)
    && !/set\s+(?:sort_order|next_check_at|worker_last_cycle_id|retry_count|current_rank|last_checked_at|scheduler_cycle_cursor)/i
      .test(shoppingDuplicateQuarantineMigration),
  files.shoppingDuplicateQuarantineMigration,
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
    && hasAll(shoppingWindowsExtensionUpdater, [
      /naver-shopping-native-host-core\.mjs/,
      /src\/server\/local-worker-auth\.mjs/,
      /src\/server\/handlers\/naver-shopping-rank\.mjs/,
      /src\/server\/security\.mjs/,
      /src\/server\/naver-shopping\/source-status\.mjs/,
      /src\/server\/naver-shopping\/provider-runtime\.mjs/,
      /src\/server\/naver-shopping\/mobile-top-fallback\.mjs/,
      /tools\/naver-shopping-rank-collector\/src\/provider\.mjs/,
      /tools\/naver-shopping-rank-collector\/src\/contract\.mjs/,
      /native_host_core_download_empty/,
      /collector_provider_download_empty/,
      /collector_contract_download_empty/,
      /native_host_core_javascript_invalid/,
      /collector_provider_javascript_invalid/,
      /collector_contract_javascript_invalid/,
      /Copy-Item -LiteralPath \$stagedNativeHostCore -Destination \$nativeHostCorePath -Force/,
      /Copy-Item -LiteralPath \$stagedCollectorProvider -Destination \$collectorProviderPath -Force/,
      /Copy-Item -LiteralPath \$stagedCollectorContract -Destination \$collectorContractPath -Force/,
      /native_host_core_sha256=/,
      /collector_provider_sha256=/,
      /collector_contract_sha256=/,
      /HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\\$hostName/,
      /\$nativeManifestNeedsRepair = -not/,
      /Write-Utf8NoBom -Path \$nativeManifestPath/,
      /native_host_manifest_repair_failed/,
      /native_host_manifest_path_mismatch/,
      /native_host_manifest_origin_mismatch/,
      /Set-Item -Path \$nativeRegistryPath -Value \$nativeManifestPath/,
      /native_host_registry_mismatch/,
      /native_host_registry_synced=true/,
      /\$ExpectedVersion`n\$serviceWorkerHash`n\$nativeHostHash`n\$nativeHostCoreHash`n\$localWorkerHash`n\$localWorkerAuthHash`n\$localWorkerContractHash`n\$shoppingRankHandlerHash`n\$securityHash`n\$sourceStatusHash`n\$providerRuntimeHash`n\$mobileTopFallbackHash`n\$collectorProviderHash`n\$collectorContractHash/,
    ])
    && [
      "native_host_core_javascript_invalid",
      "local_worker_auth_javascript_invalid",
      "shopping_rank_handler_javascript_invalid",
      "security_runtime_javascript_invalid",
      "source_status_javascript_invalid",
      "provider_runtime_javascript_invalid",
      "mobile_top_fallback_javascript_invalid",
      "collector_provider_javascript_invalid",
      "collector_contract_javascript_invalid",
    ].every((code) => shoppingWindowsExtensionUpdater.indexOf(code) >= 0
      && shoppingWindowsExtensionUpdater.indexOf(code) < shoppingWindowsExtensionUpdater.indexOf("Get-Process chrome"))
    && hasAll(shoppingNativeHost, [
      /sha256File\(new URL\("\.\/naver-shopping-native-host-core\.mjs"/,
      /sha256File\(new URL\("\.\.\/src\/server\/local-worker-auth\.mjs"/,
      /sha256File\(new URL\("\.\.\/src\/server\/handlers\/naver-shopping-rank\.mjs"/,
      /sha256File\(new URL\("\.\.\/src\/server\/security\.mjs"/,
      /sha256File\(new URL\("\.\.\/src\/server\/naver-shopping\/source-status\.mjs"/,
      /sha256File\(new URL\("\.\.\/src\/server\/naver-shopping\/provider-runtime\.mjs"/,
      /sha256File\(new URL\("\.\.\/src\/server\/naver-shopping\/mobile-top-fallback\.mjs"/,
      /sha256File\(new URL\("\.\.\/tools\/naver-shopping-rank-collector\/src\/provider\.mjs"/,
      /sha256File\(new URL\("\.\.\/tools\/naver-shopping-rank-collector\/src\/contract\.mjs"/,
    ])
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
      /\$sameChromeRunning = @\(\$sessionChromeProcesses/,
      /if \(\$sameChromeRunning\)[\s\S]{0,300}"--no-startup-window"/,
      /chrome_profile_handoff profile=/,
      /chrome_ready profile=/,
    ])
    && !/remote-debugging|no-sandbox|user-data-dir/iu.test(shoppingWindowsChromeScheduler),
  `${files.shoppingWindowsHostInstaller}, ${files.shoppingWindowsExtensionUpdater}, ${files.shoppingWindowsHostLauncher}, ${files.shoppingWindowsChromeScheduler}, ${files.shoppingNativeHost}`,
);
check(
  "N Shopping website wakes the development Chrome profile within one minute and runs one job",
  shoppingChromeManifest.version === "1.1.16"
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
    && /const EXPECTED_RUNTIME_VERSION = "1\.1\.16";/.test(shoppingLocalWorker)
    && /const EXPECTED_WORKER_RUNTIME_VERSION = "1\.1\.16";/.test(shoppingLocalWorkerHandler)
    && /const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "1\.1\.16";/.test(productTrackers)
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
    && /async function initializeWorker\(\)[\s\S]*?extensionRuntimeIdentity\(\)[\s\S]*?INITIALIZATION_SAFE_STATUSES\.has\(storedStatus\)[\s\S]*?markCandidateCadenceResetPending\(runtimeIdentity\)[\s\S]*?storedStatus === "running"[\s\S]*?saveStatus\("failed", "native_host_interrupted"\)[\s\S]*?configureAlarms\(\)[\s\S]*?await removeLegacyControllerTabs\(\)/.test(shoppingChromeWorker)
    && /async function requestWorkerRun\(trigger\)[\s\S]*?await initializationPromise/.test(shoppingChromeWorker)
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
    && /chrome_profile_handoff profile=/.test(shoppingWindowsChromeScheduler)
    && /if \(\$sameChromeRunning\)[\s\S]{0,300}"--no-startup-window"/.test(shoppingWindowsChromeScheduler)
    && /RANK_LOOKUP_EXPIRED/.test(shoppingRankLookupJobs)
    && /RANK_LOOKUP_WORKER_STALLED/.test(shoppingRankLookupJobs)
    && /pending: false/.test(shoppingRankLookupJobs)
    && /chrome\.tabs\.create\(\{ url, active: false \}\)/.test(shoppingChromeWorker)
    && /WHOLE_SITE_QUEUE_TRIGGERS = new Set\(\["manual", "rank-catch-up"\]\)/.test(shoppingNativeHost)
    && /writeMessage\(\{ type: "ready", collectionProtocol: COLLECTION_PROTOCOL \}\)/.test(shoppingNativeHost)
    && /readyAck = await nextMessage\(30_000\)/.test(shoppingNativeHost)
    && /port\.postMessage\(nativeReadyAcknowledgement\(message\)\)/.test(shoppingChromeWorker)
    && /return \{ action: "ready_ack", collectionProtocol: COLLECTION_PROTOCOL \}/.test(shoppingChromeWorker)
    && /runTrigger: trigger/.test(shoppingNativeHost)
    && /queueAllTrackers: WHOLE_SITE_QUEUE_TRIGGERS\.has\(trigger\)/.test(shoppingNativeHost)
    && /await writeTerminalMessage\(\{ type: "summary", summary \}\)/.test(shoppingNativeHost)
    && /process\.stdin\.destroy\(\)/.test(shoppingNativeHost)
    && shoppingWindowsHostLauncher.indexOf("child.WaitForExit();")
      < shoppingWindowsHostLauncher.indexOf("singleInstance.ReleaseMutex();")
    && shoppingWindowsHostLauncher.indexOf("singleInstance.ReleaseMutex();")
      < shoppingWindowsHostLauncher.indexOf("outputRelay.Join(5000)")
    && /requireWakeSignal: trigger === "rank-remote"/.test(shoppingNativeHost)
    && /CHROME_RUN_TRIGGERS = new Set/.test(shoppingNativeHost)
    && /MI_NAVER_SHOPPING_RUN_TRIGGER/.test(shoppingLocalWorker)
    && /p_run_trigger: control\.runTrigger/.test(shoppingLocalWorkerHandler)
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
  "N Shopping preserves absolute slots and accepts cross-page overlap only with two stable full-window proofs",
  hasAll(shoppingCollectorProvider, [
    /const collisionKind = origin\?\.pageIndex === pageIndex/,
    /if \(collisionKind !== "duplicate_row" && !preserveStableCrossPage\)/,
    /provider_duplicate_identity/,
    /buildStableFullWindowProof/,
    /stableFullWindowEvidence/,
  ])
    && hasAll(shoppingCollectorContract, [
      /const NAVER_SHOPPING_PAGE_SIZE = 40/,
      /STABLE_FULL_WINDOW_PROOF_VERSION = "stable-full-window-v1"/,
      /stableWindowDigest/,
      /stableCollisionDigest/,
      /const identityOrigins = new Map\(\)/,
      /Math\.ceil\(originRank \/ NAVER_SHOPPING_PAGE_SIZE\)/,
      /Math\.ceil\(item\.organicRank \/ NAVER_SHOPPING_PAGE_SIZE\)/,
      /duplicate_identity/,
    ])
    && hasAll(shoppingRank, [
      /const identityOrigins = new Map\(\)/,
      /Math\.ceil\(originRank \/ NAVER_SHOPPING_PAGE_SIZE\)/,
      /crossPageDuplicate/,
      /trustedStableCrossPageProof/,
      /stableWindowDigest/,
      /stableCollisionDigest/,
    ])
    && hasAll(shoppingNativeHostCore, [
      /PAGE_NAVIGATION_BUDGET = 16/,
      /stableProofPass: 2/,
      /buildStableFullWindowProof/,
    ])
    && hasAll(shoppingLocalWorker, [
      /const TRACKER_ISOLATED_FAILURE_CODES = new Set/,
      /"provider_duplicate_identity"/,
      /"provider_partial_window"/,
      /detail\.replace\("\/", "_"\)/,
    ]),
  `${files.shoppingCollectorProvider}, ${files.shoppingCollectorContract}, ${files.shoppingRank}, ${files.shoppingNativeHostCore}, ${files.shoppingLocalWorker}`,
);
check(
  "N Shopping bounds submit payloads and isolates malformed rows without stalling the lane",
  hasAll(shoppingLocalWorkerContract, [
    /LOCAL_WORKER_BODY_MAX_BYTES = 4 \* 1024 \* 1024/,
    /LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS \* 1000/,
  ])
    && hasAll(shoppingLocalWorkerAuth, [
      /LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS = 5 \* 60/,
    ])
    && hasAll(shoppingLocalWorker, [
      /"provider_row_invalid"/,
      /"provider_row_title_missing"/,
      /"provider_row_identity_missing"/,
      /action: "reconcile-submit"/,
      /submitClaimOutcome\(partial, job/,
      /explicitOutcome\.uncommittedClaims/,
      /processedCount !== job\.claims\.length/,
    ])
    && !/job\.claims\.slice\(processedCount\)/.test(shoppingLocalWorker)
    && hasAll(shoppingLocalWorkerHandler, [
      /body\.action === "reconcile-submit"/,
      /\.from\("naver_rank_snapshots"\)/,
      /claimResults/,
    ])
    && hasAll(shoppingNativeHostCore, [
      /native_host_request_id_mismatch/,
    ])
    && hasAll(serverIndex, [
      /LOCAL_WORKER_BODY_MAX_BYTES/,
    ]),
  `${files.shoppingLocalWorkerContract}, ${files.shoppingLocalWorkerAuth}, ${files.shoppingLocalWorker}, ${files.shoppingNativeHostCore}, ${files.serverIndex}`,
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
    && /camera=\(\)/.test(globalSecurityHeaders["permissions-policy"] || "")
    && /microphone=\(self\)/.test(globalSecurityHeaders["permissions-policy"] || "")
    && /geolocation=\(\)/.test(globalSecurityHeaders["permissions-policy"] || ""),
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
