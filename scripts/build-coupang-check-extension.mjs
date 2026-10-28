// C 30일 ① '지금 확인' 크롬 확장 배포물 만들기(spec-manual §8, 2026-10-23 구현).
// Vercel 빌드(build:vercel)에서 build-coupang-collector-bundle.mjs 다음, check:public-build 앞에 돈다.
// 출력: dist/coupang-check/mi-coupang-check-<version>.zip + dist/coupang-check/version.json
// - zip 안 폴더 이름은 버전 없는 고정 'mi-coupang-check/' 다(업데이트 때 같은 자리에 풀고 크롬 ↻ 만 누르면 되게).
// - 무압축(stored)·항목 순서 고정·시각 1980-01-01·UTF-8 이름 표시·추가 필드 없음·CRC32 직접 계산 → 두 번 만들어도 바이트가 같다.
// - 넣는 파일은 허용 목록 5개뿐이다. 확장 폴더에 목록 밖 파일(README·test 제외)이 생기면 만들지 않는다.
// - 비밀키는 저장소에 없다(manifest key 는 공개키). 'PRIVATE KEY' 문자열이 보이면 만들지 않는다.
// - release 규칙은 수집기 묶음과 같다(VERCEL_GIT_COMMIT_SHA 앞 7자 → git → 0000000). release 는 version.json 에만 넣는다.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRelease } from "./build-coupang-collector-bundle.mjs";

export const EXTENSION_DIR = "tools/coupang-rank-check-extension";
export const OUTPUT_SUBDIR = "coupang-check";
export const ZIP_FOLDER = "mi-coupang-check";
export const VERSION_SCHEMA = 1;
export const ZIP_MAX_BYTES = 1024 * 1024;
// zip 에 넣는 파일(이 순서 그대로). 확장 폴더의 README.md·test/ 는 넣지 않는다.
export const SHIPPED_FILES = Object.freeze([
  "background.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "lib/assemble.js",
  "lib/measure.js",
  "lib/protocol.js",
  "manifest.json",
]);
const NOT_SHIPPED = Object.freeze(["README.md"]);
const NOT_SHIPPED_DIRS = Object.freeze(["test"]);
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1; // 1980년 = 0, 1월, 1일
const DOS_TIME_ZERO = 0;
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY_UNIX = (3 << 8) | 20;
const EXTERNAL_ATTR_FILE_0644 = (0o100644 << 16) >>> 0;

const repoRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
export const ICON_MAX_BYTES = 64 * 1024;

export function checkIconPng(rel, data) {
  const match = /^icons\/icon-(16|32|48|128)\.png$/.exec(rel);
  const fail = (why) => { throw new Error(`coupang check extension: invalid icon ${rel}: ${why}`); };
  if (!match) fail("name");
  if (!Buffer.isBuffer(data) || data.length < 8 + 25 + 12 || data.length > ICON_MAX_BYTES) fail("size");
  if (Buffer.compare(data.subarray(0, 8), PNG_SIGNATURE) !== 0) fail("signature");
  if (data.readUInt32BE(8) !== 13 || data.toString("latin1", 12, 16) !== "IHDR") fail("ihdr");
  const want = Number(match[1]);
  if (data.readUInt32BE(16) !== want || data.readUInt32BE(20) !== want) fail("dimensions");
  if (Buffer.compare(data.subarray(data.length - 12), PNG_IEND) !== 0) fail("trailing data");
  if (/PRIVATE KEY/.test(data.toString("latin1"))) fail("private key material");
}

export function zipFileName(version) {
  return `mi-coupang-check-${version}.zip`;
}

// 화면 내려받기 링크와 같은 공개 경로(서버 contract MANUAL_EXTENSION_ZIP_PATH 와 같아야 한다 — 확장 테스트가 대조).
export function publishedZipPath(version) {
  return `/${OUTPUT_SUBDIR}/${zipFileName(version)}`;
}

// 크롬 확장 ID: manifest key(공개키 SPKI DER, base64)의 SHA-256 앞 16바이트를 16진 32자로 쓰고 0~f 를 a~p 로 바꾼다
// (Chromium components/crx_file/id_util.cc). 대표 설치 화면의 ID 와 대조해 최종 확인한다.
export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(String(keyBase64 || ""), "base64");
  if (der.length < 64) throw new Error("coupang check extension: manifest key is missing or too short");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return Array.from(hex, (char) => String.fromCharCode(97 + parseInt(char, 16))).join("");
}

let crcTable = null;
export function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let k = 0; k < 8; k += 1) value = value & 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) crc = (crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

// 무압축 zip(항목 = [{ name, data }]). 같은 입력이면 같은 바이트.
export function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME_ZERO, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME_ZERO, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE(EXTERNAL_ATTR_FILE_0644, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function readRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`coupang check extension: not a regular file: ${file}`);
  return fs.readFileSync(file);
}

