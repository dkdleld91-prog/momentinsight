// C 30일 순위(쿠팡) 수집기 묶음 만들기(명세 §9.7, D7). Vercel 빌드에서 build-vercel-static.mjs 다음에 돈다.
// 출력: dist/coupang-collector/{bundle.json, install-windows.ps1, install-macos.sh}
// - 코드는 JSON 안의 문자열로 배포한다(public 의 .mjs 공개 금지 규칙). public/ 에는 아무것도 두지 않는다.
// - sha256 은 UTF-8 바이트 기준(PS 5.1 설치기가 UTF8.GetBytes 로 다시 계산한다).
// - release = VERCEL_GIT_COMMIT_SHA 앞 7자 → 없으면 git rev-parse --short=7 HEAD → 그래도 아니면 0000000.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUNDLE_SCHEMA = 1;
export const BUNDLE_MAX_BYTES = 512 * 1024;
export const RELEASE_PATTERN = /^[0-9a-f]{7}$/;
export const UNKNOWN_RELEASE = "0000000";
export const COLLECTOR_DIR = "tools/coupang-rank-collector";
export const OUTPUT_SUBDIR = "coupang-collector";
// 묶음 안 경로(app/ 기준) ← 저장소 경로
export const PLATFORM_FILES = Object.freeze([
  ["run-worker.ps1", "platform/windows/run-worker.ps1"],
  ["run-worker.sh", "platform/macos/run-worker.sh"],
  ["collector.plist.template", "platform/macos/collector.plist.template"],
]);
export const INSTALLERS = Object.freeze([
  ["install-windows.ps1", "platform/windows/install-windows.ps1"],
  ["install-macos.sh", "platform/macos/install-macos.sh"],
]);

const repoRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function sha256Utf8(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
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

export function resolveRelease({ env = process.env, gitRelease = () => "" } = {}) {
  const sha = String(env.VERCEL_GIT_COMMIT_SHA || "").trim();
  // 서버(one-liners)와 같은 규칙: 소문자 16진 7자가 아니면 0000000(대소문자를 바꿔 맞추지 않는다).
  const candidate = sha ? sha.slice(0, 7) : String(gitRelease() || "").trim().slice(0, 7);
  return RELEASE_PATTERN.test(candidate) ? candidate : UNKNOWN_RELEASE;
}

export function bundleSourceList(collectorRoot) {
  const libDir = path.join(collectorRoot, "lib");
  const libs = fs.readdirSync(libDir).filter((name) => name.endsWith(".mjs")).sort();
  return [
    ...libs.map((name) => [`lib/${name}`, `lib/${name}`]),
    ["worker.mjs", "worker.mjs"],
    ["trial.mjs", "trial.mjs"],
    ...PLATFORM_FILES,
  ];
}

function readText(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`coupang collector bundle: not a regular file: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`coupang collector bundle: BOM not allowed: ${file}`);
  if (!text.isWellFormed()) throw new Error(`coupang collector bundle: invalid UTF-8/UTF-16: ${file}`);
  return text;
}

function assertAscii(file, text) {
  if (/[^\x00-\x7f]/.test(text)) throw new Error(`coupang collector bundle: PowerShell file must be ASCII only: ${file}`);
}

export async function buildCoupangCollectorBundle({
  repoRoot = repoRootDefault,
  outDir = path.join(repoRoot, "dist", OUTPUT_SUBDIR),
  env = process.env,
  gitRelease = () => defaultGitRelease(repoRoot),
  nodePath = process.execPath,
} = {}) {
  const collectorRoot = path.join(repoRoot, COLLECTOR_DIR);
  const contractUrl = pathToFileURL(path.join(collectorRoot, "lib", "contract.mjs")).href;
  const { COLLECTOR_VERSION } = await import(contractUrl);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(COLLECTOR_VERSION))) throw new Error("coupang collector bundle: COLLECTOR_VERSION is invalid");
  const release = resolveRelease({ env, gitRelease });
  const files = [];
  for (const [bundlePath, sourcePath] of bundleSourceList(collectorRoot)) {
    const absolute = path.join(collectorRoot, sourcePath);
    const content = readText(absolute);
    if (bundlePath.endsWith(".ps1")) assertAscii(sourcePath, content);
    if (bundlePath.endsWith(".mjs")) {
      execFileSync(nodePath, ["--check", absolute], { stdio: ["ignore", "ignore", "pipe"], timeout: 30000 });
    }
    files.push({ path: bundlePath, sha256: sha256Utf8(content), content });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bundle = { schema: BUNDLE_SCHEMA, release, version: COLLECTOR_VERSION, files };
  const text = JSON.stringify(bundle);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > BUNDLE_MAX_BYTES) throw new Error(`coupang collector bundle: ${bytes} bytes exceeds ${BUNDLE_MAX_BYTES}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "bundle.json"), text, "utf8");
  for (const [name, sourcePath] of INSTALLERS) {
    const content = readText(path.join(collectorRoot, sourcePath));
    if (name.endsWith(".ps1")) assertAscii(sourcePath, content);
    fs.writeFileSync(path.join(outDir, name), content, "utf8");
  }
  return { outDir, release, version: COLLECTOR_VERSION, bytes, files: files.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildCoupangCollectorBundle();
  console.log(`Coupang collector bundle: release=${result.release} version=${result.version} files=${result.files.length} bytes=${result.bytes} -> ${path.relative(process.cwd(), result.outDir) || result.outDir}`);
}
