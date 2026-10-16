// C 30일 순위 수집기 연결 코드(명세 §3.1·§5.7·§6.1·§6.2, WP0). 화면 API(WP2)는 발급에, 수집기 API(WP3)는 인증에 쓴다.
// 연결 코드 = "mic1_" + base64url(32바이트). 서버는 sha256 hex(token_sha256)와 끝 4자(token_hint)만 저장한다.
// N30 비밀값·nonce 표·HMAC 모듈은 쓰지 않는다(§2.2-6). authorization 머리글 하나만 읽는다.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { COLLECTOR_TOKEN_PATTERN } from "./contract.mjs";
import { isSetupMissing } from "./db.mjs";

const COLLECTORS_TABLE = "coupang_rank_collectors";
const BEARER_PATTERN = /^Bearer (mic1_[A-Za-z0-9_-]{43})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
// token_sha256 은 응답·로그로 새지 않게 돌려주는 collector 에서 뺀다.
const COLLECTOR_COLUMNS = [
  "id", "label", "token_sha256", "token_hint", "created_at", "revoked_at", "last_seen_at",
  "platform", "last_version", "last_node", "last_browser", "last_os", "last_guard", "last_claim_at",
].join(", ");

// authorization 머리글 값에서 연결 코드를 꺼낸다. 형식이 정확히 "Bearer mic1_<43자>" 가 아니면 null.
export function parseBearer(header) {
  if (typeof header !== "string") return null;
  const match = BEARER_PATTERN.exec(header);
  if (!match) return null;
  const token = match[1];
  return COLLECTOR_TOKEN_PATTERN.test(token) ? token : null;
}

// 연결 코드의 sha256 hex(소문자 64자). DB token_sha256 과 같은 값.
export function collectorTokenHash(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

// 새 연결 코드를 만든다. token 원문은 발급 응답에 한 번만 담고 저장하지 않는다.
// 반환: { token, tokenSha256, tokenHint }  (tokenHint = token.slice(-4))
export function generateCollectorToken() {
  const token = `mic1_${randomBytes(32).toString("base64url")}`;
  if (!COLLECTOR_TOKEN_PATTERN.test(token)) throw new Error("collector_token_format");
  return { token, tokenSha256: collectorTokenHash(token), tokenHint: token.slice(-4) };
}

// 수집기 요청의 연결 코드를 확인한다(§6.2 2·4단계).
// - 형식이 틀리면 DB 를 조회하지 않고 거절한다.
// - token_sha256 = 해시인 행을 찾고, 해시를 timingSafeEqual 로 다시 비교하고, revoked_at 이 비어 있어야 통과.
// 반환
// - 통과: { ok: true, collector: <행(snake_case), token_sha256 제외>, tokenHash }
// - 거절: { ok: false, status: 401, code: "COLLECTOR_AUTH_REJECTED", message }
// - 표 없음: { ok: false, status: 503, code: "COUPANG_SETUP_REQUIRED", message }
// - 그 밖의 DB 오류: Error 를 던진다(code = DB 코드, stage = "auth"). 핸들러의 catch 가 500 으로 답한다.
export async function verifyCollectorToken(ctx, request) {
  const header = request?.headers?.get?.("authorization");
  const token = parseBearer(header);
  if (!token) return rejected();

  const tokenHash = collectorTokenHash(token);
  const { data, error } = await ctx.supabaseAdmin
    .from(COLLECTORS_TABLE)
    .select(COLLECTOR_COLUMNS)
    .eq("token_sha256", tokenHash)
    .maybeSingle();
  if (error) {
    if (isSetupMissing(error)) {
      return {
        ok: false,
        status: 503,
        code: "COUPANG_SETUP_REQUIRED",
        message: "쿠팡 순위 저장소가 아직 준비되지 않았습니다.",
      };
    }
    const failure = new Error("coupang_rank_auth_failed");
    failure.code = String(error?.code || "");
    failure.stage = "auth";
    failure.cause = error;
    throw failure;
  }
  if (!data || typeof data !== "object") return rejected();
  if (!sameHash(data.token_sha256, tokenHash)) return rejected();
  if (data.revoked_at !== null && data.revoked_at !== undefined) return rejected();

  const { token_sha256: _storedHash, ...collector } = data;
  return { ok: true, collector, tokenHash };
}

function sameHash(stored, wanted) {
  if (typeof stored !== "string" || !SHA256_HEX_PATTERN.test(stored)) return false;
  const left = Buffer.from(stored, "utf8");
  const right = Buffer.from(wanted, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function rejected() {
  return {
    ok: false,
    status: 401,
    code: "COLLECTOR_AUTH_REJECTED",
    message: "수집기 연결 코드가 맞지 않습니다.",
  };
}
