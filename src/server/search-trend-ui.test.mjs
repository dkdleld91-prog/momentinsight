import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const client = read("src/pages/client.html");
const admin = read("src/pages/admin.html");
const script = read("public/mi-search-trend.js");
const css = read("public/mi-search-trend.css");

function load() {
  const window = { document: null };
  const context = vm.createContext({ window, TextEncoder, Uint8Array, Uint32Array, DataView, Date, Math, Object, Array, String, Number, JSON, Blob: undefined });
  vm.runInContext(script, context);
  return window.MomentSearchTrend;
}
const trend = load();
const plain = (value) => JSON.parse(JSON.stringify(value));

test("관리자 화면에만 메뉴·화면·파일이 연결되어 있다(네이버 답변 2026-11-13: 데이터랩은 직원 내부용만)", () => {
  assert.ok(admin.includes('href="/mi-search-trend.css?v='));
  assert.ok(admin.includes('<script src="/mi-search-trend.js?v='));
  assert.equal([...admin.matchAll(/data-search-trend><\/div>/g)].length, 1);
  assert.ok(admin.includes('data-mi-admin-screen="search-trend">검색어 트렌드</a>'));
  assert.ok(admin.includes('data-mi-admin-view="search-trend"'));
  // 광고주·체험 화면(client.html)에는 메뉴·화면·파일 어느 것도 없다. 서버도 직원이 아니면 STAFF_ONLY 로 거절한다.
  for (const marker of ["mi-search-trend.css", "mi-search-trend.js", "data-search-trend", 'data-mi-screen="search-trend"', 'data-mi-view="search-trend"']) {
    assert.equal(client.includes(marker), false, `광고주 화면에 ${marker} 가 없어야 한다`);
  }
});

test("체험 계정 메뉴는 숨기고 화면 글자는 textContent 로만 넣는다", () => {
  assert.match(css, /#mi-clean\.is-trial \[data-mi-screen="search-trend"\] \{ display: none !important; \}/);
  assert.equal(script.includes("innerHTML"), false);
  assert.equal(script.includes("insertAdjacentHTML"), false);
});

test("조회 경로는 세션 게이트가 이미 아는 키워드 조사 경로를 쓴다", () => {
  assert.ok(script.includes('"/api/client/keyword-research?mode=search-trend"'));
  assert.ok(script.includes('"x-mi-csrf"'));
});

test("연령 11구간이 데이터랩 코드와 1:1 로 맞는다", () => {
  const match = script.match(/var AGE_OPTIONS = (\[.*?\]\]);/s);
  const options = JSON.parse(match[1]);
  assert.equal(options.length, 11);
  assert.deepEqual(options.map((entry) => entry[0]), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.equal(options[0][1], "~12");
  assert.equal(options[10][1], "60~");
});

test("기간 버튼 계산: 월말을 넘기지 않고 2016년 이전으로 가지 않는다", () => {
  assert.equal(trend.presetStart("1m", "2026-03-31"), "2026-02-28");
  assert.equal(trend.presetStart("3m", "2026-11-08"), "2026-08-08");
  assert.equal(trend.presetStart("1y", "2026-02-28"), "2025-02-28");
  assert.equal(trend.presetStart("all", "2026-11-08"), "2016-01-01");
  assert.equal(trend.presetStart("1y", "2016-03-01"), "2016-01-01");
  assert.equal(trend.latestDate(Date.parse("2026-11-08T15:30:00Z")), "2026-11-08");
});

test("검색어 나누기는 빈 값과 중복을 정리한다", () => {
  assert.deepEqual(plain(trend.splitKeywords(" 캠핑 , Camping,camping,, 겨울  캠핑 ")), ["캠핑", "Camping", "겨울 캠핑"]);
});

test("입력 줄 위치를 색 번호로 유지하고 평균·최고점을 받은 값으로만 계산한다", () => {
  const model = trend.buildModel({
    conditions: { startDate: "2026-01-01", endDate: "2026-01-03", timeUnit: "date" },
    results: [
      { title: "a", keywords: ["a"], data: [{ period: "2026-01-01", ratio: 10 }, { period: "2026-01-03", ratio: 100 }] },
      { title: "b", keywords: ["b"], data: [] },
    ],
  }, [2, 4]);
  assert.deepEqual(plain(model.series.map((item) => item.slot)), [2, 4]);
  assert.deepEqual(plain(model.periods), ["2026-01-01", "2026-01-03"]);
  assert.equal(model.series[0].average, 55);
  assert.equal(model.series[0].peak.period, "2026-01-03");
  assert.equal(model.series[1].average, null);
  assert.equal(model.series[1].byPeriod["2026-01-01"], undefined);
});

test("네이버가 건너뛴 구간에서 선을 끊는다", () => {
  const point = (date) => ({ period: date, time: Date.parse(`${date}T00:00:00Z`), value: 1 });
  assert.equal(trend.segmentsOf(["2026-01-01", "2026-01-02", "2026-01-05", "2026-01-06"].map(point), "date").length, 2);
  assert.equal(trend.segmentsOf(["2026-01-05", "2026-01-12", "2026-01-26"].map(point), "week").length, 2);
  assert.equal(trend.segmentsOf(["2025-12-01", "2026-01-01", "2026-02-01"].map(point), "month").length, 1);
  assert.equal(trend.segmentsOf(["2025-12-01", "2026-02-01"].map(point), "month").length, 2);
  assert.equal(trend.segmentsOf(["2026-01-01", "2026-01-05"].map(point), "week").length, 1, "시작일이 낀 첫 구간은 끊지 않는다");
});

test("그리는 점을 줄여도 양 끝과 최고점은 남는다", () => {
  const values = Array.from({ length: 2000 }, (_, index) => Math.sin(index / 40) * 10 + 20);
  values[1234] = 100;
  const picked = plain(trend.thinIndices(values, 400, 1234));
  assert.ok(picked.length <= 402);
  assert.equal(picked[0], 0);
  assert.equal(picked[picked.length - 1], 1999);
  assert.ok(picked.includes(1234));
  assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
  assert.equal(new Set(picked).size, picked.length);
  assert.equal(trend.thinIndices([1, 2, 3], 400, 1).length, 3);
});

test("기간 길이에 맞춰 축 눈금을 고른다", () => {
  const days = (from, count, step = 1) => Array.from({ length: count }, (_, index) => new Date(Date.parse(`${from}T00:00:00Z`) + index * step * 86400000).toISOString().slice(0, 10));
  assert.deepEqual(plain(trend.xTicks(days("2021-11-08", 1827)).map((tick) => tick.label)), ["2022년", "2023년", "2024년", "2025년", "2026년"]);
  const year = plain(trend.xTicks(days("2025-11-08", 366)));
  assert.ok(year.some((tick) => tick.label === "2026년 1월" && tick.major));
  assert.ok(plain(trend.xTicks(days("2026-08-08", 92))).every((tick) => /월$/.test(tick.label)));
  assert.ok(plain(trend.xTicks(days("2026-10-08", 30))).every((tick) => /^\d+\.\d+$/.test(tick.label)));
});

test("조건 표시는 조회한 값을 그대로 쓴다", () => {
  assert.deepEqual(plain(trend.conditionTexts({ startDate: "2026-01-01", endDate: "2026-02-01", timeUnit: "week", device: "mo", gender: "f", ages: ["4", "11"] })), [
    "2026.01.01 ~ 2026.02.01", "주간", "범위 모바일", "성별 여성", "연령 25~29, 60~",
  ]);
  assert.deepEqual(plain(trend.conditionTexts({ startDate: "2026-01-01", endDate: "2026-02-01", timeUnit: "date", device: "", gender: "", ages: [] })).slice(2), ["범위 전체", "성별 전체", "연령 전체"]);
});

function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = Buffer.from(bytes.slice(offset + 30, offset + 30 + nameLength)).toString("utf8");
    files[name] = Buffer.from(bytes.slice(offset + 30 + nameLength, offset + 30 + nameLength + size)).toString("utf8");
    offset += 30 + nameLength + size;
  }
  return files;
}

