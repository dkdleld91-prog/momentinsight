import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  AUDIT_LOG_DAYS,
  FULL_REFRESH_DAYS,
  INCREMENTAL_OVERLAP_MS,
  backupFolderName,
  daysSinceFullDownload,
  exportTable,
  findIncrementalBase,
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

// ─── 증분 백업(스냅숏 두 표) · 첫 페이지 중복 제거 · 제한시간/재시도 ───────────────────────────────

// PostgREST 흉내: select(* 또는 id)·gte/lte 필터·order·Range·count=exact·HEAD.
// 표의 줄은 'id 순(=Postgres 가 order=id.asc 로 내는 순서)'으로 넣어 두고, order=id 는 넣어 둔 자리 순서를 그대로 쓴다.
// 그래서 증분 결과를 JS 로 다시 정렬한 순서가 서버 순서와 다르면 바이트 대조에서 드러난다.
function tsKey(value) {
  const fraction = /\.(\d+)/.exec(String(value));
  return Date.parse(value) * 1000 + (fraction ? Number((fraction[1] + "000000").slice(3, 6)) : 0);
}

function fakeDb(state, { columns = {}, intercept = null } = {}) {
  const calls = [];
  const reply = (status, body, headers = {}) => new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
  const impl = async (url, init = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const params = parsed.searchParams;
    const call = {
      table,
      method: init.method || "GET",
      select: params.get("select"),
      order: params.get("order"),
      filters: [...params].filter(([name]) => name !== "select" && name !== "order"),
      range: init.headers.range || null,
      count: init.headers.prefer === "count=exact",
      bytes: 0,
      rows: 0,
    };
    calls.push(call);
    if (intercept) {
      const injected = intercept(call, init, calls.length - 1);
      if (injected) return injected;
    }
    const all = state[table];
    if (!all) return reply(404, JSON.stringify({ code: "42P01", message: `relation "public.${table}" does not exist` }));
    const known = columns[table] || (all[0] ? Object.keys(all[0]) : ["id", "created_at"]);
    const missingColumn = (name) => reply(400, JSON.stringify({ code: "42703", message: `column ${table}.${name} does not exist` }));
    let rows = all.map((row, position) => ({ row, position }));
    for (const [name, expr] of call.filters) {
      if (!known.includes(name)) return missingColumn(name);
      const dot = expr.indexOf(".");
      const op = expr.slice(0, dot);
      const value = tsKey(expr.slice(dot + 1));
      if (op === "gte") rows = rows.filter(({ row }) => tsKey(row[name]) >= value);
      else if (op === "lte") rows = rows.filter(({ row }) => tsKey(row[name]) <= value);
      else throw new Error(`가짜 서버가 모르는 필터 ${name}=${expr}`);
    }
    if (call.order) {
      const keys = call.order.split(",").map((part) => part.split(".")[0]);
      for (const name of keys) if (!known.includes(name)) return missingColumn(name);
      rows.sort((a, b) => {
        for (const name of keys) {
          const diff = name === "id" ? a.position - b.position : tsKey(a.row[name]) - tsKey(b.row[name]);
          if (diff) return diff;
        }
        return 0;
      });
    }
    const projected = rows.map(({ row }) => (call.select === "id" ? { id: row.id } : row));
    const total = projected.length;
    if (call.method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `*/${total}` } });
    const [from, to] = call.range ? call.range.split("-").map(Number) : [0, total - 1];
    const slice = projected.slice(from, to + 1);
    const body = JSON.stringify(slice);
    call.bytes = Buffer.byteLength(body);
    call.rows = slice.length;
    const shown = slice.length ? `${from}-${from + slice.length - 1}` : "*";
    return reply(200, body, { "content-range": `${shown}/${call.count ? total : "*"}` });
  };
  return { state, calls, impl };
}

