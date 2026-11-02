export const PRIMARY_AGENCY_CODE = "mml93-a01";

function isProduction(env = process.env) {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

export function primaryAgencyConfiguration(env = process.env) {
  const configured = String(env.MI_PRIMARY_AGENCY_CODE || "");
  const production = isProduction(env);
  const valid = configured === PRIMARY_AGENCY_CODE || (!production && configured === "");
  return {
    configured,
    effective: valid ? PRIMARY_AGENCY_CODE : "",
    production,
    valid,
  };
}

export function ownerClaimsMatchPrimary(claims, env = process.env) {
  const config = primaryAgencyConfiguration(env);
  return config.valid
    && claims?.role === "owner"
    && claims.agencyCode === PRIMARY_AGENCY_CODE;
}

function reservedCodeKey(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

// 대표 코드와 옛 대표 코드(MI_LEGACY_AGENCY_CODES, 쉼표 목록)는 총관리자만 쓴다.
// 광고주 로그인·세션 복원과 광고주·운영팀 코드 발급에 쓰지 않는다(점검 2026-11-02 F00·N1).
// 전각·대소문자·앞뒤 공백만 다른 값도 같은 코드로 본다.
export function reservedOwnerAgencyCodes(env = process.env) {
  const legacy = String(env.MI_LEGACY_AGENCY_CODES || "").split(",");
  return [...new Set([PRIMARY_AGENCY_CODE, ...legacy].map(reservedCodeKey).filter(Boolean))];
}

export function isReservedOwnerAgencyCode(value, env = process.env) {
  const code = reservedCodeKey(value);
  return Boolean(code) && reservedOwnerAgencyCodes(env).includes(code);
}
