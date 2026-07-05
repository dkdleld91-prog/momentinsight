import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const simplifiedWorkbook = Workbook.create();
const simplifiedOutputDir = "outputs";
const simplifiedFinalName = "모먼트인사이트_운영시트_템플릿.xlsx";

const miTheme = {
  navy: "#061A3A",
  ink: "#111827",
  muted: "#667085",
  line: "#D9E1EC",
  soft: "#EEF3F8",
  input: "#FFF8D7",
  calc: "#F5F7FB",
  green: "#EAF7F1",
  blue: "#EAF2FF",
};

function miAddSheet(name) {
  const sheet = simplifiedWorkbook.worksheets.add(name);
  sheet.showGridLines = false;
  return sheet;
}

function miWrite(sheet, range, values) {
  sheet.getRange(range).values = values;
}

function miFormulas(sheet, range, values) {
  sheet.getRange(range).formulas = values;
}

function miTitle(sheet, range) {
  sheet.getRange(range).format = {
    fill: miTheme.navy,
    font: { name: "Arial", size: 16, color: "#FFFFFF", bold: true },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
}

function miSection(sheet, range) {
  sheet.getRange(range).format = {
    fill: miTheme.soft,
    font: { name: "Arial", size: 11, color: miTheme.navy, bold: true },
    horizontalAlignment: "left",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: miTheme.line },
  };
}

function miHeader(sheet, range) {
  sheet.getRange(range).format = {
    fill: miTheme.soft,
    font: { name: "Arial", size: 10, color: miTheme.ink, bold: true },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: miTheme.line },
  };
}

function miBody(sheet, range) {
  sheet.getRange(range).format = {
    fill: "#FFFFFF",
    font: { name: "Arial", size: 10, color: miTheme.ink },
    horizontalAlignment: "left",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: miTheme.line },
  };
}

function miInput(sheet, range) {
  sheet.getRange(range).format.fill = miTheme.input;
}

function miCalc(sheet, range) {
  sheet.getRange(range).format.fill = miTheme.calc;
}

function miWidths(sheet, specs, rows = 80) {
  Object.entries(specs).forEach(([col, width]) => {
    sheet.getRange(`${col}1:${col}${rows}`).format.columnWidthPx = width;
  });
}

function miTall(sheet, range, px) {
  sheet.getRange(range).format.rowHeightPx = px;
}

function miApplyMoney(sheet, range) {
  sheet.getRange(range).format.numberFormat = "#,##0";
  sheet.getRange(range).format.horizontalAlignment = "right";
}

function miApplyRate(sheet, range, format = "0.0%") {
  sheet.getRange(range).format.numberFormat = format;
  sheet.getRange(range).format.horizontalAlignment = "right";
}

function miApplyRoas(sheet, range) {
  sheet.getRange(range).format.numberFormat = "0.0x";
  sheet.getRange(range).format.horizontalAlignment = "right";
}

function miMonthDate() {
  return new Date(Date.UTC(2026, 5, 1));
}

function miDayDate(day) {
  return new Date(Date.UTC(2026, 5, day));
}

function miDailySumFormula(row, dailyColumn) {
  return `=SUMIFS('일별_매출입력'!${dailyColumn}$6:${dailyColumn}$205,'일별_매출입력'!$B$6:$B$205,$A${row},'일별_매출입력'!$A$6:$A$205,">="&$B${row},'일별_매출입력'!$A$6:$A$205,"<"&EDATE($B${row},1))`;
}

