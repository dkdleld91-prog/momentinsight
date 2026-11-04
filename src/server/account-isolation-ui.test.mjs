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
const NOTES_END = 'window.addEventListener("mi:rank-scope-changed", refreshKeywordNotes);';

test("keyword notes code is identical on both pages and follows sign-in, scope changes and sign-out", () => {
  const clientNotes = between(client, NOTES_START, NOTES_END);
  assert.equal(between(admin, NOTES_START, NOTES_END), clientNotes);
  assert.match(clientNotes, /if \(generation !== keywordNotesGeneration\) return;/, "늦게 온 앞 계정 응답은 버린다");
  assert.match(clientNotes, /function loadKeywordNotes\(\) \{\n\s*if \(!keywordNotesSignedIn\(\)\) return;/, "로그인 상태가 아니면 어떤 경로로도 불러오지 않는다(저장·삭제 뒤 포함)");
  assert.match(clientNotes, /if \(scope && scope === keywordNotesScope && keywordNotesState\.ready\) return;/, "같은 범위면 다시 받지 않는다");
  assert.doesNotMatch(clientNotes, /setTimeout\(/, "페이지 연 뒤 한 번만 부르던 타이머는 없앤다");
  assert.match(between(client, "function applyClientSession(payload) {", "return session;"), /refreshKeywordNotes\(\)/);
  assert.match(between(admin, "function applySecureSession(payload) {", "return session;"), /refreshKeywordNotes\(\)/);
  for (const body of [between(client, "function clearClientAuth() {", "unmountPersonalCalendar();"), between(admin, "function clearAdminAuthCode() {", "resetAdminAsyncControls({ clearSensitiveInputs: true });")]) {
    for (const reset of ["resetKeywordNotes", "resetKeywordCompare", "resetHomeFeed"]) assert.match(body, new RegExp(`${reset}\\(\\)`), reset);
  }
  for (const page of [client, admin]) {
    const home = between(page, "function resetHomeFeed() {", "renderHomeFeedFailure();");
    assert.match(home, /homeFeedRequest \+= 1;[\s\S]*homeFeedStartedAt = 0;[\s\S]*homeFeedLastPayload = null;/, "앞 계정 홈 피드를 지우고 10초 막기를 푼다");
    assert.match(between(page, "function resetKeywordCompare() {", "renderKeywordCompare([]);"), /keywordCompareRequest \+= 1;[\s\S]*keywordCompareItems = \[\];/);
  }
  assert.match(between(admin, "async function refreshHomeFeed() {", "var requestId = ++homeFeedRequest;"), /homeFeedKey === homeFeedStartedKey/, "총관리자 대상이 바뀌면 10초 막기에 걸리지 않는다");
});

test("signing out removes only the client dashboard copies from this device", () => {
  const fn = between(client, "function removeStoredPublicStates() {", "keys.forEach(function (key) { window.localStorage.removeItem(key); });\n        } catch (error) {}\n      }");
  const store = new Map([
    ["miAgencyPublicState:v2", "{}"],
    ["miAgencyPublicState:v2:abcdefghijklmnopqrstuvwx", "{}"],
    ["miAgencyPublicState:v2:abc-def_ghijklmnopqrst12", "{}"],
    ["miAgencyPublicState:v2:0b6f3a52-6c1e-4d7a-9e2f-1a2b3c4d5e6f", "{}"],
    ["miAgencyPublicState:v2:owner-unresolved", "{}"],
    ["miAgencyPublicState:v20", "{}"],
    ["miSiteNoticeHide:1:x", "1"],
    ["mi-personal-assistant-ai-consent:v1", "yes"],
  ]);
  const localStorage = {
    get length() { return store.size; },
    key(index) { return [...store.keys()][index] ?? null; },
    removeItem(key) { store.delete(key); },
  };
  const pattern = between(client, "var CLIENT_PUBLIC_STATE_SCOPE_PATTERN = ", ";");
  const sandbox = { window: { localStorage }, storageKey: "miAgencyPublicState:v2" };
  vm.runInNewContext(`${pattern}\n${fn}\nremoveStoredPublicStates();`, sandbox);
  assert.deepEqual([...store.keys()], [
    "miAgencyPublicState:v2:0b6f3a52-6c1e-4d7a-9e2f-1a2b3c4d5e6f",
    "miAgencyPublicState:v2:owner-unresolved",
    "miAgencyPublicState:v20",
    "miSiteNoticeHide:1:x",
    "mi-personal-assistant-ai-consent:v1",
  ], "관리자 화면 편집값(광고주 id·owner-unresolved)과 다른 저장값은 남긴다");
});
