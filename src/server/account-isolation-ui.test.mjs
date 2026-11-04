// 계정 섞임 정리(점검 2026-11-02 F41 묶음, 2026-11-04): 조사 노트는 로그인한 계정 것만, 로그아웃 때 광고주 대시보드 사본 삭제.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const client = fs.readFileSync(path.join(root, "src/pages/client.html"), "utf8");
const admin = fs.readFileSync(path.join(root, "src/pages/admin.html"), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, start);
  const to = source.indexOf(end, from);
  assert.ok(to > from, end);
  return source.slice(from, to + end.length);
}

const NOTES_START = "var keywordNotesState = ";
const NOTES_END = "window.setTimeout(function () { if (keywordNotesSignedIn()) loadKeywordNotes(); }, 4000);";

test("keyword notes code is identical on both pages and follows sign-in, scope changes and sign-out", () => {
  const clientNotes = between(client, NOTES_START, NOTES_END);
  assert.equal(between(admin, NOTES_START, NOTES_END), clientNotes);
  assert.match(clientNotes, /if \(generation !== keywordNotesGeneration\) return;/, "늦게 온 앞 계정 응답은 버린다");
  assert.match(clientNotes, /window\.addEventListener\("mi:rank-scope-changed", refreshKeywordNotes\);/);
  assert.match(clientNotes, /if \(keywordNotesSignedIn\(\)\) loadKeywordNotes\(\);/, "로그인 상태일 때만 불러온다");
  assert.match(between(client, "function applyClientSession(payload) {", "return session;"), /refreshKeywordNotes\(\)/);
  assert.match(between(admin, "function applySecureSession(payload) {", "return session;"), /refreshKeywordNotes\(\)/);
  assert.match(between(client, "function clearClientAuth() {", "unmountPersonalCalendar();"), /resetKeywordNotes\(\)/);
  assert.match(between(admin, "function clearAdminAuthCode() {", "resetAdminAsyncControls({ clearSensitiveInputs: true });"), /resetKeywordNotes\(\)/);
});

test("signing out removes only the client dashboard copies from this device", () => {
  const fn = between(client, "function removeStoredPublicStates() {", "keys.forEach(function (key) { window.localStorage.removeItem(key); });\n        } catch (error) {}\n      }");
  const store = new Map([
    ["miAgencyPublicState:v2", "{}"],
    ["miAgencyPublicState:v2:scope-a", "{}"],
    ["miAgencyPublicState:v2:scope-b", "{}"],
    ["miAgencyPublicState:v20", "{}"],
    ["miSiteNoticeHide:1:x", "1"],
    ["mi-personal-assistant-ai-consent:v1", "yes"],
  ]);
  const localStorage = {
    get length() { return store.size; },
    key(index) { return [...store.keys()][index] ?? null; },
    removeItem(key) { store.delete(key); },
  };
  const sandbox = { window: { localStorage }, storageKey: "miAgencyPublicState:v2" };
  vm.runInNewContext(`${fn}\nremoveStoredPublicStates();`, sandbox);
  assert.deepEqual([...store.keys()], ["miAgencyPublicState:v20", "miSiteNoticeHide:1:x", "mi-personal-assistant-ai-consent:v1"]);
});
