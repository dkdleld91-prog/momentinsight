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
  "/api/naver-product-seo-audit",
  "/api/naver-rank-trackers",
  "/api/naver-shopping-rank",
].sort();

const adminScreens = matches(adminSource, /data-mi-admin-screen="([^"]+)"/g);
const clientScreens = matches(clientSource, /data-mi-screen="([^"]+)"/g);
const adminEndpoints = matches(adminSource, /\/api\/naver-(?:keyword|place-rank-trackers|product-seo-audit|rank-trackers|shopping-rank)/g);
const clientEndpoints = matches(clientSource, /\/api\/naver-(?:keyword|place-rank-trackers|product-seo-audit|rank-trackers|shopping-rank)/g);
const apiHelperNames = [
  "getKeywordApiUrl",
  "getShoppingRankApiUrl",
  "getRankTrackerApiUrl",
  "getPlaceRankTrackerApiUrl",
  "fetchSeoAudit",
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
const adminOwnerTarget = functionBlock(adminSource, "ownerTargetAgencyCode");
const adminCurrentPublicCode = functionBlock(adminSource, "currentPublicCode");
const adminOwnerCodeList = functionBlock(adminSource, "renderOwnerCodeList");
const adminProductLoad = functionBlock(adminSource, "loadRankTrackers");
const clientProductLoad = functionBlock(clientSource, "loadRankTrackers");
const adminPlaceLoad = functionBlock(adminSource, "loadPlaceTrackers");
const clientPlaceLoad = functionBlock(clientSource, "loadPlaceTrackers");
const adminProductSync = functionBlock(adminSource, "syncDueRankTrackersIfNeeded");
const clientProductSync = functionBlock(clientSource, "syncDueRankTrackersIfNeeded");
const adminPlaceSync = functionBlock(adminSource, "syncDuePlaceTrackersIfNeeded");
const clientPlaceSync = functionBlock(clientSource, "syncDuePlaceTrackersIfNeeded");
const adminPlaceSnapshotMetric = functionBlock(adminSource, "placeSnapshotMetric");
const clientPlaceSnapshotMetric = functionBlock(clientSource, "placeSnapshotMetric");
const adminPlaceDailyBoard = functionBlock(adminSource, "renderPlaceTrackerDailyBoard");
const clientPlaceDailyBoard = functionBlock(clientSource, "renderPlaceTrackerDailyBoard");
const adminCompleteTrackerPayload = functionBlock(adminSource, "completeRankTrackerPayload");
const clientCompleteTrackerPayload = functionBlock(clientSource, "completeRankTrackerPayload");
const adminScopedTrackerPayload = functionBlock(adminSource, "scopedRankTrackerPayload");
const clientScopedTrackerPayload = functionBlock(clientSource, "scopedRankTrackerPayload");
const adminApplyState = functionBlock(adminSource, "applyState");
const adminSessionRestore = functionBlock(adminSource, "restoreAdminLogin");
const clientSessionRestore = functionBlock(clientSource, "restoreClientLogin");
const clientReportSync = functionBlock(clientSource, "syncReportCenterReports");
const clientUnlock = functionBlock(clientSource, "unlockWithCode");
const adminSeoEvaluation = functionBlock(adminSource, "buildSeoEvaluation");
const clientSeoEvaluation = functionBlock(clientSource, "buildSeoEvaluation");
const adminSeoRender = functionBlock(adminSource, "renderSeoEvaluation");
const clientSeoRender = functionBlock(clientSource, "renderSeoEvaluation");
const adminOwnerToolLoad = functionBlock(adminSource, "loadOwnerTool");
const ownerToolFetchIndex = adminOwnerToolLoad.indexOf("var response = await miFetch");
const ownerToolDiscardIndex = adminOwnerToolLoad.indexOf("discardOwnerTool()");

const sharedPageMarkers = [
  "async function fetchKeywordData",
  "async function runKeywordLookup",
  "async function runSeoCheck",
  "async function fetchSeoAudit",
  "function makeRelatedKeywords",
  "function initRankCheck",
  "function initRankTracking",
  "function initPlaceRankTracking",
  "function dueRankTrackers",
  "async function syncDueRankTrackersIfNeeded",
  "function duePlaceTrackers",
  "async function syncDuePlaceTrackersIfNeeded",
  'action: "sync-due"',
  "await syncDueRankTrackersIfNeeded(silent, scope, generation)",
  "await syncDuePlaceTrackersIfNeeded(silent, scope, generation)",
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
    "[data-seo-keyword]",
    "[data-seo-url]",
    "[data-rank-check-card]",
    "[data-rank-card]",
    "[data-place-rank-card]",
    "[data-keyword-related]",
  ]) && includesAll(clientSource, [
    "[data-mi-keyword-search]",
    "[data-seo-run]",
    "[data-seo-keyword]",
    "[data-seo-url]",
    "[data-rank-check-card]",
    "[data-rank-card]",
    "[data-place-rank-card]",
    "[data-keyword-related]",
  ]),
  relatedKeywordViewsConnected: adminSource.includes('href="#mi-admin-related-keywords" data-mi-admin-screen="related-keywords"')
    && clientSource.includes('href="#mi-related-keywords" data-mi-screen="related-keywords"'),
  seoEvaluationRoleParity: normalizedBlock(adminSource, "buildSeoEvaluation")
    && normalizedBlock(adminSource, "buildSeoEvaluation") === normalizedBlock(clientSource, "buildSeoEvaluation")
    && normalizedBlock(adminSource, "renderSeoEvaluation") === normalizedBlock(clientSource, "renderSeoEvaluation")
    && includesAll(adminSeoEvaluation, ["window.MomentSeoEvaluation", "auditPayload", "auditProduct", "signals.review", "signals.discount", "signals.reviewPoint"])
    && includesAll(clientSeoEvaluation, ["window.MomentSeoEvaluation", "auditPayload", "auditProduct", "signals.review", "signals.discount", "signals.reviewPoint"])
    && !includesAll(adminSeoEvaluation, ["signals.detailPage"])
    && !includesAll(clientSeoEvaluation, ["signals.detailPage"])
    && !includesAll(adminSeoEvaluation, ["signals.productNotice"])
    && !includesAll(clientSeoEvaluation, ["signals.productNotice"])
    && !includesAll(adminSeoEvaluation, ["trafficCount"])
    && !includesAll(clientSeoEvaluation, ["trafficCount"])
    && !includesAll(adminSeoEvaluation, ["orderCount"])
    && !includesAll(clientSeoEvaluation, ["orderCount"])
    && includesAll(adminSeoRender, ["상품명 키워드", "상품명 길이", "동종 카테고리", "현재 순위", "순위 "])
    && includesAll(clientSeoRender, ["상품명 키워드", "상품명 길이", "동종 카테고리", "현재 순위", "순위 "])
    && !includesAll(adminSeoRender, ["API 참고"])
    && !includesAll(clientSeoRender, ["API 참고"])
    && !includesAll(adminSeoRender, ["자동 확인 불가"])
    && !includesAll(clientSeoRender, ["자동 확인 불가"]),
  seoManualTrafficInputsRemoved: [adminSource, clientSource].every((source) =>
    !source.includes("[data-seo-traffic-count]")
    && !source.includes("[data-seo-order-count]")
    && !source.includes("최근 30일 유입수")
    && !source.includes("최근 30일 구매수")
    && !source.includes("[data-seo-review-count]")
    && !source.includes("[data-seo-detail-page-state]")
    && !source.includes("[data-seo-notice-state]")
    && !source.includes("[data-seo-discount-state]")
    && !source.includes("[data-seo-review-point-state]")
    && !source.includes("판매자 확인")),
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
      "var requestScope = verifiedRankTrackerScope()",
      'headers: {}',
      'new URLSearchParams({ limit: "500" })',
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
  placeMetricRenderingAlignedAndNullSafe: normalizedBlock(adminSource, "placeSnapshotMetric")
    === normalizedBlock(clientSource, "placeSnapshotMetric")
    && normalizedBlock(adminSource, "renderPlaceTrackerDailyBoard")
      === normalizedBlock(clientSource, "renderPlaceTrackerDailyBoard")
    && [adminPlaceSnapshotMetric, clientPlaceSnapshotMetric].every((block) => includesAll(block, [
      'fallback === undefined || fallback === null || String(fallback).trim() === ""',
      "return null",
    ]))
    && [adminPlaceDailyBoard, clientPlaceDailyBoard].every((block) => includesAll(block, [
      'renderPlaceDayMetric("블로그"',
      'renderPlaceDayMetric("방문"',
      'renderPlaceDayMetric("월검색"',
      'renderPlaceDayMetric("업체"',
    ])),
  trackingAuthRefreshConnected: (adminSource.match(/mi:rank-auth-ready/g) || []).length >= 2
    && (clientSource.match(/mi:rank-auth-ready/g) || []).length >= 2,
  ownerRankDefaultScopeProtected: includesAll(adminSource, [
    "function isOwnerScopePlaceholder",
    'normalized === "owner-session"',
    'normalized === "session"',
    "normalized === normalizeStorageCode(secureSession && secureSession.scopeKey)",
  ])
    && includesAll(adminOwnerTarget, [
      "isOwnerScopePlaceholder(value)",
    ])
    && includesAll(adminCurrentPublicCode, [
      'secureSession.role === "owner"',
      "normalizeStorageCode(primaryAgencyCode)",
    ])
    && includesAll(adminOwnerCodeList, [
      "activeCodes",
      "isOwnerScopePlaceholder(currentCode)",
      "!activeCodes.has(currentCode)",
      "publicCodeInput.value = payload.ownerAgencyCode",
    ]),
  trackingLoadFailuresPreserveExistingCards: [adminProductLoad, clientProductLoad].every((block) => includesAll(block, [
    "if (!completeRankTrackerPayload(payload, scope))",
    "renderRankHistory(rankHistory, rankTrackers)",
    "return false",
  ])) && [adminPlaceLoad, clientPlaceLoad].every((block) => includesAll(block, [
    "if (!completeRankTrackerPayload(payload, scope))",
    "renderPlaceHistory(placeHistory, placeTrackers)",
    "return false",
  ])),
  trackerLastGoodCacheScopedAndExpiring: [adminSource, clientSource].every((source) => includesAll(source, [
    "var rankTrackerCacheTtlMs = 24 * 60 * 60 * 1000",
    "function verifiedRankTrackerScope",
    "function readRankTrackerLastGood",
    "function writeRankTrackerLastGood",
    "window.sessionStorage.getItem(rankTrackerCacheKey(feature, scope))",
    "Date.now() - savedAt > rankTrackerCacheTtlMs",
  ])),
  trackerLastGoodCacheIsCompactedAndQuotaAware: [adminSource, clientSource].every((source) => includesAll(source, [
    "function compactRankSnapshotForCache",
    "function compactRankTrackersForCache",
    "function pruneOtherRankTrackerCaches",
    "compactRankTrackersForCache(trackers, 62)",
    "compactRankTrackersForCache(trackers, 30)",
    "pruneOtherRankTrackerCaches(scope)",
    "return false",
  ])),
  completeTrackerListsOnlyReplaceCache: includesAll(adminScopedTrackerPayload, [
    "payload.ok !== true",
    "!Array.isArray(payload.trackers)",
    "Number.isSafeInteger(payload.returnedCount)",
    "payload.returnedCount !== payload.trackers.length",
    "trackerIds.has(trackerId)",
    "payload.scopeAgencyCode",
    "payload.scopeClientId",
  ]) && includesAll(clientScopedTrackerPayload, [
    "payload.ok !== true",
    "!Array.isArray(payload.trackers)",
    "Number.isSafeInteger(payload.returnedCount)",
    "payload.returnedCount !== payload.trackers.length",
    "trackerIds.has(trackerId)",
    "payload.scopeClientId",
  ]) && [adminCompleteTrackerPayload, clientCompleteTrackerPayload].every((block) => includesAll(block, [
    "scopedRankTrackerPayload(payload, scope)",
    "payload.complete === true",
    "payload.hasMore === false",
  ])) && [adminProductLoad, clientProductLoad, adminPlaceLoad, clientPlaceLoad].every((block) => includesAll(block, [
    "writeRankTrackerLastGood",
    "if (!completeRankTrackerPayload(payload, scope))",
  ])),
  incompleteTrackerListsNeverRenderAsEmpty: [adminProductLoad, clientProductLoad].every((block) => includesAll(block, [
    "!rankTrackers.length",
    "scopedRankTrackerPayload(payload, scope)",
    "payload.trackers.length",
    "검증된 일부 순위 목록을 우선 표시합니다.",
  ])) && [adminPlaceLoad, clientPlaceLoad].every((block) => includesAll(block, [
    "!placeTrackers.length",
    "scopedRankTrackerPayload(payload, scope)",
    "payload.trackers.length",
    "검증된 일부 플레이스 순위를 우선 표시합니다.",
  ])),
  trackerScopeGenerationRejectsLateResponses: [adminProductRequest, clientProductRequest].every((block) => includesAll(block, [
    "var requestGeneration = rankRequestGeneration",
    "requestGeneration !== rankRequestGeneration",
    "!sameRankTrackerScope(requestScope)",
  ])) && [adminPlaceRequest, clientPlaceRequest].every((block) => includesAll(block, [
    "var requestGeneration = placeRequestGeneration",
    "requestGeneration !== placeRequestGeneration",
    "!sameRankTrackerScope(requestScope)",
  ])) && [adminSource, clientSource].every((source) => source.includes('new CustomEvent("mi:rank-scope-changed")')),
  trackerRequestsBoundedAndComplete: [adminProductRequest, clientProductRequest].every((block) => includesAll(block, [
    'new URLSearchParams({ limit: "500" })',
    "? 120000 : 20000",
  ])) && [adminPlaceRequest, clientPlaceRequest].every((block) => includesAll(block, [
    'new URLSearchParams({ limit: "500" })',
    "? 270000 : 20000",
  ])) && [adminPlaceSync, clientPlaceSync].every((block) => block.includes('action: "sync-due", limit: "1"')),
  syncDueFailuresPreserveLastGood: [adminProductSync, clientProductSync].every((block) => includesAll(block, [
    "completeRankTrackerPayload(refreshed, scope)",
    "renderRankHistory(rankHistory, rankTrackers)",
    "writeRankTrackerLastGood",
  ]) && !block.includes("refreshed.trackers || []")) && [adminPlaceSync, clientPlaceSync].every((block) => includesAll(block, [
    "completeRankTrackerPayload(refreshed, scope)",
    "renderPlaceHistory(placeHistory, placeTrackers)",
    "writeRankTrackerLastGood",
  ]) && !block.includes("refreshed.trackers || []")),
  syncDueTokensCannotRemainStuck: [adminProductSync, clientProductSync].every((block) => includesAll(block, [
    "var syncToken = ++rankAutoSyncToken",
    "syncToken === rankAutoSyncToken",
  ])) && [adminPlaceSync, clientPlaceSync].every((block) => includesAll(block, [
    "var syncToken = ++placeAutoSyncToken",
    "syncToken === placeAutoSyncToken",
  ])),
  ownerProgrammaticScopeChangesRefreshTrackers: includesAll(adminOwnerCodeList, [
    "currentCode !== nextOwnerCode",
    'new CustomEvent("mi:rank-scope-changed")',
  ]) && includesAll(adminApplyState, [
    "previousCode !== nextCode",
    'new CustomEvent("mi:rank-scope-changed")',
  ]),
  placeDeleteRequiresConfirmedSuccess: [adminPlaceTracking, clientPlaceTracking].every((block) => includesAll(block, [
    "if (!payload || payload.ok !== true)",
    "기존 항목을 유지합니다.",
  ])),
  sessionRestorePreservesAuthOnOutage: includesAll(adminSource, [
    'payload.code === "SESSION_VALIDATION_UNAVAILABLE"',
    "payload.httpStatus = Number(response.status || 0)",
  ]) && includesAll(clientSource, [
    'payload.code === "SESSION_VALIDATION_UNAVAILABLE"',
    "payload.httpStatus = Number(response.status || 0)",
  ]) && [adminSessionRestore, clientSessionRestore].every((block) => includesAll(block, [
    "for (var attempt = 0; attempt < 2; attempt += 1)",
    "await waitForSessionRetry(350)",
    "sessionValidationUnavailable(payload)",
    "=== 401",
    "기존 인증은 유지",
  ])),
  reportCenterPreservesLastApprovedState: includesAll(clientReportSync, [
    "payload.ok !== true",
    "!Array.isArray(payload.files)",
    "!Array.isArray(payload.reports)",
    "state.approvedSessionScope = normalized",
    "state.approvedStateAt = new Date().toISOString()",
  ]) && includesAll(clientUnlock, [
    "readLastApprovedPublicState(sessionScope)",
    "preservedApprovedState = true",
    "새 빈 상태는 저장하지 않았습니다.",
  ]) && includesAll(clientSessionRestore, [
    "readLastApprovedPublicState(sessionScope)",
    "preservedApprovedState = true",
  ]),
  ownerToolSwapsOnlyAfterValidation: ownerToolFetchIndex >= 0
    && ownerToolDiscardIndex > ownerToolFetchIndex
    && includesAll(adminOwnerToolLoad, [
      "requestGeneration !== ownerToolGeneration",
      'menu.tagName !== "A"',
      'view.tagName !== "SECTION"',
      'view.querySelector("[data-owner-tool-input]")',
    ]),
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
