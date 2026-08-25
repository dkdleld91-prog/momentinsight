import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import handler, {
  PERSONAL_ASSISTANT_CHAT_PATH,
  consumePersonalAssistantRate,
  handlePersonalAssistantRequest,
  personalAssistantAccountTag,
  personalAssistantRateConfiguration,
  resetPersonalAssistantRateBuckets,
  runPersonalAssistantChat,
} from "./personal-assistant-api.mjs";

// ─────────────────────────────────────────────────────────────
// 주변 환경 고정
//
// 이 파일은 네트워크를 부르지 않고 환경변수도 읽지 않는다. 모델 호출은 언제나
// 주입한 createMessage 로 가고, ANTHROPIC_API_KEY 는 테스트가 만든 env 객체
// 안에만 있다(실 배포 키가 깔린 머신에서도 결과가 같아야 한다).
// 계정 판정만은 resolvePersonalAccess 가 process.env 의 대행사 코드를 보므로
// 그 값 하나를 못 박았다가 되돌린다.
// ─────────────────────────────────────────────────────────────
const OWNER_CODE = "mml93-a01";
const AMBIENT_PRIMARY = process.env.MI_PRIMARY_AGENCY_CODE;
process.env.MI_PRIMARY_AGENCY_CODE = OWNER_CODE;
process.on("exit", () => {
  if (AMBIENT_PRIMARY === undefined) delete process.env.MI_PRIMARY_AGENCY_CODE;
  else process.env.MI_PRIMARY_AGENCY_CODE = AMBIENT_PRIMARY;
});

const TEAM_A = { id: "11111111-1111-4111-8111-111111111111", code: "team-a1" };
const TEAM_B = { id: "22222222-2222-4222-8222-222222222222", code: "team-b1" };
const CLIENT_A = { id: "33333333-3333-4333-8333-333333333333", agencyCode: "mml93-a02" };

const CHAT_ENV = { ANTHROPIC_API_KEY: "sk-test-key" };
const HEX_64 = /^[a-f0-9]{64}$/u;

const MODULE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "personal-assistant-api.mjs");
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, "utf8");

// ─────────────────────────────────────────────────────────────
// 하니스 — personal-calendar-isolation.test.mjs 의 tableCtx 에서 이 파일에
// 필요한 부분(계정 조회 두 테이블 + rpc 기록기)만 옮겨 왔다.
// ─────────────────────────────────────────────────────────────
function teamRow(team, overrides = {}) {
  return {
    id: team.id,
    team_name: `운영팀 ${team.code}`,
    team_code: team.code,
    status: "active",
    client_id: null,
    revoked_at: null,
    ...overrides,
  };
}

function clientRow(client, overrides = {}) {
  return {
    id: client.id,
    name: `광고주 ${client.agencyCode}`,
    business_name: `광고주 ${client.agencyCode}`,
    agency_code: client.agencyCode,
    status: "active",
    disconnected_at: null,
    ...overrides,
  };
}

function matchesFilters(row, filters) {
  return filters.every(([method, ...args]) => {
    if (method === "order" || method === "limit") return true;
    const [column, value] = args;
    if (method === "eq") return String(row[column] ?? "") === String(value);
    if (method === "ilike") return String(row[column] ?? "").toLowerCase() === String(value ?? "").toLowerCase();
    if (method === "is") {
      return value === null ? (row[column] === null || row[column] === undefined) : row[column] === value;
    }
    return assert.fail(`테스트 스텁이 지원하지 않는 필터입니다: ${method}`);
  });
}

