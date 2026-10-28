// C 30일 ① '지금 확인' 확장 배포물(zip) 테스트(spec-manual §8·§10.8). 임시 폴더에 만들어 본다(dist 는 건드리지 않는다).
// 지난 결함: 화면은 '확장 내려받기(zip)' 링크를 그리는데 빌드 산출물에 zip 이 없었다 → 빌더·build:vercel 등록·zip 모양을 여기서 막는다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SHIPPED_FILES, ZIP_FOLDER, ZIP_MAX_BYTES, buildCoupangCheckExtension, crc32, extensionIdFromKey, publishedZipPath, storedZip,
} from "./build-coupang-check-extension.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repoRoot, "tools", "coupang-rank-check-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
const ENV = { VERCEL_GIT_COMMIT_SHA: "abc1234def5678900000000000000000000000ff" };
const EXPECTED_NAMES = SHIPPED_FILES.map((rel) => `${ZIP_FOLDER}/${rel}`);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function build(outDir, extra = {}) {
  return buildCoupangCheckExtension({ outDir, env: ENV, ...extra });
}

// zip 을 직접 읽는다(끝 레코드 → 중앙 목록 → 각 로컬 머리). 무압축만 받는다.
function readZip(buffer) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endOffset >= 0, "끝 레코드");
  assert.equal(endOffset, buffer.length - 22, "zip 주석 없음");
  const count = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  assert.equal(centralOffset + centralSize, endOffset);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const entry = {
      madeBy: buffer.readUInt16LE(cursor + 4),
      flags: buffer.readUInt16LE(cursor + 8),
      method: buffer.readUInt16LE(cursor + 10),
      time: buffer.readUInt16LE(cursor + 12),
      date: buffer.readUInt16LE(cursor + 14),
      crc: buffer.readUInt32LE(cursor + 16),
      compressed: buffer.readUInt32LE(cursor + 20),
      size: buffer.readUInt32LE(cursor + 24),
      extraLength: buffer.readUInt16LE(cursor + 30),
      commentLength: buffer.readUInt16LE(cursor + 32),
      externalAttr: buffer.readUInt32LE(cursor + 38),
      localOffset: buffer.readUInt32LE(cursor + 42),
    };
    const nameLength = buffer.readUInt16LE(cursor + 28);
    entry.name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + entry.extraLength + entry.commentLength;
    const local = entry.localOffset;
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt16LE(local + 6), entry.flags);
    assert.equal(buffer.readUInt16LE(local + 8), entry.method);
    assert.equal(buffer.readUInt32LE(local + 14), entry.crc);
    const localName = buffer.readUInt16LE(local + 26);
    const localExtra = buffer.readUInt16LE(local + 28);
    assert.equal(localExtra, 0, "로컬 추가 필드 없음");
    const start = local + 30 + localName;
    entry.data = buffer.subarray(start, start + entry.compressed);
    entries.push(entry);
  }
  return entries;
}

function copyExtension(target) {
  fs.cpSync(extensionRoot, target, { recursive: true });
  return target;
}

