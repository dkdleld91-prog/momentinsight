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
const homeSource = read("02_아임웹_적용코드/아임웹_원샷코드_홈페이지형_모먼트인사이트.html");
const rankServer = read("src/server/handlers/naver-rank-trackers.mjs");
const superAdminServer = read("src/server/handlers/super-admin-api.mjs");
const rankUnlimitedMigration = read("supabase/migrations/20260626074000_primary_rank_tracker_unlimited.sql");

const adminScreens = uniqueMatches(adminSource, /data-mi-admin-screen="([^"]+)"/g);
const clientScreens = uniqueMatches(clientSource, /data-mi-screen="([^"]+)"/g);

const checks = {
  adminCopySynced: adminSource === adminCopy,
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
  clientToolsExist: ["keyword-tool", "naver-rank", "seo-check", "agency-code"].every((screen) => clientScreens.includes(screen)),
  homeRoutesExist: homeSource.includes('href="/client#mi-dashboard"') && homeSource.includes('href="/admin"'),
  rankOwnerAccessBypassesClientRow: rankServer.includes("adminAuthorized && isPrimaryAgencyCode(agencyCode)") && rankServer.includes("clientId: null"),
  rankOwnerCreateLimitBypass: rankServer.includes("const unlimitedOwner") && rankServer.includes("!unlimitedOwner"),
  rankOwnerListLimit500: rankServer.includes("maxListLimit") && rankServer.includes("? 500 : 50"),
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