function accountCtx({ teams = [], clients = [], rpc } = {}) {
  const ops = [];
  const rpcCalls = [];
  const rows = { operation_team_codes: teams, clients };
  const from = (table) => {
    const op = { table, kind: "select", filters: [] };
    const settle = (shape) => {
      ops.push(op);
      const matched = (rows[table] || []).filter((row) => matchesFilters(row, op.filters));
      return shape === "single"
        ? { data: matched[0] ?? null, error: null }
        : { data: matched, error: null };
    };
    const query = {
      select() { return query; },
      maybeSingle() { return Promise.resolve(settle("single")); },
      single() { return Promise.resolve(settle("single")); },
      then(onOk, onErr) { return Promise.resolve(settle("list")).then(onOk, onErr); },
    };
    for (const method of ["eq", "is", "in", "or", "gt", "gte", "lt", "lte", "not", "ilike", "order", "limit"]) {
      query[method] = (...args) => { op.filters.push([method, ...args]); return query; };
    }
    return query;
  };
  const rpcImpl = async (name, params) => {
    rpcCalls.push({ name, params });
    return rpc ? rpc(name, params) : { data: [{ allowed: true, retry_after: 0 }], error: null };
  };
  return { ctx: { supabaseAdmin: { from, rpc: rpcImpl } }, ops, rpcCalls };
}

const SESSION_HEADERS = {
  owner: { "x-mi-session-role": "owner", "x-mi-owner-agency-code": OWNER_CODE },
  teamA: { "x-mi-session-role": "team", "x-mi-team-code": TEAM_A.code },
  teamB: { "x-mi-session-role": "team", "x-mi-team-code": TEAM_B.code },
  clientA: { "x-mi-session-role": "client", "x-mi-agency-code": CLIENT_A.agencyCode },
  none: {},
};

function miRequest(path_, { method = "GET", session = "owner", headers = {}, body, rawBody } = {}) {
  const payload = rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body));
  return new Request(`https://insight.momentlabs.co.kr${path_}`, {
    method,
    headers: {
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...SESSION_HEADERS[session],
      ...headers,
    },
    body: payload,
  });
}

// 모델 호출 기록기. calls 가 비어 있다는 단언이 "토큰을 태우지 않았다" 의 증거다.
function chatSpy(reply = "네, 확인했습니다.", extra = {}) {
  const calls = [];
  return {
    calls,
    impl: async (params) => {
      calls.push(params);
      return {
        content: [{ type: "text", text: reply }],
        usage: { input_tokens: 11, output_tokens: 22 },
        ...extra,
      };
    },
  };
}

