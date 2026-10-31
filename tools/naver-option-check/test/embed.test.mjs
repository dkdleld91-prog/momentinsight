// build.mjs --embed 시험: 관리자 화면의 표식 사이 링크 href 만 바꾸고, 표식이 틀리면 큰 소리로 실패한다.
// 마지막 시험은 저장소의 src/pages/admin.html 이 지금 빌드와 같은 버튼을 품고 있는지 본다(표식이 아직 없으면 건너뜀).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MARKER_END,
  MARKER_START,
  REPO_ROOT,
  assertServerRulesMatch,
  bookmarkletHref,
  buildBookmarkletCode,
  embedBookmarklet,
  readEmbeddedHref,
  readServerOptionRules,
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

const href = bookmarkletHref(buildBookmarkletCode());

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

test("명령: --embed 는 표식 사이만 고쳐 쓰고, 표식이 없으면 파일을 그대로 둔 채 실패 코드로 끝난다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mi-option-check-embed-"));
  try {
    const page = path.join(dir, "admin.html");
    const out = path.join(dir, "dist");
    fs.writeFileSync(page, PAGE);
    execFileSync(process.execPath, [BUILD_SCRIPT, "--out", out, "--embed", page], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(readEmbeddedHref(fs.readFileSync(page, "utf8")), href);
    assert.equal(fs.readFileSync(path.join(out, "bookmarklet-href.txt"), "utf8"), `${href}\n`);
    assert.equal(bookmarkletHref(fs.readFileSync(path.join(out, "bookmarklet.js"), "utf8")), href);

    const plain = path.join(dir, "plain.html");
    fs.writeFileSync(plain, "<html>표식 없음</html>");
    const failed = spawnSync(process.execPath, [BUILD_SCRIPT, "--out", out, "--embed", plain], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /표식이 정확히 1쌍/);
    assert.equal(fs.readFileSync(plain, "utf8"), "<html>표식 없음</html>");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("전체 시험 목록(package.json scripts.test)에 이 폴더 시험이 들어 있다", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(packageJson.scripts.test.includes("tools/naver-option-check/test/*.test.mjs"));
});

test("관리자 화면(src/pages/admin.html)의 버튼이 지금 빌드와 같다", (t) => {
  const adminPath = path.join(REPO_ROOT, "src", "pages", "admin.html");
  const html = fs.existsSync(adminPath) ? fs.readFileSync(adminPath, "utf8") : "";
  if (!html.includes(MARKER_START) && !html.includes(MARKER_END)) {
    t.skip("admin.html 에 버튼 표식이 아직 없습니다(편집창 작업이 넣을 예정)");
    return;
  }
  const embedded = readEmbeddedHref(html);
  // 긴 주소 전체를 비교 출력하지 않게 같음 여부만 본다.
  assert.ok(
    embedded === href,
    `admin.html 의 '모먼트 옵션 확인' 버튼이 빌드와 다릅니다(지금 ${embedded.length}자${embedded === "javascript:void(0)" ? ", 아직 빈 링크" : ""} · 빌드 ${href.length}자). `
      + "node tools/naver-option-check/build.mjs --embed src/pages/admin.html 을 실행하세요.",
  );
});