function listFolder(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!NOT_SHIPPED_DIRS.includes(rel)) walk(absolute);
        continue;
      }
      found.push(rel);
    }
  };
  walk(root);
  return found.sort();
}

// 정적 import 가 모두 배포 파일을 가리키는지(빠진 파일이 있는 zip 을 만들지 않게).
function relativeImports(source) {
  const specs = [];
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specs.push(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(match[1]);
  return specs;
}

export function buildCoupangCheckExtension({
  repoRoot = repoRootDefault,
  outDir = path.join(repoRoot, "dist", OUTPUT_SUBDIR),
  env = process.env,
  gitRelease = () => defaultGitRelease(repoRoot),
  nodePath = process.execPath,
  extensionRoot = path.join(repoRoot, EXTENSION_DIR),
} = {}) {
  const present = listFolder(extensionRoot);
  const unexpected = present.filter((rel) => !SHIPPED_FILES.includes(rel) && !NOT_SHIPPED.includes(rel));
  if (unexpected.length) throw new Error(`coupang check extension: unexpected files (add to SHIPPED_FILES or remove): ${unexpected.join(", ")}`);
  const missing = SHIPPED_FILES.filter((rel) => !present.includes(rel));
  if (missing.length) throw new Error(`coupang check extension: missing files: ${missing.join(", ")}`);

  const manifestBytes = readRegular(path.join(extensionRoot, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const version = String(manifest.version || "");
  if (!/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(version)) throw new Error("coupang check extension: manifest version is invalid");
  const extensionId = extensionIdFromKey(manifest.key);
  if (manifest.background?.service_worker && !SHIPPED_FILES.includes(manifest.background.service_worker)) {
    throw new Error("coupang check extension: service worker is not shipped");
  }

  const entries = [];
  const files = [];
  for (const rel of SHIPPED_FILES) {
    const absolute = path.join(extensionRoot, rel);
    const data = readRegular(absolute);
    // 아이콘(1.0.4)은 PNG 만 받는다(checkIconPng): icons/icon-<크기>.png · 서명 · 첫 덩어리 IHDR 의 가로=세로=크기 ·
    // 끝 12바이트가 IEND(뒤에 붙인 글자 없음) · 64KB 이하 · 바이트 어디에도 비밀키 표시 없음. 글자 검사(UTF-8·BOM)는 글자 파일에만.
    if (rel.endsWith(".png")) {
      checkIconPng(rel, data);
      entries.push({ name: `${ZIP_FOLDER}/${rel}`, data });
      files.push({ path: rel, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
      continue;
    }
    const text = data.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) throw new Error(`coupang check extension: BOM not allowed: ${rel}`);
    if (!text.isWellFormed() || Buffer.compare(Buffer.from(text, "utf8"), data) !== 0) throw new Error(`coupang check extension: invalid UTF-8: ${rel}`);
    if (/PRIVATE KEY/.test(text)) throw new Error(`coupang check extension: private key material in ${rel}`);
    if (rel.endsWith(".js")) {
      execFileSync(nodePath, ["--check", absolute], { stdio: ["ignore", "ignore", "pipe"], timeout: 30000 });
      for (const spec of relativeImports(text)) {
        if (!spec.startsWith(".")) throw new Error(`coupang check extension: non-relative import ${spec} in ${rel}`);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        if (!SHIPPED_FILES.includes(target)) throw new Error(`coupang check extension: ${rel} imports ${target}, which is not shipped`);
      }
    }
    entries.push({ name: `${ZIP_FOLDER}/${rel}`, data });
    files.push({ path: rel, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
  }
  const zip = storedZip(entries);
  if (zip.length > ZIP_MAX_BYTES) throw new Error(`coupang check extension: zip ${zip.length} bytes exceeds ${ZIP_MAX_BYTES}`);
  const release = resolveRelease({ env, gitRelease });
  const zipName = zipFileName(version);
  const info = {
    schema: VERSION_SCHEMA,
    version,
    extensionId,
    folder: ZIP_FOLDER,
    zip: zipName,
    path: publishedZipPath(version),
    sha256: createHash("sha256").update(zip).digest("hex"),
    bytes: zip.length,
    release,
    files,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, zipName), zip);
  fs.writeFileSync(path.join(outDir, "version.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
  return { outDir, zipPath: path.join(outDir, zipName), ...info };
}

function defaultGitRelease(repoRoot) {
  try {
    return String(execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
    })).trim();
  } catch {
    return "";
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildCoupangCheckExtension();
  console.log(`Coupang check extension: version=${result.version} id=${result.extensionId} release=${result.release} bytes=${result.bytes} -> ${path.relative(process.cwd(), result.zipPath) || result.zipPath}`);
}
