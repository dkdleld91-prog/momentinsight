import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  SITE_NOTICE_BODY_MAX,
  SITE_NOTICE_TITLE_MAX,
  editableNotice,
  handleSiteNoticeRequest,
  kstDateToUtcIso,
  noticeIsActive,
  publicNotice,
  utcIsoToKstDate,
  validateSiteNoticeInput,
} from "./site-notice.mjs";

// 운영 공지 팝업(대표 결정 2026-09-18): 단일 공지를 모든 세션이 읽고 총관리자만 저장한다.
const NOW = Date.parse("2026-09-18T03:30:00.000Z"); // 2026-09-18 12:30 KST
const ROW = Object.freeze({
  id: 1,
  title: "N 30일 추적 서버 점검 안내",
  body: "프로그램 개발로 인한 N 30일 추적 서버 점검이 진행 중입니다.\n9월 20일 완료 예정입니다.",
  starts_at: "2026-09-17T15:00:00+00:00",
  ends_at: "2026-09-20T14:59:59.999+00:00",
  enabled: true,
  updated_at: "2026-09-18T02:00:00+00:00",
});

function request(method, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.role) headers.set("x-mi-session-role", options.role);
  if (options.ownerCode) headers.set("x-mi-owner-agency-code", options.ownerCode);
  return new Request(`https://insight.momentlabs.co.kr${options.path || "/api/site-notice"}`, {
    method,
    headers,
    body: options.body,
  });
}

function ctxWith(row, { selectError = null, upsertError = null, updateError = null } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      supabaseAdmin: {
        from(table) {
          calls.push(["from", table]);
          return {
            select(columns) {
              calls.push(["select", columns]);
              return {
                eq(column, value) {
                  calls.push(["eq", column, value]);
                  return { async maybeSingle() { return selectError ? { data: null, error: selectError } : { data: row, error: null }; } };
                },
              };
            },
            update(value) {
              calls.push(["update", value]);
              return {
                eq(column, id) {
                  calls.push(["eq", column, id]);
                  return {
                    select(columns) {
                      calls.push(["select", columns]);
                      return { async maybeSingle() { return updateError ? { data: null, error: updateError } : { data: row ? { ...row, ...value } : null, error: null }; } };
                    },
                  };
                },
              };
            },
            upsert(value, options) {
              calls.push(["upsert", value, options]);
              return {
                select(columns) {
                  calls.push(["select", columns]);
                  return { async single() { return upsertError ? { data: null, error: upsertError } : { data: { ...value }, error: null }; } };
                },
              };
            },
          };
        },
      },
    },
  };
}

test("KST calendar dates map to UTC instants and reject impossible dates", () => {
  assert.equal(kstDateToUtcIso("2026-09-18"), "2026-09-17T15:00:00.000Z");
  assert.equal(kstDateToUtcIso("2026-09-20", true), "2026-09-20T14:59:59.999Z");
  assert.equal(kstDateToUtcIso("2026-02-30"), null);
  assert.equal(kstDateToUtcIso("2026-9-1"), null);
  assert.equal(kstDateToUtcIso(""), null);
  assert.equal(utcIsoToKstDate("2026-09-20T14:59:59.999Z"), "2026-09-20");
  assert.equal(utcIsoToKstDate("2026-09-20T15:00:00.000Z"), "2026-09-21");
  assert.equal(utcIsoToKstDate("not-a-date"), "");
});

test("notice input is normalised and bounded", () => {
  const valid = validateSiteNoticeInput({ title: "  점검  안내 ", body: "첫 줄\r\n\r\n\r\n둘째 줄  ", startDate: "2026-09-18", endDate: "2026-09-20", enabled: "true" });
  assert.deepEqual(valid, { ok: true, value: { title: "점검 안내", body: "첫 줄\n\n둘째 줄", starts_at: "2026-09-17T15:00:00.000Z", ends_at: "2026-09-20T14:59:59.999Z", enabled: true } });
  assert.equal(validateSiteNoticeInput({ title: "x".repeat(SITE_NOTICE_TITLE_MAX + 1), body: "b", startDate: "2026-09-18", endDate: "2026-09-20" }).ok, false);
  assert.equal(validateSiteNoticeInput({ title: "t", body: "x".repeat(SITE_NOTICE_BODY_MAX + 1), startDate: "2026-09-18", endDate: "2026-09-20" }).ok, false);
  assert.equal(validateSiteNoticeInput({ title: "t", body: "b", startDate: "2026-09-21", endDate: "2026-09-20" }).ok, false);
  assert.equal(validateSiteNoticeInput({ title: "t", body: "b", startDate: "2026/09/18", endDate: "2026-09-20" }).ok, false);
  assert.equal(validateSiteNoticeInput({ title: "", body: "b", startDate: "2026-09-18", endDate: "2026-09-20" }).ok, false);
  assert.equal(validateSiteNoticeInput({ title: "t", body: "b", startDate: "2026-09-18", endDate: "2026-09-18", enabled: "no" }).value.enabled, false);
});