test("CRC32 표준값", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("zip: 항목 9개(고정 순서·고정 폴더 mi-coupang-check/)·무압축·1980-01-01·UTF-8 표시·추가 필드 없음·원문 바이트 그대로", () => {
  const outDir = tempDir("mi-coupang-check-build-");
  try {
    const result = build(outDir);
    const zip = fs.readFileSync(result.zipPath);
    const entries = readZip(zip);
    assert.deepEqual(entries.map((entry) => entry.name), EXPECTED_NAMES);
    for (const entry of entries) {
      const source = fs.readFileSync(path.join(extensionRoot, entry.name.slice(ZIP_FOLDER.length + 1)));
      assert.equal(entry.method, 0, entry.name);
      assert.equal(entry.flags, 0x0800, entry.name);
      assert.equal(entry.time, 0);
      assert.equal(entry.date, (1 << 5) | 1);
      assert.equal(entry.extraLength, 0);
      assert.equal(entry.commentLength, 0);
      assert.equal(entry.compressed, entry.size);
      assert.equal(entry.madeBy >> 8, 3, "유닉스(권한 0644)");
      assert.equal(entry.externalAttr >>> 16, 0o100644);
      assert.deepEqual(Buffer.from(entry.data), source, entry.name);
      assert.equal(entry.crc, crc32(source), entry.name);
    }
    assert.ok(zip.length <= ZIP_MAX_BYTES);
    assert.doesNotMatch(zip.toString("latin1"), /PRIVATE KEY/);
    assert.ok(!entries.some((entry) => /README|test\/|\.pem$|\.key$|\.mjs$/.test(entry.name)));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("두 번 만들어도 바이트가 같고(zip·version.json), release 는 version.json 에만 있다", () => {
  const first = tempDir("mi-coupang-check-a-");
  const second = tempDir("mi-coupang-check-b-");
  const other = tempDir("mi-coupang-check-c-");
  try {
    const a = build(first);
    const b = build(second);
    assert.deepEqual(fs.readFileSync(a.zipPath), fs.readFileSync(b.zipPath));
    assert.deepEqual(fs.readFileSync(path.join(first, "version.json")), fs.readFileSync(path.join(second, "version.json")));
    const c = buildCoupangCheckExtension({ outDir: other, env: { VERCEL_GIT_COMMIT_SHA: "ffffffff00000000000000000000000000000000" } });
    assert.deepEqual(fs.readFileSync(c.zipPath), fs.readFileSync(a.zipPath), "release 가 달라도 zip 은 같다");
    assert.equal(c.release, "fffffff");
    assert.deepEqual(fs.readdirSync(first).sort(), [`mi-coupang-check-${manifest.version}.zip`, "version.json"]);
  } finally {
    for (const dir of [first, second, other]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("version.json: 버전·확장 ID(manifest key 로 계산)·폴더·zip 이름·공개 경로·sha256·바이트·release·파일 목록", () => {
  const outDir = tempDir("mi-coupang-check-version-");
  try {
    const result = build(outDir);
    const info = JSON.parse(fs.readFileSync(path.join(outDir, "version.json"), "utf8"));
    const zip = fs.readFileSync(result.zipPath);
    assert.deepEqual(Object.keys(info), ["schema", "version", "extensionId", "folder", "zip", "path", "sha256", "bytes", "release", "files"]);
    assert.equal(info.schema, 1);
    assert.equal(info.version, manifest.version);
    assert.equal(info.extensionId, extensionIdFromKey(manifest.key));
    assert.equal(info.extensionId, "onbmdfamcmbljplkgalameendlmgnjeg");
    assert.match(info.extensionId, /^[a-p]{32}$/);
    assert.equal(info.folder, "mi-coupang-check");
    assert.equal(info.zip, `mi-coupang-check-${manifest.version}.zip`);
    assert.equal(info.path, `/coupang-check/mi-coupang-check-${manifest.version}.zip`);
    assert.equal(info.path, publishedZipPath(manifest.version));
    assert.equal(info.sha256, createHash("sha256").update(zip).digest("hex"));
    assert.equal(info.bytes, zip.length);
    assert.equal(info.release, "abc1234");
    assert.deepEqual(info.files.map((file) => file.path), SHIPPED_FILES);
    for (const file of info.files) {
      const source = fs.readFileSync(path.join(extensionRoot, file.path));
      assert.equal(file.sha256, createHash("sha256").update(source).digest("hex"));
      assert.equal(file.bytes, source.length);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("만드는 쪽 안전장치: 목록 밖 파일·빠진 파일·배포 안 되는 파일 import·key 없음·BOM·비밀키 문자열이면 만들지 않는다", () => {
  const work = tempDir("mi-coupang-check-guard-");
  try {
    const cases = [
      ["extra", (root) => fs.writeFileSync(path.join(root, "lib", "extra.js"), "export const x = 1;\n"), /unexpected files/],
      ["missing", (root) => fs.rmSync(path.join(root, "lib", "assemble.js")), /missing files|unexpected/],
      ["import", (root) => {
        fs.appendFileSync(path.join(root, "lib", "protocol.js"), "\nexport { y } from \"./helper.js\";\n");
      }, /imports lib\/helper\.js/],
      // 아이콘 PNG(1.0.4, Codex 검수 반영): 뒤에 비밀키를 붙인 PNG · 서명뿐인 파일 · 크기 다른 그림 · 64KB 초과는 만들지 않는다
      ["icon-appended-key", (root) => {
        fs.appendFileSync(path.join(root, "icons", "icon-16.png"), "\n-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n");
      }, /invalid icon icons\/icon-16\.png: trailing data/],
      ["icon-signature-only", (root) => {
        fs.writeFileSync(path.join(root, "icons", "icon-32.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      }, /invalid icon icons\/icon-32\.png: size/],
      ["icon-wrong-dimensions", (root) => {
        fs.copyFileSync(path.join(root, "icons", "icon-16.png"), path.join(root, "icons", "icon-48.png"));
      }, /invalid icon icons\/icon-48\.png: dimensions/],
      ["icon-too-big", (root) => {
        const png = fs.readFileSync(path.join(root, "icons", "icon-128.png"));
        fs.writeFileSync(path.join(root, "icons", "icon-128.png"), Buffer.concat([png.subarray(0, 33), Buffer.alloc(70 * 1024), png.subarray(png.length - 12)]));
      }, /invalid icon icons\/icon-128\.png: size/],
      ["key", (root) => {
        const data = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
        delete data.key;
        fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(data));
      }, /manifest key/],
      ["bom", (root) => {
        const file = path.join(root, "background.js");
        fs.writeFileSync(file, `﻿${fs.readFileSync(file, "utf8")}`);
      }, /BOM/],
      ["secret", (root) => {
        fs.appendFileSync(path.join(root, "lib", "measure.js"), "\n// -----BEGIN PRIVATE KEY-----\n");
      }, /private key/],
    ];
    for (const [name, mutate, pattern] of cases) {
      const root = copyExtension(path.join(work, name));
      mutate(root);
      assert.throws(() => build(path.join(work, `${name}-out`), { extensionRoot: root }), pattern, name);
      assert.equal(fs.existsSync(path.join(work, `${name}-out`, `mi-coupang-check-${manifest.version}.zip`)), false, name);
    }
    // README·test 는 있어도 되고 zip 에 들어가지 않는다.
    const ok = copyExtension(path.join(work, "ok"));
    const result = build(path.join(work, "ok-out"), { extensionRoot: ok });
    assert.equal(readZip(fs.readFileSync(result.zipPath)).length, SHIPPED_FILES.length);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("맥 기본 풀기(ditto)·unzip 으로 풀면 mi-coupang-check 폴더 하나에 원문 그대로 나온다", (t) => {
  const tools = ["/usr/bin/ditto", "/usr/bin/unzip"].filter((file) => fs.existsSync(file));
  if (!tools.length) {
    t.skip("ditto·unzip 이 없는 환경");
    return;
  }
  const outDir = tempDir("mi-coupang-check-unpack-");
  try {
    const result = build(outDir);
    for (const tool of tools) {
      const target = path.join(outDir, path.basename(tool));
      fs.mkdirSync(target);
      const args = tool.endsWith("ditto") ? ["-x", "-k", result.zipPath, target] : ["-q", result.zipPath, "-d", target];
      const run = spawnSync(tool, args, { encoding: "utf8", timeout: 30000 });
      assert.equal(run.status, 0, `${tool}: ${run.stderr}`);
      assert.deepEqual(fs.readdirSync(target), ["mi-coupang-check"]);
      for (const rel of SHIPPED_FILES) {
        assert.deepEqual(fs.readFileSync(path.join(target, "mi-coupang-check", rel)), fs.readFileSync(path.join(extensionRoot, rel)), `${tool} ${rel}`);
      }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("storedZip: 빈 목록·한글 이름도 모양이 맞다", () => {
  const entries = readZip(storedZip([{ name: "가/나.txt", data: Buffer.from("다") }]));
  assert.equal(entries[0].name, "가/나.txt");
  assert.equal(Buffer.from(entries[0].data).toString("utf8"), "다");
  assert.equal(storedZip([]).length, 22);
});

test("공개 빌드 검사는 .zip·version.json 을 막지 않고, 공개 폴더에는 확장 원문을 두지 않는다", () => {
  const checker = fs.readFileSync(path.join(repoRoot, "scripts", "check-public-build-security.mjs"), "utf8");
  const blocked = checker.slice(checker.indexOf("const blockedExtensions"), checker.indexOf("]);", checker.indexOf("const blockedExtensions")));
  assert.doesNotMatch(blocked, /"\.zip"|"\.json"/);
  assert.equal(fs.existsSync(path.join(repoRoot, "public", "coupang-check")), false, "zip 은 빌드 때만 dist 에 생긴다");
});

// 아래 두 단정은 통합 담당이 package.json 을 고친 뒤에 통과한다(지난 결함: build:vercel 에 빌더가 없어 zip 이 배포되지 않음).
test("package.json build:vercel: 수집기 묶음 다음·공개 빌드 검사 앞에 확장 빌더가 돈다", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const script = String(pkg.scripts?.["build:vercel"] || "");
  const collector = script.indexOf("node scripts/build-coupang-collector-bundle.mjs");
  const builder = script.indexOf("node scripts/build-coupang-check-extension.mjs");
  const publicCheck = script.indexOf("npm run check:public-build");
  assert.ok(collector >= 0, "수집기 묶음 빌드");
  assert.ok(builder > collector, "확장 빌더가 수집기 묶음 다음에 있어야 한다");
  assert.ok(publicCheck > builder, "공개 빌드 검사가 확장 빌더 뒤에 있어야 한다");
});

test("package.json test: 확장 테스트 글롭과 이 빌더 테스트가 npm test 에 들어 있다", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const script = String(pkg.scripts?.test || "");
  assert.ok(script.includes("tools/coupang-rank-check-extension/test/*.test.mjs"), "확장 테스트 글롭");
  assert.ok(script.includes("scripts/coupang-check-extension-build.test.mjs"), "빌더 테스트");
});
