import assert from "node:assert/strict";
import test from "node:test";
import {
  handleCreateReport,
  handleDirectUpload,
  reportUploadMaxBytes,
  safeExternalReportUrl,
  validateUploadedFile,
} from "./report-center.mjs";

test("upload size configuration fails closed for invalid or excessive values", () => {
  assert.equal(reportUploadMaxBytes("NaN"), 8 * 1024 * 1024);
  assert.equal(reportUploadMaxBytes("0"), 8 * 1024 * 1024);
  assert.equal(reportUploadMaxBytes(String(100 * 1024 * 1024)), 8 * 1024 * 1024);
  assert.equal(reportUploadMaxBytes(String(4 * 1024 * 1024)), 4 * 1024 * 1024);
});

test("external report URLs accept only safe HTTPS destinations", () => {
  assert.equal(safeExternalReportUrl("javascript:alert(1)", "link"), "");
  assert.equal(safeExternalReportUrl("data:text/html,boom", "link"), "");
  assert.equal(safeExternalReportUrl("http://example.com/report", "link"), "");
  assert.equal(safeExternalReportUrl("https://127.0.0.1/report", "link"), "");
  assert.equal(safeExternalReportUrl("https://drive.google.com/file/d/abc", "drive"), "https://drive.google.com/file/d/abc");
  assert.equal(safeExternalReportUrl("https://evil.example/file", "drive"), "");
  assert.equal(safeExternalReportUrl("https://workspace.notion.site/report", "notion"), "https://workspace.notion.site/report");
});

test("upload validation rejects extension, MIME and magic-byte mismatches", () => {
  const pdf = Buffer.from("%PDF-1.7\n%test", "ascii");
  assert.equal(validateUploadedFile("report.pdf", "application/pdf", pdf).ok, true);
  assert.equal(validateUploadedFile("report.pdf", "image/png", pdf).ok, false);
  assert.equal(validateUploadedFile("report.pdf", "application/pdf", Buffer.from("MZ")).ok, false);
  assert.equal(validateUploadedFile("macro.xlsm", "application/octet-stream", Buffer.from("PK\u0003\u0004")).ok, false);
  assert.equal(validateUploadedFile("legacy.xls", "application/vnd.ms-excel", Buffer.from("D0CF")).ok, false);
  assert.equal(validateUploadedFile("payload.svg", "image/svg+xml", Buffer.from("<svg><script/></svg>")).ok, false);
});

test("image uploads must match their declared MIME and binary signature", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(validateUploadedFile("image.png", "image/png", png).ok, true);
  assert.equal(validateUploadedFile("image.jpg", "image/jpeg", png).ok, false);
});

test("CSV uploads reject NUL bytes and obvious executable formulas", () => {
  assert.equal(validateUploadedFile("data.csv", "text/csv", Buffer.from("name,value\nA,1\n")).ok, true);
  assert.equal(validateUploadedFile("data.csv", "text/csv", Buffer.from([0x61, 0x00, 0x62])).ok, false);
  assert.equal(validateUploadedFile("data.csv", "text/csv", Buffer.from("name,value\n=cmd|'/C calc'!A0,1\n")).ok, false);
});

test("direct upload rejects a cross-tenant report id before Storage or file writes", async () => {
  const tables = [];
  let storageTouched = false;
  const reportQuery = {
    select() { return reportQuery; },
    eq() { return reportQuery; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
  };
  const ctx = {
    supabaseAdmin: {
      from(table) {
        tables.push(table);
        assert.equal(table, "reports");
        return reportQuery;
      },
      storage: {
        from() {
          storageTouched = true;
          throw new Error("Storage must not be touched for a cross-tenant report id");
        },
      },
    },
  };
  const request = new Request("https://insight.momentlabs.co.kr/api/report-center", { method: "POST" });
  const response = await handleDirectUpload(request, ctx, {
    role: "team",
    client: { id: "00000000-0000-0000-0000-000000000001" },
  }, {
    filename: "report.pdf",
    contentType: "application/pdf",
    contentBase64: Buffer.from("%PDF-1.7\n%test", "ascii").toString("base64"),
    reportId: "00000000-0000-0000-0000-000000000002",
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).ok, false);
  assert.deepEqual(tables, ["reports"]);
  assert.equal(storageTouched, false);
});

test("direct upload removes the Storage object when the file row write fails", async () => {
  const uploads = [];
  const removals = [];
  const fileQuery = {
    insert() { return fileQuery; },
    select() { return fileQuery; },
    single() { return Promise.resolve({ data: null, error: { message: "files_insert_failed" } }); },
  };
  const storageBucket = {
    upload(path) {
      uploads.push(path);
      return Promise.resolve({ data: { path }, error: null });
    },
    remove(paths) {
      removals.push(paths);
      return Promise.resolve({ data: [], error: null });
    },
  };
  const ctx = {
    supabaseAdmin: {
      from(table) {
        assert.equal(table, "files");
        return fileQuery;
      },
      storage: {
        from(bucket) {
          assert.equal(bucket, "moment-reports");
          return storageBucket;
        },
      },
    },
  };
  const request = new Request("https://insight.momentlabs.co.kr/api/report-center", { method: "POST" });
  const response = await handleDirectUpload(request, ctx, {
    role: "team",
    client: { id: "00000000-0000-0000-0000-000000000001" },
  }, {
    filename: "report.pdf",
    contentType: "application/pdf",
    contentBase64: Buffer.from("%PDF-1.7\n%test", "ascii").toString("base64"),
  });

  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.detail, "files_insert_failed");
  assert.deepEqual(body.cleanup, { storageRemoved: true });
  assert.equal(uploads.length, 1);
  assert.deepEqual(removals, [[uploads[0]]]);
});

