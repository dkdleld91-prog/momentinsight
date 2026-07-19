import fs from "node:fs";

const files = {
  index: "src/server/index.mjs",
  session: "src/server/code-session.mjs",
  gate: "src/server/session-gate.mjs",
  login: "src/server/handlers/code-session-api.mjs",
  ownerIdentity: "src/server/owner-identity.mjs",
  ownerTool: "src/server/handlers/owner-tool-api.mjs",
  runtimeEnv: "scripts/check-runtime-env.mjs",
  adminPage: "src/pages/admin.html",
  clientPage: "src/pages/client.html",
  productRank: "src/server/handlers/naver-rank-trackers.mjs",
  placeRank: "src/server/handlers/naver-place-rank-trackers.mjs",
  adminApi: "src/server/handlers/admin-api.mjs",
  migration: "supabase/migrations/20260719090000_code_session_rate_limits.sql",
};

const source = Object.fromEntries(
  Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, "utf8")]),
);

function functionBlock(text, name) {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  if (!match) return "";
  let parenDepth = 0;
  let close = -1;
  for (let index = text.indexOf("(", match.index); index < text.length; index += 1) {
    if (text[index] === "(") parenDepth += 1;
    if (text[index] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        close = index;
        break;
      }
    }
  }
  const open = close >= 0 ? text.indexOf("{", close) : -1;
  if (open < 0) return "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(match.index, index + 1);
    }
  }
  return "";
}

const authorizeBlock = functionBlock(source.gate, "authorizeCodeSession");
const currentSessionBlock = functionBlock(source.login, "currentSession");
const currentSessionUnavailableBlock = currentSessionBlock.slice(
  currentSessionBlock.indexOf("SESSION_ACTIVITY_UNAVAILABLE"),
  currentSessionBlock.indexOf("activity.state !== SESSION_ACTIVITY_ACTIVE"),
);
const productListBlock = functionBlock(source.productRank, "listTrackers");
const placeListBlock = functionBlock(source.placeRank, "listTrackers");
const adminDeleteBlock = functionBlock(source.adminApi, "handleDelete");
const protectedAdminResourceBlocks = [
  source.adminApi.slice(source.adminApi.indexOf("  clients: {"), source.adminApi.indexOf("  brands: {")),
  source.adminApi.slice(source.adminApi.indexOf('  "naver-rank-trackers": {'), source.adminApi.indexOf('  "naver-rank-snapshots": {')),
  source.adminApi.slice(source.adminApi.indexOf('  "naver-rank-snapshots": {'), source.adminApi.indexOf("\n};")),
];
const adminFetch = functionBlock(source.adminPage, "miFetch");
const clientFetch = functionBlock(source.clientPage, "miFetch");
const adminProductRequest = functionBlock(source.adminPage, "requestRankTrackers");
const adminPlaceRequest = functionBlock(source.adminPage, "requestPlaceTrackers");
const clientProductRequest = functionBlock(source.clientPage, "requestRankTrackers");
const clientPlaceRequest = functionBlock(source.clientPage, "requestPlaceTrackers");