test("a notice is active only while enabled and inside its KST window", () => {
  assert.equal(noticeIsActive(ROW, NOW), true);
  assert.equal(noticeIsActive({ ...ROW, enabled: false }, NOW), false);
  assert.equal(noticeIsActive(ROW, Date.parse("2026-09-17T14:59:59.000Z")), false);
  assert.equal(noticeIsActive(ROW, Date.parse("2026-09-20T14:59:59.999Z")), true);
  assert.equal(noticeIsActive(ROW, Date.parse("2026-09-20T15:00:00.000Z")), false);
  assert.equal(noticeIsActive(null, NOW), false);
  assert.deepEqual(Object.keys(publicNotice(ROW)), ["id", "title", "body", "startsAt", "endsAt", "updatedAt"]);
  assert.deepEqual(editableNotice(ROW).startDate, "2026-09-18");
  assert.deepEqual(editableNotice(ROW).endDate, "2026-09-20");
});

test("every signed-in role reads the active notice and only the owner sees the editable copy", async () => {
  for (const role of ["client", "team"]) {
    const harness = ctxWith(ROW);
    const response = await handleSiteNoticeRequest(request("GET", { role }), harness.ctx, { nowMs: NOW });
    const body = await response.json();
    assert.equal(response.status, 200, role);
    assert.deepEqual(body, { ok: true, notice: publicNotice(ROW) }, role);
    assert.deepEqual(harness.calls, [["from", "site_notices"], ["select", "id, title, body, starts_at, ends_at, enabled, updated_at"], ["eq", "id", 1]], role);
  }
  const owner = ctxWith(ROW);
  const ownerBody = await (await handleSiteNoticeRequest(request("GET", { role: "owner", ownerCode: "mml93-a01" }), owner.ctx, { nowMs: NOW })).json();
  assert.deepEqual(ownerBody, { ok: true, notice: publicNotice(ROW), editable: editableNotice(ROW), active: true });
  const inactive = ctxWith({ ...ROW, enabled: false });
  const inactiveBody = await (await handleSiteNoticeRequest(request("GET", { role: "owner", ownerCode: "mml93-a01" }), inactive.ctx, { nowMs: NOW })).json();
  assert.equal(inactiveBody.notice, null);
  assert.equal(inactiveBody.active, false);
  assert.equal(inactiveBody.editable.enabled, false);
  const empty = ctxWith(null);
  assert.deepEqual(await (await handleSiteNoticeRequest(request("GET", { role: "client" }), empty.ctx, { nowMs: NOW })).json(), { ok: true, notice: null });
});

test("GET fails closed without a session role and hides database errors", async () => {
  const anonymous = await handleSiteNoticeRequest(request("GET"), ctxWith(ROW).ctx, { nowMs: NOW });
  assert.equal(anonymous.status, 401);
  const failing = await handleSiteNoticeRequest(request("GET", { role: "client" }), ctxWith(ROW, { selectError: new Error("relation \"site_notices\" does not exist") }).ctx, { nowMs: NOW });
  assert.equal(failing.status, 500);
  assert.deepEqual(await failing.json(), { ok: false, message: "공지를 불러오지 못했습니다." });
  const unknownPath = await handleSiteNoticeRequest(request("GET", { role: "client", path: "/api/site-notice/x" }), ctxWith(ROW).ctx, { nowMs: NOW });
  assert.equal(unknownPath.status, 404);
  assert.equal((await handleSiteNoticeRequest(request("OPTIONS"), ctxWith(ROW).ctx, { nowMs: NOW })).status, 204);
  assert.equal((await handleSiteNoticeRequest(request("DELETE", { role: "owner", ownerCode: "mml93-a01" }), ctxWith(ROW).ctx, { nowMs: NOW })).status, 405);
});