test("create report validates linked file metadata before creating a report row", async () => {
  let databaseTouched = false;
  const ctx = {
    supabaseAdmin: {
      from() {
        databaseTouched = true;
        throw new Error("invalid metadata must not reach the database");
      },
    },
  };
  const request = new Request("https://insight.momentlabs.co.kr/api/report-center", { method: "POST" });
  const response = await handleCreateReport(request, ctx, {
    role: "team",
    client: { id: "00000000-0000-0000-0000-000000000001" },
  }, {
    title: "월간 보고서",
    reportType: "monthly",
    file: {
      fileType: "drive",
      externalUrl: "https://evil.example/report",
    },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
  assert.equal(databaseTouched, false);
});

function existingReportMutationContext({ fileInsertError = null, reportUpdateError = null, fileCleanupError = null } = {}) {
  const prior = {
    id: "00000000-0000-0000-0000-000000000010",
    client_id: "00000000-0000-0000-0000-000000000001",
    brand_id: "00000000-0000-0000-0000-000000000020",
    report_type: "monthly",
    title: "월간 보고서",
    report_date: "2026-08-12",
    period_start: "2026-08-01",
    period_end: "2026-08-12",
    channel_id: "00000000-0000-0000-0000-000000000030",
    summary: "이전 요약",
    public_comment: "이전 공개 코멘트",
    internal_note: "이전 내부 메모",
    visibility: "internal",
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
  };
  const linkedFile = {
    id: "00000000-0000-0000-0000-000000000040",
    client_id: prior.client_id,
    report_id: prior.id,
    title: "월간 보고서",
    file_type: "drive",
    external_url: "https://drive.google.com/file/d/report",
    visibility: "internal",
  };
  let reportUpdates = 0;
  let fileDeletes = 0;
  let reportRead = false;
  const ctx = {
    supabaseAdmin: {
      from(table) {
        if (table === "reports") {
          if (!reportRead) {
            reportRead = true;
            const query = {
              select() { return query; },
              eq() { return query; },
              maybeSingle() { return Promise.resolve({ data: prior, error: null }); },
            };
            return query;
          }
          return {
            update(payload) {
              reportUpdates += 1;
              const query = {
                eq() { return query; },
                select() { return query; },
                single() {
                  return Promise.resolve(reportUpdateError
                    ? { data: null, error: { message: reportUpdateError } }
                    : { data: { ...prior, ...payload }, error: null });
                },
              };
              return query;
            },
          };
        }
        assert.equal(table, "files");
        return {
          insert() {
            const query = {
              select() { return query; },
              single() {
                return Promise.resolve(fileInsertError
                  ? { data: null, error: { message: fileInsertError } }
                  : { data: linkedFile, error: null });
              },
            };
            return query;
          },
          delete() {
            fileDeletes += 1;
            const query = {
              eq() { return query; },
              select() { return query; },
              maybeSingle() {
                return Promise.resolve(fileCleanupError
                  ? { data: null, error: { message: fileCleanupError } }
                  : { data: { id: linkedFile.id }, error: null });
              },
            };
            return query;
          },
        };
      },
    },
  };
  return {
    ctx,
    prior,
    linkedFile,
    reportUpdates: () => reportUpdates,
    fileDeletes: () => fileDeletes,
  };
}

async function updateExistingReportWithFailingFile(ctx) {
  return handleCreateReport(
    new Request("https://insight.momentlabs.co.kr/api/report-center", { method: "POST" }),
    ctx,
    {
      role: "team",
      client: { id: "00000000-0000-0000-0000-000000000001" },
    },
    {
      title: "월간 보고서",
      reportType: "monthly",
      reportDate: "2026-08-12",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-12",
      summary: "변경된 요약",
      publicComment: "변경된 공개 코멘트",
      internalNote: "변경된 내부 메모",
      file: {
        fileType: "drive",
        externalUrl: "https://drive.google.com/file/d/report",
      },
    },
  );
}

test("existing report file insert failure performs zero report updates", async () => {
  const fixture = existingReportMutationContext({ fileInsertError: "files_insert_failed" });
  const response = await updateExistingReportWithFailingFile(fixture.ctx);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.detail, "files_insert_failed");
  assert.deepEqual(body.cleanup, { reportUpdateSkipped: true });
  assert.equal(fixture.reportUpdates(), 0);
  assert.equal(fixture.fileDeletes(), 0);
});

test("existing report update failure removes the newly inserted file row", async () => {
  const fixture = existingReportMutationContext({ reportUpdateError: "report_update_failed" });
  const response = await updateExistingReportWithFailingFile(fixture.ctx);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.detail, "report_update_failed");
  assert.deepEqual(body.cleanup, { fileRemoved: true });
  assert.equal(body.file, null);
  assert.equal(fixture.reportUpdates(), 1);
  assert.equal(fixture.fileDeletes(), 1);
});

test("existing report update cleanup failure is surfaced with the remaining file", async () => {
  const fixture = existingReportMutationContext({
    reportUpdateError: "report_update_failed",
    fileCleanupError: "file_cleanup_failed",
  });
  const response = await updateExistingReportWithFailingFile(fixture.ctx);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.code, "REPORT_COMPENSATION_FAILED");
  assert.deepEqual(body.cleanup, { fileRemoved: false });
  assert.equal(body.file.id, fixture.linkedFile.id);
});
