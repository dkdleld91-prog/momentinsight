import fs from "node:fs";
import crypto from "node:crypto";
import { shoppingCollectorFailureStatus } from "../src/server/naver-shopping/source-status.mjs";
import { shoppingProviderRuntimeConfig } from "../src/server/naver-shopping/provider-runtime.mjs";
import { calculateN30RuntimeFingerprint } from "./naver-shopping-runtime-fingerprint.mjs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function exists(path) {
  return fs.existsSync(path);
}

function uniqueMatches(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
}

function orderedIncludes(source, values) {
  let cursor = 0;
  return values.every((value) => {
    const next = source.indexOf(value, cursor);
    if (next === -1) return false;
    cursor = next + value.length;
    return true;
  });
}

function normalizeIdentityText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "");
}

function assertCheck(condition, label) {
  if (!condition) {
    throw new Error(`Release baseline failed: ${label}`);
  }
}

function functionBody(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) return "";
  return source.slice(start, end);
}

const adminSource = read("src/pages/admin.html");
const clientSource = read("src/pages/client.html");
const homeSource = read("src/pages/home.html");
const privacySource = read("src/pages/privacy.html");
const personalCalendarStyleSource = read("public/mi-personal-calendar.css");
const homeDevelopmentNoticeStyleSource = functionBody(homeSource, "    #mi-home .mi-dev-banner {", "    #mi-home .mi-dev-banner.is-hidden {");
const homeDevelopmentNoticeMarkupSource = functionBody(homeSource, '  <aside class="mi-dev-banner"', "  </aside>");
const homeDevelopmentNoticeScriptSource = functionBody(homeSource, "    (function () {", "    })();");
const clientLogoutSource = functionBody(clientSource, "async function logoutClient() {", "async function unlockWithCode(");
const adminLogoutSource = functionBody(adminSource, "async function logoutAdmin() {", 'root.querySelectorAll("[data-admin-logout]")');
const clientUnlockSource = functionBody(clientSource, "async function unlockWithCode(", "function requireCodeEntry(");
const clientSessionRestorePreparationSource = functionBody(clientSource, "function prepareClientSessionRestore() {", "var views =");
const clientBootSource = functionBody(clientSource, "var state = readState();", "var initial =");
const clientAsyncResetSource = functionBody(clientSource, "function resetClientAsyncControls(", "function applyClientSession(");
const adminAsyncResetSource = functionBody(adminSource, "function resetAdminAsyncControls(", "function staleAdminSessionPayload(");
const adminSourceRefreshSource = functionBody(adminSource, "async function refreshSourceFileFromServer(", "function handleSourceFileSelected(");
const adminSourceUploadSource = functionBody(adminSource, "function handleSourceFileSelected(", "function resetAdminGuardrails(");
const adminLoginHandlerSource = functionBody(adminSource, 'if (loginButton) {\n        loginButton.addEventListener("click"', "async function restoreAdminLogin(");
const adminAccountRequestSource = functionBody(adminSource, "async function refreshOperationTeamPanel() {", "function reportTypeLabel(");
const adminAccountActionSource = functionBody(adminSource, 'var ownerCreateButton = root.querySelector("[data-owner-team-create]");', 'var codeSaveButton = root.querySelector("[data-admin-code-save]");');
const adminOwnerToolLoaderSource = functionBody(adminSource, "async function loadOwnerTool() {", "function applySecureSession(");
const ownerCodeListRenderSource = functionBody(
  adminSource,
  "function renderOwnerCodeList(payload) {",
  "function renderOperationTeamCodePanel(payload) {",
);
const clientReportDownloadSource = functionBody(clientSource, "async function openReportFile(", "function renderReports(");
const adminSourceDownloadSource = functionBody(adminSource, "async function downloadSourceFile() {", "async function uploadSourceFileToServer(");
const adminPptxDownloadSource = functionBody(adminSource, "async function generateSalesPptxReport(", "var initial = (window.location.hash");
const clientMetaLookupSource = functionBody(clientSource, "async function fetchMetaAds(", "function initRankCheck(");
const adminMetaLookupSource = functionBody(adminSource, "async function fetchMetaAds(", "function initRankCheck(");
const clientRankCheckLookupSource = functionBody(clientSource, "function initRankCheck(", "function initRankTracking(");
const adminRankCheckLookupSource = functionBody(adminSource, "function initRankCheck(", "function initRankTracking(");
const adminRankTrackingSource = functionBody(adminSource, "function initRankTracking(", "function initSeoCheck(");
const adminScreenRouterSource = functionBody(adminSource, "function setScreen(", 'root.addEventListener("click"');
const adminWorkerOperationsLookupSource = functionBody(adminSource, "function rankWorkerOperationsPanel(", "function renderRankWorkerOperations(");
const clientRankTrackingSource = functionBody(clientSource, "function initRankTracking(", "function initPlaceRankTracking(");
const adminPlaceDailyBoardSource = functionBody(adminSource, "function renderPlaceTrackerDailyBoard(", "function placeTrackerActionNote(");
const clientPlaceDailyBoardSource = functionBody(clientSource, "function renderPlaceTrackerDailyBoard(", "function placeTrackerActionNote(");
const adminPlaceTargetMetricSource = functionBody(adminSource, "function placeSnapshotTargetMetric(", "function placeDaySnapshotState(");
const clientPlaceTargetMetricSource = functionBody(clientSource, "function placeSnapshotTargetMetric(", "function placeDaySnapshotState(");
const adminFullRankRefreshSource = functionBody(adminSource, "async function refreshAllRankTrackers(", "function syncKeywordFromMain(");
const clientFullRankRefreshSource = functionBody(clientSource, "async function refreshAllRankTrackers(", "function syncKeywordFromMain(");
const adminFullPlaceRefreshSource = functionBody(adminSource, "async function refreshAllPlaceTrackers(", "function placeRankExportFileName(");
const clientFullPlaceRefreshSource = functionBody(clientSource, "async function refreshAllPlaceTrackers(", "async function loadPlaceTrackers(");
const clientKeywordLookupSource = functionBody(clientSource, "async function runKeywordLookup() {", "if (keywordInput && keywordButton && keywordResult)");
const adminKeywordLookupSource = functionBody(adminSource, "async function runKeywordLookup() {", "if (keywordInput && keywordButton && keywordResult)");
const clientSeoLookupSource = functionBody(clientSource, "async function runSeoCheck() {", "if (keywordInput && seoKeyword)");
const adminSeoLookupSource = functionBody(adminSource, "async function runSeoCheck() {", 'seoKeyword.setAttribute("data-synced-keyword"');
const ownerCreateDesktopStyle = functionBody(
  adminSource,
  "#mi-admin .mi-owner-create-tool {",
  "#mi-admin .mi-owner-hint {",
);
const ownerCreateResponsiveStyle = functionBody(
  adminSource,
  "@media (max-width: 1220px) {",
  "@media (max-width: 900px) {",
);
// 모바일(≤900px) 규칙 묶음. admin.html 은 900px 묶음이 두 개라 앞쪽(대시보드 본문)과
// 맨 뒤(업무 다이얼로그·구글 패널)를 따로 자른다. 못 찾으면 빈 문자열이 되어 검사가 막힌다.
const adminMobileStyle = functionBody(adminSource, "@media (max-width: 900px) {", "@media (max-width: 720px) {");
const adminWorkDialogMobileStyle = functionBody(
  adminSource.slice(adminSource.lastIndexOf("@media (max-width: 900px) {")),
  "@media (max-width: 900px) {",
  "</style>",
);
const clientMobileStyle = functionBody(clientSource, "@media (max-width: 900px) {", "@media (max-width: 520px) {");
const personalCalendarMobileStyle = functionBody(
  personalCalendarStyleSource,
  "@media (max-width: 900px) {",
  "@media (max-width: 760px) {",
);
// 개인정보처리방침의 모바일(≤640px) 묶음. 표(min-width:560px)가 .mi-table-scroll
// 안에서만 밀리게 하려면 그리드 아이템인 .mi-article 의 min-width:auto 를 풀어야 한다.
const privacyMobileStyle = functionBody(privacySource, "@media (max-width: 640px) {", "@media (max-width: 430px) {");
// 네 페이지가 실제로 선언한 viewport 태그 원문. 주석에 적힌 maximum-scale 설명글이
// 검사에 섞이지 않도록, 전체 파일이 아니라 태그 한 줄만 뽑아 본다.
const dashboardViewportMetas = [adminSource, clientSource, homeSource, privacySource]
  .map((source) => (source.match(/<meta name="viewport"[^>]*>/u) || [""])[0]);
const homeFeatureShowcaseSource = functionBody(
  homeSource,
  "<!-- mi-feature-showcase:start -->",
  "<!-- mi-feature-showcase:end -->",
);
const homeSnapshotShowcaseSource = functionBody(
  homeFeatureShowcaseSource,
  'data-mi-showcase-group="snapshot"',
  "</section>",
);
const homeTrackingShowcaseSource = functionBody(
  homeFeatureShowcaseSource,
  'data-mi-showcase-group="tracking"',
  "</section>",
);
const normalizedHomeFeatureShowcase = normalizeIdentityText(homeFeatureShowcaseSource);
const prohibitedHomeShowcaseFragments = [
  "물티슈",
  "브라운물티슈",
  "BROWN",
  "일신한일의료기",
  "헤든프라임",
  "온열찜질기",
  "운열찜질기",
  "배찜질기",
  "구월동 맛집",
  "대동집 인천구월점",
  "호르몬치치 구월점",
  "눈썹칼기",
  "키친타올",
  "휴지도매",
  "51929278883",
  "12149720593",
  "1565776290",
  "2011652806",
].map(normalizeIdentityText);
const sheetTemplateBuilder = read("03_운영시트_템플릿/build_moment_insight_sheet.mjs");
const rankServer = read("src/server/handlers/naver-rank-trackers.mjs");
const rankServerTests = read("src/server/handlers/naver-rank-trackers.test.mjs");
const shoppingRankServer = read("src/server/handlers/naver-shopping-rank.mjs");
const placeRankServer = read("src/server/handlers/naver-place-rank-trackers.mjs");
const placeRankServerTests = read("src/server/handlers/naver-place-rank-trackers.test.mjs");
const placeRankCollector = read("tools/naver-place-rank-collector/src/naver-place-rank.mjs");
const placeRankCollectorTests = read("tools/naver-place-rank-collector/test/naver-place-rank.test.mjs");
const metaAdsServer = read("src/server/handlers/meta-ads.mjs");
const superAdminServer = read("src/server/handlers/super-admin-api.mjs");
const ownerToolServer = read("src/server/handlers/owner-tool-api.mjs");
const adminApiServer = read("src/server/handlers/admin-api.mjs");
const reportCenterServer = read("src/server/handlers/report-center.mjs");
const workItemsServer = read("src/server/handlers/work-items.mjs");
const workItemsTests = read("src/server/handlers/work-items.test.mjs");
const workItemsMigration = read("supabase/migrations/20260730074106_extend_schedule_items_for_work_operations.sql");
const calendarDomain = read("src/server/calendar-domain.mjs");
const calendarHandlerTests = read("src/server/handlers/work-items-calendar.test.mjs");
const calendarMigration = read("supabase/migrations/20260820110000_schedule_calendar_sharing.sql");
const calendarMigrationTests = read("scripts/calendar-sharing-migration.test.mjs");
const calendarNoEndMigration = read("supabase/migrations/20260820152359_schedule_monthly_no_end_mode.sql");
const calendarNoEndMigrationTests = read("scripts/schedule-monthly-no-end-migration.test.mjs");
const calendarUiTests = read("scripts/work-calendar-ui.test.mjs");
const clientApiServer = read("src/server/handlers/client-api.mjs");
const keywordServer = read("src/server/handlers/naver-keyword.mjs");
const integrationStatusServer = read("src/server/handlers/integration-status.mjs");
const rankCronServer = read("src/server/handlers/naver-rank-cron.mjs");
const cronAuthServer = read("src/server/cron-auth.mjs");
const serverIndex = read("src/server/index.mjs");
const sessionGateSource = read("src/server/session-gate.mjs");
const securityServer = read("src/server/security.mjs");
const runtimeEnvCheck = read("scripts/check-runtime-env.mjs");
const shoppingCollectorLiveCheck = read("scripts/check-naver-shopping-collector-live.mjs");
const shoppingRankSourceStatus = read("src/server/naver-shopping/source-status.mjs");
const shoppingProviderRuntime = read("src/server/naver-shopping/provider-runtime.mjs");
const shoppingCollectorContract = read("tools/naver-shopping-rank-collector/src/contract.mjs");
const shoppingCollectorProvider = read("tools/naver-shopping-rank-collector/src/provider.mjs");
const shoppingCollectorPackage = JSON.parse(read("tools/naver-shopping-rank-collector/package.json"));
const shoppingCollectorPackageLock = JSON.parse(read("tools/naver-shopping-rank-collector/package-lock.json"));
const shoppingLocalWorker = read("scripts/naver-shopping-local-worker.mjs");
const shoppingLocalWorkerWrapper = read("scripts/run-naver-shopping-local-worker.sh");
const shoppingLocalWorkerPlist = read("scripts/co.kr.momentinsight.naver-shopping-local-worker.plist.template");
const shoppingLocalWorkerAuth = read("src/server/local-worker-auth.mjs");
const shoppingLocalWorkerHandler = read("src/server/handlers/naver-shopping-local-worker.mjs");
const shoppingLocalWorkerContract = read("src/server/naver-shopping/local-worker-contract.mjs");
const shoppingLocalWorkerMigration = read("supabase/migrations/20260801125959_naver_shopping_local_worker.sql");
const shoppingRankLookupJobs = read("src/server/handlers/naver-shopping-rank-jobs.mjs");
const shoppingRankLookupMigration = read("supabase/migrations/20260802161731_naver_shopping_rank_lookup_jobs.sql");
const shoppingRankLookupGrantMigration = read("supabase/migrations/20260802164548_harden_naver_shopping_rank_lookup_jobs_grants.sql");
const shoppingRankLookupLeasePrecisionMigration = read("supabase/migrations/20260811142000_fix_naver_shopping_lookup_lease_precision.sql");
const shoppingWorkerWake = read("src/server/naver-shopping/worker-wake.mjs");
const shoppingWorkerWakeMigration = read("supabase/migrations/20260809113105_naver_shopping_worker_remote_wake.sql");
const shoppingWorkerLaneMigration = read("supabase/migrations/20260809203826_naver_shopping_global_worker_lane.sql");
const shoppingWorkerControlMigration = read("supabase/migrations/20260811095137_naver_shopping_worker_control_plane.sql");
const shoppingWorkerContinuityMigration = read("supabase/migrations/20260811113622_naver_shopping_queue_continuity.sql");
const shoppingWorkerCycleOverflowMigration = read("supabase/migrations/20260821042129_naver_shopping_cycle_keyword_overflow.sql");
const shoppingWorkerRuntime112Migration = read("supabase/migrations/20260813070000_naver_shopping_runtime_1_1_2.sql");
const shoppingWorkerRuntime113Migration = read("supabase/migrations/20260813072500_naver_shopping_runtime_1_1_3.sql");
const shoppingWorkerRuntime114Migration = read("supabase/migrations/20260813084000_naver_shopping_runtime_1_1_4.sql");
const shoppingWorkerRuntime115Migration = read("supabase/migrations/20260814110000_naver_shopping_runtime_1_1_5.sql");
const shoppingSchedulerEventLedgerMigration = read("supabase/migrations/20260814130826_naver_shopping_scheduler_event_ledger.sql");
const shoppingWorkerRuntime116Migration = read("supabase/migrations/20260814140000_naver_shopping_runtime_1_1_6.sql");
const shoppingWorkerRuntime117Migration = read("supabase/migrations/20260814173500_naver_shopping_runtime_1_1_7.sql");
const shoppingWorkerRuntime118Migration = read("supabase/migrations/20260815014135_naver_shopping_runtime_1_1_8.sql");
const shoppingWorkerRuntime119Migration = read("supabase/migrations/20260821160000_naver_shopping_runtime_1_1_9.sql");
const shoppingWorkerRuntime110Migration = read("supabase/migrations/20260821180000_naver_shopping_runtime_1_1_10.sql");
const shoppingWorkerRuntime111Migration = read("supabase/migrations/20260821180002_naver_shopping_runtime_1_1_11.sql");
const shoppingWorkerRuntime1112Migration = read("supabase/migrations/20260824042226_naver_shopping_runtime_1_1_12.sql");
const shoppingWorkerRuntime1113Candidate6Migration = read("supabase/migrations/20260824165332_naver_shopping_runtime_1_1_13_candidate_6_minute_cadence.sql");
const shoppingStableFiniteWindowMigration = read("supabase/migrations/20260826035440_naver_shopping_stable_finite_window_v1.sql");
const shoppingStableFiniteWindowRuntime1115Migration = read("supabase/migrations/20260826083450_naver_shopping_runtime_1_1_15_stable_finite_third_pass.sql");
const shoppingExactParentRelationGuardMigration = read("supabase/migrations/20260827050000_naver_shopping_exact_parent_relation_guard.sql");
const shoppingStableFiniteWindowRuntime1116Migration = read("supabase/migrations/20260827051000_naver_shopping_runtime_1_1_16_exact_parent.sql");
const shoppingStableFiniteWindowRuntime1117Migration = read("supabase/migrations/20260829140000_naver_shopping_runtime_1_1_17_rank_drift_isolation.sql");
const shoppingStableFiniteWindowRuntime1118Migration = read("supabase/migrations/20260830064426_naver_shopping_runtime_1_1_18_rank_drift_diagnostics.sql");
const shoppingStableRenderedOrderRuntime1119Migration = read("supabase/migrations/20260831014800_naver_shopping_runtime_1_1_19_stable_rendered_order.sql");
const shoppingNextDataSchemaDriftRecoveryMigration = read("supabase/migrations/20260827194500_naver_shopping_next_data_schema_drift_recovery.sql");
const shoppingSupersavingCompositeRecoveryMigration = read("supabase/migrations/20260828025000_naver_shopping_supersaving_composite_recovery.sql");
const shoppingCandidatePerformanceAudit = read("scripts/naver-shopping-candidate-performance-audit.mjs");
const shoppingWorkerCandidate111ExactIdentityMigration = read("supabase/migrations/20260822061741_naver_shopping_candidate_exact_identity_gate.sql");
const shoppingWorkerCandidateExactIdentityMigration = read("supabase/migrations/20260824042232_naver_shopping_runtime_1_1_12_exact_candidate_gate.sql");
const shoppingAtomicSuccessProofHardeningMigration = read("supabase/migrations/20260824133751_naver_shopping_atomic_success_proof_hardening.sql");
const shoppingStableProofLedgerMigration = read("supabase/migrations/20260815015239_naver_shopping_stable_proof_ledger.sql");
const shoppingStableProofQuarantineMigration = read("supabase/migrations/20260815015618_naver_shopping_stable_proof_quarantine.sql");
const shoppingAutoNavigationHalfOpenMigration = read("supabase/migrations/20260814182150_naver_shopping_auto_navigation_half_open.sql");
const shoppingAutoNavigationTrackerFailureRecoveryMigration = read("supabase/migrations/20260814183217_naver_shopping_auto_navigation_tracker_failure_recovery.sql");
const shoppingProbeIncompleteAutoRecoveryMigration = read("supabase/migrations/20260819022043_naver_shopping_probe_incomplete_auto_recovery.sql");
const shoppingTransientSystemRecoveryMigration = read("supabase/migrations/20260821153000_naver_shopping_transient_system_half_open.sql");
const shoppingNativeInputClosedHalfOpenMigration = read("supabase/migrations/20260821170000_naver_shopping_native_input_closed_half_open.sql");
const shoppingErrorTaxonomyHardeningMigration = read("supabase/migrations/20260821180001_naver_shopping_error_taxonomy_hardening.sql");
const shoppingWorkerRuntime1113Fingerprint =
  "cde647ea615e807730cd39b5e10efb4fff5805d4b7181afc0db97315995f98f6";
const shoppingWorkerRuntime1114Fingerprint =
  "13e801cf18adaea7352d7c78bbe067f969e3fef5e756528335443d3122b2d405";
const shoppingWorkerRuntime1115Fingerprint =
  "c7941930ccabd1206f19cc9ae5cfcd744f12313974c37d5143ed5f795ec9b46c";
const shoppingWorkerRuntime1116Fingerprint =
  "9680164f90965609896b72c05b09e67946bc51d1df44c76d0cb5b9e5f0085478";
const shoppingWorkerRuntime1117Fingerprint =
  "1f24b246d5ad3fe6c36607f03521b93d0c645eb0a9e1af43627482c6c66bd4e7";
const shoppingWorkerRuntime1118Fingerprint =
  "65e3f53a81dd71ff33e7a200344d5cb7f50833d182965fbe8e66b698c3eb9d2c";
const shoppingWorkerRuntime1119Fingerprint = calculateN30RuntimeFingerprint({
  repositoryRoot: process.cwd(),
  version: "1.1.19",
}).fingerprint;
const shoppingErrorTaxonomyLookupBranch = shoppingErrorTaxonomyHardeningMigration.match(
  /if normalized_scope = 'lookup' then[\s\S]*?\n  end if;/u,
)?.[0] || "";
const shoppingTransientSystemRecoveryTests = read("scripts/naver-shopping-transient-system-recovery-migration.test.mjs");
const shoppingDuplicateQuarantineMigration = read("supabase/migrations/20260813144700_naver_shopping_duplicate_quarantine_cap.sql");
const shoppingNativeHost = read("scripts/naver-shopping-native-host.mjs");
const shoppingNativeHostCore = read("scripts/naver-shopping-native-host-core.mjs");
const shoppingNativeHostInstaller = read("scripts/install-naver-shopping-chrome-bridge.mjs");
const shoppingWindowsHostInstaller = read("scripts/install-naver-shopping-chrome-bridge-windows.ps1");
const shoppingWindowsExtensionUpdater = read("scripts/windows/update-naver-shopping-chrome-extension.ps1");
const shoppingWindowsHostLauncher = read("scripts/windows/MomentInsightNaverShoppingHost.cs");
const shoppingWindowsChromeScheduler = read("scripts/windows/run-naver-shopping-chrome-scheduler.ps1");
const shoppingNativeHostWrapper = read("scripts/run-naver-shopping-native-host.sh");
const shoppingChromeSchedulerWrapper = read("scripts/run-naver-shopping-chrome-scheduler.sh");
const shoppingChromeManifest = JSON.parse(read("tools/naver-shopping-chrome-extension/manifest.json"));
const shoppingChromeWorker = read("tools/naver-shopping-chrome-extension/service-worker.js");
const shoppingChromePopup = read("tools/naver-shopping-chrome-extension/popup.js");
const shoppingChromePopupHtml = read("tools/naver-shopping-chrome-extension/popup.html");
const rankUnlimitedMigration = read("supabase/migrations/20260626074000_primary_rank_tracker_unlimited.sql");
const accessAuditMigration = read("supabase/migrations/20260628152000_harden_access_and_audit_logs.sql");
const packageConfig = JSON.parse(read("package.json"));
const vercelConfig = JSON.parse(read("vercel.json"));
const protectedFeatureLock = JSON.parse(read("scripts/protected-rank-features.lock.json"));
const rankCronWorkflow = read(".github/workflows/naver-rank-cron.yml");
const rankCronScheduleCheck = read("scripts/check-rank-cron-schedule.mjs");
const rankDownloadFunctions = [adminSource, clientSource].map((source) => functionBody(
  source,
  "async function downloadSelectedRankTrackers",
  "function renderRankHistory",
));
const staticBuildScript = read("scripts/build-vercel-static.mjs");
const rankProcessingLeaseMigration = read("supabase/migrations/20260629025402_naver_rank_tracker_processing_lease.sql");
const rankTrackerGroupsMigration = read("supabase/migrations/20260701090000_naver_rank_tracker_groups.sql");
const placeRankTrackerGroupsMigration = read("supabase/migrations/20260712090000_naver_place_rank_tracker_groups.sql");
const fixedRankScopeMigration = read("supabase/migrations/20260712042029_fix_rank_trackers_to_300.sql");
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

const adminScreens = uniqueMatches(adminSource, /data-mi-admin-screen="([^"]+)"/g);
const clientScreens = uniqueMatches(clientSource, /data-mi-screen="([^"]+)"/g);
const staticAdminProductRankMenu = /<a\b[^>]*data-mi-admin-screen="naver-rank"/u;
const staticClientProductRankMenu = /<a\b[^>]*data-mi-screen="naver-rank"/u;
const staticAdminProductRankView = /<section\b[^>]*data-mi-admin-view="naver-rank"/u;
const staticClientProductRankView = /<section\b[^>]*data-mi-view="naver-rank"/u;
const adminAgencyConnectionViewSource = functionBody(
  adminSource,
  '<section class="mi-view" data-mi-admin-view="agency-code"',
  // UI 고도화 4단계 §1: 활성 계정 전체보기가 대행사 연결 화면 안으로 들어와
  // 더 이상 독립 mi-view 가 아니다. 다음 화면(운영 입력)을 경계로 쓴다.
  '<section class="mi-view mi-operation-input" data-mi-admin-view="excel"',
);
const adminWorkViewSource = functionBody(
  adminSource,
  '<section class="mi-view mi-work-shell" data-mi-admin-view="work"',
  '<section class="mi-view" data-mi-admin-view="client-preview"',
);
const adminWorkScopeSource = functionBody(
  adminSource,
  "function syncWorkOwnerScope() {",
  "function resetWorkOperation() {",
);
const adminPublishViewSource = functionBody(
  adminSource,
  '<section class="mi-view" data-mi-admin-view="publish"',
  '<a class="mi-kakao-floating"',
);
const adminNaverRankTrackingViewSource = functionBody(
  adminSource,
  '<section class="mi-view" data-mi-admin-view="naver-rank-tracking"',
  '<section class="mi-view" data-mi-admin-view="naver-place-rank-tracking"',
);
const staticOwnerDevelopmentMarkup = /<(?:a|div|section)\b[^>]*data-mi-admin-(?:screen|view)="owner-(?:development|utility)"/u;
const staticWorkerOperationsPanel = /<(?:div|section)\b[^>]*data-rank-worker-operations(?:\s|>|=)/u;