const guide = miAddSheet("처음_사용법");
miWrite(guide, "A1:H1", [["모먼트인사이트 운영팀 기본 양식", "", "", "", "", "", "", ""]]);
miTitle(guide, "A1:H1");
miWrite(guide, "A3:H3", [["작성 순서", "", "", "", "", "", "", ""]]);
miSection(guide, "A3:H3");
miWrite(guide, "A4:H8", [
  ["1", "일별_매출입력", "날짜별 채널 매출, 광고비, 구매수, 노출/클릭/전환수를 입력합니다.", "노란색 칸만 작성", "", "", "", ""],
  ["2", "월간_매출입력", "일별 입력값을 기준으로 월간 매출, 광고비, 구매수, ROAS가 자동 합산됩니다.", "자동 계산 확인", "", "", "", ""],
  ["3", "네이버_일별입력 / 쿠팡_일별입력", "플랫폼 원천값을 보관할 때 사용합니다. 월간 공개값은 일별_매출입력 기준입니다.", "선택 입력", "", "", "", ""],
  ["4", "보고서_목록 / 일정표", "운영팀이 공개할 보고서, 일정, 요청사항을 정리합니다.", "필수 확인", "", "", "", ""],
  ["5", "인사이트_액션플랜", "광고주에게 보여줄 결론과 다음 행동을 작성합니다.", "짧게 작성", "", "", "", ""],
]);
miBody(guide, "A4:H8");
miWrite(guide, "A10:H10", [["운영 기준", "", "", "", "", "", "", ""]]);
miSection(guide, "A10:H10");
miWrite(guide, "A11:H15", [
  ["광고주 연결", "", "웹에서 운영팀 코드와 광고주 코드가 이미 1:1로 연결되므로 엑셀에는 별도 코드 입력이 없습니다.", "", "", "", "", ""],
  ["입력 규칙", "", "노란색 칸은 운영팀 입력값이고, 회색 칸은 자동 계산값입니다.", "", "", "", "", ""],
  ["공개 기준", "", "광고주에게 보일 문장은 공개코멘트, 일정, 인사이트 영역에만 작성합니다.", "", "", "", "", ""],
  ["원본 보관", "", "작성 완료 후 관리자 화면의 원천 엑셀 업로드 영역에 이 파일을 업로드합니다.", "", "", "", "", ""],
  ["주의", "", "내부 판단이나 민감한 메모는 광고주공개코멘트에 작성하지 않습니다.", "", "", "", "", ""],
]);
miBody(guide, "A11:H15");
miWidths(guide, { A: 112, B: 150, C: 560, D: 140, E: 70, F: 70, G: 70, H: 70 }, 30);
miTall(guide, "A1:H1", 34);
miTall(guide, "A4:H15", 30);

const dailySales = miAddSheet("일별_매출입력");
miWrite(dailySales, "A1:J1", [["일별 매출/광고 성과 입력", "", "", "", "", "", "", "", "", ""]]);
miTitle(dailySales, "A1:J1");
miWrite(dailySales, "A3:J3", [["운영팀은 날짜별 수치만 입력합니다. 월간_매출입력 시트가 채널과 기준월에 맞춰 자동 합산합니다.", "", "", "", "", "", "", "", "", ""]]);
miSection(dailySales, "A3:J3");
miWrite(dailySales, "A5:J5", [["일자", "채널", "캠페인/상품군", "광고비", "매출", "구매수", "노출수", "클릭수", "전환수", "운영메모"]]);
miHeader(dailySales, "A5:J5");
miWrite(dailySales, "A6:J14", [
  [miDayDate(24), "네이버", "브랜드 검색 캠페인", 1200000, 7200000, 220, 180000, 6900, 330, "일별 수치 확인"],
  [miDayDate(25), "네이버", "브랜드 검색 캠페인", 980000, 6100000, 190, 152000, 5700, 284, "정상"],
  [miDayDate(26), "네이버", "키워드 확장 캠페인", 1020000, 5300000, 232, 178000, 6800, 337, "키워드 보강"],
  [miDayDate(24), "쿠팡", "상품 검색 캠페인", 760000, 4800000, 148, 126000, 5200, 228, "상품명 확인"],
  [miDayDate(25), "쿠팡", "상품 검색 캠페인", 710000, 4600000, 139, 119000, 4800, 216, "정상"],
  [miDayDate(26), "쿠팡", "상품 확장 캠페인", 740000, 4800000, 151, 135000, 7200, 366, "검색어 확장"],
  [miDayDate(24), "메타", "리타겟팅 소재 A", 730000, 3100000, 58, 76000, 2500, 75, "소재 피로도 확인"],
  [miDayDate(25), "메타", "리타겟팅 소재 B", 720000, 2900000, 54, 73000, 2400, 70, "교체 테스트"],
  [miDayDate(26), "메타", "전환 캠페인", 740000, 3000000, 56, 81000, 2900, 86, "정상"],
]);
miBody(dailySales, "A6:J205");
miInput(dailySales, "A6:J205");
dailySales.getRange("A6:A205").format.numberFormat = "yyyy-mm-dd";
miApplyMoney(dailySales, "D6:E205");
miApplyMoney(dailySales, "F6:I205");
miWidths(dailySales, { A: 112, B: 98, C: 230, D: 112, E: 112, F: 86, G: 106, H: 92, I: 92, J: 260 }, 215);
miTall(dailySales, "A1:J1", 34);
miTall(dailySales, "A5:J205", 25);
dailySales.freezePanes.freezeRows(5);

