// C 30일 순위(쿠팡) 연결 영구 검사(명세 §7.3, 대표 승인 2026-10-16 D1).
// 서버 고도화로 index.mjs·session-gate.mjs 가 앞으로 바뀌어도 깨지지 않도록 "C 줄이 있는지"와 C 모듈 경계(§2.1)만 본다.
// '추가 줄만'인지는 이 테스트가 아니라 출시 관문 G3 에서 한 번만 확인한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COUPANG_TRACKERS_PATH, COUPANG_WORKER_PATH } from "../src/server/coupang-rank/contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_INDEX = "src/server/index.mjs";
const SESSION_GATE = "src/server/session-gate.mjs";
const C_MODULE_DIR = "src/server/coupang-rank";
const HANDLER_DIR = "src/server/handlers";
const TRACKERS_HANDLER = `${HANDLER_DIR}/coupang-rank-trackers.mjs`;
const WORKER_HANDLER = `${HANDLER_DIR}/coupang-rank-worker.mjs`;

// §2.1 서버 층 허용 바깥 의존. 그 밖의 서버 모듈(naver-*·rank-*·local-worker-auth·session-gate·code-session 등)은 금지.
const ALLOWED_PACKAGES = new Set(["@supabase/server", "node:crypto"]);
const ALLOWED_SERVER_MODULES = new Set([
  "src/server/security.mjs", // protectedJson·safeEqual
  "src/server/owner-identity.mjs", // PRIMARY_AGENCY_CODE
  "src/server/runtime.mjs", // requestIdFor
]);
const C_HANDLERS = new Set([TRACKERS_HANDLER, WORKER_HANDLER]);

function absolute(file) {
  return path.join(ROOT, file);
}

function exists(file) {
  return fs.existsSync(absolute(file));
}

function read(file) {
  return fs.readFileSync(absolute(file), "utf8").replace(/\r\n/g, "\n");
}

function toRepoPath(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function isTestFile(file) {
  return file.endsWith(".test.mjs");
}

function setBlock(source, name) {
  return source.match(new RegExp(`const ${name} = new Set\\(\\[[\\s\\S]*?\\]\\);`))?.[0] || "";
}

// 서버 쪽 C 파일: src/server/coupang-rank/*.mjs 전부와 handlers/coupang-rank*.mjs 전부(테스트 포함).
function cServerFiles() {
  const moduleFiles = fs.readdirSync(absolute(C_MODULE_DIR))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => `${C_MODULE_DIR}/${name}`);
  const handlerFiles = fs.readdirSync(absolute(HANDLER_DIR))
    .filter((name) => name.startsWith("coupang-rank") && name.endsWith(".mjs"))
    .map((name) => `${HANDLER_DIR}/${name}`);
  return [...moduleFiles, ...handlerFiles].sort();
}

// 줄 맨 앞의 정적 import·re-export 와 코드 안의 동적 import() 를 모은다. 동적 import 의 인자가 문자열 하나가
// 아니면 specifier 를 null 로 남겨 실패시킨다(검사를 피해 가는 경로를 막는다).
function importSpecifiers(source) {
  const found = [];
  const staticImport = /^[ \t]*import\s+(?:[^;"'`]*?\s+from\s+)?["']([^"']+)["']/gm;
  const reExport = /^[ \t]*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm;
  const dynamicImport = /\bimport\s*\(\s*([^)]*?)\s*\)/g;
  for (const match of source.matchAll(staticImport)) found.push({ kind: "import", specifier: match[1] });
  for (const match of source.matchAll(reExport)) found.push({ kind: "export-from", specifier: match[1] });
  for (const match of source.matchAll(dynamicImport)) {
    const literal = /^["']([^"']+)["']$/.exec(match[1]);
    found.push({ kind: "dynamic-import", specifier: literal ? literal[1] : null, raw: match[0] });
  }
  if (/\bcreateRequire\b/.test(source)) found.push({ kind: "createRequire", specifier: null, raw: "createRequire" });
  return found;
}

function resolveRelative(fromFile, specifier) {
  return toRepoPath(path.resolve(path.dirname(absolute(fromFile)), specifier));
}

