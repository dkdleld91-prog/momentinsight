import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import JSZip from "jszip";

const sourcePath = "public/mi-related-keywords-xlsx.js";
const queriedAt = "2026-10-18T23:59:58.123Z";
const exportedAt = "2026-10-19T00:01:02.456Z";

function api() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), { window, TextEncoder, Uint8Array, Uint32Array, Date });
  return window.MomentRelatedKeywordXlsx;
}

function payload(overrides = {}) {
  return {
    keyword: "온열찜질기", queriedAt, exportedAt, competition: "전체", sortLabel: "통합 월 검색량 높은 순",
    mainRows: [
      [1, "허리찜질기", 100, 0, 100, "보통", 12.5, 0.0123],
      [2, "찜질패드", "<10", "<10", null, "낮음", null, null],
      [3, "=SUM(1,1)", null, null, null, "확인 필요", 0, 0]
    ],
    ...overrides
  };
}

async function unpack(data = payload()) {
  const bytes = api().create(data);
  assert.ok(bytes instanceof Uint8Array);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const files = {};
  for (const [name, entry] of Object.entries(zip.files)) files[name] = await entry.async("string");
  return { bytes, files, main: files["xl/worksheets/sheet1.xml"] };
}

function cell(xml, ref) {
  const match = xml.match(new RegExp('<c r="' + ref + '"[^>]*?(?:/>|>[\\s\\S]*?</c>)'));
  assert.ok(match, "Missing cell " + ref);
  return match[0];
}

function height(xml, number) {
  const match = xml.match(new RegExp('<row r="' + number + '" ht="([0-9.]+)" customHeight="1">'));
  assert.ok(match, "Missing row " + number);
  return Number(match[1]);
}

function styles(files) { return files["xl/styles.xml"].match(/<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/)[1].match(/<xf\b[\s\S]*?<\/xf>/g); }

test("XLSX runtime emits deterministic six-part OOXML with valid CRCs and only the related-keyword sheet", async () => {
  const { bytes, files } = await unpack();
  assert.equal(Buffer.from(bytes).readUInt32LE(0), 0x04034b50);
  assert.deepEqual(Object.keys(files).sort(), [
    "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"
  ].sort());
  assert.match(files["xl/workbook.xml"], /<sheets><sheet name="연관 키워드" sheetId="1" r:id="rId1"\/><\/sheets>/);
  assert.match(files["[Content_Types].xml"], /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml/);
  assert.deepEqual(api().create(payload()), bytes);
  for (const xml of Object.values(files)) assert.doesNotMatch(xml, /카테고리|sheet2\.xml|TargetMode="External"|<hyperlink|<f[ >]|vbaProject|externalLink/);
});

test("ZIP uses stored compression, UTF-8 flags and consistent local, central, and end records", async () => {
  const { bytes } = await unpack();
  const buffer = Buffer.from(bytes);
  let offset = 0;
  let entries = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 6), 0x0800);
    assert.equal(buffer.readUInt16LE(offset + 8), 0);
    const size = buffer.readUInt32LE(offset + 18);
    assert.equal(size, buffer.readUInt32LE(offset + 22));
    offset += 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28) + size;
    entries++;
  }
  assert.equal(entries, 6);
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  assert.equal(buffer.readUInt16LE(buffer.length - 12), 6);
  assert.equal(buffer.readUInt32LE(buffer.length - 6), offset);
  const corrupted = bytes.slice();
  corrupted[30 + buffer.readUInt16LE(26) + buffer.readUInt16LE(28)] ^= 1;
  await assert.rejects(() => JSZip.loadAsync(corrupted, { checkCRC32: true }), /CRC32/);
});

test("main sheet preserves typed zero, numeric clicks and fraction CTR, null cells and suppressed strings", async () => {
  const { main } = await unpack();
  assert.match(cell(main, "D7"), /<v>0<\/v>/);
  assert.doesNotMatch(cell(main, "D7"), /inlineStr/);
  assert.match(cell(main, "G7"), /s="5"[^>]*><v>12\.5<\/v>/);
  assert.match(cell(main, "H7"), /s="6"[^>]*><v>0\.0123<\/v>/);
  assert.match(cell(main, "H9"), /<v>0<\/v>/);
  assert.match(cell(main, "C8"), /t="inlineStr"><is><t xml:space="preserve">&lt;10<\/t><\/is>/);
  assert.doesNotMatch(cell(main, "E8"), /<v>|inlineStr/);
  assert.doesNotMatch(cell(main, "G8"), /<v>|inlineStr/);
  assert.match(cell(main, "B9"), /t="inlineStr"[\s\S]*=SUM\(1,1\)/);
  assert.doesNotMatch(main, /<f(?:\s|>)/);
});

