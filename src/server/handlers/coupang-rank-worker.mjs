// C 30일 순위 수집기 API(/api/coupang-rank-worker, 명세 §6, WP3).
// 세션 없는 경로다. 게이트가 머리글을 지우지 않으므로 이 파일은 authorization(연결 코드)과 수집기 버전 머리글만 읽고,
// 그 밖의 게이트용 머리글은 하나도 읽지 않는다(정적 테스트로 강제).
// OPTIONS 는 라우터가 먼저 204 로 답한다(M2). 이 핸들러는 POST 만 다룬다.
// 측정 시각·날짜·맞추기·쉬기·속도 상한은 모두 SQL(coupang_rank_claim·record·release)이 한 트랜잭션에서 정한다.
import { withSupabase } from "@supabase/server";
import { protectedJson } from "../security.mjs";
import { requestIdFor } from "../runtime.mjs";
import {
  BROWSER_KINDS,
  CLAIM_MIN_REMAINING_SECONDS,
  COLLECTOR_VERSION_HEADER,
  ERROR_HTTP_STATUS,
  GUARD_MODES,
  MIN_BROWSER_GAP_SECONDS,
  PLATFORMS,
  RELEASE_REASONS,
  RUN_BUDGET_SECONDS,
  VERSION_PATTERN,
  WORKER_BODY_MAX_BYTES,
  compareVersion,
} from "../coupang-rank/contract.mjs";
import { isSetupMissing, loadSettings } from "../coupang-rank/db.mjs";
import { parseBearer, verifyCollectorToken } from "../coupang-rank/worker-token.mjs";
import {
  classifyCollectorPage,
  recordPayloadForRpc,
  sanitizeTitles,
  validateCollectorRecord,
} from "../coupang-rank/page-result.mjs";

const COLLECTORS_TABLE = "coupang_rank_collectors";
const ACTIONS = new Set(["hello", "claim", "record", "release"]);
const VERSION_GATED_ACTIONS = new Set(["hello", "claim"]);
const SIGNAL_THROTTLE_MS = 60_000;
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
// SQL 열 상한(coupang_rank_collectors)
const NODE_TEXT_MAX = 20;
const BROWSER_TEXT_MAX = 60;
const OS_TEXT_MAX = 60;
const GUARD_TEXT_MAX = 40;

// RPC 가 { ok:false, code } 로 돌려줄 수 있는 코드(§6.5·§6.6). HTTP 는 계약의 §3.4 표(ERROR_HTTP_STATUS)를 따른다.
// 목록 밖 코드는 500 으로 닫는다.
const RPC_FAILURE_CODES = new Set([
  "JOB_NOT_FOUND",
  "JOB_LEASE_MISMATCH",
  "JOB_KEYWORD_MISMATCH",
  "JOB_TOO_OLD",
  "RUN_STATUS_INVALID",
  "RELEASE_REASON_INVALID",
]);

const MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "POST 요청만 받습니다.",
  COLLECTOR_AUTH_REJECTED: "수집기 연결 코드가 맞지 않습니다.",
  BODY_TOO_LARGE: "요청 본문이 너무 큽니다.",
  BODY_INVALID: "요청 본문 형식이 맞지 않습니다.",
  ACTION_INVALID: "알 수 없는 요청입니다.",
  COLLECTOR_VERSION_INVALID: "수집기 버전 표기가 맞지 않습니다.",
  COLLECTOR_UPDATE_REQUIRED: "수집기를 새 버전으로 업데이트해야 합니다.",
  PAGE_INVALID: "측정 결과 형식이 맞지 않습니다.",
  RUN_STATUS_INVALID: "측정 상태 값이 맞지 않습니다.",
  RELEASE_REASON_INVALID: "반납 사유가 맞지 않습니다.",
  JOB_NOT_FOUND: "회차를 찾을 수 없습니다.",
  JOB_LEASE_MISMATCH: "다른 수집기에 맡긴 회차입니다.",
  JOB_KEYWORD_MISMATCH: "회차의 키워드가 다릅니다.",
  JOB_TOO_OLD: "보고 기한(30분)이 지난 회차입니다.",
  COUPANG_SETUP_REQUIRED: "쿠팡 순위 저장소가 아직 준비되지 않았습니다.",
  COUPANG_RANK_WORKER_FAILED: "수집기 요청을 처리하지 못했습니다.",
});

