import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  AUDIT_LOG_DAYS,
  backupFolderName,
  exportTable,
  parseArgs,
  parseEnvFile,
  pruneOldBackups,
  runExport,
} from "./db-export.mjs";

const BASE = "https://example.supabase.co";
const KEY = "service-key";

// 표별 행을 정해 두고 Range 헤더대로 잘라 주는 가짜 PostgREST. 모든 호출을 기록한다.
function fakeRest(rowsByTable) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const range = String(init.headers.range || "0-999").split("-").map(Number);
    calls.push({ table, method: init.method, range, query: parsed.search, auth: init.headers.authorization });
    const rows = rowsByTable[table];
    if (!rows) return new Response("relation missing", { status: 404 });
    const slice = rows.slice(range[0], range[1] + 1);
    return new Response(JSON.stringify(slice), {
      status: 206,
      headers: { "content-type": "application/json", "content-range": `${range[0]}-${range[0] + slice.length - 1}/${rows.length}` },
    });
  };
  return { calls, impl };
}

test("env 파일은 주석·빈 줄을 건너뛰고 따옴표를 벗긴다", () => {
  const env = parseEnvFile('# 설명\nSUPABASE_URL="https://x.supabase.co"\n\nSUPABASE_SERVICE_ROLE_KEY=abc=def\nBAD LINE\n');
  assert.deepEqual(env, { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "abc=def" });
});

test("인자: --out·--keep·--env 를 읽고 keep 이 이상하면 14", () => {
  assert.equal(parseArgs(["--out", "/tmp/b", "--keep", "7"]).keep, 7);
  assert.equal(parseArgs(["--out", "/tmp/b", "--keep", "0"]).keep, 14);
  assert.equal(parseArgs(["--out", "/tmp/b"]).out, "/tmp/b");
  assert.match(parseArgs([]).env, /backup\.env$/);
  assert.match(backupFolderName(new Date(2026, 8, 7, 3, 5)), /^2026-09-07_0305$/);
});

test("id 가 있는 표는 id 순으로 1000행씩 끝까지 읽고 GET 만 보낸다", async () => {
  const rows = Array.from({ length: 2300 }, (_, index) => ({ id: `r${index}`, value: index }));
  const rest = fakeRest({ clients: rows });
  const result = await exportTable({ baseUrl: BASE, key: KEY, table: "clients", fetchImpl: rest.impl });
  assert.equal(result.rows.length, 2300);
  assert.equal(result.total, 2300);
  assert.ok(rest.calls.every((call) => call.method === "GET"), "쓰기 요청은 없다");
  assert.ok(rest.calls.every((call) => call.auth === `Bearer ${KEY}`));
  const ordered = rest.calls.filter((call) => call.query.includes("order=id.asc"));
  assert.equal(ordered.length, 3, "정렬 기준을 알고 나면 정렬해서 3페이지");
  assert.deepEqual(ordered.map((call) => call.range), [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("빈 표는 한 번 읽고 끝난다 · 감사 기록은 90일 필터가 붙는다", async () => {
  const rest = fakeRest({ brands: [], audit_logs: [{ id: "a1", created_at: "2026-09-01T00:00:00Z" }] });
  const empty = await exportTable({ baseUrl: BASE, key: KEY, table: "brands", fetchImpl: rest.impl });
  assert.deepEqual(empty.rows, []);
  assert.equal(rest.calls.filter((call) => call.table === "brands").length, 1);
  const nowMs = Date.parse("2026-09-07T00:00:00Z");
  await exportTable({ baseUrl: BASE, key: KEY, table: "audit_logs", fetchImpl: rest.impl, nowMs });
  const auditCall = rest.calls.find((call) => call.table === "audit_logs");
  const since = new Date(nowMs - AUDIT_LOG_DAYS * 24 * 60 * 60 * 1000).toISOString();
  assert.ok(auditCall.query.includes(`created_at=gte.${encodeURIComponent(since)}`));
});

test("runExport: 표별 gz 파일·manifest 를 쓰고, 실패한 표는 errors 에 남기며, 오래된 폴더를 정리한다", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mi-db-export-"));
  for (const name of ["2026-08-01_0300", "2026-08-02_0300", "2026-08-03_0300", "not-a-backup"]) fs.mkdirSync(path.join(outDir, name));
  const rest = fakeRest({ clients: [{ id: "c1", name: "광고주" }], reports: [] });
  const { folder, manifest } = await runExport({
    baseUrl: BASE,
    key: KEY,
    outDir,
    tables: ["clients", "reports", "missing_table"],
    keep: 2,
    fetchImpl: rest.impl,
    nowMs: Date.parse("2026-09-07T03:00:00+09:00"),
    log: () => {},
  });
  const clients = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(folder, "clients.json.gz"))).toString("utf8"));
  assert.deepEqual(clients, [{ id: "c1", name: "광고주" }]);
  assert.equal(manifest.tables.clients.rows, 1);
  assert.equal(manifest.tables.reports.rows, 0);
  assert.equal(manifest.tables.missing_table.rows, null);
  assert.equal(manifest.errors.length, 1);
  assert.match(manifest.errors[0], /missing_table: HTTP 404/);
  assert.ok(fs.existsSync(path.join(folder, "manifest.json")));
  // keep=2: 새 폴더 포함 최신 2개만 남는다. 백업 이름 패턴이 아닌 폴더는 건드리지 않는다.
  const remaining = fs.readdirSync(outDir).sort();
  assert.ok(remaining.includes("not-a-backup"));
  assert.ok(remaining.includes(path.basename(folder)));
  assert.equal(remaining.filter((name) => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(name)).length, 2);
  assert.deepEqual(manifest.pruned, ["2026-08-01_0300", "2026-08-02_0300"]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("pruneOldBackups: 폴더가 없으면 아무것도 하지 않는다", () => {
  assert.deepEqual(pruneOldBackups(path.join(os.tmpdir(), "mi-db-export-none-" + Date.now()), 3), []);
});
