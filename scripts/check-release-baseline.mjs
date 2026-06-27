import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function uniqueMatches(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))];
}

function assertCheck(condition, label) {
  if (!condition) {
    throw new Error(`Release baseline failed: ${label}`);
  }
}

const adminSource = read("02_아임웹_적용코드/아임웹_원샷코드_관리자형_모먼트인사이트.html");
const adminCopy = read("02_아임웹_적용코드/복붙용_관리자형_CODE.txt");
const clientSource = read("02_아임웹_적용코드/아임웹_원샷코드_대시보드형_모먼트인사이트.html");
const clientCopy = read("02_아임웹_적용코드/복붙용_광고주형_CODE.txt");
const homeSource = read("02_아임웹_적용코드/아임웹_원샷코드_홈페이지형_모먼트인사이트.html");
const integratedSource = read("02_아임웹_적용코드/아임웹_원샷코드_통합보기_모먼트인사이트.html");
const sheetTemplateBuilder = read("03_운영시트_템플릿/build_moment_insight_sheet.mjs");
const rankServer = read("src/server/handlers/naver-rank-trackers.mjs");
const superAdminServer = read("src/server/handlers/super-admin-api.mjs");
const rankUnlimitedMigration = read("supabase/migrations/20260626074000_primary_rank_tracker_unlimited.sql");

const adminScreens = uniqueMatches(adminSource, /data-mi-admin-screen="([^"]+)"/g);
const clientScreens = uniqueMatches(clientSource, /data-mi-screen="([^"]+)"/g);

const checks = {
  adminCopySynced: adminSource === adminCopy,
  clientCopySynced: clientSource === clientCopy,
  adminMenuCount: adminScreens.length === 10,
  adminMenuHasCore: ["home", "client-preview", "agency-code", "excel", "reports", "keyword", "seo-check", "naver-rank", "publish", "related-keywords"].every((screen) => adminScreens.includes(screen)),
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
    && clientSource.includes("buildClientReportCsv")
    && clientSource.includes("downloadClientReport")
    && clientSource.includes("운영팀이 공개한 보고서만 다운로드"),
  reportPolicyAligned: adminSource.includes("보고서는 운영팀이 검수 후 공개합니다.")
    && adminSource.includes("공개 처리된 파일만 광고주 노출")
    && clientSource.includes("보고서함 다운로드 방식")
    && integratedSource.includes("운영팀 검수 후 보고서함 공개")
    && sheetTemplateBuilder.includes("운영팀 검수 후 보고서함 공개")
    && !adminSource.includes("보고서는 관리자가 전달합니다.")
    && !clientSource.includes("관리자가 다운로드 후 전달")
    && !clientSource.includes("관리자 전달 방식")
    && !integratedSource.includes("관리자가 다운로드 후 전달")
    && !sheetTemplateBuilder.includes("관리자가 다운로드 후 전달"),
  clientToolsExist: ["keyword-tool", "naver-rank", "seo-check", "agency-code"].every((screen) => clientScreens.includes(screen)),
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
  superAdminCanCreateClient: superAdminServer.includes('action === "create-client"') && superAdminServer.includes("return createClient(request, ctx, body)"),
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
