import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import app, { calculateOwnerTax, parseAssistantCompletion, parseOwnerAssistantDrafts } from "./owner-tool-api.mjs";

function request(method = "GET", options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.owner !== false) {
    headers.set("x-mi-session-role", options.role || "owner");
    headers.set("x-mi-owner-agency-code", options.ownerCode || "mml93-a01");
  }
  return new Request("https://insight.momentlabs.co.kr/api/owner/tool", {
    method,
    headers,
    body: options.body,
  });
}

test("calculation reverses a VAT-inclusive total with integer half-up rounding", () => {
  assert.deepEqual(calculateOwnerTax("1100000"), { supply: 1_000_000, tax: 100_000, total: 1_100_000 });
  assert.deepEqual(calculateOwnerTax("776602"), { supply: 706_002, tax: 70_600, total: 776_602 });
  assert.deepEqual(calculateOwnerTax("17"), { supply: 15, tax: 2, total: 17 });
  assert.deepEqual(calculateOwnerTax("10"), { supply: 9, tax: 1, total: 10 });
  assert.deepEqual(calculateOwnerTax("0"), { supply: 0, tax: 0, total: 0 });
  assert.equal(calculateOwnerTax("1,000"), null);
  assert.equal(calculateOwnerTax("1000000000000000"), null);
  assert.equal(calculateOwnerTax(-1), null);
});