function respond(request, body, status = 200) {
  return protectedJson(request, body, status, { methods: "POST" });
}

function fail(request, status, code, extra = {}) {
  return respond(request, { ok: false, code, message: MESSAGES[code] || MESSAGES.COUPANG_RANK_WORKER_FAILED, ...extra }, status);
}

function setupRequired(request) {
  return fail(request, 503, "COUPANG_SETUP_REQUIRED");
}

function stageError(stage, error) {
  const failure = new Error(`coupang_rank_worker_${stage}_failed`);
  failure.code = String(error?.code || "");
  failure.stage = stage;
  return failure;
}

function timeMs(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  return Date.parse(String(value));
}

// 본문을 최대 maxBytes 까지만 읽는다. 넘으면 읽기를 멈추고 null(→ 413).
async function readBodyLimited(request, maxBytes) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("request_body_too_large").catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseJsonObject(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

// KST 시(0~23). Vercel 은 UTC 로 돌기 때문에 Intl 로 구한다(§5.3.4·낮음 8).
const KST_HOUR_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hourCycle: "h23" });
export function kstHourOf(nowMs) {
  const part = KST_HOUR_FORMAT.formatToParts(new Date(nowMs)).find((item) => item.type === "hour");
  return Number(part?.value) % 24;
}

// hello 의 state(§6.3). 이 순서로 판정한다: disabled → review → budget → cooldown → window → run.
export function helloStateFor(settings, nowMs) {
  if (settings?.enabled !== true) return "disabled";
  if (settings.needs_owner_review === true) return "review";
  if (settings.budget_blocked === true) return "budget";
  const cooldownMs = timeMs(settings.cooldown_until);
  if (Number.isFinite(cooldownMs) && cooldownMs > nowMs) return "cooldown";
  const hour = kstHourOf(nowMs);
  const from = Number(settings.active_from_hour);
  const to = Number(settings.active_to_hour);
  if (!Number.isInteger(from) || !Number.isInteger(to) || hour < from || hour >= to) return "window";
  return "run";
}

function optionalText(value, max) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const text = value.trim();
  if (CONTROL_CHAR_PATTERN.test(text) || Array.from(text).length > max) return { ok: false };
  return { ok: true, value: text || null };
}

// hello 본문 검증(§6.3). platform·browser.kind 는 필수, 윈도우는 edge 만. 나머지는 SQL 열 상한 안의 문자열(없으면 null).
// 반환: { ok:true, fields } (collectors 행에 쓸 칸) 또는 { ok:false }
export function helloFields(body) {
  if (!PLATFORMS.includes(body?.platform)) return { ok: false };
  const browser = body.browser;
  if (!browser || typeof browser !== "object" || Array.isArray(browser)) return { ok: false };
  if (!BROWSER_KINDS.includes(browser.kind)) return { ok: false };
  if (body.platform === "windows" && browser.kind !== "edge") return { ok: false };
  const version = optionalText(browser.version, BROWSER_TEXT_MAX);
  const node = optionalText(body.node, NODE_TEXT_MAX);
  const os = optionalText(body.os, OS_TEXT_MAX);
  const guard = optionalText(body.guard, GUARD_TEXT_MAX);
  if (!version.ok || !node.ok || !os.ok || !guard.ok) return { ok: false };
  if (guard.value !== null && !GUARD_MODES.includes(guard.value)) return { ok: false };
  const lastBrowser = version.value ? `${browser.kind} ${version.value}` : browser.kind;
  if (Array.from(lastBrowser).length > BROWSER_TEXT_MAX) return { ok: false };
  return {
    ok: true,
    fields: {
      platform: body.platform,
      last_node: node.value,
      last_browser: lastBrowser,
      last_os: os.value,
      last_guard: guard.value,
    },
  };
}

