import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const workbook = Workbook.create();
const outputDir = "outputs";
const finalName = "모먼트인사이트_운영시트_템플릿.xlsx";

const theme = {
  navy: "#061A3A",
  ink: "#111827",
  muted: "#667085",
  line: "#DFE5EF",
  bg: "#F5F7FB",
  soft: "#EEF2F7",
  green: "#EAF7F1",
  orange: "#FFF4E6",
  input: "#FFF9DB",
};

function addSheet(name) {
  const sheet = workbook.worksheets.add(name);
  return sheet;
}

function write(sheet, range, values) {
  sheet.getRange(range).values = values;
}

function formulas(sheet, range, values) {
  sheet.getRange(range).formulas = values;
}

function styleTitle(sheet, range) {
  const r = sheet.getRange(range);
  r.format = {
    fill: theme.navy,
    font: { name: "Arial", size: 16, color: "#FFFFFF", bold: true },
    horizontalAlignment: "left",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: theme.navy },
  };
}

function styleHeader(sheet, range) {
  const r = sheet.getRange(range);
  r.format = {
    fill: theme.soft,
    font: { name: "Arial", size: 10, color: theme.ink, bold: true },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: theme.line },
  };
}

function styleBody(sheet, range) {
  const r = sheet.getRange(range);
  r.format = {
    fill: "#FFFFFF",
    font: { name: "Arial", size: 10, color: theme.ink },
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: theme.line },
    wrapText: true,
  };
}

function styleInput(sheet, range) {
  sheet.getRange(range).format.fill = theme.input;
}

function finishSheet(sheet, usedRange) {
  sheet.getRange(usedRange).format.autofitColumns();
  sheet.getRange(usedRange).format.autofitRows();
}

