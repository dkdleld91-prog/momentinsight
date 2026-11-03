// 이용약관·개인정보처리방침(2026-11-03 v1.1 개정·약관 신설) 시험.
// 문서에 적은 숫자(유예 5일, 자동 로그인 30일, 체험 하루 5회, 백업 14회분, 방문 집계 120일)가 코드 값과 같은지 묶어 둔다 —
// 코드를 바꾸면 이 시험이 깨져 문서도 함께 고치게 한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PLAN_GRACE_DAYS, PLAN_WARN_DAYS } from "./account-plan.mjs";
import { PERSISTENT_SESSION_SECONDS, TRIAL_KEYWORD_DAILY_LIMIT } from "./code-session.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const privacy = read("src/pages/privacy.html");
const privacyV10 = read("src/pages/privacy-v1-0.html");
const terms = read("src/pages/terms.html");

const NOTICE_DATE = "2026-11-03";
const EFFECTIVE_DATE = "2026-11-10";

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
}

function tocTargetsExist(html) {
  const targets = [...html.matchAll(/<a href="#([^"]+)">/g)].map((match) => match[1]);
  assert.ok(targets.length > 10, "목차가 있어야 한다");
  for (const id of targets) assert.ok(html.includes(`id="${id}"`), `목차 #${id} 가 본문에 있어야 한다`);
}

test("세 문서는 인라인 스크립트가 없어 CSP 해시를 바꾸지 않는다", () => {
  for (const [name, html] of [["privacy", privacy], ["privacy-v1-0", privacyV10], ["terms", terms]]) {
    assert.deepEqual(inlineScripts(html), [], `${name} 에 인라인 스크립트가 없어야 한다`);
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/, `${name} 는 검색 제외`);
  }
});

test("개인정보처리방침 v1.1: 공고일·시행일이 머리말과 제13조에서 같고, 이전 버전과 약관으로 이어진다", () => {
  assert.ok(privacy.includes("버전 · v1.1"));
  assert.ok(privacy.includes(`공고일 · ${NOTICE_DATE}`) && privacy.includes(`시행일 · ${EFFECTIVE_DATE}`));
  assert.ok(privacy.includes(`<li>공고일자: ${NOTICE_DATE}</li>`) && privacy.includes(`<li>시행일자: ${EFFECTIVE_DATE}</li>`));
  assert.ok(privacy.includes(`본 개인정보처리방침은 ${EFFECTIVE_DATE}부터 적용됩니다.`));
  assert.ok(privacy.includes('href="/privacy-v1-0"'));
  assert.ok(privacy.includes('href="/terms"'));
  assert.ok(privacy.includes('canonical" href="https://insight.momentlabs.co.kr/privacy"'));
  tocTargetsExist(privacy);
});

test("개인정보처리방침 v1.1 은 코드의 실제 값과 같은 숫자를 적는다", () => {
  assert.equal(PLAN_GRACE_DAYS, 5);
  assert.ok(privacy.includes(`만료 뒤 <b>${PLAN_GRACE_DAYS}일</b>의 유예 기간`));
  assert.equal(PERSISTENT_SESSION_SECONDS, 30 * 24 * 60 * 60);
  assert.ok(privacy.includes("이 기기에서 30일 유지"));
  assert.ok(privacy.includes("&lsquo;자동 로그인&rsquo; 선택 시 30일"));
  // 백업 보관 개수와 방문 집계 보관 기간
  assert.match(read("scripts/db-export.mjs"), /keep: 14,/);
  assert.ok(privacy.includes("최근 <b>14회분</b>"));
  assert.match(read("src/server/handlers/site-events.mjs"), /p_keep_days: 120/);
  assert.ok(privacy.includes("120일이 지난 기록"));
  // 위탁·보관 위치
  for (const word of ["Vercel Inc.", "Supabase Inc.", "Google LLC", "Anthropic PBC", "OpenAI", "AWS ap-northeast-2"]) {
    assert.ok(privacy.includes(word), word);
  }
});

test("이전 버전 v1.0 은 원문을 그대로 두고 맨 위에 개정 안내만 붙인다", () => {
  assert.ok(privacyV10.includes("버전 · v1.0"));
  assert.ok(privacyV10.includes("data-privacy-archive-notice"));
  assert.ok(privacyV10.includes('canonical" href="https://insight.momentlabs.co.kr/privacy-v1-0"'));
  assert.ok(!privacyV10.includes("mi-analytics.js"), "이전 버전 페이지에는 방문 통계를 싣지 않는다");
  assert.ok(privacyV10.includes("본 개인정보처리방침은 2026-08-24부터 적용됩니다."));
});

test("이용약관: 공고일·시행일, 만료 뒤 유예·삭제, 체험 한도가 코드 값과 같다", () => {
  assert.ok(terms.includes(`공고일 · ${NOTICE_DATE}`) && terms.includes(`시행일 · ${EFFECTIVE_DATE}`));
  assert.ok(terms.includes(`<li>공고일자: ${NOTICE_DATE}</li>`) && terms.includes(`<li>시행일자: ${EFFECTIVE_DATE}</li>`));
  assert.ok(terms.includes('canonical" href="https://insight.momentlabs.co.kr/terms"'));
  assert.ok(!terms.includes("mi-analytics.js"), "약관 페이지에는 방문 통계를 싣지 않는다");
  assert.ok(terms.includes(`만료 뒤 <b>${PLAN_GRACE_DAYS}일</b>(유예 기간)`));
  assert.equal(PLAN_WARN_DAYS, 3);
  assert.ok(terms.includes(`만료 ${PLAN_WARN_DAYS}일 전부터`));
  assert.equal(TRIAL_KEYWORD_DAILY_LIMIT, 5);
  assert.ok(terms.includes(`키워드 조회(하루 ${TRIAL_KEYWORD_DAILY_LIMIT}회`));
  assert.ok(terms.includes("최대 30일 동안 로그인이 유지됩니다"));
  assert.ok(terms.includes('href="/privacy"'));
  tocTargetsExist(terms);
});

test("새 페이지는 빌드·주소·필수 산출물 목록에 들어 있다", () => {
  const build = read("scripts/build-vercel-static.mjs");
  assert.ok(build.includes('terms: "terms.html"') && build.includes('"privacy-v1-0": "privacy-v1-0.html"'));
  const rewrites = JSON.parse(read("vercel.json")).rewrites || [];
  for (const [source, destination] of [["/terms", "/terms.html"], ["/privacy-v1-0", "/privacy-v1-0.html"]]) {
    assert.ok(rewrites.some((rule) => rule.source === source && rule.destination === destination), source);
  }
  const security = read("scripts/check-public-build-security.mjs");
  assert.ok(security.includes('"terms.html", "privacy-v1-0.html"'));
});

test("개인정보처리방침으로 이어지는 모든 하단·가입 안내에 이용약관 링크도 있다", () => {
  for (const file of [
    "src/pages/home.html",
    "src/pages/guide-naver-shopping-rank-tracking.html",
    "src/pages/guide-naver-keyword-search-volume.html",
    "src/pages/privacy.html",
    "src/pages/terms.html",
    "src/pages/privacy-v1-0.html",
    "public/related-keywords.html",
    "src/server/handlers/news-page.mjs",
    "src/pages/client.html",
  ]) {
    const source = read(file);
    assert.ok(source.includes('href="/privacy"'), `${file} 에 개인정보처리방침 링크`);
    assert.ok(source.includes('href="/terms"'), `${file} 에 이용약관 링크`);
  }
});
