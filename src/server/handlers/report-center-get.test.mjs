import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fallbackSalesNarrative,
  handleGenerateSalesPptx,
  handleGet,
  normalizeSalesReportInput,
  reportDocKind,
} from "./report-center.mjs";

// Keep the listing/PPTX paths hermetic: no super-admin owner branch, no OpenAI network call.
delete process.env.MI_SUPER_ADMIN_CODE;
delete process.env.OPENAI_API_KEY;

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const AGENCY_CODE = "testcorp-a01";

const CLIENT_ROW = {
  id: CLIENT_ID,
  name: "테스트 광고주",
  business_name: "테스트 주식회사",
  agency_code: AGENCY_CODE,
  status: "active",
  issued_by_team_code: null,
  disconnected_at: null,
};

const REPORT_ROWS = [
  {
    id: "22222222-2222-4222-8222-222222222221",
    client_id: CLIENT_ID,
    brand_id: null,
    report_type: "sales",
    title: "2026년 8월 매출 보고서",
    report_date: "2026-08-15",
    period_start: "2026-08-01",
    period_end: "2026-08-31",
    channel_id: null,
    summary: "8월 성과 요약",
    public_comment: "이번 달 성과와 다음 실행 방향",
    visibility: "client_visible",
    created_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    client_id: CLIENT_ID,
    brand_id: null,
    report_type: "monthly",
    title: "2026년 8월 월간 보고서",
    report_date: "2026-08-10",
    period_start: "2026-08-01",
    period_end: "2026-08-10",
    channel_id: null,
    summary: "월간 요약",
    public_comment: "월간 공개 코멘트",
    visibility: "client_visible",
    created_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:00.000Z",
  },
];

const STORED_FILE_ID = "33333333-3333-4333-8333-333333333331";
const LINK_FILE_ID = "33333333-3333-4333-8333-333333333332";

const FILE_ROWS = [
  {
    id: STORED_FILE_ID,
    client_id: CLIENT_ID,
    report_id: REPORT_ROWS[0].id,
    title: "8월 매출 보고서.pptx",
    file_type: "pptx",
    url: null,
    external_url: null,
    storage_bucket: "moment-reports",
    storage_path: `clients/${CLIENT_ID}/reports/2026-08/x.pptx`,
    visibility: "client_visible",
    created_at: "2026-08-16T00:00:00.000Z",
  },
  {
    id: LINK_FILE_ID,
    client_id: CLIENT_ID,
    report_id: REPORT_ROWS[1].id,
    title: "구글 드라이브 링크",
    file_type: "drive",
    url: null,
    external_url: "https://drive.google.com/file/d/abc/view",
    storage_bucket: null,
    storage_path: null,
    visibility: "client_visible",
    created_at: "2026-08-11T00:00:00.000Z",
  },
];

const SIGNED_URL = "https://signed.example/x";

// Chainable Supabase query stub: every filter returns itself, and the builder is
// awaitable directly (thenable) or via maybeSingle()/single() — matching how the
// real PostgrestFilterBuilder resolves.
function makeQuery(result) {
  const query = {
    select() { return query; },
    eq() { return query; },
    neq() { return query; },
    is() { return query; },
    gte() { return query; },
    lte() { return query; },
    order() { return query; },
    limit() { return query; },
    maybeSingle() { return Promise.resolve(result); },
    single() { return Promise.resolve(result); },
    then(onFulfilled, onRejected) { return Promise.resolve(result).then(onFulfilled, onRejected); },
  };
  return query;
}

function listingCtx({ clients = CLIENT_ROW, reports = REPORT_ROWS, files = FILE_ROWS } = {}) {
  const signedPaths = [];
  const ctx = {
    supabaseAdmin: {
      from(table) {
        if (table === "clients") return makeQuery({ data: clients, error: null });
        if (table === "reports") return makeQuery({ data: reports, error: null });
        if (table === "files") return makeQuery({ data: files, error: null });
        throw new Error(`unexpected table lookup: ${table}`);
      },
      storage: {
        from(bucket) {
          assert.equal(bucket, "moment-reports");
          return {
            createSignedUrl(path) {
              signedPaths.push(path);
              return Promise.resolve({ data: { signedUrl: SIGNED_URL }, error: null });
            },
          };
        },
      },
    },
  };
  return { ctx, signedPaths };
}

