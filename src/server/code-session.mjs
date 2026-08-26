import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SESSION_VERSION = "v1";
const SESSION_AAD = Buffer.from("moment-insight-code-session:v1", "utf8");
const DEFAULT_SESSION_SECONDS = 60 * 60 * 8;
// "자동 로그인"으로 만든 세션만 이 수명을 쓴다. 새 환경변수를 만들지 않는다 —
// 런타임 환경 게이트(scripts/check-runtime-env.mjs)가 잠겨 있어 검증해 주지 못한다.
export const PERSISTENT_SESSION_SECONDS = 60 * 60 * 24 * 30;
const MIN_SECRET_BYTES = 32;
const PROD_COOKIE = "__Host-mi-session";
const DEV_COOKIE = "mi-session";
const VALID_ROLES = new Set(["owner", "team", "client"]);

function isProduction(env = process.env) {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function configuredSecrets(env = process.env) {
  const production = isProduction(env);
  return [env.MI_SESSION_SECRET, env.MI_SESSION_SECRET_PREVIOUS]
    .map((value) => String(value || ""))
    .filter((value) => Boolean(value) && (!production || Buffer.byteLength(value, "utf8") >= MIN_SECRET_BYTES));
}

function keyFor(secret) {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function sessionConfiguration(env = process.env) {
  const rawSecrets = [env.MI_SESSION_SECRET, env.MI_SESSION_SECRET_PREVIOUS]
    .map((value) => String(value || ""));
  const secrets = configuredSecrets(env);
  const active = rawSecrets[0];
  const rawTtl = env.MI_SESSION_TTL_SECONDS;
  const parsedTtl = rawTtl === undefined || rawTtl === "" ? DEFAULT_SESSION_SECONDS : Number(rawTtl);
  const ttlNumberValid = Number.isFinite(parsedTtl) && parsedTtl > 0;
  const ttl = Math.min(
    60 * 60 * 24,
    Math.max(60 * 5, ttlNumberValid ? parsedTtl : DEFAULT_SESSION_SECONDS),
  );
  const activeStrong = Buffer.byteLength(active, "utf8") >= MIN_SECRET_BYTES;
  const previousStrong = !rawSecrets[1] || Buffer.byteLength(rawSecrets[1], "utf8") >= MIN_SECRET_BYTES;
  const production = isProduction(env);
  const valid = production
    ? activeStrong && previousStrong && ttlNumberValid
    : Boolean(active) && ttlNumberValid;

  return {
    valid,
    reason: valid
      ? ""
      : (!ttlNumberValid
        ? "MI_SESSION_TTL_SECONDS must be a finite positive number"
        : "MI_SESSION_SECRET and MI_SESSION_SECRET_PREVIOUS must each contain at least 32 bytes"),
    secrets,
    ttl,
    production,
    cookieName: production ? PROD_COOKIE : DEV_COOKIE,
  };
}

export function createSessionClaims(input, options = {}) {
  const now = Number(options.now || Date.now());
  const ttlSeconds = Number(options.ttlSeconds || DEFAULT_SESSION_SECONDS);
  const persist = options.persist === true;
  const role = String(input?.role || "");
  if (!VALID_ROLES.has(role)) throw new Error("invalid_session_role");

  return {
    v: 1,
    sid: base64url(randomBytes(18)),
    csrf: base64url(randomBytes(24)),
    role,
    agencyCode: String(input.agencyCode || "").slice(0, 128),
    teamCode: String(input.teamCode || "").slice(0, 128),
    teamId: String(input.teamId || "").slice(0, 128),
    clientId: String(input.clientId || "").slice(0, 128),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSeconds,
    ...(persist ? { pst: 1 } : {}),
  };
}

export function sealSession(claims, env = process.env) {
  const config = sessionConfiguration(env);
  if (!config.valid || !config.secrets[0]) throw new Error("session_secret_unavailable");

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(config.secrets[0]), iv);
  cipher.setAAD(SESSION_AAD);
  const plaintext = Buffer.from(JSON.stringify(claims), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SESSION_VERSION, base64url(iv), base64url(ciphertext), base64url(tag)].join(".");
}

function validClaims(value, now = Date.now()) {
  if (!value || value.v !== 1 || !VALID_ROLES.has(value.role)) return null;
  if (!Number.isFinite(value.iat) || !Number.isFinite(value.exp)) return null;
  const nowSeconds = Math.floor(now / 1000);
  if (value.iat > nowSeconds + 60 || value.exp <= nowSeconds) return null;
  const maxLifetime = value.pst === 1 ? PERSISTENT_SESSION_SECONDS : 60 * 60 * 24;
  if (!value.sid || !value.csrf || value.exp - value.iat > maxLifetime) return null;
  return value;
}

export function openSession(token, env = process.env, options = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return null;

  let iv;
  let ciphertext;
  let tag;
  try {
    iv = fromBase64url(parts[1]);
    ciphertext = fromBase64url(parts[2]);
    tag = fromBase64url(parts[3]);
  } catch {
    return null;
  }
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > 4096) return null;

  for (const secret of configuredSecrets(env)) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
      decipher.setAAD(SESSION_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString("utf8"));
      const claims = validClaims(parsed, options.now || Date.now());
      if (claims) return claims;
    } catch {
      // Try the previous rotation key before treating the token as invalid.
    }
  }
  return null;
}