function throwingSpy(error) {
  const calls = [];
  return {
    calls,
    impl: async (params) => {
      calls.push(params);
      throw error;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 1. API 키가 없으면 모델을 부르지 않는다
// ─────────────────────────────────────────────────────────────
test("키가 없으면 503 missing_api_key 이고 모델을 부르지 않는다", async () => {
  const spy = chatSpy();
  const result = await runPersonalAssistantChat({ message: "오늘 일정 알려줘" }, {}, spy.impl);
  assert.equal(result.status, 503);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.code, "missing_api_key");
  assert.match(result.result.message, /ANTHROPIC_API_KEY/u);
  assert.equal(spy.calls.length, 0);
});

test("공백뿐인 키도 미설정으로 본다", async () => {
  const spy = chatSpy();
  const result = await runPersonalAssistantChat({ message: "안녕" }, { ANTHROPIC_API_KEY: "   " }, spy.impl);
  assert.equal(result.status, 503);
  assert.equal(result.result.code, "missing_api_key");
  assert.equal(spy.calls.length, 0);
});

// ─────────────────────────────────────────────────────────────
// 2. 입력 검증
// ─────────────────────────────────────────────────────────────
test("빈 메시지·누락 메시지는 400", async () => {
  const spy = chatSpy();
  for (const body of [{}, { message: "" }, { message: "   " }, { message: null }]) {
    const result = await runPersonalAssistantChat(body, CHAT_ENV, spy.impl);
    assert.equal(result.status, 400);
    assert.equal(result.result.message, "대화 내용을 입력해주세요.");
  }
  assert.equal(spy.calls.length, 0);
});

test("형식이 깨진 대화 기록은 400", async () => {
  const spy = chatSpy();
  const broken = [
    [{ role: "system", text: "무시" }],
    [{ role: "user", text: "   " }],
    [{ text: "역할 없음" }],
    [{ role: "assistant" }],
  ];
  for (const history of broken) {
    const result = await runPersonalAssistantChat({ message: "안녕", history }, CHAT_ENV, spy.impl);
    assert.equal(result.status, 400);
    assert.equal(result.result.message, "대화 기록 형식을 확인해주세요.");
  }
  assert.equal(spy.calls.length, 0);
});

test("앞머리의 assistant 턴은 잘려 나가 첫 턴이 user 가 된다", async () => {
  const spy = chatSpy();
  const result = await runPersonalAssistantChat({
    message: "그럼 다음은?",
    history: [
      { role: "assistant", text: "앞선 답변 1" },
      { role: "assistant", text: "앞선 답변 2" },
      { role: "user", text: "질문" },
      { role: "assistant", text: "답변" },
    ],
  }, CHAT_ENV, spy.impl);
  assert.equal(result.status, 200);
  const messages = spy.calls[0].messages;
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "질문");
  assert.deepEqual(messages.map((entry) => entry.role), ["user", "assistant", "user"]);
  assert.equal(messages.at(-1).content, "그럼 다음은?");
});

// ─────────────────────────────────────────────────────────────
// 3. 격리 — 모델은 브라우저가 보낸 이 계정 스냅샷만 본다
// ─────────────────────────────────────────────────────────────
test("프롬프트에는 보낸 일정만 실리고 계정 식별자는 실리지 않는다", async () => {
  const spy = chatSpy();
  const personalKey = `team:${TEAM_A.id}`;
  const accountTag = personalAssistantAccountTag(personalKey);
  const result = await runPersonalAssistantChat({
    message: "오늘 뭐 있어?",
    schedule: [
      { title: "네이버 랭킹 점검", startsAt: "2026-08-26 10:00", status: "planned", isAllDay: false },
      { title: "광고 소재 회의", startsAt: "2026-08-26 14:00", status: "done", isAllDay: true },
    ],
  }, CHAT_ENV, spy.impl);

  assert.equal(result.status, 200);
  const { system } = spy.calls[0];
  assert.ok(system.includes("네이버 랭킹 점검"));
  assert.ok(system.includes("광고 소재 회의"));
  assert.ok(system.includes("- 2026-08-26 14:00 종일 [done] 광고 소재 회의"));
  // 보낸 두 줄 말고 다른 일정 줄이 끼어들지 않았다.
  assert.equal(system.split("\n").filter((line) => line.startsWith("- ")).length, 2);
  assert.ok(system.includes("다른 계정의 일정은 볼 수 없습니다."));

  // 계정을 특정할 수 있는 값은 어느 것도 프롬프트에 없다.
  for (const secret of [personalKey, TEAM_A.id, TEAM_A.code, accountTag, OWNER_CODE, CLIENT_A.agencyCode]) {
    assert.ok(!system.includes(secret), `프롬프트에 ${secret} 가 들어갔습니다`);
  }
});

test("일정이 없으면 (등록된 일정 없음) 한 줄만 실린다", async () => {
  const spy = chatSpy();
  await runPersonalAssistantChat({ message: "일정?", schedule: [] }, CHAT_ENV, spy.impl);
  assert.ok(spy.calls[0].system.includes("(등록된 일정 없음)"));
  assert.equal(spy.calls[0].system.split("\n").filter((line) => line.startsWith("- ")).length, 0);
});

test("소스 자체가 일정 테이블을 읽지 않는다", () => {
  assert.ok(!MODULE_SOURCE.includes('.from("schedule_items")'));
  assert.ok(!MODULE_SOURCE.includes("schedule_items"));
  assert.ok(!MODULE_SOURCE.includes("supabaseAdmin.from("));
  // 계정 판정은 resolvePersonalAccess 하나뿐이다.
  assert.ok(MODULE_SOURCE.includes('import { resolvePersonalAccess } from "./personal-identity.mjs";'));
});

// ─────────────────────────────────────────────────────────────
// 4. 상한
// ─────────────────────────────────────────────────────────────
test("일정 스냅샷은 60건까지만 실린다", async () => {
  const spy = chatSpy();
  const schedule = Array.from({ length: 70 }, (_, index) => ({
    title: `업무-${String(index).padStart(3, "0")}`,
    startsAt: `2026-08-26 ${String(index % 24).padStart(2, "0")}:00`,
    status: "planned",
    isAllDay: false,
  }));
  await runPersonalAssistantChat({ message: "요약", schedule }, CHAT_ENV, spy.impl);
  const { system } = spy.calls[0];
  assert.equal(system.split("\n").filter((line) => line.startsWith("- ")).length, 60);
  assert.ok(system.includes("업무-059"));
  assert.ok(!system.includes("업무-060"));
  assert.ok(!system.includes("업무-069"));
});

test("일정 필드는 길이가 잘리고 startsAt 없는 행은 버려진다", async () => {
  const spy = chatSpy();
  await runPersonalAssistantChat({
    message: "요약",
    schedule: [
      { title: "가".repeat(200), startsAt: `${"9".repeat(60)}`, status: "s".repeat(40), isAllDay: "yes" },
      { title: "제목만 있음", startsAt: "   " },
      { title: "", startsAt: "2026-08-27 09:00", status: "planned" },
    ],
  }, CHAT_ENV, spy.impl);
  const lines = spy.calls[0].system.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("가".repeat(120)));
  assert.ok(!lines[0].includes("가".repeat(121)));
  assert.ok(lines[0].includes("9".repeat(40)));
  assert.ok(!lines[0].includes("9".repeat(41)));
  assert.ok(lines[0].includes(`[${"s".repeat(20)}]`));
  assert.ok(!lines[0].includes("s".repeat(21)));
  // isAllDay 는 Boolean 으로 강제된다.
  assert.ok(lines[0].includes(" 종일 "));
  assert.ok(lines[1].includes("제목 없는 업무"));
});