const dashboard = addSheet("운영_대시보드");
write(dashboard, "A1:H1", [["모먼트인사이트 운영 시트 템플릿", "", "", "", "", "", "", ""]]);
styleTitle(dashboard, "A1:H1");
write(dashboard, "A3:B6", [
  ["선택 광고주ID", "MI-CLIENT-001"],
  ["운영 기준월", "2026-06"],
  ["공개 조건", "관리자컨펌=승인 / 광고주공유여부=Y"],
  ["사용 방식", "원천 탭에 입력하면 공개 데이터와 대시보드가 계산됩니다."],
]);
styleBody(dashboard, "A3:B6");
styleInput(dashboard, "B3:B4");
write(dashboard, "A8:H8", [["지표", "값", "상태", "", "채널", "매출", "광고비", "ROAS"]]);
styleHeader(dashboard, "A8:H8");
write(dashboard, "A9:A14", [
  ["이번 달 매출"],
  ["광고비"],
  ["ROAS"],
  ["구매수"],
  ["목표 달성률"],
  ["공개 상태"],
]);
formulas(dashboard, "B9:B14", [
  ["=IFERROR(INDEX('대시보드_공개데이터'!D:D,MATCH($B$3,'대시보드_공개데이터'!A:A,0)),\"\")"],
  ["=IFERROR(INDEX('대시보드_공개데이터'!E:E,MATCH($B$3,'대시보드_공개데이터'!A:A,0)),\"\")"],
  ["=IFERROR(INDEX('대시보드_공개데이터'!J:J,MATCH($B$3,'대시보드_공개데이터'!A:A,0)),\"\")"],
  ["=IFERROR(INDEX('대시보드_공개데이터'!F:F,MATCH($B$3,'대시보드_공개데이터'!A:A,0)),\"\")"],
  ["=IFERROR(INDEX('대시보드_공개데이터'!M:M,MATCH($B$3,'대시보드_공개데이터'!A:A,0)),\"\")"],
  ["=IFERROR(IF(AND(INDEX('대시보드_공개데이터'!N:N,MATCH($B$3,'대시보드_공개데이터'!A:A,0))=\"승인\",INDEX('대시보드_공개데이터'!O:O,MATCH($B$3,'대시보드_공개데이터'!A:A,0))=\"Y\"),\"광고주 공개\",\"비공개\"),\"\")"],
]);
formulas(dashboard, "C9:C14", [
  ["=IF(B9=\"\",\"대기\",IF(B9>=INDEX('대시보드_공개데이터'!C:C,MATCH($B$3,'대시보드_공개데이터'!A:A,0)),\"목표 초과\",\"추적 필요\"))"],
  ["=IF(B10=\"\",\"대기\",\"확인\")"],
  ["=IF(B11=\"\",\"대기\",IF(B11>=5,\"양호\",\"개선\"))"],
  ["=IF(B12=\"\",\"대기\",\"확인\")"],
  ["=IF(B13=\"\",\"대기\",IF(B13>=1,\"달성\",\"진행\"))"],
  ["=B14"],
]);
write(dashboard, "E9:E10", [["네이버"], ["쿠팡"]]);
formulas(dashboard, "F9:H10", [
  [
    "=SUMIFS('네이버_데이터'!E:E,'네이버_데이터'!A:A,$B$3,'네이버_데이터'!O:O,\"승인\",'네이버_데이터'!P:P,\"Y\")",
    "=SUMIFS('네이버_데이터'!D:D,'네이버_데이터'!A:A,$B$3,'네이버_데이터'!O:O,\"승인\",'네이버_데이터'!P:P,\"Y\")",
    "=IFERROR(F9/G9,0)",
  ],
  [
    "=SUMIFS('쿠팡_데이터'!E:E,'쿠팡_데이터'!A:A,$B$3,'쿠팡_데이터'!O:O,\"승인\",'쿠팡_데이터'!P:P,\"Y\")",
    "=SUMIFS('쿠팡_데이터'!D:D,'쿠팡_데이터'!A:A,$B$3,'쿠팡_데이터'!O:O,\"승인\",'쿠팡_데이터'!P:P,\"Y\")",
    "=IFERROR(F10/G10,0)",
  ],
]);
write(dashboard, "A17:H17", [["운영 체크", "기준", "현재 상태", "담당", "다음 조치", "마감", "공개 영향", "메모"]]);
styleHeader(dashboard, "A17:H17");
write(dashboard, "A18:H22", [
  ["광고주ID", "모든 원천 탭 필수", "정상", "운영", "신규 광고주 생성 시 먼저 발급", "상시", "높음", "권한 분리 기준"],
  ["공개 승인", "관리자컨펌=승인", "검수 중", "팀장", "승인 전 광고주 화면 미노출", "오늘", "높음", "내부 메모 제거 확인"],
  ["공유 여부", "광고주공유여부=Y", "정상", "운영", "공개할 행만 Y 처리", "상시", "높음", "보고서와 데이터 동일 기준"],
  ["시트 원본", "네이버/쿠팡 분리", "정상", "분석", "월별 원천값 업데이트", "매주", "중간", "캠페인별 확장 가능"],
  ["보고서 전달", "관리자 확인 후 전달", "대기", "관리자", "PDF/엑셀 링크 검수", "이번 주", "중간", "광고주 직접 다운로드는 2차"],
]);
styleBody(dashboard, "A9:H22");
dashboard.getRange("B9:B10").format.numberFormat = "#,##0";
dashboard.getRange("B11:B11").format.numberFormat = "0.0x";
dashboard.getRange("B13:B13").format.numberFormat = "0%";
dashboard.getRange("F9:G10").format.numberFormat = "#,##0";
dashboard.getRange("H9:H10").format.numberFormat = "0.0x";
finishSheet(dashboard, "A1:H22");

const clients = addSheet("광고주_목록");
write(clients, "A1:J1", [["client_id", "광고주명", "브랜드명", "agency_code", "담당자", "상태", "sheet_id", "로그인 이메일", "생성일", "메모"]]);
write(clients, "A2:J5", [
  ["MI-CLIENT-001", "예시브랜드", "예시브랜드", "MI-AGENCY-2026", "운영 관리자", "운영 중", "SHEET-DEMO-001", "client@example.com", "2026-06-01", "데모 기본 광고주"],
  ["MI-CLIENT-002", "신규브랜드 A", "신규브랜드 A", "MI-AGENCY-A", "차장", "세팅", "SHEET-DEMO-002", "new@example.com", "2026-06-10", "KPI 목표 입력 필요"],
  ["MI-CLIENT-003", "리텐션브랜드 B", "리텐션브랜드 B", "MI-AGENCY-B", "팀장", "운영 중", "SHEET-DEMO-003", "retention@example.com", "2026-05-20", "일정 공개 완료"],
  ["", "", "", "", "", "", "", "", "", ""],
]);
styleHeader(clients, "A1:J1");
styleBody(clients, "A2:J30");
styleInput(clients, "A2:J30");
finishSheet(clients, "A1:J30");

