import fs from "node:fs";
import vm from "node:vm";

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
  runtime: "src/server/runtime.mjs",
  errorSafety: "src/server/error-safety.mjs",
  readiness: "src/server/handlers/ready.mjs",
  productCron: "src/server/handlers/naver-rank-cron.mjs",
  placeCron: "src/server/handlers/naver-place-rank-cron.mjs",
  productTrackers: "src/server/handlers/naver-rank-trackers.mjs",
  clientApi: "src/server/handlers/client-api.mjs",
  vercel: "vercel.json",
};

const productWorkflow = fs.readFileSync(files.productWorkflow, "utf8");
const placeWorkflow = fs.readFileSync(files.placeWorkflow, "utf8");
const legacyDeploy = fs.readFileSync(files.legacyDeploy, "utf8");
const packageJson = JSON.parse(fs.readFileSync(files.packageJson, "utf8"));
const serverIndex = fs.readFileSync(files.serverIndex, "utf8");
const sessionGate = fs.readFileSync(files.sessionGate, "utf8");
const ownerIdentity = fs.readFileSync(files.ownerIdentity, "utf8");
const ownerTool = fs.readFileSync(files.ownerTool, "utf8");
const ownerToolAdapter = fs.readFileSync(files.ownerToolAdapter, "utf8");
const runtime = fs.readFileSync(files.runtime, "utf8");
const errorSafety = fs.readFileSync(files.errorSafety, "utf8");
const readiness = fs.readFileSync(files.readiness, "utf8");
const productCron = fs.readFileSync(files.productCron, "utf8");
const placeCron = fs.readFileSync(files.placeCron, "utf8");
const productTrackers = fs.readFileSync(files.productTrackers, "utf8");
const clientApi = fs.readFileSync(files.clientApi, "utf8");
const vercel = JSON.parse(fs.readFileSync(files.vercel, "utf8"));
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
    /const maxBatches = 10;/,
    /for \(let batch = 1; batch <= maxBatches;/,
    /searchParams\.set\("limit", String\(batchSize\)\)/,
  ]) && !/limit=100/.test(productWorkflow),
  files.productWorkflow,
);
check(
  "product cron validates timeout, HTTP, JSON, ok and failed",
  hasAll(productWorkflow, [
    /AbortController/,
    /requestTimeoutMs/,
    /if \(!response\.ok\)/,
    /JSON\.parse\(body\)/,
    /payload\.ok !== true/,
    /safe\.failed > 0/,
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
  ]),
  files.placeWorkflow,
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
    /const tax = \(supply \+ 5n\) \/ 10n/,
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
    /limit: DEFAULT_CRON_BATCH/,
    /drainMode/,
    /!summary\.configured/,
    /!summary\.drained && !drainMode/,
    /}, 503\)/,
  ]) && hasAll(placeCron, [
    /limit: DEFAULT_CRON_BATCH/,
    /drainMode/,
    /!summary\.configured/,
    /summary\.partial > 0/,
    /!summary\.drained && !drainMode/,
    /}, 503\)/,
    /}, 502\)/,
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
  "Vercel release requires quality and production authentication gates",
  vercel.buildCommand === "npm run check:release"
    && packageJson.scripts?.["check:production-auth"] === "node scripts/check-production-auth.mjs"
    && String(packageJson.scripts?.["check:release"] || "").includes("npm run check:quality")
    && String(packageJson.scripts?.["check:release"] || "").includes("npm run check:production-auth"),
  `${files.vercel}, ${files.packageJson}`,
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
