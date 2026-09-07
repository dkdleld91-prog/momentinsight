import assert from "node:assert/strict";
import test from "node:test";
import {
  SITE_EVENTS,
  clientIp,
  handleSiteEventRequest,
  isBotUserAgent,
  kstDay,
  loginVisitor,
  normalizeSitePath,
  recordLoginEvent,
  recordSiteEvent,
  siteSummary,
  visitorHash,
} from "./site-events.mjs";

const ENV = { MI_SESSION_SECRET: "test-secret" };

// rpc·from 호출을 기록하고, 이름별 응답을 돌려주는 가짜 Supabase.
function fakeCtx(responses = {}) {
  const calls = [];
  const supabaseAdmin = {
    async rpc(name, args) {
      calls.push({ kind: "rpc", name, args });
      const reply = responses[name];
      if (typeof reply === "function") return reply(args);
      if (reply instanceof Error) return { data: null, error: { message: reply.message } };
      return { data: reply === undefined ? null : reply, error: null };
    },
    from(table) {
      const record = { kind: "from", table, ops: [] };
      calls.push(record);
      const query = {
        select(columns, options) { record.ops.push(["select", columns, options]); return query; },
        eq(column, value) { record.ops.push(["eq", column, value]); return query; },
        gte(column, value) { record.ops.push(["gte", column, value]); return query; },
        lt(column, value) { record.ops.push(["lt", column, value]); return query; },
        then(resolve, reject) {
          const reply = responses[`from:${table}`];
          return Promise.resolve(reply || { data: null, error: null, count: 0 }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { ctx: { supabaseAdmin }, calls };
}

function siteRequest(body, headers = {}) {
  return new Request("https://insight.momentlabs.co.kr/api/site-event", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Macintosh) Chrome/128", "x-forwarded-for": "203.0.113.9, 10.0.0.1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("KST 날짜·경로 정규화·로봇 판정", () => {
  assert.equal(kstDay(Date.parse("2026-09-07T16:30:00Z")), "2026-09-08", "UTC 16:30 은 한국 다음날 01:30");
  assert.equal(normalizeSitePath("/news?x=1#top"), "/news");
  assert.equal(normalizeSitePath("/"), "/");
  assert.equal(normalizeSitePath("https://evil.example/"), "");
  assert.equal(normalizeSitePath("/a b"), "");
  assert.equal(normalizeSitePath("/" + "x".repeat(200)), "");
  assert.equal(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)"), true);
  assert.equal(isBotUserAgent("UptimeRobot/2.0"), true);
  assert.equal(isBotUserAgent(""), true);
  assert.equal(isBotUserAgent("Mozilla/5.0 (iPhone) Safari/605"), false);
  assert.equal(clientIp(new Request("https://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })), "1.2.3.4");
});

test("visitor 해시는 비밀·날짜·IP·UA 에 묶이고 원문을 드러내지 않는다", () => {
  const a = visitorHash(["2026-09-07", "203.0.113.9", "ua"], ENV);
  const b = visitorHash(["2026-09-08", "203.0.113.9", "ua"], ENV);
  const c = visitorHash(["2026-09-07", "203.0.113.9", "ua"], { MI_SESSION_SECRET: "other" });
  assert.equal(a.length, 32);
  assert.notEqual(a, b, "날이 바뀌면 같은 사람도 다른 방문자");
  assert.notEqual(a, c);
  assert.ok(!a.includes("203.0.113.9"));
  assert.equal(loginVisitor("client", " OFYOU ", ENV), loginVisitor("client", "ofyou", ENV));
});

test("POST /api/site-event: 사람 방문은 mi_site_event_record 로 기록하고 204", async () => {
  const { ctx, calls } = fakeCtx();
  const response = await handleSiteEventRequest(siteRequest({ event: "view", path: "/news?utm=x" }), ctx, { nowMs: Date.parse("2026-09-07T03:00:00Z"), env: ENV });
  assert.equal(response.status, 204);
  const rpc = calls.find((call) => call.kind === "rpc");
  assert.equal(rpc.name, "mi_site_event_record");
  assert.equal(rpc.args.p_day, "2026-09-07");
  assert.equal(rpc.args.p_event, "view");
  assert.equal(rpc.args.p_path, "/news");
  assert.equal(rpc.args.p_visitor, visitorHash(["2026-09-07", "203.0.113.9", "Mozilla/5.0 (Macintosh) Chrome/128"], ENV));
});

test("POST /api/site-event: 로봇·모르는 이벤트·login·잘못된 경로·큰 본문은 기록 없이 204", async () => {
  const cases = [
    [siteRequest({ event: "view", path: "/" }, { "user-agent": "Googlebot/2.1" }), "robot"],
    [siteRequest({ event: "purchase", path: "/" }), "unknown event"],
    [siteRequest({ event: "login", path: "/client" }), "login 은 서버만 기록"],
    [siteRequest({ event: "view", path: "https://x/" }), "bad path"],
    [siteRequest("{" + '"event":"view","path":"/","pad":"' + "x".repeat(2100) + '"}'), "too large"],
    [siteRequest("not json"), "bad json"],
  ];
  for (const [request, label] of cases) {
    const { ctx, calls } = fakeCtx();
    const response = await handleSiteEventRequest(request, ctx, { env: ENV });
    assert.equal(response.status, 204, label);
    assert.equal(calls.length, 0, `${label}: 기록하지 않는다`);
  }
  const { ctx } = fakeCtx();
  assert.equal((await handleSiteEventRequest(new Request("https://x/api/site-event"), ctx)).status, 405);
  assert.equal((await handleSiteEventRequest(new Request("https://x/api/site-event", { method: "OPTIONS" }), ctx)).status, 204);
});

test("DB 오류가 나도 204 이고 recordSiteEvent 는 ok:false 를 돌려준다", async () => {
  const { ctx } = fakeCtx({ mi_site_event_record: new Error("relation missing") });
  const direct = await recordSiteEvent(ctx, { event: "view", path: "/", visitor: "v1" });
  assert.equal(direct.ok, false);
  assert.match(direct.error, /relation missing/);
  const response = await handleSiteEventRequest(siteRequest({ event: "signup_click", path: "/" }), ctx, { env: ENV });
  assert.equal(response.status, 204);
  assert.deepEqual(await recordSiteEvent(ctx, { event: "nope", path: "/", visitor: "v" }), { ok: false, skipped: "invalid" });
  assert.equal(SITE_EVENTS.has("login"), true);
});

test("recordLoginEvent: 역할·코드 해시로 login 을 남기고, 느리면 기다리지 않는다", async () => {
  const { ctx, calls } = fakeCtx();
  const result = await recordLoginEvent(ctx, { role: "client", code: "ofyou", env: ENV, nowMs: Date.parse("2026-09-07T03:00:00Z") });
  assert.equal(result.ok, true);
  assert.equal(calls[0].args.p_event, "login");
  assert.equal(calls[0].args.p_path, "/client");
  assert.equal(calls[0].args.p_visitor, loginVisitor("client", "ofyou", ENV));
  const slow = fakeCtx({ mi_site_event_record: () => new Promise(() => {}) });
  const timed = await recordLoginEvent(slow.ctx, { role: "team", code: "weleadergroup", env: ENV, waitMs: 20 });
  assert.deepEqual(timed, { ok: false, skipped: "timeout" });
  assert.deepEqual(await recordLoginEvent(ctx, { role: "client", code: "", env: ENV }), { ok: false, skipped: "no-code" });
});

test("siteSummary: 오늘·어제 요약 + 체험 가입 수, 정리 RPC 호출", async () => {
  const { ctx, calls } = fakeCtx({
    mi_site_event_summary: ({ p_day }) => ({ data: p_day === "2026-09-07" ? { visitors: 12, views: 30, signup_clicks: 3, inquiry_clicks: 2, logins: 5 } : { visitors: 9, views: 20, signup_clicks: 1, inquiry_clicks: 0, logins: 4 }, error: null }),
    mi_site_event_prune: 0,
    "from:login_identities": { data: null, error: null, count: 1 },
  });
  const summary = await siteSummary(ctx, { nowMs: Date.parse("2026-09-07T03:00:00Z") });
  assert.equal(summary.ok, true);
  assert.equal(summary.pending, false);
  assert.equal(summary.day, "2026-09-07");
  assert.deepEqual(summary.today, { visitors: 12, views: 30, signupClicks: 3, inquiryClicks: 2, logins: 5, trialSignups: 1 });
  assert.equal(summary.yesterday.day, "2026-09-06");
  assert.equal(summary.yesterday.visitors, 9);
  const trialQuery = calls.find((call) => call.kind === "from" && call.table === "login_identities");
  assert.ok(trialQuery.ops.some(([op, column, value]) => op === "eq" && column === "role" && value === "trial"));
  assert.ok(trialQuery.ops.some(([op, column, value]) => op === "gte" && column === "linked_at" && value === "2026-09-06T15:00:00.000Z"));
  assert.ok(calls.some((call) => call.kind === "rpc" && call.name === "mi_site_event_prune"));
});

test("siteSummary: 표가 아직 없으면 pending 으로 0 을 주고, 다른 오류는 ok:false", async () => {
  const missing = fakeCtx({ mi_site_event_summary: new Error('Could not find the function public.mi_site_event_summary in the schema cache') });
  const pending = await siteSummary(missing.ctx, { nowMs: Date.parse("2026-09-07T03:00:00Z") });
  assert.equal(pending.ok, true);
  assert.equal(pending.pending, true);
  assert.equal(pending.today.visitors, 0);
  assert.match(pending.message, /20260907213000_site_events\.sql/);
  const broken = fakeCtx({ mi_site_event_summary: new Error("connection reset") });
  const failed = await siteSummary(broken.ctx);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /connection reset/);
});
