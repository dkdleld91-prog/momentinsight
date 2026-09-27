import assert from "node:assert/strict";
import test from "node:test";
import { cleanSnapshots, handleKeywordNotesRequest } from "./keyword-notes.mjs";

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

function request(method, body, query = "") {
  return new Request(`https://example.com/api/client/keyword-notes${query}`, {
    method,
    headers: { "content-type": "application/json", "x-mi-session-role": "client", "x-mi-agency-code": "test-account" },
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