export function parseCookies(request) {
  const raw = String(request?.headers?.get?.("cookie") || "");
  return Object.fromEntries(raw.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 1) return null;
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(Boolean));
}

export function sessionFromRequest(request, env = process.env, options = {}) {
  const cookies = parseCookies(request);
  const token = isProduction(env)
    ? (cookies[PROD_COOKIE] || "")
    : (cookies[DEV_COOKIE] || cookies[PROD_COOKIE] || "");
  return openSession(token, env, options);
}

export function sessionCookie(token, env = process.env, options = {}) {
  const config = sessionConfiguration(env);
  const requested = Number(options.maxAge);
  const maxAge = Number.isFinite(requested) && requested > 0
    ? Math.min(PERSISTENT_SESSION_SECONDS, Math.floor(requested))
    : config.ttl;
  const parts = [
    `${config.cookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    "Priority=High",
  ];
  if (config.production) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookies(env = process.env) {
  const secure = isProduction(env) ? "; Secure" : "";
  return [PROD_COOKIE, DEV_COOKIE].map((name) => (
    `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Priority=High${secure}`
  ));
}

export function csrfMatches(claims, supplied) {
  const expected = Buffer.from(String(claims?.csrf || ""), "utf8");
  const actual = Buffer.from(String(supplied || ""), "utf8");
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}

// 클레임 exp 와 쿠키 Max-Age 가 어긋나지 않도록 숫자는 여기서만 나온다.
export function sessionLifetimeSeconds(persist, env = process.env) {
  return persist === true ? PERSISTENT_SESSION_SECONDS : sessionConfiguration(env).ttl;
}

// 세션을 다시 발급할 때 자동 로그인의 원래 만료 시각을 그대로 물려준다(연장 아님).
export function reissueSessionOptions(claims, env = process.env, now = Date.now()) {
  if (claims?.pst !== 1) return { ttlSeconds: sessionConfiguration(env).ttl };
  return { ttlSeconds: Math.max(60, claims.exp - Math.floor(now / 1000)), persist: true };
}

export function publicSession(claims) {
  if (!claims) return null;
  const scopeKey = base64url(
    createHash("sha256")
      .update(`${claims.role}\u0000${claims.sid}`, "utf8")
      .digest()
      .subarray(0, 18),
  );
  return {
    role: claims.role,
    scopeKey,
    clientId: claims.clientId || "",
    teamId: claims.teamId || "",
    csrfToken: claims.csrf,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
