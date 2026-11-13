// 네이버 데이터랩(검색어 트렌드·쇼핑인사이트) 이용 범위 — 네이버 클라우드 답변(2026-11-13, 대표 승인 같은 날).
// 회사 직원(총관리자·운영팀)이 내부 판단에 쓰는 것만 가능하고, 광고주·체험 계정 등 회사 밖 사람에게 데이터나
// 그걸로 만든 결과(추이·비율·연령·피크 달·시즌 캘린더·증감률 등)를 보여 주거나 파일로 주는 것은 이용료와
// 상관없이 불가(약관 7.2③·7.3③·7.3⑥·7.3⑧). 그래서 서버가 직원이 아닌 세션에는 데이터랩을 부르지도,
// 응답에 담지도 않는다(화면에서 숨기는 것만으로는 직접 요청·저장본으로 새어 나간다).
// 직원 판단은 세션 게이트가 덮어쓰는 x-mi-session-role 로만 한다(바깥에서 보낸 값은 게이트가 지운다).
// 대표 결정(2026-11-13): 운영팀(team) 계정은 광고주 연결 여부와 상관없이 모두 직원으로 보고 데이터랩을 쓴다.
// 운영팀에 회사 밖 사람(외주·협력사)이 생기면 그 계정은 네이버 기준 외부 제공이므로 여기서 외부로 돌려야 한다.

const STAFF_ROLES = new Set(["owner", "team"]);

export function sessionRoleOf(request) {
  return String(request?.headers?.get?.("x-mi-session-role") || "").trim().toLowerCase();
}

// 데이터랩 값을 받아도 되는 세션인가(총관리자·운영팀만). 모르는 역할·역할 없음은 외부로 본다.
export function datalabAllowedForRole(role) {
  return STAFF_ROLES.has(String(role || "").trim().toLowerCase());
}

export function datalabAllowedForRequest(request) {
  return datalabAllowedForRole(sessionRoleOf(request));
}

// 광고주·체험 계정이 보는 문구라 "운영팀 전용"(운영팀에 따로 받으면 된다는 뜻으로 읽힘) 대신 "제공하지 않습니다"로 쓴다.
export const DATALAB_STAFF_ONLY_MESSAGE = "검색 추이·검색 비율·연령 등 네이버 데이터랩 정보는 네이버 이용 정책에 따라 제공하지 않습니다.";