// 마지막 신호(§6.2-6). 60초에 한 번만 쓴다. 마지막 신호가 60초 안이면 쓰기 요청을 아예 보내지 않고,
// 보낼 때도 "last_seen_at 이 비었거나 60초보다 오래됨" 조건을 걸어 동시 요청이 겹쳐도 한 번만 바뀌게 한다.
// 실패는 기록만 하고 요청 처리는 계속한다(신호 갱신 때문에 결과 보고를 잃지 않게).
async function touchSignal(ctx, request, collector, version, extraFields, nowMs) {
  const lastSeenMs = timeMs(collector.last_seen_at);
  if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < SIGNAL_THROTTLE_MS) return false;
  const cutoff = new Date(nowMs - SIGNAL_THROTTLE_MS).toISOString();
  try {
    const { error } = await ctx.supabaseAdmin
      .from(COLLECTORS_TABLE)
      .update({ last_seen_at: new Date(nowMs).toISOString(), last_version: version, ...(extraFields || {}) })
      .eq("id", collector.id)
      .or(`last_seen_at.is.null,last_seen_at.lt.${cutoff}`);
    if (error) throw stageError("signal", error);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "coupang_rank_worker_signal_failed",
      requestId: requestIdFor(request),
      errorCode: String(error?.code || ""),
    }));
    return false;
  }
}

// 보관 기간 정리·예산 검사(§6.3). 마지막 정리가 없거나 6시간 지났을 때만 기다려 부른다. 실패는 기록만 한다.
async function maybeHousekeeping(ctx, request, settings, nowMs) {
  const lastMs = timeMs(settings.last_housekeeping_at);
  if (Number.isFinite(lastMs) && nowMs - lastMs < HOUSEKEEPING_INTERVAL_MS) return false;
  try {
    const { error } = await ctx.supabaseAdmin.rpc("coupang_rank_housekeeping");
    if (error) throw stageError("housekeeping", error);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "coupang_rank_worker_housekeeping_failed",
      requestId: requestIdFor(request),
      errorCode: String(error?.code || ""),
    }));
    return false;
  }
}

function rpcFailure(request, data) {
  const code = typeof data?.code === "string" ? data.code : "";
  const status = RPC_FAILURE_CODES.has(code) ? ERROR_HTTP_STATUS[code] : 0;
  if (!Number.isInteger(status) || status < 400) throw stageError("rpc_code", { code: "" });
  return fail(request, status, code);
}

