// 계정별 순위 추적 키워드 등록 한도.
//
// 기본값 50 은 지금까지 두 핸들러에 하드코딩돼 있던 숫자와 같다. 총관리자가
// 계정별로 다른 숫자를 지정하면 clients.rank_keyword_limit(광고주) 또는
// operation_team_codes.rank_keyword_limit(광고주 미연결 운영팀)에 저장된다.
// 컬럼이 아직 없는 DB(마이그레이션 적용 전)에서는 조회가 에러를 돌려주므로
// 기본값 50 으로 떨어뜨린다. 배포가 마이그레이션보다 먼저 나가도 오늘과
// 똑같이 동작해야 한다.

export const DEFAULT_RANK_KEYWORD_LIMIT = 50;
export const MIN_RANK_KEYWORD_LIMIT = 1;
// DB CHECK 는 1..10000 이다. 여기서 더 좁히는 이유는 수집 주기 용량 때문이며,
// 상향이 필요하면 이 상수 하나만 올리면 된다(10000 이하이면 마이그레이션 불필요).
export const MAX_RANK_KEYWORD_LIMIT = 1000;

export const RANK_KEYWORD_LIMIT_CODE = "RANK_KEYWORD_LIMIT_REACHED";
export const PLACE_RANK_KEYWORD_LIMIT_CODE = "PLACE_RANK_KEYWORD_LIMIT_REACHED";

const MISSING_SCHEMA_CODES = new Set(["42703", "PGRST204", "PGRST205"]);

export function isMissingRankKeywordLimitSchema(error) {
  if (!error) return false;
  if (MISSING_SCHEMA_CODES.has(String(error.code || ""))) return true;
  return /rank_keyword_limit|operation_team_codes|schema cache|does not exist/i.test(error.message || "");
}

export function parseRankKeywordLimitInput(value) {
  if (value === null || value === undefined) return { ok: true, limit: null };
  const text = String(value).trim();
  if (!text) return { ok: true, limit: null };
  const invalid = {
    ok: false,
    message: `키워드 한도는 ${MIN_RANK_KEYWORD_LIMIT}~${MAX_RANK_KEYWORD_LIMIT} 사이 숫자로 입력해주세요.`,
  };
  if (!/^[0-9]{1,5}$/.test(text)) return invalid;
  const limit = Number(text);
  if (limit < MIN_RANK_KEYWORD_LIMIT || limit > MAX_RANK_KEYWORD_LIMIT) return invalid;
  return { ok: true, limit };
}

export function normalizeStoredRankKeywordLimit(value) {
  const limit = Math.trunc(Number(value));
  if (!Number.isFinite(limit) || limit < MIN_RANK_KEYWORD_LIMIT) return null;
  return Math.min(limit, MAX_RANK_KEYWORD_LIMIT);
}

// 조회가 오류를 값으로 돌려주면 어떤 오류든 기본값으로 내려앉는다. DB 트리거가
// 진짜 상한이라 잘못 낮춰 잡아도 데이터가 깨지지 않고, 등록이 통째로 500 이 되는
// 쪽이 더 나쁘다. 다만 컬럼/테이블 없음(마이그레이션 적용 전)은 예정된 경로라
// 조용히 내려앉히고, 그 밖의 오류(타임아웃 같은 일시적 실패)는 한도를 올려둔
// 계정이 말없이 50 으로 떨어지는 사고라서 코드를 남기는 경고를 한 줄 찍는다.
// 행이 없는 것은 오류가 아니므로 경고하지 않는다. 예외(throw)는 그대로 올려보낸다.
function warnRankKeywordLimitLookupFailed(table, agencyCode, error) {
  const errorCode = String(error?.code || error?.message || "unknown");
  console.warn(
    `[rank-keyword-limit] ${table} 한도 조회 실패(code=${errorCode}) - ${agencyCode} 계정을 기본값 ${DEFAULT_RANK_KEYWORD_LIMIT} 으로 처리했습니다.`,
  );
}

export async function resolveRankKeywordLimit(ctx, agencyCode) {
  const fallback = { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" };
  const code = String(agencyCode || "").trim().toLowerCase();
  if (!code) return fallback;

  const clientResult = await ctx.supabaseAdmin
    .from("clients")
    .select("rank_keyword_limit")
    .eq("agency_code", code)
    .maybeSingle();
  if (clientResult.error) {
    if (!isMissingRankKeywordLimitSchema(clientResult.error)) {
      warnRankKeywordLimitLookupFailed("clients", code, clientResult.error);
    }
    return fallback;
  }
  if (clientResult.data) {
    const stored = normalizeStoredRankKeywordLimit(clientResult.data.rank_keyword_limit);
    return stored === null ? fallback : { limit: stored, source: "client" };
  }

  const teamResult = await ctx.supabaseAdmin
    .from("operation_team_codes")
    .select("rank_keyword_limit")
    .eq("team_code", code)
    .maybeSingle();
  if (teamResult.error) {
    if (!isMissingRankKeywordLimitSchema(teamResult.error)) {
      warnRankKeywordLimitLookupFailed("operation_team_codes", code, teamResult.error);
    }
    return fallback;
  }
  if (!teamResult.data) return fallback;
  const storedTeam = normalizeStoredRankKeywordLimit(teamResult.data.rank_keyword_limit);
  return storedTeam === null ? fallback : { limit: storedTeam, source: "team" };
}

export function rankKeywordLimitMessage(limit, kind = "product") {
  const prefix = kind === "place" ? "플레이스 키워드" : "키워드";
  return `${prefix} 등록 한도 ${limit}개를 모두 사용했습니다. 한도 상향이 필요하시면 관리자에게 문의해주세요.`;
}

// 마이그레이션 적용 전에는 옛 문구, 적용 후에는 새 문구로 올라온다. 둘 다 잡는다.
export function isRankKeywordLimitDbError(error) {
  if (!error) return false;
  if (String(error.code || "") !== "P0001") return false;
  return /키워드 등록 한도|50개까지만/.test(String(error.message || ""));
}