test("대화 기록은 마지막 12턴까지만 실린다", async () => {
  const spy = chatSpy();
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `턴-${String(index).padStart(2, "0")}`,
  }));
  await runPersonalAssistantChat({ message: "마지막", history }, CHAT_ENV, spy.impl);
  const { messages } = spy.calls[0];
  assert.equal(messages.length, 13);
  assert.equal(messages[0].content, "턴-08");
  assert.equal(messages.at(-1).content, "마지막");
});

test("메시지 본문도 2000자에서 잘린다", async () => {
  const spy = chatSpy();
  await runPersonalAssistantChat({ message: "다".repeat(2500) }, CHAT_ENV, spy.impl);
  assert.equal(spy.calls[0].messages.at(-1).content.length, 2000);
});

// ─────────────────────────────────────────────────────────────
// 5. 역할별 도달성 + 계정 태그
// ─────────────────────────────────────────────────────────────
test("owner·team·client 세션이 모두 대화에 닿고 계정 태그는 서로 다르다", async () => {
  const tags = [];
  const cases = [
    { session: "owner", role: "owner" },
    { session: "teamA", role: "team" },
    { session: "clientA", role: "client" },
  ];
  for (const { session, role } of cases) {
    const { ctx } = accountCtx({ teams: [teamRow(TEAM_A)], clients: [clientRow(CLIENT_A)] });
    const spy = chatSpy();
    const probe = await handlePersonalAssistantRequest(
      miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session }),
      ctx,
      { env: CHAT_ENV, createMessage: spy.impl },
    );
    assert.equal(probe.status, 200);
    const payload = await probe.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.role, role);
    assert.equal(payload.ready, true);
    assert.equal(payload.limit, 20);
    assert.equal(payload.windowSeconds, 3600);
    assert.match(payload.accountTag, /^[a-f0-9]{16}$/u);
    tags.push(payload.accountTag);

    const chat = await handlePersonalAssistantRequest(
      miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session, method: "POST", body: { message: "오늘 일정 알려줘" } }),
      ctx,
      { env: CHAT_ENV, createMessage: spy.impl },
    );
    assert.equal(chat.status, 200);
    const chatPayload = await chat.json();
    assert.equal(chatPayload.ok, true);
    assert.equal(chatPayload.reply, "네, 확인했습니다.");
    assert.deepEqual(chatPayload.usage, { inputTokens: 11, outputTokens: 22 });
    assert.equal(spy.calls.length, 1);
  }
  assert.equal(new Set(tags).size, 3);
});

