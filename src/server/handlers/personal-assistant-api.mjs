// 개인 캘린더 전용 '실장' 대화 API (/api/my/assistant-chat).
//
// 총관리자용 실장(owner-tool-api.mjs 의 runOwnerAssistantChat)과 같은 모양이지만
// 두 가지가 다르다. 첫째, 계정 판정을 resolvePersonalAccess 하나로만 한다 —
// 운영 범위로 폴백하지 않으므로 광고주 미연결 운영팀 세션도 자기 개인 공간에
// 그대로 닿는다. 둘째, 프롬프트에 실리는 일정은 이 계정의 브라우저가 보낸
// 스냅샷뿐이고 서버가 일정 테이블을 직접 읽지 않는다.
//
// owner-tool-api.mjs 를 import 하지 않고 필요한 로직을 다시 쓴 이유는 그 파일이
// 잠금 대상이고(protected-rank-features.lock.json), 페르소나 문장이 다르며,
// 지연 dispatch 로 부르는 이 경로에 600줄짜리 CSS·HTML 문자열까지 끌고 오기
// 때문이다.

import { createHash } from "node:crypto";
import { withSupabase } from "@supabase/server";
import { protectedJson } from "../security.mjs";
import { resolvePersonalAccess } from "./personal-identity.mjs";

export const PERSONAL_ASSISTANT_CHAT_PATH = "/api/my/assistant-chat";

const MAX_MESSAGE = 2000;
const MAX_HISTORY = 12;
const MAX_SCHEDULE = 60;

// 인메모리 폴백 버킷. 프로세스 수명과 같이 가므로 서버리스에서는 인스턴스별로
// 따로 센다 — 이 한계를 알고도 쓰는 이유는 아래 consumePersonalAssistantRate 의
// 주석에 적어 두었다.
const localRateBuckets = new Map();

function text(value, max) {
  const trimmed = String(value ?? "").trim();
  return max ? trimmed.slice(0, max) : trimmed;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

// 계정마다 다르고 계정을 되돌릴 수는 없는 짧은 태그. 브라우저가 localStorage
// 키를 계정별로 나누는 데만 쓴다(같은 기기에서 계정을 바꿔 로그인해도 이전
// 계정의 대기 상태·대화가 새 계정 화면에 남지 않아야 한다).
export function personalAssistantAccountTag(personalKey) {
  return sha256Hex(personalKey).slice(0, 16);
}

// 상·하한은 SQL RPC(consume_code_login_rate_limit)가 받아들이는 범위 안에
// 머물러야 한다. RPC 는 window 60..86400, limit 3..100 밖의 값을 raise 로
// 거부하므로, 여기서 미리 자르지 않으면 환경변수 오타 하나가 429 가 아니라
// 500 을 만든다.
export function personalAssistantRateConfiguration(env = process.env) {
  return {
    windowSeconds: boundedInteger(env.MI_PERSONAL_ASSISTANT_WINDOW_SECONDS, 3600, 60, 86400),
    attemptLimit: boundedInteger(env.MI_PERSONAL_ASSISTANT_CHAT_LIMIT, 20, 3, 100),
  };
}

export function resetPersonalAssistantRateBuckets() {
  localRateBuckets.clear();
}

function consumeLocalRateLimit(key, attemptLimit, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const existing = localRateBuckets.get(key);
  const bucket = !existing || now - existing.startedAt >= windowMs
    ? { startedAt: now, count: 0 }
    : existing;
  bucket.count += 1;
  localRateBuckets.set(key, bucket);
  if (bucket.count > attemptLimit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000)),
    };
  }
  return { allowed: true, retryAfter: 0 };
}

