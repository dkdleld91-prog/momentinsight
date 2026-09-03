// 계정(광고주 코드 · 운영팀 코드) 해지 · 연결 해제 시 그 계정의 순위 추적기를
// 자동 일시중지하고, 재활성화 시 그때 중지한 것만 되돌린다(F16).
//
// 왜 필요한가: 해지 핸들러는 clients 행만 바꾸고 추적기는 그대로 둔다. 수집 명단
// (20260826035440 로스터)은 tracker.status = 'active' 만 보고, 조회 게이트는
// clients.status 를 본다. 그래서 해지된 계정의 추적기는 "아무도 조회·중지할 수
// 없는데 두 레인 수집 용량은 계속 먹는" 유령이 된다.
//
// 마이그레이션 없이 되돌릴 대상을 구분해야 하므로 기존 열(last_message)에 표식
// 문자열을 남긴다. 표식은 이 파일에서만 만들고, 복구는 표식이 있는 행만 건드린다.
import {
  isRankKeywordLimitDbError,
  resolveRankKeywordLimit,
} from "./rank-keyword-limit.mjs";

// 다른 경로가 절대 쓰지 않는 값이어야 한다(드리프트 테스트로 고정).
export const RANK_TRACKER_AUTO_PAUSE_MARK = "[자동중지:계정해지]";
export const RANK_TRACKER_AUTO_PAUSE_MESSAGE =
  `${RANK_TRACKER_AUTO_PAUSE_MARK} 계정 해지·연결 해제로 순위 수집을 자동 중지했습니다.`;
// 한도가 가득 차 복구하지 못한 행. 표식을 그대로 남겨 다음 재활성화 때 다시 시도한다.
export const RANK_TRACKER_AUTO_PAUSE_LIMIT_MESSAGE =
  `${RANK_TRACKER_AUTO_PAUSE_MARK} 키워드 한도가 가득 차 자동 복구되지 못했습니다. 한도를 올린 뒤 추적 화면에서 다시 시작해주세요.`;
// 복구된 행은 표식을 지운다(같은 표식이 남으면 다음 복구가 이미 켜진 행을 다시 센다).
export const RANK_TRACKER_AUTO_RESUME_MESSAGE =
  "계정 재활성화로 순위 수집을 자동 복구했습니다. 차례가 되면 갱신합니다.";

// 상품 · 플레이스 두 레인을 같은 규칙으로 다룬다.
export const RANK_TRACKER_ACCOUNT_TABLES = Object.freeze([
  "naver_rank_trackers",
  "naver_place_rank_trackers",
]);

const RESTORE_SCAN_LIMIT = 500;

function normalizeCodes(value) {
  const codes = (Array.isArray(value) ? value : [value])
    .map((code) => String(code || "").trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(codes)];
}

function laneSummary() {
  return { paused: 0, busySkipped: 0, resumed: 0, limited: 0 };
}

function pushError(summary, table, error) {
  summary.errors.push(`${table}: ${String(error?.message || error || "unknown")}`);
}

// 진행 중 수집(processing_until 이 미래)은 건드리지 않는다. 커밋 3경로
// (updateTrackerAfterCheck / Failure / Preservation)와 assertRankLeaseOwnership 이
// 리스를 들고 있을 때 status = 'active' 를 함께 걸기 때문에, 여기서 status 만 바꾸면
// 수집기 커밋이 통째로 실패하고 리스가 만료까지 남는다. 그 행은 건너뛰고 다음 기회
// (다음 해지·해제 호출)에 처리하며, 건너뛴 수는 호출자에게 그대로 돌려준다.
export async function pauseAccountRankTrackers(ctx, agencyCodes, options = {}) {
  const codes = normalizeCodes(agencyCodes);
  const summary = { paused: 0, busySkipped: 0, lanes: {}, errors: [] };
  if (!codes.length) return summary;
  const nowIso = new Date(options.now || Date.now()).toISOString();

  for (const table of RANK_TRACKER_ACCOUNT_TABLES) {
    const lane = laneSummary();

    const busy = await ctx.supabaseAdmin
      .from(table)
      .select("id", { count: "exact", head: true })
      .in("agency_code", codes)
      .eq("status", "active")
      .gte("processing_until", nowIso);
    if (busy.error) pushError(summary, table, busy.error);
    else lane.busySkipped = Number(busy.count || 0);

    const paused = await ctx.supabaseAdmin
      .from(table)
      .update({ status: "paused", last_message: RANK_TRACKER_AUTO_PAUSE_MESSAGE })
      .in("agency_code", codes)
      .eq("status", "active")
      .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
      .select("id");
    if (paused.error) pushError(summary, table, paused.error);
    else lane.paused = (paused.data || []).length;

    summary.lanes[table] = lane;
    summary.paused += lane.paused;
    summary.busySkipped += lane.busySkipped;
  }

  return summary;
}

