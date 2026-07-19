import assert from "node:assert/strict";
import test from "node:test";
import {
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
