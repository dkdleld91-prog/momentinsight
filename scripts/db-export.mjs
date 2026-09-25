#!/usr/bin/env node
// 모먼트 인사이트 DB 논리 백업 — 읽기 전용. Supabase REST(PostgREST)를 서비스 키로 읽어 표마다 JSON.gz 로 남긴다.
//
// 왜: 이용 기간 만료 + 유예 5일 뒤 광고주 데이터를 지우는 크론(account-expiry-cron, 매일 03:30·03:40 KST)이 돌고
//     있다. 지우기 전 상태를 매일 새벽에 한 벌 남겨 두면 실수로 만료일을 잘못 잡아도 되돌릴 근거가 있다.
//     pg_dump 가 없는 맥에서도 node 하나로 돌아가게 REST 로 읽는다(쓰기 요청은 한 번도 보내지 않는다).
//
// 사용:
//   node scripts/db-export.mjs --out "$HOME/MomentInsightBackups" [--keep 14] [--env ~/.config/momentinsight/backup.env] [--full]
// 환경(파일, chmod 600 — 채팅·저장소에 넣지 않는다):
//   SUPABASE_URL=https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=<service role key>
//   MI_DB_EXPORT_TABLES=clients,naver_rank_trackers,...   (선택 · 기본 목록을 바꿀 때만)
// 결과:
//   <out>/<YYYY-MM-DD_HHmm>/<table>.json.gz + manifest.json(표별 행 수·소요·오류·받은 바이트·방식). 오래된 폴더는 --keep 개만 남긴다.
//   표 하나라도 실패하면 exit 1 (launchd 로그에서 바로 보이게).
// 증분(Supabase 전송량 절감, 2026-09-25):
//   스냅숏 두 표(INCREMENTAL_TABLES)는 줄이 추가만 되고 고쳐지지 않는다(삭제는 추적기 삭제 때 함께 지워질 때뿐).
//   그래서 표마다 '마지막으로 성공한 백업 파일'을 기준으로 새 줄만 받아 합치고, 지워진 줄은 id 목록으로 빼고,
//   서버 줄 수와 대조해 다르면 그 표만 통째로 다시 받는다. 결과 파일은 통째로 받은 것과 내용·순서가 같다(복원 방법 그대로).
//   --full 을 주면 증분 없이 모든 표를 통째로 받는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

// 기본 백업 대상. 토큰·임시 큐 표는 뺀다(owner_google_integrations 는 구글 토큰, naver_shopping_* 는 워커 조정용 임시값).
export const DEFAULT_TABLES = [
  "clients",
  "operation_team_codes",
  "client_members",
  "login_identities",
  "profiles",
  "trial_keyword_quota",
  "naver_rank_trackers",
  "naver_rank_snapshots",
  "naver_place_rank_trackers",
  "naver_place_rank_snapshots",
  "keyword_research_notes",
  "keywords",
  "brands",
  "channels",
  "kpi_targets",
  "kpi_results",
  "action_plans",
  "ad_performance",
  "reports",
  "files",
  "schedule_items",
  "dashboard_snapshots",
  "meta_ad_research_items",
  "audit_logs",
];
// 감사 기록은 최근 90일만(오래된 것은 이전 백업에 있다).
export const AUDIT_LOG_DAYS = 90;
export const PAGE_SIZE = 1000;
export const BACKUP_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{4}$/;
// 새 줄만 받는 표. 두 표 모두 id(무작위 uuid)·created_at(default now(), not null)이 있고, 서버 코드에 update 경로가 없다.
export const INCREMENTAL_TABLES = ["naver_rank_snapshots", "naver_place_rank_snapshots"];
// 기준 파일의 created_at 최댓값보다 이만큼 앞부터 다시 받는다(늦게 커밋된 트랜잭션·시계 차이 여유).
export const INCREMENTAL_OVERLAP_MS = 2 * 60 * 60 * 1000;
// 요청 하나의 제한시간과 재시도 간격. 맥이 잠들었다 깨면 요청 하나를 51분~2.6시간 붙잡고 있다가 'fetch failed'로
// 끝났다(09-18·09-19·09-23 실행, manifest 의 ms). 제한시간은 깨어 있는 시간 기준이라 잠든 동안에는 흐르지 않는다(추정).
export const REQUEST_TIMEOUT_MS = 120_000;
export const RETRY_DELAYS_MS = [5_000, 30_000];
// id·created_at 이 둘 다 없는 표(정렬 없이 받는다 — 예전과 같다). 여기 없는 표는 id → created_at → 정렬 없음 순서로 시도한다.
const UNORDERED_TABLES = new Set(["login_identities", "trial_keyword_quota"]);

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function parseArgs(argv) {
  const args = { out: "", keep: 14, env: path.join(os.homedir(), ".config", "momentinsight", "backup.env"), full: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = String(argv[index + 1] || ""), index += 1;
    else if (arg === "--keep") args.keep = Number(argv[index + 1]), index += 1;
    else if (arg === "--env") args.env = String(argv[index + 1] || ""), index += 1;
    else if (arg === "--full") args.full = true;
  }
  if (!Number.isInteger(args.keep) || args.keep < 1) args.keep = 14;
  return args;
}