test("계정이 바뀌면 입력과 결과를 비우고 숨긴 동안 온 결과는 다시 그린다", () => {
  assert.ok(script.includes('window.addEventListener("mi:rank-auth-ready", checkIdentity)'));
  assert.ok(script.includes("if (knownIdentity && identity !== knownIdentity) { epoch += 1; controller.reset(); }"));
  assert.ok(script.includes("if (!width) { state.lastWidth = 0; return; }"));
  const runStart = script.indexOf("async function run()");
  assert.ok(script.indexOf("state.requestId = id;", runStart) < script.indexOf("var request = requestBody();", runStart), "입력 검사 전에 앞 조회를 무효로 한다");
});

test("엑셀에서 이모지와 한글을 지우지 않고 제어 문자만 뺀다", () => {
  const model = trend.buildModel({ conditions: { startDate: "2026-01-01", endDate: "2026-01-01", timeUnit: "date" }, results: [{ title: "캠핑😀\u0001", keywords: ["a"], data: [{ period: "2026-01-01", ratio: 1 }] }] }, [0]);
  const sheet = unzip(new Uint8Array(trend.workbookBytes(model)))["xl/worksheets/sheet1.xml"];
  assert.ok(sheet.includes("캠핑😀"));
  assert.equal(sheet.includes("\u0001"), false);
});

test("엑셀에 조회 조건을 함께 적고 없는 구간은 비우며 특수문자를 안전하게 넣는다", () => {
  const model = trend.buildModel({
    conditions: { startDate: "2026-01-01", endDate: "2026-01-02", timeUnit: "date", device: "", gender: "", ages: [] },
    results: [{ title: "A&B<x>", keywords: ["a"], data: [{ period: "2026-01-01", ratio: 12.5 }] }, { title: "둘", keywords: ["둘"], data: [{ period: "2026-01-02", ratio: 100 }] }],
  }, [0, 1]);
  const rows = plain(trend.workbookRows(model));
  assert.match(rows[1][0].text, /2026\.01\.01 ~ 2026\.01\.02/);
  assert.match(rows[2][0].text, /100/);
  const header = rows.findIndex((row) => row[0]?.text === "날짜");
  assert.deepEqual(rows[header + 1], [{ text: "2026.01.01" }, { number: 12.5 }, {}]);
  const files = unzip(new Uint8Array(trend.workbookBytes(model)));
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  const sheet = files["xl/worksheets/sheet1.xml"];
  assert.ok(sheet.includes("A&amp;B&lt;x&gt;"));
  assert.equal(sheet.includes("A&B<x>"), false);
  assert.ok(sheet.includes("<v>12.5</v>"));
});