function isCModule(repoPath) {
  return repoPath.startsWith(`${C_MODULE_DIR}/`)
    && !repoPath.slice(C_MODULE_DIR.length + 1).includes("/")
    && repoPath.endsWith(".mjs");
}

// 운영 코드: 허용 바깥 의존 + C 내부 상대 경로(./*.mjs, ../coupang-rank/*.mjs)만. 테스트 파일은 여기에 node:* 내장 모듈과
// 시험 대상인 C 핸들러·C 모듈 테스트 대상만 더 연다. 테스트도 다른 서버 모듈을 import 하지 않는다(N30 MockQuery 는 복사해서 쓴다).
function importViolation(fromFile, entry) {
  if (entry.specifier === null) return `${entry.kind} 인자가 문자열 하나가 아님: ${entry.raw}`;
  const specifier = entry.specifier;
  const test = isTestFile(fromFile);
  if (!specifier.startsWith(".")) {
    if (ALLOWED_PACKAGES.has(specifier)) return "";
    if (test && specifier.startsWith("node:")) return "";
    return `허용되지 않은 패키지·모듈: ${specifier}`;
  }
  const target = resolveRelative(fromFile, specifier);
  if (ALLOWED_SERVER_MODULES.has(target)) return "";
  if (isCModule(target) && (test || !isTestFile(target))) return "";
  if (test && C_HANDLERS.has(target)) return "";
  return `허용되지 않은 상대 import: ${specifier} → ${target}`;
}