const monthly = miAddSheet("월간_매출입력");
miWrite(monthly, "A1:O1", [["월간 매출/광고 성과 입력", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]]);
miTitle(monthly, "A1:O1");
miWrite(monthly, "A3:O3", [["일별_매출입력에 날짜별 수치를 입력하면 월간 매출, 광고비, 구매수, ROAS가 자동 계산됩니다. 운영팀 1개당 광고주 1개 기준이라 별도 광고주 코드 입력은 없습니다.", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]]);
miSection(monthly, "A3:O3");
miWrite(monthly, "A5:O5", [["채널", "기준월", "목표매출", "실제매출", "광고비", "구매수", "노출수", "클릭수", "전환수", "ROAS", "CTR", "CVR", "목표달성률", "광고주공개코멘트", "업데이트일"]]);
miHeader(monthly, "A5:O5");
miWrite(monthly, "A6:I9", [
  ["네이버", miMonthDate(), 36000000, "", "", "", "", "", ""],
  ["쿠팡", miMonthDate(), 18000000, "", "", "", "", "", ""],
  ["메타", miMonthDate(), 9000000, "", "", "", "", "", ""],
  ["합계", miMonthDate(), 0, 0, 0, 0, 0, 0, 0],
]);
miFormulas(monthly, "D6:I8", Array.from({ length: 3 }, (_, index) => {
  const row = index + 6;
  return [
    miDailySumFormula(row, "E"),
    miDailySumFormula(row, "D"),
    miDailySumFormula(row, "F"),
    miDailySumFormula(row, "G"),
    miDailySumFormula(row, "H"),
    miDailySumFormula(row, "I"),
  ];
}));
miFormulas(monthly, "C9:I9", [["=SUM(C6:C8)", "=SUM(D6:D8)", "=SUM(E6:E8)", "=SUM(F6:F8)", "=SUM(G6:G8)", "=SUM(H6:H8)", "=SUM(I6:I8)"]]);
miFormulas(monthly, "J6:M9", Array.from({ length: 4 }, (_, index) => {
  const row = index + 6;
  return [
    `=IFERROR(D${row}/E${row},0)`,
    `=IFERROR(H${row}/G${row},0)`,
    `=IFERROR(I${row}/H${row},0)`,
    `=IFERROR(D${row}/C${row},0)`,
  ];
}));
miWrite(monthly, "N6:O9", [
  ["다음 주에는 네이버 검색광고 효율은 유지하고 쿠팡 상품명 키워드를 보강합니다.", "2026-06-27"],
  ["쿠팡은 전환은 안정적이나 검색어 보강이 필요합니다.", "2026-06-27"],
  ["메타는 소재 피로도를 확인하고 교체 테스트를 준비합니다.", "2026-06-27"],
  ["합산 기준으로 보고서 공개 전 수치 검수 필요", "2026-06-27"],
]);
miBody(monthly, "A6:O35");
miInput(monthly, "A6:C8");
miInput(monthly, "N6:O35");
miCalc(monthly, "D6:M35");
monthly.getRange("B6:B35").format.numberFormat = "yyyy-mm";
miApplyMoney(monthly, "C6:E35");
miApplyMoney(monthly, "F6:I35");
miApplyRoas(monthly, "J6:J35");
miApplyRate(monthly, "K6:M35");
miWidths(monthly, { A: 100, B: 96, C: 112, D: 112, E: 108, F: 90, G: 106, H: 96, I: 96, J: 78, K: 78, L: 78, M: 104, N: 390, O: 112 }, 45);
miTall(monthly, "A1:O1", 34);
miTall(monthly, "A5:O35", 26);
monthly.freezePanes.freezeRows(5);

