// 개인 캘린더 계정 격리 정적 검사 (설계 §5.3).
//
// 테스트는 "지금 이 입력에서 무엇이 반환되는가" 를 증명하고, 이 스크립트는
// "격리를 만드는 문장이 소스에 그대로 남아 있는가" 를 증명한다. 두 가지가
// 필요한 이유는 술어 하나가 사라진 뒤에도 픽스처가 우연히 통과할 수 있기
// 때문이다 — 특히 개인 행이 아직 없는 배포 창에서는 모든 조회가 같은 결과를 낸다.
//
// 검사 방식은 scripts/check-role-query-parity.mjs · check-server-contract.mjs 와
// 같다. 소스를 읽어 문자열·블록을 단언하고, 하나라도 깨지면 1 로 종료한다.

import fs from "node:fs";
import path from "node:path";

const files = {
  workItems: "src/server/handlers/work-items.mjs",
  personalIdentity: "src/server/handlers/personal-identity.mjs",
  personalAssistant: "src/server/handlers/personal-assistant-api.mjs",
  adminApi: "src/server/handlers/admin-api.mjs",
  sessionGate: "src/server/session-gate.mjs",
  googleCalendarApi: "src/server/handlers/google-calendar-api.mjs",
  packageJson: "package.json",
};

function read(file) {
  return fs.readFileSync(file, "utf8");
}

// 주석은 근거가 아니다. "x-mi-agency-code 는 여기서 절대 읽지 않는다" 같은
// 설명문이 그 헤더를 실제로 읽는 코드와 같은 문자열을 담고 있으므로, 코드만
// 남기고 판정해야 검사가 뒤집히지 않는다.
function stripComments(source) {
  let output = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") quote = char;
    output += char;
  }
  return output;
}

// 매개변수 목록의 닫는 괄호를 먼저 찾는다. 기본값·구조분해를 쓰는 시그니처
// (applyFilters(query, url, id, config = {}) · applyAccessScope(..., { ... } = {}))
// 는 본문보다 먼저 나오는 중괄호를 갖고 있어서, indexOf("{") 로 본문을 잡으면
// 블록이 매개변수 한 줄로 잘린다.
function functionBodyStart(source, from) {
  const parenOpen = source.indexOf("(", from);
  if (parenOpen < 0) return -1;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = parenOpen; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.indexOf("{", index);
    }
  }
  return -1;
}

// check-role-query-parity.mjs 의 블록 추출기와 같은 규칙(문자열·주석 인식).
function functionBlock(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return "";
  const open = functionBodyStart(source, match.index);
  if (open < 0) return "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  return "";
}

function includesAll(source, markers) {
  return markers.every((marker) => source.includes(marker));
}

function includesNone(source, markers) {
  return markers.every((marker) => !source.includes(marker));
}

function listFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full));
    else found.push(full);
  }
  return found;
}

const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
}

// ─────────────────────────────────────────────────────────────
// 소스 읽기
// ─────────────────────────────────────────────────────────────
const workItemsSource = stripComments(read(files.workItems));
const workItemsRaw = read(files.workItems);
const personalIdentitySource = stripComments(read(files.personalIdentity));
const personalAssistantSource = stripComments(read(files.personalAssistant));
const adminApiSource = stripComments(read(files.adminApi));
const sessionGateSource = stripComments(read(files.sessionGate));
const sessionGateRaw = read(files.sessionGate);
const googleCalendarApiSource = stripComments(read(files.googleCalendarApi));
const packageJson = JSON.parse(read(files.packageJson));

const applyAccessScopeBlock = functionBlock(workItemsSource, "applyAccessScope");
const excludePersonalRowsBlock = functionBlock(workItemsSource, "excludePersonalRows");
const personalRowScopeBlock = functionBlock(workItemsSource, "personalRowScope");
const accessForRequestBlock = functionBlock(workItemsSource, "accessForRequest");
const resolveAccessBlock = functionBlock(workItemsSource, "resolveAccess");
const workItemsMethodBlocks = ["handleGet", "handlePost", "handlePatch", "handleDelete"]
  .map((name) => [name, functionBlock(workItemsSource, name)]);