// 한 계정 · 한 레인의 남은 등록 여유. 트리거(trg_naver_rank_tracker_limit)가 진짜
// 상한이지만, 상품 레인은 한 행이라도 걸리면 그 UPDATE 문이 통째로 죽기 때문에
// 행 단위로 나눠 쏘고 여유를 먼저 계산해 순서대로 채운다. 조회가 실패하면 여유를
// 한도만큼으로 낙관하고 판정을 DB 트리거에 넘긴다.
async function laneCapacity(ctx, table, code) {
  const { limit } = await resolveRankKeywordLimit(ctx, code);
  const active = await ctx.supabaseAdmin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("agency_code", code)
    .eq("status", "active");
  if (active.error) return { limit, remaining: limit };
  return { limit, remaining: Math.max(0, limit - Number(active.count || 0)) };
}

async function markLimited(ctx, table, id) {
  return ctx.supabaseAdmin
    .from(table)
    .update({ last_message: RANK_TRACKER_AUTO_PAUSE_LIMIT_MESSAGE })
    .eq("id", id)
    .eq("status", "paused")
    .select("id");
}

// 재활성화 경로에서 "그때 자동 중지한" 행만 되돌린다. 광고주가 직접 중지한 추적기는
// 표식이 없으므로 그대로 둔다. 한도 초과 행은 복구하지 않고 그 사실을 last_message
// 로 남기며(표식 유지 → 다음 재활성화 때 재시도) 나머지는 계속 복구한다.
export async function resumeAccountRankTrackers(ctx, agencyCodes) {
  const codes = normalizeCodes(agencyCodes);
  const summary = { resumed: 0, limited: 0, lanes: {}, errors: [] };
  if (!codes.length) return summary;

  for (const table of RANK_TRACKER_ACCOUNT_TABLES) {
    const lane = laneSummary();
    const marked = await ctx.supabaseAdmin
      .from(table)
      .select("id, agency_code, last_message")
      .in("agency_code", codes)
      .eq("status", "paused")
      .like("last_message", `${RANK_TRACKER_AUTO_PAUSE_MARK}%`)
      .order("sort_order", { ascending: true })
      .limit(RESTORE_SCAN_LIMIT);

    if (marked.error) {
      pushError(summary, table, marked.error);
      summary.lanes[table] = lane;
      continue;
    }

    // like 필터를 믿지 않고 한 번 더 확인한다. 표식 없는 행을 되돌리는 것이
    // 이 기능에서 가장 나쁜 실수라 판정은 서버에서 다시 한다.
    const rows = (marked.data || []).filter((row) => String(row.last_message || "")
      .startsWith(RANK_TRACKER_AUTO_PAUSE_MARK));
    const capacities = new Map();

    for (const row of rows) {
      const code = String(row.agency_code || "").trim().toLowerCase();
      if (!capacities.has(code)) capacities.set(code, await laneCapacity(ctx, table, code));
      const capacity = capacities.get(code);

      if (capacity.remaining <= 0) {
        const limited = await markLimited(ctx, table, row.id);
        if (limited.error) pushError(summary, table, limited.error);
        lane.limited += 1;
        continue;
      }

      const restored = await ctx.supabaseAdmin
        .from(table)
        .update({
          status: "active",
          last_message: RANK_TRACKER_AUTO_RESUME_MESSAGE,
          processing_started_at: null,
          processing_until: null,
        })
        .eq("id", row.id)
        .eq("status", "paused")
        .select("id")
        .maybeSingle();

      if (restored.error) {
        if (isRankKeywordLimitDbError(restored.error)) {
          const limited = await markLimited(ctx, table, row.id);
          if (limited.error) pushError(summary, table, limited.error);
          lane.limited += 1;
          capacity.remaining = 0;
          continue;
        }
        pushError(summary, table, restored.error);
        continue;
      }
      if (!restored.data) continue;

      lane.resumed += 1;
      capacity.remaining -= 1;
    }

    summary.lanes[table] = lane;
    summary.resumed += lane.resumed;
    summary.limited += lane.limited;
  }

  return summary;
}