test("main sheet keeps the actual keyword membership and order without padding", async () => {
  const { main } = await unpack();
  for (let index = 0; index < 3; index++) assert.ok(cell(main, "B" + (index + 7)).includes(payload().mainRows[index][1]));
  assert.match(main, /<dimension ref="A2:H9"\/>/);
  assert.match(main, /<autoFilter ref="A6:H9"\/>/);
  assert.doesNotMatch(main, /<row r="10"/);
});

test("compact navy design keeps grouped headers, widths, two-line header, filters, and frozen panes", async () => {
  const { main, files } = await unpack();
  assert.match(main, /<pane xSplit="2" ySplit="6" topLeftCell="C7" activePane="bottomRight" state="frozen"\/>/);
  assert.match(main, /showGridLines="0"/);
  for (const ref of ["A2:H2", "A3:H3", "A4:H4", "A5:B5", "C5:E5", "F5:H5"]) assert.ok(main.includes('ref="' + ref + '"'));
  assert.match(cell(main, "A2"), /모먼트인사이트 · 연관 키워드/);
  assert.match(cell(main, "A5"), /키워드/);
  assert.match(cell(main, "C5"), /월간 검색수/);
  assert.match(cell(main, "F5"), /광고 지표/);
  assert.match(cell(main, "A6"), /번호/);
  assert.match(cell(main, "H6"), /광고&#10;클릭률/);
  assert.equal(height(main, 6), 36);
  assert.equal(height(main, 7), 28);
  assert.deepEqual([...main.matchAll(/<col min="\d+" max="\d+" width="([\d.]+)"/g)].map((match) => Number(match[1])), [6, 27, 16, 12, 13, 13, 17, 15]);
  assert.match(files["xl/styles.xml"], /<sz val="15"\/>/);
  assert.match(files["xl/styles.xml"], /<name val="Malgun Gothic"\/>/);
  for (const format of ["#,##0", "#,##0.0", "0.00%"]) assert.ok(files["xl/styles.xml"].includes('formatCode="' + format + '"'));
  assert.match(files["xl/styles.xml"], /fgColor rgb="FF14283F"/);
});

test("body keeps white fill, padding, centered numbers/competition and emphasized total search volume", async () => {
  const { files, main } = await unpack();
  const xfs = styles(files);
  assert.match(xfs[0], /horizontal="left"[^>]*wrapText="1"[^>]*indent="1"/);
  for (const index of [4, 5, 6]) assert.match(xfs[index], /horizontal="right"[^>]*indent="1"/);
  for (const index of [1, 2, 3, 7]) assert.doesNotMatch(xfs[index], /indent=/);
  assert.match(xfs[3], /wrapText="1"/);
  assert.match(cell(main, "A7"), /s="9"/);
  assert.match(cell(main, "F7"), /s="10"/);
  assert.match(cell(main, "C7"), /s="8"/);
  assert.match(xfs[8], /fontId="4"[^>]*fillId="5"/);
  assert.match(xfs[9], /horizontal="center"/);
  assert.match(xfs[10], /horizontal="center"/);
  for (const index of [0, 4, 5, 6, 9, 10]) assert.match(xfs[index], /fillId="4"/);
  assert.match(files["xl/styles.xml"], /fgColor rgb="FFFFFFFF"/);
});

test("long Korean keywords expand only the affected body row and preserve their full text", async () => {
  const data = payload();
  data.mainRows[0][1] = "가".repeat(60);
  const { main } = await unpack(data);
  assert.ok(height(main, 7) >= 99 && height(main, 7) <= 409);
  assert.equal(height(main, 8), 28);
  assert.equal(height(main, 3), 24);
  assert.ok(cell(main, "B7").includes(data.mainRows[0][1]));
});

test("literal whitespace, tabs and CRLF contribute conservatively to height without changing text", async () => {
  const data = payload();
  data.mainRows[0][1] = "  공백 유지\r\n둘째 줄\n셋째\t줄  ";
  const { main } = await unpack(data);
  assert.ok(height(main, 7) >= 54);
  assert.match(cell(main, "B7"), /xml:space="preserve">  공백 유지&#13;&#10;둘째 줄&#10;셋째&#9;줄  <\/t>/);
});

test("body and metadata too tall for Excel's 409pt row limit are rejected instead of clipped", () => {
  const create = api().create;
  const tooManyLines = payload(); tooManyLines.mainRows[0][1] = "한 줄\n".repeat(27);
  const tooWide = payload(); tooWide.mainRows[0][1] = "가".repeat(400);
  for (const data of [tooManyLines, tooWide, payload({ keyword: "가".repeat(2000) }), payload({ sortLabel: "한 줄\n".repeat(27) })]) assert.throws(() => create(data), /Invalid XLSX:.*409/);
});

test("long metadata wraps across its complete merged width without truncating literal values", async () => {
  const data = payload({ keyword: "가".repeat(60), competition: "나".repeat(20), sortLabel: "통합 월 검색량 오름차순" });
  const { main, files } = await unpack(data);
  assert.match(styles(files)[2], /wrapText="1"/);
  assert.doesNotMatch(styles(files)[2], /indent=/);
  for (const number of [3, 4]) assert.ok(height(main, number) > 24 && height(main, number) <= 409);
  assert.ok(cell(main, "A3").includes(data.keyword));
  assert.ok(cell(main, "A4").includes(data.competition));
  assert.ok(cell(main, "A4").includes(data.sortLabel));
  assert.equal(height(main, 2), 24);
  assert.equal(height(main, 6), 36);
  assert.equal(height(main, 7), 28);
});

test("metadata uses supplied KST timestamps and never fabricates an unavailable query time", async () => {
  const { main } = await unpack();
  assert.match(cell(main, "A3"), /조회: 2026\.10\.19 08:59:58 KST/);
  assert.match(cell(main, "A4"), /내보내기: 2026\.10\.19 09:01:02 KST/);
  assert.match(cell(main, "A4"), /경쟁도: 전체/);
  assert.match(cell(main, "A4"), /정렬: 통합 월 검색량 높은 순/);
  assert.match(cell(main, "A4"), /3개/);
  assert.match(cell((await unpack(payload({ queriedAt: null }))).main, "A3"), /조회: 확인 필요/);
  assert.match(cell((await unpack(payload({ queriedAt: "" }))).main, "A3"), /조회: 확인 필요/);
  assert.match(cell((await unpack(payload({ exportedAt: "2026-10-19T18:01:02+09:00" }))).main, "A4"), /내보내기: 2026\.10\.19 18:01:02 KST/);
  const allCompetition = payload({ competition: "" });
  assert.match(cell((await unpack(allCompetition)).main, "A4"), /경쟁도: 전체/);
  assert.equal(allCompetition.competition, "");
});

test("all strings stay literal inlineStr, including formula prefixes, XML symbols and escaped OOXML text", async () => {
  const data = payload();
  data.mainRows[0][1] = " =HYPERLINK(\"https://invalid.example\",\"열기\") & < > ' \" 😀 _x0041_\r\n";
  data.mainRows[0][5] = "+literal";
  data.mainRows[0][2] = "-literal";
  data.mainRows[0][4] = "@literal";
  const { main } = await unpack(data);
  const literal = cell(main, "B7");
  assert.match(literal, /t="inlineStr"/);
  assert.match(literal, /xml:space="preserve"> =HYPERLINK/);
  assert.match(literal, /&quot;https:\/\/invalid\.example&quot;/);
  assert.match(literal, /&amp; &lt; &gt; &apos; &quot; 😀 _x005F_x0041_&#13;&#10;/);
  for (const [ref, value] of [["F7", "+literal"], ["C7", "-literal"], ["E7", "@literal"]]) {
    assert.match(cell(main, ref), /t="inlineStr"/);
    assert.ok(cell(main, ref).includes(value));
  }
  assert.doesNotMatch(main, /<f(?:\s|>)|<hyperlink/);
});

test("exactly 50 actual keywords produce rows 7 to 56, a matching filter and no synthetic rows", async () => {
  const mainRows = Array.from({ length: 50 }, (_, index) => [index + 1, "실제 연관어 " + index, index, null, "<10", "확인 필요", null, 0]);
  const { main, files } = await unpack(payload({ mainRows }));
  assert.equal((main.match(/<row r="(?:[7-9]|[1-4][0-9]|5[0-6])"/g) || []).length, 50);
  assert.match(main, /<dimension ref="A2:H56"\/>/);
  assert.match(main, /<autoFilter ref="A6:H56"\/>/);
  assert.match(main, /topLeftCell="C7"/);
  assert.match(cell(main, "B56"), /실제 연관어 49/);
  assert.match(cell(main, "A56"), /<v>50<\/v>/);
  assert.match(cell(main, "A4"), /50개/);
  assert.doesNotMatch(main, /<row r="57"/);
  assert.deepEqual(Object.keys(files).filter((name) => name.startsWith("xl/worksheets/")), ["xl/worksheets/sheet1.xml"]);
});

test("legacy category inputs are not required, not read, not validated and never exported", async () => {
  const data = payload();
  Object.defineProperty(data, "categoryRows", { get() { throw new Error("Category input must never be read"); } });
  const { files } = await unpack(data);
  for (const xml of Object.values(files)) assert.doesNotMatch(xml, /카테고리|sheet2\.xml/);
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /categoryRows|CATEGORY_|카테고리|sheet2\.xml/);
});

test("writer rejects zero/51 rows, sparse arrays, malformed matrices, wrong numbering and duplicate keywords", () => {
  const create = api().create;
  const tooMany = Array.from({ length: 51 }, (_, index) => [index + 1, "연관어" + index, 0, 0, 0, "보통", 0, 0]);
  const sparseRows = payload(); sparseRows.mainRows = [sparseRows.mainRows[0], , sparseRows.mainRows[2]];
  const sparseCells = payload(); delete sparseCells.mainRows[0][2];
  const wrongWidth = payload(); wrongWidth.mainRows[0].pop();
  const wrongNumber = payload(); wrongNumber.mainRows[1][0] = 9;
  const emptyKeyword = payload(); emptyKeyword.mainRows[0][1] = "  ";
  const duplicate = payload(); duplicate.mainRows[1][1] = duplicate.mainRows[0][1];
  for (const data of [null, {}, payload({ mainRows: [] }), payload({ mainRows: tooMany }), sparseRows, sparseCells, wrongWidth, wrongNumber, emptyKeyword, duplicate]) assert.throws(() => create(data), /Invalid XLSX/);
});

test("writer rejects ambiguous, impossible or invalid metadata dates instead of inventing timestamps", () => {
  const create = api().create;
  for (const value of [null, "", "invalid", "2026-10-19", "2026-10-19T01:00:00", "2026-02-30T01:00:00Z", "2026-10-19T25:00:00Z", "2026-10-19T01:00:00+24:00"]) assert.throws(() => create(payload({ exportedAt: value })), /Invalid XLSX/);
  assert.throws(() => create(payload({ queriedAt: "invalid" })), /Invalid XLSX/);
});

test("writer rejects negative, nonfinite, object, undefined and boolean cells without coercion", () => {
  const create = api().create;
  for (const value of [-1, NaN, Infinity, -Infinity, {}, [], undefined, true, BigInt(1)]) {
    const data = payload(); data.mainRows[0][2] = value;
    assert.throws(() => create(data), /Invalid XLSX/);
  }
});

test("writer rejects XML forbidden controls, unpaired surrogates and oversized text without silent loss", () => {
  const create = api().create;
  for (const value of ["bad\u0000text", "bad\u000btext", "bad\u001ftext", "bad\ufffe", "bad\uffff", "bad\ud800", "bad\udc00", "a".repeat(32768)]) {
    const data = payload(); data.mainRows[0][1] = value;
    assert.throws(() => create(data), /Invalid XLSX/);
  }
  const characterLimit = payload(); characterLimit.mainRows[0][1] = "a".repeat(32767);
  assert.throws(() => create(characterLimit), /Invalid XLSX:.*409/);
});

test("runtime remains dependency-free, read-only, and cannot fetch, evaluate or construct formulas", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|eval|Function|importScripts|localStorage|sessionStorage)\s*\(/);
  assert.doesNotMatch(source, /\bimport\s|require\s*\(|https?:\/\/.*(?:cdn|jsdelivr|unpkg)/);
  const data = payload();
  const before = JSON.stringify(data);
  api().create(data);
  assert.equal(JSON.stringify(data), before);
});
