import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function unique(values) {
  return [...new Set(values)].sort();
}

function matches(source, pattern) {
  return unique([...source.matchAll(pattern)].map((match) => match[1] || match[0]));
}

function includesAll(source, markers) {
  return markers.every((marker) => source.includes(marker));
}

function functionBlock(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return "";
  const open = source.indexOf("{", match.index);
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

function normalizedBlock(source, name) {
  return functionBlock(source, name).replace(/\s+/g, " ").trim();
}

function hasActions(block, actions) {
  const found = new Set(matches(block, /action:\s*"([^"]+)"/g));
  return actions.every((action) => found.has(action));
}

const adminSource = read("src/pages/admin.html");
const clientSource = read("src/pages/client.html");
const serverIndex = read("src/server/index.mjs");

const expectedEndpoints = [
  "/api/naver-keyword",
  "/api/naver-place-rank-trackers",
  "/api/naver-rank-trackers",
  "/api/naver-shopping-rank",
].sort();

const adminScreens = matches(adminSource, /data-mi-admin-screen="([^"]+)"/g);
const clientScreens = matches(clientSource, /data-mi-screen="([^"]+)"/g);
const adminEndpoints = matches(adminSource, /\/api\/naver-(?:keyword|place-rank-trackers|rank-trackers|shopping-rank)/g);
const clientEndpoints = matches(clientSource, /\/api\/naver-(?:keyword|place-rank-trackers|rank-trackers|shopping-rank)/g);
const apiHelperNames = [
  "getKeywordApiUrl",
  "getShoppingRankApiUrl",
  "getRankTrackerApiUrl",
  "getPlaceRankTrackerApiUrl",
];
const adminProductTracking = functionBlock(adminSource, "initRankTracking");
const clientProductTracking = functionBlock(clientSource, "initRankTracking");
const adminPlaceTracking = functionBlock(adminSource, "initPlaceRankTracking");
const clientPlaceTracking = functionBlock(clientSource, "initPlaceRankTracking");
const adminFetch = functionBlock(adminSource, "miFetch");
const clientFetch = functionBlock(clientSource, "miFetch");
const adminProductRequest = functionBlock(adminSource, "requestRankTrackers");
const clientProductRequest = functionBlock(clientSource, "requestRankTrackers");
const adminPlaceRequest = functionBlock(adminSource, "requestPlaceTrackers");
const clientPlaceRequest = functionBlock(clientSource, "requestPlaceTrackers");

const sharedPageMarkers = [
  "async function fetchKeywordData",
  "async function runKeywordLookup",
  "async function runSeoCheck",
  "function makeRelatedKeywords",
  "function initRankCheck",
  "function initRankTracking",
  "function initPlaceRankTracking",
  "function dueRankTrackers",
  "async function syncDueRankTrackersIfNeeded",
  "function duePlaceTrackers",
  "async function syncDuePlaceTrackersIfNeeded",
  'action: "sync-due"',
  "await syncDueRankTrackersIfNeeded(silent)",
  "await syncDuePlaceTrackersIfNeeded(silent)",
  "maxRank: 300",
];

