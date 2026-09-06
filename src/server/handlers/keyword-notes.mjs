// 조사 노트(2026-09-06 피드백 4): 키워드 조회 결과를 광고주 계정 단위로 저장·목록·삭제한다.
// 표: public.keyword_research_notes (supabase/migrations/20260906213000_keyword_research_notes.sql)
// 표가 아직 없으면 ok:false reason:table_missing 을 200으로 돌려 화면이 안내만 보이게 한다.
// 순위 수집·추적과 무관한 독립 표. 서비스 롤로만 접근한다.
import { withSupabase } from "@supabase/server";
import { resolveScope } from "./home-feed.mjs";

const TABLE = "keyword_research_notes";
const MAX_NOTES = 50;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function tableMissing(error) {
  const text = String(error?.message || "");
  return error?.code === "42P01" || error?.code === "PGRST205" || /does not exist|schema cache/i.test(text);
}

export function cleanKeywords(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((value) => String(value || "").trim().slice(0, 80))
    .filter((value) => value && !seen.has(value) && seen.add(value))
    .slice(0, 5);
}

export function cleanSnapshots(list) {
  return (Array.isArray(list) ? list : []).slice(0, 5).map((item) => ({
    keyword: String(item?.keyword || "").trim().slice(0, 80),
    volume: Number.isFinite(Number(item?.volume)) ? Number(item.volume) : null,
    peakMonth: String(item?.peakMonth || "").slice(0, 12),
    checkedAt: String(item?.checkedAt || new Date().toISOString()).slice(0, 40),
  }));
}

export async function handleKeywordNotesRequest(request, ctx) {
  const scope = resolveScope(request);
  if (!scope.ok || !scope.accountCode) return json({ ok: false, message: "세션 역할을 확인할 수 없습니다." }, 401);
  const db = ctx.supabaseAdmin;
  try {
    if (request.method === "GET") {
      const { data, error } = await db
        .from(TABLE)
        .select("id, title, keywords, snapshots, created_at")
        .eq("agency_code", scope.accountCode)
        .order("created_at", { ascending: false })
        .limit(MAX_NOTES);
      if (error) throw error;
      return json({ ok: true, items: data || [] });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const keywords = cleanKeywords(body?.keywords);
      if (!keywords.length) return json({ ok: false, message: "키워드가 없습니다." }, 400);
      const row = {
        agency_code: scope.accountCode,
        title: String(body?.title || keywords.join(" · ")).trim().slice(0, 80) || keywords.join(" · "),
        keywords,
        snapshots: cleanSnapshots(body?.snapshots),
        created_by_role: scope.role,
      };
      const { data, error } = await db.from(TABLE).insert(row).select("id, title, keywords, snapshots, created_at").single();
      if (error) throw error;
      return json({ ok: true, item: data });
    }
    if (request.method === "DELETE") {
      const id = String(new URL(request.url).searchParams.get("id") || "").trim();
      if (!id) return json({ ok: false, message: "id가 필요합니다." }, 400);
      const { error } = await db.from(TABLE).delete().eq("agency_code", scope.accountCode).eq("id", id);
      if (error) throw error;
      return json({ ok: true });
    }
    return json({ ok: false, message: "Method not allowed" }, 405);
  } catch (error) {
    if (tableMissing(error)) return json({ ok: false, reason: "table_missing", message: "조사 노트 표가 아직 없습니다." }, 200);
    return json({ ok: false, message: "조사 노트 처리 중 오류가 발생했습니다." }, 500);
  }
}

export default {
  fetch: withSupabase({ auth: "none" }, handleKeywordNotesRequest),
};
