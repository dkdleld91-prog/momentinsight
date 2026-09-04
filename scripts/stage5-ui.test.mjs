import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

// UI 고도화 5단계: 광고주 대시보드의 "목표 달성률" 타일이 서버가 계산한 KPI 진척을 그대로 보여주고,
// 값이 없을 때는 기존 빈 상태 문구를 그대로 지킨다는 계약을 원본 HTML에서 확인한다.
const clientSource = fs.readFileSync(new URL("../src/pages/client.html", import.meta.url), "utf8");

// 시장 홈의 기사 카드는 출처를 색으로 구분한다. 네이버·쿠팡 두 브랜드색만 예외로 허용하고,
// 그 밖의 새 색은 여전히 막는다. 상승·하락·정보 색은 페이지에 이미 있는 값을 재사용해야 한다.
const MARKET_HOME_BRAND_COLORS = new Set(["#03c75a", "#4a9ed2"]);

function clientBlock(start, end) {
  const from = clientSource.indexOf(start);
  const to = clientSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `client.html block not found: ${start}`);
  return clientSource.slice(from, to);
}

const summaryRowMarkup = clientBlock('<div class="mi-summary-row" aria-label="핵심 대시보드">', "</div>\n              <div class=\"mi-action-strip\"");
const kpiRenderSource = clientBlock("function renderPublicKpiLine(state) {", "function applyState(state) {");

test("목표 달성률 타일이 KPI 보조줄 자리를 갖는다", () => {
  // 보조줄은 목표 달성률 박스 안에만 있고, 처음에는 hidden 이라 아무 수치도 보이지 않는다.
  assert.ok(summaryRowMarkup.includes("data-mi-public-kpi"));
  assert.ok(
    summaryRowMarkup.includes(
      '<span>목표 달성률</span><strong class="is-empty" data-mi-public="achievement">아직 등록된 수치가 없습니다 — 운영팀이 입력하면 표시됩니다</strong><small data-mi-public-kpi hidden></small>',
    ),
  );
  // 다른 타일에는 보조줄이 붙지 않는다.
  assert.equal((clientSource.match(/data-mi-public-kpi/g) || []).length, 3);
});

test("achievement 타일의 빈 상태 문구가 그대로 남아 있다", () => {
  assert.ok(clientSource.includes("아직 등록된 수치가 없습니다"));
  assert.ok(summaryRowMarkup.includes('data-mi-public="achievement">아직 등록된 수치가 없습니다 — 운영팀이 입력하면 표시됩니다'));
  assert.ok(clientSource.includes('var EMPTY_METRIC_TEXT = "아직 등록된 수치가 없습니다 — 운영팀이 입력하면 표시됩니다";'));
});

test("기본 상태 객체 두 곳이 kpi 자리를 null 로 비워 둔다", () => {
  // 캐시된 첫 페인트에서도 state.kpi 접근이 터지지 않도록 defaultState · blankPublicState 모두 채운다.
  assert.equal((clientSource.match(/^\s*kpi: null,$/gmu) || []).length, 2);
  assert.ok(clientSource.includes("        achievement: \"\",\n        // 서버가 계산한 KPI 목표/실적 묶음. 없으면 null 이며 어떤 수치도 지어내지 않는다.\n        kpi: null,"));
  assert.ok(clientSource.includes("          achievement: \"\",\n          // 캐시 첫 페인트에서도 안전하도록 KPI 자리는 null 로 비워 둔다.\n          kpi: null,"));
});