const checks = [
  {
    name: "all business APIs pass through the central session and body-size gate",
    ok: source.index.includes("const bounded = await boundedApiRequest(request)")
      && source.index.includes("const authorized = await authorizeCodeSession(bounded.request)")
      && source.index.includes("routeRequest(authorized.request)")
      && source.index.includes('url.pathname === "/api/session"'),
    file: files.index,
  },
  {
    name: "session authorization separates revocation from temporary validation outages",
    ok: source.gate.includes("export async function sessionActivityState")
      && source.gate.includes("export async function authorizeCodeSession")
      && authorizeBlock.includes("const activityState = await sessionActivityState(claims, env, options)")
      && authorizeBlock.includes("activityState === SESSION_ACTIVITY_UNAVAILABLE")
      && authorizeBlock.includes('code: "SESSION_VALIDATION_UNAVAILABLE"')
      && authorizeBlock.includes("}, 503)")
      && authorizeBlock.includes('code: "SESSION_REVOKED"')
      && authorizeBlock.indexOf("await sessionActivityState") < authorizeBlock.indexOf("internalRequestForSession"),
    file: files.gate,
  },
  {
    name: "session restore preserves cookies when live validation is temporarily unavailable",
    ok: source.login.includes("export async function sessionActivityState")
      && currentSessionBlock.includes("activity.state === SESSION_ACTIVITY_UNAVAILABLE")
      && currentSessionUnavailableBlock.includes('code: "SESSION_VALIDATION_UNAVAILABLE"')
      && currentSessionUnavailableBlock.includes("}, 503)")
      && !currentSessionUnavailableBlock.includes("clearedSessionCookies")
      && currentSessionBlock.includes("activity.state !== SESSION_ACTIVITY_ACTIVE")
      && currentSessionBlock.includes("401, clearedSessionCookies()"),
    file: files.login,
  },
  {
    name: "session tokens are confidential authenticated cookies",
    ok: source.session.includes('createCipheriv("aes-256-gcm"')
      && source.session.includes('createDecipheriv("aes-256-gcm"')
      && source.session.includes('"HttpOnly"')
      && source.session.includes('"SameSite=Strict"')
      && source.session.includes('parts.push("Secure")')
      && source.session.includes("MI_SESSION_SECRET")
      && source.session.includes("MIN_SECRET_BYTES = 32")
      && source.session.includes("MI_SESSION_SECRET_PREVIOUS")
      && source.session.includes("previousStrong")
      && source.session.includes("isProduction(env)")
      && source.session.includes("cookies[PROD_COOKIE]"),
    file: files.session,
  },
  {
    name: "browser credentials are stripped and server credentials are injected after session authorization",
    ok: source.gate.includes("CREDENTIAL_HEADERS")
      && source.gate.includes('headers.delete(name)')
      && source.gate.includes('headers.set("x-mi-super-admin-code", superAdminCode)')
      && source.gate.includes('headers.set("apikey", key)')
      && source.gate.includes("roleAllowsPath")
      && source.gate.includes("csrfMatches")
      && source.gate.includes("mutationOriginAllowed")
      && source.gate.includes("sessionActivityState")
      && source.gate.includes('code: "SESSION_REVOKED"'),
    file: files.gate,
  },
  {
    name: "owner login fails closed without a separate server credential",
    ok: source.login.includes("MI_OWNER_LOGIN_CODE_SHA256")
      && source.login.includes("MI_OWNER_LOGIN_CODE")
      && source.login.includes("if (!isProduction(env))")
      && source.login.includes("return false;")
      && source.login.includes("SESSION_CONFIGURATION_REQUIRED"),
    file: files.login,
  },
  {
    name: "code login uses durable database rate limiting in production",
    ok: source.login.includes('rpc("consume_code_login_rate_limit"')
      && source.login.includes("LOGIN_RATE_LIMIT_UNAVAILABLE")
      && source.login.includes("LOGIN_IP_ATTEMPT_LIMIT")
      && source.login.includes("loginRateKeys")
      && source.login.includes("if (isProduction())")
      && source.migration.includes("pg_advisory_xact_lock")
      && source.migration.includes("enable row level security")
      && source.migration.includes("revoke all on function")
      && source.migration.includes("grant execute on function"),
    file: `${files.login}, ${files.migration}`,
  },
  {
    name: "product and place rank scope prefers trusted session headers over request bodies",
    ok: [source.productRank, source.placeRank].every((handler) => (
      handler.includes('const trustedSession = Boolean(request.headers.get("x-mi-session-role"));')
      && handler.includes('const trustedAgencyCode = request.headers.get("x-mi-agency-code") || "";')
      && handler.includes("trustedAgencyCode ||")
      && handler.includes('request.headers.get("x-mi-rank-access-code") ||')
      && handler.includes('(trustedSession ? "" : (')
    )),
    file: `${files.productRank}, ${files.placeRank}`,
  },
  {
    name: "rank tracker lists return a complete 500-row scoped response contract",
    ok: [source.productRank, source.placeRank].every((handler) => (
      handler.includes("const TRACKER_LIST_MAX = 500")
      && handler.includes("const TRACKER_LIST_QUERY_LIMIT = TRACKER_LIST_MAX + 1")
    ))
      && [productListBlock, placeListBlock].every((block) => (
        block.includes(".limit(TRACKER_LIST_QUERY_LIMIT)")
        && block.includes('.select(TRACKER_SELECT, { count: "exact" })')
        && block.includes(".slice(0, TRACKER_LIST_MAX)")
        && block.includes("scopeKey:")
        && block.includes("scopeAgencyCode:")
        && block.includes("scopeClientId:")
        && block.includes("returnedCount:")
        && block.includes("totalCount:")
        && block.includes("hasMore,")
        && block.includes("complete: !hasMore && rows.length === count")
      )),
    file: `${files.productRank}, ${files.placeRank}`,
  },
  {
    name: "product rank history preserves up to 120 snapshots from the last 30 days",
    ok: source.productRank.includes("const PRODUCT_RANK_HISTORY_DAYS = 30")
      && source.productRank.includes("const PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS = 120")
      && source.productRank.includes("checkedAt >= historyCutoff")
      && source.productRank.includes(".slice(0, PRODUCT_RANK_HISTORY_MAX_SNAPSHOTS)"),
    file: files.productRank,
  },
  {
    name: "generic admin API blocks hard delete for clients and rank history",
    ok: source.adminApi.includes("export function resourceHardDeleteBlocked")
      && source.adminApi.includes('code: "HARD_DELETE_BLOCKED"')
      && adminDeleteBlock.includes("if (config.hardDeleteBlocked)")
      && protectedAdminResourceBlocks.every((block) => block.includes("hardDeleteBlocked: true")),
    file: files.adminApi,
  },
  {
    name: "raw advertiser and staff codes are not persisted as browser credentials",
    ok: !/localStorage\.setItem\("miClientAuthedCode"/.test(source.clientPage)
      && !/localStorage\.setItem\("miAdminAuthedCode"/.test(source.adminPage)
      && !/localStorage\.setItem\("miRankAccessCode"/.test(source.clientPage)
      && source.adminPage.includes("restoreSecureSession")
      && source.clientPage.includes("restoreClientSession"),
    file: `${files.adminPage}, ${files.clientPage}`,
  },
  {
    name: "client rank requests rely on the verified session instead of retransmitting access codes",
    ok: [clientProductRequest, clientPlaceRequest].every((block) => (
      block.includes("var requestScope = verifiedRankTrackerScope()")
      && block.includes("if (!requestScope)")
      && block.includes("!sameRankTrackerScope(requestScope)")
      && block.includes('headers: {}')
      && block.includes('new URLSearchParams({ limit: "500" })')
      && !/x-mi-(?:agency|rank-access)-code/.test(block)
      && !/\b(?:accessCode|agencyCode)\s*:/.test(block)
    ))
      && !source.clientPage.includes('"x-mi-rank-access-code": accessCode')
      && !source.clientPage.includes("function rankAccessCode()"),
    file: files.clientPage,
  },
  {
    name: "admin rank requests expose only an owner-selected target and never retransmit login secrets",
    ok: adminFetch.includes('requestHeaders.delete("x-mi-agency-code")')
      && [adminProductRequest, adminPlaceRequest].every((block) => (
        block.includes('headers: canManageOwnerCodes() ? { "x-mi-agency-code": agencyCode } : {}')
        && !/x-mi-rank-access-code|x-demo-admin-code/.test(block)
        && !/\b(?:adminCode|accessCode)\s*:/.test(block)
      ))
      && !source.adminPage.includes('"x-demo-admin-code": adminCode')
      && !source.adminPage.includes('"x-mi-rank-access-code": adminCode')
      && !source.adminPage.includes("adminCode: adminCode"),
    file: files.adminPage,
  },
  {
    name: "browser mutations carry csrf while server-only credential headers are deleted",
    ok: source.adminPage.includes('requestHeaders.set("x-mi-csrf", secureSession.csrfToken)')
      && source.clientPage.includes('requestHeaders.set("x-mi-csrf", secureClientSession.csrfToken)')
      && [adminFetch, clientFetch].every((page) => (
        page.includes('"x-mi-super-admin-code"')
        && page.includes("requestHeaders.delete(name)")
      )),
    file: `${files.adminPage}, ${files.clientPage}`,
  },
  {
    name: "email magic-link authentication is not present",
    ok: [source.adminPage, source.clientPage, source.index].every((item) => (
      !/signInWithOtp|requestMagicLink|moment-auth\.js|\/api\/auth\//.test(item)
    )),
    file: `${files.adminPage}, ${files.clientPage}, ${files.index}`,
  },
  {
    name: "owner sessions and private tools are bound to exact mml93-a01 identity",
    ok: source.ownerIdentity.includes('PRIMARY_AGENCY_CODE = "mml93-a01"')
      && source.ownerIdentity.includes('configured === PRIMARY_AGENCY_CODE')
      && source.ownerIdentity.includes('claims.agencyCode === PRIMARY_AGENCY_CODE')
      && source.gate.includes('!path.startsWith("/api/owner/")')
      && source.gate.includes('ownerClaimsMatchPrimary(claims, env)')
      && source.runtimeEnv.includes('merged.MI_PRIMARY_AGENCY_CODE === "mml93-a01"')
      && source.index.includes('url.pathname === "/api/owner/tool"')
      && source.ownerTool.includes('request.headers.get("x-mi-session-role") === "owner"')
      && source.ownerTool.includes('request.headers.get("x-mi-owner-agency-code") === PRIMARY_AGENCY_CODE'),
    file: `${files.ownerIdentity}, ${files.gate}, ${files.ownerTool}, ${files.runtimeEnv}`,
  },
  {
    name: "owner-only calculator is absent from public pages and loaded after verified owner session",
    ok: !/부가세|mi-vat|data-admin-vat|vat-calculator/i.test(source.adminPage)
      && !/부가세|mi-vat|data-admin-vat|vat-calculator/i.test(source.clientPage)
      && source.adminPage.includes('async function loadOwnerTool()')
      && source.adminPage.includes('if (secureSession.role !== "owner") return false;')
      && source.adminPage.includes('await loadOwnerTool()')
      && source.ownerTool.includes('data-owner-tool-input')
      && source.ownerTool.includes('const tax = (supply + 5n) / 10n'),
    file: `${files.adminPage}, ${files.clientPage}, ${files.ownerTool}`,
  },
];

for (const result of checks) {
  console.log(`${result.ok ? "PASS" : "BLOCK"} ${result.name} (${result.file})`);
}

const blocked = checks.filter((result) => !result.ok);
if (blocked.length) {
  console.error(
    `Production auth gate blocked: ${blocked.length}/${checks.length}. `
      + "코드 입력 UX는 유지하되 서버 세션, CSRF, 지속형 제한과 브라우저 비밀값 제거가 모두 확인돼야 합니다.",
  );
  process.exit(1);
}

console.log(`Production auth gate passed: ${checks.length}/${checks.length}`);