function uuidFrom(seed) {
  const hex = createHash("md5").update(String(seed)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
// 운영 출력과 같은 모양: 2026-09-24T17:58:12.123456+00:00
function stamp(ms, micro = 0) {
  return new Date(ms).toISOString().slice(0, 23) + String(micro).padStart(3, "0") + "+00:00";
}
function byId(rows) {
  return rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY1 = Date.parse("2026-09-24T03:00:00+09:00");
function snapshotRow(seed, createdMs, tracker = "tracker-a") {
  return {
    id: uuidFrom(`snap-${seed}`),
    tracker_id: tracker,
    checked_at: stamp(createdMs - 1500),
    rank: seed % 300,
    matched: seed % 3 !== 0,
    item: { title: `상품 ${seed}`, price: 1000 + seed },
    top_items: [{ rank: 1, title: `경쟁 ${seed}` }],
    created_at: stamp(createdMs, seed % 1000),
  };
}
// DAY1 전 n 줄(1분 간격, 마지막 줄이 DAY1 - 10분).
function snapshotHistory(n, { offset = 0, tracker = "tracker-a", endMs = DAY1 - 10 * 60 * 1000 } = {}) {
  return Array.from({ length: n }, (_, index) => snapshotRow(offset + index, endMs - (n - 1 - index) * 60 * 1000, tracker));
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mi-db-export-incr-"));
}
function readGz(file) {
  return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
}
const quiet = { log: () => {}, sleep: async () => {} };

async function backup(db, outDir, nowMs, extra = {}) {
  return runExport({ baseUrl: BASE, key: KEY, outDir, fetchImpl: db.impl, nowMs, keep: 14, ...quiet, ...extra });
}

// ⑥ 같은 서버 상태를 통째로(--full) 받은 파일과 바이트 단위로 같은지(압축 전 JSON·gz 파일 둘 다).
async function assertSameAsFull(db, folder, table) {
  const fullOut = tmpDir();
  const before = db.calls.length;
  const { folder: fullFolder } = await backup(db, fullOut, DAY1 + 30 * DAY_MS, { tables: [table], full: true });
  db.calls.splice(before);
  const mine = fs.readFileSync(path.join(folder, `${table}.json.gz`));
  const reference = fs.readFileSync(path.join(fullFolder, `${table}.json.gz`));
  assert.equal(readGz(path.join(folder, `${table}.json.gz`)), readGz(path.join(fullFolder, `${table}.json.gz`)), `${table}: 압축 전 JSON 이 전체 수신과 같다(정렬 포함)`);
  assert.ok(mine.equals(reference), `${table}: gz 파일 바이트도 같다`);
  fs.rmSync(fullOut, { recursive: true, force: true });
  return reference.length;
}

const SNAP = "naver_rank_snapshots";
const PLACE = "naver_place_rank_snapshots";

test("① 기준 백업이 없으면 스냅숏도 통째로(full) — 처음부터 정렬해서 받아 첫 페이지를 두 번 받지 않는다", async () => {
  const outDir = tmpDir();
  const db = fakeDb({
    clients: byId([{ id: uuidFrom("c1"), name: "광고주", created_at: stamp(DAY1 - DAY_MS) }]),
    login_identities: [{ provider: "google", subject: "s1" }, { provider: "google", subject: "s2" }],
    [SNAP]: byId(snapshotHistory(2300)),
    [PLACE]: byId(snapshotHistory(40, { offset: 90000 })),
  });
  const { folder, manifest } = await backup(db, outDir, DAY1, { tables: ["clients", "login_identities", SNAP, PLACE] });
  assert.deepEqual(manifest.errors, []);
  for (const table of ["clients", "login_identities", SNAP, PLACE]) assert.equal(manifest.tables[table].method, "full");
  assert.deepEqual(JSON.parse(readGz(path.join(folder, `${SNAP}.json.gz`))), db.state[SNAP]);
  // 2,300줄 표 = 정렬된 3페이지(예전에는 정렬 없는 첫 페이지 1번 + 정렬 3페이지 = 4번)
  const snapCalls = db.calls.filter((call) => call.table === SNAP);
  assert.deepEqual(snapCalls.map((call) => [call.order, call.range]), [["id.asc", "0-999"], ["id.asc", "1000-1999"], ["id.asc", "2000-2999"]]);
  // 1,000줄 미만 표는 1번씩, id·created_at 없는 표는 정렬 없이 1번
  assert.equal(db.calls.filter((call) => call.table === "clients").length, 1);
  assert.deepEqual(db.calls.filter((call) => call.table === "login_identities").map((call) => call.order), [null]);
  // count=exact 는 첫 페이지에만
  assert.deepEqual(snapCalls.map((call) => call.count), [true, false, false]);
  // manifest 의 받은 바이트·요청 수 = 실제 응답 합
  const sum = (table) => db.calls.filter((call) => call.table === table).reduce((acc, call) => acc + call.bytes, 0);
  assert.equal(manifest.tables[SNAP].bytes, sum(SNAP));
  assert.equal(manifest.tables[SNAP].requests, 3);
  // 페이지 경계마다 "," 1자 대신 "][" 2자 → 3페이지 합 = 전체 JSON + 2바이트(첫 페이지를 다시 받지 않는다)
  assert.equal(manifest.tables[SNAP].bytes, Buffer.byteLength(JSON.stringify(db.state[SNAP])) + 2);
  assert.equal(manifest.totalRequests, db.calls.length);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("② 증분: 어제 성공 파일 기준으로 created_at 최댓값 − 2시간 이후 줄만 받아 합친다", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(2300)), [PLACE]: byId(snapshotHistory(300, { offset: 90000 })) });
  const day1 = await backup(db, outDir, DAY1, { tables: [SNAP, PLACE] });
  const fullBytes = day1.manifest.tables[SNAP].bytes;
  // 하루 동안 새 줄 170개(DAY1 이후)
  const fresh = Array.from({ length: 170 }, (_, index) => snapshotRow(50000 + index, DAY1 + (index + 1) * 5 * 60 * 1000));
  db.state[SNAP] = byId(db.state[SNAP].concat(fresh));
  db.calls.length = 0;
  const { folder, manifest } = await backup(db, outDir, DAY1 + DAY_MS, { tables: [SNAP, PLACE] });
  const entry = manifest.tables[SNAP];
  assert.equal(entry.method, "incremental");
  assert.equal(entry.base, path.basename(day1.folder));
  assert.equal(entry.added, 170);
  assert.equal(entry.deleted, 0);
  assert.equal(entry.changed, 0);
  assert.equal(entry.rows, 2470);
  assert.equal(entry.reportedTotal, 2470);
  const baseMax = Math.max(...snapshotHistory(2300).map((row) => Date.parse(row.created_at)));
  assert.equal(entry.since, new Date(baseMax - INCREMENTAL_OVERLAP_MS).toISOString());
  const snapCalls = db.calls.filter((call) => call.table === SNAP);
  // id 목록(3페이지) → 새 줄(1페이지) → HEAD count
  assert.deepEqual(snapCalls.map((call) => `${call.method} ${call.select} ${call.order || ""}`), [
    "GET id id.asc", "GET id id.asc", "GET id id.asc", "GET * created_at.asc,id.asc", "HEAD id ",
  ]);
  const recentCall = snapCalls[3];
  assert.deepEqual(recentCall.filters, [["created_at", `gte.${entry.since}`]]);
  const expectedRecent = db.state[SNAP].filter((row) => tsKey(row.created_at) >= tsKey(entry.since)).length;
  assert.equal(recentCall.rows, expectedRecent);
  assert.equal(expectedRecent, 170 + 121, "새 줄 170 + 2시간 여유 안의 옛 줄 121(1분 간격, 경계 포함)");
  assert.equal(snapCalls.filter((call) => call.select === "*" && !call.filters.length).length, 0, "스냅숏 본문을 통째로 받지 않는다");
  assert.ok(snapCalls[4].count && snapCalls[4].filters[0][1].startsWith("lte."), "줄 수 대조는 본문 없는 HEAD·count=exact");
  assert.equal(entry.bytes, snapCalls.reduce((acc, call) => acc + call.bytes, 0), "manifest 바이트 = id 목록 + 새 줄 본문(HEAD 는 0)");
  // 가짜 줄은 작아서(약 280B) id 목록 비중이 크다. 실제 줄(평균 약 8KB)의 절감은 로컬 백업 사본으로 따로 잰다.
  assert.ok(entry.bytes < fullBytes / 2, `증분 ${entry.bytes}B < 전체 ${fullBytes}B 의 절반`);
  await assertSameAsFull(db, folder, SNAP);
  await assertSameAsFull(db, folder, PLACE);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("③ 어제 실행이 실패했으면 기준은 그 표가 마지막으로 성공한 폴더(이틀 전)", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(1200)), [PLACE]: byId(snapshotHistory(200, { offset: 90000 })) });
  const day1 = await backup(db, outDir, DAY1, { tables: [SNAP, PLACE] });
  // 둘째 날: 순위 스냅숏만 연결이 계속 끊긴다(재시도 2번까지 모두 실패)
  db.state[SNAP] = byId(db.state[SNAP].concat([snapshotRow(60001, DAY1 + 60 * 60 * 1000)]));
  const failing = fakeDb(db.state, { intercept: (call) => (call.table === SNAP ? Promise.reject(new TypeError("fetch failed")) : null) });
  const waits = [];
  const day2 = await backup(failing, outDir, DAY1 + DAY_MS, { tables: [SNAP, PLACE], sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [5000, 30000], "5초·30초 기다렸다 다시 시도");
  assert.equal(day2.manifest.tables[SNAP].rows, null);
  assert.match(day2.manifest.errors[0], /naver_rank_snapshots: fetch failed/);
  assert.equal(failing.calls.filter((call) => call.table === SNAP).length, 3, "첫 시도 + 재시도 2번");
  assert.ok(!fs.existsSync(path.join(day2.folder, `${SNAP}.json.gz`)));
  assert.equal(day2.manifest.tables[PLACE].method, "incremental");
  // 셋째 날: 순위 스냅숏의 기준은 day1, 플레이스는 day2
  db.state[SNAP] = byId(db.state[SNAP].concat([snapshotRow(60002, DAY1 + DAY_MS + 60 * 60 * 1000)]));
  db.state[PLACE] = byId(db.state[PLACE].concat([snapshotRow(99999, DAY1 + DAY_MS + 60 * 60 * 1000)]));
  const day3 = await backup(db, outDir, DAY1 + 2 * DAY_MS, { tables: [SNAP, PLACE] });
  assert.deepEqual(day3.manifest.errors, []);
  assert.equal(day3.manifest.tables[SNAP].method, "incremental");
  assert.equal(day3.manifest.tables[SNAP].base, path.basename(day1.folder));
  assert.equal(day3.manifest.tables[SNAP].added, 2);
  assert.equal(day3.manifest.tables[PLACE].base, path.basename(day2.folder));
  await assertSameAsFull(db, day3.folder, SNAP);
  await assertSameAsFull(db, day3.folder, PLACE);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("④ 지워진 줄(추적기 삭제로 cascade)은 id 목록으로 찾아 뺀다", async () => {
  const outDir = tmpDir();
  const history = snapshotHistory(1500).concat(snapshotHistory(337, { offset: 20000, tracker: "tracker-deleted", endMs: DAY1 - 5 * 60 * 60 * 1000 }));
  const db = fakeDb({ [SNAP]: byId(history) });
  await backup(db, outDir, DAY1, { tables: [SNAP] });
  const deletedIds = new Set(db.state[SNAP].filter((row) => row.tracker_id === "tracker-deleted").map((row) => row.id));
  db.state[SNAP] = byId(db.state[SNAP].filter((row) => !deletedIds.has(row.id)).concat([snapshotRow(70000, DAY1 + 30 * 60 * 1000)]));
  const { folder, manifest } = await backup(db, outDir, DAY1 + DAY_MS, { tables: [SNAP] });
  assert.equal(manifest.tables[SNAP].method, "incremental");
  assert.equal(manifest.tables[SNAP].deleted, 337);
  assert.equal(manifest.tables[SNAP].added, 1);
  assert.equal(manifest.tables[SNAP].rows, 1501);
  const saved = JSON.parse(readGz(path.join(folder, `${SNAP}.json.gz`)));
  assert.ok(saved.every((row) => !deletedIds.has(row.id)));
  await assertSameAsFull(db, folder, SNAP);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("⑤ 서버 줄 수(count)가 합친 결과와 다르면 그 표만 통째로 다시 받는다(fallback)", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(1100)), [PLACE]: byId(snapshotHistory(50, { offset: 90000 })) });
  await backup(db, outDir, DAY1, { tables: [SNAP, PLACE] });
  db.state[SNAP] = byId(db.state[SNAP].concat([snapshotRow(80000, DAY1 + 60 * 60 * 1000)]));
  // HEAD 가 한 줄 더 있다고 답하는 서버(예: 합치는 사이 옛 줄이 지워지거나 다른 줄이 끼어든 경우)
  const skewed = fakeDb(db.state, {
    intercept: (call) => (call.table === SNAP && call.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-range": `*/${db.state[SNAP].length + 1}` } }) : null),
  });
  const { folder, manifest } = await backup(skewed, outDir, DAY1 + DAY_MS, { tables: [SNAP, PLACE] });
  const entry = manifest.tables[SNAP];
  assert.equal(entry.method, "fallback");
  assert.equal(entry.fallbackReason, "count_mismatch:merged=1101,server=1102");
  assert.equal(entry.rows, 1101);
  assert.deepEqual(manifest.errors, []);
  const afterHead = skewed.calls.slice(skewed.calls.findIndex((call) => call.table === SNAP && call.method === "HEAD") + 1).filter((call) => call.table === SNAP);
  assert.deepEqual(afterHead.map((call) => `${call.select} ${call.order} ${call.range}`), ["* id.asc 0-999", "* id.asc 1000-1999"], "그 표만 처음부터 통째로");
  assert.equal(manifest.tables[PLACE].method, "incremental", "다른 표는 증분 그대로");
  await assertSameAsFull(db, folder, SNAP);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("⑤-2 2시간 여유보다 오래된 created_at 으로 끼어든 줄이 있으면(id 목록에만 있음) 통째로 다시 받는다", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(600)) });
  await backup(db, outDir, DAY1, { tables: [SNAP] });
  const backdated = snapshotRow(81000, DAY1 - 3 * DAY_MS);
  db.state[SNAP] = byId(db.state[SNAP].concat([backdated]));
  const { folder, manifest } = await backup(db, outDir, DAY1 + DAY_MS, { tables: [SNAP] });
  assert.equal(manifest.tables[SNAP].method, "fallback");
  assert.equal(manifest.tables[SNAP].fallbackReason, "server_rows_not_in_base_or_recent:1");
  const saved = JSON.parse(readGz(path.join(folder, `${SNAP}.json.gz`)));
  assert.ok(saved.some((row) => row.id === backdated.id));
  await assertSameAsFull(db, folder, SNAP);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("⑤-3 표에 열이 더해지면(마이그레이션) 옛 줄 모양이 달라지므로 통째로 다시 받는다", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(300)) });
  await backup(db, outDir, DAY1, { tables: [SNAP] });
  db.state[SNAP] = byId(db.state[SNAP].concat([snapshotRow(82000, DAY1 + 60 * 60 * 1000)]).map((row) => {
    const { created_at: createdAt, ...rest } = row;
    return { ...rest, evidence: null, created_at: createdAt };
  }));
  const { folder, manifest } = await backup(db, outDir, DAY1 + DAY_MS, { tables: [SNAP] });
  assert.equal(manifest.tables[SNAP].method, "fallback");
  assert.equal(manifest.tables[SNAP].fallbackReason, "columns_changed");
  await assertSameAsFull(db, folder, SNAP);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("⑤-4 서버가 증분 요청을 거절하면(예: HEAD 405) 매일 실패하지 않게 그 표만 통째로 받는다", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(120)) });
  await backup(db, outDir, DAY1, { tables: [SNAP] });
  const refusing = fakeDb(db.state, {
    intercept: (call) => (call.method === "HEAD" ? new Response("method not allowed", { status: 405 }) : null),
  });
  const { folder, manifest } = await backup(refusing, outDir, DAY1 + DAY_MS, { tables: [SNAP] });
  assert.deepEqual(manifest.errors, []);
  assert.equal(manifest.tables[SNAP].method, "fallback");
  assert.equal(manifest.tables[SNAP].fallbackReason, "incremental_http_405");
  assert.equal(refusing.calls.filter((call) => call.method === "HEAD").length, 1, "405 는 다시 시도하지 않는다");
  await assertSameAsFull(db, folder, SNAP);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("⑥ 증분을 여러 날 이어도 결과는 매일 전체 수신과 바이트 단위로 같다(추가·삭제·경계 같은 시각 포함)", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(900)) });
  await backup(db, outDir, DAY1, { tables: [SNAP] });
  for (let day = 1; day <= 4; day += 1) {
    const dayMs = DAY1 + day * DAY_MS;
    const fresh = Array.from({ length: 30 }, (_, index) => snapshotRow(day * 1000 + 100000 + index, dayMs - DAY_MS + (index + 1) * 40 * 60 * 1000));
    // 같은 밀리초·다른 마이크로초 줄(경계 비교)
    const twin = { ...fresh[29], id: uuidFrom(`twin-${day}`), created_at: fresh[29].created_at.replace(/\d{3}\+00:00$/, "999+00:00") };
    const drop = new Set(db.state[SNAP].slice(day * 7, day * 7 + 5).map((row) => row.id));
    db.state[SNAP] = byId(db.state[SNAP].filter((row) => !drop.has(row.id)).concat(fresh, [twin]));
    const { folder, manifest } = await backup(db, outDir, dayMs, { tables: [SNAP] });
    assert.equal(manifest.tables[SNAP].method, "incremental", `day ${day}`);
    assert.equal(manifest.tables[SNAP].deleted, 5);
    assert.equal(manifest.tables[SNAP].added, 31);
    await assertSameAsFull(db, folder, SNAP);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("⑦ 첫 페이지 중복이 사라져 작은 표는 요청 1번, 큰 표는 정렬 페이지 수만큼 — 같은 범위를 두 번 받지 않는다", async () => {
  const outDir = tmpDir();
  const state = {
    clients: byId(Array.from({ length: 22 }, (_, index) => ({ id: uuidFrom(`c${index}`), name: `광고주 ${index}`, created_at: stamp(DAY1 - index * 1000) }))),
    audit_logs: byId(Array.from({ length: 212 }, (_, index) => ({ id: uuidFrom(`a${index}`), action: "x", created_at: stamp(DAY1 - index * 60000) }))),
    trial_keyword_quota: [{ owner: "o1", used: 3 }],
    [SNAP]: byId(snapshotHistory(2001)),
  };
  const db = fakeDb(state);
  const { manifest } = await backup(db, outDir, DAY1, { tables: Object.keys(state), full: true });
  assert.equal(manifest.totalRequests, 1 + 1 + 1 + 3);
  const seen = new Set();
  for (const call of db.calls) {
    const keyOfCall = `${call.table} ${call.range}`;
    assert.ok(!seen.has(keyOfCall), `두 번 받은 범위 없음: ${keyOfCall}`);
    seen.add(keyOfCall);
  }
  const body = (rows) => Buffer.byteLength(JSON.stringify(rows));
  assert.equal(manifest.tables.clients.bytes, body(state.clients), "작은 표는 본문 한 번만");
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("정렬 열이 없는 모르는 표는 id → created_at → 정렬 없음 순서로 시도한다(400·42703 만 넘어간다)", async () => {
  const db = fakeDb(
    {
      events_only_created: [{ created_at: stamp(DAY1 - 2000), v: 2 }, { created_at: stamp(DAY1 - 1000), v: 1 }],
      no_keys: [{ k: "b" }, { k: "a" }],
    },
    { columns: { events_only_created: ["created_at", "v"], no_keys: ["k"] } },
  );
  const one = await exportTable({ baseUrl: BASE, key: KEY, table: "events_only_created", fetchImpl: db.impl });
  assert.equal(one.order, "created_at");
  assert.deepEqual(one.rows.map((row) => row.v), [2, 1]);
  const two = await exportTable({ baseUrl: BASE, key: KEY, table: "no_keys", fetchImpl: db.impl });
  assert.equal(two.order, null);
  assert.deepEqual(two.rows, [{ k: "b" }, { k: "a" }]);
  assert.deepEqual(db.calls.map((call) => `${call.table}:${call.order}`), [
    "events_only_created:id.asc", "events_only_created:created_at.asc", "no_keys:id.asc", "no_keys:created_at.asc", "no_keys:null",
  ]);
});

test("제한시간·재시도: 끊긴 연결은 5초 뒤 다시 시도하고, 멈춘 요청은 제한시간에 끊는다 · 404 는 다시 시도하지 않는다", async () => {
  const outDir = tmpDir();
  const waits = [];
  let hangs = 1;
  let drops = 1;
  const db = fakeDb(
    { clients: byId([{ id: uuidFrom("c1"), created_at: stamp(DAY1) }]), brands: [] },
    {
      intercept: (call, init) => {
        if (call.table === "clients" && drops > 0) {
          drops -= 1;
          return Promise.reject(new TypeError("fetch failed"));
        }
        if (call.table === "brands" && hangs > 0) {
          hangs -= 1;
          return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
        }
        return null;
      },
    },
  );
  const { manifest } = await runExport({
    baseUrl: BASE,
    key: KEY,
    outDir,
    tables: ["clients", "brands", "missing_table"],
    fetchImpl: db.impl,
    nowMs: DAY1,
    log: () => {},
    timeoutMs: 30,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(manifest.tables.clients.rows, 1);
  assert.equal(manifest.tables.clients.requests, 2);
  assert.equal(manifest.tables.brands.rows, 0);
  assert.equal(manifest.tables.brands.requests, 2, "제한시간에 끊고 한 번 더");
  assert.deepEqual(waits, [5000, 5000]);
  assert.equal(db.calls.filter((call) => call.table === "missing_table").length, 1);
  assert.match(manifest.errors[0], /missing_table: HTTP 404/);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("기준 찾기: manifest 없음·그 표 오류·깨진 gz·줄 수 불일치·다른 프로젝트 백업은 건너뛴다", () => {
  const outDir = tmpDir();
  const rows = [{ id: "a", created_at: stamp(DAY1) }];
  const write = (name, manifest, content) => {
    fs.mkdirSync(path.join(outDir, name));
    if (manifest) fs.writeFileSync(path.join(outDir, name, "manifest.json"), JSON.stringify(manifest));
    if (content !== undefined) fs.writeFileSync(path.join(outDir, name, `${SNAP}.json.gz`), content);
  };
  const ok = (count) => ({ baseUrl: "example", tables: { [SNAP]: { rows: count } } });
  write("2026-09-01_0300", ok(1), zlib.gzipSync(JSON.stringify(rows)));
  write("2026-09-02_0300", { baseUrl: "other-project", tables: { [SNAP]: { rows: 1 } } }, zlib.gzipSync(JSON.stringify(rows)));
  write("2026-09-03_0300", ok(2), zlib.gzipSync(JSON.stringify(rows)));
  write("2026-09-04_0300", ok(1), Buffer.from("not gzip"));
  write("2026-09-05_0300", { baseUrl: "example", tables: { [SNAP]: { rows: null, error: "fetch failed" } }, errors: ["x"] });
  write("2026-09-06_0300", null, zlib.gzipSync(JSON.stringify(rows)));
  write("2026-09-07_0300", ok(1), zlib.gzipSync(JSON.stringify(rows)));
  assert.equal(findIncrementalBase(outDir, SNAP, { projectRef: "example", excludeFolder: "2026-09-07_0300" }).folder, "2026-09-01_0300");
  assert.equal(findIncrementalBase(outDir, SNAP, { projectRef: "example" }).folder, "2026-09-07_0300");
  assert.equal(findIncrementalBase(outDir, PLACE, { projectRef: "example" }), null);
  assert.equal(findIncrementalBase(path.join(outDir, "none"), SNAP, {}), null);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("--full 이면 기준이 있어도 스냅숏을 통째로 받는다", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(50)) });
  await backup(db, outDir, DAY1, { tables: [SNAP] });
  const { manifest } = await backup(db, outDir, DAY1 + DAY_MS, { tables: [SNAP], full: true });
  assert.equal(manifest.tables[SNAP].method, "full");
  assert.equal(parseArgs(["--out", "/tmp/b", "--full"]).full, true);
  assert.equal(parseArgs(["--out", "/tmp/b"]).full, false);
  fs.rmSync(outDir, { recursive: true, force: true });
});

// ─── 검토 지적 반영(2026-09-25): 주 1회 통째 수신 · 증분 도중 실패의 방식 기록 ─────────────────────

test("주 1회 통째 수신: 마지막 통째 수신이 7일 지났으면 그날은 스냅숏도 통째로 받고, 다음 날부터 다시 증분", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(900)) });
  const first = await backup(db, outDir, DAY1, { tables: [SNAP] });
  assert.equal(first.manifest.tables[SNAP].method, "full");
  for (let day = 1; day < FULL_REFRESH_DAYS; day += 1) {
    const { manifest } = await backup(db, outDir, DAY1 + day * DAY_MS, { tables: [SNAP] });
    assert.equal(manifest.tables[SNAP].method, "incremental", `day ${day}`);
  }
  // 7일째: 마지막 통째 수신(DAY1)에서 정확히 7일 → 통째로
  const week = await backup(db, outDir, DAY1 + FULL_REFRESH_DAYS * DAY_MS, { tables: [SNAP] });
  assert.equal(week.manifest.tables[SNAP].method, "full");
  assert.match(week.manifest.tables[SNAP].fullRefresh, /^last_full_7\.0d$/);
  assert.equal(week.manifest.tables[SNAP].base, undefined, "통째로 받는 날은 기준 폴더를 쓰지 않는다");
  await assertSameAsFull(db, week.folder, SNAP);
  // 다음 날은 방금 통째로 받은 폴더 기준으로 다시 증분
  const next = await backup(db, outDir, DAY1 + (FULL_REFRESH_DAYS + 1) * DAY_MS, { tables: [SNAP] });
  assert.equal(next.manifest.tables[SNAP].method, "incremental");
  assert.equal(next.manifest.tables[SNAP].base, path.basename(week.folder));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("주 1회 통째 수신: 예전 코드의 폴더(method 칸 없음)는 통째로 받은 날로 센다 · 그 표가 오류였던 폴더는 세지 않는다", () => {
  const outDir = tmpDir();
  const write = (name, tables) => {
    fs.mkdirSync(path.join(outDir, name), { recursive: true });
    fs.writeFileSync(path.join(outDir, name, "manifest.json"), JSON.stringify({ baseUrl: "example", tables }));
  };
  write("2026-09-20_0300", { [SNAP]: { rows: 10 } }); // 예전 코드 — 통째
  write("2026-09-23_0300", { [SNAP]: { rows: 12, method: "incremental" } });
  write("2026-09-24_0300", { [SNAP]: { rows: null, error: "fetch failed", method: "full" } }); // 실패 — 세지 않음
  const now = new Date(2026, 8, 25, 3, 0).getTime();
  assert.equal(daysSinceFullDownload(outDir, SNAP, { projectRef: "example", nowMs: now }), 5);
  assert.equal(daysSinceFullDownload(outDir, "naver_place_rank_snapshots", { projectRef: "example", nowMs: now }), Infinity);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("증분 도중 연결이 끊기면 manifest 방식은 incremental 로 남고(통째 실패로 잘못 적지 않음) 오류가 적힌다 — 다음 날 기준에서 빠진다", async () => {
  const outDir = tmpDir();
  const db = fakeDb({ [SNAP]: byId(snapshotHistory(300)) });
  const day1 = await backup(db, outDir, DAY1, { tables: [SNAP] });
  // 이튿날: 새 줄 조회(select=*·created_at 필터)에서 연결이 끊긴다(status 없음, 재시도도 모두 실패)
  const broken = fakeDb(db.state, { intercept: (call) => (call.select === "*" && call.filters.length ? Promise.reject(new TypeError("fetch failed")) : null) });
  const day2 = await runExport({ baseUrl: BASE, key: KEY, outDir, fetchImpl: broken.impl, nowMs: DAY1 + DAY_MS, keep: 14, tables: [SNAP], ...quiet });
  const entry = day2.manifest.tables[SNAP];
  assert.equal(entry.method, "incremental");
  assert.match(entry.error, /fetch failed/);
  assert.equal(entry.base, path.basename(day1.folder));
  // 셋째 날은 실패한 둘째 날 폴더를 건너뛰고 첫날 폴더를 기준으로 증분
  const day3 = await backup(db, outDir, DAY1 + 2 * DAY_MS, { tables: [SNAP] });
  assert.equal(day3.manifest.tables[SNAP].method, "incremental");
  assert.equal(day3.manifest.tables[SNAP].base, path.basename(day1.folder));
  fs.rmSync(outDir, { recursive: true, force: true });
});
