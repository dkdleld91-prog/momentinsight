import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_PATH = "scripts/protected-rank-features.lock.json";
const RANK_MIGRATION_PATTERN = /naver_(?:place_)?rank_(?:trackers|snapshots)|claim_due_naver_(?:place_)?rank_tracker/i;

function read(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function functionBlock(source, name) {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`함수 잠금 대상을 찾을 수 없습니다: ${name}`);
  const open = source.indexOf("{", match.index);
  if (open < 0) throw new Error(`함수 본문을 찾을 수 없습니다: ${name}`);
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
  throw new Error(`함수 끝을 찾을 수 없습니다: ${name}`);
}

function currentLock(lock) {
  return {
    ...lock,
    functions: lock.functions.map((entry) => ({
      ...entry,
      sha256: sha256(functionBlock(read(entry.file), entry.name)),
    })),
    files: lock.files.map((entry) => ({
      ...entry,
      sha256: sha256(read(entry.file)),
    })),
  };
}

function rankMigrationFiles() {
  const directory = "supabase/migrations";
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => path.posix.join(directory, name))
    .filter((file) => RANK_MIGRATION_PATTERN.test(read(file)))
    .sort();
}

function collectFailures(expected, actual, discoveredMigrations) {
  const failures = [];
  for (const entry of actual.functions) {
    const expectedHash = expected.functions.find((candidate) => candidate.id === entry.id)?.sha256;
    if (expectedHash !== entry.sha256) failures.push(`${entry.id}: 보호 함수가 변경되었습니다 (${entry.file}#${entry.name})`);
  }
  for (const entry of actual.files) {
    const expectedHash = expected.files.find((candidate) => candidate.id === entry.id)?.sha256;
    if (expectedHash !== entry.sha256) failures.push(`${entry.id}: 보호 파일이 변경되었습니다 (${entry.file})`);
  }

  const lockedMigrations = expected.files
    .filter((entry) => entry.rankMigration)
    .map((entry) => entry.file)
    .sort();
  const unlockedMigrations = discoveredMigrations.filter((file) => !lockedMigrations.includes(file));
  const missingMigrations = lockedMigrations.filter((file) => !discoveredMigrations.includes(file));
  if (unlockedMigrations.length) failures.push(`잠금되지 않은 순위 마이그레이션이 추가되었습니다: ${unlockedMigrations.join(", ")}`);
  if (missingMigrations.length) failures.push(`잠금된 순위 마이그레이션을 찾을 수 없습니다: ${missingMigrations.join(", ")}`);
  return failures;
}

const lock = JSON.parse(read(LOCK_PATH));
const current = currentLock(lock);
const discoveredMigrations = rankMigrationFiles();

if (process.argv.includes("--print-current")) {
  process.stdout.write(JSON.stringify(current, null, 2) + "\n");
  process.exit(0);
}

if (process.argv.includes("--self-test")) {
  const selfTestErrors = [];
  current.functions.forEach((entry, index) => {
    const altered = JSON.parse(JSON.stringify(current));
    altered.functions[index].sha256 = sha256(`${entry.sha256}:intentional-function-lock-test`);
    const failures = collectFailures(lock, altered, discoveredMigrations);
    if (!failures.some((failure) => failure.startsWith(`${entry.id}:`))) {
      selfTestErrors.push(`보호 함수 변조를 차단하지 못했습니다: ${entry.id}`);
    }
  });
  current.files.forEach((entry, index) => {
    const altered = JSON.parse(JSON.stringify(current));
    altered.files[index].sha256 = sha256(`${entry.sha256}:intentional-file-lock-test`);
    const failures = collectFailures(lock, altered, discoveredMigrations);
    if (!failures.some((failure) => failure.startsWith(`${entry.id}:`))) {
      selfTestErrors.push(`보호 파일 변조를 차단하지 못했습니다: ${entry.id}`);
    }
  });
  const syntheticMigration = "supabase/migrations/29999999999999_naver_rank_trackers_lock_self_test.sql";
  const migrationFailures = collectFailures(lock, current, [...discoveredMigrations, syntheticMigration].sort());
  if (!migrationFailures.some((failure) => failure.includes(syntheticMigration))) {
    selfTestErrors.push("새 순위 마이그레이션 자동 탐지를 확인하지 못했습니다.");
  }
  if (selfTestErrors.length) {
    console.error("Protected core feature lock self-test failed");
    selfTestErrors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log(`Protected core feature lock self-test passed: ${current.functions.length} functions, ${current.files.length} files, migration discovery`);
  process.exit(0);
}

const failures = collectFailures(lock, current, discoveredMigrations);

if (failures.length) {
  console.error("키워드 조회·N 상품 순위·N 30일·N 플레이스 30일 핵심 기능 잠금이 변경을 차단했습니다.");
  failures.forEach((failure) => console.error(`- ${failure}`));
  console.error("대표님의 명시적 변경 승인 후 대상 테스트와 전체 check:release를 통과한 경우에만 잠금 기준을 갱신하세요.");
  process.exit(1);
}

console.log(`Protected core feature lock passed: ${current.functions.length} functions, ${current.files.length} files, ${discoveredMigrations.length} migrations`);