const checks = {
  adminScreensConnected: [
    "keyword",
    "seo-check",
    "related-keywords",
    "naver-rank",
    "naver-rank-tracking",
    "naver-place-rank-tracking",
  ].every((screen) => adminScreens.includes(screen)),
  clientScreensConnected: [
    "keyword-tool",
    "seo-check",
    "related-keywords",
    "naver-rank",
    "naver-rank-tracking",
    "naver-place-rank-tracking",
  ].every((screen) => clientScreens.includes(screen)),
  roleEndpointSetsMatch: JSON.stringify(adminEndpoints) === JSON.stringify(expectedEndpoints)
    && JSON.stringify(clientEndpoints) === JSON.stringify(expectedEndpoints),
  apiHelperBodiesAligned: apiHelperNames.every((name) => normalizedBlock(adminSource, name)
    && normalizedBlock(adminSource, name) === normalizedBlock(clientSource, name)),
  sharedRuntimeHooksMatch: includesAll(adminSource, sharedPageMarkers)
    && includesAll(clientSource, sharedPageMarkers),
  toolSelectorsWired: includesAll(adminSource, [
    "[data-admin-keyword-search]",
    "[data-seo-run]",
    "[data-rank-check-card]",
    "[data-rank-card]",
    "[data-place-rank-card]",
    "[data-keyword-related]",
  ]) && includesAll(clientSource, [
    "[data-mi-keyword-search]",
    "[data-seo-run]",
    "[data-rank-check-card]",
    "[data-rank-card]",
    "[data-place-rank-card]",
    "[data-keyword-related]",
  ]),
  relatedKeywordViewsConnected: adminSource.includes('href="#mi-admin-related-keywords" data-mi-admin-screen="related-keywords"')
    && clientSource.includes('href="#mi-related-keywords" data-mi-screen="related-keywords"'),
  adminTrackingAuthConnected: includesAll(adminFetch, [
    'requestHeaders.delete("x-mi-agency-code")',
    'requestHeaders.set("x-mi-csrf", secureSession.csrfToken)',
  ])
    && [adminProductRequest, adminPlaceRequest].every((block) => includesAll(block, [
      'headers: canManageOwnerCodes() ? { "x-mi-agency-code": agencyCode } : {}',
      "var response = await miFetch(url, options)",
    ]))
    && !includesAll(adminSource, ['"x-demo-admin-code": adminCode'])
    && !includesAll(adminSource, ['"x-mi-rank-access-code": adminCode'])
    && !includesAll(adminSource, ["adminCode: adminCode"]),
  clientTrackingAuthConnected: includesAll(clientFetch, [
    'requestHeaders.delete(name)',
    'requestHeaders.set("x-mi-csrf", secureClientSession.csrfToken)',
  ])
    && [clientProductRequest, clientPlaceRequest].every((block) => includesAll(block, [
      'secureClientSession.role !== "client"',
      'headers: {}',
      'new URLSearchParams({ limit: "50" })',
      "var response = await miFetch(url, options)",
    ]))
    && !clientSource.includes('"x-mi-rank-access-code": accessCode'),
  clientRankAccessLifecycleConnected: includesAll(clientSource, [
    "var secureClientSession",
    'requestHeaders.set("x-mi-csrf", secureClientSession.csrfToken)',
    'localStorage.removeItem("miRankAccessCode"',
    'sessionStorage.removeItem("miRankAccessCode"',
  ])
    && !clientSource.includes('localStorage.setItem("miRankAccessCode"')
    && !clientSource.includes('sessionStorage.setItem("miRankAccessCode"')
    && !clientSource.includes("function rankAccessCode()"),
  productTrackerActionsAligned: hasActions(adminProductTracking, ["create", "check", "sync-due", "group", "delete", "reorder"])
    && hasActions(clientProductTracking, ["create", "check", "sync-due", "group", "delete", "reorder"]),
  placeTrackerActionsAligned: hasActions(adminPlaceTracking, ["create", "check", "sync-due", "group", "delete"])
    && hasActions(clientPlaceTracking, ["create", "check", "sync-due", "group", "delete"]),
  trackingAuthRefreshConnected: (adminSource.match(/mi:rank-auth-ready/g) || []).length >= 2
    && (clientSource.match(/mi:rank-auth-ready/g) || []).length >= 2,
  serverRoutesConnected: [
    ["naverKeyword", "/api/naver-keyword"],
    ["naverShoppingRank", "/api/naver-shopping-rank"],
    ["naverRankTrackers", "/api/naver-rank-trackers"],
    ["naverPlaceRankTrackers", "/api/naver-place-rank-trackers"],
  ].every(([handler, endpoint]) => serverIndex.includes(`${handler}: () => import(`)
    && serverIndex.includes(`url.pathname === "${endpoint}"`)
    && serverIndex.includes(`dispatch("${handler}", request)`)),
  rolePagesInitializeAllTools: adminSource.includes("initRankCheck(keywordInput);")
    && adminSource.includes("initRankTracking(keywordInput);")
    && adminSource.includes("initPlaceRankTracking(keywordInput);")
    && clientSource.includes("initRankCheck(keywordInput);")
    && clientSource.includes("initRankTracking(keywordInput);")
    && clientSource.includes("initPlaceRankTracking(keywordInput);"),
};

const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([label]) => label);
if (failed.length) {
  console.error(JSON.stringify({
    ok: false,
    failed,
    adminEndpoints,
    clientEndpoints,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checkedRoles: ["operation", "client"],
  checkedTools: ["keyword", "seo", "related-keywords", "product-rank", "product-rank-30-days", "place-rank-30-days"],
  endpoints: expectedEndpoints,
  checks,
}, null, 2));
