import { withSupabase } from "@supabase/server";
import { PRIMARY_AGENCY_CODE } from "../owner-identity.mjs";
import { protectedJson } from "../security.mjs";

// 운영 공지 팝업(대표 결정 2026-09-18). 총관리자가 관리자 화면에서 저장한 단일 공지(site_notices id=1)를
// 로그인한 모든 세션(총관리자·운영팀·광고주·체험)이 GET 으로 읽고, 표시 기간 안에 켜져 있을 때만 팝업으로 본다.
// 저장(POST)은 총관리자 세션만 가능하다. 날짜는 KST 달력일 기준(시작 00:00, 종료 23:59:59.999)이다.
export const SITE_NOTICE_PATH = "/api/site-notice";
export const SITE_NOTICE_TITLE_MAX = 80;
export const SITE_NOTICE_BODY_MAX = 600;
const NOTICE_COLUMNS = "id, title, body, starts_at, ends_at, enabled, updated_at";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SESSION_ROLES = new Set(["owner", "team", "client"]);

function response(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-csrf",
  });
}

function sessionRole(request) {
  return String(request.headers.get("x-mi-session-role") || "").trim();
}

function ownerRequest(request) {
  return sessionRole(request) === "owner"
    && request.headers.get("x-mi-owner-agency-code") === PRIMARY_AGENCY_CODE;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/[ ]*\n[ ]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function kstDateToUtcIso(date, endOfDay = false) {
  const text = String(date || "").trim();
  if (!DATE_PATTERN.test(text)) return null;
  const ms = Date.parse(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+09:00`);
  if (!Number.isFinite(ms)) return null;
  return utcIsoToKstDate(new Date(ms).toISOString()) === text ? new Date(ms).toISOString() : null;
}

export function utcIsoToKstDate(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "";
  const kst = new Date(ms + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(kst.getUTCDate())}`;
}

export function validateSiteNoticeInput(body) {
  const title = cleanText(body?.title);
  const text = cleanText(body?.body);
  if (!title || title.length > SITE_NOTICE_TITLE_MAX) {
    return { ok: false, message: `제목은 1~${SITE_NOTICE_TITLE_MAX}자로 입력해주세요.` };
  }
  if (!text || text.length > SITE_NOTICE_BODY_MAX) {
    return { ok: false, message: `내용은 1~${SITE_NOTICE_BODY_MAX}자로 입력해주세요.` };
  }
  const startsAt = kstDateToUtcIso(body?.startDate, false);
  const endsAt = kstDateToUtcIso(body?.endDate, true);
  if (!startsAt || !endsAt) {
    return { ok: false, message: "시작일과 종료일을 YYYY-MM-DD 형식으로 입력해주세요." };
  }
  if (Date.parse(endsAt) < Date.parse(startsAt)) {
    return { ok: false, message: "종료일은 시작일보다 앞설 수 없습니다." };
  }
  const enabled = body?.enabled === true || body?.enabled === "true" || body?.enabled === 1;
  return { ok: true, value: { title, body: text, starts_at: startsAt, ends_at: endsAt, enabled } };
}

export function noticeIsActive(row, nowMs = Date.now()) {
  if (!row || row.enabled !== true) return false;
  const startsAt = Date.parse(String(row.starts_at || ""));
  const endsAt = Date.parse(String(row.ends_at || ""));
  return Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt <= nowMs && nowMs <= endsAt;
}

export function publicNotice(row) {
  return {
    id: Number(row.id),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    updatedAt: row.updated_at,
  };
}

export function editableNotice(row) {
  return {
    ...publicNotice(row),
    startDate: utcIsoToKstDate(row.starts_at),
    endDate: utcIsoToKstDate(row.ends_at),
    enabled: row.enabled === true,
  };
}

async function readNotice(ctx) {
  const { data, error } = await ctx.supabaseAdmin
    .from("site_notices")
    .select(NOTICE_COLUMNS)
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function handleSiteNoticeRequest(request, ctx, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  if (new URL(request.url).pathname !== SITE_NOTICE_PATH) {
    return response(request, { ok: false, message: "Not found" }, 404);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!SESSION_ROLES.has(sessionRole(request))) {
    return response(request, { ok: false, message: "로그인이 필요합니다." }, 401);
  }
  if (request.method === "GET") {
    let row = null;
    try {
      row = await readNotice(ctx);
    } catch {
      return response(request, { ok: false, message: "공지를 불러오지 못했습니다." }, 500);
    }
    const active = noticeIsActive(row, nowMs);
    return response(request, {
      ok: true,
      notice: active ? publicNotice(row) : null,
      ...(ownerRequest(request) ? { editable: row ? editableNotice(row) : null, active } : {}),
    });
  }
  if (request.method !== "POST") return response(request, { ok: false, message: "Method not allowed" }, 405);
  if (!ownerRequest(request)) {
    return response(request, { ok: false, message: "총관리자 전용 기능입니다." }, 403);
  }
  if (String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return response(request, { ok: false, message: "JSON 요청만 허용됩니다." }, 415);
  }
  const body = await request.json().catch(() => null);
  if (!body || body.action !== "save") return response(request, { ok: false, message: "요청 내용을 확인해주세요." }, 400);
  const validated = validateSiteNoticeInput(body);
  if (!validated.ok) return response(request, { ok: false, message: validated.message }, 400);
  const row = {
    id: 1,
    ...validated.value,
    updated_at: new Date(nowMs).toISOString(),
    updated_by: "owner",
  };
  const { data, error } = await ctx.supabaseAdmin
    .from("site_notices")
    .upsert(row, { onConflict: "id" })
    .select(NOTICE_COLUMNS)
    .single();
  if (error || !data) {
    return response(request, { ok: false, message: "공지를 저장하지 못했습니다." }, 500);
  }
  const active = noticeIsActive(data, nowMs);
  return response(request, {
    ok: true,
    editable: editableNotice(data),
    active,
    notice: active ? publicNotice(data) : null,
  });
}

export default {
  fetch: withSupabase({ auth: "none" }, (request, ctx) => handleSiteNoticeRequest(request, ctx)),
};