function buildDailySheet(name, firstCampaign, secondCampaign) {
  const sheet = miAddSheet(name);
  miWrite(sheet, "A1:L1", [[`${name} 원천 입력`, "", "", "", "", "", "", "", "", "", "", ""]]);
  miTitle(sheet, "A1:L1");
  miWrite(sheet, "A3:L3", [["플랫폼에서 내려받은 일별/캠페인별 수치를 그대로 입력합니다. 코드 입력 없이 광고주 한 곳 기준으로 작성합니다.", "", "", "", "", "", "", "", "", "", "", ""]]);
  miSection(sheet, "A3:L3");
  miWrite(sheet, "A5:L5", [["일자", "캠페인/상품군", "광고비", "매출", "노출수", "클릭수", "전환수", "구매수", "ROAS", "CTR", "CVR", "운영메모"]]);
  miHeader(sheet, "A5:L5");
  miWrite(sheet, "A6:H9", [
    ["2026-06-24", firstCampaign, 1200000, 7200000, 180000, 6900, 330, 220],
    ["2026-06-25", firstCampaign, 980000, 6100000, 152000, 5700, 284, 190],
    ["2026-06-26", secondCampaign, 1020000, 5300000, 178000, 6800, 337, 232],
    ["합계", "", 0, 0, 0, 0, 0, 0],
  ]);
  miFormulas(sheet, "C9:H9", [["=SUM(C6:C8)", "=SUM(D6:D8)", "=SUM(E6:E8)", "=SUM(F6:F8)", "=SUM(G6:G8)", "=SUM(H6:H8)"]]);
  miFormulas(sheet, "I6:K9", Array.from({ length: 4 }, (_, index) => {
    const row = index + 6;
    return [
      `=IFERROR(D${row}/C${row},0)`,
      `=IFERROR(F${row}/E${row},0)`,
      `=IFERROR(G${row}/F${row},0)`,
    ];
  }));
  miWrite(sheet, "L6:L9", [["수치 확인 완료"], ["정상"], ["소재/키워드 확인"], ["합계 검수"]]);
  miBody(sheet, "A6:L45");
  miInput(sheet, "A6:H45");
  miInput(sheet, "L6:L45");
  miCalc(sheet, "I6:K45");
  miApplyMoney(sheet, "C6:D45");
  miApplyMoney(sheet, "E6:H45");
  miApplyRoas(sheet, "I6:I45");
  miApplyRate(sheet, "J6:K45");
  miWidths(sheet, { A: 105, B: 220, C: 112, D: 112, E: 105, F: 90, G: 90, H: 90, I: 76, J: 76, K: 76, L: 260 }, 55);
  miTall(sheet, "A1:L1", 34);
  miTall(sheet, "A5:L45", 25);
  sheet.freezePanes.freezeRows(5);
}

buildDailySheet("네이버_일별입력", "브랜드 검색 캠페인", "키워드 확장 캠페인");
buildDailySheet("쿠팡_일별입력", "상품 검색 캠페인", "상품 확장 캠페인");