async function callRpc(ctx, name, args, stage) {
  const { data, error } = await ctx.supabaseAdmin.rpc(name, args);
  if (error) {
    if (isSetupMissing(error)) return { setupMissing: true };
    throw stageError(stage, error);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw stageError(stage, { code: "" });
  return { data };
}

async function handleHello(request, ctx, { collector, settings, nowMs }) {
  await maybeHousekeeping(ctx, request, settings, nowMs);
  const state = helloStateFor(settings, nowMs);
  const cooldownMs = timeMs(settings.cooldown_until);
  return respond(request, {
    ok: true,
    serverTime: new Date(nowMs).toISOString(),
    collectorId: collector.id,
    label: collector.label ?? null,
    state,
    cooldownUntil: Number.isFinite(cooldownMs) && cooldownMs > nowMs ? settings.cooldown_until : null,
    windowMode: settings.window_mode,
    maxRunSeconds: RUN_BUDGET_SECONDS,
    claimMinRemainingSeconds: CLAIM_MIN_REMAINING_SECONDS,
    minBrowserGapSeconds: MIN_BROWSER_GAP_SECONDS,
  });
}

async function handleClaim(request, ctx, { collector }) {
  const result = await callRpc(ctx, "coupang_rank_claim", { p_collector_id: collector.id }, "claim");
  if (result.setupMissing) return setupRequired(request);
  // SQL 답(빈도 조절의 throttled 포함)을 그대로 넘기고 serverTime 만 더한다(§6.4). 수집기에는 검색어만 간다.
  return respond(request, { ok: true, ...result.data, serverTime: new Date().toISOString() });
}

async function handleRecord(request, ctx, { collector, body }) {
  const checked = validateCollectorRecord(body);
  if (!checked.ok) return fail(request, 400, "PAGE_INVALID", { field: checked.field });
  const page = sanitizeTitles(body.page);
  const classified = classifyCollectorPage(page);
  const result = await callRpc(ctx, "coupang_rank_record", {
    p_run_id: body.runId,
    p_collector_id: collector.id,
    p_keyword_key: body.keywordKey,
    p_status: classified.status,
    p_run: recordPayloadForRpc({ ...body, page }, classified),
  }, "record");
  if (result.setupMissing) return setupRequired(request);
  if (result.data.ok !== true) return rpcFailure(request, result.data);
  return respond(request, { ...result.data, ok: true });
}

async function handleRelease(request, ctx, { collector, body }) {
  if (typeof body.runId !== "string" || !UUID_PATTERN.test(body.runId)) return fail(request, 400, "BODY_INVALID");
  if (!RELEASE_REASONS.includes(body.reason)) return fail(request, 400, "RELEASE_REASON_INVALID");
  const result = await callRpc(ctx, "coupang_rank_release", {
    p_run_id: body.runId,
    p_collector_id: collector.id,
    p_reason: body.reason,
  }, "release");
  if (result.setupMissing) return setupRequired(request);
  if (result.data.ok !== true) return rpcFailure(request, result.data);
  return respond(request, { ...result.data, ok: true });
}

export async function handleCoupangRankWorkerRequest(request, ctx) {
  // 1. POST 만
  if (request.method !== "POST") return fail(request, 405, "METHOD_NOT_ALLOWED");
  // 2. 연결 코드 형식. 틀리면 본문도 DB 도 보지 않는다
  if (!parseBearer(request.headers.get("authorization"))) return fail(request, 401, "COLLECTOR_AUTH_REJECTED");

  let stage = "body";
  let action = "";
  try {
    // 3. 본문(상한 64KB, JSON 객체)
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > WORKER_BODY_MAX_BYTES)) {
      return fail(request, 413, "BODY_TOO_LARGE");
    }
    const bytes = await readBodyLimited(request, WORKER_BODY_MAX_BYTES);
    if (bytes === null) return fail(request, 413, "BODY_TOO_LARGE");
    const body = parseJsonObject(bytes);
    if (!body) return fail(request, 400, "BODY_INVALID");
    action = typeof body.action === "string" && ACTIONS.has(body.action) ? body.action : "";

    // 4. 연결 코드 해시로 수집기 행 조회(timingSafeEqual 비교·폐기 확인은 verifyCollectorToken)
    stage = "auth";
    const auth = await verifyCollectorToken(ctx, request);
    if (!auth.ok) return fail(request, auth.status, auth.code);
    const collector = auth.collector;

    // 5. 버전 머리글. 형식은 모든 요청, 최소 버전은 hello·claim 에만(record·release 는 늘 받음)
    stage = "version";
    const version = String(request.headers.get(COLLECTOR_VERSION_HEADER) || "").trim();
    if (!VERSION_PATTERN.test(version)) return fail(request, 400, "COLLECTOR_VERSION_INVALID");
    if (!action) return fail(request, 400, "ACTION_INVALID");

    let settings = null;
    if (VERSION_GATED_ACTIONS.has(action)) {
      stage = "settings";
      const loaded = await loadSettings(ctx);
      if (loaded.setupRequired) return setupRequired(request);
      settings = loaded.settings;
      const minVersion = typeof settings.min_collector_version === "string" ? settings.min_collector_version : "";
      if (minVersion && compareVersion(version, minVersion) < 0) {
        return fail(request, 426, "COLLECTOR_UPDATE_REQUIRED", { minVersion });
      }
    }

    // hello 는 신호와 함께 저장할 칸을 먼저 검사한다(틀린 값을 쓰지 않게)
    let helloExtra = null;
    if (action === "hello") {
      const hello = helloFields(body);
      if (!hello.ok) return fail(request, 400, "BODY_INVALID");
      helloExtra = hello.fields;
    }

    // 6. 마지막 신호(60초에 한 번)
    stage = "signal";
    const nowMs = Date.now();
    await touchSignal(ctx, request, collector, version, helloExtra, nowMs);

    // 7. 동작별 처리
    stage = action;
    const input = { collector, settings, body, nowMs };
    if (action === "hello") return await handleHello(request, ctx, input);
    if (action === "claim") return await handleClaim(request, ctx, input);
    if (action === "record") return await handleRecord(request, ctx, input);
    return await handleRelease(request, ctx, input);
  } catch (error) {
    console.error(JSON.stringify({
      event: "coupang_rank_worker_failed",
      requestId: requestIdFor(request),
      action,
      stage: typeof error?.stage === "string" && error.stage ? error.stage : stage,
      errorCode: String(error?.code || ""),
    }));
    return fail(request, 500, "COUPANG_RANK_WORKER_FAILED");
  }
}

export default {
  fetch: withSupabase({ auth: "none", cors: false }, handleCoupangRankWorkerRequest),
};