// applyAccessScope 는 개인 분기 하나와 그 뒤의 운영 분기들로 이뤄진다.
// 개인 분기의 끝(첫 세미콜론으로 닫히는 return 문 다음의 닫는 중괄호)을 기준으로
// 두 조각을 나눠 각각 다른 규칙으로 검사한다.
const personalBranchStart = applyAccessScopeBlock.indexOf("if (access.personalKey) {");
const personalBranchEnd = applyAccessScopeBlock.indexOf("}", applyAccessScopeBlock.indexOf(".eq(\"owner_agency_code\", access.personalKey);"));
const personalBranch = personalBranchStart >= 0 && personalBranchEnd > personalBranchStart
  ? applyAccessScopeBlock.slice(personalBranchStart, personalBranchEnd + 1)
  : "";
const operationalBranches = personalBranchEnd > 0 ? applyAccessScopeBlock.slice(personalBranchEnd + 1) : "";
const operationalReturns = operationalBranches
  .split("\n")
  .filter((line) => /\breturn\b/.test(line));

// ─────────────────────────────────────────────────────────────
// work-items.mjs
// ─────────────────────────────────────────────────────────────
check(
  "work-items: every operational applyAccessScope branch returns through excludePersonalRows",
  Boolean(excludePersonalRowsBlock)
    && excludePersonalRowsBlock.includes('query.is("personal_role", null)')
    && operationalReturns.length >= 4
    && operationalReturns.every((line) => line.includes("excludePersonalRows(")),
  `${files.workItems} applyAccessScope (${operationalReturns.length} operational returns)`,
);

check(
  "work-items: the personal branch pins personal_role, personal_code and owner_agency_code",
  Boolean(personalBranch) && includesAll(personalBranch, [
    '.eq("personal_role", access.personalRole)',
    '.eq("personal_code", access.personalCode)',
    '.eq("owner_agency_code", access.personalKey)',
  ]),
  `${files.workItems} applyAccessScope personal branch`,
);

check(
  "work-items: the personal predicates are unconditional while excludePersonalRows is column-gated",
  Boolean(personalBranch)
    && !personalBranch.includes("optionalColumnEnabled")
    && excludePersonalRowsBlock.includes('optionalColumnEnabled("personal_role")')
    // 행에서 뽑는 개인 술어(UPDATE·DELETE·형제 조회)도 같은 게이트를 쓴다.
    && personalRowScopeBlock.includes('optionalColumnEnabled("personal_role")'),
  `${files.workItems} excludePersonalRows / personalRowScope`,
);

check(
  "work-items: all four method handlers resolve access through accessForRequest",
  workItemsMethodBlocks.every(([, block]) => block.includes("await accessForRequest(request, ctx)"))
    && includesAll(functionBlock(workItemsSource, "handleWorkItemsRequest"), [
      "handleGet(request, ctx)",
      "handlePost(request, ctx)",
      "handlePatch(request, ctx)",
      "handleDelete(request, ctx)",
    ]),
  `${files.workItems} ${workItemsMethodBlocks.map(([name]) => name).join(", ")}`,
);

check(
  "work-items: accessForRequest splits the personal path and fails closed on demoted columns",
  includesAll(accessForRequestBlock, [
    "PERSONAL_WORK_ITEMS_PATH",
    "return resolveAccess(request, ctx)",
    "personalStorageReady()",
    '"personal_calendar_not_ready"',
    "resolvePersonalAccess(request, ctx)",
  ]),
  `${files.workItems} accessForRequest`,
);

check(
  "work-items: resolvePersonalAccess is imported from ./personal-identity.mjs",
  /import\s*\{[^}]*resolvePersonalAccess[^}]*\}\s*from\s*"\.\/personal-identity\.mjs"/su.test(workItemsSource)
    && /import\s*\{[^}]*personalRowKeys[^}]*\}\s*from\s*"\.\/personal-identity\.mjs"/su.test(workItemsSource),
  `${files.workItems} import`,
);

