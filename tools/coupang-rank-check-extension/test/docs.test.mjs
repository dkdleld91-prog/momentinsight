// 대표용 안내(README)와 docs/COUPANG_RANK_MANUAL_CHECK.md 가 같은 순서·같은 문장인지, 지난 반박 검토의 안내가 빠지지 않았는지.
import assert from "node:assert/strict";
import test from "node:test";
import { readExtension, readRepo } from "./helpers.mjs";
import { ZIP_FOLDER, zipFileName } from "../../../scripts/build-coupang-check-extension.mjs";

const readme = readExtension("README.md");
const docs = readRepo("docs/COUPANG_RANK_MANUAL_CHECK.md");
const manifest = JSON.parse(readExtension("manifest.json"));

function sections(text) {
  return [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

function commonPart(text) {
  return text.slice(text.indexOf("## 1."), text.indexOf("## 9.") >= 0 ? text.indexOf("## 9.") : undefined).trimEnd();
}

test("docs 1~8장은 README 와 같은 순서·같은 문장이고, 9장부터 개발·운영 메모가 붙는다", () => {
  const readmeSections = sections(readme);
  assert.deepEqual(sections(docs).slice(0, readmeSections.length), readmeSections);
  assert.equal(commonPart(docs), commonPart(readme));
  assert.ok(sections(docs).length > readmeSections.length);
});

test("설치 안내: zip 이름·고정 폴더·두는 곳·개발자 모드 유지·메뉴 이름·사이트 액세스·Profile 3·5 금지", () => {
  for (const piece of [
    zipFileName(manifest.version),
    `\`${ZIP_FOLDER}\``,
    "모먼트인사이트",
    "Profile 3",
    "Profile 5",
    "chrome://version",
    "chrome://extensions",
    "개발자 모드는 계속 켜 두세요",
    "Load unpacked(압축해제된 확장 프로그램 로드)",
    "Allow in Incognito(시크릿 모드에서 허용)",
    "Site access(사이트 액세스)",
    "다른 확장들의 '시크릿 모드에서 허용'은 꺼 두세요",
    "열려 있는 시크릿 창을 모두 닫아 주세요",
    "지금 확인 끄기",
    "크롬에서만",
    "확장 ID",
  ]) {
    assert.ok(readme.includes(piece), piece);
  }
  assert.doesNotMatch(readme, /mi-coupang-check-1\.0\.0\/|압축해제된 확장 프로그램을 로드합니다/, "버전 붙은 폴더·옛 메뉴 이름 없음");
  assert.doesNotMatch(readme, /문서\(Documents\) 폴더로 옮기/);
  assert.ok(readme.includes("onbmdfamcmbljplkgalameendlmgnjeg"));
});