export function backupFolderName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function projectRefOf(baseUrl) {
  return String(baseUrl || "").replace(/^https?:\/\//, "").split(".")[0];
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 요청 하나하나를 세는 REST 읽기 도구. requests·bytes(응답 본문, 압축 풀린 기준)는 manifest 에 표별로 적는다.
export function createRestClient({
  baseUrl,
  key,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  sleep = defaultSleep,
  log = () => {},
}) {
  return { baseUrl, key, fetchImpl, timeoutMs, retryDelaysMs, sleep, log, requests: 0, bytes: 0 };
}

// 연결 끊김(fetch failed)·제한시간·본문 중간 끊김·5xx·408·429 만 다시 시도한다. 404·400 같은 요청 오류는 바로 실패.
function isRetryable(error) {
  if (error && Number.isInteger(error.status)) return error.status >= 500 || error.status === 408 || error.status === 429;
  return true;
}

async function restRequest(client, pathWithQuery, { method = "GET", from = null, to = null, count = false } = {}) {
  const headers = { apikey: client.key, authorization: `Bearer ${client.key}`, accept: "application/json" };
  if (from !== null) headers.range = `${from}-${to}`;
  if (count) headers.prefer = "count=exact";
  for (let attempt = 0; ; attempt += 1) {
    client.requests += 1;
    try {
      const response = await client.fetchImpl(`${client.baseUrl}/rest/v1/${pathWithQuery}`, {
        method,
        headers,
        signal: AbortSignal.timeout(client.timeoutMs),
      });
      const text = method === "HEAD" ? "" : await response.text();
      client.bytes += Buffer.byteLength(text, "utf8");
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
        error.status = response.status;
        error.body = text;
        throw error;
      }
      const rows = text ? JSON.parse(text) : [];
      const contentRange = response.headers.get("content-range") || "";
      const total = contentRange.includes("/") ? Number(contentRange.split("/")[1]) : NaN;
      return { rows: Array.isArray(rows) ? rows : [], total: Number.isFinite(total) ? total : null };
    } catch (error) {
      if (attempt >= client.retryDelaysMs.length || !isRetryable(error)) throw error;
      client.log(`  다시 시도 ${attempt + 1}/${client.retryDelaysMs.length} (${String(error && error.message || error)})`);
      await client.sleep(client.retryDelaysMs[attempt]);
    }
  }
}

// Range 로 pageSize 줄씩 끝까지 읽는다. count=exact 는 첫 페이지에만 붙인다(서버 줄 수 보고용).
async function fetchAllPages(client, pathWithQuery, pageSize, { count = false } = {}) {
  const rows = [];
  let total = null;
  for (let offset = 0; ;) {
    const page = await restRequest(client, pathWithQuery, { from: offset, to: offset + pageSize - 1, count: count && offset === 0 });
    if (offset === 0) total = page.total;
    for (const row of page.rows) rows.push(row);
    offset += page.rows.length;
    if (page.rows.length < pageSize) return { rows, total };
  }
}

function isUndefinedColumnError(error) {
  return Boolean(error) && error.status === 400 && /42703|does not exist/.test(String(error.body || ""));
}

function tableFilters(table, nowMs) {
  if (table !== "audit_logs") return [];
  return [`created_at=gte.${encodeURIComponent(new Date(nowMs - AUDIT_LOG_DAYS * 24 * 60 * 60 * 1000).toISOString())}`];
}

// 표 하나를 통째로 받는다. 처음부터 정렬해서 받는다(id → created_at → 없음). 정렬 없이 넘기면 페이지 사이에 행이 밀릴 수 있다.
// 예전에는 정렬 없는 첫 페이지를 받아 열 이름을 본 뒤 버리고 처음부터 다시 받아, 첫 1,000줄을 두 번 받았다.
export async function exportTable({ baseUrl, key, table, fetchImpl = fetch, nowMs = Date.now(), pageSize = PAGE_SIZE, client = null }) {
  const rest = client || createRestClient({ baseUrl, key, fetchImpl });
  const query = ["select=*"].concat(tableFilters(table, nowMs)).join("&");
  const orderColumns = UNORDERED_TABLES.has(table) ? [""] : ["id", "created_at", ""];
  for (const column of orderColumns) {
    try {
      const order = column ? `&order=${column}.asc` : "";
      const result = await fetchAllPages(rest, `${table}?${query}${order}`, pageSize, { count: true });
      return { table, rows: result.rows, total: result.total, order: column || null };
    } catch (error) {
      if (column && isUndefinedColumnError(error)) continue;
      throw error;
    }
  }
  throw new Error(`${table}: 정렬 기준을 정하지 못했습니다`);
}

// 표마다 '마지막으로 성공한 백업 파일'을 찾는다(어제 실행이 실패했으면 그 전 성공분). manifest 가 없거나,
// 그 표가 오류였거나, 파일이 깨졌거나, 줄 수가 manifest 와 다르거나, 다른 Supabase 프로젝트의 백업이면 건너뛴다.
export function findIncrementalBase(outDir, table, { excludeFolder = "", projectRef = "" } = {}) {
  if (!fs.existsSync(outDir)) return null;
  const folders = fs.readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BACKUP_DIR_PATTERN.test(entry.name) && entry.name !== excludeFolder)
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of folders) {
    const dir = path.join(outDir, name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
      if (projectRef && manifest.baseUrl && manifest.baseUrl !== projectRef) continue;
      const entry = manifest.tables && manifest.tables[table];
      if (!entry || entry.error || !Number.isInteger(entry.rows)) continue;
      const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, `${table}.json.gz`))).toString("utf8"));
      if (!Array.isArray(rows) || rows.length !== entry.rows) continue;
      return { folder: name, rows };
    } catch {
      continue;
    }
  }
  return null;
}