test("KPI 보조줄은 state.kpi 를 가드한 뒤에만 그린다", () => {
  assert.ok(kpiRenderSource.includes('var kpi = state && state.kpi && typeof state.kpi === "object" ? state.kpi : null;'));
  assert.ok(kpiRenderSource.includes("var target = kpi ? publicKpiNumber(kpi.targetValue) : null;"));
  assert.ok(kpiRenderSource.includes("if (!kpi || target === null) {"));
  // 목표가 없으면 줄을 통째로 감춘다.
  assert.ok(kpiRenderSource.includes('node.textContent = "";\n          node.hidden = true;'));
  // 실적이 없으면 0 이 아니라 "집계 전"이라고 쓴다.
  assert.ok(kpiRenderSource.includes('var actualText = actual === null || progress === null ? "집계 전" : formatNumber(actual);'));
  assert.ok(kpiRenderSource.includes('"목표 " + formatNumber(target) + " · 실적 " + actualText'));
  // applyState 가 실제로 호출한다.
  assert.ok(clientSource.includes("        renderPublicKpiLine(state);"));
});

test("서버 응답의 kpi 만 상태에 담고 지어내지 않는다", () => {
  assert.ok(
    clientSource.includes('next.kpi = publicState.kpi && typeof publicState.kpi === "object" ? publicState.kpi : null;'),
  );
  // 기존 지표 키 목록은 그대로 둔다.
  assert.ok(
    clientSource.includes(
      'var PUBLIC_METRIC_KEYS = ["sales", "roas", "adSpend", "orders", "achievement", "status", "nextSchedule", "updatedAt", "comment"];',
    ),
  );
});

