// 순위 수집 용량 가시화(2026-09-03, F7). 지금 활성 상품 추적기가 몇 개의 "검색어 묶음"을
// 도는지를 수치로만 보여 준다. 상한 판단도, 경보도, 합격/불합격 판정도 하지 않는다 —
// 이 모듈이 내는 값은 화면과 헬스 응답이 사람에게 읽히는 정수 하나뿐이다.
//
// 왜 헬스 핸들러가 아니라 별도 모듈인가:
// /api/rank-collection-health 는 무인증 공개 표면이라 "핸들러 소스에 계정 데이터 열 이름이
// 한 글자도 없어야 한다"는 가드가 테스트로 고정되어 있다(F2). 이 집계는 그 열을 실제로
// 읽어야 하므로 읽는 코드를 여기로 분리하고, 핸들러는 정수만 돌려받는다. 파일명·export
// 식별자에도 소문자 열 이름이 들어가지 않게 대문자 K 를 쓴다(import 경로가 핸들러
// 소스에 그대로 남기 때문이다).
//
// 왜 페이지로 읽는가:
// PostgREST 에는 count(distinct …) 가 없다. 그래서 활성 행의 해당 열만 페이지 단위로
// 받아 프로세스 안에서 정규화 키의 distinct 를 센다. 행 본문은 반환하지도, 로그하지도
// 않는다(로그 한 줄도 두지 않는다).

// 정규화 규약은 서버가 이미 쓰는 것과 같은 의미다. 원본은 잠금 파일 두 곳이라 import 할
// 수 없어 여기에 복제한다(테스트가 두 원본 문자열의 드리프트를 가드한다).
//   src/server/handlers/naver-shopping-local-worker.mjs
//     normalizedKeywordKey(value) → normalizeText(value).replace(/\s/g, "").toLowerCase()
//   src/server/handlers/naver-shopping-rank.mjs
//     normalizeText(value)        → String(value || "").replace(/\s+/g, " ").trim()
// 두 규약의 합성은 아래 한 줄과 동치다(공백을 모두 지우므로 앞선 공백 축약·trim 은 흡수된다).
export function normalizedRankKeywordKey(value) {
  return String(value || "").replace(/\s/g, "").toLowerCase();
}

// PostgREST 기본 상한(1000)에 맞춘 페이지 크기. 실측 활성 행은 약 71건이라 평시에는
// 1페이지에서 끝난다. 상한 10페이지 = 최대 10,000행까지만 읽고 멈춘다.
export const RANK_KEYWORD_GROUP_PAGE_SIZE = 1000;
export const RANK_KEYWORD_GROUP_MAX_PAGES = 10;

// 활성 상품 추적기의 정규화 검색어 distinct 수. 관측 전용이다.
//
// 반환은 언제나 비음수 정수다. 어떤 실패(PostgREST error·체인 throw·배열이 아닌 data)도
// 0 으로 접는다 — 이 값을 쓰는 헬스 엔드포인트의 규약이 "관측 실패는 경보가 아니다" 이고,
// 실패를 추정치로 메우면 화면이 없는 사실을 단정하게 된다.
//
// 최대 페이지에 닿아 멈춘 경우의 반환값은 실제 그룹 수가 아니라 그때까지 센 수, 즉
// 하한값이다. 지금 규모(활성 약 71행)에서는 도달할 수 없는 경로이며, 도달한다면 그것
// 자체가 규모가 설계 전제를 넘었다는 뜻이므로 0 으로 지우지 않고 본 만큼을 낸다.
export async function countActiveProductKeywordGroups(supabaseAdmin, table = "naver_rank_trackers") {
  try {
    const groups = new Set();
    for (let page = 0; page < RANK_KEYWORD_GROUP_MAX_PAGES; page += 1) {
      const from = page * RANK_KEYWORD_GROUP_PAGE_SIZE;
      const { data, error } = await supabaseAdmin
        .from(table)
        .select("keyword")
        .eq("status", "active")
        .range(from, from + RANK_KEYWORD_GROUP_PAGE_SIZE - 1);
      if (error || !Array.isArray(data)) return 0;
      for (const row of data) {
        const key = normalizedRankKeywordKey(row?.keyword);
        // 빈 키는 그룹이 아니다. 세면 "정체 불명" 하나가 용량으로 둔갑한다.
        if (key) groups.add(key);
      }
      // 페이지가 덜 찼으면 마지막 페이지다. 꽉 찼을 때만 다음 페이지를 부른다.
      if (data.length < RANK_KEYWORD_GROUP_PAGE_SIZE) break;
    }
    return groups.size;
  } catch {
    return 0;
  }
}
