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