test("client.html 에 새 색상 리터럴이 늘지 않았다", () => {
  const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/gu;
  const headSource = execFileSync("git", ["show", "HEAD:src/pages/client.html"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const literals = (text) => new Set((text.match(HEX) || []).map((value) => value.toLowerCase()));
  const current = literals(clientSource);
  const head = literals(headSource);
  const added = [...current].filter((value) => !head.has(value) && !MARKET_HOME_BRAND_COLORS.has(value));
  assert.deepEqual(added, [], `새 색상 리터럴이 추가됨: ${added.join(", ")}`);
});

// UI 고도화 5단계 (운영 화면): 운영 이력 · KPI 목표 편집기 · 보고서 유형 선택.
// 세 표면 모두 기존 mi-* 클래스와 기존 helper(miFetch · readApiPayload · setStatus)만 쓰고,
// 새 /api 경로나 새 색상 토큰을 만들지 않았다는 계약을 원본 HTML에서 확인한다.
const adminSource = fs.readFileSync(new URL("../src/pages/admin.html", import.meta.url), "utf8");

function adminBlock(start, end) {
  const from = adminSource.indexOf(start);
  const to = adminSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `admin.html block not found: ${start}`);
  return adminSource.slice(from, to);
}

const agencyCodeViewMarkup = adminBlock(
  '<section class="mi-view" data-mi-admin-view="agency-code" id="mi-admin-agency-code">',
  '<section class="mi-view mi-operation-input" data-mi-admin-view="excel"',
);
const publishViewMarkup = adminBlock(
  '<section class="mi-view" data-mi-admin-view="publish" id="mi-admin-publish">',
  "</section>\n      </div>\n    </main>",
);
const reportsViewMarkup = adminBlock(
  '<section class="mi-view" data-mi-admin-view="reports" id="mi-admin-reports">',
  '<section class="mi-view" data-mi-admin-view="keyword"',
);
// 운영 이력 조회 helper 는 계정 요청 묶음(refreshOperationTeamPanel ~ reportTypeLabel) 밖에 둔다.
// 그 묶음은 출시 기준선이 낡은 세션 가드 호출 수를 정확히 세는 구역이라, 새 함수가 들어가면
// 보안 불변식 검사가 깨진다. 그래서 운영 이력 JS 묶음 바로 앞에 자리한다.
const auditRequestSource = adminBlock(
  "async function requestOwnerAuditLogs(query) {",
  "function operationHistoryTimeLabel(value) {",
);
const operationHistorySource = adminBlock(
  "function operationHistoryTimeLabel(value) {",
  'var opsHistoryRefreshButton = root.querySelector("[data-ops-history-refresh]");',
);
const kpiEditorSource = adminBlock(
  "function adminKpiMetricLabel(metric) {",
  'var adminKpiSaveButton = root.querySelector("[data-admin-kpi-save]");',
);
const salesPptxSource = adminBlock(
  "async function generateSalesPptxReport(state, type, requestSession, kind) {",
  'root.querySelectorAll("[data-admin-download]")',
);

test("운영 이력 구역은 대행사 연결 화면 안의 총관리자 전용 구역이다", () => {
  assert.ok(adminSource.includes('data-mi-admin-section="operation-history"'));
  // 별도 화면(mi-view)이 아니라 대행사 연결 화면 안의 한 구역이다.
  assert.ok(agencyCodeViewMarkup.includes('data-mi-admin-section="operation-history"'));
  assert.ok(!adminSource.includes('data-mi-admin-view="operation-history"'));
  // 활성 계정 전체보기 바로 뒤에 온다.
  assert.ok(
    agencyCodeViewMarkup.indexOf('data-mi-admin-section="active-accounts"') <
      agencyCodeViewMarkup.indexOf('data-mi-admin-section="operation-history"'),
  );
  // 총관리자 세션에서만 보이도록 기존 data-owner-only 토글을 그대로 쓴다.
  const sectionTag = agencyCodeViewMarkup.slice(
    agencyCodeViewMarkup.indexOf('<section class="mi-owner-account-full" data-mi-admin-section="operation-history"'),
  ).split(">")[0];
  assert.ok(sectionTag.includes("data-owner-only"), `운영 이력 구역에 data-owner-only 가 없음: ${sectionTag}`);
  assert.ok(sectionTag.includes('class="mi-owner-account-full"'));
});

test("운영 이력 조작부는 읽기 전용 마커만 갖고 총관리자 API 의 audit-logs 뷰를 부른다", () => {
  for (const marker of [
    "data-ops-history-list",
    "data-ops-history-filter",
    "data-ops-history-refresh",
    "data-ops-history-status",
    "data-ops-history-more",
  ]) {
    assert.ok(agencyCodeViewMarkup.includes(marker), `운영 이력 마커 누락: ${marker}`);
  }
  assert.ok(agencyCodeViewMarkup.includes('<option value="">전체 작업</option>'));
  // 읽기 전용: 삭제·수정 조작을 하나도 두지 않는다.
  assert.ok(!/data-ops-history-(delete|edit|remove)/u.test(adminSource));
  // 조회는 기존 총관리자 API 를 그대로 쓴다(새 /api 경로 없음).
  assert.ok(auditRequestSource.includes('if (secureSession.role !== "owner")'));
  assert.ok(auditRequestSource.includes("captureAdminSession()"));
  assert.ok(auditRequestSource.includes("staleAdminSessionPayload()"));
  assert.ok(auditRequestSource.includes('miFetch(getSuperAdminApiUrl() + "?" + params.toString()'));
  assert.ok(auditRequestSource.includes("new URLSearchParams(query || {})"));
  assert.ok(operationHistorySource.includes('var query = { view: "audit-logs", limit: "50" };'));
  assert.ok(operationHistorySource.includes('"audit-logs"'));
  // 기존 2-인자 requestOwnerCodes 호출부는 그대로 살아 있다.
  assert.ok(adminSource.includes('await requestOwnerCodes("GET")'));
  assert.ok(adminSource.includes("async function requestOwnerCodes(method, body) {"));
});

test("운영 이력 줄은 actionLabel 이 없으면 서버가 준 원본 action 을 그대로 쓴다", () => {
  assert.ok(operationHistorySource.includes("entry.actionLabel || entry.action"));
  // 이름을 지어내지 않도록 textContent 로만 그린다.
  assert.ok(operationHistorySource.includes("title.textContent = entry.actionLabel || entry.action"));
  assert.ok(operationHistorySource.includes("when.textContent = operationHistoryTimeLabel(entry.createdAt);"));
  assert.ok(operationHistorySource.includes('timeZone: "Asia/Seoul"'));
  // metadata 는 최대 3쌍 · 값 40자로 줄인다.
  assert.ok(operationHistorySource.includes("if (parts.length >= 3) return;"));
  assert.ok(operationHistorySource.includes('if (text.length > 40) text = text.slice(0, 40) + "…";'));
  // 빈 상태 문구.
  assert.ok(operationHistorySource.includes('emptyValue.textContent = "기록된 운영 이력이 없습니다.";'));
  assert.ok(operationHistorySource.includes('empty.className = "mi-row is-empty";'));
  // 서버가 ok:false 로 답하면 서버 메시지를 그대로 상태줄에 쓴다.
  assert.ok(operationHistorySource.includes('setStatus(statusNode, payload.message || "운영 이력을 불러오지 못했습니다.", "is-warn");'));
  // 상시 조회가 아니라 화면을 열었을 때만 늦게 부른다.
  assert.ok(adminSource.includes('if (target === "agency-code" && secureSession.role === "owner") maybeLoadOperationHistory();'));
});

test("KPI 목표 편집기는 공개 관리 화면 안에서 기존 공개 저장 경로만 쓴다", () => {
  for (const marker of [
    "data-admin-kpi-metric",
    "data-admin-kpi-period",
    "data-admin-kpi-target",
    "data-admin-kpi-save",
    "data-admin-kpi-status",
    "data-admin-kpi-progress",
  ]) {
    assert.ok(publishViewMarkup.includes(marker), `KPI 마커 누락: ${marker}`);
  }
  for (const metric of ["revenue", "ad_spend", "orders"]) {
    assert.ok(publishViewMarkup.includes(`<option value="${metric}">`), `KPI 지표 옵션 누락: ${metric}`);
  }
  // 공개 데이터 설정 카드 뒤, 내부 메모 mi-split 앞에 온다.
  assert.ok(publishViewMarkup.indexOf("data-admin-code-save") < publishViewMarkup.indexOf("data-admin-kpi-save"));
  assert.ok(publishViewMarkup.indexOf("data-admin-kpi-save") < publishViewMarkup.indexOf('<div class="mi-split">'));
  // 저장은 기존 /api/client/public-state 한 곳으로만 간다.
  assert.ok(kpiEditorSource.includes('action: "save-kpi-target"'));
  assert.ok(kpiEditorSource.includes("miFetch(getClientPublicStateApiUrl(), {"));
  assert.ok(kpiEditorSource.includes("kpiTarget: {"));
  assert.ok(kpiEditorSource.includes("periodMonth:"));
  assert.ok(kpiEditorSource.includes("metric:"));
  assert.ok(kpiEditorSource.includes("targetValue:"));
  // 총관리자 헤더 규칙은 persistPublicState 와 같다.
  assert.ok(kpiEditorSource.includes('headers["x-mi-agency-code"] = targetAgencyCode;'));
  assert.ok(kpiEditorSource.includes("총관리자는 대상 광고주 코드를 먼저 확인해주세요."));
  assert.ok(adminSource.includes('headers["x-mi-agency-code"] = targetAgencyCode;'));
  // 낡은 세션 가드.
  assert.ok(kpiEditorSource.includes("adminSessionIsCurrent(session.generation, session.role, session.scopeKey)"));
});

test("KPI 진행 줄은 서버 값만 그리고 없는 숫자를 만들지 않는다", () => {
  assert.ok(kpiEditorSource.includes('node.textContent = "등록된 KPI 목표가 없습니다.";'));
  assert.ok(publishViewMarkup.includes("등록된 KPI 목표가 없습니다."));
  assert.ok(kpiEditorSource.includes('node.textContent = head + " · 실적 집계 전";'));
  assert.ok(kpiEditorSource.includes('node.textContent = head + " · 달성 " + (Math.round(rate * 10) / 10) + "%";'));
  assert.ok(kpiEditorSource.includes("var kpi = payload.publicState ? payload.publicState.kpi : null;"));
  // 목표 기간 기본값은 이번 달.
  assert.ok(kpiEditorSource.includes("periodInput.value = (kpi && kpi.periodMonth) || adminKpiCurrentPeriod();"));
  assert.ok(kpiEditorSource.includes('return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");'));
  // 공개 관리 화면을 열었을 때만 늦게 부른다.
  assert.ok(adminSource.includes('if (target === "publish" && secureSession.role) maybeLoadAdminKpiTarget();'));
});

test("AI PPTX 는 문서 종류 선택값을 reportKind 로 보내고 기존 호출부를 지킨다", () => {
  assert.ok(reportsViewMarkup.includes("data-admin-ai-report-kind"));
  assert.ok(reportsViewMarkup.includes('<option value="sales">매출 보고서</option>'));
  assert.ok(reportsViewMarkup.includes('<option value="monthly">월간 요약 보고서</option>'));
  // 선택 상자는 AI 버튼 옆(mi-downloads 안)에 있고, 버튼 자체는 그대로다.
  assert.ok(reportsViewMarkup.indexOf('class="mi-downloads"') < reportsViewMarkup.indexOf("data-admin-ai-report-kind"));
  assert.ok(reportsViewMarkup.indexOf("data-admin-ai-report-kind") < reportsViewMarkup.indexOf("data-admin-ai-pptx"));
  assert.ok(reportsViewMarkup.includes('<button class="mi-download" type="button" data-admin-ai-pptx>'));
  // POST 본문에 reportKind 가 붙는다.
  assert.ok(salesPptxSource.includes('reportKind: kind === "monthly" ? "monthly" : "sales",'));
  assert.ok(salesPptxSource.includes('action: "generate-sales-pptx",'));
  // 제목은 기존 reportTypeLabel 을 그대로 쓴다(새 라벨 사전을 만들지 않는다).
  assert.ok(salesPptxSource.includes('title: reportTypeLabel(type || "sales") + " · "'));
  assert.ok(adminSource.includes('monthly: "월간 보고서",'));
  // 기존 3-인자 호출부(data-admin-download)는 글자 그대로 남아 있다.
  assert.ok(adminSource.includes("var payload = await generateSalesPptxReport(state, type, requestSession);"));
  // AI 버튼은 선택값을 유형·문서 종류로 함께 넘긴다.
  assert.ok(adminSource.includes('var reportKind = kindSelect && kindSelect.value === "monthly" ? "monthly" : "sales";'));
  assert.ok(adminSource.includes("var payload = await generateSalesPptxReport(state, reportKind, requestSession, reportKind);"));
  // busy/idle 교체용 셀렉터 목록은 여전히 AI 버튼을 잡는다.
  assert.ok(adminSource.includes("[data-admin-download], [data-admin-ai-pptx], [data-owner-team-create]"));
  assert.ok(adminSource.includes('button.hasAttribute("data-admin-ai-pptx")) && typeof button._miIdleHtml === "string"'));
});

test("admin.html 에 새 색상 리터럴이 늘지 않았다", () => {
  const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/gu;
  const headSource = execFileSync("git", ["show", "HEAD:src/pages/admin.html"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const literals = (text) => new Set((text.match(HEX) || []).map((value) => value.toLowerCase()));
  const current = literals(adminSource);
  const head = literals(headSource);
  const added = [...current].filter((value) => !head.has(value) && !MARKET_HOME_BRAND_COLORS.has(value));
  assert.deepEqual(added, [], `새 색상 리터럴이 추가됨: ${added.join(", ")}`);
});

// ─────────────────────────────────────────────────────────────
// 계정별 키워드 등록 한도(총관리자 콘솔)
// ─────────────────────────────────────────────────────────────
const ownerFullAccountSource = adminBlock(
  "function renderOwnerFullAccountView(payload) {",
  "function renderOwnerCodeList(payload) {",
);
const ownerQuotaControlSource = adminBlock(
  "function ownerQuotaControl(code, limit) {",
  "function renderOwnerFullAccountView(payload) {",
);
const ownerQuotaActionSource = adminBlock(
  '"[data-owner-quota-save]"',
  "if (codeSaveButton) {",
);

test("활성 계정 전체보기의 두 목록 모두에 키워드 한도 입력칸이 붙는다", () => {
  assert.ok(ownerQuotaControlSource.includes("data-owner-quota-input"));
  assert.ok(ownerQuotaControlSource.includes("data-owner-quota-save"));
  // 값은 언제나 escapeHtml 을 거쳐 마크업으로 들어간다.
  assert.ok(ownerQuotaControlSource.includes('escapeHtml(target) + \'">한도 저장</button>'));
  assert.ok(ownerQuotaControlSource.includes('data-owner-quota-input="\' + escapeHtml(target)'));
  assert.ok(ownerQuotaControlSource.includes("escapeHtml(value)"));
  // 지정하지 않은 계정은 빈 칸에 "기본 50" 안내만 보인다.
  assert.ok(ownerQuotaControlSource.includes('placeholder="기본 50"'));
  // 서버 상수 MAX_RANK_KEYWORD_LIMIT 과 같은 숫자를 입력칸에도 건다.
  assert.ok(ownerQuotaControlSource.includes('max="1000"'));

  // 운영팀 슬롯: 광고주가 붙어 있으면 광고주 코드, 아니면 운영팀 코드가 한도 단위다.
  assert.ok(ownerFullAccountSource.includes("client ? (client.agencyCode || \"\") : (team.teamCode || \"\")"));
  assert.ok(ownerFullAccountSource.includes("client ? client.rankKeywordLimit : team.rankKeywordLimit"));
  // 직접 광고주 슬롯: 총관리자 자신의 보호 행에는 입력칸을 달지 않는다.
  assert.ok(ownerFullAccountSource.includes("(isOwnerClient ? '' : ownerQuotaControl(client.agencyCode || \"\", client.rankKeywordLimit))"));
  assert.equal((ownerFullAccountSource.match(/ownerQuotaControl\(/g) || []).length, 2);
});

test("한도 저장은 새 API 경로 없이 기존 총관리자 코드 요청을 그대로 쓴다", () => {
  assert.ok(ownerQuotaActionSource.includes('action: "set-rank-keyword-limit"'));
  assert.ok(ownerQuotaActionSource.includes('requestOwnerCodes("POST"'));
  assert.ok(ownerQuotaActionSource.includes("canManageOwnerCodes()"));
  assert.ok(ownerQuotaActionSource.includes("if (payload.staleSession) return;"));
  assert.ok(ownerQuotaActionSource.includes("loadOwnerCodes(true)"));
  // 새 /api 진입점을 만들지 않는다(Vercel 함수 12개 한도).
  assert.ok(!ownerQuotaActionSource.includes("miFetch("));
  // 빈 칸은 "기본값으로 되돌린다"는 뜻이라 null 로 보낸다.
  assert.ok(ownerQuotaActionSource.includes('rankKeywordLimit: raw === "" ? null : raw'));
});

test("한도 저장 핸들러는 세션 가드 호출 수를 세는 묶음 밖에 둔다", () => {
  // adminAccountActionSource(ownerCreateButton ~ codeSaveButton) 안에 들어가면
  // 출시 기준선의 정확한 개수 검사가 깨진다.
  assert.ok(
    adminSource.indexOf('"[data-owner-quota-save]"') >
      adminSource.indexOf('var codeSaveButton = root.querySelector("[data-admin-code-save]");'),
  );
});

test("키워드 한도 조작은 광고주 화면으로 새어 나가지 않는다", () => {
  assert.ok(!clientSource.includes("data-owner-quota-save"));
  assert.ok(!clientSource.includes("data-owner-quota-input"));
  assert.ok(!clientSource.includes("set-rank-keyword-limit"));
});