test("only the owner session saves, and the save is a single-row upsert on id 1", async () => {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = { action: "save", title: "새 공지", body: "내용", startDate: "2026-09-18", endDate: "2026-09-20", enabled: true };
  for (const [label, options, status] of [
    ["team", { role: "team", ...json(payload) }, 403],
    ["client", { role: "client", ...json(payload) }, 403],
    ["owner with wrong code", { role: "owner", ownerCode: "mml93-a02", ...json(payload) }, 403],
    ["owner without json", { role: "owner", ownerCode: "mml93-a01", headers: { "content-type": "text/plain" }, body: "x" }, 415],
    ["owner unknown action", { role: "owner", ownerCode: "mml93-a01", ...json({ action: "delete" }) }, 400],
    ["owner invalid dates", { role: "owner", ownerCode: "mml93-a01", ...json({ ...payload, endDate: "2026-09-17" }) }, 400],
  ]) {
    const harness = ctxWith(ROW);
    const response = await handleSiteNoticeRequest(request("POST", options), harness.ctx, { nowMs: NOW });
    assert.equal(response.status, status, label);
    assert.equal(harness.calls.some((call) => call[0] === "upsert"), false, label);
  }
  const harness = ctxWith(ROW);
  const response = await handleSiteNoticeRequest(request("POST", { role: "owner", ownerCode: "mml93-a01", ...json(payload) }), harness.ctx, { nowMs: NOW });
  const body = await response.json();
  assert.equal(response.status, 200);
  const upsert = harness.calls.find((call) => call[0] === "upsert");
  assert.deepEqual(upsert[1], { id: 1, title: "새 공지", body: "내용", starts_at: "2026-09-17T15:00:00.000Z", ends_at: "2026-09-20T14:59:59.999Z", enabled: true, updated_at: new Date(NOW).toISOString(), updated_by: "owner" });
  assert.deepEqual(upsert[2], { onConflict: "id" });
  assert.equal(body.ok, true);
  assert.equal(body.active, true);
  assert.equal(body.editable.startDate, "2026-09-18");
  assert.equal(body.notice.title, "새 공지");
  const failing = await handleSiteNoticeRequest(request("POST", { role: "owner", ownerCode: "mml93-a01", ...json(payload) }), ctxWith(ROW, { upsertError: new Error("permission denied") }).ctx, { nowMs: NOW });
  assert.equal(failing.status, 500);
  assert.deepEqual(await failing.json(), { ok: false, message: "공지를 저장하지 못했습니다." });
});

test("site notice migration creates a locked-down single-row table seeded with the 2026-09-18 ~ 09-20 maintenance notice", () => {
  const sql = fs.readFileSync("supabase/migrations/20260918050000_site_notices.sql", "utf8");
  assert.match(sql, /create table if not exists public\.site_notices/u);
  assert.match(sql, /constraint site_notices_single_row check \(id = 1\)/u);
  assert.match(sql, /constraint site_notices_window check \(ends_at >= starts_at\)/u);
  assert.match(sql, /alter table public\.site_notices enable row level security;/u);
  assert.match(sql, /revoke all on table public\.site_notices from public, anon, authenticated;/u);
  assert.match(sql, /grant select, insert, update on table public\.site_notices to service_role;/u);
  assert.match(sql, /'2026-09-17 15:00:00\+00',\s+'2026-09-20 14:59:59\.999\+00',\s+true,/u);
  assert.match(sql, /N 30일 추적 서버 점검 안내/u);
  assert.match(sql, /9월 20일 완료 예정입니다\./u);
  assert.match(sql, /on conflict \(id\) do nothing;/u);
  assert.doesNotMatch(sql, /naver_rank|naver_shopping|naver_place/u);
});

test("the owner takes the popup down at once without losing its content (2026-09-19)", async () => {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const role of ["team", "client"]) {
    const denied = ctxWith(ROW);
    assert.equal((await handleSiteNoticeRequest(request("POST", { role, ...json({ action: "clear" }) }), denied.ctx, { nowMs: NOW })).status, 403, role);
    assert.equal(denied.calls.some((call) => call[0] === "update"), false, role);
  }
  const harness = ctxWith(ROW);
  const response = await handleSiteNoticeRequest(request("POST", { role: "owner", ownerCode: "mml93-a01", ...json({ action: "clear" }) }), harness.ctx, { nowMs: NOW });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(harness.calls.find((call) => call[0] === "update")[1], { enabled: false, updated_at: new Date(NOW).toISOString(), updated_by: "owner" });
  assert.deepEqual(harness.calls.filter((call) => call[0] === "eq"), [["eq", "id", 1]]);
  assert.equal(body.ok, true);
  assert.equal(body.active, false);
  assert.equal(body.notice, null);
  assert.equal(body.editable.enabled, false);
  assert.equal(body.editable.title, ROW.title, "내용은 남아 다시 켤 수 있다");
  const empty = await (await handleSiteNoticeRequest(request("POST", { role: "owner", ownerCode: "mml93-a01", ...json({ action: "clear" }) }), ctxWith(null).ctx, { nowMs: NOW })).json();
  assert.deepEqual(empty, { ok: true, editable: null, active: false, notice: null });
  const failing = await handleSiteNoticeRequest(request("POST", { role: "owner", ownerCode: "mml93-a01", ...json({ action: "clear" }) }), ctxWith(ROW, { updateError: new Error("permission denied") }).ctx, { nowMs: NOW });
  assert.equal(failing.status, 500);
  assert.deepEqual(await failing.json(), { ok: false, message: "공지를 내리지 못했습니다." });
});