test("ready 는 주입한 env 만 본다", async () => {
  const { ctx } = accountCtx();
  const response = await handlePersonalAssistantRequest(
    miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session: "owner" }),
    ctx,
    { env: {}, createMessage: chatSpy().impl },
  );
  assert.equal((await response.json()).ready, false);
});

test("세션 역할이 없으면 401", async () => {
  const { ctx } = accountCtx();
  const spy = chatSpy();
  const response = await handlePersonalAssistantRequest(
    miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session: "none", method: "POST", body: { message: "안녕" } }),
    ctx,
    { env: CHAT_ENV, createMessage: spy.impl },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).ok, false);
  assert.equal(spy.calls.length, 0);
});

test("해지된 운영팀 세션은 대화에 닿지 못한다", async () => {
  const { ctx } = accountCtx({ teams: [teamRow(TEAM_A)] });
  const spy = chatSpy();
  const response = await handlePersonalAssistantRequest(
    miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session: "teamB", method: "POST", body: { message: "안녕" } }),
    ctx,
    { env: CHAT_ENV, createMessage: spy.impl },
  );
  assert.ok(response.status === 404 || response.status === 403, `expected 404/403, got ${response.status}`);
  assert.equal((await response.json()).ok, false);
  assert.equal(spy.calls.length, 0);
});

// ─────────────────────────────────────────────────────────────
// 6. 사용량 한도
// ─────────────────────────────────────────────────────────────
test("한도를 넘기면 429 이고 모델을 부르지 않는다", async () => {
  resetPersonalAssistantRateBuckets();
  const { ctx, rpcCalls } = accountCtx({
    teams: [teamRow(TEAM_A)],
    rpc: () => ({ data: [{ allowed: false, retry_after: 42 }], error: null }),
  });
  const spy = chatSpy();
  const response = await handlePersonalAssistantRequest(
    miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session: "teamA", method: "POST", body: { message: "안녕" } }),
    ctx,
    { env: CHAT_ENV, createMessage: spy.impl },
  );
  assert.equal(response.status, 429);
  const payload = await response.json();
  assert.equal(payload.code, "rate_limited");
  assert.equal(payload.retryAfter, 42);
  assert.match(payload.message, /시간당 20회/u);
  assert.equal(spy.calls.length, 0);

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "consume_code_login_rate_limit");
  assert.equal(rpcCalls[0].params.p_window_seconds, 3600);
  assert.equal(rpcCalls[0].params.p_attempt_limit, 20);
  assert.match(rpcCalls[0].params.p_key_hash, HEX_64);
});

test("계정이 다르면 한도 버킷 키도 다르다", async () => {
  resetPersonalAssistantRateBuckets();
  const hashes = [];
  for (const session of ["owner", "teamA", "clientA"]) {
    const { ctx, rpcCalls } = accountCtx({
      teams: [teamRow(TEAM_A)],
      clients: [clientRow(CLIENT_A)],
      rpc: () => ({ data: [{ allowed: true, retry_after: 0 }], error: null }),
    });
    await handlePersonalAssistantRequest(
      miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session, method: "POST", body: { message: "안녕" } }),
      ctx,
      { env: CHAT_ENV, createMessage: chatSpy().impl },
    );
    hashes.push(rpcCalls[0].params.p_key_hash);
  }
  assert.equal(new Set(hashes).size, 3);
  for (const hash of hashes) assert.match(hash, HEX_64);
});

test("로그인 제한기와 접두사가 달라 같은 버킷을 쓰지 않는다", () => {
  assert.ok(MODULE_SOURCE.includes("assistant-chat "));
  assert.ok(!MODULE_SOURCE.includes("`credential"));
  assert.ok(!MODULE_SOURCE.includes("loginRateKeys"));
});

