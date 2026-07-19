const SENSITIVE_METADATA_KEY = /^(?:authorization|apikey|api_key|cookie|credential|password|secret|session|token|code|agencyCode|agency_code|teamCode|team_code|ownerAgencyCode|owner_agency_code|issuedByTeamCode|issued_by_team_code)$/i;

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/\bmml93-[at]\d+\b/gi, "[redacted-code]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sb_secret|sbp|sk_live|sk_test)_[A-Za-z0-9_-]{12,}\b/g, "[redacted-secret]")
    .replace(/([?&](?:code|token|secret|apikey|api_key)=)[^&#\s]*/gi, "$1[redacted]")
    .slice(0, 2000);
}

export function sanitizeAuditMetadata(value, depth = 0) {
  if (depth > 4 || value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeAuditMetadata(item, depth + 1));
  if (typeof value !== "object") return redactSensitiveText(value);

  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (SENSITIVE_METADATA_KEY.test(key)) continue;
    output[key] = sanitizeAuditMetadata(item, depth + 1);
  }
  return output;
}