// activeClientByAgencyCode 는 .eq("agency_code", 소문자) 라 대문자 코드를 못 찾는다.
// 개인 경로가 이 조회로 계정을 정하면 활성 광고주가 404 가 된다 — 운영 경로
// 전용 함수여야 하고, 실제로 resolveAccess 안에서만 불려야 한다.
const agencyLookupCallSites = [...workItemsSource.matchAll(/await activeClientByAgencyCode\(ctx/gu)].map((match) => match.index);
const resolveAccessStart = workItemsSource.indexOf(resolveAccessBlock);
check(
  "work-items: activeClientByAgencyCode is never reached from a personal path",
  agencyLookupCallSites.length > 0
    && agencyLookupCallSites.every((index) => index >= resolveAccessStart
      && index < resolveAccessStart + resolveAccessBlock.length)
    && !accessForRequestBlock.includes("activeClientByAgencyCode")
    && !applyAccessScopeBlock.includes("activeClientByAgencyCode"),
  `${files.workItems} resolveAccess (${agencyLookupCallSites.length} call sites)`,
);

// ─────────────────────────────────────────────────────────────
// personal-identity.mjs
// ─────────────────────────────────────────────────────────────
const resolvePersonalAccessBlock = functionBlock(personalIdentitySource, "resolvePersonalAccess");
const teamBranchStart = resolvePersonalAccessBlock.indexOf('if (role === "team") {');
const clientBranchStart = resolvePersonalAccessBlock.indexOf("const agencyCode = normalizeCode(request.headers.get(\"x-mi-agency-code\"));");
const teamBranch = teamBranchStart >= 0 && clientBranchStart > teamBranchStart
  ? resolvePersonalAccessBlock.slice(teamBranchStart, clientBranchStart)
  : "";
const clientBranch = clientBranchStart >= 0 ? resolvePersonalAccessBlock.slice(clientBranchStart) : "";

check(
  "personal-identity: the team branch never reads x-mi-agency-code (the client branch may)",
  Boolean(teamBranch)
    && !teamBranch.includes("x-mi-agency-code")
    && teamBranch.includes('request.headers.get("x-mi-team-code")')
    && clientBranch.includes("x-mi-agency-code"),
  `${files.personalIdentity} resolvePersonalAccess`,
);

check(
  "personal-identity: the principal key is prefixed by role and built from uuids only",
  includesAll(functionBlock(personalIdentitySource, "personalPrincipalKey"), [
    'if (personalRole === "owner") return personalCode;',
    "`${personalRole}:${personalCode}`",
    "normalizedUuid(personalCode)",
  ]) && includesAll(functionBlock(personalIdentitySource, "personalRowKeys"), [
    "personal_role: access.personalRole",
    "personal_code: access.personalCode",
    "owner_agency_code: access.personalKey",
  ]),
  `${files.personalIdentity} personalPrincipalKey, personalRowKeys`,
);

// ─────────────────────────────────────────────────────────────
// admin-api.mjs
// ─────────────────────────────────────────────────────────────
const scopeToSharedBlock = functionBlock(adminApiSource, "scopeToSharedOperationRows");
check(
  "admin-api: scopeToSharedOperationRows guards personal_role next to calendar_id (I11)",
  includesAll(scopeToSharedBlock, [
    'query.is("calendar_id", null)',
    'optionalColumnEnabled("personal_role")',
    'scoped.is("personal_role", null)',
  ]) && functionBlock(adminApiSource, "applyFilters").includes("config.personalOnly"),
  `${files.adminApi} scopeToSharedOperationRows, applyFilters`,
);

// ─────────────────────────────────────────────────────────────
// session-gate.mjs
// ─────────────────────────────────────────────────────────────
const credentialHeaderList = /const CREDENTIAL_HEADERS = \[([^\]]*)\]/su.exec(sessionGateRaw)?.[1] || "";
const credentialHeaders = [...credentialHeaderList.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
const EXPECTED_CREDENTIAL_HEADERS = [
  "authorization",
  "apikey",
  "x-demo-admin-code",
  "x-mi-agency-code",
  "x-mi-rank-access-code",
  "x-mi-super-admin-code",
  "x-mi-owner-agency-code",
  "x-mi-team-code",
  "x-mi-session-role",
  "x-mi-session-scope",
];
check(
  "session-gate: CREDENTIAL_HEADERS still has exactly the same 10 names (no new forgeable header)",
  credentialHeaders.length === EXPECTED_CREDENTIAL_HEADERS.length
    && EXPECTED_CREDENTIAL_HEADERS.every((name, index) => credentialHeaders[index] === name)
    && sessionGateSource.includes("for (const name of CREDENTIAL_HEADERS) headers.delete(name);"),
  `${files.sessionGate} CREDENTIAL_HEADERS (${credentialHeaders.length} entries)`,
);

check(
  "session-gate: owner and admin surfaces stay closed to team and client roles",
  (sessionGateSource.match(/!path\.startsWith\("\/api\/owner\/"\)/gu) || []).length >= 2
    && (sessionGateSource.match(/!path\.startsWith\("\/api\/admin\/"\)/gu) || []).length >= 2,
  `${files.sessionGate} roleAllowsPath`,
);

const personalPathsBlock = /const ACCOUNT_ONLY_PERSONAL_PATHS = new Set\(\[([^\]]*)\]/su.exec(sessionGateSource)?.[1] || "";
const personalPaths = [...personalPathsBlock.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
check(
  "session-gate: exactly the four /api/my/* paths open for an advertiser-unlinked team session",
  personalPaths.length === 4
    && personalPaths.every((entry) => entry.startsWith("/api/my/"))
    && includesAll(personalPaths.join(" "), [
      "/api/my/work-items",
      "/api/my/google-calendar",
      "/api/my/google-login",
      "/api/my/assistant-chat",
    ])
    && functionBlock(sessionGateSource, "sessionScopeAllowsPath").includes("ACCOUNT_ONLY_PERSONAL_PATHS.has(path)"),
  `${files.sessionGate} ACCOUNT_ONLY_PERSONAL_PATHS (${personalPaths.length} paths)`,
);

// 실장 대화는 개인 일정을 프롬프트에 싣는 유일한 경로다. 계정 판정이
// resolvePersonalAccess 하나로 끝나고, 일정 행을 서버가 직접 읽지 않는다는 두
// 문장이 소스에 남아 있어야 "다른 계정의 일정이 프롬프트에 닿을 길이 없다" 가
// 유지된다. 자격 헤더를 이 파일이 직접 읽어서도 안 된다 — session-gate 가 지운
// 뒤 다시 심고, 그것을 읽는 곳은 personal-identity 하나여야 한다.
const personalAssistantHandlerBlock = functionBlock(personalAssistantSource, "handlePersonalAssistantRequest");
check(
  "personal-assistant: the chat resolves the account through resolvePersonalAccess and never reads schedule rows",
  includesAll(personalAssistantSource, [
    'import { resolvePersonalAccess } from "./personal-identity.mjs";',
  ])
    && includesAll(personalAssistantHandlerBlock, [
      "resolvePersonalAccess(request, ctx)",
      "access.personalKey",
    ])
    && includesNone(personalAssistantSource, [
      "supabaseAdmin.from(",
      "schedule_items",
      "/api/owner/",
      "x-mi-agency-code",
    ]),
  `${files.personalAssistant} handlePersonalAssistantRequest`,
);

// ─────────────────────────────────────────────────────────────
// google-calendar-api.mjs
// ─────────────────────────────────────────────────────────────
const oauthCallbackBlock = functionBlock(googleCalendarApiSource, "handleOauthCallback");
const rebuiltKeyAt = oauthCallbackBlock.indexOf("personalPrincipalKey(state.r, state.owner)");
const recheckedAt = oauthCallbackBlock.indexOf("activePersonalPrincipal(ctx, accountKey)");
const integrationWriteAt = oauthCallbackBlock.indexOf('.from("owner_google_integrations")');
check(
  "google-calendar-api: the calendar callback rebuilds the key and re-checks the account before writing",
  rebuiltKeyAt >= 0
    && recheckedAt > rebuiltKeyAt
    && integrationWriteAt > recheckedAt
    && oauthCallbackBlock.includes('if (state.p === "link") return handleLinkCallback(request, ctx, state, code);')
    && oauthCallbackBlock.includes('if (state.p === "login") return handleLoginCallback(request, ctx, code, state);'),
  `${files.googleCalendarApi} handleOauthCallback`,
);

const roleRedirectBlock = functionBlock(googleCalendarApiSource, "roleRedirect");
const callbackRedirectBlock = functionBlock(googleCalendarApiSource, "callbackRedirect");
const loginRedirectBlock = functionBlock(googleCalendarApiSource, "loginRedirect");
check(
  "google-calendar-api: redirect destinations come from a fixed table, never from a URL parameter",
  includesAll(googleCalendarApiSource, [
    "const ROLE_REDIRECTS = {",
    'owner: { base: "/admin", hash: "#mi-admin-owner-assistant" }',
    'team: { base: "/admin", hash: "" }',
    'client: { base: "/client", hash: "" }',
  ])
    && roleRedirectBlock.includes("ROLE_REDIRECTS[cleanText(role).toLowerCase()] || ROLE_REDIRECTS.owner")
    && callbackRedirectBlock.includes("roleRedirect(role)")
    && loginRedirectBlock.includes("roleRedirect(role)")
    && includesNone(`${roleRedirectBlock}${callbackRedirectBlock}${loginRedirectBlock}`, [
      "searchParams",
      "request.url",
      "body.",
    ]),
  `${files.googleCalendarApi} ROLE_REDIRECTS, roleRedirect, callbackRedirect, loginRedirect`,
);

check(
  "google-calendar-api: the OAuth state carries a signed role that only known roles can hold",
  includesAll(functionBlock(googleCalendarApiSource, "signOauthState"), [
    "owner: cleanText(ownerCode).toLowerCase()",
    'r: cleanText(role).toLowerCase() || "owner"',
    'p: cleanText(purpose) || "calendar"',
  ]) && includesAll(functionBlock(googleCalendarApiSource, "verifyOauthState"), [
    'payload.r = cleanText(payload.r).toLowerCase() || "owner"',
    "if (!PERSONAL_ROLES.has(payload.r)) return null;",
    "crypto.timingSafeEqual(provided, wanted)",
  ]),
  `${files.googleCalendarApi} signOauthState, verifyOauthState`,
);

// ─────────────────────────────────────────────────────────────
// 저장소 전체
// ─────────────────────────────────────────────────────────────
const scannedSources = [...listFiles("src/server"), ...listFiles("src/pages")];
const legacyAuthPathFiles = scannedSources.filter((file) => read(file).includes("/api/auth/"));
check(
  "no file under src/server or src/pages references the legacy /api/auth/ surface",
  legacyAuthPathFiles.length === 0,
  `${scannedSources.length} files scanned${legacyAuthPathFiles.length ? `: ${legacyAuthPathFiles.join(", ")}` : ""}`,
);

check(
  "package.json wires this check into check:quality and leaves check:release untouched",
  String(packageJson.scripts?.["check:personal-isolation"] || "") === "node scripts/check-personal-isolation.mjs"
    && String(packageJson.scripts?.["check:quality"] || "").includes("npm run check:personal-isolation")
    && String(packageJson.scripts?.["check:release"] || "") === "npm run check:quality && npm run check:production-auth",
  files.packageJson,
);

for (const result of checks) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.detail})`);
}

const failed = checks.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`Personal isolation check failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}

console.log(`Personal isolation check passed: ${checks.length}/${checks.length}`);
