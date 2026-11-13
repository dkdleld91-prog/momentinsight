// 네이버 답변(2026-11-13, 대표 승인 같은 날): 데이터랩(검색어 트렌드·쇼핑인사이트)은 회사 직원 내부용만 가능하고
// 광고주·체험 계정에 데이터나 가공 결과를 보여 주는 것은 불가. 서버가 값을 지우는 것(naver-keyword-external.test 등)과
// 별개로, 광고주 화면(client.html)도 데이터랩 블록을 보이지 않고 그 값을 쓰지 않는지 확인한다.
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
const codeOnly = (source) => source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

function hiddenBlocks() {
  const blocks = [];
  const opener = '<div hidden aria-hidden="true" data-keyword-datalab-hidden>';
  let from = 0;
  for (;;) {
    const start = html.indexOf(opener, from);
    if (start < 0) break;
    let depth = 0;
    const tag = /<\/?div\b[^>]*>/gu;
    tag.lastIndex = start;
    let end = -1;
    for (let match = tag.exec(html); match; match = tag.exec(html)) {
      depth += match[0].startsWith("</") ? -1 : 1;
      if (depth === 0) { end = match.index + match[0].length; break; }
    }
    assert.ok(end > start, "숨김 블록이 닫혀야 한다");
    blocks.push(html.slice(start, end));
    from = end;
  }
  return blocks;
}

test("키워드 조회의 데이터랩 블록(추이·월별/요일별 비율·연령·성별·시즌 캘린더)은 숨김 블록 안에만 있다", () => {
  const blocks = hiddenBlocks();
  assert.equal(blocks.length, 2, "추이~누가 묶음 하나, 시즌 캘린더 하나");
  const hidden = blocks.join("\n");
  // 마크업(여는 태그) 기준으로 본다 — 같은 이름이 CSS 선택자·렌더 코드에도 나오기 때문.
  for (const marker of ['<article class="mi-card mi-keyword-chart">', 'data-keyword-ratio-chart="month" style', 'data-keyword-ratio-chart="week" style', 'data-keyword-ratio-chart="age" style', '<div data-keyword-profile="gender"></div>', '<div class="mi-season" data-keyword-season>', '<div class="mi-yoy" data-keyword-yoy hidden']) {
    assert.ok(hidden.includes(marker), `${marker} 는 숨김 블록 안`);
    const outside = blocks.reduce((source, block) => source.replace(block, ""), html);
    assert.equal(outside.includes(marker), false, `${marker} 가 숨김 블록 밖에 없다`);
  }
  assert.match(html, /data-keyword-datalab-note>[^<]*네이버 이용 정책에 따라 제공하지 않습니다\.<\/p>/u, "제공하지 않는 이유를 화면에 적는다");
});