// 로그인 제한기와 달리 여기서는 unavailable 을 돌려주지 않는다. 로그인 제한은
// 인증 경계라 DB 가 죽으면 닫는 쪽이 안전하지만, 대화 한도는 비용 방어일 뿐이다.
// DB 장애가 곧 "실장이 아무에게도 대답하지 않음" 이 되어서는 안 되므로 RPC 가
// 실패하면 인메모리 버킷으로 내려가 계속 센다(fail open).
export async function consumePersonalAssistantRate(ctx, personalKey, env = process.env) {
  const { windowSeconds, attemptLimit } = personalAssistantRateConfiguration(env);
  // 접두사를 code-session-api 의 'ip ' · 'credential ' 과 다르게 둔 이유는
  // 두 제한기가 절대 같은 버킷을 나눠 쓰면 안 되기 때문이다. 대화 20회가
  // 로그인 시도 횟수를 깎아 먹으면 계정이 잠긴다.
  const keyHash = sha256Hex(`assistant-chat ${personalKey}`);
  try {
    const result = await ctx.supabaseAdmin.rpc("consume_code_login_rate_limit", {
      p_key_hash: keyHash,
      p_window_seconds: windowSeconds,
      p_attempt_limit: attemptLimit,
    });
    if (!result?.error) {
      const row = Array.isArray(result?.data) ? result.data[0] : result?.data;
      return {
        allowed: row?.allowed !== false,
        retryAfter: Number(row?.retry_after || 0),
        durable: true,
      };
    }
  } catch (error) {
    // RPC 자체가 던진 경우도 같은 폴백으로 처리한다.
  }
  const local = consumeLocalRateLimit(keyHash, attemptLimit, windowSeconds);
  return { ...local, durable: false };
}

async function defaultAssistantChatCreate(params) {
  // 무거운 ESM 을 모듈 최상단에서 import 하면 지연 dispatch 핸들러의 모듈 로드가
  // 통째로 깨진다(report-center 의 pptxgenjs 사례). 실제로 쓰는 지점에서만 부른다.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client.messages.create(params);
}

export async function runPersonalAssistantChat(body = {}, env = process.env, createMessage = defaultAssistantChatCreate) {
  if (!text(env.ANTHROPIC_API_KEY, 200)) {
    return {
      status: 503,
      result: {
        ok: false,
        code: "missing_api_key",
        message: "실장 대화 기능이 아직 연결되지 않았습니다. Vercel 환경변수 ANTHROPIC_API_KEY를 설정해주세요.",
      },
    };
  }
  const message = text(body.message, MAX_MESSAGE);
  if (!message) return { status: 400, result: { ok: false, message: "대화 내용을 입력해주세요." } };

  const rawHistory = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];
  const history = [];
  for (const entry of rawHistory) {
    const role = entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : "";
    const entryText = text(entry?.text, MAX_MESSAGE);
    if (!role || !entryText) return { status: 400, result: { ok: false, message: "대화 기록 형식을 확인해주세요." } };
    history.push({ role, content: entryText });
  }
  // 모델은 user 턴으로 시작하는 대화만 받는다. 앞머리가 assistant 로 남는 경우는
  // 브라우저가 잘라 보낸 기록의 경계에서 흔히 생긴다.
  while (history.length && history[0].role !== "user") history.shift();

  // 여기서 서버가 일정 테이블을 조회하는 일은 없다. 모델이 보는 일정은 오직
  // 이 계정 자신의 브라우저가 /api/my/work-items 로 받아 그대로 실어 보낸
  // 스냅샷뿐이고, 그 응답은 이미 계정 키로 걸러져 있다. 따라서 다른 계정의
  // 행이 프롬프트에 닿는 경로 자체가 존재하지 않는다.
  const scheduleRows = (Array.isArray(body.schedule) ? body.schedule : [])
    .slice(0, MAX_SCHEDULE)
    .map((item) => ({
      title: text(item?.title, 120) || "제목 없는 업무",
      startsAt: text(item?.startsAt, 40),
      status: text(item?.status, 20),
      isAllDay: Boolean(item?.isAllDay),
    }))
    .filter((item) => item.startsAt);

  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16);
  const scheduleText = scheduleRows.length
    ? scheduleRows.map((item) => `- ${item.startsAt}${item.isAllDay ? " 종일" : ""} [${item.status}] ${item.title}`).join("\n")
    : "(등록된 일정 없음)";

  // 프롬프트에는 계정 키·uuid·대행사 코드·운영팀 코드·계정 태그를 넣지 않는다.
  // 모델이 그 값을 알 이유가 없고(일정은 이미 이 계정 것만 실려 있다), 한 번
  // 프롬프트에 들어가면 답변으로 되읽혀 화면·음성으로 새어 나갈 수 있다.
  const system = [
    "당신은 마케팅 대행사 모먼트 인사이트 구성원의 개인 일정 비서 '실장'입니다.",
    "한국어로 두세 문장 이내로 간결하고 실무적으로 답합니다. 음성으로 읽히므로 목록 기호 없이 자연스러운 문장으로 말합니다.",
    `현재 한국 시간: ${nowKst}`,
    "아래는 이 계정의 개인 일정표 스냅샷입니다. 다른 계정의 일정은 볼 수 없습니다. 이 정보와 일반 운영 상식으로만 답하고, 모르는 것은 모른다고 말합니다.",
    scheduleText,
    // 개인 화면에는 일정 등록 초안 흐름이 없다. 없는 기능을 안내하면 사용자가
    // 말로 등록을 시도하다 실패한다.
    "당신은 일정을 직접 등록·완료할 수 없습니다. 요청받으면 방법을 안내합니다: 완료는 \"○○ 완료로 해줘\", 브리핑은 \"오늘 일정 알려줘\"라고 말하면 됩니다.",
  ].join("\n");

  try {
    const responseMessage = await createMessage({
      model: text(env.MI_ASSISTANT_CHAT_MODEL, 60) || "claude-haiku-4-5",
      max_tokens: 700,
      system,
      messages: [...history, { role: "user", content: message }],
    });
    const reply = (responseMessage?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!reply) return { status: 502, result: { ok: false, message: "실장 응답을 받지 못했습니다. 잠시 후 다시 시도해주세요." } };
    return {
      status: 200,
      result: {
        ok: true,
        reply: reply.slice(0, 4000),
        usage: {
          inputTokens: Number(responseMessage?.usage?.input_tokens || 0),
          outputTokens: Number(responseMessage?.usage?.output_tokens || 0),
        },
      },
    };
  } catch (error) {
    const status = Number(error?.status) || 502;
    const failureMessage = status === 401
      ? "실장 대화 API 키가 올바르지 않습니다."
      : status === 429
        ? "실장 대화 사용량 한도에 걸렸습니다. 잠시 후 다시 시도해주세요."
        : "실장 대화 처리에 실패했습니다. 잠시 후 다시 시도해주세요.";
    return { status: status >= 400 && status < 600 ? status : 502, result: { ok: false, message: failureMessage } };
  }
}

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-csrf",
  });
}