function clientRequest(query = "") {
  return new Request(`https://insight.momentlabs.co.kr/api/report-center${query}`, {
    method: "GET",
    headers: { "x-mi-agency-code": AGENCY_CODE },
  });
}

test("GET listing succeeds without pptxgenjs and returns reports + files with signed URLs", async () => {
  const { ctx, signedPaths } = listingCtx();
  const response = await handleGet(clientRequest(), ctx);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.access.role, "client");
  assert.ok(Array.isArray(body.reports), "reports must be an array");
  assert.ok(Array.isArray(body.files), "files must be an array");
  assert.equal(body.reports.length, REPORT_ROWS.length);
  assert.equal(body.files.length, FILE_ROWS.length);

  const storedFile = body.files.find((file) => file.id === STORED_FILE_ID);
  assert.ok(storedFile, "stored file must be present");
  assert.equal(storedFile.signed_url, SIGNED_URL);
  assert.equal(storedFile.signed_url_expires_in, 60 * 10);

  const linkFile = body.files.find((file) => file.id === LINK_FILE_ID);
  assert.ok(linkFile, "link-only file must be present");
  assert.equal(linkFile.signed_url, undefined);

  assert.deepEqual(signedPaths, [FILE_ROWS[0].storage_path]);
});

test("GET applies report_type/from/to/limit filters without throwing", async () => {
  const { ctx } = listingCtx();
  const filtered = await handleGet(
    clientRequest("?report_type=sales&from=2026-08-01&to=2026-08-31&limit=40"),
    ctx,
  );
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.json()).ok, true);
});

test("GET tolerates malformed filter inputs and still returns 200", async () => {
  const { ctx } = listingCtx();
  const odd = await handleGet(clientRequest("?limit=abc&report_type=%"), ctx);
  assert.equal(odd.status, 200);
  assert.equal((await odd.json()).ok, true);
});

