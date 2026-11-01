// build.mjs --embed 시험: 화면 파일의 표식 사이 링크 href 만 그 화면 변형(관리자 …/admin · 광고주 …/client)의 주소로 바꾸고,
// 표식이 틀리거나 모르는 파일이면 큰 소리로 실패한다(하나라도 실패하면 아무 파일도 쓰지 않음).
// 저장소 화면 파일은 고치지 않고 임시 사본으로 시험한다. 마지막 시험은 저장소의 src/pages/admin.html·client.html 이 지금 빌드와
// 같은 버튼을 품고 있는지 본다(표식이 아직 없으면 건너뜀).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EMBED_PAGE_VARIANTS,
  MARKER_END,
  MARKER_START,
  OPTION_FILL_TARGETS,
  REPO_ROOT,
  assertServerRulesMatch,
  bookmarkletHref,
  buildBookmarkletCode,
  embedBookmarklet,
  readEmbeddedHref,
  readServerOptionRules,
  variantForEmbedPath,
} from "../build.mjs";
import * as server from "../../../src/server/naver-rank-option-group.mjs";

const BUILD_SCRIPT = fileURLToPath(new URL("../build.mjs", import.meta.url));
const INITIAL_ANCHOR = '<a class="mi-rank-option-bookmarklet" data-rank-option-bookmarklet href="javascript:void(0)" title="즐겨찾기 줄로 끌어다 놓으세요">모먼트 옵션 확인</a>';
const PAGE = [
  "<!doctype html><html><body>",
  '<details class="mi-rank-option-install"><summary>버튼 설치</summary>',
  "<ol><li>즐겨찾기 줄을 켭니다</li></ol>",
  `${MARKER_START}${INITIAL_ANCHOR}${MARKER_END}`,
  '<a href="https://insight.momentlabs.co.kr/admin">다른 링크</a>',
  "</details></body></html>",
].join("\n");

const hrefs = {
  admin: bookmarkletHref(buildBookmarkletCode({ variant: "admin" })),
  client: bookmarkletHref(buildBookmarkletCode({ variant: "client" })),
};
const href = hrefs.admin;
const codeOf = (value) => decodeURIComponent(value.slice("javascript:".length));

test("규칙 읽기: build.mjs 가 서버 파일 글자에서 읽은 값이 서버 모듈 값과 같다", () => {
  assert.deepEqual(readServerOptionRules(), {
    OPTION_PRODUCT_IDS_MAX: server.OPTION_PRODUCT_IDS_MAX,
    OPTION_PRODUCT_ID_MIN_DIGITS: server.OPTION_PRODUCT_ID_MIN_DIGITS,
    OPTION_PRODUCT_ID_MAX_DIGITS: server.OPTION_PRODUCT_ID_MAX_DIGITS,
  });
  assert.doesNotThrow(() => assertServerRulesMatch());
});

