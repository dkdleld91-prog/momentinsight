import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkPowerShell51Line } from "../docs/skills/mi-collection-incident/scripts/windows-drill.mjs";

// 런타임 배포 도구(docs/skills/mi-runtime-release/scripts)의 저장소 사본이 문서(SKILL.md·RUNBOOK 1.1.34 D 절)가
// 말하는 판인지 고정한다. 1.1.34 최종 검토: 문서는 새 도구를 설명했지만 저장소 사본은 옛 판이었다 — 옛 bump.py 는
// SERVICE_WORKER_BUILD 를 옮기지 않아 다음 인상에서 baseline 이 막히고, 옛 windows-oneliner.sh 에는 D 절 0단계가
// 쓰라는 등록 SW 확인 한 줄이 없다. 버전 리터럴은 manifest.json 에서 읽는다(bump.py 가 옮기는 파일이 아니다).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const toolDirectory = "docs/skills/mi-runtime-release/scripts";
const bump = read(`${toolDirectory}/bump.py`);
const updater = read("scripts/windows/update-naver-shopping-chrome-extension.ps1");
const manifestPath = "tools/naver-shopping-chrome-extension/manifest.json";
const serviceWorkerPath = "tools/naver-shopping-chrome-extension/service-worker.js";
const CURRENT = JSON.parse(read(manifestPath)).version;
const NEXT = CURRENT.replace(/\d+$/u, (patch) => String(Number(patch) + 1));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const EXTENSION_ID = updater.match(/^\$extensionId = "([a-p]{32})"$/mu)?.[1];

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} … ${end}`);
  return source.slice(from, to);
}

// bump.py 1단계(버전 리터럴) 표: sub("파일", [(f'…{OLD}…', f'…{NEW}…')])
function bumpLiteralTable() {
  const section = slice(bump, "# 1. 버전 리터럴", "flush()");
  return [...section.matchAll(/sub\("([^"]+)", \[\(f'([^']+)', f'([^']+)'\)\]\)/gu)]
    .map(([, file, from, to]) => ({ file, from, to }));
}

// 런타임 버전 상수(const X = "<현재 버전>";)를 가진 비테스트 소스 파일. baseline·contract 는 bump.py 가
// 핀 단계(6)에서 따로 옮기므로 뺀다.
function runtimeLiteralCarriers() {
  const declaration = new RegExp(`\\bconst [A-Z0-9_]+ = "${escapeRegExp(CURRENT)}";`, "u");
  const skipped = new Set(["scripts/check-release-baseline.mjs", "scripts/check-server-contract.mjs"]);
  const carriers = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(child);
      } else if (/\.(?:mjs|js)$/u.test(entry.name) && !entry.name.endsWith(".test.mjs") && !skipped.has(child)
        && declaration.test(read(child))) {
        carriers.push(child);
      }
    }
  };
  for (const directory of ["scripts", "src", "tools/naver-shopping-chrome-extension", "tools/naver-shopping-rank-collector/src"]) walk(directory);
  return carriers.sort();
}

test("bump.py names every file that declares the runtime version literal, including the service worker build", () => {
  const carriers = runtimeLiteralCarriers();
  assert.ok(carriers.includes(serviceWorkerPath), "SERVICE_WORKER_BUILD 를 가진 서비스 워커가 목록에 있어야 한다");
  assert.ok(carriers.length >= 6, carriers.join(", "));
  const missing = carriers.filter((file) => !bump.includes(`"${file}"`));
  assert.deepEqual(missing, [], "bump.py 가 옮기지 않는 버전 리터럴 파일");
});

test("bump.py step 1 moves the service worker build together with manifest.json", () => {
  const table = bumpLiteralTable();
  assert.ok(table.length >= 6, "1단계 표");
  const files = new Map();
  for (const { file, from, to } of table) {
    const before = files.get(file) ?? read(file);
    const oldText = from.replaceAll("{OLD}", CURRENT);
    assert.ok(before.includes(oldText), `${file}: ${oldText}`);
    files.set(file, before.replaceAll(oldText, to.replaceAll("{NEW}", NEXT)));
  }
  assert.equal(JSON.parse(files.get(manifestPath) ?? "{}").version, NEXT);
  // baseline shoppingStaleServiceWorkerIsRefusedAndReloaded 와 같은 조건: 빌드 리터럴 == manifest 버전.
  const nextWorker = files.get(serviceWorkerPath) ?? read(serviceWorkerPath);
  assert.ok(nextWorker.includes(`\nconst SERVICE_WORKER_BUILD = "${NEXT}";\n`), "인상 뒤 SERVICE_WORKER_BUILD");
  assert.ok(!nextWorker.includes(`"${CURRENT}"`), "서비스 워커에 옛 버전이 남으면 모든 기계가 30분마다 스스로 새로고침한다");
  for (const [file, text] of files) {
    assert.ok(!new RegExp(`\\bconst [A-Z0-9_]+ = "${escapeRegExp(CURRENT)}";`, "u").test(text), `${file} 에 옛 버전 상수가 남음`);
  }
});

function windowsOneliner(sha, version) {
  const result = spawnSync("bash", [path.join(root, toolDirectory, "windows-oneliner.sh"), sha, version], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

// 등록 SW 확인 한 줄의 문자열 판독을 JavaScript 로 옮긴다(PS 5.1 ConvertFrom-Json 은 Secure Preferences 를 못 읽는다).
function checkLineRegisteredVersion(line, text) {
  const key = line.match(/\$k='([^']+)';/u)?.[1];
  const nextExtension = line.match(/\$n=\[regex\]::Match\(\$r, '([^']+)'\);/u)?.[1];
  const registration = line.match(/\$v=\[regex\]::Match\(\$r, '([^']+)'\)\.Groups\[1\]\.Value;/u)?.[1];
  assert.ok(key && nextExtension && registration, "check line patterns");
  const index = text.indexOf(key);
  if (index < 0) return "EXTENSION_NOT_FOUND";
  let extensionText = text.slice(index + key.length);
  const next = new RegExp(nextExtension, "u").exec(extensionText);
  if (next) extensionText = extensionText.slice(0, next.index);
  return new RegExp(registration, "u").exec(extensionText)?.[1] ?? "";
}

test("windows-oneliner.sh prints the updater line, the SW guidance and the read-only registered-SW check line", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const lines = windowsOneliner(sha, NEXT);
  const commands = lines.filter((line) => !line.startsWith("#"));
  assert.equal(commands.length, 2, "업데이터 한 줄 + 등록 SW 확인 한 줄");
  const [updateLine, checkLine] = commands;
  assert.equal(lines[0], updateLine);
  assert.ok(updateLine.includes(`/momentinsight/${sha}/scripts/windows/update-naver-shopping-chrome-extension.ps1 `));
  assert.ok(updateLine.endsWith(` -ReleaseCommit ${sha.slice(0, 7)} -ExpectedVersion ${NEXT}`));
  for (const line of commands) assert.deepEqual(checkPowerShell51Line(line), [], line.slice(0, 60));

  const guide = lines.filter((line) => line.startsWith("#")).join("\n");
  assert.ok(guide.includes(`MI_EXTENSION_UPDATE_OK release=${sha.slice(0, 7)} version=${NEXT} ... extension_sw_registered_version=${NEXT}`));
  assert.match(guide, /# MI_EXTENSION_SW_STALE [^\n]*chrome:\/\/extensions[^\n]*↻/u);
  assert.match(guide, /# MI_EXTENSION_SW_UNVERIFIED reason=scheduled_task_disabled [^\n]*Enable-ScheduledTask -TaskPath '\\MomentInsight\\' -TaskName NaverShoppingChrome; Start-ScheduledTask -TaskPath '\\MomentInsight\\' -TaskName NaverShoppingChrome/u);
  assert.ok(guide.includes(`SW_VERSION=${NEXT} DISK_VERSION=${NEXT} PROFILE=<수집 프로필> VERDICT=OK`));
  // 안내가 말하는 결과 줄과 작업 이름은 업데이터가 실제로 찍고 쓰는 것이다.
  assert.match(updater, /Write-Host "MI_EXTENSION_SW_STALE [^"\n]*extension_sw_registered_version=\$reportedServiceWorkerVersion"/u);
  assert.match(updater, /Write-Host "MI_EXTENSION_SW_UNVERIFIED reason=scheduled_task_disabled [^"\n]*"/u);
  assert.match(updater, /\$successMessage \+= " extension_sw_registered_version=\$reportedServiceWorkerVersion"/u);
  assert.match(updater, /^\$taskPath = "\\MomentInsight\\"$/mu);
  assert.match(updater, /^\$taskName = "NaverShoppingChrome"$/mu);

  // 확인 한 줄: 업데이터와 같은 설정 파일 둘째 줄(수집 프로필)·같은 확장 id 를 읽기만 한다.
  assert.ok(EXTENSION_ID, "updater extension id");
  assert.ok(checkLine.includes(`$k='"${EXTENSION_ID}":{'`));
  assert.ok(checkLine.includes('$b="$env:LOCALAPPDATA\\MomentInsight\\NaverShoppingBridge"'));
  assert.ok(checkLine.includes('(@(Get-Content -Encoding UTF8 "$b\\windows-chrome-scheduler.conf"))[1].Trim()'));
  assert.ok(checkLine.includes('"$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\$pr\\Secure Preferences"'));
  assert.doesNotMatch(checkLine, /Stop-|Start-|Set-|Remove-|Out-File|Invoke-WebRequest|ConvertFrom-Json \$t/u);
  assert.match(checkLine, /VERDICT=\$\(if \(\$v -eq \$m\) \{ 'OK' \} else \{ 'STALE' \}\)/u);

  const other = "abcdefghijklmnopabcdefghijklmnop";
  const settings = (entries) => JSON.stringify({ extensions: { settings: Object.fromEntries(entries) } });
  const cases = [
    ["measured shape", settings([[EXTENSION_ID, { path: "C:\\x", service_worker_registration_info: { version: CURRENT } }], [other, { service_worker_registration_info: { version: "9.9.9" } }]]), CURRENT],
    ["F3 shape", settings([[other, { path: "y" }], [EXTENSION_ID, { path: "C:\\x", service_worker_registration_info: { version: "1.1.32" } }]]), "1.1.32"],
    ["only another extension is registered", settings([[EXTENSION_ID, { path: "x" }], [other, { service_worker_registration_info: { version: "9.9.9" } }]]), ""],
    ["another extension before ours", settings([[other, { service_worker_registration_info: { version: "9.9.9" } }], [EXTENSION_ID, { path: "x" }]]), ""],
    ["not installed", settings([[other, { service_worker_registration_info: { version: "9.9.9" } }]]), "EXTENSION_NOT_FOUND"],
  ];
  for (const [label, text, expected] of cases) assert.equal(checkLineRegisteredVersion(checkLine, text), expected, label);
});