const reportsSimple = miAddSheet("보고서_목록");
miWrite(reportsSimple, "A1:G1", [["보고서 목록", "", "", "", "", "", ""]]);
miTitle(reportsSimple, "A1:G1");
miWrite(reportsSimple, "A3:G3", [["운영팀이 공개할 보고서 파일명이나 링크를 정리합니다.", "", "", "", "", "", ""]]);
miSection(reportsSimple, "A3:G3");
miWrite(reportsSimple, "A5:G5", [["보고서유형", "기준기간", "파일명/링크", "공개상태", "작성자", "업데이트일", "메모"]]);
miHeader(reportsSimple, "A5:G5");
miWrite(reportsSimple, "A6:G9", [
  ["주간 보고서", "2026-06 4주차", "moment-weekly-202606-4.pdf", "공개 가능", "운영팀", "2026-06-27", "내부 메모 제거 후 공개"],
  ["월간 보고서", "2026-06", "moment-monthly-202606.pdf", "검수 중", "운영팀", "2026-06-27", "매출 수치 재확인"],
  ["KPI 보고서", "2026-06", "moment-kpi-202606.xlsx", "공개 가능", "운영팀", "2026-06-27", "목표달성률 포함"],
  ["", "", "", "", "", "", ""],
]);
miBody(reportsSimple, "A6:G40");
miInput(reportsSimple, "A6:G40");
miWidths(reportsSimple, { A: 120, B: 120, C: 310, D: 110, E: 100, F: 112, G: 300 }, 45);
miTall(reportsSimple, "A1:G1", 34);
miTall(reportsSimple, "A5:G40", 26);
reportsSimple.freezePanes.freezeRows(5);