const checks = {
  pageSourcesMovedOutOfImwebBundle: exists("src/pages/admin.html")
    && exists("src/pages/client.html")
    && exists("src/pages/home.html")
    && !exists("02_아임웹_적용코드"),
  // 14번째 화면은 운영팀 전용 "내 캘린더"(개인 캘린더, 설계 §6.2)다.
  adminMenuCount: adminScreens.length === 14,
  adminMenuHasCore: ["home", "work", "my-calendar", "client-preview", "agency-code", "excel", "reports", "keyword", "seo-check", "naver-rank-tracking", "naver-place-rank-tracking", "meta-ads", "publish", "related-keywords"].every((screen) => adminScreens.includes(screen))
    && !adminScreens.includes("naver-rank"),
  adminNavigationTaxonomy: orderedIncludes(adminSource, [
    '<p class="mi-nav-title">운영</p>',
    'data-mi-admin-screen="home">운영 홈</a>',
    'data-mi-admin-screen="work">업무 운영</a>',
    'data-mi-admin-screen="my-calendar">내 캘린더</a>',
    'data-mi-admin-screen="client-preview">광고주 미리보기</a>',
    'data-mi-admin-screen="agency-code">대행사 연결</a>',
    'data-mi-admin-screen="excel">운영 입력</a>',
    'data-mi-admin-screen="reports">보고서 관리</a>',
    'data-mi-admin-screen="publish">공개 관리</a>',
    '<p class="mi-nav-title">키워드·SEO</p>',
    'data-mi-admin-screen="keyword">키워드 조회</a>',
    '<p class="mi-nav-title">순위 조회·추적</p>',
    'data-mi-admin-screen="naver-rank-tracking">N 30일 순위</a>',
    'data-mi-admin-screen="naver-place-rank-tracking">N 플레이스 30일 순위</a>',
    // UI 고도화 4단계 §3: 개발 중 화면(SEO 확인 · 메타 광고 조사)은 상시 메뉴에서
    // 내려와 맨 아래 접힌 "실험실 · 개발 중" 그룹으로 모인다. 링크는 그대로 남는다.
    '<div class="mi-nav-group mi-nav-lab" data-mi-nav-lab>',
    '실험실 · 개발 중',
    'data-mi-admin-screen="seo-check">SEO 확인 (개발중)</a>',
    'data-mi-admin-screen="meta-ads">메타 광고 조사 <small>(개발중)</small></a>',
  // 보고서는 생성 시점에 visibility=client_visible 로 저장된다. 승인 단계는
  // 코드에 존재한 적이 없으므로, 화면 문구도 그 사실만 말해야 한다.
  ]) && adminSource.includes('<h1>보고서 관리</h1>')
    && adminSource.includes("보고서는 생성 즉시 광고주에게 공개됩니다.")
    && !adminSource.includes("검수한 보고서만 광고주에게 공개합니다."),
  operationTeamNotLockedToAgencyCode: !adminSource.includes("setOperationTeamNavigation") && !adminSource.includes('target !== "agency-code"'),
  agencyConnectionViewKeepsOnlyAccountManagement: adminAgencyConnectionViewSource.includes("data-owner-team-create")
    && adminAgencyConnectionViewSource.includes("data-team-client-create")
    && adminAgencyConnectionViewSource.includes("data-owner-code-list")
    && !adminAgencyConnectionViewSource.includes("공개 데이터 설정")
    && !adminAgencyConnectionViewSource.includes("현재 연결 상태")
    && !adminAgencyConnectionViewSource.includes("권한 관리 구조")
    && !adminAgencyConnectionViewSource.includes("공개/비공개 기준"),
  ownerAccountOverviewIsAggregateOnly: !adminAgencyConnectionViewSource.includes("mi-owner-step-badge")
    && !adminAgencyConnectionViewSource.includes("선택 01")
    && !adminAgencyConnectionViewSource.includes("필수 02")
    && ownerCodeListRenderSource.includes("'팀 운영 중")
    && ownerCodeListRenderSource.includes("'곳 운영 중")
    && !ownerCodeListRenderSource.includes("activeTeams.slice")
    && !ownerCodeListRenderSource.includes("번 운영팀")
    && !ownerCodeListRenderSource.includes("보고서/원본")
    && adminSource.includes("data-owner-list-open")
    && adminSource.includes("data-owner-revoke-team")
    && adminSource.includes("data-owner-revoke-client"),
  publicDataControlsBelongToPublishView: adminPublishViewSource.includes("공개 데이터 설정")
    && adminPublishViewSource.includes("data-admin-code")
    && adminPublishViewSource.includes("data-admin-client")
    && adminPublishViewSource.includes("data-admin-code-save")
    && adminPublishViewSource.includes("data-admin-internal-note")
    && adminPublishViewSource.includes("data-admin-public-save"),
  adminLoginRoleSelection: adminSource.includes('data-login-mode="client"')
    && adminSource.includes('data-login-mode="operator"')
    && adminSource.includes("운영팀 로그인")
    && adminSource.includes("운영팀 코드 접속"),
  adminLoginRestoresSecureServerSession: !adminSource.includes('localStorage.setItem("miAdminAuthedCode"')
    && adminSource.includes("restoreSecureSession")
    && adminSource.includes('window.location.origin + "/api/session"')
    && adminSource.includes('requestHeaders.set("x-mi-csrf", secureSession.csrfToken)')
    && adminSource.includes("restoreAdminLogin")
    && adminSource.includes('class="mi-login-brand" href="/"'),
  adminLogoutExists: adminSource.includes("data-admin-logout")
    && adminSource.includes("data-admin-current-code")
    && adminSource.includes("logoutAdmin")
    && adminSource.includes("clearAdminAuthCode")
    && adminSource.includes("로그아웃되었습니다. 다른 운영팀 코드를 입력해주세요."),
  ownerModeContextVisible: adminSource.includes("총관리자 모드") && adminSource.includes("운영팀 모드"),
  ownerVatCalculator: ownerToolServer.includes('const OWNER_TOOL_PATH = "/api/owner/tool"')
    && ownerToolServer.includes('request.headers.get("x-mi-session-role") === "owner"')
    && ownerToolServer.includes('request.headers.get("x-mi-owner-agency-code") === PRIMARY_AGENCY_CODE')
    && ownerToolServer.includes('data-mi-admin-screen="owner-utility"')
    && ownerToolServer.includes('data-mi-admin-view="owner-utility"')
    && ownerToolServer.includes('data-owner-tool-input')
    && ownerToolServer.includes('data-owner-tool-copy="total"')
    && ownerToolServer.includes('const supply = ((total * 10n) + 5n) / 11n')
    && ownerToolServer.includes('const tax = total - supply')
    && adminSource.includes('window.location.origin + "/api/owner/tool"')
    && adminSource.includes('loadOwnerTool')
    && adminSource.includes('navigator.clipboard.writeText')
    && !/부가세|mi-vat|data-admin-vat|vat-calculator/i.test(adminSource)
    && !/부가세|mi-vat|data-admin-vat|vat-calculator/i.test(clientSource),
  ownerAssistantCanaryIsPrivateAndConfirmOnly: ownerToolServer.includes('data-mi-admin-screen="owner-assistant"')
    && ownerToolServer.includes('data-mi-admin-view="owner-assistant"')
    && ownerToolServer.includes('모먼트랩스 비서실 운영실')
    && ownerToolServer.includes('data-owner-assistant-office')
    && (ownerToolServer.match(/data-owner-assistant-agent(?:\s|>)/g) || []).length === 6
    && ownerToolServer.includes('data-owner-assistant-role="chief"')
    && ownerToolServer.includes('자리 대기, 담당 회의, 비서실장 방문')
    && ownerToolServer.includes('독립 AI 직원의 자동 실행 상태는 아닙니다')
    && ownerToolServer.includes('data-owner-assistant-mic')
    && ownerToolServer.includes('data-owner-assistant-wake')
    && ownerToolServer.includes('data-owner-assistant-read')
    && ownerToolServer.includes('source: "deterministic-private-v1"')
    && ownerToolServer.includes('visibility: "internal"')
    && ownerToolServer.includes('body?.action === "assistant-draft"')
    && adminSource.includes('window.confirm(targetLabel + " 일정으로 등록할까요?')
    && adminSource.includes('await requestWorkItems("POST", workItemPayload(draft))')
    && adminSource.includes('window.SpeechRecognition || window.webkitSpeechRecognition')
    && adminSource.includes('new window.SpeechSynthesisUtterance(briefing)')
    && adminSource.includes('function runOfficeScene()')
    && adminSource.includes('ownerAssistantOfficeController.setActive(target === "owner-assistant" && secureSession.role === "owner")')
    && adminSource.includes('ownerAssistantOfficeController.destroy()')
    && adminSource.includes('getAttribute("data-mi-admin-view") === "owner-assistant"')
    && !/<(?:a|section)\b[^>]*data-mi-admin-(?:screen|view)="owner-assistant"/u.test(adminSource)
    && !/<(?:a|section)\b[^>]*data-mi-(?:screen|view)="owner-assistant"/u.test(clientSource),
  ownerDevelopmentIsServerDeliveredOnly: ownerToolServer.includes('data-mi-admin-screen="owner-development"')
    && ownerToolServer.includes('data-mi-admin-view="owner-development"')
    && ownerToolServer.includes('data-mi-admin-screen="owner-utility"')
    && ownerToolServer.includes('data-mi-admin-view="owner-utility"')
    && ownerToolServer.includes("mi-nav-group")
    && /개발\s+(?:&lt;\/?&gt;|<\/?\s*>)/u.test(ownerToolServer)
    && ownerToolServer.includes("data-rank-worker-operations")
    && !staticOwnerDevelopmentMarkup.test(adminSource)
    && !staticOwnerDevelopmentMarkup.test(clientSource)
    && !staticWorkerOperationsPanel.test(adminSource)
    && !staticWorkerOperationsPanel.test(clientSource),
  ownerDevelopmentDynamicMountContract: ownerToolServer.includes('screen: "owner-development"')
    && adminOwnerToolLoaderSource.includes("menuGroup")
    && adminOwnerToolLoaderSource.includes('querySelectorAll(":scope > section[data-mi-admin-view]")')
    && adminOwnerToolLoaderSource.includes('getAttribute("data-mi-admin-view") === "owner-development"')
    && /nav\.appendChild\(menuGroup\)/u.test(adminOwnerToolLoaderSource)
    && /wrap\.appendChild\(view\)/u.test(adminOwnerToolLoaderSource)
    && adminOwnerToolLoaderSource.includes('CustomEvent("mi:rank-owner-tool-mounted")')
    && adminSource.includes('document.querySelectorAll("[data-owner-tool-menu-root], [data-owner-tool-view-root], [data-owner-tool-style-root]")'),
  ownerDevelopmentHashFailsClosedForNonOwner: adminSource.includes("owner-development")
    && adminSource.includes("owner-utility")
    && adminScreenRouterSource.includes("/^owner-/")
    && adminScreenRouterSource.includes("/^#mi-admin-owner-/")
    && adminScreenRouterSource.includes('secureSession.role !== "owner"')
    && adminScreenRouterSource.includes("window.history.replaceState")
    && adminScreenRouterSource.includes('"agency-code"')
    && adminScreenRouterSource.includes('"home"'),
  ownerDirectClientCreate: adminSource.includes('action: "create-client"') && adminSource.includes("비우면 총관리자 직접 발급"),
  ownerTeamCodeManualOnly: adminSource.includes('data-owner-team-code placeholder="6자리 이상 직접 입력" aria-label="운영팀 코드" autocomplete="off"')
    && !adminSource.includes("teamCreateInput.value = nextTeamCode")
    && superAdminServer.includes("생성할 운영팀 코드를 직접 입력해주세요.")
    && !superAdminServer.includes("function nextTeamCode(")
    && !superAdminServer.includes("nextTeamCode:"),
  teamClientCreateStillExists: adminSource.includes('action: "create-client-for-team"'),
  ownerCreateActionsSharePremiumGrid: (adminSource.match(/class="mi-form-row mi-form-row-3 mi-owner-create-row"/g) || []).length === 2
    && (adminSource.match(/class="mi-button mi-owner-create-action" type="button" data-owner-team-create/g) || []).length === 1
    && (adminSource.match(/class="mi-button mi-owner-create-action" type="button" data-team-client-create/g) || []).length === 1
    && ownerCreateDesktopStyle.includes("#mi-admin .mi-form-row.mi-form-row-3.mi-owner-create-row")
    && ownerCreateDesktopStyle.includes("grid-template-columns: repeat(2, minmax(0, 1fr));")
    && ownerCreateDesktopStyle.includes("grid-column: 2;")
    && ownerCreateDesktopStyle.includes("grid-row: 2;")
    && ownerCreateDesktopStyle.includes(".mi-owner-create-action:not(:disabled):hover")
    && ownerCreateResponsiveStyle.includes("#mi-admin .mi-form-row.mi-form-row-3.mi-owner-create-row")
    && ownerCreateResponsiveStyle.includes("grid-template-columns: 1fr;")
    && ownerCreateResponsiveStyle.includes("grid-column: auto;")
    && ownerCreateResponsiveStyle.includes("grid-row: auto;"),
  ownerAgencyConnectionUiIsOwnerOnly: adminSource.includes('root.classList.toggle("is-owner-agency-mode", ownerMode)')
    && adminSource.includes("mi-owner-account-layout")
    && adminSource.includes("mi-owner-flow-grid")
    && adminSource.includes("계정 연결을 관리합니다.")
    && adminSource.includes("운영팀은 선택입니다.")
    && adminSource.includes('data-owner-client-title')
    && adminSource.includes("mi-owner-security")
    && adminSource.includes('#mi-admin.is-owner-agency-mode .mi-owner-create-row [data-owner-team-create]')
    && adminSource.includes("grid-area: team-action;")
    && adminSource.includes("grid-area: client-action;")
    && adminSource.includes("grid-column: 1 / -1;")
    && adminSource.includes('ownerMode ? "광고주 생성" : "광고주 바로 생성"')
    && adminSource.includes('ownerMode ? "6자리 이상 직접 입력" : "광고주 코드 직접 입력"')
    && !clientSource.includes("is-owner-agency-mode")
    && !clientSource.includes("mi-owner-flow-grid"),
  ownerClientCodeRecoveryExists: superAdminServer.includes("광고주 코드 재활성화에 실패했습니다.")
    && superAdminServer.includes('action: "client.reactivated_by_owner"')
    && superAdminServer.includes("reactivated: true"),
  teamCannotTakeOverExistingClientCode: superAdminServer.includes("사용할 수 없는 광고주 코드입니다. 다른 코드를 발급해주세요.")
    && !superAdminServer.includes('action: "client.reactivated_by_team"')
    && !superAdminServer.includes("Reissued by operation team"),
  // UI 고도화 4단계 §1: 전체보기는 별도 화면이 아니라 대행사 연결 화면의 한 구역이다.
  ownerActiveAccountsFullView: adminSource.includes('data-mi-admin-section="active-accounts"')
    && !adminSource.includes('data-mi-admin-view="active-accounts"')
    && adminAgencyConnectionViewSource.includes('data-mi-admin-section="active-accounts"')
    && adminSource.includes("data-owner-team-full-list")
    && adminSource.includes("data-owner-client-full-list")
    && adminSource.includes("data-owner-list-open"),
  ownerRelationshipBoard: adminSource.includes("data-owner-relationship-list")
    && adminSource.includes("data-owner-root-account")
    && adminSource.includes("총관리자 직접 광고주"),
  rankTrackerListLimit500ForBothRoles: [adminSource, clientSource].every((source) =>
    source.includes('new URLSearchParams({ limit: "500" })')),
  clientLoginGate: clientSource.includes("data-mi-login-code") && clientSource.includes("data-mi-login-button"),
  clientNavigationTaxonomy: orderedIncludes(clientSource, [
    '<p class="mi-nav-title">운영</p>',
    'data-mi-screen="dashboard">대시보드</a>',
    'data-mi-screen="sales">매출 현황</a>',
    // 대표 결재(2026-08-25): 광고주의 "공개 일정" 메뉴는 개인 캘린더가 대체한다.
    'data-mi-screen="my-calendar">내 캘린더</a>',
    'data-mi-screen="agency-code">대행사 연결</a>',
    '<p class="mi-nav-title">키워드·SEO</p>',
    'data-mi-screen="keyword-tool">키워드 조회</a>',
    '<p class="mi-nav-title">순위 조회·추적</p>',
    'data-mi-screen="naver-rank-tracking">N 30일 순위</a>',
    'data-mi-screen="naver-place-rank-tracking">N 플레이스 30일 순위</a>',
    // UI 고도화 4단계 §3: 광고주 화면도 같은 규칙으로 개발 중 화면을 아래로 모은다.
    '<div class="mi-nav-group mi-nav-lab" data-mi-nav-lab>',
    '실험실 · 개발 중',
    'data-mi-screen="seo-check">SEO 확인 (개발중)</a>',
    'data-mi-screen="meta-ads">메타 광고 조사 <small>(개발중)</small></a>',
  ]),
  roleSidebarsSharePremiumShell: adminSource.includes('data-mi-shell="premium-sidebar"')
    && clientSource.includes('data-mi-shell="premium-sidebar"'),
  roleNavigationResetsScroll: [adminSource, clientSource].every((source) => source.includes('window.scrollTo({ top: 0, left: 0, behavior: "auto" })')),
  clientLoginRoleSelection: clientSource.includes('data-client-login-mode="client"')
    && clientSource.includes('data-client-login-mode="operator"')
    && clientSource.includes("운영팀 화면으로 이동")
    && clientSource.includes("getOperatorEntryUrl"),
  clientLoginRestoresSecureServerSession: !clientSource.includes('localStorage.setItem("miClientAuthedCode"')
    && !clientSource.includes('localStorage.setItem("miRankAccessCode"')
    && clientSource.includes("restoreClientSession")
    && clientSource.includes('window.location.origin + "/api/session"')
    && clientSource.includes('requestHeaders.set("x-mi-csrf", secureClientSession.csrfToken)')
    && clientSource.includes("restoreClientLogin")
    && clientSource.includes('class="mi-login-brand" href="/"'),
  clientLogoutExists: clientSource.includes("data-mi-logout")
    && clientSource.includes("data-mi-current-code")
    && clientSource.includes("logoutClient")
    && clientSource.includes("removeClientAuthCode")
    && clientSource.includes("로그아웃되었습니다. 다른 대행사 코드를 입력해주세요."),
  roleLogoutAlwaysReturnsToLogin: /function clearClientAuth\(\) \{[\s\S]{0,1000}?root\.classList\.add\("is-locked"\)[\s\S]{0,300}?root\.classList\.remove\("is-authed"\)/.test(clientSource)
    && orderedIncludes(clientLogoutSource, [
      "var logoutRequest = closeClientSession();",
      "clearClientAuth();",
      'window.scrollTo({ top: 0, left: 0, behavior: "auto" });',
      "serverLogoutConfirmed = await logoutRequest;",
    ])
    && orderedIncludes(adminLogoutSource, [
      "var logoutRequest = closeSecureSession();",
      'root.classList.add("is-locked");',
      'root.classList.remove("is-authed");',
      'window.scrollTo({ top: 0, left: 0, behavior: "auto" });',
      "serverLogoutConfirmed = await logoutRequest;",
    ])
    && [adminSource, clientSource].every((source) => source.includes("response.ok && payload && payload.ok === true"))
    && [adminSource, clientSource].every((source) => source.includes("timeoutMs: 5000")),
  roleLogoutInvalidatesStaleAuthWork: clientSource.includes("var clientSessionGeneration = 0;")
    && clientSource.includes("clientSessionGeneration += 1;")
    && clientUnlockSource.includes("var requestGeneration = ++clientSessionGeneration;")
    && clientUnlockSource.includes("clientSessionIsCurrent(requestGeneration, sessionScope)")
    && clientSource.includes("if (!clientSessionIsCurrent(generation, normalized)) throw new Error(\"stale_client_session\");")
    && adminSource.includes("var adminSessionGeneration = 0;")
    && adminSource.includes("adminSessionGeneration += 1;")
    && adminSource.includes("var requestGeneration = ++adminSessionGeneration;")
    && adminSourceRefreshSource.includes('if (!adminSessionIsCurrent(generation, "team", sessionScope)) return false;')
    && adminSourceUploadSource.includes("var requestGeneration = adminSessionGeneration;")
    && (adminSourceUploadSource.match(/adminSessionIsCurrent\(requestGeneration, sessionRole, sessionScope\)/g) || []).length >= 4
    && (adminAccountRequestSource.match(/var session = captureAdminSession\(\);/g) || []).length === 2
    && (adminAccountRequestSource.match(/adminSessionIsCurrent\(session\.generation, session\.role, session\.scopeKey\)/g) || []).length === 4
    && (adminAccountRequestSource.match(/if \(payload\.staleSession\) return false;/g) || []).length === 1
    && (adminSource.match(/if \(payload\.staleSession\) return;/g) || []).length >= 3
    && (adminAccountActionSource.match(/var actionSession = captureAdminSession\(\);/g) || []).length === 3
    && (adminAccountActionSource.match(/finally \{/g) || []).length === 3
    && (adminAccountActionSource.match(/adminSessionIsCurrent\(actionSession\.generation, actionSession\.role, actionSession\.scopeKey\)/g) || []).length >= 12,
  roleLogoutBlocksLatePrivilegedAndToolResponses: clientSource.includes("function captureClientSession() {")
    && clientSource.includes("function resetClientAsyncControls(options) {")
    && adminSource.includes("function resetAdminAsyncControls(options) {")
    && (clientReportDownloadSource.match(/clientSessionIsCurrent\(requestSession\.generation, requestSession\.scopeKey\)/g) || []).length >= 5
    && (adminSourceDownloadSource.match(/adminSessionIsCurrent\(requestSession\.generation, requestSession\.role, requestSession\.scopeKey\)/g) || []).length >= 4
    && (adminPptxDownloadSource.match(/adminSessionIsCurrent\(requestSession\.generation, requestSession\.role, requestSession\.scopeKey\)/g) || []).length >= 10
    && !clientMetaLookupSource.includes("metaLiveAdsCache = (payload.ads")
    && !adminMetaLookupSource.includes("metaLiveAdsCache = (payload.ads")
    && (clientMetaLookupSource.match(/clientSessionIsCurrent\(requestSession\.generation, requestSession\.scopeKey\)/g) || []).length >= 4
    && (adminMetaLookupSource.match(/adminSessionIsCurrent\(requestSession\.generation, requestSession\.role, requestSession\.scopeKey\)/g) || []).length >= 4
    && (clientKeywordLookupSource.match(/clientSessionIsCurrent\(requestSession\.generation, requestSession\.scopeKey\)/g) || []).length >= 4
    && (adminKeywordLookupSource.match(/adminSessionIsCurrent\(requestSession\.generation, requestSession\.role, requestSession\.scopeKey\)/g) || []).length >= 4
    && (clientSeoLookupSource.match(/clientSessionIsCurrent\(requestSession\.generation, requestSession\.scopeKey\)/g) || []).length >= 4
    && (adminSeoLookupSource.match(/adminSessionIsCurrent\(requestSession\.generation, requestSession\.role, requestSession\.scopeKey\)/g) || []).length >= 4
    && (clientRankCheckLookupSource.match(/clientSessionIsCurrent\(requestSession\.generation, requestSession\.scopeKey\)/g) || []).length >= 4
    && (adminRankCheckLookupSource.match(/adminSessionIsCurrent\(requestSession\.generation, requestSession\.role, requestSession\.scopeKey\)/g) || []).length >= 4
    && clientSource.includes("resetClientAsyncControls({ clearSensitiveInputs: true });")
    && adminSource.includes("resetAdminAsyncControls({ clearSensitiveInputs: true });")
    && [clientAsyncResetSource, adminAsyncResetSource].every((source) => source.includes("clearSensitiveInputs")
      && source.includes("[data-meta-query]")
      && source.includes("[data-seo-keyword]")
      && source.includes("[data-seo-url]")
      && source.includes("[data-meta-summary-query]")
      && source.includes("[data-meta-summary-count]")
      && source.includes("[data-meta-summary-state]")
      && source.includes("[data-rank-check-run]")
      && source.includes("[data-rank-check-keyword]")
      && source.includes("[data-rank-check-url]")
      && source.includes("[data-rank-check-product-id]")
      && source.includes("[data-rank-check-result]")
      && source.includes("[data-rank-check-status]")
      && source.includes("[data-rank-keyword]")
      && source.includes("[data-rank-url]")
      && source.includes("[data-place-rank-keyword]")
      && source.includes("[data-place-rank-url]")
      && source.includes("data-rank-bulk-group-draft")),
  clientLoginButtonsRespectSessionGeneration: (clientSource.match(/var initialGeneration = clientSessionGeneration;/g) || []).length === 2
    && (clientSource.match(/clientSessionGeneration === initialGeneration \|\| clientSessionGeneration === initialGeneration \+ 1/g) || []).length === 2
    && clientSource.includes("[data-mi-connect-button], [data-mi-login-button]"),
  clientSessionRestoreKeepsInitialGeneration: clientSessionRestorePreparationSource.includes('root.classList.add("is-locked");')
    && clientSessionRestorePreparationSource.includes('root.classList.remove("is-authed");')
    && clientSessionRestorePreparationSource.includes("resetClientAsyncControls();")
    && !clientSessionRestorePreparationSource.includes("clearClientAuth();")
    && !clientSessionRestorePreparationSource.includes("clientSessionGeneration += 1;")
    && orderedIncludes(clientBootSource, [
      "applyState(state);",
      "prepareClientSessionRestore();",
      "var initialRestoreGeneration = clientSessionGeneration;",
      "restoreClientLogin().catch(function () {",
      "if (initialRestoreGeneration !== clientSessionGeneration) return;",
    ])
    && (clientSource.match(/restoreClientLogin\(\)\.catch/g) || []).length === 1,
  adminLoginFailureCanRetry: orderedIncludes(adminLoginHandlerSource, [
    "if (requestGeneration !== adminSessionGeneration) return;",
    "await closeSecureSession().catch(function () { clearAdminAuthCode(); });",
    "loginButton.disabled = false;",
    "return;",
  ]),
  homeDevelopmentNoticeVisible: homeSource.includes("8월 서비스 운영 안내")
    && homeDevelopmentNoticeMarkupSource.includes("키워드 조회는 네이버 공식 API 연결 기준으로 제공")
    && homeDevelopmentNoticeMarkupSource.includes("매일 오전 9시와 오후 3시, 하루 두 차례 자동 갱신됩니다.")
    && homeDevelopmentNoticeMarkupSource.includes('<span data-status="공식 API">키워드 조회</span>')
    && homeDevelopmentNoticeMarkupSource.includes('<span class="is-development" data-status="(개발중)">SEO 확인</span>')
    && !homeDevelopmentNoticeMarkupSource.includes("N 상품 순위")
    && homeDevelopmentNoticeMarkupSource.includes('data-status="09:00 · 15:00"')
    && homeSource.includes("data-mi-dev-banner")
    && homeSource.includes("mi-dev-banner-head")
    && homeSource.includes("mi-dev-banner-contact")
    && homeSource.includes("카카오톡 채널")
    && homeSource.includes("채널 문의")
    && homeSource.includes("data-mi-dev-banner-close")
    && homeSource.includes("data-mi-dev-banner-toggle")
    && homeSource.includes('aria-expanded="false"')
    && homeSource.includes('aria-controls="mi-home-dev-banner-details"')
    && homeSource.includes('id="mi-home-dev-banner-details" data-mi-dev-banner-details hidden')
    && homeSource.includes("data-mi-dev-banner-toggle-label")
    && homeSource.includes("data-mi-dev-banner-week")
    && homeSource.includes("miHomeDevBannerHiddenUntil")
    && homeSource.includes("7 * 24 * 60 * 60 * 1000")
    && ["키워드 조회", "SEO 확인", "N 30일 순위", "N 플레이스 30일 순위"].every((label) => homeDevelopmentNoticeMarkupSource.includes(label))
    && !["네이버 상품순위", "네이버 30일 순위", "네이버 플레이스 30일 순위"].some((label) => homeSource.includes(label)),
  homeDocumentShellAndViewport: homeSource.startsWith("<!doctype html>")
    && homeSource.includes('<html lang="ko">')
    && homeSource.includes('<meta name="viewport" content="width=device-width, initial-scale=1" />')
    && homeSource.includes("<head>")
    && homeSource.includes("</head>")
    && homeSource.includes("<body>")
    && homeSource.includes("</body>")
    && homeSource.trimEnd().endsWith("</html>"),
  // 뷰포트 선언이 없으면 모바일 사파리가 980px 데스크톱 폭으로 그리고 페이지를 축소한다.
  // 네 페이지 모두 같은 한 줄을 갖고, 손가락 확대를 막는 값은 어디에도 없어야 한다.
  dashboardPagesDeclareMobileViewport: [adminSource, clientSource, homeSource, privacySource]
    .every((source) => source.includes('<meta name="viewport" content="width=device-width, initial-scale=1" />'))
    // 대시보드 두 장은 charset 바로 다음 줄에 둔다 — 선언이 늦으면 첫 레이아웃을 놓친다.
    && adminSource.includes('<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />')
    && clientSource.includes('<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />')
    && dashboardViewportMetas.length === 4
    && dashboardViewportMetas.every((meta) => meta.includes("width=device-width")
      && !meta.includes("maximum-scale")
      && !meta.includes("user-scalable=no")),
  // ≤900px 에서 고정 폭 칸을 눕히고(가로 넘침), 입력칸 글자를 16px 로 올린다(iOS 확대).
  dashboardMobileLayoutAndInputGuards: adminMobileStyle.includes("#mi-admin .mi-rank-form.is-tracking,")
    && adminMobileStyle.includes("#mi-admin .mi-rank-grid {")
    && clientMobileStyle.includes("#mi-clean .mi-rank-form.is-tracking,")
    && clientMobileStyle.includes("#mi-clean .mi-rank-grid {")
    // `#mi-admin input { font: inherit }` 가 아이디 특이도로 공유 CSS 를 이기므로,
    // 페이지 쪽에서도 아이디를 달아 캘린더 입력칸을 다시 16px 로 못박아야 한다.
    && orderedIncludes(adminMobileStyle, [
      "#mi-admin .mi-cal-input,",
      "#mi-admin .mi-cal-select,",
      "#mi-admin .mi-cal-textarea {",
      "font-size: 16px;",
    ])
    && orderedIncludes(clientMobileStyle, [
      "#mi-clean .mi-cal-input,",
      "#mi-clean .mi-cal-select,",
      "#mi-clean .mi-cal-textarea {",
      "font-size: 16px;",
    ])
    && orderedIncludes(adminWorkDialogMobileStyle, [
      "#mi-admin .mi-work-dialog .mi-input,",
      "#mi-admin .mi-work-dialog .mi-textarea,",
      "#mi-admin .mi-work-gcal-panel .mi-select {",
      "font-size: 16px;",
    ])
    && orderedIncludes(personalCalendarMobileStyle, [
      ".mi-cal-input,",
      ".mi-cal-select,",
      ".mi-cal-textarea {",
      "font-size: 16px;",
    ])
    // 표는 스크롤 상자 안에서만 밀려야 한다. .mi-article 은 그리드 아이템이라
    // 기본값 min-width:auto 가 표(560px)보다 좁아지기를 거부해, 상자가 있어도
    // 문서가 통째로 가로로 넘쳤다(375px 에서 scrollWidth 576).
    && orderedIncludes(privacyMobileStyle, [
      "#mi-privacy .mi-article {",
      "min-width: 0;",
    ])
    && privacySource.includes("min-width: 560px;")
    && privacySource.includes("overflow-x: auto;"),
  homeInlineDevelopmentStatusDoesNotCoverPrimaryActions: /position:\s*relative;/u.test(homeDevelopmentNoticeStyleSource)
    && !/position:\s*fixed;/u.test(homeDevelopmentNoticeStyleSource)
    && homeDevelopmentNoticeStyleSource.includes("width: min(1120px, calc(100% - 40px));")
    && homeDevelopmentNoticeStyleSource.includes("margin: 18px auto 0;")
    && orderedIncludes(homeSource, [
      "</header>",
      '<aside class="mi-dev-banner"',
      '<main id="mi-home-top">',
    ])
    && orderedIncludes(homeSource, [
      "@media (max-width: 640px)",
      "#mi-home .mi-dev-banner {",
      "width: calc(100% - 28px);",
      "margin-top: 12px;",
    ])
    && homeDevelopmentNoticeMarkupSource.includes("data-mi-dev-banner-toggle")
    && homeDevelopmentNoticeMarkupSource.includes('aria-expanded="false"')
    && homeDevelopmentNoticeMarkupSource.includes("data-mi-dev-banner-details hidden")
    && homeDevelopmentNoticeScriptSource.includes('toggle.setAttribute("aria-expanded", String(!expanded));')
    && homeDevelopmentNoticeScriptSource.includes('toggleLabel.textContent = expanded ? "자세히" : "접기";')
    && homeDevelopmentNoticeScriptSource.includes("details.hidden = expanded;")
    && homeSource.includes('<a class="mi-button primary" href="/client">대시보드 미리보기</a>')
    && homeSource.includes('<a class="mi-button secondary" href="#mi-home-features">기능 다시 보기</a>'),
  homePremiumHierarchyVisible: homeSource.includes("통합 마케팅 운영 플랫폼")
    && homeSource.includes("샘플 화면")
    && homeSource.includes("예시 데이터")
    && homeSource.includes("#mi-home-trust .mi-grid-3")
    && homeSource.includes("#mi-home .mi-cta .mi-button.primary")
    && homeSource.includes("mi-footer-inner")
    && homeSource.includes("카카오 문의"),
  homeAnonymousFeatureShowcase: homeFeatureShowcaseSource.includes('data-mi-showcase-privacy="synthetic-only"')
    && homeFeatureShowcaseSource.includes("예시 데이터")
    && homeFeatureShowcaseSource.includes("실고객 정보 미사용")
    && homeFeatureShowcaseSource.includes("예시 키워드 A")
    && homeFeatureShowcaseSource.includes("예시 키워드 B")
    && homeFeatureShowcaseSource.includes("예시 키워드 C")
    && homeFeatureShowcaseSource.includes("예시 상품 A")
    && homeFeatureShowcaseSource.includes("예시 매장 A")
    && homeFeatureShowcaseSource.includes("30일 오가닉 순위 추적")
    && homeFeatureShowcaseSource.includes("자동 300위 확인")
    && homeFeatureShowcaseSource.includes("상품 순위 추적")
    && homeFeatureShowcaseSource.includes("플레이스 순위 추적")
    && homeFeatureShowcaseSource.includes("키워드 시장 분석")
    && homeFeatureShowcaseSource.includes("기능 설명을 위한 예시 데이터입니다.")
    && (homeFeatureShowcaseSource.match(/class="mi-suite-card /g) || []).length === 4
    && !/<img\b/i.test(homeFeatureShowcaseSource)
    && !/https?:\/\//i.test(homeFeatureShowcaseSource)
    && !/\b\d{9,}\b/.test(homeFeatureShowcaseSource)
    && !["상품ID", "원부ID", "플레이스ID", "codex-clipboard", "/var/folders/", "/products/", "/entry/place/"].some((value) => homeFeatureShowcaseSource.includes(value))
    && !prohibitedHomeShowcaseFragments.some((value) => normalizedHomeFeatureShowcase.includes(value))
    && !homeSource.includes("For Brand Growth")
    && !homeSource.includes("Core Features"),
  homeFeatureShowcasePriorityAndGroups: homeSource.indexOf('id="mi-home-features"') !== -1
    && homeSource.indexOf('id="mi-home-trust"') !== -1
    && homeSource.indexOf('id="mi-home-features"') < homeSource.indexOf('id="mi-home-trust"')
    && homeFeatureShowcaseSource.includes('data-mi-showcase-group="snapshot"')
    && homeFeatureShowcaseSource.includes('data-mi-showcase-group="tracking"')
    && homeFeatureShowcaseSource.includes("현재 데이터")
    && homeFeatureShowcaseSource.includes("30일 순위 추적")
    && (homeFeatureShowcaseSource.match(/class="mi-suite-grid"/g) || []).length === 2
    && homeSnapshotShowcaseSource.includes('class="mi-suite-card rank"')
    && homeSnapshotShowcaseSource.includes('class="mi-suite-card keyword"')
    && !homeSnapshotShowcaseSource.includes('class="mi-suite-card trend"')
    && !homeSnapshotShowcaseSource.includes('class="mi-suite-card place"')
    && homeTrackingShowcaseSource.includes('class="mi-suite-card trend"')
    && homeTrackingShowcaseSource.includes('class="mi-suite-card place"')
    && !homeTrackingShowcaseSource.includes('class="mi-suite-card rank"')
    && !homeTrackingShowcaseSource.includes('class="mi-suite-card keyword"'),
  metaAdsMarkedInDevelopment: [adminSource, clientSource].every((source) => source.includes("메타 광고 조사 <small>(개발중)</small>")
    && source.includes('<span class="mi-badge warn">개발중</span>')),
  placeRankReleased: [adminSource, clientSource].every((source) => source.includes("N 플레이스 30일 순위</a>")
    && source.includes("<h1>네이버 플레이스 30일 순위</h1>")
    && !source.includes("N 플레이스 30일 순위 <small>(개발중)</small>")
    && !source.includes('네이버 플레이스 30일 순위 <span class="mi-badge warn">개발중</span>')),
  rankTrackingFixedAt300: [adminSource, clientSource].every((source) => source.includes("data-rank-fixed-range")
    && source.includes("data-place-rank-fixed-range")
    && source.includes("300위 이내")
    && !source.includes("300위 고정")
    && !source.includes("data-place-rank-name")
    && !source.includes("data-rank-max")
    && !source.includes("data-place-rank-max")
    && source.includes("maxRank: 300"))
    && rankServer.includes("PRODUCT_RANK_TRACKER_MAX_RANK = 300")
    && rankServer.includes("maxRank: PRODUCT_RANK_TRACKER_MAX_RANK")
    && placeRankServer.includes("PLACE_RANK_TRACKER_MAX_RANK = 300")
    && placeRankServer.includes("maxRank: PLACE_RANK_TRACKER_MAX_RANK")
    && adminApiServer.includes('if (config.table === "naver_rank_trackers") body.max_rank = 300;')
    && fixedRankScopeMigration.includes("check (max_rank = 300)")
    && fixedRankScopeMigration.includes("update public.naver_rank_trackers")
    && fixedRankScopeMigration.includes("update public.naver_place_rank_trackers"),
  placeRankTruthfulDailyBoard: [adminPlaceDailyBoardSource, clientPlaceDailyBoardSource].every((source) =>
    [
      "mi-place-day-card",
      "groupPlaceSnapshotsByDay",
      'role="list"',
      'role="listitem"',
      'tabindex="0"',
      "placeDaySnapshotState",
      "방문자 리뷰",
      "블로그 리뷰",
      "mi-place-day-evidence",
    ].every((marker) => source.includes(marker))
      && ![
        "monthlySearchCount",
        "businessCount",
        'renderPlaceDayMetric("월검색"',
        'renderPlaceDayMetric("업체"',
      ].some((marker) => source.includes(marker))
    )
    && [adminPlaceTargetMetricSource, clientPlaceTargetMetricSource].every((metricSource) =>
      metricSource.includes("snapshot.place") && !metricSource.includes("place.metrics")
    )
    && placeRankServer.includes("mergeDefinedPlaceMetrics")
    && placeRankServer.includes("aggregateCompleteTopPlaceMetrics")
    && placeRankServer.includes('"blogReviewCount", "blog_review_count"')
    && placeRankServer.includes('scope: "organic_search_results"'),
  placeRankPremiumCompactCards: [adminSource, clientSource].every((source) => source.includes("--mi-place-day-width: 156px")
    && source.includes("flex: 0 0 var(--mi-place-day-width, 156px)")
    && source.includes("grid-template-columns: repeat(2, minmax(0, 1fr));")
    && source.includes(".mi-place-day-card.is-latest")
    && source.includes(".mi-place-day-trend.is-up")
    && source.includes(".mi-place-day-reviews")
    && /mi-rank-export-sheet \.mi-place-day-grid \{[\s\S]*?grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);[\s\S]*?overflow: visible;[\s\S]*?scroll-snap-type: none;/.test(source)
    && /mi-rank-export-sheet \.mi-place-day-card \{[\s\S]*?min-width: 0;/.test(source)
    && source.includes(".mi-place-rank-item .mi-rank-row-actions .mi-rank-pill:first-child")
    && source.includes("scroll-snap-type: x proximity")),
  placeRankPartialResultsStayTruthful: [adminSource, clientSource].every((source) => source.includes("개 확인 · 이후 미검증")
    && source.includes('rankLabel: rank ? rankText(rank) : "-"')
    && source.includes('partial ? "부분 확인"')
    && source.includes('"오가닉 " + formatNumber(checkedCount) + "개까지 확인"')
    && !source.includes('? formatNumber(checkedCount) + "개 확인"')
    && source.includes("function placeTrackerLatestRank")
    && source.includes("function placeTrackerPreviousRank")
    && source.includes("function placeTrackerNeedsAttention")
    && source.includes("function placeTrackerInsight")
    && source.includes("placeTrackerChangeLabel(tracker)")
    && source.includes("rankTrackerOpsSummary(list, placeTrackerLatestRank)")
    && source.includes("if (snapshots.length) return rankTrackerRankValue"))
    && placeRankServer.includes("checkedCount >= PLACE_RANK_TRACKER_MAX_RANK")
    && placeRankServer.includes("current_rank: null")
    && placeRankServer.includes("placeRetryAt(tracker, new Date(checkedAt))")
    && placeRankServer.includes("providerDeadlineAt")
    && placeRankServer.includes('providerSource !== "naver_map_pc_list_collector"')
    && placeRankServer.includes('rankEvidence !== "naver_pc_organic_list"')
    && placeRankServer.includes('throw new Error("place_rank_provider_untrusted_evidence")')
    && placeRankCollector.includes("resolveProviderDeadlineAt")
    && placeRankCollector.includes("The native Naver PC organic list is the only rank authority")
    && placeRankCollector.includes('rankEvidence: "naver_pc_organic_list"')
    && placeRankCollector.includes("viewport: { width: 1440, height: 1600 }")
    && !placeRankCollector.includes("const apifyResult = await apifyLookup(payload)")
    && placeRankCollector.includes("collectVerifiedListRowsProgressively")
    && placeRankCollector.includes("selectorError,")
    && placeRankCollector.includes("needsBrowserIdentityResolution(placeUrl, placeId)")
    && placeRankCollector.includes("IDENTITY_OPTIONAL_SELECTOR_TIMEOUT_MS")
    && placeRankCollector.includes("COLLECTION_DEADLINE_GUARD_MS = 12000")
    && placeRankCollector.includes("Only rows proven to come from Naver's place-list scroll container")
    && placeRankCollector.includes("row?.isPlaceListRow === true")
    && placeRankCollector.includes("identifiedCandidateCount === 0")
    && placeRankCollector.includes("Only top-level list rows represent")
    && placeRankCollector.includes('row.parentElement?.closest("li")')
    && placeRankCollector.includes("function nextListScrollTop")
    && placeRankCollector.includes("An end jump can skip middle rows")
    && !placeRankCollector.includes("root.scrollTop = root.scrollHeight")
    && placeRankCollector.includes("Math.min(2, growthPollAttempts)")
    && placeRankCollector.includes('collection?.stopReason === "naver_result_list_exhausted"')
    && placeRankCollector.includes("collection?.complete !== true && !stableExhaustion")
    && placeRankCollector.includes("isApifyAccountLimitError"),
  placeRankGroupAndShareTools: [adminSource, clientSource].every((source) => source.includes("data-place-rank-filter-group")
    && source.includes("data-place-rank-select")
    && source.includes("data-rank-bulk-move")
    && source.includes("data-rank-bulk-clear")
    && source.includes("data-rank-refresh-all")
    && source.includes("data-rank-download-selected")
    && source.includes("그룹 생성/적용")
    && source.includes("전체 순위 갱신")
    && source.includes("선택 이미지 저장")
    && source.includes("renderPlaceKeywordName")
    && source.includes("https://map.naver.com/p/search/"))
    && placeRankTrackerGroupsMigration.includes("add column if not exists group_name text")
    && placeRankTrackerGroupsMigration.includes("idx_naver_place_rank_trackers_agency_group_sort"),
  clientReportDownloadBox: clientSource.includes("data-mi-report-list")
    && clientSource.includes("data-mi-report-download")
    && clientSource.includes("downloadClientReport")
    && clientSource.includes("공개 보고서만 표시합니다.")
    && clientSource.includes("공개 보고서 없음")
    && clientSource.includes("reportCenterSynced")
    && clientSource.includes("renderReports(state.reports, state.updatedAt, state.reportCenterSynced)")
    && !clientSource.includes("buildClientReportCsv")
    && !clientSource.includes("text/csv;charset=utf-8")
    && !clientSource.includes("CSV 백업"),
  clientDataReliabilityVisible: clientSource.includes("데이터 신뢰도: 운영팀 검수 완료")
    && clientSource.includes("데이터 상태: 공개 데이터 연결 대기")
    && clientSource.includes("data-mi-summary-empty")
    && clientSource.includes("data-mi-update-state")
    && clientSource.includes("data-mi-performance-state")
    && clientSource.includes("운영팀 공개 입력 전")
    && clientSource.includes("데이터 출처")
    && clientSource.includes("공개 승인된 보고서만 표시")
    && clientSource.includes("운영팀 업로드 → 검수 → 공개 → 다운로드")
    && clientSource.includes("운영팀 공개 파일 대기")
    && clientSource.includes("공개 대기"),
  adminHomeAvoidsFabricatedCounts: adminSource.includes("data-admin-home-truthful-state")
    && adminSource.includes("실제 연결 데이터가 없는 수치는 임의 집계하지 않습니다.")
    && !adminSource.includes("<strong>12개</strong>")
    && !adminSource.includes("<strong>4건</strong>")
    && !adminSource.includes("<strong>3건</strong>")
    && !adminSource.includes("<strong>2건</strong>")
    && !adminSource.includes("브랜드 A 입력값 확인")
    && !adminSource.includes("신규브랜드 A")
    && !adminSource.includes("리텐션브랜드 B"),
  adminHomePremiumOperatingFlow: adminSource.includes("mi-ops-home")
    && adminSource.includes("mi-ops-quick-grid")
    && adminSource.includes("mi-ops-flow")
    && adminSource.includes("mi-ops-check-list")
    && adminSource.includes("빠른 실행")
    && adminSource.includes("운영 루틴")
    && adminSource.includes("공개 전 확인")
    && !adminSource.includes("보고서·공개 승인 큐")
    && !adminSource.includes("운영 신뢰 체크")
    && !adminSource.includes("실제 상태 확인"),
  adminHomeUsesRealMonthlyOperationStatus: adminSource.includes("data-ops-home-sales-state")
    && adminSource.includes("data-ops-home-report-state")
    && adminSource.includes("function renderOperationHomeSalesStatus")
    && adminSource.includes("function refreshOperationHomeReportStatus")
    && adminSource.includes('endpoint.searchParams.set("from", month.from)')
    && adminSource.includes('report.visibility === "client_visible"')
    && adminSource.includes("이번 달 매출 미입력")
    && adminSource.includes("이번 달 보고서 없음")
    && !adminSource.includes("<strong>매출 입력 완료</strong>")
    && !adminSource.includes("<strong>보고서 제출 완료</strong>"),
  adminHomeStatusLeadsOperatingHierarchy: adminSource.indexOf('class="mi-ops-status-board"') < adminSource.indexOf('class="mi-ops-quick-grid"')
    && adminSource.indexOf('class="mi-ops-quick-grid"') < adminSource.indexOf('class="mi-ops-flow-card"')
    && adminSource.indexOf('class="mi-ops-flow-card"') < adminSource.indexOf('class="mi-ops-check-card"')
    && adminSource.includes("grid-template-columns: repeat(2, minmax(0, 1fr));"),
  // 3단계: 역할마다 "지금 상황"에서 시작하고, 대상 광고주는 한 번만 고른다.
  adminOwnerLandsInExecutiveRoom: adminSource.includes('if (!ownerLandingHash && ownerToolScreens.indexOf("owner-assistant") >= 0) {')
    && adminSource.includes('setScreen("owner-assistant", !restored);')
    && adminSource.includes('data-mi-admin-screen="home">운영 홈</a>'),
  adminTeamLandsOnStatusSummaryHome: adminSource.includes('setScreen(personalCalendarNoticePending() ? "my-calendar" : "home", !restored);')
    && !adminSource.includes('teamHasClient ? "agency-code" : "home"')
    && adminSource.includes("<strong>지금 상황</strong>")
    && ["client", "sales", "report", "schedule", "rank"].every((hook) => adminSource.includes(`data-ops-home-${hook}-state`))
    && adminSource.includes("function renderOperationHomeClientStatus")
    && adminSource.includes("function refreshOperationHomeScheduleStatus")
    && adminSource.includes("function refreshOperationHomeRankSignal")
    && adminSource.includes('rankTrackerTrend(tracker) === "dropped"')
    && adminSource.includes('placeTrackerTrend(tracker) === "dropped"')
    && adminSource.includes('return window.location.origin + "/api/my/work-items";')
    && adminSource.includes('class="mi-ops-quick-grid" data-admin-home-truthful-state'),
  adminGlobalAdvertiserTargetIsSingleSource: adminSource.includes("data-mi-target-picker")
    && adminSource.includes("data-mi-target-select")
    && adminSource.includes("data-mi-target-manual")
    && adminSource.includes('var GLOBAL_ADVERTISER_MANUAL_VALUE = "__manual__";')
    && adminSource.includes("function applyGlobalAdvertiserTarget(rawCode, options)")
    && adminSource.includes("publicCodeInput.value = nextPublicCode;")
    && adminSource.includes("workScopeInput.value = nextWorkCode;")
    && adminSource.includes("activeOwnerClients(ownerCodeSnapshot)")
    && adminSource.includes('"mi-global-advertiser-target:" + (normalizeStorageCode(secureSession.scopeKey) || "session")')
    && adminSource.includes("applyGlobalAdvertiserTarget(workOwnerClientInput.value, { force: true, reloadWork: false });")
    && adminSource.includes('<span class="mi-target-echo" data-mi-target-echo>')
    && !clientSource.includes("data-mi-target-picker"),
  clientReportCenterSync: clientSource.includes("getReportCenterApiUrl")
    && clientSource.includes("syncReportCenterReports")
    && clientSource.includes("restoreClientSession")
    && clientSource.includes('requestHeaders.delete(name)')
    && clientSource.includes("file.signed_url")
    && clientSource.includes("fileUrl")
    && clientSource.includes("운영팀이 보고서 파일을 공개하면 다운로드할 수 있습니다."),
  adminReportCenterPublish: adminSource.includes("getReportCenterApiUrl")
    && adminSource.includes("generateSalesPptxReport")
    && adminSource.includes("reportCenterSessionRequest")
    && adminSource.includes('headers["x-mi-agency-code"] = agencyCode')
    && !adminSource.includes('"x-mi-team-code": teamCode')
    && adminSource.includes("PPTX 생성 · 보고서함 기록 완료")
    && adminSource.includes("운영팀-광고주 연결이 필요합니다."),
  reportPolicyAligned: adminSource.includes("<h1>보고서 관리</h1>")
    && adminSource.includes("보고서는 생성 즉시 광고주에게 공개됩니다.")
    && adminSource.includes("공개 처리된 파일만 광고주 노출")
    && clientSource.includes("보고서함 다운로드 방식")
    && sheetTemplateBuilder.includes("운영팀 검수 후 보고서함 공개")
    && !adminSource.includes("보고서는 관리자가 전달합니다.")
    && !clientSource.includes("관리자가 다운로드 후 전달")
    && !clientSource.includes("관리자 전달 방식")
    && !sheetTemplateBuilder.includes("관리자가 다운로드 후 전달"),
  adminSourceFileUploadDownload: adminSource.includes("data-admin-source-file")
    && adminSource.includes("data-admin-source-download")
    && adminSource.includes("data-admin-source-delete")
    && adminSource.includes("sourceFileStorageKey")
    && adminSource.includes("downloadSourceFile")
    && adminSource.includes("운영 원본 파일")
    && adminSource.includes("현재 파일은 브라우저 임시 보관입니다"),
  adminOperatingGuardrailsVisible: adminSource.includes("데이터 출처 고정")
    && adminSource.includes("생성 즉시 공개")
    && adminSource.includes('data-admin-guardrail="naverDaily"')
    && adminSource.includes('data-admin-guardrail="coupangDaily"')
    && adminSource.includes("#mi-admin .mi-guardrail-chip.is-ok")
    && adminSource.includes("function checkAdminSheetInputs")
    && adminSource.includes("setAdminGuardrails(checks)")
    && adminSource.includes("입력값 상태 확인 완료")
    && adminSource.includes("운영 입력</strong><span>매출·광고비·KPI 원본을 먼저 업로드")
    && adminSource.includes("현재 파일은 브라우저 임시 보관입니다")
    && adminSource.includes("다른 기기나 브라우저에서는 확인할 수 없습니다"),
  adminDefaultTemplateDownload: adminSource.includes("/downloads/moment-insight-operation-sheet-template.xlsx")
    && adminSource.includes("기본 양식 다운로드")
    && adminSource.includes("새 운영팀은 이 파일을 먼저 내려받고")
    && adminSource.includes("연결 광고주 1곳 기준")
    && exists("public/downloads/moment-insight-operation-sheet-template.xlsx"),
  publicStateScopedBySessionIdentity: adminSource.includes("scopedStorageKey(storageKey")
    && adminSource.includes("scopedStorageKey(sourceFileStorageKey")
    && adminSource.includes("ownerTargetClientId")
    && adminSource.includes('ownerTargetClientId() || "owner-unresolved"')
    && adminSource.includes("secureSession.teamId")
    && adminSource.includes("secureSession.clientId")
    && adminSource.includes("secureSession.scopeKey")
    && adminSource.includes("delete nextState.code")
    && adminSource.includes("delete nextState.agencyCode")
    && clientSource.includes("scopedStorageKey(code)")
    && clientSource.includes("secureClientSession.scopeKey")
    && clientSource.includes("publicStateForStorage")
    && clientSource.includes("delete safeState.code")
    && clientSource.includes("delete safeState.agencyCode")
    && !clientSource.includes("await syncDemoState(loginStatus)")
    && !clientSource.includes("await syncDemoState(connectStatus)"),
  operationSheetSingleClientSimple: sheetTemplateBuilder.includes("single-client-operation-team-template")
    && sheetTemplateBuilder.includes("별도 광고주 코드 입력은 없습니다")
    && sheetTemplateBuilder.includes("네이버_일별입력")
    && sheetTemplateBuilder.includes("쿠팡_일별입력")
    && sheetTemplateBuilder.includes("월간_매출입력")
    && sheetTemplateBuilder.includes("월간 매출, 광고비, 구매수, ROAS가 자동 계산")
    && sheetTemplateBuilder.includes("DAILY_TOTAL_ROW = 205")
    && sheetTemplateBuilder.includes("C${DAILY_FIRST_INPUT_ROW}:C${DAILY_LAST_INPUT_ROW}")
    && !sheetTemplateBuilder.includes("보고서_목록")
    && sheetTemplateBuilder.includes("SUMIFS")
    && sheetTemplateBuilder.includes("광고주 연결")
    && adminSource.includes("운영팀은 네이버·쿠팡 일별값만 넣고, 월간 합계와 ROAS는 자동 계산")
    && adminSource.includes("네이버_일별입력")
    && adminSource.includes("쿠팡_일별입력")
    && adminSource.includes("월간_매출입력")
    && !adminSource.includes("보고서_목록")
    && !adminSource.includes('data-report-type="weekly"')
    && !adminSource.includes("주간 보고서")
    && !clientSource.includes("주간 보고서")
    && !sheetTemplateBuilder.includes("일별_매출입력")
    && !adminSource.includes("일별_매출입력")
    && !sheetTemplateBuilder.includes('client_id", "광고주명", "브랜드명"'),
  clientToolsExist: ["keyword-tool", "related-keywords", "naver-rank-tracking", "naver-place-rank-tracking", "meta-ads", "seo-check", "agency-code"].every((screen) => clientScreens.includes(screen))
    && !clientScreens.includes("naver-rank"),
  keywordThreeYearTrendWorks: [adminSource, clientSource].every((source) => [
    'data-keyword-range="year"',
    'data-keyword-range="threeYear"',
    "threeYear: 36",
    "data.seriesPeriods",
    'keywordRange === "threeYear"',
    'chartWidth < 640 ? 6 : 12',
    "match[1].slice(2) + \".\" + match[2]",
  ].every((marker) => source.includes(marker)))
    && keywordServer.includes("const KEYWORD_TREND_MONTHS = 36;")
    && keywordServer.includes("seriesPeriods: trendPeriods(trend)")
    && keywordServer.includes("seriesPeriods: datalabProfile?.seriesPeriods || []"),
  keywordMarketPremiumSummary: [adminSource, clientSource].every((source) => [
    "KEYWORD MARKET",
    'data-keyword-market-indicator="demand"',
    'data-keyword-market-indicator="competition"',
    'data-keyword-market-indicator="salesOpportunity"',
    "검색 수요",
    "경쟁 강도",
    "판매 기회율",
    "판매 기회율은 실제 매출 전환율이 아닙니다.",
    "grid-template-columns: minmax(100px, 1fr) 58px 38px 74px;",
    "function setKeywordMarketIndicator(",
  ].every((marker) => source.includes(marker)))
    && keywordServer.includes("export function keywordMarketIndicators(")
    && keywordServer.includes("market: keywordMarketIndicators({")
    && keywordServer.includes("absoluteShoppingSupplyScore")
    && keywordServer.includes("demandSupplyScaleScore")
    && keywordServer.includes("Math.max(highest, score)")
    && keywordServer.includes("검색수요×상품규모·수요 대비 상품밀도·검색광고 경쟁도 기반 참고 지표"),
  keywordMarketDecisionUsesAggregateForBothRoles: [adminSource, clientSource].every((source) => [
    "function keywordMarketCompetitionLabel(data)",
    "data.marketComp = keywordMarketCompetitionLabel(data)",
    "if (data.market && data.market.action) data.action = data.market.action",
    "if (data.market && data.market.insight) data.insight = data.market.insight",
    "escapeHtml(keywordMarketCompetitionLabel(item.data))",
    "종합 경쟁강도는 \" + marketCompetition",
  ].every((marker) => source.includes(marker)))
    && keywordServer.includes("대표 포화 키워드 · 세부 고효율 키워드 병행 검토")
    && keywordServer.includes("수요 대비 상품 공급이 적은 SEO 우선 후보")
    && keywordServer.includes("종합 경쟁강도는 ${marketCompetition.label}으로 확인됩니다."),
  metaResearchEndpointDisabled: !serverIndex.includes('import metaResearch from "./handlers/meta-research.mjs"')
    && !serverIndex.includes('url.pathname === "/api/meta-research"'),
  metaAdsToolReady: serverIndex.includes('metaAds: () => import("./handlers/meta-ads.mjs")')
    && serverIndex.includes('url.pathname === "/api/meta-ads"')
    && serverIndex.includes('dispatch("metaAds", request)')
    && metaAdsServer.includes("META_AD_LIBRARY_ACCESS_TOKEN")
    && metaAdsServer.includes("META_AD_LIBRARY_NOT_CONFIGURED")
    && metaAdsServer.includes("ad_reached_countries")
    && metaAdsServer.includes("search_terms")
    && metaAdsServer.includes("isRelevantAd")
    && metaAdsServer.includes("metaAdRelevanceScore")
    && metaAdsServer.includes("META_COMMERCE_CONTEXT_TERMS")
    && metaAdsServer.includes("META_LOW_INTENT_CONTEXT_TERMS")
    && metaAdsServer.includes("const relevantAds")
    && metaAdsServer.includes("item.score >= 2")
    && metaAdsServer.includes("filteredCount")
    && metaAdsServer.includes("normalizePaging")
    && metaAdsServer.includes("snapshotAvailable")
    && metaAdsServer.includes('ad_type: "ALL"')
    && metaAdsServer.includes("ad_snapshot_url")
    && metaAdsServer.includes("ad_creative_link_captions")
    && metaAdsServer.includes("protectedJson")
    && [adminSource, clientSource].every((source) => source.includes('data-meta-card')
      && source.includes("data-meta-query")
      && source.includes("data-meta-results")
      && source.includes("metaAdsLibraryUrl")
      && source.includes("fetchMetaAds")
      && source.includes('status: "ALL"')
      && source.includes("우리 화면에 표시 가능한 광고가 없습니다.")
      && source.includes("initMetaAdsTool")
      && source.includes("광고 조회")
      && source.includes("Meta 공식 API 조회 결과")
      && source.includes("원본 광고 보기")
      && source.includes("Meta 공식 광고 라이브러리"))
    && runtimeEnvCheck.includes('status(env, "Meta Ad Library access token", ["META_AD_LIBRARY_ACCESS_TOKEN", "META_ADS_LIBRARY_ACCESS_TOKEN"], false)')
    && integrationStatusServer.includes("Meta Ad Library access token")
    && integrationStatusServer.includes("metaAdLibrary"),
  naverProductRankLookupHiddenWhileThirtyDayTrackingRemains: !staticAdminProductRankMenu.test(adminSource)
    && !staticClientProductRankMenu.test(clientSource)
    && !staticAdminProductRankView.test(adminSource)
    && !staticClientProductRankView.test(clientSource)
    && [adminSource, clientSource].every((source) => source.includes('target === "naver-rank"')
      && source.includes("rejectedProductRankTarget")
      && source.includes("window.history.replaceState")
      && source.includes("initRankCheck")
      && source.includes("네이버 30일 순위")
      && source.includes("data-rank-card"))
    && adminSource.includes('data-mi-admin-screen="naver-rank-tracking"')
    && adminSource.includes('data-mi-admin-view="naver-rank-tracking"')
    && clientSource.includes('data-mi-screen="naver-rank-tracking"')
    && clientSource.includes('data-mi-view="naver-rank-tracking"'),
  retiredShoppingSearchCannotReturn: [keywordServer, shoppingRankServer].every((source) => !source.includes("/v1/search/shop.json")
    && !source.includes("naver_developers_shopping_search")
    && !source.includes("naver_shopping_official_api_order"))
    && keywordServer.includes("fetchShoppingResultsWindow")
    && shoppingRankServer.includes('NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA = "mi.naver-shopping-organic-window.v1"')
    && shoppingRankServer.includes("collectionId")
    && shoppingRankServer.includes("sourceExhausted")
    && shoppingRankServer.includes("fetchShoppingWindow")
    && shoppingRankServer.includes('source !== "naver_shopping_results_collector"')
    && shoppingRankServer.includes('rankEvidence !== "naver_shopping_organic_list"'),
  rankFeatureLockIsBuildOnlyAndUsageStaysOpen: ![
    serverIndex,
    adminSource,
    clientSource,
    keywordServer,
    shoppingRankServer,
    rankServer,
    placeRankServer,
  ].some((source) => source.includes("check-protected-rank-features"))
    && protectedFeatureLock.n30Freeze?.active === true
    && protectedFeatureLock.n30Freeze?.requires === "explicit-user-request"
    && protectedFeatureLock.n30Freeze?.scope?.includes("N 상품 30일")
    && protectedFeatureLock.n30Freeze?.scope?.includes("N 플레이스 30일")
    && [
      "operation-keyword-lookup",
      "advertiser-keyword-lookup",
      "operation-seo-entry",
      "advertiser-seo-entry",
      "operation-seo-rank-request",
      "advertiser-seo-rank-request",
      "operation-seo-evaluation",
      "advertiser-seo-evaluation",
      "operation-seo-render",
      "advertiser-seo-render",
      "operation-product-rank-check",
      "advertiser-product-rank-check",
      "operation-product-30-day",
      "advertiser-product-30-day",
      "operation-place-30-day",
      "advertiser-place-30-day",
      "keyword-hub-provider-config",
      "keyword-hub-transport",
      "keyword-hub-config-check",
      "keyword-hub-request",
      "keyword-hub-error-message",
      "keyword-hub-search-request",
    ].every((id) => protectedFeatureLock.functions.some((entry) => entry.id === id))
    && [
      "seo-scoring-engine",
      "seo-audit-server",
      "keyword-query-server",
      "product-organic-rank-server",
      "product-tracker-server",
      "product-rank-cron-server",
      "place-tracker-server",
      "place-rank-cron-server",
      "place-collector",
      "place-collector-server",
      "shopping-rank-source-status",
      "shopping-rank-provider-runtime",
      "shopping-rank-mobile-top-fallback",
      "shopping-collector-contract",
      "shopping-collector-provider",
      "shopping-collector-package-manifest",
      "shopping-collector-dependency-lock",
      "shopping-local-worker-auth",
      "shopping-local-worker-handler",
      "shopping-local-worker-contract",
      "shopping-local-worker-schedule",
      "shopping-local-worker-runner",
      "shopping-local-worker-wrapper",
      "shopping-local-worker-installer",
      "shopping-local-worker-profile-bootstrap",
      "shopping-local-worker-launch-agent",
      "shopping-local-worker-schema",
      "shopping-collector-live-gate",
      "shopping-local-worker-router",
      "shopping-runtime-env-gate",
      "place-collector-blueprint",
      "product-cron-workflow",
      "place-cron-workflow",
      "rank-feature-lock-checker",
    ].every((id) => protectedFeatureLock.files.some((entry) => entry.id === id))
    && adminSource.includes("data-admin-keyword-search")
    && clientSource.includes("data-mi-keyword-search")
    && [adminSource, clientSource].every((source) => source.includes("runKeywordLookup")
      && source.includes("data-rank-check-run")
      && source.includes("initRankCheck")
      && source.includes("data-rank-run")
      && source.includes("data-place-rank-run")
      && source.includes('action: "create"'))
    && keywordServer.includes("keywordMarketIndicators")
    && shoppingRankServer.includes("findShoppingRank")
    && rankServer.includes('if (action === "create") return createTracker(request, ctx, body, access);')
    && placeRankServer.includes('if (action === "create") return createTracker(request, ctx, body, access);'),
  releasedToolButtonLabelsClean: [adminSource, clientSource].every((source) => source.includes(">순위 추적<")
    && source.includes('>키워드 조회</a>')
    && !source.includes('>키워드 조회 (개발중)</a>')
    && source.includes('>SEO 확인 (개발중)</a>')
    && !source.includes('>N 상품 순위 (개발중)</a>')
    && !source.includes(">순위 1회 조회<")
    && !source.includes("<small>1회 조회</small>")
    && !source.includes('<span class="mi-badge">1회 조회</span>')
    && !source.includes(">오가닉 추적 시작<")),
  naverPlaceThirtyDayNamingAligned: [adminSource, clientSource].every((source) => source.includes("네이버 플레이스 30일 순위")
    && source.includes("30일 순위 기록")
    && !source.includes("네이버 플레이스 순위 <small>추적</small>")
    && !source.includes("기존 네이버 검색 API 연결 시")),
  naverPlaceTrackingFormUsesFourColumns: [adminSource, clientSource].every((source) => source.includes(".mi-place-rank-card .mi-rank-form.is-tracking")
    && source.includes("grid-template-columns: minmax(150px, 0.8fr) minmax(320px, 1.9fr) 104px auto;")
    && source.includes(".mi-place-rank-item .mi-rank-track-row-head")
    && source.includes("grid-template-columns: minmax(0, 1fr);")),
  naverRankNoResultRangeMessage: [adminSource, clientSource].every((source) => source.includes("rankCheckRangeLabel")
    && source.includes("이내 없음")
    && source.includes("조회 완료: ")
    && source.includes("선택한 조회 범위 안에서 해당 상품을 찾지 못했습니다.")),
  rankTrackingActivePanelRemoved: [adminSource, clientSource].every((source) => !source.includes('<div class="mi-rank-panel" data-rank-result>')),
  rankTrackingProductTitleLinks: [adminSource, clientSource].every((source) => source.includes("rankTrackerProductUrl")
    && source.includes("renderRankProductTitle")
    && source.includes('target="_blank" rel="noopener noreferrer"')
    && source.includes("tracker.productUrl")
    && source.includes("item.link")),
  rankTrackingKeywordAllTabLinks: [adminSource, clientSource].every((source) => source.includes("rankTrackerKeywordUrl")
    && source.includes("renderRankKeywordName")
    && source.includes("https://search.shopping.naver.com/search/all?where=all&frm=NVSCTAB&query=")
    && !source.includes("https://search.shopping.naver.com/ns/search?query=")
    && source.includes("가격비교로 열기")),
  rankTrackingKeywordVolumeVisible: [adminSource, clientSource].every((source) => source.includes("renderRankKeywordVolume")
    && source.includes("keywordVolumeLabel")
    && source.includes("키워드검색량")
    && source.includes("mi-rank-keyword-volume"))
    && rankServer.includes("keywordVolumeLabel")
    && rankServer.includes("fetchSearchAdKeywordVolume")
    && rankServer.includes("NAVER_SEARCHAD_API_KEY"),
  rankTrackingCompactActionColumn: [adminSource, clientSource].every((source) => source.includes("mi-rank-track-main")
    && source.includes("mi-rank-track-primary")
    && source.includes("mi-rank-track-controls")
    && source.includes("grid-template-columns: minmax(0, 1fr) minmax(170px, max-content)")
    && source.includes("grid-template-columns: 78px minmax(68px, 0.38fr) minmax(112px, 0.54fr) minmax(110px, 0.5fr) minmax(84px, 1fr)")
    && !source.includes('<div class="mi-rank-track-meta-line">')
    && /mi-rank-row-actions \{[^}]*justify-self: end;[^}]*width: max-content;[^}]*min-width: 166px;[^}]*padding-left: 2px;[^}]*\}/.test(source)
    && source.includes("font-size: 9.8px")
    && !/mi-rank-row-actions \{[^}]*position: sticky/.test(source)
    && !source.includes("min-width: 980px;")),
  rankTrackingRefreshAll: [adminSource, clientSource].every((source) => source.includes("data-rank-refresh-all")
    && source.includes("refreshAllRankTrackers")
    && source.includes("전체 순위 갱신")
    && source.includes("갱신할 운영중 순위 추적 항목이 없습니다.")
    && source.includes("grid-template-columns: minmax(260px, 1fr) auto auto auto auto;")
    && source.includes("data-rank-bulk-clear>그룹 해제</button>' +")
    && source.includes("data-rank-refresh-all>전체 순위 갱신</button>' +")
    && source.includes("data-rank-download-selected>선택 이미지 저장</button></div></div>")),
  rankTrackingShareImageDownload: [adminSource, clientSource].every((source) => source.includes("data-rank-download-selected")
    && source.includes("선택 이미지 저장")
    && source.includes("downloadSelectedRankTrackers")
    && source.includes("serializeRankExportSheet")
    && source.includes("showRankDownloadReady")
    && source.includes("renderRankExportSheet")
    && source.includes("cloneRankCardForExport")
    && source.includes("mi-rank-export-stage")
    && source.includes("mi-rank-share-image")
    && source.includes("mi-rank-download-ready")
    && source.includes("선택 상품 30일 대표 순위 공유")
    && source.includes("canvas.toBlob")
    && source.includes("reject(error);"))
    && rankDownloadFunctions.every((fn) => fn
      && fn.includes('var statusNode = card ? card.querySelector("[data-rank-status]") : null;')
      && fn.includes("setStatus(statusNode")
      && !fn.includes("setStatus(rankStatus")),
  rankTrackingShareImageTwoRowHistory: [adminSource, clientSource].every((source) => /mi-rank-export-sheet \.mi-rank-day-grid \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: repeat\(15, minmax\(0, 1fr\)\);[\s\S]*?overflow: visible;/.test(source)
    && /mi-rank-export-sheet \.mi-rank-day-card:nth-child\(15n\) \{[\s\S]*?border-right: 0;/.test(source)
    && /mi-rank-export-sheet \.mi-rank-day-card:nth-child\(n \+ 16\) \{[\s\S]*?border-top: 1px solid #e1e8f1;/.test(source)),
  rankTrackingTypographyReduced: [adminSource, clientSource].every((source) => /mi-rank-ops-row \{[\s\S]*?font-size: 11px;/.test(source)
    && /mi-rank-keyword-name \{[\s\S]*?font-size: 13px;/.test(source)
    && /mi-rank-keyword-volume \{[\s\S]*?font-size: 11px;/.test(source)
    && /mi-rank-product-info \{[\s\S]*?font-size: 11px;/.test(source)
    && /mi-rank-product-title \{[\s\S]*?font-size: 11px;/.test(source)
    && /mi-rank-pill \{[\s\S]*?font-size: 10px;/.test(source)
    && /mi-rank-day-slots b \{[\s\S]*?white-space: nowrap;[\s\S]*?word-break: keep-all;/.test(source)),
  rankTrackingDailySlotAlignment: [adminSource, clientSource].every((source) => /mi-rank-day-slots small \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/.test(source)),
  rankTrackingDailySingleRank: [adminSource, clientSource].every((source) => /mi-rank-day-slots \{[\s\S]*?grid-template-columns: 1fr;/.test(source)
    && source.includes("function latestRankSnapshotForDay(day)")
    && source.includes("return snapshots[0] || null;")
    && source.includes('source && source !== "상품" ? source : "순위"')
    && source.includes("renderRankSlot(latestRankSnapshotForDay(day))")
    && !source.includes('renderRankSlot("PM", day.pm)')
    && !source.includes('renderRankSlot("AM", day.am)')),
  rankTrackingInsightLabels: [adminSource, clientSource].every((source) => source.includes("rankTrackerAverageRank")
    && source.includes("rankTrackerChangeLabel")
    && source.includes("rankTrackerInsight")
    && source.includes("7일 평균")
    && source.includes("전회 대비")),
  seoScoringBasisVisible: [adminSource, clientSource].every((source) => source.includes("SEO 점수 기준")
    && source.includes("상품명 적합도 20점")
    && source.includes("키워드 정확·상품군 관련성·50자 이내·중복 및 홍보 문구")
    && source.includes("상위 상품 핵심어 10점")
    && source.includes("상위 오가닉 5개 상품명의 공통어 반영")
    && source.includes("카테고리 적합도 15점")
    && source.includes("상위 오가닉 상품의 세부 카테고리 비교")
    && source.includes("브랜드·제조사 10점")
    && source.includes("공식 상품정보 등록 여부")
    && source.includes("대표 이미지 10점")
    && source.includes("공식 검색 결과 이미지 등록 여부")
    && !source.includes("상품 노출 구조")
    && !source.includes("원부형·단일형 참고 정보 · 점수 제외")
    && source.includes("리뷰 수량 20점")
    && source.includes("현재 리뷰 수량 직접 입력")
    && source.includes("순위·트래픽 15점")
    && source.includes("광고 제외 5위 10점·40위 9점·100위 8점·200위 5점·300위 3점")
    && source.includes("/seo-evaluation.js?v=seo-v13-20260726")
    && source.includes("모든 키워드에 동일 계산식을 적용합니다.")
    && source.includes("정확 키워드가 없어도 동일 상품군과 핵심어 관련성이 확인되면 부분 점수를 반영")
    && source.includes("공식 검색 결과와 직접 입력한 리뷰 수량만 사용해 점검합니다.")
    && !source.includes("상세페이지 80% 이상·상품정보고시 직접 작성")
    && !source.includes("태그 10개·항목별 고시·상세 이미지 8컷")
    && !source.includes("상위 오가닉 상품 최대 5개의 평균 리뷰 대비")
    && !source.includes("API 참고 ")
    && !source.includes("검색 수요·경쟁 25점")
    && !source.includes("운영 설정 15점")
    && !source.includes("트래픽·노출 25점")
    && !source.includes("[data-seo-traffic-count]")
    && !source.includes("[data-seo-order-count]")
    && !source.includes("최근 30일 유입수")
    && !source.includes("최근 30일 구매수")
    && source.includes("[data-seo-review-count]")
    && source.includes('<script src="/seo-evaluation.js?v=seo-v13-20260726"></script>')
    && source.includes("window.MomentSeoEvaluation")),
  seoRankBasisUsesVerifiedOrganicResult: [adminSource, clientSource].every((source) => (
    source.includes('return "광고 제외 오가닉 순위 " + formatNumber(rankResult.rank) + "위 · " + seoRankMatchLabel(rankResult.matchType);')
    && !source.includes('return "공식 검색 API 기준 순위 " + formatNumber(rankResult.rank)')
  )),
  homeRoutesExist: homeSource.includes('href="/client#mi-dashboard"') && homeSource.includes('href="/admin"'),
  rankOwnerAccessBypassesClientRow: rankServer.includes("adminAuthorized && isPrimaryAgencyCode(agencyCode)") && rankServer.includes("clientId: null"),
  rankOwnerCreateLimitBypass: rankServer.includes("const unlimitedOwner") && rankServer.includes("!unlimitedOwner"),
  rankTrackerCompleteListLimit500: rankServer.includes("const TRACKER_LIST_MAX = 500")
    && rankServer.includes("const TRACKER_LIST_QUERY_LIMIT = TRACKER_LIST_MAX + 1")
    && rankServer.includes(".limit(TRACKER_LIST_QUERY_LIMIT)")
    && rankServer.includes('.select(TRACKER_SELECT, { count: "exact" })')
    && rankServer.includes("totalCount: count")
    && rankServer.includes("complete: !hasMore && rows.length === count"),
  rankTrackerRolling30Days: rankServer.includes("const PRODUCT_RANK_HISTORY_DAYS = 30")
    && rankServer.includes("const PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS = 120")
    && rankServer.includes("checkedAt >= historyCutoff")
    && rankServer.includes("slice(0, PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS)")
    && rankServer.includes("addDays(now, 3650)")
    && !rankServer.includes('.gt("ends_at"')
    && !rankServer.includes('lte("ends_at"')
    && !rankServer.includes("30일 추적 기간이 종료되었습니다."),
  rankDeleteMicroInteraction: [adminSource, clientSource].every((source) => source.includes("is-deleting")
    && source.includes("삭제 중")
    && source.includes("translateY(1px) scale(0.97)")
    && source.includes("box-shadow: inset 0 2px 5px")
    && source.includes(".mi-rank-row-actions .mi-link-button:hover")
    && source.includes(".mi-rank-drag-handle:hover")),
  primaryButtonMicroInteraction: [adminSource, clientSource].every((source) => source.includes(".mi-button:hover")
    && source.includes(".mi-button:active")
    && source.includes(".mi-button:focus-visible")
    && source.includes(".mi-button:disabled")
    && source.includes("translateY(1px) scale(0.98)")
    && source.includes("cursor: wait")),
  healthRewriteConfigured: (vercelConfig.rewrites || []).some((rewrite) => rewrite.source === "/health" && rewrite.destination === "/api/health"),
  productionCorsExcludesLocalOrigins: securityServer.includes('"http://127.0.0.1:8793"')
    && securityServer.includes('"http://localhost:8793"')
    && securityServer.includes("productionAllowedOrigins")
    && securityServer.includes('origin !== "*"')
    && securityServer.includes("productionEnvironment()"),
  productionBuildHidesInternalSourceBundle: !staticBuildScript.includes('all: "아임웹_원샷코드_통합보기_모먼트인사이트.html"')
    && !staticBuildScript.includes('path.join(outputDir, "02_아임웹_적용코드")')
    && !staticBuildScript.includes("path.join(outputDir, fileName)")
    && !staticBuildScript.includes('"/all.html"'),
  productionBuildRunsRuntimeEnvGate: vercelConfig.buildCommand === "npm run check:vercel-deploy"
    && packageConfig.scripts?.["check:vercel-env"] === "node scripts/check-runtime-env.mjs --vercel-build"
    && packageConfig.scripts?.["check:vercel-deploy"] === "npm run check:vercel-env && npm run check:release && node scripts/check-naver-shopping-collector-live.mjs --vercel-build"
    && packageConfig.scripts?.["check:release"] === "npm run check:quality && npm run check:production-auth"
    && runtimeEnvCheck.includes('const vercelBuildMode = process.argv.includes("--vercel-build")')
    && runtimeEnvCheck.includes('vercelBuildMode && env.VERCEL_ENV !== "production"')
    && runtimeEnvCheck.includes('reason: "vercel_non_production_build"')
    && shoppingCollectorLiveCheck.includes('const vercelBuildMode = process.argv.includes("--vercel-build")')
    && shoppingCollectorLiveCheck.includes('vercelBuildMode && env.VERCEL_ENV !== "production"')
    && shoppingCollectorLiveCheck.includes('reason: "vercel_non_production_build"')
    && shoppingCollectorLiveCheck.includes("window.checkedCount !== limit")
    && shoppingCollectorLiveCheck.includes("collector_window_short"),
  shoppingLocalWorkerIsSignedReplaySafeAndAtomic: sessionGateSource.includes('"/api/naver-shopping-local-worker"')
    && shoppingLocalWorkerAuth.includes('createHmac("sha256"')
    && shoppingLocalWorkerAuth.includes("timingSafeEqual")
    && shoppingLocalWorkerAuth.includes("x-mi-worker-nonce")
    && shoppingLocalWorkerContract.includes("LOCAL_WORKER_ORGANIC_LIMIT = 300")
    && shoppingLocalWorkerContract.includes("LOCAL_WORKER_REQUEST_TIMEOUT_MS = 14 * 60_000")
    && /NAVER_SHOPPING_PROVIDER_TIMEOUT_MS,\s*14 \* 60_000,\s*30_000,\s*14 \* 60_000/u.test(shoppingLocalWorker)
    && shoppingLocalWorkerContract.includes("validateStrictLocalWorkerWindow")
    && shoppingLocalWorkerHandler.includes("mi_consume_naver_shopping_worker_nonce")
    && shoppingLocalWorkerHandler.includes("mi_commit_naver_shopping_worker_result")
    && shoppingLocalWorkerHandler.includes("mi_fail_naver_shopping_worker_claim")
    && shoppingLocalWorkerMigration.includes("idx_naver_rank_snapshots_tracker_collection")
    && shoppingLocalWorkerMigration.includes("security definer")
    && shoppingLocalWorkerMigration.includes("to service_role"),
  shoppingRankLookupQueueIsScopedAndNonBlocking: [adminSource, clientSource].every((source) =>
    source.includes("getShoppingRankJobsApiUrl")
      && source.includes("queueFullRankLookup")
      && source.includes("순위 작업기에 300위 전체 조회를 요청했습니다."))
    && shoppingRankLookupJobs.includes("rankLookupScopeHash")
    && shoppingRankLookupJobs.includes('.eq("scope_hash", scopeHash)')
    && shoppingRankLookupMigration.includes("force row level security")
    && shoppingRankLookupMigration.includes("for update skip locked")
    && shoppingRankLookupMigration.includes("pg_advisory_xact_lock")
    && shoppingRankLookupGrantMigration.includes("revoke all on table public.naver_shopping_rank_lookup_jobs from service_role")
    && shoppingRankLookupGrantMigration.includes("grant select, insert, update, delete on table public.naver_shopping_rank_lookup_jobs to service_role")
    && shoppingRankLookupJobs.includes('"processing_until"')
    && shoppingRankLookupJobs.includes('code: "RANK_LOOKUP_EXPIRED"')
    && shoppingRankLookupJobs.includes('code: "RANK_LOOKUP_WORKER_STALLED"')
    && shoppingRankLookupJobs.includes("pending: false")
    && shoppingLocalWorkerHandler.includes('body.schedulerVersion === "v2"')
    && shoppingLocalWorkerHandler.includes('LOCAL_WORKER_SCHEDULER_VERSION_STALE')
    && shoppingLocalWorkerHandler.includes('mi_claim_naver_shopping_cycle_keyword')
    && shoppingLocalWorker.includes('schedulerVersion: "v2"')
    && shoppingLocalWorker.includes("preferLookup: !trackerReserved")
    && shoppingWorkerControlMigration.includes("scheduler_urgent_streak between 0 and 2")
    && shoppingWorkerControlMigration.includes("mi_choose_naver_shopping_worker_turn")
    && shoppingWorkerControlMigration.includes("worker_quarantined_until"),
  shoppingVerifiedDirectChromeBridgeIsLeastPrivilegeAndAtomic: JSON.stringify(shoppingChromeManifest.permissions) === JSON.stringify([
    "alarms", "nativeMessaging", "scripting", "storage", "tabs",
  ])
    && JSON.stringify(shoppingChromeManifest.host_permissions) === JSON.stringify([
      "https://search.shopping.naver.com/*",
    ])
    && shoppingChromeWorker.includes("function searchUrl(keyword, pageIndex)")
    && shoppingChromeWorker.includes('new URL("https://search.shopping.naver.com/search/all")')
    && shoppingChromeWorker.includes('searchParams.set("where", "all")')
    && shoppingChromeWorker.includes('searchParams.set("frm", "NVSCTAB")')
    && shoppingChromeWorker.includes('searchParams.set("pagingSize", "40")')
    && shoppingChromeWorker.includes('searchParams.set("productSet", "total")')
    && shoppingChromeWorker.includes('searchParams.set("sort", "rel")')
    && shoppingChromeWorker.includes('searchParams.set("viewType", "list")')
    && shoppingChromeWorker.includes("PAGE_REQUEST_INTERVAL_MS = 3_500")
    && shoppingChromeWorker.includes("PAGE_REQUEST_JITTER_MS = 2_500")
    && shoppingChromeWorker.includes("async function saveCollectionProgress(pageIndex)")
    && shoppingChromeWorker.includes("async function clearCompletedCollectionVerificationState()")
    && shoppingChromeWorker.includes("await saveCollectionProgress(pageIndex)")
    && shoppingChromeWorker.includes("await clearCompletedCollectionVerificationState()")
    && !/www\.naver\.com|search\.naver\.com|네이버 가격비교 더보기|SEARCH_DWELL|readPriceCompareEntry|readNextPageTarget/u.test(shoppingChromeWorker)
    && shoppingChromeWorker.includes("collectPages")
    && shoppingChromeWorker.includes("pagingIndex")
    && shoppingChromeWorker.includes("productSet")
    && shoppingChromeWorker.includes("nextDataText")
    && shoppingChromeWorker.includes('type: "collection_page"')
    && shoppingChromeWorker.includes('type: "collection_complete"')
    && shoppingNativeHost.includes('response?.type === "collection_page"')
    && shoppingNativeHost.includes('response?.type === "collection_complete"')
    && shoppingNativeHost.includes('native_host_input_closed')
    && shoppingNativeHost.includes("RESPONSE_TIMEOUT_MS = 14 * 60_000")
    && shoppingChromeWorker.includes("naver_verification_required")
    && shoppingChromeWorker.includes("naver_network_restricted")
    && shoppingChromeWorker.includes('request.rankPolicy !== "organic_only"')
    && shoppingChromeWorker.includes("chrome.tabs.remove(tabId)")
    && !/\bcookies\b|localStorage|webRequest|browsingData|history/iu.test(shoppingChromeWorker)
    && shoppingNativeHostCore.includes("parseNaverNextDataPage")
    && shoppingNativeHostCore.includes("buildNativeWindowFromRows")
    && shoppingNativeHostCore.includes("appendNormalizedPage")
    && shoppingNativeHostCore.includes("state.items.length !== REQUIRED_LIMIT")
    && shoppingNativeHostCore.includes("validateProviderWindow")
    && shoppingNativeHostCore.includes("pw-chrome-")
    && shoppingNativeHost.includes("runLocalShoppingWorker")
    && shoppingNativeHost.includes("native_host_input_invalid_json")
    && shoppingNativeHost.includes("inputFailure")
    && shoppingNativeHostInstaller.includes("allowed_origins")
    && shoppingNativeHostInstaller.includes("oldAutomaticBrowserWorkerDisabled: true")
    && shoppingNativeHostWrapper.includes("security find-generic-password")
    && shoppingNativeHostWrapper.includes("MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET")
    && shoppingNativeHostInstaller.includes("StartCalendarInterval")
    && shoppingNativeHostInstaller.includes("<integer>600</integer>")
    && shoppingNativeHostInstaller.includes("resolveChromeProfileDirectory")
    && shoppingNativeHostInstaller.includes("activateChromeScheduler")
    && shoppingChromeSchedulerWrapper.includes("/usr/bin/open -gj")
    && shoppingChromeSchedulerWrapper.includes("--profile-directory=")
    && !/remote-debugging|no-sandbox|user-data-dir/iu.test(shoppingChromeSchedulerWrapper),
  shoppingWindowsChromeBridgeIsUserScopedAndWatchdogBounded: shoppingWindowsHostInstaller.includes('Read-Host "Chrome profile visible name or number"')
    && shoppingWindowsHostInstaller.includes("Google\\Chrome\\User Data\\Local State")
    && shoppingWindowsHostInstaller.includes("Add-Type -AssemblyName System.Security -ErrorAction Stop")
    && shoppingWindowsHostInstaller.includes("HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts")
    && shoppingWindowsHostInstaller.includes("[Security.Cryptography.DataProtectionScope]::CurrentUser")
    && shoppingWindowsHostInstaller.includes("-AsSecureString")
    && shoppingWindowsHostInstaller.includes("SetAccessRuleProtection($true, $false)")
    && shoppingWindowsHostInstaller.includes("New-TimeSpan -Minutes 10")
    && shoppingWindowsHostInstaller.includes('CreateFolder("MomentInsight")')
    && shoppingWindowsHostInstaller.includes("-LogonType Interactive -RunLevel Limited")
    && shoppingWindowsHostInstaller.includes("tools/naver-shopping-chrome-extension/service-worker.js")
    && shoppingWindowsHostInstaller.includes("chrome://extensions")
    && !/-AsPlainText|cmdkey|remote-debugging|no-sandbox|user-data-dir/iu.test(shoppingWindowsHostInstaller)
    && shoppingWindowsHostLauncher.includes("ProtectedData.Unprotect")
    && shoppingWindowsHostLauncher.includes("DataProtectionScope.CurrentUser")
    && shoppingWindowsHostLauncher.includes("RedirectStandardInput = false")
    && shoppingWindowsHostLauncher.includes("RedirectStandardOutput = true")
    && shoppingWindowsHostLauncher.includes("child.StandardOutput.BaseStream.CopyTo(output)")
    && shoppingWindowsHostLauncher.includes("outputRelay.Join(5000)")
    && shoppingWindowsHostLauncher.includes("child.WaitForExit()")
    && shoppingWindowsHostLauncher.includes("MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET")
    && shoppingWindowsHostLauncher.includes('String.Equals(maxJobs, "1"')
    && !shoppingWindowsHostLauncher.includes("NAVER_SHOPPING_PROVIDER_TIMEOUT_MS")
    && !/Console\.(?:Write|WriteLine)|StandardInput\.BaseStream/u.test(shoppingWindowsHostLauncher)
    && shoppingWindowsChromeScheduler.includes("'--profile-directory=\"{0}\"' -f $profileDirectory")
    && shoppingWindowsChromeScheduler.includes("$sameChromeRunning")
    && shoppingWindowsChromeScheduler.includes('"--no-startup-window"')
    && shoppingWindowsChromeScheduler.includes("chrome_profile_handoff profile=")
    && shoppingWindowsChromeScheduler.includes("chrome_ready profile=")
    && !/remote-debugging|no-sandbox|user-data-dir/iu.test(shoppingWindowsChromeScheduler),
  shoppingWindowsRuntimeDependenciesAreValidatedAndFingerprinted: shoppingWindowsExtensionUpdater.includes("scripts/naver-shopping-native-host-core.mjs")
    && shoppingWindowsExtensionUpdater.includes("src/server/local-worker-auth.mjs")
    && shoppingWindowsExtensionUpdater.includes("src/server/handlers/naver-shopping-rank.mjs")
    && shoppingWindowsExtensionUpdater.includes("src/server/security.mjs")
    && shoppingWindowsExtensionUpdater.includes("src/server/naver-shopping/source-status.mjs")
    && shoppingWindowsExtensionUpdater.includes("src/server/naver-shopping/provider-runtime.mjs")
    && shoppingWindowsExtensionUpdater.includes("src/server/naver-shopping/mobile-top-fallback.mjs")
    && shoppingWindowsExtensionUpdater.includes("tools/naver-shopping-rank-collector/src/provider.mjs")
    && shoppingWindowsExtensionUpdater.includes("tools/naver-shopping-rank-collector/src/contract.mjs")
    && shoppingWindowsExtensionUpdater.includes("native_host_core_download_empty")
    && shoppingWindowsExtensionUpdater.includes("collector_provider_download_empty")
    && shoppingWindowsExtensionUpdater.includes("collector_contract_download_empty")
    && shoppingWindowsExtensionUpdater.includes("native_host_core_javascript_invalid")
    && shoppingWindowsExtensionUpdater.includes("collector_provider_javascript_invalid")
    && shoppingWindowsExtensionUpdater.includes("collector_contract_javascript_invalid")
    && shoppingWindowsExtensionUpdater.includes("Copy-Item -LiteralPath $stagedNativeHostCore -Destination $nativeHostCorePath -Force")
    && shoppingWindowsExtensionUpdater.includes("Copy-Item -LiteralPath $stagedCollectorProvider -Destination $collectorProviderPath -Force")
    && shoppingWindowsExtensionUpdater.includes("Copy-Item -LiteralPath $stagedCollectorContract -Destination $collectorContractPath -Force")
    && shoppingWindowsExtensionUpdater.includes("native_host_core_sha256=")
    && shoppingWindowsExtensionUpdater.includes("collector_provider_sha256=")
    && shoppingWindowsExtensionUpdater.includes("collector_contract_sha256=")
    && shoppingWindowsExtensionUpdater.includes("HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\$hostName")
    && shoppingWindowsExtensionUpdater.includes("$nativeManifestNeedsRepair = -not")
    && shoppingWindowsExtensionUpdater.includes("Write-Utf8NoBom -Path $nativeManifestPath")
    && shoppingWindowsExtensionUpdater.includes("native_host_manifest_repair_failed")
    && shoppingWindowsExtensionUpdater.includes("native_host_manifest_path_mismatch")
    && shoppingWindowsExtensionUpdater.includes("native_host_manifest_origin_mismatch")
    && shoppingWindowsExtensionUpdater.includes("Set-Item -Path $nativeRegistryPath -Value $nativeManifestPath")
    && shoppingWindowsExtensionUpdater.includes("native_host_registry_mismatch")
    && shoppingWindowsExtensionUpdater.includes("native_host_registry_synced=true")
    && shoppingWindowsExtensionUpdater.includes("$ExpectedVersion`n$serviceWorkerHash`n$nativeHostHash`n$nativeHostCoreHash`n$localWorkerHash`n$localWorkerAuthHash`n$localWorkerContractHash`n$shoppingRankHandlerHash`n$securityHash`n$sourceStatusHash`n$providerRuntimeHash`n$mobileTopFallbackHash`n$collectorProviderHash`n$collectorContractHash")
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
    && shoppingNativeHost.includes('sha256File(new URL("./naver-shopping-native-host-core.mjs"')
    && shoppingNativeHost.includes('sha256File(new URL("../src/server/local-worker-auth.mjs"')
    && shoppingNativeHost.includes('sha256File(new URL("../src/server/handlers/naver-shopping-rank.mjs"')
    && shoppingNativeHost.includes('sha256File(new URL("../src/server/security.mjs"')
    && shoppingNativeHost.includes('sha256File(new URL("../src/server/naver-shopping/source-status.mjs"')
    && shoppingNativeHost.includes('sha256File(new URL("../src/server/naver-shopping/provider-runtime.mjs"')
    && shoppingNativeHost.includes('sha256File(new URL("../src/server/naver-shopping/mobile-top-fallback.mjs"')
    && shoppingNativeHost.includes('sha256File(new URL("../tools/naver-shopping-rank-collector/src/provider.mjs"')
    && shoppingNativeHost.includes('sha256File(new URL("../tools/naver-shopping-rank-collector/src/contract.mjs"'),
  shoppingChromeCatchUpQueueIsBounded: shoppingChromeWorker.includes("BASELINE_CADENCE_MINUTES = 10")
    && shoppingChromeWorker.includes("CANDIDATE_CADENCE_MINUTES = 6")
    && shoppingChromeWorker.includes('["rank-catch-up", { delayInMinutes: cadenceMinutes, periodInMinutes: cadenceMinutes }]')
    && shoppingChromeWorker.includes("existing.periodInMinutes")
    && !shoppingChromeWorker.includes("rank-drain-follow-up")
    && shoppingChromeWorker.includes("PAGE_REQUEST_INTERVAL_MS = 3_500")
    && shoppingChromeWorker.includes("PAGE_REQUEST_JITTER_MS = 2_500")
    && shoppingChromeWorker.includes("VERIFICATION_COOLDOWN_MS = 60 * 60_000")
    && shoppingChromeWorker.includes("NAVER_ACCESS_COOLDOWN_CODES")
    && shoppingNativeHostWrapper.includes('MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS="1"')
    && shoppingChromeWorker.includes('failed > 0 ? "partial" : "completed"'),
  shoppingRemoteWakeIsAtomicAndOneJobBounded: shoppingChromeManifest.version === "1.1.19"
    && shoppingChromeManifest.icons?.[16] === "icon16.png"
    && shoppingChromeManifest.icons?.[128] === "icon128.png"
    && shoppingChromeWorker.includes('["rank-remote", { delayInMinutes: 1, periodInMinutes: 1 }]')
    && shoppingChromeWorker.includes('result.status === "standby" || result.status === "idle"')
    && shoppingChromeWorker.includes('result.status === "standby"')
    && shoppingNativeHost.includes('requireWakeSignal: trigger === "rank-remote"')
    && shoppingNativeHost.includes('runTrigger: trigger')
    && shoppingNativeHost.includes('writeMessage({ type: "ready", collectionProtocol: COLLECTION_PROTOCOL })')
    && shoppingNativeHost.includes('readyAck = await nextMessage(30_000)')
    && shoppingChromeWorker.includes('port.postMessage(nativeReadyAcknowledgement(message))')
    && shoppingChromeWorker.includes('return { action: "ready_ack", collectionProtocol: COLLECTION_PROTOCOL }')
    && shoppingChromeWorker.includes('port.postMessage({ action: "run", trigger, ...runtimeIdentity })')
    && shoppingLocalWorker.includes('const EXPECTED_RUNTIME_VERSION = "1.1.19";')
    && shoppingLocalWorkerHandler.includes('const EXPECTED_WORKER_RUNTIME_VERSION = "1.1.19";')
    && rankServer.includes('const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "1.1.19";')
    && shoppingChromeWorker.includes("chrome.runtime.getManifest().version")
    && shoppingChromeWorker.includes('crypto.subtle.digest(\n        "SHA-256"')
    && shoppingNativeHost.includes("async function runtimeIdentity(start)")
    && shoppingNativeHost.includes("registerProgressSink(sink)")
    && shoppingChromeWorker.includes("async function requestWorkerRun(trigger)")
    && shoppingChromeWorker.includes("void runWorker(trigger)")
    && shoppingChromeWorker.includes("chrome.runtime.connectNative(NATIVE_HOST)")
    && shoppingChromeWorker.includes("WORKER_KEEPALIVE_INTERVAL_MS = 20_000")
    && shoppingChromeWorker.includes("function startWorkerKeepAlive()")
    && shoppingChromeWorker.includes("const timer = setInterval(heartbeat, WORKER_KEEPALIVE_INTERVAL_MS)")
    && shoppingChromeWorker.includes("return () => clearInterval(timer)")
    && shoppingChromeWorker.includes("if (stopKeepAlive) stopKeepAlive()")
    && shoppingChromeWorker.includes("async function removeLegacyControllerTabs()")
    && /async function initializeWorker\(\)[\s\S]*?extensionRuntimeIdentity\(\)[\s\S]*?INITIALIZATION_SAFE_STATUSES\.has\(storedStatus\)[\s\S]*?markCandidateCadenceResetPending\(runtimeIdentity\)[\s\S]*?storedStatus === "running"[\s\S]*?saveStatus\("failed", "native_host_interrupted"\)[\s\S]*?configureAlarms\(\)[\s\S]*?await removeLegacyControllerTabs\(\)/.test(shoppingChromeWorker)
    && /async function requestWorkerRun\(trigger\)[\s\S]*?await initializationPromise/.test(shoppingChromeWorker)
    && !shoppingChromePopupHtml.includes('<script src="service-worker.js"></script>')
    && shoppingChromePopup.includes('chrome.runtime.sendMessage({ action: "run-now" })')
    && shoppingChromePopupHtml.includes('<button id="run" type="button">지금 안전 갱신</button>')
    && shoppingChromeWorker.includes("automaticVerificationCooldownActive(trigger)")
    && shoppingChromeWorker.includes("verification.blockedUntil > Date.now()")
    && shoppingChromeWorker.includes("selectPendingTrigger(currentTrigger, candidateTrigger)")
    && shoppingChromeWorker.includes('candidate === "rank-remote"')
    && shoppingChromeWorker.includes("const nextTrigger = takePendingTrigger()")
    && shoppingChromeWorker.includes("PENDING_TRIGGER_HANDOFF_MS = 6_000")
    && shoppingChromeWorker.includes('result.status === "control_plane_failed"')
    && shoppingChromeWorker.includes('result.status !== "completed"')
    && shoppingWindowsChromeScheduler.includes("chrome_profile_handoff profile=")
    && shoppingWindowsChromeScheduler.includes('"--no-startup-window"')
    && shoppingChromeWorker.includes('saveStatus("standby", "다음 갱신 요청 대기 중")')
    && shoppingChromeWorker.includes("RUNNING_STATUS_STALE_MS = 20 * 60_000")
    && shoppingChromeWorker.includes("typedCollectionError(error, collectionStageCode)")
    && shoppingChromeWorker.includes('collectionStageCode = "naver_page_navigation_failed"')
    && shoppingLocalWorker.includes('options.requireWakeSignal === true')
    && shoppingLocalWorker.includes('const wake = await action({ action: "claim-wake", ...lanePayload })')
    && shoppingLocalWorker.includes('action: "claim-lane"')
    && shoppingLocalWorker.includes('action: "release-lane"')
    && shoppingLocalWorker.includes('action: "block-lane"')
    && shoppingLocalWorker.includes("TRACKER_ISOLATED_FAILURE_CODES")
    && shoppingLocalWorker.includes('"provider_duplicate_identity"')
    && shoppingLocalWorkerHandler.includes('body.action === "claim-wake"')
    && shoppingLocalWorkerHandler.includes('claimShoppingWorkerWake(ctx)')
    && shoppingWorkerWake.includes('mi_request_naver_shopping_worker_wake')
    && shoppingWorkerWake.includes('mi_claim_naver_shopping_worker_wake')
    && shoppingWorkerWakeMigration.includes('force row level security')
    && shoppingWorkerWakeMigration.includes('security invoker')
    && !shoppingWorkerWakeMigration.includes('security definer')
    && shoppingWorkerWakeMigration.includes('consumed_at is null or consumed_at < requested_at')
    && shoppingWorkerWakeMigration.includes('to service_role')
    && shoppingWorkerLaneMigration.includes('primary_seen_at')
    && shoppingWorkerLaneMigration.includes('mi_claim_naver_shopping_worker_lane')
    && shoppingWorkerLaneMigration.includes('mi_block_naver_shopping_worker_lane')
    && shoppingWorkerLaneMigration.includes('security invoker')
    && !shoppingWorkerLaneMigration.includes('security definer')
    && shoppingWorkerContinuityMigration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.1'")
    && shoppingWorkerContinuityMigration.includes("if coalesce(p_has_new, false) then")
    && shoppingWorkerContinuityMigration.includes("current_row.runtime_version = '1.1.1'")
    && shoppingWorkerContinuityMigration.includes("security invoker")
    && !shoppingWorkerContinuityMigration.includes("security definer")
    && shoppingWorkerContinuityMigration.includes("to service_role")
    && shoppingWorkerCycleOverflowMigration.includes("worker_last_cycle_deferred_at")
    && shoppingWorkerCycleOverflowMigration.includes("case when tracker.id = seed.id then 0 else 1 end asc")
    && shoppingWorkerCycleOverflowMigration.includes("tracker.last_checked_at asc nulls first")
    && /limit 100\s+for update skip locked/iu.test(shoppingWorkerCycleOverflowMigration)
    && shoppingWorkerCycleOverflowMigration.includes("worker_last_cycle_id = current_row.scheduler_cycle_id")
    && shoppingWorkerCycleOverflowMigration.includes("'deferredCount', v_deferred_count")
    && shoppingWorkerCycleOverflowMigration.includes("'groupSize', v_claim_count + v_deferred_count")
    && shoppingWorkerCycleOverflowMigration.includes("'tracker_deferred'")
    && shoppingWorkerCycleOverflowMigration.includes("idx_naver_shopping_scheduler_events_cycle_deferred_once")
    && shoppingWorkerCycleOverflowMigration.includes("mi_audit_naver_shopping_tracker_deferred")
    && shoppingWorkerCycleOverflowMigration.includes("security invoker")
    && shoppingWorkerCycleOverflowMigration.includes("from public, anon, authenticated, service_role")
    && shoppingWorkerCycleOverflowMigration.includes("to service_role")
    && !/set\s+(?:current_rank|last_checked_at|next_check_at|last_error|retry_count)\s*=/iu.test(shoppingWorkerCycleOverflowMigration)
    && shoppingWorkerRuntime112Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.2'")
    && shoppingWorkerRuntime112Migration.includes("current_row.runtime_version = '1.1.2'")
    && shoppingWorkerRuntime112Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime112Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime112Migration.includes("security invoker")
    && !shoppingWorkerRuntime112Migration.includes("security definer")
    && shoppingWorkerRuntime112Migration.includes("to service_role")
    && shoppingWorkerRuntime113Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.3'")
    && shoppingWorkerRuntime113Migration.includes("current_row.runtime_version = '1.1.3'")
    && shoppingWorkerRuntime113Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime113Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime113Migration.includes("security invoker")
    && !shoppingWorkerRuntime113Migration.includes("security definer")
    && shoppingWorkerRuntime113Migration.includes("to service_role")
    && shoppingWorkerRuntime114Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.4'")
    && shoppingWorkerRuntime114Migration.includes("current_row.runtime_version = '1.1.4'")
    && shoppingWorkerRuntime114Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime114Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime114Migration.includes("security invoker")
    && !shoppingWorkerRuntime114Migration.includes("security definer")
    && shoppingWorkerRuntime114Migration.includes("to service_role")
    && shoppingWorkerRuntime115Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.5'")
    && shoppingWorkerRuntime115Migration.includes("current_row.runtime_version = '1.1.5'")
    && shoppingWorkerRuntime115Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime115Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime115Migration.includes("security invoker")
    && !shoppingWorkerRuntime115Migration.includes("security definer")
    && shoppingWorkerRuntime115Migration.includes("to service_role")
    && shoppingWorkerRuntime116Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.6'")
    && shoppingWorkerRuntime116Migration.includes("current_row.runtime_version = '1.1.6'")
    && shoppingWorkerRuntime116Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime116Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime116Migration.includes("security invoker")
    && !shoppingWorkerRuntime116Migration.includes("security definer")
    && shoppingWorkerRuntime116Migration.includes("to service_role")
    && shoppingWorkerRuntime117Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.7'")
    && shoppingWorkerRuntime117Migration.includes("current_row.runtime_version = '1.1.7'")
    && shoppingWorkerRuntime117Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime117Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime117Migration.includes("security invoker")
    && !shoppingWorkerRuntime117Migration.includes("security definer")
    && shoppingWorkerRuntime117Migration.includes("to service_role")
    && shoppingWorkerRuntime118Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.8'")
    && shoppingWorkerRuntime118Migration.includes("current_row.runtime_version = '1.1.8'")
    && shoppingWorkerRuntime118Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime118Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime118Migration.includes("security invoker")
    && !shoppingWorkerRuntime118Migration.includes("security definer")
    && shoppingWorkerRuntime118Migration.includes("to service_role")
    && shoppingWorkerRuntime119Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.9'")
    && shoppingWorkerRuntime119Migration.includes("current_row.runtime_version = '1.1.9'")
    && shoppingWorkerRuntime119Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime119Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime119Migration.includes("set cadence_mode = 'baseline',\n    cadence_minutes = 10,\n    stability_started_at = null,\n    success_streak = 0")
    && shoppingWorkerRuntime119Migration.includes("runtime_version is distinct from trim(p_runtime_version)")
    && shoppingWorkerRuntime119Migration.includes("runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))")
    && shoppingWorkerRuntime119Migration.includes("'transient_system_probe_attempts', current_row.transient_system_probe_attempts")
    && /'candidate_eligible',[\s\S]+current_row\.circuit_state = 'closed'[\s\S]+and processing_count = 0[\s\S]+current_row\.runtime_version = '1\.1\.9'/u.test(shoppingWorkerRuntime119Migration)
    && /for update;[\s\S]+status = 'processing' and processing_until > v_now[\s\S]+status = 'active' and processing_until > v_now[\s\S]+into processing_count;[\s\S]+eligible :=[\s\S]+and processing_count = 0/u.test(shoppingWorkerRuntime119Migration)
    && shoppingWorkerRuntime119Migration.includes("security invoker")
    && !shoppingWorkerRuntime119Migration.includes("security definer")
    && shoppingWorkerRuntime119Migration.includes("to service_role")
    && shoppingWorkerRuntime110Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.10'")
    && shoppingWorkerRuntime110Migration.includes("current_row.runtime_version = '1.1.10'")
    && shoppingWorkerRuntime110Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime110Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime110Migration.includes("set cadence_mode = 'baseline',\n    cadence_minutes = 10,\n    stability_started_at = null,\n    success_streak = 0")
    && shoppingWorkerRuntime110Migration.includes("runtime_version is distinct from trim(p_runtime_version)")
    && shoppingWorkerRuntime110Migration.includes("runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))")
    && shoppingWorkerRuntime110Migration.includes("'transient_system_probe_attempts', current_row.transient_system_probe_attempts")
    && /'candidate_eligible',[\s\S]+current_row\.circuit_state = 'closed'[\s\S]+and processing_count = 0[\s\S]+current_row\.runtime_version = '1\.1\.10'/u.test(shoppingWorkerRuntime110Migration)
    && /for update;[\s\S]+status = 'processing' and processing_until > v_now[\s\S]+status = 'active' and processing_until > v_now[\s\S]+into processing_count;[\s\S]+eligible :=[\s\S]+and processing_count = 0/u.test(shoppingWorkerRuntime110Migration)
    && shoppingWorkerRuntime110Migration.includes("security invoker")
    && !shoppingWorkerRuntime110Migration.includes("security definer")
    && shoppingWorkerRuntime110Migration.includes("from public, anon, authenticated, service_role")
    && shoppingWorkerRuntime110Migration.includes("to service_role")
    && shoppingWorkerRuntime111Migration.replaceAll("1.1.11", "1.1.10") === shoppingWorkerRuntime110Migration
    && shoppingWorkerRuntime111Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.11'")
    && shoppingWorkerRuntime111Migration.includes("current_row.runtime_version = '1.1.11'")
    && shoppingWorkerRuntime111Migration.includes("last_collection_id ~ '^pw-chrome-'")
    && shoppingWorkerRuntime111Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime111Migration.includes("last_source = 'naver_shopping_results_collector'")
    && shoppingWorkerRuntime111Migration.includes("set cadence_mode = 'baseline',\n    cadence_minutes = 10,\n    stability_started_at = null,\n    success_streak = 0")
    && shoppingWorkerRuntime111Migration.includes("runtime_version is distinct from trim(p_runtime_version)")
    && shoppingWorkerRuntime111Migration.includes("runtime_fingerprint is distinct from lower(trim(p_runtime_fingerprint))")
    && /'candidate_eligible',[\s\S]+current_row\.circuit_state = 'closed'[\s\S]+and processing_count = 0[\s\S]+current_row\.runtime_version = '1\.1\.11'/u.test(shoppingWorkerRuntime111Migration)
    && /for update;[\s\S]+status = 'processing' and processing_until > v_now[\s\S]+status = 'active' and processing_until > v_now[\s\S]+into processing_count;[\s\S]+eligible :=[\s\S]+and processing_count = 0/u.test(shoppingWorkerRuntime111Migration)
    && (shoppingWorkerRuntime111Migration.match(/security invoker/gu) || []).length === 3
    && (shoppingWorkerRuntime111Migration.match(/set search_path = ''/gu) || []).length === 3
    && !shoppingWorkerRuntime111Migration.includes("security definer")
    && shoppingWorkerRuntime111Migration.includes("from public, anon, authenticated, service_role")
    && shoppingWorkerRuntime111Migration.includes("to service_role")
    && shoppingWorkerRuntime1112Migration.replaceAll("1.1.12", "1.1.11") === shoppingWorkerRuntime111Migration
    && shoppingWorkerRuntime1112Migration.includes("trim(coalesce(p_runtime_version, '')) <> '1.1.12'")
    && shoppingWorkerRuntime1112Migration.includes("current_row.runtime_version = '1.1.12'")
    && shoppingWorkerRuntime1112Migration.includes("last_collection_id ~ '^pw-chrome-'")
    && shoppingWorkerRuntime1112Migration.includes("last_checked_count = 300")
    && shoppingWorkerRuntime1112Migration.includes("last_source = 'naver_shopping_results_collector'")
    && (shoppingWorkerRuntime1112Migration.match(/security invoker/gu) || []).length === 3
    && (shoppingWorkerRuntime1112Migration.match(/set search_path = ''/gu) || []).length === 3
    && !shoppingWorkerRuntime1112Migration.includes("security definer")
    && shoppingWorkerRuntime1112Migration.includes("from public, anon, authenticated, service_role")
    && shoppingWorkerRuntime1112Migration.includes("to service_role")
    && shoppingStableProofLedgerMigration.includes("mi_audit_naver_shopping_snapshot_commit")
    && shoppingStableProofLedgerMigration.includes("crossPageProofVersion")
    && shoppingStableProofLedgerMigration.includes("stable-full-window-v1")
    && !/(?:captureIds|passDigests|collisionDigest)/u.test(shoppingStableProofLedgerMigration)
    && shoppingStableProofQuarantineMigration.includes("provider_stable_window_unproven")
    && shoppingStableProofQuarantineMigration.includes("then v_now + interval '30 minutes'")
    && shoppingStableProofQuarantineMigration.includes("security invoker")
    && !shoppingStableProofQuarantineMigration.includes("security definer")
    && shoppingStableProofQuarantineMigration.includes("mi_release_naver_shopping_worker_lane")
    && shoppingStableProofQuarantineMigration.includes("auto_navigation_recovered")
    && shoppingStableProofQuarantineMigration.includes("to service_role")
    && shoppingAutoNavigationHalfOpenMigration.includes("mi_claim_naver_shopping_worker_lane")
    && shoppingAutoNavigationHalfOpenMigration.includes("normalized_worker_role = 'primary'")
    && shoppingAutoNavigationHalfOpenMigration.includes("circuit_reason = 'navigating:naver_page_navigation_failed'")
    && shoppingAutoNavigationHalfOpenMigration.includes("circuit_opened_at <= v_now - interval '10 minutes'")
    && shoppingAutoNavigationHalfOpenMigration.includes("circuit_reason = 'auto_navigation_probe'")
    && shoppingAutoNavigationHalfOpenMigration.includes("'autoRecovery', current_row.circuit_reason = 'auto_navigation_probe'")
    && shoppingAutoNavigationHalfOpenMigration.includes("mi_record_naver_shopping_worker_success")
    && shoppingAutoNavigationHalfOpenMigration.includes("p_checked_count is distinct from 300")
    && shoppingAutoNavigationHalfOpenMigration.includes("security invoker")
    && !shoppingAutoNavigationHalfOpenMigration.includes("security definer")
    && shoppingAutoNavigationHalfOpenMigration.includes("to service_role")
    && !/(?:next_check_at|scheduler_cycle_cursor_\w+)\s*=/iu.test(shoppingAutoNavigationHalfOpenMigration)
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("mi_release_naver_shopping_worker_lane")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("current_row.circuit_reason = 'auto_navigation_probe'")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("current_row.current_stage = 'failed'")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("when auto_navigation_recovered then 'closed'")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("when current_row.circuit_state = 'half_open' then 'open'")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("circuit_reason = 'probe_incomplete'")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("primary_seen_at > clock_timestamp() - interval '5 minutes'")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("last_failure_at > clock_timestamp() - interval '1 day'")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("security invoker")
    && !shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("security definer")
    && shoppingAutoNavigationTrackerFailureRecoveryMigration.includes("to service_role")
    && !/(?:next_check_at|worker_quarantined_until|scheduler_cycle_cursor_\w+|worker_last_cycle_id)\s*=/iu.test(shoppingAutoNavigationTrackerFailureRecoveryMigration)
    && shoppingProbeIncompleteAutoRecoveryMigration.includes("mi_claim_naver_shopping_worker_lane")
    && shoppingProbeIncompleteAutoRecoveryMigration.includes("'probe_incomplete'")
    && shoppingProbeIncompleteAutoRecoveryMigration.includes("'probe_interrupted'")
    && shoppingProbeIncompleteAutoRecoveryMigration.includes("= 'naver_page_navigation_failed'")
    && shoppingProbeIncompleteAutoRecoveryMigration.includes("circuit_opened_at <= v_now - interval '10 minutes'")
    && shoppingProbeIncompleteAutoRecoveryMigration.includes("circuit_reason = 'auto_navigation_probe'")
    && shoppingProbeIncompleteAutoRecoveryMigration.includes("security invoker")
    && !shoppingProbeIncompleteAutoRecoveryMigration.includes("security definer")
    && shoppingProbeIncompleteAutoRecoveryMigration.includes("to service_role")
    && !/(?:next_check_at|worker_quarantined_until|scheduler_cycle_cursor_\w+|worker_last_cycle_id)\s*=/iu.test(shoppingProbeIncompleteAutoRecoveryMigration)
    && shoppingTransientSystemRecoveryMigration.includes("transient_system_probe_attempts integer not null default 0")
    && shoppingTransientSystemRecoveryMigration.includes("check (transient_system_probe_attempts between 0 and 2)")
    && shoppingTransientSystemRecoveryMigration.includes("transient_failure_code in (")
    && shoppingTransientSystemRecoveryMigration.includes("'native_host_response_timeout'")
    && shoppingTransientSystemRecoveryMigration.includes("'provider_deadline_exceeded'")
    && shoppingTransientSystemRecoveryMigration.includes("current_row.transient_system_probe_attempts < 2")
    && shoppingTransientSystemRecoveryMigration.includes("circuit_opened_at <= v_now - interval '30 minutes'")
    && shoppingTransientSystemRecoveryMigration.includes("circuit_reason = 'auto_transient_system_probe'")
    && shoppingTransientSystemRecoveryMigration.includes("p_checked_count is distinct from 300")
    && shoppingTransientSystemRecoveryMigration.includes("transient_system_recovered")
    && shoppingTransientSystemRecoveryMigration.includes("force row level security")
    && shoppingTransientSystemRecoveryMigration.includes("security invoker")
    && !shoppingTransientSystemRecoveryMigration.includes("security definer")
    && shoppingTransientSystemRecoveryMigration.includes("from public, anon, authenticated, service_role")
    && shoppingTransientSystemRecoveryMigration.includes("to service_role")
    && shoppingTransientSystemRecoveryTests.includes("transient recovery excludes security, network, generic and integrity failures")
    && /if current_row\.circuit_state = 'open'[\s\S]*normalized_worker_role = 'primary'[\s\S]*transient_failure_code in \(\s*'native_host_response_timeout',\s*'provider_deadline_exceeded',\s*'native_host_input_closed'\s*\)[\s\S]*current_row\.transient_system_probe_attempts < 2[\s\S]*circuit_opened_at <= v_now - interval '30 minutes'[\s\S]*update public\.naver_shopping_worker_coordination/u.test(shoppingNativeInputClosedHalfOpenMigration)
    && /where lane_key = 'global'\s*and circuit_state = 'open'[\s\S]*split_part\(lower\(trim\(coalesce\(last_failure_code, ''\)\)\), ':', 1\) in \(\s*'native_host_response_timeout',\s*'provider_deadline_exceeded',\s*'native_host_input_closed'\s*\)[\s\S]*and transient_system_probe_attempts < 2[\s\S]*and circuit_opened_at <= v_now - interval '30 minutes'[\s\S]*and \(lease_until is null or lease_until <= v_now\)/u.test(shoppingNativeInputClosedHalfOpenMigration)
    && (shoppingNativeInputClosedHalfOpenMigration.match(/'native_host_input_closed'/gu) || []).length === 2
    && shoppingNativeInputClosedHalfOpenMigration.includes("transient_system_probe_attempts = least(2, current_row.transient_system_probe_attempts + 1)")
    && shoppingNativeInputClosedHalfOpenMigration.includes("circuit_reason = 'auto_transient_system_probe'")
    && shoppingNativeInputClosedHalfOpenMigration.includes("security invoker")
    && !shoppingNativeInputClosedHalfOpenMigration.includes("security definer")
    && shoppingNativeInputClosedHalfOpenMigration.includes("from public, anon, authenticated, service_role")
    && shoppingNativeInputClosedHalfOpenMigration.includes("to service_role")
    && !/(?:update public\.naver_rank_trackers|next_check_at\s*=|worker_quarantined_until\s*=|scheduler_cycle_cursor_\w+\s*=|insert into public\.naver_shopping_worker_wakes)/iu.test(shoppingNativeInputClosedHalfOpenMigration)
    && /transient_failure_code in \(\s*'native_host_response_timeout',\s*'provider_deadline_exceeded',\s*'native_host_input_closed',\s*'naver_page_timeout',\s*'naver_page_script_timeout',\s*'local_worker_commit_unavailable'\s*\)/u.test(shoppingErrorTaxonomyHardeningMigration)
    && (shoppingErrorTaxonomyHardeningMigration.match(/'naver_page_timeout'/gu) || []).length === 2
    && (shoppingErrorTaxonomyHardeningMigration.match(/'naver_page_script_timeout'/gu) || []).length === 2
    && (shoppingErrorTaxonomyHardeningMigration.match(/'local_worker_commit_unavailable'/gu) || []).length === 2
    && shoppingErrorTaxonomyHardeningMigration.includes("normalized_worker_role = 'primary'")
    && shoppingErrorTaxonomyHardeningMigration.includes("current_row.transient_system_probe_attempts < 2")
    && shoppingErrorTaxonomyHardeningMigration.includes("circuit_opened_at <= v_now - interval '30 minutes'")
    && /normalized_error in \(\s*'naver_captcha_detected',\s*'naver_auth_required',\s*'naver_verification_required',\s*'naver_access_blocked',\s*'naver_http_403'\s*\) then 3600/u.test(shoppingErrorTaxonomyHardeningMigration)
    && !/transient_failure_code in \([^)]*(?:naver_access_blocked|naver_http_403)/iu.test(shoppingErrorTaxonomyHardeningMigration)
    && shoppingErrorTaxonomyHardeningMigration.includes("normalized_scope not in ('system', 'tracker', 'security', 'lookup')")
    && shoppingErrorTaxonomyHardeningMigration.includes("normalized_scope = 'lookup' and p_tracker_id is not null")
    && shoppingErrorTaxonomyHardeningMigration.includes("normalized_scope <> 'lookup' or circuit_state = 'closed'")
    && shoppingErrorTaxonomyLookupBranch.includes("lease_worker_id = null")
    && shoppingErrorTaxonomyLookupBranch.includes("lease_token = null")
    && shoppingErrorTaxonomyLookupBranch.includes("lease_until = null")
    && shoppingErrorTaxonomyLookupBranch.includes("run_id = null")
    && shoppingErrorTaxonomyLookupBranch.includes("cadence_mode = 'baseline'")
    && shoppingErrorTaxonomyLookupBranch.includes("cadence_minutes = 10")
    && shoppingErrorTaxonomyLookupBranch.includes("stability_started_at = null")
    && shoppingErrorTaxonomyLookupBranch.includes("success_streak = 0")
    && shoppingErrorTaxonomyLookupBranch.includes("'laneReleased', true")
    && shoppingErrorTaxonomyLookupBranch.includes("'quarantined', false")
    && !/(?:failure_signature|failure_streak|circuit_state|circuit_reason|circuit_opened_at|next_signature|next_streak|should_open)\s*=/iu.test(shoppingErrorTaxonomyLookupBranch)
    && !/(?:update public\.naver_rank_trackers|worker_quarantined_until|next_check_at|worker_last_cycle_id|scheduler_cycle_cursor_\w+)\s*=?/iu.test(shoppingErrorTaxonomyLookupBranch)
    && shoppingErrorTaxonomyHardeningMigration.includes("create or replace function public.mi_release_naver_shopping_worker_lane")
    && /transient_system_recovered := current_row\.circuit_state = 'half_open'[\s\S]*split_part\(lower\(trim\(coalesce\(current_row\.last_failure_code, ''\)\)\), ':', 1\) in \([\s\S]*'local_worker_window_not_300'[\s\S]*'local_worker_match_result_incomplete'[\s\S]*\)/iu.test(shoppingErrorTaxonomyHardeningMigration)
    && shoppingErrorTaxonomyHardeningMigration.includes("revoke all on function public.mi_release_naver_shopping_worker_lane(text, uuid)")
    && shoppingErrorTaxonomyHardeningMigration.includes("grant execute on function public.mi_release_naver_shopping_worker_lane(text, uuid)")
    && (shoppingErrorTaxonomyHardeningMigration.match(/security invoker/gu) || []).length === 4
    && (shoppingErrorTaxonomyHardeningMigration.match(/set search_path = ''/gu) || []).length === 4
    && !shoppingErrorTaxonomyHardeningMigration.includes("security definer")
    && shoppingErrorTaxonomyHardeningMigration.includes("from public, anon, authenticated, service_role")
    && shoppingErrorTaxonomyHardeningMigration.includes("to service_role")
    && shoppingTransientSystemRecoveryTests.includes("two repeated lookup failures release only the lane and preserve a closed zero-streak circuit")
    && shoppingTransientSystemRecoveryTests.includes("access blocked and HTTP 403 stay in a 60-minute security block lane, never half-open")
    && shoppingTransientSystemRecoveryTests.includes("half-open release treats the new tracker-only failures as a recovered transport probe")
    && shoppingSchedulerEventLedgerMigration.includes("create schema if not exists mi_internal authorization postgres")
    && shoppingSchedulerEventLedgerMigration.includes("force row level security")
    && shoppingSchedulerEventLedgerMigration.includes("grant select on table public.naver_shopping_scheduler_events")
    && shoppingSchedulerEventLedgerMigration.includes("'new_after_start'")
    && shoppingSchedulerEventLedgerMigration.includes("'fullCycleEvidenceStartsWithNextCycle', true")
    && !/grant execute on function (?:public|mi_internal)\.mi_audit_/iu.test(shoppingSchedulerEventLedgerMigration)
    && !/create unique index[^;]*scheduled_(?:group|tracker)/iu.test(shoppingSchedulerEventLedgerMigration)
    && shoppingDuplicateQuarantineMigration.includes("mi_record_naver_shopping_worker_failure")
    && shoppingDuplicateQuarantineMigration.includes("split_part(normalized_error, ':', 1) = 'provider_duplicate_identity'")
    && shoppingDuplicateQuarantineMigration.includes("then v_now + interval '30 minutes'")
    && shoppingDuplicateQuarantineMigration.includes("coalesce(retry_count, 0) >= 2 then interval '24 hours'")
    && shoppingDuplicateQuarantineMigration.includes("worker_quarantined_until > greatest(v_now, updated_at + interval '30 minutes')")
    && shoppingDuplicateQuarantineMigration.includes("security invoker")
    && !shoppingDuplicateQuarantineMigration.includes("security definer")
    && shoppingDuplicateQuarantineMigration.includes("to service_role")
    && !/set\s+(?:sort_order|next_check_at|worker_last_cycle_id|retry_count|current_rank|last_checked_at|scheduler_cycle_cursor)/iu.test(shoppingDuplicateQuarantineMigration)
    && shoppingLocalWorkerHandler.includes('mi_claim_naver_shopping_cycle_keyword')
    && shoppingLocalWorkerHandler.includes('rawClaims.length > 100')
    && shoppingLocalWorkerHandler.includes('CATALOG_HISTORY_BATCH_MAX = 8')
    && shoppingRankLookupLeasePrecisionMigration.includes("date_trunc('milliseconds', clock_timestamp())")
    && shoppingRankLookupLeasePrecisionMigration.includes('processing_started_at = v_lease_started_at')
    && shoppingRankLookupLeasePrecisionMigration.includes("date_trunc('milliseconds', v_job.processing_started_at)")
    && shoppingRankLookupLeasePrecisionMigration.includes("date_trunc('milliseconds', processing_started_at)")
    && shoppingRankLookupLeasePrecisionMigration.includes('to service_role')
    && shoppingRankLookupJobs.includes('requestShoppingWorkerWake(ctx, "rank-lookup")')
    && rankServer.includes('requestShoppingWorkerWake(ctx, "tracker-refresh-all")')
    && rankServer.includes('loadShoppingWorkerStatus')
    && rankServer.includes('"naver_shopping_worker_coordination"')
    && [adminSource, clientSource].every((source) =>
      source.includes('queuedPayload.remoteWakeRequested === true')
        && source.includes('개발 프로필에 원격 실행을 요청했습니다.')
        && source.includes('data-rank-worker-state')
        && source.includes('네이버 쇼핑 접속 제한으로 일시정지했습니다.')
        && source.includes('기존 정상 순위와 30일 기록은 유지합니다.')),
  shoppingCandidateCadence111Regression: shoppingWorkerCandidateExactIdentityMigration
    .replaceAll("1.1.12", "1.1.11")
    .replaceAll(
      "862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e",
      "6461e835e840ff873711f38a223ab1a7a06b3e2945822a92cce49e50a295cf00",
    ) === shoppingWorkerCandidate111ExactIdentityMigration,
  shoppingCandidate6RuntimeExactIdentityAndRunProvenance:
    shoppingWorkerRuntime1113Candidate6Migration.includes("-- Runtime 1.1.13 candidate 6-minute cadence")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("create table if not exists public.naver_shopping_worker_runs")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("run_id uuid primary key")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("run_trigger text not null")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("on conflict (run_id) do nothing")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("naver_shopping_worker_run_provenance_mismatch")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("p_run_trigger text")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("cadence_mode = 'candidate' and cadence_minutes = 6")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("set cadence_mode = 'candidate', cadence_minutes = 6")
    && shoppingWorkerRuntime1113Candidate6Migration.includes("'mode', 'candidate', 'minutes', 6")
    && (shoppingWorkerRuntime1113Candidate6Migration.match(
      new RegExp(`runtime_fingerprint = '${shoppingWorkerRuntime1113Fingerprint}'`, "gu"),
    ) || []).length === 3
    && shoppingWorkerRuntime1113Candidate6Migration.includes("grant select, insert on table public.naver_shopping_worker_runs")
    && !shoppingWorkerRuntime1113Candidate6Migration.includes("security definer")
    && !shoppingWorkerRuntime1113Candidate6Migration.includes("cadence_mode = 'candidate' and cadence_minutes = 8")
    && shoppingLocalWorker.includes("MI_NAVER_SHOPPING_RUN_TRIGGER")
    && shoppingLocalWorkerHandler.includes("p_run_trigger: control.runTrigger")
    && shoppingNativeHost.includes("CHROME_RUN_TRIGGERS = new Set")
    && shoppingNativeHost.includes("runTrigger: trigger"),
  shoppingRuntime1116ExactParentProofExactIdentity:
    shoppingStableFiniteWindowMigration.includes("stable-finite-window-v1")
    && shoppingStableFiniteWindowMigration.includes("c0ccded2-9bf7-488e-af8d-00898c0a1ff8")
    && shoppingStableFiniteWindowMigration.includes("13327339525")
    && shoppingStableFiniteWindowMigration.includes("59776958987")
    && shoppingStableFiniteWindowMigration.includes("finite_window_committed")
    && shoppingStableFiniteWindowMigration.includes("atomicSuccessEligible")
    && shoppingStableFiniteWindowMigration.includes("checked_count between 1 and 299")
    && shoppingStableFiniteWindowMigration.includes("revoke insert, update, delete on table public.naver_rank_snapshots")
    && shoppingStableFiniteWindowMigration.includes(shoppingWorkerRuntime1114Fingerprint)
    && shoppingStableFiniteWindowRuntime1115Migration.includes("target.runtime_version is distinct from '1.1.14'")
    && shoppingStableFiniteWindowRuntime1115Migration.includes(shoppingWorkerRuntime1114Fingerprint)
    && shoppingStableFiniteWindowRuntime1115Migration.includes("set runtime_version = '1.1.15'")
    && shoppingStableFiniteWindowRuntime1115Migration.includes(shoppingWorkerRuntime1115Fingerprint)
    && shoppingStableFiniteWindowRuntime1115Migration.includes("set cadence_mode = 'candidate', cadence_minutes = 6")
    && shoppingStableFiniteWindowRuntime1115Migration.includes("security invoker")
    && shoppingStableFiniteWindowRuntime1115Migration.includes("set search_path = ''")
    && shoppingExactParentRelationGuardMigration.includes("mi_guard_naver_shopping_exact_parent_snapshot")
    && shoppingExactParentRelationGuardMigration.includes("catalog_seller_product_id")
    && shoppingExactParentRelationGuardMigration.includes("catalogSellerProductIds")
    && shoppingExactParentRelationGuardMigration.includes("naver_shopping_exact_parent_relation_guard")
    && shoppingExactParentRelationGuardMigration.includes("security invoker")
    && shoppingExactParentRelationGuardMigration.includes("set search_path = ''")
    && shoppingStableFiniteWindowRuntime1116Migration.includes("target.runtime_version is distinct from '1.1.15'")
    && shoppingStableFiniteWindowRuntime1116Migration.includes(shoppingWorkerRuntime1115Fingerprint)
    && shoppingStableFiniteWindowRuntime1116Migration.includes("set runtime_version = '1.1.16'")
    && shoppingStableFiniteWindowRuntime1116Migration.includes("570ffc52d411f2ae34e247b77d7fb645d36f4478b624ed56926a6ccc00b6159f")
    && shoppingNextDataSchemaDriftRecoveryMigration.includes("570ffc52d411f2ae34e247b77d7fb645d36f4478b624ed56926a6ccc00b6159f")
    && shoppingNextDataSchemaDriftRecoveryMigration.includes("8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1")
    && shoppingNextDataSchemaDriftRecoveryMigration.includes("naver_next_data_schema_drift:compositelist_list_[0-9]+_type")
    && shoppingNextDataSchemaDriftRecoveryMigration.includes("last_checked_count is distinct from 300")
    && shoppingNextDataSchemaDriftRecoveryMigration.includes("circuit_state = 'closed'")
    && shoppingNextDataSchemaDriftRecoveryMigration.includes("runtime_fingerprint = null")
    && shoppingSupersavingCompositeRecoveryMigration.includes("8772da2f70e2e7aa0d35d4cfd4b09436d3da5a1211e83f687c9a6e9bcf9e0bd1")
    && shoppingSupersavingCompositeRecoveryMigration.includes(shoppingWorkerRuntime1116Fingerprint)
    && shoppingSupersavingCompositeRecoveryMigration.includes("^collecting:naver_next_data_schema_drift:compositelist_list_[0-9]+_type_supersaving$")
    && shoppingSupersavingCompositeRecoveryMigration.includes("^naver_next_data_schema_drift:compositelist_list_[0-9]+_type_supersaving$")
    && shoppingSupersavingCompositeRecoveryMigration.includes("last_checked_count is distinct from 300")
    && shoppingSupersavingCompositeRecoveryMigration.includes("set cadence_mode = 'baseline'")
    && shoppingSupersavingCompositeRecoveryMigration.includes("circuit_state = 'closed'")
    && shoppingSupersavingCompositeRecoveryMigration.includes("runtime_fingerprint = null")
    && shoppingSupersavingCompositeRecoveryMigration.includes("post_row.scheduler_cycle_cursor_tracker_id is distinct from prior_row.scheduler_cycle_cursor_tracker_id")
    && shoppingSupersavingCompositeRecoveryMigration.includes("post_row.last_collection_id is distinct from prior_row.last_collection_id")
    && shoppingSupersavingCompositeRecoveryMigration.includes("post_row.last_failure_code is distinct from prior_row.last_failure_code")
    && !/update public\.naver_rank_trackers|update public\.naver_shopping_rank_lookup_jobs|insert into public\.naver_shopping_worker_events|create or replace function public\./iu.test(
      shoppingSupersavingCompositeRecoveryMigration,
    )
    && shoppingStableFiniteWindowRuntime1117Migration.includes("target.runtime_version is distinct from '1.1.16'")
    && shoppingStableFiniteWindowRuntime1117Migration.includes(shoppingWorkerRuntime1116Fingerprint)
    && shoppingStableFiniteWindowRuntime1117Migration.includes("set runtime_version = '1.1.17'")
    && shoppingStableFiniteWindowRuntime1117Migration.includes(shoppingWorkerRuntime1117Fingerprint)
    && shoppingStableFiniteWindowRuntime1117Migration.includes("set cadence_mode = 'candidate', cadence_minutes = 6")
    && shoppingStableFiniteWindowRuntime1117Migration.includes("security invoker")
    && shoppingStableFiniteWindowRuntime1117Migration.includes("set search_path = ''")
    && shoppingStableFiniteWindowRuntime1118Migration.includes("current_row.runtime_version is distinct from '1.1.17'")
    && shoppingStableFiniteWindowRuntime1118Migration.includes(shoppingWorkerRuntime1117Fingerprint)
    && shoppingStableFiniteWindowRuntime1118Migration.includes("set runtime_version = '1.1.18'")
    && shoppingStableFiniteWindowRuntime1118Migration.includes(shoppingWorkerRuntime1118Fingerprint)
    && shoppingStableFiniteWindowRuntime1118Migration.includes("expected_runtime_version constant text := '1.1.18'")
    && shoppingStableFiniteWindowRuntime1118Migration.includes("target_updated_count <> prior_target_count")
    && shoppingStableFiniteWindowRuntime1118Migration.includes("security invoker")
    && shoppingStableFiniteWindowRuntime1118Migration.includes("set search_path = ''")
    && shoppingStableRenderedOrderRuntime1119Migration.includes("current_row.runtime_version is distinct from '1.1.18'")
    && shoppingStableRenderedOrderRuntime1119Migration.includes(shoppingWorkerRuntime1118Fingerprint)
    && shoppingStableRenderedOrderRuntime1119Migration.includes("set runtime_version = '1.1.19'")
    && shoppingStableRenderedOrderRuntime1119Migration.includes(shoppingWorkerRuntime1119Fingerprint)
    && shoppingStableRenderedOrderRuntime1119Migration.includes("expected_runtime_version constant text := '1.1.19'")
    && shoppingStableRenderedOrderRuntime1119Migration.includes("target_updated_count <> prior_target_count")
    && shoppingStableRenderedOrderRuntime1119Migration.includes("provider_stable_rendered_order_unproven")
    && shoppingStableRenderedOrderRuntime1119Migration.includes("provider_rendered_order_candidate_invalid")
    && shoppingStableRenderedOrderRuntime1119Migration.includes("security invoker")
    && shoppingStableRenderedOrderRuntime1119Migration.includes("set search_path = ''")
    && shoppingStableFiniteWindowRuntime1116Migration.includes("set cadence_mode = 'candidate', cadence_minutes = 6")
    && shoppingStableFiniteWindowRuntime1116Migration.includes("security invoker")
    && shoppingStableFiniteWindowRuntime1116Migration.includes("set search_path = ''")
    && shoppingCandidatePerformanceAudit.includes('export const N30_TARGET_RUNTIME_VERSION = "1.1.19";')
    && shoppingCandidatePerformanceAudit.includes(shoppingWorkerRuntime1119Fingerprint)
    && !shoppingStableFiniteWindowMigration.includes("__N30_RUNTIME_1_1_14_FINGERPRINT__")
    && !shoppingStableFiniteWindowRuntime1116Migration.includes("__N30_RUNTIME_1_1_16_FINGERPRINT__")
    && !shoppingNextDataSchemaDriftRecoveryMigration.includes("__N30_RUNTIME_1_1_16_FINGERPRINT__")
    && !shoppingSupersavingCompositeRecoveryMigration.includes("__N30_RUNTIME_1_1_16_FINGERPRINT__"),
  shoppingCandidateCadenceExactIdentityAndIdle: shoppingWorkerCandidateExactIdentityMigration.includes("-- Runtime 1.1.12 exact candidate gate")
    && (shoppingWorkerCandidateExactIdentityMigration.match(/create or replace function public\./gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/security invoker/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/set search_path = ''/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/runtime_fingerprint = '862b3779b7f4c96db52005a090888d80facb653a598a5141093557cb2eef7e8e'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.circuit_state = 'closed'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.circuit_reason is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/processing_count = 0/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.lease_worker_id is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.lease_token is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.lease_until is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.run_id is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.current_stage is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.current_page = 0/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.current_job_kind is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.current_tracker_id is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.current_job_started_at is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.probe_started_at is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.probe_tracker_id is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.cooldown_until is null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.primary_worker_id = 'windows-desktop-primary'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.primary_seen_at > v_now - interval '3 minutes'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.cadence_mode = 'baseline'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.cadence_minutes = 10/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.stability_started_at is not null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.stability_started_at <= v_now - interval '24 hours'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.success_streak >= 6/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.last_success_at is not null/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.last_success_at > v_now - interval '15 minutes'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.runtime_version = '1\.1\.12'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.last_collection_id ~ '\^pw-chrome-'/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.last_checked_count = 300/gu) || []).length === 2
    && (shoppingWorkerCandidateExactIdentityMigration.match(/current_row\.last_source = 'naver_shopping_results_collector'/gu) || []).length === 2
    && /where lane_key = 'global'\s*for update;[\s\S]*into processing_count;[\s\S]*eligible :=/u.test(shoppingWorkerCandidateExactIdentityMigration)
    && shoppingWorkerCandidateExactIdentityMigration.includes("from public, anon, authenticated, service_role")
    && shoppingWorkerCandidateExactIdentityMigration.includes("to service_role")
    && !/stability_started_at\s*=/u.test(shoppingWorkerCandidateExactIdentityMigration)
    && !/success_streak\s*=/u.test(shoppingWorkerCandidateExactIdentityMigration)
    && !shoppingWorkerCandidateExactIdentityMigration.includes("security definer"),
  shoppingAtomicSuccessProofIsLedgerSnapshotLockedAndIdempotent: shoppingAtomicSuccessProofHardeningMigration.includes("-- N Shopping atomic success proof hardening")
    && /into representative_commit_count[\s\S]+committed\.event_type = 'tracker_committed'[\s\S]+committed\.run_id = p_run_id[\s\S]+committed\.worker_id = current_row\.lease_worker_id[\s\S]+committed\.tracker_id = p_tracker_id[\s\S]+committed\.collection_id = normalized_collection_id[\s\S]+committed\.checked_count = 300[\s\S]+committed\.details ->> 'source' = 'naver_shopping_results_collector'[\s\S]+representative_commit_count <> 1/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /select committed\.claim_id, committed\.group_fingerprint\s+into group_claim_id, expected_group_fingerprint[\s\S]+committed\.event_type = 'tracker_committed'[\s\S]+committed\.run_id = p_run_id[\s\S]+committed\.worker_id = current_row\.lease_worker_id[\s\S]+committed\.tracker_id = p_tracker_id[\s\S]+committed\.collection_id = normalized_collection_id[\s\S]+committed\.checked_count = 300[\s\S]+committed\.details ->> 'source' = 'naver_shopping_results_collector'/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /current_row\.current_job_kind is distinct from 'tracker'[\s\S]+current_row\.current_tracker_id is distinct from p_tracker_id[\s\S]+atomic_current_job_mismatch/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /event\.claim_id = group_claim_id[\s\S]+failed\.claim_id = group_claim_id[\s\S]+claimed\.claim_id = group_claim_id[\s\S]+claimed\.claim_id = group_claim_id[\s\S]+committed\.claim_id = group_claim_id[\s\S]+committed\.claim_id = group_claim_id[\s\S]+claimed\.claim_id = group_claim_id[\s\S]+committed\.claim_id = claimed\.claim_id/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /event\.event_type = 'group_claimed'[\s\S]+group_claim_count <> 1/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /failed\.event_type = 'job_failed'[\s\S]+atomic_run_failed/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /claimed\.event_type = 'tracker_claimed'[\s\S]+tracker_claim_count < 1/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /committed\.event_type = 'tracker_committed'[\s\S]+committed_count <> tracker_claim_count/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /from public\.naver_rank_snapshots as snapshot[\s\S]+snapshot\.checked_count = 300[\s\S]+snapshot\.source = 'naver_shopping_results_collector'/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /snapshot\.matched = false or snapshot\.item -> 'isOrganic' = 'true'::jsonb/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && shoppingAtomicSuccessProofHardeningMigration.includes("snapshot.item -> 'adExcluded' = 'true'::jsonb")
    && shoppingAtomicSuccessProofHardeningMigration.includes("snapshot.item ->> 'rankPolicy' = 'organic_only'")
    && shoppingAtomicSuccessProofHardeningMigration.includes("snapshot.item ->> 'rankEvidence' = 'naver_shopping_organic_list'")
    && /top_item -> 'isOrganic' is distinct from 'true'::jsonb[\s\S]+top_item -> 'isAd' is distinct from 'false'::jsonb/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /if current_row\.last_collection_id = normalized_collection_id then[\s\S]+'alreadyRecorded', true[\s\S]+end if;[\s\S]+next_success_streak :=/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && shoppingAtomicSuccessProofHardeningMigration.includes("'alreadyRecorded', false")
    && (shoppingAtomicSuccessProofHardeningMigration.match(/security invoker/gu) || []).length === 2
    && (shoppingAtomicSuccessProofHardeningMigration.match(/set search_path = ''/gu) || []).length === 2
    && (shoppingAtomicSuccessProofHardeningMigration.match(/v_now timestamptz;/gu) || []).length === 2
    && (shoppingAtomicSuccessProofHardeningMigration.match(/for update;\s+v_now := clock_timestamp\(\);/gu) || []).length === 2
    && (shoppingAtomicSuccessProofHardeningMigration.match(/grant execute on function public\./gu) || []).length === 2
    && /revoke all on function public\.mi_record_naver_shopping_worker_success\([^)]+\)\s+from public, anon, authenticated, service_role;/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /grant execute on function public\.mi_record_naver_shopping_worker_success\([^)]+\)\s+to service_role;/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /revoke all on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s+from public, anon, authenticated, service_role;/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && /grant execute on function public\.mi_set_naver_shopping_worker_cadence\(text\)\s+to service_role;/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && !/v_now timestamptz\s*:=/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && !/grant execute on function public\.[\s\S]+to (?:public|anon|authenticated)/u.test(shoppingAtomicSuccessProofHardeningMigration)
    && !shoppingAtomicSuccessProofHardeningMigration.includes("security definer"),
  shoppingCandidateResponseRequiresExactCandidateSixMinutes: rankServer.includes("if (result?.accepted !== true) return false;")
    && rankServer.includes("if (result?.activated !== true) return false;")
    && rankServer.includes('if (mode === "candidate") return result?.mode === "candidate" && result?.minutes === 6;')
    && rankServer.includes("shoppingWorkerControlAccepted(action, result, cadenceMode)")
    && rankServer.includes("rejected ? 409 : 200"),
  shoppingWorkerFailureBoundariesStayScopedAndBounded: shoppingLocalWorkerContract.includes("LOCAL_WORKER_BODY_MAX_BYTES = 4 * 1024 * 1024")
    && shoppingLocalWorkerContract.includes("LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS * 1000")
    && shoppingLocalWorkerAuth.includes("LOCAL_WORKER_MAX_CLOCK_SKEW_SECONDS = 5 * 60")
    && shoppingLocalWorker.includes('"provider_row_invalid"')
    && shoppingLocalWorker.includes('"provider_row_title_missing"')
    && shoppingLocalWorker.includes('"provider_row_identity_missing"')
    && shoppingLocalWorker.includes('action: "reconcile-submit"')
    && shoppingLocalWorker.includes("submitClaimOutcome(partial, job")
    && shoppingLocalWorker.includes("explicitOutcome.uncommittedClaims")
    && !shoppingLocalWorker.includes("job.claims.slice(processedCount)")
    && shoppingLocalWorkerHandler.includes('body.action === "reconcile-submit"')
    && shoppingLocalWorkerHandler.includes('.from("naver_rank_snapshots")')
    && shoppingLocalWorkerHandler.includes("claimResults")
    && shoppingLocalWorker.includes("processedCount !== job.claims.length")
    && shoppingNativeHostCore.includes("native_host_request_id_mismatch")
    && serverIndex.includes("LOCAL_WORKER_BODY_MAX_BYTES"),
  shoppingManualExtensionQueuesEntireTrackerSite: shoppingChromeManifest.version === "1.1.19"
    && shoppingChromeWorker.includes('port.postMessage({ action: "run", trigger, ...runtimeIdentity })')
    && shoppingChromeWorker.includes('setTimeout(() => finish(new Error("native_host_timeout")), 30 * 60_000)')
    && shoppingLocalWorkerHandler.includes("WORKER_COLLECTION_LEASE_SECONDS = 35 * 60")
    && rankServer.includes("MIN_RANK_TRACKER_LEASE_MS = 1000 * 60 * 35")
    && shoppingNativeHost.includes('WHOLE_SITE_QUEUE_TRIGGERS = new Set(["manual", "rank-catch-up"])')
    && shoppingNativeHost.includes('runTrigger: trigger')
    && shoppingNativeHost.includes('queueAllTrackers: WHOLE_SITE_QUEUE_TRIGGERS.has(trigger)')
    && shoppingNativeHost.includes('await writeTerminalMessage({ type: "summary", summary })')
    && shoppingNativeHost.includes("process.stdin.destroy()")
    && shoppingWindowsHostLauncher.indexOf("child.WaitForExit();")
      < shoppingWindowsHostLauncher.indexOf("singleInstance.ReleaseMutex();")
    && shoppingWindowsHostLauncher.indexOf("singleInstance.ReleaseMutex();")
      < shoppingWindowsHostLauncher.indexOf("outputRelay.Join(5000)")
    && shoppingLocalWorker.includes('action({ action: "queue-all-active-trackers", ...lanePayload })')
    && shoppingLocalWorkerHandler.includes('body.action === "queue-all-active-trackers"')
    && shoppingLocalWorkerHandler.includes('mi_queue_naver_shopping_cycle')
    && shoppingLocalWorkerHandler.includes('alreadyQueued')
    && shoppingLocalWorkerHandler.includes('cycleStartedAt')
    && !shoppingLocalWorkerHandler.slice(
      shoppingLocalWorkerHandler.indexOf("async function queueAllActiveTrackers"),
      shoppingLocalWorkerHandler.indexOf("function json"),
    ).includes("next_check_at")
    && !shoppingLocalWorkerHandler.slice(
      shoppingLocalWorkerHandler.indexOf("async function queueAllActiveTrackers"),
      shoppingLocalWorkerHandler.indexOf("function json"),
    ).includes("agency_code"),
  shoppingCollectorFailureClassificationIsFailClosed: shopping418Failure.status === "unavailable"
    && shopping418Failure.retryable === false
    && shopping418Failure.retryAfterSeconds === 0
    && shopping429Failure.status === "error"
    && shopping429Failure.retryable === true
    && shopping429Failure.retryAfterSeconds === 5
    && shoppingRankSourceStatus.includes("status === 429")
    && shoppingRankSourceStatus.includes("naver[_ -]?http[_ -]?429")
    && shoppingRankSourceStatus.includes("http[_ -]?(?:403|418)")
    && shoppingRankSourceStatus.includes("captcha[_ -]?detected"),
  shoppingCollectorColdStartBudgetIsBounded: shoppingProviderDefaults.requestTimeoutMs === 90_000
    && shoppingProviderDefaults.prewarmTimeoutMs === 75_000
    && shoppingProviderRuntime.includes("const DEFAULT_REQUEST_TIMEOUT_MS = 90_000")
    && shoppingProviderRuntime.includes("const DEFAULT_PREWARM_TIMEOUT_MS = 75_000")
    && shoppingProviderRuntime.includes("runtime.prewarmTimeoutMs, 1_000, 90_000")
    && shoppingProviderRuntime.includes('lastResult.ready || ["unavailable", "unauthorized", "misconfigured"].includes(lastResult.status)')
    && shoppingProviderRuntime.includes("providerPrewarmCache.delete(cacheKey)"),
  shoppingLocalWorkerLaunchIsBounded: shoppingLocalWorker.includes("MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS")
    && shoppingLocalWorker.includes("acquireWorkerLock")
    && shoppingLocalWorker.includes("local_worker_window_not_300")
    && shoppingLocalWorkerWrapper.includes("MAX_ATTEMPTS=3")
    && shoppingLocalWorkerWrapper.includes("security find-generic-password")
    && shoppingLocalWorkerWrapper.includes("caffeinate -i -s")
    && shoppingLocalWorkerPlist.includes("<key>StartInterval</key>")
    && shoppingLocalWorkerPlist.includes("<integer>300</integer>")
    && shoppingCollectorLiveCheck.includes("verifiedHybridWorkerEvidence"),
  shoppingCollectorDependencyIsPinnedAndLocked: /^\d+\.\d+\.\d+$/u.test(shoppingPlaywrightVersion)
    && shoppingCollectorPackageLock.lockfileVersion === 3
    && shoppingCollectorPackageLock.packages?.[""]?.dependencies?.playwright === shoppingPlaywrightVersion,
  shoppingCollectorProductionGateRequiresAtomic300: shoppingCollectorContract.includes("const MAX_RANK_LIMIT = 300")
    && shoppingCollectorContract.includes("value.items.length !== value.checkedCount")
    && shoppingCollectorContract.includes("validateItem(item, index + 1, request.limit)")
    && shoppingCollectorContract.includes("provider_ad_item_rejected")
    && shoppingCollectorLiveCheck.includes('argValue("limit", "300")')
    && shoppingCollectorLiveCheck.includes("window.complete !== true")
    && shoppingCollectorLiveCheck.includes("window.checkedCount !== limit")
    && shoppingCollectorLiveCheck.includes("collector_window_short"),
  shoppingCollectorSamePageRankSlotsStayAtomic: shoppingCollectorProvider.includes('if (collisionKind !== "duplicate_row" && !preserveStableCrossPage)')
    && shoppingCollectorProvider.includes('"provider_duplicate_identity"')
    && shoppingCollectorProvider.includes("buildStableFullWindowProof")
    && shoppingCollectorProvider.includes("stableFullWindowEvidence")
    && shoppingCollectorContract.includes("const NAVER_SHOPPING_PAGE_SIZE = 40")
    && shoppingCollectorContract.includes('STABLE_FULL_WINDOW_PROOF_VERSION = "stable-full-window-v1"')
    && shoppingCollectorContract.includes("stableWindowDigest")
    && shoppingCollectorContract.includes("stableCollisionDigest")
    && shoppingCollectorContract.includes("const identityOrigins = new Map()")
    && shoppingCollectorContract.includes("Math.ceil(originRank / NAVER_SHOPPING_PAGE_SIZE)")
    && shoppingCollectorContract.includes("Math.ceil(item.organicRank / NAVER_SHOPPING_PAGE_SIZE)")
    && shoppingNativeHostCore.includes("PAGE_NAVIGATION_BUDGET = 16")
    && shoppingNativeHostCore.includes("stableProofPass: 2")
    && shoppingNativeHostCore.includes("buildStableFullWindowProof")
    && shoppingRankServer.includes("trustedStableCrossPageProof")
    && shoppingRankServer.includes("stableWindowDigest")
    && shoppingRankServer.includes("stableCollisionDigest")
    && shoppingLocalWorker.includes('"provider_partial_window"')
    && shoppingLocalWorker.includes('detail.replace("/", "_")'),
  rankCronEndpointReady: read("src/server/index.mjs").includes('url.pathname === "/api/naver-rank-cron"')
    && rankCronServer.includes("Unauthorized cron request")
    && rankCronServer.includes('NAVER_RANK_PROVIDER_NOT_CONFIGURED = "NAVER_RANK_PROVIDER_NOT_CONFIGURED"')
    && rankCronServer.includes("productRankCronProviderConfigured")
    && rankCronServer.includes("claimed: 0")
    && cronAuthServer.includes("CRON_SECRET")
    && cronAuthServer.includes("MI_RANK_CRON_SECRET")
    && cronAuthServer.includes("safeEqual"),
  reportCenterEndpointReady: serverIndex.includes('url.pathname === "/api/report-center"')
    && serverIndex.includes('reportCenter: () => import("./handlers/report-center.mjs")')
    && serverIndex.includes("dispatch(\"reportCenter\", request)")
    && reportCenterServer.includes('withSupabase({ auth: "none" }')
    && reportCenterServer.includes("x-mi-agency-code")
    && reportCenterServer.includes("x-mi-team-code")
    && reportCenterServer.includes("x-mi-super-admin-code"),
  workOperationEndpointReady: serverIndex.includes('url.pathname === "/api/work-items"')
    && serverIndex.includes('workItems: () => import("./handlers/work-items.mjs")')
    && serverIndex.includes('dispatch("workItems", request)')
    && workItemsServer.includes('withSupabase({ auth: "none" }')
    && workItemsServer.includes('request.headers.get("x-mi-session-role")')
    && workItemsServer.includes("roleCanMutateWorkItems")
    && workItemsServer.includes("clientWorkItemPayload"),
  workOperationIsPrivateByDefault: workItemsMigration.includes("alter column visibility set default 'internal'")
    && workItemsMigration.includes("operation_team_id uuid references public.operation_team_codes")
    && workItemsMigration.includes("idx_schedule_items_operation_team_start")
    && workItemsServer.includes("requestedVisible ? VISIBLE : INTERNAL")
    && workItemsServer.includes("광고주 연결 후 공개할 수 있습니다.")
    && workItemsTests.includes("account-only team cannot publish a work item")
    && workItemsTests.includes("client payload excludes internal and tenant fields"),
  // 대표 결재(2026-08-25): 광고주 화면의 "운영팀이 공개한 일정" 뷰는 개인 캘린더가 대체한다.
  // 업무 운영(admin)은 그대로다. 광고주 쪽은 이제 메뉴·화면이 개인 캘린더여야 하고,
  // 옛 공개 일정 뷰로 들어가는 경로가 남아 있으면 안 된다(마크업·데이터는 보존).
  workOperationRoleUiReady: adminSource.includes('data-mi-admin-screen="work">업무 운영</a>')
    && adminSource.includes('data-mi-admin-view="work"')
    && adminSource.includes("내부 메모 · 광고주 비공개")
    && adminSource.includes("loadWorkItems")
    && clientSource.includes('data-mi-screen="my-calendar">내 캘린더</a>')
    && clientSource.includes('data-mi-view="my-calendar"')
    && clientSource.includes("data-mi-personal-calendar")
    && !/<a\b[^>]*data-mi-screen="schedule"/u.test(clientSource)
    && clientSource.includes('var retiredScheduleTarget = target === "schedule";')
    && clientSource.includes('if (retiredScheduleTarget) target = "my-calendar";'),
  workOperationDragMoveRequiresConfirmation: adminSource.includes('draggable="\' + (canEdit ? "true" : "false") + \'" data-work-edit="')
    && adminSource.includes("function workItemCanEdit(item)")
    && adminSource.includes('data-work-drop-date="')
    && adminSource.includes("openWorkMoveConfirmation")
    && adminSource.includes("workShiftDateTime")
    && adminSource.includes("data-work-move-confirm")
    && adminSource.includes("확인 후에만 저장됩니다.")
    && adminSource.includes("일정 변경을 저장하지 못해 원래 날짜로 되돌렸습니다.")
    && adminSource.includes("event.pointerType === \"mouse\"")
    && adminSource.includes("320);"),
  workOperationCalendarCellCreatesAndDialogIsPremium: adminSource.includes('data-work-cell-date="')
    && adminSource.includes('event.target.closest("[data-work-cell-date]")')
    && adminSource.includes("mi-work-dialog-eyebrow")
    && adminSource.includes("mi-work-switch")
    && adminSource.includes("필요한 정보만 입력하면 일정과 가까운 업무에 함께 반영됩니다."),
  workCalendarPersonalOnlyAndMonthlyRecurrenceAreReleaseGated: !adminSource.includes("function renderWorkCalendarRail")
    && !adminSource.includes("data-work-calendar-list")
    && !adminSource.includes("data-work-calendar-select")
    && !adminSource.includes("data-work-calendar-share")
    && !adminSource.includes("에메랄드")
    && adminSource.includes("개인 일정 등록")
    && adminSource.includes("function workItemsQuery")
    && adminSource.includes("payload.truncated")
    && workItemsServer.includes('cleanText(body.action).startsWith("calendar-")')
    && workItemsServer.includes("calendars: []")
    && !workItemsServer.includes("schedule_calendar_memberships")
    && !workItemsServer.includes("mi_insert_shared_schedule_items")
    && !workItemsServer.includes("mi_update_shared_schedule_item")
    && !workItemsServer.includes("mi_delete_shared_schedule_item")
    && workItemsServer.includes("buildMonthlyOccurrences")
    && workItemsServer.includes("recurrence_no_end")
    && workItemsServer.includes('typeof body.repeatNoEnd !== "boolean"')
    && adminApiServer.includes("personalOnly: true")
    && adminApiServer.includes('query.is("calendar_id", null)')
    && clientApiServer.includes("personalOnly: true")
    && clientApiServer.includes('query.is("calendar_id", null)')
    && calendarDomain.includes("DEFAULT_MAX_OCCURRENCES = 60")
    && calendarDomain.includes('timeZone: "Asia/Seoul"')
    && calendarDomain.includes("repeatNoEnd")
    && calendarMigration.includes("force row level security")
    && calendarMigration.includes("revoke all on table public.schedule_items from public, anon, authenticated")
    && calendarMigration.includes("returns setof public.schedule_items")
    && !/grant\s+(?:select|insert|update|delete)[^;]*on table public\.schedule_items to (?:public|anon|authenticated)/i.test(calendarMigration)
    && calendarNoEndMigration.includes("recurrence_no_end boolean not null default false")
    && calendarNoEndMigration.includes("schedule_items_recurrence_no_end_coherent")
    && !/grant\s+(?:select|insert|update|delete)[^;]*to\s+(?:public|anon|authenticated)/i.test(calendarNoEndMigration)
    && calendarHandlerTests.includes("personal-only contract: sharing, list, create, join, invite, and leave actions are disabled")
    && calendarHandlerTests.includes("monthly no-end POST stores intent and an exact 60-occurrence materialized horizon")
    && calendarHandlerTests.includes("existing shared rows reject PATCH, DELETE, and assistant completion")
    && calendarHandlerTests.includes("bounded calendar GET reports truncation")
    && calendarMigrationTests.includes("service-role-only")
    && calendarNoEndMigrationTests.includes("stores explicit intent")
    && calendarUiTests.includes("wide personal calendar without list or sharing controls")
    && calendarUiTests.includes("preserving existing work fields")
    && calendarUiTests.includes("no planned end")
    && String(packageConfig.scripts?.test || "").includes("scripts/calendar-sharing-migration.test.mjs")
    && String(packageConfig.scripts?.test || "").includes("scripts/schedule-monthly-no-end-migration.test.mjs")
    && String(packageConfig.scripts?.test || "").includes("scripts/work-calendar-ui.test.mjs")
    && String(packageConfig.scripts?.test || "").includes("scripts/naver-shopping-transient-system-recovery-migration.test.mjs"),
  workOperationExecutionSummaryAndQuickComplete: adminSource.includes('data-work-summary-filter="today"')
    && adminSource.includes('data-work-summary-filter="overdue"')
    && adminSource.includes('data-work-summary-filter="needs_check"')
    && adminSource.includes("workItemMatchesFilter")
    && adminSource.includes("data-work-quick-done")
    && adminSource.includes("toggleWorkItemCompletion")
    && adminSource.includes('item.status === "done" ? "planned" : "done"')
    && adminSource.includes("완료 해제")
    && adminSource.includes('aria-pressed="')
    && !adminSource.includes('(done ? " disabled" : "")')
    && adminSource.includes("data-work-advanced")
    && adminSource.includes("상세 설정 · 필요할 때만 입력"),
  workOperationViewIsStrictlyScoped: adminSource.includes("#mi-admin .mi-view:not(.is-active)")
    && adminSource.includes("display: none !important;")
    && adminSource.includes("#mi-admin .mi-work-shell.is-active")
    && !adminSource.includes("#mi-admin .mi-work-shell {\n      display: grid;")
    && adminSource.includes('if (target !== "work" && target !== "owner-assistant") deactivateWorkOperation();'),
  workOperationOwnerCodeIsManualAndNonEnumerating: adminWorkViewSource.includes("광고주 코드 직접 입력")
    && adminWorkViewSource.includes('autocomplete="new-password"')
    && !adminWorkViewSource.includes("<datalist")
    && !adminWorkViewSource.includes("list=\"mi-work-owner-clients\"")
    && !adminWorkViewSource.includes("data-work-owner-client-options")
    && !adminWorkScopeSource.includes("ownerCodeSnapshot")
    && !adminWorkScopeSource.includes(".clients"),
  reportCenterScopesByCode: reportCenterServer.includes("findActiveClientByAgencyCode")
    && reportCenterServer.includes("findActiveClientByTeamCode")
    && reportCenterServer.includes(".eq(\"owner_agency_code\", primaryAgencyCode())")
    && reportCenterServer.includes(".eq(\"status\", \"active\")")
    && reportCenterServer.includes(".is(\"disconnected_at\", null)")
    && reportCenterServer.includes("광고주는 보고서를 등록할 수 없습니다."),
  reportCenterClientVisibleOnly: reportCenterServer.includes('if (access.role === "client") reportsQuery = reportsQuery.eq("visibility", "client_visible")')
    && reportCenterServer.includes('if (access.role === "client") filesQuery = filesQuery.eq("visibility", "client_visible")')
    && reportCenterServer.includes('body.visibility === "client_visible" ? "client_visible" : "internal"'),
  reportCenterUploadAndAuditReady: reportCenterServer.includes("DIRECT_SIGNED_UPLOAD_DISABLED")
    && reportCenterServer.includes("validateUploadedFile")
    && reportCenterServer.includes("safeExternalReportUrl")
    && reportCenterServer.includes("createSignedUrl")
    && reportCenterServer.includes("REPORT_DOWNLOAD_EXPIRES_IN")
    && reportCenterServer.includes("signed_url")
    && reportCenterServer.includes('const REPORT_BUCKET = "moment-reports"')
    && reportCenterServer.includes("requestedReportBucket")
    && reportCenterServer.includes("validateReportReferences")
    && reportCenterServer.includes("해당 광고주에 속한 브랜드만 보고서에 연결")
    && reportCenterServer.includes("보고서 파일은 해당 광고주 전용 경로만 연결")
    && reportCenterServer.includes("report_center.report_created")
    && reportCenterServer.includes("recordAuditLog")
    && reportCenterServer.includes("auditLogged"),
  reportCenterAiPptxReady: adminSource.includes("data-admin-ai-pptx")
    && adminSource.includes("AI 매출 PPTX")
    && adminSource.includes("운영팀 작성값을 보고서 디자인에 자동 배치")
    && adminSource.includes("PPTX · 2026년 6월")
    && !adminSource.includes("<small>CSV · 6월 2주차")
    && !adminSource.includes("<small>CSV · 2026년 6월")
    && !adminSource.includes("CSV 생성 완료")
    && adminSource.includes("generateSalesPptxReport")
    && adminSource.includes('action: "generate-sales-pptx"')
    && adminSource.includes("downloadBase64File")
    && reportCenterServer.includes('await import("pptxgenjs")')
    && !reportCenterServer.includes('import pptxgen from "pptxgenjs"')
    && reportCenterServer.includes("OPENAI_API_KEY")
    && reportCenterServer.includes("buildAiSalesNarrative")
    && reportCenterServer.includes("buildSalesReportPptx")
    && reportCenterServer.includes('"pptx"')
    && reportCenterServer.includes("PPTX_MIME")
    && reportCenterServer.includes("report_center.ai_pptx_created"),
  naverRankProductKindVisible: adminSource.includes("rankProductKindLabel")
    && adminSource.includes("rankProductKindNote")
    && adminSource.includes("원부형")
    && adminSource.includes("상품 형태")
    && adminSource.includes("대표 기준")
    && adminSource.includes("원부ID ")
    && adminSource.includes("상품ID ")
    && adminSource.includes("가격비교 묶음 상품")
    && clientSource.includes("rankProductKindLabel")
    && clientSource.includes("rankProductKindNote")
    && clientSource.includes("원부형")
    && clientSource.includes("대표 기준")
    && clientSource.includes("원부ID ")
    && clientSource.includes("상품ID ")
    && clientSource.includes("가격비교 묶음 상품")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("classifyNaverProductType")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("isPriceCompareCatalog")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("productKindLabel")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("catalogIdCandidates")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("extractCatalogIdsFromHtml")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("resolveRankTarget")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("const urlProductIds = productIdCandidates(targetUrl)")
    && !read("src/server/handlers/naver-shopping-rank.mjs").includes("catalog_inferred_from_product_url")
    && adminSource.includes("상품ID·판매자 일치")
    && clientSource.includes("상품ID·판매자 일치"),
  naverRankWorkerOperationsSeparatedFromTracking: adminNaverRankTrackingViewSource.length > 0
    && !staticWorkerOperationsPanel.test(adminNaverRankTrackingViewSource)
    && !adminNaverRankTrackingViewSource.includes("N 쇼핑 수집 운영센터"),
  naverRankWorkerCanaryReadsRenderedOperationsTarget: /root\.querySelector\(\s*['"][^'"]*\[data-rank-worker-operations\][^'"]*['"]\s*\)/u.test(adminWorkerOperationsLookupSource)
    && adminWorkerOperationsLookupSource.includes('secureSession.role !== "owner"')
    && adminRankTrackingSource.includes("rankWorkerOperationsPanel()")
    && adminRankTrackingSource.includes('body.trackerId = operationsPanel ? operationsPanel.getAttribute("data-rank-canary-tracker-id") || "" : "";')
    && adminRankTrackingSource.includes("[data-rank-worker-stop], [data-rank-worker-canary], [data-rank-worker-candidate], [data-rank-worker-baseline]")
    && adminRankTrackingSource.includes('root.addEventListener("click"')
    && !adminRankTrackingSource.includes('card.querySelector("[data-rank-worker-operations]")')
    && !adminSource.includes('body.trackerId = card.getAttribute("data-rank-canary-tracker-id") || "";'),
  naverRankPremiumExposureCards: [adminSource, clientSource].every((source) => source.includes("renderProductExposureCards")
    && source.includes("mi-rank-exposure-board")
    && source.includes("상품 노출 결과")
    && source.includes("관련 원부")
    && source.includes("상품 ID 일치")
    && source.includes("광고상품 미연결")
    && source.includes('var keywordUrl = rankTrackerKeywordUrl(keyword === "-" ? "" : keyword)')
    && source.includes('class="mi-rank-exposure-title" href="\' + escapeHtml(keywordUrl)')
    && source.includes('class="mi-rank-exposure-action" href="\' + escapeHtml(productUrl)')
    && source.includes("키워드 검색 결과 보기")
    && source.includes("background: #eaf9f0")
    && source.includes("color: #087f45")
    && source.includes("40개 보기 기준 페이지·페이지 내 순위")
    && source.includes("관련 원부와 정확 상품 중 더 높은 노출"))
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("productExposureItemsFromOrganic")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("productExposureSummary")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("relatedCatalogIds")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("sellerItemsFromOrganic")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes('adCoverage: "explicit_ad_markers_excluded"')
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("isExactTarget")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("isRelatedCatalog"),
  naverRankSellerLinkExactAndFullRange: shoppingRankServer.includes("function sellerProductIdCandidates")
    && shoppingRankServer.includes('targetMode === "catalog" ? itemCatalogIds(item) : itemSellerProductIds(item)')
    && shoppingRankServer.includes('matchEvidence: targetMode === "catalog" ? "catalog_id" : "seller_link_product_id"')
    && shoppingRankServer.includes("let matchedResult = null")
    && shoppingRankServer.includes("checkedCount: organicCheckedCount")
    && shoppingRankServer.includes("sourceLink: serializedExactItem.link")
    && shoppingRankServer.includes("target?.sourceUrl ? target.sourceUrl : serializedExactItem.link"),
  naverRankShowsRepresentativeOrganicPage: [adminSource, clientSource].every((source) => source.includes("현재 오가닉 순위")
    && source.includes('page + "페이지 " + position + "위"')
    && source.includes("Math.ceil(rank / 40)")
    && source.includes("대표 기준"))
    && shoppingRankServer.includes('rankBasis: "naver_shopping_organic_rank"')
    && shoppingRankServer.includes("webPageVerified: false")
    && shoppingRankServer.includes("selectRepresentativeExposure")
    && shoppingRankServer.includes("exactProductRank")
    && shoppingRankServer.includes("representativeProductId"),
  naverRankTrackingUsesBestExactOrCatalog: [adminSource, clientSource].every((source) => source.includes("정확 상품과 관련 원부를 함께 비교해 더 높은 오가닉 순위")
    && source.includes("function rankSnapshotSourceLabel")
    && source.includes('source === "related_catalog"')
    && source.includes('" · " + currentSource'))
    && rankServer.includes("function selectRepresentativeTrackingRank")
    && rankServer.includes('rankSelectionBasis: "best_of_exact_product_and_related_catalog"')
    && rankServer.includes('trackingRankSource: result.trackingRankSource')
    && rankServer.includes("const result = selectRepresentativeTrackingRank(lookupResult, tracker.product_id)")
    && rankServer.includes("hasDirectCatalogSellerEvidence")
    && rankServer.includes('=== "catalog_seller_product_id"')
    && rankServer.includes("catalogSellerProductIds.includes(exactProductId)")
    && rankServer.includes("representativeTrackingRankMessage(result)"),
  naverRankTrackingExcludesAds: [adminSource, clientSource].every((source) => source.includes("광고 제외")
    && source.includes("오가닉 순위"))
    && shoppingRankServer.includes('"isadproduct"')
    && shoppingRankServer.includes('"adid"')
    && shoppingRankServer.includes('"supersaving"')
    && shoppingRankServer.includes("if (isAdItem(item))")
    && shoppingRankServer.includes('rankPolicy: "organic_only"')
    && shoppingRankServer.includes("adExcluded: true")
    && rankServer.includes("sanitizeOrganicTrackingItems")
    && rankServer.includes("exactExposureRejectedAsAd")
    && rankServer.includes('top_items: sanitizeOrganicTrackingItems(result?.topItems)')
    && rankServer.includes('rankPolicy: "organic_only"')
    && rankServer.includes("adExcluded: true"),
  clientConnectRejectsDisconnected: clientApiServer.includes("disconnected_at")
    && clientApiServer.includes('.is("disconnected_at", null)'),
  adminAuditResourceReady: adminApiServer.includes('"audit-logs"')
    && adminApiServer.includes("readonly: true")
    && adminApiServer.includes("recordAuditLog")
    && adminApiServer.includes("auditLogged"),
  accessRlsRequiresActiveClient: accessAuditMigration.includes("add column if not exists disconnected_at")
    && accessAuditMigration.includes("create or replace function public.has_client_access")
    && accessAuditMigration.includes("c.status = 'active'")
    && accessAuditMigration.includes("c.disconnected_at is null")
    && accessAuditMigration.includes("idx_audit_logs_action_created"),
  rankCronTwiceDailyKst: rankCronWorkflow.includes('cron: "5,10,15 0,6 * * *"')
    && rankCronWorkflow.includes('cron: "37 * * * *"')
    && !rankCronWorkflow.includes("\n  push:")
    && rankCronWorkflow.includes("KST 09:05/15:05 durable-cycle wake window")
    && rankCronWorkflow.includes("Hourly catch-up wakes the same cycle")
    && rankCronWorkflow.includes("const batchSize = 1")
    && rankCronWorkflow.includes("const maxBatches = 100")
    && rankCronWorkflow.includes("drain 100 due trackers")
    && rankCronWorkflow.includes("await sleep(8000)")
    && rankCronWorkflow.includes("preserved")
    && rankCronWorkflow.includes("requestTimeoutMs")
    && rankCronWorkflow.includes("payload.ok !== true")
    && rankCronWorkflow.includes("const itemFailureResponse = response.status === 502")
    && rankCronWorkflow.includes('payloadCode === "NAVER_RANK_CRON_ITEM_FAILURE"')
    && rankCronWorkflow.includes('payloadCode === "NAVER_RANK_PROVIDER_NOT_CONFIGURED"')
    && rankCronWorkflow.includes("totals.failed > 0")
    && rankCronWorkflow.includes("drained the queue with")
    && rankCronWorkflow.includes("MI_RANK_CRON_SECRET")
    && rankCronWorkflow.includes("Validate cron secret")
    && rankCronWorkflow.includes("GitHub Actions secret MI_RANK_CRON_SECRET is missing")
    && rankCronWorkflow.includes("Naver rank cron batch")
    && rankCronWorkflow.includes("Naver rank cron window"),
  rankCronHasConcurrencyGuard: rankCronWorkflow.includes("concurrency:")
    && rankCronWorkflow.includes("group: naver-rank-tracking")
    && rankCronWorkflow.includes("cancel-in-progress: false"),
  rankCronHasDbProcessingLease: rankServer.includes("RANK_TRACKER_LEASE_MS")
    && rankServer.includes("claimDueTracker")
    && rankServer.includes("clearDueTrackerClaim")
    && rankServer.includes("processing_started_at")
    && rankServer.includes("processing_until")
    && rankServer.includes("isMissingRankLeaseColumns")
    && rankProcessingLeaseMigration.includes("add column if not exists processing_started_at")
    && rankProcessingLeaseMigration.includes("add column if not exists processing_until")
    && rankProcessingLeaseMigration.includes("idx_naver_rank_trackers_due_processing"),
  rankCronReportsPartialFailures: rankCronServer.includes("summary.checked > 0 && summary.failed > 0")
    && rankCronServer.includes('NAVER_RANK_CRON_ITEM_FAILURE = "NAVER_RANK_CRON_ITEM_FAILURE"')
    && rankCronServer.includes("safeProductRankCronSummary")
    && rankCronServer.includes("일부 네이버 상품 순위 자동 갱신이 실패했습니다.")
    && rankCronServer.includes("}, 502)"),
  rankTrackerDueSelfHeal: rankServer.includes("syncDueTrackers")
    && rankServer.includes('action === "sync-due"')
    && [adminSource, clientSource].every((source) => source.includes("syncDueRankTrackersIfNeeded")
      && source.includes('action: "sync-due"')
      && source.includes("밀린 자동 순위 갱신을 확인 중입니다.")
      && source.includes("dueRankTrackers")),
  rankTrackerGroupsReady: rankServer.includes("DEFAULT_RANK_GROUP")
    && rankServer.includes("updateTrackerGroup")
    && rankServer.includes('action === "group"')
    && rankServer.includes("groupName: normalizeRankGroupName(row.group_name)")
    && rankTrackerGroupsMigration.includes("add column if not exists group_name")
    && rankTrackerGroupsMigration.includes("idx_naver_rank_trackers_agency_group_sort")
    && [adminSource, clientSource].every((source) => source.includes("data-rank-bulk-group")
      && source.includes("data-rank-group-menu-toggle")
      && source.includes("data-rank-group-option")
      && source.includes("mi-rank-group-menu")
      && source.includes("data-rank-filter-group")
      && source.includes("data-rank-filter-group-wrap")
      && source.includes("그룹 보기")
      && source.includes('<option value="">전체 그룹</option>')
      && source.includes("그룹 생성/적용")
      && source.includes("그룹 해제")
      && source.includes("mi-rank-group-menu-label")
      && source.includes("RANK_DEFAULT_GROUP")
      && source.includes("rankGroupDisplayName")
      && source.includes("rankGroupNamesForCard")
      && source.includes("rankTrackerGroupName")
      && source.includes("data-rank-group-edit")
      && source.includes("data-rank-bulk-group-draft")
      && source.includes("groupFilterAfterMove")
      && source.includes("그룹에 넣을 추적 항목을 먼저 체크해주세요.")
      && source.includes("그룹 해제할 추적 항목을 먼저 체크해주세요.")
      && source.includes("mi-rank-group-section")
      && source.includes('action: "group"')
      && !source.includes("data-rank-group-list")
      && !source.includes("data-rank-group list=")),
  vercelRankCronConfigured: (vercelConfig.crons || []).some((cron) => cron.path === "/api/naver-rank-cron"
    && cron.schedule === "7 0 * * *")
    && rankCronServer.includes("DEFAULT_CRON_BATCH = 1")
    && rankCronServer.includes("MAX_CRON_BATCH = 5")
    && rankCronServer.includes("productRankCronBatchLimit(url)"),
  rankNextCheckUsesAmPmSlots: rankServer.includes("function nextRankCheckAt")
    && rankServer.includes("kstSlotToUtc(kstBase, 9)")
    && rankServer.includes("kstSlotToUtc(kstBase, 15)")
    && rankServer.includes("next_check_at: nextCheckAt"),
  rankCronDailyScheduleTested: rankCronScheduleCheck.includes("dailySlots")
    && rankCronScheduleCheck.includes('"Monday"')
    && rankCronScheduleCheck.includes('"Tuesday"')
    && rankCronScheduleCheck.includes('"Wednesday"')
    && rankCronScheduleCheck.includes('"Thursday"')
    && rankCronScheduleCheck.includes('"Friday"')
    && rankCronScheduleCheck.includes('"Saturday"')
    && rankCronScheduleCheck.includes('"Sunday"')
    && rankCronScheduleCheck.includes("before morning slot")
    && rankCronScheduleCheck.includes("before afternoon slot")
    && rankCronScheduleCheck.includes("after afternoon slot")
    && rankCronScheduleCheck.includes("Daily rank cron schedule checks passed."),
  rankTrackerOpsStatusVisible: [adminSource, clientSource].every((source) => source.includes("mi-rank-ops-row")
    && source.includes("rankTrackerOpsSummary")
    && source.includes("mi-rank-auto-center")
    && source.includes("mi-rank-auto-metrics")
    && source.includes("mi-rank-auto-metric")
    && source.includes("자동추적")
    && source.includes("최근 갱신")
    && source.includes("다음 갱신")
    && source.includes("매일 09:00 · 15:00")
    && source.includes("rankTrackerStatusClass")
    && source.includes("formatRankRemain(tracker.nextCheckAt)")
    && source.includes("tracker.lastCheckedAt")
    && source.includes("tracker.lastMessage")
    && !source.includes('return "D-"')),
  rankTrackerActionNotesVisible: [adminSource, clientSource].every((source) => source.includes("rankTrackerActionNote")
    && source.includes("mi-rank-action-note")
    && source.includes("권고 ")
    && source.includes("300위 이내 없음 · 상품명/카테고리 확인")
    && source.includes("하락 감지 · 가격/소재 점검")
    && source.includes("상승 흐름 유지")
    && source.includes("상위권 방어")),
  rankTrackingFilterControls: [adminSource, clientSource].every((source) => source.includes("data-rank-filter-panel")
    && source.includes("data-rank-filter-search")
    && source.includes('data-rank-filter-status="attention"')
    && source.includes('data-rank-filter-status="improved"')
    && source.includes('data-rank-filter-status="dropped"')
    && source.includes("rankTrackerMatchesFilter")
    && source.includes("rankTrackerNeedsAttention")
    && source.includes("rankTrackerTrend")
    && source.includes("updateRankFilterPanel")
    && source.includes("키워드, 상품명, 상품번호 검색")),
  rankFullRefreshUsesSafeConcurrency: [adminFullRankRefreshSource, clientFullRankRefreshSource].every((source) => source.includes('rankSourceMode === "hybrid_local_worker"')
    && source.includes('action: "queue-refresh-all"')
    && source.includes("완료된 순위부터 자동 반영됩니다.")
    && source.includes("var mobileFallback = rankSourceUsesMobileFallback()")
    && source.includes("Math.min(mobileFallback ? 1 : 2, targets.length)")
    && source.includes("if (mobileFallback && completedCount > 0)")
    && source.includes("Promise.all")
    && source.includes("setTimeout(resolve, 8000)")
    && source.includes("preservedCount")
    && source.includes("waitForRankAutoSyncBeforeManual")
    && source.includes("전체 순위 갱신을 시작합니다.")
    && source.includes('"전체 순위 갱신 중입니다. " + completedCount + "/" + targets.length')
    && !source.includes("안전 동시 갱신 2개")
    && source.includes("Boolean(refreshedTracker) && checkedAt >= batchStartedAt - 1000")
    && source.includes("rankSourceReady !== true")
    && source.includes("payload.retryable === true")
    && source.includes("retryTargets.length")
    && source.includes("일시 오류 ")
    && source.includes("for (var retryIndex = 0; retryIndex < retryTargets.length; retryIndex += 1)")
    && source.includes("sourceUnavailableDuringBatch")
    && !source.includes("응답을 확인하지 못한 ")
    && !source.includes("for (var retryIndex = 0; retryIndex < unresolvedTargets.length; retryIndex += 1)")
    && source.includes("재시도 예정")
    && !source.includes("for (var i = 0; i < targets.length")),
  rankRefreshAppliesBySessionScopeSiteWide: [adminFullRankRefreshSource, clientFullRankRefreshSource, adminFullPlaceRefreshSource, clientFullPlaceRefreshSource]
    .every((source) => !source.includes("mml93-a01"))
    && [adminRankTrackingSource, clientRankTrackingSource].every((source) => source.includes("verifiedRankTrackerScope()"))
    && rankServerTests.includes("product due refresh stays global for cron and accepts any advertiser scope")
    && placeRankServerTests.includes("place due refresh stays global for cron and accepts any advertiser scope"),
  rankPageAutoSyncIsBounded: [adminRankTrackingSource, clientRankTrackingSource].every((source) => source.includes('action: "sync-due"')
    && source.includes('limit: "2"')
    && !source.includes('limit: "50"')),
  placeFullRefreshStaysSequential: [adminFullPlaceRefreshSource, clientFullPlaceRefreshSource].every((source) => source.includes("waitForPlaceAutoSyncBeforeManual")
    && source.includes("for (var index = 0; index < targets.length; index += 1)")
    && source.includes("재시도 예정")
    && !source.includes("Promise.all")),
  placeCollectorBusyRetryIsDeadlineBounded: placeRankServer.includes("fetchPlaceProviderWithBusyRetry")
    && placeRankServer.includes('response.status === 429')
    && placeRankServer.includes('"collector_busy"')
    && placeRankServer.includes("remainingMs <= retryDelayMs + 2000"),
  placeNativeExhaustionCacheIsFailClosed: placeRankCollector.includes('collection?.stopReason === "naver_result_list_exhausted"')
    && placeRankCollector.includes('const targetIds = collectTargetIds(target)')
    && placeRankCollector.includes('if (!targetIds.length || !findMatch(entry.collection.candidates, target)) return null')
    && placeRankCollector.includes('["collection_deadline_reached", "max_scrolls_reached"]')
    && placeRankCollectorTests.includes("reuses a transient native-list collection only for an exact cached place ID")
    && placeRankCollectorTests.includes("collection_deadline_reached")
    && placeRankCollectorTests.includes("list_selector_unavailable_fallback"),
  adminDownloadMicroInteraction: adminSource.includes("#mi-admin .mi-download:hover")
    && adminSource.includes("#mi-admin .mi-download:active")
    && adminSource.includes("#mi-admin .mi-download:focus-visible")
    && adminSource.includes("#mi-admin .mi-download:disabled"),
  kakaoChannelCtaVisible: [homeSource, adminSource, clientSource].every((source) => source.includes("https://pf.kakao.com/_ixoLxfX")
    && source.includes("mi-kakao-floating")
    && source.includes("채널 문의")
    && source.includes("카카오톡 상담")
    && source.includes(".mi-kakao-icon::before")
    && source.includes("clip-path: polygon(0 0, 100% 0, 18% 100%)")
    && !source.includes(">톡</i>")),
  superAdminCanCreateClient: superAdminServer.includes('action === "create-client"') && superAdminServer.includes("return createClient(request, ctx, body)"),
  superAdminSecretFailsClosed: superAdminServer.includes('process.env.MI_SUPER_ADMIN_CODE || ""')
    && superAdminServer.includes("총관리자 비밀값이 서버에 설정되지 않았습니다.")
    && !superAdminServer.includes("process.env.MI_SUPER_ADMIN_CODE || primaryAgencyCode()"),
  productionEnvRequiresCronAndOwnerSecrets: runtimeEnvCheck.includes('const productionMode = process.argv.includes("--production")')
    && runtimeEnvCheck.includes('status(\n    env,\n    "Naver shopping rank source"')
    && runtimeEnvCheck.includes('"NAVER_SHOPPING_RANK_MODE", "NAVER_SHOPPING_RANK_API_URL", "NAVER_SHOPPING_RANK_API_KEY"')
    && runtimeEnvCheck.includes('status(env, "Rank tracker GitHub cron secret", ["MI_RANK_CRON_SECRET"], productionMode)')
    && runtimeEnvCheck.includes('status(env, "Vercel Cron authorization secret", ["CRON_SECRET"], productionMode)')
    && runtimeEnvCheck.includes('status(env, "Super admin code", ["MI_SUPER_ADMIN_CODE"], productionMode,')
    && runtimeEnvCheck.includes('status(env, "Encrypted session secret", ["MI_SESSION_SECRET"], productionMode,')
    && runtimeEnvCheck.includes('status(env, "Previous encrypted session secret", ["MI_SESSION_SECRET_PREVIOUS"], false,')
    && runtimeEnvCheck.includes('status(env, "Encrypted session TTL", ["MI_SESSION_TTL_SECONDS"], false,')
    && runtimeEnvCheck.includes('merged.MI_PRIMARY_AGENCY_CODE === "mml93-a01"')
    && runtimeEnvCheck.includes('status(env, "Owner login credential", ["MI_OWNER_LOGIN_CODE_SHA256", "MI_OWNER_LOGIN_CODE"], productionMode,'),
  integrationStatusHidesEnvNamesInProduction: integrationStatusServer.includes("MI_EXPOSE_INTEGRATION_ENV_NAMES")
    && integrationStatusServer.includes("missingEnv: exposeDetails ? missing : []")
    && integrationStatusServer.includes("missingEnvCount: missing.length"),
  rankDbTriggerBypassesOwner: rankUnlimitedMigration.includes("lower(coalesce(new.agency_code, '')) = 'mml93-a01'"),
};

for (const [label, passed] of Object.entries(checks)) {
  assertCheck(passed, label);
}

console.log(JSON.stringify({
  ok: true,
  adminScreens,
  clientScreens,
  checks,
}, null, 2));
