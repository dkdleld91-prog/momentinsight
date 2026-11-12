// 체험 계정 키워드 조회 화면(client.html)의 비교 조회 처리(대표 승인 2026-11-12, 잠금 핵심 기능 runKeywordLookup 변경).
// - 서버가 비교 키워드를 하루 한도로 거절(429 TRIAL_COMPARE_QUOTA)하면 그 키워드만 빼고 첫 키워드 결과는 남긴다.
// - 체험 계정의 후보 비교·시즌 캘린더는 조회 흐름이 이미 받은 비교 키워드를 쓴다(체험은 비교 키워드를 다시 부르지 않는다).
// 브라우저 확인(가짜 서버 ~/.config/momentinsight/trial-preview): 고치기 전에는 결과 전체가 비워지고 비교 표에 첫 키워드만 보였다.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync("src/pages/client.html", "utf8");

function functionBody(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} 함수가 있어야 한다`);
  let depth = 0;
  for (let index = html.indexOf("{", start); index < html.length; index += 1) {
    if (html[index] === "{") depth += 1;
    else if (html[index] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`${name} 함수 끝을 찾지 못함`);
}

test("a compare keyword refused by the trial compare quota is dropped alone; other lookup errors still stop the whole lookup", () => {
  const fetchBody = functionBody("fetchKeywordData");
  assert.match(fetchBody, /lookupError\.code = payload && payload\.code \? String\(payload\.code\) : "";/u, "오류에 서버 코드를 싣는다");
  assert.match(fetchBody, /payload\.code === "TRIAL_QUOTA"/u, "하루 조회 한도(TRIAL_QUOTA) 처리는 그대로");

  const resolveBody = functionBody("resolveKeywordItem");
  assert.match(resolveBody, /if \(index > 0 && error && error\.code === "TRIAL_COMPARE_QUOTA"\) \{\s*return \{ keyword: keyword, data: fallbackData, sourceLabel: "확인 필요", ok: false, quotaMessage: error\.message \};/u);
  assert.match(resolveBody, /throw error;/u, "그 밖의 오류(첫 키워드 실패 포함)는 예전처럼 던진다");
  const code = resolveBody.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.equal((code.match(/error\.code === "/gu) || []).length, 1, "비교 한도 코드 하나만 따로 다룬다(주석 제외)");
});

test("the lookup keeps every resolved item, judges data status without the refused keywords, and prefixes the quota note to it", () => {
  const runBody = functionBody("runKeywordLookup");
  assert.match(runBody, /keywordLookupItems = items;\s*keywordDatasets = items;/u);
  assert.match(runBody, /var shownItems = items\.filter\(function \(item\) \{ return !item\.quotaMessage; \}\);/u);
  for (const name of ["failed", "pendingTrend", "missingVolume"]) {
    assert.match(runBody, new RegExp(`var ${name} = shownItems\\.filter`, "u"), `${name} 는 한도로 빠진 키워드를 빼고 판단한다`);
  }
  assert.match(runBody, /var report = function \(text, tone\) \{ setStatus\(keywordStatus, quotaNote \+ text, quotaNote \? "is-warn" : tone\); \};/u, "비교 한도 안내와 첫 키워드 데이터 상태를 함께 보여 준다");
  const resultBranch = runBody.slice(runBody.indexOf("var compareShown"), runBody.indexOf("} catch (error)"));
  assert.ok(resultBranch.length > 0);
  assert.doesNotMatch(resultBranch, /setStatus\(keywordStatus/u, "성공 결과 안내는 모두 report 로 낸다(오류 안내는 그대로)");
});

test("only trial sessions reuse the lookup's compare items (with the lookup's own keyword list and a basis note), and logout clears them", () => {
  const compareBody = functionBody("loadKeywordCompare");
  assert.match(compareBody, /var trialLookup = secureClientSession\.trial === true && keywordLookupItems\.length && keywordLookupItems\[0\] && keywordLookupItems\[0\]\.keyword === first\.keyword;/u, "체험이고 같은 조회의 결과일 때만");
  assert.match(compareBody, /trialLookup \? keywordLookupItems\.slice\(1\)/u, "체험은 조회 때 확정한 키워드 목록을 쓴다(입력이 바뀌어도)");
  assert.match(compareBody, /if \(trialLookup\) \{\s*keywordLookupItems\.forEach\(function \(entry\) \{[\s\S]*?if \(entry && entry\.ok !== false && entry\.keyword && entry\.data && !known\[entry\.keyword\]\) known\[entry\.keyword\] = entry;/u,
    "한도로 거절된 항목(ok:false)은 빼고, 이미 아는 키워드는 덮어쓰지 않는다");
  assert.match(functionBody("renderKeywordCompare"), /var basisNote = keywordBasisNote\(rows\);/u, "비교 표에 실제 기간 기준 안내");
  assert.match(functionBody("renderKeywordSeason"), /keywordBasisNote\(items\)/u, "시즌 캘린더에 실제 기간 기준 안내");
  assert.match(functionBody("resetKeywordCompare"), /keywordLookupItems = \[\];/u, "로그아웃 때 앞 사람의 조회 결과를 비운다");
  assert.match(html, /var keywordLookupItems = \[\];/u);
});

test("the basis note reads each keyword's real month basis and appears only when the bases differ", () => {
  const body = functionBody("keywordBasisNote");
  const labels = { "2016_current_search_ratio": "2016년부터 누적", "recent_12_month_trend_ratio": "최근 12개월" };
  const keywordBasisNote = new Function("KEYWORD_MONTH_BASIS_LABEL", `${body}; return keywordBasisNote;`)(labels);
  const row = (keyword, monthBasis) => ({ keyword, data: { monthBasis } });
  assert.equal(keywordBasisNote([row("원두", "2016_current_search_ratio"), row("온수매트", "2016_current_search_ratio")]), "");
  assert.equal(keywordBasisNote([row("원두", "recent_12_month_trend_ratio"), row("온수매트", "recent_12_month_trend_ratio")]), "", "첫 키워드의 장기 자료가 실패해 둘 다 12개월이면 안내하지 않는다");
  assert.equal(keywordBasisNote([row("원두", "2016_current_search_ratio"), row("온수매트", "recent_12_month_trend_ratio"), row("담요", "")]),
    "피크 달 기준 기간이 키워드마다 다릅니다: 원두 2016년부터 누적 · 온수매트 최근 12개월.");
  assert.equal(keywordBasisNote([]), "");
});