test("PPTX generation still works via the lazy pptxgenjs import", async () => {
  // saveToReportCenter:false means the handler must never touch Supabase/Storage.
  const ctx = {
    supabaseAdmin: {
      from() { throw new Error("PPTX generation with saveToReportCenter:false must not touch the database"); },
      storage: {
        from() { throw new Error("PPTX generation with saveToReportCenter:false must not touch Storage"); },
      },
    },
  };
  const access = {
    role: "team",
    client: { id: CLIENT_ID, name: "테스트" },
    team: null,
  };
  const body = {
    action: "generate-sales-pptx",
    saveToReportCenter: false,
    clientName: "테스트",
    reportMonth: "2026-08",
  };
  const request = new Request("https://insight.momentlabs.co.kr/api/report-center", { method: "POST" });

  const response = await handleGenerateSalesPptx(request, ctx, access, body);
  assert.equal(response.status, 201);

  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.mimeType, PPTX_MIME);
  assert.equal(payload.stored, null);
  assert.equal(typeof payload.contentBase64, "string");
  assert.ok(payload.contentBase64.length > 0, "contentBase64 must be non-empty");

  const decoded = Buffer.from(payload.contentBase64, "base64");
  assert.ok(decoded.length > 0, "decoded PPTX buffer must be non-empty");
  // Real .pptx files are ZIP archives — verify the local-file-header signature.
  assert.deepEqual([...decoded.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});

// --- 문서 종류(매출 / 월간 요약) 선택 -------------------------------------

const HANDLER_SOURCE = readFileSync(
  fileURLToPath(new URL("./report-center.mjs", import.meta.url)),
  "utf8",
);

const SALES_ACCESS = {
  role: "team",
  client: { id: CLIENT_ID, name: "테스트 광고주" },
  team: null,
};

const TREND_DATA = [
  { month: "2026-06", sales: "1,200만원", roas: "480%" },
  { month: "2026-07", sales: "1,350만원", roas: "510%" },
  { month: "2026-08", sales: "1,510만원", roas: "545%" },
  { month: "2026-09", sales: "1,600만원", roas: "560%" },
];

function pptxBody(extra = {}) {
  return {
    action: "generate-sales-pptx",
    saveToReportCenter: false,
    clientName: "테스트",
    reportMonth: "2026-08",
    ...extra,
  };
}

function noDbCtx() {
  return {
    supabaseAdmin: {
      from() { throw new Error("saveToReportCenter:false must not touch the database"); },
      storage: {
        from() { throw new Error("saveToReportCenter:false must not touch Storage"); },
      },
    },
  };
}

function pptxRequest() {
  return new Request("https://insight.momentlabs.co.kr/api/report-center", { method: "POST" });
}

test("reportDocKind resolves known kinds and defaults to sales", () => {
  assert.equal(reportDocKind("sales").reportType, "sales");
  assert.equal(reportDocKind("sales").windowMonths, 1);
  assert.equal(reportDocKind("monthly").reportType, "monthly");
  assert.equal(reportDocKind("monthly").label, "월간 요약 보고서");
  assert.equal(reportDocKind("monthly").filenameSlug, "monthly");
  assert.equal(reportDocKind("monthly").windowMonths, 3);
  assert.notEqual(reportDocKind("monthly").systemPrompt, reportDocKind("sales").systemPrompt);
  assert.notEqual(reportDocKind("monthly").deckTitle, reportDocKind("sales").deckTitle);

  // 알 수 없는 값/빈 값은 매출 보고서로 되돌린다.
  for (const value of ["kpi", "", null, undefined, 42, {}]) {
    assert.equal(reportDocKind(value).reportType, "sales", `${String(value)} must fall back to sales`);
  }
});

test("normalizeSalesReportInput carries the doc kind and slices the trend window", () => {
  const monthly = normalizeSalesReportInput(SALES_ACCESS, {
    reportKind: "monthly",
    reportData: { clientName: "테스트", reportMonth: "2026-08", monthlyTrend: TREND_DATA },
  });
  assert.equal(monthly.docKind, "monthly");
  assert.equal(monthly.docLabel, "월간 요약 보고서");
  assert.equal(monthly.periodWindow, "최근 3개월");
  assert.equal(monthly.trend.length, 3);
  assert.deepEqual(monthly.trend[0], { month: "2026-06", sales: "1,200만원", roas: "480%" });

  // 기본(매출) 종류는 1개월 창만 남긴다.
  const sales = normalizeSalesReportInput(SALES_ACCESS, {
    reportData: { clientName: "테스트", reportMonth: "2026-08", monthlyTrend: TREND_DATA },
  });
  assert.equal(sales.docKind, "sales");
  assert.equal(sales.docLabel, "매출 보고서");
  assert.equal(sales.periodWindow, "최근 1개월");
  assert.equal(sales.trend.length, 1);

  // months / trend 별칭도 동일하게 인식한다.
  assert.equal(
    normalizeSalesReportInput(SALES_ACCESS, { reportKind: "monthly", reportData: { months: TREND_DATA } }).trend.length,
    3,
  );
  assert.equal(
    normalizeSalesReportInput(SALES_ACCESS, { report_kind: "monthly", reportData: { trend: TREND_DATA } }).trend.length,
    3,
  );

  // 배열이 아닌 흐름 데이터는 빈 배열로 정리한다.
  for (const bad of [{ monthlyTrend: "2026-06" }, { monthlyTrend: null }, {}]) {
    const input = normalizeSalesReportInput(SALES_ACCESS, { reportKind: "monthly", reportData: bad });
    assert.deepEqual(input.trend, []);
  }
});

test("fallbackSalesNarrative headline carries the doc label", () => {
  const monthly = normalizeSalesReportInput(SALES_ACCESS, {
    documentKind: "monthly",
    reportData: { clientName: "테스트", reportMonth: "2026-08" },
  });
  const narrative = fallbackSalesNarrative(monthly, "openai_not_configured");
  assert.equal(narrative.headline, "테스트 2026-08 월간 요약 보고서");
  assert.equal(narrative.source, "openai_not_configured");

  const sales = normalizeSalesReportInput(SALES_ACCESS, {
    reportData: { clientName: "테스트", reportMonth: "2026-08" },
  });
  assert.equal(fallbackSalesNarrative(sales).headline, "테스트 2026-08 매출 보고서");
});

test("generate-sales-pptx builds both doc kinds on the fallback narrative path", async () => {
  assert.equal(process.env.OPENAI_API_KEY, undefined, "OpenAI must stay unconfigured for the fallback path");

  const salesResponse = await handleGenerateSalesPptx(pptxRequest(), noDbCtx(), SALES_ACCESS, pptxBody());
  assert.equal(salesResponse.status, 201);
  const sales = await salesResponse.json();
  assert.equal(sales.reportKind, "sales");
  assert.equal(sales.ai.kind, "sales");
  assert.equal(sales.ai.source, "openai_not_configured");
  assert.equal(sales.filename, "moment-insight-sales-테스트-2026-08.pptx");

  const monthlyResponse = await handleGenerateSalesPptx(
    pptxRequest(),
    noDbCtx(),
    SALES_ACCESS,
    pptxBody({ reportKind: "monthly", reportData: { clientName: "테스트", reportMonth: "2026-08", monthlyTrend: TREND_DATA } }),
  );
  assert.equal(monthlyResponse.status, 201);
  const monthly = await monthlyResponse.json();
  assert.equal(monthly.reportKind, "monthly");
  assert.equal(monthly.ai.kind, "monthly");
  assert.equal(monthly.ai.source, "openai_not_configured");
  assert.equal(monthly.filename, "moment-insight-monthly-테스트-2026-08.pptx");
  assert.notEqual(monthly.filename, sales.filename, "filename slug must differ per doc kind");
  assert.match(monthly.ai.headline, /월간 요약 보고서$/);

  // 두 종류 모두 실제 PPTX(ZIP) 바이트를 만들어야 한다.
  for (const payload of [sales, monthly]) {
    const decoded = Buffer.from(payload.contentBase64, "base64");
    assert.deepEqual([...decoded.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  }
});

test("generate-sales-pptx keeps the client-role 403 guard ahead of any doc kind", async () => {
  const access = { role: "client", client: { id: CLIENT_ID, name: "테스트" }, team: null };
  for (const kind of ["monthly", "sales", undefined]) {
    const response = await handleGenerateSalesPptx(
      pptxRequest(),
      noDbCtx(),
      access,
      pptxBody({ reportKind: kind }),
    );
    assert.equal(response.status, 403, `role client must be refused for kind ${String(kind)}`);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.reportKind, undefined, "403 must not leak generation fields");
  }
});

test("pptxgenjs is never imported at report-center.mjs module top level", () => {
  // 과거 프로덕션 장애: 무거운 ESM 의존성을 최상위에서 import하면 모듈 로드가 깨진다.
  const occurrences = HANDLER_SOURCE.match(/pptxgenjs/g) || [];
  assert.equal(occurrences.length, 1, "pptxgenjs must appear exactly once, at its use site");
  assert.match(HANDLER_SOURCE, /await import\(\s*["']pptxgenjs["']\s*\)/);
  assert.doesNotMatch(
    HANDLER_SOURCE,
    /^\s*import\b[^;]*["']pptxgenjs["']/m,
    "no top-level import of pptxgenjs is allowed",
  );
});