const publicData = addSheet("대시보드_공개데이터");
write(publicData, "A1:Q1", [["client_id", "기준월", "목표매출", "실제매출", "광고비", "구매수", "노출수", "클릭수", "전환수", "ROAS", "CTR", "CVR", "목표달성률", "관리자컨펌", "광고주공유여부", "공개코멘트", "업데이트일"]]);
write(publicData, "A2:I6", [
  ["MI-CLIENT-001", "2026-06", 36000000, 41800000, 7200000, 1248, 890000, 36600, 1761],
  ["MI-CLIENT-002", "2026-06", 18000000, 0, 0, 0, 0, 0, 0],
  ["MI-CLIENT-003", "2026-06", 26000000, 29100000, 5100000, 890, 612000, 22100, 1030],
  ["", "", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", ""],
]);
formulas(publicData, "J2:M30", Array.from({ length: 29 }, (_, i) => {
  const row = i + 2;
  return [
    `=IFERROR(D${row}/E${row},0)`,
    `=IFERROR(H${row}/G${row},0)`,
    `=IFERROR(I${row}/H${row},0)`,
    `=IFERROR(D${row}/C${row},0)`,
  ];
}));
write(publicData, "N2:Q6", [
  ["승인", "Y", "다음 주에는 메타 소재 교체와 쿠팡 키워드 보강을 우선 진행하겠습니다.", "2026-06-19"],
  ["대기", "N", "KPI 목표 입력 후 공개 예정입니다.", "2026-06-19"],
  ["승인", "Y", "주간 일정과 매출 흐름은 정상입니다.", "2026-06-19"],
  ["", "", "", ""],
  ["", "", "", ""],
]);
styleHeader(publicData, "A1:Q1");
styleBody(publicData, "A2:Q30");
styleInput(publicData, "A2:I30");
styleInput(publicData, "N2:Q30");
publicData.getRange("C2:E30").format.numberFormat = "#,##0";
publicData.getRange("F2:I30").format.numberFormat = "#,##0";
publicData.getRange("J2:J30").format.numberFormat = "0.0x";
publicData.getRange("K2:M30").format.numberFormat = "0.0%";
finishSheet(publicData, "A1:Q30");

function buildChannelSheet(name) {
  const sheet = addSheet(name);
  write(sheet, "A1:P1", [["client_id", "일자", "캠페인", "광고비", "매출", "노출수", "클릭수", "전환수", "구매수", "ROAS", "CTR", "CVR", "CPA", "CPC", "관리자컨펌", "광고주공유여부"]]);
  const sample = name.startsWith("네이버")
    ? ["MI-CLIENT-001", "2026-06-19", "브랜드 검색 캠페인", 3200000, 18600000, 510000, 19400, 951, 642, "승인", "Y"]
    : ["MI-CLIENT-001", "2026-06-19", "상품 검색 캠페인", 2210000, 14200000, 380000, 17200, 810, 438, "승인", "Y"];
  write(sheet, "A2:I6", [
    sample.slice(0, 9),
    ["MI-CLIENT-003", "2026-06-19", name.startsWith("네이버") ? "검색 확장 캠페인" : "상품 확장 캠페인", 1800000, 9400000, 220000, 8600, 412, 301],
    ["", "", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", ""],
  ]);
  formulas(sheet, "J2:N30", Array.from({ length: 29 }, (_, i) => {
    const row = i + 2;
    return [
      `=IFERROR(E${row}/D${row},0)`,
      `=IFERROR(G${row}/F${row},0)`,
      `=IFERROR(H${row}/G${row},0)`,
      `=IFERROR(D${row}/H${row},0)`,
      `=IFERROR(D${row}/G${row},0)`,
    ];
  }));
  write(sheet, "O2:P6", [
    [sample[9], sample[10]],
    ["승인", "Y"],
    ["", ""],
    ["", ""],
    ["", ""],
  ]);
  styleHeader(sheet, "A1:P1");
  styleBody(sheet, "A2:P30");
  styleInput(sheet, "A2:I30");
  styleInput(sheet, "O2:P30");
  sheet.getRange("D2:E30").format.numberFormat = "#,##0";
  sheet.getRange("F2:I30").format.numberFormat = "#,##0";
  sheet.getRange("J2:J30").format.numberFormat = "0.0x";
  sheet.getRange("K2:L30").format.numberFormat = "0.0%";
  sheet.getRange("M2:N30").format.numberFormat = "#,##0";
  finishSheet(sheet, "A1:P30");
}

buildChannelSheet("네이버_데이터");
buildChannelSheet("쿠팡_데이터");

const kpi = addSheet("KPI_목표");
write(kpi, "A1:K1", [["client_id", "기준월", "목표매출", "목표ROAS", "목표구매수", "목표리뷰수", "목표키워드순위", "실제매출", "달성률", "상태", "메모"]]);
write(kpi, "A2:H6", [
  ["MI-CLIENT-001", "2026-06", 36000000, 5, 1200, 80, 3, 41800000],
  ["MI-CLIENT-002", "2026-06", 18000000, 4, 500, 30, 10, 0],
  ["MI-CLIENT-003", "2026-06", 26000000, 4.5, 780, 50, 5, 29100000],
  ["", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
]);
formulas(kpi, "I2:J30", Array.from({ length: 29 }, (_, i) => {
  const row = i + 2;
  return [
    `=IFERROR(H${row}/C${row},0)`,
    `=IF(A${row}=\"\",\"\",IF(I${row}>=1,\"달성\",IF(I${row}>=0.8,\"추적\",\"위험\")))`,
  ];
}));
write(kpi, "K2:K6", [["월간 목표 초과"], ["초기 세팅 필요"], ["안정"], [""], [""]]);
styleHeader(kpi, "A1:K1");
styleBody(kpi, "A2:K30");
styleInput(kpi, "A2:H30");
styleInput(kpi, "K2:K30");
kpi.getRange("C2:C30").format.numberFormat = "#,##0";
kpi.getRange("D2:D30").format.numberFormat = "0.0x";
kpi.getRange("I2:I30").format.numberFormat = "0%";
finishSheet(kpi, "A1:K30");

const reports = addSheet("보고서_목록");
write(reports, "A1:J1", [["report_id", "client_id", "보고서유형", "기준기간", "파일/링크", "관리자컨펌", "광고주공유여부", "전달상태", "담당자", "메모"]]);
write(reports, "A2:J6", [
  ["R-001", "MI-CLIENT-001", "주간 보고서", "2026-06 2주차", "https://drive.example/weekly", "승인", "Y", "전달 예정", "운영 관리자", "내부 메모 제거 완료"],
  ["R-002", "MI-CLIENT-001", "월간 보고서", "2026-06", "https://drive.example/monthly", "대기", "N", "준비 중", "운영 관리자", "수치 검수 중"],
  ["R-003", "MI-CLIENT-003", "KPI 보고서", "2026-06", "https://drive.example/kpi", "승인", "Y", "전달 완료", "팀장", "정상"],
  ["", "", "", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", "", ""],
]);
styleHeader(reports, "A1:J1");
styleBody(reports, "A2:J30");
styleInput(reports, "A2:J30");
finishSheet(reports, "A1:J30");

const schedule = addSheet("일정표");
write(schedule, "A1:J1", [["schedule_id", "client_id", "일자", "일정유형", "제목", "상세", "상태", "공개여부", "담당자", "메모"]]);
write(schedule, "A2:J7", [
  ["S-001", "MI-CLIENT-001", "2026-06-21", "소재", "메타 소재 교체", "기존 소재 피로도 반영", "진행 중", "Y", "디자인", "광고주 문구 확인 필요"],
  ["S-002", "MI-CLIENT-001", "2026-06-24", "보고서", "월간 보고서 전달", "관리자가 다운로드 후 전달", "예정", "Y", "운영 관리자", "내부 메모 제거"],
  ["S-003", "MI-CLIENT-001", "2026-06-27", "키워드", "쿠팡 키워드 보강", "상품명과 검색어 반영", "예정", "Y", "분석", "키워드 20개 확장"],
  ["S-004", "MI-CLIENT-002", "2026-06-28", "세팅", "KPI 목표 확정", "초기 목표 입력", "확인 필요", "N", "차장", "공개 전"],
  ["", "", "", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", "", ""],
]);
styleHeader(schedule, "A1:J1");
styleBody(schedule, "A2:J30");
styleInput(schedule, "A2:J30");
finishSheet(schedule, "A1:J30");

const insights = addSheet("인사이트_액션플랜");
write(insights, "A1:K1", [["insight_id", "client_id", "작성일", "구분", "핵심변화", "낮은지표", "개선제안", "다음액션", "관리자컨펌", "광고주공유여부", "내부메모"]]);
write(insights, "A2:K6", [
  ["I-001", "MI-CLIENT-001", "2026-06-19", "주간", "네이버 CTR 상승", "쿠팡 키워드 확장 부족", "상품명/검색어 필드 보강", "메타 소재 교체 + 쿠팡 키워드 20개 추가", "승인", "Y", "내부 판단: 예산 증액은 다음 주 검토"],
  ["I-002", "MI-CLIENT-003", "2026-06-19", "주간", "일정 진행 안정", "리뷰 증가 속도 둔화", "리뷰 요청 프로세스 보강", "리뷰 확보 캠페인 진행", "승인", "Y", "내부 판단: 담당자 확인"],
  ["", "", "", "", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", "", "", ""],
]);
styleHeader(insights, "A1:K1");
styleBody(insights, "A2:K30");
styleInput(insights, "A2:K30");
finishSheet(insights, "A1:K30");

const rules = addSheet("공개규칙");
write(rules, "A1:F1", [["규칙", "설명", "광고주 화면 노출", "관리자 화면 노출", "필수 여부", "비고"]]);
write(rules, "A2:F9", [
  ["광고주ID", "모든 시트의 기본 연결 키", "본인 ID만", "전체", "필수", "이름 대신 ID로 연결"],
  ["관리자컨펌", "승인/대기/반려", "승인만", "전체", "필수", "미승인 행은 숨김"],
  ["광고주공유여부", "Y/N", "Y만", "전체", "필수", "내부 자료 분리"],
  ["내부메모", "운영 판단 기록", "숨김", "표시", "필수", "광고주 화면 노출 금지"],
  ["공개코멘트", "광고주용 해석", "표시", "표시", "권장", "짧고 실행 중심"],
  ["보고서 파일", "PDF/엑셀/링크", "직접 노출 안 함", "관리자 전달", "권장", "초기 운영은 관리자 전달"],
  ["시트 원본", "네이버/쿠팡/메타 원천값", "숨김", "표시", "필수", "계산값만 공개"],
  ["변경이력", "수정자와 공개 시간", "숨김", "표시", "필수", "실제 개발 시 DB 로그"],
]);
styleHeader(rules, "A1:F1");
styleBody(rules, "A2:F20");
finishSheet(rules, "A1:F20");

await fs.mkdir(outputDir, { recursive: true });
const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(`${outputDir}/${finalName}`);
await fs.copyFile(`${outputDir}/${finalName}`, finalName);

const dashboardCheck = await workbook.inspect({
  kind: "table",
  range: "운영_대시보드!A1:H22",
  include: "values,formulas",
  tableMaxRows: 22,
  tableMaxCols: 8,
});
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
});
await workbook.render({ sheetName: "운영_대시보드", range: "A1:H22", scale: 2 });
await workbook.render({ sheetName: "대시보드_공개데이터", range: "A1:Q12", scale: 2 });

console.log(JSON.stringify({
  output: `${outputDir}/${finalName}`,
  copied: finalName,
  dashboardPreviewRows: dashboardCheck.ndjson.split("\n").filter(Boolean).length,
  formulaErrorScan: errors.ndjson,
}, null, 2));