export async function handlePersonalAssistantRequest(request, ctx, options = {}) {
  if (new URL(request.url).pathname !== PERSONAL_ASSISTANT_CHAT_PATH) {
    return json(request, { ok: false, message: "Not found" }, 404);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const env = options.env || process.env;
  const createMessage = options.createMessage || defaultAssistantChatCreate;

  // 계정 판정은 이것 하나뿐이다. 운영 범위로 폴백하지 않으므로 개인 공간을
  // 만들지 못하면 그대로 거절한다.
  const access = await resolvePersonalAccess(request, ctx);
  if (!access.ok) return json(request, access, access.status);

  const { windowSeconds, attemptLimit } = personalAssistantRateConfiguration(env);

  if (request.method === "GET") {
    // 마운트 시 한 번 부르는 값싼 탐침. 대화를 한 번도 쓰지 않고도 브라우저가
    // 계정별 저장소 이름을 정하고 "아직 연결 안 됨" 을 표시할 수 있어야 한다.
    return json(request, {
      ok: true,
      accountTag: personalAssistantAccountTag(access.personalKey),
      ready: Boolean(text(env.ANTHROPIC_API_KEY, 200)),
      role: access.personalRole,
      limit: attemptLimit,
      windowSeconds,
    });
  }

  if (request.method === "POST") {
    const contentType = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return json(request, { ok: false, message: "JSON 요청만 허용됩니다." }, 415);
    }
    const body = await request.json().catch(() => null);
    // 한도 확인은 반드시 모델 호출보다 앞이다. 뒤에 두면 한도를 넘긴 요청도
    // 이미 토큰을 태운 뒤가 된다.
    const rate = await consumePersonalAssistantRate(ctx, access.personalKey, env);
    if (!rate.allowed) {
      return json(request, {
        ok: false,
        code: "rate_limited",
        retryAfter: rate.retryAfter,
        message: `실장 대화는 시간당 ${attemptLimit}회까지 이용할 수 있습니다. 잠시 후 다시 시도해주세요.`,
      }, 429);
    }
    const chat = await runPersonalAssistantChat(body || {}, env, createMessage);
    return json(request, chat.result, chat.status);
  }

  return json(request, { ok: false, message: "Method not allowed", allowed: ["GET", "POST"] }, 405);
}

export default {
  fetch: withSupabase({ auth: "none" }, handlePersonalAssistantRequest),
};