test("owner assistant creates only dated internal schedule drafts without external AI", () => {
  const now = new Date("2026-08-18T03:00:00.000Z");
  const result = parseOwnerAssistantDrafts([
    "내일 오후 2시 광고주 미팅 1시간 등록해줘",
    "다음 주 월요일 오전 10시 월간 보고서 최종 검수",
    "성과 자료도 정리하기",
  ].join("\n"), { now });
  assert.equal(result.ok, true);
  assert.equal(result.source, "deterministic-private-v1");
  assert.equal(result.drafts.length, 2);
  assert.equal(result.unresolved.length, 1);
  assert.deepEqual(result.drafts[0], {
    title: "광고주 미팅",
    scheduleType: "meeting",
    status: "planned",
    priority: "medium",
    startsAt: "2026-08-19T05:00:00.000Z",
    endsAt: "2026-08-19T06:00:00.000Z",
    assigneeName: "",
    internalNote: "실장 초안 원문: 내일 오후 2시 광고주 미팅 1시간 등록해줘",
    isAllDay: false,
    visibility: "internal",
    publicTitle: "",
    publicComment: "",
  });
  assert.equal(result.drafts[1].scheduleType, "report_due");
  assert.equal(result.drafts[1].startsAt, "2026-08-24T01:00:00.000Z");
  assert.equal(result.drafts.every((draft) => draft.visibility === "internal"), true);
  const halfPast = parseOwnerAssistantDrafts("내일 오후 2시 30분 미팅", { now }).drafts[0];
  assert.equal(halfPast.startsAt, "2026-08-19T05:30:00.000Z");
  assert.equal(halfPast.endsAt, "2026-08-19T06:30:00.000Z");
  assert.equal(parseOwnerAssistantDrafts("날짜 없는 업무", { now }).drafts.length, 0);
  assert.equal(parseOwnerAssistantDrafts("", { now }).ok, false);
  const source = fs.readFileSync(new URL("./owner-tool-api.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /api\.openai\.com|anthropic|claude|OPENAI_API_KEY/i);
});

test("assistant completion parser extracts targets from undated completion requests", () => {
  assert.equal(parseAssistantCompletion("광고주 미팅 완료로 해줘"), "광고주 미팅");
  assert.equal(parseAssistantCompletion("주간 보고서 업무 완료 처리 해주세요"), "주간 보고서");
  assert.equal(parseAssistantCompletion("광고 세팅 완료"), "광고 세팅");
  assert.equal(parseAssistantCompletion("내일 회의 준비"), "");
  assert.equal(parseAssistantCompletion("완료해줘"), "");
});

test("owner assistant splits mixed input into dated drafts and completion requests", () => {
  const now = new Date("2026-08-18T03:00:00.000Z");
  const result = parseOwnerAssistantDrafts([
    "내일 오후 2시 광고주 미팅 1시간 등록해줘",
    "주간 보고서 완료 처리해줘",
  ].join("\n"), { now });
  assert.equal(result.ok, true);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.completions.length, 1);
  assert.equal(result.completions[0].query, "주간 보고서");
  assert.equal(result.completions[0].source, "주간 보고서 완료 처리해줘");
  assert.equal(result.unresolved.length, 0);
});

test("tool content is disclosed only to the exact primary owner identity", async () => {
  const anonymous = await app.fetch(request("GET", { owner: false }));
  const team = await app.fetch(request("GET", { role: "team" }));
  const wrongOwner = await app.fetch(request("GET", { ownerCode: "mml93-a02" }));
  assert.equal(anonymous.status, 403);
  assert.equal(team.status, 403);
  assert.equal(wrongOwner.status, 403);

  const owner = await app.fetch(request());
  const payload = await owner.json();
  assert.equal(owner.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.tool.screen, "owner-development");
  assert.match(payload.tool.menuHtml, /^<div class="mi-nav-group/);
  assert.match(payload.tool.menuHtml, /개발 &lt;\/&gt;/);
  assert.match(payload.tool.menuHtml, /data-mi-admin-screen="owner-development"/);
  assert.match(payload.tool.menuHtml, /data-mi-admin-screen="owner-assistant"/);
  assert.match(payload.tool.menuHtml, /실장 운영 비서/);
  assert.match(payload.tool.menuHtml, /CANARY/);
  assert.match(payload.tool.menuHtml, /data-mi-admin-screen="owner-utility"/);
  assert.match(payload.tool.menuHtml, /부가세 계산기/);
  assert.match(payload.tool.viewHtml, /^<div class="mi-owner-tool-views"/);
  assert.ok(payload.tool.viewHtml.indexOf('data-mi-admin-view="owner-development"') < payload.tool.viewHtml.indexOf('data-mi-admin-view="owner-assistant"'));
  assert.ok(payload.tool.viewHtml.indexOf('data-mi-admin-view="owner-assistant"') < payload.tool.viewHtml.indexOf('data-mi-admin-view="owner-utility"'));
  assert.match(payload.tool.viewHtml, /data-rank-worker-operations/);
  assert.equal((payload.tool.viewHtml.match(/data-rank-worker-operations(?:\s|=)/g) || []).length, 1);
  assert.match(payload.tool.viewHtml, /N 쇼핑 수집 운영/);
  assert.match(payload.tool.viewHtml, /mml93-a01 전용/);
  assert.match(payload.tool.viewHtml, /한 번에 한 키워드/);
  assert.match(payload.tool.viewHtml, /오가닉 300개 검증/);
  assert.match(payload.tool.viewHtml, /마지막 정상 기록 보존/);
  assert.match(payload.tool.viewHtml, /data-owner-tool-input/);
  assert.match(payload.tool.viewHtml, /data-owner-assistant-input/);
  assert.match(payload.tool.viewHtml, /모먼트랩스 비서실 운영실/);
  assert.match(payload.tool.viewHtml, /data-owner-assistant-office/);
  assert.equal((payload.tool.viewHtml.match(/data-owner-assistant-agent(?:\s|>)/g) || []).length, 6);
  assert.equal((payload.tool.viewHtml.match(/data-owner-assistant-role=/g) || []).length, 6);
  assert.match(payload.tool.viewHtml, /비서실장/);
  assert.match(payload.tool.viewHtml, /일정 운영 담당/);
  assert.match(payload.tool.viewHtml, /보고서 담당/);
  assert.match(payload.tool.viewHtml, /광고 운영 담당/);
  assert.match(payload.tool.viewHtml, /콘텐츠 담당/);
  assert.match(payload.tool.viewHtml, /키워드 담당/);
  assert.match(payload.tool.viewHtml, /자리 대기, 담당 회의, 비서실장 방문/);
  assert.match(payload.tool.viewHtml, /독립 AI 직원의 자동 실행 상태는 아닙니다/);
  assert.match(payload.tool.viewHtml, /data-owner-assistant-mic/);
  assert.match(payload.tool.viewHtml, /data-owner-assistant-wake/);
  assert.match(payload.tool.viewHtml, /data-owner-assistant-read/);
  assert.match(payload.tool.viewHtml, /확인하기 전에는 저장하거나 공개하지 않습니다/);
  assert.match(payload.tool.viewHtml, /외부 전송 없음/);
  assert.match(payload.tool.viewHtml, /부가세 포함 금액/);
  assert.match(payload.tool.viewHtml, /최종 합계금액을 입력/);
  assert.doesNotMatch(payload.tool.viewHtml, /미포함 금액을 입력/);
  assert.match(payload.tool.styleText, /mi-vat-layout/);
  assert.match(payload.tool.styleText, /mi-owner-development-hero/);
  assert.match(payload.tool.styleText, /mi-owner-development-principles/);
  assert.match(payload.tool.styleText, /mi-owner-assistant/);
  assert.match(payload.tool.styleText, /mi-assistant-office/);
  assert.match(payload.tool.styleText, /@keyframes mi-assistant-walk/);
  assert.match(payload.tool.styleText, /@keyframes mi-assistant-talk/);
  assert.match(payload.tool.styleText, /prefers-reduced-motion:reduce/);
  assert.match(payload.tool.styleText, /mi-assistant-voice/);
  assert.match(payload.tool.styleText, /@media\(max-width:900px\).*mi-owner-development-nav.*mi-nav-title\{display:none\}/s);
  for (const html of [payload.tool.menuHtml, payload.tool.viewHtml]) {
    assert.doesNotMatch(html, /<script|<iframe|<object|\son[a-z]+\s*=/i);
  }
});

test("assistant endpoint is exact-owner-only and returns drafts without writing schedules", async () => {
  const body = JSON.stringify({ action: "assistant-draft", prompt: "내일 오후 2시 광고주 미팅" });
  const blocked = await app.fetch(request("POST", {
    ownerCode: "mml93-a02",
    headers: { "content-type": "application/json" },
    body,
  }));
  assert.equal(blocked.status, 403);
  const response = await app.fetch(request("POST", {
    headers: { "content-type": "application/json" },
    body,
  }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.drafts.length, 1);
  assert.equal(payload.drafts[0].visibility, "internal");
  assert.equal(Array.isArray(payload.completions), true);
  assert.equal(payload.completions.length, 0);
  assert.equal(payload.source, "deterministic-private-v1");
  assert.equal("saved" in payload, false);
});

test("calculation endpoint rejects non-owner, wrong media and invalid amounts", async () => {
  const body = JSON.stringify({ action: "calculate", total: "1100000" });
  const blocked = await app.fetch(request("POST", {
    role: "client",
    headers: { "content-type": "application/json" },
    body,
  }));
  assert.equal(blocked.status, 403);

  const wrongMedia = await app.fetch(request("POST", { body }));
  assert.equal(wrongMedia.status, 415);

  const invalid = await app.fetch(request("POST", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "calculate", total: "1e6" }),
  }));
  assert.equal(invalid.status, 400);

  const valid = await app.fetch(request("POST", {
    headers: { "content-type": "application/json" },
    body,
  }));
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).amounts, { supply: 1_000_000, tax: 100_000, total: 1_100_000 });
});