test("환경변수 한도는 RPC 가 받는 범위 밖이면 기본값으로 돌아간다", () => {
  assert.deepEqual(personalAssistantRateConfiguration({}), { windowSeconds: 3600, attemptLimit: 20 });
  assert.deepEqual(
    personalAssistantRateConfiguration({ MI_PERSONAL_ASSISTANT_WINDOW_SECONDS: "7200", MI_PERSONAL_ASSISTANT_CHAT_LIMIT: "50" }),
    { windowSeconds: 7200, attemptLimit: 50 },
  );
  assert.deepEqual(
    personalAssistantRateConfiguration({ MI_PERSONAL_ASSISTANT_WINDOW_SECONDS: "5", MI_PERSONAL_ASSISTANT_CHAT_LIMIT: "9999" }),
    { windowSeconds: 3600, attemptLimit: 20 },
  );
  assert.deepEqual(
    personalAssistantRateConfiguration({ MI_PERSONAL_ASSISTANT_WINDOW_SECONDS: "abc", MI_PERSONAL_ASSISTANT_CHAT_LIMIT: "" }),
    { windowSeconds: 3600, attemptLimit: 20 },
  );
});

// ─────────────────────────────────────────────────────────────
// 7. RPC 가 죽어도 열린 채로(fail open) 계속 센다
// ─────────────────────────────────────────────────────────────
test("RPC 오류 시 인메모리 버킷으로 내려가 20회까지 허용하고 21회째를 막는다", async () => {
  resetPersonalAssistantRateBuckets();
  const { ctx } = accountCtx({
    teams: [teamRow(TEAM_A)],
    rpc: () => ({ data: null, error: { message: "rate limit table missing" } }),
  });
  const spy = chatSpy();
  const request = () => handlePersonalAssistantRequest(
    miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session: "teamA", method: "POST", body: { message: "안녕" } }),
    ctx,
    { env: CHAT_ENV, createMessage: spy.impl },
  );
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await request();
    assert.equal(response.status, 200, `${attempt}회째가 막혔습니다`);
  }
  const blocked = await request();
  assert.equal(blocked.status, 429);
  const payload = await blocked.json();
  assert.equal(payload.code, "rate_limited");
  assert.ok(payload.retryAfter > 0);
  assert.equal(spy.calls.length, 20);
  resetPersonalAssistantRateBuckets();
});

test("consumePersonalAssistantRate 는 RPC 성공 시 durable, 실패 시 fail open 을 보고한다", async () => {
  resetPersonalAssistantRateBuckets();
  const ok = await consumePersonalAssistantRate(
    accountCtx({ rpc: () => ({ data: [{ allowed: true, retry_after: 0 }], error: null }) }).ctx,
    "team:key-1",
    {},
  );
  assert.deepEqual(ok, { allowed: true, retryAfter: 0, durable: true });

  const thrown = await consumePersonalAssistantRate(
    { supabaseAdmin: { rpc: async () => { throw new Error("연결 실패"); } } },
    "team:key-2",
    {},
  );
  assert.equal(thrown.allowed, true);
  assert.equal(thrown.durable, false);
  resetPersonalAssistantRateBuckets();
});

// ─────────────────────────────────────────────────────────────
// 8. 메서드·경로 계약
// ─────────────────────────────────────────────────────────────
test("JSON 이 아닌 POST 는 415", async () => {
  const { ctx } = accountCtx();
  const spy = chatSpy();
  const response = await handlePersonalAssistantRequest(
    miRequest(PERSONAL_ASSISTANT_CHAT_PATH, {
      session: "owner",
      method: "POST",
      rawBody: "message=안녕",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    ctx,
    { env: CHAT_ENV, createMessage: spy.impl },
  );
  assert.equal(response.status, 415);
  assert.equal((await response.json()).message, "JSON 요청만 허용됩니다.");
  assert.equal(spy.calls.length, 0);
});

test("PUT·DELETE 는 405", async () => {
  for (const method of ["PUT", "DELETE"]) {
    const { ctx } = accountCtx();
    const response = await handlePersonalAssistantRequest(
      miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session: "owner", method }),
      ctx,
      { env: CHAT_ENV, createMessage: chatSpy().impl },
    );
    assert.equal(response.status, 405);
    const payload = await response.json();
    assert.deepEqual(payload.allowed, ["GET", "POST"]);
  }
});

