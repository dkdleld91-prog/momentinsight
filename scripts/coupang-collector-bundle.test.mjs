// C 30일 순위(쿠팡) 수집기 묶음 테스트(명세 §9.7·§9.9). 임시 dist 에 묶음을 만들어 본다. 셸·PowerShell 은 실행하지 않는다
// (맥 설치기 안의 node 풀기 스크립트만 node 로 돌려 sha256·release 검증이 만드는 쪽과 맞는지 본다).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_MAX_BYTES, UNKNOWN_RELEASE, buildCoupangCollectorBundle, resolveRelease, sha256Utf8,
} from "./build-coupang-collector-bundle.mjs";
import { COLLECTOR_VERSION } from "../tools/coupang-rank-collector/lib/contract.mjs";
import { COLLECTOR_BUNDLE_VERSION, UNKNOWN_RELEASE as SERVER_UNKNOWN_RELEASE } from "../src/server/coupang-rank/contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectorRoot = path.join(repoRoot, "tools", "coupang-rank-collector");

// check-public-build-security.mjs 와 같은 비밀 패턴 + 연결 코드 원문 모양
const SECRET_PATTERNS = [
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential token prefix", /\b(?:ghp|github_pat|glpat|sk_live|sk_test|sb_secret|sbp)_[A-Za-z0-9_-]{16,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["server secret assignment", /\b(?:SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|MI_SUPER_ADMIN_CODE|MI_RANK_CRON_SECRET|CRON_SECRET|NAVER_SEARCHAD_SECRET_KEY|NAVER_OPENAPI_CLIENT_SECRET|NAVER_DATALAB_CLIENT_SECRET|NAVER_API_HUB_CLIENT_SECRET|NAVER_API_HUB_API_KEY)\s*[:=]\s*["']?[^\s"'<>]{8,}/],
  ["source map reference", /sourceMappingURL\s*=/],
  ["embedded source map content", /["']sourcesContent["']\s*:/],
  ["collector connection code", /\bmic1_[A-Za-z0-9_-]{43}\b/],
  ["supabase jwt", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
];

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function expectedPaths() {
  const libs = fs.readdirSync(path.join(collectorRoot, "lib")).filter((name) => name.endsWith(".mjs")).map((name) => `lib/${name}`);
  return [...libs, "worker.mjs", "trial.mjs", "run-worker.ps1", "run-worker.sh", "collector.plist.template"].sort();
}

const SOURCE_OF = {
  "run-worker.ps1": "platform/windows/run-worker.ps1",
  "run-worker.sh": "platform/macos/run-worker.sh",
  "collector.plist.template": "platform/macos/collector.plist.template",
};

test("묶음 만들기: 파일 목록·sha256(UTF-8 바이트)·원문·version·release·512KB", async () => {
  const outDir = tempDir("mi-coupang-bundle-");
  try {
    const result = await buildCoupangCollectorBundle({ outDir, env: { VERCEL_GIT_COMMIT_SHA: "abc1234def5678900000000000000000000000ff" } });
    assert.equal(result.release, "abc1234");
    assert.equal(result.version, COLLECTOR_VERSION);
    assert.equal(COLLECTOR_VERSION, COLLECTOR_BUNDLE_VERSION, "수집기 COLLECTOR_VERSION = 서버 COLLECTOR_BUNDLE_VERSION");
    const text = fs.readFileSync(path.join(outDir, "bundle.json"), "utf8");
    assert.ok(Buffer.byteLength(text) <= BUNDLE_MAX_BYTES);
    assert.equal(result.bytes, Buffer.byteLength(text));
    const bundle = JSON.parse(text);
    assert.deepEqual(Object.keys(bundle), ["schema", "release", "version", "files"]);
    assert.equal(bundle.schema, 1);
    assert.equal(bundle.release, "abc1234");
    assert.equal(bundle.version, COLLECTOR_VERSION);
    assert.deepEqual(bundle.files.map((file) => file.path), expectedPaths());
    for (const file of bundle.files) {
      assert.deepEqual(Object.keys(file), ["path", "sha256", "content"]);
      const source = fs.readFileSync(path.join(collectorRoot, SOURCE_OF[file.path] || file.path));
      assert.equal(file.content, source.toString("utf8"), file.path);
      assert.equal(file.sha256, createHash("sha256").update(source).digest("hex"), file.path);
      assert.equal(file.sha256, sha256Utf8(file.content));
    }
    assert.ok(!bundle.files.some((file) => /install-|test\//.test(file.path)), "설치기·테스트는 묶음에 넣지 않는다");
    for (const name of ["install-windows.ps1", "install-macos.sh"]) {
      const source = name.endsWith(".ps1") ? "platform/windows/install-windows.ps1" : "platform/macos/install-macos.sh";
      assert.deepEqual(fs.readFileSync(path.join(outDir, name)), fs.readFileSync(path.join(collectorRoot, source)), name);
    }
    assert.deepEqual(fs.readdirSync(outDir).sort(), ["bundle.json", "install-macos.sh", "install-windows.ps1"]);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("release: VERCEL sha 앞 7자 → 없으면 git → 그래도 아니면 0000000", () => {
  assert.equal(UNKNOWN_RELEASE, SERVER_UNKNOWN_RELEASE);
  assert.equal(resolveRelease({ env: { VERCEL_GIT_COMMIT_SHA: "0123abcdef" }, gitRelease: () => "fffffff" }), "0123abc");
  assert.equal(resolveRelease({ env: { VERCEL_GIT_COMMIT_SHA: "ZZZZZZZZZZ" }, gitRelease: () => "fffffff" }), "0000000");
  assert.equal(resolveRelease({ env: { VERCEL_GIT_COMMIT_SHA: "ABC1234DEF" } }), "0000000", "대문자는 맞추지 않는다(서버와 같은 규칙)");
  assert.equal(resolveRelease({ env: {}, gitRelease: () => "1234abc\n" }), "1234abc");
  assert.equal(resolveRelease({ env: {}, gitRelease: () => "" }), "0000000");
  assert.equal(resolveRelease({ env: {}, gitRelease: () => "12ab" }), "0000000");
  assert.equal(resolveRelease({ env: { VERCEL_GIT_COMMIT_SHA: "" }, gitRelease: () => "abcdef0" }), "abcdef0");
});

test("release 0000000 대체: git 이 없는 빌드에서도 묶음이 만들어진다", async () => {
  const outDir = tempDir("mi-coupang-bundle-");
  try {
    const result = await buildCoupangCollectorBundle({ outDir, env: {}, gitRelease: () => "" });
    assert.equal(result.release, "0000000");
    assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, "bundle.json"), "utf8")).release, "0000000");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("public/ 에 .mjs 없음, 수집기 코드는 public 에 두지 않는다", () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.mjs$/i.test(entry.name) || /coupang-collector/i.test(path.relative(repoRoot, absolute))) found.push(path.relative(repoRoot, absolute));
    }
  };
  walk(path.join(repoRoot, "public"));
  assert.deepEqual(found, []);
});

test("묶음·두 설치기에 비밀 패턴 0개", async () => {
  const outDir = tempDir("mi-coupang-bundle-");
  try {
    await buildCoupangCollectorBundle({ outDir, env: { VERCEL_GIT_COMMIT_SHA: "abc1234" } });
    for (const name of ["bundle.json", "install-windows.ps1", "install-macos.sh"]) {
      const text = fs.readFileSync(path.join(outDir, name), "utf8");
      for (const [label, pattern] of SECRET_PATTERNS) assert.doesNotMatch(text, pattern, `${name}: ${label}`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

function macUnpackScript() {
  const installer = fs.readFileSync(path.join(collectorRoot, "platform", "macos", "install-macos.sh"), "utf8");
  const match = installer.match(/\nUNPACK_JS='\n([\s\S]*?)\n'\n/);
  assert.ok(match, "맥 설치기의 UNPACK_JS");
  return match[1];
}

test("맥 설치기의 풀기 스크립트가 만든 묶음을 그대로 풀고, sha256·release 가 다르면 거절한다", async () => {
  const outDir = tempDir("mi-coupang-bundle-");
  const work = tempDir("mi-coupang-unpack-");
  try {
    await buildCoupangCollectorBundle({ outDir, env: { VERCEL_GIT_COMMIT_SHA: "abc1234" } });
    const script = macUnpackScript();
    const bundleFile = path.join(outDir, "bundle.json");
    const appNew = path.join(work, "app.new");
    const ok = spawnSync(process.execPath, ["-e", script, bundleFile, appNew, "abc1234"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), `version=${COLLECTOR_VERSION}`);
    for (const relative of expectedPaths()) {
      assert.deepEqual(fs.readFileSync(path.join(appNew, relative)), fs.readFileSync(path.join(collectorRoot, SOURCE_OF[relative] || relative)), relative);
    }
    assert.equal(fs.readFileSync(path.join(appNew, "VERSION"), "utf8"), `${COLLECTOR_VERSION} abc1234\n`);
    // 풀린 worker.mjs 는 문법이 맞다.
    execFileSync(process.execPath, ["--check", path.join(appNew, "worker.mjs")]);

    const wrongRelease = spawnSync(process.execPath, ["-e", script, bundleFile, appNew, "1111111"], { encoding: "utf8" });
    assert.equal(wrongRelease.status, 1);
    assert.equal(wrongRelease.stdout.trim(), "error=release_mismatch");

    const tampered = JSON.parse(fs.readFileSync(bundleFile, "utf8"));
    tampered.files[0].content += "\n// changed";
    const tamperedFile = path.join(work, "tampered.json");
    fs.writeFileSync(tamperedFile, JSON.stringify(tampered));
    const bad = spawnSync(process.execPath, ["-e", script, tamperedFile, appNew, "abc1234"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout.trim(), "error=bundle_hash_mismatch");

    const escape = JSON.parse(fs.readFileSync(bundleFile, "utf8"));
    escape.files[0].path = "../evil.mjs";
    const escapeFile = path.join(work, "escape.json");
    fs.writeFileSync(escapeFile, JSON.stringify(escape));
    const escaped = spawnSync(process.execPath, ["-e", script, escapeFile, appNew, "abc1234"], { encoding: "utf8" });
    assert.equal(escaped.stdout.trim(), "error=bundle_invalid");
    assert.equal(fs.existsSync(path.join(work, "evil.mjs")), false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("윈도우 설치기도 같은 기준으로 검증한다(UTF-8 바이트 sha256·release 대조·경로 검사) — 정적 확인", () => {
  const installer = fs.readFileSync(path.join(collectorRoot, "platform", "windows", "install-windows.ps1"), "utf8");
  for (const needle of [
    "[System.Text.Encoding]::UTF8.GetBytes([string]$f.content)", "$sha.ComputeHash($bytes)", "$_.ToString('x2')",
    "if ($hash -cne [string]$f.sha256) { Stop-Install 'bundle_hash_mismatch' }", "if ([string]$bundle.release -cne $Release) { Stop-Install 'release_mismatch' }",
    "$relative -cnotmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$' -or $relative.Contains('..')", "[System.IO.File]::WriteAllBytes($target, $bytes)",
  ]) {
    assert.ok(installer.includes(needle), needle);
  }
});

test("만드는 쪽 안전장치: .ps1 에 ASCII 가 아닌 글자가 있으면 묶음을 만들지 않는다", async () => {
  const fakeRepo = tempDir("mi-coupang-repo-");
  const outDir = tempDir("mi-coupang-bundle-");
  try {
    fs.cpSync(collectorRoot, path.join(fakeRepo, "tools", "coupang-rank-collector"), { recursive: true });
    const runner = path.join(fakeRepo, "tools", "coupang-rank-collector", "platform", "windows", "run-worker.ps1");
    fs.appendFileSync(runner, "# 한글\n");
    await assert.rejects(buildCoupangCollectorBundle({ repoRoot: fakeRepo, outDir, env: { VERCEL_GIT_COMMIT_SHA: "abc1234" } }), /ASCII only/);
  } finally {
    fs.rmSync(fakeRepo, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