// PostgREST 의 order=id.asc 와 같은 순서. uuid 는 바이트 순으로 비교되고, 소문자 16진 문자열 비교와 같다.
function compareId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function laterCreatedAt(a, b) {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (aMs !== bMs) return aMs > bMs ? a : b;
  return a >= b ? a : b; // 같은 밀리초면 마이크로초 자리까지 문자열로 비교(같은 서버 출력 형식)
}

// 기준 파일 + 새 줄 + 지워진 줄 반영. 검증에 실패하면 { fallbackReason } 을 돌려주고 부른 쪽이 그 표만 통째로 다시 받는다.
export async function exportTableIncremental({ client, table, base, pageSize = PAGE_SIZE, overlapMs = INCREMENTAL_OVERLAP_MS }) {
  const baseRows = base.rows;
  if (!baseRows.length) return { fallbackReason: "base_empty" };
  let baseMaxMs = -Infinity;
  for (const row of baseRows) {
    const ms = row && typeof row.id === "string" && typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
    if (!Number.isFinite(ms)) return { fallbackReason: "base_row_without_id_or_created_at" };
    if (ms > baseMaxMs) baseMaxMs = ms;
  }
  const since = new Date(baseMaxMs - overlapMs).toISOString();

  // ① 지금 서버에 있는 id 전부(id 만 받는 가벼운 조회). 새 줄보다 먼저 받아야 그 사이에 들어온 줄이 '모르는 줄'로 잡히지 않는다.
  const idList = await fetchAllPages(client, `${table}?select=id&order=id.asc`, pageSize);
  const serverIds = new Set(idList.rows.map((row) => row.id));

  // ② 기준 파일의 created_at 최댓값 − 2시간 이후 줄만, created_at,id 순으로.
  const recent = await fetchAllPages(
    client,
    `${table}?select=*&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc,id.asc`,
    pageSize,
  );

  // 표에 열이 더해지거나 빠졌으면(마이그레이션) 옛 줄의 모양이 전체 수신과 달라진다 → 통째로 다시 받는다.
  const baseColumns = Object.keys(baseRows[0]).join(",");
  if (recent.rows.some((row) => Object.keys(row).join(",") !== baseColumns)) return { fallbackReason: "columns_changed", stats: { since } };

  // ③ id 로 합친다. 서버 id 목록에 없는 기준 줄은 지워진 줄이라 뺀다. 겹치는 줄은 방금 받은 서버 값을 쓴다.
  const merged = new Map();
  let deleted = 0;
  for (const row of baseRows) {
    if (serverIds.has(row.id)) merged.set(row.id, row);
    else deleted += 1;
  }
  let added = 0;
  let changed = 0;
  for (const row of recent.rows) {
    const previous = merged.get(row.id);
    if (!previous) added += 1;
    else if (JSON.stringify(previous) !== JSON.stringify(row)) changed += 1;
    merged.set(row.id, row);
  }
  let missing = 0;
  for (const id of serverIds) if (!merged.has(id)) missing += 1;
  const stats = { since, added, deleted, changed };
  // 서버에는 있는데 기준에도 새 줄에도 없는 줄 = 2시간 여유보다 오래된 created_at 으로 들어온 줄. 통째로 다시 받는다.
  if (missing) return { fallbackReason: `server_rows_not_in_base_or_recent:${missing}`, stats };

  const rows = Array.from(merged.values()).sort(compareId);
  if (!rows.length) return { fallbackReason: "merged_empty", stats };

  // ④ 줄 수 대조: 합친 줄의 created_at 최댓값까지의 서버 줄 수(count=exact, 본문 없는 HEAD).
  //    그 뒤에 새로 들어오는 줄은 세지 않아 백업 도중의 수집 때문에 어긋나지 않는다.
  let maxCreatedAt = rows[0].created_at;
  for (const row of rows) maxCreatedAt = laterCreatedAt(maxCreatedAt, row.created_at);
  const head = await restRequest(client, `${table}?select=id&created_at=lte.${encodeURIComponent(maxCreatedAt)}`, { method: "HEAD", count: true });
  if (head.total !== rows.length) return { fallbackReason: `count_mismatch:merged=${rows.length},server=${head.total}`, stats };
  return { table, rows, total: head.total, stats };
}

