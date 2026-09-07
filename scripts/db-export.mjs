#!/usr/bin/env node
// 모먼트 인사이트 DB 논리 백업 — 읽기 전용. Supabase REST(PostgREST)를 서비스 키로 읽어 표마다 JSON.gz 로 남긴다.
//
// 왜: 이용 기간 만료 + 유예 5일 뒤 광고주 데이터를 지우는 크론(account-expiry-cron, 매일 03:30·03:40 KST)이 돌고
//     있다. 지우기 전 상태를 매일 새벽에 한 벌 남겨 두면 실수로 만료일을 잘못 잡아도 되돌릴 근거가 있다.
//     pg_dump 가 없는 맥에서도 node 하나로 돌아가게 REST 로 읽는다(쓰기 요청은 한 번도 보내지 않는다).
//
// 사용:
//   node scripts/db-export.mjs --out "$HOME/MomentInsightBackups" [--keep 14] [--env ~/.config/momentinsight/backup.env]
// 환경(파일, chmod 600 — 채팅·저장소에 넣지 않는다):
//   SUPABASE_URL=https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=<service role key>
//   MI_DB_EXPORT_TABLES=clients,naver_rank_trackers,...   (선택 · 기본 목록을 바꿀 때만)
// 결과:
//   <out>/<YYYY-MM-DD_HHmm>/<table>.json.gz + manifest.json(표별 행 수·소요·오류). 오래된 폴더는 --keep 개만 남긴다.
//   표 하나라도 실패하면 exit 1 (launchd 로그에서 바로 보이게).
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
  const args = { out: "", keep: 14, env: path.join(os.homedir(), ".config", "momentinsight", "backup.env") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = String(argv[index + 1] || ""), index += 1;
    else if (arg === "--keep") args.keep = Number(argv[index + 1]), index += 1;
    else if (arg === "--env") args.env = String(argv[index + 1] || ""), index += 1;
  }
  if (!Number.isInteger(args.keep) || args.keep < 1) args.keep = 14;
  return args;
}

export function backupFolderName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// 첫 행의 열 이름으로 정렬 기준을 고른다(id → created_at → 없음). 정렬 없이 넘기면 페이지 사이에 행이 밀릴 수 있다.
function orderParam(firstRow) {
  if (!firstRow || typeof firstRow !== "object") return "";
  if ("id" in firstRow) return "&order=id.asc";
  if ("created_at" in firstRow) return "&order=created_at.asc";
  return "";
}

async function restGet(baseUrl, key, pathWithQuery, rangeFrom, rangeTo, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/rest/v1/${pathWithQuery}`, {
    method: "GET",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      accept: "application/json",
      range: `${rangeFrom}-${rangeTo}`,
      prefer: "count=exact",
    },
  });
  const text = await response.text();
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  const rows = text ? JSON.parse(text) : [];
  const contentRange = response.headers.get("content-range") || "";
  const total = contentRange.includes("/") ? Number(contentRange.split("/")[1]) : NaN;
  return { rows: Array.isArray(rows) ? rows : [], total: Number.isFinite(total) ? total : null };
}

export async function exportTable({ baseUrl, key, table, fetchImpl = fetch, nowMs = Date.now(), pageSize = PAGE_SIZE }) {
  const filters = [];
  if (table === "audit_logs") {
    filters.push(`created_at=gte.${encodeURIComponent(new Date(nowMs - AUDIT_LOG_DAYS * 24 * 60 * 60 * 1000).toISOString())}`);
  }
  const query = ["select=*"].concat(filters).join("&");
  const first = await restGet(baseUrl, key, `${table}?${query}`, 0, pageSize - 1, fetchImpl);
  const order = orderParam(first.rows[0]);
  const rows = order ? [] : first.rows.slice();
  let offset = order ? 0 : first.rows.length;
  // 정렬 기준이 있으면 처음부터 정렬해서 다시 읽는다(첫 페이지도 같은 순서여야 한다).
  for (;;) {
    if (order || offset > 0) {
      if (!order && first.rows.length < pageSize) break;
      const page = await restGet(baseUrl, key, `${table}?${query}${order}`, offset, offset + pageSize - 1, fetchImpl);
      rows.push(...page.rows);
      offset += page.rows.length;
      if (page.rows.length < pageSize) break;
    } else {
      break;
    }
  }
  return { table, rows, total: first.total };
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

export async function runExport({ baseUrl, key, outDir, tables = DEFAULT_TABLES, keep = 14, fetchImpl = fetch, nowMs = Date.now(), log = console.log }) {
  const folder = path.join(outDir, backupFolderName(new Date(nowMs)));
  fs.mkdirSync(folder, { recursive: true });
  const manifest = { startedAt: new Date(nowMs).toISOString(), baseUrl: baseUrl.replace(/^https?:\/\//, "").split(".")[0], tables: {}, errors: [] };
  for (const table of tables) {
    const started = Date.now();
    try {
      const result = await exportTable({ baseUrl, key, table, fetchImpl, nowMs });
      const body = JSON.stringify(result.rows);
      fs.writeFileSync(path.join(folder, `${table}.json.gz`), zlib.gzipSync(Buffer.from(body, "utf8")));
      manifest.tables[table] = { rows: result.rows.length, reportedTotal: result.total, ms: Date.now() - started };
      log(`${table}: ${result.rows.length} rows`);
    } catch (error) {
      manifest.tables[table] = { rows: null, error: String(error && error.message || error), ms: Date.now() - started };
      manifest.errors.push(`${table}: ${String(error && error.message || error)}`);
      log(`${table}: FAILED ${String(error && error.message || error)}`);
    }
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.pruned = pruneOldBackups(outDir, keep);
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { folder, manifest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error("사용: node scripts/db-export.mjs --out <백업 폴더> [--keep 14] [--env <env 파일>]");
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