test("보이는 블록 번호는 1~5로 이어지고, 핵심 요약에는 언제·누가(데이터랩) 줄이 없다", () => {
  const outside = hiddenBlocks().reduce((source, block) => source.replace(block, ""), html);
  const view = outside.slice(outside.indexOf('id="mi-keyword-tool"'), outside.indexOf('id="mi-keyword-tool"') + 40000);
  const numbers = [...view.matchAll(/<div class="mi-kw-sec"><span class="n">(\d+)<\/span>/gu)].map((match) => Number(match[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5]);
  assert.equal(html.includes('data-keyword-summary="when"'), false);
  assert.equal(html.includes('data-keyword-summary="who"'), false);
  // 이동 번호(data-kw-jump)는 숨김 포함 .mi-kw-sec 순서다: 5번째 = 광고 비용, 6번째 = 후보 비교.
  const all = [...html.matchAll(/<div class="mi-kw-sec"><span class="n">\d+<\/span><div><h2>([^<]+)<\/h2>/gu)].map((match) => match[1]);
  assert.equal(all[4], "광고를 건다면 얼마인가");
  assert.equal(all[5], "후보 키워드 비교");
  assert.match(html, /data-kw-jump="5"><i>얼마<\/i>/u);
  assert.match(html, /data-kw-jump="6"><i>대안<\/i>/u);
});

test("가장 많이 찾는 달 칸은 검색광고 모바일 검색 비중으로 바뀌고, 저장·내보내기·노트에도 피크 달이 없다", () => {
  assert.equal(html.includes('data-keyword-kpi="peakMonth"'), false);
  assert.match(html, /<span>모바일 검색 비중<\/span><b data-keyword-kpi="mobileShare">/u);
  assert.equal(codeOnly(functionBody("keywordExportSummary")).includes("가장 많이 찾는 달"), false);
  assert.match(functionBody("keywordExportSummary"), /\["모바일 검색 비중", keywordExportText\('\[data-keyword-kpi="mobileShare"\]'\)/u);
  const note = codeOnly(functionBody("saveKeywordNote"));
  assert.match(note, /peakMonth: ""/u, "노트에 피크 달을 넣지 않는다");
  assert.doesNotMatch(note, /data\.month|monthLabels/u);
});

test("보이는 1번 블록(히어로)에 데이터랩 추이로 계산한 '전월 대비'를 쓰지 않는다", () => {
  assert.doesNotMatch(codeOnly(html), /setKeywordText\("\[data-keyword-market-status\]"[^;]*전월 대비/u);
});

test("조회 상태 문구는 데이터랩 비율·시즌 캘린더를 약속하지 않는다", () => {
  const run = codeOnly(functionBody("runKeywordLookup"));
  assert.doesNotMatch(run, /비율 데이터는 연결 후|검색 비율을 표시|시즌 캘린더에 표시/u);
  assert.match(run, /나머지 " \+ compareShown \+ "개는 비교 표에 표시합니다\./u);
});

test("비교 키워드는 연령(데이터랩)을 채우려고 다시 부르지 않는다", () => {
  const compare = codeOnly(functionBody("loadKeywordCompare"));
  assert.match(compare, /if \(entry && entry\.data\) return Promise\.resolve\(\);/u);
  assert.doesNotMatch(compare, /hasRatioValues\(entry\.data\.age/u);
});

test("홈 '내 키워드 지표'는 지난주 대비 증감률(데이터랩) 없이 검색광고 월 검색수 순으로 그린다", () => {
  const render = codeOnly(functionBody("renderHomeVolumeRows"));
  assert.doesNotMatch(render, /changePct/u, "증감률을 쓰지 않는다");
  assert.match(render, /Number\(b\.monthlyVolume\) - Number\(a\.monthlyVolume\)/u);
  assert.match(html, /<h4>월 검색수 TOP<\/h4>/u);
  assert.equal(html.includes("데이터랩 상대지수"), false);

  // 그리기 확인: 증감률이 있어도(직원 미리보기) 화면은 월 검색수만 쓴다.
  const nodes = [];
  const makeNode = (tag, className, text) => ({ tag, className: className || "", textContent: text || "", children: [], style: {}, appendChild(child) { this.children.push(child); return child; } });
  const container = makeNode("div");
  container.appendChild = function (child) { this.children.push(child); nodes.push(child); return child; };
  const renderHomeVolumeRows = new Function("homeNode", "homeReplace", "document", `${functionBody("renderHomeVolumeRows")}; return renderHomeVolumeRows;`)(
    (tag, className, text) => makeNode(tag, className, text),
    (target, node) => { target.children = [node]; },
    { createElement: (tag) => makeNode(tag) },
  );
  renderHomeVolumeRows(container, { ok: true, volumeChange: [
    { keyword: "담요", monthlyVolume: 900, changePct: 40 },
    { keyword: "원두", monthlyVolume: 6300, changePct: -12 },
    { keyword: "없음", monthlyVolume: null, changePct: 5 },
  ] });
  assert.deepEqual(container.children.map((row) => row.children[0].textContent), ["원두", "담요"], "월 검색수 큰 순, 검색수 없는 줄은 뺀다");
  assert.deepEqual(container.children.map((row) => row.children.map((child) => child.className)), [["mi-home-kw", "mi-home-bar", "mi-home-vol"], ["mi-home-kw", "mi-home-bar", "mi-home-vol"]]);
  assert.equal(container.children[0].children[1].children[0].style.width, "100%");
  assert.equal(container.children[1].children[1].children[0].style.width, "14%");
  const empty = makeNode("div");
  renderHomeVolumeRows(empty, { ok: false });
  assert.equal(empty.children[0].textContent, "등록한 키워드의 월 검색수가 아직 없습니다.");
});

test("광고주 화면 홈은 view=client 로 불러 미리보기(총관리자·운영팀)도 광고주와 같은 응답을 받는다", () => {
  assert.match(html, /miFetch\(getHomeFeedApiUrl\(\) \+ "\?view=client", \{ method: "GET", cache: "no-store" \}\)/u);
});

test("모바일 비중은 '< 10' 칸을 0~9 범위로 보고, 정해지지 않으면 범위나 '확인 필요'로 보인다", () => {
  const helpers = new Function("keywordNumber", "keywordPercent", `${functionBody("keywordCountRange")}; ${functionBody("keywordMobileShare")}; return keywordMobileShare;`);
  const keywordNumber = (value) => { const number = Number(String(value ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(number) ? number : 0; };
  const keywordPercent = (value, digits) => { const factor = 10 ** (digits || 0); return `${Math.round(value * factor) / factor}%`; };
  const share = helpers(keywordNumber, keywordPercent);
  assert.deepEqual(share({ monthlyPcQcCnt: "1000", monthlyMobileQcCnt: "3000" }), { text: "75%", pcText: "25%", exact: true });
  assert.equal(share({ monthlyPcQcCnt: "< 10", monthlyMobileQcCnt: "5000" }).text, "100%", "범위가 좁아 한 값으로 정해짐(99.8~100%)");
  assert.equal(share({ monthlyPcQcCnt: "< 10", monthlyMobileQcCnt: "100" }).text, "92~100%");
  assert.equal(share({ monthlyPcQcCnt: "< 10", monthlyMobileQcCnt: "< 10" }).text, "확인 필요");
  assert.equal(share({ monthlyPcQcCnt: "0", monthlyMobileQcCnt: "0" }).text, "확인 필요");
});

test("홈 월 검색수에 '10 미만'이 섞이면 '1,230+' 또는 '20 미만'으로 보인다", () => {
  const render = functionBody("renderHomeVolumeRows");
  assert.match(render, /row\.volumeLowerBound \? \(volume > 0 \? volume\.toLocaleString\("ko-KR"\) \+ "\+" : "20 미만"\)/u);
});

test("광고주 화면은 분야 트렌드·구매층(쇼핑인사이트)·검색량 증감(데이터랩)을 앞으로 준다고 안내하지 않는다", () => {
  assert.doesNotMatch(html, /분야 트렌드·구매층 비중은 준비되면 추가|검색량 증감·분야 트렌드/u);
});