export function pruneOldBackups(outDir, keep) {
  if (!fs.existsSync(outDir)) return [];
  const folders = fs.readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BACKUP_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const remove = folders.slice(0, Math.max(0, folders.length - keep));
  for (const name of remove) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  return remove;
}

function formatMb(bytes) {
  return `${(bytes / 1e6).toFixed(2)}MB`;
}

export async function runExport({
  baseUrl,
  key,
  outDir,
  tables = DEFAULT_TABLES,
  keep = 14,
  fetchImpl = fetch,
  nowMs = Date.now(),
  log = console.log,
  full = false,
  incrementalTables = INCREMENTAL_TABLES,
  pageSize = PAGE_SIZE,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  sleep = defaultSleep,
}) {
  const folderName = backupFolderName(new Date(nowMs));
  const folder = path.join(outDir, folderName);
  fs.mkdirSync(folder, { recursive: true });
  const projectRef = projectRefOf(baseUrl);
  const manifest = { startedAt: new Date(nowMs).toISOString(), baseUrl: projectRef, tables: {}, errors: [] };
  const client = createRestClient({ baseUrl, key, fetchImpl, timeoutMs, retryDelaysMs, sleep, log });
  for (const table of tables) {
    const started = Date.now();
    const before = { requests: client.requests, bytes: client.bytes };
    const usage = () => ({ bytes: client.bytes - before.bytes, requests: client.requests - before.requests });
    let method = "full";
    const detail = {};
    try {
      let result = null;
      if (!full && incrementalTables.includes(table)) {
        const base = findIncrementalBase(outDir, table, { excludeFolder: folderName, projectRef });
        if (base) {
          detail.base = base.folder;
          let incremental;
          try {
            incremental = await exportTableIncremental({ client, table, base, pageSize });
          } catch (error) {
            // 서버가 증분 요청(HEAD·필터·정렬)을 거절하면 매일 같은 실패가 반복되지 않게 그 표만 통째로 받는다.
            // 연결 끊김 같은 네트워크 오류(status 없음)는 통째로 받아도 실패하므로 그대로 실패로 남긴다.
            if (!(error && Number.isInteger(error.status))) throw error;
            incremental = { fallbackReason: `incremental_http_${error.status}` };
          }
          Object.assign(detail, incremental.stats);
          if (incremental.rows) {
            result = incremental;
            method = "incremental";
          } else {
            method = "fallback";
            detail.fallbackReason = incremental.fallbackReason;
            log(`${table}: 증분 검증 실패(${incremental.fallbackReason}) → 통째로 다시 받음`);
          }
        }
      }
      if (!result) result = await exportTable({ table, client, nowMs, pageSize });
      const body = JSON.stringify(result.rows);
      fs.writeFileSync(path.join(folder, `${table}.json.gz`), zlib.gzipSync(Buffer.from(body, "utf8")));
      const used = usage();
      manifest.tables[table] = { rows: result.rows.length, reportedTotal: result.total, ms: Date.now() - started, method, ...used, ...detail };
      log(`${table}: ${result.rows.length} rows (${method}, ${formatMb(used.bytes)})`);
    } catch (error) {
      manifest.tables[table] = { rows: null, error: String(error && error.message || error), ms: Date.now() - started, method, ...usage(), ...detail };
      manifest.errors.push(`${table}: ${String(error && error.message || error)}`);
      log(`${table}: FAILED ${String(error && error.message || error)}`);
    }
  }
  manifest.totalBytes = client.bytes;
  manifest.totalRequests = client.requests;
  manifest.finishedAt = new Date().toISOString();
  manifest.pruned = pruneOldBackups(outDir, keep);
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`받은 양 ${formatMb(client.bytes)} · 요청 ${client.requests}회`);
  return { folder, manifest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error("사용: node scripts/db-export.mjs --out <백업 폴더> [--keep 14] [--env <env 파일>] [--full]");
    process.exit(2);
  }
  const fileEnv = fs.existsSync(args.env) ? parseEnvFile(fs.readFileSync(args.env, "utf8")) : {};
  const env = { ...fileEnv, ...process.env };
  const baseUrl = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!baseUrl || !key) {
    console.error(`SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없습니다. ${args.env} 파일(chmod 600)에 넣어주세요.`);
    process.exit(2);
  }
  const tables = String(env.MI_DB_EXPORT_TABLES || "").split(",").map((value) => value.trim()).filter(Boolean);
  const { folder, manifest } = await runExport({
    baseUrl,
    key,
    outDir: path.resolve(args.out),
    tables: tables.length ? tables : DEFAULT_TABLES,
    keep: args.keep,
    full: args.full,
  });
  console.log(`백업 폴더: ${folder}`);
  if (manifest.errors.length) {
    console.error(`실패 ${manifest.errors.length}건: ${manifest.errors.join(" | ")}`);
    process.exit(1);
  }
}

// 경로에 한글이 있으면 URL pathname 은 퍼센트 인코딩이라 fileURLToPath 로 비교한다.
const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(String(error && error.stack || error));
    process.exit(1);
  });
}
