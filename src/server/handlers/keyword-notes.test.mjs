import assert from "node:assert/strict";
import test from "node:test";
import { cleanSnapshots, handleKeywordNotesRequest, stripNoteDatalab } from "./keyword-notes.mjs";

// 2026-09-27 통합 점검: 연달아 저장하면 같은 노트가 2개 생기고, 없는 노트를 지워도 '성공'이라고 답했다.

function fakeDb() {
  const rows = [];
  let nextId = 1;
  function query(table) {
    const filters = [];
    let mode = "select";
    let payload = null;
    let returning = false;
    const api = {
      select() { returning = true; return api; },
      insert(row) { mode = "insert"; payload = row; return api; },
      delete() { mode = "delete"; return api; },
      eq(column, value) { filters.push((row) => row[column] === value); return api; },
      gte(column, value) { filters.push((row) => String(row[column]) >= String(value)); return api; },
      order() { return api; },
      limit() { return api; },
      single() { return api.then((result) => ({ ...result, data: Array.isArray(result.data) ? result.data[0] : result.data })); },
      then(resolve, reject) {
        let result;
        if (mode === "insert") {
          const row = { id: `note-${nextId++}`, created_at: new Date().toISOString(), ...payload };
          rows.push(row);
          result = { data: [row], error: null };
        } else if (mode === "delete") {
          const removed = rows.filter((row) => filters.every((fn) => fn(row)));
          for (const row of removed) rows.splice(rows.indexOf(row), 1);
          result = { data: returning ? removed.map((row) => ({ id: row.id })) : null, error: null };
        } else {
          result = { data: rows.filter((row) => filters.every((fn) => fn(row))), error: null };
        }
        assert.equal(table, "keyword_research_notes");
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return api;
  }
  return { rows, ctx: { supabaseAdmin: { from: query } } };
}

function request(method, body, query = "", role = "client") {
  return new Request(`https://example.com/api/client/keyword-notes${query}`, {
    method,
    headers: { "content-type": "application/json", "x-mi-session-role": role, "x-mi-agency-code": "test-account" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("같은 제목·키워드를 연달아 저장하면 새 노트를 만들지 않고 방금 노트를 돌려준다", async () => {
  const { rows, ctx } = fakeDb();
  const body = { title: "탄소매트 조사", keywords: ["탄소매트", "전기매트"] };
  const first = await (await handleKeywordNotesRequest(request("POST", body), ctx)).json();
  const second = await (await handleKeywordNotesRequest(request("POST", body), ctx)).json();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.item.id, first.item.id);
  assert.equal(rows.length, 1);
  const other = await (await handleKeywordNotesRequest(request("POST", { title: "탄소매트 조사", keywords: ["탄소매트"] }), ctx)).json();
  assert.equal(other.duplicate, undefined, "키워드가 다르면 다른 노트다");
  assert.equal(rows.length, 2);
});

test("없는 노트를 지우면 404 로 사실대로 답하고, 있는 노트는 지운다", async () => {
  const { rows, ctx } = fakeDb();
  const saved = await (await handleKeywordNotesRequest(request("POST", { keywords: ["모자"] }), ctx)).json();
  const missing = await handleKeywordNotesRequest(request("DELETE", null, "?id=no-such-note"), ctx);
  assert.equal(missing.status, 404);
  assert.equal(rows.length, 1);
  const removed = await handleKeywordNotesRequest(request("DELETE", null, `?id=${saved.item.id}`), ctx);
  assert.equal(removed.status, 200);
  assert.equal(rows.length, 0);
});

test("검색량 기록의 날짜가 날짜 형식이 아니면 저장 시각으로 바꾼다", () => {
  const [item] = cleanSnapshots([{ keyword: "모자", volume: "abc", checkedAt: "x" }]);
  assert.equal(item.volume, null);
  assert.ok(!Number.isNaN(new Date(item.checkedAt).getTime()));
  const [kept] = cleanSnapshots([{ keyword: "모자", checkedAt: "2026-09-27T01:02:03.000Z" }]);
  assert.equal(kept.checkedAt, "2026-09-27T01:02:03.000Z");
});

// 네이버 답변(2026-11-13): '가장 많이 찾는 달'(peakMonth)은 데이터랩 값이라 직원(총관리자·운영팀)끼리만 쓴다.
// 노트는 광고주 코드로 묶여 운영팀이 저장한 값도 광고주 화면에 보이므로, 광고주·체험 응답(목록·저장·중복)에서 지운다.
test("광고주·체험 세션에는 노트의 '가장 많이 찾는 달'을 보내지 않고, 새로 저장하지도 않는다. 직원 세션은 그대로 본다", async () => {
  const { rows, ctx } = fakeDb();
  const snapshots = [{ keyword: "원두", volume: 6300, peakMonth: "12월", checkedAt: "2026-11-01T00:00:00.000Z" }];
  const staffSaved = await (await handleKeywordNotesRequest(request("POST", { title: "직원 조사", keywords: ["원두"], snapshots }, "", "team"), ctx)).json();
  assert.equal(staffSaved.item.snapshots[0].peakMonth, "12월", "직원 응답은 그대로");
  assert.equal(rows[0].snapshots[0].peakMonth, "12월", "직원이 저장한 값은 남는다(직원끼리 쓰는 값)");

  const clientList = await (await handleKeywordNotesRequest(request("GET"), ctx)).json();
  assert.equal(clientList.items.length, 1);
  assert.equal(clientList.items[0].snapshots[0].peakMonth, "", "광고주 목록에는 직원이 저장한 피크 달도 없다");
  assert.equal(clientList.items[0].snapshots[0].volume, 6300, "검색광고 월 검색수는 그대로");
  const ownerList = await (await handleKeywordNotesRequest(request("GET", null, "", "owner"), ctx)).json();
  assert.equal(ownerList.items[0].snapshots[0].peakMonth, "12월", "총관리자 목록은 그대로");

  const duplicate = await (await handleKeywordNotesRequest(request("POST", { title: "직원 조사", keywords: ["원두"], snapshots }), ctx)).json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.item.snapshots[0].peakMonth, "", "중복 저장 응답에서도 지운다");

  const clientSaved = await (await handleKeywordNotesRequest(request("POST", { title: "광고주 조사", keywords: ["담요"], snapshots: [{ keyword: "담요", volume: 900, peakMonth: "1월" }] }), ctx)).json();
  assert.equal(clientSaved.item.snapshots[0].peakMonth, "");
  assert.equal(rows.find((row) => row.title === "광고주 조사").snapshots[0].peakMonth, "", "광고주가 보낸 피크 달은 저장하지 않는다");
});

test("stripNoteDatalab 은 snapshots 가 없거나 이상한 노트도 깨지지 않게 둔다", () => {
  assert.deepEqual(stripNoteDatalab({ id: "a", snapshots: null }).snapshots, null);
  assert.deepEqual(stripNoteDatalab({ id: "b", snapshots: [null, { keyword: "x", peakMonth: "3월" }] }).snapshots, [null, { keyword: "x", peakMonth: "" }]);
});
