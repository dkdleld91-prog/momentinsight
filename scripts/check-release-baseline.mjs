import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function exists(path) {
  return fs.existsSync(path);
}

function uniqueMatches(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
}

function assertCheck(condition, label) {
  if (!condition) {
    throw new Error(`Release baseline failed: ${label}`);
  }
}

const adminSource = read("src/pages/admin.html");
const clientSource = read("src/pages/client.html");
const homeSource = read("src/pages/home.html");
const sheetTemplateBuilder = read("03_운영시트_템플릿/build_moment_insight_sheet.mjs");
const rankServer = read("src/server/handlers/naver-rank-trackers.mjs");
const metaAdsServer = read("src/server/handlers/meta-ads.mjs");
const superAdminServer = read("src/server/handlers/super-admin-api.mjs");
const adminApiServer = read("src/server/handlers/admin-api.mjs");
const reportCenterServer = read("src/server/handlers/report-center.mjs");
const clientApiServer = read("src/server/handlers/client-api.mjs");
const integrationStatusServer = read("src/server/handlers/integration-status.mjs");
const rankCronServer = read("src/server/handlers/naver-rank-cron.mjs");
const serverIndex = read("src/server/index.mjs");
const securityServer = read("src/server/security.mjs");
const runtimeEnvCheck = read("scripts/check-runtime-env.mjs");
const rankUnlimitedMigration = read("supabase/migrations/20260626074000_primary_rank_tracker_unlimited.sql");
const accessAuditMigration = read("supabase/migrations/20260628152000_harden_access_and_audit_logs.sql");
const vercelConfig = JSON.parse(read("vercel.json"));
const rankCronWorkflow = read(".github/workflows/naver-rank-cron.yml");
const rankCronScheduleCheck = read("scripts/check-rank-cron-schedule.mjs");
const staticBuildScript = read("scripts/build-vercel-static.mjs");
const rankProcessingLeaseMigration = read("supabase/migrations/20260629025402_naver_rank_tracker_processing_lease.sql");
const rankTrackerGroupsMigration = read("supabase/migrations/20260701090000_naver_rank_tracker_groups.sql");

const adminScreens = uniqueMatches(adminSource, /data-mi-admin-screen="([^"]+)"/g);
const clientScreens = uniqueMatches(clientSource, /data-mi-screen="([^"]+)"/g);