const scheduleSimple = miAddSheet("일정표");
miWrite(scheduleSimple, "A1:H1", [["일정표", "", "", "", "", "", "", ""]]);
miTitle(scheduleSimple, "A1:H1");
miWrite(scheduleSimple, "A3:H3", [["광고주와 공유할 일정만 정리합니다. 내부 할 일은 메모에 구분해서 작성합니다.", "", "", "", "", "", "", ""]]);
miSection(scheduleSimple, "A3:H3");
miWrite(scheduleSimple, "A5:H5", [["일자", "유형", "제목", "상세", "상태", "공개여부", "담당자", "메모"]]);
miHeader(scheduleSimple, "A5:H5");
miWrite(scheduleSimple, "A6:H10", [
  ["2026-06-28", "보고서", "월간 보고서 공개", "운영팀 검수 후 보고서함 공개", "예정", "Y", "운영팀", "공개 전 수치 확인"],
  ["2026-06-29", "소재", "메타 소재 교체", "기존 소재 피로도 반영", "진행 중", "Y", "디자인", "광고주 확인 필요"],
  ["2026-06-30", "키워드", "쿠팡 키워드 보강", "상품명과 검색어 반영", "예정", "Y", "분석", "20개 확장"],
  ["", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
]);
miBody(scheduleSimple, "A6:H45");
miInput(scheduleSimple, "A6:H45");
miWidths(scheduleSimple, { A: 108, B: 90, C: 190, D: 330, E: 100, F: 86, G: 110, H: 270 }, 50);
miTall(scheduleSimple, "A1:H1", 34);
miTall(scheduleSimple, "A5:H45", 26);
scheduleSimple.freezePanes.freezeRows(5);

const insightSimple = miAddSheet("인사이트_액션플랜");
miWrite(insightSimple, "A1:H1", [["인사이트 및 액션 플랜", "", "", "", "", "", "", ""]]);
miTitle(insightSimple, "A1:H1");
miWrite(insightSimple, "A3:H3", [["광고주가 이해해야 하는 결론과 다음 실행만 짧게 작성합니다.", "", "", "", "", "", "", ""]]);
miSection(insightSimple, "A3:H3");
miWrite(insightSimple, "A5:H5", [["작성일", "구분", "핵심변화", "부족한 지표", "개선제안", "다음액션", "광고주공개코멘트", "내부메모"]]);
miHeader(insightSimple, "A5:H5");
miWrite(insightSimple, "A6:H9", [
  ["2026-06-27", "주간", "네이버 검색광고 CTR 상승", "쿠팡 검색어 확장 부족", "상품명/검색어 필드 보강", "쿠팡 키워드 20개 추가", "검색 유입은 유지되고 있으나 쿠팡 키워드 보강이 필요합니다.", "예산 증액은 다음 주 검토"],
  ["2026-06-27", "월간", "합산 매출 목표 초과", "메타 소재 피로도", "소재 교체 테스트", "메타 소재 2종 교체", "월간 매출 흐름은 양호하며 다음 달은 소재 테스트를 진행합니다.", "내부용 소재 피로도 높음"],
  ["", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
]);
miBody(insightSimple, "A6:H45");
miInput(insightSimple, "A6:H45");
miWidths(insightSimple, { A: 108, B: 90, C: 230, D: 190, E: 230, F: 220, G: 380, H: 260 }, 50);
miTall(insightSimple, "A1:H1", 34);
miTall(insightSimple, "A5:H45", 34);
insightSimple.freezePanes.freezeRows(5);

const dashboardSimple = miAddSheet("운영_대시보드");
miWrite(dashboardSimple, "A1:H1", [["운영 요약 대시보드", "", "", "", "", "", "", ""]]);
miTitle(dashboardSimple, "A1:H1");
miWrite(dashboardSimple, "A3:H3", [["일별_매출입력에서 월간_매출입력으로 합산된 값을 기준으로 자동 요약됩니다.", "", "", "", "", "", "", ""]]);
miSection(dashboardSimple, "A3:H3");
miWrite(dashboardSimple, "A5:H5", [["지표", "값", "판단", "", "채널", "매출", "광고비", "ROAS"]]);
miHeader(dashboardSimple, "A5:H5");
miWrite(dashboardSimple, "A6:A11", [["이번 달 매출"], ["광고비"], ["ROAS"], ["구매수"], ["목표달성률"], ["보고서 상태"]]);
miFormulas(dashboardSimple, "B6:B11", [
  ["='월간_매출입력'!D9"],
  ["='월간_매출입력'!E9"],
  ["='월간_매출입력'!J9"],
  ["='월간_매출입력'!F9"],
  ["='월간_매출입력'!M9"],
  ["=IF(COUNTIF('보고서_목록'!D6:D40,\"공개 가능\")>=1,\"공개 가능\",\"검수 필요\")"],
]);
miFormulas(dashboardSimple, "C6:C11", [
  ["=IF(B6>=SUM('월간_매출입력'!C6:C8),\"목표 초과\",\"추적 필요\")"],
  ["=IF(B7>0,\"확인\",\"입력 필요\")"],
  ["=IF(B8>=5,\"양호\",\"개선 필요\")"],
  ["=IF(B9>0,\"확인\",\"입력 필요\")"],
  ["=IF(B10>=1,\"달성\",\"진행\")"],
  ["=B11"],
]);
miWrite(dashboardSimple, "E6:E9", [["네이버"], ["쿠팡"], ["메타"], ["합계"]]);
miFormulas(dashboardSimple, "F6:H9", [
  ["='월간_매출입력'!D6", "='월간_매출입력'!E6", "='월간_매출입력'!J6"],
  ["='월간_매출입력'!D7", "='월간_매출입력'!E7", "='월간_매출입력'!J7"],
  ["='월간_매출입력'!D8", "='월간_매출입력'!E8", "='월간_매출입력'!J8"],
  ["='월간_매출입력'!D9", "='월간_매출입력'!E9", "='월간_매출입력'!J9"],
]);
miBody(dashboardSimple, "A6:H20");
miCalc(dashboardSimple, "B6:C11");
miCalc(dashboardSimple, "F6:H9");
miWrite(dashboardSimple, "A14:H14", [["운영 체크", "상태", "다음 조치", "메모", "", "", "", ""]]);
miHeader(dashboardSimple, "A14:H14");
miWrite(dashboardSimple, "A15:D18", [
  ["월간 입력", "완료", "수치 검수", "노란색 입력칸 확인"],
  ["보고서", "검수 중", "파일 업로드", "공개 가능 보고서만 광고주 노출"],
  ["일정", "정상", "공개 일정 확인", "Y 일정만 광고주 공유"],
  ["인사이트", "작성 필요", "광고주 코멘트 정리", "내부 메모 분리"],
]);
miBody(dashboardSimple, "A15:H18");
miApplyMoney(dashboardSimple, "B6:B7");
miApplyRoas(dashboardSimple, "B8:B8");
miApplyMoney(dashboardSimple, "B9:B9");
miApplyRate(dashboardSimple, "B10:B10");
miApplyMoney(dashboardSimple, "F6:G9");
miApplyRoas(dashboardSimple, "H6:H9");
miWidths(dashboardSimple, { A: 140, B: 140, C: 130, D: 260, E: 110, F: 130, G: 130, H: 90 }, 30);
miTall(dashboardSimple, "A1:H1", 34);
miTall(dashboardSimple, "A5:H18", 27);
dashboardSimple.freezePanes.freezeRows(5);

const rulesSimple = miAddSheet("공개규칙");
miWrite(rulesSimple, "A1:F1", [["공개 규칙", "", "", "", "", ""]]);
miTitle(rulesSimple, "A1:F1");
miWrite(rulesSimple, "A3:F3", [["광고주에게 보여줄 자료와 내부 메모를 분리하는 기준입니다.", "", "", "", "", ""]]);
miSection(rulesSimple, "A3:F3");
miWrite(rulesSimple, "A5:F5", [["항목", "설명", "광고주 노출", "운영팀 입력", "필수", "비고"]]);
miHeader(rulesSimple, "A5:F5");
miWrite(rulesSimple, "A6:F13", [
  ["일별_매출입력", "날짜별 매출과 광고 성과 원천값", "월간 합산 후 요약 노출", "노란색 칸 작성", "필수", "월간_매출입력 자동 합산"],
  ["월간_매출입력", "일별 입력값을 월간으로 자동 요약", "요약 수치만 노출", "채널·목표·공개코멘트 작성", "필수", "코드 입력 없음"],
  ["광고주공개코멘트", "광고주가 보는 해석 문장", "노출", "짧게 작성", "필수", "내부 판단 작성 금지"],
  ["보고서_목록", "보고서 파일명 또는 링크", "공개 가능 상태만 노출", "운영팀 작성", "필수", "업로드 후 확인"],
  ["일정표", "광고주 공유 일정", "공개여부 Y만 노출", "운영팀 작성", "권장", "내부 일정은 N"],
  ["인사이트", "이번 주 결론과 다음 액션", "공개코멘트만 노출", "운영팀 작성", "권장", "내부메모는 미노출"],
  ["원천 파일", "작성 완료한 엑셀 원본", "미노출", "관리자 화면 업로드", "필수", "다운로드 보관 가능"],
  ["코드/ID", "웹 계정에서 연결 처리", "미노출", "엑셀 입력 없음", "자동", "운영팀 1:1 연결 기준"],
]);
miBody(rulesSimple, "A6:F24");
miWidths(rulesSimple, { A: 150, B: 300, C: 160, D: 160, E: 80, F: 260 }, 30);
miTall(rulesSimple, "A1:F1", 34);
miTall(rulesSimple, "A5:F24", 27);

await fs.mkdir(simplifiedOutputDir, { recursive: true });
const simplifiedExport = await SpreadsheetFile.exportXlsx(simplifiedWorkbook);
await simplifiedExport.save(`${simplifiedOutputDir}/${simplifiedFinalName}`);
await fs.copyFile(`${simplifiedOutputDir}/${simplifiedFinalName}`, simplifiedFinalName);

const simplifiedErrors = await simplifiedWorkbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|####",
  options: { useRegex: true, maxResults: 300 },
  summary: "formula and display error scan",
});
await simplifiedWorkbook.render({ sheetName: "월간_매출입력", range: "A1:O14", scale: 2, format: "png" });
await simplifiedWorkbook.render({ sheetName: "일별_매출입력", range: "A1:J16", scale: 2, format: "png" });
await simplifiedWorkbook.render({ sheetName: "운영_대시보드", range: "A1:H18", scale: 2, format: "png" });
console.log(JSON.stringify({
  output: `${simplifiedOutputDir}/${simplifiedFinalName}`,
  copied: simplifiedFinalName,
  formulaErrorScan: simplifiedErrors.ndjson,
  mode: "single-client-operation-team-template",
}, null, 2));
process.exit(0);