test("index: C 로더 두 줄과 dispatch 두 줄이 있고, dispatch 는 세션 게이트 뒤 routeRequest 안에 있다", () => {
  const index = read(SERVER_INDEX);
  assert.equal(COUPANG_TRACKERS_PATH, "/api/coupang-rank-trackers");
  assert.equal(COUPANG_WORKER_PATH, "/api/coupang-rank-worker");

  assert.match(index, /^[ \t]*coupangRankTrackers: \(\) => import\("\.\/handlers\/coupang-rank-trackers\.mjs"\),$/m);
  assert.match(index, /^[ \t]*coupangRankWorker: \(\) => import\("\.\/handlers\/coupang-rank-worker\.mjs"\),$/m);

  const trackersDispatch = /if \(url\.pathname === "\/api\/coupang-rank-trackers"\) \{\s*return dispatch\("coupangRankTrackers", request\);\s*\}/.exec(index);
  const workerDispatch = /if \(url\.pathname === "\/api\/coupang-rank-worker"\) \{\s*return dispatch\("coupangRankWorker", request\);\s*\}/.exec(index);
  assert.ok(trackersDispatch, "화면 API dispatch 줄");
  assert.ok(workerDispatch, "수집기 API dispatch 줄");

  // OPTIONS 는 routeRequest 첫 분기가 먼저 204 로 답하고(M2), 수집기 API 도 fetch 의 boundedApiRequest →
  // authorizeCodeSession(세션 없는 경로라 그대로 통과) → routeRequest 순서를 그대로 탄다. N30 워커 선처리 분기에는 C 가 없다.
  const routeStart = index.indexOf("async function routeRequest(request)");
  const optionsBranch = index.indexOf('if (request.method === "OPTIONS")', routeStart);
  const exportStart = index.indexOf("export default {");
  assert.ok(routeStart >= 0 && optionsBranch > routeStart && exportStart > optionsBranch, "routeRequest·OPTIONS 분기·export default 위치");
  for (const match of [trackersDispatch, workerDispatch]) {
    assert.ok(match.index > optionsBranch && match.index < exportStart, `routeRequest 안: ${match[0].split("\n")[0]}`);
  }
  assert.equal(/coupang/i.test(index.slice(exportStart)), false, "fetch 선처리 분기에 C 경로가 없음");
  assert.equal((index.match(/dispatch\("coupangRank(?:Trackers|Worker)"/g) || []).length, 2, "C dispatch 는 정확히 두 줄");
});

test("session-gate: 세 묶음에 C 경로가 있고, 체험·개인·코드 전용 묶음에는 없다", () => {
  const gate = read(SESSION_GATE);
  const sessionFree = setBlock(gate, "SESSION_FREE_PATHS");
  const teamRank = setBlock(gate, "TEAM_ACCOUNT_ONLY_RANK_PATHS");
  const teamTool = setBlock(gate, "TEAM_ACCOUNT_ONLY_TOOL_PATHS");
  const planExpiredGet = setBlock(gate, "PLAN_EXPIRED_GET_PATHS");
  for (const [name, block] of Object.entries({ sessionFree, teamRank, teamTool, planExpiredGet })) {
    assert.notEqual(block, "", `${name} 묶음을 찾지 못함`);
  }

  assert.ok(sessionFree.includes(`"${COUPANG_WORKER_PATH}"`), "SESSION_FREE_PATHS 에 수집기 API");
  assert.ok(teamRank.includes(`"${COUPANG_TRACKERS_PATH}"`), "TEAM_ACCOUNT_ONLY_RANK_PATHS 에 화면 API");
  assert.ok(planExpiredGet.includes(`"${COUPANG_TRACKERS_PATH}"`), "PLAN_EXPIRED_GET_PATHS 에 화면 API(D4)");
  // 미연결 팀 코드 주입은 TEAM_ACCOUNT_ONLY_RANK_PATHS 로, 범위 허용은 TOOL_PATHS 의 펼침으로 자동 포함된다.
  assert.ok(teamTool.includes("...TEAM_ACCOUNT_ONLY_RANK_PATHS"), "TEAM_ACCOUNT_ONLY_TOOL_PATHS 가 RANK_PATHS 를 펼침");

  // 경로가 서로 섞이지 않는다: 화면 API 는 세션 경로, 수집기 API 는 세션 없는 경로.
  assert.equal(sessionFree.includes(`"${COUPANG_TRACKERS_PATH}"`), false, "화면 API 는 세션 없는 경로가 아님");
  assert.equal(teamRank.includes(`"${COUPANG_WORKER_PATH}"`), false);
  assert.equal(planExpiredGet.includes(`"${COUPANG_WORKER_PATH}"`), false);

  // §7.2 넣지 않는 곳: 체험(TRIAL_LOCKED 유지)·체험 예시·개인 경로·코드 세션 전용 광고주 경로·만료 쓰기 허용.
  for (const name of ["TRIAL_ALLOWED_PATHS", "TRIAL_SAMPLE_TRACKER_PATHS", "ACCOUNT_ONLY_PERSONAL_PATHS", "CODE_SESSION_ONLY_CLIENT_PATHS", "PLAN_EXPIRED_WRITE_PATHS"]) {
    const block = setBlock(gate, name);
    assert.notEqual(block, "", `${name} 묶음을 찾지 못함`);
    assert.equal(block.includes('"/api/coupang-rank-'), false, `${name} 에 C 경로가 없어야 함`);
  }
});

test("C 서버 파일의 import 는 §2.1 허용 목록(바깥 의존 + C 내부 상대 경로)뿐이다", () => {
  for (const handler of C_HANDLERS) assert.ok(exists(handler), `핸들러 파일이 있어야 함: ${handler}`);
  const files = cServerFiles();
  assert.ok(files.includes(`${C_MODULE_DIR}/contract.mjs`), "C 계약 모듈");
  const violations = [];
  for (const file of files) {
    for (const entry of importSpecifiers(read(file))) {
      const problem = importViolation(file, entry);
      if (problem) violations.push(`${file}: ${problem}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("검사기 자체 확인: 금지 import 를 실제로 잡는다", () => {
  const sample = [
    'import { protectedJson } from "../security.mjs";',
    'import { contract } from "./contract.mjs";',
    'import { verifiedSession } from "../session-gate.mjs";',
    'import {',
    '  naverThing,',
    '} from "../naver-shopping/local-worker-contract.mjs";',
    'export * from "../rank-tracker-account-suspension.mjs";',
    'const lazy = await import("../code-session.mjs");',
    'const hidden = await import(name);',
    'import fs from "node:fs";',
  ].join("\n");
  const problems = importSpecifiers(sample)
    .map((entry) => importViolation(`${C_MODULE_DIR}/sample.mjs`, entry))
    .filter(Boolean);
  assert.equal(problems.length, 6, problems.join("\n"));
  assert.equal(importViolation(`${C_MODULE_DIR}/sample.test.mjs`, { kind: "import", specifier: "node:fs" }), "");
  assert.equal(importViolation(`${HANDLER_DIR}/coupang-rank-worker.test.mjs`, { kind: "import", specifier: "./coupang-rank-worker.mjs" }), "");
  assert.notEqual(importViolation(`${HANDLER_DIR}/coupang-rank-worker.mjs`, { kind: "import", specifier: "./naver-rank-trackers.mjs" }), "");
  assert.equal(importViolation(`${HANDLER_DIR}/coupang-rank-worker.mjs`, { kind: "import", specifier: "../coupang-rank/db.mjs" }), "");
});

// §2.3-2·§6.2: 게이트가 이 경로의 머리글을 지우지 않으므로 수집기 쪽 코드는 x-mi-session·x-mi-agency·x-mi-rank 를 읽지 않는다.
// 핸들러 원문과, 핸들러가 import 하는 C 모듈(전이 포함)까지 본다. 허용 머리글은 authorization 과 x-mi-coupang-collector 뿐이다.
test("수집기 핸들러와 그 C 의존 모듈에 x-mi-session·x-mi-agency·x-mi-rank 가 0개다", () => {
  const pattern = /x-mi-(?:session|agency|rank)/gi;
  const workerSource = read(WORKER_HANDLER);
  assert.deepEqual(workerSource.match(pattern) || [], [], WORKER_HANDLER);

  const seen = new Set();
  const queue = [WORKER_HANDLER];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const entry of importSpecifiers(read(file))) {
      if (!entry.specifier?.startsWith(".")) continue;
      const target = resolveRelative(file, entry.specifier);
      if (isCModule(target) && exists(target)) queue.push(target);
    }
  }
  for (const file of seen) {
    assert.deepEqual(read(file).match(pattern) || [], [], file);
  }
});

test("C 서버 파일에 naver_ 가 0개이고, 두 핸들러는 withSupabase({ auth: \"none\", cors: false })를 쓴다", () => {
  const productionFiles = cServerFiles().filter((file) => !isTestFile(file));
  for (const file of productionFiles) {
    assert.equal(read(file).includes("naver_"), false, `${file} 에 naver_ 가 있음`);
  }
  for (const handler of C_HANDLERS) {
    const source = read(handler);
    assert.match(source, /withSupabase\(\s*\{[^}]*\bauth:\s*"none"[^}]*\}/, `${handler} auth none`);
    assert.match(source, /withSupabase\(\s*\{[^}]*\bcors:\s*false\b[^}]*\}/, `${handler} cors: false`);
  }
});

// §2.3-3·4: 새 Vercel 함수 파일·크론을 만들지 않고, /ready·N30 상태 집계·만료 크론·계정 해지 모듈은 C 를 모른다.
test("C 는 새 Vercel 함수·크론을 만들지 않고, /ready·상태 집계·만료 크론·해지 모듈에 C 이름이 없다", () => {
  const apiFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(absolute(dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else apiFiles.push(child);
    }
  };
  walk("api");
  assert.deepEqual(apiFiles.filter((file) => /coupang/i.test(file)), []);
  const vercel = JSON.parse(read("vercel.json"));
  assert.deepEqual((vercel.crons || []).filter((cron) => /coupang/i.test(JSON.stringify(cron))), []);

  for (const file of [
    `${HANDLER_DIR}/ready.mjs`,
    `${HANDLER_DIR}/rank-collection-health.mjs`,
    `${HANDLER_DIR}/account-expiry-cron.mjs`,
    "src/server/rank-tracker-account-suspension.mjs",
  ]) {
    assert.equal(/coupang/i.test(read(file)), false, `${file} 에 C 이름이 있음`);
  }
});