test("OPTIONS 는 204, 다른 경로는 404", async () => {
  const { ctx } = accountCtx();
  const preflight = await handlePersonalAssistantRequest(
    miRequest(PERSONAL_ASSISTANT_CHAT_PATH, { session: "owner", method: "OPTIONS" }),
    ctx,
    { env: CHAT_ENV },
  );
  assert.equal(preflight.status, 204);

  const wrongPath = await handlePersonalAssistantRequest(
    miRequest("/api/my/work-items", { session: "owner" }),
    ctx,
    { env: CHAT_ENV },
  );
  assert.equal(wrongPath.status, 404);
  assert.equal((await wrongPath.json()).message, "Not found");
});

test("기본 export 는 withSupabase 로 감싼 fetch 하나다", () => {
  assert.equal(typeof handler.fetch, "function");
  assert.equal(PERSONAL_ASSISTANT_CHAT_PATH, "/api/my/assistant-chat");
});

// ─────────────────────────────────────────────────────────────
// 9. 상위 API 오류 매핑
// ─────────────────────────────────────────────────────────────
test("401·429·기타 오류가 정해진 문구로 매핑된다", async () => {
  const cases = [
    { error: Object.assign(new Error("unauthorized"), { status: 401 }), status: 401, message: "실장 대화 API 키가 올바르지 않습니다." },
    { error: Object.assign(new Error("too many"), { status: 429 }), status: 429, message: "실장 대화 사용량 한도에 걸렸습니다. 잠시 후 다시 시도해주세요." },
    { error: new Error("boom"), status: 502, message: "실장 대화 처리에 실패했습니다. 잠시 후 다시 시도해주세요." },
    { error: Object.assign(new Error("teapot"), { status: 999 }), status: 502, message: "실장 대화 처리에 실패했습니다. 잠시 후 다시 시도해주세요." },
  ];
  for (const item of cases) {
    const spy = throwingSpy(item.error);
    const result = await runPersonalAssistantChat({ message: "안녕" }, CHAT_ENV, spy.impl);
    assert.equal(result.status, item.status);
    assert.equal(result.result.ok, false);
    assert.equal(result.result.message, item.message);
    assert.equal(spy.calls.length, 1);
  }
});

test("빈 응답은 502", async () => {
  const empty = async () => ({ content: [], usage: {} });
  const result = await runPersonalAssistantChat({ message: "안녕" }, CHAT_ENV, empty);
  assert.equal(result.status, 502);
  assert.equal(result.result.message, "실장 응답을 받지 못했습니다. 잠시 후 다시 시도해주세요.");

  const nonText = async () => ({ content: [{ type: "tool_use", id: "t1" }] });
  const second = await runPersonalAssistantChat({ message: "안녕" }, CHAT_ENV, nonText);
  assert.equal(second.status, 502);
});

test("모델 이름은 env 로 바꿀 수 있고 기본값은 haiku 다", async () => {
  const spy = chatSpy();
  await runPersonalAssistantChat({ message: "안녕" }, CHAT_ENV, spy.impl);
  assert.equal(spy.calls[0].model, "claude-haiku-4-5");
  assert.equal(spy.calls[0].max_tokens, 700);

  const custom = chatSpy();
  await runPersonalAssistantChat({ message: "안녕" }, { ...CHAT_ENV, MI_ASSISTANT_CHAT_MODEL: "claude-sonnet-4-5" }, custom.impl);
  assert.equal(custom.calls[0].model, "claude-sonnet-4-5");
});

test("계정 태그는 같은 키에 안정적이고 키가 다르면 달라진다", () => {
  const key = `client:${CLIENT_A.id}`;
  assert.equal(personalAssistantAccountTag(key), personalAssistantAccountTag(key));
  assert.notEqual(personalAssistantAccountTag(key), personalAssistantAccountTag(OWNER_CODE));
  assert.match(personalAssistantAccountTag(key), /^[a-f0-9]{16}$/u);
});