test("규칙이 서버와 다르면 빌드가 멈춘다", () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mi-option-check-rules-"));
  try {
    const file = path.join(fakeRoot, "src", "server", "naver-rank-option-group.mjs");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const OPTION_PRODUCT_IDS_MAX = 60;\nexport const OPTION_PRODUCT_ID_MIN_DIGITS = 5;\nexport const OPTION_PRODUCT_ID_MAX_DIGITS = 20;\n");
    assert.throws(() => assertServerRulesMatch(fakeRoot), /OPTION_PRODUCT_IDS_MAX=50 이 서버 규칙 60/);
    fs.writeFileSync(file, "export const OPTION_PRODUCT_IDS_MAX = 50;\n");
    assert.throws(() => assertServerRulesMatch(fakeRoot), /OPTION_PRODUCT_ID_MIN_DIGITS 를 정확히 1번 찾지 못했습니다/);
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("embed: 표식 사이 링크의 href 만 바뀌고 나머지(속성·글자·표식 밖)는 그대로, 두 번 해도 같다", () => {
  const once = embedBookmarklet(PAGE, href);
  const twice = embedBookmarklet(once, href);
  assert.equal(twice, once);
  assert.equal(readEmbeddedHref(once), href);
  assert.equal(readEmbeddedHref(PAGE), "javascript:void(0)");
  const expectedAnchor = INITIAL_ANCHOR.replace('href="javascript:void(0)"', `href="${href}"`);
  assert.equal(once, PAGE.replace(INITIAL_ANCHOR, expectedAnchor));
  assert.ok(once.includes('<a href="https://insight.momentlabs.co.kr/admin">다른 링크</a>'));
  // 주소에 # 이 없어 관리자 화면 색 검사(stage5-ui 의 #hex 셈)에 잡히지 않는다.
  const inner = once.slice(once.indexOf(MARKER_START), once.indexOf(MARKER_END));
  assert.equal(inner.includes("#"), false);
});

test("embed: 표식이 없거나·두 번이거나·순서가 틀리거나·링크가 0개/2개/href 없음이면 실패한다", () => {
  const cases = [
    ["표식 없음", "<html><body>없음</body></html>", /표식이 정확히 1쌍/],
    ["시작만", `${MARKER_START}${INITIAL_ANCHOR}`, /표식이 정확히 1쌍/],
    ["두 쌍", `${MARKER_START}${INITIAL_ANCHOR}${MARKER_END}${MARKER_START}${INITIAL_ANCHOR}${MARKER_END}`, /표식이 정확히 1쌍/],
    ["순서 반대", `${MARKER_END}${INITIAL_ANCHOR}${MARKER_START}`, /끝 표식이 시작 표식보다 앞/],
    ["링크 없음", `${MARKER_START}<span>버튼</span>${MARKER_END}`, /링크가 정확히 1개/],
    ["링크 둘", `${MARKER_START}${INITIAL_ANCHOR}${INITIAL_ANCHOR}${MARKER_END}`, /링크가 정확히 1개/],
    ["href 없음", `${MARKER_START}<a class="x">버튼</a>${MARKER_END}`, /href 가 정확히 1개/],
  ];
  for (const [name, html, pattern] of cases) assert.throws(() => embedBookmarklet(html, href), pattern, name);
  assert.equal(readEmbeddedHref("<html></html>"), null);
});

test("변형 정하기: src/pages/admin.html → admin, src/pages/client.html → client, 그 밖의 파일은 실패", () => {
  assert.deepEqual(EMBED_PAGE_VARIANTS, { "src/pages/admin.html": "admin", "src/pages/client.html": "client" });
  assert.equal(variantForEmbedPath(path.join(REPO_ROOT, "src", "pages", "admin.html")), "admin");
  assert.equal(variantForEmbedPath(path.join(os.tmpdir(), "copy", "src", "pages", "client.html")), "client");
  for (const other of [
    path.join(os.tmpdir(), "admin.html"),
    path.join(os.tmpdir(), "src", "pages", "other.html"),
    path.join(os.tmpdir(), "src", "pages", "xadmin.html"),
    path.join(os.tmpdir(), "src", "pages", "admin.html.bak"),
    path.join(os.tmpdir(), "pages", "client.html"),
  ]) {
    assert.throws(() => variantForEmbedPath(other), /--embed 는 src\/pages\/admin\.html·src\/pages\/client\.html 만 받습니다/, other);
  }
  // 두 변형 주소는 고정 주소만 다르다.
  assert.ok(codeOf(hrefs.admin).includes(`const OPTION_FILL_TARGET = ${JSON.stringify(OPTION_FILL_TARGETS.admin)};`));
  assert.ok(codeOf(hrefs.client).includes(`const OPTION_FILL_TARGET = ${JSON.stringify(OPTION_FILL_TARGETS.client)};`));
  assert.equal(codeOf(hrefs.admin).replace(OPTION_FILL_TARGETS.admin, OPTION_FILL_TARGETS.client), codeOf(hrefs.client));
});

// 임시 폴더에 src/pages/<이름> 사본을 만든다. 표식이 없는 화면(아직 버튼 자리를 넣기 전)은 맨 끝에 표식 묶음을 붙인 사본을 쓴다
// (화면 파일은 </body> 없는 조각이다).
function copyPage(root, name, { addMarkerIfMissing = true } = {}) {
  const source = fs.readFileSync(path.join(REPO_ROOT, "src", "pages", name), "utf8");
  const target = path.join(root, "src", "pages", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const hasMarker = source.includes(MARKER_START) || source.includes(MARKER_END);
  const text = hasMarker || !addMarkerIfMissing
    ? source
    : `${source}\n${MARKER_START}${INITIAL_ANCHOR}${MARKER_END}\n`;
  fs.writeFileSync(target, text);
  return { path: target, before: text };
}

// 표식 밖(앞·뒤) 글자가 그대로인지 본다.
function assertOnlyHrefChanged(before, after, expectedHref) {
  assert.equal(readEmbeddedHref(after), expectedHref);
  assert.equal(after.slice(0, after.indexOf(MARKER_START)), before.slice(0, before.indexOf(MARKER_START)));
  assert.equal(after.slice(after.indexOf(MARKER_END)), before.slice(before.indexOf(MARKER_END)));
  assert.equal(after, embedBookmarklet(before, expectedHref));
}

test("명령: --embed 를 두 번 주면 두 화면 사본을 각자 변형 주소로 바꾸고, dist 에 두 변형을 만든다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mi-option-check-embed-"));
  try {
    const admin = copyPage(root, "admin.html");
    const client = copyPage(root, "client.html");
    const out = path.join(root, "dist");
    const stdout = execFileSync(process.execPath, [BUILD_SCRIPT, "--out", out, "--embed", admin.path, "--embed", client.path], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.match(stdout, /admin\.html\(admin\) 바꿈/);
    assert.match(stdout, /client\.html\(client\) 바꿈/);
    const adminAfter = fs.readFileSync(admin.path, "utf8");
    const clientAfter = fs.readFileSync(client.path, "utf8");
    assertOnlyHrefChanged(admin.before, adminAfter, hrefs.admin);
    assertOnlyHrefChanged(client.before, clientAfter, hrefs.client);
    for (const variant of ["admin", "client"]) {
      assert.equal(fs.readFileSync(path.join(out, `bookmarklet-${variant}-href.txt`), "utf8"), `${hrefs[variant]}\n`);
      assert.equal(bookmarkletHref(fs.readFileSync(path.join(out, `bookmarklet-${variant}.js`), "utf8")), hrefs[variant]);
    }
    // 주소에 # 이 없어 화면 색 검사(stage5-ui 의 #hex 셈)에 잡히지 않는다('#mi-optfill=' 은 %23 으로 들어감).
    for (const after of [adminAfter, clientAfter]) {
      const inner = after.slice(after.indexOf(MARKER_START), after.indexOf(MARKER_END));
      assert.equal(inner.includes("#"), false);
      assert.ok(inner.includes("%23mi-optfill%3D"));
    }
    // 다시 돌려도 같다.
    const again = execFileSync(process.execPath, [BUILD_SCRIPT, "--out", out, "--embed", admin.path, "--embed", client.path], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.match(again, /admin\.html\(admin\) 이미 같음/);
    assert.match(again, /client\.html\(client\) 이미 같음/);
    assert.equal(fs.readFileSync(admin.path, "utf8"), adminAfter);
    assert.equal(fs.readFileSync(client.path, "utf8"), clientAfter);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("명령: 모르는 파일·표식 없는 화면·겹친 파일이면 실패 코드로 끝나고 어느 파일도 쓰지 않는다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mi-option-check-embed-"));
  try {
    const admin = copyPage(root, "admin.html");
    const clientNoMarker = copyPage(root, "client.html", { addMarkerIfMissing: false });
    const unmarked = clientNoMarker.before.split(MARKER_START).join("").split(MARKER_END).join("");
    fs.writeFileSync(clientNoMarker.path, unmarked);
    const plain = path.join(root, "plain.html");
    fs.writeFileSync(plain, `<html>${MARKER_START}${INITIAL_ANCHOR}${MARKER_END}</html>`);
    const out = path.join(root, "dist");
    const cases = [
      ["모르는 파일", [admin.path, plain], /--embed 는 src\/pages\/admin\.html·src\/pages\/client\.html 만 받습니다/],
      ["표식 없는 광고주 화면", [admin.path, clientNoMarker.path], /표식이 정확히 1쌍/],
      ["겹친 파일", [admin.path, admin.path], /--embed 파일이 겹칩니다/],
    ];
    for (const [name, files, pattern] of cases) {
      const failed = spawnSync(process.execPath, [BUILD_SCRIPT, "--out", out, ...files.flatMap((file) => ["--embed", file])], { cwd: REPO_ROOT, encoding: "utf8" });
      assert.equal(failed.status, 1, name);
      assert.match(failed.stderr, pattern, name);
      assert.equal(fs.readFileSync(admin.path, "utf8"), admin.before, `${name}: 관리자 사본 그대로`);
      assert.equal(fs.readFileSync(clientNoMarker.path, "utf8"), unmarked, `${name}: 광고주 사본 그대로`);
      assert.equal(fs.existsSync(out), false, `${name}: dist 도 만들지 않음`);
    }
    const noValue = spawnSync(process.execPath, [BUILD_SCRIPT, "--embed"], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(noValue.status, 1);
    assert.match(noValue.stderr, /--embed 뒤에 경로가 필요합니다/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("명령: 두 번째 화면 파일을 쓰다 실패하면(폴더 쓰기 막힘) 첫 화면 파일도 그대로이고 임시 파일이 남지 않는다", (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    t.skip("폴더 쓰기 막기를 흉내 낼 수 없는 환경");
    return;
  }
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "mi-option-check-embed-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "mi-option-check-embed-b-"));
  const lockedDir = path.join(rootB, "src", "pages");
  try {
    const admin = copyPage(rootA, "admin.html");
    const client = copyPage(rootB, "client.html");
    fs.chmodSync(lockedDir, 0o555);
    const out = path.join(rootA, "dist");
    const failed = spawnSync(process.execPath, [BUILD_SCRIPT, "--out", out, "--embed", admin.path, "--embed", client.path], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /EACCES|permission/i);
    assert.equal(fs.readFileSync(admin.path, "utf8"), admin.before, "관리자 사본 그대로");
    assert.equal(fs.readFileSync(client.path, "utf8"), client.before, "광고주 사본 그대로");
    assert.deepEqual(fs.readdirSync(path.dirname(admin.path)), ["admin.html"], "임시 파일 없음");
    assert.deepEqual(fs.readdirSync(lockedDir), ["client.html"]);
  } finally {
    fs.chmodSync(lockedDir, 0o755);
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("전체 시험 목록(package.json scripts.test)에 이 폴더 시험이 들어 있다", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(packageJson.scripts.test.includes("tools/naver-option-check/test/*.test.mjs"));
});

test("화면 파일(src/pages/admin.html·client.html)의 버튼이 지금 빌드의 그 화면 변형과 같다", (t) => {
  for (const [relative, variant] of Object.entries(EMBED_PAGE_VARIANTS)) {
    const pagePath = path.join(REPO_ROOT, ...relative.split("/"));
    const html = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, "utf8") : "";
    if (!html.includes(MARKER_START) && !html.includes(MARKER_END)) {
      t.diagnostic(`${relative} 에 버튼 표식이 아직 없습니다(편집창 작업이 넣을 예정)`);
      continue;
    }
    const embedded = readEmbeddedHref(html);
    // 긴 주소 전체를 비교 출력하지 않게 같음 여부만 본다.
    assert.ok(
      embedded === hrefs[variant],
      `${relative} 의 '모먼트 옵션 확인' 버튼이 빌드(${variant})와 다릅니다(지금 ${embedded.length}자${embedded.startsWith("javascript:void") ? ", 아직 빈 링크" : ""} · 빌드 ${hrefs[variant].length}자). `
        + "node tools/naver-option-check/build.mjs --embed src/pages/admin.html --embed src/pages/client.html 을 실행하세요.",
    );
  }
});