test("public page sources contain no owner-only tax markup, styles or calculation formula", () => {
  const sources = ["src/pages/admin.html", "src/pages/client.html"].map((file) => fs.readFileSync(file, "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /부가세|mi-vat|data-admin-vat|vat-calculator/i);
    assert.doesNotMatch(source, /Math\.round\([^\n]*\*\s*0\.1\)/);
  }
  assert.match(sources[0], /\/api\/owner\/tool/);
  assert.match(sources[0], /loadOwnerTool/);
  assert.match(sources[0], /JSON\.stringify\(\{ action: "calculate", total:/);
  assert.doesNotMatch(sources[0], /JSON\.stringify\(\{ action: "calculate", supply:/);
});

test("owner development navigation and view are not present in public static markup", () => {
  const sources = ["src/pages/admin.html", "src/pages/client.html"].map((file) => fs.readFileSync(file, "utf8"));
  for (const source of sources) {
    const staticMarkup = source.slice(0, source.indexOf("<script src=\"/seo-evaluation.js"));
    assert.doesNotMatch(staticMarkup, /mi-admin-owner-development/);
    assert.doesNotMatch(staticMarkup, /data-owner-development-nav/);
    assert.doesNotMatch(staticMarkup, /data-mi-admin-screen="owner-development"/);
    assert.doesNotMatch(staticMarkup, /data-mi-admin-view="owner-development"/);
    assert.doesNotMatch(staticMarkup, /mi-admin-owner-assistant/);
    assert.doesNotMatch(staticMarkup, /data-mi-admin-screen="owner-assistant"/);
    assert.doesNotMatch(staticMarkup, /data-mi-admin-view="owner-assistant"/);
  }
});

test("owner assistant standby voice is explicit, visibility-gated and torn down with the owner view", () => {
  const admin = fs.readFileSync("src/pages/admin.html", "utf8");
  const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  const permissions = vercel.headers
    .flatMap((entry) => entry.headers || [])
    .find((header) => String(header.key).toLowerCase() === "permissions-policy")?.value || "";
  assert.match(admin, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.match(admin, /micButton\.addEventListener\("click"/);
  assert.match(admin, /wakeButton\.addEventListener\("click"/);
  assert.match(admin, /mi-owner-assistant-standby/);
  assert.match(admin, /writeStandbyPreference\(true\)/);
  assert.match(admin, /writeStandbyPreference\(false\)/);
  assert.match(admin, /if \(document\.hidden\)/);
  assert.match(admin, /function standbyLoop\(\)/);
  assert.match(admin, /not-allowed/);
  assert.doesNotMatch(admin, /}, 30000\);/);
  assert.match(admin, /ownerAssistantVoiceController\.stop\(\)/);
  assert.match(admin, /window\.speechSynthesis\.cancel\(\)/);
  assert.match(permissions, /microphone=\(self\)/);
  assert.match(permissions, /camera=\(\)/);
});

test("owner assistant office animates only on the owner screen and stops when removed", () => {
  const admin = fs.readFileSync("src/pages/admin.html", "utf8");
  assert.match(admin, /var ownerAssistantOfficeController = null/);
  assert.match(admin, /function runOfficeScene\(\)/);
  assert.match(admin, /비서실장이 .*에게 이동합니다/);
  assert.match(admin, /두 담당 조직이 공용 협의 공간으로 이동합니다/);
  assert.match(admin, /officeReturn\(\[chief, specialist\]\)/);
  assert.match(admin, /ownerAssistantOfficeController\.setActive\(target === "owner-assistant" && secureSession\.role === "owner"\)/);
  assert.match(admin, /ownerAssistantOfficeController\.destroy\(\)/);
  assert.match(admin, /window\.removeEventListener\("resize", handleOfficeResize\)/);
  assert.match(admin, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(admin, /setInterval\(runOfficeScene/);
});