const checks = {
  pageSourcesMovedOutOfImwebBundle: exists("src/pages/admin.html")
    && exists("src/pages/client.html")
    && exists("src/pages/home.html")
    && !exists("02_아임웹_적용코드"),
  adminMenuCount: adminScreens.length === 12,
  adminMenuHasCore: ["home", "client-preview", "agency-code", "excel", "reports", "keyword", "seo-check", "naver-rank", "naver-rank-tracking", "meta-ads", "publish", "related-keywords"].every((screen) => adminScreens.includes(screen)),
  operationTeamNotLockedToAgencyCode: !adminSource.includes("setOperationTeamNavigation") && !adminSource.includes('target !== "agency-code"'),
  adminLoginRoleSelection: adminSource.includes('data-login-mode="client"')
    && adminSource.includes('data-login-mode="operator"')
    && adminSource.includes("운영팀 로그인")
    && adminSource.includes("운영팀 코드 접속"),
  ownerModeContextVisible: adminSource.includes("총관리자 모드") && adminSource.includes("운영팀 모드"),
  ownerDirectClientCreate: adminSource.includes('action: "create-client"') && adminSource.includes("비우면 총관리자 직접 발급"),
  teamClientCreateStillExists: adminSource.includes('action: "create-client-for-team"'),
  clientCodeReactivationExists: superAdminServer.includes("광고주 코드 재활성화에 실패했습니다.")
    && superAdminServer.includes("reactivated: true")
    && superAdminServer.includes("Reissued by operation team"),
  ownerActiveAccountsFullView: adminSource.includes('data-mi-admin-view="active-accounts"')
    && adminSource.includes("data-owner-team-full-list")
    && adminSource.includes("data-owner-client-full-list")
    && adminSource.includes("data-owner-list-open"),
  ownerRelationshipBoard: adminSource.includes("data-owner-relationship-list")
    && adminSource.includes("data-owner-root-account")
    && adminSource.includes("총관리자 직접 광고주"),
  ownerRankListLimit500: adminSource.includes("rankListLimit") && adminSource.includes('? "500" : "50"'),
  clientLoginGate: clientSource.includes("data-mi-login-code") && clientSource.includes("data-mi-login-button"),
  clientLoginRoleSelection: clientSource.includes('data-client-login-mode="client"')
    && clientSource.includes('data-client-login-mode="operator"')
    && clientSource.includes("운영팀 화면으로 이동")
    && clientSource.includes("getOperatorEntryUrl"),
  clientReportDownloadBox: clientSource.includes("data-mi-report-list")
    && clientSource.includes("data-mi-report-download")
    && clientSource.includes("downloadClientReport")
    && clientSource.includes("공개 보고서만 표시합니다.")
    && clientSource.includes("공개 보고서 없음")
    && clientSource.includes("reportCenterSynced")
    && !clientSource.includes("buildClientReportCsv")
    && !clientSource.includes("text/csv;charset=utf-8")
    && !clientSource.includes("CSV 백업"),
  clientDataReliabilityVisible: clientSource.includes("데이터 신뢰도: 운영팀 검수 완료")
    && clientSource.includes("데이터 출처")
    && clientSource.includes("공개 승인된 보고서만 표시")
    && clientSource.includes("운영팀 업로드 → 검수 → 공개 → 다운로드")
    && clientSource.includes("운영팀 공개 파일 대기")
    && clientSource.includes("공개 대기"),
  clientReportCenterSync: clientSource.includes("getReportCenterApiUrl")
    && clientSource.includes("syncReportCenterReports")
    && clientSource.includes('"x-mi-agency-code": normalized')
    && clientSource.includes("file.signed_url")
    && clientSource.includes("fileUrl")
    && clientSource.includes("운영팀이 보고서 파일을 공개하면 다운로드할 수 있습니다."),
  adminReportCenterPublish: adminSource.includes("getReportCenterApiUrl")
    && adminSource.includes("generateSalesPptxReport")
    && adminSource.includes('"x-mi-team-code": teamCode')
    && adminSource.includes("PPTX 생성 · 보고서함 기록 완료")
    && adminSource.includes("운영팀-광고주 연결이 필요합니다."),
  reportPolicyAligned: adminSource.includes("보고서는 운영팀이 검수 후 공개합니다.")
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
    && adminSource.includes("광고주 1:1 범위")
    && adminSource.includes("검수 후 공개")
    && adminSource.includes("운영 입력</strong><span>매출·광고비·KPI 원본을 먼저 업로드")
    && adminSource.includes("현재 파일은 브라우저 임시 보관입니다")
    && adminSource.includes("다른 기기나 브라우저에서는 확인할 수 없습니다"),
  adminDefaultTemplateDownload: adminSource.includes("/downloads/moment-insight-operation-sheet-template.xlsx")
    && adminSource.includes("기본 양식 다운로드")
    && adminSource.includes("새 운영팀은 이 파일을 먼저 내려받고")
    && adminSource.includes("연결 광고주 1곳 기준")
    && exists("public/downloads/moment-insight-operation-sheet-template.xlsx"),
  publicStateScopedByCode: adminSource.includes("scopedStorageKey(storageKey")
    && adminSource.includes("scopedStorageKey(sourceFileStorageKey")
    && adminSource.includes("currentPublicCode")
    && adminSource.includes("blankPublicState")
    && adminSource.includes("operationTeamClientCode")
    && clientSource.includes("scopedStorageKey(code)")
    && clientSource.includes("blankPublicState(code)")
    && clientSource.includes("readState(normalized)")
    && !clientSource.includes("await syncDemoState(loginStatus)")
    && !clientSource.includes("await syncDemoState(connectStatus)"),
  operationSheetSingleClientSimple: sheetTemplateBuilder.includes("single-client-operation-team-template")
    && sheetTemplateBuilder.includes("별도 광고주 코드 입력은 없습니다")
    && sheetTemplateBuilder.includes("월간_매출입력")
    && sheetTemplateBuilder.includes("광고주 연결")
    && !sheetTemplateBuilder.includes('client_id", "광고주명", "브랜드명"'),
  clientToolsExist: ["keyword-tool", "naver-rank", "naver-rank-tracking", "meta-ads", "seo-check", "agency-code"].every((screen) => clientScreens.includes(screen)),
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
  naverRankScreensSplit: [adminSource, clientSource].every((source) => source.includes("data-rank-check-card")
    && source.includes("data-rank-check-run")
    && source.includes("initRankCheck")
    && source.includes("네이버 상품 순위")
    && source.includes("네이버 30일 순위")
    && source.includes("data-rank-card"))
    && adminSource.includes('data-mi-admin-screen="naver-rank-tracking"')
    && clientSource.includes('data-mi-screen="naver-rank-tracking"'),
  naverRankButtonLabelsClean: [adminSource, clientSource].every((source) => source.includes(">순위 조회<")
    && source.includes(">순위 추적<")
    && source.includes("네이버 상품 순위 <small>조회</small>")
    && source.includes('<span class="mi-badge">조회</span>')
    && !source.includes(">순위 1회 조회<")
    && !source.includes("<small>1회 조회</small>")
    && !source.includes('<span class="mi-badge">1회 조회</span>')
    && !source.includes(">오가닉 추적 시작<")),
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
    && source.includes("https://search.shopping.naver.com/search/all?query=")
    && source.includes("productSet=total")
    && !source.includes("productSet=model")
    && !source.includes("https://search.shopping.naver.com/search/catalog?query=")
    && source.includes("전체탭으로 열기")),
  rankTrackingKeywordVolumeVisible: [adminSource, clientSource].every((source) => source.includes("renderRankKeywordVolume")
    && source.includes("keywordVolumeLabel")
    && source.includes("키워드검색량")
    && source.includes("mi-rank-keyword-volume"))
    && rankServer.includes("keywordVolumeLabel")
    && rankServer.includes("fetchSearchAdKeywordVolume")
    && rankServer.includes("NAVER_SEARCHAD_API_KEY"),
  rankTrackingCompactActionColumn: [adminSource, clientSource].every((source) => source.includes("minmax(128px, 0.55fr)")
    && source.includes("minmax(196px, auto)")
    && source.includes("position: sticky")
    && source.includes("min-width: max-content")
    && source.includes("font-size: 10.5px")
    && source.includes("min-width: 132px;")
    && !source.includes("min-width: 1100px")),
  rankTrackingTypographyReduced: [adminSource, clientSource].every((source) => /mi-rank-ops-row \{[\s\S]*?font-weight: 700;/.test(source)
    && /mi-rank-keyword-name \{[\s\S]*?font-weight: 800;/.test(source)
    && /mi-rank-keyword-volume \{[\s\S]*?font-weight: 650;/.test(source)
    && /mi-rank-product-info \{[\s\S]*?font-weight: 650;/.test(source)
    && /mi-rank-product-title \{[\s\S]*?font-weight: 700;/.test(source)
    && /mi-rank-pill \{[\s\S]*?font-weight: 750;/.test(source)
    && /mi-rank-day-slots b \{[\s\S]*?font-weight: 850;/.test(source)),
  rankTrackingInsightLabels: [adminSource, clientSource].every((source) => source.includes("rankTrackerAverageRank")
    && source.includes("rankTrackerChangeLabel")
    && source.includes("rankTrackerInsight")
    && source.includes("7일 평균")
    && source.includes("전회 대비")),
  seoScoringBasisVisible: [adminSource, clientSource].every((source) => source.includes("SEO 점수 기준")
    && source.includes("상품명 키워드 25점")
    && source.includes("카테고리 연결 15점")
    && source.includes("시장 수요 15점")
    && source.includes("광고 제외 순위만 확인")
    && source.includes("가격/혜택 15점")
    && source.includes("리뷰/신뢰도 15점")),
  homeRoutesExist: homeSource.includes('href="/client#mi-dashboard"') && homeSource.includes('href="/admin"'),
  rankOwnerAccessBypassesClientRow: rankServer.includes("adminAuthorized && isPrimaryAgencyCode(agencyCode)") && rankServer.includes("clientId: null"),
  rankOwnerCreateLimitBypass: rankServer.includes("const unlimitedOwner") && rankServer.includes("!unlimitedOwner"),
  rankOwnerListLimit500: rankServer.includes("maxListLimit") && rankServer.includes("? 500 : 50"),
  rankTrackerRolling30Days: rankServer.includes("recentSnapshots")
    && rankServer.includes("slice(0, 30)")
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
  localCorsOriginsMergedWithConfigured: securityServer.includes('"http://127.0.0.1:8793"')
    && securityServer.includes('"http://localhost:8793"')
    && securityServer.includes("[...new Set([...configured, ...defaultAllowedOrigins])]"),
  productionBuildHidesInternalSourceBundle: !staticBuildScript.includes('all: "아임웹_원샷코드_통합보기_모먼트인사이트.html"')
    && !staticBuildScript.includes('path.join(outputDir, "02_아임웹_적용코드")')
    && !staticBuildScript.includes("path.join(outputDir, fileName)")
    && !staticBuildScript.includes('"/all.html"'),
  rankCronEndpointReady: read("src/server/index.mjs").includes('url.pathname === "/api/naver-rank-cron"')
    && rankCronServer.includes("Unauthorized cron request")
    && rankCronServer.includes("MI_RANK_CRON_SECRET"),
  reportCenterEndpointReady: serverIndex.includes('url.pathname === "/api/report-center"')
    && serverIndex.includes('reportCenter: () => import("./handlers/report-center.mjs")')
    && serverIndex.includes("dispatch(\"reportCenter\", request)")
    && reportCenterServer.includes('withSupabase({ auth: "none" }')
    && reportCenterServer.includes("x-mi-agency-code")
    && reportCenterServer.includes("x-mi-team-code")
    && reportCenterServer.includes("x-mi-super-admin-code"),
  reportCenterScopesByCode: reportCenterServer.includes("findActiveClientByAgencyCode")
    && reportCenterServer.includes("findActiveClientByTeamCode")
    && reportCenterServer.includes(".eq(\"owner_agency_code\", primaryAgencyCode())")
    && reportCenterServer.includes(".eq(\"status\", \"active\")")
    && reportCenterServer.includes(".is(\"disconnected_at\", null)")
    && reportCenterServer.includes("광고주는 보고서를 등록할 수 없습니다."),
  reportCenterClientVisibleOnly: reportCenterServer.includes('if (access.role === "client") reportsQuery = reportsQuery.eq("visibility", "client_visible")')
    && reportCenterServer.includes('if (access.role === "client") filesQuery = filesQuery.eq("visibility", "client_visible")')
    && reportCenterServer.includes('body.visibility === "client_visible" ? "client_visible" : "internal"'),
  reportCenterUploadAndAuditReady: reportCenterServer.includes("createSignedUploadUrl")
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
    && adminSource.includes("PPTX · 6월 2주차")
    && adminSource.includes("PPTX · 2026년 6월")
    && !adminSource.includes("<small>CSV · 6월 2주차")
    && !adminSource.includes("<small>CSV · 2026년 6월")
    && !adminSource.includes("CSV 생성 완료")
    && adminSource.includes("generateSalesPptxReport")
    && adminSource.includes('action: "generate-sales-pptx"')
    && adminSource.includes("downloadBase64File")
    && reportCenterServer.includes('import pptxgen from "pptxgenjs"')
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
    && adminSource.includes("조회 기준")
    && adminSource.includes("URL 자동 인식")
    && adminSource.includes("원부ID ")
    && adminSource.includes("가격비교 묶음 상품")
    && clientSource.includes("rankProductKindLabel")
    && clientSource.includes("rankProductKindNote")
    && clientSource.includes("원부형")
    && clientSource.includes("조회 기준")
    && clientSource.includes("URL 자동 인식")
    && clientSource.includes("원부ID ")
    && clientSource.includes("가격비교 묶음 상품")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("classifyNaverProductType")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("isPriceCompareCatalog")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("productKindLabel")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("catalogIdCandidates")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("extractCatalogIdsFromHtml")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("resolveRankTarget")
    && read("src/server/handlers/naver-shopping-rank.mjs").includes("catalog_inferred_from_product_url"),
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
  rankCronTwiceDailyKst: rankCronWorkflow.includes('cron: "*/10 0,6 * * *"')
    && rankCronWorkflow.includes("push:")
    && rankCronWorkflow.includes("deploy backfill")
    && rankCronWorkflow.includes("09:00 and 15:00 KST slots")
    && rankCronWorkflow.includes("missed exact-minute calls are retried")
    && rankCronWorkflow.includes("MI_RANK_CRON_SECRET")
    && rankCronWorkflow.includes("Validate cron secret")
    && rankCronWorkflow.includes("GitHub Actions secret MI_RANK_CRON_SECRET is missing")
    && rankCronWorkflow.includes("Naver rank cron summary")
    && rankCronWorkflow.includes("Naver rank cron accepted"),
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
      && source.includes("data-rank-filter-group")
      && source.includes("그룹 만들고 넣기")
      && source.includes("rankCustomGroupSet")
      && source.includes("rankGroupNamesForCard")
      && source.includes("rankTrackerGroupName")
      && source.includes("data-rank-group-edit")
      && source.includes("data-rank-bulk-group-draft")
      && source.includes("그룹에 넣을 추적 항목을 먼저 체크해주세요.")
      && source.includes("mi-rank-group-section")
      && source.includes('action: "group"')),
  vercelRankCronConfigured: (vercelConfig.crons || []).some((cron) => cron.path === "/api/naver-rank-cron"
    && cron.schedule === "0 0 * * *")
    && rankCronServer.includes("DEFAULT_CRON_BATCH = 50"),
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
  adminDownloadMicroInteraction: adminSource.includes("#mi-admin .mi-download:hover")
    && adminSource.includes("#mi-admin .mi-download:active")
    && adminSource.includes("#mi-admin .mi-download:focus-visible")
    && adminSource.includes("#mi-admin .mi-download:disabled"),
  kakaoChannelCtaVisible: [homeSource, adminSource, clientSource].every((source) => source.includes("https://pf.kakao.com/_ixoLxfX")
    && source.includes("mi-kakao-floating")
    && source.includes("카카오톡 문의")
    && source.includes("모먼트인사이트 채널")),
  superAdminCanCreateClient: superAdminServer.includes('action === "create-client"') && superAdminServer.includes("return createClient(request, ctx, body)"),
  superAdminSecretFailsClosed: superAdminServer.includes('process.env.MI_SUPER_ADMIN_CODE || ""')
    && superAdminServer.includes("총관리자 비밀값이 서버에 설정되지 않았습니다.")
    && !superAdminServer.includes("process.env.MI_SUPER_ADMIN_CODE || primaryAgencyCode()"),
  productionEnvRequiresCronAndOwnerSecrets: runtimeEnvCheck.includes('const productionMode = process.argv.includes("--production")')
    && runtimeEnvCheck.includes('status(env, "Rank tracker cron secret", ["MI_RANK_CRON_SECRET", "CRON_SECRET"], productionMode)')
    && runtimeEnvCheck.includes('status(env, "Super admin code", ["MI_SUPER_ADMIN_CODE"], productionMode)'),
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
